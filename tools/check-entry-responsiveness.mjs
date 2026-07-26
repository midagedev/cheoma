// Entry responsiveness contract (#16, docs/ui-design.md §4.8).
//
// The hero title is the first surface a visitor touches, and it had no gate at all:
// check-app-smoke.mjs boots with ?hero=0 and the only harness that clicks `.hero`
// needs a dist-entry build that does not exist. That gap is why "press 들어가기 and
// nothing happens for seconds" shipped twice.
//
// This gate is deliberately an EVENT-ORDERING contract, not a performance benchmark:
//   · the click handler must not do the heavy work itself (a synchronous village build
//     inside the handler makes a paint impossible, whatever the machine speed),
//   · the browser must be able to run a frame right after the press,
//   · the title must stay on screen with an explicit progress affordance until the
//     scene is ready — never a blank window, never a dead button.
//
// Measured before the fix (chromium): syncHandler 811ms, first rAF after the click
// 3159ms, 2 frames in 6s. The budgets below are structural, with wide headroom, so a
// slow machine cannot fail them but a re-regressed architecture will.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from '../app/node_modules/vite/dist/node/index.js';
import { launchVerificationBrowser } from './lib/verification-browser.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const cacheDir = await mkdtemp(join(tmpdir(), 'cheoma-entry-'));
const timeout = Number(process.env.CHEOMA_ENTRY_TIMEOUT_MS) || 120_000;

// Structural budgets. Generous on purpose — they catch "the handler builds the village"
// and "the main thread cannot paint", not frame throughput.
const MAX_SYNC_HANDLER_MS = 150;
const MAX_FIRST_FRAME_MS = 600;

const PROFILES = [
  { id: 'desktop', width: 1280, height: 800, touch: false },
  { id: 'phone', width: 390, height: 844, touch: true },
];

const failures = [];
const pass = (condition, message) => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${message}`);
  if (!condition) failures.push(message);
};

const server = await createServer({
  root: join(ROOT, 'app'),
  configFile: join(ROOT, 'app', 'vite.config.js'),
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

  for (const profile of PROFILES) {
    // "early" is the case that matters: the visitor presses before the village preload
    // has landed. A handler that builds synchronously freezes exactly here.
    const context = await browser.newContext({
      viewport: { width: profile.width, height: profile.height },
      hasTouch: profile.touch, isMobile: profile.touch, deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    page.on('pageerror', (error) => runtimeErrors.push(`page: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error' && !/favicon|404/i.test(message.text())) {
        runtimeErrors.push(`console: ${message.text()}`);
      }
    });
    await page.goto(`http://127.0.0.1:${port}/?seed=42&vseed=20260716&lang=ko`,
      { waitUntil: 'domcontentloaded', timeout });
    await page.waitForSelector('.hero', { timeout });

    const probe = await page.evaluate(() => new Promise((resolveProbe) => {
      const hero = document.querySelector('.hero');
      const marks = { firstFrame: null, busyAtFirstFrame: null, heroPresentAtFirstFrame: null };
      const readBusy = () => {
        const title = document.querySelector('.hero');
        return {
          present: !!title,
          busy: title?.getAttribute('aria-busy') === 'true',
          progress: !!document.querySelector('[data-entry-progress]'),
        };
      };
      const t0 = performance.now();
      requestAnimationFrame(() => {
        marks.firstFrame = performance.now() - t0;
        const state = readBusy();
        marks.busyAtFirstFrame = state.busy;
        marks.heroPresentAtFirstFrame = state.present;
        marks.progressAtFirstFrame = state.progress;
        resolveProbe(marks);
      });
      const clickAt = performance.now();
      hero.click();
      marks.syncHandler = performance.now() - clickAt;
    }));

    pass(probe.syncHandler <= MAX_SYNC_HANDLER_MS,
      `${profile.id} press returns the main thread immediately — the handler must not build the scene (${Math.round(probe.syncHandler)}ms <= ${MAX_SYNC_HANDLER_MS}ms)`);
    pass(probe.firstFrame != null && probe.firstFrame <= MAX_FIRST_FRAME_MS,
      `${profile.id} the browser can render a frame right after the press (${probe.firstFrame == null ? 'never' : Math.round(probe.firstFrame) + 'ms'} <= ${MAX_FIRST_FRAME_MS}ms)`);
    pass(probe.heroPresentAtFirstFrame === true,
      `${profile.id} the title stays on screen while the scene is not ready (no blank window)`);
    pass(probe.busyAtFirstFrame === true,
      `${profile.id} the press is acknowledged on the first rendered frame (aria-busy)`);
    pass(probe.progressAtFirstFrame === true,
      `${profile.id} an explicit progress affordance is present while waiting ([data-entry-progress])`);

    // The wait must actually end: the village becomes active and the title retires.
    const reached = await page.waitForFunction(
      () => !!window.__engine?.village?.getState?.().active,
      null, { timeout },
    ).then(() => true, () => false);
    pass(reached, `${profile.id} the entry completes and the village becomes active`);
    const retired = await page.waitForFunction(
      () => !document.querySelector('.hero'),
      null, { timeout },
    ).then(() => true, () => false);
    pass(retired, `${profile.id} the title retires once the scene owns the frame`);

    await page.close();
    await context.close();
  }

  pass(runtimeErrors.length === 0, `browser reports no runtime errors (${runtimeErrors.length})`);
  if (runtimeErrors.length) console.log(runtimeErrors.slice(0, 5).join('\n'));
} catch (error) {
  failures.push(error.message);
  console.error(error.stack || error);
} finally {
  await browser?.close();
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
}

console.log(failures.length ? `\nENTRY RESPONSIVENESS: ${failures.length} FAIL` : '\nENTRY RESPONSIVENESS: PASS');
process.exit(failures.length ? 1 : 0);
