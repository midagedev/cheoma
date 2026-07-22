// Visual contract for #76: the same distant house/camera first uses the legacy
// origin-fixed shadow frustum, then the focus-following texel-stable frustum.
// Captures stay in an OS temp directory for direct human inspection.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PNG } from 'pngjs';
import { createServer } from '../app/node_modules/vite/dist/node/index.js';
import { launchVerificationBrowser, reportWebGLRenderer } from './lib/verification-browser.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const APP_ROOT = join(ROOT, 'app');
const cacheDir = await mkdtemp(join(tmpdir(), 'cheoma-focus-shadow-cache-'));
const outDir = await mkdtemp(join(tmpdir(), 'cheoma-focus-shadow-shots-'));
const timeout = Number(process.env.CHEOMA_FOCUS_SHADOW_TIMEOUT_MS) || 180_000;
const failures = [];
const errors = [];

function pass(condition, message, detail = '') {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${message}${detail ? ` (${detail})` : ''}`);
  if (!condition) failures.push(message);
}

function pixelDifference(firstBuffer, secondBuffer) {
  const first = PNG.sync.read(firstBuffer);
  const second = PNG.sync.read(secondBuffer);
  if (first.width !== second.width || first.height !== second.height) {
    throw new Error('focus-shadow captures have different dimensions');
  }
  let sum = 0;
  let changed = 0;
  const pixels = first.width * first.height;
  for (let index = 0; index < first.data.length; index += 4) {
    const delta = Math.max(
      Math.abs(first.data[index] - second.data[index]),
      Math.abs(first.data[index + 1] - second.data[index + 1]),
      Math.abs(first.data[index + 2] - second.data[index + 2]),
    );
    sum += delta;
    if (delta >= 4) changed++;
  }
  return { mean: sum / pixels, changedRatio: changed / pixels };
}

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
  browser = await launchVerificationBrowser();
  const page = await browser.newPage({ viewport: { width: 1200, height: 760 } });
  page.setDefaultTimeout(timeout);
  await page.addInitScript(() => { window.__noWarm = true; });
  page.on('pageerror', (error) => errors.push(`page: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' && !/favicon|404/i.test(message.text())) {
      errors.push(`console: ${message.text()}`);
    }
  });

  const url = `http://127.0.0.1:${port}/?shot=1&hero=0&village=1&worker=0`
    + '&vscale=town&seed=42&vseed=20260716&time=sunset&sunset=gold&season=autumn&weather=clear';
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
  await page.waitForFunction(() => window.__SHOT_READY === true
    && window.__engine?.village?.debugPlan?.()?.scale === 'town', null, { timeout });
  await page.waitForFunction(() => !window.__engine.village.getState().transitioning, null, { timeout });
  await reportWebGLRenderer(page, 'focus-shadow');

  const candidate = await page.evaluate(() => window.__engine.village.debugParcels()
    .filter((parcel) => !parcel.hero && parcel.editable && Array.isArray(parcel.worldCenter))
    .sort((a, b) => Math.hypot(b.worldCenter[0], b.worldCenter[2])
      - Math.hypot(a.worldCenter[0], a.worldCenter[2]))[0] || null);
  if (!candidate) throw new Error('focus-shadow fixture has no regular parcel');

  await page.evaluate((parcelId) => window.__engine.village.debugFocus(parcelId), candidate.parcelId);
  await page.waitForFunction(() => window.__engine.village.getState().transitioning, null, { timeout: 10_000 });
  await page.evaluate(() => window.__engine.debugDofSeek(1, { finish: true }));
  await page.waitForFunction(() => {
    const state = window.__engine.village.getState();
    return !!state.selected && !state.transitioning;
  }, null, { timeout: 10_000 });

  const setup = await page.evaluate(() => {
    const engine = window.__engine;
    engine.setTime('sunset', { immediate: true });
    engine.setSeason('autumn', { immediate: true });
    engine.setWeather('clear', { immediate: true });
    engine.debugTuneDof({ amount: 0 });
    engine.debugAdvanceFocusRing(3.2);
    engine.debugAdvancePost(2);
    engine.debugSetPaused(true);
    let sun = null;
    engine.scene.traverse((object) => { if (!sun && object.isDirectionalLight) sun = object; });
    return {
      selected: engine.village.getState().selected,
      target: engine.__controls.target.toArray(),
      sunPosition: sun?.position.toArray() || null,
      sunTarget: sun?.target?.position.toArray() || null,
    };
  });

  async function capture(name, anchor) {
    const state = await page.evaluate((nextAnchor) => {
      const engine = window.__engine;
      engine.debugSetDirectionalShadowAnchor(nextAnchor);
      engine.debugRenderDofFrame();
      engine.debugRenderDofFrame();
      let sun = null;
      engine.scene.traverse((object) => { if (!sun && object.isDirectionalLight) sun = object; });
      const targetNdc = engine.__controls.target.clone().project(sun.shadow.camera);
      return {
        shadow: engine.debugDirectionalShadow(),
        targetNdc: targetNdc.toArray(),
        sunPosition: sun.position.toArray(),
        sunTarget: sun.target.position.toArray(),
      };
    }, anchor);
    const path = join(outDir, `${name}.png`);
    const buffer = await page.locator('canvas').screenshot({ path });
    return { path, buffer, state };
  }

  const legacy = await capture('legacy-origin-shadow', [0, 0, 0]);
  const focused = await capture('focused-physical-shadow', setup.target);
  await page.evaluate(() => window.__engine.debugSetDirectionalShadowAnchor(null));

  const difference = pixelDifference(legacy.buffer, focused.buffer);
  const legacyOutside = Math.abs(legacy.state.targetNdc[0]) > 1
    || Math.abs(legacy.state.targetNdc[1]) > 1
    || legacy.state.targetNdc[2] < -1 || legacy.state.targetNdc[2] > 1;
  const focusedError = Math.hypot(focused.state.targetNdc[0], focused.state.targetNdc[1]);
  const sunUnchanged = JSON.stringify(setup.sunPosition) === JSON.stringify(focused.state.sunPosition)
    && JSON.stringify(setup.sunTarget) === JSON.stringify(focused.state.sunTarget)
    && JSON.stringify(legacy.state.sunPosition) === JSON.stringify(focused.state.sunPosition)
    && JSON.stringify(legacy.state.sunTarget) === JSON.stringify(focused.state.sunTarget);

  pass(Math.hypot(candidate.worldCenter[0], candidate.worldCenter[2]) > 22,
    'visual fixture is outside the legacy 22 m half-span',
    `${candidate.parcelId} @ ${candidate.worldCenter.map((value) => value.toFixed(1)).join(', ')}`);
  pass(legacyOutside, 'legacy origin-fixed shadow frustum misses the focused house',
    `ndc=${legacy.state.targetNdc.map((value) => value.toFixed(3)).join(', ')}`);
  pass(focusedError <= 2 / focused.state.shadow.mapSize[0]
      && focused.state.targetNdc[2] >= -1 && focused.state.targetNdc[2] <= 1,
  'focus-following frustum centres the same house within two shadow texels',
  `ndc=${focused.state.targetNdc.map((value) => value.toFixed(5)).join(', ')}`);
  pass(sunUnchanged, 'shadow framing never translates the authored product sun');
  pass(difference.changedRatio > 0.0005 && difference.mean > 0.01,
    'same-camera captures contain a visible physical-shadow delta',
    `changed=${(difference.changedRatio * 100).toFixed(3)}%, mean=${difference.mean.toFixed(4)}`);
  pass(errors.length === 0, 'browser console remains clean', errors[0] || '');

  console.log(`VISUAL  ${legacy.path}`);
  console.log(`VISUAL  ${focused.path}`);
  if (failures.length || errors.length) {
    throw new Error(`FOCUS SHADOW: FAIL (${[...failures, ...errors].join('; ')})`);
  }
  console.log(`FOCUS SHADOW: PASS (${outDir})`);
} finally {
  await browser?.close();
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
}
