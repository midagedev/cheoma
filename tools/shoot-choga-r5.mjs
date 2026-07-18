// 헤드리스 스크린샷: 초가 R5 폴리시 + 아궁이 검증 → shots/choga-r5-*.png
// 사용법: NODE_PATH=/Users/hckim/repo/threesur/node_modules node tools/shoot-choga-r5.mjs [group]
//   group = choga | agungi | chimney | regress | all(기본)
//
// env 직접 import 하네스(/__cr5): index.html 앱 경로 회피(다른 에이전트가 자주 깨뜨림).
// 플래그십 룩(post.js) + 날씨(적설 0 고정) + 연기/불씨 전진을 실제 앱과 동일하게 배선.
//   window.__aim(cx,cy,cz,tx,ty,tz) : 카메라 재조준
//   window.__advance(secs)          : env.update 스텝(연기 컬럼 형성·불씨 일렁임)
//   window.__frameInfo()            : {W,D,totalH,xEave,zEave} 레이아웃 치수 반환
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
import { setupWeather } from '/src/env/weather.js';
import { setupPost } from '/src/env/post.js';
const q = new URLSearchParams(location.search);
const preset = q.get('preset') || 'choga';
const timeOfDay = q.get('time') || 'sunset';
const season = q.get('season') || 'summer';
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
weather.setWeather('clear',{immediate:true});
if(window.__wx)window.__wx.setAccum(0);   // "clear인데 적설" 버그 차단
window.__env=env;
const camera=new THREE.PerspectiveCamera(28,innerWidth/innerHeight,0.1,500);
const maxDim=Math.max(layout.W+4,layout.D+4,layout.totalH);
const target=new THREE.Vector3(0,layout.totalH*0.42,0);
// 프레임 프리셋: az(방위°) el(고도°) r(거리배율) ty(타겟높이배율)
const spots={
  front:{az:0,el:6,r:2.9,ty:0.42},
  tq:{az:38,el:13,r:3.0,ty:0.42},
  side:{az:90,el:9,r:2.9,ty:0.42},
  sidelow:{az:76,el:3,r:2.7,ty:0.40},
  roof:{az:32,el:44,r:2.5,ty:0.60},
  roofclose:{az:26,el:38,r:1.7,ty:0.72},
  eave:{az:22,el:-3,r:1.7,ty:0.30},
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
  if (path === '/__cr5') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(HTML); return; }
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
page.on('console', (msg) => { if (msg.type() === 'error') { console.error('[page]', msg.text()); } });
page.on('pageerror', (err) => { console.error('[pageerror]', err.message); errors.push(err.message); });

async function open(url) {
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 30000 });
}
async function advance(s) { await page.evaluate((x) => window.__advance(x), s); }
async function aim(a) { await page.evaluate((v) => window.__aim(...v), a); }
async function info() { return await page.evaluate(() => window.__frameInfo()); }
async function save(name, clip) {
  const file = join(OUT, `choga-r5-${name}.png`);
  await page.screenshot(clip ? { path: file, clip } : { path: file });
  console.log('saved', file);
}
const want = (g) => GROUP === 'all' || GROUP === g;

// ---------------- 1) 초가 부위별 (사진 대비 7건) ----------------
if (want('choga')) {
  const F = [
    ['front', 'day', null], ['tq', 'day', null],
    ['side', 'day', -90], ['sidelow', 'day', -108],   // -x 단부 프로파일(나무 회피)
    ['roof', 'day', null], ['roofclose', 'day', null], ['eave', 'day', null],
    ['tq', 'sunset', null],
  ];
  for (const [fr, t, az] of F) {
    const azq = az == null ? '' : `&az=${az}`;
    await open(`${base}/__cr5?preset=choga&frame=${fr}&time=${t}${azq}`);
    await save(`${fr}-${t}`);
  }
  // 근접 측면 프로파일(나무 링 안쪽에서 -x 단부 원뿔감) — __aim 직접 조준
  await open(`${base}/__cr5?preset=choga&frame=side&time=day&az=-90`);
  const L2 = await info();
  await aim([-(L2.W / 2 + 8.5), L2.totalH * 0.62, L2.D / 2 + 8.0, 0, L2.totalH * 0.40, 0]);
  await save('sideprofile-day');

  // 레이아웃 치수 출력(아궁이 좌표 산출용)
  await open(`${base}/__cr5?preset=choga&frame=tq&time=day`);
  console.log('LAYOUT', JSON.stringify(await info()));
}

// ---------------- 2) 아궁이 (주간 + 야간 불씨) ----------------
if (want('agungi')) {
  // 아궁이는 부엌 끝(+x)면 하부(x≈W/2+0.5, z≈-0.25, 화구 y≈0.34) — 근접 조준.
  for (const t of ['day', 'night', 'sunset']) {
    await open(`${base}/__cr5?preset=choga&frame=side&time=${t}`);
    const L = await info();
    const ex = L.W / 2 + 0.55; // 화구 전면(+x) 대략 x
    await aim([ex + 2.4, 1.55, 1.7, ex - 0.15, 0.45, -0.25]);
    await advance(2.0);
    await save(`agungi-${t}`);
  }
}

// ---------------- 3) 굴뚝 연기 유지 (sunset) ----------------
if (want('chimney')) {
  await open(`${base}/__cr5?preset=choga&frame=tq&time=sunset`);
  const L = await info();
  // 후면 처마 밖 +x 코너 굴뚝(x≈W/2-0.45, z≈-(D/2+xEave-...)) — 뒤에서 넓게 조준해 연기 컬럼 확보.
  const cz = -L.zEave - 0.28;                       // 굴뚝 z(후면 처마 밖)
  const ccx = L.W / 2 - 0.45;                       // 굴뚝 x
  // 측후면에서 굴뚝+연기 컬럼을 하늘 대비로 — 타겟을 컬럼 중간 높이로 올려 상승 확인.
  await aim([ccx - 6.5, 4.6, cz - 5.5, ccx, 4.6, cz]);
  await advance(3.0);
  await save('chimney-sunset-a');
  await advance(3.5);
  await save('chimney-sunset-b');
}

// ---------------- 4) 회귀 (궁·절·기와 각 1컷) ----------------
if (want('regress')) {
  for (const p of ['korea', 'temple', 'giwa']) {
    await open(`${base}/__cr5?preset=${p}&frame=tq&time=day`);
    await save(`regress-${p}`);
  }
}

await browser.close();
server.close();
console.log(errors.length ? `\nTOTAL PAGEERRORS: ${errors.length}` : '\nNO PAGEERRORS');
for (const e of errors) console.log(' -', e);
