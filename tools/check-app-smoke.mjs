// Full-app browser smoke: app bootstrap → village → focus wiring.
// Uses an isolated Vite cache and ephemeral port, leaving any user dev server untouched.
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from '../app/node_modules/vite/dist/node/index.js';
import {
  SCENE_SNAPSHOT_QUERY_KEY,
  buildSceneSnapshotUrl,
  decodeSceneSnapshot,
  normalizeSceneView,
} from '../app/src/lib/scene-snapshot.js';
import {
  SCENE_GUIDE_DISMISSED_VALUE,
  SCENE_GUIDE_STORAGE_KEY,
} from '../app/src/lib/scene-guide.js';
import { planVillage } from '../src/api/village-plan.js';
import {
  VILLAGE_MJA_HOUSE_PRODUCT_CONTEXT,
  isVillageMjaHouseProductContext,
} from '../src/api/village-options.js';
import { launchVerificationBrowser, reportWebGLRenderer } from './lib/verification-browser.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const APP_ROOT = join(ROOT, 'app');
const cacheDir = await mkdtemp(join(tmpdir(), 'cheoma-app-smoke-'));
const captureDir = process.env.CHEOMA_APP_SMOKE_CAPTURE_DIR
  ? resolve(process.env.CHEOMA_APP_SMOKE_CAPTURE_DIR)
  : null;
if (captureDir) await mkdir(captureDir, { recursive: true });
const timeout = Number(process.env.CHEOMA_APP_SMOKE_TIMEOUT_MS) || 90_000;
const FOOTWEAR_REFERENCE_URLS = Object.freeze([
  'https://iksan.museum.go.kr/site/kor/html/sub04/0402.html?cate_code=&cate_gubun=&id=PS0100101400100019700000&mode=V',
  'https://iksan.museum.go.kr/site/kor/html/sub04/0402.html?cate_code=&cate_gubun=&id=PS0100101400000297500000&mode=V',
  'https://www.museum.go.kr/MUSEUM/contents/M0501000000.do?pageSize=10&relicRecommendCategory=&relicRecommendId=165924&sc=&schM=view&sv=',
  'https://www.korea.net/koreanet/fileDownload?fileUrl=FILE%2FPDF%2Fgeneral%2F201209_liveinkorea_en.pdf',
]);
const MJA_HANOK_REFERENCE_URLS = Object.freeze([
  'https://www.hanokdb.kr/theology/sub_02',
  'https://www.kci.go.kr/kciportal/ci/sereArticleSearch/ciSereArtiView.kci?sereArticleSearchBean.artiId=ART001493607',
  'https://www.kci.go.kr/kciportal/ci/sereArticleSearch/ciSereArtiView.kci?sereArticleSearchBean.artiId=ART001497233',
  'https://www.kci.go.kr/kciportal/ci/sereArticleSearch/ciSereArtiView.kci?sereArticleSearchBean.artiId=ART003276541',
  'https://journal.khousing.or.kr/articles/xml/RJPM/',
  'https://m.korea.kr/news/policyNewsView.do?cateId=&newsId=148944036&pageIndex=12&repCode_P=&smenu=',
]);
const failures = [];
const pass = (condition, message) => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${message}`);
  if (!condition) failures.push(message);
};
const circularDegrees = (a, b) => Math.abs((((a - b) % 360) + 540) % 360 - 180);
const semanticViewClose = (actual, expected) => {
  const a = normalizeSceneView(actual);
  const b = normalizeSceneView(expected);
  return !!a && !!b
    && circularDegrees(a.azimuth, b.azimuth) <= 0.1
    && Math.abs(a.elevation - b.elevation) <= 0.1
    && Math.abs(a.zoom - b.zoom) <= 0.001
    && Math.abs(a.panEast - b.panEast) <= 0.001
    && Math.abs(a.panUp - b.panUp) <= 0.001
    && Math.abs(a.panSouth - b.panSouth) <= 0.001;
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
  browser = await launchVerificationBrowser();
  const productContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await productContext.newPage();
  await page.addInitScript(() => {
    const nativeAdd = EventTarget.prototype.addEventListener;
    const nativeRemove = EventTarget.prototype.removeEventListener;
    const active = [];
    const captureOf = (options) => (typeof options === 'boolean' ? options : !!options?.capture);
    const appCaller = () => {
      const lines = (new Error().stack || '').split('\n');
      const wrapper = lines.findIndex((line) => line.includes('trackedAdd'));
      return wrapper >= 0 && /\/(?:app\/)?src\//.test(lines[wrapper + 1] || '');
    };
    EventTarget.prototype.addEventListener = function trackedAdd(type, listener, options) {
      if (listener && appCaller()) {
        const capture = captureOf(options);
        if (!active.some((entry) => entry.target === this && entry.type === type
          && entry.listener === listener && entry.capture === capture)) {
          active.push({ target: this, type, listener, capture });
        }
      }
      return nativeAdd.call(this, type, listener, options);
    };
    EventTarget.prototype.removeEventListener = function trackedRemove(type, listener, options) {
      const capture = captureOf(options);
      const index = active.findIndex((entry) => entry.target === this && entry.type === type
        && entry.listener === listener && entry.capture === capture);
      if (index >= 0) active.splice(index, 1);
      return nativeRemove.call(this, type, listener, options);
    };
    Object.defineProperty(window, '__listenerAudit', {
      configurable: false,
      value: {
        active: () => active.map((entry) => ({
          type: entry.type,
          target: entry.target === window ? 'window'
            : entry.target === document ? 'document'
              : entry.target?.tagName?.toLowerCase?.() || entry.target?.constructor?.name || 'unknown',
        })),
      },
    });
    const shareProbe = {
      nativeMode: 'success',
      clipboardMode: 'success',
      nativePayloads: [],
      nativeActivations: [],
      clipboardValues: [],
      activeClick: null,
    };
    Object.defineProperty(window, '__shareProbe', {
      configurable: false,
      value: shareProbe,
    });
    // Remember the exact trusted click object seen in capture. window.event is
    // that same object only while dispatch is still running, so the native
    // stub below rejects any call moved behind App's first await even if
    // Chromium's transient userActivation outlives the event task.
    document.addEventListener('click', (event) => {
      if (!event.isTrusted) return;
      shareProbe.activeClick = event;
    }, true);
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: async (payload) => {
        const activation = {
          userActivation: navigator.userActivation?.isActive === true,
          eventTask: window.event === shareProbe.activeClick
            && window.event?.isTrusted === true
            && window.event?.type === 'click',
        };
        shareProbe.nativeActivations.push(activation);
        shareProbe.nativePayloads.push(structuredClone(payload));
        if (!activation.userActivation || !activation.eventTask) {
          throw new Error('native share lost user activation');
        }
        if (shareProbe.nativeMode === 'abort') {
          throw new DOMException('share dismissed', 'AbortError');
        }
        if (shareProbe.nativeMode === 'fail') throw new Error('native share failed');
      },
    });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (value) => {
          shareProbe.clipboardValues.push(value);
          if (shareProbe.clipboardMode === 'fail') throw new Error('clipboard failed');
        },
      },
    });
  });
  runtimeErrors = [];
  page.on('pageerror', (error) => runtimeErrors.push(`page: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' && !/favicon|404/i.test(message.text())) {
      runtimeErrors.push(`console: ${message.text()}`);
    }
  });

  const url = `http://127.0.0.1:${port}/?hero=0&village=1&worker=0&seed=42&vseed=20260716&time=day&lang=ko`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
  await page.waitForFunction(() => window.__SHOT_READY === true && !!window.__engine, null, { timeout });
  await page.waitForFunction(() => !!window.__engine.village.debugPlan(), null, { timeout });
  await page.waitForFunction(() => !!window.__engine.village.captureView(), null, { timeout });
  await reportWebGLRenderer(page, 'app-smoke');

  const mjaToggle = page.locator('[data-vkey="mjaHouse"]');
  await mjaToggle.waitFor({ state: 'visible', timeout });
  const mjaDefaultUi = await mjaToggle.evaluate((button) => ({
    checked: button.getAttribute('aria-checked'),
    disabled: button.disabled,
    label: button.getAttribute('aria-label'),
    row: button.closest('.row')?.textContent?.replace(/\s+/g, ' ').trim() || '',
  }));
  pass(mjaDefaultUi.checked === 'false'
      && !mjaDefaultUi.disabled
      && mjaDefaultUi.label === 'ㅁ자 뜰집'
      && mjaDefaultUi.row.includes('ㅁ자 뜰집'),
  `village-scale mjaHouse opt-in renders default-off with its localized label (${JSON.stringify(mjaDefaultUi)})`);
  await mjaToggle.click();
  await page.waitForFunction(() => (
    document.querySelector('[data-vkey="mjaHouse"]')?.getAttribute('aria-checked') === 'true'
  ), null, { timeout });
  pass(await mjaToggle.getAttribute('aria-checked') === 'true'
      && isVillageMjaHouseProductContext(VILLAGE_MJA_HOUSE_PRODUCT_CONTEXT),
  'mjaHouse object toggle enters the schema-owned product context');
  await mjaToggle.click();
  await page.waitForFunction(() => (
    !window.__engine.village.isWaving()
      && window.__engine.village.debugPlan()?.opts?.mjaHouse == null
  ), null, { timeout });
  pass(await mjaToggle.getAttribute('aria-checked') === 'false',
    'mjaHouse object toggle returns to null/default-off before snapshot checks');

  const sceneGuide = page.locator('[data-scene-guide]');
  await sceneGuide.waitFor({ state: 'visible', timeout });
  const desktopGuide = await sceneGuide.evaluate((guide) => {
    const rect = guide.getBoundingClientRect();
    const dismiss = guide.querySelector('.dismiss')?.getBoundingClientRect();
    const active = document.activeElement;
    return {
      input: guide.dataset.input,
      text: guide.textContent?.replace(/\s+/g, ' ').trim(),
      pointerEvents: getComputedStyle(guide).pointerEvents,
      dismissPointerEvents: getComputedStyle(guide.querySelector('.dismiss')).pointerEvents,
      bounds: [rect.left, rect.top, rect.right, rect.bottom],
      dismiss: dismiss ? [dismiss.width, dismiss.height] : null,
      viewport: [innerWidth, innerHeight],
      focusInside: guide.contains(active),
      modal: guide.matches('[aria-modal="true"]') || !!guide.querySelector('[aria-modal="true"]'),
    };
  });
  pass(desktopGuide.input === 'desktop'
      && desktopGuide.text.includes('드래그해 마을 둘러보기')
      && desktopGuide.text.includes('휠로 확대·축소')
      && desktopGuide.text.includes('집을 눌러 가까이 보기')
      && desktopGuide.text.includes('Esc 또는 둘러보기로 돌아가기')
      && desktopGuide.pointerEvents === 'none'
      && desktopGuide.dismissPointerEvents === 'auto'
      && desktopGuide.dismiss?.[0] >= 44
      && desktopGuide.dismiss?.[1] >= 44
      && desktopGuide.bounds[0] >= 0
      && desktopGuide.bounds[1] >= 0
      && desktopGuide.bounds[2] <= desktopGuide.viewport[0]
      && desktopGuide.bounds[3] <= desktopGuide.viewport[1]
      && !desktopGuide.focusInside
      && !desktopGuide.modal,
  `fresh desktop stable frame shows one bounded nonmodal guide without stealing focus (${JSON.stringify(desktopGuide)})`);
  if (captureDir) {
    await page.screenshot({ path: join(captureDir, 'scene-guide-desktop.png') });
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(
    () => window.__device?.sheet === true && innerWidth === 390 && innerHeight === 844,
    null,
    { timeout },
  );
  await page.evaluate(() => { window.__device.touch = true; });
  await page.waitForFunction(
    () => document.querySelector('[data-scene-guide]')?.dataset.input === 'touch',
    null,
    { timeout },
  );
  await page.waitForFunction(
    () => {
      const sheet = document.querySelector('.sheet.context[data-snap="peek"]');
      return sheet?.getBoundingClientRect().top >= 740;
    },
    null,
    { timeout },
  );
  const touchGuide = await sceneGuide.evaluate((guide) => {
    const rect = guide.getBoundingClientRect();
    const dismiss = guide.querySelector('.dismiss')?.getBoundingClientRect();
    const sheet = document.querySelector('.sheet.context')?.getBoundingClientRect();
    return {
      text: guide.textContent?.replace(/\s+/g, ' ').trim(),
      bounds: [rect.left, rect.top, rect.right, rect.bottom],
      dismiss: dismiss ? [dismiss.width, dismiss.height] : null,
      sheetTop: sheet?.top ?? null,
      viewport: [innerWidth, innerHeight],
    };
  });
  pass(touchGuide.text.includes('한 손가락으로 드래그해 둘러보기')
      && touchGuide.text.includes('두 손가락으로 확대·축소하고 이동')
      && touchGuide.text.includes('집을 탭해 가까이 보기')
      && touchGuide.text.includes('둘러보기로 돌아가기')
      && touchGuide.bounds[0] >= 0
      && touchGuide.bounds[1] >= 0
      && touchGuide.bounds[2] <= touchGuide.viewport[0]
      && touchGuide.bounds[3] <= touchGuide.viewport[1]
      && touchGuide.bounds[3] <= touchGuide.sheetTop
      && touchGuide.dismiss?.[0] >= 44
      && touchGuide.dismiss?.[1] >= 44,
  `390x844 touch copy and 44px dismissal stay inside the first scene (${JSON.stringify(touchGuide)})`);
  if (captureDir) {
    await page.screenshot({ path: join(captureDir, 'scene-guide-touch.png') });
  }

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForFunction(
    () => window.__device?.sheet === false && innerWidth === 1280 && innerHeight === 800,
    null,
    { timeout },
  );
  await page.evaluate(() => { window.__device.touch = false; });
  await page.waitForFunction(
    () => document.querySelector('[data-scene-guide]')?.dataset.input === 'desktop'
      && window.__device?.sheet === false,
    null,
    { timeout },
  );
  const guideInput = await page.evaluate(() => {
    const guide = document.querySelector('[data-scene-guide]');
    const rect = guide.getBoundingClientRect();
    return {
      point: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
      view: window.__engine.village.captureView(),
    };
  });
  await page.mouse.move(guideInput.point.x, guideInput.point.y);
  await page.mouse.wheel(0, -120);
  await page.waitForFunction(
    ({ key, beforeZoom }) => {
      const view = window.__engine?.village?.captureView?.();
      return !document.querySelector('[data-scene-guide]')
        && localStorage.getItem(key) === 'dismissed'
        && Math.abs((view?.zoom ?? beforeZoom) - beforeZoom) > 0.001;
    },
    { key: SCENE_GUIDE_STORAGE_KEY, beforeZoom: guideInput.view.zoom },
    { timeout },
  );
  const guideDismissal = await page.evaluate((key) => ({
    stored: localStorage.getItem(key),
    view: window.__engine.village.captureView(),
  }), SCENE_GUIDE_STORAGE_KEY);
  pass(guideDismissal.stored === SCENE_GUIDE_DISMISSED_VALUE
      && Math.abs(guideDismissal.view.zoom - guideInput.view.zoom) > 0.001,
  `wheel through the pointer-transparent card both controls the camera and persists dismissal (${JSON.stringify({
    before: guideInput.view.zoom,
    after: guideDismissal.view.zoom,
    stored: guideDismissal.stored,
  })})`);

  // The guide layout checks intentionally outlast the 3s appreciation fade.
  // Wake the existing ActionBar before exercising its trusted keyboard share.
  await page.mouse.move(32, 32);
  await page.waitForFunction(() => !document.querySelector('.chroma')?.classList.contains('faded'), null, { timeout });
  const shareButton = page.locator('.actions [data-action="share"]');
  await shareButton.waitFor({ state: 'visible', timeout });
  const desktopShareLayout = await shareButton.evaluate((button) => {
    const rect = button.getBoundingClientRect();
    const panel = document.querySelector('.ctxcard')?.getBoundingClientRect();
    const overlap = panel
      ? Math.max(0, Math.min(rect.right, panel.right) - Math.max(rect.left, panel.left))
        * Math.max(0, Math.min(rect.bottom, panel.bottom) - Math.max(rect.top, panel.top))
      : 0;
    return {
      count: document.querySelectorAll('[data-action="share"]').length,
      left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
      width: rect.width, height: rect.height,
      viewport: [innerWidth, innerHeight],
      panelOverlap: overlap,
    };
  });
  pass(desktopShareLayout.count === 1
      && desktopShareLayout.width >= 44
      && desktopShareLayout.height >= 44
      && desktopShareLayout.left >= 0
      && desktopShareLayout.top >= 0
      && desktopShareLayout.right <= 1280
      && desktopShareLayout.bottom <= 800
      && desktopShareLayout.panelOverlap === 0,
  `1280x800 aerial share action is unique, bounded, and clear of ContextPanel (${JSON.stringify(desktopShareLayout)})`);
  if (captureDir) {
    await page.screenshot({ path: join(captureDir, 'share-desktop-aerial.png') });
  }

  // Exercise the product handler, not only the pure platform adapter. Enter
  // preserves the same transient activation as click because share() is called
  // synchronously before the first await in App.
  await page.evaluate(() => {
    Object.assign(window.__shareProbe, { nativeMode: 'abort', clipboardMode: 'success' });
    window.__shareProbe.nativePayloads.length = 0;
    window.__shareProbe.nativeActivations.length = 0;
    window.__shareProbe.clipboardValues.length = 0;
  });
  await page.mouse.move(34, 34);
  await page.waitForFunction(() => !document.querySelector('.chroma')?.classList.contains('faded'), null, { timeout });
  await shareButton.focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () => window.__shareProbe.nativePayloads.length === 1,
    null,
    { timeout: Math.min(timeout, 5000) },
  ).catch(() => {});
  const abortShareDispatch = await page.evaluate(() => {
    const button = document.querySelector('.actions [data-action="share"]');
    return {
      payloads: window.__shareProbe.nativePayloads.length,
      active: document.activeElement === button,
      connected: !!button?.isConnected,
      disabled: !!button?.disabled,
      chroma: document.querySelector('.chroma')?.className,
      toast: document.querySelector('.toast')?.textContent?.trim() || null,
      view: window.__engine.captureView(),
    };
  });
  if (abortShareDispatch.payloads !== 1) {
    throw new Error(`keyboard share did not dispatch: ${JSON.stringify(abortShareDispatch)}`);
  }
  await page.evaluate(() => new Promise((resolveFrame) => requestAnimationFrame(resolveFrame)));
  const abortedShare = await page.evaluate(() => ({
    native: window.__shareProbe.nativePayloads.length,
    activation: window.__shareProbe.nativeActivations[0] || null,
    clipboard: window.__shareProbe.clipboardValues.length,
    toast: document.querySelector('.toast')?.textContent?.trim() || null,
  }));
  pass(abortedShare.native === 1
      && abortedShare.activation?.userActivation
      && abortedShare.activation?.eventTask
      && abortedShare.clipboard === 0
      && abortedShare.toast == null,
    `keyboard-native AbortError stays silent and does not copy (${JSON.stringify(abortedShare)})`);

  await page.evaluate(() => {
    Object.assign(window.__shareProbe, { nativeMode: 'success', clipboardMode: 'success' });
    window.__shareProbe.nativePayloads.length = 0;
    window.__shareProbe.nativeActivations.length = 0;
    window.__shareProbe.clipboardValues.length = 0;
  });
  await page.mouse.move(36, 36);
  await page.waitForFunction(() => !document.querySelector('.chroma')?.classList.contains('faded'), null, { timeout });
  await shareButton.focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__shareProbe.nativePayloads.length === 1, null, { timeout });
  await page.evaluate(() => new Promise((resolveFrame) => requestAnimationFrame(resolveFrame)));
  const nativeShare = await page.evaluate(() => {
    const payload = window.__shareProbe.nativePayloads[0];
    const shared = new URL(payload.url);
    const fields = Object.fromEntries(shared.searchParams);
    return {
      payload,
      activation: window.__shareProbe.nativeActivations[0] || null,
      fields,
      clipboard: window.__shareProbe.clipboardValues.length,
      toast: document.querySelector('.toast')?.textContent?.trim() || null,
      runtimeKeys: ['hero', 'worker', 'shot', 'lang', 'flowsec', 'post']
        .filter((key) => shared.searchParams.has(key)),
    };
  });
  const nativeScene = decodeSceneSnapshot(nativeShare.fields[SCENE_SNAPSHOT_QUERY_KEY]);
  pass(nativeShare.payload?.title === '처마 — 내가 지은 풍경'
      && nativeShare.payload?.text === '처마에서 만든 한국의 집과 마을을 둘러보세요.'
      && nativeShare.activation?.userActivation
      && nativeShare.activation?.eventTask
      && Object.keys(nativeShare.fields).length === 1
      && !!nativeShare.fields[SCENE_SNAPSHOT_QUERY_KEY]
      && nativeScene?.seed === 42
      && nativeScene?.time === 'day'
      && nativeScene?.village?.seed === 20260716
      && nativeScene?.village?.scale === 'village'
      && !!nativeScene?.view
      && nativeShare.runtimeKeys.length === 0
      && nativeShare.clipboard === 0
      && nativeShare.toast === '장면 링크를 공유했습니다',
  `native share receives the canonical scene payload without runtime controls or clipboard fallback (${JSON.stringify(nativeShare)})`);

  // Open the exact native payload, let the canonical entry camera settle, then
  // reload the address that App re-canonicalized. This catches eager #107
  // downgrade, restore-order races, and one-frame OrbitControls/focus drift.
  // Reuse the product session: dismissal is localStorage-backed and must survive
  // a newly opened shared scene plus reload in the same browser context.
  const sharedPage = await productContext.newPage();
  await sharedPage.addInitScript((sceneKey) => {
    const nativeReplaceState = history.replaceState.bind(history);
    const canonicalWrites = [];
    history.replaceState = (state, title, nextUrl) => {
      const resolved = new URL(nextUrl ?? location.href, location.href);
      if (resolved.searchParams.has(sceneKey)) canonicalWrites.push(resolved.href);
      return nativeReplaceState(state, title, nextUrl);
    };
    Object.defineProperty(window, '__canonicalHistoryWrites', {
      configurable: false,
      value: canonicalWrites,
    });
  }, SCENE_SNAPSHOT_QUERY_KEY);
  sharedPage.on('pageerror', (error) => runtimeErrors.push(`shared page: ${error.message}`));
  sharedPage.on('console', (message) => {
    if (message.type() === 'error' && !/favicon|404/i.test(message.text())) {
      runtimeErrors.push(`shared console: ${message.text()}`);
    }
  });
  await sharedPage.goto(nativeShare.payload.url, { waitUntil: 'domcontentloaded', timeout });
  try {
    await sharedPage.waitForFunction(
      () => window.__SHOT_READY === true && !!window.__engine?.village?.captureView?.(),
      null,
      { timeout },
    );
  } catch (error) {
    const diagnostic = await sharedPage.evaluate(() => ({
      url: location.href,
      ready: window.__SHOT_READY,
      engine: !!window.__engine,
      village: !!window.__engine?.village,
      view: window.__engine?.village?.captureView?.() || null,
      villageState: window.__engine?.village?.getState?.() || null,
      wave: window.__engine?.village?.debugWave?.() || null,
      waving: window.__engine?.village?.isWaving?.() ?? null,
      plan: window.__engine?.village?.debugPlan?.()?.stats || null,
      body: document.body?.innerText?.replace(/\s+/g, ' ').slice(0, 240) || '',
      canvases: document.querySelectorAll('canvas').length,
      visibility: document.visibilityState,
    })).catch((diagnosticError) => ({
      evaluationError: diagnosticError instanceof Error
        ? diagnosticError.message
        : String(diagnosticError),
    }));
    throw new Error(
      `shared scene bootstrap timed out: ${JSON.stringify({ diagnostic, runtimeErrors })}`,
      { cause: error },
    );
  }
  await sharedPage.evaluate(() => new Promise((resolveFrame) => requestAnimationFrame(resolveFrame)));
  const sharedBeforeReload = await sharedPage.evaluate(() => ({
    address: location.href,
    state: window.__engine.getState(),
    village: window.__engine.village.getState(),
    view: window.__engine.village.captureView(),
    canonicalWrites: [...window.__canonicalHistoryWrites],
    guideVisible: !!document.querySelector('[data-scene-guide]'),
    guideStored: localStorage.getItem('cheoma-scene-guide-v1'),
  }));
  const sharedBeforeSnapshot = decodeSceneSnapshot(
    new URL(sharedBeforeReload.address).searchParams.get(SCENE_SNAPSHOT_QUERY_KEY),
  );
  await sharedPage.reload({ waitUntil: 'domcontentloaded', timeout });
  await sharedPage.waitForFunction(
    () => window.__SHOT_READY === true && !!window.__engine?.village?.captureView?.(),
    null,
    { timeout },
  );
  await sharedPage.evaluate(() => new Promise((resolveFrame) => requestAnimationFrame(resolveFrame)));
  const sharedAfterReload = await sharedPage.evaluate(() => ({
    address: location.href,
    state: window.__engine.getState(),
    village: window.__engine.village.getState(),
    view: window.__engine.village.captureView(),
    canonicalWrites: [...window.__canonicalHistoryWrites],
    guideVisible: !!document.querySelector('[data-scene-guide]'),
    guideStored: localStorage.getItem('cheoma-scene-guide-v1'),
  }));
  const sharedAfterSnapshot = decodeSceneSnapshot(
    new URL(sharedAfterReload.address).searchParams.get(SCENE_SNAPSHOT_QUERY_KEY),
  );
  pass(sharedBeforeSnapshot?.seed === nativeScene.seed
      && sharedAfterSnapshot?.seed === nativeScene.seed
      && sharedBeforeSnapshot?.village?.seed === nativeScene.village.seed
      && sharedAfterSnapshot?.village?.seed === nativeScene.village.seed
      && sharedBeforeReload.village.selected === nativeScene.focusedParcelId
      && sharedAfterReload.village.selected === nativeScene.focusedParcelId
      && semanticViewClose(sharedBeforeReload.view, nativeScene.view)
      && semanticViewClose(sharedAfterReload.view, nativeScene.view)
      && sharedBeforeReload.canonicalWrites.length === 1
      && sharedAfterReload.canonicalWrites.length === 1
      && !sharedBeforeReload.guideVisible
      && !sharedAfterReload.guideVisible
      && sharedBeforeReload.guideStored === SCENE_GUIDE_DISMISSED_VALUE
      && sharedAfterReload.guideStored === SCENE_GUIDE_DISMISSED_VALUE
      && [...new URL(sharedAfterReload.address).searchParams.keys()].join() === SCENE_SNAPSHOT_QUERY_KEY,
  `exact native scene writes once per stable restore while the dismissed guide stays absent (${JSON.stringify({
    before: sharedBeforeReload.view,
    after: sharedAfterReload.view,
    expected: nativeScene.view,
    selected: [sharedBeforeReload.village.selected, sharedAfterReload.village.selected],
    expectedSelected: nativeScene.focusedParcelId,
    snapshots: [sharedBeforeSnapshot, sharedAfterSnapshot],
    guide: [
      [sharedBeforeReload.guideVisible, sharedBeforeReload.guideStored],
      [sharedAfterReload.guideVisible, sharedAfterReload.guideStored],
    ],
    fields: [...new URL(sharedAfterReload.address).searchParams.keys()],
    writes: [sharedBeforeReload.canonicalWrites.length, sharedAfterReload.canonicalWrites.length],
  })})`);

  const shareSource = await page.evaluate(() => ({
    state: window.__engine.getState(),
    heroId: window.__engine.village.heroId(),
  }));
  const advancedView = {
    azimuth: 327.34,
    elevation: 27.44,
    zoom: 0.6436,
    panEast: 0.1174,
    panUp: -0.0386,
    panSouth: 0.0214,
  };
  const advancedVillage = {
    seed: 20260716,
    scale: 'village',
    character: 'yeoyeom',
    includePalace: false,
    includeTemple: false,
    siteR: 150.5,
    undAmpK: 1.75,
    ridgeHK: 1.32,
    streamMeanderK: 2.1,
    stream: false,
    river: false,
    paddyDensityK: 0.65,
    treeDensityK: 1.8,
    cityWall: false,
    sijeon: true,
    char01: 0.74,
    diversityK: 1.55,
    houses: 18,
    wallWeights: {
      tile: 1.5, stone: 1.25, mud: 0.75, brush: 0.5, hedge: 1, open: 0,
    },
  };
  const advancedEditParcel = planVillage(advancedVillage).parcels.find(
    (parcel) => !parcel.hero && (parcel.kind === 'giwa' || parcel.kind === 'choga'),
  );
  const advancedEdit = {
    parcelId: advancedEditParcel.id,
    kind: advancedEditParcel.kind,
    params: {
      doorCount: 2,
      windowCount: 3,
      doorWidthK: 0.72,
      windowWidthK: 0.46,
      doorHeightK: 1.03,
      windowHeightK: 0.91,
    },
  };
  const staleAdvancedEdit = { ...advancedEdit, parcelId: 'zz-missing-future' };
  const advancedUrl = buildSceneSnapshotUrl({
    baseUrl: nativeShare.payload.url,
    state: shareSource.state,
    overrides: nativeScene.overrides,
    village: advancedVillage,
    residentialEdits: [advancedEdit, staleAdvancedEdit],
    focusedParcelId: shareSource.heroId,
    view: advancedView,
  });
  await sharedPage.goto(advancedUrl, { waitUntil: 'domcontentloaded', timeout });
  await sharedPage.waitForFunction((heroId) => {
    const village = window.__engine?.village;
    const state = village?.getState?.();
    return window.__SHOT_READY === true
      && state?.selected === heroId
      && !state.transitioning
      && !!village.captureView();
  }, shareSource.heroId, { timeout });
  await sharedPage.evaluate(() => new Promise((resolveFrame) => requestAnimationFrame(resolveFrame)));
  const advancedFirst = await sharedPage.evaluate(() => ({
    address: location.href,
    scene: window.__engine.getState(),
    village: window.__engine.village.getState(),
    plan: window.__engine.village.debugPlan(),
    edits: window.__engine.village.residentialOpeningEdits(),
    view: window.__engine.village.captureView(),
  }));
  if (captureDir) {
    await sharedPage.screenshot({ path: join(captureDir, 'scene-snapshot-focus-restored.png') });
  }
  await sharedPage.evaluate(() => new Promise((resolveFrame) => requestAnimationFrame(resolveFrame)));
  const advancedOneFrameLater = await sharedPage.evaluate(() => ({
    view: window.__engine.village.captureView(),
  }));
  await sharedPage.reload({ waitUntil: 'domcontentloaded', timeout });
  await sharedPage.waitForFunction((heroId) => {
    const village = window.__engine?.village;
    const state = village?.getState?.();
    return window.__SHOT_READY === true
      && state?.selected === heroId
      && !state.transitioning
      && !!village.captureView();
  }, shareSource.heroId, { timeout });
  await sharedPage.evaluate(() => new Promise((resolveFrame) => requestAnimationFrame(resolveFrame)));
  const advancedReloaded = await sharedPage.evaluate(() => ({
    address: location.href,
    village: window.__engine.village.getState(),
    plan: window.__engine.village.debugPlan(),
    edits: window.__engine.village.residentialOpeningEdits(),
    view: window.__engine.village.captureView(),
  }));
  if (captureDir) {
    await sharedPage.screenshot({ path: join(captureDir, 'scene-snapshot-focus-reloaded.png') });
  }
  const advancedAddress = decodeSceneSnapshot(
    new URL(advancedReloaded.address).searchParams.get(SCENE_SNAPSHOT_QUERY_KEY),
  );
  pass(advancedAddress?.focusedParcelId === shareSource.heroId
      && advancedReloaded.village.selected === shareSource.heroId
      && advancedReloaded.plan.opts.siteR === advancedVillage.siteR
      && advancedReloaded.plan.stream === false
      && advancedReloaded.plan.opts.houses === advancedVillage.houses
      && advancedReloaded.plan.opts.sijeon === advancedVillage.sijeon
      && JSON.stringify(advancedReloaded.plan.opts.wallWeights)
        === JSON.stringify(advancedVillage.wallWeights)
      && JSON.stringify(advancedFirst.edits) === JSON.stringify([advancedEdit])
      && JSON.stringify(advancedReloaded.edits) === JSON.stringify([advancedEdit])
      && JSON.stringify(advancedAddress.residentialEdits) === JSON.stringify([advancedEdit])
      && semanticViewClose(advancedFirst.view, advancedView)
      && semanticViewClose(advancedOneFrameLater.view, advancedView)
      && semanticViewClose(advancedReloaded.view, advancedView),
  `advanced options, stable focus, semantic pan/optics, and one-frame camera state survive reload (${JSON.stringify({
    plan: advancedReloaded.plan,
    expectedEdit: advancedEdit,
    firstEdits: advancedFirst.edits,
    reloadedEdits: advancedReloaded.edits,
    addressEdits: advancedAddress?.residentialEdits,
    first: advancedFirst.view,
    oneFrame: advancedOneFrameLater.view,
    reloaded: advancedReloaded.view,
  })})`);
  const villageManualBeforeAddress = advancedReloaded.address;
  await sharedPage.mouse.move(640, 400);
  await sharedPage.mouse.wheel(0, -480);
  await sharedPage.waitForFunction(
    (beforeAddress) => location.href !== beforeAddress,
    villageManualBeforeAddress,
    { timeout },
  );
  const villageManualView = await sharedPage.evaluate(() => ({
    address: location.href,
    view: window.__engine.village.captureView(),
    selected: window.__engine.village.getState().selected,
  }));
  const villageManualSnapshot = decodeSceneSnapshot(
    new URL(villageManualView.address).searchParams.get(SCENE_SNAPSHOT_QUERY_KEY),
  );
  pass(villageManualView.selected === shareSource.heroId
      && semanticViewClose(villageManualSnapshot?.view, villageManualView.view),
  `focused village wheel settles optics/crane before canonical vw sync (${JSON.stringify(villageManualView.view)})`);
  await sharedPage.close();

  await page.evaluate(() => {
    Object.assign(window.__shareProbe, { nativeMode: 'fail', clipboardMode: 'success' });
    window.__shareProbe.nativePayloads.length = 0;
    window.__shareProbe.nativeActivations.length = 0;
    window.__shareProbe.clipboardValues.length = 0;
  });
  await shareButton.focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('.toast')?.textContent?.trim() === '장면 링크를 복사했습니다', null, { timeout });
  const copiedShare = await page.evaluate(() => ({
    native: window.__shareProbe.nativePayloads.length,
    activation: window.__shareProbe.nativeActivations[0] || null,
    copied: window.__shareProbe.clipboardValues,
    payloadUrl: window.__shareProbe.nativePayloads[0]?.url,
    toast: document.querySelector('.toast')?.textContent?.trim() || null,
  }));
  pass(copiedShare.native === 1
      && copiedShare.activation?.userActivation
      && copiedShare.activation?.eventTask
      && copiedShare.copied.length === 1
      && copiedShare.copied[0] === copiedShare.payloadUrl
      && copiedShare.toast === '장면 링크를 복사했습니다',
  `native failure copies exactly the canonical URL and reports success (${JSON.stringify(copiedShare)})`);

  await page.evaluate(() => {
    Object.assign(window.__shareProbe, { nativeMode: 'fail', clipboardMode: 'fail' });
    window.__shareProbe.nativePayloads.length = 0;
    window.__shareProbe.nativeActivations.length = 0;
    window.__shareProbe.clipboardValues.length = 0;
  });
  await shareButton.focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('.toast')?.textContent?.trim() === '장면 링크를 공유하지 못했습니다', null, { timeout });
  const failedShare = await page.evaluate(() => ({
    native: window.__shareProbe.nativePayloads.length,
    activation: window.__shareProbe.nativeActivations[0] || null,
    clipboard: window.__shareProbe.clipboardValues.length,
    toast: document.querySelector('.toast')?.textContent?.trim() || null,
  }));
  pass(failedShare.native === 1
      && failedShare.activation?.userActivation
      && failedShare.activation?.eventTask
      && failedShare.clipboard === 1
      && failedShare.toast === '장면 링크를 공유하지 못했습니다',
  `native and clipboard failure surface one localized failure toast (${JSON.stringify(failedShare)})`);

  // docs/credits.md is the public product-reference source of truth.  Verify the
  // newly applied house-plan and legal-limit evidence reaches the actual modal,
  // including authoritative links and the non-literal-use qualification.
  const referenceInfoTrigger = page.locator('button.info[aria-label="참고 자료"]');
  await referenceInfoTrigger.focus();
  await referenceInfoTrigger.press('Enter');
  const referenceDialog = page.getByRole('dialog', { name: '참고 자료' });
  await referenceDialog.waitFor({ state: 'visible', timeout });
  await page.waitForFunction(() => document.activeElement?.id === 'reference-modal-title', null, { timeout });
  const referenceA11y = await referenceDialog.evaluate((dialog) => {
    const surface = document.querySelector('[data-app-surface]');
    const labelledBy = dialog.getAttribute('aria-labelledby');
    return {
      activeTitle: document.activeElement?.id === labelledBy,
      labelledBy,
      title: labelledBy ? document.getElementById(labelledBy)?.textContent?.trim() : null,
      modal: dialog.getAttribute('aria-modal'),
      surfaceInert: surface?.inert === true,
      surfaceHidden: surface?.getAttribute('aria-hidden'),
      hiddenAncestor: !!dialog.closest('[inert], [aria-hidden="true"]'),
    };
  });
  pass(referenceA11y.activeTitle
      && referenceA11y.labelledBy === 'reference-modal-title'
      && referenceA11y.title === '참고 자료'
      && referenceA11y.modal === 'true'
      && referenceA11y.surfaceInert
      && referenceA11y.surfaceHidden === 'true'
      && !referenceA11y.hiddenAncestor,
  `References opens at its labelled title while the app surface is inert (${JSON.stringify(referenceA11y)})`);

  const closeReference = referenceDialog.getByRole('button', { name: '닫기' });
  await closeReference.focus();
  await page.keyboard.press('Shift+Tab');
  const wrappedBackward = await referenceDialog.evaluate((dialog) => {
    const focusable = [...dialog.querySelectorAll('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])')]
      .filter((element) => element.getClientRects().length > 0);
    return document.activeElement === focusable.at(-1);
  });
  await page.keyboard.press('Tab');
  const wrappedForward = await referenceDialog.evaluate((dialog) => {
    const focusable = [...dialog.querySelectorAll('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])')]
      .filter((element) => element.getClientRects().length > 0);
    return document.activeElement === focusable[0];
  });
  await referenceDialog.focus();
  await page.keyboard.press('Shift+Tab');
  const dialogWrappedBackward = await referenceDialog.evaluate((dialog) => {
    const focusable = [...dialog.querySelectorAll('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])')]
      .filter((element) => element.getClientRects().length > 0);
    return document.activeElement === focusable.at(-1);
  });
  await referenceDialog.focus();
  await page.keyboard.press('Tab');
  const dialogWrappedForward = await referenceDialog.evaluate((dialog) => {
    const focusable = [...dialog.querySelectorAll('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])')]
      .filter((element) => element.getClientRects().length > 0);
    return document.activeElement === focusable[0];
  });
  await page.evaluate(() => {
    document.body.tabIndex = -1;
    document.body.focus();
    document.body.removeAttribute('tabindex');
  });
  const recoveredFocus = await referenceDialog.evaluate((dialog) => (
    dialog.contains(document.activeElement) && document.activeElement?.id === 'reference-modal-title'
  ));
  pass(wrappedBackward
      && wrappedForward
      && dialogWrappedBackward
      && dialogWrappedForward
      && recoveredFocus,
  'References traps forward/backward Tab from focusable and dialog entry points, and recovers programmatic focus escape');

  const revealCapture = await page.evaluate(async ({ runtimeModuleUrl, threeModuleUrl }) => {
    const [{ createArchitecturalRevealRuntime }, THREE] = await Promise.all([
      import(runtimeModuleUrl),
      import(threeModuleUrl),
    ]);
    const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
    camera.position.set(0, 2, 8);
    const controls = { target: new THREE.Vector3(0, 1, 0), enabled: true };
    const canvas = document.createElement('canvas');
    const runtime = createArchitecturalRevealRuntime({ camera, controls, domElement: canvas });
    runtime.reveal('arrival', {
      position: { x: 1, y: 2, z: 7 },
      target: { x: 0, y: 1, z: 0 },
      fov: 30,
      referenceFov: 30,
      composition: 0,
    }, { duration: 1, subjectSize: 4 });
    document.getElementById('reference-modal-title')?.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Tab', bubbles: true, cancelable: true,
    }));
    const modalKeyKeptReveal = runtime.isPlaying();
    document.body.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'x', bubbles: true, cancelable: true,
    }));
    const backgroundKeyInterrupted = runtime.getState().reason === 'input';
    runtime.dispose();
    return { modalKeyKeptReveal, backgroundKeyInterrupted };
  }, {
    runtimeModuleUrl: `/@fs${join(APP_ROOT, 'src/engine/architectural-reveal-runtime.js')}`,
    threeModuleUrl: `/@fs${join(APP_ROOT, 'node_modules/three/build/three.module.js')}`,
  });
  pass(revealCapture.modalKeyKeptReveal && revealCapture.backgroundKeyInterrupted,
    `modal keyboard input cannot interrupt the background architectural reveal (${JSON.stringify(revealCapture)})`);

  await page.waitForFunction(() => window.__engine.cine.available(), null, { timeout });
  const walkStartedBehindReferences = await page.evaluate(() => window.__engine.cine.start('walk'));
  await page.waitForFunction(() => {
    const state = window.__engine.cine.getState();
    return state.active && state.mode === 'walk' && !!window.__engine.cine.debugWalker();
  }, null, { timeout });
  await page.evaluate(() => window.__engine.cine.setAutoStroll(false));
  const referenceScrollLink = referenceDialog.locator('.scroll a[href]').first();
  await referenceScrollLink.focus();
  await referenceDialog.locator('.scroll').evaluate((scroll) => { scroll.scrollTop = 0; });
  const walkBeforeModalKeys = await page.evaluate(() => window.__engine.cine.debugWalker()?.pos);
  await page.keyboard.down('ArrowDown');
  await page.waitForFunction(() => document.querySelector('[role="dialog"] .scroll')?.scrollTop > 0, null, { timeout });
  await page.waitForTimeout(120);
  await page.keyboard.up('ArrowDown');
  await page.keyboard.down('w');
  await page.waitForTimeout(120);
  await page.keyboard.up('w');
  const modalWalkIsolation = await referenceDialog.evaluate((dialog) => ({
    scrollTop: dialog.querySelector('.scroll')?.scrollTop || 0,
    focusInside: dialog.contains(document.activeElement),
    cine: window.__engine.cine.getState(),
    walker: window.__engine.cine.debugWalker(),
  }));
  pass(walkStartedBehindReferences
      && modalWalkIsolation.scrollTop > 0
      && modalWalkIsolation.focusInside
      && modalWalkIsolation.cine.active
      && modalWalkIsolation.cine.mode === 'walk'
      && modalWalkIsolation.walker?.pos.x === walkBeforeModalKeys?.x
      && modalWalkIsolation.walker?.pos.z === walkBeforeModalKeys?.z,
  `References keeps Arrow/WASD out of active walk while preserving internal scrolling (${JSON.stringify({
    before: walkBeforeModalKeys,
    after: modalWalkIsolation,
  })})`);
  await page.evaluate(() => window.__engine.cine.stop());
  await page.waitForFunction(() => !window.__engine.cine.getState().active, null, { timeout });

  const reference = await referenceDialog.evaluate((dialog) => ({
    text: dialog.textContent.replace(/\s+/g, ' ').trim(),
    links: [...dialog.querySelectorAll('a')].map((anchor) => anchor.href),
    items: [...dialog.querySelectorAll('li')].map((item) => ({
      title: item.querySelector('.it-title')?.textContent?.trim() || '',
      topic: item.dataset.referenceTopic || '',
      text: item.textContent.replace(/\s+/g, ' ').trim(),
      links: [...item.querySelectorAll('a')].map((anchor) => anchor.href),
      anchors: [...item.querySelectorAll('a')].map((anchor) => ({
        href: anchor.href,
        target: anchor.target,
        rel: anchor.rel,
      })),
      license: item.querySelector('.it-license')?.textContent?.replace(/\s+/g, ' ').trim() || '',
    })),
  }));
  pass(reference.text.includes('국가한옥센터(AURI) 한옥DB — 한옥의 종류·한옥이론')
      && reference.text.includes('ㅡ·ㄱ·ㄷ·ㅁ')
      && reference.text.includes('앱의 칸·충돌 안전 범위')
      && reference.text.includes('역사적 빈도나 보편 비례가 아닌')
      && reference.links.some((url) => url.includes('hanokdb.kr/theology/sub_02')),
  'National Hanok Center semantic-slot evidence and non-historical safety bounds render in Product References');
  pass(reference.text.includes('출입용 호와 채광·조망·환기용 창')
      && reference.text.includes('창 하부 머름 apron/rail')
      && reference.text.includes('lowerPanel')
      && reference.links.some((url) => url.includes('hanokdb.kr/theology/sub_04')),
  'National Hanok Center opening facts and applied lightweight grammar render in Product References');
  const auriNight = reference.items.find((item) => item.title.includes('국가한옥센터(AURI) 한옥DB'));
  const folkNight = reference.items.find((item) => item.title.includes('빛으로 밝히고 조명으로 통하다'));
  pass(auriNight?.text.includes('창호지를 실내 쪽에 붙이고')
      && auriNight.text.includes('실제 고정 한지 면')
      && auriNight.text.includes('주간 채광 설명을 밤의 정확한 외부 밝기·색·점등 빈도로 확대하지 않는다')
      && auriNight.links.some((url) => url.includes('hanokdb.kr/theology/sub_03'))
      && auriNight.license.includes('All rights reserved'),
  'AURI hanji-plane evidence, limit, canonical link, and license stay in one Reference item');
  pass(folkNight?.text.includes('작은 연소 광원')
      && folkNight.text.includes('일부 거주 창호만 seed-stable하게 켜고 어두운 방')
      && folkNight.text.includes('정확한 색·밝기·flicker·점등 비율은 사료값이 아니라')
      && folkNight.text.includes('깊이 가림')
      && folkNight.links.some((url) => url.includes('webzine.nfm.go.kr/2018/09/06/'))
      && folkNight.license.includes('원문·전시 사진은 재배포하지 않는다'),
  'folk-light vocabulary, product limits, canonical link, and license stay in one Reference item');
  pass(reference.text.includes('법적 상한·규범')
      && reference.text.includes('17배 필지 비례')
      && reference.links.some((url) => url.includes('contents.history.go.kr/front/km/view.do')),
  'enhanced house/lot legal-limit evidence and non-literal use render in Product References');
  pass(reference.text.includes('Wikimedia Commons · Bernard Gagnon — 낙안읍성 흙길·마당')
      && reference.text.includes('사진 픽셀이나 자국을 복제하지 않고')
      && reference.links.some((url) => url.includes('Naganeupseong_Village_06.jpg'))
      && reference.links.some((url) => url.includes('Naganeupseong_Village_08.jpg')),
  'packed-earth visual evidence, non-copying use, and CC0 source links render in Product References');
  const sijeonEvidence = reference.items.find((item) => (
    item.title.includes('한양 시전행랑의 칸·표식·발굴 유구')
  ));
  pass(sijeonEvidence?.text.includes('기존 위치·footprint를 보존한 순수 2칸 계획')
      && sijeonEvidence.text.includes('bench·개방 비율·후면 저장·모든 수치는 제품 결정')
      && sijeonEvidence.text.includes('정확한 형식이 불확실하므로 rendered v1에서는 제외')
      && sijeonEvidence.links.some((url) => url.includes('km_003_0040_0020_0010'))
      && sijeonEvidence.links.some((url) => url.includes('arcvGroupNo=2177'))
      && sijeonEvidence.anchors.every((anchor) => (
        anchor.target === '_blank'
          && anchor.rel.split(/\s+/).includes('noopener')
          && anchor.rel.split(/\s+/).includes('noreferrer')
      ))
      && sijeonEvidence.license.includes('All rights reserved'),
  'sijeon evidence, product limits, canonical links, and safe external-link attributes render in Product References');
  const yardLifeEvidence = reference.items.find((item) => (
    item.title.includes('계절 농가 마당 생활 / Seasonal rural-yard life')
  ));
  pass(yardLifeEvidence?.text.includes('선택된 소수 일반 농가에만')
      && yardLifeEvidence.text.includes('실제 못자리는 주택 마당에 만들지 않고')
      && yardLifeEvidence.text.includes('모든 수치, 겨울 장작의 선택 짚 덮개는 충돌 안전·가독성·기후 동선을 위한 명시적 제품 해석이며 역사적 평균이나 전국 표준이 아니다')
      && yardLifeEvidence.links.some((url) => url.includes('nfm.go.kr/home/subIndex/11.do'))
      && yardLifeEvidence.links.some((url) => url.includes('/2021/09/01/'))
      && yardLifeEvidence.links.some((url) => url.includes('press_190905.pdf'))
      && yardLifeEvidence.links.some((url) => url.includes('/2021/07/30/'))
      && yardLifeEvidence.links.some((url) => url.includes('km_036_0050_0040_0030_0020'))
      && yardLifeEvidence.anchors.every((anchor) => (
        anchor.target === '_blank'
          && anchor.rel.split(/\s+/).includes('noopener')
          && anchor.rel.split(/\s+/).includes('noreferrer')
      ))
      && yardLifeEvidence.license.includes('All rights reserved'),
  'yard-life evidence, sparse scope, rejected anachronisms, product limits, and safe links render in Product References');
  const mudWallEvidence = reference.items.find((item) => (
    item.title.includes('판담·판축과 돌 하부 / Formed earth walls and stone bases')
  ));
  const mudWallMoisture = reference.items.find((item) => (
    item.title.includes('토벽의 물·습기 거동 / Moisture behaviour of earthen walls')
  ));
  pass(mudWallEvidence?.text.includes('기존 mud 담장의 footprint·낮은 돌 굽·coping을 보존')
      && mudWallEvidence.text.includes('실측 복원이나 전국 표준이 아닌 seed-stable 제품 해석')
      && mudWallEvidence.text.includes('규칙적 벽돌 줄눈, 깊은 장식 홈')
      && mudWallEvidence.links.some((url) => url.includes('encykorea.aks.ac.kr/Article/E0013772'))
      && mudWallEvidence.links.some((url) => url.includes('idx=8681'))
      && mudWallEvidence.links.some((url) => url.includes('ctptNo=4413802600000'))
      && mudWallMoisture?.text.includes('생성 시점에 고정되는 희미하고 불규칙한 하부 darkening')
      && mudWallMoisture.text.includes('live rain tween은 후속 비대상이다')
      && mudWallMoisture.links.some((url) => url.includes('terra_literature_review.html'))
      && [...mudWallEvidence.anchors, ...mudWallMoisture.anchors].every((anchor) => (
        anchor.target === '_blank'
          && anchor.rel.split(/\s+/).includes('noopener')
          && anchor.rel.split(/\s+/).includes('noreferrer')
      ))
      && mudWallEvidence.license.includes('공공누리 제4유형')
      && mudWallMoisture.license.includes('J. Paul Getty Trust'),
  'mud-wall evidence, conservative scope, static moisture limit, canonical links, and safe attributes render in Product References');
  const drainageEvidence = reference.items.find((item) => item.topic === 'drainage');
  pass(drainageEvidence?.title.includes('조선 길가 배수와 제한적 마을 수로')
      && drainageEvidence.text.includes('Hanyang 계획가로에는 최대 양측')
      && drainageEvidence.text.includes('일반 hamlet/village/town은 none')
      && drainageEvidence.text.includes('stone-slab')
      && drainageEvidence.text.includes('실시간 빗물 수위·유량·침수 시뮬레이션은 이번 범위에 넣지 않는다')
      && drainageEvidence.links.some((url) => url.includes('nh_024_0060_0010_0010'))
      && drainageEvidence.links.some((url) => url.includes('annex_insadosi_02.jsp'))
      && drainageEvidence.links.some((url) => url.includes('Heritage_99_08.jsp'))
      && drainageEvidence.anchors.every((anchor) => (
        anchor.target === '_blank'
          && anchor.rel.split(/\s+/).includes('noopener')
          && anchor.rel.split(/\s+/).includes('noreferrer')
      )),
  'drainage evidence, bounded city scope, product crossing limits, canonical links, and safe attributes render in Product References');
  const mjaHanokEvidence = reference.items.find((item) => item.topic === 'mja-hanok');
  pass(mjaHanokEvidence?.title.includes('안동문화권 ㅁ자형 뜰집의 지역·기후·계층 한계')
      && mjaHanokEvidence.text.includes('일반 주택의 ㅁ자는 기본 off')
      && mjaHanokEvidence.text.includes('기와집 fitted frame')
      && mjaHanokEvidence.text.includes('기존 30° 겨울 일조 계약')
      && mjaHanokEvidence.text.includes('좌우 익사와 중문채')
      && mjaHanokEvidence.text.includes('독립 팔작 다섯 채와 별도 솟을대문을 겹치지 않는다')
      && mjaHanokEvidence.text.includes('weather·위도·rank·wealth 자동 선택')
      && mjaHanokEvidence.text.includes('튼ㅁ자·겹집·궁 행각·사찰 배치의 혼용은 배제')
      && MJA_HANOK_REFERENCE_URLS.every((url) => mjaHanokEvidence.links.includes(url))
      && mjaHanokEvidence.links.length === MJA_HANOK_REFERENCE_URLS.length
      && mjaHanokEvidence.anchors.every((anchor) => (
        anchor.target === '_blank'
          && anchor.rel.split(/\s+/).includes('noopener')
          && anchor.rel.split(/\s+/).includes('noreferrer')
      ))
      && mjaHanokEvidence.license.includes('CC BY-NC 4.0'),
  'mja-hanok evidence, roof/gate topology, six canonical links, and safe attributes render in Product References');

  await closeReference.click();
  await referenceDialog.waitFor({ state: 'detached', timeout });
  await page.waitForFunction((trigger) => document.activeElement === trigger, await referenceInfoTrigger.elementHandle(), { timeout });
  pass(await referenceInfoTrigger.evaluate((trigger) => document.activeElement === trigger),
    'closing References returns focus to the exact info trigger');

  await referenceInfoTrigger.press('Enter');
  await referenceDialog.waitFor({ state: 'visible', timeout });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => {
    const dialog = document.querySelector('[role="dialog"]');
    return dialog?.classList.contains('sheet')
      && Math.abs(innerHeight - dialog.getBoundingClientRect().bottom) < 1;
  }, null, { timeout });
  const mobileReference = await referenceDialog.evaluate((dialog) => {
    const scroll = dialog.querySelector('.scroll');
    const rect = dialog.getBoundingClientRect();
    const before = scroll.scrollTop;
    scroll.scrollTop = Math.min(240, scroll.scrollHeight - scroll.clientHeight);
    return {
      sheet: dialog.classList.contains('sheet'),
      left: rect.left,
      right: innerWidth - rect.right,
      bottom: innerHeight - rect.bottom,
      height: rect.height,
      viewportHeight: innerHeight,
      scrollable: scroll.scrollHeight > scroll.clientHeight,
      scrolled: scroll.scrollTop > before,
      bodyScroll: scrollY,
      surfaceInert: document.querySelector('[data-app-surface]')?.inert === true,
      focusInside: dialog.contains(document.activeElement),
    };
  });
  pass(mobileReference.sheet
      && Math.abs(mobileReference.left) < 1
      && Math.abs(mobileReference.right) < 1
      && Math.abs(mobileReference.bottom) < 1
      && mobileReference.height < mobileReference.viewportHeight
      && mobileReference.scrollable
      && mobileReference.scrolled
      && mobileReference.bodyScroll === 0
      && mobileReference.surfaceInert
      && mobileReference.focusInside,
  `390x844 References sheet stays bounded and owns scrolling (${JSON.stringify(mobileReference)})`);
  await referenceDialog.getByRole('button', { name: '닫기' }).click();
  await referenceDialog.waitFor({ state: 'detached', timeout });
  await page.waitForFunction(() => {
    const surface = document.querySelector('[data-app-surface]');
    return document.activeElement === surface
      && surface?.inert === false
      && !surface.hasAttribute('aria-hidden');
  }, null, { timeout });
  const mobileCloseFallback = await page.locator('[data-app-surface]').evaluate((surface) => ({
    focused: document.activeElement === surface,
    inert: surface.inert,
    hidden: surface.getAttribute('aria-hidden'),
  }));
  pass(mobileCloseFallback.focused
      && !mobileCloseFallback.inert
      && mobileCloseFallback.hidden == null,
  `References close without a mounted trigger restores the active app surface after inert clears (${JSON.stringify(mobileCloseFallback)})`);

  await page.setViewportSize({ width: 1280, height: 800 });
  await referenceInfoTrigger.waitFor({ state: 'visible', timeout });
  const remountInfoOpener = await referenceInfoTrigger.elementHandle();
  await referenceInfoTrigger.press('Enter');
  await referenceDialog.waitFor({ state: 'visible', timeout });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => document.querySelector('[role="dialog"]')?.classList.contains('sheet'), null, { timeout });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForFunction(() => !document.querySelector('[role="dialog"]')?.classList.contains('sheet'), null, { timeout });
  const responsiveInfoFallback = await referenceInfoTrigger.elementHandle();
  const responsiveOpenerReplaced = await page.evaluate(
    ({ opener, fallback }) => opener !== fallback,
    { opener: remountInfoOpener, fallback: responsiveInfoFallback },
  );
  await referenceDialog.getByRole('button', { name: '닫기' }).click();
  await referenceDialog.waitFor({ state: 'detached', timeout });
  await page.waitForFunction(
    (trigger) => document.activeElement === trigger,
    responsiveInfoFallback,
    { timeout },
  );
  pass(responsiveOpenerReplaced
      && await referenceInfoTrigger.evaluate((trigger) => document.activeElement === trigger),
  'responsive References close returns focus to the remounted equivalent info trigger');

  // #114: the persistent native navigator is the keyboard alternative to
  // pointer-only scene picking. Candidate data must be stable JSON from the
  // existing pick-proxy address space, never a second UI-side scene traversal.
  const buildingNavigation = page.locator('[data-building-navigation]');
  const buildingSelect = buildingNavigation.locator('select');
  const buildingAction = buildingNavigation.locator('button.navaction');
  await buildingNavigation.waitFor({ state: 'visible', timeout });
  const navigationContract = await page.evaluate(() => {
    const first = window.__engine.village.navigationTargets();
    const second = window.__engine.village.navigationTargets();
    const options = [...document.querySelectorAll('[data-building-navigation] option')]
      .map((option) => option.value);
    return {
      first,
      second,
      options,
      parcelIds: window.__engine.village.debugParcels().map((parcel) => parcel.parcelId),
      json: JSON.parse(JSON.stringify(first)),
      keys: first.map((target) => Object.keys(target).sort()),
    };
  });
  pass(navigationContract.first.length > 1
      && navigationContract.first.length === new Set(navigationContract.first.map((target) => target.id)).size
      && navigationContract.first.every((target, index) => (
        target.id === navigationContract.parcelIds[index]
        && navigationContract.keys[index].join() === 'id,type'
      ))
      && JSON.stringify(navigationContract.first) === JSON.stringify(navigationContract.second)
      && JSON.stringify(navigationContract.first) === JSON.stringify(navigationContract.json)
      && JSON.stringify(navigationContract.options) === JSON.stringify(
        navigationContract.first.map((target) => target.id),
      ),
  `building navigation preserves pick-proxy order as duplicate-free JSON-only targets (${JSON.stringify({
    count: navigationContract.first.length,
    first: navigationContract.first.slice(0, 4),
  })})`);
  if (captureDir) {
    await page.screenshot({ path: join(captureDir, 'building-navigation-desktop.png') });
  }

  await page.evaluate(() => {
    const events = [];
    const engine = window.__engine;
    const offs = [
      engine.on('villageSelectStart', ({ parcelId }) => events.push(`start:${parcelId}`)),
      engine.on('villageSelect', ({ parcelId }) => events.push(`done:${parcelId}`)),
      engine.on('villageReturn', ({ parcelId }) => events.push(`return:${parcelId}`)),
      engine.on('villageReturnDone', ({ parcelId }) => events.push(`returned:${parcelId}`)),
    ];
    window.__buildingNavigationAudit = { events, dispose: () => offs.forEach((off) => off()) };
  });
  await buildingSelect.focus();
  await page.keyboard.press('Home');
  const keyboardTargetA = await buildingSelect.inputValue();
  const selectFocusRing = await buildingSelect.evaluate((select) => {
    const style = getComputedStyle(select);
    return { width: style.outlineWidth, style: style.outlineStyle };
  });
  await page.keyboard.press('Tab');
  const actionBeforeFocus = await buildingAction.evaluate((button) => ({
    active: document.activeElement === button,
    label: button.getAttribute('aria-label'),
    disabled: button.getAttribute('aria-disabled'),
  }));
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter'); // busy guard: no duplicate transition
  await page.waitForFunction((parcelId) => {
    const state = window.__engine.village.getState();
    return state.selected === parcelId && !state.transitioning;
  }, keyboardTargetA, { timeout });
  const keyboardFocusA = await buildingNavigation.evaluate((navigation) => ({
    activeAction: document.activeElement === navigation.querySelector('button.navaction'),
    actionDisabled: navigation.querySelector('button.navaction')?.getAttribute('aria-disabled'),
    selectDisabled: navigation.querySelector('select')?.disabled,
    status: navigation.querySelector('[role="status"]')?.textContent?.replace(/\s+/g, ' ').trim(),
    events: window.__buildingNavigationAudit.events.slice(),
  }));
  pass(selectFocusRing.style !== 'none'
      && Number.parseFloat(selectFocusRing.width) >= 2
      && actionBeforeFocus.active
      && actionBeforeFocus.label?.includes(':')
      && actionBeforeFocus.disabled === 'false'
      && keyboardFocusA.activeAction
      && keyboardFocusA.actionDisabled === 'true'
      && !keyboardFocusA.selectDisabled
      && keyboardFocusA.status?.includes('현재 보고 있는 건물')
      && keyboardFocusA.events.filter((event) => event === `start:${keyboardTargetA}`).length === 1
      && keyboardFocusA.events.filter((event) => event === `done:${keyboardTargetA}`).length === 1,
  `keyboard-only aerial focus keeps a visible focus ring, live status, and one activation (${JSON.stringify({
    target: keyboardTargetA,
    before: actionBeforeFocus,
    after: keyboardFocusA,
    focusRing: selectFocusRing,
  })})`);

  // Playwright cannot drive Chrome/macOS's out-of-process native select popup
  // with synthetic Arrow keys. Commit the real select's change event through
  // selectOption, then keep the product transition and return keyboard-only.
  await buildingSelect.selectOption(navigationContract.first.at(-1).id);
  await buildingSelect.focus();
  const keyboardTargetB = await buildingSelect.inputValue();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.waitForFunction((parcelId) => {
    const state = window.__engine.village.getState();
    return state.selected === parcelId && !state.transitioning;
  }, keyboardTargetB, { timeout });
  const keyboardHop = await buildingNavigation.evaluate((navigation) => ({
    activeAction: document.activeElement === navigation.querySelector('button.navaction'),
    status: navigation.querySelector('[role="status"]')?.textContent?.replace(/\s+/g, ' ').trim(),
    events: window.__buildingNavigationAudit.events.slice(),
  }));
  pass(keyboardTargetB !== keyboardTargetA
      && keyboardHop.activeAction
      && keyboardHop.status?.includes('현재 보고 있는 건물')
      && keyboardHop.events.filter((event) => event === `start:${keyboardTargetB}`).length === 1
      && keyboardHop.events.filter((event) => event === `done:${keyboardTargetB}`).length === 1,
  `native-selector focus hop uses keyboard activation without duplicate busy work (${JSON.stringify({
    from: keyboardTargetA,
    to: keyboardTargetB,
    events: keyboardHop.events,
  })})`);

  await page.keyboard.press('Escape');
  await page.waitForFunction(() => {
    const state = window.__engine.village.getState();
    return !state.selected && !state.transitioning;
  }, null, { timeout });
  const keyboardReturn = await buildingNavigation.evaluate((navigation) => ({
    activeAction: document.activeElement === navigation.querySelector('button.navaction'),
    status: navigation.querySelector('[role="status"]')?.textContent?.replace(/\s+/g, ' ').trim(),
    events: window.__buildingNavigationAudit.events.slice(),
  }));
  pass(keyboardReturn.activeAction
      && keyboardReturn.status?.includes('둘러보기에서 선택할 수 있습니다')
      && keyboardReturn.events.filter((event) => event.startsWith('return:')).length === 1
      && keyboardReturn.events.filter((event) => event.startsWith('returned:')).length === 1,
  `keyboard Escape returns to Explore while preserving navigator focus (${JSON.stringify(keyboardReturn)})`);

  // Reduced motion finishes through the same camera tween on its first render
  // advance. A synchronous completion would invert or collapse consumer event
  // ordering, so inspect the event list in the same click task and then await
  // the resulting product completion. Shader warm-up precedes that first
  // advance, so host scheduling may delay wall time without changing ordering.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await buildingSelect.focus();
  await page.keyboard.press('Home');
  const reducedTarget = await buildingSelect.inputValue();
  await page.keyboard.press('Tab');
  const reducedImmediate = await buildingAction.evaluate((button) => {
    const audit = window.__buildingNavigationAudit;
    audit.events.length = 0;
    const startedAt = performance.now();
    button.click();
    return {
      startedAt,
      events: audit.events.slice(),
      active: document.activeElement === button,
    };
  });
  await page.waitForFunction((parcelId) => {
    const state = window.__engine.village.getState();
    return state.selected === parcelId && !state.transitioning;
  }, reducedTarget, { timeout: Math.min(timeout, 10_000) });
  const reducedEvidence = await page.evaluate((startedAt) => ({
    elapsed: performance.now() - startedAt,
    events: window.__buildingNavigationAudit.events.slice(),
  }), reducedImmediate.startedAt);
  pass(reducedImmediate.active
      && reducedImmediate.events.length === 1
      && reducedImmediate.events[0] === `start:${reducedTarget}`
      && reducedEvidence.events.join() === `start:${reducedTarget},done:${reducedTarget}`,
  `reduced-motion focus is asynchronous but settles on the next tween frame (${JSON.stringify({
    immediate: reducedImmediate,
    complete: reducedEvidence,
  })})`);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => {
    const state = window.__engine.village.getState();
    return !state.selected && !state.transitioning;
  }, null, { timeout: Math.min(timeout, 10_000) });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.evaluate(() => {
    window.__buildingNavigationAudit.dispose();
    delete window.__buildingNavigationAudit;
  });

  // ContextPanel keeps both visual subtrees mounted for its camera-synchronised crossfade, but
  // only one may own keyboard/accessibility input. Inspect direct ownership separately from the
  // app-surface inert inherited while References is open.
  const contextA11y = (owner) => page.evaluate((expectedOwner) => {
    const roots = [...document.querySelectorAll('[data-context-owner]')];
    const active = document.activeElement;
    return {
      directOwners: [...new Set(roots.filter((root) => !root.inert).map((root) => root.dataset.contextOwner))],
      inactiveInert: roots.filter((root) => root.dataset.contextOwner !== expectedOwner)
        .every((root) => root.inert && root.getAttribute('aria-hidden') === 'true'),
      activeClear: !active?.closest('[inert]'),
      activeOwner: active?.closest('[data-context-owner]')?.dataset.contextOwner || null,
      inNavigation: !!active?.closest('[data-building-navigation]'),
      focusTarget: active?.dataset?.contextFocus || null,
      effectiveOwners: [...new Set(roots
        .filter((root) => !root.closest('[inert]'))
        .map((root) => root.dataset.contextOwner))],
    };
  }, owner);
  const seekViewTransition = async (progress, finish = false) => {
    await page.waitForFunction(() => window.__engine.debugDof().tweenProgress != null, null, { timeout });
    await page.evaluate(({ progress: value, finish: done }) => {
      window.__engine.debugDofSeek(value, { finish: done });
    }, { progress, finish });
  };

  await page.locator('[data-context-focus="village"]').focus();
  await page.keyboard.press('Tab');
  const desktopAerialOwner = await contextA11y('village');
  pass(desktopAerialOwner.directOwners.join() === 'village'
      && desktopAerialOwner.inactiveInert
      && desktopAerialOwner.activeClear
      && desktopAerialOwner.activeOwner == null
      && desktopAerialOwner.inNavigation,
  `desktop aerial Tab enters the persistent building navigator before the visible village controls (${JSON.stringify(desktopAerialOwner)})`);

  const contextParcel = await page.evaluate(() => (
    window.__engine.village.debugParcels().find((parcel) => !parcel.hero)?.parcelId
      || window.__engine.village.debugParcels()[0]?.parcelId
  ));
  await page.evaluate(() => {
    const audit = { count: 0, off: null };
    audit.off = window.__engine.on('viewSettled', () => { audit.count += 1; });
    window.__sceneGuideSettleAudit = audit;
  });
  await page.locator('.ctx.village input.scale').focus();
  await page.mouse.move(640, 120);
  await page.mouse.down();
  await page.mouse.move(666, 126, { steps: 2 });
  // Pointer capture moves focus to the canvas. Restore the outgoing control so
  // this existing accessibility assertion can still observe the context handoff
  // while the physical orbit gesture remains held.
  await page.locator('.ctx.village input.scale').focus();
  await page.evaluate(() => new Promise((resolveFrame) => (
    requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)))
  )));
  const heldBeforeFocus = await page.evaluate(() => window.__sceneGuideSettleAudit.count);
  await page.evaluate((parcelId) => window.__engine.village.debugFocus(parcelId), contextParcel);
  await seekViewTransition(0.6);
  await page.waitForFunction(() => document.activeElement?.dataset?.contextFocus === 'house', null, { timeout });
  const desktopHouseOwner = await contextA11y('house');
  await page.keyboard.press('Tab');
  const desktopHouseTabOwner = await contextA11y('house');
  pass(desktopHouseOwner.directOwners.join() === 'house'
      && desktopHouseOwner.inactiveInert
      && desktopHouseOwner.focusTarget === 'house'
      && desktopHouseTabOwner.activeOwner == null
      && desktopHouseTabOwner.inNavigation,
  `desktop focus crossfade hands village focus to the house breadcrumb, then enters the persistent navigator (${JSON.stringify({
    handoff: desktopHouseOwner,
    tab: desktopHouseTabOwner,
  })})`);
  await seekViewTransition(1, true);
  const heldAfterFocus = await page.evaluate(() => window.__sceneGuideSettleAudit.count);
  await page.mouse.up();
  await page.waitForFunction(() => window.__sceneGuideSettleAudit?.count === 1, null, { timeout });
  const focusSettles = await page.evaluate(() => window.__sceneGuideSettleAudit.count);
  pass(heldBeforeFocus === 0 && heldAfterFocus === 0 && focusSettles === 1,
    `held orbit input defers a completed focus until pointer-up, then publishes once (${JSON.stringify({
      heldBeforeFocus,
      heldAfterFocus,
      focusSettles,
    })})`);

  await page.locator('[data-context-focus="house"]').focus();
  await page.evaluate(() => window.__engine.village.return());
  await seekViewTransition(0.6);
  await page.waitForFunction(() => document.activeElement?.dataset?.contextFocus === 'village', null, { timeout });
  const desktopReturnOwner = await contextA11y('village');
  pass(desktopReturnOwner.directOwners.join() === 'village'
      && desktopReturnOwner.inactiveInert
      && desktopReturnOwner.focusTarget === 'village',
  `desktop return crossfade hands house focus to the village heading (${JSON.stringify(desktopReturnOwner)})`);
  await seekViewTransition(1, true);
  const returnSettles = await page.evaluate(() => {
    const audit = window.__sceneGuideSettleAudit;
    const count = audit.count;
    audit.off?.();
    delete window.__sceneGuideSettleAudit;
    return {
      count,
      guideVisible: !!document.querySelector('[data-scene-guide]'),
      stored: localStorage.getItem('cheoma-scene-guide-v1'),
    };
  });
  pass(returnSettles.count === 2
      && !returnSettles.guideVisible
      && returnSettles.stored === SCENE_GUIDE_DISMISSED_VALUE,
  `aerial return publishes one more settled view without reviving the guide (${JSON.stringify(returnSettles)})`);

  // A modal is the outer owner: a simultaneous context transition may update which subtree is
  // ready underneath it, but must not steal focus through the inert app surface.
  await referenceInfoTrigger.press('Enter');
  await referenceDialog.waitFor({ state: 'visible', timeout });
  await page.waitForFunction(() => document.activeElement?.id === 'reference-modal-title', null, { timeout });
  await page.evaluate((parcelId) => window.__engine.village.debugFocus(parcelId), contextParcel);
  await seekViewTransition(0.6);
  const nestedContextOwner = await contextA11y('house');
  const nestedModalOwner = await referenceDialog.evaluate((dialog) => ({
    focusInside: dialog.contains(document.activeElement),
    surfaceInert: document.querySelector('[data-app-surface]')?.inert === true,
    navigationInert: !!document.querySelector('[data-building-navigation]')?.closest('[inert]'),
  }));
  pass(nestedContextOwner.directOwners.join() === 'house'
      && nestedContextOwner.inactiveInert
      && nestedContextOwner.effectiveOwners.length === 0
      && nestedModalOwner.focusInside
      && nestedModalOwner.surfaceInert
      && nestedModalOwner.navigationInert,
  `References remains the sole effective owner during a context crossfade (${JSON.stringify({
    context: nestedContextOwner,
    modal: nestedModalOwner,
  })})`);
  await referenceDialog.getByRole('button', { name: '닫기' }).click();
  await referenceDialog.waitFor({ state: 'detached', timeout });
  await seekViewTransition(1, true);
  await page.evaluate(() => window.__engine.village.return());
  await seekViewTransition(1, true);

  // The mobile context sheet starts at peek: only its visible grip is interactive. Expanded
  // content regains ownership, and a programmatic collapse recovers focused content to the grip.
  await page.setViewportSize({ width: 390, height: 844 });
  const contextSheet = page.locator('.sheet.context');
  await page.waitForFunction(() => document.querySelector('.sheet.context')?.dataset.snap === 'peek', null, { timeout });
  const mobileAerialShare = page.locator('.actions [data-action="share"]');
  await mobileAerialShare.waitFor({ state: 'visible', timeout });
  const mobileAerialShareLayout = await mobileAerialShare.evaluate((button) => {
    const rect = button.getBoundingClientRect();
    const sheet = document.querySelector('.sheet.context')?.getBoundingClientRect();
    const overlap = sheet
      ? Math.max(0, Math.min(rect.right, sheet.right) - Math.max(rect.left, sheet.left))
        * Math.max(0, Math.min(rect.bottom, Math.min(sheet.bottom, innerHeight)) - Math.max(rect.top, sheet.top))
      : 0;
    return {
      count: document.querySelectorAll('[data-action="share"]').length,
      left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
      width: rect.width, height: rect.height,
      sheetTop: sheet?.top ?? null,
      viewport: [innerWidth, innerHeight],
      sheetOverlap: overlap,
    };
  });
  pass(mobileAerialShareLayout.count === 1
      && mobileAerialShareLayout.width >= 44
      && mobileAerialShareLayout.height >= 44
      && mobileAerialShareLayout.left >= 0
      && mobileAerialShareLayout.top >= 0
      && mobileAerialShareLayout.right <= 390
      && mobileAerialShareLayout.bottom <= 844
      && mobileAerialShareLayout.sheetOverlap === 0,
  `390x844 aerial share action is unique, bounded, and clear of the peek sheet (${JSON.stringify(mobileAerialShareLayout)})`);
  if (captureDir) {
    await page.screenshot({ path: join(captureDir, 'share-mobile-aerial.png') });
  }
  const contextGrip = contextSheet.locator('.grip');
  const mobilePeek = await contextSheet.evaluate((sheet) => ({
    snap: sheet.dataset.snap,
    sheetInert: sheet.inert,
    contentInert: [...sheet.querySelectorAll('[data-sheet-content]')]
      .every((part) => part.inert && part.getAttribute('aria-hidden') === 'true'),
  }));
  await contextGrip.focus();
  await page.keyboard.press('Tab');
  const peekTabSkippedContent = await page.evaluate(() => !document.activeElement?.closest('[data-sheet-content]'));
  pass(mobilePeek.snap === 'peek'
      && !mobilePeek.sheetInert
      && mobilePeek.contentInert
      && peekTabSkippedContent,
  `mobile peek exposes only its visible grip to Tab (${JSON.stringify(mobilePeek)})`);

  await contextGrip.press('Enter');
  await page.waitForFunction(() => document.querySelector('.sheet.context')?.dataset.snap === 'half'
    && [...document.querySelectorAll('.sheet.context [data-sheet-content]')].every((part) => !part.inert), null, { timeout });
  await page.waitForFunction(() => {
    const sheet = document.querySelector('.sheet.context');
    return sheet && sheet.getBoundingClientRect().top < innerHeight * 0.6;
  }, null, { timeout });
  const mobileNavigationLayout = await buildingNavigation.evaluate((navigation) => {
    const rect = navigation.getBoundingClientRect();
    const sheet = navigation.closest('.sheet')?.getBoundingClientRect();
    const footer = navigation.closest('.sheet')?.querySelector('.sheetfoot')?.getBoundingClientRect();
    const select = navigation.querySelector('select')?.getBoundingClientRect();
    const action = navigation.querySelector('button')?.getBoundingClientRect();
    const overlap = footer
      ? Math.max(0, Math.min(rect.right, footer.right) - Math.max(rect.left, footer.left))
        * Math.max(0, Math.min(rect.bottom, footer.bottom) - Math.max(rect.top, footer.top))
      : 0;
    return {
      bounds: [rect.left, rect.top, rect.right, rect.bottom],
      sheet: sheet ? [sheet.left, sheet.top, sheet.right, Math.min(sheet.bottom, innerHeight)] : null,
      select: select ? [select.width, select.height] : null,
      action: action ? [action.width, action.height] : null,
      footerOverlap: overlap,
      viewport: [innerWidth, innerHeight],
    };
  });
  pass(mobileNavigationLayout.sheet
      && mobileNavigationLayout.bounds[0] >= mobileNavigationLayout.sheet[0]
      && mobileNavigationLayout.bounds[1] >= mobileNavigationLayout.sheet[1]
      && mobileNavigationLayout.bounds[2] <= mobileNavigationLayout.sheet[2]
      && mobileNavigationLayout.bounds[3] <= mobileNavigationLayout.sheet[3]
      && mobileNavigationLayout.select?.[1] >= 44
      && mobileNavigationLayout.action?.[1] >= 44
      && mobileNavigationLayout.footerOverlap === 0,
  `390x844 expanded sheet keeps the building navigator visible, 44px, and clear of sticky actions (${JSON.stringify(mobileNavigationLayout)})`);
  if (captureDir) {
    await page.screenshot({ path: join(captureDir, 'building-navigation-mobile.png') });
  }
  await page.locator('.ctx.village input.scale').focus();
  await contextGrip.evaluate((grip) => grip.click());
  await page.waitForFunction(() => document.querySelector('.sheet.context')?.dataset.snap === 'peek'
    && document.activeElement?.classList.contains('grip'), null, { timeout });
  const mobileCollapseFocus = await contextSheet.evaluate((sheet) => ({
    snap: sheet.dataset.snap,
    gripFocused: document.activeElement === sheet.querySelector('.grip'),
    contentInert: [...sheet.querySelectorAll('[data-sheet-content]')].every((part) => part.inert),
  }));
  pass(mobileCollapseFocus.snap === 'peek'
      && mobileCollapseFocus.gripFocused
      && mobileCollapseFocus.contentInert,
  `mobile collapse recovers content focus to the visible grip (${JSON.stringify(mobileCollapseFocus)})`);

  await contextGrip.press('Enter');
  await page.waitForFunction(() => document.querySelector('.sheet.context')?.dataset.snap === 'half', null, { timeout });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.locator('.ctx.village input.scale').focus();
  await page.evaluate((parcelId) => window.__engine.village.debugFocus(parcelId), contextParcel);
  await page.waitForFunction((parcelId) => {
    const state = window.__engine.village.getState();
    return state.selected === parcelId && !state.transitioning;
  }, contextParcel, { timeout });
  await page.waitForFunction(() => document.activeElement?.dataset?.contextFocus === 'house', null, { timeout });
  const mobileReducedOwner = await contextA11y('house');
  const mobileReducedTransition = await contextSheet.evaluate((sheet) => (
    Number.parseFloat(getComputedStyle(sheet).transitionDuration) || 0
  ));
  const mobileFocusShare = contextSheet.locator('.foot.house [data-action="share"]');
  await mobileFocusShare.waitFor({ state: 'visible', timeout });
  const mobileFocusShareLayout = await mobileFocusShare.evaluate((button) => {
    const rect = button.getBoundingClientRect();
    const sheet = button.closest('.sheet')?.getBoundingClientRect();
    const sibling = button.parentElement?.querySelector('.hbtn.reroll')?.getBoundingClientRect();
    const siblingOverlap = sibling
      ? Math.max(0, Math.min(rect.right, sibling.right) - Math.max(rect.left, sibling.left))
        * Math.max(0, Math.min(rect.bottom, sibling.bottom) - Math.max(rect.top, sibling.top))
      : 0;
    return {
      count: document.querySelectorAll('[data-action="share"]').length,
      inStickyFooter: !!button.closest('.sheetfoot'),
      owner: button.closest('[data-context-owner]')?.dataset.contextOwner || null,
      globalActionBar: document.querySelectorAll('.actions').length,
      left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
      width: rect.width, height: rect.height,
      sheetLeft: sheet?.left ?? null,
      sheetRight: sheet?.right ?? null,
      viewport: [innerWidth, innerHeight],
      siblingOverlap,
    };
  });
  pass(mobileReducedOwner.directOwners.join() === 'house'
      && mobileReducedOwner.inactiveInert
      && mobileReducedOwner.focusTarget === 'house'
      && mobileReducedTransition <= 0.001,
  `reduced-motion mobile focus keeps one owner without restoring long sheet motion (${JSON.stringify({
    owner: mobileReducedOwner,
    transition: mobileReducedTransition,
  })})`);
  pass(mobileFocusShareLayout.count === 1
      && mobileFocusShareLayout.inStickyFooter
      && mobileFocusShareLayout.owner === 'house'
      && mobileFocusShareLayout.globalActionBar === 0
      && mobileFocusShareLayout.width >= 44
      && mobileFocusShareLayout.height >= 44
      && mobileFocusShareLayout.left >= mobileFocusShareLayout.sheetLeft
      && mobileFocusShareLayout.right <= mobileFocusShareLayout.sheetRight
      && mobileFocusShareLayout.top >= 0
      && mobileFocusShareLayout.bottom <= 844
      && mobileFocusShareLayout.siblingOverlap === 0,
  `390x844 focus share moves into the visible sticky house owner without a global duplicate (${JSON.stringify(mobileFocusShareLayout)})`);
  if (captureDir) {
    await page.screenshot({ path: join(captureDir, 'share-mobile-focus.png') });
  }
  await page.evaluate(() => window.__engine.village.return());
  await page.waitForFunction(() => {
    const state = window.__engine.village.getState();
    return !state.selected && !state.transitioning;
  }, null, { timeout });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForFunction(() => window.__device?.sheet === false
    && !!document.querySelector('.ctxcard:not([inert])'), null, { timeout });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

  await page.locator('.ctx.village input.scale').focus();
  const panelHideStarted = await page.evaluate(() => window.__engine.cine.start('drone'));
  if (panelHideStarted) {
    await page.waitForFunction(() => {
      const panel = document.querySelector('.ctxcard');
      return panel?.inert && panel.getAttribute('aria-hidden') === 'true'
        && document.activeElement === document.querySelector('[data-app-surface]');
    }, null, { timeout: 10_000 });
  }
  const hiddenPanel = await page.locator('.ctxcard').evaluate((panel) => ({
    inert: panel.inert,
    hidden: panel.getAttribute('aria-hidden'),
    focusedSurface: document.activeElement === document.querySelector('[data-app-surface]'),
  }));
  pass(panelHideStarted
      && hiddenPanel.inert
      && hiddenPanel.hidden === 'true'
      && hiddenPanel.focusedSurface,
  `a fully hidden BottomSheet returns its focused control to the app surface (${JSON.stringify(hiddenPanel)})`);
  await page.evaluate(() => window.__engine.cine.stop());
  await page.waitForFunction(() => {
    const panel = document.querySelector('.ctxcard');
    return panel && !panel.inert && panel.getAttribute('aria-hidden') === 'false';
  }, null, { timeout });

  const modalEscapeParcel = await page.evaluate(() => {
    const engine = window.__engine;
    const parcelId = engine.village.debugParcels()[0]?.parcelId;
    engine.village.debugFocus(parcelId);
    if (engine.debugDof().tweenProgress != null) engine.debugDofSeek(1, { finish: true });
    return parcelId;
  });
  await page.waitForFunction((parcelId) => {
    const state = window.__engine.village.getState();
    return state.selected === parcelId && !state.transitioning;
  }, modalEscapeParcel, { timeout });
  const referenceBrandTrigger = page.locator('button.brand[aria-label="참고 자료"]');
  await referenceBrandTrigger.focus();
  const backgroundBeforeEscape = await page.evaluate(() => ({
    village: window.__engine.village.getState(),
    cine: window.__engine.cine.getState(),
  }));
  await referenceBrandTrigger.press('Enter');
  await referenceDialog.waitFor({ state: 'visible', timeout });
  await page.keyboard.press('Escape');
  await referenceDialog.waitFor({ state: 'detached', timeout });
  await page.waitForFunction((trigger) => document.activeElement === trigger, await referenceBrandTrigger.elementHandle(), { timeout });
  const backgroundAfterEscape = await page.evaluate(() => ({
    village: window.__engine.village.getState(),
    cine: window.__engine.cine.getState(),
  }));
  pass(backgroundAfterEscape.village.selected === backgroundBeforeEscape.village.selected
      && backgroundAfterEscape.village.transitioning === backgroundBeforeEscape.village.transitioning
      && backgroundAfterEscape.cine.active === backgroundBeforeEscape.cine.active
      && await referenceBrandTrigger.evaluate((trigger) => document.activeElement === trigger),
  'modal Escape closes only References, preserves the focused scene, and returns to the brand trigger');
  await page.evaluate(() => {
    const engine = window.__engine;
    engine.village.return();
    if (engine.debugDof().tweenProgress != null) engine.debugDofSeek(1, { finish: true });
  });

  // __SHOT_READY는 렌더 준비 신호이지 1.4초 진입 돌리의 완료 신호가 아니다. 실제 제품 tween의
  // onDone을 결정적으로 실행해 explore 줌 범위가 설치된 상태에서 보기 계약을 검사한다.
  await page.evaluate(() => {
    const engine = window.__engine;
    if (engine.debugDof().tweenProgress != null) engine.debugDofSeek(1, { finish: true });
  });

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
      && boot.continuum.mode === 'explore'
      && boot.continuum.exploreMinReferenceDist < boot.continuum.aerialReferenceDist
      && boot.continuum.exploreMaxReferenceDist >= boot.continuum.aerialReferenceDist
      && Number.isFinite(boot.camera.near),
    'village camera exposes valid aerial, zoom, and near-plane contracts',
  );

  const diversityRuntime = await page.evaluate(async ({ housesModuleUrl }) => {
    const parcels = window.__engine.village.debugParcels();
    const mirrored = parcels.find((parcel) => parcel.kind === 'giwa' && parcel.variant === 1);
    const mirrorStats = mirrored
      ? window.__engine.village.debugParcelStats(mirrored.parcelId, {})
      : null;

    const { buildKindDecomps } = await import(housesModuleUrl);
    const { decomps, matset } = buildKindDecomps('giwa');
    const canonical = new Set(decomps[0].map((entry) => entry.material));
    const allMaterials = new Set(decomps.flatMap((decomp) => decomp.map((entry) => entry.material)));
    const allTextures = new Set();
    for (const material of allMaterials) {
      for (const value of Object.values(material)) if (value?.isTexture) allTextures.add(value);
    }
    for (const value of Object.values(matset || {})) {
      if (value?.isTexture) allTextures.add(value);
      if (value?.isMaterial) {
        allMaterials.add(value);
        for (const property of Object.values(value)) if (property?.isTexture) allTextures.add(property);
      }
    }
    const result = {
      mirroredId: mirrored?.parcelId || null,
      mirrorX: mirrorStats?.mirrorX ?? null,
      lengths: decomps.map((decomp) => decomp.length),
      shared: decomps.map((decomp) => decomp.filter((entry) => canonical.has(entry.material)).length),
      hardwareEntries: decomps.map((decomp) => decomp.filter((entry) => (
        entry.material?.userData?.paletteKey === 'hardware'
      )).length),
      hardwareMaterials: new Set(decomps.flatMap((decomp) => decomp
        .filter((entry) => entry.material?.userData?.paletteKey === 'hardware')
        .map((entry) => entry.material))).size,
      hardwareEnvelope: decomps.some((decomp) => decomp.some((entry) => (
        entry.material?.userData?.paletteKey === 'hardware'
          && entry.material?.userData?.lodEnvelope === true
      ))),
      materials: allMaterials.size,
      textures: allTextures.size,
    };
    for (const decomp of decomps) for (const entry of decomp) entry.geometry.dispose();
    for (const texture of allTextures) texture.dispose();
    for (const material of allMaterials) material.dispose();
    return result;
  }, { housesModuleUrl: `/@fs${join(ROOT, 'src/generators/village/houses.js')}` });
  pass(diversityRuntime.mirroredId != null && diversityRuntime.mirrorX === -1,
    'mirrored L-plan stays mirrored in the real focus/edit overlay');
  const semanticSharing = diversityRuntime.shared[2] >= Math.floor(diversityRuntime.lengths[2] * 0.45)
    && diversityRuntime.shared[3] >= Math.floor(diversityRuntime.lengths[3] * 0.45)
    && diversityRuntime.materials <= 120
    && diversityRuntime.textures <= 60;
  pass(semanticSharing,
    `single/U topology reuses semantic palette resources (${JSON.stringify(diversityRuntime)})`);
  pass(
    diversityRuntime.hardwareEntries.every((count) => count === 1)
      && diversityRuntime.hardwareMaterials === 1
      && !diversityRuntime.hardwareEnvelope,
    `one shared ironwork group remains FULL-only across house topology (${JSON.stringify(diversityRuntime)})`,
  );

  await page.evaluate((parcelId) => {
    const engine = window.__engine;
    engine.village.debugFocus(parcelId);
    if (engine.debugDof().tweenProgress != null) engine.debugDofSeek(1, { finish: true });
  }, diversityRuntime.mirroredId);
  await page.waitForFunction((parcelId) => {
    const state = window.__engine.village.getState();
    return state.selected === parcelId && !state.transitioning;
  }, diversityRuntime.mirroredId, { timeout });
  const initialOpening = await page.evaluate((parcelId) => (
    window.__engine.village.debugOpeningDetail(parcelId)
  ), diversityRuntime.mirroredId);
  pass(initialOpening?.valid && initialOpening.plan?.primary
      && initialOpening.thresholdLifeBatch === 1
      && initialOpening.plan.hardware === 3
      && initialOpening.plan.meoreum === 0
      && initialOpening.plan.lowerPanel > 0
      && initialOpening.plan.pivot && initialOpening.plan.footwear,
  `focused overlay owns one reusable primary opening contract (${JSON.stringify(initialOpening)})`);
  const houseTabs = page.locator('.ctx.house:not([aria-hidden="true"]) .tabs .tab');
  await houseTabs.filter({ hasText: '초가' }).click();
  await page.waitForFunction(() => window.__engine.village.getState().spec?.kind === 'choga', null, { timeout });
  const chogaSwitch = await page.evaluate(() => {
    const engine = window.__engine;
    const state = engine.village.getState();
    const panel = document.querySelector('.ctx.house:not([aria-hidden="true"])');
    const column = panel?.querySelector('input[data-key="columnHeight"]');
    return {
      spec: state.spec,
      columnValue: Number(column?.value),
      columnMax: Number(column?.max),
      keys: [...(panel?.querySelectorAll('[data-key]') || [])].map((element) => element.dataset.key),
      activeType: panel?.querySelector('.tabs .tab.on')?.textContent?.replace(/\s+/g, ' ').trim(),
      opening: engine.village.debugOpeningDetail(state.selected),
    };
  });
  pass(chogaSwitch.spec.params.columnHeight === 1.95
      && chogaSwitch.spec.params.wallType === 'stone'
      && chogaSwitch.columnValue === 1.95
      && chogaSwitch.columnValue <= chogaSwitch.columnMax
      && !chogaSwitch.keys.some((key) => ['mainHalfW', 'wingLen', 'wingW'].includes(key))
      && chogaSwitch.activeType?.includes('초가')
      && chogaSwitch.opening?.valid && chogaSwitch.opening.thresholdLifeBatch === 1
      && chogaSwitch.opening.plan?.style === 'choga'
      && chogaSwitch.opening.plan.hardware === 3,
  `giwa→choga switch reseeds target defaults and accepted UI values (${JSON.stringify(chogaSwitch)})`);
  await houseTabs.filter({ hasText: '기와집' }).click();
  await page.waitForFunction(() => window.__engine.village.getState().spec?.kind === 'giwa', null, { timeout });
  const restoredType = await page.evaluate((parcelId) => {
    const engine = window.__engine;
    const spec = engine.village.getState().spec;
    const panel = document.querySelector('.ctx.house:not([aria-hidden="true"])');
    const result = {
      kind: spec?.kind,
      columnHeight: spec?.params?.columnHeight,
      mainHalfWMin: Number(panel?.querySelector('input[data-key="mainHalfW"]')?.min),
      mirrorX: engine.village.debugParcelStats(parcelId, { kind: 'giwa' })?.mirrorX,
      opening: engine.village.debugOpeningDetail(parcelId),
    };
    engine.village.return();
    if (engine.debugDof().tweenProgress != null) engine.debugDofSeek(1, { finish: true });
    return result;
  }, diversityRuntime.mirroredId);
  pass(restoredType.kind === 'giwa'
      && restoredType.columnHeight === 2.9
      && Math.abs(restoredType.mainHalfWMin - 4.4) < 1e-9
      && restoredType.mirrorX === -1
      && restoredType.opening?.valid && restoredType.opening.thresholdLifeBatch === 1
      && restoredType.opening.plan?.style === 'giwa'
      && restoredType.opening.plan.hardware === 3,
  `choga→giwa switch restores fitted variant defaults and mirror (${JSON.stringify(restoredType)})`);

  const zoomModes = await page.evaluate(async () => {
    const engine = window.__engine;
    window.__noWarm = true;
    const parcelId = engine.village.debugParcels()[0]?.parcelId;
    if (!parcelId) throw new Error('zoom mode fixture has no parcel');
    const frames = (count = 8) => new Promise((resolve) => {
      const step = () => (--count <= 0 ? resolve() : requestAnimationFrame(step));
      requestAnimationFrame(step);
    });
    const drainTransition = async () => {
      for (let i = 0; i < 4; i++) await Promise.resolve();
      const sample = engine.debugDofSeek(1, { finish: true });
      if (!sample) throw new Error('explicit view transition did not start');
    };

    const exploreStart = engine.village.debugContinuum();
    const exploreDistance = engine.village.debugDolly(0.20, parcelId);
    await frames();
    const exploreNear = {
      state: engine.village.getState(),
      continuum: engine.village.debugContinuum(),
      minDistance: engine.__controls.minDistance,
    };

    const expectedFocus = engine.village.heroId();
    document.querySelector('.mode .seg:last-child')?.click();
    await drainTransition();
    const focusStart = engine.village.debugContinuum();
    const focusDistance = engine.village.debugDolly(0.99);
    await frames();
    const focusWide = {
      state: engine.village.getState(),
      continuum: engine.village.debugContinuum(),
      maxDistance: engine.__controls.maxDistance,
      labels: [...document.querySelectorAll('.mode .seg')]
        .map((button) => button.textContent.replace(/\s+/g, ' ').trim()),
    };

    engine.village.return();
    await drainTransition();
    const returned = engine.village.getState();
    return { parcelId, expectedFocus, exploreStart, exploreDistance, exploreNear, focusStart, focusDistance, focusWide, returned };
  });
  pass(zoomModes.exploreNear.state.selected == null
      && zoomModes.exploreNear.continuum.mode === 'explore'
      && zoomModes.exploreNear.minDistance <= zoomModes.exploreDistance + 0.2,
  'deep wheel-equivalent zoom keeps free village exploration instead of selecting the center house');
  const focusWideOk = zoomModes.focusWide.state.active
      && zoomModes.focusWide.state.selected === zoomModes.expectedFocus
      && zoomModes.focusWide.state.transitioning === false
      && zoomModes.focusWide.continuum.mode === 'focus'
      && zoomModes.focusWide.continuum.focusEffectWeight <= 0.05
      && zoomModes.focusWide.continuum.elevation >= 29
      && zoomModes.focusWide.maxDistance >= zoomModes.focusDistance - 0.2;
  pass(focusWideOk,
  `direct-village house view preserves selection while retiring close-up bokeh${focusWideOk ? '' : ` (${JSON.stringify(zoomModes.focusWide)})`}`);
  pass(zoomModes.focusWide.labels.some((label) => label.includes('둘러보기'))
      && zoomModes.focusWide.labels.some((label) => label.includes('집 보기'))
      && zoomModes.returned.selected == null,
  'view controls name the two intents and only an explicit return leaves house view');

  const fallbackContract = await page.evaluate(async ({ environmentModuleUrl, threeModuleUrl }) => {
    const [{ captureEnvironmentFallback, restoreEnvironmentFallback }, THREE] = await Promise.all([
      import(environmentModuleUrl),
      import(threeModuleUrl),
    ]);
    const scene = new THREE.Scene();
    const background = new THREE.Texture();
    const fog = new THREE.FogExp2(new THREE.Color().setRGB(0.12, 0.34, 0.56), 0.0123);
    scene.background = background;
    scene.fog = fog;
    const sun = new THREE.DirectionalLight();
    sun.position.set(2.5, 4.5, -7.5);
    sun.color.setRGB(0.17, 0.43, 0.81);
    sun.intensity = 2.37;
    const hemi = new THREE.HemisphereLight();
    hemi.color.setRGB(0.21, 0.38, 0.62);
    hemi.groundColor.setRGB(0.51, 0.27, 0.13);
    hemi.intensity = 0.73;
    const renderer = { toneMappingExposure: 1.17 };
    const original = {
      fogColor: fog.color.clone(), fogDensity: fog.density,
      sunPosition: sun.position.clone(), sunColor: sun.color.clone(), sunIntensity: sun.intensity,
      hemiSky: hemi.color.clone(), hemiGround: hemi.groundColor.clone(), hemiIntensity: hemi.intensity,
      exposure: renderer.toneMappingExposure,
    };
    const fallback = captureEnvironmentFallback(scene, { sun, hemi, renderer });
    scene.background = new THREE.Color(0xffffff);
    scene.fog = new THREE.Fog(0xffffff, 1, 2);
    fog.color.set(0); fog.density = 0.5;
    sun.position.set(0, 0, 0); sun.color.set(0); sun.intensity = 0;
    hemi.color.set(0); hemi.groundColor.set(0); hemi.intensity = 0;
    renderer.toneMappingExposure = 0;
    restoreEnvironmentFallback(scene, { sun, hemi, renderer }, fallback);
    const restored = scene.background === background
      && scene.fog === fog
      && scene.fog.isFogExp2
      && fog.color.equals(original.fogColor)
      && fog.density === original.fogDensity
      && sun.position.equals(original.sunPosition)
      && sun.color.equals(original.sunColor)
      && sun.intensity === original.sunIntensity
      && hemi.color.equals(original.hemiSky)
      && hemi.groundColor.equals(original.hemiGround)
      && hemi.intensity === original.hemiIntensity
      && renderer.toneMappingExposure === original.exposure;
    background.dispose();
    return restored;
  }, {
    environmentModuleUrl: `/@fs${join(ROOT, 'src/env/index.js')}`,
    threeModuleUrl: `/@fs${join(APP_ROOT, 'node_modules/three/build/three.module.js')}`,
  });
  pass(fallbackContract, 'environment fallback preserves Texture and FogExp2 identity, type, and exact light values');

  // old/new village roots can legitimately share module-lifetime pad/lantern materials.
  // Scenery handoff must preserve that exact opaque material instead of creating transparent
  // clones/program variants. The fast pure contract covers the full timeline; this browser
  // probe verifies the same ownership rule through Vite's real module graph.
  const waveMaterialContract = await page.evaluate(async ({ waveModuleUrl, threeModuleUrl, resourceModuleUrl }) => {
    const [{ createRerollWave }, THREE, { markSharedResource }] = await Promise.all([
      import(waveModuleUrl),
      import(threeModuleUrl),
      import(resourceModuleUrl),
    ]);
    function fixture() {
      const shared = new THREE.MeshStandardMaterial({
        opacity: 1, transparent: false, depthWrite: true,
        emissive: 0x111111, emissiveIntensity: 0,
      });
      const shaderHook = () => {};
      const cacheKey = () => 'wave-shared-fixture';
      shared.onBeforeCompile = shaderHook;
      shared.customProgramCacheKey = cacheKey;
      const geometry = new THREE.BoxGeometry(1, 1, 1);
      const oldRoot = new THREE.Group();
      const newRoot = new THREE.Group();
      const oldPads = new THREE.Group(); oldPads.name = 'village-pads';
      const newPads = new THREE.Group(); newPads.name = 'village-pads';
      const oldMesh = new THREE.Mesh(geometry, shared);
      const newMesh = new THREE.Mesh(geometry, shared);
      oldPads.add(oldMesh); newPads.add(newMesh);
      oldRoot.add(oldPads); newRoot.add(newPads);
      const wave = createRerollWave({ oldRoot, newRoot, duration: 1 });
      const oldClone = oldMesh.material;
      const newClone = newMesh.material;
      let oldCloneDisposals = 0, newCloneDisposals = 0;
      oldClone.addEventListener('dispose', () => { oldCloneDisposals++; });
      newClone.addEventListener('dispose', () => { newCloneDisposals++; });
      return {
        shared, shaderHook, cacheKey, oldPads, newPads, oldMesh, newMesh,
        oldClone, newClone, wave, geometry,
        disposalCounts: () => [oldCloneDisposals, newCloneDisposals],
      };
    }

    const cancel = fixture();
    const opaqueShared = cancel.oldClone === cancel.shared
      && cancel.newClone === cancel.shared
      && cancel.oldClone.onBeforeCompile === cancel.shaderHook
      && cancel.oldClone.customProgramCacheKey === cancel.cacheKey;
    cancel.shared.emissiveIntensity = 0.77; // night-glow updates the shared source during a live wave.
    cancel.wave.seek(0.405);
    const alpha = {
      old: cancel.oldMesh.material.opacity,
      new: cancel.newMesh.material.opacity,
      source: cancel.shared.opacity,
      oldEmission: cancel.oldMesh.material.emissiveIntensity,
      newEmission: cancel.newMesh.material.emissiveIntensity,
    };
    cancel.wave.cancel();
    cancel.wave.cancel();
    const cancelRestored = cancel.oldMesh.material === cancel.shared
      && cancel.newMesh.material === cancel.shared
      && cancel.oldPads.visible && !cancel.newPads.visible
      && cancel.shared.opacity === 1 && !cancel.shared.transparent && cancel.shared.depthWrite
      && cancel.disposalCounts().every((count) => count === 0)
      && cancel.wave.isDone() && cancel.wave.update(0.5) === 1;
    cancel.geometry.dispose(); cancel.shared.dispose();

    const finish = fixture();
    finish.wave.seek(0.405);
    finish.wave.dispose();
    finish.wave.dispose();
    const finishRestored = finish.oldMesh.material === finish.shared
      && finish.newMesh.material === finish.shared
      && !finish.oldPads.visible && finish.newPads.visible
      && finish.shared.opacity === 1 && !finish.shared.transparent && finish.shared.depthWrite
      && finish.disposalCounts().every((count) => count === 0)
      && finish.wave.isDone() && finish.wave.update(0.5) === 1;
    finish.geometry.dispose(); finish.shared.dispose();

    // A module-lifetime material may also have a consumer outside the wave. All three users
    // must retain the same opaque identity throughout the scenery ownership handoff.
    const marked = markSharedResource(new THREE.MeshStandardMaterial({ opacity: 1 }));
    const incoming = new THREE.MeshStandardMaterial({ opacity: 1 });
    const markedGeometry = new THREE.BoxGeometry(1, 1, 1);
    const markedOldRoot = new THREE.Group(), markedNewRoot = new THREE.Group();
    const markedOldPads = new THREE.Group(), markedNewPads = new THREE.Group();
    markedOldPads.name = markedNewPads.name = 'village-pads';
    const markedOldMesh = new THREE.Mesh(markedGeometry, marked);
    const markedNewMesh = new THREE.Mesh(markedGeometry, incoming);
    const externalMesh = new THREE.Mesh(markedGeometry, marked);
    markedOldPads.add(markedOldMesh); markedNewPads.add(markedNewMesh);
    markedOldRoot.add(markedOldPads); markedNewRoot.add(markedNewPads);
    const markedWave = createRerollWave({ oldRoot: markedOldRoot, newRoot: markedNewRoot, duration: 1 });
    markedWave.seek(0.405);
    const markedIdentity = markedOldMesh.material === marked
      && markedOldMesh.material.opacity === 1
      && externalMesh.material === marked && externalMesh.material.opacity === 1;
    markedWave.cancel();
    const markedRestored = markedOldMesh.material === marked && marked.opacity === 1;
    markedGeometry.dispose(); incoming.dispose(); marked.dispose();
    return { opaqueShared, alpha, cancelRestored, finishRestored, markedIdentity, markedRestored };
  }, {
    waveModuleUrl: `/@fs${join(ROOT, 'src/village/wave.js')}`,
    threeModuleUrl: `/@fs${join(APP_ROOT, 'node_modules/three/build/three.module.js')}`,
    resourceModuleUrl: `/@fs${join(ROOT, 'src/core/three-resources.js')}`,
  });
  pass(
    waveMaterialContract.opaqueShared
      && waveMaterialContract.alpha.old === 1
      && waveMaterialContract.alpha.new === 1
      && waveMaterialContract.alpha.source === 1
      && waveMaterialContract.alpha.oldEmission === 0.77
      && waveMaterialContract.alpha.newEmission === 0.77
      && waveMaterialContract.cancelRestored
      && waveMaterialContract.finishRestored
      && waveMaterialContract.markedIdentity
      && waveMaterialContract.markedRestored,
    `wave preserves opaque shared materials across exclusive scenery ownership (${JSON.stringify(waveMaterialContract)})`,
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

  const postOrder = await page.evaluate(() => window.__engine.debugPostPassOrder());
  pass(
    JSON.stringify(postOrder) === JSON.stringify([
      'RenderPass', 'GradePass', 'BokehPass', 'UnrealBloomPass',
      'FlarePass', 'OutlinePass', 'OutputPass',
    ]),
    `post passes preserve the output-last contract (${postOrder.join(' → ')})`,
  );

  const postResolution = await page.evaluate(() => {
    const engine = window.__engine;
    const renderer = engine.renderer;
    const previousRatio = renderer.getPixelRatio();
    const width = renderer.domElement.clientWidth;
    const height = renderer.domElement.clientHeight;
    let state;
    try {
      renderer.setPixelRatio(1.5);
      engine.resize();
      state = engine.debugPostResolution();
    } finally {
      renderer.setPixelRatio(previousRatio);
      engine.resize();
    }
    return {
      ...state,
      expectedWidth: Math.round(width * 1.5),
      expectedHeight: Math.round(height * 1.5),
    };
  });
  pass(
    postResolution.composer.width === postResolution.expectedWidth
      && postResolution.composer.height === postResolution.expectedHeight
      && postResolution.outline.width === postResolution.expectedWidth
      && postResolution.outline.height === postResolution.expectedHeight,
    `composer and outline follow renderer DPR (${postResolution.expectedWidth}×${postResolution.expectedHeight})`,
  );

  const heroId = await page.evaluate(() => window.__engine.village.heroId());
  pass(typeof heroId === 'string' && heroId.length > 0, 'hero parcel is addressable through the app API');
  const focused = await page.evaluate(() => {
    const engine = window.__engine;
    let baseThresholdLife = 0;
    engine.village.exportRoot()?.traverse((object) => {
      if (object.name === 'threshold-life-detail') baseThresholdLife++;
    });
    engine.setTime('night');
    engine.setSeason('autumn');
    engine.setWeather('clear');
    const environment = engine.scene.getObjectByName('environment');
    const motes = environment?.getObjectByName('dustMotes')?.material?.uniforms;
    const sun = engine.scene.children.find((object) => object.isDirectionalLight && object.castShadow);
    const parcelId = engine.village.heroId();
    engine.village.focus(parcelId);
    const state = engine.village.getState();
    const life = engine.village.focusRoot()?.getObjectByName('threshold-life-detail');
    return {
      baseThresholdLife,
      selected: state.selected,
      spec: state.spec,
      overlay: engine.village.debugOverlayBox(state.selected),
      opening: engine.village.debugOpeningDetail(state.selected),
      thresholdLife: life ? {
        count: 1,
        kind: life.userData.thresholdLifePlan?.kind,
        pairs: life.userData.thresholdLifePlan?.items?.length,
        tier: life.userData.openingDetailTier,
        paletteKey: life.material?.userData?.paletteKey,
        envelope: life.material?.userData?.lodEnvelope === true,
        transparent: life.material?.transparent === true,
      } : null,
      // Visible-time changes remain animated: synchronously after the dial event, neither the
      // scene-level sky nor the hidden single-house motes have snapped to the night target yet.
      timeTransitionStart: {
        sunIntensity: sun?.intensity,
        moteIntensity: motes?.uIntensity?.value,
      },
    };
  });
  // Headless ANGLE may produce fewer than one frame per second while linking shaders, so this
  // fast smoke asserts synchronous focus setup rather than wall-clock tween completion.
  pass(focused.selected === heroId && !!focused.spec, 'focus setup targets the requested parcel');
  pass(focused.baseThresholdLife === 0,
    'aerial/static village prototypes own no repeated threshold footwear');
  pass(!!focused.overlay, 'focused parcel exposes a measurable detail overlay');
  pass(focused.opening?.valid
      && focused.opening.plan?.style === 'giwa'
      && focused.opening.plan.hardware === 3
      && focused.opening.plan.meoreum === 0
      && focused.opening.plan.lowerPanel > 0
      && focused.opening.recess === 1
      && focused.opening.door?.hasRecess,
  `representative head house consumes one shared primary opening contract (${JSON.stringify(focused.opening)})`);
  pass(focused.thresholdLife?.count === 1
      && focused.thresholdLife.kind === 'jipsin'
      && focused.thresholdLife.pairs === 2
      && focused.thresholdLife.tier === 'focus'
      && focused.thresholdLife.paletteKey === 'thresholdLife'
      && !focused.thresholdLife.envelope
      && !focused.thresholdLife.transparent,
  `focused residence owns one opaque focus-only footwear batch (${JSON.stringify(focused.thresholdLife)})`);
  pass(
    Math.abs(focused.timeTransitionStart.sunIntensity - 0.9) > 1e-3
      && Math.abs(focused.timeTransitionStart.moteIntensity - 0.5) > 1e-6,
    `visible time changes preserve the sky and ambience crossfade contract (${JSON.stringify(focused.timeTransitionStart)})`,
  );

  // Wait only for the shader-warm handoff, then deterministically finish the real focus tween.
  // Product pointer input remains locked until this same onDone path has installed the focus regime.
  await page.waitForFunction(() => {
    const engine = window.__engine;
    return !engine.village.getState().transitioning || engine.debugDof().tweenProgress != null;
  }, null, { timeout });
  await page.evaluate(() => {
    const engine = window.__engine;
    if (engine.debugDof().tweenProgress != null) engine.debugDofSeek(1, { finish: true });
  });
  await page.waitForFunction(() => !window.__engine.village.getState().transitioning, null, { timeout });

  // The representative hero is a walled compound whose inner-hall leaf is
  // legitimately occluded by its south gate. Exercise direct interaction on a
  // regular focused choga where the planned south approach exposes the leaf and
  // the formerly solid host wall now reads as a recessed opening.
  const regularDoorCandidates = await page.evaluate(() => window.__engine.village.debugParcels()
    .filter((parcel) => !parcel.hero && parcel.kind === 'choga')
    .map((parcel) => parcel.parcelId));
  let doorParcelId = null;
  for (const candidate of regularDoorCandidates) {
    await page.evaluate((parcelId) => window.__engine.village.switchTo(parcelId), candidate);
    await page.waitForFunction((parcelId) => {
      const engine = window.__engine;
      return engine.village.getState().selected === parcelId
        && (!engine.village.getState().transitioning || engine.debugDof().tweenProgress != null);
    }, candidate, { timeout });
    await page.evaluate(() => {
      const engine = window.__engine;
      if (engine.debugDof().tweenProgress != null) engine.debugDofSeek(1, { finish: true });
    });
    await page.waitForFunction((parcelId) => {
      const state = window.__engine.village.getState();
      return state.selected === parcelId && !state.transitioning;
    }, candidate, { timeout });
    if (await page.evaluate((parcelId) => !!window.__engine.village.debugDoorScreen(parcelId), candidate)) {
      doorParcelId = candidate;
      break;
    }
  }
  pass(doorParcelId != null,
    `at least one regular south-focus frame exposes its actual primary leaf (${regularDoorCandidates.join(',')})`);
  if (!doorParcelId) throw new Error('No regular focus frame exposes a primary door action');

  const closedDoor = await page.evaluate((parcelId) => {
    const engine = window.__engine;
    const calls = engine.village.debugDrawCalls();
    return {
      state: engine.village.debugDoorInteraction(parcelId),
      screen: engine.village.debugDoorScreen(parcelId),
      programs: engine.renderer.info.programs?.length || 0,
      calls,
    };
  }, doorParcelId);
  pass(closedDoor.state?.valid && closedDoor.state.progress === 0 && !closedDoor.state.targetOpen
      && closedDoor.state.hasRecess && closedDoor.state.recessDepth > 0.03
      && !closedDoor.screen?.behind
      && closedDoor.screen.x > 0 && closedDoor.screen.x < 1280
      && closedDoor.screen.y > 0 && closedDoor.screen.y < 800
      && closedDoor.programs > 0 && closedDoor.calls > 0,
  `focused FULL primary door starts closed at a visible direct target (${JSON.stringify(closedDoor)})`);

  const visibilityGate = await page.evaluate((parcelId) => {
    const engine = window.__engine;
    const root = engine.village.focusRoot();
    const panel = root?.getObjectByName('primary-opening-panel');
    const pivot = root?.getObjectByName('primary-door-pivot');
    const originalLayer = pivot?.layers.mask;
    panel.visible = false;
    const hiddenPanel = engine.village.debugDoorScreen(parcelId) == null;
    panel.visible = true;
    pivot.visible = false;
    const hiddenOwner = engine.village.debugDoorScreen(parcelId) == null;
    pivot.visible = true;
    pivot.layers.set(1);
    const layerOwner = engine.village.debugDoorScreen(parcelId) == null;
    pivot.layers.mask = originalLayer;
    root.visible = false;
    const hiddenRoot = engine.village.debugDoorScreen(parcelId) == null;
    root.visible = true;
    return { hiddenPanel, hiddenOwner, layerOwner, hiddenRoot };
  }, doorParcelId);
  pass(Object.values(visibilityGate).every(Boolean),
    `door input follows visible/layer owner state (${JSON.stringify(visibilityGate)})`);

  await page.waitForFunction(() => {
    const engine = window.__engine;
    const shift = window.__viewshift;
    return !engine.village.getState().transitioning
      && !engine.village.isWaving()
      && (!shift || (Math.abs(shift.x - shift.tx) < 0.25 && Math.abs(shift.y - shift.ty) < 0.25));
  }, null, { timeout });
  const restoredDoorScreen = await page.evaluate((parcelId) => (
    window.__engine.village.debugDoorScreen(parcelId)
  ), doorParcelId);
  pass(restoredDoorScreen != null,
    `door target remains actionable after visible/layer owner state is restored (${JSON.stringify(restoredDoorScreen)})`);
  closedDoor.screen = restoredDoorScreen;

  await page.mouse.move(closedDoor.screen.x, closedDoor.screen.y);
  const doorHover = page.locator('.hlabel');
  await doorHover.waitFor({ state: 'visible', timeout });
  pass((await doorHover.textContent()).includes('문 열기'),
    'actual door hover renders the localized open action in Product UI');

  // `isPrimary` is scoped to a pointer type. A primary touch arriving while a
  // primary mouse gesture owns the door must not overwrite the first pointer's
  // down hit; cancelling that unrelated touch must not cancel the mouse click.
  await page.mouse.down();
  await page.evaluate(({ x, y }) => {
    const canvas = window.__engine.renderer.domElement;
    canvas.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true,
      clientX: x,
      clientY: y,
      pointerId: 17,
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      buttons: 1,
    }));
    canvas.dispatchEvent(new PointerEvent('pointercancel', {
      bubbles: true,
      clientX: x,
      clientY: y,
      pointerId: 17,
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      buttons: 0,
    }));
  }, closedDoor.screen);
  await page.mouse.up();
  const afterCrossTypePointer = await page.evaluate((parcelId) => {
    const engine = window.__engine;
    const toggled = engine.village.debugDoorInteraction(parcelId);
    engine.village.debugSeekDoor(0, parcelId);
    return toggled;
  }, doorParcelId);
  pass(afterCrossTypePointer?.targetOpen,
    `a second primary pointer type cannot steal the active door click `
      + `(${JSON.stringify(afterCrossTypePointer)})`);

  // A browser-cancelled pointer sequence must never survive until a later up
  // and toggle the leaf. Exercise the real mouse pointer so OrbitControls also
  // owns/releases pointer capture exactly as it does in production.
  await page.mouse.down();
  await page.evaluate(({ x, y }) => {
    const canvas = window.__engine.renderer.domElement;
    canvas.dispatchEvent(new PointerEvent('pointercancel', {
      bubbles: true,
      clientX: x,
      clientY: y,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
      button: 0,
      buttons: 0,
    }));
  }, closedDoor.screen);
  await page.mouse.up();
  const afterPointerCancel = await page.evaluate((parcelId) => (
    window.__engine.village.debugDoorInteraction(parcelId)
  ), doorParcelId);
  pass(afterPointerCancel?.progress === 0 && !afterPointerCancel.targetOpen,
    `pointercancel clears the pending door click (${JSON.stringify(afterPointerCancel)})`);

  await page.mouse.down();
  const captureReleased = await page.evaluate(async () => {
    const canvas = window.__engine.renderer.domElement;
    const captured = canvas.hasPointerCapture(1);
    if (captured) canvas.releasePointerCapture(1);
    else canvas.dispatchEvent(new PointerEvent('lostpointercapture', {
      bubbles: true,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
    }));
    await new Promise((resolveFrame) => requestAnimationFrame(resolveFrame));
    return captured;
  });
  await page.mouse.up();
  const afterLostCapture = await page.evaluate((parcelId) => (
    window.__engine.village.debugDoorInteraction(parcelId)
  ), doorParcelId);
  pass(afterLostCapture?.progress === 0 && !afterLostCapture.targetOpen,
    `lostpointercapture clears the pending door click (native=${captureReleased}, `
      + `${JSON.stringify(afterLostCapture)})`);

  await page.mouse.down();
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.mouse.up();
  const afterBlur = await page.evaluate((parcelId) => (
    window.__engine.village.debugDoorInteraction(parcelId)
  ), doorParcelId);
  pass(afterBlur?.progress === 0 && !afterBlur.targetOpen,
    `window blur clears the pending door click (${JSON.stringify(afterBlur)})`);

  // A pointer sequence that turns into an OrbitControls drag must never toggle the door.
  const preDragCamera = await page.evaluate(() => ({
    position: window.__engine.camera.position.toArray(),
    quaternion: window.__engine.camera.quaternion.toArray(),
    target: window.__engine.__controls.target.toArray(),
  }));
  await page.mouse.down();
  await page.mouse.move(closedDoor.screen.x + 12, closedDoor.screen.y);
  await page.mouse.up();
  const afterDrag = await page.evaluate((parcelId) => ({
    state: window.__engine.village.debugDoorInteraction(parcelId),
    screen: window.__engine.village.debugDoorScreen(parcelId),
  }), doorParcelId);
  pass(afterDrag.state?.progress === 0 && !afterDrag.state.targetOpen,
    `door pointer drag stays an orbit gesture (${JSON.stringify(afterDrag)})`);

  // Down/up must both resolve to the same unobscured moving leaf. Reverse it while
  // moving to prove the spring inherits the exact pose instead of snapping.
  await page.evaluate(() => window.__engine.debugSetPaused(true));
  // OrbitControls damping can keep moving the camera for a few frames after the
  // drag's pointerup. Freeze first, restore the exact pre-drag camera, then
  // resolve the click point. This keeps the drag assertion independent from
  // host frame rate without bypassing the pointer path under test.
  const pausedDoorScreen = await page.evaluate(({ parcelId, pose }) => {
    const engine = window.__engine;
    engine.camera.position.fromArray(pose.position);
    engine.camera.quaternion.fromArray(pose.quaternion);
    engine.__controls.target.fromArray(pose.target);
    engine.camera.updateMatrixWorld(true);
    return engine.village.debugDoorScreen(parcelId);
  }, { parcelId: doorParcelId, pose: preDragCamera });
  if (!pausedDoorScreen) throw new Error('Door projection did not recover after restoring the pre-drag camera');
  await page.mouse.click(pausedDoorScreen.x, pausedDoorScreen.y);
  const openingDoor = await page.evaluate((parcelId) => {
    const engine = window.__engine;
    const targeted = engine.village.debugDoorInteraction(parcelId);
    const mid = engine.village.debugAdvanceDoor(0.12, parcelId);
    return { targeted, mid, screen: engine.village.debugDoorScreen(parcelId) };
  }, doorParcelId);
  pass(openingDoor.targeted?.targetOpen
      && openingDoor.mid.progress > 0 && openingDoor.mid.progress < 1,
  `direct click starts an interruptible door swing (${JSON.stringify(openingDoor)})`);
  await page.mouse.click(openingDoor.screen.x, openingDoor.screen.y);
  const interruptedDoor = await page.evaluate(({ parcelId, progress }) => {
    const engine = window.__engine;
    const reversed = engine.village.debugDoorInteraction(parcelId);
    const closed = engine.village.debugAdvanceDoor(3, parcelId);
    return { reversed, closed, inheritedError: Math.abs(reversed.progress - progress) };
  }, { parcelId: doorParcelId, progress: openingDoor.mid.progress });
  pass(!interruptedDoor.reversed?.targetOpen && interruptedDoor.inheritedError < 1e-9
      && interruptedDoor.closed.progress === 0 && !interruptedDoor.closed.moving,
  `mid-swing click reverses without a pose snap (${JSON.stringify(interruptedDoor)})`);

  const reopenedScreen = await page.evaluate((parcelId) => (
    window.__engine.village.debugDoorScreen(parcelId)
  ), doorParcelId);
  await page.mouse.click(reopenedScreen.x, reopenedScreen.y);
  const openDoor = await page.evaluate((parcelId) => {
    const engine = window.__engine;
    const state = engine.village.debugAdvanceDoor(3, parcelId);
    const root = engine.village.focusRoot();
    const pivot = root?.getObjectByName('primary-door-pivot');
    const frame = root?.getObjectByName('opening-frame-details');
    const panel = root?.getObjectByName('primary-opening-panel');
    const hardware = root?.getObjectByName('opening-hardware-details');
    const leaf = root?.getObjectByName('primary-opening-leaf-details');
    const openCalls = engine.village.debugDrawCalls();
    const openPrograms = engine.renderer.info.programs?.length || 0;
    engine.village.debugSeekDoor(0, parcelId);
    const closedPoseCalls = engine.village.debugDrawCalls();
    const closedPosePrograms = engine.renderer.info.programs?.length || 0;
    engine.village.debugSeekDoor(1, parcelId);
    return {
      state,
      hierarchy: {
        panel: panel?.parent === pivot,
        hardware: hardware?.parent === pivot,
        leaf: leaf?.parent === pivot,
        frameFixed: frame?.parent !== pivot,
        recessFixed: frame?.parent !== pivot
          && frame?.userData?.primaryDoorRecesses?.length === 1,
      },
      programs: [openPrograms, closedPosePrograms],
      calls: [openCalls, closedPoseCalls],
    };
  }, doorParcelId);
  pass(openDoor.state?.progress === 1 && openDoor.state.targetOpen && !openDoor.state.moving
      && Object.values(openDoor.hierarchy).every(Boolean)
      && openDoor.programs[0] === openDoor.programs[1]
      && openDoor.calls[0] === openDoor.calls[1]
      && openDoor.calls[0] > 0,
  `open leaf, ironwork, and seams share one hinge without program/draw drift (${JSON.stringify(openDoor)})`);
  await page.evaluate(() => window.__engine.debugSetPaused(false));

  const regularDoorReleaseBeforeHop = await page.evaluate((parcelId) => {
    const engine = window.__engine;
    const root = engine.village.focusRoot();
    const pivot = root?.getObjectByName('primary-door-pivot');
    const panel = root?.getObjectByName('primary-opening-panel');
    window.__regularDoorReleaseProbe = { root, pivot, panel };
    return {
      open: engine.village.debugDoorInteraction(parcelId)?.progress === 1,
      pivotAttached: pivot?.parent != null,
      panelOnPivot: panel?.parent === pivot,
    };
  }, doorParcelId);
  pass(Object.values(regularDoorReleaseBeforeHop).every(Boolean),
    `regular door release probe starts on one open attached runtime (${JSON.stringify(regularDoorReleaseBeforeHop)})`);

  await page.evaluate((parcelId) => window.__engine.village.switchTo(parcelId), heroId);
  await page.waitForFunction((parcelId) => {
    const engine = window.__engine;
    return engine.village.getState().selected === parcelId
      && (!engine.village.getState().transitioning || engine.debugDof().tweenProgress != null);
  }, heroId, { timeout });
  await page.evaluate(() => {
    const engine = window.__engine;
    if (engine.debugDof().tweenProgress != null) engine.debugDofSeek(1, { finish: true });
  });
  await page.waitForFunction((parcelId) => {
    const state = window.__engine.village.getState();
    return state.selected === parcelId && !state.transitioning;
  }, heroId, { timeout });

  const regularDoorReleaseAfterHop = await page.evaluate((parcelId) => {
    const engine = window.__engine;
    const probe = window.__regularDoorReleaseProbe;
    delete window.__regularDoorReleaseProbe;
    return {
      runtimeReleased: engine.village.debugDoorInteraction(parcelId) == null,
      rootDetached: probe?.root?.parent == null,
      pivotDetached: probe?.pivot?.parent == null,
      pivotClosed: Math.abs(probe?.pivot?.rotation?.y || 0) < 1e-9,
      panelRestored: probe?.panel?.parent !== probe?.pivot,
    };
  }, doorParcelId);
  pass(Object.values(regularDoorReleaseAfterHop).every(Boolean),
    `regular→hero hop releases the old runtime, closes its pivot, and restores host ownership `
      + `(${JSON.stringify(regularDoorReleaseAfterHop)})`);

  const heroOpeningLifecycle = await page.evaluate(async ({ parcelId, resourcesModuleUrl }) => {
    const engine = window.__engine;
    const { collectObjectResources, isSharedResource } = await import(resourcesModuleUrl);
    const frames = (count = 4) => new Promise((resolve) => {
      const step = () => (--count <= 0 ? resolve() : requestAnimationFrame(step));
      requestAnimationFrame(step);
    });
    const settlePrograms = async (maxFrames = 36) => {
      let previous = -1;
      let stableFrames = 0;
      for (let frame = 0; frame < maxFrames; frame++) {
        await frames(1);
        const current = engine.renderer.info.programs?.length || 0;
        stableFrames = current === previous ? stableFrames + 1 : 0;
        previous = current;
        if (stableFrames >= 4) break;
      }
    };
    // The focus handoff waits for async link completion, but Chrome may append
    // its finished depth/basic programs to renderer.info a few rAFs later. Take
    // both snapshots only after that observable list settles so delayed focus
    // work is not misreported as a rebuild program family.
    await settlePrograms();
    const oldRoot = engine.village.focusRoot();
    // Register and finish this exact focus subtree before the baseline so
    // delayed scene links cannot be charged to the replacement.
    engine.renderer.compile(oldRoot, engine.camera, engine.scene);
    await engine.renderer.compileAsync(oldRoot, engine.camera);
    await settlePrograms();
    engine.village.debugSeekDoor(1, parcelId);
    const oldPivot = oldRoot?.getObjectByName('primary-door-pivot');
    const oldDoorOpen = engine.village.debugDoorInteraction(parcelId)?.progress === 1;
    const oldGeometries = [];
    oldRoot?.traverse((object) => {
      if ([
        'opening-frame-details',
        'primary-opening-leaf-details',
        'opening-hardware-details',
        'threshold-life-detail',
      ].includes(object.name)
          && object.geometry) oldGeometries.push(object.geometry);
    });
    const disposed = new Map(oldGeometries.map((geometry) => [geometry, 0]));
    const openingShared = oldGeometries.map((geometry) => isSharedResource(geometry));
    const oldResources = collectObjectResources(oldRoot);
    const onDispose = (event) => disposed.set(event.target, (disposed.get(event.target) || 0) + 1);
    for (const geometry of oldGeometries) geometry.addEventListener('dispose', onDispose);
    const beforeProgramList = engine.renderer.info.programs || [];
    const beforePrograms = beforeProgramList.length;
    const beforeProgramKeys = new Set(beforeProgramList.map((program) => program.cacheKey));
    const rebuilt = engine.village.rebuild(parcelId, {
      building: { roofPitch: 1.08, eaveOverhang: 1.38, profileCurve: 0.56 },
    }, { refreshFlora: false });
    await settlePrograms();
    const root = engine.village.focusRoot();
    await engine.renderer.compileAsync(root, engine.camera);
    await settlePrograms();
    const material = {
      frameEnvelope: null, hardwareEnvelope: null, hardwareKey: null,
      thresholdLifeEnvelope: null, thresholdLifeKey: null, thresholdLifeTransparent: null,
    };
    root?.traverse((object) => {
      if (object.name === 'opening-frame-details') {
        material.frameEnvelope = object.material?.userData?.lodEnvelope === true;
      }
      if (object.name === 'opening-hardware-details') {
        material.hardwareEnvelope = object.material?.userData?.lodEnvelope === true;
        material.hardwareKey = object.material?.userData?.paletteKey || null;
      }
      if (object.name === 'threshold-life-detail') {
        material.thresholdLifeEnvelope = object.material?.userData?.lodEnvelope === true;
        material.thresholdLifeKey = object.material?.userData?.paletteKey || null;
        material.thresholdLifeTransparent = object.material?.transparent === true;
      }
    });
    const inspectPrimaryFace = () => {
      const anchor = root?.getObjectByName('primary-opening-anchor');
      const panel = root?.getObjectByName('primary-opening-panel');
      const frame = root?.getObjectByName('opening-frame-details');
      const plan = anchor?.userData?.openingDetailPlan;
      const panelPositions = panel?.geometry?.attributes?.position;
      const framePositions = frame?.geometry?.attributes?.position;
      if (!plan || !panelPositions || !framePositions) return null;
      root.updateWorldMatrix(true, true);
      const point = panel.position.clone();
      let panelFront = -Infinity;
      for (let index = 0; index < panelPositions.count; index++) {
        point.fromBufferAttribute(panelPositions, index);
        panel.localToWorld(point);
        anchor.worldToLocal(point);
        panelFront = Math.max(panelFront, point.z);
      }
      let frameFront = -Infinity;
      const uLimit = plan.width * 0.5 + plan.frame.width;
      const yMin = plan.frame.width * 1.5;
      const yMax = plan.height + plan.frame.width;
      for (let index = 0; index < framePositions.count; index++) {
        point.fromBufferAttribute(framePositions, index);
        frame.localToWorld(point);
        anchor.worldToLocal(point);
        if (Math.abs(point.x) <= uLimit && point.y >= yMin && point.y <= yMax) {
          frameFront = Math.max(frameFront, point.z);
        }
      }
      if (!Number.isFinite(panelFront) || !Number.isFinite(frameFront)) return null;
      return {
        panelFront,
        frameFront,
        clearance: frameFront - panelFront,
        expectedClearance: plan.reveal.faceClearance + plan.frame.depth,
      };
    };
    const afterProgramList = engine.renderer.info.programs || [];
    const newProgramKeys = afterProgramList
      .map((program) => program.cacheKey)
      .filter((key) => !beforeProgramKeys.has(key));
    const result = {
      rebuilt: !!rebuilt,
      opening: engine.village.debugOpeningDetail(parcelId),
      oldDoorOpen,
      oldPivotClosed: Math.abs(oldPivot?.rotation?.y || 0) < 1e-9,
      oldRootDetached: oldRoot?.parent == null,
      oldResourceContainsOpening: oldGeometries.map((geometry) => oldResources.geometries.has(geometry)),
      openingShared,
      oldOpeningGeometries: oldGeometries.length,
      disposed: [...disposed.values()],
      programs: [beforePrograms, engine.renderer.info.programs?.length || 0],
      newProgramKeys,
      openingProgramKeys: newProgramKeys.filter((key) => !/^(?:basic|depth),/.test(key)),
      delayedInfrastructurePrograms: newProgramKeys.filter((key) => /^(?:basic|depth),/.test(key)).length,
      material,
      primaryFace: inspectPrimaryFace(),
    };
    for (const geometry of oldGeometries) geometry.removeEventListener('dispose', onDispose);
    return result;
  }, {
    parcelId: heroId,
    resourcesModuleUrl: `/@fs${join(ROOT, 'src/core/three-resources.js')}`,
  });
  pass(heroOpeningLifecycle.rebuilt
      && heroOpeningLifecycle.opening?.valid
      && heroOpeningLifecycle.opening.plan?.style === 'giwa'
      && heroOpeningLifecycle.opening.door?.progress === 0
      && heroOpeningLifecycle.oldDoorOpen && heroOpeningLifecycle.oldPivotClosed
      && heroOpeningLifecycle.oldRootDetached
      && heroOpeningLifecycle.oldResourceContainsOpening.every(Boolean)
      && heroOpeningLifecycle.openingShared.every((shared) => !shared)
      && heroOpeningLifecycle.oldOpeningGeometries === 4
      && heroOpeningLifecycle.disposed.every((count) => count === 1)
      && heroOpeningLifecycle.material.frameEnvelope
      && !heroOpeningLifecycle.material.hardwareEnvelope
      && heroOpeningLifecycle.material.hardwareKey === 'hardware'
      && !heroOpeningLifecycle.material.thresholdLifeEnvelope
      && heroOpeningLifecycle.material.thresholdLifeKey === 'thresholdLife'
      && !heroOpeningLifecycle.material.thresholdLifeTransparent
      && heroOpeningLifecycle.primaryFace?.clearance > 0
      && Math.abs(
        heroOpeningLifecycle.primaryFace.clearance
          - heroOpeningLifecycle.primaryFace.expectedClearance,
      ) <= 1e-5
      // Chrome can append already-requested scene-level basic/depth links after
      // four stable rAFs. The opening must add no material shader family; keep a
      // small ceiling on that separately classified infrastructure tail.
      && heroOpeningLifecycle.openingProgramKeys.length === 0
      && heroOpeningLifecycle.delayedInfrastructurePrograms <= 4,
  `head-house rebuild preserves positive frame/panel clearance, replaces one opening overlay, `
    + `disposes it once, and adds no opening shader family (${JSON.stringify(heroOpeningLifecycle)})`);

  const thresholdWeather = await page.evaluate(() => {
    const engine = window.__engine;
    const root = engine.village.focusRoot();
    const dry = root?.getObjectByName('threshold-life-detail');
    let dryDisposed = 0;
    dry?.geometry?.addEventListener('dispose', () => { dryDisposed++; });
    engine.setWeather('rain');
    const wet = engine.village.focusRoot()?.getObjectByName('threshold-life-detail');
    let count = 0;
    engine.village.focusRoot()?.traverse((object) => {
      if (object.name === 'threshold-life-detail') count++;
    });
    const result = {
      dryKind: dry?.userData?.thresholdLifePlan?.kind || null,
      wetKind: wet?.userData?.thresholdLifePlan?.kind || null,
      wetCondition: wet?.userData?.thresholdLifePlan?.condition || null,
      count,
      dryDisposed,
      sameGeometry: dry?.geometry === wet?.geometry,
      sameMaterial: dry?.material === wet?.material,
    };
    engine.setWeather('clear');
    return result;
  });
  pass(
    thresholdWeather.dryKind === 'jipsin'
      && thresholdWeather.wetKind === 'namaksin'
      && thresholdWeather.wetCondition === 'wet'
      && thresholdWeather.count === 1
      && thresholdWeather.dryDisposed === 1
      && !thresholdWeather.sameGeometry
      && thresholdWeather.sameMaterial,
    `real clear→rain path swaps one focused pair, releases its geometry, and reuses the runtime material (${JSON.stringify(thresholdWeather)})`,
  );

  const typeChange = await page.evaluate(() => {
    window.__engine.setType('choga');
    return window.__engine.getState().preset;
  });
  pass(typeChange === 'choga', 'setType uses the shared building framing path without a runtime error');

  const expansionContract = await page.evaluate(async () => {
    const { ghostSpec, nextWingPlacement } = await import('/src/engine/expansion.js');
    const params = window.__engine.getParams();
    const samePlacement = [2, 3].every((target) => {
      const ghost = ghostSpec(params, target);
      const placement = nextWingPlacement(params, target);
      return !!ghost && !!placement
        && ghost.pStart.equals(placement.pStart)
        && ghost.size.W === placement.size.W
        && ghost.size.D === placement.size.D
        && ghost.size.H === placement.size.H;
    });
    const originalRandom = Math.random;
    const originalCreateElement = document.createElement;
    let randomCalls = 0;
    let canvasCalls = 0;
    Math.random = () => { randomCalls++; return 0.5; };
    document.createElement = function(tagName, options) {
      if (String(tagName).toLowerCase() === 'canvas') canvasCalls++;
      return originalCreateElement.call(this, tagName, options);
    };
    try { ghostSpec(params, 2); } finally {
      Math.random = originalRandom;
      document.createElement = originalCreateElement;
    }
    return {
      samePlacement,
      invalidRanges: ghostSpec(params, 1) === null && ghostSpec(params, 4) === null,
      randomCalls,
      canvasCalls,
    };
  });
  pass(
    expansionContract.samePlacement
      && expansionContract.invalidRanges
      && expansionContract.randomCalls === 0
      && expansionContract.canvasCalls === 0,
    `wing ghost shares pure placement without hidden generation (random ${expansionContract.randomCalls}, canvas ${expansionContract.canvasCalls})`,
  );

  const buildingApiUrl = `/@fs${join(ROOT, 'src/api/building.js')}`;
  const resourceApiUrl = `/@fs${join(ROOT, 'src/core/three-resources.js')}`;
  const lifecycleContract = await page.evaluate(async ({ buildingModuleUrl, resourceModuleUrl }) => {
    const { PRESETS, buildBuilding, disposeBuilding } = await import(buildingModuleUrl);
    const { isSharedResource } = await import(resourceModuleUrl);
    const owner = buildBuilding({ ...PRESETS.choga });
    const sharedMats = owner.userData.materials;
    const borrower = buildBuilding({ ...PRESETS.choga, mats: sharedMats });
    const sharedResources = new Set();
    for (const value of Object.values(sharedMats)) {
      if (value?.isMaterial) {
        sharedResources.add(value);
        for (const property of Object.values(value)) {
          if (property?.isTexture) sharedResources.add(property);
        }
      } else if (value?.isTexture) sharedResources.add(value);
    }
    const ownedResources = new Set();
    const moduleSharedResources = new Set();
    const addOwnedTexture = (texture) => {
      if (!texture || sharedResources.has(texture)) return;
      (isSharedResource(texture) ? moduleSharedResources : ownedResources).add(texture);
    };
    const addOwnedMaterial = (material) => {
      if (!material || sharedResources.has(material)) return;
      if (isSharedResource(material)) moduleSharedResources.add(material);
      else ownedResources.add(material);
      for (const value of Object.values(material)) {
        if (value?.isTexture) addOwnedTexture(value);
      }
      for (const uniform of Object.values(material.uniforms || {})) {
        const value = uniform?.value;
        if (value?.isTexture) addOwnedTexture(value);
        else if (Array.isArray(value)) {
          for (const item of value) if (item?.isTexture) addOwnedTexture(item);
        }
      }
    };
    borrower.traverse((object) => {
      if (object.geometry?.dispose) {
        (isSharedResource(object.geometry) ? moduleSharedResources : ownedResources).add(object.geometry);
      }
      const objectMaterials = Array.isArray(object.material)
        ? object.material
        : (object.material ? [object.material] : []);
      for (const material of objectMaterials) addOwnedMaterial(material);
    });
    let sharedDisposeEvents = 0;
    let moduleSharedDisposeEvents = 0;
    const ownedDisposeCounts = new Map();
    const onDispose = () => { sharedDisposeEvents++; };
    const onModuleSharedDispose = () => { moduleSharedDisposeEvents++; };
    const onOwnedDispose = (event) => ownedDisposeCounts.set(
      event.target, (ownedDisposeCounts.get(event.target) || 0) + 1,
    );
    for (const resource of sharedResources) resource.addEventListener('dispose', onDispose);
    for (const resource of moduleSharedResources) resource.addEventListener('dispose', onModuleSharedDispose);
    for (const resource of ownedResources) resource.addEventListener('dispose', onOwnedDispose);
    const borrowerFirst = disposeBuilding(borrower);
    const afterBorrower = sharedDisposeEvents;
    const borrowerSecond = disposeBuilding(borrower);
    const afterDuplicate = sharedDisposeEvents;
    const ownerFirst = disposeBuilding(owner);
    const afterOwner = sharedDisposeEvents;
    for (const resource of sharedResources) resource.removeEventListener('dispose', onDispose);
    for (const resource of moduleSharedResources) resource.removeEventListener('dispose', onModuleSharedDispose);
    for (const resource of ownedResources) resource.removeEventListener('dispose', onOwnedDispose);
    return {
      borrowerFirst,
      borrowerSecond,
      ownerFirst,
      afterBorrower,
      afterDuplicate,
      afterOwner,
      sharedCount: sharedResources.size,
      moduleSharedCount: moduleSharedResources.size,
      moduleSharedDisposeEvents,
      ownedCount: ownedResources.size,
      ownedDisposed: ownedDisposeCounts.size,
      ownedDuplicates: [...ownedDisposeCounts.values()].filter((count) => count !== 1).length,
    };
  }, { buildingModuleUrl: buildingApiUrl, resourceModuleUrl: resourceApiUrl });
  pass(
    lifecycleContract.borrowerFirst
      && !lifecycleContract.borrowerSecond
      && lifecycleContract.ownerFirst
      && lifecycleContract.afterBorrower === 0
      && lifecycleContract.afterDuplicate === 0
      && lifecycleContract.afterOwner === lifecycleContract.sharedCount
      && lifecycleContract.moduleSharedDisposeEvents === 0
      && lifecycleContract.ownedDisposed === lifecycleContract.ownedCount
      && lifecycleContract.ownedDuplicates === 0,
    `building lifecycle preserves ${lifecycleContract.sharedCount} injected + ${lifecycleContract.moduleSharedCount} module-shared resources and releases ${lifecycleContract.ownedDisposed}/${lifecycleContract.ownedCount} owned resources exactly once`,
  );

  const authenticityContract = await page.evaluate(async ({ buildingModuleUrl }) => {
    const { PRESETS, buildBuilding, disposeBuilding } = await import(buildingModuleUrl);
    const buildings = {
      palace: buildBuilding({ ...PRESETS.korea }),
      templePaljak: buildBuilding({ ...PRESETS.temple, roofType: 'paljak' }),
      jeongja: buildBuilding({ ...PRESETS.giwa, doorPattern: 'jeongja' }),
      sesal: buildBuilding({ ...PRESETS.giwa, doorPattern: 'sesal' }),
    };
    const greenRatio = (building) => {
      const canvas = building.userData.materials.door.map.image;
      const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let green = 0;
      let sampled = 0;
      for (let i = 0; i < data.length; i += 4 * 4) {
        const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
        if (a < 128) continue;
        sampled++;
        if (g > r * 1.15 && g > b * 1.15) green++;
      }
      return green / Math.max(1, sampled);
    };
    const ornamentCounts = (building) => {
      const counts = { chwidu: 0, japsang: 0 };
      building.traverse((object) => {
        if (object.name === 'palace-chwidu') counts.chwidu++;
        if (object.name === 'palace-japsang') counts.japsang++;
      });
      return counts;
    };
    const result = {
      green: {
        palace: greenRatio(buildings.palace),
        jeongja: greenRatio(buildings.jeongja),
        sesal: greenRatio(buildings.sesal),
      },
      palace: ornamentCounts(buildings.palace),
      templePaljak: ornamentCounts(buildings.templePaljak),
    };
    for (const building of Object.values(buildings)) disposeBuilding(building);
    return result;
  }, { buildingModuleUrl: buildingApiUrl });
  pass(
    authenticityContract.green.palace > 0.03
      && authenticityContract.green.jeongja < 0.001
      && authenticityContract.green.sesal < 0.001,
    `civilian lattice keeps bare timber/hanji while palace color remains (${JSON.stringify(authenticityContract.green)})`,
  );
  pass(
    authenticityContract.palace.chwidu > 0
      && authenticityContract.palace.japsang > 0
      && authenticityContract.templePaljak.chwidu === 0
      && authenticityContract.templePaljak.japsang === 0,
    `palace roof ornaments do not leak into a paljak temple (${JSON.stringify(authenticityContract)})`,
  );

  // 고증 조사도 제품 신뢰 표면이다. docs/credits.md를 파싱하는 실제 Reference 모달에서
  // 사용자가 출처→구현 해석과 원문을 함께 확인할 수 있어야 한다.
  await page.locator('.seal-label .info').click();
  const kitchenCredit = page.locator('.modal .cat li').filter({
    hasText: '국사편찬위원회 · 한국학중앙연구원 — 조선 살림집 부엌·구들·굴뚝',
  });
  const ornamentCredit = page.locator('.modal .cat li').filter({
    hasText: '국가유산청 · 한국학중앙연구원 — 궁궐 지붕 장식과 잡상',
  });
  const openingCredit = page.locator('.modal .cat li').filter({
    hasText: '국가유산청 국가유산포털 — 경복궁 근정전 창호 철물 정밀실측도',
  });
  const footwearCredit = page.locator('.modal .cat li').filter({
    hasText: '국립익산박물관 · 국립중앙박물관 · Korea.net — 조선 신발과 문간 탈화 생활',
  });
  await kitchenCredit.waitFor({ state: 'visible', timeout });
  await ornamentCredit.waitFor({ state: 'visible', timeout });
  await openingCredit.waitFor({ state: 'visible', timeout });
  await footwearCredit.waitFor({ state: 'visible', timeout });
  const referenceContract = {
    kitchenLinks: await kitchenCredit.locator('a').count(),
    ornamentLinks: await ornamentCredit.locator('a').count(),
    openingLinks: await openingCredit.locator('a').count(),
    footwearLinks: await footwearCredit.locator('a').count(),
    kitchenUse: await kitchenCredit.locator('.it-use').textContent(),
    ornamentUse: await ornamentCredit.locator('.it-use').textContent(),
    openingUse: await openingCredit.locator('.it-use').textContent(),
    openingHref: await openingCredit.locator('a').getAttribute('href'),
    footwearUse: await footwearCredit.locator('.it-use').textContent(),
    footwearHrefs: await footwearCredit.locator('.it-links a')
      .evaluateAll((links) => links.map((link) => link.getAttribute('href'))),
    footwearLicense: await footwearCredit.locator('.it-license').textContent(),
    safeLinks: await page.locator('.modal .it-links a').evaluateAll((links) => links.every((link) => (
      link.target === '_blank'
        && link.rel.split(/\s+/).includes('noopener')
        && link.rel.split(/\s+/).includes('noreferrer')
    ))),
  };
  pass(
    referenceContract.kitchenLinks === 3
      && referenceContract.ornamentLinks === 2
      && referenceContract.openingLinks === 1
      && referenceContract.footwearLinks === 4
      && referenceContract.kitchenUse?.includes('마당 높이 부엌 개구 안')
      && referenceContract.ornamentUse?.includes('palace 전용 경계')
      && referenceContract.openingUse?.includes('민가에 그대로 복제하지 않는다')
      && referenceContract.openingUse?.includes('경첩 띠 두 개와 고리 하나')
      && referenceContract.openingUse?.includes('선택 FULL 주거 근경')
      && referenceContract.openingUse?.includes('경첩 쪽 한 짝·청판·고리·띠를 같은 jamb-edge pivot')
      && referenceContract.openingUse?.includes('관아·궁·사찰 복합체는')
      && referenceContract.openingUse?.includes('열림 각도·감쇠 운동은 실측 복원이 아니라')
      && referenceContract.openingHref?.includes('file_seq=2839493')
      && referenceContract.openingHref?.includes('title3d=')
      && referenceContract.footwearUse?.includes('접근 쪽 문설주 바깥')
      && referenceContract.footwearUse?.includes('현대 고무신')
      && FOOTWEAR_REFERENCE_URLS.every((url, index) => (
        referenceContract.footwearHrefs[index] === url
      ))
      && referenceContract.footwearLicense?.includes('저작권 보호')
      && referenceContract.footwearLicense?.includes('공공누리 제3유형')
      && referenceContract.safeLinks,
    `Reference UI exposes authenticity evidence and applied-use mapping (${JSON.stringify(referenceContract)})`,
  );
  await page.locator('.modal .x').click();

  // Palace and temple are authored multi-building compounds. Until a main-hall
  // role is preserved through their optimized roots, product interaction must
  // not silently choose an arbitrary duplicated or merged primary leaf.
  const compoundPage = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const compoundErrors = [];
  compoundPage.on('pageerror', (error) => compoundErrors.push(error.message));
  await compoundPage.goto(
    `http://127.0.0.1:${port}/?hero=0&village=1&worker=0&vscale=capital&vpalace=1&vtemple=1&seed=42&vseed=20260716&time=day&lang=ko`,
    { waitUntil: 'domcontentloaded', timeout },
  );
  await compoundPage.waitForFunction(() => window.__SHOT_READY === true && !!window.__engine, null, { timeout });
  await compoundPage.evaluate(() => {
    const engine = window.__engine;
    if (engine.debugDof().tweenProgress != null) engine.debugDofSeek(1, { finish: true });
  });
  const compoundIds = await compoundPage.evaluate(() => (
    window.__engine.village.debugParcels().map((parcel) => parcel.parcelId)
  ));
  const compoundScope = {};
  for (const [index, parcelId] of ['palace', 'temple'].entries()) {
    await compoundPage.evaluate(({ id, first }) => {
      const engine = window.__engine;
      if (first) engine.village.debugFocus(id);
      else engine.village.switchTo(id);
    }, { id: parcelId, first: index === 0 });
    await compoundPage.waitForFunction((id) => {
      const engine = window.__engine;
      return engine.village.getState().selected === id
        && (!engine.village.getState().transitioning || engine.debugDof().tweenProgress != null);
    }, parcelId, { timeout });
    await compoundPage.evaluate(() => {
      const engine = window.__engine;
      if (engine.debugDof().tweenProgress != null) engine.debugDofSeek(1, { finish: true });
    });
    await compoundPage.waitForFunction((id) => {
      const state = window.__engine.village.getState();
      return state.selected === id && !state.transitioning;
    }, parcelId, { timeout });
    compoundScope[parcelId] = await compoundPage.evaluate((id) => {
      const engine = window.__engine;
      const root = engine.village.focusRoot();
      let pivots = 0;
      root?.traverse((object) => { if (object.name === 'primary-door-pivot') pivots++; });
      return {
        selected: engine.village.getState().selected,
        door: engine.village.debugDoorInteraction(id),
        screen: engine.village.debugDoorScreen(id),
        pivots,
      };
    }, parcelId);
  }
  // A town has no landmark palace proxy, but its reserved hero is a palace-style
  // magistracy/guest-house core. `hero` alone is therefore not a residential
  // interaction role; the authored heroStyle must survive into runtime scope.
  await compoundPage.goto(
    `http://127.0.0.1:${port}/?hero=0&village=1&worker=0&vscale=town&vpalace=0&vtemple=0&seed=42&vseed=20260716&time=day&lang=ko`,
    { waitUntil: 'domcontentloaded', timeout },
  );
  await compoundPage.waitForFunction(() => window.__SHOT_READY === true && !!window.__engine, null, { timeout });
  await compoundPage.evaluate(() => {
    const engine = window.__engine;
    if (engine.debugDof().tweenProgress != null) engine.debugDofSeek(1, { finish: true });
  });
  const magistracyId = await compoundPage.evaluate(() => (
    window.__engine.village.debugParcels()
      .find((parcel) => parcel.hero && parcel.heroStyle === 'palace')?.parcelId || null
  ));
  let magistracyScope = null;
  if (magistracyId) {
    await compoundPage.evaluate((id) => window.__engine.village.debugFocus(id), magistracyId);
    await compoundPage.waitForFunction((id) => {
      const engine = window.__engine;
      return engine.village.getState().selected === id
        && (!engine.village.getState().transitioning || engine.debugDof().tweenProgress != null);
    }, magistracyId, { timeout });
    await compoundPage.evaluate(() => {
      const engine = window.__engine;
      if (engine.debugDof().tweenProgress != null) engine.debugDofSeek(1, { finish: true });
    });
    await compoundPage.waitForFunction((id) => {
      const state = window.__engine.village.getState();
      return state.selected === id && !state.transitioning;
    }, magistracyId, { timeout });
    magistracyScope = await compoundPage.evaluate((id) => {
      const engine = window.__engine;
      const root = engine.village.focusRoot();
      let pivots = 0;
      root?.traverse((object) => { if (object.name === 'primary-door-pivot') pivots++; });
      return {
        parcel: engine.village.debugParcels().find((candidate) => candidate.parcelId === id),
        door: engine.village.debugDoorInteraction(id),
        screen: engine.village.debugDoorScreen(id),
        pivots,
      };
    }, magistracyId);
  }
  await compoundPage.close();
  pass(['palace', 'temple'].every((id) => compoundIds.includes(id)
      && compoundScope[id]?.selected === id
      && compoundScope[id].door == null
      && compoundScope[id].screen == null
      && compoundScope[id].pivots === 0)
      && compoundErrors.length === 0,
  `palace/temple focus keeps ambiguous compound doors non-interactive (${JSON.stringify(compoundScope)})`);
  pass(magistracyScope?.parcel?.heroStyle === 'palace'
      && magistracyScope.door == null
      && magistracyScope.screen == null
      && magistracyScope.pivots === 0,
  `town magistracy hero remains outside residential door interaction (${JSON.stringify(magistracyScope)})`);

  // Return this existing app boot to the standalone house, select it, and
  // exercise the narrow ParamPanel owner. The global ActionBar is deliberately
  // absent while hideActions=true, so ParamPanel must own exactly one share
  // action instead of dropping the capability.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => {
    const engine = window.__engine;
    engine.village.exit();
    engine.select();
  });
  await page.waitForFunction(() => {
    const sheet = document.querySelector('.sheet.right');
    return window.__device?.sheet === true
      && !window.__engine.village.getState().active
      && sheet?.dataset.snap === 'half'
      && sheet.getAttribute('aria-hidden') === 'false'
      && !sheet.inert;
  }, null, { timeout });
  const singleHouseShare = page.locator('.sheet.right [data-action="share"]');
  await singleHouseShare.waitFor({ state: 'visible', timeout });
  const singleHouseShareLayout = await singleHouseShare.evaluate((button) => {
    const rect = button.getBoundingClientRect();
    const sheet = button.closest('.sheet.right')?.getBoundingClientRect();
    const title = button.parentElement?.querySelector('.title')?.getBoundingClientRect();
    const close = button.closest('.sheet.right')?.querySelector('.grip .x')?.getBoundingClientRect();
    const overlap = (a, b) => b
      ? Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left))
        * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top))
      : 0;
    return {
      count: document.querySelectorAll('[data-action="share"]').length,
      owner: button.closest('.sheet.right')?.getAttribute('aria-label') || null,
      ownerInert: button.closest('.sheet.right')?.inert ?? null,
      hiddenAncestor: !!button.closest('[inert], [aria-hidden="true"]'),
      globalActionBar: document.querySelectorAll('.actions').length,
      left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
      width: rect.width, height: rect.height,
      sheetLeft: sheet?.left ?? null,
      sheetRight: sheet?.right ?? null,
      titleOverlap: overlap(rect, title),
      closeOverlap: overlap(rect, close),
      viewport: [innerWidth, innerHeight],
    };
  });
  pass(singleHouseShareLayout.count === 1
      && singleHouseShareLayout.owner === 'build panel'
      && singleHouseShareLayout.ownerInert === false
      && !singleHouseShareLayout.hiddenAncestor
      && singleHouseShareLayout.globalActionBar === 0
      && singleHouseShareLayout.width >= 44
      && singleHouseShareLayout.height >= 43.9
      && singleHouseShareLayout.left >= singleHouseShareLayout.sheetLeft
      && singleHouseShareLayout.right <= singleHouseShareLayout.sheetRight
      && singleHouseShareLayout.top >= 0
      && singleHouseShareLayout.bottom <= 844
      && singleHouseShareLayout.titleOverlap === 0
      && singleHouseShareLayout.closeOverlap === 0,
  `390x844 standalone edit share stays in the active ParamPanel owner without a global duplicate (${JSON.stringify(singleHouseShareLayout)})`);
  if (captureDir) {
    await page.screenshot({ path: join(captureDir, 'share-mobile-single-house.png') });
  }

  // Establish the source through App's public type action so the canonical
  // snapshot owns the same base building as the receiver, not only slider deltas.
  await page.locator('.tab').nth(3).click();
  await page.waitForFunction(() => window.__engine.getState().preset === 'choga'
    && !!window.__engine.captureView(), null, { timeout });
  const standalonePatch = { eaveOverhang: 1.85, cornerLift: 0.72 };
  await page.locator('input[data-param="eaveOverhang"]').fill(String(standalonePatch.eaveOverhang));
  await page.locator('input[data-param="cornerLift"]').fill(String(standalonePatch.cornerLift));
  await page.waitForFunction((patch) => {
    const engine = window.__engine;
    const params = engine?.getParams?.();
    return Object.entries(patch).every(([key, value]) => params?.[key] === value)
      && !!engine?.captureView?.();
  }, standalonePatch, { timeout });
  await page.waitForFunction(() => window.__engine.__debugAssemblyActive(), null, { timeout });
  await page.waitForFunction(() => !window.__engine.__debugAssemblyActive(), null, { timeout });
  const standaloneSource = await page.evaluate(() => ({
    state: window.__engine.getState(),
    params: window.__engine.getParams(),
    view: window.__engine.captureView(),
    assembly: window.__engine.__debugAssemblyActive(),
  }));

  await page.evaluate(() => {
    Object.assign(window.__shareProbe, { nativeMode: 'success', clipboardMode: 'success' });
    window.__shareProbe.nativePayloads.length = 0;
    window.__shareProbe.nativeActivations.length = 0;
    window.__shareProbe.clipboardValues.length = 0;
  });
  await singleHouseShare.click();
  await page.waitForFunction(() => document.querySelector('.toast')?.textContent?.trim() === '장면 링크를 공유했습니다', null, { timeout });
  const singleHouseShareCall = await page.evaluate(() => {
    const payload = window.__shareProbe.nativePayloads[0];
    const query = new URL(payload?.url || location.href).searchParams;
    return {
      native: window.__shareProbe.nativePayloads.length,
      activation: window.__shareProbe.nativeActivations[0] || null,
      clipboard: window.__shareProbe.clipboardValues.length,
      payloadUrl: payload?.url || null,
      queryKeys: [...query.keys()],
      toast: document.querySelector('.toast')?.textContent?.trim() || null,
    };
  });
  const singleHouseSnapshot = decodeSceneSnapshot(
    new URL(singleHouseShareCall.payloadUrl).searchParams.get(SCENE_SNAPSHOT_QUERY_KEY),
  );
  pass(singleHouseShareCall.native === 1
      && singleHouseShareCall.activation?.userActivation
      && singleHouseShareCall.activation?.eventTask
      && singleHouseShareCall.clipboard === 0
      && singleHouseShareCall.queryKeys.length === 1
      && singleHouseShareCall.queryKeys[0] === SCENE_SNAPSHOT_QUERY_KEY
      && singleHouseSnapshot?.village == null
      && JSON.stringify(singleHouseSnapshot?.standaloneParams) === JSON.stringify(standalonePatch)
      && !!singleHouseSnapshot?.view
      && singleHouseShareCall.toast === '장면 링크를 공유했습니다',
  `standalone ParamPanel share invokes native sharing synchronously with no stale village state (${JSON.stringify(singleHouseShareCall)})`);

  const standalonePage = await browser.newPage({ viewport: { width: 390, height: 844 } });
  standalonePage.on('pageerror', (error) => runtimeErrors.push(`standalone shared page: ${error.message}`));
  standalonePage.on('console', (message) => {
    if (message.type() === 'error' && !/favicon|404/i.test(message.text())) {
      runtimeErrors.push(`standalone shared console: ${message.text()}`);
    }
  });
  await standalonePage.goto(singleHouseShareCall.payloadUrl, {
    waitUntil: 'domcontentloaded',
    timeout,
  });
  await standalonePage.waitForFunction((patch) => {
    const engine = window.__engine;
    const params = engine?.getParams?.();
    return window.__SHOT_READY === true
      && Object.entries(patch).every(([key, value]) => params?.[key] === value)
      && !!engine?.captureView?.();
  }, standalonePatch, { timeout });
  await standalonePage.evaluate(() => new Promise((resolveFrame) => requestAnimationFrame(resolveFrame)));
  const standaloneFirst = await standalonePage.evaluate(() => ({
    address: location.href,
    state: window.__engine.getState(),
    params: window.__engine.getParams(),
    view: window.__engine.captureView(),
    assembly: window.__engine.__debugAssemblyActive(),
  }));
  await standalonePage.reload({ waitUntil: 'domcontentloaded', timeout });
  await standalonePage.waitForFunction((patch) => {
    const engine = window.__engine;
    const params = engine?.getParams?.();
    return window.__SHOT_READY === true
      && Object.entries(patch).every(([key, value]) => params?.[key] === value)
      && !!engine?.captureView?.();
  }, standalonePatch, { timeout });
  await standalonePage.evaluate(() => new Promise((resolveFrame) => requestAnimationFrame(resolveFrame)));
  const standaloneReloaded = await standalonePage.evaluate(() => ({
    address: location.href,
    state: window.__engine.getState(),
    params: window.__engine.getParams(),
    view: window.__engine.captureView(),
    assembly: window.__engine.__debugAssemblyActive(),
  }));
  const standaloneReloadedSnapshot = decodeSceneSnapshot(
    new URL(standaloneReloaded.address).searchParams.get(SCENE_SNAPSHOT_QUERY_KEY),
  );
  if (captureDir) {
    await standalonePage.screenshot({ path: join(captureDir, 'scene-snapshot-standalone-reloaded.png') });
  }
  pass(Object.entries(standalonePatch)
    .every(([key, value]) => standaloneFirst.params[key] === value
      && standaloneReloaded.params[key] === value)
      && standaloneFirst.state.preset === standaloneSource.state.preset
      && standaloneReloaded.state.preset === standaloneSource.state.preset
      && standaloneFirst.params.roofPitch === standaloneSource.params.roofPitch
      && standaloneReloaded.params.profileCurve === standaloneSource.params.profileCurve
      && standaloneSource.assembly === false
      && standaloneFirst.assembly === false
      && standaloneReloaded.assembly === false
      && semanticViewClose(standaloneFirst.view, singleHouseSnapshot.view)
      && semanticViewClose(standaloneReloaded.view, singleHouseSnapshot.view)
      && JSON.stringify(standaloneReloadedSnapshot?.standaloneParams)
        === JSON.stringify(standalonePatch)
      && [...new URL(standaloneReloaded.address).searchParams.keys()].join()
        === SCENE_SNAPSHOT_QUERY_KEY,
  `standalone committed geometry and semantic composition survive exact share URL + reload (${JSON.stringify({
    source: standaloneSource,
    first: standaloneFirst,
    reloaded: standaloneReloaded,
  })})`);

  const manualStandaloneBeforeAddress = standaloneReloaded.address;
  const manualStandaloneBeforeView = standaloneReloaded.view;
  await standalonePage.evaluate(() => {
    const audit = { starts: 0, ends: 0, settled: 0 };
    window.__engine.__controls.addEventListener('start', () => { audit.starts += 1; });
    window.__engine.__controls.addEventListener('end', () => { audit.ends += 1; });
    window.__engine.on('viewSettled', () => { audit.settled += 1; });
    window.__standaloneOrbitAudit = audit;
  });
  const dragStandalone = async ({ from, to }) => {
    await standalonePage.mouse.move(from.x, from.y);
    await standalonePage.mouse.down();
    await standalonePage.mouse.move(to.x, to.y, { steps: 8 });
    await standalonePage.mouse.up();
  };
  const waitForStandaloneInput = () => standalonePage.waitForFunction(
    (before) => {
      const current = window.__engine?.captureView?.();
      if (!current) return false;
      const azimuthDelta = Math.abs((((current.azimuth - before.azimuth) % 360) + 540) % 360 - 180);
      return azimuthDelta > 0.25
        || Math.abs(current.elevation - before.elevation) > 0.25
        || Math.abs(current.zoom - before.zoom) > 0.002
        || Math.abs(current.panEast - before.panEast) > 0.002
        || Math.abs(current.panUp - before.panUp) > 0.002
        || Math.abs(current.panSouth - before.panSouth) > 0.002;
    },
    manualStandaloneBeforeView,
    { timeout: 3_000 },
  ).then(() => true, () => false);

  // This late mobile page competes with two retained product pages in the
  // full merge profile. Make input ownership explicit and fail fast if the
  // trusted drag itself was not delivered; a moved camera with an unchanged
  // URL is the separate product settlement failure below.
  await standalonePage.bringToFront();
  await dragStandalone({ from: { x: 195, y: 300 }, to: { x: 235, y: 320 } });
  const standaloneInputMoved = await waitForStandaloneInput();
  if (!standaloneInputMoved) {
    const hit = await standalonePage.evaluate(() => {
      const node = document.elementFromPoint(195, 300);
      return { tag: node?.tagName || null, className: node?.className || null };
    });
    throw new Error(`standalone OrbitControls fixture delivered no camera movement: ${JSON.stringify(hit)}`);
  }
  await standalonePage.waitForFunction(
    (beforeAddress) => location.href !== beforeAddress,
    manualStandaloneBeforeAddress,
    { timeout: 10_000 },
  ).catch(async (error) => {
    const evidence = await standalonePage.evaluate(() => ({
      address: location.href,
      view: window.__engine?.captureView?.() || null,
      reveal: window.__engine?.debugArchitecturalReveal?.() || null,
      audit: window.__standaloneOrbitAudit || null,
    }));
    throw new Error(`standalone camera moved but semantic URL did not settle: ${JSON.stringify(evidence)}`, {
      cause: error,
    });
  });
  const manualStandaloneView = await standalonePage.evaluate((beforeAddress) => ({
    beforeAddress,
    afterAddress: location.href,
    view: window.__engine.captureView(),
    audit: window.__standaloneOrbitAudit,
  }), manualStandaloneBeforeAddress);
  const manualStandaloneSnapshot = decodeSceneSnapshot(
    new URL(manualStandaloneView.afterAddress).searchParams.get(SCENE_SNAPSHOT_QUERY_KEY),
  );
  pass(manualStandaloneView.afterAddress !== manualStandaloneView.beforeAddress
      && semanticViewClose(manualStandaloneSnapshot?.view, manualStandaloneView.view)
      && manualStandaloneView.audit.starts === 1
      && manualStandaloneView.audit.ends === 1
      && manualStandaloneView.audit.settled === 1,
  `standalone OrbitControls end commits the settled semantic view to the canonical address (${JSON.stringify({
    view: manualStandaloneView.view,
    audit: manualStandaloneView.audit,
  })})`);
  await standalonePage.close();

  // A pending old-type slider callback must not write into a newly reset P.
  // Reroll then establishes a second baseline and its next share omits hp.
  await page.locator('.tab').nth(0).click();
  await page.waitForFunction(() => window.__engine.getState().preset === 'korea'
    && !!window.__engine.captureView(), null, { timeout });
  // Dispatch the old-type input and type switch in one browser task. This
  // guarantees the 110ms callback is still pending when its generation ends,
  // rather than relying on Playwright command latency to happen under 110ms.
  await page.evaluate(() => {
    const input = document.querySelector('input[data-param="eaveOverhang"]');
    const tab = document.querySelectorAll('.tab')[2];
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setValue.call(input, '2.75');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    tab.click();
  });
  await page.waitForFunction(() => window.__engine.getState().preset === 'giwa'
    && !!window.__engine.captureView(), null, { timeout });
  await page.waitForTimeout(300);
  const staleParamReset = await page.evaluate(async () => {
    const { paramsFor } = await import('/src/lib/seed.js');
    return {
      preset: window.__engine.getState().preset,
      params: window.__engine.getParams(),
      expectedEaveOverhang: paramsFor('giwa').eaveOverhang,
    };
  });
  pass(staleParamReset.preset === 'giwa'
      && staleParamReset.params.eaveOverhang === staleParamReset.expectedEaveOverhang,
    `type reset rejects the previous slider generation (${JSON.stringify(staleParamReset)})`);

  await page.locator('input[data-param="eaveOverhang"]').fill('1.9');
  await page.waitForFunction(() => window.__engine.getParams().eaveOverhang === 1.9, null, { timeout });
  await page.evaluate(() => window.__engine.clearSelection());
  await page.waitForFunction(() => !window.__engine.getState().selected
    && !!window.__engine.captureView(), null, { timeout });
  const beforeRerollSeed = await page.evaluate(() => window.__engine.getState().seed);
  await page.evaluate(() => document.querySelector('.actions .primary').click());
  await page.waitForFunction((seed) => window.__engine.getState().seed !== seed
    && !!window.__engine.captureView(), beforeRerollSeed, { timeout });
  await page.evaluate(() => {
    Object.assign(window.__shareProbe, { nativeMode: 'success', clipboardMode: 'success' });
    window.__shareProbe.nativePayloads.length = 0;
    window.__shareProbe.nativeActivations.length = 0;
    window.__shareProbe.clipboardValues.length = 0;
  });
  await page.evaluate(() => document.querySelector('.actions [data-action="share"]').click());
  await page.waitForFunction(() => window.__shareProbe.nativePayloads.length === 1, null, { timeout });
  const rerolledShareUrl = await page.evaluate(
    () => window.__shareProbe.nativePayloads[0]?.url || null,
  );
  const rerolledSnapshot = decodeSceneSnapshot(
    new URL(rerolledShareUrl).searchParams.get(SCENE_SNAPSHOT_QUERY_KEY),
  );
  const rerolledParams = await page.evaluate(() => window.__engine.getParams());
  pass(Object.keys(rerolledSnapshot?.standaloneParams || {}).length === 0
      && rerolledParams.eaveOverhang !== 1.9,
  `standalone reroll resets committed hp overrides (${JSON.stringify(rerolledSnapshot?.standaloneParams)})`);
  await page.evaluate(() => {
    // Restore the pre-existing downstream environment fixture after reroll
    // deliberately exercised a new seed-derived profile.
    window.__engine.setTime('night', { immediate: true });
    window.__engine.setSeason('autumn', { immediate: true });
    window.__engine.setWeather('clear', { immediate: true });
    window.__engine.select();
  });
  await page.waitForFunction(() => window.__engine.getState().selected
    && !!window.__engine.captureView(), null, { timeout });

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForFunction(() => window.__device?.sheet === false
    && !!document.querySelector('.panel:not([inert])')
    && document.querySelectorAll('[data-action="share"]').length === 1
    && !!document.querySelector('.actions [data-action="share"]'), null, { timeout });

  const texturePlateau = await page.evaluate(() => {
    const engine = window.__engine;
    let thresholdLifeCount = 0;
    engine.village.exportRoot()?.traverse((object) => {
      if (object.name === 'threshold-life-detail') thresholdLifeCount++;
    });
    const environment = engine.scene.getObjectByName('environment');
    const motes = environment?.getObjectByName('dustMotes')?.material?.uniforms;
    const smokeSprite = environment?.getObjectByName('smoke')?.children.find((object) => object.isSprite && object.visible);
    const sun = engine.scene.children.find((object) => object.isDirectionalLight && object.castShadow);
    const resumedEnvironment = {
      visible: environment?.visible === true,
      sunIntensity: sun?.intensity,
      sunColor: sun?.color?.getHex(),
      fogNear: engine.scene.fog?.near,
      fogFar: engine.scene.fog?.far,
      fogColor: engine.scene.fog?.color?.getHex(),
      moteIntensity: motes?.uIntensity?.value,
      moteColor: motes?.uColor?.value?.getHex(),
      // No assigned emitter is also settled: the first visible update detects the rebuilt house
      // after the immediate profile snap, so a stale smoke sprite cannot be rendered meanwhile.
      smokeColor: smokeSprite?.material?.color?.getHex() ?? null,
    };
    engine.setType('choga');
    // setType의 조립 초반에는 아직 숨은 재질이 있어 첫 렌더가 전체 텍스처를 업로드하지 않는다.
    // 완성 상태 1회를 워밍한 뒤, 같은 완성 상태의 교체들만 steady-state로 비교한다.
    engine.__debugFreezeRebuild(1);
    engine.renderer.render(engine.scene, engine.camera);
    const samples = [engine.renderer.info.memory.textures];
    for (let i = 0; i < 6; i++) {
      engine.__debugFreezeRebuild(1);
      engine.renderer.render(engine.scene, engine.camera);
      samples.push(engine.renderer.info.memory.textures);
    }
    return {
      samples,
      stable: samples.every((count) => count === samples[0]),
      resumedEnvironment,
      thresholdLifeCount,
    };
  });
  const resumed = texturePlateau.resumedEnvironment;
  pass(
    resumed.visible
      && Math.abs(resumed.sunIntensity - 0.9) < 1e-6
      && resumed.sunColor === 0x9fb4d9
      && resumed.fogNear === 60 && resumed.fogFar === 400 && resumed.fogColor === 0x1a2740
      && Math.abs(resumed.moteIntensity - 0.5) < 1e-6
      && resumed.moteColor === 0xcdd8f0
      && (resumed.smokeColor == null || resumed.smokeColor === 0x969eae),
    `single-house environment resumes directly at the hidden night profiles (${JSON.stringify(resumed)})`,
  );
  pass(
    texturePlateau.stable && texturePlateau.samples[0] > 0,
    `repeated visible building rebuilds keep GPU textures flat (${texturePlateau.samples.join(' → ')})`,
  );
  pass(texturePlateau.thresholdLifeCount === 0,
    'village exit/focus-out releases threshold footwear from the retained village handle');

  const teardown = await page.evaluate(async () => {
    const engine = window.__engine;
    const canvas = engine.renderer.domElement;
    const environment = engine.scene.getObjectByName('environment');
    const geometries = new Set();
    const materials = new Set();
    const textures = new Set();
    const addTextures = (material) => {
      for (const value of Object.values(material || {})) if (value?.isTexture) textures.add(value);
      for (const uniform of Object.values(material?.uniforms || {})) {
        const value = uniform?.value;
        if (value?.isTexture) textures.add(value);
        else if (Array.isArray(value)) for (const item of value) if (item?.isTexture) textures.add(item);
      }
    };
    environment?.traverse((object) => {
      if (object.geometry?.dispose) geometries.add(object.geometry);
      const objectMaterials = Array.isArray(object.material)
        ? object.material
        : (object.material ? [object.material] : []);
      for (const material of objectMaterials) {
        materials.add(material);
        addTextures(material);
      }
    });
    const disposedGeometries = new Set();
    const disposedMaterials = new Set();
    const disposedTextures = new Set();
    const disposeCounts = new Map();
    const recordDispose = (target) => disposeCounts.set(target, (disposeCounts.get(target) || 0) + 1);
    const onGeometryDispose = (event) => { disposedGeometries.add(event.target); recordDispose(event.target); };
    const onMaterialDispose = (event) => { disposedMaterials.add(event.target); recordDispose(event.target); };
    const onTextureDispose = (event) => { disposedTextures.add(event.target); recordDispose(event.target); };
    for (const resource of geometries) resource.addEventListener('dispose', onGeometryDispose);
    for (const resource of materials) resource.addEventListener('dispose', onMaterialDispose);
    for (const resource of textures) resource.addEventListener('dispose', onTextureDispose);

    const lateCalls = { preload: 0, enter: 0, rerollWave: 0, setOpts: 0, setParam: 0, render: 0, compile: 0 };
    let tearingDown = false;
    const wrapLate = (owner, key, counter = key) => {
      const original = owner[key];
      owner[key] = function trackedLateCall(...args) {
        if (tearingDown) lateCalls[counter] += 1;
        return original.apply(this, args);
      };
    };
    for (const key of ['preload', 'enter', 'rerollWave', 'setOpts']) wrapLate(engine.village, key);
    wrapLate(engine, 'setParam');
    wrapLate(engine.renderer, 'render');
    if (typeof engine.renderer.compileAsync === 'function') wrapLate(engine.renderer, 'compileAsync', 'compile');

    let disposeCalls = 0;
    const ownedDispose = engine.dispose.bind(engine);
    engine.dispose = () => { disposeCalls += 1; return ownedDispose(); };

    // Re-arm the exact App-owned paths while the existing smoke app is live.
    // The ParamPanel input covers its separate debounce owner as well.
    const lifecycleHook = window.__appLifecycle;
    const armed = {
      preload: typeof lifecycleHook?.armPreload === 'function',
      veil: typeof lifecycleHook?.armVeil === 'function',
      reroll: typeof lifecycleHook?.armReroll === 'function',
      param: false,
    };
    lifecycleHook?.armPreload();
    lifecycleHook?.armVeil();
    lifecycleHook?.armReroll();
    // Start real engine-owned async work on this existing boot. chunkNodes=1
    // guarantees the export yields before teardown; hanyang guarantees preload
    // cannot finish synchronously and re-acquire the cache after disposal.
    engine.village.preload({ scale: 'hanyang', includeTemple: true }, 0x1100cafe);
    const exportTarget = engine.village.exportRoot();
    const pendingExport = engine.exportGLB(exportTarget, { chunkNodes: 1 }).then(
      () => 'resolved',
      (error) => error?.name || 'unknown',
    );
    const param = document.querySelector('.panel input[type="range"]');
    if (param) {
      armed.param = true;
      param.value = String(Number(param.min || 0) + Number(param.step || 0.01));
      param.dispatchEvent(new Event('input', { bubbles: true }));
    }

    const replacementNames = ['__device', '__envflow', '__glb', '__envRerollPick', '__appLifecycle'];
    const replacementHooks = Object.fromEntries(replacementNames.map((name) => [name, { owner: `new:${name}` }]));
    for (const name of replacementNames) window[name] = replacementHooks[name];
    const retainedEngineHooks = {
      viewshift: window.__viewshift,
      hero: window.__hero,
      asm: window.__asm,
    };
    const engineHookNames = ['__viewshift', '__hero', '__asm'];
    const replacementEngineHooks = Object.fromEntries(engineHookNames.map((name) => [name, { owner: `new:${name}` }]));
    for (const name of engineHookNames) window[name] = replacementEngineHooks[name];

    const { disposeApp } = await import('/src/main.js');
    tearingDown = true;
    const firstDispose = disposeApp();
    const secondDispose = disposeApp();
    const sharedDisposePromise = firstDispose === secondDispose;
    await Promise.all([firstDispose, secondDispose]);
    engine.dispose(); // retained callers remain harmless after the owned dispose
    const exportOutcome = await pendingExport;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const replacementHooksPreserved = replacementNames.every((name) => window[name] === replacementHooks[name]);
    const replacementEngineHooksPreserved = engineHookNames.every((name) => window[name] === replacementEngineHooks[name]);
    for (const name of replacementNames) delete window[name]; // remove harness-owned sentinels
    for (const name of engineHookNames) delete window[name];

    const lateCallsAfterFlush = { ...lateCalls };
    tearingDown = false;
    const disposedState = engine.getState();
    const disposedSeed = disposedState.seed;
    const unsubscribe = engine.on('state', () => {});
    engine.setParam('W', 999);
    retainedEngineHooks.viewshift.setEnabled(true);
    retainedEngineHooks.asm.seek(0.5);
    const postDisposeExport = await engine.exportGLB(exportTarget).then(
      () => 'resolved',
      (error) => error?.name || 'unknown',
    );
    const apiAfterDispose = {
      unsubscribe: typeof unsubscribe,
      stateStable: engine.getState().seed === disposedSeed,
      paramsPlain: !!engine.getParams() && !Array.isArray(engine.getParams()),
      villageReady: engine.village.isReady(),
      villagePlan: engine.village.debugPlan(),
      villageRoot: engine.village.exportRoot(),
      villageParcels: engine.village.debugParcels(),
      navigationTargets: engine.village.navigationTargets(),
      cineActive: engine.cine.isActive(),
      cineAvailable: engine.cine.available(),
      cinePasses: engine.cine.passList(),
      rerollStable: engine.reroll() === disposedSeed,
      resourcesNull: engine.renderer === null && engine.scene === null
        && engine.camera === null && engine.__controls === null,
      postDisposeExport,
      retainedHooksNeutral: retainedEngineHooks.viewshift.enabled === false
        && retainedEngineHooks.viewshift.x === 0
        && retainedEngineHooks.hero.selected == null
        && retainedEngineHooks.hero.dofAmount === 0
        && retainedEngineHooks.asm.active === false,
    };

    return {
      armed,
      replacementHooksPreserved,
      replacementEngineHooksPreserved,
      sharedDisposePromise,
      disposeCalls,
      lateCalls: lateCallsAfterFlush,
      exportOutcome,
      apiAfterDispose,
      villageAfterFlush: {
        ready: engine.village.isReady(),
        plan: engine.village.debugPlan(),
        root: !!engine.village.exportRoot(),
      },
      canvasConnected: canvas.isConnected,
      canvasCount: document.querySelectorAll('canvas').length,
      appChildren: document.getElementById('app')?.childElementCount ?? -1,
      environmentConnected: !!environment?.parent,
      environmentResources: {
        geometries: [disposedGeometries.size, geometries.size],
        materials: [disposedMaterials.size, materials.size],
        textures: [disposedTextures.size, textures.size],
      },
      duplicateDisposals: [...disposeCounts.values()].filter((count) => count !== 1).length,
      hooks: [
        '__engine', '__viewshift', '__hero', '__asm', '__wx', '__rim', '__flare', '__season',
        '__device', '__envflow', '__glb', '__envRerollPick', '__appLifecycle',
      ]
        .filter((name) => name in window),
      listeners: window.__listenerAudit.active(),
    };
  });
  pass(Object.values(teardown.armed).every(Boolean),
    `final app boot arms preload, veil, focus reroll, and ParamPanel debounce (${JSON.stringify(teardown.armed)})`);
  pass(teardown.replacementHooksPreserved,
    'unmount preserves debug hooks that a newer owner replaced by identity');
  pass(teardown.replacementEngineHooksPreserved,
    'engine teardown preserves each engine debug hook replaced by a newer owner');
  pass(teardown.sharedDisposePromise && teardown.disposeCalls === 2,
    `disposeApp shares one Svelte unmount and retained engine.dispose stays idempotent (${JSON.stringify({
      shared: teardown.sharedDisposePromise,
      calls: teardown.disposeCalls,
    })})`);
  pass(Object.values(teardown.lateCalls).every((count) => count === 0)
      && !teardown.villageAfterFlush.ready
      && teardown.villageAfterFlush.plan == null
      && !teardown.villageAfterFlush.root,
  `App unmount aborts late village, prewarm, and edit work (${JSON.stringify({
    calls: teardown.lateCalls,
    village: teardown.villageAfterFlush,
  })})`);
  pass(teardown.exportOutcome === 'AbortError',
    `dispose aborts an in-flight engine-owned GLB export (${teardown.exportOutcome})`);
  pass(
    teardown.apiAfterDispose.unsubscribe === 'function'
      && teardown.apiAfterDispose.stateStable
      && teardown.apiAfterDispose.paramsPlain
      && teardown.apiAfterDispose.villageReady === false
      && teardown.apiAfterDispose.villagePlan == null
      && teardown.apiAfterDispose.villageRoot == null
      && teardown.apiAfterDispose.villageParcels.length === 0
      && teardown.apiAfterDispose.navigationTargets.length === 0
      && teardown.apiAfterDispose.cineActive === false
      && teardown.apiAfterDispose.cineAvailable === false
      && teardown.apiAfterDispose.cinePasses.length === 0
      && teardown.apiAfterDispose.rerollStable
      && teardown.apiAfterDispose.resourcesNull
      && teardown.apiAfterDispose.postDisposeExport === 'AbortError'
      && teardown.apiAfterDispose.retainedHooksNeutral,
    `disposed engine API is table-driven fail-closed (${JSON.stringify(teardown.apiAfterDispose)})`,
  );
  pass(!teardown.canvasConnected && teardown.canvasCount === 0 && teardown.appChildren === 0,
    'disposeApp unmounts the component tree and removes the renderer canvas');
  pass(
    !teardown.environmentConnected
      && Object.values(teardown.environmentResources).every(([disposedCount, ownedCount]) => (
        ownedCount > 0 && disposedCount === ownedCount
      ))
      && teardown.duplicateDisposals === 0,
    `engine.dispose releases each environment resource exactly once (${JSON.stringify(teardown.environmentResources)}, duplicates ${teardown.duplicateDisposals})`,
  );
  pass(teardown.hooks.length === 0, `App and engine teardown remove owned debug hooks (${teardown.hooks.join(', ') || 'none'})`);
  pass(teardown.listeners.length === 0,
    `App, device, environment, and engine remove source-owned DOM listeners (${JSON.stringify(teardown.listeners)})`);
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
