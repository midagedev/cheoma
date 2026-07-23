import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import {
  SCENE_GUIDE_DISMISSED_VALUE,
  SCENE_GUIDE_STORAGE_KEY,
  persistSceneGuideDismissal,
  sceneGuideIsVisible,
  sceneGuideWasDismissed,
} from '../app/src/lib/scene-guide.js';

class MemoryStorage {
  constructor() {
    this.values = new Map();
    this.reads = 0;
    this.writes = 0;
  }
  getItem(key) {
    this.reads++;
    return this.values.get(key) ?? null;
  }
  setItem(key, value) {
    this.writes++;
    this.values.set(key, value);
  }
}

assert.equal(SCENE_GUIDE_STORAGE_KEY, 'cheoma-scene-guide-v1');
assert.equal(SCENE_GUIDE_DISMISSED_VALUE, 'dismissed');

const visibleState = {
  sceneVillage: true,
  stable: true,
  heroVisible: false,
  heroLanding: false,
  waving: false,
  veil: false,
  cinematic: false,
  references: false,
  toast: false,
};

assert.equal(sceneGuideIsVisible(visibleState), true, 'fresh stable village should show');
assert.equal(sceneGuideIsVisible({ ...visibleState, dismissed: true }), false, 'seen guide should stay hidden');
assert.equal(sceneGuideIsVisible({ ...visibleState, sceneVillage: false }), false, 'standalone scene should hide');
assert.equal(sceneGuideIsVisible({ ...visibleState, stable: false }), false, 'unstable scene should hide');

for (const blocker of [
  'heroVisible',
  'heroLanding',
  'waving',
  'veil',
  'cinematic',
  'references',
  'toast',
]) {
  assert.equal(
    sceneGuideIsVisible({ ...visibleState, [blocker]: true }),
    false,
    `${blocker} must hide the guide`,
  );
}

const storage = new MemoryStorage();
let dismissed = sceneGuideWasDismissed(storage);
assert.equal(storage.reads, 1, 'App can seed one reactive dismissed state from storage');
assert.equal(dismissed, false);
assert.equal(sceneGuideIsVisible({ ...visibleState, dismissed }), true);
assert.equal(
  sceneGuideIsVisible({ ...visibleState, dismissed, locale: 'ko' }),
  true,
  'locale is not policy state',
);
// App updates its one Svelte $state before/alongside this independent best-effort
// write. The helpers contain no closure that could drift from that state.
dismissed = true;
assert.equal(persistSceneGuideDismissal(storage), true, 'successful persistence is reported');
assert.equal(sceneGuideIsVisible({ ...visibleState, dismissed }), false);
assert.equal(storage.writes, 1);
assert.equal(storage.values.get(SCENE_GUIDE_STORAGE_KEY), SCENE_GUIDE_DISMISSED_VALUE);
assert.equal(sceneGuideWasDismissed(storage), true);
assert.equal(
  sceneGuideIsVisible({ ...visibleState, dismissed: sceneGuideWasDismissed(storage) }),
  false,
  'revisit stays hidden',
);

storage.values.set(SCENE_GUIDE_STORAGE_KEY, 'unknown-value');
assert.equal(sceneGuideWasDismissed(storage), false, 'unknown versions/values fail open');
assert.equal(sceneGuideWasDismissed(null), false, 'missing storage fails open');
assert.equal(persistSceneGuideDismissal(null), false);

const failingStorage = {
  getItem() { throw new Error('read denied'); },
  setItem() { throw new Error('write denied'); },
};
let failOpenDismissed = sceneGuideWasDismissed(failingStorage);
assert.equal(
  sceneGuideIsVisible({ ...visibleState, dismissed: failOpenDismissed }),
  true,
  'read failure shows the guide',
);
failOpenDismissed = true;
assert.equal(persistSceneGuideDismissal(failingStorage), false, 'write failure is reported without throwing');
assert.equal(
  sceneGuideIsVisible({ ...visibleState, dismissed: failOpenDismissed }),
  false,
  'App-owned session state still dismisses after write failure',
);
assert.equal(
  sceneGuideIsVisible({
    ...visibleState,
    dismissed: sceneGuideWasDismissed(failingStorage),
  }),
  true,
  'a later storage-denied session remains fail-open',
);

const componentUrl = new URL('../app/src/components/SceneGuide.svelte', import.meta.url);
const componentSource = await readFile(componentUrl, 'utf8');
const requireFromApp = createRequire(new URL('../app/package.json', import.meta.url));
const { compile } = requireFromApp('svelte/compiler');
const compiled = compile(componentSource, {
  filename: componentUrl.pathname,
  generate: 'client',
  modernAst: true,
});
assert.equal(compiled.warnings.length, 0, 'SceneGuide should compile without Svelte warnings');

assert.match(componentSource, /\.scene-guide\s*\{[^}]*pointer-events:\s*none/s);
assert.match(componentSource, /\.dismiss\s*\{[^}]*min-width:\s*44px[^}]*min-height:\s*44px/s);
assert.match(componentSource, /\.dismiss\s*\{[^}]*pointer-events:\s*auto/s);
assert.match(
  componentSource,
  /:\s*\['↻',\s*'＋',\s*'⌂',\s*'↩'\]/,
  'desktop exit should use a return mark while the localized copy names Esc once',
);
assert.doesNotMatch(componentSource, /class:word|\.mark\.word/, 'guide marks share one visual grammar');
assert.match(
  componentSource,
  /@media \(max-height: 520px\) and \(orientation: landscape\)[\s\S]*?\.scene-guide\.touch\s*\{[^}]*bottom:\s*max\(88px,\s*calc\(env\(safe-area-inset-bottom\) \+ 82px\)\)/,
  'landscape touch guide must clear the raised ActionBar input envelope',
);
assert.equal((componentSource.match(/onclick=/g) || []).length, 1, 'only dismiss owns pointer input');
for (const forbidden of ['autofocus', '<dialog', 'scrim', '.focus(', 'setTimeout']) {
  assert.equal(componentSource.includes(forbidden), false, `SceneGuide must not contain ${forbidden}`);
}

const policySource = await readFile(new URL('../app/src/lib/scene-guide.js', import.meta.url), 'utf8');
for (const forbidden of ['window', 'document', 'location', 'history', 'navigator', 'URLSearchParams', 'setTimeout']) {
  assert.equal(policySource.includes(forbidden), false, `pure policy must not depend on ${forbidden}`);
}

const i18nSource = await readFile(new URL('../app/src/lib/i18n.svelte.js', import.meta.url), 'utf8');
for (const key of [
  'guide_title',
  'guide_desktop_orbit',
  'guide_desktop_zoom',
  'guide_desktop_house',
  'guide_desktop_exit',
  'guide_touch_orbit',
  'guide_touch_zoom',
  'guide_touch_house',
  'guide_touch_exit',
  'guide_dismiss',
]) {
  assert.equal((i18nSource.match(new RegExp(`${key}:`, 'g')) || []).length, 2, `${key} needs ko/en copy`);
}
assert.match(i18nSource, /hero_enter:\s*'Enter'/, 'English hero copy must be input-neutral');

const appSource = await readFile(new URL('../app/src/App.svelte', import.meta.url), 'utf8');
assert.match(appSource, /onpointerdowncapture=\{dismissSceneGuide\}/);
assert.match(appSource, /onwheelcapture=\{dismissSceneGuide\}/);
assert.match(
  appSource,
  /function dismissSceneGuide\(\)\s*\{[^}]*sceneGuideDismissed = true;[^}]*persistSceneGuideDismissal/s,
  'canvas input and close share one session-first dismissal path',
);
assert.doesNotMatch(
  appSource.match(/function dismissSceneGuide\(\)[\s\S]*?\n  \}/)?.[0] || '',
  /preventDefault|stopPropagation/,
  'guide dismissal must not consume stage input',
);
const appSurfaceIndex = appSource.indexOf('data-app-surface');
const guideIndex = appSource.indexOf('<SceneGuide ');
const referenceIndex = appSource.indexOf('<ReferenceModal');
const appSurfaceCloseIndex = appSource.lastIndexOf('</div>', referenceIndex);
assert.ok(
  guideIndex > appSurfaceIndex && guideIndex < appSurfaceCloseIndex,
  'SceneGuide must inherit the app-surface inert boundary',
);
assert.match(
  appSource,
  /try \{ sceneGuideStorage = window\.localStorage; \}\s*catch \{ sceneGuideStorage = null; \}/,
  'localStorage getter denial must fail open before helper calls',
);

const heroSource = await readFile(new URL('../app/src/components/Hero.svelte', import.meta.url), 'utf8');
assert.match(heroSource, /\.hero:focus-visible\s*\{[^}]*outline:\s*3px solid var\(--seal\)/s);
assert.doesNotMatch(heroSource, /\.hero:focus-visible\s*\{[^}]*outline:\s*none/s);

const engineSource = await readFile(new URL('../app/src/engine/engine.js', import.meta.url), 'utf8');
assert.equal(
  (engineSource.match(/emit\('viewSettled'/g) || []).length,
  1,
  'all stable endpoints must publish through one guarded semantic boundary',
);
assert.match(
  engineSource,
  /function emitSettledView\(\)[\s\S]{0,420}?retireSemanticViewSettlement\(\);[\s\S]{0,80}?emit\('viewSettled'/,
  'a semantic endpoint must retire stale manual OrbitControls settlement before publishing',
);
assert.match(
  engineSource,
  /function tweenTo\([\s\S]{0,420}?retireSemanticViewSettlement\(\);/,
  'programmatic camera ownership must retire a pending manual end before any warm/tween delay',
);
assert.equal(
  (engineSource.match(/onInterrupt: requestSemanticViewSettlement/g) || []).length,
  2,
  'interrupted standalone reveals must defer publication until the same input settles',
);
assert.match(
  engineSource,
  /controls\.addEventListener\('start', onControlsStart\);[\s\S]{0,100}?controls\.addEventListener\('end', onControlsEnd\)/,
  'manual gesture ownership must bracket semantic settlement',
);
assert.match(
  engineSource,
  /if \(!semanticViewSettlePending \|\| semanticViewGestureActive \|\| tween/,
  'a held pointer must block early quiet-frame publication',
);
const settledVillageSelections = [...engineSource.matchAll(
  /emit\('villageSelect',[\s\S]{0,180}?emitSettledView\(\);/g,
)];
assert.equal(settledVillageSelections.length, 5, 'every village focus/replay landing settles exactly once');
assert.match(
  engineSource,
  /function settleVillageExplore\(\)[\s\S]{0,300}?emit\('villageExplore'[\s\S]{0,120}?emitSettledView\(\)/,
  'aerial and wave endpoints share the same settled-view boundary',
);

console.log('scene guide policy: PASS');
