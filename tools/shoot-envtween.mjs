// 헤드리스 검증: 환경 전환 크로스페이드(태스크 #50) — 팝 없이 단조 보간되는지.
// 사용법: node tools/shoot-envtween.mjs [transition]
//   transition = day-sunset | sunset-night | clear-rain | rain-snow | summer-autumn | all(기본)
//
// 전체 pbr 파이프라인(env + post + 안티솔라 필 + weather + night-glow)을 main.js 배선대로 조립하고,
// 결정론 sim 스텝(__advance)으로 전환을 밀며 t=0/25/50/75/100% 컷을 저장한다. 아울러 전환 구간을
// 20스텝으로 세분해 프레임간 화면 평균 luma 델타를 측정 — 스냅(팝)이면 한 스텝에 큰 스파이크가,
// 크로스페이드면 총변화가 여러 스텝에 고르게 퍼진다(peak/mean 비가 낮다).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'shots');
mkdirSync(OUT, { recursive: true });
const WHICH = process.argv[2] || 'all';

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json',
};

// pbr 파이프라인 하네스. 애니메이션 루프는 "현재 상태 렌더"만 하고, 시뮬레이션 전진은 __advance 가
// sim dt(0.05)로 직접 몰아 결정론을 확보(post.update 는 dt override 로 sim 시간을 소비).
const HTML = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>html,body{margin:0;height:100%;overflow:hidden;background:#cfd8e0}#app{width:100%;height:100%}</style>
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.185.1/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.185.1/examples/jsm/"}}</script>
</head><body><div id="app"></div>
<script type="module">
import * as THREE from 'three';
import { PRESETS, computeLayout } from '/src/params.js';
import { buildBuilding } from '/src/builder/index.js';
import { setupEnvironment } from '/src/env/index.js';
import { setupWeather } from '/src/env/weather.js';
import { setupNightGlow } from '/src/env/night-glow.js';
import { setupPost } from '/src/env/post.js';
const q = new URLSearchParams(location.search);
const timeOfDay = q.get('time') || 'sunset';
const season = ['spring','summer','autumn'].includes(q.get('season'))?q.get('season'):'summer';
const weatherName = ['clear','rain','snow'].includes(q.get('weather'))?q.get('weather'):'clear';

const renderer = new THREE.WebGLRenderer({ antialias:true, preserveDrawingBuffer:true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio,2));
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
document.getElementById('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xcfd8e0);
scene.fog = new THREE.Fog(0xcfd8e0, 60, 220);
const sun = new THREE.DirectionalLight(0xfff0dd, 2.6);
sun.position.set(30,42,26); sun.castShadow = true;
sun.shadow.mapSize.set(2048,2048);
sun.shadow.camera.left=-22; sun.shadow.camera.right=22; sun.shadow.camera.top=22; sun.shadow.camera.bottom=-22;
sun.shadow.bias=-0.0001; sun.shadow.normalBias=0.05; scene.add(sun);
const hemi = new THREE.HemisphereLight(0xbdd0e4, 0x8a7a63, 0.9); scene.add(hemi);
const fill = new THREE.DirectionalLight(0xff9a5c, 0); fill.castShadow=false; scene.add(fill); scene.add(fill.target);
const ground = new THREE.Mesh(new THREE.CircleGeometry(160,48), new THREE.MeshStandardMaterial({color:0xb5a893, roughness:1}));
ground.rotation.x=-Math.PI/2; ground.receiveShadow=true; scene.add(ground);

const P = {...PRESETS.korea};
const building = buildBuilding(P); scene.add(building);
const layout = computeLayout(P);

const env = setupEnvironment(scene, { sun, hemi, renderer, layout });
const envState = { enabled:true, time:timeOfDay };
env.setTime(timeOfDay); env.setSeason(season, { immediate:true }); env.setEnabled(true);
ground.visible = false;

const weather = setupWeather(scene, { layout, getBuilding:()=>building, getGround:()=>ground });
env.addFogModifier((scn)=>weather.applyAtmosphereScaled(scn));
weather.setWeather(weatherName);

const nightGlow = setupNightGlow({ getBuilding:()=>building });
nightGlow.setEnabled(true); nightGlow.setTime(timeOfDay);

const camera = new THREE.PerspectiveCamera(28, innerWidth/innerHeight, 0.1, 500);
const maxDim = Math.max(layout.W+4, layout.D+4, layout.totalH);
const target = new THREE.Vector3(0, layout.totalH*0.42, 0);
{ const az=38*Math.PI/180, el=13*Math.PI/180, r=3.0*maxDim;
  camera.position.set(target.x+r*Math.cos(el)*Math.sin(az), target.y+r*Math.sin(el), target.z+r*Math.cos(el)*Math.cos(az)); }
camera.lookAt(target);

const post = setupPost({ renderer, scene, camera });
post.setSize(innerWidth, innerHeight);
post.setTime(timeOfDay);
post.setEnabled(true);

// 안티솔라 웜 필(main.js FILL_BY_TIME · stepFill 배선 복제).
const FILL_BY_TIME = {
  dawn:{int:0.35,color:0xffc49e}, day:{int:0.0,color:0xffffff},
  sunset:{int:0.95,color:0xf2b28c}, night:{int:0.0,color:0x000000},
};
const _fillDir = new THREE.Vector3();
let _fillTargetInt = 0; const _fillTargetCol = new THREE.Color(0xffffff); let _fillStarted = false;
function applyFill(){
  const cfg = FILL_BY_TIME[envState.time] || FILL_BY_TIME.day;
  const on = envState.enabled && cfg.int>0;
  _fillTargetInt = on?cfg.int:0; _fillTargetCol.setHex(on?cfg.color:0xffffff);
  if(!_fillStarted){ fill.intensity=_fillTargetInt; fill.color.copy(_fillTargetCol); }
}
function stepFill(dt){
  _fillStarted=true; const k=Math.min(1,dt*3.0);
  fill.intensity += (_fillTargetInt-fill.intensity)*k; fill.color.lerp(_fillTargetCol,k);
  const s=sun.position; const hmag=Math.hypot(s.x,s.z)||1;
  _fillDir.set(-s.x, hmag*0.27, -s.z).normalize().multiplyScalar(80);
  fill.position.copy(_fillDir); fill.target.position.set(0,0,0); fill.target.updateMatrixWorld();
}
applyFill();

// 초기 세팅: 실제 앱은 매 프레임 env.update 가 돌아 구름·엣지 헤이즈·fog 가 정착돼 있다. 하네스는
// 캡처 전 이를 안 돌리면 첫 프레임이 미정착(과헤이즈)이라 전환 첫 스텝에 헛 스파이크가 생긴다.
// → 정착 루프로 실제 앱 정상상태와 맞춘다(트윈 없음 → 상태 불변, 헤이즈만 정착).
for (let i=0;i<16;i++){ env.update(0.05); nightGlow.update(0.05); weather.update(0.05); stepFill(0.05); post.update(0.05); }

// 컨트롤 훅 — main.js GUI onChange 경로와 동형(env.setTime + nightGlow.setTime + post.setTime + applyFill).
window.__setTime = (name)=>{ envState.time=name; env.setTime(name); nightGlow.setTime(name); post.setTime(name); applyFill(); };
window.__setSeason = (name)=>{ env.setSeason(name); };
window.__setWeather = (name)=>{ weather.setWeather(name); };
// 결정론 sim 전진: env/night-glow/weather/fill/post 를 sim dt 로 밀고 렌더는 rAF 가 담당.
window.__advance = (secs)=>{
  const n = Math.max(1, Math.round(secs/0.05));
  for(let i=0;i<n;i++){ env.update(0.05); nightGlow.update(0.05); weather.update(0.05); stepFill(0.05); post.update(0.05); }
};
// 현재 화면 평균 luma(0..255) — 팝 감지용(프레임간 델타). 저해상 다운샘플 평균.
window.__luma = ()=>{
  const w=160,h=100; const c=document.createElement('canvas'); c.width=w; c.height=h;
  const ctx=c.getContext('2d'); ctx.drawImage(renderer.domElement,0,0,w,h);
  const d=ctx.getImageData(0,0,w,h).data; let s=0;
  for(let i=0;i<d.length;i+=4) s += 0.2126*d[i]+0.7152*d[i+1]+0.0722*d[i+2];
  return s/(w*h);
};
window.__fog = ()=>({ near:+scene.fog.near.toFixed(1), far:+scene.fog.far.toFixed(1), color:'#'+scene.fog.color.getHexString() });
post.update(0);
let frames=0;
renderer.setAnimationLoop(()=>{ post.composer.render(); frames++; if(frames===3) window.__SHOT_READY=true; });
</script></body></html>`;

const server = createServer(async (req, res) => {
  const path = req.url.split('?')[0];
  if (path === '/__envtween') { res.writeHead(200, { 'content-type':'text/html' }); res.end(HTML); return; }
  try {
    const file = join(ROOT, path === '/' ? 'index.html' : path);
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

let browser;
try { browser = await chromium.launch({ channel:'chrome' }); }
catch { browser = await chromium.launch(); }
const page = await browser.newPage({ viewport:{ width:1280, height:800, deviceScaleFactor:2 } });
page.on('pageerror', (err)=>console.error('[pageerror]', err.message));
page.on('console', (m)=>{ if(m.type()==='error') console.error('[page]', m.text()); });

async function open(url){ await page.goto(url, { waitUntil:'load' }); await page.waitForFunction('window.__SHOT_READY===true', null, { timeout:30000 }); }
async function raf(){ await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))); }
async function shot(name){ const f=join(OUT, `envtween-${name}.png`); await page.screenshot({ path:f }); console.log('saved', f); }

// 한 전환 검증: initial 상태 로드 → apply(kind,target) → 20스텝(총 DUR)으로 밀며 luma 수집,
// t=0/25/50/75/100% 컷 저장. kind: time|season|weather.
async function runTransition(label, initialQS, kind, target, dur){
  await open(`${base}/__envtween?${initialQS}`);
  await raf();
  const STEPS = 20; const step = dur/STEPS;
  // 트리거
  await page.evaluate(([k,t])=>{ if(k==='time') window.__setTime(t); else if(k==='season') window.__setSeason(t); else window.__setWeather(t); }, [kind, target]);
  const lumas = [];
  lumas.push(await page.evaluate(()=>window.__luma()));   // t=0(전환 직전 프레임)
  const cutAt = new Set([0, Math.round(STEPS*0.25), Math.round(STEPS*0.5), Math.round(STEPS*0.75), STEPS]);
  if (cutAt.has(0)) await shot(`${label}-t000`);
  for (let i=1;i<=STEPS;i++){
    await page.evaluate((s)=>window.__advance(s), step);
    await raf();
    lumas.push(await page.evaluate(()=>window.__luma()));
    if (cutAt.has(i)) {
      const pct = String(Math.round(i/STEPS*100)).padStart(3,'0');
      await shot(`${label}-t${pct}`);
    }
  }
  // 프레임간 델타 통계
  const deltas = [];
  for (let i=1;i<lumas.length;i++) deltas.push(Math.abs(lumas[i]-lumas[i-1]));
  const total = Math.abs(lumas[lumas.length-1]-lumas[0]);
  const peak = Math.max(...deltas);
  const mean = deltas.reduce((a,b)=>a+b,0)/deltas.length;
  const monoUp = lumas.every((v,i)=>i===0||v>=lumas[i-1]-0.6);
  const monoDown = lumas.every((v,i)=>i===0||v<=lumas[i-1]+0.6);
  console.log(`\n[${label}] luma ${lumas[0].toFixed(1)} → ${lumas[lumas.length-1].toFixed(1)} (총 ${total.toFixed(1)})`);
  console.log(`  peak/step 델타 ${peak.toFixed(2)}, mean ${mean.toFixed(2)}, peak/mean ${(peak/(mean||1)).toFixed(1)} (스냅이면 ≫; 크로스페이드면 낮음)`);
  console.log(`  단조성: ${(monoUp||monoDown)?'단조(팝 없음)':'비단조(중간 역전 있음 — 확인 필요)'}`);
  console.log(`  luma 시퀀스: ${lumas.map(v=>v.toFixed(0)).join(' ')}`);
}

// 전환 중 재다이얼(리타깃): day →(0.6s)→ night →(0.6s)→ sunset. 큐 쌓임 없이 현재 보간값에서
// 새 목표로 갈아타는지 + NaN/검은 프레임(luma≈0) 없는지 확인.
async function runRetarget(){
  await open(`${base}/__envtween?time=day`);
  await raf();
  const lumas = [];
  const snap = async ()=>{ await raf(); lumas.push(await page.evaluate(()=>window.__luma())); };
  await snap();
  await page.evaluate(()=>window.__setTime('night'));
  for (let i=0;i<7;i++){ await page.evaluate(()=>window.__advance(0.09)); await snap(); }  // 중간까지
  await page.evaluate(()=>window.__setTime('sunset'));   // 리타깃(밤으로 가던 중 석양으로)
  await shot('retarget-mid');
  for (let i=0;i<20;i++){ await page.evaluate(()=>window.__advance(0.09)); await snap(); }
  await shot('retarget-end');
  const minL = Math.min(...lumas), hasNaN = lumas.some((v)=>!Number.isFinite(v));
  const deltas = []; for (let i=1;i<lumas.length;i++) deltas.push(Math.abs(lumas[i]-lumas[i-1]));
  const peak = Math.max(...deltas);
  console.log(`\n[retarget] day→night→(리타깃)→sunset`);
  console.log(`  NaN 프레임: ${hasNaN?'있음(FAIL)':'없음'}, 최소 luma ${minL.toFixed(1)} (검은 프레임 아님), peak/step 델타 ${peak.toFixed(2)}`);
  console.log(`  luma 시퀀스: ${lumas.map(v=>v.toFixed(0)).join(' ')}`);
}

const DUR_TIME = 1.8, DUR_SEASON = 2.6, DUR_WX = 1.6;
const want = (k)=> WHICH==='all' || WHICH===k;
try {
  if (want('day-sunset'))     await runTransition('day-sunset', 'time=day', 'time', 'sunset', DUR_TIME);
  if (want('sunset-night'))   await runTransition('sunset-night', 'time=sunset', 'time', 'night', DUR_TIME);
  if (want('clear-rain'))     await runTransition('clear-rain', 'time=day&weather=clear', 'weather', 'rain', DUR_WX);
  if (want('rain-snow'))      await runTransition('rain-snow', 'time=day&weather=rain', 'weather', 'snow', DUR_WX);
  if (want('summer-autumn'))  await runTransition('summer-autumn', 'time=day&season=summer', 'season', 'autumn', DUR_SEASON);
  if (want('retarget'))       await runRetarget();
} finally {
  await browser.close();
  server.close();
}
