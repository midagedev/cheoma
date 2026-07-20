import { makeRng, hashString } from '../rng.js';
import { makeSite, resolveSiteR, tierForR, rToScale01 } from './site.js';
import { planRoads } from './roads.js';
import { planParcels, planSatellites } from './parcels.js';
import { assignVariation } from './variants.js';
import * as G from '../core/math/geom2.js';

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

// 로컬 +z(정면)를 frontDir 로 향하는 자립 사각 필지 폴리곤(도로 비접) — 종가·궁 등 예약분.
function rectParcel(center, frontDir, plotW, plotD) {
  const fd = G.norm(frontDir);
  const tan = G.perpL(fd);
  const base = G.add(center, G.mul(fd, plotD / 2));   // 전면(도로/마당쪽) 모서리선
  const inward = G.mul(fd, -1);
  return G.frontageParcel(base, tan, inward, plotW / 2, plotD, 0);
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
  //   ("절 하나만" 구성: houses:0 + includeTemple:true → 집 없는 산사 플랜, 엔진은 부감 랜딩 폴백).
  const housesOverridden = typeof opts.houses === 'number' && isFinite(opts.houses);
  const defaultTarget = Math.round(pieceLerp(siteR, HOUSE_ANCHORS));   // siteR 이 함의하는 명목 호수
  const houseTarget = housesOverridden ? Math.max(0, Math.min(400, Math.round(opts.houses))) : defaultTarget;

  // ── 분지 크기 = 건축 footprint 종속(#120) ── siteR(규모)만 움직이면 houseTarget≈defaultTarget 이라
  //   계수 1(현행 반경 정확 재현 — 무옵션 게이트 보존). houses 를 직접 낮추면(집 적음) 분지가 아담해지고
  //   높이면 넓어진다("사각 그릇 고정 반경" 인상 해소). 면적 ∝ 호수 → 반경 ∝ √호수(+3 완충으로 극단 방지).
  //   대규모 궁·성곽 붕괴 방지로 [0.72,1.25] 클램프(site.js 도 [0.68,1.28] 재클램프).
  const bowlK = housesOverridden
    ? Math.min(1.25, Math.max(0.72, Math.pow((houseTarget + 3) / (defaultTarget + 3), 0.5)))
    : 1;

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

  const rimFrontDir = G.norm({ x: -16, z: -45 }); // 석양 sunDir [-16, 8, -45] 의 수평 투영 방향

  if (isCapitalTier && includePalace) {
    // 궁역(#88): 행각 공유 다일곽 궁궐. 한양=경복궁급 4일곽(96×150), capital=3일곽 축소판(60×90).
    //   축선 깊이가 커져 궁역이 배산(-z)쪽으로 확장 — 중심을 북으로 당겨 진입부(+z)가 도성 안에 앉게 한다.
    const tier = scale === 'hanyang' ? 'hanyang' : 'capital';
    const pw = tier === 'hanyang' ? 96 : 60, pd = tier === 'hanyang' ? 150 : 90;
    const pc = { x: 0, z: C.z - pd * 0.16 };   // 깊어진 축선을 북으로 상재(진입부 여유)
    const poly = rectParcel(pc, rimFrontDir, pw, pd);
    features.palace = { x: pc.x, z: pc.z, frontDir: rimFrontDir, seed: (seed ^ 0x9a11) >>> 0, plotW: pw, plotD: pd, tier };
    blockers.push({ poly });
  } else if (houseTarget <= 0 && typeof opts.houses === 'number') {
    // 집 없는 구성(#114): houses:0 명시 시 예약 코어(종가·관아)도 생략 — "절 하나만"(includeTemple)
    //   또는 빈 산세 구성. 엔진은 hero 부재 시 부감 랜딩 폴백(기존 경로).
  } else if (isCapitalTier) {
    // 궁 없는 도성풍: 중심에 대형 관아(객사) 코어
    const poly = rectParcel(C, rimFrontDir, 42, 34);
    features.govCore = { x: C.x, z: C.z, frontDir: rimFrontDir };
    blockers.push({ poly, hero: true, heroStyle: 'palace', center: C, frontDir: rimFrontDir, plotW: 42, plotD: 34, kind: 'giwa', rank: 1, seed: (seed ^ 0x5a11) >>> 0 });
  } else if (scale === 'town') {
    // 관아 코어(객사 남향) — 배산 아래 중앙
    const poly = rectParcel(C, rimFrontDir, 40, 32);
    blockers.push({ poly, hero: true, heroStyle: 'palace', center: C, frontDir: rimFrontDir, plotW: 40, plotD: 32, kind: 'giwa', rank: 1, seed: (seed ^ 0x5a11) >>> 0 });
  } else {
    // 씨족촌 종가 — 명당(중심), 남향(동구쪽) -> 림 라이트 최적 방향
    const plotW = scale === 'village' ? 28 : 26, plotD = scale === 'village' ? 26 : 24;
    const poly = rectParcel(C, rimFrontDir, plotW, plotD);
    blockers.push({ poly, hero: true, heroStyle: 'hanok', center: C, frontDir: rimFrontDir, plotW, plotD, kind: 'giwa', rank: 1, seed: (seed ^ 0x5a11) >>> 0 });
  }

  // ── 2.5) 성곽·사대문 (한양 전용) ── 도로 생성 전에 게이트를 확정해 간선을 성문과 정렬한다.
  //   내사산 능선을 잇는 부정형 폐곡선(joseon-city 규칙 2) — 여기선 스펙(순수 데이터)만, 렌더는 citywall.js.
  // 성곽 강제 오버라이드(#91): auto=hanyang 자동, true/false=강제. computeCityWall 은 site 파생(공유 rng
  //   미소비)이고 blocker 도 안 만들어 — 비-hanyang 강제 ON 은 도로·필지 배치를 흔들지 않고 완전형 링만
  //   추가된다(성곽 끊김 없음). hanyang 강제 OFF 는 도로 게이트 정렬이 사라져 하류가 달라짐(비기본, 결정론).
  const wantWall = tuning.cityWall === true ? true : tuning.cityWall === false ? false : (scale === 'hanyang');
  const cityWall = wantWall ? computeCityWall(site, seed) : null;
  if (cityWall) { features.cityWall = cityWall; norm.cityWall = cityWall; }

  // ── 3) 도로 (간선 결정론 + 이면 유기) ──
  const roadsResult = planRoads(site, norm, rng);

  // ── 3.5) 시전행랑 (한양) ── 간선(주작대로·종로) 파사드를 따라 연립 벽식 점포(선형 상업, 규칙 7).
  //   점포 footprint 를 blockers 에 넣어 일반 필지가 대로변 상가 열을 침범하지 않게 한다.
  // 시전 강제 오버라이드(#91): auto=hanyang, true/false=강제. planSijeon 은 간선(daero) 파사드가 있어야
  //   점포가 나므로 daero 를 만드는 capital·hanyang 에서만 실효(그 외 강제 ON 은 빈 배열=무영향). 점포
  //   footprint 는 blocker 라 강제 ON 시 일반 필지 배치가 그만큼 달라진다(의도된 구성 변화, 결정론).
  const wantSijeon = tuning.sijeon === true ? true : tuning.sijeon === false ? false : (scale === 'hanyang');
  if (wantSijeon) {
    features.sijeon = planSijeon(roadsResult, site, char01);
    for (const s of features.sijeon) blockers.push({ poly: s.poly });
  }

  // ── 4) 필지 (도로변 분할 + 위계 그라디언트) ──
  const frontage = planParcels(site, roadsResult, norm, rng, blockers);
  // ── 4.5) 위성 부락(#120) ── 본동에서 조금 떨어진 완사면 포켓에 작은 무리(몇 채). rng 소비 없는 전용
  //   시드 경로(공유 rng 불침해 → 상류 결정론 보존, 위성 OFF 회귀 안전). 겹침 회피에 기존 필지·예약 코어
  //   polygon 을 넘긴다. cityWall 있으면 성곽 링 밖으로(minR).
  const satMinR = features.cityWall ? features.cityWall.ringR * 1.06 : 0;
  const satExisting = [...blockers.map((b) => b.poly).filter(Boolean), ...frontage.map((p) => p.poly)];
  const satellites = planSatellites(site, norm, seed, { minR: satMinR, existing: satExisting });
  // 예약 코어 중 실제 필지로 렌더할 것(궁 제외)만 parcels 에 포함
  const reserved = blockers.filter((b) => b.hero);
  const parcels = [...reserved, ...frontage, ...satellites];
  // 안정적 필지 ID(시드 고정 → 같은 seed 는 같은 id 순서) — 인스턴싱·픽킹·편집의 키.
  parcels.forEach((p, i) => { p.id = `p${i}`; });
  // 집 변주 필드(평면 프로토·톤·yaw·스케일·담 유형·부속채) — parcel.seed 결정론(variants.js).
  //   #91 어휘 옵션(다양성 강도·담장 분포)을 tuning 으로 전달(무옵션 시 현행 정확 재현, parcel-seed rng 격리).
  parcels.forEach((p) => assignVariation(p, char01, tuning));

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
    const cx = site.stream.cross;
    const tanS = G.norm(G.sub(site.stream.pts[Math.min(site.stream.pts.length - 1, 37)], site.stream.pts[35]));
    const across = G.perpL(tanS);
    const rot = Math.atan2(-across.z, across.x);   // 다리 로컬 X(span)를 개울 횡단 방향으로
    // 반촌=격식 홍예교, 민촌=소박 판석교, 여염=규모 따라.
    const bridgeType = char01 < 0.34 ? 'slab'
      : (char01 >= 0.66 || scale === 'town' || scale === 'capital') ? 'arch' : 'slab';
    features.bridges.push({
      x: cx.x, z: cx.z, rot, type: bridgeType,
      span: site.stream.width + 5, width: scale === 'hamlet' ? 1.8 : 2.4,
    });
  }

  // ── 7) 다랑이 논 (개울 남쪽 저지) — 민촌일수록 농경 비중↑(논 촘촘), 반촌은 성글게 ──
  const paddies = site.paddyRegion ? planPaddies(site, rng, char01, tuning.paddyDensityK) : null;

  // ── 8) 소품 (동구 장승·솟대, 종가 앞 우물·장독대, 성격별 액센트) ──
  planProps(features, site, scale, rng, char01);

  // ── 9) 절 클러스터 (배산 사면 중턱, 마을과 이격) ──
  if (includeTemple) features.temple = placeTemple(site, seed);

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

// ── 성곽·사대문 스펙(순수 데이터, THREE 비의존) ── 렌더는 citywall.buildCityWall 이 소비.
//   내사산 능선을 잇는 부정형 폐곡선 대신, 분지 중심(명당) 둘레의 링(ringR)에 유기적 파동을 실어
//   근사한다(joseon-city 규칙 2). 4대문: 남(숭례문·정문)·동(흥인)·북(숙정)·서(돈의). angle 0 = +z(남).
function computeCityWall(site, seed) {
  const C = site.center;
  const ringR = site.bowlR * 1.16;                 // 주거역(bowlR·1.06) 바깥 하부 사면에 성벽
  const gates = [
    { name: 'south', angle: 0,             width: 26 },   // 숭례문 — 정문(가장 큼), 주작대로 정렬
    { name: 'east',  angle: Math.PI * 0.5, width: 18 },   // 흥인지문 — 종로 동단
    { name: 'north', angle: Math.PI,       width: 15 },   // 숙정문 — 궁 뒤(주산), 작음
    { name: 'west',  angle: Math.PI * 1.5, width: 18 },   // 돈의문 — 종로 서단
  ].map((g) => {
    const dx = Math.sin(g.angle), dz = Math.cos(g.angle);
    return { name: g.name, angle: g.angle, width: g.width, x: C.x + dx * ringR, z: C.z + dz * ringR, dirX: dx, dirZ: dz };
  });
  return { cx: C.x, cz: C.z, ringR, gates, wobbleAmp: ringR * 0.055, seed: (seed ^ 0xc17a) >>> 0 };
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
      fields.push({ poly, y: site.heightAt(cx, cz) + 0.06, tone });
    }
  }
  return fields;
}

// ── 절(산사) 배치 (#94) ── 산사(山寺)는 능선 마루가 아니라 배산 사면의 완사 벤치(좌청룡·우백호 어깨)에
//   앉아 마을을 내려다보되 하늘선을 깨지 않는다. 옛 배치(측면 급벽 x=±0.62R, z=중심-0.18R)는 33m footprint
//   안에서 표고차 40~59m 인 거의 절벽에 얹혀 (a)부감 실루엣이 능선과 겹치고 (b)성토 패드가 접지 못해
//   컴파운드가 붕 떴다. 대신 배산 측면 사면을 스캔해 완경사·능선 백드롭·비가장자리를 만족하는 어깨 벤치를
//   고른다. 지형은 자기유사(site.js)라 표고비(er)·완경사 존이 규모 불변 → 비율 기반 밴드로 전 규모 대응.
//   temple 은 rng 소비 마지막 단계라 seed 파생 배치로 바꿔도 상류 결정론 불변(절 OFF 앵커 회귀 안전).
function placeTemple(site, seed) {
  const C = site.center, Hmax = site.Hmax, R = site.R;
  const foot = 33;                                   // pad 포함 footprint(30+3)
  const side = ((seed ^ 0x7e11) >>> 0) % 2 === 0 ? 1 : -1;   // 결정론 좌/우 사면
  // footprint 표고 낙차(완경사=접지 가능 판별)
  const footSlope = (x, z) => {
    let lo = 1e9, hi = -1e9;
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      const h = site.heightAt(x + i * foot / 2, z + j * foot / 2);
      if (h < lo) lo = h; if (h > hi) hi = h;
    }
    return hi - lo;
  };
  // 절 뒤(북) 능선 백드롭: 벤치에서 북으로 스캔한 최대 표고 − 절 지반(양수면 능선이 배경으로 솟음)
  const backdropRise = (x, z, gy) => {
    let hi = -1e9;
    for (let dz = 0.06 * R; dz <= 0.7 * R; dz += 0.05 * R)
      for (const dx of [-0.12 * R, 0, 0.12 * R]) hi = Math.max(hi, site.heightAt(x + dx, z - dz));
    return hi - gy;
  };
  // 배산 측면 사면(북~정측) 방위 × 반경 스캔 → 어깨 벤치. 표고 밴드 안에서 완경사(접지)·백드롭·중앙표고·
  //   비가장자리 최적점. 밴드는 표고비(Hmax 비율) — 어깨 벤치가 er≈0.5~0.7 에 형성됨(규모 불변).
  const eLo = 0.50, eHi = 0.70, eMid = 0.60;
  let best = null;
  for (let ai = 0; ai < 6; ai++) {
    const angFrac = 0.34 + (0.52 - 0.34) * (ai / 5);
    const ang = angFrac * Math.PI;                   // 0=정북(주산 배후), 0.5=정측(청룡·백호 어깨)
    const dir = { x: side * Math.sin(ang), z: -Math.cos(ang) };
    const rCap = Math.min(1.00 * R, (site.terrainR || R) * 0.94);   // #143 절 스캔 상한을 terrainR 안으로(절단 지형 밖 off-mesh 배치 방지)
    for (let r = 0.55 * R; r <= rCap; r += 0.02 * R) {
      const x = C.x + dir.x * r, z = C.z + dir.z * r;
      const gy = site.heightAt(x, z);
      const er = gy / Hmax;
      if (er < eLo || er > eHi) continue;
      const slope = footSlope(x, z), bd = backdropRise(x, z, gy);
      const edge = Math.max(0, r / R - 0.98) * 60;
      const score = -slope * 3.0 + bd * 0.35 - Math.abs(er - eMid) * Hmax * 0.30 - edge;
      if (!best || score > best.score) best = { x, z, score };
    }
  }
  if (!best) {   // 밴드 미발견(극소 분지) 안전 폴백 — 측면 산기슭
    const x = side * Math.min(R * 0.62, (site.terrainR || R) * 0.9), z = C.z - R * 0.18;   // #143 폴백도 terrainR 안
    best = { x, z };
  }
  // 일주문·대웅전은 마을(하향)을 향한다 — 절→마을 중심 방향으로 정면(남향 성분 유지).
  const toC = G.norm({ x: C.x - best.x, z: C.z - best.z });
  const frontDir = G.norm({ x: toC.x * 0.5, z: Math.max(0.5, toC.z) });
  return { x: best.x, z: best.z, frontDir, seed: (seed ^ 0x7e11) >>> 0 };
}

// 소품: 동구(장승 한 쌍·솟대), 종가/중심(우물), 초가군(장독대). 은은하게 몇 점만.
function planProps(features, site, scale, rng, char01 = 0.5) {
  const E = site.entrance, C = site.center;
  const toC = G.norm(G.sub(C, E));
  const perp = G.perpL(toC);
  // 동구 장승 한 쌍 — 진입 초입, 안길 한쪽 옆으로 비켜(진입로 안 막게)
  features.props.push({ name: 'jangseung-pair', x: E.x + perp.x * 5, z: E.z + perp.z * 5, rot: Math.atan2(toC.x, toC.z), scale: 1.0, seed: 21 });
  // 솟대 — 장승 옆
  features.props.push({ name: 'sotdae', x: E.x + perp.x * 8, z: E.z + perp.z * 8, rot: 0, scale: 1.0, seed: 22 });
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
