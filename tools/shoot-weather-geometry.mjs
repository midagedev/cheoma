// Issue #96 weather A/B evidence.
// Run under the shared browser lock:
//   node tools/run-browser-locked.mjs -- node tools/shoot-weather-geometry.mjs
//
// The product keeps FAR as its default. This harness renders FAR and physical FULL
// from the exact same CPU state, with no automatic distance switch or hysteresis.
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { PNG } from 'pngjs';
import {
  launchVerificationBrowser,
  reportWebGLRenderer,
} from './lib/verification-browser.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const outputDir = await mkdtemp(join(tmpdir(), 'cheoma-weather-geometry-'));
const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
};
const WIDTH = 960;
const HEIGHT = 600;

const HTML = `<!doctype html>
<html><head><meta charset="utf-8">
<style>html,body,#app{margin:0;width:100%;height:100%;overflow:hidden;background:#71808c}</style>
<script type="importmap">{"imports":{
  "three":"/app/node_modules/three/build/three.module.js",
  "three/addons/":"/app/node_modules/three/examples/jsm/"
}}</script></head><body><div id="app"></div>
<script type="module">
import * as THREE from 'three';
import { PRESETS, computeLayout } from '/src/params.js';
import { buildBuilding } from '/src/builder/index.js';
import {
  VILLAGE_FOCUS_CONTEXT_ELEVATION,
  VILLAGE_FOCUS_ELEVATION,
  VILLAGE_LENS,
  dollyDistanceForFov,
  dollyScaleForFov,
} from '/src/camera/optics.js';
import {
  advanceRainPrecipitation,
  advanceSnowPrecipitation,
  createPhysicalRainRepresentation,
  createPhysicalSnowRepresentation,
  createRainLinesRepresentation,
  createRainPrecipitationState,
  createSnowPointsRepresentation,
  createSnowPrecipitationState,
  precipitationStateBytes,
  representationAttributeBytes,
} from '/src/env/weather-physical-geometry.js';

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(1);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.08;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.getElementById('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x74838f);
scene.fog = new THREE.Fog(0x74838f, 75, 190);
const hemi = new THREE.HemisphereLight(0xd9e4ef, 0x4a443d, 1.65);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff1d6, 3.2);
sun.position.set(-22, 35, 20);
scene.add(sun);

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(190, 190),
  new THREE.MeshStandardMaterial({ color: 0x756f62, roughness: 0.92 }),
);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -0.12;
ground.name = 'weather-test-ground';
scene.add(ground);

const preset = { ...PRESETS.korea };
const layout = computeLayout(preset);
const building = buildBuilding(preset);
building.name = 'weather-test-building';
scene.add(building);
building.updateWorldMatrix(true, true);
const buildingBox = new THREE.Box3().setFromObject(building);
const buildingSize = buildingBox.getSize(new THREE.Vector3());
const target = buildingBox.getCenter(new THREE.Vector3());

const count = { snow: 3600, rain: 2600 };
const snowState = createSnowPrecipitationState({ count: count.snow, top: layout.totalH + 28 });
const rainState = createRainPrecipitationState({ count: count.rain, top: layout.totalH + 28 });
const wind = { dirX: 0.82, dirZ: 0.31, speed: 0.74, gust: 0.36 };
for (let frame = 0; frame < 90; frame++) {
  const step = { dt: 1 / 60, time: frame / 60, wind, collide: false };
  advanceSnowPrecipitation(snowState, step);
  advanceRainPrecipitation(rainState, step);
}

const representations = {
  snow: {
    far: createSnowPointsRepresentation(snowState),
    physical: createPhysicalSnowRepresentation(snowState),
  },
  rain: {
    far: createRainLinesRepresentation(rainState),
    physical: createPhysicalRainRepresentation(rainState),
  },
};
for (const kind of Object.keys(representations)) {
  for (const mode of Object.keys(representations[kind])) {
    const representation = representations[kind][mode];
    representation.object.visible = false;
    scene.add(representation.object);
    representation.sync({ level: 1, time: 1.5 });
    representation.setLens({ lensScale: 1, visualDistance: 55 });
  }
}

const camera = new THREE.PerspectiveCamera(46, innerWidth / innerHeight, 0.1, 500);
let active = { kind: 'snow', mode: 'far', view: 'focus' };
function referenceFitDistance(fov, fill) {
  const tangent = Math.tan(THREE.MathUtils.degToRad(fov * 0.5));
  const vertical = buildingSize.y * 0.5 / (fill * tangent);
  const horizontal = buildingSize.x * 0.5 / (fill * tangent * camera.aspect);
  return Math.max(vertical, horizontal);
}
function setView(view) {
  const profile = view === 'focus' ? VILLAGE_LENS.hero : VILLAGE_LENS.aerial;
  const elevation = view === 'focus'
    ? VILLAGE_FOCUS_ELEVATION
    : VILLAGE_FOCUS_CONTEXT_ELEVATION;
  const azimuth = (view === 'focus' ? 24 : 9) * Math.PI / 180;
  const referenceDistance = referenceFitDistance(
    profile.referenceFov,
    view === 'focus' ? 0.72 : 0.18,
  );
  const distance = dollyDistanceForFov(
    referenceDistance,
    profile.referenceFov,
    profile.fov,
  );
  camera.fov = profile.fov;
  camera.userData.villageReferenceFov = profile.referenceFov;
  camera.position.set(
    Math.sin(azimuth) * Math.cos(elevation) * distance,
    target.y + Math.sin(elevation) * distance,
    Math.cos(azimuth) * Math.cos(elevation) * distance,
  );
  camera.lookAt(target);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  const lensScale = dollyScaleForFov(profile.referenceFov, profile.fov);
  const spread = Math.min(3, Math.max(1, referenceDistance / 60));
  for (const kind of Object.keys(representations)) {
    for (const mode of Object.keys(representations[kind])) {
      const representation = representations[kind][mode];
      representation.setLens({ lensScale, visualDistance: referenceDistance });
      representation.setCenterSpread(spread);
    }
  }
  return {
    fov: profile.fov,
    referenceFov: profile.referenceFov,
    elevationDeg: THREE.MathUtils.radToDeg(elevation),
    referenceDistance,
    distance,
    lensScale,
    spread,
  };
}
function select(kind, mode, view) {
  for (const weatherKind of Object.keys(representations)) {
    for (const representationMode of Object.keys(representations[weatherKind])) {
      representations[weatherKind][representationMode].object.visible =
        weatherKind === kind && representationMode === mode;
    }
  }
  active = { kind, mode, view };
  return setView(view);
}
function render() {
  renderer.render(scene, camera);
}
function renderStats() {
  renderer.info.reset();
  render();
  return {
    calls: renderer.info.render.calls,
    triangles: renderer.info.render.triangles,
    lines: renderer.info.render.lines,
    points: renderer.info.render.points,
    programs: renderer.info.programs?.length || 0,
    geometries: renderer.info.memory.geometries,
    textures: renderer.info.memory.textures,
  };
}
function incrementalStats() {
  const object = representations[active.kind][active.mode].object;
  object.visible = false;
  const clear = renderStats();
  object.visible = true;
  const weather = renderStats();
  return {
    calls: weather.calls - clear.calls,
    triangles: weather.triangles - clear.triangles,
    lines: weather.lines - clear.lines,
    points: weather.points - clear.points,
    geometries: weather.geometries - clear.geometries,
    textures: weather.textures - clear.textures,
  };
}
function projectedAreaProxy(kind, mode) {
  const state = kind === 'snow' ? snowState : rainState;
  const representation = representations[kind][mode];
  const centerSpread = representation.centerSpread;
  const height = renderer.domElement.height;
  const focal = height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5)));
  const viewPosition = new THREE.Vector3();
  const ndc = new THREE.Vector3();
  let area = 0;
  for (let index = 0; index < state.count; index++) {
    ndc.set(
      state.positions[index * 3] * centerSpread,
      state.positions[index * 3 + 1],
      state.positions[index * 3 + 2] * centerSpread,
    );
    viewPosition.copy(ndc).applyMatrix4(camera.matrixWorldInverse);
    const depth = -viewPosition.z;
    if (depth <= camera.near || depth >= camera.far) continue;
    ndc.project(camera);
    if (Math.abs(ndc.x) > 1.05 || Math.abs(ndc.y) > 1.05 || Math.abs(ndc.z) > 1) continue;
    if (kind === 'snow') {
      const diameter = mode === 'far'
        ? Math.min(
          state.sizes[index]
            * representations.snow.far.object.material.uniforms.uScale.value
            * representations.snow.far.object.material.uniforms.uLensScale.value
            / Math.max(depth, 1),
          representations.snow.far.object.material.uniforms.uMaxPx.value,
        )
        : state.sizes[index]
          * representations.snow.physical.object.material.uniforms.uWorldScale.value
          * focal / depth;
      area += Math.PI * diameter * diameter * 0.25;
    } else {
      const lengthPx = state.lengths[index] * focal / depth;
      const diameter = representations.rain.physical.object.material.uniforms.uRadius.value * 2;
      const widthPx = mode === 'far' ? 1 : Math.max(0.25, diameter * focal / depth);
      area += lengthPx * widthPx;
    }
  }
  return area;
}
async function queryRenderBatch(batchSize) {
  const gl = renderer.getContext();
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  if (!ext || typeof gl.createQuery !== 'function') return null;
  const query = gl.createQuery();
  gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
  for (let frame = 0; frame < batchSize; frame++) render();
  gl.endQuery(ext.TIME_ELAPSED_EXT);
  gl.flush();
  const deadline = performance.now() + 2500;
  while (performance.now() < deadline && !gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) {
    await new Promise((resolve) => setTimeout(resolve, 4));
  }
  if (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) {
    gl.deleteQuery(query);
    return null;
  }
  const disjoint = !!gl.getParameter(ext.GPU_DISJOINT_EXT);
  const milliseconds = gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6 / batchSize;
  gl.deleteQuery(query);
  return disjoint ? null : milliseconds;
}
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) * 0.5;
}
async function measureGpu(kind, view) {
  const blocks = [];
  const batchSize = 48;
  // Isolate the one precipitation draw. The 333-draw hanok baseline otherwise
  // dominates sub-millisecond timer queries and hides the representation cost.
  const buildingVisible = building.visible;
  const groundVisible = ground.visible;
  building.visible = false;
  ground.visible = false;
  for (const mode of ['far', 'physical']) {
    select(kind, mode, view);
    render(); render(); render();
    await queryRenderBatch(batchSize);
  }
  for (let block = 0; block < 4; block++) {
    const sequence = block % 2 === 0
      ? ['far', 'physical', 'physical', 'far']
      : ['physical', 'far', 'far', 'physical'];
    const samples = [];
    for (const mode of sequence) {
      select(kind, mode, view);
      render(); render(); render();
      samples.push({ mode, milliseconds: await queryRenderBatch(batchSize) });
    }
    blocks.push(samples);
  }
  building.visible = buildingVisible;
  ground.visible = groundVisible;
  const flat = blocks.flat();
  if (flat.some((sample) => sample.milliseconds == null)) {
    return { available: false, batchSize };
  }
  const far = flat.filter((sample) => sample.mode === 'far').map((sample) => sample.milliseconds);
  const physical = flat.filter((sample) => sample.mode === 'physical').map((sample) => sample.milliseconds);
  const ratios = blocks.map((samples) => (
    median(samples.filter((sample) => sample.mode === 'physical').map((sample) => sample.milliseconds))
    / median(samples.filter((sample) => sample.mode === 'far').map((sample) => sample.milliseconds))
  ));
  return {
    available: true,
    batchSize,
    far,
    physical,
    farMedianMs: median(far),
    physicalMedianMs: median(physical),
    ratio: median(physical) / median(far),
    blockRatios: ratios,
    blockRatioMedian: median(ratios),
  };
}
function resourceReport() {
  const out = {};
  for (const kind of Object.keys(representations)) {
    const state = kind === 'snow' ? snowState : rainState;
    out[kind] = {
      stateBytes: precipitationStateBytes(state),
      farAttributeBytes: representationAttributeBytes(representations[kind].far),
      physicalAttributeBytes: representationAttributeBytes(representations[kind].physical),
      farExclusiveAttributeBytes:
        representationAttributeBytes(representations[kind].far) - state.positions.byteLength,
      physicalExclusiveAttributeBytes:
        representationAttributeBytes(representations[kind].physical) - state.positions.byteLength,
      physicalTriangles: representations[kind].physical.triangles,
      farColorPrograms: 1,
      physicalColorPrograms: 1,
      physicalDofDepthPrograms: 1,
    };
  }
  return out;
}
async function resourcePlateau() {
  select('snow', 'far', 'focus');
  render(); render();
  const before = {
    geometries: renderer.info.memory.geometries,
    textures: renderer.info.memory.textures,
    programs: renderer.info.programs?.length || 0,
  };
  for (let cycle = 0; cycle < 12; cycle++) {
    const state = createSnowPrecipitationState({ count: 64 });
    const far = createSnowPointsRepresentation(state);
    const full = createPhysicalSnowRepresentation(state);
    far.object.visible = true;
    full.object.visible = true;
    far.sync({ level: 1 });
    full.sync({ level: 1, time: cycle });
    scene.add(far.object, full.object);
    render();
    scene.remove(far.object, full.object);
    far.dispose();
    full.dispose();
  }
  render(); render();
  return {
    before,
    after: {
      geometries: renderer.info.memory.geometries,
      textures: renderer.info.memory.textures,
      programs: renderer.info.programs?.length || 0,
    },
  };
}

window.__weatherGeometry = {
  select,
  render,
  renderStats,
  incrementalStats,
  projectedAreaProxy,
  measureGpu,
  resourceReport,
  resourcePlateau,
  setBuildingVisible(value) { building.visible = value; },
  setPrecipitationVisible(value) {
    representations[active.kind][active.mode].object.visible = value;
  },
};
for (const kind of ['snow', 'rain']) {
  select(kind, 'physical', 'focus');
  const object = representations[kind].physical.object;
  const colorMaterial = object.material;
  object.material = object.userData.dofDepthMaterial;
  render();
  object.material = colorMaterial;
}
select('snow', 'far', 'focus');
render(); render();
window.__SHOT_READY = true;
</script></body></html>`;

const server = createServer(async (request, response) => {
  const pathname = decodeURIComponent(request.url.split('?')[0]);
  if (pathname === '/__weather_geometry') {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(HTML);
    return;
  }
  try {
    const file = join(ROOT, pathname === '/' ? 'index.html' : pathname);
    const data = await readFile(file);
    response.writeHead(200, {
      'content-type': MIME[extname(file)] || 'application/octet-stream',
    });
    response.end(data);
  } catch {
    response.writeHead(404);
    response.end('not found');
  }
});

function imageDifference(actualBuffer, baselineBuffer) {
  const actual = PNG.sync.read(actualBuffer);
  const baseline = PNG.sync.read(baselineBuffer);
  let changedPixels = 0;
  let energy = 0;
  for (let offset = 0; offset < actual.data.length; offset += 4) {
    const difference = (
      Math.abs(actual.data[offset] - baseline.data[offset])
      + Math.abs(actual.data[offset + 1] - baseline.data[offset + 1])
      + Math.abs(actual.data[offset + 2] - baseline.data[offset + 2])
    ) / 3;
    if (difference > 3) changedPixels++;
    energy += difference;
  }
  return { changedPixels, energy };
}

function makeContactSheet(records, labels) {
  const first = PNG.sync.read(records[0]);
  const sheet = new PNG({ width: first.width * 2, height: first.height * 2 });
  for (let index = 0; index < records.length; index++) {
    const source = PNG.sync.read(records[index]);
    const x = (index % 2) * source.width;
    const y = Math.floor(index / 2) * source.height;
    PNG.bitblt(source, sheet, 0, 0, source.width, source.height, x, y);
  }
  return {
    buffer: PNG.sync.write(sheet),
    labels,
  };
}

function farPolicyEvidence(resources, evidence) {
  const samples = {};
  let qualifies = true;
  for (const kind of ['snow', 'rain']) {
    samples[kind] = {};
    for (const view of ['focus', 'aerial']) {
      const timing = evidence[kind][view].gpu;
      const far = evidence[kind][view].far;
      const physical = evidence[kind][view].physical;
      const absoluteSavingsMs = timing.available
        ? timing.physicalMedianMs - timing.farMedianMs
        : null;
      const visualEnergyRatio = far.visible.energy / Math.max(1, physical.visible.energy);
      const visualCoverageRatio =
        far.visible.changedPixels / Math.max(1, physical.visible.changedPixels);
      const blockWinRate = timing.available
        ? timing.blockRatios.filter((ratio) => ratio > 1).length / timing.blockRatios.length
        : 0;
      const materiallyFaster = absoluteSavingsMs != null && absoluteSavingsMs >= 0.1;
      const visuallyEquivalent = (
        visualEnergyRatio >= 0.75 && visualEnergyRatio <= 1.33
        && visualCoverageRatio >= 0.75 && visualCoverageRatio <= 1.33
      );
      const consistent = blockWinRate >= 0.75;
      qualifies &&= materiallyFaster && visuallyEquivalent && consistent;
      samples[kind][view] = {
        absoluteSavingsMs,
        frameBudgetPercent: absoluteSavingsMs == null
          ? null : absoluteSavingsMs / (1000 / 60) * 100,
        blockWinRate,
        visualEnergyRatio,
        visualCoverageRatio,
        farOverdrawProxy: far.overdrawProxy,
        physicalOverdrawProxy: physical.overdrawProxy,
        materiallyFaster,
        visuallyEquivalent,
        consistent,
      };
    }
  }
  return {
    samples,
    exclusiveAttributeBytes: {
      snow: {
        far: resources.snow.farExclusiveAttributeBytes,
        physical: resources.snow.physicalExclusiveAttributeBytes,
      },
      rain: {
        far: resources.rain.farExclusiveAttributeBytes,
        physical: resources.rain.physicalExclusiveAttributeBytes,
      },
    },
    aerialDutyCycleEvidence:
      'not measured; an aerial sleep policy receives no FAR-savings credit',
    automaticFarLodQualified: qualifies,
    recommendation: qualifies
      ? 'eligible-for-product-lod-review'
      : 'do-not-productize-automatic-far-lod',
  };
}

await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
const port = server.address().port;
let browser;
const errors = [];
try {
  browser = await launchVerificationBrowser();
  const page = await browser.newPage({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 1,
  });
  page.on('pageerror', (error) => errors.push(`page: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' && !/favicon|404/i.test(message.text())) {
      errors.push(`console: ${message.text()}`);
    }
  });
  await page.goto(`http://127.0.0.1:${port}/__weather_geometry`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__SHOT_READY === true, null, { timeout: 60_000 });
  const gpu = await reportWebGLRenderer(page, 'weather-geometry');

  const captures = {};
  const evidence = {};
  for (const kind of ['snow', 'rain']) {
    captures[kind] = {};
    evidence[kind] = {};
    for (const view of ['focus', 'aerial']) {
      captures[kind][view] = {};
      evidence[kind][view] = {};
      for (const mode of ['far', 'physical']) {
        await page.evaluate(
          ({ kind: nextKind, mode: nextMode, view: nextView }) => {
            window.__weatherGeometry.select(nextKind, nextMode, nextView);
            window.__weatherGeometry.render();
          },
          { kind, mode, view },
        );
        await page.evaluate(() => {
          window.__weatherGeometry.setPrecipitationVisible(false);
          window.__weatherGeometry.render();
        });
        const baseline = await page.screenshot();
        await page.evaluate(() => {
          window.__weatherGeometry.setPrecipitationVisible(true);
          window.__weatherGeometry.render();
        });
        const image = await page.screenshot();
        const file = join(outputDir, `${kind}-${view}-${mode}.png`);
        await writeFile(file, image);
        captures[kind][view][mode] = image;

        await page.evaluate(() => {
          window.__weatherGeometry.setBuildingVisible(false);
          window.__weatherGeometry.setPrecipitationVisible(false);
          window.__weatherGeometry.render();
        });
        const noBuildingBaseline = await page.screenshot();
        await page.evaluate(() => {
          window.__weatherGeometry.setPrecipitationVisible(true);
          window.__weatherGeometry.render();
        });
        const noBuildingWeather = await page.screenshot();
        await page.evaluate(() => {
          window.__weatherGeometry.setBuildingVisible(true);
          window.__weatherGeometry.render();
        });
        const visible = imageDifference(image, baseline);
        const unoccluded = imageDifference(noBuildingWeather, noBuildingBaseline);
        const runtime = await page.evaluate(
          ({ kind: activeKind, mode: activeMode, view: activeView }) => {
            const cameraView =
              window.__weatherGeometry.select(activeKind, activeMode, activeView);
            return {
              stats: window.__weatherGeometry.renderStats(),
              incrementalStats: window.__weatherGeometry.incrementalStats(),
              view: cameraView,
              projectedAreaProxy:
                window.__weatherGeometry.projectedAreaProxy(activeKind, activeMode),
            };
          },
          { kind, mode, view },
        );
        evidence[kind][view][mode] = {
          ...runtime,
          visible,
          unoccluded,
          occlusionEnergyRatio: unoccluded.energy > 0
            ? 1 - visible.energy / unoccluded.energy
            : null,
          overdrawProxy: visible.changedPixels > 0
            ? runtime.projectedAreaProxy / visible.changedPixels
            : null,
          file,
        };
      }
      evidence[kind][view].gpu = await page.evaluate(
        ({ kind: activeKind, view: activeView }) =>
          window.__weatherGeometry.measureGpu(activeKind, activeView),
        { kind, view },
      );
    }
  }

  for (const kind of ['snow', 'rain']) {
    const sheet = makeContactSheet([
      captures[kind].focus.far,
      captures[kind].focus.physical,
      captures[kind].aerial.far,
      captures[kind].aerial.physical,
    ], ['focus FAR', 'focus physical', 'aerial FAR', 'aerial physical']);
    await writeFile(join(outputDir, `${kind}-comparison.png`), sheet.buffer);
  }

  const resources = await page.evaluate(() => window.__weatherGeometry.resourceReport());
  const plateau = await page.evaluate(() => window.__weatherGeometry.resourcePlateau());
  const policy = farPolicyEvidence(resources, evidence);
  const result = { outputDir, gpu, resources, plateau, policy, evidence, errors };
  await writeFile(join(outputDir, 'metrics.json'), JSON.stringify(result, null, 2));

  if (errors.length) throw new Error(errors.join('\n'));
  if (
    plateau.after.geometries !== plateau.before.geometries
    || plateau.after.textures !== plateau.before.textures
    || plateau.after.programs !== plateau.before.programs
  ) {
    throw new Error(`weather resource plateau failed: ${JSON.stringify(plateau)}`);
  }
  for (const kind of ['snow', 'rain']) {
    for (const view of ['focus', 'aerial']) {
      for (const mode of ['far', 'physical']) {
        const sample = evidence[kind][view][mode];
        if (!(sample.visible.changedPixels > 0)) {
          throw new Error(`${kind}/${view}/${mode} produced no visible precipitation`);
        }
        const occlusionMinimum = view === 'focus' ? 0.02 : -0.001;
        if (!(sample.occlusionEnergyRatio > occlusionMinimum)) {
          throw new Error(`${kind}/${view}/${mode} did not show building depth occlusion`);
        }
      }
    }
  }

  const gpuSummary = {};
  for (const kind of ['snow', 'rain']) {
    gpuSummary[kind] = {};
    for (const view of ['focus', 'aerial']) {
      const timing = evidence[kind][view].gpu;
      gpuSummary[kind][view] = timing.available ? {
        farMedianMs: timing.farMedianMs,
        physicalMedianMs: timing.physicalMedianMs,
        ratio: timing.ratio,
        blockRatioMedian: timing.blockRatioMedian,
      } : { available: false };
    }
  }
  console.log(`weather geometry A/B: PASS\nartifacts: ${outputDir}`);
  console.log(JSON.stringify({ gpu, resources, plateau, gpuSummary, policy }, null, 2));
} finally {
  await browser?.close();
  await new Promise((resolvePromise) => server.close(resolvePromise));
}
