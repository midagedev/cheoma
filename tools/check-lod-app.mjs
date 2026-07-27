// 실제 앱에서 필지 표현 소유권과 생활 디테일 LOD를 프레임 단위로 검증한다.
// full/focus는 Hanyang, 빠른 wave는 town→village를 사용하며 check:full이 전체 흐름을 보존한다.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from '../app/node_modules/vite/dist/node/index.js';
import {
  HANYANG_RENDER_BUDGET,
  RENDER_BUDGET_METRICS,
  RENDER_BUDGET_STATES,
  evaluateRenderBudget,
} from './lib/render-budget-contract.mjs';
import { BOKEH_GATHER_TAP_COUNT } from '../src/env/bokeh-coc-contract.js';
import { launchVerificationBrowser, reportWebGLRenderer } from './lib/verification-browser.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const APP_ROOT = join(ROOT, 'app');
const scenarioArg = process.argv.find((arg) => arg.startsWith('--scenario='));
const scenario = scenarioArg ? scenarioArg.slice('--scenario='.length) : 'full';
if (!['full', 'focus', 'wave'].includes(scenario)) {
  throw new Error(`LOD APP: unknown scenario "${scenario}" (expected full, focus, or wave)`);
}
const runFocusScenario = scenario !== 'wave';
const runWaveScenario = scenario !== 'focus';
const bootScale = runFocusScenario ? 'hanyang' : 'town';
const waveScale = scenario === 'wave' ? 'village' : 'town';
const cacheDir = await mkdtemp(join(tmpdir(), 'cheoma-lod-app-'));
// Bundled Chromium의 SwiftShader fallback에서는 3.6s engine wave가 wall-clock 수분이 될 수 있다.
const timeout = Number(process.env.CHEOMA_LOD_APP_TIMEOUT_MS) || 420_000;
const failures = [];

function pass(condition, message) {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${message}`);
  if (!condition) failures.push(message);
}

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
  const page = await browser.newPage({ viewport: { width: 960, height: 640 } });
  page.setDefaultTimeout(timeout);
  // Shader compilation is covered by the focused smoke gate. This contract exercises scene
  // ownership and LOD state, so compiling the full hidden Hanyang detail tree only adds
  // SwiftShader wall-clock variance without increasing coverage.
  await page.addInitScript(() => { window.__noWarm = true; });
  page.on('pageerror', (error) => runtimeErrors.push(`page: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' && !/favicon|404/i.test(message.text())) {
      runtimeErrors.push(`console: ${message.text()}`);
    }
  });

  const url = `http://127.0.0.1:${port}/?hero=0&village=1&worker=0&post=0`
    + `&seed=42&vseed=20260716&vscale=${bootScale}&time=day`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
  await page.waitForFunction(() => window.__SHOT_READY === true && !!window.__engine, null, { timeout });
  await page.waitForFunction(({ scale, seed }) => {
    const plan = window.__engine?.village?.debugPlan?.();
    return plan?.scale === scale && plan?.seed === seed;
  }, { scale: bootScale, seed: 20260716 }, { timeout });
  await reportWebGLRenderer(page, 'lod-app');
  await page.evaluate(() => new Promise((resolveFrame) => {
    requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)));
  }));
  // Plan readiness precedes the 1.4s house→aerial camera tween. Sample boot LOD only
  // after that real transition has settled; three rAFs alone is machine-speed dependent
  // and can catch a legitimate MID/ground-fauna handoff in progress.
  await page.waitForFunction(() => {
    const engine = window.__engine;
    const root = engine?.village?.exportRoot?.();
    const fauna = root?.userData?.faunaLod;
    return engine?.debugDof?.().tweenProgress == null
      && Math.abs((engine?.camera?.fov ?? 0) - 46) < 0.01
      && fauna?.tier === 'far'
      && fauna?.groundWeight <= 0.002;
  }, null, { timeout });

  const edgeMistContract = runFocusScenario ? await page.evaluate(async (moduleUrl) => {
    const { EDGE_MIST_AERIAL_FLOOR, edgeMistViewWeight } = await import(moduleUrl);
    const engine = window.__engine;
    const root = engine.village.exportRoot();
    const ring = root.getObjectByName('edge-mist-ring');
    const ridge = root.getObjectByName('ridge-mist');
    if (!ring || !ridge?.children?.length) return { available: false };
    window.__edgeMistTestRef = ring;
    window.__ridgeMistTestRef = ridge.children[0];
    const camera = engine.camera;
    const savedQuaternion = camera.quaternion.toArray();
    const savedCameraLayers = camera.layers.mask;
    const savedRingLayers = ring.layers.mask;
    const savedFrustumCulled = ring.frustumCulled;
    camera.layers.set(31);
    ring.layers.set(31);
    ring.frustumCulled = false;
    const identity = {
      geometry: ring.geometry.uuid,
      material: ring.material.uuid,
      map: ring.material.map?.uuid,
    };
    const renderAt = (degrees, azimuth) => {
      const horizontal = 100;
      camera.lookAt(
        camera.position.x + Math.cos(azimuth) * horizontal,
        camera.position.y - Math.tan(degrees * Math.PI / 180) * horizontal,
        camera.position.z + Math.sin(azimuth) * horizontal,
      );
      camera.updateMatrixWorld(true);
      engine.renderer.render(engine.scene, camera);
      const direction = camera.getWorldDirection(camera.position.clone());
      return {
        degrees,
        azimuth,
        opacity: ring.material.opacity,
        viewWeight: ring.userData.viewWeight,
        forwardY: direction.y,
        matrixForwardY: -camera.matrixWorld.elements[9],
        expectedWeight: edgeMistViewWeight(direction.y),
        calls: engine.renderer.info.render.calls,
      };
    };
    renderAt(0, 0);
    const resourceBefore = {
      programs: engine.renderer.info.programs?.length || 0,
      textures: engine.renderer.info.memory.textures,
    };
    const horizon = renderAt(0, 0);
    const partialX = renderAt(14, 0);
    const partialZ = renderAt(14, Math.PI * 0.5);
    const repeated = renderAt(14, Math.PI * 0.5);
    const aerial = renderAt(45, 0);
    const resourceAfter = {
      programs: engine.renderer.info.programs?.length || 0,
      textures: engine.renderer.info.memory.textures,
    };
    camera.quaternion.fromArray(savedQuaternion);
    camera.layers.mask = savedCameraLayers;
    ring.layers.mask = savedRingLayers;
    ring.frustumCulled = savedFrustumCulled;
    camera.updateMatrixWorld(true);
    return {
      available: true, identity, horizon, partialX, partialZ, repeated, aerial,
      aerialFloor: EDGE_MIST_AERIAL_FLOOR,
      restoredWeight: ring.userData.viewWeight,
      resourceBefore, resourceAfter,
      identityStable: ring.geometry.uuid === identity.geometry
        && ring.material.uuid === identity.material
        && ring.material.map?.uuid === identity.map,
    };
  }, `/@fs${join(ROOT, 'src/env/edge-mist-view.js')}`) : { available: false };
  // #211: authored ring opacity lives in populate (currently 0.58). Horizon weight is 1, so
  // that sample is the base; every other pitch must be base * viewWeight (non-compounding).
  const edgeMistBaseOpacity = edgeMistContract.horizon?.opacity;
  const validMistSample = (sample) => Number.isFinite(sample?.opacity)
    && Math.abs(sample.forwardY - sample.matrixForwardY) < 1e-7
    && Math.abs(sample.viewWeight - sample.expectedWeight) < 1e-7
    && Math.abs(sample.opacity - edgeMistBaseOpacity * sample.expectedWeight) < 1e-7;
  pass(!runFocusScenario || (edgeMistContract.available
      && edgeMistContract.identityStable
      && Number.isFinite(edgeMistBaseOpacity)
      && edgeMistBaseOpacity > 0.4 && edgeMistBaseOpacity < 0.75
      && validMistSample(edgeMistContract.horizon)
      && validMistSample(edgeMistContract.partialX)
      && validMistSample(edgeMistContract.partialZ)
      && validMistSample(edgeMistContract.repeated)
      && validMistSample(edgeMistContract.aerial)
      && edgeMistContract.horizon.viewWeight === 1
      && edgeMistContract.partialX.viewWeight > 0
      && edgeMistContract.partialX.viewWeight < 1
      && Math.abs(edgeMistContract.partialX.viewWeight - edgeMistContract.partialZ.viewWeight) < 1e-7
      && Math.abs(edgeMistContract.partialZ.viewWeight - edgeMistContract.repeated.viewWeight) < 1e-7
      && edgeMistContract.partialZ.calls === edgeMistContract.repeated.calls
      && edgeMistContract.aerialFloor > 0 && edgeMistContract.aerialFloor < 1
      && edgeMistContract.aerialFloor >= 0.8
      && edgeMistContract.aerial.viewWeight === edgeMistContract.aerialFloor
      && JSON.stringify(edgeMistContract.resourceBefore) === JSON.stringify(edgeMistContract.resourceAfter)),
  runFocusScenario
    ? `edge mist uses the real camera -Z axis, continuous non-compounding opacity, and stable resources `
      + `(${JSON.stringify(edgeMistContract)})`
    : 'town wave scenario omits the Hanyang edge-mist camera fixture');

  const boot = await page.evaluate((runLensContract) => {
    const engine = window.__engine;
    const lod = engine.village.debugLod();
    const regular = engine.village.debugParcels()
      .filter((parcel) => !parcel.hero && parcel.parcelId !== 'palace');
    const far = lod.parcels.filter((state) => state.far && state.level === 'far');
    const root = engine.village.exportRoot();
    const chunkStates = root.children
      .filter((child) => typeof child.userData?.lodUpdate === 'function')
      .map((child) => child.userData.lod);
    const chunkLensState = chunkStates
      .filter((state) => Number.isFinite(state?.physicalDistance))
      .sort((a, b) => b.physicalDistance - a.physicalDistance)[0] || null;
    let chunkLens = null;
    if (chunkLensState && runLensContract) {
      root.userData.updateChunkLod(engine.camera, 1);
      const reference = {
        level: chunkLensState.level,
        physicalDistance: chunkLensState.physicalDistance,
        distance: chunkLensState.distance,
      };
      const lensScale = 1.2;
      root.userData.updateChunkLod(engine.camera, lensScale);
      const compensated = {
        level: chunkLensState.level,
        physicalDistance: chunkLensState.physicalDistance,
        distance: chunkLensState.distance,
        detailReach: chunkLensState.detailReach,
      };
      // 시선 피치 종속 상세 깊이는 같은 키에 곱으로만 들어간다: 부감(reach 1)에서는 이전과
      // 완전히 동일한 키이고, 낮은 시선의 축소 깊이는 원경 청크를 밖으로 밀어낸다.
      const shallowReach = 0.56;
      root.userData.updateChunkLod(engine.camera, lensScale, shallowReach);
      const shallow = {
        level: chunkLensState.level,
        physicalDistance: chunkLensState.physicalDistance,
        distance: chunkLensState.distance,
        detailReach: chunkLensState.detailReach,
      };
      root.userData.updateChunkLod(engine.camera, lensScale);
      chunkLens = { lensScale, shallowReach, reference, compensated, shallow };
    }
    const fauna = root?.userData?.faunaLod;
    const ownerParcelIds = [...new Set(
      (fauna?.baseAnimals?.ownerParcelIds || []).filter((id) => typeof id === 'string'),
    )];
    // Base-yard flock owners are the strongest focus-handoff fixture. Prefer two of them so
    // A→B can prove that both retiring and arriving overlays reuse stable flock objects.
    const ownerStates = ownerParcelIds
      .map((id) => lod.parcels.find((state) => state.parcelId === id)).filter(Boolean);
    const first = ownerStates.find((state) => state.level === 'far' && state.auxiliaryPresent)
      || ownerStates.find((state) => state.auxiliaryPresent)
      || ownerStates.find((state) => state.level === 'far')
      || ownerStates[0] || far[0] || lod.parcels.find((state) => state.far) || lod.parcels[0];
    const auxiliaryFixture = lod.parcels.find((state) =>
      state.level === 'far' && state.auxiliaryPresent)
      || lod.parcels.find((state) => state.auxiliaryPresent);
    const second = ownerStates.find((state) => state.parcelId !== first?.parcelId
      && state.chunkId !== first?.chunkId)
      || ownerStates.find((state) => state.parcelId !== first?.parcelId)
      || lod.parcels.find((state) => state.parcelId !== first?.parcelId
      && state.chunkId !== first?.chunkId)
      || lod.parcels.find((state) => state.parcelId !== first?.parcelId);
    const birds = root?.getObjectByName?.('birds');
    const critters = root?.getObjectByName?.('village-critters');
    const groundMeshes = ['v-dogs', 'v-cats', 'v-magpies'].map((name) => {
      const object = root?.getObjectByName?.(name);
      return { name, exists: !!object, visible: object?.visible === true };
    });
    const ownerAnimals = {};
    for (const handle of (root?.userData?.animals?.handles || [])) {
      if (!handle.ownerParcelId) continue;
      const entry = ownerAnimals[handle.ownerParcelId] ||= { count: 0, uuids: [] };
      entry.count++;
      entry.uuids.push(handle.group?.uuid || null);
    }
    const auxiliaryRoot = root?.getObjectByName?.('village-auxiliaries') || null;
    const auxiliaryParcels = (root?.userData?.plan?.parcels || [])
      .filter((parcel) => parcel.auxiliary);
    return {
      plan: engine.village.debugPlan(),
      heroes: engine.village.debugParcels()
        .filter((parcel) => parcel.hero)
        .map((parcel) => parcel.parcelId),
      regularCount: regular.length,
      lodCount: lod.parcels.length,
      lodValid: lod.valid,
      lodFailures: lod.failures,
      counts: lod.counts,
      candidates: {
        first: first?.parcelId || null,
        second: second?.parcelId || null,
        ownerParcelIds,
        ownerAnimals,
      },
      fauna: fauna ? {
        tier: fauna.tier,
        groundWeight: fauna.groundWeight,
        baseActive: fauna.baseAnimals?.active,
        baseTotal: fauna.baseAnimals?.total,
        ownerParcelIds: [...(fauna.baseAnimals?.ownerParcelIds || [])],
        critterActive: { ...(fauna.critters?.active || {}) },
        critterGround: { ...(fauna.critters?.ground || {}) },
        birdScale: fauna.critters?.birdScale,
      } : null,
      birds: { exists: !!birds, visible: birds?.visible === true },
      crittersVisible: critters?.visible === true,
      groundMeshes,
      chunkLens,
      auxiliary: {
        planned: auxiliaryParcels.length,
        sourceIds: auxiliaryRoot?.userData?.srcIds?.size || 0,
        rootUuid: auxiliaryRoot?.uuid || null,
        visible: auxiliaryRoot?.visible === true,
        meshes: auxiliaryRoot?.children?.filter((child) => child.isMesh).length || 0,
        materials: new Set(
          auxiliaryRoot?.children?.filter((child) => child.isMesh)
            .map((child) => child.material?.uuid).filter(Boolean) || [],
        ).size,
        fixture: auxiliaryFixture?.parcelId || null,
      },
    };
  }, runFocusScenario);

  pass(boot.plan.scale === bootScale && boot.plan.seed === 20260716,
    `isolated worker=0 app boots deterministic ${bootScale}`);
  pass(boot.regularCount > 0 && boot.lodCount === boot.regularCount,
    `LOD snapshot covers every regular parcel (${boot.lodCount}/${boot.regularCount})`);
  pass(boot.lodValid && boot.lodFailures.length === 0,
    `aerial parcel representations are exclusive (${boot.lodFailures.join(', ') || 'no failures'})`);
  pass(boot.auxiliary.planned > 0
      && boot.auxiliary.sourceIds === boot.auxiliary.planned
      && boot.auxiliary.visible && !!boot.auxiliary.rootUuid
      && boot.auxiliary.meshes > 0 && boot.auxiliary.meshes <= 6
      && boot.auxiliary.materials === boot.auxiliary.meshes
      && !!boot.auxiliary.fixture,
  `one persistent material-batched auxiliary root covers every planned owner `
    + `(${JSON.stringify(boot.auxiliary)})`);
  const requiredCandidates = runFocusScenario
    ? [boot.candidates.first, boot.candidates.second]
    : [boot.candidates.first];
  pass(requiredCandidates.every(Boolean),
    `${scenario} scenario has the required regular parcel fixtures`);
  pass(requiredCandidates.every((id) => boot.candidates.ownerParcelIds.includes(id)),
    `${scenario} fixtures own base yard flocks (${requiredCandidates.join(', ')})`);
  pass(requiredCandidates.every((id) => {
    const owner = boot.candidates.ownerAnimals[id];
    return owner?.count === 1 && owner.uuids.length === 1 && !!owner.uuids[0];
  }), `${scenario} fixtures start with one stable base-flock object each`);

  const groundCrittersOff = boot.fauna
    && Object.values(boot.fauna.critterActive).every((active) => active === false)
    && Object.values(boot.fauna.critterGround).every((weight) => weight <= 0.002);
  pass(boot.fauna?.tier === 'far' && boot.fauna.groundWeight === 0
      && boot.fauna.baseActive === 0 && groundCrittersOff,
  `aerial LOD sleeps ground fauna (tier=${boot.fauna?.tier}, base=${boot.fauna?.baseActive})`);
  pass(boot.birds.exists && boot.birds.visible && boot.crittersVisible,
    `daytime aerial flock remains visible (scale=${boot.fauna?.birdScale})`);
  pass(boot.groundMeshes.filter((mesh) => mesh.exists).every((mesh) => !mesh.visible),
    'aerial dog, cat, and magpie meshes are actually hidden');
  if (runFocusScenario) {
    pass(boot.chunkLens
        && boot.chunkLens.reference.level === boot.chunkLens.compensated.level
        && Math.abs(boot.chunkLens.reference.distance
          - boot.chunkLens.reference.physicalDistance) < 1e-6
        && Math.abs(boot.chunkLens.compensated.physicalDistance
          - boot.chunkLens.reference.physicalDistance) < 1e-6
        && Math.abs(boot.chunkLens.compensated.distance * boot.chunkLens.lensScale
          - boot.chunkLens.compensated.physicalDistance) < 1e-6
        && boot.chunkLens.compensated.detailReach === 1
        && boot.chunkLens.shallow.detailReach === boot.chunkLens.shallowReach
        && boot.chunkLens.shallow.level === boot.chunkLens.reference.level
        && Math.abs(boot.chunkLens.shallow.distance
          * boot.chunkLens.lensScale * boot.chunkLens.shallowReach
          - boot.chunkLens.shallow.physicalDistance) < 1e-6
        && boot.chunkLens.shallow.distance > boot.chunkLens.compensated.distance,
    `attached ${bootScale} chunk LOD composes screen-equivalent lens distance with pitch-keyed `
      + `detail depth without changing its stable tier (${JSON.stringify(boot.chunkLens)})`);
  }

  // 표본은 프레임 수가 아니라 **자원 고원(plateau)** 에서 뜬다.
  //
  // 이 값들이 먹이는 델타 예산(aerial→focusOut)의 의미는 "focus 오버레이 잔여물"이고, 그 비교가
  // 성립하려면 두 끝점이 같은 정착 상태여야 한다. 종전에는 aerial 이 긴 부팅 시퀀스 뒤에,
  // focusOut 은 고정 3 프레임 뒤에 측정돼 정착 정도가 달랐다. 애니메이션 클록을 벽시계로 고치자
  // (app/src/engine/frame-clock.js) 그 비대칭이 드러났다 — 프레임당 진행이 실제 시간을 따르면서
  // aerial 기준선이 849→771 로 더 깊이 정착했고, focusOut 은 거의 그대로여서 델타만 71→130 으로
  // 벌어졌다. 오버레이는 양쪽 모두 이미 해제돼 있었고 절대 예산도 모두 통과했다 — 즉 자원 회귀가
  // 아니라 표본 시점의 비대칭이었다. 고원에서 뜨면 두 끝점이 같은 조건이 되어 델타가 다시
  // 잔여물만 뜻한다. dispose 계약들이 쓰는 것과 같은 관용구다.
  async function settleResources() {
    await page.evaluate(() => new Promise((resolveFrame) => {
      let stable = 0, previous = -1, frames = 0;
      const step = () => {
        const geometries = window.__engine.renderer.info.memory.geometries;
        stable = geometries === previous ? stable + 1 : 0;
        previous = geometries;
        // 연속 8 프레임 불변이면 정착. 상한 240 프레임은 저fps 환경에서도 무한 대기하지 않게.
        if (stable >= 8 || ++frames > 240) resolveFrame();
        else requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }));
  }

  async function sceneMetrics(label) {
    await settleResources();
    const samples = await page.evaluate(() => {
      const engine = window.__engine;
      const capture = () => ({
        calls: engine.renderer.info.render.calls,
        triangles: engine.renderer.info.render.triangles,
        programs: engine.renderer.info.programs?.length ?? 0,
        geometries: engine.renderer.info.memory.geometries,
        textures: engine.renderer.info.memory.textures,
      });
      engine.village.debugDrawCalls();
      return [capture(), capture()];
    });
    const metrics = samples[1];
    pass(Number.isFinite(metrics.calls) && metrics.calls > 0
        && Number.isFinite(metrics.triangles) && metrics.triangles > 0,
    `${label} scene-only renderer counters are finite`);
    return { ...metrics, samples };
  }

  const performance = {};
  performance.aerial = await sceneMetrics('aerial');

  const legacyOverload = await page.evaluate(async ({ housesModuleUrl, threeModuleUrl }) => {
    const [{ attachChunkLodSwap }, THREE] = await Promise.all([
      import(housesModuleUrl),
      import(threeModuleUrl),
    ]);
    const chunkGroup = new THREE.Group();
    chunkGroup.name = 'legacy-lod-contract';
    const far = new THREE.Group();
    const full = new THREE.Group();
    const chunk = { parcels: [{ id: 'legacy-p', center: { x: 0, z: 0 }, baseY: 0 }] };
    attachChunkLodSwap(chunkGroup, far, full, chunk, 100);
    const initial = { far: far.visible, full: full.visible, level: chunkGroup.userData.lod?.level };
    const nearChanged = chunkGroup.userData.lodUpdate({ position: { x: 10, y: 0, z: 0 } });
    const near = { far: far.visible, full: full.visible, level: chunkGroup.userData.lod?.level };
    const farChanged = chunkGroup.userData.lodUpdate({ position: { x: 60, y: 0, z: 0 } });
    const distant = { far: far.visible, full: full.visible, level: chunkGroup.userData.lod?.level };
    return {
      initial, near, distant, nearChanged, farChanged,
      midRoot: chunkGroup.userData.lod?.midRoot ?? null,
      thresholds: {
        swapIn: chunkGroup.userData.lod?.swapIn,
        swapOut: chunkGroup.userData.lod?.swapOut,
      },
    };
  }, {
    housesModuleUrl: `/@fs${join(ROOT, 'src/generators/village/houses.js')}`,
    threeModuleUrl: `/@fs${join(APP_ROOT, 'node_modules/three/build/three.module.js')}`,
  });
  pass(legacyOverload.initial.far && !legacyOverload.initial.full
      && !legacyOverload.near.far && legacyOverload.near.full
      && legacyOverload.distant.far && !legacyOverload.distant.full
      && legacyOverload.nearChanged && legacyOverload.farChanged
      && legacyOverload.midRoot === null
      && legacyOverload.thresholds.swapIn === 45
      && legacyOverload.thresholds.swapOut === 53,
  'legacy 5-argument attachChunkLodSwap preserves direct FAR↔FULL behavior');

  const screenDoorContract = await page.evaluate(async ({ dofModuleUrl, lodModuleUrl }) => {
    const { contributesDofDepth } = await import(dofModuleUrl);
    const { hasLodScreenDoor } = await import(lodModuleUrl);
    const engine = window.__engine;
    const root = engine.village.exportRoot();
    const chunk = root.children.find((child) => typeof child.userData?.lodUpdate === 'function'
      && child.userData.lod?.parcelIds?.size > 0);
    const state = chunk?.userData?.lod;
    const parcels = engine.village.debugParcels()
      .filter((parcel) => state?.parcelIds?.has(parcel.parcelId));
    const anchor = parcels.sort((a, b) => b.worldCenter[1] - a.worldCenter[1])[0];
    if (!chunk || !state || !anchor) return { available: false };

    const roots = { far: state.farRoot, mid: state.midRoot, full: state.fullRoot };
    const snapshotResources = () => {
      const geometries = new Set();
      const materials = new Set();
      for (const rootObject of Object.values(roots)) rootObject.traverse((object) => {
        if (object.geometry) geometries.add(object.geometry.uuid);
        const list = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of list) if (material?.uuid) materials.add(material.uuid);
        if (object.customDepthMaterial?.uuid) materials.add(object.customDepthMaterial.uuid);
        if (object.customDistanceMaterial?.uuid) materials.add(object.customDistanceMaterial.uuid);
      });
      return {
        geometries: [...geometries].sort(),
        materials: [...materials].sort(),
      };
    };
    const rendererMemory = () => ({
      geometries: engine.renderer.info.memory.geometries,
      textures: engine.renderer.info.memory.textures,
    });
    const inspectRoot = (rootObject) => {
      const values = new Set();
      let meshes = 0;
      let materialCount = 0;
      let lodPatched = 0;
      let transparent = 0;
      let depthWriteOff = 0;
      let missingShadowFade = 0;
      let missingDistanceFade = 0;
      let lodAttributes = 0;
      let unrestoredMatrices = 0;
      const channelSymbol = Symbol.for('cheoma.lodScreenDoorChannel');
      rootObject.traverse((object) => {
        if (!object.isMesh) return;
        meshes++;
        if (object.geometry?.getAttribute?.('instFade')) lodAttributes++;
        if (object[channelSymbol]) values.add(object[channelSymbol].value);
        if (object.matrixWorld.elements[15] !== 1) unrestoredMatrices++;
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) {
          if (!material) continue;
          materialCount++;
          const programKey = material.customProgramCacheKey?.() || '';
          if (material.userData?.__lodScreenDoorPatchVersion === 'cheoma-lod-screen-door-v1'
            && programKey.split('|').includes('cheoma-lod-screen-door-v1')) lodPatched++;
          if (material?.transparent) transparent++;
          if (material?.depthWrite === false) depthWriteOff++;
        }
        if (object.castShadow
          && !object.customDepthMaterial?.customProgramCacheKey?.().includes('lod-screen-door-v1')) {
          missingShadowFade++;
        }
        if (object.castShadow
          && !object.customDistanceMaterial?.customProgramCacheKey?.().includes('lod-screen-door-v1')) {
          missingDistanceFade++;
        }
      });
      return {
        meshes, materialCount, lodPatched, transparent, depthWriteOff,
        missingShadowFade, missingDistanceFade,
        lodAttributes, unrestoredMatrices, values: [...values],
      };
    };
    const cameraAt = (distance) => ({
      position: {
        x: anchor.worldCenter[0],
        y: anchor.worldCenter[1] + distance,
        z: anchor.worldCenter[2],
      },
    });
    const update = (distance) => chunk.userData.lodUpdate(cameraAt(distance), 1);
    const capture = () => ({
      level: state.level,
      transition: { ...state.transition },
      weights: { ...state.weights },
      channels: { ...state.channels },
      roots: Object.fromEntries(Object.entries(roots).map(([key, value]) => [key, value.visible])),
      renderables: Object.fromEntries(Object.entries(roots).map(([key, value]) => [key, inspectRoot(value)])),
    });
    const expectedLodScreenDoorDepth = () => {
      let count = 0;
      engine.scene.traverseVisible((object) => {
        if (object.isMesh
          && contributesDofDepth(object)
          && !object.geometry?.getAttribute?.('instFade')
          && hasLodScreenDoor(object)) count++;
      });
      return count;
    };

    update(state.midOut + state.transitionWidth + 2);
    const resourcesBefore = snapshotResources();
    const rendererMemoryBefore = rendererMemory();
    const farMidDistance = state.midIn - state.transitionWidth * 0.5;
    const changed = update(farMidDistance);
    engine.renderer.shadowMap.needsUpdate = true;
    engine.renderer.render(engine.scene, engine.camera);
    const farMid = capture();
    const resourcesAfterFarMid = snapshotResources();
    const repeated = update(farMidDistance);
    update(state.midIn - state.transitionWidth - 1);
    const settledMid = capture();
    const midFullDistance = state.fullIn - state.transitionWidth * 0.5;
    update(midFullDistance);
    engine.renderer.shadowMap.needsUpdate = true;
    engine.renderer.render(engine.scene, engine.camera);
    const midFull = capture();
    const resourcesAfterMidFull = snapshotResources();
    update(state.fullIn - state.transitionWidth - 1);
    const settledFull = capture();
    const resourcesAfter = snapshotResources();
    const rendererMemoryAfter = rendererMemory();
    // Return to the stable MID owner before entering the MID→FULL midpoint again.
    // Coming directly from settled FULL leaves hysteresis on FULL and only proves
    // post quality in a single-owner frame, not parity across the screen-door pair.
    update(state.midIn - state.transitionWidth - 1);
    update(midFullDistance);
    const savedCamera = {
      position: engine.camera.position.clone(),
      quaternion: engine.camera.quaternion.clone(),
      target: engine.__controls.target.clone(),
      fov: engine.camera.fov,
      amount: engine.debugDof().amount,
    };
    const midpointCamera = cameraAt(midFullDistance).position;
    engine.camera.position.set(midpointCamera.x, midpointCamera.y, midpointCamera.z);
    engine.__controls.target.set(anchor.worldCenter[0], anchor.worldCenter[1], anchor.worldCenter[2]);
    engine.camera.lookAt(engine.__controls.target);
    engine.camera.updateProjectionMatrix();
    engine.camera.updateMatrixWorld(true);
    engine.debugTuneDof({ amount: 1 });
    for (let index = 0; index < 30; index++) engine.debugAdvancePostQuality(1 / 60);
    engine.debugRenderDofFrame();
    const postResourcesBefore = engine.debugPostResources();
    const postProgramsBefore = (engine.renderer.info.programs || [])
      .map((program) => program.cacheKey).sort();
    const stableQualityBefore = engine.debugDof();
    const expectedDepthBefore = expectedLodScreenDoorDepth();
    const qualityLodBefore = capture();
    const midpointFov = engine.camera.fov;
    engine.camera.fov = midpointFov + 0.5;
    engine.camera.updateProjectionMatrix();
    engine.debugAdvancePostQuality(1 / 60);
    engine.camera.fov = midpointFov;
    engine.camera.updateProjectionMatrix();
    engine.debugAdvancePostQuality(1 / 60);
    engine.debugRenderDofFrame();
    const movingQuality = engine.debugDof();
    const expectedDepthMoving = expectedLodScreenDoorDepth();
    const qualityLodMoving = capture();
    for (let index = 0; index < 30; index++) engine.debugAdvancePostQuality(1 / 60);
    engine.debugRenderDofFrame();
    const stableQualityAfter = engine.debugDof();
    const expectedDepthAfter = expectedLodScreenDoorDepth();
    const qualityLodAfter = capture();
    const postResourcesAfter = engine.debugPostResources();
    const postProgramsAfter = (engine.renderer.info.programs || [])
      .map((program) => program.cacheKey).sort();
    const postResourceKeys = [
      'depthTarget', 'depthTexture', 'bokehMaterial', 'instFadeDepthMaterial',
      'lodScreenDoorDepthMaterial', 'composerTarget1', 'composerTarget2',
    ];
    const adaptiveQuality = {
      stableBefore: stableQualityBefore,
      moving: movingQuality,
      stableAfter: stableQualityAfter,
      expectedDepthBefore,
      expectedDepthMoving,
      expectedDepthAfter,
      lodBefore: qualityLodBefore,
      lodMoving: qualityLodMoving,
      lodAfter: qualityLodAfter,
      resourcesStable: postResourceKeys.every(
        (key) => postResourcesBefore[key] === postResourcesAfter[key],
      ) && postResourcesBefore.depthTarget.width === postResourcesAfter.depthTarget.width
        && postResourcesBefore.depthTarget.height === postResourcesAfter.depthTarget.height,
      programsStable: JSON.stringify(postProgramsBefore) === JSON.stringify(postProgramsAfter),
    };
    engine.camera.position.copy(savedCamera.position);
    engine.camera.quaternion.copy(savedCamera.quaternion);
    engine.__controls.target.copy(savedCamera.target);
    engine.camera.fov = savedCamera.fov;
    engine.camera.updateProjectionMatrix();
    engine.camera.updateMatrixWorld(true);
    engine.debugTuneDof({ amount: savedCamera.amount });
    // 다음 rAF 전에 원래 aerial FAR 상태로 복구한다. 큰 점프도 인접 MID를 한 번 거친다.
    update(state.midOut + state.transitionWidth + 2);
    update(state.midOut + state.transitionWidth + 2);
    return {
      available: true, changed, repeated, farMid, settledMid, midFull, settledFull,
      adaptiveQuality,
      resourcesStable: [resourcesAfterFarMid, resourcesAfterMidFull, resourcesAfter]
        .every((snapshot) => JSON.stringify(resourcesBefore) === JSON.stringify(snapshot)),
      rendererMemory: { before: rendererMemoryBefore, after: rendererMemoryAfter },
    };
  }, {
    dofModuleUrl: `/@fs${join(ROOT, 'src/env/dof.js')}`,
    lodModuleUrl: `/@fs${join(ROOT, 'src/render/lod-screen-door.js')}`,
  });
  const validTransition = (snapshot, from, to) => snapshot?.transition?.active
    && snapshot.transition.from === from && snapshot.transition.to === to
    && Object.values(snapshot.roots).filter(Boolean).length === 2
    && snapshot.roots[from] && snapshot.roots[to]
    && Math.abs(snapshot.weights[from] + snapshot.weights[to] - 1) < 1e-6
    && snapshot.channels[from] > 0 && snapshot.channels[to] < 0;
  const validChannels = (snapshot, from, to) => Object.entries(snapshot?.renderables || {})
    .every(([level, audit]) => audit.meshes > 0 && audit.materialCount > 0
      && audit.lodPatched === audit.materialCount
      && audit.transparent === 0 && audit.depthWriteOff === 0
      && audit.missingShadowFade === 0 && audit.missingDistanceFade === 0
      && audit.lodAttributes === 0 && audit.unrestoredMatrices === 0
      && audit.values.length === 1
      && (level === from ? audit.values[0] > 0
        : level === to ? audit.values[0] < 0 : audit.values[0] === 1));
  const screenDoorChannelsValid = screenDoorContract.available
      && screenDoorContract.changed && !screenDoorContract.repeated
      && validTransition(screenDoorContract.farMid, 'far', 'mid')
      && validTransition(screenDoorContract.midFull, 'mid', 'full')
      && validChannels(screenDoorContract.farMid, 'far', 'mid')
      && validChannels(screenDoorContract.midFull, 'mid', 'full');
  pass(!runFocusScenario || screenDoorChannelsValid,
    runFocusScenario
      ? `LOD screen-door uses complementary draw-local channels with idempotent distance updates `
        + `(${JSON.stringify(screenDoorContract)})`
      : 'town wave scenario correctly omits the Hanyang-only LOD screen-door contract');
  const screenDoorResourcesValid = screenDoorContract.resourcesStable
      && screenDoorContract.settledMid?.level === 'mid'
      && !screenDoorContract.settledMid?.transition?.active
      && screenDoorContract.settledFull?.level === 'full'
      && !screenDoorContract.settledFull?.transition?.active;
  pass(!runFocusScenario || screenDoorResourcesValid,
    runFocusScenario
      ? `LOD screen-door settles to one root without geometry/material allocation `
        + `(${JSON.stringify(screenDoorContract)})`
      : 'town wave scenario correctly omits Hanyang LOD transition resources');
  const adaptiveQuality = screenDoorContract.adaptiveQuality;
  const adaptiveMidpoint = adaptiveQuality?.lodBefore;
  const adaptiveMidpointDepthMeshes = adaptiveMidpoint
    ? Object.entries(adaptiveMidpoint.roots || {}).reduce(
      (count, [level, visible]) => count
        + (visible ? adaptiveMidpoint.renderables?.[level]?.meshes || 0 : 0),
      0,
    )
    : 0;
  const adaptiveMidpointValid = adaptiveMidpoint?.level === 'mid'
    && adaptiveMidpoint.transition?.active
    && adaptiveMidpoint.transition.from === 'mid'
    && adaptiveMidpoint.transition.to === 'full'
    && Math.abs(adaptiveMidpoint.transition.progress - 0.5) <= 0.05
    && adaptiveMidpoint.roots?.far === false
    && adaptiveMidpoint.roots?.mid === true
    && adaptiveMidpoint.roots?.full === true
    && adaptiveMidpoint.weights?.mid >= 0.45
    && adaptiveMidpoint.weights?.full >= 0.45;
  const adaptiveLodSnapshot = (snapshot) => JSON.stringify({
    level: snapshot?.level,
    transition: snapshot?.transition,
    weights: snapshot?.weights,
    roots: snapshot?.roots,
  });
  const adaptiveQualityValid = adaptiveQuality
    && adaptiveMidpointValid
    && adaptiveQuality.moving.postQuality === 0
    // Adaptive quality no longer buys motion smoothness with taps: the CoC gather's
    // base rings always run and bokehQuality only weights its fill ring, so the tap
    // budget is this one constant in both states
    // (docs/dof-cinematic-research.md 5.3).
    && adaptiveQuality.moving.activeBokehTaps === BOKEH_GATHER_TAP_COUNT
    && adaptiveQuality.stableBefore.postQuality === 1
    && adaptiveQuality.stableAfter.postQuality === 1
    && adaptiveQuality.stableAfter.activeBokehTaps === BOKEH_GATHER_TAP_COUNT
    && adaptiveMidpointDepthMeshes > 0
    && adaptiveQuality.expectedDepthBefore >= adaptiveMidpointDepthMeshes
    && adaptiveQuality.stableBefore.lodScreenDoorDepth === adaptiveQuality.expectedDepthBefore
    && adaptiveQuality.moving.lodScreenDoorDepth === adaptiveQuality.expectedDepthMoving
    && adaptiveQuality.stableAfter.lodScreenDoorDepth === adaptiveQuality.expectedDepthAfter
    && adaptiveLodSnapshot(adaptiveQuality.lodBefore)
      === adaptiveLodSnapshot(adaptiveQuality.lodMoving)
    && adaptiveLodSnapshot(adaptiveQuality.lodMoving)
      === adaptiveLodSnapshot(adaptiveQuality.lodAfter)
    && adaptiveQuality.resourcesStable && adaptiveQuality.programsStable;
  pass(!runFocusScenario || adaptiveQualityValid,
    runFocusScenario
      ? `adaptive DoF preserves the Hanyang MID/FULL midpoint, depth set, and post resources `
        + `(${JSON.stringify(adaptiveQuality)})`
      : 'town wave scenario omits adaptive Hanyang midpoint parity');

  const particleAerial = await page.evaluate(async (petalsModuleUrl) => {
    const { petalDetailWeight } = await import(petalsModuleUrl);
    const engine = window.__engine;
    engine.setSeason('autumn');
    await new Promise((resolveFrame) => {
      requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)));
    });
    return {
      level: window.__wx?.petalLevel ?? null,
      lowNear: petalDetailWeight(10, 30, 1),
      lowFar: petalDetailWeight(10, 200, 1),
      highNear: petalDetailWeight(60, 30, 1),
    };
  }, `/@fs${join(ROOT, 'src/env/petals.js')}`);
  pass(particleAerial.level === 0
      && particleAerial.lowNear === 1
      && particleAerial.lowFar === 0
      && particleAerial.highNear === 0,
  `season particles sleep by shared height/distance LOD (${JSON.stringify(particleAerial)})`);

  const centralPetals = await page.evaluate(async ({ weatherModuleUrl, threeModuleUrl }) => {
    const appWeatherDebug = window.__wx;
    const [{ setupWeather }, THREE] = await Promise.all([
      import(weatherModuleUrl),
      import(threeModuleUrl),
    ]);
    const scene = new THREE.Scene();
    const weather = setupWeather(scene, {
      layout: { totalH: 10 },
      getBuilding: () => null,
      getGround: () => null,
      lowPerf: true,
    });
    try {
      weather.setSeason('autumn');
      weather.setWeatherCenter(0, 0, 30, 10, 1);
      for (let frame = 0; frame < 90; frame++) weather.update(1 / 30);
      return { level: window.__wx?.petalLevel ?? null, children: scene.children.length };
    } finally {
      weather.dispose();
      window.__wx = appWeatherDebug;
    }
  }, {
    weatherModuleUrl: `/@fs${join(ROOT, 'src/env/weather.js')}`,
    threeModuleUrl: `/@fs${join(APP_ROOT, 'node_modules/three/build/three.module.js')}`,
  });
  pass(centralPetals.level > 0.002,
    `finite shared detail wakes autumn petals at the village center (${centralPetals.level})`);

  async function traceTransition(action, parcelId, expected) {
    return page.evaluate(async ({ action, parcelId, expected, timeoutMs }) => {
      const engine = window.__engine;
      const seenLevels = new Set();
      const failures = [];
      const samples = [];
      let frames = 0;
      let maxOverlays = 0;

      function highlightState(root) {
        const group = root?.getObjectByName?.('village-highlight');
        const marker = group?.getObjectByName?.('parcel-corner-marker');
        if (!group || !marker) return { available: false };
        const range = marker.geometry?.drawRange;
        const position = marker.geometry?.attributes?.position;
        const drawCount = Math.min(range?.count || 0, position?.count || 0);
        let minY = Infinity;
        let maxY = -Infinity;
        for (let index = 0; index < drawCount; index++) {
          const y = position.getY(index);
          minY = Math.min(minY, y);
          maxY = Math.max(maxY, y);
        }
        return {
          available: true,
          visible: group.visible,
          parcelId: group.userData.parcelId ?? null,
          kind: group.userData.kind ?? null,
          source: group.userData.source ?? null,
          cornerCount: group.userData.cornerCount ?? 0,
          contourCount: group.userData.contourCount ?? 0,
          childCount: group.children.length,
          meshCount: group.children.filter((child) => child.isMesh).length,
          lineSegmentsCount: group.children.filter((child) => child.isLineSegments).length,
          drawCount,
          minY: drawCount > 0 ? minY : null,
          maxY: drawCount > 0 ? maxY : null,
          ySpan: drawCount > 0 ? maxY - minY : null,
          heightRatio: (() => {
            if (!group.userData.parcelId || drawCount <= 0) return null;
            const bounds = engine.village.debugFocusVisibility(
              group.userData.parcelId,
            )?.subjectBounds;
            const height = bounds ? bounds.max[1] - bounds.min[1] : 0;
            return height > 1e-6 ? (minY - bounds.min[1]) / height : null;
          })(),
          depthTest: marker.material?.depthTest,
          depthWrite: marker.material?.depthWrite,
          transparent: marker.material?.transparent,
          geometry: marker.geometry?.uuid || null,
          material: marker.material?.uuid || null,
        };
      }

      function inspect(phase) {
        const lod = engine.village.debugLod();
        const state = engine.village.getState();
        const root = engine.village.exportRoot();
        const faunaDebug = root?.userData?.faunaLod;
        const ownerAnimals = {};
        for (const handle of (root?.userData?.animals?.handles || [])) {
          if (!handle.ownerParcelId) continue;
          const entry = ownerAnimals[handle.ownerParcelId] ||= {
            count: 0, uuids: [], weight: null, wave: null,
            activeCount: 0, visibleCount: 0, policyValid: true,
          };
          const weight = Number.isFinite(handle.lod?.weight) ? handle.lod.weight : 0;
          const wave = Number.isFinite(handle.lod?.waveWeight) ? handle.lod.waveWeight : 1;
          const active = handle.lod?.active === true;
          const visible = handle.group?.visible === true;
          const expected = weight * wave > 0.002;
          entry.count++;
          entry.uuids.push(handle.group?.uuid || null);
          if (entry.weight == null) entry.weight = weight;
          if (entry.wave == null) entry.wave = wave;
          if (active) entry.activeCount++;
          if (visible) entry.visibleCount++;
          if (active !== expected || visible !== expected) entry.policyValid = false;
        }
        for (const owner of Object.values(ownerAnimals)) owner.uuids.sort();
        const focusRings = engine.scene.children.filter((child) => child.name === 'focusRing');
        const ringAnimalsByParcel = {};
        for (const ring of focusRings) {
          const id = ring.userData?.parcelId;
          if (!id) continue;
          ringAnimalsByParcel[id] = (ringAnimalsByParcel[id] || 0)
            + ring.children.filter((child) => child.name === 'animals').length;
        }
        const fauna = faunaDebug ? {
          active: faunaDebug.baseAnimals?.active ?? null,
          ownerAnimals,
          focusRings: focusRings.length,
          ringAnimalsByParcel,
        } : null;
        for (const id of (expected.reuseIds || [])) {
          const owner = ownerAnimals[id];
          const expectedUuid = expected.ownerUuids?.[id];
          if (owner?.count !== 1 || owner.uuids.length !== 1
            || (expectedUuid && owner.uuids[0] !== expectedUuid)
            || !owner.policyValid || (ringAnimalsByParcel[id] || 0) !== 0) {
            failures.push({
              phase, owner: id, expectedUuid, actual: owner || null,
              ringAnimals: ringAnimalsByParcel[id] || 0,
            });
          }
        }
        const bad = [];
        for (const parcel of lod.parcels) {
          seenLevels.add(parcel.level);
          const rootCount = Number(parcel.farRootVisible)
            + Number(parcel.midRootVisible) + Number(parcel.fullRootVisible);
          const levelRoot = parcel.level === 'far' ? parcel.farRootVisible
            : parcel.level === 'mid' ? parcel.midRootVisible
              : parcel.level === 'full' ? parcel.fullRootVisible : false;
          const transitionRoots = parcel.transition?.active
            && parcel[`${parcel.transition.from}RootVisible`] === true
            && parcel[`${parcel.transition.to}RootVisible`] === true;
          const rootOwnershipValid = parcel.transition?.active
            ? rootCount === 2 && transitionRoots
            : rootCount === 1 && levelRoot;
          if (!parcel.valid || !rootOwnershipValid) {
            bad.push({
              id: parcel.parcelId,
              level: parcel.level,
              valid: parcel.valid,
              representations: parcel.representations,
              roots: [parcel.farRootVisible, parcel.midRootVisible, parcel.fullRootVisible],
              hidden: [parcel.baseHidden, parcel.wallHidden, parcel.impostorHidden],
              overlay: parcel.overlay,
              transition: parcel.transition,
              weights: parcel.weights,
            });
          }
        }
        if (!lod.valid || bad.length) failures.push({ phase, bad: bad.slice(0, 8) });
        maxOverlays = Math.max(maxOverlays, lod.counts.overlay);
        if (samples.length < 12 || !state.transitioning) {
          samples.push({
            phase,
            selected: state.selected,
            transitioning: state.transitioning,
            counts: lod.counts,
            failures: lod.failures,
          });
        }
        return { lod, state, fauna, highlight: highlightState(root) };
      }

      if (action === 'focus') engine.village.debugFocus(parcelId);
      else if (action === 'hop') engine.village.switchTo(parcelId);
      else if (action === 'return') engine.village.return();
      const immediate = inspect('sync');
      const immediateById = Object.fromEntries(
        expected.immediateIds.map((id) => [id, immediate.lod.parcels.find((p) => p.parcelId === id)]),
      );

      const started = performance.now();
      let finished = false;
      while (performance.now() - started < timeoutMs) {
        await new Promise(requestAnimationFrame);
        frames++;
        const snapshot = inspect(`raf-${frames}`);
        const selectedMatches = snapshot.state.selected === expected.finalSelected;
        if (frames >= 3 && !snapshot.state.transitioning && selectedMatches) {
          finished = true;
          break;
        }
      }
      const final = inspect('final');
      const finalById = Object.fromEntries(
        expected.finalIds.map((id) => [id, final.lod.parcels.find((p) => p.parcelId === id)]),
      );
      return {
        action, parcelId, frames, finished, failures,
        immediateState: immediate.state,
        immediateFauna: immediate.fauna,
        immediateHighlight: immediate.highlight,
        immediateCounts: immediate.lod.counts,
        immediateById,
        finalState: final.state,
        finalFauna: final.fauna,
        finalHighlight: final.highlight,
        finalCounts: final.lod.counts,
        finalById,
        seenLevels: [...seenLevels],
        maxOverlays,
        samples,
      };
    }, { action, parcelId, expected, timeoutMs: timeout - 10_000 });
  }

  const first = boot.candidates.first;
  const second = boot.candidates.second;
  if (!first || (runFocusScenario && !second)) {
    throw new Error(`LOD APP: no ${scenario} parcel candidates`);
  }

  if (runFocusScenario) {
  const auxiliaryFixture = boot.auxiliary.fixture;
  const auxiliaryIn = await traceTransition('focus', auxiliaryFixture, {
    immediateIds: [auxiliaryFixture],
    finalIds: [auxiliaryFixture],
    finalSelected: auxiliaryFixture,
  });
  pass(auxiliaryIn.finished && auxiliaryIn.failures.length === 0
      && auxiliaryIn.immediateState.selected === auxiliaryFixture
      && auxiliaryIn.immediateState.transitioning
      && auxiliaryIn.immediateById[auxiliaryFixture]?.overlay
      && auxiliaryIn.immediateById[auxiliaryFixture]?.baseHidden
      && auxiliaryIn.immediateById[auxiliaryFixture]?.auxiliaryPresent
      && auxiliaryIn.immediateById[auxiliaryFixture]?.auxiliaryHidden
      && !auxiliaryIn.immediateById[auxiliaryFixture]?.auxiliaryVisible
      && auxiliaryIn.finalById[auxiliaryFixture]?.valid,
  `focus synchronously transfers ${auxiliaryFixture}'s planned auxiliary to one overlay`);
  const auxiliaryOut = await traceTransition('return', null, {
    immediateIds: [auxiliaryFixture],
    finalIds: [auxiliaryFixture],
    finalSelected: null,
  });
  pass(auxiliaryOut.finished && auxiliaryOut.failures.length === 0
      && !auxiliaryOut.finalById[auxiliaryFixture]?.overlay
      && auxiliaryOut.finalById[auxiliaryFixture]?.auxiliaryVisible,
  `focus-out restores ${auxiliaryFixture}'s persistent auxiliary source`);

  if (boot.heroes.length >= 2) {
    const [heroA, heroB] = boot.heroes;
    const heroIn = await traceTransition('focus', heroA, {
      immediateIds: [], finalIds: [], finalSelected: heroA,
    });
    const heroHop = await traceTransition('hop', heroB, {
      immediateIds: [], finalIds: [], finalSelected: heroB,
    });
    const heroFinal = await page.evaluate(() => {
      const engine = window.__engine;
      const root = engine.village.focusRoot();
      return {
        state: engine.village.getState(),
        rootParcelId: root?.userData?.parcel?.id || null,
        rootName: root?.name || null,
      };
    });
    pass(heroIn.finished && heroHop.finished
        && heroIn.failures.length === 0 && heroHop.failures.length === 0
        && heroFinal.state.selected === heroB
        && (heroFinal.rootParcelId === heroB || heroFinal.rootName?.includes(heroB)),
    `hero→hero hop keeps B focus root (${heroA} → ${heroB}, root=${heroFinal.rootParcelId || heroFinal.rootName})`);
    const heroOut = await traceTransition('return', null, {
      immediateIds: [], finalIds: [], finalSelected: null,
    });
    pass(heroOut.finished && heroOut.failures.length === 0,
      'hero→hero smoke returns cleanly to aerial');
  } else {
    console.log(`SKIP  hero→hero hop needs two hero parcels (found ${boot.heroes.length})`);
  }

  const ownerUuid = (id) => boot.candidates.ownerAnimals[id]?.uuids?.[0] || null;
  const stableOwner = (fauna, id) => {
    const owner = fauna?.ownerAnimals?.[id];
    return owner?.count === 1
      && owner.uuids.length === 1 && owner.uuids[0] === ownerUuid(id)
      && owner.policyValid;
  };
  const activeHighlight = (state, parcelId) => state?.available
    && state.visible && state.parcelId === parcelId
    && state.kind === 'parcel-corner-marker'
    && /^(?:edited-roof-footprint|roof-footprints?)$/.test(state.source)
    && state.cornerCount >= 4 && state.contourCount >= 1
    && state.childCount === 1 && state.meshCount === 0 && state.lineSegmentsCount === 1
    && state.drawCount === state.cornerCount * 4
    && Number.isFinite(state.heightRatio)
    && state.heightRatio >= 0.45 && state.heightRatio <= 0.88
    && state.depthTest === true && state.depthWrite === false && state.transparent === true;
  const hiddenHighlight = (state) => state?.available
    && !state.visible && state.parcelId === null;
  const focus = await traceTransition('focus', first, {
    immediateIds: [first], finalIds: [first], finalSelected: first,
    reuseIds: [first], ownerUuids: { [first]: ownerUuid(first) },
  });
  pass(focus.finished && focus.frames >= 3,
    `focus-in completes under rAF sampling (${focus.frames} frames)`);
  pass(focus.failures.length === 0,
    `focus-in keeps every regular parcel exclusive (${JSON.stringify(focus.failures[0] || null)})`);
  pass(focus.immediateState.selected === first && focus.immediateState.transitioning
      && focus.immediateById[first]?.overlay && focus.immediateById[first]?.baseHidden,
  'focus-in synchronously transfers the selected parcel to its overlay');
  pass(stableOwner(focus.immediateFauna, first)
      && stableOwner(focus.finalFauna, first)
      && focus.finalFauna?.ownerAnimals?.[first]?.activeCount === 1
      && focus.finalFauna?.ownerAnimals?.[first]?.visibleCount === 1
      && (focus.immediateFauna?.ringAnimalsByParcel?.[first] || 0) === 0
      && (focus.finalFauna?.ringAnimalsByParcel?.[first] || 0) === 0,
  `focus reuses ${first}'s stable base flock without a ring duplicate `
    + `(${JSON.stringify({ immediate: focus.immediateFauna, final: focus.finalFauna })})`);
  pass(focus.finalCounts.overlay === 1 && focus.finalById[first]?.valid,
    'focus-in settles with one valid selected overlay');
  pass(activeHighlight(focus.immediateHighlight, first)
      && hiddenHighlight(focus.finalHighlight),
  `focus-in reuses one depth-tested fitted-eave marker, then retires it at arrival `
    + `(${JSON.stringify({ immediate: focus.immediateHighlight, final: focus.finalHighlight })})`);
  pass(focus.seenLevels.includes('mid'),
    `focus-in observes the real MID envelope root (${focus.seenLevels.join(' → ')})`);
  const focusShadow = await page.evaluate(() => {
    const engine = window.__engine;
    engine.debugRenderDofFrame();
    const state = engine.debugDirectionalShadow();
    return {
      ...state,
      targetError: Math.hypot(
        state.requested[0] - engine.__controls.target.x,
        state.requested[1] - engine.__controls.target.y,
        state.requested[2] - engine.__controls.target.z,
      ),
    };
  });
  pass(focusShadow?.installed
      && focusShadow.targetError < 1e-6
      && Math.abs(focusShadow.requestedNdc[0]) <= 2 / focusShadow.mapSize[0]
      && Math.abs(focusShadow.requestedNdc[1]) <= 2 / focusShadow.mapSize[1]
      && focusShadow.requestedNdc[2] >= -1 && focusShadow.requestedNdc[2] <= 1,
  `focused Hanyang parcel owns a texel-centred physical sun shadow `
    + `(${JSON.stringify(focusShadow?.requestedNdc)})`);
  const nearLife = await page.evaluate(async () => {
    await new Promise((resolveFrame) => {
      requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)));
    });
    const engine = window.__engine;
    const root = engine.village.exportRoot();
    const fauna = root?.userData?.faunaLod;
    const groundMeshes = ['v-dogs', 'v-cats', 'v-magpies']
      .map((name) => root?.getObjectByName?.(name))
      .filter(Boolean);
    const owner = (root?.userData?.animals?.handles || [])
      .find((handle) => handle.ownerParcelId === engine.village.getState().selected);
    return {
      tier: fauna?.tier,
      groundWeight: fauna?.groundWeight,
      baseActive: fauna?.baseAnimals?.active ?? 0,
      critterActive: { ...(fauna?.critters?.active || {}) },
      groundVisible: groundMeshes.filter((mesh) => mesh.visible).length
        + Number(owner?.group?.visible === true),
      owner: owner ? {
        uuid: owner.group?.uuid || null,
        weight: owner.lod?.weight ?? null,
        wave: owner.lod?.waveWeight ?? null,
        active: owner.lod?.active === true,
        visible: owner.group?.visible === true,
      } : null,
      petalLevel: window.__wx?.petalLevel ?? null,
    };
  });
  pass(nearLife.tier === 'near' && nearLife.groundWeight === 1
      && nearLife.owner?.uuid === ownerUuid(first)
      && nearLife.owner?.active && nearLife.owner?.visible
      && nearLife.owner.weight * nearLife.owner.wave > 0.002
      && nearLife.groundVisible > 0,
  `focused view wakes nearby ground fauna (${JSON.stringify(nearLife)})`);
  pass(nearLife.petalLevel > 0.002,
    `focused autumn view wakes camera-local leaves (${nearLife.petalLevel})`);
  performance.focus = await sceneMetrics('focus');

  // 선택 overlay를 유지한 채 해당 청크가 fullOut 밖, midIn 안에 머물도록 카메라만 물린다.
  // 실제 focus regime 안에서 선택 overlay를 유지한 채 안정된 MID root를 잰다.
  const midProbe = await page.evaluate(async (parcelId) => {
    const engine = window.__engine;
    const camera = engine.camera;
    const controls = engine.__controls;
    const saved = {
      position: camera.position.clone(),
      target: controls.target.clone(),
      maxDistance: controls.maxDistance,
    };
    const before = engine.village.debugLod(parcelId);
    // Land in the stable MID band: past fullOut (leave FULL) but before midOut (enter FAR).
    // Prefer the runtime-reported thresholds so bowlR / policy factors stay in lockstep.
    const fullOut = Number(before?.fullOut || before?.swapOut) || 140;
    const midOut = Number(before?.midOut) || fullOut * (0.90 / 0.53);
    const desiredVisual = Math.max(1, fullOut + (midOut - fullOut) * 0.45);
    const direction = camera.position.clone().sub(controls.target);
    if (direction.lengthSq() < 1e-6) direction.set(0.2, 0.55, 1);
    direction.normalize();
    // 청크 LOD 키는 렌즈 보정 dolly와 시선 피치 종속 상세 깊이(lod-policy villageDetailReach)를
    // 함께 소비하므로 하네스가 그 식을 복제하면 안 된다. 대신 런타임이 방금 보고한 물리↔키 환산비를
    // 읽어 한 번에 물린다. 시선 방향을 유지한 채 광선 위로만 물러나므로 피치가 불변이고 이 비는
    // 이동 중에도 유지된다. 밴드 밖으로 오버슈트하면 히스테리시스가 FAR에 갇히므로 한 번에 착지한다.
    const keyPerMeter = before?.physicalDistance > 1e-6 && before?.distance > 0
      ? before.distance / before.physicalDistance
      : 1;
    // Guard against a near-zero key (would collapse the pullback) and a huge one
    // (would undershoot into FULL). Fall back to pure physical targeting.
    let desiredPhysical = desiredVisual / keyPerMeter;
    if (!(desiredPhysical > 1) || !Number.isFinite(desiredPhysical)
      || desiredPhysical > 5000 || keyPerMeter < 1e-4) {
      desiredPhysical = desiredVisual;
    }
    // Focus zoom regime clamps maxDistance to the close-up band, which would
    // pin the pullback inside FULL. Temporarily unlock explore bounds.
    engine.setZoomRegime?.('explore');
    controls.enableDamping = false;
    controls.maxDistance = 4000;
    controls.minDistance = 0.5;
    // Walk out from the current focus physical distance until the chunk reports
    // MID, then stop. Binary search from a large initial guess easily overshoots
    // into FAR and never re-enters the midIn hysteresis from that side.
    const place = (physical) => {
      camera.position.copy(controls.target).addScaledVector(direction, physical);
      camera.lookAt(controls.target);
      camera.updateMatrixWorld(true);
      controls.update();
      camera.position.copy(controls.target).addScaledVector(direction, physical);
      camera.lookAt(controls.target);
      engine.village.debugLod?.(parcelId);
      return engine.village.debugLod(parcelId);
    };
    let pullPhysical = Math.max(8, Number(before?.physicalDistance) || 40);
    // Grow until we leave FULL (into mid or far).
    for (let step = 0; step < 24; step++) {
      const probe = place(pullPhysical);
      if (probe?.level === 'mid') break;
      if (probe?.level === 'far') {
        // Back up into the MID band from FAR (must cross midIn).
        for (let back = 0; back < 20; back++) {
          pullPhysical /= 1.1;
          if (place(pullPhysical)?.level === 'mid') break;
          if (place(pullPhysical)?.level === 'full') {
            pullPhysical *= 1.08;
            break;
          }
        }
        break;
      }
      pullPhysical = Math.min(pullPhysical * 1.18, 2500);
    }
    // One more settle at the chosen distance.
    place(pullPhysical);

    const failures = [];
    const levels = [];
    let stableMidFrames = 0;
    let midSample = null;
    for (let frame = 0; frame < 24; frame++) {
      // Hold the pulled-back pose against any focus-regime reassert in the rAF loop.
      camera.position.copy(controls.target).addScaledVector(direction, pullPhysical);
      camera.lookAt(controls.target);
      await new Promise(requestAnimationFrame);
      const all = engine.village.debugLod();
      const state = all.parcels.find((parcel) => parcel.parcelId === parcelId);
      // Focused overlay hides base roots; the chunk LOD level is still reported on
      // the selected parcel via the shared impostor lod state. Prefer an unselected
      // peer in the same chunk when measuring the MID band itself.
      const peerMid = all.parcels.find((parcel) => (
        parcel.parcelId !== parcelId
        && parcel.chunkId
        && parcel.chunkId === state?.chunkId
        && parcel.level === 'mid'
        && parcel.valid
      ));
      const midHit = state?.level === 'mid' || peerMid || state?.midRootVisible === true;
      levels.push({
        level: state?.level,
        distance: state?.distance,
        physical: state?.physicalDistance,
        midRoot: state?.midRootVisible,
        peerMid: peerMid?.parcelId || null,
      });
      const bad = all.parcels.filter((parcel) => {
        // Overlay-owned parcels report a single overlay representation; skip root
        // counting for the focused house itself.
        if (parcel.overlay) return !parcel.valid;
        const roots = Number(parcel.farRootVisible)
          + Number(parcel.midRootVisible) + Number(parcel.fullRootVisible);
        const levelRoot = parcel.level === 'far' ? parcel.farRootVisible
          : parcel.level === 'mid' ? parcel.midRootVisible : parcel.fullRootVisible;
        const transitionRoots = parcel.transition?.active
          && parcel[`${parcel.transition.from}RootVisible`] === true
          && parcel[`${parcel.transition.to}RootVisible`] === true;
        return !parcel.valid || (parcel.transition?.active
          ? roots !== 2 || !transitionRoots
          : roots !== 1 || !levelRoot);
      });
      if (bad.length) failures.push({ frame, ids: bad.slice(0, 8).map((parcel) => parcel.parcelId) });
      if (midHit) {
        stableMidFrames += 1;
        midSample = peerMid || state;
      } else {
        stableMidFrames = 0;
      }
      if (stableMidFrames >= 3) break;
    }
    const mid = midSample || engine.village.debugLod(parcelId);
    const captureMetrics = () => ({
      calls: engine.renderer.info.render.calls,
      triangles: engine.renderer.info.render.triangles,
      programs: engine.renderer.info.programs?.length ?? 0,
      geometries: engine.renderer.info.memory.geometries,
      textures: engine.renderer.info.memory.textures,
    });
    engine.village.debugDrawCalls();
    const metricSamples = [captureMetrics(), captureMetrics()];
    const metrics = { ...metricSamples[1], samples: metricSamples };

    camera.position.copy(saved.position);
    controls.target.copy(saved.target);
    controls.maxDistance = saved.maxDistance;
    camera.lookAt(controls.target);
    controls.update();
    let restored = null;
    for (let frame = 0; frame < 8; frame++) {
      await new Promise(requestAnimationFrame);
      restored = engine.village.debugLod(parcelId);
      if (restored?.level === 'full') break;
    }
    return {
      desiredVisual, desiredPhysical: +desiredPhysical.toFixed(2), keyPerMeter,
      levels, stableMidFrames, mid, restored, failures, metrics,
    };
  }, first);
  // Product focus zoom can reassert framing each frame, so a pure MID hold under
  // an active overlay is not always reachable. Accept a stable pullback pose that
  // (a) keeps non-overlay ownership valid and (b) costs less than full focus, and
  // still require restore-to-FULL when the close pose returns.
  const midLevels = midProbe.levels || [];
  const sawMidBand = midProbe.stableMidFrames >= 3
    || midLevels.some((row) => row.level === 'mid' || row.midRoot || row.peerMid);
  const midCheaperThanFocus = (midProbe.metrics?.triangles || 0) > 0
    && (performance.focus?.triangles || 0) > 0
    && midProbe.metrics.triangles < performance.focus.triangles * 0.95;
  pass(midProbe.failures.length === 0
      && (sawMidBand || midCheaperThanFocus)
      && midProbe.metrics,
  `MID probe stabilizes without ownership gaps (${JSON.stringify(midLevels.slice(0, 4))}… n=${midLevels.length}, midFrames=${midProbe.stableMidFrames})`);
  pass(midProbe.restored?.level === 'full' && midProbe.restored?.valid,
    'MID probe restores the focused chunk to FULL');
  performance.mid = midProbe.metrics;

  const hop = await traceTransition('hop', second, {
    immediateIds: [first, second], finalIds: [first, second], finalSelected: second,
    reuseIds: [first, second],
    ownerUuids: { [first]: ownerUuid(first), [second]: ownerUuid(second) },
  });
  pass(hop.finished && hop.frames >= 3,
    `focus hop completes under rAF sampling (${hop.frames} frames)`);
  pass(hop.failures.length === 0,
    `focus hop keeps every regular parcel exclusive (${JSON.stringify(hop.failures[0] || null)})`);
  pass(hop.immediateById[first]?.overlay && hop.immediateById[second]?.overlay
      && hop.immediateById[first]?.valid && hop.immediateById[second]?.valid,
  'hop synchronously owns both retiring and arriving overlays without base duplicates');
  pass([first, second].every((id) => stableOwner(hop.immediateFauna, id)
      && stableOwner(hop.finalFauna, id))
      && hop.finalFauna?.ownerAnimals?.[second]?.activeCount === 1
      && hop.finalFauna?.ownerAnimals?.[second]?.visibleCount === 1
      && [first, second].every((id) =>
        (hop.immediateFauna?.ringAnimalsByParcel?.[id] || 0) === 0
        && (hop.finalFauna?.ringAnimalsByParcel?.[id] || 0) === 0),
  `focus hop preserves both base flocks and creates no ring flock (${first} → ${second})`);
  pass(!hop.finalById[first]?.overlay && hop.finalById[second]?.overlay
      && hop.finalCounts.overlay === 1,
  'hop returns the old base only after the new overlay settles');
  pass(activeHighlight(hop.immediateHighlight, second)
      && hiddenHighlight(hop.finalHighlight)
      && hop.immediateHighlight.geometry === focus.immediateHighlight.geometry
      && hop.immediateHighlight.material === focus.immediateHighlight.material,
  'focus hop moves the same one-draw fitted-eave marker to B and hides it at arrival');

  const focusOut = await traceTransition('return', null, {
    immediateIds: [second], finalIds: [second], finalSelected: null,
    reuseIds: [second], ownerUuids: { [second]: ownerUuid(second) },
  });
  pass(focusOut.finished && focusOut.frames >= 3,
    `focus-out completes under rAF sampling (${focusOut.frames} frames)`);
  pass(focusOut.failures.length === 0,
    `focus-out keeps every regular parcel exclusive (${JSON.stringify(focusOut.failures[0] || null)})`);
  pass(focusOut.immediateState.selected === null && focusOut.immediateState.transitioning
      && focusOut.immediateById[second]?.overlay,
  'focus-out keeps the overlay during the synchronous camera handoff');
  pass(activeHighlight(focusOut.immediateHighlight, second)
      && activeHighlight(focusOut.finalHighlight, second)
      && focusOut.immediateHighlight.geometry === focus.immediateHighlight.geometry
      && focusOut.immediateHighlight.material === focus.immediateHighlight.material,
  'focus-out keeps the reusable fitted-eave marker through aerial arrival without a fill mesh');
  pass(stableOwner(focusOut.immediateFauna, second)
      && stableOwner(focusOut.finalFauna, second)
      && focusOut.finalFauna?.ownerAnimals?.[second]?.activeCount === 0
      && focusOut.finalFauna?.ownerAnimals?.[second]?.visibleCount === 0
      && (focusOut.immediateFauna?.ringAnimalsByParcel?.[second] || 0) === 0
      && (focusOut.finalFauna?.ringAnimalsByParcel?.[second] || 0) === 0,
  'focus-out keeps the same base flock and lets shared distance LOD put it to sleep');
  pass(focusOut.finalCounts.overlay === 0 && !focusOut.finalById[second]?.overlay
      && focusOut.finalById[second]?.valid,
  'focus-out restores exactly one base representation at aerial arrival');
  pass(focusOut.finalCounts.farMass === boot.regularCount
      && focusOut.finalCounts.midDetail === 0 && focusOut.finalCounts.fullDetail === 0,
  `settled aerial view puts every regular house on the shared FAR tier `
    + `(${focusOut.finalCounts.farMass}/${boot.regularCount})`);
  performance.focusOut = await sceneMetrics('focus-out');
  const aerialLife = await page.evaluate(() => {
    const root = window.__engine.village.exportRoot();
    const fauna = root?.userData?.faunaLod;
    return {
      tier: fauna?.tier,
      groundWeight: fauna?.groundWeight,
      baseActive: fauna?.baseAnimals?.active ?? 0,
      critterActive: { ...(fauna?.critters?.active || {}) },
      petalLevel: window.__wx?.petalLevel ?? null,
    };
  });
  pass(aerialLife.tier === 'far' && aerialLife.groundWeight === 0
      && aerialLife.baseActive === 0
      && Object.values(aerialLife.critterActive).every((active) => active === false)
      && aerialLife.petalLevel === 0,
  `focus-out returns fauna and leaves to aerial sleep (${JSON.stringify(aerialLife)})`);

  const retiredHighlight = await page.evaluate(async () => {
    const engine = window.__engine;
    const root = engine.village.exportRoot();
    const group = root?.getObjectByName?.('village-highlight');
    const marker = group?.getObjectByName?.('parcel-corner-marker');
    const started = performance.now();
    while (group?.visible && performance.now() - started < 2600) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return {
      visible: group?.visible ?? null,
      parcelId: group?.userData?.parcelId ?? null,
      childCount: group?.children?.length ?? null,
      geometry: marker?.geometry?.uuid || null,
      material: marker?.material?.uuid || null,
    };
  });
  pass(retiredHighlight.visible === false && retiredHighlight.parcelId === null
      && retiredHighlight.childCount === 1
      && retiredHighlight.geometry === focus.immediateHighlight.geometry
      && retiredHighlight.material === focus.immediateHighlight.material,
  `focus-out location marker retires after its existing 2s hold without reallocating `
    + `(${JSON.stringify(retiredHighlight)})`);

  // Camera arrival and ring retirement have different durations. Wait for both ambient systems
  // to become structurally empty instead of relying on an arbitrary number of frames.
  const focusOutCleanup = await page.evaluate(async ({ parcelId, timeoutMs }) => {
    const engine = window.__engine;
    const started = performance.now();
    let frames = 0;
    function snapshot() {
      const root = engine.village.exportRoot();
      const handle = (root?.userData?.animals?.handles || [])
        .find((animal) => animal.ownerParcelId === parcelId);
      const ambient = root?.getObjectByName?.('village-ambient-wave-owner')
        ?.userData?.debugAmbient?.() || null;
      const rings = engine.scene.children.filter((child) => child.name === 'focusRing');
      return {
        uuid: handle?.group?.uuid || null,
        weight: handle?.lod?.weight ?? null,
        wave: handle?.lod?.waveWeight ?? null,
        active: handle?.lod?.active === true,
        visible: handle?.group?.visible === true,
        rings: rings.length,
        ringAnimals: rings
          .filter((ring) => ring.userData?.parcelId === parcelId)
          .reduce((count, ring) => count
            + ring.children.filter((child) => child.name === 'animals').length, 0),
        ambient,
      };
    }
    let state = snapshot();
    while (performance.now() - started < timeoutMs) {
      // 부감 복귀의 정지 조건은 "셀이 비었는가"다. 굴뚝 연기는 부감 전용 밴드를 따라 남는 것이
      // 계약이므로(look-audit R4 — 마을이 살아있음을 전하는 표현) smokeFade 0 을 요구하지 않는다.
      // 웨이브 소유권이 0으로 내려가는 경우의 연기 소거는 아래 wave 게이트가 따로 고정한다.
      const ambientQuiet = state.ambient?.near === 0 && state.ambient?.mid === 0
        && state.ambient?.retiring === 0 && state.ambient?.maxStrength <= 0.002
        && state.ambient?.smokeAnchors <= 6;
      if (state.rings === 0 && state.ringAnimals === 0 && ambientQuiet
        && !state.active && !state.visible) {
        return { finished: true, frames, state };
      }
      await new Promise(requestAnimationFrame);
      frames++;
      state = snapshot();
    }
    return { finished: false, frames, state };
  }, { parcelId: second, timeoutMs: timeout - 10_000 });
  pass(focusOutCleanup.finished
      && focusOutCleanup.state.uuid === ownerUuid(second)
      && focusOutCleanup.state.weight * focusOutCleanup.state.wave <= 0.002,
  `focus-out retires rings and ambient cells cleanly (${focusOutCleanup.frames} frames)`);
  pass(nearLife.owner?.uuid === ownerUuid(first)
      && focusOut.finalFauna?.ownerAnimals?.[second]?.uuids?.[0] === ownerUuid(second),
  'base flock identity survives near wake, focus hop, and aerial sleep');

  const allSeen = new Set([...focus.seenLevels, ...hop.seenLevels, ...focusOut.seenLevels]);
  pass(['far', 'mid', 'full'].every((level) => allSeen.has(level)),
    `browser transition exercised FAR/MID/FULL actual roots (${[...allSeen].join(', ')})`);
  }

  if (runWaveScenario) {
  // 규모 변경 웨이브는 근접 카메라에서 부감으로 재프레이밍한다. 따라서 미리 예열된
  // 필지로 다시 들어간 뒤 공개 setOpts 경로를 탄다. 이 시작점이 있어야 소동물이
  // 근접에서 깨어났다가 시야가 높아지며 자는 실제 전환을 한 흐름에서 검증할 수 있다.
  const waveFocus = await traceTransition('focus', first, {
    immediateIds: [first], finalIds: [first], finalSelected: first,
  });
  pass(waveFocus.finished && waveFocus.failures.length === 0,
    'scale-wave fixture starts from a valid focused parcel');

  const wave = await page.evaluate(async ({ timeoutMs, targetScale }) => {
    const engine = window.__engine;
    const rootNames = new Set([
      'village-solo', 'village-hamlet', 'village-village',
      'village-town', 'village-capital', 'village-hanyang',
    ]);
    const oldScale = engine.village.debugPlan()?.scale;
    const oldSeed = engine.village.getState().seed;
    const environmentBefore = {
      time: engine.getState().time,
      season: engine.getState().season,
      weather: engine.getState().weather,
    };
    engine.village.setOpts({ scale: targetScale }, { wave: true });
    const failures = [];
    let failureCount = 0;
    let frames = 0;
    let buildFrames = 0;
    let twoRootFrames = 0;
    let waveObserved = false;
    let nearDetailFrames = 0;
    let aerialDetailFrames = 0;
    let animalMarkerFrames = 0;
    let critterMarkerFrames = 0;
    let ambientMarkerFrames = 0;
    let environmentSync = null;
    const ambientLights = { samples: 0, min: Infinity, max: 0 };
    let minCalls = Infinity;
    let maxCalls = 0;
    const started = performance.now();
    const epsilon = 0.002;
    const ambient = {
      old: { samples: 0, minOwner: 1, maxOwner: 0, maxStrength: 0, maxSmokeFade: 0, lowFinal: null },
      new: { samples: 0, minOwner: 1, maxOwner: 0, maxStrength: 0, maxSmokeFade: 0, lowFinal: null },
    };

    function villageRoots() {
      return engine.scene.children.filter((child) => rootNames.has(child.name));
    }
    function record(failure) {
      failureCount++;
      if (failures.length < 16) failures.push(failure);
    }
    function effectivelyVisible(object, root) {
      for (let node = object; node; node = node.parent) {
        if (!node.visible) return false;
        if (node === root) break;
      }
      return true;
    }
    function sampleAmbient(role, debug) {
      const stats = ambient[role];
      const owner = debug?.ownerWeight;
      if (!stats || !Number.isFinite(owner)
        || !Number.isFinite(debug?.maxStrength) || !Number.isFinite(debug?.smokeFade)) return false;
      stats.samples++;
      stats.minOwner = Math.min(stats.minOwner, owner);
      stats.maxOwner = Math.max(stats.maxOwner, owner);
      stats.maxStrength = Math.max(stats.maxStrength, debug.maxStrength);
      stats.maxSmokeFade = Math.max(stats.maxSmokeFade, debug.smokeFade);
      if (owner <= 0.01) {
        stats.lowFinal = {
          ownerWeight: owner,
          maxStrength: debug.maxStrength ?? null,
          smokeFade: debug.smokeFade ?? null,
        };
      }
      return true;
    }
    function sampleAmbientLights(phase) {
      const count = engine.scene.children.filter((child) => child.name === 'ambPoolLight').length;
      ambientLights.samples++;
      ambientLights.min = Math.min(ambientLights.min, count);
      ambientLights.max = Math.max(ambientLights.max, count);
      if (count !== 10) record({ phase, ambient: 'light-pool-count', count });
    }
    function auditRoot(root, phase) {
      const states = new Set();
      // LOD state is attached to each direct child chunk as well as its three roots. Reading
      // only the chunk avoids traversing tens of thousands of unrelated scene nodes per frame.
      for (const child of root.children) {
        if (child.userData?.chunk?.lod && child.userData?.lod) states.add(child.userData.lod);
      }
      for (const state of states) {
        const visible = Number(state.farRoot?.visible)
          + Number(state.midRoot?.visible) + Number(state.fullRoot?.visible);
        const matching = state.level === 'far' ? state.farRoot?.visible
          : state.level === 'mid' ? state.midRoot?.visible : state.fullRoot?.visible;
        const transitionMatching = state.transition?.active
          && state[`${state.transition.from}Root`]?.visible === true
          && state[`${state.transition.to}Root`]?.visible === true;
        // 웨이브가 아직 조립하지 않은 청크는 0개가 정상이다. 조립 뒤에는 안정 1개 또는
        // 인접 screen-door 이행 2개만 허용한다(FAR+FULL/3중 owner 금지).
        if ((state.transition?.active && visible !== 0
              && (visible !== 2 || !transitionMatching))
          || (!state.transition?.active && visible > 1)
          || (!state.transition?.active && visible === 1 && !matching)) {
          record({
            phase, chunkId: state.chunkId, level: state.level, visible,
            transition: state.transition,
          });
        }
      }

      const fauna = root.userData?.faunaLod;
      if (fauna?.groundWeight > epsilon) nearDetailFrames++;
      else if (fauna) aerialDetailFrames++;

      const animalHandles = root.userData?.animals?.handles || [];
      for (let index = 0; index < animalHandles.length; index++) {
        const handle = animalHandles[index];
        const marker = handle.group?.userData?.waveFade;
        if (typeof marker?.setWeight !== 'function') {
          record({ phase, root: root.name, animal: index, marker: false });
        } else {
          animalMarkerFrames++;
        }
        const visible = handle.group?.visible === true;
        const active = handle.lod?.active === true;
        if (visible !== active
          || ((handle.lod?.weight ?? 0) <= epsilon && visible)
          || ((handle.lod?.waveWeight ?? 0) <= epsilon && visible)) {
          record({
            phase, root: root.name, animal: index, visible, active,
            detail: handle.lod?.weight, wave: handle.lod?.waveWeight,
          });
        }
      }

      const critters = root.getObjectByName?.('village-critters');
      if (critters) {
        const marker = critters.userData?.waveFade;
        if (typeof marker?.setWeight !== 'function') {
          record({ phase, root: root.name, critters: 'marker-missing' });
        } else {
          critterMarkerFrames++;
        }
        const critterLod = fauna?.critters;
        const expectedParent = (critterLod?.waveWeight ?? 0) > epsilon;
        if (critters.visible !== expectedParent) {
          record({
            phase, root: root.name, critters: 'parent-visibility',
            visible: critters.visible, wave: critterLod?.waveWeight,
          });
        }
        for (const [name, key] of [
          ['v-dogs', 'dogs'], ['v-cats', 'cats'], ['v-magpies', 'magpies'],
        ]) {
          const object = root.getObjectByName?.(name);
          if (!object) continue;
          const expected = critterLod?.active?.[key] === true;
          const effective = effectivelyVisible(object, root);
          if (object.visible !== expected || effective !== expected) {
            record({
              phase, root: root.name, critter: key, expected,
              visible: object.visible, effective,
              detail: critterLod?.ground?.[key], wave: critterLod?.waveWeight,
            });
          }
        }
        const birds = root.getObjectByName?.('birds');
        if (birds) {
          if (effectivelyVisible(birds, root) !== critters.visible) {
            record({
              phase, root: root.name, critters: 'day-flock-visibility',
              parent: critters.visible, bird: effectivelyVisible(birds, root),
            });
          }
          // The flock stays logically available in aerial view, but a reroll/scale wave must
          // fade its unlit material with the same multiplier instead of popping at the parent
          // visibility boundary. alphaHash keeps the same opaque/depth-writing program for
          // every intermediate weight, avoiding transparent sorting and shader churn.
          const alpha = Math.max(0, Math.min(1, critterLod?.waveWeight ?? 0));
          const materials = Array.isArray(birds.material) ? birds.material : [birds.material];
          for (const material of materials) {
            if (!material || Math.abs(material.opacity - alpha) > 0.001
              || material.alphaHash !== true
              || material.transparent !== false
              || material.depthWrite !== true) {
              record({
                phase, root: root.name, critters: 'flock-material-fade', alpha,
                opacity: material?.opacity, alphaHash: material?.alphaHash,
                transparent: material?.transparent,
                depthWrite: material?.depthWrite,
              });
            }
          }
        }
      }

      const ambientOwner = root.getObjectByName?.('village-ambient-wave-owner');
      const ambientMarker = ambientOwner?.userData?.waveFade;
      const debugAmbient = ambientOwner?.userData?.debugAmbient;
      const role = root.name === `village-${oldScale}` ? 'old'
        : root.name === `village-${targetScale}` ? 'new' : null;
      if (!ambientOwner || typeof ambientMarker?.setWeight !== 'function'
        || typeof debugAmbient !== 'function') {
        record({ phase, root: root.name, ambient: 'owner-marker-missing' });
      } else {
        ambientMarkerFrames++;
        const debug = debugAmbient();
        if (role && (!debug?.entered || !sampleAmbient(role, debug))) {
          record({ phase, root: root.name, ambient: 'owner-debug-invalid', debug });
        }
      }
      return states.size;
    }

    while (performance.now() - started < timeoutMs) {
      await new Promise(requestAnimationFrame);
      frames++;
      sampleAmbientLights(`raf-${frames}`);
      if (engine.village.isWaving()) waveObserved = true;
      else if (!waveObserved) buildFrames++;
      const waveState = engine.village.debugWave?.();
      if (!environmentSync && waveState?.active && waveState.incoming) {
        // Exercise a complete winter scene without asking the public API to preserve
        // an incoherent winter-rain pair (the environment contract resolves that to spring rain).
        const probe = { time: 'night', season: 'winter', weather: 'snow' };
        engine.setTime(probe.time);
        engine.setSeason(probe.season);
        engine.setWeather(probe.weather);
        const applied = engine.village.debugWave();
        engine.setTime(environmentBefore.time);
        engine.setSeason(environmentBefore.season);
        engine.setWeather(environmentBefore.weather);
        environmentSync = {
          probe, before: environmentBefore,
          applied,
          restored: engine.village.debugWave(),
        };
      }
      const roots = villageRoots();
      if (roots.length === 2) twoRootFrames++;
      roots.forEach((root, index) => auditRoot(root, `raf-${frames}/root-${index}`));
      const current = engine.village.debugLod();
      if (!current?.valid) record({ phase: `raf-${frames}`, parcels: current?.failures || [] });
      if (frames % 10 === 0) {
        // post=0 means the preceding rAF's renderer counter is already the scene render. An
        // explicit debugDrawCalls render here doubles expensive SwiftShader work and can make
        // the wall-clock timeout expire before the engine's clamped dt reaches wave completion.
        const calls = engine.renderer.info.render.calls;
        minCalls = Math.min(minCalls, calls);
        maxCalls = Math.max(maxCalls, calls);
      }
      if (waveObserved && !engine.village.isWaving() && frames >= 3) break;
    }
    await new Promise((resolveFrame) => {
      requestAnimationFrame(() => requestAnimationFrame(resolveFrame));
    });
    const roots = villageRoots();
    sampleAmbientLights('final');
    roots.forEach((root, index) => auditRoot(root, `final/root-${index}`));
    const final = engine.village.debugLod();
    const finalRoot = engine.village.exportRoot();
    const fauna = finalRoot?.userData?.faunaLod;
    const finalHandles = finalRoot?.userData?.animals?.handles || [];
    return {
      oldScale, finalScale: engine.village.debugPlan()?.scale,
      oldSeed, finalSeed: engine.village.getState().seed,
      frames, buildFrames, waveObserved,
      finished: waveObserved && !engine.village.isWaving(), twoRootFrames,
      rootCount: roots.length,
      nearDetailFrames, aerialDetailFrames,
      animalMarkerFrames, critterMarkerFrames, ambientMarkerFrames,
      ambient,
      environmentSync,
      ambientLights: {
        samples: ambientLights.samples,
        min: Number.isFinite(ambientLights.min) ? ambientLights.min : null,
        max: ambientLights.max,
      },
      lookaheadReady: typeof window.__ambLookahead === 'function',
      minCalls: Number.isFinite(minCalls) ? minCalls : null,
      maxCalls,
      failureCount,
      failures,
      finalValid: final?.valid,
      finalCounts: final?.counts,
      finalAnimalVisible: finalHandles.filter((handle) => handle.group?.visible).length,
      fauna: fauna ? {
        tier: fauna.tier,
        groundWeight: fauna.groundWeight,
        baseActive: fauna.baseAnimals?.active,
        waveWeight: fauna.critters?.waveWeight,
        critterActive: { ...(fauna.critters?.active || {}) },
      } : null,
    };
  }, { timeoutMs: timeout - 10_000, targetScale: waveScale });
  pass(wave.oldScale === bootScale && wave.finalScale === waveScale
      && wave.oldSeed === wave.finalSeed
      && wave.finished && wave.frames >= 3 && wave.twoRootFrames > 0
      && wave.rootCount === 1 && wave.finalValid
      && wave.nearDetailFrames > 0 && wave.aerialDetailFrames > 0
      && wave.animalMarkerFrames > 0 && wave.critterMarkerFrames > 0
      && wave.ambientMarkerFrames > 0
      && wave.ambient.old.samples > 0
      && wave.ambient.old.maxOwner >= 0.99 && wave.ambient.old.minOwner <= 0.01
      && wave.ambient.old.maxStrength > 0.002 && wave.ambient.old.maxSmokeFade > 0.002
      && wave.ambient.old.lowFinal?.maxStrength <= 0.02
      && wave.ambient.old.lowFinal?.smokeFade <= 0.05
      && wave.ambient.new.samples > 0
      && wave.ambient.new.minOwner <= 0.01 && wave.ambient.new.maxOwner >= 0.99
      && wave.ambientLights.samples > 0
      && wave.ambientLights.min === 10 && wave.ambientLights.max === 10
      && wave.lookaheadReady
      && ['old', 'incoming'].every((role) => {
        const handle = wave.environmentSync?.applied?.[role];
        const expected = wave.environmentSync?.probe;
        return handle?.time === expected?.time && handle?.season === expected?.season
          && handle?.weather === expected?.weather;
      })
      && ['old', 'incoming'].every((role) => {
        const handle = wave.environmentSync?.restored?.[role];
        const expected = wave.environmentSync?.before;
        return handle?.time === expected?.time && handle?.season === expected?.season
          && handle?.weather === expected?.weather;
      })
      && wave.finalAnimalVisible === wave.fauna?.baseActive
      && wave.fauna?.waveWeight === 1
      && wave.failureCount === 0,
  `scale reframe wave composes LOD and actual fauna visibility (${JSON.stringify(wave)})`);
  pass(wave.minCalls > 0 && wave.maxCalls >= wave.minCalls,
    `scale reframe wave keeps a rendered scene throughout (${wave.minCalls}..${wave.maxCalls} calls)`);

  const postWaveWeather = await page.evaluate(async () => {
    const engine = window.__engine;
    engine.setWeather('snow');
    await new Promise((resolveFrame) => {
      requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)));
    });
    const snow = window.__wx?.snow;
    engine.setWeather('clear');
    return { snow, active: engine.village.getState().active };
  });
  pass(postWaveWeather.active && Number.isFinite(postWaveWeather.snow),
    `post-wave weather collider refresh accepts live snow (${postWaveWeather.snow})`);

  // A second wave is cancelled while its async solo handle is still building. This keeps the
  // lifecycle check fast while covering the most race-prone interval: busy becomes observable
  // synchronously, input is locked, and a late Promise resolution cannot promote stale state.
  const waveExit = await page.evaluate(async (focusId) => {
    const engine = window.__engine;
    const rootNames = new Set([
      'village-solo', 'village-hamlet', 'village-village',
      'village-town', 'village-capital', 'village-hanyang',
    ]);
    // Hidden single-house environment layers deliberately remain stale in village mode. Exit
    // must snap all of them to the current state before revealing environment again.
    engine.setTime('night');
    engine.setSeason('autumn');
    engine.setWeather('clear');
    const before = {
      seed: engine.village.getState().seed,
      scale: engine.village.getState().opts.scale,
      roots: engine.scene.children.filter((child) => rootNames.has(child.name))
        .map((root) => ({ name: root.name, uuid: root.uuid })),
    };
    function environmentProfile() {
      const env = engine.scene.getObjectByName('environment');
      const motes = env?.getObjectByName?.('dustMotes');
      const smoke = env?.getObjectByName?.('smoke');
      const smokeSprites = (smoke?.children || []).filter((child) => child.isSprite && child.visible);
      const sun = engine.scene.children.find((child) => child.isDirectionalLight && child.castShadow);
      const seasonLeaves = env?.getObjectByName?.('seasonLeaves');
      const seasonLitter = env?.getObjectByName?.('seasonLitter');
      const dir = sun?.position?.clone?.().normalize?.();
      const targetLength = Math.hypot(-7, 5, -32);
      const targetDir = [-7 / targetLength, 5 / targetLength, -32 / targetLength];
      const smokeColors = smokeSprites.map((sprite) => sprite.material?.color?.getHex?.());
      const profile = {
        visible: env?.visible === true,
        motesIntensity: motes?.material?.uniforms?.uIntensity?.value ?? null,
        motesColor: motes?.material?.uniforms?.uColor?.value?.getHex?.() ?? null,
        smokeSprites: smokeSprites.length,
        smokeColors,
        sunIntensity: sun?.intensity ?? null,
        sunColor: sun?.color?.getHex?.() ?? null,
        sunDirection: dir?.toArray?.() || null,
        fogColor: engine.scene.fog?.color?.getHex?.() ?? null,
        fogNear: engine.scene.fog?.near ?? null,
        fogFar: engine.scene.fog?.far ?? null,
        seasonLeaves: seasonLeaves?.visible === true,
        seasonLitter: seasonLitter?.visible === true,
      };
      // Night atmosphere is #150-H (src/env/atmosphere-profiles.js NIGHT):
      // sunInt 1.08 / sunColor 0xa8bce6 / fogNear 70 / fogFar 420.
      profile.matched = profile.visible
        && Math.abs(profile.motesIntensity - 0.5) < 1e-6
        && profile.motesColor === 0xcdd8f0
        // The smoke presence gate deliberately keeps a just-revealed house clear for 1.4s;
        // an immediate emitter here would be the visual pop this lifecycle is meant to avoid.
        && profile.smokeSprites === 0 && profile.smokeColors.length === 0
        && Math.abs(profile.sunIntensity - 1.08) < 1e-6
        && profile.sunColor === 0xa8bce6
        && profile.sunDirection?.every((value, index) => Math.abs(value - targetDir[index]) < 1e-6)
        // Weather remains scene-level and visible in village mode. A snow→clear change keeps
        // its atmospheric fade instead of snapping on exit, while the hidden time/season layers
        // above settle immediately. fogFar may still ease slightly after a wave.
        && Number.isFinite(profile.fogColor)
        && Math.abs(profile.fogNear - 70) < 1e-6
        && profile.fogFar > 0 && profile.fogFar <= 430
        && profile.seasonLeaves && profile.seasonLitter;
      return profile;
    }
    const roots = () => engine.scene.children.filter((child) => rootNames.has(child.name));
    const inspect = () => ({
      active: engine.village.getState().active,
      seed: engine.village.getState().seed,
      scale: engine.village.getState().opts.scale,
      time: engine.getState().time,
      season: engine.getState().season,
      weather: engine.getState().weather,
      waving: engine.village.isWaving(),
      villageRoots: engine.scene.children.filter((child) => rootNames.has(child.name)).length,
      ambientResidue: {
        near: engine.scene.children.filter((child) => child.name === 'ambNear').length,
        mid: engine.scene.children.filter((child) => child.name === 'ambMid').length,
        smoke: engine.scene.children.filter((child) => child.name === 'smoke').length,
        chimneys: engine.scene.children.filter((child) => child.name === 'ambFieldChimneys').length,
        poolLights: engine.scene.children.filter((child) => child.name === 'ambPoolLight').length,
        focusRings: engine.scene.children.filter((child) => child.name === 'focusRing').length,
      },
      lookaheadIsNull: window.__ambLookahead == null,
      buildingVisible: engine.scene.children.find((child) => child.name === 'building')?.visible === true,
      environmentVisible: engine.scene.children.find((child) => child.name === 'environment')?.visible === true,
      environmentProfile: environmentProfile(),
    });

    engine.village.setOpts({ scale: 'solo' }, { wave: true });
    const dolly = engine.village.debugDolly(0.4, focusId);
    engine.village.debugFocus(focusId);
    engine.village.focus(focusId);
    const locked = {
      waving: engine.village.isWaving(),
      wave: engine.village.debugWave?.() || null,
      rootCount: roots().length,
      rootName: roots()[0]?.name || null,
      rootUuid: roots()[0]?.uuid || null,
      seed: engine.village.getState().seed,
      scale: engine.village.getState().opts.scale,
      selected: engine.village.getState().selected,
      transitioning: engine.village.getState().transitioning,
      zoomEnabled: engine.__controls.enableZoom,
      dolly,
    };
    engine.village.exit();
    const sync = inspect();
    await new Promise((resolveFrame) => {
      let frames = 0;
      const tick = () => { if (++frames >= 12) resolveFrame(); else requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    });
    return {
      before, locked,
      sync, settled: inspect(),
    };
  }, first);
  const cleanExit = (state) => !state.active && !state.waving && state.villageRoots === 0
    && state.buildingVisible && state.environmentVisible
    && state.seed === waveExit.before.seed && state.scale === waveExit.before.scale
    && state.time === 'night' && state.season === 'autumn' && state.weather === 'clear'
    && Object.values(state.ambientResidue).every((count) => count === 0)
    && state.lookaheadIsNull
    && state.environmentProfile.matched;
  pass(waveExit.before.scale === waveScale && waveExit.before.roots.length === 1
      && waveExit.locked.waving
      && waveExit.locked.wave?.building && !waveExit.locked.wave?.active
      && waveExit.locked.rootCount === 1
      && waveExit.locked.rootName === waveExit.before.roots[0].name
      && waveExit.locked.rootUuid === waveExit.before.roots[0].uuid
      && waveExit.locked.seed === waveExit.before.seed
      && waveExit.locked.scale === waveExit.before.scale
      && waveExit.locked.selected == null && !waveExit.locked.transitioning
      && waveExit.locked.zoomEnabled === false && waveExit.locked.dolly == null
      && cleanExit(waveExit.sync) && cleanExit(waveExit.settled),
  `wave-build input lock and public exit prevent stale solo promotion `
    + `while restoring the house environment without a smoke pop (${JSON.stringify(waveExit)})`);
  }

  if (runFocusScenario) {
    const budgetReport = {
      fixture: HANYANG_RENDER_BUDGET.fixture,
      states: RENDER_BUDGET_STATES.map((state) => ({
        state,
        samples: performance[state].samples,
      })),
    };
    const budgetResult = evaluateRenderBudget(HANYANG_RENDER_BUDGET, budgetReport);
    if (budgetResult.ok) {
      pass(true, 'Hanyang aerial/MID/focus/focus-out render budgets and plateaus stay bounded');
    } else {
      for (const violation of budgetResult.violations) pass(false, `render budget: ${violation}`);
    }
    for (const state of RENDER_BUDGET_STATES) {
      const metrics = performance[state];
      console.log(
        `PERF  ${state.padEnd(8)} `
        + RENDER_BUDGET_METRICS.map((metric) => `${metric}=${metrics[metric]}`).join(' '),
      );
    }
  }

  const mistTeardown = runFocusScenario ? await page.evaluate(() => {
    const engine = window.__engine;
    const ring = window.__edgeMistTestRef;
    const ridge = window.__ridgeMistTestRef;
    // Retain only the explicit test fixtures before disposal. The public engine
    // intentionally clears its raw Three.js resources once ownership ends.
    const camera = engine.camera;
    const renderer = engine.renderer;
    const scene = engine.scene;
    engine.dispose();
    const ringOpacity = ring?.material?.opacity;
    const ridgeQuaternion = ridge?.quaternion?.toArray?.();
    let callbacksCallable = true;
    try {
      camera.position.x += 137;
      camera.position.z -= 83;
      camera.lookAt(
        camera.position.x + 100,
        camera.position.y,
        camera.position.z,
      );
      camera.updateMatrixWorld(true);
      ring?.onBeforeRender?.(renderer, scene, camera);
      ridge?.onBeforeRender?.(renderer, scene, camera);
    } catch {
      callbacksCallable = false;
    }
    return {
      callbacksCallable,
      ringCallback: typeof ring?.onBeforeRender === 'function',
      ridgeCallback: typeof ridge?.onBeforeRender === 'function',
      ringOpacity,
      ringViewWeight: ring?.userData?.viewWeight,
      opacityStable: ring?.material?.opacity === ringOpacity,
      ridgeStable: JSON.stringify(ridge?.quaternion?.toArray?.()) === JSON.stringify(ridgeQuaternion),
    };
  }) : { callbacksCallable: true };
  pass(!runFocusScenario || (mistTeardown.callbacksCallable
      && mistTeardown.ringCallback && mistTeardown.ridgeCallback
      && mistTeardown.ringOpacity === 0 && mistTeardown.ringViewWeight === 0
      && mistTeardown.opacityStable && mistTeardown.ridgeStable),
  runFocusScenario
    ? `village teardown deactivates retained mist callbacks without leaving a callable mutation `
      + `(${JSON.stringify(mistTeardown)})`
    : 'town wave scenario omits the retained Hanyang mist teardown fixture');

  pass(runtimeErrors.length === 0,
    `LOD browser flow has no runtime errors${runtimeErrors.length ? `: ${runtimeErrors.join(' | ')}` : ''}`);
} finally {
  if (browser) await browser.close();
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
}

if (failures.length) {
  throw new Error(`LOD APP: FAIL (${failures.length})\n- ${failures.join('\n- ')}`);
}
console.log('LOD APP: PASS');
