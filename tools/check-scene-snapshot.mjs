import assert from 'node:assert/strict';

import {
  MAX_SCENE_SNAPSHOT_PAYLOAD_LENGTH,
  MAX_SCENE_SNAPSHOT_URL_LENGTH,
  SCENE_SNAPSHOT_QUERY_KEY,
  SCENE_SNAPSHOT_VERSION,
  SCENE_VIEW_QUANTIZATION,
  buildSceneSnapshotUrl,
  decodeSceneSnapshot,
  encodeSceneSnapshot,
  normalizeSceneView,
} from '../app/src/lib/scene-snapshot.js';
import {
  captureSemanticOrbit,
  semanticLogZoom,
  semanticLogZoomRatio,
} from '../app/src/engine/semantic-view-runtime.js';

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
const openingParams = (offset = 0) => ({
  doorCount: 2,
  windowCount: 3,
  doorWidthK: 0.72 + offset,
  windowWidthK: 0.46,
  doorHeightK: 1.03,
  windowHeightK: 0.91,
});
const records = [{
  parcelId: 'regular-3',
  kind: 'giwa',
  params: openingParams(),
}];
const advancedVillage = {
  seed: 20260716,
  scale: 'hanyang',
  character: 'banchon',
  includePalace: false,
  includeTemple: true,
  siteR: 287.4,
  undAmpK: 1.75,
  ridgeHK: 1.32,
  streamMeanderK: 2.1,
  stream: false,
  river: true,
  paddyDensityK: 0.65,
  treeDensityK: 1.8,
  cityWall: false,
  sijeon: true,
  char01: 0.74,
  diversityK: 1.55,
  houses: 0,
  wallWeights: {
    tile: 1.5,
    stone: 1.25,
    mud: 0.75,
    brush: 0.5,
    hedge: 1,
    open: 0,
  },
};
const sourceView = {
  azimuth: -31.246,
  elevation: 24.051,
  zoom: 0.61749,
  panEast: 0.1264,
  panUp: -0.0436,
  panSouth: 0.0074,
};
const canonicalView = normalizeSceneView(sourceView);
assert.deepEqual(canonicalView, {
  azimuth: 328.8,
  elevation: 24.1,
  zoom: 0.617,
  panEast: 0.126,
  panUp: -0.044,
  panSouth: 0.007,
});
assert.deepEqual(SCENE_VIEW_QUANTIZATION, {
  azimuthDegrees: 0.1,
  elevationDegrees: 0.1,
  zoom: 0.001,
  pan: 0.001,
});
assert.deepEqual(normalizeSceneView({
  azimuth: 359.96, elevation: 24, zoom: 0.5,
}), {
  azimuth: 0, elevation: 24, zoom: 0.5, panEast: 0, panUp: 0, panSouth: 0,
});

const encoded = encodeSceneSnapshot({
  state,
  overrides,
  village: advancedVillage,
  flow: true,
  residentialEdits: records,
  focusedParcelId: 'regular-3',
  view: sourceView,
});
assert.ok(encoded && encoded.length < MAX_SCENE_SNAPSHOT_PAYLOAD_LENGTH);
assert.equal(encoded.split('~')[0], String(SCENE_SNAPSHOT_VERSION));
const decoded = decodeSceneSnapshot(encoded);
assert.deepEqual(decoded, {
  version: 1,
  seed: 42,
  time: 'sunset',
  preset: 'korea',
  sunsetLook: 'crimson',
  season: 'autumn',
  weather: 'clear',
  renderStyle: 'ink',
  expansion: 2,
  flow: true,
  village: advancedVillage,
  residentialEdits: records,
  focusedParcelId: 'regular-3',
  view: canonicalView,
  standaloneParams: {},
  overrides,
});
assert.equal(encodeSceneSnapshot({
  state: {
    seed: decoded.seed,
    preset: decoded.preset,
    time: decoded.time,
    sunsetLook: decoded.sunsetLook,
    season: decoded.season,
    weather: decoded.weather,
    renderStyle: decoded.renderStyle,
    expansion: decoded.expansion,
  },
  overrides: decoded.overrides,
  village: decoded.village,
  flow: decoded.flow,
  residentialEdits: decoded.residentialEdits,
  focusedParcelId: decoded.focusedParcelId,
  view: decoded.view,
  standaloneParams: decoded.standaloneParams,
}), encoded, 'encode → decode → encode changed canonical bytes');

const defaults = encodeSceneSnapshot({
  state: { ...state, preset: 'korea', time: 'day', renderStyle: 'pbr', expansion: 1 },
  village: {
    seed: 7,
    scale: 'village',
    character: 'yeoyeom',
    includePalace: false,
    includeTemple: false,
    siteR: null,
    undAmpK: 1,
    ridgeHK: 1,
    streamMeanderK: 1,
    stream: true,
    river: false,
    paddyDensityK: 1,
    treeDensityK: 1,
    cityWall: 'auto',
    sijeon: 'auto',
    char01: null,
    diversityK: 1,
    houses: null,
    wallWeights: null,
  },
  view: { azimuth: 9, elevation: 31, zoom: 0.5 },
});
assert.equal(defaults, '1~s.16~t.1~vs.7~vw.2i.8m.dw',
  'seed-derived/fixed village defaults polluted the payload');
assert.deepEqual(decodeSceneSnapshot(defaults).village, {
  seed: 7,
  scale: 'village',
  character: 'yeoyeom',
  includePalace: false,
  includeTemple: false,
  siteR: null,
  undAmpK: 1,
  ridgeHK: 1,
  streamMeanderK: 1,
  stream: true,
  river: false,
  paddyDensityK: 1,
  treeDensityK: 1,
  cityWall: 'auto',
  sijeon: 'auto',
  char01: null,
  diversityK: 1,
  houses: null,
  wallWeights: null,
});

const wrappedView = encodeSceneSnapshot({
  state: { ...state, renderStyle: 'pbr', expansion: 1 },
  village: { ...advancedVillage, siteR: null, wallWeights: null },
  view: { azimuth: 359.96, elevation: 24, zoom: 0.5 },
});
const wrappedDecoded = decodeSceneSnapshot(wrappedView);
assert.equal(wrappedDecoded.view.azimuth, 0);
assert.equal(encodeSceneSnapshot({
  state: {
    ...state,
    renderStyle: 'pbr',
    expansion: 1,
  },
  village: wrappedDecoded.village,
  view: wrappedDecoded.view,
}), wrappedView, '359.96° changed bytes after canonical round trip');

const standaloneParams = {
  roofPitch: 0.7,
  profileCurve: 0.43,
  eaveOverhang: 1.85,
  riseScale: 1.05,
  cornerLift: 0.72,
};
const standalone = encodeSceneSnapshot({
  state: { ...state, renderStyle: 'pbr', expansion: 1 },
  overrides: { ...overrides, sunsetLook: false, season: false, weather: false },
  standaloneParams,
  view: sourceView,
});
const standaloneDecoded = decodeSceneSnapshot(standalone);
assert.equal(standalone.includes('~hp.'), true);
assert.equal(standaloneDecoded.village, null);
assert.deepEqual(standaloneDecoded.standaloneParams, {
  roofPitch: 0.7,
  riseScale: 1.05,
  eaveOverhang: 1.85,
  cornerLift: 0.72,
  profileCurve: 0.43,
});
assert.deepEqual(standaloneDecoded.view, canonicalView);
assert.equal(encodeSceneSnapshot({
  state: {
    ...state,
    renderStyle: 'pbr',
    expansion: 1,
  },
  overrides: standaloneDecoded.overrides,
  standaloneParams: standaloneDecoded.standaloneParams,
  view: standaloneDecoded.view,
}), standalone, 'standalone param insertion order changed canonical bytes');
assert.equal(semanticLogZoom(Math.exp(-8) / 2), null);
assert.equal(semanticLogZoom(Math.exp(8) * 2), null);
const middleZoom = semanticLogZoom(1);
assert.equal(middleZoom, 0.5);
assert.equal(semanticLogZoomRatio(middleZoom), 1);
assert.equal(captureSemanticOrbit({
  position: { x: 0, y: 0, z: 5 },
  target: { x: 0, y: 0, z: 0 },
  canonicalTarget: { x: 0, y: 0, z: 0 },
  panScale: 10,
  zoom: 0.5,
}), null, 'invalid zero-elevation orbit escaped the shared semantic boundary');

const futureField = `${defaults}~future_camera_contract.alpha`;
assert.deepEqual(decodeSceneSnapshot(futureField), decodeSceneSnapshot(defaults),
  'unknown future field did not fail soft');
for (const malformed of [
  null,
  '',
  defaults.replace(/^1/, '2'),
  '1~s.-1~t.1',
  '1~s.16~t.zz',
  '1~s.16~s.17~t.1',
  '1~s.16~t.1~vw.bad',
  '1~s.16~t.1~se.1~we.2',
  '1~s.16~t.1~vs.7~vw.2s0.8c.dw',
  '1~s.16~t.1~vs.7~f.../escape',
  '1~s.16~t.1~vs.7~u.zzzz',
  '1~s.16~t.1~vs.7~ed.invalid',
  '1~s.16~t.1~hp.z.1',
  '1~s.16~t.1~hp.1.zzz',
  '1~s.16~t.1~x.2',
  '1~s.16~t.1~p.2~x.2',
  '1~s.16~t.1~p.0~x.4',
  `1~s.16~t.1~${'x'.repeat(MAX_SCENE_SNAPSHOT_PAYLOAD_LENGTH)}`,
]) {
  assert.equal(decodeSceneSnapshot(malformed), null, `malformed snapshot partially decoded: ${String(malformed).slice(0, 60)}`);
}

for (const invalid of [
  { state: { ...state, seed: undefined } },
  { state: { ...state, seed: -1 } },
  { state: { ...state, seed: '42' } },
  { state: { ...state, expansion: 1.5 } },
  { state: { ...state, preset: 'giwa', expansion: 2 } },
  { state: { ...state, preset: 'korea', expansion: 4 } },
  { state, flow: 'true' },
  { state, overrides: { season: 1 } },
  { state: { ...state, season: 'winter', weather: 'rain' } },
  { state, village: { ...advancedVillage, character: 'future' } },
  { state, village: { ...advancedVillage, stream: 'false' } },
  { state, village: { ...advancedVillage, includePalace: 1 } },
  { state, village: { ...advancedVillage, siteR: 287.45 } },
  { state, village: { ...advancedVillage, wallWeights: { tile: 4 } } },
  { state, village: { ...advancedVillage, wallWeights: { future: 1 } } },
  { state, village: advancedVillage, residentialEdits: null },
  { state, village: advancedVillage, focusedParcelId: '../parcel' },
  { state, village: advancedVillage, view: { ...sourceView, elevation: 0 } },
  { state, village: advancedVillage, view: { ...sourceView, elevation: 90 } },
  { state, village: advancedVillage, view: { ...sourceView, zoom: Infinity } },
  { state, standaloneParams: { futureAxis: 1 } },
  { state, standaloneParams: { roofPitch: 0.405 } },
  { state, standaloneParams: { roofPitch: 1 } },
  { state, village: advancedVillage, standaloneParams: { roofPitch: 0.7 } },
]) {
  assert.equal(encodeSceneSnapshot(invalid), null, `invalid source was coerced: ${JSON.stringify(invalid)}`);
}

const maximumRecords = Array.from({ length: 8 }, (_, index) => ({
  parcelId: `parcel_${index}_${'x'.repeat(20)}`,
  kind: index % 2 ? 'choga' : 'giwa',
  params: openingParams(index / 1000),
}));
const maximumUrl = buildSceneSnapshotUrl({
  baseUrl: 'https://cheoma.midagedev.com/view/?hero=0&worker=0&shot=1&lang=ko&flowsec=1#debug',
  state,
  overrides,
  village: { ...advancedVillage, houses: 400 },
  flow: true,
  residentialEdits: maximumRecords,
  focusedParcelId: maximumRecords[7].parcelId,
  view: sourceView,
});
assert.ok(maximumUrl && maximumUrl.length <= MAX_SCENE_SNAPSHOT_URL_LENGTH,
  `maximum snapshot exceeded ${MAX_SCENE_SNAPSHOT_URL_LENGTH}: ${maximumUrl?.length}`);
const maximumParsed = new URL(maximumUrl);
assert.deepEqual([...maximumParsed.searchParams.keys()], [SCENE_SNAPSHOT_QUERY_KEY]);
assert.equal(maximumParsed.hash, '');
assert.equal(
  encodeSceneSnapshot({
    state,
    overrides,
    village: { ...advancedVillage, houses: 400 },
    flow: true,
    residentialEdits: maximumRecords,
    focusedParcelId: maximumRecords[7].parcelId,
    view: sourceView,
  }),
  maximumParsed.searchParams.get(SCENE_SNAPSHOT_QUERY_KEY),
);

console.log(`SCENE SNAPSHOT: PASS (v${SCENE_SNAPSHOT_VERSION}, canonical ${encoded.length} chars, maximum URL ${maximumUrl.length}/${MAX_SCENE_SNAPSHOT_URL_LENGTH})`);
