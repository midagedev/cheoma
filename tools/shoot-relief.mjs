// 헤드리스 스크린샷: 마을 내부 지형 기복(완경사·언듈레이션·필지 단차·축대) 검증 → shots/relief-*.png
// 사용법: node tools/shoot-relief.mjs [필터]
//   어댑터(createVillage) 경로로 렌더 → baseY(성토 패드)·픽킹 프록시·야간 창호광까지 함께 확인.
//   자체 프레이밍(부감/아이레벨/클로즈업)을 쓴다. 파탄 검사(부양·관통·축대)는 window.__PLAN.relief 에.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'shots');
mkdirSync(OUT, { recursive: true });

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
import { createVillage } from '/src/village/adapter.js';
import { setupPost } from '/src/env/post.js';
const q = new URLSearchParams(location.search);
const scale = q.get('scale') || 'village';
const seedRaw = q.get('seed');
const seed = seedRaw != null ? (isNaN(+seedRaw) ? seedRaw : +seedRaw) : 20260716;
const includePalace = q.get('palace') === '1';
const includeTemple = q.get('temple') === '1';
const character = q.get('char') || 'yeoyeom';
const view = q.get('view') || 'aerial';
const time = q.get('time') || 'day';
const usePost = q.get('post') === '1';   // 플래그십 bloom 파이프라인(개울 흰 띠 회귀 검증)
const river = q.get('river') === '1';
const num = (k, d) => { const v = parseFloat(q.get(k)); return Number.isFinite(v) ? v : d; };

// 결정론 렌더: 공유 팔레트·사립문이 Math.random 을 쓰므로 재현 컷 픽셀 동일하도록 시드 고정.
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
  night:  { bg: 0x131a29, sun: [0xbcd2ff, 0.55, [0.30,0.95,0.52]], hemi: [0x2a3550, 0x171820, 0.55], exp: 1.2 },
}[time] || {};
scene.background = new THREE.Color(L.bg);
renderer.toneMappingExposure = L.exp;

const handle = createVillage({ scale, seed, includePalace, includeTemple, character, river });
handle.setTime(time);
scene.add(handle.group);
const plan = handle.plan;
const site = plan.site;
const R = site.R;
window.__PLAN = {
  scale, seed, character: plan.opts.character, stats: plan.stats, warnings: plan.warnings, R,
  watercourse: site.stream?.kind || 'dry',
  waterWidth: site.stream ? +(site.stream.waterHalf * 2).toFixed(2) : 0,
  bankWidth: site.stream ? +site.stream.width.toFixed(2) : 0,
  reliefConfig: site.relief,
};

scene.fog = new THREE.Fog(L.bg, R * 2.4, R * 7.0);

const sun = new THREE.DirectionalLight(L.sun[0], L.sun[1]);
sun.position.set(L.sun[2][0] * R, L.sun[2][1] * R, L.sun[2][2] * R);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
const TR = site.terrainR || R;
const sc = sun.shadow.camera;
sc.left = -TR * 1.05; sc.right = TR * 1.05; sc.top = TR * 1.05; sc.bottom = -TR * 1.05;
sc.near = 1; sc.far = TR * 8;
sun.shadow.bias = -0.0003; sun.shadow.normalBias = 0.08;
scene.add(sun);
scene.add(new THREE.HemisphereLight(L.hemi[0], L.hemi[1], L.hemi[2]));

// ── 파탄 검사: 필지 성토 패드 정합(부양·관통·축대). site.heightAt 로 footprint 를 조밀 샘플. ──
function pointInPoly(px, pz, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (((a.z > pz) !== (b.z > pz)) && (px < (b.x - a.x) * (pz - a.z) / (b.z - a.z) + a.x)) inside = !inside;
  }
  return inside;
}
(function reliefCheck() {
  let maxPoke = -1e9, maxFill = -1e9, maxStep = 0, chukdae = 0, floating = 0;
  for (const p of plan.parcels) {
    if (!p.poly || p.baseY == null) continue;
    const padY = p.baseY;
    // footprint bbox 조밀 그리드 → 패드가 지형을 덮는지(관통) / 과도 성토(부양) 검사
    let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
    for (const c of p.poly) { minX = Math.min(minX, c.x); maxX = Math.max(maxX, c.x); minZ = Math.min(minZ, c.z); maxZ = Math.max(maxZ, c.z); }
    let footMax = -1e9, footMin = 1e9;
    const NG = 6;
    for (let i = 0; i <= NG; i++) for (let j = 0; j <= NG; j++) {
      const x = minX + (maxX - minX) * i / NG, z = minZ + (maxZ - minZ) * j / NG;
      if (!pointInPoly(x, z, p.poly)) continue;
      const g = site.heightAt(x, z);
      footMax = Math.max(footMax, g); footMin = Math.min(footMin, g);
    }
    if (footMax < -1e8) { const g = site.heightAt(p.center.x, p.center.z); footMax = footMin = g; }
    maxPoke = Math.max(maxPoke, footMax - padY);     // >0.06 이면 지형이 패드 위로 관통
    const fill = padY - footMin;                     // 성토(축대) 최대 높이
    maxFill = Math.max(maxFill, fill);
    maxStep = Math.max(maxStep, fill);
    if (fill > 0.4) chukdae++;                        // 축대로 읽히는 필지 수
    if (fill > 3.0) floating++;                       // 과도 성토(부양 위험)
  }
  // 분지 바닥 언듈레이션 레인지(완전 평면이 아님을 확인)
  let lo = 1e9, hi = -1e9;
  const cx = site.center.x, cz = site.center.z, br = site.bowlR * 0.7;
  for (let i = 0; i < 40; i++) {
    const a = i / 40 * Math.PI * 2;
    for (const rr of [0.25, 0.5, 0.85]) {
      const x = cx + Math.cos(a) * br * rr, z = cz + Math.sin(a) * br * rr;
      const g = site.heightAt(x, z);
      lo = Math.min(lo, g); hi = Math.max(hi, g);
    }
  }
  window.__PLAN.relief = {
    parcels: plan.parcels.length,
    maxPoke: +maxPoke.toFixed(3), maxFill: +maxFill.toFixed(3), maxStep: +maxStep.toFixed(3),
    chukdae, floating, bowlReliefRange: +(hi - lo).toFixed(2),
  };
})();

// 픽킹 프록시 정합: worldCenter.y 가 baseY(패드)와 일치하는지(어댑터 정합 확인)
(function proxyCheck() {
  const pr = handle.getPickProxies();
  let maxDelta = 0;
  const byId = new Map(plan.parcels.map((p) => [p.id, p]));
  for (const x of pr) {
    const p = byId.get(x.parcelId);
    if (p && p.baseY != null) maxDelta = Math.max(maxDelta, Math.abs(x.worldCenter.y - p.baseY));
  }
  window.__PLAN.proxyMaxDelta = +maxDelta.toFixed(3);
})();

// ── 카메라 프레이밍 ──
const cen = site.center;
const hAt = (x, z) => site.heightAt(x, z);
let campos, target, fov;
if (view === 'aerial') {
  fov = 44;
  campos = new THREE.Vector3(0.18 * R, 1.02 * R, 1.98 * R);
  target = new THREE.Vector3(0, 0.06 * R, -0.16 * R);
} else if (view === 'eye') {
  const camZ = site.streamZ + R * 0.34, cx0 = R * 0.04;
  const gy = hAt(cx0, camZ);
  fov = 52;
  campos = new THREE.Vector3(cx0, gy + 2.4, camZ);
  target = new THREE.Vector3(0, hAt(0, cen.z) + 5, cen.z * 0.55);
} else if (view === 'relief-eye') {
  // 측면 저각: 마을을 가로질러 필지 단차·축대가 프로필로 읽히게(남동→북서)
  const cxp = 0.5 * R, czp = 0.42 * R;
  const gy = hAt(cxp, czp);
  fov = 46;
  campos = new THREE.Vector3(cxp, gy + 5.5, czp);
  target = new THREE.Vector3(-0.12 * R, hAt(0, cen.z) + 2.5, cen.z * 0.7);
} else if (view === 'road-close') {
  // 안길(스파인) 저각 오블리크: 도로 리본이 지형 언듈레이션을 따라 흐르는지(뜸/파묻힘)
  const z0 = cen.z + R * 0.42;             // 마을 남측 거리(개울 북)
  const gy = hAt(8, z0);
  fov = 52;
  campos = new THREE.Vector3(9, gy + 6.0, z0 + 6);
  target = new THREE.Vector3(-3, hAt(-3, cen.z) + 1.2, cen.z * 0.4);
} else if (view === 'bridge-close') {
  // 돌다리·개울 정합 — 개울 축(동→서)을 따라 저각으로: 물 리본이 다리 아래로 흐르는지.
  const crossing = plan.features.bridges?.[0] || site.stream?.cross || { x: 0, z: site.streamZ };
  const bx = crossing.x, bz = crossing.z;
  const wy = site.streamY ? site.streamY(bx) : hAt(bx, bz);
  fov = 44;
  campos = new THREE.Vector3(bx + 22, wy + 4.0, bz + 3);
  target = new THREE.Vector3(bx - 12, wy + 0.2, bz - 1);
} else if (view === 'bridge-oblique') {
  const crossing = plan.features.bridges?.[0] || site.stream?.cross || { x: 0, z: site.streamZ };
  const bx = crossing.x, bz = crossing.z;
  const wy = site.streamY ? site.streamY(bx) : hAt(bx, bz);
  fov = 46;
  campos = new THREE.Vector3(bx + 25, wy + 13, bz + 23);
  target = new THREE.Vector3(bx, wy + 2.2, bz);
} else { // aerial-high
  fov = 40;
  campos = new THREE.Vector3(0.02 * R, 2.1 * R, 1.5 * R);
  target = new THREE.Vector3(0, 0, -0.05 * R);
}
const camera = new THREE.PerspectiveCamera(fov, innerWidth / innerHeight, 0.5, R * 8);
camera.position.set(num('cx', campos.x), num('cy', campos.y), num('cz', campos.z));
camera.lookAt(num('tx', target.x), num('ty', target.y), num('tz', target.z));

// 플래그십 bloom 파이프라인(개울 흰 띠 검증용) — OutputPass 가 ACES 담당하므로 렌더러 톤매핑 off.
let post = null;
if (usePost) {
  renderer.toneMapping = THREE.NoToneMapping;
  post = setupPost({ renderer, scene, camera });
  post.setTime(time);
  post.setSize(innerWidth, innerHeight);
}

let frames = 0;
renderer.setAnimationLoop(() => {
  handle.update(1 / 60);
  if (post) { post.update(1 / 60); post.composer.render(); }
  else renderer.render(scene, camera);
  frames++;
  if (frames === 14) {
    const ri = renderer.info;
    window.__PLAN.perf = { calls: ri.render.calls, triangles: ri.render.triangles, geometries: ri.memory.geometries, textures: ri.memory.textures };
    window.__SHOT_READY = true;
  }
});
</script></body></html>`;

// 단일 건물 씬(env/water.js 개울) — 흰 띠 회귀 검증용. 앰비언트 env 조립 + 플래그십 bloom.
const SINGLE_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>html,body{margin:0;height:100%;overflow:hidden;background:#cfd8e0}#app{width:100%;height:100%}</style>
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.185.1/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.185.1/examples/jsm/"}}</script>
</head><body><div id="app"></div>
<script type="module">
import * as THREE from 'three';
import { PRESETS, computeLayout } from '/src/params.js';
import { buildBuilding } from '/src/builder/index.js';
import { setupEnvironment } from '/src/env/index.js';
import { setupPost } from '/src/env/post.js';
const q = new URLSearchParams(location.search);
const time = q.get('time') || 'day';
const usePost = q.get('post') === '1';
const num = (k, d) => { const v = parseFloat(q.get(k)); return Number.isFinite(v) ? v : d; };
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight); renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = usePost ? THREE.NoToneMapping : THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
document.getElementById('app').appendChild(renderer.domElement);
const scene = new THREE.Scene(); scene.background = new THREE.Color(0xcfd8e0); scene.fog = new THREE.Fog(0xcfd8e0, 60, 300);
const sun = new THREE.DirectionalLight(0xfff0dd, 2.6); sun.position.set(30, 42, 26); sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048); sun.shadow.camera.left = -60; sun.shadow.camera.right = 60; sun.shadow.camera.top = 60; sun.shadow.camera.bottom = -60;
sun.shadow.camera.far = 260; sun.shadow.bias = -0.0001; sun.shadow.normalBias = 0.05; scene.add(sun);
const hemi = new THREE.HemisphereLight(0xbdd0e4, 0x8a7a63, 0.9); scene.add(hemi);
const P = { ...PRESETS.korea }; const building = buildBuilding(P); building.name = 'building'; scene.add(building);
const layout = computeLayout(P);
const env = setupEnvironment(scene, { sun, hemi, renderer, layout });
env.setSeason('summer', { immediate: true }); env.setTime(time); env.setEnabled(true);
// 개울 근접 프레이밍(앰비언트 water 컷과 동일 앵글)
const camera = new THREE.PerspectiveCamera(38, innerWidth / innerHeight, 0.1, 600);
camera.position.set(num('cx', -40), num('cy', 5), num('cz', 6));
camera.lookAt(num('tx', -88), num('ty', -2), num('tz', -14));
let post = null;
if (usePost) { post = setupPost({ renderer, scene, camera }); post.setTime(time); post.setSize(innerWidth, innerHeight); }
for (let i = 0; i < 44; i++) env.update(0.05);   // 물결 위상 전진(반짝임)
let frames = 0;
renderer.setAnimationLoop(() => {
  env.update(1 / 60);
  if (post) { post.update(1 / 60); post.composer.render(); }
  else renderer.render(scene, camera);
  frames++;
  if (frames === 8) { window.__SHOT_READY = true; }
});
</script></body></html>`;

const server = createServer(async (req, res) => {
  const path = req.url.split('?')[0];
  if (path === '/__relief') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(HTML); return; }
  if (path === '/__single') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(SINGLE_HTML); return; }
  try {
    const file = join(ROOT, path === '/' ? 'index.html' : path);
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const port = server.address().port;

const filter = process.argv[2] || '';
const shots = [
  // ① village 아이레벨·측면 저각 — 완경사·필지 단차·축대가 읽히는 컷
  ['village-eye', '/__relief?scale=village&view=eye&time=day'],
  ['village-relief-eye', '/__relief?scale=village&view=relief-eye&time=day'],
  // ② hamlet·capital 항공
  ['hamlet-aerial', '/__relief?scale=hamlet&view=aerial&time=day'],
  ['hamlet-relief-eye', '/__relief?scale=hamlet&view=relief-eye&time=day'],
  ['capital-aerial', '/__relief?scale=capital&view=aerial&time=day'],
  ['capital-relief-eye', '/__relief?scale=capital&view=relief-eye&time=day&palace=1'],
  ['capital-river-aerial', '/__relief?scale=capital&view=aerial&time=day&river=1&palace=1'],
  ['hanyang-river-aerial', '/__relief?scale=hanyang&view=aerial&time=day&river=1&palace=1'],
  ['hanyang-river-ferry', '/__relief?scale=hanyang&view=bridge-oblique&time=day&river=1&palace=1'],
  // ③ 도로 지형 밀착 클로즈업
  ['road-close', '/__relief?scale=village&view=road-close&time=day'],
  // ④ 다리·개울 정합
  ['bridge-close', '/__relief?scale=village&view=bridge-close&time=day'],
  // ⑤ 같은 seed 재현성 2컷
  ['repro-a', '/__relief?scale=village&view=relief-eye&seed=20260716&time=day'],
  ['repro-b', '/__relief?scale=village&view=relief-eye&seed=20260716&time=day'],
  // ⑥ night 마을(창호광 회귀)
  ['village-night', '/__relief?scale=village&view=eye&time=night'],
  // 개울 물 글린트 흰 띠 검증(bloom 파이프라인) — night 마을 부감·석양 capital 부감
  ['water-night', '/__relief?scale=village&view=aerial&time=night&post=1'],
  ['water-sunset-capital', '/__relief?scale=capital&view=aerial&time=sunset&post=1&palace=1'],
  ['water-day-check', '/__relief?scale=village&view=aerial&time=day&post=1'],
  // 단일 건물 개울(env/water.js) 흰 띠 회귀 — night·sunset·day(회귀)
  ['water-single-night', '/__single?time=night&post=1'],
  ['water-single-sunset', '/__single?time=sunset&post=1'],
  ['water-single-day', '/__single?time=day&post=1'],
  // 옵션 조합(궁·절 패드 확인)
  ['capital-palace-aerial', '/__relief?scale=capital&view=aerial&palace=1&time=day'],
  ['village-temple-relief', '/__relief?scale=village&view=relief-eye&temple=1&time=day'],
].filter(([name]) => !filter || name.includes(filter));

let browser;
try { browser = await chromium.launch({ channel: 'chrome' }); }
catch { browser = await chromium.launch(); }
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
let pageErrs = 0, consoleErrs = 0;
page.on('console', (msg) => {
  if (msg.type() !== 'error') return;
  const t = msg.text();
  if (/favicon\.ico/.test(t) || /status of 404/.test(t)) return;
  consoleErrs++; console.error('[console]', t);
});
page.on('pageerror', (err) => { pageErrs++; console.error('[pageerror]', err.message); });

for (const [name, qs] of shots) {
  const url = `http://127.0.0.1:${port}${qs}`;
  await page.goto(url, { waitUntil: 'load' });
  try { await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 40000 }); }
  catch (e) { console.error('TIMEOUT', name); }
  await page.waitForTimeout(250);
  const info = await page.evaluate(() => window.__PLAN || null);
  if (info) console.log(name, JSON.stringify(info.stats && { houses: info.stats.houses }), 'relief=' + JSON.stringify(info.relief || {}), 'proxyΔ=' + info.proxyMaxDelta, 'perf=' + JSON.stringify(info.perf || {}), info.warnings && info.warnings.length ? 'WARN:' + info.warnings.join(';') : '');
  const file = join(OUT, `relief-${name}.png`);
  await page.screenshot({ path: file });
  console.log('saved', file);
}
console.log(`pageerror=${pageErrs} console-error=${consoleErrs} (favicon 404 제외)`);

await browser.close();
server.close();
