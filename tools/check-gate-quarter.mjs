// 성벽 안면 부속 밴드 계약 — 성문 지구의 낮은 부속채 열 (순수 노드, 미등록 게이트).
//
// 왜 이 게이트가 필요한가 (#54 슬라이스 B):
//   구한말 도성 사진의 성문 좌우는 **성벽 안쪽 면에 낮은 부속채(헛간·초가급)가 붙어** 시가지가
//   성벽에 닿는다(refs/hanyang-old, 비공개). 직전 라운드가 간선 파사드 행랑을 성문까지 이었으므로
//   (docs/joseon-city.md §성문 주변) 남은 공백이 이 밴드였고, 실측상 성벽 안면은 전무하게 비어
//   있었다(scratch/gate-approach 프로브, 2026-08-04). 여기서 단언하는 것은 그 열의 **존재**와
//   그 열이 넘어서는 안 되는 선(순라 통로·문전 마당·통행 예약·도로·필지·시전·개천)이다.
//
// 밴드의 치수는 고증 치수가 아니라 제품 값이며(gate-quarter-plan.js 주석), 그 값들 자체가
//   레포의 검증된 수(성벽 두께·소로 폭·주칸·접근 예약·초가 프리셋)의 파생이므로 이 게이트는
//   임계를 새로 저작하지 않고 LIMITS 를 읽어 단언한다.
//
// usage:
//   node tools/check-gate-quarter.mjs
//   node tools/check-gate-quarter.mjs --report-only   # 임계 판정 없이 실측 표만
//   node tools/check-gate-quarter.mjs --fail-first    # 결함 주입 → 단언이 실제로 실패하는지 확인
import { createHash } from 'node:crypto';

import * as G from '../src/core/math/geom2.js';
import { planVillage, GATE_FORECOURT_PLAN_DEPTH } from '../src/village/plan.js';
import {
  CITY_WALL_DIMENSIONS,
  cityGateApproachFootprint,
  cityGateForecourtPolygon,
  cityWallClearance,
} from '../src/village/citywall-contour.js';
import { isSijeonShop } from '../src/village/sijeon-plan.js';
import { createRoadSpatialIndex } from '../src/village/road-spatial.js';
import { streamIntersectsPolygon } from '../src/village/stream-spatial.js';
import { terrainMeshHeightAt } from '../src/village/terrain-grid.js';
import {
  GATE_QUARTER_KIND,
  GATE_QUARTER_PLAN_LIMITS as LIMITS,
  validateGateQuarterPlan,
} from '../src/village/gate-quarter-plan.js';

const reportOnly = process.argv.includes('--report-only');
const failFirst = process.argv.includes('--fail-first');
const SEEDS = [20260716, 2026, 7, 99];
const SCALES_WITHOUT_WALL = ['hamlet', 'village', 'town', 'capital'];

// ── 집계 하한 ────────────────────────────────────────────────────────────────
// 시드별 단언을 쓰지 않는 이유: 성곽은 산릉을 타고 개천은 성벽에 붙어 흐를 수 있어(docs/joseon-city.md
//   §개천 "개천이 성벽과 나란히 10~15m 거리로 흐르는 것은 Phase A 가 채택한 기하") 어떤 시드는
//   특정 성문 안면에 밴드가 물리적으로 성립하지 않는다. 그 시드를 통과시키려고 이격·경사 계약을
//   완화하면 계약이 사라지므로, **집계 하한 + 조용한 0 금지**로 회귀를 잡는다.
// 실측(2026-08-05, 4시드): 전체 14/16/14/2 = 46, 남문 9/10/11/1 = 31.
const TOTAL_FLOOR = 30;          // 46 에 35% 여유. 구현 전 소스는 0 이라 이 하한이 정확히 그 회귀를 잡는다.
const SOUTH_FLOOR = 20;          // 31 에 35% 여유. 남문은 히어로 접근로다.
const MIN_BANDED_GATES = 2;      // 시드당 밴드를 가진 접근 간선 문 수(실측 2~3).

// ── v2 변주 하한 (2026-08-05 비전 ②) ────────────────────────────────────────
// 비전 판정: "유닛들이 끊기지 않은 하나의 갈색 벽면을 공유해 지붕 4개 얹힌 창고 한 채로 읽힌다".
//   원인은 균일 반복이었으므로(칸수 2~3 균등·용마루 높이 고정·요 0·간격 0.6~1.8 단일 대역),
//   여기서 단언하는 것은 **변주가 실제로 존재하는가**다. 임계는 v2 실측에서 넉넉한 여유를 두고
//   내렸고(아래 각 상수 주석), 구현 전(v1) 형상에서 실패함을 --fail-first 의 uniform 주입으로 확인한다.
// v2 실측(4시드 54채): 칸수 1/2/3 = 59/28/13%, 용마루 높이 std 0.183m, 요 std 0.0288rad,
//   틈 분포 군집 30%(10) · 공백 70%(23). 아래 임계는 그 실측에서 내렸고 v1 형상(uniform 주입)에서 실패한다.
const KAN_SHARE_CEILING = 0.70;  // 실측 최대 점유 59%(1칸). 한 칸수가 열의 70% 를 넘으면 반복이다.
const RIDGE_STD_FLOOR = 0.14;    // 용마루 높이(기단+몸통+지붕상승) 표준편차 실측 0.183m → 24% 여유.
const YAW_STD_FLOOR = 0.015;     // 요 표준편차 실측 0.0288rad → 0.015 하한(0 이면 완전 평행이다).
const GAP_TIGHT_SHARE = 0.15;    // 실측 30/70%. 어느 쪽이든 15% 아래면 리듬이 한 종류로 무너진 것이다.

const errors = [];
const fail = (message) => errors.push(message);
const r2 = (value) => (Number.isFinite(value) ? +value.toFixed(2) : value);
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);

function planHanyang(seed) {
  return planVillage({ scale: 'hanyang', seed, includePalace: true, includeTemple: true });
}

// ── 독립 재구성 (계측기 교차 확인) ──────────────────────────────────────────
// 지붕 사각·축대 사각을 계획 모듈에서 import 하지 않고 center·frontDir·치수에서 **여기서 다시**
//   세운다. 계획과 게이트가 같은 함수를 공유하면 그 함수의 버그를 둘 다 못 본다(2026-08-01 계측기
//   버그 2건). 지형 최저점도 계획(5×5)보다 촘촘한 격자(9×9)로 다시 훑는다.
function orientedRect(center, frontDir, halfW, halfD, offsetX = 0) {
  const t = { x: frontDir.z, z: -frontDir.x };          // perpL(frontDir)
  const cx = center.x + t.x * offsetX;
  const cz = center.z + t.z * offsetX;
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => ({
    x: cx + t.x * halfW * a + frontDir.x * halfD * b,
    z: cz + t.z * halfW * a + frontDir.z * halfD * b,
  }));
}

const roofRect = (record, pad = 0) => orientedRect(record.center, record.frontDir,
  record.w / 2 + record.eave + pad, record.d / 2 + record.eave + pad);

const stoneRect = (record) => orientedRect(record.center, record.frontDir,
  (record.stone.spanNegX + record.stone.spanPosX) / 2, record.stone.depth / 2,
  (record.stone.spanPosX - record.stone.spanNegX) / 2);

function rectFloor(site, rect, steps = 8) {
  const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
  let min = Infinity;
  for (let i = 0; i <= steps; i++) {
    const left = lerp(rect[0], rect[3], i / steps);
    const right = lerp(rect[1], rect[2], i / steps);
    for (let j = 0; j <= steps; j++) {
      const point = lerp(left, right, j / steps);
      const y = terrainMeshHeightAt(site, point.x, point.z);
      if (Number.isFinite(y) && y < min) min = y;
    }
  }
  return Number.isFinite(min) ? min : null;
}

const mean = (values) => values.reduce((sum, value) => sum + value, 0) / (values.length || 1);
const std = (values) => {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - m) ** 2)));
};

// 같은 (문,면)의 연속 채 사이 접선 틈. **한 시드 안에서만** 의미가 있다 — 시드를 섞어 정렬하면
//   서로 다른 도성의 호 좌표가 이웃으로 붙어 0 에 가까운 가짜 틈이 나온다(실측 오진 1건).
function sideGaps(records) {
  const bySide = new Map();
  for (const record of records) {
    const key = `${record.gate}|${record.side}`;
    if (!bySide.has(key)) bySide.set(key, []);
    bySide.get(key).push(record);
  }
  const gaps = [];
  for (const list of bySide.values()) {
    list.sort((a, b) => a.arc - b.arc);
    for (let i = 0; i + 1 < list.length; i++) {
      gaps.push(list[i + 1].arc - list[i].arc - list[i].w / 2 - list[i + 1].w / 2);
    }
  }
  return gaps;
}

/**
 * 변주 계약(비전 ②) — 레코드 집합이 "균일 반복"이 아님을 단언한다. 집계 단위로 쓰지만
 * --fail-first 의 uniform 주입은 한 시드에도 걸리므로 같은 함수를 재사용한다.
 * `gaps` 는 시드별로 계산해 모은 틈 목록이다(시드 간 정렬 금지 — 위 sideGaps 주석).
 */
function variationErrors(records, gaps, label) {
  const local = [];
  const note = (message) => local.push(`${label}: ${message}`);
  if (records.length < 4) return local;
  const kans = records.map((record) => record.widthKan);
  for (const want of [1, 2, 3]) {
    if (!kans.includes(want)) note(`칸수 분포에 ${want}칸이 없다 — 열이 같은 덩이의 반복이다`);
  }
  for (const want of new Set(kans)) {
    const share = kans.filter((kan) => kan === want).length / kans.length;
    if (share > KAN_SHARE_CEILING) {
      note(`${want}칸이 열의 ${(share * 100).toFixed(0)}% — 상한 ${KAN_SHARE_CEILING * 100}%`);
    }
  }
  const ridge = records.map((record) => record.heights.plinth + record.heights.body
    + record.heights.roofRise);
  if (std(ridge) < RIDGE_STD_FLOOR) {
    note(`용마루 높이 표준편차 ${std(ridge).toFixed(3)}m < ${RIDGE_STD_FLOOR}m — 용마루 선이 한 줄이다`);
  }
  const yaws = records.map((record) => record.yaw);
  if (std(yaws) < YAW_STD_FLOOR) {
    note(`요 표준편차 ${std(yaws).toFixed(4)}rad < ${YAW_STD_FLOOR} — 열이 완전 평행이다`);
  }
  if (yaws.some((yaw) => Math.abs(yaw) > LIMITS.yawMax + 1e-9)) {
    note('요가 상한을 넘었다 — 성벽 안면 열이 아니라 흐트러진 배치다');
  }
  // 간격 리듬: 군집 틈(<= 처마 3폭)과 공백 틈(>= 소로)이 둘 다 나와야 "붙은 군집과 넓은 공백이
  //   혼재"가 성립한다.
  if (gaps.length >= 4) {
    const tight = gaps.filter((gap) => gap <= LIMITS.gapTightMax + 1e-6).length / gaps.length;
    const wide = gaps.filter((gap) => gap >= LIMITS.gapVoidMin - 1e-6).length / gaps.length;
    if (tight < GAP_TIGHT_SHARE) {
      note(`군집 틈(<= ${r2(LIMITS.gapTightMax)}m)이 간격의 ${(tight * 100).toFixed(0)}% — 붙은 군집이 없다`);
    }
    if (wide < GAP_TIGHT_SHARE) {
      note(`공백 틈(>= ${LIMITS.gapVoidMin}m)이 간격의 ${(wide * 100).toFixed(0)}% — 넓은 공백이 없다`);
    }
    if (std(gaps) < LIMITS.drip) {
      note(`간격 표준편차 ${std(gaps).toFixed(2)}m < ${LIMITS.drip}m — 간격이 사실상 고정이다`);
    }
  }
  return local;
}

// 문 로컬좌표(프로브와 같은 축): u = 성 안쪽 거리, v = 문 축 좌우 오프셋.
function gateLocal(gate, point) {
  const length = Math.hypot(gate.dirX, gate.dirZ) || 1;
  const ux = gate.dirX / length, uz = gate.dirZ / length;
  const dx = point.x - gate.x, dz = point.z - gate.z;
  return { u: -(dx * ux + dz * uz), v: dx * -uz + dz * ux };
}

/**
 * 한 시드의 밴드 계약 전부. 결함 주입 모드가 같은 함수를 재사용하므로 단언은 여기 한 곳에만 있다.
 * plan 은 planVillage 결과(또는 그 JSON 복제)이며 gateQuarter 만 교체될 수 있다.
 */
function checkSeed(plan, label, { verbose = true } = {}) {
  const local = [];
  const note = (message) => local.push(`${label}: ${message}`);
  const cityWall = plan.features?.cityWall;
  if (!cityWall?.gates?.length) {
    note('성곽 게이트가 없다 — 도성 시드가 아니다');
    return { errors: local, records: [], south: 0, gaps: [] };
  }
  const band = plan.features?.gateQuarter;
  if (!band) {
    note('성벽 안면 부속 밴드(features.gateQuarter)가 아예 없다');
    return { errors: local, records: [], south: 0, gaps: [] };
  }
  try {
    validateGateQuarterPlan(band);
  } catch (error) {
    note(`계획 자체 검증 실패 — ${error.message}`);
  }
  if (band.kind !== GATE_QUARTER_KIND) {
    note(`밴드 kind 가 ${band.kind} 다 — 기존 enum 차용 금지(신규 kind 여야 한다)`);
  }

  const records = band.records || [];
  const forecourts = cityWall.gates.map((gate) => cityGateForecourtPolygon(gate,
    { length: GATE_FORECOURT_PLAN_DEPTH }));
  const approaches = cityWall.gates.map((gate) => cityGateApproachFootprint(gate));
  const parcels = plan.parcels || [];
  const shops = (plan.features.sijeon || []).filter(isSijeonShop);
  const paddies = plan.paddies || [];
  const roadSpatial = createRoadSpatialIndex(plan.roads || []);
  const exposedWall = CITY_WALL_DIMENSIONS.bodyHeight - CITY_WALL_DIMENSIONS.foundationSink;

  // ── 1) 북문(접근 간선 없는 문)에는 밴드가 없다 ──
  const northBand = records.filter((record) => record.gate === 'north');
  if (northBand.length) {
    note(`숙정문(북)에 부속채 ${northBand.length}채 — 북문은 접근 간선이 없는 설계다`);
  }

  // ── 2) 조용한 0 금지: 밴드가 빈 (문,면)은 계획이 사유를 보고해야 한다 ──
  for (const entry of band.bands || []) {
    if (entry.count > 0) continue;
    if (entry.reason === 'no-approach-arterial') continue;
    const rejected = entry.rejected || {};
    const total = Object.values(rejected).reduce((sum, value) => sum + value, 0);
    if (!(entry.reach > 0)) continue;    // 이웃 개구부에 막혀 호가 없는 면
    if (total === 0) {
      note(`${entry.gate} side ${entry.side}: 밴드가 비었는데 탈락 사유가 0 — 조용한 공백`);
    }
  }

  // ── 3) 레코드별 물리 계약 ──
  for (const record of records) {
    const id = `${label} ${record.id}(${record.gate}${record.side > 0 ? '+' : '-'})`;
    const measured = record.poly.map((point) => cityWallClearance(cityWall, point));
    const min = Math.min(...measured), max = Math.max(...measured);
    if (min + 1e-6 < LIMITS.wallClearanceMin) {
      note(`${id}: 성벽 이격 ${r2(min)}m < 하한 ${r2(LIMITS.wallClearanceMin)}m — 순라 통로 침범`);
    }
    if (max > LIMITS.wallClearanceMax + 1e-6) {
      note(`${id}: 성벽 이격 ${r2(max)}m > 상한 ${r2(LIMITS.wallClearanceMax)}m — 성벽 안면을 떠났다`);
    }
    // 처마까지 통로 밖 — 이 밴드가 성벽에 붙는 것과 통로를 막는 것은 다르다.
    const lane = min - record.eave - CITY_WALL_DIMENSIONS.thickness / 2;
    if (lane + 1e-6 < LIMITS.patrolLane) {
      note(`${id}: 처마 포함 순라 통로 ${r2(lane)}m < ${LIMITS.patrolLane}m`);
    }
    if (forecourts.some((poly) => G.polysOverlap(record.poly, poly))) {
      note(`${id}: 문전 마당(${GATE_FORECOURT_PLAN_DEPTH}m) 침범`);
    }
    if (approaches.some((poly) => G.polysOverlap(record.poly, poly))) {
      note(`${id}: 성문 통행·식생 예약(${CITY_WALL_DIMENSIONS.gateApproachLength
        + CITY_WALL_DIMENSIONS.gateApproachClearance}m) 침범`);
    }
    if (parcels.some((parcel) => G.polysOverlap(record.poly, parcel.poly))) {
      note(`${id}: 기존 필지 침범`);
    }
    if (shops.some((shop) => G.polysOverlap(record.poly, shop.poly))) {
      note(`${id}: 시전 행랑 침범`);
    }
    if (paddies.some((field) => G.polysOverlap(record.poly, field.poly))) {
      note(`${id}: 논배미 침범`);
    }
    if (roadSpatial.intersectsRoadCorridor(record.poly, 0)) {
      note(`${id}: 도로 회랑 침범`);
    }
    if (streamIntersectsPolygon(plan.site, record.poly, 0)) {
      note(`${id}: 개천 하도 침범`);
    }
    const visible = record.apexY - record.terrain.minY;
    if (visible > exposedWall + 1e-6) {
      note(`${id}: 용마루가 지형 최저귀에서 ${r2(visible)}m — 성벽 지상 노출 ${exposedWall}m 를 넘었다`);
    }
    // ── 개구부(비전 ①) — 무창 매스 금지. 문 한 짝이 자기 칸 안에 있고 인방 아래여야 한다. ──
    const door = record.door;
    if (!door || !(door.w > 0) || !(door.h > 0)) {
      note(`${id}: 개구부가 없다 — 무창 흙벽 매스로 읽힌다`);
    } else {
      if (!Number.isInteger(record.bays) || record.bays !== record.widthKan) {
        note(`${id}: 칸 분할(bays ${record.bays})이 칸수 ${record.widthKan} 와 다르다`);
      }
      if (Math.abs(door.offsetX) + door.w / 2 > record.w / 2 + 1e-9) {
        note(`${id}: 널문이 벽면을 벗어났다`);
      }
      if (door.h >= record.heights.body) {
        note(`${id}: 널문 높이 ${r2(door.h)}m 가 기둥 ${r2(record.heights.body)}m 이상 — 인방이 없다`);
      }
      if (!(door.recess > 0)) note(`${id}: 개구부 음각 깊이가 0 — 벽면과 같은 평면이다`);
    }

    // ── 축대 연속성(비전 ③) — 리턴면이 지형까지 마감됐는가. 계획보다 촘촘한 격자로 다시 잰다. ──
    const stone = record.stone;
    if (!stone) {
      note(`${id}: 축대 단면이 없다`);
    } else {
      const floor = rectFloor(plan.site, stoneRect(record));
      if (floor != null && stone.bottomY > floor - LIMITS.embed * 0.9) {
        note(`${id}: 축대 밑동 ${r2(stone.bottomY)}m 가 접지 지형 최저 ${r2(floor)}m 에 못 미친다`
          + ` — 노출 리턴면(9×9 격자 재측)`);
      }
      if (Math.abs(stone.topY - (record.baseY + record.heights.plinth)) > 1e-6) {
        note(`${id}: 축대 윗면이 기단 상면과 어긋난다`);
      }
      // 축대는 몸통보다 어깨만큼 넓으므로 배면이 성벽 쪽으로 더 나온다. 처마가 없는 부재이므로
      //   기준은 순라 통로 그 자체(성벽 면에서 3.4m)다 — 이 단언이 없으면 축대 깊이를 늘리는
      //   변경이 조용히 통로를 먹는다.
      const stoneLane = Math.min(...stoneRect(record).map((point) => cityWallClearance(cityWall, point)))
        - CITY_WALL_DIMENSIONS.thickness / 2;
      if (stoneLane + 1e-6 < LIMITS.patrolLane) {
        note(`${id}: 축대 배면이 순라 통로를 ${r2(LIMITS.patrolLane - stoneLane)}m 먹는다`);
      }
    }

    // 성문 지구 범위: 문 개구 끝 기준 호 거리가 계획 범위 안이고, 문 안쪽에 있어야 한다.
    const gate = cityWall.gates.find((candidate) => candidate.name === record.gate);
    if (!gate) { note(`${id}: 알 수 없는 성문 참조`); continue; }
    if (record.arc > LIMITS.arcReach + 1e-6) {
      note(`${id}: 호 거리 ${r2(record.arc)}m > 계획 범위 ${LIMITS.arcReach}m`);
    }
    if (gateLocal(gate, record.center).u < 0) {
      note(`${id}: 성문 바깥에 앉았다`);
    }
  }

  // ── 4) 지붕 간 하드 Z 교차 금지(비전 ④) ──
  // 낙수 골 절반씩 부풀린 처마 사각이 겹치면 두 채가 서로를 관통해 한 덩이로 읽힌다. v1 은
  //   처마 0.7m 두 폭(1.4m)보다 좁은 간격(0.6~1.8m)을 허용해 실제로 겹쳐 있었다.
  const halfDrip = LIMITS.drip / 2;
  const roofs = records.map((record) => roofRect(record, halfDrip));
  for (let i = 0; i < roofs.length; i++) {
    for (let j = i + 1; j < roofs.length; j++) {
      if (G.polysOverlap(roofs[i], roofs[j])) {
        note(`${records[i].id}·${records[j].id}: 처마 사각이 겹친다 — 낙수 골 ${LIMITS.drip}m 미달`);
      }
    }
  }

  // ── 5) 군집 축대 접합(비전 ③) ──
  // 좁은 틈으로 이웃한 쌍은 축대가 실제로 맞물려야 하고(사각 겹침으로 확인), 못 이었으면
  //   계획이 사유를 남겨야 한다(조용한 노치 금지).
  const byId = new Map(records.map((record) => [record.id, record]));
  let joinedPairs = 0;
  let unjoined = 0;
  for (const entry of band.bands || []) {
    for (const join of entry.joins || []) {
      const a = byId.get(join.from);
      const b = byId.get(join.to);
      if (!a || !b) continue;
      if (join.joined) {
        joinedPairs++;
        if (!G.polysOverlap(stoneRect(a), stoneRect(b))) {
          note(`${a.id}·${b.id}: 접합했다고 기록됐지만 축대 사각이 만나지 않는다 — 노치 잔존`);
        }
      } else {
        unjoined++;
        if (!join.reason) {
          note(`${a.id}·${b.id}: 축대 미접합인데 사유가 없다 — 조용한 노치`);
        } else if (join.reason === 'void-gap'
          && join.free <= LIMITS.gapTightMax + 1e-6 && join.free > 0) {
          note(`${a.id}·${b.id}: 틈 ${r2(join.free)}m 는 군집인데 void-gap 으로 넘겼다`);
        }
      }
    }
  }

  const south = records.filter((record) => record.gate === 'south').length;
  if (verbose) {
    const kans = records.map((record) => record.widthKan);
    const ridge = records.map((record) => record.heights.plinth + record.heights.body
      + record.heights.roofRise);
    const yaws = records.map((record) => record.yaw);
    if (records.length) {
      console.log(`\n-- ${label} 변주: 칸수 `
        + [1, 2, 3].map((kan) => `${kan}칸:${kans.filter((k) => k === kan).length}`).join(' ')
        + `  용마루 높이 ${r2(Math.min(...ridge))}~${r2(Math.max(...ridge))}m std ${std(ridge).toFixed(3)}`
        + `  요 std ${std(yaws).toFixed(4)}rad`
        + `  축대 접합 ${joinedPairs}쌍 (미접합 ${unjoined})`);
    }
    const byGate = new Map();
    for (const record of records) {
      const key = `${record.gate}${record.side > 0 ? '+' : '-'}`;
      byGate.set(key, (byGate.get(key) || 0) + 1);
    }
    const clear = records.map((record) => record.wallClearance.min);
    const pads = records.map((record) => record.heights.pad);
    const apex = records.map((record) => record.apexY - record.terrain.minY);
    console.log(`\n== ${label}  부속채 ${records.length}채 (남문 ${south}) ==`);
    console.log(`  면별 ${[...byGate].sort().map(([k, v]) => `${k}:${v}`).join(' ') || '없음'}`);
    if (records.length) {
      console.log(`  성벽 이격 ${r2(Math.min(...clear))}~${r2(Math.max(...clear))}m`
        + ` [${r2(LIMITS.wallClearanceMin)}~${r2(LIMITS.wallClearanceMax)}]`
        + `  축대 낙차 ${r2(Math.min(...pads))}~${r2(Math.max(...pads))}m [<= ${r2(LIMITS.maxTerrainSpread)}]`
        + `  용마루 높이 ${r2(Math.min(...apex))}~${r2(Math.max(...apex))}m [<= ${exposedWall}]`);
    }
    for (const entry of band.bands || []) {
      const rejected = entry.rejected
        ? Object.entries(entry.rejected).filter(([, v]) => v).map(([k, v]) => `${k}:${v}`).join(' ')
        : (entry.reason || '');
      console.log(`  ${entry.gate.padEnd(6)} side ${String(entry.side).padStart(2)}`
        + ` 채수 ${String(entry.count).padStart(2)}  호 ${r2(entry.arcCovered)}/${r2(entry.reach)}m`
        + `   탈락 ${rejected || '없음'}`);
    }
  }
  return { errors: local, records, south, gaps: sideGaps(records) };
}

// ── 결함 주입(FAIL-first) ────────────────────────────────────────────────────
// 구현 전 소스에서 실제로 실패함을 보이는 것이 원칙이지만 이 라운드는 git 을 쓸 수 없으므로,
//   같은 단언 함수에 **구현 전 형상(밴드 없음)**과 대표 위반 두 개를 주입해 각각이 잡히는지 본다.
//   'no-band' 는 문자 그대로 구현 전 plan 형상이다.
function injectFault(plan, kind) {
  const clone = {
    ...plan,
    features: { ...plan.features },
  };
  if (kind === 'no-band') {
    delete clone.features.gateQuarter;
    return clone;
  }
  const band = JSON.parse(JSON.stringify(plan.features.gateQuarter));
  const cityWall = plan.features.cityWall;
  // v1 형상 재현 결함들 — 각각이 2026-08-05 비전 판정 한 건에 대응한다.
  if (kind === 'no-door') {
    // 비전 ①: 개구부 없는 무창 흙벽.
    for (const record of band.records) { delete record.door; delete record.bays; }
    clone.features.gateQuarter = band;
    return clone;
  }
  if (kind === 'uniform') {
    // 비전 ②: 칸수 2 고정·용마루 높이 고정·요 0 — v1 의 균일 반복.
    for (const record of band.records) {
      record.widthKan = 2;
      record.bays = 2;
      record.w = LIMITS.kan * 2;
      record.yaw = 0;
      record.heights.body = LIMITS.bodyHeightMax;
      record.heights.roofRise = LIMITS.roofRiseMax;
    }
    clone.features.gateQuarter = band;
    return clone;
  }
  if (kind === 'notch') {
    // 비전 ③: 축대를 몸통 폭으로 되돌리고 밑동을 지형 최저 귀에 맞춘다(v1 형상).
    for (const record of band.records) {
      const bare = record.w / 2 + LIMITS.plinthMargin;
      record.stone.spanNegX = bare;
      record.stone.spanPosX = bare;
      record.stone.bottomY = record.terrain.minY;
    }
    for (const entry of band.bands) {
      for (const join of entry.joins || []) { join.joined = false; delete join.reason; }
    }
    clone.features.gateQuarter = band;
    return clone;
  }
  if (kind === 'roof-overlap') {
    // 비전 ④: 같은 면의 채들을 서로 0.9m 당겨 처마를 겹치게 한다(v1 간격 대역).
    const bySide = new Map();
    for (const record of band.records) {
      const key = `${record.gate}|${record.side}`;
      if (!bySide.has(key)) bySide.set(key, []);
      bySide.get(key).push(record);
    }
    for (const list of bySide.values()) {
      list.sort((a, b) => a.arc - b.arc);
      list.forEach((record, index) => {
        if (index === 0) return;
        const previous = list[index - 1];
        const dx = previous.center.x - record.center.x;
        const dz = previous.center.z - record.center.z;
        const length = Math.hypot(dx, dz) || 1;
        const pull = Math.max(0, length - previous.w / 2 - record.w / 2 - 0.2);
        record.center = {
          x: record.center.x + (dx / length) * pull,
          z: record.center.z + (dz / length) * pull,
        };
      });
    }
    clone.features.gateQuarter = band;
    return clone;
  }
  for (const record of band.records) {
    if (kind === 'crowd-wall') {
      // 성벽 쪽으로 3m 밀어 순라 통로를 먹게 한다(배면 법선 = -frontDir).
      const shift = { x: -record.frontDir.x * 3, z: -record.frontDir.z * 3 };
      record.poly = record.poly.map((point) => ({ x: point.x + shift.x, z: point.z + shift.z }));
      record.center = { x: record.center.x + shift.x, z: record.center.z + shift.z };
      record.wallClearance = {
        min: Math.min(...record.poly.map((p) => cityWallClearance(cityWall, p))),
        max: Math.max(...record.poly.map((p) => cityWallClearance(cityWall, p))),
      };
    } else if (kind === 'forecourt') {
      // 문 축 위(문전 마당 안)로 옮긴다.
      const gate = cityWall.gates.find((candidate) => candidate.name === record.gate);
      const inward = { x: -gate.dirX, z: -gate.dirZ };
      const target = { x: gate.x + inward.x * 8, z: gate.z + inward.z * 8 };
      const delta = { x: target.x - record.center.x, z: target.z - record.center.z };
      record.poly = record.poly.map((point) => ({ x: point.x + delta.x, z: point.z + delta.z }));
      record.center = target;
    }
  }
  clone.features.gateQuarter = band;
  return clone;
}

// ── 실행 ─────────────────────────────────────────────────────────────────────
console.log(`gate quarter: 이격 ${r2(LIMITS.wallClearanceMin)}~${r2(LIMITS.wallClearanceMax)}m`
  + `  (성벽 반두께 ${CITY_WALL_DIMENSIONS.thickness / 2} + 순라 통로 ${LIMITS.patrolLane} + 처마 ${LIMITS.eave})`
  + `  호 범위 ${LIMITS.arcReach}m  사면 상한 ${r2(LIMITS.maxTerrainSpread)}m`);

if (failFirst) {
  const plan = planHanyang(SEEDS[0]);
  // 결함 종류마다 "이 단언이 잡아야 한다"까지 명시한다. no-band 는 구현 전 형상, 나머지 4종은
  //   v1 형상(비전 4결함) 재현이다.
  const FAULTS = [
    'no-band', 'crowd-wall', 'forecourt',
    'no-door', 'uniform', 'notch', 'roof-overlap',
  ];
  let caught = 0;
  for (const kind of FAULTS) {
    const faulty = injectFault(plan, kind);
    const result = checkSeed(faulty, `FAULT/${kind}`, { verbose: false });
    const errors = [...result.errors,
      ...variationErrors(result.records, result.gaps, `FAULT/${kind}`)];
    if (errors.length) {
      caught++;
      console.log(`\n  ${kind.padEnd(12)} → ${errors.length} FAIL (기대대로)`);
      for (const error of errors.slice(0, 3)) console.log(`      - ${error}`);
    } else {
      console.log(`\n  ${kind.padEnd(12)} → 0 FAIL — 게이트가 이 결함을 못 잡는다`);
    }
  }
  const clean = checkSeed(plan, 'CLEAN', { verbose: false });
  const cleanErrors = [...clean.errors, ...variationErrors(clean.records, clean.gaps, 'CLEAN')];
  console.log(`\n  clean        → ${cleanErrors.length} FAIL (0 이어야 한다)`);
  for (const error of cleanErrors.slice(0, 5)) console.log(`      - ${error}`);
  if (caught !== FAULTS.length || cleanErrors.length !== 0) {
    console.error('\nGATE QUARTER FAIL-FIRST: 검증 실패 — 게이트를 신뢰할 수 없다');
    process.exit(1);
  }
  console.log(`\nGATE QUARTER FAIL-FIRST: PASS (구현 전 형상 + v1 형상 재현 ${FAULTS.length - 1}종 모두 잡힘,`
    + ' 정상 소스는 0)');
  process.exit(0);
}

let total = 0;
let southTotal = 0;
const allRecords = [];
const allGaps = [];
for (const seed of SEEDS) {
  const plan = planHanyang(seed);
  const result = checkSeed(plan, `hanyang/${seed}`);
  for (const error of result.errors) fail(error);
  total += result.records.length;
  southTotal += result.south;
  allRecords.push(...result.records);
  allGaps.push(...result.gaps);

  // 결정론: 같은 seed → 같은 밴드(전용 시드 스트림이므로 공유 rng 와 무관하게 재현되어야 한다).
  const repeat = planHanyang(seed);
  if (hash(plan.features.gateQuarter) !== hash(repeat.features.gateQuarter)) {
    fail(`hanyang/${seed}: 밴드가 재현되지 않는다`);
  }

  // 밴드를 가진 접근 간선 문 수
  const banded = new Set(result.records.map((record) => record.gate));
  if (banded.size < MIN_BANDED_GATES) {
    fail(`hanyang/${seed}: 밴드를 가진 성문 ${banded.size}문 < ${MIN_BANDED_GATES}문`);
  }
}

// 성곽 없는 규모는 features 키조차 얻지 않는다(다른 4규모 plan 바이트 보존의 계약 표현).
for (const scale of SCALES_WITHOUT_WALL) {
  const plan = planVillage({ scale, seed: SEEDS[0], includeTemple: true });
  if (plan.features.gateQuarter !== undefined) {
    fail(`${scale}: 성곽이 없는데 features.gateQuarter 가 붙었다 — 4규모 plan 바이트가 이동한다`);
  }
  if (plan.stats.gateQuarters !== undefined) {
    fail(`${scale}: 성곽이 없는데 stats.gateQuarters 가 붙었다`);
  }
}

// 변주 계약(비전 ②)은 집계로 단언한다 — 시드 하나는 표본이 10채까지 내려가고, 성벽 안면이
//   물리적으로 좁은 시드까지 분포 단언에 걸면 계약이 시드 운에 좌우된다.
for (const error of variationErrors(allRecords, allGaps, '집계')) fail(error);

console.log(`\n합계: 부속채 ${total}채 (남문 ${southTotal}채) / ${SEEDS.length} 시드`);
{
  const kans = allRecords.map((record) => record.widthKan);
  const ridge = allRecords.map((record) => record.heights.plinth + record.heights.body
    + record.heights.roofRise);
  const yaws = allRecords.map((record) => record.yaw);
  console.log(`  칸수 분포 `
    + [1, 2, 3].map((kan) => {
      const n = kans.filter((k) => k === kan).length;
      return `${kan}칸 ${n}(${(n / kans.length * 100).toFixed(0)}%)`;
    }).join(' ')
    + `   [상한 ${KAN_SHARE_CEILING * 100}%]`);
  const tight = allGaps.filter((gap) => gap <= LIMITS.gapTightMax + 1e-6).length;
  const wide = allGaps.filter((gap) => gap >= LIMITS.gapVoidMin - 1e-6).length;
  console.log(`  틈 분포 군집(<= ${r2(LIMITS.gapTightMax)}m) ${tight}`
    + `  공백(>= ${LIMITS.gapVoidMin}m) ${wide}  / ${allGaps.length}개`
    + `  std ${std(allGaps).toFixed(2)}m   [양쪽 >= ${GAP_TIGHT_SHARE * 100}%]`);
  console.log(`  용마루 높이(기단+몸통+지붕상승) ${r2(Math.min(...ridge))}~${r2(Math.max(...ridge))}m`
    + ` std ${std(ridge).toFixed(3)} [>= ${RIDGE_STD_FLOOR}]`
    + `   요 std ${std(yaws).toFixed(4)}rad [>= ${YAW_STD_FLOOR}]`
    + `   |요| max ${Math.max(...yaws.map(Math.abs)).toFixed(4)} [<= ${LIMITS.yawMax}]`);
}

if (reportOnly) {
  console.log(`\nGATE QUARTER REPORT ONLY — ${errors.length} would-be failures`);
  for (const error of errors) console.log(`  - ${error}`);
  process.exit(0);
}

if (total < TOTAL_FLOOR) {
  fail(`전체 부속채 ${total}채 < 하한 ${TOTAL_FLOOR}채 — 성벽 안면이 다시 비었다`);
}
if (southTotal < SOUTH_FLOOR) {
  fail(`남문 부속채 ${southTotal}채 < 하한 ${SOUTH_FLOOR}채 — 히어로 접근로 안면이 비었다`);
}

if (errors.length) {
  console.error(`\nGATE QUARTER: FAIL (${errors.length})`);
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}
console.log(`\nGATE QUARTER: PASS (${SEEDS.length} hanyang 시드, 부속채 ${total}채 >= ${TOTAL_FLOOR},`
  + ` 남문 ${southTotal} >= ${SOUTH_FLOOR}, 북문 0, 이격·마당·예약·필지·시전·논·도로·개천 무침범)`);
