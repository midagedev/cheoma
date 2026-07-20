// 외곽 나무 검증(#86): 부유(높이 오배치) + 밀도. populateVillage 직접 경로(결정론·나무 수 집계).
// 사용법: node tools/shoot-trees.mjs [out=scratch|shots] [필터]
//   전용 포트 4202, src/ 직접 서빙(빌드 불필요 → 사용자 dev 5174 무접촉).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..');
const dest = process.argv[2] === 'shots' ? 'shots' : 'scratch';
const SCRATCH = '/private/tmp/claude-501/-Users-hckim-repo-asiahouse/7a15478e-68e3-4ad3-b08a-bdb86ae4fe92/scratchpad/trees';
const OUT = dest === 'shots' ? join(ROOT, 'shots') : SCRATCH;
mkdirSync(OUT, { recursive: true });
const PFX = dest === 'shots' ? 'trees-' : '';
const PORT = 4202;

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

const HTML = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>html,body{margin:0;height:100%;overflow:hidden}#app{width:100%;height:100%}</style>
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.185.1/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.185.1/examples/jsm/"}}</script>
</head><body><div id="app"></div>
<script type="module">
import * as THREE from 'three';
import { planVillage } from '/src/village/plan.js';
import { populateVillage } from '/src/village/populate.js';
const q = new URLSearchParams(location.search);
const scale = q.get('scale') || 'village';
const seed = 20260716;
const view = q.get('view') || 'aerial';
const time = q.get('time') || 'day';
const palace = q.get('palace') === '1';
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
  sunset: { bg: 0xe7b98f, sun: [0xffb066, 2.1, [0.72,0.34,0.42]], hemi: [0xd7b48c, 0x7a6a54, 1.0], exp: 1.0 },
}[time] || {};
scene.background = new THREE.Color(L.bg);
renderer.toneMappingExposure = L.exp;

const plan = planVillage({ scale, seed, includePalace: palace });
const group = populateVillage(plan);
scene.add(group);
const site = plan.site;
const R = site.R;
const TR = site.terrainR || R;
scene.fog = new THREE.Fog(L.bg, R * 2.4, R * 7.5);
const sun = new THREE.DirectionalLight(L.sun[0], L.sun[1]);
sun.position.set(L.sun[2][0] * R, L.sun[2][1] * R, L.sun[2][2] * R);
sun.castShadow = true; sun.shadow.mapSize.set(4096, 4096);
const sc = sun.shadow.camera;
sc.left = -TR * 1.05; sc.right = TR * 1.05; sc.top = TR * 1.05; sc.bottom = -TR * 1.05;
sc.near = 1; sc.far = TR * 8; sun.shadow.bias = -0.0003; sun.shadow.normalBias = 0.08;
scene.add(sun);
scene.add(new THREE.HemisphereLight(L.hemi[0], L.hemi[1], L.hemi[2]));

// ── 나무 수 집계(그룹 userData.count + 인스턴스 합)
const treesGrp = group.getObjectByName('village-trees');
let treeInst = 0; if (treesGrp) treesGrp.traverse((o) => { if (o.isInstancedMesh) treeInst += o.count; });
const treeCount = treesGrp ? (treesGrp.userData.count || 0) : 0;

// occ=0: 전경 나무 오클루더(#36 스크린도어 디더) 무력화 — 부유가 배치 문제인지 오클루더 착시인지 분리.
if (q.get('occ') === '0' && treesGrp) {
  treesGrp.traverse((o) => {
    if (!o.isInstancedMesh) return;
    o.onBeforeRender = () => {};
    const a = o.geometry.getAttribute('instFade');
    if (a) { a.array.fill(1); a.needsUpdate = true; }
  });
}

// ── 부유 런타임 진단: 각 나무 밑동 y vs 실제 렌더된 village-terrain 표면(레이캐스트) 비교.
//    onMesh 가 메시면에 앉힌다는 정적 가정을 런타임으로 검증 — 어긋나는 지점을 특정한다(#86 재라운드).
let diag = null;
if (q.get('diag') === '1') {
  const cen = site.center;
  group.updateMatrixWorld(true);
  const terr = group.getObjectByName('village-terrain');
  const rc = new THREE.Raycaster(); rc.firstHitOnly = false;
  const down = new THREE.Vector3(0, -1, 0);
  const pos = new THREE.Vector3(), qq = new THREE.Quaternion(), scl = new THREE.Vector3(), m = new THREE.Matrix4();
  const floaters = []; let maxDelta = -1e9, maxAt = null;
  treesGrp.traverse((o) => {
    if (!o.isInstancedMesh) return;
    for (let k = 0; k < o.count; k++) {
      o.getMatrixAt(k, m); m.decompose(pos, qq, scl);
      rc.set(new THREE.Vector3(pos.x, pos.y + 400, pos.z), down);
      const hT = terr ? rc.intersectObject(terr, false) : [];
      if (!hT.length) continue;                       // 지형 위에 없음(디스크 밖) — 별도 문제
      const surfY = hT[0].point.y;
      const d = pos.y - surfY;
      if (d > maxDelta) { maxDelta = d; maxAt = { x: +pos.x.toFixed(1), z: +pos.z.toFixed(1), treeY: +pos.y.toFixed(2), surfY: +surfY.toFixed(2), r: +Math.hypot(pos.x, pos.z).toFixed(1), rFromCenter: +Math.hypot(pos.x - cen.x, pos.z - cen.z).toFixed(1) }; }
      if (d > 0.6) floaters.push({ x: +pos.x.toFixed(1), z: +pos.z.toFixed(1), d: +d.toFixed(2), r: +Math.hypot(pos.x, pos.z).toFixed(1), rC: +Math.hypot(pos.x - cen.x, pos.z - cen.z).toFixed(1) });
    }
  });
  floaters.sort((a, b) => b.d - a.d);
  // rim-behind-hero 영역(z<center.z, rC∈[bowlR, 1.6bowlR]) 나무 — 급사면 근접 프레이밍 앵커.
  const behind = [];
  treesGrp.traverse((o) => {
    if (!o.isInstancedMesh) return;
    for (let k = 0; k < o.count; k++) {
      o.getMatrixAt(k, m); m.decompose(pos, qq, scl);
      const rC = Math.hypot(pos.x - cen.x, pos.z - cen.z);
      if (pos.z < cen.z && rC > site.bowlR * 0.9 && rC < site.bowlR * 1.7) behind.push({ x: +pos.x.toFixed(1), z: +pos.z.toFixed(1), y: +pos.y.toFixed(1), rC: +rC.toFixed(0) });
    }
  });
  behind.sort((a, b) => a.rC - b.rC);
  diag = { floaterCount: floaters.length, maxDelta: +maxDelta.toFixed(2), maxAt, top: floaters.slice(0, 12), behindHero: behind.slice(0, 10), bowlR: +site.bowlR.toFixed(0), R: +R.toFixed(0), center: { x: +cen.x.toFixed(1), z: +cen.z.toFixed(1) } };
}

const cen = site.center;
const hAt = (x, z) => site.heightAt(x, z);
let campos, target, fov = 44;
if (view === 'aerial') {
  // #80 부감 기본 프레이밍 근사(마을 화면 65~75%)
  campos = new THREE.Vector3(0.16 * R, 0.98 * R, 1.9 * R);
  target = new THREE.Vector3(0, 0.02 * R, -0.12 * R);
} else if (view === 'edge') {
  // 외곽 오블리크: 북동 능선 밖에서 안쪽으로 내려다봄 — 지형 디스크 경계 밖 부유목이 배경 위에 뜸.
  fov = 50;
  campos = new THREE.Vector3(0.95 * TR, 0.42 * TR, 0.55 * TR);
  target = new THREE.Vector3(0.30 * TR, 0.02 * TR, -0.15 * TR);
} else if (view === 'edge2') {
  // 남서 외곽 오블리크(반대 방위)
  fov = 50;
  campos = new THREE.Vector3(-0.9 * TR, 0.40 * TR, 0.9 * TR);
  target = new THREE.Vector3(-0.25 * TR, 0.02 * TR, 0.1 * TR);
} else if (view === 'foot') {
  // 능선 기슭 근경 저각: 사면을 가로질러 봐 둥치-지면 접점(부유 프로파일)이 읽힘.
  const px = 0.15 * R, pz = cen.z - 0.5 * R;
  const gy = hAt(px, pz);
  fov = 46;
  campos = new THREE.Vector3(px + 0.5 * R, gy + 0.10 * R, pz + 0.35 * R);
  target = new THREE.Vector3(px - 0.4 * R, gy + 0.04 * R, pz);
} else if (view === 'ridge-eye') {
  // 아이레벨 배산 능선 실루엣(트리 리듬) — 남측 저지에서 북 능선 크레스트를 올려다봄.
  const camZ = site.streamZ + R * 0.25, cx0 = R * 0.02;
  const gy = hAt(cx0, camZ);
  fov = 50;
  campos = new THREE.Vector3(cx0, gy + 3, camZ);
  target = new THREE.Vector3(0, hAt(-0.1 * R, cen.z - 0.5 * R) + 0.35 * R, cen.z - 0.9 * R);
} else if (view === 'rimclose') {
  // rim-behind-hero 근접 부감(~45° 내려봄): 급사면 나무 둥치-지면 접점이 명확히 읽힘(그림자 짧음).
  const tz = cen.z - site.bowlR * 1.05;      // 종가 배후 rim 안쪽 사면
  const gy = hAt(0, tz);
  fov = 40;
  campos = new THREE.Vector3(num('cx0', 0.02 * R), gy + 0.42 * R, tz + 0.55 * R);
  target = new THREE.Vector3(0, gy + 3, tz);
} else { // high 부감
  fov = 40;
  campos = new THREE.Vector3(0.02 * R, 2.0 * R, 1.4 * R);
  target = new THREE.Vector3(0, 0, -0.05 * R);
}
const camera = new THREE.PerspectiveCamera(fov, innerWidth / innerHeight, 0.5, R * 9);
camera.position.set(num('cx', campos.x), num('cy', campos.y), num('cz', campos.z));
camera.lookAt(num('tx', target.x), num('ty', target.y), num('tz', target.z));

let frames = 0;
renderer.setAnimationLoop(() => {
  if (group.userData.update) group.userData.update(1 / 60);
  renderer.render(scene, camera); frames++;
  if (frames === 14) {
    const ri = renderer.info;
    window.__T = { scale, view, R: +R.toFixed(0), TR: +TR.toFixed(0), bowlR: +site.bowlR.toFixed(0),
      trees: treeCount, treeInst, diag,
      calls: ri.render.calls, triangles: ri.render.triangles, geometries: ri.memory.geometries };
    window.__READY = true;
  }
});
</script></body></html>`;

const server = createServer(async (req, res) => {
  const path = req.url.split('?')[0];
  if (path === '/__trees') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(HTML); return; }
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
  ['village-diag', 'scale=village&view=foot&time=day&diag=1'],
  ['capital-diag', 'scale=capital&view=aerial&time=day&diag=1'],
  ['hanyang-diag', 'scale=hanyang&view=aerial&time=day&palace=1&diag=1'],
  ['village-aerial', 'scale=village&view=aerial&time=day'],
  ['village-edge', 'scale=village&view=edge&time=day'],
  ['village-edge2', 'scale=village&view=edge2&time=day'],
  ['village-foot', 'scale=village&view=foot&time=day'],
  ['village-foot-noocc', 'scale=village&view=foot&time=day&occ=0'],
  ['village-treeclose', 'scale=village&view=foot&time=day&occ=0&cx=-35&cy=73&cz=-30&tx=-70&ty=45&tz=-80'],
  ['village-treeclose-occ', 'scale=village&view=foot&time=day&cx=-35&cy=73&cz=-30&tx=-70&ty=45&tz=-80'],
  ['village-foot-high', 'scale=village&view=foot&time=day&occ=0&cy=95'],
  ['village-ridge-sunset', 'scale=village&view=ridge-eye&time=sunset'],
  ['capital-aerial', 'scale=capital&view=aerial&time=day'],
  ['capital-edge', 'scale=capital&view=edge&time=day'],
  ['hanyang-aerial', 'scale=hanyang&view=aerial&time=day&palace=1'],
  ['hanyang-edge', 'scale=hanyang&view=edge&time=day&palace=1'],
  ['hanyang-ridge-sunset', 'scale=hanyang&view=ridge-eye&time=sunset&palace=1'],
].filter(([n]) => !filter || n.includes(filter));

let browser;
try { browser = await chromium.launch({ channel: 'chrome' }); } catch { browser = await chromium.launch(); }
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
let pageErrs = 0;
page.on('pageerror', (e) => { pageErrs++; console.error('[pageerror]', e.message); });
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) console.error('[console]', m.text()); });

for (const [name, qs] of shots) {
  await page.goto(`http://127.0.0.1:${PORT}/__trees?${qs}`, { waitUntil: 'load' });
  try { await page.waitForFunction('window.__READY === true', null, { timeout: 60000 }); }
  catch { console.error('TIMEOUT', name); }
  await page.waitForTimeout(150);
  const info = await page.evaluate(() => window.__T);
  if (info) console.log(name.padEnd(22), 'trees=' + info.trees, 'inst=' + info.treeInst, 'calls=' + info.calls, 'tri=' + info.triangles, 'TR=' + info.TR, 'bowlR=' + info.bowlR);
  if (info && info.diag) console.log('  DIAG', JSON.stringify(info.diag));
  const file = join(OUT, `${PFX}${name}.png`);
  await page.screenshot({ path: file });
}
console.log('pageerror=' + pageErrs, 'out=' + OUT);
await browser.close();
server.close();
