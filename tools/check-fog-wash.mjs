// #35-R2 대기 워시 계약 (2026-08-01) — 순수 노드. 브라우저 락을 잡지 않는다.
//
// 무엇을 지키는가
//   ① 워시(결함 #1): scene.fog 색이 대표 알베도들의 색상 차를 지워 프레임 전체를 한 색조로
//      만드는 것을 막는다. 순수 픽셀 진단(2026-08-01, 기존 캡처 78장)에서 유채 픽셀의 78.6%가
//      hue 320~30° 한 대역에 뭉쳤고 foliage 녹은 2.2% 뿐이었다.
//   ② 부감 돔 구배(결함 #4): 지평 밴드가 무구배 평면이 되어 그 위로 돌출한 지오가 "떠 있는"
//      것처럼 읽히는 것을 막는다. 같은 진단에서 상부 63~219행이 3×3 국소 휘도 std 0.05~0.06,
//      180행 동안 변화 4/255 였다.
//   ③ 암부 중립(look-grammar §2-3): 중성 알베도(화강암·회벽)가 대기색을 뒤집어쓰지 않는다.
//
// 왜 브라우저가 아닌가
//   fog 는 <fog_fragment> 의 선형 mix 한 줄이고 돔은 캔버스 그라디언트 위 알파 램프다. 둘 다
//   해석적으로 정확히 재현되며(아래 파이프라인), 수치 게이트는 모든 알베도 조합을 잡지만
//   캡처는 고른 프레이밍만 잡는다. 렌더 확인은 shoot 계열이 따로 맡는다.
//
// 재현하는 파이프라인 (three r185.1, renderer.toneMapping=None + 컴포저 선형 타깃)
//   material   : directDiffuse + indirectDiffuse (BRDF_Lambert = albedo / PI)
//   fog        : mix(col, fogLinear, fogFactor)          — 선형 공간
//   GradePass  : luma 축 채도 → lift * liftColor * (1-col)
//   OutputPass : ACESFilmic(exposure) → linear→sRGB
//   bloom·flare 는 가산이라 생략한다(측정값을 키우기만 한다).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SUNSET_LOOKS, TIME_PROFILES } from '../src/env/atmosphere-profiles.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ── 계약 임계 ────────────────────────────────────────────────────────────────
// FOG_FACTOR: 마을 부감에서 실제로 도달하는 최대 대기 혼합비(src/env/village-fog-band.js 의
//   near/far 램프를 aerial fallback 2.3R 로 풀면 가장 먼 지형에서 0.456). 최악 조건에서 건다.
const FOG_FACTOR = 0.456;
// 채도 가중 원형 표준편차(도). 무회귀 시점 실측: gold 2.6 · crimson 3.5 · violet 12.0 · dawn 3.7.
//   대기 없는 상태(fogFactor 0)가 92° 이므로 25° 는 "색상 구분이 남아 있다"의 하한이다.
const MIN_HUE_SPREAD_DEG = 25;
// hue 320~30° = 진단이 워시 대역으로 특정한 구간. 12개 중 6개(50%) 초과면 워시로 본다.
const ROSE_BAND = (h) => h >= 320 || h < 30;
const MAX_ROSE_SHARE = 0.5;
// 중성 알베도가 대기 때문에 **얻는** 색조의 상한(HSV S 증가분, fogFactor 0 대비).
//   절대 채도가 아니라 증가분으로 재는 이유: 프로필의 조명 리그가 이미 무채 알베도를 물들이는
//   경우가 있고(dawn 의 웜 안티솔라 fill), 그건 이 계약이 아니라 조명 리그의 문제다. 여기서는
//   fog 항의 지분만 격리한다. 무회귀 시점 실측: gold 화강암 +0.309 · 회벽 +0.292,
//   crimson +0.157 / +0.176.
const MAX_NEUTRAL_CAST_GAIN = 0.06;
// 저작 축 상한. 색상은 프로필별 정체성이 있어 걸지 않고, 양(채도·휘도)만 건다.
const MAX_FOG_HSL_SAT = 0.25;
// fog 선형 휘도 / 그 프로필 표면 휘도 중앙값. 무회귀 시점: gold 9.9 · crimson 10.6 ·
//   violet 11.2 · dawn 15.1 배 — fog 가 20% 혼합만으로 픽셀의 다수가 되던 근본 원인이다.
const MAX_FOG_LUMA_RATIO = 4.0;
// 부감 돔 밴드: pos 0.44(지평 −10.8°) ~ 0.52(지평 +3.6°). 제품 부감 렌즈 46°/1080행을 행 척도로
//   쓴다(100행 = 4.26° = pos 0.0237). 밴드 안에서 위로 갈수록 밝아져야 하고(부호), 100행당
//   최소 변화량이 있어야 한다(무구배 평면 금지).
const BAND_POS_LO = 0.44;
const BAND_POS_HI = 0.52;
const AERIAL_FOV_DEG = 46;
const AERIAL_ROWS = 1080;
const POS_PER_100_ROWS = (AERIAL_FOV_DEG / AERIAL_ROWS) * 100 / 180;
const MIN_BAND_STEP_PER_100_ROWS = 1.5;

// ── 색 공간 ──────────────────────────────────────────────────────────────────
const s2l = (x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
const l2s = (x) => (x <= 0.0031308 ? x * 12.92 : 1.055 * x ** (1 / 2.4) - 0.055);
const LUMA = [0.2126, 0.7152, 0.0722];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (v) => { const l = Math.hypot(...v); return v.map((x) => x / l); };
const hexBytes = (hex) => [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
const hexLin = (hex) => hexBytes(hex).map((c) => s2l(c / 255));
const linLuma = (hex) => dot3(LUMA, hexLin(hex));

function hsv(rgb255) {
  const [r, g, b] = rgb255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) {
    if (mx === r) h = 60 * (((g - b) / d) % 6);
    else if (mx === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  if (h < 0) h += 360;
  return { h, s: mx ? d / mx : 0, v: mx / 255 };
}

function hslSat(hex) {
  const [r, g, b] = hexBytes(hex).map((x) => x / 255);
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (d === 0) return 0;
  const L = (mx + mn) / 2;
  return d / (1 - Math.abs(2 * L - 1));
}

function aces(c, exposure) {
  const IN = [[0.59719, 0.35458, 0.04823], [0.07600, 0.90834, 0.01566], [0.02840, 0.13383, 0.83777]];
  const OUT = [[1.60475, -0.53108, -0.07367], [-0.10208, 1.10813, -0.00605], [-0.00327, -0.07276, 1.07602]];
  const mul = (M, v) => M.map((row) => dot3(row, v));
  let v = c.map((x) => x * exposure / 0.6);
  v = mul(IN, v);
  v = v.map((x) => (x * (x + 0.0245786) - 0.000090537) / (x * (0.983729 * x + 0.432951) + 0.238081));
  return mul(OUT, v).map((x) => Math.min(1, Math.max(0, x)));
}

// ── 씬 상수 (미러 + 드리프트 단언) ───────────────────────────────────────────
// lighting.js 는 three 를 import 하므로(app/node_modules 전용) 여기서 값을 미러하고,
// 원본 텍스트와 대조해 드리프트하면 게이트가 먼저 죽게 한다.
const VILLAGE_RIG = {
  dawn: { hemiSky: 0xb9c2da, hemiGround: 0x86745c, hemiInt: 0.62, fillColor: 0xffcda0, fillInt: 0.85, fillElev: 0.34 },
  sunset: { hemiSky: 0x9fb0d6, hemiGround: 0x2a241e, hemiInt: 0.54, fillColor: 0xb6b9c4, fillInt: 0.72, fillElev: 0.42 },
};
{
  const src = readFileSync(join(ROOT, 'src/runtime/village/lighting.js'), 'utf8');
  for (const need of [
    'hemiSky: 0xb9c2da, hemiGround: 0x86745c, hemiInt: 0.62',
    'fillColor: 0xffcda0, fillInt: 0.85, fillElev: 0.34',
    'hemiSky: 0x9fb0d6, hemiGround: 0x2a241e, hemiInt: 0.54',
    'fillColor: 0xb6b9c4, fillInt: 0.72, fillElev: 0.42',
  ]) {
    assert.ok(src.includes(need), `village lighting rig drifted from the mirrored constants: ${need}`);
  }
}

// DOME_HAZE 는 sky.js 안의 렌더러 결합 상수라 export 되지 않는다. 소스에서 읽어 계약을 건다.
function readDomeHaze() {
  const src = readFileSync(join(ROOT, 'src/env/sky.js'), 'utf8');
  const block = src.match(/const DOME_HAZE = \[([\s\S]*?)\];/);
  assert.ok(block, 'DOME_HAZE table not found in src/env/sky.js');
  const stops = [...block[1].matchAll(/pos:\s*([\d.]+),\s*a:\s*([\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
  assert.ok(stops.length >= 4, 'DOME_HAZE parse produced too few stops');
  return stops;
}
const DOME_HAZE = readDomeHaze();

// ── 셰이딩 ───────────────────────────────────────────────────────────────────
// warmScale: lighting.js setSiteRadius. 마을(R150)은 1.0.
const warmScale = (R) => Math.max(0.3, 1 - Math.min(1, Math.max(0, (R - 170) / 130)) * 0.6);

function makeScene(atmosphere, rig) {
  const sunDir = norm(atmosphere.sunDir);
  const horiz = Math.hypot(atmosphere.sunDir[0], atmosphere.sunDir[2]);
  const fillDir = norm([-atmosphere.sunDir[0], horiz * rig.fillElev, -atmosphere.sunDir[2]]);
  return { atmosphere, rig, sunDir, fillDir };
}

function shade(scene, albedoHex, normal, sunShadow, siteR = 150) {
  const { atmosphere: A, rig, sunDir, fillDir } = scene;
  const alb = hexLin(albedoHex);
  const w = warmScale(siteR);
  const out = [0, 0, 0];
  const lights = [
    { dir: sunDir, color: hexLin(A.sunColor), intensity: A.sunInt, shadow: sunShadow },
    { dir: fillDir, color: hexLin(rig.fillColor), intensity: rig.fillInt * w, shadow: 1 },
  ];
  for (const L of lights) {
    const nl = Math.max(0, dot3(normal, L.dir));
    if (nl <= 0) continue;
    for (let i = 0; i < 3; i++) out[i] += nl * L.color[i] * L.intensity * L.shadow * alb[i] / Math.PI;
  }
  const wUp = 0.5 * normal[1] + 0.5;
  const hemis = [
    { sky: hexLin(A.hemiSky), ground: hexLin(A.hemiGround), intensity: A.hemiInt },
    { sky: hexLin(rig.hemiSky), ground: hexLin(rig.hemiGround), intensity: rig.hemiInt * w },
  ];
  for (const H of hemis) {
    for (let i = 0; i < 3; i++) out[i] += (H.ground[i] + (H.sky[i] - H.ground[i]) * wUp) * H.intensity * alb[i] / Math.PI;
  }
  return out;
}

function present(linear, { fogFactor, fogHex, post, exposure }) {
  const fog = hexLin(fogHex);
  let c = linear.map((x, i) => x + (fog[i] - x) * fogFactor);
  const l = dot3(LUMA, c);
  c = c.map((x) => l + (x - l) * post.sat);
  const lc = hexLin(post.liftColor ?? 0x000000);
  const lift = post.lift ?? 0;
  c = c.map((x, i) => x + lc[i] * lift * Math.max(0, 1 - x));
  return aces(c, exposure).map((x) => Math.round(l2s(x) * 255));
}

// 대표 알베도 12종 — 진단이 실제 렌더에서 뽑은 패밀리(뇌록·주홍·기와·초가·수목·화강암·회벽·흙).
// 'neutral' 은 알베도 자체가 거의 무채라 대기색 전이가 그대로 보이는 감시 표면이다.
function families(scene) {
  const UP = [0, 1, 0];
  const pitched = (deg, toward) => {
    const h = norm([toward[0], 0, toward[2]]);
    const r = deg * Math.PI / 180;
    return norm([h[0] * Math.sin(r), Math.cos(r), h[2] * Math.sin(r)]);
  };
  const roofSun = pitched(30, scene.sunDir);
  const roofAway = pitched(30, scene.sunDir.map((x) => -x));
  const wallAway = norm([-scene.sunDir[0], 0, -scene.sunDir[2]]);
  return [
    { id: 'giwa tile (sun side)', hex: 0x56585f, n: roofSun, shadow: 1 },
    { id: 'giwa tile (away)', hex: 0x56585f, n: roofAway, shadow: 0 },
    { id: 'choga thatch', hex: 0x766748, n: roofAway, shadow: 0 },
    { id: 'noerok dancheong', hex: 0x4c6559, n: wallAway, shadow: 0 },
    { id: 'juhong dancheong', hex: 0x9c4632, n: wallAway, shadow: 0 },
    { id: 'foliage pine dark', hex: 0x243821, n: UP, shadow: 1 },
    { id: 'foliage pine light', hex: 0x364c2d, n: UP, shadow: 1 },
    { id: 'foliage broad', hex: 0x445f2c, n: UP, shadow: 1 },
    { id: 'granite outcrop', hex: 0x827f76, n: UP, shadow: 1, neutral: true },
    { id: 'plaster wall', hex: 0xe0dccb, n: wallAway, shadow: 0, neutral: true },
    { id: 'terrain court', hex: 0x8a7f66, n: UP, shadow: 1 },
    { id: 'terrain forest floor', hex: 0x435a2a, n: UP, shadow: 1 },
  ];
}

// 채도 가중 원형 표준편차(도). 채도가 0 에 가까운 표면은 색상 정보가 없으므로 가중이 낮다.
function hueSpreadDeg(rows) {
  let sx = 0, sy = 0, sw = 0;
  for (const r of rows) {
    const a = r.h * Math.PI / 180;
    sx += Math.cos(a) * r.s; sy += Math.sin(a) * r.s; sw += r.s;
  }
  if (sw <= 0) return 0;
  const R = Math.min(1, Math.hypot(sx, sy) / sw);
  return Math.sqrt(Math.max(0, -2 * Math.log(R))) * 180 / Math.PI;
}

// ── 돔 ───────────────────────────────────────────────────────────────────────
function rampAt(table, pos) {
  const t = [...table].sort((a, b) => a[0] - b[0]);
  if (pos <= t[0][0]) return t[0][1];
  if (pos >= t[t.length - 1][0]) return t[t.length - 1][1];
  for (let i = 1; i < t.length; i++) {
    if (pos <= t[i][0]) {
      const k = (pos - t[i - 1][0]) / (t[i][0] - t[i - 1][0]);
      const a = t[i - 1][1], b = t[i][1];
      return Array.isArray(a) ? a.map((x, j) => x + (b[j] - x) * k) : a + (b - a) * k;
    }
  }
  return t[t.length - 1][1];
}

// 캔버스 그라디언트는 sRGB 로 보간하고, 그 위에 fog 색을 알파로 합성한 뒤 SRGBColorSpace
// 텍스처로 디코드된다 — 그 순서를 그대로 따른다.
function domeLuma(atmosphere, post, pos, fogHex) {
  const stops = atmosphere.sky.map(([p, hex]) => [p, [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))]);
  const base = rampAt(stops, pos);
  const a = rampAt(DOME_HAZE, pos);
  const fogSRGB = hexBytes(fogHex);
  const composited = base.map((c, i) => c * (1 - a) + fogSRGB[i] * a);
  let lin = composited.map((c) => s2l(c / 255));
  const l = dot3(LUMA, lin);
  lin = lin.map((x) => l + (x - l) * post.sat);
  const lc = hexLin(post.liftColor ?? 0x000000);
  const lift = post.lift ?? 0;
  lin = lin.map((x, i) => x + lc[i] * lift * Math.max(0, 1 - x));
  const out = aces(lin, atmosphere.exposure).map((x) => Math.round(l2s(x) * 255));
  return dot3(LUMA, out);
}

// ── 케이스 ───────────────────────────────────────────────────────────────────
// 네 노을 프로필 전부. dawn 은 sunsetLook 이 아니지만 같은 저녁/새벽 역광 유도를 공유하고
// 진단에서 fog 휘도 비율이 가장 나빴으므로(15.1배) 같은 계약 아래 둔다.
const CASES = [
  { id: 'sunset:gold', atmosphere: SUNSET_LOOKS.gold.atmosphere, post: SUNSET_LOOKS.gold.post, rig: VILLAGE_RIG.sunset },
  { id: 'sunset:crimson', atmosphere: SUNSET_LOOKS.crimson.atmosphere, post: SUNSET_LOOKS.crimson.post, rig: VILLAGE_RIG.sunset },
  { id: 'sunset:violet', atmosphere: SUNSET_LOOKS.violet.atmosphere, post: SUNSET_LOOKS.violet.post, rig: VILLAGE_RIG.sunset },
  { id: 'dawn', atmosphere: TIME_PROFILES.dawn.atmosphere, post: TIME_PROFILES.dawn.post, rig: VILLAGE_RIG.dawn },
];

const report = [];
for (const c of CASES) {
  const { atmosphere: A, post, rig } = c;
  const scene = makeScene(A, rig);
  const fam = families(scene);

  const surfaceLuma = fam.map((f) => dot3(LUMA, shade(scene, f.hex, f.n, f.shadow))).sort((a, b) => a - b);
  const medianSurfaceLuma = surfaceLuma[Math.floor(surfaceLuma.length / 2)];

  // ① 저작 축: 대기색의 "양"만 건다(색상은 프로필 정체성이라 자유).
  const sat = hslSat(A.fog);
  assert.ok(sat <= MAX_FOG_HSL_SAT,
    `${c.id}: fog HSL saturation ${sat.toFixed(3)} exceeds ${MAX_FOG_HSL_SAT} — a saturated atmosphere paints every surface one hue`);
  const ratio = linLuma(A.fog) / medianSurfaceLuma;
  assert.ok(ratio <= MAX_FOG_LUMA_RATIO,
    `${c.id}: fog linear luminance ${linLuma(A.fog).toFixed(3)} is ${ratio.toFixed(1)}x the median surface luminance `
    + `${medianSurfaceLuma.toFixed(4)} (cap ${MAX_FOG_LUMA_RATIO}x) — fog becomes the majority of the pixel at low fogFactor`);

  // ② 워시: 최악 대기 혼합비에서 색상 구분이 남아 있는가.
  const rows = fam.map((f) => {
    const rgb = present(shade(scene, f.hex, f.n, f.shadow), {
      fogFactor: FOG_FACTOR, fogHex: A.fog, post, exposure: A.exposure,
    });
    return { ...f, rgb, ...hsv(rgb) };
  });
  const spread = hueSpreadDeg(rows);
  assert.ok(spread >= MIN_HUE_SPREAD_DEG,
    `${c.id}: hue spread ${spread.toFixed(1)} deg at fogFactor ${FOG_FACTOR} is below ${MIN_HUE_SPREAD_DEG} `
    + `— the atmosphere collapsed ${rows.length} albedo families onto one hue`);

  const rose = rows.filter((r) => ROSE_BAND(r.h) && r.s > 0.05).length;
  assert.ok(rose <= Math.floor(rows.length * MAX_ROSE_SHARE),
    `${c.id}: ${rose}/${rows.length} families land in the rose band (hue 320-30) at fogFactor ${FOG_FACTOR} `
    + `— cap is ${Math.floor(rows.length * MAX_ROSE_SHARE)}`);

  // ③ 암부 중립: 무채 알베도가 대기색을 뒤집어쓰지 않는가(fog 항의 지분만).
  const clear = new Map(fam.map((f) => {
    const rgb = present(shade(scene, f.hex, f.n, f.shadow), {
      fogFactor: 0, fogHex: A.fog, post, exposure: A.exposure,
    });
    return [f.id, hsv(rgb).s];
  }));
  let neutralGain = -Infinity;
  for (const r of rows.filter((x) => x.neutral)) {
    const gain = r.s - clear.get(r.id);
    neutralGain = Math.max(neutralGain, gain);
    assert.ok(gain <= MAX_NEUTRAL_CAST_GAIN,
      `${c.id}: neutral albedo "${r.id}" gains ${gain >= 0 ? '+' : ''}${gain.toFixed(3)} saturation from the atmosphere `
      + `(${clear.get(r.id).toFixed(3)} -> ${r.s.toFixed(3)}, cap +${MAX_NEUTRAL_CAST_GAIN}) `
      + `— warmth belongs to highlights and rim, not to midtones and shadows`);
  }

  // ④ 부감 돔 밴드 구배: 위로 갈수록 밝아지고, 100행마다 최소 변화가 있어야 한다.
  const samples = [];
  for (let pos = BAND_POS_LO; pos <= BAND_POS_HI + 1e-9; pos += POS_PER_100_ROWS) {
    samples.push({ pos, luma: domeLuma(A, post, pos, A.fog) });
  }
  assert.ok(samples.length >= 3, 'dome band sampling produced too few steps');
  let minStep = Infinity;
  for (let i = 1; i < samples.length; i++) {
    minStep = Math.min(minStep, samples[i].luma - samples[i - 1].luma);
  }
  assert.ok(minStep >= MIN_BAND_STEP_PER_100_ROWS,
    `${c.id}: dome band pos ${BAND_POS_LO}-${BAND_POS_HI} changes only ${minStep.toFixed(2)} luminance levels per 100 `
    + `aerial rows (floor ${MIN_BAND_STEP_PER_100_ROWS}, and it must brighten upward) — a gradient-free bright plane is `
    + `what makes protruding geometry read as floating above a fog band`);

  report.push({
    id: c.id,
    fog: `#${A.fog.toString(16).padStart(6, '0')}`,
    hue: hsv(hexBytes(A.fog)).h,
    sat,
    lum: linLuma(A.fog),
    ratio,
    spread,
    rose,
    neutralGain,
    bandLo: samples[0].luma,
    bandHi: samples[samples.length - 1].luma,
    minStep,
  });
}

console.log('fog wash contract — fogFactor %s, dome band pos %s..%s (%s deg / %s row lens)',
  FOG_FACTOR, BAND_POS_LO, BAND_POS_HI, AERIAL_FOV_DEG, AERIAL_ROWS);
console.log('  profile         fog      hue  sHSL   linY   x med  hueSpread  rose  neutralGain  band L      /100rows');
for (const r of report) {
  console.log(`  ${r.id.padEnd(15)} ${r.fog}  ${r.hue.toFixed(0).padStart(3)}  ${r.sat.toFixed(3)}  ${r.lum.toFixed(3)}  ${r.ratio.toFixed(1).padStart(4)}x  `
    + `${r.spread.toFixed(1).padStart(7)}   ${String(r.rose).padStart(2)}/12  ${(r.neutralGain >= 0 ? '+' : '') + r.neutralGain.toFixed(3)}   `
    + `${r.bandLo.toFixed(1)}->${r.bandHi.toFixed(1)}  +${r.minStep.toFixed(2)}`);
}
console.log('fog wash contract OK (%d profiles)', report.length);
