// 헤드리스 검증(태스크 #60): 원경 창불 발광 포인트 + 황혼 점등.
//   → 기본 출력 scratchpad/vnight/ (반복), VNIGHT_OUT=shots 로 최종 게이트 증거(vnight-*.png).
// 앱 전경로 재현(shoot-village-light.mjs 준용): scene sun/hemi → setupEnvironment(sky.apply) →
//   setupPost → createVillage → enterVillageMode → setTime → post.composer.render.
//   매 프레임 villageHandle.update(dt) → adapter.stepNightGlow 가 vnight 크로스페이드 →
//   updateNightLights(dt, vnight) 로 발광 포인트 점등 다이얼 정합.
//
// 모드:
//   기본: time 컷을 warmup 후 캡처(스냅 진입이라 즉시 목표).
//   cross=from-to: from 으로 진입→warmup, 스위치 후 crossAt 프레임에서 캡처(크로스페이드 중간 프레임).
//   결정론: 같은 URL 2회 스크린샷 버퍼 해시 비교.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = process.env.VNIGHT_OUT
  ? (process.env.VNIGHT_OUT === 'shots' ? join(ROOT, 'shots') : resolve(process.env.VNIGHT_OUT))
  : '/private/tmp/claude-501/-Users-hckim-repo-asiahouse/7a15478e-68e3-4ad3-b08a-bdb86ae4fe92/scratchpad/vnight';
const PREFIX = process.env.VNIGHT_OUT === 'shots' ? 'vnight-' : '';
mkdirSync(OUT, { recursive: true });

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json',
};

const HTML = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>html,body{margin:0;height:100%;overflow:hidden;background:#000}#app{width:100%;height:100%}</style>
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.185.1/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.185.1/examples/jsm/"}}</script>
</head><body><div id="app"></div>
<script type="module">
import * as THREE from 'three';
import { computeLayout, PRESETS } from '/src/params.js';
import { setupEnvironment } from '/src/env/index.js';
import { setupPost } from '/src/env/post.js';
import { createVillage } from '/src/village/adapter.js';

const q = new URLSearchParams(location.search);
const scale = q.get('scale') || 'village';
const seedRaw = q.get('seed');
const seed = seedRaw != null ? (isNaN(+seedRaw) ? seedRaw : +seedRaw) : 20260716;
const includePalace = q.get('palace') === '1';
const includeTemple = q.get('temple') === '1';
const character = q.get('char') || 'yeoyeom';
const view = q.get('view') || 'aerial';
const time = q.get('time') || 'sunset';
const cross = q.get('cross') || '';              // 'day-night' 등
const crossAt = parseInt(q.get('crossAt') || '14', 10);
const num = (k, d) => { const v = parseFloat(q.get(k)); return Number.isFinite(v) ? v : d; };

// 결정론: seed xorshift 로 Math.random 고정(shoot-village-light 준용).
{ let s = 0x2545f491 >>> 0; Math.random = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
document.getElementById('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xcfd8e0);
scene.fog = new THREE.Fog(0xcfd8e0, 60, 220);

const sun = new THREE.DirectionalLight(0xfff0dd, 2.6);
sun.position.set(30, 42, 26);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -22; sun.shadow.camera.right = 22;
sun.shadow.camera.top = 22; sun.shadow.camera.bottom = -22;
sun.shadow.bias = -0.0001; sun.shadow.normalBias = 0.05;
scene.add(sun);
const hemi = new THREE.HemisphereLight(0xbdd0e4, 0x8a7a63, 0.9);
scene.add(hemi);

const ground = new THREE.Mesh(
  new THREE.CircleGeometry(160, 48),
  new THREE.MeshStandardMaterial({ color: 0xb5a893, roughness: 1 }));
ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true;
scene.add(ground);

const camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, 0.1, 500);

const env = setupEnvironment(scene, { sun, hemi, renderer, layout: computeLayout(PRESETS.korea) });
const post = setupPost({ renderer, scene, camera });
post.setSize(innerWidth, innerHeight);
const startTime = cross ? cross.split('-')[0] : time;
const endTime = cross ? cross.split('-')[1] : time;
// setTime 을 setEnabled 앞에 두면 enabled=false 라 currentTime 만 기록 → setEnabled(true) 가
//   sky.apply(startTime, immediate) 로 즉시 스냅(낮→밤 tween 대기 없이 목표 시간대로 착지).
env.setTime(startTime);
env.setEnabled(true);
post.setTime(startTime);

const villageHandle = createVillage({ scale, seed, includePalace, includeTemple, character });
villageHandle.enterVillageMode({ scene, building: null, ground, env });
villageHandle.setTime(startTime);

// 드로우콜 증분 실측용: nl=0 이면 물리 창불 batch를 강제 은닉(같은 씬 delta 계측).
if (q.get('nl') === '0') { villageHandle.group.traverse((o) => { if (o.name === 'nightlight-physical') o.userData._forceHide = true; }); }

const R = villageHandle.plan.site.R;
if (scene.fog) { scene.fog.near = R * 2.2; scene.fog.far = R * 7.0; }
camera.far = R * 8; camera.near = 0.5;
camera.updateProjectionMatrix();
window.__PLAN = { scale, seed, R, stats: villageHandle.plan.stats, time, cross };

let campos, target, fov;
if (view === 'aerial') {
  fov = 42;
  campos = new THREE.Vector3(0.20 * R, 1.02 * R, 1.98 * R);
  target = new THREE.Vector3(0, 0.06 * R, -0.10 * R);
} else {
  const camZ = villageHandle.plan.site.streamZ + R * 0.34;
  const gy = villageHandle.plan.site.heightAt(R * 0.04, camZ);
  fov = 52;
  campos = new THREE.Vector3(R * 0.04, gy + 2.4, camZ);
  target = new THREE.Vector3(0, villageHandle.plan.site.heightAt(0, 0) + 5, 0);
}
camera.fov = num('fov', fov);
camera.position.set(num('cx', campos.x), num('cy', campos.y), num('cz', campos.z));
camera.lookAt(num('tx', target.x), num('ty', target.y), num('tz', target.z));
camera.updateProjectionMatrix();

// 발광 포인트 점등 판정: 화면에서 additive 웜(붉은기>청기) 픽셀 수·최대 휘도.
function computeGlowStats() {
  const cvs = renderer.domElement;
  const w = cvs.width, h = cvs.height;
  const c2 = document.createElement('canvas'); c2.width = w; c2.height = h;
  const ctx = c2.getContext('2d');
  ctx.drawImage(cvs, 0, 0);
  const data = ctx.getImageData(0, 0, w, h).data;
  let warmPx = 0, maxL = 0, sumL = 0, npx = w * h;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const L = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    sumL += L; if (L > maxL) maxL = L;
    // 창불: 밝고 따뜻(R>B 뚜렷), 임계 이상.
    if (L > 0.42 && r > b + 26 && r > 120) warmPx++;
  }
  return { warmPx, warmPct: +(100 * warmPx / npx).toFixed(3), maxL: +maxL.toFixed(3), meanL: +(sumL / npx).toFixed(3) };
}

// 결정론 판정: 물리 창불 instance 버퍼 해시 — GPU 비결정(AA) 무관하게 점등 패턴 동일성 검증.
function nlHash() {
  let batch = null;
  villageHandle.group.traverse((o) => { if (o.name === 'nightlight-physical') batch = o; });
  if (!batch) return 'none';
  const g = batch.geometry;
  let h = 2166136261 >>> 0;
  for (const k of ['aAnchor', 'aOutward', 'aOpeningSize', 'aPhase', 'aLit', 'aThreshold', 'aWarm']) {
    const a = g.attributes[k] && g.attributes[k].array; if (!a) continue;
    for (let i = 0; i < a.length; i++) { h ^= Math.round(a[i] * 1000) | 0; h = Math.imul(h, 16777619) >>> 0; }
  }
  return (h >>> 0).toString(16) + ':n' + g.instanceCount;
}

let frame = 0;
const switchFrame = 10;                       // warmup 후 스위치(cross)
const captureFrame = cross ? switchFrame + crossAt : 18;
renderer.setAnimationLoop(() => {
  if (cross && frame === switchFrame) { env.setTime(endTime); post.setTime(endTime); villageHandle.setTime(endTime); }
  env.update(1 / 60);                          // 시간대 크로스페이드(cross) + fog 합성 정합
  villageHandle.update(1 / 60);                // adapter.stepNightGlow → updateNightLights(vnight)
  if (q.get('nl') === '0') villageHandle.group.traverse((o) => { if (o.userData._forceHide) o.visible = false; });
  post.update();
  frame++;
  if (frame === captureFrame) {
    renderer.render(scene, camera);            // 드로우콜 실측(composer 경로는 마지막 패스만 계수)
    window.__PLAN.perf = { calls: renderer.info.render.calls, tris: renderer.info.render.triangles };
    post.composer.render();                    // 실제 스크린샷(post 적용)
    window.__STATS = computeGlowStats();
    window.__NLHASH = nlHash();
    window.__SHOT_READY = true;
  } else {
    post.composer.render();
  }
});
</script></body></html>`;

const server = createServer(async (req, res) => {
  const path = req.url.split('?')[0];
  if (path === '/__vnight') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(HTML); return; }
  try {
    const file = join(ROOT, path === '/' ? 'index.html' : path);
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const port = server.address().port;

const filter = process.argv[2] || '';
const shots = [
  ['sunset-aerial', '/__vnight?scale=village&view=aerial&time=sunset', 1440, 900],
  ['night-aerial', '/__vnight?scale=village&view=aerial&time=night', 1440, 900],
  ['day-aerial', '/__vnight?scale=village&view=aerial&time=day', 1440, 900],
  ['dawn-aerial', '/__vnight?scale=village&view=aerial&time=dawn', 1440, 900],
  ['sunset-eye', '/__vnight?scale=village&view=eye&time=sunset', 1440, 900],
  ['night-eye', '/__vnight?scale=village&view=eye&time=night', 1440, 900],
  ['night-town', '/__vnight?scale=town&view=aerial&time=night', 1440, 900],
  ['sunset-town', '/__vnight?scale=town&view=aerial&time=sunset', 1440, 900],
  ['night-hamlet', '/__vnight?scale=hamlet&view=aerial&time=night', 1440, 900],
  ['night-palace', '/__vnight?scale=town&view=aerial&time=night&palace=1&temple=1', 1440, 900],
  ['cross-day-night', '/__vnight?scale=village&view=aerial&cross=day-night&crossAt=14', 1440, 900],
  ['dc-on', '/__vnight?scale=town&view=aerial&time=night&nl=1', 1440, 900],
  ['dc-off', '/__vnight?scale=town&view=aerial&time=night&nl=0', 1440, 900],
  ['repro-a', '/__vnight?scale=village&view=aerial&time=night', 1440, 900],
  ['repro-b', '/__vnight?scale=village&view=aerial&time=night', 1440, 900],
].filter(([name]) => !filter || name.includes(filter));

let browser;
try { browser = await chromium.launch({ channel: 'chrome' }); }
catch { browser = await chromium.launch(); }

let pageErrs = 0, consoleErrs = 0;
const hashes = {};
for (const [name, qs, vw, vh] of shots) {
  const page = await browser.newPage({ viewport: { width: vw, height: vh } });
  page.on('console', (msg) => { if (msg.type() === 'error') { const t = msg.text(); if (!/favicon|404/.test(t)) { consoleErrs++; console.error('[console]', name, t); } } });
  page.on('pageerror', (err) => { pageErrs++; console.error('[pageerror]', name, err.message); });
  const url = `http://127.0.0.1:${port}${qs}`;
  await page.goto(url, { waitUntil: 'load' });
  try { await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 40000 }); }
  catch { console.error('TIMEOUT', name); }
  await page.waitForTimeout(150);
  const info = await page.evaluate(() => ({ plan: window.__PLAN, stats: window.__STATS, nlHash: window.__NLHASH }));
  await page.screenshot({ path: join(OUT, `${PREFIX}${name}.png`) });
  hashes[name] = info.nlHash;
  const s = info.stats || {};
  console.log(`${name.padEnd(18)} warmPx=${s.warmPx} warmPct=${s.warmPct}% maxL=${s.maxL} meanL=${s.meanL} | calls=${info.plan?.perf?.calls} tris=${info.plan?.perf?.tris} nl=${info.nlHash} R=${info.plan?.R}`);
  await page.close();
}
if (hashes['repro-a'] && hashes['repro-b']) {
  console.log(`\\nDETERMINISM(nightlight buffer) repro-a=${hashes['repro-a']} repro-b=${hashes['repro-b']} → ${hashes['repro-a'] === hashes['repro-b'] ? 'IDENTICAL' : 'DIFFER'}`);
}
console.log(`pageerror=${pageErrs} console-error=${consoleErrs}`);
await browser.close();
server.close();
