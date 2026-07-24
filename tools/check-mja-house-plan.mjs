import { performance } from 'node:perf_hooks';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  MJA_HOUSE_PLAN_LIMITS,
  MJA_HOUSE_PLAN_SCHEMA_VERSION,
  planMjaHouse,
  validateMjaHousePlan,
} from '../src/api/mja-house-plan.js';
import { GIWA_VARIANTS } from '../src/village/variants.js';
import { planVillage } from '../src/api/village-plan.js';
import * as G from '../src/core/math/geom2.js';

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deeplyFrozen(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return true;
  seen.add(value);
  return Object.isFrozen(value)
    && Object.values(value).every((child) => deeplyFrozen(child, seen));
}

function rectangularParcel({
  id = 'mja-fixture',
  width = 27,
  depth = 27,
  gateX = 0,
  roadX = gateX,
  fitFactor = 1,
  effectiveScale = 1,
  gateRole = 'front',
  roadZ = depth * 0.5 + 4,
} = {}) {
  return {
    id,
    seed: 141,
    kind: 'giwa',
    plotW: width,
    plotD: depth,
    shape: {
      pts: [
        { x: width * 0.5, z: depth * 0.5 },
        { x: -width * 0.5, z: depth * 0.5 },
        { x: -width * 0.5, z: -depth * 0.5 },
        { x: width * 0.5, z: -depth * 0.5 },
      ],
    },
    center: { x: 0, z: 0 },
    frontDir: { x: 0, z: 1 },
    houseLocal: { x: 0, z: -depth * 0.28 },
    houseFitFactor: fitFactor,
    sx: effectiveScale,
    sy: effectiveScale,
    sz: effectiveScale,
    rank: 0.9,
    wealth: 0.84,
    access: {
      gateRole,
      gateLocalPoint: { x: gateX, z: depth * 0.5 },
      roadPoint: { x: roadX, z: roadZ },
    },
  };
}

const context = {
  enabled: true,
  form: 'mja',
  region: { id: 'andong-cultural-region', raw: '안동문화권 사례 맥락' },
  climate: '한랭한 겨울을 고려한 선택',
  household: '명시적으로 선택한 반가',
};

function buildWithoutAmbientRandom(input) {
  const before = JSON.stringify(input);
  const originalRandom = Math.random;
  Math.random = () => { throw new Error('mja plan consumed global Math.random'); };
  let plan;
  try {
    plan = planMjaHouse(input);
  } finally {
    Math.random = originalRandom;
  }
  invariant(JSON.stringify(input) === before, 'mja plan mutated its input');
  return plan;
}

const prototypeSignature = GIWA_VARIANTS.map((variant) => [
  variant.name,
  variant.mirrorOf ?? null,
  variant.ov?.planShape ?? null,
  variant.ov?.bays ?? null,
]);
invariant(JSON.stringify(prototypeSignature) === JSON.stringify([
  ['giwa-l', null, 'l', 3],
  ['giwa-l-flip', 0, null, null],
  ['giwa-single', null, 'single', 3],
  ['giwa-u', null, 'u', 4],
]), 'default ㅡ/ㄱ/ㄷ prototype groups changed');

const defaultVillage = planVillage({ scale: 'town', seed: 141 });
const defaultBytes = JSON.stringify({
  roads: defaultVillage.roads,
  parcels: defaultVillage.parcels,
  nodes: defaultVillage.nodes,
});
invariant(planMjaHouse({ parcel: defaultVillage.parcels[0] }) === null,
  'missing opt-in unexpectedly planned an mja house');
invariant(JSON.stringify({
  roads: defaultVillage.roads,
  parcels: defaultVillage.parcels,
  nodes: defaultVillage.nodes,
}) === defaultBytes, 'default-off mja probe changed existing village bytes');

for (const invalidContext of [
  null,
  {},
  { ...context, enabled: false },
  { ...context, form: 'u' },
  { ...context, region: '' },
  { ...context, climate: '' },
  { ...context, household: '' },
]) {
  invariant(planMjaHouse({ context: invalidContext, parcel: rectangularParcel() }) === null,
    'incomplete explicit context did not fail closed');
}
for (const invalidParcel of [
  rectangularParcel({ width: 18, depth: 18 }),
  rectangularParcel({ fitFactor: 0.7 }),
  rectangularParcel({ effectiveScale: 0.7 }),
  rectangularParcel({ gateRole: 'left' }),
  rectangularParcel({ roadZ: -20 }),
  { ...rectangularParcel(), kind: 'choga' },
]) {
  invariant(planMjaHouse({ context, parcel: invalidParcel }) === null,
    'physically invalid parcel did not fail closed');
}

const parcel = rectangularParcel();
const plan = buildWithoutAmbientRandom({ context, parcel });
invariant(plan, 'valid fitted fixture did not plan an mja house');
validateMjaHousePlan(plan);
validateMjaHousePlan(clone(plan));
invariant(deeplyFrozen(plan), 'mja plan is not deeply frozen');
invariant(plan.schema === MJA_HOUSE_PLAN_SCHEMA_VERSION, 'mja schema drift');
invariant(plan.context.region.id === 'andong-cultural-region'
  && plan.context.region.raw === '안동문화권 사례 맥락',
'mja context did not preserve normalized ID and raw provenance');

const repeat = buildWithoutAmbientRandom({ context: clone(context), parcel: clone(parcel) });
invariant(JSON.stringify(plan) === JSON.stringify(repeat), 'mja plan is not deterministic');

const roles = plan.wings.map((wing) => wing.role);
invariant(JSON.stringify(roles) === JSON.stringify([
  'north-anchae',
  'east-wing',
  'west-wing',
  'south-east',
  'south-west',
]), 'mja semantic wing order drifted');
for (const wing of plan.wings) {
  invariant(wing.building.seed === (wing.building.seed >>> 0),
    `${wing.id} lacks a stable builder seed`);
  invariant(!Object.hasOwn(wing.building, 'doorPattern'),
    `${wing.id} authored a door texture override ignored by shared palette materials`);
  for (const key of [
    'style', 'roofType', 'planShape', 'bays', 'mainHalfW', 'mainHalfD',
    'bay', 'columnHeight', 'columnRadius', 'entasis', 'podiumTierH',
    'eaveOverhang', 'riseScale', 'profileCurve', 'cornerLift', 'planCurve', 'ridgeH',
  ]) invariant(wing.building[key] != null, `${wing.id} omitted builder field ${key}`);
  for (const point of wing.roofFootprint) {
    invariant(G.pointInPoly(point, parcel.shape.pts), `${wing.id} roof left parcel`);
    let clearance = Infinity;
    for (let edge = 0; edge < parcel.shape.pts.length; edge++) {
      clearance = Math.min(clearance, G.distToSeg(
        point,
        parcel.shape.pts[edge],
        parcel.shape.pts[(edge + 1) % parcel.shape.pts.length],
      ).d);
    }
    invariant(clearance + 1e-8 >= MJA_HOUSE_PLAN_LIMITS.roofClearance,
      `${wing.id} roof lost fitted clearance`);
  }
}
for (const point of plan.gate.roofFootprint) {
  invariant(G.pointInPoly(point, parcel.shape.pts), 'gate roof left parcel');
}

invariant(plan.courtyard.width >= MJA_HOUSE_PLAN_LIMITS.minCourtyardWidth
  && plan.courtyard.depth >= MJA_HOUSE_PLAN_LIMITS.minCourtyardDepth,
'mja courtyard is not usable');
invariant(plan.gate.center.x === plan.gate.parcelGate.x
  && plan.gate.parcelGate.z > plan.gate.center.z
  && plan.gate.roadAxis.z >= Math.SQRT1_2,
'mja gate is not aligned to stored south access');
invariant(plan.gate.heightKind === 'clear-opening'
  && plan.gate.roof.ridgeY === plan.gate.roofTopY,
'mja gate height/roof semantics drifted');

const primary = plan.openings.find((opening) => opening.id === plan.primaryOpeningId);
invariant(primary?.wingId === 'mja:wing:north-anchae'
  && primary.role === 'primary'
  && primary.outward.x === 0 && primary.outward.z === 1,
'mja primary opening is not a south-facing north-anchae door');
invariant(primary.center.y === primary.bottomY + primary.height * 0.5,
  'mja primary opening center is not the geometric door-plane center');
invariant(plan.solarTarget.openingId === primary.id
  && plan.solarTarget.point.x === primary.center.x
  && plan.solarTarget.point.z === primary.center.z
  && plan.solarTarget.altitude === Math.PI / 6,
'mja solar target drifted from primary opening');
const expectedShadow = (plan.solarTarget.southRoofTopY - plan.solarTarget.point.y)
  / Math.tan(plan.solarTarget.altitude);
invariant(Math.abs(plan.solarTarget.shadowReach - expectedShadow) <= 1e-9
  && plan.solarTarget.margin >= MJA_HOUSE_PLAN_LIMITS.minSolarMargin,
'mja courtyard does not preserve 30-degree winter solar access');
const southWingRoofTopY = Math.max(...plan.wings
  .filter((wing) => wing.role === 'south-east' || wing.role === 'south-west')
  .map((wing) => wing.roofTopY));
invariant(plan.solarTarget.southRoofTopY === Math.max(
  plan.gate.roof.ridgeY,
  southWingRoofTopY,
) && southWingRoofTopY > plan.gate.roof.ridgeY,
'mja solar check did not use the actual taller south-wing roofs');

const offsetPlan = planMjaHouse({
  context: {
    enabled: true,
    form: 'mja',
    region: '영남 북부의 명시적 선택',
    climate: { id: 'winter-context', raw: '겨울 기후 맥락' },
    household: '상류주택 모방 맥락',
  },
  parcel: rectangularParcel({ id: 'offset', width: 29, depth: 28, gateX: 2, roadX: 3 }),
});
invariant(offsetPlan && offsetPlan.gate.center.x === 2
  && offsetPlan.context.region.raw === '영남 북부의 명시적 선택',
'free-text provenance or off-centre stored gate was not preserved');

const malformed = clone(plan);
malformed.wings[0].building.planShape = 'u';
let rejected = false;
try {
  validateMjaHousePlan(malformed);
} catch {
  rejected = true;
}
invariant(rejected, 'mja validator accepted a renderer-divergent wing');

const source = readFileSync(fileURLToPath(
  new URL('../src/village/mja-house-plan.js', import.meta.url),
), 'utf8');
invariant(!/from\s+['"]three['"]|\bTHREE\b|\bdocument\s*\.|\bwindow\s*\.|Math\.random/.test(source),
  'mja planner contains a renderer, DOM, or ambient-random dependency');

const iterations = 500;
const started = performance.now();
for (let index = 0; index < iterations; index++) {
  invariant(planMjaHouse({ context, parcel }), `mja performance fixture failed at ${index}`);
}
const elapsed = performance.now() - started;

console.log(`MJA HOUSE PLAN: PASS (${plan.wings.length} wings, ${plan.openings.length} openings, `
  + `${plan.bounds.outer.width.toFixed(1)}×${plan.bounds.outer.depth.toFixed(1)}m outer, `
  + `${plan.courtyard.width.toFixed(1)}×${plan.courtyard.depth.toFixed(1)}m courtyard, `
  + `${iterations} plans in ${elapsed.toFixed(1)}ms)`);
