// 헤드리스 검증: 마을 모드 환경 전환 크로스페이드(태스크 #50 마을 경로).
// 사용법: NODE_PATH=/Users/hckim/repo/threesur/node_modules node tools/shoot-village-tween.mjs
//
// engine 의 마을 배선을 모사: setupEnvironment + setupWeather(env) + createVillage + enterVillageMode,
// 시간대 변경 시 env.setTime + village.handle.setTime(+ reapplyVillageFog 상당 near/far). env.update·
// village.update 를 매 프레임 호출(engine 동일). day→sunset→night 를 밀며 t 컷 + luma 델타로 팝 부재 확인.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'shots');
mkdirSync(OUT, { recursive: true });
const MIME = { '.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.png':'image/png','.json':'application/json' };

const HTML = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>html,body{margin:0;height:100%;overflow:hidden;background:#cfd8e0}#app{width:100%;height:100%}</style>
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.185.1/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.185.1/examples/jsm/"}}</script>
</head><body><div id="app"></div>
<script type="module">
import * as THREE from 'three';
import { PRESETS, computeLayout } from '/src/params.js';
import { setupEnvironment } from '/src/env/index.js';
import { setupWeather } from '/src/env/weather.js';
import { createVillage } from '/src/village/adapter.js';
const q = new URLSearchParams(location.search);
const timeOfDay = q.get('time') || 'day';

const renderer = new THREE.WebGLRenderer({ antialias:true, preserveDrawingBuffer:true });
renderer.setSize(innerWidth, innerHeight); renderer.setPixelRatio(Math.min(devicePixelRatio,2));
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
document.getElementById('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xcfd8e0); scene.fog = new THREE.Fog(0xcfd8e0, 60, 220);
const sun = new THREE.DirectionalLight(0xfff0dd, 2.6); sun.position.set(30,42,26); sun.castShadow = true;
sun.shadow.mapSize.set(2048,2048); scene.add(sun);
const hemi = new THREE.HemisphereLight(0xbdd0e4, 0x8a7a63, 0.9); scene.add(hemi);

const layout = computeLayout({...PRESETS.korea});
const env = setupEnvironment(scene, { sun, hemi, renderer, layout });
env.setTime(timeOfDay); env.setSeason('summer', { immediate:true }); env.setEnabled(true);
const weather = setupWeather(scene, { layout, getBuilding:()=>null, getGround:()=>null, env });
weather.setWeather('clear');

const village = createVillage({ scale:'hamlet', seed:20260716 });
const R = village.plan.site.R;
village.enterVillageMode({ scene, env });
village.setTime(timeOfDay);
// engine reapplyVillageFog 상당(진입 1회) — 모디파이어가 매 틱 유지하지만 초기값도 세팅.
scene.fog.near = R*2.2; scene.fog.far = R*7.0;

// 마을 부감 카메라(높은 각). village 지형은 원점 중심.
const camera = new THREE.PerspectiveCamera(40, innerWidth/innerHeight, 0.5, R*8);
camera.position.set(R*0.05, R*1.15, R*1.5); camera.lookAt(0, 0, 0);

window.__setTime = (name)=>{ env.setTime(name); village.setTime(name); scene.fog.near=R*2.2; scene.fog.far=R*7.0; };
window.__advance = (secs)=>{ const n=Math.max(1,Math.round(secs/0.05)); for(let i=0;i<n;i++){ env.update(0.05); village.update(0.05); weather.update(0.05); } };
window.__luma = ()=>{ const w=160,h=100,c=document.createElement('canvas'); c.width=w;c.height=h; const x=c.getContext('2d'); x.drawImage(renderer.domElement,0,0,w,h); const d=x.getImageData(0,0,w,h).data; let s=0; for(let i=0;i<d.length;i+=4) s+=0.2126*d[i]+0.7152*d[i+1]+0.0722*d[i+2]; return s/(w*h); };
window.__fog = ()=>({near:+scene.fog.near.toFixed(0), far:+scene.fog.far.toFixed(0), color:'#'+scene.fog.color.getHexString()});
// 순흑 비율(#44 회귀): 다운샘플 픽셀 중 luma<thresh 비율(%). 마을 야간이 뭉갠 검정으로 죽지 않는지.
window.__blackfrac = (thresh)=>{ const w=200,h=125,c=document.createElement('canvas'); c.width=w;c.height=h; const x=c.getContext('2d'); x.drawImage(renderer.domElement,0,0,w,h); const d=x.getImageData(0,0,w,h).data; let n=0; for(let i=0;i<d.length;i+=4){ const l=0.2126*d[i]+0.7152*d[i+1]+0.0722*d[i+2]; if(l<(thresh||14)) n++; } return +(100*n/(w*h)).toFixed(2); };
// 마을 이탈: fog 모디파이어 해제 후 단일 건물 base fog(시간대 거리)로 복귀하는지 확인.
window.__exit = ()=>{ village.exitVillageMode({ scene, env }); env.update(0.05); };
// 정착 루프(구름·엣지 헤이즈·리그 정착).
for (let i=0;i<16;i++){ env.update(0.05); village.update(0.05); weather.update(0.05); }
let frames=0;
renderer.setAnimationLoop(()=>{ renderer.render(scene,camera); frames++; if(frames===3) window.__SHOT_READY=true; });
</script></body></html>`;

const server = createServer(async (req,res)=>{ const p=req.url.split('?')[0]; if(p==='/__vtween'){res.writeHead(200,{'content-type':'text/html'});res.end(HTML);return;} try{const d=await readFile(join(ROOT,p==='/'?'index.html':p));res.writeHead(200,{'content-type':MIME[extname(p)]||'application/octet-stream'});res.end(d);}catch{res.writeHead(404);res.end('nf');}});
await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
const base=`http://127.0.0.1:${server.address().port}`;
let browser; try{browser=await chromium.launch({channel:'chrome'});}catch{browser=await chromium.launch();}
const page=await browser.newPage({viewport:{width:1280,height:800,deviceScaleFactor:2}});
page.on('pageerror',e=>console.error('[pageerror]',e.message));
page.on('console',m=>{ if(m.type()==='error') console.error('[page]',m.text()); });
async function raf(){ await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))); }
async function shot(n){ await page.screenshot({path:join(OUT,`vtween-${n}.png`)}); console.log('saved vtween-'+n+'.png'); }

async function run(label, initial, target, dur){
  await page.goto(`${base}/__vtween?time=${initial}`,{waitUntil:'load'});
  await page.waitForFunction('window.__SHOT_READY===true',null,{timeout:45000});
  await raf();
  console.log(`\n[${label}] initial fog`, await page.evaluate(()=>window.__fog()));
  const STEPS=16, step=dur/STEPS; const lumas=[await page.evaluate(()=>window.__luma())];
  await shot(`${label}-t000`);
  await page.evaluate((t)=>window.__setTime(t), target);
  const cut=new Set([Math.round(STEPS*0.5),STEPS]);
  for(let i=1;i<=STEPS;i++){ await page.evaluate(s=>window.__advance(s),step); await raf(); lumas.push(await page.evaluate(()=>window.__luma())); if(cut.has(i)) await shot(`${label}-t${String(Math.round(i/STEPS*100)).padStart(3,'0')}`); }
  const dl=[]; for(let i=1;i<lumas.length;i++) dl.push(Math.abs(lumas[i]-lumas[i-1]));
  const peak=Math.max(...dl), mean=dl.reduce((a,b)=>a+b,0)/dl.length;
  console.log(`  final fog`, await page.evaluate(()=>window.__fog()));
  console.log(`  luma ${lumas[0].toFixed(1)}→${lumas[lumas.length-1].toFixed(1)}, peak/step ${peak.toFixed(2)}, mean ${mean.toFixed(2)}, peak/mean ${(peak/(mean||1)).toFixed(1)}`);
  console.log(`  seq: ${lumas.map(v=>v.toFixed(0)).join(' ')}`);
  return lumas;
}
try {
  await run('day-sunset','day','sunset',1.8);
  await run('sunset-night','sunset','night',1.8);
  // #44 회귀: 정착 야간 순흑 비율(no-post 보수적 추정 — 실파이프라인은 bloom 로 더 밝음).
  const black = await page.evaluate(()=>window.__blackfrac(14));
  console.log(`\n[#44 순흑] 정착 야간 luma<14 비율 ${black}% (낮을수록 좋음, 뭉갠 검정 없음)`);
  // 이탈 fog 복귀: 모디파이어 해제 후 base(시간대 거리)로 돌아오는지.
  const fogBefore = await page.evaluate(()=>window.__fog());
  await page.evaluate(()=>window.__exit());
  const fogAfter = await page.evaluate(()=>window.__fog());
  console.log(`[이탈 fog] 이탈 전(마을) near/far ${fogBefore.near}/${fogBefore.far} → 이탈 후(단일) ${fogAfter.near}/${fogAfter.far} (마을 거리 오버라이드 해제 확인)`);
} finally { await browser.close(); server.close(); }
