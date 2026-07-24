// Real Hanyang FAR↔MID↔FULL screen-door review.
// Captures before/midpoint/after from the same camera ray for both adjacent boundaries.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from '../app/node_modules/vite/dist/node/index.js';
import { launchVerificationBrowser, reportWebGLRenderer } from './lib/verification-browser.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const APP_ROOT = join(ROOT, 'app');
const cacheDir = await mkdtemp(join(tmpdir(), 'cheoma-lod-transition-cache-'));
const outputDir = await mkdtemp(join(tmpdir(), 'cheoma-lod-transition-shots-'));
const timeout = Number(process.env.CHEOMA_LOD_SHOT_TIMEOUT_MS) || 240_000;
const errors = [];

const server = await createServer({
  root: APP_ROOT,
  configFile: join(APP_ROOT, 'vite.config.js'),
  cacheDir,
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false },
});

let browser;
try {
  await server.listen();
  const port = server.httpServer.address().port;
  browser = await launchVerificationBrowser();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(timeout);
  page.on('pageerror', (error) => errors.push(`page: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' && !/favicon|404/i.test(message.text())) {
      errors.push(`console: ${message.text()}`);
    }
  });

  const url = `http://127.0.0.1:${port}/?hero=0&village=1&worker=0&shot=1`
    + '&seed=42&vseed=20260716&vscale=hanyang&time=sunset&season=autumn&weather=clear';
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
  await page.waitForFunction(() => window.__SHOT_READY === true && !!window.__engine, null, { timeout });
  await page.waitForFunction(
    () => window.__engine?.village?.debugPlan?.()?.seed === 20260716,
    null,
    { timeout },
  );
  await page.waitForFunction(
    () => window.__engine?.renderer?.debug?.checkShaderErrors === false,
    null,
    { timeout },
  );
  await page.waitForFunction(
    () => window.__engine?.village?.debugCamera?.()?.transitioning === false
      && window.__engine?.debugDof?.()?.tweenProgress == null,
    null,
    { timeout },
  );
  await reportWebGLRenderer(page, 'lod-transition-shot');

  const prepared = await page.evaluate(async () => {
    const engine = window.__engine;
    const parcelId = 'p13';
    if (!engine.village.debugParcels().some((parcel) => parcel.parcelId === parcelId)) {
      throw new Error(`missing deterministic ${parcelId} LOD fixture`);
    }
    const finishTransition = async (label) => {
      for (let index = 0; index < 80; index++) {
        const sample = engine.debugDofSeek(1, { finish: true });
        if (sample) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`${label} camera did not start`);
    };
    engine.setViewShiftEnabled(false);
    engine.village.focus(parcelId);
    await finishTransition('focus');
    const direction = engine.camera.position.clone().sub(engine.__controls.target).normalize().toArray();
    const target = engine.__controls.target.toArray();
    engine.village.return();
    await finishTransition('return');
    engine.setSeason('autumn', { immediate: true });
    engine.setTime('sunset', { immediate: true });
    engine.setWeather('clear');
    engine.debugAdvancePost(2);
    engine.debugSetPaused(true);
    engine.debugRenderDofFrame();
    const edgeMist = engine.village.exportRoot().getObjectByName('edge-mist-ring');
    if (!edgeMist) throw new Error('edge mist ring is unavailable');
    window.__lodShotProgramKeys = new Set(
      (engine.renderer.info.programs || []).map((program) => program.cacheKey),
    );
    return {
      parcelId, direction, target,
      edgeMist: {
        geometry: edgeMist.geometry.uuid,
        material: edgeMist.material.uuid,
        map: edgeMist.material.map?.uuid,
      },
    };
  });

  await page.addStyleTag({ content: `
    body > :not(canvas), #app > :not(canvas) { visibility: hidden !important; }
    canvas { visibility: visible !important; }
  ` });

  async function capture(name, boundary, phase, saveScreenshot = true) {
    const state = await page.evaluate(({ prepared, boundary, phase }) => {
      const engine = window.__engine;
      const root = engine.village.exportRoot();
      const parcelState = engine.village.debugLod(prepared.parcelId);
      const chunk = root.children.find((child) => child.userData?.lod?.chunkId === parcelState?.chunkId
        && typeof child.userData?.lodUpdate === 'function');
      const lod = chunk?.userData?.lod;
      if (!chunk || !lod) throw new Error('target LOD chunk is unavailable');
      const target = prepared.target;
      const direction = prepared.direction;
      const threshold = boundary === 'far-mid' ? lod.midIn : lod.fullIn;
      const desired = phase === 'before' ? threshold + 1
        : phase === 'half' ? threshold - lod.transitionWidth * 0.5
          : threshold - lod.transitionWidth - 1;

      const cameraAt = (radius) => ({ position: {
        x: target[0] + direction[0] * radius,
        y: target[1] + direction[1] * radius,
        z: target[2] + direction[2] * radius,
      } });
      // 청크가 실제로 쓰는 가장 가까운 대지 3D 거리를 feedback으로 풀어, pick proxy 중심과
      // baseY 차이가 있어도 midpoint를 정확히 잡는다. 탐색 중 바뀐 tier는 아래에서 명시 복원한다.
      const radiusFor = (distance) => {
        let low = 0, high = 700;
        for (let index = 0; index < 36; index++) {
          const mid = (low + high) * 0.5;
          chunk.userData.lodUpdate(cameraAt(mid), 1);
          if (lod.distance < distance) low = mid;
          else high = mid;
        }
        return (low + high) * 0.5;
      };
      const radius = radiusFor(desired);
      const midResetRadius = boundary === 'mid-full'
        ? radiusFor(lod.midIn - lod.transitionWidth - 2) : null;

      // 거리 탐색의 방문 순서가 결과에 영향을 주지 않도록 각 shot의 출발 tier를 고정한다.
      for (let index = 0; index < 3; index++) chunk.userData.lodUpdate(cameraAt(700), 1);
      if (midResetRadius != null) chunk.userData.lodUpdate(cameraAt(midResetRadius), 1);
      engine.camera.fov = 46;
      engine.camera.userData.villageReferenceFov = 46;
      engine.camera.position.set(
        target[0] + direction[0] * radius,
        target[1] + direction[1] * radius,
        target[2] + direction[2] * radius,
      );
      engine.camera.updateProjectionMatrix();
      engine.__controls.target.fromArray(target);
      engine.__controls.maxDistance = 800;
      engine.camera.lookAt(engine.__controls.target);
      engine.camera.updateMatrixWorld(true);

      root.userData.updateChunkLod(engine.camera, 1);
      engine.debugRenderDofFrame();
      const actual = engine.village.debugLod(prepared.parcelId);
      const edgeMist = root.getObjectByName('edge-mist-ring');
      const programKeys = (engine.renderer.info.programs || []).map((program) => program.cacheKey);
      const addedPrograms = programKeys.filter((key) => !window.__lodShotProgramKeys.has(key));
      window.__lodShotProgramKeys = new Set(programKeys);
      return {
        boundary, phase, desired, actual,
        camera: { position: engine.camera.position.toArray(), target, fov: engine.camera.fov },
        edgeMist: edgeMist ? {
          opacity: edgeMist.material.opacity,
          viewWeight: edgeMist.userData.viewWeight,
          identityStable: edgeMist.geometry.uuid === prepared.edgeMist.geometry
            && edgeMist.material.uuid === prepared.edgeMist.material
            && edgeMist.material.map?.uuid === prepared.edgeMist.map,
        } : null,
        calls: engine.village.debugDrawCalls(),
        triangles: engine.renderer.info.render.triangles,
        programs: programKeys.length,
        addedPrograms,
      };
    }, { prepared, boundary, phase });
    if (saveScreenshot) {
      await page.locator('canvas').screenshot({ path: join(outputDir, `${name}.png`) });
    }
    return state;
  }

  // Warm the exact six camera/tier combinations once, then review a second pass. Program
  // plateau on that second pass isolates LOD churn from first-sight environment variants.
  for (const boundary of ['far-mid', 'mid-full']) {
    for (const phase of ['before', 'half', 'after']) {
      await capture('', boundary, phase, false);
    }
  }
  const captures = [];
  for (const [boundary, prefix] of [['far-mid', 'far-mid'], ['mid-full', 'mid-full']]) {
    captures.push(await capture(`${prefix}-before`, boundary, 'before'));
    captures.push(await capture(`${prefix}-half`, boundary, 'half'));
    captures.push(await capture(`${prefix}-after`, boundary, 'after'));
  }
  await capture('', 'mid-full', 'half', false);
  const edgeMistView = await page.evaluate((prepared) => {
    const engine = window.__engine;
    const ring = engine.village.exportRoot().getObjectByName('edge-mist-ring');
    const programsBefore = engine.renderer.info.programs?.length || 0;
    const dx = engine.__controls.target.x - engine.camera.position.x;
    const dz = engine.__controls.target.z - engine.camera.position.z;
    engine.camera.lookAt(
      engine.camera.position.x + dx,
      engine.camera.position.y,
      engine.camera.position.z + dz,
    );
    engine.camera.updateMatrixWorld(true);
    engine.debugRenderDofFrame();
    const horizon = { opacity: ring.material.opacity, viewWeight: ring.userData.viewWeight };
    engine.camera.lookAt(engine.__controls.target);
    engine.camera.updateMatrixWorld(true);
    engine.debugRenderDofFrame();
    return {
      horizon,
      restored: { opacity: ring.material.opacity, viewWeight: ring.userData.viewWeight },
      identityStable: ring.geometry.uuid === prepared.edgeMist.geometry
        && ring.material.uuid === prepared.edgeMist.material
        && ring.material.map?.uuid === prepared.edgeMist.map,
      programDelta: (engine.renderer.info.programs?.length || 0) - programsBefore,
    };
  }, prepared);
  const passParity = await page.evaluate(() => {
    const engine = window.__engine;
    const channelSymbol = Symbol.for('cheoma.lodScreenDoorChannel');
    const renderables = [];
    engine.scene.traverseVisible((object) => {
      if (!object.isMesh || !object[channelSymbol]
        || object.material?.depthWrite === false || object.userData?.dofDepth === false) return;
      renderables.push({
        object,
        material: Array.isArray(object.material)
          ? object.material.map((material) => material?.uuid).join('|')
          : object.material?.uuid,
      });
    });
    const restored = () => renderables.every(({ object, material }) => {
      const current = Array.isArray(object.material)
        ? object.material.map((entry) => entry?.uuid).join('|') : object.material?.uuid;
      return current === material && object.matrixWorld.elements[15] === 1;
    });

    engine.debugTuneDof({ amount: 1 });
    for (let i = 0; i < 30; i++) engine.debugAdvancePostQuality(1 / 60);
    engine.debugRenderDofFrame();
    const dof = engine.debugDof();
    const dofRestored = restored();
    const lodStableBefore = engine.village.debugLod('p13');
    const resourcesBefore = engine.debugPostResources();
    const fov = engine.camera.fov;
    engine.camera.fov = fov + 0.5;
    engine.camera.updateProjectionMatrix();
    engine.debugAdvancePostQuality(1 / 60);
    engine.camera.fov = fov;
    engine.camera.updateProjectionMatrix();
    engine.debugAdvancePostQuality(1 / 60);
    engine.debugRenderDofFrame();
    const movingDof = engine.debugDof();
    const lodMoving = engine.village.debugLod('p13');
    for (let i = 0; i < 30; i++) engine.debugAdvancePostQuality(1 / 60);
    engine.debugRenderDofFrame();
    const stableDof = engine.debugDof();
    const lodStableAfter = engine.village.debugLod('p13');
    const resourcesAfter = engine.debugPostResources();
    const adaptiveResourceKeys = [
      'depthTarget', 'depthTexture', 'bokehMaterial', 'instFadeDepthMaterial',
      'lodScreenDoorDepthMaterial', 'composerTarget1', 'composerTarget2',
    ];
    const comparableLod = (state) => ({
      level: state?.level,
      transition: state?.transition ? { ...state.transition } : null,
      weights: state?.weights ? { ...state.weights } : null,
      owners: state?.owners ? [...state.owners] : [],
    });
    const adaptiveQuality = {
      movingDof,
      stableDof,
      lodMoving: comparableLod(lodMoving),
      lodStableBefore: comparableLod(lodStableBefore),
      lodStableAfter: comparableLod(lodStableAfter),
      resourcesStable: adaptiveResourceKeys.every((key) => resourcesBefore[key] === resourcesAfter[key])
        && resourcesBefore.passCount === resourcesAfter.passCount,
    };

    engine.setRenderStyle('ink', { immediate: true });
    engine.debugRenderDofFrame();
    const ink = engine.debugInk();
    const inkRestored = restored();

    engine.setRenderStyle('pbr', { immediate: true });
    engine.debugTuneDof({ amount: 0 });
    engine.debugRenderDofFrame();
    return {
      visibleLodMeshes: renderables.length,
      dofDithered: dof.depthDithered,
      dofLodScreenDoor: dof.lodScreenDoorDepth,
      inkDithered: ink.normalDithered,
      inkLodScreenDoor: ink.lodScreenDoorNormal,
      dofRestored,
      inkRestored,
      adaptiveQuality,
    };
  });
  const report = {
    fixture: prepared.parcelId, viewport: '1440x900', captures, edgeMistView,
    passParity, errors, outputDir,
  };
  await writeFile(join(outputDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`LOD TRANSITION SHOTS: ${JSON.stringify(report, null, 2)}`);
  const captureStateValid = captures.every((capture) => {
    const [from, to] = capture.boundary === 'far-mid' ? ['far', 'mid'] : ['mid', 'full'];
    if (capture.phase === 'half') {
      return capture.actual?.transition?.active
        && capture.actual.transition.from === from && capture.actual.transition.to === to
        && capture.actual.transition.direction === -1
        && capture.actual.transition.progress > 0.45 && capture.actual.transition.progress < 0.55
        && capture.actual.owners?.length === 2
        && capture.actual.owners.includes(from) && capture.actual.owners.includes(to);
    }
    const expected = capture.phase === 'before' ? from : to;
    return capture.actual?.level === expected && !capture.actual?.transition?.active
      && capture.actual?.owners?.length === 1 && capture.actual.owners[0] === expected;
  });
  const transitionBudgetsValid = ['far-mid', 'mid-full'].every((boundary) => {
    const samples = captures.filter((capture) => capture.boundary === boundary);
    const midpoint = samples.find((capture) => capture.phase === 'half');
    const stable = samples.filter((capture) => capture.phase !== 'half');
    const stableCalls = Math.max(...stable.map((capture) => capture.calls));
    const stableTriangles = Math.max(...stable.map((capture) => capture.triangles));
    return midpoint.calls <= stableCalls * 1.35 + 10
      && midpoint.triangles <= stableTriangles * 1.20;
  });
  const adaptive = passParity.adaptiveQuality;
  const adaptiveLodParity = JSON.stringify(adaptive.lodStableBefore) === JSON.stringify(adaptive.lodMoving)
    && JSON.stringify(adaptive.lodMoving) === JSON.stringify(adaptive.lodStableAfter);
  if (errors.length || captures.some((capture) => (
    !capture.actual?.valid || capture.addedPrograms.length > 0
      || !capture.edgeMist?.identityStable
      || Math.abs(capture.edgeMist.opacity) > 1e-6
      || Math.abs(capture.edgeMist.viewWeight) > 1e-6
  )) || !captureStateValid || !transitionBudgetsValid || passParity.visibleLodMeshes <= 0
    || !edgeMistView.identityStable || edgeMistView.programDelta !== 0
    || Math.abs(edgeMistView.horizon.opacity - 0.5) > 1e-6
    || Math.abs(edgeMistView.horizon.viewWeight - 1) > 1e-6
    || Math.abs(edgeMistView.restored.opacity) > 1e-6
    || Math.abs(edgeMistView.restored.viewWeight) > 1e-6
    || passParity.dofLodScreenDoor !== passParity.visibleLodMeshes
    || passParity.inkLodScreenDoor !== passParity.visibleLodMeshes
    || adaptive.movingDof.postQuality !== 0 || adaptive.movingDof.activeBokehTaps !== 1
    || adaptive.stableDof.postQuality !== 1 || adaptive.stableDof.activeBokehTaps !== 13
    || adaptive.movingDof.lodScreenDoorDepth !== adaptive.stableDof.lodScreenDoorDepth
    || !adaptive.resourcesStable || !adaptiveLodParity
    || !passParity.dofRestored || !passParity.inkRestored) process.exitCode = 1;
} finally {
  await browser?.close();
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
}
