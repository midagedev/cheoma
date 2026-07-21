// 실제 앱의 한양 장면에서 필지 표현 소유권과 생활 디테일 LOD를 프레임 단위로 검증한다.
// 느린 Playwright 게이트이므로 check-fast/check:all에는 넣지 않고 필요할 때 독립 실행한다.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from '../app/node_modules/vite/dist/node/index.js';

const ROOT = resolve(import.meta.dirname, '..');
const APP_ROOT = join(ROOT, 'app');
const cacheDir = await mkdtemp(join(tmpdir(), 'cheoma-lod-app-'));
// Headless SwiftShader serializes the large Hanyang shader workload. A 3.6s engine wave can
// therefore need several wall-clock minutes even though its frame/dt progression is healthy.
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
  browser = await chromium.launch();
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
    + '&seed=42&vseed=20260716&vscale=hanyang&time=day';
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
  await page.waitForFunction(() => window.__SHOT_READY === true && !!window.__engine, null, { timeout });
  await page.waitForFunction(() => {
    const plan = window.__engine?.village?.debugPlan?.();
    return plan?.scale === 'hanyang' && plan?.seed === 20260716;
  }, null, { timeout });
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

  const boot = await page.evaluate(() => {
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
    if (chunkLensState) {
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
      };
      chunkLens = { lensScale, reference, compensated };
    }
    const fauna = root?.userData?.faunaLod;
    const ownerParcelIds = [...new Set(
      (fauna?.baseAnimals?.ownerParcelIds || []).filter((id) => typeof id === 'string'),
    )];
    // Base-yard flock owners are the strongest focus-handoff fixture. Prefer two of them so
    // A→B can prove that both retiring and arriving overlays reuse stable flock objects.
    const ownerStates = ownerParcelIds
      .map((id) => lod.parcels.find((state) => state.parcelId === id)).filter(Boolean);
    const first = ownerStates.find((state) => state.level === 'far')
      || ownerStates[0] || far[0] || lod.parcels.find((state) => state.far) || lod.parcels[0];
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
    };
  });

  pass(boot.plan.scale === 'hanyang' && boot.plan.seed === 20260716,
    'isolated worker=0 app boots deterministic Hanyang');
  pass(boot.regularCount > 0 && boot.lodCount === boot.regularCount,
    `LOD snapshot covers every regular parcel (${boot.lodCount}/${boot.regularCount})`);
  pass(boot.lodValid && boot.lodFailures.length === 0,
    `aerial parcel representations are exclusive (${boot.lodFailures.join(', ') || 'no failures'})`);
  pass(!!boot.candidates.first && !!boot.candidates.second,
    'two regular parcels in different chunks are available for focus/hop');
  pass(boot.candidates.ownerParcelIds.includes(boot.candidates.first)
      && boot.candidates.ownerParcelIds.includes(boot.candidates.second),
  `focus/hop fixtures own base yard flocks (${boot.candidates.first}, ${boot.candidates.second})`);
  pass([boot.candidates.first, boot.candidates.second].every((id) => {
    const owner = boot.candidates.ownerAnimals[id];
    return owner?.count === 1 && owner.uuids.length === 1 && !!owner.uuids[0];
  }), 'focus/hop fixtures start with one stable base-flock object each');

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
  pass(boot.chunkLens
      && boot.chunkLens.reference.level === boot.chunkLens.compensated.level
      && Math.abs(boot.chunkLens.reference.distance
        - boot.chunkLens.reference.physicalDistance) < 1e-6
      && Math.abs(boot.chunkLens.compensated.physicalDistance
        - boot.chunkLens.reference.physicalDistance) < 1e-6
      && Math.abs(boot.chunkLens.compensated.distance * boot.chunkLens.lensScale
        - boot.chunkLens.compensated.physicalDistance) < 1e-6,
  'attached Hanyang chunk LOD consumes screen-equivalent lens distance without changing its stable tier');

  async function sceneMetrics(label) {
    const metrics = await page.evaluate(() => {
      const engine = window.__engine;
      const calls = engine.village.debugDrawCalls();
      return {
        calls,
        triangles: engine.renderer.info.render.triangles,
        programs: engine.renderer.info.programs?.length ?? 0,
        geometries: engine.renderer.info.memory.geometries,
        textures: engine.renderer.info.memory.textures,
      };
    });
    pass(Number.isFinite(metrics.calls) && metrics.calls > 0
        && Number.isFinite(metrics.triangles) && metrics.triangles > 0,
    `${label} scene-only renderer counters are finite`);
    return metrics;
  }

  const performance = {};

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
          if (!parcel.valid || parcel.representations !== 1 || rootCount !== 1 || !levelRoot) {
            bad.push({
              id: parcel.parcelId,
              level: parcel.level,
              valid: parcel.valid,
              representations: parcel.representations,
              roots: [parcel.farRootVisible, parcel.midRootVisible, parcel.fullRootVisible],
              hidden: [parcel.baseHidden, parcel.wallHidden, parcel.impostorHidden],
              overlay: parcel.overlay,
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
        return { lod, state, fauna };
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
        immediateCounts: immediate.lod.counts,
        immediateById,
        finalState: final.state,
        finalFauna: final.fauna,
        finalCounts: final.lod.counts,
        finalById,
        seenLevels: [...seenLevels],
        maxOverlays,
        samples,
      };
    }, { action, parcelId, expected, timeoutMs: timeout - 10_000 });
  }

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

  const first = boot.candidates.first;
  const second = boot.candidates.second;
  if (!first || !second) throw new Error('LOD APP: no focus/hop parcel candidates');
  const ownerUuid = (id) => boot.candidates.ownerAnimals[id]?.uuids?.[0] || null;
  const stableOwner = (fauna, id) => {
    const owner = fauna?.ownerAnimals?.[id];
    return owner?.count === 1
      && owner.uuids.length === 1 && owner.uuids[0] === ownerUuid(id)
      && owner.policyValid;
  };
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
  pass(focus.seenLevels.includes('mid'),
    `focus-in observes the real MID envelope root (${focus.seenLevels.join(' → ')})`);
  performance.focus = await sceneMetrics('focus');
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

  // 선택 overlay를 유지한 채 해당 청크가 fullOut 밖, midIn 안에 머물도록 카메라만 물린다.
  // 자동 focus-in을 우회하는 별도 디버그 API 없이 실제 focus regime 안에서 안정된 MID root를 잰다.
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
    // 같은 청크의 이웃 필지가 선택 필지보다 카메라 쪽에 있을 수 있으므로 fullOut보다 충분히
    // 물리되, midOut(= fullOut * 0.90/0.53) 안에는 남는 화면등가 거리로 잡는다. Focus는
    // compensated telephoto라 실제 dolly 미터에는 reference/actual lensScale을 다시 곱해야 한다.
    const desiredVisual = Math.max(1, (before?.swapOut || 140) * 1.58);
    const DEG = Math.PI / 180;
    const referenceFov = camera.userData.villageReferenceFov ?? camera.fov;
    const lensScale = Math.tan(referenceFov * DEG * 0.5) / Math.tan(camera.fov * DEG * 0.5);
    const desiredPhysical = desiredVisual * lensScale;
    const direction = camera.position.clone().sub(controls.target);
    if (direction.lengthSq() < 1e-6) direction.set(0.2, 0.55, 1);
    direction.normalize();
    controls.maxDistance = Math.max(saved.maxDistance, desiredPhysical * 1.2);
    camera.position.copy(controls.target).addScaledVector(direction, desiredPhysical);
    camera.lookAt(controls.target);
    controls.update();

    const failures = [];
    const levels = [];
    let stableMidFrames = 0;
    for (let frame = 0; frame < 16; frame++) {
      await new Promise(requestAnimationFrame);
      const all = engine.village.debugLod();
      const state = all.parcels.find((parcel) => parcel.parcelId === parcelId);
      levels.push({ level: state?.level, distance: state?.distance });
      const bad = all.parcels.filter((parcel) => {
        const roots = Number(parcel.farRootVisible)
          + Number(parcel.midRootVisible) + Number(parcel.fullRootVisible);
        return !parcel.valid || parcel.representations !== 1 || roots !== 1;
      });
      if (bad.length) failures.push({ frame, ids: bad.slice(0, 8).map((parcel) => parcel.parcelId) });
      stableMidFrames = state?.level === 'mid' ? stableMidFrames + 1 : 0;
      if (stableMidFrames >= 3) break;
    }
    const mid = engine.village.debugLod(parcelId);
    const calls = engine.village.debugDrawCalls();
    const metrics = {
      calls,
      triangles: engine.renderer.info.render.triangles,
      programs: engine.renderer.info.programs?.length ?? 0,
      geometries: engine.renderer.info.memory.geometries,
      textures: engine.renderer.info.memory.textures,
    };

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
      desiredVisual, desiredPhysical, lensScale,
      levels, stableMidFrames, mid, restored, failures, metrics,
    };
  }, first);
  pass(midProbe.stableMidFrames >= 3 && midProbe.mid?.level === 'mid'
      && midProbe.mid?.valid && midProbe.failures.length === 0,
  `MID probe stabilizes without ownership gaps (${JSON.stringify(midProbe.levels)})`);
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
  await page.evaluate(() => new Promise((resolveFrame) => {
    requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)));
  }));
  performance.focusOut = await sceneMetrics('focus-out');
  performance.aerial = { ...performance.focusOut };
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
      const ambientQuiet = state.ambient?.near === 0 && state.ambient?.mid === 0
        && state.ambient?.retiring === 0 && state.ambient?.maxStrength <= 0.002
        && state.ambient?.smokeFade <= 0.02;
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

  // 규모 변경 웨이브는 근접 카메라에서 부감으로 재프레이밍한다. 따라서 미리 예열된
  // 필지로 다시 들어간 뒤 공개 setOpts 경로를 탄다. 이 시작점이 있어야 소동물이
  // 근접에서 깨어났다가 시야가 높아지며 자는 실제 전환을 한 흐름에서 검증할 수 있다.
  const waveFocus = await traceTransition('focus', first, {
    immediateIds: [first], finalIds: [first], finalSelected: first,
  });
  pass(waveFocus.finished && waveFocus.failures.length === 0,
    'scale-wave fixture starts from a valid focused parcel');

  const wave = await page.evaluate(async (timeoutMs) => {
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
    engine.village.setOpts({ scale: 'town' }, { wave: true });
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
        // 웨이브가 아직 조립하지 않은 청크는 0개가 정상이다. 둘 이상이거나 보이는 루트가
        // 현재 정책 level과 다르면 새 핸들 승격 때 한 프레임 중복/팝이 생긴다.
        if (visible > 1 || (visible === 1 && !matching)) {
          record({ phase, chunkId: state.chunkId, level: state.level, visible });
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
        : root.name === 'village-town' ? 'new' : null;
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
        const probe = { time: 'night', season: 'winter', weather: 'rain' };
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
  }, timeout - 10_000);
  pass(wave.oldScale === 'hanyang' && wave.finalScale === 'town'
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
      profile.matched = profile.visible
        && Math.abs(profile.motesIntensity - 0.5) < 1e-6
        && profile.motesColor === 0xcdd8f0
        // The smoke presence gate deliberately keeps a just-revealed house clear for 1.4s;
        // an immediate emitter here would be the visual pop this lifecycle is meant to avoid.
        && profile.smokeSprites === 0 && profile.smokeColors.length === 0
        && Math.abs(profile.sunIntensity - 0.9) < 1e-6
        && profile.sunColor === 0x9fb4d9
        && profile.sunDirection?.every((value, index) => Math.abs(value - targetDir[index]) < 1e-6)
        // Weather remains scene-level and visible in village mode. A snow→clear change keeps
        // its atmospheric fade instead of snapping on exit, while the hidden time/season layers
        // above settle immediately.
        && Number.isFinite(profile.fogColor)
        && Math.abs(profile.fogNear - 60) < 1e-6
        && profile.fogFar > 0 && profile.fogFar <= 400
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
  pass(waveExit.before.scale === 'town' && waveExit.before.roots.length === 1
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

  console.log(`PERF  aerial   calls=${performance.aerial.calls} triangles=${performance.aerial.triangles}`);
  console.log(`PERF  mid      calls=${performance.mid.calls} triangles=${performance.mid.triangles}`);
  console.log(`PERF  focus    calls=${performance.focus.calls} triangles=${performance.focus.triangles}`);
  console.log(`PERF  focusOut calls=${performance.focusOut.calls} triangles=${performance.focusOut.triangles}`);

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
