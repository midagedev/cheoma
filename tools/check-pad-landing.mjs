// Pure pad / skirt / gate-landing coherence contract (#150 F).
//
// Asserts that residential 성토 shelves, their outer stone skirt (축대), solid
// wall feet, and level gate landings share one datum (padY) without a second
// material family or multi-tier residential apron. THREE / DOM / browser free.
import assert from 'node:assert/strict';
import { planVillage } from '../src/api/village-plan.js';
import { COURTYARD_SURFACE_LIFT, FOUNDATION_SINK } from '../src/core/surface-clearance.js';
import { makeRng } from '../src/rng.js';
import {
  PAD_LANDING_SCHEMA_VERSION,
  VILLAGE_PAD,
  computePadY,
  padWallLandingViolations,
  planParcelPadLanding,
  planPadSkirtSegments,
} from '../src/village/pad-landing-plan.js';
import {
  VILLAGE_WALL_STEP,
  villageWallLayout,
} from '../src/village/wall-contract.js';
import {
  rectangularParcelShape,
} from '../src/village/parcel-contract.js';
import { terrainRangeOnPolygon } from '../src/village/placement-search.js';

const EPSILON = 1e-8;

// ── Constant lock: pad lift/sink cannot drift from shared surface/wall sinks ──
assert.equal(VILLAGE_PAD.lift, COURTYARD_SURFACE_LIFT,
  'pad lift must equal COURTYARD_SURFACE_LIFT');
assert.equal(VILLAGE_PAD.sink, FOUNDATION_SINK,
  'pad sink must equal FOUNDATION_SINK');
assert.equal(VILLAGE_PAD.sink, VILLAGE_WALL_STEP.terrainSink,
  'pad sink must equal wall terrainSink so feet and skirts meet grade the same way');
assert.equal(VILLAGE_PAD.maxChukdaeCourses, 1,
  'residential pads may plan at most one downhill 축대 course');

// ── Synthetic slope fixture: known padY, skirt, wall foot, gate landing ──
const shape = rectangularParcelShape(16, 12);
const fixtureParcel = {
  id: 'pad-landing-fixture',
  kind: 'giwa',
  wallType: 'stone',
  seed: 19,
  center: { x: 0, z: 0 },
  frontDir: { x: 0, z: 1 },
  shape,
  poly: shape.pts.map((point) => ({ x: point.x, z: point.z })),
  plotW: 16,
  plotD: 12,
  sx: 1,
  sy: 1,
  sz: 1,
  access: { gateEdge: 0, gateT: 0.5 },
};
const slopeSite = {
  R: 64,
  terrainR: 64,
  heightAt(x, z) { return x * 0.09 + z * 0.015; },
};
const flatSite = {
  R: 64,
  terrainR: 64,
  heightAt() { return 0; },
};

const expectedPadY = terrainRangeOnPolygon(slopeSite, fixtureParcel.poly, 5).max + VILLAGE_PAD.lift;
assert.equal(computePadY(fixtureParcel, slopeSite), expectedPadY,
  'computePadY must be terrain max + lift');

const slopePlan = planParcelPadLanding(fixtureParcel, slopeSite);
assert.equal(slopePlan.schema, PAD_LANDING_SCHEMA_VERSION);
assert.equal(slopePlan.padY, expectedPadY);
assert(Object.isFrozen(slopePlan) && Object.isFrozen(slopePlan.skirt),
  'pad landing plan must be deeply frozen');
assert.deepEqual(
  JSON.parse(JSON.stringify(slopePlan)),
  JSON.parse(JSON.stringify(planParcelPadLanding(fixtureParcel, slopeSite))),
  'pad landing plan must be JSON-safe and deterministic',
);
assert(slopePlan.skirt.length > 0, 'sloped fixture must emit skirt segments');
assert(slopePlan.skirt.every((segment) => Math.abs(segment.topY - slopePlan.padY) <= EPSILON),
  'every skirt top must sit on padY');
assert(slopePlan.chukdae, 'sloped fixture must plan one downhill 축대 course');
assert.equal(slopePlan.chukdae.courseCount, 1);
assert.equal(slopePlan.chukdae.materialRole, VILLAGE_PAD.materialRole);
assert.equal(slopePlan.chukdae.topY, slopePlan.padY);
assert.equal(slopePlan.materialRole, VILLAGE_PAD.materialRole);

// Flat shelf: no retaining course, empty skirt.
const flatPlan = planParcelPadLanding(fixtureParcel, flatSite);
assert.equal(flatPlan.padY, VILLAGE_PAD.lift);
assert.equal(flatPlan.skirt.length, 0, 'flat pad must omit zero-rise skirt');
assert.equal(flatPlan.chukdae, null, 'flat pad must not invent a 축대 course');

// Pure skirt plan matches the numbers emitPad will tessellate.
const directSkirt = planPadSkirtSegments(fixtureParcel.poly, expectedPadY, slopeSite);
assert.equal(directSkirt.length, slopePlan.skirt.length);
assert.deepEqual(
  directSkirt.map((segment) => segment.height),
  slopePlan.skirt.map((segment) => segment.height),
);

// Wall layout against the same padY: gate landing flat at pad height, foot within maxDrop.
const wallLayout = villageWallLayout(shape, {
  style: 'stone',
  char01: 0.5,
  wallHeightK: 1,
  plotW: fixtureParcel.plotW,
  plotD: fixtureParcel.plotD,
  gateEdge: fixtureParcel.access.gateEdge,
  gateT: fixtureParcel.access.gateT,
  parcel: fixtureParcel,
  site: slopeSite,
  baseY: slopePlan.padY,
}, () => 0.5);
assert(wallLayout.edgeLayouts.some((edge) => edge.runs.some((run) =>
  (run.bottomOffset || 0) !== 0 || (run.topOffset || 0) !== 0)),
'fixture slope must produce stepped solid wall runs');
const fixtureViolations = padWallLandingViolations(slopePlan, wallLayout);
assert.deepEqual(fixtureViolations, [],
  `fixture pad/wall coherence failed: ${fixtureViolations.join('; ')}`);

// Flat wall + flat pad: still coherent, no false 축대 demand.
const flatWall = villageWallLayout(shape, {
  style: 'stone',
  char01: 0.5,
  wallHeightK: 1,
  plotW: fixtureParcel.plotW,
  plotD: fixtureParcel.plotD,
  gateEdge: fixtureParcel.access.gateEdge,
  gateT: fixtureParcel.access.gateT,
  parcel: fixtureParcel,
  site: flatSite,
  baseY: flatPlan.padY,
}, () => 0.5);
assert.deepEqual(padWallLandingViolations(flatPlan, flatWall), [],
  'flat pad/wall must remain coherent without a 축대');

// Negative: a wall foot deeper than maxDrop must fail closed.
const forged = {
  ...wallLayout,
  edgeLayouts: wallLayout.edgeLayouts.map((edge) => ({
    ...edge,
    runs: edge.runs.map((run) => ({ ...run, bottomOffset: -VILLAGE_WALL_STEP.maxDrop - 0.5 })),
  })),
};
const forgedViolations = padWallLandingViolations(slopePlan, forged);
assert(forgedViolations.some((message) => /maxDrop/.test(message)),
  'wall foot beyond maxDrop must be reported');

// Negative: multi-course residential 축대 is rejected.
const multiCourse = {
  ...slopePlan,
  chukdae: { ...slopePlan.chukdae, courseCount: 2 },
};
assert(padWallLandingViolations(multiCourse, wallLayout).some((message) => /courses/.test(message)),
  'multi-course residential 축대 must fail');

// ── Real plans: padY, skirt, wall foot, gateLanding share one shelf ──
let solidParcels = 0;
let steppedParcels = 0;
let chukdaeParcels = 0;
let maxSkirt = 0;
let maxFootDrop = 0;

for (const scale of ['hamlet', 'village', 'town', 'capital', 'hanyang']) {
  const plan = planVillage({ scale, seed: 1 });
  let scaleStepped = 0;
  for (const parcel of plan.parcels) {
    if (!parcel.poly || parcel.hero) continue;
    const padPlan = planParcelPadLanding(
      { ...parcel, baseY: undefined, padY: undefined },
      plan.site,
    );
    // Authoritative padY equals the populate computePadY path.
    assert.equal(padPlan.padY, computePadY(parcel, plan.site),
      `${scale}:${parcel.id}: padY drifted from computePadY`);
    assert.equal(
      padPlan.padY,
      terrainRangeOnPolygon(plan.site, parcel.poly, 5).max + VILLAGE_PAD.lift,
      `${scale}:${parcel.id}: padY is not terrain max + lift`,
    );
    if (padPlan.chukdae) {
      chukdaeParcels++;
      assert.equal(padPlan.chukdae.courseCount, 1,
        `${scale}:${parcel.id}: more than one 축대 course`);
      assert.equal(padPlan.chukdae.materialRole, VILLAGE_PAD.materialRole,
        `${scale}:${parcel.id}: 축대 material role drifted`);
    }
    for (const segment of padPlan.skirt) {
      maxSkirt = Math.max(maxSkirt, segment.height);
      assert(segment.topY === padPlan.padY, `${scale}:${parcel.id}: skirt top ≠ padY`);
      assert(segment.bottom0 <= padPlan.padY + EPSILON
        && segment.bottom1 <= padPlan.padY + EPSILON,
      `${scale}:${parcel.id}: skirt bottom above padY`);
    }

    const style = parcel.wallType || 'stone';
    if (!['tile', 'stone', 'mud'].includes(style)) continue;
    solidParcels++;
    const baseY = padPlan.padY;
    const layout = villageWallLayout(parcel.shape, {
      style,
      char01: plan.opts.char01,
      wallHeightK: parcel.wallHeightK,
      plotW: parcel.plotW,
      plotD: parcel.plotD,
      gateEdge: parcel.access?.gateEdge,
      gateT: parcel.access?.gateT,
      parcel,
      site: plan.site,
      baseY,
    }, makeRng((((parcel.seed | 0) || 7) ^ 0x51de) >>> 0));

    let parcelStepped = false;
    for (const edge of layout.edgeLayouts) {
      for (const run of edge.runs) {
        const bottom = run.bottomOffset || 0;
        const top = run.topOffset || 0;
        if (bottom !== 0 || top !== 0) parcelStepped = true;
        maxFootDrop = Math.max(maxFootDrop, -Math.min(0, bottom));
        assert(bottom <= EPSILON,
          `${scale}:${parcel.id}: wall foot rose above padY`);
        assert(bottom >= -VILLAGE_WALL_STEP.maxDrop - EPSILON,
          `${scale}:${parcel.id}: wall foot exceeded maxDrop`);
      }
    }
    if (parcelStepped) {
      steppedParcels++;
      scaleStepped++;
    }

    const violations = padWallLandingViolations(padPlan, layout);
    assert.deepEqual(violations, [],
      `${scale}:${parcel.id}: ${violations.join('; ')}`);
  }
  // At least one stepped solid wall per representative scale keeps the wall
  // step contract live; pad landing must not force every edge flat.
  assert(scaleStepped > 0, `${scale}: no stepped solid wall under pad-landing baseY`);
}

assert(solidParcels > 0, 'no solid-wall parcels sampled');
assert(steppedParcels > 0, 'no stepped walls sampled');
assert(chukdaeParcels > 0, 'no 축대 courses planned on real slope parcels');
assert(maxFootDrop <= VILLAGE_WALL_STEP.maxDrop + EPSILON,
  `observed wall foot drop ${maxFootDrop} exceeds maxDrop`);
// Skirt may exceed wall maxDrop: the continuous 축대 covers residual fill the
// wall body is not allowed to chase (see VILLAGE_WALL_STEP.maxDrop).
assert(maxSkirt + EPSILON >= Math.min(maxFootDrop, VILLAGE_PAD.chukdaeTrigger),
  'skirt never covered a real wall foot drop');

console.log(
  `PAD LANDING CONTRACT: PASS (schema v${PAD_LANDING_SCHEMA_VERSION}, `
  + `${solidParcels} solid / ${steppedParcels} stepped / ${chukdaeParcels} 축대, `
  + `max skirt ${maxSkirt.toFixed(2)}m, max foot ${maxFootDrop.toFixed(2)}m, `
  + `gateLanding ${VILLAGE_WALL_STEP.gateLanding}m @ padY, stone role shared)`,
);
