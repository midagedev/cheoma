// 헤드리스 검증(태스크 #57): 마을 비정형 테두리 + 저층 운해 링 + 흐르는 구름 그림자.
//   → shots/vclouds-*.png
// 어댑터 전체 경로(createVillage → enterVillageMode)를 실제 앱처럼 구동한다 — clouds 빌보드는
//   어댑터가 scene 의 sun 을 찾아 마을 그룹에 붙이므로 populate-only 하네스(shoot-village)와 달리
//   실제 표류·그림자를 촬영할 수 있다. fog 모디파이어(env stub)로 엣지 헤이즈·운해 색을 매 틱 갱신.
// 카메라: 건물 고정 리그와 무관한 자체 부감/아이레벨(마을 검증 규약).
//   ?steps=N&dt= 가상시간 결정론, ?clouds=0 옵트아웃, ?shot=1 표류 t=0 결정론.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'shots');
mkdirSync(OUT, { recursive: true });
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json' };

const HTML = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>html,body{margin:0;height:100%;overflow:hidden}#app{width:100%;height:100%}</style>
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.185.1/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.185.1/examples/jsm/"}}</script>
</head><body><div id="app"></div>
<script type="module">
import * as THREE from 'three';
import { createVillage } from '/src/village/adapter.js';
const q = new URLSearchParams(location.search);
const scale = q.get('scale') || 'village';
const seedRaw = q.get('seed');
const seed = seedRaw != null ? (isNaN(+seedRaw) ? seedRaw : +seedRaw) : 20260716;
const includeTemple = q.get('temple') === '1';
const includePalace = q.get('palace') === '1';
const character = q.get('char') || 'yeoyeom';
const view = q.get('view') || 'aerial';
const time = q.get('time') || 'day';
const cross = q.get('cross') || '';              // 'day-sunset' 등: 두 시간대 사이 크로스페이드 중간 프레임
const steps = parseInt(q.get('steps') || '30', 10);
const dt = parseFloat(q.get('dt') || (1/60));
const azDeg = parseFloat(q.get('az') || '0');    // 부감 방위(테두리 방위별 비교)
const num = (k, d) => { const v = parseFloat(q.get(k)); return Number.isFinite(v) ? v : d; };

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight); renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.getElementById('app').appendChild(renderer.domElement);
const scene = new THREE.Scene();

// 시간대별 조명·대기(engine.js·shoot-village 계열). sun.position 은 방위 벡터 × 거리.
const TIMES = {
  day:    { bg: 0xcfd8e0, sun: [0xfff0dd, 2.6, [0.42,1.25,0.30]], hemi: [0xbdd0e4, 0x8a7a63, 0.9], exp: 1.05 },
  sunset: { bg: 0xe7b98f, sun: [0xffb066, 2.3, [0.7,0.34,0.42]], hemi: [0xd7b48c, 0x7a6a54, 0.8], exp: 1.0 },
  night:  { bg: 0x2a3550, sun: [0xa9bde0, 0.9, [0.3,0.5,0.5]],   hemi: [0x3d4c6e, 0x1b2233, 0.5], exp: 1.0 },
};
function applyLight(L) {
  scene.background = new THREE.Color(L.bg);
  renderer.toneMappingExposure = L.exp;
  sun.color.setHex(L.sun[0]); sun.intensity = L.sun[1];
  sun.position.set(L.sun[2][0] * R, L.sun[2][1] * R, L.sun[2][2] * R);
  hemi.color.setHex(L.hemi[0]); hemi.groundColor.setHex(L.hemi[1]); hemi.intensity = L.hemi[2];
  scene.fog.color.setHex(L.bg);
  if (scene.background && scene.background.isColor) scene.background.setHex(L.bg);
}
function lerpLight(a, b, k) {
  const mix = (x, y) => x + (y - x) * k;
  const mc = (h1, h2) => new THREE.Color(h1).lerp(new THREE.Color(h2), k).getHex();
  return {
    bg: mc(a.bg, b.bg), exp: mix(a.exp, b.exp),
    sun: [mc(a.sun[0], b.sun[0]), mix(a.sun[1], b.sun[1]), a.sun[2].map((v, i) => mix(v, b.sun[2][i]))],
    hemi: [mc(a.hemi[0], b.hemi[0]), mc(a.hemi[1], b.hemi[1]), mix(a.hemi[2], b.hemi[2])],
  };
}

// scene 직속 그림자 캐스터 sun(어댑터 findSun 이 이걸 찾는다) + hemi + fog.
const sun = new THREE.DirectionalLight(0xffffff, 1);
sun.castShadow = true; sun.shadow.mapSize.set(4096, 4096);
scene.add(sun);
const hemi = new THREE.HemisphereLight(0xffffff, 0x808080, 1);
scene.add(hemi);
scene.fog = new THREE.Fog(0xcfd8e0, 60, 220);

// 마을 어댑터(앱 경로) — createVillage → enterVillageMode.
const handle = createVillage({ scale, seed, includeTemple, includePalace, character });
const plan = handle.plan;
const R = plan.site.R;
const TR = plan.site.terrainR || R;
const sc = sun.shadow.camera;
sc.left = -TR * 1.05; sc.right = TR * 1.05; sc.top = TR * 1.05; sc.bottom = -TR * 1.05;
sc.near = 1; sc.far = TR * 8; sun.shadow.bias = -0.0003; sun.shadow.normalBias = 0.08;

// env stub: fog 모디파이어(near/far + 엣지 헤이즈·운해색). 실제 env.applyFogBaseAndMods 를 대신해
//   매 틱 harness 가 fogMods 를 돌린다(어댑터 villageFog 가 setEnvHaze 를 호출 → 헤이즈 동기화).
const fogMods = [];
const env = {
  group: { visible: true },
  addFogModifier: (fn) => { if (fn && !fogMods.includes(fn)) { fogMods.push(fn); fn(scene); } },
  removeFogModifier: (fn) => { const i = fogMods.indexOf(fn); if (i >= 0) fogMods.splice(i, 1); },
};

// 진입 전 초기 조명(baseTime) 세팅 → findSun 이 정상 sun 을 잡도록 이미 scene 에 있음.
const baseTime = cross ? cross.split('-')[0] : time;
applyLight(TIMES[baseTime] || TIMES.day);

handle.enterVillageMode({ scene, env, building: null, ground: null });
handle.setTime(baseTime);
handle.setSeason(plan.opts.season || 'summer', {});
handle.setWeather('clear');

// 카메라 프레이밍
let campos, target, fov;
if (view === 'eye') {
  const camZ = plan.site.streamZ + R * 0.34, cx0 = R * 0.04;
  const gy = plan.site.heightAt(cx0, camZ);
  fov = 52; campos = new THREE.Vector3(cx0, gy + 2.4, camZ);
  target = new THREE.Vector3(0, plan.site.heightAt(0, plan.site.center.z) + 5, plan.site.center.z * 0.55);
} else {
  // 부감: 방위(az)로 회전한 높은 시점 — 비정형 테두리·운해 halo 가 산수화 여백으로 읽히게.
  fov = 46;
  const az = azDeg * Math.PI / 180;
  const rad = 2.05 * R, hy = 1.15 * R;
  campos = new THREE.Vector3(Math.sin(az) * rad, hy, Math.cos(az) * rad);
  target = new THREE.Vector3(0, 0.05 * R, -0.10 * R);
}
const camera = new THREE.PerspectiveCamera(fov, innerWidth / innerHeight, 0.5, R * 8);
camera.position.set(num('cx', campos.x), num('cy', campos.y), num('cz', campos.z));
camera.lookAt(num('tx', target.x), num('ty', target.y), num('tz', target.z));

// 가상시간 결정론 스텝. cross 모드면 baseTime→toTime 을 steps 에 걸쳐 lerp(중간 프레임 촬영).
const toTime = cross ? cross.split('-')[1] : null;
let frame = 0;
renderer.setAnimationLoop(() => {
  if (cross && toTime) {
    const k = Math.min(1, frame / Math.max(1, steps - 1));
    applyLight(lerpLight(TIMES[baseTime], TIMES[toTime], k));
  }
  for (const fn of fogMods) { try { fn(scene); } catch (e) {} }   // villageFog: near/far + 헤이즈·운해색
  handle.update(dt);
  renderer.render(scene, camera);
  frame++;
  if (frame === steps) {
    const ri = renderer.info;
    window.__STATS = {
      scale, seed, R, character: plan.opts.character, stats: plan.stats,
      calls: ri.render.calls,
      triangles: ri.render.triangles, geometries: ri.memory.geometries, textures: ri.memory.textures,
    };
    window.__SHOT_READY = true;
  }
});
</script></body></html>`;

const server = createServer(async (req, res) => {
  const path = req.url.split('?')[0];
  if (path === '/__vclouds') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(HTML); return; }
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
  // 부감 3방위 — 비정형 테두리 + 운해가 "잘린 티" 없이 산수화 여백으로
  ['aerial-n', '/__vclouds?view=aerial&az=0&time=day&steps=30'],
  ['aerial-e', '/__vclouds?view=aerial&az=90&time=day&steps=30'],
  ['aerial-w', '/__vclouds?view=aerial&az=-90&time=day&steps=30'],
  ['aerial-sunset', '/__vclouds?view=aerial&az=20&time=sunset&steps=30'],
  ['aerial-night', '/__vclouds?view=aerial&az=20&time=night&steps=30'],
  // 아이레벨 — 골목/진입 시점 원경에 물안개·운해
  ['eye-day', '/__vclouds?view=eye&time=day&steps=30'],
  ['eye-sunset', '/__vclouds?view=eye&time=sunset&steps=30'],
  // 구름 그림자 드리프트 diff(같은 뷰, 가상시간 상이) — 뭉게구름·대응 그림자가 함께 이동(#68).
  //   창을 넓게(30 vs 480 프레임 ≈ 0.5s vs 8s) 잡아 표류가 눈에 띄게 보이도록.
  ['drift-a', '/__vclouds?view=aerial&az=0&time=day&steps=30'],
  ['drift-b', '/__vclouds?view=aerial&az=0&time=day&steps=480'],
  // 시간대 크로스페이드 중간 프레임(#50 정합 — 라이브 sun 판독으로 구름 그늘·틴트 연속)
  ['cross-day-sunset', '/__vclouds?view=aerial&az=20&cross=day-sunset&steps=30'],
  // 구름 옵트아웃(빌보드 소등 — 미스트 링·테두리는 유지). aerial-n 과 동일 프레이밍 → 빌보드 델타 계측.
  ['clouds-off', '/__vclouds?view=aerial&az=0&time=day&clouds=0&steps=30'],
  // 결정론(같은 seed 2회 stats 동일)
  ['det-1', '/__vclouds?view=aerial&az=0&time=day&shot=1&steps=20'],
  ['det-2', '/__vclouds?view=aerial&az=0&time=day&shot=1&steps=20'],
  // 규모/옵션
  ['hamlet-aerial', '/__vclouds?scale=hamlet&view=aerial&az=15&time=day&steps=30'],
  ['town-temple-aerial', '/__vclouds?scale=town&view=aerial&az=15&temple=1&time=sunset&steps=30'],
].filter(([name]) => !filter || name.includes(filter));

let browser;
try { browser = await chromium.launch({ channel: 'chrome' }); }
catch { browser = await chromium.launch(); }
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
let pageErrs = 0, consoleErrs = 0;
page.on('console', (m) => { if (m.type() === 'error') { const t = m.text(); if (/favicon|404/.test(t)) return; consoleErrs++; console.error('[console]', t); } });
page.on('pageerror', (e) => { pageErrs++; console.error('[pageerror]', e.message); });

const statsByName = {};
for (const [name, qs] of shots) {
  const url = `http://127.0.0.1:${port}${qs}`;
  await page.goto(url, { waitUntil: 'load' });
  try { await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 40000 }); }
  catch { console.error('TIMEOUT', name); }
  await page.waitForTimeout(200);
  const info = await page.evaluate(() => window.__STATS || null);
  if (info) {
    statsByName[name] = info;
    console.log(name, 'calls=' + info.calls,
      'tris=' + info.triangles, 'geo=' + info.geometries, 'tex=' + info.textures,
      JSON.stringify(info.stats));
  }
  const file = join(OUT, `vclouds-${name}.png`);
  await page.screenshot({ path: file });
  console.log('saved', file);
}
// 빌보드 draw call 델타(default aerial-n vs clouds-off, 동일 프레이밍)
if (statsByName['aerial-n'] && statsByName['clouds-off']) {
  const d = statsByName['aerial-n'].calls - statsByName['clouds-off'].calls;
  console.log('CLOUD BILLBOARD draw-call delta (aerial-n - clouds-off):', d, '(미스트 링 +1 별도)');
}
// 결정론 체크
if (statsByName['det-1'] && statsByName['det-2']) {
  const a = statsByName['det-1'], b = statsByName['det-2'];
  const same = a.calls === b.calls && a.triangles === b.triangles && a.geometries === b.geometries;
  console.log('DETERMINISM det-1 vs det-2:', same ? 'IDENTICAL stats' : 'DIFFER', JSON.stringify({ a: [a.calls, a.triangles, a.geometries], b: [b.calls, b.triangles, b.geometries] }));
}
console.log(`pageerror=${pageErrs} console-error=${consoleErrs} (favicon 404 제외)`);
await browser.close();
server.close();
