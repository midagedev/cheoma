import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planVerification, verificationCommands } from './lib/verification-plan.mjs';
import {
  ALL_PROFILE,
  FULL_PROFILE,
  VERIFICATION_GATES,
} from './lib/verification-gates.mjs';
import {
  API_REUSE_DEPENDENCIES,
  impactedFastChecks,
} from './lib/verification-impact.mjs';

function ids(files, options) {
  return verificationCommands(planVerification(files, options)).map((command) => command.id);
}

assert.deepEqual(ids(['docs/verification.md']), ['docs']);
assert.deepEqual(ids(['docs/verification.md', 'src/env/post.js']), ['docs', 'core', 'app', 'dof-app']);
assert.deepEqual(ids(['src/env/post.js']), ['core', 'app', 'dof-app']);
assert.deepEqual(ids(['src/env/post-quality-state.js']), [
  'core', 'app', 'ink-app', 'dof-app', 'lod-focus',
]);
assert.deepEqual(ids(['src/env/circular-bokeh-shader.js']), [
  'core', 'app', 'ink-app', 'dof-app', 'bokeh-fixture', 'lod-focus',
]);
assert.deepEqual(ids(['src/env/bokeh-source-scatter.js']), [
  'core', 'app', 'ink-app', 'dof-app', 'bokeh-fixture', 'lod-focus',
]);
assert.deepEqual(ids(['src/env/rim.js']), ['core', 'app', 'dof-app', 'rim']);
assert.deepEqual(ids(['src/env/clouds.js']), ['core', 'app', 'rim', 'api-reuse', 'lod-app']);
assert.deepEqual(ids(['src/env/snow-material.js']), ['core', 'app', 'rim', 'winter-app']);
assert.deepEqual(ids(['src/env/weather.js']), [
  'core', 'app', 'petals', 'particle-geometry', 'winter-app', 'lod-wave',
]);
assert.deepEqual(ids(['src/env/petals.js']), [
  'core', 'app', 'petals', 'particle-geometry', 'lod-focus',
]);
assert.deepEqual(ids(['src/env/motes.js']), [
  'core', 'app', 'particle-geometry', 'lod-app',
]);
assert.deepEqual(ids(['src/env/detail-particle-geometry.js']), [
  'core', 'app', 'particle-geometry',
]);
assert.deepEqual(ids(['src/env/edge-mist-view.js']), ['core', 'app', 'api-reuse', 'lod-app']);
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
assert.deepEqual(ids(['src/village/wave.js']), ['core', 'app', 'instance-upload', 'lod-wave']);
assert.deepEqual(ids(['src/env/focus.js']), ['core', 'app', 'lod-app']);
assert.deepEqual(ids(['src/env/animals.js']), ['core', 'app', 'lod-app']);
assert.deepEqual(ids(['src/runtime/village/ambient-field.js']), [
  'core', 'app', 'worker', 'lod-app', 'parcel-rebuild-browser',
]);
assert.deepEqual(ids(['src/runtime/village/handle.js']), [
  'core', 'app', 'worker', 'lod-app', 'parcel-rebuild-browser',
]);
assert.deepEqual(ids(['src/audio/index.js']), ['core', 'app', 'audio']);
assert.deepEqual(ids(['app/src/App.svelte']), [
  'core', 'app', 'ink-app', 'parcel-rebuild-browser', 'build',
]);
assert.deepEqual(ids(['app/src/lib/live-edit-scheduler.js']), [
  'core', 'app', 'parcel-rebuild-browser', 'build',
]);
assert.deepEqual(ids(['app/src/engine/village-camera-runtime.js']), [
  'core', 'app', 'dof-app', 'lod-app', 'build',
]);
assert.deepEqual(ids(['app/src/engine/post-quality-runtime.js']), [
  'core', 'app', 'ink-app', 'dof-app', 'lod-focus', 'build',
]);
assert.deepEqual(ids(['app/src/engine/post-runtime.js']), [
  'core', 'app', 'ink-app', 'dof-app', 'lod-focus', 'build',
]);
assert.deepEqual(ids(['app/src/engine/directional-shadow-runtime.js']), [
  'core', 'app', 'rim', 'lod-focus', 'build',
]);
assert.deepEqual(ids(['app/src/components/EnvironmentDial.svelte']), [
  'core', 'app', 'winter-app', 'build',
]);
assert.deepEqual(ids(['src/api/village.js']), [
  'core', 'app', 'worker', 'lod-app',
]);
assert.deepEqual(ids(['src/api/village-plan.js']), ['core', 'app', 'worker']);
assert.deepEqual(ids(['src/api/shadow-framing.js']), ['core', 'app', 'rim', 'lod-focus']);
assert.deepEqual(ids(['src/api/post-quality.js']), [
  'core', 'app', 'ink-app', 'dof-app', 'lod-focus',
]);
assert.deepEqual(ids(['src/render/ink.js']), ['core', 'app', 'ink-app']);
assert.deepEqual(ids(['app/src/engine/ink-mode-runtime.js']), ['core', 'app', 'ink-app', 'build']);
assert.deepEqual(ids(['src/api/rendering.js']), ['core', 'app']);
assert.deepEqual(ids(['src/api/ink.js']), ['core', 'app', 'ink-app']);
assert.deepEqual(ids(['src/api/render-style.js']), ['core', 'app', 'ink-app']);
assert.deepEqual(ids(['src/builder/palette.js']), [
  'core', 'app', 'rim', 'building-lifecycle', 'api-reuse', 'winter-app', 'worker',
]);
assert.deepEqual(ids(['src/builder/index.js']), [
  'core', 'app', 'building-lifecycle', 'api-reuse', 'worker',
]);
assert.deepEqual(ids(['src/render/shadow-depth-texture-lifecycle.js']), [
  'core', 'app', 'building-lifecycle', 'api-reuse',
]);
assert.deepEqual(ids(['src/core/three-resources.js']), [
  'core', 'app', 'building-lifecycle', 'api-reuse', 'worker',
]);
assert.deepEqual(ids(['src/api/building.js']), [
  'core', 'app', 'building-lifecycle', 'api-reuse',
]);
assert.deepEqual(ids(['src/layout/hanok.js']), [
  'core', 'app', 'api-reuse', 'worker',
]);
assert.deepEqual(ids(['examples/api-building/main.js']), ['core', 'api-reuse']);
assert.deepEqual(ids(['src/village/palace.js']), ['core', 'app', 'api-reuse', 'worker']);
assert.deepEqual(ids(['src/rng.js']), ['core', 'app', 'api-reuse', 'worker']);
assert.deepEqual(ids(['src/props/threshold-life.js']), ['core', 'app', 'worker']);
assert.deepEqual(ids(['src/env/weather.js', 'src/village/plan.js']), [
  'core', 'app', 'petals', 'particle-geometry', 'winter-app', 'worker', 'lod-wave',
]);
assert.deepEqual(ids(['package-lock.json']), ['full']);
assert.equal(planVerification(['package-lock.json']).routes[0].full, true);
assert.deepEqual(ids(['src/unmapped-future-domain.js']), ['full']);
assert.deepEqual(ids(['src/env/new-bokeh-backend.js'], {
  newPaths: ['src/env/new-bokeh-backend.js'],
}), ['full']);
assert.deepEqual(ids(['docs/new-note.md'], { newPaths: ['docs/new-note.md'] }), ['docs']);
assert.deepEqual(ids(['docs/verification.md'], { forceFullReason: 'base lookup failed' }), ['full']);
assert.throws(() => planVerification(['../outside.js']), /unsafe verification path/);
assert.throws(() => planVerification(['/absolute.js']), /unsafe verification path/);

const deduped = planVerification(['src/env/post.js', './src/env/post.js']);
assert.deepEqual(deduped.files, ['src/env/post.js']);

assert.deepEqual(ids(['src/temple/plan.js']), [
  'core', 'app', 'worker', 'temple-browser', 'lod-focus',
]);
assert.deepEqual(ids(['src/interaction/door-motion.js']), [
  'core', 'app', 'dof-app', 'parcel-rebuild-browser',
]);
assert.deepEqual(ids(['src/cinematic/architectural-reveal.js']), [
  'core', 'app', 'cinematic-app',
]);
assert.deepEqual(ids(['tools/check-worker-contract.mjs']), ['core', 'worker']);
assert.deepEqual(ids(['tools/shoot-bokeh-fixture.mjs']), ['core', 'bokeh-fixture']);
for (const helper of [
  'tools/lib/bokeh-gpu-diagnostic.mjs',
  'tools/lib/bokeh-image-analysis.mjs',
  'tools/lib/bokeh-linear-sweep.mjs',
  'tools/lib/bokeh-optical-chart.mjs',
  'tools/lib/bokeh-scatter-proof.mjs',
  'tools/lib/bokeh-source-stress.mjs',
]) {
  assert.deepEqual(ids([helper]), ['core', 'bokeh-fixture'], `${helper} must run its owning fixture`);
}
assert.deepEqual(ids(['tools/shoot-bokeh-scatter-proof.mjs']), ['core', 'bokeh-fixture']);
assert.deepEqual(ids(['tools/shoot-wall-steps.mjs']), ['core', 'app']);
assert.deepEqual(ids(['src/village/nightlights.js']), [
  'core', 'app', 'dof-app', 'particle-geometry', 'instance-upload', 'worker', 'lod-wave',
]);
assert.deepEqual(ids(['src/village/nightlight-physical-geometry.js']), [
  'core', 'app', 'particle-geometry', 'instance-upload', 'worker',
]);
assert.deepEqual(ids(['src/village/instancing.js']), [
  'core', 'app', 'instance-upload', 'api-reuse', 'winter-app', 'worker', 'lod-app',
]);
assert.deepEqual(ids(['src/core/buffer-update-range.js']), [
  'core', 'app', 'instance-upload', 'api-reuse', 'worker', 'lod-wave',
]);
assert.deepEqual(ids(['src/api/particles.js']), ['core', 'app', 'particle-geometry']);
assert.deepEqual(ids(['src/api/particle-state.js']), ['core', 'particle-geometry']);
assert.deepEqual(ids(['src/api/lighting.js']), ['core', 'app', 'particle-geometry']);
assert.deepEqual(ids(['src/env/weather-particle-state.js']), [
  'core', 'app', 'particle-geometry',
]);
assert.deepEqual(ids(['src/env/lantern-sway.js']), [
  'core', 'app', 'lod-app',
]);
assert.deepEqual(ids(['tools/check-detail-particle-geometry.mjs']), [
  'core', 'particle-geometry',
]);
assert.deepEqual(ids(['tools/check-instance-upload-browser.mjs']), [
  'core', 'instance-upload',
]);
assert.deepEqual(ids(['tools/check-building-texture-lifecycle.mjs']), [
  'core', 'building-lifecycle',
]);
assert.deepEqual(ids(['tools/check-api-reuse-example.mjs']), [
  'core', 'api-reuse',
]);
const bokehCommands = verificationCommands(planVerification(['src/env/bokeh-source-scatter.js']));
assert.deepEqual(
  bokehCommands.find((command) => command.id === 'bokeh-fixture')?.args,
  ['run', 'shoot:bokeh:proof'],
);
assert.deepEqual(impactedFastChecks(['docs/verification.md']), []);
assert.deepEqual(impactedFastChecks(['.gitignore']), [
  './check-architecture.mjs', './check-verification-plan.mjs', './check-worktree-contract.mjs',
]);
assert.deepEqual(impactedFastChecks(['src/env/circular-bokeh-shader.js']), [
  './check-architecture.mjs', './check-dof.mjs',
]);
assert.deepEqual(impactedFastChecks(['src/camera/optics.js']), [
  './check-architecture.mjs', './check-dof.mjs', './check-plan-contract.mjs', './check-lod.mjs',
]);
assert.deepEqual(impactedFastChecks(['src/env/weather-physical-geometry.js']), [
  './check-architecture.mjs', './check-weather-geometry.mjs',
]);
assert.deepEqual(impactedFastChecks(['src/village/nightlight-physical-geometry.js']), [
  './check-architecture.mjs', './check-nightlight-geometry.mjs', './check-instance-upload.mjs',
]);
assert.deepEqual(impactedFastChecks(['src/village/nightlights.js']).includes(
  './check-nightlight-geometry.mjs',
), true);
assert.deepEqual(impactedFastChecks(['src/village/instancing.js']), [
  './check-architecture.mjs', './check-instance-upload.mjs',
]);
assert.deepEqual(impactedFastChecks(['src/village/wave.js']), [
  './check-architecture.mjs', './check-instance-upload.mjs', './check-wave-contract.mjs',
]);
assert.deepEqual(impactedFastChecks(['src/core/buffer-update-range.js']), [
  './check-architecture.mjs', './check-instance-upload.mjs', './check-wave-contract.mjs',
]);
assert.deepEqual(impactedFastChecks(['src/village/wall-contract.js']), [
  './check-architecture.mjs',
  './check-door-occlusion-contract.mjs',
  './check-wall-gate-contract.mjs',
  './check-wall-step-contract.mjs',
]);

assert.deepEqual(ids(['src/camera/optics.js']), [
  'core', 'app', 'dof-app', 'rim', 'api-reuse', 'worker', 'lod-app', 'cinematic-app',
]);
for (const path of API_REUSE_DEPENDENCIES) {
  assert.equal(
    planVerification([path]).gates.includes('api-reuse'),
    true,
    `${path} must retain the standalone API reuse gate`,
  );
}
assert.deepEqual(ALL_PROFILE, [
  'docs', 'core-full', 'app', 'ink-app', 'petals', 'particle-geometry',
  'instance-upload', 'building-lifecycle', 'api-reuse', 'winter-app', 'worker', 'audio', 'temple-browser',
  'parcel-rebuild-browser', 'surface-browser',
]);
assert.deepEqual(FULL_PROFILE, [
  ...ALL_PROFILE, 'dof-app', 'rim', 'lod-app', 'cinematic-app', 'build',
]);
for (const id of new Set([...ALL_PROFILE, ...FULL_PROFILE])) {
  assert.equal(typeof VERIFICATION_GATES[id]?.script, 'string', `${id} must map to a script`);
}
const packageScripts = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).scripts;
for (const [id, gate] of Object.entries(VERIFICATION_GATES)) {
  assert.equal(typeof packageScripts[gate.script], 'string', `${id} must map to npm script ${gate.script}`);
}

const scratch = mkdtempSync(join(tmpdir(), 'cheoma-check-pr-files-'));
try {
  const list = join(scratch, 'files.txt');
  writeFileSync(list, './src/env/post.js\n');
  const injected = spawnSync(process.execPath, ['tools/check-pr.mjs', '--json', '--files-from', list], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
  });
  assert.equal(injected.status, 0, injected.stderr);
  const injectedPlan = JSON.parse(injected.stdout);
  assert.equal(injectedPlan.full, false);
  assert.deepEqual(injectedPlan.files, ['src/env/post.js']);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log('VERIFICATION PLAN: PASS (routing union, dedupe, unsafe/unknown fail-closed)');
