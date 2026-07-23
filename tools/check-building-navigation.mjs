import assert from 'node:assert/strict';
import {
  buildingNavigationStatus,
  buildingNavigationTargetFromProxy,
  classifyBuildingNavigationTarget,
  normalizeBuildingNavigationTargets,
  resolveBuildingNavigationTarget,
} from '../app/src/lib/building-navigation.js';
import { advanceCameraTweenClock } from '../app/src/engine/semantic-view-runtime.js';

assert.equal(classifyBuildingNavigationTarget({ hero: true, heroStyle: 'hanok' }, 'p0'), 'head-house');
assert.equal(classifyBuildingNavigationTarget({ hero: true, heroStyle: 'palace' }, 'p1'), 'government');
assert.equal(classifyBuildingNavigationTarget({ family: 'palace-compound' }, 'court'), 'palace');
assert.equal(classifyBuildingNavigationTarget({}, 'temple'), 'temple');
assert.equal(classifyBuildingNavigationTarget({ kind: 'giwa' }, 'p2'), 'giwa');
assert.equal(classifyBuildingNavigationTarget({ kind: 'choga' }, 'p3'), 'choga');
assert.equal(classifyBuildingNavigationTarget({ kind: 'unknown' }, 'p4'), null);

assert.deepEqual(buildingNavigationTargetFromProxy({
  parcelId: 'p7',
  buildingSpec: { kind: 'giwa' },
  mesh: { forbidden: true },
}), { id: 'p7', type: 'giwa' });
assert.equal(buildingNavigationTargetFromProxy({
  parcelId: ' p8 ',
  buildingSpec: { kind: 'giwa' },
}), null);

const targets = normalizeBuildingNavigationTargets([
  { id: 'hero', type: 'head-house', ignored: { scene: true } },
  { id: 'p2', type: 'giwa' },
  { id: 'p3', type: 'choga' },
  { id: 'p4', type: 'giwa' },
  { id: 'p4', type: 'choga' },
  { id: '', type: 'giwa' },
  { id: 'p5', type: 'unknown' },
]);

assert.deepEqual(targets, [
  { id: 'hero', type: 'head-house', ordinal: 1 },
  { id: 'p2', type: 'giwa', ordinal: 1 },
  { id: 'p3', type: 'choga', ordinal: 1 },
  { id: 'p4', type: 'giwa', ordinal: 2 },
]);
assert.deepEqual(JSON.parse(JSON.stringify(targets)), targets);
assert.deepEqual(structuredClone(targets), targets);
assert.equal(resolveBuildingNavigationTarget(targets, 'p4')?.ordinal, 2);
assert.equal(resolveBuildingNavigationTarget(targets, 'missing'), null);
assert.deepEqual(buildingNavigationStatus(targets, 'p3'), {
  kind: 'focus',
  total: 4,
  selected: { id: 'p3', type: 'choga', ordinal: 1 },
});
assert.deepEqual(buildingNavigationStatus(targets, null), {
  kind: 'explore',
  total: 4,
  selected: null,
});
assert.deepEqual(buildingNavigationStatus([], 'p3'), {
  kind: 'empty',
  total: 0,
  selected: null,
});

assert.deepEqual(advanceCameraTweenClock(0, 1.9, 1 / 120, true), {
  elapsed: 1.9,
  progress: 1,
  done: true,
});
assert.deepEqual(advanceCameraTweenClock(0.4, 1.9, 0.1, false), {
  elapsed: 0.5,
  progress: 0.5 / 1.9,
  done: false,
});
assert.equal(advanceCameraTweenClock(0, 0, 1 / 60, true), null);

console.log('BUILDING NAVIGATION: PASS — stable JSON targets, labels, selection state, one-frame reduced motion');
