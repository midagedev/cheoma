import assert from 'node:assert/strict';

import {
  SHARE_OUTCOMES,
  VILLAGE_SCALE_IDS,
  buildSceneShareUrl,
  shareSceneLink,
} from '../app/src/lib/share-scene.js';
import { decodeResidentialEditState } from '../app/src/lib/residential-edit-url.js';

const state = {
  seed: 42,
  preset: 'giwa',
  time: 'sunset',
  sunsetLook: 'crimson',
  season: 'autumn',
  weather: 'clear',
  renderStyle: 'ink',
  expansion: 2,
};
const overrides = {
  preset: true,
  time: true,
  sunsetLook: true,
  season: true,
  weather: true,
};
const records = [{
  parcelId: 'regular-3',
  kind: 'giwa',
  params: {
    doorCount: 2,
    windowCount: 3,
    doorWidthK: 0.72,
    windowWidthK: 0.46,
    doorHeightK: 1.03,
    windowHeightK: 0.91,
  },
}];

assert.ok(VILLAGE_SCALE_IDS.includes('solo'), 'solo cannot survive the shared URL parser vocabulary');
assert.deepEqual(SHARE_OUTCOMES, ['shared', 'copied', 'cancelled', 'failed']);

const url = buildSceneShareUrl({
  baseUrl: 'https://cheoma.midagedev.com/view/?hero=0&worker=0&shot=1&lang=ko&flowsec=1#debug',
  state,
  overrides,
  flow: true,
  village: {
    seed: 7,
    scale: 'solo',
    character: 'banchon',
    includePalace: true,
    includeTemple: true,
  },
  residentialEdits: records,
  focusedParcelId: 'regular-3',
});
const parsed = new URL(url);
const query = parsed.searchParams;

assert.equal(parsed.origin, 'https://cheoma.midagedev.com');
assert.equal(parsed.pathname, '/view/');
assert.equal(parsed.hash, '');
assert.deepEqual(
  Object.fromEntries([...query].filter(([key]) => key !== 'vedit')),
  {
    seed: '42',
    preset: 'giwa',
    time: 'sunset',
    sunset: 'crimson',
    season: 'autumn',
    weather: 'clear',
    mode: 'ink',
    exp: '2',
    flow: '1',
    village: '1',
    vseed: '7',
    vscale: 'solo',
    vchar: 'banchon',
    vpalace: '1',
    vtemple: '1',
  },
  'canonical scene fields changed',
);
assert.deepEqual(decodeResidentialEditState(query.get('vedit')), {
  version: 1,
  records,
  focusedParcelId: 'regular-3',
});
for (const key of ['hero', 'worker', 'shot', 'lang', 'flowsec']) {
  assert.equal(query.has(key), false, `${key} leaked into the shared scene URL`);
}

// Default vocabulary remains terse while still pinning the scene seed. Runtime
// parameters from the source address never leak through.
const terse = new URL(buildSceneShareUrl({
  baseUrl: 'https://cheoma.midagedev.com/?shot=1&post=0',
  state: { ...state, renderStyle: 'pbr', expansion: 1 },
}));
assert.deepEqual(Object.fromEntries(terse.searchParams), { seed: '42' });

const payload = {
  title: 'cheoma — scene',
  text: 'Explore this scene.',
  url,
};
let nativePayload = null;
let copies = 0;
assert.equal(await shareSceneLink(payload, {
  share: async (value) => { nativePayload = value; },
  writeText: async () => { copies += 1; },
}), 'shared');
assert.equal(nativePayload, payload, 'native share payload was rewritten');
assert.equal(copies, 0, 'clipboard ran after native share success');

const abort = new Error('dismissed');
abort.name = 'AbortError';
assert.equal(await shareSceneLink(payload, {
  share: async () => { throw abort; },
  writeText: async () => { copies += 1; },
}), 'cancelled');
assert.equal(copies, 0, 'native share cancellation copied behind the user’s back');

let copiedUrl = null;
assert.equal(await shareSceneLink(payload, {
  share: async () => { throw new Error('native unavailable'); },
  writeText: async (value) => { copiedUrl = value; },
}), 'copied');
assert.equal(copiedUrl, url, 'clipboard received text other than the canonical URL');

assert.equal(await shareSceneLink(payload, {
  writeText: async (value) => { copiedUrl = value; },
}), 'copied', 'missing Web Share API did not fall back to clipboard');

assert.equal(await shareSceneLink(payload, {
  share: async () => { throw new Error('native failed'); },
  writeText: async () => { throw new Error('clipboard failed'); },
}), 'failed');
assert.equal(await shareSceneLink(payload), 'failed');
assert.equal(await shareSceneLink({ ...payload, url: '' }, {
  share: async () => { throw new Error('must not run'); },
}), 'failed');

console.log('SCENE SHARE: PASS (canonical URL + Web Share/clipboard outcomes)');
