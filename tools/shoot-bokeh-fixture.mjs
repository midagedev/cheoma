// Controlled visual proof for issue #24: the product's real post stack must turn
// isolated foreground/background HDR lights into round aperture images, while a
// subject on the focus plane stays sharp. Captures live in an OS temp directory.
//
// This is intentionally an app-level fixture, not a second rendering setup. It
// boots the normal engine and StableBokehPass, pauses the product loop, then swaps
// only the visible scene content for a deterministic optical chart. No production
// object, pass, shader, or draw call is added by this tool.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PNG } from 'pngjs';
import { createServer } from '../app/node_modules/vite/dist/node/index.js';
import { launchVerificationBrowser, reportWebGLRenderer } from './lib/verification-browser.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const APP_ROOT = join(ROOT, 'app');
const cacheDir = await mkdtemp(join(tmpdir(), 'cheoma-bokeh-fixture-cache-'));
const outputDir = await mkdtemp(join(tmpdir(), 'cheoma-bokeh-fixture-'));
const timeout = Number(process.env.CHEOMA_BOKEH_TIMEOUT_MS) || 180_000;
const ROUNDNESS_RADIUS = 20;
const ENERGY_RADIUS = 26;
const STRIP_RADIUS = 20;
const ROUNDNESS_LIMIT = 1.12;
const ANGULAR_UNIFORMITY_LIMIT = 0.32;

function pixelLuminance(png, x, y) {
  const offset = (y * png.width + x) * 4;
  return 0.2126 * png.data[offset]
    + 0.7152 * png.data[offset + 1]
    + 0.0722 * png.data[offset + 2];
}

// Background-subtracted luminance covariance. The square root of its eigenvalue
// ratio is 1 for a circle and grows as a highlight stretches into an ellipse.
function estimateBackground(png) {
  let energy = 0;
  let count = 0;
  const origins = [[8, 8], [png.width - 16, 8], [8, png.height - 16], [png.width - 16, png.height - 16]];
  for (const [originX, originY] of origins) {
    for (let y = originY; y < originY + 8; y++) {
      for (let x = originX; x < originX + 8; x++) {
        energy += pixelLuminance(png, x, y);
        count++;
      }
    }
  }
  return energy / count;
}

function measureLight(png, light, background, radius = ROUNDNESS_RADIUS) {
  const cx = Math.round(light.x);
  const cy = Math.round(light.y);
  const samples = [];
  for (let y = cy - radius; y <= cy + radius; y++) {
    for (let x = cx - radius; x <= cx + radius; x++) {
      const luminance = pixelLuminance(png, x, y);
      samples.push({ x, y, luminance });
    }
  }
  let energy = 0;
  let weightedX = 0;
  let weightedY = 0;
  for (const sample of samples) {
    sample.weight = Math.max(0, sample.luminance - background);
    energy += sample.weight;
    weightedX += sample.x * sample.weight;
    weightedY += sample.y * sample.weight;
  }
  if (!(energy > 0)) throw new Error(`${light.name} has no measurable HDR bokeh energy`);
  const centroidX = weightedX / energy;
  const centroidY = weightedY / energy;
  let xx = 0;
  let yy = 0;
  let xy = 0;
  for (const sample of samples) {
    const dx = sample.x - centroidX;
    const dy = sample.y - centroidY;
    xx += sample.weight * dx * dx;
    yy += sample.weight * dy * dy;
    xy += sample.weight * dx * dy;
  }
  xx /= energy;
  yy /= energy;
  xy /= energy;
  const trace = xx + yy;
  const delta = Math.sqrt((xx - yy) ** 2 + 4 * xy ** 2);
  const minor = Math.max(1e-9, (trace - delta) * 0.5);
  const major = Math.max(minor, (trace + delta) * 0.5);
  const angularEnergy = Array(24).fill(0);
  for (const sample of samples) {
    const dx = sample.x - centroidX;
    const dy = sample.y - centroidY;
    const distance = Math.hypot(dx, dy);
    if (distance < 3 || distance > radius * 0.9) continue;
    const angle = (Math.atan2(dy, dx) + Math.PI * 2) % (Math.PI * 2);
    const bin = Math.min(angularEnergy.length - 1, Math.floor(angle / (Math.PI * 2) * angularEnergy.length));
    angularEnergy[bin] += sample.weight;
  }
  const angularMean = angularEnergy.reduce((sum, value) => sum + value, 0) / angularEnergy.length;
  const angularVariance = angularEnergy.reduce(
    (sum, value) => sum + (value - angularMean) ** 2,
    0,
  ) / angularEnergy.length;
  return {
    name: light.name,
    x: light.x,
    y: light.y,
    centroidX,
    centroidY,
    energy,
    aspect: Math.sqrt(major / minor),
    angularVariation: angularMean > 0 ? Math.sqrt(angularVariance) / angularMean : Infinity,
    rmsRadius: Math.sqrt(trace),
  };
}

function measureLights(image, lights) {
  const png = PNG.sync.read(image);
  const background = estimateBackground(png);
  return lights.map((light) => {
    const shape = measureLight(png, light, background);
    const wide = measureLight(png, light, background, ENERGY_RADIUS);
    return { ...shape, energy: wide.energy };
  });
}

function maxChannelDifference(a, b) {
  const first = PNG.sync.read(a);
  const second = PNG.sync.read(b);
  if (first.width !== second.width || first.height !== second.height) return Infinity;
  let difference = 0;
  for (let index = 0; index < first.data.length; index++) {
    difference = Math.max(difference, Math.abs(first.data[index] - second.data[index]));
  }
  return difference;
}

function makePanStrip(frames, lightNames, scale = 4) {
  const cropSize = STRIP_RADIUS * 2 + 1;
  const strip = new PNG({
    width: frames.length * cropSize * scale,
    height: lightNames.length * cropSize * scale,
  });
  for (let column = 0; column < frames.length; column++) {
    const png = PNG.sync.read(frames[column].image);
    for (let row = 0; row < lightNames.length; row++) {
      const light = frames[column].lights.find((candidate) => candidate.name === lightNames[row]);
      const cx = Math.round(light.x);
      const cy = Math.round(light.y);
      for (let sy = -STRIP_RADIUS; sy <= STRIP_RADIUS; sy++) {
        for (let sx = -STRIP_RADIUS; sx <= STRIP_RADIUS; sx++) {
          const source = ((cy + sy) * png.width + cx + sx) * 4;
          for (let oy = 0; oy < scale; oy++) {
            for (let ox = 0; ox < scale; ox++) {
              const dx = column * cropSize * scale + (sx + STRIP_RADIUS) * scale + ox;
              const dy = row * cropSize * scale + (sy + STRIP_RADIUS) * scale + oy;
              const target = (dy * strip.width + dx) * 4;
              png.data.copy(strip.data, target, source, source + 4);
            }
          }
        }
      }
    }
  }
  return PNG.sync.write(strip);
}

const server = await createServer({
  root: APP_ROOT,
  configFile: join(APP_ROOT, 'vite.config.js'),
  cacheDir,
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false },
});

let browser;
const errors = [];
try {
  if (process.env.CHEOMA_BROWSER !== 'chrome') {
    throw new Error('shoot:bokeh GPU evidence requires CHEOMA_BROWSER=chrome');
  }
  await server.listen();
  const port = server.httpServer.address().port;
  browser = await launchVerificationBrowser();
  const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
  page.setDefaultTimeout(timeout);
  await page.addInitScript(() => { window.__noWarm = true; });
  page.on('pageerror', (error) => errors.push(`page: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' && !/favicon|404/i.test(message.text())) {
      errors.push(`console: ${message.text()}`);
    }
  });

  const url = `http://127.0.0.1:${port}/?hero=0&village=1&worker=0&shot=1`
    + '&seed=42&vseed=20260716&time=night&season=summer&weather=clear';
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
  await page.waitForFunction(() => window.__SHOT_READY === true && !!window.__engine, null, { timeout });
  const gpuInfo = await reportWebGLRenderer(page, 'bokeh-fixture');
  if (!gpuInfo?.renderer
      || /swiftshader|llvmpipe|software|basic render/i.test(`${gpuInfo.renderer} ${gpuInfo.vendor}`)) {
    throw new Error(`shoot:bokeh requires a hardware Chrome renderer: ${JSON.stringify(gpuInfo)}`);
  }

  // A locator screenshot includes overlapping HTML controls. Hide every canvas
  // sibling while keeping its ancestor chain laid out at the product dimensions.
  await page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    for (const element of document.body.querySelectorAll('*')) {
      if (element === canvas || element.contains(canvas)) continue;
      element.style.setProperty('visibility', 'hidden', 'important');
    }
  });

  const fixture = await page.evaluate(async (threeModuleUrl) => {
    const THREE = await import(threeModuleUrl);
    const engine = window.__engine;
    engine.setViewShiftEnabled(false);
    engine.setWeather('clear');
    engine.setSeason('summer', { immediate: true });
    engine.setTime('night', { immediate: true });
    engine.debugSetPaused(true);

    // Detach (do not dispose) the product roots for this transient page. The real
    // composer, camera and update/debug paths remain in place, while the depth pass
    // traverses only the optical chart and its counters stay easy to interpret.
    for (const child of [...engine.scene.children]) engine.scene.remove(child);
    engine.scene.background = new THREE.Color(0x01030a);
    engine.scene.fog = null;

    const chart = new THREE.Group();
    chart.name = 'bokeh-optical-chart';
    engine.scene.add(chart);

    const material = (r, g, b) => new THREE.MeshBasicMaterial({
      color: new THREE.Color(r, g, b),
      fog: false,
    });
    const addBox = (name, size, position, color) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material(...color));
      mesh.name = name;
      mesh.position.set(...position);
      chart.add(mesh);
      return mesh;
    };

    // A quiet, deep backdrop gives both light banks room to form clean discs.
    addBox('backdrop', [520, 300, 1], [0, 0, -220], [0.002, 0.004, 0.012]);

    // Focus-plane subject: a restrained, gate-like chart with fine edges. It is
    // deliberately below the bloom threshold, so sharpness is attributable to DoF.
    addBox('focus-field', [20, 20, 0.35], [0, 0, -0.35], [0.006, 0.009, 0.016]);
    addBox('focus-left-post', [1.1, 14, 1.5], [-4.6, 0, 0], [0.075, 0.105, 0.14]);
    addBox('focus-right-post', [1.1, 14, 1.5], [4.6, 0, 0], [0.075, 0.105, 0.14]);
    addBox('focus-lower-roof', [14, 0.75, 1.8], [0, 6.1, 0], [0.16, 0.09, 0.045]);
    addBox('focus-upper-roof', [10.8, 0.58, 1.9], [0, 7.25, 0], [0.24, 0.15, 0.065]);
    addBox('focus-sill', [10.2, 0.45, 1.2], [0, -6.5, 0], [0.055, 0.075, 0.1]);
    const focusRing = new THREE.Mesh(
      new THREE.TorusGeometry(2.15, 0.17, 12, 64),
      material(0.28, 0.22, 0.11),
    );
    focusRing.name = 'focus-plane-ring';
    focusRing.position.z = 0.9;
    chart.add(focusRing);
    addBox('focus-needle-v', [0.12, 5.5, 0.8], [0, 0, 1.0], [0.18, 0.22, 0.26]);
    addBox('focus-needle-h', [5.5, 0.12, 0.8], [0, 0, 1.0], [0.18, 0.22, 0.26]);

    const lights = [];
    const sphere = new THREE.SphereGeometry(1, 16, 12);
    const addLight = (name, position, radius, color) => {
      const mesh = new THREE.Mesh(sphere, material(...color));
      mesh.name = name;
      mesh.position.set(...position);
      mesh.scale.setScalar(radius);
      chart.add(mesh);
      lights.push(mesh);
    };

    // At camera z=100 these banks sit 20m in front and 240m behind the focus
    // plane. The default 0.00015 aperture therefore reaches the product max-blur
    // radius on both sides, making the aperture shape legible without exaggeration.
    // Source radii are chosen for similar ~4px emissive faces before DoF despite
    // the different perspective scales. This models a lantern/firefly glow rather
    // than an unattainable mathematical delta, while remaining much smaller than
    // the resulting aperture image.
    addLight('foreground-amber-left', [-5.9, 3.8, 80], 0.04, [11.0, 4.2, 0.75]);
    addLight('foreground-rose-right', [6.1, 2.1, 80], 0.04, [10.5, 1.7, 1.15]);
    addLight('foreground-moon-left', [-6.6, -3.6, 80], 0.04, [3.0, 5.8, 11.0]);
    addLight('foreground-gold-right', [5.7, -4.0, 80], 0.04, [12.0, 6.2, 1.0]);
    // Edge-case probe: an out-of-focus foreground emitter directly over an
    // opaque focus-plane field. This exposes the foreground-bleed limitation of
    // a screen-space gather blur instead of letting the dark far backdrop hide it.
    addLight('foreground-over-focus', [1.4, -1.4, 80], 0.04, [11.5, 3.4, 0.65]);

    addLight('background-gold-left', [-58, 30, -140], 0.4, [12.0, 5.4, 0.8]);
    addLight('background-blue-left', [-53, -31, -140], 0.4, [2.4, 5.0, 11.5]);
    addLight('background-rose-right', [58, 27, -140], 0.4, [11.0, 1.8, 1.0]);
    addLight('background-amber-right', [55, -33, -140], 0.4, [12.0, 6.5, 1.1]);

    const camera = engine.camera;
    camera.position.set(0, 0, 100);
    camera.near = 0.1;
    camera.far = 500;
    camera.fov = 35;
    camera.clearViewOffset();
    camera.updateProjectionMatrix();
    engine.__controls.target.set(0, 0, 0);
    camera.lookAt(engine.__controls.target);
    camera.updateMatrixWorld(true);
    // Finish any load-time camera handoff, then establish the chart's exact focus
    // depth once before the 0-vs-default pair. Both captures start from one state.
    if (engine.debugDof().tweenProgress != null) engine.debugDofSeek(1, { finish: true });
    camera.position.set(0, 0, 100);
    camera.fov = 35;
    camera.updateProjectionMatrix();
    engine.__controls.target.set(0, 0, 0);
    camera.lookAt(engine.__controls.target);
    camera.updateMatrixWorld(true);
    engine.debugTuneDof({ amount: 1, aperture: 0.00015, maxBlur: 0.01 });
    for (let i = 0; i < 30; i++) engine.debugAdvancePostQuality(1 / 60);
    engine.debugRenderDofFrame();

    const projectedLights = lights.map((light) => {
      const p = light.getWorldPosition(new THREE.Vector3()).project(camera);
      return {
        name: light.name,
        x: Math.round((p.x * 0.5 + 0.5) * 960),
        y: Math.round((-p.y * 0.5 + 0.5) * 600),
      };
    });
    return { projectedLights, focusDepth: 100, fixtureDrawCalls: chart.children.length };
  }, `/@fs${join(APP_ROOT, 'node_modules/three/build/three.module.js')}`);

  const capture = async (name, amount) => {
    const state = await page.evaluate((value) => {
      const engine = window.__engine;
      engine.debugTuneDof({ amount: value, aperture: 0.00015, maxBlur: 0.01 });
      engine.debugRenderDofFrame();
      return engine.debugDof();
    }, amount);
    const path = join(outputDir, `${name}.png`);
    await page.locator('canvas').screenshot({ path });
    console.log(`${path} ${JSON.stringify(state)}`);
    return path;
  };

  const off = await capture('bokeh-hdr-off', 0);
  const on = await capture('bokeh-hdr-default', 1);
  const repeatState = await page.evaluate(() => window.__engine.debugRenderDofFrame());
  const repeat = await page.locator('canvas').screenshot();
  const pixelStable = repeat.equals(await readFile(on));
  if (!pixelStable) throw new Error('static bokeh fixture changed between identical product frames');

  const onMetrics = measureLights(repeat, fixture.projectedLights);
  const offMetrics = measureLights(await readFile(off), fixture.projectedLights);
  const maxAspect = Math.max(...onMetrics.map((sample) => sample.aspect));
  if (maxAspect > ROUNDNESS_LIMIT) {
    throw new Error(`bokeh aperture stretched to ${maxAspect.toFixed(3)} (limit ${ROUNDNESS_LIMIT})`);
  }

  // Preserve a stable reference at the final pan pose. The moving sequence will
  // arrive at this exact camera again through the 13-tap path, then settle back
  // to the reference without changing the aperture center or radius.
  const finalTargetX = 0.105;
  const stableFinalState = await page.evaluate((targetX) => {
    const engine = window.__engine;
    engine.camera.position.set(0, 0, 100);
    engine.__controls.target.set(targetX, 0, 0);
    engine.camera.lookAt(engine.__controls.target);
    engine.camera.updateMatrixWorld(true);
    engine.debugRenderDofFrame(1 / 60);
    for (let i = 0; i < 30; i++) engine.debugAdvancePostQuality(1 / 60);
    return engine.debugRenderDofFrame();
  }, finalTargetX);
  const stableFinalReference = await page.locator('canvas').screenshot();
  const stableFinalPath = join(outputDir, 'bokeh-final-stable-reference.png');
  await writeFile(stableFinalPath, stableFinalReference);

  // Eight fixed yaw steps move the chart by roughly two pixels. This is slow
  // enough to expose screen-space kernel crawl without conflating it with a large
  // perspective/composition change.
  const panFrames = [];
  for (let index = 0; index < 8; index++) {
    const targetX = -0.105 + index * (0.21 / 7);
    const frame = await page.evaluate(({ targetX, names }) => {
      const engine = window.__engine;
      engine.camera.position.set(0, 0, 100);
      engine.__controls.target.set(targetX, 0, 0);
      engine.camera.lookAt(engine.__controls.target);
      engine.camera.updateMatrixWorld(true);
      const state = engine.debugRenderDofFrame(1 / 60);
      const lights = names.map((name) => {
        const object = engine.scene.getObjectByName(name);
        const projected = object.getWorldPosition(object.position.clone()).project(engine.camera);
        return {
          name,
          x: (projected.x * 0.5 + 0.5) * 960,
          y: (-projected.y * 0.5 + 0.5) * 600,
        };
      });
      return { lights, state };
    }, { targetX, names: fixture.projectedLights.map((light) => light.name) });
    const image = await page.locator('canvas').screenshot();
    panFrames.push({
      targetX,
      lights: frame.lights,
      state: frame.state,
      image,
      metrics: measureLights(image, frame.lights),
    });
  }
  if (!panFrames.every((frame) => frame.state.postQuality === 0
      && frame.state.activeBokehTaps === 13)) {
    throw new Error('camera pan did not remain on the fully-moving 13-tap path');
  }

  const settleFrames = [];
  for (let index = 0; index < 22; index++) {
    const state = await page.evaluate(() => window.__engine.debugRenderDofFrame(1 / 60));
    if ([0, 3, 7, 10, 14, 18, 21].includes(index)) {
      const image = await page.locator('canvas').screenshot();
      const lights = panFrames.at(-1).lights;
      settleFrames.push({ index, lights, state, image, metrics: measureLights(image, lights) });
    }
  }
  const settledState = settleFrames.at(-1).state;
  const settledImage = settleFrames.at(-1).image;
  const finalPixelDifference = maxChannelDifference(stableFinalReference, settledImage);
  if (settledState.postQuality !== 1 || settledState.activeBokehTaps !== 41) {
    throw new Error('static camera did not restore the exact stable 41-tap path');
  }
  if (finalPixelDifference > 1) {
    throw new Error(`settled bokeh differs from its stable reference by ${finalPixelDifference} channels`);
  }
  const unobstructedNames = new Set(
    fixture.projectedLights.map((light) => light.name).filter((name) => name !== 'foreground-over-focus'),
  );
  const transitionMetrics = [...panFrames, ...settleFrames]
    .flatMap((frame) => frame.metrics)
    .filter((sample) => unobstructedNames.has(sample.name));
  const maxAngularVariation = Math.max(...transitionMetrics.map((sample) => sample.angularVariation));
  if (maxAngularVariation > ANGULAR_UNIFORMITY_LIMIT) {
    throw new Error(`moving/settling bokeh has visible radial lobes ${maxAngularVariation.toFixed(3)} (limit ${ANGULAR_UNIFORMITY_LIMIT})`);
  }
  const motion = fixture.projectedLights.map((light) => {
    const samples = panFrames.map((frame) => frame.metrics.find((sample) => sample.name === light.name));
    const energies = samples.map((sample) => sample.energy);
    const aspects = samples.map((sample) => sample.aspect);
    const centers = samples.map((sample) => sample.centroidX);
    const meanEnergy = energies.reduce((sum, value) => sum + value, 0) / energies.length;
    return {
      name: light.name,
      energyRange: (Math.max(...energies) - Math.min(...energies)) / meanEnergy,
      maxAspect: Math.max(...aspects),
      centroidTravel: Math.max(...centers) - Math.min(...centers),
    };
  });
  const maxMotionAspect = Math.max(...motion.map((sample) => sample.maxAspect));
  if (maxMotionAspect > ROUNDNESS_LIMIT) {
    throw new Error(`moving bokeh aperture stretched to ${maxMotionAspect.toFixed(3)} (limit ${ROUNDNESS_LIMIT})`);
  }
  // This value is diagnostic rather than a golden: subpixel raster coverage and
  // browser color math can shift total crop energy even when the aperture moves
  // coherently. The pan strip is the visual temporal-crawl acceptance artifact.
  const maxEnergyRange = Math.max(...motion.map((sample) => sample.energyRange));
  const overlapName = 'foreground-over-focus';
  const overlapOn = onMetrics.find((sample) => sample.name === overlapName);
  const overlapOff = offMetrics.find((sample) => sample.name === overlapName);
  const overlapProbe = {
    name: overlapName,
    rmsRatio: overlapOn.rmsRadius / overlapOff.rmsRadius,
    limitation: 'central-depth gather retains bloom but cannot scatter across an opaque focus plane',
  };
  const panStrip = join(outputDir, 'bokeh-pan-settle-strip.png');
  await writeFile(panStrip, makePanStrip([...panFrames, ...settleFrames], [
    'foreground-amber-left',
    'background-gold-left',
    'foreground-over-focus',
  ]));

  const gpuTiming = await page.evaluate(async () => {
    const engine = window.__engine;
    const gl = engine.renderer.getContext();
    const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    if (!ext || typeof gl.createQuery !== 'function') return { available: false };
    // Timer-query results on ANGLE/Metal have enough per-query jitter that
    // comparing isolated A/B samples is flaky. Measure larger batches in
    // alternating ABBA blocks: each block balances short-term GPU drift while
    // keeping the total number of query waits lower than the old 12-pair gate.
    const batchSize = 24;
    let sawDisjoint = false;
    const measure = async () => {
      const resources = engine.debugPostResources();
      const query = gl.createQuery();
      gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
      for (let index = 0; index < batchSize; index++) {
        resources.bokehPass.render(
          engine.renderer,
          resources.composerWriteBuffer,
          resources.composerReadBuffer,
          0,
          false,
        );
      }
      gl.endQuery(ext.TIME_ELAPSED_EXT);
      gl.flush();
      const deadline = performance.now() + 2000;
      while (performance.now() < deadline
          && !gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) {
        await new Promise((resolve) => setTimeout(resolve, 4));
      }
      if (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) return null;
      sawDisjoint ||= !!gl.getParameter(ext.GPU_DISJOINT_EXT);
      const milliseconds = gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6 / batchSize;
      gl.deleteQuery(query);
      return milliseconds;
    };
    const enterMovingAtFinalPose = () => {
      const fov = engine.camera.fov;
      engine.camera.fov = fov + 0.5;
      engine.camera.updateProjectionMatrix();
      engine.debugAdvancePostQuality(1 / 60);
      engine.camera.fov = fov;
      engine.camera.updateProjectionMatrix();
      engine.debugAdvancePostQuality(1 / 60);
    };
    const settle = () => {
      for (let i = 0; i < 30; i++) engine.debugAdvancePostQuality(1 / 60);
    };
    const blocks = [];
    for (let block = 0; block < 3; block++) {
      const sequence = block % 2 === 0
        ? ['moving', 'stable', 'stable', 'moving']
        : ['stable', 'moving', 'moving', 'stable'];
      const samples = [];
      for (const quality of sequence) {
        if (quality === 'moving') enterMovingAtFinalPose();
        else settle();
        samples.push({ quality, milliseconds: await measure() });
      }
      blocks.push(samples);
    }
    const disjoint = sawDisjoint || !!gl.getParameter(ext.GPU_DISJOINT_EXT);
    if (blocks.flat().some((sample) => sample.milliseconds == null)) {
      return { available: true, complete: false, disjoint };
    }
    const median = (values) => {
      const sorted = [...values].sort((a, b) => a - b);
      const middle = sorted.length >> 1;
      return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) * 0.5;
    };
    const moving = blocks.flatMap((samples) => samples
      .filter((sample) => sample.quality === 'moving')
      .map((sample) => sample.milliseconds));
    const stable = blocks.flatMap((samples) => samples
      .filter((sample) => sample.quality === 'stable')
      .map((sample) => sample.milliseconds));
    const blockRatios = blocks.map((samples) => {
      const movingSamples = samples
        .filter((sample) => sample.quality === 'moving')
        .map((sample) => sample.milliseconds);
      const stableSamples = samples
        .filter((sample) => sample.quality === 'stable')
        .map((sample) => sample.milliseconds);
      return median(movingSamples) / median(stableSamples);
    });
    return {
      available: true,
      complete: true,
      disjoint,
      moving,
      stable,
      movingMedianMs: median(moving),
      stableMedianMs: median(stable),
      ratio: median(moving) / median(stable),
      blockRatios,
      blockRatioMedian: median(blockRatios),
      winningBlocks: blockRatios.filter((ratio) => ratio < 1).length,
      batchSize,
    };
  });
  if (!gpuTiming.available || !gpuTiming.complete || gpuTiming.disjoint) {
    throw new Error(`Chrome GPU timer unavailable or invalid: ${JSON.stringify(gpuTiming)}`);
  }
  if (!(gpuTiming.ratio < 0.85
      && gpuTiming.blockRatioMedian < 0.9
      && gpuTiming.winningBlocks >= 2)) {
    throw new Error(`13-tap GPU median did not improve on 41 taps: ${JSON.stringify(gpuTiming)}`);
  }
  console.log(`BOKEH FIXTURE: ${outputDir}`);
  console.log(`fixture: ${JSON.stringify({
    ...fixture,
    off,
    on,
    panStrip,
    stableFinalPath,
    stableFinalState,
    settledState,
    finalPixelDifference,
    maxAngularVariation,
    gpuTiming,
    gpuInfo,
    pixelStable,
    maxAspect,
    maxMotionAspect,
    maxEnergyRange,
    overlapProbe,
    onMetrics,
    motion,
    repeatState,
  })}`);
  console.log(`runtime errors: ${errors.length}`);
  for (const error of errors) console.log(error);
  if (errors.length) process.exitCode = 1;
} catch (error) {
  console.error(error.stack || error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
}
