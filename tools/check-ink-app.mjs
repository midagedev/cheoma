import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PNG } from 'pngjs';
import { createServer } from '../app/node_modules/vite/dist/node/index.js';
import { launchVerificationBrowser, reportWebGLRenderer } from './lib/verification-browser.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const APP_ROOT = join(ROOT, 'app');
const cacheDir = await mkdtemp(join(tmpdir(), 'cheoma-ink-cache-'));
const shotDir = await mkdtemp(join(tmpdir(), 'cheoma-ink-shots-'));
const timeout = Number(process.env.CHEOMA_INK_TIMEOUT_MS) || 90_000;
const failures = [];
const pass = (condition, message, detail = '') => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${message}${detail ? ` (${detail})` : ''}`);
  if (!condition) failures.push(message);
};

function imageStats(buffer) {
  const png = PNG.sync.read(buffer);
  let luma = 0, chroma = 0, dark = 0, light = 0, count = 0;
  for (let y = 0; y < png.height; y += 3) for (let x = 0; x < png.width; x += 3) {
    const i = (y * png.width + x) * 4;
    const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2];
    const v = 0.299 * r + 0.587 * g + 0.114 * b;
    luma += v;
    chroma += Math.max(r, g, b) - Math.min(r, g, b);
    dark += v < 82 ? 1 : 0;
    light += v > 175 ? 1 : 0;
    count++;
  }
  return { luma: luma / count, chroma: chroma / count, dark: dark / count, light: light / count };
}

function meanDifference(aBuffer, bBuffer) {
  const a = PNG.sync.read(aBuffer), b = PNG.sync.read(bBuffer);
  let sum = 0, count = 0;
  for (let y = 0; y < Math.min(a.height, b.height); y += 3) {
    for (let x = 0; x < Math.min(a.width, b.width); x += 3) {
      const i = (y * a.width + x) * 4;
      const j = (y * b.width + x) * 4;
      sum += Math.abs(a.data[i] - b.data[j])
        + Math.abs(a.data[i + 1] - b.data[j + 1])
        + Math.abs(a.data[i + 2] - b.data[j + 2]);
      count += 3;
    }
  }
  return sum / count;
}

async function captureScene(page, name) {
  await page.evaluate(() => document.body.classList.add('ink-scene-capture'));
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const buffer = await page.locator('canvas').screenshot({ path: join(shotDir, name) });
  await page.evaluate(() => document.body.classList.remove('ink-scene-capture'));
  return buffer;
}

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
  const base = `http://127.0.0.1:${port}/?hero=0&village=1&worker=0&vscale=hamlet&seed=42&vseed=20260716&time=day&season=summer&weather=clear&shot=1&lang=ko`;
  browser = await launchVerificationBrowser();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (error) => runtimeErrors.push(`page: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' && !/favicon|404/i.test(message.text())) runtimeErrors.push(`console: ${message.text()}`);
  });
  await page.goto(base, { waitUntil: 'domcontentloaded', timeout });
  await page.waitForFunction(() => window.__SHOT_READY === true && !!window.__engine?.village?.debugPlan?.(), null, { timeout });
  await reportWebGLRenderer(page, 'ink-app');
  await page.addStyleTag({
    content: [
      'body.ink-scene-capture * { visibility: hidden !important; opacity: 0 !important; }',
      'body.ink-scene-capture #app, body.ink-scene-capture .stage,',
      'body.ink-scene-capture .stage canvas { visibility: visible !important; opacity: 1 !important; }',
    ].join(' '),
  });
  await page.evaluate(() => {
    const engine = window.__engine;
    if (engine.debugDof().tweenProgress != null) engine.debugDofSeek(1, { finish: true });
  });
  await page.waitForTimeout(400);

  const initial = await page.evaluate(() => ({
    state: window.__engine.getState(),
    ink: window.__engine.debugInk(),
    passes: window.__engine.debugPostPassOrder(),
    sceneCalls: window.__engine.village.debugDrawCalls(),
    programs: window.__engine.renderer.info.programs?.length || 0,
    url: location.search,
    buttons: [...document.querySelectorAll('.render-style button')].map((button) => ({
      text: button.textContent.replace(/\s+/g, ' ').trim(),
      pressed: button.getAttribute('aria-pressed'),
      title: button.title,
    })),
  }));
  const pbrPng = await captureScene(page, 'pbr-aerial.png');
  pass(initial.state.renderStyle === 'pbr' && !initial.ink.created, 'default PBR path is lazy and pays no ink setup cost');
  pass(!initial.url.includes('mode='), 'default PBR URL stays canonical');
  pass(initial.buttons.length === 2 && initial.buttons[0].pressed === 'true' && initial.buttons[1].pressed === 'false',
    'render-style control exposes a two-state pressed contract');

  // Native keyboard activation is the actual product path; no debug setter is used here.
  await page.locator('.render-style button:last-child').focus();
  await page.keyboard.press('Enter');
  const transitionSamples = [];
  for (let i = 0; i < 7; i++) {
    await page.waitForTimeout(130);
    transitionSamples.push(await page.evaluate(() => window.__engine.debugInk().amount));
  }
  await page.waitForFunction(() => window.__engine.debugInk().amount >= 0.999, null, { timeout });
  const inkState = await page.evaluate(async () => {
    const state = window.__engine.getState();
    const { shareUrl } = await import('/src/lib/url.js');
    return {
      state,
      ink: window.__engine.debugInk(),
      passes: window.__engine.debugPostPassOrder(),
      programs: window.__engine.renderer.info.programs?.length || 0,
      url: location.search,
      shared: shareUrl(state, {}),
      active: document.querySelector('.render-style button:last-child')?.getAttribute('aria-pressed'),
      outputLast: window.__engine.debugPostPassOrder().at(-1),
    };
  });
  await page.screenshot({ path: join(shotDir, 'ink-ui.png') });
  const inkPng = await captureScene(page, 'ink-aerial.png');
  const pbrStats = imageStats(pbrPng), inkStats = imageStats(inkPng), difference = meanDifference(pbrPng, inkPng);

  pass(transitionSamples.every((value, i) => i === 0 || value + 1e-4 >= transitionSamples[i - 1]),
    'PBR→ink mix is monotonic', transitionSamples.map((v) => v.toFixed(2)).join('→'));
  pass(inkState.state.renderStyle === 'ink' && inkState.active === 'true'
    && inkState.url.includes('mode=ink') && inkState.shared.includes('mode=ink'),
  'keyboard toggle synchronizes engine, accessible UI, live URL, and share URL');
  pass(inkState.outputLast === 'OutputPass' && inkState.passes.at(-2) === 'InkPass',
    'ink remains inside the unified composer immediately before the one OutputPass', inkState.passes.join(' → '));
  pass(!Object.values(inkState.ink.pbrPasses).some(Boolean),
    'fully covered ink mode sleeps grade, bloom, DoF, and flare', JSON.stringify(inkState.ink.pbrPasses));
  pass(inkState.programs - initial.programs <= 5,
    'ink shader vocabulary keeps program growth bounded', `programs ${initial.programs}→${inkState.programs}`);
  pass(inkState.ink.normalScale <= 0.75 && inkState.ink.normalExcluded > 0 && inkState.ink.normalDithered > 0,
    'normal/depth work is reduced-resolution, excludes atmosphere, and preserves instFade holes',
    `scale=${inkState.ink.normalScale} excluded=${inkState.ink.normalExcluded} dithered=${inkState.ink.normalDithered} calls=${inkState.ink.normalDrawCalls}`);
  pass(inkState.ink.normalDrawCalls > 0 && inkState.ink.normalDrawCalls <= initial.sceneCalls,
    'reduced normal pass stays within the opaque scene draw budget',
    `normal=${inkState.ink.normalDrawCalls} scene=${initial.sceneCalls}`);
  pass(difference > 28 && inkStats.chroma < pbrStats.chroma * 0.65,
    'ink frame is visually distinct and substantially desaturated',
    `diff=${difference.toFixed(1)} chroma ${pbrStats.chroma.toFixed(1)}→${inkStats.chroma.toFixed(1)}`);
  pass(inkStats.dark > 0.025 && inkStats.light > 0.08 && inkStats.luma > 105 && inkStats.luma < 225,
    'ink frame preserves 농묵, readable midtones, and paper 여백 instead of flattening',
    `luma=${inkStats.luma.toFixed(1)} dark=${(inkStats.dark * 100).toFixed(1)}% light=${(inkStats.light * 100).toFixed(1)}%`);

  // The same ink state must survive the product's telephoto house transition. This capture is
  // intentionally separate from the aerial statistics so both landscape and architecture can be reviewed.
  const focusState = await page.evaluate(async () => {
    window.__noWarm = true;
    const engine = window.__engine;
    const parcelId = engine.village.debugParcels().find((parcel) => parcel.editable && !parcel.hero)?.parcelId;
    if (!parcelId) throw new Error('ink focus fixture has no regular editable parcel');
    engine.village.focus(parcelId);
    for (let i = 0; i < 4; i++) await Promise.resolve();
    const sample = engine.debugDofSeek(1, { finish: true });
    await new Promise((resolve) => {
      let frames = 12;
      const step = () => (--frames <= 0 ? resolve() : requestAnimationFrame(step));
      requestAnimationFrame(step);
    });
    return { sample: !!sample, selected: engine.village.getState().selected, ink: engine.debugInk() };
  });
  await captureScene(page, 'ink-focus.png');
  pass(focusState.sample && !!focusState.selected && focusState.ink.amount >= 0.999,
    'telephoto house focus preserves fully covered ink policy');

  await page.evaluate(() => document.querySelector('.render-style button:first-child')?.focus());
  await page.keyboard.press('Space');
  await page.waitForFunction(() => window.__engine.debugInk().amount <= 0.001, null, { timeout });
  const restored = await page.evaluate(() => ({
    state: window.__engine.getState(),
    ink: window.__engine.debugInk(),
    url: location.search,
    output: window.__engine.debugPostPassOrder().at(-1),
  }));
  pass(restored.state.renderStyle === 'pbr' && restored.ink.pbrAwake && !restored.url.includes('mode='),
    'Space-key return restores PBR policy and removes the default URL token');
  pass(restored.output === 'OutputPass', 'PBR return keeps OutputPass last');

  // A shared ink URL must restore before the first product-ready frame rather than flash PBR.
  await page.goto(`${base}&mode=ink`, { waitUntil: 'domcontentloaded', timeout });
  await page.waitForFunction(() => window.__SHOT_READY === true && window.__engine?.debugInk?.().amount >= 0.999, null, { timeout });
  const restoredInk = await page.evaluate(() => ({ state: window.__engine.getState(), ink: window.__engine.debugInk() }));
  pass(restoredInk.state.renderStyle === 'ink' && !restoredInk.ink.transitioning,
    'mode=ink URL restores atomically before the ready frame');

  const mobile = await browser.newPage({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  });
  await mobile.goto(`${base}&mode=ink`, { waitUntil: 'domcontentloaded', timeout });
  await mobile.waitForFunction(() => window.__SHOT_READY === true && !!window.__engine, null, { timeout });
  const mobileUi = await mobile.evaluate(() => {
    const group = document.querySelector('.render-style');
    const buttons = [...group.querySelectorAll('button')];
    const rect = group.getBoundingClientRect();
    return {
      inside: rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
      heights: buttons.map((button) => button.getBoundingClientRect().height),
      pressed: buttons.map((button) => button.getAttribute('aria-pressed')),
      normalScale: window.__engine.debugInk().normalScale,
    };
  });
  pass(mobileUi.inside && mobileUi.heights.every((height) => height >= 44),
    'mobile control stays on-screen with 44px touch targets', JSON.stringify(mobileUi));
  pass(mobileUi.pressed[1] === 'true', 'mobile shared URL exposes the restored ink state');
  pass(mobileUi.normalScale <= 0.5, 'compact ink uses a half-resolution normal target');
  await mobile.close();

  pass(runtimeErrors.length === 0, 'ink rendering emits no runtime or shader errors', runtimeErrors.join(' | '));
  if (failures.length) throw new Error(`ink app failed: ${failures.join('; ')}`);
  console.log(`INK APP: PASS (temporary visual evidence ${shotDir})`);
} finally {
  await browser?.close();
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
}
