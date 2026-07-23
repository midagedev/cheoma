// Focused full-app DoF gate. Camera transitions are sampled through the product's
// real tween applicator; only one settled frame pays for the full Bokeh depth pass.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from '../app/node_modules/vite/dist/node/index.js';
import { launchVerificationBrowser, reportWebGLRenderer } from './lib/verification-browser.mjs';
import { VILLAGE_LENS, dollyScaleForFov } from '../src/camera/optics.js';

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
    const cameraAxisDepth = (point) => {
      if (!Array.isArray(point) || point.length !== 3 || !point.every(Number.isFinite)) return null;
      engine.camera.updateMatrixWorld(true);
      const e = engine.camera.matrixWorldInverse.elements;
      return -(e[2] * point[0] + e[6] * point[1] + e[10] * point[2] + e[14]);
    };
    const doorFocusSnapshot = (parcelId) => {
      const dof = snapshot();
      const door = engine.village.debugDoorFrame(parcelId);
      const leaf = engine.village.debugDoorInteraction(parcelId);
      const anchor = dof.anchorWorld;
      const center = door?.center;
      const delta = Array.isArray(anchor) && Array.isArray(center)
        ? anchor.map((value, index) => value - center[index])
        : null;
      const outward = door?.outward;
      return {
        dof,
        door,
        leafWidth: leaf?.leafWidth ?? null,
        doorDepth: cameraAxisDepth(center),
        anchorDepthFromMatrix: cameraAxisDepth(anchor),
        worldOffset: delta ? Math.hypot(...delta) : null,
        verticalOffset: delta ? Math.abs(delta[1]) : null,
        portalPlaneOffset: delta && Array.isArray(outward)
          ? Math.abs(delta[0] * outward[0] + delta[1] * outward[1] + delta[2] * outward[2])
          : null,
      };
    };
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
    const focusOuterDoor = doorFocusSnapshot('p32');

    // Refresh the product LOD at the settled telephoto camera, then assert that weather
    // consumes that exact lens scale instead of re-inferring it from a roof-height target.
    engine.debugAdvanceFocusRing(0);
    const focusedOptics = engine.debugSyncCameraEnvironment();
    const focusedSnow = engine.scene.getObjectByName('weatherSnow');
    const focusedWeatherLensScale = focusedSnow?.material?.uniforms?.uLensScale?.value ?? null;

    // Warm the stable program once, then render the exact same final camera pose
    // through moving 13-tap and restored 41-tap quality. Uniform changes must not
    // create or resize any post/depth resource or disturb the depth filter.
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
    const initialRecovery = [];
    for (let i = 0; i < 30; i++) initialRecovery.push(engine.debugAdvancePostQuality(1 / 60));
    const beforeDepthFrame = {
      dof: snapshot(), visibleCount: visibleSentinels.length,
      materialCount: materialSentinels.length,
      fadedTreesKeepRim: materialSentinels.every(([, material]) => (
        (Array.isArray(material) ? material : [material])
          .filter(Boolean).every((part) => part.userData?.__rimPatched)
      )),
    };
    engine.debugRenderDofFrame();
    const stableWarm = snapshot();
    const resourcesBefore = engine.debugPostResources();
    const resolutionBefore = engine.debugPostResolution();
    const passOrderBefore = engine.debugPostPassOrder();
    const programCountBefore = engine.renderer.info.programs?.length ?? null;
    const programKeysBefore = (engine.renderer.info.programs || [])
      .map((program) => program.cacheKey).sort();
    const memoryBefore = { ...engine.renderer.info.memory };
    const materialVersionBefore = resourcesBefore.bokehMaterial.version;

    const finalFov = engine.camera.fov;
    engine.camera.fov = finalFov + 0.5;
    engine.camera.updateProjectionMatrix();
    engine.debugAdvancePostQuality(1 / 60);
    engine.camera.fov = finalFov;
    engine.camera.updateProjectionMatrix();
    const movingQuality = engine.debugAdvancePostQuality(1 / 60);
    engine.debugRenderDofFrame();
    const movingDepth = snapshot();

    const settleQuality = [];
    for (let i = 0; i < 30; i++) settleQuality.push(engine.debugAdvancePostQuality(1 / 60));
    engine.debugRenderDofFrame();
    const resourcesAfter = engine.debugPostResources();
    const resolutionAfter = engine.debugPostResolution();
    const passOrderAfter = engine.debugPostPassOrder();
    const stableQuality = snapshot();
    const resourceKeys = [
      'depthTarget',
      'depthTexture',
      'bokehMaterial',
      'instFadeDepthMaterial',
      'lodScreenDoorDepthMaterial',
      'composerTarget1',
      'composerTarget2',
    ];
    const afterDepthFrame = {
      dof: stableQuality,
      visibilityRestored: visibleSentinels.every((object) => object.visible),
      materialsRestored: materialSentinels.every(([object, material]) => object.material === material),
      overrideRestored: engine.scene.overrideMaterial === overrideBefore,
      backgroundRestored: engine.scene.background === backgroundBefore,
    };
    const postQuality = {
      initialRecovery: initialRecovery.map((sample) => sample.postQuality),
      moving: movingQuality,
      movingDepth,
      settle: settleQuality.map((sample) => sample.postQuality),
      stableWarm,
      stable: stableQuality,
      policyStable: {
        amount: stableWarm.amount,
        focus: stableWarm.focus,
        aperture: stableWarm.aperture,
      },
      policyMoving: {
        amount: movingDepth.amount,
        focus: movingDepth.focus,
        aperture: movingDepth.aperture,
      },
      resourcesStable: resourceKeys.every((key) => resourcesBefore[key] === resourcesAfter[key])
        && resourcesBefore.passCount === resourcesAfter.passCount
        && resourcesAfter.bokehMaterial.version === materialVersionBefore,
      resolutionStable: JSON.stringify(resolutionBefore) === JSON.stringify(resolutionAfter),
      passOrderStable: JSON.stringify(passOrderBefore) === JSON.stringify(passOrderAfter),
      programCountBefore,
      programCountAfter: engine.renderer.info.programs?.length ?? null,
      programKeysStable: JSON.stringify(programKeysBefore) === JSON.stringify(
        (engine.renderer.info.programs || []).map((program) => program.cacheKey).sort(),
      ),
      depthSizeStable: resourcesBefore.depthTarget.width === resourcesAfter.depthTarget.width
        && resourcesBefore.depthTarget.height === resourcesAfter.depthTarget.height,
      memoryBefore,
      memoryAfter: { ...engine.renderer.info.memory },
      depthParity: movingDepth.depthExcluded === stableQuality.depthExcluded
        && movingDepth.depthDithered === stableQuality.depthDithered
        && movingDepth.instFadeDepth === stableQuality.instFadeDepth
        && movingDepth.lodScreenDoorDepth === stableQuality.lodScreenDoorDepth,
    };
    const focusEnd = stableQuality;

    // A committed focused rebuild replaces the entire overlay. The semantic DoF
    // cache must be refreshed in the same event turn rather than retaining the
    // disposed anchor or waiting for a render-frame traversal.
    const rebuildBefore = doorFocusSnapshot('p32');
    const rebuildState = engine.village.debugParcelRebuild('p32');
    const previousDoorHeight = rebuildState?.params?.doorHeightK;
    const nextDoorHeight = previousDoorHeight < 1 ? 1.05 : 0.9;
    const rebuilt = !!engine.village.rebuild('p32', {
      building: { doorHeightK: nextDoorHeight },
    }, { refreshFlora: false });
    const rebuildAfter = doorFocusSnapshot('p32');

    // The public reroll path synchronously replaces the selected overlay before
    // its restrained camera arc begins. Lock that event boundary: the new fixed
    // portal must own DoF immediately, without a render frame or stale Object3D.
    const rerollBefore = doorFocusSnapshot('p32');
    const rerollStateBefore = engine.village.debugParcelRebuild('p32');
    const originalRandom = Math.random;
    try {
      Math.random = () => 0.3141592653589793;
      engine.village.rerollParcel();
    } finally {
      Math.random = originalRandom;
    }
    const rerollStateAfter = engine.village.debugParcelRebuild('p32');
    const rerollAfter = doorFocusSnapshot('p32');
    const rerollReveal = engine.debugArchitecturalReveal();

    await begin(() => engine.village.return());
    // return() first skips the assembly into its rest pose, then value-copies the
    // same semantic point into the departure path. This lets us compare against
    // the current portal without adding another Bokeh render.
    const rerollRestored = doorFocusSnapshot('p32');
    const returnOuter = seek();
    const returnEnd = snapshot();

    morph = 0;
    await begin(() => engine.village.focus('p27'));
    const focusHopStart = seek();
    const focusHopFrom = snapshot();
    const focusHopFromDoor = doorFocusSnapshot('p27');
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
      focusOuterDoor,
      focusedOptics,
      focusedWeatherLensScale,
      postQuality,
      depthFrame: { before: beforeDepthFrame, after: afterDepthFrame },
      rebuild: {
        rebuilt,
        previousDoorHeight,
        nextDoorHeight,
        before: rebuildBefore,
        after: rebuildAfter,
      },
      reroll: {
        before: rerollBefore,
        after: rerollAfter,
        restored: rerollRestored,
        seedBefore: rerollStateBefore?.rebuildSeed ?? null,
        seedAfter: rerollStateAfter?.rebuildSeed ?? null,
        revealKind: rerollReveal?.kind ?? null,
      },
      returnOuter,
      returnEnd,
      focusHopStart,
      focusHopFrom,
      focusHopFromDoor,
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
  const finiteAnchor = (sample) => Array.isArray(sample?.anchorWorld)
    && sample.anchorWorld.length === 3
    && sample.anchorWorld.every(Number.isFinite);
  const vectorDistance = (a, b) => (
    Array.isArray(a) && Array.isArray(b) && a.length === 3 && b.length === 3
      ? Math.hypot(...a.map((value, index) => value - b[index]))
      : Infinity
  );
  const primaryDoorAligned = (sample, sources = ['primary-opening']) => {
    const { dof, leafWidth } = sample;
    return sources.includes(dof.anchorSource)
      && finiteAnchor(dof)
      && Number.isFinite(sample.doorDepth)
      && Number.isFinite(sample.anchorDepthFromMatrix)
      && Math.abs(dof.anchorDepth - sample.anchorDepthFromMatrix) < 1e-5
      && Math.abs(dof.anchorDepth - sample.doorDepth) < 0.08
      && sample.verticalOffset < 0.01
      && sample.portalPlaneOffset < 0.01
      // The semantic point is the whole fixed portal center. debugDoorFrame is
      // the active outer-leaf center, so multi-leaf doors may differ laterally.
      && sample.worldOffset < Math.max(0.05, (leafWidth || 0) * 2 + 0.02);
  };

  pass(result.aerial.enabled === false && result.aerial.amount === 0 && result.aerial.aperture === 0,
    'aerial mode owns a zero-cost, zero-residue DoF state');
  pass(result.returnEnd.fov === 46
      && result.focusEnd.fov === 10
      && monotonic(result.focusOuter.map((sample) => sample.fov), -1)
      && monotonic(result.returnOuter.map((sample) => sample.fov), 1)
      && result.focusedOptics.lensScale > 2
      && Math.abs(result.focusedOptics.lensScale - dollyScaleForFov(
        VILLAGE_LENS.parcel.referenceFov, VILLAGE_LENS.parcel.fov,
      )) < 1e-6,
  'lens continuum moves monotonically from wide aerial to compensated telephoto house framing');
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
  pass(result.postQuality.moving.postQuality === 0
      && result.postQuality.moving.postQualityMode === 'moving'
      && result.postQuality.moving.bokehSamples === 13
      && result.postQuality.moving.activeBokehTaps === 13
      && result.postQuality.stable.postQuality === 1
      && result.postQuality.stable.postQualityMode === 'stable'
      && result.postQuality.stable.bokehSamples === 41
      && result.postQuality.stable.activeBokehTaps === 41,
  'final camera motion uses 13 taps and restores the exact 41-tap stable kernel');
  pass(monotonic(result.postQuality.settle, 1)
      && result.postQuality.settle.every((quality) => quality >= 0 && quality <= 1),
  'post quality hold and settling recovery are monotonic without overshoot');
  pass(result.postQuality.policyMoving.amount === result.postQuality.policyStable.amount
      && Math.abs(result.postQuality.policyMoving.focus - result.postQuality.policyStable.focus) < 1e-9
      && Math.abs(result.postQuality.policyMoving.aperture - result.postQuality.policyStable.aperture) < 1e-12,
  'adaptive quality leaves DoF amount, focus, and aperture unchanged');
  pass(result.postQuality.resourcesStable
      && result.postQuality.resolutionStable
      && result.postQuality.passOrderStable
      && result.postQuality.programKeysStable
      && result.postQuality.depthSizeStable
      && result.postQuality.programCountAfter === result.postQuality.programCountBefore
      && result.postQuality.memoryAfter.textures === result.postQuality.memoryBefore.textures
      && result.postQuality.memoryAfter.geometries === result.postQuality.memoryBefore.geometries,
  '13/41 transitions preserve pass order, shader program, targets, materials, and GPU resource counts');
  pass(result.postQuality.depthParity,
    'moving and stable kernels share one unchanged opaque/deferred depth contract');

  pass(finite(result.focusOuter) && result.focusEnd.transitioning === false && result.focusEnd.selected === 'p32',
    'outer focus-in completes with finite DoF state');
  pass(result.focusOuter.every((sample) => (
    sample.anchorSource === 'primary-opening-transition' && finiteAnchor(sample)
  )),
  'focus-in interpolates a finite controls-target to primary-opening anchor path');
  pass(maxError(result.focusOuter) < 0.01,
    `outer focus-in tracks camera-axis depth (max error ${maxError(result.focusOuter).toFixed(5)}m)`);
  pass(monotonic(result.focusOuter.map((sample) => sample.amount), 1)
      && apertureInRange(result.focusOuter),
  'focus-in aperture rises monotonically without overshoot');
  pass(primaryDoorAligned(result.focusOuterDoor)
      && result.focusOuterDoor.dof.semanticParcel === 'p32',
  `settled focus owns p32's fixed primary-opening plane (depth delta ${Math.abs(
    result.focusOuterDoor.dof.anchorDepth - result.focusOuterDoor.doorDepth
  ).toFixed(5)}m)`);

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

  const rebuildAnchorMove = vectorDistance(
    result.rebuild.before.dof.anchorWorld,
    result.rebuild.after.dof.anchorWorld,
  );
  pass(result.rebuild.rebuilt
      && Number.isFinite(result.rebuild.previousDoorHeight)
      && result.rebuild.nextDoorHeight !== result.rebuild.previousDoorHeight
      && result.rebuild.after.dof.semanticParcel === 'p32'
      && result.rebuild.after.dof.semanticWrites > result.rebuild.before.dof.semanticWrites
      && rebuildAnchorMove > 1e-4
      && primaryDoorAligned(result.rebuild.after),
  `focused rebuild atomically refreshes the semantic anchor (${rebuildAnchorMove.toFixed(4)}m, writes ${
    result.rebuild.before.dof.semanticWrites}->${result.rebuild.after.dof.semanticWrites})`);

  pass(result.reroll.seedBefore !== result.reroll.seedAfter
      && result.reroll.revealKind === 'rebuild'
      && result.reroll.after.dof.semanticParcel === 'p32'
      && result.reroll.after.dof.semanticWrites === result.reroll.before.dof.semanticWrites + 1
      && result.reroll.after.dof.anchorSource === 'primary-opening'
      && finiteAnchor(result.reroll.after.dof)
      && primaryDoorAligned(result.reroll.restored, ['primary-opening-transition']),
  `focused reroll atomically replaces the semantic anchor (seed ${
    result.reroll.seedBefore}->${result.reroll.seedAfter}, writes ${
    result.reroll.before.dof.semanticWrites}->${result.reroll.after.dof.semanticWrites}, source ${
    result.reroll.after.dof.anchorSource}, reveal ${result.reroll.revealKind}, rest-plane ${
    result.reroll.restored.portalPlaneOffset})`);

  pass(maxError(result.returnOuter) < 0.01
      && monotonic(result.returnOuter.map((sample) => sample.amount), -1)
      && result.returnEnd.enabled === false && result.returnEnd.transitioning === false,
  'focus-out holds the departing house depth while DoF fades monotonically to off');
  pass(result.returnOuter.every((sample) => (
    sample.anchorSource === 'primary-opening-transition' && finiteAnchor(sample)
  ))
      && result.returnEnd.anchorSource === 'controls-target'
      && result.returnEnd.semanticParcel == null,
  'focus-out retains the departure portal through zero amount, then clears semantic ownership');

  pass(finite(result.focusHopStart) && finite(result.hop)
      && result.hopEnd.selected === 'p16' && result.hopEnd.transitioning === false,
  'long house hop completes with finite DoF state');
  pass(primaryDoorAligned(result.focusHopFromDoor)
      && result.focusHopFrom.anchorSource === 'primary-opening'
      && result.focusHopFrom.semanticParcel === 'p27',
  'settled p27 focus resolves its fixed primary-opening plane before the hop');
  pass(result.hop.every((sample) => (
    sample.anchorSource === 'primary-opening-transition' && finiteAnchor(sample)
  )),
  'house hop interpolates one finite primary-opening path instead of snapping target depth');
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
