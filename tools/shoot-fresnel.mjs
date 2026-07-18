// 재질 프레넬 림(#76) 검증. env/post.js 를 index.html(main.js) 대신 env 직접 import 하네스(/__fres)로
//   구동 — 병렬 작업 중 앱 경로 breakage 에 흔들리지 않음(ambient-verify-harness 원칙).
// 사용: NODE_PATH=/Users/hckim/repo/threesur/node_modules node tools/shoot-fresnel.mjs
// 산출: scratchpad/fresnel/ 에 전 컷(중간), shots/fresnel-*.png 에 게이트 증거만.
//
// 림 모드는 post.js 가 location.search 의 ?rim= 로 선택하므로 하네스 URL 에 rim=pass|fresnel 을 실어
//   같은 씬을 A/B 캡처한다. 다중 건물 배치로 "앞 건물이 뒷 건물을 가리는" X-ray 재현각을 만든다.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync, copyFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
const { PNG } = createRequire(import.meta.url)('pngjs');

const ROOT = resolve(import.meta.dirname, '..');
const SCRATCH = '/private/tmp/claude-501/-Users-hckim-repo-asiahouse/7a15478e-68e3-4ad3-b08a-bdb86ae4fe92/scratchpad/fresnel';
const SHOTS = join(ROOT, 'shots');
mkdirSync(SCRATCH, { recursive: true });
mkdirSync(SHOTS, { recursive: true });
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json' };

// 하네스 HTML: scene + 건물 배치(scene='single'|'pair'|'grid') + env + post 를 직접 배선.
//   URL: /__fres?rim=fresnel&scene=pair&preset=giwa&time=sunset&az=34&el=-4&r=3.0&tx=..&fov=30&ink=0
const HARNESS = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>html,body{margin:0;height:100%;overflow:hidden;background:#cfd8e0}#app{width:100%;height:100%}</style>
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.185.1/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.185.1/examples/jsm/"}}</script>
</head><body><div id="app"></div>
<script type="module">
import * as THREE from 'three';
import { PRESETS, computeLayout } from '/src/params.js';
import { buildBuilding } from '/src/builder/index.js';
import { setupEnvironment } from '/src/env/index.js';
import { setupPost } from '/src/env/post.js';
import { setupInk } from '/src/render/ink.js';
const q = new URLSearchParams(location.search);
const num = (k, d) => { const v = parseFloat(q.get(k)); return Number.isFinite(v) ? v : d; };
const presetName = ['korea','temple','choga','giwa'].includes(q.get('preset')) ? q.get('preset') : 'giwa';
const time = q.get('time') || 'sunset';
const sceneKind = q.get('scene') || 'single';   // single | pair | grid
const ink = q.get('ink') === '1';
const post0 = q.get('post') === '0';

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = ink ? THREE.NoToneMapping : THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
document.getElementById('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xcfd8e0);
scene.fog = new THREE.Fog(0xcfd8e0, 60, 320);
const sun = new THREE.DirectionalLight(0xfff0dd, 2.6); sun.position.set(30, 42, 26); sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048); sun.shadow.camera.left = -80; sun.shadow.camera.right = 80; sun.shadow.camera.top = 80; sun.shadow.camera.bottom = -80;
sun.shadow.camera.far = 320; sun.shadow.bias = -0.0001; sun.shadow.normalBias = 0.05; scene.add(sun);
const hemi = new THREE.HemisphereLight(0xbdd0e4, 0x8a7a63, 0.9); scene.add(hemi);

// 건물 배치. 'building' 이름은 하나만(env smoke 조회용) — 나머지는 building2 등.
const P = { ...PRESETS[presetName] };
const backName = ['korea','temple','choga','giwa'].includes(q.get('backPreset')) ? q.get('backPreset') : presetName;
const layout = computeLayout(P);
function place(x, z, ry, name, preset) {
  const b = buildBuilding({ ...PRESETS[preset || presetName] });
  b.position.set(x, 0, z); b.rotation.y = ry; b.name = name;
  scene.add(b); return b;
}
const maxDim = Math.max(layout.W + 4, layout.D + 4, layout.totalH);
if (sceneKind === 'single') {
  place(0, 0, 0, 'building');
} else if (sceneKind === 'pair') {
  // 뒷채(원점)를 앞채가 화면상 겹쳐 가리게 배치: 앞채를 카메라(+x,+z) 쪽으로 바짝 당겨
  //   화면에서 두 지붕이 겹치도록. 뒷채 지붕·처마 실루엣이 앞채 벽 위로 새는지(X-ray) 판정.
  place(0, 0, 0, 'building');                          // 뒷채(가려지는 대상)
  place(maxDim * 0.42, maxDim * 0.20, 0.0, 'building2'); // 앞채(가리는 것) — 화면상 뒷채와 겹침
} else if (sceneKind === 'occlude') {
  // X-ray 결정타: 키 큰 뒷채(궁, 원점) 앞에 낮은 앞채(기와)를 카메라 쪽으로 바짝. 앞채 지붕/벽이
  //   뒷채 하부를 가리고 뒷채 지붕만 그 위로 솟는다 → 구 RimPass 는 "앞채 지붕선 위/뒤로 뒷채
  //   지붕 실루엣선"이 앞채 표면에 겹쳐 새고(깊이 불연속 무차별 선화+반해상도 스멜), fresnel 은 없음.
  place(0, 0, 0, 'building', backName);                        // 키 큰 뒷채(궁)
  place(maxDim * 0.30, maxDim * 0.42, 0.1, 'building2', presetName); // 낮은 앞채(기와) 카메라 쪽
} else { // grid: 마을 부감 근사(다수 겹침)
  let n = 0;
  for (let ix = -2; ix <= 2; ix++) for (let iz = -2; iz <= 2; iz++) {
    place(ix * maxDim * 1.15, iz * maxDim * 1.15, (ix * 31 + iz * 17) * 0.03, n === 0 ? 'building' : 'b' + n); n++;
  }
}
const layout0 = computeLayout(P);
const env = setupEnvironment(scene, { sun, hemi, renderer, layout: layout0 });
env.setSeason('summer', { immediate: true });
env.setTime(time);
env.setEnabled(true);
window.__env = env;
// X-ray·부감 판정 시 나무 클러터 제거(하늘·지형·태양방향은 유지). 원경 나무가 건물 겹침을 가림.
if (q.get('notrees') === '1') { const tg = env.group.getObjectByName('trees'); if (tg) tg.visible = false; }

// 카메라(az/el/r 구면 — shoot-ambient 공식). grid 는 위에서 내려보는 부감.
const fov = num('fov', 30);
const camera = new THREE.PerspectiveCamera(fov, innerWidth / innerHeight, 0.1, 900);
const target = new THREE.Vector3(num('tx', 0), num('ty', layout.totalH * 0.45), num('tz', 0));
function aim(az, el, r) {
  const A = az * Math.PI / 180, E = el * Math.PI / 180;
  camera.position.set(target.x + r * Math.cos(E) * Math.sin(A), target.y + r * Math.sin(E), target.z + r * Math.cos(E) * Math.cos(A));
  camera.lookAt(target);
}
const defR = sceneKind === 'grid' ? 6.2 : (sceneKind === 'pair' ? 4.6 : 3.0);
aim(num('az', 34), num('el', sceneKind === 'grid' ? 34 : -4), num('r', defR) * maxDim);
window.__aim = (az, el, r) => aim(az, el, r * maxDim);
window.__aimT = (tx, ty, tz) => { target.set(tx, ty, tz); camera.lookAt(target); };

let post = null, inkPipe = null;
if (ink) {
  inkPipe = setupInk(renderer, scene, camera); inkPipe.setSize(innerWidth, innerHeight);
  if (scene.fog) { inkPipe.inkPass.uniforms.fogNear.value = scene.fog.near; inkPipe.inkPass.uniforms.fogFar.value = scene.fog.far; scene.fog.color.copy(new THREE.Color(0xf3efe6)); }
  scene.background = new THREE.Color(0xf3efe6);
  // 실제 앱 ink 경로: post 는 만들되 setEnabled(false) — 재질 프레넬 강도/마스터가 0 으로 눌리는지 검증.
  post = setupPost({ renderer, scene, camera });
  post.setTime(time); post.setEnabled(false);
} else if (!post0) {
  post = setupPost({ renderer, scene, camera });
  post.setSize(innerWidth, innerHeight);
  post.setTime(time);
  post.setEnabled(true);
}
window.__post = post;
window.__advance = (secs) => { const n = Math.max(1, Math.round(secs / 0.05)); for (let i = 0; i < n; i++) env.update(0.05); };
window.__setRim = (on) => { try { post && post.setRimEnabled(on); } catch {} };
window.__setFlare = (on) => { try { post && post.setFlareEnabled(on); } catch {} };
// 프레임당 누적 draw call: renderer.info 는 renderer.render 마다 autoReset 되므로 컴포저 다패스에서
//   마지막 패스 값만 남는다. autoReset 끄고 프레임 시작에 reset → 씬 제출(RenderPass + RimPass 등)
//   전부 합산해 읽는다. RimPass(pass) 는 씬을 한 번 더 제출하므로 fresnel 대비 calls 가 크다.
renderer.info.autoReset = false;
window.__info = () => ({ calls: window.__lastCalls || 0, tris: window.__lastTris || 0 });

let frames = 0;
renderer.setAnimationLoop(() => {
  renderer.info.reset();
  env.update(0.016);
  if (post) post.update(0.016);
  if (ink) inkPipe.composer.render();
  else if (post0) renderer.render(scene, camera);
  else post.composer.render();
  window.__lastCalls = renderer.info.render.calls;
  window.__lastTris = renderer.info.render.triangles;
  frames++;
  if (frames === 4) { window.__advance(0.5); if (post) post.update(0.016); }
  if (frames === 6) window.__SHOT_READY = true;
});
</script></body></html>`;

const server = createServer(async (req, res) => {
  const path = req.url.split('?')[0];
  if (path === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  if (path === '/__fres') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(HARNESS); return; }
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
const ignorable = (t) => /favicon/i.test(t);   // 브라우저 자동 /favicon.ico 404 는 무해
page.on('console', (m) => { if (m.type() === 'error' && !ignorable(m.text())) { console.error('[page]', m.text()); errors.push(m.text()); } });
page.on('pageerror', (e) => { console.error('[pageerror]', e.message); errors.push('PAGEERROR: ' + e.message); });

async function open(qs) {
  const before = errors.length;
  await page.goto(`${base}/__fres?${qs}`, { waitUntil: 'load' });
  await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 30000 });
  await page.waitForTimeout(220);
  return errors.length - before;
}
async function shot(name, clip) {
  const buf = await page.screenshot(clip ? { path: join(SCRATCH, name + '.png'), clip } : { path: join(SCRATCH, name + '.png') });
  return PNG.sync.read(buf);
}
function gate(name) { copyFileSync(join(SCRATCH, name + '.png'), join(SHOTS, 'fresnel-' + name + '.png')); }
async function rimInfo() { return page.evaluate(() => window.__rim ? ({ mode: window.__rim.mode, patched: window.__rim.patched, strength: +window.__rim.strength.toFixed(3), scale: window.__rim.scale }) : null); }
async function flareInfo() { return page.evaluate(() => window.__flare ? ({ amt: +window.__flare.amt.toFixed(3), front: window.__flare.front }) : null); }
async function info() { return page.evaluate(() => window.__info()); }

// 프레임 안정화 후 draw call 평균(몇 프레임). RimPass(pass) 는 씬을 한 번 더 제출하므로 calls 가 커진다.
async function drawCalls() {
  let s = 0, n = 0;
  for (let i = 0; i < 5; i++) { const d = await info(); s += d.calls; n++; await page.waitForTimeout(60); }
  return Math.round(s / n);
}

const luma = (r, g, b) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
// 두 컷의 가산 웜(골드) 차이 맵 통계 — 림 기여분의 위치·양. building2(앞채) 영역 vs 전체.
function warmDiff(a, b) {
  const { width, height, data: A } = a; const B = b.data;
  let add = 0, mx = 0, litN = 0;
  for (let i = 0; i < A.length; i += 4) {
    const dl = luma(A[i], A[i + 1], A[i + 2]) - luma(B[i], B[i + 1], B[i + 2]);
    if (dl > 0.01) { add += dl; if (dl > mx) mx = dl; litN++; }
  }
  const px = width * height;
  return { addPerPx: (add / px).toFixed(5), maxAdd: mx.toFixed(3), litPct: (100 * litN / px).toFixed(2) };
}

console.log('\n=== GATE 1: X-ray 재현 (앞 건물이 뒷 건물 가림, sunset 역광) ===');
// occlude 씬: 키 큰 뒷채(궁) 앞에 낮은 앞채(기와). rim=pass 는 뒷채 지붕 실루엣선이 앞채 표면 위로
//   새고(깊이 불연속 무차별 선화+반해상도 스멜), rim=fresnel 은 각 표면 자기 프레넬만 → 누출 없음.
//   겹침 경계 확대 클립도 저장(전 컷 + zoom).
const occQs = 'scene=occlude&preset=giwa&backPreset=korea&time=sunset&az=22&el=3&r=3.0&notrees=1';
const zoomClip = { x: 360, y: 150, width: 560, height: 420 };
{
  const e1 = await open(`rim=pass&${occQs}`); await shot('xray-before-pass'); await shot('xray-before-pass-zoom', zoomClip); const ri1 = await rimInfo();
  const e2 = await open(`rim=fresnel&${occQs}`); await shot('xray-after-fresnel'); await shot('xray-after-fresnel-zoom', zoomClip); const ri2 = await rimInfo();
  gate('xray-before-pass'); gate('xray-after-fresnel'); gate('xray-before-pass-zoom'); gate('xray-after-fresnel-zoom');
  console.log(`  pass:    ${JSON.stringify(ri1)}${e1 ? ' ERR:' + e1 : ''}`);
  console.log(`  fresnel: ${JSON.stringify(ri2)}${e2 ? ' ERR:' + e2 : ''}`);
}
// pair(기와 두 채, 지붕끼리 겹침) 보조 컷.
const pairQs = 'scene=pair&preset=giwa&time=sunset&az=26&el=1&r=3.6&notrees=1';
{
  await open(`rim=pass&${pairQs}`); await shot('xray-pair-pass'); gate('xray-pair-pass');
  await open(`rim=fresnel&${pairQs}`); await shot('xray-pair-fresnel'); gate('xray-pair-fresnel');
}

console.log('\n=== GATE 2: 패리티 (단일 건물 sunset 역광, rim vs fresnel) ===');
for (const [nm, qs] of [
  ['parity-giwa', 'scene=single&preset=giwa&time=sunset&az=34&el=-4&r=3.0'],
  ['parity-korea', 'scene=single&preset=korea&time=sunset&az=34&el=2&r=3.0'],
  ['parity-choga', 'scene=single&preset=choga&time=sunset&az=34&el=-2&r=3.0'],
]) {
  const ep = await open(`rim=pass&${qs}`); const sp = await shot(nm + '-pass'); const rip = await rimInfo();
  const ef = await open(`rim=fresnel&${qs}`); const sf = await shot(nm + '-fresnel'); const rif = await rimInfo();
  gate(nm + '-pass'); gate(nm + '-fresnel');
  const d = warmDiff(sf, sp);   // fresnel - pass 골드 차이(어디에 림이 더/덜 붙나)
  console.log(`  ${nm}: pass str=${rip && rip.strength} / fresnel str=${rif && rif.strength} patched=${rif && rif.patched} | Δ(fres-pass) add/px=${d.addPerPx} lit%=${d.litPct}${ep + ef ? ' ERR' : ''}`);
}

console.log('\n=== GATE 3: 마을 부감 근사 상시 ON (grid, 과다 여부) ===');
const gridQs = 'scene=grid&preset=giwa&time=sunset&az=28&el=34&r=6.4&notrees=1';
// grid 부감에서 fresnel 을 강제 ON(scale 1) 해 "전 건물 골든 아웃라인 과다" 여부를 눈검사.
{
  const eg = await open(`rim=fresnel&${gridQs}`);
  const ri = await rimInfo();
  await shot('aerial-fresnel-on'); gate('aerial-fresnel-on');
  // 부감에서 rim OFF(현행 앱 기본) 컷도.
  await page.evaluate(() => window.__setRim(false)); await page.waitForTimeout(120);
  await shot('aerial-fresnel-off'); gate('aerial-fresnel-off');
  console.log(`  grid fresnel ON: ${JSON.stringify(ri)}${eg ? ' ERR:' + eg : ''}`);
  // 같은 부감을 구 RimPass(pass) 상시 ON 으로 — 과다·X-ray 대비 컷(참고: 앱은 부감서 rim OFF).
  await open(`rim=pass&${gridQs}`); await shot('aerial-pass-on'); gate('aerial-pass-on');
}

console.log('\n=== GATE 4: 플레어 정상 (fresnel 자체 depth 가림 판정) ===');
// 태양이 처마 뒤에서 드러나는 저각 프레이밍 — flare 헤일로 성립 + 가림 페이드.
for (const [nm, qs] of [
  ['flare-eave', 'rim=fresnel&scene=single&preset=korea&time=sunset&az=30&el=-6&r=3.0'],
  ['flare-pair-occlude', 'rim=fresnel&scene=pair&preset=giwa&time=sunset&az=30&el=-4&r=4.2'],
]) {
  const e = await open(qs); const fi = await flareInfo(); const ri = await rimInfo();
  await shot(nm); gate(nm);
  // flare ON/OFF 분리 기여 컷(같은 프레임)
  await page.evaluate(() => window.__setFlare(false)); await page.waitForTimeout(120); await shot(nm + '-off');
  await page.evaluate(() => window.__setFlare(true)); await page.waitForTimeout(120);
  console.log(`  ${nm}: flare=${JSON.stringify(fi)} rim=${JSON.stringify(ri)}${e ? ' ERR:' + e : ''}`);
}
gate('flare-eave-off');

console.log('\n=== GATE 5: ink · post=0 무회귀 (골든 림 누출 없어야) ===');
{
  const ei = await open('rim=fresnel&scene=single&preset=korea&time=sunset&az=34&el=2&r=3.0&ink=1');
  const ri = await rimInfo(); await shot('mode-ink'); gate('mode-ink');
  console.log(`  ink: rim=${JSON.stringify(ri)} (strength/scale 0 이어야)${ei ? ' ERR:' + ei : ''}`);
  const ep = await open('scene=single&preset=korea&time=sunset&az=34&el=2&r=3.0&post=0');
  await shot('post0'); gate('post0');
  console.log(`  post0: (post 컴포저 미사용, 재질 미패치)${ep ? ' ERR:' + ep : ''}`);
}

console.log('\n=== GATE 6: 성능 — 림의 씬 제출 비용 격리 (draw calls/프레임, flare OFF) ===');
// 림 비용만 격리: flare 를 끈다(flare 는 focus 에서만 켜지고 자체 depth 렌더가 있어 rim 비용을 가림).
//   - pass rim ON:  RenderPass + RimPass(씬 노멀 재렌더) = 씬 2회 제출
//   - pass rim OFF: RenderPass = 씬 1회 (구 앱이 부감에서 택한 게이팅)
//   - fresnel rim ON: RenderPass = 씬 1회 (림이 재질이라 추가 제출 0) ← 상시 ON 이면서 부감서도 1회
async function rimCost(sceneKind, az, el, r, label) {
  const q = `scene=${sceneKind}&preset=giwa&time=sunset&az=${az}&el=${el}&r=${r}&notrees=1`;
  await open(`rim=pass&${q}`); await page.evaluate(() => window.__setFlare(false)); await page.waitForTimeout(150);
  const passOn = await drawCalls();
  await page.evaluate(() => window.__setRim(false)); await page.waitForTimeout(150);
  const passOff = await drawCalls();
  await open(`rim=fresnel&${q}`); await page.evaluate(() => window.__setFlare(false)); await page.waitForTimeout(150);
  const fresOn = await drawCalls(); const it = await info();
  console.log(`  ${label} (tris≈${it.tris}):`);
  console.log(`     pass rim ON = ${passOn} calls | pass rim OFF = ${passOff} | fresnel rim ON = ${fresOn}`);
  console.log(`     → RimPass 추가 제출 = ${passOn - passOff} calls; fresnel 추가 제출 = ${fresOn - passOff} calls`);
}
await rimCost('single', 34, -3, 3.0, '단일건물 focus');
await rimCost('grid', 28, 34, 6.4, '25채 부감(마을 근사)');

await browser.close();
server.close();
console.log(errors.length ? `\nTOTAL ERRORS: ${errors.length}` : '\nNO ERRORS');
