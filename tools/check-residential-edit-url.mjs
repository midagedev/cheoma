import assert from 'node:assert/strict';

import {
  MAX_RESIDENTIAL_EDIT_RECORDS,
  RESIDENTIAL_EDIT_PARAM_KEYS,
  decodeResidentialEditState,
  encodeResidentialEditState,
} from '../app/src/lib/residential-edit-url.js';

const params = (overrides = {}) => ({
  doorCount: 2,
  windowCount: 3,
  doorWidthK: 0.72,
  windowWidthK: 0.46,
  doorHeightK: 1.03,
  windowHeightK: 0.91,
  ...overrides,
});
const records = [
  { parcelId: 'p20', kind: 'choga', params: params({ doorCount: 1, windowCount: 5 }) },
  { parcelId: 'p3', kind: 'giwa', params: params() },
];
const snapshot = JSON.stringify(records);
const encodedA = encodeResidentialEditState({ records, focusedParcelId: 'p20' });
const encodedB = encodeResidentialEditState({ records: [...records].reverse(), focusedParcelId: 'p20' });

assert.equal(encodedA, encodedB, 'record order changed the URL payload');
assert.ok(encodedA.length < 100, `two compact records grew to ${encodedA.length} bytes`);
assert.equal(JSON.stringify(records), snapshot, 'encoder mutated the runtime snapshot');

const decoded = decodeResidentialEditState(encodedA);
assert.deepEqual(decoded.records, [...records].sort((a, b) => a.parcelId < b.parcelId ? -1 : 1));
assert.equal(decoded.focusedParcelId, 'p20');
assert.deepEqual(Object.keys(decoded.records[0].params), RESIDENTIAL_EDIT_PARAM_KEYS);
assert.equal(encodeResidentialEditState(decoded), encodedA, 'decode/encode was not canonical');

assert.equal(encodeResidentialEditState({ records: [] }), null, 'empty edits polluted the default URL');
assert.equal(encodeResidentialEditState({ records: records.concat(
  Array.from({ length: MAX_RESIDENTIAL_EDIT_RECORDS - 1 }, (_, i) => ({
    parcelId: `extra${i}`, kind: 'giwa', params: params(),
  })),
) }), null, 'oversize runtime snapshot was silently truncated');
assert.equal(encodeResidentialEditState({ records: [records[0], records[0]] }), null, 'duplicate parcel id survived');
assert.equal(encodeResidentialEditState({ records: [{ ...records[0], kind: 'temple' }] }), null, 'non-residential kind survived');
assert.equal(encodeResidentialEditState({ records: [{ ...records[0], params: params({ doorWidthK: NaN }) }] }), null,
  'NaN survived');
assert.equal(encodeResidentialEditState({ records: [{ ...records[0], params: params({ windowHeightK: Infinity }) }] }), null,
  'Infinity survived');
assert.equal(encodeResidentialEditState({ records: [{ ...records[0], params: params({ windowCount: 2.5 }) }] }), null,
  'fractional count survived');
assert.equal(encodeResidentialEditState({ records, focusedParcelId: '../p20' }), null, 'unsafe focus id survived');

for (const malformed of [
  '', '2~-~p1.g.1.2.k.k.rs.rs', '1~-~', '1~../p1~p1.g.1.2.k.k.rs.rs',
  '1~-~p1.x.1.2.k.k.rs.rs', '1~-~p1.g.1.2.k.k.rs', '1~-~p1.g.1.2.!..rs.rs',
  '1~-~p1.g.1.2.k.k.rs.rs;p1.c.1.2.k.k.rs.rs',
  `1~-~${'p'.repeat(800)}`,
]) {
  assert.equal(decodeResidentialEditState(malformed), null, `malformed payload did not fail closed: ${malformed.slice(0, 40)}`);
}

// Standard URLSearchParams escaping is itself part of the transport contract:
// delimiters must survive a real query-string roundtrip without a custom
// base64 implementation or locale-dependent ordering.
const query = new URLSearchParams({ seed: '42', village: '1', vedit: encodedA });
const queryRoundtrip = decodeResidentialEditState(new URLSearchParams(query.toString()).get('vedit'));
assert.deepEqual(queryRoundtrip, decoded);
const terseHome = new URLSearchParams({ seed: '42' });
assert.equal(terseHome.has('village'), false);
assert.equal(terseHome.has('vedit'), false);

console.log(`RESIDENTIAL EDIT URL: PASS (${records.length} records, ${encodedA.length} bytes, six normalized axes, fail-closed)`);
