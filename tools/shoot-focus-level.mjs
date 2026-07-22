// #15 focus eye-level composition gate.
//
// Runs the real app from an isolated Vite server, finishes the product's actual
// camera tween deterministically, and captures representative house/landmark views.
// This avoids both a persistent dist directory and several seconds of wall-clock
// animation per subject while retaining the same tween applicator used at runtime.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from '../app/node_modules/vite/dist/node/index.js';
import { launchVerificationBrowser, reportWebGLRenderer } from './lib/verification-browser.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const APP_ROOT = join(ROOT, 'app');
const cacheDir = await mkdtemp(join(tmpdir(), 'cheoma-focus-level-cache-'));
const outputDir = await mkdtemp(join(tmpdir(), 'cheoma-focus-level-shots-'));
const timeout = Number(process.env.CHEOMA_FOCUS_LEVEL_TIMEOUT_MS) || 90_000;
const results = [];
const runtimeErrors = [];
const check = (pass, message) => {
  results.push({ pass, message });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${message}`);
};

const server = await createServer({
  root: APP_ROOT,
  configFile: join(APP_ROOT, 'vite.config.js'),
  cacheDir,
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false },
});

let browser;
try {
  await server.listen();
  const port = server.httpServer.address().port;
  const base = `http://127.0.0.1:${port}`;
  browser = await launchVerificationBrowser();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  page.setDefaultTimeout(timeout);
  await page.addInitScript(() => { window.__noWarm = true; });
  page.on('pageerror', (error) => runtimeErrors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' && !/favicon|404|Failed to load resource/i.test(message.text())) {
      runtimeErrors.push(`console: ${message.text()}`);
    }
  });

  async function loadVillage(query) {
    await page.goto(`${base}/?hero=0&village=1&worker=0&shot=1&${query}`, {
      waitUntil: 'domcontentloaded', timeout,
    });
    await page.waitForFunction(
      () => window.__SHOT_READY === true
        && window.__engine?.village?.getState()?.active
        && !window.__engine.village.debugCamera().transitioning,
      null,
      { timeout },
    );
  }

  // Start an actual product transition, drain the no-warm reveal microtasks, then
  // finish that same tween through its shared deterministic applicator.
  async function finishTransition(action, parcelId = null) {
    return page.evaluate(async ({ actionName, id }) => {
      const engine = window.__engine;
      if (actionName === 'focus') engine.village.debugFocus(id);
      else engine.village.return();
      for (let index = 0; index < 6; index++) await Promise.resolve();
      const sample = engine.debugDofSeek(1, { finish: true });
      if (!sample) throw new Error(`${actionName} camera tween did not start`);
      return engine.village.debugCamera();
    }, { actionName: action, id: parcelId });
  }

  let selected = null;
  const expectedLift = { choga: 3.12, giwa: 4.32, hero: 5.6, palace: 3.2, temple: 3 };
  async function focusAndCapture(name, parcel) {
    if (selected) {
      await finishTransition('return');
      selected = null;
    }
    const framing = await finishTransition('focus', parcel.parcelId);
    selected = parcel.parcelId;
    check(!framing.transitioning && framing.selected === parcel.parcelId,
      `${name} focus transition settles on ${parcel.parcelId}`);

    const current = (await page.evaluate(() => window.__engine.village.debugParcels()))
      .find((candidate) => candidate.parcelId === parcel.parcelId);
    const wanted = expectedLift[name];
    check(Number.isFinite(current?.focusTargetLift)
      && Math.abs(current.focusTargetLift - wanted) < 0.011,
    `${name} aims at its authored lintel/eave height (${current?.focusTargetLift}m above base)`);
    check(Math.abs(framing.targetY - current.focusTargetY) < 0.11,
      `${name} runtime target matches planned framing (${framing.targetY}/${current.focusTargetY})`);
    if (name === 'giwa' || name === 'choga' || name === 'hero') {
      const eyeHeight = current.focusCameraY - current.focusBaseY;
      check(Math.abs(eyeHeight - 1.35) < 0.011,
        `${name} keeps the camera at yard eye height (${eyeHeight.toFixed(2)}m)`);
    }

    // Allow the settled frame, LOD ownership handoff, and Svelte panel CSS morph to
    // finish before capture. Camera motion itself was already sought deterministically.
    await page.evaluate(() => new Promise((resolveFrame) => requestAnimationFrame(() => resolveFrame())));
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(outputDir, `${name}.png`) });
  }

  await loadVillage('vscale=capital&vpalace=1&vtemple=1&seed=20260718&vseed=7&time=day&weather=clear');
  await reportWebGLRenderer(page, 'focus-level');
  const parcels = await page.evaluate(() => window.__engine.village.debugParcels());
  const picks = [
    ['giwa', parcels.find((parcel) => parcel.family === 'regular' && parcel.kind === 'giwa')],
    ['choga', parcels.find((parcel) => parcel.family === 'regular' && parcel.kind !== 'giwa')],
    ['palace', parcels.find((parcel) => parcel.parcelId === 'palace')],
    ['temple', parcels.find((parcel) => parcel.parcelId === 'temple')],
  ].filter(([, parcel]) => parcel);
  check(picks.length === 4,
    `capital focus subjects are available (${picks.map(([name]) => name).join(', ')})`);
  for (const [name, parcel] of picks) {
    await focusAndCapture(name, parcel);
    if (name !== 'temple') continue;
    const edit = await page.evaluate(() => {
      const engine = window.__engine;
      const initial = engine.village.getState().spec;
      const compactOptions = { ...initial.variantDefaults.compact, variant: 'compact' };
      engine.village.rebuild('temple', { templeOptions: compactOptions });
      const compact = {
        spec: engine.village.getState().spec,
        box: engine.village.debugOverlayBox('temple'),
      };
      const extendedOptions = { ...compact.spec.variantDefaults.extended, variant: 'extended' };
      engine.village.rebuild('temple', { templeOptions: extendedOptions });
      const extended = {
        spec: engine.village.getState().spec,
        box: engine.village.debugOverlayBox('temple'),
      };
      return { initial, compact, extended };
    });
    check(edit.compact.spec.params.variant === 'compact'
      && edit.compact.spec.params.hallCount === edit.compact.spec.variantDefaults.compact.hallCount,
    `temple editor keeps compact UI and plan values synchronized (${edit.compact.spec.params.hallCount} halls)`);
    check(edit.extended.spec.params.variant === 'extended'
      && edit.extended.spec.params.hallCount === edit.extended.spec.variantDefaults.extended.hallCount,
    `temple editor restores extended semantic defaults (${edit.extended.spec.params.hallCount} halls)`);
    check(edit.extended.box.x > edit.compact.box.x + 20 && edit.extended.box.z > edit.compact.box.z + 20,
      `temple editor rebuilds the reserved compound geometry (${JSON.stringify({ compact: edit.compact.box, extended: edit.extended.box })})`);
  }

  // Capital deliberately replaces the residential hero with the palace core.
  await loadVillage('vscale=village&vtemple=0&seed=20260718&vseed=7&time=day&weather=clear');
  selected = null;
  const hero = (await page.evaluate(() => window.__engine.village.debugParcels()))
    .find((parcel) => parcel.hero);
  check(!!hero, 'village head house is available');
  if (hero) await focusAndCapture('hero', hero);

  check(runtimeErrors.length === 0, `browser reports no runtime errors (${runtimeErrors.length})`);
} finally {
  await browser?.close();
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
}

for (const error of runtimeErrors) console.error(error);
const failures = results.filter((result) => !result.pass);
console.log(`FOCUS LEVEL: ${failures.length ? 'FAIL' : 'PASS'} (${results.length - failures.length}/${results.length})`);
console.log(`screenshots: ${outputDir}`);
process.exitCode = failures.length ? 1 : 0;
