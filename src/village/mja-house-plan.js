import { deepFreeze } from '../core/stable-seed.js';
import { hashString } from '../rng.js';
import * as G from '../core/math/geom2.js';
import { parcelLocalPoint } from './parcel-contract.js';
import { planResidentialOpenings } from '../layout/residential-openings.js';

export const MJA_HOUSE_PLAN_SCHEMA_VERSION = 1;

// World-metre product bounds. Sources establish the enclosed courtyard grammar,
// not universal dimensions or frequencies; these values are deliberately small,
// bounded fit constraints for one explicitly opted-in banga archetype.
export const MJA_HOUSE_PLAN_LIMITS = deepFreeze({
  minOuterWidth: 18,
  maxOuterWidth: 22,
  minOuterDepth: 18,
  maxOuterDepth: 22,
  dimensionStep: 0.5,
  wingDepth: 3.2,
  minCourtyardWidth: 10,
  minCourtyardDepth: 10,
  structuralGateGap: 3.8,
  gateWidth: 2.1,
  gateHeight: 2.45,
  gatePostHeight: 2.8,
  gateRoofWidth: 4.4,
  gateRoofDepth: 2.3,
  gateRoofEaveY: 3.08,
  gateRoofTopY: 3.6,
  gateRoofOverhang: 0.45,
  southSetback: 1.7,
  eaveOverhang: 0.85,
  roofClearance: 0.3,
  minSourceFitFactor: 0.82,
  minSourceEffectiveScale: 0.76,
  solarAltitude: Math.PI / 6,
  solarTargetLift: 1.5,
  solarHalfWidth: 0.8,
  minSolarMargin: 0.75,
  maxWings: 5,
  maxOpenings: 5,
});

const REQUIRED_WING_ROLES = Object.freeze([
  'north-anchae',
  'east-wing',
  'west-wing',
  'south-east',
  'south-west',
]);
const EPSILON = 1e-8;
const SOUTH = Object.freeze({ x: 0, z: 1 });

const finitePoint = (point) => Number.isFinite(point?.x) && Number.isFinite(point?.z);
const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));

function contextMetadata(value) {
  const rawValue = typeof value === 'string'
    ? value
    : value && typeof value === 'object'
      ? (value.raw ?? value.label ?? value.id)
      : null;
  if (typeof rawValue !== 'string' || !rawValue.trim()) return null;
  const raw = rawValue.trim();
  const requestedId = value && typeof value === 'object' && typeof value.id === 'string'
    ? value.id.trim()
    : raw;
  const id = requestedId.normalize('NFKC').toLocaleLowerCase('en-US')
    .replace(/[^\p{Letter}\p{Number}._-]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return id ? { id, raw } : null;
}

function normalizeContext(context) {
  if (context?.enabled !== true || context?.form !== 'mja') return null;
  const region = contextMetadata(context.region);
  const climate = contextMetadata(context.climate);
  const household = contextMetadata(context.household);
  if (!region || !climate || !household) return null;
  return { enabled: true, form: 'mja', region, climate, household };
}

function cleanPolygon(points) {
  const polygon = [];
  for (const point of points || []) {
    if (!finitePoint(point)) continue;
    const copy = { x: point.x, z: point.z };
    if (!polygon.length || G.dist2(polygon.at(-1), copy) > EPSILON * EPSILON) {
      polygon.push(copy);
    }
  }
  if (polygon.length > 2 && G.dist2(polygon[0], polygon.at(-1)) <= EPSILON * EPSILON) {
    polygon.pop();
  }
  return polygon;
}

function rectangle(minX, maxX, minZ, maxZ) {
  return [
    { x: minX, z: maxZ },
    { x: maxX, z: maxZ },
    { x: maxX, z: minZ },
    { x: minX, z: minZ },
  ];
}

function expandedRectangle(polygon, amount) {
  const bounds = G.boundsOfPts(polygon);
  return rectangle(
    bounds.minX - amount,
    bounds.maxX + amount,
    bounds.minZ - amount,
    bounds.maxZ + amount,
  );
}

function pointPolygonClearance(point, polygon) {
  if (!G.pointInPoly(point, polygon)) return -Infinity;
  let distance = Infinity;
  for (let index = 0; index < polygon.length; index++) {
    distance = Math.min(
      distance,
      G.distToSeg(point, polygon[index], polygon[(index + 1) % polygon.length]).d,
    );
  }
  return distance;
}

function polygonFits(inner, outer, clearance) {
  return inner.every((point) => pointPolygonClearance(point, outer) >= clearance - EPSILON);
}

function localRoadPoint(parcel) {
  const roadPoint = parcel?.access?.roadPoint;
  if (!finitePoint(roadPoint) || !finitePoint(parcel?.center) || !finitePoint(parcel?.frontDir)) {
    return null;
  }
  return parcelLocalPoint(parcel, roadPoint);
}

function fittedParcelFrame(parcel) {
  const polygon = cleanPolygon(parcel?.shape?.pts);
  const houseLocal = parcel?.houseLocal;
  const gate = parcel?.access?.gateLocalPoint;
  const road = localRoadPoint(parcel);
  const effectiveScale = Math.min(parcel?.sx, parcel?.sy, parcel?.sz);
  if (parcel?.kind !== 'giwa'
    || typeof parcel?.id !== 'string' || !parcel.id
    || polygon.length < 3
    || !finitePoint(houseLocal)
    || !Number.isFinite(parcel?.houseFitFactor)
    || parcel.houseFitFactor < MJA_HOUSE_PLAN_LIMITS.minSourceFitFactor
    || !Number.isFinite(effectiveScale)
    || effectiveScale < MJA_HOUSE_PLAN_LIMITS.minSourceEffectiveScale
    || parcel?.access?.gateRole !== 'front'
    || !finitePoint(gate)
    || !finitePoint(road)) return null;
  const gateToRoad = G.norm(G.sub(road, gate));
  if (gateToRoad.z < Math.SQRT1_2) return null;
  const maxZ = Math.max(...polygon.map((point) => point.z));
  if (Math.abs(gate.z - maxZ) > 1e-6) return null;
  return {
    polygon,
    houseLocal: { x: houseLocal.x, z: houseLocal.z },
    gate: { x: gate.x, z: gate.z },
    road,
    gateToRoad,
    effectiveScale,
  };
}

function wingSeed(parcel, role) {
  const source = Number.isFinite(parcel.seed) ? parcel.seed >>> 0 : hashString(parcel.id);
  return (source ^ hashString(`mja-wing-v1:${role}`)) >>> 0;
}

function wingBuilding(parcel, role, length, depth) {
  const bays = clamp(Math.round(length / 2.7), 3, 5);
  return {
    label: `Korea · Opt-in M-shaped banga · ${role}`,
    seed: wingSeed(parcel, role),
    style: 'giwa',
    roofType: 'skeleton',
    planShape: 'single',
    bays,
    mainHalfW: length * 0.5,
    mainHalfD: depth * 0.5,
    wingW: 1.6,
    wingLen: 2.6,
    bay: clamp(length / bays, 1.8, 3.6),
    columnHeight: 3,
    columnRadius: 0.16,
    entasis: 0.25,
    podiumTierH: 0.5,
    eaveOverhang: MJA_HOUSE_PLAN_LIMITS.eaveOverhang,
    riseScale: 0.8,
    profileCurve: 0.5,
    cornerLift: 0.42,
    planCurve: 0.28,
    ridgeH: 0.38,
    doorCount: role === 'north-anchae' ? 2 : 1,
    windowCount: role === 'north-anchae' ? 3 : 2,
    doorWidthK: 0.88,
    windowWidthK: 0.48,
    doorHeightK: 1,
    windowHeightK: 1,
  };
}

function makeWing(parcel, role, footprint, center, yaw) {
  const bounds = G.boundsOfPts(footprint);
  const horizontal = role === 'north-anchae'
    || role === 'south-east'
    || role === 'south-west';
  const length = horizontal ? bounds.w : bounds.d;
  const depth = horizontal ? bounds.d : bounds.w;
  const building = wingBuilding(parcel, role, length, depth);
  const roofTopY = building.podiumTierH
    + building.columnHeight
    + 0.35
    + building.mainHalfD * building.riseScale
    + building.ridgeH;
  return {
    id: `mja:wing:${role}`,
    role,
    center: { x: center.x, z: center.z },
    yaw,
    length,
    depth,
    bays: building.bays,
    bay: building.bay,
    footprint,
    roofFootprint: expandedRectangle(footprint, MJA_HOUSE_PLAN_LIMITS.eaveOverhang),
    roofTopY,
    building,
  };
}

function compoundGeometry(parcel, frame, width, depth) {
  const wingDepth = MJA_HOUSE_PLAN_LIMITS.wingDepth;
  const gateGap = MJA_HOUSE_PLAN_LIMITS.structuralGateGap;
  const maxZ = frame.gate.z - MJA_HOUSE_PLAN_LIMITS.southSetback;
  const minZ = maxZ - depth;
  const minX = frame.gate.x - width * 0.5;
  const maxX = frame.gate.x + width * 0.5;
  const courtyard = {
    minX: minX + wingDepth,
    maxX: maxX - wingDepth,
    minZ: minZ + wingDepth,
    maxZ: maxZ - wingDepth,
  };
  const gateLeft = frame.gate.x - gateGap * 0.5;
  const gateRight = frame.gate.x + gateGap * 0.5;
  const wings = [
    makeWing(
      parcel,
      'north-anchae',
      rectangle(minX, maxX, minZ, minZ + wingDepth),
      { x: frame.gate.x, z: minZ + wingDepth * 0.5 },
      0,
    ),
    makeWing(
      parcel,
      'east-wing',
      rectangle(maxX - wingDepth, maxX, courtyard.minZ, courtyard.maxZ),
      { x: maxX - wingDepth * 0.5, z: (courtyard.minZ + courtyard.maxZ) * 0.5 },
      -Math.PI * 0.5,
    ),
    makeWing(
      parcel,
      'west-wing',
      rectangle(minX, minX + wingDepth, courtyard.minZ, courtyard.maxZ),
      { x: minX + wingDepth * 0.5, z: (courtyard.minZ + courtyard.maxZ) * 0.5 },
      Math.PI * 0.5,
    ),
    makeWing(
      parcel,
      'south-east',
      rectangle(gateRight, maxX, maxZ - wingDepth, maxZ),
      { x: (gateRight + maxX) * 0.5, z: maxZ - wingDepth * 0.5 },
      Math.PI,
    ),
    makeWing(
      parcel,
      'south-west',
      rectangle(minX, gateLeft, maxZ - wingDepth, maxZ),
      { x: (minX + gateLeft) * 0.5, z: maxZ - wingDepth * 0.5 },
      Math.PI,
    ),
  ];
  const gateRoofFootprint = rectangle(
    frame.gate.x - MJA_HOUSE_PLAN_LIMITS.gateRoofWidth * 0.5,
    frame.gate.x + MJA_HOUSE_PLAN_LIMITS.gateRoofWidth * 0.5,
    maxZ - MJA_HOUSE_PLAN_LIMITS.gateRoofDepth * 0.5,
    maxZ + MJA_HOUSE_PLAN_LIMITS.gateRoofDepth * 0.5,
  );
  const roofFootprints = [
    ...wings.map((wing) => wing.roofFootprint),
    gateRoofFootprint,
  ];
  return {
    outer: { minX, maxX, minZ, maxZ, width, depth },
    courtyard,
    wings,
    gateRoofFootprint,
    roofFootprints,
  };
}

function fitCompound(parcel, frame) {
  const candidates = [];
  for (let width = MJA_HOUSE_PLAN_LIMITS.maxOuterWidth;
    width >= MJA_HOUSE_PLAN_LIMITS.minOuterWidth;
    width -= MJA_HOUSE_PLAN_LIMITS.dimensionStep) {
    for (let depth = MJA_HOUSE_PLAN_LIMITS.maxOuterDepth;
      depth >= MJA_HOUSE_PLAN_LIMITS.minOuterDepth;
      depth -= MJA_HOUSE_PLAN_LIMITS.dimensionStep) {
      candidates.push({ width, depth });
    }
  }
  candidates.sort((a, b) => b.width * b.depth - a.width * a.depth
    || b.width - a.width || b.depth - a.depth);
  for (const candidate of candidates) {
    const geometry = compoundGeometry(parcel, frame, candidate.width, candidate.depth);
    const courtyardWidth = geometry.courtyard.maxX - geometry.courtyard.minX;
    const courtyardDepth = geometry.courtyard.maxZ - geometry.courtyard.minZ;
    if (courtyardWidth < MJA_HOUSE_PLAN_LIMITS.minCourtyardWidth
      || courtyardDepth < MJA_HOUSE_PLAN_LIMITS.minCourtyardDepth) continue;
    if (!geometry.roofFootprints.every((roof) => (
      polygonFits(roof, frame.polygon, MJA_HOUSE_PLAN_LIMITS.roofClearance)
    ))) continue;
    // Sample the true gate-to-parcel-gate path; its endpoint lies on the parcel
    // boundary by contract, while every interior sample must remain inside.
    let approachInside = true;
    const gateCenter = { x: frame.gate.x, z: geometry.outer.maxZ };
    const length = G.dist(gateCenter, frame.gate);
    const samples = Math.max(2, Math.ceil(length / 0.4));
    for (let index = 0; index < samples; index++) {
      const point = G.lerp(gateCenter, frame.gate, index / samples);
      if (!G.pointInPoly(point, frame.polygon)) {
        approachInside = false;
        break;
      }
    }
    if (approachInside) return geometry;
  }
  return null;
}

function rotateLocal(point, yaw) {
  const cosine = Math.cos(yaw), sine = Math.sin(yaw);
  return {
    x: cosine * point.x + sine * point.z,
    z: -sine * point.x + cosine * point.z,
  };
}

function plannedWingOpening(wing, id, role) {
  const residential = planResidentialOpenings('giwa', wing.building, wing.building.seed);
  const source = residential.openings.find((candidate) => (
    candidate.kind === 'door' && candidate.primary
  ));
  if (!source) throw new RangeError(`${wing.id} has no primary residential door`);
  const centerOffset = rotateLocal(source.center, wing.yaw);
  const tangent = rotateLocal(source.tangent, wing.yaw);
  const outward = rotateLocal(source.outward, wing.yaw);
  const bottomY = wing.building.podiumTierH + 0.02;
  const height = 2.05 * source.heightK;
  return {
    id,
    wingId: wing.id,
    sourceOpeningId: source.id,
    kind: 'door',
    role,
    center: {
      x: wing.center.x + centerOffset.x,
      y: bottomY + height * 0.5,
      z: wing.center.z + centerOffset.z,
    },
    bottomY,
    tangent,
    outward,
    width: source.width,
    height,
  };
}

function openingPlan(geometry) {
  const byRole = new Map(geometry.wings.map((wing) => [wing.role, wing]));
  return [
    plannedWingOpening(
      byRole.get('north-anchae'),
      'mja:opening:primary',
      'primary',
    ),
    plannedWingOpening(
      byRole.get('east-wing'),
      'mja:opening:east-service',
      'service',
    ),
    plannedWingOpening(
      byRole.get('west-wing'),
      'mja:opening:west-service',
      'service',
    ),
    plannedWingOpening(
      byRole.get('south-east'),
      'mja:opening:south-east-service',
      'service',
    ),
    plannedWingOpening(
      byRole.get('south-west'),
      'mja:opening:south-west-service',
      'service',
    ),
  ];
}

function roofBounds(roofFootprints) {
  const points = roofFootprints.flat();
  const bounds = G.boundsOfPts(points);
  return {
    minX: bounds.minX,
    maxX: bounds.maxX,
    minZ: bounds.minZ,
    maxZ: bounds.maxZ,
  };
}

/**
 * Plans one explicitly opted-in enclosed ㅁ-shaped banga in parcel-local space.
 *
 * Region, climate, and household metadata document the caller's chosen context;
 * they never become a national probability table. Physical fit, south access,
 * usable courtyard size, and winter-solar clearance are the only eligibility
 * decisions here. All failed or default-off inputs return null.
 */
export function planMjaHouse({ context, parcel } = {}) {
  const normalizedContext = normalizeContext(context);
  const frame = fittedParcelFrame(parcel);
  if (!normalizedContext || !frame) return null;
  const geometry = fitCompound(parcel, frame);
  if (!geometry) return null;
  const openings = openingPlan(geometry);
  const primaryOpeningId = 'mja:opening:primary';
  const primary = openings[0];
  const courtyardWidth = geometry.courtyard.maxX - geometry.courtyard.minX;
  const courtyardDepth = geometry.courtyard.maxZ - geometry.courtyard.minZ;
  const southRoofTopY = Math.max(
    MJA_HOUSE_PLAN_LIMITS.gateRoofTopY,
    ...geometry.wings
      .filter((wing) => wing.role === 'south-east' || wing.role === 'south-west')
      .map((wing) => wing.roofTopY),
  );
  const shadowReach = Math.max(
    0,
    (southRoofTopY - MJA_HOUSE_PLAN_LIMITS.solarTargetLift)
      / Math.tan(MJA_HOUSE_PLAN_LIMITS.solarAltitude),
  );
  const solarMargin = courtyardDepth - shadowReach;
  if (solarMargin < MJA_HOUSE_PLAN_LIMITS.minSolarMargin) return null;
  const gateCenter = {
    x: frame.gate.x,
    y: 0,
    z: geometry.outer.maxZ,
  };
  const plan = {
    schema: MJA_HOUSE_PLAN_SCHEMA_VERSION,
    kind: 'mja-banga',
    frame: {
      space: 'parcel-local',
      xAxis: 'east-right',
      zAxis: 'south-front',
      yDatum: 'parcel-base-relative',
      origin: {
        x: (geometry.outer.minX + geometry.outer.maxX) * 0.5,
        z: (geometry.outer.minZ + geometry.outer.maxZ) * 0.5,
      },
      front: { ...SOUTH },
    },
    context: normalizedContext,
    source: {
      parcelId: parcel.id,
      parcelSeed: Number.isFinite(parcel.seed) ? parcel.seed >>> 0 : hashString(parcel.id),
      parcelPolygon: frame.polygon.map((point) => ({ ...point })),
      sourceHouseLocal: { ...frame.houseLocal },
      sourceFitFactor: parcel.houseFitFactor,
      sourceScale: {
        x: parcel.sx,
        y: parcel.sy,
        z: parcel.sz,
      },
      rank: Number.isFinite(parcel.rank) ? parcel.rank : null,
      wealth: Number.isFinite(parcel.wealth) ? parcel.wealth : null,
    },
    bounds: {
      outer: { ...geometry.outer },
      roof: roofBounds(geometry.roofFootprints),
    },
    wings: geometry.wings,
    courtyard: {
      polygon: rectangle(
        geometry.courtyard.minX,
        geometry.courtyard.maxX,
        geometry.courtyard.minZ,
        geometry.courtyard.maxZ,
      ),
      center: {
        x: (geometry.courtyard.minX + geometry.courtyard.maxX) * 0.5,
        y: 0,
        z: (geometry.courtyard.minZ + geometry.courtyard.maxZ) * 0.5,
      },
      width: courtyardWidth,
      depth: courtyardDepth,
    },
    gate: {
      id: 'mja:gate:south',
      center: gateCenter,
      yaw: 0,
      outward: { ...SOUTH },
      width: MJA_HOUSE_PLAN_LIMITS.gateWidth,
      height: MJA_HOUSE_PLAN_LIMITS.gateHeight,
      heightKind: 'clear-opening',
      postHeight: MJA_HOUSE_PLAN_LIMITS.gatePostHeight,
      roofTopY: MJA_HOUSE_PLAN_LIMITS.gateRoofTopY,
      roofFootprint: geometry.gateRoofFootprint,
      roof: {
        width: MJA_HOUSE_PLAN_LIMITS.gateRoofWidth,
        depth: MJA_HOUSE_PLAN_LIMITS.gateRoofDepth,
        eaveY: MJA_HOUSE_PLAN_LIMITS.gateRoofEaveY,
        ridgeY: MJA_HOUSE_PLAN_LIMITS.gateRoofTopY,
        overhang: MJA_HOUSE_PLAN_LIMITS.gateRoofOverhang,
        footprint: geometry.gateRoofFootprint,
      },
      passage: rectangle(
        gateCenter.x - MJA_HOUSE_PLAN_LIMITS.gateWidth * 0.5,
        gateCenter.x + MJA_HOUSE_PLAN_LIMITS.gateWidth * 0.5,
        geometry.courtyard.maxZ,
        geometry.outer.maxZ,
      ),
      parcelGate: { ...frame.gate },
      roadPoint: { ...frame.road },
      roadAxis: { ...frame.gateToRoad },
      approach: {
        from: { x: gateCenter.x, z: gateCenter.z },
        to: { ...frame.gate },
        axis: { ...SOUTH },
        length: frame.gate.z - gateCenter.z,
      },
    },
    openings,
    primaryOpeningId,
    solarTarget: {
      openingId: primaryOpeningId,
      point: {
        x: primary.center.x,
        y: MJA_HOUSE_PLAN_LIMITS.solarTargetLift,
        z: primary.center.z,
      },
      direction: { ...SOUTH },
      altitude: MJA_HOUSE_PLAN_LIMITS.solarAltitude,
      corridor: rectangle(
        primary.center.x - MJA_HOUSE_PLAN_LIMITS.solarHalfWidth,
        primary.center.x + MJA_HOUSE_PLAN_LIMITS.solarHalfWidth,
        primary.center.z,
        geometry.courtyard.maxZ,
      ),
      southRoofTopY,
      shadowReach,
      clearDepth: courtyardDepth,
      margin: solarMargin,
    },
  };
  return deepFreeze(plan);
}

function finite(value, label) {
  if (!Number.isFinite(value)) throw new TypeError(`${label} must be finite`);
  return value;
}

function assertPoint(point, label, withY = false) {
  finite(point?.x, `${label}.x`);
  finite(point?.z, `${label}.z`);
  if (withY) finite(point?.y, `${label}.y`);
}

function assertPolygon(polygon, label) {
  if (!Array.isArray(polygon) || polygon.length < 3) {
    throw new TypeError(`${label} must be a polygon`);
  }
  polygon.forEach((point, index) => assertPoint(point, `${label}[${index}]`));
}

export function validateMjaHousePlan(plan) {
  if (!plan || typeof plan !== 'object') throw new TypeError('mja house plan must be an object');
  if (plan.schema !== MJA_HOUSE_PLAN_SCHEMA_VERSION || plan.kind !== 'mja-banga') {
    throw new RangeError(`mja house schema must be ${MJA_HOUSE_PLAN_SCHEMA_VERSION}`);
  }
  if (plan.frame?.space !== 'parcel-local'
    || plan.frame?.xAxis !== 'east-right'
    || plan.frame?.zAxis !== 'south-front'
    || plan.frame?.yDatum !== 'parcel-base-relative'
    || plan.frame?.front?.x !== 0 || plan.frame?.front?.z !== 1) {
    throw new RangeError('mja house frame is unsupported');
  }
  for (const field of ['region', 'climate', 'household']) {
    if (typeof plan.context?.[field]?.id !== 'string' || !plan.context[field].id
      || typeof plan.context[field].raw !== 'string' || !plan.context[field].raw) {
      throw new TypeError(`mja context.${field} must preserve id and raw text`);
    }
  }
  if (plan.context?.enabled !== true || plan.context?.form !== 'mja') {
    throw new RangeError('mja context must be explicitly enabled');
  }
  if (!Array.isArray(plan.wings) || plan.wings.length !== MJA_HOUSE_PLAN_LIMITS.maxWings
    || !Array.isArray(plan.openings)
    || plan.openings.length > MJA_HOUSE_PLAN_LIMITS.maxOpenings) {
    throw new RangeError('mja wing or opening count is invalid');
  }
  assertPolygon(plan.source?.parcelPolygon, 'mja source parcel');
  const roles = new Set();
  const wingIds = new Set();
  for (const wing of plan.wings) {
    if (typeof wing.id !== 'string' || wingIds.has(wing.id)
      || !REQUIRED_WING_ROLES.includes(wing.role) || roles.has(wing.role)) {
      throw new RangeError('mja wings require unique stable IDs and roles');
    }
    wingIds.add(wing.id);
    roles.add(wing.role);
    assertPoint(wing.center, `${wing.id}.center`);
    assertPolygon(wing.footprint, `${wing.id}.footprint`);
    assertPolygon(wing.roofFootprint, `${wing.id}.roofFootprint`);
    finite(wing.yaw, `${wing.id}.yaw`);
    finite(wing.length, `${wing.id}.length`);
    finite(wing.depth, `${wing.id}.depth`);
    finite(wing.roofTopY, `${wing.id}.roofTopY`);
    if (wing.length <= 0
      || Math.abs(wing.depth - MJA_HOUSE_PLAN_LIMITS.wingDepth) > EPSILON
      || wing.bays < 3 || wing.bays > 5
      || wing.bay < 1.8 - EPSILON || wing.bay > 3.6 + EPSILON) {
      throw new RangeError(`${wing.id} has an unsupported wing envelope`);
    }
    const building = wing.building;
    if (building?.style !== 'giwa' || building?.roofType !== 'skeleton'
      || building?.planShape !== 'single' || building.bays !== wing.bays
      || Math.abs(building.mainHalfW * 2 - wing.length) > EPSILON
      || Math.abs(building.mainHalfD * 2 - wing.depth) > EPSILON
      || !Number.isFinite(building.seed)) {
      throw new RangeError(`${wing.id} has an incomplete builder payload`);
    }
    const expectedRoofTopY = building.podiumTierH
      + building.columnHeight
      + 0.35
      + building.mainHalfD * building.riseScale
      + building.ridgeH;
    if (Math.abs(wing.roofTopY - expectedRoofTopY) > EPSILON) {
      throw new RangeError(`${wing.id} roof height drifted from its builder payload`);
    }
  }
  if (roles.size !== REQUIRED_WING_ROLES.length) {
    throw new RangeError('mja wing roles are incomplete');
  }
  assertPolygon(plan.courtyard?.polygon, 'mja courtyard');
  assertPoint(plan.courtyard?.center, 'mja courtyard center', true);
  if (plan.courtyard.width < MJA_HOUSE_PLAN_LIMITS.minCourtyardWidth
    || plan.courtyard.depth < MJA_HOUSE_PLAN_LIMITS.minCourtyardDepth) {
    throw new RangeError('mja courtyard is not usable');
  }
  assertPoint(plan.gate?.center, 'mja gate center', true);
  assertPoint(plan.gate?.parcelGate, 'mja parcel gate');
  assertPoint(plan.gate?.roadPoint, 'mja road point');
  if (plan.gate?.outward?.x !== 0 || plan.gate?.outward?.z !== 1
    || plan.gate.yaw !== 0 || plan.gate.heightKind !== 'clear-opening'
    || plan.gate.width !== MJA_HOUSE_PLAN_LIMITS.gateWidth
    || plan.gate.height !== MJA_HOUSE_PLAN_LIMITS.gateHeight
    || plan.gate.postHeight !== MJA_HOUSE_PLAN_LIMITS.gatePostHeight
    || plan.gate.approach?.axis?.x !== 0 || plan.gate.approach?.axis?.z !== 1
    || plan.gate.approach.length <= 0
    || Math.abs(plan.gate.center.x - plan.gate.parcelGate.x) > EPSILON
    || plan.gate.parcelGate.z <= plan.gate.center.z
    || plan.gate.roadAxis?.z < Math.SQRT1_2) {
    throw new RangeError('mja gate is not a south access');
  }
  assertPolygon(plan.gate.roofFootprint, 'mja gate roof');
  assertPolygon(plan.gate.roof?.footprint, 'mja gate roof contract');
  if (plan.gate.roof?.width !== MJA_HOUSE_PLAN_LIMITS.gateRoofWidth
    || plan.gate.roof?.depth !== MJA_HOUSE_PLAN_LIMITS.gateRoofDepth
    || plan.gate.roof?.eaveY !== MJA_HOUSE_PLAN_LIMITS.gateRoofEaveY
    || plan.gate.roof?.ridgeY !== MJA_HOUSE_PLAN_LIMITS.gateRoofTopY
    || plan.gate.roof?.overhang !== MJA_HOUSE_PLAN_LIMITS.gateRoofOverhang) {
    throw new RangeError('mja gate roof contract is unsupported');
  }
  for (const roof of [
    ...plan.wings.map((wing) => wing.roofFootprint),
    plan.gate.roofFootprint,
  ]) {
    if (!polygonFits(roof, plan.source.parcelPolygon, MJA_HOUSE_PLAN_LIMITS.roofClearance)) {
      throw new RangeError('mja roof left its fitted parcel');
    }
  }
  assertPolygon(plan.gate.passage, 'mja gate passage');
  const openingIds = new Set();
  for (const record of plan.openings) {
    if (typeof record.id !== 'string' || openingIds.has(record.id)
      || !wingIds.has(record.wingId) || record.kind !== 'door') {
      throw new RangeError('mja openings require unique IDs and owned wings');
    }
    openingIds.add(record.id);
    assertPoint(record.center, record.id, true);
    assertPoint(record.tangent, `${record.id}.tangent`);
    assertPoint(record.outward, `${record.id}.outward`);
    finite(record.bottomY, `${record.id}.bottomY`);
    if (record.width <= 0 || record.height <= 0
      || Math.abs(record.center.y - (record.bottomY + record.height * 0.5)) > EPSILON
      || typeof record.sourceOpeningId !== 'string' || !record.sourceOpeningId) {
      throw new RangeError(`${record.id} has an invalid aperture`);
    }
    const wing = plan.wings.find((candidate) => candidate.id === record.wingId);
    const expected = plannedWingOpening(wing, record.id, record.role);
    if (record.sourceOpeningId !== expected.sourceOpeningId
      || Math.abs(record.center.x - expected.center.x) > EPSILON
      || Math.abs(record.center.y - expected.center.y) > EPSILON
      || Math.abs(record.center.z - expected.center.z) > EPSILON
      || Math.abs(record.bottomY - expected.bottomY) > EPSILON
      || Math.abs(record.tangent.x - expected.tangent.x) > EPSILON
      || Math.abs(record.tangent.z - expected.tangent.z) > EPSILON
      || Math.abs(record.outward.x - expected.outward.x) > EPSILON
      || Math.abs(record.outward.z - expected.outward.z) > EPSILON
      || Math.abs(record.width - expected.width) > EPSILON
      || Math.abs(record.height - expected.height) > EPSILON) {
      throw new RangeError(`${record.id} drifted from its residential opening plan`);
    }
  }
  const primary = plan.openings.find((record) => record.id === plan.primaryOpeningId);
  if (!primary || primary.role !== 'primary'
    || primary.wingId !== 'mja:wing:north-anchae'
    || primary.outward.x !== 0 || primary.outward.z !== 1) {
    throw new RangeError('mja primary opening must face south from the north anchae');
  }
  assertPoint(plan.solarTarget?.point, 'mja solar target', true);
  assertPolygon(plan.solarTarget?.corridor, 'mja solar corridor');
  if (plan.solarTarget.openingId !== plan.primaryOpeningId
    || plan.solarTarget.direction?.x !== 0 || plan.solarTarget.direction?.z !== 1
    || plan.solarTarget.altitude !== MJA_HOUSE_PLAN_LIMITS.solarAltitude
    || plan.solarTarget.point.y !== MJA_HOUSE_PLAN_LIMITS.solarTargetLift
    || plan.solarTarget.margin < MJA_HOUSE_PLAN_LIMITS.minSolarMargin) {
    throw new RangeError('mja winter solar target is invalid');
  }
  const expectedSouthRoofTopY = Math.max(
    plan.gate.roof.ridgeY,
    ...plan.wings
      .filter((wing) => wing.role === 'south-east' || wing.role === 'south-west')
      .map((wing) => wing.roofTopY),
  );
  if (Math.abs(plan.solarTarget.southRoofTopY - expectedSouthRoofTopY) > EPSILON) {
    throw new RangeError('mja solar obstruction drifted from the south roofs');
  }
  const expectedShadowReach = Math.max(
    0,
    (expectedSouthRoofTopY - plan.solarTarget.point.y)
      / Math.tan(MJA_HOUSE_PLAN_LIMITS.solarAltitude),
  );
  if (Math.abs(plan.solarTarget.shadowReach - expectedShadowReach) > EPSILON
    || Math.abs(plan.solarTarget.clearDepth - plan.courtyard.depth) > EPSILON
    || Math.abs(
      plan.solarTarget.margin
        - (plan.solarTarget.clearDepth - expectedShadowReach),
    ) > EPSILON) {
    throw new RangeError('mja winter solar clearance is inconsistent');
  }
  return plan;
}
