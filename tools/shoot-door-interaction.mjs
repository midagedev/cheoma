// Product-app visual review for issue #16: one active primary leaf at closed,
// mid-swing, and open poses from the authored focus frame and an oblique orbit.
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from '../app/node_modules/vite/dist/node/index.js';
import { launchVerificationBrowser, reportWebGLRenderer } from './lib/verification-browser.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const APP_ROOT = join(ROOT, 'app');
const outDir = process.env.CHEOMA_DOOR_OUT
  || join(tmpdir(), `cheoma-door-${Date.now()}`);
const targetKind = ['giwa', 'choga', 'hero'].includes(process.env.CHEOMA_DOOR_TARGET)
  ? process.env.CHEOMA_DOOR_TARGET : 'giwa';
const captureTime = process.env.CHEOMA_DOOR_TIME || (targetKind === 'hero' ? 'day' : 'sunset');
await mkdir(outDir, { recursive: true });

const server = await createServer({
  root: APP_ROOT,
  configFile: join(APP_ROOT, 'vite.config.js'),
  cacheDir: join(outDir, '.vite-cache'),
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false },
});

let browser;
try {
  await server.listen();
  const port = server.httpServer.address().port;
  browser = await launchVerificationBrowser();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(
    `http://127.0.0.1:${port}/?hero=0&village=1&worker=0&seed=42&vseed=20260716&time=${captureTime}&lang=ko`,
    { waitUntil: 'domcontentloaded', timeout: 90_000 },
  );
  await page.waitForFunction(() => window.__SHOT_READY === true && !!window.__engine, null, { timeout: 90_000 });
  await reportWebGLRenderer(page, 'door-interaction');
  const candidates = await page.evaluate((kind) => {
    const engine = window.__engine;
    if (engine.debugDof().tweenProgress != null) engine.debugDofSeek(1, { finish: true });
    return engine.village.debugParcels()
      .filter((parcel) => kind === 'hero'
        ? parcel.hero && parcel.heroStyle === 'hanok'
        : !parcel.hero && parcel.kind === kind)
      .map((parcel) => parcel.parcelId);
  }, targetKind);
  let parcelId = null;
  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index];
    await page.evaluate(({ id, first }) => {
      const engine = window.__engine;
      if (first) engine.village.focus(id);
      else engine.village.switchTo(id);
    }, { id: candidate, first: index === 0 });
    await page.waitForFunction((id) => {
      const engine = window.__engine;
      return engine.village.getState().selected === id
        && (!engine.village.getState().transitioning || engine.debugDof().tweenProgress != null);
    }, candidate, { timeout: 90_000 });
    await page.evaluate(() => {
      const engine = window.__engine;
      if (engine.debugDof().tweenProgress != null) engine.debugDofSeek(1, { finish: true });
    });
    await page.waitForFunction((id) => {
      const state = window.__engine.village.getState();
      return state.selected === id && !state.transitioning;
    }, candidate, { timeout: 90_000 });
    let screen = await page.evaluate(() => window.__engine.village.debugDoorScreen());
    if (!screen && targetKind === 'hero') {
      const cameraTrials = [
        { distance: 3.2, lateral: 0, height: 0.65 },
        { distance: 3.6, lateral: -1.0, height: 0.65 },
        { distance: 3.6, lateral: 1.0, height: 0.65 },
        { distance: 4.5, lateral: -1.2, height: 0.4 },
        { distance: 4.5, lateral: 1.2, height: 0.4 },
      ];
      for (const trial of cameraTrials) {
        await page.evaluate(({ distance, lateral, height }) => {
          const engine = window.__engine;
          const frame = engine.village.debugDoorFrame();
          if (!frame) return;
          const [cx, cy, cz] = frame.center;
          const [rx, , rz] = frame.right;
          const [ox, , oz] = frame.outward;
          engine.__controls.target.set(cx, cy, cz);
          engine.camera.position.set(
            cx + ox * distance + rx * lateral,
            cy + height,
            cz + oz * distance + rz * lateral,
          );
          engine.camera.lookAt(cx, cy, cz);
          engine.__controls.update();
        }, trial);
        await page.waitForTimeout(80);
        screen = await page.evaluate(() => window.__engine.village.debugDoorScreen());
        if (screen) break;
      }
    }
    if (screen && screen.spanY >= 42 && screen.spanX >= 18) {
      parcelId = candidate;
      break;
    }
  }
  if (!parcelId) throw new Error(`No visible ${targetKind} primary door among ${candidates.join(',')}`);
  // Put ordinary houses on an explicit human-height inspection frame. Wheel
  // deltas depend on the current focus lens and used to leave the moving leaf
  // only ~50 px tall, too small for a useful visual gate.
  if (targetKind !== 'hero') {
    await page.evaluate(() => {
      const engine = window.__engine;
      const frame = engine.village.debugDoorFrame();
      if (!frame) return;
      const [cx, cy, cz] = frame.center;
      const [rx, , rz] = frame.right;
      const [ox, , oz] = frame.outward;
      engine.__controls.target.set(cx, cy, cz);
      engine.camera.position.set(
        cx + ox * 4.2 + rx * 0.25,
        cy + 0.35,
        cz + oz * 4.2 + rz * 0.25,
      );
      engine.camera.lookAt(cx, cy, cz);
      engine.__controls.update();
    });
  }
  await page.waitForTimeout(180);
  await page.mouse.move(1240, 40);
  await page.addStyleTag({ content: '.hlabel { display: none !important; }' });
  await page.evaluate(() => window.__engine.debugSetPaused(true));
  console.log(`door target=${targetKind} parcel=${parcelId}`);

  const capture = async (view, label, progress) => {
    await page.evaluate((value) => {
      const engine = window.__engine;
      engine.village.debugSeekDoor(value);
      engine.debugSetPaused(false);
    }, progress);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => {
      window.__engine.debugSetPaused(true);
      resolve();
    })));
    const { state, screen, anchorScreen } = await page.evaluate(() => {
      const engine = window.__engine;
      const frame = engine.village.debugDoorFrame();
      const rect = engine.renderer.domElement.getBoundingClientRect();
      const projected = frame
        ? engine.camera.position.clone().fromArray(frame.center).project(engine.camera)
        : null;
      return {
        state: engine.village.debugDoorInteraction(),
        screen: engine.village.debugDoorScreen(),
        anchorScreen: projected ? {
          x: rect.left + (projected.x + 1) * rect.width * 0.5,
          y: rect.top + (1 - projected.y) * rect.height * 0.5,
        } : null,
      };
    });
    if (!screen) throw new Error(`${view}-${label} door has no visible capture target`);
    if (!anchorScreen) throw new Error(`${view}-${label} door has no fixed opening frame`);
    const path = join(outDir, `${view}-${label}.png`);
    const clip = {
      x: Math.max(0, Math.min(720, anchorScreen.x - 280)),
      y: Math.max(0, Math.min(320, anchorScreen.y - 240)),
      width: 560,
      height: 480,
    };
    await page.screenshot({ path, clip });
    console.log(`${view}-${label}: progress=${state.progress.toFixed(3)} angle=${(state.angle * 180 / Math.PI).toFixed(1)}° screen=${screen.x.toFixed(1)},${screen.y.toFixed(1)} span=${screen.spanX.toFixed(1)}×${screen.spanY.toFixed(1)} ${path}`);
  };

  for (const [label, progress] of [['closed', 0], ['mid', 0.5], ['open', 1]]) {
    await capture('front', label, progress);
  }

  await page.evaluate(() => window.__engine.debugSetPaused(false));
  const orbitTarget = await page.evaluate(() => window.__engine.village.debugDoorScreen());
  await page.mouse.move(orbitTarget.x, orbitTarget.y);
  await page.mouse.down();
  await page.mouse.move(orbitTarget.x + 9, orbitTarget.y - 2, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(120);
  await page.mouse.move(1240, 40);
  await page.evaluate(() => window.__engine.debugSetPaused(true));
  for (const [label, progress] of [['closed', 0], ['mid', 0.5], ['open', 1]]) {
    await capture('oblique', label, progress);
  }
  console.log(`DOOR CAPTURES: ${outDir}`);
} finally {
  await browser?.close();
  await server.close();
}
