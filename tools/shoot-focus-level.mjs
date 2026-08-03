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
import { VILLAGE_FOCUS_CAMERA_CLEARANCE } from '../src/camera/focus-visibility.js';

const ROOT = resolve(import.meta.dirname, '..');
const APP_ROOT = join(ROOT, 'app');
// 두 계약은 종전에 **한 필지**에 겹쳐 있었다: `giwa` 캡처 대상(정규 기와집)과 "경계 탐색이 저작
// 프레임이 가리는 계획 마당 디테일을 드러낸다"(base 0 → after ≥1). R2 지붕바다 라운드가 capital
// 필지를 재배열하면서 그 겹침이 **동시 충족 불가능**해졌다. 같은 query(집 시드 `seed=20260718` 가
// 중요) 재스캔 결과:
//   · `p15` 는 더 이상 기와집이 아니다(regular/choga, 디테일 3/3 이 base 에서 이미 보인다 → 개선 0).
//   · 정규 기와집은 7곳뿐이고(p10·p11·p19·p21·p22·p37·p40) **어느 곳도 개선하지 않는다**
//     (p10 0→0/1, p11 0→0/2, p19 0→0/2, p21 0→0/1, p22 0→0/2, p37 0→0/2, p40 은 base 1 로 부적격).
//   · 반대로 개선 사례는 제품에 살아 있다 — 다섯 곳(p4·p17·p20·p42·p46, 모두 초가).
// 그래서 어서션을 완화하는 대신 **두 역할을 분리**했다. 각 어서션의 의미는 그대로다: 기와집 캡처는
// 여전히 정규 기와집을 찍고, 개선 계약은 실제로 그 일이 일어나는 필지에서 측정된다.
//
// 캡처용 기와집: 건축 차폐물이 없고 경계 탐색이 candidate 0(scale 1 / fov 16°)에 머무는 필지여야
// 한다(그렇지 않으면 망원 프레임 어서션이 다른 것을 시험한다). p10·p11·p21 이 그 조건을 만족하고,
// p37 은 `p21` 에 가리고 p22·p40 은 scale 0.8 로 밀려난다. 셋 중 `p21` 만 근접 링 동물이 실제로
// 화면에 기여한다(측정 animalPixels: p10 0, p11 0, p21 634) — 아래 동물 기여 어서션은 `.some()`
// 이라 초가만으로도 통과하지만, 기와집 쪽 증거가 0 인 픽스처는 커버리지를 스스로 지운다.
const GIWA_CAPTURE_FIXTURE = 'p21';
// 개선 계약 픽스처: base 0 → 경계 candidate ≥1. 다섯 후보 중 p46 은 candidate 하나(scale 0.8)에서만
// 개선되어 가장 취약하고, p20·p42 는 담이 함께 가린다. `p4`(0→1/2, scale 0.9·0.8 두 candidate 에서
// 개선, 차폐는 본채 자신 = 문서화된 "본채가 가리고 경계 탐색이 드러낸다" 사례)가 가장 깨끗하다.
// 다시 드리프트하면 base-0/after-≥1 정규 주거 필지를 재스캔할 것 — 어서션을 완화하지 말 것.
const YARD_DETAIL_FIXTURE = 'p4';
// The terrain-occluded fixture must actually cross the rendered ridge. `p31` stopped doing so when
// the #164 ridge gentling lowered the capital ridge anchor, `p8` stopped when the R2 roof-sea round
// re-laid the capital parcels, and (2026-08-04 re-scan, #51) `p47`/`p48`/`p36`'s old −1.132m form all
// went clear too: p47 now reads minClearance +0.658m (0/9 blocked, reason 'clear'; a same-day
// independent live measurement logged +0.802m — both agree the ray no longer crosses terrain). The
// most likely cause is the same R2 roof-sea round (43b93bd, 2026-07-31, "look: hanyang roof sea —
// density, thatch tone, road muting, paddy float gates") that reflowed `parcels.js`/`plan.js`/
// `house-footprint.js` and already re-laid `p8`; no later commit touches capital parcel placement.
//
// Pure-node re-scan of all 50 capital/7 parcels (`buildParcelPickProxies(plan, plan.site)` over
// `planVillage({ scale:'capital', seed:7, includePalace:true, includeTemple:true })`, no renderer)
// found three parcels still negative: p36 (minClearance −3.494m, 9/9 blocked, near 12.898m vs
// subject 42.266m), p11 (−2.279m, 9/9 blocked) and p10 (−0.685m, 5/9 blocked). `p36` is the fixture:
// it stays on candidate 0 (requestedScale 1, fov 16°) so the telephoto assertion below still tests
// the authored angle, it has the deepest margin and the most blocked rays of the three (most likely
// to survive the next reflow), and it stays armed through a simulated kind-swap rebuild (choga→giwa:
// −2.954m, 9/9 blocked, still 'cutaway'; restored choga: exact −3.494m match, confirming determinism
// and that a rebuild's cache invalidation does not silently disarm it).
// Re-scan for an armed parcel if this ever goes missing — never relax the terrain assertions below.
const TERRAIN_FIXTURE = 'p36';
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
      // Project the semantic box into the *stage/canvas* pixel space that owns both the
      // camera projection (aspect + setViewOffset fullWidth/fullHeight) and
      // __viewshift.safeRect. The 1440×900 page viewport still includes the docked
      // inspector column outside .stage, so scaling by it stretched every semantic box by
      // viewport/stage (measured 4/3: stage 1080 vs window 1440) and falsely reported
      // UI-safe overflow while the fit scale was already applied on the live camera.
      // check-cinematic-reveal-app.mjs was corrected the same way and passes.
      const canvas = engine.renderer.domElement;
      const view = camera.view;
      const stageWidth = (view?.enabled && view.fullWidth > 0)
        ? view.fullWidth
        : (canvas.clientWidth || window.innerWidth);
      const stageHeight = (view?.enabled && view.fullHeight > 0)
        ? view.fullHeight
        : (canvas.clientHeight || window.innerHeight);
      // Authored framing vs the live pose, read in this same frame. The settled focus
      // camera is not always the authored endpoint: engine.js#cushionCameraAboveGround
      // lifts an endpoint that sits under the rendered terrain, preserving orbit radius.
      // Landmark subjects (palace/temple) return no bounded solve, so this stays optional
      // and a missing value fails its assertion instead of throwing here.
      const planned = visibility?.safeFraming?.position && visibility.safeFraming.target
        ? visibility.safeFraming : null;
      const plannedDistance = planned ? Math.hypot(
        planned.position[0] - planned.target[0],
        planned.position[1] - planned.target[1],
        planned.position[2] - planned.target[2],
      ) : null;
      const plannedElevation = plannedDistance > 0 ? Math.asin(
        (planned.position[1] - planned.target[1]) / plannedDistance,
      ) * 180 / Math.PI : null;
      const liveCutaway = engine.village.debugContinuum()?.focusCutaway ?? null;
      return {
        elevation: Math.asin(-forward.y) * 180 / Math.PI,
        plannedElevation,
        plannedDistance,
        liveDistance: camera.position.distanceTo(target),
        endpointClearance: visibility.terrainEndpointClearance ?? null,
        groundClearance: liveCutaway?.cameraClearance ?? null,
        stageWidth,
        stageHeight,
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
      if (name === `terrain-${TERRAIN_FIXTURE}`) {
        // The terrain fixture is the one subject whose authored camera endpoint sits *under*
        // the rendered terrain (endpointClearance −0.174m), so the runtime frame cannot hold
        // the shared 9° elevation: engine.js#cushionCameraAboveGround (asymptotic cushion,
        // floor = VILLAGE_FOCUS_CAMERA_CLEARANCE, fixed point exactly ground+1.2m) lifts it
        // every frame and updateFocusContext absorbs that lift as a user elevation offset.
        // Measured settle → +2.3s: 9.76° → 10.91° at a constant 48.135m radius, creeping
        // toward the cushion floor (the map's derivative is 1 at its fixed point, so it never
        // stops converging — "wait for the camera to settle" is not available here).
        // Asserting a settle-time constant tested a pose the product deliberately does not
        // hold, so this pins the same thing more tightly instead: the *authored* solve keeps
        // the exact shared elevation, and the live pose differs from it only by that cushion —
        // same target, same orbit radius, lifted upward, never under the terrain and never
        // above the cushion floor. Same-frame read (measureFocusedFrame).
        check(Math.abs(frame.plannedElevation - FOCUS_ELEVATION_DEG) < 0.02
          && frame.endpointClearance < 0
          && Math.abs(frame.liveDistance - frame.plannedDistance) < 0.05
          && frame.elevation >= FOCUS_ELEVATION_DEG - 0.02
          && frame.groundClearance > 0
          && frame.groundClearance <= VILLAGE_FOCUS_CAMERA_CLEARANCE + 1e-3,
        `${name} keeps the authored shared focus elevation and only the ground cushion lifts it (${
          frame.plannedElevation.toFixed(2)}° authored → ${frame.elevation.toFixed(2)}° live, radius ${
          frame.liveDistance.toFixed(3)}/${frame.plannedDistance.toFixed(3)}m, clearance ${
          frame.endpointClearance?.toFixed(3)}→${frame.groundClearance}m of ${
          VILLAGE_FOCUS_CAMERA_CLEARANCE}m)`);
      } else check(Math.abs(frame.elevation - FOCUS_ELEVATION_DEG) < 0.02,
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
    // Stage pixels, not page-viewport pixels — see measureFocusedFrame's stageWidth note.
    const px = {
      left: frame.left * frame.stageWidth,
      right: frame.right * frame.stageWidth,
      top: frame.top * frame.stageHeight,
      bottom: frame.bottom * frame.stageHeight,
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
  // Fixed fixtures: do not search the implementation's diagnostics for a passing
  // house. p11 is the regular giwa this run captures; p4 owns the before/after
  // contract — two planned details, both hidden from the authored base frame by the
  // house itself, one of which a bounded south-opening candidate exposes
  // (see GIWA_CAPTURE_FIXTURE / YARD_DETAIL_FIXTURE above).
  const giwaCapture = parcels.find((parcel) => parcel.parcelId === GIWA_CAPTURE_FIXTURE);
  const yardDetailFixture = parcels.find((parcel) => parcel.parcelId === YARD_DETAIL_FIXTURE);
  check(giwaCapture?.family === 'regular' && giwaCapture?.kind === 'giwa',
    `capital fixed giwa capture fixture remains a regular giwa (${giwaCapture?.parcelId || 'missing'})`);
  check(yardDetailFixture?.family === 'regular'
      && yardDetailFixture?.focusVisibility?.baseDetailVisibleCount === 0
      && yardDetailFixture?.focusVisibility?.detailVisibleCount >= 1,
    `fixed ${YARD_DETAIL_FIXTURE} bounded focus improves planned detail visibility (${
      yardDetailFixture?.focusVisibility?.baseDetailVisibleCount
    }→${yardDetailFixture?.focusVisibility?.detailVisibleCount}/${
      yardDetailFixture?.focusVisibility?.detailCount})`);
  const picks = [
    ['giwa', giwaCapture],
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
    // "One shared cutaway" means the live camera's near plane and the runtime's own report
    // are the same number, not that they equal a solve taken at the authored endpoint.
    // `visibility.terrainCutaway` re-solves from that authored pose (13.296m), while the
    // live camera has been lifted onto the ground cushion (see the elevation check above),
    // so the live solve legitimately differs (11.09m and still creeping). Compare the two
    // live readers against each other in the same frame — the same-frame realignment
    // f202204 applied to check-cinematic-reveal-app.mjs's cutaway assertion — and require the
    // live cutaway to be the same *decision* the planner made, still clipping ahead of the
    // house. The authored promise itself stays asserted by the preceding check.
    const live = terrainEvidence.continuum.focusCutaway;
    check(Math.abs(terrainEvidence.camera.near - live.near) < 1e-3
      && live.active
      && live.available
      && live.reason === 'cutaway'
      && cutaway.reason === 'cutaway'
      && live.blockedRays >= 1
      && live.minClearance < 0
      && live.near <= live.subjectNear - 1.2,
    `${TERRAIN_FIXTURE} applies one shared live-camera cutaway (${
      terrainEvidence.camera.near.toFixed(3)}m/${live.subjectNear.toFixed(3)}m, ${
      live.blockedRays} blocked rays)`);
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

  // The focus-in itself runs on the *real* product timeline here. Portrait is the one
  // viewport where the context sheet is an overlay, so selecting morphs the chrome — and
  // therefore the safe rectangle — while the dolly is still in flight. The product re-solves
  // the UI-safe framing when that chrome settles (engine.js#retargetOnChromeSettled), and
  // that path only exists while the tween is alive: seeking it to the end in one call raced
  // the 420ms sheet morph and left the live camera on a fit solved against pre-morph chrome
  // (measured on the palace landing: 30.9px left and 6.0px up of fit.projectedBounds, the
  // semantic box 31px outside the safe rectangle, and fit.scale 2.94 where the settled
  // chrome needs 3.54). Running the real timeline reproduces sub-pixel agreement with
  // fit.projectedBounds and a fully settled shift (x == tx) for both landmarks. The
  // intermediate focus-out is not under test and keeps the deterministic seek.
  async function mobileFocus(parcelId) {
    await mobile.evaluate(async (id) => {
      const engine = window.__engine;
      if (engine.village.getState().selected) {
        engine.village.return();
        for (let index = 0; index < 6; index++) await Promise.resolve();
        engine.debugDofSeek(1, { finish: true });
      }
      engine.village.debugFocus(id);
    }, parcelId);
    await mobile.waitForFunction((id) => {
      const state = window.__engine.village.getState();
      return state.selected === id && !state.transitioning;
    }, parcelId, { timeout });
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
      // Same stage/canvas pixel space the desktop capture uses. Portrait is full-bleed, so
      // this equals the page viewport there, but the space must not depend on that.
      const canvas = engine.renderer.domElement;
      const view = engine.camera.view;
      const width = (view?.enabled && view.fullWidth > 0)
        ? view.fullWidth : (canvas.clientWidth || innerWidth);
      const height = (view?.enabled && view.fullHeight > 0)
        ? view.fullHeight : (canvas.clientHeight || innerHeight);
      const box = { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity };
      for (const point of points) {
        const projected = engine.camera.position.clone().set(point.x, point.y, point.z).project(engine.camera);
        const x = (projected.x + 1) * width * 0.5;
        const y = (1 - projected.y) * height * 0.5;
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
