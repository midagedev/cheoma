// Product-path performance probe (post ON): capital aerial orbit + focus rebuild.
// Reports structure costs and adaptive fill/bloom budgets — not absolute GPU ms
// (headless ANGLE wall-clock is not evidence; use Chrome GPU for feel checks).
//
// Usage: node tools/run-browser-locked.mjs -- node tools/bench-product-path.mjs
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from '../app/node_modules/vite/dist/node/index.js';
import { launchVerificationBrowser, reportWebGLRenderer } from './lib/verification-browser.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const APP_ROOT = join(ROOT, 'app');
const cacheDir = await mkdtemp(join(tmpdir(), 'cheoma-product-path-cache-'));
const timeout = Number(process.env.CHEOMA_PRODUCT_PATH_TIMEOUT_MS) || 120_000;

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
  const url = `http://127.0.0.1:${port}/?hero=0&village=1&worker=0&vscale=capital&vseed=7&time=sunset&lang=ko`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
  await page.waitForFunction(() => window.__SHOT_READY === true && !!window.__engine, null, { timeout });
  await page.waitForFunction(() => !!window.__engine.village.debugPlan(), null, { timeout });
  await reportWebGLRenderer(page, 'product-path');

  // Wait until adaptive post quality is fully settled (OrbitControls damping / reveal).
  await page.waitForFunction(() => {
    const q = window.__engine.debugDof?.();
    return q?.postQualityMode === 'stable' && (window.__engine.debugPostResolution().fillScale ?? 1) === 1;
  }, null, { timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(200);
  const aerial = await page.evaluate(async () => {
    const engine = window.__engine;
    const samples = [];
    for (let i = 0; i < 45; i++) {
      const t0 = performance.now();
      await new Promise((r) => requestAnimationFrame(r));
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    const res = engine.debugPostResolution();
    const q = engine.debugDof?.() || {};
    return {
      regime: 'aerial-settle',
      frameMed: samples[Math.floor(samples.length / 2)],
      frameP90: samples[Math.floor(samples.length * 0.9)],
      programs: res.programs,
      textures: res.textures,
      geometries: res.geometries,
      fillScale: res.fillScale,
      bloomHalf: res.bloomHalf,
      msaaSamples: res.msaaSamples,
      composer: res.composer,
      bloom: res.bloom,
      postQualityMode: q.postQualityMode ?? null,
    };
  });

  // Synthetic orbit (pointer drag on canvas) — should drop fillScale while moving.
  const canvas = page.locator('canvas').first();
  const box = await canvas.boundingBox();
  const orbit = await page.evaluate(async ({ cx, cy }) => {
    const engine = window.__engine;
    const el = engine.renderer.domElement;
    const dispatch = (type, x, y) => {
      el.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, buttons: type === 'pointerup' ? 0 : 1,
      }));
    };
    dispatch('pointerdown', cx, cy);
    const modes = [];
    for (let i = 0; i < 24; i++) {
      dispatch('pointermove', cx + i * 12, cy + Math.sin(i) * 8);
      await new Promise((r) => requestAnimationFrame(r));
      const q = engine.debugDof?.() || {};
      modes.push({
        mode: q.postQualityMode,
        fill: engine.debugPostResolution().fillScale,
      });
    }
    dispatch('pointerup', cx + 280, cy);
    // OrbitControls damping keeps motion for hundreds of ms — wait for stable fill.
    const tDeadline = performance.now() + 4000;
    while (performance.now() < tDeadline) {
      await new Promise((r) => requestAnimationFrame(r));
      const q = engine.debugDof?.() || {};
      if (q.postQualityMode === 'stable' && engine.debugPostResolution().fillScale === 1) break;
    }
    const settled = engine.debugPostResolution();
    const q = engine.debugDof?.() || {};
    return {
      regime: 'aerial-orbit',
      samples: modes,
      movedFill: modes.some((s) => s.fill < 1),
      settledFill: settled.fillScale,
      settledMode: q.postQualityMode,
      bloomHalf: settled.bloomHalf,
    };
  }, { cx: box.x + box.width * 0.5, cy: box.y + box.height * 0.45 });

  // Focus a regular house and measure rebuild cost for openings slider.
  const focusId = await page.evaluate(() => {
    const engine = window.__engine;
    const plan = engine.village.exportRoot().userData.plan;
    const editable = engine.village.debugParcels()
      .filter((p) => p.editable && !p.hero && p.parcelId !== 'palace' && p.parcelId !== 'temple');
    const id = editable[0]?.parcelId || plan.parcels.find((p) => !p.hero)?.id;
    engine.village.debugFocus(id);
    return id;
  });
  await page.waitForFunction((id) => {
    const s = window.__engine.village.getState();
    return s.selected === id && !s.transitioning;
  }, focusId, { timeout });
  await page.waitForTimeout(300);
  // After focus camera settles, fill should return to 1 and bloom to full.
  await page.waitForFunction(() => {
    const q = window.__engine.debugDof?.();
    const res = window.__engine.debugPostResolution();
    return q?.postQualityMode === 'stable' && res.fillScale === 1 && res.bloomHalf === false;
  }, null, { timeout: 15_000 }).catch(() => {});

  const focus = await page.evaluate(async (parcelId) => {
    const engine = window.__engine;
    const res = engine.debugPostResolution();
    const costs = [];
    const pitchCosts = [];
    const base = engine.village.debugParcelRebuild(parcelId);
    for (let i = 0; i < 12; i++) {
      const doorWidthK = 0.35 + (i % 6) * 0.02;
      const t0 = performance.now();
      engine.village.rebuild(parcelId, {
        building: { doorWidthK },
      }, { refreshFlora: false, warm: false });
      costs.push(performance.now() - t0);
      await new Promise((r) => requestAnimationFrame(r));
    }
    // Roof-shell path (pitch): should stay house-only without full group rebuild.
    const basePitch = base.params.roofPitch ?? base.params.riseScale ?? 0.55;
    for (let i = 0; i < 10; i++) {
      const roofPitch = basePitch + ((i % 5) - 2) * 0.02;
      const t0 = performance.now();
      engine.village.rebuild(parcelId, {
        building: { roofPitch },
      }, { refreshFlora: false, warm: false });
      pitchCosts.push(performance.now() - t0);
      await new Promise((r) => requestAnimationFrame(r));
    }
    // Final commit warm path
    const tCommit = performance.now();
    engine.village.rebuild(parcelId, {
      building: {
        doorWidthK: base.params.doorWidthK,
        roofPitch: basePitch,
      },
    }, { refreshFlora: true, warm: true });
    const commitMs = performance.now() - tCommit;
    costs.sort((a, b) => a - b);
    pitchCosts.sort((a, b) => a - b);
    return {
      regime: 'focus-rebuild',
      parcelId,
      previewMed: costs[Math.floor(costs.length / 2)],
      previewP90: costs[Math.floor(costs.length * 0.9)],
      pitchPreviewMed: pitchCosts[Math.floor(pitchCosts.length / 2)],
      pitchPreviewP90: pitchCosts[Math.floor(pitchCosts.length * 0.9)],
      commitMs,
      bloomHalf: res.bloomHalf,
      fillScale: res.fillScale,
      msaaSamples: res.msaaSamples,
      programs: res.programs,
      bloom: res.bloom,
      composer: res.composer,
    };
  }, focusId);

  // Structural assertions for focus budget (MSAA + bloom).
  if (focus.msaaSamples != null && focus.msaaSamples < 4 && !focus.bloomHalf) {
    console.warn('[product-path] focus expected desktop MSAA 4, got', focus.msaaSamples);
  }

  const row = (label, obj) => {
    console.log(`\n=== ${label} ===`);
    for (const [k, v] of Object.entries(obj)) {
      if (k === 'samples') continue;
      const val = typeof v === 'number' ? (Number.isInteger(v) ? v : +v.toFixed(2)) : JSON.stringify(v);
      console.log(`  ${k}: ${val}`);
    }
  };
  row('aerial settle (post on)', aerial);
  row('aerial orbit', {
    movedFill: orbit.movedFill,
    settledFill: orbit.settledFill,
    settledMode: orbit.settledMode,
    bloomHalf: orbit.bloomHalf,
    modeTrace: orbit.samples.map((s) => s.mode).join('→'),
  });
  row('focus openings rebuild', focus);

  const ok = aerial.bloomHalf === true
    && orbit.movedFill === true
    && orbit.settledFill === 1
    && focus.bloomHalf === false
    && focus.previewMed < 80;
  console.log(`\nPRODUCT PATH BENCH: ${ok ? 'PASS' : 'WARN'} (structural budgets; frame ms headless-only)`);
  if (!ok) process.exitCode = 1;
} finally {
  await browser?.close();
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
}
