// 시네마틱 데모 코어(#103) 수치 검증 — 렌더 캡처 없음, 수치 단언만.
//   실행: NODE_PATH=/Users/hckim/repo/threesur/node_modules node tools/verify-cine.mjs
//   방식: esbuild 로 createVillage + createDronePaths + createWalker 를 브라우저 번들로 묶어
//         포트 4219 로 서빙 → headless chromium 에서 window.__RESULT 산출(순수 수치) → 표·게이트.
//
// 게이트:
//   드론 4패스 × 3규모: (a) 지형 클리어런스 min > 1.5m  (b) 건물 관통 0  (c) flythrough 지붕 위 <2m 0
//                       (d) lookAt 각속도 max < 60 deg/s
//   walker 100초 자동산책 × 3규모: 지면 침하 0(발 클리어런스>0)·담 관통 0·경계 이탈 0·결정론(재현 delta≈0)
//   드론 결정론(파이프라인): 같은 시드 → 같은 경로(샘플 delta≈0). pageerror 0.

import { createServer } from 'node:http';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const { chromium } = require('playwright');

const ROOT = resolve(import.meta.dirname, '..');
const PORT = 4219;
const threeMain = join(ROOT, 'app/node_modules/three/build/three.module.js');
const threeAddons = join(ROOT, 'app/node_modules/three/examples/jsm/');

// bare 'three' 및 'three/addons/*' 를 앱 설치본으로(vite.config 와 동일 규약).
const threeAlias = {
  name: 'three-alias',
  setup(b) {
    b.onResolve({ filter: /^three$/ }, () => ({ path: threeMain }));
    b.onResolve({ filter: /^three\/addons\// }, (args) => ({ path: join(threeAddons, args.path.slice('three/addons/'.length)) }));
  },
};

const ENTRY = `
import { createVillage } from './src/village/adapter.js';
import { createDronePaths, buildObstacles, roofTopAt } from './src/cinematic/dronepath.js';
import { createWalker } from './src/cinematic/walker.js';

const RAD2DEG = 180 / Math.PI;
function dirOf(p, l){ const dx=l.x-p.x, dy=l.y-p.y, dz=l.z-p.z; const m=Math.hypot(dx,dy,dz)||1; return [dx/m,dy/m,dz/m]; }
function angBetween(a,b){ let d=a[0]*b[0]+a[1]*b[1]+a[2]*b[2]; d=Math.min(1,Math.max(-1,d)); return Math.acos(d); }

const SCALES = [
  { name:'village', opts:{ scale:'village', includePalace:false, includeTemple:true, seed:2026 } },
  { name:'capital', opts:{ scale:'capital', includePalace:true,  includeTemple:true, seed:2026 } },
  { name:'hanyang', opts:{ scale:'hanyang', includePalace:true,  includeTemple:true, seed:2026 } },
];
const N = 240;

function droneCheck(plan, site, H){
  const paths = createDronePaths({ site, plan, heightAt: H, seed: 2026 });
  const obs = buildObstacles(plan, H);
  const rows = [];
  for (const p of paths){
    let minClear = Infinity, penetrate = 0, below2 = 0, maxAng = 0, prev = null;
    const dt = p.duration / (N - 1);
    for (let i = 0; i < N; i++){
      const s = p.sample(i / (N - 1));
      const clr = s.pos.y - H(s.pos.x, s.pos.z);
      if (clr < minClear) minClear = clr;
      const rt = roofTopAt(obs, s.pos.x, s.pos.z);
      if (rt != null){
        if (s.pos.y < rt - 1e-6) penetrate++;
        if (s.pos.y < rt + 2 - 1e-6) below2++;
      }
      const d = dirOf(s.pos, s.lookAt);
      if (prev){ const a = angBetween(prev, d) * RAD2DEG / dt; if (a > maxAng) maxAng = a; }
      prev = d;
    }
    rows.push({ name:p.name, dur:+p.duration.toFixed(1), minClear:+minClear.toFixed(2), penetrate, below2, maxAng:+maxAng.toFixed(1) });
  }
  return rows;
}

function walkerCheck(plan, site, H){
  const dt = 1/60, steps = Math.round(100 / dt);
  const w = createWalker({ site, plan, heightAt: H });
  w.startAutoStroll();
  let minFoot = Infinity, collide = 0, outb = 0;
  for (let i = 0; i < steps; i++){
    w.update(dt, {});
    const fc = w.groundClearance();
    if (fc < minFoot) minFoot = fc;
    if (w.isColliding()) collide++;
    if (w.outsideBoundary()) outb++;
  }
  // 결정론: 같은 plan 재시뮬 → 종점 일치
  const w2 = createWalker({ site, plan, heightAt: H });
  w2.startAutoStroll();
  for (let i = 0; i < steps; i++) w2.update(dt, {});
  const det = Math.hypot(w.pos.x - w2.pos.x, w.pos.y - w2.pos.y, w.pos.z - w2.pos.z);
  return { minFoot:+minFoot.toFixed(3), collide, outb, det:+det.toFixed(6) };
}

export function run(){
  const out = { scales: [], walker: [], determinism: null };
  for (const sc of SCALES){
    const h = createVillage(sc.opts);
    const plan = h.plan, site = plan.site, H = site.heightAt;
    out.scales.push({
      scale: sc.name, R: Math.round(site.R), parcels: plan.parcels.length,
      palace: !!(plan.features && plan.features.palace),
      paths: droneCheck(plan, site, H),
    });
    out.walker.push({ scale: sc.name, ...walkerCheck(plan, site, H) });
    h.dispose && h.dispose();
  }
  // 파이프라인 결정론: 같은 시드 두 번 → 같은 경로 샘플
  const A = createVillage({ scale:'village', includePalace:false, includeTemple:true, seed:777 });
  const B = createVillage({ scale:'village', includePalace:false, includeTemple:true, seed:777 });
  const pa = createDronePaths({ site:A.plan.site, plan:A.plan, heightAt:A.plan.site.heightAt, seed:777 });
  const pb = createDronePaths({ site:B.plan.site, plan:B.plan, heightAt:B.plan.site.heightAt, seed:777 });
  let maxd = 0;
  for (const t of [0.13, 0.37, 0.62, 0.88]){
    for (let k = 0; k < pa.length; k++){
      const sa = pa[k].sample(t).pos, sb = pb[k].sample(t).pos;
      maxd = Math.max(maxd, Math.hypot(sa.x-sb.x, sa.y-sb.y, sa.z-sb.z));
    }
  }
  out.determinism = { droneSampleDelta: +maxd.toFixed(6) };
  A.dispose && A.dispose(); B.dispose && B.dispose();
  return out;
}

window.__RESULT = null;
try { window.__RESULT = run(); }
catch (e){ window.__RESULT = { error: String((e && e.stack) || e) }; }
`;

const built = await esbuild.build({
  stdin: { contents: ENTRY, resolveDir: ROOT, sourcefile: 'verify-cine-entry.js', loader: 'js' },
  bundle: true, format: 'esm', platform: 'browser', write: false, logLevel: 'silent',
  plugins: [threeAlias],
});
const bundle = built.outputFiles[0].text;

const HTML = '<!doctype html><meta charset="utf-8"><body><script type="module" src="/bundle.js"></script></body>';
const server = createServer((req, res) => {
  const u = req.url.split('?')[0];
  if (u === '/bundle.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(bundle); }
  else { res.writeHead(200, { 'content-type': 'text/html' }); res.end(HTML); }
});
await new Promise((ok) => server.listen(PORT, '127.0.0.1', ok));

let browser;
try { browser = await chromium.launch({ channel: 'chrome' }); }
catch { browser = await chromium.launch(); }
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
await page.waitForFunction('window.__RESULT !== null', null, { timeout: 180000 });
const R = await page.evaluate('window.__RESULT');
await browser.close();
server.close();

// ── 리포트 ──
const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);
let fail = 0;

if (R.error) { console.log('RUN ERROR:\n' + R.error); process.exit(1); }

console.log('\n=== 드론 패스 (규모 × 4패스) ===');
console.log(pad('scale', 9) + pad('R', 6) + pad('parcels', 9) + pad('palace', 8) + pad('pass', 20) + padL('dur', 6) + padL('minClear', 10) + padL('penetr', 8) + padL('roof<2', 8) + padL('maxAng°/s', 11));
for (const s of R.scales) {
  for (const p of s.paths) {
    const clOk = p.minClear > 1.5;
    const pnOk = p.penetrate === 0;
    const b2Ok = p.below2 === 0;
    const anOk = p.maxAng < 60;
    if (!(clOk && pnOk && b2Ok && anOk)) fail++;
    const flag = (clOk && pnOk && b2Ok && anOk) ? '' : '  <-- FAIL';
    console.log(
      pad(s.scale, 9) + pad(s.R, 6) + pad(s.parcels, 9) + pad(s.palace ? 'yes' : 'no', 8) +
      pad(p.name, 20) + padL(p.dur, 6) + padL(p.minClear, 10) + padL(p.penetrate, 8) +
      padL(p.below2, 8) + padL(p.maxAng, 11) + flag);
  }
}

console.log('\n=== walker 100초 자동 산책 ===');
console.log(pad('scale', 9) + padL('minFootClear', 14) + padL('담관통', 10) + padL('경계이탈', 10) + padL('det delta', 12));
for (const w of R.walker) {
  const ok = w.minFoot > 0 && w.collide === 0 && w.outb === 0 && w.det < 1e-4;
  if (!ok) fail++;
  console.log(pad(w.scale, 9) + padL(w.minFoot, 14) + padL(w.collide, 10) + padL(w.outb, 10) + padL(w.det, 12) + (ok ? '' : '  <-- FAIL'));
}

console.log('\n=== 결정론(파이프라인) ===');
const detOk = R.determinism.droneSampleDelta < 1e-4;
if (!detOk) fail++;
console.log('drone sample delta (같은 시드 2회): ' + R.determinism.droneSampleDelta + (detOk ? '  OK' : '  <-- FAIL'));

console.log('\n' + (errors.length ? `PAGEERRORS(${errors.length}):\n - ${errors.join('\n - ')}` : 'NO PAGEERRORS'));
if (errors.length) fail++;

console.log('\n' + (fail === 0 ? 'ALL PASS' : `FAILURES: ${fail}`));
process.exit(fail === 0 ? 0 : 1);
