// 헤드리스 스크린샷: focus 링 바람 풀(#90) 검증 → shots/grass-*.png + scratchpad
// 사용법: NODE_PATH=/Users/hckim/repo/threesur/node_modules node tools/shoot-grass.mjs
//
// shoot-focus(/__focus) 구조 재활용, 전용 포트 4204(사용자 dev 5174·다른 하네스 4197 미접촉).
//   window.__advance(secs)      : ring.update 를 0.05s 씩 전진(페이드/흔들림)
//   window.__ringSet(which,r)   : 'choga'|'hanok' 필지에 링 점등
//   window.__ringSeason(s)      : 풀 계절 크로스페이드(spring|summer|autumn|winter)
//   window.__grassVisible(v)    : focusGrass 메시 가시 토글(off/on A/B·드로우콜 격리)
//   window.__windScale(v)       : window.__windScale 세팅(0=무풍, >1=강풍 — sway 진폭)
//   window.__calls              : 마지막 프레임 렌더 드로우콜
//   window.__grassInfo()        : { instances, triangles, present }
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
const PORT = 4204;

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
const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshStandardMaterial({ color: 0xb8b09a, roughness: 1 }));
ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);

const parcels = {};
const choga = buildParcel({ style: 'choga', seed: 20260718 }); choga.position.set(0, 0, 0); scene.add(choga); parcels.choga = choga;
const hanok = buildParcel({ style: 'hanok', seed: 4242 }); hanok.position.set(60, 0, 0); scene.add(hanok); parcels.hanok = hanok;

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
const q = new URLSearchParams(location.search);
applyTime(q.get('time') || 'day');

const camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, 0.1, 600);
// choga(원점) 마당 안 저각 — sunset 은 -x/-z 저고도 태양(북서). SE 코너에서 NW 로 가로질러 봐
// 전경 담장 밑 풀이 역광 림을 받는다.
function aimGrass() { camera.position.set(6.4, 1.5, 6.6); camera.lookAt(-1.0, 0.7, -1.5); }
function aimGrassWide() { camera.position.set(9, 3.4, 10); camera.lookAt(0, 0.5, -1); }
function aimYard() { camera.position.set(9, 3.8, 9); camera.lookAt(1.5, 0.3, 3.4); }
function aimChoga() { camera.position.set(2.5, 5.2, 20); camera.lookAt(0.5, 3.0, -1); }
function aimHanok() { camera.position.set(66, 2.2, 16); camera.lookAt(58, 0.8, -2); }
function aimTop() { camera.position.set(0.5, 26, 2); camera.lookAt(0, 0, -0.5); }   // 배치 부감(동선·발자국 비움 확인)
aimGrass();

window.__advance = (secs) => { const n = Math.max(1, Math.round(secs / 0.05)); for (let i = 0; i < n; i++) ring.update(0.05, curTime); };
window.__ringSet = (which, radius) => ring.set({ group: parcels[which], radius: radius || 18, seed: which === 'choga' ? 20260718 : 4242 });
window.__ringClear = () => ring.clear();
window.__ringSeason = (s) => ring.setSeason(s);
window.__setTime = (name) => applyTime(name);
// wind.js 는 window.__windScale(number)를 판독한다 → 값으로 세팅(무풍 0 · 강풍 >1).
window.__setWind = (v) => { window.__windScale = v; };
window.__aim = (mode) => {
  if (mode === 'wide') aimGrassWide(); else if (mode === 'yard') aimYard(); else if (mode === 'choga') aimChoga();
  else if (mode === 'hanok') aimHanok(); else if (mode === 'top') aimTop(); else aimGrass();
};
window.__grassMesh = () => { let g = null; scene.traverse((o) => { if (o.name === 'focusGrass') g = o; }); return g; };
window.__grassVisible = (v) => { const g = window.__grassMesh(); if (g) g.visible = !!v; };
window.__grassInfo = () => {
  const g = window.__grassMesh();
  if (!g) return { present: false };
  return { present: true, visible: g.visible, instances: g.count, triangles: (g.geometry.index ? g.geometry.index.count / 3 : 0) * g.count };
};
// 드로우콜 격리: 동일 프레임을 grass off/on 으로 연속 동기 렌더(다른 시스템 미전진) → 순수 delta.
window.__measureGrass = () => {
  const g = window.__grassMesh();
  if (!g) return { off: 0, on: 0, delta: 0 };
  g.visible = false; renderer.render(scene, camera); const off = renderer.info.render.calls;
  g.visible = true;  renderer.render(scene, camera); const on = renderer.info.render.calls;
  return { off, on, delta: on - off };
};
window.__strength = () => ring.strength;

let frames = 0;
renderer.setAnimationLoop(() => {
  renderer.render(scene, camera);
  window.__calls = renderer.info.render.calls;
  frames++; if (frames === 3) window.__SHOT_READY = true;
});
</script></body></html>`;

const server = createServer(async (req, res) => {
  const path = req.url.split('?')[0];
  if (path === '/__focus') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(HTML); return; }
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

async function open(time) {
  await page.goto(`${base}/__focus?time=${time || 'day'}`, { waitUntil: 'load' });
  await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 30000 });
}
async function save(name, toShots = false) {
  const file = join(toShots ? OUT : SCRATCH, `grass-${name}.png`);
  await page.screenshot({ path: file });
  console.log('saved', file);
}
const ev = (fn, ...a) => page.evaluate(fn, ...a);

// ============ 1) 머니샷: sunset 역광 풀 off/on + 드로우콜 격리 ============
await open('sunset');
await ev('window.__setWind(1.1)');
await ev('window.__ringSet("choga")');
await ev('window.__advance(6)');                 // full strength(풀 grow-in 완료)
await ev('window.__aim("grass")');               // 저각 역광
await ev('window.__advance(0.1)');
const info = await ev('window.__grassInfo()');
const dc = await ev('window.__measureGrass()');  // 동기 이중렌더 격리
await ev('window.__grassVisible(false)');
await save('sunset-off', true);
await ev('window.__grassVisible(true)');
await save('sunset-on', true);
console.log('GRASS INFO', JSON.stringify(info));
console.log('DRAWCALLS grass off=%d on=%d delta=%d (동기 이중렌더 격리)', dc.off, dc.on, dc.delta);

// ============ 2) 흔들림 연속 3프레임(위상차 가시) — 강풍 ============
await open('sunset');
await ev('window.__setWind(1.6)');
await ev('window.__ringSet("choga")');
await ev('window.__advance(6)');
await ev('window.__aim("grass")');
await ev('window.__advance(0.3)'); await save('sway-1', true);
await ev('window.__advance(0.45)'); await save('sway-2', true);
await ev('window.__advance(0.45)'); await save('sway-3', true);
console.log('SWAY 3프레임(0.3/0.75/1.2s) — 위상차로 블레이드 기울기 변화');

// ============ 3) 무풍 vs 강풍(진폭 대조) ============
await open('sunset');
await ev('window.__setWind(0)');
await ev('window.__ringSet("choga")');
await ev('window.__advance(6)');
await ev('window.__aim("grass")');
await save('calm');
await ev('window.__setWind(1.8)');
await ev('window.__advance(1.0)');
await save('windy');
console.log('CALM vs WINDY — windScale 0 → 1.8');

// ============ 4) 계절 2종(summer/autumn) ============
await open('day');
await ev('window.__ringSet("choga")');
await ev('window.__advance(6)');
await ev('window.__aim("wide")');
await save('season-summer', true);               // 기본(초록)
await ev('window.__ringSeason("autumn")');
await ev('window.__advance(3)');                  // 색 크로스페이드
await save('season-autumn', true);                // 금빛
await ev('window.__ringSeason("winter")');
await ev('window.__advance(3)');
await save('season-winter');                      // 마른 짚
console.log('SEASONS summer/autumn/winter');

// ============ 5) 배치 검수: day 부감(동선·발자국·마당 중심 비움) ============
await open('day');
await ev('window.__ringSet("choga")');
await ev('window.__advance(6)');
await ev('window.__aim("top")');
await save('place-top', true);
await ev('window.__aim("yard")');
await save('place-yard', true);
console.log('PLACEMENT top/yard — 담장 밑 몰림, 중앙 동선·발자국 비움 확인');

// ============ 6) hanok(큰 필지) 저각 ============
await open('sunset');
await ev('window.__setWind(1.1)');
await ev('window.__ringSet("hanok")');
await ev('window.__advance(6)');
await ev('window.__aim("hanok")');
const hinfo = await ev('window.__grassInfo()');
await save('hanok-sunset', true);
console.log('HANOK grass', JSON.stringify(hinfo));

// ============ 7) 크로스페이드 grow-in(팟 아님) ============
await open('sunset');
await ev('window.__setWind(0.8)');
await ev('window.__ringSet("choga")');
await ev('window.__aim("grass")');
await ev('window.__advance(1.2)'); const g1 = await ev('window.__strength()'); await save('growin-1');
await ev('window.__advance(1.0)'); const g2 = await ev('window.__strength()'); await save('growin-2');
await ev('window.__advance(5)'); const g3 = await ev('window.__strength()'); await save('growin-3');
console.log('GROW-IN strengths %s %s %s (점증=크로스페이드, 팟 아님)', g1.toFixed(2), g2.toFixed(2), g3.toFixed(2));

await browser.close();
server.close();
