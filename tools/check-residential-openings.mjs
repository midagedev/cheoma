// Pure contract for issue #10. The renderer/UI will consume this policy in a
// later PR; this gate keeps shape capacity, determinism, and nesting stable.
import assert from 'node:assert/strict';
import {
  RESIDENTIAL_OPENING_DEFAULTS,
  RESIDENTIAL_OPENING_PARAM_KEYS,
  normalizeChogaShape,
  normalizeResidentialOpenings,
  planGiwaKitchenOpening,
  planResidentialOpenings,
  residentialOpeningCapabilities,
  residentialOpeningSlots,
} from '../src/api/residential-openings.js';
import { PRESETS, computeLayout } from '../src/params.js';
import {
  giwaFootprintMetrics,
  giwaFootprintPoints,
} from '../src/layout/giwa-footprint.js';

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

assert.deepEqual(RESIDENTIAL_OPENING_PARAM_KEYS, [
  'doorCount', 'windowCount', 'doorWidthK', 'windowWidthK',
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
    });
    assert.equal(invalid.doorCount, 1, `${name}: door minimum was not enforced`);
    assert.equal(invalid.windowCount, capacity.windows, `${name}: window maximum was not enforced`);
    assert.equal(invalid.doorWidthK, capabilities.doorWidthK.min,
      `${name}: door width minimum was not enforced`);
    assert.equal(invalid.windowWidthK, capabilities.windowWidthK.default,
      `${name}: invalid window width did not use its declared default`);

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
    });
    const maximalBefore = JSON.stringify(maximalRequest);
    const maximal = planResidentialOpenings(kind, maximalRequest, 0x10a0b0c0);
    assert.equal(JSON.stringify(maximalRequest), maximalBefore,
      `${name}: full planning mutated its input`);
    assertDeepFrozen(maximal, name);
    assert.deepEqual(Object.keys(maximal.params), RESIDENTIAL_OPENING_PARAM_KEYS,
      `${name}: normalized plan grew beyond the four intended axes`);
    assert.equal(maximal.openings.length, capacity.doors + capacity.windows,
      `${name}: normalized counts and emitted openings disagree`);
    for (const opening of maximal.openings) {
      assert.equal(opening.style, kind, `${name}/${opening.id}: #16 style handoff drifted`);
      assert.equal(opening.width, opening.availableWidth * opening.widthK,
        `${name}/${opening.id}: #16 width handoff is inconsistent`);
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
} finally {
  Math.random = originalRandom;
}

const adversarialShapes = [
  ['choga-nonfinite', 'choga', {
    frontBays: Infinity, sideBays: -Infinity,
    centerBayW: NaN, middleBayW: Infinity, endBayW: -Infinity,
    centerBayD: Infinity, endBayD: NaN, columnRadius: Infinity,
    doorCount: 1e308, windowCount: 1e308, doorWidthK: 1e308, windowWidthK: 1e308,
  }],
  ['giwa-huge', 'giwa', {
    planShape: 'u', bays: 1e308, bay: 1e308,
    mainHalfW: 1e308, mainHalfD: 1e308, wingLen: 1e308, wingW: 1e308,
    columnRadius: 1e308,
    doorCount: 1e308, windowCount: 1e308, doorWidthK: 1e308, windowWidthK: 1e308,
  }],
  ['giwa-nonfinite', 'giwa', {
    planShape: 'single', bays: Infinity, bay: -Infinity,
    mainHalfW: Infinity, mainHalfD: NaN, wingLen: -Infinity, wingW: Infinity,
    columnRadius: NaN,
    doorCount: Infinity, windowCount: -Infinity, doorWidthK: NaN, windowWidthK: Infinity,
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

console.log('RESIDENTIAL OPENINGS: PASS (초가 3/5칸 + 기와 ㅡ/ㄱ/ㄷ, nested seed-stable pure plans)');
