// Focused full-app DoF gate. Camera transitions are sampled through the product's
// real tween applicator; only one settled frame pays for the full Bokeh depth pass.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from '../app/node_modules/vite/dist/node/index.js';
import { launchVerificationBrowser, reportWebGLRenderer } from './lib/verification-browser.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const APP_ROOT = join(ROOT, 'app');
const cacheDir = await mkdtemp(join(tmpdir(), 'cheoma-dof-app-'));
const timeout = Number(process.env.CHEOMA_DOF_APP_TIMEOUT_MS) || 180_000;
const failures = [];
const pass = (condition, message) => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${message}`);
  if (!condition) failures.push(message);
};

const server = await createServer({
  root: APP_ROOT,
  configFile: join(APP_ROOT, 'vite.config.js'),
  cacheDir,
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false },
});

let browser;
const runtimeErrors = [];
try {
  await server.listen();
  const port = server.httpServer.address().port;
  browser = await launchVerificationBrowser();
  // Keep desktop DoF enabled (>900px) while making the single real depth frame inexpensive.
  const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
  page.setDefaultTimeout(timeout);
  await page.addInitScript(() => { window.__noWarm = true; });
  page.on('pageerror', (error) => runtimeErrors.push(`page: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' && !/favicon|404/i.test(message.text())) {
      runtimeErrors.push(`console: ${message.text()}`);
    }
  });

  const url = `http://127.0.0.1:${port}/?hero=0&village=1&worker=0&shot=1`
    + '&seed=42&vseed=20260716&time=day';
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
  await page.waitForFunction(() => window.__SHOT_READY === true && !!window.__engine, null, { timeout });
  await page.waitForFunction(() => window.__engine?.village?.debugPlan?.()?.seed === 20260716, null, { timeout });
  await reportWebGLRenderer(page, 'dof-app');

  const result = await page.evaluate(async () => {
    const engine = window.__engine;
    engine.setViewShiftEnabled(false);
    let morph = 0;
    const offMorph = engine.on('villageFocusMorph', (value) => { morph = value; });
    const snapshot = () => ({
      ...engine.debugDof(),
      morph,
      selected: engine.village.getState().selected,
      transitioning: engine.village.getState().transitioning,
      continuum: engine.village.debugContinuum(),
      zoomMax: engine.__controls.maxDistance,
    });
    const begin = async (action) => {
      action();
      // __noWarm makes the reveal gate an already-resolved promise. Drain its microtasks
      // without yielding an animation frame, so the expensive post stack cannot race the seek.
      for (let i = 0; i < 4; i++) await Promise.resolve();
      if (engine.debugDof().tweenProgress == null) throw new Error('DoF transition did not start');
    };
    const seek = (points = [0, 0.25, 0.5, 0.75, 1]) => points.map((progress, index) => {
      const sample = engine.debugDofSeek(progress, { finish: index === points.length - 1 && progress === 1 });
      if (!sample) throw new Error(`DoF transition vanished at progress ${progress}`);
      return { ...sample, morph };
    });

    const fixtures = engine.village.debugParcels().map((parcel) => parcel.parcelId);
    const required = ['p32', 'p27', 'p16'];
    if (!required.every((id) => fixtures.includes(id))) {
      throw new Error(`missing deterministic DoF fixtures: ${required.filter((id) => !fixtures.includes(id)).join(', ')}`);
    }

    const aerial = snapshot();

    morph = 0;
    await begin(() => engine.village.focus('p32'));
    const focusOuter = seek();
    const focusEnd = snapshot();

    // Refresh the product LOD at the settled telephoto camera, then assert that weather
    // consumes that exact lens scale instead of re-inferring it from a roof-height target.
    engine.debugAdvanceFocusRing(0);
    const focusedOptics = engine.debugSyncCameraEnvironment();
    const focusedSnow = engine.scene.getObjectByName('weatherSnow');
    const focusedWeatherLensScale = focusedSnow?.material?.uniforms?.uLensScale?.value ?? null;

    // Exactly one real settled Bokeh render validates the depth filter and state restoration.
    const visibleSentinels = [];
    const materialSentinels = [];
    engine.scene.traverse((object) => {
      if (object.visible && (object.isPoints || object.isLine || object.isSprite
          || (object.isMesh && (Array.isArray(object.material) ? object.material : [object.material])
            .filter(Boolean).every((material) => material.depthWrite === false)))) {
        visibleSentinels.push(object);
      }
      if (object.visible && object.isMesh && object.geometry?.getAttribute?.('instFade')) {
        materialSentinels.push([object, object.material]);
      }
    });
    const overrideBefore = engine.scene.overrideMaterial;
    const backgroundBefore = engine.scene.background;
    const beforeDepthFrame = {
      dof: snapshot(), visibleCount: visibleSentinels.length,
      materialCount: materialSentinels.length,
      fadedTreesKeepRim: materialSentinels.every(([, material]) => (
        (Array.isArray(material) ? material : [material])
          .filter(Boolean).every((part) => part.userData?.__rimPatched)
      )),
    };
    engine.debugRenderDofFrame();
    const afterDepthFrame = {
      dof: snapshot(),
      visibilityRestored: visibleSentinels.every((object) => object.visible),
      materialsRestored: materialSentinels.every(([object, material]) => object.material === material),
      overrideRestored: engine.scene.overrideMaterial === overrideBefore,
      backgroundRestored: engine.scene.background === backgroundBefore,
    };

    await begin(() => engine.village.return());
    const returnOuter = seek();
    const returnEnd = snapshot();

    morph = 0;
    await begin(() => engine.village.focus('p27'));
    const focusHopStart = seek();
    await begin(() => engine.village.switchTo('p16'));
    const hop = seek(Array.from({ length: 17 }, (_, index) => index / 16));
    const hopEnd = snapshot();

    await begin(() => engine.village.return());
    const returnHop = seek();

    // Reverse focus-in at its midpoint. The replacement tween must inherit the current
    // amount instead of restoring or stranding an inflated aperture.
    morph = 0;
    await begin(() => engine.village.focus('p32'));
    const reverseIn = [engine.debugDofSeek(0), engine.debugDofSeek(0.5)];
    const reverseStartAmount = reverseIn.at(-1).amount;
    await begin(() => engine.village.return());
    const reverseOut = seek();
    const reverseEnd = snapshot();

    // Village ownership ends before its 1.2s return-to-house camera tween. Sample the
    // shared live-frame optics policy to prove weather and newly restored house motes
    // continue following the named lens instead of jumping to raw physical distance.
    await begin(() => engine.village.exit());
    const exitHouse = [0, 0.25, 0.5, 0.75, 0.999, 1].map((progress, index, points) => {
      const dof = engine.debugDofSeek(progress, {
        finish: index === points.length - 1,
      });
      const optics = engine.debugSyncCameraEnvironment();
      const motes = engine.scene.getObjectByName('dustMotes');
      return {
        ...dof,
        optics,
        hasReferenceFov: Object.hasOwn(engine.camera.userData, 'villageReferenceFov'),
        referenceFov: engine.camera.userData.villageReferenceFov ?? null,
        moteLensScale: motes?.material?.uniforms?.uLensScale?.value ?? null,
        villageActive: engine.village.getState().active,
      };
    });

    // A position-only house tween must not manufacture village lens metadata. Otherwise
    // the next village enter captures a subtly wrong house reference FOV.
    await begin(() => engine.select());
    const plainHouse = [0, 0.5, 1].map((progress, index, points) => {
      const dof = engine.debugDofSeek(progress, {
        finish: index === points.length - 1,
      });
      const optics = engine.debugSyncCameraEnvironment();
      return {
        ...dof,
        optics,
        hasReferenceFov: Object.hasOwn(engine.camera.userData, 'villageReferenceFov'),
      };
    });

    offMorph();
    return {
      aerial,
      fixtures: required,
      focusOuter,
      focusEnd,
      focusedOptics,
      focusedWeatherLensScale,
      depthFrame: { before: beforeDepthFrame, after: afterDepthFrame },
      returnOuter,
      returnEnd,
      focusHopStart,
      hop,
      hopEnd,
      returnHop,
      reverse: { in: reverseIn, out: reverseOut, startAmount: reverseStartAmount, end: reverseEnd },
      exitHouse,
      plainHouse,
    };
  });

  const active = (samples) => samples.filter((sample) => sample.amount > 1e-6);
  const maxError = (samples) => Math.max(0, ...active(samples).map((sample) => sample.error ?? Infinity));
  const apertureInRange = (samples) => samples.every((sample) => (
    sample.aperture >= -1e-12 && sample.aperture <= sample.baseAperture + 1e-12
  ));
  const monotonic = (values, direction) => values.every((value, index) => (
    index === 0 || (direction > 0 ? value >= values[index - 1] - 1e-6 : value <= values[index - 1] + 1e-6)
  ));
  const finite = (samples) => samples.every((sample) => (
    [sample.focus, sample.aperture, sample.baseAperture, sample.maxBlur, sample.anchorDepth,
      sample.fov, sample.highlightThreshold, sample.highlightGain, sample.bokehRadiusScale]
      .every(Number.isFinite)
  ));

  pass(result.aerial.enabled === false && result.aerial.amount === 0 && result.aerial.aperture === 0,
    'aerial mode owns a zero-cost, zero-residue DoF state');
  pass(result.returnEnd.fov === 46
      && result.focusEnd.fov === 20
      && monotonic(result.focusOuter.map((sample) => sample.fov), -1)
      && monotonic(result.returnOuter.map((sample) => sample.fov), 1),
  'lens continuum moves monotonically from wide aerial to telephoto house framing');
  pass(result.focusEnd.continuum.aerialReferenceDist > 0
      && result.focusEnd.continuum.focusMaxReferenceDist
        >= result.focusEnd.continuum.aerialReferenceDist
      && Math.abs(result.focusEnd.zoomMax
        - result.focusEnd.continuum.focusMaxActualDist) < 0.2,
  'telephoto house view can zoom out to village context without distance-owned focus-out');
  pass(Number.isFinite(result.focusedWeatherLensScale)
      && Math.abs(result.focusedWeatherLensScale - result.focusedOptics.lensScale) < 1e-9,
  'focused weather particles consume the shared village lens scale without target-height breathing');
  pass(result.focusEnd.bokehSamples === 41
      && result.focusEnd.highlightThreshold >= 0.48
      && result.focusEnd.highlightGain > 0,
  'one single-pass circular HDR kernel owns focused bokeh');

  pass(finite(result.focusOuter) && result.focusEnd.transitioning === false && result.focusEnd.selected === 'p32',
    'outer focus-in completes with finite DoF state');
  pass(maxError(result.focusOuter) < 0.01,
    `outer focus-in tracks camera-axis depth (max error ${maxError(result.focusOuter).toFixed(5)}m)`);
  pass(monotonic(result.focusOuter.map((sample) => sample.amount), 1)
      && apertureInRange(result.focusOuter),
  'focus-in aperture rises monotonically without overshoot');

  const depthJitter = Math.abs(result.depthFrame.after.dof.focus - result.depthFrame.before.dof.focus);
  pass(result.depthFrame.after.dof.depthExcluded > 0,
    `Bokeh depth excludes decorative/non-depth objects (${result.depthFrame.after.dof.depthExcluded})`);
  pass(result.depthFrame.before.visibleCount > 0 && result.depthFrame.after.visibilityRestored,
    `depth prepass restores all decorative visibility (${result.depthFrame.before.visibleCount} sentinels)`);
  pass(result.depthFrame.before.materialCount > 0
      && result.depthFrame.after.dof.depthDithered === result.depthFrame.before.materialCount
      && result.depthFrame.after.materialsRestored,
  `depth prepass preserves faded-tree holes and restores materials (${result.depthFrame.before.materialCount} sentinels)`);
  pass(result.depthFrame.before.fadedTreesKeepRim,
    'instFade tree materials retain the flagship Fresnel rim patch');
  pass(result.depthFrame.after.overrideRestored,
    'depth prepass restores the pre-existing scene override material');
  pass(result.depthFrame.after.backgroundRestored,
    'depth prepass restores the scene background after preserving far-depth sky');
  pass(depthJitter < 0.01 && result.depthFrame.after.dof.amount === 1,
    `settled focus does not breathe across a real Bokeh frame (${depthJitter.toFixed(6)}m)`);

  pass(maxError(result.returnOuter) < 0.01
      && monotonic(result.returnOuter.map((sample) => sample.amount), -1)
      && result.returnEnd.enabled === false && result.returnEnd.transitioning === false,
  'focus-out holds the departing house depth while DoF fades monotonically to off');

  pass(finite(result.focusHopStart) && finite(result.hop)
      && result.hopEnd.selected === 'p16' && result.hopEnd.transitioning === false,
  'long house hop completes with finite DoF state');
  pass(maxError(result.hop) < 0.01
      && result.hop.every((sample) => sample.enabled && Math.abs(sample.amount - 1) < 1e-9)
      && apertureInRange(result.hop),
  `long house hop follows the interpolated sightline without breathing (max error ${maxError(result.hop).toFixed(5)}m)`);
  pass(result.returnHop.at(-1).finished === true, 'hop fixture returns cleanly to aerial');

  pass(result.reverse.startAmount > 0 && result.reverse.startAmount < 1,
    `mid-focus reversal starts from its current amount (${result.reverse.startAmount.toFixed(3)})`);
  pass(apertureInRange(result.reverse.out)
      && monotonic(result.reverse.out.map((sample) => sample.amount), -1)
      && maxError(result.reverse.out) < 0.01
      && result.reverse.end.amount === 0 && result.reverse.end.enabled === false,
  'reversal remains monotonic and leaves no DoF residue');
  const opticalContinuity = result.exitHouse.every((sample) => {
    const { physicalDistance, visualDistance, lensScale } = sample.optics;
    return [physicalDistance, visualDistance, lensScale, sample.moteLensScale].every(Number.isFinite)
      && Math.abs(physicalDistance / visualDistance - lensScale) < 1e-6
      && Math.abs(sample.moteLensScale - lensScale) < 1e-6
      && sample.villageActive === false;
  });
  pass(opticalContinuity
      && result.exitHouse.at(-1).hasReferenceFov === false
      && Math.abs(result.exitHouse.at(-1).optics.lensScale - 1) < 1e-9,
  'village exit keeps weather and house motes lens-stable, then returns to identity optics');
  pass(result.plainHouse.every((sample) => !sample.hasReferenceFov
      && Math.abs(sample.optics.lensScale - 1) < 1e-9),
  'position-only house tweens do not leak village lens metadata');
  pass(runtimeErrors.length === 0, `browser reports no runtime errors (${runtimeErrors.length})`);
  if (runtimeErrors.length) console.log(runtimeErrors.slice(0, 10).join('\n'));

  await page.close();
} catch (error) {
  failures.push(error.message);
  console.error(error.stack || error);
  if (runtimeErrors.length) console.error(runtimeErrors.slice(0, 10).join('\n'));
} finally {
  await browser?.close();
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
}

console.log(failures.length ? `\nDOF APP: ${failures.length} FAIL` : '\nDOF APP: PASS');
process.exit(failures.length ? 1 : 0);
