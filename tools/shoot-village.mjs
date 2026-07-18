// 헤드리스 스크린샷: 마을 자동 구성(village) 검증 → shots/village-*.png
// 사용법: NODE_PATH=/Users/hckim/repo/threesur/node_modules node tools/shoot-village.mjs [필터]
//   [필터] 인자가 있으면 파일명에 그 문자열이 포함된 컷만 촬영(반복 개발용).
//   메인 카메라 리그(건물 고정)와 무관하게 자체 프레이밍(부감/아이레벨)을 쓴다.
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

const VILLAGE_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>html,body{margin:0;height:100%;overflow:hidden}#app{width:100%;height:100%}</style>
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.185.1/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.185.1/examples/jsm/"}}</script>
</head><body><div id="app"></div>
<script type="module">
import * as THREE from 'three';
import { planVillage } from '/src/village/plan.js';
import { populateVillage } from '/src/village/populate.js';
const q = new URLSearchParams(location.search);
const scale = q.get('scale') || 'village';
const seedRaw = q.get('seed');
const seed = seedRaw != null ? (isNaN(+seedRaw) ? seedRaw : +seedRaw) : 20260716;
const includePalace = q.get('palace') === '1';
const includeTemple = q.get('temple') === '1';
const character = q.get('char') || 'yeoyeom';
const view = q.get('view') || 'aerial';
const time = q.get('time') || 'day';
const num = (k, d) => { const v = parseFloat(q.get(k)); return Number.isFinite(v) ? v : d; };

// 결정론 렌더: 공유 팔레트(palette.js 캔버스 텍스처)·사립문(gate.js)이 Math.random 을 쓰므로
// 같은 seed 재현 컷이 픽셀 동일하도록 하네스에서 Math.random 을 시드 xorshift 로 고정한다.
// (앱 소스 불침해 — 검증 하네스 국한. 마을 배치 자체는 이미 makeRng 로 완전 결정론.)
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

// 마을 생성
const plan = planVillage({ scale, seed, includePalace, includeTemple, character });
const group = populateVillage(plan);
scene.add(group);
window.__PLAN = { scale, seed, character: plan.opts.character, stats: plan.stats, warnings: plan.warnings, R: plan.site.R };

const R = plan.site.R;
scene.fog = new THREE.Fog(L.bg, R * 2.4, R * 7.0);

// 태양(방위 벡터 × 거리) — 부감에서 그림자로 위계·마당이 읽히게
const sun = new THREE.DirectionalLight(L.sun[0], L.sun[1]);
sun.position.set(L.sun[2][0] * R, L.sun[2][1] * R, L.sun[2][2] * R);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
const TR = plan.site.terrainR || R;
const sc = sun.shadow.camera;
sc.left = -TR * 1.05; sc.right = TR * 1.05; sc.top = TR * 1.05; sc.bottom = -TR * 1.05;
sc.near = 1; sc.far = TR * 8;
sun.shadow.bias = -0.0003; sun.shadow.normalBias = 0.08;
scene.add(sun);
scene.add(new THREE.HemisphereLight(L.hemi[0], L.hemi[1], L.hemi[2]));

// 카메라 프레이밍
const cen = plan.site.center;
let campos, target, fov;
if (view === 'aerial') {
  fov = 44;
  campos = new THREE.Vector3(0.18 * R, 1.02 * R, 1.98 * R);
  target = new THREE.Vector3(0, 0.06 * R, -0.16 * R);
} else if (view === 'aerial-high') {
  fov = 40;
  campos = new THREE.Vector3(0.02 * R, 2.1 * R, 1.5 * R);
  target = new THREE.Vector3(0, 0, -0.05 * R);
} else {
  // 아이레벨: 개울 앞(남)에서 마을·배산을 바라보는 진입 접근뷰
  const camZ = plan.site.streamZ + R * 0.34;
  const cx0 = R * 0.04;
  const gy = plan.site.heightAt(cx0, camZ);
  fov = 52;
  campos = new THREE.Vector3(cx0, gy + 2.4, camZ);
  target = new THREE.Vector3(0, plan.site.heightAt(0, cen.z) + 5, cen.z * 0.55);
}
const camera = new THREE.PerspectiveCamera(fov, innerWidth / innerHeight, 0.5, R * 8);
camera.position.set(num('cx', campos.x), num('cy', campos.y), num('cz', campos.z));
camera.lookAt(num('tx', target.x), num('ty', target.y), num('tz', target.z));

// 고정 dt: 물(uTime) 애니메이션을 벽시계와 무관하게 진행 → 같은 seed 재현 컷 픽셀 동일.
let frames = 0;
renderer.setAnimationLoop(() => {
  if (group.userData.update) group.userData.update(1 / 60);
  renderer.render(scene, camera); frames++;
  if (frames === 14) {
    const ri = renderer.info;
    window.__PLAN.perf = { calls: ri.render.calls, triangles: ri.render.triangles, geometries: ri.memory.geometries, textures: ri.memory.textures };
    window.__SHOT_READY = true;
  }
});
</script></body></html>`;

const server = createServer(async (req, res) => {
  const path = req.url.split('?')[0];
  if (path === '/__village') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(VILLAGE_HTML); return; }
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
  // 4 scale × 부감
  ['hamlet-aerial', '/__village?scale=hamlet&view=aerial&time=day'],
  ['hamlet-eye', '/__village?scale=hamlet&view=eye&time=day'],
  ['village-aerial', '/__village?scale=village&view=aerial&time=day'],
  ['village-eye', '/__village?scale=village&view=eye&time=day'],
  ['town-aerial', '/__village?scale=town&view=aerial&time=day'],
  ['town-eye', '/__village?scale=town&view=eye&time=day'],
  ['capital-aerial', '/__village?scale=capital&view=aerial&time=day'],
  ['capital-eye', '/__village?scale=capital&view=eye&time=day'],
  // 성격(빈부) 3단 비교 — 같은 seed·scale, 한눈에 민촌/여염/반촌이 읽혀야(기준 ⑦)
  ['minchon-aerial', '/__village?scale=village&view=aerial&char=minchon&time=day'],
  ['yeoyeom-aerial', '/__village?scale=village&view=aerial&char=yeoyeom&time=day'],
  ['banchon-aerial', '/__village?scale=village&view=aerial&char=banchon&time=day'],
  ['banchon-hamlet-aerial', '/__village?scale=hamlet&view=aerial&char=banchon&time=day'],
  ['minchon-town-aerial', '/__village?scale=town&view=aerial&char=minchon&time=day'],
  // 옵션 조합
  ['village-temple-aerial', '/__village?scale=village&view=aerial&temple=1&time=day'],
  ['capital-palace-aerial', '/__village?scale=capital&view=aerial&palace=1&time=day'],
  ['capital-palace-temple-aerial', '/__village?scale=capital&view=aerial&palace=1&temple=1&time=sunset'],
  // 재현성(같은 seed 2컷 픽셀 동일해야) + 다양성(다른 seed 3종)
  ['repro-a', '/__village?scale=village&view=aerial&seed=20260716&time=day'],
  ['repro-b', '/__village?scale=village&view=aerial&seed=20260716&time=day'],
  ['seed-1', '/__village?scale=village&view=aerial&seed=101&time=day'],
  ['seed-2', '/__village?scale=village&view=aerial&seed=202&time=day'],
  ['seed-3', '/__village?scale=village&view=aerial&seed=303&time=day'],
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
  try {
    await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 40000 });
  } catch (e) { console.error('TIMEOUT', name); }
  await page.waitForTimeout(250);
  const info = await page.evaluate(() => window.__PLAN || null);
  if (info) console.log(name, 'char=' + info.character, JSON.stringify(info.stats), 'perf=' + JSON.stringify(info.perf || {}), info.warnings.length ? 'WARN:' + info.warnings.join(';') : '');
  const file = join(OUT, `village-${name}.png`);
  await page.screenshot({ path: file });
  console.log('saved', file);
}
console.log(`pageerror=${pageErrs} console-error=${consoleErrs} (favicon 404 제외)`);

await browser.close();
server.close();
