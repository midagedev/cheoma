// Product-path gate for GitHub #22: title arrival and focused-house reroll use
// the same deterministic camera runtime, remain optically focused, and hand the
// exact live frame to OrbitControls on pointer/wheel/key interruption.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from '../app/node_modules/vite/dist/node/index.js';
import { launchVerificationBrowser, reportWebGLRenderer } from './lib/verification-browser.mjs';
import { countChangedPixels } from './lib/png-metrics.mjs';
import {
  VILLAGE_FOCUS_ELEVATION,
  VILLAGE_LENS,
  dollyScaleForFov,
  fovForDollyScale,
} from '../src/camera/optics.js';

const ROOT = resolve(import.meta.dirname, '..');
const APP_ROOT = join(ROOT, 'app');
const cacheDir = await mkdtemp(join(tmpdir(), 'cheoma-cinematic-cache-'));
const outputDir = await mkdtemp(join(tmpdir(), 'cheoma-cinematic-shots-'));
const timeout = Number(process.env.CHEOMA_CINEMATIC_TIMEOUT_MS) || 90_000;
const failures = [];
const invariant = (condition, message) => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${message}`);
  if (!condition) failures.push(message);
};
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const monotonic = (values, direction, epsilon = 1e-7) => values.every((value, index) => (
  index === 0 || direction * (value - values[index - 1]) >= -epsilon
));
const FOCUS_ELEVATION_DEG = VILLAGE_FOCUS_ELEVATION * 180 / Math.PI;

const server = await createServer({
  root: APP_ROOT,
  configFile: join(APP_ROOT, 'vite.config.js'),
  cacheDir,
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false },
});

let browser;
const runtimeErrors = [];
function wireErrors(page, label) {
  page.on('pageerror', (error) => runtimeErrors.push(`${label} page: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' && !/favicon|404/i.test(message.text())) {
      runtimeErrors.push(`${label} console: ${message.text()}`);
    }
  });
}

async function waitForDirectVillage(page, base) {
  await page.goto(`${base}/?hero=0&village=1&worker=0&vseed=20260716&time=sunset&lang=ko`, {
    waitUntil: 'domcontentloaded', timeout,
  });
  await page.waitForFunction(() => window.__SHOT_READY && window.__engine?.village?.debugPlan?.(), null, { timeout });
  await page.evaluate(() => {
    const engine = window.__engine;
    if (engine.debugDof().tweenProgress != null) engine.debugDofSeek(1, { finish: true });
  });
}

async function focusRegularHouse(page) {
  const id = await page.evaluate(() => {
    const engine = window.__engine;
    const parcel = engine.village.debugParcels().find((item) => item.editable && !item.hero && !['palace', 'temple'].includes(item.parcelId));
    if (!parcel) throw new Error('cinematic fixture has no editable regular house');
    engine.village.focus(parcel.parcelId);
    return parcel.parcelId;
  });
  await page.waitForFunction(() => window.__engine.debugDof().tweenProgress != null, null, { timeout });
  await page.evaluate(() => window.__engine.debugDofSeek(1, { finish: true }));
  await page.waitForFunction(() => window.__engine.village.getState().transitioning === false, null, { timeout });
  return id;
}

async function rerollFocusedDeterministically(page) {
  return page.evaluate(() => {
    const originalRandom = Math.random;
    Math.random = () => 0.3141592653589793;
    try {
      window.__engine.village.rerollParcel();
      return window.__engine.debugArchitecturalReveal()?.kind === 'rebuild';
    }
    finally { Math.random = originalRandom; }
  });
}

async function sampleSequence(page, prefix, points) {
  const frames = [];
  for (const [index, progress] of points.entries()) {
    const state = await page.evaluate(({ progress, finish }) => {
      const engine = window.__engine;
      const reveal = engine.debugArchitecturalRevealSeek(progress, { finish });
      if (window.__asm?.active) window.__asm.seek(progress);
      const optics = engine.debugSyncCameraEnvironment();
      const dof = engine.debugRenderDofFrame();
      return { ...reveal, optics, dof, programs: engine.renderer.info.programs?.length || 0 };
    }, { progress, finish: progress >= 1 });
    frames.push(state);
    await page.screenshot({ path: join(outputDir, `${prefix}-${index}-${String(progress).replace('.', '_')}.png`) });
  }
  return frames;
}

async function capturePointProjectionStats(page, prefix) {
  // Camera seeking freezes the separate village ink-fog reveal. Let the real loop
  // settle that veil before judging the 7° product frame or point projection.
  await page.evaluate(() => window.__engine.debugSetPaused(false));
  await page.waitForTimeout(1600);
  await page.evaluate(() => window.__engine.debugSetPaused(true));
  const stats = await page.evaluate(() => {
    const engine = window.__engine;
    const camera = engine.camera;
    const optics = engine.debugSyncCameraEnvironment();
    engine.scene.updateMatrixWorld(true);
    camera.updateMatrixWorld(true);

    const worldVisible = (object) => {
      for (let current = object; current; current = current.parent) {
        if (!current.visible) return false;
      }
      return true;
    };
    const summarize = (object, kind) => {
      const material = object.material;
      const uniforms = material?.uniforms || {};
      const position = object.geometry?.attributes?.position;
      const size = object.geometry?.attributes?.aSize;
      const rand = object.geometry?.attributes?.aRand;
      const scale = object.geometry?.attributes?.aScale;
      if (!position) return null;
      const lensScale = uniforms.uLensScale?.value ?? null;
      const pixelRatio = uniforms.uPixelRatio?.value ?? 1;
      const maxPx = kind === 'motes'
        ? 4 * pixelRatio
        : (uniforms.uMaxPx?.value ?? Infinity) * (kind === 'nightlights' ? pixelRatio : 1);
      const minPx = kind === 'motes'
        ? pixelRatio
        : (kind === 'nightlights' ? (uniforms.uMinPx?.value ?? 0) * pixelRatio : 0);
      let depthMin = Infinity, depthMax = -Infinity;
      let rawMin = Infinity, rawMax = -Infinity, pxMin = Infinity, pxMax = -Infinity;
      let clipped = 0, measured = 0;
      const point = object.position.clone();
      for (let index = 0; index < position.count; index++) {
        point.fromBufferAttribute(position, index);
        object.localToWorld(point);
        point.applyMatrix4(camera.matrixWorldInverse);
        const depth = -point.z;
        if (!(depth > 0)) continue;
        let raw;
        if (kind === 'snow' || kind === 'petals') {
          raw = size.getX(index) * uniforms.uScale.value * lensScale / Math.max(depth, 1);
        } else if (kind === 'motes') {
          raw = uniforms.uSize.value * rand.getW(index) * pixelRatio
            * (50 * lensScale / depth);
        } else {
          raw = uniforms.uSizeBase.value * scale.getX(index) * pixelRatio * lensScale / depth;
        }
        const px = Math.max(minPx, Math.min(maxPx, raw));
        depthMin = Math.min(depthMin, depth); depthMax = Math.max(depthMax, depth);
        rawMin = Math.min(rawMin, raw); rawMax = Math.max(rawMax, raw);
        pxMin = Math.min(pxMin, px); pxMax = Math.max(pxMax, px);
        if (raw >= maxPx) clipped++;
        measured++;
      }
      return {
        name: object.name, kind, visible: worldVisible(object), count: position.count, measured,
        lensScale, depthMin, depthMax, rawMin, rawMax, pxMin, pxMax, maxPx, clipped,
      };
    };
    const layers = [];
    engine.scene.traverse((object) => {
      const kind = object.name === 'weatherSnow' ? 'snow'
        : object.name === 'seasonPetals' ? 'petals'
          : object.name === 'dustMotes' ? 'motes'
            : object.name === 'nightlight-points' ? 'nightlights' : null;
      if (kind) layers.push(summarize(object, kind));
    });
    engine.debugRenderDofFrame();
    return {
      fov: camera.fov,
      referenceFov: camera.userData.villageReferenceFov,
      optics,
      layers: layers.filter(Boolean),
    };
  });
  await page.screenshot({ path: join(outputDir, `${prefix}-7deg-particles.png`) });
  return stats;
}

async function captureFocusVisibilityPair(page, parcelId, prefix) {
  const visibility = await page.evaluate((id) => window.__engine.village.debugFocusVisibility(id), parcelId);
  const apply = async (framing, suffix) => {
    await page.evaluate(({ frame }) => {
      const engine = window.__engine;
      engine.camera.position.fromArray(frame.position);
      engine.__controls.target.fromArray(frame.target);
      engine.camera.fov = frame.fov;
      engine.camera.userData.villageReferenceFov = frame.referenceFov;
      engine.camera.updateProjectionMatrix();
      engine.camera.lookAt(engine.__controls.target);
      engine.debugRenderDofFrame();
    }, { frame: framing });
    await page.screenshot({ path: join(outputDir, `${prefix}-visibility-${suffix}.png`) });
  };
  await apply(visibility.baseFraming, 'before');
  await apply(visibility.safeFraming, 'after');
  return visibility;
}

async function captureSettledFocusFrame(page, prefix) {
  // Camera seeks are deliberately renderer-free. Let the real view-shift runtime
  // consume the endpoint composition before measuring the product frame, while the
  // already-seeked building assembly remains frozen at its complete pose.
  const assemblyWasFrozen = await page.evaluate(() => {
    const wasFrozen = window.__asm?.frozen || false;
    if (window.__asm?.active) window.__asm.finish();
    window.__engine.debugSetPaused(false);
    return wasFrozen;
  });
  await page.evaluate(() => new Promise((resolveFrame) => requestAnimationFrame(() => (
    requestAnimationFrame(() => requestAnimationFrame(resolveFrame))
  ))));
  const result = await page.evaluate(async () => {
    const engine = window.__engine;
    engine.debugSetPaused(true);
    window.__asm?.seek(1);
    engine.debugRenderDofFrame();
    const id = engine.village.getState().selected;
    const visibility = engine.village.debugFocusVisibility(id);
    const bounds = visibility.subjectBounds;
    const camera = engine.camera;
    const threeUrl = performance.getEntriesByType('resource')
      .map((entry) => entry.name)
      .find((name) => /\/deps\/three\.js/.test(name));
    const THREE = await import(threeUrl);
    const detailRoot = engine.village.focusRoot();
    detailRoot?.updateWorldMatrix(true, true);
    const anchor = detailRoot?.getObjectByName('primary-opening-anchor');
    const opening = anchor?.userData?.openingDetailPlan;
    const blockerRoots = [];
    detailRoot?.traverse((object) => {
      if (object.name === 'fence' || object.name === 'soseuldaemun' || object.name === 'corridor') {
        blockerRoots.push(object);
      }
    });
    const semantic = opening ? [
      ['door', 0, opening.height * 0.55, 0.03],
      ['column-left', -opening.width * 0.62, opening.height * 0.55, 0.03],
      ['column-right', opening.width * 0.62, opening.height * 0.55, 0.03],
      ['lintel', 0, opening.height * 0.94, 0.03],
      ['eave', 0, opening.height + 0.42, 0.03],
    ] : [];
    const raycaster = new THREE.Raycaster();
    const rayBlocker = (point) => {
      const ray = point.clone().sub(camera.position);
      const distance = ray.length();
      raycaster.set(camera.position, ray.normalize());
      raycaster.near = 0.02;
      raycaster.far = distance - 0.04;
      const hit = raycaster.intersectObjects(blockerRoots, true)
        .find((entry) => entry.object.visible && entry.object.material?.visible !== false);
      if (!hit) return null;
      return blockerRoots.find((root) => root === hit.object || root.getObjectById(hit.object.id))?.name
        || hit.object.name || hit.object.type;
    };
    const rayVisible = (point) => !rayBlocker(point);
    const facade = semantic.map(([name, x, y, z]) => {
      const point = anchor.localToWorld(new THREE.Vector3(x, y, z));
      return { name, visible: rayVisible(point) };
    });
    const inFrame = (point) => {
      const projected = point.clone().project(camera);
      return Math.abs(projected.x) <= 1 && Math.abs(projected.y) <= 1
        && Math.abs(projected.z) <= 1;
    };
    const courtyard = detailRoot?.getObjectByName('courtyard-ground');
    const courtyardBox = courtyard ? new THREE.Box3().setFromObject(courtyard) : null;
    const courtyardSamples = [];
    if (courtyardBox) {
      const y = courtyardBox.max.y + 0.035;
      const x0 = THREE.MathUtils.lerp(courtyardBox.min.x, courtyardBox.max.x, 0.18);
      const x1 = THREE.MathUtils.lerp(courtyardBox.min.x, courtyardBox.max.x, 0.82);
      // The northern strip overlaps the main hall. Sample the open southern yard
      // where focus animals and household details are expected to remain readable.
      const z0 = THREE.MathUtils.lerp(courtyardBox.min.z, courtyardBox.max.z, 0.42);
      const z1 = THREE.MathUtils.lerp(courtyardBox.min.z, courtyardBox.max.z, 0.92);
      for (let iz = 0; iz < 4; iz++) for (let ix = 0; ix < 5; ix++) {
        const point = new THREE.Vector3(
          THREE.MathUtils.lerp(x0, x1, ix / 4),
          y,
          THREE.MathUtils.lerp(z0, z1, iz / 3),
        );
        const framed = inFrame(point);
        courtyardSamples.push({
          inFrame: framed,
          visible: framed && rayVisible(point),
          point: point.toArray().map((value) => +value.toFixed(2)),
        });
      }
    }
    const focusRing = engine.scene.children.find((child) => (
      child.name === 'focusRing' && child.userData?.parcelId === id && child.visible
    ));
    const animalGroup = focusRing?.getObjectByName('animals');
    const animals = (animalGroup?.children || [])
      .filter((animal) => animal.isGroup && animal.visible)
      .map((animal) => {
        const point = animal.getWorldPosition(new THREE.Vector3());
        point.y += animal.name === 'cow' ? 0.8 : 0.18;
        const framed = inFrame(point);
        const blocker = framed ? rayBlocker(point) : null;
        return {
          name: animal.name || 'chicken', inFrame: framed, visible: framed && !blocker, blocker,
          point: point.toArray().map((value) => +value.toFixed(2)),
        };
      });
    const yardDetails = [];
    detailRoot?.traverse((object) => {
      if (!['soseuldaemun', 'lantern-bulb'].includes(object.name) || !object.visible) return;
      const point = new THREE.Box3().setFromObject(object).getCenter(new THREE.Vector3());
      const framed = inFrame(point);
      yardDetails.push({
        name: object.name,
        inFrame: framed,
        // The gate is itself one of the blocker roots; lanterns must additionally
        // retain a clear camera ray through the compound wall/corridor geometry.
        visible: framed && (object.name === 'soseuldaemun' || !rayBlocker(point)),
      });
    });
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const x of [bounds.min[0], bounds.max[0]]) {
      for (const y of [bounds.min[1], bounds.max[1]]) {
        for (const z of [bounds.min[2], bounds.max[2]]) {
          const point = camera.position.clone().set(x, y, z).project(camera);
          minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x);
          minY = Math.min(minY, point.y); maxY = Math.max(maxY, point.y);
        }
      }
    }
    const target = engine.__controls.target.clone().project(camera);
    const focusPlan = engine.village.debugParcels()
      .find((parcel) => parcel.parcelId === id);
    const forwardY = engine.__controls.target.clone().sub(camera.position).normalize().y;
    return {
      parcelId: id,
      left: (minX + 1) * 0.5,
      right: (maxX + 1) * 0.5,
      top: (1 - maxY) * 0.5,
      bottom: (1 - minY) * 0.5,
      height: (maxY - minY) * 0.5,
      targetY: (1 - target.y) * 0.5,
      cameraY: camera.position.y,
      cameraPosition: camera.position.toArray(),
      cameraFov: camera.fov,
      cameraReferenceFov: camera.userData.villageReferenceFov,
      targetWorld: engine.__controls.target.toArray(),
      targetWorldY: engine.__controls.target.y,
      targetLift: focusPlan?.focusTargetLift ?? null,
      forwardY,
      composition: window.__viewshift?.compositionYFrac ?? null,
      facade,
      facadeVisible: facade.filter((sample) => sample.visible).length,
      courtyardInFrame: courtyardSamples.filter((sample) => sample.inFrame).length,
      courtyardVisible: courtyardSamples.filter((sample) => sample.visible).length,
      courtyardSamples: courtyardSamples.length,
      courtyardVisiblePoints: courtyardSamples.filter((sample) => sample.visible)
        .map((sample) => sample.point),
      animals,
      animalsInFrame: animals.filter((animal) => animal.inFrame).length,
      animalsVisible: animals.filter((animal) => animal.visible).length,
      yardDetails,
      yardDetailsInFrame: yardDetails.filter((detail) => detail.inFrame).length,
      yardDetailsVisible: yardDetails.filter((detail) => detail.visible).length,
    };
  });
  await page.screenshot({ path: join(outputDir, `${prefix}-settled-frame.png`) });
  await page.evaluate((wasFrozen) => window.__asm?.freeze(wasFrozen), assemblyWasFrozen);
  return result;
}

async function captureAnimalPixelDelta(page, parcelId, prefix) {
  // Let the real focus-ring fade reach its settled product weight, then freeze every
  // animation and toggle only this parcel's animal group. A non-zero canvas delta is
  // stronger evidence than projection alone: animals behind an opaque corridor do not pass.
  await page.evaluate(async () => {
    window.__engine.debugSetPaused(true);
    window.__engine.debugAdvanceFocusRing(3.2);
    await new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)));
    window.__engine.debugRenderDofFrame();
  });
  const state = await page.evaluate((id) => {
    const engine = window.__engine;
    const ring = engine.scene.children.find((child) => (
      child.name === 'focusRing' && child.userData?.parcelId === id && child.visible
    ));
    const animals = ring?.getObjectByName('animals');
    const opacities = [];
    animals?.traverse((object) => {
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) if (material) opacities.push(material.opacity);
    });
    return {
      strength: window.__hero?.focusStrength ?? null,
      visible: animals?.visible ?? false,
      opacityMin: opacities.length ? Math.min(...opacities) : null,
      opacityMax: opacities.length ? Math.max(...opacities) : null,
    };
  }, parcelId);
  const onUrl = await page.evaluate(() => {
    window.__engine.debugRenderDofFrame();
    return window.__engine.renderer.domElement.toDataURL('image/png');
  });
  const on = Buffer.from(onUrl.split(',')[1], 'base64');
  await writeFile(join(outputDir, `${prefix}-animals-on.png`), on);
  const offResult = await page.evaluate((id) => {
    const engine = window.__engine;
    const ring = engine.scene.children.find((child) => (
      child.name === 'focusRing' && child.userData?.parcelId === id && child.visible
    ));
    const animals = ring?.getObjectByName('animals');
    if (!animals) return { toggled: false, dataUrl: null };
    animals.visible = false;
    engine.debugRenderDofFrame();
    return { toggled: true, dataUrl: engine.renderer.domElement.toDataURL('image/png') };
  }, parcelId);
  const off = Buffer.from(offResult.dataUrl.split(',')[1], 'base64');
  await writeFile(join(outputDir, `${prefix}-animals-off.png`), off);
  await page.evaluate((id) => {
    const engine = window.__engine;
    const ring = engine.scene.children.find((child) => (
      child.name === 'focusRing' && child.userData?.parcelId === id
    ));
    const animals = ring?.getObjectByName('animals');
    if (animals) animals.visible = true;
    engine.debugRenderDofFrame();
  }, parcelId);
  return { toggled: offResult.toggled, changed: countChangedPixels(on, off), ...state };
}

function assertReadableHouseFrame(focusFrame, label, { minHeight = 0.19 } = {}) {
  invariant(focusFrame.bottom <= 0.84,
    `${label} keeps the selected roof/wall volume clear of the bottom crop (${(focusFrame.bottom * 100).toFixed(1)}%)`);
  invariant(focusFrame.top >= 0.12,
    `${label} keeps the selected roof clear of the top crop (${(focusFrame.top * 100).toFixed(1)}%)`);
  invariant(focusFrame.height >= minHeight,
    `${label} keeps the building large enough to read (${(focusFrame.height * 100).toFixed(1)}% of frame height)`);
  invariant(focusFrame.left >= 0.04 && focusFrame.right <= 0.96,
    `${label} keeps the selected building inside both side edges (${(focusFrame.left * 100).toFixed(1)}–${(focusFrame.right * 100).toFixed(1)}%)`);
  invariant(focusFrame.targetLift >= 1.65 && focusFrame.targetLift <= 2.5,
    `${label} aims at the restored door-height band (${focusFrame.targetLift}m)`);
  const elevation = Math.asin(-focusFrame.forwardY) * 180 / Math.PI;
  invariant(Math.abs(elevation - FOCUS_ELEVATION_DEG) < 0.02,
    `${label} keeps the shared ${FOCUS_ELEVATION_DEG.toFixed(0)}-degree courtyard elevation (${elevation.toFixed(2)}°)`);
  invariant(Math.abs(focusFrame.composition) < 1e-6,
    `${label} keeps a centered projection instead of cropping the courtyard for sky`);
  invariant(focusFrame.facadeVisible === 5,
    `${label} leaves every door/facade landmark unobstructed by its own wall, gate, and corridors (${focusFrame.facadeVisible}/5)`);
  invariant(focusFrame.courtyardInFrame === focusFrame.courtyardSamples
      && focusFrame.courtyardVisible >= 4,
  `${label} retains the sampled open courtyard in frame and across its wall/gate (${focusFrame.courtyardVisible}/${focusFrame.courtyardSamples} ray-visible)`);
  invariant(focusFrame.animalsInFrame >= 5 && focusFrame.animalsVisible >= 2,
    `${label} retains focus animals in frame (${focusFrame.animalsInFrame}; ${focusFrame.animalsVisible} currently clear the compound wall/corridor ray)`);
  invariant(focusFrame.yardDetailsInFrame >= 3 && focusFrame.yardDetailsVisible >= 2,
    `${label} retains the gate and ray-visible lantern details (${focusFrame.yardDetailsVisible}/${focusFrame.yardDetailsInFrame})`);
}

try {
  await server.listen();
  const base = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await launchVerificationBrowser();

  // Initial title → village hero arrival: real Hero button and engine path.
  const arrivalPage = await browser.newPage({ viewport: { width: 1360, height: 850 }, deviceScaleFactor: 1 });
  wireErrors(arrivalPage, 'arrival');
  await arrivalPage.goto(`${base}/?worker=0&vseed=20260716&time=sunset&lang=ko`, {
    waitUntil: 'domcontentloaded', timeout,
  });
  await arrivalPage.waitForSelector('button.hero', { timeout });
  await arrivalPage.click('button.hero');
  await arrivalPage.waitForFunction(() => window.__engine?.debugArchitecturalReveal?.().kind === 'arrival', null, { timeout });
  await arrivalPage.evaluate(() => window.__engine.debugSetPaused(true));
  await reportWebGLRenderer(arrivalPage, 'cinematic-arrival');
  const arrival = await sampleSequence(arrivalPage, 'arrival', [0, 0.28, 0.56, 0.82, 1]);
  const arrivalStart = arrival[0], arrivalEnd = arrival.at(-1);
  invariant(arrivalStart.kind === 'arrival' && arrivalStart.motion === 'full', 'initial Hero action starts the desktop arrival profile');
  invariant(
    dist(arrivalStart.start.position, arrivalStart.start.target)
      > dist(arrivalStart.end.position, arrivalStart.end.target) * 1.5,
    'initial arrival travels from an establishing frame into the close architectural frame',
  );
  invariant(arrivalStart.start.fov > arrivalStart.end.fov && arrivalEnd.fov === arrivalEnd.end.fov,
    'initial arrival lands wide-to-telephoto on the authored lens');
  const arrivalFovs = arrival.map((state) => state.fov);
  const arrivalReferenceFovs = arrival.map((state) => state.referenceFov);
  const arrivalLensScales = arrival.map((state) => state.optics.lensScale);
  const arrivalOccupancy = arrival.map((state) => 1 / (
    state.optics.visualDistance * Math.tan(state.referenceFov * Math.PI / 360)
  ));
  console.log(`ARRIVAL OPTICS: ${JSON.stringify(arrival.map((state, index) => ({
    progress: [0, 0.28, 0.56, 0.82, 1][index],
    fov: +state.fov.toFixed(3),
    referenceFov: +state.referenceFov.toFixed(3),
    physicalDistance: +state.optics.physicalDistance.toFixed(3),
    visualDistance: +state.optics.visualDistance.toFixed(3),
    lensScale: +state.optics.lensScale.toFixed(3),
    occupancy: +arrivalOccupancy[index].toFixed(6),
  })))}`);
  invariant(monotonic(arrivalFovs, -1) && monotonic(arrivalReferenceFovs, -1),
    'arrival narrows actual and reference FOV monotonically');
  invariant(monotonic(arrivalLensScales, 1)
      && arrival.every((state) => Math.abs(state.optics.lensScale
        - dollyScaleForFov(state.referenceFov, state.fov)) < 1e-6),
  'arrival increases compensated optical compression with the authored lens scale');
  invariant(monotonic(arrivalOccupancy, 1),
    'arrival grows the selected architecture monotonically while the lens compresses');
  invariant(arrival.every((state) => state.lookErrorDeg < 1e-4), 'arrival calls lookAt on every sampled live frame');
  invariant(arrival.every((state) => state.dof.error == null || state.dof.error < 0.04), 'arrival keeps DoF on the moving architectural target');
  invariant(dist(arrivalEnd.position, arrivalEnd.end.position) < 1e-6 && dist(arrivalEnd.target, arrivalEnd.end.target) < 1e-6,
    'arrival finishes on the exact target and camera endpoint');
  invariant(Math.max(...arrival.map((state) => state.programs)) - Math.min(...arrival.map((state) => state.programs)) <= 8,
    'camera-only arrival does not grow shader programs while seeking');
  const heroFrame = await captureSettledFocusFrame(arrivalPage, 'arrival');
  console.log(`HERO FRAME: ${JSON.stringify(heroFrame)}`);
  assertReadableHouseFrame(heroFrame, 'default hero arrival', { minHeight: 0.24 });
  const pointProjection = await capturePointProjectionStats(arrivalPage, 'arrival');
  console.log(`HERO POINT PROJECTION: ${JSON.stringify(pointProjection)}`);
  invariant(Math.abs(pointProjection.fov - VILLAGE_LENS.hero.fov) < 1e-9
      && pointProjection.layers.length >= 4,
  '7-degree hero frame exposes weather, petal, mote, and practical-light point tiers');
  invariant(pointProjection.layers.every((layer) => (
    Math.abs(layer.lensScale - pointProjection.optics.lensScale) < 1e-6
      && layer.pxMax <= layer.maxPx + 1e-6
  )), '7-degree point tiers consume the full optical scale while preserving their pixel caps');
  const heroAnimalPixels = await captureAnimalPixelDelta(arrivalPage, heroFrame.parcelId, 'arrival');
  console.log(`HERO ANIMAL PIXELS: ${JSON.stringify(heroAnimalPixels)}`);
  invariant(heroAnimalPixels.toggled && heroAnimalPixels.changed >= 100,
    `default hero arrival focus animals make a real local pixel contribution (${heroAnimalPixels.changed} changed pixels)`);
  const heroVisibility = await arrivalPage.evaluate(() => {
    const engine = window.__engine;
    return engine.village.debugFocusVisibility(engine.village.getState().selected);
  });
  console.log(`HERO VISIBILITY: ${Math.round(heroVisibility.baseVisibleRatio * 100)}% -> ${Math.round(heroVisibility.visibleRatio * 100)}% (azimuth ${((heroVisibility.baseAzimuth || 0) * 180 / Math.PI).toFixed(1)}° -> ${((heroVisibility.azimuth || 0) * 180 / Math.PI).toFixed(1)}°, scale ${heroVisibility.scale})`);
  invariant(heroVisibility.visibleRatio >= heroVisibility.baseVisibleRatio,
    'hero safe endpoint never reduces sampled selected-compound visibility');
  invariant(heroVisibility.visibleRatio >= 1 / 9 - 1e-9,
    'hero final keeps the compound gate and central roof band visible');
  const selectedHeroCandidate = heroVisibility.candidates.find((candidate) => (
    Math.abs(candidate.azimuth - heroVisibility.azimuth) < 1e-9
      && Math.abs(candidate.scale - heroVisibility.scale) < 1e-9
  ));
  invariant(selectedHeroCandidate && !selectedHeroCandidate.cameraBlocked,
    'hero safe endpoint never places the camera inside a neighbouring house proxy');
  const actualHeroCameraCollision = await arrivalPage.evaluate(() => {
    const engine = window.__engine;
    const selected = engine.village.getState().selected;
    const camera = engine.camera.position;
    const inside = [];
    for (const parcel of engine.village.debugParcels()) {
      if (parcel.parcelId === selected) continue;
      const bounds = engine.village.debugFocusVisibility(parcel.parcelId)?.subjectBounds;
      if (!bounds) continue;
      if (camera.x >= bounds.min[0] && camera.x <= bounds.max[0]
        && camera.y >= bounds.min[1] && camera.y <= bounds.max[1]
        && camera.z >= bounds.min[2] && camera.z <= bounds.max[2]) {
        inside.push(parcel.parcelId);
      }
    }
    return inside;
  });
  invariant(actualHeroCameraCollision.length === 0,
    'actual 7-degree arrival endpoint stays outside every neighbouring house volume');
  const xzDirection = (position, target) => {
    const x = position[0] - target[0], z = position[2] - target[2];
    const length = Math.hypot(x, z);
    return [x / length, z / length];
  };
  const arrivedDirection = xzDirection(
    [arrivalEnd.position.x, arrivalEnd.position.y, arrivalEnd.position.z],
    [arrivalEnd.target.x, arrivalEnd.target.y, arrivalEnd.target.z],
  );
  const safeDirection = xzDirection(
    heroVisibility.safeFraming.position,
    heroVisibility.safeFraming.target,
  );
  invariant(arrivedDirection[0] * safeDirection[0] + arrivedDirection[1] * safeDirection[1]
      > 1 - 1e-9,
  'hero arrival consumes the safe endpoint azimuth instead of rebuilding the authored base ray');
  const expectedArrivalFov = fovForDollyScale(
    VILLAGE_LENS.hero.fov,
    heroVisibility.scale,
  );
  const expectedArrivalReferenceFov = fovForDollyScale(
    VILLAGE_LENS.hero.referenceFov,
    heroVisibility.scale,
  );
  invariant(Math.abs(heroFrame.cameraFov - expectedArrivalFov) < 1e-9
      && Math.abs(heroFrame.cameraReferenceFov - expectedArrivalReferenceFov) < 1e-9,
  `hero arrival retains the safe endpoint scale through its compensating lens (${heroVisibility.scale}, ${heroFrame.cameraFov.toFixed(2)}°)`);
  await arrivalPage.close();

  // Focused-house reroll: real public product command, deterministic seeks and PNGs.
  const rebuildPage = await browser.newPage({ viewport: { width: 1360, height: 850 }, deviceScaleFactor: 1 });
  wireErrors(rebuildPage, 'rebuild');
  await waitForDirectVillage(rebuildPage, base);
  const toggledHeroId = await rebuildPage.evaluate(() => {
    const engine = window.__engine;
    const id = engine.village.heroId();
    engine.village.focusHero();
    return id;
  });
  await rebuildPage.waitForFunction(() => window.__engine.debugDof().tweenProgress != null, null, { timeout });
  await rebuildPage.evaluate(() => window.__engine.debugDofSeek(1, { finish: true }));
  await rebuildPage.waitForFunction(() => window.__engine.village.getState().transitioning === false, null, { timeout });
  const toggledHeroFrame = await captureSettledFocusFrame(rebuildPage, 'focus-hero-toggle');
  console.log(`HERO TOGGLE FRAME: ${JSON.stringify(toggledHeroFrame)}`);
  invariant(toggledHeroFrame.parcelId === toggledHeroId,
    'the public house-view toggle focuses the planned village head house');
  assertReadableHouseFrame(toggledHeroFrame, 'house-view hero focus');
  const toggledHeroAnimalPixels = await captureAnimalPixelDelta(
    rebuildPage, toggledHeroFrame.parcelId, 'focus-hero-toggle',
  );
  console.log(`HERO TOGGLE ANIMAL PIXELS: ${JSON.stringify(toggledHeroAnimalPixels)}`);
  invariant(toggledHeroAnimalPixels.toggled && toggledHeroAnimalPixels.changed >= 100,
    `house-view hero focus animals make a real local pixel contribution (${toggledHeroAnimalPixels.changed} changed pixels)`);
  await rebuildPage.evaluate(() => {
    const engine = window.__engine;
    engine.debugSetPaused(false);
    engine.village.return();
  });
  await rebuildPage.waitForFunction(() => window.__engine.debugDof().tweenProgress != null, null, { timeout });
  await rebuildPage.evaluate(() => window.__engine.debugDofSeek(1, { finish: true }));
  await rebuildPage.waitForFunction(() => window.__engine.village.getState().transitioning === false, null, { timeout });
  const parcelId = await focusRegularHouse(rebuildPage);
  await rebuildPage.evaluate(() => window.__engine.debugSetPaused(true));
  invariant(await rerollFocusedDeterministically(rebuildPage), 'deterministic fixture executes the real focused-house reroll command');
  const rebuild = await sampleSequence(rebuildPage, 'rebuild', [0, 0.25, 0.5, 0.75, 1]);
  const rebuildStart = rebuild[0], rebuildMid = rebuild[2], rebuildEnd = rebuild.at(-1);
  invariant(rebuildStart.kind === 'rebuild' && rebuildStart.motion === 'full', 'focused-house action starts the desktop rebuild profile');
  invariant(dist(rebuildStart.position, rebuildStart.start.position) < 1e-6, 'reroll path begins on the exact previously presented camera frame');
  invariant(dist(rebuildMid.position, rebuildStart.position) > 0.4, 'reroll has a visible restrained camera arc instead of a stationary assembly');
  invariant(rebuild.every((state) => state.lookErrorDeg < 1e-4), 'reroll calls lookAt on every sampled live frame');
  invariant(rebuild.every((state) => state.dof.error == null || state.dof.error < 0.04), 'reroll updates DoF focus with its moving target');
  invariant(dist(rebuildEnd.position, rebuildEnd.end.position) < 1e-6 && dist(rebuildEnd.target, rebuildEnd.end.target) < 1e-6,
    'reroll finishes on the rebuilt parcel framing without a handoff snap');
  invariant(rebuildEnd.controlsEnabled && rebuildEnd.reason === 'complete', 'natural completion returns enabled OrbitControls');
  invariant(rebuildEnd.programs - rebuildStart.programs <= 8, 'camera arc itself adds no persistent shader-program family');
  const rebuildVisibility = await captureFocusVisibilityPair(rebuildPage, parcelId, 'rebuild');
  console.log(`FOCUS VISIBILITY ${parcelId}: ${Math.round(rebuildVisibility.baseVisibleRatio * 100)}% -> ${Math.round(rebuildVisibility.visibleRatio * 100)}% (azimuth ${((rebuildVisibility.baseAzimuth || 0) * 180 / Math.PI).toFixed(1)}° -> ${((rebuildVisibility.azimuth || 0) * 180 / Math.PI).toFixed(1)}°, base blockers ${rebuildVisibility.baseBlockers.join(',') || 'none'})`);
  console.log(`FOCUS CANDIDATES ${parcelId}: ${JSON.stringify(rebuildVisibility.candidates)}`);
  console.log(`FOCUS GEOMETRY ${parcelId}: ${JSON.stringify({ subjectBounds: rebuildVisibility.subjectBounds, blockerBounds: rebuildVisibility.blockerBounds, baseFraming: rebuildVisibility.baseFraming })}`);
  invariant(rebuildVisibility.visibleRatio >= rebuildVisibility.baseVisibleRatio,
    'safe reroll endpoint never reduces sampled selected-house visibility');
  invariant(rebuildVisibility.visibleRatio >= 1 / 3 - 1e-9,
    'safe reroll endpoint keeps the selected roof/eave band visible');
  if (rebuildVisibility.baseOcclusionRatio > 1 / 9) {
    invariant(rebuildVisibility.visibleRatio >= rebuildVisibility.baseVisibleRatio + 1 / 9 - 1e-9,
      'occluded authored endpoint improves by at least one deterministic bounding sample');
  }
  const selectedVisibilityCandidate = rebuildVisibility.candidates.find((candidate) => (
    Math.abs(candidate.azimuth - rebuildVisibility.azimuth) < 1e-9
      && Math.abs(candidate.scale - rebuildVisibility.scale) < 1e-9
  ));
  invariant(selectedVisibilityCandidate && !selectedVisibilityCandidate.cameraBlocked,
    'safe endpoint never places the camera inside a neighbouring house proxy');
  invariant(rebuildVisibility.safeFraming.position[1] >= rebuildVisibility.safeFraming.target[1],
    'safe endpoint preserves the authored elevated camera side of the door-height target');
  invariant(Math.abs(rebuildVisibility.azimuth) <= 14 * Math.PI / 180 + 1e-9,
    'safe endpoint remains inside the south-facing solar-opening angle');
  invariant(rebuildVisibility.safeFraming.fov <= 26,
    'safe endpoint remains on the residential telephoto lens');
  invariant(
    dist(rebuildEnd.end.position, {
      x: rebuildVisibility.safeFraming.position[0],
      y: rebuildVisibility.safeFraming.position[1],
      z: rebuildVisibility.safeFraming.position[2],
    }) < 1e-6,
    'ordinary click focus and cinematic final share the same authoritative safe framing',
  );
  await rebuildPage.evaluate(() => window.__engine.debugSetPaused(false));
  await rebuildPage.waitForFunction(() => window.__engine.village.getState().transitioning === false, null, { timeout });

  // Pointer and key preserve the exact live frame. Wheel restores the focus zoom
  // regime in capture phase, so the same gesture that cancels the reveal also
  // reaches OrbitControls and changes distance instead of being discarded.
  const canvasBox = await rebuildPage.locator('canvas').boundingBox();
  if (!canvasBox) throw new Error('cinematic canvas has no bounding box');
  const canvasPoint = {
    x: canvasBox.x + canvasBox.width * 0.72,
    y: canvasBox.y + canvasBox.height * 0.52,
  };
  for (const eventType of ['pointer', 'wheel', 'key']) {
    await rebuildPage.evaluate(() => window.__engine.debugSetPaused(true));
    await rerollFocusedDeterministically(rebuildPage);
    const before = await rebuildPage.evaluate(() => {
      const engine = window.__engine;
      engine.debugArchitecturalRevealSeek(0.37);
      return engine.debugArchitecturalReveal();
    });
    if (eventType === 'pointer') {
      await rebuildPage.mouse.move(canvasPoint.x, canvasPoint.y);
      await rebuildPage.mouse.down();
    } else if (eventType === 'wheel') {
      await rebuildPage.mouse.move(canvasPoint.x, canvasPoint.y);
      await rebuildPage.mouse.wheel(0, 240);
    } else {
      await rebuildPage.keyboard.press('x');
    }
    const after = await rebuildPage.evaluate(() => window.__engine.debugArchitecturalReveal());
    if (eventType === 'pointer') await rebuildPage.mouse.up();
    invariant(!after.active && after.reason === 'input' && after.controlsEnabled,
      `${eventType} input immediately interrupts and enables OrbitControls (${JSON.stringify({ active: after.active, reason: after.reason, enabled: after.controlsEnabled })})`);
    if (eventType === 'wheel') {
      const beforeDistance = dist(before.position, before.target);
      const afterDistance = dist(after.position, after.target);
      invariant(after.controlsZoomEnabled,
        'wheel interruption synchronously restores the focused OrbitControls zoom regime');
      invariant(Math.abs(afterDistance - beforeDistance) > 0.05,
        `the interrupting wheel gesture performs a real dolly (${beforeDistance.toFixed(3)} -> ${afterDistance.toFixed(3)})`);
      invariant(dist(before.target, after.target) < 1e-8,
        'wheel handoff preserves the live architectural target while dollying');
    } else {
      invariant(dist(before.position, after.position) < 1e-8 && dist(before.target, after.target) < 1e-8,
        `${eventType} handoff preserves the exact camera and target frame`);
    }
    invariant(after.lookErrorDeg < 1e-4, `${eventType} handoff preserves the lookAt direction`);
    await rebuildPage.evaluate(() => window.__engine.debugSetPaused(false));
    await rebuildPage.waitForFunction(() => window.__engine.village.getState().transitioning === false, null, { timeout });
  }
  invariant(await rebuildPage.evaluate((id) => window.__engine.village.getState().selected === id, parcelId),
    'camera interruption does not lose focused parcel ownership');
  await rebuildPage.close();

  // Reduced motion is a real immediate endpoint, including the explicit duration override.
  const reducedPage = await browser.newPage({ viewport: { width: 1024, height: 720 }, reducedMotion: 'reduce' });
  wireErrors(reducedPage, 'reduced');
  await waitForDirectVillage(reducedPage, base);
  await focusRegularHouse(reducedPage);
  await rerollFocusedDeterministically(reducedPage);
  const reduced = await reducedPage.evaluate(() => {
    const engine = window.__engine;
    engine.debugRenderDofFrame();
    return engine.debugArchitecturalReveal();
  });
  invariant(!reduced.active && reduced.motion === 'reduced' && reduced.duration === 0 && reduced.reason === 'complete',
    'prefers-reduced-motion resolves the reroll directly to its endpoint');
  invariant(dist(reduced.position, reduced.end.position) < 1e-6 && dist(reduced.target, reduced.end.target) < 1e-6,
    'reduced-motion endpoint is exact');
  invariant(reduced.lookErrorDeg < 1e-4 && (reduced.dof.error == null || reduced.dof.error < 0.04),
    'reduced-motion endpoint keeps lookAt and DoF coherent');
  await reducedPage.close();

  // Phone/perf profile keeps choreography but selects the compact path.
  const mobilePage = await browser.newPage({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 1,
    isMobile: true, hasTouch: true,
  });
  wireErrors(mobilePage, 'mobile');
  await waitForDirectVillage(mobilePage, base);
  await focusRegularHouse(mobilePage);
  await rerollFocusedDeterministically(mobilePage);
  const mobile = await mobilePage.evaluate(() => {
    const engine = window.__engine;
    engine.debugSetPaused(true);
    const state = engine.debugArchitecturalRevealSeek(0.5);
    if (window.__asm?.active) window.__asm.seek(0.5);
    engine.debugRenderDofFrame();
    return state;
  });
  invariant(mobile.active && mobile.motion === 'compact', 'phone/perf path selects compact camera motion');
  invariant(mobile.lookErrorDeg < 1e-4
      && (!mobile.dof.enabled || mobile.dof.error == null || mobile.dof.error < 0.04),
  'compact phone frame keeps lookAt coherent and respects the mobile DoF-off policy');
  await mobilePage.screenshot({ path: join(outputDir, 'rebuild-mobile-mid.png') });
  await mobilePage.close();
} finally {
  await browser?.close().catch(() => {});
  await server.close().catch(() => {});
  await rm(cacheDir, { recursive: true, force: true });
}

console.log(`CINEMATIC SHOTS: ${outputDir}`);
if (runtimeErrors.length) {
  for (const error of runtimeErrors) console.error(`ERROR ${error}`);
  failures.push(`${runtimeErrors.length} browser runtime error(s)`);
}
if (failures.length) {
  console.error(`CINEMATIC REVEAL APP: FAIL (${failures.length})`);
  process.exitCode = 1;
} else {
  console.log('CINEMATIC REVEAL APP: PASS');
}
