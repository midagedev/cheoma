// 시전 행랑이 성문에 닿는가 — 도성 간선 파사드 커버리지 계약 (순수 노드, 미등록 게이트).
//
// 왜 이 게이트가 필요한가 (실측 2026-08-04, #54):
//   ① `SIJEON_PLACEMENT.runCap` 이 (도로,면)당 **프리픽스** 캡이라, 도성 전체 행랑 51레코드가
//      전부 종로 서단 151m(도로 길이의 22.1%)에 몰렸다. 나머지 세 성문 접근로에는 행랑이
//      원리적으로 나올 수 없었다.
//   ② 남대문로(T→숭례문)가 `jungno` 로 저작돼 있었다. `planSijeon` 은 `daero` 만 보므로
//      히어로 남문 접근로는 행랑 후보에서 아예 빠졌다.
//   ③ 문전 마당(필지·시전 배제)이 통행 예약 47m 를 그대로 써서 문 안쪽 51.25m 가 비었다.
// docs/joseon-city.md §시전행랑("종루~남대문, 종묘~동대문")·§성문 주변("행랑은 성문에 닿는 간선
//   파사드를 따라")·규칙 7("간선 양측 파사드를 따라 연속 배치")이 단언하는 조항이므로 계약이다.
//
// usage: node tools/check-sijeon-approach.mjs [--report-only]
import { createHash } from 'node:crypto';

import * as G from '../src/core/math/geom2.js';
import { planVillage, GATE_FORECOURT_PLAN_DEPTH } from '../src/village/plan.js';
import { ROAD_WIDTH } from '../src/village/roads.js';
import {
  CITY_WALL_DIMENSIONS,
  cityGateForecourtPolygon,
  cityWallContainsPolygon,
} from '../src/village/citywall-contour.js';
import { SIJEON_PLACEMENT, isSijeonShop } from '../src/village/sijeon-plan.js';

const reportOnly = process.argv.includes('--report-only');
const SEEDS = [20260716, 2026, 7, 99];

// 행랑 첫 칸이 육축에서 얼마나 떨어질 수 있는가. 배치 격자가 pitch(6.2m) 양자화라 첫 칸은 마당
// 경계 **다음 한 칸** 안에 반드시 들어온다 — 그게 여기서 단언할 수 있는 상한이다(저작값 아님).
// 제품 판정선인 "문 앞 15m 급"은 대역 스윕의 평균으로 확인했고(실측 2026-08-04: 12m→13.93,
// 14m→15.37, 16m→17.61, 18m→19.31 / 4시드 × 접근로 3문), 채택 깊이 14m 의 근거다.
const GATE_REACH_LIMIT = GATE_FORECOURT_PLAN_DEPTH + SIJEON_PLACEMENT.pitch;
// 반대쪽 하한: 행랑이 육축에 붙지 못한다(사용자 결정 대역의 하한 = 12m). 깊이 12m 를 기각한 근거도
// 이 선이다 — 실측 최근접이 11.87m 로 대역 밖으로 나갔다.
const GATE_REACH_FLOOR = 12;
// 간선 파사드 커버리지 하한(레코드 / 가용 슬롯). 실측 90.7~100% 에 15%p 여유.
// 수정 전 소스는 22.1%(종로 서단 프리픽스만) 라 이 하한이 정확히 그 회귀를 잡는다.
const COVERAGE_FLOOR = 0.75;

const errors = [];
const reachSamples = [];
const fail = (message) => errors.push(message);
const r2 = (value) => (Number.isFinite(value) ? +value.toFixed(2) : value);

function gateLocal(gate, point) {
  const length = Math.hypot(gate.dirX, gate.dirZ) || 1;
  const ux = gate.dirX / length, uz = gate.dirZ / length;
  const dx = point.x - gate.x, dz = point.z - gate.z;
  return { u: -(dx * ux + dz * uz), v: dx * -uz + dz * ux };
}

// 육축 안쪽 면(= 문전 마당이 시작하는 면)까지의 거리. gate.z 는 육축 중심이므로 depth/2 를 뺀다.
const masonryFaceU = (gate) => CITY_WALL_DIMENSIONS.gateDepth * (gate.scale || 1) * 0.5;

function nearestAlongAxis(gate, polys, half = 30) {
  let best = null;
  for (const entry of polys) {
    for (const point of entry.poly || []) {
      const local = gateLocal(gate, point);
      if (local.u <= 0 || Math.abs(local.v) > half) continue;
      if (!best || local.u < best.u) best = { u: local.u, v: local.v, id: entry.id };
    }
  }
  if (!best) return null;
  return { ...best, fromMasonry: best.u - masonryFaceU(gate) };
}

// planSijeon 과 같은 샘플 격자에서 "가용 슬롯"을 센다: reach(성벽 안쪽 + 문전 마당 밖) 를 통과하는
// 중심선 샘플 × 좌우 2면. 교차 간선 클리어런스로 빠지는 슬롯은 설계상 빈 자리이므로 분모에 남긴다.
function arterialCoverage(plan, road) {
  const cityWall = plan.features.cityWall;
  const forecourts = cityWall
    ? cityWall.gates.map((gate) => cityGateForecourtPolygon(gate, { length: GATE_FORECOURT_PLAN_DEPTH }))
    : [];
  const fine = G.resample(road.pts, SIJEON_PLACEMENT.pitch);
  let eligible = 0;
  for (let i = 3; i < fine.length - 3; i++) {
    const point = fine[i].pt;
    const inside = !cityWall || (cityWall && G.dist(point, plan.site.center) < Infinity
      && cityWallContainsPolygon(cityWall, [point], 8));
    if (!inside) continue;
    if (forecourts.some((poly) => G.pointInPoly(point, poly))) continue;
    eligible++;
  }
  const own = (plan.features.sijeon || []).filter((record) => {
    let best = null;
    for (const candidate of plan.roads.filter((r) => r.level === 'daero')) {
      const distance = G.distToPolyline(record.center, candidate.pts).d;
      if (!best || distance < best.distance) best = { distance, id: candidate.id };
    }
    return best?.id === road.id;
  });
  const shops = own.filter(isSijeonShop).length;
  const slots = eligible * 2;
  return {
    id: road.id,
    length: G.polylineLength ? G.polylineLength(road.pts) : null,
    eligible,
    slots,
    records: own.length,
    shops,
    coverage: slots ? own.length / slots : 0,
    shopCoverage: slots ? shops / slots : 0,
  };
}

function onAxisArterials(plan, gate) {
  return plan.roads.filter((road) => road.level === 'daero' && (road.pts || []).some((point) => {
    const local = gateLocal(gate, point);
    return local.u > -6 && local.u < 160 && Math.abs(local.v) <= 18;
  }));
}

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

console.log(`sijeon approach: forecourt plan depth = ${GATE_FORECOURT_PLAN_DEPTH}m`
  + `  (통행 예약 ${CITY_WALL_DIMENSIONS.gateApproachLength + CITY_WALL_DIMENSIONS.gateApproachClearance}m 유지)`);

for (const seed of SEEDS) {
  const plan = planVillage({ scale: 'hanyang', seed, includePalace: true, includeTemple: true });
  const cityWall = plan.features.cityWall;
  if (!cityWall?.gates?.length) { fail(`hanyang/${seed}: no city wall gates`); continue; }
  const sijeon = plan.features.sijeon || [];
  const shops = sijeon.filter(isSijeonShop);
  // 재현성은 계약 실행에서만 확인한다(리포트 모드는 대역 스윕용이라 계획을 두 번 짓지 않는다).
  if (!reportOnly) {
    const repeat = planVillage({ scale: 'hanyang', seed, includePalace: true, includeTemple: true });
    if (hash(sijeon) !== hash(repeat.features.sijeon || [])) {
      fail(`hanyang/${seed}: sijeon placement is not reproducible`);
    }
  }

  console.log(`\n== hanyang/${seed}  daero=${plan.roads.filter((r) => r.level === 'daero').length}`
    + `  records=${sijeon.length} shops=${shops.length} parcels=${plan.parcels.length} ==`);

  // 남대문로 등급: 남문 축 위의 간선이 daero 이고 폭이 대로 폭이어야 한다(슬라이스 C).
  const southGate = cityWall.gates.find((gate) => gate.name === 'south');
  if (!southGate) fail(`hanyang/${seed}: no south gate`);
  else {
    const southArterials = onAxisArterials(plan, southGate);
    if (!southArterials.length) {
      fail(`hanyang/${seed}: 남대문로가 daero 가 아니다 — 남문 축에 간선 없음`);
    } else if (!southArterials.some((road) => Math.abs(road.width - ROAD_WIDTH.daero) < 1e-9)) {
      fail(`hanyang/${seed}: 남문 축 간선 폭 ${southArterials.map((r) => r.width).join(',')} != ${ROAD_WIDTH.daero}`);
    }
  }

  for (const gate of cityWall.gates) {
    const nearShop = nearestAlongAxis(gate, shops);
    const nearParcel = nearestAlongAxis(gate, plan.parcels);
    const arterials = onAxisArterials(plan, gate);
    console.log(`  ${gate.name.padEnd(6)} arterial=${arterials.map((r) => `${r.id}/${r2(r.width)}`).join(',') || '없음'}`
      + `  최근접 행랑 ${nearShop ? `${r2(nearShop.fromMasonry)}m(육축 기준)` : '없음'}`
      + `  최근접 필지 ${nearParcel ? `${r2(nearParcel.fromMasonry)}m` : '없음'}`);

    if (!arterials.length) {
      // 숙정문(북)은 북악 고지라 접근로를 의도적으로 생략했다(roads.js hanyang 분기 주석).
      // 그 설계가 바뀌면 이 면제가 조용히 삼키지 않도록 여기서 못박는다.
      if (gate.name !== 'north') {
        fail(`hanyang/${seed} ${gate.name}: 성문 접근 간선이 사라졌다`);
      }
      continue;
    }
    if (!nearShop) {
      fail(`hanyang/${seed} ${gate.name}: 접근 간선에 행랑이 하나도 없다`);
      continue;
    }
    reachSamples.push(nearShop.fromMasonry);
    if (nearShop.fromMasonry > GATE_REACH_LIMIT) {
      fail(`hanyang/${seed} ${gate.name}: 행랑 첫 칸이 육축 ${r2(nearShop.fromMasonry)}m 앞에서 끊긴다`
        + ` (상한 ${r2(GATE_REACH_LIMIT)}m = 마당 ${GATE_FORECOURT_PLAN_DEPTH} + pitch ${SIJEON_PLACEMENT.pitch})`);
    }
    if (nearShop.fromMasonry < GATE_REACH_FLOOR) {
      fail(`hanyang/${seed} ${gate.name}: 행랑이 육축 ${r2(nearShop.fromMasonry)}m 까지 붙었다`
        + ` (하한 ${GATE_REACH_FLOOR}m — 문전 마당이 사라짐)`);
    }
  }

  for (const road of plan.roads.filter((r) => r.level === 'daero')) {
    const row = arterialCoverage(plan, road);
    if (row.slots === 0) continue;
    console.log(`  ${row.id}  가용슬롯 ${row.slots}  레코드 ${row.records} (점포 ${row.shops})`
      + `  커버리지 ${(row.coverage * 100).toFixed(1)}% / 점포만 ${(row.shopCoverage * 100).toFixed(1)}%`);
    // 주작대로(궁 정문 광장 축선)는 상업 가로가 아니므로 커버리지 계약에서 제외한다.
    const isPalaceAxis = row.records === 0 && row.slots < 12;
    if (!isPalaceAxis && row.coverage < COVERAGE_FLOOR) {
      fail(`hanyang/${seed} ${row.id}: 간선 파사드 커버리지 ${(row.coverage * 100).toFixed(1)}%`
        + ` < ${COVERAGE_FLOOR * 100}% — 행랑이 도로 일부만 채운다`);
    }
  }

  // 행랑 mass 자체는 legacy 치수를 그대로 쓴다(점포당 삼각형 예산 불변) + 성벽 안쪽·마당 밖.
  const forecourts = cityWall.gates.map((gate) => cityGateForecourtPolygon(gate,
    { length: GATE_FORECOURT_PLAN_DEPTH }));
  for (const record of sijeon) {
    if (record.w !== SIJEON_PLACEMENT.pitch || record.d !== SIJEON_PLACEMENT.depth) {
      fail(`hanyang/${seed} ${record.id}: 점포 치수 ${record.w}x${record.d} 가 legacy 값에서 벗어났다`);
      break;
    }
    if (!cityWallContainsPolygon(cityWall, record.poly, 4)) {
      fail(`hanyang/${seed} ${record.id}: 행랑 footprint 가 성벽을 넘었다`);
      break;
    }
    if (forecourts.some((poly) => G.polysOverlap(record.poly, poly))) {
      fail(`hanyang/${seed} ${record.id}: 행랑 footprint 가 문전 마당을 침범했다`);
      break;
    }
  }
}

if (reportOnly) {
  console.log(`\nsijeon approach REPORT ONLY — ${errors.length} would-be failures`);
  for (const error of errors) console.log(`  - ${error}`);
  process.exit(0);
}

if (errors.length) {
  console.error(`\nSIJEON APPROACH: FAIL (${errors.length})`);
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}
const reachMean = reachSamples.reduce((a, b) => a + b, 0) / (reachSamples.length || 1);
console.log(`\nSIJEON APPROACH: PASS (${SEEDS.length} hanyang seeds, forecourt ${GATE_FORECOURT_PLAN_DEPTH}m,`
  + ` 행랑 도달 ${r2(Math.min(...reachSamples))}~${r2(Math.max(...reachSamples))}m mean ${r2(reachMean)}m`
  + ` [${GATE_REACH_FLOOR}~${r2(GATE_REACH_LIMIT)}m], 커버리지 >= ${COVERAGE_FLOOR * 100}%)`);
