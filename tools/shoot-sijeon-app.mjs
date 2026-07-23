// Real-app visual contract for #128 sijeon integration.
//
// Boots the deterministic Hanyang product scene at the actual desktop and
// phone UI viewports. The app owns every camera/lens choice; this harness only
// settles that camera, preserves the product's aerial rim policy, and freezes
// the live loop before bracketing `village-sijeon.visible`. The same zero-dt
// composer render therefore proves a real canvas contribution without a
// harness-authored camera or renderer.
//
// Usage:
//   CHEOMA_BROWSER=chrome node tools/run-browser-locked.mjs -- \
//     node tools/shoot-sijeon-app.mjs [--out /scratch/path]
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
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
const TIMEOUT = Number(process.env.CHEOMA_SIJEON_APP_TIMEOUT_MS) || 180_000;

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
  : await mkdtemp(join(tmpdir(), 'cheoma-sijeon-app-shots-'));
const cacheDir = await mkdtemp(join(tmpdir(), 'cheoma-sijeon-app-cache-'));
await mkdir(outputDir, { recursive: true });

const failures = [];
const runtimeErrors = [];

function pass(condition, message, detail = '') {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${message}${detail ? ` (${detail})` : ''}`);
  if (!condition) failures.push(message);
}

function pixelDifference(firstBuffer, secondBuffer, threshold = 12) {
  const first = PNG.sync.read(firstBuffer);
  const second = PNG.sync.read(secondBuffer);
  if (first.width !== second.width || first.height !== second.height) {
    throw new Error(
      `capture dimensions differ: ${first.width}x${first.height} vs `
      + `${second.width}x${second.height}`,
    );
  }

  let changedPixels = 0;
  let exactChangedPixels = 0;
  let absoluteDelta = 0;
  let peakChannelDelta = 0;
  let minX = first.width;
  let minY = first.height;
  let maxX = -1;
  let maxY = -1;
  for (let offset = 0; offset < first.data.length; offset += 4) {
    const dr = Math.abs(first.data[offset] - second.data[offset]);
    const dg = Math.abs(first.data[offset + 1] - second.data[offset + 1]);
    const db = Math.abs(first.data[offset + 2] - second.data[offset + 2]);
    const sum = dr + dg + db;
    const peak = Math.max(dr, dg, db);
    absoluteDelta += sum;
    peakChannelDelta = Math.max(peakChannelDelta, peak);
    if (sum > 0) exactChangedPixels++;
    if (sum < threshold) continue;
    changedPixels++;
    const pixel = offset / 4;
    const x = pixel % first.width;
    const y = Math.floor(pixel / first.width);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }

  const pixels = first.width * first.height;
  return {
    width: first.width,
    height: first.height,
    changedPixels,
    changedRatio: changedPixels / pixels,
    exactChangedPixels,
    meanChannelDelta: absoluteDelta / (pixels * 3),
    peakChannelDelta,
    changedBounds: changedPixels ? {
      x: minX,
      y: minY,
      width: maxX - minX + 1,
      height: maxY - minY + 1,
    } : null,
  };
}

function sameCamera(first, second) {
  return JSON.stringify(first) === JSON.stringify(second);
}

async function waitForSettledProductCamera(page) {
  await page.evaluate(async () => {
    const engine = window.__engine;
    // A synchronous Hanyang build can itself exceed the nine-second idle
    // threshold on a cold browser. Mark ordinary product activity once so the
    // authored idle orbit does not begin while this harness is measuring the
    // end of the entry tween.
    window.dispatchEvent(new Event('pointermove'));
    let previous = null;
    let stableFrames = 0;
    for (let frame = 0; frame < 360; frame++) {
      await new Promise(requestAnimationFrame);
      const current = [
        ...engine.camera.position.toArray(),
        ...engine.camera.quaternion.toArray(),
        ...engine.__controls.target.toArray(),
        engine.camera.fov,
      ];
      const delta = previous
        ? Math.max(...current.map((value, index) => Math.abs(value - previous[index])))
        : Infinity;
      const cameraState = engine.village.debugCamera();
      const revealActive = engine.debugArchitecturalReveal?.().active === true;
      stableFrames = !cameraState.transitioning && !revealActive && delta < 1e-5
        ? stableFrames + 1
        : 0;
      previous = current;
      if (stableFrames >= 6) return;
    }
    throw new Error('Hanyang product camera did not settle');
  });
}

function wireRuntimeErrors(page, label) {
  page.on('pageerror', (error) => runtimeErrors.push(`${label} page: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' && !/favicon|404/i.test(message.text())) {
      runtimeErrors.push(`${label} console: ${message.text()}`);
    }
  });
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

const viewports = [
  {
    label: 'desktop',
    page: {
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
    },
  },
  {
    label: 'mobile',
    page: {
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 1,
      isMobile: true,
      hasTouch: true,
    },
  },
];

let browser;
const startedAt = Date.now();
try {
  await server.listen();
  const port = server.httpServer.address().port;
  browser = await launchVerificationBrowser();

  for (const viewport of viewports) {
    const viewportStartedAt = Date.now();
    const page = await browser.newPage(viewport.page);
    page.setDefaultTimeout(TIMEOUT);
    wireRuntimeErrors(page, viewport.label);
    await page.addInitScript(() => { window.__noWarm = true; });

    const url = `http://127.0.0.1:${port}/?hero=0&village=1&worker=0`
      + `&vscale=hanyang&vpalace=1&seed=42&vseed=${SEED}`
      + '&time=sunset&sunset=gold&season=autumn&weather=clear&lang=ko';
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    await page.waitForFunction(
      (seed) => window.__SHOT_READY === true
        && window.__engine?.village?.debugPlan?.()?.seed === seed
        && window.__engine?.village?.debugPlan?.()?.scale === 'hanyang'
        && window.__engine?.village?.debugPlan?.()?.sijeon > 0
        && !window.__engine.village.getState().transitioning,
      SEED,
      { timeout: TIMEOUT },
    );
    await waitForSettledProductCamera(page);
    // Camera settlement and the 1.3 s ink-fog reveal are independent product
    // timelines. Freeze only after the public read-only hero diagnostic says
    // that reveal ownership has ended, otherwise a fast phone boot captures a
    // legitimate intermediate veil instead of the final Hanyang composition.
    await page.waitForFunction(() => window.__hero?.reveal == null, null, { timeout: TIMEOUT });
    await reportWebGLRenderer(page, `sijeon-app-${viewport.label}`);

    const prepared = await page.evaluate(() => {
      const engine = window.__engine;
      const root = engine.village.exportRoot();
      const sijeon = root?.getObjectByName('village-sijeon');
      if (!root || !sijeon) throw new Error('missing product village-sijeon root');

      // Keep the product's canonical aerial pose, lens, view shift, and
      // focused-only rim policy. Only the URL-authored environment is settled.
      engine.setTime('sunset', { immediate: true });
      engine.setSeason('autumn', { immediate: true });
      engine.setWeather('clear', { immediate: true });
      engine.debugAdvancePost(2);
      engine.debugSetPaused(true);
      for (let index = 0; index < 4; index++) engine.debugRenderDofFrame();

      root.updateMatrixWorld(true);
      const camera = engine.camera;
      const ndc = {
        min: [Infinity, Infinity, Infinity],
        max: [-Infinity, -Infinity, -Infinity],
      };
      const world = {
        min: [Infinity, Infinity, Infinity],
        max: [-Infinity, -Infinity, -Infinity],
      };
      let meshCount = 0;
      let triangleCount = 0;
      let finite = true;
      let descendantsVisible = true;
      const materialRoles = new Set();
      sijeon.traverse((object) => {
        finite &&= object.matrixWorld.elements.every(Number.isFinite);
        descendantsVisible &&= object.visible;
        if (!object.isMesh || !object.geometry) return;
        meshCount++;
        const geometry = object.geometry;
        if (!geometry.boundingBox) geometry.computeBoundingBox();
        const box = geometry.boundingBox;
        finite &&= !!box
          && box.min.toArray().every(Number.isFinite)
          && box.max.toArray().every(Number.isFinite);
        const positionCount = geometry.attributes.position?.count || 0;
        triangleCount += (geometry.index?.count || positionCount) / 3;
        for (const material of Array.isArray(object.material)
          ? object.material : [object.material]) {
          if (material?.userData?.role) materialRoles.add(material.userData.role);
        }
        if (!box) return;
        for (const x of [box.min.x, box.max.x]) {
          for (const y of [box.min.y, box.max.y]) {
            for (const z of [box.min.z, box.max.z]) {
              const point = object.position.clone().set(x, y, z).applyMatrix4(object.matrixWorld);
              finite &&= point.toArray().every(Number.isFinite);
              for (let axis = 0; axis < 3; axis++) {
                world.min[axis] = Math.min(world.min[axis], point.getComponent(axis));
                world.max[axis] = Math.max(world.max[axis], point.getComponent(axis));
              }
              point.project(camera);
              finite &&= point.toArray().every(Number.isFinite);
              for (let axis = 0; axis < 3; axis++) {
                ndc.min[axis] = Math.min(ndc.min[axis], point.getComponent(axis));
                ndc.max[axis] = Math.max(ndc.max[axis], point.getComponent(axis));
              }
            }
          }
        }
      });

      let hierarchyVisible = true;
      for (let object = sijeon; object; object = object.parent) {
        hierarchyVisible &&= object.visible;
      }
      const overlapsClip = ndc.max[0] >= -1 && ndc.min[0] <= 1
        && ndc.max[1] >= -1 && ndc.min[1] <= 1
        && ndc.max[2] >= -1 && ndc.min[2] <= 1;
      const cameraState = {
        position: camera.position.toArray(),
        quaternion: camera.quaternion.toArray(),
        target: engine.__controls.target.toArray(),
        fov: camera.fov,
        projection: camera.projectionMatrix.toArray(),
      };
      const rect = engine.renderer.domElement.getBoundingClientRect();
      return {
        plan: engine.village.debugPlan(),
        metadata: structuredClone(sijeon.userData.sijeon),
        meshCount,
        triangleCount,
        materialRoles: [...materialRoles].sort(),
        finite,
        hierarchyVisible,
        descendantsVisible,
        overlapsClip,
        world,
        ndc,
        camera: cameraState,
        canvas: {
          cssWidth: rect.width,
          cssHeight: rect.height,
          drawingWidth: engine.renderer.domElement.width,
          drawingHeight: engine.renderer.domElement.height,
        },
        postPasses: engine.debugPostPassOrder(),
        rim: window.__rim ? {
          mode: window.__rim.mode,
          patched: window.__rim.patched,
          strength: window.__rim.strength,
          scale: window.__rim.scale,
        } : null,
      };
    });

    // Keep one real UI-viewport review frame, then hide only DOM chrome for the
    // pixel bracket. Playwright element screenshots include overlapping DOM
    // (not just the canvas backing store), and the phone guide has independent
    // CSS transitions. `visibility` preserves layout, so camera projection and
    // the product canvas remain byte-for-byte untouched.
    const viewportPath = join(outputDir, `${viewport.label}-ui-restored.png`);
    await page.screenshot({ path: viewportPath });
    await page.evaluate(() => {
      const canvas = window.__engine.renderer.domElement;
      const keep = new Set();
      for (let current = canvas; current; current = current.parentElement) keep.add(current);
      for (const element of document.querySelectorAll('*')) {
        if (!keep.has(element)) element.style.setProperty('visibility', 'hidden', 'important');
      }
      const freezeCss = document.createElement('style');
      freezeCss.textContent = '* { animation: none !important; transition: none !important; }';
      document.head.appendChild(freezeCss);
    });

    const canvas = page.locator('canvas').first();
    const visiblePath = join(outputDir, `${viewport.label}-sijeon-visible.png`);
    const visibleBuffer = await canvas.screenshot({ path: visiblePath });

    const cameraAfterHide = await page.evaluate(() => {
      const engine = window.__engine;
      const sijeon = engine.village.exportRoot()?.getObjectByName('village-sijeon');
      if (!sijeon) throw new Error('village-sijeon disappeared before hide bracket');
      sijeon.visible = false;
      engine.debugRenderDofFrame();
      engine.debugRenderDofFrame();
      return {
        position: engine.camera.position.toArray(),
        quaternion: engine.camera.quaternion.toArray(),
        target: engine.__controls.target.toArray(),
        fov: engine.camera.fov,
        projection: engine.camera.projectionMatrix.toArray(),
      };
    });
    const hiddenPath = join(outputDir, `${viewport.label}-sijeon-hidden.png`);
    const hiddenBuffer = await canvas.screenshot({ path: hiddenPath });

    const cameraAfterRestore = await page.evaluate(() => {
      const engine = window.__engine;
      const sijeon = engine.village.exportRoot()?.getObjectByName('village-sijeon');
      if (!sijeon) throw new Error('village-sijeon disappeared before restore bracket');
      sijeon.visible = true;
      sijeon.updateMatrixWorld(true);
      engine.debugRenderDofFrame();
      engine.debugRenderDofFrame();
      return {
        position: engine.camera.position.toArray(),
        quaternion: engine.camera.quaternion.toArray(),
        target: engine.__controls.target.toArray(),
        fov: engine.camera.fov,
        projection: engine.camera.projectionMatrix.toArray(),
      };
    });
    const restoredPath = join(outputDir, `${viewport.label}-sijeon-restored.png`);
    const restoredBuffer = await canvas.screenshot({ path: restoredPath });

    const visibleVsHidden = pixelDifference(visibleBuffer, hiddenBuffer);
    const restoredVsHidden = pixelDifference(restoredBuffer, hiddenBuffer);
    const visibleVsRestored = pixelDifference(visibleBuffer, restoredBuffer);
    const cameraStable = sameCamera(prepared.camera, cameraAfterHide)
      && sameCamera(prepared.camera, cameraAfterRestore);
    const minimumContribution = Math.max(
      8,
      Math.ceil(visibleVsHidden.width * visibleVsHidden.height * 0.000001),
    );

    pass(prepared.plan.scale === 'hanyang' && prepared.plan.seed === SEED
        && prepared.plan.sijeon > 0,
    `${viewport.label}: deterministic Hanyang includes planned sijeon`,
    `shops=${prepared.plan.sijeon} seed=${prepared.plan.seed}`);
    pass(prepared.metadata?.shopCount === prepared.plan.sijeon
        && prepared.metadata?.shopIds?.length === prepared.plan.sijeon,
    `${viewport.label}: rendered sijeon owns every planned shop`,
    `rendered=${prepared.metadata?.shopCount ?? 'missing'}`);
    pass(prepared.meshCount > 0 && prepared.triangleCount > 0,
      `${viewport.label}: sijeon contains drawable geometry`,
      `meshes=${prepared.meshCount} triangles=${prepared.triangleCount}`);
    pass(prepared.finite, `${viewport.label}: sijeon transforms and bounds are finite`);
    pass(prepared.hierarchyVisible && prepared.descendantsVisible,
      `${viewport.label}: sijeon is visible through its complete scene hierarchy`);
    pass(prepared.overlapsClip, `${viewport.label}: sijeon bounds overlap the product camera frustum`,
      `ndc=${JSON.stringify(prepared.ndc)}`);
    pass(prepared.postPasses[0] === 'RenderPass'
        && prepared.postPasses.at(-1) === 'OutputPass'
        && prepared.postPasses.includes('UnrealBloomPass'),
    `${viewport.label}: canonical product post composer is active`,
    prepared.postPasses.join(' → '));
    pass(prepared.rim?.mode === 'fresnel'
        && prepared.rim.scale === 0
        && prepared.rim.strength > 0
        && prepared.rim.patched > 0,
    `${viewport.label}: product aerial keeps Fresnel materials patched but unlit`,
    JSON.stringify(prepared.rim));
    pass(visibleVsHidden.changedPixels >= minimumContribution
        && visibleVsHidden.peakChannelDelta >= 4,
    `${viewport.label}: village-sijeon contributes visible canvas pixels`,
    `changed=${visibleVsHidden.changedPixels} `
      + `(${(visibleVsHidden.changedRatio * 100).toFixed(4)}%) `
      + `mean=${visibleVsHidden.meanChannelDelta.toFixed(5)} `
      + `peak=${visibleVsHidden.peakChannelDelta}`);
    pass(restoredVsHidden.changedPixels >= minimumContribution,
      `${viewport.label}: restored sijeon contribution is repeatable`,
      `changed=${restoredVsHidden.changedPixels}`);
    pass(visibleVsRestored.changedPixels === 0 && visibleVsRestored.exactChangedPixels === 0,
      `${viewport.label}: visibility bracket restores the exact product frame`,
      `threshold=${visibleVsRestored.changedPixels} exact=${visibleVsRestored.exactChangedPixels}`);
    pass(cameraStable, `${viewport.label}: verification never mutates the product camera`);
    pass(prepared.canvas.cssWidth === viewport.page.viewport.width
        && prepared.canvas.cssHeight === viewport.page.viewport.height,
    `${viewport.label}: canvas uses the requested UI viewport`,
    `${prepared.canvas.cssWidth}x${prepared.canvas.cssHeight} CSS px`);

    console.log(`METRICS ${viewport.label} ${JSON.stringify({
      viewport: prepared.canvas,
      worldBounds: prepared.world,
      ndcBounds: prepared.ndc,
      materialRoles: prepared.materialRoles,
      visibleVsHidden,
      restoredVsHidden,
      visibleVsRestored,
      elapsedMs: Date.now() - viewportStartedAt,
    })}`);
    console.log(`VISUAL ${visiblePath}`);
    console.log(`VISUAL ${hiddenPath}`);
    console.log(`VISUAL ${restoredPath}`);
    console.log(`VISUAL ${viewportPath}`);
    await page.close();
  }

  pass(runtimeErrors.length === 0, 'browser console remains clean', runtimeErrors[0] || '');
} catch (error) {
  failures.push(error instanceof Error ? error.stack || error.message : String(error));
} finally {
  await browser?.close().catch(() => {});
  await server.close().catch(() => {});
  await rm(cacheDir, { recursive: true, force: true });
}

console.log(`SIJEON APP: ${failures.length ? 'FAIL' : 'PASS'} `
  + `elapsed=${((Date.now() - startedAt) / 1000).toFixed(2)}s output=${outputDir}`);
if (runtimeErrors.length) {
  for (const error of runtimeErrors) console.error(`ERROR ${error}`);
}
if (failures.length) {
  for (const failure of failures) console.error(`FAILURE ${failure}`);
  process.exitCode = 1;
}
