// 헤드리스 검증(태스크 #73): 처마 등롱 야간 blowout 톤다운 + 야간 구름 무드.
//   단일 씬(env 전체: sky 등롱 + clouds)을 시간대별로 렌더해 등롱·구름을 검수한다.
//   컷: 등롱 야간(giwa 3q · choga closeup), 주간 소등, 석양 중간 점등, 야간 구름 부감, 석양 구름(무회귀).
//   앱 단일건물 경로 재현(shoot-hanji.mjs 준용): scene → setupEnvironment → setupPost →
//     buildBuilding → setupNightGlow. 매 프레임 env.update/nightGlow.update/post.update.
//   출력 기본 scratchpad(반복), ENVNIGHT_OUT=shots 로 게이트(envnight-*.png).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = process.env.ENVNIGHT_OUT === 'shots'
  ? join(ROOT, 'shots')
  : '/private/tmp/claude-501/-Users-hckim-repo-asiahouse/7a15478e-68e3-4ad3-b08a-bdb86ae4fe92/scratchpad/envnight';
const PREFIX = process.env.ENVNIGHT_OUT === 'shots' ? 'envnight-' : '';
mkdirSync(OUT, { recursive: true });

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json',
};

const HTML = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>html,body{margin:0;height:100%;overflow:hidden;background:#000}#app{width:100%;height:100%}</style>
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.185.1/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.185.1/examples/jsm/"}}</script>
</head><body><div id="app"></div>
<script type="module">
import * as THREE from 'three';
import { computeLayout, PRESETS } from '/src/params.js';
import { buildBuilding } from '/src/builder/index.js';
import { setupEnvironment } from '/src/env/index.js';
import { setupPost } from '/src/env/post.js';
import { setupNightGlow } from '/src/env/night-glow.js';

const q = new URLSearchParams(location.search);
const preset = q.get('preset') || 'giwa';
const time = q.get('time') || 'night';
const view = q.get('view') || '3q';         // 3q | closeup | clouds
const num = (k, d) => { const v = parseFloat(q.get(k)); return Number.isFinite(v) ? v : d; };

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
document.getElementById('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xcfd8e0);
scene.fog = new THREE.Fog(0xcfd8e0, 60, 220);

const sun = new THREE.DirectionalLight(0xfff0dd, 2.6);
sun.position.set(30, 42, 26);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -22; sun.shadow.camera.right = 22;
sun.shadow.camera.top = 22; sun.shadow.camera.bottom = -22;
sun.shadow.bias = -0.0001; sun.shadow.normalBias = 0.05;
scene.add(sun);
const hemi = new THREE.HemisphereLight(0xbdd0e4, 0x8a7a63, 0.9);
scene.add(hemi);
const fill = new THREE.DirectionalLight(0xff9a5c, 0);
fill.castShadow = false; scene.add(fill); scene.add(fill.target);

const ground = new THREE.Mesh(
  new THREE.CircleGeometry(160, 48),
  new THREE.MeshStandardMaterial({ color: 0xb5a893, roughness: 1 }));
ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);

const P = { ...PRESETS[preset] };
const env = setupEnvironment(scene, { sun, hemi, renderer, layout: computeLayout(P) });
const camera = new THREE.PerspectiveCamera(38, innerWidth / innerHeight, 0.1, 500);
const post = setupPost({ renderer, scene, camera });
post.setSize(innerWidth, innerHeight);

env.setTime(time); env.setEnabled(true); post.setTime(time);

let building = buildBuilding(P);
scene.add(building);

const nightGlow = setupNightGlow({ getBuilding: () => building });
nightGlow.setEnabled(true);
nightGlow.setTime(time);

const box = new THREE.Box3().setFromObject(building);
const c = box.getCenter(new THREE.Vector3());
const size = box.getSize(new THREE.Vector3());
const maxDim = Math.max(size.x, size.y, size.z);
window.__PLAN = { preset, time, view, size: [size.x, size.y, size.z].map((v)=>+v.toFixed(2)) };

let campos, target, fov;
const DEG = Math.PI / 180;
if (view === 'closeup') {
  fov = 34;
  campos = new THREE.Vector3(c.x - size.x * 0.18, c.y + size.y * 0.05, c.z + maxDim * 0.95);
  target = new THREE.Vector3(c.x - size.x * 0.18, c.y - size.y * 0.05, c.z);
} else if (view === 'clouds') {
  // 부감 디오라마: 지형은 하반, 하늘·구름·능선은 상반. 구름 빌보드(y76~108, r60~124)가 프레임 중상단에.
  fov = 52;
  campos = new THREE.Vector3(150, 128, 190);
  target = new THREE.Vector3(0, 34, -10);
} else { // 3q
  fov = 36;
  const az = 32 * DEG, el = 16 * DEG, r = maxDim * 2.0;
  campos = new THREE.Vector3(c.x + r * Math.cos(el) * Math.sin(az), c.y + size.y * 0.28 + r * Math.sin(el), c.z + r * Math.cos(el) * Math.cos(az));
  target = new THREE.Vector3(c.x, c.y + size.y * 0.02, c.z);
}
camera.fov = num('fov', fov);
camera.position.set(num('cx', campos.x), num('cy', campos.y), num('cz', campos.z));
camera.lookAt(num('tx', target.x), num('ty', target.y), num('tz', target.z));
camera.updateProjectionMatrix();

// 발광 계측: 화면 웜(붉은기) 밝은 픽셀 분포 — 형광(과다 blowout) 판정용(shoot-hanji 와 동일 기준).
function glowStats() {
  const cvs = renderer.domElement, w = cvs.width, h = cvs.height;
  const c2 = document.createElement('canvas'); c2.width = w; c2.height = h;
  const ctx = c2.getContext('2d'); ctx.drawImage(cvs, 0, 0);
  const data = ctx.getImageData(0, 0, w, h).data;
  let hot = 0, warm = 0, sum = 0, maxL = 0, npx = w * h;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const L = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    sum += L; if (L > maxL) maxL = L;
    if (r > b + 18 && L > 0.30) warm++;
    if (r > 210 && g > 190 && L > 0.82) hot++;   // 형광 blowout(거의 흰 크림)
  }
  return { warmPct: +(100 * warm / npx).toFixed(3), hotPct: +(100 * hot / npx).toFixed(3), maxL: +maxL.toFixed(3), meanL: +(sum / npx).toFixed(4) };
}

let frame = 0;
renderer.setAnimationLoop(() => {
  env.update(1 / 60);
  nightGlow.update(1 / 60);
  post.update();
  frame++;
  if (frame === 24) {
    post.composer.render();
    window.__STATS = glowStats();
    window.__SHOT_READY = true;
  } else { post.composer.render(); }
});
</script></body></html>`;

const server = createServer(async (req, res) => {
  const path = req.url.split('?')[0];
  if (path === '/__envnight') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(HTML); return; }
  try {
    const file = join(ROOT, path === '/' ? 'index.html' : path);
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const port = server.address().port;

// 컷 목록: [name, query]. shot=1 로 구름 표류 t=0 고정(결정론).
const shots = [
  ['giwa-3q-night',    'preset=giwa&time=night&view=3q&shot=1'],
  ['choga-closeup-night', 'preset=choga&time=night&view=closeup&shot=1'],
  ['korea-3q-night',   'preset=korea&time=night&view=3q&shot=1'],
  ['giwa-3q-day',      'preset=giwa&time=day&view=3q&shot=1'],
  ['giwa-3q-sunset',   'preset=giwa&time=sunset&view=3q&shot=1'],
  ['clouds-night',     'preset=giwa&time=night&view=clouds&shot=1'],
  ['clouds-sunset',    'preset=giwa&time=sunset&view=clouds&shot=1'],
];
const filter = process.argv[2] || '';
const list = shots.filter(([name]) => !filter || name.includes(filter));

let browser;
try { browser = await chromium.launch({ channel: 'chrome' }); }
catch { browser = await chromium.launch(); }

let pageErrs = 0, consoleErrs = 0;
for (const [name, qs] of list) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('console', (msg) => { if (msg.type() === 'error') { const t = msg.text(); if (!/favicon|404/.test(t)) { consoleErrs++; console.error('[console]', name, t); } } });
  page.on('pageerror', (err) => { pageErrs++; console.error('[pageerror]', name, err.message); });
  await page.goto(`http://127.0.0.1:${port}/__envnight?${qs}`, { waitUntil: 'load' });
  try { await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 40000 }); }
  catch { console.error('TIMEOUT', name); }
  await page.waitForTimeout(120);
  const info = await page.evaluate(() => ({ plan: window.__PLAN, stats: window.__STATS }));
  await page.screenshot({ path: join(OUT, `${PREFIX}${name}.png`) });
  const s = info.stats || {};
  console.log(`${name.padEnd(20)} warm%=${s.warmPct} hot%=${s.hotPct} maxL=${s.maxL} meanL=${s.meanL}`);
  await page.close();
}
console.log(`pageerror=${pageErrs} console-error=${consoleErrs}`);
await browser.close();
server.close();
