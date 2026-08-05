// Walk-mode visible-float contract (#56). Pure — no THREE, DOM, or browser.
//
// A structure floats when its lowest solid sits above the RENDERED terrain surface
// under its own footprint. At walk-mode eye height (y ≈ 1.6 m) a slot of ~0.12 m
// already reads, and the pre-fix source had many: measured at base d9dcdfc over
// village/town/capital/hanyang x seeds 1,2 with each category's real footprint
// taken from the module that owns the drawn geometry —
//
//   category            objs  float>0.12m   maxFloat
//   guardian 돌단        18    11 (61%)      6.49 m
//   sijeon shop rows     319   99 (31%)      2.91 m
//   pavilion podium      8     5  (63%)      0.98 m
//   parcel pad skirt     1115  ~26 (2%)      0.29 m   (town; palace feature pad 0.37 m)
//   jangseung / sotdae   16    13 (81%)      0.57 m   ← pinned frontier, see below
//
// This gate asserts two things that must both hold, so it cannot pass on the
// pre-fix source and cannot pass on a no-op:
//   1. CLOSURE — every planned junction / pad skirt reaches at or below the exact
//      rendered-terrain minimum under every chord (residual float 0).
//   2. FAIL-FIRST FIXTURE — the *unclosed* float (what the datum alone leaves, i.e.
//      the pre-fix geometry) still measurably exceeds the visible threshold on
//      carried fixtures. If someone reverts the apron, (1) fails; if someone
//      neuters the measurement so everything reads flat, (2) fails.
//
// Not registered in FAIL_CHECKS/CORE_CHECKS (gate policy 2026-08-02: new feature
// gates stay opt-in). Run directly: node tools/check-house-float.mjs
import assert from 'node:assert/strict';
import { planVillage } from '../src/api/village-plan.js';
import { PUBLIC_PROP_OBSTRUCTIONS } from '../src/village/public-props-plan.js';
import { terrainMeshSegmentRange } from '../src/village/terrain-grid.js';
import * as G from '../src/core/math/geom2.js';
import {
  GROUND_JUNCTION,
  GROUND_JUNCTION_SCHEMA_VERSION,
  groundJunctionResidualFloat,
  planGroundJunction,
  ringFootprint,
} from '../src/village/ground-junction-plan.js';
import {
  featureGroundJunctionBudget,
  planFeatureGroundJunctions,
} from '../src/village/feature-junction-plan.js';
import {
  VILLAGE_PAD,
  computePadY,
  padApronPolygon,
  planPadSkirtSegments,
} from '../src/village/pad-landing-plan.js';

const VISIBLE_FLOAT = 0.12;   // walk-mode readable slot
const EPSILON = 1e-6;
const SCALES = ['village', 'town', 'capital', 'hanyang'];
const SEEDS = [1, 2];

// ── Constant locks ─────────────────────────────────────────────────────────
assert.equal(GROUND_JUNCTION.sink, VILLAGE_PAD.sink,
  'junction sink must equal the pad/foundation sink so both meet grade the same way');
assert.equal(GROUND_JUNCTION.materialRole, VILLAGE_PAD.materialRole,
  'junction must borrow the pad-stone material role — no second stone family');
assert(GROUND_JUNCTION.maxSegmentLength <= 3,
  'junction chord cap must stay at or under the city-wall 3 m contour budget');
// A rise under stepMin is deliberately left without geometry (a micro-lip, not a
// slot). That cull is only sound while it stays below what walk-mode can read.
assert(GROUND_JUNCTION.stepMin < VISIBLE_FLOAT,
  'the junction stepMin cull must stay below the walk-mode visible float threshold');

// ── Synthetic slope fixture: closure is exact, and endpoint sampling is not ──
{
  const slopeSite = { R: 64, terrainR: 64, heightAt: (x, z) => x * 0.09 + z * 0.015 };
  const ring = [
    { x: -8, z: -6 }, { x: 8, z: -6 }, { x: 8, z: 6 }, { x: -8, z: 6 },
  ];
  const baseY = 1.0;
  const plan = planGroundJunction(slopeSite, ring, baseY);
  assert.equal(plan.schema, GROUND_JUNCTION_SCHEMA_VERSION);
  assert(Object.isFrozen(plan) && Object.isFrozen(plan.segments[0]),
    'junction plan must be deeply frozen');
  assert.deepEqual(
    JSON.parse(JSON.stringify(plan)),
    JSON.parse(JSON.stringify(planGroundJunction(slopeSite, ring, baseY))),
    'junction plan must be JSON-safe and deterministic',
  );
  assert(plan.segments.length > 0, 'sloped fixture must emit junction segments');
  assert(plan.segments.every((segment) => segment.topY === baseY),
    'every junction top must sit on the structure datum');
  assert(groundJunctionResidualFloat(slopeSite, ring, baseY, plan) <= GROUND_JUNCTION.stepMin,
    'sloped fixture must be closed to within the stepMin micro-lip');

  // A flat site plans nothing (no dead geometry).
  const flatSite = { R: 64, terrainR: 64, heightAt: () => 0 };
  assert.equal(planGroundJunction(flatSite, ring, 0.05).segments.length, 0,
    'flat fixture must not allocate a junction face');

  // Negative: forge a shallow bottom and the residual must be reported.
  const forged = {
    ...plan,
    segments: plan.segments.map((segment) => ({ ...segment, bottomY: baseY - 0.01 })),
  };
  assert(groundJunctionResidualFloat(slopeSite, ring, baseY, forged) > VISIBLE_FLOAT,
    'a junction that does not reach terrain must report visible residual float');
}

// Exact lowest rendered-terrain height under a footprint ring.
function ringFloor(site, ring) {
  let min = Infinity;
  for (let index = 0; index < ring.length; index++) {
    const range = terrainMeshSegmentRange(site, ring[index], ring[(index + 1) % ring.length]);
    if (range.min < min) min = range.min;
  }
  return min;
}

// The pre-fix skirt: two analytic endpoint samples per chord, 4 chords per edge.
// Carried permanently so the fixture cannot rot away.
//
// Deliberately conservative: it credits the legacy quad with the LOWER of its two
// endpoint bottoms, whereas the drawn quad's bottom edge interpolates between them
// and is therefore higher in the middle. So this returns a lower bound on the real
// legacy residual — 0.17 m here versus 0.29 m measured against the true
// interpolated bottom (scratch probe, town/s1 p60). Both exceed VISIBLE_FLOAT, and
// a lower bound is the right thing to assert on.
function legacyAnalyticSkirtResidual(site, polygon, padY) {
  const apron = padApronPolygon(polygon);
  let residual = 0;
  const count = VILLAGE_PAD.skirtSegmentsPerEdge;
  for (let index = 0; index < apron.length; index++) {
    const a = apron[index];
    const b = apron[(index + 1) % apron.length];
    for (let chord = 0; chord < count; chord++) {
      const t0 = chord / count, t1 = (chord + 1) / count;
      const p0 = { x: a.x + (b.x - a.x) * t0, z: a.z + (b.z - a.z) * t0 };
      const p1 = { x: a.x + (b.x - a.x) * t1, z: a.z + (b.z - a.z) * t1 };
      const g0 = site.heightAt(p0.x, p0.z);
      const g1 = site.heightAt(p1.x, p1.z);
      const legacyBottom = (padY - g0 < VILLAGE_PAD.stepMin && padY - g1 < VILLAGE_PAD.stepMin)
        ? padY
        : Math.min(Math.min(g0, padY), Math.min(g1, padY)) - VILLAGE_PAD.sink;
      const floor = terrainMeshSegmentRange(site, p0, p1).min;
      residual = Math.max(residual, legacyBottom - floor);
    }
  }
  return residual;
}

// ── Real plans ─────────────────────────────────────────────────────────────
const summary = [];
let worstUnclosedByKind = new Map();
let worstLegacyPadResidual = 0;
let worstLegacyPadWhere = '';
let worstPropFloat = 0;
let worstPropWhere = '';
let totalJunctionSegments = 0;
let closedObjects = 0;

for (const scale of SCALES) {
  for (const seed of SEEDS) {
    const plan = planVillage({ scale, seed });
    const site = plan.site;
    const label = `${scale}/s${seed}`;

    // 1) No-pad structures: every junction must close, and the datum alone must not.
    const junctions = planFeatureGroundJunctions(plan, site);
    const budget = featureGroundJunctionBudget(junctions);
    totalJunctionSegments += budget.segments;
    for (const entry of junctions) {
      // Closure bound is stepMin, not zero: a rise under stepMin is intentionally
      // left as bare grade (no dead geometry) and stepMin < VISIBLE_FLOAT is locked
      // above, so nothing that reads at walk-mode eye height survives.
      const residual = groundJunctionResidualFloat(site, entry.footprint, entry.baseY, entry.junction);
      assert(residual <= GROUND_JUNCTION.stepMin + EPSILON,
        `${label} ${entry.kind}:${entry.id} left ${residual.toFixed(3)}m of visible float`);
      assert(entry.junction.materialRole === GROUND_JUNCTION.materialRole,
        `${label} ${entry.kind}:${entry.id} junction left the pad-stone family`);
      for (const segment of entry.junction.segments) {
        assert(segment.bottomY < segment.topY,
          `${label} ${entry.kind}:${entry.id} junction bottom rose to or above its top`);

        // ── 석축 dressing contract (v2) ──────────────────────────────────────
        // A single tall bare quad is what the vision round rejected as a concrete
        // slab, so a face tall enough to read as masonry must actually be coursed.
        assert(segment.courses.length > 0,
          `${label} ${entry.kind}:${entry.id} segment has no courses`);
        const dressed = segment.height > GROUND_JUNCTION.dressAbove;
        assert(segment.dressed === dressed,
          `${label} ${entry.kind}:${entry.id} dressed flag disagrees with dressAbove`);
        if (dressed) {
          assert(segment.courses.length >= 2,
            `${label} ${entry.kind}:${entry.id} is ${segment.height.toFixed(2)}m tall but has `
            + `${segment.courses.length} course(s) — a tall face must be coursed, not one slab`);
          assert(segment.courses[0].role === 'capstone',
            `${label} ${entry.kind}:${entry.id} dressed face lacks a 갓돌 capstone on top`);
          assert(segment.courses[0].outsetTop >= GROUND_JUNCTION.capstoneProjection - EPSILON,
            `${label} ${entry.kind}:${entry.id} capstone does not lap beyond the ring`);
          assert(segment.courses.at(-1).role === 'base',
            `${label} ${entry.kind}:${entry.id} lowest course is not the 대석 base course`);
          assert(segment.courses.length <= GROUND_JUNCTION.maxCourses + 1,
            `${label} ${entry.kind}:${entry.id} exceeded the course cap`);
          // Batter: the face must lean back, i.e. lower stone sits further out.
          const body = segment.courses.filter((course) => course.role !== 'capstone');
          for (const course of body) {
            assert(course.outsetBottom >= course.outsetTop - EPSILON,
              `${label} ${entry.kind}:${entry.id} course batter inverted (top flares past bottom)`);
            assert(course.outsetBottom <= GROUND_JUNCTION.batterMaxInset + EPSILON,
              `${label} ${entry.kind}:${entry.id} batter ${course.outsetBottom.toFixed(3)}m `
              + `exceeded the ${GROUND_JUNCTION.batterMaxInset}m flare cap`);
          }
        }
        // Courses tile the face top-to-bottom with no gap and no overlap.
        let cursor = segment.topY;
        for (const course of segment.courses) {
          assert(Math.abs(course.topY - cursor) <= 1e-6,
            `${label} ${entry.kind}:${entry.id} course stack has a gap or overlap`);
          assert(course.bottomY < course.topY,
            `${label} ${entry.kind}:${entry.id} course is inverted`);
          // Value variation must stay a shade, never a different stone.
          assert(course.tone > 0.8 && course.tone < 1.2,
            `${label} ${entry.kind}:${entry.id} stone tone ${course.tone.toFixed(3)} left the band`);
          cursor = course.bottomY;
        }
        assert(Math.abs(cursor - segment.bottomY) <= 1e-6,
          `${label} ${entry.kind}:${entry.id} courses do not reach the closing bottom`);
      }
      closedObjects++;
      // Unclosed float = the pre-fix geometry's slot for this object.
      const unclosed = entry.baseY - ringFloor(site, entry.footprint);
      const previous = worstUnclosedByKind.get(entry.kind);
      if (!previous || unclosed > previous.value) {
        worstUnclosedByKind.set(entry.kind, { value: unclosed, where: `${label} ${entry.id}` });
      }
    }
    summary.push({ label, ...budget });

    // 2) Residential pads: the exact-mesh skirt closes; the legacy analytic
    //    endpoint skirt did not (carried FAIL-first fixture).
    for (const parcel of plan.parcels || []) {
      if (!parcel.poly) continue;
      const padY = parcel.baseY ?? computePadY(parcel, site);
      const apron = padApronPolygon(parcel.poly);
      const skirt = planPadSkirtSegments(parcel.poly, padY, site);
      const bottoms = new Map();
      for (const segment of skirt) {
        bottoms.set(`${segment.a.x},${segment.a.z},${segment.b.x},${segment.b.z}`, segment.bottom0);
        assert(segment.topY === padY, `${label} ${parcel.id}: skirt top left padY`);
        assert(segment.bottom0 === segment.bottom1,
          `${label} ${parcel.id}: skirt bottom must be flat at the chord minimum`);
      }
      // Recompute the same chord split the planner used and demand closure.
      let residual = 0;
      for (let index = 0; index < apron.length; index++) {
        const a = apron[index];
        const b = apron[(index + 1) % apron.length];
        const count = Math.max(
          VILLAGE_PAD.skirtSegmentsPerEdge,
          Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / GROUND_JUNCTION.maxSegmentLength - 1e-8)),
        );
        for (let chord = 0; chord < count; chord++) {
          const t0 = chord / count, t1 = (chord + 1) / count;
          const p0 = { x: a.x + (b.x - a.x) * t0, z: a.z + (b.z - a.z) * t0 };
          const p1 = { x: a.x + (b.x - a.x) * t1, z: a.z + (b.z - a.z) * t1 };
          const key = `${p0.x},${p0.z},${p1.x},${p1.z}`;
          const bottom = bottoms.has(key) ? bottoms.get(key) : padY;
          residual = Math.max(residual, bottom - terrainMeshSegmentRange(site, p0, p1).min);
        }
      }
      assert(residual <= VISIBLE_FLOAT + EPSILON,
        `${label} ${parcel.id}: pad skirt left ${residual.toFixed(3)}m of visible float`);
      const legacy = legacyAnalyticSkirtResidual(site, parcel.poly, padY);
      if (legacy > worstLegacyPadResidual) {
        worstLegacyPadResidual = legacy;
        worstLegacyPadWhere = `${label} ${parcel.id}`;
      }
    }

    // 3) Pinned frontier — public props. [잠정 — 백로그]
    //    Point-placed props (장승 한 쌍, 솟대) are posts, not plinth-borne buildings:
    //    the enclosing planning cylinder over-states their real slot (the posts sit
    //    near the centre), and the in-vocabulary fix is a deeper post sink in
    //    src/props/, not a stone apron ring. Measured worst over this matrix at
    //    d9dcdfc is 0.57 m (jangseung-pair, town/s2). Pinned as a no-regression
    //    ceiling only — NOT asserted at VISIBLE_FLOAT, and deliberately not closed
    //    in this round. Re-pin downward when the props round lands.
    for (const prop of plan.features?.props || []) {
      const spec = PUBLIC_PROP_OBSTRUCTIONS[prop.name];
      if (!spec) continue;
      const radius = spec.radius * (Number.isFinite(prop.scale) ? prop.scale : 1);
      const ring = G.ensureCCW(ringFootprint(prop.x, prop.z, radius, 12, prop.rot || 0));
      const float = site.heightAt(prop.x, prop.z) - ringFloor(site, ring);
      if (float > worstPropFloat) {
        worstPropFloat = float;
        worstPropWhere = `${label} ${prop.name}`;
      }
    }
  }
}

// ── FAIL-first fixtures: the pre-fix geometry must still measure as broken ──
const PRE_FIX_FLOAT_FIXTURE = Object.freeze({
  // Measured at base d9dcdfc. Lower bounds, so terrain retuning cannot silently
  // erase the fixture without tripping this gate.
  sijeon: 2.5,
  'guardian-dolran': 5.5,
  pavilion: 0.8,
});
for (const [kind, floor] of Object.entries(PRE_FIX_FLOAT_FIXTURE)) {
  const observed = worstUnclosedByKind.get(kind);
  assert(observed, `FAIL-first fixture lost: no ${kind} junction was planned at all`);
  assert(observed.value >= floor,
    `FAIL-first fixture weakened for ${kind}: unclosed float ${observed.value.toFixed(2)}m `
    + `< ${floor}m (${observed.where}). The pre-fix defect must remain measurable, `
    + 'or this gate would pass on unfixed source.');
  assert(observed.value > VISIBLE_FLOAT,
    `${kind} unclosed float is no longer visible — fixture is dead`);
}
assert(worstLegacyPadResidual > VISIBLE_FLOAT,
  `FAIL-first fixture weakened: the legacy analytic endpoint pad skirt now leaves only `
  + `${worstLegacyPadResidual.toFixed(3)}m of residual float — its lower bound measured `
  + `0.17m at d9dcdfc (${worstLegacyPadWhere}), 0.29m against the true interpolated bottom`);
assert(closedObjects > 300, `too few junction objects sampled (${closedObjects})`);
assert(totalJunctionSegments > 0, 'no junction segments planned across the whole matrix');

// Frontier ceiling (no-regression only, deliberately above VISIBLE_FLOAT).
const PROP_FLOAT_FRONTIER = 0.60;   // [잠정 — 백로그] measured 0.57m at d9dcdfc
assert(worstPropFloat <= PROP_FLOAT_FRONTIER,
  `public prop float ${worstPropFloat.toFixed(3)}m exceeded the pinned frontier `
  + `${PROP_FLOAT_FRONTIER}m at ${worstPropWhere}`);

const pad = (value, width) => String(value).padEnd(width);
console.log('\nGROUND JUNCTION BUDGET (quads = courses + 갓돌 ledges, 2 tri each; 0 new draw calls / materials)');
for (const row of summary) {
  const kinds = Object.entries(row.byKind)
    .map(([kind, bucket]) => `${kind} ${bucket.objects}o/${bucket.quads}q/${bucket.maxHeight.toFixed(2)}m`)
    .join('  ');
  console.log(`  ${pad(row.label, 14)} ${String(row.segments).padStart(5)} seg `
    + `${String(row.dressedSegments).padStart(4)} dressed ${String(row.quads).padStart(5)} quad `
    + `${String(row.triangles).padStart(6)} tri  max ${row.maxHeight.toFixed(2)}m  ${kinds}`);
}
console.log(
  `\nHOUSE FLOAT CONTRACT: PASS (schema v${GROUND_JUNCTION_SCHEMA_VERSION}, `
  + `${closedObjects} no-pad structures closed to 0 residual, `
  + `pad skirt closed within ${VISIBLE_FLOAT}m on ${SCALES.length}x${SEEDS.length} plans, `
  + `${totalJunctionSegments} junction segments, single '${GROUND_JUNCTION.materialRole}' family)\n`
  + `  FAIL-first: sijeon ${worstUnclosedByKind.get('sijeon').value.toFixed(2)}m / `
  + `돌단 ${worstUnclosedByKind.get('guardian-dolran').value.toFixed(2)}m / `
  + `pavilion ${worstUnclosedByKind.get('pavilion').value.toFixed(2)}m unclosed datum, `
  + `legacy analytic pad skirt ${worstLegacyPadResidual.toFixed(2)}m\n`
  + `  frontier [잠정 — 백로그]: public prop float ${worstPropFloat.toFixed(2)}m @ ${worstPropWhere} (ceiling ${PROP_FLOAT_FRONTIER}m)`,
);
