// #83 필지 등롱 검증 — 렌더 캡처 없음. 코어(buildParcel/planVillage/populateVillage) + env/motes.js
//   setupLanternSway 를 esbuild 로 번들해 헤드리스 크로미움에서 실행하고 수치만 단언한다.
//   앱 dev 서버(5174) 불침해, 전용 포트 4220.
//
//   실행: node tools/verify-lantern.mjs   (playwright 는 tools/node_modules 에서 해석)
//
//   검증 항목
//     ① 마을 규모 3종(hamlet/town/capital): 등롱 보유 필지 수·대문/마당 등롱 수, hanjiGlow 재질 존재,
//        드로우콜 before/after(등롱 제거 빌드 대비 델타 ≤2, flora-lantern 발광 레이어 1).
//     ② focus 오버레이 계약: buildParcel(기본)=필지 루트 직속 PointLight+소형 bulb 짝 발견>0
//        (env/motes.js setupLanternSway.detect 규약 재현) / lanterns:false=0(병합 안전).
//     ③ setupLanternSway 실구동: 오버레이 컴파운드에 붙여 ~2s 업데이트 → bulb 위치 흔들림 발현.
//     ④ 결정론: 같은 seed → plan.lantern 배정·flora-lantern 삼각형·오버레이 bulb 위치 동일.
//     ⑤ 공유 glow 재질 동일성: 마을 flora-lantern 재질 === 오버레이 bulb 재질(어댑터 야간 램프 단일 경로).
//     ⑥ pageerror/예외 0.

import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const reqApp = createRequire(join(ROOT, 'app', 'package.json'));
const reqTools = createRequire(join(ROOT, 'tools', 'package.json'));
const esbuild = reqApp('esbuild');
const { chromium } = reqTools('playwright');

const THREE_MAIN = join(ROOT, 'app/node_modules/three/build/three.module.js');
const THREE_ADDONS = join(ROOT, 'app/node_modules/three/examples/jsm');
const PORT = 4220;
const SEED = 20260716;

const ENTRY = `
import * as THREE from 'three';
import { buildParcel } from '${ROOT}/src/layout/parcel.js';
import { planVillage } from '${ROOT}/src/village/plan.js';
import { populateVillage } from '${ROOT}/src/village/populate.js';
import { setupLanternSway } from '${ROOT}/src/env/motes.js';
import { getLanternMaterials } from '${ROOT}/src/layout/props.js';

function floraGroup(root){ let f=null; root.traverse(o=>{ if(!f && o.name==='village-flora') f=o; }); return f; }
function floraMeshNames(root){ const f=floraGroup(root); if(!f) return []; return f.children.filter(o=>o.isMesh).map(o=>o.name); }
function totalMeshes(root){ let n=0; root.traverse(o=>{ if(o.isMesh||o.isInstancedMesh) n++; }); return n; }
function hanjiMatSet(root){ const s=new Set(); root.traverse(o=>{ const mm=Array.isArray(o.material)?o.material:(o.material?[o.material]:[]); for(const m of mm){ if(m&&m.userData&&m.userData.hanjiGlow!=null) s.add(m); } }); return s; }
function lanternMeshMat(root){ const f=floraGroup(root); if(!f) return null; const m=f.children.find(o=>o.isMesh && o.name==='flora-lantern'); return m?m.material:null; }
function triCount(mesh){ if(!mesh||!mesh.geometry) return 0; const g=mesh.geometry; const idx=g.getIndex(); const p=g.getAttribute('position'); return idx?idx.count/3:(p?p.count/3:0); }
function lanternTris(root){ const f=floraGroup(root); if(!f) return 0; const m=f.children.find(o=>o.isMesh && o.name==='flora-lantern'); return triCount(m); }

function lanternStats(plan){
  let gate=0, yard=0, withAny=0;
  for(const p of plan.parcels){ const L=p.lantern||{gate:0,yard:0}; gate+=(L.gate||0); yard+=(L.yard||0); if((L.gate||0)+(L.yard||0)>0) withAny++; }
  return { parcels: plan.parcels.length, withAny, gate, yard };
}
function lanternHash(plan){ return plan.parcels.map(p=>{ const L=p.lantern||{}; return p.id+':'+(L.gate||0)+','+(L.yard||0); }).join('|'); }

// env/motes.js setupLanternSway.detect() 규약 재현 — 스코프 직속 자식 PointLight + SphereGeometry(radius<0.5).
function detectSim(scope){
  const lights=[], bulbs=[];
  for(const o of scope.children){
    if(o.isPointLight) lights.push(o);
    else if(o.isMesh && o.geometry && o.geometry.type==='SphereGeometry' && o.geometry.parameters && o.geometry.parameters.radius<0.5) bulbs.push(o);
  }
  let paired=0;
  for(const b of bulbs){ let best=Infinity; for(const l of lights){ const d=l.position.distanceToSquared(b.position); if(d<best) best=d; } if(best<0.01) paired++; }
  return { lights: lights.length, bulbs: bulbs.length, paired };
}

function overlayCompound(style, seed, lanterns){
  const opts = { seed, style, plotW: 24, plotD: 22 };
  if (lanterns === false) opts.lanterns = false;
  return buildParcel(opts);
}

// 실제 흔들림 발현: setupLanternSway 를 컴파운드에 붙여 업데이트 → bulb 위치가 base 에서 벗어나는지.
function swayTest(style, seed){
  const scope = overlayCompound(style, seed, true);
  const scene = new THREE.Scene();
  scene.add(scope);
  const bulbs = scope.children.filter(o=>o.isMesh && o.geometry && o.geometry.type==='SphereGeometry' && o.geometry.parameters.radius<0.5);
  const base = bulbs.map(b=>b.position.clone());
  // getBuilding 미지정 → 조기노출 게이트 비활성(항상 present) → 순수 흔들림만 측정.
  const sway = setupLanternSway({ scene, scope });
  sway.setEnabled(true);
  for(let i=0;i<150;i++) sway.update(1/60);   // ~2.5s
  let maxMove=0;
  for(let i=0;i<bulbs.length;i++){ const d=bulbs[i].position.distanceTo(base[i]); if(d>maxMove) maxMove=d; }
  // 정지(setEnabled false) 시 base 복귀도 확인.
  sway.setEnabled(false);
  let maxResidual=0;
  for(let i=0;i<bulbs.length;i++){ const d=bulbs[i].position.distanceTo(base[i]); if(d>maxResidual) maxResidual=d; }
  return { bulbs: bulbs.length, maxMove, maxResidual };
}

function bulbPositions(style, seed){
  const c = overlayCompound(style, seed, true);
  return c.children.filter(o=>o.isMesh && o.geometry && o.geometry.type==='SphereGeometry' && o.geometry.parameters.radius<0.5)
    .map(b=>[+b.position.x.toFixed(4), +b.position.y.toFixed(4), +b.position.z.toFixed(4)]);
}

async function runAll(){
  const SEED = ${SEED};
  const out = { scales: [], overlay: {}, sway: {}, determinism: {}, shared: {} };
  const SCALES = ['hamlet','town','capital'];

  // ① 규모 3종 + 드로우콜 before/after
  for(const scale of SCALES){
    try {
      const planA = planVillage({ scale, seed: SEED, includeTemple: true, includePalace: scale==='capital' });
      const rootA = populateVillage(planA);
      const planB = planVillage({ scale, seed: SEED, includeTemple: true, includePalace: scale==='capital' });
      for(const p of planB.parcels) p.lantern = { gate:0, yard:0 };
      const rootB = populateVillage(planB);
      const stats = lanternStats(planA);
      const hanji = hanjiMatSet(rootA);
      const lmat = lanternMeshMat(rootA);
      out.scales.push({
        scale, ...stats,
        floraNamesA: floraMeshNames(rootA), floraNamesB: floraMeshNames(rootB),
        totalA: totalMeshes(rootA), totalB: totalMeshes(rootB),
        hanjiMats: hanji.size,
        lanternMatGlow: lmat ? (lmat.userData ? lmat.userData.hanjiGlow : null) : null,
        lanternTris: lanternTris(rootA),
      });
    } catch(e){ out.scales.push({ scale, err: String(e && e.stack || e) }); }
  }

  // ② focus 오버레이 계약 (detect 규약)
  try {
    for(const style of ['hanok','palace','temple','choga']){
      out.overlay[style] = detectSim(overlayCompound(style, 7, true));
    }
    out.overlay['hanok:off'] = detectSim(overlayCompound('hanok', 7, false));
  } catch(e){ out.overlay.err = String(e && e.stack || e); }

  // ③ 실제 흔들림 발현
  try { out.sway = swayTest('hanok', 7); }
  catch(e){ out.sway = { err: String(e && e.stack || e) }; }

  // ④ 결정론
  try {
    const p1 = planVillage({ scale:'town', seed: SEED, includeTemple:true });
    const p2 = planVillage({ scale:'town', seed: SEED, includeTemple:true });
    const planEqual = lanternHash(p1) === lanternHash(p2);
    const r1 = populateVillage(planVillage({ scale:'town', seed: SEED, includeTemple:true }));
    const r2 = populateVillage(planVillage({ scale:'town', seed: SEED, includeTemple:true }));
    const trisEqual = lanternTris(r1) === lanternTris(r2);
    const bp1 = JSON.stringify(bulbPositions('hanok', 7));
    const bp2 = JSON.stringify(bulbPositions('hanok', 7));
    out.determinism = { planEqual, trisEqual, bulbEqual: bp1===bp2, tris: lanternTris(r1) };
  } catch(e){ out.determinism = { err: String(e && e.stack || e) }; }

  // ⑤ 공유 glow 재질 동일성 (마을 flora-lantern === 오버레이 bulb === getLanternMaterials().glow)
  try {
    const root = populateVillage(planVillage({ scale:'town', seed: SEED, includeTemple:true }));
    const villageMat = lanternMeshMat(root);
    const ov = overlayCompound('hanok', 7, true);
    const bulb = ov.children.find(o=>o.isMesh && o.geometry && o.geometry.type==='SphereGeometry' && o.geometry.parameters.radius<0.5);
    const shared = getLanternMaterials().glow;
    out.shared = {
      villageIsShared: villageMat === shared,
      overlayIsShared: bulb ? bulb.material === shared : false,
      glowHanji: shared.userData.hanjiGlow,
    };
  } catch(e){ out.shared = { err: String(e && e.stack || e) }; }

  return out;
}
window.__run = runAll;
window.__READY = true;
`;

const built = await esbuild.build({
  stdin: { contents: ENTRY, resolveDir: ROOT, loader: 'js' },
  bundle: true, format: 'esm', write: false, sourcemap: false,
  alias: { three: THREE_MAIN, 'three/addons': THREE_ADDONS },
  logLevel: 'silent',
});
const BUNDLE = built.outputFiles[0].text;
const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><script type="module" src="/bundle.js"></script></body></html>`;

const server = createServer((req, res) => {
  if (req.url === '/' || req.url.startsWith('/index')) { res.setHeader('content-type', 'text/html'); res.end(PAGE); return; }
  if (req.url.startsWith('/bundle.js')) { res.setHeader('content-type', 'text/javascript'); res.end(BUNDLE); return; }
  res.statusCode = 404; res.end('nf');
});
await new Promise((r) => server.listen(PORT, r));

const pageErrors = [];
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (e) => pageErrors.push(String(e && e.stack || e)));
page.on('console', (m) => { if (m.type() === 'error') pageErrors.push('[console] ' + m.text()); });

let results = null, fatal = null;
try {
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction('window.__READY === true', { timeout: 60000 });
  results = await page.evaluate(async () => await window.__run(), { timeout: 240000 });
} catch (e) { fatal = String(e && e.stack || e); }

await browser.close();
await new Promise((r) => server.close(r));

const fails = [];
const BASELINE = ['flora-wood','flora-leaf','flora-stone','flora-blossom','flora-fruit'];
if (fatal) fails.push('FATAL: ' + fatal);

if (results) {
  console.log('\n=== ① 규모 3종 · 등롱 배치 · 드로우콜 before/after ===');
  console.log('scale'.padEnd(9), 'parcels'.padEnd(8), 'withLantern'.padEnd(12), 'gate/yard'.padEnd(11), 'floraΔ'.padEnd(8), 'totalΔ'.padEnd(8), 'hanjiMats'.padEnd(10), 'glowTag');
  for (const s of results.scales) {
    if (s.err) { fails.push(`scale ${s.scale}: ${s.err}`); console.log(s.scale.padEnd(9), 'ERR', s.err.split('\n')[0]); continue; }
    const floraDelta = s.floraNamesA.length - s.floraNamesB.length;
    const totalDelta = s.totalA - s.totalB;
    const newNames = s.floraNamesA.filter((n) => !s.floraNamesB.includes(n));
    const hasLanternLayer = s.floraNamesA.includes('flora-lantern');
    const deltaOk = totalDelta >= 0 && totalDelta <= 2 && floraDelta >= 0 && floraDelta <= 2;
    const glowOk = !s.withAny || s.lanternMatGlow === 0.30;
    const layerOk = !s.withAny || (hasLanternLayer && newNames.every((n) => n === 'flora-lantern'));
    const hanjiOk = s.hanjiMats > 0;
    if (!deltaOk) fails.push(`${s.scale}: 드로우콜 델타 floraΔ${floraDelta}/totalΔ${totalDelta} (≤2 위반)`);
    if (!glowOk) fails.push(`${s.scale}: flora-lantern glow hanjiGlow=${s.lanternMatGlow}≠0.30`);
    if (!layerOk) fails.push(`${s.scale}: 신규 flora 레이어가 flora-lantern 외 존재 (${newNames.join(',')})`);
    if (!hanjiOk) fails.push(`${s.scale}: hanjiGlow 재질 0`);
    console.log(
      s.scale.padEnd(9), String(s.parcels).padEnd(8), String(s.withAny).padEnd(12),
      `${s.gate}/${s.yard}`.padEnd(11), `+${floraDelta}${deltaOk?'':'✗'}`.padEnd(8), `+${totalDelta}${deltaOk?'':'✗'}`.padEnd(8),
      String(s.hanjiMats).padEnd(10), `${s.lanternMatGlow}${glowOk?'':'✗'}`);
  }

  console.log('\n=== ② focus 오버레이 계약 (setupLanternSway.detect 규약) ===');
  if (results.overlay.err) { fails.push('overlay: ' + results.overlay.err); console.log('ERR', results.overlay.err.split('\n')[0]); }
  else {
    for (const [style, d] of Object.entries(results.overlay)) {
      const isOff = style.endsWith(':off');
      const ok = isOff ? (d.paired === 0 && d.lights === 0 && d.bulbs === 0) : (d.paired > 0 && d.lights === d.bulbs && d.paired === d.bulbs);
      if (!ok) fails.push(`overlay ${style}: lights${d.lights}/bulbs${d.bulbs}/paired${d.paired} (기대 ${isOff?'0/0/0':'>0 짝'})`);
      console.log(`${style.padEnd(12)} lights ${d.lights} · bulbs ${d.bulbs} · paired ${d.paired} ${ok?'':'✗'}`);
    }
  }

  console.log('\n=== ③ setupLanternSway 실구동 (흔들림 발현) ===');
  const sw = results.sway;
  if (sw.err) { fails.push('sway: ' + sw.err); console.log('ERR', sw.err.split('\n')[0]); }
  else {
    const moveOk = sw.bulbs > 0 && sw.maxMove > 0.001;       // 흔들림 발현
    const resetOk = sw.maxResidual < 1e-6;                    // 정지 시 base 복귀
    if (!moveOk) fails.push(`sway: bulbs ${sw.bulbs} maxMove ${sw.maxMove} (흔들림 미발현)`);
    if (!resetOk) fails.push(`sway: setEnabled(false) 후 잔차 ${sw.maxResidual} (base 미복귀)`);
    console.log(`bulbs ${sw.bulbs} · maxMove ${sw.maxMove.toFixed(4)}m ${moveOk?'':'✗'} · 정지잔차 ${sw.maxResidual.toExponential(1)} ${resetOk?'':'✗'}`);
  }

  console.log('\n=== ④ 결정론 ===');
  const dt = results.determinism;
  if (dt.err) { fails.push('determinism: ' + dt.err); console.log('ERR', dt.err.split('\n')[0]); }
  else {
    const ok = dt.planEqual && dt.trisEqual && dt.bulbEqual;
    if (!ok) fails.push(`determinism: plan=${dt.planEqual} tris=${dt.trisEqual} bulb=${dt.bulbEqual}`);
    console.log(`plan.lantern ${dt.planEqual?'=':'≠'} · flora-lantern tris ${dt.trisEqual?'=':'≠'}(${dt.tris}) · overlay bulb pos ${dt.bulbEqual?'=':'≠'} ${ok?'':'✗'}`);
  }

  console.log('\n=== ⑤ 공유 glow 재질 동일성 (야간 램프 단일 경로) ===');
  const sh = results.shared;
  if (sh.err) { fails.push('shared: ' + sh.err); console.log('ERR', sh.err.split('\n')[0]); }
  else {
    const ok = sh.villageIsShared && sh.overlayIsShared && sh.glowHanji === 0.30;
    if (!ok) fails.push(`shared: village=${sh.villageIsShared} overlay=${sh.overlayIsShared} hanji=${sh.glowHanji}`);
    console.log(`village flora-lantern === overlay bulb === getLanternMaterials().glow: ${sh.villageIsShared && sh.overlayIsShared} · hanjiGlow ${sh.glowHanji} ${ok?'':'✗'}`);
  }
}

console.log('\n=== ⑥ pageerror/예외 ===');
console.log(pageErrors.length ? pageErrors.join('\n') : '없음');
if (pageErrors.length) fails.push(`pageerror ${pageErrors.length}건`);

console.log('\n=== 결과 ===');
if (fails.length === 0) { console.log('PASS — 모든 단언 통과'); process.exit(0); }
else { console.log('FAIL (' + fails.length + ')'); for (const f of fails) console.log('  ✗ ' + f); process.exit(1); }
