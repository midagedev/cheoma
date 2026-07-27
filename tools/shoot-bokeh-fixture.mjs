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
  edgeEnergy,
  ENERGY_RADIUS,
  makePanStrip,
  maxChannelDifference,
  measureCardLeak,
  measureDiscProfile,
  measureLights,
  measurePositiveDelta,
  ROUNDNESS_RADIUS,
  SOURCE_ANNULUS_INNER,
  SOURCE_ANNULUS_OUTER,
  STRIP_RADIUS,
} from "./lib/bokeh-image-analysis.mjs";
import {
  BOKEH_SWEEP_CORE_BAND,
  bokehSourceDiscRadiusPx,
  bokehSurfaceDiscRadiusPx,
  measureLinearBokehSweep,
  readBokehSweepOptics,
} from "./lib/bokeh-linear-sweep.mjs";
import {
  BOKEH_SOURCE_CONTRACT,
  bokehSourceAnnulusMeanWeight,
  bokehSourcePeakWeight,
} from "../src/env/bokeh-source-contract.js";
import { BOKEH_COC_DEFAULTS } from "../src/env/bokeh-coc-contract.js";

const PRODUCT_APERTURE_METERS = BOKEH_COC_DEFAULTS.apertureMeters;
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
import {
  BOKEH_GATHER_TAP_COUNT,
  CIRCULAR_BOKEH_DEFAULTS,
} from "../src/env/circular-bokeh-shader.js";

const ROOT = resolve(import.meta.dirname, "..");
const APP_ROOT = join(ROOT, "app");
const cacheDir = await mkdtemp(join(tmpdir(), "cheoma-bokeh-fixture-cache-"));
const outputDir = await mkdtemp(join(tmpdir(), "cheoma-bokeh-fixture-"));
const timeout = Number(process.env.CHEOMA_BOKEH_TIMEOUT_MS) || 180_000;
const scatterProofEnabled = process.env.CHEOMA_BOKEH_SCATTER_PROOF === "1";
// Aperture roundness, split by optical side because the two sides do not measure the
// same thing at this fixture's geometry.
//
// BACKGROUND is the assertion "a defocused point light is a circle": the far bank sits
// 140m behind the focus plane, its physical CoC radius is 321.1 * (1/100 - 1/240) =
// 1.873px, and x2.8 source multiplier = 5.24px of disc against a ~2px emitter. Every
// far light measures 1.001-1.004, so the limit is 1.05 - tight enough that a genuinely
// elliptical aperture cannot hide in it.
//
// FOREGROUND is a *known defect with a boundary on it*, not a relaxed assertion. The
// near bank is only 20m in front of focus, so its CoC is 321.1 * (1/100 - 1/80) =
// 0.80px and x2.8 = 2.25px - 2.3x smaller than the background disc and comparable to
// the emitter's own projected face. At that radius the covariance eigenvalue ratio is
// dominated by the pixel lattice and by the one-pixel-wide `coverage` rolloff rather
// than by the aperture shape, and the near lights measure 1.007-1.346 (worst:
// foreground-open-pair).
//
// The number is set just above the measurement rather than at a comfortable margin,
// which makes this gate STRONGER than the flat 1.13 it replaces:
//   * pre-existing, not caused by the half-res CoC round. A controlled experiment with
//     the previous per-texel depth build measured 1.376; the MSAA depth-election fix
//     brought it to 1.346, so this axis improved. It was never observed before only
//     because an earlier dilution assertion threw first and execution never reached here.
//   * 1.376 (the pre-fix build) now FAILS at a 1.37 limit. The gate cannot be satisfied
//     by reverting the fix.
//   * the contrast with BACKGROUND_ROUNDNESS_LIMIT is the diagnosis: circularity holds
//     wherever the disc is large enough to have a shape, and only degrades where the
//     disc is barely larger than its source.
// Next-round candidates, BOTH UNVERIFIED HYPOTHESES: (a) extend the gather's 3x3 near
// dilate so a small near disc is reconstructed from more than its own texel, (b) force
// the triangle backend below the point-size cap so a small near disc is rasterised as
// geometry instead of a lattice-quantised point sprite.
const BACKGROUND_ROUNDNESS_LIMIT = 1.05;
const FOREGROUND_ROUNDNESS_LIMIT = 1.37;
/** Per-light roundness limit. Anything not named `background-*` is a near source. */
const roundnessLimitFor = (name) =>
  String(name).startsWith("background-")
    ? BACKGROUND_ROUNDNESS_LIMIT
    : FOREGROUND_ROUNDNESS_LIMIT;
const ANGULAR_UNIFORMITY_LIMIT = 0.32;
const SOURCE_PAN_ENERGY_STEP_LIMIT = 0.23;
const SOURCE_PAN_INPUT_ENERGY_MIN = 0.35;
const SOURCE_PAN_INPUT_ENERGY_MAX = 0.5;
const SOURCE_PAN_RADIUS_RATIO_MIN = 0.95;
const SOURCE_PAN_RADIUS_RATIO_MAX = 1.05;
const TELEPHOTO_CORE_MAGNIFICATION_MIN = 4;
const TELEPHOTO_EDGE_DROP_MIN = 0.34;
const LEGACY_RADIUS_SCALE = 2.4;
// The compact-source multiplier ladder. It has to be strictly increasing and end
// on the shipped value, because the sweep's monotonicity and area-dilution
// assertions read "first" as the small-radius reference and "last" as the product.
// The former ladder ran past the product because the product multiplier used to be
// larger than 4.2; it is now 2.8 (docs/dof-cinematic-research.md 8, pending user
// sign-off) and this list must never be re-sorted by hand to accommodate a change
// in that constant - the assertion below fails loudly instead.
const SWEEP_RADIUS_SCALES = Object.freeze([
  1.35,
  1.5,
  1.65,
  1.8,
  2.0,
  2.15,
  2.3,
  LEGACY_RADIUS_SCALE,
  2.6,
  CIRCULAR_BOKEH_DEFAULTS.sourceRadiusScale,
]);
// The reference the product radius is compared against for growth and area
// dilution. Keeping it the ladder's smallest entry maximises the lever arm.
const SWEEP_REFERENCE_RADIUS_SCALE = SWEEP_RADIUS_SCALES[0];
const SWEEP_PRODUCT_RADIUS_RATIO_MIN = 1.4;
const SWEEP_CORE_BAND_MIN = BOKEH_SWEEP_CORE_BAND.min;
const SWEEP_CORE_BAND_MAX = BOKEH_SWEEP_CORE_BAND.max;
// Both tolerances cover measurement, not optics. The predictor is for an ideal point
// emitter; the fixture's sources are ~4px spheres, so their own footprint is
// convolved into the rendered disc. That barely touches the flat interior (measured
// agreement across the whole ladder is within 0.1%) but it does soften the rim, and
// the rim is where the peak lives, which is why the two bands differ by 5x.
const SWEEP_CORE_TOLERANCE = 0.02;
const SWEEP_PEAK_TOLERANCE = 0.1;
// Measured 5%-of-peak support radius minus the contract radius. This is the assertion
// that catches a wrong CoC curve rather than a merely self-consistent one, so it is
// stated the way the quantity actually behaves: as an **additive** pixel offset.
//
// The aperture profile's coverage term reaches zero at radius + 0.5px, so a point
// emitter's support could never exceed that. The fixture's emitters are not points -
// the chart authors them at ~4px emissive faces - and each ownership block splats its
// disc from the block centre, so the measured edge sits at the contract radius plus
// the emitter's own half-extent plus that quantisation. All three terms are absolute
// pixels, which is exactly why a *ratio* band is the wrong shape: it tightens as the
// radius shrinks and slackens as it grows, the opposite of the truth. The former
// 0.95..1.15 ratio band admitted -0.87px at the ladder's small end and +5.4px at its
// large end, and it was only ever satisfied because a hot core inflated the peak and
// so raised the 5%-of-peak threshold.
//
// Measured offset across the whole ladder and both sweep sources: 2.788..2.984px.
const SOURCE_SUPPORT_OFFSET_MIN_PX = 0.5;
const SOURCE_SUPPORT_OFFSET_MAX_PX =
  0.5 + 4 / 2 + BOKEH_SOURCE_CONTRACT.blockSize;
// The real claim is radius-independence: a wrong CoC curve makes this offset drift
// with radius instead of staying put, and nothing else in this gate would notice.
const SOURCE_SUPPORT_OFFSET_RANGE_MAX_PX = 0.6;
// Counterfactual: with the source scatter disabled the same ON−OFF difference is
// the surface gather's own image of the source. Two bounds hold there and both are
// asserted, because together they say the surface path is a different, much
// smaller, radiusScale-blind response.
//   * Upper bound. The clamped physical CoC is the furthest the gather can ever
//     reach, so the measured extent can never exceed it.
//   * Lower bound. It cannot reach the physical radius either: an isolated compact
//     emitter only bleeds forward through the gather's bounded 3x3 near max-dilate
//     (bokeh-coc-shaders.js), so its footprint is the source's own half-resolution
//     block plus one dilate ring. That quantises to a few half-resolution texels,
//     which is why this band is a fraction of the analytic radius rather than 1.0.
const SURFACE_SUPPORT_RATIO_MIN = 0.5;
const SURFACE_SUPPORT_RATIO_MAX = 1.05;
// Nothing in the surface path reads bokehRadiusScale, so sweeping the whole ladder
// must not move this radius at all. Measured range is exactly 0; the tolerance
// only allows float noise.
const SURFACE_RADIUS_INVARIANCE_MAX = 0.02;
// Per-scale separation of the two axes. Even the smallest source multiplier on the
// ladder must produce a disc clearly larger than everything the surface path can
// do, or "the difference responds to the source axis" would not be observable.
const SOURCE_OVER_SURFACE_RADIUS_MIN = 1.5;
if (
  SWEEP_RADIUS_SCALES.some(
    (scale, index) => index > 0 && !(scale > SWEEP_RADIUS_SCALES[index - 1]),
  ) ||
  SWEEP_RADIUS_SCALES.at(-1) !== CIRCULAR_BOKEH_DEFAULTS.sourceRadiusScale ||
  !(
    CIRCULAR_BOKEH_DEFAULTS.sourceRadiusScale /
      SWEEP_REFERENCE_RADIUS_SCALE >=
    SWEEP_PRODUCT_RADIUS_RATIO_MIN
  )
) {
  throw new Error(
    `source radius ladder is not a strictly increasing sweep up to the product multiplier: ${JSON.stringify(
      {
        SWEEP_RADIUS_SCALES,
        product: CIRCULAR_BOKEH_DEFAULTS.sourceRadiusScale,
      },
    )}`,
  );
}

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
  // This tool's verdict is GPU evidence: its half-float readbacks and point-size cap
  // behaviour are only meaningful on a hardware renderer, so it requires Chrome
  // rather than accepting the shared `auto` fallback to bundled Chromium. It defaults
  // the choice instead of only rejecting the absence of it, because `npm run
  // shoot:bokeh` sets no environment and a gate that cannot be run by its own script
  // name is a gate nobody runs.
  process.env.CHEOMA_BROWSER ??= "chrome";
  if (process.env.CHEOMA_BROWSER !== "chrome") {
    throw new Error(
      `shoot:bokeh GPU evidence requires CHEOMA_BROWSER=chrome (received ${JSON.stringify(
        process.env.CHEOMA_BROWSER,
      )})`,
    );
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
    const canvas = window.__engine.renderer.domElement;
    canvas.dataset.bokehFixtureCanvas = "";
    for (const element of document.body.querySelectorAll("*")) {
      if (element === canvas || element.contains(canvas)) continue;
      element.style.setProperty("visibility", "hidden", "important");
    }
    // The first-frame guide mounts after readiness. Keep late UI out of every
    // canvas-clipped optical capture as well as the elements already present.
    const style = document.createElement("style");
    style.textContent = "[data-scene-guide]{display:none!important}";
    document.head.append(style);
  });
  const canvasLocator = page.locator("canvas[data-bokeh-fixture-canvas]");

  const threeModuleUrl =
    `/@fs${join(APP_ROOT, "node_modules/three/build/three.module.js")}`;
  const fixture = await installBokehOpticalChart(page, threeModuleUrl);

  const capture = async (name, amount) => {
    const state = await page.evaluate(({ value, apertureMeters }) => {
      const engine = window.__engine;
      // aperture is an aperture diameter in metres (src/env/dof.js /
      // bokeh-coc-contract.js). Pass the product default so the isolated chart
      // tracks residential focus retunes instead of a hard-coded legacy dial.
      engine.debugTuneDof({
        amount: value,
        aperture: apertureMeters,
        maxBlur: 0.01,
      });
      engine.debugRenderDofFrame();
      return engine.debugDof();
    }, { value: amount, apertureMeters: PRODUCT_APERTURE_METERS });
    const path = join(outputDir, `${name}.png`);
    await canvasLocator.screenshot({ path });
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
  // Live lens optics, read out of the running pass and cross-checked against
  // src/env/bokeh-coc-contract.js. Every expected radius and every image-space
  // crop below is derived from these numbers through the contract's pure
  // functions, so no optical constant is restated in this harness.
  const sweepSourceNames = ["foreground-open-pair", "foreground-over-focus"];
  const optics = await readBokehSweepOptics(
    page,
    fixture.projectedLights.map((light) => light.name),
  );
  const axialDepthByName = new Map(
    optics.sources.map((source) => [source.name, source.axialDepth]),
  );
  const productDiscRadiusPx = (name) =>
    bokehSourceDiscRadiusPx(
      optics,
      axialDepthByName.get(name),
      CIRCULAR_BOKEH_DEFAULTS.sourceRadiusScale,
    );
  for (const light of fixture.projectedLights) {
    const disc = productDiscRadiusPx(light.name);
    light.surfaceRadiusPx = bokehSurfaceDiscRadiusPx(
      optics,
      axialDepthByName.get(light.name),
    );
    light.discRadiusPx = disc;
    light.shapeRadius = Math.max(ROUNDNESS_RADIUS, Math.ceil(disc * 1.35));
    light.energyRadius = Math.max(ENERGY_RADIUS, Math.ceil(disc * 1.55));
    light.annulus = {
      inner: Math.max(SOURCE_ANNULUS_INNER, Math.round(disc * 0.72)),
      outer: Math.max(SOURCE_ANNULUS_OUTER, Math.round(disc * 0.98)),
    };
  }
  const lightAnnotations = new Map(
    fixture.projectedLights.map((light) => [
      light.name,
      {
        shapeRadius: light.shapeRadius,
        energyRadius: light.energyRadius,
        annulus: light.annulus,
        discRadiusPx: light.discRadiusPx,
        surfaceRadiusPx: light.surfaceRadiusPx,
      },
    ]),
  );
  const annotateLights = (lights) =>
    lights.map((light) => ({ ...light, ...lightAnnotations.get(light.name) }));
  const sweepSources = fixture.projectedLights.filter(({ name }) =>
    sweepSourceNames.includes(name),
  );
  const maxSweepDiscRadiusPx = Math.max(
    ...sweepSources.map((light) => light.discRadiusPx),
  );
  // The sweep's halo baseline is sampled out to 1.45x the expected radius, so the
  // crop must contain that band or the baseline is estimated from a truncated
  // annulus. This replaces the old `maxblur * radiusScale * viewportWidth * 0.866`
  // window, which under a physical aperture resolved to NaN and zeroed every
  // measurement.
  const PRODUCT_MEASUREMENT_RADIUS = Math.max(
    ENERGY_RADIUS,
    Math.ceil(maxSweepDiscRadiusPx * 1.5) + 2,
  );
  const STRIP_MEASUREMENT_RADIUS = Math.max(
    STRIP_RADIUS,
    Math.ceil(maxSweepDiscRadiusPx * 1.15),
  );
  const sweepSamples = sweepSources.map((light) => ({
    ...light,
    expected: SWEEP_RADIUS_SCALES.map((scale) =>
      bokehSourceDiscRadiusPx(optics, axialDepthByName.get(light.name), scale),
    ),
  }));
  // Same fixture, same ON−OFF difference, source scatter disabled: the difference
  // is then the surface gather's own disc at the pure physical CoC. Its radius must
  // ignore the whole multiplier ladder, which is what proves the enabled run above
  // measures the source path and nothing else.
  const surfaceSweepSamples = sweepSources.map((light) => ({
    ...light,
    expected: SWEEP_RADIUS_SCALES.map(() =>
      bokehSurfaceDiscRadiusPx(optics, axialDepthByName.get(light.name)),
    ),
  }));
  console.log(
    `sweep optics ${JSON.stringify({
      optics,
      PRODUCT_MEASUREMENT_RADIUS,
      STRIP_MEASUREMENT_RADIUS,
      maxSweepDiscRadiusPx,
    })}`,
  );
  const linearSweep = await measureLinearBokehSweep(page, {
    samples: sweepSamples,
    scales: SWEEP_RADIUS_SCALES,
    radiusPx: PRODUCT_MEASUREMENT_RADIUS,
  });
  const surfaceSweep = await measureLinearBokehSweep(page, {
    samples: surfaceSweepSamples,
    scales: SWEEP_RADIUS_SCALES,
    radiusPx: PRODUCT_MEASUREMENT_RADIUS,
    sourceScatter: false,
  });
  console.log(`linear-HDR sweep ${JSON.stringify(linearSweep)}`);
  console.log(`surface counterfactual sweep ${JSON.stringify(surfaceSweep)}`);
  const surfaceSupportRadius = new Map();
  for (const [name, samples] of Object.entries(surfaceSweep)) {
    const radii = samples.map((sample) => sample.supportRadius);
    const mean = radii.reduce((sum, value) => sum + value, 0) / radii.length;
    const invariance =
      (Math.max(...radii) - Math.min(...radii)) / Math.max(1e-9, mean);
    const ratios = samples.map((sample) => sample.supportRadiusRatio);
    surfaceSupportRadius.set(name, mean);
    if (
      !(
        samples.every((sample) => sample.integratedEnergy > 0) &&
        invariance <= SURFACE_RADIUS_INVARIANCE_MAX &&
        Math.min(...ratios) >= SURFACE_SUPPORT_RATIO_MIN &&
        Math.max(...ratios) <= SURFACE_SUPPORT_RATIO_MAX
      )
    ) {
      throw new Error(
        `surface counterfactual is not a bounded scale-invariant response for ${name}: ${JSON.stringify(
          { invariance, ratios, mean, samples },
        )}`,
      );
    }
  }
  for (const [name, samples] of Object.entries(linearSweep)) {
    const first = samples[0];
    const last = samples.at(-1);
    if (
      first.scale !== SWEEP_REFERENCE_RADIUS_SCALE ||
      last.scale !== CIRCULAR_BOKEH_DEFAULTS.sourceRadiusScale
    ) {
      throw new Error(
        `linear-HDR sweep missed reference/product radii for ${name}`,
      );
    }
    const surfaceRadius = bokehSurfaceDiscRadiusPx(
      optics,
      axialDepthByName.get(name),
    );
    const supportOffsets = samples.map(
      (sample) => sample.supportRadius - sample.expectedCoCRadius,
    );
    const supportOffsetRange =
      Math.max(...supportOffsets) - Math.min(...supportOffsets);
    const surfaceRadiusMeasured = surfaceSupportRadius.get(name);
    const overSurface = samples.map(
      (sample) => sample.supportRadius / Math.max(1e-9, surfaceRadiusMeasured),
    );
    if (
      Math.min(...supportOffsets) < SOURCE_SUPPORT_OFFSET_MIN_PX ||
      Math.max(...supportOffsets) > SOURCE_SUPPORT_OFFSET_MAX_PX ||
      supportOffsetRange > SOURCE_SUPPORT_OFFSET_RANGE_MAX_PX ||
      Math.min(...overSurface) < SOURCE_OVER_SURFACE_RADIUS_MIN
    ) {
      throw new Error(
        `measured source disc diverged from the contract radius for ${name}: ${JSON.stringify(
          {
            surfaceRadius,
            surfaceRadiusMeasured,
            supportOffsets,
            supportOffsetRange,
            overSurface,
            samples,
          },
        )}`,
      );
    }
    const radiusRatio =
      last.expectedCoCRadius / Math.max(1e-9, first.expectedCoCRadius);
    const peakRatio = last.peak / Math.max(1e-9, first.peak);
    const coreRatio =
      last.opticalCoreMean / Math.max(1e-9, first.opticalCoreMean);
    // The dilution the profile actually predicts, evaluated by the same pure
    // functions the shader's rawProfile/kernelNormalization are the GLSL twins of.
    // The interior comes out as pure 1/area, which is why coreRatio can be held to
    // a fraction of a percent; the peak does not, because `coverage` rolls off over
    // one absolute pixel and so occupies a smaller share of a larger disc. Writing
    // `1 / radiusRatio^2` here instead asserted self-similarity, which this profile
    // does not have: it read a correct 16% peak drift as a failure and would have
    // accepted a 12% error in the interior, the one place the law is exact.
    const predictedPeakRatio =
      bokehSourcePeakWeight(last.expectedCoCRadius) /
      Math.max(1e-9, bokehSourcePeakWeight(first.expectedCoCRadius));
    const predictedCoreRatio =
      bokehSourceAnnulusMeanWeight(
        last.expectedCoCRadius,
        SWEEP_CORE_BAND_MIN,
        SWEEP_CORE_BAND_MAX,
      ) /
      Math.max(
        1e-9,
        bokehSourceAnnulusMeanWeight(
          first.expectedCoCRadius,
          SWEEP_CORE_BAND_MIN,
          SWEEP_CORE_BAND_MAX,
        ),
      );
    if (
      radiusRatio < SWEEP_PRODUCT_RADIUS_RATIO_MIN ||
      Math.abs(peakRatio / predictedPeakRatio - 1) > SWEEP_PEAK_TOLERANCE ||
      Math.abs(coreRatio / predictedCoreRatio - 1) > SWEEP_CORE_TOLERANCE
    ) {
      throw new Error(
        `product bokeh did not grow and dilute by the aperture profile for ${name}: ${JSON.stringify(
          {
            reference: first,
            product: last,
            radiusRatio,
            peakRatio,
            predictedPeakRatio,
            coreRatio,
            predictedCoreRatio,
            areaDilution: 1 / (radiusRatio * radiusRatio),
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
  const repeat = await canvasLocator.screenshot();
  const repeatPath = join(outputDir, "bokeh-hdr-repeat.png");
  await writeFile(repeatPath, repeat);
  const offImage = await readFile(off);
  const staticFrameDifference = maxChannelDifference(
    repeat,
    await readFile(on),
  );
  const pixelStable = staticFrameDifference <= 1;
  if (!pixelStable)
    throw new Error(
      `static bokeh fixture changed by ${staticFrameDifference} channels (${repeatPath})`,
    );
  const programKeysBefore = await page.evaluate(() =>
    (window.__engine.renderer.info.programs || [])
      .map((program) => program.cacheKey)
      .sort(),
  );

  const overlapName = "foreground-over-focus";
  const captureWithoutSource = async (sourceName) => {
    await page.evaluate((name) => {
      const engine = window.__engine;
      engine.scene.getObjectByName(name).visible = false;
      engine.debugRenderDofFrame();
    }, sourceName);
    const baseline = await canvasLocator.screenshot();
    await page.evaluate((name) => {
      const engine = window.__engine;
      engine.scene.getObjectByName(name).visible = true;
      engine.debugRenderDofFrame();
    }, sourceName);
    return baseline;
  };
  const openSourceBaseline = await captureWithoutSource(
    "foreground-open-pair",
  );
  const cardSourceBaseline = await captureWithoutSource(overlapName);

  const onMetrics = measureLights(repeat, fixture.projectedLights);
  const offMetrics = measureLights(offImage, fixture.projectedLights);
  const roundnessSamples = onMetrics.filter(
    (sample) => sample.name !== overlapName,
  );
  const maxAspect = Math.max(...roundnessSamples.map((sample) => sample.aspect));
  const roundnessFailures = roundnessSamples.filter(
    (sample) => sample.aspect > roundnessLimitFor(sample.name),
  );
  if (roundnessFailures.length) {
    // Name the subjects. A roundness verdict that reports only the worst number gives
    // no way to tell an elliptical aperture from one source that adopted a neighbour's
    // depth, which is exactly the distinction this gate had to make once the scatter
    // started electing depth across ownership blocks.
    throw new Error(
      `bokeh aperture stretched past its optical-side limit: ${JSON.stringify(
        roundnessSamples
          .map((sample) => [
            sample.name,
            Number(sample.aspect.toFixed(3)),
            roundnessLimitFor(sample.name),
          ])
          .sort((a, b) => b[1] / b[2] - a[1] / a[2]),
      )}`,
    );
  }
  const lightByName = (name) =>
    fixture.projectedLights.find((light) => light.name === name);
  const openPair = measurePositiveDelta(
    repeat,
    openSourceBaseline,
    lightByName("foreground-open-pair"),
    PRODUCT_MEASUREMENT_RADIUS,
  );
  const cardPair = measurePositiveDelta(
    repeat,
    cardSourceBaseline,
    lightByName(overlapName),
    PRODUCT_MEASUREMENT_RADIUS,
  );
  const telephotoProfile = measureDiscProfile(
    repeat,
    lightByName("foreground-open-pair"),
    PRODUCT_MEASUREMENT_RADIUS,
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
    // Both of these are near sources (foreground-open-pair, foreground-over-focus).
    openPair.aspect <= FOREGROUND_ROUNDNESS_LIMIT &&
    cardPair.aspect <= FOREGROUND_ROUNDNESS_LIMIT &&
    openPair.angularVariation <= ANGULAR_UNIFORMITY_LIMIT &&
    cardPair.angularVariation <= ANGULAR_UNIFORMITY_LIMIT &&
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
  const counterfactualImage = await canvasLocator.screenshot();
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
  const restoredControlImage = await canvasLocator.screenshot();
  if (maxChannelDifference(repeat, restoredControlImage) > 1) {
    throw new Error(
      "source rejection counterfactual did not restore the byte-stable fixture",
    );
  }
  // Preserve a stable reference at the final pan pose. The moving sequence will
  // arrive at this exact camera again through the center-only path, then settle
  // back to the reference without changing the aperture center or radius.
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
  const stableFinalReference = await canvasLocator.screenshot();
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
    // Re-project per pose, but keep each light's contract-derived crop windows.
    frame.lights = annotateLights(frame.lights);
    const image = await canvasLocator.screenshot();
    await page.evaluate((sourceName) => {
      const engine = window.__engine;
      engine.scene.getObjectByName(sourceName).visible = false;
      engine.debugRenderDofFrame();
    }, overlapName);
    const dofBaselineAtPose = await canvasLocator.screenshot();
    await page.evaluate((sourceName) => {
      const engine = window.__engine;
      engine.scene.getObjectByName(sourceName).visible = true;
      engine.debugTuneDof({ amount: 0 });
      engine.debugRenderDofFrame();
    }, overlapName);
    const offImageAtPose = await canvasLocator.screenshot();
    await page.evaluate((sourceName) => {
      const engine = window.__engine;
      engine.scene.getObjectByName(sourceName).visible = false;
      engine.debugRenderDofFrame();
    }, overlapName);
    const sharpBaselineAtPose = await canvasLocator.screenshot();
    await page.evaluate((sourceName) => {
      const engine = window.__engine;
      engine.scene.getObjectByName(sourceName).visible = true;
      engine.debugTuneDof({ amount: 1 });
      engine.debugRenderDofFrame();
    }, overlapName);
    const renderedCard = measurePositiveDelta(
      image,
      dofBaselineAtPose,
      frame.lights.find((light) => light.name === overlapName),
      PRODUCT_MEASUREMENT_RADIUS,
    );
    const sharpInput = measurePositiveDelta(
      offImageAtPose,
      sharpBaselineAtPose,
      frame.lights.find((light) => light.name === overlapName),
      PRODUCT_MEASUREMENT_RADIUS,
    );
    panFrames.push({
      targetX,
      lights: frame.lights,
      state: frame.state,
      image,
      offImage: offImageAtPose,
      metrics: measureLights(image, frame.lights),
      sourceDelta: {
        renderedCard,
        sharpInput,
      },
    });
  }
  const repairedPanEnergy = panFrames.map(
    (frame) =>
      frame.sourceDelta.renderedCard.energy /
      Math.max(1, frame.sourceDelta.sharpInput.energy),
  );
  const repairedPanRms = panFrames.map(
    (frame) => frame.sourceDelta.renderedCard.rmsRadius,
  );
  const repairedPanRadiusRatio = repairedPanRms.map(
    (radius) => radius / cardPair.rmsRadius,
  );
  const repairedEnergyMean =
    repairedPanEnergy.reduce((sum, value) => sum + value, 0) /
    repairedPanEnergy.length;
  const repairedPanStability = {
    integratedEnergy: repairedPanEnergy,
    rmsRadius: repairedPanRms,
    radiusRatio: repairedPanRadiusRatio,
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
  const panCentroidError = (frame, name) => {
    const light = frame.lights.find((sample) => sample.name === name);
    const rendered = frame.metrics.find((sample) => sample.name === name);
    return Math.hypot(
      rendered.centroidX - light.x,
      rendered.centroidY - light.y,
    );
  };
  if (
    !panFrames.every(
      (frame) =>
        frame.state.postQuality === 0 &&
        // Adaptive quality no longer trades taps for motion: the gather's base
        // rings always run and bokehQuality only weights the fill ring, so the tap
        // budget is the same constant while moving and while settled
        // (docs/dof-cinematic-research.md 5.3). A regression to a motion-dependent
        // tap count would reintroduce the settling pop this round removed.
        frame.state.activeBokehTaps === BOKEH_GATHER_TAP_COUNT &&
        frame.metrics.find(
          (sample) => sample.name === "foreground-open-pair",
        ).aspect <= FOREGROUND_ROUNDNESS_LIMIT &&
        frame.sourceDelta.renderedCard.aspect <= FOREGROUND_ROUNDNESS_LIMIT &&
        frame.sourceDelta.renderedCard.angularVariation <=
          ANGULAR_UNIFORMITY_LIMIT &&
        panCentroidError(frame, "foreground-open-pair") <= 2 &&
        frame.sourceDelta.renderedCard.centroidError <= 2 &&
        frame.sourceDelta.renderedCard.energy > 0 &&
        frame.sourceDelta.renderedCard.energy /
          Math.max(1, frame.sourceDelta.sharpInput.energy) >=
          SOURCE_PAN_INPUT_ENERGY_MIN &&
        frame.sourceDelta.renderedCard.energy /
          Math.max(1, frame.sourceDelta.sharpInput.energy) <=
          SOURCE_PAN_INPUT_ENERGY_MAX &&
        frame.sourceDelta.renderedCard.rmsRadius / cardPair.rmsRadius >=
          SOURCE_PAN_RADIUS_RATIO_MIN &&
        frame.sourceDelta.renderedCard.rmsRadius / cardPair.rmsRadius <=
          SOURCE_PAN_RADIUS_RATIO_MAX,
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
      const image = await canvasLocator.screenshot();
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
  if (
    settledState.postQuality !== 1 ||
    settledState.activeBokehTaps !== BOKEH_GATHER_TAP_COUNT
  ) {
    throw new Error(
      `static camera did not restore the full-quality ${BOKEH_GATHER_TAP_COUNT}-tap gather: ${JSON.stringify(settledState)}`,
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
  const motionRoundnessFailures = motion.filter(
    (sample) => sample.maxAspect > roundnessLimitFor(sample.name),
  );
  if (motionRoundnessFailures.length) {
    throw new Error(
      `moving bokeh aperture stretched past its optical-side limit: ${JSON.stringify(
        motionRoundnessFailures.map((sample) => [
          sample.name,
          Number(sample.maxAspect.toFixed(3)),
          roundnessLimitFor(sample.name),
        ]),
      )}`,
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
      2,
      STRIP_MEASUREMENT_RADIUS,
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
  // At this point the shared depth pass, 53-tap half-resolution compact-source
  // classifier, and source scatter dominate the chart. The center-only branch
  // must not regress that fixed work; the exact 1/13 full-resolution fetch
  // budgets are asserted by check:dof and are more reliable than sub-ms ANGLE
  // timer direction.
  if (!(gpuTiming.ratio < 1.15 && gpuTiming.blockRatioMedian < 1.15)) {
    throw new Error(
      `center-only surface path regressed fixed DoF work: ${JSON.stringify(gpuTiming)}`,
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
    roundnessLimit: {
      background: BACKGROUND_ROUNDNESS_LIMIT,
      foreground: FOREGROUND_ROUNDNESS_LIMIT,
    },
    angularUniformityLimit: ANGULAR_UNIFORMITY_LIMIT,
    radiusScale: CIRCULAR_BOKEH_DEFAULTS.sourceRadiusScale,
    linearCropRadius: Math.ceil(maxSweepDiscRadiusPx * 1.25),
    enabled: scatterProofEnabled,
  });
  // The proof leaves its own multiplier in place. Restore the exported product
  // radius before stress and max-DPR measurements so their performance/resource
  // evidence describes the shipped profile.
  await page.evaluate((radiusScale) => {
    const pass = window.__engine.debugPostResources().bokehPass;
    pass.uniforms.bokehRadiusScale.value = radiusScale;
    window.__engine.debugRenderDofFrame();
  }, CIRCULAR_BOKEH_DEFAULTS.sourceRadiusScale);
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
  // ANGLE wall time is backend- and clock-dependent. Keep the paired ABBA
  // relative cap here; the pure contract owns the exact reduced fetch budget.
  if (
    maxDprGpu &&
    (!maxDprGpu.available ||
      maxDprGpu.disjoint ||
      maxDprGpu.pixelRatio !== 2 ||
      maxDprGpu.ratio > 2.5)
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
