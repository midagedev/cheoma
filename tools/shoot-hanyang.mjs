// 한양 도성 시각 검증 + 컬링 실효 측정. shots 모드는 shots/capital-*, 그 외는 지정 디렉터리에 저장.
// 사용법: node tools/shoot-hanyang.mjs [scratch|shots|output-dir] [name-filter]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..');
const dest = process.argv[2] || 'scratch';
const OUT = dest === 'shots' ? join(ROOT, 'shots')
  : dest === 'scratch' ? join(tmpdir(), 'cheoma-hanyang')
    : resolve(process.cwd(), dest);
mkdirSync(OUT, { recursive: true });
const PFX = dest === 'shots' ? 'capital-' : '';

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

const HTML = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>html,body{margin:0;height:100%;overflow:hidden}#app{width:100%;height:100%}</style>
<script type="importmap">{"imports":{"three":"/app/node_modules/three/build/three.module.js","three/addons/":"/app/node_modules/three/examples/jsm/"}}</script>
</head><body><div id="app"></div>
<script type="module">
import * as THREE from 'three';
import { planVillage } from '/src/village/plan.js';
import { populateVillage } from '/src/village/populate.js';
const q = new URLSearchParams(location.search);
const scale = q.get('scale') || 'hanyang';
const seedRaw = q.get('seed'); const seed = seedRaw != null ? (isNaN(+seedRaw) ? seedRaw : +seedRaw) : 20260716;
const view = q.get('view') || 'aerial';
const time = q.get('time') || 'day';
const palace = q.get('palace') !== '0';
const num = (k, d) => { const v = parseFloat(q.get(k)); return Number.isFinite(v) ? v : d; };
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

const plan = planVillage({ scale, seed, includePalace: palace });
const group = populateVillage(plan);
scene.add(group);
const R = plan.site.R;
scene.fog = new THREE.Fog(L.bg, R * 2.4, R * 7.5);
const sun = new THREE.DirectionalLight(L.sun[0], L.sun[1]);
sun.position.set(L.sun[2][0] * R, L.sun[2][1] * R, L.sun[2][2] * R);
sun.castShadow = true; sun.shadow.mapSize.set(4096, 4096);
const TR = plan.site.terrainR || R; const sc = sun.shadow.camera;
sc.left = -TR * 1.05; sc.right = TR * 1.05; sc.top = TR * 1.05; sc.bottom = -TR * 1.05;
sc.near = 1; sc.far = TR * 8; sun.shadow.bias = -0.0003; sun.shadow.normalBias = 0.08;
scene.add(sun);
scene.add(new THREE.HemisphereLight(L.hemi[0], L.hemi[1], L.hemi[2]));

const cen = plan.site.center;
let campos, target, fov = 44;
let subject = null;
if (view === 'aerial') {
  campos = new THREE.Vector3(0.16 * R, 0.95 * R, 1.85 * R);
  target = new THREE.Vector3(0, 0.02 * R, -0.12 * R);
} else if (view === 'high') {
  fov = 42; campos = new THREE.Vector3(0.02 * R, 1.95 * R, 1.35 * R);
  target = new THREE.Vector3(0, 0, -0.05 * R);
} else if (view === 'gate') {
  // 숭례문(남문) 근처 접근뷰 — 성벽·문루가 크게
  fov = 48;
  const gs = (plan.features.cityWall && plan.features.cityWall.gates.find((g) => g.name === 'south')) || { x: 0, z: cen.z + R * 0.65 };
  let dx = Number.isFinite(gs.dirX) ? gs.dirX : 0;
  let dz = Number.isFinite(gs.dirZ) ? gs.dirZ : 1;
  const dLen = Math.hypot(dx, dz) || 1;
  dx /= dLen; dz /= dLen;
  const tx = -dz, tz = dx;
  const camX = gs.x + dx * R * 0.18 + tx * R * 0.035;
  const camZ = gs.z + dz * R * 0.18 + tz * R * 0.035;
  const gy = plan.site.heightAt(gs.x, gs.z);
  campos = new THREE.Vector3(camX, plan.site.heightAt(camX, camZ) + R * 0.06, camZ);
  target = new THREE.Vector3(gs.x, gy + 7, gs.z);
} else if (view === 'east' || view === 'west') {
  // 동·서문 근경 — 성 안쪽 사선에서 문루와 성벽 접합을 함께 본다.
  fov = 48;
  const side = view === 'east' ? 1 : -1;
  const gate = (plan.features.cityWall && plan.features.cityWall.gates.find((g) => g.name === view))
    || { x: cen.x + side * R * 0.65, z: cen.z, dirX: side, dirZ: 0 };
  let dx = Number.isFinite(gate.dirX) ? gate.dirX : side;
  let dz = Number.isFinite(gate.dirZ) ? gate.dirZ : 0;
  const dLen = Math.hypot(dx, dz) || 1;
  dx /= dLen; dz /= dLen;
  const tx = -dz, tz = dx;
  const camX = gate.x - dx * R * 0.18 + tx * R * 0.035;
  const camZ = gate.z - dz * R * 0.18 + tz * R * 0.035;
  const camY = plan.site.heightAt(camX, camZ) + R * 0.06;
  const gateY = plan.site.heightAt(gate.x, gate.z);
  campos = new THREE.Vector3(camX, camY, camZ);
  target = new THREE.Vector3(gate.x, gateY + 7, gate.z);
} else if (view === 'north') {
  // 숙정문(북문) 산길 근경 — 도성 안에서 북악 급사면·성벽·문루를 올려다봄.
  fov = 48;
  const gn = (plan.features.cityWall && plan.features.cityWall.gates.find((g) => g.name === 'north'))
    || { x: 0, z: cen.z - R * 0.65, dirX: 0, dirZ: -1 };
  let dx = Number.isFinite(gn.dirX) ? gn.dirX : 0;
  let dz = Number.isFinite(gn.dirZ) ? gn.dirZ : -1;
  const dLen = Math.hypot(dx, dz) || 1;
  dx /= dLen; dz /= dLen;
  const tx = -dz, tz = dx;
  const camX = gn.x - dx * R * 0.18 + tx * R * 0.04;
  const camZ = gn.z - dz * R * 0.18 + tz * R * 0.04;
  const gy = plan.site.heightAt(gn.x, gn.z);
  campos = new THREE.Vector3(camX, plan.site.heightAt(camX, camZ) + R * 0.06, camZ);
  target = new THREE.Vector3(gn.x, gy + 7, gn.z);
} else if (view === 'palace') {
  // 궁역 근접 3/4 부감(#88) — 도시 속 다일곽 궁궐 스카이라인.
  const Pl = plan.features.palace || { x: 0, z: cen.z };
  const py = plan.site.heightAt(Pl.x, Pl.z);
  fov = 42;
  campos = new THREE.Vector3(Pl.x + R * 0.30, py + R * 0.34, Pl.z + R * 0.52);
  target = new THREE.Vector3(Pl.x, py + 6, Pl.z - R * 0.05);
} else if (view === 'sijeon') {
  // 실제 한양 plan의 도심 시전 중 중심에 가까운 한 칸을 기준으로, 대로 위에서
  // 연속 행랑을 사선으로 본다. 고립 fixture가 놓치는 성곽·도로·인접 필지 맥락을 확인한다.
  const shops = plan.features.sijeon || [];
  if (!shops.length) throw new Error('sijeon view requires planned Hanyang market rows');
  const shop = shops.reduce((best, candidate) => {
    const distance = Math.hypot(candidate.center.x - cen.x, candidate.center.z - cen.z);
    return !best || distance < best.distance ? { shop: candidate, distance } : best;
  }, null).shop;
  const front = new THREE.Vector3(shop.frontDir.x, 0, shop.frontDir.z).normalize();
  const along = new THREE.Vector3(-front.z, 0, front.x);
  const sy = plan.site.heightAt(shop.center.x, shop.center.z);
  fov = 38;
  campos = new THREE.Vector3(shop.center.x, sy + 2.25, shop.center.z)
    .addScaledVector(front, shop.d * 0.5 + 5.8)
    .addScaledVector(along, -17);
  target = new THREE.Vector3(shop.center.x, sy + 1.65, shop.center.z)
    .addScaledVector(along, 9);
  subject = { kind: 'sijeon', id: shop.id, center: shop.center, frontDir: shop.frontDir };
} else if (view === 'cull') {
  // 컬링 증명: 도성 중심에서 북(-z)만 바라봄 → 남쪽 청크는 뒤로 컬링돼야 함(calls 감소).
  fov = 55;
  const gy = plan.site.heightAt(0, cen.z);
  campos = new THREE.Vector3(0, gy + 8, cen.z + R * 0.02);
  target = new THREE.Vector3(0, gy + 4, cen.z - R * 0.5);
} else { // eye — 남측 진입
  const gate = (plan.features.cityWall && plan.features.cityWall.gates.find((g) => g.name === 'south'))
    || { x: 0, z: cen.z + R * 0.65, dirX: 0, dirZ: 1 };
  const approach = plan.roads.find((road) => road.wallApproach?.gate === 'south');
  let dx = Number.isFinite(gate.dirX) ? gate.dirX : 0;
  let dz = Number.isFinite(gate.dirZ) ? gate.dirZ : 1;
  const dLen = Math.hypot(dx, dz) || 1;
  dx /= dLen; dz /= dLen;
  const approachEnd = approach
    ? (approach.wallApproach.side === 'start' ? approach.pts[0] : approach.pts.at(-1))
    : null;
  const camX = approachEnd?.x ?? gate.x + dx * R * 0.13;
  const camZ = approachEnd?.z ?? gate.z + dz * R * 0.13;
  const innerX = gate.x - dx * R * 0.08;
  const innerZ = gate.z - dz * R * 0.08;
  fov = 52;
  campos = new THREE.Vector3(camX, plan.site.heightAt(camX, camZ) + 4.2, camZ);
  target = new THREE.Vector3(innerX, plan.site.heightAt(innerX, innerZ) + 4.2, innerZ);
}
const camera = new THREE.PerspectiveCamera(fov, innerWidth / innerHeight, 0.5, R * 9);
camera.position.set(num('cx', campos.x), num('cy', campos.y), num('cz', campos.z));
camera.lookAt(num('tx', target.x), num('ty', target.y), num('tz', target.z));

let frames = 0;
renderer.setAnimationLoop(() => {
  if (group.userData.update) group.userData.update(1 / 60);
  // 실제 앱과 같은 production LOD 경로를 반드시 구동한다. 이 호출이 없으면 모든 컷이 부팅 시
  // 임포스터 상태에 고정돼 근경/게이트 스크린샷이 LOD 회귀를 전혀 잡지 못한다(#29).
  if (group.userData.updateChunkLod) group.userData.updateChunkLod(camera);
  renderer.render(scene, camera); frames++;
  if (frames === 14) {
    const ri = renderer.info;
    const lod = { full: 0, mid: 0, far: 0, invalid: 0 };
    for (const child of group.children) {
      const state = child.userData?.lod;
      if (!state) continue;
      if (state.level === 'full') lod.full++;
      else if (state.level === 'mid') lod.mid++;
      else if (state.level === 'far' || state.level === 'impostor') lod.far++;
      else lod.invalid++;
    }
    window.__PLAN = { scale, seed, view, subject, R, stats: plan.stats, warnings: plan.warnings,
      lod,
      perf: { calls: ri.render.calls, triangles: ri.render.triangles, programs: ri.programs?.length || 0,
        geometries: ri.memory.geometries, textures: ri.memory.textures } };
    window.__SHOT_READY = true;
  }
});
</script></body></html>`;

const server = createServer(async (req, res) => {
  const path = req.url.split('?')[0];
  if (path === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  if (path === '/__hanyang') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(HTML); return; }
  try {
    const file = join(ROOT, path === '/' ? 'index.html' : path);
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const port = server.address().port;

const filter = process.argv[3] || '';
const shots = [
  ['hanyang-aerial', 'scale=hanyang&view=aerial&time=day'],
  ['hanyang-high', 'scale=hanyang&view=high&time=day'],
  ['hanyang-gate', 'scale=hanyang&view=gate&time=day'],
  ['hanyang-east-gate', 'scale=hanyang&view=east&time=day'],
  ['hanyang-west-gate', 'scale=hanyang&view=west&time=day'],
  ['hanyang-north', 'scale=hanyang&view=north&time=day'],
  ['hanyang-sunset', 'scale=hanyang&view=aerial&time=sunset'],
  ['hanyang-sijeon-day', 'scale=hanyang&view=sijeon&time=day'],
  ['hanyang-sijeon-sunset', 'scale=hanyang&view=sijeon&time=sunset'],
  ['hanyang-cull', 'scale=hanyang&view=cull&time=day'],
  ['hanyang-eye', 'scale=hanyang&view=eye&time=day'],
  ['hanyang-palace', 'scale=hanyang&view=palace&time=sunset'],
  ['capital-aerial', 'scale=capital&view=aerial&time=day'],
  ['capital-palace', 'scale=capital&view=palace&time=day'],
].filter(([n]) => !filter || n.includes(filter));
if (!shots.length) {
  throw new Error(`no screenshot job matches filter: ${JSON.stringify(filter)}`);
}

let browser;
const errors = [];
let currentJob = 'setup';
const fail = (kind, detail) => {
  const message = `[${currentJob}] ${kind}: ${detail}`;
  errors.push(message);
  console.error(message);
};

try {
  try { browser = await chromium.launch({ channel: 'chrome' }); } catch { browser = await chromium.launch(); }
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
  page.on('pageerror', (error) => fail('pageerror', error.message));
  page.on('console', (message) => { if (message.type() === 'error') fail('console', message.text()); });
  page.on('requestfailed', (request) => fail('requestfailed', `${request.url()} — ${request.failure()?.errorText || 'unknown error'}`));

  console.log('output=' + OUT);
  for (const [name, qs] of shots) {
    currentJob = name;
    try {
      await page.goto(`http://127.0.0.1:${port}/__hanyang?${qs}`, { waitUntil: 'load', timeout: 60000 });
    } catch (error) {
      fail('navigation', error.message);
      continue;
    }
    try {
      await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 60000 });
    } catch (error) {
      fail('timeout', error.message);
      continue;
    }
    await page.waitForTimeout(200);
    try {
      const info = await page.evaluate(() => window.__PLAN);
      if (!info) throw new Error('window.__PLAN was not populated');
      console.log(name, JSON.stringify(info.stats), 'lod=' + JSON.stringify(info.lod), 'perf=' + JSON.stringify(info.perf), info.warnings.length ? 'WARN:' + info.warnings.join(';') : '');
      const file = join(OUT, `${PFX}${name}.png`);
      await page.screenshot({ path: file });
      console.log('saved', file);
    } catch (error) {
      fail('capture', error.message);
    }
  }
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
}

console.log(`errors=${errors.length}`);
if (errors.length) process.exitCode = 1;
