import { makeRng, hashString } from '../rng.js';
import { makeSite, resolveSiteR, tierForR, rToScale01 } from './site.js';
import { planRoads } from './roads.js';
import { planParcels, planSatellites } from './parcels.js';
import {
  CITY_WALL_MIN_SITE_R,
  cityGateForecourtPolygon,
  cityWallClearance,
  cityWallContainsPolygon,
  cityWallOutsidePolygon,
  planCityWall,
  worldEdgeContainsPolygon,
} from './citywall-contour.js';
import * as G from '../core/math/geom2.js';
import {
  attachParcelSpatialContract,
  parcelLocalPoint,
  parcelRoadAccess,
  parcelSolarAccessPolygon,
  parcelWorldPoint,
  rectangularParcelShape,
} from './parcel-contract.js';
import {
  palaceGatePoint,
  palaceUrbanFrontPlan,
} from './palace-precinct-plan.js';
import { planGuardianTrees } from './guardian-plan.js';
import { assignFittedVariation } from './house-footprint.js';
import {
  STREAM_PADDY_BANK_CLEARANCE,
  streamIntersectsPolygon,
  creekCrossingSpanHalf,
} from './stream-spatial.js';
import { planTempleSite, templeReservationPolygons } from './temple-plan.js';
import { planPavilion } from './pavilion-plan.js';
import { planPublicProps } from './public-props-plan.js';
import { planRiverPort } from './river-port-plan.js';
import { attachRoadJunctions } from './road-topology.js';
import { createRoadSpatialIndex } from './road-spatial.js';
import { normalizeVillageTuningOptions } from './options.js';
import { planSijeon } from './sijeon-plan.js';
import { planRoadsideDrainage } from './drainage-plan.js';
import { planDangsan } from './dangsan-plan.js';
import { planMjaHouse } from './mja-house-plan.js';
import { planParcelAuxiliary } from './auxiliary-building-plan.js';
import { yardHardObstacles } from './yard-layout.js';

// v4 마을 자동 구성 진입점. 순수 데이터 VillagePlan 을 반환한다(렌더는 populate.js).
//
// planVillage(opts) → VillagePlan
//   opts: { scale:'hamlet'|'village'|'town'|'capital', includePalace?, includeTemple?, seed }
//
// 규모·옵션 시맨틱 (joseon-city.md 규칙 번호):
//   hamlet(초락 5~12호)  : 씨족촌 16~18 — 배산임수 시드·종가 명당·준방사 골목·진입 시퀀스
//   village(마을 15~40호): hamlet + 개울·돌다리·다랑이 논, 초가:기와 그라디언트 뚜렷
//   town(읍치 30~80호)   : 14~15 — 십자/T 간선·배산 아래 관아 코어·민가 유기 충전
//   capital(도성풍)       : 1~6 — 주산 남 궁·남북대로+동서 간선 T·관청 좌우·북촌→남촌
//   includeTemple        : 19~21 — 마을과 떨어진 산기슭 별도 클러스터(어느 scale에도 조합)
//   includePalace        : capital 외 scale 에선 무시(경고)

// 종가·관아처럼 도로 프론티지보다 먼저 자리를 잡는 사각 필지도 일반 필지와 같은
// shape→poly→일조 계약을 쓴다. 별도 사각형 수학을 두지 않아 pad·담·집 방향이 어긋나지 않는다.
function reservedParcel(center, frontDir, plotW, plotD, fields = {}) {
  return attachParcelSpatialContract({
    placement: 'core',
    ...fields,
    center: { x: center.x, z: center.z },
    frontDir: G.norm(frontDir),
    plotW,
    plotD,
    shape: rectangularParcelShape(plotW, plotD),
  });
}

// site.center는 종가·관아의 몸체 중심보다 공동 앞마당/대문 결절로 쓰인다. 집을 남향으로
// 돌린 뒤에도 기존 안길이 본채를 관통하지 않도록 필지 중심을 대문에서 북쪽으로 물린다.
function coreCenterBehindGate(gate, frontDir, plotD) {
  return G.sub(gate, G.mul(G.norm(frontDir), plotD * 0.5));
}

function attachOptInMjaHouse({
  context,
  core,
  coreRoadAnchor,
  roads,
  char01,
  tuning,
}) {
  if (!context || !core || core.heroStyle !== 'hanok' || !coreRoadAnchor || !roads?.length) {
    return null;
  }
  // The pure reusable planner requires the same fitted source frame and stored
  // road-side gate that every downstream renderer/camera will consume. The
  // reserved clan core is always p0; assign that stable ID before frontage
  // planning so the deep-frozen record never needs a later mutation.
  core.id = 'p0';
  // mja opt-in is hamlet/village only (rural) — eave stays preset 1.0 (no urban ov).
  if (!assignFittedVariation(core, char01, tuning)) return null;
  const gateLocal = parcelLocalPoint(core, coreRoadAnchor);
  // Several lateral clan lanes share the exact gate endpoint. Select the one
  // segment that actually approaches along the south-facing axis; a nearest
  // distance tie alone would often choose the first sideways branch.
  let approach = null;
  for (const road of roads) {
    for (let index = 0; index < road.pts.length - 1; index++) {
      const a = road.pts[index], b = road.pts[index + 1];
      const nearest = G.distToSeg(coreRoadAnchor, a, b);
      if (nearest.d > 2) continue;
      const tangent = G.norm(G.sub(b, a));
      const alignment = Math.abs(G.dot(tangent, core.frontDir));
      if (!approach
        || alignment > approach.alignment + 1e-9
        || (Math.abs(alignment - approach.alignment) <= 1e-9
          && nearest.d < approach.distance - 1e-9)) {
        approach = { road, a, b, alignment, distance: nearest.d };
      }
    }
  }
  if (!approach?.road?.id || approach.alignment < Math.SQRT1_2) return null;
  const localA = parcelLocalPoint(core, approach.a);
  const localB = parcelLocalPoint(core, approach.b);
  const outward = localA.z > localB.z ? approach.a : approach.b;
  const outwardLocal = localA.z > localB.z ? localA : localB;
  if (outwardLocal.z <= gateLocal.z + 0.25) return null;
  const outwardDistance = G.dist(outward, coreRoadAnchor);
  if (!outward || !Number.isFinite(outwardDistance) || outwardDistance <= 1e-8) return null;
  // Keep the provenance point on the actual final road segment, but no farther
  // than four metres from the parcel gate. It is a stored access direction, not
  // a second renderer-only approach path.
  const roadPoint = G.lerp(
    coreRoadAnchor,
    outward,
    Math.min(1, 4 / outwardDistance),
  );
  const access = parcelRoadAccess(core, approach.road.id, roadPoint);
  if (!access || access.gateRole !== 'front') return null;
  core.access = access;

  const mjaHouse = planMjaHouse({ context, parcel: core });
  if (!mjaHouse) return null;
  core.mjaHouse = mjaHouse;
  // The north anchae receives winter sun through the real south gate gap. Keep
  // the internal start point authored by the reusable plan and extend that
  // narrow opening to the existing parcel-exterior clearance distance.
  const corridor = mjaHouse.solarTarget.corridor;
  const xs = corridor.map((point) => point.x);
  core.solarAccess = {
    localStart: mjaHouse.solarTarget.point.z,
    localEnd: core.solarAccess.localEnd,
    halfWidth: (Math.max(...xs) - Math.min(...xs)) * 0.5,
  };
  return mjaHouse;
}

function roadStreamCrossing(road, site, cityWall) {
  if (!road || !site.stream) return null;
  const candidates = streamCrossingsOnRoad(road, site).map((candidate) => ({
    ...candidate,
    outside: !cityWall || cityWallClearance(cityWall, candidate.point) <= 0,
  }));
  const outside = candidates.filter((candidate) => candidate.outside);
  return (outside.length ? outside : candidates)[0] || null;
}

// 이 거리 안의 두 횡단은 한 다리로 본다(사행을 스치며 두 번 부호가 바뀌는 굽이 = 다리 하나).
//   데크 폭(간선 6m)보다 넉넉하되, 실측된 별개 횡단(11.8~15.6m 떨어진 골목)은 자기 다리를 얻는다.
const BRIDGE_MERGE_DISTANCE = 10;
// 물길과 거의 나란히 가다 중심선을 스치는 길은 **건너는 것이 아니다**. 그 자리에 다리를 놓으면
//   사교 보정이 폭주해 하도 폭 20m 를 60m 데크로 건넌다(실측 2026-08-01 hanyang/2026: 사교 0.07,
//   span 60.6m). 지선은 실제로 물을 가로지르는 각도일 때만 다리를 얻는다(≈66° 이상).
const BRIDGE_MIN_SKEW = 0.4;

// 통행로 전체가 개울 중심선을 건너는 지점. 도로 배열 순서를 그대로 따르므로 결정론적이고 rng 를
//   전혀 쓰지 않는다(시드 흐름 불변).
function roadStreamCrossings(roads, site) {
  const out = [];
  for (const road of roads || []) {
    for (const candidate of streamCrossingsOnRoad(road, site)) {
      out.push({ road, ...candidate });
    }
  }
  return out;
}

function streamCrossingsOnRoad(road, site) {
  const out = [];
  if (!road?.pts?.length || !site.stream) return out;
  const signed = (point) => point.z - site.streamZat(point.x);
  for (let i = 0; i < road.pts.length - 1; i++) {
    const a = road.pts[i], b = road.pts[i + 1];
    let fa = signed(a), fb = signed(b);
    if (fa * fb > 0) continue;
    let lo = 0, hi = 1;
    for (let step = 0; step < 42; step++) {
      const mid = (lo + hi) * 0.5;
      const fm = signed(G.lerp(a, b, mid));
      if (fa * fm <= 0) { hi = mid; fb = fm; }
      else { lo = mid; fa = fm; }
    }
    out.push({ point: G.lerp(a, b, (lo + hi) * 0.5), tangent: G.norm(G.sub(b, a)) });
  }
  return out;
}

// 데크가 건너야 하는 실제 폭(사교 보정 전). 개착 하도는 양안 **벤치** 사이(stream-spatial 의 벤치
//   탐색이 단일 진실원), 농촌 개울은 하도 전폭이다.
function bridgeCrossWidth(site, x) {
  if (!site.stream?.urban) return site.stream.width;
  const bench = creekCrossingSpanHalf(site, x);
  return bench.found ? bench.half * 2 : site.stream.width;
}

// 길이 물길을 얼마나 직교로 건너는가(1 = 직교, 0 = 나란함). span 은 이 값으로 나눠 늘어난다.
function crossingSkewRaw(site, x, tangent) {
  const d = 1;
  const streamTangent = G.norm({ x: d * 2, z: site.streamZat(x + d) - site.streamZat(x - d) });
  const streamNormal = G.perpL(streamTangent);
  return Math.abs(G.dot(tangent, streamNormal));
}

// span 계산용 하한 클램프(0.5 = 사교 60°). 성문 접근 간선은 이 라운드 이전과 같은 클램프를 쓴다.
function crossingSkew(site, x, tangent) {
  return Math.max(0.5, crossingSkewRaw(site, x, tangent));
}

// ── char01 규모 파생(#89) ── 규모 연동 단조 앵커 + 시드 지터. 작은 씨족촌=민촌 성향(초가 우세,
//   char01↓) → 도성=반촌·여염 혼합(기와 상승, char01≈0.66; 순반촌 1.0 아님 — 도성엔 서민도 산다).
//   앵커 siteR 은 SCALE_ANCHORS(명명 tier)와 동기. capital base 0.60 / hanyang 0.66 → 지터(±0.08)
//   후에도 0.5 이상이라 궁+민촌 클램프가 자연 소멸(회귀 안전).
const CHAR01_ANCHORS = [[105, 0.18], [180, 0.34], [240, 0.48], [280, 0.60], [500, 0.66]];
// 필지 목표수 앵커(연속) — SCALE_TARGET 이산값을 제어점으로. town(70)=단일청크 상한, capital(104)+는 다청크.
//   값은 "프론티지(추가 필지)" 목표수 — 종가·관아 예약 코어는 별도 +1. [30,0] = 외딴집 하한(#114):
//   R30 에서 프론티지 0 + 예약 종가 = 딱 한 채. 30~hamlet 은 0~10 연속(두세 채 촌락도 성립).
//   siteR 앵커는 SCALE_ANCHORS 와 동기 — 필지 확대 뒤에도 명명 tier 호수가 유지되게 한다.
const HOUSE_ANCHORS = [[30, 0], [105, 10], [180, 32], [240, 70], [280, 112], [500, 392]];
const WALLED_BOWL_K_MIN = 0.8;

function pieceLerp(R, anchors) {
  if (R <= anchors[0][0]) return anchors[0][1];
  for (let i = 1; i < anchors.length; i++) {
    if (R <= anchors[i][0]) {
      const [x0, y0] = anchors[i - 1], [x1, y1] = anchors[i];
      return y0 + (y1 - y0) * (R - x0) / (x1 - x0);
    }
  }
  return anchors[anchors.length - 1][1];
}
function char01ForR(R, seed) {
  const base = pieceLerp(R, CHAR01_ANCHORS);
  const jit = (makeRng((seed ^ 0x2a01) >>> 0)() * 2 - 1) * 0.08;   // 시드별 성격 지터
  return Math.min(1, Math.max(0, base + jit));
}
const charLabel = (c) => (c < 0.34 ? 'minchon' : c < 0.66 ? 'yeoyeom' : 'banchon');

// 행랑이 성벽 몸통·여장에 붙지 않도록 두는 안쪽 여유(성벽 두께 + 순라 통로 몫).
const SIJEON_WALL_INSET = 8;
// ── 문전 마당 깊이 (필지·시전 배제분) ── 사용자 결정 2026-08-04: 12~18m 로 축소.
//   왜 축소했나: citywall-contour.js#cityGateForecourtPolygon 의 기본 깊이는 통행 예약
//   (gateApproachLength 44 + clearance 3 = 47m)를 그대로 쓴다. 그 값을 **필지·시전 배제**에도 쓰면
//   성문 안쪽 51.25m 가 통째로 비어, 문서가 단언하는 조항("행랑은 성문에 닿는 간선 파사드를 따라" —
//   docs/joseon-city.md §성문 주변, §시전행랑 종루~남대문·종묘~동대문)과 구한말 도성 사진의
//   "문 앞까지 처마가 이어진 가로"를 둘 다 어긴다. 반대편 근거인 "문 안쪽 의례 광장"은 같은 문서가
//   **미검증**으로 명시한 조항이므로, 단언된 조항 쪽을 택했다(원 결정과 근거는 문서에 보존).
//   숫자의 성격: 고증 치수가 아니라 **제품 값**이다(segmentShops 와 같은 급). 12~18m 대역에서
//   "행랑 마지막 칸이 육축 앞 15m 안"이라는 실측 조건을 만족하는 가장 큰 값으로 골랐다
//   (실측 2026-08-04, hanyang 4시드 × 사대문 — tools/check-sijeon-approach.mjs 표).
//   통행·식생 예약(cityGateApproachFootprint · cityWallVegetationBlocked)은 47m 그대로다 —
//   축소는 "무엇이 그 자리에 설 수 있는가"만 바꾸고 문 앞 통로 자체는 비운다.
export const GATE_FORECOURT_PLAN_DEPTH = 14;
// 논배미와 성벽 바깥면 사이 여유(성저 들이 성벽 발치에 붙지 않게) — 필지 성벽 여유와 같은 급.
const PADDY_WALL_CLEARANCE = 6;

export function planVillage(opts = {}) {
  const warnings = [];
  const seed = (typeof opts.seed === 'number' ? opts.seed
    : typeof opts.seed === 'string' ? hashString(opts.seed) : 20260716) >>> 0;
  const tuning = normalizeVillageTuningOptions(opts);

  // ── 연속 스케일(#89) ── siteR(분지 반경, m) 하나가 규모의 진입점. opts.scale 은 프리셋명('capital')
  //   | 절대 siteR(m, >1) | 0..1 정규화(슬라이더) 모두 허용, opts.siteR(m) 은 명시 우선. 지형은 연속
  //   (site.js siteConfigFor)이되 도로망·성곽·시전·궁 tier 등 불연속 문법은 tier 임계에서 스냅한다.
  const siteR = resolveSiteR(typeof opts.siteR === 'number' ? opts.siteR
    : (opts.scale != null ? opts.scale : 'village'));
  const scale = tierForR(siteR);                      // 이산 tier(토폴로지·성곽·궁 임계 분기)
  const isCapitalTier = scale === 'capital' || scale === 'hanyang';
  if (tuning.river && !isCapitalTier) warnings.push('강은 도성·한양 규모에서만 유효 — 이 규모에서는 개울로 구성됨');
  // 한양 도성은 궁 앵커가 도시 구성의 척추 — 명시적으로 끄지 않는 한 궁 기본 활성.
  let includePalace = scale === 'hanyang' ? (opts.includePalace !== false) : !!opts.includePalace;
  if (includePalace && !isCapitalTier) {
    warnings.push(`includePalace 는 capital·hanyang(R≥213) 에서만 유효 — R=${Math.round(siteR)}(${scale}) 에서 무시됨`);
    includePalace = false;
  }
  const includeTemple = !!opts.includeTemple;

  // 마을 성격(빈부 축) 자동화(#89): character 외부 축 폐지 — char01 을 규모 연동 함수로 파생한다.
  //   opts.character 는 더 이상 소비하지 않는다. 내부 char01 파이프(필지 치수·기와비·반가 밀도·논·
  //   소품·담)는 그대로. character 라벨은 하위호환 표시용(내부 로직 비의존).
  // char01 오버라이드(#91): 어휘 축 "초가/기와 비율"을 직접 노출. 미지정 시 규모 파생(char01ForR) 유지
  //   → #89 자동화 기본 불변. 지정 시 필지 유형비·담·반가밀도·논 등 char01 파이프 전체가 반응(결정론).
  const charOverride = typeof opts.char01 === 'number' && isFinite(opts.char01);
  const char01 = charOverride ? Math.min(1, Math.max(0, opts.char01)) : char01ForR(siteR, seed);
  const character = charLabel(char01);
  // 필지 목표수(연속) → tier 경계 카운트 스냅 제거. opts.houses(#114)는 직접 오버라이드 — 0 허용
  //   ("절 하나만" 구성: houses:0 + includeTemple:true → 집 없는 사찰 플랜, 엔진은 부감 랜딩 폴백).
  const housesOverridden = typeof opts.houses === 'number' && isFinite(opts.houses);
  const defaultTarget = Math.round(pieceLerp(siteR, HOUSE_ANCHORS));   // siteR 이 함의하는 명목 호수
  const requestedHouseTarget = housesOverridden ? Math.max(0, Math.min(400, Math.round(opts.houses))) : defaultTarget;
  // The solo field can safely hold either one household or the minimum 22m
  // hermitage precinct, not both plus a road network. Selecting a temple at
  // this scale therefore means the documented "temple alone" composition.
  const templeSolo = includeTemple && siteR < 50;
  const houseTarget = templeSolo ? 0 : requestedHouseTarget;
  if (templeSolo && requestedHouseTarget > 0) warnings.push('외딴 절 구성에서는 주거 필지를 생략함');
  const wantWall = tuning.cityWall === true ? true : tuning.cityWall === false ? false : (scale === 'hanyang');
  const wallSupported = siteR >= CITY_WALL_MIN_SITE_R;

  // ── 분지 크기 = 건축 footprint 종속(#120) ── siteR(규모)만 움직이면 houseTarget≈defaultTarget 이라
  //   계수 1(현행 반경 정확 재현 — 무옵션 게이트 보존). houses 를 직접 낮추면(집 적음) 분지가 아담해지고
  //   높이면 넓어진다("사각 그릇 고정 반경" 인상 해소). 면적 ∝ 호수 → 반경 ∝ √호수(+3 완충으로 극단 방지).
  //   대규모 궁·성곽 붕괴 방지로 [0.72,1.25] 클램프(site.js 도 [0.68,1.28] 재클램프).
  const footprintBowlK = housesOverridden
    ? Math.min(1.25, Math.max(0.72, Math.pow((houseTarget + 3) / (defaultTarget + 3), 0.5)))
    : 1;
  // 성곽은 호수와 무관한 고정 폭 성문·육축·edge inset을 가진다. 원래 규모의 지형 span을
  // 80% 아래로 줄이면 최소 초락에서는 성벽보다 terrain grid가 먼저 잘리고, 큰 tier에서도
  // 성문 연결도로 ribbon이 잘린 지형 band에 닿는다.
  // 요청된 성곽에만 인프라 최소 span을 적용하므로 기본/무성곽의 footprint 축소와 RNG는 그대로다.
  const wallBowlFloor = WALLED_BOWL_K_MIN;
  const bowlK = wantWall && wallSupported
    ? Math.max(footprintBowlK, wallBowlFloor)
    : footprintBowlK;

  const norm = { scale, siteR, scale01: rToScale01(siteR), includePalace, includeTemple, seed, character, char01, charOverride, target: houseTarget, tuning, bowlK };
  const rng = makeRng(seed);

  // ── 1) 사이트(배산임수) ── 지형 옵션(#91) 주입: 기복·능선고·개울 사행/유무(무옵션=현행 정확 재현).
  //   bowlK(#120): 분지 반경을 footprint(houseTarget)에 종속. 무옵션(houses 미지정) 시 bowlK=1 → 불변.
  // A 22m compact precinct cannot share the 30m solo field with the stream bank
  // without either climbing the ridge or violating the exact bank clearance.
  // Keep that smallest temple landscape dry; the next scale restores the user's
  // stream setting. This is a planning constraint, not a renderer-side overlap.
  const templeSoloDry = templeSolo;
  const site = makeSite({ siteR, seed, bowlK,
    undAmpK: tuning.undAmpK, ridgeHK: tuning.ridgeHK, streamMeanderK: tuning.streamMeanderK,
    stream: templeSoloDry ? false : tuning.stream, river: tuning.river && isCapitalTier });
  if (templeSoloDry && tuning.stream) warnings.push('외딴 절 터는 경내 이격을 위해 마른 분지로 구성됨');
  const C = site.center, E = site.entrance;
  const toEntrance = G.norm(G.sub(E, C));   // 종가가 바라보는 방향(남, 동구쪽)

  // ── 2) 예약 코어(종가/관아/궁) — 프론티지 배정 전에 블록으로 확보 ──
  const blockers = [];
  const features = {
    pavilion: null, bridges: [], ferry: null, riverPort: null,
    props: [], temple: null, palace: null,
  };

  // 핵심 건물의 좌향은 카메라/석양 룩이 아니라 배산임수의 주산→동구 축이 결정한다.
  // 이전 rimFrontDir(-z)은 남향 주석과 달리 종가·관아·궁을 북북서로 돌리고 있었다.
  const coreFrontDir = toEntrance;
  // 궁이 있으면 간선 앵커는 종가가 아니라 정문이고(육조거리는 광화문에서 시작한다),
  //   축선 직선 구간을 roads.js 에 넘긴다(#21 R5 D8).
  let palaceAxis = null;
  let palaceRoadAnchor = null;
  let palaceForecourt = null;   // 육조거리 광장 폴리곤(시전·논 배제에도 쓰인다)
  let palaceReservation = null;
  let palaceKeepOut = null;     // 길이 들어가면 안 되는 궁역·광장 폴리곤

  if (isCapitalTier && includePalace) {
    // 궁역(#88): 행각 공유 다일곽 궁궐. 한양=경복궁급 4일곽(108×150), capital=3일곽 축소판(58×90).
    //   축선 깊이가 커져 궁역이 배산(-z)쪽으로 확장 — 중심을 북으로 당겨 진입부(+z)가 도성 안에 앉게 한다.
    //   폭은 #21 R5 D5 에서 96→108 로 넓혔다: 정전 처마가 21.6→27.4m 로 길어지고
    //   행각 깊이가 3.0→4.6m 로 두꺼워져, 종전 폭에서는 측면 블록(동궁·궐내각사)과 정전곽 행각이
    //   관통했다. capital 은 측면 블록이 없어 정전곽 44 만 담으면 되므로 오히려 60→58 로 좁아진다
    //   (그만큼 도성 필지가 산다). palace.js tierSpec 의 w·d 와 반드시 같은 값이어야 한다.
    const tier = scale === 'hanyang' ? 'hanyang' : 'capital';
    const pw = tier === 'hanyang' ? 108 : 58, pd = tier === 'hanyang' ? 150 : 90;
    const pc = { x: 0, z: C.z - pd * 0.16 };   // 깊어진 축선을 북으로 상재(진입부 여유)
    const palaceParcel = reservedParcel(pc, coreFrontDir, pw, pd, {
      placement: 'landmark', kind: 'palace', roofRank: 'palace',
      seed: (seed ^ 0x9a11) >>> 0,
    });
    // 궁역도 일반 필지와 같은 poly·남측 일조 회랑을 보존한다. 렌더용 축약 feature만
    // 남기면 보호수와 숲 worker가 궁궐을 빈 땅으로 오인한다.
    features.palace = { ...palaceParcel, x: pc.x, z: pc.z, tier, roofRank: 'palace' };
    blockers.push(palaceParcel);
    palaceReservation = palaceParcel;
  } else if (houseTarget <= 0 && (typeof opts.houses === 'number' || templeSolo)) {
    // 집 없는 구성(#114): houses:0 명시 시 예약 코어(종가·관아)도 생략 — "절 하나만"(includeTemple)
    //   또는 빈 산세 구성. 엔진은 hero 부재 시 부감 랜딩 폴백(기존 경로).
  } else if (isCapitalTier) {
    // 궁 없는 도성풍: 중심에 대형 관아(객사) 코어
    const coreCenter = coreCenterBehindGate(C, coreFrontDir, 34);
    const core = reservedParcel(coreCenter, coreFrontDir, 42, 34, {
      hero: true, heroStyle: 'palace', roofRank: 'magistracy',
      kind: 'giwa', rank: 1, seed: (seed ^ 0x5a11) >>> 0,
    });
    features.govCore = {
      x: coreCenter.x, z: coreCenter.z, frontDir: coreFrontDir, roofRank: 'magistracy',
    };
    blockers.push(core);
  } else if (scale === 'town') {
    // 관아 코어(객사 남향) — 배산 아래 중앙. 궁 복제가 아니라 magistracy roof rank (#150 C).
    blockers.push(reservedParcel(coreCenterBehindGate(C, coreFrontDir, 32), coreFrontDir, 40, 32, {
      hero: true, heroStyle: 'palace', roofRank: 'magistracy',
      kind: 'giwa', rank: 1, seed: (seed ^ 0x5a11) >>> 0,
    }));
  } else {
    // 씨족촌 종가 — 명당(중심), 남향(동구쪽) -> 림 라이트 최적 방향
    const plotW = scale === 'village' ? 28 : 26, plotD = scale === 'village' ? 26 : 24;
    blockers.push(reservedParcel(coreCenterBehindGate(C, coreFrontDir, plotD), coreFrontDir, plotW, plotD, {
      hero: true, heroStyle: 'hanok', roofRank: 'giwa',
      kind: 'giwa', rank: 1, seed: (seed ^ 0x5a11) >>> 0,
    }));
  }

  // ── 2.5) 성곽·사대문 (한양 전용) ── 도로 생성 전에 게이트를 확정해 간선을 성문과 정렬한다.
  //   내사산 능선을 잇는 부정형 폐곡선(joseon-city 규칙 2) — 여기선 스펙(순수 데이터)만, 렌더는 citywall.js.
  // 성곽 강제 오버라이드(#91): auto=hanyang 자동, true/false=강제. planCityWall 은 공유 rng를 소비하지
  //   않는 순수 site 파생이다. 강제 ON에서도 필지는 성 안·위성 부락은 성 밖이라는 같은 배치 계약을 쓴다.
  //   hanyang 강제 OFF는 도로의 성문 정렬이 사라져 하류가 달라진다(비기본이지만 seed 결정론은 유지).
  const corePolys = blockers.map((b) => b.poly).filter(Boolean);
  if (wantWall && !wallSupported) {
    warnings.push(`성곽은 초락(R≥${CITY_WALL_MIN_SITE_R})부터 유효 — R=${Math.round(siteR)}에서 생략됨`);
  }
  const cityWall = wantWall && wallSupported ? planCityWall(site, seed, corePolys) : null;
  if (cityWall) features.cityWall = cityWall;

  // ── 2.6) 궁역 앞 도시면: 광장 · 육조거리 축선 · 관아 슬롯 · 궁장 밖 이격 (#21 R5 D8·D14·E) ──
  //   좌표는 palace-precinct-plan.js 가 단일 소스다(렌더러·게이트가 같은 수를 읽는다).
  //   성곽 뒤에 오는 이유: 육조거리의 실제 길이는 정문에서 **종로 축**까지이고, 그 축은
  //   성곽 윤곽이 결정한다. 궁 예약 폴리곤은 이미 corePolys 로 성곽에 반영됐고, 여기서 다는
  //   것은 blocker 뿐이라 성곽 계산은 종전과 같다(시드 스트림 불침해 — 이 블록은 rng 미소비).
  if (palaceReservation) {
    const gate = palaceGatePoint(palaceReservation);
    const axisDir = G.norm(palaceReservation.frontDir);
    const jongnoZ = cityWall?.axes?.jongnoZ;
    const axisSpan = Number.isFinite(jongnoZ)
      ? Math.max(0, G.dot(G.sub({ x: 0, z: jongnoZ }, gate), axisDir))
      : Infinity;
    const front = palaceUrbanFrontPlan(palaceReservation, { axisSpan });
    palaceAxis = front.axis;
    palaceRoadAnchor = front.axis.origin;
    // 광장: 건물 없는 흙 마당. 시전 점포·민가·논 모두 여기 들어오지 못한다. 성문 문전 마당과
    //   같은 blocker 단계라 시드 스트림 순서는 그대로고, 후보 수락 여부만 바뀐다.
    if (front.plaza) {
      palaceForecourt = front.plaza;
      blockers.push({
        poly: palaceForecourt,
        palacePlaza: true,
        solarObstruction: false,   // 빈 마당 — 그림자를 드리우지 않는다.
      });
    }
    // 궁장 밖 이격 링 — 민가가 담에 붙어 궁역 윤곽을 지우는 것을 막는다.
    blockers.push({
      poly: front.clearance,
      palaceClearance: true,
      solarObstruction: false,   // 궁역 본체가 이미 일조 예약을 한다(중복 예약 금지).
    });
    // 같은 폴리곤들을 도로 금지 구역으로도 넘긴다 — 길은 blocker 를 보지 않는다.
    //   관아 슬롯도 포함한다: 예약 필지는 도로 여유 검사를 건너뛰므로, 넣지 않으면 골목이
    //   관아 지붕을 관통한다(check-layout-contract 의 "roof overlaps a road ribbon").
    palaceKeepOut = [front.clearance, ...(front.plaza ? [front.plaza] : [])];
    // 육조 관아: 광장 좌우 변에 **궁과 같은 좌향**으로 늘어선 대형 기와 필지(좌향 근거는
    //   palace-precinct-plan#palaceMagistracySlots 주석). 궁 전각의 복제가 아니라
    //   magistracy 등급이고(#150 C), 히어로 재질셋을 공유하므로 드로우콜은 heroCap 차감으로
    //   상쇄된다(parcels.js heroBudget). 급경사·분지 밖 슬롯은 조용히 생략한다.
    for (const slot of front.magistracy) {
      const magistracy = reservedParcel(slot.center, slot.frontDir, slot.plotW, slot.plotD, {
        hero: true, heroStyle: 'hanok', roofRank: 'magistracy', heroBudget: true,
        magistracySlot: true,
        kind: 'giwa', rank: 1,
        seed: (seed ^ (0x6a00 + slot.index * 7 + (slot.side > 0 ? 0x40 : 0))) >>> 0,
      });
      if (!worldEdgeContainsPolygon(site.edge, magistracy.poly, 6)) continue;
      if (cityWall && !cityWallContainsPolygon(cityWall, magistracy.poly, 6)) continue;
      let low = Infinity, high = -Infinity;
      for (const corner of magistracy.poly) {
        const y = site.heightAt(corner.x, corner.z);
        if (y < low) low = y;
        if (y > high) high = y;
      }
      if (high - low > 2.2) continue;            // 한 계단 성토로 감당 못 하는 사면은 생략
      if (site.hillAt(slot.center.x, slot.center.z) > 0.52) continue;
      blockers.push(magistracy);
      palaceKeepOut.push(magistracy.poly);
    }
  }
  // 관아 슬롯도 hero 예약이지만 간선 앵커는 아니다 — 앵커는 종가/객사 코어 또는 궁 정문이다.
  const coreParcel = blockers.find((blocker) => blocker.hero && !blocker.magistracySlot);
  const coreRoadAnchor = palaceRoadAnchor || (coreParcel
    ? parcelWorldPoint(coreParcel, { x: 0, z: coreParcel.plotD * 0.5 })
    : null);
  const layoutOpts = (cityWall || coreRoadAnchor)
    ? {
      ...norm,
      ...(cityWall ? { cityWall } : {}),
      ...(coreRoadAnchor ? { coreRoadAnchor } : {}),
      ...(palaceAxis ? { palaceAxis } : {}),
      ...(palaceKeepOut ? { palaceKeepOut } : {}),
    }
    : norm; // 생성 중에만 주입; 반환 plan에는 features가 단일 소스.

  // ── 3) 도로 (간선 결정론 + 이면 유기) ──
  const roadsResult = templeSolo
    ? { roads: [], nodes: { junctions: [] } }
    : planRoads(site, layoutOpts, rng);

  // 한강급 수계는 도성 남문에서 끝나지 않고 나루 반대편의 성저 취락으로
  // 이어진다. 성벽 클립 이후에 외곽 길을 추가하고 정규 접합 메타데이터를 한 번만
  // 재계산해, 렌더러 전용 리본이 아닌 픽킹·필지·검증이 공유하는 실제 길로 남긴다.
  const riverPort = planRiverPort(site, seed);
  if (riverPort) {
    roadsResult.roads.push(...riverPort.roads);
    roadsResult.nodes.junctions = attachRoadJunctions(roadsResult.roads);
    features.riverPort = riverPort;
  }

  // The enclosed Andong-area house is never inferred from weather, rank, or
  // coordinates. Only an explicit source-context opt-in may replace the one
  // reserved clan head house, and only at the hamlet/village scales that
  // actually own that role. Default plans do not enter this branch, preserving
  // their exact object shape and RNG stream.
  let mjaHouse = null;
  if (opts.mjaHouse != null) {
    const mjaScale = siteR >= resolveSiteR('hamlet')
      && (scale === 'hamlet' || scale === 'village');
    const mjaCore = mjaScale
      ? blockers.find((blocker) => blocker.hero && blocker.heroStyle === 'hanok')
      : null;
    mjaHouse = attachOptInMjaHouse({
      context: opts.mjaHouse,
      core: mjaCore,
      coreRoadAnchor,
      roads: roadsResult.roads,
      char01,
      tuning,
    });
    if (mjaHouse) norm.mjaHouse = mjaHouse.context;
    else warnings.push('ㅁ자 반가는 초락·마을의 fitted 종가와 명시적 지역·기후·가계 문맥에서만 구성됨');
  }

  // ── 3.25) 사찰 대지·진입로 예약 ── 사찰은 남은 급사면에 사후 삽입되는 장식물이 아니라,
  //   완만한 대지와 물·길의 관계를 먼저 읽고 자리를 잡는다. 산의 위요감은 좋은 선택지 중 하나일
  //   뿐 필수 조건이 아니다. 도로가 확정된 직후
  //   footprint와 접근로를 예약해 필지·시전·위성 부락·논이 그 공간을 선점하지 않게 한다.
  //   seed 파생 전용 경로라 공유 rng를 소비하지 않으며 temple OFF의 하류 plan은 그대로다.
  let templeReservations = [];
  if (includeTemple) {
    features.temple = planTempleSite({
      site,
      seed,
      roads: roadsResult.roads,
      occupied: corePolys,
      cityWall,
    });
    templeReservations = templeReservationPolygons(features.temple);
    templeReservations.forEach((poly, index) => blockers.push({
      poly,
      templeReserve: true,
      // The precinct can cast a shadow; the remaining reservation polygons are
      // only a walkable approach and must not be treated as tall structures.
      solarObstruction: index === 0,
    }));
  }

  // ── 3.5) 시전행랑 (한양) ── 간선(주작대로·종로) 파사드를 따라 연립 벽식 점포(선형 상업, 규칙 7).
  //   점포 footprint 를 blockers 에 넣어 일반 필지가 대로변 상가 열을 침범하지 않게 한다.
  // 시전 강제 오버라이드(#91): auto=hanyang, true/false=강제. planSijeon 은 간선(daero) 파사드가 있어야
  //   점포가 나므로 daero 를 만드는 capital·hanyang 에서만 실효(그 외 강제 ON 은 빈 배열=무영향). 점포
  //   footprint 는 blocker 라 강제 ON 시 일반 필지 배치가 그만큼 달라진다(의도된 구성 변화, 결정론).
  const wantSijeon = tuning.sijeon === true ? true : tuning.sijeon === false ? false : (scale === 'hanyang');
  if (wantSijeon) {
    // 도성은 행랑을 성문까지 이어 붙인다(docs/joseon-city.md §시전행랑: 종루~남대문·종묘~동대문 구간).
    //   분지 0.9R 컷은 그 구간을 성문 100~300m 앞에서 끊었다. 단 문전 마당은 비워 두어야 하므로
    //   마당 안쪽은 reach 에서 제외한다 — 넓은 가로가 좁은 홍예로 수렴하는 압축이 마당에서 완성된다.
    const gateForecourts = cityWall
      ? cityWall.gates.map((gate) => cityGateForecourtPolygon(gate,
        { length: GATE_FORECOURT_PLAN_DEPTH }))
      : [];
    // 육조거리(궁 정문 광장)는 상업 가로가 아니다 — 시전 행랑은 종로·남대문로의 몫이고,
    //   관아 열 사이에 점포가 끼면 축선이 상가로 읽힌다(#21 R5 D8, 실측 2026-08-02: 광장
    //   길이 70m 일 때 축선 70~84m 대역에 점포 12~14채). 점포는 blocker 를 보지 않으므로
    //   성문 문전 마당과 같은 방식으로 reach·필터 양쪽에 광장을 명시한다.
    const forecourts = palaceForecourt ? [...gateForecourts, palaceForecourt] : gateForecourts;
    const sijeonReach = (cityWall || palaceForecourt)
      ? (pt) => (!cityWall || cityWallClearance(cityWall, pt) >= SIJEON_WALL_INSET)
        && !forecourts.some((poly) => G.pointInPoly(pt, poly))
      : undefined;
    // 성곽 도성은 (도로,면)당 프리픽스 캡을 풀고 reach 에 맡긴다 — 캡이 26이던 동안 도성 전체
    //   행랑 51레코드가 전부 종로 서단 151m(도로의 22.1%)에 몰려, 나머지 세 성문 접근로에는
    //   행랑이 원리적으로 나올 수 없었다(실측 2026-08-04). 문서가 단언하는 구간은 종루~남대문·
    //   종묘~동대문이고 규칙 7 은 "간선 양측 파사드를 따라 연속 배치"다.
    const sijeonRunCap = cityWall ? Infinity : undefined;
    // 예약 코어(궁·관아·종가)의 30° 일조 통로는 행랑이 비운다. 예약 코어는 행랑보다 **먼저** 자리를
    //   잡으므로 후보를 스스로 기각할 수 없다 — 일반 필지·위성 부락은 점포 footprint 를 일조
    //   장애물로 이미 보고 있지만(planParcels/planSatellites 의 solarObstacles), 코어에는 그 경로가
    //   없다. 캡을 풀어 파사드를 연속으로 만들자 종로 북면 행랑이 축선 반가(x=±39) 남쪽 채광 통로에
    //   들어왔다(실측 2026-08-04: 4시드 전부 코어 2채씩, 시드당 3~4레코드). 여기서 걸러 내면
    //   파사드에 코어 진입 골목만큼의 틈이 생기고, 계약(check:layout)이 그대로 유지된다.
    const coreSolarAccess = blockers
      .filter((blocker) => blocker.hero && blocker.solarObstruction !== false)
      .map((blocker) => parcelSolarAccessPolygon(blocker));
    features.sijeon = planSijeon(roadsResult, site, char01,
      { reach: sijeonReach, runCap: sijeonRunCap }).filter((shop) =>
      worldEdgeContainsPolygon(site.edge, shop.poly, 6)
      && (!cityWall || cityWallContainsPolygon(cityWall, shop.poly, 4))
      && !forecourts.some((poly) => G.polysOverlap(shop.poly, poly))
      && !coreSolarAccess.some((poly) => G.polysOverlap(shop.poly, poly))
      && !templeReservations.some((poly) => G.polysOverlap(shop.poly, poly)));
    for (const s of features.sijeon) blockers.push({ poly: s.poly });
  }

  // ── 3.6) 문전 마당 (한양, R3-B 2026-07-31) ── 성문 안쪽 접근 예약을 **필지 배치에도** 적용한다. 이 예약은 지금까지
  //   식생(cityWallVegetationBlocked)에만 걸려 있어서, 일반 필지가 육축 13m 앞까지 붙었다
  //   (hanyang/7 남문 최근접 필지정점 13.8m·접근구역 내 정점 20개). 시전 점포와 같은 blocker 단계에
  //   넣어 시드 스트림 순서를 보존한다(추첨 순서를 바꾸지 않고 후보 수락 여부만 바꾼다).
  //   마당의 근거·치수는 citywall-contour.js#cityGateForecourtPolygon 주석 참조(고증: 문 안쪽
  //   의례 광장은 미검증 — docs/joseon-city.md §성문 주변, docs/credits.md #52).
  //   실측(2026-07-31): hanyang 계획 해시만 이동, 다른 규모 골든 불변. aerial 드로우콜 1205→1205·
  //   tris 4.28M 불변(shoot-cityperf 동일 하네스 연속 측정), eye 차이는 LOD 상태(MID 2→0)다.
  if (cityWall) {
    for (const gate of cityWall.gates) {
      // 빈 마당이므로 그림자를 드리우지 않는다(solarObstruction:false) — 필지 겹침만 막는다.
      //   `kind` 는 쓰지 않는다: planParcels 가 kind 를 "집이 있는 예약"으로 읽어 일조 예약 경로로
      //   보내고 거기서 center 를 요구한다(절 예약도 같은 이유로 kind 를 쓰지 않는다).
      //   깊이는 GATE_FORECOURT_PLAN_DEPTH(사용자 결정 2026-08-04) — 통행 예약 47m 은 식생·도로에
      //   그대로 남고, 필지·시전 배제만 축소된다.
      blockers.push({
        poly: cityGateForecourtPolygon(gate, { length: GATE_FORECOURT_PLAN_DEPTH }),
        gateForecourt: true,
        solarObstruction: false,
      });
    }
  }

  // ── 4) 필지 (도로변 분할 + 위계 그라디언트) ──
  const frontage = planParcels(site, roadsResult, layoutOpts, rng, blockers);
  // 예약 코어 중 실제 필지로 렌더할 것(궁 제외)만 parcels 에 포함
  const reserved = blockers.filter((blocker) => blocker.hero);
  // ── 4.5) 위성 부락(#120) ── 본동에서 조금 떨어진 완사면 포켓에 작은 무리(몇 채). rng 소비 없는 전용
  //   시드 경로(공유 rng 불침해 → 상류 결정론 보존, 위성 OFF 회귀 안전). 겹침 회피에 기존 필지·예약 코어
  //   polygon 을 넘긴다. cityWall 이 있으면 실제 부정형 윤곽 바깥만 허용한다.
  const satExisting = [
    ...blockers.map((blocker) => blocker.poly).filter(Boolean),
    ...frontage.map((parcel) => parcel.poly),
  ];
  const satellites = planSatellites(site, norm, seed, {
    existing: satExisting,
    residential: [...reserved, ...frontage],
    solarObstacles: blockers
      .filter((blocker) => !blocker.kind && blocker.solarObstruction !== false)
      .map((blocker) => blocker.poly),
    cityWall,
    roads: roadsResult.roads,
    riverPort,
  });
  const parcels = [...reserved, ...frontage, ...satellites];
  // 안정적 필지 ID(시드 고정 → 같은 seed 는 같은 id 순서) — 인스턴싱·픽킹·편집의 키.
  parcels.forEach((p, i) => { p.id = `p${i}`; });
  // 집 변주 필드(평면 프로토·톤·yaw·스케일·담 유형·부속채) — parcel.seed 결정론(variants.js).
  //   #91 어휘 옵션(다양성 강도·담장 분포)을 tuning 으로 전달(무옵션 시 현행 정확 재현, parcel-seed rng 격리).
  parcels.forEach((p) => {
    if (p.sx == null) {
      assignFittedVariation(p, char01, tuning, scale);
    }
  });
  // The variation roll retains the historical boolean probability, but a real
  // outbuilding is accepted only after its roof footprint can live inside the
  // final fitted parcel without blocking a gate, winter sun, the main house, or
  // existing yard work. A salted parcel-local planner keeps this pass outside
  // the shared village RNG window.
  const auxiliaryPeers = [
    ...parcels,
    ...(features.palace?.center ? [features.palace] : []),
  ];
  for (const parcel of parcels) {
    parcel.auxRequested = !!parcel.aux;
    const auxiliary = planParcelAuxiliary(parcel, {
      site,
      peers: auxiliaryPeers,
      hardObstacles: yardHardObstacles({
        ...parcel,
        auxiliary: null,
      }),
    });
    parcel.auxiliary = auxiliary;
    if (!auxiliary) parcel.aux = false;
  }

  // ── 5) 정자 ──
  // 씨족촌의 동구 정자 / 읍치·도성의 중심 정자라는 의미는 유지하되, 고정 좌표를 찍어
  // 민가 위에 겹치거나 남측 일조·focus 회랑을 가리던 오류를 순수 배치 계약으로 막는다.
  // 작은 마을이 예전부터 소비하던 RNG 1회는 ±6.9° 도로향 jitter로 보존해 하류 seed를 흔들지 않는다.
  const pavilionRotationJitter = (scale === 'hamlet' || scale === 'village')
    ? (rng.range(0, 6.28) / 6.28 - 0.5) * 0.24
    : 0;
  const pavilionParcels = [
    ...parcels,
    ...(features.palace?.poly ? [features.palace] : []),
  ];
  const pavilionPlanInput = {
    site,
    scale,
    roads: roadsResult.roads,
    parcels: pavilionParcels,
    cityWall,
    rotationJitter: pavilionRotationJitter,
  };

  // ── 6) 돌다리 (개울 위, 진입 스파인 교차점) ──
  if (site.stream) {
    if (site.stream.kind === 'river') {
      const d = 1;
      const tangent = G.norm({
        x: d * 2,
        z: site.streamZat(d) - site.streamZat(-d),
      });
      let across = G.perpL(tangent);
      if (across.z > 0) across = G.mul(across, -1); // local +X = north bank
      features.ferry = {
        x: site.stream.cross.x,
        z: site.stream.cross.z,
        rot: Math.atan2(-across.z, across.x),
        span: site.stream.width + 12,
        waterWidth: site.stream.waterHalf * 2,
        north: site.stream.northLanding,
        south: site.stream.southLanding,
        boatCount: scale === 'hanyang' ? 3 : 2,
      };
    } else {
      const wallApproach = cityWall
        ? roadsResult.roads.find((road) => road.wallApproach?.gate === 'south')
        : null;
      const crossing = roadStreamCrossing(wallApproach, site, cityWall);
      const cx = crossing?.point || site.stream.cross;
      const tanS = G.norm(G.sub(site.stream.pts[Math.min(site.stream.pts.length - 1, 37)], site.stream.pts[35]));
      const across = crossing?.tangent || G.perpL(tanS);
      const rot = Math.atan2(-across.z, across.x);   // 다리 로컬 X(span)를 개울 횡단 방향으로
      // 데크가 건너야 하는 폭. 농촌 개울은 하도 전폭(완경사 둑이라 그 밖이 곧 벤치)이고, 개착 하도는
      //   수직 석축 **천단 사이**다 — 하도 전폭만 쓰면 데크 끝이 석축 뒤채움 사면에 걸린다.
      const crossWidth = bridgeCrossWidth(site, cx.x);
      let span = crossWidth + 5;
      let width = scale === 'hamlet' ? 1.8 : 2.4;
      if (crossing) {
        span = crossWidth / crossingSkew(site, cx.x, crossing.tangent) + 5;
        width = wallApproach.width + 1;
      }
      // 반촌=격식 홍예교, 민촌=소박 판석교, 여염=규모 따라. 단 **도성 개천은 예외 없이 평석교**다:
      //   구한말 도성 사진 판독이 "홍예 없는 평평한 석판 + 짧은 돌기둥"이고(docs/joseon-city.md
      //   §개천), 현존 사례로 열거되는 개천의 다리도 수표교·광통교·살곶이다리 = 전부 평석교다
      //   (한국민족문화대백과사전 「평석교」). char01 로 홍예를 고르면 도성이 0.66 이라 개천에
      //   무지개다리가 놓였다.
      const bridgeType = site.stream.urban ? 'slab'
        : char01 < 0.34 ? 'slab'
          : (char01 >= 0.66 || scale === 'town' || scale === 'capital') ? 'arch' : 'slab';
      features.bridges.push({
        x: cx.x, z: cx.z, rot, type: bridgeType,
        span, width,
      });
      // ── 나머지 횡단부에도 다리를 놓는다 ──────────────────────────────────────
      // 위 블록은 성문 접근 간선 **한 곳**만 다리를 놓았고, 개천이 도성을 관류하게 되면서 다른
      //   간선·골목도 물을 건너게 됐다(실측 2026-08-01: hanyang seed 7/1/11 에서 교량 없는 횡단
      //   2·2·3곳 — 길이 물 위를 그냥 지나갔다). 고증도 다리는 하나가 아니다: 개천 위에는 광교
      //   등 **24개의 다리**가 놓였다(docs/joseon-city.md §개천). 그래서 남은 횡단부마다 그 길의
      //   폭으로 다리를 놓는다. 첫 다리 spec 은 위에서 그대로 확정되므로 횡단부가 하나인 시드의
      //   계획 바이트는 변하지 않는다.
      for (const extra of roadStreamCrossings(roadsResult.roads, site)) {
        if (G.dist(extra.point, cx) <= BRIDGE_MERGE_DISTANCE) continue;
        if (features.bridges.some((b) => G.dist(b, extra.point) <= BRIDGE_MERGE_DISTANCE)) continue;
        if (crossingSkewRaw(site, extra.point.x, extra.tangent) < BRIDGE_MIN_SKEW) continue;
        const extraWidth = bridgeCrossWidth(site, extra.point.x);
        features.bridges.push({
          x: extra.point.x, z: extra.point.z,
          rot: Math.atan2(-extra.tangent.z, extra.tangent.x),
          type: 'slab',   // 지선 횡단은 소박한 판석교 — 격식 홍예는 성문 접근 간선의 몫이다.
          span: extraWidth / crossingSkew(site, extra.point.x, extra.tangent) + 5,
          width: extra.road.width + 1,
        });
      }
    }
  }

  // ── 7) 다랑이 논 (개울 남쪽 저지) — 민촌일수록 농경 비중↑(논 촘촘), 반촌은 성글게 ──
  const paddyObstacles = [
    ...parcels.map((parcel) => parcel.poly),
    ...(features.palace?.poly ? [features.palace.poly] : []),
    ...(palaceForecourt ? [palaceForecourt] : []),   // 육조거리 광장은 논도 받지 않는다
    ...templeReservations,
  ];
  // 논 후보 RNG는 전부 소비한 뒤 실제 필지와 겹치는 배미만 걷어 낸다. 필터 때문에 뒤쪽
  // 소품/절 seed 흐름이 달라지지 않으면서 담·처마 아래 논 표면이 비치는 오류를 막는다.
  let paddies = null;
  if (site.paddyRegion) {
    // roadsResult 회랑 탈락은 planPaddies 내부 셀 게이트(hillAt 단계)에서 처리한다.
    // 호출 시그니처만 도로 배열을 넘기며, 후보 RNG 소비 규율은 planPaddies가 유지한다.
    const candidates = planPaddies(site, rng, char01, tuning.paddyDensityK, roadsResult.roads,
      { walled: !!cityWall });
    paddies = [];
    // 후보·tone RNG를 전부 소비한 뒤 stable first-wins로 공간 계약만 적용한다. 인접 셀 지터가
    // 논둑을 포개도 뒤 소품 seed는 불변이고, 화면에는 한 겹의 온전한 배미만 남는다.
    for (const field of candidates) {
      if (streamIntersectsPolygon(site, field.poly, STREAM_PADDY_BANK_CLEARANCE)) continue;
      // 성곽 도성(#20 R4): 개천이 도성 안을 관류하게 되면서 "물 남쪽 = 논"이라는 농촌 규칙이
      //   성 안까지 밀려 들어왔다(실측 2026-07-31: hanyang/2026 배미 8장이 성벽 안에 앉음).
      //   논은 성저십리 — 성 밖 들이다. 후보 rng 를 전부 소비한 뒤의 공간 계약이므로 추첨 순서는
      //   불변이고, 성곽이 없는 규모(cityWall === null)는 이 줄을 지나가지 않는다.
      if (cityWall && !cityWallOutsidePolygon(cityWall, field.poly, PADDY_WALL_CLEARANCE)) continue;
      if (paddyObstacles.some((poly) => G.polysOverlap(field.poly, poly))) continue;
      if (paddies.some((accepted) => G.polysOverlap(field.poly, accepted.poly))) continue;
      paddies.push(field);
    }
  }

  // 보호수는 scale별 필수 landmark이므로 먼저 실제 수관을 예약한다. 정자를 먼저 고정해
  // 동구 당산나무를 밀어내거나, 유일한 초락 배미를 지우지 않는다.
  features.guardianTrees = planGuardianTrees({
    scale,
    features,
    parcels,
    paddies,
    roads: roadsResult.roads,
  }, site, seed);

  // 논과 보호수의 stable 예약을 모두 보존한 채 정자가 남향 주거 회랑 사이의 빈터를 찾는다.
  features.pavilion = planPavilion({
    ...pavilionPlanInput,
    occupied: [
      ...parcels.map((parcel) => parcel.poly),
      ...(features.palace?.poly ? [features.palace.poly] : []),
      ...(features.sijeon || []).map((shop) => shop.poly),
      ...templeReservations,
      ...(paddies || []).map((field) => field.poly),
    ],
    reservedCircles: features.guardianTrees,
  });

  // ── 8) 소품 (동구 장승·솟대, 종가 앞 우물·장독대, 성격별 액센트) ──
  features.props = planPublicProps({
    features,
    site,
    scale,
    rng,
    char01,
    parcels: pavilionParcels,
    roads: roadsResult.roads,
    pavilion: features.pavilion,
    reservedCircles: features.guardianTrees,
    occupied: [
      ...parcels.map((parcel) => parcel.poly),
      ...(features.palace?.poly ? [features.palace.poly] : []),
      ...(features.sijeon || []).map((shop) => shop.poly),
      ...templeReservations,
      ...(paddies || []).map((field) => field.poly),
    ],
  });

  // 도로·필지·논이 모두 확정된 뒤에만 배수 계약을 세운다. 배수 계획은 RNG를 소비하지
  // 않으므로 기존 마을의 후속 결정론을 바꾸지 않으며, 농촌 규모는 고증상 명시적인 empty
  // plan을 유지한다. renderer는 이 world-space plan을 그대로 조립할 뿐 배치를 추론하지 않는다.
  const drainage = planRoadsideDrainage({
    roads: roadsResult.roads,
    parcels,
    site,
    productionPolygons: paddies || [],
  });

  // 보호수 수관 아래의 선택적 당산 문화경관(의례 공터·당집). 전용 seed stream을 쓰므로
  // 기존 plan RNG·worker 해시를 흔들지 않고, hamlet/village 낮은 빈도 또는 opts.dangsan
  // 강제 시에만 시도한다. 실패는 empty plan으로 fail-closed.
  const dangsan = planDangsan({
    scale,
    seed,
    site,
    guardians: features.guardianTrees,
    parcels,
    roads: roadsResult.roads,
    paddies: paddies || [],
    pavilion: features.pavilion,
    props: features.props,
    cityWall: features.cityWall,
    dangsan: opts.dangsan,
  });

  const allPts = [...roadsResult.roads.flatMap((r) => r.pts), ...parcels.map((p) => p.center)];
  const bounds = G.boundsOfPts(allPts.length ? allPts : [site.center]);

  return {
    opts: norm, seed, scale, warnings,
    site,
    roads: roadsResult.roads,
    nodes: roadsResult.nodes,
    parcels,
    paddies,
    drainage,
    dangsan,
    features,
    bounds,
    stats: {
      houses: parcels.length,
      giwa: parcels.filter((p) => p.kind === 'giwa').length,
      choga: parcels.filter((p) => p.kind === 'choga').length,
      auxiliaries: parcels.filter((p) => p.auxiliary).length,
      satellites: satellites.length,            // 위성 부락 필지 수(#120)
      bowlK,                                     // footprint 종속 분지 계수(#120)
      roads: roadsResult.roads.length,
      paddies: paddies ? paddies.length : 0,
      drainageRuns: drainage.runs.length,
      drainageCrossings: drainage.crossings.length,
      dangsanSites: dangsan.sites.length,
      ...(mjaHouse ? { mjaHouses: 1 } : {}),
      parcelDebug: planParcels.lastDebug,
    },
  };
}

// 다랑이 논: 개울 남쪽 저지를 완만한 계단식 필드로 분할(등고 순응 지터).
// 수평 슬래브 배미의 결함은 내부 낙차(매몰·다랑이 계단)가 아니라 지형 위 부유뿐이다.
//   maxFloat = slabY − min(꼭짓점·변중점 heightAt). 매몰(음수 float)은 정상 계단 읽힘.
// roads 인자는 회랑 검사용이며 rng 를 소비하지 않는다.
// PADDY_MAX_FLOAT: 정상 다랑이(매몰+완만한 하향 부유) 보존, 병적 부유만 절단.
//   seed 20260716 · 도로 게이트 ON · 부유 게이트 OFF 분포(최종 배미):
//     hamlet n=1 maxFloat≈4.99 · village n=2 ≈4.54–5.23 · town n=3 ≈3.86–4.09
//     capital n=6 ≈3.01–6.70 · hanyang n=5 ≈5.44–9.31
//   병적 셀(hanyang x0–35/z200–224, 지터 전 full cell) maxFloat≈9.35 (inset≈8.88; 조사 9.78과 동일 축).
//   2.5–3.5m 은 전 배미를 지워 기각. 농촌·capital 상한(≤6.70) 위 · 병적(≥8.2) 아래 → 8.0m.
const PADDY_MAX_FLOAT = 8.0;           // 슬래브 부유 상한(m); 내부 낙차 게이트는 사용하지 않음
// 도로 여유 2.0m 은 도로에 "인접"한 정상 배미(고증상 길이 논둑을 따라 붙는 게 자연스러움)까지 잘라
// 논 하한 계약(PADDY_TOTAL_FLOOR)을 깼다. 결함의 본질은 리본 면 위의 논이므로 지붕-도로 계약(0.2m)과
// 같은 자릿수의 최소 여유만 둔다.
const PADDY_ROAD_CORRIDOR_M = 0.4;     // 도로 회랑 반폭 = road.width/2 + 이 값(m)

function paddyMaxFloat(site, poly, slabY) {
  let minH = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const ha = site.heightAt(a.x, a.z);
    const hm = site.heightAt((a.x + b.x) * 0.5, (a.z + b.z) * 0.5);
    if (ha < minH) minH = ha;
    if (hm < minH) minH = hm;
  }
  return slabY - minH;
}

function planPaddies(site, rng, char01 = 0.5, paddyK = 1, roads = [], { walled = false } = {}) {
  const pr = site.paddyRegion;
  const fields = [];
  // 작은 다랑이 계단(≈18×13m)으로 잘게 나눈다 — 큰 잔디밭이 아니라 논배미로.
  //   도성급(R>300)은 성저십리 평야라 논배미를 다소 크게 나눈다(필드 수·생성비 관리).
  //   #78 성저십리 논 서사 회복: #77 능선 압축으로 남측 hillAt 가 전반 상승해 논배미가 34→11 로
  //     성겨짐. 완사면 다랑이 논을 허용(hillMax↑)하고 셀을 잘게(top-down 가독) 나눠 대역을 되살린다.
  //     좌청룡·우백호(측면 능선) 열은 xInset 으로 배제해 급사면 관통을 막는다. hanyang 한정(big).
  const big = site.R > 300;
  const cell = big ? 34 : 20, cellD = big ? 24 : 15;
  const xInset = big ? 0.10 * (pr.xMax - pr.xMin) : 0;      // 성저십리 좌우 능선 여백
  const xMin = pr.xMin + xInset, xMax = pr.xMax - xInset;
  // 완사면 다랑이 허용(도성만; 타 규모 불변). 성곽 도성(#20 R4)은 한 단 더 푼다: 개천이 도성 안으로
  //   들어가면서 성저 들이 더는 **개울 골짜기의 평탄면**에 앉지 않게 됐고(구 개울 z=150 의
  //   streamValleyWeight 가 이 대역의 hillAt 를 0 으로 눌러 주고 있었다), 그 결과 hillAt 표고 프록시가
  //   belt 를 통째로 기각해 한양 논이 0장이 됐다(실측 2026-07-31, 계약 하한 6장 위반). 이 대역의 실제
  //   경사는 안산 하부 완사면 3~18% 이고, 병적 부유는 아래 post-rng 부유 게이트(PADDY_MAX_FLOAT)와
  //   성벽 밖 계약이 잡는다 — 즉 표고 프록시는 여기서 안전장치가 아니라 오탐이다.
  //   0.70 은 실측으로 고른 값이다: 0.70 → 성저 배미 22~27장(부유 ≤6.1m), 0.80 → 30~39장(≤7.6m),
  //   0.95 → 43~56장. 구 belt 밀도(30장급)와 부유 여유를 함께 만족하는 것이 0.70 이다.
  const hillMax = walled ? 0.70 : big ? 0.40 : 0.28;
  const cols = Math.max(4, Math.round((xMax - xMin) / cell));
  const rows = Math.max(2, Math.round((pr.zFar - pr.zNear) / cellD));
  // 반촌일수록 논배미 성글게(농경 비중↓). #89: char01 이 규모 파생이 되며 도성(char01↑)의 논이
  //   과도하게 성겨졌다(성저십리 논 32장으로 하락). 드롭률을 기존 기본(char01 0.5 → 0.2) 상한으로
  //   클램프해 대규모 성저십리 벨트를 보존한다 — 저규모(char01<0.5) 그라디언트는 그대로.
  //   #91 논 밀도 배율(paddyK): 유지확률 = (1-기본드롭)·paddyK 로 사상 → paddyK=1 은 현행 dropP 정확 재현,
  //   >1 촘촘(드롭↓)·<1 성글게·0 무논. 셀당 드롭 판정 rng 는 그대로 1회(밀도만 시프트).
  const dropBase = Math.min(0.2, char01 * 0.4);
  const dropP = Math.min(1, Math.max(0, 1 - (1 - dropBase) * paddyK));
  const cw = (xMax - xMin) / cols;
  const rd = (pr.zFar - pr.zNear) / rows;
  // 도로 회랑 인덱스 — 셀 게이트마다 전 선분을 훑지 않도록. 빈 roads 는 회랑 게이트 스킵.
  const roadSpatial = roads?.length ? createRoadSpatialIndex(roads) : null;
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      const x0 = xMin + c * cw, z0 = pr.zNear + r * rd;
      const cx = x0 + cw / 2, cz = z0 + rd / 2;
      if (site.hillAt(cx, cz) > hillMax) continue;           // 안산 기슭 급경사 제외(완사면은 허용)
      // 신규 부유·도로 게이트는 여기(pre-rng)가 아니라 아래 post-rng 재검사에만 둔다.
      // pre-rng 배치는 셀별 추첨(dropP·지터) 스트림을 밀어 멀쩡한 배미까지 복권으로 갈아치운다 —
      // 기존 hillAt 게이트는 히스토리 스트림의 일부지만 신규 게이트는 아니므로 소비 후에만 판정한다.
      const inset = 0.9;
      if (Math.abs(cz - site.streamZat(cx)) < site.streamHalf + 2) continue;
      if (rng() < dropP) continue;                          // 반촌: 논 일부 생략
      const j = (dx, dz) => ({ x: dx + rng.range(-cw * 0.06, cw * 0.06), z: dz + rng.range(-rd * 0.06, rd * 0.06) });
      const poly = [
        j(x0 + inset, z0 + inset), j(x0 + cw - inset, z0 + inset),
        j(x0 + cw - inset, z0 + rd - inset), j(x0 + inset, z0 + rd - inset),
      ];
      // 논배미마다 옅은 색편차(패치워크). 차분한 여름 초록·마른 논둑 톤.
      const tone = rng.pick([0x6a7b3f, 0x71803f, 0x62723a, 0x79794a, 0x6d7c42]);
      // 첫 단이 사행 수로에 닿으면 배미 전체를 버리지 않고 북변만 실제 남쪽 둑선까지 물린다.
      // 다음 단과의 간격은 그대로라 겹침이 생기지 않고, 수변에 맞춘 얕은 사다리꼴이 남는다.
      // tone까지 먼저 뽑아 기존 RNG 창을 끝낸 뒤 trim하므로 탈락 여부가 뒤 소품 seed를 흔들지 않는다.
      const safePoly = trimPaddyToStreamBank(site, poly, STREAM_PADDY_BANK_CLEARANCE);
      if (!safePoly) continue;
      // 지터·trim 후 실제 폴리곤 재검사. 이 셀의 rng 는 이미 전부 소비됐으므로 탈락해도
      // 이후 셀·후속 plan 단계의 rng 스트림은 변하지 않는다. 검증 계약은 최종 배미 기준.
      const safeCenter = G.polyCentroid(safePoly);
      const slabY = site.heightAt(safeCenter.x, safeCenter.z) + 0.06;
      if (paddyMaxFloat(site, safePoly, slabY) > PADDY_MAX_FLOAT) continue;
      if (roadSpatial && roadSpatial.intersectsRoadCorridor(safePoly, PADDY_ROAD_CORRIDOR_M)) continue;
      fields.push({ poly: safePoly, y: slabY, tone });
    }
  }
  return fields;
}

function trimPaddyToStreamBank(site, poly, margin) {
  if (!site.stream || !streamIntersectsPolygon(site, poly, margin)) return poly;
  const out = poly.map((point) => ({ ...point }));
  const minX = Math.min(...out.map((point) => point.x));
  const maxX = Math.max(...out.map((point) => point.x));
  let bankZ = -Infinity;
  // 한 배미 폭 안의 사행 최고점을 직선 북변으로 감싸 convex 계약을 보존한다.
  for (let i = 0; i <= 12; i++) {
    const x = minX + (maxX - minX) * i / 12;
    bankZ = Math.max(bankZ, site.streamZat(x) + site.streamHalf + margin + 0.08);
  }
  const southEdge = Math.min(out[2].z, out[3].z);
  if (southEdge - bankZ < 3.5) return null;
  out[0].z = Math.max(out[0].z, bankZ);
  out[1].z = Math.max(out[1].z, bankZ);
  // 선형 water ribbon의 접선 폭까지 포함한 최종 exact 판정. 드문 급굽이는 20cm씩 더
  // 물리되, 농사 가능한 최소 깊이 아래로 줄어들면 그 배미만 생략한다.
  for (let step = 0; step < 12 && streamIntersectsPolygon(site, out, margin); step++) {
    out[0].z += 0.2;
    out[1].z += 0.2;
    if (southEdge - Math.max(out[0].z, out[1].z) < 3.5) return null;
  }
  return streamIntersectsPolygon(site, out, margin) ? null : out;
}
