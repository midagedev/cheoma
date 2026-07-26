// Linear-HDR source-scatter sweep for the bokeh optical chart.
//
// WHAT IS MEASURED, AND WHY IT IS ONLY THE SOURCE PATH
// ----------------------------------------------------
// The measurement is the positive ON-OFF difference of the *explicit
// StableBokehPass writeBuffer*, captured synchronously inside pass.render before
// the composer can reuse either ping-pong target. Two facts make that difference
// the compact-source scatter alone, with no isolation switch involved:
//
//   1. Capture point. src/env/post.js adds bokeh *before* bloom and flare, so the
//      writeBuffer is linear HDR with no sensor bloom, no lens flare, no ACES and
//      no sRGB encode. Nothing downstream of DoF can enter the difference.
//   2. The compact-source transfer. The fixture switches a source between its HDR
//      colour and pure black, never hiding it, so depth is bit-identical in both
//      frames. In the ON frame the CoC prefilter's withoutTransferredSource()
//      zeroes the owned 2x2 block, so the source contributes exactly 0 to the
//      surface gather; in the OFF frame the same texels *are* 0 because the
//      material is black. Every other texel in the frame is byte-identical.
//      The half-resolution gather therefore produces the identical image in both
//      frames and cancels to zero in the difference, leaving only the additively
//      blended scatter draw.
//
// The former isolation used `bokehQuality = 0`, which was valid only while that
// uniform collapsed the whole surface reconstruction to a single tap. It now
// weights the gather's fill ring only (docs/dof-cinematic-research.md 5.3), so
// using it would have isolated nothing. Fact 2 above replaces it and is a
// property of the fixture rather than of a debug dial.
//
// measureLinearBokehSweep is deliberately runnable with the scatter disabled as
// well. That is the counterfactual that proves the claim instead of asserting it:
// with `sourceScatter: false` the source is no longer transferred, the surface
// gather blurs it as an ordinary surface, and the same difference must then show
// a disc at the *pure physical CoC* that does not move when bokehRadiusScale
// sweeps. Source-multiplier response and surface response are thereby measured on
// the same fixture and separated by construction.
//
// Expected radii are never re-derived here. They come from the pure functions in
// src/env/bokeh-coc-contract.js applied to the live optics read out of the running
// pass; duplicating the curve in a harness constant is what silently broke this
// gate when the aperture became a physical diameter.
import {
  bokehCocRadiusPx,
  bokehCocScalePx,
  bokehMaxCocPx,
} from "../../src/env/bokeh-coc-contract.js";
import { ENERGY_RADIUS } from "./bokeh-image-analysis.mjs";

// Fractions of the expected radius that bound the disc interior sampled as
// `opticalCoreMean`. Exported because the assertion side has to predict the mean
// over exactly this band from the contract's profile, and a second copy of the
// numbers there is what let the old area-dilution law look self-consistent.
export const BOKEH_SWEEP_CORE_BAND = Object.freeze({ min: 0.2, max: 0.6 });

/**
 * Read the live lens state and each source's camera-axis depth out of the running
 * pass. Nothing is assumed about the fixture: fov, aperture, focus and viewport
 * height are whatever the product resolved for this frame.
 */
export async function readBokehSweepOptics(page, sourceNames) {
  const optics = await page.evaluate((names) => {
    const engine = window.__engine;
    const pass = engine.debugPostResources().bokehPass;
    const coc = pass.debugCoc();
    const camera = engine.camera;
    // camera.position.clone() is only used as a scratch Vector3 so this evaluate
    // needs no three import of its own.
    const forward = camera.getWorldDirection(camera.position.clone());
    const eye = camera.position;
    const sources = names.map((name) => {
      const object = engine.scene.getObjectByName(name);
      if (!object) throw new Error(`missing linear-HDR sweep source ${name}`);
      const world = object.getWorldPosition(camera.position.clone());
      return {
        name,
        axialDepth:
          (world.x - eye.x) * forward.x +
          (world.y - eye.y) * forward.y +
          (world.z - eye.z) * forward.z,
      };
    });
    return {
      apertureMeters: coc.apertureMeters,
      maxCocFraction: coc.maxCocFraction,
      cocScalePx: coc.cocScalePx,
      maxCocPx: coc.maxCocPx,
      sourceRadiusScale: coc.sourceRadiusScale,
      focus: pass.uniforms.focus.value,
      viewportHeight: pass.materialBokeh.uniforms.viewportHeight.value,
      fovDegrees: camera.fov,
      sources,
    };
  }, sourceNames);

  // The runtime must be evaluating the contract's curve, not a private copy of
  // it. Assert that before any expected radius is derived from these numbers,
  // otherwise a divergence between pass and contract would be absorbed silently.
  const contractScalePx = bokehCocScalePx(
    optics.apertureMeters,
    optics.viewportHeight,
    optics.fovDegrees,
  );
  const contractMaxCocPx = bokehMaxCocPx(
    optics.viewportHeight,
    optics.maxCocFraction,
  );
  if (
    !(contractScalePx > 0) ||
    Math.abs(contractScalePx - optics.cocScalePx) > contractScalePx * 1e-6 ||
    Math.abs(contractMaxCocPx - optics.maxCocPx) > 1e-9
  ) {
    throw new Error(
      `pass optics diverged from bokeh-coc-contract: ${JSON.stringify({
        optics,
        contractScalePx,
        contractMaxCocPx,
      })}`,
    );
  }
  return { ...optics, contractScalePx, contractMaxCocPx };
}

/**
 * Surface circle of confusion in pixels: the pure clamped physical radius the
 * gather and the composite spend at this depth.
 */
export function bokehSurfaceDiscRadiusPx(optics, axialDepth) {
  return bokehCocRadiusPx(
    optics.cocScalePx,
    optics.focus,
    axialDepth,
    optics.maxCocPx,
  );
}

/**
 * Compact-source disc radius in pixels, i.e. exactly what
 * bokeh-source-scatter.js#sourceRadiusAtDepth computes:
 *
 *   min(|cocScalePx * (1/focus - 1/z)|, maxCocPx) * radiusScale
 *
 * The clamp is applied before the source multiplier in the shader, so it is
 * applied before it here as well.
 */
export function bokehSourceDiscRadiusPx(optics, axialDepth, radiusScale) {
  return bokehSurfaceDiscRadiusPx(optics, axialDepth) * radiusScale;
}

/**
 * Capture the explicit StableBokehPass writeBuffer synchronously, before the
 * composer reuses either ping-pong target. Each source is then blackened for one
 * otherwise identical frame; positive ON-OFF RGB is the linear-HDR contribution
 * of that source without ACES, sRGB, bloom, flare, or focus-card contamination.
 *
 * `samples[i].expected[j].radiusPx` must already be the contract-derived radius
 * for `scales[j]`; this function never computes an optical radius itself.
 */
export async function measureLinearBokehSweep(
  page,
  {
    samples: lights,
    scales,
    radiusPx: radius = ENERGY_RADIUS,
    sourceScatter = true,
  },
) {
  return page.evaluate(
    ({ samples, radiusScales, radiusPx, scatterEnabled, coreBand }) => {
      const engine = window.__engine;
      const pass = engine.debugPostResources().bokehPass;

      const halfToFloat = (half) => {
        const sign = half & 0x8000 ? -1 : 1;
        const exponent = (half >> 10) & 0x1f;
        const fraction = half & 0x03ff;
        if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
        if (exponent === 31) return fraction ? NaN : sign * Infinity;
        return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
      };

      const capture = (sample) => {
        let captured = null;
        const originalRender = pass.render;
        pass.render = function captureBokehWriteBuffer(
          renderer,
          writeBuffer,
          ...args
        ) {
          originalRender.call(this, renderer, writeBuffer, ...args);
          const cx = Math.round(sample.x);
          const cy = Math.round(sample.y);
          const diameter = radiusPx * 2 + 1;
          const x = Math.max(0, cx - radiusPx);
          // readRenderTargetPixels uses a bottom-left origin.
          const y = Math.max(0, writeBuffer.height - 1 - (cy + radiusPx));
          const width = Math.min(diameter, writeBuffer.width - x);
          const height = Math.min(diameter, writeBuffer.height - y);
          const raw = new Uint16Array(width * height * 4);
          renderer.readRenderTargetPixels(
            writeBuffer,
            x,
            y,
            width,
            height,
            raw,
          );
          captured = {
            raw,
            x,
            y,
            width,
            height,
            targetHeight: writeBuffer.height,
          };
        };
        try {
          engine.debugRenderDofFrame();
        } finally {
          pass.render = originalRender;
        }
        if (!captured)
          throw new Error("StableBokehPass writeBuffer was not captured");
        return captured;
      };

      const measureDelta = (sample, on, off, expectedRadius) => {
        const points = [];
        let integratedEnergy = 0;
        let signedIntegratedEnergy = 0;
        let negativeIntegratedEnergy = 0;
        let peak = 0;
        for (let row = 0; row < on.height; row++) {
          for (let column = 0; column < on.width; column++) {
            const screenX = on.x + column;
            const screenY = on.targetHeight - 1 - (on.y + row);
            const distance = Math.hypot(screenX - sample.x, screenY - sample.y);
            if (distance > radiusPx) continue;
            const offset = (row * on.width + column) * 4;
            const red =
              halfToFloat(on.raw[offset]) - halfToFloat(off.raw[offset]);
            const green =
              halfToFloat(on.raw[offset + 1]) -
              halfToFloat(off.raw[offset + 1]);
            const blue =
              halfToFloat(on.raw[offset + 2]) -
              halfToFloat(off.raw[offset + 2]);
            const signedEnergy = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
            const energy = Math.max(0, signedEnergy);
            points.push({
              distance,
              dx: screenX - sample.x,
              dy: screenY - sample.y,
              energy,
            });
            integratedEnergy += energy;
            signedIntegratedEnergy += signedEnergy;
            negativeIntegratedEnergy += Math.max(0, -signedEnergy);
            peak = Math.max(peak, energy);
          }
        }
        const threshold = peak * 0.05;
        const support = points.filter((point) => point.energy >= threshold);
        const supportRadius = Math.max(
          0,
          ...support.map((point) => point.distance),
        );
        const disc = points.filter((point) => point.distance <= supportRadius);
        const discEnergy = disc.reduce((sum, point) => sum + point.energy, 0);
        const core = disc.filter(
          (point) => point.distance <= supportRadius * 0.55,
        );
        const rim = disc.filter(
          (point) => point.distance >= supportRadius * 0.72,
        );
        const mean = (set) =>
          set.reduce((sum, point) => sum + point.energy, 0) /
          Math.max(1, set.length);
        const haloBand = points
          .filter(
            (point) =>
              point.distance >= expectedRadius * 1.12 &&
              point.distance <= expectedRadius * 1.45,
          )
          .map((point) => point.energy)
          .sort((a, b) => a - b);
        const haloBaseline = haloBand[Math.floor(haloBand.length * 0.5)] || 0;
        const opticalPoints = points.map((point) => ({
          ...point,
          opticalEnergy: Math.max(0, point.energy - haloBaseline),
        }));
        const opticalBandMean = (minimum, maximum) => {
          const band = opticalPoints.filter(
            (point) =>
              point.distance >= expectedRadius * minimum &&
              point.distance <= expectedRadius * maximum,
          );
          return (
            band.reduce((sum, point) => sum + point.opticalEnergy, 0) /
            Math.max(1, band.length)
          );
        };
        const opticalDisc = opticalPoints.filter(
          (point) => point.distance <= expectedRadius * 1.05,
        );
        const opticalIntegratedEnergy = opticalDisc.reduce(
          (sum, point) => sum + point.opticalEnergy,
          0,
        );
        const opticalCoreMean = opticalBandMean(coreBand.min, coreBand.max);
        const opticalRimMean = opticalBandMean(0.78, 0.95);
        const opticalOutsideMean = opticalBandMean(1.08, 1.35);
        const weightedX =
          points.reduce((sum, point) => sum + point.dx * point.energy, 0) /
          Math.max(1e-9, integratedEnergy);
        const weightedY =
          points.reduce((sum, point) => sum + point.dy * point.energy, 0) /
          Math.max(1e-9, integratedEnergy);
        const xx =
          points.reduce(
            (sum, point) => sum + (point.dx - weightedX) ** 2 * point.energy,
            0,
          ) / Math.max(1e-9, integratedEnergy);
        const yy =
          points.reduce(
            (sum, point) => sum + (point.dy - weightedY) ** 2 * point.energy,
            0,
          ) / Math.max(1e-9, integratedEnergy);
        const xy =
          points.reduce(
            (sum, point) =>
              sum +
              (point.dx - weightedX) * (point.dy - weightedY) * point.energy,
            0,
          ) / Math.max(1e-9, integratedEnergy);
        return {
          integratedEnergy,
          signedIntegratedEnergy,
          negativeIntegratedEnergy,
          negativeEnergyRatio:
            negativeIntegratedEnergy / Math.max(1e-9, integratedEnergy),
          peak,
          expectedCoCRadius: expectedRadius,
          expectedCoCArea: Math.PI * expectedRadius * expectedRadius,
          haloBaseline,
          opticalIntegratedEnergy,
          opticalDiscMean:
            opticalIntegratedEnergy / Math.max(1, opticalDisc.length),
          opticalCoreMean,
          opticalRimMean,
          opticalRimToCore: opticalRimMean / Math.max(1e-9, opticalCoreMean),
          opticalOutsideMean,
          supportArea: support.length,
          supportRadius,
          supportRadiusSquared: supportRadius * supportRadius,
          // Measured/derived radius agreement. The support radius is the 5%-of-peak
          // extent of the ON-OFF disc, so for the scatter's rim-brightened profile
          // it lands on the aperture edge; comparing it to the contract radius is
          // the one assertion that catches a wrong CoC curve rather than a merely
          // self-consistent one.
          supportRadiusRatio: supportRadius / Math.max(1e-9, expectedRadius),
          covarianceArea:
            4 * Math.PI * Math.sqrt(Math.max(0, xx * yy - xy * xy)),
          rmsRadius: Math.sqrt(xx + yy),
          rmsRadiusRatio: Math.sqrt(xx + yy) / Math.max(1e-9, expectedRadius),
          discMean: discEnergy / Math.max(1, disc.length),
          coreMean: mean(core),
          rimMean: mean(rim),
          rimToCore: mean(rim) / Math.max(1e-9, mean(core)),
        };
      };

      const result = {};
      const originalScale = pass.uniforms.bokehRadiusScale.value;
      const originalScatter = pass.debugSourceScatter().enabled;
      try {
        // The counterfactual axis. With the scatter enabled the difference is the
        // compact-source disc; with it disabled the source is no longer
        // transferred out of the CoC prefilter and the same difference is the
        // surface gather's own physical disc, which must ignore radiusScale.
        pass.setSourceScatterEnabled(scatterEnabled);
        for (const sample of samples) {
          const source = engine.scene.getObjectByName(sample.name);
          if (!source)
            throw new Error(`missing linear-HDR sweep source ${sample.name}`);
          const originalColor = source.material.color.clone();
          const samplesForSource = [];
          try {
            for (let index = 0; index < radiusScales.length; index++) {
              const scale = radiusScales[index];
              const expectedRadius = sample.expected[index];
              if (!(expectedRadius > 0)) {
                throw new Error(
                  `missing contract radius for ${sample.name} at scale ${scale}`,
                );
              }
              pass.uniforms.bokehRadiusScale.value = scale;
              source.material.color.copy(originalColor);
              const on = capture(sample);
              source.material.color.setRGB(0, 0, 0);
              const off = capture(sample);
              samplesForSource.push({
                scale,
                ...measureDelta(sample, on, off, expectedRadius),
              });
            }
          } finally {
            source.material.color.copy(originalColor);
          }
          result[sample.name] = samplesForSource;
        }
      } finally {
        pass.uniforms.bokehRadiusScale.value = originalScale;
        pass.setSourceScatterEnabled(originalScatter);
        engine.debugRenderDofFrame();
      }
      return result;
    },
    {
      samples: lights,
      radiusScales: scales,
      radiusPx: radius,
      scatterEnabled: !!sourceScatter,
      coreBand: BOKEH_SWEEP_CORE_BAND,
    },
  );
}
