// #99 히어로 종가 문/창 개구 검증. 코어(buildHanok) 직접 import 하네스 — 앱 dev 서버 불침해, 전용 포트 4214.
//   사용법: node tools/shoot-hanokface.mjs [필터]
//   CHEOMA_HANOKFACE_OUT=/절대/경로 로 throwaway 출력 위치를 지정할 수 있다.
//   컷: front(히어로 근접 정면) · grid(시드 스윕 8) · night(hanjiGlow 발광) · L(ㄱ자) · U(ㄷ자) · rect
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = process.env.CHEOMA_HANOKFACE_OUT || join(ROOT, 'shots');
mkdirSync(OUT, { recursive: true });
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };

const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>html,body{margin:0;height:100%;overflow:hidden;background:#0c0d10}#app{width:100%;height:100%}</style>
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.185.1/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.185.1/examples/jsm/"}}</script>
</head><body><div id="app"></div>
<script type="module">
import * as THREE from 'three';
import { buildHanok } from '/src/layout/hanok.js';
import { makeMaterials } from '/src/builder/palette.js';

const q = new URLSearchParams(location.search);
const view = q.get('view') || 'front';   // front | grid | night | L | U | rect
const time = q.get('time') || 'day';
const num = (k, d) => { const v = parseFloat(q.get(k)); return Number.isFinite(v) ? v : d; };

// 히어로 종가 ㄱ자 풋프린트(parcel.js hanok 분기와 동일) — x·z 중심 정렬.
function fpL() {
  const fp = [{x:-5,z:-2.6},{x:5,z:-2.6},{x:5,z:2.6},{x:-1.4,z:2.6},{x:-1.4,z:8},{x:-5,z:8}];
  const cx = fp.reduce((s,p)=>s+p.x,0)/fp.length, cz = fp.reduce((s,p)=>s+p.z,0)/fp.length;
  return fp.map((p)=>({x:p.x-cx,z:p.z-cz}));
}
// ㄷ자(안뜰 남향 개방): 본채 + 좌우 남향 날개.
function fpU() {
  const fp = [{x:-6,z:-3},{x:6,z:-3},{x:6,z:6},{x:2.5,z:6},{x:2.5,z:0},{x:-2.5,z:0},{x:-2.5,z:6},{x:-6,z:6}];
  const cx = fp.reduce((s,p)=>s+p.x,0)/fp.length, cz = fp.reduce((s,p)=>s+p.z,0)/fp.length;
  return fp.map((p)=>({x:p.x-cx,z:p.z-cz}));
}
function fpRect() { return [{x:-5,z:-3},{x:5,z:-3},{x:5,z:3},{x:-5,z:3}]; }

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight); renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.getElementById('app').appendChild(renderer.domElement);
const scene = new THREE.Scene();

const LT = {
  day:    { bg: 0xcdd7df, sun: [0xfff0dd, 2.7, [0.35,1.3,0.9]], hemi: [0xc4d6e8, 0x9a8c72, 1.15], exp: 1.05 },
  sunset: { bg: 0xe7b98f, sun: [0xffb066, 2.3, [0.4,0.8,1.0]], hemi: [0xd7b48c, 0x7a6a54, 0.95], exp: 1.0 },
  night:  { bg: 0x141a26, sun: [0x9fb4d8, 0.35, [0.4,1.0,0.8]], hemi: [0x2a3550, 0x14161c, 0.5], exp: 1.0 },
}[time] || {};
scene.background = new THREE.Color(LT.bg);
renderer.toneMappingExposure = LT.exp;
scene.fog = new THREE.Fog(LT.bg, 60, 160);

const sun = new THREE.DirectionalLight(LT.sun[0], LT.sun[1]);
sun.position.set(LT.sun[2][0]*30, LT.sun[2][1]*30, LT.sun[2][2]*30);
sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
const sc = sun.shadow.camera; sc.left=-30; sc.right=30; sc.top=30; sc.bottom=-30; sc.near=1; sc.far=120;
sun.shadow.bias=-0.0004; sun.shadow.normalBias=0.05; scene.add(sun);
scene.add(new THREE.HemisphereLight(LT.hemi[0], LT.hemi[1], LT.hemi[2]));

// 지면
const ground = new THREE.Mesh(new THREE.PlaneGeometry(400,400), new THREE.MeshStandardMaterial({color:0xb7a98d, roughness:1}));
ground.rotation.x = -Math.PI/2; ground.receiveShadow = true; scene.add(ground);

// #66 야간 창호광 재현(night-glow.js 계약과 동일: userData.hanjiGlow 태그 재질에 온기 emissive).
const WARM = new THREE.Color(0xffb35c);
function applyNightGlow(root) {
  root.traverse((o) => {
    const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
    for (const m of mats) {
      const base = m && m.userData ? m.userData.hanjiGlow : null;
      if (base == null) continue;
      m.emissive.copy(WARM);
      m.emissiveIntensity = base * 3.2;   // night-glow LIGHT_BASE 근사(창빛 가시화)
      m.emissiveMap = m.map || null;
      m.needsUpdate = true;
    }
  });
}

// 개구 감사: changho(문·창) 패널 존재·개수. buildHanok 이 doorN/winN 을 노출하지 않으므로
//   병합 메시 존재로 "개구 있음"만 판정하고, 시각(스크린샷)으로 최종 눈검사.
function auditOpenings(g) {
  let changho = null;
  g.traverse((o) => { if (o.name === 'changho') changho = o; });
  return { hasChangho: !!changho, tris: changho ? changho.geometry.index ? changho.geometry.index.count/3 : 0 : 0 };
}

function place(footprint, seed, mats) {
  const g = buildHanok({ footprint, seed, mats });
  return g;
}

function frameBox(g, camera, opt={}) {
  const box = new THREE.Box3().setFromObject(g);
  const c = box.getCenter(new THREE.Vector3());
  const s = box.getSize(new THREE.Vector3());
  const r = Math.max(s.x, s.z) * (opt.pad || 1.15);
  // 남(+z)에서 골든아워 사각(살짝 동측)으로 근접.
  const az = (opt.az ?? 22) * Math.PI/180, el = (opt.el ?? 16) * Math.PI/180;
  const dist = r / Math.tan((camera.fov*Math.PI/180)/2) * (opt.dist || 0.62);
  camera.position.set(
    c.x + Math.sin(az)*Math.cos(el)*dist,
    c.y + s.y*0.15 + Math.sin(el)*dist,
    c.z + Math.cos(az)*Math.cos(el)*dist + r*0.2);
  camera.lookAt(c.x, c.y + s.y*(opt.tf ?? 0.28), c.z);
}

const camera = new THREE.PerspectiveCamera(34, innerWidth/innerHeight, 0.1, 400);
let audit = {};

if (view === 'grid') {
  // 시드 스윕 8 — 같은 히어로 ㄱ 풋프린트로 seed 1..8 (개구 항상 발현 확인).
  const cols = 4, rows = 2, step = 20;
  const seeds = [1,2,3,4,5,6,7,8];
  audit.cells = [];
  seeds.forEach((seed, i) => {
    const mats = makeMaterials('hanok');
    const g = place(fpL(), seed, mats);
    const cx = (i % cols - (cols-1)/2) * step;
    const cz = (Math.floor(i/cols) - (rows-1)/2) * step;
    g.position.set(cx, 0, cz);
    scene.add(g);
    audit.cells.push({ seed, ...auditOpenings(g) });
  });
  // 부감 정면(남쪽 위에서 격자 전면 조망).
  camera.position.set(0, 46, 58);
  camera.lookAt(0, 3, 0);
} else {
  const fp = view === 'U' ? fpU() : view === 'rect' ? fpRect() : fpL();
  const seed = num('seed', 20260716);
  const mats = makeMaterials('hanok');
  const g = place(fp, seed, mats);
  scene.add(g);
  audit = auditOpenings(g);
  if (time === 'night') applyNightGlow(g);
  frameBox(g, camera, {
    az: num('az', view==='U'?8:22), el: num('el', view==='night'?12:16),
    dist: num('dist', view==='U'?0.72:0.62), pad: num('pad', 1.15),
  });
}

let frames = 0;
renderer.setAnimationLoop(() => {
  renderer.render(scene, camera); frames++;
  if (frames === 6) {
    const ri = renderer.info;
    window.__AUDIT = { ...audit, calls: ri.render.calls, tris: ri.render.triangles, mats: ri.memory ? undefined : undefined };
    window.__SHOT_READY = true;
  }
});
</script></body></html>`;

const server = createServer(async (req, res) => {
  const path = req.url.split('?')[0];
  if (path === '/__face') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE); return; }
  try {
    const file = join(ROOT, path === '/' ? 'index.html' : path);
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise((ok) => server.listen(4214, '127.0.0.1', ok));
const port = 4214;

const filter = process.argv[2] || '';
const tag = process.env.TAG || 'now';
const shots = [
  ['front-day', '/__face?view=front&time=day'],
  ['front-sunset', '/__face?view=front&time=sunset'],
  ['detail', '/__face?view=front&time=day&az=8&el=7&dist=0.40&pad=0.92'],
  ['grid', '/__face?view=grid&time=day'],
  ['night', '/__face?view=front&time=night'],
  ['L', '/__face?view=L&time=day&az=30&el=20&dist=0.7'],
  ['U', '/__face?view=U&time=day'],
  ['rect', '/__face?view=rect&time=day'],
].filter(([name]) => !filter || name.includes(filter));

let browser;
try { browser = await chromium.launch({ channel: 'chrome' }); }
catch { browser = await chromium.launch(); }
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
let pageErrs = 0, consoleErrs = 0;
page.on('console', (msg) => { if (msg.type()==='error') { const t=msg.text(); if(/favicon|404/.test(t))return; consoleErrs++; console.error('[console]', t); } });
page.on('pageerror', (err) => { pageErrs++; console.error('[pageerror]', err.message); });

for (const [name, qs] of shots) {
  await page.goto(`http://127.0.0.1:${port}${qs}`, { waitUntil: 'load' });
  try { await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 30000 }); }
  catch { console.error('TIMEOUT', name); }
  await page.waitForTimeout(200);
  const info = await page.evaluate(() => window.__AUDIT || null);
  console.log(name, JSON.stringify(info));
  const file = join(OUT, `hanokface-${tag}-${name}.png`);
  await page.screenshot({ path: file });
  console.log('saved', file);
}
console.log(`pageerror=${pageErrs} console-error=${consoleErrs}`);
await browser.close();
server.close();
