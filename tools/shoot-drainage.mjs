import { createServer } from 'node:http';
import { readFile, mkdtemp } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { PNG } from 'pngjs';
import {
  launchVerificationBrowser,
  reportWebGLRenderer,
} from './lib/verification-browser.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
};
const invariant = (condition, message) => {
  if (!condition) throw new Error(message);
};

const PRODUCT_HTML = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#c5d0d1}canvas{display:block}</style>
<script type="importmap">{"imports":{
  "three":"/app/node_modules/three/build/three.module.js",
  "three/addons/":"/app/node_modules/three/examples/jsm/"
}}</script></head><body><script type="module">
import * as THREE from 'three';
import { createVillage } from '/src/village/adapter.js';

const OPTIONS = Object.freeze({
  scale: 'capital',
  seed: 11,
  character: 'yeoyeom',
});
const renderer = new THREE.WebGLRenderer({
  antialias: true,
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(1);
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.04;
renderer.shadowMap.enabled = false;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xc5d0d1);
scene.fog = new THREE.Fog(scene.background, 100, 360);
const handle = createVillage(OPTIONS);
scene.add(handle.group);

const drainagePlan = handle.plan?.drainage;
if (!drainagePlan?.runs?.length) throw new Error('capital/11 drainage plan has no runs');
if (!drainagePlan.crossings?.length) {
  throw new Error('capital/11 drainage fixture has no gate crossing');
}
const drainage = handle.group.getObjectByName('roadside-drainage-ground');
if (!drainage) throw new Error('populated village is missing roadside-drainage-ground');
const ditchMesh = drainage.getObjectByName('road-drainage-ground');
const crossingMesh = drainage.getObjectByName('road-drainage-stone-crossings');
if (!ditchMesh || !crossingMesh) throw new Error('drainage named meshes are incomplete');

const target = drainagePlan.crossings[0];
const travel = {
  x: Math.sin(target.yaw),
  z: Math.cos(target.yaw),
};
const right = { x: travel.z, z: -travel.x };
const camera = new THREE.PerspectiveCamera(30, innerWidth / innerHeight, 0.05, 420);

const sun = new THREE.DirectionalLight(0xffd1a0, 3.4);
sun.position.set(
  target.center.x - 28,
  target.center.y + 38,
  target.center.z + 24,
);
sun.target.position.set(target.center.x, target.center.y, target.center.z);
scene.add(sun, sun.target);
scene.add(new THREE.HemisphereLight(0xe2e8df, 0x62543f, 1.35));

function setView(view) {
  if (view === 'aerial') {
    camera.fov = 36;
    camera.position.set(
      target.center.x - travel.x * 16 + right.x * 13,
      target.center.y + 18,
      target.center.z - travel.z * 16 + right.z * 13,
    );
    camera.lookAt(target.center.x, target.center.y - 0.03, target.center.z);
  } else {
    camera.fov = 28;
    camera.position.set(
      target.center.x - travel.x * 3.6 + right.x * 2.65,
      target.center.y + 2.35,
      target.center.z - travel.z * 3.6 + right.z * 2.65,
    );
    camera.lookAt(
      target.center.x + travel.x * 0.05,
      target.center.y - 0.035,
      target.center.z + travel.z * 0.05,
    );
  }
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
}

function materialTextures(material) {
  const textures = new Set();
  for (const value of Object.values(material || {})) {
    if (value?.isTexture) textures.add(value);
  }
  for (const uniform of Object.values(material?.uniforms || {})) {
    const value = uniform?.value;
    if (value?.isTexture) textures.add(value);
    else if (Array.isArray(value)) {
      for (const item of value) if (item?.isTexture) textures.add(item);
    }
  }
  return textures;
}

function geometryTriangles(geometry) {
  return (geometry.index?.count || geometry.attributes.position.count) / 3;
}

function hashString(hash, text) {
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function hashGeometry(root) {
  let hash = 0x811c9dc5;
  const scratch = new DataView(new ArrayBuffer(8));
  const meshes = [];
  root.traverse((object) => {
    if (object.isMesh) meshes.push(object);
  });
  meshes.sort((left, right) => left.name.localeCompare(right.name));
  for (const mesh of meshes) {
    hash = hashString(hash, mesh.name);
    for (const key of ['position', 'normal', 'color']) {
      const values = mesh.geometry.getAttribute(key)?.array || [];
      hash = hashString(hash, key);
      for (const value of values) {
        scratch.setFloat64(0, value, true);
        hash ^= scratch.getUint32(0, true);
        hash = Math.imul(hash, 0x01000193);
        hash ^= scratch.getUint32(4, true);
        hash = Math.imul(hash, 0x01000193);
      }
    }
    const indices = mesh.geometry.index?.array || [];
    for (const value of indices) {
      hash ^= value;
      hash = Math.imul(hash, 0x01000193);
    }
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

// A second actual createVillage run proves that renderer geometry follows only
// the deterministic plan record. Three's UUID allocation is deliberately not
// part of this hash.
const replay = createVillage(OPTIONS);
const replayDrainage = replay.group.getObjectByName('roadside-drainage-ground');
const deterministicPlan = JSON.stringify(replay.plan?.drainage)
  === JSON.stringify(drainagePlan);
const geometryHash = hashGeometry(drainage);
const replayGeometryHash = replayDrainage ? hashGeometry(replayDrainage) : null;
const deterministicGeometry = geometryHash === replayGeometryHash;
replay.dispose();

const materials = new Set();
const textures = new Set();
const meshes = [];
drainage.traverse((object) => {
  if (!object.isMesh) return;
  meshes.push(object);
  const list = Array.isArray(object.material) ? object.material : [object.material];
  for (const material of list) {
    materials.add(material);
    for (const texture of materialTextures(material)) textures.add(texture);
  }
});
const expectedTriangles = drainagePlan.runs.reduce(
  (sum, run) => sum + Math.max(0, run.points.length - 1) * 6,
  0,
) + drainagePlan.crossings.length * 36;
const ownedTriangles = meshes.reduce(
  (sum, mesh) => sum + geometryTriangles(mesh.geometry),
  0,
);

function renderState(visible) {
  drainage.visible = visible;
  handle.update(1 / 60);
  renderer.render(scene, camera);
  return {
    visible,
    calls: renderer.info.render.calls,
    triangles: renderer.info.render.triangles,
    programs: renderer.info.programs.length,
  };
}

let baselinePrograms = null;
function measure(view) {
  setView(view);
  const off = renderState(false);
  if (baselinePrograms == null) baselinePrograms = off.programs;
  const on = renderState(true);
  return {
    view,
    off,
    on,
    drawDelta: on.calls - off.calls,
    triangleDelta: on.triangles - off.triangles,
    programDelta: on.programs - baselinePrograms,
  };
}

window.__DRAINAGE_SET_VIEW = (view) => {
  setView(view);
  renderer.render(scene, camera);
};
window.__DRAINAGE_SET_VISIBLE = (visible) => {
  drainage.visible = !!visible;
  renderer.render(scene, camera);
};
window.__DRAINAGE_MEASURE = (view) => measure(view);

setView('close');
drainage.visible = false;
let frames = 0;
renderer.setAnimationLoop(() => {
  handle.update(1 / 60);
  renderer.render(scene, camera);
  if (++frames < 12) return;
  renderer.setAnimationLoop(null);
  baselinePrograms = renderer.info.programs.length;
  window.__DRAINAGE_DIAG = {
    seed: OPTIONS.seed,
    scale: OPTIONS.scale,
    runCount: drainagePlan.runs.length,
    crossingCount: drainagePlan.crossings.length,
    crossingId: target.id,
    meshCount: meshes.length,
    materialCount: materials.size,
    textureCount: textures.size,
    ownedTriangles,
    expectedTriangles,
    geometryHash,
    replayGeometryHash,
    deterministicPlan,
    deterministicGeometry,
    groupName: drainage.name,
    meshNames: meshes.map((mesh) => mesh.name).sort(),
    crossingTop: target.center.y,
    crossingSpan: target.span,
    crossingWidth: target.width,
  };
  window.__DRAINAGE_READY = true;
});
</script></body></html>`;

const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    if (pathname === '/favicon.ico') {
      response.writeHead(204);
      response.end();
      return;
    }
    if (pathname === '/__drainage_product') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(PRODUCT_HTML);
      return;
    }
    const file = resolve(ROOT, `.${pathname}`);
    if (file !== ROOT && !file.startsWith(`${ROOT}${sep}`)) throw new Error('unsafe path');
    const body = await readFile(file);
    response.writeHead(200, {
      'content-type': MIME[extname(file)] || 'application/octet-stream',
    });
    response.end(body);
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('not found');
  }
});
await new Promise((done, reject) =>
  server.listen(0, '127.0.0.1', done).on('error', reject));

function meanDifference(leftBuffer, rightBuffer) {
  const left = PNG.sync.read(leftBuffer);
  const right = PNG.sync.read(rightBuffer);
  invariant(
    left.width === right.width && left.height === right.height,
    'drainage frame dimensions drifted',
  );
  let total = 0;
  for (let offset = 0; offset < left.data.length; offset += 4) {
    total += Math.abs(left.data[offset] - right.data[offset]);
    total += Math.abs(left.data[offset + 1] - right.data[offset + 1]);
    total += Math.abs(left.data[offset + 2] - right.data[offset + 2]);
  }
  return total / (left.width * left.height * 3);
}

const output = process.env.CHEOMA_CAPTURE_DIR
  || await mkdtemp(join(tmpdir(), 'cheoma-drainage-'));
const browser = await launchVerificationBrowser();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (error) => errors.push(`page: ${error.message}`));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(`console: ${message.text()}`);
});
const port = server.address().port;

async function capture(view, visible) {
  await page.evaluate(({ nextView, nextVisible }) => {
    window.__DRAINAGE_SET_VIEW(nextView);
    window.__DRAINAGE_SET_VISIBLE(nextVisible);
  }, { nextView: view, nextVisible: visible });
  const path = join(output, `drainage-${view}-${visible ? 'on' : 'off'}.png`);
  const buffer = await page.locator('canvas').screenshot({ path });
  return { view, visible, path, buffer };
}

try {
  await page.goto(`http://127.0.0.1:${port}/__drainage_product`, {
    waitUntil: 'load',
  });
  await page.waitForFunction(() => window.__DRAINAGE_READY === true, null, {
    timeout: 120_000,
  });
  const diag = await page.evaluate(() => window.__DRAINAGE_DIAG);
  const closeOff = await capture('close', false);
  const closeOn = await capture('close', true);
  const closeMeasure = await page.evaluate(() => window.__DRAINAGE_MEASURE('close'));
  const aerialOff = await capture('aerial', false);
  const aerialOn = await capture('aerial', true);
  const aerialMeasure = await page.evaluate(() => window.__DRAINAGE_MEASURE('aerial'));
  const deltas = {
    close: meanDifference(closeOff.buffer, closeOn.buffer),
    aerial: meanDifference(aerialOff.buffer, aerialOn.buffer),
  };

  invariant(errors.length === 0, errors.join(' | '));
  invariant(diag.runCount > 0 && diag.crossingCount > 0,
    `capital/11 drainage fixture drifted ${JSON.stringify(diag)}`);
  invariant(diag.groupName === 'roadside-drainage-ground',
    `drainage group name drifted (${diag.groupName})`);
  invariant(diag.meshCount === 2
    && diag.meshNames.includes('road-drainage-ground')
    && diag.meshNames.includes('road-drainage-stone-crossings'),
  `drainage mesh family drifted ${JSON.stringify(diag.meshNames)}`);
  invariant(diag.materialCount === 1 && diag.textureCount === 0,
    `drainage material budget drifted ${JSON.stringify(diag)}`);
  invariant(diag.ownedTriangles === diag.expectedTriangles,
    `drainage triangle formula drifted ${diag.ownedTriangles}/${diag.expectedTriangles}`);
  invariant(diag.deterministicPlan && diag.deterministicGeometry,
    `drainage determinism failed ${diag.geometryHash}/${diag.replayGeometryHash}`);
  for (const measure of [closeMeasure, aerialMeasure]) {
    invariant(measure.drawDelta >= 1 && measure.drawDelta <= 2,
      `${measure.view} drainage draw delta drifted (${measure.drawDelta})`);
    invariant(measure.triangleDelta > 0
      && measure.triangleDelta <= diag.ownedTriangles,
    `${measure.view} drainage triangle submission drifted (${measure.triangleDelta})`);
    invariant(measure.programDelta <= 1,
      `${measure.view} drainage program delta drifted (${measure.programDelta})`);
  }
  invariant(deltas.close >= 0.005,
    `close drainage contribution is not visible (${deltas.close.toFixed(4)})`);
  invariant(deltas.aerial < deltas.close,
    `drainage did not recede with distance (${deltas.close.toFixed(4)} -> ${deltas.aerial.toFixed(4)})`);

  await reportWebGLRenderer(page, 'drainage');
  console.log(
    `DRAINAGE BROWSER: PASS (capital/${diag.seed}, runs/crossings=`
    + `${diag.runCount}/${diag.crossingCount}, delta close/aerial=`
    + `${deltas.close.toFixed(4)}/${deltas.aerial.toFixed(4)}, draws close/aerial=`
    + `${closeMeasure.drawDelta}/${aerialMeasure.drawDelta}, triangles owned/submitted=`
    + `${diag.ownedTriangles}/${closeMeasure.triangleDelta}, programs +`
    + `${Math.max(closeMeasure.programDelta, aerialMeasure.programDelta)}, materials/textures=`
    + `${diag.materialCount}/${diag.textureCount}, hash=${diag.geometryHash})`,
  );
  console.log(`captures=${output}`);
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
