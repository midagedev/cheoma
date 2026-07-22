// Product-path gate for GitHub #22: title arrival and focused-house reroll use
// the same deterministic camera runtime, remain optically focused, and hand the
// exact live frame to OrbitControls on pointer/wheel/key interruption.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from '../app/node_modules/vite/dist/node/index.js';
import { launchVerificationBrowser, reportWebGLRenderer } from './lib/verification-browser.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const APP_ROOT = join(ROOT, 'app');
const cacheDir = await mkdtemp(join(tmpdir(), 'cheoma-cinematic-cache-'));
const outputDir = await mkdtemp(join(tmpdir(), 'cheoma-cinematic-shots-'));
const timeout = Number(process.env.CHEOMA_CINEMATIC_TIMEOUT_MS) || 90_000;
const failures = [];
const invariant = (condition, message) => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${message}`);
  if (!condition) failures.push(message);
};
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

const server = await createServer({
  root: APP_ROOT,
  configFile: join(APP_ROOT, 'vite.config.js'),
  cacheDir,
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false },
});

let browser;
const runtimeErrors = [];
function wireErrors(page, label) {
  page.on('pageerror', (error) => runtimeErrors.push(`${label} page: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' && !/favicon|404/i.test(message.text())) {
      runtimeErrors.push(`${label} console: ${message.text()}`);
    }
  });
}

async function waitForDirectVillage(page, base) {
  await page.goto(`${base}/?hero=0&village=1&worker=0&vseed=20260716&time=sunset&lang=ko`, {
    waitUntil: 'domcontentloaded', timeout,
  });
  await page.waitForFunction(() => window.__SHOT_READY && window.__engine?.village?.debugPlan?.(), null, { timeout });
  await page.evaluate(() => {
    const engine = window.__engine;
    if (engine.debugDof().tweenProgress != null) engine.debugDofSeek(1, { finish: true });
  });
}

async function focusRegularHouse(page) {
  const id = await page.evaluate(() => {
    const engine = window.__engine;
    const parcel = engine.village.debugParcels().find((item) => item.editable && !item.hero && !['palace', 'temple'].includes(item.parcelId));
    if (!parcel) throw new Error('cinematic fixture has no editable regular house');
    engine.village.focus(parcel.parcelId);
    return parcel.parcelId;
  });
  await page.waitForFunction(() => window.__engine.debugDof().tweenProgress != null, null, { timeout });
  await page.evaluate(() => window.__engine.debugDofSeek(1, { finish: true }));
  await page.waitForFunction(() => window.__engine.village.getState().transitioning === false, null, { timeout });
  return id;
}

async function rerollFocusedDeterministically(page) {
  return page.evaluate(() => {
    const originalRandom = Math.random;
    Math.random = () => 0.3141592653589793;
    try {
      window.__engine.village.rerollParcel();
      return window.__engine.debugArchitecturalReveal()?.kind === 'rebuild';
    }
    finally { Math.random = originalRandom; }
  });
}

async function sampleSequence(page, prefix, points) {
  const frames = [];
  for (const [index, progress] of points.entries()) {
    const state = await page.evaluate(({ progress, finish }) => {
      const engine = window.__engine;
      const reveal = engine.debugArchitecturalRevealSeek(progress, { finish });
      if (window.__asm?.active) window.__asm.seek(progress);
      const dof = engine.debugRenderDofFrame();
      return { ...reveal, dof, programs: engine.renderer.info.programs?.length || 0 };
    }, { progress, finish: progress >= 1 });
    frames.push(state);
    await page.screenshot({ path: join(outputDir, `${prefix}-${index}-${String(progress).replace('.', '_')}.png`) });
  }
  return frames;
}

async function captureFocusVisibilityPair(page, parcelId, prefix) {
  const visibility = await page.evaluate((id) => window.__engine.village.debugFocusVisibility(id), parcelId);
  const apply = async (framing, suffix) => {
    await page.evaluate(({ frame }) => {
      const engine = window.__engine;
      engine.camera.position.fromArray(frame.position);
      engine.__controls.target.fromArray(frame.target);
      engine.camera.fov = frame.fov;
      engine.camera.userData.villageReferenceFov = frame.referenceFov;
      engine.camera.updateProjectionMatrix();
      engine.camera.lookAt(engine.__controls.target);
      engine.debugRenderDofFrame();
    }, { frame: framing });
    await page.screenshot({ path: join(outputDir, `${prefix}-visibility-${suffix}.png`) });
  };
  await apply(visibility.baseFraming, 'before');
  await apply(visibility.safeFraming, 'after');
  return visibility;
}

try {
  await server.listen();
  const base = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await launchVerificationBrowser();

  // Initial title → village hero arrival: real Hero button and engine path.
  const arrivalPage = await browser.newPage({ viewport: { width: 1360, height: 850 }, deviceScaleFactor: 1 });
  wireErrors(arrivalPage, 'arrival');
  await arrivalPage.goto(`${base}/?worker=0&vseed=20260716&time=sunset&lang=ko`, {
    waitUntil: 'domcontentloaded', timeout,
  });
  await arrivalPage.waitForSelector('button.hero', { timeout });
  await arrivalPage.click('button.hero');
  await arrivalPage.waitForFunction(() => window.__engine?.debugArchitecturalReveal?.().kind === 'arrival', null, { timeout });
  await arrivalPage.evaluate(() => window.__engine.debugSetPaused(true));
  await reportWebGLRenderer(arrivalPage, 'cinematic-arrival');
  const arrival = await sampleSequence(arrivalPage, 'arrival', [0, 0.28, 0.56, 0.82, 1]);
  const arrivalStart = arrival[0], arrivalEnd = arrival.at(-1);
  invariant(arrivalStart.kind === 'arrival' && arrivalStart.motion === 'full', 'initial Hero action starts the desktop arrival profile');
  invariant(
    dist(arrivalStart.start.position, arrivalStart.start.target)
      > dist(arrivalStart.end.position, arrivalStart.end.target) * 1.5,
    'initial arrival travels from an establishing frame into the close architectural frame',
  );
  invariant(arrivalStart.start.fov > arrivalStart.end.fov && arrivalEnd.fov === arrivalEnd.end.fov,
    'initial arrival lands wide-to-telephoto on the authored lens');
  invariant(arrival.every((state) => state.lookErrorDeg < 1e-4), 'arrival calls lookAt on every sampled live frame');
  invariant(arrival.every((state) => state.dof.error == null || state.dof.error < 0.04), 'arrival keeps DoF on the moving architectural target');
  invariant(dist(arrivalEnd.position, arrivalEnd.end.position) < 1e-6 && dist(arrivalEnd.target, arrivalEnd.end.target) < 1e-6,
    'arrival finishes on the exact target and camera endpoint');
  invariant(Math.max(...arrival.map((state) => state.programs)) - Math.min(...arrival.map((state) => state.programs)) <= 8,
    'camera-only arrival does not grow shader programs while seeking');
  const heroVisibility = await arrivalPage.evaluate(() => {
    const engine = window.__engine;
    return engine.village.debugFocusVisibility(engine.village.getState().selected);
  });
  console.log(`HERO VISIBILITY: ${Math.round(heroVisibility.baseVisibleRatio * 100)}% -> ${Math.round(heroVisibility.visibleRatio * 100)}% (azimuth ${((heroVisibility.baseAzimuth || 0) * 180 / Math.PI).toFixed(1)}° -> ${((heroVisibility.azimuth || 0) * 180 / Math.PI).toFixed(1)}°, scale ${heroVisibility.scale})`);
  invariant(heroVisibility.visibleRatio >= heroVisibility.baseVisibleRatio,
    'hero safe endpoint never reduces sampled selected-compound visibility');
  invariant(heroVisibility.visibleRatio >= 1 / 9 - 1e-9,
    'hero final keeps the compound gate and central roof band visible');
  const selectedHeroCandidate = heroVisibility.candidates.find((candidate) => (
    Math.abs(candidate.azimuth - heroVisibility.azimuth) < 1e-9
      && Math.abs(candidate.scale - heroVisibility.scale) < 1e-9
  ));
  invariant(selectedHeroCandidate && !selectedHeroCandidate.cameraBlocked,
    'hero safe endpoint never places the camera inside a neighbouring house proxy');
  await arrivalPage.close();

  // Focused-house reroll: real public product command, deterministic seeks and PNGs.
  const rebuildPage = await browser.newPage({ viewport: { width: 1360, height: 850 }, deviceScaleFactor: 1 });
  wireErrors(rebuildPage, 'rebuild');
  await waitForDirectVillage(rebuildPage, base);
  const parcelId = await focusRegularHouse(rebuildPage);
  await rebuildPage.evaluate(() => window.__engine.debugSetPaused(true));
  invariant(await rerollFocusedDeterministically(rebuildPage), 'deterministic fixture executes the real focused-house reroll command');
  const rebuild = await sampleSequence(rebuildPage, 'rebuild', [0, 0.25, 0.5, 0.75, 1]);
  const rebuildStart = rebuild[0], rebuildMid = rebuild[2], rebuildEnd = rebuild.at(-1);
  invariant(rebuildStart.kind === 'rebuild' && rebuildStart.motion === 'full', 'focused-house action starts the desktop rebuild profile');
  invariant(dist(rebuildStart.position, rebuildStart.start.position) < 1e-6, 'reroll path begins on the exact previously presented camera frame');
  invariant(dist(rebuildMid.position, rebuildStart.position) > 0.4, 'reroll has a visible restrained camera arc instead of a stationary assembly');
  invariant(rebuild.every((state) => state.lookErrorDeg < 1e-4), 'reroll calls lookAt on every sampled live frame');
  invariant(rebuild.every((state) => state.dof.error == null || state.dof.error < 0.04), 'reroll updates DoF focus with its moving target');
  invariant(dist(rebuildEnd.position, rebuildEnd.end.position) < 1e-6 && dist(rebuildEnd.target, rebuildEnd.end.target) < 1e-6,
    'reroll finishes on the rebuilt parcel framing without a handoff snap');
  invariant(rebuildEnd.controlsEnabled && rebuildEnd.reason === 'complete', 'natural completion returns enabled OrbitControls');
  invariant(rebuildEnd.programs - rebuildStart.programs <= 8, 'camera arc itself adds no persistent shader-program family');
  const rebuildVisibility = await captureFocusVisibilityPair(rebuildPage, parcelId, 'rebuild');
  console.log(`FOCUS VISIBILITY ${parcelId}: ${Math.round(rebuildVisibility.baseVisibleRatio * 100)}% -> ${Math.round(rebuildVisibility.visibleRatio * 100)}% (azimuth ${((rebuildVisibility.baseAzimuth || 0) * 180 / Math.PI).toFixed(1)}° -> ${((rebuildVisibility.azimuth || 0) * 180 / Math.PI).toFixed(1)}°, base blockers ${rebuildVisibility.baseBlockers.join(',') || 'none'})`);
  console.log(`FOCUS CANDIDATES ${parcelId}: ${JSON.stringify(rebuildVisibility.candidates)}`);
  console.log(`FOCUS GEOMETRY ${parcelId}: ${JSON.stringify({ subjectBounds: rebuildVisibility.subjectBounds, blockerBounds: rebuildVisibility.blockerBounds, baseFraming: rebuildVisibility.baseFraming })}`);
  invariant(rebuildVisibility.visibleRatio >= rebuildVisibility.baseVisibleRatio,
    'safe reroll endpoint never reduces sampled selected-house visibility');
  invariant(rebuildVisibility.visibleRatio >= 1 / 3 - 1e-9,
    'safe reroll endpoint keeps the selected roof/eave band visible');
  if (rebuildVisibility.baseOcclusionRatio > 1 / 9) {
    invariant(rebuildVisibility.visibleRatio >= rebuildVisibility.baseVisibleRatio + 1 / 9 - 1e-9,
      'occluded authored endpoint improves by at least one deterministic bounding sample');
  }
  const selectedVisibilityCandidate = rebuildVisibility.candidates.find((candidate) => (
    Math.abs(candidate.azimuth - rebuildVisibility.azimuth) < 1e-9
      && Math.abs(candidate.scale - rebuildVisibility.scale) < 1e-9
  ));
  invariant(selectedVisibilityCandidate && !selectedVisibilityCandidate.cameraBlocked,
    'safe endpoint never places the camera inside a neighbouring house proxy');
  invariant(Math.abs(rebuildVisibility.safeFraming.position[1] - rebuildVisibility.baseFraming.position[1]) < 1e-9,
    'safe endpoint preserves the authored yard eye height');
  invariant(Math.abs(rebuildVisibility.azimuth) <= 14 * Math.PI / 180 + 1e-9,
    'safe endpoint remains inside the south-facing solar-opening angle');
  invariant(rebuildVisibility.safeFraming.fov <= 26,
    'safe endpoint remains on the residential telephoto lens');
  invariant(
    dist(rebuildEnd.end.position, {
      x: rebuildVisibility.safeFraming.position[0],
      y: rebuildVisibility.safeFraming.position[1],
      z: rebuildVisibility.safeFraming.position[2],
    }) < 1e-6,
    'ordinary click focus and cinematic final share the same authoritative safe framing',
  );
  await rebuildPage.evaluate(() => window.__engine.debugSetPaused(false));
  await rebuildPage.waitForFunction(() => window.__engine.village.getState().transitioning === false, null, { timeout });

  // Pointer and key preserve the exact live frame. Wheel restores the focus zoom
  // regime in capture phase, so the same gesture that cancels the reveal also
  // reaches OrbitControls and changes distance instead of being discarded.
  const canvasBox = await rebuildPage.locator('canvas').boundingBox();
  if (!canvasBox) throw new Error('cinematic canvas has no bounding box');
  const canvasPoint = {
    x: canvasBox.x + canvasBox.width * 0.72,
    y: canvasBox.y + canvasBox.height * 0.52,
  };
  for (const eventType of ['pointer', 'wheel', 'key']) {
    await rebuildPage.evaluate(() => window.__engine.debugSetPaused(true));
    await rerollFocusedDeterministically(rebuildPage);
    const before = await rebuildPage.evaluate(() => {
      const engine = window.__engine;
      engine.debugArchitecturalRevealSeek(0.37);
      return engine.debugArchitecturalReveal();
    });
    if (eventType === 'pointer') {
      await rebuildPage.mouse.move(canvasPoint.x, canvasPoint.y);
      await rebuildPage.mouse.down();
    } else if (eventType === 'wheel') {
      await rebuildPage.mouse.move(canvasPoint.x, canvasPoint.y);
      await rebuildPage.mouse.wheel(0, 240);
    } else {
      await rebuildPage.keyboard.press('x');
    }
    const after = await rebuildPage.evaluate(() => window.__engine.debugArchitecturalReveal());
    if (eventType === 'pointer') await rebuildPage.mouse.up();
    invariant(!after.active && after.reason === 'input' && after.controlsEnabled,
      `${eventType} input immediately interrupts and enables OrbitControls (${JSON.stringify({ active: after.active, reason: after.reason, enabled: after.controlsEnabled })})`);
    if (eventType === 'wheel') {
      const beforeDistance = dist(before.position, before.target);
      const afterDistance = dist(after.position, after.target);
      invariant(after.controlsZoomEnabled,
        'wheel interruption synchronously restores the focused OrbitControls zoom regime');
      invariant(Math.abs(afterDistance - beforeDistance) > 0.05,
        `the interrupting wheel gesture performs a real dolly (${beforeDistance.toFixed(3)} -> ${afterDistance.toFixed(3)})`);
      invariant(dist(before.target, after.target) < 1e-8,
        'wheel handoff preserves the live architectural target while dollying');
    } else {
      invariant(dist(before.position, after.position) < 1e-8 && dist(before.target, after.target) < 1e-8,
        `${eventType} handoff preserves the exact camera and target frame`);
    }
    invariant(after.lookErrorDeg < 1e-4, `${eventType} handoff preserves the lookAt direction`);
    await rebuildPage.evaluate(() => window.__engine.debugSetPaused(false));
    await rebuildPage.waitForFunction(() => window.__engine.village.getState().transitioning === false, null, { timeout });
  }
  invariant(await rebuildPage.evaluate((id) => window.__engine.village.getState().selected === id, parcelId),
    'camera interruption does not lose focused parcel ownership');
  await rebuildPage.close();

  // Reduced motion is a real immediate endpoint, including the explicit duration override.
  const reducedPage = await browser.newPage({ viewport: { width: 1024, height: 720 }, reducedMotion: 'reduce' });
  wireErrors(reducedPage, 'reduced');
  await waitForDirectVillage(reducedPage, base);
  await focusRegularHouse(reducedPage);
  await rerollFocusedDeterministically(reducedPage);
  const reduced = await reducedPage.evaluate(() => {
    const engine = window.__engine;
    engine.debugRenderDofFrame();
    return engine.debugArchitecturalReveal();
  });
  invariant(!reduced.active && reduced.motion === 'reduced' && reduced.duration === 0 && reduced.reason === 'complete',
    'prefers-reduced-motion resolves the reroll directly to its endpoint');
  invariant(dist(reduced.position, reduced.end.position) < 1e-6 && dist(reduced.target, reduced.end.target) < 1e-6,
    'reduced-motion endpoint is exact');
  invariant(reduced.lookErrorDeg < 1e-4 && (reduced.dof.error == null || reduced.dof.error < 0.04),
    'reduced-motion endpoint keeps lookAt and DoF coherent');
  await reducedPage.close();

  // Phone/perf profile keeps choreography but selects the compact path.
  const mobilePage = await browser.newPage({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 1,
    isMobile: true, hasTouch: true,
  });
  wireErrors(mobilePage, 'mobile');
  await waitForDirectVillage(mobilePage, base);
  await focusRegularHouse(mobilePage);
  await rerollFocusedDeterministically(mobilePage);
  const mobile = await mobilePage.evaluate(() => {
    const engine = window.__engine;
    engine.debugSetPaused(true);
    const state = engine.debugArchitecturalRevealSeek(0.5);
    if (window.__asm?.active) window.__asm.seek(0.5);
    engine.debugRenderDofFrame();
    return state;
  });
  invariant(mobile.active && mobile.motion === 'compact', 'phone/perf path selects compact camera motion');
  invariant(mobile.lookErrorDeg < 1e-4
      && (!mobile.dof.enabled || mobile.dof.error == null || mobile.dof.error < 0.04),
  'compact phone frame keeps lookAt coherent and respects the mobile DoF-off policy');
  await mobilePage.screenshot({ path: join(outputDir, 'rebuild-mobile-mid.png') });
  await mobilePage.close();
} finally {
  await browser?.close().catch(() => {});
  await server.close().catch(() => {});
  await rm(cacheDir, { recursive: true, force: true });
}

console.log(`CINEMATIC SHOTS: ${outputDir}`);
if (runtimeErrors.length) {
  for (const error of runtimeErrors) console.error(`ERROR ${error}`);
  failures.push(`${runtimeErrors.length} browser runtime error(s)`);
}
if (failures.length) {
  console.error(`CINEMATIC REVEAL APP: FAIL (${failures.length})`);
  process.exitCode = 1;
} else {
  console.log('CINEMATIC REVEAL APP: PASS');
}
