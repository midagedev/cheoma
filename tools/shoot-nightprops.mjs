// 헤드리스 검증(태스크 #70):
//   ① 등롱(석등 화창) emissive 시간 게이트 — 주간 소등 / 황혼·야간 웜 호롱빛(흰 blowout 소멸),
//      크로스페이드 중간 팟 없음. 석등 프롭을 직접 배치하고 마을 adapter 의 야간광 구동(WARM emissive
//      × vnight × glowBoost, candleFlicker)을 충실히 미러해 시간대별로 렌더. legacy=1 은 구(舊)
//      상수 emissive 0.9 재질을 재현(blowout 비교).
//   ② tagRoles 부활(#55) — mode=village 는 실제 adapter(createVillage) 경로로 마을 부감을 렌더하고
//      village group 을 훑어 material.userData.role 태그 수·드로우콜을 리포트(before/after 판정).
//
// 사용: node tools/shoot-nightprops.mjs [필터]
//   기본 출력 scratchpad/nightprops/ (반복). NIGHTPROPS_OUT=shots 로 최종 게이트(shots/nightprops-*.png).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = process.env.NIGHTPROPS_OUT
  ? (process.env.NIGHTPROPS_OUT === 'shots' ? join(ROOT, 'shots') : resolve(process.env.NIGHTPROPS_OUT))
  : '/private/tmp/claude-501/-Users-hckim-repo-asiahouse/7a15478e-68e3-4ad3-b08a-bdb86ae4fe92/scratchpad/nightprops';
const PREFIX = process.env.NIGHTPROPS_OUT === 'shots' ? 'nightprops-' : '';
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
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { buildProp } from '/src/props/index.js';
import { createVillage } from '/src/village/adapter.js';
import { candleFlicker } from '/src/env/night-glow.js';

const q = new URLSearchParams(location.search);
const mode = q.get('mode') || 'lantern';
const time = q.get('time') || 'night';
const legacy = q.get('legacy') === '1';
const tween = parseFloat(q.get('tw'));           // lantern-tween: 0..1 (sunset→night)
const num = (k, d) => { const v = parseFloat(q.get(k)); return Number.isFinite(v) ? v : d; };

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.NoToneMapping;   // OutputPass(ACES) 가 톤매핑 1회 적용(post.js 동형)
document.getElementById('app').appendChild(renderer.domElement);
const scene = new THREE.Scene();

// shoot-var 와 동일 시간대 조명 테이블(마을 부감과 결이 맞게).
const L = {
  day:    { bg: 0xcfd8e0, sun: [0xfff0dd, 2.5, [0.42,1.25,0.30]], hemi: [0xc4d6e8, 0x9a8c72, 1.25], exp: 1.05 },
  sunset: { bg: 0xe7b98f, sun: [0xffb066, 2.1, [0.7,0.7,0.42]], hemi: [0xd7b48c, 0x7a6a54, 1.0], exp: 1.0 },
  night:  { bg: 0x131a29, sun: [0xbcd2ff, 0.55, [0.30,0.95,0.52]], hemi: [0x2a3550, 0x171820, 0.55], exp: 1.2 },
}[time] || {};
scene.background = new THREE.Color(L.bg);
renderer.toneMappingExposure = L.exp;

// ── 마을 adapter 야간광 구동 미러(석등 hanjiGlow 태그를 그대로 구동) ──
//   adapter.js: WARM=0xffb35c, nightLevelFor(night=1/sunset=.42/dawn=.22/day=0), glowBoost(night=1.5, 그 외 1.0).
const WARM = 0xffb35c;
const NIGHT_LEVEL = { night: 1.0, sunset: 0.42, dawn: 0.22, day: 0 };
const GLOW_BOOST  = { night: 1.5, sunset: 1.0,  dawn: 1.0,  day: 1.0 };
function collectGlow(root) {
  const out = [], seen = new Set(); let i = 0;
  root.traverse((o) => {
    const ms = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
    for (const m of ms) {
      const b = m && m.userData ? m.userData.hanjiGlow : null;
      if (b == null || seen.has(m)) continue;
      seen.add(m);
      out.push({ mat: m, glow: b, phase: (i++) * 1.7 });
    }
  });
  return out;
}

function makeSceneLights() {
  const sun = new THREE.DirectionalLight(L.sun[0], L.sun[1]);
  sun.position.set(L.sun[2][0] * 12, L.sun[2][1] * 12, L.sun[2][2] * 12);
  sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera; sc.left = -6; sc.right = 6; sc.top = 6; sc.bottom = -6; sc.near = 0.5; sc.far = 40;
  sun.shadow.bias = -0.0003; sun.shadow.normalBias = 0.04;
  scene.add(sun);
  scene.add(new THREE.HemisphereLight(L.hemi[0], L.hemi[1], L.hemi[2]));
  scene.fog = new THREE.Fog(L.bg, 40, 160);
}

// post.js 시간대별 bloom(광원 헤이즈) 파라미터 미러 — 야간(threshold 0.32·strength 0.70)이
//   광원성 요소를 공격적으로 피어나게 함. 구 등롱(0.9)이 흰 blowout 나던 조건을 재현.
const BLOOM = { day: [0.55, 0.55, 0.82], sunset: [0.62, 0.38, 0.80], night: [0.70, 0.62, 0.32] };
function makeComposer(camera) {
  const size = renderer.getSize(new THREE.Vector2());
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const [str, rad, thr] = BLOOM[time] || BLOOM.night;
  composer.addPass(new UnrealBloomPass(new THREE.Vector2(size.x, size.y), str, rad, thr));
  composer.addPass(new OutputPass());
  return composer;
}

let glowMats = [];
let statsRegion = null;   // [x0,y0,x1,y1] 발광 픽셀 계측 영역(정규화)

if (mode === 'village') {
  // 실제 adapter 경로: 석등 포함 마을 부감. tagRoles 부활 판정(role 태그 수·드로우콜)·실런타임 등롱.
  const scale = q.get('scale') || 'village';
  const character = q.get('char') || 'banchon';
  const seed = num('seed', 20260716);
  { let s = 0x2545f491 >>> 0; Math.random = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
  const handle = createVillage({ scale, seed, character, includeTemple: true });
  handle.setTime(time);
  scene.add(handle.group);
  makeSceneLights();
  const site = handle.plan.site, R = site.R;
  scene.fog = new THREE.Fog(L.bg, R * 2.4, R * 7.0);
  // 부위 role 태그 계측 + 드로우콜.
  const roleCount = {}; const seenMat = new Set();
  handle.group.traverse((o) => {
    const ms = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
    for (const m of ms) { if (!m || seenMat.has(m)) continue; seenMat.add(m); const r = m.userData && m.userData.role; if (r) roleCount[r] = (roleCount[r] || 0) + 1; }
  });
  const view = q.get('view') || 'aerial';
  let campos, target3, fov;
  if (view === 'cluster') { fov = 40; campos = new THREE.Vector3(0.16 * R, 0.42 * R, 0.86 * R); target3 = new THREE.Vector3(0, 0.02 * R, 0.02 * R); }
  else if (view === 'aerial-low') { fov = 46; campos = new THREE.Vector3(0.28 * R, 0.62 * R, 1.35 * R); target3 = new THREE.Vector3(0, 0.05 * R, -0.08 * R); }
  else { fov = 44; campos = new THREE.Vector3(0.18 * R, 1.02 * R, 1.98 * R); target3 = new THREE.Vector3(0, 0.06 * R, -0.16 * R); }
  const camera = new THREE.PerspectiveCamera(fov, innerWidth / innerHeight, 0.5, R * 8);
  camera.position.set(num('cx', campos.x), num('cy', campos.y), num('cz', campos.z));
  camera.lookAt(num('tx', target3.x), num('ty', target3.y), num('tz', target3.z));
  const composer = makeComposer(camera);
  let frames = 0;
  renderer.setAnimationLoop(() => {
    handle.update(1 / 60);
    composer.render();
    if (++frames === 16) {
      // 씬 드로우콜 계측: composer.render 뒤 renderer.info 는 OutputPass(풀스크린 쿼드)만 반영하므로
      //   씬을 1회 직접 렌더해 실제 드로우콜을 읽는다(캔버스는 이후 프레임 composer.render 로 복원).
      renderer.render(scene, camera);
      const ri = renderer.info;
      window.__PLAN = { mode, time, scale, character, seed, roleCount, taggedMats: Object.values(roleCount).reduce((a, b) => a + b, 0),
        houses: handle.plan.stats.houses, perf: { calls: ri.render.calls, triangles: ri.render.triangles } };
      window.__SHOT_READY = true;
    }
  });
} else {
  // 석등 단독 프롭 씬(등롱 게이트 격리 검증).
  makeSceneLights();
  const ground = new THREE.Mesh(new THREE.CircleGeometry(30, 40), new THREE.MeshStandardMaterial({ color: 0x8a7f66, roughness: 1 }));
  ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);

  const lantern = buildProp('stone-lantern', { seed: 3, scale: 2.2 });   // 크게(화창 불빛 판독)
  lantern.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  scene.add(lantern);

  glowMats = collectGlow(lantern);
  if (legacy) {
    // 구(舊) 상수 재질 재현: emissive 0xff9c3c, intensity 0.9, 시간 게이트 없음(태그 제거).
    for (const rec of glowMats) { rec.mat.emissive.setHex(0xff9c3c); rec.mat.emissiveIntensity = 0.9; rec.mat.emissiveMap = null; rec.mat.needsUpdate = true; }
    glowMats = [];
  }

  const box = new THREE.Box3().setFromObject(lantern);
  const c = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const camera = new THREE.PerspectiveCamera(34, innerWidth / innerHeight, 0.05, 200);
  const r = Math.max(size.x, size.y, size.z) * 1.9;
  camera.position.set(num('cx', c.x + r * 0.55), num('cy', c.y + size.y * 0.22), num('cz', c.z + r));
  camera.lookAt(num('tx', c.x), num('ty', c.y + size.y * 0.10), num('tz', c.z));
  // 화창(불빛) 대략 화면 중앙 상부 — 계측 영역.
  statsRegion = [0.34, 0.20, 0.66, 0.62];

  // 발광 레벨 세팅: 정착 스냅(설정 시간대) 또는 tween(sunset→night 중간 프레임).
  function setLevel(vnight, glowBoost, flickerOn, t) {
    for (const rec of glowMats) {
      if (vnight > 0.001) {
        rec.mat.emissive.setHex(WARM);
        rec.mat.emissiveMap = rec.mat.map || null;
        const fl = flickerOn ? candleFlicker(t, rec.phase) : 1;
        rec.mat.emissiveIntensity = rec.glow * glowBoost * vnight * fl;
      } else {
        rec.mat.emissiveIntensity = 0;   // 주간 소등(기본 emissive 0 상태로)
      }
      rec.mat.needsUpdate = true;
    }
  }

  let vnight, glowBoost;
  if (Number.isFinite(tween)) {
    // sunset(0.42, boost1.0) → night(1.0, boost1.5) 선형 샘플 — 크로스페이드 연속성(팟 없음) 확인.
    vnight = 0.42 + (1.0 - 0.42) * tween;
    glowBoost = 1.0 + (1.5 - 1.0) * tween;
  } else {
    vnight = NIGHT_LEVEL[time] ?? 0;
    glowBoost = GLOW_BOOST[time] ?? 1.0;
  }
  setLevel(vnight, glowBoost, false, 0);
  const composer = makeComposer(camera);

  function glowStats() {
    const cvs = renderer.domElement, w = cvs.width, h = cvs.height;
    const gl = renderer.getContext();
    const [x0, y0, x1, y1] = statsRegion;
    const px = Math.floor(x0 * w), py = Math.floor((1 - y1) * h), pw = Math.floor((x1 - x0) * w), ph = Math.floor((y1 - y0) * h);
    const buf = new Uint8Array(pw * ph * 4);
    gl.readPixels(px, py, pw, ph, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    let blowout = 0, warm = 0, n = pw * ph;
    for (let i = 0; i < n; i++) {
      const R = buf[i * 4], G = buf[i * 4 + 1], B = buf[i * 4 + 2];
      if (R > 250 && G > 250 && B > 245) blowout++;                 // 순백 blowout
      if (R > 150 && R - B > 25 && G > B) warm++;                    // 웜(호롱빛) 픽셀
    }
    return { blowoutPct: +(100 * blowout / n).toFixed(2), warmPct: +(100 * warm / n).toFixed(2) };
  }

  let frames = 0;
  renderer.setAnimationLoop(() => {
    composer.render();
    if (++frames === 4) {
      window.__PLAN = { mode, time, legacy, tween: Number.isFinite(tween) ? tween : null, vnight: +vnight.toFixed(3), glowBoost, glowMats: glowMats.length, stats: glowStats() };
      window.__SHOT_READY = true;
    }
  });
}
</script></body></html>`;

const server = createServer(async (req, res) => {
  const path = req.url.split('?')[0];
  if (path === '/__np') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(HTML); return; }
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
  // ① 등롱 게이트: 주간 소등 / 황혼·야간 웜(흰 blowout 소멸)
  ['lantern-day',    '/__np?mode=lantern&time=day'],
  ['lantern-sunset', '/__np?mode=lantern&time=sunset'],
  ['lantern-night',  '/__np?mode=lantern&time=night'],
  // 구 상수(0.9) 재질 — 야간 blowout 비교(before)
  ['lantern-night-legacy', '/__np?mode=lantern&time=night&legacy=1'],
  ['lantern-day-legacy',   '/__np?mode=lantern&time=day&legacy=1'],
  // 크로스페이드 연속성(sunset→night, 팟 없음)
  ['lantern-tw-000', '/__np?mode=lantern&time=night&tw=0'],
  ['lantern-tw-050', '/__np?mode=lantern&time=night&tw=0.5'],
  ['lantern-tw-100', '/__np?mode=lantern&time=night&tw=1'],
  // ② tagRoles 부활 — 실 adapter 마을 부감(role 태그 수·드로우콜·실런타임 등롱)
  ['village-day',            '/__np?mode=village&char=banchon&time=day&view=aerial'],
  ['village-day-cluster',    '/__np?mode=village&char=banchon&time=day&view=cluster'],
  ['village-minchon-cluster','/__np?mode=village&char=minchon&time=day&view=cluster'],
  ['village-yeoyeom-cluster','/__np?mode=village&char=yeoyeom&time=day&view=cluster'],
  ['village-night',          '/__np?mode=village&char=banchon&time=night&view=aerial-low'],
].filter(([name]) => !filter || name.includes(filter));

let browser;
try { browser = await chromium.launch({ channel: 'chrome' }); }
catch { browser = await chromium.launch(); }
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
let pageErrs = 0, consoleErrs = 0;
page.on('console', (msg) => { if (msg.type() !== 'error') return; const t = msg.text(); if (/favicon\.ico/.test(t) || /status of 404/.test(t)) return; consoleErrs++; console.error('[console]', t); });
page.on('pageerror', (err) => { pageErrs++; console.error('[pageerror]', err.message); });

for (const [name, qs] of shots) {
  await page.goto(`http://127.0.0.1:${port}${qs}`, { waitUntil: 'load' });
  try { await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 40000 }); }
  catch { console.error('TIMEOUT', name); }
  await page.waitForTimeout(150);
  const info = await page.evaluate(() => window.__PLAN || null);
  console.log(name, JSON.stringify(info));
  const file = join(OUT, `${PREFIX}${name}.png`);
  await page.screenshot({ path: file });
  console.log('saved', file);
}
console.log(`pageerror=${pageErrs} console-error=${consoleErrs} (favicon 404 제외)`);
await browser.close();
server.close();
