// Controlled visual proof for issues #24/#88: the product's real post stack must turn
// isolated foreground/background HDR lights into round aperture images, while a
// subject on the focus plane stays sharp. Captures live in an OS temp directory.
//
// This is intentionally an app-level fixture, not a second rendering setup. It
// boots the normal engine and StableBokehPass, pauses the product loop, then swaps
// only the visible scene content for a deterministic optical chart. No production
// object, pass, shader, or draw call is added by this tool.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "../app/node_modules/vite/dist/node/index.js";
import {
  ENERGY_RADIUS,
  edgeEnergy,
  makePanStrip,
  maxChannelDifference,
  measureCardLeak,
  measureDiscProfile,
  measureLights,
  measurePositiveDelta,
} from "./lib/bokeh-image-analysis.mjs";
import { measureLinearBokehSweep } from "./lib/bokeh-linear-sweep.mjs";
import {
  BOKEH_OPTICAL_CHART_VIEWPORT,
  installBokehOpticalChart,
} from "./lib/bokeh-optical-chart.mjs";
import { runBokehScatterProof } from "./lib/bokeh-scatter-proof.mjs";
import {
  assertBokehSourceStress,
  runBokehSourceStress,
} from "./lib/bokeh-source-stress.mjs";
import { runBokehMaxDprGpuDiagnostic } from "./lib/bokeh-gpu-diagnostic.mjs";
import {
  launchVerificationBrowser,
  reportWebGLRenderer,
} from "./lib/verification-browser.mjs";
import { CIRCULAR_BOKEH_DEFAULTS } from "../src/env/circular-bokeh-shader.js";

const ROOT = resolve(import.meta.dirname, "..");
const APP_ROOT = join(ROOT, "app");
const cacheDir = await mkdtemp(join(tmpdir(), "cheoma-bokeh-fixture-cache-"));
const outputDir = await mkdtemp(join(tmpdir(), "cheoma-bokeh-fixture-"));
const timeout = Number(process.env.CHEOMA_BOKEH_TIMEOUT_MS) || 180_000;
const scatterProofEnabled = process.env.CHEOMA_BOKEH_SCATTER_PROOF === "1";
const ROUNDNESS_LIMIT = 1.13;
const ANGULAR_UNIFORMITY_LIMIT = 0.32;
const SOURCE_PAN_PAIR_ENERGY_MIN = 0.35;
const SOURCE_PAN_PAIR_ENERGY_MAX = 1.35;
const SOURCE_PAN_ENERGY_STEP_LIMIT = 0.23;
const TELEPHOTO_CORE_MAGNIFICATION_MIN = 4;
const TELEPHOTO_EDGE_DROP_MIN = 0.34;
const BASELINE_RADIUS_SCALE = 2.4;

// Background-subtracted luminance covariance. The square root of its eigenvalue
// ratio is 1 for a circle and grows as a highlight stretches into an ellipse.
const server = await createServer({
  root: APP_ROOT,
  configFile: join(APP_ROOT, "vite.config.js"),
  cacheDir,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false },
});

let browser;
const errors = [];
try {
  if (process.env.CHEOMA_BROWSER !== "chrome") {
    throw new Error("shoot:bokeh GPU evidence requires CHEOMA_BROWSER=chrome");
  }
  await server.listen();
  const port = server.httpServer.address().port;
  browser = await launchVerificationBrowser();
  const page = await browser.newPage({
    viewport: BOKEH_OPTICAL_CHART_VIEWPORT,
  });
  page.setDefaultTimeout(timeout);
  await page.addInitScript(() => {
    window.__noWarm = true;
  });
  page.on("pageerror", (error) => errors.push(`page: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error" && !/favicon|404/i.test(message.text())) {
      errors.push(`console: ${message.text()}`);
    }
  });

  const url =
    `http://127.0.0.1:${port}/?hero=0&village=1&worker=0&shot=1` +
    "&seed=42&vseed=20260716&time=night&season=summer&weather=clear";
  await page.goto(url, { waitUntil: "domcontentloaded", timeout });
  await page.waitForFunction(
    () => window.__SHOT_READY === true && !!window.__engine,
    null,
    { timeout },
  );
  const gpuInfo = await reportWebGLRenderer(page, "bokeh-fixture");
  if (
    !gpuInfo?.renderer ||
    /swiftshader|llvmpipe|software|basic render/i.test(
      `${gpuInfo.renderer} ${gpuInfo.vendor}`,
    )
  ) {
    throw new Error(
      `shoot:bokeh requires a hardware Chrome renderer: ${JSON.stringify(gpuInfo)}`,
    );
  }

  // A locator screenshot includes overlapping HTML controls. Hide every canvas
  // sibling while keeping its ancestor chain laid out at the product dimensions.
  await page.evaluate(() => {
    const canvas = document.querySelector("canvas");
    for (const element of document.body.querySelectorAll("*")) {
      if (element === canvas || element.contains(canvas)) continue;
      element.style.setProperty("visibility", "hidden", "important");
    }
  });

  const threeModuleUrl =
    `/@fs${join(APP_ROOT, "node_modules/three/build/three.module.js")}`;
  const fixture = await installBokehOpticalChart(page, threeModuleUrl);

  const capture = async (name, amount) => {
    const state = await page.evaluate((value) => {
      const engine = window.__engine;
      engine.debugTuneDof({ amount: value, aperture: 0.00015, maxBlur: 0.01 });
      engine.debugRenderDofFrame();
      return engine.debugDof();
    }, amount);
    const path = join(outputDir, `${name}.png`);
    await page.locator("canvas").screenshot({ path });
    console.log(`${path} ${JSON.stringify(state)}`);
    return path;
  };

  const off = await capture("bokeh-hdr-off", 0);
  const prefilterAfterOff = await page.evaluate(() => {
    const prefilter =
      window.__engine.debugPostResources().bokehPass.highlightPrefilter;
    return {
      renderCount: prefilter.renderCount,
      width: prefilter.target.width,
      height: prefilter.target.height,
      depthBuffer: prefilter.target.depthBuffer,
      stencilBuffer: prefilter.target.stencilBuffer,
    };
  });
  const on = await capture("bokeh-hdr-default", 1);
  const prefilterAfterOn = await page.evaluate(() => {
    const prefilter =
      window.__engine.debugPostResources().bokehPass.highlightPrefilter;
    return {
      renderCount: prefilter.renderCount,
      width: prefilter.target.width,
      height: prefilter.target.height,
      depthBuffer: prefilter.target.depthBuffer,
      stencilBuffer: prefilter.target.stencilBuffer,
    };
  });
  if (
    prefilterAfterOn.renderCount !== prefilterAfterOff.renderCount + 1 ||
    prefilterAfterOn.width !== 480 ||
    prefilterAfterOn.height !== 300 ||
    prefilterAfterOn.depthBuffer ||
    prefilterAfterOn.stencilBuffer
  ) {
    throw new Error(
      `highlight prefilter resource/pass contract failed: ${JSON.stringify({
        prefilterAfterOff,
        prefilterAfterOn,
      })}`,
    );
  }
  const linearSweep = await measureLinearBokehSweep(
    page,
    fixture.projectedLights.filter(
      ({ name }) =>
        name === "foreground-open-pair" || name === "foreground-over-focus",
    ),
    [
      1.35,
      1.65,
      1.85,
      2.0,
      2.2,
      2.3,
      BASELINE_RADIUS_SCALE,
      2.6,
      2.8,
      3.0,
      CIRCULAR_BOKEH_DEFAULTS.radiusScale,
    ],
  );
  console.log(`linear-HDR sweep ${JSON.stringify(linearSweep)}`);
  for (const [name, samples] of Object.entries(linearSweep)) {
    const first = samples[0];
    const last = samples.at(-1);
    const baseline = samples.find(
      (sample) => sample.scale === BASELINE_RADIUS_SCALE,
    );
    if (!baseline || last.scale !== CIRCULAR_BOKEH_DEFAULTS.radiusScale) {
      throw new Error(
        `linear-HDR sweep missed baseline/product radii for ${name}`,
      );
    }
    const radiusRatio =
      last.expectedCoCRadius / Math.max(1e-9, baseline.expectedCoCRadius);
    const peakRatio = last.peak / Math.max(1e-9, baseline.peak);
    const coreRatio =
      last.opticalCoreMean / Math.max(1e-9, baseline.opticalCoreMean);
    const expectedAreaDilution = 1 / (radiusRatio * radiusRatio);
    if (
      radiusRatio < 1.28 ||
      Math.abs(peakRatio / expectedAreaDilution - 1) > 0.12 ||
      Math.abs(coreRatio / expectedAreaDilution - 1) > 0.12
    ) {
      throw new Error(
        `product bokeh did not grow and dilute by disc area for ${name}: ${JSON.stringify(
          {
            baseline,
            product: last,
            radiusRatio,
            peakRatio,
            coreRatio,
            expectedAreaDilution,
          },
        )}`,
      );
    }
    const energyValues = samples.map((sample) => sample.integratedEnergy);
    const energyRange =
      (Math.max(...energyValues) - Math.min(...energyValues)) /
      Math.max(
        1e-9,
        energyValues.reduce((sum, value) => sum + value, 0) /
          energyValues.length,
      );
    const signedEnergyValues = samples.map(
      (sample) => sample.signedIntegratedEnergy,
    );
    const signedEnergyRange =
      (Math.max(...signedEnergyValues) - Math.min(...signedEnergyValues)) /
      Math.max(
        1e-9,
        signedEnergyValues.reduce((sum, value) => sum + value, 0) /
          signedEnergyValues.length,
      );
    const monotone = (key) =>
      samples
        .slice(1)
        .every((sample, index) => sample[key] < samples[index][key]);
    const increasing = (key) =>
      samples
        .slice(1)
        .every((sample, index) => sample[key] > samples[index][key]);
    const largeRadiusPeakArea = samples
      .slice(-4)
      .map(
        (sample) =>
          sample.peak * sample.expectedCoCRadius * sample.expectedCoCRadius,
      );
    const largeRadiusCoreArea = samples
      .slice(-4)
      .map(
        (sample) =>
          sample.opticalCoreMean *
          sample.expectedCoCRadius *
          sample.expectedCoCRadius,
      );
    const peakAreaMean =
      largeRadiusPeakArea.reduce((sum, value) => sum + value, 0) /
      largeRadiusPeakArea.length;
    const peakAreaRange =
      (Math.max(...largeRadiusPeakArea) -
        Math.min(...largeRadiusPeakArea)) /
      Math.max(1e-9, peakAreaMean);
    const coreAreaMean =
      largeRadiusCoreArea.reduce((sum, value) => sum + value, 0) /
      largeRadiusCoreArea.length;
    const coreAreaRange =
      (Math.max(...largeRadiusCoreArea) -
        Math.min(...largeRadiusCoreArea)) /
      Math.max(1e-9, coreAreaMean);
    if (
      !samples
        .slice(1)
        .every(
          (sample, index) =>
            sample.expectedCoCArea > samples[index].expectedCoCArea,
        ) ||
      !increasing("covarianceArea") ||
      !increasing("rmsRadius") ||
      !(last.covarianceArea > first.covarianceArea * 1.5) ||
      !samples
        .slice(1)
        .every(
          (sample, index) =>
            sample.peak <= samples[index].peak * 1.03,
        ) ||
      peakAreaRange > 0.15 ||
      coreAreaRange > 0.1 ||
      !monotone("opticalDiscMean") ||
      !(last.peak < first.peak * 0.75) ||
      !(last.opticalDiscMean < first.opticalDiscMean * 0.75) ||
      energyRange > 0.05 ||
      signedEnergyRange > 0.05 ||
      samples.some((sample) => sample.negativeEnergyRatio > 0.03)
    ) {
      throw new Error(
        `linear-HDR radius/energy contract failed for ${name}: ${JSON.stringify(
          {
            energyRange,
            signedEnergyRange,
            largeRadiusPeakArea,
            peakAreaRange,
            largeRadiusCoreArea,
            coreAreaRange,
            samples,
          },
        )}`,
      );
    }
  }
  const repeatState = await page.evaluate(() =>
    window.__engine.debugRenderDofFrame(),
  );
  const repeat = await page.locator("canvas").screenshot();
  const offImage = await readFile(off);
  const pixelStable = repeat.equals(await readFile(on));
  if (!pixelStable)
    throw new Error(
      "static bokeh fixture changed between identical product frames",
    );
  const programKeysBefore = await page.evaluate(() =>
    (window.__engine.renderer.info.programs || [])
      .map((program) => program.cacheKey)
      .sort(),
  );

  const onMetrics = measureLights(repeat, fixture.projectedLights);
  const offMetrics = measureLights(offImage, fixture.projectedLights);
  const overlapName = "foreground-over-focus";
  const maxAspect = Math.max(
    ...onMetrics
      .filter((sample) => sample.name !== overlapName)
      .map((sample) => sample.aspect),
  );
  if (maxAspect > ROUNDNESS_LIMIT) {
    throw new Error(
      `bokeh aperture stretched to ${maxAspect.toFixed(3)} (limit ${ROUNDNESS_LIMIT})`,
    );
  }
  const lightByName = (name) =>
    fixture.projectedLights.find((light) => light.name === name);
  const openPair = measurePositiveDelta(
    repeat,
    offImage,
    lightByName("foreground-open-pair"),
    ENERGY_RADIUS,
  );
  const cardPair = measurePositiveDelta(
    repeat,
    offImage,
    lightByName(overlapName),
    ENERGY_RADIUS,
  );
  const telephotoProfile = measureDiscProfile(
    repeat,
    lightByName("foreground-open-pair"),
  );
  // For a filled circular disc RMS radius is R/sqrt(2), so this converts the
  // positive-delta covariance into a comparable effective diameter.
  telephotoProfile.cardEffectiveDiameterPx =
    cardPair.rmsRadius * 2 * Math.SQRT2;
  telephotoProfile.cardEffectiveMagnification =
    telephotoProfile.cardEffectiveDiameterPx /
    Math.max(1e-9, telephotoProfile.projectedEmitterDiameterPx);
  const pairAnnulusRatio =
    cardPair.annulusEnergy / Math.max(1, openPair.annulusEnergy);
  const pairEnergyRatio = cardPair.energy / Math.max(1, openPair.energy);
  if (!(
    openPair.aspect <= ROUNDNESS_LIMIT &&
    cardPair.aspect <= ROUNDNESS_LIMIT &&
    openPair.centroidError <= 2 &&
    cardPair.centroidError <= 2 &&
    pairEnergyRatio >= 0.35 &&
    pairEnergyRatio <= 1.35
  )) {
    throw new Error(
      `source-depth paired bokeh failed: ${JSON.stringify({
        openPair,
        cardPair,
        pairAnnulusRatio,
        pairEnergyRatio,
      })}`,
    );
  }
  if (!(
    telephotoProfile.coreMagnification >= TELEPHOTO_CORE_MAGNIFICATION_MIN &&
    telephotoProfile.outerMagnification > telephotoProfile.coreMagnification &&
    telephotoProfile.edgeDrop >= TELEPHOTO_EDGE_DROP_MIN &&
    telephotoProfile.cardEffectiveMagnification >=
      TELEPHOTO_CORE_MAGNIFICATION_MIN
  )) {
    throw new Error(
      `telephoto bokeh scale/rim profile failed: ${JSON.stringify(telephotoProfile)}`,
    );
  }
  const controlByName = (name) =>
    fixture.projectedControls.find((control) => control.name === name);
  const dimLeak = measureCardLeak(
    repeat,
    offImage,
    controlByName("dim-foreground-bar"),
    fixture.focusCardBounds,
    "left",
  );
  const farLeak = measureCardLeak(
    repeat,
    offImage,
    controlByName("background-edge-control"),
    fixture.focusCardBounds,
    "right",
  );
  if (
    dimLeak.maxPositiveChannel > 1 ||
    dimLeak.meanPositiveLuminance > 0.25 ||
    farLeak.maxPositiveChannel > 1 ||
    farLeak.meanPositiveLuminance > 0.25
  ) {
    throw new Error(
      `source-depth negative control leaked into focus card: ${JSON.stringify({
        dimLeak,
        farLeak,
      })}`,
    );
  }
  const edgeControl = controlByName("focus-edge-control");
  const edgeEnergyOff = edgeEnergy(offImage, edgeControl);
  const edgeEnergyOn = edgeEnergy(repeat, edgeControl);
  const edgeEnergyRatio = edgeEnergyOn / Math.max(1, edgeEnergyOff);
  // A larger physical foreground disc may cover a small part of this focus-plane
  // line. Its own edge must remain sharp; allow only the measured optical overlap.
  if (edgeEnergyRatio < 0.95) {
    throw new Error(
      `non-HDR focus edge lost energy under source probing (${edgeEnergyRatio})`,
    );
  }
  // Prove that the two zero-leak controls are not probe misses: at the exact same
  // projected positions and coverage, make the dim source HDR and move the far
  // source in front of the card. Both must then register inside the sampled card
  // strips before their original HDR/depth rejection state is restored.
  await page.evaluate(() => {
    const engine = window.__engine;
    const dim = engine.scene.getObjectByName("dim-foreground-bar");
    const far = engine.scene.getObjectByName("background-edge-control");
    dim.material.color.setRGB(11, 4.2, 0.75);
    far.position.set(2.1, 1, 80);
    far.scale.setScalar(0.04);
    far.updateMatrixWorld(true);
    engine.debugRenderDofFrame();
  });
  const counterfactualImage = await page.locator("canvas").screenshot();
  const counterfactualPath = join(
    outputDir,
    "bokeh-source-rejection-counterfactual.png",
  );
  await writeFile(counterfactualPath, counterfactualImage);
  const controlCounterfactuals = {
    dimAsHdr: measureCardLeak(
      counterfactualImage,
      repeat,
      controlByName("dim-foreground-bar"),
      fixture.focusCardBounds,
      "left",
    ),
    farAsNear: measureCardLeak(
      counterfactualImage,
      repeat,
      controlByName("background-edge-control"),
      fixture.focusCardBounds,
      "right",
    ),
  };
  if (
    controlCounterfactuals.dimAsHdr.maxPositiveChannel < 4 ||
    controlCounterfactuals.dimAsHdr.meanPositiveLuminance < 0.5 ||
    controlCounterfactuals.farAsNear.maxPositiveChannel < 4 ||
    controlCounterfactuals.farAsNear.meanPositiveLuminance < 0.5
  ) {
    throw new Error(
      `source rejection controls missed the card probe: ${JSON.stringify(controlCounterfactuals)}`,
    );
  }
  await page.evaluate(() => {
    const engine = window.__engine;
    const dim = engine.scene.getObjectByName("dim-foreground-bar");
    const far = engine.scene.getObjectByName("background-edge-control");
    dim.material.color.setRGB(0.2, 0.14, 0.08);
    far.position.set(25.2, 12, -140);
    far.scale.setScalar(0.4);
    far.updateMatrixWorld(true);
    engine.debugRenderDofFrame();
  });
  const restoredControlImage = await page.locator("canvas").screenshot();
  if (maxChannelDifference(repeat, restoredControlImage) > 1) {
    throw new Error(
      "source rejection counterfactual did not restore the byte-stable fixture",
    );
  }
  // Preserve a stable reference at the final pan pose. The moving sequence will
  // arrive at this exact camera again through the 13-tap path, then settle back
  // to the reference without changing the aperture center or radius.
  const finalTargetX = 0.105;
  const stableFinalState = await page.evaluate((targetX) => {
    const engine = window.__engine;
    engine.camera.position.set(0, 0, 100);
    engine.__controls.target.set(targetX, 0, 0);
    engine.camera.lookAt(engine.__controls.target);
    engine.camera.updateMatrixWorld(true);
    engine.debugRenderDofFrame(1 / 60);
    for (let i = 0; i < 30; i++) engine.debugAdvancePostQuality(1 / 60);
    return engine.debugRenderDofFrame();
  }, finalTargetX);
  const stableFinalReference = await page.locator("canvas").screenshot();
  const stableFinalPath = join(outputDir, "bokeh-final-stable-reference.png");
  await writeFile(stableFinalPath, stableFinalReference);

  // Eight fixed yaw steps move the chart by roughly two pixels. This is slow
  // enough to expose screen-space kernel crawl without conflating it with a large
  // perspective/composition change.
  const panFrames = [];
  for (let index = 0; index < 8; index++) {
    const targetX = -0.105 + index * (0.21 / 7);
    const frame = await page.evaluate(
      ({ targetX, names }) => {
        const engine = window.__engine;
        engine.camera.position.set(0, 0, 100);
        engine.__controls.target.set(targetX, 0, 0);
        engine.camera.lookAt(engine.__controls.target);
        engine.camera.updateMatrixWorld(true);
        const state = engine.debugRenderDofFrame(1 / 60);
        const lights = names.map((name) => {
          const object = engine.scene.getObjectByName(name);
          const projected = object
            .getWorldPosition(object.position.clone())
            .project(engine.camera);
          return {
            name,
            x: (projected.x * 0.5 + 0.5) * 960,
            y: (-projected.y * 0.5 + 0.5) * 600,
          };
        });
        return { lights, state };
      },
      { targetX, names: fixture.projectedLights.map((light) => light.name) },
    );
    const image = await page.locator("canvas").screenshot();
    await page.evaluate(() => {
      const engine = window.__engine;
      engine.debugTuneDof({ amount: 0 });
      engine.debugRenderDofFrame();
    });
    const offImageAtPose = await page.locator("canvas").screenshot();
    await page.evaluate((sourceName) => {
      const engine = window.__engine;
      engine.scene.getObjectByName(sourceName).visible = false;
      engine.debugRenderDofFrame();
    }, overlapName);
    const sharpBaselineAtPose = await page.locator("canvas").screenshot();
    await page.evaluate((sourceName) => {
      const engine = window.__engine;
      engine.scene.getObjectByName(sourceName).visible = true;
      engine.debugTuneDof({ amount: 1 });
      engine.debugRenderDofFrame();
    }, overlapName);
    const openDelta = measurePositiveDelta(
      image,
      offImageAtPose,
      frame.lights.find((light) => light.name === "foreground-open-pair"),
      ENERGY_RADIUS,
    );
    const cardDelta = measurePositiveDelta(
      image,
      offImageAtPose,
      frame.lights.find((light) => light.name === overlapName),
      ENERGY_RADIUS,
    );
    const sharpInput = measurePositiveDelta(
      offImageAtPose,
      sharpBaselineAtPose,
      frame.lights.find((light) => light.name === overlapName),
      ENERGY_RADIUS,
    );
    panFrames.push({
      targetX,
      lights: frame.lights,
      state: frame.state,
      image,
      offImage: offImageAtPose,
      metrics: measureLights(image, frame.lights),
      sourceDelta: {
        open: openDelta,
        card: cardDelta,
        sharpInput,
        pairEnergyRatio: cardDelta.energy / Math.max(1, openDelta.energy),
      },
    });
  }
  const repairedPanEnergy = panFrames.map(
    (frame) =>
      frame.sourceDelta.card.energy /
      Math.max(1, frame.sourceDelta.sharpInput.energy),
  );
  const repairedPanRms = panFrames.map(
    (frame) => frame.sourceDelta.card.rmsRadius,
  );
  const repairedEnergyMean =
    repairedPanEnergy.reduce((sum, value) => sum + value, 0) /
    repairedPanEnergy.length;
  const repairedPanStability = {
    integratedEnergy: repairedPanEnergy,
    rmsRadius: repairedPanRms,
    maxRelativeEnergyStep: Math.max(
      ...repairedPanEnergy
        .slice(1)
        .map(
          (value, index) =>
            Math.abs(value - repairedPanEnergy[index]) /
            Math.max(1e-9, (value + repairedPanEnergy[index]) * 0.5),
        ),
    ),
    relativeEnergyRange:
      (Math.max(...repairedPanEnergy) - Math.min(...repairedPanEnergy)) /
      Math.max(1e-9, repairedEnergyMean),
    maxRmsRadiusStep: Math.max(
      ...repairedPanRms
        .slice(1)
        .map((value, index) => Math.abs(value - repairedPanRms[index])),
    ),
  };
  if (
    !panFrames.every(
      (frame) =>
        frame.state.postQuality === 0 &&
        frame.state.activeBokehTaps === 13 &&
        frame.sourceDelta.open.aspect <= ROUNDNESS_LIMIT &&
        frame.sourceDelta.card.aspect <= ROUNDNESS_LIMIT &&
        frame.sourceDelta.open.centroidError <= 2 &&
        frame.sourceDelta.card.centroidError <= 2 &&
        frame.sourceDelta.pairEnergyRatio >= SOURCE_PAN_PAIR_ENERGY_MIN &&
        frame.sourceDelta.pairEnergyRatio <= SOURCE_PAN_PAIR_ENERGY_MAX,
    ) ||
    repairedPanStability.maxRelativeEnergyStep > SOURCE_PAN_ENERGY_STEP_LIMIT ||
    repairedPanStability.relativeEnergyRange > 0.3 ||
    repairedPanStability.maxRmsRadiusStep > 0.75
  ) {
    throw new Error(
      `camera pan lost moving source-depth bokeh: ${JSON.stringify({
        frames: panFrames.map((frame) => ({
          state: frame.state,
          sourceDelta: frame.sourceDelta,
        })),
        repairedPanStability,
      })}`,
    );
  }

  const settleFrames = [];
  for (let index = 0; index < 22; index++) {
    const state = await page.evaluate(() =>
      window.__engine.debugRenderDofFrame(1 / 60),
    );
    if ([0, 3, 7, 10, 14, 18, 21].includes(index)) {
      const image = await page.locator("canvas").screenshot();
      const lights = panFrames.at(-1).lights;
      settleFrames.push({
        index,
        lights,
        state,
        image,
        metrics: measureLights(image, lights),
      });
    }
  }
  const settledState = settleFrames.at(-1).state;
  const settledImage = settleFrames.at(-1).image;
  const finalPixelDifference = maxChannelDifference(
    stableFinalReference,
    settledImage,
  );
  if (settledState.postQuality !== 1 || settledState.activeBokehTaps !== 41) {
    throw new Error(
      "static camera did not restore the exact stable 41-tap path",
    );
  }
  if (finalPixelDifference > 1) {
    throw new Error(
      `settled bokeh differs from its stable reference by ${finalPixelDifference} channels`,
    );
  }
  const unobstructedNames = new Set(
    fixture.projectedLights
      .map((light) => light.name)
      .filter((name) => name !== "foreground-over-focus"),
  );
  const transitionMetrics = [...panFrames, ...settleFrames]
    .flatMap((frame) => frame.metrics)
    .filter((sample) => unobstructedNames.has(sample.name));
  const maxAngularVariation = Math.max(
    ...transitionMetrics.map((sample) => sample.angularVariation),
  );
  if (maxAngularVariation > ANGULAR_UNIFORMITY_LIMIT) {
    throw new Error(
      `moving/settling bokeh has visible radial lobes ${maxAngularVariation.toFixed(3)} (limit ${ANGULAR_UNIFORMITY_LIMIT})`,
    );
  }
  const motion = fixture.projectedLights
    .filter((light) => light.name !== overlapName)
    .map((light) => {
      const samples = panFrames.map((frame) =>
        frame.metrics.find((sample) => sample.name === light.name),
      );
      const energies = samples.map((sample) => sample.energy);
      const aspects = samples.map((sample) => sample.aspect);
      const centers = samples.map((sample) => sample.centroidX);
      const meanEnergy =
        energies.reduce((sum, value) => sum + value, 0) / energies.length;
      return {
        name: light.name,
        energyRange:
          (Math.max(...energies) - Math.min(...energies)) / meanEnergy,
        maxAspect: Math.max(...aspects),
        centroidTravel: Math.max(...centers) - Math.min(...centers),
      };
    });
  const maxMotionAspect = Math.max(...motion.map((sample) => sample.maxAspect));
  if (maxMotionAspect > ROUNDNESS_LIMIT) {
    throw new Error(
      `moving bokeh aperture stretched to ${maxMotionAspect.toFixed(3)} (limit ${ROUNDNESS_LIMIT})`,
    );
  }
  // This value is diagnostic rather than a golden: subpixel raster coverage and
  // browser color math can shift total crop energy even when the aperture moves
  // coherently. The pan strip is the visual temporal-crawl acceptance artifact.
  const maxEnergyRange = Math.max(
    ...motion.map((sample) => sample.energyRange),
  );
  const overlapOn = onMetrics.find((sample) => sample.name === overlapName);
  const overlapOff = offMetrics.find((sample) => sample.name === overlapName);
  const overlapProbe = {
    name: overlapName,
    rmsRatio: overlapOn.rmsRadius / overlapOff.rmsRadius,
    openPair,
    cardPair,
    annulusRatio: pairAnnulusRatio,
    recovery:
      "disjoint compact-source energy is scattered from its owned front depth",
  };
  const panStrip = join(outputDir, "bokeh-pan-settle-strip.png");
  await writeFile(
    panStrip,
    makePanStrip(
      [...panFrames, ...settleFrames],
      [
        "foreground-amber-left",
        "background-gold-left",
        "foreground-over-focus",
      ],
    ),
  );

  const gpuTiming = await page.evaluate(async () => {
    const engine = window.__engine;
    const gl = engine.renderer.getContext();
    const ext = gl.getExtension("EXT_disjoint_timer_query_webgl2");
    if (!ext || typeof gl.createQuery !== "function")
      return { available: false };
    // Timer-query results on ANGLE/Metal have enough per-query jitter that
    // comparing isolated A/B samples is flaky. Measure larger batches in
    // alternating ABBA blocks: each block balances short-term GPU drift while
    // keeping the total number of query waits lower than the old 12-pair gate.
    const batchSize = 24;
    let sawDisjoint = false;
    const measure = async () => {
      const resources = engine.debugPostResources();
      const query = gl.createQuery();
      gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
      for (let index = 0; index < batchSize; index++) {
        resources.bokehPass.render(
          engine.renderer,
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
      if (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) return null;
      sawDisjoint ||= !!gl.getParameter(ext.GPU_DISJOINT_EXT);
      const milliseconds =
        gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6 / batchSize;
      gl.deleteQuery(query);
      return milliseconds;
    };
    const enterMovingAtFinalPose = () => {
      const fov = engine.camera.fov;
      engine.camera.fov = fov + 0.5;
      engine.camera.updateProjectionMatrix();
      engine.debugAdvancePostQuality(1 / 60);
      engine.camera.fov = fov;
      engine.camera.updateProjectionMatrix();
      engine.debugAdvancePostQuality(1 / 60);
    };
    const settle = () => {
      for (let i = 0; i < 30; i++) engine.debugAdvancePostQuality(1 / 60);
    };
    const blocks = [];
    for (let block = 0; block < 3; block++) {
      const sequence =
        block % 2 === 0
          ? ["moving", "stable", "stable", "moving"]
          : ["stable", "moving", "moving", "stable"];
      const samples = [];
      for (const quality of sequence) {
        if (quality === "moving") enterMovingAtFinalPose();
        else settle();
        samples.push({ quality, milliseconds: await measure() });
      }
      blocks.push(samples);
    }
    const disjoint = sawDisjoint || !!gl.getParameter(ext.GPU_DISJOINT_EXT);
    if (blocks.flat().some((sample) => sample.milliseconds == null)) {
      return { available: true, complete: false, disjoint };
    }
    const median = (values) => {
      const sorted = [...values].sort((a, b) => a - b);
      const middle = sorted.length >> 1;
      return sorted.length % 2
        ? sorted[middle]
        : (sorted[middle - 1] + sorted[middle]) * 0.5;
    };
    const moving = blocks.flatMap((samples) =>
      samples
        .filter((sample) => sample.quality === "moving")
        .map((sample) => sample.milliseconds),
    );
    const stable = blocks.flatMap((samples) =>
      samples
        .filter((sample) => sample.quality === "stable")
        .map((sample) => sample.milliseconds),
    );
    const blockRatios = blocks.map((samples) => {
      const movingSamples = samples
        .filter((sample) => sample.quality === "moving")
        .map((sample) => sample.milliseconds);
      const stableSamples = samples
        .filter((sample) => sample.quality === "stable")
        .map((sample) => sample.milliseconds);
      return median(movingSamples) / median(stableSamples);
    });
    return {
      available: true,
      complete: true,
      disjoint,
      moving,
      stable,
      movingMedianMs: median(moving),
      stableMedianMs: median(stable),
      ratio: median(moving) / median(stable),
      blockRatios,
      blockRatioMedian: median(blockRatios),
      winningBlocks: blockRatios.filter((ratio) => ratio < 1).length,
      batchSize,
    };
  });
  if (!gpuTiming.available || !gpuTiming.complete || gpuTiming.disjoint) {
    throw new Error(
      `Chrome GPU timer unavailable or invalid: ${JSON.stringify(gpuTiming)}`,
    );
  }
  if (!(
    gpuTiming.ratio < 0.85 &&
    gpuTiming.blockRatioMedian < 0.9 &&
    gpuTiming.winningBlocks >= 2
  )) {
    throw new Error(
      `13-tap GPU median did not improve on 41 taps: ${JSON.stringify(gpuTiming)}`,
    );
  }
  const programKeysAfter = await page.evaluate(() =>
    (window.__engine.renderer.info.programs || [])
      .map((program) => program.cacheKey)
      .sort(),
  );
  const programKeysStable =
    JSON.stringify(programKeysBefore) === JSON.stringify(programKeysAfter);
  if (!programKeysStable) {
    throw new Error(
      "source-depth ON/OFF and pan path created a new shader program",
    );
  }
  const scatterProof = await runBokehScatterProof({
    page,
    outputDir,
    fixture,
    overlapName,
    roundnessLimit: ROUNDNESS_LIMIT,
    angularUniformityLimit: ANGULAR_UNIFORMITY_LIMIT,
    enabled: scatterProofEnabled,
  });
  // The proof deliberately exercises the former 2.4 baseline. Return to the
  // exported product radius before stress and max-DPR measurements so their
  // performance/resource evidence describes the shipped profile.
  await page.evaluate((radiusScale) => {
    const pass = window.__engine.debugPostResources().bokehPass;
    pass.uniforms.bokehRadiusScale.value = radiusScale;
    window.__engine.debugRenderDofFrame();
  }, CIRCULAR_BOKEH_DEFAULTS.radiusScale);
  await page.setViewportSize({ width: 961, height: 601 });
  await page.evaluate(
    () =>
      new Promise((resolveFrame) =>
        requestAnimationFrame(() => requestAnimationFrame(resolveFrame)),
      ),
  );
  const sourceStress = await runBokehSourceStress(
    page,
    threeModuleUrl,
  );
  await page.setViewportSize(BOKEH_OPTICAL_CHART_VIEWPORT);
  assertBokehSourceStress(sourceStress);
  const maxDprGpu = scatterProofEnabled
    ? await runBokehMaxDprGpuDiagnostic(page, 2)
    : null;
  if (
    maxDprGpu &&
    (!maxDprGpu.available ||
      maxDprGpu.disjoint ||
      maxDprGpu.pixelRatio !== 2 ||
      maxDprGpu.ratio > 2.5 ||
      maxDprGpu.deltaMs > 4)
  ) {
    throw new Error(
      `max-DPR pass-only GPU diagnostic failed: ${JSON.stringify(maxDprGpu)}`,
    );
  }
  console.log(`BOKEH FIXTURE: ${outputDir}`);
  console.log(
    `fixture: ${JSON.stringify({
      ...fixture,
      off,
      on,
      panStrip,
      stableFinalPath,
      stableFinalState,
      settledState,
      finalPixelDifference,
      maxAngularVariation,
      gpuTiming,
      gpuInfo,
      pixelStable,
      maxAspect,
      maxMotionAspect,
      maxEnergyRange,
      overlapProbe,
      telephotoProfile,
      linearEnergy: linearSweep,
      highlightPrefilter: {
        afterOff: prefilterAfterOff,
        afterOn: prefilterAfterOn,
      },
      counterfactualPath,
      controlCounterfactuals,
      repairedPanStability,
      negativeControls: { dimLeak, farLeak, edgeEnergyRatio },
      programKeysStable,
      onMetrics,
      motion,
      repeatState,
      scatterProof,
      sourceStress,
      maxDprGpu,
    })}`,
  );
  console.log(`runtime errors: ${errors.length}`);
  for (const error of errors) console.log(error);
  if (errors.length) process.exitCode = 1;
} catch (error) {
  console.error(error.stack || error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
}
