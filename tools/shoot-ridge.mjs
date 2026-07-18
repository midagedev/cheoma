// #97 팔작지붕 용마루 소실 + 부속채 지붕 관통 검증. buildBuilding·buildPalaceCompound 직접 import.
//   전용 포트 4212 / 중간 컷 scratchpad/ridge/, 게이트 증거 shots/ridge-*.
// 사용: NODE_PATH=/Users/hckim/repo/threesur/node_modules node tools/shoot-ridge.mjs [out=scratch|shots] [filter]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..');
const dest = process.argv[2] === 'shots' ? 'shots' : 'scratch';
const OUT = dest === 'shots' ? join(ROOT, 'shots')
  : '/private/tmp/claude-501/-Users-hckim-repo-asiahouse/7a15478e-68e3-4ad3-b08a-bdb86ae4fe92/scratchpad/ridge';
mkdirSync(OUT, { recursive: true });
const PFX = dest === 'shots' ? 'ridge-' : '';
const PORT = 4212;

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

const HTML = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>html,body{margin:0;height:100%;overflow:hidden;background:#c9d2da}#app{width:100%;height:100%}</style>
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.185.1/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.185.1/examples/jsm/"}}</script>
</head><body><div id="app"></div>
<script type="module">
import * as THREE from 'three';
import { buildBuilding } from '/src/builder/index.js';
import { buildPalaceCompound } from '/src/village/palace.js';
import { PRESETS, computeLayout } from '/src/params.js';
const q = new URLSearchParams(location.search);
const mode = q.get('mode') || 'single';   // single | palace
const view = q.get('view') || 'tq';        // tq | top
const num = (k, d) => { const v = parseFloat(q.get(k)); return Number.isFinite(v) ? v : d; };
const str = (k, d) => q.get(k) ?? d;

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight); renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
document.getElementById('app').appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xcfd8e0);

const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400),
  new THREE.MeshStandardMaterial({ color: 0x9a8f76, roughness: 1 }));
ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);

// palace.js hallPreset 축소 재현 (소전각 프리셋 스윕용)
const k = PRESETS.korea;
function smallPreset(fb, sb) {
  return { ...k, frontBays: fb, sideBays: sb, columnHeight: 3.4, bracketTiers: 1, interBrackets: 1,
    centerBayW: 3.2, middleBayW: 2.8, endBayW: 2.4, ridgeH: 0.42, podiumTiers: 1, podiumTierH: 0.6, podiumRailing: false };
}

let target = new THREE.Vector3(0, 3, 0);
let camDist = 22, camH = 14;
let focusObj = null;

function overlap(a, b) {  // 두 AABB 의 x·z 교차량(음수=이격). min 이 양수면 관통.
  const dx = Math.min(a.max.x, b.max.x) - Math.max(a.min.x, b.min.x);
  const dz = Math.min(a.max.z, b.max.z) - Math.max(a.min.z, b.min.z);
  return { dx: +dx.toFixed(2), dz: +dz.toFixed(2), hit: dx > 0.15 && dz > 0.15 };
}
function bboxByName(root, name) {
  let obj = null; root.traverse((o) => { if (o.name === name) obj = o; });
  return obj ? new THREE.Box3().setFromObject(obj) : null;
}

if (mode === 'palace') {
  const tier = str('tier', 'hanyang');
  const palace = buildPalaceCompound({ tier, seed: 5, merge: false });   // 측정 위해 미병합
  scene.add(palace);
  window.__P = { tier };
  // 결함 ② 겹침 판정: 침전 본채↔위성, 궐내각사 셀 상호.
  const boxes = {};
  for (const n of ['hall-chimjeon', 'sat-chimjeon-e', 'sat-chimjeon-w',
    'gwolnaegaksa-cell0', 'gwolnaegaksa-cell1', 'gwolnaegaksa-cell2', 'gwolnaegaksa-cell3']) {
    const bx = bboxByName(palace, n); if (bx) boxes[n] = bx;
  }
  const checks = {};
  if (boxes['hall-chimjeon'] && boxes['sat-chimjeon-e']) checks['hall_x_sat-e'] = overlap(boxes['hall-chimjeon'], boxes['sat-chimjeon-e']);
  if (boxes['hall-chimjeon'] && boxes['sat-chimjeon-w']) checks['hall_x_sat-w'] = overlap(boxes['hall-chimjeon'], boxes['sat-chimjeon-w']);
  // 셀 격자: cell0(-z,-x) cell1(-z,+x) cell2(+z,-x) cell3(+z,+x). 인접쌍만.
  if (boxes['gwolnaegaksa-cell0'] && boxes['gwolnaegaksa-cell1']) checks['cell0_x_cell1'] = overlap(boxes['gwolnaegaksa-cell0'], boxes['gwolnaegaksa-cell1']);
  if (boxes['gwolnaegaksa-cell0'] && boxes['gwolnaegaksa-cell2']) checks['cell0_x_cell2'] = overlap(boxes['gwolnaegaksa-cell0'], boxes['gwolnaegaksa-cell2']);
  if (boxes['gwolnaegaksa-cell1'] && boxes['gwolnaegaksa-cell3']) checks['cell1_x_cell3'] = overlap(boxes['gwolnaegaksa-cell1'], boxes['gwolnaegaksa-cell3']);
  if (boxes['gwolnaegaksa-cell2'] && boxes['gwolnaegaksa-cell3']) checks['cell2_x_cell3'] = overlap(boxes['gwolnaegaksa-cell2'], boxes['gwolnaegaksa-cell3']);
  window.__P.checks = checks;
  // 금천교 치수(#97 축소 검증) — 노면 최고점 y·크로싱·통행 폭.
  let bridge = null;
  palace.traverse((o) => { if (o.name === 'bridge-slab' || o.name === 'bridge-arch') bridge = o; });
  if (bridge) {
    const bb = new THREE.Box3().setFromObject(bridge);
    window.__P.bridge = {
      type: bridge.name, topY: +bb.max.y.toFixed(2),
      dz: +(bb.max.z - bb.min.z).toFixed(2), dx: +(bb.max.x - bb.min.x).toFixed(2),
    };
  }
  // 진입 시퀀스 게이트 존재 확인(광화문→흥례문→정전문).
  const gateNames = ['gate-gwanghwamun', 'gate-heungryemun'];
  let gates = 0; palace.traverse((o) => { if (gateNames.includes(o.name)) gates++; });
  window.__P.gates = gates;
  // 궐내각사(-x) 일곽 중심으로 프레이밍
  const h = palace.userData.palaceHandle;
  const gaksa = h && h.areas.find((a) => a.role === 'gwolnaegaksa');
  if (gaksa) { target.set(gaksa.center.x, 4, gaksa.center.z); camDist = 34; camH = 30; }
  const chim = h && h.areas.find((a) => a.role === 'chimjeon');
  const f = str('focus', 'gaksa');
  if (f === 'chim' && chim) { target.set(chim.center.x, 4, chim.center.z); camDist = 40; camH = 34; }
  if (f === 'whole') { target.set(0, 6, -10); camDist = 150; camH = 110; }
} else {
  const preset = str('preset', '');
  const fb = num('fb', 3), sb = num('sb', 3);
  const P = preset ? { ...PRESETS[preset] } : smallPreset(fb, sb);   // 회귀: 절·초가·korea 원 프리셋
  const b = buildBuilding(P);
  scene.add(b);
  focusObj = b;
  const L = computeLayout(P);
  window.__P = { fb, sb, W: L.W, D: L.D, ridge2: L.ridgeHalf * 2, ridgeToW: (L.ridgeHalf * 2) / L.W };
  target.set(0, L.ridgeY * 0.55, 0);
  camDist = Math.max(L.xEave, L.zEave) * 2.1;
  camH = L.ridgeY * 1.4 + Math.max(L.xEave, L.zEave) * 0.9;
}

let camera;
if (view === 'top') {
  const asp = innerWidth / innerHeight;
  const half = camDist * 0.62;
  camera = new THREE.OrthographicCamera(-half * asp, half * asp, half, -half, 1, 2000);
  camera.position.set(target.x, 300, target.z + 0.01);
  camera.up.set(0, 0, -1);
  camera.lookAt(target.x, 0, target.z);
} else {
  camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.3, 2000);
  camera.position.set(target.x + camDist * 0.55, camH, target.z + camDist * 0.85);
  camera.lookAt(target);
}

const sun = new THREE.DirectionalLight(0xfff0dd, 2.6);
const S = 150; sun.position.set(0.42 * S, 1.25 * S, 0.30 * S);
sun.castShadow = true; sun.shadow.mapSize.set(4096, 4096);
const sc = sun.shadow.camera; sc.left = -120; sc.right = 120; sc.top = 120; sc.bottom = -120; sc.near = 1; sc.far = 600;
sun.shadow.bias = -0.0003; sun.shadow.normalBias = 0.06; scene.add(sun);
scene.add(new THREE.HemisphereLight(0xc4d6e8, 0x9a8c72, 1.25));

let frames = 0;
renderer.setAnimationLoop(() => {
  renderer.render(scene, camera); frames++;
  if (frames === 8) window.__SHOT_READY = true;
});
</script></body></html>`;

const server = createServer(async (req, res) => {
  const path = req.url.split('?')[0];
  if (path === '/__ridge') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(HTML); return; }
  try {
    const file = join(ROOT, path === '/' ? 'index.html' : path);
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise((ok) => server.listen(PORT, '127.0.0.1', ok));

const filter = process.argv[3] || '';
const shots = [
  ['sweep-3x3-tq', 'mode=single&view=tq&fb=3&sb=3'],
  ['sweep-3x3-top', 'mode=single&view=top&fb=3&sb=3'],
  ['sweep-3x2-tq', 'mode=single&view=tq&fb=3&sb=2'],
  ['sweep-3x2-top', 'mode=single&view=top&fb=3&sb=2'],
  ['sweep-5x3-tq', 'mode=single&view=tq&fb=5&sb=3'],
  ['sweep-5x3-top', 'mode=single&view=top&fb=5&sb=3'],
  ['gaksa-tq', 'mode=palace&view=tq&focus=gaksa'],
  ['gaksa-top', 'mode=palace&view=top&focus=gaksa'],
  ['chim-tq', 'mode=palace&view=tq&focus=chim'],
  ['hanyang-tq', 'mode=palace&view=tq&focus=whole'],
  ['regress-temple', 'mode=single&view=tq&preset=temple'],
  ['regress-choga', 'mode=single&view=tq&preset=choga'],
  ['measure-hanyang', 'mode=palace&view=tq&focus=whole'],
  ['measure-capital', 'mode=palace&view=tq&focus=whole&tier=capital'],
].filter(([n]) => !filter || n.includes(filter));

let browser;
try { browser = await chromium.launch({ channel: 'chrome' }); } catch { browser = await chromium.launch(); }
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
let pageErrs = 0;
page.on('pageerror', (e) => { pageErrs++; console.error('[pageerror]', e.message); });
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) console.error('[console]', m.text()); });

for (const [name, qs] of shots) {
  await page.goto(`http://127.0.0.1:${PORT}/__ridge?${qs}`, { waitUntil: 'load' });
  try { await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 60000 }); }
  catch { console.error('TIMEOUT', name); }
  await page.waitForTimeout(120);
  const info = await page.evaluate(() => window.__P);
  console.log(name, JSON.stringify(info));
  if (name.includes('measure')) continue;   // 측정 전용: 스크린샷 생략(시각검증 중단)
  const file = join(OUT, `${PFX}${name}.png`);
  await page.screenshot({ path: file });
  console.log('saved', file);
}
console.log('pageerror=' + pageErrs);
await browser.close();
server.close();
