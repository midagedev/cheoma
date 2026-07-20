// 헤드리스 스크린샷: hanok(종가) 굴뚝 #82 검증 → shots/chimney-*.png + scratchpad
// 사용법: node tools/shoot-chimney.mjs
//
// shoot-focus.mjs(#79 /__focus) 구조 재활용. 전용 포트 4199, 사용자 dev 미접촉.
//   buildParcel(hanok) + createFocusRing 만 직접 import(앱/adapter 우회).
//   window.__advance(secs)   : ring.update 를 0.05s 씩 밀어 연기 발현 전진
//   window.__ringSet()       : hanok 필지에 focus 링 점등(연기·앰비언스)
//   window.__setTime(name)   : day|sunset|night|dawn 조명 프리셋
//   window.__aim(mode)       : 3q|close|smoke|aerial 카메라
//   window.__calls           : 마지막 프레임 드로우콜
//   window.__chimney()       : name='chimney' 탐지·bbox·처마 대비 이격 판정(굴뚝 anchor 검증)
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'shots');
const SCRATCH = '/private/tmp/claude-501/-Users-hckim-repo-asiahouse/7a15478e-68e3-4ad3-b08a-bdb86ae4fe92/scratchpad';
mkdirSync(OUT, { recursive: true });
mkdirSync(SCRATCH, { recursive: true });
const PORT = 4199;

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };

const HTML = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>html,body{margin:0;height:100%;overflow:hidden;background:#c7d0d8}#app{width:100%;height:100%}</style>
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.185.1/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.185.1/examples/jsm/"}}</script>
</head><body><div id="app"></div>
<script type="module">
import * as THREE from 'three';
import { buildParcel } from '/src/layout/parcel.js';
import { createFocusRing } from '/src/env/focus.js';

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight); renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
document.getElementById('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xc7d0d8);
const sun = new THREE.DirectionalLight(0xfff0dd, 2.6); sun.position.set(20, 40, 12); sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048); sun.shadow.camera.left = -40; sun.shadow.camera.right = 40;
sun.shadow.camera.top = 40; sun.shadow.camera.bottom = -40; sun.shadow.camera.far = 200; sun.shadow.normalBias = 0.05;
scene.add(sun);
const hemi = new THREE.HemisphereLight(0xbdd0e4, 0x8a7a63, 0.9); scene.add(hemi);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), new THREE.MeshStandardMaterial({ color: 0xb8b09a, roughness: 1 }));
ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);

const q = new URLSearchParams(location.search);

// 단독 hanok 필지(굴뚝 검수·연기 게이트) + 부감용 3x3 그리드 필지(무회귀 확인)
const hanok = buildParcel({ style: 'hanok', seed: 4242 }); scene.add(hanok);
const gridGroup = new THREE.Group(); gridGroup.visible = false; scene.add(gridGroup);
if (q.get('grid') === '1') {
  gridGroup.visible = true; hanok.visible = false;
  const seeds = [11, 22, 33, 44, 55, 66, 77, 88, 99];
  let k = 0;
  for (let iz = -1; iz <= 1; iz++) for (let ix = -1; ix <= 1; ix++) {
    const p = buildParcel({ style: 'hanok', seed: seeds[k++] }); p.position.set(ix * 30, 0, iz * 28); gridGroup.add(p);
  }
}

const ring = createFocusRing(scene, { heightAt: () => 0, sun, renderer });

const TIMES = {
  day:    { sun: [20, 40, 12], sunC: 0xfff0dd, sunI: 2.6, hemiI: 0.9, bg: 0xc7d0d8 },
  sunset: { sun: [-6, 7, -26], sunC: 0xffb877, sunI: 2.9, hemiI: 0.55, bg: 0xd8b58c },
  night:  { sun: [-10, 9, -20], sunC: 0x8ea2c8, sunI: 0.5, hemiI: 0.35, bg: 0x2a3550 },
  dawn:   { sun: [-8, 8, -24], sunC: 0xffe0c0, sunI: 2.2, hemiI: 0.6, bg: 0xcabfb8 },
};
let curTime = 'day';
function applyTime(name) {
  const p = TIMES[name] || TIMES.day; curTime = name;
  sun.position.set(p.sun[0], p.sun[1], p.sun[2]); sun.color.setHex(p.sunC); sun.intensity = p.sunI;
  hemi.intensity = p.hemiI; scene.background.setHex(p.bg);
}
applyTime(q.get('time') || 'day');

// 굴뚝 월드 위치(단독 필지)
function chimneyObj() { let c = null; hanok.traverse((o) => { if (o.name === 'chimney') c = o; }); return c; }
function chimneyCenter() {
  const c = chimneyObj(); if (!c) return new THREE.Vector3(-6.9, 3.2, 0.6);
  const b = new THREE.Box3().setFromObject(c); return b.getCenter(new THREE.Vector3());
}

const camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, 0.1, 800);
function aim3q() { camera.position.set(-17, 8.5, 17); camera.lookAt(-3.5, 4.0, 0); }       // 서남 3/4(굴뚝 실루엣·처마 밖)
function aimClose() { const c = chimneyCenter(); camera.position.set(c.x - 0.5, c.y + 1.6, c.z + 5.4); camera.lookAt(c.x + 0.2, c.y + 0.2, c.z - 0.3); }
function aimSmoke() { const c = chimneyCenter(); camera.position.set(c.x - 12, c.y + 1.5, c.z + 8); camera.lookAt(c.x + 1.5, c.y + 3.2, c.z - 0.5); }
function aimAerial() { camera.position.set(0, 70, 62); camera.lookAt(0, 0, 0); }
aim3q();

window.__advance = (secs) => { const n = Math.max(1, Math.round(secs / 0.05)); for (let i = 0; i < n; i++) ring.update(0.05, curTime); };
window.__ringSet = () => ring.set({ group: hanok, radius: 20, seed: 4242 });
window.__setTime = (name) => applyTime(name);
window.__aim = (mode) => { if (mode === 'close') aimClose(); else if (mode === 'smoke') aimSmoke(); else if (mode === 'aerial') aimAerial(); else aim3q(); };
window.__calls = 0;
// 굴뚝 탐지·bbox·처마 대비 이격(연기 anchor 검증). smoke.js 는 anchor = bbox 중심 x/z + top.y+0.15.
window.__chimney = () => {
  const c = chimneyObj();
  if (!c) return { found: false };
  const cb = new THREE.Box3().setFromObject(c);
  const anchorX = (cb.min.x + cb.max.x) / 2, anchorY = cb.max.y + 0.15;
  // hanok 몸채 그룹의 footprint(로컬)+월드 x 로 서측 처마선(eave) 산출
  let hb = null; hanok.traverse((o) => { if (o.name === 'hanok') hb = o; });
  let eaveWestX = -6.15;
  if (hb && hb.userData && hb.userData.footprint) {
    const wp = new THREE.Vector3(); hb.getWorldPosition(wp);
    const fpMinX = Math.min(...hb.userData.footprint.map((p) => p.x));
    eaveWestX = wp.x + fpMinX - 1.15;
  }
  return {
    found: true,
    chimneyMaxX: +cb.max.x.toFixed(2), chimneyTopY: +cb.max.y.toFixed(2),
    anchorX: +anchorX.toFixed(2), eaveWestX: +eaveWestX.toFixed(2),
    // 연기 anchor(bbox 중심 x)가 처마 서단보다 바깥(더 작은 x)이면 처마 밖 → 상승 연기 무간섭
    anchorClearsEave: anchorX < eaveWestX,
    anchorClearanceM: +(eaveWestX - anchorX).toFixed(2),
    smokeAnchorY: +anchorY.toFixed(2),
  };
};

let frames = 0;
renderer.setAnimationLoop(() => {
  renderer.render(scene, camera);
  window.__calls = renderer.info.render.calls;
  frames++; if (frames === 3) window.__SHOT_READY = true;
});
</script></body></html>`;

const server = createServer(async (req, res) => {
  const path = req.url.split('?')[0];
  if (path === '/__chimney') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(HTML); return; }
  try {
    const file = join(ROOT, path);
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise((ok) => server.listen(PORT, '127.0.0.1', ok));
const base = `http://127.0.0.1:${PORT}`;

let browser;
try { browser = await chromium.launch({ channel: 'chrome' }); } catch { browser = await chromium.launch(); }
const page = await browser.newPage({ viewport: { width: 1280, height: 800, deviceScaleFactor: 2 } });
page.on('console', (m) => { if (m.type() === 'error') console.error('[page]', m.text()); });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));

async function open(query) {
  await page.goto(`${base}/__chimney?${query || ''}`, { waitUntil: 'load' });
  await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 30000 });
}
async function save(name, toShots = false) {
  const file = join(toShots ? OUT : SCRATCH, `chimney-${name}.png`);
  await page.screenshot({ path: file });
  console.log('saved', file);
}
const ev = (fn, ...a) => page.evaluate(fn, ...a);

// ============ 1) 단독 hanok 3/4 (굴뚝 실루엣·처마 밖 이격) ============
await open('time=day');
const info = await ev('window.__chimney()');
console.log('CHIMNEY', JSON.stringify(info));
const callsBase = await ev('window.__calls');
await save('3q-day', true);
await ev('window.__aim("close")');
await save('closeup-day', true);
const callsClose = await ev('window.__calls');
console.log('DRAWCALLS 3q=%d close=%d', callsBase, callsClose);

// ============ 2) 굴뚝 클로즈업 sunset (전돌·연가·기와 갓 톤) ============
await open('time=sunset');
await ev('window.__aim("close")');
await save('closeup-sunset', true);

// ============ 3) focus 링 연기 발현 (sunset) — 굴뚝에서 발원 확인 ============
await open('time=sunset');
await ev('window.__aim("smoke")');
await save('smoke-off', false);                 // baseline(연기 전)
await ev('window.__ringSet()');
await ev('window.__advance(6)');                // full strength
await save('smoke-on-sunset', true);            // 게이트: 연기 굴뚝 발원
// 낮에도 확인(연기 미약하지만 있어야)
await open('time=dawn');
await ev('window.__aim("smoke")');
await ev('window.__ringSet()');
await ev('window.__advance(6)');
await save('smoke-on-dawn', true);

// ============ 4) 마을 부감 무회귀 (3x3 hanok 그리드 — 굴뚝 과하지 않게) ============
await open('time=day&grid=1');
await ev('window.__aim("aerial")');
await save('aerial-grid-day', true);
await open('time=sunset&grid=1');
await ev('window.__aim("aerial")');
await save('aerial-grid-sunset', true);

await browser.close();
server.close();
