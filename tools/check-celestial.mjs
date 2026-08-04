// 천체 표현 계약(#53 S1~S3) — 순수 노드 게이트.
//
//   S1 태양 원반: 림 다크닝 프로필 + 저고도 편평화·확대 계수
//   S2 달 위상: 위상각 ↔ 조명 방향, 가시 원반의 조명 면적비, 터미네이터 방향, 지구조 바닥
//   S3 별: 시드 재현성·등급 멱법칙 분포·지평 위 반구 제약·시간대 페이드(낮 0 / 박명 / 밤 1)
//
// 원인은 순수 노드로 단언한다(레포 규약). src/env/celestial.js 는 three·DOM 무의존이라
// 렌더러 없이 전부 검증 가능하고, sky.js 는 소스 정합만 확인한다(배선 회귀 방지).
//
// FAST_CHECKS 미등록(라운드 스펙) — 개별 실행: node tools/check-celestial.mjs

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  MILKY_WAY,
  MILKY_WAY_POLE,
  MOON_PHASE,
  MOON_TEXTURE,
  STAR_BAND_POLE,
  STAR_FIELD,
  STAR_TIME_FADE,
  SUN_DISK,
  SUN_DISK_TIME,
  buildStarField,
  elevationDegOf,
  makeStarRng,
  moonPhaseAngleDeg,
  moonPhaseLightDir,
  moonReliefNormal,
  moonSurfaceAlbedo,
  moonSurfaceShade,
  moonVisibleLitAreaFraction,
  milkyWayFade,
  milkyWayWeight,
  starAlpha,
  starFlux,
  starMagnitudeCdf,
  starMagnitudeQuantile,
  sunDiskEnlargement,
  sunDiskFlattening,
  sunDiskProfile,
  sunLimbDarkening,
  sunLowAltitude01,
} from '../src/env/celestial.js';
import { MOON_DISTANCE } from '../src/env/moon-optics.js';
import {
  SUNSET_LOOK_IDS,
  SUNSET_LOOKS,
  TIME_PRESETS,
  TIME_PROFILES,
} from '../src/env/atmosphere-profiles.js';

const near = (a, b, eps, label) => assert.ok(
  Math.abs(a - b) <= eps,
  `${label}: ${a} vs ${b} (eps ${eps})`,
);

// ── 0. 모듈 순수성 ───────────────────────────────────────────────────────────
const celestialSource = await readFile(new URL('../src/env/celestial.js', import.meta.url), 'utf8');
// 큰 소스를 doesNotMatch 로 넘기면 실패 메시지가 파일 전체를 토해내므로 boolean 으로 단언한다.
assert.ok(
  !/from\s+['"]three['"]|document\.|window\.|WebGL|createElement/i.test(celestialSource),
  'celestial contract stays renderer/browser independent',
);
assert.ok(
  !/Math\.random\s*\(/.test(celestialSource),
  'celestial contract never calls the global rng (village seed window)',
);

// ── 1. S1 태양 원반 ──────────────────────────────────────────────────────────
// 원반은 sunGlow 스프라이트와 같은 반경에 앉아야 한다(같은 태양이 두 겹으로 어긋나면 실패).
const postSource = await readFile(new URL('../src/env/post.js', import.meta.url), 'utf8');
const glowDist = Number(postSource.match(/const SUN_GLOW_DIST\s*=\s*([\d.]+)/)?.[1]);
assert.ok(Number.isFinite(glowDist), 'SUN_GLOW_DIST readable from post.js');
assert.equal(SUN_DISK.distance, glowDist, 'sun disc shares the sunGlow radius');
assert.ok(SUN_DISK.distance < 500, 'sun disc inside camera far (<500)');

// 림 다크닝: 중심 1 → 림에서 확실히 어두워지되 검게 죽지 않는다.
near(sunLimbDarkening(0), 1, 1e-12, 'limb darkening centre');
assert.ok(sunLimbDarkening(1) > 0.10 && sunLimbDarkening(1) < 0.35,
  `limb value at the edge stays a visible but darkened rim: ${sunLimbDarkening(1)}`);
let prevLimb = Infinity;
for (let i = 0; i <= 40; i++) {
  const v = sunLimbDarkening(i / 40);
  assert.ok(v <= prevLimb + 1e-12, `limb darkening is monotone decreasing at r=${i / 40}`);
  prevLimb = v;
}

// 텍스처 프로필: 경계 있는 원반(스팬 끝은 0) + 단조 감소.
near(sunDiskProfile(0), 1, 1e-12, 'disc profile centre');
near(sunDiskProfile(1), 0, 1e-12, 'disc profile vanishes at the texture span edge');
let prevProfile = Infinity;
for (let i = 0; i <= 200; i++) {
  const v = sunDiskProfile(i / 200);
  assert.ok(v <= prevProfile + 1e-9, `disc profile monotone at r=${i / 200}`);
  prevProfile = v;
}
// 코어 경계 안팎의 대비 = "원반이 있다"는 신호.
const coreR = SUN_DISK.coreSpanFraction;
assert.ok(sunDiskProfile(coreR * 0.85) > 0.35, 'core interior stays a bright disc');
assert.ok(sunDiskProfile(coreR * 1.25) < 0.09, 'outside the core only a faint aureole remains');

// 저고도 편평화·확대. 프로필의 실제 태양 고도로 판정한다.
const elevOf = (name) => elevationDegOf(TIME_PRESETS[name].sunDir);
const elevDay = elevOf('day');
const elevSunset = elevOf('sunset');
const elevDawn = elevOf('dawn');
assert.ok(elevDay > 40 && elevSunset < 14 && elevDawn < 16,
  `authored elevations: day ${elevDay} sunset ${elevSunset} dawn ${elevDawn}`);
near(sunDiskFlattening(elevDay), 1, 1e-12, 'high sun is a round disc');
near(sunDiskEnlargement(elevDay), 1, 1e-12, 'high sun keeps its authored size');
near(sunDiskFlattening(0), SUN_DISK.flattenFloor, 1e-12, 'horizon flattening floor');
near(sunDiskEnlargement(0), 1 + SUN_DISK.enlargeGain, 1e-12, 'horizon enlargement peak');
assert.ok(sunDiskFlattening(elevSunset) > 0.82 && sunDiskFlattening(elevSunset) < 0.90,
  `sunset flattening is perceptible but not an ellipse: ${sunDiskFlattening(elevSunset)}`);
assert.ok(sunDiskEnlargement(elevSunset) > 1.16 && sunDiskEnlargement(elevSunset) < 1.30,
  `sunset enlargement stays restrained: ${sunDiskEnlargement(elevSunset)}`);
// 편평비는 고도에 대해 단조, 확대는 그 역.
let prevFlat = -Infinity;
let prevBig = Infinity;
for (let e = 0; e <= 40; e += 0.5) {
  const f = sunDiskFlattening(e);
  const g = sunDiskEnlargement(e);
  assert.ok(f >= prevFlat - 1e-12, `flattening monotone in elevation at ${e}`);
  assert.ok(g <= prevBig + 1e-12, `enlargement monotone in elevation at ${e}`);
  assert.ok(f <= 1 + 1e-12 && g >= 1 - 1e-12, `no inflation above the authored size at ${e}`);
  prevFlat = f; prevBig = g;
}
near(sunLowAltitude01(SUN_DISK.lowElevHiDeg + 5), 0, 1e-12, 'low-altitude factor closes above the window');
near(sunLowAltitude01(-3), 1, 1e-12, 'below the horizon saturates the low-altitude factor');

// 시간대 존재감: 밤 0(태양 방향은 밤에 달을 겸한다 — 원반이 남으면 두 개의 달이 된다),
// 석양 최대, 정오는 절제.
// R2: 원반 코어는 HDR 광원이어야 한다(선형 1.0 은 ACES 숄더에서 노을 하늘에 묻혔다 — 실측 1.24×).
assert.ok(SUN_DISK.coreHdrGain > 1 && SUN_DISK.coreHdrGain <= 6,
  `sun core carries HDR gain above the sky, within blowout reason: ${SUN_DISK.coreHdrGain}`);
assert.equal(SUN_DISK_TIME.night, 0, 'no sun disc at night');
assert.ok(SUN_DISK_TIME.sunset >= SUN_DISK_TIME.dawn, 'sunset owns the flagship disc');
assert.ok(SUN_DISK_TIME.day < SUN_DISK_TIME.sunset, 'noon disc is restrained');
for (const k of ['dawn', 'day', 'sunset', 'night']) {
  assert.ok(SUN_DISK_TIME[k] >= 0 && SUN_DISK_TIME[k] <= 1, `sun disc opacity in range at ${k}`);
}

// ── 2. S2 달 위상 ────────────────────────────────────────────────────────────
near(moonPhaseAngleDeg(1), 0, 1e-9, 'full moon phase angle');
near(moonPhaseAngleDeg(0.5), 90, 1e-9, 'quarter moon phase angle');
near(moonPhaseAngleDeg(0), 180, 1e-9, 'new moon phase angle');

assert.ok(MOON_PHASE.illuminatedFraction > 0.5 && MOON_PHASE.illuminatedFraction < 1,
  'authored phase sits between quarter and full (night readability)');
const L = moonPhaseLightDir();
near(Math.hypot(L[0], L[1], L[2]), 1, 1e-12, 'phase light direction is unit');
// 관측자 = 원반 로컬 +z. cos(위상각) = L·ẑ = 2f − 1.
near(L[2], 2 * MOON_PHASE.illuminatedFraction - 1, 1e-12, 'phase angle matches the authored fraction');

// 가시 원반의 조명 면적비 = (1+cos θ)/2. 수치 적분으로 위상 방향식 전체를 검증한다.
const litFraction = moonVisibleLitAreaFraction(L, 768);
near(litFraction, MOON_PHASE.illuminatedFraction, 0.01,
  'numerically integrated lit area of the visible disc matches the authored phase');

// 터미네이터 방향: 조명의 화면투영 쪽이 밝고 반대쪽이 어둡다(기울기 포함).
const tilt = MOON_PHASE.terminatorTiltDeg * Math.PI / 180;
const litSide = [Math.cos(tilt) * 0.62, Math.sin(tilt) * 0.62];
const darkSide = [-litSide[0], -litSide[1]];
const shadeAt = (x, y) => {
  const nz = Math.sqrt(Math.max(0, 1 - x * x - y * y));
  return moonSurfaceShade(x, y, nz, L);
};
assert.ok(shadeAt(litSide[0], litSide[1]) > 0.55,
  `lit limb reads as sunlit: ${shadeAt(litSide[0], litSide[1])}`);
assert.ok(shadeAt(darkSide[0], darkSide[1]) < 0.16,
  `dark limb falls to earthshine: ${shadeAt(darkSide[0], darkSide[1])}`);
assert.ok(shadeAt(darkSide[0], darkSide[1]) > 0,
  'earthshine keeps the unlit limb from becoming a hole');
assert.ok(MOON_PHASE.earthshine > 0 && MOON_PHASE.earthshine < 0.12,
  `earthshine stays weak: ${MOON_PHASE.earthshine}`);
// 기울기가 0 이면 터미네이터는 수직 — 위·아래 대칭이어야 한다.
const flatL = moonPhaseLightDir({ terminatorTiltDeg: 0 });
near(flatL[1], 0, 1e-12, 'zero tilt keeps the terminator vertical');
near(
  moonSurfaceShade(0.4, 0.3, Math.sqrt(1 - 0.16 - 0.09), flatL),
  moonSurfaceShade(0.4, -0.3, Math.sqrt(1 - 0.16 - 0.09), flatL),
  1e-12,
  'zero tilt is symmetric about the disc equator',
);

// 크레이터 결: 결정론적이고 유계이며 실제로 변화가 있다(평면 회색판 금지).
const albedoSamples = [];
for (let i = 0; i < 400; i++) {
  const u = (i + 0.5) / 400;
  const theta = Math.acos(1 - 2 * u);
  const phi = i * 2.399963;
  const n = [Math.sin(theta) * Math.cos(phi), Math.cos(theta), Math.sin(theta) * Math.sin(phi)];
  const a = moonSurfaceAlbedo(n[0], n[1], n[2]);
  assert.ok(a > 0.45 && a <= 1.0001, `moon albedo bounded at sample ${i}: ${a}`);
  assert.equal(a, moonSurfaceAlbedo(n[0], n[1], n[2]), 'moon albedo is deterministic');
  albedoSamples.push(a);
}
const albedoMean = albedoSamples.reduce((s, v) => s + v, 0) / albedoSamples.length;
const albedoStd = Math.sqrt(
  albedoSamples.reduce((s, v) => s + (v - albedoMean) ** 2, 0) / albedoSamples.length,
);
assert.ok(albedoStd > 0.02, `crater/maria variation is present: std ${albedoStd}`);
assert.ok(albedoStd < 0.20, `crater variation stays a surface grain, not a mask: std ${albedoStd}`);

// 결의 법선 교란은 유계(구가 울퉁불퉁한 감자가 되면 실패).
let maxTilt = 0;
for (let i = 0; i < 200; i++) {
  const u = (i + 0.5) / 200;
  const theta = Math.acos(1 - 2 * u);
  const phi = i * 1.61803;
  const n = [Math.sin(theta) * Math.cos(phi), Math.cos(theta), Math.sin(theta) * Math.sin(phi)];
  const p = moonReliefNormal(n[0], n[1], n[2]);
  near(Math.hypot(p[0], p[1], p[2]), 1, 1e-9, 'relief normal stays unit');
  const dot = Math.min(1, Math.max(-1, p[0] * n[0] + p[1] * n[1] + p[2] * n[2]));
  maxTilt = Math.max(maxTilt, Math.acos(dot) * 180 / Math.PI);
}
assert.ok(maxTilt > 0.5, `relief actually perturbs the shading normal: ${maxTilt}°`);
assert.ok(maxTilt < 16, `relief perturbation stays a grain: ${maxTilt}°`);

assert.ok(MOON_TEXTURE.width >= 128 && MOON_TEXTURE.height >= 64, 'moon bake resolution');
assert.equal(MOON_TEXTURE.width, MOON_TEXTURE.height * 2, 'equirect bake is 2:1');
assert.equal(MOON_TEXTURE.width & (MOON_TEXTURE.width - 1), 0, 'moon bake width is power of two');

// ── 3. S3 별 ─────────────────────────────────────────────────────────────────
assert.ok(STAR_FIELD.radius < 500, 'star shell inside camera far (<500)');
assert.ok(STAR_FIELD.radius < MOON_DISTANCE, 'stars sit behind the moon so the disc stays in front');
assert.ok(STAR_FIELD.sizePxMax <= 4, 'star points stay point sources (no visible quads)');
assert.ok(STAR_FIELD.twinkleAmp > 0 && STAR_FIELD.twinkleAmp <= 0.2,
  `twinkle is micro-scale: ${STAR_FIELD.twinkleAmp}`);

// 전역 rng 오염 금지(마을 결정론 시드창).
const realRandom = Math.random;
let randomCalls = 0;
Math.random = () => { randomCalls += 1; return realRandom(); };
const field = buildStarField();
Math.random = realRandom;
assert.equal(randomCalls, 0, 'star placement never calls the global Math.random');

const total = STAR_FIELD.fieldCount + STAR_FIELD.bandCount;
assert.equal(field.count, total, 'star count matches the authored budget');
assert.equal(field.position.length, total * 3);
assert.equal(field.color.length, total * 3);
assert.equal(field.size.length, total);
assert.equal(field.bright.length, total);
assert.equal(field.phase.length, total);
assert.equal(field.magnitude.length, total);
assert.equal(field.band.length, total);

// 시드 재현성 + 시드 민감성.
const again = buildStarField();
assert.deepEqual(Array.from(again.position), Array.from(field.position), 'seeded placement reproduces');
assert.deepEqual(Array.from(again.magnitude), Array.from(field.magnitude), 'seeded magnitudes reproduce');
const shifted = buildStarField({ seed: STAR_FIELD.seed + 1 });
assert.notDeepEqual(Array.from(shifted.position), Array.from(field.position), 'a different seed moves the sky');

// 지평 위 반구 제약: 지평 아래 별은 지형 뒤에서 비친다.
const minY = Math.sin(STAR_FIELD.minElevationDeg * Math.PI / 180) * STAR_FIELD.radius;
let minSeenY = Infinity;
for (let i = 0; i < total; i++) {
  const x = field.position[i * 3];
  const y = field.position[i * 3 + 1];
  const z = field.position[i * 3 + 2];
  near(Math.hypot(x, y, z), STAR_FIELD.radius, 1e-2, `star ${i} sits on the shell`);
  assert.ok(y >= minY - 1e-3, `star ${i} stays above the horizon band: y=${y} min=${minY}`);
  minSeenY = Math.min(minSeenY, y);
}
assert.ok(minSeenY < minY + STAR_FIELD.radius * 0.05, 'the field actually reaches the horizon band');

// 별 크기·색: 채도 절제(흰빛 기준의 낮은 편차).
for (let i = 0; i < total; i++) {
  const s = field.size[i];
  assert.ok(s > 0 && s <= STAR_FIELD.sizePxMax + 1e-6, `star ${i} size in range: ${s}`);
  const r = field.color[i * 3];
  const g = field.color[i * 3 + 1];
  const b = field.color[i * 3 + 2];
  assert.ok(r >= 0 && g >= 0 && b >= 0, `star ${i} colour is non-negative`);
  const peak = Math.max(r, g, b);
  const chroma = peak - Math.min(r, g, b);
  assert.ok(chroma <= peak * 0.55 + 1e-6, `star ${i} keeps saturation discipline: ${chroma / peak}`);
}

// 등급 멱법칙: 필드 별의 경험 CDF 가 해석 CDF 를 따른다(KS 상한 ≈ 1.63/√n).
const fieldMags = [];
const bandMags = [];
for (let i = 0; i < total; i++) (field.band[i] ? bandMags : fieldMags).push(field.magnitude[i]);
assert.equal(fieldMags.length, STAR_FIELD.fieldCount);
assert.equal(bandMags.length, STAR_FIELD.bandCount);
fieldMags.sort((a, b) => a - b);
let maxKs = 0;
for (let i = 0; i < fieldMags.length; i++) {
  const empirical = (i + 1) / fieldMags.length;
  maxKs = Math.max(maxKs, Math.abs(empirical - starMagnitudeCdf(fieldMags[i])));
}
assert.ok(maxKs < 1.63 / Math.sqrt(fieldMags.length) + 1e-9,
  `field magnitudes follow the authored power law: KS ${maxKs}`);
// 등급이 1 낮아질수록 개수가 늘어난다(멱법칙의 관측 가능한 형태).
const bins = [0, 0, 0, 0, 0];
const span = (STAR_FIELD.magMax - STAR_FIELD.magMin) / bins.length;
for (const m of fieldMags) {
  const idx = Math.min(bins.length - 1, Math.floor((m - STAR_FIELD.magMin) / span));
  bins[idx] += 1;
}
for (let i = 1; i < bins.length; i++) {
  assert.ok(bins[i] > bins[i - 1], `fainter magnitude bin ${i} is more populous: ${bins}`);
}
assert.ok(bins.at(-1) / bins[0] > 3, `power-law slope is visible: ${bins}`);
near(starMagnitudeCdf(STAR_FIELD.magMin), 0, 1e-12, 'CDF starts at the brightest magnitude');
near(starMagnitudeCdf(STAR_FIELD.magMax), 1, 1e-12, 'CDF closes at the faintest magnitude');
near(starMagnitudeQuantile(0), STAR_FIELD.magMin, 1e-12, 'quantile spans the authored range');
near(starMagnitudeQuantile(1), STAR_FIELD.magMax, 1e-12, 'quantile spans the authored range');
near(starFlux(STAR_FIELD.magMin), 1, 1e-12, 'brightest star is the flux reference');
near(starFlux(STAR_FIELD.magMin + 5), 0.01, 1e-12, 'five magnitudes is a hundredth of the flux');

// ── 은하수: 확산 휘도(R2 재구현) ─────────────────────────────────────────────
// R1 의 2600 점 방식은 폐기됐다(비전 "안 보인다"). 점 밴드가 남아 있지 않은 것도 계약이다.
assert.equal(STAR_FIELD.bandCount, 0,
  'the milky way is a diffuse dome band, not a faint point cloud');
assert.equal(bandMags.length, 0, 'no band points remain in the star buffer');
const pole = MILKY_WAY_POLE;
near(Math.hypot(pole[0], pole[1], pole[2]), 1, 1e-9, 'milky-way pole is unit');
assert.ok(Math.hypot(...STAR_BAND_POLE) > 0, 'legacy band pole export stays well-formed');

// 지평 게이트가 계약이다: 지평 아래는 정확히 0 이어야 fog 색 수렴(지형 절단면 하드컷 방지)과
// check-fog-wash 의 돔 미러가 보존된다.
for (const pos of [0, 0.2, 0.44, 0.5, MILKY_WAY.gateLoPos]) {
  for (const u of [0, 0.25, 0.5, 0.75]) {
    assert.equal(milkyWayWeight(u, pos), 0,
      `milky way never touches the horizon-convergence band (pos ${pos}, u ${u})`);
  }
}
// 밴드는 대원 근처 천정 쪽에서 실제로 켜지고, 양자화 계조 수를 넘지 않는다.
const weightValues = new Set();
let bandPeak = 0;
for (let iu = 0; iu < 128; iu++) {
  for (let ip = 0; ip <= 40; ip++) {
    const w = milkyWayWeight(iu / 128, 0.5 + (ip / 40) * 0.5);
    weightValues.add(+w.toFixed(6));
    bandPeak = Math.max(bandPeak, w);
  }
}
assert.ok(bandPeak > 0.9, `the diffuse band reaches full weight on its great circle: ${bandPeak}`);
assert.ok(weightValues.size <= MILKY_WAY.steps * 12,
  `the band stays a few painterly steps, not a continuous ramp: ${weightValues.size} distinct weights`);
assert.ok(MILKY_WAY.sigmaDeg > STAR_FIELD.bandSigmaDeg,
  'the diffuse band is wider than the discarded point band (unresolved glow, not a line)');
assert.ok(MILKY_WAY.peak > 0 && MILKY_WAY.peak < 0.2,
  `diffuse band stays a low-energy overlay: ${MILKY_WAY.peak}`);
// 밤 전용 램프: 박명 돔은 불변이어야 한다(fog-wash 는 dawn 을 측정한다).
near(milkyWayFade(STAR_TIME_FADE.dawn), 0, 1e-12, 'dawn dome is untouched by the milky way');
near(milkyWayFade(STAR_TIME_FADE.sunset), 0, 1e-12, 'sunset dome is untouched by the milky way');
near(milkyWayFade(STAR_TIME_FADE.day), 0, 1e-12, 'day dome is untouched by the milky way');
near(milkyWayFade(1), 1, 1e-12, 'full night carries the full diffuse band');
let prevFade = -1;
for (let i = 0; i <= 20; i++) {
  const f = milkyWayFade(i / 20);
  assert.ok(f >= prevFade - 1e-12, 'milky-way fade is monotone in star fade');
  prevFade = f;
}

// ── 별 대비 축(R2 비전 FIX) ──────────────────────────────────────────────────
// 상위 별의 선형 휘도가 실제로 올라갔고 희미한 꼬리는 올라가지 않았음을 등급으로 단언한다.
const lumOf = (m) => STAR_FIELD.lumMax * starFlux(m) ** STAR_FIELD.lumExp;
assert.ok(STAR_FIELD.lumMax > 0.9, `top-star linear luminance was raised: ${STAR_FIELD.lumMax}`);
assert.ok(lumOf(STAR_FIELD.magMin) > 0.9, 'first-magnitude stars carry HDR energy');
assert.ok(lumOf(STAR_FIELD.magMax) < 0.09,
  `the faint tail stays a faint tail: ${lumOf(STAR_FIELD.magMax)}`);
// 구 곡선(0.52 / 0.45)보다 상위는 밝고 꼬리는 어둡다 — 대비를 키운 것이지 전체를 올린 것이 아니다.
const legacy = (m) => 0.52 * starFlux(m) ** 0.45;
assert.ok(lumOf(STAR_FIELD.magMin) > legacy(STAR_FIELD.magMin) * 1.6,
  'top stars gained substantial contrast over the R1 curve');
assert.ok(lumOf(STAR_FIELD.magMax) < legacy(STAR_FIELD.magMax) * 1.4,
  'the faint tail did not get washed brighter with them');
const mag60 = starMagnitudeQuantile(60 / STAR_FIELD.fieldCount);
assert.ok(lumOf(mag60) > 0.25,
  `the top ~60 stars clear a visible-contrast floor: mag ${mag60.toFixed(2)} → lum ${lumOf(mag60).toFixed(3)}`);

// 시간대 페이드: 낮 0 · 밤 1 · 박명은 그 사이, 밝은 별부터 남는다.
assert.equal(STAR_TIME_FADE.day, 0, 'no stars in daylight');
assert.equal(STAR_TIME_FADE.night, 1, 'full night sky');
assert.ok(STAR_TIME_FADE.dawn > 0 && STAR_TIME_FADE.dawn < 0.4, `dawn keeps only a trace: ${STAR_TIME_FADE.dawn}`);
assert.ok(STAR_TIME_FADE.sunset >= 0 && STAR_TIME_FADE.sunset < STAR_TIME_FADE.dawn,
  `the golden-hour sky is brighter than dawn: ${STAR_TIME_FADE.sunset}`);
near(starAlpha(0, 1), 0, 1e-12, 'daylight hides even the brightest star');
near(starAlpha(0, 0), 0, 1e-12, 'daylight hides the faintest star');
near(starAlpha(1, 0), 1, 1e-12, 'full night shows the faintest star');
near(starAlpha(1, 1), 1, 1e-12, 'full night shows the brightest star');
near(starAlpha(STAR_TIME_FADE.dawn, 1), STAR_TIME_FADE.dawn, 1e-12,
  'first-magnitude stars carry the twilight ramp');
near(starAlpha(STAR_TIME_FADE.dawn, 0), 0, 1e-12, 'faint stars are gone by twilight');
for (const bright of [0, 0.25, 0.5, 0.75, 1]) {
  let prev = -1;
  for (let i = 0; i <= 40; i++) {
    const a = starAlpha(i / 40, bright);
    assert.ok(a >= prev - 1e-12, `star alpha monotone in fade (bright ${bright})`);
    assert.ok(a >= 0 && a <= 1, `star alpha in range (bright ${bright})`);
    prev = a;
  }
}
// 밝은 별이 항상 먼저 보인다.
for (const fade of [0.1, 0.3, 0.5, 0.8]) {
  assert.ok(starAlpha(fade, 1) >= starAlpha(fade, 0.5), `brighter star leads the ramp at ${fade}`);
  assert.ok(starAlpha(fade, 0.5) >= starAlpha(fade, 0), `brighter star leads the ramp at ${fade}`);
}

// rng 계약: 같은 시드는 같은 수열, 값은 [0,1).
const rngA = makeStarRng(7);
const rngB = makeStarRng(7);
for (let i = 0; i < 64; i++) {
  const v = rngA();
  assert.equal(v, rngB(), 'star rng is reproducible');
  assert.ok(v >= 0 && v < 1, 'star rng stays in [0,1)');
}

// ── 3b. 밤 SUN_BAND 배율 + 은하수 조준(#53 R3b) ──────────────────────────────
// 배경(직전 라운드 실측): 밤하늘 바닥의 97%(부감)/84%(skyward)를 돔의 SUN_BAND 가 칠하고 있었고,
//   별·달·구름·블룸의 지분은 ≈0 이었다. 그래서 별 대비는 별 상수가 아니라 이 밴드가 결정한다.
const nightAtmosphere = TIME_PROFILES.night.atmosphere;
const NIGHT_SUN_BAND_PEAK = 0.26;   // sky.js 저작값(아래에서 소스로 재확인 — fog-wash 가 같은 값을 읽는다)
assert.ok(typeof nightAtmosphere.sunBandScale === 'number',
  'night profile owns the SUN_BAND time multiplier');
assert.ok(nightAtmosphere.sunBandScale > 0.15 && nightAtmosphere.sunBandScale < 0.5,
  `night SUN_BAND multiplier stays a restraint, not an erasure: ${nightAtmosphere.sunBandScale}`);
const nightBandPeak = NIGHT_SUN_BAND_PEAK * nightAtmosphere.sunBandScale;
assert.ok(nightBandPeak > 0.06 && nightBandPeak < 0.10,
  `night effective SUN_BAND peak sits on the measured frontier (0.08): ${nightBandPeak.toFixed(4)}`);
// 낮·박명·노을 돔은 동결이다 — 배율을 두지 않거나 정확히 1.
for (const [id, atmosphere] of [
  ['day', TIME_PROFILES.day.atmosphere],
  ['dawn', TIME_PROFILES.dawn.atmosphere],
  ...SUNSET_LOOK_IDS.map((look) => [`sunset:${look}`, SUNSET_LOOKS[look].atmosphere]),
]) {
  const scale = atmosphere.sunBandScale ?? 1;
  assert.equal(scale, 1, `${id} dome stays byte-frozen (SUN_BAND multiplier 1)`);
}

// 은하수 조준: 대원 중심선(d·pole = 0)이 달 조준 프레임 안에서 지평을 건너야 밴드가 화면을
//   가로지른다. 구 pole 118° 는 중심선이 Δaz +11° 이후에만 지평 위였고(프레임 모서리만 스침),
//   그 상태의 실측 진폭이 +6.6/255 였다. 프레임 방위 반각은 fov 40°·16:9 에서 ≈35°.
const nightSunDir = nightAtmosphere.sunDir;
const moonAzimuthU = (() => {
  const h = Math.hypot(nightSunDir[0], nightSunDir[2]);
  const u = Math.atan2(nightSunDir[2] / h, -nightSunDir[0] / h) / (Math.PI * 2);
  return u - Math.floor(u);
})();
const bandCentrelineElevDeg = (u) => {
  const phi = u * Math.PI * 2;
  return Math.atan2(
    Math.cos(phi) * MILKY_WAY_POLE[0] - Math.sin(phi) * MILKY_WAY_POLE[2],
    MILKY_WAY_POLE[1],
  ) * (180 / Math.PI);
};
// 제품 캔버스는 1440×810 뷰포트에서 우측 패널을 뺀 1080×810(4:3)이다 — fov 40° 세로에
//   가로 반각은 atan(tan20°·4/3) ≈ 25.9°. 16:9 로 가정하면 프레임 밖 방위까지 세게 된다.
const FRAME_ASPECT = 4 / 3;
const FRAME_AZ_HALF_DEG = Math.atan(Math.tan(20 * Math.PI / 180) * FRAME_ASPECT) * (180 / Math.PI);
const elevAtMoonAzimuth = bandCentrelineElevDeg(moonAzimuthU);
assert.ok(elevAtMoonAzimuth > 5 && elevAtMoonAzimuth < 40,
  `the band centreline crosses the moon-aimed frame above the moon: ${elevAtMoonAzimuth.toFixed(1)}°`);
// 프레임 방위창 안에서 중심선이 지평(0°)을 건너는 지점이 존재해야 "능선에서 솟는 대각"이 된다.
let horizonCrossDeg = null;
let prevElev = bandCentrelineElevDeg((moonAzimuthU - FRAME_AZ_HALF_DEG / 360 + 1) % 1);
for (let d = -FRAME_AZ_HALF_DEG + 1; d <= FRAME_AZ_HALF_DEG; d += 0.5) {
  const e = bandCentrelineElevDeg((moonAzimuthU + d / 360 + 1) % 1);
  if (horizonCrossDeg === null && Math.sign(e) !== Math.sign(prevElev)) horizonCrossDeg = d;
  prevElev = e;
}
assert.ok(horizonCrossDeg !== null,
  'the diffuse band rises out of the horizon inside the moon-aimed frame');
// 밴드가 달 원반을 삼키지 않는다(달 자리의 가중은 낮게 남는다).
const weightAtMoon = milkyWayWeight(moonAzimuthU, 0.5 + elevationDegOf(nightSunDir) / 180);
assert.ok(weightAtMoon < 0.3,
  `the moon disc is not swallowed by the band: weight ${weightAtMoon.toFixed(2)}`);
// 프레임 하늘 픽셀 평균 가중(61×61 표집, 지평 게이트 위) — 구 조준 0.26 에서 실제로 올라갔는가.
const skywardSkyMeanWeight = (() => {
  const DEG = Math.PI / 180;
  const centreElev = elevationDegOf(nightSunDir) * DEG;
  const phi = moonAzimuthU * Math.PI * 2;
  const fwd = [-Math.cos(phi) * Math.cos(centreElev), Math.sin(centreElev), Math.sin(phi) * Math.cos(centreElev)];
  let right = [fwd[2], 0, -fwd[0]];
  const rl = Math.hypot(...right);
  right = right.map((v) => v / rl);
  const up = [
    fwd[1] * right[2] - fwd[2] * right[1],
    fwd[2] * right[0] - fwd[0] * right[2],
    fwd[0] * right[1] - fwd[1] * right[0],
  ];
  const tanY = Math.tan(20 * DEG), tanX = tanY * FRAME_ASPECT;
  let sum = 0, n = 0;
  for (let j = 0; j < 61; j++) {
    const sy = (j / 60) * 2 - 1;
    for (let i = 0; i < 61; i++) {
      const sx = (i / 60) * 2 - 1;
      const d = [0, 1, 2].map((axis) => fwd[axis] + right[axis] * sx * tanX + up[axis] * sy * tanY);
      const l = Math.hypot(...d);
      const dir = d.map((v) => v / l);
      const elev = Math.asin(dir[1]) / DEG;
      if (elev <= (MILKY_WAY.gateLoPos - 0.5) * 180) continue;
      const hh = Math.hypot(dir[0], dir[2]);
      const u = (Math.atan2(dir[2] / hh, -dir[0] / hh) / (Math.PI * 2) + 1) % 1;
      sum += milkyWayWeight(u, 0.5 + elev / 180);
      n++;
    }
  }
  return n ? sum / n : 0;
})();
assert.ok(skywardSkyMeanWeight > 0.40,
  `re-aimed band actually fills the skyward sky band: mean weight ${skywardSkyMeanWeight.toFixed(3)}`);

// ── 4. sky.js 배선 정합 ──────────────────────────────────────────────────────
const skySource = await readFile(new URL('../src/env/sky.js', import.meta.url), 'utf8');
// 저작 리터럴 보존(tools/check-fog-wash.mjs 가 소스에서 `peak: 0.26` 을 읽는다) + 배율 배선.
assert.ok(new RegExp(`peak:\\s*${NIGHT_SUN_BAND_PEAK}`).test(skySource),
  'SUN_BAND authored peak literal is preserved for check-fog-wash');
const wired = (re, msg) => assert.ok(re.test(skySource), `sky.js wiring — ${msg}`);
wired(/from\s+['"]\.\/celestial\.js['"]/, 'consumes the celestial contract');
wired(/new THREE\.Points\(/, 'owns the star Points layer');
assert.equal((skySource.match(/new THREE\.Points\(/g) || []).length, 1,
  'exactly one star draw call (milky way rides the same buffer)');
assert.equal((skySource.match(/new THREE\.Sprite\(/g) || []).length, 1,
  'exactly one new sun-disc sprite');
wired(/sun-disk/, 'sun disc is a named sky object');
wired(/'stars'|"stars"/, 'star layer is a named sky object');
// 페이드는 상태기계 필드여야 한다(하드 컷 금지 계약).
wired(/stars:\s*0/, 'stars is an interpolated state field');
wired(/sunDisk:\s*0/, 'sunDisk is an interpolated state field');
wired(/out\.stars\s*=\s*_l\(a\.stars/, 'star fade crossfades with the time tween');
wired(/out\.sunDisk\s*=\s*_l\(a\.sunDisk/, 'sun disc crossfades with the time tween');
wired(/dst\.stars\s*=\s*src\.stars/, 'star fade survives tween retarget');
wired(/dst\.sunDisk\s*=\s*src\.sunDisk/, 'sun disc survives tween retarget');
// #53 R3b: SUN_BAND 시간대 배율도 트윈 필드 — 하드 컷이면 시간대 전환에서 하늘이 툭 떨어진다.
wired(/sunBandScale:\s*1/, 'SUN_BAND multiplier is an interpolated state field (default 1)');
wired(/out\.sunBandScale\s*=\s*P\.sunBandScale/, 'the multiplier is owned by the time profile');
wired(/out\.sunBandScale\s*=\s*_l\(a\.sunBandScale/, 'SUN_BAND multiplier crossfades with the time tween');
wired(/dst\.sunBandScale\s*=\s*src\.sunBandScale/, 'SUN_BAND multiplier survives tween retarget');
wired(/SUN_BAND\.peak\s*\*\s*cur\.sunBandScale/, 'the dome band actually applies the multiplier');
// 달 원반은 위상 베이크를 map 으로 받는다.
wired(/moonSurfaceTexture|makeMoonSurfaceTexture/, 'moon disc consumes the phase bake');
// 별·원반은 가산 하늘 레이어 — 깊이는 지형이 소유한다.
wired(/AdditiveBlending/, 'sky celestial layers are additive');
// 은하수는 돔 캔버스 합성(드로우콜 +0) — 별 Points 가 두 번째 버퍼를 만들면 안 된다.
wired(/makeMilkyWayCanvas/, 'milky way is baked as a diffuse dome overlay');
wired(/drawMilkyWay\(W\)/, 'the diffuse band composites inside the dome rebuild');
wired(/coreHdrGain/, 'sun disc core applies the HDR gain');
assert.ok(
  !/from\s+['"][^'"]*clouds\.js['"]/.test(skySource),
  'sky.js does not import the parallel cloud round',
);
// check-fog-wash 가 미러링하는 돔 테이블은 그대로 남아야 한다.
for (const table of ['DOME_HAZE', 'HAZE_TINT', 'SUN_BAND']) {
  assert.ok(skySource.includes(`const ${table} =`), `${table} table preserved for check-fog-wash`);
}
// 결정론: shot 모드는 반짝임 시계를 얼린다.
wired(/shot/, 'freezes the twinkle clock for shot captures');

console.log('celestial contract OK');
console.log(`  sun disc: dist ${SUN_DISK.distance} · limb(edge) ${sunLimbDarkening(1).toFixed(3)}`
  + ` · sunset flatten ${sunDiskFlattening(elevSunset).toFixed(3)} enlarge ${sunDiskEnlargement(elevSunset).toFixed(3)}`);
console.log(`  moon: phase ${MOON_PHASE.illuminatedFraction} · integrated lit area ${litFraction.toFixed(4)}`
  + ` · albedo std ${albedoStd.toFixed(4)} · relief max ${maxTilt.toFixed(2)}°`);
console.log(`  stars: ${field.count} points (field ${STAR_FIELD.fieldCount} / band ${STAR_FIELD.bandCount})`
  + ` · KS ${maxKs.toFixed(4)} · bins ${bins.join('/')}`);
console.log(`  star contrast curve: lumMax ${STAR_FIELD.lumMax} exp ${STAR_FIELD.lumExp}`
  + ` → brightest ${lumOf(STAR_FIELD.magMin).toFixed(3)} · top60(mag ${mag60.toFixed(2)})`
  + ` ${lumOf(mag60).toFixed(3)} · faintest ${lumOf(STAR_FIELD.magMax).toFixed(3)} linear`);
console.log(`  milky way: diffuse dome band peak ${MILKY_WAY.peak} · sigma ${MILKY_WAY.sigmaDeg}°`
  + ` · ${MILKY_WAY.steps} steps · horizon-gated above pos ${MILKY_WAY.gateLoPos}`);
console.log(`  milky way aim: pole az ${MILKY_WAY.poleAzimuthDeg}° → centreline ${elevAtMoonAzimuth.toFixed(1)}°`
  + ` above the moon azimuth · crosses the horizon at Δaz ${horizonCrossDeg.toFixed(1)}°`
  + ` · skyward sky-pixel mean weight ${skywardSkyMeanWeight.toFixed(3)} · weight at the moon ${weightAtMoon.toFixed(2)}`);
console.log(`  night SUN_BAND: authored ${NIGHT_SUN_BAND_PEAK} × ${nightAtmosphere.sunBandScale}`
  + ` = effective ${nightBandPeak.toFixed(4)} (day/dawn/sunset frozen at 1.0)`);
console.log(`  sun core HDR gain: ${SUN_DISK.coreHdrGain}x`);
console.log(`  fade: day ${STAR_TIME_FADE.day} · sunset ${STAR_TIME_FADE.sunset} · dawn ${STAR_TIME_FADE.dawn} · night ${STAR_TIME_FADE.night}`);
