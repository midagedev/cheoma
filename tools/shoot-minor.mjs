// 헤드리스 스크린샷: 조연 건물(정자·돌다리) 검증 → shots/minor-*.png
// 사용법: NODE_PATH=/Users/hckim/repo/threesur/node_modules node tools/shoot-minor.mjs
//   - 정자: 사모/육모 × day/sunset/night (night 창호광 오작동 없음 확인)
//   - 돌다리: 판석교·홍예교 개울 위 배치
//   - 회귀: index.html?shot=1 korea day (pageerror 0 확인)
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

// 검증 전용 인라인 하네스(프로젝트 HTML 불침해). pavilion/bridge 를 직접 import,
// 카메라를 오브젝트에 맞춰 놓는다(메인 카메라 리그는 건물 고정이므로 조연은 자체 프레이밍).
const MINOR_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>html,body{margin:0;height:100%;overflow:hidden}#app{width:100%;height:100%}</style>
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.185.1/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.185.1/examples/jsm/"}}</script>
</head><body><div id="app"></div>
<script type="module">
import * as THREE from 'three';
import { buildPavilion } from '/src/builder/pavilion.js';
import { buildBridge } from '/src/builder/bridge.js';
import { setupNightGlow } from '/src/env/night-glow.js';
const q = new URLSearchParams(location.search);
const obj = q.get('obj') || 'pavilion';
const time = q.get('time') || 'day';
const sides = parseInt(q.get('sides') || '6', 10);
const btype = q.get('type') || 'arch';
const num = (k, d) => { const v = parseFloat(q.get(k)); return Number.isFinite(v) ? v : d; };

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight); renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.getElementById('app').appendChild(renderer.domElement);
const scene = new THREE.Scene();

// 시간대 라이팅
const L = {
  day:    { bg: 0xcfd8e0, sun: [0xfff0dd, 2.6, [16,26,14]], hemi: [0xbdd0e4, 0x8a7a63, 0.9], exp: 1.05 },
  sunset: { bg: 0xe7b98f, sun: [0xffb066, 2.1, [22,10,10]], hemi: [0xd7b48c, 0x6a5a48, 0.7], exp: 1.0 },
  night:  { bg: 0x141a26, sun: [0xaec4ff, 0.55, [-14,20,10]], hemi: [0x2a3550, 0x0e1018, 0.35], exp: 1.1 },
}[time] || {};
scene.background = new THREE.Color(L.bg);
scene.fog = new THREE.Fog(L.bg, 40, 120);
renderer.toneMappingExposure = L.exp;
const sun = new THREE.DirectionalLight(L.sun[0], L.sun[1]);
sun.position.set(...L.sun[2]); sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -14; sun.shadow.camera.right = 14; sun.shadow.camera.top = 14; sun.shadow.camera.bottom = -14;
sun.shadow.bias = -0.0002; sun.shadow.normalBias = 0.04; scene.add(sun);
scene.add(new THREE.HemisphereLight(L.hemi[0], L.hemi[1], L.hemi[2]));

let target = new THREE.Vector3(0, 3.2, 0);
let campos = new THREE.Vector3(7.5, 5.5, 9.5);

if (obj === 'bridge') {
  // 개울 + 둑: 물 채널(중앙) + 흙 둑(양쪽). 다리는 X 로 개울을 가로지른다.
  const earth = new THREE.Mesh(new THREE.PlaneGeometry(60, 60),
    new THREE.MeshStandardMaterial({ color: 0x9a8c74, roughness: 1 }));
  earth.rotation.x = -Math.PI / 2; earth.position.y = -0.02; earth.receiveShadow = true; scene.add(earth);
  const water = new THREE.Mesh(new THREE.PlaneGeometry(2.8, 40),
    new THREE.MeshStandardMaterial({ color: 0x35566a, roughness: 0.16, metalness: 0.4 }));
  water.rotation.x = -Math.PI / 2; water.position.set(0, 0.0, 0); water.receiveShadow = true; scene.add(water);
  const bridge = buildBridge({ type: btype, span: 4.6, width: 1.6 });
  scene.add(bridge);
  target = new THREE.Vector3(0, 1.0, 0);
  campos = new THREE.Vector3(5.6, 2.4, 6.6);
} else {
  const ground = new THREE.Mesh(new THREE.CircleGeometry(40, 40),
    new THREE.MeshStandardMaterial({ color: 0xb0a58f, roughness: 1 }));
  ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);
  const pav = buildPavilion({ sides });
  scene.add(pav);
  // ?glowtest=1: 창호광 시스템을 굳이 정자에 물렸을 때의 거동을 실증.
  //  → 창호 emissive 발광은 정자에 door/hanji 메시가 없어 안 뜬다(정상).
  //    단 night-glow 는 getBuilding() 안에 실내 등불 2개를 넣으므로 조연은 대상에서
  //    제외해야 한다(기본 야간 컷은 배선하지 않음 = 순수 달빛).
  if (time === 'night' && q.get('glowtest') === '1') {
    const ng = setupNightGlow({ getBuilding: () => pav });
    ng.setEnabled(true); ng.setTime('night');
  }
  target = new THREE.Vector3(0, (pav.userData.height || 7) * 0.42, 0);
  campos = new THREE.Vector3(8.5, 5.8, 10.5);
}
const camera = new THREE.PerspectiveCamera(32, innerWidth / innerHeight, 0.1, 400);
camera.position.set(num('cx', campos.x), num('cy', campos.y), num('cz', campos.z));
camera.lookAt(num('tx', target.x), num('ty', target.y), num('tz', target.z));

let frames = 0; const clock = new THREE.Clock();
renderer.setAnimationLoop(() => { clock.getDelta(); renderer.render(scene, camera); frames++; if (frames === 12) window.__SHOT_READY = true; });
</script></body></html>`;

const server = createServer(async (req, res) => {
  const path = req.url.split('?')[0];
  if (path === '/__minor') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(MINOR_HTML); return; }
  try {
    const file = join(ROOT, path === '/' ? 'index.html' : path);
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const port = server.address().port;

// [파일접미사, 경로+쿼리]
const shots = [
  ['pavilion-hex-day', '/__minor?obj=pavilion&sides=6&time=day'],
  ['pavilion-hex-sunset', '/__minor?obj=pavilion&sides=6&time=sunset'],
  ['pavilion-hex-night', '/__minor?obj=pavilion&sides=6&time=night'],
  ['pavilion-hex-night-glowtest', '/__minor?obj=pavilion&sides=6&time=night&glowtest=1'],
  ['pavilion-square-day', '/__minor?obj=pavilion&sides=4&time=day'],
  ['pavilion-hex-closeup', '/__minor?obj=pavilion&sides=6&time=day&cx=4.5&cy=6.8&cz=5.5&tx=0&ty=5.8&tz=0'],
  ['bridge-arch-day', '/__minor?obj=bridge&type=arch&time=day'],
  ['bridge-arch-side', '/__minor?obj=bridge&type=arch&time=day&cx=0.5&cy=1.6&cz=8&tx=0&ty=1.1&tz=0'],
  ['bridge-slab-day', '/__minor?obj=bridge&type=slab&time=day'],
  ['bridge-arch-sunset', '/__minor?obj=bridge&type=arch&time=sunset'],
  // 회귀: 메인 4종 프리셋(korea day) — pageerror 0 확인
  ['regress-korea-day', '/index.html?shot=1&env=1&preset=korea&angle=three-quarter&time=day'],
];

let browser;
try { browser = await chromium.launch({ channel: 'chrome' }); }
catch { browser = await chromium.launch(); }
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
let pageErrs = 0, consoleErrs = 0;
// Chrome 이 자동 요청하는 /favicon.ico 404 는 무해 → 집계 제외.
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
  await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 30000 });
  await page.waitForTimeout(250);
  const file = join(OUT, `minor-${name}.png`);
  await page.screenshot({ path: file });
  console.log('saved', file);
}
console.log(`pageerror=${pageErrs} console-error=${consoleErrs} (favicon 404 제외)`);
console.log(pageErrs === 0 && consoleErrs === 0 ? 'OK: no page/console errors' : 'WARN: errors present');

await browser.close();
server.close();
