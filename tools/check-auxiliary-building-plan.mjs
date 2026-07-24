import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as G from '../src/core/math/geom2.js';
import {
  auxiliaryHardObstacle,
  auxiliaryLocalFootprint,
  auxiliaryObstructionPolygons,
  auxiliarySolarObstruction,
  auxiliaryWorldFootprint,
  planParcelAuxiliary,
} from '../src/api/auxiliary-building-plan.js';
import { parcelLocalRoofRectangles } from '../src/village/house-footprint.js';
import {
  parcelHouseTranslation,
  parcelWorldPoint,
} from '../src/village/parcel-contract.js';
import { planVillage } from '../src/village/plan.js';
import { yardHardObstacles } from '../src/village/yard-layout.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCALES = ['hamlet', 'village', 'town', 'capital', 'hanyang'];
const SEEDS = [7, 42, 91, 20260716];
const EXPECTED_TOP_KEYS = [
  'body', 'footprint', 'id', 'local', 'role', 'roof', 'roofTopY',
];
const EXPECTED_LOCAL_KEYS = ['x', 'yaw', 'z'];
const EXPECTED_BODY_KEYS = ['depth', 'height', 'width'];
const EXPECTED_ROOF_KEYS = ['covering', 'form', 'overhang', 'rise'];
const GATE_GAP = 0.82;
const TARGET_LIFT = 1.5;
const SOLAR_ALTITUDE = Math.PI / 6;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function keys(value) {
  return Object.keys(value).sort();
}

function near(actual, expected, message, epsilon = 1e-9) {
  invariant(Math.abs(actual - expected) <= epsilon,
    `${message}: ${actual} != ${expected}`);
}

function rectangle(rect) {
  return [
    { x: rect.minX, z: rect.minZ },
    { x: rect.maxX, z: rect.minZ },
    { x: rect.maxX, z: rect.maxZ },
    { x: rect.minX, z: rect.maxZ },
  ];
}

function onOrInside(point, polygon) {
  if (G.pointInPoly(point, polygon)) return true;
  return polygon.some((edge, index) => (
    G.distToSeg(point, edge, polygon[(index + 1) % polygon.length]).d <= 1e-8
  ));
}

function localSolarPolygon(parcel, roofTopY) {
  const access = parcel.solarAccess;
  if (!access) return null;
  const length = Math.max(
    0,
    (roofTopY - TARGET_LIFT) / Math.tan(SOLAR_ALTITUDE),
  );
  const end = Math.min(access.localEnd, access.localStart + length);
  if (end <= access.localStart + 1e-8) return null;
  return [
    { x: -access.halfWidth, z: access.localStart },
    { x: access.halfWidth, z: access.localStart },
    { x: access.halfWidth, z: end },
    { x: -access.halfWidth, z: end },
  ];
}

function expectedFootprint(spec) {
  const halfWidth = spec.body.width * 0.5 + spec.roof.overhang;
  const halfDepth = spec.body.depth * 0.5 + spec.roof.overhang;
  const c = Math.cos(spec.local.yaw), s = Math.sin(spec.local.yaw);
  return [
    { x: -halfWidth, z: -halfDepth },
    { x: halfWidth, z: -halfDepth },
    { x: halfWidth, z: halfDepth },
    { x: -halfWidth, z: halfDepth },
  ].map((point) => ({
    x: spec.local.x + point.x * c + point.z * s,
    z: spec.local.z - point.x * s + point.z * c,
  }));
}

function validateSpec(parcel, spec, site) {
  invariant(JSON.stringify(keys(spec)) === JSON.stringify(EXPECTED_TOP_KEYS),
    `${parcel.id}: top-level schema drifted`);
  invariant(JSON.stringify(keys(spec.local)) === JSON.stringify(EXPECTED_LOCAL_KEYS),
    `${parcel.id}: local schema drifted`);
  invariant(JSON.stringify(keys(spec.body)) === JSON.stringify(EXPECTED_BODY_KEYS),
    `${parcel.id}: body schema drifted`);
  invariant(JSON.stringify(keys(spec.roof)) === JSON.stringify(EXPECTED_ROOF_KEYS),
    `${parcel.id}: roof schema drifted`);
  invariant(spec.id === 'aux-0' && spec.role === 'storehouse',
    `${parcel.id}: semantic identity drifted`);
  invariant(spec.roof.form === 'gable', `${parcel.id}: roof form drifted`);
  invariant(spec.roof.covering === (parcel.kind === 'giwa' ? 'tile' : 'thatch'),
    `${parcel.id}: roof covering no longer follows house kind`);
  invariant(Object.isFrozen(spec) && Object.isFrozen(spec.local)
    && Object.isFrozen(spec.body) && Object.isFrozen(spec.roof)
    && Object.isFrozen(spec.footprint),
  `${parcel.id}: plan is not deeply immutable`);

  near(spec.body.width, Math.min(parcel.plotW * 0.3, 3.2),
    `${parcel.id}: width was miniaturized`);
  near(spec.body.depth, Math.min(parcel.plotD * 0.22, 2.6),
    `${parcel.id}: depth was miniaturized`);
  invariant(spec.body.height >= 1.7 && spec.body.height < 1.9,
    `${parcel.id}: body height escaped the authored range`);
  near(spec.roof.overhang, 0.28, `${parcel.id}: overhang drifted`);
  near(spec.roof.rise, 0.6, `${parcel.id}: roof rise drifted`);
  near(spec.roofTopY, spec.body.height + spec.roof.rise,
    `${parcel.id}: local roof top drifted`);

  const expected = expectedFootprint(spec);
  invariant(spec.footprint.length === 4, `${parcel.id}: footprint is not a rectangle`);
  for (let index = 0; index < expected.length; index++) {
    near(spec.footprint[index].x, expected[index].x,
      `${parcel.id}: footprint x ${index}`);
    near(spec.footprint[index].z, expected[index].z,
      `${parcel.id}: footprint z ${index}`);
    invariant(onOrInside(spec.footprint[index], parcel.shape.pts),
      `${parcel.id}: footprint ${index} escaped the true parcel`);
  }
  for (const roof of parcelLocalRoofRectangles(parcel)) {
    invariant(!G.polysOverlap(spec.footprint, rectangle(roof)),
      `${parcel.id}: auxiliary roof overlaps the fitted main roof`);
  }

  const mainBounds = G.boundsOfPts(
    parcelLocalRoofRectangles(parcel).flatMap((roof) => rectangle(roof)),
  );
  const house = parcelHouseTranslation(parcel);
  const gate = parcel.access?.gateLocalPoint || {
    x: 0,
    z: Math.max(...parcel.shape.pts.map((point) => point.z)),
  };
  invariant(G.segmentPolygonDistance(
    { x: house.x, z: mainBounds.maxZ + 0.15 },
    gate,
    spec.footprint,
  ) > GATE_GAP,
  `${parcel.id}: auxiliary blocks the house-to-gate approach`);

  const ownSolar = localSolarPolygon(parcel, spec.roofTopY);
  invariant(!ownSolar || !G.polysOverlap(spec.footprint, ownSolar),
    `${parcel.id}: auxiliary blocks its household's winter-sun opening`);

  invariant(auxiliaryLocalFootprint(spec) === spec.footprint,
    `${parcel.id}: local footprint helper did not preserve the immutable source`);
  const world = auxiliaryWorldFootprint(parcel, spec);
  for (let index = 0; index < world.length; index++) {
    const expectedWorld = parcelWorldPoint(parcel, spec.footprint[index]);
    near(world[index].x, expectedWorld.x, `${parcel.id}: world footprint x ${index}`);
    near(world[index].z, expectedWorld.z, `${parcel.id}: world footprint z ${index}`);
  }
  const obstructionPolygons = auxiliaryObstructionPolygons(parcel, spec);
  invariant(obstructionPolygons.length === 1
    && JSON.stringify(obstructionPolygons[0]) === JSON.stringify(world),
  `${parcel.id}: obstruction polygon diverged from the rendered footprint`);
  const solar = auxiliarySolarObstruction(parcel, spec, site);
  invariant(JSON.stringify(solar.polygon) === JSON.stringify(world),
    `${parcel.id}: solar polygon diverged from the rendered footprint`);
  near(solar.roofTopY, (
    Number.isFinite(parcel.baseY)
      ? parcel.baseY
      : site.heightAt(parcel.center.x, parcel.center.z)
  ) + spec.roofTopY, `${parcel.id}: absolute solar roof top drifted`);
  const hard = auxiliaryHardObstacle(spec);
  invariant(hard.kind === 'auxiliary-building' && hard.mode === 'canopy'
    && hard.shape === 'polygon'
    && JSON.stringify(hard.points) === JSON.stringify(spec.footprint),
  `${parcel.id}: hard-object footprint diverged from the plan`);
}

const source = await readFile(
  join(ROOT, 'src/village/auxiliary-building-plan.js'),
  'utf8',
);
for (const forbidden of [
  /from ['"]three(?:\/|['"])/,
  /\bwindow\./,
  /\bdocument\./,
  /\bMath\.random\b/,
  /from ['"].*yard-layout\.js['"]/,
]) {
  invariant(!forbidden.test(source),
    `renderer-free auxiliary planner contains forbidden dependency ${forbidden}`);
}

invariant(planParcelAuxiliary(null) === null, 'missing parcel did not fail closed');
invariant(planParcelAuxiliary({ aux: false }) === null, 'disabled aux did not fail closed');

let requested = 0;
let planned = 0;
let giwa = 0;
let choga = 0;
let first = null;
const fingerprints = new Set();
const originalRandom = Math.random;
try {
  for (const scale of SCALES) for (const seed of SEEDS) {
    const plan = planVillage({
      scale,
      seed,
      includePalace: scale === 'capital' || scale === 'hanyang',
    });
    for (const parcel of plan.parcels.filter((candidate) => candidate.aux && !candidate.hero)) {
      requested++;
      const hardObstacles = yardHardObstacles(parcel)
        .filter((obstacle) => !['aux', 'auxiliary-building'].includes(obstacle.kind));
      const before = JSON.stringify(parcel);
      Math.random = () => {
        throw new Error('auxiliary planning consumed global Math.random');
      };
      const a = planParcelAuxiliary(parcel, {
        site: plan.site,
        peers: plan.parcels,
        hardObstacles,
      });
      const b = planParcelAuxiliary(parcel, {
        site: plan.site,
        peers: plan.parcels,
        hardObstacles,
      });
      Math.random = originalRandom;
      invariant(JSON.stringify(parcel) === before,
        `${scale}:${seed}:${parcel.id} planner mutated its parcel`);
      invariant(JSON.stringify(a) === JSON.stringify(b),
        `${scale}:${seed}:${parcel.id} planner is nondeterministic`);
      if (!a) continue;
      planned++;
      if (parcel.kind === 'giwa') giwa++;
      else choga++;
      first ||= { parcel, spec: a, site: plan.site };
      validateSpec(parcel, a, plan.site);
      fingerprints.add(JSON.stringify(a));
    }
  }
} finally {
  Math.random = originalRandom;
}

invariant(requested > 0, 'fixed-seed cohort lost every requested auxiliary');
invariant(planned >= 100,
  `candidate solver over-pruned valid auxiliaries (${planned}/${requested})`);
invariant(giwa > 0 && choga > 0,
  `candidate solver lost a roof-covering family (giwa=${giwa}, choga=${choga})`);
invariant(fingerprints.size > 8,
  `dedicated parcel seed no longer produces useful placement variety (${fingerprints.size})`);
invariant(first, 'cohort produced no reusable auxiliary fixture');

const blockedByHardObject = planParcelAuxiliary(first.parcel, {
  enabled: true,
  site: first.site,
  hardObstacles: [{
    kind: 'test-reservation',
    mode: 'canopy',
    shape: 'rect',
    x: 0,
    z: 0,
    halfWidth: 1_000,
    halfDepth: 1_000,
  }],
});
invariant(blockedByHardObject === null,
  'planner miniaturized or escaped instead of respecting a hard-object reservation');

const peer = {
  id: 'solar-peer',
  kind: 'giwa',
  center: { ...first.parcel.center },
  frontDir: { ...first.parcel.frontDir },
  baseY: -100,
  solarAccess: { localStart: -100, localEnd: 100, halfWidth: 100 },
};
invariant(planParcelAuxiliary(first.parcel, {
  enabled: true,
  site: first.site,
  peers: [peer],
}) === null, 'planner placed an auxiliary through a neighbour winter-sun opening');

const tiny = {
  ...first.parcel,
  id: 'tiny-no-fallback',
  plotW: 3,
  plotD: 3,
  shape: {
    pts: [
      { x: -1.5, z: -1.5 }, { x: 1.5, z: -1.5 },
      { x: 1.5, z: 1.5 }, { x: -1.5, z: 1.5 },
    ],
  },
  access: null,
};
invariant(planParcelAuxiliary(tiny, { enabled: true }) === null,
  'planner created a miniature fallback on an impossible parcel');

console.log(
  `AUXILIARY BUILDING PLAN: PASS (${planned}/${requested} valid, `
  + `${giwa} tile, ${choga} thatch, ${fingerprints.size} distinct)`,
);
