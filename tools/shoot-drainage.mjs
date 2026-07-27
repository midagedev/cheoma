import { createServer } from 'node:http';
import { readFile, mkdtemp } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { PNG } from 'pngjs';
import {
  launchVerificationBrowser,
  reportWebGLRenderer,
} from './lib/verification-browser.mjs';

const ROOT = process.env.CHEOMA_REPO_ROOT
  ? resolve(process.env.CHEOMA_REPO_ROOT)
  : resolve(import.meta.dirname, '..');
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

const OPTIONS = Object.freeze({
  scale: 'capital',
  seed: 11,
  character: 'yeoyeom',
});
const renderer = new THREE.WebGLRenderer({
  antialias: true,
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(1);
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.04;
renderer.shadowMap.enabled = false;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xc5d0d1);
scene.fog = new THREE.Fog(scene.background, 100, 360);
const handle = createVillage(OPTIONS);
scene.add(handle.group);

const drainagePlan = handle.plan?.drainage;
if (!drainagePlan?.runs?.length) throw new Error('capital/11 drainage plan has no runs');
if (!drainagePlan.crossings?.length) {
  throw new Error('capital/11 drainage fixture has no gate crossing');
}
const drainage = handle.group.getObjectByName('roadside-drainage-ground');
if (!drainage) throw new Error('populated village is missing roadside-drainage-ground');
const ditchMesh = drainage.getObjectByName('road-drainage-ground');
const crossingMesh = drainage.getObjectByName('road-drainage-stone-crossings');
if (!ditchMesh || !crossingMesh) throw new Error('drainage named meshes are incomplete');

const target = drainagePlan.crossings[0];
const gateDelta = {
  x: target.gatePoint.x - target.center.x,
  z: target.gatePoint.z - target.center.z,
};
const gateDistance = Math.hypot(gateDelta.x, gateDelta.z);
const towardGate = {
  x: gateDelta.x / gateDistance,
  z: gateDelta.z / gateDistance,
};
const right = { x: towardGate.z, z: -towardGate.x };
const camera = new THREE.PerspectiveCamera(30, innerWidth / innerHeight, 0.05, 420);

const sun = new THREE.DirectionalLight(0xffd1a0, 3.4);
sun.position.set(
  target.center.x - 28,
  target.center.y + 38,
  target.center.z + 24,
);
sun.target.position.set(target.center.x, target.center.y, target.center.z);
scene.add(sun, sun.target);
scene.add(new THREE.HemisphereLight(0xe2e8df, 0x62543f, 1.35));

function setView(view) {
  if (view === 'aerial') {
    const targetX = target.center.x + gateDelta.x * 0.5;
    const targetZ = target.center.z + gateDelta.z * 0.5;
    camera.fov = 40;
    camera.position.set(
      targetX - towardGate.x * 24 + right.x * 19,
      target.center.y + 28,
      targetZ - towardGate.z * 24 + right.z * 19,
    );
    camera.lookAt(targetX, target.center.y + 0.1, targetZ);
  } else {
    const cameraBack = Math.max(7.5, Math.min(10, gateDistance * 0.8));
    camera.fov = 36;
    camera.position.set(
      target.center.x - towardGate.x * cameraBack + right.x * 2.8,
      target.center.y + 4.2,
      target.center.z - towardGate.z * cameraBack + right.z * 2.8,
    );
    camera.lookAt(
      target.center.x + gateDelta.x * 0.56,
      target.center.y + 0.75,
      target.center.z + gateDelta.z * 0.56,
    );
  }
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
}

function materialTextures(material) {
  const textures = new Set();
  for (const value of Object.values(material || {})) {
    if (value?.isTexture) textures.add(value);
  }
  for (const uniform of Object.values(material?.uniforms || {})) {
    const value = uniform?.value;
    if (value?.isTexture) textures.add(value);
    else if (Array.isArray(value)) {
      for (const item of value) if (item?.isTexture) textures.add(item);
    }
  }
  return textures;
}

function geometryTriangles(geometry) {
  return (geometry.index?.count || geometry.attributes.position.count) / 3;
}

function hashString(hash, text) {
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function hashGeometry(root) {
  let hash = 0x811c9dc5;
  const scratch = new DataView(new ArrayBuffer(8));
  const meshes = [];
  root.traverse((object) => {
    if (object.isMesh) meshes.push(object);
  });
  meshes.sort((left, right) => left.name.localeCompare(right.name));
  for (const mesh of meshes) {
    hash = hashString(hash, mesh.name);
    for (const key of ['position', 'normal', 'color']) {
      const values = mesh.geometry.getAttribute(key)?.array || [];
      hash = hashString(hash, key);
      for (const value of values) {
        scratch.setFloat64(0, value, true);
        hash ^= scratch.getUint32(0, true);
        hash = Math.imul(hash, 0x01000193);
        hash ^= scratch.getUint32(4, true);
        hash = Math.imul(hash, 0x01000193);
      }
    }
    const indices = mesh.geometry.index?.array || [];
    for (const value of indices) {
      hash ^= value;
      hash = Math.imul(hash, 0x01000193);
    }
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

// A second actual createVillage run proves that renderer geometry follows only
// the deterministic plan record. Three's UUID allocation is deliberately not
// part of this hash.
const replay = createVillage(OPTIONS);
const replayDrainage = replay.group.getObjectByName('roadside-drainage-ground');
const deterministicPlan = JSON.stringify(replay.plan?.drainage)
  === JSON.stringify(drainagePlan);
const geometryHash = hashGeometry(drainage);
const replayGeometryHash = replayDrainage ? hashGeometry(replayDrainage) : null;
const deterministicGeometry = geometryHash === replayGeometryHash;
replay.dispose();

const materials = new Set();
const textures = new Set();
const meshes = [];
drainage.traverse((object) => {
  if (!object.isMesh) return;
  meshes.push(object);
  const list = Array.isArray(object.material) ? object.material : [object.material];
  for (const material of list) {
    materials.add(material);
    for (const texture of materialTextures(material)) textures.add(texture);
  }
});
// Ditch: 5 quads × 2 tris per sample step. Each planned slab is a subdivided
// box (3×1×2 segments → 44 tris). Count is plan-owned 2–3 per crossing (#217).
const expectedTriangles = drainagePlan.runs.reduce(
  (sum, run) => sum + Math.max(0, run.points.length - 1) * 10,
  0,
) + drainagePlan.crossings.reduce(
  (sum, crossing) => sum + (crossing.slabs?.length ?? 0) * 44,
  0,
);
const ownedTriangles = meshes.reduce(
  (sum, mesh) => sum + geometryTriangles(mesh.geometry),
  0,
);

function renderState(visible) {
  drainage.visible = visible;
  handle.update(1 / 60);
  renderer.render(scene, camera);
  return {
    visible,
    calls: renderer.info.render.calls,
    triangles: renderer.info.render.triangles,
    programs: renderer.info.programs.length,
  };
}

let baselinePrograms = null;
function measure(view) {
  setView(view);
  const off = renderState(false);
  if (baselinePrograms == null) baselinePrograms = off.programs;
  const on = renderState(true);
  return {
    view,
    off,
    on,
    drawDelta: on.calls - off.calls,
    triangleDelta: on.triangles - off.triangles,
    programDelta: on.programs - baselinePrograms,
  };
}

window.__DRAINAGE_SET_VIEW = (view) => {
  setView(view);
  renderer.render(scene, camera);
};
window.__DRAINAGE_SET_VISIBLE = (visible) => {
  drainage.visible = !!visible;
  renderer.render(scene, camera);
};
// 근경 판독 축 전용: 도랑은 그대로 두고 건넘돌만 접는다. 이 프레임과의 차이가 곧 판석의
//   실루엣 마스크이고, 그 마스크 안의 "판석 없을 때 픽셀"이 판석이 앉은 노면의 기준값이 된다.
window.__DRAINAGE_SET_CROSSINGS_VISIBLE = (visible) => {
  crossingMesh.visible = !!visible;
  renderer.render(scene, camera);
};
window.__DRAINAGE_MEASURE = (view) => measure(view);

setView('close');
drainage.visible = false;
let frames = 0;
renderer.setAnimationLoop(() => {
  handle.update(1 / 60);
  renderer.render(scene, camera);
  if (++frames < 12) return;
  renderer.setAnimationLoop(null);
  baselinePrograms = renderer.info.programs.length;
  window.__DRAINAGE_DIAG = {
    seed: OPTIONS.seed,
    scale: OPTIONS.scale,
    runCount: drainagePlan.runs.length,
    crossingCount: drainagePlan.crossings.length,
    crossingId: target.id,
    meshCount: meshes.length,
    materialCount: materials.size,
    textureCount: textures.size,
    ownedTriangles,
    expectedTriangles,
    geometryHash,
    replayGeometryHash,
    deterministicPlan,
    deterministicGeometry,
    groupName: drainage.name,
    meshNames: meshes.map((mesh) => mesh.name).sort(),
    crossingTop: target.center.y,
    crossingSpan: target.span,
    crossingWidth: target.width,
  };
  window.__DRAINAGE_READY = true;
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
    if (pathname === '/__drainage_product') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(PRODUCT_HTML);
      return;
    }
    const file = resolve(ROOT, `.${pathname}`);
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

function meanDifference(leftBuffer, rightBuffer) {
  const left = PNG.sync.read(leftBuffer);
  const right = PNG.sync.read(rightBuffer);
  invariant(
    left.width === right.width && left.height === right.height,
    'drainage frame dimensions drifted',
  );
  let total = 0;
  for (let offset = 0; offset < left.data.length; offset += 4) {
    total += Math.abs(left.data[offset] - right.data[offset]);
    total += Math.abs(left.data[offset + 1] - right.data[offset + 1]);
    total += Math.abs(left.data[offset + 2] - right.data[offset + 2]);
  }
  return total / (left.width * left.height * 3);
}

// ── 근경 판독 축(docs/architectural-authenticity.md §7.4-9 / §7.7-2) ──────────────
//
// 종전 `check:drainage`·`shoot:drainage`는 record 수·mesh 수·재질 예산·해시·기여 픽셀량만
// 봤으므로 "건넘돌이 현대 프리캐스트 콘크리트 판으로 읽힌다"는 회귀를 전부 통과시켰다.
// 판석 실루엣 안에서 두 가지를 재서 그 축을 닫는다.
//
//   1. brightnessRatio — 판석 평균 휘도 ÷ **같은 픽셀의 노면 휘도**. 콘크리트로 읽힌 원인은
//      형상이 아니라 "판석이 자기가 앉은 흙길보다 밝다"였다(실측 143.8 / 127.1 = 1.13).
//      국립민속박물관 「디딤돌」은 잘 다듬은 화강 장대석·판석을 위상 높은 건축에 배정하므로,
//      살림집 대문 앞에는 노면보다 밝은 백색 판이 서지 않아야 한다. 상한은 1.0 이 아니라
//      실측 분리 지점으로 둔다(빛 방향·계절에 여유).
//   2. toneSpread — 판석 실루엣 안 휘도의 중앙값 절대편차. 돌마다 톤이 같고 상면이 완전
//      평행이면 0 에 가깝다. 텍스처가 금지된 계약 안에서 "돌이 개별로 읽히는가"의 최소 축이다.
//
// 버린 후보:
//   - 판석 마스크 면적·기여 픽셀량: 기존 deltas.close 가 이미 보고 있고 재질감과 무관하다.
//   - 엣지 검출로 "직선 격자" 판정: 카메라 각도·AA 에 지배돼 임계값이 유지되지 않았다.
//   - 절대 휘도 상한: 노출·시간대 상수에 묶여 조명 변경마다 재기준이 필요했다. 노면 대비로
//     정규화하면 같은 프레임 안의 상대 관계만 남아 훨씬 안정적이다.
const MAX_CROSSING_BRIGHTNESS_RATIO = 0.95;
const MIN_CROSSING_TONE_SPREAD = 2.5;

function luma(data, index) {
  return 0.2126 * data[index] + 0.7152 * data[index + 1] + 0.0722 * data[index + 2];
}

function robustSpread(values) {
  if (values.length < 2) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const deviations = sorted.map((value) => Math.abs(value - median)).sort((a, b) => a - b);
  return deviations[Math.floor(deviations.length / 2)] * 1.4826;
}

function crossingReadability(withoutBuffer, withBuffer) {
  const without = PNG.sync.read(withoutBuffer);
  const withCrossings = PNG.sync.read(withBuffer);
  invariant(
    without.width === withCrossings.width && without.height === withCrossings.height,
    'drainage crossing frame dimensions drifted',
  );
  const stone = [];
  const road = [];
  for (let offset = 0; offset < without.data.length; offset += 4) {
    const delta = Math.abs(without.data[offset] - withCrossings.data[offset])
      + Math.abs(without.data[offset + 1] - withCrossings.data[offset + 1])
      + Math.abs(without.data[offset + 2] - withCrossings.data[offset + 2]);
    if (delta < 24) continue;
    stone.push(luma(withCrossings.data, offset));
    road.push(luma(without.data, offset));
  }
  if (stone.length < 200) return { pixels: stone.length };
  const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const stoneMean = mean(stone);
  const roadMean = mean(road);
  return {
    pixels: stone.length,
    stoneMean,
    roadMean,
    brightnessRatio: roadMean > 0 ? stoneMean / roadMean : Infinity,
    toneSpread: robustSpread(stone),
  };
}

const output = process.env.CHEOMA_CAPTURE_DIR
  || await mkdtemp(join(tmpdir(), 'cheoma-drainage-'));
const browser = await launchVerificationBrowser();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (error) => errors.push(`page: ${error.message}`));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(`console: ${message.text()}`);
});
const port = server.address().port;

async function capture(view, visible) {
  await page.evaluate(({ nextView, nextVisible }) => {
    window.__DRAINAGE_SET_VIEW(nextView);
    window.__DRAINAGE_SET_VISIBLE(nextVisible);
  }, { nextView: view, nextVisible: visible });
  const path = join(output, `drainage-${view}-${visible ? 'on' : 'off'}.png`);
  const buffer = await page.locator('canvas').screenshot({ path });
  return { view, visible, path, buffer };
}

try {
  await page.goto(`http://127.0.0.1:${port}/__drainage_product`, {
    waitUntil: 'load',
  });
  await page.waitForFunction(() => window.__DRAINAGE_READY === true, null, {
    timeout: 120_000,
  });
  const diag = await page.evaluate(() => window.__DRAINAGE_DIAG);
  const closeOff = await capture('close', false);
  const closeOn = await capture('close', true);
  const closeMeasure = await page.evaluate(() => window.__DRAINAGE_MEASURE('close'));
  const aerialOff = await capture('aerial', false);
  const aerialOn = await capture('aerial', true);
  const aerialMeasure = await page.evaluate(() => window.__DRAINAGE_MEASURE('aerial'));
  const deltas = {
    close: meanDifference(closeOff.buffer, closeOn.buffer),
    aerial: meanDifference(aerialOff.buffer, aerialOn.buffer),
  };

  // 근경 판독 축: 같은 close 카메라에서 건넘돌만 접은 프레임을 하나 더 찍는다.
  await page.evaluate(() => {
    window.__DRAINAGE_SET_VIEW('close');
    window.__DRAINAGE_SET_VISIBLE(true);
    window.__DRAINAGE_SET_CROSSINGS_VISIBLE(false);
  });
  const crossingsHidden = await page.locator('canvas').screenshot({
    path: join(output, 'drainage-close-no-crossings.png'),
  });
  await page.evaluate(() => window.__DRAINAGE_SET_CROSSINGS_VISIBLE(true));
  const crossingsShown = await page.locator('canvas').screenshot({
    path: join(output, 'drainage-close-crossings.png'),
  });
  const readability = crossingReadability(crossingsHidden, crossingsShown);

  invariant(errors.length === 0, errors.join(' | '));
  invariant(diag.runCount > 0 && diag.crossingCount > 0,
    `capital/11 drainage fixture drifted ${JSON.stringify(diag)}`);
  invariant(diag.groupName === 'roadside-drainage-ground',
    `drainage group name drifted (${diag.groupName})`);
  invariant(diag.meshCount === 2
    && diag.meshNames.includes('road-drainage-ground')
    && diag.meshNames.includes('road-drainage-stone-crossings'),
  `drainage mesh family drifted ${JSON.stringify(diag.meshNames)}`);
  invariant(diag.materialCount === 1 && diag.textureCount === 0,
    `drainage material budget drifted ${JSON.stringify(diag)}`);
  invariant(diag.ownedTriangles === diag.expectedTriangles,
    `drainage triangle formula drifted ${diag.ownedTriangles}/${diag.expectedTriangles}`);
  invariant(diag.deterministicPlan && diag.deterministicGeometry,
    `drainage determinism failed ${diag.geometryHash}/${diag.replayGeometryHash}`);
  for (const measure of [closeMeasure, aerialMeasure]) {
    invariant(measure.drawDelta >= 1 && measure.drawDelta <= 2,
      `${measure.view} drainage draw delta drifted (${measure.drawDelta})`);
    invariant(measure.triangleDelta > 0
      && measure.triangleDelta <= diag.ownedTriangles,
    `${measure.view} drainage triangle submission drifted (${measure.triangleDelta})`);
    invariant(measure.programDelta <= 1,
      `${measure.view} drainage program delta drifted (${measure.programDelta})`);
  }
  invariant(deltas.close >= 0.1,
    `close drainage contribution is not visible (${deltas.close.toFixed(4)})`);
  invariant(deltas.aerial >= 0.005,
    `aerial drainage contribution vanished (${deltas.aerial.toFixed(4)})`);
  invariant(deltas.aerial < deltas.close,
    `drainage did not recede with distance (${deltas.close.toFixed(4)} -> ${deltas.aerial.toFixed(4)})`);
  invariant(readability.pixels >= 200,
    `drainage crossing silhouette is too small to judge (${readability.pixels}px)`);
  invariant(readability.brightnessRatio <= MAX_CROSSING_BRIGHTNESS_RATIO,
    `gate crossing reads as a precast slab brighter than its own road `
    + `(${readability.brightnessRatio.toFixed(3)} > ${MAX_CROSSING_BRIGHTNESS_RATIO})`);
  invariant(readability.toneSpread >= MIN_CROSSING_TONE_SPREAD,
    `gate crossing stones share one flat machined tone `
    + `(${readability.toneSpread.toFixed(2)} < ${MIN_CROSSING_TONE_SPREAD})`);

  await reportWebGLRenderer(page, 'drainage');
  console.log(
    `DRAINAGE BROWSER: PASS (capital/${diag.seed}, runs/crossings=`
    + `${diag.runCount}/${diag.crossingCount}, delta close/aerial=`
    + `${deltas.close.toFixed(4)}/${deltas.aerial.toFixed(4)}, draws close/aerial=`
    + `${closeMeasure.drawDelta}/${aerialMeasure.drawDelta}, triangles owned/submitted=`
    + `${diag.ownedTriangles}/${closeMeasure.triangleDelta}, programs +`
    + `${Math.max(closeMeasure.programDelta, aerialMeasure.programDelta)}, materials/textures=`
    + `${diag.materialCount}/${diag.textureCount}, hash=${diag.geometryHash}, `
    + `crossing stone/road luma=${readability.stoneMean.toFixed(1)}/`
    + `${readability.roadMean.toFixed(1)} ratio=${readability.brightnessRatio.toFixed(3)} `
    + `toneSpread=${readability.toneSpread.toFixed(2)} mask=${readability.pixels}px)`,
  );
  console.log(`captures=${output}`);
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
