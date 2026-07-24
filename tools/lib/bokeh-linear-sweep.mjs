import { ENERGY_RADIUS } from "./bokeh-image-analysis.mjs";

// Capture the explicit StableBokehPass writeBuffer synchronously, before the
// composer reuses either ping-pong target. Each source is then hidden for one
// otherwise identical frame; positive ON−OFF RGB is the source's linear-HDR
// contribution without ACES, sRGB, bloom-floor, or focus-card contamination.
export async function measureLinearBokehSweep(
  page,
  lights,
  scales,
  radius = ENERGY_RADIUS,
) {
  return page.evaluate(
    ({ samples, radiusScales, radiusPx }) => {
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
        const opticalCoreMean = opticalBandMean(0.2, 0.6);
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
          covarianceArea:
            4 * Math.PI * Math.sqrt(Math.max(0, xx * yy - xy * xy)),
          rmsRadius: Math.sqrt(xx + yy),
          discMean: discEnergy / Math.max(1, disc.length),
          coreMean: mean(core),
          rimMean: mean(rim),
          rimToCore: mean(rim) / Math.max(1e-9, mean(core)),
        };
      };

      const result = {};
      const originalScale = pass.uniforms.bokehRadiusScale.value;
      const originalQuality = pass.uniforms.bokehQuality.value;
      try {
        // Measure the compact-source optical path in isolation. The product's
        // contrast-aware surface reconstruction is intentionally independent
        // of source radius and would otherwise contaminate an ON/OFF source
        // delta when the fixture changes a light to black.
        pass.uniforms.bokehQuality.value = 0;
        for (const sample of samples) {
          const source = engine.scene.getObjectByName(sample.name);
          if (!source)
            throw new Error(`missing linear-HDR sweep source ${sample.name}`);
          const originalColor = source.material.color.clone();
          const samplesForSource = [];
          try {
            for (const scale of radiusScales) {
              pass.uniforms.bokehRadiusScale.value = scale;
              source.material.color.copy(originalColor);
              const on = capture(sample);
              source.material.color.setRGB(0, 0, 0);
              const off = capture(sample);
              const expectedRadius =
                pass.uniforms.maxblur.value *
                scale *
                pass.uniforms.viewportWidth.value *
                0.8660254;
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
        pass.uniforms.bokehQuality.value = originalQuality;
        engine.debugRenderDofFrame();
      }
      return result;
    },
    { samples: lights, radiusScales: scales, radiusPx: radius },
  );
}
