import assert from 'node:assert/strict';
import { planVerification, verificationCommands } from './lib/verification-plan.mjs';

function ids(files, options) {
  return verificationCommands(planVerification(files, options)).map((command) => command.id);
}

assert.deepEqual(ids(['docs/verification.md']), ['core']);
assert.deepEqual(ids(['src/env/post.js']), ['core', 'app', 'dof-app']);
assert.deepEqual(ids(['src/env/weather.js']), ['core', 'app', 'petals', 'winter-app', 'lod-wave']);
assert.deepEqual(ids(['src/env/petals.js']), ['core', 'app', 'petals', 'lod-focus']);
assert.deepEqual(ids(['src/village/plan.js']), ['core', 'app', 'worker']);
assert.deepEqual(ids(['src/generators/village/roads.js']), [
  'core', 'app', 'worker', 'surface-browser',
]);
assert.deepEqual(ids(['src/surfaces/packed-earth.js']), [
  'core', 'app', 'worker', 'surface-browser',
]);
assert.deepEqual(ids(['src/village/parcel-rebuild.js']), [
  'core', 'app', 'worker', 'parcel-rebuild-browser',
]);
assert.deepEqual(ids(['src/village/wave.js']), ['core', 'app', 'lod-wave']);
assert.deepEqual(ids(['src/env/focus.js']), ['core', 'app', 'lod-focus', 'lod-wave']);
assert.deepEqual(ids(['src/env/animals.js']), ['core', 'app', 'lod-focus', 'lod-wave']);
assert.deepEqual(ids(['src/runtime/village/ambient-field.js']), [
  'core', 'app', 'worker', 'lod-focus', 'lod-wave', 'parcel-rebuild-browser',
]);
assert.deepEqual(ids(['src/runtime/village/handle.js']), [
  'core', 'app', 'worker', 'lod-focus', 'lod-wave', 'parcel-rebuild-browser',
]);
assert.deepEqual(ids(['src/audio/index.js']), ['core', 'app', 'audio']);
assert.deepEqual(ids(['app/src/App.svelte']), [
  'core', 'app', 'ink-app', 'parcel-rebuild-browser', 'build',
]);
assert.deepEqual(ids(['app/src/lib/live-edit-scheduler.js']), [
  'core', 'app', 'parcel-rebuild-browser', 'build',
]);
assert.deepEqual(ids(['app/src/engine/village-camera-runtime.js']), [
  'core', 'app', 'dof-app', 'lod-focus', 'lod-wave', 'build',
]);
assert.deepEqual(ids(['app/src/components/EnvironmentDial.svelte']), [
  'core', 'app', 'winter-app', 'build',
]);
assert.deepEqual(ids(['src/api/village.js']), [
  'core', 'app', 'worker', 'lod-focus', 'lod-wave',
]);
assert.deepEqual(ids(['src/api/village-plan.js']), ['core', 'app', 'worker']);
assert.deepEqual(ids(['src/render/ink.js']), ['core', 'app', 'ink-app']);
assert.deepEqual(ids(['app/src/engine/ink-mode-runtime.js']), ['core', 'app', 'ink-app', 'build']);
assert.deepEqual(ids(['src/api/rendering.js']), ['core', 'app']);
assert.deepEqual(ids(['src/api/ink.js']), ['core', 'app', 'ink-app']);
assert.deepEqual(ids(['src/api/render-style.js']), ['core', 'app', 'ink-app']);
assert.deepEqual(ids(['src/env/weather.js', 'src/village/plan.js']), [
  'core', 'app', 'petals', 'winter-app', 'worker', 'lod-wave',
]);
assert.deepEqual(ids(['package-lock.json']), ['full']);
assert.equal(planVerification(['package-lock.json']).routes[0].full, true);
assert.deepEqual(ids(['src/unmapped-future-domain.js']), ['full']);
assert.deepEqual(ids(['src/env/new-bokeh-backend.js'], {
  newPaths: ['src/env/new-bokeh-backend.js'],
}), ['full']);
assert.deepEqual(ids(['docs/new-note.md'], { newPaths: ['docs/new-note.md'] }), ['core']);
assert.deepEqual(ids(['docs/verification.md'], { forceFullReason: 'base lookup failed' }), ['full']);
assert.throws(() => planVerification(['../outside.js']), /unsafe verification path/);
assert.throws(() => planVerification(['/absolute.js']), /unsafe verification path/);

const deduped = planVerification(['src/env/post.js', './src/env/post.js']);
assert.deepEqual(deduped.files, ['src/env/post.js']);

console.log('VERIFICATION PLAN: PASS (routing union, dedupe, unsafe/unknown fail-closed)');
