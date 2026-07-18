// 헤드리스 스크린샷: 굴뚝 연기 + 아궁이 불씨 검증 → shots/smoke-*.png
// 사용법: NODE_PATH=/Users/hckim/repo/threesur/node_modules node tools/shoot-smoke.mjs [group]
//   group = giwa | wind | night | choga | regress | all(기본)
//
// env 직접 import 하네스(/__smoke): index.html 앱 경로(다른 에이전트가 자주 깨뜨림) 회피.
//   window.__advance(secs)      : env.update 를 0.05s 씩 밀어 연기 상승·소산 전진(결정론)
//   window.__setWind(scale)     : getWind 전역 배율(무풍 0 · 강풍 2 비교 컷)
//   window.__aim(cx,cy,cz,tx,ty,tz) : 카메라 재조준
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'shots');
mkdirSync(OUT, { recursive: true });
const GROUP = process.argv[2] || 'all';

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json',
};

const HTML = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>html,body{margin:0;height:100%;overflow:hidden;background:#cfd8e0}#app{width:100%;height:100%}</style>
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.185.1/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.185.1/examples/jsm/"}}</script>
</head><body><div id="app"></div>
<script type="module">
import * as THREE from 'three';
import { PRESETS, computeLayout } from '/src/params.js';
import { buildBuilding } from '/src/builder/index.js';
import { setupEnvironment } from '/src/env/index.js';
const q = new URLSearchParams(location.search);
const preset = q.get('preset') || 'giwa';
const timeOfDay = q.get('time') || 'sunset';
const num=(k,d)=>{const v=parseFloat(q.get(k));return Number.isFinite(v)?v:d;};
const renderer=new THREE.WebGLRenderer({antialias:true});
renderer.setSize(innerWidth,innerHeight);renderer.setPixelRatio(Math.min(devicePixelRatio,2));
renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;
renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.05;
document.getElementById('app').appendChild(renderer.domElement);
const scene=new THREE.Scene();scene.background=new THREE.Color(0xcfd8e0);scene.fog=new THREE.Fog(0xcfd8e0,60,300);
const sun=new THREE.DirectionalLight(0xfff0dd,2.6);sun.position.set(30,42,26);sun.castShadow=true;
sun.shadow.mapSize.set(2048,2048);sun.shadow.camera.left=-40;sun.shadow.camera.right=40;sun.shadow.camera.top=40;sun.shadow.camera.bottom=-40;
sun.shadow.camera.far=260;sun.shadow.bias=-0.0001;sun.shadow.normalBias=0.05;scene.add(sun);
const hemi=new THREE.HemisphereLight(0xbdd0e4,0x8a7a63,0.9);scene.add(hemi);
const P={...PRESETS[preset]};const building=buildBuilding(P);building.name='building';scene.add(building);
const layout=computeLayout(P);
const env=setupEnvironment(scene,{sun,hemi,renderer,layout});
env.setTime(timeOfDay);env.setSeason('summer',{immediate:true});env.setEnabled(true);
window.__env=env;
// 카메라: 실제 제품 프레이밍(건물 고정, FOV28). frame=tq|front|side, 또는 cx..tz 직접.
const frame=q.get('frame')||'tq';
const camera=new THREE.PerspectiveCamera(28,innerWidth/innerHeight,0.1,600);
const maxDim=Math.max(layout.W+4,layout.D+4,layout.totalH);
const target=new THREE.Vector3(0,layout.totalH*0.42,0);
const spots={front:{az:0,el:7,r:2.9},'tq':{az:38,el:13,r:3.0},side:{az:90,el:8,r:2.9}};
function place(){
  if(q.get('cx')!==null){camera.position.set(num('cx',12),num('cy',3),num('cz',6));target.set(num('tx',0),num('ty',1),num('tz',0));camera.lookAt(target);return;}
  const s=spots[frame]||spots.tq;const az=(num('az',s.az))*Math.PI/180,el=s.el*Math.PI/180,r=s.r*maxDim;
  camera.position.set(target.x+r*Math.cos(el)*Math.sin(az),target.y+r*Math.sin(el),target.z+r*Math.cos(el)*Math.cos(az));
  camera.lookAt(target);
}
place();
window.__aim=(cx,cy,cz,tx,ty,tz)=>{camera.position.set(cx,cy,cz);target.set(tx,ty,tz);camera.lookAt(target);};
window.__setWind=(s)=>{window.__windScale=s;};
window.__advance=(secs)=>{const n=Math.max(1,Math.round(secs/0.05));for(let i=0;i<n;i++)env.update(0.05);};
let frames=0;
renderer.setAnimationLoop(()=>{
  renderer.render(scene,camera);
  frames++;if(frames===3){window.__advance(2.0);window.__SHOT_READY=true;}  // 초기 연기 컬럼 형성
});
</script></body></html>`;

const server = createServer(async (req, res) => {
  const path = req.url.split('?')[0];
  if (path === '/__smoke') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(HTML); return; }
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
try { browser = await chromium.launch({ channel: 'chrome' }); }
catch { browser = await chromium.launch(); }
const page = await browser.newPage({ viewport: { width: 1280, height: 800, deviceScaleFactor: 2 } });
page.on('console', (msg) => { if (msg.type() === 'error') console.error('[page]', msg.text()); });
page.on('pageerror', (err) => console.error('[pageerror]', err.message));

async function open(url) {
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 30000 });
}
async function advance(s) { await page.evaluate((x) => window.__advance(x), s); }
async function setWind(s) { await page.evaluate((x) => window.__setWind(x), s); }
async function aim(a) { await page.evaluate((v) => window.__aim(...v), a); }
async function save(name, clip) {
  const file = join(OUT, `smoke-${name}.png`);
  await page.screenshot(clip ? { path: file, clip } : { path: file });
  console.log('saved', file);
}
const want = (g) => GROUP === 'all' || GROUP === g;

// ---------------- 1) giwa 해질녘·새벽 연기 (하늘 배경에서 읽히게) ----------------
if (want('giwa')) {
  for (const [t, fr] of [['sunset', 'tq'], ['sunset', 'front'], ['dawn', 'tq']]) {
    await open(`${base}/__smoke?preset=giwa&time=${t}&frame=${fr}`);
    await save(`giwa-${t}-${fr}-a`);
    await advance(3.0); await save(`giwa-${t}-${fr}-b`);   // 3초 뒤(형태 변화: 상승·소산)
  }
}

// ---------------- 2) 바람 유/무 비교 (연기 기울기) ----------------
if (want('wind')) {
  // 무풍: 수직 상승
  await open(`${base}/__smoke?preset=giwa&time=sunset&frame=tq`);
  await setWind(0); await advance(4.0); await save('wind-calm');
  // 강풍: 눕는 컬럼 + 거스트 kink
  await setWind(2.2); await advance(4.0); await save('wind-gust');
}

// ---------------- 3) 밤: 아궁이 불씨 + 연기 ----------------
if (want('night')) {
  await open(`${base}/__smoke?preset=giwa&time=night&frame=tq`);
  await advance(2.0); await save('night-tq');
  // 아궁이 근접(우측면 기단부 화구·가마솥·불씨)
  await aim([11.5, 1.9, 4.2, 5.1, 0.6, 0.7]);
  await advance(0.4); await save('night-agungi');
  // 낮에는 화구 소등(회귀)
  await open(`${base}/__smoke?preset=giwa&time=day&frame=tq`);
  await aim([11.5, 1.9, 4.2, 5.1, 0.6, 0.7]);
  await advance(0.4); await save('day-agungi');
}

// ---------------- 4) choga 굴뚝 연기 (anchor 탐지 성공 확인) ----------------
if (want('choga')) {
  for (const [t, fr] of [['sunset', 'tq'], ['dawn', 'side']]) {
    await open(`${base}/__smoke?preset=choga&time=${t}&frame=${fr}`);
    await advance(2.5); await save(`choga-${t}-${fr}-a`);
    await advance(3.0); await save(`choga-${t}-${fr}-b`);
  }
}

// ---------------- 연가 개별 실루엣 검증 (three-quarter, 하늘 배경) ----------------
if (want('yeonga')) {
  // 굴뚝 꼭대기 근접 three-quarter(저각→하늘 배경): 개별 토관으로 읽히는지
  await open(`${base}/__smoke?preset=giwa&time=day&cx=11.5&cy=1.7&cz=5.6&tx=5.75&ty=3.25&tz=-1.2`);
  await advance(0.3); await save('yeonga-closeup');
  // 원거리 판정(주간 중거리 three-quarter, 하늘/원경 배경 — critic 근거와 동일 조건)
  await open(`${base}/__smoke?preset=giwa&time=day&cx=14&cy=3.9&cz=7&tx=5.75&ty=3.35&tz=-1.2`);
  await advance(0.3); await save('yeonga-far');
}

// ---------------- 회귀: day 맑음 · night 기존 무드 (연기 있어도 어색 X) ----------------
if (want('regress')) {
  for (const [name, qs] of [
    ['reg-giwa-day', 'preset=giwa&time=day&frame=tq'],
    ['reg-giwa-night', 'preset=giwa&time=night&frame=tq'],
    ['reg-choga-day', 'preset=choga&time=day&frame=tq'],
  ]) {
    await open(`${base}/__smoke?${qs}`);
    await advance(2.0); await save(name);
  }
}

await browser.close();
server.close();
