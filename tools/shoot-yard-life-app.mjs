// Real-product visual and lifecycle contract for #131 seasonal yard life.
//
// Boots the deterministic capital through Vite, focuses a real household whose
// authored yard-life slot is on the right side of the yard, and captures the
// actual product canvas in spring, autumn, and winter. A first season sweep
// warms every stable batch; the second sweep must keep the renderer resource
// signature unchanged. Returning through the product camera transition must
// then put the physical layer to sleep with zero submitted yard-life draws.
//
// Usage:
//   CHEOMA_BROWSER=chrome node tools/run-browser-locked.mjs -- \
//     node tools/shoot-yard-life-app.mjs [--out /scratch/path]
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PNG } from 'pngjs';
import { createServer } from '../app/node_modules/vite/dist/node/index.js';
import {
  launchVerificationBrowser,
  reportWebGLRenderer,
} from './lib/verification-browser.mjs';
import { YARD_HARD_GAP } from '../src/village/yard-layout.js';

const ROOT = resolve(import.meta.dirname, '..');
const APP_ROOT = join(ROOT, 'app');
const SEED = 4;
const TIMEOUT = Number(process.env.CHEOMA_YARD_LIFE_APP_TIMEOUT_MS) || 180_000;
const SEASONS = Object.freeze(['spring', 'autumn', 'winter']);

function outputArgument(argv) {
  const equal = argv.find((argument) => argument.startsWith('--out='));
  if (equal) return equal.slice('--out='.length);
  const index = argv.indexOf('--out');
  if (index < 0) return null;
  if (!argv[index + 1] || argv[index + 1].startsWith('--')) {
    throw new Error('--out requires a directory');
  }
  return argv[index + 1];
}

const requestedOutput = outputArgument(process.argv.slice(2));
const outputDir = requestedOutput
  ? resolve(requestedOutput)
  : await mkdtemp(join(tmpdir(), 'cheoma-yard-life-app-shots-'));
const cacheDir = await mkdtemp(join(tmpdir(), 'cheoma-yard-life-app-cache-'));
await mkdir(outputDir, { recursive: true });

const failures = [];
const runtimeErrors = [];

function pass(condition, message, detail = '') {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${message}${detail ? ` (${detail})` : ''}`);
  if (!condition) failures.push(message);
}

function resourceSignature(snapshot) {
  return JSON.stringify({
    programs: snapshot.resources.programs,
    programKeys: snapshot.resources.programKeys,
    geometries: snapshot.resources.geometries,
    textures: snapshot.resources.textures,
  });
}

function pixelDelta(leftBytes, rightBytes) {
  const left = PNG.sync.read(leftBytes);
  const right = PNG.sync.read(rightBytes);
  if (left.width !== right.width || left.height !== right.height) {
    throw new Error('yard-life pixel comparison dimensions differ');
  }
  let changed = 0;
  let energy = 0;
  let minX = left.width;
  let minY = left.height;
  let maxX = -1;
  let maxY = -1;
  for (let offset = 0; offset < left.data.length; offset += 4) {
    const difference = Math.abs(left.data[offset] - right.data[offset])
      + Math.abs(left.data[offset + 1] - right.data[offset + 1])
      + Math.abs(left.data[offset + 2] - right.data[offset + 2]);
    energy += difference;
    if (difference < 12) continue;
    const pixel = offset / 4;
    const x = pixel % left.width;
    const y = Math.floor(pixel / left.width);
    changed++;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return {
    changed,
    energy,
    bounds: changed ? { minX, minY, maxX, maxY } : null,
  };
}

function wireRuntimeErrors(page) {
  page.on('pageerror', (error) => runtimeErrors.push(`page: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' && !/favicon|404/i.test(message.text())) {
      runtimeErrors.push(`console: ${message.text()}`);
    }
  });
}

async function settleFrames(page, count = 24) {
  await page.evaluate((frameCount) => new Promise((resolveFrame) => {
    let remaining = frameCount;
    const step = () => {
      remaining--;
      if (remaining <= 0) resolveFrame();
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }), count);
}

async function hideNonCanvasChrome(page) {
  await page.evaluate(() => {
    const canvas = window.__engine.renderer.domElement;
    const keep = new Set();
    for (let current = canvas; current; current = current.parentElement) keep.add(current);
    for (const element of document.querySelectorAll('*')) {
      if (!keep.has(element)) element.style.setProperty('visibility', 'hidden', 'important');
    }
  });
}

async function setAndSettleSeason(page, season) {
  await page.evaluate((name) => {
    const engine = window.__engine;
    engine.debugSetPaused(false);
    engine.setWeather('clear', { immediate: true });
    engine.setSeason(name);
  }, season);
  await page.waitForFunction((name) => {
    const engine = window.__engine;
    const state = engine?.getState?.();
    const yardLife = engine?.village?.debugYardLife?.();
    return state?.season === name
      && state?.weather === 'clear'
      && yardLife?.season === name
      && yardLife?.weather === 'clear'
      && yardLife?.transitioning === false
      && engine.village.getState().transitioning === false;
  }, season, { timeout: TIMEOUT });
  await settleFrames(page);
}

async function snapshotSeason(page, season, ownerId) {
  const snapshot = await page.evaluate(({ expectedSeason, expectedOwner }) => {
    const engine = window.__engine;
    engine.debugSetPaused(true);
    for (let frame = 0; frame < 4; frame++) engine.debugRenderDofFrame();

    const yardLife = engine.village.debugYardLife();
    const state = engine.getState();
    const villageState = engine.village.getState();
    const root = engine.village.exportRoot();
    const group = root?.getObjectByName('village-yard-life') || null;
    const ownerRecords = [];
    for (let index = 0; index < (yardLife?.records?.length || 0); index++) {
      const record = yardLife.records[index];
      if (record.owner?.parcelId !== expectedOwner) continue;
      ownerRecords.push({
        id: record.id,
        season: record.season,
        motif: record.motif,
        variant: record.variant,
        slot: record.slot,
        world: record.world,
        weight: yardLife.weights[index],
      });
    }
    const selectedRecord = ownerRecords.find((record) => record.season === expectedSeason);
    const otherSeasonPeak = Math.max(
      0,
      ...ownerRecords
        .filter((record) => record.season !== expectedSeason)
        .map((record) => record.weight),
    );
    const resources = {
      programs: engine.renderer.info.programs?.length || 0,
      programKeys: (engine.renderer.info.programs || [])
        .map((program) => String(program.cacheKey))
        .sort(),
      geometries: engine.renderer.info.memory.geometries,
      textures: engine.renderer.info.memory.textures,
    };
    return {
      season: expectedSeason,
      state: { season: state.season, weather: state.weather },
      villageState,
      yardLife: {
        season: yardLife?.season ?? null,
        weather: yardLife?.weather ?? null,
        transitioning: yardLife?.transitioning ?? null,
        recordCount: yardLife?.recordCount ?? 0,
        activeRecords: yardLife?.activeRecords ?? 0,
        allocatedDrawCalls: yardLife?.allocatedDrawCalls ?? 0,
        submittedDrawCalls: yardLife?.submittedDrawCalls ?? 0,
        selectedRecordWeight: selectedRecord?.weight ?? null,
        otherSeasonPeak,
        ownerRecords,
      },
      group: group ? {
        visible: group.visible,
        attached: !!group.parent,
        childCount: group.children.length,
      } : null,
      resources,
    };
  }, { expectedSeason: season, expectedOwner: ownerId });

  const path = join(outputDir, `capital-focus-${ownerId}-${season}.png`);
  const canvas = page.locator('canvas[data-yard-life-product-canvas]');
  const visibleA = await canvas.screenshot({ path });
  await page.evaluate(() => {
    const engine = window.__engine;
    const group = engine.village.exportRoot()?.getObjectByName('village-yard-life');
    if (!group) throw new Error('yard-life product group disappeared before pixel proof');
    group.visible = false;
    for (let frame = 0; frame < 4; frame++) engine.debugRenderDofFrame();
  });
  const hidden = await canvas.screenshot();
  await page.evaluate(() => {
    const engine = window.__engine;
    const group = engine.village.exportRoot()?.getObjectByName('village-yard-life');
    if (!group) throw new Error('yard-life product group disappeared during pixel proof');
    group.visible = true;
    for (let frame = 0; frame < 4; frame++) engine.debugRenderDofFrame();
  });
  const visibleB = await canvas.screenshot();
  const contribution = pixelDelta(visibleA, hidden);
  const repeat = pixelDelta(visibleA, visibleB);
  await page.evaluate(() => window.__engine.debugSetPaused(false));
  return { ...snapshot, path, pixels: { contribution, repeat } };
}

async function inspectFocusGrassClearance(page, ownerId) {
  return page.evaluate(({ expectedOwner, hardGap }) => {
    const engine = window.__engine;
    const yardLife = engine.village.debugYardLife();
    const ring = engine.scene.children.find((object) => (
      object.name === 'focusRing'
      && object.userData?.parcelId === expectedOwner
    )) || null;
    const grass = ring?.getObjectByName('focusGrass') || null;
    const union = new Map();
    for (const record of yardLife?.records || []) {
      if (record.owner?.parcelId !== expectedOwner) continue;
      const radius = Math.hypot(record.footprint.halfX, record.footprint.halfZ) + hardGap;
      const key = `${record.slot}|${record.world.x}|${record.world.z}`;
      const prior = union.get(key);
      if (!prior || radius > prior.radius) {
        union.set(key, {
          slot: record.slot,
          x: record.world.x,
          z: record.world.z,
          radius,
        });
      }
    }

    if (!grass) {
      return {
        ringFound: !!ring,
        grassFound: false,
        instances: 0,
        obstacles: union.size,
        collisions: null,
        minimumClearance: null,
      };
    }

    // setupGrass stores world instance transforms beneath an identity focusRing,
    // but compose with matrixWorld too so this proof remains valid if that parent
    // later gains a transform.
    grass.updateWorldMatrix(true, false);
    const instance = grass.instanceMatrix.array;
    const world = grass.matrixWorld.elements;
    let collisions = 0;
    let minimumClearance = Infinity;
    for (let index = 0; index < grass.count; index++) {
      const offset = index * 16;
      const localX = instance[offset + 12];
      const localY = instance[offset + 13];
      const localZ = instance[offset + 14];
      const x = world[0] * localX + world[4] * localY + world[8] * localZ + world[12];
      const z = world[2] * localX + world[6] * localY + world[10] * localZ + world[14];
      for (const obstacle of union.values()) {
        const clearance = Math.hypot(x - obstacle.x, z - obstacle.z) - obstacle.radius;
        minimumClearance = Math.min(minimumClearance, clearance);
        if (clearance <= 1e-6) collisions++;
      }
    }
    return {
      ringFound: true,
      grassFound: true,
      instances: grass.count,
      obstacles: union.size,
      collisions,
      minimumClearance: Number.isFinite(minimumClearance) ? minimumClearance : null,
    };
  }, { expectedOwner: ownerId, hardGap: YARD_HARD_GAP });
}

const server = await createServer({
  root: APP_ROOT,
  configFile: join(APP_ROOT, 'vite.config.js'),
  cacheDir,
  logLevel: 'error',
  server: {
    host: '127.0.0.1',
    port: 0,
    strictPort: false,
    hmr: false,
  },
});

let browser;
const startedAt = Date.now();
try {
  await server.listen();
  const port = server.httpServer.address().port;
  browser = await launchVerificationBrowser();
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  });
  page.setDefaultTimeout(TIMEOUT);
  wireRuntimeErrors(page);

  const url = `http://127.0.0.1:${port}/?hero=0&village=1&worker=0&shot=1`
    + `&seed=42&vseed=${SEED}&vscale=capital&vpalace=1`
    + '&time=day&season=summer&weather=clear&lang=ko';
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
  await page.waitForFunction((seed) => {
    const engine = window.__engine;
    const plan = engine?.village?.debugPlan?.();
    const yardLife = engine?.village?.debugYardLife?.();
    return window.__SHOT_READY === true
      && plan?.seed === seed
      && plan?.scale === 'capital'
      && yardLife?.recordCount > 0
      && !engine.village.getState().transitioning;
  }, SEED, { timeout: TIMEOUT });
  await reportWebGLRenderer(page, 'yard-life-app');

  const fixture = await page.evaluate(() => {
    const engine = window.__engine;
    const yardLife = engine.village.debugYardLife();
    const focusable = new Set(engine.village.debugParcels().map((parcel) => parcel.parcelId));
    const owners = new Map();
    for (const record of yardLife.records || []) {
      const ownerId = record.owner?.parcelId;
      if (!ownerId || !focusable.has(ownerId)) continue;
      let owner = owners.get(ownerId);
      if (!owner) {
        owner = { ownerId, records: [], rightCount: 0 };
        owners.set(ownerId, owner);
      }
      owner.records.push({
        id: record.id,
        season: record.season,
        motif: record.motif,
        variant: record.variant,
        slot: record.slot,
        world: record.world,
      });
      if (String(record.slot).includes('right')) owner.rightCount++;
    }
    return [...owners.values()]
      .filter((owner) => owner.rightCount > 0)
      .sort((left, right) => (
        right.rightCount - left.rightCount
        || left.ownerId.localeCompare(right.ownerId)
      ))[0] || null;
  });
  if (!fixture) throw new Error('capital seed has no focusable yard-life owner with a right slot');
  pass(fixture.records.length === 3,
    'selected household owns one record for each authored season',
    `${fixture.ownerId}: ${fixture.records.map((record) => record.season).join(',')}`);
  pass(fixture.rightCount > 0,
    'selected household uses a right-side yard slot',
    fixture.records.map((record) => `${record.season}:${record.slot}`).join(' '));

  await page.evaluate((ownerId) => {
    const engine = window.__engine;
    engine.renderer.domElement.dataset.yardLifeProductCanvas = '';
    engine.village.focus(ownerId);
  }, fixture.ownerId);
  await page.waitForFunction((ownerId) => {
    const state = window.__engine?.village?.getState?.();
    return state?.selected === ownerId && state.transitioning === false;
  }, fixture.ownerId, { timeout: TIMEOUT });
  await settleFrames(page, 36);
  const grassClearance = await inspectFocusGrassClearance(page, fixture.ownerId);
  pass(grassClearance.ringFound && grassClearance.grassFound
      && grassClearance.instances > 0,
  'focused household owns one physical focus-grass batch',
  `instances=${grassClearance.instances}`);
  pass(grassClearance.obstacles > 0 && grassClearance.collisions === 0,
    'focus-grass centers clear the selected household three-season obstacle union',
    `obstacles=${grassClearance.obstacles} collisions=${grassClearance.collisions}`
      + ` minimumClearance=${grassClearance.minimumClearance}`);
  // Element screenshots include overlapping DOM in the canvas rectangle.
  // Preserve every layout box (and therefore the product view shift), while
  // hiding only non-canvas chrome so the review files contain the real WebGL
  // image instead of a harness-authored camera or UI-obscured crop.
  await hideNonCanvasChrome(page);

  // Exercise every transition once before measuring. This allows the stable
  // prebuilt scene and post stack to link any legitimate first-use program.
  for (const season of SEASONS) await setAndSettleSeason(page, season);

  const captures = [];
  for (const season of SEASONS) {
    await setAndSettleSeason(page, season);
    captures.push(await snapshotSeason(page, season, fixture.ownerId));
  }

  for (const capture of captures) {
    const detail = capture.yardLife;
    pass(capture.state.season === capture.season && capture.state.weather === 'clear'
        && detail.season === capture.season && detail.weather === 'clear',
    `${capture.season}: product and yard-life state agree`,
    `app=${capture.state.season}/${capture.state.weather} `
      + `yard=${detail.season}/${detail.weather}`);
    pass(detail.transitioning === false,
      `${capture.season}: capture occurs after the continuous transition settles`);
    pass(capture.villageState.selected === fixture.ownerId
        && capture.villageState.transitioning === false,
    `${capture.season}: product focus remains settled on the chosen parcel`);
    pass(capture.group?.attached && capture.group.visible && capture.group.childCount > 0,
      `${capture.season}: the actual product yard-life group is drawable`,
      JSON.stringify(capture.group));
    pass(detail.activeRecords > 0 && detail.submittedDrawCalls > 0,
      `${capture.season}: near-detail LOD submits physical yard-life batches`,
      `active=${detail.activeRecords} draws=${detail.submittedDrawCalls}`);
    pass(detail.selectedRecordWeight > 0.998 && detail.otherSeasonPeak < 0.002,
      `${capture.season}: only the chosen household's matching motif is active`,
      `selected=${detail.selectedRecordWeight} otherPeak=${detail.otherSeasonPeak}`);
    pass(capture.pixels.contribution.changed >= 24
        && capture.pixels.contribution.changed
          > capture.pixels.repeat.changed * 1.5 + 16,
    `${capture.season}: the selected physical motif contributes visible product pixels`,
    `changed=${capture.pixels.contribution.changed}`
      + ` repeat=${capture.pixels.repeat.changed}`
      + ` bounds=${JSON.stringify(capture.pixels.contribution.bounds)}`);
    console.log(`VISUAL ${capture.path}`);
  }

  const signatures = new Set(captures.map(resourceSignature));
  pass(signatures.size === 1,
    'program, geometry, and texture counts plateau across the measured season sweep',
    captures.map((capture) => (
      `${capture.season}=p${capture.resources.programs}`
      + `/g${capture.resources.geometries}/t${capture.resources.textures}`
    )).join(' '));

  await page.evaluate(() => window.__engine.village.return());
  await page.waitForFunction(() => {
    const engine = window.__engine;
    const state = engine?.village?.getState?.();
    const yardLife = engine?.village?.debugYardLife?.();
    return state?.selected == null
      && state?.transitioning === false
      && yardLife?.submittedDrawCalls === 0;
  }, null, { timeout: TIMEOUT });
  await settleFrames(page, 24);

  const aerial = await page.evaluate(() => {
    const engine = window.__engine;
    engine.debugSetPaused(true);
    for (let frame = 0; frame < 4; frame++) engine.debugRenderDofFrame();
    const debug = engine.village.debugYardLife();
    const group = engine.village.exportRoot()?.getObjectByName('village-yard-life');
    return {
      state: engine.village.getState(),
      activeRecords: debug.activeRecords,
      submittedDrawCalls: debug.submittedDrawCalls,
      groupVisible: group?.visible ?? null,
      resources: {
        programs: engine.renderer.info.programs?.length || 0,
        programKeys: (engine.renderer.info.programs || [])
          .map((program) => String(program.cacheKey))
          .sort(),
        geometries: engine.renderer.info.memory.geometries,
        textures: engine.renderer.info.memory.textures,
      },
    };
  });
  const aerialPath = join(outputDir, `capital-aerial-${fixture.ownerId}-winter.png`);
  // Focus-out changes product UI state and can mount fresh guide elements.
  // Hide those new DOM nodes too before recording the canvas-only aerial proof.
  await hideNonCanvasChrome(page);
  await page.locator('canvas[data-yard-life-product-canvas]').screenshot({ path: aerialPath });
  await page.evaluate(() => window.__engine.debugSetPaused(false));

  pass(aerial.state.selected == null && aerial.state.transitioning === false,
    'product camera returns to settled aerial exploration');
  pass(aerial.activeRecords === 0
      && aerial.submittedDrawCalls === 0
      && aerial.groupVisible === false,
  'aerial LOD sleeps the physical yard-life layer with zero submitted draws',
  `active=${aerial.activeRecords} draws=${aerial.submittedDrawCalls} visible=${aerial.groupVisible}`);
  console.log(`VISUAL ${aerialPath}`);

  pass(runtimeErrors.length === 0,
    'product page emits no runtime or shader errors',
    runtimeErrors[0] || '');
  console.log(`FIXTURE ${JSON.stringify(fixture)}`);
  console.log(`METRICS ${JSON.stringify({
    captures: captures.map((capture) => ({
      season: capture.season,
      activeRecords: capture.yardLife.activeRecords,
      submittedDrawCalls: capture.yardLife.submittedDrawCalls,
      selectedRecordWeight: capture.yardLife.selectedRecordWeight,
      pixels: capture.pixels,
      resources: {
        programs: capture.resources.programs,
        geometries: capture.resources.geometries,
        textures: capture.resources.textures,
      },
    })),
    aerial: {
      state: aerial.state,
      activeRecords: aerial.activeRecords,
      submittedDrawCalls: aerial.submittedDrawCalls,
      groupVisible: aerial.groupVisible,
      resources: {
        programs: aerial.resources.programs,
        geometries: aerial.resources.geometries,
        textures: aerial.resources.textures,
      },
    },
    focusGrass: grassClearance,
  })}`);
  await page.close();
} catch (error) {
  failures.push(error instanceof Error ? error.stack || error.message : String(error));
} finally {
  await browser?.close().catch(() => {});
  await server.close().catch(() => {});
  await rm(cacheDir, { recursive: true, force: true });
}

console.log(`YARD LIFE APP: ${failures.length ? 'FAIL' : 'PASS'} `
  + `elapsed=${((Date.now() - startedAt) / 1000).toFixed(2)}s output=${outputDir}`);
if (runtimeErrors.length) {
  for (const error of runtimeErrors) console.error(`ERROR ${error}`);
}
if (failures.length) {
  for (const failure of failures) console.error(`FAILURE ${failure}`);
  process.exitCode = 1;
}
