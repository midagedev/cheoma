// 천체 계약 — 태양 원반(S1)·달 위상(S2)·별(S3)의 렌더러/DOM 무의존 소스.
//
// sky.js 가 이 모듈의 순수 함수로 캔버스를 베이크하고 지오·유니폼을 배선한다. three 도, canvas 도,
// 전역 Math.random 도 건드리지 않으므로 tools/check-celestial.mjs 가 노드에서 전부 단언할 수 있다
// (레포 규약: "원인은 순수 노드로 단언, 브라우저는 효과 확인 1회").
//
// 근거 문헌(조사 라운드 scratch/sky-research.md §3~§4):
//   태양 림 다크닝·석양 편평화 — atoptics.co.uk/blog/flattened-suns, arxiv 1410.8474
//   달 위상 터미네이터·지구조 — BeamNG sky 문서, arxiv 1904.00236(earthshine)
//   별 등급 멱법칙·twinkle·시간대 페이드 — drei-vanilla Stars 구조, HYG 카탈로그 통계
//
// 회화 문법 계약(docs/look-grammar.md): 사진 사실주의가 아니다. 아래 수치 중 물리에서 그대로
// 오는 것(림 다크닝 계수, 위상각↔조명면적, 등급 플럭스비)과 **의도적으로 과장한 것**(석양 편평화·
// 확대의 고도 창, 별 최대 휘도)을 주석에 구분해 두었다 — 후자는 리드 비전 판정용 노브다.

const DEG = Math.PI / 180;
const clamp01 = (x) => (x < 0 ? 0 : (x > 1 ? 1 : x));
const smoothstep = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
const mix = (a, b, t) => a + (b - a) * t;
const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

// ─────────────────────────────────────────────────────────────────────────────
// S1 태양 원반
// ─────────────────────────────────────────────────────────────────────────────
// 현행 표현은 sunGlow 스프라이트(post.js) + FlarePass 의 합이라 "경계 있는 원반"이 없었다.
// 여기서는 같은 반경(SUN_GLOW_DIST) 위에 림 다크닝된 원반 코어만 얹는다 — 글로우·플레어는 불침해.
//
// 물리:
//   · 림 다크닝 I(μ)/I(1) = 1 − u1(1−μ) − u2(1−μ)², μ=cos(시선각)=√(1−r²). 가시광 표준 계수대
//     (u1≈0.93, u2≈−0.23)로 림 휘도 ≈ 0.30 — 원반 경계가 "칼로 자른 흰 원"이 되지 않는 이유다.
//   · 각지름 32′ ≈ 0.53°. 저고도에서 하부 림의 굴절이 더 커서 수직으로 압축된다(편평화).
// 과장(리드 노브):
//   · coreAngularDiameterDeg 0.62° = 실제 0.53° 의 1.17배. 46° 화각 1080p 에서 실제 각지름은
//     ~12px 로 원반 판독이 어렵다. 아주 약한 회화적 확대.
//   · flattenFloor / enlargeGain / lowElev 창(2°~26°). 실제 편평화는 고도 2° 아래에서만 유의하지만
//     프로필의 석양 태양은 9.5°에 authored 되어 있다. 창을 굴절이 유의한 대역(≈25° 이하)까지 넓혀
//     석양 프레임에서 실제로 읽히게 했다 — 판정은 비전 라운드.
export const SUN_DISK = Object.freeze({
  distance: 430,                    // = post.js SUN_GLOW_DIST (같은 태양이 두 겹으로 어긋나면 안 된다)
  coreAngularDiameterDeg: 0.62,
  spanFactor: 1.9,                  // 텍스처 스팬 / 코어 지름(약한 아우레올 여백)
  coreSpanFraction: 1 / 1.9,        // 코어 반경 / 스팬 반경
  edgeSoftSpan: 0.045,              // 원반 경계 안티에일리어싱 폭(스팬 정규화)
  aureolePeak: 0.05,                // 코어 밖 잔여 — sunGlow 와의 하드컷 방지용(헤일로는 글로우 소유)
  limbU1: 0.93,
  limbU2: -0.23,
  flattenFloor: 0.82,               // 지평에서의 수직/수평 비
  enlargeGain: 0.30,                // 지평에서의 확대율 − 1
  lowElevLoDeg: 2,
  lowElevHiDeg: 26,
  textureSize: 128,
  // 코어 HDR 게인(리드 노브). 태양은 하늘보다 수 자릿수 밝은 광원이라 선형 1.0 으로는 ACES
  //   숄더에서 하늘에 묻힌다 — 저각 역광 실측에서 원반 대비가 1.24× 에 불과했다(#53 R2 계측).
  //   원반만 HDR 로 올려 bloom 시드가 되게 한다. 1.0 = 이전 동작(되돌리기 지점).
  coreHdrGain: 3.2,
});

// 시간대별 원반 존재감. 밤 0 은 계약이다 — 밤엔 sunDir 이 달 방향을 겸하므로 원반이 남으면
// 달 옆에 두 번째 달이 뜬다. 정오는 절제(연구 §3: 원반 자체를 페이드), 석양이 플래그십.
export const SUN_DISK_TIME = Object.freeze({
  dawn: 0.70, day: 0.34, sunset: 1.0, night: 0,
});

export function elevationDegOf(direction) {
  const v = Array.isArray(direction)
    ? direction
    : [direction?.x, direction?.y, direction?.z];
  const x = Number(v[0]) || 0;
  const y = Number(v[1]) || 0;
  const z = Number(v[2]) || 0;
  const horizontal = Math.hypot(x, z);
  if (horizontal < 1e-9 && Math.abs(y) < 1e-9) return 0;
  return Math.atan2(y, horizontal) / DEG;
}

/** 저고도 계수 1 = 지평, 0 = 굴절 무의미 고도 위. */
export function sunLowAltitude01(elevationDeg) {
  return 1 - smoothstep(SUN_DISK.lowElevLoDeg, SUN_DISK.lowElevHiDeg, elevationDeg);
}

/** 수직/수평 비. 1 = 원, floor = 지평 최대 압축. */
export function sunDiskFlattening(elevationDeg) {
  const low = sunLowAltitude01(elevationDeg);
  return SUN_DISK.flattenFloor + (1 - SUN_DISK.flattenFloor) * (1 - low);
}

/** 저고도 확대율(≥1). */
export function sunDiskEnlargement(elevationDeg) {
  return 1 + SUN_DISK.enlargeGain * sunLowAltitude01(elevationDeg);
}

/** 림 다크닝. r = 반경/코어반경 (0..1). */
export function sunLimbDarkening(rNorm) {
  const r = clamp01(rNorm);
  const mu = Math.sqrt(Math.max(0, 1 - r * r));
  const k = 1 - mu;
  return clamp01(1 - SUN_DISK.limbU1 * k - SUN_DISK.limbU2 * k * k);
}

/** 텍스처 알파 프로필. r = 반경/스팬반경 (0..1). 스팬 끝은 정확히 0(경계 있는 원반). */
export function sunDiskProfile(rSpan) {
  const r = Math.max(0, rSpan);
  const core = SUN_DISK.coreSpanFraction;
  const soft = SUN_DISK.edgeSoftSpan;
  const disc = sunLimbDarkening(Math.min(1, r / core))
    * (1 - smoothstep(core - soft, core + soft, r));
  const tail = 1 - smoothstep(core * 0.9, 1, r);
  return clamp01(disc + SUN_DISK.aureolePeak * tail * tail);
}

/** 텍스처 스팬의 각지름(도). */
export function sunDiskSpanDeg() {
  return SUN_DISK.coreAngularDiameterDeg * SUN_DISK.spanFactor;
}

/** 스프라이트 월드 스팬(거리·각지름 → 평면 크기). */
export function sunDiskSpanWorld(distance = SUN_DISK.distance) {
  return 2 * distance * Math.tan(sunDiskSpanDeg() * DEG * 0.5);
}

// ─────────────────────────────────────────────────────────────────────────────
// S2 달 위상
// ─────────────────────────────────────────────────────────────────────────────
// 현행 달은 균일 원반(MeshBasicMaterial 단색)이다. 씬의 밤 sunDir 이 달 방향을 겸하므로 실제
// 천문 위상각은 계산할 수 없고 계산할 필요도 없다(연구 §3) — 위상은 **아트 초이스 상수**다.
//
// 좌표계: 원반 로컬 프레임. +z = 관측자(카메라) 방향, +y = 화면 위, +x = 화면 오른쪽.
//   sky.js 가 moonDisk.lookAt(camera) 로 이 프레임을 매 프레임 카메라에 정렬하므로, 베이크는
//   한 번만 하고도 위상 방향이 화면에서 안정적이다(재베이크 0, 프로그램 +0).
// 위상각 θ: cos θ = L·ẑ = 2f − 1 (f = 조명 면적비). 가시 원반의 조명 면적비가 정확히 f 가 되는
//   고전 결과를 게이트가 수치 적분으로 확인한다.
// 기본값 0.76 = waxing gibbous — 보름은 입체감이 없고(현행 원반과 같아진다) 상현은 야간 인지가
//   약하다. 그 사이에서 야간 판독이 가장 좋은 쪽(리드 노브: illuminatedFraction/terminatorTiltDeg).
export const MOON_PHASE = Object.freeze({
  illuminatedFraction: 0.76,
  terminatorTiltDeg: 24,            // 화면상 터미네이터 기울기(조명이 오른쪽 위에서)
  terminatorSoftness: 0.11,         // 회화적 부드러움 — 실제 터미네이터보다 관대
  subsolarGain: 0.26,               // 밝은 쪽의 미세한 중심 밝아짐(달은 후방산란으로 거의 평평)
  earthshine: 0.05,                 // 지구조 — 어두운 쪽이 구멍이 되지 않게(arxiv 1904.00236)
  earthshineTint: Object.freeze([0.74, 0.82, 1.0]),
  maria: 0.16,                      // 바다(어두운 대영역) 대비
  craterAlbedo: 0.22,               // 크레이터·고지 알베도 결
  craterRelief: 0.020,              // 법선 교란(결이 터미네이터 근처에서 읽히게) — 최대 ≈10°

  craterSeed: 20260804,
  limbFalloff: 0.10,                // 구 실루엣 끝의 아주 약한 어두워짐(회화적 둥근맛)
});

export const MOON_TEXTURE = Object.freeze({ width: 256, height: 128 });

export function moonPhaseAngleDeg(illuminatedFraction) {
  const f = clamp01(illuminatedFraction);
  return Math.acos(Math.min(1, Math.max(-1, 2 * f - 1))) / DEG;
}

/** 원반 로컬 프레임에서의 조명 방향(단위). */
export function moonPhaseLightDir({
  illuminatedFraction = MOON_PHASE.illuminatedFraction,
  terminatorTiltDeg = MOON_PHASE.terminatorTiltDeg,
} = {}) {
  const cosTheta = Math.min(1, Math.max(-1, 2 * clamp01(illuminatedFraction) - 1));
  const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
  const tilt = terminatorTiltDeg * DEG;
  return [sinTheta * Math.cos(tilt), sinTheta * Math.sin(tilt), cosTheta];
}

/**
 * 위상 셰이딩만(크레이터·알베도 제외). 0..1.
 * 어두운 쪽은 지구조 바닥으로 수렴하고, 밝은 쪽은 거의 평평하게 밝다.
 */
export function moonSurfaceShade(nx, ny, nz, light = moonPhaseLightDir(), opts = {}) {
  const soft = Number.isFinite(opts.terminatorSoftness)
    ? opts.terminatorSoftness : MOON_PHASE.terminatorSoftness;
  const earthshine = Number.isFinite(opts.earthshine) ? opts.earthshine : MOON_PHASE.earthshine;
  const gain = Number.isFinite(opts.subsolarGain) ? opts.subsolarGain : MOON_PHASE.subsolarGain;
  const d = nx * light[0] + ny * light[1] + nz * light[2];
  const lit = smoothstep(-soft, soft, d);
  return clamp01(earthshine + (1 - earthshine) * lit * ((1 - gain) + gain * clamp01(d)));
}

/** 가시 원반(정면 반구의 투영)의 조명 면적비 — 위상 방향식 전체를 검증하는 수치 적분. */
export function moonVisibleLitAreaFraction(light = moonPhaseLightDir(), steps = 512) {
  let inside = 0;
  let lit = 0;
  for (let iy = 0; iy < steps; iy++) {
    const y = (iy + 0.5) / steps * 2 - 1;
    for (let ix = 0; ix < steps; ix++) {
      const x = (ix + 0.5) / steps * 2 - 1;
      const rr = x * x + y * y;
      if (rr >= 1) continue;
      inside += 1;
      const nz = Math.sqrt(1 - rr);
      if (x * light[0] + y * light[1] + nz * light[2] > 0) lit += 1;
    }
  }
  return inside ? lit / inside : 0;
}

// 3D 값 노이즈 — 격자 해시 + smoothstep 보간. 구면 위 3D 좌표로 평가하므로 u 이음선이 없다.
function hash3(ix, iy, iz, seed) {
  let h = Math.imul(ix | 0, 374761393) ^ Math.imul(iy | 0, 668265263)
    ^ Math.imul(iz | 0, 1274126177) ^ Math.imul(seed | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function valueNoise3(x, y, z, seed) {
  const fx = Math.floor(x); const fy = Math.floor(y); const fz = Math.floor(z);
  const tx = x - fx; const ty = y - fy; const tz = z - fz;
  const ux = tx * tx * (3 - 2 * tx);
  const uy = ty * ty * (3 - 2 * ty);
  const uz = tz * tz * (3 - 2 * tz);
  const c000 = hash3(fx, fy, fz, seed);
  const c100 = hash3(fx + 1, fy, fz, seed);
  const c010 = hash3(fx, fy + 1, fz, seed);
  const c110 = hash3(fx + 1, fy + 1, fz, seed);
  const c001 = hash3(fx, fy, fz + 1, seed);
  const c101 = hash3(fx + 1, fy, fz + 1, seed);
  const c011 = hash3(fx, fy + 1, fz + 1, seed);
  const c111 = hash3(fx + 1, fy + 1, fz + 1, seed);
  const x00 = mix(c000, c100, ux);
  const x10 = mix(c010, c110, ux);
  const x01 = mix(c001, c101, ux);
  const x11 = mix(c011, c111, ux);
  return mix(mix(x00, x10, uy), mix(x01, x11, uy), uz);
}

function fbm3(x, y, z, seed, octaves) {
  let amp = 1;
  let sum = 0;
  let norm = 0;
  let fx = x; let fy = y; let fz = z;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise3(fx, fy, fz, seed + i * 7919);
    norm += amp;
    amp *= 0.5;
    fx *= 2.03; fy *= 2.03; fz *= 2.03;
  }
  return sum / norm;
}

/** 달 표면 알베도(0.45..1) — 바다 대영역 + 크레이터 결. 결정론. */
export function moonSurfaceAlbedo(nx, ny, nz, opts = {}) {
  const seed = (opts.craterSeed ?? MOON_PHASE.craterSeed) | 0;
  const mariaAmt = opts.maria ?? MOON_PHASE.maria;
  const grainAmt = opts.craterAlbedo ?? MOON_PHASE.craterAlbedo;
  const low = fbm3(nx * 1.7, ny * 1.7, nz * 1.7, seed, 3);
  const maria = smoothstep(0.48, 0.72, low) * mariaAmt;
  const grain = fbm3(nx * 8.5, ny * 8.5, nz * 8.5, seed + 101, 2);
  return clamp01(1 - maria - grainAmt * (0.62 - grain * 0.62));
}

/** 결의 법선 교란(단위). 크레이터가 터미네이터 근처에서 읽히게 하는 유일한 장치. */
export function moonReliefNormal(nx, ny, nz, opts = {}) {
  const seed = ((opts.craterSeed ?? MOON_PHASE.craterSeed) | 0) + 401;
  const relief = opts.craterRelief ?? MOON_PHASE.craterRelief;
  const len = Math.hypot(nx, ny, nz) || 1;
  const n = [nx / len, ny / len, nz / len];
  // 접선 기저(극 근처에서도 퇴화하지 않게 축 선택).
  const pick = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  let t1 = [
    pick[1] * n[2] - pick[2] * n[1],
    pick[2] * n[0] - pick[0] * n[2],
    pick[0] * n[1] - pick[1] * n[0],
  ];
  const t1len = Math.hypot(t1[0], t1[1], t1[2]) || 1;
  t1 = [t1[0] / t1len, t1[1] / t1len, t1[2] / t1len];
  const t2 = [
    n[1] * t1[2] - n[2] * t1[1],
    n[2] * t1[0] - n[0] * t1[2],
    n[0] * t1[1] - n[1] * t1[0],
  ];
  const F = 9.5;
  const eps = 0.02;
  const h = (p) => fbm3(p[0] * F, p[1] * F, p[2] * F, seed, 2);
  const step = (t, s) => [n[0] + t[0] * s, n[1] + t[1] * s, n[2] + t[2] * s];
  const g1 = (h(step(t1, eps)) - h(step(t1, -eps))) / (2 * eps);
  const g2 = (h(step(t2, eps)) - h(step(t2, -eps))) / (2 * eps);
  const out = [
    n[0] - relief * (g1 * t1[0] + g2 * t2[0]),
    n[1] - relief * (g1 * t1[1] + g2 * t2[1]),
    n[2] - relief * (g1 * t1[2] + g2 * t2[2]),
  ];
  const olen = Math.hypot(out[0], out[1], out[2]) || 1;
  return [out[0] / olen, out[1] / olen, out[2] / olen];
}

/**
 * 등적 equirect 베이크용: SphereGeometry 의 (u,v) → 로컬 법선.
 * three 의 SphereGeometry 매개화와 동일해야 한다(phi=u·2π, theta=v·π):
 *   x = −cos φ sin θ · y = cos θ · z = sin φ sin θ
 */
export function sphereUvNormal(u, v) {
  const phi = u * Math.PI * 2;
  const theta = v * Math.PI;
  const st = Math.sin(theta);
  return [-Math.cos(phi) * st, Math.cos(theta), Math.sin(phi) * st];
}

/** 베이크 1 텍셀의 최종 그레이(알베도 × 위상 셰이딩 + 지구조 틴트). rgb 0..1 sRGB. */
export function moonTexel(u, v, light = moonPhaseLightDir(), opts = {}) {
  const n = sphereUvNormal(u, v);
  const relief = moonReliefNormal(n[0], n[1], n[2], opts);
  const albedo = moonSurfaceAlbedo(n[0], n[1], n[2], opts);
  const shade = moonSurfaceShade(relief[0], relief[1], relief[2], light, opts);
  const earthshine = Number.isFinite(opts.earthshine) ? opts.earthshine : MOON_PHASE.earthshine;
  const tint = opts.earthshineTint ?? MOON_PHASE.earthshineTint;
  // 어두운 쪽 비중만큼 지구조의 한색 틴트를 섞는다(밝은 쪽은 무채 달빛 그대로).
  const darkWeight = clamp01((earthshine * 1.6 - (shade - earthshine)) / (earthshine * 1.6));
  // 베이크 프레임은 관측자 정렬(+z = 카메라)이라 여기서 시선 기준 림 감쇠를 실을 수 있다.
  const falloff = opts.limbFalloff ?? MOON_PHASE.limbFalloff;
  const value = albedo * shade * (1 - falloff * (1 - clamp01(n[2])));
  return [
    value * mix(1, tint[0], darkWeight),
    value * mix(1, tint[1], darkWeight),
    value * mix(1, tint[2], darkWeight),
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// S3 별 (신설)
// ─────────────────────────────────────────────────────────────────────────────
// Points 1 드로우콜에 필드 별 + 은하수 밴드를 같은 버퍼로 싣는다(밴드 전용 draw 를 만들지 않는다).
// 배치는 지역 rng — 마을 생성의 전역 Math.random 시드창을 절대 건드리지 않는다.
//
// 등급 멱법칙: 육안 하늘의 별 수는 등급당 대략 ×4 로 늘어난다 → log₁₀N ∝ 0.6·m.
//   플럭스는 Δm=1 당 2.512배 차 → flux = 10^(−0.4(m−m₀)).
// 반짝임: 룩 문법 "모든 모션은 미세 스케일" — 진폭은 감지 문턱 부근(±13%).
// 시간대 페이드: 낮 0 / 밤 1 / 박명은 밝은 별부터 남는다(twilightBias).
//   dawn 0.18 은 연구 §7 Q2(박명 잔존)의 **리드 판단 노브**다 — bias 0.55 에서 등급 2.2 보다
//   밝은 별 ~14개만 낮은 알파로 남는다(어둑한 새벽 프로필의 회화적 잔광).
//   sunset 0: 이 씬의 석양은 태양 고도 9.5° 의 밝은 골든아워라 별이 물리적으로 보이지 않고,
//   정착값 0 이면 플래그십 프레임에서 별 드로우콜 자체가 사라진다. 크로스페이드는 트윈이
//   1→0 을 지나므로 하드 컷 금지 계약은 그대로 지켜진다.
export const STAR_FIELD = Object.freeze({
  seed: 20260804,
  radius: 452,                      // 카메라 far(<500) 안 · 달(460)보다 앞이 아니게
  fieldCount: 1600,
  // #53 R2: 은하수를 2600 점 → 돔 확산 휘도(MILKY_WAY)로 재구현했다. 점 방식은 1px 알파 0.1
  //   짜리 점배열이라 하늘 기저 78/255 위에서 아예 읽히지 않았다(비전 평결). 밴드 점은 0.
  bandCount: 0,
  minElevationDeg: 3.5,             // 지평 아래 별 금지(지형 뒤에서 비친다)
  magMin: 0.6,
  magMax: 5.6,
  magSlope: 0.6,                    // log₁₀ N(<m) ∝ magSlope·m
  bandMagOffset: 1.9,               // 은하수는 미분해 성단 — 필드보다 어둡다
  bandLum: 0.72,
  bandPoleAzimuthDeg: 118,
  bandPoleElevationDeg: 34,
  bandSigmaDeg: 6.5,
  sizePxMin: 0.9,
  sizePxMax: 2.9,
  // #53 R2 대비 축(비전 FIX). 구 값 lumMax 0.52 / lumExp 0.45 는 상위 별조차 하늘 대비 2.1×
  //   (실측 1st 2.14× · 10th 1.62×)로 "사실상 안 보이는" 판정을 받았다. 상위 별을 올리고
  //   지수를 세워 희미한 꼬리는 오히려 조금 낮춘다(균일 점배열 방지 요소는 유지).
  //   상위 60번째 별 ≈ 등급 3.15(flux 0.128) → lum 0.30, 최빈 꼬리(flux 0.01) → lum 0.075.
  lumMax: 1.05,                     // 선형 HDR — 상위 몇 개는 야간 bloom 임계를 넘겨 헤일로를 얻는다
  lumExp: 0.55,
  colorAmp: 0.30,                   // 흑체 색편차 상한(채도 절제)
  twinkleAmp: 0.13,
  twilightBias: 0.55,
});

export const STAR_TIME_FADE = Object.freeze({
  dawn: 0.18, day: 0, sunset: 0, night: 1,
});

export const STAR_BAND_POLE = Object.freeze((() => {
  const el = STAR_FIELD.bandPoleElevationDeg * DEG;
  const az = STAR_FIELD.bandPoleAzimuthDeg * DEG;
  const c = Math.cos(el);
  return [c * Math.sin(az), Math.sin(el), c * Math.cos(az)];
})());

// ── 은하수: 확산 휘도(돔 캔버스 합성) ────────────────────────────────────────
// R1 은 2600 개 희미한 Points 였고 비전 평결은 "안 보인다"였다. 미분해 성단은 원래 점이 아니라
//   넓은 확산 휘도이므로, 돔 캔버스(128×256, 방위 2.8°/px)에 기울어진 대원 주변 가우시안을
//   몇 계조로 양자화해 굽고 별 페이드에 맞춰 합성한다 — 드로우콜 +0, 프로그램 +0.
// 계조 양자화(steps)는 회화 문법(연속 램프가 아니라 2~3단)과 128px 방위 해상도에 모두 맞다.
// **지평 게이트가 계약이다**: pos ≤ gateLoPos 에서 정확히 0 — 지평 아래 fog 색 수렴(지형 절단면
//   하드컷 방지)과 DOME_HAZE/HAZE_TINT 미러(check-fog-wash)를 침해하지 않는다.
// **조준이 계약이다** (#53 R3b, 2026-08-04): 대원의 정점 방위는 pole 방위 − 90° 이고, 밴드가
//   화면에 걸리는 것은 그 정점 주변뿐이다. 판정 화각인 달 조준 skyward 프레임(fov 40° 세로,
//   제품 캔버스 1080×810 → 방위 반각 ≈26°, 중심 고도 5.2° = 달 고도)에서 구 pole 118°(정점 20°)는
//   달 방위(282°)에서 100° 떨어져 있었다. 그래서 밴드 중심선이 Δaz +11° 이후에만 지평 위로
//   올라왔고, 프레임 오른쪽 모서리만 스쳤다 — 하늘 픽셀 평균 가중 0.237, 실측 진폭 +6.6/255,
//   비전 평결 "안 보인다".
//   방위 스윕(순수 노드 · 프레임 표집 61×61 · 1~2° 해상도)의 프런티어는 az 86~90 과 그 거울상
//   295~299 가 공동 최대(하늘 픽셀 평균 0.461~0.463)다. 그 고원에서 90° 를 고른 근거는 중심선이
//   프레임 안에서 지평을 건너는 것이다: Δaz −11.9° 에서 지평을 지나 Δ0 에서 +17.6°,
//   Δ+30° 에서 +45° 로 올라간다 — 능선에서 솟아 프레임을 가로지르는 대각(실제 은하수 사진의
//   문법). 달 자리(Δ0, 고도 5.2°)의 가중은 0.03 이라 달 원반은 밴드에 삼켜지지 않는다.
//   실측 효과(제품 픽셀 on/off 원자쌍): 하늘 밴드 델타 p50 12.1 / p99 17.2 / max 17.8 —
//   3×3 셀 중앙값이 상단 8.7 / 16.2 / 8.0, 중·하단 0 이라 균일 워시가 아니라 상부의 호다.
export const MILKY_WAY = Object.freeze({
  // peak: 새 밤 바닥(SUN_BAND 배율 이후 실측 31/255) 위에서 지각 델타를 만드는 합성 알파 상한.
  //   R3b 실측(제품 픽셀 on/off 원자쌍 · night skyward 1080×810 · 하늘 밴드): peak 0.085 는
  //   델타 p50 15.2 / p99 21.8 / max 22.0 이었다 — 상한 25 아래지만 리드가 준 목표대(+12~18)의
  //   위쪽을 넘는다. 0.072 로 내려 목표대 안에 들어온다(아래 실측 표 참조). 상한 25 까지 여유가
  //   있으므로 비전이 존재감을 더 원하면 이 상수 하나로 올릴 수 있다.
  peak: 0.072,                      // 캔버스 합성 알파 상한(리드 노브 — 0 이면 은하수 없음)
  sigmaDeg: 13,                     // 대원에서의 각 폭(점 방식의 6.5° 보다 넓게 — 확산광)
  poleAzimuthDeg: 90,               // 정점 방위 0° = 달 방위 +78° → 밴드가 프레임을 대각으로 건넌다
  poleElevationDeg: 34,
  steps: 4,                         // 계조 수
  gateLoPos: 0.52,                  // 지평 위에서만(0.5=지평) — 아래는 정확히 0
  gateHiPos: 0.60,
  tint: Object.freeze([0.82, 0.86, 1.0]),   // 서늘한 백청
  fadeLo: 0.55,                     // 밤 전용 램프 — 박명(dawn 0.18)에서는 0
  fadeHi: 0.95,
});

export const MILKY_WAY_POLE = Object.freeze((() => {
  const el = MILKY_WAY.poleElevationDeg * DEG;
  const az = MILKY_WAY.poleAzimuthDeg * DEG;
  const c = Math.cos(el);
  return [c * Math.sin(az), Math.sin(el), c * Math.cos(az)];
})());

/** 별 페이드 → 은하수 합성 세기. 박명에서는 0(돔이 dawn 게이트에서 바이트 동일하게 유지된다). */
export function milkyWayFade(starFade) {
  return smoothstep(MILKY_WAY.fadeLo, MILKY_WAY.fadeHi, clamp01(starFade));
}

/**
 * 돔 캔버스 좌표에서의 은하수 가중치(0..1, 양자화).
 *   u   = 방위 텍스처 좌표(0..1) — SphereGeometry phi=u·2π, 수평방향 (−cos φ, sin φ)
 *   pos = 0 천저 · 0.5 지평 · 1 천정 (프로필 sky 스톱과 같은 공간)
 */
export function milkyWayWeight(u, pos) {
  const gate = smoothstep(MILKY_WAY.gateLoPos, MILKY_WAY.gateHiPos, pos);
  if (gate <= 0) return 0;
  const elev = (pos - 0.5) * Math.PI;
  const phi = u * Math.PI * 2;
  const ce = Math.cos(elev);
  const dx = -Math.cos(phi) * ce;
  const dy = Math.sin(elev);
  const dz = Math.sin(phi) * ce;
  const d = Math.abs(dx * MILKY_WAY_POLE[0] + dy * MILKY_WAY_POLE[1] + dz * MILKY_WAY_POLE[2]);
  const deg = Math.asin(Math.min(1, d)) / DEG;
  const band = Math.exp(-0.5 * (deg / MILKY_WAY.sigmaDeg) ** 2);
  // 몇 계조로 양자화 — 부드러운 연속 램프가 아니라 회화적 단계.
  const quantized = Math.round(band * MILKY_WAY.steps) / MILKY_WAY.steps;
  return clamp01(quantized * gate);
}

/** mulberry32 — 지역 결정론 rng. */
export function makeStarRng(seed) {
  let a = (seed >>> 0) || 1;
  return function rng() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function starMagnitudeCdf(m, {
  magMin = STAR_FIELD.magMin, magMax = STAR_FIELD.magMax, magSlope = STAR_FIELD.magSlope,
} = {}) {
  const span = 10 ** (magSlope * (magMax - magMin)) - 1;
  const at = 10 ** (magSlope * (Math.min(magMax, Math.max(magMin, m)) - magMin)) - 1;
  return span > 0 ? at / span : 0;
}

export function starMagnitudeQuantile(u, {
  magMin = STAR_FIELD.magMin, magMax = STAR_FIELD.magMax, magSlope = STAR_FIELD.magSlope,
} = {}) {
  const span = 10 ** (magSlope * (magMax - magMin)) - 1;
  return magMin + Math.log10(1 + clamp01(u) * span) / magSlope;
}

export function starFlux(m, magMin = STAR_FIELD.magMin) {
  return 10 ** (-0.4 * (m - magMin));
}

/** 시간대 페이드 × 등급 → 알파. 밝은 별이 먼저 나타나고 마지막에 사라진다. */
export function starAlpha(fade, bright01, twilightBias = STAR_FIELD.twilightBias) {
  const thresh = (1 - clamp01(bright01)) * twilightBias;
  return clamp01((clamp01(fade) - thresh) / Math.max(1e-4, 1 - thresh));
}

function gaussian(rng) {
  // Box–Muller, |z| ≤ 3 으로 절단(밴드 이탈 별 금지).
  for (let i = 0; i < 16; i++) {
    const u1 = Math.max(1e-12, rng());
    const u2 = rng();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    if (Math.abs(z) <= 3) return z;
  }
  return 0;
}

/**
 * 별 필드 생성. 반환은 JSON 안전한 typed array 세트(three 무의존).
 *   position: 카메라 상대 셸 좌표 · size: 픽셀 크기 · bright: 등급 정규화(박명 게이트)
 *   color: 선형 HDR rgb(휘도 반영) · phase: twinkle 위상 · magnitude/band: 게이트용
 */
export function buildStarField(options = {}) {
  const cfg = { ...STAR_FIELD, ...options };
  const total = cfg.fieldCount + cfg.bandCount;
  const rng = makeStarRng(cfg.seed);
  const position = new Float32Array(total * 3);
  const color = new Float32Array(total * 3);
  const size = new Float32Array(total);
  const bright = new Float32Array(total);
  const phase = new Float32Array(total);
  const magnitude = new Float32Array(total);
  const band = new Uint8Array(total);

  const sinMin = Math.sin(cfg.minElevationDeg * DEG);
  const pole = options.bandPole || STAR_BAND_POLE;
  // 대원 기저: pole ⟂ (b1, b2).
  const helper = Math.abs(pole[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  let b1 = [
    helper[1] * pole[2] - helper[2] * pole[1],
    helper[2] * pole[0] - helper[0] * pole[2],
    helper[0] * pole[1] - helper[1] * pole[0],
  ];
  const b1len = Math.hypot(b1[0], b1[1], b1[2]) || 1;
  b1 = [b1[0] / b1len, b1[1] / b1len, b1[2] / b1len];
  const b2 = [
    pole[1] * b1[2] - pole[2] * b1[1],
    pole[2] * b1[0] - pole[0] * b1[2],
    pole[0] * b1[1] - pole[1] * b1[0],
  ];
  const sigma = cfg.bandSigmaDeg * DEG;

  const warm = [1.0, 0.84, 0.68];
  const cool = [0.76, 0.85, 1.0];

  for (let i = 0; i < total; i++) {
    const isBand = i >= cfg.fieldCount;
    band[i] = isBand ? 1 : 0;
    let dx = 0; let dy = 0; let dz = 0;
    if (!isBand) {
      // 구면 캡 균등: sin(고도)를 균등 표집.
      const s = sinMin + (1 - sinMin) * rng();
      const r = Math.sqrt(Math.max(0, 1 - s * s));
      const az = rng() * Math.PI * 2;
      dx = r * Math.cos(az); dy = s; dz = r * Math.sin(az);
    } else {
      let ok = false;
      for (let attempt = 0; attempt < 96 && !ok; attempt++) {
        const phi = rng() * Math.PI * 2;
        const delta = gaussian(rng) * sigma;
        const cd = Math.cos(delta);
        const sd = Math.sin(delta);
        const cx = Math.cos(phi); const cy = Math.sin(phi);
        dx = cd * (b1[0] * cx + b2[0] * cy) + sd * pole[0];
        dy = cd * (b1[1] * cx + b2[1] * cy) + sd * pole[1];
        dz = cd * (b1[2] * cx + b2[2] * cy) + sd * pole[2];
        ok = dy >= sinMin;
      }
      if (!ok) {
        dy = Math.max(sinMin, Math.abs(dy));
        const flat = Math.hypot(dx, dz) || 1;
        const want = Math.sqrt(Math.max(0, 1 - dy * dy));
        dx = dx / flat * want; dz = dz / flat * want;
      }
    }
    const dlen = Math.hypot(dx, dy, dz) || 1;
    position[i * 3] = dx / dlen * cfg.radius;
    position[i * 3 + 1] = dy / dlen * cfg.radius;
    position[i * 3 + 2] = dz / dlen * cfg.radius;

    const magOffset = isBand ? cfg.bandMagOffset : 0;
    const m = starMagnitudeQuantile(rng(), cfg) + magOffset;
    magnitude[i] = m;
    const flux = starFlux(m, cfg.magMin);
    const b01 = clamp01((cfg.magMax - m) / (cfg.magMax - cfg.magMin));
    bright[i] = b01;
    size[i] = cfg.sizePxMin + (cfg.sizePxMax - cfg.sizePxMin) * flux ** 0.55;
    const lum = cfg.lumMax * flux ** cfg.lumExp * (isBand ? cfg.bandLum : 1);
    const tint = rng() * 2 - 1;
    const amp = cfg.colorAmp * Math.abs(tint) * b01 ** 0.6;
    const target = tint > 0 ? cool : warm;
    phase[i] = rng();
    for (let c = 0; c < 3; c++) {
      color[i * 3 + c] = srgbToLinear(mix(1, target[c], amp)) * lum;
    }
  }
  return {
    count: total,
    radius: cfg.radius,
    position, color, size, bright, phase, magnitude, band,
  };
}
