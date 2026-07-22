// Full-app gate for GitHub #19's focused-house rebuild transaction. It exercises
// the user-facing controls, persistent LOD ownership, deterministic flora swap,
// and the shared south-light / pavilion / camera contract in one representative
// scene. Screenshots go to an OS scratch directory for human review.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from '../app/node_modules/vite/dist/node/index.js';
import { launchVerificationBrowser, reportWebGLRenderer } from './lib/verification-browser.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const APP_ROOT = join(ROOT, 'app');
const cacheDir = await mkdtemp(join(tmpdir(), 'cheoma-parcel-rebuild-cache-'));
const outputDir = await mkdtemp(join(tmpdir(), 'cheoma-parcel-rebuild-shots-'));
const timeout = Number(process.env.CHEOMA_PARCEL_REBUILD_TIMEOUT_MS) || 120_000;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

const signed = (value) => `${value >= 0 ? '+' : ''}${value}`;

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
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (error) => runtimeErrors.push(`page: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' && !/favicon|404/i.test(message.text())) {
      runtimeErrors.push(`console: ${message.text()}`);
    }
  });

  // Seed 7 intentionally contains a regular courtyard-tree owner near the
  // pavilion, so the browser gate cannot pass on an empty flora fixture.
  const url = `http://127.0.0.1:${port}/?hero=0&village=1&worker=0&seed=42&vseed=7&time=day&lang=ko`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
  await page.waitForFunction(() => window.__SHOT_READY === true && !!window.__engine, null, { timeout });
  await page.waitForFunction(() => !!window.__engine.village.debugPlan(), null, { timeout });
  await reportWebGLRenderer(page, 'parcel-rebuild');

  const fixture = await page.evaluate(() => {
    const engine = window.__engine;
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
    const floraGroups = [];
    root.traverse((object) => { if (object.name === 'village-flora') floraGroups.push(object); });
    return {
      parcelId: parcel?.id || null,
      hasTree: !!parcel && treeOwners.has(parcel.id),
      villageSeed: engine.village.getState().seed,
      pavilion: pavilion ? { x: pavilion.x, z: pavilion.z, radius: pavilion.radius } : null,
      floraGroups: floraGroups.length,
      floraLayers: floraGroups[0]?.children.length || 0,
    };
  });
  invariant(fixture.parcelId, 'no editable residential parcel was available');
  invariant(fixture.hasTree, 'browser fixture did not select a rendered yard-tree owner');
  invariant(fixture.pavilion, 'village pavilion was not planned');
  invariant(fixture.floraGroups === 1 && fixture.floraLayers > 0,
    `expected one batched flora group, got ${fixture.floraGroups}/${fixture.floraLayers}`);

  await page.evaluate((parcelId) => window.__engine.village.debugFocus(parcelId), fixture.parcelId);
  await page.waitForFunction((parcelId) => {
    const state = window.__engine.village.getState();
    return state.selected === parcelId && !state.transitioning;
  }, fixture.parcelId, { timeout });

  const beforePath = join(outputDir, 'before-focus.png');
  await page.screenshot({ path: beforePath, animations: 'disabled' });
  const before = await page.evaluate(async ({ parcelId, focusModuleUrl, pavilionModuleUrl }) => {
    const engine = window.__engine;
    const root = engine.village.exportRoot();
    const plan = root.userData.plan;
    const parcel = plan.parcels.find((candidate) => candidate.id === parcelId);
    const pavilion = plan.features.pavilion;
    const [{ planParcelFocus }, { PAVILION_VIEW_CLEARANCE, pavilionBlocksParcelFocus }] = await Promise.all([
      import(focusModuleUrl),
      import(pavilionModuleUrl),
    ]);
    const expected = planParcelFocus(parcel);
    const target = engine.__controls.target;
    const camera = engine.camera.position;
    const dx = camera.x - target.x;
    const dz = camera.z - target.z;
    const len2 = dx * dx + dz * dz;
    const t = Math.max(0, Math.min(1,
      ((pavilion.x - target.x) * dx + (pavilion.z - target.z) * dz) / len2));
    const closestX = target.x + dx * t;
    const closestZ = target.z + dz * t;
    const floraGroups = [];
    root.traverse((object) => { if (object.name === 'village-flora') floraGroups.push(object); });
    engine.village.debugDrawCalls();
    return {
      state: engine.village.debugParcelRebuild(parcelId),
      cameraError: Math.hypot(camera.x - expected.cameraX, camera.z - expected.cameraZ),
      targetError: Math.hypot(target.x - expected.worldX, target.z - expected.worldZ),
      pavilionDistance: Math.hypot(pavilion.x - closestX, pavilion.z - closestZ),
      pavilionClearance: (pavilion.radius || 4.5) + PAVILION_VIEW_CLEARANCE,
      pavilionBlocks: pavilionBlocksParcelFocus(parcel, pavilion),
      drawCalls: engine.renderer.info.render.calls,
      programs: engine.renderer.info.programs?.length || 0,
      floraGroups: floraGroups.length,
      floraLayers: floraGroups[0]?.children.length || 0,
    };
  }, {
    parcelId: fixture.parcelId,
    focusModuleUrl: `/@fs${join(ROOT, 'src/generators/shared/parcel-spatial.js')}`,
    pavilionModuleUrl: `/@fs${join(ROOT, 'src/village/pavilion-plan.js')}`,
  });
  invariant(before.cameraError < 0.15 && before.targetError < 0.15,
    `live camera drifted from the south-light framing (${before.cameraError}/${before.targetError})`);
  invariant(!before.pavilionBlocks && before.pavilionDistance > before.pavilionClearance,
    `pavilion blocks the live focus ray (${before.pavilionDistance} <= ${before.pavilionClearance})`);

  const actions = await page.locator('.foot.house:not([aria-hidden="true"]) button')
    .evaluateAll((buttons) => buttons.map((button) => button.textContent.replace(/\s+/g, ' ').trim()));
  invariant(actions.length === 2, `house footer has ${actions.length} actions instead of 2`);
  invariant(actions.some((label) => label.includes('이 집 다시 짓기')), `missing rebuild label: ${actions.join(' | ')}`);
  invariant(actions.some((label) => label.includes('내보내기')), `missing export label: ${actions.join(' | ')}`);
  invariant(!actions.some((label) => /다시 보기|GLB/i.test(label)), `legacy action remains: ${actions.join(' | ')}`);

  // #10: the real Korean editor exposes the planner's four axes with visible
  // units/ranges. Exercise one width through the native keyboard path and one
  // count through the stepper, then inspect the actual FULL overlay plan.
  const openingBefore = await page.evaluate((parcelId) => {
    const engine = window.__engine;
    engine.village.debugDrawCalls();
    const state = engine.village.debugParcelRebuild(parcelId);
    const controls = {};
    for (const key of ['doorCount', 'windowCount', 'doorWidthK', 'windowWidthK']) {
      const input = document.querySelector(`.ctx.house:not([aria-hidden="true"]) input[data-key="${key}"]`);
      const row = input?.closest('.row')
        || document.querySelector(`.ctx.house:not([aria-hidden="true"]) .row[data-key="${key}"]`);
      controls[key] = {
        label: row?.querySelector('.rl')?.childNodes?.[0]?.textContent?.trim() || '',
        bounds: row?.querySelector('.bounds')?.textContent?.trim() || '',
        value: row?.querySelector('.rv, .num')?.textContent?.trim() || '',
        min: input?.min || null,
        max: input?.max || null,
        aria: input?.getAttribute('aria-valuetext') || '',
      };
    }
    return {
      controls,
      params: state.params,
      programs: engine.renderer.info.programs?.length || 0,
      drawCalls: engine.renderer.info.render.calls,
    };
  }, fixture.parcelId);
  invariant(openingBefore.controls.doorCount.label === '문 수'
      && openingBefore.controls.windowCount.label === '창 수'
      && openingBefore.controls.doorWidthK.label === '문 너비'
      && openingBefore.controls.windowWidthK.label === '창 너비',
    `opening editor lost Korean labels: ${JSON.stringify(openingBefore.controls)}`);
  invariant(openingBefore.controls.doorCount.value.endsWith('개')
      && openingBefore.controls.windowCount.value.endsWith('개'),
    `opening counts lost their unit: ${JSON.stringify(openingBefore.controls)}`);
  invariant(openingBefore.controls.doorWidthK.value.endsWith('%')
      && openingBefore.controls.windowWidthK.value.endsWith('%')
      && openingBefore.controls.doorWidthK.bounds.includes('–')
      && openingBefore.controls.windowWidthK.bounds.includes('–'),
    `opening widths lost percent/range affordances: ${JSON.stringify(openingBefore.controls)}`);

  const doorWidth = page.locator('.ctx.house:not([aria-hidden="true"]) input[data-key="doorWidthK"]');
  await doorWidth.focus();
  await doorWidth.press('ArrowRight');
  await page.waitForFunction(({ parcelId, beforeValue }) => (
    window.__engine.village.debugParcelRebuild(parcelId)?.params?.doorWidthK !== beforeValue
  ), { parcelId: fixture.parcelId, beforeValue: openingBefore.params.doorWidthK }, { timeout });
  const countButtons = page.locator('.ctx.house:not([aria-hidden="true"]) .row[data-key="doorCount"] button');
  const increaseEnabled = await countButtons.nth(1).isEnabled();
  await countButtons.nth(increaseEnabled ? 1 : 0).click();
  await page.waitForFunction(({ parcelId, beforeValue }) => (
    window.__engine.village.debugParcelRebuild(parcelId)?.params?.doorCount !== beforeValue
  ), { parcelId: fixture.parcelId, beforeValue: openingBefore.params.doorCount }, { timeout });
  const openingControlsPath = join(outputDir, 'opening-controls.png');
  await page.screenshot({ path: openingControlsPath, animations: 'disabled' });
  const openingAfter = await page.evaluate((parcelId) => {
    const engine = window.__engine;
    const override = engine.village.exportRoot().getObjectByName(`override-${parcelId}`);
    const plans = [];
    const panels = [];
    let frameBatches = 0;
    let hardwareBatches = 0;
    const materials = new Set();
    override?.traverse((object) => {
      if (object.userData.residentialOpeningPlan) plans.push(object.userData.residentialOpeningPlan);
      if (object.userData.residentialOpening) panels.push(object.userData.residentialOpening);
      if (object.name === 'opening-frame-details') frameBatches++;
      if (object.name === 'opening-hardware-details') hardwareBatches++;
      if (object.material) {
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material);
      }
    });
    engine.village.debugDrawCalls();
    return {
      state: engine.village.debugParcelRebuild(parcelId),
      plan: plans[0] || null,
      panels,
      frameBatches,
      hardwareBatches,
      materials: materials.size,
      programs: engine.renderer.info.programs?.length || 0,
      drawCalls: engine.renderer.info.render.calls,
    };
  }, fixture.parcelId);
  invariant(openingAfter.plan && openingAfter.panels.length === openingAfter.plan.openings.length,
    `FULL overlay rendered ${openingAfter.panels.length}/${openingAfter.plan?.openings.length || 0} openings`);
  invariant(openingAfter.plan.params.doorCount === openingAfter.state.params.doorCount
      && openingAfter.plan.params.doorWidthK === openingAfter.state.params.doorWidthK,
    'editor state and rendered residential plan diverged');
  invariant(openingAfter.panels.filter((opening) => opening.primary).length === 1
      && openingAfter.frameBatches === 1 && openingAfter.hardwareBatches === 1,
    `opening detail ownership/batching drifted: ${JSON.stringify(openingAfter)}`);
  invariant(openingAfter.programs - openingBefore.programs <= 8,
    `opening controls added ${openingAfter.programs - openingBefore.programs} shader programs`);
  invariant(openingAfter.drawCalls - openingBefore.drawCalls <= 30,
    `opening controls added ${openingAfter.drawCalls - openingBefore.drawCalls} draw calls`);
  invariant(openingAfter.materials < 80,
    `focused opening edit grew to ${openingAfter.materials} materials`);

  // #3: exercise the actual range-input path before the full parcel reroll.
  // A synchronous burst must become one latest-value preview, keep the merged
  // flora identity stable, then perform exactly one flora commit on change.
  const liveFixture = await page.evaluate((parcelId) => {
    const engine = window.__engine;
    const slider = document.querySelector('.ctx.house:not([aria-hidden="true"]) input[data-key="eaveOverhang"]');
    if (!slider) return null;
    const root = engine.village.exportRoot();
    const floraGroups = [];
    root.traverse((object) => { if (object.name === 'village-flora') floraGroups.push(object); });
    const min = Number(slider.min);
    const max = Number(slider.max);
    const startValue = Number(slider.value);
    const finalValue = Math.abs(startValue - max) > (max - min) * 0.2 ? max : min;
    const original = engine.village.rebuild.bind(engine.village);
    const calls = [];
    const liveState = {
      calls,
      flora: floraGroups[0],
      finalValue,
      startValue,
      inputSerial: 0,
      inputValue: startValue,
      phase: 'burst',
    };
    engine.village.rebuild = (...args) => {
      const started = performance.now();
      const result = original(...args);
      calls.push({
        parcelId: args[0],
        refreshFlora: args[2]?.refreshFlora !== false,
        inputSerial: liveState.inputSerial,
        inputValue: liveState.inputValue,
        payloadEave: args[1]?.building?.eaveOverhang,
        phase: liveState.phase,
        startedAt: started,
        duration: performance.now() - started,
      });
      return result;
    };
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    window.__liveEditFixture = liveState;
    for (let i = 1; i <= 48; i++) {
      const value = startValue + (finalValue - startValue) * (i / 48);
      setValue.call(slider, String(value));
      liveState.inputSerial++;
      liveState.inputValue = Number(slider.value);
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    }
    engine.village.debugDrawCalls();
    return {
      startValue,
      finalValue,
      startBox: engine.village.debugOverlayBox(parcelId),
      programs: engine.renderer.info.programs?.length || 0,
      drawCalls: engine.renderer.info.render.calls,
    };
  }, fixture.parcelId);
  invariant(liveFixture, 'focused regular parcel did not expose the eave slider');
  await page.waitForFunction(() => window.__liveEditFixture?.calls.length > 0, null, { timeout });
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
  // The first edited overlay can finish a retained shader link after the JS
  // rebuild has returned. Let the beauty frame settle; DOM assertions below
  // separately prove that the live edit did not fade or remove any controls.
  await page.waitForTimeout(180);
  const livePreviewPath = join(outputDir, 'live-preview.png');
  await page.screenshot({
    path: livePreviewPath,
    animations: 'disabled',
    style: '.ctxcard, .modewrap, .chroma { visibility: hidden !important; }',
  });
  const livePreview = await page.evaluate((parcelId) => {
    const engine = window.__engine;
    const slider = document.querySelector('.ctx.house:not([aria-hidden="true"]) input[data-key="eaveOverhang"]');
    const floraGroups = [];
    engine.village.exportRoot().traverse((object) => {
      if (object.name === 'village-flora') floraGroups.push(object);
    });
    engine.village.debugDrawCalls();
    return {
      calls: window.__liveEditFixture.calls.map((call) => ({ ...call })),
      value: Number(slider.value),
      label: slider.closest('label')?.querySelector('.rv')?.textContent?.trim(),
      box: engine.village.debugOverlayBox(parcelId),
      state: engine.village.debugParcelRebuild(parcelId),
      floraSame: floraGroups[0] === window.__liveEditFixture.flora,
      programs: engine.renderer.info.programs?.length || 0,
      drawCalls: engine.renderer.info.render.calls,
      houseOpacity: Number(getComputedStyle(slider.closest('.ctx.house')).opacity),
      footerOpacity: Number(getComputedStyle(document.querySelector('.foot.house')).opacity),
      modeText: document.querySelector('.mode')?.textContent?.replace(/\s+/g, ' ').trim(),
      exportText: document.querySelector('.foot.house .hbtn.glb')?.textContent?.replace(/\s+/g, ' ').trim(),
    };
  }, fixture.parcelId);
  invariant(livePreview.calls.length === 1,
    `48 input events produced ${livePreview.calls.length} previews instead of one`);
  invariant(livePreview.calls.every((call) => call.parcelId === fixture.parcelId && !call.refreshFlora),
    `live preview crossed parcel/flora ownership: ${JSON.stringify(livePreview.calls)}`);
  invariant(Math.abs(livePreview.value - liveFixture.finalValue) < 1e-6,
    `slider did not retain the latest input (${livePreview.value} != ${liveFixture.finalValue})`);
  invariant(livePreview.label === liveFixture.finalValue.toFixed(2),
    `live value label lagged behind geometry (${livePreview.label})`);
  invariant(Math.abs(livePreview.state.params.eaveOverhang - liveFixture.finalValue) < 1e-6,
    'preview geometry did not consume the latest slider value');
  invariant(livePreview.floraSame, 'live preview rebuilt the merged flora batch');
  invariant(livePreview.houseOpacity > 0.99 && livePreview.footerOpacity > 0.99,
    `live input faded the editing context (${livePreview.houseOpacity}/${livePreview.footerOpacity})`);
  invariant(/둘러보기.*집 보기/.test(livePreview.modeText || '') && /내보내기/.test(livePreview.exportText || ''),
    `live input removed UI actions (${livePreview.modeText}/${livePreview.exportText})`);
  invariant(Math.abs(livePreview.box.x - liveFixture.startBox.x) > 0.1
    || Math.abs(livePreview.box.z - liveFixture.startBox.z) > 0.1,
  'eave slider did not visibly change the house footprint before pointer release');

  await page.evaluate(() => {
    const slider = document.querySelector('.ctx.house:not([aria-hidden="true"]) input[data-key="eaveOverhang"]');
    window.__liveEditFixture.phase = 'burst-commit';
    slider.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForFunction(() => window.__liveEditFixture?.calls.length === 2, null, { timeout });
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
  const liveCommitPath = join(outputDir, 'live-commit.png');
  await page.screenshot({ path: liveCommitPath, animations: 'disabled' });
  const liveCommit = await page.evaluate((parcelId) => {
    const engine = window.__engine;
    const floraGroups = [];
    engine.village.exportRoot().traverse((object) => {
      if (object.name === 'village-flora') floraGroups.push(object);
    });
    engine.village.debugDrawCalls();
    return {
      calls: window.__liveEditFixture.calls.map((call) => ({ ...call })),
      state: engine.village.debugParcelRebuild(parcelId),
      floraChanged: floraGroups[0] !== window.__liveEditFixture.flora,
      floraGroups: floraGroups.length,
      programs: engine.renderer.info.programs?.length || 0,
      drawCalls: engine.renderer.info.render.calls,
    };
  }, fixture.parcelId);
  invariant(liveCommit.calls[1].refreshFlora, 'pointer release did not perform the final flora commit');
  invariant(liveCommit.floraChanged && liveCommit.floraGroups === 1,
    `commit did not atomically replace one flora batch (${liveCommit.floraChanged}/${liveCommit.floraGroups})`);
  invariant(liveCommit.state.persistent && liveCommit.state.conflicts === 0,
    `live commit lost persistence or yard clearance: ${JSON.stringify(liveCommit.state)}`);
  invariant(liveCommit.programs - liveFixture.programs <= 8,
    `live edit added ${liveCommit.programs - liveFixture.programs} shader programs`);
  invariant(liveCommit.drawCalls - liveFixture.drawCalls <= 60,
    `live edit added ${liveCommit.drawCalls - liveFixture.drawCalls} draw calls`);

  // A real drag emits one input per displayed frame rather than one synchronous
  // burst. Verify the scheduler's wall-clock cadence directly: at low display
  // rates, rebuilding each already-sparse frame is valid and smoother than an
  // input-count ratio would allow.
  const continuous = await page.evaluate(() => new Promise((resolve) => {
    const engine = window.__engine;
    const slider = document.querySelector('.ctx.house:not([aria-hidden="true"]) input[data-key="eaveOverhang"]');
    const fixture = window.__liveEditFixture;
    const floraGroups = [];
    engine.village.exportRoot().traverse((object) => {
      if (object.name === 'village-flora') floraGroups.push(object);
    });
    fixture.streamFlora = floraGroups[0];
    fixture.phase = 'continuous';
    const from = Number(slider.value);
    const target = fixture.startValue;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    const startedAt = performance.now();
    const duration = 520;
    const callStart = fixture.calls.length;
    let inputs = 0;
    function frame(now) {
      const progress = Math.min(1, (now - startedAt) / duration);
      setValue.call(slider, String(from + (target - from) * progress));
      fixture.inputSerial++;
      fixture.inputValue = Number(slider.value);
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      inputs++;
      if (progress < 1) requestAnimationFrame(frame);
      else resolve({ target, inputs, callStart, finalSerial: fixture.inputSerial });
    }
    requestAnimationFrame(frame);
  }));
  await page.waitForFunction(({ finalSerial }) => window.__liveEditFixture?.calls.some((call) => (
    call.phase === 'continuous' && call.inputSerial === finalSerial && !call.refreshFlora
  )), { finalSerial: continuous.finalSerial }, { timeout });
  const continuousPreview = await page.evaluate(({ callStart, finalSerial }) => {
    const fixture = window.__liveEditFixture;
    const floraGroups = [];
    window.__engine.village.exportRoot().traverse((object) => {
      if (object.name === 'village-flora') floraGroups.push(object);
    });
    const calls = fixture.calls.slice(callStart).map((call) => ({ ...call }));
    return {
      calls,
      finalPreview: calls.findLast((call) => (
        call.phase === 'continuous' && call.inputSerial === finalSerial && !call.refreshFlora
      )),
      totalCalls: fixture.calls.length,
      floraSame: floraGroups[0] === fixture.streamFlora,
    };
  }, { callStart: continuous.callStart, finalSerial: continuous.finalSerial });
  invariant(continuousPreview.calls.length >= 3,
    `continuous drag produced only ${continuousPreview.calls.length} previews`);
  invariant(continuousPreview.finalPreview
      && Math.abs(continuousPreview.finalPreview.inputValue - continuous.target) < 1e-6
      && Math.abs(continuousPreview.finalPreview.payloadEave - continuous.target) < 1e-6,
    `final input serial was not consumed exactly: ${JSON.stringify(continuousPreview.finalPreview)}`);
  const cadenceToleranceMs = 1;
  const cadenceSamples = continuousPreview.calls.slice(1).map((call, index) => {
    const previous = continuousPreview.calls[index];
    return {
      gapMs: call.startedAt - previous.startedAt,
      requiredMs: Math.min(96, Math.max(32, previous.duration * 2.2)),
      previousDurationMs: previous.duration,
    };
  });
  const cadenceViolations = cadenceSamples.filter(({ gapMs, requiredMs }) => (
    gapMs + cadenceToleranceMs < requiredMs
  ));
  invariant(cadenceViolations.length === 0,
    `continuous drag violated adaptive cadence: ${JSON.stringify(cadenceViolations)}`);
  console.log(`[live-edit] drag ${continuous.inputs} inputs → ${continuousPreview.calls.length} previews; `
    + `minimum gap ${Math.min(...cadenceSamples.map((sample) => sample.gapMs)).toFixed(1)}ms; `
    + `maximum required ${Math.max(...cadenceSamples.map((sample) => sample.requiredMs)).toFixed(1)}ms`);
  invariant(continuousPreview.calls.every((call) => !call.refreshFlora) && continuousPreview.floraSame,
    'continuous preview rebuilt flora before pointer release');

  const continuousCommit = await page.evaluate(({ parcelId, baseline }) => {
    const fixture = window.__liveEditFixture;
    const slider = document.querySelector('.ctx.house:not([aria-hidden="true"]) input[data-key="eaveOverhang"]');
    const before = fixture.calls.length;
    const callsBeforeCommit = fixture.calls.slice(baseline).map((call) => ({ ...call }));
    fixture.phase = 'continuous-commit';
    slider.dispatchEvent(new Event('change', { bubbles: true }));
    const after = fixture.calls.length;
    const calls = fixture.calls.slice(before).map((call) => ({ ...call }));
    const floraGroups = [];
    window.__engine.village.exportRoot().traverse((object) => {
      if (object.name === 'village-flora') floraGroups.push(object);
    });
    fixture.committedValue = fixture.startValue;
    return {
      before,
      after,
      callCount: after,
      callsBeforeCommit,
      calls,
      lastCall: calls.at(-1),
      state: window.__engine.village.debugParcelRebuild(parcelId),
      floraChanged: floraGroups[0] !== fixture.streamFlora,
    };
  }, { parcelId: fixture.parcelId, baseline: continuousPreview.totalCalls });
  invariant(continuousCommit.before === continuousPreview.totalCalls,
    `preview calls crossed the drained baseline: ${JSON.stringify(continuousCommit.callsBeforeCommit)}`);
  invariant(continuousCommit.after - continuousCommit.before === 1 && continuousCommit.calls.length === 1,
    `continuous pointer release produced ${continuousCommit.after - continuousCommit.before} calls: ${JSON.stringify(continuousCommit.calls)}`);
  invariant(continuousCommit.lastCall.refreshFlora && continuousCommit.floraChanged,
    `continuous pointer release did not perform one final flora commit: ${JSON.stringify(continuousCommit.calls)}`);
  invariant(continuousCommit.state.conflicts === 0,
    `continuous commit left ${continuousCommit.state.conflicts} yard conflicts`);
  await page.waitForTimeout(110);
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
  const staleCommitCalls = await page.evaluate((callCount) => (
    window.__liveEditFixture.calls.slice(callCount).map((call) => ({ ...call }))
  ), continuousCommit.callCount);
  invariant(staleCommitCalls.length === 0,
    `stale preview ran after exact commit: ${JSON.stringify(staleCommitCalls)}`);

  // Start another preview and leave focus in the same task. The scheduled frame
  // must be invalidated, and re-entry must restore the last committed value.
  await page.evaluate(() => {
    const slider = document.querySelector('.ctx.house:not([aria-hidden="true"]) input[data-key="eaveOverhang"]');
    const fixture = window.__liveEditFixture;
    const cancelledValue = fixture.committedValue === Number(slider.min) ? Number(slider.max) : Number(slider.min);
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setValue.call(slider, String(cancelledValue));
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    window.__engine.village.return();
  });
  await page.waitForFunction(() => {
    const state = window.__engine.village.getState();
    return state.selected == null && !state.transitioning;
  }, null, { timeout });
  const cancelled = await page.evaluate((parcelId) => ({
    calls: window.__liveEditFixture.calls.length,
    state: window.__engine.village.debugParcelRebuild(parcelId),
  }), fixture.parcelId);
  invariant(cancelled.calls === continuousCommit.callCount,
    `focus-out leaked a stale preview (${cancelled.calls}/${continuousCommit.callCount} rebuild calls)`);
  invariant(Math.abs(cancelled.state.params.eaveOverhang - continuous.target) < 1e-6,
    'cancelled slider value replaced the committed parcel spec');

  await page.evaluate((parcelId) => window.__engine.village.debugFocus(parcelId), fixture.parcelId);
  await page.waitForFunction((parcelId) => {
    const state = window.__engine.village.getState();
    return state.selected === parcelId && !state.transitioning;
  }, fixture.parcelId, { timeout });
  const restoredValue = await page.locator(
    '.ctx.house:not([aria-hidden="true"]) input[data-key="eaveOverhang"]',
  ).inputValue();
  invariant(Math.abs(Number(restoredValue) - continuous.target) < 1e-6,
    `refocus restored an uncommitted value (${restoredValue})`);

  await page.locator('.foot.house:not([aria-hidden="true"]) .hbtn.reroll').click();
  await page.waitForFunction(() => window.__engine.village.getState().transitioning, null, { timeout });
  await page.waitForFunction((parcelId) => {
    const state = window.__engine.village.getState();
    return state.selected === parcelId && !state.transitioning;
  }, fixture.parcelId, { timeout });

  const afterPath = join(outputDir, 'after-focus.png');
  await page.screenshot({ path: afterPath, animations: 'disabled' });
  const after = await page.evaluate(async ({
    parcelId,
    pavilionModuleUrl,
    parcelModuleUrl,
    solarModuleUrl,
  }) => {
    const engine = window.__engine;
    const root = engine.village.exportRoot();
    const plan = root.userData.plan;
    const parcel = plan.parcels.find((candidate) => candidate.id === parcelId);
    const pavilion = plan.features.pavilion;
    const [
      { pavilionBlocksParcelFocus, PAVILION_ROOF_RADIUS },
      { canopyBlocksSolarAccess },
      { buildingBlocksSolarAccess },
    ] = await Promise.all([
      import(pavilionModuleUrl),
      import(parcelModuleUrl),
      import(solarModuleUrl),
    ]);
    const floraGroups = [];
    root.traverse((object) => { if (object.name === 'village-flora') floraGroups.push(object); });
    engine.village.debugDrawCalls();
    return {
      villageSeed: engine.village.getState().seed,
      state: engine.village.debugParcelRebuild(parcelId),
      pavilionBlocksFocus: pavilionBlocksParcelFocus(parcel, pavilion),
      pavilionBlocksSolar: canopyBlocksSolarAccess(parcel, pavilion, pavilion.radius || PAVILION_ROOF_RADIUS),
      neighbourSolarConflicts: plan.parcels.filter((peer) => peer.id !== parcel.id && (
        buildingBlocksSolarAccess(parcel, peer, plan.site)
        || (peer.kind !== 'palace' && buildingBlocksSolarAccess(peer, parcel, plan.site))
      )).map((peer) => peer.id),
      drawCalls: engine.renderer.info.render.calls,
      programs: engine.renderer.info.programs?.length || 0,
      floraGroups: floraGroups.length,
      floraLayers: floraGroups[0]?.children.length || 0,
    };
  }, {
    parcelId: fixture.parcelId,
    pavilionModuleUrl: `/@fs${join(ROOT, 'src/village/pavilion-plan.js')}`,
    parcelModuleUrl: `/@fs${join(ROOT, 'src/village/parcel-contract.js')}`,
    solarModuleUrl: `/@fs${join(ROOT, 'src/village/solar-access.js')}`,
  });
  invariant(after.villageSeed === fixture.villageSeed, 'focused rebuild changed the village seed');
  invariant(after.state?.persistent && after.state.rebuildSeed != null, 'rebuilt parcel did not become authoritative');
  invariant(after.state.conflicts === 0, `rebuilt yard has ${after.state.conflicts} tree/object conflicts`);
  invariant(after.state.lod?.valid && after.state.lod.representations === 1 && after.state.lod.overlay,
    `focused rebuild has invalid LOD ownership: ${JSON.stringify(after.state.lod)}`);
  invariant(after.state.plotW < before.state.plotW || after.state.plotD < before.state.plotD,
    'rebuild did not vary the parcel envelope');
  invariant(!after.pavilionBlocksFocus && !after.pavilionBlocksSolar,
    'rebuilt parcel lost its pavilion solar/camera clearance');
  invariant(after.neighbourSolarConflicts.length === 0,
    `rebuilt house blocks neighbour sunlight: ${after.neighbourSolarConflicts.join(', ')}`);
  invariant(after.floraGroups === 1 && after.floraLayers === before.floraLayers,
    `flora batching changed ${before.floraGroups}/${before.floraLayers} -> ${after.floraGroups}/${after.floraLayers}`);
  invariant(after.programs - before.programs <= 8,
    `rebuild added ${after.programs - before.programs} shader programs`);
  invariant(after.drawCalls - before.drawCalls <= 60,
    `rebuild added ${after.drawCalls - before.drawCalls} draw calls`);

  await page.evaluate(() => window.__engine.village.return());
  await page.waitForFunction(() => {
    const state = window.__engine.village.getState();
    return state.selected == null && !state.transitioning;
  }, null, { timeout });
  const aerialPath = join(outputDir, 'after-aerial.png');
  await page.screenshot({ path: aerialPath, animations: 'disabled' });
  const aerial = await page.evaluate((parcelId) => window.__engine.village.debugParcelRebuild(parcelId), fixture.parcelId);
  invariant(aerial?.persistent && aerial.lod?.valid && aerial.lod.overlay,
    `focus-out restored stale base geometry: ${JSON.stringify(aerial?.lod)}`);

  await page.evaluate((parcelId) => window.__engine.village.debugFocus(parcelId), fixture.parcelId);
  await page.waitForFunction((parcelId) => {
    const state = window.__engine.village.getState();
    return state.selected === parcelId && !state.transitioning;
  }, fixture.parcelId, { timeout });
  const refocused = await page.evaluate((parcelId) => window.__engine.village.debugParcelRebuild(parcelId), fixture.parcelId);
  invariant(refocused.persistent && refocused.rebuildSeed === after.state.rebuildSeed,
    'refocus discarded the rebuilt parcel seed');
  invariant(JSON.stringify(refocused.params) === JSON.stringify(after.state.params),
    'refocus discarded the rebuilt edit specification');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(180);
  const mobileGrip = page.locator('.sheet.context .grip');
  await page.waitForFunction(() => document.querySelector('.sheet.context')?.dataset.snap === 'peek', null, { timeout });
  await mobileGrip.click();
  await page.waitForFunction(() => document.querySelector('.sheet.context')?.dataset.snap === 'half', null, { timeout });
  // data-snap changes before the 420ms transform finishes. Hover waits for a
  // stable, event-receiving grip, avoiding a stale pre-transition hit point.
  await mobileGrip.hover();
  const gripBox = await mobileGrip.boundingBox();
  invariant(gripBox, 'mobile editor grip has no layout box');
  await page.mouse.down();
  invariant(await page.locator('.sheet.context').evaluate((sheet) => sheet.classList.contains('dragging')),
    'mobile grip missed pointerdown');
  await page.mouse.move(gripBox.x + gripBox.width / 2, 36, { steps: 8 });
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelector('.sheet.context')?.dataset.snap === 'full', null, { timeout });
  const mobileControls = await page.evaluate(() => {
    const house = document.querySelector('.ctx.house:not([aria-hidden="true"])');
    const keys = ['doorCount', 'windowCount', 'doorWidthK', 'windowWidthK'];
    const controls = keys.map((key) => (
      house?.querySelector(`input[data-key="${key}"]`)
      || house?.querySelector(`.row[data-key="${key}"]`)
    ));
    const card = house?.closest('.ctxcard') || house?.parentElement;
    return {
      allPresent: controls.every(Boolean),
      widths: controls.filter(Boolean).map((control) => control.getBoundingClientRect().width),
      buttonSizes: [...house?.querySelectorAll('.row[data-key="doorCount"] button') || []]
        .map((button) => ({ width: button.getBoundingClientRect().width, height: button.getBoundingClientRect().height })),
      card: card ? { left: card.getBoundingClientRect().left, right: card.getBoundingClientRect().right } : null,
    };
  });
  invariant(mobileControls.allPresent, 'mobile editor lost one of the four opening controls');
  invariant(mobileControls.buttonSizes.every((size) => size.width >= 40 && size.height >= 40),
    `mobile opening steppers are too small: ${JSON.stringify(mobileControls.buttonSizes)}`);
  invariant(mobileControls.card && mobileControls.card.left >= -1 && mobileControls.card.right <= 391,
    `mobile editor overflows the viewport: ${JSON.stringify(mobileControls.card)}`);
  const mobilePath = join(outputDir, 'mobile-openings.png');
  await page.screenshot({ path: mobilePath, animations: 'disabled' });
  invariant(runtimeErrors.length === 0, `browser errors: ${runtimeErrors.join(' | ')}`);

  console.log(`screenshots: ${beforePath}, ${openingControlsPath}, ${livePreviewPath}, ${liveCommitPath}, ${afterPath}, ${aerialPath}, ${mobilePath}`);
  console.log(`PARCEL REBUILD BROWSER: PASS (${fixture.parcelId}, tree=${fixture.hasTree}, openings ${openingAfter.plan.openings.length}/${openingAfter.materials} materials, live 48→${livePreview.calls.length}, drag ${continuous.inputs}→${continuousPreview.calls.length}, exact commits, programs ${signed(after.programs - before.programs)}, calls ${signed(after.drawCalls - before.drawCalls)})`);
} finally {
  await browser?.close();
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
}
