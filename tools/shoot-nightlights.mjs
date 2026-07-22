// #81 product visual: renderer-authored window anchors and real depth occlusion.
//
// Captures one stable regular house from the real Vite app at vseed=20260716.
// All three frames use the same front camera. `front-final` and `rear-depth-on`
// retain the product material; `rear-depth-off` changes only the Points
// material's verification hook so a rear light reveals where it would leak.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PNG } from 'pngjs';
import { createServer } from '../app/node_modules/vite/dist/node/index.js';
import {
  launchVerificationBrowser,
  reportWebGLRenderer,
} from './lib/verification-browser.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const APP_ROOT = join(ROOT, 'app');
const SEED = 20260716;
const timeout = Number(process.env.CHEOMA_NIGHTLIGHTS_TIMEOUT_MS) || 180_000;

function outputArgument(argv) {
  const equal = argv.find((arg) => arg.startsWith('--out='));
  if (equal) return equal.slice('--out='.length);
  const index = argv.indexOf('--out');
  if (index < 0) return null;
  if (!argv[index + 1] || argv[index + 1].startsWith('--')) {
    throw new Error('--out requires a directory');
  }
  return argv[index + 1];
}

const requestedOut = outputArgument(process.argv.slice(2));
const outDir = requestedOut
  ? resolve(requestedOut)
  : await mkdtemp(join(tmpdir(), 'cheoma-nightlights-shots-'));
await mkdir(outDir, { recursive: true });
const cacheDir = await mkdtemp(join(tmpdir(), 'cheoma-nightlights-cache-'));

const failures = [];
const errors = [];

function pass(condition, message, detail = '') {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${message}${detail ? ` (${detail})` : ''}`);
  if (!condition) failures.push(message);
}

function horizontalUnit(anchor) {
  const length = Math.hypot(anchor.outwardX, anchor.outwardZ) || 1;
  return { x: anchor.outwardX / length, z: anchor.outwardZ / length };
}

function pairScore(first, second) {
  const a = horizontalUnit(first);
  const b = horizontalUnit(second);
  return a.x * b.x + a.z * b.z;
}

function bestOpposedPair(selected) {
  let best = null;
  for (let i = 0; i < selected.length; i += 1) {
    for (let j = i + 1; j < selected.length; j += 1) {
      const dot = pairScore(selected[i], selected[j]);
      if (!best || dot < best.dot) best = { first: selected[i], second: selected[j], dot };
    }
  }
  if (!best) return null;
  const firstFront = best.first.outwardZ >= best.second.outwardZ;
  return {
    front: firstFront ? best.first : best.second,
    rear: firstFront ? best.second : best.first,
    dot: best.dot,
  };
}

function ownerSignature(owner) {
  if (!owner) return null;
  return owner.selected.map((anchor) => ({
    openingId: anchor.openingId,
    position: [anchor.x, anchor.y, anchor.z].map((value) => +value.toFixed(5)),
    outward: [anchor.outwardX, anchor.outwardY, anchor.outwardZ]
      .map((value) => +value.toFixed(5)),
  }));
}

function anchorDelta(before, after) {
  if (!before || !after) return null;
  const byId = new Map(before.selected.map((anchor) => [anchor.openingId, anchor]));
  let max = 0;
  let matched = 0;
  for (const anchor of after.selected) {
    const old = byId.get(anchor.openingId);
    if (!old) continue;
    matched += 1;
    max = Math.max(max, Math.hypot(anchor.x - old.x, anchor.y - old.y, anchor.z - old.z));
  }
  return { matched, max };
}

function decode(buffer) {
  return PNG.sync.read(buffer);
}

function sampleWindow(buffer, ndc, radius = 30) {
  const image = decode(buffer);
  const cx = Math.round((ndc[0] * 0.5 + 0.5) * (image.width - 1));
  const cy = Math.round((-ndc[1] * 0.5 + 0.5) * (image.height - 1));
  const x0 = Math.max(0, cx - radius);
  const x1 = Math.min(image.width - 1, cx + radius);
  const y0 = Math.max(0, cy - radius);
  const y1 = Math.min(image.height - 1, cy + radius);
  let warmPixels = 0;
  let peakWarm = -Infinity;
  let peak = { x: cx, y: cy, rgba: [0, 0, 0, 0] };
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const offset = (y * image.width + x) * 4;
      const rgba = Array.from(image.data.subarray(offset, offset + 4));
      const [r, g, b] = rgba;
      const warmth = r - b + Math.max(0, g - b) * 0.25;
      if (r > 100 && r > b + 18 && g > b + 5) warmPixels += 1;
      if (warmth > peakWarm) {
        peakWarm = warmth;
        peak = { x, y, rgba };
      }
    }
  }
  return { center: { x: cx, y: cy }, radius, warmPixels, peakWarm, peak };
}

function difference(onBuffer, offBuffer, ndc, radius = 34) {
  const on = decode(onBuffer);
  const off = decode(offBuffer);
  if (on.width !== off.width || on.height !== off.height) {
    throw new Error('nightlight captures have different dimensions');
  }
  const cx = Math.round((ndc[0] * 0.5 + 0.5) * (on.width - 1));
  const cy = Math.round((-ndc[1] * 0.5 + 0.5) * (on.height - 1));
  const x0 = Math.max(0, cx - radius);
  const x1 = Math.min(on.width - 1, cx + radius);
  const y0 = Math.max(0, cy - radius);
  const y1 = Math.min(on.height - 1, cy + radius);
  let changedPixels = 0;
  let signedBrightnessGain = 0;
  let maxChannelDelta = 0;
  let peak = null;
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const offset = (y * on.width + x) * 4;
      const onRgb = Array.from(on.data.subarray(offset, offset + 3));
      const offRgb = Array.from(off.data.subarray(offset, offset + 3));
      const delta = Math.max(...offRgb.map((value, channel) => Math.abs(value - onRgb[channel])));
      const gain = offRgb.reduce((sum, value) => sum + value, 0)
        - onRgb.reduce((sum, value) => sum + value, 0);
      if (delta >= 4) changedPixels += 1;
      signedBrightnessGain += gain;
      if (delta > maxChannelDelta) {
        maxChannelDelta = delta;
        peak = { x, y, on: onRgb, off: offRgb, delta, gain };
      }
    }
  }
  return {
    center: { x: cx, y: cy },
    radius,
    changedPixels,
    signedBrightnessGain,
    maxChannelDelta,
    peak,
  };
}

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
  page.setDefaultTimeout(timeout);
  await page.addInitScript(() => { window.__noWarm = true; });
  page.on('pageerror', (error) => errors.push(`page: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' && !/favicon|404/i.test(message.text())) {
      errors.push(`console: ${message.text()}`);
    }
  });

  const url = `http://127.0.0.1:${port}/?shot=1&hero=0&village=1&worker=0`
    + `&vscale=town&seed=42&vseed=${SEED}&time=night&season=autumn&weather=clear`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
  await page.waitForFunction(() => window.__SHOT_READY === true
    && window.__engine?.village?.debugPlan?.()?.seed === 20260716
    && window.__engine?.village?.debugPlan?.()?.scale === 'town', null, { timeout });
  await page.waitForFunction(() => !window.__engine.village.getState().transitioning, null, { timeout });
  await reportWebGLRenderer(page, 'nightlights');

  const fixture = await page.evaluate(() => {
    const engine = window.__engine;
    let points = null;
    engine.scene.traverse((object) => { if (object.name === 'nightlight-points') points = object; });
    const api = points?.parent?.userData?.nightLights;
    if (!points || !api) throw new Error('missing product nightlight Points API');
    const regular = engine.village.debugParcels()
      .filter((parcel) => !parcel.hero && parcel.editable && (parcel.kind === 'giwa' || parcel.kind === 'choga'))
      .map((parcel) => ({ parcel, owner: api.debugOwner(parcel.parcelId) }))
      .filter(({ owner }) => owner?.selected?.length >= 2);
    const dot = (a, b) => {
      const al = Math.hypot(a.outwardX, a.outwardZ) || 1;
      const bl = Math.hypot(b.outwardX, b.outwardZ) || 1;
      return a.outwardX / al * b.outwardX / bl + a.outwardZ / al * b.outwardZ / bl;
    };
    const score = ({ owner }) => {
      let value = 1;
      for (let i = 0; i < owner.selected.length; i += 1) {
        for (let j = i + 1; j < owner.selected.length; j += 1) {
          value = Math.min(value, dot(owner.selected[i], owner.selected[j]));
        }
      }
      return value;
    };
    regular.sort((a, b) => score(a) - score(b)
      || a.parcel.parcelId.localeCompare(b.parcel.parcelId));
    const p13 = regular.find((entry) => entry.parcel.parcelId === 'p13' && score(entry) < -0.15);
    const chosen = p13 || regular[0];
    if (!chosen) throw new Error('no stable regular house owns two authored nightlight anchors');
    return {
      parcel: chosen.parcel,
      owner: chosen.owner,
      pairDot: score(chosen),
      usedPreferredP13: chosen.parcel.parcelId === 'p13',
      resource: api.debugState(),
    };
  });

  const baseOwner = fixture.owner;
  await page.evaluate((parcelId) => window.__engine.village.debugFocus(parcelId), fixture.parcel.parcelId);
  await page.waitForFunction(() => window.__engine.village.getState().transitioning, null, { timeout: 10_000 });
  await page.evaluate(() => window.__engine.debugDofSeek(1, { finish: true }));
  await page.waitForFunction((parcelId) => {
    const state = window.__engine.village.getState();
    return state.selected === parcelId && !state.transitioning;
  }, fixture.parcel.parcelId, { timeout: 10_000 });

  const focusedOwner = await page.evaluate((parcelId) => {
    const engine = window.__engine;
    let points = null;
    engine.scene.traverse((object) => { if (object.name === 'nightlight-points') points = object; });
    return points.parent.userData.nightLights.debugOwner(parcelId);
  }, fixture.parcel.parcelId);

  const rebuilt = await page.evaluate((parcelId) => Boolean(window.__engine.village.rebuild(
    parcelId,
    { building: { windowHeightK: 1.17 } },
    { refreshFlora: false },
  )), fixture.parcel.parcelId);
  if (!rebuilt) throw new Error(`failed to rebuild regular fixture ${fixture.parcel.parcelId}`);
  await page.waitForTimeout(500);

  const rebuiltOwner = await page.evaluate((parcelId) => {
    const engine = window.__engine;
    engine.setTime('night', { immediate: true });
    engine.setSeason('autumn', { immediate: true });
    engine.setWeather('clear', { immediate: true });
    engine.debugTuneDof({ amount: 0 });
    engine.debugAdvancePost(2);
    engine.debugSetPaused(true);
    // Keep product canvas/layout unchanged while removing DOM chrome from the
    // review PNG. `visibility` avoids a reflow that could invalidate pixels.
    const canvas = engine.renderer.domElement;
    const keep = new Set();
    for (let current = canvas; current; current = current.parentElement) keep.add(current);
    for (const element of document.querySelectorAll('*')) {
      if (!keep.has(element)) element.style.setProperty('visibility', 'hidden', 'important');
    }
    const freezeCss = document.createElement('style');
    freezeCss.textContent = '* { animation: none !important; transition: none !important; }';
    document.head.appendChild(freezeCss);
    let points = null;
    engine.scene.traverse((object) => { if (object.name === 'nightlight-points') points = object; });
    const api = points.parent.userData.nightLights;
    return { owner: api.debugOwner(parcelId), resource: api.debugState() };
  }, fixture.parcel.parcelId);

  const pair = bestOpposedPair(rebuiltOwner.owner.selected);
  if (!pair) throw new Error(`${fixture.parcel.parcelId} lost its two-point nightlight fixture after rebuild`);
  const outward = horizontalUnit(pair.front);
  const target = {
    x: (pair.front.x + pair.rear.x) * 0.5,
    y: (pair.front.y + pair.rear.y) * 0.5,
    z: (pair.front.z + pair.rear.z) * 0.5,
  };
  const distance = 70;
  const cameraFrame = {
    position: [
      target.x + outward.x * distance,
      target.y + Math.tan(10 * Math.PI / 180) * distance,
      target.z + outward.z * distance,
    ],
    target: [target.x, target.y, target.z],
    fov: 28,
  };

  const framing = await page.evaluate(({ frame, front, rear }) => {
    const engine = window.__engine;
    engine.camera.position.fromArray(frame.position);
    engine.__controls.target.fromArray(frame.target);
    engine.camera.fov = frame.fov;
    engine.camera.updateProjectionMatrix();
    engine.camera.lookAt(engine.__controls.target);
    engine.debugSyncCameraEnvironment();
    engine.debugAdvanceFocusRing(0.3);
    engine.debugRenderDofFrame();
    const project = (anchor) => {
      const point = engine.camera.position.clone().set(anchor.x, anchor.y, anchor.z).project(engine.camera);
      return point.toArray();
    };
    return {
      camera: {
        position: engine.camera.position.toArray(),
        quaternion: engine.camera.quaternion.toArray(),
        fov: engine.camera.fov,
        projection: engine.camera.projectionMatrix.toArray(),
      },
      frontNdc: project(front),
      rearNdc: project(rear),
    };
  }, { frame: cameraFrame, front: pair.front, rear: pair.rear });

  async function capture(name, depthTest) {
    const state = await page.evaluate((enabled) => {
      const engine = window.__engine;
      let points = null;
      engine.scene.traverse((object) => { if (object.name === 'nightlight-points') points = object; });
      const api = points.parent.userData.nightLights;
      api.setDepthTestForTest(enabled);
      engine.debugRenderDofFrame();
      engine.debugRenderDofFrame();
      return {
        depthTest: api.debugState().depthTest,
        camera: {
          position: engine.camera.position.toArray(),
          quaternion: engine.camera.quaternion.toArray(),
          fov: engine.camera.fov,
          projection: engine.camera.projectionMatrix.toArray(),
        },
      };
    }, depthTest);
    const path = join(outDir, `${name}.png`);
    const buffer = await page.locator('canvas').screenshot({ path });
    return { path, buffer, state };
  }

  const frontFinal = await capture('front-final', true);
  const rearOn = await capture('rear-depth-on', true);
  const rearOff = await capture('rear-depth-off', false);
  await page.evaluate(() => {
    const engine = window.__engine;
    let points = null;
    engine.scene.traverse((object) => { if (object.name === 'nightlight-points') points = object; });
    points.parent.userData.nightLights.setDepthTestForTest(true);
    engine.debugRenderDofFrame();
  });

  const frontPixels = sampleWindow(frontFinal.buffer, framing.frontNdc);
  const rearPixels = difference(rearOn.buffer, rearOff.buffer, framing.rearNdc);
  const focusDelta = anchorDelta(baseOwner, focusedOwner);
  const rebuildDelta = anchorDelta(focusedOwner, rebuiltOwner.owner);
  const cameraStable = [frontFinal, rearOn, rearOff]
    .every((shot) => JSON.stringify(shot.state.camera) === JSON.stringify(framing.camera));
  const resource = rebuiltOwner.resource;
  const report = {
    seed: SEED,
    parcelId: fixture.parcel.parcelId,
    kind: fixture.parcel.kind,
    preferredP13: fixture.usedPreferredP13,
    opposedOutwardDot: pair.dot,
    openingIds: { front: pair.front.openingId, rear: pair.rear.openingId },
    camera: framing.camera,
    projected: { frontNdc: framing.frontNdc, rearNdc: framing.rearNdc },
    frontPixels,
    rearDepthDifference: rearPixels,
    ownerRefresh: {
      base: ownerSignature(baseOwner),
      focus: ownerSignature(focusedOwner),
      rebuild: ownerSignature(rebuiltOwner.owner),
      baseToFocus: focusDelta,
      focusToRebuild: rebuildDelta,
    },
    resource,
    captures: {
      frontFinal: frontFinal.path,
      rearDepthOn: rearOn.path,
      rearDepthOff: rearOff.path,
    },
    cameraStable,
    browserErrors: errors,
  };
  await writeFile(join(outDir, 'nightlights-report.json'), `${JSON.stringify(report, null, 2)}\n`);

  pass(fixture.usedPreferredP13 || /^p\d+$/.test(fixture.parcel.parcelId),
    'fixture is p13 or a stable regular parcel', fixture.parcel.parcelId);
  pass(pair.dot < 0.35, 'front/rear anchors face sufficiently different directions', pair.dot.toFixed(3));
  pass(framing.frontNdc[2] >= -1 && framing.frontNdc[2] <= 1
      && Math.abs(framing.frontNdc[0]) <= 1 && Math.abs(framing.frontNdc[1]) <= 1,
  'front authored opening is inside the final frame');
  pass(framing.rearNdc[2] >= -1 && framing.rearNdc[2] <= 1
      && Math.abs(framing.rearNdc[0]) <= 1 && Math.abs(framing.rearNdc[1]) <= 1,
  'rear authored opening is inside the A/B frame');
  pass(frontPixels.warmPixels > 0, 'front final contains warm pixels at its authored opening',
    `warm=${frontPixels.warmPixels} peak=${frontPixels.peak.x},${frontPixels.peak.y}`);
  pass(cameraStable && frontFinal.state.depthTest && rearOn.state.depthTest && !rearOff.state.depthTest,
    'front final and rear depth A/B preserve one camera and change only depthTest');
  pass(rearPixels.changedPixels > 4 && rearPixels.maxChannelDelta >= 8
      && rearPixels.signedBrightnessGain > 0,
  'depthTest hides the rear light behind opaque village surfaces',
  `center=${rearPixels.center.x},${rearPixels.center.y} changed=${rearPixels.changedPixels} maxΔ=${rearPixels.maxChannelDelta}`);
  pass(focusDelta?.matched > 0 && rebuildDelta?.matched > 0 && rebuildDelta.max > 0.005,
    'focus/rebuild refresh the same authored owner slot',
    `focus matched=${focusDelta?.matched || 0}, rebuild Δ=${rebuildDelta?.max?.toFixed(4) || 'n/a'}m`);
  pass(resource.drawCalls === 1 && resource.triangles === 0 && resource.lights === 0
      && resource.textures === 0 && resource.materials === 1 && resource.depthTest === true,
  'nightlight resource state remains one draw with zero lights/textures/triangles',
  `draw=${resource.drawCalls} light=${resource.lights} texture=${resource.textures} tri=${resource.triangles}`);
  pass(errors.length === 0, 'browser console remains clean', errors[0] || '');

  console.log(`PIXEL  front opening @ ${frontPixels.center.x},${frontPixels.center.y}; warm=${frontPixels.warmPixels}`);
  console.log(`PIXEL  rear opening @ ${rearPixels.center.x},${rearPixels.center.y}; peak=${JSON.stringify(rearPixels.peak)}`);
  console.log(`OWNER  ${JSON.stringify(report.ownerRefresh)}`);
  console.log(`RESOURCE draw=${resource.drawCalls} light=${resource.lights} texture=${resource.textures} tri=${resource.triangles}`);
  console.log(`VISUAL  ${frontFinal.path}`);
  console.log(`VISUAL  ${rearOn.path}`);
  console.log(`VISUAL  ${rearOff.path}`);
  console.log(`REPORT  ${join(outDir, 'nightlights-report.json')}`);

  if (failures.length || errors.length) {
    throw new Error(`NIGHTLIGHTS VISUAL: FAIL (${[...failures, ...errors].join('; ')})`);
  }
  console.log(`NIGHTLIGHTS VISUAL: PASS (${outDir})`);
} finally {
  await browser?.close();
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
}
