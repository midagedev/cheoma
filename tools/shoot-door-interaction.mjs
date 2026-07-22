// Product-app visual review for issue #16: one active primary leaf at closed,
// mid-swing, and open poses from deterministic inspection cameras. This harness
// uses the verification-only seek API; product focus framing and pointer input
// remain the responsibility of check-app-smoke.mjs.
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PNG } from 'pngjs';
import { createServer } from '../app/node_modules/vite/dist/node/index.js';
import { launchVerificationBrowser, reportWebGLRenderer } from './lib/verification-browser.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const APP_ROOT = join(ROOT, 'app');
const outDir = process.env.CHEOMA_DOOR_OUT
  || join(tmpdir(), `cheoma-door-${Date.now()}`);
const targetKind = ['giwa', 'choga', 'hero'].includes(process.env.CHEOMA_DOOR_TARGET)
  ? process.env.CHEOMA_DOOR_TARGET : 'giwa';
const captureTime = process.env.CHEOMA_DOOR_TIME || (targetKind === 'hero' ? 'day' : 'sunset');
await mkdir(outDir, { recursive: true });

const POSES = Object.freeze([
  ['closed', 0],
  ['mid', 0.5],
  ['open', 1],
]);
const PIXEL_DELTA = 24;

const invariant = (value, message) => {
  if (!value) throw new Error(`door visual gate: ${message}`);
};

function unionRect(rects) {
  const valid = rects.filter(Boolean);
  if (!valid.length) return null;
  return {
    minX: Math.min(...valid.map((rect) => rect.minX)),
    minY: Math.min(...valid.map((rect) => rect.minY)),
    maxX: Math.max(...valid.map((rect) => rect.maxX)),
    maxY: Math.max(...valid.map((rect) => rect.maxY)),
  };
}

function localRect(rect, clip, image, padding = 0) {
  return {
    minX: Math.max(0, Math.floor(rect.minX - clip.x - padding)),
    minY: Math.max(0, Math.floor(rect.minY - clip.y - padding)),
    maxX: Math.min(image.width, Math.ceil(rect.maxX - clip.x + padding)),
    maxY: Math.min(image.height, Math.ceil(rect.maxY - clip.y + padding)),
  };
}

function rectDrift(a, b) {
  return Math.max(
    Math.abs(a.minX - b.minX), Math.abs(a.minY - b.minY),
    Math.abs(a.maxX - b.maxX), Math.abs(a.maxY - b.maxY),
  );
}

function contains(rect, x, y) {
  return !rect || (x >= rect.minX && x < rect.maxX && y >= rect.minY && y < rect.maxY);
}

function luminance(data, offset) {
  return data[offset] * 0.2126 + data[offset + 1] * 0.7152 + data[offset + 2] * 0.0722;
}

function diffStats(first, second, include = null, exclude = null) {
  invariant(first.width === second.width && first.height === second.height,
    'capture dimensions changed between door poses');
  let pixels = 0;
  let changed = 0;
  let energy = 0;
  for (let y = 0; y < first.height; y++) for (let x = 0; x < first.width; x++) {
    if (!contains(include, x, y) || (exclude && contains(exclude, x, y))) continue;
    const offset = (y * first.width + x) * 4;
    const delta = Math.abs(first.data[offset] - second.data[offset])
      + Math.abs(first.data[offset + 1] - second.data[offset + 1])
      + Math.abs(first.data[offset + 2] - second.data[offset + 2]);
    pixels++;
    energy += delta;
    if (delta >= PIXEL_DELTA) changed++;
  }
  return {
    pixels,
    changed,
    ratio: pixels ? changed / pixels : 0,
    meanEnergy: pixels ? energy / pixels : 0,
  };
}

function recessStats(closed, open, rect) {
  let pixels = 0;
  let darkened = 0;
  let closedLuma = 0;
  let openLuma = 0;
  for (let y = rect.minY; y < rect.maxY; y++) for (let x = rect.minX; x < rect.maxX; x++) {
    const offset = (y * closed.width + x) * 4;
    const before = luminance(closed.data, offset);
    const after = luminance(open.data, offset);
    pixels++;
    if (before - after >= 18 && after <= 100 && after <= before * 0.82) {
      darkened++;
      closedLuma += before;
      openLuma += after;
    }
  }
  return {
    pixels,
    darkened,
    ratio: pixels ? darkened / pixels : 0,
    closedLuma: darkened ? closedLuma / darkened : 0,
    openLuma: darkened ? openLuma / darkened : 0,
  };
}

const pct = (value) => `${(value * 100).toFixed(2)}%`;

function sameProgramKeys(entries) {
  const first = JSON.stringify(entries[0].programKeys);
  return entries.every((entry) => JSON.stringify(entry.programKeys) === first);
}

const server = await createServer({
  root: APP_ROOT,
  configFile: join(APP_ROOT, 'vite.config.js'),
  cacheDir: join(outDir, '.vite-cache'),
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false },
});

let browser;
try {
  await server.listen();
  const port = server.httpServer.address().port;
  browser = await launchVerificationBrowser();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(
    `http://127.0.0.1:${port}/?hero=0&village=1&worker=0&seed=42&vseed=20260716&time=${captureTime}&lang=ko`,
    { waitUntil: 'domcontentloaded', timeout: 90_000 },
  );
  await page.waitForFunction(() => window.__SHOT_READY === true && !!window.__engine, null, { timeout: 90_000 });
  await reportWebGLRenderer(page, 'door-interaction');
  const candidates = await page.evaluate((kind) => {
    const engine = window.__engine;
    if (engine.debugDof().tweenProgress != null) engine.debugDofSeek(1, { finish: true });
    return engine.village.debugParcels()
      .filter((parcel) => kind === 'hero'
        ? parcel.hero && parcel.heroStyle === 'hanok'
        : !parcel.hero && parcel.kind === kind)
      .map((parcel) => parcel.parcelId);
  }, targetKind);
  let parcelId = null;
  let usedInspectionCamera = false;
  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index];
    await page.evaluate(({ id, first }) => {
      const engine = window.__engine;
      if (first) engine.village.focus(id);
      else engine.village.switchTo(id);
    }, { id: candidate, first: index === 0 });
    await page.waitForFunction((id) => {
      const engine = window.__engine;
      return engine.village.getState().selected === id
        && (!engine.village.getState().transitioning || engine.debugDof().tweenProgress != null);
    }, candidate, { timeout: 90_000 });
    await page.evaluate(() => {
      const engine = window.__engine;
      if (engine.debugDof().tweenProgress != null) engine.debugDofSeek(1, { finish: true });
    });
    await page.waitForFunction((id) => {
      const state = window.__engine.village.getState();
      return state.selected === id && !state.transitioning;
    }, candidate, { timeout: 90_000 });
    const target = await page.evaluate(() => ({
      frame: window.__engine.village.debugDoorFrame(),
      screen: window.__engine.village.debugDoorScreen(),
    }));
    // The authored compound approach stops outside its enclosing gate. The
    // hero visual gate therefore selects the semantic door here, then moves
    // inside the court only for deterministic material/recess inspection.
    if (targetKind === 'hero' && target.frame) {
      usedInspectionCamera = true;
      parcelId = candidate;
      break;
    }
    if (target.screen?.spanY >= 42 && target.screen?.spanX >= 18) {
      parcelId = candidate;
      break;
    }
  }
  if (!parcelId) throw new Error(`No visible ${targetKind} primary door among ${candidates.join(',')}`);
  await page.waitForTimeout(180);
  await page.mouse.move(1240, 40);
  await page.addStyleTag({ content: '.hlabel { display: none !important; }' });
  await page.evaluate(() => {
    const engine = window.__engine;
    engine.__controls.enableDamping = false;
    engine.__controls.update();
    engine.__controls.enabled = false;
    engine.camera.updateMatrixWorld(true);
    engine.debugSetPaused(true);
  });
  console.log(`door target=${targetKind} parcel=${parcelId} camera=court-inspection`
    + `${usedInspectionCamera ? '-override' : ''}`);
  const captures = new Map();
  const viewClips = new Map();
  const settleInspectionView = () => page.evaluate(() => new Promise((resolve) => {
    const engine = window.__engine;
    let remaining = 8;
    engine.debugSetPaused(false);
    const step = () => {
      remaining--;
      if (remaining <= 0) {
        engine.debugSetPaused(true);
        resolve();
      } else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }));
  await settleInspectionView();
  // Move inside the enclosing wall only after live LOD/ambience has settled.
  // No live frame runs from here to capture, so camera policy cannot normalize
  // this material/recess inspection back to the product focus distance.
  const frontInspection = targetKind === 'hero'
    ? { distance: 7.5, lateral: 0, height: 0.65 }
    : targetKind === 'giwa'
      ? { distance: 5.2, lateral: 0.25, height: 0.45 }
      : { distance: 6.5, lateral: 0.4, height: 0.65 };
  await page.evaluate(({ distance, lateral, height }) => {
    const engine = window.__engine;
    const frame = engine.village.debugDoorFrame();
    if (!frame) return;
    const [cx, cy, cz] = frame.center;
    const [rx, , rz] = frame.right;
    const [ox, , oz] = frame.outward;
    // Product focus may arrive with a strong telephoto projection. Inspection
    // uses a fixed moderate-wide lens so a camera inside a wall ring can still
    // retain the complete opening and some architectural context.
    engine.camera.fov = 45;
    engine.camera.zoom = 1;
    engine.camera.clearViewOffset();
    engine.camera.updateProjectionMatrix();
    engine.__controls.target.set(cx, cy, cz);
    engine.camera.position.set(
      cx + ox * distance + rx * lateral,
      cy + height,
      cz + oz * distance + rz * lateral,
    );
    engine.camera.lookAt(cx, cy, cz);
    engine.camera.updateMatrixWorld(true);
    engine.__controls.enabled = false;
    engine.debugRenderDofFrame();
  }, frontInspection);

  const capture = async (view, label, progress) => {
    await page.evaluate((value) => {
      const engine = window.__engine;
      engine.debugSetPaused(true);
      engine.village.debugSeekDoor(value);
      engine.debugRenderDofFrame();
    }, progress);
    const diagnostic = await page.evaluate(() => {
      const engine = window.__engine;
      const frame = engine.village.debugDoorFrame();
      const rect = engine.renderer.domElement.getBoundingClientRect();
      const root = engine.village.focusRoot();
      const anchor = root?.getObjectByName('primary-opening-anchor');
      const panel = root?.getObjectByName('primary-opening-panel');
      const plan = anchor?.userData?.openingDetailPlan;
      const state = engine.village.debugDoorInteraction();
      root?.updateWorldMatrix(true, true);
      const projected = frame
        ? engine.camera.position.clone().fromArray(frame.center).project(engine.camera)
        : null;
      const screenPoint = (point) => {
        const p = point.project(engine.camera);
        return {
          x: rect.left + (p.x + 1) * rect.width * 0.5,
          y: rect.top + (1 - p.y) * rect.height * 0.5,
        };
      };
      const screenRect = (points) => points.length ? {
        minX: Math.min(...points.map((point) => point.x)),
        minY: Math.min(...points.map((point) => point.y)),
        maxX: Math.max(...points.map((point) => point.x)),
        maxY: Math.max(...points.map((point) => point.y)),
      } : null;
      const anchorRect = (u0, u1, y0, y1, outward) => {
        if (!anchor) return null;
        return screenRect([
          [u0, y0], [u1, y0], [u1, y1], [u0, y1],
        ].map(([u, y]) => screenPoint(
          engine.camera.position.clone().set(u, y, outward).applyMatrix4(anchor.matrixWorld),
        )));
      };
      const panelPoints = [];
      const positions = panel?.geometry?.attributes?.position;
      if (positions) {
        panel.updateWorldMatrix(true, false);
        const point = engine.camera.position.clone();
        for (let index = 0; index < positions.count; index++) {
          point.fromBufferAttribute(positions, index).applyMatrix4(panel.matrixWorld);
          panelPoints.push(screenPoint(point.clone()));
        }
      }
      const outward = plan?.anchors?.pivot?.outward || 0;
      const leafWidth = state?.leafWidth || 0;
      const leafCenter = state?.panelCenterU || 0;
      const frameWidth = plan?.frame?.width || 0;
      const openingRect = plan ? anchorRect(
        -plan.width * 0.5,
        plan.width * 0.5,
        0,
        plan.height,
        outward,
      ) : null;
      const frameOuterRect = plan ? anchorRect(
        -plan.width * 0.5 - frameWidth,
        plan.width * 0.5 + frameWidth,
        -frameWidth,
        plan.height + frameWidth,
        outward,
      ) : null;
      const activeOpeningRect = plan ? anchorRect(
        leafCenter - leafWidth * 0.5,
        leafCenter + leafWidth * 0.5,
        0,
        plan.height,
        outward,
      ) : null;
      const panelRect = screenRect(panelPoints);
      return {
        state,
        screen: engine.village.debugDoorScreen(),
        anchorScreen: projected ? {
          x: rect.left + (projected.x + 1) * rect.width * 0.5,
          y: rect.top + (1 - projected.y) * rect.height * 0.5,
        } : null,
        openingRect,
        frameOuterRect,
        activeOpeningRect,
        panelRect,
      };
    });
    const { state, screen, anchorScreen } = diagnostic;
    if (!anchorScreen) throw new Error(`${view}-${label} door has no fixed opening frame`);
    invariant(diagnostic.openingRect && diagnostic.frameOuterRect
      && diagnostic.activeOpeningRect && diagnostic.panelRect,
    `${view}-${label} lost its projected opening/panel geometry`);
    invariant(Math.abs(state.progress - progress) <= 0.01,
      `${view}-${label} seek settled at ${state.progress.toFixed(4)} instead of ${progress}`);
    const targetScreen = screen || {
      x: (diagnostic.activeOpeningRect.minX + diagnostic.activeOpeningRect.maxX) * 0.5,
      y: (diagnostic.activeOpeningRect.minY + diagnostic.activeOpeningRect.maxY) * 0.5,
      spanX: diagnostic.activeOpeningRect.maxX - diagnostic.activeOpeningRect.minX,
      spanY: diagnostic.activeOpeningRect.maxY - diagnostic.activeOpeningRect.minY,
    };
    const path = join(outDir, `${view}-${label}.png`);
    const clip = viewClips.get(view) || {
      x: Math.max(0, Math.min(720, anchorScreen.x - 280)),
      y: Math.max(0, Math.min(320, anchorScreen.y - 240)),
      width: 560,
      height: 480,
    };
    viewClips.set(view, clip);
    const imageBuffer = await page.screenshot({ path, clip });

    // EffectComposer resets renderer.info for every pass, so its final counters
    // describe only the presentation triangle. Render the same frozen scene once
    // without post to measure the actual scene submission; the next composer frame
    // restores the captured product output before the repeat image is taken.
    const metrics = await page.evaluate(() => {
      const engine = window.__engine;
      const renderer = engine.renderer;
      renderer.render(engine.scene, engine.camera);
      return {
        calls: renderer.info.render.calls,
        triangles: renderer.info.render.triangles,
        programs: renderer.info.programs?.length || 0,
        programKeys: (renderer.info.programs || []).map((program) => String(program.cacheKey)).sort(),
        textures: renderer.info.memory.textures,
        geometries: renderer.info.memory.geometries,
      };
    });
    await page.evaluate((value) => {
      const engine = window.__engine;
      engine.village.debugSeekDoor(value);
      engine.debugRenderDofFrame();
    }, progress);
    const repeatBuffer = await page.screenshot({ clip });
    captures.set(`${view}:${label}`, {
      ...diagnostic,
      clip,
      image: PNG.sync.read(imageBuffer),
      repeat: PNG.sync.read(repeatBuffer),
      metrics,
      path,
    });
    console.log(`${view}-${label}: progress=${state.progress.toFixed(3)} angle=${(state.angle * 180 / Math.PI).toFixed(1)}° screen=${targetScreen.x.toFixed(1)},${targetScreen.y.toFixed(1)} span=${targetScreen.spanX.toFixed(1)}×${targetScreen.spanY.toFixed(1)} target=${screen ? 'input-visible' : 'diagnostic-only'} sceneCalls=${metrics.calls} sceneTriangles=${metrics.triangles} programs=${metrics.programs} textures=${metrics.textures} geometries=${metrics.geometries} ${path}`);
  };

  for (const [label, progress] of POSES) {
    await capture('front', label, progress);
  }

  const oblique = await page.evaluate((kind) => {
    const engine = window.__engine;
    engine.__controls.enabled = true;
    const frame = engine.village.debugDoorFrame();
    if (!frame) return null;
    const [cx, cy, cz] = frame.center;
    const [rx, , rz] = frame.right;
    const [ox, , oz] = frame.outward;
    const distances = kind === 'hero'
      ? [7.5, 6.5, 5.5, 4.5]
      : kind === 'giwa' ? [5.2, 6.5, 4.5] : [6.5, 7.5, 5.5];
    const laterals = kind === 'hero'
      ? [1.2, -1.2, 1.0, -1.0, 0.55, -0.55]
      : kind === 'giwa'
        ? [1.2, -1.2, 0.9, -0.9, 1.5, -1.5]
        : [2.3, -2.3, 1.8, -1.8, 2.8, -2.8, 1.2, -1.2];
    const heights = kind === 'hero' ? [0.65, 0.5, 0.8] : [0.8, 0.6, 1.0];
    for (const distance of distances) for (const lateral of laterals) for (const height of heights) {
      engine.__controls.target.set(cx, cy, cz);
      engine.camera.position.set(
        cx + ox * distance + rx * lateral,
        cy + height,
        cz + oz * distance + rz * lateral,
      );
      engine.camera.lookAt(cx, cy, cz);
      engine.camera.updateMatrixWorld(true);
      const root = engine.village.focusRoot();
      const anchor = root?.getObjectByName('primary-opening-anchor');
      const plan = anchor?.userData?.openingDetailPlan;
      root?.updateWorldMatrix(true, true);
      const frameWidth = plan?.frame?.width || 0;
      const outward = plan?.anchors?.pivot?.outward || 0;
      const projectedCorners = plan ? [
        [-plan.width * 0.5 - frameWidth, -frameWidth],
        [plan.width * 0.5 + frameWidth, -frameWidth],
        [plan.width * 0.5 + frameWidth, plan.height + frameWidth],
        [-plan.width * 0.5 - frameWidth, plan.height + frameWidth],
      ].map(([u, y]) => engine.camera.position.clone()
        .set(u, y, outward).applyMatrix4(anchor.matrixWorld).project(engine.camera)) : [];
      const minX = Math.min(...projectedCorners.map((point) => point.x));
      const maxX = Math.max(...projectedCorners.map((point) => point.x));
      const minY = Math.min(...projectedCorners.map((point) => point.y));
      const maxY = Math.max(...projectedCorners.map((point) => point.y));
      const widthPx = (maxX - minX) * 640;
      const heightPx = (maxY - minY) * 400;
      const valid = projectedCorners.length === 4
        && projectedCorners.every((point) => point.z <= 1)
        && minX >= -0.92 && maxX <= 0.92 && minY >= -0.92 && maxY <= 0.92
        && widthPx >= 48 && widthPx <= 420 && heightPx >= 72 && heightPx <= 380;
      if (valid) {
        engine.__controls.enabled = false;
        engine.camera.updateMatrixWorld(true);
        return { distance, lateral, height };
      }
    }
    engine.__controls.enabled = false;
    return null;
  }, targetKind);
  invariant(oblique, `no usable oblique inspection camera for ${targetKind}/${parcelId}`);
  await page.mouse.move(1240, 40);
  await page.evaluate(() => window.__engine.debugSetPaused(true));
  console.log(`oblique inspection distance=${oblique.distance} lateral=${oblique.lateral} height=${oblique.height}`);
  for (const [label, progress] of POSES) {
    await capture('oblique', label, progress);
  }

  for (const view of ['front', 'oblique']) {
    const entries = POSES.map(([label]) => captures.get(`${view}:${label}`));
    const first = entries[0];
    invariant(entries.every((entry) => (
      entry.clip.x === first.clip.x && entry.clip.y === first.clip.y
        && entry.clip.width === first.clip.width && entry.clip.height === first.clip.height
    )), `${view} capture clip moved between door poses`);
    const projectionDrifts = entries.map((entry) => ({
      opening: rectDrift(entry.openingRect, first.openingRect),
      frame: rectDrift(entry.frameOuterRect, first.frameOuterRect),
    }));
    invariant(projectionDrifts.every((entry) => entry.opening <= 0.75 && entry.frame <= 0.75),
      `${view} fixed opening/frame projection moved with the leaf: ${JSON.stringify(projectionDrifts)}`);

    const actionScreen = unionRect(entries.flatMap((entry) => [
      entry.activeOpeningRect,
      entry.panelRect,
    ]));
    const action = localRect(actionScreen, first.clip, first.image, 8);
    const frameOuter = localRect(first.frameOuterRect, first.clip, first.image, 2);
    const openingInner = localRect(first.openingRect, first.clip, first.image, -2);
    invariant(action.maxX > action.minX && action.maxY > action.minY,
      `${view} action ROI is empty`);
    invariant(diffStats(first.image, first.repeat, frameOuter, openingInner).pixels >= 64,
      `${view} fixed jamb/head ring is outside the capture`);
    for (const [index, entry] of entries.entries()) {
      const repeat = diffStats(entry.image, entry.repeat);
      invariant(repeat.changed === 0,
        `${view} ${POSES[index][0]} changed across identical frozen renders (${repeat.changed} pixels)`);
    }

    for (const [fromLabel, toLabel] of [['closed', 'mid'], ['mid', 'open']]) {
      const from = captures.get(`${view}:${fromLabel}`);
      const to = captures.get(`${view}:${toLabel}`);
      const actionChange = diffStats(from.repeat, to.image, action);
      const actionNoise = Math.max(
        diffStats(from.image, from.repeat, action).ratio,
        diffStats(to.image, to.repeat, action).ratio,
      );
      const outsideChange = diffStats(from.repeat, to.image, null, action);
      const outsideNoise = Math.max(
        diffStats(from.image, from.repeat, null, action).ratio,
        diffStats(to.image, to.repeat, null, action).ratio,
      );
      const frameChange = diffStats(from.repeat, to.image, frameOuter, openingInner);
      const frameNoise = Math.max(
        diffStats(from.image, from.repeat, frameOuter, openingInner).ratio,
        diffStats(to.image, to.repeat, frameOuter, openingInner).ratio,
      );
      invariant(actionChange.changed >= Math.max(64, actionChange.pixels * 0.004)
          && actionChange.ratio >= actionNoise * 1.35 + 0.002,
      `${view} ${fromLabel}→${toLabel} leaf has no rendered pixel motion `
        + `(${actionChange.changed}/${actionChange.pixels}, noise ${pct(actionNoise)})`);
      invariant(outsideChange.ratio <= Math.max(
        0.065,
        outsideNoise * 4 + 0.01,
        actionChange.ratio * 0.5,
      ) && actionChange.ratio >= outsideChange.ratio * 1.7 + 0.003,
      `${view} ${fromLabel}→${toLabel} changed the surrounding frame like camera motion `
        + `(action ${pct(actionChange.ratio)}, outside ${pct(outsideChange.ratio)}, noise ${pct(outsideNoise)})`);
      invariant(frameChange.ratio <= Math.max(0.18, frameNoise * 4 + 0.02),
        `${view} ${fromLabel}→${toLabel} moved the fixed jamb/head ring `
          + `(${pct(frameChange.ratio)}, noise ${pct(frameNoise)})`);
      console.log(`${view} ${fromLabel}→${toLabel}: action=${actionChange.changed}/${actionChange.pixels} `
        + `(${pct(actionChange.ratio)}) outside=${pct(outsideChange.ratio)} frame=${pct(frameChange.ratio)}`);
    }

    const closed = captures.get(`${view}:closed`);
    const open = captures.get(`${view}:open`);
    const recess = recessStats(closed.repeat, open.image, action);
    const recessNoise = Math.max(
      recessStats(closed.image, closed.repeat, action).darkened,
      recessStats(open.image, open.repeat, action).darkened,
    );
    invariant(recess.darkened >= Math.max(80, recess.pixels * 0.0025, recessNoise * 2 + 32)
        && recess.closedLuma - recess.openLuma >= 18,
    `${view} open pose exposes no stable dark aperture/recess `
      + `(${recess.darkened}/${recess.pixels}, luma ${recess.closedLuma.toFixed(1)}→${recess.openLuma.toFixed(1)}, noise ${recessNoise})`);
    console.log(`${view} recess: darkened=${recess.darkened}/${recess.pixels} `
      + `(${pct(recess.ratio)}) luma=${recess.closedLuma.toFixed(1)}→${recess.openLuma.toFixed(1)}`);

    const metrics = entries.map((entry) => entry.metrics);
    for (const key of ['calls', 'triangles', 'programs', 'textures', 'geometries']) {
      invariant(metrics.every((entry) => entry[key] === metrics[0][key]),
        `${view} door pose changed ${key}: ${metrics.map((entry) => entry[key]).join(' → ')}`);
    }
    invariant(metrics[0].calls > 0 && metrics[0].triangles > 0 && sameProgramKeys(metrics),
      `${view} scene submission/program cache did not plateau across poses`);
  }

  const plateau = await page.evaluate(() => {
    const engine = window.__engine;
    const renderer = engine.renderer;
    const samples = [];
    for (const progress of [0, 0.5, 1, 0.5, 0, 1, 0, 0.5, 1]) {
      engine.village.debugSeekDoor(progress);
      renderer.render(engine.scene, engine.camera);
      samples.push({
        calls: renderer.info.render.calls,
        triangles: renderer.info.render.triangles,
        programs: renderer.info.programs?.length || 0,
        programKeys: (renderer.info.programs || []).map((program) => String(program.cacheKey)).sort(),
        textures: renderer.info.memory.textures,
        geometries: renderer.info.memory.geometries,
      });
    }
    return samples;
  });
  for (const key of ['calls', 'triangles', 'programs', 'textures', 'geometries']) {
    invariant(plateau.every((sample) => sample[key] === plateau[0][key]),
      `repeated seek changed ${key}: ${plateau.map((sample) => sample[key]).join(' → ')}`);
  }
  invariant(sameProgramKeys(plateau), 'repeated seek changed the renderer program cache keys');
  console.log(`door plateau: ${plateau.length} seeks, calls=${plateau[0].calls}, `
    + `triangles=${plateau[0].triangles}, programs=${plateau[0].programs}, `
    + `textures=${plateau[0].textures}, geometries=${plateau[0].geometries}`);
  console.log(`DOOR CAPTURES: ${outDir}`);
} finally {
  await browser?.close();
  await server.close();
}
