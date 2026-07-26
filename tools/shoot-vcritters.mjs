// 헤드리스 스크린샷: 마을 소동물(개·고양이·까치·새 떼, critters.js setupVillageCritters) 검증.
// 사용법: node tools/shoot-vcritters.mjs [필터]
//   출력 PNG → OS 임시 디렉터리(CHEOMA_CRITTER_OUT으로 재지정 가능).
//   콘솔에 개체수·드로우콜·거리 LOD sleep·개 모션 델타 출력.
// 앱 경로 준용(shoot-village-light.mjs 골격): scene sun/hemi → setupEnvironment → setupPost →
//   createVillage(adapter) → enterVillageMode → setTime. adapter 가 마을 루트에 붙인 village-critters
//   그룹이 실제 앱과 동일하게 반영된다.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { launchVerificationBrowser } from './lib/verification-browser.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = process.env.CHEOMA_CRITTER_OUT
  ? resolve(process.env.CHEOMA_CRITTER_OUT)
  : mkdtempSync(join(tmpdir(), 'cheoma-critters-'));
mkdirSync(OUT, { recursive: true });

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json',
};

const HTML = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>html,body{margin:0;height:100%;overflow:hidden;background:#000}#app{width:100%;height:100%}</style>
<script type="importmap">{"imports":{"three":"/app/node_modules/three/build/three.module.js","three/addons/":"/app/node_modules/three/examples/jsm/"}}</script>
</head><body><div id="app"></div>
<script type="module">
import * as THREE from 'three';
import { computeLayout, PRESETS } from '/src/params.js';
import { setupEnvironment } from '/src/env/index.js';
import { setupPost } from '/src/env/post.js';
import { createVillage } from '/src/village/adapter.js';

const q = new URLSearchParams(location.search);
const scale = q.get('scale') || 'village';
const seedRaw = q.get('seed');
const seed = seedRaw != null ? (isNaN(+seedRaw) ? seedRaw : +seedRaw) : 20260716;
const view = q.get('view') || 'aerial';
const targetKind = q.get('target') || 'dog';
const time = q.get('time') || 'day';
const season = q.get('season') || 'summer';
const warm = parseFloat(q.get('warm') || '0');
const num = (k, d) => { const v = parseFloat(q.get(k)); return Number.isFinite(v) ? v : d; };

{ let s = 0x2545f491 >>> 0; Math.random = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

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

const ground = new THREE.Mesh(new THREE.CircleGeometry(160, 48), new THREE.MeshStandardMaterial({ color: 0xb5a893, roughness: 1 }));
ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);

const camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, 0.1, 500);

const env = setupEnvironment(scene, { sun, hemi, renderer, layout: computeLayout(PRESETS.korea) });
const post = setupPost({ renderer, scene, camera });
post.setSize(innerWidth, innerHeight);
env.setEnabled(true); env.setTime(time); post.setTime(time);

const villageHandle = createVillage({ scale, seed });
villageHandle.enterVillageMode({ scene, building: null, ground, env });
villageHandle.setTime(time);
env.setSeason(season, { immediate: true });
villageHandle.setSeason(season, { immediate: true });

const R = villageHandle.plan.site.R;
if (scene.fog) { scene.fog.near = R * 2.2; scene.fog.far = R * 7.0; }
camera.far = R * 8; camera.near = 0.5; camera.updateProjectionMatrix();

const critGroup = villageHandle.group.getObjectByName('village-critters');
const meshByName = {};
if (critGroup) critGroup.traverse((o) => { if (o.isInstancedMesh) meshByName[o.name] = o; });
function instPositions(name) {
  const m = meshByName[name]; if (!m) return [];
  const mat = new THREE.Matrix4(), p = new THREE.Vector3(), out = [];
  m.updateWorldMatrix(true, false);
  for (let i = 0; i < m.count; i++) { m.getMatrixAt(i, mat); p.setFromMatrixPosition(mat); p.applyMatrix4(m.matrixWorld); out.push({ x: p.x, y: p.y, z: p.z }); }
  return out;
}
const nameFor = { dog: 'v-dogs', cat: 'v-cats', magpie: 'v-magpies', birds: 'birds' };
// 논 소(animals.js name='cow') 월드 위치 수집.
const cowGroups = [];
villageHandle.group.traverse((o) => { if (o.name === 'cow') cowGroups.push(o); });
function cowPositions() { return cowGroups.map((g) => { g.updateWorldMatrix(true, false); const p = new THREE.Vector3().setFromMatrixPosition(g.matrixWorld); return { x: p.x, y: p.y, z: p.z }; }); }
window.__CRIT = {
  present: !!critGroup,
  meshes: Object.keys(meshByName),
  drawMeshes: critGroup ? critGroup.children.filter((c) => c.isMesh || c.isInstancedMesh).length : 0,
  counts: { dogs: (meshByName['v-dogs']?.count) || 0, cats: (meshByName['v-cats']?.count) || 0, magpies: (meshByName['v-magpies']?.count) || 0, birds: (meshByName['birds']?.count) || 0, cows: cowGroups.length },
};
window.__flock = () => (villageHandle.group.userData.faunaDebug?.flock?.() || null);
// 실제 새 인스턴스 위치에서 편대성을 잰다(진행방향 기준 좌우 팔·최대 폭·선두 앞 개체 수).
window.__formation = () => {
  const mesh = meshByName['birds'];
  const state = window.__flock();
  if (!mesh || !state) return null;
  const mat = new THREE.Matrix4(), p = new THREE.Vector3(), pts = [];
  for (let i = 0; i < mesh.count; i++) { mesh.getMatrixAt(i, mat); p.setFromMatrixPosition(mat); pts.push(p.clone()); }
  const fx = Math.cos(state.heading), fz = Math.sin(state.heading);
  let lead = pts[0], leadAlong = -Infinity;
  for (const q2 of pts) { const a = q2.x * fx + q2.z * fz; if (a > leadAlong) { leadAlong = a; lead = q2; } }
  let left = 0, right = 0, width = 0, ahead = 0, depth = 0;
  for (const q2 of pts) {
    if (q2 === lead) continue;
    const dx = q2.x - lead.x, dz = q2.z - lead.z;
    const along = dx * fx + dz * fz, cross = dx * -fz + dz * fx;
    if (along > 0.5) ahead++;
    if (cross < 0) left++; else right++;
    width = Math.max(width, Math.abs(cross));
    depth = Math.max(depth, -along);
  }
  return { species: state.species, formation: state.formation, count: mesh.count, left, right, ahead, width: +width.toFixed(1), depth: +depth.toFixed(1), bank: +state.bank.toFixed(3), rotations: state.rotations };
};
window.__resources = () => {
  renderer.render(scene, camera);   // 컴포저 밖 직접 렌더 — info.calls 가 전체 씬을 센다
  const keys = renderer.info.programs.map((program) => program.cacheKey);
  return {
    calls: renderer.info.render.calls, triangles: renderer.info.render.triangles,
    programs: renderer.info.programs.length,
    critterPrograms: keys.filter((key) => key.includes('cheoma-critter-articulation')).length,
    geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures,
  };
};
window.__critterOnly = (on) => {
  const group = villageHandle.group.getObjectByName('village-critters');
  if (group) group.visible = !!on;
  return window.__resources();
};
window.__advance = (secs) => { const n = Math.max(1, Math.round(secs / (1 / 60))); for (let i = 0; i < n; i++) { villageHandle.updateLod(camera); villageHandle.update(1 / 60); } };
// LOD 램프 실측: 지상 소는 근경 1→원경 0으로 자연스럽게 잠들고, 하늘 새 떼만 부감 실루엣을 유지한다.
window.__lodSweep = (heights) => {
  const cow = (() => { let g = null; villageHandle.group.traverse((o) => { if (o.name === 'cow') g = o; }); return g; })();
  const birds = meshByName['birds'];
  const fauna = villageHandle.group.userData.faunaLod;
  const savePosition = camera.position.clone();
  const cowWorld = cow ? cow.getWorldPosition(new THREE.Vector3()) : new THREE.Vector3();
  const detailTarget = { x: cowWorld.x, z: cowWorld.z };
  const m = new THREE.Matrix4(), s = new THREE.Vector3();
  const out = [];
  // aerial 페이지에서 실행해도 XZ를 실제 소 주변으로 옮겨, 높이만 바뀌는 순수 near↔far 계약을 잰다.
  camera.position.x = cowWorld.x + 5;
  camera.position.z = cowWorld.z + 9;
  for (const height of heights) {
    camera.position.y = cowWorld.y + height;
    villageHandle.updateLod(camera, detailTarget);
    villageHandle.update(1 / 60);
    villageHandle.updateLod(camera, detailTarget);
    let birdSx = null; if (birds) { birds.getMatrixAt(0, m); m.decompose(new THREE.Vector3(), new THREE.Quaternion(), s); birdSx = +s.x.toFixed(3); }
    out.push({
      viewHeight: height,
      groundWeight: fauna ? +fauna.groundWeight.toFixed(3) : null,
      cowVisible: cow ? cow.parent.visible : null,
      baseActive: fauna?.baseAnimals?.active ?? null,
      birdSx,
    });
  }
  camera.position.copy(savePosition); villageHandle.updateLod(camera);
  return out;
};
window.__posOf = (kind) => (kind === 'cow' ? cowPositions() : instPositions(nameFor[kind] || 'v-dogs'));
window.__flockCenter = () => { const ps = instPositions('birds'); if (!ps.length) return null; let x = 0, y = 0, z = 0; for (const p of ps) { x += p.x; y += p.y; z += p.z; } return { x: x / ps.length, y: y / ps.length, z: z / ps.length }; };
// 월드 → 캔버스 디바이스 픽셀(크롭 조준용).
window.__project = (p) => { const v = new THREE.Vector3(p.x, p.y, p.z).project(camera); const W = renderer.domElement.width, H = renderer.domElement.height; return { x: (v.x * 0.5 + 0.5) * W, y: (-v.y * 0.5 + 0.5) * H, dpr: renderer.getPixelRatio() }; };

// 지상 인스턴스 행렬은 update() 에서만 써지므로, 조준 전에 항상 한 번은 돌린다.
{
  const seconds = Math.max(view === 'skein' ? 0 : 1.5, warm);
  for (let i = 0; i < Math.round(seconds * 60); i++) { villageHandle.update(1 / 60); villageHandle.updateLod(camera); }
}
if (view === 'near') {
  // 개는 대문 안쪽, 고양이는 담장 위에 있다 → 담을 넘겨다보는 45° 내림각으로 조준한다.
  const ps = instPositions(nameFor[targetKind] || 'v-dogs');
  const idx = Math.min(ps.length - 1, Math.max(0, parseInt(q.get('idx') || '0', 10) || 0));
  const tgt = ps[idx] || { x: 0, y: villageHandle.plan.site.heightAt(0, 0), z: 0 };
  camera.fov = num('fov', 26);
  camera.position.set(tgt.x + num('cx', 3.5), tgt.y + num('cy', 7), tgt.z + num('cz', 7));
  camera.lookAt(tgt.x, tgt.y + 0.4, tgt.z);
  window.__CRIT.aimAt = tgt;
} else if (view === 'paddy') {
  // 논 소를 중거리로 조준 — fade band에서 크기/활동이 자연스럽게 줄어드는지 확인.
  const ps = cowPositions();
  const tgt = ps[0] || { x: 0, y: villageHandle.plan.site.heightAt(0, 0), z: 0 };
  camera.fov = num('fov', 34);
  camera.position.set(tgt.x + num('cx', 6), tgt.y + num('cy', 52), tgt.z + num('cz', 62));
  camera.lookAt(tgt.x, tgt.y, tgt.z);
  window.__CRIT.aimAt = tgt;
} else if (view === 'cownear') {
  // 논 소를 근접에서 조준 — 실제 크기(1x)와 동작이 유지되는지 확인.
  const ps = cowPositions();
  const tgt = ps[0] || { x: 0, y: villageHandle.plan.site.heightAt(0, 0), z: 0 };
  camera.fov = num('fov', 30);
  camera.position.set(tgt.x + num('cx', 5), tgt.y + num('cy', 4), tgt.z + num('cz', 9));
  camera.lookAt(tgt.x, tgt.y + 0.8, tgt.z);
  window.__CRIT.aimAt = tgt;
} else if (view === 'skein') {
  // 편대 판독용: 무리 중심을 향해 능선 위 하늘 밴드를 담는다(부감보다 낮은 시선).
  for (let i = 0; i < Math.round(warm * 60); i++) { villageHandle.update(1 / 60); villageHandle.updateLod(camera); }
  const c = window.__flockCenter() || { x: 0, y: 60, z: 0 };
  camera.fov = num('fov', 30);
  const dist = num('dist', 95);
  // 편대는 위·뒤에서 봐야 V가 읽힌다(옆에서 보면 한 줄로 겹친다). 부감 프레이밍과 같은 시선각.
  camera.position.set(c.x - dist * 0.55, c.y + num('cy', 42), c.z + dist);
  camera.lookAt(c.x, c.y, c.z);
  window.__CRIT.aimAt = c;
} else {
  // aerial: 기본 부감(마을 전체) — 지상 동물은 sleep, 새 떼만 하늘 실루엣으로 유지.
  camera.fov = num('fov', 42);
  camera.position.set(0.20 * R, 1.02 * R, 1.98 * R);
  camera.lookAt(0, 0.06 * R, -0.10 * R);
}
camera.updateProjectionMatrix();
window.__PLAN = { scale, seed, R, time, camY: +camera.position.y.toFixed(1) };

let frames = 0;
renderer.setAnimationLoop(() => {
  villageHandle.update(1 / 60);
  villageHandle.updateLod(camera);   // 공통 시선-셀 LOD(앱 engine 렌더 루프 준용)
  post.update(); post.composer.render();
  frames++;
  if (frames === 24) { window.__PLAN.perf = { calls: renderer.info.render.calls, tris: renderer.info.render.triangles }; window.__SHOT_READY = true; }
});
</script></body></html>`;

const server = createServer(async (req, res) => {
  const path = req.url.split('?')[0];
  if (path === '/__crit') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(HTML); return; }
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
// ── LOD 게이트(한 세트): 부감=지상 동물 sleep+새 떼 유지, 근접=소동물 1x 실제 크기.
//   seed 12=개활 논. crop 금지, 앱 villageAerial 프레이밍 풀프레임.
const shots = [
  // 원경(부감) — 지상 동물은 숨고 하늘 새 떼만 읽힘
  ['aerial-s12-sunset', '/__crit?scale=village&seed=12&view=aerial&time=sunset', 1280, 900],
  ['aerial-s12-day', '/__crit?scale=village&seed=12&view=aerial&time=day', 1280, 900],
  // 가을·겨울 하늘의 기러기 V자 편대 vs 봄·여름 텃새 무리(같은 카메라·같은 seed).
  ['skein-autumn-sunset', '/__crit?scale=village&seed=12&view=skein&season=autumn&time=sunset&warm=40', 1280, 900],
  ['skein-winter-day', '/__crit?scale=village&seed=12&view=skein&season=winter&time=day&warm=70', 1280, 900],
  ['flock-summer-sunset', '/__crit?scale=village&seed=12&view=skein&season=summer&time=sunset&warm=40', 1280, 900],
  ['aerial-autumn-sunset', '/__crit?scale=village&seed=12&view=aerial&season=autumn&time=sunset&warm=40', 1280, 900],
  // 근접 — 소·개·고양이·까치가 실제 크기로 나타나고 애니메이션이 깨어나는지 확인.
  ['near-cow-s12', '/__crit?scale=village&seed=12&view=cownear&time=sunset', 1280, 900],
  ['near-dog', '/__crit?scale=village&seed=12&view=near&target=dog&time=day', 1280, 900],
  ['near-dog-sunset', '/__crit?scale=village&seed=12&view=near&target=dog&time=sunset&season=autumn&warm=12', 1280, 900],
  ['near-dog2-sunset', '/__crit?scale=village&seed=12&view=near&target=dog&idx=2&time=sunset&season=autumn&warm=26', 1280, 900],
  ['near-cat', '/__crit?scale=village&seed=12&view=near&target=cat&time=day', 1280, 900],
  ['near-cat-sunset', '/__crit?scale=village&seed=12&view=near&target=cat&time=sunset&season=autumn&warm=12', 1280, 900],
  ['near-cat2-sunset', '/__crit?scale=village&seed=12&view=near&target=cat&idx=3&time=sunset&season=autumn&warm=30&fov=20', 1280, 900],
  ['near-cat3-day', '/__crit?scale=village&seed=12&view=near&target=cat&idx=6&time=day&season=summer&warm=8&fov=22', 1280, 900],
  ['near-magpie', '/__crit?scale=village&seed=12&view=near&target=magpie&time=day', 1280, 900],
].filter(([name]) => !filter || name.includes(filter));

const browser = await launchVerificationBrowser();

let pageErrs = 0, consoleErrs = 0, sweptOnce = false;
for (const [name, qs, vw, vh] of shots) {
  const page = await browser.newPage({ viewport: { width: vw, height: vh } });
  page.on('console', (msg) => { if (msg.type() === 'error') { const t = msg.text(); if (!/favicon|404/.test(t)) { consoleErrs++; console.error('[console]', name, t); } } });
  page.on('pageerror', (err) => { pageErrs++; console.error('[pageerror]', name, err.message); });
  const url = `http://127.0.0.1:${port}${qs}`;
  await page.goto(url, { waitUntil: 'load' });
  try { await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 60000 }); }
  catch { console.error('TIMEOUT', name); }
  await page.waitForTimeout(150);
  const motion = await page.evaluate(() => {
    if (!window.__posOf) return null;
    const a = window.__posOf('dog'); window.__advance(2.0); const b = window.__posOf('dog');
    if (!a.length) return { count: 0, avg: 0 };
    let sum = 0; for (let i = 0; i < a.length; i++) sum += Math.hypot(b[i].x - a[i].x, b[i].z - a[i].z);
    return { count: a.length, avg: +(sum / a.length).toFixed(3) };
  });
  const info = await page.evaluate(() => ({ plan: window.__PLAN, crit: window.__CRIT }));
  const file = join(OUT, `crit-${name}.png`);
  await page.screenshot({ path: file });   // 풀프레임만(crop 게이트 무효 — 앱 villageAerial 프레이밍 그대로)
  // LOD 램프 실측(첫 shot에서 1회): camera.y 스윕 → 지상 1→0·하늘 1→부감 실루엣이 매끄러운지.
  if (!sweptOnce) {
    sweptOnce = true;
    const R = info.plan?.R || 128;
    const ys = [8, 20, R * 0.45, R * 0.55, R * 0.7, R * 0.85, R * 0.9, R * 1.02].map((v) => +v.toFixed(1));
    const sweep = await page.evaluate((arr) => window.__lodSweep(arr), ys);
    const near = sweep[0], far = sweep[sweep.length - 1];
    if (!near?.cowVisible || !(near.baseActive > 0) || near.groundWeight < 0.99) {
      throw new Error(`near fauna did not wake: ${JSON.stringify(near)}`);
    }
    if (far?.cowVisible || far?.baseActive !== 0 || far?.groundWeight > 0.002) {
      throw new Error(`far fauna did not sleep: ${JSON.stringify(far)}`);
    }
    console.log('LOD sweep (viewHeight→ground/cow/baseActive/birdSx):', JSON.stringify(sweep));
  }
  const extra = await page.evaluate(() => ({
    formation: window.__formation ? window.__formation() : null,
    withCritters: window.__critterOnly ? window.__critterOnly(true) : null,
    withoutCritters: window.__critterOnly ? window.__critterOnly(false) : null,
  }));
  await page.evaluate(() => window.__critterOnly && window.__critterOnly(true));
  const c = info.crit || {};
  console.log(`${name.padEnd(22)} R=${info.plan?.R} present=${c.present} drawMeshes=${c.drawMeshes} counts=${JSON.stringify(c.counts)} dogMotion=${JSON.stringify(motion)} calls=${info.plan?.perf?.calls}`);
  console.log(`  formation=${JSON.stringify(extra.formation)}`);
  console.log(`  resources on =${JSON.stringify(extra.withCritters)}`);
  console.log(`  resources off=${JSON.stringify(extra.withoutCritters)}`);
  await page.close();
}
console.log(`\npageerror=${pageErrs} console-error=${consoleErrs}`);
await browser.close();
server.close();
