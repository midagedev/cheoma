// 빠른 순수 plan 회귀 게이트. Playwright·THREE·네트워크 없이 5규모 × 절 OFF/ON을 검사한다.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planVillage } from '../src/api/village-plan.js';
import * as G from '../src/core/math/geom2.js';
import {
  cityWallClearance,
  cityWallContainsPolygon,
  cityWallOutsidePolygon,
  worldEdgeClearance,
  worldEdgeContainsPolygon,
} from '../src/village/citywall-contour.js';
import { parcelWorldPoint } from '../src/village/parcel-contract.js';
import { createRoadSpatialIndex } from '../src/village/road-spatial.js';
import { streamIntersectsPolygon } from '../src/village/stream-spatial.js';
import {
  TEMPLE_PAD_LIFT,
  TEMPLE_MAX_COMPOUND_SIZE,
  TEMPLE_MAX_RELIEF,
  TEMPLE_MIN_COMPOUND_SIZE,
  TEMPLE_PATH_WIDTH,
  templeCompoundDepth,
  templeCompoundSize,
  templeCompoundWidth,
  templeFootprint,
  templeReservationPolygons,
} from '../src/village/temple-plan.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(HERE, 'plan-contract.json'), 'utf8'));
const scales = ['hamlet', 'village', 'town', 'capital', 'hanyang'];

function canonical(value, seen = new WeakSet()) {
  if (typeof value === 'function' || value === undefined) return undefined;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`non-finite number in plan: ${value}`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (ArrayBuffer.isView(value)) return Array.from(value);
  if (Array.isArray(value)) return value.map((item) => canonical(item, seen));
  if (typeof value === 'object') {
    if (seen.has(value)) throw new Error('cycle in plan data');
    seen.add(value);
    const out = {};
    for (const key of Object.keys(value).sort()) {
      const item = canonical(value[key], seen);
      if (item !== undefined) out[key] = item;
    }
    seen.delete(value);
    return out;
  }
  return String(value);
}

function buildWithoutGlobalRandom(options) {
  const original = Math.random;
  Math.random = () => { throw new Error('planVillage consumed global Math.random'); };
  try { return planVillage(options); }
  finally { Math.random = original; }
}

function snapshot(options) {
  const before = JSON.stringify(options);
  const plan = buildWithoutGlobalRandom(options);
  if (JSON.stringify(options) !== before) throw new Error('planVillage mutated input options');
  const json = JSON.stringify(canonical(plan));
  return {
    plan,
    json,
    bytes: Buffer.byteLength(json),
    hash: createHash('sha256').update(json).digest('hex'),
  };
}

const errors = [];

function assertTempleContract(plan, label) {
  const temple = plan.features.temple;
  const size = templeCompoundSize(temple);
  const width = templeCompoundWidth(temple);
  const depth = templeCompoundDepth(temple);
  const footprint = templeFootprint(temple);
  const placement = temple.placement || {};
  const fail = (message) => errors.push(`${label}: ${message}`);

  if (size < TEMPLE_MIN_COMPOUND_SIZE || size > TEMPLE_MAX_COMPOUND_SIZE) {
    fail(`compound size ${size} outside ${TEMPLE_MIN_COMPOUND_SIZE}..${TEMPLE_MAX_COMPOUND_SIZE}m`);
  }
  if (placement.footprintDrop > TEMPLE_MAX_RELIEF) {
    fail(`footprint drop ${placement.footprintDrop}m exceeds ${TEMPLE_MAX_RELIEF}m`);
  }
  if (!['road', 'gate', 'center'].includes(placement.pathSource)) {
    fail(`approach source ${placement.pathSource || 'missing'} is not a road, city gate, or empty-site center`);
  }
  if (placement.pathSource === 'center' && plan.roads.length) {
    fail('center approach is only valid in a road-free solo temple composition');
  }
  if (!worldEdgeContainsPolygon(plan.site.edge, footprint, 4)) fail('footprint crosses the world edge');
  const terrainR = plan.site.terrainR || plan.site.R;
  if (footprint.some((point) => Math.hypot(point.x, point.z) > terrainR - 6)) {
    fail('footprint crosses the rendered terrain');
  }
  if (createRoadSpatialIndex(plan.roads).intersectsRoadCorridor(footprint, 2)) {
    fail('footprint overlaps a road corridor');
  }
  if (streamIntersectsPolygon(plan.site, footprint, 4)) fail('footprint overlaps the stream bank');

  let sampledMax = -Infinity;
  const frame = { center: temple, frontDir: temple.frontDir };
  for (let row = 0; row <= 4; row++) for (let column = 0; column <= 4; column++) {
    const point = parcelWorldPoint(frame, {
      x: -width * 0.5 + width * column / 4,
      z: -depth * 0.5 + depth * row / 4,
    });
    sampledMax = Math.max(sampledMax, plan.site.heightAt(point.x, point.z));
  }
  if (Math.abs(temple.baseY - sampledMax - TEMPLE_PAD_LIFT) > 1e-8) {
    fail(`baseY ${temple.baseY} does not cover the sampled precinct maximum ${sampledMax}`);
  }

  const path = temple.path || [];
  if (path.length < 2) fail('approach path has fewer than two points');
  else {
    const expectedStart = parcelWorldPoint(frame, { x: 0, z: depth * 0.5 });
    if (G.dist(path[0], expectedStart) > 1e-8) fail('approach does not start at the south gate');
    const edgeMargin = TEMPLE_PATH_WIDTH * 0.5 + 0.4;
    for (let index = 0; index < path.length; index++) {
      if (worldEdgeClearance(plan.site.edge, path[index]) < edgeMargin) {
        fail(`approach point ${index} crosses the world edge`);
        break;
      }
      if (Math.hypot(path[index].x, path[index].z) > terrainR - edgeMargin - 4) {
        fail(`approach point ${index} crosses the rendered terrain`);
        break;
      }
      if (index && G.dist(path[index - 1], path[index]) > 4) {
        fail(`approach sample gap ${G.dist(path[index - 1], path[index]).toFixed(3)}m exceeds 4m`);
        break;
      }
    }
    const endpoint = path[path.length - 1];
    if (placement.pathSource === 'road') {
      const road = plan.roads.find((candidate) => candidate.id === placement.pathRoadId);
      if (!road || G.distToPolyline(endpoint, road.pts).d > 1e-7) fail('approach endpoint misses its road');
    } else if (placement.pathSource === 'gate') {
      const gate = plan.features.cityWall?.gates?.find((candidate) => candidate.name === placement.pathGate);
      if (!gate || G.dist(endpoint, gate) > 1e-7) fail('approach endpoint misses its city gate');
    } else if (placement.pathSource === 'center') {
      if (G.dist(endpoint, plan.site.center) > 1e-7) fail('solo approach endpoint misses the site center');
    }
  }

  const cityWall = plan.features.cityWall;
  if (cityWall && placement.wallSide === 'inside') {
    if (!cityWallContainsPolygon(cityWall, footprint, 4)) fail('inside temple footprint crosses the city wall');
    if (path.some((point) => cityWallClearance(cityWall, point) < TEMPLE_PATH_WIDTH * 0.5 + 0.4)) {
      fail('inside temple approach crosses the city wall');
    }
  } else if (cityWall && placement.wallSide === 'outside') {
    if (!cityWallOutsidePolygon(cityWall, footprint, 4)) fail('outside temple footprint touches the city wall');
  }

  const reservations = templeReservationPolygons(temple);
  const overlapsReservation = (polygon) => polygon?.length
    && reservations.some((reservation) => G.polysOverlap(polygon, reservation));
  if (plan.parcels.some((parcel) => overlapsReservation(parcel.poly))) fail('a parcel overlaps the temple reservation');
  if ((plan.features.sijeon || []).some((shop) => overlapsReservation(shop.poly))) {
    fail('a market shop overlaps the temple reservation');
  }
  if ((plan.paddies || []).some((field) => overlapsReservation(field.poly))) {
    fail('a paddy overlaps the temple reservation');
  }
}

for (const includeTemple of [false, true]) {
  for (const scale of scales) {
    const label = `${scale}:${includeTemple ? 'temple' : 'base'}`;
    const options = Object.freeze({
      scale,
      seed: fixture.seed,
      includeTemple,
      includePalace: scale === 'capital' || scale === 'hanyang',
    });
    const a = snapshot(options);
    const b = snapshot(options);
    const expected = fixture.cases[label];

    if (a.hash !== b.hash) errors.push(`${label}: repeated builds differ (${a.hash} != ${b.hash})`);
    if (!includeTemple && a.plan.features?.temple) errors.push(`${label}: temple exists while includeTemple=false`);
    if (includeTemple && !a.plan.features?.temple) errors.push(`${label}: temple missing while includeTemple=true`);
    if (includeTemple && a.plan.features?.temple) assertTempleContract(a.plan, label);
    if (!expected) errors.push(`${label}: fixture missing`);
    else {
      if (a.hash !== expected.hash) errors.push(`${label}: hash ${a.hash} != ${expected.hash}`);
      if (a.bytes !== expected.bytes) errors.push(`${label}: bytes ${a.bytes} != ${expected.bytes}`);
    }

    console.log(
      `${label.padEnd(18)} ${a.hash.slice(0, 12)}  bytes=${String(a.bytes).padStart(6)}`
      + `  parcels=${String(a.plan.parcels.length).padStart(3)}`,
    );
  }
}

if (errors.length) {
  console.error(`PLAN CONTRACT: FAIL (${errors.length})`);
  for (const error of errors) console.error(`  - ${error}`);
  console.error('If the plan change is intentional, review every diff before updating tools/plan-contract.json.');
  process.exit(1);
}

console.log(`PLAN CONTRACT: PASS (${Object.keys(fixture.cases).length} golden cases, baseline ${fixture.baselineCommit})`);
