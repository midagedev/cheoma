// #114 외딴집·절단독 populate 레벨 스모크 — 렌더 캡처 없음, 전용 포트 4230, dev 서버(5174) 불침해.
//   planVillage + populateVillage 를 esbuild 번들로 헤드리스 크로미움에서 실행(palette 가 canvas 필요).
//   ① siteR30: populate 무예외·집 1채(hero hanok)·지형 메시 존재 ② siteR40+houses:0+절: 필지 0·절 지오 존재
//   ③ pageerror 0.
//   실행: node tools/verify-solo-app.mjs
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const reqApp = createRequire(join(ROOT, 'app', 'package.json'));
const reqTools = createRequire(join(ROOT, 'tools', 'package.json'));
const esbuild = reqApp('esbuild');
const { chromium } = reqTools('playwright');

const THREE_MAIN = join(ROOT, 'app/node_modules/three/build/three.module.js');
const THREE_ADDONS = join(ROOT, 'app/node_modules/three/examples/jsm');
const PORT = 4230;

const ENTRY = `
import { planVillage } from '${ROOT}/src/village/plan.js';
import { populateVillage } from '${ROOT}/src/village/populate.js';

window.__run = async () => {
  const out = { cases: [] };
  const run = (label, planOpts) => {
    const c = { label };
    try {
      const plan = planVillage(planOpts);
      c.houses = plan.stats.houses;
      c.hero = plan.parcels.filter((p) => p.hero).length;
      c.heroStyle = plan.parcels.find((p) => p.hero)?.heroStyle ?? null;
      c.temple = !!plan.features?.temple;
      const root = populateVillage(plan, {});
      let terrain = 0, templeGeo = 0, meshes = 0;
      root.traverse((o) => {
        if (o.isMesh || o.isInstancedMesh) meshes++;
        const n = (o.name || '').toLowerCase();
        if (n.includes('terrain') || n.includes('site')) terrain++;
        if (n.includes('temple') || n.includes('landmark')) templeGeo++;
      });
      c.meshes = meshes; c.terrain = terrain; c.templeGeo = templeGeo;
      c.userDataKeys = Object.keys(root.userData || {}).length;
      c.heroHandle = root.userData.heroHandle ? root.userData.heroHandle.size : -1;
    } catch (e) { c.err = String(e && e.stack || e); }
    out.cases.push(c);
  };
  run('solo-R30', { siteR: 30, seed: 20260716 });
  run('solo-R30-seed2', { siteR: 30, seed: 777 });
  run('temple-only-R40', { siteR: 40, seed: 20260716, houses: 0, includeTemple: true });
  run('duo-R38', { siteR: 38, seed: 20260716 });
  return out;
};
window.__READY = true;
`;

const BUNDLE = (await esbuild.build({
  stdin: { contents: ENTRY, resolveDir: ROOT, loader: 'js' },
  bundle: true, format: 'esm', write: false,
  alias: { three: THREE_MAIN, 'three/addons': THREE_ADDONS },
})).outputFiles[0].text;

const PAGE = `<!doctype html><html><body><script type="module" src="/bundle.js"></script></body></html>`;

const server = createServer((req, res) => {
  if (req.url === '/' || req.url.startsWith('/index')) { res.setHeader('content-type', 'text/html'); res.end(PAGE); return; }
  if (req.url.startsWith('/bundle.js')) { res.setHeader('content-type', 'text/javascript'); res.end(BUNDLE); return; }
  res.statusCode = 404; res.end('nf');
});
await new Promise((r) => server.listen(PORT, r));

const pageErrors = [];
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (e) => pageErrors.push(String(e && e.stack || e)));
page.on('console', (m) => { if (m.type() === 'error') pageErrors.push('[console] ' + m.text()); });

let results = null, fatal = null;
try {
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction('window.__READY === true', { timeout: 60000 });
  results = await page.evaluate(async () => await window.__run(), { timeout: 240000 });
} catch (e) { fatal = String(e && e.stack || e); }

await browser.close();
await new Promise((r) => server.close(r));

let fails = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) fails++; };
if (fatal) { console.log('FATAL', fatal); process.exit(1); }

for (const c of results.cases) {
  if (c.err) { ok(false, `${c.label}: populate 예외 — ${c.err.split('\n')[0]}`); continue; }
  console.log(`--- ${c.label}: houses=${c.houses} hero=${c.hero}(${c.heroStyle}) meshes=${c.meshes} terrain=${c.terrain} templeGeo=${c.templeGeo} heroHandle=${c.heroHandle}`);
  if (c.label.startsWith('solo-R30')) {
    ok(c.houses === 1 && c.hero === 1 && c.heroStyle === 'hanok', `${c.label}: 집 1채 = hero hanok 종가`);
    ok(c.terrain > 0 && c.meshes > 3, `${c.label}: 지형·지오 생성`);
  }
  if (c.label === 'temple-only-R40') {
    ok(c.houses === 0 && c.temple, `${c.label}: 필지 0 + 절 feature`);
    ok(c.templeGeo > 0, `${c.label}: 절 지오 존재 (실측 ${c.templeGeo})`);
  }
  if (c.label === 'duo-R38') ok(c.houses >= 1 && c.hero === 1, `${c.label}: 소촌락 성립 (${c.houses}채)`);
}
ok(pageErrors.length === 0, `pageerror 0 (실측 ${pageErrors.length})`);
if (pageErrors.length) console.log(pageErrors.slice(0, 3).join('\n'));
console.log(fails === 0 ? '\nVERIFY-SOLO-APP: ALL PASS' : `\nVERIFY-SOLO-APP: ${fails} FAIL`);
process.exit(fails === 0 ? 0 : 1);
