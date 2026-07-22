// One representative full-app reload proves the compact edit URL reaches the
// real Svelte control, persistent village overlay, focus camera, and runtime
// snapshot. No screenshot is needed: this is state/geometry ownership, not a
// pixel-look gate.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from '../app/node_modules/vite/dist/node/index.js';
import { launchVerificationBrowser } from './lib/verification-browser.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const APP_ROOT = join(ROOT, 'app');
const cacheDir = await mkdtemp(join(tmpdir(), 'cheoma-residential-edit-url-cache-'));
const timeout = Number(process.env.CHEOMA_RESIDENTIAL_EDIT_URL_TIMEOUT_MS) || 120_000;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
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
  const base = `http://127.0.0.1:${port}`;
  browser = await launchVerificationBrowser();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (error) => runtimeErrors.push(`page: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' && !/favicon|404/i.test(message.text())) {
      runtimeErrors.push(`console: ${message.text()}`);
    }
  });

  // The default product landing must stay terse until an edit exists.
  await page.goto(`${base}/?seed=42`, { waitUntil: 'domcontentloaded', timeout });
  await page.waitForFunction(() => !!window.__engine, null, { timeout });
  invariant(!new URL(page.url()).searchParams.has('village')
      && !new URL(page.url()).searchParams.has('vedit'),
    `default landing URL was expanded: ${page.url()}`);

  await page.goto(`${base}/?hero=0&village=1&worker=0&seed=42&vseed=7&time=day&lang=ko`, {
    waitUntil: 'domcontentloaded', timeout,
  });
  await page.waitForFunction(() => window.__SHOT_READY === true && !!window.__engine?.village?.debugPlan?.(), null, { timeout });
  await page.waitForFunction(() => typeof window.__engine.village.residentialOpeningEdits === 'function', null, { timeout });

  const parcelId = await page.evaluate(() => window.__engine.village.debugParcels()
    .find((parcel) => parcel.editable && !parcel.hero && parcel.kind === 'giwa')?.parcelId || null);
  invariant(parcelId, 'no regular giwa fixture was available');
  await page.evaluate((id) => window.__engine.village.focus(id), parcelId);
  await page.waitForFunction((id) => {
    const state = window.__engine.village.getState();
    return state.selected === id && !state.transitioning;
  }, parcelId, { timeout });

  // Home chooses a conspicuous, valid endpoint and uses the native input/change
  // path. The resulting snapshot must contain all six normalized fields.
  const height = page.locator('.ctx.house:not([aria-hidden="true"]) input[data-key="doorHeightK"]');
  await height.waitFor({ state: 'visible', timeout });
  await height.focus();
  await page.keyboard.press('Home');
  await page.waitForFunction((id) => {
    const edits = window.__engine.village.residentialOpeningEdits();
    return edits.length === 1 && edits[0].parcelId === id
      && Object.keys(edits[0].params).length === 6;
  }, parcelId, { timeout });
  await page.waitForFunction(() => {
    const q = new URLSearchParams(location.search);
    return q.get('village') === '1' && !!q.get('vedit');
  }, null, { timeout });

  const beforeReload = await page.evaluate(async () => {
    const { decodeResidentialEditState } = await import('/src/lib/residential-edit-url.js');
    const q = new URLSearchParams(location.search);
    return {
      url: location.href,
      edits: window.__engine.village.residentialOpeningEdits(),
      selected: window.__engine.village.getState().selected,
      decoded: decodeResidentialEditState(q.get('vedit')),
    };
  });
  invariant(beforeReload.selected === parcelId && beforeReload.decoded?.focusedParcelId === parcelId,
    `focused parcel was not encoded: ${JSON.stringify(beforeReload)}`);
  invariant(JSON.stringify(beforeReload.decoded.records) === JSON.stringify(beforeReload.edits),
    `URL/runtime snapshots differ before reload: ${JSON.stringify(beforeReload)}`);

  await page.reload({ waitUntil: 'domcontentloaded', timeout });
  await page.waitForFunction((expected) => {
    const engine = window.__engine;
    if (!engine?.village?.residentialOpeningEdits) return false;
    const state = engine.village.getState();
    return !state.transitioning && state.selected === expected.selected
      && JSON.stringify(engine.village.residentialOpeningEdits()) === JSON.stringify(expected.edits);
  }, { selected: beforeReload.selected, edits: beforeReload.edits }, { timeout });
  invariant(page.url() === beforeReload.url, `canonical edited URL drifted across reload:\n${beforeReload.url}\n${page.url()}`);

  const restored = await page.evaluate((id) => {
    const state = window.__engine.village.getState();
    const detail = window.__engine.village.debugParcelRebuild(id);
    return {
      selected: state.selected,
      params: detail?.params || null,
      persistent: detail?.persistent === true,
    };
  }, parcelId);
  invariant(restored.selected === parcelId && restored.persistent,
    `reload did not restore the persistent focused overlay: ${JSON.stringify(restored)}`);
  for (const [key, value] of Object.entries(beforeReload.edits[0].params)) {
    invariant(restored.params?.[key] === value, `reload changed ${key}: ${restored.params?.[key]} != ${value}`);
  }

  // An untrusted/truncated payload is ignored as a whole while the otherwise
  // valid explicit village still boots.
  await page.goto(`${base}/?hero=0&village=1&worker=0&seed=42&vseed=7&vedit=1~p0~broken`, {
    waitUntil: 'domcontentloaded', timeout,
  });
  await page.waitForFunction(() => !!window.__engine?.village?.debugPlan?.(), null, { timeout });
  const malformed = await page.evaluate(() => ({
    edits: window.__engine.village.residentialOpeningEdits(),
    selected: window.__engine.village.getState().selected,
    query: location.search,
  }));
  invariant(malformed.edits.length === 0 && malformed.selected == null && !malformed.query.includes('vedit='),
    `malformed payload did not fail closed: ${JSON.stringify(malformed)}`);
  invariant(runtimeErrors.length === 0, `browser emitted runtime errors:\n${runtimeErrors.join('\n')}`);

  console.log(`RESIDENTIAL EDIT URL BROWSER: PASS (${parcelId}, six-axis commit → reload → focus, malformed fail-closed)`);
} finally {
  await browser?.close();
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
}
