// Pure JSON map export for external game engines (packaging-plan P3).
// Colliders reuse walk-solids; metadata flattens plan fields; terrain is a regular height grid.
// No three / DOM. Deterministic for a fixed plan (no Math.random / Date.now).

import {
  buildWalkSolids,
  makeWalkPolySolid,
  parcelHouseWalkSolids,
} from '../cinematic/walk-solids.js';
import {
  cityWallAngleInGate,
  normalOnCityWall,
  pointOnCityWall,
} from '../village/citywall-contour.js';
import { computeFixedRadius, terrainMeshHeightAt } from '../village/terrain-surface.js';
import { tierForR } from '../village/site.js';

const TAU = Math.PI * 2;
const DEFAULT_CITY_WALL_STEP = 3;
const DEFAULT_TERRAIN_STEP = 4;

/** Deep-clone via JSON so the result is free of functions / shared plan refs. */
function jsonClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isPlainJsonValue(value) {
  if (value === null) return true;
  const t = typeof value;
  if (t === 'string' || t === 'boolean') return true;
  if (t === 'number') return Number.isFinite(value);
  if (t === 'function' || t === 'undefined' || t === 'symbol' || t === 'bigint') return false;
  if (Array.isArray(value)) return value.every(isPlainJsonValue);
  if (t === 'object') {
    // Reject exotic objects (Map, typed arrays as opaque) by requiring plain own keys only.
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      return false;
    }
    for (const key of Object.keys(value)) {
      if (!isPlainJsonValue(value[key])) return false;
    }
    return true;
  }
  return false;
}

function assertJsonSafe(value, label) {
  if (!isPlainJsonValue(value)) {
    throw new Error(`map-data: ${label} is not JSON-safe`);
  }
  // Round-trip must preserve structure (also rejects NaN which becomes null in JSON).
  const text = JSON.stringify(value);
  if (text.includes('null') && JSON.stringify(value, (_k, v) => (Number.isNaN(v) ? '__NaN__' : v)).includes('__NaN__')) {
    throw new Error(`map-data: ${label} contains NaN`);
  }
  return value;
}

/**
 * Approximate a citywall annulus solid as rectangular strip polygons along the contour.
 * Gate angle intervals stay open (same cityWallAngleInGate rule as walk-solids point tests).
 * Water-gate angles stay solid, matching pointHitsWalkSolid (not cityWallAngleInAperture).
 *
 * @param {{type:'citywall', spec:object, half:number, kind?:string}} solid
 * @param {{step?:number}} [opts] arc-length sample step in meters (default 3)
 * @returns {Array<{type:'poly', pts:Array<{x:number,z:number}>}>}
 */
export function polygonizeCityWallSolid(solid, { step = DEFAULT_CITY_WALL_STEP } = {}) {
  if (!solid || solid.type !== 'citywall' || !solid.spec) return [];
  const spec = solid.spec;
  const half = Number.isFinite(solid.half) ? solid.half : 0;
  if (!(half > 0) || !spec.radii?.length) return [];

  const meanR = Number.isFinite(spec.meanRadius)
    ? spec.meanRadius
    : spec.radii.reduce((a, b) => a + b, 0) / spec.radii.length;
  const arcStep = Math.max(0.5, step);
  // Angular pitch from arc length at mean radius; densify slightly for non-circular contours.
  const dAngle = Math.min(TAU / 32, arcStep / Math.max(meanR, 1));
  const count = Math.max(32, Math.ceil(TAU / dAngle));
  const da = TAU / count;

  const polys = [];
  for (let i = 0; i < count; i++) {
    const a0 = i * da;
    const a1 = (i + 1) * da;
    const mid = a0 + da * 0.5;
    // Open the same gate wedges the analytic walker leaves passable.
    if (cityWallAngleInGate(spec, a0) || cityWallAngleInGate(spec, mid) || cityWallAngleInGate(spec, a1)) {
      continue;
    }
    const p0 = pointOnCityWall(spec, a0);
    const p1 = pointOnCityWall(spec, a1);
    const n0 = normalOnCityWall(spec, a0);
    const n1 = normalOnCityWall(spec, a1);
    // Rectangular strip: outer edge → outer edge → inner edge → inner edge.
    const pts = [
      { x: p0.x + n0.x * half, z: p0.z + n0.z * half },
      { x: p1.x + n1.x * half, z: p1.z + n1.z * half },
      { x: p1.x - n1.x * half, z: p1.z - n1.z * half },
      { x: p0.x - n0.x * half, z: p0.z - n0.z * half },
    ];
    const poly = makeWalkPolySolid(pts, {
      kind: solid.kind || 'citywall',
      source: 'citywall-polygonized',
      part: i,
    });
    if (poly) polys.push(poly);
  }
  return polys;
}

/**
 * Walk-solid colliders wrapped for engine consumers.
 * @param {object} plan village plan from planVillage
 * @param {{heightAt?:function, polygonizeCityWall?:boolean, cityWallStep?:number}} [opts]
 */
export function buildMapColliders(plan, {
  heightAt,
  polygonizeCityWall = false,
  cityWallStep = DEFAULT_CITY_WALL_STEP,
} = {}) {
  const raw = buildWalkSolids(plan, heightAt);
  const solids = [];
  for (let i = 0; i < raw.length; i++) {
    const solid = raw[i];
    if (polygonizeCityWall && solid.type === 'citywall') {
      const polys = polygonizeCityWallSolid(solid, { step: cityWallStep });
      for (let j = 0; j < polys.length; j++) solids.push(jsonClone(polys[j]));
      continue;
    }
    solids.push(jsonClone(solid));
  }
  const out = {
    schemaVersion: 1,
    convention: { south: '+z', units: 'meters' },
    solids,
  };
  return assertJsonSafe(out, 'buildMapColliders');
}

function xzPoint(p) {
  if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.z)) return null;
  return { x: p.x, z: p.z };
}

function summarizeSite(site) {
  if (!site) return {};
  const out = {};
  if (Number.isFinite(site.siteR)) out.siteR = site.siteR;
  // tier name: site.scale is the product tier string (hamlet…hanyang); tierForR is the same axis.
  const tier = site.scale || (Number.isFinite(site.siteR) ? tierForR(site.siteR) : undefined);
  if (tier != null) out.tier = tier;
  if (Number.isFinite(site.seed)) out.seed = site.seed;
  if (Number.isFinite(site.R)) out.R = site.R;
  if (Number.isFinite(site.terrainR)) out.terrainR = site.terrainR;
  if (Number.isFinite(site.Hmax)) out.Hmax = site.Hmax;
  if (Number.isFinite(site.bowlR)) out.bowlR = site.bowlR;
  if (Number.isFinite(site.ridgeR)) out.ridgeR = site.ridgeR;
  if (Number.isFinite(site.nearR)) out.nearR = site.nearR;
  if (Number.isFinite(site.mountainZ)) out.mountainZ = site.mountainZ;
  if (Number.isFinite(site.streamZ)) out.streamZ = site.streamZ;
  if (Number.isFinite(site.ansanZ)) out.ansanZ = site.ansanZ;
  if (Number.isFinite(site.streamHalf)) out.streamHalf = site.streamHalf;
  if (Number.isFinite(site.streamWaterHalf)) out.streamWaterHalf = site.streamWaterHalf;
  const center = xzPoint(site.center);
  if (center) out.center = center;
  const entrance = xzPoint(site.entrance);
  if (entrance) out.entrance = entrance;
  if (site.bounds && Number.isFinite(site.bounds.minX)) {
    out.bounds = {
      minX: site.bounds.minX,
      maxX: site.bounds.maxX,
      minZ: site.bounds.minZ,
      maxZ: site.bounds.maxZ,
    };
  }
  return out;
}

function summarizeFeatures(features) {
  const f = features || {};
  const out = {};

  if (f.cityWall) {
    const cw = f.cityWall;
    out.cityWall = {
      present: true,
      cx: cw.cx,
      cz: cw.cz,
      meanRadius: cw.meanRadius,
      gates: (cw.gates || []).map((g) => {
        const gate = { name: g.name, angle: g.angle, width: g.width };
        if (Number.isFinite(g.x) && Number.isFinite(g.z)) {
          gate.x = g.x;
          gate.z = g.z;
        }
        return gate;
      }),
    };
    if (cw.waterGates?.length) {
      out.cityWall.waterGateNames = cw.waterGates.map((g) => g.name).filter(Boolean);
    }
  } else {
    out.cityWall = { present: false };
  }

  if (f.temple && (Number.isFinite(f.temple.x) || Number.isFinite(f.temple.center?.x))) {
    out.temple = {
      present: true,
      x: Number.isFinite(f.temple.x) ? f.temple.x : f.temple.center.x,
      z: Number.isFinite(f.temple.z) ? f.temple.z : f.temple.center.z,
    };
    if (f.temple.variant != null) out.temple.variant = f.temple.variant;
  } else {
    out.temple = { present: false };
  }

  if (f.palace && (Number.isFinite(f.palace.x) || Number.isFinite(f.palace.center?.x))) {
    out.palace = {
      present: true,
      x: Number.isFinite(f.palace.x) ? f.palace.x : f.palace.center.x,
      z: Number.isFinite(f.palace.z) ? f.palace.z : f.palace.center.z,
    };
    if (Number.isFinite(f.palace.plotW)) out.palace.plotW = f.palace.plotW;
    if (Number.isFinite(f.palace.plotD)) out.palace.plotD = f.palace.plotD;
  } else {
    out.palace = { present: false };
  }

  if (f.pavilion && Number.isFinite(f.pavilion.x)) {
    out.pavilion = { present: true, x: f.pavilion.x, z: f.pavilion.z };
  }

  if (Array.isArray(f.props) && f.props.length) {
    out.propCount = f.props.length;
  }
  if (Array.isArray(f.guardianTrees) && f.guardianTrees.length) {
    out.guardianTreeCount = f.guardianTrees.length;
  }
  if (Array.isArray(f.bridges) && f.bridges.length) {
    out.bridgeCount = f.bridges.length;
  }
  if (f.ferry) out.ferry = { present: true };
  if (f.riverPort) out.riverPort = { present: true };

  return out;
}

/**
 * Flatten plan fields already present — do not invent new values.
 * houseBodies reuse parcelHouseWalkSolids polygons; gate uses parcel.access.gatePoint.
 */
export function buildMapMetadata(plan) {
  const buildings = (plan?.parcels || []).map((parcel) => {
    const houseSolids = parcelHouseWalkSolids(parcel);
    const entry = {
      parcelId: parcel.id,
      kind: parcel.kind,
      hero: !!parcel.hero,
      center: { x: parcel.center.x, z: parcel.center.z },
      houseBodies: houseSolids.map((s) => (s.pts || []).map((p) => ({ x: p.x, z: p.z }))),
    };
    // Same access source walk-solids / sampleGateCourtyardPath use.
    const gatePoint = parcel.access?.gatePoint;
    if (gatePoint && Number.isFinite(gatePoint.x) && Number.isFinite(gatePoint.z)) {
      entry.gate = { x: gatePoint.x, z: gatePoint.z };
    }
    return entry;
  });

  const roads = (plan?.roads || []).map((road) => {
    const entry = {
      pts: (road.pts || []).map((p) => ({ x: p.x, z: p.z })),
      width: road.width,
    };
    if (road.id != null) entry.id = road.id;
    if (road.level != null) entry.level = road.level;
    if (Array.isArray(road.junctionIds)) entry.junctionIds = road.junctionIds.slice();
    return entry;
  });

  const paddies = (plan?.paddies || []).map((field) => {
    const entry = {
      poly: (field.poly || []).map((p) => ({ x: p.x, z: p.z })),
    };
    if (Number.isFinite(field.y)) entry.y = field.y;
    if (field.tone != null) entry.tone = field.tone;
    return entry;
  });

  const out = {
    schemaVersion: 1,
    seed: plan?.seed,
    scale: plan?.scale,
    warnings: Array.isArray(plan?.warnings) ? plan.warnings.slice() : [],
    site: summarizeSite(plan?.site),
    buildings,
    roads,
    paddies,
    features: summarizeFeatures(plan?.features),
  };
  return assertJsonSafe(out, 'buildMapMetadata');
}

/**
 * Regular terrain height grid over the plan's fixed-content radius.
 * Heights come from terrainMeshHeightAt (the mesh surface the product samples).
 *
 * @param {object} plan
 * @param {{step?:number}} [opts]
 */
export function sampleTerrainHeightGrid(plan, { step = DEFAULT_TERRAIN_STEP } = {}) {
  const site = plan?.site;
  if (!site) {
    return assertJsonSafe({
      schemaVersion: 1,
      origin: { x: 0, z: 0 },
      step,
      nx: 0,
      nz: 0,
      heights: [],
    }, 'sampleTerrainHeightGrid');
  }
  const gridStep = Math.max(0.5, step);
  const radius = computeFixedRadius(plan, site);
  // Axis-aligned box covering the fixed-content circle around world origin.
  const origin = { x: -radius, z: -radius };
  const span = radius * 2;
  const nx = Math.floor(span / gridStep) + 1;
  const nz = Math.floor(span / gridStep) + 1;
  const heights = new Array(nx * nz);
  for (let j = 0; j < nz; j++) {
    const z = origin.z + j * gridStep;
    for (let i = 0; i < nx; i++) {
      const x = origin.x + i * gridStep;
      const h = terrainMeshHeightAt(site, x, z);
      if (!Number.isFinite(h)) {
        throw new Error(`map-data: non-finite terrain height at (${x}, ${z})`);
      }
      heights[j * nx + i] = h;
    }
  }
  const out = {
    schemaVersion: 1,
    origin,
    step: gridStep,
    nx,
    nz,
    heights,
  };
  return assertJsonSafe(out, 'sampleTerrainHeightGrid');
}
