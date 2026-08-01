import * as G from '../core/math/geom2.js';
import { createRoadSpatialIndex } from './road-spatial.js';

// 렌더러(buildWaterRibbon)가 소비하는 동일 centerline·half-width를 기준으로 한 개울 계약.
// analytic streamZat(center.x) 근사는 회전된 필지 모서리와 사행 접선을 놓치므로 배치·식생·
// 회귀 검사는 이 모듈을 통해 실제 폴리라인 리본과 비교한다.
// 중심점 근사의 옛 +4.5m는 필지 반폭을 대신하려던 휴리스틱이었다. 폴리곤 자체를 재므로
// 실제 물가 밖 배수 여유까지 직접 재므로 더 강한 안전 계약을 유지하면서 수변 취락 밀도를 잃지 않는다.
export const STREAM_PARCEL_BANK_CLEARANCE = 1.2;
export const STREAM_SATELLITE_BANK_CLEARANCE = 1.2;
export const STREAM_PADDY_BANK_CLEARANCE = 2;
export const STREAM_VEGETATION_BANK_CLEARANCE = 1.2;
export const STREAM_GUARDIAN_BASE_CLEARANCE = 2.5;

export function streamClearanceAt(site, point) {
  if (!site?.stream?.pts?.length) return Infinity;
  return G.distToPolyline(point, site.stream.pts).d - Math.max(0, site.streamHalf || 0);
}

export function streamIntersectsPolygon(site, poly, margin = 0) {
  if (!site?.stream?.pts?.length || !poly?.length) return false;
  const corridor = Math.max(0, site.streamHalf || 0) + Math.max(0, margin || 0);
  return G.polylinePolygonDistance(site.stream.pts, poly) < corridor;
}

export function streamBlocksCircle(site, point, radius = 0, margin = 0) {
  return streamClearanceAt(site, point) < Math.max(0, radius || 0) + Math.max(0, margin || 0);
}

// 수백~수만 필지 후보를 검사하는 배치 경로는 centerline 전수 순회를 반복하지 않는다.
// 도로와 개울은 모두 폭을 가진 polyline corridor이므로 이미 검증된 uniform-grid broad phase를
// 그대로 재사용한다. 저빈도 단건 소비자는 위의 stateless 함수만 써도 된다.
export function createStreamSpatialIndex(site) {
  if (!site?.stream?.pts?.length) {
    return Object.freeze({
      intersectsPolygon: () => false,
      stats: Object.freeze({ cellSize: 0, cells: 0, segments: 0 }),
    });
  }
  const spatial = createRoadSpatialIndex([site.stream]);
  return Object.freeze({
    intersectsPolygon(poly, margin = 0) {
      return spatial.intersectsRoadCorridor(poly, Math.max(0, margin || 0), site.stream);
    },
    stats: spatial.stats,
  });
}

// ── 개울·개천 다리 접지(단일 진실원) ────────────────────────────────────────
// 판석교(평석교) 데크 표고는 렌더러가 즉석에서 계산하면 계약이 검사할 수 없다. 배치 산술을
//   여기 한 곳에 두고 generators/village/features.js 가 그대로 소비한다(계획-렌더 이중 진실 금지).
// 옛 식은 둑 표본을 `streamHalf + 3` 고정 오프셋에서 떴는데, 데크 **양 끝**은 span/2 에 있어
//   둑이 그보다 높은 시드에서 널돌이 둑을 파고들었다(실측 2026-08-01: village 20260716 −0.08m,
//   town 5 −0.26m, hanyang −0.18m). 실제 접지면인 데크 양 끝 지반을 표본에 포함해 접지를 정한다.
export const BRIDGE_SLAB_DECK_LIFT = 0.55;   // 판석 상면 = 배치 y + 이 값(builder/bridge.js 규약)
export const BRIDGE_BANK_INSET = 0.35;       // 데크를 둑 상면보다 이만큼 낮춰 문턱 단차를 줄인다
// 널돌(청판석) 한 켜가 건너는 지간. 평석교는 교각을 세우고 그 위에 멍엣돌을 걸치는 형식이라
//   (한국민족문화대백과사전 「평석교」) 지간이 석재 한 장의 길이를 넘을 수 없다. 25m 하도를 교각
//   2기로 건너면 지간 8.3m 짜리 통돌이 되어 석교로 읽히지 않는다.
export const BRIDGE_SLAB_BAY = 3;

// 지간 3m 규약을 만족하는 교각 수. span 은 사교 보정을 포함한 실제 데크 길이다.
export function bridgeSlabPiers(span) {
  return Math.max(2, Math.round(Math.max(1, span) / BRIDGE_SLAB_BAY) - 1);
}

// ── 개착 하도 횡단부의 '벤치' 탐색 ────────────────────────────────────────────
// 도성 개천의 다리는 골짜기를 **벤치 높이에서** 건너야 한다(#20 R4 Phase B). 그런데 벤치가 어디인지
//   고정 오프셋으로 가정하면 두 결함이 번갈아 난다(실측 2026-08-01):
//     · 오프셋이 작으면 데크가 하도 안에 앉아 접근로가 골짜기로 내려간다(Phase A: 노면이 데크보다
//       1.4~1.8m 높음).
//     · 오프셋이 골짜기 어깨(성 밖 60m)까지 나가면 데크 끝이 산 사면에 올라앉아 반대로 데크가
//       접근 노면보다 4.1m 뜬다(hanyang/777·55).
//   그래서 물가에서 바깥으로 걸어 나가며 **사면이 완만해지는 첫 지점**을 벤치로 잡는다. 완경사
//   판정은 시가지 지반 구배(BENCH_GRADE) 기준이고, 골짜기 어깨(bankTopHalf)를 절대 상한으로 둔다.
export const CREEK_BENCH_GRADE = 0.10;   // m/m — 이 아래로 떨어지면 골짜기 사면이 끝났다고 본다
export const CREEK_BENCH_STEP = 1;       // m — 탐색 간격
// 벤치 검증: 찾은 지점 밖으로 더 나가 보고, 지반이 그보다 이만큼 이상 **떨어지면** 그것은 벤치가
//   아니라 능선(rim)이다. 능선에 데크를 앉히면 접근로가 다리 아래로 흘러내려 다리가 언덕 위에
//   올라앉는다(실측 2026-08-01 hanyang/55: 데크가 접근 노면보다 2.34m 위).
export const CREEK_BENCH_CONFIRM = 8;    // m — 벤치 밖 확인 거리
export const CREEK_BENCH_MAX_FALL = 1;   // m — 확인 지점이 이보다 더 낮으면 벤치가 아니다
// 벤치 횡단이 성립한 개천 다리는 **낮은 쪽 접근 노면**과 수평으로 만나야 한다. 이 값이 계약이고
//   check-creek 이 데크 끝 밖 CREEK_APPROACH_REACH 지점의 노면으로 검사한다. 실측(2026-08-01):
//   Phase A 는 노면이 데크보다 1.23~2.84m 높았고(= 길이 골짜기로 내려가 다리를 만났다),
//   Phase B 벤치 횡단은 −2.00~+0.05m 다.
export const CREEK_APPROACH_LEVEL = 0.6;   // m — 노면이 데크 상면보다 이보다 더 높으면 접근이 내려간다
export const CREEK_APPROACH_REACH = 15;    // m — 데크 끝 밖 접근 노면 표본 거리
// 데크는 직사각형이라 양안 벤치 표고가 크게 다르면 한쪽 끝이 반드시 뜬다(실측 2026-08-01
//   hanyang/99: 좌 끝 상면이 지반 위 1.87m — 접지 envelope 상한 1.0m 초과). 양안 비대칭이 이 값을
//   넘으면 그 횡단은 벤치 문법을 쓸 수 없다 — 농촌 개울 규칙으로 폴백한다.
export const CREEK_BENCH_ASYMMETRY = 0.7;

export function creekCrossingBench(site, x, side) {
  const centerZ = site.streamZat(x);
  const start = Math.max(0, site.streamHalf || 0);
  // 탐색 상한은 **개착 하도의** 골짜기 어깨다. site.streamValleyHalf 는 도성에서 그 값(하도 반폭
  //   + 어깨)이고, x 종속 어깨(성 밖 60m)를 상한으로 쓰면 탐색이 산 사면 60m 를 걸어 올라간다.
  const limit = Math.min(
    site.streamBankTopHalfAt ? site.streamBankTopHalfAt(x) : start + 3,
    (site.streamValleyHalf || start + 3) + 1.5,
  );
  let offset = start, y = site.heightAt(x, centerZ + side * start), found = false;
  for (let next = start + CREEK_BENCH_STEP; next <= limit; next += CREEK_BENCH_STEP) {
    const ny = site.heightAt(x, centerZ + side * next);
    const grade = (ny - y) / CREEK_BENCH_STEP;
    offset = next; y = ny;
    if (grade < CREEK_BENCH_GRADE) { found = true; break; }   // 사면이 끝났다 = 벤치
  }
  if (found) {
    const beyond = site.heightAt(x, centerZ + side * (offset + CREEK_BENCH_CONFIRM));
    if (y - beyond > CREEK_BENCH_MAX_FALL) found = false;     // 벤치가 아니라 능선이었다
  }
  return { offset, y, found };
}

// 개착 하도를 건너는 데크의 반폭·표고. 양안 벤치 중 **낮은** 쪽에 데크를 맞춰 다리가 두 접근로
//   위로 뜨지 않게 하고, 반폭은 두 벤치 중 먼 쪽을 덮어 데크 끝이 사면에 걸리지 않게 한다.
//   한쪽이라도 어깨 안에서 벤치를 못 찾으면(개천이 산 사면·성벽에 붙어 흐르는 시드) 그 횡단은
//   개착 하도 문법을 쓸 수 없다 — found=false 를 돌려 호출부가 농촌 개울 규칙으로 되돌린다.
//   실측 근거(2026-08-01): 그 시드에서 어깨까지 밀어붙이면 데크 끝이 국소 고지(지반 5.4m)에 올라
//   접근 노면보다 4.0m 뜬 다리가 된다(hanyang/777 −4.03m, 55 −2.34m).
export function creekCrossingSpanHalf(site, x) {
  const left = creekCrossingBench(site, x, -1);
  const right = creekCrossingBench(site, x, 1);
  // 데크 반폭은 두 벤치 중 먼 쪽이다(가까운 쪽에 맞추면 반대편 끝이 사면에 걸린다). 접지 표고는
  //   그 공통 반폭에서의 양안 지반 중 **높은** 쪽이라 어느 끝도 널돌 아래로 묻히지 않는다.
  const half = Math.max(left.offset, right.offset);
  const centerZ = site.streamZat(x);
  const atHalf = [-1, 1].map((side) => site.heightAt(x, centerZ + side * half));
  const asymmetry = Math.max(...atHalf) - Math.min(...atHalf);
  return {
    half,
    benchY: Math.max(...atHalf),
    asymmetry,
    found: left.found && right.found && asymmetry <= CREEK_BENCH_ASYMMETRY,
  };
}

export function bridgeDeckPlacement(site, spec, { surfaceY } = {}) {
  const span = spec.span || 5;
  const rot = spec.rot || 0;
  const centerZ = site.streamZat(spec.x);
  const across = { x: Math.cos(rot), z: -Math.sin(rot) };
  const ends = [-1, 1].map((side) => ({
    x: spec.x + across.x * side * span * 0.5,
    z: spec.z + across.z * side * span * 0.5,
  }));
  const endGround = ends.map((point) => site.heightAt(point.x, point.z));
  // 접지 기준의 두 갈래(#20 R4 Phase B):
  //   · 개착 하도에서 양안 벤치를 찾은 경우 — **낮은 쪽 벤치** 표고. 다리가 두 접근로 위로 뜨지
  //     않고 시가지 지반 높이에서 하도를 건넌다. 데크 끝이 그보다 높은 지반에 걸리면 널돌이
  //     묻히므로 그때만 데크 끝 지반이 바닥을 만든다.
  //   · 그 밖(농촌 개울 + 벤치 없는 개천 시드) — 이 라운드 이전과 **같은** 산술이다. 둑 표본
  //     오프셋도 옛 streamHalf + 3 을 그대로 써야 한다(넓은 천단 오프셋을 폴백에 쓰면 표본이 산
  //     사면을 물어 데크가 3.7m 뜬다 — 실측 2026-08-01 hanyang/777).
  const bench = site.stream?.urban ? creekCrossingSpanHalf(site, spec.x) : null;
  const bankOffset = bench?.found
    ? site.streamBankTopHalfAt(spec.x)
    : Math.max(0, site.streamHalf || 0) + 3;
  const bankGround = [-1, 1].map((side) => site.heightAt(spec.x, centerZ + side * bankOffset));
  const contactY = bench?.found
    ? Math.max(...endGround, bench.benchY)
    : Math.max(...bankGround, ...endGround);
  const waterY = typeof surfaceY === 'number'
    ? surfaceY
    : (site.streamY ? site.streamY(spec.x) : 0);
  const deckY = spec.type === 'arch'
    ? waterY
    : Math.max(waterY, contactY - BRIDGE_BANK_INSET);
  // 교각이 실제로 닿아야 하는 하상. 데크가 시가지 지반까지 올라오면 교각도 그만큼 길어져야 한다 —
  //   builder 의 로컬 고정값(-0.4)으로 두면 3.5m 트렌치 위에서 교각이 공중에 뜬다.
  const bedY = site.heightAt(spec.x, centerZ);
  return {
    deckY,
    deckTopY: deckY + BRIDGE_SLAB_DECK_LIFT,
    ends,
    endGround,
    bankGround,
    contactY,
    waterY,
    bedY,
    piers: bridgeSlabPiers(span),
  };
}
