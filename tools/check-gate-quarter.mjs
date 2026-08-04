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

const errors = [];
const fail = (message) => errors.push(message);
const r2 = (value) => (Number.isFinite(value) ? +value.toFixed(2) : value);
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);

function planHanyang(seed) {
  return planVillage({ scale: 'hanyang', seed, includePalace: true, includeTemple: true });
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
    return { errors: local, records: [], south: 0 };
  }
  const band = plan.features?.gateQuarter;
  if (!band) {
    note('성벽 안면 부속 밴드(features.gateQuarter)가 아예 없다');
    return { errors: local, records: [], south: 0 };
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

  const south = records.filter((record) => record.gate === 'south').length;
  if (verbose) {
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
  return { errors: local, records, south };
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
  let caught = 0;
  for (const kind of ['no-band', 'crowd-wall', 'forecourt']) {
    const result = checkSeed(injectFault(plan, kind), `FAULT/${kind}`, { verbose: false });
    if (result.errors.length) {
      caught++;
      console.log(`\n  ${kind.padEnd(12)} → ${result.errors.length} FAIL (기대대로)`);
      for (const error of result.errors.slice(0, 3)) console.log(`      - ${error}`);
    } else {
      console.log(`\n  ${kind.padEnd(12)} → 0 FAIL — 게이트가 이 결함을 못 잡는다`);
    }
  }
  const clean = checkSeed(plan, 'CLEAN', { verbose: false });
  console.log(`\n  clean        → ${clean.errors.length} FAIL (0 이어야 한다)`);
  if (caught !== 3 || clean.errors.length !== 0) {
    console.error('\nGATE QUARTER FAIL-FIRST: 검증 실패 — 게이트를 신뢰할 수 없다');
    process.exit(1);
  }
  console.log('\nGATE QUARTER FAIL-FIRST: PASS (구현 전 형상 + 대표 위반 2종 모두 잡힘, 정상 소스는 0)');
  process.exit(0);
}

let total = 0;
let southTotal = 0;
for (const seed of SEEDS) {
  const plan = planHanyang(seed);
  const result = checkSeed(plan, `hanyang/${seed}`);
  for (const error of result.errors) fail(error);
  total += result.records.length;
  southTotal += result.south;

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

console.log(`\n합계: 부속채 ${total}채 (남문 ${southTotal}채) / ${SEEDS.length} 시드`);

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
