// 궁궐 다일곽 컴파운드(#88) 근접 검증. 컴파운드를 직접 import 해 평지 위에 렌더(앱 경로 우회).
//   전용 포트 4206 / 중간 컷은 scratchpad/palace2/, 게이트 증거는 shots/palace2-*.
// 사용: NODE_PATH=/Users/hckim/repo/threesur/node_modules node tools/shoot-palace2.mjs [out=scratch|shots] [filter]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..');
const dest = process.argv[2] === 'shots' ? 'shots' : 'scratch';
const OUT = dest === 'shots' ? join(ROOT, 'shots')
  : '/private/tmp/claude-501/-Users-hckim-repo-asiahouse/7a15478e-68e3-4ad3-b08a-bdb86ae4fe92/scratchpad/palace2';
mkdirSync(OUT, { recursive: true });
const PFX = dest === 'shots' ? 'palace2-' : '';
const PORT = 4206;

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

const HTML = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>html,body{margin:0;height:100%;overflow:hidden;background:#c9d2da}#app{width:100%;height:100%}</style>
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.185.1/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.185.1/examples/jsm/"}}</script>
</head><body><div id="app"></div>
<script type="module">
import * as THREE from 'three';
import { buildPalaceCompound } from '/src/village/palace.js';
const q = new URLSearchParams(location.search);
const tier = q.get('tier') || 'hanyang';
const view = q.get('view') || 'top';
const time = q.get('time') || 'day';
const num = (k, d) => { const v = parseFloat(q.get(k)); return Number.isFinite(v) ? v : d; };

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight); renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.getElementById('app').appendChild(renderer.domElement);
const scene = new THREE.Scene();
const L = time === 'sunset'
  ? { bg: 0xe7b98f, sun: [0xffb066, 2.2, [0.7, 0.7, 0.42]], hemi: [0xd7b48c, 0x7a6a54, 1.0], exp: 1.0 }
  : { bg: 0xcfd8e0, sun: [0xfff0dd, 2.6, [0.42, 1.25, 0.30]], hemi: [0xc4d6e8, 0x9a8c72, 1.25], exp: 1.05 };
scene.background = new THREE.Color(L.bg);
renderer.toneMappingExposure = L.exp;

// 평지 지면
const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400),
  new THREE.MeshStandardMaterial({ color: 0x9a8f76, roughness: 1 }));
ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);

const merge = q.get('merge') !== '0';
const palace = buildPalaceCompound({ tier, seed: 5, merge });
scene.add(palace);

const sun = new THREE.DirectionalLight(L.sun[0], L.sun[1]);
const S = 150;
sun.position.set(L.sun[2][0] * S, L.sun[2][1] * S, L.sun[2][2] * S);
sun.castShadow = true; sun.shadow.mapSize.set(4096, 4096);
const sc = sun.shadow.camera; sc.left = -120; sc.right = 120; sc.top = 120; sc.bottom = -120; sc.near = 1; sc.far = 600;
sun.shadow.bias = -0.0003; sun.shadow.normalBias = 0.06; scene.add(sun);
scene.add(new THREE.HemisphereLight(L.hemi[0], L.hemi[1], L.hemi[2]));

const D = tier === 'hanyang' ? 150 : 90;
const W = tier === 'hanyang' ? 96 : 60;
let camera;
if (view === 'top') {
  // 부감 top-down — 남(+z) 화면 아래, 북(-z) 위(참조 배치도와 동일 방향).
  const asp = innerWidth / innerHeight;
  const half = D * 0.56;
  camera = new THREE.OrthographicCamera(-half * asp, half * asp, half, -half, 1, 1000);
  camera.position.set(0, 300, 0.01);
  camera.up.set(0, 0, -1);
  camera.lookAt(0, 0, 0);
} else if (view === 'tq') {
  // 3/4 부감 — 지붕 위계 스카이라인
  camera = new THREE.PerspectiveCamera(38, innerWidth / innerHeight, 0.5, 1200);
  camera.position.set(W * 0.85, D * 0.62, D * 0.78);
  camera.lookAt(0, 6, -D * 0.05);
} else { // eye — 축선 남측 진입(게이트 시퀀스)
  camera = new THREE.PerspectiveCamera(52, innerWidth / innerHeight, 0.3, 1200);
  camera.position.set(0, 6, D * 0.62);
  camera.lookAt(0, 8, -D * 0.2);
}
if (view !== 'top') {
  camera.position.set(num('cx', camera.position.x), num('cy', camera.position.y), num('cz', camera.position.z));
  camera.lookAt(num('tx', 0), num('ty', view === 'eye' ? 8 : 6), num('tz', view === 'eye' ? -D * 0.2 : -D * 0.05));
}

let frames = 0;
renderer.setAnimationLoop(() => {
  renderer.render(scene, camera); frames++;
  if (frames === 10) {
    const ri = renderer.info;
    let meshes = 0; palace.traverse((o) => { if (o.isMesh) meshes++; });
    window.__P = { tier, view, meshes, calls: ri.render.calls, triangles: ri.render.triangles,
      handle: palace.userData.palaceHandle ? { areas: palace.userData.palaceHandle.areas.map((a) => a.role) } : null };
    window.__SHOT_READY = true;
  }
});
</script></body></html>`;

const server = createServer(async (req, res) => {
  const path = req.url.split('?')[0];
  if (path === '/__palace2') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(HTML); return; }
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
  ['hanyang-top', 'tier=hanyang&view=top&time=day'],
  ['hanyang-tq', 'tier=hanyang&view=tq&time=sunset'],
  ['hanyang-eye', 'tier=hanyang&view=eye&time=day'],
  ['capital-top', 'tier=capital&view=top&time=day'],
  ['capital-tq', 'tier=capital&view=tq&time=day'],
].filter(([n]) => !filter || n.includes(filter));

let browser;
try { browser = await chromium.launch({ channel: 'chrome' }); } catch { browser = await chromium.launch(); }
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
let pageErrs = 0;
page.on('pageerror', (e) => { pageErrs++; console.error('[pageerror]', e.message); });
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) console.error('[console]', m.text()); });

for (const [name, qs] of shots) {
  await page.goto(`http://127.0.0.1:${PORT}/__palace2?${qs}`, { waitUntil: 'load' });
  try { await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 60000 }); }
  catch { console.error('TIMEOUT', name); }
  await page.waitForTimeout(150);
  const info = await page.evaluate(() => window.__P);
  if (info) console.log(name, 'meshes=' + info.meshes, 'calls=' + info.calls, 'tris=' + info.triangles, 'areas=' + JSON.stringify(info.handle && info.handle.areas));
  const file = join(OUT, `${PFX}${name}.png`);
  await page.screenshot({ path: file });
  console.log('saved', file);
}
console.log('pageerror=' + pageErrs);
await browser.close();
server.close();
