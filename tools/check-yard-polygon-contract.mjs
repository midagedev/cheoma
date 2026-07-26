// 마당 소품은 plotW×plotD 직사각형이 아니라 실제 필지 폴리곤(parcel.shape)에 앉는다는 순수 계약.
//
// 왜 이 게이트가 있는가: 담(walls.js)은 parcel.shape 를 따르는데 소품 좌표는 오랫동안
// plotW×plotD 직사각형에서 나왔다. parcels.js#localParcelShape 의 전단(lean ≤0.22·plotW)·뒷변
// 오므림(변당 ≤0.105·plotW)·뒤깊이 지터는 필지 크기에 비례하므로 저작 슬롯의 상수 0.5m 인셋이
// 흡수하지 못한다. 수정 전 측정(seed 7·11, hamlet~capital): 장독대 47~53% · 낟가리 42~67% ·
// 빨래줄 8~43% 가 담 밖(최대 2.89m)이었고, 필지의 63~66% 가 소품 하나 이상을 담 밖에 두었다.
//
// 이탈률은 plotW 에 비례하므로 필지를 키우면 줄지만 결코 0이 되지 않는다 — 크기 조정이 아니라
// 폴리곤 판정만이 이 결함을 없앤다. 그래서 규모 변경과 독립된 계약으로 고정한다.
//
// 판정 축(전부 순수 산술, 브라우저 없음):
//   1. 음성 대조 — 수정 전 직사각형 공식은 같은 픽스처에서 실제로 이탈한다(어서션이 공허해질 수 없음).
//   2. 이탈 0 — 예약/렌더가 공유하는 모든 소품 footprint 가 폴리곤 안, 담 내측 여유 이상.
//   3. 예약 == 배치 — yardHardObstacles 가 내보내는 집합이 yardHardPlacements 의 placed 집합과 일치.
//   4. 결정론 — 같은 seed 는 같은 배치(반복 호출·재생성 모두).
//   5. 유지 하한 — "전부 생략"으로 이탈 0을 달성하는 퇴행 금지.
//   6. 히어로 면제의 근거 — 히어로는 직사각 필지라 담과 직사각형이 정의상 일치.
//   7. 비주거 지번(궁·절·시전)은 마당 소품 계약을 공유하지 않는다.
//
// 물리 규칙: 소품은 처마(지붕) 아래를 허용하되 벽체 몸채를 관통하면 안 된다.
// 몸채 전면(지붕까지) 배제는 소품을 열린 마당으로 밀어 별채를 굶긴다 — 몸채만 배제한다.
// 별채 자체는 auxiliary-building-plan 이 전체 지붕 clearance 를 유지한다.

import { planVillage } from '../src/api/village-plan.js';
import * as G from '../src/core/math/geom2.js';
import {
  parcelLocalBodyPolygons,
  parcelLocalRoofRectangles,
} from '../src/village/house-footprint.js';
import {
  YARD_BODY_GAP,
  yardGwaeseokPosition,
  yardHardObstacles,
  yardHardPlacements,
  yardLifeWallInwardClearance,
  yardSeokjiPosition,
} from '../src/village/yard-layout.js';

const SCALES = ['hamlet', 'village', 'town', 'capital', 'hanyang'];
// 전단·오므림은 시드 종속이라 한 시드는 결함을 완전히 숨길 수 있다. 넓게 뿌린다.
const SEEDS = [7, 11, 20260716, 4242];
const EPS = 1e-6;

// 배치 유지 하한. 이탈 0을 "소품을 다 지워서" 달성하는 변경을 막는다. 폴리곤 판정만으로는
// 거의 모든 소품이 이동·축소로 살아남는다 — 현재 측정(5규모 × 4시드): 장독대·낟가리·빨래줄·
// 괴석·석지 100% · 개방 마당 텃밭 99.5% · 텃밭 96.3%. 하한은 그 아래 여유를 두고 잡는다.
const RETENTION_FLOOR = Object.freeze({
  jangdok: 0.98,
  stack: 0.95,
  clothesline: 0.95,
  vegBed: 0.90,
  openGarden: 0.90,
  gwaeseok: 0.98,
  seokji: 0.95,
});

const errors = [];
function invariant(condition, message) {
  if (!condition) errors.push(message);
}

const footprintCorners = (obstacle) => (obstacle.shape === 'circle'
  ? [
      { x: obstacle.x - obstacle.radius, z: obstacle.z },
      { x: obstacle.x + obstacle.radius, z: obstacle.z },
      { x: obstacle.x, z: obstacle.z - obstacle.radius },
      { x: obstacle.x, z: obstacle.z + obstacle.radius },
    ]
  : [
      { x: obstacle.x - obstacle.halfWidth, z: obstacle.z - obstacle.halfDepth },
      { x: obstacle.x + obstacle.halfWidth, z: obstacle.z - obstacle.halfDepth },
      { x: obstacle.x + obstacle.halfWidth, z: obstacle.z + obstacle.halfDepth },
      { x: obstacle.x - obstacle.halfWidth, z: obstacle.z + obstacle.halfDepth },
    ]);

const footprintPolygon = (obstacle) => (obstacle.shape === 'circle'
  ? [
      { x: obstacle.x - obstacle.radius, z: obstacle.z - obstacle.radius },
      { x: obstacle.x + obstacle.radius, z: obstacle.z - obstacle.radius },
      { x: obstacle.x + obstacle.radius, z: obstacle.z + obstacle.radius },
      { x: obstacle.x - obstacle.radius, z: obstacle.z + obstacle.radius },
    ]
  : [
      { x: obstacle.x - obstacle.halfWidth, z: obstacle.z - obstacle.halfDepth },
      { x: obstacle.x + obstacle.halfWidth, z: obstacle.z - obstacle.halfDepth },
      { x: obstacle.x + obstacle.halfWidth, z: obstacle.z + obstacle.halfDepth },
      { x: obstacle.x - obstacle.halfWidth, z: obstacle.z + obstacle.halfDepth },
    ]);

// 폴리곤 경계까지의 부호 있는 거리(음수 = 밖).
function signedClearance(point, polygon) {
  let nearest = Infinity;
  for (let i = 0; i < polygon.length; i++) {
    nearest = Math.min(nearest, G.distToSeg(point, polygon[i], polygon[(i + 1) % polygon.length]).d);
  }
  return G.pointInPoly(point, polygon) ? nearest : -nearest;
}

const worstClearance = (obstacle, polygon) =>
  Math.min(...footprintCorners(obstacle).map((corner) => signedClearance(corner, polygon)));

function polygonDistance(left, right) {
  if (left.some((point) => G.pointInPoly(point, right))
    || right.some((point) => G.pointInPoly(point, left))) return 0;
  let distance = Infinity;
  for (let i = 0; i < left.length; i++) {
    distance = Math.min(
      distance,
      G.segmentPolygonDistance(left[i], left[(i + 1) % left.length], right),
    );
  }
  return distance;
}

function roofRectPolygon(roof) {
  return [
    { x: roof.minX, z: roof.minZ },
    { x: roof.maxX, z: roof.minZ },
    { x: roof.maxX, z: roof.maxZ },
    { x: roof.minX, z: roof.maxZ },
  ];
}

// ── 1) 음성 대조: 수정 전 직사각형 공식 ────────────────────────────────────────
// 이 게이트가 검사하는 결함을 그대로 재현한다. 같은 픽스처에서 이것이 이탈하지 않으면
// 어서션 2가 공허하다는 뜻이므로 게이트 자체가 실패한다.
function preFixRectangleFootprints(parcel) {
  const plotW = parcel.plotW, plotD = parcel.plotD;
  const out = [];
  const rows = Math.max(0, (parcel.jangdok || 0) | 0);
  if (rows > 0) {
    const perRow = 2 + rows;
    const width = Math.min(plotW * 0.4, perRow * 0.62 + 0.4);
    const depth = rows * 0.56 + 0.3;
    out.push({
      kind: 'jangdok', shape: 'rect',
      x: -plotW / 2 + width / 2 + 0.5,
      z: -plotD / 2 + depth / 2 + 0.5,
      halfWidth: width / 2 + 0.12, halfDepth: depth / 2 + 0.12,
    });
  }
  if (parcel.yardStack && !parcel.aux) {
    out.push({
      kind: 'yard-stack', shape: 'rect',
      x: plotW / 2 - 1.65, z: -plotD / 2 + 1.75, halfWidth: 1.05, halfDepth: 1.05,
    });
  }
  if (parcel.clothesline) {
    out.push({
      kind: 'clothesline', shape: 'circle',
      x: -plotW * 0.25, z: plotD * 0.225, radius: Math.min(plotW * 0.44, 3.6) / 2 + 0.28,
    });
  }
  return out;
}

const fixtures = [];
for (const scale of SCALES) {
  for (const seed of SEEDS) {
    fixtures.push({ scale, seed, plan: planVillage({ scale, seed }) });
  }
}

let preFixEscapes = 0;
const preFixTiers = new Set();
let checkedObjects = 0, checkedParcels = 0, heroParcels = 0;
let preFixWorstOverhang = 0;
let bodyChecked = 0;
let underRoofPlaced = 0;
const retention = {};
const bumpRetention = (kind, placed) => {
  const row = (retention[kind] ||= { requested: 0, placed: 0 });
  row.requested++;
  if (placed) row.placed++;
};

for (const { scale, seed, plan } of fixtures) {
  const label = `${scale}:${seed}`;
  for (const parcel of plan.parcels || []) {
    if (!Number.isFinite(parcel.plotW) || !Number.isFinite(parcel.plotD)) continue;

    // ── 7) 비주거 지번은 마당 소품 계약 밖 ──
    if (parcel.kind !== 'giwa' && parcel.kind !== 'choga') {
      invariant(yardHardObstacles(parcel).length === 0,
        `${label}:${parcel.id} non-residential parcel (${parcel.kind}) carries yard hard objects`);
      continue;
    }
    const polygon = parcel.shape?.pts;
    if (!polygon?.length) continue;
    checkedParcels++;

    // ── 6) 히어로 면제의 근거: 직사각 필지 ──
    if (parcel.hero) {
      heroParcels++;
      invariant(polygon.length === 4,
        `${label}:${parcel.id} hero shape is not a rectangle (${polygon.length} pts) — the authored-slot exemption no longer holds`);
    } else {
      for (const obstacle of preFixRectangleFootprints(parcel)) {
        const worst = worstClearance(obstacle, polygon);
        if (worst < 0) {
          preFixEscapes++;
          preFixTiers.add(scale);
          preFixWorstOverhang = Math.max(preFixWorstOverhang, -worst);
        }
      }
    }

    const placements = yardHardPlacements(parcel);
    for (const [kind, record] of Object.entries(placements)) {
      if (record) bumpRetention(kind, record.placed);
    }
    // ── 4) 결정론: 반복 호출이 같은 배치를 내야 한다 ──
    invariant(JSON.stringify(yardHardPlacements(parcel)) === JSON.stringify(placements),
      `${label}:${parcel.id} yardHardPlacements is not a pure function of the parcel`);

    const gardenLevel = parcel.gardenLevel || 0;
    if (parcel.hero || gardenLevel >= 2) {
      for (const side of [-1, 1]) {
        const rock = yardGwaeseokPosition(parcel, side);
        bumpRetention('gwaeseok', !!rock);
        if (parcel.hero || gardenLevel >= 3) {
          bumpRetention('seokji', !!yardSeokjiPosition(parcel, side));
        }
      }
    }

    const clearance = yardLifeWallInwardClearance(parcel.wallType);
    const bodies = parcel.hero ? [] : parcelLocalBodyPolygons(parcel);
    const roofs = parcel.hero ? [] : parcelLocalRoofRectangles(parcel);
    const emitted = new Set();
    for (const obstacle of yardHardObstacles(parcel)) {
      // 부속채는 auxiliary-building-plan 이 자기 계약으로 검증한다.
      if (obstacle.kind === 'auxiliary-building' || obstacle.shape === 'polygon') continue;
      checkedObjects++;
      emitted.add(obstacle.kind);

      // ── 2) 이탈 0 ──
      const worst = worstClearance(obstacle, polygon);
      invariant(worst >= 0,
        `${label}:${parcel.id} ${obstacle.kind} escapes the parcel polygon by ${(-worst).toFixed(3)}m`);
      // 히어로는 저작 슬롯을 쓰므로 담 내측 여유를 요구하지 않는다(직사각 필지라 이탈은 없다).
      if (!parcel.hero) {
        invariant(worst >= clearance - EPS,
          `${label}:${parcel.id} ${obstacle.kind} sits ${worst.toFixed(3)}m from the wall, inside the ${clearance.toFixed(2)}m inward clearance`);
      }

      // ── 몸채 관통 금지(처마 아래는 허용) ──
      if (bodies.length) {
        const propPoly = footprintPolygon(obstacle);
        bodyChecked++;
        for (let bi = 0; bi < bodies.length; bi++) {
          const body = bodies[bi];
          const dist = polygonDistance(propPoly, body);
          invariant(dist > YARD_BODY_GAP - EPS,
            `${label}:${parcel.id} ${obstacle.kind} penetrates house body #${bi}`
            + ` (gap ${dist.toFixed(3)}m ≤ ${YARD_BODY_GAP}m)`);
        }
        // soft evidence that eaves-under-roof remains allowed
        if (roofs.some((roof) => polygonDistance(propPoly, roofRectPolygon(roof)) <= EPS)) {
          underRoofPlaced++;
        }
      }
    }

    // ── 3) 예약 == 배치 ──
    const expected = new Set();
    if (placements.jangdok?.placed) expected.add('jangdok');
    if (placements.stack?.placed) expected.add('yard-stack');
    if (placements.clothesline?.placed) expected.add('clothesline');
    if (placements.vegBed?.placed) expected.add('vegetable-bed');
    if (placements.openGarden?.placed) expected.add('open-garden');
    for (const kind of expected) {
      invariant(emitted.has(kind),
        `${label}:${parcel.id} placed ${kind} is not reserved — flora and the shed can overwrite it`);
    }
    for (const kind of ['jangdok', 'yard-stack', 'clothesline', 'vegetable-bed', 'open-garden']) {
      invariant(!emitted.has(kind) || expected.has(kind),
        `${label}:${parcel.id} reserved ${kind} was never placed — a phantom reservation blocks the yard`);
    }
  }
}

// ── 1) 음성 대조 판정 ──
invariant(preFixEscapes > 0 && preFixTiers.size >= 3,
  `the pre-fix rectangle formulas no longer escape these fixtures (${preFixEscapes} escapes across ${preFixTiers.size} tiers) — this gate can no longer prove the polygon assertion has teeth`);

// ── 5) 유지 하한 ──
for (const [kind, floor] of Object.entries(RETENTION_FLOOR)) {
  const row = retention[kind];
  invariant(row && row.requested > 0, `${kind} was never requested in any fixture`);
  if (!row?.requested) continue;
  const ratio = row.placed / row.requested;
  invariant(ratio >= floor,
    `${kind} placement retention ${(ratio * 100).toFixed(1)}% (${row.placed}/${row.requested}) fell below the ${(floor * 100).toFixed(0)}% floor — escapes must be fixed by relocating or resizing, not by deleting the yard`);
}

// Soft: 처마 밑 배치는 여전히 허용돼야 한다(몸채 배제가 지붕 전면 금지가 아님).
if (bodyChecked > 50) {
  invariant(underRoofPlaced > 0,
    `body exclusion appears to ban eaves-under-roof placement entirely (${underRoofPlaced}/${bodyChecked})`);
}

// ── 4) 결정론: 재생성이 같은 배치를 내야 한다 ──
{
  const repeat = planVillage({ scale: 'town', seed: 7 });
  const original = fixtures.find((f) => f.scale === 'town' && f.seed === 7).plan;
  const snapshot = (plan) => JSON.stringify((plan.parcels || [])
    .filter((parcel) => parcel.kind === 'giwa' || parcel.kind === 'choga')
    .map((parcel) => [parcel.id, yardHardPlacements(parcel)]));
  invariant(snapshot(repeat) === snapshot(original),
    'town:7 yard placements drifted between two identical plan builds');
}

if (errors.length) {
  console.error(`YARD POLYGON CONTRACT: FAIL (${errors.length})`);
  for (const error of errors.slice(0, 40)) console.error(`  - ${error}`);
  if (errors.length > 40) console.error(`  ... ${errors.length - 40} more`);
  process.exit(1);
}

const retentionReport = Object.entries(retention).sort()
  .map(([kind, row]) => `${kind} ${((row.placed / row.requested) * 100).toFixed(0)}%`)
  .join(', ');
console.log(
  `YARD POLYGON CONTRACT: PASS (${fixtures.length} plans, ${checkedParcels} parcels`
  + ` incl. ${heroParcels} hero, ${checkedObjects} objects, 0 outside the polygon;`
  + ` body-clear ${bodyChecked}, under-roof ${underRoofPlaced};`
  + ` pre-fix control still escapes ${preFixEscapes}× across ${preFixTiers.size} tiers`
  + ` by up to ${preFixWorstOverhang.toFixed(2)}m;`
  + ` retention ${retentionReport})`,
);
