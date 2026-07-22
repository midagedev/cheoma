// One focused full-app contract for the two user-facing dancheong controls.
// The faster standalone gate owns texture/perf/export coverage; this only proves
// that Svelte routes real input changes through the public village rebuild API.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from '../app/node_modules/vite/dist/node/index.js';
import { launchVerificationBrowser, reportWebGLRenderer } from './lib/verification-browser.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const APP_ROOT = join(ROOT, 'app');
const cacheDir = await mkdtemp(join(tmpdir(), 'cheoma-dancheong-app-'));
const timeout = 120_000;
const invariant = (condition, message) => {
  if (!condition) throw new Error(message);
};

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
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (error) => errors.push(`page: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' && !/favicon|404/i.test(message.text())) {
      errors.push(`console: ${message.text()}`);
    }
  });

  const url = `http://127.0.0.1:${port}/?hero=0&village=1&worker=0&seed=42&vseed=20260716&vtemple=1&time=day&lang=ko`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
  await page.waitForFunction(() => window.__SHOT_READY === true && !!window.__engine?.village?.debugPlan(), null, { timeout });
  const templeAvailable = await page.evaluate(() => (
    window.__engine.village.debugParcels().some((parcel) => parcel.parcelId === 'temple' && parcel.editable)
  ));
  invariant(templeAvailable, 'fixture has no editable temple landmark');

  await page.evaluate(() => window.__engine.village.debugFocus('temple'));
  await page.waitForFunction(() => {
    const state = window.__engine.village.getState();
    return state.selected === 'temple' && !state.transitioning;
  }, null, { timeout });

  const result = await page.evaluate(() => {
    const engine = window.__engine;
    const clarity = document.querySelector('.ctx.house:not([aria-hidden="true"]) input[data-key="dancheongClarity"]');
    const splendor = document.querySelector('.ctx.house:not([aria-hidden="true"]) input[data-key="dancheongSplendor"]');
    if (!clarity || !splendor) return null;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    const original = engine.village.rebuild.bind(engine.village);
    const calls = [];
    engine.village.rebuild = (...args) => {
      calls.push(structuredClone(args[1]));
      return original(...args);
    };
    const change = (input, value) => {
      setValue.call(input, String(value));
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    };
    change(clarity, 0.14);
    change(splendor, 0.96);

    const focus = engine.village.focusRoot();
    const grades = {};
    focus?.traverse?.((object) => {
      const grade = object.userData?.materials?.dancheong?.grade;
      if (grade && object.name?.startsWith('temple-')) grades[object.name] = grade;
    });
    const spec = engine.village.getState().spec;
    return {
      controls: [
        clarity.closest('label')?.querySelector('.rl')?.textContent?.trim(),
        splendor.closest('label')?.querySelector('.rl')?.textContent?.trim(),
      ],
      calls,
      params: spec?.params,
      grades,
    };
  });

  invariant(result, 'temple panel did not render both dancheong controls');
  invariant(result.controls[0] === '단청 선명도' && result.controls[1] === '단청 화려함',
    `localized control labels drifted: ${result.controls.join(' / ')}`);
  invariant(result.calls.length === 2
    && result.calls.every((payload) => payload?.templeOptions),
  `panel bypassed public templeOptions rebuild: ${JSON.stringify(result.calls)}`);
  invariant(result.calls.at(-1).templeOptions.dancheongClarity === 0.14
    && result.calls.at(-1).templeOptions.dancheongSplendor === 0.96,
  `panel values did not survive successive regeneration: ${JSON.stringify(result.calls.at(-1))}`);
  invariant(result.params.dancheongClarity === 0.14 && result.params.dancheongSplendor === 0.96,
    `runtime spec and panel diverged: ${JSON.stringify(result.params)}`);
  invariant(result.grades['temple-main-hall'] === 'geum',
    `regenerated main hall lost its intended rank: ${JSON.stringify(result.grades)}`);

  // Research is part of the product trust surface, not only a repository note.
  // docs/credits.md is parsed into the live ReferenceModal, so this proves the
  // authoritative dancheong sources and their implementation mapping are visible.
  await page.locator('.seal-label .info').click();
  const credit = page.locator('.modal .cat li').filter({
    hasText: '국가유산청 · 국립문화유산연구원 — 단청 위계와 궁궐·사찰 안료 조사',
  });
  await credit.waitFor({ state: 'visible', timeout });
  invariant(await credit.locator('a').count() === 4,
    'Reference UI did not expose all four authoritative dancheong links');
  invariant((await credit.locator('.it-use').textContent())?.includes('궁 기본 모로'),
    'Reference UI lost the source-to-implementation mapping');

  await reportWebGLRenderer(page, 'dancheong-app');
  invariant(errors.length === 0, errors.join(' | '));
  console.log('DANCHEONG APP: PASS (localized controls -> public templeOptions -> real compound regeneration)');
} finally {
  await browser?.close();
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
}
