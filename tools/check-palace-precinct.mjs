// 궁·관아 위계 계약 (#21 R5). 구한말 도성 사진 대조 판정(#15)의 D5·D8·D13·D14·E 를 수치로 못박는다.
//
//   D5  정전이 "수평으로 긴 어두운 덩어리"인가 — 정면 처마 길이와 정면:측면 비, 행각 지붕 밴드 폭
//   D8  정문 앞이 비어 있고 축선 대로가 문 법선 위에 서는가 — 광장 안 필지·시전 0
//   D13 궁장이 민가 담과 구별되는가 — 높이·두께 배수, 기와 갓, 지대석
//   D14 관아가 궁 축선에 정렬하는가 — 좌우 대칭 슬롯, 궁과 같은 좌향
//   E   궁 경계에 민가가 붙지 않는가 — 궁역 폴리곤까지 최소 이격
//
// 브라우저·GL 없이 돈다. 궁 컴파운드는 esbuild 로 번들해 node 에서 세우고(Object3D 읽기만),
//   도시면은 순수 plan 으로 검사한다. 도로 쪽 계약(축선 시점·궁역 관통 금지)은
//   tools/check-road-contract.mjs 가 소유한다 — 여기서 중복하지 않는다.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as G from '../src/core/math/geom2.js';
import { planVillage } from '../src/api/village-plan.js';
import {
  PALACE_OUTER_WALL,
  palaceGatePoint,
  palaceUrbanFrontPlan,
} from '../src/village/palace-precinct-plan.js';

const ROOT = resolve(import.meta.dirname, '..');
const requireApp = createRequire(join(ROOT, 'app', 'package.json'));
const esbuild = requireApp('esbuild');

// ── 판정 임계 ────────────────────────────────────────────────────────────────
// 전부 2026-08-02 실측에서 나온 값이고, 괄호 안이 이 라운드 **이전** 소스의 실측이다
// (FAIL-first: 종전 값은 모두 아래 하한 아래에 있다).
const JEONGJEON_EAVE_MIN = 26;        // 정전 정면 처마 폭 m   (종전 21.62)
const JEONGJEON_RATIO_MIN = 1.40;     // 정면:측면            (종전 1.22)
const CORRIDOR_BAND_MIN = 5.0;        // 정전곽 행각 지붕 밴드 m (종전 3.95)
const CORRIDOR_BAND_MIN_OTHER = 3.9;  // 나머지 일곽·측면 블록 (종전 3.95 / 측면 3.35)
const HALL_SLACK_MIN = 2.0;           // 전각 처마와 행각 안쪽 면 사이 여유 m
const FLANK_GAP_MIN = 1.0;            // 측면 블록과 축선 일곽 사이 이격 m
// 민가 담 최대치(parcel-compound-plan: 초가 1.3 / 한옥 2.0 / 반가·객사 2.2, 두께 0.46~0.5).
const CIVIL_FENCE_HEIGHT = 2.2;
const CIVIL_FENCE_THICKNESS = 0.5;
const WALL_HEIGHT_RATIO_MIN = 1.5;    // 궁장 높이 배수        (종전 3.0/2.2 = 1.36)
const WALL_THICKNESS_RATIO_MIN = 1.9; // 궁장 두께 배수        (종전 0.7/0.5 = 1.40)

const SEEDS = [20260716, 7, 1, 11, 2026, 42];

function stubCanvasFactory() {
  function createCanvas() {
    let width = 0, height = 0;
    const gradient = { addColorStop() {} };
    const ctx = new Proxy({
      getImageData(x, y, w, h) {
        return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
      },
      measureText() { return { width: 0 }; },
      createLinearGradient() { return gradient; },
      createRadialGradient() { return gradient; },
      createConicGradient() { return gradient; },
      createPattern() { return null; },
      getLineDash() { return []; },
      get canvas() { return canvas; },
    }, {
      get(target, key) {
        if (key in target) return target[key];
        return () => {};
      },
      set() { return true; },
    });
    const canvas = {
      get width() { return width; }, set width(v) { width = v; },
      get height() { return height; }, set height(v) { height = v; },
      getContext() { return ctx; },
      toDataURL: () => 'data:,',
    };
    return canvas;
  }
  return { createCanvas };
}

const built = await esbuild.build({
  stdin: {
    contents: `
      export * as THREE from 'three';
      export { buildPalaceCompound } from './src/village/palace.js';
      export { setPaletteContext, createPaletteContext } from './src/builder/palette.js';
    `,
    resolveDir: ROOT,
    sourcefile: 'palace-precinct-contract-entry.js',
  },
  alias: {
    'three/addons/utils/BufferGeometryUtils.js': join(
      ROOT, 'app/node_modules/three/examples/jsm/utils/BufferGeometryUtils.js',
    ),
    three: join(ROOT, 'app/node_modules/three/build/three.module.js'),
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  write: false,
  logLevel: 'silent',
});
const bundleDir = mkdtempSync(join(tmpdir(), 'palace-precinct-'));
const bundleFile = join(bundleDir, 'bundle.mjs');
writeFileSync(bundleFile, built.outputFiles[0].text);
const {
  THREE,
  buildPalaceCompound,
  setPaletteContext,
  createPaletteContext,
} = await import(pathToFileURL(bundleFile).href);

const factory = stubCanvasFactory();
// 소품 재질 일부는 palette 컨텍스트가 아니라 document 를 직접 쓴다(금천교 짚·돌 텍스처).
globalThis.document = {
  createElement: (tag) => (tag === 'canvas' ? factory.createCanvas() : {}),
};
setPaletteContext(createPaletteContext({
  random: () => 0.5,
  createCanvas: factory.createCanvas,
}));

const boxOf = (object) => {
  object.updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(object);
};

// ── D5 · D13: 궁 컴파운드 기하 ───────────────────────────────────────────────
for (const tier of ['hanyang', 'capital']) {
  const root = buildPalaceCompound({ tier, seed: 5, merge: false });
  const handle = root.userData.palaceHandle;
  const areas = handle.areas;

  const jeongjeon = areas.find((area) => area.role === 'jeongjeon');
  assert.ok(jeongjeon?.hall, `${tier}: no jeongjeon hall`);
  const hall = boxOf(jeongjeon.hall);
  const eaveWidth = hall.max.x - hall.min.x;
  const eaveDepth = hall.max.z - hall.min.z;
  assert.ok(eaveWidth >= JEONGJEON_EAVE_MIN,
    `${tier}: jeongjeon eave width ${eaveWidth.toFixed(2)}m < ${JEONGJEON_EAVE_MIN}m`);
  assert.ok(eaveWidth / eaveDepth >= JEONGJEON_RATIO_MIN,
    `${tier}: jeongjeon front:side ${(eaveWidth / eaveDepth).toFixed(3)} < ${JEONGJEON_RATIO_MIN}`);

  // 행각 지붕 밴드 — 세그먼트의 짧은 수평 변이 곧 지붕 두께다.
  for (const area of areas) {
    const bands = [];
    area.group.traverse((object) => {
      if (object.name !== 'corridor') return;
      for (const segment of object.children) {
        if (!segment.isGroup) continue;
        const box = new THREE.Box3().setFromObject(segment);
        bands.push(Math.min(box.max.x - box.min.x, box.max.z - box.min.z));
      }
    });
    if (!bands.length) continue;
    const minimum = area.role === 'jeongjeon' ? CORRIDOR_BAND_MIN : CORRIDOR_BAND_MIN_OTHER;
    const measured = Math.min(...bands);
    assert.ok(measured >= minimum,
      `${tier}/${area.role}: corridor roof band ${measured.toFixed(2)}m < ${minimum}m`);
  }

  // 전각은 자기 일곽 안에 여유를 두고 앉는다(행각을 두껍게 하면서 깨지기 쉬운 지점).
  for (const area of areas) {
    if (!area.hall) continue;
    const box = boxOf(area.hall);
    const half = Math.max(
      Math.abs(box.min.x - area.center.x),
      Math.abs(box.max.x - area.center.x),
    );
    const slack = area.W / 2 - half;
    assert.ok(slack >= HALL_SLACK_MIN,
      `${tier}/${area.role}: hall lateral slack ${slack.toFixed(2)}m < ${HALL_SLACK_MIN}m`);
  }

  // 측면 블록(동궁·궐내각사)은 어떤 축선 일곽과도 겹치지 않는다.
  const axial = areas.filter((area) => area.hall).map((area) => ({ area, box: boxOf(area.group) }));
  const flanks = areas.filter((area) => !area.hall).map((area) => ({ area, box: boxOf(area.group) }));
  for (const flank of flanks) {
    for (const core of axial) {
      const overlapZ = Math.min(flank.box.max.z, core.box.max.z)
        - Math.max(flank.box.min.z, core.box.min.z);
      if (overlapZ <= 0) continue;
      const gapX = Math.max(
        flank.box.min.x - core.box.max.x,
        core.box.min.x - flank.box.max.x,
      );
      assert.ok(gapX >= FLANK_GAP_MIN,
        `${tier}: ${flank.area.role} clears ${core.area.role} by only ${gapX.toFixed(2)}m`);
    }
  }

  // D13 궁장: 치수 배수 + 기와 갓(그림자 캐스터) + 지대석.
  const wall = root.getObjectByName('palace-wall');
  assert.ok(wall, `${tier}: no palace wall`);
  assert.ok(PALACE_OUTER_WALL.height / CIVIL_FENCE_HEIGHT >= WALL_HEIGHT_RATIO_MIN,
    `${tier}: palace wall height ratio ${(PALACE_OUTER_WALL.height / CIVIL_FENCE_HEIGHT).toFixed(2)}`
    + ` < ${WALL_HEIGHT_RATIO_MIN}`);
  assert.ok(PALACE_OUTER_WALL.thickness / CIVIL_FENCE_THICKNESS >= WALL_THICKNESS_RATIO_MIN,
    `${tier}: palace wall thickness ratio `
    + `${(PALACE_OUTER_WALL.thickness / CIVIL_FENCE_THICKNESS).toFixed(2)} < ${WALL_THICKNESS_RATIO_MIN}`);
  const wallBox = boxOf(wall);
  assert.ok(wallBox.max.y >= PALACE_OUTER_WALL.height,
    `${tier}: palace wall tops out at ${wallBox.max.y.toFixed(2)}m below its authored ${PALACE_OUTER_WALL.height}m`);
  let coping = 0, plinth = 0;
  wall.traverse((object) => {
    if (!object.isMesh) return;
    const box = new THREE.Box3().setFromObject(object);
    // 갓(기와 코핑)은 회벽 상단 위에 있고 그림자를 드리운다.
    if (box.min.y >= PALACE_OUTER_WALL.height - 0.4 && object.castShadow) coping++;
    // 지대석은 담 두께보다 넓게 내밀고 발치에 앉는다.
    const spanX = box.max.x - box.min.x, spanZ = box.max.z - box.min.z;
    const width = Math.min(spanX, spanZ);
    if (box.max.y <= PALACE_OUTER_WALL.plinth.height + 1e-6
      && width > PALACE_OUTER_WALL.thickness + 1e-6) plinth++;
  });
  assert.ok(coping > 0, `${tier}: palace wall has no shadow-casting tile coping`);
  assert.ok(plinth > 0, `${tier}: palace wall has no stone plinth wider than the wall`);
  console.log(`palace ${tier}: jeongjeon eave ${eaveWidth.toFixed(2)}m `
    + `(front:side ${(eaveWidth / eaveDepth).toFixed(2)}), wall ${PALACE_OUTER_WALL.height}m/`
    + `${PALACE_OUTER_WALL.thickness}m, coping meshes ${coping}, plinth meshes ${plinth}`);
}

// ── D8 · D14 · E: 도시면 계획 ────────────────────────────────────────────────
function polygonGap(a, b) {
  if (G.polysOverlap(a, b)) return 0;
  let best = Infinity;
  for (const point of a) {
    for (let i = 0; i < b.length; i++) {
      best = Math.min(best, G.distToSeg(point, b[i], b[(i + 1) % b.length]).d);
    }
  }
  for (const point of b) {
    for (let i = 0; i < a.length; i++) {
      best = Math.min(best, G.distToSeg(point, a[i], a[(i + 1) % a.length]).d);
    }
  }
  return best;
}

for (const seed of SEEDS) {
  const plan = planVillage({ scale: 'hanyang', seed });
  const palace = plan.features.palace;
  assert.ok(palace, `hanyang:${seed}: no palace`);
  const gate = palaceGatePoint(palace);
  const direction = G.norm(palace.frontDir);
  const jongnoZ = plan.features.cityWall?.axes?.jongnoZ;
  const axisSpan = Number.isFinite(jongnoZ)
    ? Math.max(0, G.dot(G.sub({ x: 0, z: jongnoZ }, gate), direction))
    : Infinity;
  const front = palaceUrbanFrontPlan(palace, { axisSpan });

  // D8 정문 앞은 비어 있다 — 민가도 시전도 들어오지 않는다.
  assert.ok(front.plaza, `hanyang:${seed}: no palace forecourt`);
  const magistracy = plan.parcels.filter((parcel) => parcel.magistracySlot);
  const civil = plan.parcels.filter((parcel) => !parcel.magistracySlot);
  for (const parcel of civil) {
    assert.ok(!G.polysOverlap(parcel.poly, front.plaza),
      `hanyang:${seed}: parcel ${parcel.id} sits in the palace forecourt`);
  }
  for (const shop of plan.features.sijeon || []) {
    assert.ok(!G.polysOverlap(shop.poly, front.plaza),
      `hanyang:${seed}: a sijeon shop sits in the palace forecourt`);
  }

  // E 궁 경계에 민가가 붙지 않는다.
  let nearest = Infinity, who = null;
  for (const parcel of civil) {
    const gap = polygonGap(palace.poly, parcel.poly);
    if (gap < nearest) { nearest = gap; who = parcel.id; }
  }
  assert.ok(nearest >= front.front.precinctClearance - 1e-6,
    `hanyang:${seed}: parcel ${who} is only ${nearest.toFixed(2)}m from the palace `
    + `(clearance ${front.front.precinctClearance}m)`);

  // D14 관아는 좌우 대칭으로 서고 축선에 직교한다.
  assert.ok(magistracy.length >= 2,
    `hanyang:${seed}: only ${magistracy.length} magistracy slot(s) on the axis`);
  const west = magistracy.filter((parcel) => G.dot(
    G.sub(parcel.center, gate), { x: direction.z, z: -direction.x },
  ) < 0).length;
  assert.equal(west, magistracy.length - west,
    `hanyang:${seed}: magistracy row is not symmetric (${west} west / ${magistracy.length - west} east)`);
  for (const parcel of magistracy) {
    assert.ok(G.dot(G.norm(parcel.frontDir), direction) >= 1 - 1e-9,
      `hanyang:${seed}: magistracy ${parcel.id} does not share the palace facing`);
    assert.equal(parcel.roofRank, 'magistracy',
      `hanyang:${seed}: magistracy ${parcel.id} carries roof rank ${parcel.roofRank}`);
  }

  console.log(`hanyang:${seed}: plaza ${front.plazaLength.toFixed(1)}m (span ${axisSpan.toFixed(1)}m), `
    + `magistracy ${magistracy.length}, nearest civil parcel ${nearest.toFixed(2)}m, `
    + `parcels ${plan.parcels.length}`);
}

console.log('PALACE PRECINCT: PASS (D5 궁 위계 기하 · D8 정문 광장 · D13 궁장 · D14 관아 정렬 · E 궁 경계 이격)');
