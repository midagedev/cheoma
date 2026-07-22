import assert from 'node:assert/strict';
import {
  ENVIRONMENT_SCENES,
  SEASON_IDS,
  environmentSceneKey,
  normalizeEnvironmentState,
  pickEnvironmentScene,
  resolveEnvironmentChange,
  weatherOkForSeason,
} from '../src/env/environment-state.js';

const keys = new Set();
for (const scene of ENVIRONMENT_SCENES) {
  assert.ok(weatherOkForSeason(scene.we, scene.se), `invalid curated scene: ${environmentSceneKey(scene)}`);
  assert.ok(scene.k > 0, `non-positive scene weight: ${environmentSceneKey(scene)}`);
  assert.ok(!keys.has(environmentSceneKey(scene)), `duplicate curated scene: ${environmentSceneKey(scene)}`);
  keys.add(environmentSceneKey(scene));
}
for (const season of SEASON_IDS) {
  assert.ok(ENVIRONMENT_SCENES.some((scene) => scene.se === season && scene.we === 'clear'), `${season} has no clear scene`);
}

assert.deepEqual(normalizeEnvironmentState({ season: 'summer', weather: 'snow' }), { season: 'winter', weather: 'snow' });
assert.deepEqual(normalizeEnvironmentState({ season: 'winter', weather: 'rain' }), { season: 'spring', weather: 'rain' });
assert.deepEqual(resolveEnvironmentChange({ season: 'summer', weather: 'rain' }, { season: 'winter' }), { season: 'winter', weather: 'clear' });
assert.deepEqual(resolveEnvironmentChange({ season: 'autumn', weather: 'clear' }, { weather: 'snow' }), { season: 'winter', weather: 'snow' });
assert.deepEqual(resolveEnvironmentChange({ season: 'winter', weather: 'clear' }, { weather: 'rain' }), { season: 'spring', weather: 'rain' });
assert.equal(weatherOkForSeason('snow', 'autumn'), false);
assert.equal(weatherOkForSeason('snow', 'winter'), true);

const sequence = [0.01, 0.24, 0.5, 0.77, 0.99];
for (const value of sequence) {
  const rng = () => value;
  const a = pickEnvironmentScene(rng);
  const b = pickEnvironmentScene(() => value);
  assert.equal(environmentSceneKey(a), environmentSceneKey(b), `non-deterministic pick at ${value}`);
  const next = pickEnvironmentScene(() => value, a);
  assert.notEqual(environmentSceneKey(next), environmentSceneKey(a), 'reroll repeated the current scene');
}

console.log(`environment state: ${ENVIRONMENT_SCENES.length} coherent curated scenes, ${SEASON_IDS.length} seasons PASS`);
