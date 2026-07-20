// Full-app browser smoke: app bootstrap → village → focus wiring.
// Uses an isolated Vite cache and ephemeral port, leaving any user dev server untouched.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from '../app/node_modules/vite/dist/node/index.js';

const ROOT = resolve(import.meta.dirname, '..');
const APP_ROOT = join(ROOT, 'app');
const cacheDir = await mkdtemp(join(tmpdir(), 'cheoma-app-smoke-'));
const timeout = Number(process.env.CHEOMA_APP_SMOKE_TIMEOUT_MS) || 90_000;
const failures = [];
const pass = (condition, message) => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${message}`);
  if (!condition) failures.push(message);
};

const server = await createServer({
  root: APP_ROOT,
  configFile: join(APP_ROOT, 'vite.config.js'),
  cacheDir,
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false },
});

let browser;
let runtimeErrors = [];
try {
  await server.listen();
  const port = server.httpServer.address().port;
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  runtimeErrors = [];
  page.on('pageerror', (error) => runtimeErrors.push(`page: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' && !/favicon|404/i.test(message.text())) {
      runtimeErrors.push(`console: ${message.text()}`);
    }
  });

  const url = `http://127.0.0.1:${port}/?hero=0&village=1&worker=0&seed=42&vseed=20260716&time=day`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
  await page.waitForFunction(() => window.__SHOT_READY === true && !!window.__engine, null, { timeout });
  await page.waitForFunction(() => !!window.__engine.village.debugPlan(), null, { timeout });

  const boot = await page.evaluate(() => {
    const engine = window.__engine;
    return {
      state: engine.getState(),
      village: engine.village.getState(),
      plan: engine.village.debugPlan(),
      continuum: engine.village.debugContinuum(),
      camera: engine.village.debugCamera(),
      sceneChildren: engine.scene.children.length,
      canvas: {
        width: engine.renderer.domElement.width,
        height: engine.renderer.domElement.height,
      },
    };
  });
  pass(boot.village.active, 'village mode becomes active');
  pass(boot.plan.seed === 20260716 && boot.plan.scale === 'village', 'URL seed and scale reach the planner');
  pass(boot.plan.houses > 0 && boot.sceneChildren > 0, 'village scene contains planned houses and scene objects');
  pass(boot.canvas.width > 0 && boot.canvas.height > 0, 'renderer owns a sized canvas');
  pass(
    boot.continuum.aerialDist > 0
      && boot.continuum.enterDist < boot.continuum.exitDist
      && Number.isFinite(boot.camera.near),
    'village camera exposes valid aerial, zoom, and near-plane contracts',
  );

  const cinematic = await page.evaluate(() => {
    const { cine } = window.__engine;
    const available = cine.available();
    const droneStarted = cine.start('drone', { pass: 'crane-in' });
    const drone = cine.getState();
    cine.stop();
    const droneStopped = cine.getState();
    const walkStarted = cine.start('walk');
    const walker = cine.debugWalker();
    cine.stop();
    return { available, droneStarted, drone, droneStopped, walkStarted, walker };
  });
  pass(
    cinematic.available && cinematic.droneStarted
      && cinematic.drone.active && cinematic.drone.pass === 'crane-in',
    'cinematic runtime starts a named drone path',
  );
  pass(!cinematic.droneStopped.active, 'cinematic runtime returns control after stop');
  pass(
    cinematic.walkStarted && cinematic.walker
      && Number.isFinite(cinematic.walker.clearance),
    'walk runtime initializes with finite terrain clearance',
  );

  const heroId = await page.evaluate(() => window.__engine.village.heroId());
  pass(typeof heroId === 'string' && heroId.length > 0, 'hero parcel is addressable through the app API');
  const focused = await page.evaluate(() => {
    const engine = window.__engine;
    engine.setTime('night');
    engine.setSeason('autumn');
    engine.setWeather('clear');
    const parcelId = engine.village.heroId();
    engine.village.focus(parcelId);
    const state = engine.village.getState();
    return { selected: state.selected, spec: state.spec, overlay: engine.village.debugOverlayBox(state.selected) };
  });
  // Headless ANGLE may produce fewer than one frame per second while linking shaders, so this
  // fast smoke asserts synchronous focus setup rather than wall-clock tween completion.
  pass(focused.selected === heroId && !!focused.spec, 'focus setup targets the requested parcel');
  pass(!!focused.overlay, 'focused parcel exposes a measurable detail overlay');
  pass(runtimeErrors.length === 0, `browser reports no runtime errors (${runtimeErrors.length})`);
  if (runtimeErrors.length) console.log(runtimeErrors.slice(0, 5).join('\n'));

  await page.close();
} catch (error) {
  failures.push(error.message);
  console.error(error.stack || error);
  if (runtimeErrors.length) console.error(runtimeErrors.slice(0, 10).join('\n'));
} finally {
  await browser?.close();
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
}

console.log(failures.length ? `\nAPP SMOKE: ${failures.length} FAIL` : '\nAPP SMOKE: PASS');
process.exit(failures.length ? 1 : 0);
