// Issue #96 physical particle A/B: screenshots + same-renderer ABBA GPU timings.
// Run through the shared browser lock:
//   node tools/run-browser-locked.mjs -- node tools/shoot-detail-particle-geometry.mjs

import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  launchVerificationBrowser,
  reportWebGLRenderer,
} from './lib/verification-browser.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const esbuild = require(resolve(ROOT, 'app/node_modules/esbuild'));
const OUT = await mkdtemp(join(tmpdir(), 'cheoma-detail-particle-'));

const ENTRY = `
import * as THREE from 'three';
import { PRESETS } from ${JSON.stringify(resolve(ROOT, 'src/params.js'))};
import { buildBuilding } from ${JSON.stringify(resolve(ROOT, 'src/builder/index.js'))};
import { createPetalField } from ${JSON.stringify(resolve(ROOT, 'src/env/petals.js'))};
import { setupMotes } from ${JSON.stringify(resolve(ROOT, 'src/env/motes.js'))};
import { setupPost } from ${JSON.stringify(resolve(ROOT, 'src/env/post.js'))};

const WIDTH = 960, HEIGHT = 600;
const renderer = new THREE.WebGLRenderer({
  antialias: true,
  powerPreference: 'high-performance',
  preserveDrawingBuffer: true,
});
renderer.setPixelRatio(1);
renderer.setSize(WIDTH, HEIGHT, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const configuredBackground = new THREE.Color(0x17202c);
scene.background = configuredBackground;
scene.fog = new THREE.Fog(0x17202c, 105, 230);
const environment = new THREE.Group();
environment.name = 'fixture-environment';
scene.add(environment);

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(120, 120),
  new THREE.MeshStandardMaterial({ color: 0x4a513f, roughness: 1 }),
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
environment.add(ground);

const courtyard = new THREE.Mesh(
  new THREE.BoxGeometry(22, 0.35, 16),
  new THREE.MeshStandardMaterial({ color: 0x9b927c, roughness: 0.95 }),
);
courtyard.position.y = 0.18;
courtyard.receiveShadow = true;
environment.add(courtyard);

const building = buildBuilding({ ...PRESETS.giwa });
building.name = 'fixture-giwa';
building.traverse((object) => {
  if (!object.isMesh) return;
  object.castShadow = true;
  object.receiveShadow = true;
});
environment.add(building);

const sun = new THREE.DirectionalLight(0xffd6a0, 3.2);
sun.position.set(-45, 58, 36);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
sun.shadow.camera.left = -70;
sun.shadow.camera.right = 70;
sun.shadow.camera.top = 70;
sun.shadow.camera.bottom = -70;
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 240;
scene.add(sun);
scene.add(new THREE.HemisphereLight(0x91a8c2, 0x554638, 1.4));

const camera = new THREE.PerspectiveCamera(7, WIDTH / HEIGHT, 0.1, 500);
const target = new THREE.Vector3(0, 5, 0);

const wind = { dirX: 0.72, dirZ: -0.35, speed: 0.42, gust: 0.94 };
const petals = createPetalField({ getWind: () => wind, lowPerf: false });
petals.setSeason('autumn');
const petalWorld = petals.getWorldRepresentation();
scene.add(petals.points, petalWorld.object);
for (let frame = 0; frame < 150; frame++) {
  petals.update(1 / 30, {
    t: frame / 30, viewHeight: 8, present: 1, wind, lensScale: 3.03,
  });
}

const motes = setupMotes({
  // Match the product focus-ring profile rather than the broad standalone field.
  scene, sun, renderer, radius: 8, centerY: 2.8, count: 90,
  ySpan: 0.22, fireflies: true,
});
scene.add(motes.group);
motes.setEnabled(true);
motes.setFade(1);
motes.setSeason('summer', { immediate: true });
motes.setTime('night', { immediate: true });
motes.setLensScale(3.03);
for (let frame = 0; frame < 150; frame++) motes.update(1 / 30);
// Seed-stable pulse phase with one bright and several dim fireflies. Capturing a
// known optical event is less ambiguous than accidentally sampling all pulses low.
for (let frame = 0; frame < 33; frame++) motes.update(1 / 30);
motes.getWorldRepresentation();

const post = setupPost({ renderer, scene, camera, lowPerf: false });
post.setRimEnabled(false);
post.setFlareEnabled(false);
post.setDof(true);
post.setDofAmount(1);
post.setDofAperture(0.00015);
post.setFocusPoint(target);
post.setTime('night', { immediate: true });

const label = document.createElement('div');
label.id = 'label';
document.body.appendChild(label);

function setLens(lens) {
  if (lens === 'focus') {
    camera.fov = 7;
    target.set(0, 4.3, 0);
    const distance = 126;
    const elevation = THREE.MathUtils.degToRad(24);
    camera.position.set(
      0,
      target.y + Math.sin(elevation) * distance,
      target.z + Math.cos(elevation) * distance,
    );
    petals.update(0, { t: 5, viewHeight: 8, present: 1, wind, lensScale: 3.03 });
    motes.setLensScale(3.03);
  } else {
    camera.fov = 46;
    target.set(0, 6, 0);
    const distance = 165;
    const elevation = THREE.MathUtils.degToRad(31);
    const azimuth = THREE.MathUtils.degToRad(9);
    camera.position.set(
      target.x + Math.cos(elevation) * Math.sin(azimuth) * distance,
      target.y + Math.sin(elevation) * distance,
      target.z + Math.cos(elevation) * Math.cos(azimuth) * distance,
    );
    // Force the same field visible for representation-only A/B. Product LOD
    // normally removes both at this aerial framing.
    petals.update(0, { t: 5, viewHeight: 8, present: 1, wind, lensScale: 1 });
    motes.setLensScale(1);
  }
  camera.aspect = WIDTH / HEIGHT;
  camera.updateProjectionMatrix();
  camera.lookAt(target);
  camera.updateMatrixWorld();
  post.setFocusPoint(target);
}

function setFamilyAndRepresentation(family, representation) {
  const petalVisible = family === 'petal';
  petals.setRepresentation(representation);
  petals.points.visible = petalVisible && representation === 'points';
  petalWorld.object.visible = petalVisible && representation === 'world';
  motes.group.visible = family === 'mote';
  motes.setRepresentation(representation);
  const moteWorld = motes.getWorldRepresentation();
  motes.points.visible = family === 'mote' && representation === 'points';
  moteWorld.object.visible = family === 'mote' && representation === 'world';
}

function configure({ family, representation, lens, season = 'autumn' }) {
  if (family === 'petal' && petals.season !== season) {
    petals.setSeason(season);
    for (let frame = 0; frame < 60; frame++) {
      petals.update(1 / 30, {
        t: 5 + frame / 30, viewHeight: 8, present: 1, wind,
        lensScale: lens === 'focus' ? 3.03 : 1,
      });
    }
  }
  setLens(lens);
  setFamilyAndRepresentation(family, representation);
  configuredBackground.set(family === 'mote' ? 0x07101c : 0x7f9cae);
  scene.background = configuredBackground;
  scene.fog.color.copy(configuredBackground);
  post.setTime(family === 'mote' ? 'night' : 'day', { immediate: true });
  label.textContent = [
    family === 'petal' ? season.toUpperCase() + ' PETALS / LEAVES' : 'DUST + FIREFLIES',
    representation === 'world' ? 'FULL WORLD GEOMETRY' : 'FAR POINTS',
    lens === 'focus' ? '7° TELEPHOTO FOCUS' : '46° AERIAL (FORCED VISIBLE)',
  ].join(' · ');
}

function renderShot(options) {
  configure(options);
  environment.visible = true;
  post.setDof(true);
  for (let i = 0; i < 4; i++) {
    post.update(1 / 60);
    post.composer.render();
  }
}

function renderPetalMacro() {
  configure({ family: 'petal', representation: 'world', lens: 'focus', season: 'autumn' });
  environment.visible = false;
  post.setDof(false);
  const attributes = petals.points.geometry.attributes;
  let index = 0;
  for (let i = 0; i < attributes.position.count; i++) {
    if (attributes.aSpecies.getX(i) > 1.5 && attributes.aThresh.getX(i) < 0.25) {
      index = i;
      break;
    }
  }
  target.fromBufferAttribute(attributes.position, index);
  const rotation = attributes.aRot.getX(index);
  const speed = attributes.aRotSpd.getX(index);
  const species = attributes.aSpecies.getX(index);
  const time = petalWorld.material.uniforms.uTime.value;
  const angles = new THREE.Vector3(
    Math.sin(time * (0.72 + Math.abs(speed) * 0.13) + rotation * 1.7)
      * (0.52 + species * 0.11),
    rotation * 0.61 + time * speed * 0.23,
    rotation + time * speed,
  );
  const normal = new THREE.Vector3(0, 0, 1);
  let c = Math.cos(angles.x), s = Math.sin(angles.x);
  [normal.y, normal.z] = [c * normal.y + s * normal.z, -s * normal.y + c * normal.z];
  c = Math.cos(angles.y); s = Math.sin(angles.y);
  [normal.x, normal.z] = [c * normal.x - s * normal.z, s * normal.x + c * normal.z];
  c = Math.cos(angles.z); s = Math.sin(angles.z);
  [normal.x, normal.y] = [c * normal.x + s * normal.y, -s * normal.x + c * normal.y];
  camera.fov = 24;
  camera.aspect = WIDTH / HEIGHT;
  camera.position.copy(target).addScaledVector(normal.normalize(), 1.05);
  camera.updateProjectionMatrix();
  camera.lookAt(target);
  camera.updateMatrixWorld();
  label.textContent = 'AUTUMN LEAF · 4-TRI CURVED WORLD SILHOUETTE · NO BILLBOARD';
  for (let i = 0; i < 3; i++) {
    post.update(1 / 60);
    post.composer.render();
  }
}

const perfTarget = new THREE.WebGLRenderTarget(640, 400, {
  depthBuffer: true,
  stencilBuffer: false,
});

function renderRaw(options) {
  configure(options);
  environment.visible = false;
  post.sunGlow.visible = false;
  post.setDof(false);
  scene.background = null;
  renderer.setClearColor(0x000000, 1);
  renderer.setRenderTarget(perfTarget);
  renderer.clear();
  renderer.render(scene, camera);
}

async function gpuBatch(options, renders = 64) {
  renderRaw(options);
  const gl = renderer.getContext();
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  const started = performance.now();
  let gpuMs = null;
  if (ext && gl.createQuery) {
    const query = gl.createQuery();
    gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
    for (let i = 0; i < renders; i++) renderer.render(scene, camera);
    gl.endQuery(ext.TIME_ELAPSED_EXT);
    while (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 0));
    }
    if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) {
      gpuMs = gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6 / renders;
    }
    gl.deleteQuery(query);
  } else {
    for (let i = 0; i < renders; i++) renderer.render(scene, camera);
  }
  const cpuMs = (performance.now() - started) / renders;
  renderer.setRenderTarget(null);
  scene.background = configuredBackground;
  return { gpuMs, cpuMs };
}

function directStats(options) {
  renderRaw(options);
  renderer.info.reset();
  renderer.render(scene, camera);
  const info = {
    calls: renderer.info.render.calls,
    triangles: renderer.info.render.triangles,
    points: renderer.info.render.points,
    lines: renderer.info.render.lines,
    programs: renderer.info.programs?.length || 0,
  };
  renderer.setRenderTarget(null);
  scene.background = configuredBackground;
  return info;
}

function coverage(options) {
  renderRaw(options);
  const pixels = new Uint8Array(640 * 400 * 4);
  renderer.readRenderTargetPixels(perfTarget, 0, 0, 640, 400, pixels);
  renderer.setRenderTarget(null);
  scene.background = configuredBackground;
  let pixelsLit = 0, lumaSum = 0, peak = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    const luma = 0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2];
    if (luma > 2) pixelsLit++;
    lumaSum += luma;
    peak = Math.max(peak, luma);
  }
  return { pixelsLit, lumaSum: lumaSum / 255, peak: peak / 255 };
}

function attributeBytes(geometry) {
  const arrays = new Set();
  let bytes = 0;
  for (const attribute of Object.values(geometry.attributes)) {
    if (arrays.has(attribute.array)) continue;
    arrays.add(attribute.array);
    bytes += attribute.array.byteLength;
  }
  return bytes;
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

window.__shot = renderShot;
window.__macro = renderPetalMacro;
window.__measure = async () => {
  const measurements = {};
  for (const family of ['petal', 'mote']) {
    for (const lens of ['focus', 'aerial']) {
      const key = family + '-' + lens;
      const samples = { points: [], world: [] };
      // Three ABBA blocks, same page/renderer/target. This cancels most warm-up
      // and thermal drift without comparing different browser processes.
      for (let block = 0; block < 4; block++) {
        for (const representation of ['points', 'world', 'world', 'points']) {
          samples[representation].push(await gpuBatch({ family, representation, lens }));
        }
      }
      measurements[key] = {
        points: {
          gpuMs: median(samples.points.map((x) => x.gpuMs)),
          cpuMs: median(samples.points.map((x) => x.cpuMs)),
          raw: samples.points,
          draw: directStats({ family, representation: 'points', lens }),
          coverage: coverage({ family, representation: 'points', lens }),
        },
        world: {
          gpuMs: median(samples.world.map((x) => x.gpuMs)),
          cpuMs: median(samples.world.map((x) => x.cpuMs)),
          raw: samples.world,
          draw: directStats({ family, representation: 'world', lens }),
          coverage: coverage({ family, representation: 'world', lens }),
        },
      };
    }
  }
  const gl = renderer.getContext();
  const debug = gl.getExtension('WEBGL_debug_renderer_info');
  const rendererName = debug
    ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)
    : gl.getParameter(gl.RENDERER);
  return {
    renderer: rendererName,
    timerQuery: !!gl.getExtension('EXT_disjoint_timer_query_webgl2'),
    measurements,
    resources: {
      petal: {
        instances: petalWorld.stats.instances,
        pointAttributeBytes: attributeBytes(petals.points.geometry),
        pointTextureBytesRGBA8: 3 * 64 * 64 * 4,
        worldAdditionalGpuAttributeBytes: petalWorld.stats.sharedCpuBytes,
        worldBaseGeometryBytes: petalWorld.stats.baseGeometryBytes,
        worldTriangles: petalWorld.stats.triangles,
        worldDofDepthPrograms: petalWorld.stats.dofDepthPrograms,
      },
      mote: {
        instances: motes.getWorldRepresentation().stats.instances,
        pointAttributeBytes: attributeBytes(motes.points.geometry),
        worldAdditionalGpuAttributeBytes: motes.getWorldRepresentation().stats.sharedCpuBytes,
        worldBaseGeometryBytes: motes.getWorldRepresentation().stats.baseGeometryBytes,
        worldTriangles: motes.getWorldRepresentation().stats.triangles,
        worldDofDepthPrograms: motes.getWorldRepresentation().stats.dofDepthPrograms,
      },
    },
  };
};
window.__ready = true;
`;

const built = await esbuild.build({
  stdin: { contents: ENTRY, resolveDir: ROOT, sourcefile: 'detail-particle-shot.js', loader: 'js' },
  bundle: true,
  format: 'iife',
  write: false,
  nodePaths: [resolve(ROOT, 'app/node_modules')],
  logLevel: 'silent',
});
const html = `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#111}
canvas{display:block;width:960px;height:600px}
#label{position:fixed;left:18px;top:16px;padding:8px 11px;border-radius:5px;
background:rgba(7,10,14,.74);color:#fff;font:600 13px/1.25 system-ui;letter-spacing:.045em}
</style><body><script>${built.outputFiles[0].text}</script>`;
const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(html);
});
await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));

const browser = await launchVerificationBrowser();
const page = await browser.newPage({
  viewport: { width: 960, height: 600 },
  deviceScaleFactor: 1,
});
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load' });
await page.waitForFunction('window.__ready === true', { timeout: 30000 });
await reportWebGLRenderer(page, 'detail-particle-shot');

const shots = [
  { family: 'petal', representation: 'points', lens: 'focus', season: 'autumn' },
  { family: 'petal', representation: 'world', lens: 'focus', season: 'autumn' },
  { family: 'petal', representation: 'points', lens: 'aerial', season: 'autumn' },
  { family: 'petal', representation: 'world', lens: 'aerial', season: 'autumn' },
  { family: 'petal', representation: 'world', lens: 'focus', season: 'spring' },
  { family: 'mote', representation: 'points', lens: 'focus' },
  { family: 'mote', representation: 'world', lens: 'focus' },
  { family: 'mote', representation: 'points', lens: 'aerial' },
  { family: 'mote', representation: 'world', lens: 'aerial' },
];

for (const options of shots) {
  await page.evaluate((value) => window.__shot(value), options);
  const suffix = options.season ? `-${options.season}` : '';
  const name = `${options.family}-${options.representation}-${options.lens}${suffix}.png`;
  await page.screenshot({ path: join(OUT, name) });
}
await page.evaluate(() => window.__macro());
await page.screenshot({ path: join(OUT, 'petal-world-macro-autumn.png') });

const metrics = await page.evaluate(() => window.__measure());
const medianNode = (values) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};
metrics.analysis = {};
for (const [name, measurement] of Object.entries(metrics.measurements)) {
  const pointGpu = measurement.points.gpuMs;
  const worldGpu = measurement.world.gpuMs;
  const blockDeltas = [];
  for (let block = 0; block < 4; block++) {
    const pointBlock = medianNode(measurement.points.raw
      .slice(block * 2, block * 2 + 2).map((sample) => sample.gpuMs));
    const worldBlock = medianNode(measurement.world.raw
      .slice(block * 2, block * 2 + 2).map((sample) => sample.gpuMs));
    if (pointBlock != null && worldBlock != null) blockDeltas.push(worldBlock - pointBlock);
  }
  metrics.analysis[name] = {
    worldMinusPointsGpuMs: worldGpu == null || pointGpu == null ? null : worldGpu - pointGpu,
    worldToPointsGpuRatio: worldGpu == null || pointGpu == null ? null : worldGpu / pointGpu,
    deltaShareOf16msFrame: worldGpu == null || pointGpu == null
      ? null : (worldGpu - pointGpu) / 16.667,
    blockDeltas,
    consistentDirection: blockDeltas.length > 0
      && (blockDeltas.every((value) => value >= 0)
        || blockDeltas.every((value) => value <= 0)),
  };
}
metrics.policyEvidence = {
  productAerialSleepsParticles: true,
  petal: 'Use one FULL world-geometry tier inside the existing detail band, then sleep; do not retain FAR Points.',
  dust: 'Keep the world-positioned optical Points model for microscopic scattering; reject enlarged octahedra.',
  firefly: 'Use the compact HDR world volume with explicit source-depth material in FULL; sleep outside the detail band.',
};
await writeFile(join(OUT, 'metrics.json'), `${JSON.stringify(metrics, null, 2)}\n`);
await browser.close();
server.close();

if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
}
console.log(JSON.stringify(metrics, null, 2));
console.log(`output: ${OUT}`);
