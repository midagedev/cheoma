// UI shell contract (#158, docs/ui-consolidation.md §4) — the geometry gate the
// three-axis chrome never had. It is deliberately layout-only: no WebGL image
// judgement, no frame timing. Every assertion is a measured rect, a hit test, or
// an interactive-target size, taken at the five audited viewports.
//
//   1280x800 / 1024x640 (fine pointer)  ·  844x390 / 390x844 / 360x780 (coarse)
//
// Metrics (§4): panel scroll visible height >= 200px, the last control in the
// scrolled panel stays inside the viewport, the primary actions and the
// breadcrumb root are hittable, and editing keeps >= 40% of the frame on scene.
//
// Self-test: CHEOMA_UI_SHELL_BREAK=<css> injects a stylesheet before measuring,
// so a deliberate violation can be shown to FAIL this gate.
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from '../app/node_modules/vite/dist/node/index.js';
import { launchVerificationBrowser, reportWebGLRenderer } from './lib/verification-browser.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const APP_ROOT = join(ROOT, 'app');
const cacheDir = await mkdtemp(join(tmpdir(), 'cheoma-ui-shell-'));
const shotDir = process.env.CHEOMA_UI_SHELL_SHOT_DIR
  ? resolve(process.env.CHEOMA_UI_SHELL_SHOT_DIR)
  : join(ROOT, '_wt-out', 'ui-shell');
await mkdir(shotDir, { recursive: true });
const timeout = Number(process.env.CHEOMA_UI_SHELL_TIMEOUT_MS) || 90_000;
const breakCss = process.env.CHEOMA_UI_SHELL_BREAK || '';

const MIN_SCROLL_HEIGHT = 200;      // §4: 패널 가시 높이
const MIN_SCENE_RATIO = 0.40;       // §4: 편집 중 씬 가시율
const MIN_TARGET = 44;              // 터치 타깃

const ALL_VIEWPORTS = [
  { id: 'desktop-1280', width: 1280, height: 800, touch: false },
  { id: 'desktop-1024', width: 1024, height: 640, touch: false },
  { id: 'phone-landscape', width: 844, height: 390, touch: true },
  { id: 'phone-portrait', width: 390, height: 844, touch: true },
  { id: 'phone-small', width: 360, height: 780, touch: true },
];
// Iteration lever only: CHEOMA_UI_SHELL_VIEWPORTS=phone-portrait,phone-small narrows
// the run while fixing one layout. The gate itself always runs all five.
const only = (process.env.CHEOMA_UI_SHELL_VIEWPORTS || '').split(',').map((s) => s.trim()).filter(Boolean);
const VIEWPORTS = only.length ? ALL_VIEWPORTS.filter((v) => only.includes(v.id)) : ALL_VIEWPORTS;
if (only.length && VIEWPORTS.length !== only.length) throw new Error(`unknown viewport in ${only.join(',')}`);

const failures = [];
const pass = (condition, message) => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${message}`);
  if (!condition) failures.push(message);
};

// Chrome the scene has to share the frame with. Keep this list in sync with the
// three axes plus the seal and the onboarding guide.
const CHROME_SELECTOR = '[data-make-panel], .actions, .dial, [data-breadcrumb], .seal-label, [data-scene-guide]';

const server = await createServer({
  root: APP_ROOT,
  configFile: join(APP_ROOT, 'vite.config.js'),
  cacheDir,
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false },
});

let browser;
const runtimeErrors = [];

async function preparePage(context) {
  const page = await context.newPage();
  page.on('pageerror', (error) => runtimeErrors.push(`page: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' && !/favicon|404/i.test(message.text())) {
      runtimeErrors.push(`console: ${message.text()}`);
    }
  });
  return page;
}

// The appreciation fade removes chrome after 3s idle; layout measurement needs it
// visible and clickable, so pin it exactly like the other app harnesses do.
async function pinChroma(page) {
  await page.addStyleTag({ content: '.chroma { opacity: 1 !important; pointer-events: auto !important; }' });
  if (breakCss) await page.addStyleTag({ content: breakCss });
}

const MEASURE = `(selector) => {
  const viewport = { w: innerWidth, h: innerHeight };
  const rectOf = (element) => {
    if (!element) return null;
    const r = element.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
  };
  const clip = (r) => (r ? {
    left: Math.max(0, r.left), top: Math.max(0, r.top),
    right: Math.min(viewport.w, r.right), bottom: Math.min(viewport.h, r.bottom),
  } : null);
  const visibleArea = (r) => {
    const c = clip(r);
    if (!c) return 0;
    return Math.max(0, c.right - c.left) * Math.max(0, c.bottom - c.top);
  };
  const overlapArea = (a, b) => {
    if (!a || !b) return 0;
    return Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left))
      * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  };
  const inViewport = (r) => !!r && r.left >= -0.5 && r.top >= -0.5
    && r.right <= viewport.w + 0.5 && r.bottom <= viewport.h + 0.5;
  const hittable = (element) => {
    if (!element) return 'absent';
    // A collapsed shell keeps its children in layout with visibility:hidden. Those
    // still return client rects, and elementFromPoint returns the visible shell,
    // whose contains() check would otherwise report the hidden child as hittable.
    if (getComputedStyle(element).visibility === 'hidden') return 'hidden';
    const r = element.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return 'empty';
    const x = Math.min(viewport.w - 1, Math.max(1, r.left + r.width / 2));
    const y = Math.min(viewport.h - 1, Math.max(1, r.top + r.height / 2));
    const hit = document.elementFromPoint(x, y);
    if (!hit) return 'nothing';
    if (element.contains(hit) || hit.contains(element)) return 'hittable';
    const owner = hit.closest('button, a, select, [role=button]');
    if (owner && (element.contains(owner) || owner === element)) return 'hittable';
    return 'covered:' + (hit.className || hit.tagName);
  };

  const panel = document.querySelector('[data-make-panel]');
  const scroll = document.querySelector('[data-panel-scroll]');
  const dock = document.querySelector('.actions');
  const dial = document.querySelector('.dial');
  const crumbs = document.querySelector('[data-breadcrumb]');
  const guide = document.querySelector('[data-scene-guide]');

  // Panel scroll: the height actually on screen, not the CSS box.
  const scrollRect = rectOf(scroll);
  const scrollClip = clip(scrollRect);
  const scrollVisibleHeight = scrollClip ? Math.max(0, scrollClip.bottom - scrollClip.top) : 0;

  // Last control after scrolling to the bottom: reachable means fully on screen
  // and inside the scroll viewport.
  let lastControl = null;
  if (scroll) {
    scroll.scrollTop = scroll.scrollHeight;
    const controls = [...scroll.querySelectorAll('input, select, button')]
      .filter((element) => element.getClientRects().length > 0);
    const last = controls.at(-1);
    if (last) {
      const r = rectOf(last);
      lastControl = {
        tag: last.tagName.toLowerCase(),
        key: last.dataset.key || last.dataset.vkey || last.dataset.group || last.className,
        rect: r,
        inViewport: inViewport(r),
        insideScroll: !!scrollClip && r.top >= scrollClip.top - 1 && r.bottom <= scrollClip.bottom + 1,
        scrollTop: scroll.scrollTop,
        scrollHeight: scroll.scrollHeight,
        clientHeight: scroll.clientHeight,
      };
    }
  }

  // Scene visibility. §4's editing metric is about the make panel: that is the
  // surface whose detent cap decides how much of the subject stays visible
  // (the audit measured exactly this). Total chrome coverage is also reported
  // so a creeping shell shows up as evidence.
  const chromeRects = [...document.querySelectorAll(selector)]
    .filter((element) => {
      const style = getComputedStyle(element);
      if (style.visibility === 'hidden' || Number(style.opacity) <= 0.02) return false;
      // A retired surface is parked outside the frame on purpose — that is the
      // slide-in idle state, not chrome competing for the scene. Only presented
      // chrome is measured (a panel that is open reports aria-hidden="false").
      return element.getAttribute('aria-hidden') !== 'true' && element.inert !== true;
    })
    .map((element) => ({ selector: element.dataset.makePanel != null ? 'panel' : element.className, ...rectOf(element) }));
  const samples = 48;
  const covered = (rects, x, y) => rects.some((r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom);
  const panelRects = panel ? [rectOf(panel)] : [];
  let clear = 0;
  let clearOfPanel = 0;
  for (let iy = 0; iy < samples; iy++) {
    for (let ix = 0; ix < samples; ix++) {
      const x = ((ix + 0.5) / samples) * viewport.w;
      const y = ((iy + 0.5) / samples) * viewport.h;
      if (!covered(chromeRects, x, y)) clear++;
      if (!covered(panelRects, x, y)) clearOfPanel++;
    }
  }

  const targets = [...document.querySelectorAll([
    '.actions button',
    '[data-make-panel] .axistab',
    '[data-make-panel] .navcontrols select',
    '[data-make-panel] .navaction',
    '[data-make-panel] .grip',
    '[data-make-panel] .rebuild',
    '[data-make-panel] .hbtn',
    '.dial .render-style button',
    '.dial .dial-btn',
    '[data-view-chip]',
    '[data-view-collapse]',
    '[data-breadcrumb] .crumb.root.link',
  ].join(', '))]
    .filter((element) => element.getClientRects().length > 0 && !element.closest('[inert]'))
    .map((element) => {
      const r = element.getBoundingClientRect();
      return { key: element.className, w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 };
    });

  // The engine's own verdict on whether product chrome left a band to frame the
  // subject in (#124). A shell that reports "usable: false", or whose band lies
  // behind the make panel, cannot show the house being edited however generous
  // the panel-only coverage number looks.
  const shift = window.__viewshift || null;
  const safeRect = shift?.safeRect || null;
  const panelBox = rectOf(panel);
  const safeArea = safeRect ? Math.max(0, safeRect.width) * Math.max(0, safeRect.height) : 0;
  const band = {
    present: !!safeRect,
    usable: safeRect?.usable === true,
    rect: safeRect ? {
      left: Math.round(safeRect.left), top: Math.round(safeRect.top),
      width: Math.round(safeRect.width), height: Math.round(safeRect.height),
    } : null,
    behindPanelFraction: safeArea > 0 && panelBox
      ? overlapArea({
        left: safeRect.left, top: safeRect.top,
        right: safeRect.left + safeRect.width, bottom: safeRect.top + safeRect.height,
      }, panelBox) / safeArea
      : 0,
  };

  return {
    viewport,
    band,
    sheetSnap: panel?.dataset.snap || null,
    panelPresent: !!panel,
    panelRect: rectOf(panel),
    panelInViewport: inViewport(rectOf(panel)),
    scrollVisibleHeight,
    lastControl,
    sceneRatio: clear / (samples * samples),
    panelSceneRatio: clearOfPanel / (samples * samples),
    chromeRects,
    chromeInViewport: chromeRects.every((r) => inViewport(r)),
    // Named boxes so a geometry failure names the offender instead of only its area.
    boxes: {
      guide: rectOf(guide), dock: rectOf(dock), panel: rectOf(panel),
      dial: rectOf(dial), crumbs: rectOf(crumbs),
    },
    chromeOutside: chromeRects.filter((r) => !inViewport(r))
      .map((r) => [r.selector, Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)]),
    overlaps: {
      guideDock: overlapArea(rectOf(guide), rectOf(dock)),
      guidePanel: overlapArea(rectOf(guide), rectOf(panel)),
      guideDial: overlapArea(rectOf(guide), rectOf(dial)),
      crumbsPanel: overlapArea(rectOf(crumbs), rectOf(panel)),
      crumbsDial: overlapArea(rectOf(crumbs), rectOf(dial)),
      dockPanel: overlapArea(rectOf(dock), rectOf(panel)),
      // The dock lifts over the sheet while editing; if it also lands on the view
      // card it eats that card's action chips (found by pixel review, not by the
      // original box list, which only compared the dock against the panel).
      dockDial: overlapArea(rectOf(dock), rectOf(dial)),
    },
    hits: {
      share: hittable(document.querySelector('.actions [data-action="share"]')),
      postcard: hittable(document.querySelector('.actions [data-action="postcard"]')),
      exportModel: hittable(document.querySelector('.actions [data-action="export"]')),
      crumbRoot: hittable(document.querySelector('[data-breadcrumb] .crumb.root.link')),
      tabVillage: hittable(document.querySelector('#make-tab-village')),
      tabHouse: hittable(document.querySelector('#make-tab-house')),
      rebuild: hittable(document.querySelector('[data-make-panel] .foot.village .rebuild')),
      rerollHouse: hittable(document.querySelector('[data-make-panel] .foot.house .hbtn.reroll')),
      renderInk: hittable(document.querySelector('.dial .render-style button:last-child')),
      // §6.13 decision A: on the portrait sheet layout the view axis collapses to a
      // 44px chip while editing so the camera keeps a band for the edited house.
      viewChip: hittable(document.querySelector('[data-view-chip]')),
      grip: hittable(document.querySelector('[data-make-panel] .grip')),
    },
    guidePresent: !!guide,
    targets,
    smallTargets: targets.filter((target) => target.w < ${MIN_TARGET} - 0.5 || target.h < ${MIN_TARGET} - 0.5),
    // One group open at a time (P11), counted per context: both morph subtrees
    // stay mounted for the crossfade, so each owner is measured on its own.
    openGroups: {
      village: document.querySelectorAll('[data-make-panel] .ctx.village [data-group-body]').length,
      house: document.querySelectorAll('[data-make-panel] .ctx.house [data-group-body]').length,
    },
    groupHeaders: {
      village: document.querySelectorAll('[data-make-panel] .ctx.village [data-group]').length,
      house: document.querySelectorAll('[data-make-panel] .ctx.house [data-group]').length,
    },
    costBadges: [...document.querySelectorAll('[data-make-panel] .costbadge')]
      .map((badge) => badge.dataset.cost),
  };
}`;

const measure = async (page) => {
  const result = await page.evaluate(new Function(`return ${MEASURE}`)(), CHROME_SELECTOR);
  // The reachability probe scrolls the panel to its last row. Leaving it there made
  // every capture show the panel parked mid-list with its first row sliced under the
  // sticky tabs, which reads as a product defect it is not — restore the top.
  await page.evaluate(() => {
    const scroll = document.querySelector('[data-panel-scroll]');
    if (scroll) scroll.scrollTop = 0;
  });
  return result;
};

async function settleVillage(page) {
  await page.waitForFunction(() => window.__SHOT_READY === true && !!window.__engine, null, { timeout });
  await page.waitForFunction(() => !!window.__engine.village.getState().active, null, { timeout });
  await page.evaluate(() => {
    const engine = window.__engine;
    if (engine.debugDof().tweenProgress != null) engine.debugDofSeek(1, { finish: true });
  });
  await page.waitForFunction(() => !window.__engine.village.getState().transitioning, null, { timeout });
}

async function focusParcel(page) {
  const parcelId = await page.evaluate(() => {
    const parcels = window.__engine.village.debugParcels();
    return (parcels.find((parcel) => parcel.editable && !parcel.hero) || parcels[0])?.parcelId || null;
  });
  if (!parcelId) throw new Error('no parcel to focus');
  // Drive the real product transition, then finish its camera tween the same way
  // the app smoke harness does (seek only once the tween exists).
  await page.evaluate((id) => window.__engine.village.debugFocus(id), parcelId);
  await page.waitForFunction((id) => {
    const engine = window.__engine;
    const state = engine.village.getState();
    return state.selected === id
      && (!state.transitioning || engine.debugDof().tweenProgress != null);
  }, parcelId, { timeout });
  await page.evaluate(() => {
    const engine = window.__engine;
    if (engine.debugDof().tweenProgress != null) engine.debugDofSeek(1, { finish: true });
  });
  await page.waitForFunction((id) => {
    const state = window.__engine.village.getState();
    return state.selected === id && !state.transitioning;
  }, parcelId, { timeout });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  return parcelId;
}

// The shell slides and grows on a 0.42–0.45s CSS transition. A geometry read taken
// mid-slide catches the panel half off-frame, so wait until its box holds still.
async function settleShell(page) {
  await page.waitForFunction(() => {
    const element = document.querySelector('[data-make-panel]');
    if (!element) return true;
    const r = element.getBoundingClientRect();
    const previous = window.__uiShellBox;
    const same = previous && Math.abs(previous.left - r.left) < 0.5
      && Math.abs(previous.top - r.top) < 0.5 && Math.abs(previous.height - r.height) < 0.5;
    window.__uiShellBox = { left: r.left, top: r.top, height: r.height };
    window.__uiShellStill = same ? (window.__uiShellStill || 0) + 1 : 0;
    return window.__uiShellStill >= 6;
  }, null, { timeout, polling: 'raf' });
  await page.evaluate(() => { window.__uiShellStill = 0; window.__uiShellBox = null; });
}

try {
  await server.listen();
  const port = server.httpServer.address().port;
  const base = `http://127.0.0.1:${port}/?village=1&worker=0&seed=42&vseed=20260716&time=sunset&lang=ko`;
  browser = await launchVerificationBrowser();

  for (const viewport of VIEWPORTS) {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      hasTouch: viewport.touch,
      isMobile: viewport.touch,
      deviceScaleFactor: 1,
    });
    const page = await preparePage(context);
    await page.goto(base, { waitUntil: 'domcontentloaded', timeout });
    await settleVillage(page);
    await pinChroma(page);
    if (viewport.id === 'desktop-1280') await reportWebGLRenderer(page, 'ui-shell');
    await page.waitForFunction(
      (expected) => window.__device?.touch === expected,
      viewport.touch,
      { timeout },
    ).catch(() => {});

    // ── 부감(aerial) ──
    // Only the portrait sheet layout has detents; the landscape phone and desktop
    // use the left overlay/card shell. The tab reachability contract differs.
    const sheetLayout = await page.evaluate(() => window.__device?.sheet === true);
    await settleShell(page);
    const aerial = await measure(page);
    await page.screenshot({ path: join(shotDir, `${viewport.id}-aerial.png`) });
    pass(aerial.chromeInViewport,
      `${viewport.id} aerial keeps every chrome box inside the frame (${JSON.stringify(aerial.chromeRects.map((r) => [r.selector, Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)]))})`);
    pass(aerial.hits.share === 'hittable' && aerial.hits.postcard === 'hittable',
      `${viewport.id} aerial share dock is hittable (${JSON.stringify(aerial.hits)})`);
    // The collapsed sheet deliberately shows only its grip, so the tabs live one
    // documented tap away there; every other shell must expose them directly.
    if (sheetLayout) {
      pass(aerial.hits.grip === 'hittable',
        `${viewport.id} the collapsed sheet offers its grip as the single way in (${aerial.hits.grip})`);
      const revealed = await page.evaluate(async () => {
        document.querySelector('[data-make-panel] .grip')?.click();
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        return document.querySelector('[data-make-panel]')?.dataset.snap || null;
      });
      await settleShell(page);
      const expanded = await measure(page);
      pass(revealed === 'half' && expanded.hits.tabVillage === 'hittable' && expanded.hits.tabHouse === 'hittable',
        `${viewport.id} one grip tap reveals both make tabs (${revealed}: ${expanded.hits.tabVillage} / ${expanded.hits.tabHouse})`);
      await page.evaluate(async () => {
        document.querySelector('[data-make-panel] .grip')?.click();
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      });
      await settleShell(page);
    } else {
      pass(aerial.hits.tabVillage === 'hittable' && aerial.hits.tabHouse === 'hittable',
        `${viewport.id} aerial make tabs are hittable (${aerial.hits.tabVillage} / ${aerial.hits.tabHouse})`);
    }
    pass(aerial.overlaps.crumbsDial === 0 && aerial.overlaps.crumbsPanel === 0,
      `${viewport.id} breadcrumb owns the top-left slot alone (${JSON.stringify(aerial.overlaps)})`);
    pass(aerial.overlaps.dockPanel === 0,
      `${viewport.id} share dock never overlaps the make panel (${aerial.overlaps.dockPanel})`);
    pass(!aerial.guidePresent
      || (aerial.overlaps.guideDock === 0 && aerial.overlaps.guidePanel === 0 && aerial.overlaps.guideDial === 0),
    `${viewport.id} onboarding guide is clamped clear of every action (${JSON.stringify(aerial.overlaps)} guide=${JSON.stringify(aerial.boxes.guide)} dock=${JSON.stringify(aerial.boxes.dock)})`);
    pass(aerial.openGroups.village <= 1 && aerial.groupHeaders.village >= 3,
      `${viewport.id} village groups expose every axis with one body open (${aerial.openGroups.village}/${aerial.groupHeaders.village})`);
    pass(aerial.costBadges.length >= 3 && aerial.costBadges.every((cost) => ['wave', 'live', 'settle'].includes(cost)),
      `${viewport.id} every village group states its commit cost (${JSON.stringify(aerial.costBadges)})`);
    if (sheetLayout) {
      pass(aerial.sheetSnap === 'peek',
        `${viewport.id} aerial keeps the make sheet collapsed (${aerial.sheetSnap})`);
    } else {
      pass(aerial.sheetSnap == null,
        `${viewport.id} uses the side panel shell instead of a sheet (${aerial.sheetSnap})`);
    }
    if (viewport.touch) {
      pass(aerial.smallTargets.length === 0,
        `${viewport.id} aerial keeps 44px targets (${JSON.stringify(aerial.smallTargets)})`);
    }

    // ── 집 focus 편집 ──
    await focusParcel(page);
    // P3: focus-in must open the panel by itself on the sheet layout.
    if (sheetLayout) {
      const snap = await page.evaluate(() => document.querySelector('[data-make-panel]')?.dataset.snap || null);
      pass(snap === 'half',
        `${viewport.id} focus-in expands the make sheet without a user gesture (${snap})`);
    }
    await settleShell(page);
    const focused = await measure(page);
    await page.screenshot({ path: join(shotDir, `${viewport.id}-focus-edit.png`) });
    pass(focused.scrollVisibleHeight >= MIN_SCROLL_HEIGHT,
      `${viewport.id} focus panel keeps ${MIN_SCROLL_HEIGHT}px of visible scroll (${Math.round(focused.scrollVisibleHeight)}px)`);
    pass(!!focused.lastControl && focused.lastControl.inViewport && focused.lastControl.insideScroll,
      `${viewport.id} the last control of a scrolled panel stays reachable (${JSON.stringify(focused.lastControl)})`);
    pass(focused.panelSceneRatio >= MIN_SCENE_RATIO,
      `${viewport.id} editing keeps ${Math.round(MIN_SCENE_RATIO * 100)}% of the frame clear of the make panel (${(focused.panelSceneRatio * 100).toFixed(1)}%, all chrome ${(focused.sceneRatio * 100).toFixed(1)}%)`);
    // §4's scene-visibility metric was measured against the make panel alone, which
    // is why a phone frame that is ~80% chrome could still pass it. The metric that
    // actually decides whether the edited house is on screen is the framing band the
    // chrome leaves behind, so assert that directly.
    pass(focused.band.present && focused.band.usable && focused.band.behindPanelFraction <= 0.02,
      `${viewport.id} editing leaves a usable framing band outside the make panel (${JSON.stringify(focused.band)})`);
    // Total chrome coverage is a creep guard, not a target. The phone shells are
    // genuinely chrome-dense (sheet + view card + dock), so their floor is the
    // measured bound; the desktop shells must keep the full §4 ratio.
    const chromeFloor = sheetLayout || viewport.id === 'phone-landscape' ? 0.20 : MIN_SCENE_RATIO;
    pass(focused.sceneRatio >= chromeFloor,
      `${viewport.id} editing keeps ${Math.round(chromeFloor * 100)}% of the frame clear of all chrome (${(focused.sceneRatio * 100).toFixed(1)}%)`);
    pass(focused.overlaps.dockDial === 0,
      `${viewport.id} the lifted share dock never covers the view card (${focused.overlaps.dockDial})`);
    pass(focused.hits.crumbRoot === 'hittable',
      `${viewport.id} focus-out breadcrumb is hittable (${focused.hits.crumbRoot})`);
    pass(focused.hits.rerollHouse === 'hittable' && focused.hits.share === 'hittable'
      && focused.hits.exportModel === 'hittable',
    `${viewport.id} focus keeps rebuild, share, and model export reachable (${JSON.stringify(focused.hits)})`);
    // §6.13 decision A. The portrait sheet layout cannot host the sheet, the full view
    // card and the lifted dock and still leave the camera a band for the edited house,
    // so the view axis collapses to a chip there. Its cost is one tap, and that tap must
    // not disturb the edit context — assert both, or the decision quietly reverts.
    if (sheetLayout) {
      pass(focused.hits.viewChip === 'hittable',
        `${viewport.id} the view axis collapses to a reachable chip while editing (${focused.hits.viewChip})`);
      const chipState = await page.evaluate(() => document.querySelector('[data-view-chip]')?.textContent?.replace(/\s+/g, ' ').trim() || '');
      pass(chipState.length > 0,
        `${viewport.id} the collapsed view chip still states the current environment ("${chipState}")`);
      const expand = await page.evaluate(async () => {
        const snapBefore = document.querySelector('[data-make-panel]')?.dataset.snap || null;
        document.querySelector('[data-view-chip]')?.click();
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        return { snapBefore, snapAfter: document.querySelector('[data-make-panel]')?.dataset.snap || null };
      });
      await settleShell(page);
      const expanded = await measure(page);
      pass(expand.snapBefore === 'half' && expand.snapAfter === 'half'
        && expanded.hits.renderInk === 'hittable',
      `${viewport.id} expanding the view chip reveals the axis without collapsing the edit sheet (${JSON.stringify({ ...expand, renderInk: expanded.hits.renderInk })})`);
      // Return to the collapsed state so the later ink/fade steps see the authored shell.
      await page.evaluate(async () => {
        document.querySelector('[data-view-collapse]')?.click();
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      });
      await settleShell(page);
    } else {
      pass(focused.hits.renderInk === 'hittable',
        `${viewport.id} the view card stays reachable while editing (${focused.hits.renderInk})`);
    }
    pass(focused.openGroups.house <= 1 && focused.groupHeaders.house >= 3,
      `${viewport.id} house groups keep one body open while exposing every axis (${focused.openGroups.house}/${focused.groupHeaders.house})`);
    pass(focused.chromeInViewport,
      `${viewport.id} editing chrome stays inside the frame`);
    if (viewport.touch) {
      pass(focused.smallTargets.length === 0,
        `${viewport.id} editing keeps 44px targets (${JSON.stringify(focused.smallTargets)})`);
    }

    // 그룹 아코디언: 다른 그룹을 펼치면 앞 그룹이 접힌다(스크롤 초과 구조적 제거).
    // Svelte updates the DOM asynchronously, so read the collapse one frame later.
    const accordionTarget = await page.evaluate(() => {
      const headers = [...document.querySelectorAll('[data-make-panel] .ctx.house [data-group]')];
      if (headers.length < 2) return null;
      const before = [...document.querySelectorAll('[data-make-panel] .ctx.house [data-group-body]')]
        .map((body) => body.dataset.groupBody);
      const target = headers.find((header) => header.getAttribute('aria-expanded') === 'false');
      target?.click();
      return { before, opened: target?.dataset.group || null };
    });
    let accordion = null;
    if (accordionTarget) {
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      const after = await page.evaluate(() => [...document.querySelectorAll('[data-make-panel] .ctx.house [data-group-body]')]
        .map((body) => body.dataset.groupBody));
      accordion = { ...accordionTarget, after };
    }
    pass(!accordion || (accordion.after.length === 1 && accordion.after[0] === accordion.opened),
      `${viewport.id} opening a group collapses the previous one (${JSON.stringify(accordion)})`);

    // 시네마틱: 크롬은 전부 물러난다(감상 우선).
    await page.evaluate(() => window.__engine.village.return());
    await page.evaluate(() => {
      const engine = window.__engine;
      if (engine.debugDof().tweenProgress != null) engine.debugDofSeek(1, { finish: true });
    });
    await page.waitForFunction(() => !window.__engine.village.getState().transitioning, null, { timeout });
    const cinematicStarted = await page.evaluate(() => window.__engine.cine.start('drone'));
    if (cinematicStarted) {
      await page.waitForFunction(() => window.__engine.cine.getState().active, null, { timeout });
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      const cinematic = await page.evaluate(() => {
        const panel = document.querySelector('[data-make-panel]');
        const chroma = document.querySelector('.chroma');
        return {
          panelInert: panel ? panel.inert === true : null,
          panelHidden: panel?.getAttribute('aria-hidden'),
          faded: chroma?.classList.contains('faded') === true,
          exitPresent: !!document.querySelector('.cine-overlay button, [data-cine-exit]'),
        };
      });
      await page.screenshot({ path: join(shotDir, `${viewport.id}-cinematic.png`) });
      pass(cinematic.faded && cinematic.panelInert && cinematic.exitPresent,
        `${viewport.id} cinematic retires the chrome and keeps one exit (${JSON.stringify(cinematic)})`);
      await page.evaluate(() => window.__engine.cine.stop());
      await page.waitForFunction(() => !window.__engine.cine.getState().active, null, { timeout });
    }

    // 수묵(墨): 렌더 스타일 전환은 보기 카드가 소유하고, 크롬 배치는 불변이어야 한다.
    // 시네마틱에서 돌아온 패널이 다시 미끄러져 들어오는 동안 재면 반쪽 프레임을 읽는다.
    await settleShell(page);
    await page.evaluate(() => document.querySelector('.dial .render-style button:last-child')?.click());
    await page.waitForFunction(() => window.__engine.getState().renderStyle === 'ink', null, { timeout });
    await page.evaluate(() => window.__engine.setRenderStyle('ink', { immediate: true }));
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const inkShell = await measure(page);
    await page.screenshot({ path: join(shotDir, `${viewport.id}-ink.png`) });
    pass(inkShell.chromeInViewport && inkShell.hits.share === 'hittable',
      `${viewport.id} ink mode keeps the same reachable shell (share=${inkShell.hits.share} outside=${JSON.stringify(inkShell.chromeOutside)})`);
    await page.evaluate(() => window.__engine.setRenderStyle('pbr', { immediate: true }));

    // 감상 페이드: 크롬 전체가 한 그룹이라 페이드 뒤에는 씬만 남는다(P6).
    await page.evaluate(() => {
      for (const style of [...document.querySelectorAll('style')]) {
        if (style.textContent.includes('.chroma { opacity: 1')) style.remove();
      }
    });
    const fadeState = await page.evaluate(() => new Promise((resolve) => {
      setTimeout(() => {
        const chroma = document.querySelector('.chroma');
        const outside = [...document.querySelectorAll('[data-make-panel], .actions, .dial, [data-breadcrumb], .seal-label')]
          .filter((element) => !element.closest('.chroma'))
          .map((element) => element.className);
        resolve({
          faded: chroma?.classList.contains('faded') === true,
          opacity: chroma ? Number(getComputedStyle(chroma).opacity) : null,
          outside,
        });
      }, 3400);
    }));
    pass(fadeState.faded && fadeState.outside.length === 0,
      `${viewport.id} appreciation fade leaves the scene alone (${JSON.stringify(fadeState)})`);

    await page.close();
    await context.close();
  }

  // ?shot=1 골든 경로: 크롬은 DOM 오버레이일 뿐이므로 canvas 픽셀에 개입하지 않는다. 골든 계약이
  //   기대는 실제 레버(뷰 시프트 오프셋 0 · 결정론 시간대 · 흐름 비활성)가 유지되는지 확인한다.
  const shotContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const shotPage = await preparePage(shotContext);
  await shotPage.goto(`http://127.0.0.1:${port}/?shot=1&village=1&worker=0&seed=42&vseed=20260716`, {
    waitUntil: 'domcontentloaded', timeout,
  });
  await settleVillage(shotPage);
  const shotContract = await shotPage.evaluate((selector) => ({
    chrome: [...document.querySelectorAll(selector)].map((element) => element.className),
    canvasChildren: document.querySelector('canvas')?.childElementCount ?? -1,
    chromeInsideCanvas: [...document.querySelectorAll(selector)]
      .filter((element) => element.closest('canvas')).length,
    viewShift: { enabled: window.__viewshift?.enabled, x: window.__viewshift?.x, y: window.__viewshift?.y },
    time: window.__engine.getState().time,
    flowing: window.__envflow?.flowing,
  }), CHROME_SELECTOR);
  // shot keeps the seed-derived environment (no flagship sunset override), disables
  // the view-shift offset and the flow clock, and never puts chrome inside the
  // canvas element - which is what keeps golden canvas captures pixel-identical.
  pass(shotContract.viewShift.enabled === false
      && shotContract.viewShift.x === 0
      && shotContract.viewShift.y === 0
      && shotContract.flowing === false
      && shotContract.canvasChildren === 0
      && shotContract.chromeInsideCanvas === 0,
  `?shot=1 keeps the deterministic golden levers and never draws chrome into the canvas (${JSON.stringify(shotContract)})`);
  await shotPage.close();
  await shotContext.close();

  pass(runtimeErrors.length === 0, `browser reports no runtime errors (${runtimeErrors.length})`);
  if (runtimeErrors.length) console.log(runtimeErrors.slice(0, 5).join('\n'));
} catch (error) {
  failures.push(error.message);
  console.error(error.stack || error);
  if (runtimeErrors.length) console.error(runtimeErrors.slice(0, 10).join('\n'));
} finally {
  await browser?.close();
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
}

console.log(failures.length ? `\nUI SHELL: ${failures.length} FAIL` : '\nUI SHELL: PASS');
process.exit(failures.length ? 1 : 0);
