import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PNG } from 'pngjs';
import { createServer } from '../app/node_modules/vite/dist/node/index.js';
import { launchVerificationBrowser, reportWebGLRenderer } from './lib/verification-browser.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const APP_ROOT = join(ROOT, 'app');
const cacheDir = await mkdtemp(join(tmpdir(), 'cheoma-winter-cache-'));
const shotDir = await mkdtemp(join(tmpdir(), 'cheoma-winter-shots-'));
const timeout = Number(process.env.CHEOMA_WINTER_TIMEOUT_MS) || 90_000;
const failures = [];
const pass = (condition, message, detail = '') => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${message}${detail ? ` (${detail})` : ''}`);
  if (!condition) failures.push(message);
};
const luma = (buffer) => {
  const png = PNG.sync.read(buffer);
  let sum = 0, count = 0;
  for (let y = 0; y < png.height; y += 3) for (let x = 0; x < png.width; x += 3) {
    const i = (y * png.width + x) * 4;
    sum += 0.299 * png.data[i] + 0.587 * png.data[i + 1] + 0.114 * png.data[i + 2];
    count++;
  }
  return sum / count;
};

const server = await createServer({
  root: APP_ROOT,
  configFile: join(APP_ROOT, 'vite.config.js'),
  cacheDir,
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false },
});

let browser;
const runtimeErrors = [];
try {
  await server.listen();
  const port = server.httpServer.address().port;
  browser = await launchVerificationBrowser();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (error) => runtimeErrors.push(`page: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' && !/favicon|404/i.test(message.text())) runtimeErrors.push(`console: ${message.text()}`);
  });

  await page.goto(
    `http://127.0.0.1:${port}/?hero=0&village=1&worker=0&vscale=hamlet&seed=7&vseed=2420175776&time=day&season=winter&weather=clear&shot=1`,
    { waitUntil: 'domcontentloaded', timeout },
  );
  await page.waitForFunction(() => window.__SHOT_READY === true && !!window.__engine?.village?.debugPlan?.(), null, { timeout });
  await reportWebGLRenderer(page, 'winter-app');
  const clear = await page.evaluate(async () => {
    const engine = window.__engine;
    if (engine.debugDof().tweenProgress != null) engine.debugDofSeek(1, { finish: true });
    const frames = (count = 48) => new Promise((resolveFrame) => {
      const step = () => (--count <= 0 ? resolveFrame() : requestAnimationFrame(step));
      requestAnimationFrame(step);
    });
    await frames();
    return {
      state: engine.getState(),
      calls: engine.village.debugDrawCalls(),
      programs: engine.renderer.info.programs?.length || 0,
    };
  });
  const clearPng = await page.screenshot({ path: join(shotDir, 'winter-clear.png') });

  const immediate = await page.evaluate(() => {
    const engine = window.__engine;
    const root = engine.scene.children.find((object) => object.name.startsWith('village-') && !object.name.includes('light'));
    const villageSnow = () => root?.userData?.getSnowInfo?.();
    engine.setWeather('snow');
    const smoothSnow = { village: villageSnow(), global: { snow: window.__wx?.snow, accum: window.__wx?.accum } };
    engine.setWeather('clear', { immediate: true });
    const clearNow = { village: villageSnow(), global: { snow: window.__wx?.snow, accum: window.__wx?.accum } };
    engine.setWeather('snow', { immediate: true, accum: 0.35 });
    const snowNow = { village: villageSnow(), global: { snow: window.__wx?.snow, accum: window.__wx?.accum } };
    engine.setWeather('clear', { immediate: true });
    return { smoothSnow, clearNow, snowNow };
  });

  const snow = await page.evaluate(async () => {
    const engine = window.__engine;
    engine.setWeather('snow');
    const root = engine.scene.children.find((object) => object.name.startsWith('village-') && !object.name.includes('light'));
    root?.userData?.setSnowAccum?.(1);
    window.__wx?.setAccum?.(1);
    const frames = (count = 18) => new Promise((resolveFrame) => {
      const step = () => (--count <= 0 ? resolveFrame() : requestAnimationFrame(step));
      requestAnimationFrame(step);
    });
    await frames();
    const terrain = root?.getObjectByName('village-terrain');
    const forest = root?.getObjectByName('village-forest');
    const materials = new Set();
    const profiles = {};
    const roles = {};
    root?.traverse((object) => {
      const list = Array.isArray(object.material) ? object.material : object.material ? [object.material] : [];
      for (const material of list) if (material.userData?.__snowPatched) {
        materials.add(material.uuid);
        const profile = material.userData.__snowProfile || 'unknown';
        const role = material.userData.role || 'none';
        profiles[profile] = (profiles[profile] || 0) + 1;
        roles[role] = (roles[role] || 0) + 1;
      }
    });
    return {
      state: engine.getState(),
      calls: engine.village.debugDrawCalls(),
      programs: engine.renderer.info.programs?.length || 0,
      patchedMaterials: materials.size,
      profiles,
      roles,
      terrainPatched: !!terrain?.material?.userData?.__snowPatched,
      forestPatched: !!forest && (() => {
        let found = false;
        forest.traverse((object) => { if (object.material?.userData?.__snowPatched) found = true; });
        return found;
      })(),
    };
  });
  const snowPng = await page.screenshot({ path: join(shotDir, 'winter-snow.png') });
  const clearLuma = luma(clearPng), snowLuma = luma(snowPng);

  pass(clear.state.season === 'winter' && clear.state.weather === 'clear', 'clear winter is a first-class stable state');
  pass(immediate.smoothSnow.village?.target === 1 && immediate.smoothSnow.village?.accum === 0,
    'ordinary village snow keeps the authored accumulation crossfade',
    JSON.stringify(immediate.smoothSnow));
  pass(immediate.clearNow.village?.accum === 0 && immediate.clearNow.global.snow === 0 && immediate.clearNow.global.accum === 0,
    'immediate clear synchronously resets village and global weather',
    JSON.stringify(immediate.clearNow));
  pass(immediate.snowNow.village?.accum === 0.35 && immediate.snowNow.global.snow === 1 && immediate.snowNow.global.accum === 0.35,
    'immediate snow synchronously forwards the requested accumulation to both runtimes',
    JSON.stringify(immediate.snowNow));
  pass(snow.state.season === 'winter' && snow.state.weather === 'snow', 'snow remains coherently coupled to winter');
  pass(snow.terrainPatched && snow.forestPatched, 'village terrain and forest consume the shared accumulation shader');
  const requiredProfiles = ['tile', 'thatch', 'terrain', 'foliage'];
  pass(requiredProfiles.every((profile) => snow.profiles[profile] > 0),
    'snow reaches tiled and thatched roofs, terrain, vegetation, and exterior props',
    `materials=${snow.patchedMaterials} profiles=${JSON.stringify(snow.profiles)} roles=${JSON.stringify(snow.roles)}`);
  pass(snow.calls - clear.calls <= 1, 'snow surface coverage adds no geometry-heavy draw path', `calls ${clear.calls}→${snow.calls}`);
  pass(snow.programs - clear.programs <= 24, 'snow profiles keep shader program growth bounded', `programs ${clear.programs}→${snow.programs}`);
  pass(snowLuma > clearLuma + 8, 'snow is visibly distinct from clear winter', `luma ${clearLuma.toFixed(1)}→${snowLuma.toFixed(1)}`);
  pass(snowLuma < 210, 'snow scene retains tonal detail instead of clipping to white', `luma=${snowLuma.toFixed(1)}`);

  const transitions = await page.evaluate(() => {
    const engine = window.__engine;
    engine.setWeather('rain');
    const rain = engine.getState();
    engine.setSeason('winter');
    return { rain, winter: engine.getState() };
  });
  pass(transitions.rain.season === 'spring' && transitions.rain.weather === 'rain', 'winter rain resolves to spring rain');
  pass(transitions.winter.season === 'winter' && transitions.winter.weather === 'clear', 'changing to winter clears incompatible rain');
  pass(runtimeErrors.length === 0, 'winter rendering emits no runtime or shader errors', runtimeErrors.join(' | '));

  if (failures.length) throw new Error(`winter app failed: ${failures.join('; ')}`);
  console.log(`WINTER APP: PASS (temporary visual evidence ${shotDir})`);
} finally {
  await browser?.close();
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
}
