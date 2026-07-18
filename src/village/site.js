import { makeRng } from '../rng.js';
import { makeWorldEdge } from '../env/worldedge.js';

// 마을 전용 사이트 지형 — 배산임수(背山臨水)의 토대. (joseon-city.md 규칙 1·2·16)
//   기존 env/terrain.js 는 단일 건물용(평탄 24m + -x 고정 개울축)이라 마을 스케일과
//   배산임수 축(뒤 -z 능선, 앞 +z 물)에 안 맞아, 마을 스케일 heightfield 를 여기서 새로 만든다.
//
// 구도(부감에서 읽혀야 하는 것):
//   - 주산(主山): 북(-z)에 가장 높은 능선. 마을의 등.
//   - 좌청룡·우백호: 동(+x)·서(-x)로 감싸 내려오는 옆 능선(팔).
//   - 명당(明堂): 주산 남쪽 기슭의 완만한 분지 — 마을이 앉는 자리(약간 북고남저).
//   - 명당수(明堂水): 마을 앞(남, +z)을 동서로 가로지르는 개울. 그 남쪽은 안산(案山) 낮은 언덕.
//   - 진입은 남(+z)에서 개울을 건너 북으로 오르며 위계가 상승(동구→…→종가).
//
// makeSite({ scale, seed }) → 순수 데이터 + heightAt/hillAt 클로저.

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const clampN = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const lerpN = (a, b, t) => a + (b - a) * t;

// 컴팩트 시드 value-noise(fBm). terrain.js 와 같은 방식이되 이 모듈 자립.
function makeNoise(seed) {
  const rng = makeRng(seed);
  const perm = new Uint8Array(512), base = new Uint8Array(256);
  for (let i = 0; i < 256; i++) base[i] = i;
  for (let i = 255; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); const t = base[i]; base[i] = base[j]; base[j] = t; }
  for (let i = 0; i < 512; i++) perm[i] = base[i & 255];
  const lat = (ix, iz) => perm[(perm[ix & 255] + iz) & 255] / 255 * 2 - 1;
  const sm = (t) => t * t * (3 - 2 * t);
  const noise = (x, z) => {
    const x0 = Math.floor(x), z0 = Math.floor(z), fx = x - x0, fz = z - z0;
    const v00 = lat(x0, z0), v10 = lat(x0 + 1, z0), v01 = lat(x0, z0 + 1), v11 = lat(x0 + 1, z0 + 1);
    const sx = sm(fx), sz = sm(fz);
    const a = v00 + (v10 - v00) * sx, b = v01 + (v11 - v01) * sx;
    return a + (b - a) * sz;
  };
  const fbm = (x, z, oct = 4) => {
    let sum = 0, amp = 0.5, freq = 1, norm = 0;
    for (let o = 0; o < oct; o++) { sum += amp * noise(x * freq, z * freq); norm += amp; amp *= 0.5; freq *= 2.03; }
    return sum / norm;
  };
  return { noise, fbm };
}

// ── 규모 연속축(#89) ── siteR(분지 반경, m) 스칼라 하나에서 지형·기복·능선·지형범위를 파생.
//   기존 5 이산 프리셋을 "연속 함수의 앵커(제어점)"로 재해석한다. 각 앵커에서 정확히 재현(회귀 안전),
//   중간 임의 R 은 보간. 사용자 피드백: 4버튼 대신 스케일 슬라이더 하나(hamlet↔hanyang 매끈 연결).
//   benchDrop = 분지 내부 완경사 총 낙차(주산측 → 개울측), undAmp = 저진폭 언듈레이션 진폭.
export const SCALE_ANCHORS = [
  { name: 'hamlet',  siteR: 74,  ridgeH: 46,  benchDrop: 2.6, undAmp: 0.50 },
  { name: 'village', siteR: 128, ridgeH: 68,  benchDrop: 3.6, undAmp: 0.62 },
  { name: 'town',    siteR: 176, ridgeH: 88,  benchDrop: 4.6, undAmp: 0.72 },
  { name: 'capital', siteR: 250, ridgeH: 124, benchDrop: 5.6, undAmp: 0.82 },
  // 한양 도성급(#47): capital 대비 선형 2배 = 면적 4배. 내사산이 도성을 감싸는 큰 분지.
  { name: 'hanyang', siteR: 500, ridgeH: 150, benchDrop: 8.0, undAmp: 1.02 },
];
const R_MIN = SCALE_ANCHORS[0].siteR * 0.86;              // 앵커 하한 살짝 아래까지 허용(파탄 없이)
const R_MAX = SCALE_ANCHORS[SCALE_ANCHORS.length - 1].siteR * 1.04;
const clampR = (R) => clampN(R, R_MIN, R_MAX);

// 앵커 필드(ridgeH·benchDrop·undAmp)의 R-구간 선형보간. 밖은 끝 앵커로 클램프.
function anchorField(R, key) {
  const A = SCALE_ANCHORS;
  if (R <= A[0].siteR) return A[0][key];
  for (let i = 1; i < A.length; i++) {
    if (R <= A[i].siteR) return lerpN(A[i - 1][key], A[i][key], (R - A[i - 1].siteR) / (A[i].siteR - A[i - 1].siteR));
  }
  return A[A.length - 1][key];
}

// 한양 전용 특수 계수(#77·#78·#86 산물)를 보간축에 흡수: capital(R=250)=기본, hanyang(R=500)=압축.
//   도시가 커질수록 주변 개활지·산 범위를 도성 + 적정 버퍼로 조여(terrainMul↓·ridgeMul↓) 불필요한
//   원경 지형 렌더를 없앤다(사용자 반복 피드백: 지형 반경은 마을 반경에 비례 종속). 능선을 도성 뒤로
//   바짝 당기고(mtnMul) 안산을 앞으로 당겨(ansanMul) 성저십리 폭을 압축. R<250 은 기본값(전 규모 불변).
function specialCoeffs(R) {
  const t = clampN((R - 250) / (500 - 250), 0, 1);
  return {
    ridgeMul:   lerpN(1.45, 1.00, t),   // 능선 바깥 런(완만 사면)
    terrainMul: lerpN(1.55, 1.06, t),   // 지형 메시·수목 범위(마을 대비 버퍼)
    mtnMul:     lerpN(-1.02, -0.98, t), // 주산 능선 z(도성 뒤로 당김)
    ansanMul:   lerpN(0.92, 0.86, t),   // 안산 z(앞으로 당김)
  };
}

// siteR(연속) → 사이트 파생 파라미터. 5 이산 앵커에서 기존값 정확 재현.
export function siteConfigFor(R) {
  return {
    siteR: R, dry: false,
    ridgeH: anchorField(R, 'ridgeH'),
    benchDrop: anchorField(R, 'benchDrop'),
    undAmp: anchorField(R, 'undAmp'),
    ...specialCoeffs(R),
  };
}

// scale 입력 정규화: 프리셋명 | 절대 siteR(m, >1) | 0..1 정규화(슬라이더). → siteR(m).
//   숫자 문자열(URL 파라미터·폼 입력, 예 '370')도 숫자로 해석한다.
export function resolveSiteR(scale) {
  if (typeof scale === 'string') {
    const a = SCALE_ANCHORS.find((x) => x.name === scale);
    if (a) return a.siteR;
    const n = parseFloat(scale);
    if (isFinite(n)) scale = n; else return SCALE_ANCHORS[1].siteR;
  }
  if (typeof scale === 'number' && isFinite(scale)) {
    if (scale >= 0 && scale <= 1) return scale01ToR(scale);
    return clampR(scale);
  }
  return SCALE_ANCHORS[1].siteR;
}

// 0..1 정규화 ↔ siteR: 5앵커를 균등 구간(0/0.25/0.5/0.75/1.0)에 매핑 → 슬라이더 사분점이 명명 tier.
export function scale01ToR(t) {
  const A = SCALE_ANCHORS, n = A.length - 1;
  const f = clampN(t, 0, 1) * n;
  const i = Math.min(n - 1, Math.floor(f));
  return lerpN(A[i].siteR, A[i + 1].siteR, f - i);
}
export function rToScale01(R) {
  const A = SCALE_ANCHORS, n = A.length - 1;
  R = clampN(R, A[0].siteR, A[n].siteR);
  for (let i = 1; i <= n; i++) {
    if (R <= A[i].siteR) return (i - 1 + (R - A[i - 1].siteR) / (A[i].siteR - A[i - 1].siteR)) / n;
  }
  return 1;
}

// R → 이산 tier(토폴로지·성곽·궁 임계 분기용). 지형은 연속이되, 도로망·성곽·시전·궁 tier 처럼
//   본질적으로 불연속인 문법은 임계에서 스냅한다(joseon-city 문법). 앵커 재현: 74·128·176·250·500 →
//   hamlet·village·town·capital·hanyang. 경계는 앵커 산술중점(단, capital↔hanyang 은 성곽 등장을
//   R400 으로 잡아 R370=성곽없는 대형 도성, R440=성곽 도성 — #89 연속성 게이트 전후 대비).
export function tierForR(R) {
  if (R < 101) return 'hamlet';
  if (R < 152) return 'village';
  if (R < 213) return 'town';
  if (R < 400) return 'capital';
  return 'hanyang';
}

export function makeSite({ scale = 'village', siteR, seed = 20260716,
  undAmpK = 1, ridgeHK = 1, streamMeanderK = 1, stream = true } = {}) {
  const R = clampR(typeof siteR === 'number' && isFinite(siteR) ? siteR : resolveSiteR(scale));
  const cfg = siteConfigFor(R);
  // ── 지형 옵션 표면화(#91) ── 무옵션 기본(K=1·stream=true)에서 현행 정확 재현. 전부 "현행값에 대한
  //   배율/토글"이라 절대값 하드코딩 이식 없음. 극단에서도 필지 유효성 검사(parcels)가 파탄을 흡수.
  const uAmpK = clampN(undAmpK, 0, 2.2);      // 기복(언듈레이션) 진폭 배율
  const rHK = clampN(ridgeHK, 0.5, 1.6);      // 배산 능선·봉우리 높이 배율(Hmax)
  const meK = clampN(streamMeanderK, 0, 2.5); // 개울 사행(굽이) 정도 배율
  const dry = stream === false ? true : cfg.dry;   // 개울 유무(off=내륙 마른 마을: 개울·다리·논 소멸)
  const benchDrop = cfg.benchDrop, undAmp = cfg.undAmp * uAmpK;
  const { fbm } = makeNoise(seed ^ 0x51a1);
  // 언듈레이션 파장: 규모에 비례(분지에 2~3개 완만한 융기가 얹히도록).
  const undF = 1.4 / R, undF2 = 3.6 / R;

  // ── 주요 앵커 (z: 음수=북/뒤, 양수=남/앞) ──
  const center = { x: 0, z: -0.24 * R };      // 명당(종가·마을 중심) — 주산 남쪽 기슭
  const mountainZ = (cfg.mtnMul || -1.02) * R; // 주산 능선. #77: hanyang 은 도성 뒤로 바짝 당김
  const streamZ = 0.30 * R;                   // 명당수(앞 개울)
  const ansanZ = (cfg.ansanMul || 0.92) * R;  // 안산(앞산). #77: hanyang 은 앞으로 당겨 성저십리 폭 축소
  const bowlR = 0.56 * R;                     // 분지(마을) 반경
  const ridgeR = (cfg.ridgeMul || 1.45) * R;  // 능선 바깥(긴 런 → 완만한 사면, 검은 급면 방지). #77: hanyang 압축
  const terrainR = (cfg.terrainMul || 1.55) * R; // 지형 메시·수목 범위(마을보다 넓게). #77: hanyang 압축
  const Hmax = cfg.ridgeH * rHK;

  // 비정형 월드 외곽선(worldedge) — 단일 씬(env/terrain.js)과 같은 makeWorldEdge 를 공유하되
  // 마을 스케일로 파라미터화. 지형 메시가 원점 중심 정사각형(-terrainR..terrainR)이라 중심은 원점.
  // populate.buildSiteTerrain 이 최외곽 정점을 edgeRadiusAt(theta) 로 신축하고 저층 운해 링을 두른다.
  // 평균 반경은 지형 범위(terrainR)에 맞춰, 내부(마을·논·개울·필지)는 신축 밴드 밖이라 불변.
  const edge = makeWorldEdge({ cx: 0, cz: 0, radius: terrainR, seed: (seed ^ 0x9e37) >>> 0, amp: 0.14, band: 0.24 });

  // ── 명당수 중심선(사행) ── 동서로 가로지르며 완만히 굽는다.
  const streamMeander = (x) => streamZ + R * 0.05 * meK * Math.sin(x / R * 3.0 + 1.1) + R * 0.03 * meK * Math.sin(x / R * 6.7);
  const streamZat = (x) => streamMeander(x);
  const streamHalf = 0.018 * R + 0.9;         // 개울 반폭
  const streamPts = [];
  const sx0 = -R * 1.02, sx1 = R * 1.02, SN = 72;
  for (let i = 0; i <= SN; i++) { const x = sx0 + (sx1 - sx0) * (i / SN); streamPts.push({ x, z: streamZat(x) }); }
  const streamCross = { x: 0, z: streamZat(0) };  // 진입 스파인이 개울을 건너는 지점(다리)

  // 능선 융기: 분지 밖으로 갈수록 상승, 뒤(북)가 가장 높고 앞(남, +z)은 열려(물·진입) 낮다.
  // 분지 가장자리에서 가파르게 솟아(가시적 사면) 바깥에서 완만해지도록 rise 곡선을 앞당긴다.
  function ridgeMass(x, z) {
    const dx = x - center.x, dz = z - center.z;
    const r = Math.hypot(dx, dz);
    const rise = smoothstep(bowlR * 0.95, ridgeR, r);   // 긴 런: 완만한 사면
    if (rise <= 0) return 0;
    // 방향 가중: 북(-z)=1, 남(+z)=열림. dirN = (북쪽일수록 +1)
    const dirN = (center.z - z) / Math.max(r, 1e-3);
    const backW = 0.30 + 0.70 * smoothstep(-0.35, 0.9, dirN);
    // 앞 중앙(진입/물)은 골짜기 입처럼 더 낮게 뚫는다.
    const frontNotch = 1 - 0.55 * smoothstep(0.35, -0.15, dirN) * Math.exp(-(x * x) / (0.20 * R * R + 1));
    return Hmax * rise * backW * frontNotch;
  }

  // 주산 봉우리(뚜렷한 실루엣) — 북쪽 능선에 2~3개 융기점.
  function mainPeaks(x, z) {
    const peaks = [
      { x: -0.10 * R, z: mountainZ,            h: Hmax * 1.18, s: 0.52 * R },
      { x: -0.52 * R, z: mountainZ + 0.16 * R, h: Hmax * 0.86, s: 0.44 * R },
      { x:  0.50 * R, z: mountainZ + 0.12 * R, h: Hmax * 0.92, s: 0.44 * R },
      // 좌청룡·우백호: 옆으로 감싸 내려오는 팔(동·서 중턱)
      { x: -0.95 * R, z: -0.34 * R, h: Hmax * 0.66, s: 0.40 * R },
      { x:  0.95 * R, z: -0.34 * R, h: Hmax * 0.66, s: 0.40 * R },
    ];
    let h = 0;
    for (const p of peaks) {
      const d2 = (x - p.x) ** 2 + (z - p.z) ** 2;
      h = Math.max(h, p.h * Math.exp(-d2 / (2 * p.s * p.s)));
    }
    return h;
  }

  // 안산(앞산): 개울 남쪽의 낮고 부드러운 언덕(앞 프레임). 중앙은 트여 원경이 보이게.
  function ansanMass(x, z) {
    if (z < streamZ + 0.06 * R) return 0;
    const rise = smoothstep(streamZ + 0.10 * R, ansanZ + 0.15 * R, z);
    const openMid = 0.5 + 0.5 * smoothstep(0.10 * R, 0.42 * R, Math.abs(x)); // 중앙 낮게(원경 열림)
    return Hmax * 0.42 * rise * openMid;
  }

  // 분지 벤치: 약간 북고남저(배산 느낌) — 완만해서 집이 앉기 좋다.
  function bench(x, z) {
    const t = smoothstep(streamZ, mountainZ + 0.12 * R, z);   // 남(0)→북(1)
    return benchDrop * t;                                     // 주산측 → 개울측 완경사(총 낙차 benchDrop)
  }

  // 언듈레이션: 완경사 위에 얹히는 저진폭·장파장 기복(잔물결이 아니라 땅의 숨결).
  //   완전 평면의 어색함을 없애되, 필지 성토 패드가 흡수할 만큼 완만하게(±undAmp).
  function undulation(x, z) {
    return undAmp * (0.72 * fbm(x * undF + 11, z * undF - 7, 3)
                   + 0.28 * fbm(x * undF2 - 5, z * undF2 + 9, 2));
  }

  // 개울 채널 파임(명당수). 중심선 근처를 수면 아래로 끌어내린다.
  function streamCarve(x, z) {
    if (dry) return { depth: 0 };
    const cz = streamZat(x);
    const d = Math.abs(z - cz);
    const k = smoothstep(streamHalf + 3.0, streamHalf * 0.3, d);
    return { depth: 2.2 * k, k };
  }

  // 분지 게이트: 분지 안 0 → 밖 1. 산 덩어리(봉우리 포함)가 분지 바닥으로 새어 들지 않게.
  function bowlGate(x, z) {
    const r = Math.hypot(x - center.x, z - center.z);
    return smoothstep(bowlR * 0.92, bowlR * 1.28, r);
  }
  // 산 덩어리(분지 밖만) — 능선·봉우리·안산 중 최대.
  function hillMass(x, z) {
    const g = bowlGate(x, z);
    const ans = ansanMass(x, z);                 // 안산은 개울 남쪽 자체 게이트
    if (g <= 0.001) return Math.max(0, ans);
    return Math.max(ridgeMass(x, z), mainPeaks(x, z) * g, ans);
  }

  function heightAt(x, z) {
    let h = Math.max(bench(x, z), hillMass(x, z));
    const hilly = hillMass(x, z);
    // 분지·평지 바닥의 미세 기복(땅의 숨결). 산으로 갈수록 자체 굴곡 노이즈가 대신하도록 억제.
    const undMask = 1 - Math.min(1, hilly / (0.12 * Hmax));
    if (undMask > 0.001) h += undMask * undulation(x, z);
    // 능선·산에만 굴곡 노이즈(분지 벤치는 완만 유지 → 집 앉히기 안정)
    if (hilly > 1.5) {
      const n = fbm(x * 0.016, z * 0.016, 4) * (0.09 * Hmax) + fbm(x * 0.05 + 4, z * 0.05 - 3, 3) * (0.03 * Hmax);
      h += n * smoothstep(1.5, 10, hilly);
    }
    const car = streamCarve(x, z);
    if (car.depth > 0) h -= car.depth;
    return h;
  }

  // hillAt: 이 점이 "산·능선"인 정도(0..1) — 나무 밀도·숲 마스크·필지 급경사 제외용.
  function hillAt(x, z) {
    return Math.min(1, hillMass(x, z) / (0.28 * Hmax));
  }

  // 개울 수면 y — 실제 파인 바닥 바로 위(파묻힘 방지).
  const streamY = (x) => heightAt(x, streamZat(x)) + 0.12;

  return {
    scale: tierForR(R), siteR: R, seed, R, terrainR, Hmax,
    edge,                                       // 비정형 외곽선(worldedge) — 지형 신축·운해 링·구름 공유
    center, entrance: { x: 0, z: streamCross.z + 0.06 * R }, // 동구: 개울 바로 북(마을측 초입)
    mountainZ, streamZ, ansanZ, bowlR, ridgeR,
    heightAt, hillAt,
    streamZat, streamY, streamHalf,
    stream: dry ? null : { pts: streamPts, width: streamHalf * 2, cross: streamCross, half: streamHalf },
    // 다랑이 논 후보역: 개울 남쪽 ~ 안산 기슭 사이 저지.
    paddyRegion: dry ? null : {
      xMin: -0.7 * R, xMax: 0.7 * R,
      zNear: streamZ + 0.05 * R, zFar: ansanZ - 0.05 * R,
    },
    bounds: { minX: -R, maxX: R, minZ: -R, maxZ: R },
  };
}
