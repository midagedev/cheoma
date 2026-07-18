// 헤드리스 스크린샷: 소동물(마당 닭 + 논 소) 검증 → shots/animals-*.png
// 사용법: NODE_PATH=/Users/hckim/repo/threesur/node_modules node tools/shoot-animals.mjs [group]
//   group = chicken | cow | night | all(기본)
//
// /__anim 인라인 하네스(env 직접 import — 병렬 중 앱 경로가 깨져도 무관):
//   window.__env             : setupEnvironment 결과(cowAnchor·debugFlockCenter)
//   window.__advance(secs)   : env.update 를 0.05s 씩 밀어 생물 시뮬 전진
//   window.__aim(cx..tz)     : 카메라 재조준
//   window.__animDiff(p,r,s) : 월드좌표 p 주변 반경 r(px) 크롭을 s초 시뮬 전후로 비교(모션 판정)
//                              — 동물 바운딩 영역만 봐서 상시 파티클(모트·물) 영향 최소화.
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
const season = ['spring','summer','autumn'].includes(q.get('season'))?q.get('season'):'summer';
const timeOfDay = q.get('time')||'day';
const preset = q.get('preset')||'korea';
const num=(k,d)=>{const v=parseFloat(q.get(k));return Number.isFinite(v)?v:d;};
const renderer=new THREE.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});
renderer.setSize(innerWidth,innerHeight);renderer.setPixelRatio(Math.min(devicePixelRatio,2));
renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;
renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.05;
document.getElementById('app').appendChild(renderer.domElement);
const scene=new THREE.Scene();scene.background=new THREE.Color(0xcfd8e0);scene.fog=new THREE.Fog(0xcfd8e0,80,340);
const sun=new THREE.DirectionalLight(0xfff0dd,2.6);sun.position.set(30,42,26);sun.castShadow=true;
sun.shadow.mapSize.set(2048,2048);sun.shadow.camera.left=-90;sun.shadow.camera.right=90;sun.shadow.camera.top=90;sun.shadow.camera.bottom=-90;
sun.shadow.camera.far=320;sun.shadow.bias=-0.0001;sun.shadow.normalBias=0.05;scene.add(sun);
const hemi=new THREE.HemisphereLight(0xbdd0e4,0x8a7a63,0.9);scene.add(hemi);
const P={...PRESETS[preset]};const building=buildBuilding(P);scene.add(building);
const layout=computeLayout(P);
const env=setupEnvironment(scene,{sun,hemi,renderer,layout});
env.setSeason(season,{immediate:true});env.setEnabled(true);env.setTime(timeOfDay);
window.__env=env;
const camera=new THREE.PerspectiveCamera(40,innerWidth/innerHeight,0.1,700);
const target=new THREE.Vector3(num('tx',0),num('ty',0.4),num('tz',10));
camera.position.set(num('cx',6),num('cy',3),num('cz',18));
camera.lookAt(target);
window.__aim=(cx,cy,cz,tx,ty,tz)=>{camera.position.set(cx,cy,cz);target.set(tx,ty,tz);camera.lookAt(target);};
window.__advance=(secs)=>{const n=Math.max(1,Math.round(secs/0.05));for(let i=0;i<n;i++)env.update(0.05);};
// 월드좌표 → 캔버스 디바이스 픽셀
function project(x,y,z){const v=new THREE.Vector3(x,y,z).project(camera);const W=renderer.domElement.width,H=renderer.domElement.height;return {x:(v.x*0.5+0.5)*W,y:(-v.y*0.5+0.5)*H};}
function grab(px,py,r){const W=renderer.domElement.width,H=renderer.domElement.height;let x0=Math.max(0,Math.round(px-r)),y0=Math.max(0,Math.round(py-r));let w=Math.min(W-x0,2*r),h=Math.min(H-y0,2*r);const c=document.createElement('canvas');c.width=w;c.height=h;const cx=c.getContext('2d');cx.drawImage(renderer.domElement,x0,y0,w,h,0,0,w,h);return cx.getImageData(0,0,w,h).data;}
// p=[x,y,z] 주변 반경 r(px) 크롭을 secs 시뮬 전후 비교 → 평균 프랙션 차(0..1)
window.__animDiff=(p,r,secs)=>{renderer.render(scene,camera);const s=project(p[0],p[1],p[2]);const a=grab(s.x,s.y,r);window.__advance(secs);renderer.render(scene,camera);const b=grab(s.x,s.y,r);let sum=0;const n=Math.min(a.length,b.length);for(let i=0;i<n;i+=4){sum+=Math.abs(a[i]-b[i])+Math.abs(a[i+1]-b[i+1])+Math.abs(a[i+2]-b[i+2]);}return sum/((n/4)*3*255);};
let frames=0;
renderer.setAnimationLoop(()=>{renderer.render(scene,camera);frames++;if(frames===3){window.__advance(0.5);window.__SHOT_READY=true;}});
</script></body></html>`;

const server = createServer(async (req, res) => {
  const path = req.url.split('?')[0];
  if (path === '/__anim') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(HTML); return; }
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
async function save(name) {
  const file = join(OUT, `animals-${name}.png`);
  await page.screenshot({ path: file });
  console.log('saved', file);
}
const want = (g) => GROUP === 'all' || GROUP === g;

// ---------------- 1) 마당 닭 (클로즈업) ----------------
if (want('chicken')) {
  for (const [name, time] of [['chicken-day', 'day'], ['chicken-sunset', 'sunset']]) {
    await open(`${base}/__anim?season=summer&time=${time}`);
    const c = await page.evaluate(() => { const v = window.__env.debugFlockCenter(); return [v.x, v.y, v.z]; });
    // 마당 앞쪽(+z, 건물 반대)에서 낮게 근접 — 닭 실루엣이 밝은 마당·하늘에 대비되게.
    await page.evaluate(([x, y, z]) => window.__aim(x + 1.6, y + 1.1, z + 3.0, x, y - 0.05, z), c);
    await page.evaluate(() => window.__advance(0.3));
    await save(name);
    if (time === 'day') {
      const d = await page.evaluate(([x, y, z]) => window.__animDiff([x, y, z], 220, 0.8), c);
      console.log('  chicken motion diff:', d.toFixed(5));
    }
  }
}

// ---------------- 2) 논의 소 (키 샷: 논+소 와이드 / 석양 실루엣) ----------------
if (want('cow')) {
  // 여름(초록 벼) 와이드 — "논에는 소가 있어야 제맛" 키 샷.
  await open(`${base}/__anim?season=summer&time=day`);
  const cow = await page.evaluate(() => { const v = window.__env.cowAnchor; return v ? [v.x, v.y, v.z] : null; });
  if (cow) {
    // 하류·개울측 저각 구도(전경 논둑에 안 가림) → 소 뒤로 다랑이 논 계단이 솟는다. 키 샷.
    await page.evaluate(([x, y, z]) => window.__aim(x - 8, y + 2.4, z - 4.5, x, y + 1.1, z), cow);
    await page.evaluate(() => window.__advance(0.3));
    await save('cow-day-wide');
    const d = await page.evaluate(([x, y, z]) => window.__animDiff([x, y + 1.0, z], 200, 2.5), cow);
    console.log('  cow motion diff:', d.toFixed(5));
    // 소 근접(고개·꼬리·귀 판독)
    await page.evaluate(([x, y, z]) => window.__aim(x - 4.5, y + 1.7, z - 2.8, x, y + 1.1, z), cow);
    await page.evaluate(() => window.__advance(0.3));
    await save('cow-close');
    // 가을(황금 들판) 와이드
    await open(`${base}/__anim?season=autumn&time=day`);
    const cow2 = await page.evaluate(() => { const v = window.__env.cowAnchor; return [v.x, v.y, v.z]; });
    await page.evaluate(([x, y, z]) => window.__aim(x - 8, y + 2.4, z - 4.5, x, y + 1.1, z), cow2);
    await page.evaluate(() => window.__advance(0.3));
    await save('cow-autumn-wide');
    // 석양 역광 실루엣: 낮게 깔아 밝은 하늘에 소 실루엣.
    await open(`${base}/__anim?season=autumn&time=sunset`);
    const cow3 = await page.evaluate(() => { const v = window.__env.cowAnchor; return [v.x, v.y, v.z]; });
    await page.evaluate(([x, y, z]) => window.__aim(x - 8, y + 1.5, z - 3.5, x, y + 1.3, z), cow3);
    await page.evaluate(() => window.__advance(0.3));
    await save('cow-sunset-silhouette');
  } else {
    console.log('cowAnchor 없음 — 소 미구현?');
  }
}

// ---------------- 3) 밤 (닭 홰 자세) ----------------
if (want('night')) {
  await open(`${base}/__anim?season=summer&time=night`);
  const c = await page.evaluate(() => { const v = window.__env.debugFlockCenter(); return [v.x, v.y, v.z]; });
  await page.evaluate(([x, y, z]) => window.__aim(x + 1.6, y + 1.1, z + 3.0, x, y - 0.05, z), c);
  await page.evaluate(() => window.__advance(1.5));   // 홰 자세로 웅크림 보간
  await save('chicken-night');
}

await browser.close();
server.close();
