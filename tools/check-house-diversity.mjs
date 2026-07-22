// Pure household/lot/plan contract for issue #8.  No browser or renderer: this
// checks the policy and the exact FULL/MID/FAR roof footprints used by planning.
import { planVillage } from '../src/api/village-plan.js';
import { buildRebuildPayload, schemaFor } from '../app/src/lib/edit-schema.js';
import {
  buildEditedParcelSpec,
  clampBuildingDimensions,
} from '../src/runtime/village/parcel-edit.js';
import * as G from '../src/core/math/geom2.js';
import { normalizeGiwaPlan } from '../src/layout/giwa-footprint.js';
import {
  GIWA_VARIANT,
  giwaVariantFallbacks,
  pickGiwaHouseVariant,
} from '../src/village/house-diversity.js';
import {
  parcelRoofPolygons,
} from '../src/village/house-footprint.js';
import {
  GIWA_VARIANTS,
  assignVariation,
  variantMirrorX,
  variantOv,
} from '../src/village/variants.js';

const invariant = (condition, message) => {
  if (!condition) throw new Error(message);
};

invariant(GIWA_VARIANTS.length === 4,
  'regular giwa prototype groups changed (draw-call budget is four)');
invariant(JSON.stringify([...new Set(GIWA_VARIANTS.map((variant, index) =>
  variantOv({ kind: 'giwa', variant: index }).planShape))].sort())
  === JSON.stringify(['l', 'single', 'u']), 'ㅡ/ㄱ/ㄷ plan repertoire drifted');
invariant(normalizeGiwaPlan('u', 3).bays === 4,
  'three-bay U survived plan normalization');
invariant(JSON.stringify(giwaVariantFallbacks(GIWA_VARIANT.U))
  === JSON.stringify([GIWA_VARIANT.L_RIGHT, GIWA_VARIANT.L_LEFT, GIWA_VARIANT.SINGLE]),
  'U fallback no longer descends through L to single');
invariant(variantMirrorX({ kind: 'giwa', variant: GIWA_VARIANT.L_RIGHT }) === 1
  && variantMirrorX({ kind: 'giwa', variant: GIWA_VARIANT.L_LEFT }) === -1
  && variantMirrorX({ kind: 'choga', variant: 1 }) === 1,
'variant mirror ownership drifted between instancing and focus/edit');

const schemaFields = (spec) => schemaFor(spec).sections.flatMap((section) => section.fields);
const singleSpec = { kind: 'giwa', params: { planShape: 'single', bays: 3, bay: 2.2 } };
const lSpec = { kind: 'giwa', params: { planShape: 'l', bays: 3, bay: 2.2 } };
const uSpec = { kind: 'giwa', params: { planShape: 'u', bays: 4, bay: 2.2 } };
const staleUSpec = { kind: 'giwa', params: { planShape: 'u', bays: 3, bay: 1.2 } };
const singleFields = schemaFields(singleSpec);
invariant(!singleFields.some((field) => field.key === 'wingLen' || field.key === 'wingW'),
  'single-house editor exposes dead wing controls');
invariant(schemaFields(lSpec).some((field) => field.key === 'wingLen')
  && schemaFields(uSpec).some((field) => field.key === 'wingW'),
'winged-house editor lost live wing controls');
invariant(Math.abs(singleFields.find((field) => field.key === 'mainHalfW')?.min - 3.3) < 1e-9
  && Math.abs(schemaFields(uSpec).find((field) => field.key === 'mainHalfW')?.min - 4.4) < 1e-9,
'giwa editor width range no longer begins at the bay-derived effective minimum');
invariant(Math.abs(schemaFields(staleUSpec).find((field) => field.key === 'mainHalfW')?.min - 3.6) < 1e-9,
  'giwa editor stopped normalizing stale U bays/bay-width like the footprint kernel');
const singlePayload = buildRebuildPayload(singleSpec, {
  kind: 'giwa', mainHalfW: 3.6, wingLen: 4.2, wingW: 2.4,
});
invariant(singlePayload.building.mainHalfW === 3.6
  && singlePayload.building.wingLen === undefined
  && singlePayload.building.wingW === undefined,
'hidden single-house wing values leaked into rebuild payload');

const mirroredParcel = {
  id: 'type-switch-fixture', kind: 'giwa', variant: GIWA_VARIANT.L_LEFT,
  rank: 0.6, plotW: 18, plotD: 16, seed: 17, wallType: 'tile', toneIdx: 1,
};
const targetChoga = buildEditedParcelSpec(mirroredParcel, { kind: 'choga' }, {});
invariant(targetChoga.kind === 'choga'
  && targetChoga.params.columnHeight === 1.95
  && targetChoga.params.mainHalfW === undefined
  && targetChoga.params.wingLen === undefined
  && targetChoga.params.wallType === 'stone'
  && targetChoga.params.thatchAge === 0.85,
'kind switch retained source giwa dimensions, wall vocabulary, or meaningless thatch state');
const clampedChoga = { columnHeight: 2.9, ridgeH: 0.9, podiumTierH: 0.8 };
clampBuildingDimensions(clampedChoga, 'choga');
const acceptedChoga = buildEditedParcelSpec(
  mirroredParcel,
  { kind: 'choga', building: { columnHeight: 2.9, ridgeH: 0.9, podiumTierH: 0.8 } },
  clampedChoga,
);
invariant(acceptedChoga.params.columnHeight === 2.7
  && acceptedChoga.params.ridgeH === 0.4
  && acceptedChoga.params.podiumTierH === 0.5,
'editor spec did not reflect the core-accepted dimension clamps');
const restoredGiwa = buildEditedParcelSpec(mirroredParcel, { kind: 'giwa' }, {});
invariant(restoredGiwa.params.columnHeight === 2.9
  && variantMirrorX({ ...mirroredParcel, kind: restoredGiwa.kind }) === -1,
'switching back to giwa lost the parcel variant defaults or mirror owner');

const small = {
  kind: 'giwa', plotW: 12.9, plotD: 11.9, rank: 1,
  settlementTier: 'hanyang', settlementScale01: 1,
};
for (let step = 0; step <= 100; step++) {
  invariant(pickGiwaHouseVariant(small, 1, 1, step / 100) !== GIWA_VARIANT.U,
    'small lot admitted a U plan');
}
const affluent = {
  kind: 'giwa', plotW: 18, plotD: 16, rank: 0.9,
  settlementTier: 'capital', settlementScale01: 0.75,
};
invariant(pickGiwaHouseVariant(affluent, 0.7, 0.9, 0.99) === GIWA_VARIANT.U,
  'large affluent household cannot reach the U-plan repertoire');

// Same per-house seed isolates the intended monotone household effect from RNG.
const low = { kind: 'giwa', seed: 0x812733, rank: 0.3, plotW: 12, plotD: 11,
  settlementTier: 'village', settlementScale01: 0.25 };
const high = { kind: 'giwa', seed: low.seed, rank: 0.9, plotW: 18, plotD: 16,
  settlementTier: 'capital', settlementScale01: 0.75 };
assignVariation(low, 0.35);
assignVariation(high, 0.75);
invariant(high.wealth > low.wealth && high.sx > low.sx && high.sy > low.sy && high.sz > low.sz,
  'rank/wealth/lot/tier no longer produce a larger, taller household');
invariant(high.roofTone.reduce((a, b) => a + b, 0) > low.roofTone.reduce((a, b) => a + b, 0),
  'household gradient no longer reaches instanceColor roof tone');

const originalRandom = Math.random;
Math.random = () => { throw new Error('house-diversity plan consumed global Math.random'); };
let plan;
try { plan = planVillage({ scale: 'town', seed: 20260716 }); }
finally { Math.random = originalRandom; }

const regular = plan.parcels.filter((parcel) => !parcel.hero && (parcel.kind === 'giwa' || parcel.kind === 'choga'));
const giwa = regular.filter((parcel) => parcel.kind === 'giwa');
const lotAreas = regular.map((parcel) => parcel.plotW * parcel.plotD);
const lotAreaKeys = new Set(lotAreas.map((area) => area.toFixed(2)));
invariant(lotAreaKeys.size >= regular.length * 0.75
  && Math.max(...lotAreas) / Math.min(...lotAreas) >= 3.5,
  'fixed town fixture lost its varied lot-size field');
const scaleRange = (key) => Math.max(...regular.map((parcel) => parcel[key]))
  - Math.min(...regular.map((parcel) => parcel[key]));
const roofToneSums = regular.map((parcel) => parcel.roofTone.reduce((sum, channel) => sum + channel, 0));
invariant(scaleRange('sx') >= 0.2 && scaleRange('sy') >= 0.2
  && Math.max(...roofToneSums) - Math.min(...roofToneSums) >= 0.4,
  'fixed town fixture lost meaningful width, height, or instance-color variation');
const shapes = new Set(giwa.map((parcel) => variantOv(parcel).planShape));
invariant(['single', 'l', 'u'].every((shape) => shapes.has(shape)),
  'fixed town fixture no longer demonstrates ㅡ/ㄱ/ㄷ diversity');

const roofOwners = [];
for (const parcel of regular) {
  const ov = variantOv(parcel);
  if (ov.planShape === 'u') {
    invariant(ov.bays >= 4, `${parcel.id}: U has fewer than four bays`);
    invariant(parcel.plotW * parcel.plotD >= 175 && parcel.plotW >= 13 && parcel.plotD >= 12,
      `${parcel.id}: small lot retained U plan`);
    invariant(parcel.houseFitFactor >= 0.82
      && Math.min(parcel.sx, parcel.sy, parcel.sz) >= 0.76,
      `${parcel.id}: miniature U survived exact roof fit`);
  }
  for (const roof of parcelRoofPolygons(parcel)) {
    for (const point of roof) {
      invariant(G.pointInPoly(point, parcel.poly)
        || parcel.poly.some((a, index) => G.distToSeg(point, a, parcel.poly[(index + 1) % parcel.poly.length]).d < 1e-7),
      `${parcel.id}: roof escaped its actual parcel polygon`);
      const boundary = Math.min(...parcel.poly.map((a, index) =>
        G.distToSeg(point, a, parcel.poly[(index + 1) % parcel.poly.length]).d));
      invariant(boundary >= 0.299999,
        `${parcel.id}: roof lost 0.3m parcel clearance (${boundary})`);
    }
    roofOwners.push({ parcel, roof });
  }
}
for (let i = 0; i < roofOwners.length; i++) for (let j = i + 1; j < roofOwners.length; j++) {
  const a = roofOwners[i], b = roofOwners[j];
  if (a.parcel === b.parcel) continue;
  invariant(!G.polysOverlap(a.roof, b.roof),
    `${a.parcel.id}/${b.parcel.id}: actual roof footprints overlap`);
}

console.log(`HOUSE DIVERSITY: PASS (${regular.length} homes, ${giwa.length} giwa, ㅡ/ㄱ/ㄷ, exact roof clearance, semantic materials)`);
