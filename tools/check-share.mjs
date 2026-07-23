import assert from 'node:assert/strict';

import {
  SHARE_OUTCOMES,
  VILLAGE_SCALE_IDS,
  buildSceneShareUrl,
  shareSceneLink,
} from '../app/src/lib/share-scene.js';
import {
  SCENE_SNAPSHOT_QUERY_KEY,
  decodeSceneSnapshot,
} from '../app/src/lib/scene-snapshot.js';

const state = {
  seed: 42,
  preset: 'korea',
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
  // A #107 URL is accepted as a base, but sharing migrates it to one canonical
  // snapshot rather than preserving either legacy state or runtime flags.
  baseUrl: 'https://cheoma.midagedev.com/view/?seed=9&time=day&village=1&vseed=8&vscale=town&hero=0&worker=0&shot=1&lang=ko&flowsec=1#debug',
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
  view: {
    azimuth: 18.24,
    elevation: 27.06,
    zoom: 0.4567,
    panEast: 0.1,
    panUp: -0.02,
    panSouth: 0,
  },
});
const parsed = new URL(url);
const query = parsed.searchParams;

assert.equal(parsed.origin, 'https://cheoma.midagedev.com');
assert.equal(parsed.pathname, '/view/');
assert.equal(parsed.hash, '');
assert.deepEqual([...query.keys()], [SCENE_SNAPSHOT_QUERY_KEY]);
const snapshot = decodeSceneSnapshot(query.get(SCENE_SNAPSHOT_QUERY_KEY));
assert.equal(snapshot.seed, 42);
assert.equal(snapshot.time, 'sunset');
assert.equal(snapshot.village.seed, 7);
assert.equal(snapshot.village.scale, 'solo');
assert.equal(snapshot.village.character, 'banchon');
assert.equal(snapshot.village.includePalace, true);
assert.equal(snapshot.village.includeTemple, true);
assert.deepEqual(snapshot.residentialEdits, records);
assert.equal(snapshot.focusedParcelId, 'regular-3');
assert.deepEqual(snapshot.view, {
  azimuth: 18.2,
  elevation: 27.1,
  zoom: 0.457,
  panEast: 0.1,
  panUp: -0.02,
  panSouth: 0,
});
for (const key of ['hero', 'worker', 'shot', 'lang', 'flowsec']) {
  assert.equal(query.has(key), false, `${key} leaked into the shared scene URL`);
}

// Default vocabulary stays compact, but time is always explicit: removing
// shot=1 must not turn its seed-derived daytime scene into the product's
// implicit sunset when the recipient opens the link.
const terse = new URL(buildSceneShareUrl({
  baseUrl: 'https://cheoma.midagedev.com/?shot=1&post=0',
  state: { ...state, time: 'day', renderStyle: 'pbr', expansion: 1 },
}));
assert.deepEqual([...terse.searchParams.keys()], [SCENE_SNAPSHOT_QUERY_KEY]);
assert.deepEqual(decodeSceneSnapshot(terse.searchParams.get(SCENE_SNAPSHOT_QUERY_KEY)), {
  version: 1,
  seed: 42,
  time: 'day',
  preset: null,
  sunsetLook: null,
  season: null,
  weather: null,
  renderStyle: 'pbr',
  expansion: 1,
  flow: false,
  village: null,
  residentialEdits: [],
  focusedParcelId: null,
  view: null,
  standaloneParams: {},
  overrides: {
    preset: false,
    time: true,
    sunsetLook: false,
    season: false,
    weather: false,
  },
});

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
