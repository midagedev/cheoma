// Full-app sky gate for issues #25/#26: persistent village sky, three sunset looks,
// cloud-linked shadows/rim/rays, and day/night continuity. Screenshots stay in OS temp.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PNG } from 'pngjs';
import { createServer } from '../app/node_modules/vite/dist/node/index.js';
import { launchVerificationBrowser, reportWebGLRenderer } from './lib/verification-browser.mjs';
import { VILLAGE_FOCUS_ELEVATION } from '../src/camera/optics.js';
import {
  MOON_ANGULAR_DIAMETER_DEG,
  projectedAngularDiameterPixels,
} from '../src/api/moon-optics.js';

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
  // The product frame is courtyard-first, so this sample intentionally includes the
  // upper roof mass as well as the smaller remaining sky. The sunset-look threshold
  // below is correspondingly modest: it catches a no-op profile without requiring a
  // sky-dominant composition that would crop the architecture again.
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
  // The low-angle composition deliberately places the cloud bank just above the
  // roofline, below the old top-45% crop. Compare the authored sky/roof frame while
  // excluding only the bottom controls and foreground bokeh.
  const y1 = Math.floor(a.height * 0.78);
  for (let y = 0; y < y1; y++) for (let x = 0; x < a.width; x++) {
    const index = (y * a.width + x) * 4;
    sum += Math.abs(a.data[index] - b.data[index]);
    sum += Math.abs(a.data[index + 1] - b.data[index + 1]);
    sum += Math.abs(a.data[index + 2] - b.data[index + 2]);
    count += 3;
  }
  return sum / Math.max(1, count);
}

const pixelLuminance = (png, x, y) => {
  const index = (y * png.width + x) * 4;
  return 0.2126 * png.data[index] + 0.7152 * png.data[index + 1] + 0.0722 * png.data[index + 2];
};

function meanDiscLuminance(png, radius) {
  const cx = Math.floor(png.width * 0.5);
  const cy = Math.floor(png.height * 0.5);
  let sum = 0; let count = 0;
  const bound = Math.ceil(radius);
  for (let y = cy - bound; y <= cy + bound; y++) for (let x = cx - bound; x <= cx + bound; x++) {
    if ((x - cx) ** 2 + (y - cy) ** 2 > radius ** 2) continue;
    sum += pixelLuminance(png, x, y);
    count++;
  }
  return sum / Math.max(1, count);
}

function meanAnnulusLuminance(png, innerRadius, outerRadius) {
  const cx = Math.floor(png.width * 0.5);
  const cy = Math.floor(png.height * 0.5);
  let sum = 0; let count = 0;
  const bound = Math.ceil(outerRadius);
  for (let y = cy - bound; y <= cy + bound; y++) for (let x = cx - bound; x <= cx + bound; x++) {
    const radius2 = (x - cx) ** 2 + (y - cy) ** 2;
    if (radius2 < innerRadius ** 2 || radius2 > outerRadius ** 2) continue;
    sum += pixelLuminance(png, x, y);
    count++;
  }
  return sum / Math.max(1, count);
}

function brightDiscDiameter(png, expectedDiameter) {
  const cx = Math.floor(png.width * 0.5);
  const cy = Math.floor(png.height * 0.5);
  const bound = Math.ceil(expectedDiameter * 0.8 + 4);
  let maximum = 0;
  for (let y = cy - bound; y <= cy + bound; y++) for (let x = cx - bound; x <= cx + bound; x++) {
    maximum = Math.max(maximum, pixelLuminance(png, x, y));
  }
  const threshold = Math.max(150, maximum - 24);
  let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
  for (let y = cy - bound; y <= cy + bound; y++) for (let x = cx - bound; x <= cx + bound; x++) {
    if (pixelLuminance(png, x, y) < threshold) continue;
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  return {
    diameter: Number.isFinite(minX) ? ((maxX - minX + 1) + (maxY - minY + 1)) * 0.5 : 0,
    maximum,
    threshold,
  };
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
    window.__skyFocusId = id;
    engine.village.debugFocus(id);
  });
  await page.waitForFunction(() => window.__engine.village.getState().transitioning, null, { timeout: 10_000 });
  await page.evaluate(() => window.__engine.debugDofSeek(1, { finish: true }));
  await page.waitForFunction(() => {
    const state = window.__engine.village.getState();
    return !!state.selected && !state.transitioning;
  }, null, { timeout: 10_000 });

  // Capture the real product aerial endpoint rather than the startup reveal
  // camera, then return to the same focused parcel for the remaining fixture.
  await page.evaluate(() => window.__engine.village.return());
  await page.waitForFunction(
    () => window.__engine.debugDof().tweenProgress != null,
    null,
    { timeout: 10_000 },
  );
  await page.evaluate(() => window.__engine.debugDofSeek(1, { finish: true }));
  await page.waitForFunction(() => {
    const state = window.__engine.village.getState();
    return !state.selected && !state.transitioning;
  }, null, { timeout: 10_000 });
  await page.evaluate(() => {
    const engine = window.__engine;
    window.__moonAerialFrame = {
      position: engine.camera.position.clone(),
      target: engine.__controls.target.clone(),
      fov: engine.camera.fov,
      referenceFov: engine.camera.userData.villageReferenceFov,
    };
    engine.village.debugFocus(window.__skyFocusId);
  });
  await page.waitForFunction(
    () => window.__engine.debugDof().tweenProgress != null,
    null,
    { timeout: 10_000 },
  );
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
      horizonViewActive: horizonBank?.userData?.viewActive ?? null,
      horizonVisible: !!horizonBank?.visible,
      horizonTextureAlpha,
      projectedClouds,
      cameraFov: engine.camera.fov,
      cameraY: engine.camera.position.y,
      targetY: engine.__controls.target.y,
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
  pass(Math.abs(live.compositionYFrac) < 1e-6,
    'focus projection stays centered so the foreground courtyard is not cropped for extra sky',
    `shift=${live.compositionYFrac.toFixed(3)}`);
  pass(Math.abs(live.cameraForwardY + Math.sin(VILLAGE_FOCUS_ELEVATION)) < 0.002,
    `focus camera holds the exact ${Math.round(VILLAGE_FOCUS_ELEVATION * 180 / Math.PI)}-degree courtyard-reading approach`,
    `forwardY=${live.cameraForwardY.toFixed(3)}`);
  pass(live.highClouds === 4 && live.minRim > 0.8,
    'four village clouds receive low-sun HDR rim lighting', `rim>=${live.minRim.toFixed(2)}`);
  pass(live.horizonClouds === 16 && live.horizonDrawCalls === 1,
    'an instanced cloud ring composes every telephoto azimuth in one draw call',
    `projected=${JSON.stringify(live.projectedClouds)}, target=${live.targetNdc.map((v) => v.toFixed(2))}, distance=${live.horizonDistance.toFixed(0)}, opacity=${live.horizonOpacity.toFixed(2)}, color=${live.horizonColor?.map((v) => v.toFixed(2))}, alpha=${JSON.stringify(live.horizonTextureAlpha)}, view=${JSON.stringify(live.cameraView)}, fov=${live.cameraFov.toFixed(1)}, fy=${live.cameraForwardY.toFixed(2)}`);
  pass(live.projectedClouds.length === 0 && live.horizonViewActive === false
      && !live.horizonVisible && live.rays === 3 && live.visibleRays === 0,
    'courtyard focus sleeps the off-frame cloud bank and all linked rays before render',
    `projected=${live.projectedClouds.length}, active=${live.horizonViewActive}, bank=${live.horizonVisible}, rays=${live.visibleRays}`);
  pass(live.shadowStrength > 0.25,
    'the same cloud layer drives readable terrain/building shadows', `strength=${live.shadowStrength.toFixed(3)}`);
  pass(live.drawCalls < 1000, 'sunset sky additions preserve the town draw-call ceiling', `calls=${live.drawCalls}`);

  const withBankPath = join(outDir, 'focus-sunset-violet-forced-cloud-bank.png');
  const withoutBankPath = join(outDir, 'focus-sunset-violet-without-cloud-bank.png');
  const bankRenderCost = await page.evaluate(() => {
    const engine = window.__engine;
    const clouds = engine.village.exportRoot()?.getObjectByName('clouds');
    const bank = clouds?.getObjectByName('horizon-cloud-bank');
    const rays = [];
    clouds?.traverse((object) => {
      if (object.name?.startsWith('cloud-light-ray-')) rays.push(object);
    });
    engine.debugSetPaused(true);
    const saved = [bank?.visible, ...rays.map((ray) => ray.visible)];
    const programsBefore = engine.renderer.info.programs?.length ?? 0;
    if (bank) bank.visible = false;
    for (const ray of rays) ray.visible = false;
    const sleepingCalls = engine.village.debugDrawCalls();
    if (bank) bank.visible = true;
    for (const ray of rays) ray.visible = true;
    const forcedCalls = engine.village.debugDrawCalls();
    const programsWarmed = engine.renderer.info.programs?.length ?? 0;
    if (bank) bank.visible = false;
    for (const ray of rays) ray.visible = false;
    engine.village.debugDrawCalls();
    const programsPlateau = engine.renderer.info.programs?.length ?? 0;
    if (bank) bank.visible = saved[0];
    rays.forEach((ray, index) => { ray.visible = saved[index + 1]; });
    engine.debugRenderDofFrame();
    return {
      saved, sleepingCalls, forcedCalls, programsBefore, programsWarmed, programsPlateau,
    };
  });
  pass(bankRenderCost.saved.every((visible) => visible === false)
      && bankRenderCost.forcedCalls - bankRenderCost.sleepingCalls === 4,
    'the default view avoids one bank and three ray submissions',
    `calls=${bankRenderCost.sleepingCalls} sleeping/${bankRenderCost.forcedCalls} forced`);
  pass(bankRenderCost.programsPlateau === bankRenderCost.programsWarmed,
    'view sleep/wake reuses the same shader-program families',
    `programs=${bankRenderCost.programsBefore}→${bankRenderCost.programsWarmed}→${bankRenderCost.programsPlateau}`);
  await page.evaluate(() => {
    const engine = window.__engine;
    const cloud = engine.village.exportRoot()?.getObjectByName('horizon-cloud-bank');
    if (cloud) cloud.visible = true;
    engine.debugRenderDofFrame();
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
    if (cloud) cloud.visible = cloud.userData.viewActive;
    engine.debugRenderDofFrame();
    engine.debugSetPaused(false);
  });
  const bankPixelDifference = meanPixelDifference(
    PNG.sync.read(await readFile(withBankPath)),
    PNG.sync.read(await readFile(withoutBankPath)),
  );
  pass(bankPixelDifference < 0.1,
  'forcing the off-frame bank on adds no hidden pixels to the courtyard composition',
  `projected=${live.projectedClouds.length}, mean Δ=${bankPixelDifference.toFixed(3)}`);

  const dGC = colourDistance(gold.mean, crimson.mean);
  const dCV = colourDistance(crimson.mean, violet.mean);
  const dGV = colourDistance(gold.mean, violet.mean);
  pass(Math.min(dGC, dCV, dGV) > 1.5,
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
      bankActive: clouds?.getObjectByName('horizon-cloud-bank')?.userData?.viewActive ?? null,
      maxRim: Math.max(0, ...highs.map((cloud) => cloud.material.userData.cloudRim?.strength?.value ?? 0)),
    };
  });
  pass(!dayState.bankActive && !dayState.raysVisible && dayState.maxRim < 0.02,
    'midday keeps the off-frame bank asleep and retires low-sun rays/rim');

  const night = await capture('focus-night-moon-clouds', 'night', 'gold');
  const nightState = await page.evaluate(() => {
    const engine = window.__engine;
    const moon = engine.scene.getObjectByName('moon');
    const root = engine.village.exportRoot();
    const moonPoint = moon?.position.clone().project(engine.camera);
    return {
      moonVisible: !!moon?.visible,
      moonNdc: moonPoint ? [moonPoint.x, moonPoint.y, moonPoint.z] : null,
      bankActive: root?.getObjectByName('horizon-cloud-bank')?.userData?.viewActive ?? null,
      shadowStrength: root?.userData?.cloudUniforms?.uCloudStr?.value ?? 0,
    };
  });
  pass(nightState.moonVisible, 'moon remains in the village focus sky');
  pass(!!nightState.moonNdc && nightState.moonNdc.every(Number.isFinite),
    'courtyard-first focus keeps a valid camera-relative moon even when it leaves the default frame',
    `ndc=${nightState.moonNdc?.map((value) => value.toFixed(2))}`);
  pass(nightState.shadowStrength > 0.05 && nightState.shadowStrength < 0.3,
    'moonlit cloud shadows remain subtle at night', `strength=${nightState.shadowStrength.toFixed(3)}`);
  pass(nightState.bankActive === false,
    'night keeps the same off-frame cloud-bank sleep contract in courtyard focus');

  // U2 product night aerial: return to the authored aerial pose under night time so the
  // lunar disc/corona share the village survey frame (not a look-at-moon judgment cut).
  await page.evaluate(() => {
    const engine = window.__engine;
    engine.debugSetPaused(false);
    engine.setTime('night', { immediate: true });
    engine.village.return();
  });
  await page.waitForFunction(
    () => window.__engine.debugDof().tweenProgress != null,
    null,
    { timeout: 10_000 },
  ).catch(() => {});
  await page.evaluate(() => window.__engine.debugDofSeek?.(1, { finish: true }));
  await page.waitForFunction(() => {
    const state = window.__engine.village.getState();
    return !state.selected && !state.transitioning;
  }, null, { timeout: 10_000 });
  await page.evaluate(() => {
    const engine = window.__engine;
    // Ensure elevation settled at night aerial (immediate path may already be there).
    engine.setTime('night', { immediate: true });
    engine.debugSetPaused(true);
    engine.debugRenderDofFrame?.();
  });
  await frames(4);
  const nightAerialPath = join(outDir, 'night-aerial-moon.png');
  await page.screenshot({ path: nightAerialPath });
  const nightAerial = await page.evaluate(() => {
    const engine = window.__engine;
    const moon = engine.scene.getObjectByName('moon');
    const continuum = engine.village.debugContinuum?.() || {};
    // Force camera-relative moon placement before project (onBeforeRender may not
    // have run while paused).
    let sun = null;
    engine.scene.traverse((object) => { if (!sun && object.isDirectionalLight) sun = object; });
    if (moon && sun) {
      const distance = moon.userData.optics?.distance || 460;
      moon.position.copy(sun.position).normalize().multiplyScalar(distance).add(engine.camera.position);
      moon.updateMatrixWorld(true);
      moon.visible = true;
    }
    const point = moon?.position.clone().project(engine.camera);
    const elev = (() => {
      const offset = engine.camera.position.clone().sub(engine.__controls.target);
      const dist = offset.length() || 1;
      return Math.asin(Math.max(-1, Math.min(1, offset.y / dist))) * 180 / Math.PI;
    })();
    return {
      moonVisible: !!moon?.visible,
      moonNdc: point ? [point.x, point.y, point.z] : null,
      aerialElevationDeg: continuum.aerialElevationDeg ?? elev,
      timeOfDay: continuum.timeOfDay ?? engine.getState?.().time,
      cameraElevDeg: elev,
    };
  });
  pass(nightAerial.moonVisible, 'product night aerial keeps the moon presentation on');
  pass(
    !!nightAerial.moonNdc
      && Math.abs(nightAerial.moonNdc[0]) < 0.92
      && Math.abs(nightAerial.moonNdc[1]) < 0.92
      && nightAerial.moonNdc[2] > -1
      && nightAerial.moonNdc[2] < 1,
    'product night aerial frames the lunar disc or corona in NDC',
    `ndc=${nightAerial.moonNdc?.map((value) => value.toFixed(2))} elev=${nightAerial.cameraElevDeg?.toFixed?.(1)}`,
  );
  pass(
    nightAerial.cameraElevDeg < 22 && nightAerial.cameraElevDeg > 8,
    'product night aerial uses the softened elevation band (not the 31° day survey)',
    `elev=${nightAerial.cameraElevDeg?.toFixed?.(1)}`,
  );
  // Village must not read as crushed-black silhouette-only: lower half mean luma.
  const nightAerialPng = PNG.sync.read(await readFile(nightAerialPath));
  let nightLumaSum = 0;
  let nightLumaCount = 0;
  const y0 = Math.floor(nightAerialPng.height * 0.45);
  for (let y = y0; y < nightAerialPng.height; y += 2) {
    for (let x = 0; x < nightAerialPng.width; x += 2) {
      const index = (y * nightAerialPng.width + x) * 4;
      nightLumaSum += 0.2126 * nightAerialPng.data[index]
        + 0.7152 * nightAerialPng.data[index + 1]
        + 0.0722 * nightAerialPng.data[index + 2];
      nightLumaCount++;
    }
  }
  const nightVillageLuma = nightLumaSum / Math.max(1, nightLumaCount);
  pass(nightVillageLuma > 12,
    'night aerial village midtones stay above crushed-black silhouette',
    `meanLuma=${nightVillageLuma.toFixed(1)}`);

  // Restore the courtyard focus endpoint so the existing moon-optics FOV / cloud
  // attenuation suite still inherits parcel (10°) and planned hero (7°) frames.
  await page.evaluate(() => {
    const engine = window.__engine;
    engine.debugSetPaused(false);
    engine.village.debugFocus(window.__skyFocusId);
  });
  await page.waitForFunction(
    () => window.__engine.debugDof().tweenProgress != null,
    null,
    { timeout: 10_000 },
  );
  await page.evaluate(() => window.__engine.debugDofSeek(1, { finish: true }));
  await page.waitForFunction(() => {
    const state = window.__engine.village.getState();
    return !!state.selected && !state.transitioning;
  }, null, { timeout: 10_000 });

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
    const distance = moon.userData.optics?.distance || 460;
    const target = sun.position.clone().normalize().multiplyScalar(distance).add(engine.camera.position);
    engine.__controls.target.copy(target);
    engine.camera.lookAt(target);
    engine.camera.updateMatrixWorld(true);
    engine.village.exportRoot()?.getObjectByName('clouds')?.userData?.updateView?.(engine.camera);
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
    return {
      moonNdc: point ? [point.x, point.y, point.z] : null,
      bankActive: bank?.userData?.viewActive ?? null,
      bankVisible: !!bank?.visible,
      cloudInFrame,
      frameLocalOpacity,
    };
  });
  pass(!!moonFrame.moonNdc && Math.abs(moonFrame.moonNdc[0]) < 0.8 && Math.abs(moonFrame.moonNdc[1]) < 0.8,
    'the night sky can frame the moon without abandoning camera-relative atmosphere',
    `ndc=${moonFrame.moonNdc?.map((value) => value.toFixed(2))}`);
  pass(moonFrame.bankActive === true && moonFrame.bankVisible && moonFrame.cloudInFrame,
    'an explicit sky-facing composition wakes the cloud bank and retains a silhouette');
  pass(moonFrame.frameLocalOpacity < 0.12,
    'nearby shadow-source billboards fade before becoming a cloud ceiling',
    `opacity=${moonFrame.frameLocalOpacity.toFixed(3)}`);

  const moonRuntime = await page.evaluate(() => {
    const engine = window.__engine;
    const moon = engine.scene.getObjectByName('moon');
    const disk = moon?.getObjectByName('moon-disk');
    const transmitted = moon?.getObjectByName('moon-corona-transmitted');
    const scattered = moon?.getObjectByName('moon-corona-scattered');
    const clouds = engine.village.exportRoot()?.getObjectByName('clouds');
    const bank = clouds?.getObjectByName('horizon-cloud-bank');
    const highOrders = [];
    clouds?.traverse((object) => {
      if (object.name?.startsWith('high-cloud-')) highOrders.push(object.renderOrder);
    });
    const layers = [disk, transmitted, scattered];
    engine.renderer.render(engine.scene, engine.camera);
    engine.renderer.render(engine.scene, engine.camera);
    const resourcesBefore = {
      programs: engine.renderer.info.programs?.length ?? 0,
      geometries: engine.renderer.info.memory.geometries,
      textures: engine.renderer.info.memory.textures,
    };
    const savedVisible = layers.map((layer) => layer?.visible);
    layers.forEach((layer) => { if (layer) layer.visible = false; });
    engine.renderer.render(engine.scene, engine.camera);
    const withoutMoonCalls = engine.renderer.info.render.calls;
    layers.forEach((layer, index) => { if (layer) layer.visible = savedVisible[index]; });
    engine.renderer.render(engine.scene, engine.camera);
    const withMoonCalls = engine.renderer.info.render.calls;
    const resourcesAfter = {
      programs: engine.renderer.info.programs?.length ?? 0,
      geometries: engine.renderer.info.memory.geometries,
      textures: engine.renderer.info.memory.textures,
    };
    engine.debugRenderDofFrame();
    return {
      count: layers.filter(Boolean).length,
      names: layers.map((layer) => layer?.name),
      transparent: layers.map((layer) => layer?.material?.transparent),
      depthTest: layers.map((layer) => layer?.material?.depthTest),
      depthWrite: layers.map((layer) => layer?.material?.depthWrite),
      frustumCulled: layers.map((layer) => layer?.frustumCulled),
      orders: layers.map((layer) => layer?.renderOrder),
      ancestorOrders: [moon?.renderOrder, clouds?.renderOrder],
      cloudOrders: [bank?.renderOrder, ...highOrders],
      sharedGeometry: transmitted?.geometry === scattered?.geometry,
      sharedMap: transmitted?.material?.map === scattered?.material?.map,
      distinctMaterials: transmitted?.material !== scattered?.material,
      diskSegments: disk?.geometry?.parameters
        ? [disk.geometry.parameters.widthSegments, disk.geometry.parameters.heightSegments]
        : null,
      textureSize: transmitted?.material?.map?.image
        ? [transmitted.material.map.image.width, transmitted.material.map.image.height]
        : null,
      drawDelta: withMoonCalls - withoutMoonCalls,
      resourcesBefore,
      resourcesAfter,
    };
  });
  pass(moonRuntime.count === 3
      && moonRuntime.names.join('|')
        === 'moon-disk|moon-corona-transmitted|moon-corona-scattered',
    'the reusable Moon assembly owns exactly one disc and two named corona layers');
  pass(moonRuntime.transparent.every(Boolean)
      && moonRuntime.depthTest.every(Boolean)
      && moonRuntime.depthWrite.every((value) => value === false),
    'all Moon layers preserve transparent blending while opaque scene depth owns occlusion');
  pass(moonRuntime.frustumCulled.every((value) => value === false),
    'camera-relative Moon layers cannot be stranded by previous-frame frustum bounds');
  pass(moonRuntime.ancestorOrders.every((value) => value === 0)
      && moonRuntime.orders.join('|') === '0|-1|4'
      && moonRuntime.cloudOrders.every((value) => value >= 1 && value <= 3),
    'transparent sorting keeps transmitted corona and disc before clouds and scattered corona after');
  pass(moonRuntime.sharedGeometry && moonRuntime.sharedMap && moonRuntime.distinctMaterials,
    'the two corona lanes share geometry and texture while retaining independent opacity');
  pass(moonRuntime.diskSegments?.join('|') === '24|16'
      && moonRuntime.textureSize?.join('|') === '128|128',
    'the optical correction retains the original lightweight disc and texture resolution');
  pass(moonRuntime.drawDelta === 3,
    'the complete night Moon costs three scene submissions', `delta=${moonRuntime.drawDelta}`);
  pass(JSON.stringify(moonRuntime.resourcesBefore) === JSON.stringify(moonRuntime.resourcesAfter),
    'Moon hide/show reuses the warmed program, geometry, and texture plateau',
    `${JSON.stringify(moonRuntime.resourcesBefore)}→${JSON.stringify(moonRuntime.resourcesAfter)}`);

  // Measure the raw physical disc without post-process bloom/DoF or corona. The
  // product camera and scene remain real; only unrelated cloud/glow layers sleep.
  const projectionPaths = [];
  for (const fov of [46, 10, 7]) {
    await page.evaluate((nextFov) => {
      const engine = window.__engine;
      const moon = engine.scene.getObjectByName('moon');
      const clouds = engine.village.exportRoot()?.getObjectByName('clouds');
      const transmitted = moon?.getObjectByName('moon-corona-transmitted');
      const scattered = moon?.getObjectByName('moon-corona-scattered');
      if (!window.__moonOpticsRestore) {
        window.__moonOpticsRestore = {
          fov: engine.camera.fov,
          position: engine.camera.position.clone(),
          target: engine.__controls.target.clone(),
          referenceFov: engine.camera.userData.villageReferenceFov,
          cloudsVisible: clouds?.visible,
          transmittedVisible: transmitted?.visible,
          scatteredVisible: scattered?.visible,
        };
      }
      const heroId = engine.village.heroId();
      const heroFrame = heroId
        ? engine.village.debugFocusVisibility(heroId)?.hero?.safeFraming
        : null;
      window.__moonHeroFrame = heroFrame;
      const restore = window.__moonOpticsRestore;
      if (nextFov === 7 && heroFrame) {
        engine.camera.position.fromArray(heroFrame.position);
        engine.camera.userData.villageReferenceFov = heroFrame.referenceFov;
      } else if (nextFov === 46 && window.__moonAerialFrame) {
        engine.camera.position.copy(window.__moonAerialFrame.position);
        engine.camera.userData.villageReferenceFov = window.__moonAerialFrame.referenceFov;
      } else if (restore?.position) {
        engine.camera.position.copy(restore.position);
        engine.camera.userData.villageReferenceFov = restore.referenceFov;
      }
      const distance = moon?.userData?.optics?.distance || 460;
      let sun = null;
      engine.scene.traverse((object) => { if (!sun && object.isDirectionalLight) sun = object; });
      const target = sun.position.clone().normalize().multiplyScalar(distance).add(engine.camera.position);
      engine.camera.fov = nextFov;
      engine.camera.updateProjectionMatrix();
      engine.__controls.target.copy(target);
      engine.camera.lookAt(target);
      engine.camera.updateMatrixWorld(true);
      if (clouds) clouds.visible = false;
      if (transmitted) transmitted.visible = false;
      if (scattered) scattered.visible = false;
      engine.renderer.render(engine.scene, engine.camera);
    }, fov);
    const path = join(outDir, `moon-disc-${fov}deg.png`);
    await page.screenshot({ path });
    projectionPaths.push({ fov, path });
  }
  const projectionMeasures = [];
  for (const { fov, path } of projectionPaths) {
    const png = PNG.sync.read(await readFile(path));
    const expected = projectedAngularDiameterPixels(
      MOON_ANGULAR_DIAMETER_DEG,
      fov,
      png.height,
    );
    projectionMeasures.push({ fov, expected, ...brightDiscDiameter(png, expected) });
  }
  const productProjectionFrames = await page.evaluate(() => ({
    aerialFov: window.__moonAerialFrame?.fov,
    focusFov: window.__moonOpticsRestore?.fov,
    heroFov: window.__moonHeroFrame?.fov,
  }));
  pass(Math.abs(productProjectionFrames.aerialFov - 46) < 1e-9
      && Math.abs(productProjectionFrames.focusFov - 10) < 1e-9
      && Math.abs(productProjectionFrames.heroFov - 7) < 1e-9,
    'isolated 46°/10°/7° measurements inherit actual aerial, parcel, and planned hero endpoints');
  for (const measure of projectionMeasures) {
    const tolerance = Math.max(2, measure.expected * 0.12);
    pass(Math.abs(measure.diameter - measure.expected) <= tolerance,
      `${measure.fov}° camera projects the 0.52° lunar disc at its angular size`,
      `actual=${measure.diameter.toFixed(1)}px expected=${measure.expected.toFixed(1)}px`);
  }
  pass(projectionMeasures.every((measure, index) => (
    index === 0 || measure.diameter > projectionMeasures[index - 1].diameter
  )), '46° → 10° → 7° optics magnify the same physical Moon monotonically');

  // Put one existing horizon-cloud instance directly on the Moon ray. This changes
  // no product resource and lets the real NormalBlending/render-order stack prove
  // continuous source attenuation plus a residual scattered corona.
  await page.evaluate(() => {
    const engine = window.__engine;
    const moon = engine.scene.getObjectByName('moon');
    const clouds = engine.village.exportRoot()?.getObjectByName('clouds');
    const bank = clouds?.getObjectByName('horizon-cloud-bank');
    const transmitted = moon?.getObjectByName('moon-corona-transmitted');
    const scattered = moon?.getObjectByName('moon-corona-scattered');
    const highs = [];
    const rays = [];
    clouds?.traverse((object) => {
      if (object.name?.startsWith('high-cloud-')) highs.push(object);
      if (object.name?.startsWith('cloud-light-ray-')) rays.push(object);
    });
    const restore = window.__moonOpticsRestore;
    window.__moonCloudRestore = {
      matrices: bank?.instanceMatrix?.array?.slice(),
      bankVisible: bank?.visible,
      bankViewActive: bank?.userData?.viewActive,
      bankOpacity: bank?.material?.opacity,
      highVisible: highs.map((object) => object.visible),
      rayVisible: rays.map((object) => object.visible),
    };
    engine.camera.fov = 7;
    engine.camera.updateProjectionMatrix();
    if (clouds) clouds.visible = true;
    if (transmitted) transmitted.visible = restore?.transmittedVisible ?? true;
    if (scattered) scattered.visible = restore?.scatteredVisible ?? true;
    highs.forEach((object) => { object.visible = false; });
    rays.forEach((object) => { object.visible = false; });
    if (bank) {
      const distance = 84;
      const direction = moon.position.clone().sub(engine.camera.position).normalize();
      const position = engine.camera.position.clone().addScaledVector(direction, distance);
      const worldMatrix = engine.camera.matrixWorld.clone().setPosition(position);
      const parentInverse = bank.matrixWorld.clone().invert();
      const localMatrix = parentInverse.multiply(worldMatrix);
      const zeroMatrix = worldMatrix.clone().makeScale(0, 0, 0);
      bank.setMatrixAt(0, localMatrix);
      for (let index = 1; index < bank.count; index++) bank.setMatrixAt(index, zeroMatrix);
      bank.instanceMatrix.needsUpdate = true;
      bank.visible = true;
      bank.userData.viewActive = true;
    }
    engine.debugRenderDofFrame();
    engine.renderer.render(engine.scene, engine.camera);
    window.__moonCloudResources = {
      programs: engine.renderer.info.programs?.length ?? 0,
      geometries: engine.renderer.info.memory.geometries,
      textures: engine.renderer.info.memory.textures,
    };
  });

  async function captureMoonCloud(alpha, name, scatteredVisible = true) {
    await page.evaluate(({ opacity, showScattered }) => {
      const engine = window.__engine;
      const moon = engine.scene.getObjectByName('moon');
      const bank = engine.village.exportRoot()?.getObjectByName('horizon-cloud-bank');
      const scattered = moon?.getObjectByName('moon-corona-scattered');
      if (bank) bank.material.opacity = opacity;
      if (scattered) scattered.visible = showScattered;
      engine.renderer.render(engine.scene, engine.camera);
    }, { opacity: alpha, showScattered: scatteredVisible });
    const path = join(outDir, `${name}.png`);
    await page.screenshot({ path });
    return { path, png: PNG.sync.read(await readFile(path)) };
  }

  const cloudClear = await captureMoonCloud(0, 'moon-cloud-clear');
  const cloudHalf = await captureMoonCloud(0.5, 'moon-cloud-half');
  const cloudOpaque = await captureMoonCloud(1, 'moon-cloud-opaque');
  const cloudOpaqueNoScatter = await captureMoonCloud(1, 'moon-cloud-opaque-no-scatter', false);
  const cloudHalfReverse = await captureMoonCloud(0.5, 'moon-cloud-half-reverse');
  const cloudClearReverse = await captureMoonCloud(0, 'moon-cloud-clear-reverse');
  const expectedHeroDisc = projectedAngularDiameterPixels(
    MOON_ANGULAR_DIAMETER_DEG,
    7,
    cloudClear.png.height,
  );
  const coreRadius = expectedHeroDisc * 0.20;
  const coreLuminance = [cloudClear, cloudHalf, cloudOpaque]
    .map(({ png }) => meanDiscLuminance(png, coreRadius));
  const halfReverseLuminance = meanDiscLuminance(cloudHalfReverse.png, coreRadius);
  const clearReverseLuminance = meanDiscLuminance(cloudClearReverse.png, coreRadius);
  pass(coreLuminance[0] > coreLuminance[1] && coreLuminance[1] > coreLuminance[2],
    'real cloud alpha continuously attenuates the direct lunar disc',
    `core=${coreLuminance.map((value) => value.toFixed(1)).join('→')}`);
  pass(coreLuminance[2] < coreLuminance[0] * 0.85,
    'maximum-density textured cloud materially attenuates the lunar core',
    `clear=${coreLuminance[0].toFixed(1)} dense=${coreLuminance[2].toFixed(1)}`);
  pass(Math.abs(coreLuminance[1] - halfReverseLuminance) <= 2
      && Math.abs(coreLuminance[0] - clearReverseLuminance) <= 2,
    'forward and reverse cloud-opacity sweeps are visually stable',
    `half Δ=${Math.abs(coreLuminance[1] - halfReverseLuminance).toFixed(2)}, clear Δ=${Math.abs(coreLuminance[0] - clearReverseLuminance).toFixed(2)}`);
  const annulusInner = expectedHeroDisc * 0.55;
  const annulusOuter = expectedHeroDisc * 0.90;
  const opaqueCorona = meanAnnulusLuminance(cloudOpaque.png, annulusInner, annulusOuter);
  const opaqueNoScatter = meanAnnulusLuminance(
    cloudOpaqueNoScatter.png,
    annulusInner,
    annulusOuter,
  );
  pass(opaqueCorona - opaqueNoScatter > 0.2,
    'a faint scattered corona survives maximum cloud-density attenuation',
    `annulus Δ=${(opaqueCorona - opaqueNoScatter).toFixed(2)}`);

  async function captureComposedMoonCloud(alpha) {
    await page.evaluate((opacity) => {
      const engine = window.__engine;
      const moon = engine.scene.getObjectByName('moon');
      const bank = engine.village.exportRoot()?.getObjectByName('horizon-cloud-bank');
      const scattered = moon?.getObjectByName('moon-corona-scattered');
      if (bank) bank.material.opacity = opacity;
      if (scattered) scattered.visible = true;
      engine.debugRenderDofFrame();
    }, alpha);
    const suffix = String(Math.round(alpha * 100)).padStart(3, '0');
    const path = join(outDir, `moon-cloud-product-${suffix}.png`);
    await page.screenshot({ path });
    return { alpha, path, png: PNG.sync.read(await readFile(path)) };
  }
  const composedAlphas = [
    0, 0.05, 0.10, 0.15, 0.20, 0.25, 0.30, 0.35, 0.40, 0.45, 0.50,
    0.55, 0.60, 0.65, 0.70, 0.72, 0.73, 0.74, 0.75, 0.80, 0.85, 0.90, 0.95, 1,
  ];
  const composedSweep = [];
  for (const alpha of composedAlphas) composedSweep.push(await captureComposedMoonCloud(alpha));
  const composedCore = composedSweep.map(({ png }) => meanDiscLuminance(png, coreRadius));
  const uniformComposedCore = composedAlphas
    .map((alpha, index) => ({ alpha, value: composedCore[index] }))
    .filter(({ alpha }) => Math.abs(alpha * 20 - Math.round(alpha * 20)) < 1e-9);
  const composedDrops = uniformComposedCore.slice(1).map(({ value }, index) => (
    uniformComposedCore[index].value - value
  ));
  const composedDropChanges = composedDrops.slice(1).map((value, index) => (
    Math.abs(value - composedDrops[index])
  ));
  const composedTotalDrop = Math.max(
    1e-6,
    uniformComposedCore[0].value - uniformComposedCore.at(-1).value,
  );
  pass(composedCore.every((value, index) => index === 0 || value <= composedCore[index - 1] + 0.5),
    'the product DoF+bloom stack attenuates a clouded Moon monotonically');
  pass(Math.max(...composedDrops) / composedTotalDrop < 0.25
      && Math.max(...composedDropChanges) / composedTotalDrop < 0.15,
    'the night bloom soft knee prevents a discontinuous source pop during cloud transit',
    `max step/total=${(Math.max(...composedDrops) / composedTotalDrop).toFixed(3)}, `
      + `max slope change/total=${(Math.max(...composedDropChanges) / composedTotalDrop).toFixed(3)}`);

  const moonCloudResources = await page.evaluate(() => {
    const engine = window.__engine;
    const moon = engine.scene.getObjectByName('moon');
    const clouds = engine.village.exportRoot()?.getObjectByName('clouds');
    const bank = clouds?.getObjectByName('horizon-cloud-bank');
    const highs = [];
    const rays = [];
    clouds?.traverse((object) => {
      if (object.name?.startsWith('high-cloud-')) highs.push(object);
      if (object.name?.startsWith('cloud-light-ray-')) rays.push(object);
    });
    const restore = window.__moonCloudRestore;
    if (bank && restore?.matrices) {
      bank.instanceMatrix.array.set(restore.matrices);
      bank.instanceMatrix.needsUpdate = true;
      bank.visible = restore.bankVisible;
      bank.userData.viewActive = restore.bankViewActive;
      bank.material.opacity = restore.bankOpacity;
    }
    highs.forEach((object, index) => { object.visible = restore?.highVisible[index]; });
    rays.forEach((object, index) => { object.visible = restore?.rayVisible[index]; });
    const opticsRestore = window.__moonOpticsRestore;
    if (opticsRestore) {
      engine.camera.fov = opticsRestore.fov;
      engine.camera.position.copy(opticsRestore.position);
      engine.camera.updateProjectionMatrix();
      engine.camera.userData.villageReferenceFov = opticsRestore.referenceFov;
      engine.__controls.target.copy(opticsRestore.target);
      engine.camera.lookAt(opticsRestore.target);
      engine.camera.updateMatrixWorld(true);
      if (clouds) clouds.visible = opticsRestore.cloudsVisible;
      const transmitted = moon?.getObjectByName('moon-corona-transmitted');
      const scattered = moon?.getObjectByName('moon-corona-scattered');
      if (transmitted) transmitted.visible = opticsRestore.transmittedVisible;
      if (scattered) scattered.visible = opticsRestore.scatteredVisible;
    }
    engine.renderer.render(engine.scene, engine.camera);
    const after = {
      programs: engine.renderer.info.programs?.length ?? 0,
      geometries: engine.renderer.info.memory.geometries,
      textures: engine.renderer.info.memory.textures,
    };
    engine.debugRenderDofFrame();
    return { before: window.__moonCloudResources, after };
  });
  pass(JSON.stringify(moonCloudResources.before) === JSON.stringify(moonCloudResources.after),
    'cloud-opacity sweep stays on the warmed resource plateau',
    `${JSON.stringify(moonCloudResources.before)}→${JSON.stringify(moonCloudResources.after)}`);

  await page.locator('[data-reference-trigger="info"]').click();
  const moonReference = page.locator('[data-reference-topic="moon-optics"]');
  await moonReference.waitFor({ state: 'visible', timeout: 10_000 });
  const referenceState = await moonReference.evaluate((item) => ({
    title: item.querySelector('[data-reference-field="title"]')?.textContent || '',
    application: item.querySelector('[data-reference-field="application"]')?.textContent || '',
    license: item.querySelector('[data-reference-field="license"]')?.textContent || '',
    links: [...item.querySelectorAll('[data-reference-field="sources"] a')].map((link) => ({
      href: link.href,
      target: link.target,
      rel: link.rel,
    })),
  }));
  pass(referenceState.title.includes('NASA · WMO · Applied Optics')
      && referenceState.application.includes('0.52°')
      && referenceState.application.includes('22° halo')
      && referenceState.license.includes('원문 문장·사진·도표는 복제하지 않고'),
    'References #46 exposes the Moon evidence, product translation, limits, and license');
  pass(referenceState.links.length === 7
      && referenceState.links.every((link) => (
        link.href.startsWith('https://')
        && link.target === '_blank'
        && link.rel.split(/\s+/).includes('noopener')
        && link.rel.split(/\s+/).includes('noreferrer')
      )),
    'References #46 renders all canonical sources as safe external links',
    `links=${referenceState.links.length}`);
  await page.locator('.modal .x').click();

  await page.evaluate(() => window.__engine.debugSetPaused(false));
  pass(errors.length === 0, 'browser console and page errors remain empty', errors.slice(0, 4).join(' | '));

  console.log(`SKY SHOTS: ${outDir}`);
  console.log([
    gold.path, crimson.path, violet.path, day.path, night.path, moonFramedPath,
    ...projectionPaths.map(({ path }) => path),
    cloudClear.path, cloudHalf.path, cloudOpaque.path,
    ...composedSweep.filter(({ alpha }) => [0, 0.5, 1].includes(alpha)).map(({ path }) => path),
  ].join('\n'));
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
