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
  // #2 지형 밀착 indexed 도로(전 tier) + 한양 성곽·접근로·식생 footprint의 의도된 geometry 변경.
  village: '587bc27c:e590aea8:092552fb:cd112f24',
  town: '2d862954:41440794:037ab6d6:e92a4a90',
  capital: '6bf3408d:32fc031d:6dd3f0e1:f0941a89',
  hanyang: 'de2fe8ee:d17ea404:7a8f2eb9:7f587cb2',
};
const expectedProxyHashes = {
  village: '28774cfe',
  town: '9f4da67b',
  capital: '0032c3e8',
  hanyang: 'de9f7c23',
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
  browser = await chromium.launch();

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
      ] = await Promise.all([
        import('/src/village/adapter.js'),
        import('/tools/lib/hash-three-group.mjs'),
        import('/src/core/three-resources.js'),
        import('/src/village/citywall-contour.js'),
        import('/src/village/forest-crunch.js'),
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
      const wallVegetationContract = (handle) => {
        const wall = handle.plan.features?.cityWall;
        if (!wall) return { pass: true, checked: 0, failures: [] };
        let checked = 0;
        const failures = [];
        handle.group.traverse((object) => {
          if (!object.isInstancedMesh || !['forest-pine', 'forest-broad', 'forest-far', 'forest-rocks'].includes(object.name)) return;
          const array = object.instanceMatrix.array;
          for (let i = 0; i < object.count; i++) {
            const o = i * 16;
            const point = { x: array[o + 12], z: array[o + 14] };
            const sx = Math.hypot(array[o], array[o + 1], array[o + 2]);
            const sz = Math.hypot(array[o + 8], array[o + 9], array[o + 10]);
            const factor = object.name === 'forest-pine' ? FOREST_VISUAL_RADIUS.pine
              : object.name === 'forest-broad' ? FOREST_VISUAL_RADIUS.broad
                : object.name === 'forest-far' ? FOREST_VISUAL_RADIUS.far
                  : FOREST_VISUAL_RADIUS.rock;
            const radius = Math.max(sx, sz) * factor;
            const blocked = cityWallVegetationBlocked(wall, point, {
              corridor: radius + CITY_WALL_DIMENSIONS.vegetationClearance,
              gateMargin: radius + CITY_WALL_DIMENSIONS.gateVegetationMargin,
              gateApproachMargin: radius,
            });
            checked++;
            if (blocked && failures.length < 8) failures.push({ name: object.name, index: i, radius, x: point.x, z: point.z });
          }
        });
        for (const [index, anchor] of (handle.group.userData.guardianAnchors || []).entries()) {
          const radius = anchor.r || 0;
          const blocked = cityWallVegetationBlocked(wall, anchor, {
            corridor: radius + CITY_WALL_DIMENSIONS.vegetationClearance,
            gateMargin: radius + CITY_WALL_DIMENSIONS.gateVegetationMargin,
            gateApproachMargin: radius,
          });
          checked++;
          if (blocked && failures.length < 8) failures.push({
            name: 'flora-guardian', index, radius, x: anchor.x, z: anchor.z,
          });
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
        const vegetation = wallVegetationContract(sync);
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
      const pass = item.equal && stepsEqual && baselineEqual && proxyApiPass && item.lifecyclePass && item.vegetation.pass;
      failed ||= !pass;
      console.log(`${item.scale.padEnd(9)} ${pass ? 'PASS' : 'FAIL'}  ${item.syncHash.hash}  proxy=${item.syncProxyHash.hash}`);
      if (!item.equal) console.log(`          async ${item.asyncHash.hash}  proxy=${item.asyncProxyHash.hash}`);
      if (!baselineEqual) {
        console.log(`          expected ${expectedSceneHashes[item.scale]}  proxy=${expectedProxyHashes[item.scale]}`);
      }
      if (!stepsEqual) console.log(`          steps ${JSON.stringify(item.steps)}`);
      if (!proxyApiPass) console.log('          getPickProxy descriptor parity/isolation contract failed');
      if (!item.lifecyclePass) {
        console.log(`          lifecycle sync=${JSON.stringify(item.syncLifecycle)} async=${JSON.stringify(item.asyncLifecycle)} inactive=${item.inactive}`);
      }
      if (!item.vegetation.pass) console.log(`          wall vegetation ${JSON.stringify(item.vegetation)}`);
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
