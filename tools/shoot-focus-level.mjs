// #15 exact-elevation residential focus composition gate.
//
// Runs the real app from an isolated Vite server, finishes the product's actual
// camera tween deterministically, and captures representative house/landmark views.
// This avoids both a persistent dist directory and several seconds of wall-clock
// animation per subject while retaining the same tween applicator used at runtime.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from '../app/node_modules/vite/dist/node/index.js';
import { launchVerificationBrowser, reportWebGLRenderer } from './lib/verification-browser.mjs';
import { countChangedPixels } from './lib/png-metrics.mjs';
import {
  VILLAGE_FOCUS_DOF_APERTURE,
  VILLAGE_FOCUS_ELEVATION,
} from '../src/camera/optics.js';

const ROOT = resolve(import.meta.dirname, '..');
const APP_ROOT = join(ROOT, 'app');
const cacheDir = await mkdtemp(join(tmpdir(), 'cheoma-focus-level-cache-'));
const outputDir = await mkdtemp(join(tmpdir(), 'cheoma-focus-level-shots-'));
const timeout = Number(process.env.CHEOMA_FOCUS_LEVEL_TIMEOUT_MS) || 90_000;
const FOCUS_ELEVATION_DEG = VILLAGE_FOCUS_ELEVATION * 180 / Math.PI;
const results = [];
const runtimeErrors = [];
const check = (pass, message) => {
  results.push({ pass, message });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${message}`);
};
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
  const base = `http://127.0.0.1:${port}`;
  browser = await launchVerificationBrowser();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  page.setDefaultTimeout(timeout);
  await page.addInitScript(() => { window.__noWarm = true; });
  page.on('pageerror', (error) => runtimeErrors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' && !/favicon|404|Failed to load resource/i.test(message.text())) {
      runtimeErrors.push(`console: ${message.text()}`);
    }
  });

  async function loadVillage(query) {
    await page.goto(`${base}/?hero=0&village=1&worker=0&shot=1&${query}`, {
      waitUntil: 'domcontentloaded', timeout,
    });
    await page.waitForFunction(
      () => window.__SHOT_READY === true
        && window.__engine?.village?.getState()?.active
        && !window.__engine.village.debugCamera().transitioning,
      null,
      { timeout },
    );
  }

  // Start an actual product transition, drain the no-warm reveal microtasks, then
  // finish that same tween through its shared deterministic applicator.
  async function finishTransition(action, parcelId = null) {
    return page.evaluate(async ({ actionName, id }) => {
      const engine = window.__engine;
      if (actionName === 'focus') engine.village.debugFocus(id);
      else engine.village.return();
      for (let index = 0; index < 6; index++) await Promise.resolve();
      const sample = engine.debugDofSeek(1, { finish: true });
      if (!sample) throw new Error(`${actionName} camera tween did not start`);
      return engine.village.debugCamera();
    }, { actionName: action, id: parcelId });
  }

  let selected = null;
  const residentialEvidence = [];
  const expectedLift = { palace: 3.2, temple: 3 };
  async function measureFocusedFrame(parcelId) {
    return page.evaluate(async (id) => {
      const engine = window.__engine;
      const camera = engine.camera;
      const target = engine.__controls.target;
      const threeUrl = performance.getEntriesByType('resource')
        .map((entry) => entry.name)
        .find((name) => /\/deps\/three\.js/.test(name));
      const THREE = await import(threeUrl);
      const visibility = engine.village.debugFocusVisibility(id);
      const bounds = visibility.subjectBounds;
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const x of [bounds.min[0], bounds.max[0]]) {
        for (const y of [bounds.min[1], bounds.max[1]]) {
          for (const z of [bounds.min[2], bounds.max[2]]) {
            const projected = camera.position.clone().set(x, y, z).project(camera);
            minX = Math.min(minX, projected.x); maxX = Math.max(maxX, projected.x);
            minY = Math.min(minY, projected.y); maxY = Math.max(maxY, projected.y);
          }
        }
      }
      const forward = target.clone().sub(camera.position).normalize();
      const detailRoot = engine.village.focusRoot();
      detailRoot?.updateWorldMatrix(true, true);
      const raycaster = new THREE.Raycaster();
      const inFrame = (point) => {
        const projected = point.clone().project(camera);
        return Math.abs(projected.x) <= 1 && Math.abs(projected.y) <= 1
          && Math.abs(projected.z) <= 1;
      };
      const objectPath = (object) => {
        const parts = [];
        for (let current = object; current && current !== detailRoot; current = current.parent) {
          parts.push(current.name || current.type || 'Object3D');
        }
        return parts.reverse().join('/');
      };
      const rayProbe = (object, point) => {
        const direction = point.clone().sub(camera.position);
        const distance = direction.length();
        raycaster.set(camera.position, direction.normalize());
        const first = raycaster.intersectObject(detailRoot, true)
          .find((hit) => hit.distance <= distance + 0.2);
        return {
          visible: first?.object === object,
          blocker: first && first.object !== object ? objectPath(first.object) : null,
          hitDistance: first ? +first.distance.toFixed(2) : null,
          targetDistance: +distance.toFixed(2),
        };
      };
      const yardDetails = [];
      detailRoot?.traverse((object) => {
        if (!object.visible) return;
        let parent = object.parent, semantic = null;
        while (parent && parent !== detailRoot) {
          if (['yard-props', 'aux', 'garden'].includes(parent.name)) {
            semantic = parent.name;
            break;
          }
          parent = parent.parent;
        }
        // A ground mesh is not a household detail and must not make this
        // close-focus evidence pass by itself.
        const named = object.name === 'lantern-bulb';
        if (!named && !(semantic && object.isMesh)) return;
        const point = new THREE.Box3().setFromObject(object).getCenter(new THREE.Vector3());
        const framed = inFrame(point);
        const projected = point.clone().project(camera);
        const ray = framed ? rayProbe(object, point) : null;
        yardDetails.push({
          name: object.name || semantic,
          path: objectPath(object),
          inFrame: framed,
          visible: framed && ray.visible,
          blocker: ray?.blocker ?? null,
          hitDistance: ray?.hitDistance ?? null,
          targetDistance: ray?.targetDistance ?? null,
          screen: framed ? {
            x: +((projected.x + 1) * 0.5).toFixed(3),
            y: +((1 - projected.y) * 0.5).toFixed(3),
          } : null,
        });
      });
      const ring = engine.scene.children.find((child) => (
        child.name === 'focusRing' && child.userData?.parcelId === id && child.visible
      ));
      return {
        elevation: Math.asin(-forward.y) * 180 / Math.PI,
        composition: window.__viewshift?.compositionYFrac ?? null,
        left: (minX + 1) * 0.5,
        right: (maxX + 1) * 0.5,
        top: (1 - maxY) * 0.5,
        bottom: (1 - minY) * 0.5,
        height: (maxY - minY) * 0.5,
        yardDetails,
        yardDetailsInFrame: yardDetails.filter((detail) => detail.inFrame).length,
        yardDetailsVisible: yardDetails.filter((detail) => detail.visible).length,
        hasChickens: ring?.userData?.hasChickens ?? false,
      };
    }, parcelId);
  }

  async function captureFocusedAnimalPixels(parcelId) {
    const state = await page.evaluate(async (id) => {
      const engine = window.__engine;
      engine.debugSetPaused(true);
      engine.debugAdvanceFocusRing(3.2);
      await new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)));
      const ring = engine.scene.children.find((child) => (
        child.name === 'focusRing' && child.userData?.parcelId === id && child.visible
      ));
      const animals = ring?.getObjectByName('animals');
      engine.debugRenderDofFrame();
      const on = engine.renderer.domElement.toDataURL('image/png');
      if (!animals) return { toggled: false, on, off: on };
      animals.visible = false;
      engine.debugRenderDofFrame();
      const off = engine.renderer.domElement.toDataURL('image/png');
      animals.visible = true;
      engine.debugRenderDofFrame();
      return { toggled: true, on, off };
    }, parcelId);
    await page.evaluate(() => window.__engine.debugSetPaused(false));
    const on = Buffer.from(state.on.split(',')[1], 'base64');
    const off = Buffer.from(state.off.split(',')[1], 'base64');
    return { toggled: state.toggled, changed: countChangedPixels(on, off) };
  }

  async function focusAndCapture(name, parcel) {
    if (selected) {
      await finishTransition('return');
      selected = null;
    }
    const framing = await finishTransition('focus', parcel.parcelId);
    selected = parcel.parcelId;
    check(!framing.transitioning && framing.selected === parcel.parcelId,
      `${name} focus transition settles on ${parcel.parcelId}`);

    const current = (await page.evaluate(() => window.__engine.village.debugParcels()))
      .find((candidate) => candidate.parcelId === parcel.parcelId);
    const wanted = expectedLift[name];
    check(Number.isFinite(current?.focusTargetLift)
      && (wanted == null
        ? current.focusTargetLift >= 1.65 && current.focusTargetLift <= 2.5
        : Math.abs(current.focusTargetLift - wanted) < 0.011),
    `${name} aims at door height (${current?.focusTargetLift}m above base)`);
    check(Math.abs(framing.targetY - current.focusTargetY) < 0.11,
      `${name} runtime target matches planned framing (${framing.targetY}/${current.focusTargetY})`);

    // Allow the settled frame, LOD ownership handoff, and Svelte panel CSS morph to
    // finish before capture. Camera motion itself was already sought deterministically.
    await page.evaluate(() => new Promise((resolveFrame) => requestAnimationFrame(() => resolveFrame())));
    await page.waitForTimeout(300);
    const frame = await measureFocusedFrame(parcel.parcelId);
    console.log(`FOCUS FRAME ${name}: ${JSON.stringify(frame)}`);
    if (name === 'giwa' || name === 'choga' || name === 'hero' || name === 'terrain-p31') {
      check(Math.abs(frame.elevation - FOCUS_ELEVATION_DEG) < 0.02,
        `${name} runtime keeps the exact shared focus elevation (${frame.elevation.toFixed(2)}°)`);
      check(Math.abs(frame.composition) < 1e-6,
        `${name} keeps the centered projection instead of cropping the courtyard for sky`);
      check(frame.top >= 0.02 && frame.bottom <= 0.98
        && frame.left >= 0.02 && frame.right <= 0.98 && frame.height >= 0.12,
      `${name} house volume remains uncropped and readable (${(frame.top * 100).toFixed(1)}–${(frame.bottom * 100).toFixed(1)}%, height ${(frame.height * 100).toFixed(1)}%)`);
    }
    if (name === 'giwa' || name === 'choga') {
      const animalPixels = await captureFocusedAnimalPixels(parcel.parcelId);
      residentialEvidence.push({ name, frame, animalPixels });
      console.log(`FOCUS LIFE ${name}: ${JSON.stringify({
        yardDetailsVisible: frame.yardDetailsVisible, animalPixels,
      })}`);
      check(frame.yardDetailsVisible >= 1,
        `${name} retains a ray-visible household yard detail (${frame.yardDetailsVisible}/${frame.yardDetailsInFrame})`);
    }
    await page.screenshot({ path: join(outputDir, `${name}.png`) });
    return frame;
  }

  await loadVillage('vscale=capital&vpalace=1&vtemple=1&seed=20260718&vseed=7&time=day&weather=clear');
  await reportWebGLRenderer(page, 'focus-level');
  const parcels = await page.evaluate(() => window.__engine.village.debugParcels());
  const picks = [
    ['giwa', parcels.find((parcel) => parcel.family === 'regular' && parcel.kind === 'giwa')],
    ['choga', parcels.find((parcel) => parcel.family === 'regular' && parcel.kind !== 'giwa')],
    ['palace', parcels.find((parcel) => parcel.parcelId === 'palace')],
    ['temple', parcels.find((parcel) => parcel.parcelId === 'temple')],
  ].filter(([, parcel]) => parcel);
  check(picks.length === 4,
    `capital focus subjects are available (${picks.map(([name]) => name).join(', ')})`);
  for (const [name, parcel] of picks) {
    await focusAndCapture(name, parcel);
    if (name !== 'temple') continue;
    const edit = await page.evaluate(() => {
      const engine = window.__engine;
      const initial = engine.village.getState().spec;
      const compactOptions = { ...initial.variantDefaults.compact, variant: 'compact' };
      engine.village.rebuild('temple', { templeOptions: compactOptions });
      const compact = {
        spec: engine.village.getState().spec,
        box: engine.village.debugOverlayBox('temple'),
      };
      const extendedOptions = { ...compact.spec.variantDefaults.extended, variant: 'extended' };
      engine.village.rebuild('temple', { templeOptions: extendedOptions });
      const extended = {
        spec: engine.village.getState().spec,
        box: engine.village.debugOverlayBox('temple'),
      };
      return { initial, compact, extended };
    });
    check(edit.compact.spec.params.variant === 'compact'
      && edit.compact.spec.params.hallCount === edit.compact.spec.variantDefaults.compact.hallCount,
    `temple editor keeps compact UI and plan values synchronized (${edit.compact.spec.params.hallCount} halls)`);
    check(edit.extended.spec.params.variant === 'extended'
      && edit.extended.spec.params.hallCount === edit.extended.spec.variantDefaults.extended.hallCount,
    `temple editor restores extended semantic defaults (${edit.extended.spec.params.hallCount} halls)`);
    check(edit.extended.box.x > edit.compact.box.x + 20 && edit.extended.box.z > edit.compact.box.z + 20,
      `temple editor rebuilds the reserved compound geometry (${JSON.stringify({ compact: edit.compact.box, extended: edit.extended.box })})`);
  }
  const terrainRegression = parcels.find((parcel) => parcel.parcelId === 'p31');
  check(!!terrainRegression, 'capital seed 7 terrain-occluded regression parcel p31 is available');
  if (terrainRegression) {
    await focusAndCapture('terrain-p31', terrainRegression);
    const terrainEvidence = await page.evaluate((id) => ({
      visibility: window.__engine.village.debugFocusVisibility(id),
      dof: window.__engine.debugDof(),
    }), terrainRegression.parcelId);
    console.log(`FOCUS TERRAIN p31: ${JSON.stringify(terrainEvidence)}`);
    check(terrainEvidence.visibility.terrainLimited
      && terrainEvidence.visibility.terrainMinClearance >= 1 - 1e-6
      && terrainEvidence.visibility.terrainEndpointClearance >= 1.2 - 1e-6,
    `p31 camera keeps an exact rendered-terrain corridor (${terrainEvidence.visibility.terrainMinClearance?.toFixed(3)}m ray, ${terrainEvidence.visibility.terrainEndpointClearance?.toFixed(3)}m eye)`);
    check(terrainEvidence.visibility.telephotoPreserved
      && terrainEvidence.visibility.safeFraming.fov <= 30,
    `p31 stays within the architectural fallback lens (${terrainEvidence.visibility.safeFraming.fov.toFixed(2)}°)`);
    check(Math.abs(terrainEvidence.dof.baseAperture - VILLAGE_FOCUS_DOF_APERTURE) < 1e-12
      && Math.abs(terrainEvidence.dof.aperture - VILLAGE_FOCUS_DOF_APERTURE) < 1e-12
      && terrainEvidence.dof.bokehSamples === 41,
    `p31 restores the strengthened settled physical DoF (${terrainEvidence.dof.aperture}, ${terrainEvidence.dof.bokehSamples} taps)`);
  }
  check(residentialEvidence.some((entry) => (
    entry.animalPixels.toggled && entry.animalPixels.changed >= 20
  )), `regular residential focus animals make a real canvas contribution (${residentialEvidence
    .map((entry) => `${entry.name}:${entry.animalPixels.changed}`).join(', ')})`);

  // Capital deliberately replaces the residential hero with the palace core.
  await loadVillage('vscale=village&vtemple=0&seed=20260718&vseed=7&time=day&weather=clear');
  selected = null;
  const hero = (await page.evaluate(() => window.__engine.village.debugParcels()))
    .find((parcel) => parcel.hero);
  check(!!hero, 'village head house is available');
  if (hero) await focusAndCapture('hero', hero);

  // Towns use a formal government/guest-hall hero. Its focus ring may share the
  // same lifecycle, but it must not inherit the residential inner-yard flock.
  await loadVillage('vscale=town&vpalace=0&vtemple=0&seed=20260718&vseed=7&time=day&weather=clear');
  selected = null;
  const formalHero = (await page.evaluate(() => window.__engine.village.debugParcels()))
    .find((parcel) => parcel.hero && parcel.heroStyle === 'palace');
  check(!!formalHero, 'town formal hero is available');
  if (formalHero) {
    const formalFrame = await focusAndCapture('formal-hero', formalHero);
    check(!formalFrame.hasChickens,
      'formal government hero does not inherit the residential inner-yard chickens');
  }

  check(runtimeErrors.length === 0, `browser reports no runtime errors (${runtimeErrors.length})`);
} finally {
  await browser?.close();
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
}

for (const error of runtimeErrors) console.error(error);
const failures = results.filter((result) => !result.pass);
console.log(`FOCUS LEVEL: ${failures.length ? 'FAIL' : 'PASS'} (${results.length - failures.length}/${results.length})`);
console.log(`screenshots: ${outputDir}`);
process.exitCode = failures.length ? 1 : 0;
