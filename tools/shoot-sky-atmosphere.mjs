// Full-app sky gate for issues #25/#26: persistent village sky, three sunset looks,
// cloud-linked shadows/rim/rays, and day/night continuity. Screenshots stay in OS temp.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PNG } from 'pngjs';
import { createServer } from '../app/node_modules/vite/dist/node/index.js';
import { launchVerificationBrowser, reportWebGLRenderer } from './lib/verification-browser.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const APP_ROOT = join(ROOT, 'app');
const cacheDir = await mkdtemp(join(tmpdir(), 'cheoma-sky-cache-'));
const outDir = await mkdtemp(join(tmpdir(), 'cheoma-sky-shots-'));
const timeout = Number(process.env.CHEOMA_SKY_TIMEOUT_MS) || 90_000;
const failures = [];
const errors = [];
const pass = (condition, message, detail = '') => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${message}${detail ? ` (${detail})` : ''}`);
  if (!condition) failures.push(message);
};

function meanSky(png) {
  const x0 = 0, x1 = Math.floor(png.width * 0.70);
  const y0 = 0, y1 = Math.floor(png.height * 0.42);
  const sum = [0, 0, 0]; let count = 0;
  for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) {
    const index = (y * png.width + x) * 4;
    if (png.data[index + 3] < 250) continue;
    sum[0] += png.data[index]; sum[1] += png.data[index + 1]; sum[2] += png.data[index + 2]; count++;
  }
  return sum.map((value) => value / Math.max(1, count));
}

const colourDistance = (a, b) => Math.hypot(...a.map((value, index) => value - b[index]));
function meanPixelDifference(a, b) {
  let sum = 0; let count = 0;
  const y1 = Math.floor(a.height * 0.45);
  for (let y = 0; y < y1; y++) for (let x = 0; x < a.width; x++) {
    const index = (y * a.width + x) * 4;
    sum += Math.abs(a.data[index] - b.data[index]);
    sum += Math.abs(a.data[index + 1] - b.data[index + 1]);
    sum += Math.abs(a.data[index + 2] - b.data[index + 2]);
    count += 3;
  }
  return sum / Math.max(1, count);
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
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (error) => errors.push(`page: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' && !/favicon|404/i.test(message.text())) errors.push(`console: ${message.text()}`);
  });

  const url = `http://127.0.0.1:${port}/?shot=1&hero=0&village=1&worker=0`
    + '&seed=42&vseed=20260716&time=sunset&sunset=gold&season=autumn&weather=clear&lang=ko';
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
  await page.waitForFunction(() => window.__SHOT_READY === true && window.__engine?.village?.debugPlan?.(), null, { timeout });
  await page.waitForFunction(() => !window.__engine.village.getState().transitioning, null, { timeout });
  await reportWebGLRenderer(page, 'sky-atmosphere');

  // Use the actual focus transition path, then deterministically seek it to its telephoto end.
  await page.evaluate(() => {
    const engine = window.__engine;
    window.__noWarm = true;
    const id = engine.village.heroId() || engine.village.debugParcels()[0]?.parcelId;
    engine.village.debugFocus(id);
  });
  await page.waitForFunction(() => window.__engine.village.getState().transitioning, null, { timeout: 10_000 });
  await page.evaluate(() => window.__engine.debugDofSeek(1, { finish: true }));
  await page.waitForFunction(() => {
    const state = window.__engine.village.getState();
    return !!state.selected && !state.transitioning;
  }, null, { timeout: 10_000 });

  // The visible UI control must cycle the hue and make a shareable URL state.
  await page.locator('.sunset-tone').click();
  await page.waitForFunction(() => window.__engine.getState().sunsetLook === 'crimson');
  pass((await page.evaluate(() => location.search)).includes('sunset=crimson'),
    'sunset hue control persists the chosen look in the URL');

  const frames = (count = 8) => page.evaluate((n) => new Promise((resolve) => {
    const step = () => (--n <= 0 ? resolve() : requestAnimationFrame(step));
    requestAnimationFrame(step);
  }), count);

  async function capture(name, time, look = 'gold') {
    await page.evaluate(({ nextTime, nextLook }) => {
      const engine = window.__engine;
      engine.setSunsetLook(nextLook, { immediate: true });
      engine.setTime(nextTime, { immediate: true });
    }, { nextTime: time, nextLook: look });
    await frames();
    const path = join(outDir, `${name}.png`);
    await page.screenshot({ path });
    return { path, mean: meanSky(PNG.sync.read(await readFile(path))) };
  }

  const gold = await capture('focus-sunset-gold', 'sunset', 'gold');
  const crimson = await capture('focus-sunset-crimson', 'sunset', 'crimson');
  const violet = await capture('focus-sunset-violet', 'sunset', 'violet');

  const live = await page.evaluate(() => {
    const engine = window.__engine;
    const sky = engine.scene.getObjectByName('sky-atmosphere');
    const environment = engine.scene.getObjectByName('environment');
    const root = engine.village.exportRoot();
    const clouds = root?.getObjectByName('clouds');
    const highs = [];
    const rays = [];
    clouds?.traverse((object) => {
      if (object.name?.startsWith('high-cloud-')) highs.push(object);
      if (object.name?.startsWith('cloud-light-ray-')) rays.push(object);
    });
    const horizonBank = clouds?.getObjectByName('horizon-cloud-bank');
    let horizonTextureAlpha = null;
    const textureCanvas = horizonBank?.material?.map?.image;
    if (textureCanvas?.getContext) {
      const data = textureCanvas.getContext('2d').getImageData(0, 0, textureCanvas.width, textureCanvas.height).data;
      let alphaSum = 0; let alphaMax = 0; let alphaPixels = 0;
      for (let i = 3; i < data.length; i += 4) {
        alphaSum += data[i]; alphaMax = Math.max(alphaMax, data[i]);
        if (data[i] > 16) alphaPixels++;
      }
      horizonTextureAlpha = {
        mean: alphaSum / (data.length / 4), max: alphaMax,
        coverage: alphaPixels / (data.length / 4),
      };
    }
    const cloudUniforms = root?.userData?.cloudUniforms;
    const dome = engine.scene.getObjectByName('skyDome');
    const cameraForward = engine.camera.position.clone();
    engine.camera.getWorldDirection(cameraForward);
    const targetNdc = engine.__controls.target.clone().project(engine.camera);
    const projectedClouds = [];
    if (horizonBank?.isInstancedMesh) {
      const matrix = engine.camera.matrixWorld.clone();
      const point = engine.camera.position.clone();
      for (let i = 0; i < horizonBank.count; i++) {
        horizonBank.getMatrixAt(i, matrix);
        matrix.premultiply(horizonBank.matrixWorld);
        point.setFromMatrixPosition(matrix).project(engine.camera);
        if (Math.abs(point.x) <= 1.4 && Math.abs(point.y) <= 1.4 && point.z >= -1 && point.z <= 1) {
          projectedClouds.push([+point.x.toFixed(2), +point.y.toFixed(2)]);
        }
      }
    }
    return {
      skyVisible: !!sky?.visible,
      environmentVisible: !!environment?.visible,
      domeCameraDistance: dome ? dome.position.distanceTo(engine.camera.position) : null,
      highClouds: highs.length,
      horizonClouds: horizonBank?.count || 0,
      horizonDrawCalls: horizonBank?.isInstancedMesh ? 1 : 0,
      horizonOpacity: horizonBank?.material?.opacity ?? 0,
      horizonDistance: horizonBank?.userData?.distance ?? 0,
      horizonColor: horizonBank?.material?.color?.toArray?.() || null,
      horizonTextureAlpha,
      projectedClouds,
      cameraFov: engine.camera.fov,
      cameraForwardY: cameraForward.y,
      targetNdc: [targetNdc.x, targetNdc.y],
      cameraView: engine.camera.view ? {
        offsetX: engine.camera.view.offsetX,
        offsetY: engine.camera.view.offsetY,
        fullWidth: engine.camera.view.fullWidth,
        fullHeight: engine.camera.view.fullHeight,
      } : null,
      compositionYFrac: window.__viewshift?.compositionYFrac ?? 0,
      rays: rays.length,
      visibleRays: rays.filter((ray) => ray.visible && ray.material.uniforms?.uRayOpacity?.value > 0.01).length,
      maxRayOpacity: Math.max(0, ...rays.map((ray) => ray.material.uniforms?.uRayOpacity?.value || 0)),
      minRim: Math.min(...highs.map((cloud) => cloud.material.userData.cloudRim?.strength?.value ?? 0)),
      shadowStrength: cloudUniforms?.uCloudStr?.value ?? 0,
      drawCalls: engine.village.debugDrawCalls(),
    };
  });
  pass(live.skyVisible && !live.environmentVisible,
    'scene-level sky stays visible when village mode hides single-house scenery');
  pass(live.domeCameraDistance != null && live.domeCameraDistance < 0.01,
    'sky dome follows the active telephoto camera', `distance=${live.domeCameraDistance}`);
  pass(live.compositionYFrac < -0.1,
    'architectural lens rise preserves a visible sky band without moving the door-height target',
    `shift=${live.compositionYFrac.toFixed(3)}`);
  pass(live.cameraForwardY > -0.065 && live.cameraForwardY < -0.035,
    'focus camera holds the three-degree near-ground approach',
    `forwardY=${live.cameraForwardY.toFixed(3)}`);
  pass(live.highClouds === 4 && live.minRim > 0.8,
    'four village clouds receive low-sun HDR rim lighting', `rim>=${live.minRim.toFixed(2)}`);
  pass(live.horizonClouds === 16 && live.horizonDrawCalls === 1,
    'an instanced cloud ring composes every telephoto azimuth in one draw call',
    `projected=${JSON.stringify(live.projectedClouds)}, target=${live.targetNdc.map((v) => v.toFixed(2))}, distance=${live.horizonDistance.toFixed(0)}, opacity=${live.horizonOpacity.toFixed(2)}, color=${live.horizonColor?.map((v) => v.toFixed(2))}, alpha=${JSON.stringify(live.horizonTextureAlpha)}, view=${JSON.stringify(live.cameraView)}, fov=${live.cameraFov.toFixed(1)}, fy=${live.cameraForwardY.toFixed(2)}`);
  pass(live.rays === 3 && live.visibleRays >= 1 && live.maxRayOpacity >= 0.025,
    'cloud-linked crepuscular rays are active in the focus view', `visible=${live.visibleRays}, opacity=${live.maxRayOpacity.toFixed(3)}`);
  pass(live.shadowStrength > 0.25,
    'the same cloud layer drives readable terrain/building shadows', `strength=${live.shadowStrength.toFixed(3)}`);
  pass(live.drawCalls < 1000, 'sunset sky additions preserve the town draw-call ceiling', `calls=${live.drawCalls}`);

  const withBankPath = join(outDir, 'focus-sunset-violet-with-cloud-bank.png');
  const withoutBankPath = join(outDir, 'focus-sunset-violet-without-cloud-bank.png');
  await page.evaluate(() => {
    window.__engine.debugSetPaused(true);
    window.__engine.debugRenderDofFrame();
  });
  await page.screenshot({ path: withBankPath });
  await page.evaluate(() => {
    const engine = window.__engine;
    const cloud = engine.village.exportRoot()?.getObjectByName('horizon-cloud-bank');
    if (cloud) cloud.visible = false;
    engine.debugRenderDofFrame();
  });
  await page.screenshot({ path: withoutBankPath });
  await page.evaluate(() => {
    const engine = window.__engine;
    const cloud = engine.village.exportRoot()?.getObjectByName('horizon-cloud-bank');
    if (cloud) cloud.visible = true;
    engine.debugRenderDofFrame();
    engine.debugSetPaused(false);
  });
  const bankPixelDifference = meanPixelDifference(
    PNG.sync.read(await readFile(withBankPath)),
    PNG.sync.read(await readFile(withoutBankPath)),
  );
  pass(bankPixelDifference > 1.0,
    'the distant cloud bank contributes visible pixels, not only scene objects',
    `mean Δ=${bankPixelDifference.toFixed(3)}`);

  const dGC = colourDistance(gold.mean, crimson.mean);
  const dCV = colourDistance(crimson.mean, violet.mean);
  const dGV = colourDistance(gold.mean, violet.mean);
  pass(Math.min(dGC, dCV, dGV) > 3.0,
    'gold, crimson and violet renders are pixel-distinct', `Δ=${dGC.toFixed(1)}/${dCV.toFixed(1)}/${dGV.toFixed(1)}`);

  const day = await capture('focus-day-clouds', 'day', 'gold');
  const dayState = await page.evaluate(() => {
    const clouds = window.__engine.village.exportRoot()?.getObjectByName('clouds');
    const rays = [], highs = [];
    clouds?.traverse((object) => {
      if (object.name?.startsWith('cloud-light-ray-')) rays.push(object);
      if (object.name?.startsWith('high-cloud-')) highs.push(object);
    });
    return {
      raysVisible: rays.some((ray) => ray.visible),
      maxRim: Math.max(0, ...highs.map((cloud) => cloud.material.userData.cloudRim?.strength?.value ?? 0)),
    };
  });
  pass(!dayState.raysVisible && dayState.maxRim < 0.02,
    'midday retires low-sun rays and rim instead of leaving a permanent effect');

  const night = await capture('focus-night-moon-clouds', 'night', 'gold');
  const nightState = await page.evaluate(() => {
    const engine = window.__engine;
    const moon = engine.scene.getObjectByName('moon');
    const root = engine.village.exportRoot();
    const moonPoint = moon?.position.clone().project(engine.camera);
    return {
      moonVisible: !!moon?.visible,
      moonNdc: moonPoint ? [moonPoint.x, moonPoint.y, moonPoint.z] : null,
      shadowStrength: root?.userData?.cloudUniforms?.uCloudStr?.value ?? 0,
    };
  });
  pass(nightState.moonVisible, 'moon remains in the village focus sky');
  pass(!!nightState.moonNdc && Math.abs(nightState.moonNdc[0]) < 1 && Math.abs(nightState.moonNdc[1]) < 1.05,
    'the near-ground focus angle brings the low moon into the authored house view',
    `ndc=${nightState.moonNdc?.map((value) => value.toFixed(2))}`);
  pass(nightState.shadowStrength > 0.05 && nightState.shadowStrength < 0.3,
    'moonlit cloud shadows remain subtle at night', `strength=${nightState.shadowStrength.toFixed(3)}`);

  // The architectural focus framing intentionally follows the south-facing house,
  // so the moon is not guaranteed to share that azimuth. Turn toward it once and
  // prove the camera-relative moon/cloud sky is an authored view, not merely live state.
  await page.evaluate(() => {
    const engine = window.__engine;
    const moon = engine.scene.getObjectByName('moon');
    let sun = null;
    engine.scene.traverse((object) => { if (!sun && object.isDirectionalLight) sun = object; });
    if (!moon || !sun) return;
    engine.debugSetPaused(true);
    // An off-screen camera-relative object is correctly culled before its
    // onBeforeRender callback, so derive the celestial offset from the shared
    // directional light instead of reading a potentially stale moon transform.
    const target = sun.position.clone().normalize().multiplyScalar(460).add(engine.camera.position);
    engine.__controls.target.copy(target);
    engine.camera.lookAt(target);
    engine.camera.updateMatrixWorld(true);
    engine.debugRenderDofFrame();
  });
  const moonFramedPath = join(outDir, 'night-moon-framed.png');
  await page.screenshot({ path: moonFramedPath });
  const moonFrame = await page.evaluate(() => {
    const engine = window.__engine;
    const moon = engine.scene.getObjectByName('moon');
    const clouds = engine.village.exportRoot()?.getObjectByName('clouds');
    const bank = clouds?.getObjectByName('horizon-cloud-bank');
    const point = moon?.position.clone().project(engine.camera);
    let cloudInFrame = false;
    if (bank?.isInstancedMesh) {
      const matrix = engine.camera.matrixWorld.clone();
      const cloudPoint = engine.camera.position.clone();
      for (let i = 0; i < bank.count; i++) {
        bank.getMatrixAt(i, matrix);
        matrix.premultiply(bank.matrixWorld);
        cloudPoint.setFromMatrixPosition(matrix).project(engine.camera);
        if (Math.abs(cloudPoint.x) <= 1.1 && Math.abs(cloudPoint.y) <= 1.1
          && cloudPoint.z >= -1 && cloudPoint.z <= 1) cloudInFrame = true;
      }
    }
    let frameLocalOpacity = 0;
    clouds?.traverse((object) => {
      if (object.name?.startsWith('high-cloud-')) {
        const projected = object.position.clone().project(engine.camera);
        // Allow for a large plane whose centre sits just outside NDC while its edge
        // still enters the picture; planes far around the world ring are irrelevant.
        if (Math.abs(projected.x) < 3 && Math.abs(projected.y) < 5) {
          frameLocalOpacity = Math.max(frameLocalOpacity, object.material.opacity || 0);
        }
      }
    });
    return { moonNdc: point ? [point.x, point.y, point.z] : null, cloudInFrame, frameLocalOpacity };
  });
  pass(!!moonFrame.moonNdc && Math.abs(moonFrame.moonNdc[0]) < 0.8 && Math.abs(moonFrame.moonNdc[1]) < 0.8,
    'the night sky can frame the moon without abandoning camera-relative atmosphere',
    `ndc=${moonFrame.moonNdc?.map((value) => value.toFixed(2))}`);
  pass(moonFrame.cloudInFrame, 'moon-facing composition retains a cloud silhouette');
  pass(moonFrame.frameLocalOpacity < 0.12,
    'nearby shadow-source billboards fade before becoming a cloud ceiling',
    `opacity=${moonFrame.frameLocalOpacity.toFixed(3)}`);
  await page.evaluate(() => window.__engine.debugSetPaused(false));
  pass(errors.length === 0, 'browser console and page errors remain empty', errors.slice(0, 4).join(' | '));

  console.log(`SKY SHOTS: ${outDir}`);
  console.log([gold.path, crimson.path, violet.path, day.path, night.path, moonFramedPath].join('\n'));
} finally {
  await browser?.close();
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`SKY ATMOSPHERE: FAIL (${failures.length})`);
  process.exitCode = 1;
} else {
  console.log('SKY ATMOSPHERE: PASS');
}
