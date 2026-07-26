// Pure contract for live-edit rebuild shortcuts: geometry/yard signatures and
// thatch-only detection. No Three, no browser.
import assert from 'node:assert/strict';
import {
  isResidentialThatchOnlyEdit,
  residentialGeometrySignature,
  residentialRoofBoundsMatch,
  residentialYardSignature,
  resolveResidentialEdit,
  buildParcelSpec,
} from '../src/runtime/village/parcel-edit.js';

const parcel = {
  id: 'p0',
  kind: 'choga',
  rank: 'common',
  plotW: 12,
  plotD: 10,
  seed: 7,
  variant: 0,
  wallType: 'mud',
  toneIdx: 1,
  thatchAge: 0.4,
  jangdok: 1,
  yardStack: false,
  clothesline: false,
  vegBed: true,
  aux: false,
};

const base = buildParcelSpec(parcel);
const geoA = residentialGeometrySignature(base);
assert.ok(geoA, 'geometry signature missing for base spec');

const thatchEdit = resolveResidentialEdit(parcel, base, { thatchAge: 0.9 });
assert.equal(
  residentialGeometrySignature(thatchEdit.spec),
  geoA,
  'thatchAge changed the geometry signature',
);
assert.equal(
  isResidentialThatchOnlyEdit(base, thatchEdit),
  true,
  'thatch-only edit was not detected',
);

const doorEdit = resolveResidentialEdit(parcel, base, {
  building: { doorWidthK: 0.55 },
});
assert.notEqual(
  residentialGeometrySignature(doorEdit.spec),
  geoA,
  'door width kept the geometry signature',
);
assert.equal(
  isResidentialThatchOnlyEdit(base, doorEdit),
  false,
  'door width misclassified as thatch-only',
);

const yardA = residentialYardSignature('choga', thatchEdit.top);
const yardB = residentialYardSignature('choga', {
  ...thatchEdit.top,
  wallType: 'stone',
});
assert.notEqual(yardA, yardB, 'wallType change kept the yard signature');

const yardDoor = residentialYardSignature('choga', doorEdit.top);
assert.equal(yardA, yardDoor, 'opening edit changed the yard signature');

assert.equal(
  residentialRoofBoundsMatch(
    { minX: 0, maxX: 1, minZ: 0, maxZ: 1 },
    { minX: 0, maxX: 1.0005, minZ: 0, maxZ: 1 },
  ),
  true,
  'near-equal roof bounds failed match',
);
assert.equal(
  residentialRoofBoundsMatch(
    { minX: 0, maxX: 1, minZ: 0, maxZ: 1 },
    { minX: 0, maxX: 1.05, minZ: 0, maxZ: 1 },
  ),
  false,
  'divergent roof bounds still matched',
);

const giwa = {
  ...parcel,
  kind: 'giwa',
  wallType: 'tile',
  thatchAge: undefined,
  vegBed: false,
};
const giwaBase = buildParcelSpec(giwa);
const toneEdit = resolveResidentialEdit(giwa, giwaBase, { roofTone: 3 });
assert.equal(
  residentialGeometrySignature(toneEdit.spec),
  residentialGeometrySignature(giwaBase),
  'roofTone changed geometry signature',
);
assert.equal(
  isResidentialThatchOnlyEdit(giwaBase, toneEdit),
  false,
  'giwa roofTone misclassified as thatch-only',
);

console.log('LIVE EDIT SIGNATURES: PASS');
