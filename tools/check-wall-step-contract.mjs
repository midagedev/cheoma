import assert from 'node:assert/strict';
import { planVillage } from '../src/api/village-plan.js';
import { makeRng } from '../src/rng.js';
import { buildVillageDoorParcelRecords } from '../src/runtime/village/village-door-records.js';
import {
  VILLAGE_WALL_STEP,
  splitVillageWallGate,
  villageWallLayout,
} from '../src/village/wall-contract.js';
import {
  parcelWorldPoint,
  rectangularParcelShape,
} from '../src/village/parcel-contract.js';
import { terrainRangeOnPolygon } from '../src/village/placement-search.js';
import {
  terrainMeshHeightAt,
  terrainMeshSegmentRange,
} from '../src/village/terrain-grid.js';

const EPSILON = 1e-8;
const shape = rectangularParcelShape(16, 12);
const parcel = {
  id: 'stepped-wall-fixture',
  kind: 'giwa',
  wallType: 'tile',
  seed: 19,
  center: { x: 0, z: 0 },
  frontDir: { x: 0, z: 1 },
  shape,
  plotW: 16,
  plotD: 12,
  sx: 1,
  sy: 1,
  sz: 1,
  baseY: 0,
  access: { gateEdge: 0, gateT: 0.5 },
};
const flatSite = {
  R: 64,
  terrainR: 64,
  heightAt() { return 0; },
};
const slopeSite = {
  R: 64,
  terrainR: 64,
  heightAt(x, z) { return x * 0.09 + z * 0.015; },
};
const reliefSite = {
  R: 64,
  terrainR: 64,
  heightAt(x, z) { return Math.sin(x * 0.21) * 2 + Math.cos(z * 0.17) * 1.5; },
};

const reliefA = { x: -30.3, z: -20.7 }, reliefB = { x: 34.1, z: 28.6 };
const exactRelief = terrainMeshSegmentRange(reliefSite, reliefA, reliefB);
let denseMin = Infinity, denseMax = -Infinity;
for (let sample = 0; sample <= 8192; sample++) {
  const t = sample / 8192;
  const height = terrainMeshHeightAt(
    reliefSite,
    reliefA.x + (reliefB.x - reliefA.x) * t,
    reliefA.z + (reliefB.z - reliefA.z) * t,
  );
  denseMin = Math.min(denseMin, height);
  denseMax = Math.max(denseMax, height);
}
assert(exactRelief.min <= denseMin && denseMin - exactRelief.min < 0.001,
  'exact terrain segment minimum missed a triangle boundary');
assert(exactRelief.max >= denseMax && exactRelief.max - denseMax < 0.001,
  'exact terrain segment maximum missed a triangle boundary');

function layout(style, site = null) {
  return villageWallLayout(shape, {
    style,
    char01: 0.5,
    wallHeightK: 1,
    plotW: parcel.plotW,
    plotD: parcel.plotD,
    gateEdge: parcel.access.gateEdge,
    gateT: parcel.access.gateT,
    ...(site ? { parcel, site, baseY: parcel.baseY } : {}),
  }, () => 0.5);
}

for (const style of ['tile', 'stone', 'mud', 'brush', 'hedge', 'open']) {
  assert.deepEqual(layout(style, flatSite), layout(style),
    `${style}: flat terrain must retain the exact legacy wall layout`);
}

for (const style of ['tile', 'stone', 'mud']) {
  const stepped = layout(style, slopeSite);
  assert(stepped.edgeLayouts.some((edge) => edge.runs.some((run) =>
    (run.bottomOffset || 0) !== 0 || (run.topOffset || 0) !== 0)),
  `${style}: sloped terrain did not produce steps`);
  for (const edge of stepped.edgeLayouts) {
    assert(edge.runs.length <= VILLAGE_WALL_STEP.maxRunsPerEdge,
      `${style}: edge ${edge.index} exceeded the segment cap`);
    for (let index = 1; index < edge.runs.length; index++) {
      const previous = edge.runs[index - 1];
      const run = edge.runs[index];
      const delta = Math.abs((run.topOffset || 0) - (previous.topOffset || 0));
      assert(delta <= VILLAGE_WALL_STEP.rise + EPSILON,
        `${style}: edge ${edge.index} has a pitched-size ${delta.toFixed(3)}m jump`);
      const bottomDelta = Math.abs((run.bottomOffset || 0) - (previous.bottomOffset || 0));
      assert(bottomDelta <= VILLAGE_WALL_STEP.rise + EPSILON,
        `${style}: edge ${edge.index} has a ${bottomDelta.toFixed(3)}m retaining jump`);
    }
  }
  const gateEdge = stepped.edgeLayouts.find((edge) => edge.index === stepped.gate.edge);
  const split = splitVillageWallGate(shape.pts[0], shape.pts[1], stepped.gate.centerT, stepped.gate.gap);
  const leftLanding = gateEdge.runs.find((run) =>
    Math.hypot(run.b.x - split.left.x, run.b.z - split.left.z) <= EPSILON);
  const rightLanding = gateEdge.runs.find((run) =>
    Math.hypot(run.a.x - split.right.x, run.a.z - split.right.z) <= EPSILON);
  assert(leftLanding && rightLanding, `${style}: gate landing spans were not preserved`);
  assert(Math.hypot(
    leftLanding.b.x - leftLanding.a.x,
    leftLanding.b.z - leftLanding.a.z,
  ) >= VILLAGE_WALL_STEP.gateLanding - EPSILON, `${style}: left gate landing is too short`);
  assert(Math.hypot(
    rightLanding.b.x - rightLanding.a.x,
    rightLanding.b.z - rightLanding.a.z,
  ) >= VILLAGE_WALL_STEP.gateLanding - EPSILON, `${style}: right gate landing is too short`);
  assert.equal(leftLanding?.topOffset || 0, 0,
    `${style}: left gate landing moved vertically`);
  assert.equal(rightLanding?.topOffset || 0, 0,
    `${style}: right gate landing moved vertically`);
}

const renderedLayout = layout('tile', slopeSite);
const semanticRecords = buildVillageDoorParcelRecords(
  { ...parcel, wallHeightK: 1 },
  slopeSite,
  0.5,
);
for (const edge of renderedLayout.edgeLayouts) {
  for (let index = 0; index < edge.runs.length; index++) {
    const run = edge.runs[index];
    const record = semanticRecords.find((candidate) =>
      candidate.id === `parcel:${parcel.id}:wall:edge:${edge.index}:${index}`);
    assert(record, `semantic wall record missing for edge ${edge.index}:${index}`);
    const solid = record.solids[0];
    assert(Math.abs(solid.minY - (parcel.baseY + (run.bottomOffset || 0))) <= EPSILON,
      `semantic bottom drifted on edge ${edge.index}:${index}`);
    assert(Math.abs(solid.maxY - (parcel.baseY + edge.height + (run.topOffset || 0))) <= EPSILON,
      `semantic top drifted on edge ${edge.index}:${index}`);
  }
}

let realSolids = 0, realStepped = 0, minimumVisible = Infinity;
for (const scale of ['hamlet', 'village', 'town', 'capital', 'hanyang']) {
  const plan = planVillage({ scale, seed: 1 });
  let scaleStepped = 0;
  for (const realParcel of plan.parcels) {
    const style = realParcel.wallType || 'stone';
    if (realParcel.hero || !['tile', 'stone', 'mud'].includes(style)) continue;
    realSolids++;
    const baseY = terrainRangeOnPolygon(plan.site, realParcel.poly, 5).max + 0.06;
    const realLayout = villageWallLayout(realParcel.shape, {
      style,
      char01: plan.opts.char01,
      wallHeightK: realParcel.wallHeightK,
      plotW: realParcel.plotW,
      plotD: realParcel.plotD,
      gateEdge: realParcel.access?.gateEdge,
      gateT: realParcel.access?.gateT,
      parcel: realParcel,
      site: plan.site,
      baseY,
    }, makeRng((((realParcel.seed | 0) || 7) ^ 0x51de) >>> 0));
    let parcelStepped = false;
    for (const edge of realLayout.edgeLayouts) {
      assert(edge.runs.length <= VILLAGE_WALL_STEP.maxRunsPerEdge,
        `${scale}:${realParcel.id}: exceeded the real-scene segment cap`);
      for (const run of edge.runs) {
        parcelStepped ||= (run.bottomOffset || 0) !== 0 || (run.topOffset || 0) !== 0;
        const terrain = terrainMeshSegmentRange(
          plan.site,
          parcelWorldPoint(realParcel, run.a),
          parcelWorldPoint(realParcel, run.b),
        );
        minimumVisible = Math.min(
          minimumVisible,
          baseY + edge.height + (run.topOffset || 0) - terrain.max,
        );
      }
    }
    if (parcelStepped) { realStepped++; scaleStepped++; }
  }
  assert(scaleStepped > 0, `${scale}: representative plan produced no stepped solid wall`);
}
assert(minimumVisible >= VILLAGE_WALL_STEP.minVisible - 1e-6,
  `real-scene wall visibility fell to ${minimumVisible.toFixed(3)}m`);

console.log(
  `WALL STEP CONTRACT: PASS (flat exact, 3 solid styles, ${realStepped}/${realSolids} real stepped, `
  + `min visible ${minimumVisible.toFixed(2)}m, cap/landing/semantic parity)`,
);
