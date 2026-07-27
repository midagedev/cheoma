// Capture harness for look-audit gaps C1–C2 (GitHub #226).
//
// Reuses the check-parcel-rebuild-browser fixture boot (vseed=7 residential
// yard-tree owner near the pavilion) and records:
//   C1 — live eave-depth slider mid-drag sequence (fixed ~300ms steps)
//   C2 — house rebuild/reroll before/after pair
//
// Default PNG + MANIFEST go to an OS temp directory so shots/ stays uncommitted.
// Override with CHEOMA_EDIT_EXPERIENCE_OUT=/absolute/path (may point at shots/
// only when the operator wants a tracked review workspace — never commit the
// PNGs). Not a quality gate: program/draw budgets and live-edit contracts stay
// on check:live-edit / check:parcel-rebuild:browser.
//
//   npm run shoot:edit-experience
//   CHEOMA_EDIT_EXPERIENCE_OUT=/tmp/edit-exp npm run shoot:edit-experience
//   CHEOMA_EDIT_EXPERIENCE_FRAMES=5 CHEOMA_EDIT_EXPERIENCE_STEP_MS=300 npm run shoot:edit-experience
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from '../app/node_modules/vite/dist/node/index.js';
import { launchVerificationBrowser, reportWebGLRenderer } from './lib/verification-browser.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const APP_ROOT = join(ROOT, 'app');
const cacheDir = await mkdtemp(join(tmpdir(), 'cheoma-edit-exp-cache-'));
const outputDir = process.env.CHEOMA_EDIT_EXPERIENCE_OUT
  ? resolve(process.env.CHEOMA_EDIT_EXPERIENCE_OUT)
  : await mkdtemp(join(tmpdir(), 'cheoma-edit-exp-shots-'));
await mkdir(outputDir, { recursive: true });

const timeout = Number(process.env.CHEOMA_EDIT_EXPERIENCE_TIMEOUT_MS) || 120_000;
const liveFrames = Math.min(5, Math.max(3, Number(process.env.CHEOMA_EDIT_EXPERIENCE_FRAMES) || 4));
const stepMs = Math.max(120, Number(process.env.CHEOMA_EDIT_EXPERIENCE_STEP_MS) || 300);
const timeOfDay = process.env.CHEOMA_EDIT_EXPERIENCE_TIME || 'day';

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
const captures = [];
const notes = [];

try {
  await server.listen();
  const port = server.httpServer.address().port;
  browser = await launchVerificationBrowser();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(timeout);
  page.on('pageerror', (error) => runtimeErrors.push(`page: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' && !/favicon|404/i.test(message.text())) {
      runtimeErrors.push(`console: ${message.text()}`);
    }
  });

  // Same deterministic product path as check-parcel-rebuild-browser.mjs.
  const url = `http://127.0.0.1:${port}/?hero=0&village=1&worker=0&seed=42&vseed=7`
    + `&time=${timeOfDay}&lang=ko`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
  await page.waitForFunction(() => window.__SHOT_READY === true && !!window.__engine, null, { timeout });
  await page.waitForFunction(() => !!window.__engine.village.debugPlan(), null, { timeout });
  await reportWebGLRenderer(page, 'edit-experience');

  const fixture = await page.evaluate(() => {
    const engine = window.__engine;
    engine.setViewShiftEnabled?.(false);
    const root = engine.village.exportRoot();
    const plan = root.userData.plan;
    const editable = new Set(engine.village.debugParcels()
      .filter((parcel) => parcel.editable && !parcel.hero && parcel.parcelId !== 'palace')
      .map((parcel) => parcel.parcelId));
    const treeOwners = new Set((root.userData.yardTreeAnchors || []).map((tree) => tree.parcelId));
    const regular = plan.parcels.filter((parcel) => editable.has(parcel.id));
    const pool = regular.some((parcel) => treeOwners.has(parcel.id))
      ? regular.filter((parcel) => treeOwners.has(parcel.id))
      : regular;
    const pavilion = plan.features.pavilion;
    const parcel = pool.sort((a, b) => (
      Math.hypot(a.center.x - pavilion.x, a.center.z - pavilion.z)
      - Math.hypot(b.center.x - pavilion.x, b.center.z - pavilion.z)
    ))[0];
    return {
      parcelId: parcel?.id || null,
      hasTree: !!parcel && treeOwners.has(parcel.id),
      kind: parcel?.kind || null,
      villageSeed: engine.village.getState().seed,
      pavilion: pavilion ? { x: pavilion.x, z: pavilion.z, radius: pavilion.radius } : null,
    };
  });
  invariant(fixture.parcelId, 'no editable residential parcel was available');
  invariant(fixture.hasTree, 'browser fixture did not select a rendered yard-tree owner');
  notes.push(`fixture parcel=${fixture.parcelId} kind=${fixture.kind} villageSeed=${fixture.villageSeed}`);

  await page.evaluate((parcelId) => window.__engine.village.debugFocus(parcelId), fixture.parcelId);
  await page.waitForFunction((parcelId) => {
    const state = window.__engine.village.getState();
    return state.selected === parcelId && !state.transitioning;
  }, fixture.parcelId, { timeout });
  // Let focus settle (DoF/post/ambience) before the first review frame.
  await page.waitForTimeout(400);

  const openMakeGroup = async (groupId) => {
    await page.evaluate((group) => {
      const header = document.querySelector(`.ctx.house [data-group="${group}"]`);
      if (header && header.getAttribute('aria-expanded') === 'false') header.click();
    }, groupId);
    await page.waitForFunction(
      (group) => !!document.querySelector(`.ctx.house [data-group-body="${group}"]`),
      groupId,
      { timeout },
    );
  };

  async function shot(name, meta = {}) {
    const file = `${name}.png`;
    const path = join(outputDir, file);
    await page.screenshot({ path, animations: 'disabled' });
    const sample = await page.evaluate((parcelId) => {
      const engine = window.__engine;
      engine.village.debugDrawCalls?.();
      const state = engine.village.debugParcelRebuild(parcelId);
      const box = engine.village.debugOverlayBox?.(parcelId) || null;
      return {
        eave: state?.params?.eaveOverhang ?? null,
        kind: state?.kind ?? null,
        rebuildSeed: state?.rebuildSeed ?? null,
        persistent: !!state?.persistent,
        programs: engine.renderer.info.programs?.length || 0,
        drawCalls: engine.renderer.info.render.calls,
        box,
      };
    }, fixture.parcelId);
    captures.push({ file, ...meta, ...sample });
    console.log(`[edit-experience] saved ${file}`
      + (sample.eave != null ? ` eave=${sample.eave}` : '')
      + (sample.rebuildSeed != null ? ` rebuildSeed=${sample.rebuildSeed}` : '')
      + ` programs=${sample.programs} draws=${sample.drawCalls}`);
    return sample;
  }

  // ── rest focus (baseline for both C1 and C2) ──────────────────────────
  await openMakeGroup('roof');
  const rest = await shot('00-focus-rest', { phase: 'rest', gap: 'C1+C2' });

  // ── C1: live-edit mid-drag sequence (fixed-timing stepped inputs) ─────
  // input only (no change) until the last step so flora stays uncommitted mid-drag,
  // matching the product live-edit path exercised by check-parcel-rebuild-browser.
  const sliderInfo = await page.evaluate(() => {
    const slider = document.querySelector('.ctx.house:not([aria-hidden="true"]) input[data-key="eaveOverhang"]');
    if (!slider) return null;
    return {
      min: Number(slider.min),
      max: Number(slider.max),
      start: Number(slider.value),
      step: Number(slider.step) || 0.05,
    };
  });
  invariant(sliderInfo, 'focused regular parcel did not expose the eaveOverhang slider');

  // Prefer the range end that moves the silhouette farthest from the rest value.
  const towardMax = Math.abs(sliderInfo.max - sliderInfo.start);
  const towardMin = Math.abs(sliderInfo.start - sliderInfo.min);
  const endValue = towardMax >= towardMin ? sliderInfo.max : sliderInfo.min;
  const values = [];
  for (let i = 1; i <= liveFrames; i++) {
    const t = i / liveFrames;
    values.push(sliderInfo.start + (endValue - sliderInfo.start) * t);
  }

  const liveBoxes = [rest.box];
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    const isLast = i === values.length - 1;
    await page.evaluate(({ value, commit }) => {
      const slider = document.querySelector('.ctx.house:not([aria-hidden="true"]) input[data-key="eaveOverhang"]');
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setValue.call(slider, String(value));
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      if (commit) slider.dispatchEvent(new Event('change', { bubbles: true }));
    }, { value, commit: isLast });
    // Wait for the live-edit scheduler's latest-wins preview (and final flora commit).
    await page.waitForFunction(({ parcelId, value, commit }) => {
      const state = window.__engine.village.debugParcelRebuild(parcelId);
      if (!state || Math.abs((state.params?.eaveOverhang ?? NaN) - value) > 1e-4) return false;
      if (!commit) return true;
      return state.persistent === true;
    }, { parcelId: fixture.parcelId, value, commit: isLast }, { timeout });
    await page.waitForTimeout(stepMs);
    // Two rAFs so the beauty frame after a rebuild is present.
    await page.evaluate(() => new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    }));
    const sample = await shot(
      `01-live-eave-${String(i + 1).padStart(2, '0')}`,
      {
        gap: 'C1',
        phase: isLast ? 'live-commit' : 'live-mid',
        stepMs,
        value,
      },
    );
    liveBoxes.push(sample.box);
  }

  const liveMoved = liveBoxes.some((box, index) => {
    if (index === 0 || !box || !liveBoxes[0]) return false;
    return Math.abs(box.x - liveBoxes[0].x) > 0.08
      || Math.abs(box.z - liveBoxes[0].z) > 0.08
      || Math.abs(box.y - liveBoxes[0].y) > 0.08;
  });
  invariant(liveMoved, 'live-edit sequence did not visibly change the house footprint');

  // ── C2: rebuild / reroll before–after pair ────────────────────────────
  // Re-open focus context if the panel still has the roof group (it should).
  // Capture a dedicated before frame so C2 is self-contained for vision review.
  const beforeReroll = await page.evaluate((parcelId) => {
    const engine = window.__engine;
    const state = engine.village.debugParcelRebuild(parcelId);
    return {
      villageSeed: engine.village.getState().seed,
      rebuildSeed: state?.rebuildSeed ?? null,
      kind: state?.kind ?? null,
      plotW: state?.plotW ?? null,
      plotD: state?.plotD ?? null,
      eave: state?.params?.eaveOverhang ?? null,
    };
  }, fixture.parcelId);
  await shot('02-reroll-before', { gap: 'C2', phase: 'before', ...beforeReroll });

  const rerollButton = page.locator('.foot.house:not([aria-hidden="true"]) .hbtn.reroll');
  invariant(await rerollButton.count() > 0, 'house footer missing rebuild/reroll control');
  await rerollButton.click();
  await page.waitForFunction(() => window.__engine.village.getState().transitioning, null, { timeout });
  await page.waitForFunction((parcelId) => {
    const state = window.__engine.village.getState();
    return state.selected === parcelId && !state.transitioning;
  }, fixture.parcelId, { timeout });
  await page.waitForTimeout(500);
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));

  const afterReroll = await page.evaluate((parcelId) => {
    const engine = window.__engine;
    const state = engine.village.debugParcelRebuild(parcelId);
    return {
      villageSeed: engine.village.getState().seed,
      rebuildSeed: state?.rebuildSeed ?? null,
      kind: state?.kind ?? null,
      plotW: state?.plotW ?? null,
      plotD: state?.plotD ?? null,
      eave: state?.params?.eaveOverhang ?? null,
      persistent: !!state?.persistent,
      conflicts: state?.conflicts ?? null,
    };
  }, fixture.parcelId);
  await shot('02-reroll-after', { gap: 'C2', phase: 'after', ...afterReroll });

  invariant(afterReroll.villageSeed === beforeReroll.villageSeed,
    `rebuild changed the village seed (${beforeReroll.villageSeed} → ${afterReroll.villageSeed})`);
  invariant(afterReroll.persistent, 'rebuild did not leave a persistent parcel overlay');
  const houseChanged = afterReroll.rebuildSeed != null && (
    String(afterReroll.rebuildSeed) !== String(beforeReroll.rebuildSeed ?? '')
    || afterReroll.plotW !== beforeReroll.plotW
    || afterReroll.plotD !== beforeReroll.plotD
    || afterReroll.kind !== beforeReroll.kind
    || afterReroll.eave !== beforeReroll.eave
  );
  invariant(houseChanged,
    `rebuild did not change house seed/envelope (${JSON.stringify(beforeReroll)} → ${JSON.stringify(afterReroll)})`);
  invariant(afterReroll.conflicts === 0,
    `rebuild left yard conflicts: ${afterReroll.conflicts}`);

  invariant(runtimeErrors.length === 0, `runtime errors:\n${runtimeErrors.join('\n')}`);

  const manifest = [
    '# edit-experience capture (look-audit C1–C2 / GitHub #226)',
    '',
    'Not an automated visual gate — open the PNGs for experience review.',
    '`shots/` is untracked; default output is an OS temp directory.',
    '',
    '## Run',
    '',
    '```bash',
    'npm run shoot:edit-experience',
    'CHEOMA_EDIT_EXPERIENCE_OUT=/absolute/scratch/path npm run shoot:edit-experience',
    '```',
    '',
    '## Fixture',
    '',
    `- parcel: \`${fixture.parcelId}\` (${fixture.kind})`,
    `- village seed: \`${fixture.villageSeed}\` (URL \`vseed=7\`, \`seed=42\`, worker=0)`,
    `- time: \`${timeOfDay}\``,
    `- viewport: 1440×900`,
    `- live frames: ${liveFrames} @ ~${stepMs}ms (axis: eaveOverhang ${sliderInfo.start} → ${endValue})`,
    '',
    '## Captures',
    '',
    ...captures.map((cap) => {
      const bits = [`- \`${cap.file}\` — gap ${cap.gap || '?'}, phase ${cap.phase || '?'}`];
      if (cap.value != null) bits.push(`value=${Number(cap.value).toFixed(3)}`);
      if (cap.eave != null) bits.push(`eave=${Number(cap.eave).toFixed(3)}`);
      if (cap.rebuildSeed != null) bits.push(`rebuildSeed=${cap.rebuildSeed}`);
      if (cap.programs != null) bits.push(`programs=${cap.programs}`);
      if (cap.drawCalls != null) bits.push(`draws=${cap.drawCalls}`);
      return bits.join(' · ');
    }),
    '',
    '## C2 summary',
    '',
    `- village seed unchanged: ${beforeReroll.villageSeed}`,
    `- rebuildSeed: ${beforeReroll.rebuildSeed} → ${afterReroll.rebuildSeed}`,
    `- plot: ${beforeReroll.plotW}×${beforeReroll.plotD} → ${afterReroll.plotW}×${afterReroll.plotD}`,
    `- kind: ${beforeReroll.kind} → ${afterReroll.kind}`,
    '',
    '## Review axes',
    '',
    '- **C1**: continuity of the house silhouette between mid-drag frames; no broken intermediate geometry;',
    '  label/value keep up; no obvious shader hitch (program count plateaus across the sequence).',
    '- **C2**: rebuild feels authored (house changes, neighbours/village seed stay); settle frame is complete;',
    '  no stale base LOD under the new overlay.',
    '',
    'Out of scope for this harness: village-scale wave (look-audit C3 / `shoot:wave`), in-app Record button.',
    '',
  ].join('\n');
  await writeFile(join(outputDir, 'MANIFEST.md'), manifest);

  console.log(`[edit-experience] captures=${captures.length}`);
  console.log(`[edit-experience] output: ${outputDir}`);
  console.log(`[edit-experience] ${notes.join(' | ')}`);
} finally {
  await browser?.close().catch(() => {});
  await server.close().catch(() => {});
  // Leave the Vite cacheDir; OS temp is cleaned by the system.
}
