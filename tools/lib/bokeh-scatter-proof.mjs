import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PNG } from "pngjs";
import {
  measureLights,
  positiveDeltaImage,
} from "./bokeh-image-analysis.mjs";

export async function runBokehScatterProof({
  page,
  outputDir,
  fixture,
  overlapName,
  roundnessLimit,
  angularUniformityLimit,
  enabled = true,
}) {
  const ROUNDNESS_LIMIT = roundnessLimit;
  const ANGULAR_UNIFORMITY_LIMIT = angularUniformityLimit;
  const scatterProofEnabled = enabled;
  let scatterProof = null;
  if (scatterProofEnabled) {
    await page.evaluate(() => {
      const engine = window.__engine;
      const pass = engine.debugPostResources().bokehPass;
      pass.setSourceScatterEnabled(false);
      pass.uniforms.bokehRadiusScale.value = 2.4;
      engine.camera.position.set(0, 0, 100);
      engine.__controls.target.set(0, 0, 0);
      engine.camera.lookAt(engine.__controls.target);
      engine.camera.updateMatrixWorld(true);
      engine.debugRenderDofFrame();
    });
    const scatterCounterfactual = await page.locator("canvas").screenshot();
    const scatterCounterfactualPath = join(
      outputDir,
      "bokeh-scatter-counterfactual.png",
    );
    await writeFile(scatterCounterfactualPath, scatterCounterfactual);

    const scatterRuntime = await page.evaluate(async () => {
      const engine = window.__engine;
      const resources = engine.debugPostResources();
      const pass = resources.bokehPass;
      const renderer = engine.renderer;
      const gl = renderer.getContext();
      const pointSizeRange = [...gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)];
      const maxPhysicalCoCDiameter =
        pass.uniforms.maxblur.value *
        pass.uniforms.bokehRadiusScale.value *
        pass.uniforms.viewportWidth.value *
        0.8660254 *
        2.08;
      const programsBefore = renderer.info.programs?.length || 0;
      pass.setSourceScatterEnabled(true);
      engine.debugRenderDofFrame();
      const programsAfter = renderer.info.programs?.length || 0;
      const debug = pass.debugSourceScatter();

      const callsFor = (enabled) => {
        pass.setSourceScatterEnabled(enabled);
        const previousAutoReset = renderer.info.autoReset;
        renderer.info.autoReset = false;
        renderer.info.reset();
        try {
          pass.render(
            renderer,
            resources.composerWriteBuffer,
            resources.composerReadBuffer,
            0,
            false,
          );
          return renderer.info.render.calls;
        } finally {
          renderer.info.autoReset = previousAutoReset;
        }
      };
      const callsOff = callsFor(false);
      const callsOn = callsFor(true);

      const ext = gl.getExtension("EXT_disjoint_timer_query_webgl2");
      if (!ext || typeof gl.createQuery !== "function") {
        return {
          pointSizeRange,
          maxPhysicalCoCDiameter,
          programsBefore,
          programsAfter,
          callsOff,
          callsOn,
          debug,
          gpu: { available: false },
        };
      }
      const batchSize = 16;
      let sawDisjoint = false;
      const measure = async (enabled) => {
        pass.setSourceScatterEnabled(enabled);
        const query = gl.createQuery();
        gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
        for (let index = 0; index < batchSize; index++) {
          pass.render(
            renderer,
            resources.composerWriteBuffer,
            resources.composerReadBuffer,
            0,
            false,
          );
        }
        gl.endQuery(ext.TIME_ELAPSED_EXT);
        gl.flush();
        const deadline = performance.now() + 2000;
        while (
          performance.now() < deadline &&
          !gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)
        ) {
          await new Promise((resolve) => setTimeout(resolve, 4));
        }
        if (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE))
          return null;
        sawDisjoint ||= !!gl.getParameter(ext.GPU_DISJOINT_EXT);
        const milliseconds =
          gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6 / batchSize;
        gl.deleteQuery(query);
        return milliseconds;
      };
      const sequence = [false, true, true, false, true, false, false, true];
      const samples = [];
      for (const enabled of sequence) {
        samples.push({ enabled, milliseconds: await measure(enabled) });
      }
      const median = (values) => {
        const sorted = [...values].sort((a, b) => a - b);
        const middle = sorted.length >> 1;
        return sorted.length % 2
          ? sorted[middle]
          : (sorted[middle - 1] + sorted[middle]) * 0.5;
      };
      const off = samples
        .filter((sample) => !sample.enabled)
        .map((sample) => sample.milliseconds);
      const on = samples
        .filter((sample) => sample.enabled)
        .map((sample) => sample.milliseconds);
      pass.setSourceScatterEnabled(true);
      engine.debugRenderDofFrame();
      return {
        pointSizeRange,
        maxPhysicalCoCDiameter,
        rendererPixelRatio: renderer.getPixelRatio(),
        maxPhysicalCoCDiameterAtDpr2:
          (maxPhysicalCoCDiameter * 2) / renderer.getPixelRatio(),
        drawingBuffer: [gl.drawingBufferWidth, gl.drawingBufferHeight],
        programsBefore,
        programsAfter,
        programDeltaAfterWarm: programsAfter - programsBefore,
        callsOff,
        callsOn,
        drawCallDelta: callsOn - callsOff,
        debug,
        gpu: {
          available: true,
          complete: samples.every((sample) => sample.milliseconds != null),
          disjoint: sawDisjoint || !!gl.getParameter(ext.GPU_DISJOINT_EXT),
          batchSize,
          samples,
          offMedianMs: median(off),
          onMedianMs: median(on),
          deltaMs: median(on) - median(off),
          ratio: median(on) / median(off),
        },
      };
    });
    const expectedBackend =
      Math.ceil(scatterRuntime.maxPhysicalCoCDiameter) >
      Math.floor(scatterRuntime.pointSizeRange[1])
        ? "triangles"
        : "points";
    if (scatterRuntime.debug.backend !== expectedBackend) {
      throw new Error(
        `scatter point-cap backend selection diverged: ${JSON.stringify(scatterRuntime)}`,
      );
    }
    if (scatterRuntime.drawCallDelta !== 1) {
      throw new Error(
        `scatter resource budget changed: ${JSON.stringify(scatterRuntime)}`,
      );
    }
    if (
      !scatterRuntime.gpu.available ||
      !scatterRuntime.gpu.complete ||
      scatterRuntime.gpu.disjoint
    ) {
      throw new Error(
        `scatter proof GPU timing invalid: ${JSON.stringify(scatterRuntime)}`,
      );
    }
    if (scatterRuntime.gpu.ratio > 1.8 || scatterRuntime.gpu.deltaMs > 2.5) {
      throw new Error(
        `scatter marginal GPU budget regressed: ${JSON.stringify(scatterRuntime)}`,
      );
    }
    const measureScatterLinear = (forceTriangle = false) =>
      page.evaluate(
        (input) => {
          const engine = window.__engine;
          const resources = engine.debugPostResources();
          const pass = resources.bokehPass;
          const renderer = engine.renderer;
          const scatter = pass._sourceScatter;
          const programsBeforeBackend = renderer.info.programs?.length || 0;
          if (input.forceTriangle) {
            scatter.pointSizeRange = [1, 0];
            pass.setSourceScatterEnabled(true);
            engine.debugRenderDofFrame();
          }
          const halfToFloat = (half) => {
            const sign = half & 0x8000 ? -1 : 1;
            const exponent = (half >> 10) & 0x1f;
            const fraction = half & 0x03ff;
            if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
            if (exponent === 31) return fraction ? NaN : sign * Infinity;
            return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
          };
          const capture = (visible) => {
            let frame = null;
            const originalRender = pass.render;
            const previousPointVisible = scatter.points.visible;
            const previousTriangleVisible = scatter.triangles.visible;
            scatter.points.visible = visible && scatter.backend === "points";
            scatter.triangles.visible =
              visible && scatter.backend === "triangles";
            pass.render = function captureScatterLinear(
              rendererArg,
              writeBuffer,
              ...args
            ) {
              originalRender.call(this, rendererArg, writeBuffer, ...args);
              const radius = 24;
              const x = Math.round(input.sample.x) - radius;
              const y =
                writeBuffer.height - 1 - (Math.round(input.sample.y) + radius);
              const width = radius * 2 + 1;
              const height = radius * 2 + 1;
              const raw = new Uint16Array(width * height * 4);
              rendererArg.readRenderTargetPixels(
                writeBuffer,
                x,
                y,
                width,
                height,
                raw,
              );
              frame = { raw, width, height };
            };
            try {
              engine.debugRenderDofFrame();
            } finally {
              pass.render = originalRender;
              scatter.points.visible = previousPointVisible;
              scatter.triangles.visible = previousTriangleVisible;
            }
            return frame;
          };

          pass.setSourceScatterEnabled(true);
          const off = capture(false);
          const on = capture(true);
          const rgb = [];
          let integratedEnergy = 0;
          let peak = 0;
          for (let screenRow = 0; screenRow < on.height; screenRow++) {
            const sourceRow = on.height - 1 - screenRow;
            for (let column = 0; column < on.width; column++) {
              const offset = (sourceRow * on.width + column) * 4;
              const red = Math.max(
                0,
                halfToFloat(on.raw[offset]) - halfToFloat(off.raw[offset]),
              );
              const green = Math.max(
                0,
                halfToFloat(on.raw[offset + 1]) -
                  halfToFloat(off.raw[offset + 1]),
              );
              const blue = Math.max(
                0,
                halfToFloat(on.raw[offset + 2]) -
                  halfToFloat(off.raw[offset + 2]),
              );
              rgb.push(red, green, blue);
              const energy = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
              integratedEnergy += energy;
              peak = Math.max(peak, energy);
            }
          }
          const callsFor = (enabled) => {
            pass.setSourceScatterEnabled(enabled);
            const previousAutoReset = renderer.info.autoReset;
            renderer.info.autoReset = false;
            renderer.info.reset();
            try {
              pass.render(
                renderer,
                resources.composerWriteBuffer,
                resources.composerReadBuffer,
                0,
                false,
              );
              return renderer.info.render.calls;
            } finally {
              renderer.info.autoReset = previousAutoReset;
            }
          };
          const callsOff = callsFor(false);
          const callsOn = callsFor(true);
          engine.debugRenderDofFrame();
          const scatterProgram = renderer.properties.get(
            scatter.material,
          )?.currentProgram;
          return {
            name: input.sample.name,
            width: on.width,
            height: on.height,
            rgb,
            peak,
            integratedEnergy,
            backend: scatter.backend,
            programDelta:
              (renderer.info.programs?.length || 0) - programsBeforeBackend,
            ownedProgramCount:
              scatterProgram &&
              (renderer.info.programs || []).includes(scatterProgram)
                ? 1
                : 0,
            drawCallDelta: callsOn - callsOff,
          };
        },
        {
          sample: fixture.projectedLights.find(
            (light) => light.name === "foreground-open-pair",
          ),
          forceTriangle,
        },
      );
    const writeScatterLinear = async (frame, filename) => {
      const png = new PNG({ width: frame.width, height: frame.height });
      for (let pixel = 0; pixel < frame.width * frame.height; pixel++) {
        for (let channel = 0; channel < 3; channel++) {
          const value = frame.rgb[pixel * 3 + channel];
          png.data[pixel * 4 + channel] = Math.round(
            Math.min(1, Math.max(0, value / Math.max(frame.peak, 1e-6))) **
              (1 / 2.2) *
              255,
          );
        }
        png.data[pixel * 4 + 3] = 255;
      }
      const path = join(outputDir, filename);
      await writeFile(path, PNG.sync.write(png));
      return path;
    };
    const scatterLinear = await measureScatterLinear();
    const scatterLinearPath = await writeScatterLinear(
      scatterLinear,
      "bokeh-scatter-linear.png",
    );
    console.log(
      `scatter linear ${JSON.stringify({
        path: scatterLinearPath,
        peak: scatterLinear.peak,
        integratedEnergy: scatterLinear.integratedEnergy,
      })}`,
    );
    const nativeScatterVisibility = await page.evaluate(() => {
      const engine = window.__engine;
      const pass = engine.debugPostResources().bokehPass;
      const scatter = pass._sourceScatter;
      const visibility = {
        points: scatter.points.visible,
        triangles: scatter.triangles.visible,
      };
      pass.setSourceScatterEnabled(true);
      scatter.points.visible = false;
      scatter.triangles.visible = false;
      engine.debugRenderDofFrame();
      return visibility;
    });
    const scatterBase = await page.locator("canvas").screenshot();
    const scatterBasePath = join(outputDir, "bokeh-scatter-base.png");
    await writeFile(scatterBasePath, scatterBase);
    await page.evaluate((visibility) => {
      const engine = window.__engine;
      const pass = engine.debugPostResources().bokehPass;
      const scatter = pass._sourceScatter;
      scatter.points.visible = visibility.points;
      scatter.triangles.visible = visibility.triangles;
      engine.debugRenderDofFrame();
    }, nativeScatterVisibility);
    const scatterOn = await page.locator("canvas").screenshot();
    const scatterOnPath = join(outputDir, "bokeh-scatter-direct.png");
    const scatterDeltaPath = join(outputDir, "bokeh-scatter-delta.png");
    const scatterDelta = positiveDeltaImage(scatterOn, scatterBase, 2);
    await writeFile(scatterOnPath, scatterOn);
    await writeFile(scatterDeltaPath, scatterDelta);
    const scatterDeltaMetrics = measureLights(
      scatterDelta,
      fixture.projectedLights.filter((light) => light.name === overlapName),
    );
    const maxScatterAspect = Math.max(
      ...scatterDeltaMetrics.map((sample) => sample.aspect),
    );
    const maxScatterAngularVariation = Math.max(
      ...scatterDeltaMetrics.map((sample) => sample.angularVariation),
    );
    const maxScatterCentroidError = Math.max(
      ...scatterDeltaMetrics.map((sample) =>
        Math.hypot(sample.centroidX - sample.x, sample.centroidY - sample.y),
      ),
    );
    if (
      maxScatterAspect > ROUNDNESS_LIMIT ||
      maxScatterAngularVariation > ANGULAR_UNIFORMITY_LIMIT ||
      maxScatterCentroidError > 2
    ) {
      throw new Error(
        `scatter proof optical disc failed: ${JSON.stringify({
          maxScatterAspect,
          maxScatterAngularVariation,
          maxScatterCentroidError,
          scatterDeltaMetrics,
        })}`,
      );
    }
    const triangleParityApplicable = scatterLinear.backend === "points";
    const triangleLinear = await measureScatterLinear(triangleParityApplicable);
    const triangleLinearPath = await writeScatterLinear(
      triangleLinear,
      "bokeh-scatter-triangle-linear.png",
    );
    const triangleOn = await page.locator("canvas").screenshot();
    const triangleOnPath = join(outputDir, "bokeh-scatter-triangle.png");
    const triangleDeltaPath = join(
      outputDir,
      "bokeh-scatter-triangle-delta.png",
    );
    const triangleDelta = positiveDeltaImage(triangleOn, scatterBase, 2);
    await writeFile(triangleOnPath, triangleOn);
    await writeFile(triangleDeltaPath, triangleDelta);
    const triangleMetrics = measureLights(
      triangleDelta,
      fixture.projectedLights.filter((light) => light.name === overlapName),
    );
    const triangleAspect = Math.max(
      ...triangleMetrics.map((sample) => sample.aspect),
    );
    const triangleAngularVariation = Math.max(
      ...triangleMetrics.map((sample) => sample.angularVariation),
    );
    const triangleEnergyRatio = triangleParityApplicable
      ? triangleLinear.integratedEnergy /
        Math.max(scatterLinear.integratedEnergy, 1e-9)
      : null;
    const trianglePeakRatio = triangleParityApplicable
      ? triangleLinear.peak / Math.max(scatterLinear.peak, 1e-9)
      : null;
    if (
      triangleLinear.backend !== "triangles" ||
      triangleLinear.programDelta !== 0 ||
      triangleLinear.ownedProgramCount !== 1 ||
      triangleLinear.drawCallDelta !== 1 ||
      (triangleParityApplicable && Math.abs(triangleEnergyRatio - 1) > 0.03) ||
      (triangleParityApplicable && Math.abs(trianglePeakRatio - 1) > 0.05) ||
      triangleAspect > ROUNDNESS_LIMIT ||
      triangleAngularVariation > ANGULAR_UNIFORMITY_LIMIT
    ) {
      throw new Error(
        `forced triangle scatter diverged from points: ${JSON.stringify({
          scatterLinear,
          triangleLinear,
          triangleEnergyRatio,
          trianglePeakRatio,
          triangleAspect,
          triangleAngularVariation,
          triangleMetrics,
        })}`,
      );
    }
    scatterProof = {
      scatterBasePath,
      scatterCounterfactualPath,
      scatterOnPath,
      scatterDeltaPath,
      runtime: scatterRuntime,
      linearPath: scatterLinearPath,
      linearPeak: scatterLinear.peak,
      linearIntegratedEnergy: scatterLinear.integratedEnergy,
      triangleLinearPath,
      triangleOnPath,
      triangleDeltaPath,
      triangleLinearPeak: triangleLinear.peak,
      triangleLinearIntegratedEnergy: triangleLinear.integratedEnergy,
      triangleParityApplicable,
      triangleEnergyRatio,
      trianglePeakRatio,
      triangleMetrics,
      maxScatterAspect,
      maxScatterAngularVariation,
      maxScatterCentroidError,
      metrics: scatterDeltaMetrics,
    };
  }
  return scatterProof;
}
