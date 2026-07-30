import { smoothstep } from '../core/math/scalar.js';
import * as THREE from 'three';
import { makeRng } from '../rng.js';
import * as G from '../core/math/geom2.js';
import { createValueNoise2D } from '../core/math/value-noise2.js';
import { CITY_WALL_DIMENSIONS, cityWallVegetationBlocked } from './citywall-contour.js';
import { villageCanopyAtten } from './forest-canopy-atten.js';
import { foliageHillBias, stratifyFoliageRgb } from './foliage-value-stratify.js';
import { terrainGridSize } from './terrain-grid.js';
import { terrainWarpInner } from './terrain-surface.js';
import { makeVegetationMask } from './vegetation-spatial.js';
import { templeFootprint } from './temple-plan.js';
import { pavilionFootprint } from './pavilion-plan.js';

// Re-export pure attenuator so existing forest-crunch consumers stay one-import.
export { villageCanopyAtten } from './forest-canopy-atten.js';
// 외곽 산포(scatter)가 forest 와 같은 농담 축을 쓰도록 공개.
export { foliageHillBias, foliageInstanceTint, stratifyFoliageRgb } from './foliage-value-stratify.js';

// 산 숲 "수치 크런치"(#123) — forest.js 의 배치 루프(buildForestTrees·buildGraniteMassifs)에서
//   THREE 오브젝트 조립을 뺀 순수 수학만 추출한 모듈. 워커(populate.worker.js)와 메인(forest.js)이
//   공유 → 중복/드리프트 0. 출력은 transferable Float32Array(인스턴스 매트릭스 16·계절색 3).
//   ★ 워커-안전: THREE 코어 수학(Color·Matrix4)·rng·geom 만 임포트(canvas/DOM·palette 무의존).
//   ★ byte-identical: forest.js 원본과 rng 시드·소비 순서·좌표·색 계산이 완전 동일해야 한다
//     (결정론 게이트가 forest 포함 마을 해시로 워커 vs 동기 동치를 단언).
//
//   crunchForest(plan, site, opts) → { trees, rocks }
//     trees = { pineMat:Float32Array(nP*16), broadMat:Float32Array(nB*16),
//               pineCol:{spring,summer,autumn,winter}, broadCol:{...}, pineCount, broadCount, ridgePine, triCount }
//     rocks = { mat:Float32Array(nR*16), col:Float32Array(nR*3), anchors:[], count, ridgeCount }
//   forest.js buildForest 는 이 버퍼로 InstancedMesh 조립만. 워커는 이 함수를 그대로 굴려 버퍼를 넘긴다.

const linCol = (hex) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const M4 = () => new THREE.Matrix4();

// ───────────────────────── 튜닝 상수(forest.js v2 와 동일값) ─────────────────────────
const TREE_HILL_MIN = 0.05;
// R1: 1/61 → 1/66 — 크레스트·암반·성곽 회랑이 뺏은 유효 면적만큼 남은 골·중사면의 팩킹을 조여
//   총 그루수를 보존한다(사진의 골 군락 뭉침과 같은 방향, 벌목 아님).
const TREE_MIN_D_K  = 1 / 69;
const TREE_AREA_N   = 9000;
const TREE_SINK     = 0.5;
const CRAG_HILL_MIN = 0.66;   // R1.2: 0.72 는 밴드가 너무 좁아 암반 소멸(village 0개) — 0.66 으로 재개방
const CRAG_TARGET_K = 20;      // R1: 크래그 밀도 상향(12→20)
// R1: 곡률 종속 캐노피 — 양수 lap(오목/골)에 뭉치고 볼록 능선은 감쇠. mtnChance 승수 전용.
const CURV_GAIN = 22;
// R1: 곡률·크레스트 승수(평균<1)로 깎이는 수락률 보상 — 총 그루수 보존(사용자 결정: 벌목 금지).
//   R1.1: 크레스트 완화(0.88→0.70)가 면적을 돌려줘 +12~18% 과잉 — 1.42→1.22 로 기준선 회귀.
const CHANCE_RENORM = 1.22;
// R1: 성곽 시선 회랑(나무·암괴 전용) — 사진의 "능선 위 밝은 성벽 리본"을 살리는 캐노피 배제 폭.
//   플랜층(장승·당산)이 공유하는 CITY_WALL_DIMENSIONS 는 10 유지 — 플랜 해시 불침해.
const TREE_WALL_CORRIDOR = 16;
const TREE_GATE_MARGIN = 14;
export const GRANITE = 0x827f76;   // R1.1: 알베도 ~-25% — 대기 헤이즈에 참여, 사면 톤에서 분리되지 않게
const GRANITE_COL = linCol(GRANITE);
// 나무 프로토 삼각수(triCount 회계용) — forest.js 프로토와 일치.
const PINE_TRIS = 20, BROAD_TRIS = 20, FAR_TRIS = 40;
// Instancing matrix의 x/z scale에 곱해야 실제 prototype 수평 bound가 된다. 배치 후 footprint 검증과
// 브라우저 계약이 이 값을 공유해 "matrix scale=시각 반경"이라는 잘못된 가정을 막는다.
export const FOREST_VISUAL_RADIUS = Object.freeze({
  pine: 1.55,
  broad: 1.97,
  // makeCanopyBlobProto 요철 돔의 실제 XZ bound(1.322m)를 덮는 상한. 구 이중 blob(1.4515m) 값 유지 —
  //   상한을 내리면 배치 수용 집합이 넓어져 골든이 또 흔들린다.
  far: 1.46,
  // 최대 scale(1.25)·형상 perturb(1.1)·중심 이동 hypot(0.4,0.4)을 합친 해석 상한 1.9407을 올림.
  rock: 1.95,
});

// ───────────────────────── 결정론 value-noise ─────────────────────────
export function makeNoise(seed) {
  return createValueNoise2D(seed).noise;
}

// ───────────────────────── 화강암 노출장(#137) ─────────────────────────
//   ★ 정합 계약: 지형 정점색 회색 페인트(populate.js buildSiteTerrain)와 나무 rockAvoid(crunchForestTrees,
//     워커에서도 실행)가 이 "단일" 함수를 공유해야 "나무가 걷힌 곳 = 회색이 보이는 곳"이 일치한다.
//     시드는 양쪽 접근 가능한 site.seed 에서 파생(워커-메인 동일값). 노이즈는 makeRng 자립 → 공유 rng·
//     배치 rng 시퀀스 불침해(결정론). 반환 (x,z,slope,hill) → rock 노출 강도 0..1(호출측이 slope·hill 기전달).
//   레퍼런스(한국 산 항공사진): 화강암은 상부 지릉·골을 따라 가는 연회색 줄무늬 패치로만(표면 ~10–20%),
//     하부 사면은 순수 숲. → (1) 온셋을 더 급한 경사·더 높은 hill 로 올려 하부 사면 완전 제외,
//     (2) 연속 회색 띠가 아니라 노이즈 게이트된 불규칙 줄무늬로 총 커버리지를 크게 줄인다.
export function makeRockExposure(site) {
  const seed = ((site.seed || 0) ^ 0x54ec37) >>> 0;
  const nStreak = makeNoise((seed ^ 0x11) >>> 0);   // 줄무늬 본체(지릉·골 리듬)
  const nWander = makeNoise((seed ^ 0x23) >>> 0);   // 저주파 방랑(노출을 산 한쪽/특정 지릉에 몰아줌)
  const nFine   = makeNoise((seed ^ 0x37) >>> 0);   // 패치 안 결(균일 회색 방지)
  const CFs = 1 / 30, CFw = 1 / 130, CFf = 1 / 11;
  return (x, z, slope, hill) => {
    // R1: 사면 화강암 노두 격상 — 온셋 하향·임계 완화로 밝은 노출 면적 확대(지형색·나무 회피 공유).
    const base = smoothstep(0.55, 1.35, slope) * smoothstep(0.50, 0.84, hill);
    if (base <= 0) return 0;
    // 줄무늬 게이트: 방랑 노이즈로 국소 임계를 상하시켜 노출을 특정 지릉에 몰고, streak 노이즈 마루만 통과.
    const wander = 0.5 + 0.5 * nWander(x * CFw, z * CFw);
    const thr = 0.52 - 0.14 * wander;
    const streak = smoothstep(thr, thr + 0.16, nStreak(x * CFs, z * CFs));
    if (streak <= 0) return 0;
    const fine = 0.70 + 0.30 * nFine(x * CFf, z * CFf);
    return base * streak * fine;
  };
}

// ───────────────────────── 산↔마을 에코톤 필드(#115) ─────────────────────────
export function makeEcotoneField(site) {
  const C = site.center, bowlR = site.bowlR;
  const seed = ((site.seed || 0) ^ 0xec0115) >>> 0;
  const nLow = makeNoise((seed ^ 0x01) >>> 0);
  const nHi = makeNoise((seed ^ 0x02) >>> 0);
  const CF_LOW = 1 / Math.max(40, bowlR * 0.85);
  const CF_HI = 1 / Math.max(14, bowlR * 0.26);
  const INNER = 0.70, OUTER = 1.14, AMP = 0.30, HI_AMP = 0.10;
  return (x, z) => {
    const rC = Math.hypot(x - C.x, z - C.z);
    const low = nLow(x * CF_LOW, z * CF_LOW) - 0.5;
    const hi = nHi(x * CF_HI, z * CF_HI) - 0.5;
    const shift = (low * 2 * AMP + hi * 2 * HI_AMP) * bowlR;
    let a = bowlR * INNER + shift, b = bowlR * OUTER + shift;
    const aMin = bowlR * 0.52;
    if (a < aMin) { const d = aMin - a; a += d; b += d; }
    return smoothstep(a, b, rC);
  };
}

// ───────────────────────── 지형 메시면 샘플러(#86) ─────────────────────────
export function makeTerrainSampler(site, warp) {
  const TR = site.terrainR || site.R;
  const N = terrainGridSize(site);
  const cache = new Map();
  const vert = (i, j) => {
    const key = i * (N + 3) + j;
    let v = cache.get(key);
    if (!v) {
      const gx = -TR + (2 * TR) * (i / N), gz = -TR + (2 * TR) * (j / N);
      const [wx, wz] = warp(gx, gz);
      v = { x: wx, z: wz, y: site.heightAt(wx, wz) };
      cache.set(key, v);
    }
    return v;
  };
  const onMesh = (gu, gv) => {
    const i = Math.min(N - 1, Math.max(0, Math.floor(gu))), j = Math.min(N - 1, Math.max(0, Math.floor(gv)));
    const fu = gu - i, fv = gv - j;
    const a = vert(i, j), b = vert(i + 1, j), c = vert(i, j + 1), d = vert(i + 1, j + 1);
    const lx = (p, q) => p + (q - p) * fu;
    const k = (key) => lx(a[key], b[key]) + (lx(c[key], d[key]) - lx(a[key], b[key])) * fv;
    return { x: k('x'), y: k('y'), z: k('z') };
  };
  return { N, onMesh };
}
export function makeSlopeAt(site) {
  const d = 2.0;
  return (x, z) => {
    const hx = (site.heightAt(x + d, z) - site.heightAt(x - d, z)) / (2 * d);
    const hz = (site.heightAt(x, z + d) - site.heightAt(x, z - d)) / (2 * d);
    return Math.hypot(hx, hz);
  };
}
// R1: 라플라시안 곡률 — 양수 = 오목(골), 음수 = 볼록(능선). heightAt 샘플만 쓰므로 rng 불침해.
//   곡률은 저주파 필드라 d(6m) 셀 중심값으로 양자화·메모한다 — 시도당 heightAt 5회가 crunch 시간을
//   3배로 불리던 것을 셀당 1회로 줄인다(결정론: 위치만의 함수, rng 무관).
export function makeCurvatureAt(heightAt, d = 6) {
  const invD2 = 1 / (d * d);
  const cache = new Map();
  return (x, z) => {
    const ci = Math.round(x / d), cj = Math.round(z / d);
    const key = ci * 131071 + cj;
    let lap = cache.get(key);
    if (lap === undefined) {
      const cx = ci * d, cz = cj * d;
      lap = (heightAt(cx + d, cz) + heightAt(cx - d, cz) + heightAt(cx, cz + d) + heightAt(cx, cz - d)
        - 4 * heightAt(cx, cz)) * invD2;
      cache.set(key, lap);
    }
    return lap;
  };
}

// ───────────────────────── 계절 그루별 수관색 ─────────────────────────
const PINE = {
  summer: [linCol(0x2f4726), linCol(0x38562e)],
  spring: [linCol(0x3a5a2f), linCol(0x456b38)],
  autumn: [linCol(0x33492a), linCol(0x41512b)],
  winter: [linCol(0x2a3b23), linCol(0x324528)],
};
const BROAD = {
  summer: [linCol(0x4f6d33), linCol(0x5e7d3d), linCol(0x445f2c)],
  spring: [linCol(0x74a63d), linCol(0x8cbf55), linCol(0x679a34)],
  autumn: [linCol(0x6f7f30), linCol(0xd9a634), linCol(0xd0691c), linCol(0xb64b22), linCol(0xa03e26)],
  winter: [linCol(0x8a7c60), linCol(0x9a8f72), linCol(0x746850)],
};
const _c = new THREE.Color();

// 농담(濃淡) 층화 — docs/tree-look.md §3.4 결손 2·원리 ⑤. 수식 본체는 foliage-value-stratify.js.
//   ★ rng 를 새로 소비하지 않는다 — t·mosaic 은 호출부의 기존 자리 그대로이므로 배치·인스턴스
//     매트릭스는 바이트 불변이고, 바뀌는 것은 instanceColor 4버퍼뿐이다. 워커와 동기 경로가
//     이 함수를 공유하므로 두 경로는 계속 바이트 동일하다.
function stratifyValue(out, t, hillBias, deep) {
  const c = stratifyFoliageRgb(out.r, out.g, out.b, t, hillBias, deep);
  out.r = c.r; out.g = c.g; out.b = c.b;
  return out;
}

function pineColor(season, t, hillBias, out) {
  const arr = PINE[season] || PINE.summer;
  out.copy(arr[0]).lerp(arr[1], t);
  return stratifyValue(out, t, hillBias, true);
}
function broadColor(season, t, hillBias, mosaic, out) {
  const arr = BROAD[season] || BROAD.summer;
  if (season === 'autumn') {
    const f = clamp(mosaic * 0.7 + hillBias * 0.5, 0, 0.999);
    const idx = f * (arr.length - 1);
    const i0 = Math.floor(idx), i1 = Math.min(arr.length - 1, i0 + 1);
    out.copy(arr[i0]).lerp(arr[i1], idx - i0);
  } else {
    out.copy(arr[0]).lerp(arr[1], t);
    if (arr[2]) out.lerp(arr[2], (1 - mosaic) * 0.4);
  }
  return stratifyValue(out, t, hillBias, false);
}

const SEASONS = ['spring', 'summer', 'autumn', 'winter'];

// ───────────────────────── 빽빽한 숲 나무 크런치(forest.js buildForestTrees 수학 그대로) ─────────────────────────
export function crunchForestTrees(site, sampler, slopeAt, mask, seed, densityK, ecotone, clearDist, cityWall = null) {
  const TR = site.terrainR || site.R;
  const C = site.center, bowlR = site.bowlR;
  const { N, onMesh } = sampler;
  const rng = makeRng((seed ^ 0x7c0f) >>> 0);
  const grove = makeNoise((seed ^ 0x0f0e57) >>> 0);
  const mixN = makeNoise((seed ^ 0x2a11) >>> 0);
  const interiorN = makeNoise((seed ^ 0x1f77e5) >>> 0);
  const rockExp = makeRockExposure(site);   // #137 지형 회색 페인트와 공유(나무 걷힘=회색 정합)
  const curvatureAt = makeCurvatureAt(site.heightAt); // R1: 위치 결정론 곡률(rng 아님)
  // R1: 에코톤 원형 하드엣지 완화 — 방위각 저주파 노이즈(전용 시드, 배치 rng 불침해).
  const edgeNoise = makeNoise(((seed ^ 0xec0d9e) >>> 0));
  const CFG = 1 / 44;
  const CFI = 1 / Math.max(30, bowlR * 0.17);

  const mtnChance = (x, z, hill) => {
    if (hill < TREE_HILL_MIN) return 0;
    const f = ecotone(x, z);
    if (f <= 0) return 0;
    const onset = smoothstep(0.0, 0.42, f);
    const g = grove(x * CFG, z * CFG);
    const soft = 0.58 + 0.42 * smoothstep(0.34, 0.76, g);
    const hard = smoothstep(0.50, 0.70, g);
    const clumpAmt = smoothstep(0.55, 0.78, hill) * (1 - 0.6 * smoothstep(0.84, 0.97, hill));
    const gr = soft + (hard - soft) * clumpAmt;
    const far = 1 - 0.32 * smoothstep(TR * 0.72, TR * 1.0, Math.hypot(x, z));
    // #20: 분지 쪽 산기슭 밀도를 살짝 낮춰 담장 실루엣 여유를 만들고, 같은 mtnTarget 은
    //   외곽 사면에서 채운다(총 그루수 유지·민둥산 금지).
    const rC = Math.hypot(x - C.x, z - C.z);
    const settleSoft = 0.48 + 0.52 * smoothstep(bowlR * 0.50, bowlR * 0.92, rC);
    // R1: 곡률 승수(골↑ 능선↓) + 크레스트 밴드 캐노피 억제(화강암·관목이 이어받음).
    //   배치 루프는 목표 도달형이 아니라 수락률 제한형이라 평균<1 승수가 그대로 총량을 깎는다 —
    //   CHANCE_RENORM 으로 평균 수락률을 복원해 총 그루수를 보존한다(분포만 이동).
    const lap = curvatureAt(x, z);
    const curveW = clamp(1 + lap * CURV_GAIN, 0.35, 1.6);
    const crestW = 1 - 0.70 * smoothstep(0.82, 0.94, hill);   // R1.1: 능선을 완전 비우지 않고 노송 실루엣 몫을 남김
    return onset * gr * far * settleSoft * curveW * crestW * CHANCE_RENORM;
  };
  const KEEP = Math.max(7, bowlR * 0.05);
  const RAMP = Math.max(28, bowlR * 0.30);
  // R1: KEEP/RAMP 방위각 변조 — clearDist 램프의 원형 하드엣지를 저주파로 흔든다.
  const keepRampAt = (x, z) => {
    const th = Math.atan2(z - C.z, x - C.x);
    const edgeN = edgeNoise(Math.cos(th) * 2.3, Math.sin(th) * 2.3);
    return { keep: KEEP * (0.55 + 0.9 * edgeN), ramp: RAMP * (0.62 + 0.75 * edgeN) };   // R1.1: 진폭 1.5배
  };
  const infillChance = (x, z, hill) => {
    if (!clearDist || hill > 0.5) return 0;
    const cd = clearDist(x, z);
    // #20: 구조물 클리어 램프를 약간 밖으로 밀어 담장 크라운 바로 옆 침투목을 줄인다.
    //   목표 그루수는 그대로라 더 먼 빈터로 이동한다. R1: 방위각 변조로 원형 엣지 완화.
    const { keep, ramp } = keepRampAt(x, z);
    const clear = smoothstep(keep * 1.12, keep + ramp * 1.12, cd);
    if (clear <= 0) return 0;
    const rC = Math.hypot(x - C.x, z - C.z);
    const radial = 0.16 + 0.84 * smoothstep(bowlR * 0.20, bowlR * 0.88, rC);
    const gr = smoothstep(0.42, 0.80, interiorN(x * CFI, z * CFI));
    const south = 1 - 0.5 * smoothstep(0, bowlR * 0.6, (z - C.z));
    return clear * radial * gr * south * 0.9;
  };
  const hidden = (x, z, yHere) => {
    const dx = x - C.x, dz = z - C.z;
    let mx = -Infinity;
    for (let t = 1; t <= 4; t++) { const s = t / 5, h = site.heightAt(C.x + dx * s, C.z + dz * s); if (h > mx) mx = h; }
    return mx > yHere + 4;
  };

  const areaK = (TR * TR) / (200 * 200);
  const mtnTarget = Math.min(TR > 480 ? 40000 : (TR > 300 ? 20000 : 14000), Math.round(TREE_AREA_N * areaK * densityK));
  const infillTarget = Math.min(TR > 480 ? 5500 : (TR > 300 ? 5000 : 3800), Math.round(2400 * areaK * densityK));
  const R = site.R || TR;
  const minD = Math.max(2.6, R * TREE_MIN_D_K);
  const grid = new Map();
  const gkey = (x, z) => Math.floor(x / minD) * 92821 ^ Math.floor(z / minD);
  const tooClose = (x, z) => {
    const cx = Math.floor(x / minD), cz = Math.floor(z / minD);
    for (let ix = cx - 1; ix <= cx + 1; ix++) for (let iz = cz - 1; iz <= cz + 1; iz++) {
      const arr = grid.get(ix * 92821 ^ iz); if (!arr) continue;
      for (const p of arr) if ((p.x - x) ** 2 + (p.z - z) ** 2 < minD * minD) return true;
    }
    return false;
  };

  // #137 원경 나무 LOD — 마을 중심에서 nearR 밖의 산나무는 개별 나무(InstancedMesh)가 아니라 클러스터
  //   블롭(여러 그루→큰 덩어리 1인스턴스)으로 뭉갠다. 카메라는 항상 마을을 보므로 정적 방사 분할이 옳다
  //   (팝핑 없음). nearR 은 focus/walk 근접(마을 가장자리)에서 진짜 나무가 보이도록 bowlR 여유 이상.
  //   FAR 는 정점수·인스턴스수를 동시에 줄이되 계절색 모자이크(클러스터 평균색)·능선 실루엣은 보존.
  //   #143: site.nearR 가 단일 진실원(site.js 가 이 경계에 지형 외곽 terrainR 을 밀착) — 그 값을 소비해
  //   지형 가장자리와 far 블롭 경계가 정확히 일치하게 한다. 폴백은 동일 공식(구 경로·해시 불변).
  const nearR = site.nearR != null ? site.nearR : (bowlR * 1.15 + Math.max(34, bowlR * 0.28));
  const clusterCell = Math.max(9, minD * 3.4);            // ~5:1 병합 목표(밀집 사면 기준)
  const clusters = new Map();                             // 삽입순 결정론(워커=메인 동일 배치순서)

  const pineM = [], broadM = [];
  const pineC = { spring: [], summer: [], autumn: [], winter: [] };
  const broadC = { spring: [], summer: [], autumn: [], winter: [] };
  let ridgePine = 0;
  const place = (chanceFn, passTarget, allowHidden, maxAtt, rockAvoid, allowFar) => {
    let placed = 0, attempts = 0;
    const cap = maxAtt || passTarget * 20;
    while (placed < passTarget && attempts < cap) {
      attempts++;
      const gu = rng() * N, gv = rng() * N;
      const p = onMesh(gu, gv);
      const hill = site.hillAt(p.x, p.z);
      if (rng() > chanceFn(p.x, p.z, hill)) continue;
      if (mask && mask(p.x, p.z)) continue;
      if (tooClose(p.x, p.z)) continue;
      if (!allowHidden && hill > 0.5 && hidden(p.x, p.z, p.y)) continue;
      const slope = slopeAt(p.x, p.z);
      if (rockAvoid && hill > 0.55) {
        // #137 rockExp 공유 필드 — 나무가 걷힌 곳 = 지형이 회색으로 칠해지는 곳(정합). 단 남는 rock 패치
        //   안에도 keep 하한(0.30)으로 나무가 군데군데 침투(레퍼런스: 바위 사이 초록) → 완전 벌목 방지.
        const rock = rockExp(p.x, p.z, slope, hill);
        if (rock > 0) {
          const clear = 1 - smoothstep(0.30, 0.82, rock);
          const keep = 0.30 + 0.70 * clear;
          if (rng() > keep) continue;
        }
      }
      const pineBias = smoothstep(0.42, 0.74, mixN(p.x / 60 + 3, p.z / 60 - 5)) * 0.4 + smoothstep(0.50, 0.90, hill) * 0.6;
      const isPine = rng() < clamp(0.28 + pineBias, 0.18, 0.9);
      // R1: s0·yStretch0 원값을 먼저 뽑아 노송 재해석(rng 소비 순서·횟수 불변).
      const s0 = rng.range(0.72, 1.35);
      const u = (s0 - 0.72) / (1.35 - 0.72);
      const y = p.y - (TREE_SINK + Math.min(2.4, slope * 1.9));
      // RNG 소비 순서는 감쇠 전·후로 바뀌면 안 된다(워커/동기 동치). 스케일·회전을 먼저 뽑고
      //   #20 위치 기반 수관 감쇠만 곱한다.
      const yaw = rng() * Math.PI * 2;
      const yStretch0 = rng.range(0.9, 1.25);
      const t = rng();
      const mosaic = rng();
      // R1 노송 개체: 고지대 소나무의 상위 ~4%(u>0.96)만 대형·낮은 수관으로 승격. 그 외 기존 식.
      let s, yStretch;
      if (hill > 0.55 && isPine && u > 0.98) {   // R1.1: 4%→2%, 크기·수관비 강화(개체 실루엣이 읽히게)
        s = s0 * 3.0;
        yStretch = 0.60 + 0.22 * (yStretch0 - 0.9) / 0.35;
      } else {
        s = s0 * (isPine ? 1.1 : 1.0) * (1 - 0.18 * smoothstep(0.6, 0.95, hill));
        yStretch = yStretch0;
      }
      const hillBias = foliageHillBias(hill);
      const rC = Math.hypot(p.x - C.x, p.z - C.z);
      const cd = clearDist ? clearDist(p.x, p.z) : Infinity;
      const { keep: attenKeep, ramp: attenRamp } = keepRampAt(p.x, p.z);
      const { yMul, xzMul } = villageCanopyAtten(rC, bowlR, cd, attenKeep, attenRamp);
      const sx = s * xzMul;
      const sy = s * yStretch * yMul;
      const m = M4().makeTranslation(p.x, y, p.z)
        .multiply(M4().makeRotationY(yaw))
        .multiply(M4().makeScale(sx, sy, sx));
      // 초기 mask는 점 anchor만 보므로 수관이 성벽·성문 시야 안으로 다시 들어올 수 있다.
      // 크기·회전·색에 필요한 RNG를 모두 소비한 뒤 실제 prototype 반경으로 재검사해 worker와
      // 동기 경로의 난수 순서는 같게 유지하면서 최종 footprint 계약을 닫는다.
      const visualRadius = sx * (isPine ? FOREST_VISUAL_RADIUS.pine : FOREST_VISUAL_RADIUS.broad);
      if (mask && mask(p.x, p.z, visualRadius)) continue;
      if (cityWallVegetationBlocked(cityWall, p, {
        corridor: visualRadius + TREE_WALL_CORRIDOR,
        gateMargin: visualRadius + TREE_GATE_MARGIN,
        gateApproachMargin: visualRadius,
      })) continue;
      { const k = gkey(p.x, p.z); let a = grid.get(k); if (!a) { a = []; grid.set(k, a); } a.push({ x: p.x, z: p.z }); }
      const far = allowFar && rC > nearR;
      if (!far) {
        if (isPine) {
          pineM.push(m);
          for (const se of SEASONS) { pineColor(se, t, hillBias, _c); pineC[se].push(_c.r, _c.g, _c.b); }
          if (hill > 0.7) ridgePine++;
        } else {
          broadM.push(m);
          for (const se of SEASONS) { broadColor(se, t, hillBias, mosaic, _c); broadC[se].push(_c.r, _c.g, _c.b); }
        }
      } else {
        // FAR: 클러스터 셀에 위치·스케일·계절색 누적(문자열 키 — 비트해시 충돌 회피, 결정론).
        //   감쇠된 xz 스케일(sx)을 누적해 블롭 footprint 가 근경 감쇠와 맞는다.
        const ck = Math.floor(p.x / clusterCell) + '_' + Math.floor(p.z / clusterCell);
        let cl = clusters.get(ck);
        if (!cl) { cl = { sx: 0, sy: 0, sz: 0, ss: 0, n: 0, col: { spring: [0, 0, 0], summer: [0, 0, 0], autumn: [0, 0, 0], winter: [0, 0, 0] } }; clusters.set(ck, cl); }
        cl.sx += p.x; cl.sy += y; cl.sz += p.z; cl.ss += sx; cl.n++;
        for (const se of SEASONS) {
          if (isPine) pineColor(se, t, hillBias, _c); else broadColor(se, t, hillBias, mosaic, _c);
          const a = cl.col[se]; a[0] += _c.r; a[1] += _c.g; a[2] += _c.b;
        }
      }
      placed++;
    }
  };
  // R1: 곡률·크레스트·암반 회피가 유효 면적을 줄여 기본 상한(target×20)에서 총량이 ~20-30% 깎인다.
  //   시도 상한을 올려 같은 총량을 남은 유효 면적(골·중사면)에서 채운다 — 분포만 이동, 벌목 아님.
  place(mtnChance, mtnTarget, false, mtnTarget * 22, true, true);
  place(infillChance, infillTarget, true, Math.min(infillTarget * 14, 58000), false, false);

  // #137 FAR 클러스터 → 저폴리 캐노피 블롭 인스턴스(계절색 4버퍼 = 클러스터 평균색 → 모자이크 보존).
  const farM = [], farC = { spring: [], summer: [], autumn: [], winter: [] };
  let farTreeN = 0;
  for (const cl of clusters.values()) {
    const inv = 1 / cl.n;
    const cx = cl.sx * inv, cz = cl.sz * inv;
    const cy = site.heightAt(cx, cz) - TREE_SINK;         // 중심 재샘플(정확한 지면 안착)
    const avgS = cl.ss * inv;
    const spread = clusterCell * (0.46 + 0.05 * Math.min(5, cl.n));   // 클러스터 footprint 커버
    const blobH = 3.0 + avgS * 3.6;                        // 캐노피 매스 높이(능선 실루엣 유지)
    // 개별 anchor는 mask를 통과해도 셀 centroid로 합친 큰 blob의 반경이 성벽을 다시 덮을 수 있다.
    // 최종 footprint 반경까지 확장한 동일 판정으로 후단을 닫는다. 충돌 cluster는 생략해 성벽 주변 시야와
    // 드로우 예산을 함께 확보하며, RNG 시퀀스는 이미 끝난 뒤라 worker/sync 결정론에 영향이 없다.
    const visualRadius = spread * FOREST_VISUAL_RADIUS.far;
    if (mask && mask(cx, cz, visualRadius)) continue;
    if (cityWallVegetationBlocked(cityWall, { x: cx, z: cz }, {
      corridor: visualRadius + TREE_WALL_CORRIDOR,
      gateMargin: visualRadius + TREE_GATE_MARGIN,
      gateApproachMargin: visualRadius,
    })) continue;
    farTreeN += cl.n;
    farM.push(M4().makeTranslation(cx, cy, cz).multiply(M4().makeScale(spread, blobH, spread)));
    for (const se of SEASONS) { const a = cl.col[se]; farC[se].push(a[0] * inv, a[1] * inv, a[2] * inv); }
  }

  const flatM = (arr) => { const out = new Float32Array(arr.length * 16); for (let i = 0; i < arr.length; i++) out.set(arr[i].elements, i * 16); return out; };
  const f = (a) => new Float32Array(a);
  const farCount = farM.length;
  const triCount = (pineM.length * PINE_TRIS) + (broadM.length * BROAD_TRIS) + (farCount * FAR_TRIS);
  return {
    pineMat: flatM(pineM), broadMat: flatM(broadM),
    pineCol: { spring: f(pineC.spring), summer: f(pineC.summer), autumn: f(pineC.autumn), winter: f(pineC.winter) },
    broadCol: { spring: f(broadC.spring), summer: f(broadC.summer), autumn: f(broadC.autumn), winter: f(broadC.winter) },
    farMat: flatM(farM),
    farCol: { spring: f(farC.spring), summer: f(farC.summer), autumn: f(farC.autumn), winter: f(farC.winter) },
    pineCount: pineM.length, broadCount: broadM.length, farCount, farTreeCount: farTreeN, ridgePine, triCount,
  };
}

// ───────────────────────── 화강암 암릉·암괴 크런치(buildGraniteMassifs 수학 그대로) ─────────────────────────
export function crunchGranite(site, sampler, slopeAt, mask, seed, densityK, cityWall = null) {
  const TR = site.terrainR || site.R;
  const C = site.center, bowlR = site.bowlR, Hmax = site.Hmax;
  const { N, onMesh } = sampler;
  const rng = makeRng((seed ^ 0x60c17a) >>> 0);
  const chainN = makeNoise((seed ^ 0x71d18b) >>> 0);
  const CF = 1 / Math.max(30, bowlR * 0.5);

  const crestChance = (x, z, hill, slope) => {
    // R1.2: 유효 밴드 0.66~0.86(상단 소프트 페이드) — 무목·안개 최상단의 "접시 위 돌" 배제(비전 판정).
    if (hill < CRAG_HILL_MIN || hill > 0.86) return 0;
    const cl = smoothstep(0.50, 0.82, chainN(x * CF, z * CF));
    const hi = smoothstep(CRAG_HILL_MIN, 0.76, hill) * (1 - smoothstep(0.80, 0.86, hill));
    // R1.2: 밴드가 좁아진 만큼 밴드 안 수락 게이트(경사·체인)를 완화해 개수를 회복.
    const st = smoothstep(0.22, 0.85, slope);
    return hi * Math.max(0.6, st) * (0.14 + 0.86 * cl);
  };
  // R1: 화강암 노두 격상 — 개수 상한 72/52, CRAG_TARGET_K 20.
  const target = Math.min(TR > 480 ? 72 : 52, Math.round((TR / 200) ** 2 * CRAG_TARGET_K * densityK));
  const minD = Math.max(5.5, TR / 64);
  const grid = new Map();
  const gkey = (x, z) => Math.floor(x / minD) * 92821 ^ Math.floor(z / minD);
  const tooClose = (x, z) => {
    const cx = Math.floor(x / minD), cz = Math.floor(z / minD);
    for (let ix = cx - 1; ix <= cx + 1; ix++) for (let iz = cz - 1; iz <= cz + 1; iz++) {
      const arr = grid.get(ix * 92821 ^ iz); if (!arr) continue;
      for (const p of arr) if ((p.x - x) ** 2 + (p.z - z) ** 2 < minD * minD) return true;
    }
    return false;
  };

  const mats = [], colors = [], anchors = [];
  let attempts = 0, ridgeCount = 0;
  while (mats.length < target && attempts < target * 120   /* R1.2: 좁아진 밴드에서 개수 회복 — 루프 자체가 작아 비용 무시 */) {
    attempts++;
    const gu = rng() * N, gv = rng() * N;
    const p = onMesh(gu, gv);
    const hill = site.hillAt(p.x, p.z);
    const slope = slopeAt(p.x, p.z);
    if (rng() > crestChance(p.x, p.z, hill, slope)) continue;
    if (mask && mask(p.x, p.z)) continue;
    if (tooClose(p.x, p.z)) continue;
    const w = rng.range(3.2, 6.0) * (0.85 + 0.4 * smoothstep(0.66, 0.95, hill));   // R1.1: 수관 3~4배 이물감 → 수관급으로
    const h = w * rng.range(0.7, 1.05);
    const rotation = rng() * Math.PI * 2;
    const l = 0.6 + rng() * 0.2;
    const redJitter = rng(), blueJitter = rng();
    const visualRadius = w * FOREST_VISUAL_RADIUS.rock;
    // reject 여부와 무관하게 이 암괴의 RNG 창을 모두 소비해, 성벽 근처 한 점 제거가 이후 산 전체
    // 배치를 재시드하지 않게 한다(나무 placement와 같은 국소 변경 계약).
    if (mask && mask(p.x, p.z, visualRadius)) continue;
    if (cityWallVegetationBlocked(cityWall, p, {
      corridor: visualRadius + TREE_WALL_CORRIDOR,
      gateMargin: visualRadius + TREE_GATE_MARGIN,
      gateApproachMargin: visualRadius,
    })) continue;
    // #137 급사면 다운슬로프 float 방지 — 폭·경사 비례로 밑동을 지형에 깊이 박는다(넓은 강체가 경사에서
    //   내리막 가장자리가 뜨는 착시). w·slope 곱으로 내리막 낙차(~w·slope)를 흡수.
    const sink = w * 0.75 + slope * w * 0.6;   // R1.2: 매립 +45% — 하부 캡·분리 접지그림자 제거(비전 판정)
    const y = p.y - sink;
    mats.push(M4().makeTranslation(p.x, y, p.z).multiply(M4().makeRotationY(rotation)).multiply(M4().makeScale(w, h, w)));
    const c = GRANITE_COL.clone().multiplyScalar(l);
    c.r *= 1 + (redJitter - 0.5) * 0.04; c.b *= 1 + (blueJitter - 0.5) * 0.04;
    colors.push(c);
    anchors.push({ x: p.x, y, z: p.z, h, sink, hill });
    if (hill > 0.72) ridgeCount++;
    { const k = gkey(p.x, p.z); let a = grid.get(k); if (!a) { a = []; grid.set(k, a); } a.push({ x: p.x, z: p.z }); }
  }
  // R1: 대형 암괴 최대 3개. granite 전용 rng 스트림 말미 유지(나무 스트림 불침해). rng() 1회(0..3).
  const nLandC = (rng() * 3) | 0;   // R1.1: 최대 2개
  let placedLand = 0, landAtt = 0;
  while (placedLand < nLandC && landAtt < 400) {
    landAtt++;
    const gu = rng() * N, gv = rng() * N;
    const p = onMesh(gu, gv);
    const hill = site.hillAt(p.x, p.z);
    if (hill < 0.68 || hill > 0.82) continue;   // R1.2: 대형 암괴 밴드 0.68~0.82
    const lslope = slopeAt(p.x, p.z);
    if (lslope > 0.45) continue;   // #137 대형 암괴는 완만한 마루 어깨에만(급사면 float 방지)
    if (mask && mask(p.x, p.z)) continue;
    const w = rng.range(7, 10);    // R1.1: 대형 암괴 크기 절제
    const h = w * rng.range(0.85, 1.15);
    const rotation = rng() * Math.PI * 2;
    const l = 0.64 + rng() * 0.18;
    const visualRadius = w * FOREST_VISUAL_RADIUS.rock;
    if (mask && mask(p.x, p.z, visualRadius)) continue;
    if (cityWallVegetationBlocked(cityWall, p, {
      corridor: visualRadius + TREE_WALL_CORRIDOR,
      gateMargin: visualRadius + TREE_GATE_MARGIN,
      gateApproachMargin: visualRadius,
    })) continue;
    const sink = w * 0.68 + lslope * w * 0.8;   // R1.2: 매립 증대 — 하부 캡 노출 방지
    const y = p.y - sink;
    mats.push(M4().makeTranslation(p.x, y, p.z).multiply(M4().makeRotationY(rotation)).multiply(M4().makeScale(w, h, w)));
    colors.push(GRANITE_COL.clone().multiplyScalar(l));
    anchors.push({ x: p.x, y, z: p.z, h, sink, hill });
    ridgeCount++; placedLand++;
  }

  const mat = new Float32Array(mats.length * 16);
  for (let i = 0; i < mats.length; i++) mat.set(mats[i].elements, i * 16);
  const col = new Float32Array(colors.length * 3);
  for (let i = 0; i < colors.length; i++) { col[i * 3] = colors[i].r; col[i * 3 + 1] = colors[i].g; col[i * 3 + 2] = colors[i].b; }
  return { mat, col, anchors, count: mats.length, ridgeCount };
}

// ───────────────────────── forest 입력 빌더(populate.js 에서 이설 — 워커 공유) ─────────────────────────
// 지형 최외곽 신축 매핑(비정형 테두리). buildSiteTerrain·scatterTrees·forest 가 공유.
export function makeEdgeWarp(site, warpInner) {
  const edge = site.edge;
  const TR = site.terrainR || site.R;
  return (x, z) => {
    if (!edge) return [x, z];
    const r = Math.hypot(x, z);
    if (r <= warpInner) return [x, z];
    const th = Math.atan2(z, x);
    const ax = Math.abs(Math.cos(th)), az = Math.abs(Math.sin(th));
    const rMax = TR / Math.max(ax, az, 1e-6);
    const Redge = Math.max(edge.edgeRadiusAt(th), warpInner + 1);
    const t = (r - warpInner) / Math.max(rMax - warpInner, 1e-3);
    const nr = warpInner + t * (Redge - warpInner);
    const k = nr / r;
    return [x * k, z * k];
  };
}

// 나무 제외 마스크: 도로·필지·논·개울·절 경내.
export function makeTreeMask(plan, site) {
  // Two-argument calls preserve the established anchor mask. Passing the actual
  // visual radius performs the commit-phase query, including canopy-safe parcel,
  // road, paddy, temple, solar-access, guardian, and city-wall clearances.
  return makeVegetationMask(plan, site);
}

// 구조물 거리 필드(#115) — 코스 그리드 최근접 구조물 거리 → 바이리니어 샘플.
export function makeClearance(plan, site) {
  const TR = site.terrainR || site.R;
  const pts = [];
  for (const p of (plan.parcels || [])) {
    if (p.poly && p.poly.length) for (const c of p.poly) pts.push(c.x, c.z);
    else if (p.center) pts.push(p.center.x, p.center.z);
  }
  for (const r of (plan.roads || [])) { const rp = r.pts || []; for (let i = 0; i < rp.length; i++) pts.push(rp[i].x, rp[i].z); }
  for (const f of (plan.paddies || [])) for (const c of f.poly) pts.push(c.x, c.z);
  if (site.stream) for (const q of site.stream.pts) pts.push(q.x, q.z);
  const F = plan.features || {};
  for (const k of ['temple', 'palace', 'govCore']) { const o = F[k]; if (o && typeof o.x === 'number') pts.push(o.x, o.z); }
  for (const point of pavilionFootprint(F.pavilion)) pts.push(point.x, point.z);
  // #147 절 footprint 모서리도 등재 — 절이 완경사(infill 발현 가능)에 앉는 경우 경내 거리장 정확화.
  if (F.temple && typeof F.temple.x === 'number') {
    for (const point of templeFootprint(F.temple)) pts.push(point.x, point.z);
    for (const point of F.temple.path || []) pts.push(point.x, point.z);
  }
  for (const o of (F.props || [])) if (o && typeof o.x === 'number') pts.push(o.x, o.z);
  const NP = pts.length / 2;
  const Gn = TR > 400 ? 96 : 128;
  const cell = (2 * TR) / Gn;
  const grid = new Float32Array((Gn + 1) * (Gn + 1));
  for (let i = 0; i <= Gn; i++) {
    const x = -TR + i * cell;
    for (let j = 0; j <= Gn; j++) {
      const z = -TR + j * cell;
      let md = Infinity;
      for (let k = 0; k < NP; k++) { const dx = pts[k * 2] - x, dz = pts[k * 2 + 1] - z; const d = dx * dx + dz * dz; if (d < md) md = d; }
      grid[i * (Gn + 1) + j] = NP ? Math.sqrt(md) : 9999;
    }
  }
  return (x, z) => {
    const gx = (x + TR) / cell, gz = (z + TR) / cell;
    const i = Math.min(Gn - 1, Math.max(0, Math.floor(gx))), j = Math.min(Gn - 1, Math.max(0, Math.floor(gz)));
    const fx = gx - i, fz = gz - j;
    const a = grid[i * (Gn + 1) + j], b = grid[(i + 1) * (Gn + 1) + j], c = grid[i * (Gn + 1) + j + 1], d = grid[(i + 1) * (Gn + 1) + j + 1];
    const top = a + (b - a) * fx, bot = c + (d - c) * fx;
    return top + (bot - top) * fz;
  };
}

// forestK/rockK 정규화(forest.js buildForest 와 동일).
function forestTuning(plan) {
  const tuning = (plan.opts && plan.opts.tuning) || {};
  return {
    forestK: clamp(tuning.forestDensityK != null ? tuning.forestDensityK : 1, 0, 1.6),
    rockK: clamp(tuning.rockDensityK != null ? tuning.rockDensityK : 1, 0, 2),
  };
}

// ───────────────────────── 최상위 크런치(워커·메인 공유) ─────────────────────────
// plan+site 로부터 forest 배치 버퍼를 계산. warp/mask/clearDist 를 넘기면 재사용(메인: populate 가 이미 계산),
//   없으면 내부에서 빌드(워커: opts+seed 로 재구성). 반환은 transferable Float32Array 묶음.
export function crunchForest(plan, site, opts = {}) {
  const seed = ((plan.seed || 0) ^ 0x0f03e5) >>> 0;
  const { forestK, rockK } = forestTuning(plan);
  // populate와 같은 순수 helper를 써 외곽 warp 좌표와 worker/sync 결정론을 한 계약으로 고정한다.
  const warp = opts.warp || makeEdgeWarp(site, terrainWarpInner(plan, site));
  const mask = opts.mask || makeTreeMask(plan, site);
  const clearDist = opts.clearDist || makeClearance(plan, site);
  const sampler = makeTerrainSampler(site, warp);
  const slopeAt = makeSlopeAt(site);
  const ecotone = makeEcotoneField(site);
  const trees = crunchForestTrees(site, sampler, slopeAt, mask, (seed ^ 0xa1) >>> 0,
    forestK, ecotone, clearDist, plan.features?.cityWall || null);
  const rocks = crunchGranite(site, sampler, slopeAt, mask, (seed ^ 0xb2) >>> 0,
    rockK, plan.features?.cityWall || null);
  return { trees, rocks };
}

// 워커 postMessage 용 transferable(ArrayBuffer) 수집.
export function crunchTransferables(cr) {
  const out = [];
  const t = cr.trees, r = cr.rocks;
  for (const b of [t.pineMat, t.broadMat, t.pineCol.spring, t.pineCol.summer, t.pineCol.autumn, t.pineCol.winter,
    t.broadCol.spring, t.broadCol.summer, t.broadCol.autumn, t.broadCol.winter,
    t.farMat, t.farCol.spring, t.farCol.summer, t.farCol.autumn, t.farCol.winter, r.mat, r.col]) {
    if (b && b.buffer) out.push(b.buffer);
  }
  return out;
}
