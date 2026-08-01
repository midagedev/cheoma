// 개천(開川) 계약 — #20 R4 Phase A. 도성 관류 · 종로 불침범 · 수문(오간수문).
// DOM/THREE 없이 순수 plan 만으로 판정한다(브라우저 게이트는 성곽 형상 캡처가 별도로 소유).
//
// 세 절이 각각 결함 하나에 대응한다:
//   1) 관류   — 개천 중심선이 성벽 안을 **연속으로** 지난다(교차 2회, 내부 런·내부 깊이 하한).
//               구 규칙 위반(streamZ = 0.30R)에서는 개천이 성벽 밖을 평행하게 흘러 실패한다.
//   2) 종로   — 개천 하도가 동서 간선(종로) 리본을 침범하지 않는다. 청계천은 종로 남쪽이다.
//   3) 수문   — 개천이 성벽을 지나는 **모든** 지점에 홍예 5개 수문이 있고, 그 자리는 사대문
//               개구부와 겹치지 않는다(오간수문은 흥인지문·광희문 사이의 별개 시설이었다).
import { performance } from 'node:perf_hooks';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import * as G from '../src/core/math/geom2.js';
import { planVillage } from '../src/api/village-plan.js';
import {
  CITY_WALL_DIMENSIONS,
  CITY_WATER_GATE,
  cityWallAngleInAperture,
  cityWallAngleInGate,
  cityWallAngleInWaterGate,
  cityWallClearance,
  cityWaterGateProfile,
  planCityWaterGates,
  pointOnCityWall,
  sampleCityWallSegments,
} from '../src/village/citywall-contour.js';
import { terrainMeshHeightAt, streamSurfaceHeightAt } from '../src/village/terrain-grid.js';
import {
  BRIDGE_SLAB_BAY,
  CREEK_APPROACH_LEVEL,
  CREEK_APPROACH_REACH,
  bridgeDeckPlacement,
  creekCrossingSpanHalf,
} from '../src/village/stream-spatial.js';
import { planCreekBanks, CREEK_BANK_LIMITS } from '../src/api/creek-bank-plan.js';

const TAU = Math.PI * 2;
// 회귀 픽스처: 2026·7·99 = 기존 계약이 쓰는 정본 시드, 777 = ratio 0.22 에서 관류가 0m 로
//   붕괴했던 시드, 55 = 개천이 성벽에 접선으로 붙던 시드, 4242 = 통과부 사교계수 최솟값 시드,
//   1 = 종로 여유 최솟값 시드(ratio 를 0.12 로 내리면 이 시드가 먼저 종로를 침범한다).
const SEEDS = [2026, 7, 99, 777, 55, 4242, 1];

// ── 실측 근거로 고정한 하한 ─────────────────────────────────────────────────
// 2026-07-31 seed 10개 스윕(게이트는 그 중 회귀 픽스처 6개를 상주시킨다)(ratio 0.16 · 도성 개천 사행 0.5): 내부 런 390~568m,
//   최대 내부 깊이 33~135m, 종로 여유 28~81m, 통과부 사교계수 0.31~0.91.
// 구 소스(0.30R)의 같은 측정: 내부 런 94~287m, 수문 0기. 하한은 그 사이에 둔다.
const CREEK_MIN_INSIDE_RUN = 300;      // m — 도성을 실제로 관류했다고 볼 수 있는 최소 내부 런
const CREEK_MIN_INSIDE_DEPTH = 25;     // m — 성벽에 붙어 흐르는 것과 구별하는 최소 내부 깊이
const CREEK_MIN_JONGNO_GAP = 4;        // m — 하도 물가와 종로 리본 사이 최소 여유
const CREEK_MIN_COS_NORMAL = 0.24;     // 통과부 사교 하한(이 아래는 수문이 교량으로 폭주한다)
const CREEK_MAX_WATER_GATES = 3;       // 한 도성의 수문 수 상한(관류가 깨진 시드의 조기 경보)

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

// 성벽 안을 지나는 개천 중심선의 연속 런·교차 횟수·최대 내부 깊이. 해석 근사가 아니라 렌더러가
// 소비하는 같은 streamZat 중심선을 촘촘히 훑는다.
function creekInsideProfile(site, wall, steps = 3000) {
  const pts = site.stream.pts;
  const x0 = pts[0].x, x1 = pts[pts.length - 1].x;
  let crossings = 0, maxDepth = -Infinity, longestRun = 0, run = 0;
  let prevInside = null, prevX = null, prevZ = null;
  let entry = null, exit = null;
  for (let i = 0; i <= steps; i++) {
    const x = x0 + (x1 - x0) * i / steps;
    const z = site.streamZat(x);
    const clearance = cityWallClearance(wall, { x, z });
    const inside = clearance > 0;
    maxDepth = Math.max(maxDepth, clearance);
    if (prevInside !== null && inside !== prevInside) crossings++;
    if (inside) {
      if (!entry) entry = { x, z };
      exit = { x, z };
      if (prevInside) run += Math.hypot(x - prevX, z - prevZ);
    } else {
      longestRun = Math.max(longestRun, run);
      run = 0;
    }
    prevInside = inside; prevX = x; prevZ = z;
  }
  longestRun = Math.max(longestRun, run);
  return { crossings, maxDepth, longestRun, entry, exit };
}

// 종로 리본과 개천 하도(streamHalf) 사이 최소 여유. 종로는 성곽 spec 이 자기 축(axes.jongnoZ)으로
// 들고 있는 동서 간선이다 — 남북 간선(육조거리)이 개천을 건너는 것은 다리이므로 대상이 아니고,
// 남촌 이면도로처럼 개천 남쪽에 있는 길도 이 계약의 대상이 아니다.
const JONGNO_AXIS_BAND = 30;   // m — 성문 정렬 굽이를 포함한 종로 축 대역
function jongnoGap(plan, site, wall) {
  const axisZ = wall.axes.jongnoZ;
  let gap = Infinity;
  for (const road of plan.roads) {
    if (road.level !== 'daero') continue;
    for (let i = 1; i < road.pts.length; i++) {
      const a = road.pts[i - 1], b = road.pts[i];
      if (Math.abs(b.z - a.z) > Math.abs(b.x - a.x)) continue;   // 남북 축 = 다리 후보
      for (const point of [a, b]) {
        if (Math.abs(point.z - axisZ) > JONGNO_AXIS_BAND) continue;
        const northBank = site.streamZat(point.x) - site.streamHalf;
        gap = Math.min(gap, northBank - (point.z + road.width * 0.5));
      }
    }
  }
  return gap;
}

const rows = [];
const started = performance.now();

for (const seed of SEEDS) {
  const plan = planVillage({ scale: 'hanyang', seed, includePalace: true, includeTemple: true });
  const site = plan.site;
  const wall = plan.features?.cityWall;
  const label = `hanyang/${seed}`;
  invariant(wall?.gates?.length === 4, `${label}: 사대문이 4기가 아니다`);
  invariant(site.stream, `${label}: 도성에 개천이 없다`);

  // ── 1) 도성 관류 ──────────────────────────────────────────────────────────
  const creek = creekInsideProfile(site, wall);
  invariant(creek.crossings === 2,
    `${label}: 개천이 성벽을 ${creek.crossings}회 지난다 — 관류는 들어가고 나오는 2회여야 한다`);
  invariant(creek.longestRun >= CREEK_MIN_INSIDE_RUN,
    `${label}: 성 안 개천 런 ${creek.longestRun.toFixed(0)}m < ${CREEK_MIN_INSIDE_RUN}m — 도성을 관류하지 않는다`);
  invariant(creek.maxDepth >= CREEK_MIN_INSIDE_DEPTH,
    `${label}: 개천 최대 내부 깊이 ${creek.maxDepth.toFixed(0)}m < ${CREEK_MIN_INSIDE_DEPTH}m — 성벽을 따라 흐른다`);

  // ── 2) 종로 불침범 ────────────────────────────────────────────────────────
  // 이 절의 이(teeth)는 비율 자체가 아니라 **종로의 개천 회피 기제**에 걸려 있다. 비율만 내려도
  //   bestJongnoGates 의 streamDeficit 항이 종로를 북으로 물려 침범이 일어나지 않는다(FAIL-first
  //   확인 2026-07-31: ratio 0.12 단독 → PASS). 그 항을 지우고 ratio 0.12 를 주면 이 단언이
  //   −23.8m 로 실패한다 — 즉 이 절은 그 기제가 사라지는 회귀를 잡는다.
  const gap = jongnoGap(plan, site, wall);
  invariant(gap >= CREEK_MIN_JONGNO_GAP,
    `${label}: 개천 하도가 동서 간선(종로) 리본과 ${gap.toFixed(1)}m — 청계천은 종로 남쪽이다`);

  // ── 3) 수문 ───────────────────────────────────────────────────────────────
  const waterGates = wall.waterGates || [];
  // 도성 반경에서는 과대 통과부 생략(spanPerimeterK)이 절대 발동하지 않아야 한다 — 발동하면
  //   물이 성벽 아래로 지나가고 수문 수가 교차 수보다 적어져 아래 단언이 잡는다.
  invariant(waterGates.every((wg) => wg.span
    <= Math.max(CITY_WATER_GATE.minSpan, wall.meanRadius * CITY_WATER_GATE.spanPerimeterK)),
  `${label}: 수문 폭이 성벽 둘레 상한을 넘었다`);
  invariant(waterGates.length === creek.crossings,
    `${label}: 성벽 통과 ${creek.crossings}회인데 수문 ${waterGates.length}기 — 물이 성벽을 그냥 지난다`);
  invariant(waterGates.length <= CREEK_MAX_WATER_GATES,
    `${label}: 수문 ${waterGates.length}기 — 관류가 접선으로 흩어졌다`);
  // 계획은 순수 재현이어야 한다(렌더러와 검증이 같은 값을 본다).
  const replan = planCityWaterGates(wall, site);
  invariant(JSON.stringify(replan) === JSON.stringify(waterGates),
    `${label}: planCityWaterGates 가 재현되지 않는다`);

  for (const waterGate of waterGates) {
    const tag = `${label}/${waterGate.name}`;
    const profile = cityWaterGateProfile(waterGate);
    invariant(waterGate.arches === CITY_WATER_GATE.arches && profile.openings.length === 5,
      `${tag}: 홍예가 5개가 아니다(1422년 오간수문 실증값)`);
    invariant(profile.piers.length === 4 && profile.shoulders.length === 2,
      `${tag}: 홍예 사이 돌기둥 4 + 어깨 2 구성이 아니다`);

    // (a) 수문은 성벽 **현(弦)** 위에 있고 개천이 실제로 지나는 자리다. 석축 양 끝이 성벽 선에
    //     물리고 중심은 새그만큼만 안으로 물러난다(접선 배치의 "덧댄 판" 회귀를 잡는다).
    const tangent0 = { x: waterGate.dirZ, z: -waterGate.dirX };
    for (const side of [-1, 1]) {
      const end = {
        x: waterGate.x + tangent0.x * side * waterGate.span * 0.5,
        z: waterGate.z + tangent0.z * side * waterGate.span * 0.5,
      };
      invariant(Math.abs(cityWallClearance(wall, end)) <= 0.05,
        `${tag}: 석축 ${side < 0 ? '좌' : '우'} 끝이 성벽 선에서 ${cityWallClearance(wall, end).toFixed(2)}m 벗어났다`);
    }
    const centerClearance = cityWallClearance(wall, waterGate);
    // 오목한 성벽 구간에서는 현의 중심이 호 **밖**으로 나간다(부정형 contour 의 필연 — 양 끝을
    //   성벽 선에 물리면 중간은 반대쪽으로 벌어진다). 양방향 같은 폭 비례 상한으로 잡는다.
    invariant(Math.abs(centerClearance) <= waterGate.span * 0.08 + 0.2,
      `${tag}: 석축 중심 여유 ${centerClearance.toFixed(2)}m 가 폭 비례 상한 밖이다`);
    invariant(Math.abs(waterGate.depth - CITY_WALL_DIMENSIONS.thickness) <= 1e-9,
      `${tag}: 석축 두께가 성벽 두께와 다르다 — 벽면 앞으로 튀어나온 판이 된다`);
    invariant(Math.abs(Math.hypot(waterGate.dirX, waterGate.dirZ) - 1) <= 1e-9,
      `${tag}: 법선이 단위벡터가 아니다`);
    // 현 중심은 호보다 안으로 물러난다(정상). 부정형 contour 에서는 이상적 새그보다 커질 수 있어
    //   폭 비례 상한으로만 잡는다 — 이음 보증은 위의 "양 끝이 성벽 선" 단언이 담당한다(실측 0.06~2.03m).
    invariant(waterGate.inset <= waterGate.span * 0.08 + 0.2,
      `${tag}: 현 중심 후퇴 ${waterGate.inset.toFixed(2)}m 가 폭 비례 상한을 넘는다`);
    // 사대문 회피가 발동하면 drift 는 **미터 단위**로 커진다. 0.15m 하한은 현 배치의 수치 잔차
    //   (angle±half 의 국소 선형화 speed 로 만든 현의 중심이 반경선에서 ~0.02m 벗어남)만 허용한다.
    // 사대문 회피가 발동하면 drift 는 **수십 m**다(성문 개구부 반각 + 석축 반폭 + 여유). 2m 상한은
    //   부정형 contour 위에 직선 석축을 현으로 앉힐 때의 기하 잔차(실측 0.00~0.53m)만 허용한다.
    invariant(waterGate.drift <= 2,
      `${tag}: 수문이 실제 통과점에서 성벽을 따라 ${waterGate.drift.toFixed(2)}m 밀려났다`);
    invariant(waterGate.cosNormal >= CREEK_MIN_COS_NORMAL,
      `${tag}: 통과부 사교계수 ${waterGate.cosNormal.toFixed(2)} < ${CREEK_MIN_COS_NORMAL} — 수문이 교량으로 폭주한다`);

    // (b) 사대문과 별개 시설: 개구부가 겹치지 않고 중심 간 거리도 두 개구부 반폭보다 크다.
    invariant(cityWallAngleInWaterGate(wall, waterGate.angle),
      `${tag}: 수문 개구부가 자기 중심을 담지 않는다`);
    invariant(!cityWallAngleInGate(wall, waterGate.angle),
      `${tag}: 수문이 사대문 개구부 안에 있다 — 오간수문은 별개 시설이다`);
    for (const side of [-1, 1]) {
      const edge = waterGate.angle + side * waterGate.halfAngle;
      invariant(!cityWallAngleInGate(wall, edge),
        `${tag}: 수문 개구부 끝이 사대문 개구부와 겹친다`);
    }
    for (const gate of wall.gates) {
      const separation = G.dist(gate, waterGate);
      invariant(separation >= gate.width * 0.5 + waterGate.span * 0.5,
        `${tag}: ${gate.name} 성문과 ${separation.toFixed(0)}m — 두 시설이 한자리에 겹친다`);
    }

    // (c) 물이 실제로 지나간다: 홍예 열이 저수로 현을 덮고, 문턱은 물 아래·이맛돌은 물 위다.
    invariant(profile.openingTotal >= waterGate.waterChord - 1e-9,
      `${tag}: 홍예 열 ${profile.openingTotal.toFixed(1)}m < 저수로 현 ${waterGate.waterChord.toFixed(1)}m — 물이 석축 밑으로 사라진다`);
    invariant(profile.submergence > 0.05,
      `${tag}: 문턱이 수면 위다(submergence ${profile.submergence.toFixed(2)}m)`);
    invariant(profile.waterClearance >= 0.3,
      `${tag}: 이맛돌 아래 여유 ${profile.waterClearance.toFixed(2)}m — 홍예가 물에 잠긴다`);
    invariant(profile.crownY + CITY_WATER_GATE.crownHeadroom <= profile.topY + 1e-9,
      `${tag}: 이맛돌 위 스팬드럴이 ${(profile.topY - profile.crownY).toFixed(2)}m 뿐이다`);
    invariant(profile.archWidth >= CITY_WATER_GATE.minArchWidth - 1e-9,
      `${tag}: 홍예 폭 ${profile.archWidth.toFixed(2)}m 가 하한 미달`);
    // 기석은 문턱보다 높아야 반원이 온전히 드러난다(홍예가 얕은 스캘럽으로 읽히던 회귀).
    invariant(profile.springY > profile.sillY + 0.2,
      `${tag}: 기석이 문턱에 붙어 홍예 아래 절반이 잠긴다`);
    invariant(Math.abs(profile.jamb.height - (profile.springY - profile.sillY)) <= 1e-9
      && profile.jamb.y0 === profile.sillY && profile.jamb.y1 === profile.springY,
    `${tag}: 문협(jamb) 구간이 문턱~기석과 어긋난다`);
    invariant(profile.crownY - profile.springY > profile.springY - profile.sillY,
      `${tag}: 홍예 높이가 문협보다 낮다 — 아치가 아니라 문틀이다`);
    // 반원 홍예: 반지름 = 폭/2, 이맛돌은 정확히 정점.
    invariant(Math.abs(profile.radius - profile.archWidth * 0.5) <= 1e-9,
      `${tag}: 홍예가 반원이 아니다`);
    for (const opening of profile.openings) {
      const crown = opening.intrados[CITY_WATER_GATE.archSegments / 2];
      invariant(Math.abs(crown.x - opening.centerX) <= 1e-9
        && Math.abs(crown.y - profile.crownY) <= 1e-9,
      `${tag}: 이맛돌이 홍예 정점에 없다`);
      const width = opening.x1 - opening.x0;
      invariant(Math.abs(width - profile.archWidth) <= 1e-9, `${tag}: 홍예 폭이 균일하지 않다`);
      invariant(opening.x0 >= -profile.span * 0.5 - 1e-9 && opening.x1 <= profile.span * 0.5 + 1e-9,
        `${tag}: 홍예가 석축 밖으로 나갔다`);
    }
    // (c-2) 홍예 열이 하상 평탄면 안에 든다(바깥 홍예가 둑에 박히지 않는다) — 비전 판정 회귀.
    const tangent = { x: waterGate.dirZ, z: -waterGate.dirX };
    const archEdgeY = [-1, 1].map((side) => {
      const localX = side * (profile.span * 0.5 - profile.abutment);
      return terrainMeshHeightAt(site,
        waterGate.x + tangent.x * localX, waterGate.z + tangent.z * localX);
    });
    // 물리 기준: 둑이 기석선보다 높으면 바깥 홍예의 발이 흙에 묻힌다(기석 아래는 수직 문협).
    for (const [i, y] of archEdgeY.entries()) {
      invariant(y <= profile.springY + CITY_WATER_GATE.archBankMargin,
        `${tag}: 홍예 열 ${i ? '우' : '좌'} 끝 둑이 기석선보다 ${(y - profile.springY).toFixed(2)}m 높다 — 홍예 발이 묻힌다`);
    }
    invariant(Math.abs(profile.halfDepth - waterGate.depth * 0.5) <= 1e-9,
      `${tag}: profile 두께가 배치 두께와 다르다`);

    // 석축은 지반 아래에서 시작해 성벽 상면 규칙과 같은 높이로 끝난다.
    const groundTop = waterGate.terrain.max
      + (CITY_WALL_DIMENSIONS.bodyHeight - CITY_WALL_DIMENSIONS.foundationSink);
    invariant(Math.abs(profile.topY - groundTop) <= 1e-9,
      `${tag}: 수문 상면이 인접 성벽 상면 규칙과 다르다`);
    invariant(profile.bottomY < waterGate.terrain.min,
      `${tag}: 석축 바닥이 지반 위에 떠 있다`);
    // 지반·수면은 렌더 지형 계약에서 온 값이어야 한다(해석 heightAt 재계산 금지).
    invariant(waterGate.terrain.min <= terrainMeshHeightAt(site, waterGate.x, waterGate.z) + 1e-9,
      `${tag}: 지반 최저값이 렌더 지형 표본보다 높다`);
    invariant(Math.abs(waterGate.waterY
      - streamSurfaceHeightAt(site, waterGate.creek.x, waterGate.creek.z)) <= 1e-9,
    `${tag}: 수면 높이가 공유 수면 계약과 다르다`);

    // (d) 성벽 리본은 이 자리에서 비어 있어야 한다 — 아니면 석축과 리본이 이중으로 선다.
    invariant(cityWallAngleInAperture(wall, waterGate.angle),
      `${tag}: 성벽 리본이 수문 자리를 그대로 지나간다`);
  }

  // 성벽 세그먼트가 수문 개구부를 실제로 비웠는지(렌더 리본 기준).
  const segments = sampleCityWallSegments(wall, site);
  for (const segment of segments) {
    const mid = (segment.angle0 + segment.angle1) * 0.5;
    invariant(!cityWallAngleInWaterGate(wall, mid),
      `${label}: 성벽 세그먼트가 수문 개구부 안에 남아 있다`);
  }
  // 개구부 밖 성벽은 그대로 살아 있어야 한다(개구부가 성곽을 통째로 지우지 않는다).
  let solid = 0;
  for (let i = 0; i < 720; i++) {
    if (!cityWallAngleInAperture(wall, i / 720 * TAU)) solid++;
  }
  invariant(solid >= 720 * 0.82,
    `${label}: 성벽 실체 구간이 ${(solid / 720 * 100).toFixed(0)}% 로 줄었다`);

  rows.push({
    seed,
    run: Math.round(creek.longestRun),
    depth: Math.round(creek.maxDepth),
    jongno: Math.round(gap),
    gates: waterGates.length,
    span: waterGates.map((wg) => wg.span.toFixed(0)).join('/'),
    cosN: waterGates.map((wg) => wg.cosNormal.toFixed(2)).join('/'),
  });
}

// ── 다리 접지·접근 구배·평석교 구성 (Phase B) ────────────────────────────────
// 리드 전달 관찰(2026-08-01): "개천 위 판석이 비스듬히 기울어 지면을 파고든 것처럼 보인다".
//   실측 결과 널돌이 둑을 파고드는 것은 아니고, **데크 상면이 둑 지반보다 0.29~0.61m 높게 서 있고
//   그 다리가 벤치보다 1.2~2.5m 낮은 골짜기 안에 있다**(= 접근로가 골짜기로 내려갔다 올라온다).
//   Phase B 는 그 접근 구배를 다리 쪽에서 없앤다 — 데크가 양안 **벤치 높이**에서 하도를 건넌다.
// 이 절이 고정하는 것:
//   (a) 접지 envelope — 널돌이 지반에 묻히지도, 공중에 뜨지도 않는다(Phase A 계약 유지).
//   (b) 접근 수평 — 벤치 횡단이 성립하면 낮은 쪽 접근 노면이 데크 상면과 수평이다.
//       FAIL-first 실측(2026-08-01): Phase A 소스에서 이 값은 hanyang 8개 시드에서 +1.23~+2.84m
//       (길이 다리로 내려간다)라 이 단언이 실패한다. Phase B 는 −2.00~+0.05m.
//   (c) 평석교 구성 — 지간(널돌 한 켜가 건너는 길이)이 석재 한 장 규약 안에 있다. 교각 2기 고정은
//       45m 데크에서 지간 15m 짜리 통돌을 요구했다.
//   (d) 도성 개천의 다리는 예외 없이 평석교다(홍예 금지 — 고증).
const BRIDGE_DECK_ABOVE_MIN = 0.05;   // 상면이 접지면보다 이만큼은 위(묻힘 금지)
const BRIDGE_DECK_ABOVE_MAX = 1.0;    // 상면이 접지면보다 이 이상 뜨면 부유
const BRIDGE_BAY_TOLERANCE = 0.5;     // m — 지간이 규약보다 이 이상 길면 통돌이다
// 배치가 접지 최고점 위로 추가로 들어올릴 수 있는 몫. 실측(2026-08-01, 14 픽스처): 벤치 횡단 0.00m,
//   폴백 0.04~0.36m. 0.45m 는 그 위 여유이고, 둑 표본이 산 사면을 물어 데크를 들어올리는 회귀를 잡는다.
const BRIDGE_DECK_MAX_LIFT = 0.45;
const bridgeRows = [];
const approachRows = [];

// 다리를 지나는 도로의 실제 노면을 따라 데크 끝 밖까지 걸어간 지점의 지반 표고.
function approachGroundAlongRoad(plan, site, spec, reach) {
  let road = null, best = Infinity;
  for (const candidate of plan.roads) {
    for (const point of candidate.pts) {
      const distance = G.dist(point, spec);
      if (distance < best) { best = distance; road = candidate; }
    }
  }
  if (!road) return [];
  let anchor = 0, anchorD = Infinity;
  for (let i = 0; i < road.pts.length; i++) {
    const distance = G.dist(road.pts[i], spec);
    if (distance < anchorD) { anchorD = distance; anchor = i; }
  }
  const out = [];
  for (const direction of [-1, 1]) {
    let travelled = 0, index = anchor, cursor = { x: spec.x, z: spec.z };
    while (travelled < reach) {
      const next = road.pts[index + direction];
      if (!next) break;
      const step = G.dist(cursor, next);
      if (travelled + step >= reach) {
        const point = G.lerp(cursor, next, (reach - travelled) / Math.max(1e-6, step));
        out.push(terrainMeshHeightAt(site, point.x, point.z));
        break;
      }
      travelled += step; cursor = next; index += direction;
    }
  }
  return out;
}

for (const [scale, seed] of [
  ['hamlet', 11], ['village', 20260716], ['village', 2026],
  ['town', 5], ['capital', 7],
  ['hanyang', 2026], ['hanyang', 7], ['hanyang', 99], ['hanyang', 777],
  ['hanyang', 55], ['hanyang', 4242], ['hanyang', 1], ['hanyang', 20260716], ['hanyang', 11],
]) {
  const plan = planVillage({
    scale, seed,
    includePalace: scale === 'capital' || scale === 'hanyang',
  });
  const site = plan.site;
  const bridges = plan.features?.bridges || [];
  invariant(bridges.length >= 1, `${scale}/${seed}: 개울을 건너는 다리가 없다`);
  for (const spec of bridges) {
    const tag = `${scale}/${seed} ${spec.type || 'slab'}`;
    // (d) 도성 개천은 홍예교를 갖지 않는다 — 사진 판독·현존 사례가 전부 평석교다.
    if (site.stream.urban) {
      invariant(spec.type === 'slab',
        `${tag}: 도성 개천에 홍예교가 놓였다 — 개천의 다리는 평석교다`);
    }
    const placement = bridgeDeckPlacement(site, spec, {
      surfaceY: streamSurfaceHeightAt(site, spec.x, site.streamZat(spec.x)),
    });
    invariant(Number.isFinite(placement.deckY) && Number.isFinite(placement.deckTopY),
      `${tag}: 다리 접지가 유한하지 않다`);
    invariant(placement.deckY >= placement.waterY - 1e-9,
      `${tag}: 데크가 수면 아래다(${placement.deckY.toFixed(2)} < ${placement.waterY.toFixed(2)})`);
    // 데크는 직사각형이라 양 끝 지반 차(endSpread)만큼은 낮은 쪽이 반드시 뜬다 — 그 몫은 물리적으로
    //   피할 수 없다(실측 2026-08-01: hanyang/777 endSpread 0.77m → 낮은 끝 1.32m 부유가 최선).
    //   그래서 부유 판정은 두 축으로 나눈다: (i) 회피 불가한 endSpread 를 포함한 절대 상한,
    //   (ii) **배치가 추가로 들어올린 양**의 상한. (ii)가 실제 계약이다 — endSpread 가 큰 시드에서
    //   상한을 통째로 늘리는 대신, 배치가 접지 최고점 위로 얼마나 더 뜨는지를 직접 묶는다.
    const endSpread = Math.max(...placement.endGround) - Math.min(...placement.endGround);
    for (const [index, ground] of placement.endGround.entries()) {
      const above = placement.deckTopY - ground;
      invariant(above >= BRIDGE_DECK_ABOVE_MIN,
        `${tag}: 데크 ${index ? '우' : '좌'} 끝 상면이 지반보다 ${above.toFixed(2)}m — 널돌이 묻힌다`);
      invariant(above <= BRIDGE_DECK_ABOVE_MAX + endSpread,
        `${tag}: 데크 ${index ? '우' : '좌'} 끝 상면이 지반 위 ${above.toFixed(2)}m (끝 단차 ${endSpread.toFixed(2)}m) — 다리가 떠 있다`);
    }
    const lift = placement.contactY - Math.max(...placement.endGround);
    invariant(lift <= BRIDGE_DECK_MAX_LIFT,
      `${tag}: 접지 기준이 데크 최고 접지점보다 ${lift.toFixed(2)}m 위다 — 배치가 다리를 들어올렸다`);
    // 접지 표본에는 실제 데크 양 끝이 들어가야 한다(고정 오프셋만 보면 span 이 긴 시드에서 놓친다).
    invariant(placement.contactY >= Math.max(...placement.endGround) - 1e-9,
      `${tag}: 접지 기준이 데크 끝 지반을 놓쳤다`);
    // (c) 평석교 지간: 교각 수는 계약이 소유하고, 렌더러가 그 수를 소비한다.
    const bay = spec.span / (placement.piers + 1);
    invariant(placement.piers >= 2,
      `${tag}: 교각이 ${placement.piers}기 — 평석교는 교각 위에 멍엣돌을 건너지른다`);
    invariant(bay <= BRIDGE_SLAB_BAY + BRIDGE_BAY_TOLERANCE,
      `${tag}: 지간 ${bay.toFixed(2)}m 가 널돌 한 장 규약(${BRIDGE_SLAB_BAY}m)을 넘는다 — 통돌 다리다`);
    // 교각은 실제 하상까지 닿아야 한다(데크가 벤치까지 올라오면 교각도 길어진다).
    invariant(placement.bedY <= placement.deckY + 1e-9,
      `${tag}: 하상이 데크보다 높다(${placement.bedY.toFixed(2)} > ${placement.deckY.toFixed(2)})`);
    bridgeRows.push({ tag, above: placement.endGround.map((g) => placement.deckTopY - g), bay });

    // (b) 접근 수평 — 벤치 횡단이 성립한 개천 다리만. 벤치를 못 찾은 시드(개천이 산 사면·성벽에
    //     붙어 흐르는 경우)는 농촌 개울 규칙으로 폴백하며, 그 거동은 Phase A 와 바이트 동일이다.
    if (!site.stream.urban) continue;
    const bench = creekCrossingSpanHalf(site, spec.x);
    if (!bench.found) { approachRows.push({ tag, bench: false, rise: null }); continue; }
    const ground = approachGroundAlongRoad(plan, site, spec,
      spec.span * 0.5 + CREEK_APPROACH_REACH);
    invariant(ground.length >= 1, `${tag}: 접근 노면 표본을 뜨지 못했다`);
    const rise = Math.min(...ground) - placement.deckTopY;
    invariant(rise <= CREEK_APPROACH_LEVEL,
      `${tag}: 낮은 쪽 접근 노면이 데크 상면보다 ${rise.toFixed(2)}m 높다 — 길이 골짜기로 내려가 다리를 만난다`);
    approachRows.push({ tag, bench: true, rise });
  }
}

// ── 호안(護岸) 계획 (Phase B) ────────────────────────────────────────────────
// 세 급 위계(성벽·수문 가공석 > 도성 개천 호안 막돌 메쌓기 > 성 밖 자연석·토안)가 실제로 나뉘고,
//   호안 높이가 사진 판독 대역(1~1.5m)에 상한되며, 표고·수면이 전부 공유 지형·수면 계약에서 온다.
const bankRows = [];
for (const [scale, seed] of [
  ['hanyang', 2026], ['hanyang', 7], ['hanyang', 99], ['hanyang', 777],
  ['hanyang', 55], ['hanyang', 4242], ['hanyang', 1],
]) {
  const plan = planVillage({ scale, seed, includePalace: true });
  const site = plan.site;
  const banks = planCreekBanks(site);
  const label = `${scale}/${seed}`;
  invariant(banks.urban === true, `${label}: 도성 개천에 호안 계획이 없다`);
  invariant(banks.stats.revetment > 0, `${label}: 석축 호안 구간이 0 — 도성 구간 위계가 사라졌다`);
  invariant(banks.stats.natural > 0, `${label}: 자연석·토안 구간이 0 — 성 밖 위계가 사라졌다`);
  for (const side of [-1, 1]) {
    invariant(banks.runs.some((run) => run.side === side),
      `${label}: ${side < 0 ? '북' : '남'}안 호안이 없다 — 개천 석축은 **양안**이다`);
  }
  let minHeight = Infinity, maxHeight = -Infinity, minFreeboard = Infinity;
  for (const run of banks.runs) {
    for (const point of run.points) {
      // 표고·수면은 렌더 지형·공유 수면 계약에서 와야 한다(해석 heightAt 재계산 금지).
      invariant(Math.abs(point.toeY - terrainMeshHeightAt(site, point.x, point.z)) <= 1e-9,
        `${label}: 호안 기저 표고가 렌더 지형 표본과 다르다`);
      invariant(Math.abs(point.waterY - streamSurfaceHeightAt(site, point.cx, point.cz)) <= 1e-9,
        `${label}: 호안 수면이 공유 수면 계약과 다르다`);
      invariant(Math.abs(point.cz - site.streamZat(point.cx)) <= 1e-9,
        `${label}: 호안 중심선 표본이 개천 중심선을 벗어났다`);
      if (run.rank !== 'seokchuk') continue;
      const height = point.topY - point.toeY;
      invariant(height >= CREEK_BANK_LIMITS.minHeight - 1e-9,
        `${label}: 석축 높이 ${height.toFixed(2)}m 가 하한 미달 — 벽이 아니라 물가다`);
      invariant(height <= CREEK_BANK_LIMITS.maxHeight + 1e-9,
        `${label}: 석축 높이 ${height.toFixed(2)}m 가 사진 판독 대역 상한(${CREEK_BANK_LIMITS.maxHeight}m)을 넘는다 — 옹벽이다`);
      invariant(point.topY > point.waterY,
        `${label}: 석축 천단이 수면 아래다 — 호안이 잠긴다`);
      invariant(point.backOffset > CREEK_BANK_LIMITS.sampleSpacing * 0 + 1e-9
        && point.backOffset <= site.streamValleyHalfAt(point.x) + 1e-9,
      `${label}: 호안 두께가 골짜기 어깨 밖으로 나갔다`);
      minHeight = Math.min(minHeight, height);
      maxHeight = Math.max(maxHeight, height);
      minFreeboard = Math.min(minFreeboard, point.topY - point.waterY);
    }
  }
  // 계획은 순수 재현이어야 한다(렌더러와 검증이 같은 값을 본다).
  invariant(JSON.stringify(planCreekBanks(site)) === JSON.stringify(banks),
    `${label}: planCreekBanks 가 재현되지 않는다`);
  bankRows.push({ label, minHeight, maxHeight, minFreeboard, ...banks.stats });
}
// 농촌 개울은 호안을 갖지 않는다 — 다른 규모의 형상·드로우콜 불변이 그 증거다.
for (const scale of ['hamlet', 'village', 'town', 'capital']) {
  const plan = planVillage({ scale, seed: 2026, includePalace: scale === 'capital' });
  const banks = planCreekBanks(plan.site);
  invariant(banks.urban === false && banks.runs.length === 0,
    `${scale}: 농촌 개울에 개천 호안이 생겼다`);
  invariant(!plan.site.stream.urban,
    `${scale}: 농촌 개울이 개착 하천으로 표시됐다`);
}

// 다른 규모는 도성 개천 문법을 갖지 않는다 — 수문 0기, 개울은 마을 앞(0.30R)에 그대로.
for (const scale of ['hamlet', 'village', 'town', 'capital']) {
  const plan = planVillage({ scale, seed: 2026, includePalace: scale === 'capital' });
  const R = plan.site.R;
  invariant(Math.abs(plan.site.streamZ - 0.30 * R) <= 1e-9,
    `${scale}: 개울 위치가 도성 규칙에 오염됐다(streamZ=${plan.site.streamZ.toFixed(1)}, 기대 ${(0.30 * R).toFixed(1)})`);
  invariant(!(plan.features?.cityWall?.waterGates || []).length,
    `${scale}: 성곽 없는 규모에 수문이 생겼다`);
}

// 렌더러가 이 순수 spec 을 실제로 소비해야 한다(계획만 있고 형상이 없으면 무효다).
const citywallSource = readFileSync(fileURLToPath(
  new URL('../src/village/citywall.js', import.meta.url),
), 'utf8');
const featuresSource = readFileSync(fileURLToPath(
  new URL('../src/generators/village/features.js', import.meta.url),
), 'utf8');
invariant(featuresSource.includes('bridgeDeckPlacement'),
  'features.js 가 순수 다리 접지 계약을 소비하지 않는다 — 렌더러가 접지를 다시 푼다');
invariant(!/bankHeight\s*-\s*0\.35/.test(featuresSource),
  'features.js 에 옛 즉석 접지 산술이 남아 있다');
// Phase B: 렌더러가 순수 호안 계획과 계약이 준 교각 수·하상을 실제로 소비해야 한다.
for (const consumed of ['planCreekBanks', 'buildCreekBanks', 'placement.piers', 'placement.bedY']) {
  invariant(featuresSource.includes(consumed),
    `features.js 가 ${consumed} 를 소비하지 않는다 — 계획만 있고 형상이 없다`);
}
const bankGeometrySource = readFileSync(fileURLToPath(
  new URL('../src/village/creek-bank-geometry.js', import.meta.url),
), 'utf8');
// 호안은 성벽·돌다리와 같은 props 화강암 재질만 차용한다(신규 재질·텍스처·프로그램 패밀리 금지).
invariant(!/new THREE\.Mesh\w*Material/.test(bankGeometrySource),
  'creek-bank-geometry.js 가 자기 재질을 만든다 — props 화강암을 차용해야 드로우콜이 늘지 않는다');
invariant(!/new THREE\.(Canvas|Data)Texture/.test(bankGeometrySource),
  'creek-bank-geometry.js 가 텍스처를 만든다');
const bankPlanSource = readFileSync(fileURLToPath(
  new URL('../src/village/creek-bank-plan.js', import.meta.url),
), 'utf8');
const bankPlanCode = bankPlanSource.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
invariant(!/from\s+['"]three['"]|\bTHREE\.|\bdocument\.|\bwindow\./.test(bankPlanCode),
  'creek-bank-plan.js imported a renderer or DOM dependency');

for (const consumed of ['cityWaterGateProfile', 'spec.waterGates', 'buildWaterGate', 'p.jamb']) {
  invariant(citywallSource.includes(consumed),
    `citywall.js does not consume ${consumed} — 수문 spec 이 렌더되지 않는다`);
}
// 수문은 성벽·육축과 같은 화강암/그늘 재질만 쓴다(병합 후 드로우콜 +0).
const waterGateBody = citywallSource.slice(citywallSource.indexOf('function buildWaterGate'));
invariant(!/new THREE\.MeshStandardMaterial/.test(waterGateBody),
  'buildWaterGate 가 자기 재질을 만든다 — 성벽 재질을 공유해야 드로우콜이 늘지 않는다');
invariant((citywallSource.match(/new THREE\.MeshStandardMaterial/g) || []).length <= 6,
  'citywall.js material count grew — 병합 후 드로우콜 예산');

// 건천 하상은 지형 정점색 한 항이어야 한다(새 재질·텍스처 금지).
const terrainSource = readFileSync(fileURLToPath(
  new URL('../src/generators/village/terrain.js', import.meta.url),
), 'utf8');
invariant(/cDryBed/.test(terrainSource) && /urbanCreek/.test(terrainSource),
  'terrain.js 에 개천 건천 하상 정점색 항이 없다');
invariant(!/new THREE\.MeshStandardMaterial[\s\S]{0,200}dryBed/i.test(terrainSource),
  '건천 하상이 별도 재질을 만든다 — 정점색 한 항이어야 한다');
// 물색은 개착 하천 여부(site.stream.urban)로 갈라지고, 물 재질은 여전히 하나다.
const ribbon = terrainSource.slice(terrainSource.indexOf('export function buildWaterRibbon'));
const ribbonBody = ribbon.slice(0, ribbon.indexOf('\nexport '));
invariant(/site\.stream\.urban/.test(ribbonBody),
  'buildWaterRibbon 이 개착 하천 물색 축을 갖지 않는다');
invariant((ribbonBody.match(/new THREE\.MeshStandardMaterial/g) || []).length === 1,
  'buildWaterRibbon 이 물 재질을 둘 이상 만든다 — 프로그램 패밀리가 늘어난다');

const contourSource = readFileSync(fileURLToPath(
  new URL('../src/village/citywall-contour.js', import.meta.url),
), 'utf8');
// 주석의 "DOM/THREE 비의존" 문구를 잡지 않도록 실제 import·전역 사용만 본다.
const contourCode = contourSource.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
invariant(!/from\s+['"]three['"]|\bTHREE\.|\bdocument\.|\bwindow\./.test(contourCode),
  'citywall-contour.js imported a renderer or DOM dependency');

for (const row of rows) {
  console.log(`hanyang/${String(row.seed).padStart(4)} run=${String(row.run).padStart(3)}m `
    + `depth=${String(row.depth).padStart(3)}m jongno=${String(row.jongno).padStart(3)}m `
    + `sugumun=${row.gates} span=${row.span} cosN=${row.cosN}`);
}
const runs = rows.map((r) => r.run), depths = rows.map((r) => r.depth);
const bridgeAbove = bridgeRows.flatMap((r) => r.above);
const bays = bridgeRows.map((r) => r.bay);
console.log(`  다리 접지: ${bridgeRows.length}기 상면-지반 `
  + `${Math.min(...bridgeAbove).toFixed(2)}~${Math.max(...bridgeAbove).toFixed(2)}m, `
  + `지간 ${Math.min(...bays).toFixed(2)}~${Math.max(...bays).toFixed(2)}m`);
const level = approachRows.filter((r) => r.bench);
console.log(`  접근 수평: 벤치 횡단 ${level.length}/${approachRows.length}기, 낮은쪽 노면-데크 `
  + `${Math.min(...level.map((r) => r.rise)).toFixed(2)}~${Math.max(...level.map((r) => r.rise)).toFixed(2)}m `
  + `(상한 ${CREEK_APPROACH_LEVEL}m), 폴백 ${approachRows.length - level.length}기`);
const heights = bankRows.flatMap((r) => [r.minHeight, r.maxHeight]);
const freeboards = bankRows.map((r) => r.minFreeboard);
console.log(`  호안: ${bankRows.length}개 도성, 석축 표본 `
  + `${Math.min(...bankRows.map((r) => r.revetment))}~${Math.max(...bankRows.map((r) => r.revetment))} / `
  + `자연석 ${Math.min(...bankRows.map((r) => r.natural))}~${Math.max(...bankRows.map((r) => r.natural))}, `
  + `높이 ${Math.min(...heights).toFixed(2)}~${Math.max(...heights).toFixed(2)}m, `
  + `수면 위 ${Math.min(...freeboards).toFixed(2)}m+`);
console.log(`CREEK: PASS (${rows.length} hanyang seeds, inside run ${Math.min(...runs)}~${Math.max(...runs)}m, `
  + `depth ${Math.min(...depths)}~${Math.max(...depths)}m, `
  + `${rows.reduce((sum, r) => sum + r.gates, 0)} water gates, `
  + `${(performance.now() - started).toFixed(0)}ms)`);
