// 헤드리스 스크린샷: 먼지 모트 + 등롱 흔들림 검증 → shots/motes-*.png
// 사용법: node tools/shoot-motes.mjs [group]
//   group = backlight | drift | timecurve | ink | lantern | regress | all(기본)
//
// env 직접 import 하네스(/__motes): index.html 앱 경로(다른 에이전트가 자주 깨뜨림) 회피.
//   window.__advance(secs)       : env.update 를 0.05s 씩 밀어 모트 드리프트·등롱 요동 전진
//   window.__setWind(scale)      : getWind 전역 배율(무풍 0 · 강풍 비교)
//   window.__setTime(name)       : 시간대 전환(모트 강도·색·태양 방향)
//   window.__setInk(on)          : renderer.toneMapping 토글(ink 모드 감지 신호)
//   window.__aim(cx,cy,cz,tx,ty,tz) : 카메라 재조준
//   window.__motesVisible()      : dustMotes.visible (ink 게이트 확인)
//   window.__lanternPos()        : 등롱 bulb 월드 좌표 배열(요동 델타 측정)
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
env.setTime(timeOfDay);env.setSeason(q.get('season')||'summer',{immediate:true});env.setEnabled(true);
window.__env=env;
const frame=q.get('frame')||'tq';
const camera=new THREE.PerspectiveCamera(28,innerWidth/innerHeight,0.1,600);
const maxDim=Math.max(layout.W+4,layout.D+4,layout.totalH);
const target=new THREE.Vector3(0,layout.totalH*0.42,0);
const spots={front:{az:0,el:7,r:2.9},'tq':{az:38,el:13,r:3.0},side:{az:90,el:8,r:2.9}};
function place(){
  if(q.get('cx')!==null){camera.position.set(num('cx',12),num('cy',3),num('cz',6));target.set(num('tx',0),num('ty',1),num('tz',0));camera.lookAt(target);return;}
  const s=spots[frame]||spots.tq;const az=(num('az',s.az))*Math.PI/180,el=num('el',s.el)*Math.PI/180,r=s.r*maxDim;
  camera.position.set(target.x+r*Math.cos(el)*Math.sin(az),target.y+r*Math.sin(el),target.z+r*Math.cos(el)*Math.cos(az));
  camera.lookAt(target);
}
place();
window.__aim=(cx,cy,cz,tx,ty,tz)=>{camera.position.set(cx,cy,cz);target.set(tx,ty,tz);camera.lookAt(target);};
window.__setWind=(s)=>{window.__windScale=s;};
window.__setTime=(name)=>{env.setTime(name);};
window.__setInk=(on)=>{renderer.toneMapping=on?THREE.NoToneMapping:THREE.ACESFilmicToneMapping;};
window.__advance=(secs)=>{const n=Math.max(1,Math.round(secs/0.05));for(let i=0;i<n;i++)env.update(0.05);};
window.__motesVisible=()=>{const m=scene.getObjectByName('dustMotes');return m?m.visible:null;};
window.__boost=(k,szk)=>{const m=scene.getObjectByName('dustMotes');if(!m)return;m.material.uniforms.uIntensity.value*=k;if(szk){m.material.uniforms.uDustRadius.value*=szk;m.material.uniforms.uFireflyRadius.value*=szk;}};
window.__motesCount=()=>{const m=scene.getObjectByName('dustMotes');return m?m.geometry.instanceCount:null;};
window.__lanternPos=()=>{
  const envg=scene.getObjectByName('environment');const out=[];
  if(!envg)return out;
  for(const o of envg.children){
    if(o.isMesh&&o.geometry&&o.geometry.type==='SphereGeometry'&&o.geometry.parameters&&o.geometry.parameters.radius<0.5){
      out.push([+o.position.x.toFixed(4),+o.position.y.toFixed(4),+o.position.z.toFixed(4)]);
    }
  }
  return out;
};
let frames=0;
renderer.setAnimationLoop(()=>{
  renderer.render(scene,camera);
  frames++;if(frames===3){window.__advance(1.0);window.__SHOT_READY=true;}
});
</script></body></html>`;

const server = createServer(async (req, res) => {
  const path = req.url.split('?')[0];
  if (path === '/__motes') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(HTML); return; }
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
async function setTime(n) { await page.evaluate((x) => window.__setTime(x), n); }
async function setInk(on) { await page.evaluate((x) => window.__setInk(x), on); }
async function aim(a) { await page.evaluate((v) => window.__aim(...v), a); }
async function motesVisible() { return page.evaluate(() => window.__motesVisible()); }
async function lanternPos() { return page.evaluate(() => window.__lanternPos()); }
async function save(name, clip) {
  const file = join(OUT, `motes-${name}.png`);
  await page.screenshot(clip ? { path: file, clip } : { path: file });
  console.log('saved', file);
}
// 1~2px 모트 확인용 중앙 줌 크롭(물리 px 좌표 = logical*DPR2).
const CROP = { x: 380, y: 200, width: 520, height: 400 };
const want = (g) => GROUP === 'all' || GROUP === g;

// ---------------- 1) 역광 게이트: sunset 기본 tq(역광) vs 순광(sun 등 뒤) ----------------
if (want('backlight')) {
  await open(`${base}/__motes?preset=giwa&time=sunset&frame=tq`);
  await advance(1.0);
  await save('backlit-full');
  await save('backlit-crop', CROP);
  // 순광 비교: 카메라를 태양 근처 방위(az≈200)로 → 모트 forward 게이트 ≈0 (거의 안 보임)
  await open(`${base}/__motes?preset=giwa&time=sunset&frame=tq&az=200`);
  await advance(1.0);
  await save('frontlit-crop', CROP);
}

// ---------------- 2) 드리프트: 3초 간격 2컷(떠다님) ----------------
if (want('drift')) {
  await open(`${base}/__motes?preset=giwa&time=sunset&frame=tq`);
  await advance(1.0); await save('drift-a', CROP);
  await advance(3.0); await save('drift-b', CROP);
  // 강풍 거스트 쓸림
  await setWind(2.2); await advance(3.0); await save('drift-gust', CROP);
}

// ---------------- 3) 시간대 강도 커브: sunset > dawn > day > night ----------------
if (want('timecurve')) {
  await open(`${base}/__motes?preset=giwa&time=sunset&frame=tq`);
  for (const tm of ['sunset', 'dawn', 'day', 'night']) {
    await setTime(tm); await advance(1.0); await save(`time-${tm}`, CROP);
  }
}

// ---------------- 4) ink 모드: 모트 비표시 ----------------
if (want('ink')) {
  await open(`${base}/__motes?preset=giwa&time=sunset&frame=tq`);
  await advance(0.5);
  const vBefore = await motesVisible();
  await setInk(true); await advance(0.2);
  const vInk = await motesVisible();
  await save('ink-hidden', CROP);
  await setInk(false); await advance(0.2);
  const vAfter = await motesVisible();
  console.log('[ink] motesVisible pbr=', vBefore, ' ink=', vInk, ' pbr-again=', vAfter);
}

// ---------------- 5) 등롱 흔들림: 근접 컷 + 위치 델타 수치 ----------------
if (want('lantern')) {
  // 밤(등롱 밝음)에 corner 등롱 근접. 먼저 좌표 읽어 카메라를 맞춘다.
  await open(`${base}/__motes?preset=giwa&time=night&frame=tq`);
  await advance(0.2);
  const pos = await lanternPos();
  console.log('[lantern] bulbs=', JSON.stringify(pos));
  if (pos.length) {
    // x>0,z>0 코너 하나 선택(없으면 첫 번째)
    const corner = pos.find((p) => p[0] > 0 && p[2] > 0) || pos[0];
    const [bx, by, bz] = corner;
    // 등롱 근접 카메라(바깥에서 코너를 바라봄)
    await aim([bx + 3.2, by + 0.6, bz + 3.2, bx, by, bz]);
    await advance(0.2); await save('lantern-a');
    const p0 = await lanternPos();
    await advance(2.5); await save('lantern-b');
    const p1 = await lanternPos();
    await advance(2.5); await save('lantern-c');
    const p2 = await lanternPos();
    // 델타(cm) 리포트 — 미세해야 함
    const dcm = (a, b) => (Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) * 100).toFixed(2);
    console.log('[lantern] corner base=', JSON.stringify(corner));
    console.log('[lantern] |a->b| cm=', p0.map((p, i) => dcm(p, p1[i])).join(','));
    console.log('[lantern] |a->c| cm=', p0.map((p, i) => dcm(p, p2[i])).join(','));
    // 강풍 거스트 시 더 큰(그래도 작은) 요동
    await setWind(2.5); await advance(2.5);
    const pg = await lanternPos();
    console.log('[lantern] gust |a->g| cm=', p0.map((p, i) => dcm(p, pg[i])).join(','));
  }
}

// ---------------- diag) 격리 진단: 강도·크기 크게 올려 렌더/게이트 확인 ----------------
if (want('diag')) {
  // 하늘이 넓게 보이는 저각 프레임 + 강도 6x·크기 2x → 모트가 확실히 읽히는지
  await open(`${base}/__motes?preset=giwa&time=sunset&frame=tq&el=2`);
  const cnt = await page.evaluate(() => window.__motesCount());
  console.log('[diag] mote count=', cnt);
  await page.evaluate(() => window.__boost(6, 2));
  await advance(1.0);
  await save('diag-boost-full');
  await save('diag-boost-crop', { x: 100, y: 60, width: 900, height: 500 });
  // 순광(az=200) 동일 부스트 → 게이트로 여전히 어두운지
  await open(`${base}/__motes?preset=giwa&time=sunset&frame=tq&el=2&az=200`);
  await page.evaluate(() => window.__boost(6, 2));
  await advance(1.0);
  await save('diag-boost-frontlit', { x: 100, y: 60, width: 900, height: 500 });
}

// ---------------- 6) 회귀: 눈/비 씬 이물감·pageerror 0 ----------------
if (want('regress')) {
  for (const [name, qs] of [
    ['reg-sunset', 'preset=giwa&time=sunset&frame=tq'],
    ['reg-choga-dawn', 'preset=choga&time=dawn&frame=side'],
    ['reg-night', 'preset=giwa&time=night&frame=tq'],
  ]) {
    await open(`${base}/__motes?${qs}`);
    await advance(1.5); await save(name);
  }
}

await browser.close();
server.close();
