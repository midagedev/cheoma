import { createVillageDoorOcclusion } from '../src/runtime/village/door-occlusion.js';
import { impostorHouseSpec } from '../src/village/impostor-spec.js';

function invariant(value, message) {
  if (!value) throw new Error(`door-occlusion contract: ${message}`);
}

const site = {
  R: 512,
  terrainR: 512,
  heightAt() { return 0; },
};

function ray(x, y, z, dx = 0, dy = 1, dz = 0) {
  return { origin: { x, y, z }, direction: { x: dx, y: dy, z: dz } };
}

function pointInPolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if ((a.z > point.z) !== (b.z > point.z)
      && point.x < (b.x - a.x) * (point.z - a.z) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

function findPlanShape(shape) {
  for (let variant = 0; variant < 24; variant++) {
    const parcel = {
      id: `${shape}-house`, kind: 'giwa', variant, seed: 17,
      center: { x: 0, z: 0 }, frontDir: { x: 0, z: 1 },
      houseLocal: { x: 0, z: 0 }, plotW: 36, plotD: 36,
      sx: 1, sy: 1, sz: 1, baseY: 0,
    };
    const spec = impostorHouseSpec(parcel);
    if (spec.planShape === shape) return { parcel, spec };
  }
  throw new Error(`missing ${shape} impostor fixture`);
}

function sampleBody(spec, wantedInside) {
  const polygon = spec.body.polygon;
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const point of polygon) {
    minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x);
    minZ = Math.min(minZ, point.z); maxZ = Math.max(maxZ, point.z);
  }
  for (let iz = 1; iz < 20; iz++) for (let ix = 1; ix < 20; ix++) {
    const point = {
      x: minX + (maxX - minX) * ix / 20,
      z: minZ + (maxZ - minZ) * iz / 20,
    };
    if (pointInPolygon(point, polygon) === wantedInside) return point;
  }
  throw new Error(`could not sample ${wantedInside ? 'wing' : 'concave void'}`);
}

const l = findPlanShape('l');
const u = findPlanShape('u');
u.parcel.center.x = 44;
const auxiliaryHalfWidth = 1.5 + 0.28;
const auxiliaryHalfDepth = 1 + 0.28;
l.parcel.auxiliary = {
  id: 'aux-0',
  role: 'storehouse',
  local: { x: 12, z: 0, yaw: 0 },
  body: { width: 3, depth: 2, height: 1.8 },
  roof: { form: 'gable', covering: 'tile', overhang: 0.28, rise: 0.6 },
  roofTopY: 2.4,
  footprint: [
    { x: 12 - auxiliaryHalfWidth, z: -auxiliaryHalfDepth },
    { x: 12 + auxiliaryHalfWidth, z: -auxiliaryHalfDepth },
    { x: 12 + auxiliaryHalfWidth, z: auxiliaryHalfDepth },
    { x: 12 - auxiliaryHalfWidth, z: auxiliaryHalfDepth },
  ],
};

const pavilion = { x: 88, z: 0, sides: 6, radius: 4.5, rot: 0, baseY: 0 };
const props = [{ name: 'well', x: 116, z: 0, scale: 1, baseY: 0 }];
const temple = {
  x: 152, z: 0, frontDir: { x: 0, z: 1 }, baseY: 0,
  compound: {
    enclosures: [{
      id: 'outer-precinct', height: 1.75, gateId: 'south-gate',
      polygon: [
        { x: -14, z: 10 }, { x: 14, z: 10 },
        { x: 14, z: -10 }, { x: -14, z: -10 },
      ],
    }],
    gates: [{
      id: 'south-gate', type: 'iljakmun', width: 2.2,
      position: { x: 0, z: 10 }, yaw: 0,
    }],
    buildings: [
      { id: 'west-hall', position: { x: -8, z: 0 }, footprint: { width: 8, depth: 4 }, scale: 1 },
      {
        id: 'east-hall', position: { x: 8, z: 0 }, yaw: Math.PI / 2,
        footprint: { width: 4, depth: 10 }, scale: 1,
      },
    ],
  },
};
const sijeon = [{
  id: 'shop', center: { x: 184, z: 0 },
  poly: [
    { x: 181, z: -4 }, { x: 187, z: -4 },
    { x: 187, z: 4 }, { x: 181, z: 4 },
  ],
  baseY: 0,
}];

const plan = {
  parcels: [l.parcel, u.parcel],
  features: { pavilion, props, temple, sijeon, guardianTrees: [] },
};
const occlusion = createVillageDoorOcclusion({ plan, site });

function bodyProbe(fixture, inside) {
  const point = sampleBody(fixture.spec, inside);
  const x = fixture.parcel.center.x + point.x;
  const y = fixture.spec.body.y0 + 0.08;
  const maxDistance = Math.max(0.1, fixture.spec.body.y1 - fixture.spec.body.y0 - 0.16);
  const hit = occlusion.find(ray(x, y, point.z), maxDistance);
  return { hitId: hit?.parcelId || null, point };
}

const lVoid = bodyProbe(l, false);
const lWing = bodyProbe(l, true);
const uVoid = bodyProbe(u, false);
const uWing = bodyProbe(u, true);
invariant(lVoid.hitId === null, `ㄱ-plan concave void was filled at ${JSON.stringify(lVoid.point)}`);
invariant(lWing.hitId === l.parcel.id, 'ㄱ-plan real wing did not block');
invariant(uVoid.hitId === null, `ㄷ-plan courtyard void was filled at ${JSON.stringify(uVoid.point)}`);
invariant(uWing.hitId === u.parcel.id, 'ㄷ-plan real wing did not block');

// The selected FULL overlay owns its own surfaces. Its hidden instanced/FAR house
// must therefore be excluded while a neighbouring semantic house still blocks.
const selectedPoint = sampleBody(l.spec, true);
const selectedRay = ray(selectedPoint.x, l.spec.body.y0 + 0.08, selectedPoint.z);
invariant(occlusion.find(selectedRay, 1)?.parcelId === l.parcel.id, 'house baseline did not hit');
invariant(occlusion.find(selectedRay, 1, { excludeParcelId: l.parcel.id }) === null,
  'selected parcel was not excluded');
invariant(
  occlusion.find(ray(12, 0.5, 0), 1, { excludeParcelId: l.parcel.id })?.kind
    === 'auxiliary-building',
  'selected parcel incorrectly excluded its independent auxiliary building',
);
invariant(
  occlusion.find(ray(12 + auxiliaryHalfWidth + 0.2, 0.5, 0), 1, {
    excludeParcelId: l.parcel.id,
  }) === null,
  'auxiliary door occluder exceeded its exact roof footprint',
);

// Owner exclusion applies only to the selected host building. Its independently
// rendered wall remains a blocker, while the visible road gate aperture remains
// clear at human height.
invariant(occlusion.find(ray(8, 1, 18), 1)?.kind === 'parcel-wall',
  'ordinary parcel wall did not block');
invariant(occlusion.find(ray(8, 1, 18), 1, { excludeParcelId: l.parcel.id })?.kind === 'parcel-wall',
  'selected parcel incorrectly excluded its wall');
invariant(occlusion.find(ray(0, 1, 21, 0, 0, -1), 4) === null,
  'ordinary parcel gate aperture was filled by a wall-sized proxy');

// A pavilion's broad roof AABB is deliberately not its human-height occluder.
// The corner passes between posts, while an actual post and the roof mass block.
invariant(occlusion.find(ray(pavilion.x - 8, 2, pavilion.z + 4.35, 1, 0, 0), 16) === null,
  'pavilion roof-box corner blocked at human height');
const postAngle = Math.PI / 6;
const postX = pavilion.x + Math.cos(postAngle) * 2.5;
const postZ = pavilion.z + Math.sin(postAngle) * 2.5;
invariant(occlusion.find(ray(postX, 1.2, postZ), 1)?.kind === 'pavilion',
  'actual pavilion post did not block');
invariant(occlusion.find(ray(pavilion.x, 4.1, pavilion.z), 1)?.kind === 'pavilion',
  'pavilion roof cylinder did not block');
invariant(occlusion.find(ray(pavilion.x + 2, 7.2, pavilion.z), 1) === null,
  'pavilion retained a full-radius cylinder beside its finial');
invariant(occlusion.find(ray(pavilion.x, 2, pavilion.z, 1, 0, 0), Infinity) === null,
  'unbounded rays must fail fast instead of entering an infinite DDA walk');

invariant(occlusion.find(ray(props[0].x, 0.5, props[0].z), 1)?.kind === 'public-prop',
  'public prop planning cylinder did not block');
invariant(occlusion.find(ray(106, 0.5, 0, 1, 0, 0), 5) === null,
  'solid behind the door maxDistance blocked input');
invariant(occlusion.find(ray(106, 0.5, 0, 1, 0, 0), 20)?.kind === 'public-prop',
  'same prop was not found when it moved inside maxDistance');

// Temple occlusion follows individual hall footprints, never the reserved court.
invariant(occlusion.find(ray(temple.x, 2, temple.z), 2) === null,
  'temple courtyard was replaced by a compound-size box');
invariant(occlusion.find(ray(temple.x - 8, 2, temple.z), 2)?.kind === 'temple-building',
  'temple hall footprint did not block');
invariant(occlusion.find(ray(temple.x + 11, 2, temple.z), 2)?.kind === 'temple-building',
  'temple hall yaw was not applied');
invariant(occlusion.find(ray(temple.x + 8, 2, temple.z + 4), 2) === null,
  'temple hall retained its unrotated footprint');
invariant(occlusion.find(ray(temple.x + 8, 1, temple.z + 10), 1)?.kind === 'temple-enclosure',
  'temple enclosure wall did not block');
invariant(occlusion.find(ray(temple.x, 1, temple.z + 10), 1)?.kind === 'temple-gate',
  'temple entry gate leaf did not block inside its wall opening');
invariant(occlusion.find(ray(184, 2, 0), 1)?.kind === 'sijeon', 'sijeon polygon prism did not block');

// Hero compounds consume the same pure parcel descriptor as buildParcel. The
// enclosing wall/gate stay active even when the selected host proxy is omitted.
const hero = {
  id: 'hero-house', kind: 'giwa', hero: true, heroStyle: 'hanok', seed: 29,
  center: { x: 280, z: 0 }, frontDir: { x: 0, z: 1 },
  houseLocal: { x: 0, z: 0 }, plotW: 24, plotD: 22,
  sx: 1, sy: 1, sz: 1, baseY: 0,
};
const heroOcclusion = createVillageDoorOcclusion({
  plan: { parcels: [hero], features: {} },
  site,
});
invariant(heroOcclusion.find(ray(288, 1, 11), 1)?.kind === 'hero-enclosure',
  'hero compound fence did not block');
invariant(heroOcclusion.find(ray(280, 1, 11), 1)?.kind === 'hero-enclosure-gate',
  'hero compound gate did not block');
invariant(heroOcclusion.find(ray(288, 1, 11), 1, { excludeParcelId: hero.id })?.kind === 'hero-enclosure',
  'selected hero incorrectly excluded its enclosure');

// A palace precinct is represented by its individual outer-wall runs and
// Gwanghwamun parts, never one precinct AABB. The narrow rendered seam between
// the gate side bay and wall remains open at human height.
const palace = {
  x: 360, z: 0, frontDir: { x: 0, z: 1 }, baseY: 0,
  tier: 'capital', plotW: 60, plotD: 90,
};
const palaceOcclusion = createVillageDoorOcclusion({
  plan: { parcels: [], features: { palace } },
  site,
});
invariant(palaceOcclusion.find(ray(380, 1, 45), 1)?.kind === 'palace-wall',
  'palace outer wall did not block');
invariant(palaceOcclusion.find(ray(360, 1, 45), 1)?.kind === 'palace-wall-gate',
  'Gwanghwamun leaf did not block');
invariant(palaceOcclusion.find(ray(363.8, 1, 45), 1) === null,
  'palace wall/gate records filled a rendered opening seam');
invariant(palaceOcclusion.find(ray(360, 1, 0), 1) === null,
  'palace precinct was replaced by one courtyard-sized box');

// City-wall contours retain their true gate hole. Rays through the hongye pass,
// while the adjacent pier, high lintel, and an ordinary wall chord block.
const cityWall = {
  cx: 440, cz: 0,
  radii: Array(64).fill(40),
  gates: [{
    name: 'south', angle: 0, halfAngle: 0.28,
    x: 440, z: 40, dirX: 0, dirZ: 1, width: 10, scale: 1,
  }],
};
const cityOcclusion = createVillageDoorOcclusion({
  plan: { parcels: [], features: { cityWall } },
  site,
});
invariant(cityOcclusion.find(ray(440, 1, 46, 0, 0, -1), 12) === null,
  'city gate arch was filled by a wall-ring proxy');
invariant(cityOcclusion.find(ray(447.75, 1, 40), 2)?.kind === 'city-gate-pier',
  'city gate pier did not block');
invariant(cityOcclusion.find(ray(440, 4.7, 40), 2)?.kind === 'city-gate-lintel',
  'city gate lintel did not block');
invariant(cityOcclusion.find(ray(480, 1, 0), 2)?.kind === 'city-wall',
  'city wall contour segment did not block');

const yardTrees = [{
  x: 216, z: 0, baseY: 0, canopyY: 5,
  canopyRadius: 2, trunkRadius: 0.18, trunkTop: 4,
  parcelId: 'tree-yard',
}];
const floraCounts = occlusion.refreshFlora({ yardTreeAnchors: yardTrees });
invariant(floraCounts.yardTrees === 1 && floraCounts.guardianTrees === 0,
  'flora refresh did not prebuild the expected indices');
invariant(occlusion.find(ray(217.2, 5, 0), 1, { season: 'summer' })?.kind === 'yard-tree',
  'summer canopy sphere did not block');
invariant(occlusion.find(ray(217.2, 5, 0), 1, { season: 'winter' }) === null,
  'winter retained the whole deciduous canopy as an occluder');
invariant(occlusion.find(ray(216, 1, 0), 1, { season: 'winter' })?.kind === 'yard-tree',
  'winter trunk cylinder stopped blocking');

// refreshParcel must replace, not accumulate, the indexed house contract,
// including a topology change in the same cells and an explicit removal.
const oldPoint = sampleBody(l.spec, true);
const moved = { ...l.parcel, center: { x: 236, z: 0 } };
const refreshOcclusion = createVillageDoorOcclusion({
  plan: { parcels: [l.parcel], features: {} },
  site,
});
invariant(refreshOcclusion.refreshParcel(moved), 'refreshParcel rejected a residential parcel');
invariant(refreshOcclusion.find(ray(oldPoint.x, l.spec.body.y0 + 0.08, oldPoint.z), 1) === null,
  'refreshParcel left the old house indexed');
invariant(refreshOcclusion.find(ray(236 + oldPoint.x, l.spec.body.y0 + 0.08, oldPoint.z), 1)?.parcelId === l.parcel.id,
  'refreshParcel did not index the replacement house');
const topologyChange = {
  ...moved,
  variant: u.parcel.variant,
};
invariant(refreshOcclusion.refreshParcel(topologyChange), 'refreshParcel rejected ㄱ→ㄷ topology change');
const topologySpec = impostorHouseSpec(topologyChange);
const topologyVoid = sampleBody(topologySpec, false);
const topologyWing = sampleBody(topologySpec, true);
const topologyY = topologySpec.body.y0 + 0.08;
invariant(refreshOcclusion.find(ray(236 + topologyVoid.x, topologyY, topologyVoid.z), 1) === null,
  'refreshParcel retained old ㄱ solids inside the new ㄷ courtyard');
invariant(refreshOcclusion.find(ray(236 + topologyWing.x, topologyY, topologyWing.z), 1)?.parcelId === l.parcel.id,
  'refreshParcel lost the new ㄷ wing');
const editedBounds = {
  ...moved,
  frontDir: { x: 1, z: 0 },
  editBuildingBounds: {
    minX: 8, maxX: 10,
    minY: 0.4, maxY: 4,
    minZ: -1, maxZ: 1,
  },
};
invariant(refreshOcclusion.refreshParcel(editedBounds), 'refreshParcel rejected committed building bounds');
invariant(refreshOcclusion.find(ray(236, 1, -9), 1)?.parcelId === l.parcel.id,
  'committed parcel-local building bounds did not follow the parcel frame');
invariant(refreshOcclusion.find(ray(236, 1, 0), 1) === null,
  'committed building bounds retained the stale impostor body');
invariant(refreshOcclusion.find(ray(236, 1, -9), 1, { excludeParcelId: l.parcel.id }) === null,
  'selected committed building bounds were not owner-excluded');
invariant(!refreshOcclusion.refreshParcel({ ...topologyChange, kind: 'palace' }),
  'refreshParcel accepted a non-residential replacement');
invariant(refreshOcclusion.recordCount === 0, 'refreshParcel did not remove the invalid replacement');

// The budget is measured through the public function on a realistic multi-cell
// oblique segment. One deliberately huge off-height record spans every visited
// cell and must still be counted once; hundreds of off-ray distractors stay out.
const budgetProps = [{ name: 'well', x: 32, z: 8, scale: 1, baseY: 0 }];
for (let i = 0; i < 240; i++) {
  budgetProps.push({
    name: 'well',
    x: (i % 24) * 9 - 100,
    z: 80 + Math.floor(i / 24) * 9,
    scale: 1,
    baseY: 0,
  });
}
const budgetOcclusion = createVillageDoorOcclusion({
  plan: {
    parcels: [],
    features: {
      props: budgetProps,
      sijeon: [{
        id: 'multi-cell-high-shop', baseY: 10, center: { x: 28, z: 7 },
        poly: [
          { x: 4, z: -4 }, { x: 56, z: -4 },
          { x: 56, z: 18 }, { x: 4, z: 18 },
        ],
      }],
    },
  },
  site,
});
const stats = {};
const budgetLength = Math.hypot(32, 8);
const budgetHit = budgetOcclusion.find(
  ray(0, 1, 0, 32, 0, 8),
  budgetLength + 2,
  { stats },
);
invariant(budgetHit?.kind === 'public-prop', 'budget probe missed its target prop');
invariant(stats.candidates <= 3, `candidate budget regressed (${stats.candidates} > 3)`);
invariant(stats.solids <= 3, `solid budget regressed (${stats.solids} > 3)`);
invariant(stats.cells <= 4, `cell budget regressed (${stats.cells} > 4)`);

console.log(
  `door occlusion contract ok: ${occlusion.recordCount} static records, `
  + `budget cells=${stats.cells} candidates=${stats.candidates} solids=${stats.solids}; `
  + 'ㄱ/ㄷ, parcel/hero/temple/palace/city enclosures, seasonal flora, refresh verified',
);
