// #53 S4 — 구름 임포스터 v4(쿼드 내 의사 3D 레이마칭) 계측 + v3/v4 A/B 대표컷.
//
// 왜 하나의 도구인가: 레포 규약상 셰이더 A/B 는 **같은 페이지·같은 부팅**에서 변수만 교체해야
//   성립한다(부팅 간 프레이밍 흔들림 = 비교 불성립). v4 는 프로그램을 하나만 쓰고 v3 복귀를
//   uniform(uCloudMarch.x=0)으로 하므로, 한 페이지에서 계측·캡처·프로그램 수 델타를 모두 잡는다.
//
// 산출:
//   1) 시선각 스윕 프로파일 — 같은 재질을 비빌보드 쿼드에 걸어 RGBA 렌더타깃에 그리고 각도별
//      커버리지·외곽 알파·내부 휘도 stdev 를 덤프한다(두께·자기그림자·내부 결의 수치 증거).
//   2) strength=0 불변식 — steps/thickness/optical/amp/alphaBlend/lightK 를 흔들어도 픽셀 해시
//      불변 ⇒ v4 기계가 완전히 비활성 ⇒ v3 셰이딩 보존(코드상 모든 v4 항이 mix(·, cloudMarchW)).
//   3) 프로그램 수·드로우콜 델타(직접 render — 컴포저가 켜지면 info.calls 는 마지막 패스만 센다).
//   4) 대표컷 4프레이밍 × v3/v4 (부감/지상 역광 sunset/측광 day/dawn) — 같은 부팅.
//
// 실행: node tools/run-browser-locked.mjs -- node tools/probe-cloud-v4.mjs
//   출력 PNG: shots/cloud-v4/<framing>-<v3|v4>.png   (--out 으로 변경 가능)
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { launchVerificationBrowser, reportWebGLRenderer } from './lib/verification-browser.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const outArg = process.argv.find((a) => a.startsWith('--out='));
const OUT = outArg ? resolve(outArg.slice('--out='.length)) : join(ROOT, 'shots', 'cloud-v4');
await mkdir(OUT, { recursive: true });

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
};

const HTML = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>html,body{margin:0;height:100%;overflow:hidden;background:#101216}#app{width:100%;height:100%}</style>
<script type="importmap">{"imports":{
  "three":"/app/node_modules/three/build/three.module.js",
  "three/addons/":"/app/node_modules/three/examples/jsm/"
}}</script>
</head><body><div id="app"></div>
<script type="module">
import * as THREE from 'three';
import { PRESETS, computeLayout } from '/src/params.js';
import { buildBuilding } from '/src/builder/index.js';
import { setupEnvironment } from '/src/env/index.js';
import { setupPost } from '/src/env/post.js';

const q = new URLSearchParams(location.search);
const W = 1280, H = 720;
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(W, H);
renderer.setPixelRatio(1);
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
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const P = { ...PRESETS[q.get('preset') || 'korea'] };
const building = buildBuilding(P);
building.name = 'building';
scene.add(building);

const camera = new THREE.PerspectiveCamera(38, W / H, 0.1, 500);
const env = setupEnvironment(scene, { sun, hemi, renderer, layout: computeLayout(P) });
const post = setupPost({ renderer, scene, camera });
post.setSize(W, H);
post.setEnabled(true);

// ── 프레이밍 ────────────────────────────────────────────────────────────────
// 태양 방위를 매번 읽어 카메라를 배치하므로 시간대가 바뀌어도 "역광/측광"의 기하가 유지된다.
function frame(kind, override = null) {
  const sunXZ = new THREE.Vector2(sun.position.x, sun.position.z);
  if (sunXZ.lengthSq() < 1e-6) sunXZ.set(0, 1);
  sunXZ.normalize();
  if (kind === 'aerial' || kind === 'aerial-side') {
    // 구름층(y 76~108) 위에서 내려다본다. env 경로는 overheadFade 가 없어 빌보드가 온전하고,
    //   카메라가 구름에 가까워 fog(60~220) 세탁을 덜 받는다 → **상공 적운을 판정할 수 있는 유일한
    //   프레이밍**이다(지상 아이레벨에서는 적운이 200m 밖이라 대기에 씻겨 사라진다 — 실측).
    //   'aerial' 은 태양 쪽(역광), 'aerial-side' 는 직교(측광).
    const dir = kind === 'aerial-side' ? new THREE.Vector2(-sunXZ.y, sunXZ.x) : sunXZ;
    camera.position.set(-dir.x * 150, 168, -dir.y * 150);
    camera.lookAt(0, 40, 0);
    return;
  }
  // 상공 적운은 반경 40~124m·고도 76~108m 다. 반경 96m 에서 상향 0.24 로 잡으면 프레임 상단이
  //   32° 인데 구름 고도각이 40° 라 **구름이 프레임 위로 빠진다**(첫 실행 실측: 변화 픽셀 0.2%).
  //   거리를 늘려 고도각을 23° 로 낮추고 상향을 0.30 으로 올려 구름 밴드를 프레임 안에 담는다.
  const up = override?.up ?? 0.30;                   // 상향 피치(≈16.7°, 세로 화각 38°)
  const dir = kind === 'side'
    ? new THREE.Vector2(-sunXZ.y, sunXZ.x)           // 태양과 직교 = 측광
    : sunXZ.clone();                                  // 태양 쪽 = 역광
  const radius = override?.radius ?? (kind === 'side' ? 172 : 190);
  const eye = override?.eye ?? (kind === 'side' ? 22 : 16);
  camera.position.set(-dir.x * radius, eye, -dir.y * radius);
  camera.lookAt(camera.position.x + dir.x * 60, eye + 60 * up, camera.position.z + dir.y * 60);
}

// ── 구름 재질 A/B ───────────────────────────────────────────────────────────
const cloudHook = () => window.__clouds;
function setStrength(v) { cloudHook().setVolume({ strength: v }); }
function setVolume(opts) { return cloudHook().setVolume(opts); }

// ── 시선각 스윕 프로파일 ────────────────────────────────────────────────────
// 제품 빌보드는 항상 카메라를 보므로 "시선각"을 제품 경로에서 직접 쓸어볼 수 없다. 같은 재질을
//   회전 가능한 쿼드에 걸고 RGBA 렌더타깃에 그려 각도별 알파·휘도를 읽는다(재질·프로그램 공유 →
//   측정 대상이 제품과 동일한 셰이더다). 배경 알파 0 이라 실루엣 알파를 직접 읽을 수 있다.
const probeTarget = new THREE.WebGLRenderTarget(256, 256, {
  type: THREE.UnsignedByteType, colorSpace: THREE.SRGBColorSpace,
});
const probeScene = new THREE.Scene();
const probeCamera = new THREE.PerspectiveCamera(38, 1, 0.1, 2000);
let probeMesh = null;
function ensureProbe() {
  if (probeMesh) return probeMesh;
  const source = env.group.getObjectByName('high-cloud-0');
  const geo = new THREE.PlaneGeometry(source.geometry.parameters.width,
                                      source.geometry.parameters.height);
  probeMesh = new THREE.Mesh(geo, source.material);   // 재질 공유 = 같은 프로그램·같은 uniform
  probeScene.add(probeMesh);
  return probeMesh;
}
function probeAngles(label, angles) {
  const mesh = ensureProbe();
  const rows = [];
  const prevTarget = renderer.getRenderTarget();
  const prevAlpha = renderer.getClearAlpha();
  renderer.setClearAlpha(0);
  for (const deg of angles) {
    const rad = deg * Math.PI / 180;
    // 카메라는 쿼드 정면 거리 고정, 쿼드만 기울인다 → 화면 크기 변화 없이 시선각만 바뀐다.
    probeMesh.rotation.set(0, rad, 0);
    probeCamera.position.set(0, 0, 210);
    probeCamera.lookAt(0, 0, 0);
    renderer.setRenderTarget(probeTarget);
    renderer.clear();
    renderer.render(probeScene, probeCamera);
    const px = new Uint8Array(256 * 256 * 4);
    renderer.readRenderTargetPixels(probeTarget, 0, 0, 256, 256, px);
    rows.push({ deg, ...analyse(px) });
  }
  renderer.setRenderTarget(prevTarget);
  renderer.setClearAlpha(prevAlpha);
  return { label, rows };
}
function analyse(px) {
  let cover = 0, edge = 0, edgeN = 0, lumSum = 0, lumSq = 0, lumN = 0;
  const lum = new Float64Array(256 * 256);
  const alpha = new Float64Array(256 * 256);
  let peak = 0;
  for (let i = 0; i < 256 * 256; i++) {
    const a = px[i * 4 + 3] / 255;
    alpha[i] = a;
    if (a > peak) peak = a;
    // NormalBlending 을 알파 0 배경에 그리면 색이 src*a 로 남으므로 a 로 나눠 원색을 되찾는다.
    lum[i] = (0.2126 * px[i * 4] + 0.7152 * px[i * 4 + 1] + 0.0722 * px[i * 4 + 2]) / Math.max(a, 1e-3);
    cover += a;
  }
  // 임계는 **관측 최대 알파에 상대적**이어야 한다. 구름 재질의 opacity 는 시간대 dim 을 타서
  //   0.7 부근이 상한이므로 절대 0.90 임계로는 내부 픽셀이 0 개가 된다(첫 실행에서 실측 — 계측기
  //   버그를 한 번 의심하라는 레포 규약의 사례).
  const edgeLo = 0.10 * peak, edgeHi = 0.60 * peak, coreLo = 0.80 * peak;
  for (let i = 0; i < 256 * 256; i++) {
    if (alpha[i] > edgeLo && alpha[i] < edgeHi) { edge += alpha[i]; edgeN++; }
    if (alpha[i] > coreLo) { lumSum += lum[i]; lumSq += lum[i] * lum[i]; lumN++; }
  }
  const mean = lumN ? lumSum / lumN : 0;
  const varr = lumN ? Math.max(0, lumSq / lumN - mean * mean) : 0;
  return {
    peakAlpha: +peak.toFixed(3),
    coverage: +(cover / (256 * 256)).toFixed(5),
    edgeBandPx: edgeN,
    edgeMeanAlpha: +(edgeN ? edge / edgeN : 0).toFixed(4),
    interiorPx: lumN,
    interiorLuma: +mean.toFixed(2),
    interiorStdev: +Math.sqrt(varr).toFixed(3),
  };
}

// ── 직접 렌더 계측(프로그램 수·드로우콜) ────────────────────────────────────
function directRender() {
  renderer.info.autoReset = false;
  renderer.info.reset();
  renderer.render(scene, camera);
  const out = { calls: renderer.info.render.calls, programs: renderer.info.programs.length };
  renderer.info.autoReset = true;
  return out;
}

function step(dt) {
  env.update(dt);
  post.update(dt);
  post.composer.render();
}

// 렌더 직후 같은 태스크에서 읽는다. page.evaluate 를 나누면 그 사이에 브라우저 컴포짓이 끼어
//   드로잉 버퍼가 무효화된다(preserveDrawingBuffer 없음) — 과거 캡처 하네스 오진의 단골이다.
function readLuma() {
  const c = renderer.domElement;
  const gl = renderer.getContext();
  const px = new Uint8Array(c.width * c.height * 4);
  gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const n = c.width * c.height;
  const lum = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    lum[i] = 0.2126 * px[i * 4] + 0.7152 * px[i * 4 + 1] + 0.0722 * px[i * 4 + 2];
  }
  return lum;
}
function lumaStats(lum) {
  let s = 0;
  for (let i = 0; i < lum.length; i++) s += lum[i];
  const mean = s / lum.length;
  let q = 0;
  for (let i = 0; i < lum.length; i++) q += (lum[i] - mean) * (lum[i] - mean);
  return { px: lum.length, mean: +mean.toFixed(3), stdev: +Math.sqrt(q / lum.length).toFixed(3) };
}
function hashLuma(lum) {
  let h = 0x811c9dc5;
  for (let i = 0; i < lum.length; i++) h = ((h ^ Math.round(lum[i] * 4)) * 16777619) >>> 0;
  return h.toString(16);
}

window.__probe = {
  settle(time, frames = 40) {
    env.setTime(time, { immediate: true });
    post.setTime(time);
    for (let i = 0; i < frames; i++) step(1 / 60);
    return time;
  },
  frame(kind, override) { frame(kind, override); for (let i = 0; i < 4; i++) step(1 / 60); return kind; },
  render() { for (let i = 0; i < 3; i++) step(1 / 60); },
  setStrength, setVolume,
  probeAngles, directRender,
  defaults: () => ({ ...window.__clouds.defaults, maxSteps: window.__clouds.maxSteps }),
  layers: () => window.__clouds.layers.length,
  // 같은 프레임 안에서 v3→v4 를 교체해 두 프레임을 읽고 차이를 낸다(스왑 유효성 자가검사).
  abFrame() {
    setStrength(0); step(1 / 60);
    const a = readLuma();
    setStrength(1); step(1 / 60);
    const b = readLuma();
    let changed = 0, maxAbs = 0, sumAbs = 0;
    for (let i = 0; i < a.length; i++) {
      const d = Math.abs(a[i] - b[i]);
      sumAbs += d;
      if (d > maxAbs) maxAbs = d;
      if (d > 4) changed++;
    }
    // 변화 픽셀의 화면 박스(좌하 원점 → 위에서부터의 비율로 환산). 프레이밍이 실제로 구름을
    //   담고 있는지, 아니면 밴드를 놓쳤는지 한 번에 드러난다.
    const c = renderer.domElement;
    let x0 = c.width, x1 = -1, y0 = c.height, y1 = -1;
    for (let i = 0; i < a.length; i++) {
      if (Math.abs(a[i] - b[i]) <= 4) continue;
      const x = i % c.width, y = Math.floor(i / c.width);
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    return {
      v3: lumaStats(a), v4: lumaStats(b),
      changedFraction: +(changed / a.length).toFixed(5),
      meanAbsDiff: +(sumAbs / a.length).toFixed(3),
      maxAbsDiff: +maxAbs.toFixed(1),
      box: x1 < 0 ? null : {
        xFrom: +(x0 / c.width).toFixed(3), xTo: +(x1 / c.width).toFixed(3),
        topFrom: +(1 - y1 / c.height).toFixed(3), topTo: +(1 - y0 / c.height).toFixed(3),
      },
    };
  },
  // strength=0 불변식 검사용: **애니메이션을 진행시키지 않고** 같은 프레임을 다시 그려 해시한다.
  //   env.update 를 돌리면 모트·물·계절 트윈이 함께 흘러 유니폼과 무관하게 해시가 매번 바뀐다
  //   (첫 실행에서 실측 — 이걸 셰이더 탓으로 읽으면 멀쩡한 코드를 고치게 된다).
  renderHash() { post.composer.render(); return hashLuma(readLuma()); },
};
window.__READY = true;
</script></body></html>`;

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/' || url.pathname === '/probe.html') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(HTML);
    return;
  }
  try {
    const body = await readFile(join(ROOT, url.pathname));
    res.writeHead(200, { 'content-type': MIME[extname(url.pathname)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('nope');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const failures = [];
const pass = (ok, message, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${message}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures.push(message);
};

const browser = await launchVerificationBrowser();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => { console.error('PAGE ERROR', e.message); failures.push(`pageerror: ${e.message}`); });
page.on('console', (m) => { if (m.type() === 'error') console.error('CONSOLE', m.text()); });
await page.goto(`${base}/probe.html?shot=1`, { waitUntil: 'load' });
await reportWebGLRenderer(page, 'probe-cloud-v4');
await page.waitForFunction('window.__READY === true', { timeout: 120_000 });

const defaults = await page.evaluate('window.__probe.defaults()');
console.log('\n== v4 기본값 ==');
console.log(JSON.stringify(defaults));
pass(await page.evaluate('window.__probe.layers()') === 1, 'cloud volume hook registered', 'window.__clouds.layers=1');

// ── 1) 시선각 스윕 ──────────────────────────────────────────────────────────
await page.evaluate('window.__probe.settle("sunset", 50)');
await page.evaluate('window.__probe.frame("backlit")');
const ANGLES = [0, 15, 30, 45, 60];
await page.evaluate('window.__probe.setStrength(0)');
const sweepV3 = await page.evaluate(`window.__probe.probeAngles('v3', ${JSON.stringify(ANGLES)})`);
await page.evaluate('window.__probe.setStrength(1)');
const sweepV4 = await page.evaluate(`window.__probe.probeAngles('v4', ${JSON.stringify(ANGLES)})`);

console.log('\n== 시선각 스윕(sunset 역광, 상공 적운 재질 · 256² RGBA 렌더타깃) ==');
console.log('deg | coverage        | edgeBandPx    | edgeMeanAlpha | interiorLuma  | interiorStdev');
for (let i = 0; i < ANGLES.length; i++) {
  const a = sweepV3.rows[i], b = sweepV4.rows[i];
  console.log(`${String(a.deg).padStart(3)} | ${a.coverage.toFixed(5)}→${b.coverage.toFixed(5)} `
    + `| ${String(a.edgeBandPx).padStart(5)}→${String(b.edgeBandPx).padEnd(5)} `
    + `| ${a.edgeMeanAlpha.toFixed(4)}→${b.edgeMeanAlpha.toFixed(4)} `
    + `| ${a.interiorLuma.toFixed(2)}→${b.interiorLuma.toFixed(2)} `
    + `| ${a.interiorStdev.toFixed(3)}→${b.interiorStdev.toFixed(3)}`);
}
const spread = (rows, key) => {
  const v = rows.map((r) => r[key]);
  return +(Math.max(...v) - Math.min(...v)).toFixed(4);
};
const stdevV3 = sweepV3.rows.reduce((s, r) => s + r.interiorStdev, 0) / ANGLES.length;
const stdevV4 = sweepV4.rows.reduce((s, r) => s + r.interiorStdev, 0) / ANGLES.length;
console.log(`\n내부 휘도 stdev 평균: v3 ${stdevV3.toFixed(3)} → v4 ${stdevV4.toFixed(3)}`);
console.log(`시선각에 따른 내부 휘도 변화폭: v3 ${spread(sweepV3.rows, 'interiorLuma')} → v4 ${spread(sweepV4.rows, 'interiorLuma')}`);
console.log(`시선각에 따른 외곽 밴드 폭 변화: v3 ${spread(sweepV3.rows, 'edgeBandPx')} → v4 ${spread(sweepV4.rows, 'edgeBandPx')}`);
// 프런티어 1.10× 는 실측(2026-08-04, sunset 역광 적운 재질, 5각도 평균 v3 17.841 → v4 20.406 =
//   1.144×)에서 여유를 둔 값이다. v4 이전 소스에서는 두 값이 같은 코드라 비율이 정확히 1.000 이므로
//   이 단언은 수정 전 소스에서 반드시 실패한다(FAIL-first 확인). 역광 프레임은 투과광이 바디를
//   지배해 변조 여지가 가장 좁은 조건이라 이 값이 하한이다.
pass(stdevV4 > stdevV3 * 1.10, '내부 명암 변조가 증가(내부 휘도 stdev)',
  `v3 ${stdevV3.toFixed(3)} → v4 ${stdevV4.toFixed(3)} (${(stdevV4 / stdevV3).toFixed(3)}×)`);
pass(spread(sweepV4.rows, 'interiorLuma') > spread(sweepV3.rows, 'interiorLuma'),
  '내부 명암이 시선각에 의존(두께·시차 존재)',
  `v3 ${spread(sweepV3.rows, 'interiorLuma')} → v4 ${spread(sweepV4.rows, 'interiorLuma')}`);
// [재핀 2026-08-04, S6 실루엣 라운드] 원판은 v4 > v3 상대 비교였으나, S6부터 윤곽 완화의
// 주 공급원이 마칭이 아니라 베이크 wisp 외곽으로 이동해 전제가 깨졌다(v3 2388 / v4 2297 —
// 절대폭은 S4 시점 1180px 대비 1.95배). 완화 계약 자체는 절대 하한으로 유지한다.
// FAIL-first: S6 소스에서 원판 단언이 실제 FAIL(2297 < 2388)함을 확인하고 교체.
const EDGE_BAND_FLOOR_PX = 1180; // S4(a3d73a3) v4 실측 — 종이 컷아웃으로 되돌아가면 이 밑으로 떨어진다
pass(sweepV4.rows[0].edgeBandPx >= EDGE_BAND_FLOOR_PX,
  '외곽 알파 램프가 절대 하한 이상(종이 컷아웃 윤곽 완화 유지)',
  `v4 ${sweepV4.rows[0].edgeBandPx}px (하한 ${EDGE_BAND_FLOOR_PX}px, v3 ${sweepV3.rows[0].edgeBandPx}px)`);

// 자기그림자: 태양 방향(뷰공간)을 뒤집어 같은 쿼드를 다시 재면 v4 만 내부 패턴이 바뀐다.
async function litSignature(strength) {
  await page.evaluate(`window.__probe.setStrength(${strength})`);
  return page.evaluate(`window.__probe.probeAngles('lit', [30])`);
}
const litV3 = (await litSignature(0)).rows[0];
const litV4 = (await litSignature(1)).rows[0];
console.log(`\n30° 프로파일 v3 vs v4: interiorLuma ${litV3.interiorLuma} → ${litV4.interiorLuma}, `
  + `stdev ${litV3.interiorStdev} → ${litV4.interiorStdev}, coverage ${litV3.coverage} → ${litV4.coverage}`);

// ── 2) strength=0 불변식 ────────────────────────────────────────────────────
await page.evaluate('window.__probe.setStrength(0)');
const hashBase = await page.evaluate('window.__probe.renderHash()');
const hashControl = await page.evaluate('window.__probe.renderHash()');
pass(hashControl === hashBase, '계측기 자기검사: 같은 uniform 은 같은 해시',
  `${hashBase} vs ${hashControl}`);
const shakes = [
  { steps: 4 }, { steps: 16 }, { thickness: 1.4 }, { optical: 12 },
  { amp: 1 }, { alphaBlend: 1 }, { lightK: 8 },
];
let invariant = true;
for (const shake of shakes) {
  await page.evaluate(`window.__probe.setVolume(${JSON.stringify(shake)})`);
  const h = await page.evaluate('window.__probe.renderHash()');
  if (h !== hashBase) { invariant = false; console.log(`  strength=0 흔들림 감지: ${JSON.stringify(shake)} → ${h}`); }
}
console.log(`\nstrength=0 픽셀 해시: ${hashBase} (7가지 v4 파라미터 스윕 전부 동일=${invariant})`);
pass(invariant, 'strength=0 은 v4 파라미터에 완전 불변(v3 셰이딩 보존)', hashBase);
await page.evaluate(`window.__probe.setVolume(${JSON.stringify(defaults)})`);

// ── 3) 프로그램 수·드로우콜 델타 ────────────────────────────────────────────
await page.evaluate('window.__probe.setStrength(0)');
await page.evaluate('window.__probe.render()');
const infoV3 = await page.evaluate('window.__probe.directRender()');
await page.evaluate('window.__probe.setStrength(1)');
await page.evaluate('window.__probe.render()');
const infoV4 = await page.evaluate('window.__probe.directRender()');
await page.evaluate('window.__probe.setVolume({ steps: 8 })');
await page.evaluate('window.__probe.render()');
const infoV4Mobile = await page.evaluate('window.__probe.directRender()');
await page.evaluate(`window.__probe.setVolume(${JSON.stringify(defaults)})`);
console.log('\n== 직접 렌더 계측 ==');
console.log(`v3(strength 0)     calls ${infoV3.calls} programs ${infoV3.programs}`);
console.log(`v4(strength 1)     calls ${infoV4.calls} programs ${infoV4.programs}`);
console.log(`v4 8스텝 강등       calls ${infoV4Mobile.calls} programs ${infoV4Mobile.programs}`);
pass(infoV4.calls === infoV3.calls, '드로우콜 델타 0', `${infoV3.calls} → ${infoV4.calls}`);
pass(infoV4.programs === infoV3.programs, '프로그램 수 델타 0', `${infoV3.programs} → ${infoV4.programs}`);
pass(infoV4Mobile.programs === infoV3.programs && infoV4Mobile.calls === infoV3.calls,
  '스텝 강등도 프로그램·드로우콜 불변(uniform 강등, 프로그램 분기 없음)',
  `${infoV4Mobile.calls}/${infoV4Mobile.programs}`);

// ── 3.5) 프레이밍 정찰(구름이 실제로 프레임에 있는지) ───────────────────────
if (process.argv.includes('--scout')) {
  await page.evaluate('window.__probe.settle("sunset", 50)');
  console.log('\n== backlit 정찰(sunset) ==');
  for (const radius of [100, 130, 160]) {
    for (const up of [0.14, 0.26, 0.38, 0.50]) {
      await page.evaluate(`window.__probe.frame('backlit', ${JSON.stringify({ radius, up, eye: 14 })})`);
      const ab = await page.evaluate('window.__probe.abFrame()');
      console.log(`r=${radius} up=${up}  변화픽셀 ${(ab.changedFraction * 100).toFixed(2)}% `
        + `최대|Δ| ${ab.maxAbsDiff} mean ${ab.v3.mean} box ${JSON.stringify(ab.box)}`);
    }
  }
}

// ── 4) 대표컷 A/B (같은 부팅) ───────────────────────────────────────────────
// 지상 프레이밍의 반경·피치는 정찰(--scout)로 고른 값이다: r=100/up=0.14 이 능선 위 구름 밴드를
//   프레임에 담으면서(변화 픽셀 최대) 하늘이 흰색으로 날아가지 않는 유일한 구간이었다.
const GROUND_BACKLIT = { radius: 100, up: 0.14, eye: 14 };
const GROUND_SIDE = { radius: 100, up: 0.20, eye: 22 };
const FRAMINGS = [
  { id: 'aerial-sunset', time: 'sunset', kind: 'aerial' },          // 부감 역광 — 적운 판정 주력
  { id: 'aerial-day', time: 'day', kind: 'aerial-side' },           // 부감 측광
  { id: 'backlit-sunset', time: 'sunset', kind: 'backlit', override: GROUND_BACKLIT },
  { id: 'side-day', time: 'day', kind: 'side', override: GROUND_SIDE },
  { id: 'backlit-dawn', time: 'dawn', kind: 'backlit', override: GROUND_BACKLIT },
];
const shots = [];
console.log('\n== 대표컷 A/B (같은 부팅, uniform 교체) ==');
for (const f of FRAMINGS) {
  await page.evaluate(`window.__probe.settle(${JSON.stringify(f.time)}, 50)`);
  await page.evaluate(`window.__probe.frame(${JSON.stringify(f.kind)}, ${JSON.stringify(f.override || null)})`);
  // 스왑 유효성 자가검사: 같은 프레임에서 uniform 만 바꿔 두 버퍼를 읽는다. 변화 픽셀 비율이
  //   바닥이면 "보이지 않는 구름 그룹에 스왑이 적중한" 무효 A/B 다(과거 사고).
  const ab = await page.evaluate('window.__probe.abFrame()');
  const paths = {};
  for (const [tag, strength] of [['v3', 0], ['v4', 1]]) {
    await page.evaluate(`window.__probe.setStrength(${strength})`);
    await page.evaluate('window.__probe.render()');
    const file = join(OUT, `${f.id}-${tag}.png`);
    await writeFile(file, await page.screenshot());
    paths[tag] = file;
  }
  console.log(`${f.id.padEnd(16)} v3 mean ${ab.v3.mean} stdev ${ab.v3.stdev} `
    + `→ v4 mean ${ab.v4.mean} stdev ${ab.v4.stdev}  `
    + `변화픽셀 ${(ab.changedFraction * 100).toFixed(2)}% · 평균|Δ| ${ab.meanAbsDiff} · 최대|Δ| ${ab.maxAbsDiff} `
    + `· box ${JSON.stringify(ab.box)}`);
  // 스왑 적중의 판정 신호는 **최대 |Δ|** 다: 보이지 않는 그룹에 적중하면 정확히 0 이 나온다(과거 무효
  //   A/B 사고의 지문). 변화 픽셀 비율은 크기 정보이지 적중 여부가 아니다 — 아이레벨 프레임에서
  //   구름 밴드는 화면의 1% 미만이고 대기에 씻겨 대비도 낮아, 적중해도 비율은 작게 나온다.
  pass(ab.maxAbsDiff > 8 && ab.changedFraction > 0.0005,
    `${f.id}: A/B 스왑이 보이는 구름 픽셀에 적중`,
    `최대|Δ| ${ab.maxAbsDiff}, 변화픽셀 ${(ab.changedFraction * 100).toFixed(2)}%`);
  shots.push({ ...f, paths, ab });
}

console.log('\n== 대표컷 경로 ==');
for (const s of shots) console.log(`${s.id}: ${s.paths.v3} | ${s.paths.v4}`);

await browser.close();
server.close();
console.log(`\n${failures.length ? `FAIL ${failures.length}` : 'ALL PASS'}`);
if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exitCode = 1; }
