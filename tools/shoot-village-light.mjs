// 헤드리스 스크린샷 + 휘도 통계: 마을 조명(태스크 #44) 검증 → shots/vlight-*.png
// 사용법: node tools/shoot-village-light.mjs [필터]
//
// shoot-village.mjs 와 달리 이 하네스는 "앱 경로"를 충실히 재현한다:
//   engine.js 처럼 scene sun/hemi → setupEnvironment(sky.apply) → setupPost →
//   createVillage(adapter) → enterVillageMode → handle.setTime → post.composer.render.
//   → adapter 의 마을 조명 리그·post 마을 오버라이드가 실제 앱과 동일하게 반영된다.
// (shoot-village.mjs 는 planVillage+populateVillage 를 직접 조명해 adapter/env/post 를 건너뛴다.)
//
// 각 컷마다 순흑 비율 + 중간톤 히스토그램(플래그십 R3 판정 방식)을 콘솔에 출력한다.
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
const num = (k, d) => { const v = parseFloat(q.get(k)); return Number.isFinite(v) ? v : d; };

// 결정론(같은 seed 픽셀 동일) — shoot-village.mjs 와 동일한 시드 xorshift 로 Math.random 고정.
{ let s = 0x2545f491 >>> 0; Math.random = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

// ── 앱 렌더러 셋업(engine.js 준용) ──
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

// engine.js 와 동일한 scene sun/hemi (shadow cam ±22).
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

// env + post (앱과 동일). env.setEnabled(true) → sky.apply 가 sun/hemi/fog/exposure 구동.
const env = setupEnvironment(scene, { sun, hemi, renderer, layout: computeLayout(PRESETS.korea) });
const post = setupPost({ renderer, scene, camera });
post.setSize(innerWidth, innerHeight);
env.setEnabled(true);
env.setTime(time);
post.setTime(time);

// 마을 생성 + 진입(engine.buildVillage 준용).
const villageHandle = createVillage({ scale, seed, includePalace, includeTemple, character });
villageHandle.enterVillageMode({ scene, building: null, ground, env });
villageHandle.setTime(time);

const R = villageHandle.plan.site.R;
// reapplyVillageFog 준용.
if (scene.fog) { scene.fog.near = R * 2.2; scene.fog.far = R * 7.0; }
camera.far = R * 8; camera.near = 0.5;
camera.updateProjectionMatrix();

window.__PLAN = { scale, seed, R, stats: villageHandle.plan.stats, time };

// villageAerial 프레이밍(engine.js).
let campos, target, fov;
if (view === 'aerial') {
  fov = 42;
  campos = new THREE.Vector3(0.20 * R, 1.02 * R, 1.98 * R);
  target = new THREE.Vector3(0, 0.06 * R, -0.10 * R);
} else {
  // 아이레벨(개울 앞 진입 접근뷰) — shoot-village.mjs eye 준용.
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

// 휘도 통계: 표시(sRGB) 픽셀 → perceptual luma. 전체 프레임 + 하단 78%(하늘 상단 밴드 제외 = 마을/지형).
function computeStats() {
  const cvs = renderer.domElement;
  const w = cvs.width, h = cvs.height;
  const c2 = document.createElement('canvas'); c2.width = w; c2.height = h;
  const ctx = c2.getContext('2d');
  ctx.drawImage(cvs, 0, 0);
  const data = ctx.getImageData(0, 0, w, h).data;
  const yStart = Math.floor(h * 0.22);  // 상단 22% 하늘 밴드 제외 → 마을/지형 subject
  const buckets = { black: 0, deep: 0, low: 0, mid: 0, high: 0 };   // <0.02 / <0.1 / <0.35 / <0.65 / else
  let subj = 0, sumL = 0;
  for (let y = yStart; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const L = (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
      subj++; sumL += L;
      if (L < 0.02) buckets.black++;
      else if (L < 0.10) buckets.deep++;
      else if (L < 0.35) buckets.low++;
      else if (L < 0.65) buckets.mid++;
      else buckets.high++;
    }
  }
  const pct = (n) => +(100 * n / subj).toFixed(2);
  return {
    subjectPx: subj, meanL: +(sumL / subj).toFixed(3),
    black: pct(buckets.black), deep: pct(buckets.deep), low: pct(buckets.low),
    mid: pct(buckets.mid), high: pct(buckets.high),
  };
}

let frames = 0;
renderer.setAnimationLoop(() => {
  villageHandle.update(1 / 60);
  post.update();
  post.composer.render();
  frames++;
  if (frames === 16) {
    window.__PLAN.perf = { calls: renderer.info.render.calls, tris: renderer.info.render.triangles };
    window.__STATS = computeStats();
    window.__SHOT_READY = true;
  }
});
</script></body></html>`;

const server = createServer(async (req, res) => {
  const path = req.url.split('?')[0];
  if (path === '/__vlight') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(HTML); return; }
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
  ['sunset-aerial', '/__vlight?scale=village&view=aerial&time=sunset', 1440, 900],
  ['sunset-aerial-portrait', '/__vlight?scale=village&view=aerial&time=sunset', 900, 1600],
  ['dawn-aerial', '/__vlight?scale=village&view=aerial&time=dawn', 1440, 900],
  ['day-aerial', '/__vlight?scale=village&view=aerial&time=day', 1440, 900],
  ['night-aerial', '/__vlight?scale=village&view=aerial&time=night', 1440, 900],
  ['sunset-eye', '/__vlight?scale=village&view=eye&time=sunset', 1440, 900],
  ['sunset-town', '/__vlight?scale=town&view=aerial&time=sunset', 1440, 900],
  ['sunset-hamlet', '/__vlight?scale=hamlet&view=aerial&time=sunset', 1440, 900],
].filter(([name]) => !filter || name.includes(filter));

let browser;
try { browser = await chromium.launch({ channel: 'chrome' }); }
catch { browser = await chromium.launch(); }

let pageErrs = 0, consoleErrs = 0;
for (const [name, qs, vw, vh] of shots) {
  const page = await browser.newPage({ viewport: { width: vw, height: vh } });
  page.on('console', (msg) => { if (msg.type() === 'error') { const t = msg.text(); if (!/favicon|404/.test(t)) { consoleErrs++; console.error('[console]', name, t); } } });
  page.on('pageerror', (err) => { pageErrs++; console.error('[pageerror]', name, err.message); });
  const url = `http://127.0.0.1:${port}${qs}`;
  await page.goto(url, { waitUntil: 'load' });
  try { await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 40000 }); }
  catch { console.error('TIMEOUT', name); }
  await page.waitForTimeout(200);
  const info = await page.evaluate(() => ({ plan: window.__PLAN, stats: window.__STATS }));
  const file = join(OUT, `vlight-${name}.png`);
  await page.screenshot({ path: file });
  const s = info.stats || {};
  console.log(`${name.padEnd(24)} R=${info.plan?.R} meanL=${s.meanL} | black=${s.black}% deep=${s.deep}% low=${s.low}% mid=${s.mid}% high=${s.high}% | perf=${JSON.stringify(info.plan?.perf || {})}`);
  await page.close();
}
console.log(`\\npageerror=${pageErrs} console-error=${consoleErrs}`);
await browser.close();
server.close();
