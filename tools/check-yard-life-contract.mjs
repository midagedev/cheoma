import * as G from '../src/core/math/geom2.js';
import { planVillage } from '../src/api/village-plan.js';
import { parcelWorldPoint } from '../src/village/parcel-contract.js';
import { parcelEffectiveRoofBounds } from '../src/village/house-footprint.js';
import {
  planYardLife,
  YARD_LIFE_MOTIFS,
  YARD_LIFE_SCHEMA_VERSION,
  yardLifeHouseholdEligible,
  yardLifeRecordsToHardObstacles,
} from '../src/village/yard-life-plan.js';
import {
  YARD_HARD_GAP,
  YARD_LIFE_MAX_HEIGHT,
  yardLifePotentialSlots,
} from '../src/village/yard-layout.js';

const SCALES = ['hamlet', 'village', 'town', 'capital', 'hanyang'];
const SEEDS = [7, 42, 20260716];
const MOTIFS = {
  spring: 'spring-seed-prep',
  autumn: 'autumn-threshing',
  winter: 'winter-fuel',
};
const WEATHER = {
  spring: ['clear', 'rain'],
  autumn: ['clear'],
  winter: ['clear', 'rain', 'snow'],
};
const PART_KINDS = new Set([
  'water-bowl', 'seed-basket',
  'threshing-bench', 'threshing-stone', 'bound-sheaf', 'chaff-patch',
  'split-log', 'stack-support', 'straw-cover',
]);
const MATERIAL_ROLES = new Set(['wood', 'onggi', 'straw', 'stone', 'chaff', 'fiber']);
const EPS = 1e-9;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function deepFrozen(value) {
  if (!value || typeof value !== 'object') return true;
  return Object.isFrozen(value) && Object.values(value).every(deepFrozen);
}

function footprintPolygon(record) {
  const { halfX, halfZ, yaw } = record.footprint;
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return [
    { x: halfX, z: halfZ },
    { x: -halfX, z: halfZ },
    { x: -halfX, z: -halfZ },
    { x: halfX, z: -halfZ },
  ].map((corner) => ({
    x: record.local.x + corner.x * c + corner.z * s,
    z: record.local.z - corner.x * s + corner.z * c,
  }));
}

function polygonDistance(left, right) {
  let distance = Infinity;
  for (let i = 0; i < left.length; i++) {
    distance = Math.min(
      distance,
      G.segmentPolygonDistance(left[i], left[(i + 1) % left.length], right),
    );
  }
  return distance;
}

function parcelBoundaryDistance(point, parcel) {
  let distance = Infinity;
  const points = parcel.shape?.pts || [];
  for (let i = 0; i < points.length; i++) {
    distance = Math.min(distance, G.distToSeg(point, points[i], points[(i + 1) % points.length]).d);
  }
  return distance;
}

function assertParts(record, label) {
  invariant(record.parts.length >= 2, `${label} has no readable semantic parts`);
  for (const part of record.parts) {
    invariant(PART_KINDS.has(part.kind), `${label} has unknown part ${part.kind}`);
    invariant(MATERIAL_ROLES.has(part.materialRole),
      `${label}:${part.kind} has unknown role ${part.materialRole}`);
    invariant(Number.isInteger(part.count) && part.count > 0,
      `${label}:${part.kind} has invalid count ${part.count}`);
  }
  invariant(record.materialRoles.every((role) => MATERIAL_ROLES.has(role)),
    `${label} has an unknown material role`);
  invariant(new Set(record.materialRoles).size === record.materialRoles.length,
    `${label} repeats material roles`);
  invariant(record.parts.every((part) => record.materialRoles.includes(part.materialRole)),
    `${label} omitted a part material role`);

  const count = (kind) => record.parts.find((part) => part.kind === kind)?.count || 0;
  if (record.motif === 'spring-seed-prep') {
    invariant(['onggi-bowl', 'wooden-bowl'].includes(record.variant),
      `${label} has invalid spring variant`);
    invariant(count('water-bowl') === 1 && count('seed-basket') >= 1 && count('seed-basket') <= 2,
      `${label} violated portable spring seed-prep vocabulary`);
    invariant(record.parts.find((part) => part.kind === 'seed-basket')?.materialRole === 'fiber',
      `${label} lost the distinct woven-fiber seed-basket role`);
    invariant(!record.parts.some((part) => /seedling|seed-bed/.test(part.kind)),
      `${label} reintroduced a yard seedbed`);
  } else if (record.motif === 'autumn-threshing') {
    invariant(['gesang', 'taetdol'].includes(record.variant),
      `${label} has invalid threshing variant`);
    invariant(count(record.variant === 'gesang' ? 'threshing-bench' : 'threshing-stone') === 1,
      `${label} lost its threshing surface`);
    invariant(count('bound-sheaf') >= 2 && count('bound-sheaf') <= 4
      && count('chaff-patch') === 1,
    `${label} violated the threshing still-life vocabulary`);
    invariant(!record.parts.some((part) => /drying|machine|fan/.test(part.kind)),
      `${label} reintroduced rejected drying/machinery vocabulary`);
  } else if (record.motif === 'winter-fuel') {
    invariant(['firewood-stack', 'straw-covered-firewood'].includes(record.variant),
      `${label} has invalid winter variant`);
    invariant(count('split-log') >= 8 && count('split-log') <= 14
      && count('stack-support') === 1,
    `${label} violated the winter fuel vocabulary`);
    invariant(count('straw-cover') === (record.variant === 'straw-covered-firewood' ? 1 : 0),
      `${label} made the seed-fixed winter cover weather-dependent`);
  }
  invariant(!record.parts.some((part) => part.activation),
    `${label} carries forbidden weather activation`);
}

let planCases = 0;
let eligibleTotal = 0;
let ownerTotal = 0;
let recordTotal = 0;
let obstacleTotal = 0;
let fallbackFixture = null;
const scaleStats = new Map(SCALES.map((scale) => [scale, { eligible: 0, owners: 0 }]));

for (const scale of SCALES) for (const seed of SEEDS) {
  const plan = planVillage({
    scale,
    seed,
    includePalace: scale === 'capital' || scale === 'hanyang',
  });
  const parcelBytes = JSON.stringify(plan.parcels);
  let heightCalls = 0;
  const heightAt = (x, z) => {
    heightCalls++;
    return plan.site.heightAt(x, z);
  };
  const originalRandom = Math.random;
  let randomCalls = 0;
  Math.random = () => {
    randomCalls++;
    throw new Error('yard-life plan consumed global Math.random');
  };
  let first;
  try {
    first = planYardLife(plan.parcels, { seed: plan.seed, heightAt });
  } finally {
    Math.random = originalRandom;
  }
  const second = planYardLife(plan.parcels, { seed: plan.seed, heightAt: plan.site.heightAt });
  const reordered = planYardLife(
    plan.parcels.slice().reverse(),
    { seed: plan.seed, heightAt: plan.site.heightAt },
  );
  const bytes = JSON.stringify(first);
  invariant(randomCalls === 0, `${scale}:${seed} called global Math.random`);
  const parcelByIdForGround = new Map(plan.parcels.map((parcel) => [parcel.id, parcel]));
  const expectedHeightCalls = first.filter((record) =>
    !Number.isFinite(parcelByIdForGround.get(record.owner.parcelId)?.baseY)).length;
  invariant(heightCalls === expectedHeightCalls,
  `${scale}:${seed} resampled raw terrain despite authoritative parcel.baseY`);
  invariant(bytes === JSON.stringify(second), `${scale}:${seed} is not byte-identical`);
  invariant(bytes === JSON.stringify(reordered), `${scale}:${seed} depends on parcel order`);
  invariant(parcelBytes === JSON.stringify(plan.parcels), `${scale}:${seed} mutated its parcels`);
  invariant(deepFrozen(first), `${scale}:${seed} plan records are not deeply frozen`);
  invariant(JSON.stringify(JSON.parse(bytes)) === bytes, `${scale}:${seed} is not JSON-safe`);

  const parcels = new Map(plan.parcels.map((parcel) => [parcel.id, parcel]));
  const eligible = plan.parcels.filter(yardLifeHouseholdEligible).length;
  const byOwner = new Map();
  const ids = new Set();
  for (const record of first) {
    const label = `${scale}:${seed}:${record.id}`;
    const parcel = parcels.get(record.owner.parcelId);
    invariant(parcel && yardLifeHouseholdEligible(parcel), `${label} has an ineligible owner`);
    invariant(record.schema === YARD_LIFE_SCHEMA_VERSION, `${label} schema drifted`);
    invariant(record.motif === MOTIFS[record.season], `${label} season/motif mismatch`);
    invariant(JSON.stringify(record.weather) === JSON.stringify({ allow: WEATHER[record.season] }),
      `${label} weather eligibility drifted`);
    invariant(record.id === `yard-life-record-v1:${parcel.id}:${record.season}:${record.motif}`,
      `${label} has an unstable id`);
    invariant(!ids.has(record.id), `${label} is duplicated`);
    ids.add(record.id);
    for (const value of [
      record.local.x, record.local.y, record.local.z, record.local.yaw,
      record.world.x, record.world.y, record.world.z, record.world.yaw,
      record.footprint.halfX, record.footprint.halfZ, record.footprint.yaw,
      record.height, record.scale, record.yaw,
    ]) invariant(Number.isFinite(value), `${label} has a non-finite transform`);
    invariant(record.local.y === 0 && record.yaw === record.local.yaw,
      `${label} has inconsistent local transform`);
    invariant(record.footprint.shape === 'rect'
      && record.footprint.halfX > 0 && record.footprint.halfZ > 0
      && record.footprint.yaw === record.yaw,
      `${label} has an invalid footprint`);
    invariant(record.height > 0 && record.height <= YARD_LIFE_MAX_HEIGHT,
      `${label} exceeds camera-safe height`);

    const spec = YARD_LIFE_MOTIFS[record.motif];
    invariant(record.scale >= spec.scale[0] && record.scale <= spec.scale[1],
      `${label} scale escaped its motif tuning range`);
    invariant(Math.abs(record.footprint.halfX - spec.halfX * record.scale) <= EPS
      && Math.abs(record.footprint.halfZ - spec.halfZ * record.scale) <= EPS,
    `${label} footprint/scale mismatch`);
    invariant(Math.abs(record.height - spec.height * record.scale) <= EPS,
      `${label} height/scale mismatch`);

    const expectedWorld = parcelWorldPoint(parcel, record.local);
    invariant(Math.abs(record.world.x - expectedWorld.x) <= EPS
      && Math.abs(record.world.z - expectedWorld.z) <= EPS,
    `${label} local/world transform mismatch`);
    const expectedY = Number.isFinite(parcel.baseY)
      ? parcel.baseY : plan.site.heightAt(record.world.x, record.world.z);
    invariant(Math.abs(record.world.y - expectedY) <= EPS,
      `${label} did not serialize authoritative parcel ground y`);
    invariant(Math.abs(record.world.yaw - G.facingY(parcel.frontDir) - record.yaw) <= EPS,
      `${label} local/world yaw mismatch`);

    const polygon = footprintPolygon(record);
    invariant(polygon.every((corner) => G.pointInPoly(corner, parcel.shape.pts)
      && parcelBoundaryDistance(corner, parcel) > 0.17),
    `${label} pierces the wall boundary`);
    const roof = parcelEffectiveRoofBounds(parcel);
    const roofPolygon = [
      { x: roof.minX, z: roof.minZ }, { x: roof.maxX, z: roof.minZ },
      { x: roof.maxX, z: roof.maxZ }, { x: roof.minX, z: roof.maxZ },
    ];
    invariant(polygonDistance(polygon, roofPolygon) > 0.21,
      `${label} intersects the actual roof envelope`);
    const corridor = parcel.solarAccess;
    const solarPolygon = [
      { x: -corridor.halfWidth, z: corridor.localStart },
      { x: corridor.halfWidth, z: corridor.localStart },
      { x: corridor.halfWidth, z: corridor.localEnd },
      { x: -corridor.halfWidth, z: corridor.localEnd },
    ];
    invariant(polygonDistance(polygon, solarPolygon) > EPS,
      `${label} blocks the solar/focus corridor`);
    const gate = parcel.access?.gateLocalPoint;
    const fallbackFront = parcel.shape.pts.reduce((front, point) => point.z > front.z ? point : front);
    const approachEnd = Number.isFinite(gate?.x) && Number.isFinite(gate?.z)
      ? gate : { x: 0, z: fallbackFront.z };
    const approachStart = {
      x: Number.isFinite(parcel.houseLocal?.x) ? parcel.houseLocal.x : 0,
      z: roof.maxZ + 0.15,
    };
    invariant(G.segmentPolygonDistance(approachStart, approachEnd, polygon) > 0.81,
      `${label} blocks the gate approach`);
    assertParts(record, label);

    if (!byOwner.has(parcel.id)) byOwner.set(parcel.id, []);
    byOwner.get(parcel.id).push(record);
  }
  if (!fallbackFixture && first.length) fallbackFixture = { plan, records: first };

  for (const [ownerId, records] of byOwner) {
    invariant(records.length === 3, `${scale}:${seed}:${ownerId} has ${records.length}/3 seasons`);
    invariant(new Set(records.map((record) => record.season)).size === 3,
      `${scale}:${seed}:${ownerId} repeats a season`);
    const spring = records.find((record) => record.season === 'spring');
    const winter = records.find((record) => record.season === 'winter');
    const autumn = records.find((record) => record.season === 'autumn');
    const parcel = parcels.get(ownerId);
    for (const record of records) {
      const radius = Math.hypot(record.footprint.halfX, record.footprint.halfZ) + YARD_HARD_GAP;
      const slots = yardLifePotentialSlots(parcel, {
        footprint: record.footprint,
        radius,
        height: record.height,
        slotClass: record.slotClass,
      });
      invariant(slots.some((slot) => slot.id === record.slot
        && slot.x === record.local.x && slot.z === record.local.z),
      `${scale}:${seed}:${ownerId}:${record.season} slot is no longer reusable`);
    }
    invariant(spring.slotClass === 'service-edge' && winter.slotClass === 'service-edge'
      && autumn.slotClass === 'open-work-yard',
    `${scale}:${seed}:${ownerId} lost motif-specific slot classes`);
    const springChoices = yardLifePotentialSlots(parcel, {
      footprint: spring.footprint,
      radius: Math.hypot(spring.footprint.halfX, spring.footprint.halfZ) + YARD_HARD_GAP,
      height: spring.height,
      slotClass: spring.slotClass,
    });
    const winterChoices = yardLifePotentialSlots(parcel, {
      footprint: winter.footprint,
      radius: Math.hypot(winter.footprint.halfX, winter.footprint.halfZ) + YARD_HARD_GAP,
      height: winter.height,
      slotClass: winter.slotClass,
    });
    if (springChoices.length > 1 && winterChoices.some((slot) => slot.id !== spring.slot)) {
      invariant(winter.slot !== spring.slot,
        `${scale}:${seed}:${ownerId} unnecessarily forced spring/winter to one coordinate`);
    }
  }

  for (const season of Object.keys(MOTIFS)) {
    const active = first.filter((record) => record.season === season);
    for (let a = 0; a < active.length; a++) for (let b = a + 1; b < active.length; b++) {
      const distance = Math.hypot(
        active[a].world.x - active[b].world.x,
        active[a].world.z - active[b].world.z,
      );
      const radiusA = Math.hypot(active[a].footprint.halfX, active[a].footprint.halfZ);
      const radiusB = Math.hypot(active[b].footprint.halfX, active[b].footprint.halfZ);
      invariant(distance > radiusA + radiusB,
        `${scale}:${seed}:${season} records overlap between households`);
    }
  }

  const obstacles = yardLifeRecordsToHardObstacles(first);
  invariant(deepFrozen(obstacles), `${scale}:${seed} obstacles are not deeply frozen`);
  const expectedObstacleCount = new Set(first.map((record) =>
    `${record.owner.parcelId}|${record.slot}`)).size;
  invariant(obstacles.length === expectedObstacleCount,
    `${scale}:${seed} did not preserve the potential-slot union`);
  for (const [ownerId, records] of byOwner) {
    const owned = yardLifeRecordsToHardObstacles(first, ownerId);
    const expectedOwnedCount = new Set(records.map((record) => record.slot)).size;
    invariant(owned.length === expectedOwnedCount && owned.every((obstacle) =>
      obstacle.ownerId === ownerId && obstacle.mode === 'trunk'
      && obstacle.kind === 'yard-life' && obstacle.shape === 'circle'),
    `${scale}:${seed}:${ownerId} obstacle adapter leaked ownership`);
    const expectedRadius = new Map();
    for (const record of records) {
      expectedRadius.set(record.slot, Math.max(
        expectedRadius.get(record.slot) || 0,
        Math.hypot(record.footprint.halfX, record.footprint.halfZ) + YARD_HARD_GAP,
      ));
    }
    invariant(owned.every((obstacle) =>
      Math.abs(obstacle.radius - expectedRadius.get(obstacle.id.split(':').at(-1))) <= EPS),
    `${scale}:${seed}:${ownerId} obstacle envelope drifted`);
  }

  const owners = byOwner.size;
  invariant(owners <= Math.max(1, Math.ceil(eligible * 0.18)),
    `${scale}:${seed} yard life is not sparse (${owners}/${eligible})`);
  scaleStats.get(scale).eligible += eligible;
  scaleStats.get(scale).owners += owners;
  eligibleTotal += eligible;
  ownerTotal += owners;
  recordTotal += first.length;
  obstacleTotal += obstacles.length;
  planCases++;
}

for (const [scale, stats] of scaleStats) {
  const density = stats.owners / stats.eligible;
  invariant(density >= 0.015 && density <= 0.13,
    `${scale} aggregate density escaped sparse bounds (${stats.owners}/${stats.eligible})`);
}
const density = ownerTotal / eligibleTotal;
invariant(density >= 0.035 && density <= 0.12,
  `aggregate yard-life density escaped sparse bounds (${ownerTotal}/${eligibleTotal})`);

invariant(fallbackFixture, 'no fixture exercised heightAt fallback');
const fallbackParcels = structuredClone(fallbackFixture.plan.parcels);
for (const parcel of fallbackParcels) delete parcel.baseY;
let fallbackCalls = 0;
const fallbackRecords = planYardLife(fallbackParcels, {
  seed: fallbackFixture.plan.seed,
  heightAt(x, z) {
    fallbackCalls++;
    return fallbackFixture.plan.site.heightAt(x, z);
  },
});
invariant(fallbackRecords.length === fallbackFixture.records.length
  && fallbackCalls === fallbackRecords.length,
'baseY-free fixture did not sample heightAt exactly once per record');
invariant(fallbackRecords.every((record) =>
  Math.abs(record.world.y - fallbackFixture.plan.site.heightAt(record.world.x, record.world.z)) <= EPS),
'baseY-free fixture did not serialize heightAt fallback');

const collisionParcelById = new Map(
  fallbackFixture.plan.parcels.map((parcel) => [parcel.id, parcel]),
);
const collisionRecord = fallbackFixture.records[0];
const collisionParcel = collisionParcelById.get(collisionRecord.owner.parcelId);
const collisionOptions = {
  footprint: collisionRecord.footprint,
  height: collisionRecord.height,
  slotClass: collisionRecord.slotClass,
  obstacles: [],
};
const collisionSlots = yardLifePotentialSlots(collisionParcel, collisionOptions);
invariant(collisionSlots.length > 0, 'exact-collision fixture has no baseline slot');
const containedSlot = collisionSlots[0];
const containmentBlocked = yardLifePotentialSlots(collisionParcel, {
  ...collisionOptions,
  obstacles: [{
    shape: 'rect',
    x: containedSlot.x,
    z: containedSlot.z,
    halfWidth: 0.02,
    halfDepth: 0.02,
  }],
});
invariant(!containmentBlocked.some((slot) => slot.id === containedSlot.id),
  'oriented footprint failed to reject a fully contained hard obstacle');

const thinFootprint = {
  shape: 'rect',
  halfX: 0.72,
  halfZ: 0.12,
  yaw: Math.PI * 0.25,
};
const thinOptions = {
  footprint: thinFootprint,
  height: 0.4,
  slotClass: 'service-edge',
  obstacles: [],
};
const thinSlots = yardLifePotentialSlots(collisionParcel, thinOptions);
invariant(thinSlots.length > 0, 'oriented-collision fixture has no thin baseline slot');
const thinSlot = thinSlots[0];
const localClearance = 0.48;
const exactCircle = {
  shape: 'circle',
  x: thinSlot.x + Math.sin(thinFootprint.yaw) * localClearance,
  z: thinSlot.z + Math.cos(thinFootprint.yaw) * localClearance,
  radius: 0.02,
};
invariant(localClearance < Math.hypot(thinFootprint.halfX, thinFootprint.halfZ)
  + exactCircle.radius + YARD_HARD_GAP,
'oriented-collision fixture is not inside the conservative circle envelope');
const exactSlots = yardLifePotentialSlots(collisionParcel, {
  ...thinOptions,
  obstacles: [exactCircle],
});
invariant(exactSlots.some((slot) => slot.id === thinSlot.id),
  'oriented footprint regressed to a conservative bounding-circle collision');

console.log(
  `YARD LIFE CONTRACT: PASS (${planCases} plans, ${ownerTotal}/${eligibleTotal} households, `
  + `${recordTotal} seasonal records, ${obstacleTotal} reserved slots, `
  + `${(density * 100).toFixed(1)}% density)`,
);
