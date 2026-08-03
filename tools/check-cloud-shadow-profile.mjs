// Pure contract for cloud ground-shadow softness (#221 / look-audit U5).
// Asserts the GLSL footprint has no hard plateau disc and that the numeric profile
// keeps a continuous radial gradient — the geometric stripe failure mode of the
// old smoothstep(0.42, 1.02) core. No WebGL, no Three.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const src = readFileSync(resolve(ROOT, 'src/env/clouds.js'), 'utf8');
const keySrc = readFileSync(resolve(ROOT, 'src/render/material-program-key.js'), 'utf8');

let failed = 0;
function ok(cond, msg) {
  if (cond) console.log(`  ok  ${msg}`);
  else { console.error(`  FAIL ${msg}`); failed++; }
}

console.log('check-cloud-shadow-profile (#221 U5)\n');

// Active GLSL only (strip block/line comments) so historical notes cannot false-fail bans.
const active = src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');
ok(!/return b\.w \* \(1\.0 - smoothstep\(0\.42,\s*1\.02,\s*t\)\)/.test(active),
  'GLSL drops hard-plateau return smoothstep(0.42→1.02)');
ok(!/\* 0\.42/.test(active) || !/csFbm\(wp \* 0\.011/.test(active),
  'GLSL drops strong ±0.21 / high-freq edge wobble');
ok(active.includes('smoothstep(0.0, 1.12, r)'), 'GLSL uses centre-peaked smoothstep(0.0, 1.12)');
ok(/a \* a/.test(active), 'GLSL squares the falloff for a soft rim');
ok(/\* 0\.16/.test(active), 'GLSL keeps mild edge breath (±0.08)');
ok(active.includes('0.40 * smoothstep(1.2, 2.45, inten)'), 'daylight cloud strength is 0.40·smoothstep');
// 2026-08-04 (#50 B): the token literal follows the GLSL body it keys. The body changed
// (deformed footprint + multiplicative union), so the assertion tracks v3. This is a version
// bump, not a relaxation — the assertion still requires an explicit token, and the shape
// contracts it now guards are asserted below.
ok(keySrc.includes("CLOUD_SHADOW: 'cloudshadow-v3'"), 'program key bumped to cloudshadow-v3');

// Numeric softness: centre peak, continuous gradient, no flat full-dark core.
const clampf = (x, a, b) => Math.min(b, Math.max(a, x));
const smoothstep = (a, b, x) => {
  const t = clampf((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
function blobShade(r) {
  const a = 1 - smoothstep(0.0, 1.12, Math.max(0, r));
  return a * a;
}

const samples = [];
for (let i = 0; i <= 20; i++) samples.push(blobShade(i / 20));
ok(samples[0] > 0.98, `centre peak ≈1 (got ${samples[0].toFixed(3)})`);
ok(samples[10] > 0.15 && samples[10] < 0.55,
  `mid-radius soft midtone (r=0.5 → ${samples[10].toFixed(3)})`);
ok(samples[20] < 0.02, `rim fully fades (r=1 → ${samples[20].toFixed(3)})`);

let monotone = true;
for (let i = 1; i < samples.length; i++) {
  if (samples[i] > samples[i - 1] + 1e-9) monotone = false;
}
ok(monotone, 'radial falloff is monotone decreasing');

// Plateau detector: old profile held shade==1 for r∈[0,0.42]. Require early drop.
const early = blobShade(0.25);
ok(early < 0.90, `no hard core plateau at r=0.25 (shade=${early.toFixed(3)} < 0.90)`);

// Old vs new hard-area comparison at a multi-blob courtyard strip.
function oldBlob(r) { return 1 - smoothstep(0.42, 1.02, r); }
let oldHard = 0, newHard = 0;
for (let x = -40; x <= 40; x += 1) {
  for (let z = -40; z <= 40; z += 1) {
    const d0 = Math.hypot(x, z) / 40;
    const d1 = Math.hypot(x - 35, z - 8) / 40;
    const o = Math.min(1, 0.9 * oldBlob(d0) + 0.85 * oldBlob(d1));
    const n = Math.min(1, 0.9 * blobShade(d0) + 0.85 * blobShade(d1));
    if (o > 0.85) oldHard++;
    if (n > 0.85) newHard++;
  }
}
ok(newHard < oldHard * 0.75,
  `hard shade area shrinks (${newHard} < 0.75·${oldHard}=${(oldHard * 0.75).toFixed(0)})`);

// ── Footprint SHAPE (#50 B, 2026-08-04) ────────────────────────────────────────────────────
// The section above pins the radial *profile*; it cannot see that the footprint was a circle.
// P1' (2026-08-01) read the dawn hillside shade as "a soft square plate", and that came from
// shape, not falloff: five circles, additively summed and clamped at 1.0, form one saturated
// slab with a soft outline. These assertions pin the two things that fixed it — a deformed
// per-slot footprint, and a union that cannot saturate. They are written against a JS mirror of
// the GLSL (float64 vs float32, so macroscopic shape only) and every one of them fails on the
// pre-#50-B source: the circle has zero radial variation, all slots share one outline, and the
// additive union plateaus. Source-level guards below keep the mirror honest.
ok(/vec2 q = vec2\(dot\(d, ex\) \* 1\.28, dot\(d, ey\) \* 0\.80\)/.test(active),
  'GLSL measures distance in an elongated per-slot basis (1.28 × 0.80)');
ok(/float ang = 6\.2831853 \* csHash\(vec2\(slot/.test(active),
  'GLSL derives the slot basis from the unroll index, not from the drifting blob centre');
ok(!/csHash\(floor\(b\.xy/.test(active), 'GLSL never hashes the blob centre (would pop on drift)');
ok(/1\.0\s*\n?\s*- \(1\.0 - cloudBlob/.test(active) && !/shade \+= cloudBlob/.test(active),
  'GLSL unions blobs multiplicatively (no additive saturation)');

const fract = (x) => x - Math.floor(x);
function csHash(px, py) {
  let x = fract(px * 123.34), y = fract(py * 345.45);
  const s = x * (x + 34.345) + y * (y + 34.345);
  x += s; y += s;
  return fract(x * y);
}
function csNoise(px, py) {
  const ix = Math.floor(px), iy = Math.floor(py);
  const fx = px - ix, fy = py - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = csHash(ix, iy), b = csHash(ix + 1, iy);
  const c = csHash(ix, iy + 1), d = csHash(ix + 1, iy + 1);
  const top = a + (b - a) * ux, bot = c + (d - c) * ux;
  return top + (bot - top) * uy;
}
// Shared warp vectors — CLOUD_SHADOW_FRAG_BODY samples these once per fragment (uCloudTime 0).
function warp(wx, wz) {
  return {
    w1: [csNoise(wx * 0.0094, wz * 0.0094) - 0.5, csNoise(wx * 0.0094 + 37.19, wz * 0.0094 + 37.19) - 0.5],
    w2: [csNoise(wx * 0.0295, wz * 0.0295) - 0.5, csNoise(wx * 0.0295 + 11.73, wz * 0.0295 + 11.73) - 0.5],
  };
}
// wob is deliberately 0 here: the shared fbm breath existed before and after, so leaving it in
// would let the OLD circle score as non-circular and the assertion would not be FAIL-first.
function newBlob(bx, bz, br, bw, wx, wz, slot) {
  const dx = (wx - bx) / br, dz = (wz - bz) / br;
  const ang = 6.2831853 * csHash(slot * 13.7 + 3.1, slot * 7.3 + 1.9);
  const ex = [Math.cos(ang), Math.sin(ang)], ey = [-ex[1], ex[0]];
  const qx0 = (dx * ex[0] + dz * ex[1]) * 1.28;
  const qz0 = (dx * ey[0] + dz * ey[1]) * 0.80;
  const lobe = smoothstep(0.14, 0.55, Math.hypot(qx0, qz0));
  const { w1, w2 } = warp(wx, wz);
  const qx = qx0 + lobe * (0.10 * Math.sin(qz0 * 2.7 + slot * 2.1)
    + (w1[0] * ex[0] + w1[1] * ex[1]) * 0.29 + (w2[0] * ex[0] + w2[1] * ex[1]) * 0.12);
  const qz = qz0 + lobe * (0.10 * Math.sin(qx0 * 3.1 + slot * 4.7)
    + (w1[0] * ey[0] + w1[1] * ey[1]) * 0.29 + (w2[0] * ey[0] + w2[1] * ey[1]) * 0.12);
  const a = 1 - smoothstep(0.0, 1.12, Math.max(0, Math.hypot(qx, qz)));
  return bw * a * a;
}

// Iso-contour radius over 180 directions. Two levels matter and they answer different questions:
//   ISO_EDGE 0.10 (≈4% darkening at uCloudStr 0.40) is where the silhouette is *read* — this is
//   the level the "square plate" verdict was about. ISO_CORE 0.50 is the dark centre, which must
//   stay one coherent form; an over-strong warp punches holes there (the first attempt measured
//   CV 1.02 at this level, which is a shadow full of holes, not a cloud).
const ISO_EDGE = 0.10, ISO_CORE = 0.50;
function contour(bx, bz, br, slot, level) {
  const radii = [];
  for (let i = 0; i < 180; i++) {
    const th = (i / 180) * Math.PI * 2;
    let lo = 0, hi = 2.6 * br;
    for (let it = 0; it < 40; it++) {
      const mid = (lo + hi) * 0.5;
      const s = newBlob(bx, bz, br, 1, bx + Math.cos(th) * mid, bz + Math.sin(th) * mid, slot);
      if (s > level) lo = mid; else hi = mid;
    }
    radii.push((lo + hi) * 0.5);
  }
  const mean = radii.reduce((a, b) => a + b, 0) / radii.length;
  const varc = radii.reduce((a, b) => a + (b - mean) ** 2, 0) / radii.length;
  return { radii, mean, cv: Math.sqrt(varc) / mean };
}
// ① Silhouette is not a circle (a circle scores exactly 0 — the pre-#50-B footprint).
const e0 = contour(0, 0, 65, 0, ISO_EDGE);
ok(e0.cv > 0.06, `silhouette is not a circle (iso-0.10 radial CV=${e0.cv.toFixed(4)} > 0.06)`);
// ② …and the core survives it as one form.
const k0 = contour(0, 0, 65, 0, ISO_CORE);
ok(k0.cv < 0.35 && k0.mean > 0.10 * 65,
  `dark core stays coherent (iso-0.50 CV=${k0.cv.toFixed(4)} < 0.35, mean r=${k0.mean.toFixed(1)}m)`);
// ③ Slots do not share one outline — otherwise an overlapping group still reads as one form.
const e3 = contour(0, 0, 65, 3, ISO_EDGE);
let maxSlotDiff = 0;
for (let i = 0; i < e0.radii.length; i++) {
  maxSlotDiff = Math.max(maxSlotDiff, Math.abs(e0.radii[i] - e3.radii[i]) / e0.mean);
}
ok(maxSlotDiff > 0.10,
  `slot 0 and slot 3 deform differently (max radial diff=${(maxSlotDiff * 100).toFixed(1)}% > 10%)`);

// ④ The overlapping lane group's silhouette is not a plate. Isoperimetric ratio 4πA/P² of the
//    perceptible region: a disc scores 1.00, a square 0.785. A union of plain discs stays high
//    because its outline is made of circular arcs; a lobed outline spends perimeter and drops.
const LANE = [[-52, -18, 62], [10, 6, 68], [64, 26, 58], [118, -6, 64]];
function unionNew(x, z) {
  let k = 1;
  for (let i = 0; i < LANE.length; i++) k *= 1 - newBlob(LANE[i][0], LANE[i][1], LANE[i][2], 0.92, x, z, i);
  return 1 - k;
}
function unionOld(x, z) {
  let s = 0;
  for (const [bx, bz, br] of LANE) s += 0.92 * blobShade(Math.hypot(x - bx, z - bz) / br);
  return Math.min(1, s);
}
// Marching-squares-free measure: area = cell count, perimeter = boundary edges between an
// inside and an outside cell, both at the same 1 m sampling, so the ratio is comparable.
function isoperimetric(f) {
  const X0 = -190, X1 = 260, Z0 = -160, Z1 = 180, STEP = 1;
  const nx = (X1 - X0) / STEP + 1, nz = (Z1 - Z0) / STEP + 1;
  const inside = new Uint8Array(nx * nz);
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) inside[i * nz + j] = f(X0 + i * STEP, Z0 + j * STEP) >= ISO_EDGE ? 1 : 0;
  }
  let area = 0, per = 0;
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) {
      if (!inside[i * nz + j]) continue;
      area += STEP * STEP;
      if (i === 0 || !inside[(i - 1) * nz + j]) per += STEP;
      if (i === nx - 1 || !inside[(i + 1) * nz + j]) per += STEP;
      if (j === 0 || !inside[i * nz + j - 1]) per += STEP;
      if (j === nz - 1 || !inside[i * nz + j + 1]) per += STEP;
    }
  }
  return { area, per, ratio: per > 0 ? 4 * Math.PI * area / (per * per) : 0 };
}
const ipOld = isoperimetric(unionOld);
const ipNew = isoperimetric(unionNew);
ok(ipNew.ratio < ipOld.ratio * 0.90,
  `group silhouette is lobed, not a plate (4πA/P² ${ipNew.ratio.toFixed(3)} < 0.90·${ipOld.ratio.toFixed(3)}`
  + `=${(ipOld.ratio * 0.90).toFixed(3)})`);

// ④ The domain warp must not fold. A non-injective warp creases the field and would read as a
//    hard seam crossing the terrain — the failure mode this deformation could introduce.
let maxJump = 0;
for (let x = -140; x <= 210; x += 1) {
  for (let z = -110; z <= 130; z += 1) {
    maxJump = Math.max(maxJump, Math.abs(unionNew(x, z) - unionNew(x + 1, z)),
      Math.abs(unionNew(x, z) - unionNew(x, z + 1)));
  }
}
// Threshold 0.12, not 0.05: the field's own gradient across a ~30 m falloff is already ≈0.045 per
// metre, so 0.05 would be pinning the natural slope and would flake on any radius change. A fold
// produces a step of order 0.3 — that is what this assertion is for.
ok(maxJump < 0.12, `warped field stays continuous (max 1m step=${maxJump.toFixed(4)} < 0.12)`);

if (failed) {
  console.error(`\n${failed} failure(s)`);
  process.exit(1);
}
console.log('\nPASS');
