// Same-camera primary-opening DoF review.
//
// The product camera, projection, lighting, scene, Bokeh kernel, and aperture stay
// byte-identical between captures. Only the debug focus point changes from the
// composition target to the cached immutable primary-opening centre.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PNG } from 'pngjs';
import { createServer } from '../app/node_modules/vite/dist/node/index.js';
import { launchVerificationBrowser, reportWebGLRenderer } from './lib/verification-browser.mjs';
import { countChangedPixels } from './lib/png-metrics.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const APP_ROOT = join(ROOT, 'app');
const cacheDir = await mkdtemp(join(tmpdir(), 'cheoma-door-dof-cache-'));
const outputDir = await mkdtemp(join(tmpdir(), 'cheoma-door-dof-shots-'));
const timeout = Number(process.env.CHEOMA_DOOR_DOF_TIMEOUT_MS) || 180_000;
const errors = [];

function edgeEnergy(buffer) {
  const image = PNG.sync.read(buffer);
  const { data, width, height } = image;
  const luma = (offset) => (
    data[offset] * 0.2126 + data[offset + 1] * 0.7152 + data[offset + 2] * 0.0722
  );
  let energy = 0;
  let samples = 0;
  for (let y = 1; y < height; y++) {
    for (let x = 1; x < width; x++) {
      const offset = (y * width + x) * 4;
      energy += Math.abs(luma(offset) - luma(offset - 4));
      energy += Math.abs(luma(offset) - luma(offset - width * 4));
      samples += 2;
    }
  }
  return samples ? energy / samples : 0;
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
  const page = await browser.newPage({
    viewport: { width: 1600, height: 900 },
    deviceScaleFactor: 2,
  });
  page.setDefaultTimeout(timeout);
  await page.addInitScript(() => { window.__noWarm = true; });
  page.on('pageerror', (error) => errors.push(`page: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' && !/favicon|404/i.test(message.text())) {
      errors.push(`console: ${message.text()}`);
    }
  });

  const url = `http://127.0.0.1:${port}/?hero=0&village=1&worker=0&shot=1`
    + '&seed=42&vseed=20260716&time=sunset&season=autumn&weather=clear';
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
  await page.waitForFunction(() => window.__SHOT_READY === true && !!window.__engine, null, { timeout });
  await page.waitForFunction(
    () => window.__engine?.village?.debugPlan?.()?.seed === 20260716,
    null,
    { timeout },
  );
  await reportWebGLRenderer(page, 'door-dof-shot');

  const prepared = await page.evaluate(async () => {
    const engine = window.__engine;
    if (!engine.village.debugParcels().some((parcel) => parcel.parcelId === 'p27')) {
      throw new Error('missing deterministic p27 door DoF fixture');
    }
    engine.setViewShiftEnabled(false);
    engine.village.focus('p27');
    for (let index = 0; index < 4; index++) await Promise.resolve();
    if (!engine.debugDofSeek(1, { finish: true })) throw new Error('p27 focus tween did not start');
    engine.setSeason('autumn', { immediate: true });
    engine.setTime('sunset', { immediate: true });
    engine.setWeather('clear');
    engine.debugAdvanceFocusRing(3.2);
    engine.debugAdvancePost(2);
    engine.debugTuneDof({ amount: 1, aperture: 0.00015 });
    engine.debugSetPaused(true);
    engine.debugRenderDofFrame();
    const screen = engine.village.debugDoorScreen('p27');
    if (!screen) throw new Error('p27 primary opening is not screen-visible');
    return screen;
  });

  const radius = 120;
  const clip = {
    x: Math.max(0, prepared.x - radius),
    y: Math.max(0, prepared.y - radius),
    width: Math.min(radius * 2, 1600 - Math.max(0, prepared.x - radius)),
    height: Math.min(radius * 2, 900 - Math.max(0, prepared.y - radius)),
  };

  async function capture(name, useCompositionTarget) {
    const state = await page.evaluate((legacy) => {
      const engine = window.__engine;
      engine.debugSetDofAnchor(legacy ? engine.__controls.target.toArray() : null);
      engine.debugRenderDofFrame();
      return {
        dof: engine.debugDof(),
        camera: {
          position: engine.camera.position.toArray(),
          quaternion: engine.camera.quaternion.toArray(),
          fov: engine.camera.fov,
          projection: engine.camera.projectionMatrix.toArray(),
        },
      };
    }, useCompositionTarget);
    const full = await page.locator('canvas').screenshot();
    const crop = await page.screenshot({ clip });
    await writeFile(join(outputDir, `${name}.png`), full);
    await writeFile(join(outputDir, `${name}-door.png`), crop);
    return { state, full, crop };
  }

  const composition = await capture('composition-target', true);
  const opening = await capture('primary-opening', false);
  const cameraStable = JSON.stringify(composition.state.camera) === JSON.stringify(opening.state.camera);
  const changed = countChangedPixels(composition.crop, opening.crop, 3);
  const cropImage = PNG.sync.read(composition.crop);
  const cropPixels = cropImage.width * cropImage.height;
  const compositionEnergy = edgeEnergy(composition.crop);
  const openingEnergy = edgeEnergy(opening.crop);
  const report = {
    fixture: 'p27',
    viewport: '1600x900@2x',
    cameraStable,
    compositionDepth: composition.state.dof.anchorDepth,
    openingDepth: opening.state.dof.anchorDepth,
    depthDelta: composition.state.dof.anchorDepth - opening.state.dof.anchorDepth,
    semanticSource: opening.state.dof.anchorSource,
    semanticParcel: opening.state.dof.semanticParcel,
    changedPixels: changed,
    changedPercent: cropPixels ? changed / cropPixels * 100 : 0,
    compositionEdgeEnergy: compositionEnergy,
    openingEdgeEnergy: openingEnergy,
    edgeGainPercent: compositionEnergy
      ? (openingEnergy / compositionEnergy - 1) * 100
      : 0,
    outputDir,
  };
  console.log(`DOOR DOF A/B: ${JSON.stringify(report, null, 2)}`);
  for (const error of errors) console.error(error);

  if (!cameraStable
    || opening.state.dof.anchorSource !== 'primary-opening'
    || opening.state.dof.semanticParcel !== 'p27'
    || !(Math.abs(report.depthDelta) > 0.25)
    || !(changed > 0)
    || errors.length) {
    process.exitCode = 1;
  }
} finally {
  await browser?.close();
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
}
