// 필지 부정형 체감 검증(태스크 #54). 앱의 실제 마을 경로(adapter.createVillage)를
// 앱 부감 카메라(engine.villageAerial: 0.20R,1.02R,1.98R·fov42)로 렌더 → shots/parcels-*.png
//
// 앱 dist 빌드가 sibling(env/animals.js) 편집중 깨짐 → 이 하네스만 animals.js 를 no-op 스텁으로
// 가로채 서빙(실제 파일 불침해). 마을 지오/필지/담/패드는 그대로 — 소동물만 렌더 생략.
//   사용법: NODE_PATH=/Users/hckim/repo/threesur/node_modules node tools/shoot-parcels.mjs [필터]
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

// setupAnimals no-op 스텁 — populate.buildVillageAnimals 계약(핸들 update/setTime/setSeason 등)만 만족.
const ANIMALS_STUB = `
export function setupAnimals() {
  return {
    update() {}, setTime() {}, setSeason() {}, setEnabled() {},
    get cowAnchor() { return null; },
    debugFlockCenter() { return null; },
  };
}
`;

const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>html,body{margin:0;height:100%;overflow:hidden}#app{width:100%;height:100%}</style>
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.185.1/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.185.1/examples/jsm/"}}</script>
</head><body><div id="app"></div>
<script type="module">
import * as THREE from 'three';
import { createVillage } from '/src/village/adapter.js';   // 앱과 동일 생성 경로
const q = new URLSearchParams(location.search);
const scale = q.get('scale') || 'village';
const character = q.get('char') || 'yeoyeom';
const seedRaw = q.get('seed');
const seed = seedRaw != null ? (isNaN(+seedRaw) ? seedRaw : +seedRaw) : 20260716;
const includePalace = q.get('palace') === '1';
const includeTemple = q.get('temple') === '1';
const view = q.get('view') || 'aerial';   // aerial(앱 부감) | top(크리스프 수직)
const time = q.get('time') || 'day';
const num = (k, d) => { const v = parseFloat(q.get(k)); return Number.isFinite(v) ? v : d; };

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

// 앱 마을 경로: createVillage 로 handle 생성(planVillage+populateVillage 내장)·group 을 씬에 add.
const handle = createVillage({ scale, seed, includePalace, includeTemple, character });
handle.setTime(time);
scene.add(handle.group);
const plan = handle.plan;
window.__PLAN = { scale, seed, character: plan.opts.character, stats: plan.stats, warnings: plan.warnings, R: plan.site.R };

const R = plan.site.R;
scene.fog = new THREE.Fog(L.bg, R * 2.4, R * 7.0);

const sun = new THREE.DirectionalLight(L.sun[0], L.sun[1]);
sun.position.set(L.sun[2][0] * R, L.sun[2][1] * R, L.sun[2][2] * R);
sun.castShadow = true; sun.shadow.mapSize.set(4096, 4096);
const TR = plan.site.terrainR || R;
const sc = sun.shadow.camera;
sc.left = -TR * 1.05; sc.right = TR * 1.05; sc.top = TR * 1.05; sc.bottom = -TR * 1.05;
sc.near = 1; sc.far = TR * 8; sun.shadow.bias = -0.0003; sun.shadow.normalBias = 0.08;
scene.add(sun);
scene.add(new THREE.HemisphereLight(L.hemi[0], L.hemi[1], L.hemi[2]));

let campos, target, fov;
if (view === 'topclose') {
  // 근접 수직 부감 — 지붕이 담을 넘는지(건물-담 관통) 육안 검사용.
  fov = 34;
  campos = new THREE.Vector3(0.0, 1.02 * R, 0.16 * R);
  target = new THREE.Vector3(0, 0, 0.14 * R);
} else if (view === 'top') {
  // 크리스프 수직 부감 — 필지 폴리곤 형상을 왜곡 없이 읽기 위한 보조 컷.
  fov = 36;
  campos = new THREE.Vector3(0.0, 2.35 * R, 0.02 * R);
  target = new THREE.Vector3(0, 0, 0);
} else {
  // 앱 engine.villageAerial 과 동일 프레이밍.
  fov = 42;
  campos = new THREE.Vector3(0.20 * R, 1.02 * R, 1.98 * R);
  target = new THREE.Vector3(0, 0.06 * R, -0.10 * R);
}
const camera = new THREE.PerspectiveCamera(fov, innerWidth / innerHeight, 0.5, R * 8);
camera.position.set(num('cx', campos.x), num('cy', campos.y), num('cz', campos.z));
camera.lookAt(num('tx', target.x), num('ty', target.y), num('tz', target.z));

let frames = 0;
renderer.setAnimationLoop(() => {
  if (handle.update) handle.update(1 / 60);
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
  if (path === '/__parcels') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE); return; }
  if (path === '/src/env/animals.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(ANIMALS_STUB); return; }
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
const tag = process.env.TAG || 'now';
const shots = [
  ['village-aerial', '/__parcels?scale=village&view=aerial&char=yeoyeom&time=day'],
  ['village-top', '/__parcels?scale=village&view=top&char=yeoyeom&time=day'],
  ['minchon-top', '/__parcels?scale=village&view=top&char=minchon&time=day'],
  ['minchon-aerial', '/__parcels?scale=village&view=aerial&char=minchon&time=day'],
  ['banchon-top', '/__parcels?scale=village&view=top&char=banchon&time=day'],
  ['hamlet-top', '/__parcels?scale=hamlet&view=top&char=yeoyeom&time=day'],
  ['town-top', '/__parcels?scale=town&view=top&char=yeoyeom&time=day'],
  ['village-aerial-sunset', '/__parcels?scale=village&view=aerial&char=yeoyeom&time=sunset'],
  ['village-topclose', '/__parcels?scale=village&view=topclose&char=yeoyeom&time=day'],
  ['minchon-topclose', '/__parcels?scale=village&view=topclose&char=minchon&time=day'],
  ['banchon-topclose', '/__parcels?scale=village&view=topclose&char=banchon&time=day'],
  ['capital-top', '/__parcels?scale=capital&view=top&char=yeoyeom&time=day'],
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
  if (info) console.log(name, 'char=' + info.character, JSON.stringify(info.stats), 'perf=' + JSON.stringify(info.perf || {}), info.warnings.length ? 'WARN:' + info.warnings.join(';') : '');
  const file = join(OUT, `parcels-${tag}-${name}.png`);
  await page.screenshot({ path: file });
  console.log('saved', file);
}
console.log(`pageerror=${pageErrs} console-error=${consoleErrs} (favicon 404 제외)`);

await browser.close();
server.close();
