// #96 nightlight representation A/B in the real app and #88 DoF pipeline.
// Run through tools/run-browser-locked.mjs so parallel worktrees share Chrome.
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
const timeout = Number(process.env.CHEOMA_NIGHTLIGHT_GEOMETRY_TIMEOUT_MS) || 180_000;
const outArg = process.argv.find((arg) => arg.startsWith('--out='));
const outDir = outArg
  ? resolve(outArg.slice('--out='.length))
  : await mkdtemp(join(tmpdir(), 'cheoma-nightlight-geometry-'));
await mkdir(outDir, { recursive: true });
const cacheDir = await mkdtemp(join(tmpdir(), 'cheoma-nightlight-geometry-cache-'));
const errors = [];

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.floor(sorted.length / 2)];
}

function imageStats(buffer) {
  const image = PNG.sync.read(buffer);
  let warmPixels = 0;
  let warmEnergy = 0;
  let peakWarm = 0;
  for (let offset = 0; offset < image.data.length; offset += 4) {
    const r = image.data[offset];
    const g = image.data[offset + 1];
    const b = image.data[offset + 2];
    const warm = Math.max(0, r - b) + Math.max(0, g - b) * 0.25;
    if (r > 105 && r > b + 20 && g > b + 6) warmPixels++;
    warmEnergy += warm;
    peakWarm = Math.max(peakWarm, warm);
  }
  return { width: image.width, height: image.height, warmPixels, warmEnergy, peakWarm };
}

function imageDifference(firstBuffer, secondBuffer) {
  const first = PNG.sync.read(firstBuffer);
  const second = PNG.sync.read(secondBuffer);
  if (first.width !== second.width || first.height !== second.height) {
    throw new Error('nightlight A/B image dimensions differ');
  }
  let changed = 0;
  let absolute = 0;
  let max = 0;
  for (let offset = 0; offset < first.data.length; offset += 4) {
    const delta = Math.max(
      Math.abs(first.data[offset] - second.data[offset]),
      Math.abs(first.data[offset + 1] - second.data[offset + 1]),
      Math.abs(first.data[offset + 2] - second.data[offset + 2]),
    );
    if (delta >= 4) changed++;
    absolute += delta;
    max = Math.max(max, delta);
  }
  return {
    changedPixels: changed,
    changedRatio: changed / (first.width * first.height),
    meanAbsolute: absolute / (first.width * first.height),
    max,
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
    + '&vscale=hanyang&seed=42&vseed=20260716&time=night&season=autumn&weather=clear';
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
  await page.waitForFunction(() => window.__SHOT_READY === true
    && window.__engine?.village?.debugPlan?.()?.seed === 20260716
    && !window.__engine.village.getState().transitioning, null, { timeout });
  const gpuInfo = await reportWebGLRenderer(page, 'nightlight-geometry');

  const fixture = await page.evaluate(() => {
    const engine = window.__engine;
    const group = engine.scene.getObjectByName('village-nightlights');
    const api = group?.userData?.nightLights;
    if (!api?.debugSetRepresentationForTest) {
      throw new Error('product nightlight A/B hook is unavailable');
    }
    engine.setTime('night', { immediate: true });
    engine.setSeason('autumn', { immediate: true });
    engine.setWeather('clear', { immediate: true });
    const parcels = engine.village.debugParcels()
      .filter((parcel) => !parcel.hero && parcel.editable
        && (parcel.kind === 'giwa' || parcel.kind === 'choga'))
      .map((parcel) => ({ parcel, owner: api.debugOwner(parcel.parcelId) }))
      .filter(({ owner }) => owner?.selected?.length > 0)
      .sort((a, b) => a.parcel.parcelId.localeCompare(b.parcel.parcelId));
    const chosen = parcels.find(({ parcel }) => parcel.parcelId === 'p13') || parcels[0];
    if (!chosen) throw new Error('no regular nightlight fixture');
    return {
      parcel: chosen.parcel,
      owner: chosen.owner,
      initial: api.debugState(),
      initialRepresentation: api.debugRepresentation(),
    };
  });

  await page.evaluate(() => {
    const style = document.createElement('style');
    style.textContent = 'body * { visibility: hidden !important; } canvas { visibility: visible !important; }';
    document.head.appendChild(style);
    window.__engine.debugSetPaused(true);
  });

  async function setFrame(kind) {
    if (kind === 'aerial') {
      return page.evaluate(() => {
        const engine = window.__engine;
        const camera = engine.camera;
        camera.fov = 46;
        camera.userData.villageReferenceFov = 46;
        camera.updateProjectionMatrix();
        camera.lookAt(engine.__controls.target);
        engine.__controls.update();
        engine.debugTuneDof({ amount: 0 });
        engine.debugSyncCameraEnvironment();
        const api = engine.scene.getObjectByName('village-nightlights').userData.nightLights;
        api.update(0, 1, 1);
        return {
          fov: camera.fov,
          position: camera.position.toArray(),
          target: engine.__controls.target.toArray(),
        };
      });
    }

    await page.evaluate((parcelId) => {
      window.__engine.debugSetPaused(false);
      window.__engine.village.debugFocus(parcelId);
    }, fixture.parcel.parcelId);
    await page.waitForFunction((parcelId) => {
      const state = window.__engine.village.getState();
      return state.selected === parcelId && !state.transitioning;
    }, fixture.parcel.parcelId, { timeout });
    return page.evaluate(() => {
      const engine = window.__engine;
      engine.debugDofSeek(1, { finish: true });
      engine.debugSetPaused(true);
      const camera = engine.camera;
      const controls = engine.__controls;
      const oldFov = camera.fov;
      const direction = camera.position.clone().sub(controls.target);
      const oldDistance = Math.max(direction.length(), 0.001);
      direction.normalize();
      const targetFov = 7;
      const newDistance = oldDistance
        * Math.tan(oldFov * Math.PI / 360)
        / Math.tan(targetFov * Math.PI / 360);
      camera.position.copy(controls.target).addScaledVector(direction, newDistance);
      controls.maxDistance = Math.max(controls.maxDistance, newDistance * 1.05);
      camera.fov = targetFov;
      camera.updateProjectionMatrix();
      camera.lookAt(controls.target);
      controls.update();
      engine.debugSyncCameraEnvironment();
      const referenceFov = camera.userData.villageReferenceFov ?? 46;
      const lensScale = Math.tan(referenceFov * Math.PI / 360)
        / Math.tan(camera.fov * Math.PI / 360);
      const api = engine.scene.getObjectByName('village-nightlights').userData.nightLights;
      api.update(0, 1, lensScale);
      return {
        fov: camera.fov,
        oldFov,
        oldDistance,
        distance: newDistance,
        lensScale,
        position: camera.position.toArray(),
        target: controls.target.toArray(),
        dof: engine.debugDof(),
      };
    });
  }

  async function projectedArea(mode) {
    return page.evaluate(async (nextMode) => {
      const THREE = await import('/node_modules/three/build/three.module.js');
      const engine = window.__engine;
      const api = engine.scene.getObjectByName('village-nightlights').userData.nightLights;
      api.debugSetRepresentationForTest(nextMode);
      const object = api.group.children[0];
      object.updateWorldMatrix(true, false);
      const camera = engine.camera;
      const width = engine.renderer.domElement.width;
      const height = engine.renderer.domElement.height;
      const project = (point) => {
        const ndc = point.project(camera);
        return [(ndc.x * 0.5 + 0.5) * width, (-ndc.y * 0.5 + 0.5) * height];
      };
      const smooth = (a, b, x) => {
        const t = Math.max(0, Math.min(1, (x - a) / Math.max(b - a, 1e-6)));
        return t * t * (3 - 2 * t);
      };
      const uniforms = object.material.uniforms;
      const phase = object.geometry.getAttribute('aPhase');
      const lit = object.geometry.getAttribute('aLit');
      const threshold = object.geometry.getAttribute('aThreshold');
      let area = 0;
      let active = 0;
      if (object.isPoints) {
        const positions = object.geometry.getAttribute('position');
        const scale = object.geometry.getAttribute('aScale');
        const mv = new THREE.Vector3();
        const world = new THREE.Vector3();
        for (let index = 0; index < positions.count; index++) {
          const on = smooth(threshold.getX(index), threshold.getX(index) + 0.16, uniforms.uNight.value);
          if (lit.getX(index) * on <= 0.002) continue;
          world.fromBufferAttribute(positions, index).applyMatrix4(object.matrixWorld);
          mv.copy(world).applyMatrix4(camera.matrixWorldInverse);
          if (mv.z >= -0.001) continue;
          const distance = Math.max(-mv.z, 0.001);
          const visual = distance / Math.max(uniforms.uLensScale.value, 0.0001);
          const nearFade = smooth(uniforms.uFadeNear.value, uniforms.uFadeNearEnd.value, visual);
          if (nearFade <= 0.002) continue;
          let px = uniforms.uSizeBase.value * scale.getX(index)
            * uniforms.uPixelRatio.value * uniforms.uLensScale.value / distance;
          px = Math.max(
            uniforms.uMinPx.value * uniforms.uPixelRatio.value,
            Math.min(uniforms.uMaxPx.value * uniforms.uPixelRatio.value, px),
          );
          const center = project(world.clone());
          const radius = px * 0.5;
          const clippedWidth = Math.max(
            0,
            Math.min(width, center[0] + radius) - Math.max(0, center[0] - radius),
          );
          const clippedHeight = Math.max(
            0,
            Math.min(height, center[1] + radius) - Math.max(0, center[1] - radius),
          );
          area += Math.PI * radius * radius
            * clippedWidth * clippedHeight / Math.max(px * px, 1e-6);
          active++;
        }
      } else {
        const anchors = object.geometry.getAttribute('aAnchor');
        const outward = object.geometry.getAttribute('aOutward');
        const sizes = object.geometry.getAttribute('aOpeningSize');
        const anchor = new THREE.Vector3();
        const normal = new THREE.Vector3();
        const right = new THREE.Vector3();
        const up = new THREE.Vector3();
        const toCamera = new THREE.Vector3();
        for (let index = 0; index < anchors.count; index++) {
          const on = smooth(threshold.getX(index), threshold.getX(index) + 0.16, uniforms.uNight.value);
          if (lit.getX(index) * on <= 0.002 || Math.min(sizes.getX(index), sizes.getY(index)) <= 0.001) continue;
          anchor.fromBufferAttribute(anchors, index).applyMatrix4(object.matrixWorld);
          normal.fromBufferAttribute(outward, index).transformDirection(object.matrixWorld);
          toCamera.copy(camera.position).sub(anchor);
          if (normal.dot(toCamera) <= 0) continue;
          const view = anchor.clone().applyMatrix4(camera.matrixWorldInverse);
          if (view.z >= -0.001) continue;
          const visual = Math.max(-view.z, 0.001) / Math.max(uniforms.uLensScale.value, 0.0001);
          const nearFade = smooth(uniforms.uFadeNear.value, uniforms.uFadeNearEnd.value, visual);
          if (nearFade <= 0.002) continue;
          right.crossVectors(new THREE.Vector3(0, 1, 0), normal).normalize()
            .multiplyScalar(sizes.getX(index) * 0.5);
          up.crossVectors(normal, right).normalize()
            .multiplyScalar(sizes.getY(index) * 0.5);
          const corners = [
            anchor.clone().sub(right).sub(up),
            anchor.clone().add(right).sub(up),
            anchor.clone().add(right).add(up),
            anchor.clone().sub(right).add(up),
          ].map(project);
          let polygon = 0;
          for (let corner = 0; corner < 4; corner++) {
            const a = corners[corner];
            const b = corners[(corner + 1) % 4];
            polygon += a[0] * b[1] - b[0] * a[1];
          }
          const polygonArea = Math.abs(polygon) * 0.5;
          const minX = Math.min(...corners.map((corner) => corner[0]));
          const maxX = Math.max(...corners.map((corner) => corner[0]));
          const minY = Math.min(...corners.map((corner) => corner[1]));
          const maxY = Math.max(...corners.map((corner) => corner[1]));
          const clippedWidth = Math.max(0, Math.min(width, maxX) - Math.max(0, minX));
          const clippedHeight = Math.max(0, Math.min(height, maxY) - Math.max(0, minY));
          area += Math.min(polygonArea, clippedWidth * clippedHeight);
          active++;
        }
      }
      return {
        mode: nextMode,
        active,
        area,
        canvasArea: width * height,
        ratio: area / (width * height),
        representation: api.debugRepresentation(),
      };
    }, mode);
  }

  async function capture(frame, mode) {
    const state = await page.evaluate((nextMode) => {
      const engine = window.__engine;
      const api = engine.scene.getObjectByName('village-nightlights').userData.nightLights;
      api.debugSetRepresentationForTest(nextMode);
      engine.debugRenderDofFrame();
      engine.debugRenderDofFrame();
      return {
        resource: api.debugState(),
        representation: api.debugRepresentation(),
        programs: engine.renderer.info.programs?.length || 0,
        sourceDepthMaterials: engine.debugPostResources().bokehPass.sourceDepthMaterialCount,
      };
    }, mode);
    const path = join(outDir, `${frame}-${mode}.png`);
    const buffer = await page.locator('canvas').screenshot({ path });
    return { path, buffer, state, image: imageStats(buffer) };
  }

  async function gpuAbba() {
    return page.evaluate(async () => {
      const engine = window.__engine;
      const renderer = engine.renderer;
      const gl = renderer.getContext();
      const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
      const api = engine.scene.getObjectByName('village-nightlights').userData.nightLights;
      const savedBackground = engine.scene.background;
      const savedLayers = engine.camera.layers.mask;
      const batchSize = 64;
      const totalBatchSize = 2;
      for (let index = 0; index < 90; index++) engine.debugAdvancePostQuality(1 / 60);
      const measureColor = async (mode) => {
        api.debugSetRepresentationForTest(mode);
        const object = api.group.children[0];
        object.layers.set(31);
        engine.camera.layers.set(31);
        engine.scene.background = null;
        // Both representations were already compiled through the real DoF
        // captures. One untimed direct draw settles the layer-only color path
        // without compiling unrelated hidden village materials.
        renderer.render(engine.scene, engine.camera);
        if (!ext || typeof gl.createQuery !== 'function') {
          const started = performance.now();
          for (let index = 0; index < batchSize; index++) renderer.render(engine.scene, engine.camera);
          object.layers.set(0);
          return { mode, gpuMs: null, cpuMs: (performance.now() - started) / batchSize };
        }
        const query = gl.createQuery();
        gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
        for (let index = 0; index < batchSize; index++) renderer.render(engine.scene, engine.camera);
        gl.endQuery(ext.TIME_ELAPSED_EXT);
        gl.flush();
        const deadline = performance.now() + 3000;
        while (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)
          && performance.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 4));
        }
        const available = gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE);
        const disjoint = !!gl.getParameter(ext.GPU_DISJOINT_EXT);
        const gpuMs = available && !disjoint
          ? gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6 / batchSize
          : null;
        gl.deleteQuery(query);
        object.layers.set(0);
        return { mode, gpuMs, cpuMs: null, disjoint, available };
      };
      const measureTotal = async (mode) => {
        api.debugSetRepresentationForTest(mode);
        engine.debugRenderDofFrame();
        if (!ext || typeof gl.createQuery !== 'function') {
          const started = performance.now();
          for (let index = 0; index < totalBatchSize; index++) engine.debugRenderDofFrame();
          return {
            mode,
            gpuMs: null,
            cpuMs: (performance.now() - started) / totalBatchSize,
          };
        }
        const query = gl.createQuery();
        gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
        for (let index = 0; index < totalBatchSize; index++) engine.debugRenderDofFrame();
        gl.endQuery(ext.TIME_ELAPSED_EXT);
        gl.flush();
        const deadline = performance.now() + 4000;
        while (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)
          && performance.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 4));
        }
        const available = gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE);
        const disjoint = !!gl.getParameter(ext.GPU_DISJOINT_EXT);
        const gpuMs = available && !disjoint
          ? gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6 / totalBatchSize
          : null;
        gl.deleteQuery(query);
        return { mode, gpuMs, cpuMs: null, disjoint, available };
      };
      const colorSamples = [];
      const totalSamples = [];
      const sequences = [];
      for (let block = 0; block < 3; block++) {
        const sequence = block % 2 === 0
          ? ['points', 'physical', 'physical', 'points']
          : ['physical', 'points', 'points', 'physical'];
        sequences.push(sequence);
        for (const mode of sequence) colorSamples.push(await measureColor(mode));
      }
      engine.scene.background = savedBackground;
      engine.camera.layers.mask = savedLayers;
      for (const sequence of sequences) {
        for (const mode of sequence) totalSamples.push(await measureTotal(mode));
      }
      api.debugSetRepresentationForTest('points');
      engine.debugRenderDofFrame();
      return {
        batchSize,
        totalBatchSize,
        colorSamples,
        totalSamples,
        programsAfter: renderer.info.programs?.length || 0,
      };
    });
  }

  const aerialFrame = await setFrame('aerial');
  const aerialArea = {
    points: await projectedArea('points'),
    physical: await projectedArea('physical'),
  };
  const aerial = {
    points: await capture('aerial-46deg', 'points'),
    physical: await capture('aerial-46deg', 'physical'),
  };
  const aerialGpu = await gpuAbba();

  const focusFrame = await setFrame('focus');
  const focusArea = {
    points: await projectedArea('points'),
    physical: await projectedArea('physical'),
  };
  const focus = {
    points: await capture('focus-7deg', 'points'),
    physical: await capture('focus-7deg', 'physical'),
  };
  await page.evaluate(() => {
    const engine = window.__engine;
    engine.debugTuneDof({ amount: 0 });
  });
  const focusPhysicalDofOff = await capture('focus-7deg-physical-dof-off', 'physical');
  await page.evaluate(() => {
    const engine = window.__engine;
    engine.debugTuneDof({ amount: 1 });
    engine.debugRenderDofFrame();
  });
  const focusGpu = await gpuAbba();

  const programBefore = await page.evaluate(
    () => window.__engine.renderer.info.programs?.length || 0,
  );
  const programSwitchPlateau = await page.evaluate(() => {
    const engine = window.__engine;
    const api = engine.scene.getObjectByName('village-nightlights').userData.nightLights;
    for (let index = 0; index < 90; index++) engine.debugAdvancePostQuality(1 / 60);
    const series = [];
    for (let index = 0; index < 24; index++) {
      api.debugSetRepresentationForTest(index % 2 ? 'physical' : 'points');
      engine.debugRenderDofFrame();
      series.push(engine.renderer.info.programs?.length || 0);
    }
    const tail = series.slice(-8);
    return {
      series,
      after: series.at(-1),
      stable: tail.every((value) => value === tail[0]),
    };
  });

  const pointGpu = median(aerialGpu.colorSamples.filter((sample) => sample.mode === 'points')
    .map((sample) => sample.gpuMs));
  const physicalGpu = median(aerialGpu.colorSamples.filter((sample) => sample.mode === 'physical')
    .map((sample) => sample.gpuMs));
  const gpuRatio = pointGpu && physicalGpu ? physicalGpu / pointGpu : null;
  const absoluteFarSavingMs = pointGpu != null && physicalGpu != null
    ? physicalGpu - pointGpu : null;
  const focusPointTotal = median(focusGpu.totalSamples
    .filter((sample) => sample.mode === 'points').map((sample) => sample.gpuMs));
  const focusPhysicalTotal = median(focusGpu.totalSamples
    .filter((sample) => sample.mode === 'physical').map((sample) => sample.gpuMs));
  const focusTotalRatio = focusPointTotal && focusPhysicalTotal
    ? focusPhysicalTotal / focusPointTotal : null;
  // A FAR approximation survives only when both its relative and absolute
  // savings matter at product count. Sub-0.1ms timer differences are noise
  // and not enough to justify a second representation/program family.
  const largeFarAdvantage = gpuRatio != null
    && gpuRatio >= 1.35
    && absoluteFarSavingMs >= 0.1;
  const recommendation = largeFarAdvantage
    ? 'retain-points-far-physical-near'
    : 'single-physical-proxy-outside-full-hanji-handoff';

  const report = {
    seed: 20260716,
    browser: gpuInfo,
    fixture,
    frames: { aerial: aerialFrame, focus: focusFrame },
    resource: {
      points: aerial.points.state,
      physical: aerial.physical.state,
      focusPoints: focus.points.state,
      focusPhysical: focus.physical.state,
      programBefore,
      programAfterSwitches: programSwitchPlateau.after,
      programSeries: programSwitchPlateau.series,
      programPlateau: programSwitchPlateau.stable,
    },
    projectedArea: { aerial: aerialArea, focus: focusArea },
    image: {
      aerial: {
        points: aerial.points.image,
        physical: aerial.physical.image,
        difference: imageDifference(aerial.points.buffer, aerial.physical.buffer),
      },
      focus: {
        points: focus.points.image,
        physical: focus.physical.image,
        difference: imageDifference(focus.points.buffer, focus.physical.buffer),
        physicalDofOff: focusPhysicalDofOff.image,
        physicalDofDifference: imageDifference(
          focusPhysicalDofOff.buffer,
          focus.physical.buffer,
        ),
      },
    },
    gpu: {
      aerial: {
        ...aerialGpu,
        pointColorMedianMs: pointGpu,
        physicalColorMedianMs: physicalGpu,
        physicalToPointColorRatio: gpuRatio,
        pointAbsoluteSavingMs: absoluteFarSavingMs,
      },
      focus: {
        ...focusGpu,
        pointTotalMedianMs: focusPointTotal,
        physicalTotalMedianMs: focusPhysicalTotal,
        physicalToPointTotalRatio: focusTotalRatio,
      },
      farRetentionThreshold: {
        relative: 1.35,
        absoluteMs: 0.1,
        passed: largeFarAdvantage,
      },
    },
    recommendation,
    captures: {
      aerialPoints: aerial.points.path,
      aerialPhysical: aerial.physical.path,
      focusPoints: focus.points.path,
      focusPhysical: focus.physical.path,
      focusPhysicalDofOff: focusPhysicalDofOff.path,
    },
    errors,
  };
  await writeFile(
    join(outDir, 'nightlight-geometry-report.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  );

  if (aerialFrame.fov !== 46 || focusFrame.fov !== 7) {
    throw new Error(`camera contract failed: aerial=${aerialFrame.fov}, focus=${focusFrame.fov}`);
  }
  if (aerial.physical.state.resource.drawCalls !== 1
    || aerial.physical.state.resource.dofDepthDrawCalls !== 1
    || aerial.physical.state.resource.programs !== 2
    || aerial.physical.state.resource.lights !== 0
    || aerial.physical.state.resource.textures !== 0
    || focus.physical.state.sourceDepthMaterials !== 1) {
    throw new Error('physical nightlights broke fixed resource/source-depth contract');
  }
  if (!report.resource.programPlateau) {
    throw new Error(`program count did not plateau: ${programSwitchPlateau.series.join('→')}`);
  }
  if (report.image.focus.physicalDofDifference.changedPixels < 100) {
    throw new Error('7deg physical frame did not exercise optical defocus');
  }
  if (errors.length) throw new Error(errors.join('; '));

  console.log(`NIGHTLIGHT GEOMETRY GPU: aerial color points=${pointGpu?.toFixed(4) || 'n/a'}ms `
    + `physical=${physicalGpu?.toFixed(4) || 'n/a'}ms ratio=${gpuRatio?.toFixed(3) || 'n/a'} `
    + `saving=${absoluteFarSavingMs?.toFixed(4) || 'n/a'}ms`);
  console.log(`NIGHTLIGHT GEOMETRY GPU: focus total points=${focusPointTotal?.toFixed(3) || 'n/a'}ms `
    + `physical=${focusPhysicalTotal?.toFixed(3) || 'n/a'}ms ratio=${focusTotalRatio?.toFixed(3) || 'n/a'}`);
  console.log(`NIGHTLIGHT GEOMETRY AREA: aerial points=${aerialArea.points.ratio.toFixed(6)} `
    + `physical=${aerialArea.physical.ratio.toFixed(6)}; focus points=${focusArea.points.ratio.toFixed(6)} `
    + `physical=${focusArea.physical.ratio.toFixed(6)}`);
  console.log(`NIGHTLIGHT GEOMETRY POLICY: ${recommendation}`);
  console.log(`NIGHTLIGHT GEOMETRY REPORT: ${join(outDir, 'nightlight-geometry-report.json')}`);
  console.log(`NIGHTLIGHT GEOMETRY VISUAL: ${aerial.physical.path}`);
  console.log(`NIGHTLIGHT GEOMETRY VISUAL: ${focus.physical.path}`);
  console.log('NIGHTLIGHT GEOMETRY: PASS');
} finally {
  await browser?.close();
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
}
