// Pure seasonal ground carpet / litter contract (#219 / look-audit U4).
//   node tools/check-season-ground-contract.mjs
//
// Asserts placement density, physical clump sizes, draw budget (no Points),
// spring+autumn activation, and deterministic seed behaviour. Rendering and
// product cameras are left to seasons.html / shoot:seasons / check:petals.

import assert from 'node:assert/strict';
import {
  SEASON_GROUND_BUDGET,
  makeSeasonGroundRng,
  planEnvLitterSpots,
  planFocusLitterSpots,
  seasonGroundCarpetActive,
  seasonGroundCarpetGoal,
  seasonGroundPalette,
} from '../src/env/season-ground-plan.js';

const B = SEASON_GROUND_BUDGET;

// ── Budget documentation contract ──────────────────────────────────────────
assert.equal(B.draws, 1, 'carpet must stay one InstancedMesh draw');
assert.equal(B.points, 0, 'FAR Points replicas are banned');
assert.ok(B.maxInstances > 0 && B.maxInstances <= 512);
assert.ok(B.minClumpM >= 0.3 && B.maxClumpM <= 1.5);
assert.ok(B.maxClumpM > B.minClumpM);
assert.ok(B.focusMaxInstances <= B.maxInstances);

// ── Season goals ───────────────────────────────────────────────────────────
for (const season of ['spring', 'autumn']) {
  assert.equal(seasonGroundCarpetActive(season), true);
  assert.equal(seasonGroundCarpetGoal(season), 1);
}
for (const season of ['summer', 'winter', 'unknown', null]) {
  assert.equal(seasonGroundCarpetActive(season), false);
  assert.equal(seasonGroundCarpetGoal(season), 0);
}

// ── Palettes ───────────────────────────────────────────────────────────────
const springPal = seasonGroundPalette('spring');
const autumnPal = seasonGroundPalette('autumn');
assert.equal(springPal.season, 'spring');
assert.equal(autumnPal.season, 'autumn');
assert.ok(springPal.frames.every((f) => f === 0 || f === 1), 'spring is petal-led');
assert.ok(springPal.frames.filter((f) => f === 0).length >= 4, 'spring mostly petals');
assert.ok(autumnPal.frames.some((f) => f === 1) && autumnPal.frames.some((f) => f === 2));
assert.ok(springPal.colors.length >= 4 && autumnPal.colors.length >= 8);

// ── Env litter spots (near trees + yard corners) ───────────────────────────
const bases = [];
for (let i = 0; i < 80; i++) {
  const a = i * 0.37;
  bases.push({
    x: Math.cos(a) * (8 + i * 0.9),
    y: 0.2,
    z: Math.sin(a) * (8 + i * 0.9),
    r: 1.2 + (i % 5) * 0.15,
  });
}
// Near-first order as seasons.js sorts.
bases.sort((a, b) => (a.x * a.x + a.z * a.z) - (b.x * b.x + b.z * b.z));

const envA = planEnvLitterSpots({
  bases,
  layout: { xEave: 9, zEave: 6 },
  seed: 0x1234abcd,
});
const envB = planEnvLitterSpots({
  bases,
  layout: { xEave: 9, zEave: 6 },
  seed: 0x1234abcd,
});
assert.equal(envA.length, envB.length, 'env litter must be deterministic');
assert.deepEqual(
  envA.map((s) => [s.x, s.y, s.z, s.size, s.rev]),
  envB.map((s) => [s.x, s.y, s.z, s.size, s.rev]),
);

assert.ok(envA.length > 0, 'env litter produces spots when trees exist');
assert.ok(envA.length <= B.maxInstances, `env litter ${envA.length} exceeds maxInstances`);
// Near-focus density floor: denser than the pre-#219 sparse piles (~200), but
// not a full-yard carpet (cap 420). With 64 trees × 6–10 + corners this lands mid-band.
assert.ok(envA.length >= 200, `env litter too sparse for near-focus season read: ${envA.length}`);
assert.ok(envA.length >= B.nearTreeCap * B.treeSpotsMin * 0.5, 'tree piles under-produced');

let treeSpots = 0, yardSpots = 0;
for (const s of envA) {
  assert.ok(Number.isFinite(s.x) && Number.isFinite(s.z));
  assert.ok(s.size >= B.minClumpM - 1e-9 && s.size <= B.maxClumpM + 1e-9,
    `clump size ${s.size} outside physical pile band`);
  assert.ok(s.rev >= 0 && s.rev <= 1);
  if (s.kind === 'tree') treeSpots++;
  if (s.kind === 'yard') yardSpots++;
}
assert.ok(treeSpots > 0 && yardSpots > 0, 'need both tree-base and yard-corner piles');

// Empty bases still get yard corners (house-only site).
const envCornersOnly = planEnvLitterSpots({ bases: [], layout: { xEave: 9, zEave: 6 } });
assert.ok(envCornersOnly.length > 0, 'yard corners remain without trees');
assert.ok(envCornersOnly.every((s) => s.kind === 'yard'));

// ── Focus parcel carpet ────────────────────────────────────────────────────
const focusA = planFocusLitterSpots({ W: 14, D: 12, gateW: 2.4, seed: 0x7c11 });
const focusB = planFocusLitterSpots({ W: 14, D: 12, gateW: 2.4, seed: 0x7c11 });
assert.deepEqual(
  focusA.map((s) => [s.x, s.z, s.size]),
  focusB.map((s) => [s.x, s.z, s.size]),
  'focus litter must be deterministic',
);
assert.ok(focusA.length > 0);
assert.ok(focusA.length <= B.focusMaxInstances);
// Sparse wall-skirt + corners — not a filled parcel carpet.
assert.ok(focusA.length <= 160, `focus carpet too dense (full-parcel risk): ${focusA.length}`);
assert.ok(focusA.length >= 40, `focus carpet too sparse: ${focusA.length}`);

const halfW = 7, halfD = 6;
for (const s of focusA) {
  assert.ok(Math.abs(s.x) <= halfW + 0.5, 'focus spot escaped parcel width');
  assert.ok(Math.abs(s.z) <= halfD + 0.5, 'focus spot escaped parcel depth');
  assert.ok(s.size >= B.minClumpM && s.size <= B.maxClumpM);
}

// Gate opening on south wall should not be packed solid with piles.
const gateHalf = 2.4 * 0.55;
const southGateHits = focusA.filter(
  (s) => s.z > halfD * 0.55 && Math.abs(s.x) < gateHalf * 0.85,
).length;
assert.ok(southGateHits < focusA.length * 0.15, 'gate approach should stay relatively clear');

// ── Seeded RNG stability ───────────────────────────────────────────────────
const r1 = makeSeasonGroundRng(42);
const r2 = makeSeasonGroundRng(42);
for (let i = 0; i < 32; i++) assert.equal(r1(), r2());

// Negative control: a full-parcel carpet density would exceed focus budget.
// 14×12m at 0.6m grid ≈ 460 spots — must not be our plan.
const gridWouldBe = Math.floor(14 / 0.6) * Math.floor(12 / 0.6);
assert.ok(focusA.length * 2 < gridWouldBe, 'plan must stay well below full-grid carpet density');

console.log(
  `season-ground: PASS env=${envA.length} focus=${focusA.length} `
  + `budget draws=${B.draws} points=${B.points} maxInst=${B.maxInstances}`,
);
