// #94 절 배치 검증 — 마을 절이 산 능선과 겹치는 문제 진단·수정 게이트.
//   코어 직접 import(planVillage + populateVillage) 하네스. 전용 포트 4209(사용자 dev 5174 미접촉).
//   mode=current: 디스크 plan.js 의 절 배치 그대로. mode=fix: 하네스 내 후보 배치 함수(placeTempleFix)로
//   plan.features.temple 를 교체해 populate — 수렴 후 plan.js 로 이식. 진단값은 window.__T.
// 사용법: node tools/shoot-templesite.mjs [필터] [--tmp]
//   --tmp: 중간 컷을 scratchpad/temple 로(shots 오염 방지). 기본은 shots/templesite-*.png(게이트 증거).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..');
const PORT = 4209;
const args = process.argv.slice(2);
const useTmp = args.includes('--tmp');
const filter = args.find((a) => !a.startsWith('--')) || '';
const OUT = useTmp
  ? '/private/tmp/claude-501/-Users-hckim-repo-asiahouse/7a15478e-68e3-4ad3-b08a-bdb86ae4fe92/scratchpad/temple'
  : join(ROOT, 'shots');
mkdirSync(OUT, { recursive: true });
const prefix = useTmp ? '' : 'templesite-';

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json',
};

const HTML = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>html,body{margin:0;height:100%;overflow:hidden}#app{width:100%;height:100%}</style>
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.185.1/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.185.1/examples/jsm/"}}</script>
</head><body><div id="app"></div>
<script type="module">
import * as THREE from 'three';
import { planVillage } from '/src/village/plan.js';
import { populateVillage } from '/src/village/populate.js';
import * as G from '/src/village/geom.js';
const q = new URLSearchParams(location.search);
const scaleRaw = q.get('scale') || 'village';
const scale = isNaN(+scaleRaw) ? scaleRaw : +scaleRaw;
const seed = q.get('seed') != null ? (isNaN(+q.get('seed')) ? q.get('seed') : +q.get('seed')) : 20260716;
const includePalace = q.get('palace') === '1';
const includeTemple = q.get('temple') !== '0';   // 이 하네스는 절 검증이 목적이라 기본 ON
const mode = q.get('mode') || 'current';
const view = q.get('view') || 'aerial';
const time = q.get('time') || 'day';
const num = (k, d) => { const v = parseFloat(q.get(k)); return Number.isFinite(v) ? v : d; };

// 결정론 렌더(팔레트·싸리문 Math.random 고정)
{ let s = 0x2545f491 >>> 0; Math.random = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight); renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.getElementById('app').appendChild(renderer.domElement);
const scene = new THREE.Scene();

const L = {
  day:    { bg: 0xcfd8e0, sun: [0xfff0dd, 2.5, [0.42,1.25,0.30]], hemi: [0xc4d6e8, 0x9a8c72, 1.25], exp: 1.05 },
  sunset: { bg: 0xe7b98f, sun: [0xffb066, 2.1, [0.7,0.7,0.42]], hemi: [0xd7b48c, 0x7a6a54, 1.0], exp: 1.0 },
}[time] || {};
scene.background = new THREE.Color(L.bg);
renderer.toneMappingExposure = L.exp;

const plan = planVillage({ scale, seed, includePalace, includeTemple });
const site = plan.site;
const R = site.R;
const Hmax = site.Hmax;

// ── 후보 배치 함수(수렴 후 plan.js 로 이식) ──────────────────────────────────
//   산사(山寺): 능선 마루가 아니라 배산 사면 중턱의 완사면 벤치에 앉아 마을을 내려다보되
//   하늘선을 깨지 않는다. 요건 (1) 목표 표고대 [eLo..eHi]*Hmax 중턱 (2) footprint 완경사
//   (3) 절 뒤(북)로 능선이 배경으로 솟음(백드롭 마진). 측사면(좌청룡·우백호 어깨)에 앉혀
//   부감 시선축(남→북)에서 절 지붕선과 능선 마루선이 분리되게 한다.
function placeTempleFix(site, seed, P) {
  const C = site.center, Hmax = site.Hmax, R = site.R;
  const foot = 33;                          // pad 포함 footprint(30+3)
  const eLo = P.eLo, eHi = P.eHi;           // 목표 표고대(Hmax 비율)
  const eMid = (eLo + eHi) / 2;
  const side = ((seed ^ 0x7e11) >>> 0) % 2 === 0 ? 1 : -1;   // 결정론 좌/우 사면
  const footSlope = (x, z) => {
    let lo = 1e9, hi = -1e9;
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      const h = site.heightAt(x + i * foot / 2, z + j * foot / 2);
      if (h < lo) lo = h; if (h > hi) hi = h;
    }
    return { lo, hi, slope: hi - lo };
  };
  const backdropRise = (x, z, gy) => {
    let hi = -1e9;
    for (let dz = 0.06 * R; dz <= 0.7 * R; dz += 0.05 * R) {
      for (const dx of [-0.12 * R, 0, 0.12 * R]) hi = Math.max(hi, site.heightAt(x + dx, z - dz));
    }
    return hi - gy;
  };
  // 후보: 배산 사면(북~정측) 방위 × 반경 스캔. 표고대 안에서 완경사(접지)·백드롭·중앙표고·비가장자리 최적.
  const angs = [];
  for (let i = 0; i < P.an; i++) angs.push(P.aLo + (P.aHi - P.aLo) * (P.an === 1 ? 0.5 : i / (P.an - 1)));
  let best = null;
  for (const angFrac of angs) {
    const ang = angFrac * Math.PI;           // 0=정북(-z, 주산 배후), 0.5=정측(±x, 청룡·백호 어깨)
    const dir = { x: side * Math.sin(ang), z: -Math.cos(ang) };
    for (let r = 0.55 * R; r <= P.rMax * R; r += 0.02 * R) {
      const x = C.x + dir.x * r, z = C.z + dir.z * r;
      const gy = site.heightAt(x, z);
      const er = gy / Hmax;
      if (er < eLo || er > eHi) continue;
      const fs = footSlope(x, z);
      const bd = backdropRise(x, z, gy);
      const edge = Math.max(0, r / R - P.rSoft) * P.wEdge;    // 가장자리(월드 밖) 페널티
      const score = -fs.slope * P.wSlope + bd * P.wBack - Math.abs(er - eMid) * Hmax * P.wElev - edge;
      if (!best || score > best.score) best = { x, z, gy, er, fs, bd, score, ang, r };
    }
  }
  if (!best) {   // 표고대 못 찾으면 안전 폴백: 기존 방식 근사
    const x = side * R * 0.62, z = C.z - R * 0.18;
    best = { x, z, gy: site.heightAt(x, z), er: site.heightAt(x, z) / Hmax,
      fs: footSlope(x, z), bd: backdropRise(x, z, site.heightAt(x, z)), fallback: true };
  }
  // 일주문·대웅전은 마을(하향)을 향한다 — 절→마을 중심 방향으로 정면(남향 성분 유지).
  const toC = G.norm({ x: C.x - best.x, z: C.z - best.z });
  const frontDir = G.norm({ x: toC.x * 0.5, z: Math.max(0.5, toC.z) });
  return { temple: { x: best.x, z: best.z, frontDir, seed: (seed ^ 0x7e11) >>> 0 }, meta: best };
}

// 지형 완경사 존 프로브 — (ang, r) 격자에서 footprint slope·elev·backdrop 를 훑어 게으른 벤치를 찾는다.
if (mode === 'probe') {
  const C = site.center;
  const foot = 33;
  const fs = (x, z) => { let lo = 1e9, hi = -1e9; for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) { const h = site.heightAt(x + i * foot / 2, z + j * foot / 2); if (h < lo) lo = h; if (h > hi) hi = h; } return hi - lo; };
  const bd = (x, z, gy) => { let hi = -1e9; for (let dz = 0.06 * R; dz <= 0.7 * R; dz += 0.06 * R) for (const dx of [-0.12 * R, 0, 0.12 * R]) hi = Math.max(hi, site.heightAt(x + dx, z - dz)); return hi - gy; };
  const rows = [];
  for (let a = 0.10; a <= 0.66; a += 0.08) {
    const cells = [];
    for (let rf = 0.60; rf <= 1.10; rf += 0.06) {
      const ang = a * Math.PI, dir = { x: Math.sin(ang), z: -Math.cos(ang) };
      const x = C.x + dir.x * rf * R, z = C.z + dir.z * rf * R;
      const gy = site.heightAt(x, z);
      cells.push({ rf: +rf.toFixed(2), er: +(gy / Hmax).toFixed(2), sl: +fs(x, z).toFixed(0), bk: +bd(x, z, gy).toFixed(0), zf: +((z - C.z) / R).toFixed(2) });
    }
    rows.push({ a: +a.toFixed(2), cells });
  }
  window.__PROBE = rows;
}

// #94 이전(옛) 배치 재현 — before/after 대비 게이트용. (측면 급벽 x=±0.62R, z=중심-0.18R)
if (includeTemple && mode === 'old') {
  const east = (((plan.opts.seed ^ 0x7e11) >>> 0) % 100) / 100 < 0.6 ? 1 : -1;
  const tR = plan.opts.scale === 'hanyang' ? 0.82 : 0.62;
  const tx = east * R * tR, tz = site.center.z - R * 0.18;
  plan.features.temple = { x: tx, z: tz, frontDir: G.norm({ x: -east * 0.4, z: 1 }), seed: (plan.opts.seed ^ 0x7e11) >>> 0 };
}

let fixMeta = null;
if (includeTemple && mode === 'fix') {
  const P = {
    eLo: num('elo', 0.50), eHi: num('ehi', 0.70),
    aLo: num('alo', 0.34), aHi: num('ahi', 0.52), an: num('an', 6),
    rMax: num('rmax', 1.00), rSoft: num('rsoft', 0.98),
    wSlope: num('wslope', 3.0), wBack: num('wback', 0.35), wElev: num('welev', 0.30), wEdge: num('wedge', 60),
  };
  const pang = parseFloat(q.get('pang')), prf = parseFloat(q.get('prf'));
  if (Number.isFinite(pang) && Number.isFinite(prf)) {
    // 위치 강제(프로브 셀 시각검증) — 탐색 우회
    const C = site.center, ang = pang * Math.PI;
    const side = ((plan.opts.seed ^ 0x7e11) >>> 0) % 2 === 0 ? 1 : -1;
    const x = C.x + side * Math.sin(ang) * prf * R, z = C.z + (-Math.cos(ang)) * prf * R;
    const toC = G.norm({ x: C.x - x, z: C.z - z });
    plan.features.temple = { x, z, frontDir: G.norm({ x: toC.x * 0.5, z: Math.max(0.5, toC.z) }), seed: (plan.opts.seed ^ 0x7e11) >>> 0 };
    fixMeta = { ang, r: prf * R, forced: true };
  } else {
    const r = placeTempleFix(site, plan.opts.seed, P);
    plan.features.temple = r.temple;
    fixMeta = r.meta;
  }
}

let villageGroup = null;
if (mode !== 'probe') { villageGroup = populateVillage(plan); scene.add(villageGroup); }

// ── 절 진단 ──────────────────────────────────────────────────────────────
const T = plan.features.temple;
let tdiag = null;
if (T) {
  const foot = 33;
  let fmin = 1e9, fmax = -1e9;
  const NG = 6;
  for (let i = 0; i <= NG; i++) for (let j = 0; j <= NG; j++) {
    const x = T.x - foot / 2 + foot * i / NG, z = T.z - foot / 2 + foot * j / NG;
    const h = site.heightAt(x, z);
    if (h < fmin) fmin = h; if (h > fmax) fmax = h;
  }
  const gy = site.heightAt(T.x, T.z);
  // 절 뒤 능선 백드롭
  let ridgeMax = -1e9, ridgeZ = 0;
  for (let dz = 0.04 * R; dz <= 0.8 * R; dz += 0.03 * R) {
    for (const dx of [-0.12 * R, 0, 0.12 * R]) {
      const h = site.heightAt(T.x + dx, T.z - dz);
      if (h > ridgeMax) { ridgeMax = h; ridgeZ = T.z - dz; }
    }
  }
  tdiag = {
    mode, x: +T.x.toFixed(1), z: +T.z.toFixed(1),
    xFrac: +(T.x / R).toFixed(2), zFracFromC: +((T.z - site.center.z) / R).toFixed(2),
    groundY: +gy.toFixed(1), elevRatio: +(gy / Hmax).toFixed(3), hillAt: +site.hillAt(T.x, T.z).toFixed(2),
    footMin: +fmin.toFixed(1), footMax: +fmax.toFixed(1), footSlope: +(fmax - fmin).toFixed(1),
    ridgeMax: +ridgeMax.toFixed(1), backdropRise: +(ridgeMax - gy).toFixed(1),
  };
  if (fixMeta) tdiag.pickAng = +(fixMeta.ang / Math.PI).toFixed(2), tdiag.pickR = +(fixMeta.r || 0).toFixed(0), tdiag.fallback = !!fixMeta.fallback;
}
const pc = villageGroup ? villageGroup.userData.palaceCore : undefined;
window.__T = { scaleIn: scaleRaw, R: +R.toFixed(0), Hmax: +Hmax.toFixed(0), tier: plan.opts.scale, seed: plan.opts.seed, temple: tdiag, warnings: plan.warnings,
  palaceCore: pc === undefined ? 'ABSENT_KEY' : (pc ? (pc.name + (pc.userData && pc.userData.palaceCompound ? '+compound' : '')) : 'null') };

scene.fog = new THREE.Fog(L.bg, R * 2.4, R * 7.0);
const sun = new THREE.DirectionalLight(L.sun[0], L.sun[1]);
sun.position.set(L.sun[2][0] * R, L.sun[2][1] * R, L.sun[2][2] * R);
sun.castShadow = true; sun.shadow.mapSize.set(4096, 4096);
const TR = site.terrainR || R;
const sc = sun.shadow.camera;
sc.left = -TR * 1.05; sc.right = TR * 1.05; sc.top = TR * 1.05; sc.bottom = -TR * 1.05;
sc.near = 1; sc.far = TR * 8; sun.shadow.bias = -0.0003; sun.shadow.normalBias = 0.08;
scene.add(sun);
scene.add(new THREE.HemisphereLight(L.hemi[0], L.hemi[1], L.hemi[2]));

// ── 카메라 ──
const hAt = (x, z) => site.heightAt(x, z);
let camera;
if (view === 'aerial') {
  // 기본 부감(남→북) — scale/relief 하네스와 동일 앵글. 절-능선 겹침이 보고된 뷰.
  camera = new THREE.PerspectiveCamera(44, innerWidth / innerHeight, 0.5, R * 8);
  camera.position.set(0.18 * R, 1.02 * R, 1.98 * R);
  camera.lookAt(0, 0.06 * R, -0.16 * R);
} else if (view === 'temple' && T) {
  // 절에 프레이밍(남쪽에서 절을 보고 능선을 배경으로) — 실루엣 분리 확인
  const gy = hAt(T.x, T.z);
  camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.5, R * 8);
  camera.position.set(T.x * 0.35, gy + 0.42 * R, T.z + 0.72 * R);
  camera.lookAt(T.x, gy + 6, T.z - 0.06 * R);
} else if (view === 'focus' && T) {
  // 근접 접지: 절 축대·대지 자연스러움(저각 오블리크)
  const gy = hAt(T.x, T.z);
  camera = new THREE.PerspectiveCamera(46, innerWidth / innerHeight, 0.3, R * 8);
  camera.position.set(T.x + 26, gy + 16, T.z + 30);
  camera.lookAt(T.x, gy + 5, T.z);
} else { // side — 측면 저각(절-능선 프로필)
  const gy = T ? hAt(T.x, T.z) : 0;
  camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, 0.5, R * 8);
  camera.position.set((T ? T.x : 0) + Math.sign((T ? T.x : 1) || 1) * 0.9 * R, gy + 0.3 * R, (T ? T.z : 0) + 0.2 * R);
  camera.lookAt((T ? T.x : 0), gy + 8, (T ? T.z : 0) - 0.1 * R);
}
camera.position.set(num('cx', camera.position.x), num('cy', camera.position.y), num('cz', camera.position.z));

let frames = 0;
renderer.setAnimationLoop(() => {
  renderer.render(scene, camera);
  frames++;
  if (frames === 12) {
    const ri = renderer.info;
    window.__T.perf = { calls: ri.render.calls, triangles: ri.render.triangles };
    window.__SHOT_READY = true;
  }
});
</script></body></html>`;

const server = createServer(async (req, res) => {
  const path = req.url.split('?')[0];
  if (path === '/__temple') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(HTML); return; }
  try {
    const file = join(ROOT, path === '/' ? 'index.html' : path);
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise((ok, no) => server.listen(PORT, '127.0.0.1', ok).on('error', no));

// 기본 게이트 목록 — 필터로 서브셋. name 이 곧 파일 접미사.
// #94 게이트 세트 — before(옛 급벽) / after(어깨 벤치) 대비 + 다시드·다규모 분리 일관성 + 근접 + 앵커.
const shots = (process.env.SHOTS ? JSON.parse(process.env.SHOTS) : [
  ['before-village-aerial', 'scale=village&seed=20260716&mode=old&view=aerial'],
  ['after-village-aerial',  'scale=village&seed=20260716&mode=current&view=aerial'],
  ['before-capital-aerial', 'scale=capital&seed=1234&palace=1&mode=old&view=aerial'],
  ['after-capital-aerial',  'scale=capital&seed=1234&palace=1&mode=current&view=aerial'],
  ['after-seed-village-a',  'scale=village&seed=20260716&mode=current&view=aerial'],
  ['after-seed-village-b',  'scale=village&seed=999&mode=current&view=aerial'],
  ['after-seed-town',       'scale=town&seed=77&mode=current&view=aerial'],
  ['after-seed-hanyang',    'scale=hanyang&seed=7&palace=1&mode=current&view=aerial'],
  ['after-close-focus',     'scale=village&seed=20260716&mode=current&view=focus'],
  ['after-town-temple',     'scale=town&seed=77&mode=current&view=temple'],
  ['anchor-notemple-village', 'scale=village&seed=20260716&mode=current&view=aerial&temple=0'],
]).filter(([name]) => !filter || name.includes(filter));

let browser;
try { browser = await chromium.launch({ channel: 'chrome' }); }
catch { browser = await chromium.launch(); }
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
let pageErrs = 0, consoleErrs = 0;
page.on('console', (m) => { if (m.type() !== 'error') return; const t = m.text(); if (/favicon|404/.test(t)) return; consoleErrs++; console.error('[console]', t); });
page.on('pageerror', (e) => { pageErrs++; console.error('[pageerror]', e.message); });

for (const [name, qs] of shots) {
  await page.goto(`http://127.0.0.1:${PORT}/__temple?${qs}`, { waitUntil: 'load' });
  try { await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 45000 }); }
  catch { console.error('TIMEOUT', name); continue; }
  await page.waitForTimeout(180);
  const probe = await page.evaluate(() => window.__PROBE || null);
  if (probe) {
    console.log(`PROBE ${name}: (a=ang/π; cells rf|er|slope|backdrop|zf)`);
    for (const row of probe) console.log(` a=${row.a} ` + row.cells.map((c) => `${c.rf}:e${c.er}s${c.sl}b${c.bk}z${c.zf}`).join('  '));
    continue;
  }
  const p = await page.evaluate(() => window.__T);
  const file = join(OUT, `${prefix}${name}.png`);
  await page.screenshot({ path: file });
  const t = p.temple;
  console.log(`${name}  R=${p.R} H=${p.Hmax} ${p.tier}` + (t
    ? `  T(xf=${t.xFrac},zf=${t.zFracFromC}) elev=${t.elevRatio}(gy${t.groundY}) slope=${t.footSlope} backdrop=${t.backdropRise} hill=${t.hillAt}` + (t.pickAng != null ? ` ang=${t.pickAng} r=${t.pickR}${t.fallback ? ' FALLBACK' : ''}` : '')
    : '  (no temple)') + `  calls=${p.perf ? p.perf.calls : '?'}  palaceCore=${p.palaceCore}` + (p.warnings && p.warnings.length ? '  WARN:' + p.warnings.join(';') : ''));
}
console.log(`\nsaved to ${OUT}/${prefix}*.png   pageerror=${pageErrs} console-error=${consoleErrs}`);
await browser.close();
server.close();
