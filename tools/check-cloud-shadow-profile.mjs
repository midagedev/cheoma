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
ok(keySrc.includes("CLOUD_SHADOW: 'cloudshadow-v2'"), 'program key bumped to cloudshadow-v2');

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

if (failed) {
  console.error(`\n${failed} failure(s)`);
  process.exit(1);
}
console.log('\nPASS');
