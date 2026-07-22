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

console.log('ATMOSPHERE CONTRACT: PASS (3 synchronized sunset looks, stable sun direction, pure reusable registry)');
