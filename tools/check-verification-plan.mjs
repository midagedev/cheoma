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
assert.deepEqual(ids(['docs/verification.md', 'src/env/post.js']), ['docs', 'core', 'app', 'dof-app', 'aa']);
assert.deepEqual(ids(['src/env/post.js']), ['core', 'app', 'dof-app', 'aa']);
// 컴포저 MSAA 는 post.js 와 같은 축이므로 신규 패스 모듈도 같은 게이트 묶음을 끈다.
assert.deepEqual(ids(['src/env/msaa-render-pass.js']), ['core', 'app', 'dof-app', 'aa']);
assert.deepEqual(ids(['src/env/bokeh-coc-contract.js']), [
  'core', 'app', 'dof-app', 'bokeh-fixture', 'lod-focus',
]);
assert.deepEqual(ids(['src/env/bokeh-coc-pass.js']), [
  'core', 'app', 'dof-app', 'bokeh-fixture', 'lod-focus',
]);
assert.deepEqual(ids(['src/env/bokeh-coc-shaders.js']), [
  'core', 'app', 'dof-app', 'bokeh-fixture', 'lod-focus',
]);
assert.deepEqual(ids(['src/env/post-quality-state.js']), [
  'core', 'app', 'dof-app', 'lod-focus',
]);
assert.deepEqual(ids(['src/env/circular-bokeh-shader.js']), [
  'core', 'app', 'dof-app', 'bokeh-fixture', 'lod-focus',
]);
assert.deepEqual(ids(['src/env/bokeh-source-scatter.js']), [
  'core', 'app', 'dof-app', 'bokeh-fixture', 'lod-focus',
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
// #219 / U4 seasonal ground carpet — reviewed pure plan + carpet renderer.
assert.deepEqual(ids(['src/env/season-ground-plan.js'], {
  newPaths: ['src/env/season-ground-plan.js'],
}), ['core', 'app', 'petals', 'lod-app']);
assert.deepEqual(ids(['src/env/season-ground-carpet.js'], {
  newPaths: ['src/env/season-ground-carpet.js'],
}), ['core', 'app', 'petals', 'particle-geometry', 'lod-app']);
assert.deepEqual(ids(['tools/check-season-ground-contract.mjs'], {
  newPaths: ['tools/check-season-ground-contract.mjs'],
}), ['core']);
assert.deepEqual(ids(['tools/shoot-seasons.mjs'], {
  newPaths: ['tools/shoot-seasons.mjs'],
}), ['core', 'petals']);
assert.deepEqual(ids(['src/env/edge-mist-view.js']), ['core', 'app', 'api-reuse', 'lod-app']);
// #31 마을 대기 밴드(카메라 거리 파생). 부감·근접·웨이브 프레이밍이 전부 이 식을 읽으므로
//   focus/wave LOD 와 깊이 대비(dof-app)까지 라우팅된다.
assert.deepEqual(ids(['src/env/village-fog-band.js'], {
  newPaths: ['src/env/village-fog-band.js'],
}), ['core', 'app', 'dof-app', 'lod-app']);
assert.deepEqual(ids(['tools/check-village-fog-band.mjs'], {
  newPaths: ['tools/check-village-fog-band.mjs'],
}), ['core']);
// #35-1 부감·시네마틱 역광 림: 정책 분리·거리 밴드 계약은 순수 core, 증거 수집 하네스는
//   캡처-온리라 소유 게이트가 없다(둘 다 reviewed new path 라 full 로 낙하하지 않는다).
assert.deepEqual(ids(['tools/check-rim-master.mjs'], {
  newPaths: ['tools/check-rim-master.mjs'],
}), ['core']);
assert.deepEqual(ids(['tools/shoot-rim-aerial.mjs'], {
  newPaths: ['tools/shoot-rim-aerial.mjs'],
}), ['core']);
// #35-R2 대기 워시·부감 돔 구배: 순수 노드라 core 만 소유한다.
assert.deepEqual(ids(['tools/check-fog-wash.mjs'], {
  newPaths: ['tools/check-fog-wash.mjs'],
}), ['core']);
assert.deepEqual(ids(['src/village/forest-canopy-atten.js'], {
  newPaths: ['src/village/forest-canopy-atten.js'],
}), ['core', 'app', 'worker']);
assert.deepEqual(ids(['tools/check-forest-canopy-atten.mjs'], {
  newPaths: ['tools/check-forest-canopy-atten.mjs'],
}), ['core']);
assert.deepEqual(ids(['src/village/foliage-value-stratify.js'], {
  newPaths: ['src/village/foliage-value-stratify.js'],
}), ['core', 'app', 'worker']);
assert.deepEqual(ids(['tools/check-scatter-tree-color.mjs'], {
  newPaths: ['tools/check-scatter-tree-color.mjs'],
}), ['core']);
assert.deepEqual(ids(['tools/check-instance-merge-immutability.mjs'], {
  newPaths: ['tools/check-instance-merge-immutability.mjs'],
}), ['core']);
// #150 C roof-rank pure policy — reviewed new path under the shared builder routing.
// builder/* also sits on the public building reuse graph → api-reuse.
assert.deepEqual(ids(['src/builder/roof-rank.js'], {
  newPaths: ['src/builder/roof-rank.js'],
}), ['core', 'app', 'building-lifecycle', 'api-reuse', 'worker']);
assert.deepEqual(ids(['tools/check-roof-rank-contract.mjs'], {
  newPaths: ['tools/check-roof-rank-contract.mjs'],
}), ['core']);
assert.deepEqual(ids(['src/village/plan.js']), ['core', 'app', 'worker']);
for (const path of [
  'src/village/auxiliary-building-plan.js',
  'src/village/auxiliary-building-geometry.js',
  'src/api/auxiliary-building-plan.js',
  'src/api/auxiliary-building.js',
]) {
  assert.deepEqual(ids([path], {
    newPaths: [path],
  }), ['core', 'app', 'worker', 'lod-app', 'parcel-rebuild-browser']);
}
for (const path of [
  'tools/check-auxiliary-building-plan.mjs',
  'tools/check-auxiliary-building-geometry.mjs',
]) {
  assert.deepEqual(ids([path], { newPaths: [path] }), ['core']);
}
assert.deepEqual(ids(['src/village/sijeon-plan.js'], {
  newPaths: ['src/village/sijeon-plan.js'],
}), ['core', 'app', 'worker']);
assert.deepEqual(ids(['src/generators/village/sijeon.js'], {
  newPaths: ['src/generators/village/sijeon.js'],
}), ['core', 'app', 'rim', 'api-reuse', 'winter-app', 'worker', 'lod-wave']);
assert.deepEqual(ids(['src/api/sijeon.js'], {
  newPaths: ['src/api/sijeon.js'],
}), ['core', 'app', 'rim', 'api-reuse', 'winter-app', 'worker', 'lod-wave']);
assert.deepEqual(ids(['src/api/sijeon-plan.js'], {
  newPaths: ['src/api/sijeon-plan.js'],
}), ['core', 'app', 'api-reuse', 'worker']);
assert.deepEqual(ids(['src/village/yard-life-plan.js'], {
  newPaths: ['src/village/yard-life-plan.js'],
}), ['core', 'app', 'yard-life', 'worker']);
assert.deepEqual(ids(['src/generators/village/yard-life.js'], {
  newPaths: ['src/generators/village/yard-life.js'],
}), ['core', 'app', 'yard-life', 'winter-app', 'worker', 'lod-app']);
assert.deepEqual(ids(['src/generators/village/yard-life-geometry.js'], {
  newPaths: ['src/generators/village/yard-life-geometry.js'],
}), ['core', 'app', 'yard-life', 'winter-app', 'worker', 'lod-app']);
assert.deepEqual(ids(['src/generators/village/yard-life-product.js'], {
  newPaths: ['src/generators/village/yard-life-product.js'],
}), ['core', 'app', 'yard-life', 'winter-app', 'worker', 'lod-app']);
assert.deepEqual(ids(['src/village/yard-life-record-contract.js'], {
  newPaths: ['src/village/yard-life-record-contract.js'],
}), ['core', 'app', 'yard-life', 'worker']);
assert.deepEqual(ids(['src/village/yard-layout.js']), [
  'core', 'app', 'yard-life', 'worker',
]);
assert.deepEqual(ids(['src/runtime/village/yard-life.js'], {
  newPaths: ['src/runtime/village/yard-life.js'],
}), ['core', 'app', 'yard-life', 'worker', 'lod-app']);
assert.deepEqual(ids(['src/api/yard-life.js'], {
  newPaths: ['src/api/yard-life.js'],
}), ['core', 'app', 'yard-life', 'winter-app', 'worker', 'lod-app']);
assert.deepEqual(ids(['src/api/yard-life-plan.js'], {
  newPaths: ['src/api/yard-life-plan.js'],
}), ['core', 'app', 'yard-life', 'worker']);
assert.deepEqual(ids(['tools/shoot-yard-life-app.mjs'], {
  newPaths: ['tools/shoot-yard-life-app.mjs'],
}), ['core', 'app', 'yard-life']);
assert.deepEqual(ids(['src/village/options.js']), ['core', 'share', 'app', 'worker']);
assert.deepEqual(ids(['src/generators/village/roads.js']), [
  'core', 'app', 'worker', 'surface-browser',
]);
assert.deepEqual(ids(['src/village/drainage-plan.js'], {
  newPaths: ['src/village/drainage-plan.js'],
}), ['core', 'app', 'worker', 'surface-browser']);
assert.deepEqual(ids(['src/village/drainage-geometry.js'], {
  newPaths: ['src/village/drainage-geometry.js'],
}), ['core', 'app', 'worker', 'surface-browser']);
assert.deepEqual(ids(['src/api/drainage-plan.js'], {
  newPaths: ['src/api/drainage-plan.js'],
}), ['core', 'app', 'worker', 'surface-browser']);
assert.deepEqual(ids(['src/api/drainage.js'], {
  newPaths: ['src/api/drainage.js'],
}), ['core', 'app', 'worker', 'surface-browser']);
assert.deepEqual(ids(['src/village/dangsan-plan.js'], {
  newPaths: ['src/village/dangsan-plan.js'],
}), ['core', 'app', 'worker']);
assert.deepEqual(ids(['src/village/dangsan-geometry.js'], {
  newPaths: ['src/village/dangsan-geometry.js'],
}), ['core', 'app', 'worker']);
assert.deepEqual(ids(['src/api/dangsan-plan.js'], {
  newPaths: ['src/api/dangsan-plan.js'],
}), ['core', 'app', 'worker']);
assert.deepEqual(ids(['src/api/dangsan.js'], {
  newPaths: ['src/api/dangsan.js'],
}), ['core', 'app', 'worker']);
assert.deepEqual(ids(['src/village/mja-house-plan.js'], {
  newPaths: ['src/village/mja-house-plan.js'],
}), ['core', 'app', 'worker', 'mja-house-browser']);
for (const path of [
  'src/village/mja-house-plan-core.js',
  'src/village/mja-house-plan-contract.js',
]) {
  assert.deepEqual(ids([path], {
    newPaths: [path],
  }), ['core', 'app', 'worker', 'mja-house-browser']);
}
for (const path of [
  'src/builder/choga-frame-plan.js',
  'src/builder/giwa-middle-gate.js',
  'src/layout/giwa-roof-envelope.js',
  'src/layout/giwa-through-passage.js',
]) {
  assert.deepEqual(ids([path], {
    newPaths: [path],
  }), path === 'src/builder/choga-frame-plan.js'
    ? ['core', 'app', 'building-lifecycle', 'api-reuse', 'worker']
    : ['core', 'app', 'building-lifecycle', 'api-reuse', 'worker', 'mja-house-browser']);
}
assert.deepEqual(ids(['src/village/mja-house-geometry.js'], {
  newPaths: ['src/village/mja-house-geometry.js'],
}), ['core', 'app', 'worker', 'mja-house-browser']);
assert.deepEqual(ids(['src/api/mja-house-plan.js'], {
  newPaths: ['src/api/mja-house-plan.js'],
}), ['core', 'app', 'worker', 'mja-house-browser']);
assert.deepEqual(ids(['src/api/mja-house.js'], {
  newPaths: ['src/api/mja-house.js'],
}), ['core', 'app', 'worker', 'mja-house-browser']);
assert.deepEqual(ids(['tools/shoot-mja-house.mjs'], {
  newPaths: ['tools/shoot-mja-house.mjs'],
}), ['core', 'mja-house-browser']);
assert.deepEqual(ids(['tools/check-render-budget-contract.mjs'], {
  newPaths: ['tools/check-render-budget-contract.mjs'],
}), ['core']);
assert.deepEqual(ids(['tools/lib/render-budget-contract.mjs'], {
  newPaths: ['tools/lib/render-budget-contract.mjs'],
}), ['core', 'lod-focus']);
assert.deepEqual(ids(['tools/shoot-thatch.mjs'], {
  newPaths: ['tools/shoot-thatch.mjs'],
}), ['core', 'app']);
assert.deepEqual(ids(['tools/shoot-drainage.mjs'], {
  newPaths: ['tools/shoot-drainage.mjs'],
}), ['core', 'app', 'surface-browser']);
assert.deepEqual(ids(['tools/shoot-brush-fence.mjs'], {
  newPaths: ['tools/shoot-brush-fence.mjs'],
}), ['core', 'surface-browser']);
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
  'core', 'app', 'ui-shell', 'entry', 'parcel-rebuild-browser', 'build',
]);
assert.deepEqual(ids(['app/src/lib/scene-snapshot.js']), [
  'core', 'share', 'app', 'build',
]);
assert.deepEqual(ids(['app/src/lib/standalone-param-spec.js']), [
  'core', 'share', 'app', 'build',
]);
assert.deepEqual(ids(['app/src/lib/scene-guide.js']), [
  'core', 'app', 'ui-shell', 'build',
]);
assert.deepEqual(ids(['app/src/lib/building-navigation.js']), [
  'core', 'app', 'ui-shell', 'build',
]);
assert.deepEqual(ids(['app/src/components/SceneGuide.svelte']), [
  'core', 'app', 'ui-shell', 'build',
]);
assert.deepEqual(ids(['app/src/engine/semantic-view-runtime.js']), [
  'core', 'share', 'app', 'dof-app', 'lod-app', 'build',
]);
assert.deepEqual(ids(['app/src/lib/standalone-param-spec.js'], {
  newPaths: ['app/src/lib/standalone-param-spec.js'],
}), ['core', 'share', 'app', 'build']);
assert.deepEqual(ids(['app/src/engine/semantic-view-runtime.js'], {
  newPaths: ['app/src/engine/semantic-view-runtime.js'],
}), ['core', 'share', 'app', 'dof-app', 'lod-app', 'build']);
assert.deepEqual(ids(['app/src/lib/scene-guide.js'], {
  newPaths: ['app/src/lib/scene-guide.js'],
}), ['core', 'app', 'ui-shell', 'build']);
assert.deepEqual(ids(['app/src/lib/building-navigation.js'], {
  newPaths: ['app/src/lib/building-navigation.js'],
}), ['core', 'app', 'ui-shell', 'build']);
assert.deepEqual(ids(['app/src/components/SceneGuide.svelte'], {
  newPaths: ['app/src/components/SceneGuide.svelte'],
}), ['core', 'app', 'ui-shell', 'build']);
assert.deepEqual(ids(['app/src/lib/live-edit-scheduler.js']), [
  'core', 'app', 'parcel-rebuild-browser', 'build',
]);
// #26 고쳐짓기: the pure morph plan feeds the live-edit rebuild path, so it owns the
// same focused-rebuild browser gate; its contract gate is FAST_CHECKS-pure.
assert.deepEqual(ids(['app/src/lib/rebuild-morph.js'], {
  newPaths: ['app/src/lib/rebuild-morph.js'],
}), ['core', 'app', 'parcel-rebuild-browser', 'build']);
assert.deepEqual(ids(['tools/check-rebuild-morph.mjs'], {
  newPaths: ['tools/check-rebuild-morph.mjs'],
}), ['core']);
// #30 감상 모드 캡처 하네스: 판정 없는 캡처-온리 도구라 소유 브라우저 게이트가 없다(core 기본만).
assert.deepEqual(ids(['tools/shoot-cine.mjs'], {
  newPaths: ['tools/shoot-cine.mjs'],
}), ['core']);
assert.deepEqual(ids(['app/src/engine/village-camera-runtime.js']), [
  'core', 'app', 'dof-app', 'lod-app', 'build',
]);
assert.deepEqual(ids(['app/src/engine/post-quality-runtime.js']), [
  'core', 'app', 'dof-app', 'lod-focus', 'build',
]);
assert.deepEqual(ids(['app/src/engine/post-runtime.js']), [
  'core', 'app', 'dof-app', 'aa', 'lod-focus', 'build',
]);
assert.deepEqual(ids(['app/src/engine/scene-runtime.js']), [
  'core', 'app', 'dof-app', 'aa', 'build',
]);
assert.deepEqual(ids(['app/src/engine/directional-shadow-runtime.js']), [
  'core', 'app', 'rim', 'lod-focus', 'build',
]);
// #158: the view card owns the environment dial.
assert.deepEqual(ids(['app/src/components/EnvironmentDial.svelte']), [
  'core', 'app', 'ui-shell', 'winter-app', 'build',
]);
assert.deepEqual(ids(['app/src/components/Breadcrumb.svelte'], {
  newPaths: ['app/src/components/Breadcrumb.svelte'],
}), ['core', 'app', 'ui-shell', 'build']);
assert.deepEqual(ids(['tools/check-ui-shell.mjs'], {
  newPaths: ['tools/check-ui-shell.mjs'],
}), ['core', 'ui-shell']);
assert.deepEqual(ids(['app/src/lib/edit-schema.js']), [
  'core', 'app', 'ui-shell', 'build',
]);
assert.deepEqual(ids(['src/api/village.js']), [
  'core', 'app', 'worker', 'lod-app',
]);
assert.deepEqual(ids(['src/api/village-plan.js']), ['core', 'app', 'worker']);
assert.deepEqual(ids(['src/api/village-options.js']), ['core', 'share', 'app', 'worker']);
assert.deepEqual(ids(['src/api/environment-state.js']), ['core', 'share']);
assert.deepEqual(ids(['src/api/shadow-framing.js']), ['core', 'app', 'rim', 'lod-focus']);
assert.deepEqual(ids(['src/api/post-quality.js']), [
  'core', 'app', 'dof-app', 'lod-focus',
]);
assert.deepEqual(ids(['src/api/rendering.js']), ['core', 'app']);
// The app's focus policy runtime is an ordinary engine runtime: it carries the
// application smoke and build gates, and no render-mode gate of its own.
assert.deepEqual(ids(['app/src/engine/focus-policy-runtime.js']), ['core', 'app', 'build']);
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
assert.deepEqual(ids(['tools/check-scene-snapshot.mjs']), ['core', 'share']);
assert.deepEqual(ids(['tools/check-scene-guide.mjs']), ['core']);
assert.deepEqual(ids(['tools/check-building-navigation.mjs']), ['core']);
assert.deepEqual(ids(['tools/check-sijeon-contract.mjs'], {
  newPaths: ['tools/check-sijeon-contract.mjs'],
}), ['core']);
assert.deepEqual(ids(['tools/shoot-sijeon.mjs'], {
  newPaths: ['tools/shoot-sijeon.mjs'],
}), ['core', 'app', 'api-reuse']);
assert.deepEqual(ids(['tools/shoot-sijeon-app.mjs'], {
  newPaths: ['tools/shoot-sijeon-app.mjs'],
}), ['core', 'app', 'api-reuse']);
assert.deepEqual(ids(['tools/check-yard-life-contract.mjs'], {
  newPaths: ['tools/check-yard-life-contract.mjs'],
}), ['core']);
assert.deepEqual(ids(['tools/shoot-yard-life.mjs'], {
  newPaths: ['tools/shoot-yard-life.mjs'],
}), ['core', 'yard-life']);
assert.deepEqual(ids(['tools/check-api-reuse-suite.mjs'], {
  newPaths: ['tools/check-api-reuse-suite.mjs'],
}), ['core', 'api-reuse']);
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
assert.deepEqual(ids(['tools/shoot-hanyang.mjs']), ['core', 'app']);
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
// #22 카메라 전환 연속성 게이트 추가: optics 의 렌즈·줌 범위 정책이 뷰 시프트 스프링과 줌 범위
// 핸드오프 계약의 입력이므로 check-camera-continuity 가 같은 impact 집합에 들어온다.
assert.deepEqual(impactedFastChecks(['src/camera/optics.js']), [
  './check-architecture.mjs', './check-camera-continuity.mjs',
  './check-dof.mjs', './check-plan-contract.mjs', './check-lod.mjs',
]);
// 편집 대상 런타임(뷰 시프트·마을 카메라)은 esbuild 번들이라 정적 폐쇄에 잡히지 않으므로
// EXACT_IMPACT 로 소유 계약을 고정한다. 브라우저 게이트는 'camera runtime changed' 가 맡는다.
assert.deepEqual(impactedFastChecks(['app/src/engine/view-shift.js']), [
  './check-architecture.mjs', './check-camera-continuity.mjs',
]);
assert.deepEqual(impactedFastChecks(['app/src/engine/village-camera-runtime.js']), [
  './check-architecture.mjs', './check-camera-continuity.mjs',
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
  './check-architecture.mjs',
  './check-instance-upload.mjs',
  './check-instance-merge-immutability.mjs',
  './check-program-diet.mjs',
]);
assert.deepEqual(impactedFastChecks(['src/village/wave.js']), [
  './check-architecture.mjs', './check-instance-upload.mjs', './check-wave-contract.mjs',
]);
assert.deepEqual(impactedFastChecks(['src/core/buffer-update-range.js']), [
  './check-architecture.mjs', './check-instance-upload.mjs', './check-wave-contract.mjs',
]);
assert.deepEqual(impactedFastChecks(['src/village/wall-contract.js']), [
  './check-architecture.mjs',
  './check-auxiliary-building-plan.mjs',
  './check-house-diversity.mjs',
  './check-mja-house-plan.mjs',
  './check-mja-house-integration.mjs',
  './check-door-occlusion-contract.mjs',
  './check-cinematic-reveal.mjs',
  './check-walk-solids.mjs',
'./check-roof-rank-contract.mjs',
  './check-plan-contract.mjs',
  './check-temple-contract.mjs',
  './check-road-contract.mjs',
  './check-drainage-plan.mjs',
  './check-dangsan-plan.mjs',
  './check-layout-contract.mjs',
  './check-gosat-topology.mjs',
  './check-wall-gate-contract.mjs',
  './check-wall-step-contract.mjs',
  './check-pad-landing.mjs',
  './check-yard-layout-contract.mjs',
  './check-yard-polygon-contract.mjs',
  './check-yard-proportion-contract.mjs',
  './check-yard-life-contract.mjs',
  './check-critter-contract.mjs',
  './check-parcel-rebuild-contract.mjs',
  './check-lod.mjs',
  './check-citywall.mjs',
  // #20 R4 (2026-07-31): 개천 계약이 planVillage 폐쇄를 공유하므로 마을 계획 경로 변경에 함께 붙는다.
  './check-creek.mjs',
]);
assert.deepEqual(impactedFastChecks(['src/village/pad-landing-plan.js']), [
  './check-architecture.mjs',
  './check-pad-landing.mjs',
]);
assert.deepEqual(impactedFastChecks(['tools/check-pad-landing.mjs']), [
  './check-architecture.mjs',
  './check-pad-landing.mjs',
]);
assert.deepEqual(impactedFastChecks(['src/generators/village/pads.js']), [
  './check-architecture.mjs',
  './check-pad-landing.mjs',
]);
assert.deepEqual(ids(['src/village/pad-landing-plan.js'], {
  newPaths: ['src/village/pad-landing-plan.js'],
}), ['core']);
assert.deepEqual(ids(['tools/check-pad-landing.mjs'], {
  newPaths: ['tools/check-pad-landing.mjs'],
}), ['core']);

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
  'docs', 'core-full', 'app', 'ui-shell', 'entry', 'petals', 'particle-geometry',
  'instance-upload', 'building-lifecycle', 'api-reuse', 'yard-life', 'winter-app', 'worker', 'audio', 'temple-browser',
  'mja-house-browser', 'parcel-rebuild-browser', 'surface-browser',
]);
assert.deepEqual(FULL_PROFILE, [
  ...ALL_PROFILE, 'dof-app', 'aa', 'rim', 'lod-app', 'cinematic-app', 'build',
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
