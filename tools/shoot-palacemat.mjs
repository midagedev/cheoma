// #149 궁 전각 재질 공유(P.mats) 측정 + 단청 파리티 하네스.
//   buildPalaceCompound(merge=true)로 populate 의 일곽 단위 병합을 재현하고,
//   그 위에 mergeStatic([compound])(= populate palaceMerged 의 일곽 교차 병합)을 얹어
//   "부감에서 실제로 렌더되는 궁 드로우콜 바닥"을 잰다. 재질 공유 전/후로 이 하네스를
//   같은 코드경로에 돌려 mesh/재질 수 델타 + 단청 스크린샷 파리티를 비교한다.
// 사용: node tools/shoot-palacemat.mjs [out=scratch|shots] [filter]
//   전용 포트 4272. 중간 컷 scratchpad/palacemat/.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..');
const dest = process.argv[2] === 'shots' ? 'shots' : 'scratch';
const OUT = dest === 'shots' ? join(ROOT, 'shots')
  : '/private/tmp/claude-501/-Users-hckim-repo-asiahouse/7a15478e-68e3-4ad3-b08a-bdb86ae4fe92/scratchpad/palacemat';
mkdirSync(OUT, { recursive: true });
const PFX = dest === 'shots' ? 'palacemat-' : '';
const PORT = 4272;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

const HTML = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>html,body{margin:0;height:100%;overflow:hidden;background:#c9d2da}#app{width:100%;height:100%}</style>
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.185.1/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.185.1/examples/jsm/"}}</script>
</head><body><div id="app"></div>
<script type="module">
import * as THREE from 'three';
import { buildPalaceCompound } from '/src/village/palace.js';
import { mergeStatic } from '/src/village/instancing.js';
const q = new URLSearchParams(location.search);
const tier = q.get('tier') || 'hanyang';
const view = q.get('view') || 'tq';
const time = q.get('time') || 'day';
const num = (k, d) => { const v = parseFloat(q.get(k)); return Number.isFinite(v) ? v : d; };
// 결정론 시드(팔레트 캔버스 얼룩)
{ let s = 0x2545f491 >>> 0; Math.random = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

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

const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400),
  new THREE.MeshStandardMaterial({ color: 0x9a8f76, roughness: 1 }));
ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);

// populate 재현: 일곽 단위 병합 컴파운드(merge=true) → palace-core 래핑 → 일곽 교차 병합(palaceMerged).
const shareMats = q.get('share') !== '0';   // ?share=0 → 구 동작(전각별 재질) A/B 측정
const compound = buildPalaceCompound({ tier, seed: 5, merge: true, shareMats });
const core = new THREE.Group(); core.name = 'palace-core'; core.add(compound);
// 일곽 단위 병합만 했을 때(= palace.js 산출)의 메시/재질 수
function countMats(root) {
  let meshes = 0; const mats = new Set();
  root.traverse((o) => { if (o.isMesh || o.isInstancedMesh) { meshes++; (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m && mats.add(m)); } });
  return { meshes, mats: mats.size };
}
const perIlgwak = countMats(core);
const palaceMerged = mergeStatic([core], 'palace-merged');
scene.add(palaceMerged);
const merged = countMats(palaceMerged);
// 진단: 병합 후 남은 재질을 (role, hasMap, repeat, color) 카테고리로 히스토그램.
function matHisto(root) {
  const seen = new Set(); const hist = {};
  root.traverse((o) => {
    if (!o.isMesh && !o.isInstancedMesh) return;
    (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => {
      if (!m || seen.has(m)) return; seen.add(m);
      const ud = m.userData || {};
      const mp = m.map ? 'map(' + m.map.repeat.x.toFixed(1) + ',' + m.map.repeat.y.toFixed(1) + ')' : 'nomap';
      const key = (ud.role || 'none') + '|' + mp + '|' + (m.color ? m.color.getHexString() : '-');
      hist[key] = (hist[key] || 0) + 1;
    });
  });
  return hist;
}
const histo = matHisto(palaceMerged);

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
  const asp = innerWidth / innerHeight;
  const half = D * 0.56;
  camera = new THREE.OrthographicCamera(-half * asp, half * asp, half, -half, 1, 1000);
  camera.position.set(0, 300, 0.01); camera.up.set(0, 0, -1); camera.lookAt(0, 0, 0);
} else if (view === 'tq') {
  camera = new THREE.PerspectiveCamera(38, innerWidth / innerHeight, 0.5, 1200);
  camera.position.set(W * 0.85, D * 0.62, D * 0.78); camera.lookAt(0, 6, -D * 0.05);
} else { // eye
  camera = new THREE.PerspectiveCamera(52, innerWidth / innerHeight, 0.3, 1200);
  camera.position.set(0, 6, D * 0.62); camera.lookAt(0, 8, -D * 0.2);
}
if (view === 'tq' || view === 'eye') {
  camera.position.set(num('cx', camera.position.x), num('cy', camera.position.y), num('cz', camera.position.z));
  camera.lookAt(num('tx', 0), num('ty', view === 'eye' ? 8 : 6), num('tz', view === 'eye' ? -D * 0.2 : -D * 0.05));
}

let frames = 0;
renderer.setAnimationLoop(() => {
  renderer.render(scene, camera); frames++;
  if (frames === 10) {
    const ri = renderer.info;
    window.__P = { tier, view,
      perIlgwakMeshes: perIlgwak.meshes, perIlgwakMats: perIlgwak.mats,
      mergedMeshes: merged.meshes, mergedMats: merged.mats,
      calls: ri.render.calls, triangles: ri.render.triangles, histo };
    window.__SHOT_READY = true;
  }
});
</script></body></html>`;

const server = createServer(async (req, res) => {
  const path = req.url.split('?')[0];
  if (path === '/__palacemat') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(HTML); return; }
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
  ['hanyang-tq', 'tier=hanyang&view=tq&time=sunset'],
  ['hanyang-top', 'tier=hanyang&view=top&time=day'],
  ['hanyang-eye', 'tier=hanyang&view=eye&time=day'],
  ['capital-tq', 'tier=capital&view=tq&time=day'],
].filter(([n]) => !filter || n.includes(filter));

let browser;
try { browser = await chromium.launch({ channel: 'chrome' }); } catch { browser = await chromium.launch(); }
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
let pageErrs = 0;
page.on('pageerror', (e) => { pageErrs++; console.error('[pageerror]', e.message); });
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) console.error('[console]', m.text()); });

for (const [name, qs] of shots) {
  await page.goto(`http://127.0.0.1:${PORT}/__palacemat?${qs}`, { waitUntil: 'load' });
  try { await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 60000 }); }
  catch { console.error('TIMEOUT', name); }
  await page.waitForTimeout(150);
  const info = await page.evaluate(() => window.__P);
  if (info) console.log(name,
    'per일곽[mesh=' + info.perIlgwakMeshes + ' mat=' + info.perIlgwakMats + ']',
    'palaceMerged[mesh=' + info.mergedMeshes + ' mat=' + info.mergedMats + ']',
    'calls=' + info.calls, 'tris=' + info.triangles);
  if (info && info.histo && name.includes('hanyang-tq')) {
    const rows = Object.entries(info.histo).filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]);
    console.log('  histo(count>=3):'); for (const [k, n] of rows) console.log('    ' + n + '  ' + k);
  }
  const file = join(OUT, `${PFX}${name}.png`);
  await page.screenshot({ path: file });
  console.log('saved', file);
}
console.log('pageerror=' + pageErrs);
await browser.close();
server.close();
