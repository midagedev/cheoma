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
  // footprint: 2~3칸 폭 × 1~1.35칸 깊이. 서민 가옥 상한이 10칸(가사제한)이고 초가삼간이 3~4칸
  //   표준이므로, 그 아래 급인 헛간·부속채는 2~3칸이다(docs/joseon-city.md §가사제한).
  widthKanMin: 2,
  widthKanMax: 3,
  depthMin: KAN,
  depthMax: KAN * 1.35,
  // 이웃 사이 틈. 사진의 부속채 열은 붙어 있으나 한 채씩 읽힌다.
  gapMin: 0.6,
  gapMax: 1.8,
  // 벽(기둥) 높이 — 초가 기둥 2.2m 의 0.82~0.95배.
  bodyHeightMin: CHOGA_COLUMN_HEIGHT * 0.82,
  bodyHeightMax: CHOGA_COLUMN_HEIGHT * 0.95,
  // 볏짚 지붕 상승분(용마루까지). 초가 roofPitch(0.6) × 반깊이 급이 되도록 0.5칸으로 고정한다.
  roofRise: KAN * 0.5,
  // 밴드 전체가 성벽 지상 노출(bodyHeight 7.9 − foundationSink 2.5 = 5.4m)보다 낮아야
  //   "낮은 부속채"다. 여장 위로 지붕이 솟으면 성벽이 부속채에 먹힌다.
  maxApexAboveGround: CITY_WALL_DIMENSIONS.bodyHeight - CITY_WALL_DIMENSIONS.foundationSink,
  // 성벽은 산릉을 타므로 밴드 슬롯이 사면에 걸린다(실측 2026-08-05: 남문 안쪽 0.36~1.07m 대
  //   흥인문·돈의문 안쪽 1.02~7.43m — 좌청룡·우백호 어깨를 오르는 구간). 사면 슬롯은 필지와 같은
  //   어휘(성토 패드 + 막돌 축대)로 앉히되, **상한은 저작하지 않는다**: 낙차까지 포함한 전체
  //   덩이가 성벽 지상 노출을 넘지 않는 값이 곧 상한이다.
  //     maxApexAboveGround − (기단 + 몸통 상한 + 지붕 상승) = 5.4 − (0.3 + 2.09 + 1.1) = 1.91m
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

function footprintAt(spec, angle, side, width, depth, clearance) {
  const anchor = pointOnCityWall(spec, angle);
  const normal = normalOnCityWall(spec, angle);
  const inward = G.mul(normal, -1);
  // 접선은 side 진행 방향을 향하게 잡아 poly 정점 순서가 두 면에서 같은 감기를 갖는다.
  const tangent = G.mul(G.perpL(inward), side);
  const base = G.add(anchor, G.mul(inward, clearance));
  return {
    poly: G.frontageParcel(base, tangent, inward, width / 2, depth, 0),
    inward,
    tangent,
  };
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
          road: 0, stream: 0, terrain: 0,
        };
        let cursor = 0;
        for (let slot = 0; slot < limits.maxPerSide && records.length < limits.maxRecords; slot++) {
          const rng = makeRng(hashString(`gate-quarter|${seed >>> 0}|${gate.name}|${side}|${slot}`));
          const widthKan = rng.int(limits.widthKanMin, limits.widthKanMax);
          const width = widthKan * limits.kan;
          const depth = rng.range(limits.depthMin, limits.depthMax);
          const bodyHeight = rng.range(limits.bodyHeightMin, limits.bodyHeightMax);
          const gap = rng.range(limits.gapMin, limits.gapMax);
          const midArc = cursor + width / 2;
          cursor += width + gap;
          if (midArc + width / 2 > reach) break;
          const angle = angleAtArc(samples, midArc);
          if (angle == null) break;

          // 오목한 contour 구간에서는 배면 양끝이 성벽 쪽으로 부풀어 이격 하한을 깬다.
          //   부족분만큼 안쪽으로 물리고(최대 상한까지), 그래도 못 지키면 그 슬롯을 생략한다.
          let clearance = limits.wallClearanceMin;
          let placement = footprintAt(cityWall, angle, side, width, depth, clearance);
          let range = clearanceRange(cityWall, placement.poly);
          for (let nudge = 0; nudge < 4 && range.min < limits.wallClearanceMin; nudge++) {
            clearance += limits.wallClearanceMin - range.min;
            placement = footprintAt(cityWall, angle, side, width, depth, clearance);
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
            cityWall, angle, side, width + pad * 2, depth + pad * 2, clearance - pad,
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
            w: width,
            d: depth,
            widthKan,
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
              roofRise: limits.roofRise,
              thatchThick: limits.thatchThick,
            },
            eave: limits.eave,
            apexY: terrain.max + limits.plinth + bodyHeight + limits.roofRise,
          };
          accepted.push(record);
          records.push(record);
        }
        bands.push({
          gate: gate.name,
          side,
          count: accepted.length,
          reach,
          arcCovered: accepted.length ? accepted.at(-1).arc + accepted.at(-1).w / 2 : 0,
          rejected,
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
    if (record.d + 1e-9 < limits.depthMin || record.d > limits.depthMax + 1e-9) {
      throw new RangeError(`${record.id} depth leaves the planned band`);
    }
    if (record.roof !== 'thatch') {
      throw new RangeError(`${record.id} must be a thatched outbuilding`);
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
      || heights.roofRise !== limits.roofRise
      || heights.thatchThick !== limits.thatchThick
      || !Number.isFinite(heights.pad) || heights.pad < 0) {
      throw new RangeError(`${record.id} has an unsupported height section`);
    }
    if (heights.body + 1e-9 < limits.bodyHeightMin || heights.body > limits.bodyHeightMax + 1e-9) {
      throw new RangeError(`${record.id} body height leaves the outbuilding rank`);
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
  }
  for (let i = 0; i < plan.records.length; i++) {
    for (let j = i + 1; j < plan.records.length; j++) {
      if (G.polysOverlap(plan.records[i].poly, plan.records[j].poly)) {
        throw new RangeError(`${plan.records[i].id} overlaps ${plan.records[j].id}`);
      }
    }
  }
  return plan;
}
