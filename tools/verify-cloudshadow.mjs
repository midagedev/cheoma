// 헤드리스 수치 검증(태스크 #108): 흐르는 구름 그림자가 마을 부감 프레임(원점 디스크)에 실제로
//   드리우는지 + 달밤 달빛 구름 그림자 발현을 "수치"로 단언한다(스크린샷 없음).
//
// 방법: esbuild 로 src/env/clouds.js + src/village/site.js + src/env/sky.js(TIME_PRESETS) 를 묶은
//   프로브 번들을 만들어 포트 4222 로 서빙 → playwright(캡처 없이) 로드 → setupClouds 를 실제 마을
//   설정(mistBillboards=false·highCloudCount=4·terrainMax=site.terrainR)으로 구동하고 update 루프를
//   돌린다. 매 프레임 uCloudBlobs·uCloudStr 을 읽어, 지형 재질이 쓰는 것과 동일한 GLSL 그림자 공식을
//   JS 로 미러링해 프레임 내 표본점(마을 중심 + 사방 4점)의 그림자 감쇠(1 - uCloudStr·shade)를 계측.
//
// 판정:
//   ① 커버리지·표류: 60초 시계열에서 표본점 감쇠가 오르내려야(변동폭 > 임계) — 블롭이 마을 위를
//      유유히 지나간다는 증명. 프레임 밖 고정이면 변동 0 → FAIL.
//   ② 시간대 강도표: day/sunset 강(가독) · dawn 약 · night 는 0 이 아니라 달빛 저감 발현.
//   ③ 단일건물 env 경로(mistBillboards=true) 무회귀: 강도 곡선이 기존식과 동일(0.52·smoothstep).
//   ④ pageerror 0.
//
// 사용: node tools/verify-cloudshadow.mjs
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const esbuild = require(resolve(ROOT, 'app/node_modules/esbuild'));

// ── 프로브 엔트리(브라우저에서 실행). window.__ct 에 고수준 API 노출. ──
const ENTRY = `
import * as THREE from 'three';
import { setupClouds, createCloudUniforms, MAX_CLOUD_BLOBS } from '${resolve(ROOT, 'src/env/clouds.js')}';
import { makeSite } from '${resolve(ROOT, 'src/village/site.js')}';
import { TIME_PRESETS } from '${resolve(ROOT, 'src/env/sky.js')}';

// ── 지형 재질 그림자 GLSL(cloudBlob/csFbm)의 JS 미러 — 재질이 쓰는 것과 동일 공식 ──
const clampf = (x,a,b)=>Math.min(b,Math.max(a,x));
const smoothstep = (a,b,x)=>{ const t=clampf((x-a)/(b-a),0,1); return t*t*(3-2*t); };
const frac = (x)=>x-Math.floor(x);
function csHash(px,py){
  let x=frac(px*123.34), y=frac(py*345.45);
  const d = x*(x+34.345)+y*(y+34.345);
  x+=d; y+=d; return frac(x*y);
}
function csNoise(px,py){
  const ix=Math.floor(px), iy=Math.floor(py), fx=px-ix, fy=py-iy;
  const ux=fx*fx*(3-2*fx), uy=fy*fy*(3-2*fy);
  const a=csHash(ix,iy), b=csHash(ix+1,iy), c=csHash(ix,iy+1), d=csHash(ix+1,iy+1);
  return (a+(b-a)*ux) + ((c+(d-c)*ux)-(a+(b-a)*ux))*uy;
}
function csFbm(px,py){ let v=0,amp=0.55; for(let i=0;i<4;i++){ v+=amp*csNoise(px,py); px=px*2.03+7.1; py=py*2.03+7.1; amp*=0.5; } return v; }
function shadeAt(wx,wz,blobs,tt){
  const wob=(csFbm(wx*0.011+tt*0.004, wz*0.011+tt*0.004)-0.5)*0.42;
  let shade=0;
  for(const b of blobs){
    if(b.z<0.5) continue;
    const t=Math.hypot(wx-b.x, wz-b.y)/b.z + wob;
    shade += b.w*(1-smoothstep(0.42,1.02,t));
  }
  return clampf(shade,0,1);
}

let inst=null, sun=null, group=null, samplePts=[];
function makeSun(){ return { position:new THREE.Vector3(0,64,0), color:new THREE.Color(0xffffff), intensity:2.6, isDirectionalLight:true }; }
function setTime(name){
  const P=TIME_PRESETS[name];
  sun.position.set(P.sunDir[0],P.sunDir[1],P.sunDir[2]).multiplyScalar(64);
  sun.color.set(P.sunColor); sun.intensity=P.sunInt;
}

window.__ct = {
  build({ scale='village', seed=20260716, village=true, coverR=null }={}){
    const site = makeSite({ scale, seed });
    group = new THREE.Group();
    sun = makeSun();
    const u = createCloudUniforms();
    inst = setupClouds(group, {
      sun, edge: site.edge, terrainMax: site.terrainR, uniforms: u,
      mistBillboards: !village, highCloudCount: 4,
      ...(coverR!=null ? { coverR } : {}),
    });
    const cover = coverR!=null ? coverR : site.terrainR*0.42;
    // 표본점: 마을 프레임 중심(원점) + 사방 4점(프레임 안, cover 의 55%)
    samplePts = [
      { name:'center', x:0, z:0 },
      { name:'N', x:0, z:-cover*0.55 },
      { name:'S', x:0, z: cover*0.55 },
      { name:'E', x: cover*0.55, z:0 },
      { name:'W', x:-cover*0.55, z:0 },
    ];
    return { center: site.center, bowlR: site.bowlR, terrainR: site.terrainR, R: site.R, cover, nBlobs: inst.uniforms.uCloudBlobs.value.filter(b=>b.z>=0.5).length };
  },
  setTime,
  step(dt, n){ for(let i=0;i<n;i++) inst.update(dt); },
  reset(){ /* setupClouds t 는 인스턴스 내부 — build 로 새로 만든다 */ },
  strength(){ return inst.uniforms.uCloudStr.value; },
  blobs(){ return inst.uniforms.uCloudBlobs.value.map(b=>({x:b.x,y:b.y,z:b.z,w:b.w})); },
  time(){ return inst.uniforms.uCloudTime.value; },
  // 프레임 내 표본점 감쇠 = 1 - uCloudStr·shade (지형 재질이 diffuse 에 곱하는 값)
  atten(){
    const blobs=inst.uniforms.uCloudBlobs.value, str=inst.uniforms.uCloudStr.value, tt=inst.uniforms.uCloudTime.value;
    return samplePts.map(p=>({ name:p.name, atten: 1 - str*shadeAt(p.x,p.z,blobs,tt) }));
  },
  MAX_CLOUD_BLOBS,
};
window.__ct_ready = true;
`;

const built = await esbuild.build({
  stdin: { contents: ENTRY, resolveDir: ROOT, loader: 'js', sourcefile: 'probe.js' },
  bundle: true, format: 'esm', write: false,
  nodePaths: [resolve(ROOT, 'app/node_modules')],
  logLevel: 'silent',
});
const bundle = built.outputFiles[0].text;

const HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>
<script type="module">${bundle}</script></body></html>`;

const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(HTML);
});
await new Promise((ok) => server.listen(4222, '127.0.0.1', ok));

const browser = await (async () => { try { return await chromium.launch({ channel: 'chrome' }); } catch { return await chromium.launch(); } })();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console:' + m.text()); });

await page.goto('http://127.0.0.1:4222/', { waitUntil: 'load' });
await page.waitForFunction('window.__ct_ready === true', null, { timeout: 30000 });

const stats = (arr) => {
  const n = arr.length, mean = arr.reduce((a, b) => a + b, 0) / n;
  const min = Math.min(...arr), max = Math.max(...arr);
  const sd = Math.sqrt(arr.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  return { mean, min, max, range: max - min, sd };
};
const f = (x) => x.toFixed(4);

console.log('================ #108 구름 그림자 수치 검증 ================\n');

// ── ① 커버리지·표류 시계열(마을, sunset — 앱 기본 뷰) ──
const meta = await page.evaluate(() => window.__ct.build({ scale: 'village', village: true }));
console.log(`[마을 기하] R=${meta.R} terrainR=${f(meta.terrainR)} bowlR=${f(meta.bowlR)} center=(${meta.center.x},${f(meta.center.z)}) cover=${f(meta.cover)} 활성블롭=${meta.nBlobs}`);

await page.evaluate(() => window.__ct.setTime('sunset'));
// 60초(60fps) 시계열 — 매 1초(60스텝)마다 표본점 감쇠 기록
const series = {};
for (const p of ['center', 'N', 'S', 'E', 'W']) series[p] = [];
for (let s = 0; s < 60; s++) {
  await page.evaluate(() => window.__ct.step(1 / 60, 60));
  const a = await page.evaluate(() => window.__ct.atten());
  for (const rec of a) series[rec.name].push(rec.atten);
}
console.log('\n[① sunset 60초 시계열 — 표본점 감쇠(1=그늘없음, <1=그늘)]');
let anyVar = false;
for (const p of ['center', 'N', 'S', 'E', 'W']) {
  const st = stats(series[p]);
  if (st.range > 0.03) anyVar = true;
  console.log(`   ${p.padEnd(6)} min=${f(st.min)} max=${f(st.max)} 변동폭=${f(st.range)} 평균=${f(st.mean)}`);
}
console.log(`   → 그늘 통과(변동폭>0.03) 관측: ${anyVar ? 'YES ✅' : 'NO ❌ (프레임 밖 고정 의심)'}`);

// ── ② 시간대별 강도표(마을) ──
console.log('\n[② 시간대별 uCloudStr(마을) — 낮 강·야간 달빛 저감]');
const strTable = {};
for (const t of ['day', 'sunset', 'dawn', 'night']) {
  await page.evaluate(() => window.__ct.build({ scale: 'village', village: true }));
  await page.evaluate((tt) => window.__ct.setTime(tt), t);
  await page.evaluate(() => window.__ct.step(1 / 60, 30));
  const str = await page.evaluate(() => window.__ct.strength());
  strTable[t] = str;
  console.log(`   ${t.padEnd(7)} uCloudStr=${f(str)}`);
}

// 최대 감쇠(블롭 중심 직하) 추정: str * 1.0(b.w≈1) → 지면 최저 밝기
console.log('\n[② 최대 국소 그늘 깊이 = uCloudStr·1.0 (블롭 중심)]');
for (const t of ['day', 'sunset', 'dawn', 'night']) console.log(`   ${t.padEnd(7)} 최저밝기≈${f(1 - strTable[t])}`);

// ── ③ 단일건물 env 경로 무회귀(mistBillboards=true) ──
console.log('\n[③ env 단일건물 경로 강도(기존식 0.52·smoothstep(1.2,2.45) 이어야)]');
const envSmooth = (inten) => { const t = Math.min(1, Math.max(0, (inten - 1.2) / (2.45 - 1.2))); return 0.52 * (t * t * (3 - 2 * t)); };
const envInten = { day: 2.6, sunset: 2.3, dawn: 1.7, night: 0.9 };
let envOk = true;
for (const t of ['day', 'sunset', 'dawn', 'night']) {
  await page.evaluate(() => window.__ct.build({ scale: 'village', village: false }));
  await page.evaluate((tt) => window.__ct.setTime(tt), t);
  await page.evaluate(() => window.__ct.step(1 / 60, 30));
  const str = await page.evaluate(() => window.__ct.strength());
  const expect = envSmooth(envInten[t]);
  const ok = Math.abs(str - expect) < 0.005;
  if (!ok) envOk = false;
  console.log(`   ${t.padEnd(7)} env=${f(str)} 기대=${f(expect)} ${ok ? '✅' : '❌'}`);
}
console.log(`   → env 무회귀: ${envOk ? 'PASS ✅' : 'FAIL ❌'}`);

// ── ④ 대규모(hanyang) 커버리지 확인 — 블롭이 프레임(원점 근처)에 남는지 ──
console.log('\n[④ 규모별 블롭 최대 반경(원점 기준) vs 프레임 반경(cover)]');
for (const scale of ['village', 'town', 'capital', 'hanyang']) {
  const m = await page.evaluate((sc) => window.__ct.build({ scale: sc, village: true }), scale);
  await page.evaluate(() => window.__ct.setTime('day'));
  await page.evaluate(() => window.__ct.step(1 / 60, 120));
  const blobs = await page.evaluate(() => window.__ct.blobs());
  const rads = blobs.filter((b) => b.z >= 0.5).map((b) => Math.hypot(b.x, b.y));
  const maxR = Math.max(...rads);
  console.log(`   ${scale.padEnd(8)} cover=${String(Math.round(m.cover)).padStart(4)} 블롭최대반경=${String(Math.round(maxR)).padStart(4)} ${maxR < m.cover * 1.4 ? '✅ 프레임내' : '⚠ 외곽'}`);
}

console.log(`\n[pageerror] ${errors.length === 0 ? '0 ✅' : errors.length + '건 ❌:\n  ' + errors.join('\n  ')}`);
console.log('\n===========================================================');

await browser.close();
server.close();
