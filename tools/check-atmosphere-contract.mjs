import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  DEFAULT_SUNSET_LOOK,
  SUNSET_LOOK_IDS,
  SUNSET_LOOKS,
  TIME_PRESETS,
  atmosphereProfileKey,
  normalizeSunsetLook,
  resolveAtmosphereProfile,
  resolvePostProfile,
} from '../src/env/atmosphere-profiles.js';
import {
  DEFAULT_MOON_OPTICS,
  MOON_ANGULAR_DIAMETER_DEG,
  MOON_BLOOM_KNEE,
  MOON_CORONA_DIAMETER_DEG,
  MOON_CORONA_ENERGY,
  MOON_CORONA_PROFILE,
  MOON_DISTANCE,
  MOON_RENDER_ORDER,
  planeSpanForAngularDiameter,
  projectedAngularDiameterPixels,
  resolveMoonBloomGate,
  resolveMoonCloudComposite,
  resolveMoonOptics,
  sampleMoonCoronaProfile,
  sphereRadiusForAngularDiameter,
} from '../src/api/moon-optics.js';

const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const rgb = (hex) => {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
};
const distance = (a, b) => Math.hypot(...a.map((value, index) => value - b[index]));

assert.equal(DEFAULT_SUNSET_LOOK, 'gold');
assert.deepEqual(SUNSET_LOOK_IDS, ['gold', 'crimson', 'violet']);
assert.equal(normalizeSunsetLook('missing'), DEFAULT_SUNSET_LOOK);
assert.equal(atmosphereProfileKey('sunset', 'crimson'), 'sunset:crimson');
assert.equal(atmosphereProfileKey('invalid', 'violet'), 'day');
assert.equal(TIME_PRESETS.sunset, SUNSET_LOOKS.gold.atmosphere);
assert.equal(resolveAtmosphereProfile('day', 'violet'), TIME_PRESETS.day);
assert.equal(resolvePostProfile('night', 'crimson'), resolvePostProfile('night', 'gold'));

const directions = [];
const lowerBands = [];
for (const id of SUNSET_LOOK_IDS) {
  const entry = SUNSET_LOOKS[id];
  const atmosphere = resolveAtmosphereProfile('sunset', id);
  const post = resolvePostProfile('sunset', id);
  assert.equal(entry.atmosphere, atmosphere);
  assert.equal(entry.post, post);
  assert.ok(Object.isFrozen(entry) && Object.isFrozen(atmosphere) && Object.isFrozen(post));
  assert.equal(atmosphere.sky.length, 4, `${id}: four compatible sky stops`);
  assert.deepEqual(atmosphere.sky.map(([position]) => position), [...atmosphere.sky.map(([position]) => position)].sort((a, b) => a - b));
  for (const [position, color] of atmosphere.sky) {
    assert.ok(finite(position) && position >= 0 && position <= 1);
    assert.match(color, /^#[0-9a-f]{6}$/i);
  }
  for (const key of ['sunInt', 'hemiInt', 'fogNear', 'fogFar', 'exposure', 'mistOp']) {
    assert.ok(finite(atmosphere[key]), `${id}: ${key}`);
  }
  assert.ok(atmosphere.fogNear < atmosphere.fogFar && atmosphere.sunInt > 0);
  for (const key of [
    'bloomStrength', 'bloomRadius', 'bloomThreshold', 'rim', 'rimPower', 'rimWrap',
    'sunGlow', 'sunGlowSize', 'sat', 'flare',
  ]) assert.ok(finite(post[key]), `${id}: post.${key}`);
  assert.ok(post.rim > 1.5 && post.sunGlow > 0.75 && post.flare > 0.75, `${id}: flagship low-sun energy`);
  directions.push(atmosphere.sunDir);
  lowerBands.push(rgb(atmosphere.sky[1][1]));
}

// Changing sunset hue must not move the sun or pop shadow direction.
assert.deepEqual(directions[1], directions[0]);
assert.deepEqual(directions[2], directions[0]);
// The variants must be visibly separated, not aliases with tiny numerical jitter.
assert.ok(distance(lowerBands[0], lowerBands[1]) > 35, 'gold/crimson lower sky separation');
assert.ok(distance(lowerBands[1], lowerBands[2]) > 35, 'crimson/violet lower sky separation');
assert.ok(distance(lowerBands[0], lowerBands[2]) > 35, 'gold/violet lower sky separation');

const source = await readFile(new URL('../src/env/atmosphere-profiles.js', import.meta.url), 'utf8');
assert.doesNotMatch(source, /from\s+['"]three['"]|document\.|window\.|WebGL/i,
  'profile registry remains renderer/browser independent');

const DEG = Math.PI / 180;
const diskDiameter = 2 * Math.asin(DEFAULT_MOON_OPTICS.diskRadius / MOON_DISTANCE) / DEG;
const coronaDiameter = 2 * Math.atan(
  DEFAULT_MOON_OPTICS.coronaSpan / (2 * MOON_DISTANCE),
) / DEG;
assert.ok(Object.isFrozen(DEFAULT_MOON_OPTICS));
assert.equal(DEFAULT_MOON_OPTICS.distance, MOON_DISTANCE);
assert.ok(Math.abs(diskDiameter - MOON_ANGULAR_DIAMETER_DEG) < 1e-12);
assert.ok(Math.abs(coronaDiameter - MOON_CORONA_DIAMETER_DEG) < 1e-12);
assert.equal(
  sphereRadiusForAngularDiameter(MOON_DISTANCE, MOON_ANGULAR_DIAMETER_DEG),
  DEFAULT_MOON_OPTICS.diskRadius,
);
assert.equal(
  planeSpanForAngularDiameter(MOON_DISTANCE, MOON_CORONA_DIAMETER_DEG),
  DEFAULT_MOON_OPTICS.coronaSpan,
);
assert.deepEqual(resolveMoonOptics({ distance: 0, diskAngularDiameterDeg: -1 }), DEFAULT_MOON_OPTICS);

const diskPixels = [46, 24, 10, 7].map((fov) => (
  projectedAngularDiameterPixels(MOON_ANGULAR_DIAMETER_DEG, fov, 640)
));
assert.ok(diskPixels.every((value, index) => index === 0 || value > diskPixels[index - 1]));
assert.ok(diskPixels[0] > 6.8 && diskPixels[0] < 6.9);
assert.ok(diskPixels[2] > 33.1 && diskPixels[2] < 33.3);
assert.ok(diskPixels[3] > 47.4 && diskPixels[3] < 47.6);

const diskRadiusInCorona = DEFAULT_MOON_OPTICS.diskRadius / (DEFAULT_MOON_OPTICS.coronaSpan * 0.5);
assert.ok(Object.isFrozen(MOON_CORONA_PROFILE) && MOON_CORONA_PROFILE.every(Object.isFrozen));
assert.equal(sampleMoonCoronaProfile(diskRadiusInCorona), 0,
  'interpolated corona energy stays empty across the direct lunar disc');
assert.equal(MOON_CORONA_PROFILE.at(-1)[1], 0);
assert.ok(MOON_CORONA_ENERGY.transmitted > MOON_CORONA_ENERGY.scattered);
assert.ok(Math.abs(
  MOON_CORONA_ENERGY.transmitted + MOON_CORONA_ENERGY.scattered - 0.42,
) < 1e-12);
assert.ok(
  MOON_RENDER_ORDER.coronaTransmitted < MOON_RENDER_ORDER.disk
  && MOON_RENDER_ORDER.disk < MOON_RENDER_ORDER.cloudsStart
  && MOON_RENDER_ORDER.cloudsEnd < MOON_RENDER_ORDER.coronaScattered,
);
const cloudSweep = [0, 0.25, 0.5, 0.75, 1].map(resolveMoonCloudComposite);
assert.deepEqual(cloudSweep.map(({ disk }) => disk), [1, 0.75, 0.5, 0.25, 0]);
assert.ok(cloudSweep.every(({ corona }, index) => (
  Math.abs(corona - [0.42, 0.32, 0.22, 0.12, 0.02][index]) < 1e-12
)));
assert.ok(cloudSweep.every((sample, index) => (
  index === 0
  || (sample.disk < cloudSweep[index - 1].disk
    && sample.corona < cloudSweep[index - 1].corona)
)));
assert.ok(cloudSweep.every(Object.isFrozen));

const bloomGateSweep = Array.from({ length: 97 }, (_, index) => (
  resolveMoonBloomGate(0.32 + index * 0.005)
));
const smoothWeight = (value, edge0, edge1) => {
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};
const bloomWeights = bloomGateSweep.map((gate) => (
  smoothWeight(0.5, gate.threshold, gate.threshold + gate.smoothWidth)
));
const reverseBloomGateSweep = [...bloomGateSweep]
  .reverse()
  .map(({ authoredThreshold }) => resolveMoonBloomGate(authoredThreshold));
assert.equal(bloomGateSweep[0].knee, MOON_BLOOM_KNEE.radius);
assert.equal(bloomGateSweep[0].threshold, 0.22);
assert.equal(bloomGateSweep[0].smoothWidth, 0.20);
assert.equal(bloomGateSweep.at(-1).knee, 0);
assert.equal(bloomGateSweep.at(-1).smoothWidth, MOON_BLOOM_KNEE.stockWidth);
assert.ok(bloomGateSweep.every(Object.isFrozen));
assert.ok(bloomGateSweep.slice(1).every((gate, index) => (
  Math.abs(gate.threshold - bloomGateSweep[index].threshold) < 0.01
  && Math.abs(gate.smoothWidth - bloomGateSweep[index].smoothWidth) < 0.01
  && Math.abs(bloomWeights[index + 1] - bloomWeights[index]) < 0.20
)), 'night bloom knee releases continuously across time-of-day threshold tween');
assert.ok(reverseBloomGateSweep.every((gate, index) => {
  const forward = bloomGateSweep.at(-(index + 1));
  return Math.abs(gate.threshold - forward.threshold) < 1e-12
    && Math.abs(gate.smoothWidth - forward.smoothWidth) < 1e-12;
}), 'time-of-day reversal retraces the same bloom gate without hysteresis');

const moonSource = await readFile(new URL('../src/env/moon-optics.js', import.meta.url), 'utf8');
assert.doesNotMatch(moonSource, /from\s+['"]three['"]|document\.|window\.|WebGL/i,
  'moon optics remain renderer/browser independent');
const moonFacade = await readFile(new URL('../src/api/moon-optics.js', import.meta.url), 'utf8');
assert.doesNotMatch(moonFacade, /from\s+['"]three['"]|document\.|window\.|WebGL/i,
  'the public Moon façade stays renderer/browser independent');

console.log(
  'ATMOSPHERE CONTRACT: PASS '
  + '(3 synchronized sunset looks, stable sun direction, 0.52° Moon + split 5° corona)',
);
