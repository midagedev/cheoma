// 헤드리스 스크린샷: 마을 다양성·담장 격상(태스크 #37) 검증 → shots/var-*.png
// 사용법: node tools/shoot-var.mjs [필터]
//   어댑터(createVillage) 경로로 렌더. 변주(집 톤·크기·방향·평면)·담장 어휘(tile/stone/brush)·
//   드로우콜(perf.calls)·rebuildParcel 신규 파라미터·재현성·야간 창호광을 함께 확인한다.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = process.env.CHEOMA_CAPTURE_DIR || join(ROOT, 'shots');
mkdirSync(OUT, { recursive: true });

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json',
};

const HTML = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>html,body{margin:0;height:100%;overflow:hidden}#app{width:100%;height:100%}</style>
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.185.1/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.185.1/examples/jsm/"}}</script>
</head><body><div id="app"></div>
<script type="module">
import * as THREE from 'three';
import { createVillage } from '/src/village/adapter.js';
import { buildBuilding } from '/src/builder/index.js';
import { applyThatchAge } from '/src/builder/palette.js';
import { PRESETS } from '/src/params.js';
const q = new URLSearchParams(location.search);
const scale = q.get('scale') || 'village';
const seedRaw = q.get('seed');
const seed = seedRaw != null ? (isNaN(+seedRaw) ? seedRaw : +seedRaw) : 20260716;
const includePalace = q.get('palace') === '1';
const character = q.get('char') || 'yeoyeom';
const view = q.get('view') || 'aerial';
const time = q.get('time') || 'day';
const wallType = q.get('wallType') || null;      // 담 클로즈업 타깃
const rb = q.get('rb') === '1';                  // rebuildParcel 실행(after)
const num = (k, d) => { const v = parseFloat(q.get(k)); return Number.isFinite(v) ? v : d; };

// 결정론 렌더(재현 컷 픽셀 동일)
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
  night:  { bg: 0x131a29, sun: [0xbcd2ff, 0.55, [0.30,0.95,0.52]], hemi: [0x2a3550, 0x171820, 0.55], exp: 1.2 },
}[time] || {};
scene.background = new THREE.Color(L.bg);
renderer.toneMappingExposure = L.exp;

const handle = createVillage({ scale, seed, includePalace, character });
handle.setTime(time);
scene.add(handle.group);
const plan = handle.plan;
const site = plan.site;
const R = site.R;

// 초가 이엉 상태 3단 비교(view=thatch3): 마을 숨기고 age 0.1/0.5/0.9 초가 3채를 나란히.
let thatch3Center = null;
if (view === 'thatch3') {
  handle.group.visible = false;
  const grp = new THREE.Group();
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(48, 28),
    new THREE.MeshStandardMaterial({ color: 0x8a7f66, roughness: 1 }));
  ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; grp.add(ground);
  const ages = [0.1, 0.5, 0.9];
  ages.forEach((age, i) => {
    const h = buildBuilding({ ...PRESETS.choga });
    applyThatchAge(h.userData.materials, age);
    h.position.set((i - 1) * 13, 0, 0);
    h.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    grp.add(h);
  });
  scene.add(grp);
  thatch3Center = new THREE.Vector3(0, 2, 0);
}

// 담 유형 분포 통계
const dist = { tile: 0, stone: 0, brush: 0 };
const variantHist = {};
for (const p of plan.parcels) {
  if (p.hero) continue;
  dist[p.wallType] = (dist[p.wallType] || 0) + 1;
  const key = p.kind + ':' + p.variant;
  variantHist[key] = (variantHist[key] || 0) + 1;
}
window.__PLAN = { scale, seed, character: plan.opts.character, houses: plan.stats.houses,
  giwa: plan.stats.giwa, choga: plan.stats.choga, wallDist: dist, variantHist };

// 담 클로즈업/리빌드 타깃 필지 선택(결정론: 첫 매칭 non-hero)
function pickParcel(pred) { return plan.parcels.find((p) => !p.hero && pred(p)); }
const kindF = q.get('kind');
const variantF = q.get('variant');
let target = null;
if (view === 'house' && variantF != null) {
  target = pickParcel((p) => p.kind === (kindF || 'giwa') && p.variant === +variantF)
        || pickParcel((p) => p.kind === (kindF || 'giwa'));
} else if (wallType) {
  target = pickParcel((p) => p.wallType === wallType && (!kindF || p.kind === kindF))
        || pickParcel((p) => p.wallType === wallType)
        || pickParcel(() => true);
} else if (rb || view === 'rebuild') {
  target = pickParcel((p) => p.kind === 'giwa') || pickParcel(() => true);
}

// rebuildParcel: cornerLift 극단 + 담유형·톤·부속채 동시 변경(신규 파라미터 동작 확인)
if (rb && target) {
  handle.rebuildParcel(target.id, {
    building: { cornerLift: num('cl', 1.5), profileCurve: 0.9, roofPitch: 1.0 },
    wallType: q.get('rbWall') || 'tile', roofTone: 2, aux: true,
  });
  window.__PLAN.rebuilt = target.id;
}

scene.fog = new THREE.Fog(L.bg, R * 2.4, R * 7.0);

const sun = new THREE.DirectionalLight(L.sun[0], L.sun[1]);
sun.position.set(L.sun[2][0] * R, L.sun[2][1] * R, L.sun[2][2] * R);
sun.castShadow = true; sun.shadow.mapSize.set(4096, 4096);
const TR = site.terrainR || R;
const sc = sun.shadow.camera;
sc.left = -TR * 1.05; sc.right = TR * 1.05; sc.top = TR * 1.05; sc.bottom = -TR * 1.05;
sc.near = 1; sc.far = TR * 8; sun.shadow.bias = -0.0003; sun.shadow.normalBias = 0.08;
scene.add(sun);
scene.add(new THREE.HemisphereLight(L.hemi[0], L.hemi[1], L.hemi[2]));

// ── 카메라 프레이밍 ──
let campos, target3, fov;
const cen = site.center;
const hAt = (x, z) => site.heightAt(x, z);
if (view === 'thatch3') {
  // 초가 상태 3단 정면 근접 — 이엉 색·얼룩 차이 비교.
  fov = 34;
  campos = new THREE.Vector3(0, 5.5, 26);
  target3 = new THREE.Vector3(0, 2.4, 0);
} else if (view === 'skyline') {
  // 마을 가로지르는 저각 오블리크 — 처마선 높이가 들쭉날쭉(치수 변주 스카이라인).
  //   마을 남측 가장자리에서 촬영(전경 수목 belt 밖) → 집들만 스카이라인으로 겹치게.
  const cx0 = 0.5 * R, cz0 = cen.z + R * 0.5;
  fov = 32;
  campos = new THREE.Vector3(cx0, hAt(cx0, cz0) + 7.5, cz0);
  target3 = new THREE.Vector3(-0.1 * R, hAt(0, cen.z) + 5.0, cen.z * 0.05);
} else if (view === 'wall' || view === 'rebuild' || view === 'house') {
  // 필지 담 클로즈업: 도로쪽(frontDir) 전방·측면 저각 오블리크.
  const p = target || plan.parcels[0];
  const baseY = p.baseY != null ? p.baseY : hAt(p.center.x, p.center.z);
  const fd = p.frontDir;                        // 도로(앞)를 향하는 단위벡터
  const side = { x: -fd.z, z: fd.x };            // 파사드 접선
  const md = Math.max(p.plotW, p.plotD);
  const dist2 = md * 1.15;
  campos = new THREE.Vector3(
    p.center.x + fd.x * dist2 + side.x * dist2 * 0.55,
    baseY + md * 0.42,
    p.center.z + fd.z * dist2 + side.z * dist2 * 0.55);
  target3 = new THREE.Vector3(p.center.x, baseY + 1.6, p.center.z);
  fov = 40;
} else if (view === 'aerial-low') {
  fov = 46;
  campos = new THREE.Vector3(0.28 * R, 0.62 * R, 1.35 * R);
  target3 = new THREE.Vector3(0, 0.05 * R, -0.08 * R);
} else { // aerial
  fov = 44;
  campos = new THREE.Vector3(0.18 * R, 1.02 * R, 1.98 * R);
  target3 = new THREE.Vector3(0, 0.06 * R, -0.16 * R);
}
const camera = new THREE.PerspectiveCamera(fov, innerWidth / innerHeight, 0.5, R * 8);
camera.position.set(num('cx', campos.x), num('cy', campos.y), num('cz', campos.z));
camera.lookAt(num('tx', target3.x), num('ty', target3.y), num('tz', target3.z));

let frames = 0;
renderer.setAnimationLoop(() => {
  handle.update(1 / 60);
  renderer.render(scene, camera);
  frames++;
  if (frames === 14) {
    const ri = renderer.info;
    window.__PLAN.perf = { calls: ri.render.calls, triangles: ri.render.triangles, geometries: ri.memory.geometries, textures: ri.memory.textures };
    window.__SHOT_READY = true;
  }
});
</script></body></html>`;

const server = createServer(async (req, res) => {
  const path = req.url.split('?')[0];
  if (path === '/__var') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(HTML); return; }
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
  // ① 변주 항공(집 톤·크기·방향·평면이 집집이 다름) — village 여염/반촌, capital
  ['aerial-village-yeoyeom', '/__var?scale=village&char=yeoyeom&view=aerial&time=day'],
  ['aerial-village-banchon', '/__var?scale=village&char=banchon&view=aerial&time=day'],
  ['aerial-village-minchon', '/__var?scale=village&char=minchon&view=aerial&time=day'],
  ['aerial-capital', '/__var?scale=capital&char=yeoyeom&view=aerial&time=day&palace=1'],
  ['aerial-low-banchon', '/__var?scale=village&char=banchon&view=aerial-low&time=day'],
  ['house-u-town', '/__var?scale=town&char=yeoyeom&view=house&kind=giwa&variant=3&time=day'],
  ['house-single-town', '/__var?scale=town&char=yeoyeom&view=house&kind=giwa&variant=2&time=day'],
  // ② 담장 어휘 클로즈업(6종) — 기와담·돌담·토담(이엉 coping)·싸리울·생울·개방 마당
  ['wall-tile-banchon', '/__var?scale=village&char=banchon&view=wall&wallType=tile&time=day'],
  ['wall-stone-choga', '/__var?scale=village&char=yeoyeom&view=wall&wallType=stone&kind=choga&time=day'],
  ['wall-mud-choga', '/__var?scale=village&char=yeoyeom&view=wall&wallType=mud&kind=choga&time=day'],
  ['wall-brush-minchon', '/__var?scale=village&char=minchon&view=wall&wallType=brush&time=day'],
  ['wall-hedge-minchon', '/__var?scale=village&char=minchon&view=wall&wallType=hedge&time=day'],
  ['wall-open-minchon', '/__var?scale=village&char=minchon&view=wall&wallType=open&time=day'],
  // ③ 드로우콜 측정(capital, <1000)
  ['calls-capital', '/__var?scale=capital&char=banchon&view=aerial&time=day&palace=1'],
  // ④ rebuildParcel 신규 파라미터(cornerLift 극단 등) 전/후
  ['rebuild-before', '/__var?scale=village&char=yeoyeom&view=rebuild&time=day'],
  ['rebuild-after', '/__var?scale=village&char=yeoyeom&view=rebuild&rb=1&cl=1.6&time=day'],
  // ⑤ 재현성(같은 seed 2컷 픽셀 동일)
  ['repro-a', '/__var?scale=village&char=banchon&view=aerial&seed=20260716&time=day'],
  ['repro-b', '/__var?scale=village&char=banchon&view=aerial&seed=20260716&time=day'],
  // ⑥ night 회귀(창호광)
  ['night-village', '/__var?scale=village&char=banchon&view=aerial-low&time=night'],
  // ⑦ 치수 변주 스카이라인(처마선 높이 들쭉날쭉) — 여염(초가·기와 혼재)
  ['skyline-yeoyeom', '/__var?scale=village&char=yeoyeom&view=skyline&time=day'],
  ['skyline-minchon', '/__var?scale=village&char=minchon&view=skyline&time=day'],
  // ⑧ 초가 이엉 상태 3단 비교(신선 금빛 · 바랜 황갈 · 노후 회갈·이끼)
  ['thatch3', '/__var?view=thatch3&time=day'],
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
  await page.waitForTimeout(200);
  const info = await page.evaluate(() => window.__PLAN || null);
  if (info) console.log(name,
    'houses=' + info.houses, 'wallDist=' + JSON.stringify(info.wallDist),
    'variants=' + JSON.stringify(info.variantHist),
    info.rebuilt ? 'rebuilt=' + info.rebuilt : '',
    'perf=' + JSON.stringify(info.perf || {}));
  const file = join(OUT, `var-${name}.png`);
  await page.screenshot({ path: file });
  console.log('saved', file);
}
console.log(`pageerror=${pageErrs} console-error=${consoleErrs} (favicon 404 제외)`);

await browser.close();
server.close();
