// Deterministic visual DoF review: rich autumn giwa and sparse summer-night choga.
// Captures go to an OS temp directory (never shots/) and are intended for direct inspection.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from '../app/node_modules/vite/dist/node/index.js';
import { launchVerificationBrowser, reportWebGLRenderer } from './lib/verification-browser.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const APP_ROOT = join(ROOT, 'app');
const cacheDir = await mkdtemp(join(tmpdir(), 'cheoma-dof-shot-cache-'));
const outputDir = await mkdtemp(join(tmpdir(), 'cheoma-dof-shots-'));
const sceneFilter = process.env.CHEOMA_DOF_SCENE || 'all';
const server = await createServer({
  root: APP_ROOT,
  configFile: join(APP_ROOT, 'vite.config.js'),
  cacheDir,
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false },
});

let browser;
const errors = [];
try {
  await server.listen();
  const port = server.httpServer.address().port;
  browser = await launchVerificationBrowser();
  const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
  page.setDefaultTimeout(180_000);
  await page.addInitScript(() => { window.__noWarm = true; });
  page.on('pageerror', (error) => errors.push(`page: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' && !/favicon|404/i.test(message.text())) errors.push(`console: ${message.text()}`);
  });

  await page.goto(`http://127.0.0.1:${port}/?hero=0&village=1&worker=0&shot=1`
    + '&seed=42&vseed=20260716&time=sunset&season=autumn&weather=clear', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__SHOT_READY === true && !!window.__engine);
  await page.waitForFunction(() => window.__engine?.village?.debugPlan?.()?.seed === 20260716);
  await reportWebGLRenderer(page, 'dof-shot');

  const candidates = await page.evaluate(() => {
    const parcels = window.__engine.village.debugParcels();
    const regular = parcels.filter((parcel) => !parcel.hero && parcel.editable);
    return {
      giwa: regular.find((parcel) => parcel.kind === 'giwa')?.parcelId || regular[0]?.parcelId,
      choga: regular.find((parcel) => parcel.kind === 'choga')?.parcelId || regular.at(-1)?.parcelId,
    };
  });
  if (!candidates.giwa || !candidates.choga) throw new Error(`missing visual DoF candidates: ${JSON.stringify(candidates)}`);

  const beginAndSeek = async (method, parcelId) => page.evaluate(async ({ method, parcelId }) => {
    const engine = window.__engine;
    engine.village[method](parcelId);
    for (let i = 0; i < 4; i++) await Promise.resolve();
    const sampled = engine.debugDofSeek(1, { finish: true });
    if (!sampled) throw new Error(`${method} transition did not start`);
    engine.debugTuneDof({ amount: 0 });
    return sampled;
  }, { method, parcelId });

  const logCenterHits = async (label) => {
    const hits = await page.evaluate(async (threeModuleUrl) => {
      const THREE = await import(threeModuleUrl);
      const engine = window.__engine;
      const ray = new THREE.Raycaster();
      ray.setFromCamera(new THREE.Vector2(0, 0), engine.camera);
      return ray.intersectObjects(engine.scene.children, true).slice(0, 8).map((hit) => {
        const ancestry = [];
        for (let object = hit.object; object && ancestry.length < 5; object = object.parent) {
          ancestry.push(object.name || object.type);
        }
        return {
          distance: +hit.distance.toFixed(2),
          object: hit.object.name || hit.object.type,
          ancestry,
          instanceId: hit.instanceId ?? null,
        };
      });
    }, `/@fs${join(APP_ROOT, 'node_modules/three/build/three.module.js')}`);
    console.log(`${label} center hits: ${JSON.stringify(hits)}`);
  };

  const capture = async (name, aperture) => {
    const state = await page.evaluate(({ aperture }) => {
      const engine = window.__engine;
      engine.debugTuneDof({ amount: aperture == null ? 0 : 1, aperture: aperture ?? 0.00012 });
      engine.debugRenderDofFrame();
      let firefly = null;
      engine.scene.traverse((object) => {
        if (firefly == null && object.name === 'dustMotes' && object.parent?.parent?.name === 'focusRing') {
          firefly = object.material?.uniforms?.uFirefly?.value ?? null;
        }
      });
      return { ...engine.debugDof(), focusStrength: window.__hero?.focusStrength ?? null, firefly };
    }, { aperture });
    const path = join(outputDir, `${name}.png`);
    await page.locator('canvas').screenshot({ path });
    console.log(`${path} ${JSON.stringify(state)}`);
  };

  if (sceneFilter !== 'night') {
    await beginAndSeek('focus', candidates.giwa);
    const giwaStrength = await page.evaluate(() => {
      window.__engine.setWeather('clear');
      window.__engine.setSeason('autumn', { immediate: true });
      window.__engine.setTime('sunset', { immediate: true });
      const strength = window.__engine.debugAdvanceFocusRing(3.2);
      window.__engine.debugAdvancePost(2.0);
      window.__engine.debugSetPaused(true);
      return strength;
    });
    console.log(`giwa focus ring strength: ${giwaStrength}`);
    await logCenterHits('giwa');
    await capture('giwa-autumn-sunset-off', null);
    await capture('giwa-autumn-sunset-012', 0.00012);
    await capture('giwa-autumn-sunset-015', 0.00015);
    await capture('giwa-autumn-sunset-018', 0.00018);
  }

  if (sceneFilter !== 'giwa') {
    await page.evaluate(() => {
      window.__engine.debugSetPaused(false);
      window.__engine.debugTuneDof({ amount: 0 });
    });
    await beginAndSeek(sceneFilter === 'night' ? 'focus' : 'switchTo', candidates.choga);
    await page.evaluate(() => {
      window.__engine.setWeather('clear');
      window.__engine.setSeason('summer', { immediate: true });
      window.__engine.setTime('night', { immediate: true });
    });
    await page.waitForTimeout(100); // one product frame wires settled uniforms before deterministic pause
    const chogaStrength = await page.evaluate(() => {
      const strength = window.__engine.debugAdvanceFocusRing(3.2);
      window.__engine.debugAdvancePost(2.0);
      window.__engine.debugSetPaused(true);
      return strength;
    });
    console.log(`choga focus ring strength: ${chogaStrength}`);
    await logCenterHits('choga');
    await capture('choga-summer-night-off', null);
    await capture('choga-summer-night-015', 0.00015);
  }

  console.log(`DOF SHOTS: ${outputDir}`);
  console.log(`runtime errors: ${errors.length}`);
  for (const error of errors) console.log(error);
  if (errors.length) process.exitCode = 1;
} finally {
  await browser?.close();
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
}
