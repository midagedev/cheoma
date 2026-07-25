import { createServer } from 'node:http';
import { readFile, mkdtemp } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { PNG } from 'pngjs';
import {
  launchVerificationBrowser,
  reportWebGLRenderer,
} from './lib/verification-browser.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
};
const invariant = (condition, message) => {
  if (!condition) throw new Error(message);
};

const PRODUCT_HTML = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#c5d0d1}canvas{display:block}</style>
<script type="importmap">{"imports":{
  "three":"/app/node_modules/three/build/three.module.js",
  "three/addons/":"/app/node_modules/three/examples/jsm/"
}}</script></head><body><script type="module">
import * as THREE from 'three';
import { createVillage } from '/src/village/adapter.js';
import { setupGrass } from '/src/env/grass.js';

const params = new URLSearchParams(location.search);
const view = params.get('view') || 'close';
const withGrass = params.get('grass') === '1';
const wallOnly = params.get('wall') === 'only';
const wallNone = params.get('wall') === 'none';
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(1);
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.04;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xc5d0d1);
const handle = createVillage({ scale: 'village', seed: 1, character: 'yeoyeom' });
scene.add(handle.group);
const target = handle.plan.parcels.find((parcel) => parcel.id === 'p3');
if (!target || target.wallType !== 'mud') throw new Error('product mud-wall fixture p3 drifted');
handle.rebuildParcel(target.id, {});
const inspectionLayers = new Set([
  'village-terrain',
  'village-pads',
  'village-roads',
  'village-overrides',
]);
for (const child of handle.group.children) child.visible = inspectionLayers.has(child.name);

// 근경 판독 축(§7.5 W3 게이트 확장): 같은 고정 카메라에서 (a) 담을 지운 프레임 (b) 담만 있는 프레임
//   (c) focus 링 풀까지 올린 프레임을 찍어, 담 하부 띠에서 담의 기여가 풀에 지워지지 않는지 본다.
//   plan record 수·envelope·해시로는 "3m 에서 보이는가"를 잡을 수 없다는 것이 A4 의 교훈이다.
const overrides = handle.group.getObjectByName('village-overrides');
let parcelRoot = null;
overrides?.traverse((object) => {
  if (!parcelRoot && Number.isFinite(object.userData?.W)) parcelRoot = object;
});
if (wallNone && overrides) overrides.visible = false;
if (wallOnly && overrides) {
  // 담 링만 남긴다(몸채·마당 소품 제외) — 담의 순수 기여를 재는 기준 프레임.
  (parcelRoot || overrides).traverse((object) => {
    if (typeof object.name === 'string' && object.name.startsWith('wall-')) object.userData.__keepWall = true;
  });
  for (const child of (parcelRoot || overrides).children) {
    child.visible = !!child.userData.__keepWall;
  }
}
let grass = null;
if (withGrass && parcelRoot) {
  parcelRoot.updateWorldMatrix(true, false);
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  parcelRoot.matrixWorld.decompose(position, quaternion, scale);
  grass = setupGrass(scene, {
    bounds: { W: parcelRoot.userData.W, D: parcelRoot.userData.D },
    matrix: new THREE.Matrix4().compose(position, quaternion, new THREE.Vector3(1, 1, 1)),
    style: parcelRoot.userData.style || 'choga',
    seed: 4343,
    season: 'summer',
  });
  grass.setFade(1);
}

const sun = new THREE.DirectionalLight(0xffd2a1, 3.6);
sun.position.set(target.center.x - 18, target.baseY + 24, target.center.z + 17);
sun.target.position.set(target.center.x, target.baseY + 1, target.center.z);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
Object.assign(sun.shadow.camera, { left: -25, right: 25, top: 25, bottom: -25, near: 1, far: 80 });
scene.add(sun, sun.target);
scene.add(new THREE.HemisphereLight(0xe2e8df, 0x645540, 1.3));
scene.fog = new THREE.Fog(scene.background, 75, 180);

const front = target.frontDir;
const right = { x: front.z, z: -front.x };
const span = Math.max(target.plotW, target.plotD);
// 'base' 는 §7.5 W3 이 요구한 고정 근경 판독 카메라다. 앞담 바깥 2.4m·눈높이 2.35m 에서 담 밑동을
//   내려다본다 — 감사 컷 mudwall-p2-base(2.4m)와 같은 척도다. 눈높이 수평 프레임은 아무리
//   낮은 잔풀도 담에 겹쳐 투영되므로 키 차이를 판정하지 못한다. 'close'(≈20m 오블리크)로는
//   "돌 굽·습윤 흔적이 보이는가"를 판정할 수 없다.
const camera = new THREE.PerspectiveCamera(
  view === 'aerial' ? 36 : view === 'base' ? 40 : 28, innerWidth / innerHeight, 0.12, 260,
);
if (view === 'base') {
  const wallZ = target.plotD / 2;
  camera.position.set(
    target.center.x + front.x * (wallZ + 2.4) + right.x * 0.8,
    target.baseY + 2.35,
    target.center.z + front.z * (wallZ + 2.4) + right.z * 0.8,
  );
  camera.lookAt(
    target.center.x + front.x * wallZ,
    target.baseY + 0.22,
    target.center.z + front.z * wallZ,
  );
} else {
  const distance = view === 'aerial' ? span * 3.2 : span * 1.15;
  camera.position.set(
    target.center.x + front.x * distance + right.x * distance * 0.78,
    target.baseY + (view === 'aerial' ? span * 2.1 : Math.max(3.8, span * 0.24)),
    target.center.z + front.z * distance + right.z * distance * 0.78,
  );
  camera.lookAt(
    target.center.x + front.x * target.plotD * 0.28,
    target.baseY + (view === 'aerial' ? 0.5 : 1.05),
    target.center.z + front.z * target.plotD * 0.28,
  );
}

let frames = 0;
renderer.setAnimationLoop(() => {
  handle.update(1 / 60);
  // grass.update 는 부러 부르지 않는다 — 바람 흔들림이 프레임 18 의 실루엣을 흔들어 rise 판정에
  //   ±2%p 지터를 넣는다. 흔들림 자체는 shoot:focus 계열이 보고, 여기선 정지 실루엣만 판정한다.
  renderer.render(scene, camera);
  if (++frames !== 18) return;
  let bodies = 0;
  let fibres = 0;
  let enabled = 0;
  handle.group.traverse((object) => {
    if (object.name === 'mud-wall-body') {
      bodies++;
      if (object.userData.mudWallSurface?.enabled) enabled++;
    }
    if (object.name === 'mud-wall-fibres') fibres++;
  });
  window.__MUD_WALL_PRODUCT = {
    view,
    grass: !!grass,
    wallOnly,
    grassTufts: grass?.drawInfo?.instances ?? null,
    parcelId: target.id,
    wallType: target.wallType,
    bodies,
    fibres,
    enabled,
    calls: renderer.info.render.calls,
    triangles: renderer.info.render.triangles,
    programs: renderer.info.programs.length,
  };
  // 이 진단 프레임에서 루프를 멈춘다. 이후로도 계속 렌더하면 스크린샷 시점의 LOD 스왑 상태가 페이지
  //   로드마다 달라져 픽셀 판정이 재현되지 않는다(실측: 같은 코드로 rise 41~67% 요동).
  renderer.setAnimationLoop(null);
});
</script></body></html>`;

const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    if (pathname === '/favicon.ico') {
      response.writeHead(204);
      response.end();
      return;
    }
    if (pathname === '/__mud_wall_product') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(PRODUCT_HTML);
      return;
    }
    const file = resolve(
      ROOT,
      `.${pathname === '/' ? '/tools/mud-wall-surface-harness.html' : pathname}`,
    );
    if (file !== ROOT && !file.startsWith(`${ROOT}${sep}`)) throw new Error('unsafe path');
    const body = await readFile(file);
    response.writeHead(200, {
      'content-type': MIME[extname(file)] || 'application/octet-stream',
    });
    response.end(body);
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('not found');
  }
});
await new Promise((done, reject) =>
  server.listen(0, '127.0.0.1', done).on('error', reject));

// band: [상단 비율, 하단 비율] — 생략하면 전 프레임. 담 하부 띠(예: [0.55, 0.95])만 재면
// "authored 디테일이 다른 시스템에 지워졌는가"를 프레임 전체 평균에 희석되지 않게 볼 수 있다.
function meanDifference(leftBuffer, rightBuffer, band = null) {
  const left = PNG.sync.read(leftBuffer);
  const right = PNG.sync.read(rightBuffer);
  invariant(
    left.width === right.width && left.height === right.height,
    'mud-wall frame dimensions drifted',
  );
  const y0 = band ? Math.round(left.height * band[0]) : 0;
  const y1 = band ? Math.round(left.height * band[1]) : left.height;
  let total = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = 0; x < left.width; x++) {
      const offset = (y * left.width + x) * 4;
      total += Math.abs(left.data[offset] - right.data[offset]);
      total += Math.abs(left.data[offset + 1] - right.data[offset + 1]);
      total += Math.abs(left.data[offset + 2] - right.data[offset + 2]);
    }
  }
  return total / (Math.max(1, y1 - y0) * left.width * 3);
}

// 풀이 담을 "어디까지" 덮는가. 감사(§7.3 A4)의 실제 주장은 면적이 아니라 높이였다 — "담 하부 30%를
// 가린다". 평균 픽셀차나 실루엣 면적비로는 짧고 촘촘한 잔풀과 길고 성긴 포기가 구별되지 않고(접촉
// 그림자까지 세므로 오히려 역전된다), 담 밑동이 보이는지도 알 수 없다. 그래서 열(column)마다 담
// 실루엣의 세로 구간을 잡고, 풀이 덮은 가장 높은 지점이 그 구간의 몇 %인지를 재서 평균한다.
function grassRiseOverWall(noWallBuffer, wallOnlyBuffer, baseBuffer, grassBuffer, band) {
  const noWall = PNG.sync.read(noWallBuffer);
  const wallOnly = PNG.sync.read(wallOnlyBuffer);
  const base = PNG.sync.read(baseBuffer);
  const grass = PNG.sync.read(grassBuffer);
  const { width, height } = noWall;
  for (const frame of [wallOnly, base, grass]) {
    invariant(frame.width === width && frame.height === height,
      'mud-wall frame dimensions drifted');
  }
  // 접촉 그림자·AA 를 세지 않도록 임계를 높게 둔다(풀 실루엣은 담보다 훨씬 밝거나 어둡다).
  const changed = (left, right, offset, limit) => (
    Math.abs(left.data[offset] - right.data[offset])
    + Math.abs(left.data[offset + 1] - right.data[offset + 1])
    + Math.abs(left.data[offset + 2] - right.data[offset + 2])
  ) > limit;
  const y0 = Math.round(height * band[0]);
  const y1 = Math.round(height * band[1]);
  let columns = 0;
  let riseTotal = 0;
  let maskPixels = 0;
  let footMask = 0;
  let footCovered = 0;
  for (let x = 0; x < width; x++) {
    let top = -1;
    let bottom = -1;
    for (let y = y0; y < y1; y++) {
      const offset = (y * width + x) * 4;
      if (!changed(noWall, wallOnly, offset, 36)) continue;
      if (top < 0) top = y;
      bottom = y;
      maskPixels++;
    }
    const span = bottom - top;
    if (span < 40) continue;                     // 담이 얇게 스치는 열은 판정에서 제외
    columns++;
    let grassTop = -1;
    for (let y = top; y <= bottom; y++) {
      const offset = (y * width + x) * 4;
      const next = ((y + 1) * width + x) * 4;
      // 세로로 이어진 2픽셀만 인정 → 단발 AA 픽셀 제외.
      if (changed(base, grass, offset, 96) && changed(base, grass, next, 96)) { grassTop = y; break; }
    }
    if (grassTop >= 0) riseTotal += (bottom - grassTop) / span;
    // 막돌 굽 띠(하부 38%)에서 담이 풀에 덮인 픽셀 비율 — "돌 굽이 보이는가"의 직접 측정.
    const footTop = bottom - Math.round(span * 0.38);
    for (let y = footTop; y <= bottom; y++) {
      const offset = (y * width + x) * 4;
      if (!changed(noWall, wallOnly, offset, 36)) continue;
      footMask++;
      if (changed(base, grass, offset, 96)) footCovered++;
    }
  }
  return {
    columns,
    maskPixels,
    rise: riseTotal / Math.max(1, columns),
    footCoverage: footCovered / Math.max(1, footMask),
    footMask,
  };
}

const output = process.env.CHEOMA_CAPTURE_DIR
  || await mkdtemp(join(tmpdir(), 'cheoma-mud-wall-'));
const browser = await launchVerificationBrowser();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (error) => errors.push(`page: ${error.message}`));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(`console: ${message.text()}`);
});
const port = server.address().port;

async function capture(mode, view = 'close') {
  await page.goto(
    `http://127.0.0.1:${port}/tools/mud-wall-surface-harness.html?mode=${mode}&view=${view}`,
    { waitUntil: 'load' },
  );
  await page.waitForFunction(() => window.__MUD_WALL_READY === true, null, {
    timeout: 60_000,
  });
  const diag = await page.evaluate(() => window.__MUD_WALL_DIAG);
  const path = join(output, `mud-wall-${view}-${mode}.png`);
  const buffer = await page.locator('canvas').screenshot({ path });
  return { mode, view, diag, path, buffer };
}

async function captureProduct(view, extra = '', label = view) {
  await page.goto(
    `http://127.0.0.1:${port}/__mud_wall_product?view=${view}${extra}`,
    { waitUntil: 'load' },
  );
  await page.waitForFunction(() => window.__MUD_WALL_PRODUCT, null, {
    timeout: 60_000,
  });
  const diag = await page.evaluate(() => window.__MUD_WALL_PRODUCT);
  const path = join(output, `mud-wall-product-${label}.png`);
  const buffer = await page.locator('canvas').screenshot({ path });
  return { view, diag, path, buffer };
}

try {
  const close = {};
  for (const mode of ['base', 'no-packed', 'no-fibres', 'no-damp', 'full']) {
    close[mode] = await capture(mode);
  }
  const aerialBase = await capture('base', 'aerial');
  const aerialFull = await capture('full', 'aerial');
  const productClose = await captureProduct('close');
  const productAerial = await captureProduct('aerial');
  // 고정 근경 카메라(base, 담 바깥 2.6m) 4연: 담+마당 / 담만 / 담 없음 / 담+focus 링 풀.
  const productBase = await captureProduct('base', '', 'base');
  const productWallOnly = await captureProduct('base', '&wall=only', 'base-wall-only');
  const productNoWall = await captureProduct('base', '&wall=none', 'base-no-wall');
  const productGrass = await captureProduct('base', '&grass=1', 'base-grass');
  const full = close.full.diag;

  invariant(errors.length === 0, errors.join(' | '));
  invariant(full.insideEnvelope, `detail escaped wall envelope ${JSON.stringify(full.bounds)}`);
  invariant(full.plan.lifts >= 2 && full.plan.joints === full.plan.lifts - 1,
    `packed lift plan is incomplete ${JSON.stringify(full.plan)}`);
  invariant(full.plan.fibres > 0 && full.plan.damp === 2,
    `fibre/damp plan is incomplete ${JSON.stringify(full.plan)}`);
  invariant(full.disposalCounts.body === 1 && full.disposalCounts.fibres === 1,
    `owned geometry lifecycle failed ${JSON.stringify(full.disposalCounts)}`);
  invariant(full.materialTextures === 0,
    `mud-wall geometry unexpectedly required material textures (${full.materialTextures})`);
  invariant(full.bodyTriangles <= 3_000 && full.fibreTriangles <= 500,
    `mud-wall geometry exceeded bounded fixture budget ${JSON.stringify(full)}`);
  invariant(full.programs <= close.base.diag.programs + 2,
    `mud-wall added too many program families (${close.base.diag.programs} -> ${full.programs})`);

  const deltas = {
    full: meanDifference(close.base.buffer, close.full.buffer),
    packed: meanDifference(close['no-packed'].buffer, close.full.buffer),
    fibres: meanDifference(close['no-fibres'].buffer, close.full.buffer),
    damp: meanDifference(close['no-damp'].buffer, close.full.buffer),
    aerial: meanDifference(aerialBase.buffer, aerialFull.buffer),
  };
  invariant(deltas.full >= 0.3, `full mud-wall detail is not visible (${deltas.full.toFixed(3)})`);
  invariant(deltas.packed >= 0.03, `packed lifts are not visible (${deltas.packed.toFixed(3)})`);
  invariant(deltas.fibres >= 0.005, `physical fibres are not visible (${deltas.fibres.toFixed(3)})`);
  invariant(deltas.damp >= 0.01, `lower damp tone is not visible (${deltas.damp.toFixed(3)})`);
  invariant(deltas.aerial < deltas.full,
    `detail did not reduce with distance (${deltas.full.toFixed(3)} -> ${deltas.aerial.toFixed(3)})`);
  for (const product of [productClose, productAerial, productBase]) {
    invariant(product.diag.wallType === 'mud'
      && product.diag.bodies > 0
      && product.diag.bodies === product.diag.enabled
      && product.diag.fibres > 0,
    `product mud-wall contribution is missing ${JSON.stringify(product.diag)}`);
  }

  // ── 고정 근경 카메라 판독 축(§7.5 W3 게이트 확장) ────────────────────────────
  // plan record 수·envelope·해시 검사는 authored 디테일이 "3m 에서 보이는가"를 전혀 보지 않는다.
  // A4 는 그 공백에서 나왔다: 계약은 전부 통과하는데 화면의 담 하부는 focus 링 풀이 양면으로
  // 덮고 있었다. 그래서 같은 고정 카메라에서 담 하부 띠의 픽셀만 두 번 비교한다.
  // 마스크는 프레임 전체에서 잡는다 — 담의 진짜 세로 구간(이엉 coping 위 ~ 막돌 굽 아래)을 알아야
  //   "풀이 담의 몇 % 높이까지 올라왔는가"가 의미를 갖는다. 띠로 자르면 분모가 띠가 되어 항상 100%다.
  const LOWER_BAND = [0, 1];
  const silhouette = grassRiseOverWall(
    productNoWall.buffer, productWallOnly.buffer,
    productBase.buffer, productGrass.buffer, LOWER_BAND,
  );
  const closeup = {
    // 담 자체가 그 띠를 실제로 칠하는 양(담 없음 ↔ 담만) — 담이 프레임에 있다는 확인.
    wall: meanDifference(productNoWall.buffer, productWallOnly.buffer, LOWER_BAND),
    grassFrame: meanDifference(productBase.buffer, productGrass.buffer),
    maskPixels: silhouette.maskPixels,
    columns: silhouette.columns,
    rise: silhouette.rise,
    occlusion: silhouette.footCoverage,
    footMask: silhouette.footMask,
  };
  invariant(productGrass.diag.grass && productGrass.diag.grassTufts > 0,
    `close-range grass fixture did not build (${JSON.stringify(productGrass.diag)})`);
  invariant(closeup.wall >= 6,
    `product mud wall barely paints its own lower band (${closeup.wall.toFixed(2)})`);
  invariant(closeup.maskPixels >= 20_000,
    `mud-wall silhouette is too small to judge at close range (${closeup.maskPixels}px)`);
  invariant(closeup.grassFrame >= 0.4,
    `grass ring is not present in the close frame (${closeup.grassFrame.toFixed(3)})`);
  // 판정 축은 막돌 굽 띠 가림률(footCoverage)이다. 2026-07-25 라운드에서 후보 세 개를 실측으로
  // 버렸다 — 이 기록을 남겨 다음 라운드가 같은 길을 다시 걷지 않게 한다:
  //   · 하부 띠 mean pixel delta: 짧고 촘촘한 잔풀과 길고 성긴 포기를 구별하지 못하고 오히려 역전된다
  //     (전자가 접촉 픽셀이 더 많다).
  //   · 실루엣 전체 면적 가림률: 접촉 그림자까지 세어 회귀 유무가 0.5%p 안에 붙는다.
  //   · 열별 "풀이 올라온 최고 높이"(rise): 회귀와 7%p 벌어지지만 열마다 min 스캔인 극값이라
  //     같은 코드에서 41~67% 로 요동한다(프레임 고정·바람 정지로도 안 잡힘) → 게이트로 못 쓴다.
  // footCoverage 는 재현된다(반복 실측 15.0~16.6%). 다만 이 축은 회귀 상태에서도 16.1% 로,
  //   §7.4-8 같은 "미묘한" 가림은 잡지 못한다. 상한 30%는 굽이 통째로 묻히는 총체적 회귀만 막는
  //   경보선이다. 이 fixture 는 포기 478개로 제품 focus 링(최대 1200)보다 성기다는 한계도 같이 있다.
  //   미묘한 축은 아래 captures 의 base-* PNG 를 사람·비전이 보고 판정한다.
  invariant(closeup.occlusion <= 0.30,
    'focus grass ring buries the mud-wall stone foot at close range '
    + `(${(closeup.occlusion * 100).toFixed(1)}% of ${closeup.footMask}px, ceiling 30%)`);

  await reportWebGLRenderer(page, 'mud-wall');
  console.log(
    `MUD WALL BROWSER: PASS (delta full/packed/fibre/damp/aerial=`
    + `${deltas.full.toFixed(3)}/${deltas.packed.toFixed(3)}/`
    + `${deltas.fibres.toFixed(3)}/${deltas.damp.toFixed(3)}/`
    + `${deltas.aerial.toFixed(3)}, triangles body/fibre=`
    + `${full.bodyTriangles}/${full.fibreTriangles}, programs=`
    + `${close.base.diag.programs}->${full.programs}, materialTextures=`
    + `${full.materialTextures}, rendererTextures=${full.rendererTextures})`,
  );
  console.log(
    `product close/aerial calls=${productClose.diag.calls}/${productAerial.diag.calls}, `
    + `triangles=${productClose.diag.triangles}/${productAerial.diag.triangles}, `
    + `programs=${productClose.diag.programs}/${productAerial.diag.programs}`,
  );
  console.log(
    `close-range (base 2.4m): wall=${closeup.wall.toFixed(2)} silhouette=${closeup.maskPixels}px `
    + `footCoverage=${(closeup.occlusion * 100).toFixed(1)}% (ceiling 30%) rise~${(closeup.rise * 100).toFixed(1)}%[unstable] `
    + `grassFrame=${closeup.grassFrame.toFixed(3)} tufts=${productGrass.diag.grassTufts}`,
  );
  console.log(`captures=${output}`);
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
