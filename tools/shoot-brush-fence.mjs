// 싸리울(바자울) 근경 판독 게이트 — docs/architectural-authenticity.md §7.4-10 / §7.7-2.
//
// 이 게이트가 있는 이유: `check:wall-gate`·`check:wall-step`은 담 레이아웃·계단·대문 계약만
// 보므로 "울이 규격 피켓 펜스로 읽히는" 회귀를 세 라운드 통과시켰다. 그래서 판정 축을
// plan record 수가 아니라 **고정 근경 카메라의 실루엣 마스크**에 둔다(`check:mud-wall`의
// 선례와 같은 방식이고, 같은 한계 — 미묘한 축은 여전히 사람·비전 판정이 필요하다).
//
// 판정 축 2개:
//   1. topEdgeRaggedness — 실루엣 상단 경계의 열별 표준편차(px). 규격 피켓은 위끝이 한 선에
//      모이므로 0에 가깝고, 자연 가지 다발은 들쭉날쭉하다. 국립민속박물관 「싸리울」이 확인하는
//      것은 재료가 싸리나무 **가지**라는 사실이고, 살 높이 수치는 어느 자료에도 없다 —
//      따라서 이 축이 재는 것은 "다듬은 각재가 아니다"이지 특정 실측 높이가 아니다.
//   2. bodyCoverage — 울 몸통 띠에서 실루엣이 채운 비율. 「싸리울」은 살대를 "발처럼" 엮은
//      **면**을 서술하므로, 살 굵기의 다섯 배 간격으로 벌어진 열은 그 면이 아니다.
//
// 버린 후보(모두 실측 후 폐기 — 회귀 재현본과 수정본을 같은 백엔드에서 각각 돌려 확인):
//   - girthVariety(살 단면 run 폭의 변동계수): 회귀 0.429 / 수정 0.430 — **분리력 0**.
//     측정된 것은 굵기 개체차가 아니라 원기둥 실루엣의 안티에일리어싱·투시 축소였다.
//   - 가로재 z 오프셋·엮음 줄 수의 기하 단언: 렌더 결과가 아니라 소스 상수를 되읽는 동어반복.
//   - 평균 휘도·색 분산: 조명·팔레트 변경마다 흔들려 임계값이 유지되지 않는다.
//   - 픽셀로 통나무 기둥 열을 골라내 상단선에서 제외: 거리·팔레트에 취약했다. 대신 산포를
//     중앙값 절대편차로 재서 소수 이상치의 영향을 없앴다.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { PNG } from 'pngjs';
import {
  launchVerificationBrowser,
  reportWebGLRenderer,
} from './lib/verification-browser.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = process.env.CHEOMA_CAPTURE_DIR
  ? resolve(process.env.CHEOMA_CAPTURE_DIR)
  : mkdtempSync(join(tmpdir(), 'cheoma-brush-fence-'));
mkdirSync(OUT, { recursive: true });

// 실측으로 갈린 임계값. 회귀 상태(모든 살 동일 높이·동일 굵기·곧은 레일 2줄)와 수정본이
// 아래 값에서 깨끗이 나뉜다. 회귀 재현치와 수정본 실측치는 리포트에 남긴다.
const MIN_TOP_EDGE_RAGGEDNESS = 6;
const MIN_BODY_COVERAGE = 0.32;

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.png': 'image/png',
  '.json': 'application/json',
};

const HTML = `<!doctype html>
<html><head><meta charset="utf-8">
<style>html,body{margin:0;overflow:hidden;background:#f2f4f2}canvas{display:block}</style>
<script type="importmap">{"imports":{
  "three":"/app/node_modules/three/build/three.module.js",
  "three/addons/":"/app/node_modules/three/examples/jsm/"
}}</script></head><body><script type="module">
import * as THREE from 'three';
import { makeMaterials } from '/src/builder/palette.js';
import { buildVillageWall } from '/src/village/walls.js';

const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setPixelRatio(1);
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
// 실루엣 마스크를 뽑기 위해 배경은 담과 대비가 큰 균일 색으로 둔다(판정 전용 무대).
scene.background = new THREE.Color(0xeef1ef);
scene.add(new THREE.HemisphereLight(0xdfe8ec, 0x6d6047, 1.5));
const sun = new THREE.DirectionalLight(0xffe6c0, 2.1);
sun.position.set(-8, 12, 14);
scene.add(sun, sun.target);

// 고정 fixture: 정사각 초가 필지 한 변의 싸리울. plan 을 통하지 않고 담 조립기를 직접 부르므로
// 마을 전체 생성 시간 없이 같은 geometry 를 얻는다.
const HALF = 9;
const shape = {
  pts: [
    { x: HALF, z: HALF }, { x: -HALF, z: HALF },
    { x: -HALF, z: -HALF }, { x: HALF, z: -HALF },
  ],
  roles: ['front', 'left', 'back', 'right'],
};
const mats = makeMaterials('choga');
const wall = buildVillageWall(shape, mats, {
  style: 'brush',
  kind: 'choga',
  seed: 20260718,
  char01: 0.5,
  wallHeightK: 1,
  plotW: HALF * 2,
  plotD: HALF * 2,
});
// 판정 축은 **한 겹의** 실루엣 상단선을 재므로, 필지 반대편 울이 프레임에 겹치면 그 축이
//   먼 쪽 울을 측정해 버린다. 앞변(+z) run 만 남기고 나머지 변은 접는다(같은 조립기·같은
//   geometry, 무대만 정리).
for (const child of wall.children) {
  if (child.position.z < HALF - 0.5) child.visible = false;
}
scene.add(wall);

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(80, 80),
  new THREE.MeshStandardMaterial({ color: 0x9a8f76, roughness: 1, metalness: 0 }),
);
ground.rotation.x = -Math.PI * 0.5;
ground.position.y = -0.01;
scene.add(ground);

// 앞변(+z) 울을 제품 focus 에 가까운 근경에서 본다. 눈높이 1.62m, 담 바깥 7.0m — 울 전체
//   높이와 여러 칸이 한 프레임에 들어와 상단선·살 굵기를 함께 판정할 수 있는 거리다.
const camera = new THREE.PerspectiveCamera(30, innerWidth / innerHeight, 0.05, 120);
camera.position.set(-2.4, 1.62, HALF + 7.0);
camera.lookAt(-2.4, 0.66, HALF);
camera.updateProjectionMatrix();
camera.updateMatrixWorld();

function stats() {
  const materials = new Set();
  const textures = new Set();
  let meshes = 0;
  let instances = 0;
  let triangles = 0;
  let stickTops = null;
  wall.traverse((object) => {
    if (!object.isMesh && !object.isInstancedMesh) return;
    meshes++;
    if (object.userData?.brushStickTops) stickTops = object.userData.brushStickTops.length;
    const count = object.isInstancedMesh ? object.count : 1;
    instances += count;
    const index = object.geometry?.index;
    const position = object.geometry?.attributes?.position;
    triangles += Math.floor((index?.count || position?.count || 0) / 3) * count;
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      if (!material?.isMaterial) continue;
      materials.add(material);
      for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
    }
  });
  return { meshes, instances, triangles, materials: materials.size, textures: textures.size, stickTops };
}

window.__BRUSH_SET_VISIBLE = (visible) => {
  wall.visible = !!visible;
  renderer.render(scene, camera);
};
renderer.render(scene, camera);
window.__BRUSH_DIAG = { ...stats(), calls: renderer.info.render.calls };
window.__BRUSH_READY = true;
</script></body></html>`;

function decode(buffer) {
  return PNG.sync.read(buffer);
}

// 담 없음 ↔ 담만 프레임 차이로 실루엣 마스크를 만든다(`check:mud-wall`과 같은 방식).
function silhouette(offPng, onPng, box) {
  const mask = [];
  for (let y = box.y0; y < box.y1; y++) {
    const row = new Uint8Array(box.x1 - box.x0);
    for (let x = box.x0; x < box.x1; x++) {
      const index = (y * offPng.width + x) * 4;
      const delta = Math.abs(offPng.data[index] - onPng.data[index])
        + Math.abs(offPng.data[index + 1] - onPng.data[index + 1])
        + Math.abs(offPng.data[index + 2] - onPng.data[index + 2]);
      row[x - box.x0] = delta >= 24 ? 1 : 0;
    }
    mask.push(row);
  }
  return mask;
}

function deviation(values) {
  if (values.length < 2) return { mean: 0, std: 0 };
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return { mean, std: Math.sqrt(variance) };
}

// 통나무 기둥은 살보다 훨씬 높고 굵어 상단선에 큰 이상치를 만든다. 기둥을 픽셀로 골라내는
//   시도는 거리·팔레트에 취약했으므로(버린 후보), 산포를 **중앙값 절대편차**로 재서 소수
//   이상치가 축을 흔들지 못하게 한다. MAD×1.4826 은 정규분포에서 표준편차와 같은 스케일이다.
function robustSpread(values) {
  if (values.length < 2) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const deviations = sorted.map((value) => Math.abs(value - median)).sort((a, b) => a - b);
  return deviations[Math.floor(deviations.length / 2)] * 1.4826;
}

// 축 1: 열별 최상단 실루엣 행의 견고한 산포(px).
function topEdgeRaggedness(mask) {
  const width = mask[0].length;
  const tops = [];
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < mask.length; y++) {
      if (mask[y][x]) { tops.push(y); break; }
    }
  }
  if (tops.length < 20) return { std: 0, samples: tops.length };
  return { std: robustSpread(tops), samples: tops.length };
}

// 축 2: 울 몸통 띠 안에서 실루엣이 채운 비율. 「싸리울」이 확인하는 것은 살대를 "발처럼"
//   엮은 **면**이고, 살 굵기의 다섯 배 간격으로 벌어진 열은 그 면이 되지 않는다(피켓 열로
//   읽힌 원인 중 하나). 살 간격 수치는 출처에 없으므로 이 축은 실측 복원이 아니라 "면인가
//   열인가"의 판독 하한이다. 상단 20%(들쭉날쭉한 팁)와 최하단은 제외해 몸통만 본다.
function bodyCoverage(mask) {
  const rows = [];
  for (let y = 0; y < mask.length; y++) {
    if (mask[y].some((value) => value)) rows.push(y);
  }
  if (rows.length < 20) return { fill: 0, samples: 0 };
  const first = rows[0] + Math.floor(rows.length * 0.25);
  const last = rows[0] + Math.floor(rows.length * 0.9);
  let minX = Infinity;
  let maxX = -Infinity;
  for (let y = first; y < last; y++) {
    for (let x = 0; x < mask[y].length; x++) {
      if (!mask[y][x]) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
    }
  }
  if (!Number.isFinite(minX) || maxX <= minX) return { fill: 0, samples: 0 };
  let on = 0;
  let total = 0;
  for (let y = first; y < last; y++) {
    for (let x = minX; x <= maxX; x++) {
      total++;
      if (mask[y][x]) on++;
    }
  }
  return { fill: total ? on / total : 0, samples: total, band: [first, last], span: maxX - minX };
}


const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    if (pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
    if (pathname === '/' || pathname === '/__brush') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(HTML);
      return;
    }
    const file = resolve(ROOT, `.${pathname}`);
    if (file !== ROOT && !file.startsWith(`${ROOT}${sep}`)) throw new Error('unsafe path');
    const body = await readFile(file);
    response.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end('not found');
  }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));

const browser = await launchVerificationBrowser();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (error) => errors.push(`page: ${error.message}`));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(`console: ${message.text()}`);
});

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  await page.goto(`http://127.0.0.1:${server.address().port}/__brush`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__BRUSH_READY === true, null, { timeout: 120_000 });
  const diag = await page.evaluate(() => window.__BRUSH_DIAG);
  invariant(errors.length === 0, errors.join(' | '));

  await page.evaluate(() => window.__BRUSH_SET_VISIBLE(false));
  const off = decode(await page.locator('canvas').screenshot({
    path: join(OUT, 'brush-fence-off.png'),
  }));
  await page.evaluate(() => window.__BRUSH_SET_VISIBLE(true));
  const on = decode(await page.locator('canvas').screenshot({
    path: join(OUT, 'brush-fence-close.png'),
  }));

  const box = { x0: 0, y0: 0, x1: off.width, y1: off.height };
  const mask = silhouette(off, on, box);
  const top = topEdgeRaggedness(mask);
  const coverage = bodyCoverage(mask);

  invariant(diag.stickTops > 0, 'brush fence exposed no stick instances');
  invariant(diag.materials <= 3 && diag.textures <= 2,
    `brush fence material budget drifted ${JSON.stringify(diag)}`);
  invariant(top.samples >= 200,
    `brush fence silhouette is too small to judge (${top.samples} columns)`);
  invariant(top.std >= MIN_TOP_EDGE_RAGGEDNESS,
    `brush fence top edge reads as a machined picket line `
    + `(${top.std.toFixed(2)}px < ${MIN_TOP_EDGE_RAGGEDNESS})`);
  invariant(coverage.fill >= MIN_BODY_COVERAGE,
    `brush fence reads as a sparse picket row, not a woven mat `
    + `(fill ${coverage.fill.toFixed(3)} < ${MIN_BODY_COVERAGE})`);

  await reportWebGLRenderer(page, 'brush-fence');
  console.log(
    `BRUSH FENCE: PASS (topEdgeRaggedness=${top.std.toFixed(2)}px/${top.samples}col, `
    + `bodyCoverage=${coverage.fill.toFixed(3)} span=${coverage.span}px, `
    + `meshes=${diag.meshes} instances=${diag.instances} `
    + `tris=${diag.triangles} materials=${diag.materials} textures=${diag.textures})`,
  );
  console.log(`captures=${OUT}`);
} catch (error) {
  console.error(`BRUSH FENCE: FAIL ${error.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
