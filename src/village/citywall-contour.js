import * as G from '../core/math/geom2.js';
import { streamSurfaceHeightAt, terrainMeshHeightAt } from './terrain-grid.js';

// 한양 성곽의 순수 평면 계약. 좌표는 village 공통 규약(+z=남)을 따른다.
// plan·roads·parcels·forest·renderer가 같은 contour와 치수를 소비하므로 성문, 길, 식생,
// 렌더 메시가 서로 다른 원을 재구성하지 않는다. DOM/THREE 비의존이라 외부 생성 엔진에서도 재사용 가능하다.

const TAU = Math.PI * 2;
const WALL_SCALE = 1.12;
const CORE_MARGIN = 10;
const EDGE_INSET = 14;
const TARGET_SEGMENT = 7.5;
const MITER_LIMIT = 2.4;
const GATE_ANGLE_STEPS = 80;
const JONGNO_STEPS = 48;
const TERRAIN_WARP_INSET = 6;

// 외딴집은 성곽을 둘러야 할 취락이 아니다. 초락 이상은 각 tier 도로를 성문에 정렬하고, 그보다 작은
// 유효 입력은 예외 대신 경고와 함께 성곽을 생략한다(plan.js).
export const CITY_WALL_MIN_SITE_R = 74;

// 계획·렌더·검증이 함께 쓰는 물리 치수. bodyHeight-foundationSink=지상 노출 높이(5.4m)는 유지한다.
// 육축 한 덩이 폭. 계획이 예약하는 문 여유폭(gateExtraWidth)은 좌우 육축 두 덩이이므로 정확히
// 이 값의 2배다. 두 곳에 따로 저작하면 한쪽만 바뀌었을 때 석축이 예약 범위를 넘거나 덜 채운다.
const GATE_PIER_WIDTH = 5.5;

export const CITY_WALL_DIMENSIONS = Object.freeze({
  thickness: 2.6,
  foundationSink: 2.5,
  bodyHeight: 7.9,
  capHeight: 0.9,
  maxSegmentLength: 3,
  maxTerrainError: 0.4,
  maxSubdivisionDepth: 5,
  gateDepth: 8.5,
  gateExtraWidth: GATE_PIER_WIDTH * 2,
  gateFoundationSink: 0.6,
  gateArchClearance: 4.4,
  gateLintelHeight: 1.2,
  gateTerrainReveal: 0.5,
  gateTerrainSampleSafety: 0.5,
  gateMaxPierHeight: 18.5,
  gateStreamClearance: 3,
  gateRoadClearance: 0.4,
  majorGateMinOpening: 18,
  maxGateOpening: 26,
  vegetationClearance: 10,
  gateVegetationMargin: 10,
  gateApproachLength: 44,
  gateApproachClearance: 3,
  roadEdgeMargin: 3,
});

// 성벽 몸통 석재 위계(#19 R3). 구한말 사진의 도성 석성은 큰 대석을 쌓은 아래 켜와 그 위 몸통이
// 얕은 수평 단차로 갈린다. 위 켜는 검증된 두께 envelope **안으로만** 물러나므로(바깥으로 자라지
// 않음) world edge·지형 밀착·여장 이음 계약이 그대로 유지된다.
//   몸통 배터는 육축과 같은 어휘(≈8%)를 쓰되 여장 두께(thickness*0.7)보다 얇아지지 않는다.
export const CITY_WALL_COURSES = Object.freeze({
  baseFraction: 0.40,   // 지상 노출 높이 중 대석 기단부 비율
  bodyInset: 0.18,      // 위 몸통이 뒤로 물러나는 두께 차(양면 합)
  baseBatter: 0.014,    // 대석 기단은 거의 수직
  bodyBatter: 0.075,    // 몸통 배터(성벽·육축 공통 어휘)
  keys: Object.freeze(['wall-base', 'wall-body']),
});

// 여장(성가퀴) 톱니. 연속 프리즘이 아니라 타(merlon)·타구(gap) 반복이며, 타 전면에는 총안이
// 어두운 인셋 면으로 붙는다(실제 구멍은 삼각형 비용만 늘리고 원경에서 구분되지 않는다).
//   총안은 타마다 등간격으로 찍으면 아이콘 리듬이 되므로 시드 파생으로 띄어 뚫고 높이를 흔든다.
export const CITY_WALL_MERLON = Object.freeze({
  length: 3,            // 타 길이(목표) — run 길이에 맞춰 ±lengthBand 안에서 균등 분배
  lengthBand: 0.2,
  gap: 0.36,            // 타구
  loopholeWidth: 0.66,  // 총안 폭(가로 슬릿)
  loopholeHeight: 0.19,
  loopholeBottom: 0.32, // 여장 밑에서 총안 하단까지
  loopholeJitter: 0.07, // 시드 파생 높이 흔들림
  loopholeKeep: 0.58,   // 총안이 뚫린 타의 비율
  loopholeRelief: 0.03, // 면에서 살짝 띄운 인셋(구멍 아님)
});

// 석재 위계는 재질이 아니라 **하나의 화강암 값 테이블**로만 표현한다. 성벽과 육축이 같은 키를
// 쓰므로 두 자산의 톤이 구성상 갈릴 수 없다(비전 판정 #1: 육축이 다른 자산으로 보였던 원인은
// 색이 아니라 정점 공유 프리즘의 노멀 스무딩이었고, 그건 flat shading 으로 잡는다).
export const CITY_STONE_VALUES = Object.freeze({
  base: 0.95,        // 대석 기단 켜(성벽·육축 공통)
  body: 1,           // 몸통(성벽·육축 공통)
  parapet: 0.94,     // 여장
  cornice: 1.02,     // 코니스·마루 윗켜
  deck: 0.97,
  shadeDeep: 0.3,    // 홍예 안쪽 깊은 곳
  shadeMouth: 0.58,  // 홍예 입구 — 반대편 지면이 읽히게 밝힌다
  loophole: 0.32,
  stoneKeys: Object.freeze(['base', 'body', 'parapet', 'cornice', 'deck']),
});

// 대형 방형 화강암 줄눈. 텍스처 없이 블록 단위 정점색(값 변주 + 블록 밑변 그림자)으로만 표현하고,
// 켜마다 반 블록 어긋난 막힌줄눈을 쓴다(통줄눈 금지).
export const CITY_STONE_BOND = Object.freeze({
  block: 1.05,                  // 블록 한 변(목표)
  blockBand: Object.freeze([0.8, 1.4]),
  toneSpread: 0.055,            // 블록별 값 변주
  jointShade: 0.06,             // 블록 밑변 줄눈 그림자
  crownLift: 0.03,              // 블록 윗변 하이라이트
  bondOffset: 0.5,
  wallRows: 2,                  // 성벽 몸통 켜당 가로 줄눈 밴드(절제)
  maxCols: 48,
  maxRows: 24,
});

// 성문 육축(석축 대). 홍예 개구 폭 / 육축 총폭은 숭례문·흥인지문 실측 밴드(≈0.18~0.22)를 따르고,
// 육축은 위로 갈수록 좁아지는 배터와 상단 코니스 켜를 가진다. 배터는 **상단을 좁히는** 방향이라
// 하단 footprint 가 계획이 검증한 예약 범위를 절대 넘지 않는다.
export const CITY_GATE_MASONRY = Object.freeze({
  archRatio: 0.20,
  archRatioBand: 0.02,
  archSegments: 10,   // 짝수라 정점(이맛돌)에 정확히 vertex 가 놓인다
  batterSlope: 0.08,
  batterMinInset: 0.2,
  batterMaxInsetK: 0.14,   // 폭·깊이 대비 상단 인셋 상한
  corniceHeight: 0.42,
  jambMin: 0.6,
  pierWidth: GATE_PIER_WIDTH,   // 진실 소유는 GATE_PIER_WIDTH — gateExtraWidth 가 이 값의 2배다
});

// 중층 문루: 하층은 기둥열+벽체, 상층은 폭·깊이를 체감한 기둥열+난간, 지붕 2단.
//   widthRatio 는 숭례문 실측 비례(육축 폭보다 좁은 문루)를 따른다. 문루가 육축 상면을 다 덮으면
//   처마가 여장 링을 가려 성가퀴 연속이 사라지므로, 좌우에 여장이 보이는 날개를 남긴다.
//   lowerRoofPitch 는 하층 차양이 상층 벽을 삼키지 않는 완만한 값이다.
export const CITY_GATE_PAVILION = Object.freeze({
  walkway: 0.8,          // 여장 안쪽 통로
  deckHeight: 0.4,
  widthRatio: 0.6,
  bayWidth: 3.2,         // 기둥 사이 한 칸
  lowerHeight: 3.6,
  lowerEave: 1.9,
  upperRatio: 0.8,
  upperFloor: 0.4,
  upperHeight: 2.9,
  upperEave: 1.7,
  railHeight: 0.55,
  lowerRoofPitch: 0.2,
  upperRoofPitch: 0.42,
  minSpan: 2.2,
  maxColumns: 15,
  // ── 공포대(다포계 포열) — #23 R3-① ──────────────────────────────────────────
  //   성문 문루는 다포계다: 기둥 위 주포만이 아니라 **주칸에도 간포**가 놓이고, 출목마다 계단형으로
  //   내밀어 처마를 받는다. 부재 재현이 아니라 중경(문전 마당·드론 저공)에서 포열의 리듬과 출목
  //   층급이 실루엣·명암으로 읽히는 축약이다(docs/look-grammar.md 실루엣 우선).
  //
  //   **처마 내밀기는 이 라운드에서 바꾸지 않았다.** 실측 결과 lowerEave/upperEave 는 이미 2출목
  //   공포대가 받칠 수 있는 깊이였다 — 아래 bracketTipRatio 규칙(최외 출목 거리 ≈ 공포대 높이)으로
  //   하층 최외 출목이 0.94m 이므로 서까래가 그 두 배까지 내미는 처마는 1.87m 이고, 저작값은
  //   1.9m 다(상층은 0.75m → 1.51m 대 저작값 1.7m 로 이미 더 깊다). 실측 비도 주칸의 0.49~0.61,
  //   기둥 높이의 0.53~0.59 로 얕지 않았다. 얕게 **읽혔던** 원인은 깊이가 아니라 그 아래가 창방·평방
  //   두 켜뿐이어서 처마를 받는 것이 없었다는 것이다. 여기서 고치는 것은 그 받침이다.
  bracketBandRatio: 0.26,   // 공포대 높이 / 층 높이. 기둥이 그만큼 짧아지고 층 y밴드·지붕 y는 불변
  bracketTiers: 2,          // 외출목 단수(2출목). 궁 정전급(3출목 이상) 아래 위계를 지킨다
  bracketInterLower: 1,     // 하층 주칸당 간포 수
  bracketInterUpper: 2,     // 상층 주칸당 간포 수 — 포 밀도가 상층 위계를 올린다(단청 rank 는 불변)
  bracketTipRatio: 1.0,     // 최외 출목 거리 / 공포대 높이 (출목 한 단이 한 켜만큼 내민다)
  // 주두 폭은 포 간격의 1/3~1/2 이어야 포열이 리듬으로 읽힌다 — 더 좁으면 포벽만 보이고, 더 넓으면
  //   포가 붙어 한 덩이 띠가 된다. 실측 결과 이 값에서 주두폭/포간격 = 0.33~0.47 이 나온다.
  bracketPostRatio: 0.36,   // 주두·소로 폭 / 공포대 높이
  bracketArmRatio: 0.20,    // 첨차·살미 두께 / 공포대 높이
  // 하층 폐합(#23 R3-① 후속). 다포계 하층은 **포벽**(포 사이를 막는 얇은 회벽·판벽)이 있는 쪽이
  //   고증상 맞고, 상층은 개방 정자라 포 사이로 하늘이 보이는 것이 정당하다. 공포대가 층 y밴드의
  //   위를 쓰면서 기둥이 짧아졌으므로, 판벽이 예전 비율(기둥의 0.86)에 머물면 그 0.14 와 포열
  //   사이가 배경 하늘이 관통하는 가로 슬릿이 된다(비전 계측 2026-08-04: forecourt-day 1440×900
  //   에서 y=505–509 행의 19~27% 가 순수 하늘색, y=488–493 은 행당 26~56px). 그래서 하층 판벽은
  //   창방 밑면까지 올라가고 포열 구간은 포벽이 막는다 — 하층 파사드는 데크에서 처마선까지 폐합이다.
  bracketInfillArmK: 1,     // 포벽 두께 / 첨차 두께(얇은 벽면 — 포는 그 앞으로 읽힌다)
  columnRadiusK: 0.075,     // 기둥 반지름 / 층 높이
  columnRadiusMax: 0.3,
});

// 수문(水門) — 개천이 성벽을 지나는 통과부. 고증: 오간수문은 처음 홍예 3개였고 1421년 범람 뒤
//   1422년 2개를 더해 **홍예 5개**가 되었다(docs/joseon-city.md §개천). 사대문과는 별개 시설이며
//   흥인지문·광희문 사이에 있었으므로, 이 계약은 수문 개구부가 사대문 개구부와 겹치는 것을 금지한다.
//   치수는 새로 저작하지 않고 성벽·성문 어휘를 그대로 재사용한다: 통과부 두께는 성벽 두께,
//   상면 높이는 인접 성벽 상면(지반+bodyHeight-foundationSink), 켜·줄눈·여장은 성벽과 같은 값.
//   홍예 폭은 실측이 아니라 **수로 폭 파생**이다 — 개천 저수로(streamWaterHalf)가 성벽 중심선을
//   지나는 실제 사교(斜交) 현(弦)을 덮어야 물이 벽 아래로 잠기지 않는다. 개수 5는 고증 고정값이라
//   폭이 넓어지면 홍예가 굵어지고, 좁아지면 얇아진다(개수를 늘려 고증값을 흩지 않는다).
export const CITY_WATER_GATE = Object.freeze({
  arches: 5,             // 1422년 이후 오간수문 홍예 수(고증 고정)
  abutment: 2.4,         // 홍예 열 양 끝 벽체(수문 어깨) — 성벽 두께와 같은 급의 석축
  pierWidth: 1.1,        // 홍예 사이 돌기둥
  minSpan: 22,           // 홍예 5개 × 최소폭 + 돌기둥 4 + 어깨 2 의 하한
  maxSpan: 36,           // 하도 전폭 추종 상한 — 이 이상 넓히면 홍예가 아니라 교량 아치가 된다
  hardMaxSpan: 80,       // 저수로 보장(아래)조차 넘길 수 없는 절대 상한(퇴화 접선 방어)
  archSegments: 8,       // 짝수라 정점(이맛돌)에 vertex 가 놓인다
  sillDrop: 0.3,         // 하상보다 낮은 석축 문턱(물은 문턱 위를 흐른다)
  springLift: 0.55,      // 문턱 위 기석(springing) 켜 — 홍예는 저수위보다 살짝 높은 데서 시작한다.
                         //   기석을 하상에 붙이면 반원의 아래 절반이 흙·물에 잠겨 홍예가 얕은
                         //   스캘럽으로 읽힌다(비전 판정 2026-08-01). 그 아래는 수직 문협(jamb)이다.
  crownHeadroom: 0.9,    // 이맛돌 위 최소 스팬드럴(여장 발치까지)
  minArchWidth: 2.2,
  apertureOverlap: 0.8,  // 성벽 리본 끝을 수문 석축 안으로 물려 곡선-현 오차 틈을 없앤다
  // 홍예 열 양 끝 지반은 **기석선(springLift) 아래**여야 한다. 그 아래는 수직 문협이므로 둑이
  //   기석보다 높으면 바깥 홍예의 발이 흙에 묻힌다 — 그때 열을 좁힌다. 구 고정값 0.35m 는 넓은
  //   골짜기(어깨 60m)의 거의 평평한 둑에서 맞춘 수였고, 개착 하도(어깨 10m)에서는 둑이 더 빨리
  //   올라와 물리적 기준(기석선)과 어긋났다(2026-08-01).
  archBankMargin: 0.1,   // 격자 표본 사이 보간 여유
  spanShrinkStep: 1,
  minCosNormal: 0.12,    // 성벽에 거의 접선인 통과부의 폭 폭주 방지
  gateClearance: 3,      // 사대문 개구부와 수문 개구부 사이 최소 여유(별개 시설)
  mergeDistance: 24,     // 이 거리 안의 두 교차는 한 통과부(짧은 접선 출입)
  // 통과부는 성벽 둘레의 이 몫을 넘을 수 없다. 넘으면 수문을 **세우지 않는다** — 최소 성곽
  //   (R=74, 성벽 반경 46m)에서 개울이 성벽에 거의 접선(cosN 0.13)으로 만나면 필요 폭이 36m,
  //   즉 둘레의 1/4 이 되어 성곽이 아니라 교량이 된다(2026-08-01 실측). 그 규모의 개울은 성벽
  //   아래를 지나가는 것이 이 라운드 이전과 같은 거동이고, 도성(반경 282~293m)에서는 상한이
  //   85m 라 실제 폭 22~40m 에 전혀 걸리지 않는다.
  spanPerimeterK: 0.30,
});

const wrapAngle = (angle) => {
  const a = angle % TAU;
  return a < 0 ? a + TAU : a;
};

const angularDistance = (a, b) => {
  let d = Math.abs(wrapAngle(a) - wrapAngle(b));
  if (d > Math.PI) d = TAU - d;
  return d;
};

const directionAt = (angle) => ({ x: Math.sin(angle), z: Math.cos(angle) });

export function worldEdgeClearance(edge, point) {
  if (!edge?.edgeRadiusAt) return Infinity;
  const dx = point.x - edge.cx, dz = point.z - edge.cz;
  return edge.edgeRadiusAt(Math.atan2(dz, dx)) - Math.hypot(dx, dz);
}

export function worldEdgeContainsPolygon(edge, poly, inset = 0) {
  return poly.every((point) => worldEdgeClearance(edge, point) >= inset);
}

function rayEdgeLimit(site, angle) {
  const { edge, center: C } = site;
  if (!edge?.edgeRadiusAt) return site.terrainR || site.R;
  const dir = directionAt(angle);
  const centerOffset = Math.hypot(C.x - edge.cx, C.z - edge.cz);
  const far = edge.radius * (1 + Math.abs(edge.amp || 0)) + centerOffset + 32;
  const step = Math.max(2, site.R / 128);
  let inside = 0;
  for (let r = step; r <= far + step; r += step) {
    const p = { x: C.x + dir.x * r, z: C.z + dir.z * r };
    if (worldEdgeClearance(edge, p) >= 0) { inside = r; continue; }
    let lo = inside, hi = r;
    for (let i = 0; i < 28; i++) {
      const mid = (lo + hi) * 0.5;
      const q = { x: C.x + dir.x * mid, z: C.z + dir.z * mid };
      if (worldEdgeClearance(edge, q) >= 0) lo = mid;
      else hi = mid;
    }
    return lo;
  }
  return far;
}

function rayCircleLimit(center, direction, radius) {
  const projection = center.x * direction.x + center.z * direction.z;
  const discriminant = projection * projection
    - (center.x * center.x + center.z * center.z - radius * radius);
  if (discriminant < 0) return -Infinity;
  return -projection + Math.sqrt(discriminant);
}

// terrain 외곽의 유기적 warp는 정규 grid 좌표를 움직인다. 성벽·가장 넓은 성문의 전체 footprint가
// 그 밴드에 닿지 않게 중심선을 제한하면 renderer의 해석 높이와 실제 terrain 삼각형이 일치한다.
function rayTerrainGridLimit(site, angle) {
  const scale = 1;
  const gateHalfWidth = (CITY_WALL_DIMENSIONS.maxGateOpening
    + CITY_WALL_DIMENSIONS.gateExtraWidth * scale) * 0.5;
  const gateHalfDepth = CITY_WALL_DIMENSIONS.gateDepth * scale * 0.5;
  const footprintReserve = Math.hypot(gateHalfWidth, gateHalfDepth) + 1;
  const terrainR = site.terrainR || site.R;
  const safeRadius = terrainR - TERRAIN_WARP_INSET - footprintReserve;
  return rayCircleLimit(site.center, directionAt(angle), safeRadius);
}

function coreRadius(center, corePolys) {
  let radius = 0;
  for (const poly of corePolys) for (const p of poly || []) radius = Math.max(radius, G.dist(center, p));
  return radius;
}

function sampleCountFor(site) {
  const estimate = TAU * site.bowlR * WALL_SCALE / TARGET_SEGMENT;
  return Math.min(256, Math.max(96, Math.round(estimate / 4) * 4));
}

export function cityWallRadiusAt(spec, angle) {
  const n = spec.radii.length;
  const u = wrapAngle(angle) / TAU * n;
  const i = Math.floor(u) % n, t = u - Math.floor(u);
  return spec.radii[i] * (1 - t) + spec.radii[(i + 1) % n] * t;
}

export function pointOnCityWall(spec, angle) {
  const a = wrapAngle(angle), r = cityWallRadiusAt(spec, a);
  const dir = directionAt(a);
  return { x: spec.cx + dir.x * r, z: spec.cz + dir.z * r };
}

export function normalOnCityWall(spec, angle) {
  const eps = TAU / spec.radii.length * 0.25;
  const before = pointOnCityWall(spec, angle - eps);
  const after = pointOnCityWall(spec, angle + eps);
  const tangent = G.norm(G.sub(after, before));
  let normal = G.perpR(tangent); // angle 증가는 남→동→북: 시계방향이므로 오른쪽이 바깥.
  const point = pointOnCityWall(spec, angle);
  const radial = G.sub(point, { x: spec.cx, z: spec.cz });
  if (G.dot(normal, radial) < 0) normal = G.mul(normal, -1);
  return normal;
}

// 양수=성 안쪽, 0=중심선, 음수=바깥. 극좌표 contour의 방사 여유이며 모든 배치 계약이 같은 값을 쓴다.
export function cityWallClearance(spec, point) {
  const dx = point.x - spec.cx, dz = point.z - spec.cz;
  const angle = Math.atan2(dx, dz); // +z=0, +x=π/2
  return cityWallRadiusAt(spec, angle) - Math.hypot(dx, dz);
}

export function cityWallContainsPolygon(spec, poly, inset = 0) {
  return poly.every((point) => cityWallClearance(spec, point) >= inset);
}

export function cityWallOutsidePolygon(spec, poly, gap = 0) {
  return poly.every((point) => cityWallClearance(spec, point) <= -gap);
}

// 점을 같은 방사선 위에서 성 안으로 당긴다. 도로의 유기 굽이가 오목한 성곽을 넘을 때 사용하며,
// 이미 안전한 점은 객체까지 그대로 반환해 불필요한 계획 데이터 변화를 피한다.
export function clampPointInsideCityWall(spec, point, inset = 0) {
  if (!spec || cityWallClearance(spec, point) >= inset) return point;
  const dx = point.x - spec.cx, dz = point.z - spec.cz;
  const angle = Math.atan2(dx, dz);
  const radius = Math.max(0, cityWallRadiusAt(spec, angle) - inset);
  const dir = directionAt(angle);
  return { x: spec.cx + dir.x * radius, z: spec.cz + dir.z * radius };
}

export function clampPointOutsideCityWall(spec, point, gap = 0) {
  if (!spec || cityWallClearance(spec, point) <= -gap) return point;
  const dx = point.x - spec.cx, dz = point.z - spec.cz;
  const angle = Math.atan2(dx, dz);
  const radius = cityWallRadiusAt(spec, angle) + gap;
  return {
    x: spec.cx + Math.sin(angle) * radius,
    z: spec.cz + Math.cos(angle) * radius,
  };
}

export function cityGateFootprint(gate, {
  depth,
  extraWidth,
} = {}) {
  const scale = gate.scale || 1;
  depth ??= CITY_WALL_DIMENSIONS.gateDepth * scale;
  extraWidth ??= CITY_WALL_DIMENSIONS.gateExtraWidth * scale;
  const halfW = (gate.width + extraWidth) * 0.5;
  const halfD = depth * 0.5;
  const localX = { x: gate.dirZ, z: -gate.dirX };
  return [
    [-halfW, -halfD], [halfW, -halfD], [halfW, halfD], [-halfW, halfD],
  ].map(([sx, sz]) => ({
    x: gate.x + localX.x * sx + gate.dirX * sz,
    z: gate.z + localX.z * sx + gate.dirZ * sz,
  }));
}

export function cityGateLocalPoint(gate, localX, localZ) {
  const tangent = { x: gate.dirZ, z: -gate.dirX };
  return {
    x: gate.x + tangent.x * localX + gate.dirX * localZ,
    z: gate.z + tangent.z * localX + gate.dirZ * localZ,
  };
}

// ── 문전 마당(성문 안쪽 빈 마당) ──
// 왜 여기가 비어 있는가: 홍예는 구조상 대로 폭이 될 수 없어(archRatio 0.20) 18~26m 대로가 5~7m
//   통로 하나로 수렴한다. 그 병목 앞은 인마가 고이는 공간이고, 문루 수비·통제 동선도 문 안쪽 마당을
//   요구한다. 이 마당의 치수는 새로 저작하지 않는다 — 계획이 이미 검증해 둔 성문 접근 예약
//   (gateApproachLength × gateApproachClearance)을 그대로 쓰고, 폭은 육축 블록 총폭
//   (gate.width + gateExtraWidth = 홍예+좌우 육축)에 도로 가장자리 여유를 더한 값이다. 즉 "석축에
//   필지가 붙지 않는다"는 물리 요구가 마당의 크기를 정한다.
// 고증 주의: 조선 도성 성문 안쪽에 **의례적 광장**이 있었다는 근거는 확인하지 못했다. 상업 집적은
//   문 **밖**이 실증된다(칠패: 숭례문~서소문 밖, 17세기 문외미전·문외상전·외어물전 — docs/joseon-city.md
//   §시전행랑 출처군). 그래서 이 마당은 "역사적 광장"이 아니라 **접근·통제 예약의 가시화**로만
//   정당화한다. 행랑은 별개로 docs/joseon-city.md §시전행랑("종루~남대문·종묘~동대문 구간 연속 행랑")
//   이 직접 뒷받침하는 선형 배치다.
export function cityGateForecourtPolygon(gate, {
  length = CITY_WALL_DIMENSIONS.gateApproachLength * Math.max(0.6, gate.scale || 1)
    + CITY_WALL_DIMENSIONS.gateApproachClearance,
  halfWidth = (gate.width + CITY_WALL_DIMENSIONS.gateExtraWidth * (gate.scale || 1)) * 0.5
    + CITY_WALL_DIMENSIONS.roadEdgeMargin,
} = {}) {
  // gate.dir 은 성 바깥을 향한다 → 안쪽은 -dir. 마당은 육축 안쪽 면에서 시작해 도성 안으로 뻗는다.
  const inner = -CITY_WALL_DIMENSIONS.gateDepth * (gate.scale || 1) * 0.5;
  return [
    cityGateLocalPoint(gate, -halfWidth, inner - length),
    cityGateLocalPoint(gate, halfWidth, inner - length),
    cityGateLocalPoint(gate, halfWidth, inner),
    cityGateLocalPoint(gate, -halfWidth, inner),
  ];
}

export function cityGateApproachFootprint(gate, {
  length = CITY_WALL_DIMENSIONS.gateApproachLength * Math.max(0.6, gate.scale || 1)
    + CITY_WALL_DIMENSIONS.gateApproachClearance,
  halfWidth = gate.width * 0.5 + CITY_WALL_DIMENSIONS.gateVegetationMargin,
} = {}) {
  return [
    cityGateLocalPoint(gate, -halfWidth, -length),
    cityGateLocalPoint(gate, halfWidth, -length),
    cityGateLocalPoint(gate, halfWidth, length),
    cityGateLocalPoint(gate, -halfWidth, length),
  ];
}

// 성문 전체(통로+육축)와 물가 사이의 최소 평면 여유. 하천 골은 낮고 평평해 높이 점수만 쓰면
// 오히려 최적 후보로 선택되므로, 물 메시와 겹치는 문을 계획 단계에서 명시적으로 제외한다.
export function cityGateStreamClearance(gate, site, {
  widthSamples = 17,
  depthSamples = 13,
} = {}) {
  if (!site.stream) return Infinity;
  const scale = gate.scale || 1;
  const halfW = (gate.width + CITY_WALL_DIMENSIONS.gateExtraWidth * scale) * 0.5;
  const halfD = CITY_WALL_DIMENSIONS.gateDepth * scale * 0.5;
  let clearance = Infinity;
  for (let ix = 0; ix < widthSamples; ix++) {
    const localX = -halfW + 2 * halfW * (widthSamples === 1 ? 0.5 : ix / (widthSamples - 1));
    for (let iz = 0; iz < depthSamples; iz++) {
      const localZ = -halfD + 2 * halfD * (depthSamples === 1 ? 0.5 : iz / (depthSamples - 1));
      const point = cityGateLocalPoint(gate, localX, localZ);
      clearance = Math.min(clearance,
        Math.abs(point.z - site.streamZat(point.x)) - site.streamHalf);
    }
  }
  return clearance;
}

// 문 육축은 평평하므로 모서리만이 아니라 내부 격자까지 훑어 최저/최고 지반을 계약으로 만든다.
export function cityGateTerrainProfile(gate, site, {
  depth,
  extraWidth,
  widthSamples = 9,
  depthSamples = 7,
} = {}) {
  const scale = gate.scale || 1;
  depth ??= CITY_WALL_DIMENSIONS.gateDepth * scale;
  extraWidth ??= CITY_WALL_DIMENSIONS.gateExtraWidth * scale;
  const halfW = (gate.width + extraWidth) * 0.5;
  const halfD = depth * 0.5;
  const localX = { x: gate.dirZ, z: -gate.dirX };
  let min = Infinity, max = -Infinity;
  const samples = [];
  for (let ix = 0; ix < widthSamples; ix++) {
    const sx = -halfW + (2 * halfW) * (widthSamples === 1 ? 0.5 : ix / (widthSamples - 1));
    for (let iz = 0; iz < depthSamples; iz++) {
      const sz = -halfD + (2 * halfD) * (depthSamples === 1 ? 0.5 : iz / (depthSamples - 1));
      const x = gate.x + localX.x * sx + gate.dirX * sz;
      const z = gate.z + localX.z * sx + gate.dirZ * sz;
      const y = terrainMeshHeightAt(site, x, z);
      min = Math.min(min, y); max = Math.max(max, y);
      samples.push({ x, z, y });
    }
  }
  return { min, max, drop: max - min, samples };
}

// 한쪽 육축 footprint의 내부 최저점을 촘촘히 찾는다. 모서리 4점만 보면 비선형 산세의 내부 골을 놓쳐
// 긴 pier가 공중에 뜰 수 있으므로 renderer가 이 순수 profile을 직접 소비한다.
export function cityGatePierTerrainProfile(gate, site, side, {
  pierWidth = CITY_GATE_MASONRY.pierWidth * (gate.scale || 1),
  depth = CITY_WALL_DIMENSIONS.gateDepth * (gate.scale || 1),
  widthSamples = 17,
  depthSamples = 13,
  centerX = side * (gate.width * 0.5 + pierWidth * 0.5),
} = {}) {
  let min = Infinity, max = -Infinity;
  const samples = [];
  for (let ix = 0; ix < widthSamples; ix++) {
    const localX = centerX - pierWidth * 0.5
      + pierWidth * (widthSamples === 1 ? 0.5 : ix / (widthSamples - 1));
    for (let iz = 0; iz < depthSamples; iz++) {
      const localZ = -depth * 0.5
        + depth * (depthSamples === 1 ? 0.5 : iz / (depthSamples - 1));
      const point = cityGateLocalPoint(gate, localX, localZ);
      const y = terrainMeshHeightAt(site, point.x, point.z);
      min = Math.min(min, y); max = Math.max(max, y);
      samples.push({ ...point, y });
    }
  }
  return { min, max, drop: max - min, centerX, pierWidth, depth, samples };
}

// 평탄화하지 않은 산문 계약: 기존 지형의 길은 그대로 통과시키고, 좌우 육축은 각자 지반까지 내린다.
// 문 높이는 통행면의 유효고로 정하고 높은 쪽 지반에는 최소 노출만 남긴다. 전체 footprint 최고점에
// 고정 성벽 높이를 더하면 경사 seed에서 20m가 넘는 절벽 탑이 되므로, 실제 도로와 지반이라는 두 제약만 쓴다.
export function cityGateStructureProfile(gate, site) {
  const scale = gate.scale || 1;
  const roadTerrain = cityGateTerrainProfile(gate, site, { extraWidth: 0 });
  const piers = [-1, 1].map((side) => cityGatePierTerrainProfile(gate, site, side));
  const terrainMin = Math.min(roadTerrain.min, ...piers.map((pier) => pier.min));
  const terrainMax = Math.max(roadTerrain.max, ...piers.map((pier) => pier.max));
  const terrain = {
    min: terrainMin,
    max: terrainMax,
    drop: terrainMax - terrainMin,
    samples: [...roadTerrain.samples, ...piers.flatMap((pier) => pier.samples)],
  };
  const lintelHeight = CITY_WALL_DIMENSIONS.gateLintelHeight * scale;
  const pierTerrainMax = Math.max(...piers.map((pier) => pier.max));
  const baseTopY = Math.max(
    roadTerrain.max + (CITY_WALL_DIMENSIONS.gateArchClearance
      + CITY_WALL_DIMENSIONS.gateTerrainSampleSafety) * scale + lintelHeight,
    pierTerrainMax + CITY_WALL_DIMENSIONS.gateTerrainReveal * scale,
  );
  const foundationSink = CITY_WALL_DIMENSIONS.gateFoundationSink * scale;
  const maxPierHeight = Math.max(...piers.map((pier) => baseTopY - (pier.min - foundationSink)));
  return {
    terrain,
    roadTerrain,
    piers,
    baseHeight: baseTopY - terrain.max,
    baseTopY,
    lintelHeight,
    maxPierHeight,
    archBottomY: roadTerrain.min - CITY_WALL_DIMENSIONS.gateTerrainSampleSafety * scale,
    // buildGate의 상인방 하단과 동일하며 통행면 최고점 위 유효고를 보장한다.
    archTopY: baseTopY - lintelHeight,
  };
}

// 성벽 몸체뿐 아니라 성문 지붕·진입 시야까지 나무와 바위에서 비운다. worker와 sync가 이 순수 판정을 공유한다.
export function cityWallVegetationBlocked(spec, point, {
  corridor = CITY_WALL_DIMENSIONS.vegetationClearance,
  gateMargin = CITY_WALL_DIMENSIONS.gateVegetationMargin,
  gateApproachMargin = 0,
} = {}) {
  if (!spec) return false;
  if (Math.abs(cityWallClearance(spec, point)) < corridor) return true;
  return spec.gates.some((gate) => {
    const radius = gate.width * 0.5 + gateMargin;
    if (G.dist2(gate, point) < radius ** 2) return true;
    const delta = G.sub(point, gate);
    const along = Math.abs(delta.x * gate.dirX + delta.z * gate.dirZ);
    const across = Math.abs(delta.x * gate.dirZ - delta.z * gate.dirX);
    const approach = CITY_WALL_DIMENSIONS.gateApproachLength * Math.max(0.6, gate.scale || 1)
      + CITY_WALL_DIMENSIONS.gateApproachClearance + gateApproachMargin;
    return along < approach && across < radius;
  });
}

function crossingAtZ(spec, z, lo, hi, preferred) {
  const roots = [];
  const steps = 160;
  let a = lo, fa = pointOnCityWall(spec, a).z - z;
  for (let i = 1; i <= steps; i++) {
    const b = lo + (hi - lo) * i / steps;
    const fb = pointOnCityWall(spec, b).z - z;
    if (Math.abs(fa) < 1e-9) roots.push(a);
    if (fa * fb < 0 || Math.abs(fb) < 1e-9) {
      let left = a, right = b, fLeft = fa;
      for (let k = 0; k < 42; k++) {
        const mid = (left + right) * 0.5;
        const fm = pointOnCityWall(spec, mid).z - z;
        if (fLeft * fm <= 0) right = mid;
        else { left = mid; fLeft = fm; }
      }
      roots.push((left + right) * 0.5);
    }
    a = b; fa = fb;
  }
  if (!roots.length) return null;
  roots.sort((a0, a1) => angularDistance(a0, preferred) - angularDistance(a1, preferred));
  return roots[0];
}

function makeGate(spec, name, angle, width, scaleMultiplier = 1, minWidth = 0) {
  const scale = (spec.gateScale || 1) * scaleMultiplier;
  width = Math.max(width * scale, minWidth);
  const point = pointOnCityWall(spec, angle);
  const normal = normalOnCityWall(spec, angle);
  const eps = TAU / spec.radii.length * 0.125;
  const speed = G.dist(pointOnCityWall(spec, angle - eps), pointOnCityWall(spec, angle + eps)) / (eps * 2);
  const openingHalf = width * 0.5 + 4 * scale;
  return {
    name, angle: wrapAngle(angle), width, scale, openingHalf,
    halfAngle: openingHalf / Math.max(1, speed),
    x: point.x, z: point.z, dirX: normal.x, dirZ: normal.z,
  };
}

function gateFitsWorld(gate, site) {
  return cityGateFootprint(gate).every((point) => worldEdgeClearance(site.edge, point) >= 0);
}

function minimumGateGapAngle(spec) {
  return Math.max(2, 3 * (spec.gateScale || 1)) / Math.max(1, spec.meanRadius);
}

function gatesHaveRoom(spec, a, b) {
  return angularDistance(a.angle, b.angle) - a.halfAngle - b.halfAngle >= minimumGateGapAngle(spec);
}

function bestGateNear(spec, site, name, center, span, width, anglePenalty, avoid = [], scaleMultipliers = [1]) {
  const steps = GATE_ANGLE_STEPS;
  const heightLimit = CITY_WALL_DIMENSIONS.gateMaxPierHeight;
  let fallback = null;
  for (const scaleMultiplier of scaleMultipliers) {
    let best = null;
    for (let i = 0; i <= steps; i++) {
      const angle = center - span + span * 2 * i / steps;
      const gate = makeGate(spec, name, angle, width, scaleMultiplier);
      if (!gateFitsWorld(gate, site)) continue;
      if (avoid.some((other) => !gatesHaveRoom(spec, gate, other))) continue;
      const streamDeficit = site.R >= 250
        ? Math.max(0, CITY_WALL_DIMENSIONS.gateStreamClearance - cityGateStreamClearance(gate, site))
        : 0;
      const structure = cityGateStructureProfile(gate, site);
      const excess = Math.max(0, structure.maxPierHeight - heightLimit);
      const score = structure.maxPierHeight + excess * 100
        + streamDeficit * 1000
        + angularDistance(angle, center) * anglePenalty;
      if (!best || score < best.score) best = {
        gate, score, maxHeight: structure.maxPierHeight, streamDeficit,
      };
    }
    if (!best) continue;
    if (!fallback || best.score < fallback.score) fallback = best;
    if (best.maxHeight <= heightLimit && best.streamDeficit <= 0) return best.gate;
  }
  if (!fallback) throw new Error(`city wall cannot place ${name} gate`);
  return fallback.gate;
}

function bestJongnoGates(spec, site, southGate) {
  const southExtent = pointOnCityWall(spec, 0).z - spec.cz;
  const desiredDelta = Math.min(site.R * 0.42, southExtent * 0.68);
  const desiredZ = spec.cz + Math.max(0, desiredDelta);
  // 종로 T는 궁 정문(C.z+0.11R)보다 남쪽이어야 주작대로의 북→남 위계가 뒤집히지 않는다.
  // 완만한 후보를 찾더라도 이 도시 문법 하한은 넘지 않고, 남는 경사는 문 크기 적응으로 흡수한다.
  const minZ = spec.cz + site.R * 0.13;
  const heightLimit = CITY_WALL_DIMENSIONS.gateMaxPierHeight;
  const minOpening = site.R >= 250 ? CITY_WALL_DIMENSIONS.majorGateMinOpening : 0;
  let fallback = null;
  // 평탄한 축이 있으면 사대문의 원래 위계를 지킨다. 전 크기 후보가 모두 한계를 넘는 seed에서만
  // 동·서문을 함께 한 단계씩 줄여 비대칭이나 우연한 절벽 구조를 만들지 않는다.
  for (const scaleMultiplier of [1, 0.9, 0.8, 0.72, 0.64, 0.56]) {
    let best = null;
    for (let i = 0; i <= JONGNO_STEPS; i++) {
      const z = minZ + (desiredZ - minZ) * i / JONGNO_STEPS;
      // 대로 폭과 양측 보행 여유가 T 지점에 들어가는 축만 후보로 삼는다.
      if (cityWallClearance(spec, { x: spec.cx, z }) < Math.min(18, spec.meanRadius * 0.22)) continue;
      const eastAngle = crossingAtZ(spec, z, 0, Math.PI, Math.PI / 2);
      const westAngle = crossingAtZ(spec, z, Math.PI, TAU, Math.PI * 1.5);
      if (eastAngle == null || westAngle == null) continue;
      const east = makeGate(spec, 'east', eastAngle, 18, scaleMultiplier, minOpening);
      const west = makeGate(spec, 'west', westAngle, 18, scaleMultiplier, minOpening);
      if (!gateFitsWorld(east, site) || !gateFitsWorld(west, site)) continue;
      if (!gatesHaveRoom(spec, east, west)
        || !gatesHaveRoom(spec, east, southGate)
        || !gatesHaveRoom(spec, west, southGate)) continue;
      const eastStructure = cityGateStructureProfile(east, site);
      const westStructure = cityGateStructureProfile(west, site);
      const streamDeficit = site.R >= 250 ? Math.max(
        0,
        CITY_WALL_DIMENSIONS.gateStreamClearance - cityGateStreamClearance(east, site),
        CITY_WALL_DIMENSIONS.gateStreamClearance - cityGateStreamClearance(west, site),
      ) : 0;
      const maxHeight = Math.max(eastStructure.maxPierHeight, westStructure.maxPierHeight);
      const excess = Math.max(0, maxHeight - heightLimit);
      const score = maxHeight + excess * 100
        + streamDeficit * 1000
        + (eastStructure.maxPierHeight + westStructure.maxPierHeight) * 0.12
        + Math.abs(z - desiredZ) * 0.01;
      if (!best || score < best.score) best = { east, west, z, score, maxHeight, streamDeficit };
    }
    if (!best) continue;
    if (!fallback || best.score < fallback.score) fallback = best;
    if (best.maxHeight <= heightLimit && best.streamDeficit <= 0) return best;
  }
  if (!fallback) throw new Error('city wall cannot place Jongno gates');
  return fallback;
}

function validateGateSpacing(spec) {
  const gates = [...spec.gates].sort((a, b) => a.angle - b.angle);
  for (let i = 0; i < gates.length; i++) {
    const a = gates[i], b = gates[(i + 1) % gates.length];
    if (!gatesHaveRoom(spec, a, b)) throw new Error(`city wall gates overlap: ${a.name}/${b.name}`);
  }
}

// ── 수문 배치(개천의 성벽 통과부) ─────────────────────────────────────────────
// 개천 중심선이 성벽 contour 안↔밖을 바꾸는 지점을 실제로 찾아(해석 근사 아님) 통과부를 만든다.
// 렌더러는 이 절대 좌표만 소비하고 스스로 교차를 다시 풀지 않는다(계획-렌더 이중 진실 금지).
function creekWallCrossings(spec, site) {
  const pts = site.stream?.pts;
  if (!pts?.length) return [];
  const x0 = pts[0].x, x1 = pts[pts.length - 1].x;
  const insideAt = (x) => cityWallClearance(spec, { x, z: site.streamZat(x) }) > 0;
  const steps = 720;
  const crossings = [];
  let prevX = x0, prevIn = insideAt(x0);
  for (let i = 1; i <= steps; i++) {
    const x = x0 + (x1 - x0) * i / steps;
    const inside = insideAt(x);
    if (inside !== prevIn) {
      let lo = prevX, hi = x;
      for (let k = 0; k < 42; k++) {
        const mid = (lo + hi) * 0.5;
        if (insideAt(mid) === prevIn) lo = mid; else hi = mid;
      }
      crossings.push({ x: (lo + hi) * 0.5, entering: inside });
    }
    prevIn = inside; prevX = x;
  }
  return crossings;
}

// 통과부 하나의 사교(斜交) 계수. 1 = 성벽에 직교, 0 = 접선. 저수로가 성벽 중심선을 지나는
// 실제 현(弦) 길이가 2·waterHalf/cos 이므로 이 값이 수문 폭을 정한다.
function creekCrossingCosNormal(site, x, normal) {
  const d = Math.max(0.25, site.R * 0.001);
  const dz = (site.streamZat(x + d) - site.streamZat(x - d)) / (2 * d);
  const len = Math.hypot(1, dz);
  return Math.abs((normal.x + normal.z * dz) / len);
}

export function planCityWaterGates(spec, site, {
  widthSamples = 13,
  depthSamples = 5,
} = {}) {
  if (!spec || !site.stream) return [];
  const W = CITY_WATER_GATE;
  const thickness = CITY_WALL_DIMENSIONS.thickness;
  // 수문도 사대문과 같은 규모 계수를 쓴다. 최소 성곽(R=74, 성벽 반경 ≈46m)에서 22m 짜리 통과부는
  //   성벽 둘레의 큰 몫을 먹어 사대문 사이에 0.6m 자투리 리본을 남겼다(check:citywall wall-only
  //   sweep seed=14/R=74, 2026-08-01). 폭 치수만 계수를 태우고 높이(문턱·기석·스팬드럴)는 물 깊이
  //   기준이라 절대값으로 둔다.
  const gs = Math.min(1, Math.max(0.4, spec.gateScale || 1));
  const minSpan = W.minSpan * gs;
  const abutment = W.abutment * gs;
  const pierWidth = W.pierWidth * gs;
  // 통과부 폭은 저수로(streamWaterHalf)가 아니라 **하도 전폭**(streamHalf, 홍수 단면)에서 나온다.
  //   고증 근거: 1421년 범람 뒤 1422년에 홍예를 2개 **증설**했다 — 즉 수문은 평시 물줄기가 아니라
  //   출수 단면에 맞춰 커졌다. 건천의 마른 자갈 하상까지가 개천의 실제 폭이다.
  const floodHalf = Math.max(1, site.streamHalf || site.streamWaterHalf || 1);
  const waterHalf = Math.max(0.5, site.streamWaterHalf || floodHalf);
  const out = [];
  for (const crossing of creekWallCrossings(spec, site)) {
    const creek = { x: crossing.x, z: site.streamZat(crossing.x) };
    let angle = wrapAngle(Math.atan2(creek.x - spec.cx, creek.z - spec.cz));
    const eps = TAU / spec.radii.length * 0.125;
    const speed = G.dist(pointOnCityWall(spec, angle - eps), pointOnCityWall(spec, angle + eps))
      / (eps * 2);
    const normal0 = normalOnCityWall(spec, angle);
    const cosNormal = Math.max(W.minCosNormal, creekCrossingCosNormal(site, creek.x, normal0));
    const floodChord = 2 * floodHalf / cosNormal;
    const waterChord = 2 * waterHalf / cosNormal;
    // 폭 결정 순서: (1) 하도 전폭을 덮으려 하되 교량 규모(maxSpan)에서 멈춘다. (2) 그래도
    //   **저수로 현은 반드시 홍예 열 안에 든다** — 물이 석축 밑으로 사라지는 것은 허용하지 않는다.
    //   마른 자갈 하상 일부가 석축 아래로 물리는 것은 허용(그림에 물이 끊기지 않는다).
    const waterFloor = waterChord + pierWidth * (W.arches - 1) + abutment * 2;
    let span = Math.min(W.hardMaxSpan, Math.max(
      Math.min(W.maxSpan, Math.max(minSpan, floodChord + abutment * 2)),
      waterFloor,
    ));
    // 성벽에 비해 과대한 통과부는 세우지 않는다(위 spanPerimeterK 주석).
    if (span > Math.max(minSpan, spec.meanRadius * W.spanPerimeterK)) continue;
    // 사대문과 별개 시설: 수문 개구부가 성문 개구부에 닿으면 성벽을 따라 밀어낸다(고증 — 오간수문은
    //   흥인지문·광희문 **사이**의 독립 시설). 실측 시드에서는 발동하지 않으며(중심 간 55~102m),
    //   발동해도 drift 로 기록되어 계약이 그 크기를 검사한다.
    let drift = 0;
    for (let pass = 0; pass < 4; pass++) {
      let moved = false;
      for (const gate of spec.gates) {
        const need = gate.halfAngle + span * 0.5 / Math.max(1, speed)
          + W.gateClearance / Math.max(1, speed);
        if (angularDistance(angle, gate.angle) >= need) continue;
        const before = wrapAngle(gate.angle - need), after = wrapAngle(gate.angle + need);
        angle = angularDistance(angle, before) <= angularDistance(angle, after) ? before : after;
        moved = true;
      }
      if (!moved) break;
    }
    // 석축은 성벽의 **현(弦)** 위에 앉는다 — 접선 위에 앉히면 양 끝이 성벽 바깥으로 0.5m 남짓
    //   튀어나와 "벽면에 덧댄 별개 판"으로 읽힌다(비전 판정 2026-08-01). 현으로 놓으면 양 끝이
    //   성벽 선에 정확히 물리고 가운데만 새그만큼 안으로 물러난다(실제 수문 석축도 성벽면보다
    //   살짝 물러나 있다). 덕분에 두께를 키워 호(弧)를 삼킬 필요도 없어진다.
    //   폭이 확정된 **뒤** 다시 앉혀야 양 끝이 성벽 선에 정확히 물린다(아래 하상 축소 루프가 폭을
    //   줄이므로, 앉히기를 한 번만 하면 줄어든 폭의 양 끝이 성벽에서 새그만큼 어긋난다).
    const seatOnChord = (width) => {
      const half = width * 0.5 / Math.max(1, speed);
      const endA = pointOnCityWall(spec, angle - half);
      const endB = pointOnCityWall(spec, angle + half);
      const chord = Math.max(1e-6, G.dist(endA, endB));
      const center = { x: (endA.x + endB.x) * 0.5, z: (endA.z + endB.z) * 0.5 };
      const tan = { x: (endB.x - endA.x) / chord, z: (endB.z - endA.z) / chord };
      let nrm = { x: -tan.z, z: tan.x };
      if (nrm.x * (center.x - spec.cx) + nrm.z * (center.z - spec.cz) < 0) {
        nrm = { x: -nrm.x, z: -nrm.z };
      }
      return { chord, center, tan, nrm };
    };
    let seat = seatOnChord(span);
    span = seat.chord;
    let point = seat.center;
    let tangent = seat.tan;
    let normal = seat.nrm;
    const at = (localX, localZ) => terrainMeshHeightAt(site,
      point.x + tangent.x * localX + normal.x * localZ,
      point.z + tangent.z * localX + normal.z * localZ);
    const reseat = () => {
      seat = seatOnChord(span);
      span = seat.chord; point = seat.center; tangent = seat.tan; normal = seat.nrm;
    };
    // 홍예 열은 **하상 평탄면 안**에 든다. 하도 전폭을 그대로 쓰면 사교 통과부에서 열의 양 끝이
    //   둑을 파고들어 바깥 홍예가 흙에 박힌다(비전 판정 2026-07-31). 문턱 기준으로 양 끝 지반이
    //   기석선(springLift)보다 높으면 폭을 줄인다 — 다만 저수로 현 보장(waterFloor)은 침해하지 않는다.
    const bedY = at(0, 0) - W.sillDrop;
    for (let step = 0; step < 40; step++) {
      const edge = span * 0.5 - abutment;
      if (Math.max(at(-edge, 0), at(edge, 0)) - bedY <= W.springLift) break;
      const next = span - W.spanShrinkStep;
      if (next < Math.max(minSpan, waterFloor)) break;
      span = next;
      reseat();
    }
    // drift = 통과점에서 **성벽을 따라** 밀려난 거리(사대문 회피가 만드는 유일한 이동). 현 중심이
    //   호보다 새그만큼 안으로 물러난 반경 성분은 inset 으로 따로 기록한다 — 두 값을 합쳐 재면
    //   정상적인 현 배치가 "밀려남"으로 오판된다.
    const toCreek = { x: point.x - creek.x, z: point.z - creek.z };
    drift = Math.abs(toCreek.x * tangent.x + toCreek.z * tangent.z);
    const inset = Math.abs(toCreek.x * normal.x + toCreek.z * normal.z);
    // 현 배치 덕분에 두께는 성벽과 같다(새그는 기록만 하고 두께를 늘리지 않는다 — 늘리면 다시
    //   벽면 앞으로 튀어나온 판이 된다). 개구부는 석축보다 조금 좁아 리본 끝이 석축 안으로 물린다.
    const radiusHere = cityWallRadiusAt(spec, angle);
    const sagitta = span * span / (8 * Math.max(1, radiusHere));
    const depth = thickness;
    // 개구부는 석축보다 조금 좁다 — 리본 끝을 석축 안으로 물려 양 끝 이음에 틈이 생기지 않게 한다
    //   (겹침은 돌 속이라 보이지 않는다).
    const halfAngle = Math.max(0, span * 0.5 - W.apertureOverlap) / Math.max(1, speed);
    let min = Infinity, max = -Infinity;
    for (let ix = 0; ix < widthSamples; ix++) {
      const localX = -span * 0.5 + span * (widthSamples === 1 ? 0.5 : ix / (widthSamples - 1));
      for (let iz = 0; iz < depthSamples; iz++) {
        const localZ = -depth * 0.5
          + depth * (depthSamples === 1 ? 0.5 : iz / (depthSamples - 1));
        const y = at(localX, localZ);
        min = Math.min(min, y); max = Math.max(max, y);
      }
    }
    out.push({
      index: out.length,
      name: `water-${out.length}`,
      angle, halfAngle, span, depth, sagitta, scale: gs,
      x: point.x, z: point.z, dirX: normal.x, dirZ: normal.z,
      cosNormal, drift, inset, entering: crossing.entering,
      floodChord, waterChord,
      creek: { x: creek.x, z: creek.z },
      terrain: { min, max, drop: max - min },
      waterY: streamSurfaceHeightAt(site, creek.x, creek.z),
      arches: W.arches,
    });
  }
  // 짧은 접선 출입(들어왔다 곧 나가는 굽이)은 하나의 통과부로 합친다 — 두 수문이 겹쳐 서지 않게.
  const merged = [];
  for (const record of out) {
    const near = merged.find((kept) => G.dist(kept, record) < W.mergeDistance);
    if (near) { near.mergedCount = (near.mergedCount || 1) + 1; continue; }
    merged.push(record);
  }
  return merged.map((record, index) => ({ ...record, index, name: `water-${index}` }));
}

// 수문 석축의 완전한 물리 spec. 로컬 x = 성벽 접선, 로컬 z = 성 바깥 법선(성문과 같은 규약),
// y 는 절대 표고. 순수 함수라 렌더러·검증이 같은 값을 본다.
export function cityWaterGateProfile(waterGate) {
  const W = CITY_WATER_GATE;
  const { span, terrain } = waterGate;
  const gs = Math.min(1, Math.max(0.4, waterGate.scale || 1));
  const pierWidth = W.pierWidth * gs;
  const minAbutment = W.abutment * gs;
  const bottomY = terrain.min - CITY_WALL_DIMENSIONS.foundationSink;
  const sillY = terrain.min - W.sillDrop;
  // 상면은 인접 성벽 상면과 같은 규칙(지반 + 지상 노출 높이)이되, 통과부 안에서는 수평이다.
  // 실제 수문은 물 위를 수평으로 건너므로 지형을 따라 내려가는 리본과 달리 한 높이를 갖는다.
  const topY = terrain.max + (CITY_WALL_DIMENSIONS.bodyHeight - CITY_WALL_DIMENSIONS.foundationSink);
  const usable = span - minAbutment * 2 - pierWidth * (W.arches - 1);
  // 반원 홍예이므로 반지름 = 폭/2. 이맛돌 위 스팬드럴이 모자라면 홍예를 좁혀 반원을 유지한다
  // (납작한 타원 홍예로 바꾸지 않는다 — 홍예는 반원이 어휘다).
  const springY = sillY + W.springLift;
  const archWidth = Math.max(W.minArchWidth * gs, Math.min(
    usable / W.arches,
    2 * (topY - springY - W.crownHeadroom),
  ));
  const radius = archWidth * 0.5;
  const openingTotal = archWidth * W.arches + pierWidth * (W.arches - 1);
  const abutment = Math.max(minAbutment, (span - openingTotal) * 0.5);
  const crownY = springY + radius;
  const openings = [], piers = [];
  let cursor = -span * 0.5 + abutment;
  for (let i = 0; i < W.arches; i++) {
    const centerX = cursor + radius;
    const intrados = [];
    for (let s = 0; s <= W.archSegments; s++) {
      const a = Math.PI * (1 - s / W.archSegments);
      intrados.push({ x: centerX + Math.cos(a) * radius, y: springY + Math.sin(a) * radius });
    }
    openings.push({ index: i, x0: cursor, x1: cursor + archWidth, centerX, intrados });
    cursor += archWidth;
    if (i < W.arches - 1) {
      piers.push({ index: i, x0: cursor, x1: cursor + pierWidth });
      cursor += pierWidth;
    }
  }
  const shoulders = [
    { index: 0, x0: -span * 0.5, x1: -span * 0.5 + abutment },
    { index: 1, x0: span * 0.5 - abutment, x1: span * 0.5 },
  ];
  return {
    span, depth: waterGate.depth, halfDepth: waterGate.depth * 0.5,
    bottomY, sillY, springY, crownY, topY,
    // 문협: 문턱과 기석 사이 수직 벽면(홍예 아래 통로 몸통).
    jamb: { y0: sillY, y1: springY, height: springY - sillY },
    courseSplitY: sillY + (topY - sillY) * CITY_WALL_COURSES.baseFraction,
    archWidth, radius, pierWidth, abutment, scale: gs,
    openings, piers, shoulders,
    // 홍예 열이 실제로 덮는 폭. 저수로 현(waterChord)보다 넓어야 물이 석축 밑으로 잠기지 않는다.
    openingTotal,
    // 여장은 성벽·육축과 같은 두께·높이·톱니 규칙을 쓴다(성가퀴가 수문 위로 이어진다).
    parapet: {
      y: topY, height: CITY_WALL_DIMENSIONS.capHeight,
      thickness: CITY_WALL_DIMENSIONS.thickness * 0.7, length: span,
    },
    // 물이 문턱 위를 흐르고 이맛돌 아래로 지나가는지(계약이 검사하는 두 여유).
    submergence: waterGate.waterY - sillY,
    waterClearance: crownY - waterGate.waterY,
  };
}

export function planCityWall(site, seed, corePolys = []) {
  const n = sampleCountFor(site);
  const C = site.center;
  const minRadius = coreRadius(C, corePolys) + CORE_MARGIN;
  const radii = new Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const angle = i / n * TAU;
    const dir = directionAt(angle);
    const standardTheta = Math.atan2(dir.z, dir.x);
    const bowlRadius = site.bowlRadiusAt ? site.bowlRadiusAt(standardTheta) : site.bowlR;
    const desired = Math.max(minRadius, bowlRadius * WALL_SCALE);
    const radius = Math.min(
      desired,
      rayEdgeLimit(site, angle) - EDGE_INSET,
      rayTerrainGridLimit(site, angle),
    );
    if (!Number.isFinite(radius) || radius < minRadius - 1e-7) {
      throw new Error(`city wall cannot fit at angle ${angle.toFixed(3)}`);
    }
    radii[i] = radius;
    sum += radius;
  }

  const spec = {
    version: 3,
    seed: seed >>> 0,
    cx: C.x,
    cz: C.z,
    radii,
    meanRadius: sum / n,
    gateScale: Math.min(1, Math.max(0.52, (sum / n) / 120)),
    edgeInset: EDGE_INSET,
    axes: {},
    gates: [],
  };
  // 물길과 급사면을 피해 남쪽 산록의 실제 마른 통과점을 찾는다. ±40°는 여전히 남쪽 반구이면서
  // 특정 seed의 개울이 정남 전 구간을 따라갈 때 물 위 문을 강제하지 않는 최소 탐색 폭이다.
  // 남문은 도시의 주축이므로 마른 후보들 사이에서는 몇 m 낮은 육축보다 정남 접근성을 우선한다.
  const south = bestGateNear(spec, site, 'south', 0, 0.7, 26, 18);
  const jongno = bestJongnoGates(spec, site, south);
  // 북악 정면 급사면을 억지로 관통하지 않고 좌·우 어깨의 고른 안부까지 탐색한다. 실제 숙정문도
  // 정북 축선보다 산세를 따른 위치가 중요하므로 북쪽 반구 안에서 ±69°를 허용한다.
  // 산문은 평지의 대문보다 작아도 자연스럽다. 먼저 온전한 크기를 찾고, 완만한 자리가 전혀 없는
  // seed에서만 단계적으로 작은 postern을 허용해 지형을 20m 석탑으로 덮는 것보다 산세를 따른다.
  const north = bestGateNear(spec, site, 'north', Math.PI, 1.2, 15, 2,
    [south, jongno.east, jongno.west], [1, 0.88, 0.76, 0.64, 0.56]);
  spec.axes.jongnoZ = jongno.z;
  spec.gates = [south, jongno.east, north, jongno.west];
  validateGateSpacing(spec);
  // 수문은 사대문이 확정된 뒤에 놓인다 — 사대문 배치는 개천 여유(gateStreamClearance)만 보고,
  //   수문은 그 결과 성벽 위에 남은 실제 통과부를 채운다. 순서를 뒤집으면 두 시설이 서로를 밀어낸다.
  spec.waterGates = planCityWaterGates(spec, site);

  for (const poly of corePolys) {
    if (!cityWallContainsPolygon(spec, poly, CORE_MARGIN * 0.5)) {
      throw new Error('city wall does not contain its reserved core');
    }
  }
  return spec;
}

export function cityWallAngleInGate(spec, angle) {
  const a = wrapAngle(angle);
  return spec.gates.some((gate) => angularDistance(a, gate.angle) < gate.halfAngle - 1e-10);
}

export function cityWallAngleInWaterGate(spec, angle) {
  const a = wrapAngle(angle);
  return (spec.waterGates || []).some((wg) => angularDistance(a, wg.angle) < wg.halfAngle - 1e-10);
}

// 성벽 리본이 비는 개구부 = 사대문 + 수문. 두 시설 모두 자기 석축이 그 구멍을 채우므로
// 리본은 여기서 끊긴다. 사대문 전용 계약(간격·접근·식생)은 cityWallAngleInGate 를 계속 쓴다.
export function cityWallAngleInAperture(spec, angle) {
  return cityWallAngleInGate(spec, angle) || cityWallAngleInWaterGate(spec, angle);
}

function wallBreakAngles(spec) {
  const n = spec.radii.length;
  const angles = Array.from({ length: n }, (_, i) => i / n * TAU);
  for (const aperture of [...spec.gates, ...(spec.waterGates || [])]) {
    angles.push(wrapAngle(aperture.angle - aperture.halfAngle));
    angles.push(wrapAngle(aperture.angle + aperture.halfAngle));
  }
  angles.sort((a, b) => a - b);
  const unique = angles.filter((a, i) => i === 0 || Math.abs(a - angles[i - 1]) > 1e-9);
  unique.push(TAU);
  return unique;
}

function sharedMiter(a, b) {
  const sum = G.add(a, b);
  if (G.len(sum) < 1e-5) return b;
  const bisector = G.norm(sum);
  const denom = Math.max(1 / MITER_LIMIT, Math.abs(G.dot(bisector, a)));
  return G.mul(bisector, Math.min(MITER_LIMIT, 1 / denom));
}

function footprint(segment, half) {
  return [
    G.add(segment.p0, G.mul(segment.startOffset, -half)),
    G.add(segment.p0, G.mul(segment.startOffset, half)),
    G.add(segment.p1, G.mul(segment.endOffset, half)),
    G.add(segment.p1, G.mul(segment.endOffset, -half)),
  ];
}

// 렌더러와 회귀 게이트가 함께 쓰는 지형 밀착 세그먼트. 인접 chord는 shared miter를 사용해 양쪽
// footprint 정점을 정확히 공유한다. 문 개구부 경계만 end-cap을 남기고 내부 수직 이음판은 렌더에서 생략한다.
export function sampleCityWallSegments(spec, site, {
  thickness = CITY_WALL_DIMENSIONS.thickness,
  maxLength = CITY_WALL_DIMENSIONS.maxSegmentLength,
  maxTerrainError = CITY_WALL_DIMENSIONS.maxTerrainError,
  maxDepth = CITY_WALL_DIMENSIONS.maxSubdivisionDepth,
} = {}) {
  const segments = [];

  const append = (a0, a1, depth) => {
    const midAngle = (a0 + a1) * 0.5;
    if (cityWallAngleInAperture(spec, midAngle)) return;
    const p0 = pointOnCityWall(spec, a0), p1 = pointOnCityWall(spec, a1);
    const pm = pointOnCityWall(spec, midAngle);
    const length = G.dist(p0, p1);
    const h0 = terrainMeshHeightAt(site, p0.x, p0.z);
    const h1 = terrainMeshHeightAt(site, p1.x, p1.z);
    const hm = terrainMeshHeightAt(site, pm.x, pm.z);
    const terrainError = Math.abs(hm - (h0 + h1) * 0.5);
    if (depth < maxDepth && (length > maxLength || terrainError > maxTerrainError)) {
      append(a0, midAngle, depth + 1);
      append(midAngle, a1, depth + 1);
      return;
    }

    const tangent = G.norm(G.sub(p1, p0));
    let normal = G.perpR(tangent);
    const radial = G.sub(G.lerp(p0, p1, 0.5), { x: spec.cx, z: spec.cz });
    if (G.dot(normal, radial) < 0) normal = G.mul(normal, -1);
    segments.push({
      angle0: a0, angle1: a1, p0, p1, length, normal,
      thickness,
      startOffset: normal, endOffset: normal,
      joinedStart: false, joinedEnd: false,
      terrainError,
    });
  };

  const angles = wallBreakAngles(spec);
  for (let i = 0; i < angles.length - 1; i++) append(angles[i], angles[i + 1], 0);

  // 결과 배열의 이웃이 같은 angle을 공유할 때만 실제 연속 run이다. 문 구멍을 건너뛴 이웃은 각도가 다르다.
  for (let i = 0; i < segments.length - 1; i++) {
    const a = segments[i], b = segments[i + 1];
    if (Math.abs(a.angle1 - b.angle0) > 1e-9) continue;
    const miter = sharedMiter(a.normal, b.normal);
    a.endOffset = miter; b.startOffset = miter;
    a.joinedEnd = true; b.joinedStart = true;
  }
  // angle 0이 성문 구멍이 아니면 TAU→0도 같은 폐곡선 run이다. 선형 배열 끝이라고 end-cap을 두면
  // 남문이 정남에서 비켜난 씨앗에만 미세한 V 틈이 생긴다.
  if (segments.length > 1 && !cityWallAngleInAperture(spec, 0)) {
    const last = segments[segments.length - 1], first = segments[0];
    if (Math.abs(last.angle1 - TAU) <= 1e-9 && Math.abs(first.angle0) <= 1e-9) {
      const miter = sharedMiter(last.normal, first.normal);
      last.endOffset = miter; first.startOffset = miter;
      last.joinedEnd = true; first.joinedStart = true;
    }
  }

  const half = thickness * 0.5;
  for (const segment of segments) {
    segment.corners = footprint(segment, half);
    segment.ground = segment.corners.map((p) => terrainMeshHeightAt(site, p.x, p.z));
  }
  return segments;
}

// renderer의 좁은 여장 footprint도 몸체와 동일한 miter를 재사용한다.
export function cityWallSegmentFootprint(segment, thickness) {
  const corners = footprint(segment, thickness * 0.5);
  return { corners };
}

// 좁은 리본(여장·위 켜)의 지반을 넓은 몸체 footprint 양쪽 edge에서 선형보간한다. 좁은
// footprint에서 지형을 다시 샘플하면 폭 차이만큼 높이가 달라져 켜 사이에 수평 틈이 생긴다.
export function cityWallSegmentGroundProfile(
  segment,
  thickness = (segment.thickness || CITY_WALL_DIMENSIONS.thickness) * 0.7,
) {
  const bodyThickness = segment.thickness || CITY_WALL_DIMENSIONS.thickness;
  const ratio = Math.max(0, Math.min(1, thickness / bodyThickness));
  const innerMix = (1 - ratio) * 0.5;
  const startY = (t) => segment.ground[0] + (segment.ground[1] - segment.ground[0]) * t;
  const endY = (t) => segment.ground[3] + (segment.ground[2] - segment.ground[3]) * t;
  return {
    corners: footprint(segment, thickness * 0.5),
    groundY: [
      startY(innerMix),
      startY(1 - innerMix),
      endY(1 - innerMix),
      endY(innerMix),
    ],
  };
}

export function cityWallSegmentCapProfile(
  segment,
  thickness = (segment.thickness || CITY_WALL_DIMENSIONS.thickness) * 0.7,
) {
  const profile = cityWallSegmentGroundProfile(segment, thickness);
  const topOffset = CITY_WALL_DIMENSIONS.bodyHeight - CITY_WALL_DIMENSIONS.foundationSink;
  return {
    corners: profile.corners,
    baseY: profile.groundY.map((ground) => ground + topOffset),
  };
}

// 몸통 석재 2켜. 아래 대석 켜는 세그먼트 footprint 그대로(=계획이 검증한 두께)이고 위 몸통만
// bodyInset 만큼 물러나 얕은 수평 단차를 만든다. 위 켜 지반은 같은 보간을 써서 켜 사이 틈이 없다.
export function cityWallCourseProfile(segment, {
  thickness = segment.thickness || CITY_WALL_DIMENSIONS.thickness,
  baseFraction = CITY_WALL_COURSES.baseFraction,
  bodyInset = CITY_WALL_COURSES.bodyInset,
  baseBatter = CITY_WALL_COURSES.baseBatter,
  bodyBatter = CITY_WALL_COURSES.bodyBatter,
} = {}) {
  const exposed = CITY_WALL_DIMENSIONS.bodyHeight - CITY_WALL_DIMENSIONS.foundationSink;
  const splitOffset = exposed * baseFraction;
  const capThickness = CITY_WALL_DIMENSIONS.thickness * 0.7;
  const baseHeight = splitOffset + CITY_WALL_DIMENSIONS.foundationSink;
  const bodyHeight = exposed - splitOffset;
  // 배터는 상단만 좁힌다 — 하단 footprint 는 계획이 검증한 두께 그대로라 지형 밀착·world edge
  // 계약이 유지되고, 어느 켜도 여장 두께(thickness*0.7)보다 얇아지지 않는다.
  const baseTopThickness = Math.max(capThickness, thickness - baseBatter * 2 * baseHeight);
  const bodyThickness = Math.max(capThickness, baseTopThickness - bodyInset);
  const bodyTopThickness = Math.max(capThickness, bodyThickness - bodyBatter * 2 * bodyHeight);
  const course = (key, bottomThickness, topThickness, bottomOffset, topOffset) => {
    const bottom = cityWallSegmentGroundProfile(segment, bottomThickness);
    const top = cityWallSegmentGroundProfile(segment, topThickness);
    return {
      key,
      thickness: bottomThickness,
      topThickness,
      corners: bottom.corners,
      groundY: bottom.groundY,
      topCorners: top.corners,
      topGroundY: top.groundY,
      bottomOffset,
      topOffset,
    };
  };
  return {
    splitOffset,
    courses: [
      course(CITY_WALL_COURSES.keys[0], thickness, baseTopThickness,
        -CITY_WALL_DIMENSIONS.foundationSink, splitOffset),
      course(CITY_WALL_COURSES.keys[1], bodyThickness, bodyTopThickness,
        splitOffset, exposed),
    ],
  };
}

// 블록별 값 변주(줄눈 읽힘). 정수 해시라 시드만 같으면 어디서든 같은 값이 나온다(Math.random 금지).
export function cityStoneTone(seed, i, j, { spread = CITY_STONE_BOND.toneSpread } = {}) {
  let h = Math.imul(((seed | 0) ^ 0x9e3779b9) >>> 0, 0x85ebca6b);
  h = Math.imul((h ^ ((i | 0) + 0x165667b1)) >>> 0, 0xc2b2ae35);
  h = Math.imul((h ^ ((j | 0) + 0x27d4eb2f)) >>> 0, 0x9e3779b1);
  h = (h ^ (h >>> 15)) >>> 0;
  const u = (h % 2048) / 2047;
  return 1 + (u * 2 - 1) * spread;
}

// 한 석면(사변형)의 방형 블록 배치. u·v 는 면 로컬 0~1 이라 렌더러가 어떤 사변형에도 매핑한다.
// 켜마다 반 블록 어긋나 통줄눈이 생기지 않는다.
export function cityStoneBondPlan(width, height, {
  block = CITY_STONE_BOND.block,
  band = CITY_STONE_BOND.blockBand,
  rows: forcedRows = 0,
  bondOffset = CITY_STONE_BOND.bondOffset,
  maxCols = CITY_STONE_BOND.maxCols,
  maxRows = CITY_STONE_BOND.maxRows,
} = {}) {
  const w = Math.max(1e-6, width), h = Math.max(1e-6, height);
  let cols = Math.max(1, Math.min(maxCols, Math.round(w / block)));
  while (cols > 1 && w / cols < band[0]) cols--;
  while (cols < maxCols && w / cols > band[1]) cols++;
  let rows = forcedRows > 0 ? Math.max(1, Math.min(maxRows, Math.round(forcedRows)))
    : Math.max(1, Math.min(maxRows, Math.round(h / block)));
  if (!(forcedRows > 0)) {
    while (rows > 1 && h / rows < band[0] * 0.55) rows--;
    while (rows < maxRows && h / rows > band[1]) rows++;
  }
  const courses = [];
  for (let r = 0; r < rows; r++) {
    const offset = (r % 2 === 1 && cols > 1) ? bondOffset / cols : 0;
    const spans = [];
    if (offset > 0) spans.push({ u0: 0, u1: offset });
    for (let c = 0; c < cols; c++) {
      const u0 = offset + c / cols;
      if (u0 >= 1 - 1e-12) break;
      spans.push({ u0, u1: Math.min(1, u0 + 1 / cols) });
    }
    const last = spans[spans.length - 1];
    if (last.u1 < 1 - 1e-12) spans.push({ u0: last.u1, u1: 1 });
    courses.push({ index: r, v0: r / rows, v1: (r + 1) / rows, offset: offset > 0, spans });
  }
  return { width: w, height: h, cols, rows, blockWidth: w / cols, blockHeight: h / rows, courses };
}

// 이 타에 총안이 뚫리는가(그리고 그 슬릿 치수). 등간격 아이콘 리듬을 피해 시드 파생으로 띄어 뚫고
// 높이를 흔든다. null = 이 타는 민무늬.
export function cityWallMerlonLoophole(seed, runIndex, merlonIndex) {
  const M = CITY_WALL_MERLON;
  let h = Math.imul((((seed | 0) ^ 0x7f4a7c15) + Math.imul(runIndex | 0, 0x9e3779b1)) >>> 0, 0x85ebca6b);
  h = Math.imul((h ^ (Math.imul(merlonIndex | 0, 0xc2b2ae35) >>> 0)) >>> 0, 0x27d4eb2f);
  h = (h ^ (h >>> 16)) >>> 0;
  if ((h % 4096) / 4095 > M.loopholeKeep) return null;
  let g = Math.imul((h ^ 0x165667b1) >>> 0, 0x9e3779b1);
  g = (g ^ (g >>> 13)) >>> 0;
  return {
    width: M.loopholeWidth,
    height: M.loopholeHeight,
    bottom: M.loopholeBottom + ((g % 1024) / 1023 * 2 - 1) * M.loopholeJitter,
    relief: M.loopholeRelief,
  };
}

// 한 연속 run(성문 사이 성벽 한 줄)의 여장 톱니 분배. 타 길이는 밴드 안에서 run 길이에 맞춰
// 균등 분배되므로 마지막 타가 잘리지 않고, run 끝은 타구로 끝나 성문 육축과 만난다.
export function cityWallMerlonSpans(runLength, {
  length = CITY_WALL_MERLON.length,
  lengthBand = CITY_WALL_MERLON.lengthBand,
  gap = CITY_WALL_MERLON.gap,
  loopholeWidth = CITY_WALL_MERLON.loopholeWidth,
} = {}) {
  const build = (count, merlonLength, cellGap, degenerate) => {
    const period = merlonLength + cellGap;
    const spans = [];
    const half = Math.min(loopholeWidth, merlonLength * 0.4) * 0.5;
    for (let i = 0; i < count; i++) {
      const start = i * period;
      const end = start + merlonLength;
      const mid = (start + end) * 0.5;
      spans.push({ start, end, loophole: { start: mid - half, end: mid + half } });
    }
    return { runLength, count, merlonLength, gap: cellGap, period, degenerate, spans };
  };
  if (!(runLength > 0)) return build(0, 0, gap, true);
  const minLength = length - lengthBand, maxLength = length + lengthBand;
  // 성문·수문에 붙은 아주 짧은 자투리 run 은 타 하나로 덮는다(톱니 한 칸도 못 넣는 길이).
  //   타 하나 + 타구 0 은 길이가 얼마든 **톱니 리듬이 없는 자투리**다. 구 코드는 길이가 우연히
  //   타 밴드(2.8~3.2m)에 들면 degenerate=false 로 보고해, 회귀 계약의 "긴 run 타구 0.3~0.4m"
  //   밴드에 걸렸다(#20 R4 에서 수문 개구부가 성문 개구부 옆에 3.06m 자투리를 남기며 표면화).
  //   렌더 형상은 그대로이고 라벨만 바로잡는다(degenerate 는 계약 라벨 전용).
  if (runLength <= maxLength) return build(1, runLength, 0, true);
  // 타 길이는 밴드 안에 두고 run 에 정확히 맞춘다. 한 타의 정수배가 밴드로 떨어지지 않는 짧은
  // 자투리에서만 타구가 밴드를 벗어나며(긴 run 은 항상 두 밴드를 함께 만족한다), 어느 쪽 이탈이
  // 작은지 후보를 훑어 고른다. 마지막 타를 잘라 남기는 방식은 톱니 리듬을 깨서 쓰지 않는다.
  const miss = (value, low, high) => Math.max(0, low - value) + Math.max(0, value - high);
  const maxCount = Math.max(1, Math.ceil(runLength / 2) + 1);
  let best = null;
  for (let count = 1; count <= maxCount; count++) {
    const cell = runLength / count;
    if (cell <= 0.5) break;
    const floor = Math.min(minLength, cell * 0.75);
    const merlonLength = Math.min(maxLength, Math.max(floor, cell - gap));
    const cellGap = cell - merlonLength;
    if (cellGap <= 0) continue;
    const penalty = miss(merlonLength, minLength, maxLength) + miss(cellGap, 0.3, 0.4);
    if (!best || penalty < best.penalty - 1e-12) best = { count, merlonLength, cellGap, penalty };
  }
  if (!best) return build(1, runLength, 0, true);
  return build(best.count, best.merlonLength, best.cellGap, best.penalty > 1e-9);
}

function lerpXZ(a, b, t) {
  return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
}

// 지형 추종 세그먼트를 arc-length 로 이어붙여 타를 자른다. 타가 세그먼트 경계를 넘으면 조각으로
// 쪼개되 실제 타 끝에서만 end-cap 을 남겨, 몸체 miter 를 그대로 물려받은 채 틈이 생기지 않는다.
export function cityWallMerlonPlan(segments, {
  thickness = CITY_WALL_DIMENSIONS.thickness * 0.7,
  merlon = undefined,
  seed = 0,
} = {}) {
  const runs = [], blocks = [];
  if (!segments || !segments.length) return { runs, blocks, triangles: 0 };
  const groups = [];
  let current = [0];
  for (let i = 0; i < segments.length - 1; i++) {
    if (segments[i].joinedEnd && segments[i + 1].joinedStart) current.push(i + 1);
    else { groups.push(current); current = [i + 1]; }
  }
  groups.push(current);
  // 배열 끝↔처음이 같은 폐곡선 run 이면 하나로 합친다(선형 배열 끝은 성문 구멍이 아니다).
  if (groups.length > 1 && segments[segments.length - 1].joinedEnd && segments[0].joinedStart) {
    const tail = groups.pop();
    groups[0] = tail.concat(groups[0]);
  }

  for (const [runIndex, indices] of groups.entries()) {
    const caps = indices.map((i) => cityWallSegmentCapProfile(segments[i], thickness));
    const lengths = indices.map((i) => segments[i].length);
    const starts = [];
    let runLength = 0;
    for (const length of lengths) { starts.push(runLength); runLength += length; }
    const plan = cityWallMerlonSpans(runLength, merlon);
    runs.push({
      index: runIndex,
      segmentIndices: indices,
      runLength,
      count: plan.count,
      merlonLength: plan.merlonLength,
      gap: plan.gap,
      period: plan.period,
      degenerate: plan.degenerate,
      spans: plan.spans,
    });
    for (const [merlonIndex, span] of plan.spans.entries()) {
      // 이 타가 총안을 갖는지는 시드 파생 — 등간격으로 전부 뚫으면 아이콘 리듬이 된다.
      const slit = cityWallMerlonLoophole(seed, runIndex, merlonIndex);
      for (let k = 0; k < indices.length; k++) {
        if (lengths[k] <= 1e-9) continue;
        const s0 = starts[k], s1 = s0 + lengths[k];
        const from = Math.max(span.start, s0), to = Math.min(span.end, s1);
        if (to - from <= 1e-6) continue;
        const cap = caps[k];
        const t0 = (from - s0) / lengths[k], t1 = (to - s0) / lengths[k];
        const inner = (t) => lerpXZ(cap.corners[0], cap.corners[3], t);
        const outer = (t) => lerpXZ(cap.corners[1], cap.corners[2], t);
        const innerY = (t) => cap.baseY[0] + (cap.baseY[3] - cap.baseY[0]) * t;
        const outerY = (t) => cap.baseY[1] + (cap.baseY[2] - cap.baseY[1]) * t;
        const hole = slit ? {
          from: Math.max(span.loophole.start, from),
          to: Math.min(span.loophole.end, to),
        } : null;
        let loophole = null;
        if (hole && hole.to - hole.from > 1e-6) {
          const h0 = (hole.from - s0) / lengths[k], h1 = (hole.to - s0) / lengths[k];
          loophole = {
            a: outer(h0), b: outer(h1),
            baseA: outerY(h0), baseB: outerY(h1),
            bottom: slit.bottom,
            height: slit.height,
            relief: slit.relief,
          };
        }
        blocks.push({
          runIndex,
          merlonIndex,
          segmentIndex: indices[k],
          // pushTerrainPrism 규약과 같은 코너 순서: 내부-시작, 외부-시작, 외부-끝, 내부-끝.
          corners: [inner(t0), outer(t0), outer(t1), inner(t1)],
          baseY: [innerY(t0), outerY(t0), outerY(t1), innerY(t1)],
          normal: segments[indices[k]].normal,
          height: CITY_WALL_DIMENSIONS.capHeight,
          startCap: Math.abs(from - span.start) <= 1e-6,
          endCap: Math.abs(to - span.end) <= 1e-6,
          loophole,
        });
      }
    }
  }
  // 렌더러가 실제로 내보내는 삼각형 수(옆면 2 + 윗면 1 + 실제 타 끝 캡) — 예산 게이트가 이 값을 본다.
  const triangles = blocks.reduce((sum, block) => sum
    + 2 * (3 + (block.startCap ? 1 : 0) + (block.endCap ? 1 : 0))
    + (block.loophole ? 2 : 0), 0);
  return { runs, blocks, triangles };
}

// 성문 육축(홍예 + 배터 + 2켜 + 코니스)의 완전한 물리 spec. 렌더러는 여기서 나온 절대 좌표만
// 소비하고 스스로 위치를 다시 만들지 않는다(계획-렌더 이중 진실 금지).
export function cityGateMasonryProfile(gate, site, structure = cityGateStructureProfile(gate, site)) {
  const scale = gate.scale || 1;
  const pierWidth = CITY_GATE_MASONRY.pierWidth * scale;
  const depth = CITY_WALL_DIMENSIONS.gateDepth * scale;
  const totalWidth = gate.width + pierWidth * 2;
  const openingWidth = totalWidth * CITY_GATE_MASONRY.archRatio;
  const radius = openingWidth * 0.5;
  const crownY = structure.archTopY;
  const springY = crownY - radius;
  const sillY = structure.archBottomY;
  const sink = CITY_WALL_DIMENSIONS.gateFoundationSink * scale;
  const zoneWidth = (totalWidth - openingWidth) * 0.5;
  const innerX = openingWidth * 0.5;
  const outerX = totalWidth * 0.5;

  // 홍예가 옛 통행 폭보다 좁으므로 그 차이만큼 도로 위도 석면이 된다. 새 footprint 의 최저 지반을
  // 직접 훑고, 겹치는 도로·옛 육축 표본까지 함께 낮은 쪽으로 물려 어떤 표본 격자에서도 뜨지 않게 한다.
  const zones = [-1, 1].map((side, index) => {
    const centerX = side * (innerX + zoneWidth * 0.5);
    const terrain = cityGatePierTerrainProfile(gate, site, side, {
      pierWidth: zoneWidth, depth, centerX,
    });
    const ground = Math.min(terrain.min, structure.roadTerrain.min, structure.piers[index].min);
    return { side, index, centerX, width: zoneWidth, ground, bottomY: ground - sink, terrain };
  });
  const groundY = Math.min(...zones.map((zone) => zone.ground));
  const masonryBottomY = Math.min(...zones.map((zone) => zone.bottomY));
  const corniceHeight = CITY_GATE_MASONRY.corniceHeight * scale;
  const corniceBottomY = structure.baseTopY - corniceHeight;
  const batterHeight = corniceBottomY - masonryBottomY;
  const inset = Math.min(
    Math.max(CITY_GATE_MASONRY.batterSlope * batterHeight, CITY_GATE_MASONRY.batterMinInset * scale),
    CITY_GATE_MASONRY.batterMaxInsetK * Math.min(zoneWidth, depth),
  );
  // 배터 램프는 육축 전체가 공유한다(zone 마다 지반이 달라도 상단 폭이 어긋나지 않는다).
  const insetAt = (y) => inset * Math.max(0, Math.min(1, (y - masonryBottomY) / Math.max(1e-6, batterHeight)));
  const courseSplitY = groundY + (structure.baseTopY - groundY) * CITY_WALL_COURSES.baseFraction;

  const rectAt = (zone, y) => {
    const back = insetAt(y);
    return zone.side > 0
      ? { x0: innerX, x1: outerX - back, z0: -depth * 0.5 + back, z1: depth * 0.5 - back }
      : { x0: -outerX + back, x1: -innerX, z0: -depth * 0.5 + back, z1: depth * 0.5 - back };
  };
  for (const zone of zones) {
    const split = Math.max(zone.bottomY, Math.min(courseSplitY, corniceBottomY));
    zone.courses = [
      {
        key: CITY_WALL_COURSES.keys[0],
        y0: zone.bottomY, y1: split,
        bottom: rectAt(zone, zone.bottomY), top: rectAt(zone, split),
      },
      {
        key: CITY_WALL_COURSES.keys[1],
        y0: split, y1: corniceBottomY,
        bottom: rectAt(zone, split), top: rectAt(zone, corniceBottomY),
      },
    ];
  }

  const segments = CITY_GATE_MASONRY.archSegments;
  const intrados = [];
  for (let i = 0; i <= segments; i++) {
    const angle = Math.PI * (1 - i / segments);   // π→0: 좌 spring → 정점 → 우 spring
    intrados.push({ x: Math.cos(angle) * radius, y: springY + Math.sin(angle) * radius });
  }
  return {
    scale, pierWidth, depth, totalWidth,
    topWidth: totalWidth - inset * 2,
    topDepth: depth - inset * 2,
    groundY, masonryBottomY, courseSplitY, zones,
    batter: { slope: CITY_GATE_MASONRY.batterSlope, inset, bottomY: masonryBottomY, topY: corniceBottomY },
    // 코니스는 배터로 좁아진 면에서 예약 폭까지 되내밀므로 내민 길이가 정확히 배터 인셋이다.
    cornice: {
      y0: corniceBottomY, y1: structure.baseTopY,
      overhang: inset,
      halfWidth: outerX, halfDepth: depth * 0.5,
    },
    arch: {
      openingWidth, radius, ratio: openingWidth / totalWidth,
      crownY, springY, sillY,
      spandrelTopY: corniceBottomY,
      halfDepth: depth * 0.5,
      segments, intrados,
    },
  };
}

// 문루 한 층의 공포대(다포계 포열) 스펙 — Three 없는 순수 수치. 층 y밴드 안의 **상단**을 공포대가
//   쓰고 기둥이 그만큼 짧아지므로, 층 높이·지붕 y·상층 바닥은 이 값에 영향받지 않는다.
//   좌표계: `out` 은 기둥 중심선 밖 수평 거리(양수 = 바깥), y 는 절대 높이.
//   포 배치: 앞·뒤 면은 기둥 격자(주포) + 주칸 등분(간포), 좌·우 면은 코너를 뺀 등분점만 — 코너는
//   앞·뒤 면 포가 이미 차지하므로 두 번 놓으면 부재가 겹친다.
//   `closed`(하층)면 포열 구간을 포벽이 막는다 — 그 층 파사드는 어느 높이에서도 배경이 보이지 않는다.
function gateBracketBand(storey, inter, closed) {
  const P = CITY_GATE_PAVILION;
  const height = storey.height * P.bracketBandRatio;
  const tiers = P.bracketTiers;
  const y0 = storey.y1 - height;
  const changHeight = height * 0.26;              // 창방(기둥머리 인방)
  const pyeongHeight = height * 0.14;             // 평방(창방 위 한 켜 — 다포계는 여기서 포가 뜬다)
  const arm = height * P.bracketArmRatio;         // 첨차·살미 부재 두께
  const postWidth = height * P.bracketPostRatio;  // 주두·소로 폭
  const stackY0 = y0 + changHeight + pyeongHeight;
  const stackHeight = height - changHeight - pyeongHeight;
  const juduHeight = stackHeight * 0.24;
  const tierHeight = (stackHeight - juduHeight) / tiers;
  const tipOut = height * P.bracketTipRatio;
  // 수평 런의 면 방향 길이 여장. 코너 기둥은 반지름만큼 기둥 중심선 밖으로 나와 있으므로, 런은
  //   최소 그만큼 길어야 기둥 머리를 덮는다 — 짧으면 코너에 슬리버가 열려 배경이 보인다.
  const grow = (out) => Math.max(out, storey.columnRadius);
  const steps = [];
  for (let i = 0; i < tiers; i++) {
    const out = tipOut * (i + 1) / tiers;         // 이 단 살미 끝(기둥 중심선 밖)
    steps.push({
      index: i,
      y: stackY0 + juduHeight + tierHeight * i,   // 이 단 부재의 밑면
      height: tierHeight,
      out,
      grow: grow(out),                            // 이 단 행공 런의 면 방향 길이 여장
    });
  }
  const spread = (positions) => {
    const out = [];
    for (let i = 0; i < positions.length; i++) {
      out.push({ at: positions[i], main: true });
      if (i === positions.length - 1) continue;
      const span = positions[i + 1] - positions[i];
      for (let k = 1; k <= inter; k++) {
        out.push({ at: positions[i] + span * k / (inter + 1), main: false });
      }
    }
    return out;
  };
  const halfDepth = storey.depth * 0.5;
  return {
    // y1 은 층 상단(=처마선)을 **그대로** 물려받는다. y0 는 거기서 밴드 높이를 뺀 값이라 y0+height 는
    //   부동소수 반올림으로 y1 과 마지막 자리가 어긋날 수 있다 — 지붕 y 불변은 y1 로 단언한다.
    tiers, inter, y0, y1: storey.y1, height,
    changbang: {
      y: y0, height: changHeight, thickness: arm * 1.5,
      overhang: postWidth * 0.5, grow: grow(postWidth * 0.5),
    },
    pyeongbang: {
      y: y0 + changHeight, height: pyeongHeight, thickness: arm * 1.9,
      overhang: postWidth, grow: grow(postWidth),
    },
    judu: { y: stackY0, height: juduHeight, width: postWidth * 1.7 },
    // 한 출목 단의 수직 적층은 살미 → 소로 → 행공 순이다(아래 값은 tierHeight 분율 = 부재가 서로를
    //   받치는 순서를 그대로 만든다). 살미 위에 소로가 앉고 그 위를 행공이 지난다.
    salmi: { base: 0.07, height: 0.46 },
    soro: { width: postWidth, base: 0.53, height: 0.30 },
    haenggong: { base: 0.74, height: 0.32 },
    arm, tipOut, steps,
    // 포벽: 평방 위 포열 구간(stackY0~층 상단)을 막는 얇은 벽면. 기둥 중심선에 서므로 주두·살미·소로가
    //   모두 그 앞으로 나오고, 포 사이로 하늘이 보이지 않는다. 상층(개방 정자)은 null 이다.
    infill: closed
      ? {
        y: stackY0, height: stackHeight, thickness: arm * P.bracketInfillArmK,
        overhang: 0, grow: grow(0),
      }
      : null,
    // 외목도리: 최외 출목 위를 잇는 수평 부재. 처마가 여기서부터 캔틸레버로 더 나간다.
    purlin: {
      out: tipOut, y: stackY0 + juduHeight + tierHeight * tiers,
      height: arm * 1.4, thickness: arm * 1.4, grow: grow(tipOut),
    },
    posts: {
      x: spread(storey.columnX),
      z: spread([-halfDepth, halfDepth]).filter((post) => !post.main),
    },
  };
}

// 중층 문루 + 육축 상면 여장 링. 문루는 링 안쪽에 앉고, 상층은 하층을 upperRatio 로 체감한다.
export function cityGatePavilionProfile(gate, structure, masonry) {
  const scale = gate.scale || 1;
  const P = CITY_GATE_PAVILION;
  const halfWidth = masonry.cornice.halfWidth;
  const halfDepth = masonry.cornice.halfDepth;
  const deckY0 = masonry.cornice.y1;
  const deckY1 = deckY0 + P.deckHeight * scale;
  // 성벽 여장과 같은 두께·높이를 써서 성벽 톱니가 육축 둘레로 이어지는 것처럼 읽히게 한다.
  const parapetThickness = CITY_WALL_DIMENSIONS.thickness * 0.7 * scale;
  const parapetHeight = CITY_WALL_DIMENSIONS.capHeight;
  const walkway = P.walkway * scale;
  const insideWidth = halfWidth * 2 - (parapetThickness + walkway) * 2;
  const insideDepth = halfDepth * 2 - (parapetThickness + walkway) * 2;
  // 좌우 날개에 여장이 드러나도록 문루는 육축보다 좁다. 깊이는 예약 footprint 가 얕아 링 안쪽을 다 쓴다.
  const lowerWidth = Math.max(P.minSpan * scale, Math.min(insideWidth, halfWidth * 2 * P.widthRatio));
  const lowerDepth = Math.max(P.minSpan * scale, insideDepth);
  const lowerHeight = P.lowerHeight * scale;
  const bays = (span) => Math.max(3, Math.min(P.maxColumns, Math.round(span / (P.bayWidth * scale)) + 1));
  const lower = {
    tier: 'lower',
    y0: deckY1, y1: deckY1 + lowerHeight, height: lowerHeight,
    width: lowerWidth, depth: lowerDepth,
    columns: bays(lowerWidth),
    panels: 0, rail: 0,
  };
  lower.panels = lower.columns - 1;
  const upperY0 = lower.y1 + P.upperFloor * scale;
  const upperHeight = P.upperHeight * scale;
  const upper = {
    tier: 'upper',
    y0: upperY0, y1: upperY0 + upperHeight, height: upperHeight,
    width: lowerWidth * P.upperRatio, depth: lowerDepth * P.upperRatio,
    columns: bays(lowerWidth * P.upperRatio),
    panels: 0, rail: P.railHeight * scale,
  };
  // 기둥 중심선(주칸 격자). 렌더러와 공포 배치가 같은 배열을 쓰므로 주포가 기둥에서 어긋날 수 없다.
  //   기둥 반지름도 여기서 정한다 — 판벽 폭이 그 값에서 나오고(기둥 사이를 정확히 채운다), 파사드
  //   폐합 검사가 렌더러와 같은 수를 보게 된다.
  for (const storey of [lower, upper]) {
    const half = storey.width * 0.5;
    storey.columnX = Array.from({ length: storey.columns }, (_, i) => (storey.columns === 1
      ? 0 : -half + storey.width * i / (storey.columns - 1)));
    storey.bay = storey.columns > 1 ? storey.width / (storey.columns - 1) : storey.width;
    storey.columnRadius = Math.min(P.columnRadiusMax, storey.height * P.columnRadiusK);
  }
  lower.bracket = gateBracketBand(lower, P.bracketInterLower, true);
  upper.bracket = gateBracketBand(upper, P.bracketInterUpper, false);
  // 하층 판벽은 창방 밑면(=공포대 밑면)까지 올라간다. 기둥 높이의 분율이 아니라 **공포대 밑면**이
  //   기준이라, 공포대 높이가 바뀌어도 판벽과 창방 사이에 슬릿이 생길 수 없다.
  lower.panel = { y0: lower.y0, y1: lower.bracket.y0, height: lower.bracket.y0 - lower.y0 };
  upper.panel = null;
  const lowerRoof = {
    tier: 'lower',
    y: lower.y1,
    width: lower.width + P.lowerEave * 2 * scale,
    depth: lower.depth + P.lowerEave * 2 * scale,
    height: 0,
  };
  lowerRoof.height = lowerRoof.depth * P.lowerRoofPitch;
  const upperRoof = {
    tier: 'upper',
    y: upper.y1,
    width: upper.width + P.upperEave * 2 * scale,
    depth: upper.depth + P.upperEave * 2 * scale,
    height: 0,
  };
  upperRoof.height = upperRoof.depth * P.upperRoofPitch;
  // 앞뒤(x축) 여장이 모서리까지 덮고, 좌우(z축) 여장은 그 안쪽만 채워 코너에 틈이 없다.
  const sides = [
    { axis: 'x', sign: -1, length: halfWidth * 2, from: { x: -halfWidth, z: -halfDepth + parapetThickness * 0.5 }, to: { x: halfWidth, z: -halfDepth + parapetThickness * 0.5 } },
    { axis: 'x', sign: 1, length: halfWidth * 2, from: { x: -halfWidth, z: halfDepth - parapetThickness * 0.5 }, to: { x: halfWidth, z: halfDepth - parapetThickness * 0.5 } },
    { axis: 'z', sign: -1, length: Math.max(0, halfDepth * 2 - parapetThickness * 2), from: { x: -halfWidth + parapetThickness * 0.5, z: -halfDepth + parapetThickness }, to: { x: -halfWidth + parapetThickness * 0.5, z: halfDepth - parapetThickness } },
    { axis: 'z', sign: 1, length: Math.max(0, halfDepth * 2 - parapetThickness * 2), from: { x: halfWidth - parapetThickness * 0.5, z: -halfDepth + parapetThickness }, to: { x: halfWidth - parapetThickness * 0.5, z: halfDepth - parapetThickness } },
  ];
  return {
    scale,
    deck: { y0: deckY0, y1: deckY1, halfWidth, halfDepth },
    storeys: [lower, upper],
    roofs: [lowerRoof, upperRoof],
    parapet: { halfWidth, halfDepth, thickness: parapetThickness, height: parapetHeight, y: deckY1, sides },
  };
}
