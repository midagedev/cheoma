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
  await page.locator('canvas').screenshot({ path: beforePath });
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

  await page.locator('.foot.house:not([aria-hidden="true"]) .hbtn.reroll').click();
  await page.waitForFunction(() => window.__engine.village.getState().transitioning, null, { timeout });
  await page.waitForFunction((parcelId) => {
    const state = window.__engine.village.getState();
    return state.selected === parcelId && !state.transitioning;
  }, fixture.parcelId, { timeout });

  const afterPath = join(outputDir, 'after-focus.png');
  await page.locator('canvas').screenshot({ path: afterPath });
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
  await page.locator('canvas').screenshot({ path: aerialPath });
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
  invariant(runtimeErrors.length === 0, `browser errors: ${runtimeErrors.join(' | ')}`);

  console.log(`screenshots: ${beforePath}, ${afterPath}, ${aerialPath}`);
  console.log(`PARCEL REBUILD BROWSER: PASS (${fixture.parcelId}, tree=${fixture.hasTree}, programs ${signed(after.programs - before.programs)}, calls ${signed(after.drawCalls - before.drawCalls)})`);
} finally {
  await browser?.close();
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
}
