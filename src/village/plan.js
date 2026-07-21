import { makeRng, hashString } from '../rng.js';
import { makeSite, resolveSiteR, tierForR, rToScale01 } from './site.js';
import { planRoads } from './roads.js';
import { planParcels, planSatellites } from './parcels.js';
import {
  CITY_WALL_DIMENSIONS,
  CITY_WALL_MIN_SITE_R,
  cityWallClearance,
  cityWallContainsPolygon,
  planCityWall,
  worldEdgeContainsPolygon,
} from './citywall-contour.js';
import * as G from '../core/math/geom2.js';
import {
  attachParcelSpatialContract,
  parcelWorldPoint,
  rectangularParcelShape,
} from './parcel-contract.js';
import { planGuardianTrees } from './guardian-plan.js';
import { assignFittedVariation } from './house-footprint.js';
import {
  STREAM_PADDY_BANK_CLEARANCE,
  streamIntersectsPolygon,
} from './stream-spatial.js';
import { planTempleSite, templeReservationPolygons } from './temple-plan.js';

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

function roadStreamCrossing(road, site, cityWall) {
  if (!road || !site.stream) return null;
  const candidates = [];
  for (let i = 0; i < road.pts.length - 1; i++) {
    const a = road.pts[i], b = road.pts[i + 1];
    const signed = (point) => point.z - site.streamZat(point.x);
    let fa = signed(a), fb = signed(b);
    if (fa * fb > 0) continue;
    let lo = 0, hi = 1;
    for (let step = 0; step < 42; step++) {
      const mid = (lo + hi) * 0.5;
      const fm = signed(G.lerp(a, b, mid));
      if (fa * fm <= 0) { hi = mid; fb = fm; }
      else { lo = mid; fa = fm; }
    }
    const point = G.lerp(a, b, (lo + hi) * 0.5);
    candidates.push({
      point,
      tangent: G.norm(G.sub(b, a)),
      outside: !cityWall || cityWallClearance(cityWall, point) <= 0,
    });
  }
  const outside = candidates.filter((candidate) => candidate.outside);
  return (outside.length ? outside : candidates)[0] || null;
}

// ── char01 규모 파생(#89) ── 규모 연동 단조 앵커 + 시드 지터. 작은 씨족촌=민촌 성향(초가 우세,
//   char01↓) → 도성=반촌·여염 혼합(기와 상승, char01≈0.66; 순반촌 1.0 아님 — 도성엔 서민도 산다).
//   앵커는 siteR 기준 piecewise. capital(R250) base 0.60 / hanyang(R500) 0.66 → 지터(±0.08) 후에도
//   0.5 이상이라 궁+민촌 클램프가 자연 소멸(회귀 안전).
const CHAR01_ANCHORS = [[74, 0.18], [128, 0.34], [176, 0.48], [250, 0.60], [500, 0.66]];
// 필지 목표수 앵커(연속) — SCALE_TARGET 이산값을 제어점으로. town(70)=단일청크 상한, capital(104)+는 다청크.
//   값은 "프론티지(추가 필지)" 목표수 — 종가·관아 예약 코어는 별도 +1. [30,0] = 외딴집 하한(#114):
//   R30 에서 프론티지 0 + 예약 종가 = 딱 한 채. 30~74 는 0~10 연속(두세 채 촌락도 성립).
const HOUSE_ANCHORS = [[30, 0], [74, 10], [128, 32], [176, 70], [250, 104], [500, 340]];
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

// ── 마을 생성 옵션 정규화(#91) ── 지형·구성·어휘 축의 스칼라/오버라이드/토글을 클램프·기본값 적용.
//   무옵션(전부 기본) 시 현행 정확 재현이 최우선 게이트 → 각 기본값은 현행 로직과 동치(배율 1·auto·미지정).
const clampNum = (v, lo, hi, d) => (typeof v === 'number' && isFinite(v)) ? Math.min(hi, Math.max(lo, v)) : d;
const triState = (v) => (v === true ? true : v === false ? false : 'auto');   // 강제 ON/OFF/자동(tier)
function normWallWeights(w) {   // 담장 스타일 분포 배율(유형별). 미지정/전부기본 → null(무영향, 픽셀 불변).
  if (!w || typeof w !== 'object') return null;
  const out = {}; let any = false;
  for (const k of ['tile', 'stone', 'mud', 'brush', 'hedge', 'open']) {
    if (typeof w[k] === 'number' && isFinite(w[k])) { out[k] = Math.min(3, Math.max(0, w[k])); any = true; }
  }
  return any ? out : null;
}
function normTuning(opts) {
  return {
    // 지형(site.js makeSite): 현행값 배율 + 개울 토글
    undAmpK: clampNum(opts.undAmpK, 0, 2.2, 1),          // 기복(언듈레이션) 진폭
    ridgeHK: clampNum(opts.ridgeHK, 0.5, 1.6, 1),        // 배산 능선·봉우리 높이
    streamMeanderK: clampNum(opts.streamMeanderK, 0, 2.5, 1),  // 개울 사행 정도
    stream: opts.stream === false ? false : true,        // 개울 유무(off=내륙 마른 마을)
    // 구성
    treeDensityK: clampNum(opts.treeDensityK, 0, 2, 1),  // 나무 밀도(populate scatterTrees)
    paddyDensityK: clampNum(opts.paddyDensityK, 0, 2, 1),// 논 밀도(planPaddies)
    cityWall: triState(opts.cityWall),                   // 성곽 강제 ON/OFF (auto=hanyang)
    sijeon: triState(opts.sijeon),                       // 시전 강제 ON/OFF (auto=hanyang; daero 필요)
    // 어휘(variants.js)
    diversityK: clampNum(opts.diversityK, 0, 2, 1),      // 다양성 강도(집 지터 배율)
    wallWeights: normWallWeights(opts.wallWeights),      // 담장 스타일 분포
  };
}

export function planVillage(opts = {}) {
  const warnings = [];
  const seed = (typeof opts.seed === 'number' ? opts.seed
    : typeof opts.seed === 'string' ? hashString(opts.seed) : 20260716) >>> 0;
  const tuning = normTuning(opts);

  // ── 연속 스케일(#89) ── siteR(분지 반경, m) 하나가 규모의 진입점. opts.scale 은 프리셋명('capital')
  //   | 절대 siteR(m, >1) | 0..1 정규화(슬라이더) 모두 허용, opts.siteR(m) 은 명시 우선. 지형은 연속
  //   (site.js siteConfigFor)이되 도로망·성곽·시전·궁 tier 등 불연속 문법은 tier 임계에서 스냅한다.
  const siteR = resolveSiteR(typeof opts.siteR === 'number' ? opts.siteR
    : (opts.scale != null ? opts.scale : 'village'));
  const scale = tierForR(siteR);                      // 이산 tier(토폴로지·성곽·궁 임계 분기)
  const isCapitalTier = scale === 'capital' || scale === 'hanyang';
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
  const houseTarget = housesOverridden ? Math.max(0, Math.min(400, Math.round(opts.houses))) : defaultTarget;
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
  const site = makeSite({ siteR, seed, bowlK,
    undAmpK: tuning.undAmpK, ridgeHK: tuning.ridgeHK, streamMeanderK: tuning.streamMeanderK, stream: tuning.stream });
  const C = site.center, E = site.entrance;
  const toEntrance = G.norm(G.sub(E, C));   // 종가가 바라보는 방향(남, 동구쪽)

  // ── 2) 예약 코어(종가/관아/궁) — 프론티지 배정 전에 블록으로 확보 ──
  const blockers = [];
  const features = { pavilion: null, bridges: [], props: [], temple: null, palace: null };

  // 핵심 건물의 좌향은 카메라/석양 룩이 아니라 배산임수의 주산→동구 축이 결정한다.
  // 이전 rimFrontDir(-z)은 남향 주석과 달리 종가·관아·궁을 북북서로 돌리고 있었다.
  const coreFrontDir = toEntrance;

  if (isCapitalTier && includePalace) {
    // 궁역(#88): 행각 공유 다일곽 궁궐. 한양=경복궁급 4일곽(96×150), capital=3일곽 축소판(60×90).
    //   축선 깊이가 커져 궁역이 배산(-z)쪽으로 확장 — 중심을 북으로 당겨 진입부(+z)가 도성 안에 앉게 한다.
    const tier = scale === 'hanyang' ? 'hanyang' : 'capital';
    const pw = tier === 'hanyang' ? 96 : 60, pd = tier === 'hanyang' ? 150 : 90;
    const pc = { x: 0, z: C.z - pd * 0.16 };   // 깊어진 축선을 북으로 상재(진입부 여유)
    const palaceParcel = reservedParcel(pc, coreFrontDir, pw, pd, {
      placement: 'landmark', kind: 'palace', seed: (seed ^ 0x9a11) >>> 0,
    });
    // 궁역도 일반 필지와 같은 poly·남측 일조 회랑을 보존한다. 렌더용 축약 feature만
    // 남기면 보호수와 숲 worker가 궁궐을 빈 땅으로 오인한다.
    features.palace = { ...palaceParcel, x: pc.x, z: pc.z, tier };
    blockers.push({ poly: palaceParcel.poly });
  } else if (houseTarget <= 0 && typeof opts.houses === 'number') {
    // 집 없는 구성(#114): houses:0 명시 시 예약 코어(종가·관아)도 생략 — "절 하나만"(includeTemple)
    //   또는 빈 산세 구성. 엔진은 hero 부재 시 부감 랜딩 폴백(기존 경로).
  } else if (isCapitalTier) {
    // 궁 없는 도성풍: 중심에 대형 관아(객사) 코어
    const coreCenter = coreCenterBehindGate(C, coreFrontDir, 34);
    const core = reservedParcel(coreCenter, coreFrontDir, 42, 34, {
      hero: true, heroStyle: 'palace', kind: 'giwa', rank: 1, seed: (seed ^ 0x5a11) >>> 0,
    });
    features.govCore = { x: coreCenter.x, z: coreCenter.z, frontDir: coreFrontDir };
    blockers.push(core);
  } else if (scale === 'town') {
    // 관아 코어(객사 남향) — 배산 아래 중앙
    blockers.push(reservedParcel(coreCenterBehindGate(C, coreFrontDir, 32), coreFrontDir, 40, 32, {
      hero: true, heroStyle: 'palace', kind: 'giwa', rank: 1, seed: (seed ^ 0x5a11) >>> 0,
    }));
  } else {
    // 씨족촌 종가 — 명당(중심), 남향(동구쪽) -> 림 라이트 최적 방향
    const plotW = scale === 'village' ? 28 : 26, plotD = scale === 'village' ? 26 : 24;
    blockers.push(reservedParcel(coreCenterBehindGate(C, coreFrontDir, plotD), coreFrontDir, plotW, plotD, {
      hero: true, heroStyle: 'hanok', kind: 'giwa', rank: 1, seed: (seed ^ 0x5a11) >>> 0,
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
  const coreParcel = blockers.find((blocker) => blocker.hero);
  const coreRoadAnchor = coreParcel
    ? parcelWorldPoint(coreParcel, { x: 0, z: coreParcel.plotD * 0.5 })
    : null;
  const layoutOpts = (cityWall || coreRoadAnchor)
    ? {
      ...norm,
      ...(cityWall ? { cityWall } : {}),
      ...(coreRoadAnchor ? { coreRoadAnchor } : {}),
    }
    : norm; // 생성 중에만 주입; 반환 plan에는 features가 단일 소스.

  // ── 3) 도로 (간선 결정론 + 이면 유기) ──
  const roadsResult = planRoads(site, layoutOpts, rng);

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
    for (const poly of templeReservations) blockers.push({ poly, templeReserve: true });
  }

  // ── 3.5) 시전행랑 (한양) ── 간선(주작대로·종로) 파사드를 따라 연립 벽식 점포(선형 상업, 규칙 7).
  //   점포 footprint 를 blockers 에 넣어 일반 필지가 대로변 상가 열을 침범하지 않게 한다.
  // 시전 강제 오버라이드(#91): auto=hanyang, true/false=강제. planSijeon 은 간선(daero) 파사드가 있어야
  //   점포가 나므로 daero 를 만드는 capital·hanyang 에서만 실효(그 외 강제 ON 은 빈 배열=무영향). 점포
  //   footprint 는 blocker 라 강제 ON 시 일반 필지 배치가 그만큼 달라진다(의도된 구성 변화, 결정론).
  const wantSijeon = tuning.sijeon === true ? true : tuning.sijeon === false ? false : (scale === 'hanyang');
  if (wantSijeon) {
    features.sijeon = planSijeon(roadsResult, site, char01).filter((shop) =>
      worldEdgeContainsPolygon(site.edge, shop.poly, 6)
      && (!cityWall || cityWallContainsPolygon(cityWall, shop.poly, 4))
      && !templeReservations.some((poly) => G.polysOverlap(shop.poly, poly)));
    for (const s of features.sijeon) blockers.push({ poly: s.poly });
  }

  // ── 4) 필지 (도로변 분할 + 위계 그라디언트) ──
  const frontage = planParcels(site, roadsResult, layoutOpts, rng, blockers);
  // ── 4.5) 위성 부락(#120) ── 본동에서 조금 떨어진 완사면 포켓에 작은 무리(몇 채). rng 소비 없는 전용
  //   시드 경로(공유 rng 불침해 → 상류 결정론 보존, 위성 OFF 회귀 안전). 겹침 회피에 기존 필지·예약 코어
  //   polygon 을 넘긴다. cityWall 이 있으면 실제 부정형 윤곽 바깥만 허용한다.
  const satExisting = [
    ...blockers.map((blocker) => blocker.poly).filter(Boolean),
    ...frontage.map((parcel) => parcel.poly),
  ];
  const satellites = planSatellites(site, norm, seed, {
    existing: satExisting,
    cityWall,
    roads: roadsResult.roads,
  });
  // 예약 코어 중 실제 필지로 렌더할 것(궁 제외)만 parcels 에 포함
  const reserved = blockers.filter((b) => b.hero);
  const parcels = [...reserved, ...frontage, ...satellites];
  // 안정적 필지 ID(시드 고정 → 같은 seed 는 같은 id 순서) — 인스턴싱·픽킹·편집의 키.
  parcels.forEach((p, i) => { p.id = `p${i}`; });
  // 집 변주 필드(평면 프로토·톤·yaw·스케일·담 유형·부속채) — parcel.seed 결정론(variants.js).
  //   #91 어휘 옵션(다양성 강도·담장 분포)을 tuning 으로 전달(무옵션 시 현행 정확 재현, parcel-seed rng 격리).
  parcels.forEach((p) => {
    if (p.sx == null) {
      assignFittedVariation(p, char01, tuning);
    }
  });

  // ── 5) 정자 ──
  // 씨족촌: 동구 정자(진입 초입). 도성/읍치: 중심 정자(공용 결절).
  if (scale === 'hamlet' || scale === 'village') {
    const side = 1;
    const off = G.mul(G.perpL(toEntrance), site.R * 0.10 * side);
    const px = E.x + off.x + toEntrance.x * site.R * 0.05;
    const pz = E.z + off.z + toEntrance.z * site.R * 0.05;
    features.pavilion = { x: px, z: pz, sides: 6, rot: rng.range(0, 6.28) };
  } else {
    const pv = G.lerp(C, E, 0.30);
    features.pavilion = { x: pv.x + site.R * 0.06, z: pv.z, sides: 6, rot: 0 };
  }

  // ── 6) 돌다리 (개울 위, 진입 스파인 교차점) ──
  if (site.stream) {
    const wallApproach = cityWall
      ? roadsResult.roads.find((road) => road.wallApproach?.gate === 'south')
      : null;
    const crossing = roadStreamCrossing(wallApproach, site, cityWall);
    const cx = crossing?.point || site.stream.cross;
    const tanS = G.norm(G.sub(site.stream.pts[Math.min(site.stream.pts.length - 1, 37)], site.stream.pts[35]));
    const across = crossing?.tangent || G.perpL(tanS);
    const rot = Math.atan2(-across.z, across.x);   // 다리 로컬 X(span)를 개울 횡단 방향으로
    let span = site.stream.width + 5;
    let width = scale === 'hamlet' ? 1.8 : 2.4;
    if (crossing) {
      const d = 1;
      const streamTangent = G.norm({
        x: d * 2,
        z: site.streamZat(cx.x + d) - site.streamZat(cx.x - d),
      });
      const streamNormal = G.perpL(streamTangent);
      span = site.stream.width / Math.max(0.5, Math.abs(G.dot(crossing.tangent, streamNormal))) + 5;
      width = wallApproach.width + 1;
    }
    // 반촌=격식 홍예교, 민촌=소박 판석교, 여염=규모 따라.
    const bridgeType = char01 < 0.34 ? 'slab'
      : (char01 >= 0.66 || scale === 'town' || scale === 'capital') ? 'arch' : 'slab';
    features.bridges.push({
      x: cx.x, z: cx.z, rot, type: bridgeType,
      span, width,
    });
  }

  // ── 7) 다랑이 논 (개울 남쪽 저지) — 민촌일수록 농경 비중↑(논 촘촘), 반촌은 성글게 ──
  const paddyObstacles = [
    ...parcels.map((parcel) => parcel.poly),
    ...(features.palace?.poly ? [features.palace.poly] : []),
    ...templeReservations,
  ];
  // 논 후보 RNG는 전부 소비한 뒤 실제 필지와 겹치는 배미만 걷어 낸다. 필터 때문에 뒤쪽
  // 소품/절 seed 흐름이 달라지지 않으면서 담·처마 아래 논 표면이 비치는 오류를 막는다.
  let paddies = null;
  if (site.paddyRegion) {
    const candidates = planPaddies(site, rng, char01, tuning.paddyDensityK);
    paddies = [];
    // 후보·tone RNG를 전부 소비한 뒤 stable first-wins로 공간 계약만 적용한다. 인접 셀 지터가
    // 논둑을 포개도 뒤 소품 seed는 불변이고, 화면에는 한 겹의 온전한 배미만 남는다.
    for (const field of candidates) {
      if (streamIntersectsPolygon(site, field.poly, STREAM_PADDY_BANK_CLEARANCE)) continue;
      if (paddyObstacles.some((poly) => G.polysOverlap(field.poly, poly))) continue;
      if (paddies.some((accepted) => G.polysOverlap(field.poly, accepted.poly))) continue;
      paddies.push(field);
    }
  }

  // ── 8) 소품 (동구 장승·솟대, 종가 앞 우물·장독대, 성격별 액센트) ──
  planProps(features, site, scale, rng, char01);

  // ── 9) 보호수 예약 ── 실제 flora를 만들기 전에 순수 위치·수관을 plan에 고정한다. 숲 worker와
  // 마당 renderer가 같은 목록을 소비하므로 보호수 자리에 배경 숲이 먼저 박히지 않는다.
  features.guardianTrees = planGuardianTrees({
    scale,
    features,
    parcels,
    paddies,
    roads: roadsResult.roads,
  }, site, seed);

  const allPts = [...roadsResult.roads.flatMap((r) => r.pts), ...parcels.map((p) => p.center)];
  const bounds = G.boundsOfPts(allPts.length ? allPts : [site.center]);

  return {
    opts: norm, seed, scale, warnings,
    site,
    roads: roadsResult.roads,
    nodes: roadsResult.nodes,
    parcels,
    paddies,
    features,
    bounds,
    stats: {
      houses: parcels.length,
      giwa: parcels.filter((p) => p.kind === 'giwa').length,
      choga: parcels.filter((p) => p.kind === 'choga').length,
      satellites: satellites.length,            // 위성 부락 필지 수(#120)
      bowlK,                                     // footprint 종속 분지 계수(#120)
      roads: roadsResult.roads.length,
      paddies: paddies ? paddies.length : 0,
      parcelDebug: planParcels.lastDebug,
    },
  };
}

// ── 시전행랑(선형 상업) ── 간선(daero=주작대로·종로) 양측 파사드를 따라 연속 배치된 연립 점포.
//   점포 칸(pitch)을 연이어 놓아 벽식 상가 열을 이룬다. 교차점 주변 밀도 최대(중심 근접만), 성문
//   접근 구간(양 끝)은 비운다. 반환 각 항목 poly 는 blockers 로도 쓰여 일반 필지 침범을 막는다.
function planSijeon(roadsResult, site, char01) {
  const shops = [];
  const arterials = roadsResult.roads.filter((r) => r.level === 'daero');
  const pitch = 6.2, depth = 8.5, setback = 1.4, runCap = 26;
  const bowlR = site.bowlR;
  const others = (road) => arterials.filter((r) => r !== road);
  let sid = 0;
  for (const road of arterials) {
    const fine = G.resample(road.pts, pitch);
    if (fine.length < 8) continue;
    const hw = road.width / 2;
    const oth = others(road);
    for (let side = 1; side >= -1; side -= 2) {
      let run = 0;
      for (let i = 3; i < fine.length - 3 && run < runCap; i++) {
        const smp = fine[i];
        if (G.dist(smp.pt, site.center) > bowlR * 0.9) continue;   // 도심 상업 집중(외곽 성글게)
        const inward = G.mul(G.perpL(smp.tan), side);
        const base = G.add(smp.pt, G.mul(inward, hw + setback));
        // 다른 간선(교차점) 너무 근접하면 건너뜀(상가 파일업·z-fighting 방지).
        let clash = false;
        for (const o of oth) { if (G.distToPolyline(base, o.pts).d < o.width / 2 + depth) { clash = true; break; } }
        if (clash) continue;
        const poly = G.frontageParcel(base, smp.tan, inward, pitch * 0.5, depth, 0);
        shops.push({ id: `s${sid++}`, poly, center: G.polyCentroid(poly),
          frontDir: G.norm(G.mul(inward, -1)), x: base.x, z: base.z, w: pitch, d: depth });
        run++;
      }
    }
  }
  return shops;
}

// 다랑이 논: 개울 남쪽 저지를 완만한 계단식 필드로 분할(등고 순응 지터).
function planPaddies(site, rng, char01 = 0.5, paddyK = 1) {
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
  const hillMax = big ? 0.40 : 0.28;                        // 완사면 다랑이 허용(도성만; 타 규모 불변)
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
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      const x0 = xMin + c * cw, z0 = pr.zNear + r * rd;
      const cx = x0 + cw / 2, cz = z0 + rd / 2;
      if (site.hillAt(cx, cz) > hillMax) continue;           // 안산 기슭 급경사 제외(완사면은 허용)
      if (Math.abs(cz - site.streamZat(cx)) < site.streamHalf + 2) continue;
      if (rng() < dropP) continue;                          // 반촌: 논 일부 생략
      const j = (dx, dz) => ({ x: dx + rng.range(-cw * 0.06, cw * 0.06), z: dz + rng.range(-rd * 0.06, rd * 0.06) });
      const inset = 0.9;
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
      const safeCenter = G.polyCentroid(safePoly);
      fields.push({ poly: safePoly, y: site.heightAt(safeCenter.x, safeCenter.z) + 0.06, tone });
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

// 소품: 동구(장승 한 쌍·솟대), 종가/중심(우물), 초가군(장독대). 은은하게 몇 점만.
function planProps(features, site, scale, rng, char01 = 0.5) {
  const C = site.center;
  const southGate = features.cityWall?.gates.find((gate) => gate.name === 'south') || null;
  const E = southGate || site.entrance;
  const toC = southGate
    ? { x: -southGate.dirX, z: -southGate.dirZ }
    : G.norm(G.sub(C, E));
  const perp = G.perpL(toC);
  let entrancePerp = perp;
  let jangseungOffset = 5, sotdaeOffset = 8, forecourtInset = 0;
  if (southGate) {
    const structureHalf = (southGate.width
      + CITY_WALL_DIMENSIONS.gateExtraWidth * (southGate.scale || 1)) * 0.5;
    jangseungOffset = structureHalf + 4;
    sotdaeOffset = structureHalf + 8;
    forecourtInset = CITY_WALL_DIMENSIONS.gateDepth * (southGate.scale || 1) * 0.5 + 3;
    // 두 문 옆 중 물가에서 더 먼 쪽을 택한다. 장승 한 쌍과 솟대 모두 육축·도로 폭 바깥,
    // 성 안쪽 문전 공간에 두어 홍예 통행과 개울을 막지 않는다.
    if (site.stream) {
      const bankScore = (sign) => Math.min(...[jangseungOffset, sotdaeOffset].map((offset) => {
        const point = G.add(E, G.add(G.mul(entrancePerp, offset * sign), G.mul(toC, forecourtInset)));
        return Math.abs(point.z - site.streamZat(point.x)) - site.streamHalf;
      }));
      if (bankScore(-1) > bankScore(1)) entrancePerp = G.mul(entrancePerp, -1);
    }
  }
  // 동구/남문 장승 한 쌍 — 성곽 ON이면 실제 남문 진입부를 쓰고 안길 한쪽으로 비킨다.
  features.props.push({
    name: 'jangseung-pair',
    x: E.x + entrancePerp.x * jangseungOffset + toC.x * forecourtInset,
    z: E.z + entrancePerp.z * jangseungOffset + toC.z * forecourtInset,
    rot: Math.atan2(toC.x, toC.z), scale: 1.0, seed: 21,
  });
  // 솟대 — 장승 옆
  features.props.push({
    name: 'sotdae',
    x: E.x + entrancePerp.x * sotdaeOffset + toC.x * forecourtInset,
    z: E.z + entrancePerp.z * sotdaeOffset + toC.z * forecourtInset,
    rot: 0, scale: 1.0, seed: 22,
  });
  // 우물 — 중심 근처
  features.props.push({ name: 'well', x: C.x + perp.x * 9, z: C.z + toC.z * 7, rot: 0, scale: 1.0, seed: 23 });
  if (scale !== 'hamlet') {
    // 장독대 — 중심 살짝 뒤(북)
    features.props.push({ name: 'jangdokdae', x: C.x - perp.x * 10, z: C.z - site.R * 0.05, rot: rng.range(0, 6.28), scale: 1.0, seed: 24 });
  }
  // 성격 액센트: 민촌은 시골 살림(낟가리·절구), 반촌은 격식(추가 장독대·우물)로 빈부가 읽히게.
  if (char01 < 0.34) {
    features.props.push({ name: 'haystack', x: C.x + perp.x * 14, z: C.z + toC.z * 12, rot: rng.range(0, 6.28), scale: 1.1, seed: 25 });
    features.props.push({ name: 'mortar-pestle', x: C.x + perp.x * 11, z: C.z + toC.z * 15, rot: rng.range(0, 6.28), scale: 1.0, seed: 26 });
  } else if (char01 >= 0.66) {
    features.props.push({ name: 'jangdokdae', x: C.x + perp.x * 12, z: C.z - site.R * 0.02, rot: rng.range(0, 6.28), scale: 1.0, seed: 27 });
    features.props.push({ name: 'well', x: C.x - perp.x * 12, z: C.z + toC.z * 5, rot: 0, scale: 1.0, seed: 28 });
  }
}
