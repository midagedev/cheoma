import { performance } from 'node:perf_hooks';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { planVillage } from '../src/api/village-plan.js';
import {
  DRAINAGE_PLAN_LIMITS,
  DRAINAGE_PLAN_SCHEMA_VERSION,
  planRoadsideDrainage,
  validateRoadsideDrainagePlan,
} from '../src/api/drainage-plan.js';
import * as G from '../src/core/math/geom2.js';
import { terrainMeshHeightAt } from '../src/village/terrain-grid.js';
import { streamClearanceAt } from '../src/village/stream-spatial.js';

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function deepFrozen(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return true;
  seen.add(value);
  return Object.isFrozen(value) && Object.values(value).every((child) => deepFrozen(child, seen));
}

function inputSnapshot(plan) {
  return JSON.stringify({
    roads: plan.roads,
    parcels: plan.parcels,
    paddies: plan.paddies,
  });
}

function build(plan) {
  const before = inputSnapshot(plan);
  const originalRandom = Math.random;
  Math.random = () => { throw new Error('drainage plan consumed global Math.random'); };
  let drainage;
  try {
    drainage = planRoadsideDrainage({
      roads: plan.roads,
      parcels: plan.parcels,
      site: plan.site,
      productionPolygons: plan.paddies,
    });
  } finally {
    Math.random = originalRandom;
  }
  invariant(inputSnapshot(plan) === before, `${plan.scale} drainage mutated village inputs`);
  return drainage;
}

function polygonClearance(run, polygons) {
  const margin = run.width * 0.5 + DRAINAGE_PLAN_LIMITS.obstacleClearance;
  for (let index = 0; index < run.points.length - 1; index++) {
    for (const polygon of polygons) {
      invariant(G.segmentPolygonDistance(run.points[index], run.points[index + 1], polygon) + 1e-7 >= margin,
        `${run.id} overlaps a reserved polygon`);
    }
  }
}

function assertPlanContract(village, drainage) {
  invariant(drainage.schema === DRAINAGE_PLAN_SCHEMA_VERSION, 'schema version drift');
  invariant(deepFrozen(drainage), `${village.scale} drainage is not deeply frozen`);
  invariant(JSON.parse(JSON.stringify(drainage)).schema === DRAINAGE_PLAN_SCHEMA_VERSION,
    `${village.scale} drainage is not JSON-safe`);
  validateRoadsideDrainagePlan(drainage);
  validateRoadsideDrainagePlan(JSON.parse(JSON.stringify(drainage)));
  invariant(drainage.runs.length <= DRAINAGE_PLAN_LIMITS.maxRuns, 'run cap exceeded');
  invariant(drainage.crossings.length <= DRAINAGE_PLAN_LIMITS.maxCrossings, 'crossing cap exceeded');

  if (['hamlet', 'village', 'town'].includes(village.scale)) {
    invariant(drainage.runs.length === 0 && drainage.crossings.length === 0,
      `${village.scale} must fail closed without ordinary rural drainage`);
  }

  const roads = new Map(village.roads.map((road) => [road.id, road]));
  const parcels = new Map(village.parcels.map((parcel) => [parcel.id, parcel]));
  const reserved = [
    ...village.parcels.map((parcel) => parcel.poly).filter(Boolean),
    ...(village.paddies || []).map((field) => field.poly).filter(Boolean),
  ];
  const sidesByRoad = new Map();
  for (const run of drainage.runs) {
    const road = roads.get(run.roadId);
    invariant(road, `${run.id} references missing road`);
    invariant(village.scale !== 'capital' || ['daero', 'jungno'].includes(road.level),
      `${run.id} puts capital drainage on ${road.level}`);
    invariant(village.scale !== 'hanyang' || ['daero', 'jungno', 'soro'].includes(road.level),
      `${run.id} puts Hanyang drainage on ${road.level}`);
    let sides = sidesByRoad.get(run.roadId);
    if (!sides) sidesByRoad.set(run.roadId, sides = new Set());
    sides.add(run.side);

    for (const point of run.points) {
      const terrainY = terrainMeshHeightAt(village.site, point.x, point.z);
      const lift = point.y - terrainY;
      invariant(lift + 1e-8 >= DRAINAGE_PLAN_LIMITS.bedClearance,
        `${run.id} hides its bed below terrain`);
      invariant(lift <= DRAINAGE_PLAN_LIMITS.bedClearance
        + DRAINAGE_PLAN_LIMITS.maxBedLift + 1e-8,
      `${run.id} floats too far above terrain`);
      invariant(G.distToPolyline(point, road.pts).d + 1e-5 >= (
        road.width * 0.5 + DRAINAGE_PLAN_LIMITS.shoulder + run.width * 0.5
      ), `${run.id} enters its road corridor`);
      invariant(streamClearanceAt(village.site, point) + 1e-7 >= (
        run.width * 0.5 + DRAINAGE_PLAN_LIMITS.streamClearance
      ), `${run.id} enters the stream reservation`);
    }
    polygonClearance(run, reserved);
  }
  if (village.scale === 'capital') {
    for (const [roadId, sides] of sidesByRoad) {
      invariant(sides.size <= 1, `${roadId} has both sides drained in capital`);
    }
  }

  const runById = new Map(drainage.runs.map((run) => [run.id, run]));
  for (const crossing of drainage.crossings) {
    const parcel = parcels.get(crossing.parcelId);
    const run = runById.get(crossing.runId);
    invariant(parcel?.access && run, `${crossing.id} lost access ownership`);
    invariant(G.dist(crossing.gatePoint, parcel.access.gatePoint) <= 1e-9
      && G.dist(crossing.roadPoint, parcel.access.roadPoint) <= 1e-9,
    `${crossing.id} drifted from stored parcel access`);
    const axis = G.norm(G.sub(crossing.roadPoint, crossing.gatePoint));
    invariant(Math.abs(crossing.yaw - Math.atan2(axis.x, axis.z)) <= 1e-9,
      `${crossing.id} yaw is not gate-to-road aligned`);
    invariant(G.distToSeg(crossing.center, crossing.gatePoint, crossing.roadPoint).d <= 1e-7,
      `${crossing.id} center left the access axis`);
    invariant(G.distToPolyline(crossing.center, run.points).d <= 1e-7,
      `${crossing.id} does not cross its ditch`);
    const runHit = G.distToPolyline(crossing.center, run.points);
    const runA = run.points[runHit.seg], runB = run.points[runHit.seg + 1];
    const expectedDeckY = runA.y + (runB.y - runA.y) * runHit.t
      + DRAINAGE_PLAN_LIMITS.depth + DRAINAGE_PLAN_LIMITS.crossingLift;
    invariant(Math.abs(crossing.center.y - expectedDeckY) <= 1e-7,
      `${crossing.id} deck does not clear its lifted channel lip`);
  }
}

const source = readFileSync(fileURLToPath(
  new URL('../src/village/drainage-plan.js', import.meta.url),
), 'utf8');
invariant(!/from\\s+['\"]three['\"]|\\bTHREE\\b|\\bdocument\\b|\\bwindow\\b/.test(source),
  'drainage plan imported a renderer or DOM dependency');

let runCount = 0;
let crossingCount = 0;
let totalLength = 0;
const started = performance.now();
for (const scale of ['hamlet', 'village', 'town', 'capital', 'hanyang']) {
  const village = planVillage({
    scale,
    seed: 11,
    includePalace: scale === 'capital' || scale === 'hanyang',
  });
  const first = build(village);
  const second = build(village);
  invariant(JSON.stringify(first) === JSON.stringify(second), `${scale} drainage is not deterministic`);
  assertPlanContract(village, first);
  runCount += first.runs.length;
  crossingCount += first.crossings.length;
  totalLength += first.runs.reduce((sum, run) => sum + run.length, 0);
  console.log(`${scale.padEnd(8)} runs=${String(first.runs.length).padStart(3)} `
    + `crossings=${String(first.crossings.length).padStart(3)} `
    + `length=${first.runs.reduce((sum, run) => sum + run.length, 0).toFixed(1)}m`);
}

invariant(runCount > 0 && crossingCount > 0 && totalLength > 100,
  'planned-city fixtures did not exercise drainage and gate crossings');

console.log(`DRAINAGE PLAN: PASS (${runCount} runs, ${crossingCount} crossings, `
  + `${totalLength.toFixed(1)}m, ${(performance.now() - started).toFixed(0)}ms)`);
