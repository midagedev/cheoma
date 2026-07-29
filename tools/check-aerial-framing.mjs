// Pure aerial framing contract (A1 mobile portrait bleach).
// Product explore pose must keep the village at ~65–75% of the long viewport axis
// on both landscape and portrait. Desktop aspect ≥ 1 must match the historical solve.
import assert from 'node:assert/strict';
import {
  VILLAGE_AERIAL_FRAME_TAN_HALF,
  VILLAGE_AERIAL_LANDSCAPE_FILL,
  VILLAGE_AERIAL_PORTRAIT_FILL,
  VILLAGE_LENS,
  dollyDistanceForFov,
  villageAerialDiameterFills,
  villageAerialDistance,
  villageAerialReferenceDistance,
} from '../src/camera/optics.js';

const EPS = 1e-9;
const FILL_MIN = 0.60;
const FILL_MAX = 0.80;
const RADIUS = 120; // any positive radius; fills are scale-free

/** Historical pre-A1 solve — width-fit including aspect < 1. Portrait over-distances. */
function legacyReferenceDistance(radius, aspect) {
  const fill = aspect >= 1 ? VILLAGE_AERIAL_LANDSCAPE_FILL : VILLAGE_AERIAL_PORTRAIT_FILL;
  return radius / (VILLAGE_AERIAL_FRAME_TAN_HALF * fill * aspect);
}

function assertFillInBand(label, fills) {
  assert.ok(
    fills.longAxis >= FILL_MIN - EPS && fills.longAxis <= FILL_MAX + EPS,
    `${label} long-axis village fill must sit in [${FILL_MIN}, ${FILL_MAX}] `
      + `(got ${fills.longAxis.toFixed(4)}; h=${fills.horizontal.toFixed(4)} v=${fills.vertical.toFixed(4)})`,
  );
}

// --- Legacy portrait must fail the band (proves the gate catches the A1 bug) ---
{
  const aspect = 0.46; // 390×844
  const legacyD = legacyReferenceDistance(RADIUS, aspect);
  const legacyFills = villageAerialDiameterFills(RADIUS, aspect, legacyD);
  assert.ok(
    legacyFills.longAxis < FILL_MIN,
    `pre-fix portrait long-axis fill must fail the band (got ${legacyFills.longAxis.toFixed(4)})`,
  );
  // Documented bleach ratio: ~32% of frame height on 390×844.
  assert.ok(
    legacyFills.vertical > 0.30 && legacyFills.vertical < 0.35,
    `legacy portrait vertical fill is the known ~0.32 bleach case (got ${legacyFills.vertical.toFixed(4)})`,
  );
}

// --- Product solve: portrait + landscape both in band ---
const CASES = [
  { label: 'portrait 390×844', aspect: 390 / 844 },
  { label: 'portrait 0.46', aspect: 0.46 },
  { label: 'desktop 1.6', aspect: 1.6 },
  { label: 'desktop 16:9', aspect: 16 / 9 },
  { label: 'square', aspect: 1 },
];

for (const { label, aspect } of CASES) {
  const referenceDistance = villageAerialReferenceDistance(RADIUS, aspect);
  const fills = villageAerialDiameterFills(RADIUS, aspect, referenceDistance);
  assertFillInBand(label, fills);

  // Compensated 46° product distance preserves projected scale vs reference FOV.
  const productDistance = villageAerialDistance(RADIUS, aspect);
  const expectedProduct = dollyDistanceForFov(
    referenceDistance,
    VILLAGE_LENS.aerial.referenceFov,
    VILLAGE_LENS.aerial.fov,
  );
  assert.ok(
    Math.abs(productDistance - expectedProduct) < 1e-9,
    `${label} product aerial distance must match reference→46° dolly`,
  );
}

// --- Desktop regression: aspect ≥ 1 is identical to the historical formula ---
for (const aspect of [1, 1.25, 1.6, 16 / 9, 1.78, 2]) {
  const product = villageAerialReferenceDistance(RADIUS, aspect);
  const legacy = legacyReferenceDistance(RADIUS, aspect);
  assert.ok(
    Math.abs(product - legacy) < 1e-12,
    `desktop aspect ${aspect} reference distance must be unchanged `
      + `(product=${product}, legacy=${legacy})`,
  );
  assert.ok(
    Math.abs(product - RADIUS / (VILLAGE_AERIAL_FRAME_TAN_HALF * VILLAGE_AERIAL_LANDSCAPE_FILL * aspect))
      < 1e-12,
    `desktop aspect ${aspect} must keep landscape fill ${VILLAGE_AERIAL_LANDSCAPE_FILL}`,
  );
}

// --- Portrait distance is strictly closer than the legacy width-fit ---
{
  const aspect = 0.46;
  const product = villageAerialReferenceDistance(RADIUS, aspect);
  const legacy = legacyReferenceDistance(RADIUS, aspect);
  assert.ok(product < legacy * 0.6,
    `portrait distance must drop substantially vs width-fit over-correction `
      + `(product=${product.toFixed(2)}, legacy=${legacy.toFixed(2)})`);
  // Vertical long-axis fill is the authored portrait fill.
  const fills = villageAerialDiameterFills(RADIUS, aspect, product);
  assert.ok(
    Math.abs(fills.vertical - VILLAGE_AERIAL_PORTRAIT_FILL) < 1e-12,
    `portrait vertical fill must equal authored ${VILLAGE_AERIAL_PORTRAIT_FILL}`,
  );
  assert.ok(
    Math.abs(fills.longAxis - VILLAGE_AERIAL_PORTRAIT_FILL) < 1e-12,
    'portrait long-axis fill is the vertical axis',
  );
}

// --- Absolute pins: share-URL zoom snapshots normalise against this distance, so a
// fill/tanHalf drift that stays inside the band still breaks stored views. A change
// here must be deliberate (it invalidates every shared scene URL's zoom). ---
{
  const desktop = villageAerialReferenceDistance(120, 1.6);
  assert.ok(Math.abs(desktop - 312.5) < 1e-9,
    `desktop reference distance drifted: expected 312.5 (R=120, aspect 1.6), got ${desktop}`);
  const portrait = villageAerialReferenceDistance(120, 0.46);
  assert.ok(Math.abs(portrait - 3000 / 7) < 1e-9,
    `portrait reference distance drifted: expected ${(3000 / 7).toFixed(4)} (R=120, aspect 0.46), got ${portrait}`);
}

// --- Invalid inputs fail soft (finite non-negative distance, zero radius) ---
assert.equal(villageAerialReferenceDistance(0, 1.6), 0);
assert.equal(villageAerialReferenceDistance(-10, 1.6), 0);
assert.ok(Number.isFinite(villageAerialReferenceDistance(RADIUS, NaN)));
assert.ok(villageAerialReferenceDistance(RADIUS, 0) > 0);

console.log('ok - aerial framing (portrait long-axis fill + desktop identity)');
