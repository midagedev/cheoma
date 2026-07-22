// End-to-end renderer-free contract for issue #10: planning, serializable edit
// state and the declarative Svelte schema share one shape-aware capability set.
import assert from 'node:assert/strict';
import {
  RESIDENTIAL_OPENING_DEFAULTS,
  RESIDENTIAL_OPENING_PARAM_KEYS,
  normalizeChogaShape,
  normalizeResidentialOpenings,
  planChogaKitchenOpening,
  planGiwaKitchenOpening,
  planResidentialOpenings,
  residentialOpeningCapabilities,
  residentialOpeningSlots,
} from '../src/api/residential-openings.js';
import { PRESETS, computeLayout } from '../src/params.js';
import {
  giwaFootprintMetrics,
  giwaFootprintPoints,
  giwaFrontRange,
} from '../src/layout/giwa-footprint.js';
import { planOpeningDetail } from '../src/api/opening-detail.js';
import { planThresholdLife } from '../src/api/threshold-life.js';
import { buildRebuildPayload, schemaFor } from '../app/src/lib/edit-schema.js';
import {
  buildEditedParcelSpec,
  buildParcelSpec,
  clampBuildingDimensions,
} from '../src/runtime/village/parcel-edit.js';

const FIXTURES = Object.freeze({
  choga3: Object.freeze({
    kind: 'choga',
    building: Object.freeze({
      frontBays: 3, sideBays: 2,
      centerBayW: 3, middleBayW: 2.6, endBayW: 2.6,
      centerBayD: 2.2, endBayD: 2.2, columnRadius: 0.12,
    }),
    capacity: Object.freeze({ doors: 2, windows: 7 }),
  }),
  choga5: Object.freeze({
    kind: 'choga',
    building: Object.freeze({
      frontBays: 5, sideBays: 2,
      centerBayW: 3.5, middleBayW: 2.9, endBayW: 2.7,
      centerBayD: 2.2, endBayD: 2.2, columnRadius: 0.12,
    }),
    capacity: Object.freeze({ doors: 2, windows: 11 }),
  }),
  giwaSingle: Object.freeze({
    kind: 'giwa',
    building: Object.freeze({
      planShape: 'single', bays: 3, bay: 2.2,
      mainHalfW: 3.3, mainHalfD: 2.2, wingW: 2.2, wingLen: 4,
      columnRadius: 0.16,
    }),
    capacity: Object.freeze({ doors: 2, windows: 6 }),
  }),
  giwaL: Object.freeze({
    kind: 'giwa',
    building: Object.freeze({
      planShape: 'l', bays: 3, bay: 2.2,
      mainHalfW: 4.2, mainHalfD: 2.2, wingW: 2.2, wingLen: 4,
      columnRadius: 0.16,
    }),
    capacity: Object.freeze({ doors: 4, windows: 10 }),
  }),
  giwaU: Object.freeze({
    kind: 'giwa',
    building: Object.freeze({
      planShape: 'u', bays: 4, bay: 2.2,
      mainHalfW: 5, mainHalfD: 2.2, wingW: 2.2, wingLen: 4,
      columnRadius: 0.16,
    }),
    capacity: Object.freeze({ doors: 6, windows: 14 }),
  }),
});

function assertDeepFrozen(value, path = 'plan') {
  if (!value || typeof value !== 'object') return;
  assert(Object.isFrozen(value), `${path} is mutable`);
  for (const [key, child] of Object.entries(value)) assertDeepFrozen(child, `${path}.${key}`);
}

function assertFiniteNumbers(value, path = 'plan') {
  if (typeof value === 'number') {
    assert(Number.isFinite(value), `${path} is not finite (${value})`);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) assertFiniteNumbers(child, `${path}.${key}`);
}

function spansOverlap(a, b) {
  return a.min < b.max && b.min < a.max;
}

function slotExtents(slots) {
  const extents = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (const slot of [...slots.doors, ...slots.windows]) {
    for (const sign of [-1, 1]) {
      const x = slot.center.x + sign * slot.tangent.x * slot.bayWidth / 2;
      const z = slot.center.z + sign * slot.tangent.z * slot.bayWidth / 2;
      extents.minX = Math.min(extents.minX, x);
      extents.maxX = Math.max(extents.maxX, x);
      extents.minZ = Math.min(extents.minZ, z);
      extents.maxZ = Math.max(extents.maxZ, z);
    }
  }
  return extents;
}

function pointExtents(points) {
  return points.reduce((extents, point) => ({
    minX: Math.min(extents.minX, point.x),
    maxX: Math.max(extents.maxX, point.x),
    minZ: Math.min(extents.minZ, point.z),
    maxZ: Math.max(extents.maxZ, point.z),
  }), { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity });
}

function assertExtentsEqual(actual, expected, name) {
  for (const key of ['minX', 'maxX', 'minZ', 'maxZ']) {
    assert(Math.abs(actual[key] - expected[key]) < 1e-9,
      `${name}: planner ${key} ${actual[key]} diverged from production ${expected[key]}`);
  }
}

function primarySideSeeds(building) {
  const bySide = new Map();
  for (let seed = 0; seed < 256 && bySide.size < 2; seed++) {
    const primary = planResidentialOpenings('giwa', building, seed)
      .openings.find((opening) => opening.primary);
    if (primary?.landing?.clearSide === -1 || primary?.landing?.clearSide === 1) {
      if (!bySide.has(primary.landing.clearSide)) bySide.set(primary.landing.clearSide, seed);
    }
  }
  return bySide;
}

function thresholdPlanFor(primary, seed) {
  const detail = planOpeningDetail({
    kind: 'door',
    style: 'giwa',
    seed: `${seed}:${primary.id}`,
    width: primary.width,
    height: 1.8,
    wallThickness: 0.13,
    primary: true,
    footwear: {
      y: 0.48,
      outward: 0.78,
      surface: 'toenmaru',
      clearSide: primary.landing?.clearSide,
    },
  });
  return { detail, threshold: planThresholdLife({ opening: detail, seed: 17 }) };
}

function buildingBoundsFor(opening, localBounds) {
  const points = [];
  for (const u of [localBounds.uMin, localBounds.uMax]) {
    for (const outward of [localBounds.outwardMin, localBounds.outwardMax]) {
      points.push({
        x: opening.center.x + opening.tangent.x * u + opening.outward.x * outward,
        z: opening.center.z + opening.tangent.z * u + opening.outward.z * outward,
      });
    }
  }
  return pointExtents(points);
}

assert.deepEqual(RESIDENTIAL_OPENING_PARAM_KEYS, [
  'doorCount', 'windowCount', 'doorWidthK', 'windowWidthK',
  'doorHeightK', 'windowHeightK',
]);
assert(Object.isFrozen(RESIDENTIAL_OPENING_PARAM_KEYS));
assert(Object.isFrozen(RESIDENTIAL_OPENING_DEFAULTS.choga));
assert.throws(() => residentialOpeningSlots('temple'), /unsupported residential opening kind/);

const tightU = {
  planShape: 'u', bays: 4, bay: 2.2,
  mainHalfW: 4.4, mainHalfD: 2.2, wingW: 99, wingLen: 4,
};
assert.equal(planResidentialOpenings('giwa', tightU, 7).openings.find((opening) => opening.primary)?.facade,
  'front', 'narrow U courtyard lost its primary south/front door when no daecheong fits');
const chogaFace = planResidentialOpenings('choga', FIXTURES.choga3.building, 20260716);
assert.equal(chogaFace.openings.filter((opening) => opening.kind === 'window' && opening.facade === 'front').length, 2,
  'default 초가 face no longer preserves the central door with flanking front windows');
const tightChogaKitchen = {
  frontBays: 3, sideBays: 2,
  centerBayW: 3, middleBayW: 2.6, endBayW: 2.6,
  centerBayD: 1.4, endBayD: 1.4, columnRadius: 0.12,
  windowCount: 99, windowWidthK: 0.62,
};
const tightChogaPlan = planResidentialOpenings('choga', tightChogaKitchen, 20260716);
const tightChogaService = planChogaKitchenOpening(4.1);
assert(Math.abs(tightChogaService.spanZ.min + 0.92) < 1e-12
    && Math.abs(tightChogaService.spanZ.max - 0.42) < 1e-12,
  `choga planner/renderer kitchen frame span drifted: ${JSON.stringify(tightChogaService.spanZ)}`);
for (const opening of tightChogaPlan.openings.filter((candidate) => (
  candidate.kind === 'window' && candidate.facade === 'side-east'
))) {
  assert(!spansOverlap({
    min: opening.center.z - opening.width / 2,
    max: opening.center.z + opening.width / 2,
  }, tightChogaService.spanZ), `${opening.id}: tight choga window overlaps its kitchen frame`);
}
assert.equal(tightChogaPlan.openings.filter((opening) => opening.facade === 'side-east').length, 0,
  'tight choga fixture retained the east window that clips the kitchen frame');

const originalRandom = Math.random;
Math.random = () => { throw new Error('residential opening plan consumed global Math.random'); };
try {
  for (const [name, fixture] of Object.entries(FIXTURES)) {
    const { kind, building, capacity } = fixture;
    const before = JSON.stringify(building);
    const slots = residentialOpeningSlots(kind, building);
    const capabilities = residentialOpeningCapabilities(kind, building);
    assert.equal(slots.doors.length, capacity.doors, `${name}: door capacity drifted`);
    assert.equal(slots.windows.length, capacity.windows, `${name}: window capacity drifted`);
    assert.equal(capabilities.doorCount.max, capacity.doors, `${name}: door max is not shape-aware`);
    assert.equal(capabilities.windowCount.max, capacity.windows, `${name}: window max is not shape-aware`);
    assert.equal(JSON.stringify(building), before, `${name}: capability planning mutated its input`);
    assert(Object.isFrozen(slots) && Object.isFrozen(slots.doors[0].center),
      `${name}: public slot graph is mutable`);

    if (kind === 'giwa') {
      assertExtentsEqual(slotExtents(slots), pointExtents(giwaFootprintPoints(building)), name);
    } else {
      const productionLayout = computeLayout({ ...PRESETS.choga, ...building });
      assertExtentsEqual(slotExtents(slots), {
        minX: -productionLayout.W / 2, maxX: productionLayout.W / 2,
        minZ: -productionLayout.D / 2, maxZ: productionLayout.D / 2,
      }, name);
    }

    const ids = [...slots.doors, ...slots.windows].map((slot) => slot.id);
    assert.equal(new Set(ids).size, ids.length, `${name}: door/window slot domains overlap`);
    for (const slot of [...slots.doors, ...slots.windows]) {
      assert(Number.isFinite(slot.center.x) && Number.isFinite(slot.center.z),
        `${name}/${slot.id}: non-finite local center`);
      assert(slot.availableWidth >= 0.5 && slot.availableWidth <= slot.bayWidth,
        `${name}/${slot.id}: usable width escaped its bay`);
      assert(Math.abs(Math.hypot(slot.tangent.x, slot.tangent.z) - 1) < 1e-9,
        `${name}/${slot.id}: tangent is not normalized`);
      assert(Math.abs(Math.hypot(slot.outward.x, slot.outward.z) - 1) < 1e-9,
        `${name}/${slot.id}: outward is not normalized`);
      assert(Math.abs(slot.tangent.x * slot.outward.x + slot.tangent.z * slot.outward.z) < 1e-9,
        `${name}/${slot.id}: outward is not perpendicular to its wall`);
    }

    const invalid = normalizeResidentialOpenings(kind, {
      ...building,
      doorCount: -20,
      windowCount: 999,
      doorWidthK: -1,
      windowWidthK: Infinity,
      doorHeightK: -1,
      windowHeightK: Infinity,
    });
    assert.equal(invalid.doorCount, 1, `${name}: door minimum was not enforced`);
    assert.equal(invalid.windowCount, capacity.windows, `${name}: window maximum was not enforced`);
    assert.equal(invalid.doorWidthK, capabilities.doorWidthK.min,
      `${name}: door width minimum was not enforced`);
    assert.equal(invalid.windowWidthK, capabilities.windowWidthK.default,
      `${name}: invalid window width did not use its declared default`);
    assert.equal(invalid.doorHeightK, capabilities.doorHeightK.min,
      `${name}: door height minimum was not enforced`);
    assert.equal(invalid.windowHeightK, capabilities.windowHeightK.default,
      `${name}: invalid window height did not use its declared default`);

    let previousDoors = [];
    for (let count = capabilities.doorCount.min; count <= capabilities.doorCount.max; count++) {
      const plan = planResidentialOpenings(kind, {
        ...building,
        doorCount: count,
        windowCount: 1,
      }, 0x10a0b0c0);
      const doors = plan.openings.filter((opening) => opening.kind === 'door');
      const primaries = plan.openings.filter((opening) => opening.primary);
      assert.deepEqual(doors.slice(0, previousDoors.length).map((opening) => opening.id), previousDoors,
        `${name}: increasing doorCount displaced an existing door`);
      assert.equal(primaries.length, 1, `${name}: plan must have exactly one primary opening`);
      assert.equal(primaries[0].kind, 'door', `${name}: primary opening is not a door`);
      assert.equal(primaries[0].facade, 'front', `${name}: primary door left the south/front range`);
      previousDoors = doors.map((opening) => opening.id);
    }

    let previousWindows = [];
    for (let count = capabilities.windowCount.min; count <= capabilities.windowCount.max; count++) {
      const plan = planResidentialOpenings(kind, {
        ...building,
        doorCount: 1,
        windowCount: count,
      }, 0x10a0b0c0);
      const windows = plan.openings.filter((opening) => opening.kind === 'window');
      assert.deepEqual(windows.slice(0, previousWindows.length).map((opening) => opening.id), previousWindows,
        `${name}: increasing windowCount displaced an existing window`);
      previousWindows = windows.map((opening) => opening.id);
    }

    const maximalRequest = Object.freeze({
      ...building,
      doorCount: capacity.doors,
      windowCount: capacity.windows,
      doorWidthK: capabilities.doorWidthK.max,
      windowWidthK: capabilities.windowWidthK.max,
      doorHeightK: capabilities.doorHeightK.max,
      windowHeightK: capabilities.windowHeightK.max,
    });
    const maximalBefore = JSON.stringify(maximalRequest);
    const maximal = planResidentialOpenings(kind, maximalRequest, 0x10a0b0c0);
    assert.equal(JSON.stringify(maximalRequest), maximalBefore,
      `${name}: full planning mutated its input`);
    assertDeepFrozen(maximal, name);
    assert.deepEqual(Object.keys(maximal.params), RESIDENTIAL_OPENING_PARAM_KEYS,
      `${name}: normalized plan grew beyond the six intended axes`);
    assert.equal(maximal.openings.length, capacity.doors + capacity.windows,
      `${name}: normalized counts and emitted openings disagree`);
    for (const opening of maximal.openings) {
      assert.equal(opening.style, kind, `${name}/${opening.id}: #16 style handoff drifted`);
      assert.equal(opening.width, opening.availableWidth * opening.widthK,
        `${name}/${opening.id}: #16 width handoff is inconsistent`);
      assert.equal(
        opening.heightK,
        opening.kind === 'door' ? maximal.params.doorHeightK : maximal.params.windowHeightK,
        `${name}/${opening.id}: #10 height handoff is inconsistent`,
      );
      assert(['floor-to-lintel', 'sill-to-lintel'].includes(opening.verticalBand),
        `${name}/${opening.id}: structural height band is missing`);
    }
    if (kind === 'giwa') {
      const eastWindows = maximal.openings.filter((opening) => (
        opening.kind === 'window' && opening.facade === 'side-east'
      ));
      assert(eastWindows.length > 0, `${name}: kitchen reservation removed the whole east wall`);
      const kitchen = planGiwaKitchenOpening(eastWindows[0].center.x);
      for (const opening of eastWindows) {
        const span = {
          min: opening.center.z - opening.width / 2,
          max: opening.center.z + opening.width / 2,
        };
        assert(!spansOverlap(span, kitchen.spanZ),
          `${name}/${opening.id}: maximum window span overlaps the shared kitchen span`);
      }
    }
    assert.deepEqual(
      normalizeResidentialOpenings(kind, { ...building, ...maximal.params }),
      maximal.params,
      `${name}: normalized opening params are not idempotent`,
    );
    assert.equal(
      JSON.stringify(planResidentialOpenings(kind, building, 73)),
      JSON.stringify(planResidentialOpenings(kind, building, 73)),
      `${name}: same seed did not reproduce byte-identical JSON`,
    );
    const seededSelections = new Set([11, 23, 37, 53].map((seed) => (
      planResidentialOpenings(kind, building, seed).openings.map((opening) => opening.id).join('|')
    )));
    assert(seededSelections.size > 1, `${name}: seed has no effect on non-primary slot selection`);
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(maximal)),
      `${name}: plan is not JSON-safe`);
  }

  // Focus footwear consumes the selected primary's local landing direction;
  // cover every production giwa footprint, both seed-selected daecheong sides,
  // and the declared minimum/default/maximum door control profiles without
  // reproducing the planner's slot ordering in this harness.
  for (const [name, fixture] of Object.entries({
    single: FIXTURES.giwaSingle,
    l: FIXTURES.giwaL,
    u: FIXTURES.giwaU,
  })) {
    const building = fixture.building;
    const capabilities = residentialOpeningCapabilities('giwa', building);
    const sideSeeds = primarySideSeeds(building);
    assert.deepEqual([...sideSeeds.keys()].sort(), [-1, 1],
      `${name}: seed selection no longer reaches both sides of the daecheong`);
    const profiles = [
      ['min', capabilities.doorWidthK.min, capabilities.doorCount.min],
      ['default', capabilities.doorWidthK.default, capabilities.doorCount.default],
      ['max', capabilities.doorWidthK.max, capabilities.doorCount.max],
    ];
    const front = giwaFrontRange(building);
    const frontCenter = { x: (front.x0 + front.x1) / 2, z: front.z };
    for (const [side, seed] of sideSeeds) {
      for (const [profile, doorWidthK, doorCount] of profiles) {
        const request = { ...building, doorWidthK, doorCount };
        const plan = planResidentialOpenings('giwa', request, seed);
        const primary = plan.openings.find((opening) => opening.primary);
        const primaries = plan.openings.filter((opening) => opening.primary);
        const label = `${name}/${side > 0 ? 'left' : 'right'}/${profile}`;
        assert.equal(primaries.length, 1, `${label}: primary opening count drifted`);
        assert.equal(primary.landing?.clearSide, side,
          `${label}: primary lost its local daecheong-side landing`);
        const centerU = (frontCenter.x - primary.center.x) * primary.tangent.x
          + (frontCenter.z - primary.center.z) * primary.tangent.z;
        assert.equal(Math.sign(centerU), side,
          `${label}: landing side points away from the actual front-range center`);
        const { detail, threshold } = thresholdPlanFor(primary, seed);
        assert.equal(detail.anchors.footwear.clearSide, side,
          `${label}: opening-detail handoff lost the landing direction`);
        assert.equal(threshold.clearance.placementSide, side,
          `${label}: threshold life reconstructed a different side`);
        assert(threshold.clearance.threshold > 0.005
            && threshold.clearance.approach > 0.04
            && threshold.clearance.jamb > 0.04,
        `${label}: footwear lost threshold/opening/jamb clearance`);
        for (const item of threshold.items) {
          const world = buildingBoundsFor(primary, item.bounds);
          assert(world.minX >= front.x0 - 1e-9 && world.maxX <= front.x1 + 1e-9,
            `${label}: footwear left the toenmaru side bounds`);
          assert(world.minZ >= front.z - 1e-9 && world.maxZ <= front.z + 1.25 + 1e-9,
            `${label}: footwear left the toenmaru depth bounds`);
        }
        const repeat = planResidentialOpenings('giwa', request, seed);
        const repeatThreshold = thresholdPlanFor(
          repeat.openings.find((opening) => opening.primary), seed,
        ).threshold;
        assert.equal(JSON.stringify(repeat), JSON.stringify(plan),
          `${label}: residential plan is not byte-identical`);
        assert.equal(repeatThreshold.placement.signature, threshold.placement.signature,
          `${label}: threshold placement signature is not deterministic`);
      }
    }
  }
} finally {
  Math.random = originalRandom;
}

const adversarialShapes = [
  ['choga-nonfinite', 'choga', {
    frontBays: Infinity, sideBays: -Infinity,
    centerBayW: NaN, middleBayW: Infinity, endBayW: -Infinity,
    centerBayD: Infinity, endBayD: NaN, columnRadius: Infinity,
    doorCount: 1e308, windowCount: 1e308, doorWidthK: 1e308, windowWidthK: 1e308,
    doorHeightK: 1e308, windowHeightK: 1e308,
  }],
  ['giwa-huge', 'giwa', {
    planShape: 'u', bays: 1e308, bay: 1e308,
    mainHalfW: 1e308, mainHalfD: 1e308, wingLen: 1e308, wingW: 1e308,
    columnRadius: 1e308,
    doorCount: 1e308, windowCount: 1e308, doorWidthK: 1e308, windowWidthK: 1e308,
    doorHeightK: 1e308, windowHeightK: 1e308,
  }],
  ['giwa-nonfinite', 'giwa', {
    planShape: 'single', bays: Infinity, bay: -Infinity,
    mainHalfW: Infinity, mainHalfD: NaN, wingLen: -Infinity, wingW: Infinity,
    columnRadius: NaN,
    doorCount: Infinity, windowCount: -Infinity, doorWidthK: NaN, windowWidthK: Infinity,
    doorHeightK: NaN, windowHeightK: Infinity,
  }],
];
for (const [name, kind, building] of adversarialShapes) {
  const plan = planResidentialOpenings(kind, building, 1e308);
  assertFiniteNumbers(plan, name);
  assert(plan.openings.length < 100, `${name}: bounded shape created ${plan.openings.length} openings`);
  assert.deepEqual(JSON.parse(JSON.stringify(plan)), plan,
    `${name}: JSON round-trip changed the normalized graph`);
  if (kind === 'choga') {
    const normalized = normalizeChogaShape(building);
    const productionLayout = computeLayout({ ...PRESETS.choga, ...building });
    assert(Object.isFrozen(normalized), `${name}: shared choga frame is mutable`);
    assertFiniteNumbers(normalized, `${name}.shape`);
    assertFiniteNumbers(productionLayout, `${name}.productionLayout`);
    assertExtentsEqual(slotExtents(plan.slots), {
      minX: -productionLayout.W / 2, maxX: productionLayout.W / 2,
      minZ: -productionLayout.D / 2, maxZ: productionLayout.D / 2,
    }, `${name}-production-fallback`);
  }
}

for (const [key, value] of [
  ['frontBays', 10],
  ['frontBays', 3.5],
  ['sideBays', 6],
  ['centerBayW', 5.01],
  ['middleBayW', 1.39],
  ['endBayW', 1e308],
  ['centerBayD', 1e308],
  ['endBayD', 0],
  ['columnRadius', 1e308],
]) {
  assert.throws(
    () => planResidentialOpenings('choga', { ...FIXTURES.choga3.building, [key]: value }, 19),
    RangeError,
    `choga ${key}=${value} was silently clamped away from production geometry`,
  );
  assert.throws(
    () => computeLayout({ ...PRESETS.choga, [key]: value }),
    RangeError,
    `production choga ${key}=${value} did not share the planner rejection`,
  );
}

const wideGiwa = {
  ...FIXTURES.giwaL.building,
  bay: 20,
  mainHalfW: 20,
  mainHalfD: 20,
  wingLen: 20,
  wingW: 20,
  columnRadius: 20,
};
const wideMetrics = giwaFootprintMetrics(wideGiwa);
assert.deepEqual(wideMetrics, {
  planShape: 'l', bays: 3, bay: 3.6, columnRadius: 0.4,
  a: 12, b: 6, w: 8, c: 12,
}, 'production footprint did not apply the shared finite upper bounds');
assertExtentsEqual(
  slotExtents(residentialOpeningSlots('giwa', wideGiwa)),
  pointExtents(giwaFootprintPoints(wideGiwa)),
  'giwa-shared-upper-bounds',
);

const parcelFixture = {
  id: 'edit-fixture', kind: 'giwa', variant: 0, rank: 0.6, seed: 73,
  plotW: 16, plotD: 14, wallType: 'stone', toneIdx: 0,
};
for (const [kind, params] of [
  ['choga', { ...PRESETS.choga }],
  ['giwa', { ...PRESETS.giwa, planShape: 'u', bays: 4, mainHalfW: 5 }],
]) {
  const schema = schemaFor({ kind, family: 'regular', params });
  const fields = schema.sections.flatMap((section) => section.fields);
  const openingFields = Object.fromEntries(fields
    .filter((field) => RESIDENTIAL_OPENING_PARAM_KEYS.includes(field.key))
    .map((field) => [field.key, field]));
  const capabilities = residentialOpeningCapabilities(kind, params);
  assert.deepEqual(Object.keys(openingFields), RESIDENTIAL_OPENING_PARAM_KEYS,
    `${kind}: editor did not expose exactly the six residential axes`);
  for (const key of RESIDENTIAL_OPENING_PARAM_KEYS) {
    assert.equal(openingFields[key].min, capabilities[key].min, `${kind}/${key}: editor minimum drifted`);
    assert.equal(openingFields[key].max, capabilities[key].max, `${kind}/${key}: editor maximum drifted`);
    assert.equal(openingFields[key].step, capabilities[key].step, `${kind}/${key}: editor step drifted`);
    assert.equal(openingFields[key].route, 'building', `${kind}/${key}: editor bypasses engine building params`);
  }
  assert.equal(openingFields.doorCount.unitKey, 'unit_count', `${kind}: count unit is missing`);
  assert.equal(openingFields.windowWidthK.format, 'percent', `${kind}: width unit is missing`);
  assert.equal(openingFields.doorHeightK.format, 'percent', `${kind}: door height unit is missing`);
  assert.equal(openingFields.windowHeightK.format, 'percent', `${kind}: window height unit is missing`);
  const payload = buildRebuildPayload({ kind, family: 'regular', params }, {
    kind,
    ...params,
    doorCount: capabilities.doorCount.max,
    windowCount: capabilities.windowCount.min,
    doorWidthK: capabilities.doorWidthK.min,
    windowWidthK: capabilities.windowWidthK.max,
    doorHeightK: capabilities.doorHeightK.min,
    windowHeightK: capabilities.windowHeightK.max,
  });
  assert.deepEqual(
    Object.keys(payload.building).filter((key) => RESIDENTIAL_OPENING_PARAM_KEYS.includes(key)),
    RESIDENTIAL_OPENING_PARAM_KEYS,
    `${kind}: rebuild payload lost an opening axis`,
  );
}

const defaultSpec = buildParcelSpec(parcelFixture);
assert.deepEqual(
  Object.fromEntries(RESIDENTIAL_OPENING_PARAM_KEYS.map((key) => [key, defaultSpec.params[key]])),
  RESIDENTIAL_OPENING_DEFAULTS.giwa,
  'parcel edit state did not serialize planner defaults',
);
const chogaSparse = buildParcelSpec({ ...parcelFixture, kind: 'choga', variant: 0 });
const chogaRich = buildParcelSpec({ ...parcelFixture, kind: 'choga', variant: 2 });
assert(chogaSparse.params.windowCount < chogaRich.params.windowCount
    && chogaSparse.params.windowWidthK < chogaRich.params.windowWidthK
    && chogaSparse.params.doorHeightK < chogaRich.params.doorHeightK
    && chogaSparse.params.windowHeightK < chogaRich.params.windowHeightK,
  'seed-selected household variants no longer vary openings inside planner capabilities');
for (const spec of [chogaSparse, chogaRich]) {
  assert.deepEqual(
    normalizeResidentialOpenings(spec.kind, spec.params),
    Object.fromEntries(RESIDENTIAL_OPENING_PARAM_KEYS.map((key) => [key, spec.params[key]])),
    `${spec.variant}: generated opening variation escaped its shape capability`,
  );
}
const accepted = { ...defaultSpec.params, planShape: 'single', doorCount: 999, windowCount: 999 };
clampBuildingDimensions(accepted, 'giwa');
const singleCapabilities = residentialOpeningCapabilities('giwa', accepted);
assert.equal(accepted.doorCount, singleCapabilities.doorCount.max,
  'shape change did not clamp the serialized door count');
assert.equal(accepted.windowCount, singleCapabilities.windowCount.max,
  'shape change did not clamp the serialized window count');
const editedSpec = buildEditedParcelSpec(parcelFixture, { building: accepted }, accepted);
assert.deepEqual(
  normalizeResidentialOpenings('giwa', editedSpec.params),
  Object.fromEntries(RESIDENTIAL_OPENING_PARAM_KEYS.map((key) => [key, editedSpec.params[key]])),
  'accepted editor spec is not a canonical serializable opening boundary',
);

console.log('RESIDENTIAL OPENINGS: PASS (초가 3/5칸 + 기와 ㅡ/ㄱ/ㄷ, planner/editor state/schema)');
