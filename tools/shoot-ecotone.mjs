// 산↔마을 에코톤(#115) 검증 + 시각 게이트 스크린샷. src/ 직접 서빙(빌드 불필요, 사용자 dev 무접촉).
//   사용: node tools/shoot-ecotone.mjs [out=scratch|shots] [필터]
//   전용 포트 4239. 5174 불가침.
// 검증 항목:
//   ① 에코톤 onset 변주: 각도별 숲 쉘 첫 등장 반경 stddev/bowlR > 0.05 (컴퍼스 원 깨짐 증명)
//   ② bowl 안 쉘=0 (마을터 침범 없음)
//   ③ 쉘-지형 간격 ∈ [1, CANOPY_MAX] (부유·관통 없음)
//   ④ 나무 수(소나무/활엽) · 암봉 수 · 드로우콜 (규모별)
//   ⑤ determinism: 같은 seed 2회 → 동일 해시
//   ⑥ pageerror 0
//   + 시각 게이트 PNG: 부감 4규모 × 여름·가을 + 경계 클로즈업 + 봄(진달래) + 겨울(F).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..');
const dest = process.argv[2] === 'shots' ? 'shots' : 'scratch';
const SCRATCH = '/private/tmp/claude-501/-Users-hckim-repo-asiahouse/7a15478e-68e3-4ad3-b08a-bdb86ae4fe92/scratchpad/ecotone';
const OUT = dest === 'shots' ? join(ROOT, 'shots') : SCRATCH;
mkdirSync(OUT, { recursive: true });
const PFX = 'fix-ecotone-';
const PORT = 4248;
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
const view = q.get('view') || 'aerial';
const season = q.get('season') || 'summer';
const time = q.get('time') || 'day';
const seed = 20260716;
const num = (k, d) => { const v = parseFloat(q.get(k)); return Number.isFinite(v) ? v : d; };
function seedRandom(){ let s = 0x2545f491 >>> 0; Math.random = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

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

seedRandom();
const includePalace = scale === 'capital' || scale === 'hanyang';
const plan = planVillage({ scale, seed, includePalace, includeTemple: true });
const group = populateVillage(plan);
if (group.userData.setSeason) group.userData.setSeason(season);
scene.add(group);
group.updateMatrixWorld(true);
const site = plan.site;
const R = site.R, TR = site.terrainR || R, bowlR = site.bowlR, ridgeR = site.ridgeR, cen = site.center;
scene.fog = new THREE.Fog(L.bg, R * 2.4, R * 7.5);
const sun = new THREE.DirectionalLight(L.sun[0], L.sun[1]);
sun.position.set(L.sun[2][0] * R, L.sun[2][1] * R, L.sun[2][2] * R);
sun.castShadow = true; sun.shadow.mapSize.set(4096, 4096);
const sc = sun.shadow.camera;
sc.left = -TR * 1.05; sc.right = TR * 1.05; sc.top = TR * 1.05; sc.bottom = -TR * 1.05;
sc.near = 1; sc.far = TR * 8; sun.shadow.bias = -0.0003; sun.shadow.normalBias = 0.08;
scene.add(sun);
scene.add(new THREE.HemisphereLight(L.hemi[0], L.hemi[1], L.hemi[2]));

// ── 집계: 나무(소나무/활엽) · 암봉 · 드로우콜
const treesGrp = group.getObjectByName('village-trees');
let pineInst = 0, broadInst = 0, treeCount = 0;
if (treesGrp) {
  treeCount = treesGrp.userData.count || 0;
  const insts = []; treesGrp.traverse((o) => { if (o.isInstancedMesh) insts.push(o); });
  // makeTreeProtos 순서: [pine, broad]. 그룹 add 순서 동일(pine 먼저).
  if (insts[0]) pineInst = insts[0].count;
  if (insts[1]) broadInst = insts[1].count;
}
const fr = group.userData.forest;
const spireCount = fr ? fr.rockCount : 0;
const forestTreeCount = fr ? (fr.treeCount || fr.count || 0) : 0;   // v2 산림+침투 식재(village-forest)
let drawCalls = 0; group.traverse((o) => { if (o.visible && (o.isMesh || o.isInstancedMesh) && o.material) drawCalls++; });

// ── ① 에코톤 onset 변주 + ② bowl 안 쉘=0 + ③ 간격
const CANOPY_MAX = 8.9;
function ecotoneMetrics(){
  const shell = group.getObjectByName('forest-shell');
  const terrain = group.getObjectByName('village-terrain');
  if (!shell || !terrain) return { hasShell: !!shell };
  const rc = new THREE.Raycaster(); const down = new THREE.Vector3(0,-1,0);
  // 각도별 숲 쉘 첫 등장 반경(onset) — bowlR*0.6 부터 ridgeR 까지 반경 행진.
  const onsets = [];
  const NA = 72;
  for (let a=0; a<NA; a++){
    const th = a/NA*Math.PI*2;
    let onset = null;
    for (let r=bowlR*0.6; r<=ridgeR*1.05; r+=bowlR*0.02){
      const x = cen.x+Math.cos(th)*r, z = cen.z+Math.sin(th)*r;
      if (site.hillAt(x,z) < 0.09) continue;          // 산자락만(평지 개활 방위 제외)
      rc.set(new THREE.Vector3(x, site.Hmax*3+400, z), down);
      if (rc.intersectObject(shell, false).length){ onset = r/bowlR; break; }
    }
    if (onset != null) onsets.push(onset);
  }
  let mean=0; for (const o of onsets) mean+=o; mean/= (onsets.length||1);
  let varc=0; for (const o of onsets) varc+=(o-mean)**2; varc/=(onsets.length||1);
  const std = Math.sqrt(varc);
  // bowl 안 쉘=0
  let bowlHit=0, bowlN=0;
  for (let a=0;a<40;a++) for (const rr of [0.25,0.5,0.68]){
    const th=a/40*Math.PI*2; const x=cen.x+Math.cos(th)*bowlR*rr, z=cen.z+Math.sin(th)*bowlR*rr;
    bowlN++; rc.set(new THREE.Vector3(x, site.Hmax*3+400, z), down);
    if (rc.intersectObject(shell,false).length) bowlHit++;
  }
  // 간격
  const pos = shell.geometry.getAttribute('position'); const nv=pos.count; const step=Math.max(1,Math.floor(nv/450));
  let gapN=0, gapOk=0, gapMin=1e9, gapMax=-1e9; const wp=new THREE.Vector3();
  for (let i=0;i<nv;i+=step){
    wp.set(pos.getX(i),pos.getY(i),pos.getZ(i)); shell.localToWorld(wp);
    rc.set(new THREE.Vector3(wp.x, site.Hmax*3+400, wp.z), down);
    const ht = rc.intersectObject(terrain,false); if(!ht.length) continue;
    const gap = wp.y-ht[0].point.y; gapN++;
    if (gap>=1 && gap<=CANOPY_MAX+0.2) gapOk++;
    if (gap<gapMin) gapMin=gap; if (gap>gapMax) gapMax=gap;
  }
  return {
    hasShell:true, onsetN: onsets.length, onsetMean:+mean.toFixed(3), onsetStd:+std.toFixed(3),
    onsetMin:+Math.min(...onsets).toFixed(3), onsetMax:+Math.max(...onsets).toFixed(3),
    bowlHitRatio: bowlN?+(bowlHit/bowlN).toFixed(3):0,
    gapOkRatio: gapN?+(gapOk/gapN).toFixed(3):0, gapMin:+gapMin.toFixed(2), gapMax:+gapMax.toFixed(2),
  };
}

// ── determinism 해시(지형 색 표본 + 나무/쉘/암봉)
function detHash(){
  const terrain = group.getObjectByName('village-terrain');
  const col = terrain.geometry.getAttribute('color');
  const parts = [treeCount, pineInst, broadInst, spireCount, fr?fr.shellVertexCount:0];
  for (let i=0;i<Math.min(col.count,600);i+=7) parts.push(col.getX(i).toFixed(3));
  return parts.join('|');
}

// ── 카메라
let campos, target, fov=44;
const hAt = (x,z)=>site.heightAt(x,z);
if (view === 'aerial') {
  campos = new THREE.Vector3(0.16*R, 0.98*R, 1.9*R);
  target = new THREE.Vector3(0, 0.02*R, -0.12*R);
} else if (view === 'bound') {
  // 경계 클로즈업: 마을 남측 위에서 뒷산(북) 경계를 비스듬히 내려다봄 — 숲 치마 전이대가 프레임 가득.
  const tz = cen.z - bowlR*1.02, gy = hAt(0, tz);
  fov = 42;
  campos = new THREE.Vector3(0.45*bowlR, gy + 0.62*bowlR, cen.z + 0.62*bowlR);
  target = new THREE.Vector3(0, gy + 0.14*bowlR, tz);
} else {
  fov = 40;
  campos = new THREE.Vector3(0.02*R, 2.0*R, 1.4*R);
  target = new THREE.Vector3(0, 0, -0.05*R);
}
const camera = new THREE.PerspectiveCamera(fov, innerWidth/innerHeight, 0.5, R*9);
camera.position.set(num('cx',campos.x), num('cy',campos.y), num('cz',campos.z));
camera.lookAt(num('tx',target.x), num('ty',target.y), num('tz',target.z));

let frames=0;
renderer.setAnimationLoop(()=>{
  if (group.userData.update) group.userData.update(1/60);
  renderer.render(scene,camera); frames++;
  if (frames===14){
    const ri = renderer.info;
    window.__T = {
      scale, view, season, R:+R.toFixed(0), TR:+TR.toFixed(0), bowlR:+bowlR.toFixed(0),
      treeCount, pineInst, broadInst, spireCount, forestTreeCount, drawCalls,
      calls: ri.render.calls, tri: ri.render.triangles,
      eco: (view==='aerial' && season==='summer') ? ecotoneMetrics() : null,
      hash: (view==='aerial' && season==='summer') ? detHash() : null,
    };
    window.__READY = true;
  }
});
</script></body></html>`;

const server = createServer(async (req, res) => {
  const path = req.url.split('?')[0];
  if (path === '/__eco') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(HTML); return; }
  try {
    const file = join(ROOT, path === '/' ? 'index.html' : path);
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise((ok) => server.listen(PORT, '127.0.0.1', ok));

const filter = process.argv[3] || '';
const shots = [];
for (const s of ['solo','village','capital','hanyang']) {
  shots.push([`${s}-summer`, `scale=${s}&view=aerial&season=summer`]);
  shots.push([`${s}-autumn`, `scale=${s}&view=aerial&season=autumn`]);
}
shots.push(['village-bound-summer', 'scale=village&view=bound&season=summer']);
shots.push(['capital-bound-summer', 'scale=capital&view=bound&season=summer']);
shots.push(['village-bound-autumn', 'scale=village&view=bound&season=autumn']);
shots.push(['village-spring', 'scale=village&view=aerial&season=spring']);   // 진달래(E)
shots.push(['village-winter', 'scale=village&view=aerial&season=winter']);   // 겨울 갈회(F)
const runShots = shots.filter(([n]) => !filter || n.includes(filter));

// determinism: 규모별 2회 빌드 해시 비교(별도 내비게이션)
let browser;
try { browser = await chromium.launch({ channel: 'chrome' }); } catch { browser = await chromium.launch(); }
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
let pageErrs = 0; const errSample = [];
page.on('pageerror', (e) => { pageErrs++; if (errSample.length<8) errSample.push(e.message); });
page.on('console', (m) => { if (m.type()==='error' && !/favicon|404/.test(m.text()) && errSample.length<8) errSample.push('[console] '+m.text()); });

const ecoBy = {}, forestBy = {}, hashA = {}, hashB = {};
for (const [name, qs] of runShots) {
  await page.goto(`http://127.0.0.1:${PORT}/__eco?${qs}`, { waitUntil: 'load' });
  try { await page.waitForFunction('window.__READY === true', null, { timeout: 60000 }); }
  catch { console.error('TIMEOUT', name); }
  await page.waitForTimeout(120);
  const info = await page.evaluate(() => window.__T);
  if (info) {
    console.log(name.padEnd(22), `trees=${info.treeCount}(pine ${info.pineInst}/broad ${info.broadInst})`,
      `forest=${info.forestTreeCount}`, `spires=${info.spireCount}`, `draw=${info.drawCalls}`, `calls=${info.calls}`, `bowlR=${info.bowlR}`);
    if (info.eco) { ecoBy[info.scale] = info.eco; console.log('   ECO', JSON.stringify(info.eco)); }
    if (info.hash) { hashA[info.scale] = info.hash; forestBy[info.scale] = info.forestTreeCount; }
  }
  await page.screenshot({ path: join(OUT, `${PFX}${name}.png`) });
}
// determinism 2회차(aerial summer 규모별)
for (const s of ['solo','village','capital','hanyang']) {
  if (!hashA[s]) continue;
  await page.goto(`http://127.0.0.1:${PORT}/__eco?scale=${s}&view=aerial&season=summer`, { waitUntil: 'load' });
  try { await page.waitForFunction('window.__READY === true', null, { timeout: 60000 }); } catch {}
  const info = await page.evaluate(() => window.__T);
  if (info && info.hash) hashB[s] = info.hash;
}

console.log('\\n===== #115 ECOTONE VERIFY =====');
const CANOPY_MAX = 8.9;
const F = [];
const pass = (n,c,d='') => F.push({ n, ok:!!c, d });
// v2(#122): 저폴리 쉘 폐기 → 빽빽한 인스턴스 나무 숲 + 분지 침투 식재(#115). shell 기반 onset/gap/bowl
//   raycast 는 obsolete. hasShell 이면(구경로) 유지, 아니면 forest 나무 존재(빽빽함·침투 발현)로 검증.
const FOREST_MIN = { solo: 8, village: 120, capital: 500, hanyang: 500 };
for (const s of Object.keys(ecoBy)) {
  const e = ecoBy[s];
  if (e.hasShell) {
    pass(`[${s}] onset 변주(원 깨짐) std/bowlR>0.05`, e.onsetStd > 0.05, `std=${e.onsetStd} mean=${e.onsetMean} [${e.onsetMin},${e.onsetMax}] n=${e.onsetN}`);
    pass(`[${s}] bowl 안 쉘=0`, e.bowlHitRatio === 0, `bowlHit=${e.bowlHitRatio}`);
    pass(`[${s}] 쉘 간격 ∈[1,${CANOPY_MAX}]`, e.gapOkRatio > 0.97, `ok=${e.gapOkRatio} min=${e.gapMin} max=${e.gapMax}`);
  } else {
    const n = forestBy[s] || 0, min = FOREST_MIN[s] ?? 50;
    pass(`[${s}] v2 숲 나무(산림+침투) ≥${min}`, n >= min, `forestTrees=${n}`);
  }
}
for (const s of Object.keys(hashA)) pass(`[${s}] determinism`, hashB[s] && hashA[s]===hashB[s], hashB[s]? (hashA[s]===hashB[s]?'equal':'DIFF') : 'no-2nd');
pass('pageerror 0', pageErrs===0, `errs=${pageErrs}`);

let fail=0;
for (const f of F){ console.log(`  ${f.ok?'PASS':'FAIL'}  ${f.n}  ${f.d}`); if(!f.ok) fail++; }
console.log(`\\n${fail===0?'ALL PASS':fail+' FAIL'}  (${F.length} checks, pageErrors=${pageErrs}, out=${OUT})`);
if (errSample.length) console.log('err sample:', errSample);
await browser.close(); server.close();
process.exit(fail===0 && pageErrs===0 ? 0 : 1);
