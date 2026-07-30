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
  VILLAGE_FOCUS_SKY_FRACTION,
  VILLAGE_LENS,
} from '../src/camera/optics.js';
import { BOKEH_GATHER_TAP_COUNT } from '../src/env/bokeh-coc-contract.js';

const ROOT = resolve(import.meta.dirname, '..');
const APP_ROOT = join(ROOT, 'app');
// The yard-detail fixture must be a regular giwa whose planned details are hidden from the authored
// base frame and exposed by a bounded candidate (base 0 → after ≥1); it is also the `giwa` capture
// below, so a parcel with occlusion blockers or an auxiliary volume in the way confounds that shot.
// `p13` stopped qualifying — under this exact query (the `seed=20260718` house seed matters) it is no
// longer a regular giwa at all. Re-measured over all 13 regular giwa parcels, five qualify:
// p11 and p15 and p31 (detail 0/2→1/2, no blockers), p16 (0/1→1/1, only one planned detail) and
// p27 (0/2→1/2 but blocked by `auxiliary:p27:aux-0`). `p31` is deliberately avoided here because it
// used to be the terrain fixture and would read as the same case.
// `p11` then stopped qualifying when 마당 소품 배치가 plotW×plotD 직사각형에서 실제 필지 폴리곤으로
// 옮겨졌다(`village/yard-layout.js`). p11 의 두 디테일(장독대·빨래줄)은 여전히 계획되지만 장독대가
// 담을 뚫고 나와 있던 자리에서 실제 뒤안(로컬 z=-4.81)으로 들어갔고, 뒤안은 본채가 정당하게 가린다
// — 즉 이전의 "보인다"는 소품이 담 밖으로 삐져나와 있었기 때문이었다. 같은 query 재측정: 네 곳이
// 여전히 자격을 갖는다(p15·p16·p27·p31, p24 는 base 1 이라 부적격). `p15`(0/2→1/2, 부속채·차폐물
// 없음)가 가장 깨끗하다. 다시 드리프트하면 base-0/after-≥1 정규 giwa 를 재스캔할 것 — 어서션을
// 완화하지 말 것.
const GIWA_YARD_DETAIL_FIXTURE = 'p15';
// The terrain-occluded fixture must actually cross the rendered ridge. `p31` stopped doing so when
// the #164 ridge gentling lowered the capital ridge anchor (its nine focus rays now clear terrain
// by +0.95m), and `p8` stopped doing so when the R2 roof-sea round re-laid the capital parcels: its
// rays now clear terrain by +0.768m with 0/9 blocked. Re-scanned over all 54 capital/7 parcels on
// this exact query, three stay armed — p48 (minClearance −3.007m), p47 (−2.733m, near 13.296m vs
// subject 46.577m) and p36 (−1.132m). p36 is disqualified because the bounded south-opening search
// moves it off candidate 0 (scale 0.9, fov 17.75°), which would make the telephoto assertion test
// the wrong thing. p48 is armed only on the settle solve — every refreshed solve reports `clear` at
// +0.5m — so `p47`, which stays armed across refreshed solves, is the stable fixture.
// Re-scan for an armed parcel if this ever goes missing — never relax the terrain assertions below.
const TERRAIN_FIXTURE = 'p47';
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
    // `shot=1` keeps unrelated motion deterministic but normally disables the
    // product UI-aware projection. This fixture explicitly owns that contract.
    await page.evaluate(() => window.__viewshift?.setEnabled(true));
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
      const semantic = visibility.focusSubject;
      const semanticPoints = [];
      const addFootprint = (footprint, y) => {
        for (const point of footprint || []) semanticPoints.push({ x: point.x, y, z: point.z });
      };
      if (semantic?.representative) {
        addFootprint(semantic.representative.footprint, semantic.representative.minY);
        addFootprint(semantic.representative.footprint, semantic.representative.maxY);
      }
      if (semantic?.courtyard) addFootprint(semantic.courtyard.footprint, semantic.courtyard.y);
      for (const anchor of semantic?.anchors || []) {
        if (anchor?.point) semanticPoints.push(anchor.point);
      }
      if (!semanticPoints.length) for (const x of [bounds.min[0], bounds.max[0]]) {
        for (const y of [bounds.min[1], bounds.max[1]]) {
          for (const z of [bounds.min[2], bounds.max[2]]) semanticPoints.push({ x, y, z });
        }
      }
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const point of semanticPoints) {
        const projected = camera.position.clone().set(point.x, point.y, point.z).project(camera);
        minX = Math.min(minX, projected.x); maxX = Math.max(maxX, projected.x);
        minY = Math.min(minY, projected.y); maxY = Math.max(maxY, projected.y);
      }
      const forward = target.clone().sub(camera.position).normalize();
      const detailRoot = engine.village.focusRoot();
      detailRoot?.updateWorldMatrix(true, true);
      const raycaster = new THREE.Raycaster();
      const objectPath = (object) => {
        const parts = [];
        for (let current = object; current && current !== detailRoot; current = current.parent) {
          parts.push(current.name || current.type || 'Object3D');
        }
        return parts.reverse().join('/');
      };
      const projectedBounds = (object) => {
        const box = new THREE.Box3().setFromObject(object);
        const min = { x: Infinity, y: Infinity, z: Infinity };
        const max = { x: -Infinity, y: -Infinity, z: -Infinity };
        for (const x of [box.min.x, box.max.x]) {
          for (const y of [box.min.y, box.max.y]) {
            for (const z of [box.min.z, box.max.z]) {
              const projected = new THREE.Vector3(x, y, z).project(camera);
              min.x = Math.min(min.x, projected.x);
              min.y = Math.min(min.y, projected.y);
              min.z = Math.min(min.z, projected.z);
              max.x = Math.max(max.x, projected.x);
              max.y = Math.max(max.y, projected.y);
              max.z = Math.max(max.z, projected.z);
            }
          }
        }
        return {
          min,
          max,
          inFrame: max.x >= -1 && min.x <= 1
            && max.y >= -1 && min.y <= 1
            && max.z >= -1 && min.z <= 1,
        };
      };
      const rayProbe = (object, ndcX, ndcY) => {
        raycaster.setFromCamera({ x: ndcX, y: ndcY }, camera);
        const first = raycaster.intersectObject(detailRoot, true)[0];
        return {
          visible: first?.object === object,
          blocker: first && first.object !== object ? objectPath(first.object) : null,
          hitDistance: first ? +first.distance.toFixed(2) : null,
        };
      };
      const visibilityProbe = (object) => {
        const bounds = projectedBounds(object);
        if (!bounds.inFrame) {
          return {
            inFrame: false,
            visible: false,
            visibleSamples: 0,
            sampleCount: 0,
            blocker: null,
            hitDistance: null,
            screen: null,
          };
        }
        const clipped = {
          minX: Math.max(-1, bounds.min.x),
          maxX: Math.min(1, bounds.max.x),
          minY: Math.max(-1, bounds.min.y),
          maxY: Math.min(1, bounds.max.y),
        };
        const probes = [];
        // Fixed screen-space samples make evidence independent of mesh vertex order
        // while requiring more than a single grazing pixel to count as readable.
        for (const xWeight of [0.2, 0.5, 0.8]) {
          for (const yWeight of [0.2, 0.5, 0.8]) {
            const x = THREE.MathUtils.lerp(clipped.minX, clipped.maxX, xWeight);
            const y = THREE.MathUtils.lerp(clipped.minY, clipped.maxY, yWeight);
            probes.push(rayProbe(object, x, y));
          }
        }
        const visibleSamples = probes.filter((probe) => probe.visible).length;
        const firstBlocker = probes.find((probe) => probe.blocker);
        const center = {
          x: (clipped.minX + clipped.maxX) * 0.5,
          y: (clipped.minY + clipped.maxY) * 0.5,
        };
        return {
          inFrame: true,
          visible: visibleSamples >= 2,
          visibleSamples,
          sampleCount: probes.length,
          blocker: firstBlocker?.blocker ?? null,
          hitDistance: firstBlocker?.hitDistance ?? null,
          screen: {
            x: +((center.x + 1) * 0.5).toFixed(3),
            y: +((1 - center.y) * 0.5).toFixed(3),
          },
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
        const visibility = visibilityProbe(object);
        yardDetails.push({
          name: object.name || semantic,
          path: objectPath(object),
          ...visibility,
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
        safeRect: window.__viewshift?.safeRect ?? null,
        viewportFit: window.__viewshift?.fit ?? null,
        yardDetails,
        yardDetailsInFrame: yardDetails.filter((detail) => detail.inFrame).length,
        yardDetailsVisible: yardDetails.filter((detail) => detail.visible).length,
        hasChickens: ring?.userData?.hasChickens ?? false,
        detailSelection: {
          azimuth: visibility.azimuth,
          baseAzimuth: visibility.baseAzimuth,
          selected: Number.isFinite(visibility.detailCount)
            ? `${visibility.detailVisibleCount}/${visibility.detailCount}`
            : null,
          candidates: visibility.candidates?.map((candidate) => ({
            azimuth: candidate.azimuth,
            scale: candidate.scale,
            detail: `${candidate.detailVisibleCount}/${candidate.detailCount}`,
            architectural: candidate.visibleRatio,
            blocked: candidate.cameraBlocked,
          })) ?? [],
        },
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
    await page.waitForFunction(() => {
      const shift = window.__viewshift;
      return shift && Math.abs(shift.x - shift.tx) < 0.25
        && Math.abs(shift.y - shift.ty) < 0.25;
    }, null, { timeout });
    const frame = await measureFocusedFrame(parcel.parcelId);
    console.log(`FOCUS FRAME ${name}: ${JSON.stringify(frame)}`);
    if (name === 'giwa' || name === 'choga' || name === 'hero' || name === `terrain-${TERRAIN_FIXTURE}`) {
      check(Math.abs(frame.elevation - FOCUS_ELEVATION_DEG) < 0.02,
        `${name} runtime keeps the exact shared focus elevation (${frame.elevation.toFixed(2)}°)`);
      // #15 re-authoring (user: "뒷산의 높이를 좀 낮추면 림패스 만들어내기 훨씬 유리할 것 같아. 하늘도
      //   보기 좋고"): a close residential frame now shifts the lens down by an authored fraction to
      //   secure sky, so demanding a centered projection tested a value the product no longer holds.
      //   The authored amount lives once in optics.js and engine.js#setFocusComposition applies it as
      //   `-VILLAGE_FOCUS_SKY_FRACTION * focusComposition` with focusComposition = 1 for every
      //   residential subject (palace/temple use 0 and are excluded from this block). Compare against
      //   the imported constant rather than re-typing 0.13 — a drifted, doubled or dropped shift still
      //   fails, and a null viewshift fails too.
      const expectedComposition = -VILLAGE_FOCUS_SKY_FRACTION;
      check(Math.abs(frame.composition - expectedComposition) < 1e-6,
        `${name} keeps the authored sky-fraction lens shift for the courtyard (${
          frame.composition?.toFixed?.(4) ?? frame.composition} = ${expectedComposition.toFixed(4)})`);
      check(frame.top >= 0.02 && frame.bottom <= 0.98
        && frame.left >= 0.02 && frame.right <= 0.98 && frame.height >= 0.12,
      `${name} house volume remains uncropped and readable (${(frame.top * 100).toFixed(1)}–${(frame.bottom * 100).toFixed(1)}%, height ${(frame.height * 100).toFixed(1)}%)`);
    }
    const safe = frame.safeRect;
    const px = {
      left: frame.left * 1440,
      right: frame.right * 1440,
      top: frame.top * 900,
      bottom: frame.bottom * 900,
    };
    check(safe?.usable
      && px.left >= safe.left - 1
      && px.right <= safe.right + 1
      && px.top >= safe.top - 1
      && px.bottom <= safe.bottom + 1
      && frame.viewportFit?.fitted
      && !frame.viewportFit?.overflow,
    `${name} semantic architecture and courtyard fit the live UI-safe viewport (${
      JSON.stringify({ px, safe, fit: frame.viewportFit })
    })`);
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
  const parcels = await page.evaluate(() => window.__engine.village.debugParcels().map((parcel) => ({
    ...parcel,
    focusVisibility: window.__engine.village.debugFocusVisibility(parcel.parcelId),
  })));
  // Fixed before/after fixture: do not search the implementation's diagnostics
  // for a passing house. In this seed p15 has two planned details, both hidden from
  // the authored base frame by the house itself, one of which a bounded
  // south-opening candidate exposes (see GIWA_YARD_DETAIL_FIXTURE above).
  const giwaDetailFixture = parcels.find((parcel) => (
    parcel.parcelId === GIWA_YARD_DETAIL_FIXTURE
  ));
  check(giwaDetailFixture?.family === 'regular' && giwaDetailFixture?.kind === 'giwa',
    `capital fixed yard-detail fixture remains a regular giwa (${giwaDetailFixture?.parcelId || 'missing'})`);
  check(giwaDetailFixture?.focusVisibility?.baseDetailVisibleCount === 0
      && giwaDetailFixture?.focusVisibility?.detailVisibleCount >= 1,
    `fixed ${GIWA_YARD_DETAIL_FIXTURE} bounded focus improves planned detail visibility (${
      giwaDetailFixture?.focusVisibility?.baseDetailVisibleCount
    }→${giwaDetailFixture?.focusVisibility?.detailVisibleCount})`);
  const picks = [
    ['giwa', giwaDetailFixture],
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
  const terrainRegression = parcels.find((parcel) => parcel.parcelId === TERRAIN_FIXTURE);
  check(!!terrainRegression,
    `capital seed 7 terrain-occluded regression parcel ${TERRAIN_FIXTURE} is available`);
  if (terrainRegression) {
    await focusAndCapture(`terrain-${TERRAIN_FIXTURE}`, terrainRegression);
    await page.waitForFunction(
      () => window.__engine.debugDof().postQualityMode === 'stable',
      null,
      { timeout },
    );
    const terrainEvidence = await page.evaluate((id) => ({
      visibility: window.__engine.village.debugFocusVisibility(id),
      dof: window.__engine.debugDof(),
      camera: window.__engine.village.debugCamera(),
      continuum: window.__engine.village.debugContinuum(),
    }), terrainRegression.parcelId);
    console.log(`FOCUS TERRAIN ${TERRAIN_FIXTURE}: ${JSON.stringify(terrainEvidence)}`);
    const cutaway = terrainEvidence.visibility.terrainCutaway;
    check(terrainEvidence.visibility.terrainLimited
      && cutaway?.active
      && cutaway.available
      && cutaway.minClearance < 0
      && cutaway.near <= cutaway.subjectNear - 1.2,
    `${TERRAIN_FIXTURE} clips the proven terrain crossing before the house (${cutaway?.near.toFixed(3)}m/${cutaway?.subjectNear.toFixed(3)}m)`);
    check(Math.abs(terrainEvidence.camera.near - cutaway.near) < 1e-3
      && Math.abs(terrainEvidence.continuum.focusCutaway.near - cutaway.near) < 1e-3,
    `${TERRAIN_FIXTURE} applies one shared live-camera cutaway (${terrainEvidence.camera.near.toFixed(3)}m)`);
    check(terrainEvidence.visibility.telephotoPreserved
      && Math.abs(terrainEvidence.visibility.safeFraming.fov - VILLAGE_LENS.parcel.fov) < 1e-9
      && terrainEvidence.visibility.safeFraming.position.every((value, index) => (
        Math.abs(value - terrainEvidence.visibility.baseFraming.position[index]) < 1e-9
      )),
    `${TERRAIN_FIXTURE} retains the authored distant telephoto frame (${terrainEvidence.visibility.safeFraming.fov.toFixed(2)}°)`);
    check(Math.abs(terrainEvidence.dof.baseAperture - VILLAGE_FOCUS_DOF_APERTURE) < 1e-12
      && Math.abs(terrainEvidence.dof.aperture - VILLAGE_FOCUS_DOF_APERTURE) < 1e-12
      && terrainEvidence.dof.postQuality === 1
      && terrainEvidence.dof.postQualityMode === 'stable'
      && terrainEvidence.dof.bokehSamples === BOKEH_GATHER_TAP_COUNT
      && terrainEvidence.dof.activeBokehTaps === BOKEH_GATHER_TAP_COUNT,
    `${TERRAIN_FIXTURE} restores the settled adaptive physical DoF (${terrainEvidence.dof.aperture}, ${terrainEvidence.dof.bokehSamples} active taps)`);
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

  // One additional mobile boot owns both landmark frames. The context sheet
  // remains at its product-default peek detent; top controls, dial, actions, and
  // the visible sheet grip all participate in the live safe rectangle.
  const mobile = await browser.newPage({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  mobile.setDefaultTimeout(timeout);
  await mobile.addInitScript(() => { window.__noWarm = true; });
  mobile.on('pageerror', (error) => runtimeErrors.push(`mobile pageerror: ${error.message}`));
  mobile.on('console', (message) => {
    if (message.type() === 'error' && !/favicon|404|Failed to load resource/i.test(message.text())) {
      runtimeErrors.push(`mobile console: ${message.text()}`);
    }
  });
  await mobile.goto(`${base}/?hero=0&village=1&worker=0&shot=1&vscale=capital&vpalace=1&vtemple=1&seed=20260718&vseed=7&time=day&weather=clear`, {
    waitUntil: 'domcontentloaded',
    timeout,
  });
  await mobile.waitForFunction(
    () => window.__SHOT_READY === true
      && window.__engine?.village?.getState()?.active
      && window.__device?.sheet === true,
    null,
    { timeout },
  );
  await mobile.evaluate(() => window.__viewshift?.setEnabled(true));

  async function mobileFocus(parcelId) {
    return mobile.evaluate(async (id) => {
      const engine = window.__engine;
      if (engine.village.getState().selected) {
        engine.village.return();
        for (let index = 0; index < 6; index++) await Promise.resolve();
        engine.debugDofSeek(1, { finish: true });
      }
      engine.village.debugFocus(id);
      for (let index = 0; index < 6; index++) await Promise.resolve();
      engine.debugDofSeek(1, { finish: true });
    }, parcelId);
  }

  async function mobileSemanticFrame(parcelId) {
    await mobileFocus(parcelId);
    await mobile.waitForFunction(() => {
      const shift = window.__viewshift;
      return document.querySelector('.sheet.context')?.dataset.snap === 'peek'
        && shift?.safeRect?.usable
        && shift.fit?.fitted
        && !shift.fit?.overflow
        && Math.abs(shift.x - shift.tx) < 0.25
        && Math.abs(shift.y - shift.ty) < 0.25;
    }, null, { timeout });
    return mobile.evaluate((id) => {
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
        snap: document.querySelector('.sheet.context')?.dataset.snap,
      };
    }, parcelId);
  }

  for (const parcelId of ['palace', 'temple']) {
    const mobileFrame = await mobileSemanticFrame(parcelId);
    check(mobileFrame.snap === 'peek'
      && mobileFrame.box.left >= mobileFrame.safe.left - 1
      && mobileFrame.box.right <= mobileFrame.safe.right + 1
      && mobileFrame.box.top >= mobileFrame.safe.top - 1
      && mobileFrame.box.bottom <= mobileFrame.safe.bottom + 1,
    `mobile ${parcelId} semantic frame clears top chrome and peek sheet (${
      JSON.stringify(mobileFrame)
    })`);
    await mobile.screenshot({ path: join(outputDir, `mobile-${parcelId}.png`) });
  }
  await mobile.close();

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
