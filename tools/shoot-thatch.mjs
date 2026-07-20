// 헤드리스: 초가 처마 프린지 고증 검증(태스크 #71) → shots/thatch-*.png (기본은 스크래치패드)
// 사용법: node tools/shoot-thatch.mjs [tag] [outdir]
//   tag    = before | after | (임의 접두)   기본 'x'
//   outdir = 저장 디렉터리                  기본 스크래치패드/thatch
//
// env 직접 import 하네스(/__th): index.html 앱 경로 회피(다른 에이전트가 자주 깨뜨림).
// 프레임 + __aim 매크로로 처마 끝을 사진과 대조 가능한 각도로 잡는다.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..');
const TAG = process.argv[2] || 'x';
const OUT = process.argv[3] || '/private/tmp/claude-501/-Users-hckim-repo-asiahouse/7a15478e-68e3-4ad3-b08a-bdb86ae4fe92/scratchpad/thatch';
mkdirSync(OUT, { recursive: true });

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
import { setupWeather } from '/src/env/weather.js';
import { setupPost } from '/src/env/post.js';
const q = new URLSearchParams(location.search);
const preset = q.get('preset') || 'choga';
const timeOfDay = q.get('time') || 'day';
const season = q.get('season') || 'summer';
const weatherKind = q.get('weather') || 'clear';
const postOn = q.get('post') !== '0';
const num=(k,d)=>{const v=parseFloat(q.get(k));return Number.isFinite(v)?v:d;};
const renderer=new THREE.WebGLRenderer({antialias:true});
renderer.setSize(innerWidth,innerHeight);renderer.setPixelRatio(Math.min(devicePixelRatio,2));
renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;
renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.05;
document.getElementById('app').appendChild(renderer.domElement);
const scene=new THREE.Scene();scene.background=new THREE.Color(0xcfd8e0);scene.fog=new THREE.Fog(0xcfd8e0,60,300);
const sun=new THREE.DirectionalLight(0xfff0dd,2.6);sun.position.set(30,42,26);sun.castShadow=true;
sun.shadow.mapSize.set(2048,2048);sun.shadow.camera.left=-22;sun.shadow.camera.right=22;sun.shadow.camera.top=22;sun.shadow.camera.bottom=-22;
sun.shadow.camera.far=260;sun.shadow.bias=-0.0001;sun.shadow.normalBias=0.05;scene.add(sun);
const hemi=new THREE.HemisphereLight(0xbdd0e4,0x8a7a63,0.9);scene.add(hemi);
const P={...PRESETS[preset]};const building=buildBuilding(P);building.name='building';scene.add(building);
const layout=computeLayout(P);
const env=setupEnvironment(scene,{sun,hemi,renderer,layout});
env.setSeason(season,{immediate:true});env.setTime(timeOfDay);env.setEnabled(true);
const weather=setupWeather(scene,{layout,getBuilding:()=>scene.getObjectByName('building'),getGround:()=>null});
weather.setWeather(weatherKind,{immediate:true});
if(weatherKind==='clear'&&window.__wx)window.__wx.setAccum(0);
window.__env=env;window.__wx=window.__wx;
const camera=new THREE.PerspectiveCamera(28,innerWidth/innerHeight,0.1,500);
const maxDim=Math.max(layout.W+4,layout.D+4,layout.totalH);
const target=new THREE.Vector3(0,layout.totalH*0.42,0);
const spots={
  front:{az:0,el:5,r:2.7,ty:0.42},
  tq:{az:38,el:13,r:2.9,ty:0.42},
  side:{az:90,el:9,r:2.9,ty:0.42},
  roof:{az:30,el:42,r:2.4,ty:0.60},
  roofclose:{az:24,el:34,r:1.6,ty:0.70},
  eave:{az:24,el:2,r:1.55,ty:0.30},
};
let post=null;
if(postOn){post=setupPost({renderer,scene,camera});post.setSize(innerWidth,innerHeight);post.setTime(timeOfDay);post.setEnabled(true);}
function place(frame){
  const s=spots[frame]||spots.tq;
  target.set(0,layout.totalH*(s.ty??0.42),0);
  const az=(num('az',s.az))*Math.PI/180,el=s.el*Math.PI/180,r=s.r*maxDim;
  camera.position.set(target.x+r*Math.cos(el)*Math.sin(az),target.y+r*Math.sin(el),target.z+r*Math.cos(el)*Math.cos(az));
  camera.lookAt(target);
}
place(q.get('frame')||'tq');
window.__aim=(cx,cy,cz,tx,ty,tz)=>{camera.position.set(cx,cy,cz);target.set(tx,ty,tz);camera.lookAt(target);};
window.__frameInfo=()=>({W:layout.W,D:layout.D,totalH:layout.totalH,xEave:layout.xEave,zEave:layout.zEave,podTopY:layout.podTopY,eaveEdgeY:layout.eaveEdgeY,ridgeY:layout.ridgeY});
window.__advance=(secs)=>{const n=Math.max(1,Math.round(secs/0.05));for(let i=0;i<n;i++){env.update(0.05);weather.update(0.05);}};
let frames=0;
renderer.setAnimationLoop(()=>{
  if(post){if(post.update)post.update(0.016);post.composer.render();}
  else renderer.render(scene,camera);
  frames++;if(frames===3){window.__advance(2.5);window.__SHOT_READY=true;}
});
</script></body></html>`;

const server = createServer(async (req, res) => {
  const path = req.url.split('?')[0];
  if (path === '/__th') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(HTML); return; }
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
const errors = [];
page.on('pageerror', (err) => { console.error('[pageerror]', err.message); errors.push(err.message); });

async function open(url) {
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 30000 });
}
async function aim(a) { await page.evaluate((v) => window.__aim(...v), a); }
async function info() { return await page.evaluate(() => window.__frameInfo()); }
async function save(name, clip) {
  const file = join(OUT, `thatch-${TAG}-${name}.png`);
  await page.screenshot(clip ? { path: file, clip } : { path: file });
  console.log('saved', file);
}

// 1) 표준 프레임(초가)
for (const [fr, t] of [['tq','day'],['front','day'],['roofclose','day'],['eave','day'],['tq','sunset'],['tq','night']]) {
  await open(`${base}/__th?preset=choga&frame=${fr}&time=${t}`);
  await save(`${fr}-${t}`);
}

// 2) 처마 끝 매크로: 정면 우측 처마 코너를 (a)측면 실루엣 (b)위-바깥 외면
await open(`${base}/__th?preset=choga&frame=eave&time=day`);
const L = await info();
// (a) 처마 높이에서 능선 밖으로 봄 — 끝단 실루엣이 하늘 대비
await aim([L.W*0.10, L.eaveEdgeY+0.35, L.zEave+3.6, L.W*0.32, L.eaveEdgeY-0.25, L.zEave]);
await save('macro-silhouette-day');
// (b) 위-바깥에서 처마 외면·썰린 단면 톤
await aim([L.W*0.28, L.eaveEdgeY+2.4, L.zEave+3.2, L.W*0.20, L.eaveEdgeY-0.15, L.zEave-0.2]);
await save('macro-outer-day');
// (c) 아래-바깥에서 처마 밑면·프린지 늘어짐(sunset 역광이면 실루엣 강조)
await open(`${base}/__th?preset=choga&frame=eave&time=sunset`);
await aim([L.W*0.12, L.eaveEdgeY-0.8, L.zEave+3.4, L.W*0.30, L.eaveEdgeY+0.2, L.zEave]);
await save('macro-silhouette-sunset');

// 3) 눈(적설 쉘 정합)
await open(`${base}/__th?preset=choga&frame=roofclose&time=day&weather=snow`);
await page.evaluate(() => window.__advance(6));
await save('snow-roofclose');

await browser.close();
server.close();
console.log(errors.length ? `\nTOTAL PAGEERRORS: ${errors.length}` : '\nNO PAGEERRORS');
for (const e of errors) console.log(' -', e);
