// Pure sijeon placement/facade contract. This intentionally imports the domain
// module directly so the planner can be developed before village integration.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as G from '../src/core/math/geom2.js';
import {
  SIJEON_FACADE_BAYS,
  SIJEON_FACADE_SCHEMA_VERSION,
  SIJEON_PLACEMENT,
  planSijeon,
  planSijeonFacade,
} from '../src/village/sijeon-plan.js';

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function withoutGlobalRandom(build, label) {
  const original = Math.random;
  Math.random = () => {
    throw new Error(`${label} consumed global Math.random`);
  };
  try {
    return build();
  } finally {
    Math.random = original;
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function boxBounds(part) {
  return {
    minX: part.center.x - part.size.width / 2,
    maxX: part.center.x + part.size.width / 2,
    minY: part.center.y - part.size.height / 2,
    maxY: part.center.y + part.size.height / 2,
    minZ: part.center.z - part.size.depth / 2,
    maxZ: part.center.z + part.size.depth / 2,
  };
}

function assertFiniteTree(value, label, path = label) {
  if (typeof value === 'number') {
    invariant(Number.isFinite(value), `${path} is not finite`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertFiniteTree(item, label, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      assertFiniteTree(item, label, `${path}.${key}`);
    }
  }
}

function assertFacade(facade, label) {
  assertFiniteTree(facade, label);
  invariant(facade.schemaVersion === SIJEON_FACADE_SCHEMA_VERSION,
    `${label}: wrong schema version`);
  invariant(facade.bayCount === SIJEON_FACADE_BAYS
      && facade.columns.length === 3
      && facade.lintels.length === 2
      && facade.openings.length === 2
      && facade.benches.length === 2,
  `${label}: two-bay grammar is incomplete`);
  invariant(facade.storage.role === 'rear-storage', `${label}: rear storage missing`);
  invariant(facade.openings.every((opening) => opening.recessed === true),
    `${label}: an opening lost its recess contract`);

  const building = facade.building.bounds;
  const lot = facade.lot.bounds;
  invariant(building.minX >= lot.minX && building.maxX <= lot.maxX
      && building.minZ >= lot.minZ && building.maxZ <= lot.maxZ,
  `${label}: building mass escaped the planned footprint`);

  const physicalParts = [
    ...facade.columns,
    ...facade.lintels,
    ...facade.openings,
    ...facade.benches,
    facade.storage,
  ];
  for (const part of physicalParts) {
    const bounds = boxBounds(part);
    invariant(bounds.minX >= lot.minX - 1e-9 && bounds.maxX <= lot.maxX + 1e-9,
      `${label}:${part.role} escaped the lot laterally`);
    invariant(bounds.minZ >= lot.minZ - 1e-9
        && bounds.maxZ <= facade.corridor.maxNonEaveZ + 1e-9,
    `${label}:${part.role} entered the road corridor`);
    invariant(bounds.minY >= -1e-9 && bounds.maxY <= facade.building.height + 1e-9,
      `${label}:${part.role} escaped the building height`);
  }
  invariant(facade.openings.every((opening) => (
    boxBounds(opening).maxZ < Math.min(...facade.columns.map((column) => boxBounds(column).maxZ))
  )), `${label}: shop opening is not recessed behind the column line`);
  invariant(facade.storage.center.z < 0
      && boxBounds(facade.storage).maxZ < Math.min(...facade.openings.map((opening) => (
        boxBounds(opening).minZ
      ))),
  `${label}: storage is not behind the sales frontage`);
  invariant(facade.roof.eaveProjection.front
      === Math.max(0, facade.corridor.maxEaveZ - facade.corridor.streetEdgeZ),
  `${label}: roof corridor exception is stale`);
  invariant(facade.corridor.maxEaveZ >= facade.building.bounds.maxZ,
    `${label}: roof no longer covers the facade`);
}

const source = readFileSync(new URL('../src/village/sijeon-plan.js', import.meta.url), 'utf8');
invariant(!/from ['"]three['"]|Math\.random/.test(source),
  'sijeon planner gained a Three.js or global-random dependency');
invariant(Object.isFrozen(SIJEON_PLACEMENT), 'placement constants must be immutable');
invariant(SIJEON_PLACEMENT.pitch === 6.2
    && SIJEON_PLACEMENT.depth === 8.5
    && SIJEON_PLACEMENT.setback === 1.4
    && SIJEON_PLACEMENT.runCap === 26,
'legacy placement dimensions drifted');

const horizontal = {
  id: 'east-west',
  level: 'daero',
  width: 10,
  pts: [{ x: -50, z: 0 }, { x: 50, z: 0 }],
};
const vertical = {
  id: 'north-south',
  level: 'daero',
  width: 12,
  pts: [{ x: 0, z: -50 }, { x: 0, z: 50 }],
};
const ignored = {
  id: 'minor',
  level: 'gil',
  width: 3,
  pts: [{ x: -50, z: 20 }, { x: 50, z: 20 }],
};
const roadsResult = { roads: [horizontal, vertical, ignored] };
const site = { center: { x: 0, z: 0 }, bowlR: 100 };
const placementInputBefore = stableJson({ roadsResult, site });

const first = withoutGlobalRandom(() => planSijeon(roadsResult, site, 0), 'placement:first');
const repeated = withoutGlobalRandom(() => planSijeon(roadsResult, site, 1), 'placement:repeat');
assertFiniteTree(first, 'placement');
invariant(stableJson({ roadsResult, site }) === placementInputBefore,
  'placement mutated its roads or site input');
invariant(stableJson(first) === stableJson(repeated),
  'placement changed across repeated/char01 inputs');
invariant(first.length === 24, `crossing arterial fixture produced ${first.length}, expected 24`);
invariant(hash(first) === '8bdb4fb03f7ef77af68704c6d45ed658a8ad5091be56f3006c307d97913c6e85',
  `legacy placement bytes drifted: ${hash(first)}`);

for (const [index, shop] of first.entries()) {
  invariant(shop.id === `s${index}`, `${shop.id}: IDs are not stable and contiguous`);
  invariant(shop.w === 6.2 && shop.d === 8.5, `${shop.id}: placement dimensions drifted`);
  invariant(shop.poly.length === 4, `${shop.id}: footprint is not a quadrilateral`);
  const centroid = G.polyCentroid(shop.poly);
  invariant(Object.is(shop.center.x, centroid.x) && Object.is(shop.center.z, centroid.z),
    `${shop.id}: center no longer preserves the exact legacy centroid`);
  invariant(Math.abs(G.len(shop.frontDir) - 1) < 1e-12,
    `${shop.id}: frontDir is not normalized`);
  const road = Math.abs(shop.frontDir.x) > 0.5 ? vertical : horizontal;
  invariant(G.polylinePolygonDistance(road.pts, shop.poly) >= road.width / 2 + 1.4 - 1e-9,
    `${shop.id}: footprint entered its road corridor`);
}

const shortRoad = {
  level: 'daero',
  width: 8,
  pts: [{ x: -22, z: 0 }, { x: 22, z: 0 }],
};
invariant(planSijeon({ roads: [shortRoad] }, site).length === 4,
  'minimum usable arterial fixture changed');
invariant(planSijeon({ roads: [{ ...shortRoad, level: 'gil' }] }, site).length === 0,
  'non-arterial road produced shops');
invariant(planSijeon({ roads: [] }, site).length === 0,
  'empty road set should produce an empty plan');

let facadeCases = 0;
for (const width of [4.4, 5.2, 6.2, 8, 12.5]) {
  for (const depth of [5.6, 6.4, 8.5, 11, 18]) {
    const label = `${width}x${depth}`;
    const facade = withoutGlobalRandom(
      () => planSijeonFacade({ w: width, d: depth }),
      `facade:${label}`,
    );
    const repeat = withoutGlobalRandom(
      () => planSijeonFacade({ w: width, d: depth }),
      `facade:${label}:repeat`,
    );
    invariant(stableJson(facade) === stableJson(repeat),
      `${label}: facade is not deterministic`);
    invariant(stableJson(JSON.parse(JSON.stringify(facade))) === stableJson(facade),
      `${label}: facade is not JSON-serializable`);
    assertFacade(facade, label);
    facadeCases++;
  }
}

// Deterministic local PRNG: broad dimension fuzz without using the ambient RNG
// whose non-consumption is itself part of the production contract.
let fuzzState = 0x5a17e0;
const fuzz01 = () => {
  fuzzState = (Math.imul(fuzzState, 1664525) + 1013904223) >>> 0;
  return fuzzState / 0x100000000;
};
for (let index = 0; index < 256; index++) {
  const width = 4.4 + fuzz01() * 20;
  const depth = 5.6 + fuzz01() * 28;
  const facade = withoutGlobalRandom(
    () => planSijeonFacade({ w: width, d: depth }),
    `facade:fuzz:${index}`,
  );
  assertFacade(facade, `fuzz:${index}`);
  facadeCases++;
}

for (const invalid of [
  null,
  {},
  { w: NaN, d: 8.5 },
  { w: Infinity, d: 8.5 },
  { w: 6.2, d: NaN },
  { w: 0, d: 8.5 },
  { w: 4.39, d: 8.5 },
  { w: 6.2, d: 5.59 },
]) {
  let rejected = false;
  try {
    planSijeonFacade(invalid);
  } catch (error) {
    rejected = error instanceof TypeError || error instanceof RangeError;
  }
  invariant(rejected, `invalid facade input was accepted: ${JSON.stringify(invalid)}`);
}

console.log(`check-sijeon-contract: PASS (${first.length} placement records, ${facadeCases} facade cases)`);
