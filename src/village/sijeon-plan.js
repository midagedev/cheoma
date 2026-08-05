import * as G from '../core/math/geom2.js';
import { hashString } from '../rng.js';
import { THATCH_SHAPE } from '../builder/thatch-profile.js';

// Renderer-free sijeon (licensed-market row) contract.
//
// Placement keeps the legacy pitch/depth/setback/runCap number path and inserts
// product-owned row breaks so long arterial façades do not read as one infinite
// copy-paste roof (GitHub #218, scope (a) 줄 분절). The facade plan uses local
// coordinates centred on the planned shop:
//   +x = along the row, +z = road/front, +y = up.
// Renderers may merge shop records, but must not build solid mass for `kind:
// 'break'` footprints, infer a second footprint, or move solid storage/wall mass
// into the road-side corridor. Break polygons stay in the plan so residential
// parcels cannot fill the reserved market corridor.

export const SIJEON_PLACEMENT = Object.freeze({
  pitch: 6.2,
  depth: 8.5,
  setback: 1.4,
  runCap: 26,
  // Product segmentation (#218a). Interval is not a measured historical bay
  // count: sources confirm long arterial rows and kan-unit use, not a universal
  // roof-break period. One pitch of empty reserved footprint separates blocks so
  // eaves (body + 1.4 m) no longer bridge across the gap.
  segmentShops: 5,
  segmentGapPitches: 1,
});

// v3 (#54): 계획이 벽체(배면·측면·박공·전면 상벽)까지 소유한다. v2 렌더러는 개방 골조만 그리므로
// 같은 데이터로 닫힌 행랑을 만들 수 없다 — 소비자 계약이 바뀌었으니 버전을 올린다(docs/sijeon.md §3.1).
// v4 (#54 후속, 2026-08-05): 지붕이 단일 박공 프리즘 스펙에서 **점포별 초가/기와 로프트 표면**으로
//   바뀌고, 벽 상단~지붕 사이 폐합을 `gables[]` 박공 프리즘 하나가 아니라 네 방향 `closures[]`
//   프리즘이 맡는다. v3 렌더러는 `roof.{width,depth,rise}` 만 읽어 슬래브 2장을 만들므로 같은
//   데이터로 새 지붕을 세울 수 없다 = 소비자 계약 변경(docs/sijeon.md §3.5).
export const SIJEON_FACADE_SCHEMA_VERSION = 4;
export const SIJEON_FACADE_BAYS = 2;

export const SIJEON_ROOF_GIWA = 'giwa';
export const SIJEON_ROOF_CHOGA = 'choga';

// 점포별 지붕 유형 혼합 정책(v4). **역사 빈도 주장이 아니다.**
//   - 사료는 행랑 지붕 형식을 확정하지 않는다(docs/sijeon.md §2 "모든 구간의 동일한 지붕 형식").
//     따라서 전 점포 동일 기와도, 전 점포 동일 초가도 출처가 지지하는 복원이 아니다.
//   - [2026-08-05 R2 개정] R1 은 19세기말~20세기초 가로 **사진**을 근거로 초가 우세(기와 29%)를
//     잡았다. 그건 같은 문서 §2 마지막 조항("조선 전기 조성과 후기의 화재·재건·임대 기록을 한
//     날짜의 모습으로 합치지 않는다")을 스스로 위반한 것이다: 사료가 확인하는 행랑은 1412~1414년
//     국가가 조성해 공랑세를 받고 임대한 **관영 상설 점포**이고(§1.1·§1.2), 후기 사진은 화재·재건과
//     민간 자본 재건이 반복된 뒤의 가로다(§1.5). 사진을 전기 관영 행랑의 지붕 재료 대리지표로 쓸 수
//     없다. 어느 쪽 비율도 사료가 정하지 않으므로 **비율은 제품 결정**이고, 그 결정을 관영 성격과
//     사용자 지시("시장골목 수준 격상", 도성 상업 축선이 주변 민가 초가와 구분될 것)에 맞춰 기와
//     우세로 돌린다. 레포가 이미 관영 구조물을 기와 위계로 다루는 것과도 일관된다(성문 문루 단청).
//   - 블록(=#218 segment) 단위로 뭉치되 **약하게**: R1 의 강한 뭉침은 부감에서 단일 유형 연속 56채
//     (≈347m)를 만들어 간선 한쪽이 통째로 단색이 됐다(비전 실측). 블록 우세는 남기고 강도를 낮춘다.
export const SIJEON_ROOF_MIX = Object.freeze({
  giwaBlockShare: 0.55,     // 블록 추첨 임계
  giwaInGiwaBlock: 0.72,    // 기와 블록 안에서 한 점포가 기와일 임계
  giwaInChogaBlock: 0.48,   // 초가 블록 안에서 한 점포가 기와일 임계
  // **실측 대역이지 정책 확률이 아니다.** 블록 키 공간이 `seg0..seg41` 같은 짧은 연속 prefix 라
  //   실현 비율은 그 prefix 의 분포가 정한다. 그래서 임계는 명목값이 아니라 **실측치**로 보정했다 —
  //   hanyang 4시드(20260716/2026/7/99, 점포 711채) 풀에서 기와 63.3% / 초가 36.7%,
  //   단일 유형 블록 23%, 최장 단일 유형 연속 11채(R1: 29.0% / 61% / 56채).
  //   세그먼트 수가 크게 달라지면 다시 측정해야 한다. 게이트는 이 값이 아니라 대역을 단언한다.
  measuredGiwaShare: 0.633,
  measuredOn: 'hanyang seeds 20260716/2026/7/99, 711 shops (2026-08-05 R2)',
  // 지붕 유형은 점포·세그먼트 ID 에서만 나오고 마을 시드는 들어오지 않는다 — `planSijeon` 배치 절과
  //   segment 메타는 이 라운드의 수정 범위 밖이고(그 필드를 늘리면 plan 골든이 움직인다), 레코드에
  //   시드 유래 엔트로피가 없다. 결과: 리롤은 행랑의 위치·수를 바꾸지만 도로 순서상의 유형 교대
  //   패턴은 같다. 시드별 패턴 변주가 필요해지면 segment 앵커를 계획에 추가하는 별도 라운드다.
  // id 없는 순수 치수 fixture: 지터 0 + 이 유형. 결정론 기본값이며 통계에 참여하지 않는다.
  fallbackKind: SIJEON_ROOF_GIWA,
});

// Product sparseness for decorative marker boards — not a historical frequency.
export const SIJEON_SIGN_POLICY = Object.freeze({
  maxShare: 0.28,
  maxPerShop: 1,
  emissive: false,
  materialRole: 'frame',
  silhouettes: Object.freeze(['tablet', 'plank']),
});
export const SIJEON_KIND_SHOP = 'shop';
export const SIJEON_KIND_BREAK = 'break';

const MIN_WIDTH = 4.4;
const MIN_DEPTH = 5.6;
const SIGN_HANG_GAP = 0.05;
const SIGN_THICKNESS = 0.05;

// 점포별 벽 상단 지터(v4). 인접 점포의 처마·용마루가 정확히 같은 높이로 이어지면 지형 기복만 남아
//   "온실 장판"으로 읽힌다(비전 실측 2026-08-04: 능선·박공·색 변주 0). 벽 상단을 내려 이음에 단차를
//   만든다 — 지붕 형태 파라미터와 독립이라 폐합 계약이 흔들리지 않는다.
//
// [2026-08-05 R2] 대역을 **유형별로 분리**한다. 근거는 R2 FIX ② 의 잔여분이다:
//   배치가 곡선 간선에서 중심선을 pitch 로 리샘플한 뒤 안쪽으로 오프셋하므로, 곡률 구간에서는 인접
//   점포 중심 간격이 pitch 보다 좁아진다(실측 4시드: median 6.20 이지만 min 3.29, 그리고 이웃의
//   11~21% 는 **본체 5.95m 끼리 이미 겹친다** — v3 부터 있던 배치 성질이고 `planSijeon` 은 이 라운드
//   범위 밖이다). 그래서 지붕 폭 클램프만으로는 교차를 전부 없앨 수 없다.
//   완화: 초가 처마가 기와 처마보다 **항상** 위에 오게 대역을 겹치지 않게 나눈다. 얕은 겹침(대부분)
//   에서 기와 지붕 끝이 초가 이엉 **아래로 들어가** 두꺼운 이엉이 얇은 기와를 덮는 한 방향 라프로
//   읽히고, 서로 뚫고 나오는 "귀"가 사라진다. 이엉이 더 두껍고 부피가 크다는 실제 성질과도 맞는다.
const BODY_TOP_BAND = Object.freeze({
  [SIJEON_ROOF_GIWA]: Object.freeze({ base: 2.86, drop: 0.14 }),   // 벽 상단 2.72~2.86
  [SIJEON_ROOF_CHOGA]: Object.freeze({ base: 3.00, drop: 0.10 }),  // 벽 상단 2.90~3.00
});
// 두 대역 + 부재 두께가 만드는 처마 상단 최소 격차(초가 3.26 − 기와 3.01). 게이트가 이 값을 단언한다.
const EAVE_LAP_MIN = 0.2;

// 지붕 부재 최고점 상한. `src/runtime/village/village-door-records.js#sijeonRecord` 가 시전 문 가림
//   occluder 를 `baseY .. baseY + ROOF_TOP_CEILING_Y` 프리즘으로 세우므로 두 값은 반드시 동조한다
//   (occluder 가 실제 질량보다 낮으면 문 가림 판정이 틀린다).
//   [2026-08-05 재핀, 비전 판정 근거] v3 의 4.7 은 "3 + rise 1.7" 에서 나온 값이고, v4 초가가 그
//   상한에 갇혀 물매가 과도하게 완만해졌다 — 비전 실측 평결: "얇은 접시/파라솔로 읽히고 지붕이
//   매스의 1/4, 벽 3/4". 초가 이엉의 실제 볼륨(두께 0.36 + 물매 1.78~1.94)을 담도록 5.6 으로 올린다.
//   기와는 종전 치수를 그대로 두므로(비전 출하 판정) 이 상향은 초가 전용 여유다.
//   FAIL-first 확인: 이 값을 4.7 로 되돌리면 `check:sijeon` 이 초가 최고점 초과로 실패한다.
const ROOF_TOP_CEILING_Y = 5.6;

// 지붕 유형별 형태 수치. 초가 지수 4종은 `src/builder/thatch-profile.js#THATCH_SHAPE` 에서 가져오므로
//   프로젝트에 이엉 형상 방언이 둘로 갈리지 않는다. 기와 물매는 `src/builder/roof.js` 의 오목 물매
//   (용마루 쪽이 급하고 처마 쪽이 완만)와 `roof-skeleton.js` 의 앙곡·처마 내밈 어휘를 같은 성격의
//   1파라미터 형태로 축약했다 — 행랑은 100~200채라 필지 집채 격자(48×22 / 56×44)를 쓸 수 없다.
const ROOF_TUNING = Object.freeze({
  [SIJEON_ROOF_GIWA]: Object.freeze({
    role: 'gable-roof',
    sideRole: 'gable-wall',        // 맞배 측면 폐합은 실제 박공벽이다
    ridgeRole: 'ridge-tile',
    thickness: 0.15,              // 기와+적심+개판의 수직 두께(종전 슬래브 0.14 와 같은 인상)
    riseBase: 1.24,
    riseSpan: 0.14,
    sideOverhangBase: 0.70,
    sideOverhangSpan: 0.10,
    endOverhangBase: 0.80,
    endOverhangSpan: 0.10,
    slopeCurve: 0.55,             // 물매 오목: drop = 1 − (1 − v)^(1+slopeCurve)
    cornerLift: 0.13,             // 앙곡(처마 양끝 들림). 안허리곡(평면 내밈)은 비채택 — 아래 주석
    cornerLiftPow: 2.2,
    ridgeHalfDepth: 0.26,
    ridgeTop: 0.17,
    ridgeSink: 0.05,
    sections: 7,                  // 행랑 진행축 단면 수
    slopeSteps: 3,                // 용마루→처마 분할(한 면당)
    uv: Object.freeze({ mode: 'unit-slope' }),
  }),
  [SIJEON_ROOF_CHOGA]: Object.freeze({
    role: 'hip-roof',
    sideRole: 'eave-closure',     // 우진각은 박공이 없다 — 측벽 상부 처마 폐합
    ridgeRole: 'ridge-roll',
    thickness: 0.36,              // 이엉 두께
    // [2026-08-05 물매 상향] 종전 1.04~1.18 은 occluder 4.7 상한에 갇힌 값이었고 비전 판정에서
    //   "얇은 접시/파라솔, 지붕이 매스의 1/4" 로 기각됐다. 이엉이 매스의 ~44% 를 차지하게 올린다
    //   (벽 2.76~3.0 + 이엉 두께 0.36 + 물매 1.78~1.94).
    riseBase: 1.78,
    riseSpan: 0.16,
    sideOverhangBase: 0.72,
    sideOverhangSpan: 0.10,
    endOverhangBase: 0.82,
    endOverhangSpan: 0.10,
    rollHalfDepth: 0.22,
    rollTop: 0.17,
    // 용마루 반길이 / 지붕 반폭. 그 밖이 마구리 경사면(hip)이다 — 폭 6.18m 점포에서 용마루 2.6m,
    //   마구리 경사 1.79m 씩. 실측 칸 수가 아니라 제품 비례다.
    ridgeHalfRatio: 0.42,
    sections: 9,                  // = sectionUnits 가 만드는 노드 수(0, ±4)
    slopeSteps: 4,                // 처마→용마루 4분할. 3분할은 물매 꺾임이 값 단계로 드러났다
    uv: Object.freeze({ mode: 'world', tile: 1.25 }),
  }),
});

// 안허리곡(처마선의 평면 내밈) 비채택 근거: 내밈은 `corridor.maxEaveZ` 를 점포 양끝에서 더 밀어
//   도로 회랑 예외를 넓힌다. 이번 범위는 지붕 형태이므로 회랑 계약을 건드리지 않는 앙곡(수직)만
//   채택한다. 필요해지면 `maxEaveZ` 재계약과 함께 별도로 다룬다.

// 폐합 부재가 지붕면 아래로 남기는 여유 = 부재 두께의 절반. 이 규칙이 v4 의 "지붕이 벽체 위에
//   앉는다"를 증명한다: 폐합 상단 = 그 지점의 지붕면 − 두께/2 이므로 (a) 지붕면을 뚫지 않고
//   (b) 지붕 밑면(= 지붕면 − 두께)보다 항상 위에 있어 틈이 남지 않는다. v3 의 고정 0.12m 는 선형
//   지붕면 전제였고, 곡면에서는 위치별로 달라져야 한다.
const CLOSURE_ALLOWANCE_RATIO = 0.5;
// 압출 프리즘의 퇴화 방지 최소 높이(ExtrudeGeometry 는 중복점에서 NaN 을 낸다).
const CLOSURE_MIN_HEIGHT = 0.02;
const CLOSURE_SAMPLES = 5;
// 폐합 상단이 지붕면/지붕 밑면에서 최소한 이만큼 떨어진다(부동소수 여유 + 시각적 안전).
const CLOSURE_SEAT_MARGIN = 0.01;
// 용마름 캡 해상도. 능선 방향 5단면 × 폭 방향 5점 = 32 삼각형(단면).
const RIDGE_CAP_SECTIONS = 5;
const RIDGE_CAP_STEPS = 2;

// FNV-1a 는 마지막 문자만 다른 짧은 키(`s41`·`s42` …)에서 하위 비트 확산이 부족하다. 실측
//   2026-08-05: 연속 5개 ID 가 같은 구간으로 떨어질 확률 0.896(이상값 0.558) → 블록이 88.5%
//   단일 유형이 되고 혼합비도 0.307/0.284 로 치우쳤다. 추출 전에 32bit 아발란치를 한 번 걸어
//   해시 품질을 고친다. `hashString` 자체는 건드리지 않는다 — v2 표식 배치 바이트가 걸려 있다.
function unit01(key) {
  let h = hashString(key);
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 8) / 0x1000000;
}

/**
 * Deterministic roof type for one placement record (v4).
 *
 * Pure: `hashString` only, zero ambient RNG consumption. Records without an id are
 * dimension-only fixtures and get `SIJEON_ROOF_MIX.fallbackKind`.
 */
export function sijeonRoofKind(shop) {
  const id = shop?.id;
  if (id == null || id === '') return SIJEON_ROOF_MIX.fallbackKind;
  const blockKey = shop?.segment?.id ? `seg|${shop.segment.id}` : `solo|${String(id)}`;
  const giwaBlock = unit01(`sijeon-roof-block|${blockKey}`) < SIJEON_ROOF_MIX.giwaBlockShare;
  const share = giwaBlock ? SIJEON_ROOF_MIX.giwaInGiwaBlock : SIJEON_ROOF_MIX.giwaInChogaBlock;
  return unit01(`sijeon-roof|${String(id)}`) < share ? SIJEON_ROOF_GIWA : SIJEON_ROOF_CHOGA;
}

// 단위 변주(v4). id 없는 순수 치수 fixture 는 전 축 0 = 저작된 기준 치수 그대로.
function jitter01(id, axis) {
  if (id == null || id === '') return 0;
  return unit01(`sijeon-${axis}|${String(id)}`);
}

function finiteDimension(value, name) {
  if (!Number.isFinite(value)) throw new TypeError(`sijeon ${name} must be finite`);
  if (value <= 0) throw new RangeError(`sijeon ${name} must be positive`);
  return value;
}

function box(role, x, y, z, width, height, depth, extra = {}) {
  return {
    role,
    center: { x, y, z },
    size: { width, height, depth },
    ...extra,
  };
}

/** True when the record owns a rendered two-bay shop mass. */
export function isSijeonShop(record) {
  return !!record && record.kind !== SIJEON_KIND_BREAK;
}

function footprintRecord(base, tan, inward, pitch, depth, id, kind) {
  const poly = G.frontageParcel(base, tan, inward, pitch * 0.5, depth, 0);
  return {
    id,
    kind,
    poly,
    center: G.polyCentroid(poly),
    frontDir: G.norm(G.mul(inward, -1)),
    x: base.x,
    z: base.z,
    w: pitch,
    d: depth,
  };
}

function annotateSegment(members, segmentId) {
  const length = members.length;
  if (!length) return;
  for (let index = 0; index < length; index++) {
    const role = length === 1 ? 'solo'
      : index === 0 ? 'start'
        : index === length - 1 ? 'end'
          : 'mid';
    members[index].segment = Object.freeze({
      id: segmentId,
      index,
      length,
      role,
    });
  }
}

/**
 * Place market-row footprints along arterial (daero) façades.
 *
 * Continuous shop runs are capped into product blocks of `segmentShops` units,
 * separated by `segmentGapPitches` reserved empty footprints (`kind: 'break'`).
 * Breaks stay in the returned array so village planning can keep them as parcel
 * blockers without drawing shop mass.
 *
 * `char01` remains in the signature because the village planner already passes
 * it, although placement never consumes it. Keeping that no-op input avoids
 * changing callers or the downstream random stream.
 */
// reach(pt) → 그 지점에 행랑을 이어붙일 수 있는가. 기본은 분지 반경 컷(종전 동작 정확 재현)이고,
//   성곽이 있는 도성은 호출부가 "성벽 안쪽 + 문전 마당 밖"을 넘긴다: docs/joseon-city.md §시전행랑 은
//   행랑 구간을 "종루~남대문, 종묘~동대문"으로 명시하므로 행랑은 성문까지 이어져야 한다. 분지 0.9R
//   컷은 그 구간을 성문에서 100~300m 앞에서 끊고 있었다.
// runCap → (도로, 면)당 **점포** 상한. 기본값은 legacy `SIJEON_PLACEMENT.runCap` 이고, 성곽 도성은
//   호출부가 Infinity 를 넘겨 "간선 파사드 전체를 reach 가 정한다"로 바꾼다. 상한은 프리픽스 컷이라
//   유한값에서는 도로 시작부만 채워지므로(실측 2026-08-04: hanyang 51레코드 전부 daero-001 시작
//   151m = 도로의 22.1%), 문서 조항의 "성문에 닿는 연속 파사드"와 양립하지 않는다.
//   예약 공백(kind:'break')은 상한을 먹지 않는다 — 빈 footprint 가 점포 슬롯을 훔치면 같은 상한이
//   분절 주기에 따라 실효 점포 수를 바꾼다(26슬롯 → 점포 22채).
export function planSijeon(roadsResult, site, _char01 = 0.5, { reach, runCap: runCapOption } = {}) {
  const shops = [];
  const arterials = (roadsResult?.roads || []).filter((road) => road.level === 'daero');
  const {
    pitch,
    depth,
    setback,
    segmentShops,
    segmentGapPitches,
  } = SIJEON_PLACEMENT;
  const runCap = runCapOption === undefined ? SIJEON_PLACEMENT.runCap : runCapOption;
  if (typeof runCap !== 'number' || Number.isNaN(runCap) || runCap <= 0) {
    throw new RangeError('sijeon runCap must be a positive number or Infinity');
  }
  const bowlR = site.bowlR;
  const others = (road) => arterials.filter((candidate) => candidate !== road);
  let sid = 0;
  let segmentSerial = 0;

  for (const road of arterials) {
    const fine = G.resample(road.pts, pitch);
    if (fine.length < 8) continue;
    const halfRoadWidth = road.width / 2;
    const crossingArterials = others(road);
    for (let side = 1; side >= -1; side -= 2) {
      let run = 0;
      let consecutiveShops = 0;
      let openSegment = [];
      let pendingBreakPitches = 0;

      const flushSegment = () => {
        if (!openSegment.length) return;
        annotateSegment(openSegment, `seg${segmentSerial++}`);
        openSegment = [];
      };

      for (let i = 3; i < fine.length - 3 && run < runCap; i++) {
        const sample = fine[i];
        const withinReach = reach
          ? reach(sample.pt)
          : G.dist(sample.pt, site.center) <= bowlR * 0.9;
        if (!withinReach) {
          // Natural hole in the bowl — close the current block without inventing a break.
          flushSegment();
          consecutiveShops = 0;
          pendingBreakPitches = 0;
          continue;
        }
        const inward = G.mul(G.perpL(sample.tan), side);
        const base = G.add(sample.pt, G.mul(inward, halfRoadWidth + setback));
        let clashes = false;
        for (const other of crossingArterials) {
          if (G.distToPolyline(base, other.pts).d < other.width / 2 + depth) {
            clashes = true;
            break;
          }
        }
        if (clashes) {
          // Crossing-arterial clearance already opens a large gap; start a new block after it.
          flushSegment();
          consecutiveShops = 0;
          pendingBreakPitches = 0;
          continue;
        }

        if (pendingBreakPitches > 0) {
          shops.push(footprintRecord(
            base,
            sample.tan,
            inward,
            pitch,
            depth,
            `s${sid++}`,
            SIJEON_KIND_BREAK,
          ));
          pendingBreakPitches--;
          continue;
        }

        const shop = footprintRecord(
          base,
          sample.tan,
          inward,
          pitch,
          depth,
          `s${sid++}`,
          SIJEON_KIND_SHOP,
        );
        shops.push(shop);
        openSegment.push(shop);
        consecutiveShops++;
        run++;

        if (consecutiveShops >= segmentShops) {
          flushSegment();
          consecutiveShops = 0;
          pendingBreakPitches = segmentGapPitches;
        }
      }
      flushSegment();
    }
  }
  return shops;
}

/**
 * Derive a restrained two-bay shop facade from one placement record.
 *
 * The output is plain serializable data. It describes only physical members;
 * materials, textures, Three.js objects, merge strategy, and LOD remain renderer
 * concerns. Eaves are the sole planned solid allowed beyond `streetEdgeZ`.
 * Break footprints have no facade — callers must filter with `isSijeonShop`.
 */

function planSparseSigns(shop, { bayWidth, lintels, frontZ }) {
  const id = shop?.id;
  if (id == null || id === '') return [];
  const h = hashString(`sijeon-sign|${String(id)}`);
  const unit = ((h >>> 8) & 0xffffff) / 0x1000000;
  if (unit >= SIJEON_SIGN_POLICY.maxShare) return [];
  const bay = h & 1;
  const silhouette = SIJEON_SIGN_POLICY.silhouettes[(h >>> 1) & 1];
  const lintel = lintels[bay];
  if (!lintel) return [];
  const lintelBottom = lintel.center.y - lintel.size.height / 2;
  const centerZ = frontZ - SIGN_THICKNESS / 2;
  const centerX = lintel.center.x;
  if (silhouette === 'plank') {
    const width = Math.min(bayWidth * 0.42, lintel.size.width * 0.55);
    const height = 0.16;
    const centerY = lintelBottom - SIGN_HANG_GAP - height / 2;
    return [box('marker-board', centerX, centerY, centerZ, width, height, SIGN_THICKNESS, {
      bay, silhouette: 'plank', mount: 'lintel-hang', decorative: true, emissive: false,
    })];
  }
  const width = 0.3;
  const height = 0.58;
  const centerY = lintelBottom - SIGN_HANG_GAP - height / 2;
  return [box('marker-board', centerX, centerY, centerZ, width, height, SIGN_THICKNESS, {
    bay, silhouette: 'tablet', mount: 'lintel-hang', decorative: true, emissive: false,
  })];
}

// ── v4 지붕 표면 ────────────────────────────────────────────────────────────────────────
// 두 유형이 같은 한 가지 표현을 쓴다: 행랑 진행축(x)을 따라 늘어선 단면 목록 `sections[i]` 와 각
//   단면의 (z, y) 점열 `points[j]`. renderer 는 (a) 상면 로프트 (b) 두께만큼 내린 밑면 (c) 격자
//   경계 테두리만 만든다 — 형태 추론이 없다. 초가 우진각은 양끝 단면의 z 반폭이 0 으로 수렴해
//   지붕이 스스로 닫히고, 기와 맞배는 양끝 단면이 그대로 박공 쪽 마구리(rake)가 된다.

function giwaSurfaceY(tune, geom, x, z) {
  const vv = Math.min(1, Math.abs(z) / geom.halfRoofDepth);
  const au = Math.min(1, Math.abs(x) / geom.halfRoofWidth);
  const lift = tune.cornerLift * Math.pow(au, tune.cornerLiftPow);
  return geom.eaveTopY + geom.rise * Math.pow(1 - vv, 1 + tune.slopeCurve) + lift * vv * vv;
}

// 우진각 마구리 파라미터: 용마루 끝(|u| = ridgeHalfRatio) 안쪽은 0, 지붕 끝(|u| = 1)에서 1.
//   [2026-08-05 R2 — R1 설계 오류 정정] R1 은 `THATCH_SHAPE.planExponent` 의 Lp **둥근사각 평면**을
//   지붕 전체에 적용하고, 그 평면이 벽 모서리를 덮도록 지수를 상향 탐색했다. 그 구성은 서로 배타적인
//   두 요구를 한 파라미터에 걸었다: (a) 벽을 덮을 만큼 각져야 하고 (b) 우진각으로 읽힐 만큼 둥글어야
//   한다. 측면 내밈이 pitch 클램프로 0.11m 가 된 뒤에는 지수 64 로도 (a) 가 성립하지 않았다.
//   **오류의 정체**: 둥근 평면은 우진각(hip)이 아니라 이엉 모서리의 둥글림을 모델링한 것이었다.
//   진짜 우진각은 **처마선이 직사각**이고 마구리 쪽 **면이 경사지는** 형태다. 따라서 평면 둥글림을
//   버리고 높이 항만 남긴다 — `thatch-profile.js#descend` 의 `side` 항과 같은 성격이다.
//   결과: 피복이 구성으로 보장되고(평면 = 직사각), 유한 길이 용마루 + 양단 경사 마구리가 생긴다.
function chogaHipDrop(tune, u) {
  const au = Math.min(1, Math.abs(u));
  const r = tune.ridgeHalfRatio;
  if (au <= r) return 0;
  return Math.min(1, (au - r) / Math.max(1e-6, 1 - r));
}

// 처마선은 직사각이다(우진각의 처마는 돌아가며 같은 깊이). 피복 문제가 원리적으로 생기지 않는다.
function chogaPlanHalfDepth(geom) {
  return geom.halfRoofDepth;
}

// 단면 u 좌표. roofSections 와 반드시 같은 열을 써야 한다.
//   기와(맞배): 등간격. 마구리 경사가 없다.
//   초가(우진각): **용마루 끝(±ridgeHalfRatio)에 노드를 박는다.** 그 자리가 용마루와 마구리 경사면이
//     갈리는 능선이므로, 노드가 없으면 한 사각형 안에서 두 면이 섞여 용마루 길이가 흐려진다.
function sectionUnits(tune) {
  if (!tune.ridgeHalfRatio) {
    const spans = tune.sections - 1;
    const units = [];
    for (let i = 0; i <= spans; i++) units.push((2 * i) / spans - 1);
    return units;
  }
  const r = tune.ridgeHalfRatio;
  const half = [r * 0.5, r, r + (1 - r) * 0.5, 1];
  const units = [0];
  for (const u of half) {
    units.push(u);
    units.unshift(-u);
  }
  return units;
}

// 계획이 내보낸 **격자**에서 읽는 지붕면 높이. 폐합 부재는 해석식이 아니라 이 값을 기준으로 삼는다 —
//   소비자가 실제로 렌더하는 것이 이 저해상 격자이므로, 해석 곡면과의 테셀레이션 오차가 그대로 벽 위
//   틈으로 남는다(게이트 실측 2026-08-05: 해석식 기준으로는 기와 전면 폐합에 2.5mm 틈). 렌더러와
//   같은 대각 분할을 쓴다.
function chogaSurfaceYFromUT(tune, geom, u, t) {
  const hip = THATCH_SHAPE.hipExponent;
  const side = chogaHipDrop(tune, u);
  const drop = Math.min(1, Math.pow(
    Math.pow(Math.min(1, Math.abs(t)), hip) + Math.pow(side, hip),
    1 / hip,
  ));
  // 용마루 처짐: 용마루 중앙에서 최대, 용마루 끝(±ridgeHalfRatio)에서 0.
  const along = Math.max(0, 1 - Math.pow(
    Math.min(1, Math.abs(u) / Math.max(1e-6, tune.ridgeHalfRatio)),
    2,
  ));
  return geom.eaveTopY
    + geom.rise * (1 - Math.pow(drop, THATCH_SHAPE.surfaceExponent))
    - THATCH_SHAPE.ridgeSag * along * (1 - drop);
}

// 유형별 단면 격자. 계획이 소유하는 지붕 형상의 전부이고, renderer 는 이것만 로프트한다.
function roofSections(kind, tune, geom) {
  const steps = tune.slopeSteps;
  const units = sectionUnits(tune);
  const sections = [];
  for (const u of units) {
    const x = u * geom.halfRoofWidth;
    const half = kind === SIJEON_ROOF_CHOGA
      ? chogaPlanHalfDepth(geom)
      : geom.halfRoofDepth;
    const points = [];
    for (let j = -steps; j <= steps; j++) {
      const t = j / steps;
      const z = t * half;
      const y = kind === SIJEON_ROOF_CHOGA
        ? chogaSurfaceYFromUT(tune, geom, u, t)
        : giwaSurfaceY(tune, geom, x, z);
      points.push({ z, y });
    }
    sections.push({ x, points });
  }
  return sections;
}

function triangleYAt(a, b, c, x, z) {
  const det = (b.z - c.z) * (a.x - c.x) + (c.x - b.x) * (a.z - c.z);
  if (Math.abs(det) < 1e-12) return null;
  const w0 = ((b.z - c.z) * (x - c.x) + (c.x - b.x) * (z - c.z)) / det;
  const w1 = ((c.z - a.z) * (x - c.x) + (a.x - c.x) * (z - c.z)) / det;
  const w2 = 1 - w0 - w1;
  const eps = 1e-7;
  if (w0 < -eps || w1 < -eps || w2 < -eps) return null;
  return w0 * a.y + w1 * b.y + w2 * c.y;
}

function latticeSurfaceYAt(sections, x, z) {
  let span = -1;
  for (let i = 0; i < sections.length - 1; i++) {
    if (x >= sections[i].x - 1e-9 && x <= sections[i + 1].x + 1e-9) {
      span = i;
      break;
    }
  }
  if (span < 0) return null;
  const left = sections[span];
  const right = sections[span + 1];
  let best = null;
  for (let j = 0; j < left.points.length - 1; j++) {
    const p00 = { x: left.x, z: left.points[j].z, y: left.points[j].y };
    const p01 = { x: left.x, z: left.points[j + 1].z, y: left.points[j + 1].y };
    const p10 = { x: right.x, z: right.points[j].z, y: right.points[j].y };
    const p11 = { x: right.x, z: right.points[j + 1].z, y: right.points[j + 1].y };
    for (const [a, b, c] of [[p00, p01, p10], [p01, p11, p10]]) {
      const y = triangleYAt(a, b, c, x, z);
      if (y !== null && (best === null || y > best)) best = y;
    }
  }
  return best;
}

// 폐합 프리즘의 (축, y) 다각형. 바닥은 벽 상단 직선, 위는 그 지점의 지붕면 − 두께/2.
function closureProfile(topAt, from, to, baseY) {
  const profile = [{ u: from, y: baseY }];
  for (let i = 0; i < CLOSURE_SAMPLES; i++) {
    const u = from + ((to - from) * i) / (CLOSURE_SAMPLES - 1);
    profile.push({ u, y: Math.max(baseY + CLOSURE_MIN_HEIGHT, topAt(u)) });
  }
  profile.push({ u: to, y: baseY });
  return profile;
}

// 벽 상단~지붕면 폐합 4방향.
//   프리즘은 두 면 사이 구간을 차지하므로 그 구간 안에서 지붕면 높이가 변한다. 유효 구간은
//     [높은면 − 두께, 낮은면] — 이 아래면 벽 위에 틈이 남고, 이 위면 지붕면을 뚫는다.
//   기본값은 "낮은면 − 두께/2" 이지만, 좁은 점포의 초가처럼 마구리 경사가 급해 벽 두께 구간에서
//   높이차가 두께/2 를 넘는 경우가 있다(실측 2026-08-05: 4.4×5.6 lot 에서 0.27m 차 → 2.4cm 틈).
//   그래서 기본값을 유효 구간으로 클램프한다. 구간 자체가 비면(높이차 > 두께) 관통 금지를 우선하고
//   게이트가 남은 틈을 잡는다 — 조용히 벽을 지붕 위로 밀어내지 않는다.
function planRoofClosures(tune, box, sections) {
  const { halfWidth, backZ, frontZ, wallThickness, wallTopY } = box;
  const allowance = tune.thickness * CLOSURE_ALLOWANCE_RATIO;
  // 격자 밖(= 지붕이 벽을 못 덮는 상태)이면 폐합을 낮게 두고 게이트가 그 미피복을 잡게 한다.
  const surfaceY = (x, z) => {
    const y = latticeSurfaceYAt(sections, x, z);
    return y === null ? wallTopY + allowance : y;
  };
  const seatY = (a, b) => {
    const low = Math.min(a, b);
    const high = Math.max(a, b);
    const noPierce = low - CLOSURE_SEAT_MARGIN;
    const noGap = high - tune.thickness + CLOSURE_SEAT_MARGIN;
    return Math.min(noPierce, Math.max(low - allowance, noGap));
  };
  const closures = [];
  for (const side of [-1, 1]) {
    const outer = side * halfWidth;
    const inner = side * (halfWidth - wallThickness);
    closures.push({
      role: tune.sideRole,
      axis: 'x',
      side,
      center: side * (halfWidth - wallThickness / 2),
      extent: wallThickness,
      profile: closureProfile(
        (z) => seatY(surfaceY(outer, z), surfaceY(inner, z)),
        backZ,
        frontZ,
        wallTopY,
      ),
    });
  }
  for (const end of [1, -1]) {
    const outer = end > 0 ? frontZ : backZ;
    const inner = outer - end * wallThickness;
    closures.push({
      role: 'eave-closure',
      axis: 'z',
      end: end > 0 ? 'front' : 'rear',
      center: outer - (end * wallThickness) / 2,
      extent: wallThickness,
      profile: closureProfile(
        (x) => seatY(surfaceY(x, outer), surfaceY(x, inner)),
        -halfWidth,
        halfWidth,
        wallTopY,
      ),
    });
  }
  return closures;
}

// 용마루(기와) / 용마름(초가).
//   기와: 능선이 직선이므로 (z, y) 사다리꼴 단면을 진행축 전체로 압출한 프리즘 하나 — 비전 출하 판정.
//   초가: **압출 프리즘을 쓸 수 없다.** R1 은 (x, y) 리본을 롤 폭만큼 압출했는데, 단면이 일정한
//     프리즘은 처지는 능선을 따라갈 수 없고 기준 높이를 해석 곡면에서 읽어 테셀레이션 격자보다
//     위에 떴다. 결과는 "돔에서 뜬 직립 평판 + 좌우 끝의 정육면체 블록"(= 리본 마구리 단면
//     0.22×0.38)이라는 역광 실루엣 최대 결함이었다(비전 차단 판정 2026-08-05).
//     v4 R2 는 이엉을 말아 능선에 **얹은 볼륨**으로 다시 만든다: 진행축 단면열마다 격자 돔 높이에
//     정확히 붙는 양끝과 중앙이 부푼 아치를 두고, 양 끝단은 높이를 0 으로 죽여 마구리 블록을 없앤다.
//     기준 높이를 `latticeSurfaceYAt` 로 읽으므로 렌더되는 표면과 밀착이 구성으로 보장된다.
function planRoofRidge(kind, tune, geom, sections) {
  if (kind === SIJEON_ROOF_GIWA) {
    const r = tune.ridgeHalfDepth;
    const topY = geom.ridgeApexY + tune.ridgeTop;
    const baseY = geom.ridgeApexY - tune.ridgeSink;
    return {
      role: tune.ridgeRole,
      kind: 'ridge-prism',
      axis: 'x',
      center: 0,
      extent: geom.halfRoofWidth * 2,
      topY,
      profile: [
        { u: -r, y: baseY },
        { u: -r * 0.58, y: topY },
        { u: r * 0.58, y: topY },
        { u: r, y: baseY },
      ],
    };
  }
  // 용마름: **용마루 구간만** 덮는 단면열(그 밖은 마구리 경사면이므로 롤이 지나가면 모히칸이 된다).
  //   양끝 점은 격자 돔에 정확히 붙고 중앙이 부푼다.
  const halfLen = tune.ridgeHalfRatio * geom.halfRoofWidth;
  const spans = RIDGE_CAP_SECTIONS - 1;
  const steps = RIDGE_CAP_STEPS;
  const lines = [];
  let topY = -Infinity;
  for (let i = 0; i <= spans; i++) {
    const x = -halfLen + (2 * halfLen * i) / spans;
    // 끝단으로 갈수록 롤 높이를 죽인다 — 뭉툭한 마구리(= R1 의 "정육면체 블록")를 만들지 않는다.
    const taper = Math.pow(Math.max(0, 1 - Math.pow(Math.abs(x) / halfLen, 4)), 0.35);
    const points = [];
    for (let j = -steps; j <= steps; j++) {
      const s = j / steps;
      const z = s * tune.rollHalfDepth;
      const base = latticeSurfaceYAt(sections, x, z);
      const domeY = base === null ? geom.eaveTopY : base;
      const bulge = tune.rollTop * Math.pow(Math.max(0, 1 - s * s), 0.62) * taper;
      const y = domeY + bulge;
      if (y > topY) topY = y;
      points.push({ z, y });
    }
    lines.push({ x, points });
  }
  return {
    role: tune.ridgeRole,
    kind: 'ridge-cap',
    topY,
    lines,
  };
}

export function planSijeonFacade(shop) {
  if (shop?.kind === SIJEON_KIND_BREAK) {
    throw new RangeError('sijeon break footprints have no facade mass');
  }
  const lotWidth = finiteDimension(shop?.w, 'width');
  const lotDepth = finiteDimension(shop?.d, 'depth');
  if (lotWidth < MIN_WIDTH) {
    throw new RangeError(`sijeon width must be at least ${MIN_WIDTH}m for two bays`);
  }
  if (lotDepth < MIN_DEPTH) {
    throw new RangeError(`sijeon depth must be at least ${MIN_DEPTH}m`);
  }

  // v4 단위 변주: 유형·벽 상단·물매·처마 내밈은 모두 점포 ID 해시에서 나온다(전역 RNG 0).
  const shopId = shop?.id;
  const roofKind = sijeonRoofKind(shop);
  const tune = ROOF_TUNING[roofKind];
  const band = BODY_TOP_BAND[roofKind];
  const bodyHeight = band.base - band.drop * jitter01(shopId, 'eave');
  const rise = tune.riseBase + tune.riseSpan * jitter01(shopId, 'rise');
  const overhangJitter = jitter01(shopId, 'overhang');
  const endOverhang = tune.endOverhangBase + tune.endOverhangSpan * overhangJitter;

  // Preserve the former visible mass while replacing its blank front wall.
  const width = lotWidth * 0.96;
  const depth = lotDepth * 0.86;
  const halfWidth = width / 2;
  const halfDepth = depth / 2;
  const streetEdgeZ = lotDepth / 2;
  const frontZ = halfDepth;
  const backZ = -halfDepth;
  const bayWidth = width / SIJEON_FACADE_BAYS;

  const columnWidth = Math.min(0.26, bayWidth * 0.1);
  const columnDepth = 0.26;
  const columnHeight = bodyHeight - 0.22;
  const columnZ = frontZ - columnDepth / 2;
  const columnInset = columnWidth / 2;
  const columns = [-halfWidth + columnInset, 0, halfWidth - columnInset]
    .map((x, index) => box(
      'front-column',
      x,
      columnHeight / 2,
      columnZ,
      columnWidth,
      columnHeight,
      columnDepth,
      { index },
    ));

  const lintelHeight = 0.28;
  const lintelDepth = 0.3;
  const lintelWidth = bayWidth - columnWidth;
  const lintelY = columnHeight - lintelHeight / 2;
  const lintels = [-bayWidth / 2, bayWidth / 2].map((x, bay) => box(
    'front-lintel',
    x,
    lintelY,
    frontZ - lintelDepth / 2,
    lintelWidth,
    lintelHeight,
    lintelDepth,
    { bay },
  ));

  const openingRecess = 0.46;
  const openingDepth = 0.12;
  const openingWidth = bayWidth - columnWidth * 1.55;
  const openingSill = 0.22;
  const openingTop = lintelY - lintelHeight / 2 - 0.08;
  const openingHeight = openingTop - openingSill;
  // 판문(plank shutter): 개구 한 짝을 밖으로 접어 세운 널문. 발굴이 확인한 것은 기둥·마룻장과 함께
  //   "문짝"을 갖춘 목조건축이므로(서울역사박물관 청진동 유구), 개구를 빈 공동으로 남기면 사료가
  //   확인한 부재를 지우고 현대 쇼윈도·동굴로 읽힌다(docs/sijeon.md §3.2-4, architectural-
  //   authenticity.md §7.5 W2-3). 기둥 뒷면과 후퇴 배면 사이에 한 장 서므로 가로 진입로(streetEdgeZ)
  //   밖으로 나가지 않고, 남은 개구 폭으로는 배면 목재 면이 그대로 보인다.
  //   좌우 칸은 각각 바깥쪽으로 접혀 결정론적이다 — 칸별 난수 없음.
  const panelThickness = 0.07;
  const panelZ = frontZ - columnDepth - 0.04;
  const panelWidth = openingWidth * 0.44;
  const openings = [-bayWidth / 2, bayWidth / 2].map((x, bay) => box(
    'recessed-opening',
    x,
    openingSill + openingHeight / 2,
    frontZ - openingRecess - openingDepth / 2,
    openingWidth,
    openingHeight,
    openingDepth,
    {
      bay,
      recessed: true,
      panel: box(
        'plank-shutter',
        x + (bay === 0 ? -1 : 1) * (openingWidth - panelWidth) / 2,
        openingSill + openingHeight / 2,
        panelZ,
        panelWidth,
        openingHeight,
        panelThickness,
        { bay, side: bay === 0 ? -1 : 1 },
      ),
    },
  ));

  const benchHeight = 0.58;
  const benchDepth = Math.min(0.62, lotDepth * 0.075);
  const benchWidth = openingWidth * 0.88;
  const benchFrontZ = Math.min(streetEdgeZ, frontZ + benchDepth * 0.48);
  const benches = [-bayWidth / 2, bayWidth / 2].map((x, bay) => box(
    'display-bench',
    x,
    benchHeight / 2,
    benchFrontZ - benchDepth / 2,
    benchWidth,
    benchHeight,
    benchDepth,
    { bay },
  ));

  // 벽 두께는 개구가 정한다: 측벽 안쪽 면이 바깥 칸 개구의 바깥 변을 넘으면 계획된 개방 전면을
  //   덮는다(= 발굴 사료가 확인한 어휘를 지우는 것). 그 상한을 그대로 두께로 쓴다 —
  //   결과는 0.775×columnWidth(폭 6.2m 점포에서 0.20m)이고 미감 선택이 아니다.
  const wallThickness = halfWidth - (bayWidth + openingWidth) / 2;

  const storageDepth = Math.min(2.5, depth * 0.34);
  const storageClearance = 0.16;
  const storage = box(
    'rear-storage',
    0,
    (bodyHeight - 0.22) / 2,
    backZ + wallThickness + storageDepth / 2,
    width - (storageClearance + wallThickness) * 2,
    bodyHeight - 0.22,
    storageDepth,
  );

  // 측면 처마 내밈은 **필지 폭이 허용하는 만큼만**(v4 R2, 2026-08-05).
  //   실측 결함: 배치 pitch 는 6.2m 인데 저작 내밈 0.70~0.82 를 쓰면 지붕 폭이 7.5m 가 되어 인접
  //   점포 지붕이 1.27m 겹쳤다. v3 는 전 점포가 동일 높이·형상의 평면 슬래브였으므로 그 겹침이
  //   같은 평면에 묻혀 보이지 않았지만, v4 는 유형·높이가 달라 **기와 지붕면이 옆 초가 돔을
  //   관통하고 초가가 귀처럼 삐져나온다**(부감 히어로 프레임에서 비전 차단 판정).
  //   행랑은 벽을 맞댄 연속 건물이므로 인접(내림)측에는 애초에 rake 내밈이 없다 — 지붕이 맞닿는다.
  //   1cm 씩 물려 정확한 동일 평면 접촉(z-fighting)도 피한다. 가로를 향한 전·배면 내밈은 그대로다:
  //   원경의 정보량인 연속 처마선은 그쪽이 만든다(docs/sijeon.md §1.1·§4.2).
  const partyOverhangCap = Math.max(0.02, (lotWidth - width) / 2 - 0.01);
  const sideOverhang = Math.min(
    tune.sideOverhangBase + tune.sideOverhangSpan * overhangJitter,
    partyOverhangCap,
  );

  // 지붕(v4). 처마 **밑면**이 벽 상단에 앉고 지붕면은 그보다 부재 두께만큼 높다 — 도리·서까래가
  //   벽 위에 올라앉는 실제 순서이고, 이 한 줄이 v3 의 관통/부유 문제를 구조적으로 없앤다.
  const roofWidth = width + sideOverhang * 2;
  const roofDepth = depth + endOverhang * 2;
  const halfRoofWidth = roofWidth / 2;
  const halfRoofDepth = roofDepth / 2;
  const eaveTopY = bodyHeight + tune.thickness;
  const geom = {
    halfRoofWidth,
    halfRoofDepth,
    eaveTopY,
    rise,
    ridgeApexY: eaveTopY + rise,
    // 벽 측면이 지붕 반폭의 몇 %에 오는가. 초가는 이 안쪽을 전폭으로 두고 밖에서만 둥글린다.
    coverRatio: halfWidth / halfRoofWidth,
  };
  const sections = roofSections(roofKind, tune, geom);
  const ridge = planRoofRidge(roofKind, tune, geom, sections);
  let sampledRidgeY = -Infinity;
  for (const section of sections) {
    for (const point of section.points) {
      if (point.y > sampledRidgeY) sampledRidgeY = point.y;
    }
  }

  const roof = {
    role: tune.role,
    kind: roofKind,
    center: { x: 0, y: bodyHeight, z: 0 },
    width: roofWidth,
    depth: roofDepth,
    rise,
    thickness: tune.thickness,
    eaveProjection: {
      side: (roofWidth - width) / 2,
      front: Math.max(0, halfRoofDepth - streetEdgeZ),
      rear: Math.max(0, halfRoofDepth - lotDepth / 2),
    },
    surface: {
      kind: 'section-loft',
      sections: tune.sections,
      slopeSteps: tune.slopeSteps,
      // 벽 측면이 지붕 반폭의 몇 %인가. 초가 마구리 둥글림은 이 밖에서만 일어난다.
      coverRatio: geom.coverRatio,
      uv: { ...tune.uv },
      // 단면 목록. renderer 는 이 격자만 로프트한다(형태 재추론 금지).
      lines: sections,
    },
    ridge,
  };

  // 벽체 완결(#54 → v4). v2 계획은 전면 골조·후면 저장 박스·박공지붕만 소유해서 측면·배면·박공이
  //   열려 있었고(지붕판이 벽 없이 뜨고 밑면 노출, 성문 접근로 망원 실측 2026-08-04), v3 는 그
  //   틈을 **선형 지붕면 전제의 스칼라 상한** 하나로 닫았다. v4 의 지붕면은 곡면이고 유형별로
  //   다르므로 스칼라로는 닫히지 않는다 → 벽은 본체 높이까지만 올리고, 벽 상단~지붕면 사이는
  //   네 방향 `closures[]` 프리즘이 그 지점의 실제 지붕면을 따라 닫는다.
  //   전면 개방 점포(기둥·인방·판문·좌판)는 사료 근거 어휘이므로 축소하지 않는다(§1.4, §3.2-4).
  const rearWall = box(
    'rear-wall',
    0,
    bodyHeight / 2,
    backZ + wallThickness / 2,
    width,
    bodyHeight,
    wallThickness,
  );
  const sideWalls = [-1, 1].map((side) => box(
    'side-wall',
    side * (halfWidth - wallThickness / 2),
    bodyHeight / 2,
    0,
    wallThickness,
    bodyHeight,
    depth,
    { side },
  ));
  // 포벽 자리의 얇은 상벽: 인방 상단부터 벽 상단까지. 그 위는 전면 폐합 프리즘이 잇는다.
  const frontHeader = box(
    'front-header',
    0,
    (columnHeight + bodyHeight) / 2,
    frontZ - wallThickness / 2,
    width,
    bodyHeight - columnHeight,
    wallThickness,
  );

  const closures = planRoofClosures(tune, {
    halfWidth,
    backZ,
    frontZ,
    wallThickness,
    wallTopY: bodyHeight,
  }, sections);
  let closureMinTopY = Infinity;
  let closureMaxTopY = -Infinity;
  for (const closure of closures) {
    for (const point of closure.profile) {
      if (point.y <= bodyHeight + 1e-12) continue;
      if (point.y < closureMinTopY) closureMinTopY = point.y;
      if (point.y > closureMaxTopY) closureMaxTopY = point.y;
    }
  }

  const signs = planSparseSigns(shop, { bayWidth, lintels, frontZ });

  return {
    schemaVersion: SIJEON_FACADE_SCHEMA_VERSION,
    bayCount: SIJEON_FACADE_BAYS,
    axis: { front: { x: 0, z: 1 } },
    lot: {
      width: lotWidth,
      depth: lotDepth,
      bounds: {
        minX: -lotWidth / 2,
        maxX: lotWidth / 2,
        minZ: -lotDepth / 2,
        maxZ: streetEdgeZ,
      },
    },
    building: {
      width,
      depth,
      height: bodyHeight,
      bounds: {
        minX: -halfWidth,
        maxX: halfWidth,
        minZ: backZ,
        maxZ: frontZ,
      },
    },
    corridor: {
      streetEdgeZ,
      maxNonEaveZ: streetEdgeZ,
      maxEaveZ: halfRoofDepth,
    },
    // 벽 위에서 지붕까지의 높이 계약(v4).
    //   wallTopY   = 벽 상단 = 처마 **밑면**
    //   eaveTopY   = 처마 지붕면 상단 (= wallTopY + roof.thickness)
    //   ridgeY     = 실제 로프트 표면의 최고점(초가는 용마루 처짐 때문에 apex 보다 낮다)
    //   topY       = 용마루/용마름을 포함한 지붕 부재 최고점 — 문 가림 occluder 상한 대조용
    //   slabAllowance = 폐합 프리즘이 그 지점 지붕면 아래로 남기는 여유 (= 두께 × 0.5)
    roofline: {
      wallTopY: bodyHeight,
      eaveTopY,
      ridgeY: sampledRidgeY,
      apexY: geom.ridgeApexY,
      topY: Math.max(sampledRidgeY, ridge.topY),
      ceilingY: ROOF_TOP_CEILING_Y,
      thickness: tune.thickness,
      slabAllowance: tune.thickness * CLOSURE_ALLOWANCE_RATIO,
      closureMinTopY: Number.isFinite(closureMinTopY) ? closureMinTopY : bodyHeight,
      closureMaxTopY: Number.isFinite(closureMaxTopY) ? closureMaxTopY : bodyHeight,
    },
    columns,
    lintels,
    openings,
    benches,
    walls: [rearWall, ...sideWalls, frontHeader],
    closures,
    storage,
    roof,
    signs,
    // Optional placement context — present when the shop came from planSijeon.
    segment: shop?.segment ?? null,
  };
}
