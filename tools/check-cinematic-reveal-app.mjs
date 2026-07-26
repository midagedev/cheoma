// Product-path gate for GitHub #22: title arrival and focused-house reroll use
// the same deterministic camera runtime, remain optically focused, and hand the
// exact live frame to OrbitControls on pointer/wheel/key interruption.
//
// The close-frame section below was re-authored on 2026-07-25 (see
// docs/look-restoration-plan.md "1-0 충돌 2"). Its previous form asserted one shared 24°
// courtyard elevation, SKY_FRACTION == 0 for every close frame, and readability by
// high-angle projection. docs/look-audit-2026-07.md R1 judged that survey frame to be the
// reason the flagship backlit rim and bokeh cannot appear at all, so the following intent is
// now the authored one:
//
//   1. The hero landing owns its own elevation (VILLAGE_HERO_FOCUS_ELEVATION) and its own
//      centered projection. It arrives on a compound whose wings and courtyard only read from
//      above, so it is asserted against that constant rather than against the residential pose.
//   2. The residential close frame is eye-level (VILLAGE_FOCUS_ELEVATION, 7–12°) and is
//      allowed — required — to shift the lens for sky (VILLAGE_FOCUS_SKY_FRACTION > 0). The
//      assertion is that the frame's top ray actually clears the horizon, because a rim only
//      exists where a silhouette edge stands against sky.
//   3. Courtyard and yard-life readability remain a goal, but they are no longer bought with
//      elevation. They are asserted as "reachable from this azimuth and distance": the samples
//      that are in frame must be ray-clear over the wall/gate, and the yard must occupy a real
//      share of the frame. A frame that simply crops the yard away still fails.
//   4. The capital/7 terrain cutaway fixture (TERRAIN_FIXTURE) and the mobile palace/temple fits are
//      unchanged; they are lens-agnostic and are read from VILLAGE_LENS.
//
// The arrival establishing assertion was re-authored on 2026-07-25 (docs/look-restoration-plan.md
// Phase 2-3, docs/look-audit-2026-07.md R6). Its previous form demanded the establishing camera
// stand at least 1.5× the landing's *world distance* from the subject. Against a lens-compensated
// destination that is a look-breaking demand, not a cinematic one: the 7° hero landing already
// stands ~5.6 subject widths out, so 1.5× more put the camera 262m from a 30m compound — beyond
// the entry veil's own far plane, which is keyed to the site radius. The subject rendered as 100%
// fog for the first five seconds of the product's signature clip and the entire assembly played
// inside an opaque wash. What "establishing" actually claims is a *wider frame*, so the assertion
// is now made on screen occupancy, which the reveal already reports and which is strictly harder to
// satisfy by accident than a distance ratio.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from '../app/node_modules/vite/dist/node/index.js';
import { launchVerificationBrowser, reportWebGLRenderer } from './lib/verification-browser.mjs';
import { countChangedPixels } from './lib/png-metrics.mjs';
import {
  VILLAGE_FOCUS_ELEVATION,
  VILLAGE_FOCUS_SKY_FRACTION,
  VILLAGE_HERO_FOCUS_ELEVATION,
  VILLAGE_LENS,
  dollyScaleForFov,
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
const HERO_ELEVATION_DEG = VILLAGE_HERO_FOCUS_ELEVATION * 180 / Math.PI;
// The eye-level band the restored residential frame must stay inside. Narrower than the
// authored constant's exact value on purpose: this is the look requirement (architectural
// eye level, not a survey), and a future retune inside the band should not need a gate edit.
const RESIDENTIAL_ELEVATION_BAND = Object.freeze({ min: 7, max: 12 });

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
  // Normal motion exposes an inspectable tween that the deterministic harness
  // seeks to its endpoint. Reduced motion intentionally completes on the first
  // rendered frame, so the tween may already be retired before Playwright can
  // observe it. Accept that settled product state without waiting for a debug
  // object that is no longer supposed to exist.
  await page.waitForFunction((parcelId) => {
    const engine = window.__engine;
    const state = engine.village.getState();
    return engine.debugDof().tweenProgress != null
      || (state.selected === parcelId && state.transitioning === false);
  }, id, { timeout });
  await page.evaluate(() => {
    const engine = window.__engine;
    if (engine.debugDof().tweenProgress != null) engine.debugDofSeek(1, { finish: true });
  });
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

async function capturePhysicalDetailStats(page, prefix) {
  // Camera seeking freezes the separate village ink-fog reveal. Let the real loop
  // settle that veil before judging the 7° product frame or physical detail tiers.
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
      if (!position) return null;
      const openingSize = object.geometry?.attributes?.aOpeningSize;
      let openingMax = 0;
      if (openingSize) {
        for (let index = 0; index < openingSize.count; index++) {
          openingMax = Math.max(openingMax, openingSize.getX(index), openingSize.getY(index));
        }
      }
      const authoredSize = kind === 'snow' || kind === 'petals'
        ? [uniforms.uWorldScale?.value ?? 0]
        : kind === 'motes'
          ? [uniforms.uDustRadius?.value ?? 0, uniforms.uFireflyRadius?.value ?? 0]
          : [openingMax];
      const instances = object.geometry?.instanceCount || object.count || 1;
      const baseTriangles = object.geometry?.index
        ? object.geometry.index.count / 3
        : position.count / 3;
      return {
        name: object.name,
        kind,
        visible: worldVisible(object),
        isMesh: object.isMesh === true,
        instances,
        triangles: baseTriangles * instances,
        authoredSize,
        hasPointSizeUniform: !!(
          uniforms.uPixelRatio || uniforms.uSize || uniforms.uSizeBase || uniforms.uMaxPx
        ),
      };
    };
    const layers = [];
    engine.scene.traverse((object) => {
      const kind = object.name === 'weatherSnowPhysical' ? 'snow'
        : object.name === 'seasonPetalsWorld' ? 'petals'
          : object.name === 'dustMotes' ? 'motes'
            : object.name === 'nightlight-physical' ? 'nightlights' : null;
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
    // Unproject the live frame edges instead of re-deriving elevation ± half-FOV ± shift.
    // The view-shift runtime writes its composition into camera.setViewOffset, so the real
    // projection matrix already carries it and these rays are exactly what the frame shows.
    const frameRayY = (ndcY) => new THREE.Vector3(0, ndcY, 0.5)
      .unproject(camera).sub(camera.position).normalize().y;
    const topRayY = frameRayY(1);
    const bottomRayY = frameRayY(-1);
    // How much of the frame height the selected parcel's own yard plane occupies. Lets the
    // readability assertion say "the yard is really in this picture" without requiring the
    // high-angle projection that killed the rim.
    let yardTop = Infinity, yardBottom = -Infinity;
    if (courtyardBox) {
      for (const cx of [courtyardBox.min.x, courtyardBox.max.x]) {
        for (const cz of [courtyardBox.min.z, courtyardBox.max.z]) {
          const projected = new THREE.Vector3(cx, courtyardBox.max.y + 0.035, cz).project(camera);
          yardTop = Math.min(yardTop, (1 - projected.y) * 0.5);
          yardBottom = Math.max(yardBottom, (1 - projected.y) * 0.5);
        }
      }
    }
    return {
      parcelId: id,
      topRayY,
      bottomRayY,
      topRayDeg: Math.asin(Math.max(-1, Math.min(1, topRayY))) * 180 / Math.PI,
      yardFrameHeight: Number.isFinite(yardTop) && Number.isFinite(yardBottom)
        ? yardBottom - yardTop : null,
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

async function captureUiSafeSemanticFrame(page, parcelId, prefix) {
  await page.evaluate((id) => {
    const engine = window.__engine;
    window.__viewshift?.setEnabled(true);
    const selected = engine.village.getState().selected;
    if (selected !== id) {
      if (selected) engine.village.switchTo(id);
      else engine.village.focus(id);
    }
  }, parcelId);
  await page.waitForFunction((id) => {
    const state = window.__engine.village.getState();
    return state.selected === id && !state.transitioning;
  }, parcelId, { timeout });
  await page.evaluate(() => {
    const engine = window.__engine;
    engine.debugDofSeek(1, { finish: true });
  });
  await page.waitForFunction(() => {
    const shift = window.__viewshift;
    return !window.__engine.village.getState().transitioning
      && shift?.safeRect?.usable
      && shift.fit?.fitted
      && !shift.fit?.overflow
      && Math.abs(shift.x - shift.tx) < 0.25
      && Math.abs(shift.y - shift.ty) < 0.25;
  }, null, { timeout });
  const result = await page.evaluate((id) => {
    const engine = window.__engine;
    const subject = engine.village.debugFocusVisibility(id).focusSubject;
    const points = [];
    const add = (footprint, y) => {
      for (const point of footprint || []) points.push({ x: point.x, y, z: point.z });
    };
    add(subject.representative.footprint, subject.representative.minY);
    add(subject.representative.footprint, subject.representative.maxY);
    if (subject.courtyard) add(subject.courtyard.footprint, subject.courtyard.y);
    for (const anchor of subject.anchors || []) if (anchor.point) points.push(anchor.point);
    const box = { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity };
    for (const point of points) {
      const projected = engine.camera.position.clone().set(point.x, point.y, point.z).project(engine.camera);
      const x = (projected.x + 1) * innerWidth * 0.5;
      const y = (1 - projected.y) * innerHeight * 0.5;
      box.left = Math.min(box.left, x);
      box.right = Math.max(box.right, x);
      box.top = Math.min(box.top, y);
      box.bottom = Math.max(box.bottom, y);
    }
    return {
      box,
      safe: window.__viewshift.safeRect,
      fit: window.__viewshift.fit,
      fov: engine.camera.fov,
      target: engine.__controls.target.toArray(),
    };
  }, parcelId);
  await page.screenshot({ path: join(outputDir, `${prefix}.png`) });
  return result;
}

function assertUiSafeSemanticFrame(frame, label) {
  invariant(frame.safe?.usable
      && frame.fit?.fitted
      && !frame.fit?.overflow
      && frame.box.left >= frame.safe.left - 1
      && frame.box.right <= frame.safe.right + 1
      && frame.box.top >= frame.safe.top - 1
      && frame.box.bottom <= frame.safe.bottom + 1,
  `${label} keeps representative architecture and its courtyard inside the live UI-safe viewport (${JSON.stringify(frame)})`);
}

// `pose` selects which authored close frame this label is: the hero compound landing, or the
// shared residential eye-level pose. They are deliberately independent — see the file header.
function assertReadableHouseFrame(focusFrame, label, { minHeight = 0.19, pose = 'residential' } = {}) {
  const hero = pose === 'hero';
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
  if (hero) {
    // The landing beat reads its own constant. Asserting the residential elevation here is what
    // made the two intents mutually exclusive.
    invariant(Math.abs(elevation - HERO_ELEVATION_DEG) < 0.02,
      `${label} keeps its own authored ${HERO_ELEVATION_DEG.toFixed(0)}-degree landing elevation (${elevation.toFixed(2)}°)`);
    invariant(Math.abs(focusFrame.composition) < 1e-6,
      `${label} keeps the centered compound projection its courtyard framing depends on (${focusFrame.composition})`);
  } else {
    invariant(elevation >= RESIDENTIAL_ELEVATION_BAND.min
        && elevation <= RESIDENTIAL_ELEVATION_BAND.max,
    `${label} stays in the architectural eye-level band `
      + `${RESIDENTIAL_ELEVATION_BAND.min}–${RESIDENTIAL_ELEVATION_BAND.max}° (${elevation.toFixed(2)}°)`);
    invariant(VILLAGE_FOCUS_SKY_FRACTION > 0
        && focusFrame.composition < 0
        && Math.abs(focusFrame.composition) <= VILLAGE_FOCUS_SKY_FRACTION + 1e-6,
    `${label} shifts the lens up to leave room above the eave instead of centering the plan `
      + `(${focusFrame.composition} of ${-VILLAGE_FOCUS_SKY_FRACTION})`);
    // The point of the eye-level restoration: the frame must actually contain sky direction, or
    // the eave silhouette has nothing to stand against and the backlit rim cannot read.
    invariant(focusFrame.topRayY > 0,
      `${label} raises the top frame ray above the horizon (${focusFrame.topRayDeg.toFixed(2)}°)`);
    invariant(focusFrame.bottomRayY < 0,
      `${label} still looks down into the near yard at its bottom edge (${focusFrame.bottomRayY.toFixed(4)})`);
  }
  invariant(focusFrame.facadeVisible === 5,
    `${label} leaves every door/facade landmark unobstructed by its own wall, gate, and corridors (${focusFrame.facadeVisible}/5)`);
  // Yard readability, re-authored: from an eye-level azimuth a wall legitimately hides part of a
  // flat yard sample grid, so requiring all 20 samples in frame is a disguised elevation demand.
  // What must hold is that the yard is genuinely in this picture (a real share of frame height,
  // a substantial part of the grid framed) and that what is framed is ray-clear over wall/gate.
  const courtyardFramedRatio = focusFrame.courtyardSamples > 0
    ? focusFrame.courtyardInFrame / focusFrame.courtyardSamples : 0;
  invariant(hero
    ? (focusFrame.courtyardInFrame === focusFrame.courtyardSamples
      && focusFrame.courtyardVisible >= 4)
    : (courtyardFramedRatio >= 0.4 && focusFrame.courtyardVisible >= 3),
  `${label} keeps the sampled open courtyard in frame and ray-clear across its wall/gate `
    + `(${focusFrame.courtyardInFrame}/${focusFrame.courtyardSamples} framed, ${focusFrame.courtyardVisible} ray-visible)`);
  invariant(focusFrame.yardFrameHeight == null || focusFrame.yardFrameHeight >= 0.08,
    `${label} gives the yard plane a readable share of frame height `
      + `(${((focusFrame.yardFrameHeight ?? 0) * 100).toFixed(1)}%)`);
  invariant(hero
    ? (focusFrame.animalsInFrame >= 5 && focusFrame.animalsVisible >= 2)
    : (focusFrame.animalsInFrame >= 2 && focusFrame.animalsVisible >= 1),
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
  // The entry veil's fog is written by the animation loop and `debugSetPaused(true)` freezes that
  // loop, so a fog value read after the pause depends on how many frames ran between the landing
  // starting and Playwright's pause command arriving. Under machine load that gap exceeded the
  // veil's whole 8.7s ramp, so the read landed on the *cleared* fog (measured: near 2.2R / far 7.0R
  // with R=128, i.e. the camera inside `near`, factor clamped to 0.000) and the assertion reported a
  // washed-out product state that never existed — the product veil is dense from its first frame
  // (near = depth * clearMargin ≈ 68.8m, far ≈ 273.6m, factor 0.206). Record the first veiled frame
  // in-page instead: it is the densest by construction, because `hold` keeps the ramp flat across
  // its first half, and an in-page recorder cannot be outrun by harness round trips.
  await arrivalPage.evaluate(() => {
    window.__veilOpening = null;
    const step = () => {
      // `e > 0` matters: startVillageReveal() arms the state synchronously, and this recorder's rAF
      // can run before the engine's own loop callback has written the veil's first fog values — that
      // frame still reports the base fog reapplyVillageFog() left behind. Require that the veil has
      // actually advanced once, which is still inside the flat `hold` half, so still the densest.
      if (!window.__veilOpening && window.__hero?.reveal?.e > 0 && window.__hero.fogNear != null) {
        window.__veilOpening = {
          near: window.__hero.fogNear,
          far: window.__hero.fogFar,
          e: window.__hero.reveal.e,
          dur: window.__hero.reveal.dur,
        };
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
  await arrivalPage.click('button.hero');
  await arrivalPage.waitForFunction(() => window.__engine?.debugArchitecturalReveal?.().kind === 'arrival', null, { timeout });
  await arrivalPage.evaluate(() => window.__engine.debugSetPaused(true));
  await reportWebGLRenderer(arrivalPage, 'cinematic-arrival');
  const arrival = await sampleSequence(arrivalPage, 'arrival', [0, 0.28, 0.56, 0.82, 1]);
  const arrivalStart = arrival[0], arrivalEnd = arrival.at(-1);
  invariant(arrivalStart.kind === 'arrival' && arrivalStart.motion === 'full', 'initial Hero action starts the desktop arrival profile');
  invariant(arrivalStart.start.fov > arrivalStart.end.fov && arrivalEnd.fov === arrivalEnd.end.fov,
    'initial arrival lands wide-to-telephoto on the authored lens');
  const arrivalFovs = arrival.map((state) => state.fov);
  const arrivalReferenceFovs = arrival.map((state) => state.referenceFov);
  const arrivalLensScales = arrival.map((state) => state.optics.lensScale);
  const arrivalOccupancy = arrival.map((state) => 1 / (
    state.optics.visualDistance * Math.tan(state.referenceFov * Math.PI / 360)
  ));
  // Establishing = a materially wider frame on the subject, measured the same way as the growth
  // assertion below. See the header note: the previous world-distance form of this invariant is what
  // pushed the establishing camera past the entry veil.
  invariant(arrivalOccupancy.at(-1) > arrivalOccupancy[0] * 2.5,
    'initial arrival establishes a frame at least 2.5x wider than the close architectural frame '
    + `(occupancy ${arrivalOccupancy[0].toFixed(5)} -> ${arrivalOccupancy.at(-1).toFixed(5)})`);
  // The arc must also sit in the readable part of the entry veil (R6). Two-sided on purpose: too
  // much and the reveal plays behind an opaque wash (the regression), too little and the frame loses
  // the warm aerial perspective that carries the golden hour and reads dark and flat instead. The arc
  // retreats monotonically from a closer, lower establishing frame to the landing, so the landing
  // depth is the worst case; the page is paused on the reveal's opening frame, so the fog read here
  // is the veil at its densest.
  const arrivalVeil = arrival.map((state) => Math.hypot(
    state.position.x - state.target.x,
    state.position.y - state.target.y,
    state.position.z - state.target.z,
  ));
  // Densest veil = the recorded opening frame (see the recorder above). The live fog is kept as a
  // fallback only for the case where no veiled frame was ever observed, which is itself a failure.
  const arrivalFog = await arrivalPage.evaluate(() => (window.__veilOpening || {
    near: window.__hero?.fogNear ?? null,
    far: window.__hero?.fogFar ?? null,
    e: null,
    dur: null,
    recorded: false,
  }));
  const veilAt = (depth) => (arrivalFog.near == null ? null : Math.max(0, Math.min(1,
    (depth - arrivalFog.near) / (arrivalFog.far - arrivalFog.near))));
  // The paused frame is the reveal's opening one, so the establishing depth and the densest fog do
  // co-occur — this is the actual first second of the product's signature clip.
  const openingVeil = veilAt(arrivalVeil[0]);
  // The landing depth never meets the densest veil (the veil opens as the arc retreats), so this is a
  // loose worst case. It exists only to fail the regression class, where the subject was fully washed.
  const worstVeil = veilAt(Math.max(...arrivalVeil));
  console.log(`ARRIVAL VEIL: depths ${arrivalVeil.map((d) => d.toFixed(1)).join(' -> ')} `
    + `vs fog ${JSON.stringify(arrivalFog)} -> opening ${openingVeil?.toFixed(3)}, worst ${worstVeil?.toFixed(3)}`);
  invariant(openingVeil != null && openingVeil > 0.05 && openingVeil < 0.35,
    'densest entry veil hazes the establishing frame without washing it out '
    + `(fog factor ${openingVeil?.toFixed(3)} at ${arrivalVeil[0].toFixed(1)}m)`);
  invariant(worstVeil < 0.7,
    'no arrival frame can be swallowed by the densest entry veil '
    + `(fog factor ${worstVeil?.toFixed(3)} at ${Math.max(...arrivalVeil).toFixed(1)}m)`);
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
  assertReadableHouseFrame(heroFrame, 'default hero arrival', { minHeight: 0.24, pose: 'hero' });
  const physicalDetail = await capturePhysicalDetailStats(arrivalPage, 'arrival');
  console.log(`HERO PHYSICAL DETAIL: ${JSON.stringify(physicalDetail)}`);
  invariant(Math.abs(physicalDetail.fov - VILLAGE_LENS.hero.fov) < 1e-9
      && physicalDetail.layers.length >= 4,
  '7-degree hero frame exposes weather, petal, mote, and practical-light physical tiers');
  invariant(physicalDetail.layers.every((layer) => (
    layer.isMesh
      && layer.triangles > 0
      && !layer.hasPointSizeUniform
      && layer.authoredSize.every((value) => Number.isFinite(value) && value > 0)
  )), 'physical detail tiers keep authored world dimensions and need no point-size pixel caps');
  const heroAnimalPixels = await captureAnimalPixelDelta(arrivalPage, heroFrame.parcelId, 'arrival');
  console.log(`HERO ANIMAL PIXELS: ${JSON.stringify(heroAnimalPixels)}`);
  invariant(heroAnimalPixels.toggled && heroAnimalPixels.changed >= 100,
    `default hero arrival focus animals make a real local pixel contribution (${heroAnimalPixels.changed} changed pixels)`);
  const heroVisibility = await arrivalPage.evaluate(() => {
    const engine = window.__engine;
    const visibility = engine.village.debugFocusVisibility(engine.village.getState().selected);
    return visibility.hero || visibility;
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
  invariant(Math.abs(heroFrame.cameraFov - heroVisibility.safeFraming.fov) < 1e-9
      && Math.abs(heroFrame.cameraReferenceFov - heroVisibility.safeFraming.referenceFov) < 1e-9
      && heroVisibility.safeFraming.referenceFov === VILLAGE_LENS.hero.referenceFov,
  `hero arrival consumes its separately solved frame and fixed reference lens (${heroVisibility.scale}, ${heroFrame.cameraFov.toFixed(2)}°)`);
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
  // An ordinary house has no compound gate/corridor fixtures, so its close frame is asserted on
  // the pose itself: eye level, an upward lens shift, and a top ray that really clears the
  // horizon. This is the frame the flagship rim and bokeh are authored for (re-authored 2026-07-25,
  // docs/look-restoration-plan.md "1-0 충돌 2" item 2).
  const residentialPose = await rebuildPage.evaluate(async (id) => {
    const engine = window.__engine;
    engine.debugRenderDofFrame();
    const camera = engine.camera;
    const threeUrl = performance.getEntriesByType('resource').map((entry) => entry.name)
      .find((name) => /\/deps\/three\.js/.test(name));
    const THREE = await import(threeUrl);
    const forward = engine.__controls.target.clone().sub(camera.position).normalize();
    const rayY = (ndcY) => new THREE.Vector3(0, ndcY, 0.5)
      .unproject(camera).sub(camera.position).normalize().y;
    const bounds = engine.village.debugFocusVisibility(id)?.subjectBounds;
    let top = Infinity, bottom = -Infinity;
    if (bounds) {
      for (const x of [bounds.min[0], bounds.max[0]]) {
        for (const y of [bounds.min[1], bounds.max[1]]) {
          for (const z of [bounds.min[2], bounds.max[2]]) {
            const projected = new THREE.Vector3(x, y, z).project(camera);
            top = Math.min(top, (1 - projected.y) * 0.5);
            bottom = Math.max(bottom, (1 - projected.y) * 0.5);
          }
        }
      }
    }
    return {
      parcelId: id,
      elevationDeg: Math.asin(-forward.y) * 180 / Math.PI,
      composition: window.__viewshift?.compositionYFrac ?? null,
      topRayY: rayY(1),
      bottomRayY: rayY(-1),
      fov: camera.fov,
      referenceFov: camera.userData.villageReferenceFov,
      subjectTop: top,
      subjectBottom: bottom,
    };
  }, parcelId);
  console.log(`RESIDENTIAL POSE: ${JSON.stringify(residentialPose)}`);
  invariant(residentialPose.elevationDeg >= RESIDENTIAL_ELEVATION_BAND.min
      && residentialPose.elevationDeg <= RESIDENTIAL_ELEVATION_BAND.max,
  `ordinary house focus stays in the architectural eye-level band `
    + `${RESIDENTIAL_ELEVATION_BAND.min}–${RESIDENTIAL_ELEVATION_BAND.max}° `
    + `(${residentialPose.elevationDeg.toFixed(2)}°)`);
  invariant(VILLAGE_FOCUS_SKY_FRACTION > 0
      && residentialPose.composition < 0
      && Math.abs(residentialPose.composition) <= VILLAGE_FOCUS_SKY_FRACTION + 1e-6,
  `ordinary house focus shifts the lens up for sky above the eave (${residentialPose.composition})`);
  invariant(residentialPose.topRayY > 0 && residentialPose.bottomRayY < 0,
    `ordinary house focus frames sky above the eave and yard below it `
      + `(top ${residentialPose.topRayY.toFixed(4)}, bottom ${residentialPose.bottomRayY.toFixed(4)})`);
  invariant(residentialPose.referenceFov === VILLAGE_LENS.parcel.referenceFov
      && residentialPose.subjectTop > 0 && residentialPose.subjectBottom < 1,
  `ordinary house focus keeps the whole subject inside its authored residential lens `
    + `(${residentialPose.fov.toFixed(2)}°/${residentialPose.referenceFov}°)`);
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
  // The guard means "more than one of the nine bounding samples is occluded". `1 - 8/9` is
  // 0.11111111111111116 in binary floating point, i.e. strictly greater than `1/9`, so without an
  // epsilon a single occluded sample opened a demand the selector can never satisfy when no
  // candidate azimuth improves on 8/9. The hard floor below (visibleRatio >= 1/3) still applies.
  if (rebuildVisibility.baseOcclusionRatio > 1 / 9 + 1e-9) {
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
  const rebuildViewportFit = await rebuildPage.evaluate(() => window.__viewshift?.fit ?? null);
  const safeBasePosition = {
    x: rebuildVisibility.safeFraming.position[0],
    y: rebuildVisibility.safeFraming.position[1],
    z: rebuildVisibility.safeFraming.position[2],
  };
  const safeBaseTarget = {
    x: rebuildVisibility.safeFraming.target[0],
    y: rebuildVisibility.safeFraming.target[1],
    z: rebuildVisibility.safeFraming.target[2],
  };
  const baseDirection = {
    x: safeBasePosition.x - safeBaseTarget.x,
    y: safeBasePosition.y - safeBaseTarget.y,
    z: safeBasePosition.z - safeBaseTarget.z,
  };
  const finalDirection = {
    x: rebuildEnd.end.position.x - rebuildEnd.end.target.x,
    y: rebuildEnd.end.position.y - rebuildEnd.end.target.y,
    z: rebuildEnd.end.position.z - rebuildEnd.end.target.z,
  };
  const baseLength = Math.hypot(baseDirection.x, baseDirection.y, baseDirection.z);
  const finalLength = Math.hypot(finalDirection.x, finalDirection.y, finalDirection.z);
  invariant(rebuildViewportFit?.fitted && !rebuildViewportFit.overflow
      && dist(rebuildEnd.end.target, safeBaseTarget) < 1e-6
      && finalLength >= baseLength - 1e-6
      && (baseDirection.x * finalDirection.x
        + baseDirection.y * finalDirection.y
        + baseDirection.z * finalDirection.z) / (baseLength * finalLength) > 1 - 1e-9,
  'ordinary click and cinematic final share the safe architectural ray while live UI may only dolly it outward');
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

  // #136 merge gate: the deterministic capital parcel that puts the residential camera behind a
  // hill must retain that authored telephoto frame and clip only the foreground depth interval
  // before the nearest sampled house face.
  //
  // Choosing this fixture: the case must (a) actually cross the rendered ridge and (b) let the
  // bounded south-opening search keep candidate 0, since a parcel whose planned yard details are
  // hidden at the authored azimuth legitimately trades 16° for the compensated 0.8 dolly (19.93°)
  // and would make the telephoto assertion below test the wrong thing. `p31` satisfied both until
  // the #164 ridge gentling lowered the capital ridge anchor (124→84m): its nine focus rays then
  // cleared terrain by +0.95m, so the cutaway had nothing to resolve. Re-measured on this exact
  // query, capital/7 still has three armed parcels — p8 (minClearance −5.34m, 9/9 blocked rays,
  // near 19.19m vs subject 43.03m), p9 (−5.30m) and p23 (−2.39m) — and all three keep fov 16° at
  // scale 1. p8 carries the widest terrain margin, so it is the least brittle of the three.
  // If this block ever fails with `active:false`, re-scan for an armed parcel instead of relaxing
  // the assertions: the cutaway is a documented product contract (CLAUDE.md, Environment).
  const TERRAIN_FIXTURE = 'p8';
  await rebuildPage.addInitScript(() => { window.__noWarm = true; });
  await rebuildPage.goto(
    `${base}/?hero=0&village=1&worker=0&shot=1&vscale=capital&vpalace=1&vtemple=1&vseed=7&time=day&weather=clear`,
    { waitUntil: 'domcontentloaded', timeout },
  );
  await rebuildPage.waitForFunction(() => (
    window.__SHOT_READY === true
      && window.__engine?.village?.getState()?.active
      && window.__engine.village.debugPlan()?.seed === 7
      && !window.__engine.village.debugCamera().transitioning
  ), null, { timeout });
  const terrainRegression = await rebuildPage.evaluate(async (fixture) => {
    const engine = window.__engine;
    const visibility = engine.village.debugFocusVisibility(fixture);
    engine.village.debugFocus(fixture);
    for (let index = 0; index < 6; index++) await Promise.resolve();
    const transition = [];
    let settled = null;
    for (const progress of [0, 0.25, 0.5, 0.75, 1]) {
      settled = engine.debugDofSeek(progress, { finish: progress === 1 });
      transition.push({
        progress,
        camera: engine.village.debugCamera(),
        continuum: engine.village.debugContinuum(),
      });
    }
    return {
      visibility,
      settled,
      transition,
      camera: engine.camera.position.toArray(),
      target: engine.__controls.target.toArray(),
      near: engine.camera.near,
      fov: engine.camera.fov,
      referenceFov: engine.camera.userData.villageReferenceFov,
    };
  }, TERRAIN_FIXTURE);
  console.log(`FOCUS TERRAIN TRANSITION: ${JSON.stringify(terrainRegression.transition)}`);
  const terrainSettledDistance = Math.hypot(...terrainRegression.camera.map((
    value,
    index,
  ) => value - terrainRegression.target[index]));
  const terrainSafe = terrainRegression.visibility.safeFraming;
  const terrainCutaway = terrainRegression.visibility.terrainCutaway;
  invariant(terrainRegression.visibility.terrainLimited
      && terrainCutaway.active
      && terrainCutaway.available
      && terrainCutaway.minClearance < 0
      && terrainCutaway.near <= terrainCutaway.subjectNear - 1.2,
  `capital/7/${TERRAIN_FIXTURE} proves the authored ray crosses terrain and resolves it before the house (${terrainCutaway.near.toFixed(3)}m near, ${terrainCutaway.subjectNear.toFixed(3)}m subject, ${terrainCutaway.minClearance.toFixed(3)}m clearance, ${terrainCutaway.blockedRays}/9 blocked rays)`);
  invariant(Math.abs(terrainRegression.near - terrainCutaway.near) < 1e-3,
    `capital/7/${TERRAIN_FIXTURE} applies the shared projection cutaway to the live camera (${terrainRegression.near.toFixed(3)}m)`);
  invariant(terrainRegression.transition.every(({ camera, continuum }) => (
    Number.isFinite(camera.near)
      && camera.near > 0
      && (!continuum.focusCutaway?.active || (
        continuum.focusCutaway.available
          && camera.near <= continuum.focusCutaway.subjectNear - 0.5 + 1e-3
      ))
  )), `capital/7/${TERRAIN_FIXTURE} focus-in keeps every sampled near plane in front of the house`);
  invariant(Math.hypot(...terrainRegression.camera.map((value, index) => (
    value - terrainSafe.position[index]
  ))) < 1e-6
      && Math.hypot(...terrainRegression.target.map((value, index) => (
        value - terrainSafe.target[index]
      ))) < 1e-6
      && Math.abs(terrainRegression.fov - terrainSafe.fov) < 1e-9
      && Math.hypot(...terrainSafe.position.map((value, index) => (
        value - terrainRegression.visibility.baseFraming.position[index]
      ))) < 1e-6
      && Math.abs(terrainRegression.fov - VILLAGE_LENS.parcel.fov) < 1e-9
      && terrainRegression.referenceFov === VILLAGE_LENS.parcel.referenceFov,
  `capital/7/${TERRAIN_FIXTURE} product focus retains the authored distant telephoto frame (${terrainRegression.fov.toFixed(2)}°/${terrainRegression.referenceFov.toFixed(2)}°)`);
  const terrainInk = await rebuildPage.evaluate(() => {
    const engine = window.__engine;
    engine.setRenderStyle('ink', { immediate: true });
    engine.debugRenderDofFrame();
    return {
      near: engine.camera.near,
      ink: engine.debugInk(),
      selected: engine.village.getState().selected,
    };
  });
  await rebuildPage.screenshot({ path: join(outputDir, `terrain-${TERRAIN_FIXTURE}-ink.png`) });
  invariant(terrainInk.selected === TERRAIN_FIXTURE
      && terrainInk.ink.amount >= 0.999
      && Math.abs(terrainInk.near - terrainCutaway.near) < 1e-3,
  `capital/7/${TERRAIN_FIXTURE} ink normal/depth keeps the same camera cutaway (${terrainInk.near.toFixed(3)}m)`);
  await rebuildPage.evaluate(() => {
    window.__engine.setRenderStyle('pbr', { immediate: true });
    window.__engine.debugRenderDofFrame();
  });
  const terrainRebuild = await rebuildPage.evaluate(async (fixture) => {
    const engine = window.__engine;
    const originalKind = engine.village.getState().spec.kind;
    const editedKind = originalKind === 'giwa' ? 'choga' : 'giwa';
    const before = engine.village.debugContinuum().focusCutaway;
    engine.village.rebuild(fixture, { kind: editedKind });
    await new Promise((resolveFrame) => requestAnimationFrame(() => resolveFrame()));
    const edited = {
      camera: engine.village.debugCamera(),
      cutaway: engine.village.debugContinuum().focusCutaway,
    };
    engine.village.rebuild(fixture, { kind: originalKind });
    await new Promise((resolveFrame) => requestAnimationFrame(() => resolveFrame()));
    return {
      before,
      edited,
      restored: {
        camera: engine.village.debugCamera(),
        cutaway: engine.village.debugContinuum().focusCutaway,
      },
      selected: engine.village.getState().selected,
    };
  }, TERRAIN_FIXTURE);
  invariant(terrainRebuild.selected === TERRAIN_FIXTURE
      && terrainRebuild.edited.cutaway.available
      && Math.abs(
        terrainRebuild.edited.cutaway.subjectNear - terrainRebuild.before.subjectNear
      ) > 1e-3
      && Math.abs(
        terrainRebuild.edited.camera.near - terrainRebuild.edited.cutaway.near
      ) < 1e-3
      && terrainRebuild.restored.cutaway.available
      && Math.abs(
        terrainRebuild.restored.cutaway.subjectNear - terrainRebuild.edited.cutaway.subjectNear
      ) > 1e-3
      && Math.abs(
        terrainRebuild.restored.camera.near - terrainRebuild.restored.cutaway.near
      ) < 1e-3,
  `capital/7/${TERRAIN_FIXTURE} kind rebuild invalidates cached subject bounds on both switches without stale cutaway depth`);
  const terrainZoom = await rebuildPage.evaluate(async () => {
    const engine = window.__engine;
    const before = engine.village.debugContinuum();
    engine.village.debugDolly(before.focusMaxReferenceDist / before.aerialReferenceDist);
    await new Promise((resolveFrame) => requestAnimationFrame(() => resolveFrame()));
    await new Promise((resolveFrame) => requestAnimationFrame(() => resolveFrame()));
    return {
      camera: engine.village.debugCamera(),
      continuum: engine.village.debugContinuum(),
      fov: engine.camera.fov,
      referenceFov: engine.camera.userData.villageReferenceFov,
    };
  });
  invariant(terrainZoom.camera.selected === TERRAIN_FIXTURE
      && terrainZoom.camera.dist > terrainSettledDistance + 5
      && Math.abs(terrainZoom.fov - VILLAGE_LENS.parcel.fov) < 1e-9
      && terrainZoom.referenceFov === VILLAGE_LENS.parcel.referenceFov,
  `capital/7/${TERRAIN_FIXTURE} focus zoom-out retains ownership and the telephoto lens (${terrainZoom.camera.dist.toFixed(1)}m, ${terrainZoom.fov.toFixed(2)}°)`);
  invariant(!terrainZoom.continuum.focusCutaway?.active
      && terrainZoom.continuum.focusCutaway?.boundaryRays > 0
      && terrainZoom.camera.near <= 2.5 + 1e-3,
  `capital/7/${TERRAIN_FIXTURE} high focus zoom-out clears the proven terrain and preserves village context (${terrainZoom.camera.near.toFixed(3)}m near)`);
  for (const [parcelId, lens] of [
    ['palace', VILLAGE_LENS.palace],
    ['temple', VILLAGE_LENS.temple],
  ]) {
    const semanticFrame = await captureUiSafeSemanticFrame(
      rebuildPage,
      parcelId,
      `semantic-${parcelId}-desktop`,
    );
    assertUiSafeSemanticFrame(semanticFrame, `desktop ${parcelId}`);
    invariant(Math.abs(semanticFrame.fov - lens.fov) < 1e-9,
      `desktop ${parcelId} UI fitting preserves its authored ${lens.fov}° lens`);
  }
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

  // Phone profile runs the same authored choreography as the desktop.
  //
  // This assertion was re-authored on 2026-07-25 (docs/mobile-effects-audit.md M14/R1). Its previous
  // form demanded `motion === 'compact'`, which was a gate written around a reduction that cost
  // nothing to remove: the compact arrival kept the full 8.1 s length but cut camera travel from
  // 57.6 m to 18.5 m, so a phone viewer watched a nearly frozen frame for eight seconds while the
  // GPU saved exactly zero (camera paths are CPU arithmetic, and the assembly window already holds
  // shadows hot because the geometry itself is moving). The phone now selects 'full'. The core
  // 'compact' profile still exists in architectural-reveal.js for reuse consumers and is asserted
  // by check-cinematic-reveal.mjs.
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
  invariant(mobile.active && mobile.motion === 'full', 'phone path runs the full authored camera choreography');
  // DoF is now device-independent: the focus context owns it everywhere (look-grammar §5). The phone
  // therefore has to satisfy the *coherent* branch, not the disabled one — a phone frame that woke
  // Bokeh without tracking the subject depth (the measured 28.4 m focus error) fails here.
  invariant(mobile.lookErrorDeg < 1e-4 && mobile.dof.enabled
      && (mobile.dof.error == null || mobile.dof.error < 0.04),
  'phone frame keeps lookAt coherent and focuses the restored DoF on its subject');
  await mobilePage.screenshot({ path: join(outputDir, 'rebuild-mobile-mid.png') });
  await mobilePage.goto(
    `${base}/?hero=0&village=1&worker=0&shot=1&vscale=capital&vpalace=1&vtemple=1&vseed=7&time=day&weather=clear`,
    { waitUntil: 'domcontentloaded', timeout },
  );
  await mobilePage.waitForFunction(() => (
    window.__SHOT_READY === true
      && window.__engine?.village?.getState()?.active
      && window.__device?.sheet === true
  ), null, { timeout });
  for (const parcelId of ['palace', 'temple']) {
    const semanticFrame = await captureUiSafeSemanticFrame(
      mobilePage,
      parcelId,
      `semantic-${parcelId}-mobile`,
    );
    assertUiSafeSemanticFrame(semanticFrame, `mobile ${parcelId}`);
  }
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
