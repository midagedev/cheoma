// 산 숲·화강암 노두 검증(#113) — 코드·수치 단언만(스크린샷·PNG Read 없음). 전용 포트 4229, src/ 직접 서빙.
//   사용: NODE_PATH=/Users/hckim/repo/threesur/node_modules node tools/verify-forest.mjs
// 검증 항목:
//   ① 쉘 커버리지: hill 밴드 표본 쉘 존재 비율 > 0.85, 마을 bowl 안 0
//   ② 부유·관통: 쉘-지형 간격 ∈ [1, 수관높이], 바위 sink(매립) 정상
//   ③ 능선 위 바위·프린지 카운트
//   ④ 경사 암석 블렌드: 급경사 정점색=화강암(회백), 완경사=녹지 (수치 델타)
//   ⑤ 드로우콜 표(규모별 + forest 델타 ≤ 4)
//   ⑥ 정점/면 수 보고(규모별)
//   ⑦ setSeason 4계절 쉘 색 변화
//   ⑧ determinism(같은 seed → 같은 forest) ALL PASS
//   ⑨ pageerror 0(계절·헤이즈 프레임)
//   ⑩ ink 모드 부팅 무에러
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const PORT = 4229;

const HTML = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>html,body{margin:0;height:100%}</style>
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.185.1/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.185.1/examples/jsm/"}}</script>
</head><body><div id="app"></div>
<script type="module">
import * as THREE from 'three';
import { planVillage } from '/src/village/plan.js';
import { populateVillage } from '/src/village/populate.js';
import { setupInk } from '/src/render/ink.js';

// 결정론: 하네스 Math.random 오버라이드(village 알고리즘 규약).
function seedRandom(){ let s = 0x2545f491 >>> 0; Math.random = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setSize(256, 256);
document.getElementById('app').appendChild(renderer.domElement);

const scale2R = { hamlet: 74, village: 128, town: 176, capital: 250, hanyang: 500 };
function build(scale){
  seedRandom();
  const includePalace = scale === 'capital' || scale === 'hanyang';
  const plan = planVillage({ scale, seed: 20260716, includePalace, includeTemple: true });
  const group = populateVillage(plan);
  group.updateMatrixWorld(true);
  return { plan, group };
}
const CANOPY_MAX = 8.9;   // forest.js 상한과 동일(#113 R4 범프 상향)

// 렌더 가능한 드로우콜 근사(visible mesh/instancedmesh, 단일 재질 가정 — 병합·인스턴싱 규약과 정합).
function countDrawCalls(group){
  let n = 0;
  group.traverse((o)=>{ if (o.visible && (o.isMesh || o.isInstancedMesh) && o.material) n++; });
  return n;
}
function slopeAt(site, x, z){ const d=2; const hx=(site.heightAt(x+d,z)-site.heightAt(x-d,z))/(2*d); const hz=(site.heightAt(x,z+d)-site.heightAt(x,z-d))/(2*d); return Math.hypot(hx,hz); }

// ① 커버리지 + ② 간격
function coverageAndGap(plan, group){
  const site = plan.site, C = site.center, bowlR = site.bowlR, ridgeR = site.ridgeR;
  const shell = group.getObjectByName('forest-shell');
  const terrain = group.getObjectByName('village-terrain');
  if (!shell || !terrain) return { hasShell: !!shell, hasTerrain: !!terrain };
  const rc = new THREE.Raycaster(); const down = new THREE.Vector3(0,-1,0);
  // hill 밴드 표본: bowl 밖 명확한 산(hillAt>0.25, rC>bowlR*1.15) 링·각도 격자.
  let bandN=0, bandHit=0;
  const radii = [1.18, 1.35, 1.55, 1.8, 2.0].map(k=>bowlR*k).filter(r=>r<ridgeR*1.02);
  for (const r of radii){
    for (let a=0; a<48; a++){
      const th = a/48*Math.PI*2;
      const x = C.x + Math.cos(th)*r, z = C.z + Math.sin(th)*r;
      if (site.hillAt(x,z) < 0.25) continue;
      bandN++;
      rc.set(new THREE.Vector3(x, site.Hmax*3+400, z), down);
      const hs = rc.intersectObject(shell, false);
      if (hs.length) bandHit++;
    }
  }
  // bowl 안(마을터): 쉘 없어야 함.
  let bowlN=0, bowlHit=0;
  for (let a=0; a<40; a++){ for (const r of [0.25, 0.5, 0.68]){
    const th = a/40*Math.PI*2; const x = C.x+Math.cos(th)*bowlR*r, z = C.z+Math.sin(th)*bowlR*r;
    bowlN++;
    rc.set(new THREE.Vector3(x, site.Hmax*3+400, z), down);
    if (rc.intersectObject(shell, false).length) bowlHit++;
  }}
  // ② 간격: 쉘 정점 표본 → 아래로 지형 레이캐스트, gap=shellY-terrainY ∈ [1, CANOPY_MAX].
  const pos = shell.geometry.getAttribute('position');
  const nv = pos.count;
  const step = Math.max(1, Math.floor(nv/450));
  let gapN=0, gapOk=0, gapMin=1e9, gapMax=-1e9, ridgeFringe=0;
  const wp = new THREE.Vector3();
  for (let i=0;i<nv;i+=step){
    wp.set(pos.getX(i), pos.getY(i), pos.getZ(i)); shell.localToWorld(wp);
    rc.set(new THREE.Vector3(wp.x, site.Hmax*3+400, wp.z), down);
    const ht = rc.intersectObject(terrain, false);
    if (!ht.length) continue;
    const gap = wp.y - ht[0].point.y;
    gapN++;
    if (gap>=1 && gap<=CANOPY_MAX+0.15) gapOk++;
    if (gap<gapMin) gapMin=gap; if (gap>gapMax) gapMax=gap;
    if (site.hillAt(wp.x, wp.z) > 0.65) ridgeFringe++;   // ③ 능선 프린지(쉘이 능선까지 도달)
  }
  return {
    hasShell:true, hasTerrain:true,
    bandCoverage: bandN? +(bandHit/bandN).toFixed(3):0, bandN,
    bowlHitRatio: bowlN? +(bowlHit/bowlN).toFixed(3):0, bowlN,
    gapOkRatio: gapN? +(gapOk/gapN).toFixed(3):0, gapN, gapMin:+gapMin.toFixed(2), gapMax:+gapMax.toFixed(2),
    ridgeFringeVerts: ridgeFringe,
  };
}

// ② 바위 sink + ③ 능선 바위
function rockCheck(plan, group){
  const site = plan.site;
  const fr = group.userData.forest;
  const anchors = (fr && fr.rockAnchors) || [];
  let buriedOk=0, sinkOk=0;
  for (const a of anchors){
    const surf = site.heightAt(a.x, a.z);
    if (surf - a.y > 0.25) buriedOk++;    // 바위 밑면이 지형 아래로 잠김
    if (a.sink > 0.2) sinkOk++;
  }
  return {
    rockCount: anchors.length,
    ridgeRockCount: fr ? fr.ridgeRockCount : 0,
    buriedRatio: anchors.length? +(buriedOk/anchors.length).toFixed(3):0,
    sinkRatio: anchors.length? +(sinkOk/anchors.length).toFixed(3):0,
  };
}

// ④ 지형 화강암 경사 블렌드
function graniteBlend(plan, group){
  const site = plan.site;
  const terrain = group.getObjectByName('village-terrain');
  const pos = terrain.geometry.getAttribute('position');
  const col = terrain.geometry.getAttribute('color');
  const nv = pos.count; const step = Math.max(1, Math.floor(nv/6000));
  let steep=[0,0,0], nSteep=0, gentle=[0,0,0], nGentle=0;
  for (let i=0;i<nv;i+=step){
    const x=pos.getX(i), z=pos.getZ(i);
    const hill=site.hillAt(x,z), slope=slopeAt(site,x,z);
    if (hill>0.42 && slope>0.85){ steep[0]+=col.getX(i); steep[1]+=col.getY(i); steep[2]+=col.getZ(i); nSteep++; }
    else if (hill>0.12 && hill<0.4 && slope<0.4){ gentle[0]+=col.getX(i); gentle[1]+=col.getY(i); gentle[2]+=col.getZ(i); nGentle++; }
  }
  const avg=(a,n)=> n? [ +(a[0]/n).toFixed(3), +(a[1]/n).toFixed(3), +(a[2]/n).toFixed(3) ] : null;
  const s=avg(steep,nSteep), g=avg(gentle,nGentle);
  // 급경사=화강암 쪽으로 중성화(녹기 감소), 완경사=녹(G가 R·B보다 뚜렷). 상대 비교로 견고 단언:
  //   완경사의 녹 우세(G-B)가 크고, 급경사는 그 녹 우세가 절반 이하로 눌림(회백 블렌드).
  let steepGrey=null, gentleGreen=null;
  const greenBias = (c) => c[1] - (c[0] + c[2]) / 2;   // 녹 우세도
  if (g){ gentleGreen = (g[1] > g[0] + 0.008 && g[1] > g[2] + 0.03); }
  if (s && g){ steepGrey = greenBias(s) < greenBias(g) * 0.55; }   // 급경사는 녹 우세가 크게 눌림 = 화강암화
  return { steepAvg:s, nSteep, gentleAvg:g, nGentle, steepGrey, gentleGreen, steepGreenBias: s?+greenBias(s).toFixed(3):null, gentleGreenBias: g?+greenBias(g).toFixed(3):null };
}

// ⑦ 계절 — 계절색은 정점색 4버퍼(모자이크)라 material.color 아닌 geo 'color' 평균으로 판정.
function seasonCheck(root){
  const shell = root.getObjectByName('forest-shell');
  if (!shell) return { hasShell:false };
  const col = shell.geometry.getAttribute('color');
  const avg = () => { let r=0,g=0,b=0; const n=col.count; const step=Math.max(1,Math.floor(n/4000)); let m=0;
    for (let i=0;i<n;i+=step){ r+=col.getX(i); g+=col.getY(i); b+=col.getZ(i); m++; } return [r/m,g/m,b/m]; };
  const out={};
  for (const s of ['spring','summer','autumn','winter']){
    root.userData.setSeason(s);
    const a = avg();
    out[s] = a.map(v=>+v.toFixed(3));
    renderer.render(sceneWrap(root), cam());   // 프레임 렌더로 셰이더 컴파일·에러 트리거
  }
  // 구분: 4계절 평균색이 유의미하게 다른지(합 거리) + 가을은 붉게(R>G), 여름은 녹(G>R).
  const keys=['spring','summer','autumn','winter'];
  let distinct=0;
  for (let i=0;i<keys.length;i++) for (let j=i+1;j<keys.length;j++){
    const a=out[keys[i]], b=out[keys[j]];
    if (Math.abs(a[0]-b[0])+Math.abs(a[1]-b[1])+Math.abs(a[2]-b[2]) > 0.04) distinct++;
  }
  const autumnRed = out.autumn[0] > out.autumn[1];      // 가을 R>G(붉음)
  const summerGreen = out.summer[1] > out.summer[0];    // 여름 G>R(녹)
  return { hasShell:true, colors: out, distinctPairs: distinct, allPairs: 6, autumnRed, summerGreen };
}
let _scene, _cam;
function sceneWrap(root){ if(!_scene){ _scene=new THREE.Scene(); _scene.add(new THREE.HemisphereLight(0xbcd0e0,0x9a8c72,1.2)); const d=new THREE.DirectionalLight(0xffffff,2); d.position.set(1,2,1); _scene.add(d);} while(_scene.children.length>2) _scene.remove(_scene.children[2]); _scene.add(root); return _scene; }
function cam(){ if(!_cam){ _cam=new THREE.PerspectiveCamera(50,1,1,5000); _cam.position.set(0,300,600); _cam.lookAt(0,0,0);} return _cam; }

// forest 결정론 해시
function forestHash(fr){
  const parts=[fr.shellVertexCount, fr.shellFaceCount, fr.rockCount, fr.ridgeRockCount];
  const a=(fr.rockAnchors||[]).slice(0,40);
  for (const r of a) parts.push(r.x.toFixed(2), r.z.toFixed(2), r.h.toFixed(2));
  return parts.join('|');
}

async function run(){
  const R = { metrics:{}, coverage:{}, granite:{}, rocks:{}, determinism:{}, season:null, ink:null };
  // 메트릭 + 드로우콜 + 정점(규모별)
  for (const scale of ['village','town','capital','hanyang']){
    const { plan, group } = build(scale);
    const fr = group.userData.forest;
    const total = countDrawCalls(group);
    R.metrics[scale] = {
      totalDrawCalls: total, forestDrawCalls: fr.drawCalls, before: total - fr.drawCalls,
      shellVerts: fr.shellVertexCount, shellFaces: fr.shellFaceCount, rockCount: fr.rockCount,
    };
    if (scale==='village' || scale==='town'){
      R.coverage[scale] = coverageAndGap(plan, group);
      R.granite[scale] = graniteBlend(plan, group);
      R.rocks[scale] = rockCheck(plan, group);
    }
  }
  // 계절(village)
  { const { group } = build('village'); R.season = seasonCheck(group); }
  // 결정론(3규모, forest 해시 2회 비교)
  for (const scale of ['village','capital','hanyang']){
    const a = build(scale).group.userData.forest;
    const b = build(scale).group.userData.forest;
    R.determinism[scale] = { equal: forestHash(a) === forestHash(b) };
  }
  // ink 부팅
  try {
    const { group } = build('village');
    const scene = sceneWrap(group); const camera = cam();
    const ink = setupInk(renderer, scene, camera);
    ink.composer.render();
    ink.dispose();
    R.ink = { ok:true };
  } catch(e){ R.ink = { ok:false, err: String(e && e.message || e) }; }
  return R;
}
window.__run = run;
window.__READY = true;
</script></body></html>`;

const server = createServer(async (req, res) => {
  const path = req.url.split('?')[0];
  if (path === '/__forest') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(HTML); return; }
  try {
    const data = await readFile(join(ROOT, path === '/' ? 'index.html' : path));
    res.writeHead(200, { 'content-type': MIME[extname(path)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise((ok) => server.listen(PORT, '127.0.0.1', ok));
let browser;
try { browser = await chromium.launch({ channel: 'chrome' }); } catch { browser = await chromium.launch(); }
const page = await browser.newPage();
let pageErr = 0; const errs = [];
page.on('pageerror', (e) => { pageErr++; errs.push(e.message); });
page.on('console', (m) => { if (m.type() === 'error') errs.push('[console] ' + m.text()); });
await page.goto(`http://127.0.0.1:${PORT}/__forest`, { waitUntil: 'load' });
await page.waitForFunction('window.__READY === true', { timeout: 20000 });
const R = await page.evaluate('window.__run()');
R.pageErrors = pageErr; R.errSample = errs.slice(0, 8);
await browser.close(); server.close();

// ───────── 판정 ─────────
const F = [];
const pass = (name, cond, detail='') => F.push({ name, ok: !!cond, detail });
for (const sc of ['village','town']){
  const c = R.coverage[sc]; if (!c) continue;
  pass(`[${sc}] 쉘 커버리지>0.85`, c.bandCoverage > 0.85, `cov=${c.bandCoverage} (n=${c.bandN})`);
  pass(`[${sc}] bowl 안 쉘=0`, c.bowlHitRatio === 0, `bowlHit=${c.bowlHitRatio}`);
  pass(`[${sc}] 쉘 간격 ∈[1,${CANOPY_MAX2()}]`, c.gapOkRatio > 0.98, `ok=${c.gapOkRatio} min=${c.gapMin} max=${c.gapMax}`);
  pass(`[${sc}] 능선 프린지 존재`, c.ridgeFringeVerts > 0, `verts=${c.ridgeFringeVerts}`);
  const rk = R.rocks[sc];
  pass(`[${sc}] 바위 sink 정상`, rk.buriedRatio > 0.9 && rk.sinkRatio > 0.9, `buried=${rk.buriedRatio} sink=${rk.sinkRatio} n=${rk.rockCount}`);
  pass(`[${sc}] 능선 위 바위 존재`, rk.ridgeRockCount > 0, `ridgeRocks=${rk.ridgeRockCount}`);
  const g = R.granite[sc];
  pass(`[${sc}] 급경사=화강암 회백`, g.steepGrey === true, `steepAvg=${JSON.stringify(g.steepAvg)} (n=${g.nSteep})`);
  pass(`[${sc}] 완경사=녹지 톤`, g.gentleGreen === true, `gentleAvg=${JSON.stringify(g.gentleAvg)} (n=${g.nGentle})`);
}
function CANOPY_MAX2(){ return 8.9; }
for (const sc of ['village','town','capital','hanyang']){
  const m = R.metrics[sc];
  pass(`[${sc}] forest 드로우콜 델타 ≤4`, m.forestDrawCalls <= 4, `+${m.forestDrawCalls} (total ${m.before}→${m.totalDrawCalls})`);
}
pass('[village] 총 드로우콜 <1000', R.metrics.village.totalDrawCalls < 1000, `total=${R.metrics.village.totalDrawCalls}`);
pass('[town] 총 드로우콜 <1000', R.metrics.town.totalDrawCalls < 1000, `total=${R.metrics.town.totalDrawCalls}`);
pass('계절 4색 구분(정점색)', R.season && R.season.distinctPairs === 6, `distinctPairs=${R.season && R.season.distinctPairs}/6`);
pass('가을 붉음(R>G) & 여름 녹(G>R)', R.season && R.season.autumnRed && R.season.summerGreen, `autumnRed=${R.season && R.season.autumnRed} summerGreen=${R.season && R.season.summerGreen}`);
for (const sc of Object.keys(R.determinism)) pass(`[${sc}] determinism`, R.determinism[sc].equal, '');
pass('ink 부팅 무에러', R.ink && R.ink.ok, R.ink && R.ink.err || '');
pass('pageerror 0', R.pageErrors === 0, `errs=${R.pageErrors}`);

console.log('\\n===== #113 FOREST VERIFY =====\\n');
console.log('드로우콜/정점 표:');
for (const sc of ['village','town','capital','hanyang']){
  const m = R.metrics[sc];
  console.log(`  ${sc.padEnd(8)} draw ${String(m.before).padStart(4)}→${String(m.totalDrawCalls).padStart(4)} (forest +${m.forestDrawCalls})  shell verts=${m.shellVerts} faces=${m.shellFaces}  rocks=${m.rockCount}`);
}
console.log('\\n커버리지/간격:');
for (const sc of ['village','town']){ const c=R.coverage[sc]; if(c) console.log(`  ${sc}: cov=${c.bandCoverage} bowlHit=${c.bowlHitRatio} gapOk=${c.gapOkRatio} gap[${c.gapMin},${c.gapMax}] ridgeFringe=${c.ridgeFringeVerts}`); }
console.log('\\n화강암 블렌드:');
for (const sc of ['village','town']){ const g=R.granite[sc]; if(g) console.log(`  ${sc}: steep=${JSON.stringify(g.steepAvg)} grey=${g.steepGrey} | gentle=${JSON.stringify(g.gentleAvg)} green=${g.gentleGreen}`); }
console.log('\\n계절:', JSON.stringify(R.season && R.season.colors));
console.log('\\n판정:');
let fail=0;
for (const f of F){ console.log(`  ${f.ok?'PASS':'FAIL'}  ${f.name}  ${f.detail}`); if(!f.ok) fail++; }
console.log(`\\n${fail===0?'ALL PASS':fail+' FAIL'}  (${F.length} checks, pageErrors=${R.pageErrors})`);
if (R.errSample.length) console.log('err sample:', R.errSample);
process.exit(fail===0 && R.pageErrors===0 ? 0 : 1);
