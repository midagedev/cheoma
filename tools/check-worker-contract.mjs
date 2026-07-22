// 전체 village scene graph 계약: sync, async worker, async fallback이 같은 결과를 만들어야 한다.
// Vite를 독립 cacheDir로 직접 띄워 실제 module Worker 변환과 메시지 왕복까지 검사한다.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from '../app/node_modules/vite/dist/node/index.js';

const ROOT = resolve(import.meta.dirname, '..');
const cacheDir = await mkdtemp(join(tmpdir(), 'cheoma-worker-contract-'));
const threeMain = join(ROOT, 'app/node_modules/three/build/three.module.js');
const threeAddons = join(ROOT, 'app/node_modules/three/examples/jsm/');
const html = '<!doctype html><meta charset="utf-8"><title>worker contract</title>';
const expectedSteps = [
  'plan', 'setup+clearance', 'terrain', 'mist+water', 'roads+paddy', 'parcels/houses',
  'features+wall+sijeon', 'merges', 'trees', 'forest', 'flora',
  'animals+night+bloom+cloudshadow',
];
const expectedSceneHashes = {
  // #12: the variable rectangular precinct is reserved before parcels and
  // vegetation, then rendered as the compact/courtyard/extended TemplePlan.
  // #49 extends the solar/focus-frame contract to pavilion eaves and feature
  // props. #13 replaces overlapping rectangular giwa podiums with one concave
  // solid and sinks every building foundation. #21 reserves a monotonically
  // graded stream valley and adds the visible five-lane water ribbon. #40 adds
  // metre-scale settlement relief to every tier; explicit river mode remains a
  // separate non-golden scenario. #56 gives temple roles distinct dancheong
  // palettes; #8 retains four giwa groups but changes their exact geometry to
  // ㅡ + mirrored ㄱ + fitted four-bay ㄷ. Sync, real module Worker, and
  // ?worker=0 fallback stay byte-identical after both changes.
  village: '820a1338:95d7b6f6:36ceed54:15357fa2',
  town: '993c3ab1:746f1801:97d2b468:c9cebe39',
  capital: '87ec65e8:b24242a4:a11e9d66:f919de6a',
  hanyang: 'd40f114e:99a94ab4:2a596b17:d3163dc2',
};
const expectedProxyHashes = {
  // #22 visibility uses #8's fitted roof OBBs plus planned feature blockers.
  // #56's palace/temple dancheong edit axes remain in the proxy contract. #8 also
  // exposes the authored giwa bay width so the shape-aware editor can start at
  // the first effective mainHalfW rather than presenting a dead slider range.
  village: '0ad40baa',
  town: 'ac44cf8c',
  capital: '5ec8ed67',
  hanyang: '7db20a4b',
};

const server = await createServer({
  appType: 'custom',
  cacheDir,
  configFile: false,
  root: ROOT,
  logLevel: 'error',
  plugins: [{
    name: 'worker-contract-page',
    configureServer(vite) {
      vite.middlewares.use('/__worker-contract', (_req, response) => {
        response.setHeader('content-type', 'text/html; charset=utf-8');
        response.end(html);
      });
    },
  }],
  resolve: {
    alias: [
      { find: /^three\/addons\//, replacement: threeAddons },
      { find: /^three$/, replacement: threeMain },
    ],
    dedupe: ['three'],
  },
  optimizeDeps: { noDiscovery: true },
  server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false },
});

let browser;
let failed = false;
try {
  await server.listen();
  const address = server.httpServer.address();
  const base = `http://127.0.0.1:${address.port}`;
  // Scene/proxy goldens are cross-path determinism bytes, not a render benchmark. Keep the
  // Playwright-pinned JS/browser runtime here; system Chrome versions can legitimately round
  // generated Float32 data differently even when worker and sync still agree with each other.
  browser = await chromium.launch();
  console.log('[verification-browser] browser=chromium mode=pinned-worker-goldens');

  async function compare(mode) {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(`page: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(`console: ${message.text()}`);
    });
    await page.goto(`${base}/__worker-contract${mode === 'fallback' ? '?worker=0' : ''}`, {
      waitUntil: 'domcontentloaded',
      timeout: 90_000,
    });

    const result = await page.evaluate(async () => {
      const NativeWorker = window.Worker;
      const workerStats = { started: 0, succeeded: 0, failed: 0 };
      window.Worker = class ContractWorker extends NativeWorker {
        constructor(...args) {
          super(...args);
          workerStats.started++;
          this.addEventListener('message', (event) => {
            if (event.data?.ok) workerStats.succeeded++;
            else workerStats.failed++;
          });
          this.addEventListener('error', () => workerStats.failed++);
        }
      };

      const [
        { createVillage, createVillageAsync },
        { hashThreeGroup, hashVillagePickProxies },
        { isSharedResource },
        { CITY_WALL_DIMENSIONS, cityWallVegetationBlocked },
        { FOREST_VISUAL_RADIUS },
        { VILLAGE_LENS, dollyScaleForFov },
        { makeVegetationMask, yardCanopyBlocked },
        { parcelLocalPoint },
        { yardHardObstacles, yardTreeIntersectsHardObstacle },
        { SCATTER_TREE_VISUAL_RADIUS },
      ] = await Promise.all([
        import('/src/village/adapter.js'),
        import('/tools/lib/hash-three-group.mjs'),
        import('/src/core/three-resources.js'),
        import('/src/village/citywall-contour.js'),
        import('/src/village/forest-crunch.js'),
        import('/src/camera/optics.js'),
        import('/src/village/vegetation-spatial.js'),
        import('/src/village/parcel-contract.js'),
        import('/src/village/yard-layout.js'),
        import('/src/generators/village/trees.js'),
      ]);
      const probeLifecycle = (handle) => {
        const owned = new Set();
        const shared = new Set();
        const add = (resource) => {
          if (!resource?.dispose) return;
          (isSharedResource(resource) ? shared : owned).add(resource);
        };
        const addMaterial = (material) => {
          if (!material) return;
          add(material);
          for (const value of Object.values(material)) if (value?.isTexture) add(value);
          for (const uniform of Object.values(material.uniforms || {})) {
            const value = uniform?.value;
            if (value?.isTexture) add(value);
            else if (Array.isArray(value)) for (const item of value) if (item?.isTexture) add(item);
          }
        };
        const addObject = (object) => {
          add(object.geometry);
          const materials = Array.isArray(object.material)
            ? object.material
            : (object.material ? [object.material] : []);
          for (const material of materials) addMaterial(material);
        };
        handle.group.traverse(addObject);
        for (const proxy of handle.getPickProxies()) addObject(proxy.mesh);
        const counts = new Map();
        let sharedDisposals = 0;
        const onOwned = (event) => counts.set(event.target, (counts.get(event.target) || 0) + 1);
        const onShared = () => { sharedDisposals++; };
        for (const resource of owned) resource.addEventListener('dispose', onOwned);
        for (const resource of shared) resource.addEventListener('dispose', onShared);
        return {
          finish() {
            for (const resource of owned) resource.removeEventListener('dispose', onOwned);
            for (const resource of shared) resource.removeEventListener('dispose', onShared);
            return {
              owned: owned.size,
              disposed: counts.size,
              duplicates: [...counts.values()].filter((count) => count !== 1).length,
              duplicateDetails: [...counts.entries()]
                .filter(([, count]) => count !== 1)
                .slice(0, 8)
                .map(([resource, count]) => ({ type: resource.type || resource.constructor?.name, name: resource.name || '', count })),
              shared: shared.size,
              sharedDisposals,
            };
          },
        };
      };
      const postDisposeInactive = (handle) => {
        const scene = new handle.group.constructor();
        let beforeObjects = 0;
        handle.group.traverse(() => { beforeObjects++; });
        const parcelId = handle.plan.parcels[0]?.id;
        handle.enterVillageMode({ scene });
        handle.debugShowProxies(true);
        const detail = handle.showParcelDetail(parcelId);
        let afterObjects = 0;
        handle.group.traverse(() => { afterObjects++; });
        return scene.children.length === 0
          && beforeObjects === afterObjects
          && detail === null
          && handle.getPickProxy(parcelId) === null
          && handle.getPickProxies().length === 0
          && handle.updateLod(null) === 0;
      };
      const vegetationContract = (handle) => {
        const wall = handle.plan.features?.cityWall;
        const mask = makeVegetationMask(handle.plan, handle.plan.site);
        let checked = 0;
        const failures = [];
        handle.group.traverse((object) => {
          if (!object.isInstancedMesh || ![
            'forest-pine', 'forest-broad', 'forest-far', 'forest-rocks',
            'scatter-pine', 'scatter-broad',
          ].includes(object.name)) return;
          const array = object.instanceMatrix.array;
          for (let i = 0; i < object.count; i++) {
            const o = i * 16;
            const point = { x: array[o + 12], z: array[o + 14] };
            const sx = Math.hypot(array[o], array[o + 1], array[o + 2]);
            const sz = Math.hypot(array[o + 8], array[o + 9], array[o + 10]);
            const factor = object.name === 'forest-pine' ? FOREST_VISUAL_RADIUS.pine
              : object.name === 'forest-broad' ? FOREST_VISUAL_RADIUS.broad
                : object.name === 'forest-far' ? FOREST_VISUAL_RADIUS.far
                  : object.name === 'forest-rocks' ? FOREST_VISUAL_RADIUS.rock
                    : object.name === 'scatter-pine' ? SCATTER_TREE_VISUAL_RADIUS.pine
                      : SCATTER_TREE_VISUAL_RADIUS.broad;
            const radius = Math.max(sx, sz) * factor;
            const blockedByLayout = mask(point.x, point.z, radius);
            const blockedByWall = wall && cityWallVegetationBlocked(wall, point, {
              corridor: radius + CITY_WALL_DIMENSIONS.vegetationClearance,
              gateMargin: radius + CITY_WALL_DIMENSIONS.gateVegetationMargin,
              gateApproachMargin: radius,
            });
            checked++;
            if ((blockedByLayout || blockedByWall) && failures.length < 8) failures.push({
              name: object.name, index: i, radius, x: point.x, z: point.z,
              blockedByLayout, blockedByWall: !!blockedByWall,
            });
          }
        });
        for (const [index, anchor] of (handle.group.userData.guardianAnchors || []).entries()) {
          const radius = anchor.r || 0;
          const blocked = wall && cityWallVegetationBlocked(wall, anchor, {
            corridor: radius + CITY_WALL_DIMENSIONS.vegetationClearance,
            gateMargin: radius + CITY_WALL_DIMENSIONS.gateVegetationMargin,
            gateApproachMargin: radius,
          });
          checked++;
          if (blocked && failures.length < 8) failures.push({
            name: 'flora-guardian', index, radius, x: anchor.x, z: anchor.z,
          });
        }
        const parcelById = new Map(handle.plan.parcels.map((parcel) => [parcel.id, parcel]));
        for (const [index, anchor] of (handle.group.userData.yardTreeAnchors || []).entries()) {
          const parcel = parcelById.get(anchor.parcelId);
          const local = parcel && parcelLocalPoint(parcel, anchor);
          const gardenOptions = Number.isFinite(anchor.hwagyeX)
            ? { exact: true, side: anchor.gardenSide, hwagyeX: anchor.hwagyeX }
            : undefined;
          const blocked = !parcel || !(anchor.radius > 0)
            || !(anchor.trunkRadius > 0)
            || yardCanopyBlocked(parcel, local, anchor.radius)
            || mask.spatial.blocksYardCanopy(anchor.x, anchor.z, anchor.radius)
            || yardTreeIntersectsHardObstacle(local, {
              canopyRadius: anchor.radius,
              trunkRadius: anchor.trunkRadius,
            }, yardHardObstacles(parcel, gardenOptions));
          checked++;
          if (blocked && failures.length < 8) failures.push({
            name: 'flora-yard', index, parcelId: anchor.parcelId,
            radius: anchor.radius, x: anchor.x, z: anchor.z,
          });
        }
        const plannedGuardians = handle.plan.features?.guardianTrees || [];
        const renderedGuardians = handle.group.userData.guardianAnchors || [];
        if (plannedGuardians.length !== renderedGuardians.length && failures.length < 8) {
          failures.push({
            name: 'flora-guardian-count',
            planned: plannedGuardians.length,
            rendered: renderedGuardians.length,
          });
        }
        return { pass: failures.length === 0, checked, failures };
      };
      const landmarkLensContract = (handle, { requirePalace = false, requireTemple = true } = {}) => {
        const DEG = Math.PI / 180;
        const failures = [];
        let checked = 0;
        const specs = [
          { id: 'palace', profile: VILLAGE_LENS.palace, fit: 1.12, padding: 0.12, targetLift: 3.2, required: requirePalace },
          { id: 'temple', profile: VILLAGE_LENS.temple, fit: 1.16, padding: 0.14, targetLift: 3, required: requireTemple },
        ];
        for (const spec of specs) {
          const proxy = handle.getPickProxy(spec.id);
          if (!proxy) {
            if (spec.required) failures.push({ id: spec.id, reason: 'missing' });
            continue;
          }
          checked++;
          const framing = proxy.cameraFraming;
          const extent = Math.max(proxy.dims.x, proxy.dims.z);
          const expectedReferenceDistance = (extent * 0.5)
            / Math.tan(spec.profile.referenceFov * 0.5 * DEG) * spec.fit
            + extent * spec.padding;
          const physicalDistance = framing.position.distanceTo(framing.target);
          const scale = dollyScaleForFov(spec.profile.referenceFov, spec.profile.fov);
          const screenEquivalentDistance = physicalDistance / scale;
          const referencePreserved = framing.referenceFov === spec.profile.referenceFov;
          const fovPreserved = framing.fov === spec.profile.fov;
          const compositionPreserved = Math.abs(screenEquivalentDistance - expectedReferenceDistance) <= 1e-8;
          const targetLift = framing.target.y - proxy.worldCenter.y;
          const doorTargetPreserved = Math.abs(targetLift - spec.targetLift) <= 1e-8;
          if (!referencePreserved || !fovPreserved || !compositionPreserved || !doorTargetPreserved) {
            failures.push({
              id: spec.id,
              fov: framing.fov,
              referenceFov: framing.referenceFov,
              screenEquivalentDistance,
              expectedReferenceDistance,
              targetLift,
              expectedTargetLift: spec.targetLift,
            });
          }
        }
        return { pass: failures.length === 0, checked, failures };
      };
      const scales = ['village', 'town', 'capital', 'hanyang'];
      const cases = [];
      for (const scale of scales) {
        const opts = { scale, seed: 20260716, includeTemple: true };
        const sync = createVillage(opts);
        const steps = [];
        const asyncHandle = await createVillageAsync(opts, {
          budgetMs: 8,
          nextFrame: (callback) => requestAnimationFrame(callback),
          onStep: (label) => steps.push(label),
        });
        const syncHash = hashThreeGroup(sync.group);
        const asyncHash = hashThreeGroup(asyncHandle.group);
        const syncProxyHash = hashVillagePickProxies(sync);
        const asyncProxyHash = hashVillagePickProxies(asyncHandle);
        const vegetation = vegetationContract(sync);
        const lensRequirements = { requirePalace: scale === 'hanyang', requireTemple: true };
        const syncLandmarkLenses = landmarkLensContract(sync, lensRequirements);
        const asyncLandmarkLenses = landmarkLensContract(asyncHandle, lensRequirements);
        const syncProbe = probeLifecycle(sync);
        const asyncProbe = probeLifecycle(asyncHandle);
        sync.dispose();
        sync.dispose();
        asyncHandle.dispose();
        asyncHandle.dispose();
        const inactive = postDisposeInactive(sync) && postDisposeInactive(asyncHandle);
        const syncLifecycle = syncProbe.finish();
        const asyncLifecycle = asyncProbe.finish();
        const lifecyclePass = [syncLifecycle, asyncLifecycle].every((result) => (
          result.owned > 0
          && result.disposed === result.owned
          && result.duplicates === 0
          && result.sharedDisposals === 0
        )) && inactive;
        cases.push({
          scale,
          equal: syncHash.hash === asyncHash.hash && syncProxyHash.hash === asyncProxyHash.hash,
          syncHash,
          asyncHash,
          syncProxyHash,
          asyncProxyHash,
          steps,
          lifecyclePass,
          syncLifecycle,
          asyncLifecycle,
          inactive,
          vegetation,
          syncLandmarkLenses,
          asyncLandmarkLenses,
        });
      }
      return { cases, workerStats };
    });
    await page.close();
    return { ...result, errors };
  }

  for (const mode of ['worker', 'fallback']) {
    const result = await compare(mode);
    console.log(`\n${mode === 'worker' ? 'async worker' : 'async fallback (?worker=0)'}`);
    for (const item of result.cases) {
      const stepsEqual = JSON.stringify(item.steps) === JSON.stringify(expectedSteps);
      const baselineEqual = item.syncHash.hash === expectedSceneHashes[item.scale]
        && item.syncProxyHash.hash === expectedProxyHashes[item.scale];
      const proxyApiPass = item.syncProxyHash.singleContract && item.asyncProxyHash.singleContract;
      const landmarkLensPass = item.syncLandmarkLenses.pass && item.asyncLandmarkLenses.pass;
      const pass = item.equal && stepsEqual && baselineEqual && proxyApiPass && landmarkLensPass
        && item.lifecyclePass && item.vegetation.pass;
      failed ||= !pass;
      console.log(`${item.scale.padEnd(9)} ${pass ? 'PASS' : 'FAIL'}  ${item.syncHash.hash}  proxy=${item.syncProxyHash.hash}`);
      if (!item.equal) console.log(`          async ${item.asyncHash.hash}  proxy=${item.asyncProxyHash.hash}`);
      if (!baselineEqual) {
        console.log(`          expected ${expectedSceneHashes[item.scale]}  proxy=${expectedProxyHashes[item.scale]}`);
      }
      if (!stepsEqual) console.log(`          steps ${JSON.stringify(item.steps)}`);
      if (!proxyApiPass) console.log('          getPickProxy descriptor parity/isolation contract failed');
      if (!landmarkLensPass) {
        console.log(`          landmark lenses sync=${JSON.stringify(item.syncLandmarkLenses)} async=${JSON.stringify(item.asyncLandmarkLenses)}`);
      }
      if (!item.lifecyclePass) {
        console.log(`          lifecycle sync=${JSON.stringify(item.syncLifecycle)} async=${JSON.stringify(item.asyncLifecycle)} inactive=${item.inactive}`);
      }
      if (!item.vegetation.pass) console.log(`          vegetation ${JSON.stringify(item.vegetation)}`);
    }
    const workerPass = mode === 'worker'
      ? result.workerStats.started === 1
        && result.workerStats.succeeded === result.cases.length
        && result.workerStats.failed === 0
      : result.workerStats.started === 0;
    failed ||= !workerPass || result.errors.length > 0;
    console.log(`worker messages: ${JSON.stringify(result.workerStats)} ${workerPass ? 'PASS' : 'FAIL'}`);
    for (const error of result.errors) console.error(error);
  }
} finally {
  await browser?.close();
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
}

if (failed) {
  console.error('\nWORKER CONTRACT: FAIL');
  process.exitCode = 1;
} else {
  console.log('\nWORKER CONTRACT: PASS');
}
