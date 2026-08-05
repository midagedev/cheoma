import { deepFreeze } from '../core/stable-seed.js';
import { makeRng, hashString } from '../rng.js';
import * as G from '../core/math/geom2.js';
import {
  CITY_WALL_DIMENSIONS,
  cityWallAngleInAperture,
  cityWallClearance,
  cityWallRadiusAt,
  normalOnCityWall,
  pointOnCityWall,
} from './citywall-contour.js';
import { ROAD_WIDTH } from './roads.js';
import { createRoadSpatialIndex } from './road-spatial.js';
import { streamIntersectsPolygon } from './stream-spatial.js';
import { terrainMeshHeightAt } from './terrain-grid.js';

// ── 성벽 안면 부속 밴드 (gate quarter) ────────────────────────────────────────
// THREE·DOM 비의존 순수 계약. 구한말 도성 사진군(`refs/hanyang-old`, 비공개)에서 성문 좌우의
// **성벽 안쪽 면을 따라 낮은 부속채(헛간·초가급)가 붙어** 시가지가 성벽에 닿는다. 직전 라운드가
// 간선 파사드(시전 행랑)를 성문까지 이었으므로(docs/joseon-city.md §성문 주변), 남은 공백은
// 성문 좌우로 성벽 안면을 따라가는 이 밴드다 — 실측으로 성벽 안면이 전무하게 비어 있었다
// (scratch/gate-approach 프로브, 2026-08-04).
//
// 이 모듈이 단언하는 것과 단언하지 않는 것:
//   · 단언: 부속채가 성문 좌우 성벽 안면에 붙는다(사진 판독). 성벽 몸통과 사이에 순라 통로가
//     남는다(성벽은 순찰 동선을 갖는 방어 시설이므로 안쪽 면이 건물로 막히지 않는다).
//   · **미검증**(§9.3 관례): 밴드의 고증 치수. 아래 값은 전부 **제품 값**이며, 새로 저작한
//     자릿수 없이 레포가 이미 검증해 둔 수(성벽 두께·소로 폭·주칸·성문 접근 예약·초가 프리셋)의
//     파생으로만 만들었다. 근거는 각 상수 주석에 있다.
//
// 좌표계: village 공통(+z=남), 절대 world. side=+1 은 성곽 contour 각도 증가 방향(남→동→북).
// 소비자는 렌더러에서 위치를 다시 추론하지 않는다 — 레코드가 유일 진실원이다.

export const GATE_QUARTER_PLAN_SCHEMA_VERSION = 1;

// 새 의미의 산출물이므로 **새 kind** 다. 시전·필지·관아 enum 을 차용하면 아이콘·라벨·감사
// 분류가 오표시된다(2026-08-03 R17b 사고).
export const GATE_QUARTER_KIND = 'gateQuarter';

// 주칸(칸) — src/params.js PRESETS.giwa.bay · PRESETS.choga.centerBayD 와 같은 2.2m.
const KAN = 2.2;
// 초가 어휘의 기준 치수는 src/params.js PRESETS.choga 가 소유한다. 부속채는 초가삼간보다 격이
// 낮으므로 그 값들을 **상한**으로 쓰고 계수로 내린다(기둥 2.2 · 처마 1.0 · 볏짚 두께 0.52 · 기단 0.3).
const CHOGA_COLUMN_HEIGHT = 2.2;
const CHOGA_EAVE = 1.0;
const CHOGA_THATCH_THICK = 0.52;
const CHOGA_PODIUM = 0.3;
// 순라 통로 = 소로 한 폭. 새 치수를 저작하지 않고 『경국대전』 소로(11척 ≈ 3.4m, roads.js
// ROAD_WIDTH.soro)를 그대로 쓴다 — 도성에서 사람이 지나는 가장 좁은 길의 폭이다.
const PATROL_LANE = ROAD_WIDTH.soro;
// 부속채 처마. 초가 처마(1.0m)의 0.7배 — 격 낮은 부속채이므로 짧다.
const EAVE = CHOGA_EAVE * 0.7;
// 낙수 골 — 이웃 처마 끝 사이에 반드시 남는 최소 틈(처마의 1/4). 이 값이 0 이면 두 지붕이
//   서로를 관통해 "지붕 여러 개 얹힌 한 채"로 읽힌다(2026-08-05 비전 판정 ①·④).
const DRIP = EAVE * 0.25;
// 요(yaw) 상한 — 성벽 안면에 맞춰 서지만 손으로 세운 열이므로 완전 평행이 아니다. 0.05rad(2.9°)는
//   3칸 채(6.6m)의 배면 끝이 0.17m 움직이는 정도이고 이격 대역(4.4m) 안에서 흡수된다.
const YAW_MAX = 0.05;

export const GATE_QUARTER_PLAN_LIMITS = deepFreeze({
  kan: KAN,
  patrolLane: PATROL_LANE,
  eave: EAVE,
  thatchThick: CHOGA_THATCH_THICK,
  plinth: CHOGA_PODIUM,
  // 몸통 배면이 성곽 contour 중심선에서 최소 이만큼 안쪽에 있어야 한다.
  //   = 성벽 반두께(1.3) + 순라 통로(3.4) + 처마(0.7) = 5.4m.
  //   처마까지 통로 밖으로 물리므로 "순라 통로는 어떤 부재도 침범하지 않는다"가 수치로 성립한다.
  //   SIJEON_WALL_INSET(8m, 성벽 두께 + 순라 통로 몫)과 같은 급이고, 그보다 붙는 것이 이 밴드의
  //   존재 이유다(사진의 부속채는 성벽에 기대어 서고 행랑은 간선 파사드에 선다).
  wallClearanceMin: CITY_WALL_DIMENSIONS.thickness / 2 + PATROL_LANE + EAVE,
  // 밴드가 성벽에서 떨어져 시가지로 흘러가면 "성벽에 붙은 열"이 아니라 그냥 민가가 된다.
  //   상한 = 하한 + 2칸(4.4m). 오목한 contour 구간에서 안쪽으로 밀린 슬롯까지만 허용한다.
  wallClearanceMax: CITY_WALL_DIMENSIONS.thickness / 2 + PATROL_LANE + EAVE + KAN * 2,
  // 성문 개구 끝에서 좌우로 뻗는 호 길이. 새 자릿수 대신 성문 **접근 예약**(gateApproachLength 44
  //   + clearance 3 = 47m)을 그대로 쓴다 — 문 앞 통행 예약이 미치는 거리가 곧 "성문 지구"의
  //   범위라는 것이 이 프로젝트가 이미 채택한 성문 주변 스케일이다. 성문 중심 기준으로는
  //   47 + openingHalf(문 여유 반폭 ≈ 13~17m) = 60~64m 급이 된다.
  arcReach: CITY_WALL_DIMENSIONS.gateApproachLength + CITY_WALL_DIMENSIONS.gateApproachClearance,
  // footprint: 1~3칸 폭 × 깊이. 서민 가옥 상한이 10칸(가사제한)이고 초가삼간이 3~4칸 표준이므로,
  //   그 아래 급인 헛간·부속채는 1~3칸이다(docs/joseon-city.md §가사제한). **1칸을 포함하는 이유**:
  //   2~3칸만 쓰면 열이 같은 덩이의 반복이 되어 "지붕 여러 개 얹힌 창고 한 채"로 읽힌다(비전 ②).
  widthKanMin: 1,
  widthKanMax: 3,
  depthMin: KAN,
  depthMax: KAN * 1.35,
  // 한 칸 헛간은 폭이 2.2m 뿐이라 같은 깊이 대역을 쓰면 폭보다 깊어져 용마루가 사라진다(모임지붕
  //   축이 뒤집힌다). 한 칸만 0.7~0.95칸으로 얕게 잡아 용마루 축을 폭 방향으로 유지한다.
  shallowDepthMin: KAN * 0.7,
  shallowDepthMax: KAN * 0.95,
  // 이웃 사이 틈 — 두 리듬. **군집 틈**은 처마가 서로 닿지 않는 최소(처마 2폭 + 낙수 골)에서
  //   처마 3폭까지, **공백 틈**은 사람이 지나는 고샅 한 폭(소로 3.4m)에서 그 + 1.5칸까지다.
  //   v1 의 0.6~1.8m 는 처마 2폭(1.4m)에 미달해 이웃 지붕이 서로를 관통했다(비전 ④).
  gapTightMin: EAVE * 2 + DRIP,
  gapTightMax: EAVE * 3,
  gapVoidMin: PATROL_LANE,
  gapVoidMax: PATROL_LANE + KAN * 1.5,
  // 한 군집에 붙는 채 수(1~2). 1 이면 고립 한 채, 2 면 붙은 한 쌍 — 비전이 목표로 지목한 리듬이
  //   "2채 붙은 군집과 넓은 공백의 혼재"이므로 3채 이상 이어 붙이지 않는다(실측: clusterMax 3 은
  //   공백 틈이 간격의 11% 로 내려가 다시 연속 열이 됐다).
  clusterMin: 1,
  clusterMax: 2,
  drip: DRIP,
  yawMax: YAW_MAX,
  // 벽(기둥) 높이 — 초가 기둥 2.2m 의 0.70~0.95배. 상한은 v1 과 같고(성벽 상한 유도식 불변),
  //   하한만 내려 용마루 높이가 열 안에서 실제로 흔들리게 한다(비전 ②).
  bodyHeightMin: CHOGA_COLUMN_HEIGHT * 0.70,
  bodyHeightMax: CHOGA_COLUMN_HEIGHT * 0.95,
  // 볏짚 지붕 상승분(용마루까지). 상한은 v1 의 0.5칸 그대로 두고(사면 상한 유도식이 이 값을 쓴다)
  //   하한만 0.38칸으로 내려 용마루 선이 채마다 달라지게 한다.
  roofRiseMin: KAN * 0.38,
  roofRiseMax: KAN * 0.5,
  // 개구부 — 헛간 널문 한 짝. 한 칸(2.2m) 안에 달리는 문이므로 폭은 칸의 0.42~0.56배이고 높이는
  //   기둥의 0.72~0.86배(인방 아래). v1 은 개구부가 아예 없어 무창 흙벽 매스로 읽혔다(비전 ①).
  doorWidthMin: KAN * 0.42,
  doorWidthMax: KAN * 0.56,
  doorHeightRatioMin: 0.72,
  doorHeightRatioMax: 0.86,
  // 개구부 음각 깊이 = 정면 심벽 한 겹(칸의 1/12 급, 널문 문틀 두께). 정면 벽을 이 두께의
  //   좌우 벽선 + 상부 인방으로 세우고 문 칸만 비워 그늘진 구멍을 만든다(신규 재질 0).
  doorRecess: KAN * 0.08,
  // 축대 어깨(기단이 몸통보다 넓게 나오는 폭). 렌더러 상수였던 값을 계획으로 올렸다 —
  //   군집 축대를 서로 만나게 이으려면 계획이 축대의 실제 접선 스팬을 알아야 한다(비전 ③).
  plinthMargin: 0.25,
  // 축대 밑동이 지형 아래로 묻히는 깊이 = 외벌대 기단 한 켜(0.3m). 노출 리턴면을 지형까지
  //   마감한다(비전 ③ 후반). 새 자릿수가 아니라 기단 높이의 재사용이다.
  embed: CHOGA_PODIUM,
  // 밴드 전체가 성벽 지상 노출(bodyHeight 7.9 − foundationSink 2.5 = 5.4m)보다 낮아야
  //   "낮은 부속채"다. 여장 위로 지붕이 솟으면 성벽이 부속채에 먹힌다.
  maxApexAboveGround: CITY_WALL_DIMENSIONS.bodyHeight - CITY_WALL_DIMENSIONS.foundationSink,
  // 성벽은 산릉을 타므로 밴드 슬롯이 사면에 걸린다(실측 2026-08-05: 남문 안쪽 0.36~1.07m 대
  //   흥인문·돈의문 안쪽 1.02~7.43m — 좌청룡·우백호 어깨를 오르는 구간). 사면 슬롯은 필지와 같은
  //   어휘(성토 패드 + 막돌 축대)로 앉히되, **상한은 저작하지 않는다**: 낙차까지 포함한 전체
  //   덩이가 성벽 지상 노출을 넘지 않는 값이 곧 상한이다.
  //     maxApexAboveGround − (기단 + 몸통 **상한** + 지붕 상승 **상한**) = 5.4 − (0.3 + 2.09 + 1.1)
  //     = 1.91m — v2 가 몸통·지붕 상승에 변주를 준 뒤에도 상한은 둘 다 그대로이므로 이 값은 불변이다.
  //   그래서 "성벽보다 낮다"가 사면에서도 수치로 성립하고, 초과 슬롯은 조용히 생략된다
  //   (축소·부유 금지 — 요청을 미니어처로 바꾸지 않는다). 필지 예약이 쓰는 "한 계단 성토"
  //   상한(2.2m, plan.js 관아 슬롯)보다 보수적이다.
  maxTerrainSpread: (CITY_WALL_DIMENSIONS.bodyHeight - CITY_WALL_DIMENSIONS.foundationSink)
    - (CHOGA_PODIUM + CHOGA_COLUMN_HEIGHT * 0.95 + KAN * 0.5),
  // 개천·도로 회랑 여유. 도로는 배수 도랑(0.48m + 0.22 어깨)이 이미 노면 옆에 있으므로
  //   그 envelope 밖으로 물린다.
  roadClearance: 1.2,
  streamClearance: 3,
  occupiedClearance: 0.6,
  maxPerSide: 12,
  maxRecords: 96,
});

const TAU = Math.PI * 2;
const EPSILON = 1e-9;

const finitePoint = (point) => Number.isFinite(point?.x) && Number.isFinite(point?.z);

function wrapAngle(angle) {
  const a = angle % TAU;
  return a < 0 ? a + TAU : a;
}

// 밴드가 이웃 개구부(다른 성문·수문)를 넘지 못하게 하는 각도 상한. 두 성문의 밴드가 서로를
// 관통하거나 수문 석축 위에 부속채가 앉는 것을 막는다.
function sweepLimit(spec, gate, side) {
  const apertures = [
    ...(spec.gates || []).filter((other) => other !== gate),
    ...(spec.waterGates || []),
  ];
  let limit = Math.PI * 0.5;
  for (const other of apertures) {
    let delta = wrapAngle((other.angle - gate.angle) * side);
    if (delta > Math.PI) delta -= TAU;
    if (delta <= 0) continue;
    limit = Math.min(limit, Math.max(0, delta - (other.halfAngle || 0)));
  }
  return limit;
}

// 밴드 중심선을 성곽 contour 를 따라 표본화한다. 직선 근사를 쓰지 않는 이유가 여기다 —
// 성곽은 산릉을 따라 휘는 부정형 폐곡선이므로 밴드도 같은 곡률로 휘어야 한다.
function bandSamples(spec, gate, side, nominalOffset) {
  const stepCount = Math.max(64, spec.radii.length);
  const sweep = Math.min(sweepLimit(spec, gate, side), Math.PI * 0.5);
  const start = gate.angle + side * gate.halfAngle;
  const step = TAU / (stepCount * 4);
  const samples = [];
  let previous = null;
  let s = 0;
  for (let index = 0; ; index++) {
    const delta = step * index;
    if (delta > sweep + EPSILON) break;
    const angle = start + side * delta;
    if (index > 0 && cityWallAngleInAperture(spec, angle)) break;
    const radius = cityWallRadiusAt(spec, angle) - nominalOffset;
    if (!(radius > 0)) break;
    const point = {
      x: spec.cx + Math.sin(angle) * radius,
      z: spec.cz + Math.cos(angle) * radius,
    };
    if (previous) s += G.dist(previous, point);
    samples.push({ angle, s });
    previous = point;
  }
  return samples;
}

// 호 길이 s 위치의 contour 각도(선형 보간). 밴드의 실제 좌표·법선은 이 각도에서 다시
// contour 계약(pointOnCityWall/normalOnCityWall)으로 뽑는다 — 좌표를 두 번 저작하지 않는다.
function angleAtArc(samples, s) {
  if (samples.length < 2) return null;
  if (s < 0 || s > samples.at(-1).s) return null;
  let lo = 0;
  let hi = samples.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].s <= s) lo = mid;
    else hi = mid;
  }
  const span = samples[hi].s - samples[lo].s;
  const t = span > EPSILON ? (s - samples[lo].s) / span : 0;
  return samples[lo].angle + (samples[hi].angle - samples[lo].angle) * t;
}

// 성벽 법선을 yaw 만큼 돌린다. 부재를 돌리는 것이 아니라 **배치 프레임 자체**를 돌리므로
// footprint·지붕 사각·축대가 모두 같은 각도를 공유하고, 소비자는 frontDir 하나만 읽으면 된다.
function rotateXZ(v, angle) {
  const c = Math.cos(angle), s = Math.sin(angle);
  return { x: v.x * c - v.z * s, z: v.x * s + v.z * c };
}

function footprintAt(spec, angle, side, width, depth, clearance, yaw = 0) {
  const anchor = pointOnCityWall(spec, angle);
  const normal = normalOnCityWall(spec, angle);
  const inward = yaw ? rotateXZ(G.mul(normal, -1), yaw) : G.mul(normal, -1);
  // 접선은 side 진행 방향을 향하게 잡아 poly 정점 순서가 두 면에서 같은 감기를 갖는다.
  const tangent = G.mul(G.perpL(inward), side);
  const base = G.add(anchor, G.mul(inward, clearance));
  return {
    poly: G.frontageParcel(base, tangent, inward, width / 2, depth, 0),
    inward,
    tangent,
  };
}

// center·frontDir 만으로 재구성되는 회전 사각(지붕 처마 사각·축대 사각). poly 를 레코드에 중복
// 저장하지 않고 이 유도식을 계약으로 삼는다 — 게이트와 렌더러는 각자 같은 식을 다시 세운다
// (계측기와 계획이 같은 함수를 공유하면 그 함수의 버그를 둘 다 못 본다).
//   offsetX = 로컬 +x(= perpL(frontDir)) 방향 중심 이동, halfW/halfD = 접선·법선 반폭.
function orientedRect(center, frontDir, halfW, halfD, offsetX = 0) {
  const t = G.perpL(frontDir);
  const cx = center.x + t.x * offsetX;
  const cz = center.z + t.z * offsetX;
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => ({
    x: cx + t.x * halfW * a + frontDir.x * halfD * b,
    z: cz + t.z * halfW * a + frontDir.z * halfD * b,
  }));
}

// 지붕 처마 사각(낙수 골 절반씩 부풀린다). 두 채의 이 사각이 겹치면 지붕이 서로를 관통한다.
function roofRect(record, pad = 0) {
  return orientedRect(record.center, record.frontDir,
    record.w / 2 + record.eave + pad, record.d / 2 + record.eave + pad);
}

// 축대 사각(비대칭 스팬). 군집 이웃 쪽으로 늘어난 축대까지 포함한 실제 접지 면적이다.
function stoneRect(record) {
  const stone = record.stone;
  const halfW = (stone.spanNegX + stone.spanPosX) / 2;
  return orientedRect(record.center, record.frontDir, halfW, stone.depth / 2,
    (stone.spanPosX - stone.spanNegX) / 2);
}

function clearanceRange(spec, poly) {
  let min = Infinity;
  let max = -Infinity;
  for (const point of poly) {
    const clearance = cityWallClearance(spec, point);
    if (clearance < min) min = clearance;
    if (clearance > max) max = clearance;
  }
  return { min, max };
}

// 사각 접지 면적의 지형 최저점. 귀 4점만 보면 변 가운데가 더 낮은 오목 지형에서 축대 밑동이
// 떠서 리턴면이 노출된다(비전 ③) — 5×5 격자로 훑는다. 게이트는 더 촘촘한 격자로 교차 확인한다.
function sampleRectFloor(site, rect, steps = 4) {
  let min = Infinity;
  for (let i = 0; i <= steps; i++) {
    const u = i / steps;
    const left = G.lerp(rect[0], rect[3], u);
    const right = G.lerp(rect[1], rect[2], u);
    for (let j = 0; j <= steps; j++) {
      const point = G.lerp(left, right, j / steps);
      const y = terrainMeshHeightAt(site, point.x, point.z);
      if (!Number.isFinite(y)) return null;
      if (y < min) min = y;
    }
  }
  return Number.isFinite(min) ? min : null;
}

const terrainFloor = (site, rect) => sampleRectFloor(site, rect, 4);

function terrainRange(site, poly, center) {
  let min = Infinity;
  let max = -Infinity;
  for (const point of [...poly, center]) {
    const y = terrainMeshHeightAt(site, point.x, point.z);
    if (!Number.isFinite(y)) return null;
    if (y < min) min = y;
    if (y > max) max = y;
  }
  return { min, max };
}

/**
 * Plan the low outbuilding band that hugs the inner face of the city wall beside
 * each approach gate.
 *
 * Pure and RNG-isolated: every dimension comes from a record-local seed stream,
 * so the shared village RNG window (and therefore every other plan feature) is
 * untouched. Ordinary settlements without a city wall return an empty plan.
 *
 * `keepOut` are hard reservations the band may not overlap at all (gate
 * forecourts, gate approach corridors, palace precinct/plaza). `occupied` are
 * existing footprints (parcels, sijeon rows, temple reservations, paddies,
 * pavilion/props) kept clear with `occupiedClearance`. `solarCorridors` are the
 * winter-sun corridors of already-placed parcels — a shed south of a house may
 * not stand in one.
 */
export function planGateQuarters({
  cityWall = null,
  site = null,
  roads = [],
  seed = 0,
  keepOut = [],
  occupied = [],
  solarCorridors = [],
} = {}) {
  const records = [];
  const bands = [];
  if (cityWall?.gates?.length && site && typeof site.heightAt === 'function') {
    const limits = GATE_QUARTER_PLAN_LIMITS;
    const roadList = (roads || []).filter((road) => (road?.pts || []).length >= 2);
    const roadSpatial = roadList.length ? createRoadSpatialIndex(roadList) : null;
    // 성문 지구가 성립하는 문 = 실제로 길이 그 문을 지나는 문. `road.wallApproach` 만 보면 안 된다:
    //   roads.js 는 성 밖으로 **연장한** 길(남문 접근로)에만 그 태그를 붙이므로, 종로가 지나는
    //   흥인문·돈의문이 조용히 빠진다(실측 2026-08-05: 태그로만 판정하면 밴드가 남문 하나에만
    //   생겼다). 문 개구 반폭 안으로 길이 들어오는지를 직접 본다. 숙정문은 접근 간선이 없는
    //   설계라(roads.js hanyang 분기) 이 조건에서 자연히 빠진다 — 이름 예외가 아니다.
    const hasApproach = (gate) => roadList.some((road) => (
      road.wallApproach?.gate === gate.name
      || G.distToPolyline(gate, road.pts).d <= (gate.openingHalf || gate.width * 0.5)
    ));
    const hardPolys = (keepOut || []).filter((poly) => (poly?.length || 0) >= 3);
    const softPolys = (occupied || []).filter((poly) => (poly?.length || 0) >= 3);
    const solarPolys = (solarCorridors || []).filter((poly) => (poly?.length || 0) >= 3);
    const nominalOffset = limits.wallClearanceMin + (limits.depthMin + limits.depthMax) / 4;
    let serial = 0;

    for (const gate of cityWall.gates) {
      if (!hasApproach(gate)) {
        bands.push({ gate: gate.name, side: 0, count: 0, reason: 'no-approach-arterial' });
        continue;
      }
      for (const side of [1, -1]) {
        const samples = bandSamples(cityWall, gate, side, nominalOffset);
        const reach = Math.min(limits.arcReach, samples.length ? samples.at(-1).s : 0);
        const accepted = [];
        // 슬롯 탈락 사유 집계. 밴드가 비는 시드를 "우연"으로 넘기지 않기 위한 계획 자체의 증거이며
        //   게이트가 이 수를 읽는다(빈 밴드의 원인이 무엇인지 계획이 스스로 보고한다).
        const rejected = {
          clearance: 0, keepOut: 0, occupied: 0, solar: 0, neighbour: 0,
          roof: 0, road: 0, stream: 0, terrain: 0,
        };
        let cursor = 0;
        // 군집 리듬 상태. clusterLeft > 0 이면 다음 채가 같은 군집에 붙는다(좁은 틈), 0 이면
        //   군집이 끝나 공백 틈이 온다. 슬롯 rng 는 슬롯마다 새로 만들지만 이 상태는 이어진다 —
        //   같은 시드에서 같은 순서로 재현되므로 결정론은 유지된다.
        let clusterLeft = 0;
        let prevYawSlack = 0;
        for (let slot = 0; slot < limits.maxPerSide && records.length < limits.maxRecords; slot++) {
          const rng = makeRng(hashString(`gate-quarter|${seed >>> 0}|${gate.name}|${side}|${slot}`));
          // 칸수 분포 — 한두 칸이 흔하고 세 칸은 드물다(30/42/28). 균등 추출이면 열이 같은
          //   덩이의 반복으로 읽힌다(비전 ②).
          const kanRoll = rng();
          const widthKan = kanRoll < 0.30 ? 1 : kanRoll < 0.72 ? 2 : 3;
          const width = widthKan * limits.kan;
          const depth = widthKan === 1
            ? rng.range(limits.shallowDepthMin, limits.shallowDepthMax)
            : rng.range(limits.depthMin, limits.depthMax);
          const bodyHeight = rng.range(limits.bodyHeightMin, limits.bodyHeightMax);
          const roofRise = rng.range(limits.roofRiseMin, limits.roofRiseMax);
          const yaw = rng.range(-limits.yawMax, limits.yawMax);
          const doorWidth = rng.range(limits.doorWidthMin, limits.doorWidthMax);
          const doorHeight = bodyHeight
            * rng.range(limits.doorHeightRatioMin, limits.doorHeightRatioMax);
          const doorBay = rng.int(0, widthKan - 1);
          if (clusterLeft <= 0) clusterLeft = rng.int(limits.clusterMin, limits.clusterMax);
          clusterLeft -= 1;
          const inCluster = clusterLeft > 0;
          // 요(yaw)로 지붕 사각이 접선 방향으로 더 벌어지는 몫. 두 채가 서로를 향해 기울면
          //   틈이 실제로는 이만큼 좁아지므로 미리 더해 준다(비전 ④ 하드 Z 교차 원인).
          const yawSlack = (depth / 2 + limits.eave) * Math.abs(Math.sin(yaw));
          const gapFloor = limits.eave * 2 + limits.drip + prevYawSlack + yawSlack;
          const gap = Math.max(
            inCluster
              ? rng.range(limits.gapTightMin, limits.gapTightMax)
              : rng.range(limits.gapVoidMin, limits.gapVoidMax),
            gapFloor,
          );
          prevYawSlack = yawSlack;
          const midArc = cursor + width / 2;
          cursor += width + gap;
          if (midArc + width / 2 > reach) break;
          const angle = angleAtArc(samples, midArc);
          if (angle == null) break;

          // 오목한 contour 구간에서는 배면 양끝이 성벽 쪽으로 부풀어 이격 하한을 깬다.
          //   부족분만큼 안쪽으로 물리고(최대 상한까지), 그래도 못 지키면 그 슬롯을 생략한다.
          let clearance = limits.wallClearanceMin;
          let placement = footprintAt(cityWall, angle, side, width, depth, clearance, yaw);
          let range = clearanceRange(cityWall, placement.poly);
          for (let nudge = 0; nudge < 4 && range.min < limits.wallClearanceMin; nudge++) {
            clearance += limits.wallClearanceMin - range.min;
            placement = footprintAt(cityWall, angle, side, width, depth, clearance, yaw);
            range = clearanceRange(cityWall, placement.poly);
          }
          if (range.min + 1e-6 < limits.wallClearanceMin
            || range.max > limits.wallClearanceMax) { rejected.clearance++; continue; }

          const { poly } = placement;
          if (hardPolys.some((other) => G.polysOverlap(poly, other))) { rejected.keepOut++; continue; }
          // 여유를 둔 검사용 footprint 는 offsetPoly(감기 의존) 대신 같은 배치 함수로 한 치수 크게
          //   다시 만든다 — 회전된 사각형이므로 결과가 정확하고 감기 부호에 좌우되지 않는다.
          const pad = limits.occupiedClearance;
          const padded = footprintAt(
            cityWall, angle, side, width + pad * 2, depth + pad * 2, clearance - pad, yaw,
          ).poly;
          if (softPolys.some((other) => G.polysOverlap(padded, other))) { rejected.occupied++; continue; }
          if (solarPolys.some((other) => G.polysOverlap(poly, other))) { rejected.solar++; continue; }
          if (accepted.some((other) => G.polysOverlap(padded, other.poly))
            || records.some((other) => other.gate === gate.name
              && G.polysOverlap(padded, other.poly))) { rejected.neighbour++; continue; }
          if (roadSpatial?.intersectsRoadCorridor(poly, limits.roadClearance)) { rejected.road++; continue; }
          if (streamIntersectsPolygon(site, poly, limits.streamClearance)) { rejected.stream++; continue; }

          const center = G.polyCentroid(poly);
          const terrain = terrainRange(site, poly, center);
          if (!terrain || terrain.max - terrain.min > limits.maxTerrainSpread) {
            rejected.terrain++;
            continue;
          }

          const record = {
            id: `gq${serial++}`,
            kind: GATE_QUARTER_KIND,
            gate: gate.name,
            side,
            slot,
            arc: midArc,
            poly: poly.map((point) => ({ x: point.x, z: point.z })),
            center: { x: center.x, z: center.z },
            frontDir: { x: placement.inward.x, z: placement.inward.z },
            // 성벽 법선에서 돌아간 각(rad). 소비자는 frontDir 로 세우면 되고 이 값은 변주 증거다.
            yaw,
            w: width,
            d: depth,
            widthKan,
            // 칸 = 정면 벽선의 분할 수. 기둥은 칸 경계마다(= bays + 1) 선다.
            bays: widthKan,
            // 개구부: 어느 칸에 널문이 달리는지와 그 칸 중심의 로컬 x 오프셋.
            door: {
              bay: doorBay,
              offsetX: (doorBay + 0.5) * limits.kan - width / 2,
              w: doorWidth,
              h: doorHeight,
              recess: limits.doorRecess,
            },
            baseY: terrain.max,
            terrain: { minY: terrain.min, maxY: terrain.max },
            wallClearance: { min: range.min, max: range.max },
            roof: 'thatch',
            heights: {
              // pad = baseY 아래로 내려가는 성토·막돌 축대 낙차(사면 슬롯을 수평으로 앉힌다).
              //   plinth = 그 위의 기단(외벌대) 높이. 몸통 바닥면은 baseY + plinth 다.
              pad: terrain.max - terrain.min,
              plinth: limits.plinth,
              body: bodyHeight,
              roofRise: roofRise,
              thatchThick: limits.thatchThick,
              embed: limits.embed,
            },
            eave: limits.eave,
            apexY: terrain.max + limits.plinth + bodyHeight + roofRise,
            // 축대(막돌 기단). 접선 스팬은 좌우 비대칭이 될 수 있다 — 군집 이웃 쪽으로 늘려
            //   두 축대가 만나면 사이에 지형이 들여다보이는 노치가 사라진다(비전 ③).
            //   spanNegX/spanPosX 는 **로컬 +x = perpL(frontDir)** 기준이고, bottomY 는 자기
            //   접지 면적의 지형 최저점보다 embed 만큼 더 내려간다(리턴면 마감).
            stone: {
              spanNegX: width / 2 + limits.plinthMargin,
              spanPosX: width / 2 + limits.plinthMargin,
              depth: depth + limits.plinthMargin * 2,
              topY: terrain.max + limits.plinth,
              bottomY: terrain.min - limits.embed,
            },
          };
          // 지붕 처마 사각이 이미 놓인 채와 겹치면(낙수 골 미달) 그 슬롯은 생략한다. 위 gapFloor
          //   가 같은 면의 연속 슬롯을 이미 벌려 두므로 여기 걸리는 것은 다른 문·다른 면의
          //   밴드가 마주치는 경우다.
          const half = limits.drip / 2;
          if (records.some((other) => G.polysOverlap(roofRect(record, half), roofRect(other, half)))) {
            rejected.roof++;
            continue;
          }
          accepted.push(record);
          records.push(record);
        }
        // 군집 축대 접합 — 좁은 틈으로 이웃한 두 채의 축대를 중간에서 만나게 늘린다. 늘린 접지
        //   면적이 도로·개천·예약을 건드리면 접합을 포기하고 사유를 남긴다(조용한 미접합 금지).
        const joins = [];
        for (let i = 0; i + 1 < accepted.length; i++) {
          const a = accepted[i];
          const b = accepted[i + 1];
          const free = G.dist(a.center, b.center)
            - (a.w / 2 + limits.plinthMargin) - (b.w / 2 + limits.plinthMargin);
          const entry = { from: a.id, to: b.id, free: free, joined: false };
          if (!(free > 0) || free > limits.gapTightMax) {
            entry.reason = 'void-gap';
            joins.push(entry);
            continue;
          }
          // 두 축대의 요가 다르면 맞댄 면이 쐐기 틈을 남긴다 — 그 폭만큼 서로 파고들게 한다.
          const wedge = (Math.abs(a.yaw) + Math.abs(b.yaw))
            * (Math.max(a.d, b.d) / 2 + limits.plinthMargin);
          const extend = free / 2 + wedge + limits.plinthMargin * 0.1;
          // 다음 슬롯이 로컬 +x(= perpL(frontDir)) 쪽인가. contour 각도 증가 방향은
          //   d/dθ (sinθ, cosθ) = (cosθ, −sinθ) 이고 perpL(inward) = (−cosθ, sinθ) 이므로
          //   **로컬 +x 는 호가 감소하는 쪽**이다 — side 부호가 그것을 한 번 더 뒤집는다.
          //   (실측 2026-08-05: side +1 에서 dot(+x, 다음채) = −7.4, side −1 에서 +9.2)
          const forward = side === -1;
          const grown = [
            { record: a, key: forward ? 'spanPosX' : 'spanNegX' },
            { record: b, key: forward ? 'spanNegX' : 'spanPosX' },
          ];
          const trial = grown.map(({ record, key }) => {
            const stone = { ...record.stone, [key]: record.stone[key] + extend };
            return { record, key, stone, rect: stoneRect({ ...record, stone }) };
          });
          const blocked = trial.find(({ rect }) => (
            hardPolys.some((other) => G.polysOverlap(rect, other))
            || softPolys.some((other) => G.polysOverlap(rect, other))
            || roadSpatial?.intersectsRoadCorridor(rect, limits.roadClearance)
            || streamIntersectsPolygon(site, rect, limits.streamClearance)
          ));
          if (blocked) {
            entry.reason = 'blocked-ground';
            joins.push(entry);
            continue;
          }
          for (const { record, key, stone, rect } of trial) {
            record.stone[key] = stone[key];
            // 늘어난 접지 면적의 지형 최저점을 다시 재고 그보다 embed 만큼 더 내린다.
            const low = terrainFloor(site, rect);
            if (low != null) record.stone.bottomY = Math.min(record.stone.bottomY, low - limits.embed);
          }
          entry.joined = true;
          entry.extend = extend;
          joins.push(entry);
        }
        // 접합이 없더라도 축대 밑동은 자기 접지 면적 전체에서 지형 아래로 묻혀야 한다(노출 리턴면).
        for (const record of accepted) {
          const low = terrainFloor(site, stoneRect(record));
          if (low != null) {
            record.stone.bottomY = Math.min(record.stone.bottomY, low - limits.embed);
          }
        }
        bands.push({
          gate: gate.name,
          side,
          count: accepted.length,
          reach,
          arcCovered: accepted.length ? accepted.at(-1).arc + accepted.at(-1).w / 2 : 0,
          rejected,
          joins,
        });
      }
    }
  }

  return deepFreeze({
    schema: GATE_QUARTER_PLAN_SCHEMA_VERSION,
    kind: GATE_QUARTER_KIND,
    frame: {
      space: 'world',
      yDatum: 'terrain-max-corner',
      side: '+1-wall-angle-increasing',
      frontDir: 'city-inward',
    },
    records,
    bands,
  });
}

function finite(value, label) {
  if (!Number.isFinite(value)) throw new TypeError(`${label} must be finite`);
  return value;
}

export function validateGateQuarterPlan(plan) {
  if (!plan || typeof plan !== 'object') throw new TypeError('gate quarter plan must be an object');
  if (plan.schema !== GATE_QUARTER_PLAN_SCHEMA_VERSION) {
    throw new RangeError(`gate quarter schema must be ${GATE_QUARTER_PLAN_SCHEMA_VERSION}`);
  }
  if (plan.kind !== GATE_QUARTER_KIND) {
    throw new RangeError(`gate quarter plan kind must be ${GATE_QUARTER_KIND}`);
  }
  if (!Array.isArray(plan.records) || !Array.isArray(plan.bands)) {
    throw new TypeError('gate quarter records and bands must be arrays');
  }
  if (plan.frame?.space !== 'world'
    || plan.frame?.yDatum !== 'terrain-max-corner'
    || plan.frame?.side !== '+1-wall-angle-increasing'
    || plan.frame?.frontDir !== 'city-inward') {
    throw new RangeError('gate quarter coordinate frame is unsupported');
  }
  const limits = GATE_QUARTER_PLAN_LIMITS;
  if (plan.records.length > limits.maxRecords) {
    throw new RangeError('gate quarter record count exceeds plan limits');
  }
  const ids = new Set();
  const perSide = new Map();
  for (const record of plan.records) {
    if (typeof record.id !== 'string' || !record.id || ids.has(record.id)) {
      throw new RangeError('gate quarter records require unique stable IDs');
    }
    ids.add(record.id);
    if (record.kind !== GATE_QUARTER_KIND) {
      throw new RangeError(`${record.id} must carry the gateQuarter kind`);
    }
    if (record.side !== 1 && record.side !== -1) {
      throw new RangeError(`${record.id} has an invalid side`);
    }
    const sideKey = `${record.gate}|${record.side}`;
    perSide.set(sideKey, (perSide.get(sideKey) || 0) + 1);
    if (perSide.get(sideKey) > limits.maxPerSide) {
      throw new RangeError(`${record.gate} side ${record.side} exceeds its slot cap`);
    }
    if (!Array.isArray(record.poly) || record.poly.length !== 4
      || !record.poly.every(finitePoint)) {
      throw new TypeError(`${record.id} must own a finite quad footprint`);
    }
    if (!finitePoint(record.center) || !finitePoint(record.frontDir)) {
      throw new TypeError(`${record.id} has an invalid center or frontDir`);
    }
    if (Math.abs(Math.hypot(record.frontDir.x, record.frontDir.z) - 1) > 1e-6) {
      throw new RangeError(`${record.id} frontDir must be a unit vector`);
    }
    if (!Number.isInteger(record.widthKan)
      || record.widthKan < limits.widthKanMin
      || record.widthKan > limits.widthKanMax) {
      throw new RangeError(`${record.id} width must be ${limits.widthKanMin}~${limits.widthKanMax} kan`);
    }
    if (Math.abs(record.w - record.widthKan * limits.kan) > 1e-9) {
      throw new RangeError(`${record.id} width must be a whole kan multiple`);
    }
    const depthFloor = record.widthKan === 1 ? limits.shallowDepthMin : limits.depthMin;
    const depthCeil = record.widthKan === 1 ? limits.shallowDepthMax : limits.depthMax;
    if (record.d + 1e-9 < depthFloor || record.d > depthCeil + 1e-9) {
      throw new RangeError(`${record.id} depth leaves the planned band`);
    }
    // 폭보다 깊으면 모임지붕 용마루 축이 뒤집혀 부속채가 정자처럼 읽는다.
    if (record.d > record.w + 1e-9) {
      throw new RangeError(`${record.id} is deeper than it is wide`);
    }
    if (record.roof !== 'thatch') {
      throw new RangeError(`${record.id} must be a thatched outbuilding`);
    }
    if (!Number.isFinite(record.yaw) || Math.abs(record.yaw) > limits.yawMax + 1e-9) {
      throw new RangeError(`${record.id} yaw leaves the planned jitter band`);
    }
    if (record.bays !== record.widthKan) {
      throw new RangeError(`${record.id} bay count must equal its kan count`);
    }
    const door = record.door;
    if (!door || !Number.isInteger(door.bay) || door.bay < 0 || door.bay >= record.bays) {
      throw new RangeError(`${record.id} door must sit in one of its bays`);
    }
    if (!(door.w > 0) || door.w + 1e-9 < limits.doorWidthMin || door.w > limits.doorWidthMax + 1e-9) {
      throw new RangeError(`${record.id} door width leaves the planned opening band`);
    }
    if (!(door.h > 0) || door.h > record.heights.body - 1e-9) {
      throw new RangeError(`${record.id} door head rises past its column height`);
    }
    if (Math.abs(door.offsetX - ((door.bay + 0.5) * limits.kan - record.w / 2)) > 1e-9) {
      throw new RangeError(`${record.id} door offset disagrees with its bay`);
    }
    // 문이 자기 칸을 벗어나면 기둥선을 먹어 개구부가 벽선 분할과 어긋난다.
    if (Math.abs(door.offsetX) + door.w / 2 > record.w / 2 - 1e-9) {
      throw new RangeError(`${record.id} door leaves its wall face`);
    }
    if (door.recess !== limits.doorRecess) {
      throw new RangeError(`${record.id} door recess must be the planned depth`);
    }
    finite(record.arc, `${record.id}.arc`);
    if (record.arc - record.w / 2 < -1e-6 || record.arc + record.w / 2 > limits.arcReach + 1e-6) {
      throw new RangeError(`${record.id} leaves the planned gate-quarter arc`);
    }
    const clearance = record.wallClearance;
    if (!Number.isFinite(clearance?.min) || !Number.isFinite(clearance?.max)) {
      throw new TypeError(`${record.id} has an invalid wall clearance record`);
    }
    if (clearance.min + 1e-6 < limits.wallClearanceMin) {
      throw new RangeError(`${record.id} crowds the wall patrol lane`);
    }
    if (clearance.max > limits.wallClearanceMax + 1e-6) {
      throw new RangeError(`${record.id} drifts off the wall face`);
    }
    // 처마까지 순라 통로 밖으로 물러났는가 — 밴드의 존재 이유가 걸린 계약이다.
    const laneLeft = clearance.min - record.eave - CITY_WALL_DIMENSIONS.thickness / 2;
    if (laneLeft + 1e-6 < limits.patrolLane) {
      throw new RangeError(`${record.id} eave eats the ${limits.patrolLane}m patrol lane`);
    }
    const heights = record.heights;
    if (!heights || heights.plinth !== limits.plinth
      || heights.thatchThick !== limits.thatchThick
      || heights.embed !== limits.embed
      || !Number.isFinite(heights.pad) || heights.pad < 0) {
      throw new RangeError(`${record.id} has an unsupported height section`);
    }
    if (heights.body + 1e-9 < limits.bodyHeightMin || heights.body > limits.bodyHeightMax + 1e-9) {
      throw new RangeError(`${record.id} body height leaves the outbuilding rank`);
    }
    if (heights.roofRise + 1e-9 < limits.roofRiseMin
      || heights.roofRise > limits.roofRiseMax + 1e-9) {
      throw new RangeError(`${record.id} roof rise leaves the outbuilding rank`);
    }
    finite(record.baseY, `${record.id}.baseY`);
    finite(record.terrain?.minY, `${record.id}.terrain.minY`);
    finite(record.terrain?.maxY, `${record.id}.terrain.maxY`);
    const spread = record.terrain.maxY - record.terrain.minY;
    if (spread > limits.maxTerrainSpread + 1e-9) {
      throw new RangeError(`${record.id} sits on a slope beyond one earth step`);
    }
    if (Math.abs(heights.pad - spread) > 1e-9) {
      throw new RangeError(`${record.id} pad must level exactly its terrain drop`);
    }
    if (Math.abs(record.baseY - record.terrain.maxY) > 1e-9) {
      throw new RangeError(`${record.id} must sit on its highest terrain corner`);
    }
    const apex = record.baseY + heights.plinth + heights.body + heights.roofRise;
    if (Math.abs(record.apexY - apex) > 1e-9) {
      throw new RangeError(`${record.id} apexY disagrees with its height section`);
    }
    // 사면 슬롯의 실제 시각 높이는 **가장 낮은 지형 귀**에서 재야 한다. 축대 낙차까지 포함해도
    //   성벽 지상 노출(5.4m)을 넘지 않는 것이 "낮은 부속채"의 수치 정의다.
    if (apex - record.terrain.minY > limits.maxApexAboveGround + 1e-9) {
      throw new RangeError(`${record.id} rises past the exposed wall body`);
    }
    const stone = record.stone;
    const bareSpan = record.w / 2 + limits.plinthMargin;
    if (!stone || !Number.isFinite(stone.spanNegX) || !Number.isFinite(stone.spanPosX)
      || !Number.isFinite(stone.depth) || !Number.isFinite(stone.topY)
      || !Number.isFinite(stone.bottomY)) {
      throw new TypeError(`${record.id} has an invalid retaining-wall section`);
    }
    if (stone.spanNegX + 1e-9 < bareSpan || stone.spanPosX + 1e-9 < bareSpan) {
      throw new RangeError(`${record.id} retaining wall is narrower than its body`);
    }
    // 접합은 이웃 쪽으로만 늘어난다 — 군집 틈(처마 3폭)의 절반 + 쐐기 보정이 상한이다.
    const maxExtend = limits.gapTightMax / 2 + limits.yawMax * 2
      * (limits.depthMax / 2 + limits.plinthMargin) + limits.plinthMargin;
    if (stone.spanNegX > bareSpan + maxExtend || stone.spanPosX > bareSpan + maxExtend) {
      throw new RangeError(`${record.id} retaining wall runs past its cluster gap`);
    }
    if (Math.abs(stone.depth - (record.d + limits.plinthMargin * 2)) > 1e-9) {
      throw new RangeError(`${record.id} retaining wall depth must shoulder its body`);
    }
    if (Math.abs(stone.topY - (record.baseY + limits.plinth)) > 1e-9) {
      throw new RangeError(`${record.id} retaining wall must top out at its plinth`);
    }
    // 리턴면 마감: 밑동이 자기 접지 면적의 지형 최저점보다 embed 만큼 아래여야 한다.
    if (stone.bottomY > record.terrain.minY - limits.embed + 1e-9) {
      throw new RangeError(`${record.id} retaining wall leaves an exposed return face`);
    }
  }
  for (let i = 0; i < plan.records.length; i++) {
    for (let j = i + 1; j < plan.records.length; j++) {
      if (G.polysOverlap(plan.records[i].poly, plan.records[j].poly)) {
        throw new RangeError(`${plan.records[i].id} overlaps ${plan.records[j].id}`);
      }
    }
  }
  // 지붕 처마 사각이 서로 파고들면 여러 채가 한 덩이로 읽힌다(2026-08-05 비전 ④). 낙수 골
  //   절반씩 부풀린 사각이 겹치지 않는 것이 "한 채씩 읽힌다"의 수치 정의다.
  const half = limits.drip / 2;
  const roofs = plan.records.map((record) => roofRect(record, half));
  for (let i = 0; i < roofs.length; i++) {
    for (let j = i + 1; j < roofs.length; j++) {
      if (G.polysOverlap(roofs[i], roofs[j])) {
        throw new RangeError(
          `${plan.records[i].id} roof intersects ${plan.records[j].id} (no ${limits.drip}m drip gap)`,
        );
      }
    }
  }
  return plan;
}
