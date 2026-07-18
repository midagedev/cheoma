// 헤드리스 스크린샷: 앰비언트 폴리시 4건 검증 → shots/ambient-*.png
// 사용법: node tools/shoot-ambient.mjs [group]
//   group = ridge | field | water | critters | regress | all(기본)
//
// 두 경로를 쓴다:
//  - /index.html?shot=1&...  : 실제 제품 프레이밍(카메라 건물 고정) — 능선/회귀 컷
//  - /__amb?...              : 카메라·시뮬레이션 스텝을 직접 제어(계곡·물·까치 근접 검증)
//    window.__advance(secs)  : env.update 를 0.05s 씩 밀어 물결·계절·생물 시뮬 전진
//    window.__aim(cx,cy,cz,tx,ty,tz) : 카메라 재조준
//    window.__env            : setupEnvironment 결과(까치 나무 페르치 디버그 스냅)
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

const AMB_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8">
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
const season = ['spring','summer','autumn'].includes(q.get('season'))?q.get('season'):'summer';
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
sun.shadow.mapSize.set(2048,2048);sun.shadow.camera.left=-60;sun.shadow.camera.right=60;sun.shadow.camera.top=60;sun.shadow.camera.bottom=-60;
sun.shadow.camera.far=260;sun.shadow.bias=-0.0001;sun.shadow.normalBias=0.05;scene.add(sun);
const hemi=new THREE.HemisphereLight(0xbdd0e4,0x8a7a63,0.9);scene.add(hemi);
const P={...PRESETS.korea};const building=buildBuilding(P);scene.add(building);
const layout=computeLayout(P);
const env=setupEnvironment(scene,{sun,hemi,renderer,layout});
env.setTime(timeOfDay);env.setSeason(season,{immediate:true});env.setEnabled(true);
window.__env=env;
// frame=tq|front: 실제 제품 프레이밍(카메라 건물 고정, FOV28) — weather.js 없이 능선/회귀 컷.
// 그 외: 계곡 근접(FOV38) — cx..tz 로 카메라 직접 지정.
const frame=q.get('frame');
const bldg=(frame==='tq'||frame==='front');
const camera=new THREE.PerspectiveCamera(bldg?28:38,innerWidth/innerHeight,0.1,600);
let target;
if(bldg){
  const maxDim=Math.max(layout.W+4,layout.D+4,layout.totalH);
  target=new THREE.Vector3(0,layout.totalH*0.42,0);
  const spot=frame==='front'?{az:0,el:7,r:2.9}:{az:38,el:13,r:3.0};
  const az=spot.az*Math.PI/180,el=spot.el*Math.PI/180,r=spot.r*maxDim;
  camera.position.set(target.x+r*Math.cos(el)*Math.sin(az),target.y+r*Math.sin(el),target.z+r*Math.cos(el)*Math.cos(az));
}else{
  target=new THREE.Vector3(num('tx',-72),num('ty',-0.5),num('tz',-3));
  camera.position.set(num('cx',-16),num('cy',11),num('cz',26));
}
camera.lookAt(target);
window.__aim=(cx,cy,cz,tx,ty,tz)=>{camera.position.set(cx,cy,cz);target.set(tx,ty,tz);camera.lookAt(target);};
let inkPipe=null;
if(ink){inkPipe=setupInk(renderer,scene,camera);inkPipe.setSize(innerWidth,innerHeight);
  if(scene.fog){inkPipe.inkPass.uniforms.fogNear.value=scene.fog.near;inkPipe.inkPass.uniforms.fogFar.value=scene.fog.far;
  scene.fog.color.copy(new THREE.Color(0xf3efe6));}scene.background=new THREE.Color(0xf3efe6);}
window.__advance=(secs)=>{const n=Math.max(1,Math.round(secs/0.05));for(let i=0;i<n;i++)env.update(0.05);};
let frames=0;
renderer.setAnimationLoop(()=>{
  if(ink)inkPipe.composer.render();else renderer.render(scene,camera);
  frames++;if(frames===3){window.__advance(0.6);window.__SHOT_READY=true;}
});
</script></body></html>`;

const server = createServer(async (req, res) => {
  const path = req.url.split('?')[0];
  if (path === '/__amb') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(AMB_HTML);
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
// index.html 경로는 다른 에이전트의 미완성 편집(weather.js 등)으로 깨질 수 있어 관대하게 처리.
async function tryOpen(url) {
  try { await open(url); return true; }
  catch (e) { console.log('SKIP (app broken?):', url.split('?')[1], '-', e.name); return false; }
}
async function save(name, clip) {
  const file = join(OUT, `ambient-${name}.png`);
  await page.screenshot(clip ? { path: file, clip } : { path: file });
  console.log('saved', file);
}
const want = (g) => GROUP === 'all' || GROUP === g;

// ---------------- 1) 능선 가을 훅 (실제 프레이밍) ----------------
if (want('ridge')) {
  const combos = [
    ['autumn-day', 'season=autumn&time=day'],
    ['autumn-sunset', 'season=autumn&time=sunset'],
    ['autumn-dawn', 'season=autumn&time=dawn'],
    ['autumn-night', 'season=autumn&time=night'],
    ['summer-day', 'season=summer&time=day'],
  ];
  for (const [name, qs] of combos) {
    await open(`${base}/__amb?frame=tq&${qs}`);
    await save(`ridge-${name}`);
  }
}

// ---------------- 2) 들판 금빛 (계곡 하네스: 들판+논 동시) ----------------
if (want('field')) {
  for (const season of ['autumn', 'summer', 'spring']) {
    await open(`${base}/__amb?season=${season}&time=day`);
    await save(`field-${season}`);
  }
  // 제품 프레이밍(앞마당 초지 apron)
  for (const season of ['autumn', 'summer']) {
    await open(`${base}/__amb?frame=tq&season=${season}&time=day`);
    await save(`field-prod-${season}`);
  }
}

// ---------------- 3) 물 하이라이트 (개울 근접) ----------------
if (want('water')) {
  const cam = 'cx=-40&cy=5&cz=6&tx=-88&ty=-2&tz=-14';
  for (const time of ['day', 'sunset', 'night']) {
    await open(`${base}/__amb?season=summer&time=${time}&${cam}`);
    await page.evaluate(() => window.__advance(2.2));  // 물결 전진(반짝임 위상)
    await save(`water-${time}`);
  }
  // 봄 물댄 논 반짝임도 확인
  await open(`${base}/__amb?season=spring&time=day&cx=-50&cy=6&cz=13&tx=-82&ty=-1&tz=-8`);
  await page.evaluate(() => window.__advance(2.2));
  await save('water-paddy-spring');
}

// ---------------- 4) 나무 위 까치 ----------------
if (want('critters')) {
  // 디버그 스냅: 까치를 나무 페르치로 올리고 그 지점을 근접 프레이밍.
  await open(`${base}/__amb?season=autumn&time=day&cx=-16&cy=11&cz=26`);
  const p = await page.evaluate(() => window.__env.debugMagpieTree && window.__env.debugMagpieTree());
  if (p) {
    // 마당(원점) 쪽에서 수관 꼭대기 높이로 근접 조준 → 하늘 배경에 까치가 산다.
    await page.evaluate(([x, y, z]) => {
      const L = Math.hypot(x, z) || 1;
      const dx = -x / L, dz = -z / L;         // 원점 방향 단위벡터
      window.__aim(x + dx * 8 + 1.5, y + 0.8, z + dz * 8 + 1.5, x, y + 0.2, z);
    }, [p.x, p.y, p.z]);
    await page.evaluate(() => window.__advance(0.2));
    await save('critters-tree-snap');
    // 조금 더 물러난 컷(나무 전체 실루엣 위 까치)
    await page.evaluate(([x, y, z]) => {
      const L = Math.hypot(x, z) || 1;
      const dx = -x / L, dz = -z / L;
      window.__aim(x + dx * 15 + 4, y + 3.0, z + dz * 15 + 4, x, y - 2.0, z);
    }, [p.x, p.y, p.z]);
    await page.evaluate(() => window.__advance(0.2));
    await save('critters-tree-wide');
  } else {
    console.log('debugMagpieTree 없음 — 페르치 미구현?');
  }
  // 자연 전개: 제품 프레이밍에서 시뮬을 밀며 연속 캡처(나무 착지 포착)
  await open(`${base}/index.html?shot=1&env=1&preset=korea&angle=three-quarter&season=summer&time=day`);
  for (let k = 0; k < 5; k++) {
    await page.waitForTimeout(3500);
    await save(`critters-seq-${k}`);
  }
}

// ---------------- 회귀: 봄/여름 낮·밤·ink (harness — weather.js 의존 없음) ----------------
if (want('regress')) {
  const shots = [
    ['reg-spring-day', 'frame=tq&season=spring&time=day'],
    ['reg-summer-day', 'frame=tq&season=summer&time=day'],
    ['reg-night', 'frame=tq&season=summer&time=night'],
    ['reg-autumn-night', 'frame=tq&season=autumn&time=night'],
    ['reg-ink', 'frame=tq&season=autumn&time=day&mode=ink'],
  ];
  for (const [name, qs] of shots) {
    await open(`${base}/__amb?${qs}`);
    await save(name);
  }
  // 전체 앱 부팅 확인(창호 실내광 등 main.js 배선 포함) — 다른 에이전트가 깨뜨렸으면 스킵.
  for (const [name, qs] of [
    ['fullapp-night', 'env=1&preset=korea&angle=three-quarter&season=autumn&time=night'],
    ['fullapp-day', 'env=1&preset=korea&angle=three-quarter&season=autumn&time=day'],
  ]) {
    if (await tryOpen(`${base}/index.html?shot=1&${qs}`)) await save(name);
  }
}

await browser.close();
server.close();
