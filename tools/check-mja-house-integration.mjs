import assert from 'node:assert/strict';
import {
  VILLAGE_MJA_HOUSE_PRODUCT_CONTEXT,
  planVillage,
} from '../src/api/village-plan.js';
import {
  parcelLocalRoofBounds,
  parcelRoofPolygons,
} from '../src/village/house-footprint.js';
import { parcelRoofTopY, parcelGroundY } from '../src/village/solar-access.js';
import { planParcelFocus } from '../src/generators/shared/parcel-spatial.js';
import { GIWA_VARIANTS } from '../src/village/variants.js';

const stable = (value) => JSON.stringify(value);
const contextBefore = stable(VILLAGE_MJA_HOUSE_PRODUCT_CONTEXT);

// The repository plan goldens already cover every scale. This focused probe
// proves the new option's explicit-null byte identity once without paying for a
// second capital/Hanyang generation in every inner loop.
for (const scale of ['village']) {
  const base = planVillage({ scale, seed: 141 });
  const explicitOff = planVillage({ scale, seed: 141, mjaHouse: null });
  assert.equal(stable(explicitOff), stable(base), `${scale} explicit-off changed default plan bytes`);
  assert.equal(base.parcels.some((parcel) => parcel.mjaHouse), false,
    `${scale} default plan acquired an enclosed house`);
}
assert.equal(GIWA_VARIANTS.length, 4, 'mja opt-in changed repeated giwa prototype groups');

const accepted = [];
for (const scale of ['hamlet', 'village']) {
  const first = planVillage({
    scale,
    seed: 141,
    mjaHouse: VILLAGE_MJA_HOUSE_PRODUCT_CONTEXT,
  });
  const repeat = planVillage({
    scale,
    seed: 141,
    mjaHouse: VILLAGE_MJA_HOUSE_PRODUCT_CONTEXT,
  });
  assert.equal(stable(repeat), stable(first), `${scale} mja village is not deterministic`);
  const houses = first.parcels.filter((parcel) => parcel.mjaHouse);
  assert.equal(houses.length, 1, `${scale} must own exactly one opted-in mja house`);
  const parcel = houses[0];
  assert.equal(parcel.id, 'p0', `${scale} mja must remain the reserved clan core`);
  assert.equal(parcel.heroStyle, 'hanok');
  assert.equal(parcel.access?.gateRole, 'front');
  assert.ok(parcel.access?.roadId, `${scale} mja lost stored road access`);
  assert.equal(first.stats.mjaHouses, 1);
  assert.equal(first.opts.mjaHouse.region.id, 'andong-cultural-area');
  assert.equal(parcel.mjaHouse.context.climate.raw,
    VILLAGE_MJA_HOUSE_PRODUCT_CONTEXT.climate);

  const roofs = parcelRoofPolygons(parcel);
  assert.equal(roofs.length, 2,
    `${scale} spatial consumers lost the independent anchae or continuous ㄷ roof`);
  const localRoof = parcelLocalRoofBounds(parcel);
  assert.deepEqual(localRoof, parcel.mjaHouse.bounds.roof,
    `${scale} focus/vegetation bounds diverged from the renderer-free plan`);
  const roofHeight = parcelRoofTopY(parcel, first.site) - parcelGroundY(parcel, first.site);
  const authoredRoofHeight = Math.max(
    parcel.mjaHouse.gate.roofTopY,
    ...parcel.mjaHouse.wings.map((wing) => wing.roofTopY),
  );
  assert.ok(Math.abs(roofHeight - authoredRoofHeight) <= 1e-9,
    `${scale} obstruction height diverged from actual authored roofs`);

  assert.equal(parcel.solarAccess.localStart, parcel.mjaHouse.solarTarget.point.z);
  assert.ok(parcel.solarAccess.halfWidth <= parcel.mjaHouse.gate.width * 0.5,
    `${scale} winter-sun corridor no longer passes through the real gate gap`);
  const focus = planParcelFocus(parcel);
  assert.ok(Math.abs(focus.width - parcel.mjaHouse.bounds.outer.width * 1.08) <= 1e-9);
  assert.ok(Math.abs(focus.depth - parcel.mjaHouse.bounds.outer.depth * 1.08) <= 1e-9);
  assert.ok(focus.height < 7,
    `${scale} camera still frames the obsolete full parcel/14m hero box`);
  assert.ok(focus.referenceFov === 23 && focus.fov === 10,
    `${scale} product telephoto lens contract changed`);
  accepted.push({
    scale,
    outer: `${parcel.mjaHouse.bounds.outer.width}x${parcel.mjaHouse.bounds.outer.depth}`,
    focusDistance: Math.hypot(
      focus.cameraX - focus.worldX,
      focus.cameraZ - focus.worldZ,
      focus.cameraLift,
    ),
    roofHeight,
  });
}

for (const scale of ['solo', 'town']) {
  const plan = planVillage({
    scale,
    seed: 141,
    mjaHouse: VILLAGE_MJA_HOUSE_PRODUCT_CONTEXT,
  });
  assert.equal(plan.parcels.some((parcel) => parcel.mjaHouse), false,
    `${scale} inferred an mja outside the product hamlet/village policy`);
  assert.equal(plan.opts.mjaHouse, undefined,
    `${scale} reported a rejected opt-in as an accepted plan`);
}

assert.equal(stable(VILLAGE_MJA_HOUSE_PRODUCT_CONTEXT), contextBefore,
  'village planning mutated the shared product provenance context');

console.log('MJA HOUSE INTEGRATION: PASS', accepted);
