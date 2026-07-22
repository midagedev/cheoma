// 헤드리스 스크린샷: 지형·다랑이 논·개울 검증 → shots/terrain-*.png
// 사용법: node tools/shoot-terrain.mjs
//   env=1 계절 3종 × three-quarter/front + 가을 ink 1 + 계곡(개울·논) 클로즈(orbit t)
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'shots');
mkdirSync(OUT, { recursive: true });

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json',
};

// 검증 전용 인라인 하네스(프로젝트 HTML 불침해): src 모듈을 그대로 import 하되
// 카메라를 계곡(개울·다랑이 논) 정면으로 놓아 디테일을 육안 확인한다.
// cam/target 은 쿼리(cx,cy,cz,tx,ty,tz)로 재정의 가능.
const VALLEY_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>html,body{margin:0;height:100%;overflow:hidden;background:#cfd8e0}#app{width:100%;height:100%}</style>
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.185.1/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.185.1/examples/jsm/"}}</script>
</head><body><div id="app"></div>
<script type="module">
import * as THREE from 'three';
import { PRESETS, computeLayout } from '/src/params.js';
import { buildBuilding } from '/src/builder/index.js';
import { setupEnvironment } from '/src/env/index.js';
import { setupInk } from '/src/render/ink.js';
const q = new URLSearchParams(location.search);
const season = ['spring','summer','autumn','winter'].includes(q.get('season'))?q.get('season'):'summer';
const timeOfDay = q.get('time')||'day';
const ink = q.get('mode')==='ink';
const num=(k,d)=>{const v=parseFloat(q.get(k));return Number.isFinite(v)?v:d;};
const renderer=new THREE.WebGLRenderer({antialias:true});
renderer.setSize(innerWidth,innerHeight);renderer.setPixelRatio(Math.min(devicePixelRatio,2));
renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;
renderer.toneMapping=ink?THREE.NoToneMapping:THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.05;
document.getElementById('app').appendChild(renderer.domElement);
const scene=new THREE.Scene();scene.background=new THREE.Color(0xcfd8e0);scene.fog=new THREE.Fog(0xcfd8e0,60,300);
const sun=new THREE.DirectionalLight(0xfff0dd,2.6);sun.position.set(30,42,26);sun.castShadow=true;
sun.shadow.mapSize.set(4096,4096);sun.shadow.camera.left=-60;sun.shadow.camera.right=60;sun.shadow.camera.top=60;sun.shadow.camera.bottom=-60;
sun.shadow.camera.far=260;sun.shadow.bias=-0.0001;sun.shadow.normalBias=0.05;scene.add(sun);
const hemi=new THREE.HemisphereLight(0xbdd0e4,0x8a7a63,0.9);scene.add(hemi);
const P={...PRESETS.korea};const building=buildBuilding(P);scene.add(building);
const layout=computeLayout(P);
const env=setupEnvironment(scene,{sun,hemi,renderer,layout});
env.setTime(timeOfDay);env.setSeason(season,{immediate:true});env.setEnabled(true);
const camera=new THREE.PerspectiveCamera(38,innerWidth/innerHeight,0.1,600);
camera.position.set(num('cx',-16),num('cy',11),num('cz',26));
const target=new THREE.Vector3(num('tx',-72),num('ty',-0.5),num('tz',-3));
camera.lookAt(target);
let inkPipe=null;
if(ink){inkPipe=setupInk(renderer,scene,camera);inkPipe.setSize(innerWidth,innerHeight);
  if(scene.fog){inkPipe.inkPass.uniforms.fogNear.value=scene.fog.near;inkPipe.inkPass.uniforms.fogFar.value=scene.fog.far;
  scene.fog.color.copy(new THREE.Color(0xf3efe6));}scene.background=new THREE.Color(0xf3efe6);}
let frames=0;const clock=new THREE.Clock();
renderer.setAnimationLoop(()=>{const dt=Math.min(clock.getDelta(),0.05);env.update(dt);
  if(ink)inkPipe.composer.render();else renderer.render(scene,camera);
  frames++;if(frames===40)window.__SHOT_READY=true;});
</script></body></html>`;

const server = createServer(async (req, res) => {
  const path = req.url.split('?')[0];
  if (path === '/__valley') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(VALLEY_HTML);
    return;
  }
  try {
    const file = join(ROOT, path === '/' ? 'index.html' : path);
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('not found');
  }
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const port = server.address().port;

// 캡처 목록: [파일접미사, 쿼리]
const shots = [];
for (const season of ['spring', 'summer', 'autumn', 'winter']) {
  for (const angle of ['three-quarter', 'front']) {
    shots.push([`${season}-${angle}`, `env=1&preset=korea&season=${season}&angle=${angle}&time=day`]);
  }
}
// --- 계곡(개울·다랑이 논) 정면 검증: 인라인 하네스 ---
const valley = [];
for (const season of ['spring', 'summer', 'autumn', 'winter']) {
  valley.push([`valley-${season}`, `/__valley?season=${season}&time=day`]);
}
valley.push(['valley-ink-autumn', `/__valley?season=autumn&time=day&mode=ink`]);
// 논 계단 클로즈업(봄 물댄 논) + 개울 클로즈업
valley.push(['paddy-close', `/__valley?season=spring&time=day&cx=-50&cy=6&cz=13&tx=-82&ty=-1&tz=-8`]);
valley.push(['stream-close', `/__valley?season=summer&time=day&cx=-40&cy=5&cz=6&tx=-88&ty=-2&tz=-14`]);

let browser;
try { browser = await chromium.launch({ channel: 'chrome' }); }
catch { browser = await chromium.launch(); }
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('console', (msg) => { if (msg.type() === 'error') console.error('[page]', msg.text()); });
page.on('pageerror', (err) => console.error('[pageerror]', err.message));

for (const [name, qs] of shots) {
  const url = `http://127.0.0.1:${port}/index.html?shot=1&${qs}`;
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 30000 });
  await page.waitForTimeout(300);
  const file = join(OUT, `terrain-${name}.png`);
  await page.screenshot({ path: file });
  console.log('saved', file);
}
for (const [name, qs] of valley) {
  const url = `http://127.0.0.1:${port}${qs}`;
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 30000 });
  await page.waitForTimeout(300);
  const file = join(OUT, `terrain-${name}.png`);
  await page.screenshot({ path: file });
  console.log('saved', file);
}

await browser.close();
server.close();
