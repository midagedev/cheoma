// 헤드리스 스크린샷: 앰비언스 근접 링(#79) 검증 → shots/focus-*.png + scratchpad
// 사용법: node tools/shoot-focus.mjs
//
// env 독립 하네스(/__focus): buildParcel + createFocusRing 만 직접 import(앱/adapter 경로 우회).
//   전용 포트 4197. 사용자 dev(5174) 절대 미접촉.
//   window.__advance(secs)  : ring.update 를 0.05s 씩 밀어 페이드/애니 전진
//   window.__ringSet(which) : which='choga'|'hanok' 필지에 링 점등(교체)
//   window.__ringClear()    : 링 페이드아웃
//   window.__calls          : 마지막 프레임 렌더 드로우콜(renderer.info.render.calls)
//   window.__strength       : 활성 링 강도(0..1), window.__retiring: 페이드아웃 대기 수
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
const PORT = 4197;

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
// 넓은 지면(그림자 받이)
const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshStandardMaterial({ color: 0xb8b09a, roughness: 1 }));
ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);

// 두 필지: choga(원점, 굴뚝 연기·닭), hanok(x=60, 교체 테스트용). 이미 월드 배치 상태.
const parcels = {};
const choga = buildParcel({ style: 'choga', seed: 20260718 }); choga.position.set(0, 0, 0); scene.add(choga); parcels.choga = choga;
const hanok = buildParcel({ style: 'hanok', seed: 4242 }); hanok.position.set(60, 0, 0); scene.add(hanok); parcels.hanok = hanok;

const ring = createFocusRing(scene, { heightAt: () => 0, sun, renderer });

// 시간대 조명 프리셋(간이) — sunset 은 저고도 역광(모트 forward-scatter).
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
function aimChoga() { camera.position.set(2.5, 5.2, 20); camera.lookAt(0.5, 3.0, -1); }
function aimYard() { camera.position.set(9, 3.8, 9); camera.lookAt(1.5, 0.3, 3.4); }   // 마당 측면 부감(닭, 담 너머)
function aimHanok() { camera.position.set(62, 6.5, 26); camera.lookAt(60.5, 3.5, -1); }
function aimBoth() { camera.position.set(30, 22, 40); camera.lookAt(30, 2, 0); }
function aimRoof() { camera.position.set(7, 8.5, 15); camera.lookAt(0, 4.2, -1.5); }   // 지붕 적설/빗물 부감(choga)
function aimHanokRoof() { camera.position.set(69, 13, 20); camera.lookAt(60, 5.5, -2); }   // hanok 기와 지붕 부감
aimChoga();

// window.__wx 스텁(weather.js 노출 인터페이스 모사) — focus.js 가 이걸 직접 판독한다(#84).
window.__wx = { accum: 0, rain: 0, snow: 0, wet: 0, wind: null };
window.__setWx = (o) => Object.assign(window.__wx, o);

window.__advance = (secs) => { const n = Math.max(1, Math.round(secs / 0.05)); for (let i = 0; i < n; i++) ring.update(0.05, curTime); };
window.__ringSet = (which, radius) => ring.set({ group: parcels[which], radius: radius || 18, seed: which === 'choga' ? 20260718 : 4242 });
window.__ringClear = () => ring.clear();
window.__setTime = (name) => applyTime(name);
window.__aim = (mode) => { if (mode === 'hanok') aimHanok(); else if (mode === 'both') aimBoth(); else if (mode === 'yard') aimYard(); else if (mode === 'roof') aimRoof(); else if (mode === 'hanokRoof') aimHanokRoof(); else aimChoga(); };
window.__ring = ring;
window.__strength = () => ring.strength;
window.__retiring = () => ring.retiringCount;
// 적설 쉘/빗물 리벌릿 가시성(씬 직속 snowVolume/rainFlow group + 자식 메시 존재).
window.__snowVisible = () => { let v = false; scene.traverse((o) => { if (o.name === 'snowVolume' && o.visible && o.getObjectByName('snowShell')) v = true; }); return v; };
window.__rainVisible = () => { let v = false; scene.traverse((o) => { if (o.name === 'rainFlow' && o.visible && o.getObjectByName('rainRivulets')) v = true; }); return v; };
// 디버그: focusRing 컨테이너 구성 카운트 + 닭 무리 월드 위치(첫 개체).
window.__debug = () => {
  const rings = [];
  scene.traverse((o) => { if (o.name === 'focusRing') rings.push(o); });
  let animalsMesh = 0, sprites = 0, points = 0, firstChick = null;
  for (const r of rings) r.traverse((o) => {
    if (o.isSprite) sprites++;
    else if (o.isPoints) points++;
    else if (o.isMesh && o.parent && !o.isSprite) {
      // animals 서브그룹 안 메시만
      let p = o; let inAnimals = false;
      while (p) { if (p.name === 'animals') { inAnimals = true; break; } p = p.parent; }
      if (inAnimals) { animalsMesh++; if (!firstChick) { firstChick = new THREE.Vector3(); o.getWorldPosition(firstChick); } }
    }
  });
  const anim = rings[0] && rings[0].getObjectByName('animals');
  let yard = null;
  if (anim) { const c = anim.children[0]; if (c) { const v = new THREE.Vector3(); c.getWorldPosition(v); yard = { x: +v.x.toFixed(2), y: +v.y.toFixed(2), z: +v.z.toFixed(2) }; } }
  return { rings: rings.length, animalsMesh, sprites, points, spriteVisible: (() => { let n = 0; for (const r of rings) r.traverse((o) => { if (o.isSprite && o.visible && o.material.opacity > 0.001) n++; }); return n; })(), yard };
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
  const file = join(toShots ? OUT : SCRATCH, `${toShots ? 'focus-' : 'focus-'}${name}.png`);
  await page.screenshot({ path: file });
  console.log('saved', file);
}
const ev = (fn, ...a) => page.evaluate(fn, ...a);

// ============ 1) OFF vs ON (choga: 닭·연기·모트) ============
await open('day');
const callsOff = await ev('window.__calls');
await save('off-day');                                   // 링 미점등 baseline
await ev('window.__ringSet("choga")');
await ev('window.__advance(6)');                   // full strength 까지
const callsOn = await ev('window.__calls');
const strOn = await ev('window.__strength()');
const dbg = await ev('window.__debug()');
await save('on-day', true);                              // 게이트 증거(shots/)
console.log('DRAWCALLS off=%d on=%d delta=%d strength=%s', callsOff, callsOn, callsOn - callsOff, strOn);
console.log('DEBUG', JSON.stringify(dbg));
// 마당 근접(닭 가시 확인)
await ev('window.__aim("yard")');
await save('yard-closeup-day', true);
await ev('window.__aim()');   // choga 복귀

// ============ 2) 시간대 2종 (sunset) — off/on A/B ============
await open('sunset');
await save('off-sunset', true);                          // 링 미점등(모트·연기 없음)
await ev('window.__ringSet("choga")');
await ev('window.__advance(6)');
await save('on-sunset', true);                           // 모트 반짝·굴뚝 연기·불씨

// ============ 3) 크로스페이드 인 3단계 (sunset — 팟 아님, 점진 발현) ============
await open('sunset');
await ev('window.__ringSet("choga")');
await ev('window.__advance(1.3)');                 // delay 직후 초기(옅은 모트·연기)
const s1 = await ev('window.__strength()');
await save('fade-in-1', true);
await ev('window.__advance(1.2)');                 // 중간
const s2 = await ev('window.__strength()');
await save('fade-in-2', true);
await ev('window.__advance(5)');                   // 완충(full)
const s3 = await ev('window.__strength()');
await save('fade-in-3', true);
console.log('FADE-IN strengths s1=%s s2=%s s3=%s (점증=크로스페이드, 팟 아님)', s1.toFixed(2), s2.toFixed(2), s3.toFixed(2));

// ============ 4) set→clear 페이드아웃 + dispose ============
await open('sunset');
await ev('window.__ringSet("choga")');
await ev('window.__advance(6)');                   // full
await ev('window.__ringClear()');
await ev('window.__advance(0.6)');                 // 페이드아웃 중간(retiring 이 부분 강도)
const retMid = await ev('window.__retiring()');
await save('clear-mid', true);
console.log('CLEAR-MID retiring=%d (1=페이드아웃 중)', retMid);
await ev('window.__advance(5)');                   // 완전 소멸 + dispose
const retDone = await ev('window.__retiring()');
await save('clear-done');
console.log('CLEAR-DONE retiring=%d (0 이면 dispose 완료·누수 없음)', retDone);

// ============ 4) 재호출 교체 (choga→hanok, 크로스오버) ============
await open('day');
await ev('window.__ringSet("choga")');
await ev('window.__advance(6)');
await ev('window.__aim("both")');
await save('replace-before');
await ev('window.__ringSet("hanok")');                   // choga retiring, hanok in
await ev('window.__advance(0.6)');
const retX = await ev('window.__retiring()');
await save('replace-crossover');
console.log('REPLACE-CROSSOVER retiring=%d (choga 페이드아웃 중이면 1)', retX);
await ev('window.__advance(6)');
await ev('window.__aim("hanok")');
await save('replace-after');

// ============ 5) mid 페이드인(부분 강도, 팟 아님 확인) ============
await open('day');
await ev('window.__ringSet("choga")');
await ev('window.__advance(1.4)');                 // 게이트 delay 직후 상승 중
const strFadeIn = await ev('window.__strength()');
await save('fadein-mid');
console.log('FADEIN-MID strength=%s (0<s<1 이면 크로스페이드)', strFadeIn);

// ============ 6) 지붕 적설/빗물 오버레이 (#84, window.__wx 판독) ============
// 6a) 적설: 눈 없음(dormant) → 눈(accum·snow 주입) A/B. day 프레이밍은 지붕 부감.
await open('day');
await ev('window.__ringSet("choga")');
await ev('window.__advance(4)');                 // 앰비언스 정착(지붕 캡처)
await ev('window.__aim("roof")');
await save('wx-snow-off', true);                 // __wx=0 → 적설 dormant(지붕 맨 기와)
await ev('window.__setWx({ accum: 1, snow: 1 })');
await ev('window.__advance(3)');                 // 눈 쌓임 크로스페이드
const snowVis = await ev('window.__snowVisible()');
await save('wx-snow-on', true);                  // 지붕 눈 쉘 발현
console.log('WX-SNOW snowShell visible=%s', snowVis);
// 6b) dormant 복귀(눈 0) — 융설
await ev('window.__setWx({ accum: 0, snow: 0 })');
await ev('window.__advance(3)');
await save('wx-snow-melt');
// 6c) 빗물 리벌릿
await open('day');
await ev('window.__ringSet("choga")');
await ev('window.__advance(4)');
await ev('window.__aim("roof")');
await ev('window.__setWx({ rain: 1, wet: 1 })');
await ev('window.__advance(2)');
const rainVis = await ev('window.__rainVisible()');
await save('wx-rain-on', true);
console.log('WX-RAIN rivulets visible=%s', rainVis);
// 6d) ?snowvol=0 폴백 — 볼륨 미생성 확인
await page.goto(`${base}/__focus?time=day&snowvol=0`, { waitUntil: 'load' });
await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 30000 });
await ev('window.__ringSet("choga")');
await ev('window.__advance(4)');
await ev('window.__setWx({ accum: 1, snow: 1 })');
await ev('window.__advance(2)');
const volFallback = await ev('window.__snowVisible()');
console.log('WX-FALLBACK ?snowvol=0 snowShell visible=%s (false 여야 폴백 정상)', volFallback);

// 6e) 기와 지붕(hanok) 적설/빗물 — 볏짚 돔 대비 기왓골에 잘 읽히는 대조 컷
await open('day');
await ev('window.__ringSet("hanok")');
await ev('window.__advance(4)');
await ev('window.__aim("hanokRoof")');
await save('wx-hanok-dry');
await ev('window.__setWx({ accum: 0.6, snow: 1 })');   // 중간 적설(과하지 않게)
await ev('window.__advance(3)');
const hSnow = await ev('window.__snowVisible()');
await save('wx-hanok-snow', true);
await ev('window.__setWx({ accum: 0, snow: 0, rain: 1, wet: 1 })');
await ev('window.__advance(2.5)');
const hRain = await ev('window.__rainVisible()');
await save('wx-hanok-rain', true);
console.log('WX-HANOK snow=%s rain=%s', hSnow, hRain);

await browser.close();
server.close();
