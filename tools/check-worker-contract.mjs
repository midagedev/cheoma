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
  village: '533a5367:8911e1f5:0ac7c5b4:af16cc1d',
  town: '7fb03ffe:7a276f00:7c244fdb:ed313cb8',
  capital: 'c38e38af:7093d979:d99406d9:d6977201',
  hanyang: 'e9cd6e0c:4591809c:ae783181:a4af5014',
};
const expectedProxyHashes = {
  village: '28774cfe',
  town: '9f4da67b',
  capital: '0032c3e8',
  hanyang: '64a3ef9e',
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

      const [{ createVillage, createVillageAsync }, { hashThreeGroup, hashVillagePickProxies }] = await Promise.all([
        import('/src/village/adapter.js'),
        import('/tools/lib/hash-three-group.mjs'),
      ]);
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
        cases.push({
          scale,
          equal: syncHash.hash === asyncHash.hash && syncProxyHash.hash === asyncProxyHash.hash,
          syncHash,
          asyncHash,
          syncProxyHash,
          asyncProxyHash,
          steps,
        });
        sync.dispose();
        asyncHandle.dispose();
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
      const pass = item.equal && stepsEqual && baselineEqual;
      failed ||= !pass;
      console.log(`${item.scale.padEnd(9)} ${pass ? 'PASS' : 'FAIL'}  ${item.syncHash.hash}  proxy=${item.syncProxyHash.hash}`);
      if (!item.equal) console.log(`          async ${item.asyncHash.hash}  proxy=${item.asyncProxyHash.hash}`);
      if (!baselineEqual) {
        console.log(`          expected ${expectedSceneHashes[item.scale]}  proxy=${expectedProxyHashes[item.scale]}`);
      }
      if (!stepsEqual) console.log(`          steps ${JSON.stringify(item.steps)}`);
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
