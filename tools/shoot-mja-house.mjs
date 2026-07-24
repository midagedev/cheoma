// Isolated visual/resource proof for the reusable ㅁ자 반가 Three assembler.
//
// Usage:
//   node tools/run-browser-locked.mjs -- node tools/shoot-mja-house.mjs
//   CHEOMA_MJA_OUT=/scratch/mja node tools/shoot-mja-house.mjs
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import {
  launchVerificationBrowser,
  reportWebGLRenderer,
} from './lib/verification-browser.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = process.env.CHEOMA_MJA_OUT
  ? resolve(process.env.CHEOMA_MJA_OUT)
  : mkdtempSync(join(tmpdir(), 'cheoma-mja-house-'));
mkdirSync(OUT, { recursive: true });

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
};

const HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    html, body, #app { width: 100%; height: 100%; margin: 0; overflow: hidden; }
    body { background: #c9d5db; }
    canvas { display: block; }
  </style>
  <script type="importmap">
    {"imports":{
      "three":"/app/node_modules/three/build/three.module.js",
      "three/addons/":"/app/node_modules/three/examples/jsm/"
    }}
  </script>
</head>
<body>
<div id="app"></div>
<script type="module">
import * as THREE from 'three';
import { makeMaterials } from '/src/builder/palette.js';
import { planMjaHouse } from '/src/api/mja-house-plan.js';
import { buildMjaHouse, disposeMjaHouse } from '/src/api/mja-house.js';

const view = new URLSearchParams(location.search).get('view') || 'close';
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.08;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.getElementById('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xcbd8de);
scene.fog = new THREE.Fog(0xc7d2d6, 72, 145);

const parcelHalf = 16;
const plan = planMjaHouse({
  context: {
    enabled: true,
    form: 'mja',
    region: '경기 중부',
    climate: '중부 내륙',
    household: '상류 주거',
  },
  parcel: {
    id: 'mja-renderer-fixture',
    seed: 0x141c0de,
    kind: 'giwa',
    center: { x: 0, z: 0 },
    frontDir: { x: 0, z: 1 },
    plotW: parcelHalf * 2,
    plotD: parcelHalf * 2,
    shape: {
      pts: [
        { x: parcelHalf, z: parcelHalf },
        { x: -parcelHalf, z: parcelHalf },
        { x: -parcelHalf, z: -parcelHalf },
        { x: parcelHalf, z: -parcelHalf },
      ],
      roles: ['front', 'left', 'back', 'right'],
    },
    houseLocal: { x: 0, z: -5 },
    houseFitFactor: 0.92,
    sx: 1,
    sy: 1,
    sz: 1,
    rank: 0.92,
    wealth: 0.9,
    access: {
      gateRole: 'front',
      gateLocalPoint: { x: 0, z: parcelHalf },
      roadPoint: { x: 0, z: parcelHalf + 6 },
    },
  },
});
if (!plan) throw new Error('MJA renderer fixture was not eligible');
const mats = makeMaterials('giwa');
const borrowedDisposeCounts = new Map();
for (const value of Object.values(mats)) {
  if (!value?.isMaterial && !value?.isTexture) continue;
  const record = { count: 0 };
  value.addEventListener('dispose', () => { record.count++; });
  borrowedDisposeCounts.set(value, record);
}

function mixByte(hash, byte) {
  hash ^= byte;
  return Math.imul(hash, 16777619) >>> 0;
}

function mixText(hash, text) {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    hash = mixByte(hash, code & 255);
    hash = mixByte(hash, code >>> 8);
  }
  return hash;
}

function transformHash(root) {
  root.updateWorldMatrix(true, true);
  const buffer = new ArrayBuffer(4);
  const data = new DataView(buffer);
  let hash = 2166136261 >>> 0;
  root.traverse((object) => {
    hash = mixText(hash, object.name || object.type);
    for (const value of object.matrixWorld.elements) {
      data.setFloat32(0, value, true);
      for (let byte = 0; byte < 4; byte++) hash = mixByte(hash, data.getUint8(byte));
    }
  });
  return hash.toString(16).padStart(8, '0');
}

function resourceStats(root) {
  const geometries = new Set();
  const materials = new Set();
  const textures = new Set();
  let meshes = 0;
  let triangles = 0;
  root.traverse((object) => {
    if (!object.isMesh && !object.isInstancedMesh) return;
    meshes++;
    if (object.geometry) {
      geometries.add(object.geometry);
      const index = object.geometry.index;
      const positions = object.geometry.attributes?.position;
      const instances = object.isInstancedMesh ? object.count : 1;
      triangles += Math.floor((index?.count || positions?.count || 0) / 3) * instances;
    }
    const current = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of current) {
      if (!material?.isMaterial) continue;
      materials.add(material);
      for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
    }
  });
  return {
    meshes,
    triangles,
    geometries: geometries.size,
    materials: materials.size,
    textures: textures.size,
  };
}

function trackedResources(root, palette) {
  const geometries = new Set();
  const materials = new Set();
  const textures = new Set();
  const addMaterial = (material) => {
    if (!material?.isMaterial) return;
    materials.add(material);
    for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
  };
  for (const value of Object.values(palette || {})) {
    if (value?.isMaterial) addMaterial(value);
    else if (value?.isTexture) textures.add(value);
  }
  root.traverse((object) => {
    if (object.geometry) geometries.add(object.geometry);
    const current = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of current) addMaterial(material);
  });
  return { geometries, materials, textures };
}

function disposeRecords(resources) {
  const records = {};
  for (const [kind, values] of Object.entries(resources)) {
    records[kind] = new Map([...values].map((resource) => {
      const record = { count: 0 };
      resource.addEventListener('dispose', () => { record.count++; });
      return [resource, record];
    }));
  }
  return records;
}

function everyDisposedOnce(records) {
  return Object.values(records).every((byResource) => (
    [...byResource.values()].every((record) => record.count === 1)
  ));
}

const compound = buildMjaHouse(plan, { mats });
const repeated = buildMjaHouse(plan, { mats });
const compoundHash = transformHash(compound);
const repeatedHash = transformHash(repeated);
if (compoundHash !== repeatedHash) {
  throw new Error('MJA transform hash is not deterministic');
}

const repeatedGeometries = new Set();
repeated.traverse((object) => {
  if (object.geometry) repeatedGeometries.add(object.geometry);
});
const geometryDisposeCounts = new Map([...repeatedGeometries].map((geometry) => {
  const record = { count: 0 };
  geometry.addEventListener('dispose', () => { record.count++; });
  return [geometry, record];
}));
const firstDispose = disposeMjaHouse(repeated);
const secondDispose = disposeMjaHouse(repeated);
if (!firstDispose || secondDispose) {
  throw new Error('MJA disposer is not idempotent');
}
if ([...geometryDisposeCounts.values()].some((record) => record.count !== 1)) {
  throw new Error('MJA disposer did not release every owned geometry exactly once');
}
if ([...borrowedDisposeCounts.values()].some((record) => record.count !== 0)) {
  throw new Error('MJA disposer released a caller-owned palette resource');
}

const ownedProbe = buildMjaHouse(plan);
const ownedResources = trackedResources(ownedProbe, ownedProbe.userData.materials);
const ownedDisposeRecords = disposeRecords(ownedResources);
const ownedFirstDispose = disposeMjaHouse(ownedProbe);
const ownedSecondDispose = disposeMjaHouse(ownedProbe);
if (!ownedFirstDispose || ownedSecondDispose || !everyDisposedOnce(ownedDisposeRecords)) {
  throw new Error('MJA internally-owned resource lifecycle is not exact and idempotent');
}

let anchorCount = 0;
let primaryPanelCount = 0;
let compoundAnchor = null;
compound.traverse((object) => {
  if (object.name === 'primary-opening-anchor') {
    anchorCount++;
    compoundAnchor = object;
  }
  if (object.name === 'primary-opening-panel') primaryPanelCount++;
});
if (anchorCount !== 1 || primaryPanelCount !== 0 || !compound.userData.mjaDoorMotionExcluded) {
  throw new Error('MJA compound did not expose one static DoF-only primary opening');
}
const primaryOpening = plan.openings.find((opening) => opening.id === plan.primaryOpeningId);
const authoredAnchor = compound.getObjectByName(
  'mja-' + primaryOpening.wingId + '-primary-opening-anchor',
);
compound.updateWorldMatrix(true, true);
const compoundFocusPoint = compoundAnchor.getWorldPosition(new THREE.Vector3());
const authoredDoorCenterPoint = authoredAnchor
  ? new THREE.Vector3(0, primaryOpening.height * 0.5, 0)
    .applyMatrix4(authoredAnchor.matrixWorld)
  : null;
const expectedFocusPoint = new THREE.Vector3(
  primaryOpening.center.x,
  primaryOpening.center.y,
  primaryOpening.center.z,
);
if (compoundFocusPoint.distanceTo(expectedFocusPoint) > 1e-6
  || !authoredDoorCenterPoint
  || authoredDoorCenterPoint.distanceTo(expectedFocusPoint) > 1e-6) {
  throw new Error('MJA pure-plan primary opening drifted from the authored giwa door');
}

scene.add(compound);
const box = new THREE.Box3().setFromObject(compound);
const size = box.getSize(new THREE.Vector3());
const center = box.getCenter(new THREE.Vector3());

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(Math.max(70, size.x * 2.2), Math.max(70, size.z * 2.2)),
  new THREE.MeshStandardMaterial({ color: 0x9d9279, roughness: 1, metalness: 0 }),
);
ground.name = 'mja-harness-ground';
ground.rotation.x = -Math.PI * 0.5;
ground.position.y = -0.035;
ground.receiveShadow = true;
scene.add(ground);

const sun = new THREE.DirectionalLight(0xffe0b4, 3.0);
sun.position.set(-32, 44, 34);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.bias = -0.0003;
sun.shadow.normalBias = 0.04;
sun.shadow.camera.left = -42;
sun.shadow.camera.right = 42;
sun.shadow.camera.top = 38;
sun.shadow.camera.bottom = -38;
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 140;
scene.add(sun, sun.target);
sun.target.position.set(center.x, 0, center.z);
scene.add(new THREE.HemisphereLight(0xd7e4ea, 0x776955, 1.08));

const camera = new THREE.PerspectiveCamera(
  view === 'close' ? 35 : 39,
  innerWidth / innerHeight,
  0.1,
  220,
);
if (view === 'close') {
  camera.position.set(
    center.x + size.x * 0.12,
    Math.max(5.6, size.y * 0.82),
    box.max.z + size.z * 0.78,
  );
  camera.lookAt(
    primaryOpening.center.x,
    primaryOpening.center.y,
    primaryOpening.center.z,
  );
} else {
  camera.position.set(
    center.x + size.x * 0.92,
    Math.max(25, size.z * 1.16),
    center.z + size.z * 1.0,
  );
  camera.lookAt(center.x, 1.0, center.z);
}
camera.updateProjectionMatrix();

renderer.render(scene, camera);
const memoryBaseline = { ...renderer.info.memory };
const plateaus = [];
for (let cycle = 0; cycle < 3; cycle++) {
  const probe = buildMjaHouse(plan, { mats });
  probe.position.x = 90;
  scene.add(probe);
  renderer.render(scene, camera);
  probe.removeFromParent();
  if (!disposeMjaHouse(probe)) throw new Error('MJA plateau probe did not dispose');
  renderer.render(scene, camera);
  plateaus.push({
    geometries: renderer.info.memory.geometries,
    textures: renderer.info.memory.textures,
    programs: renderer.info.programs?.length ?? 0,
  });
}
const plateauStable = plateaus.every((sample) => (
  sample.geometries === memoryBaseline.geometries
  && sample.textures === memoryBaseline.textures
));
if (!plateauStable) {
  throw new Error('MJA renderer memory did not return to its post-warm plateau: '
    + JSON.stringify({ memoryBaseline, plateaus }));
}

renderer.render(scene, camera);
const resources = resourceStats(compound);
window.__MJA_AUDIT = {
  view,
  schema: plan.schema,
  kind: plan.kind,
  wings: plan.wings.length,
  transformHash: compoundHash,
  deterministic: compoundHash === repeatedHash,
  primary: {
    anchorCount,
    primaryPanelCount,
    staticDoorMotion: compound.userData.mjaDoorMotionExcluded === true,
    planToAuthoredError: authoredDoorCenterPoint.distanceTo(expectedFocusPoint),
  },
  compound: resources,
  frame: {
    calls: renderer.info.render.calls,
    triangles: renderer.info.render.triangles,
    programs: renderer.info.programs?.length ?? 0,
    memory: { ...renderer.info.memory },
  },
  ownership: {
    firstDispose,
    secondDispose,
    geometryCount: geometryDisposeCounts.size,
    everyGeometryDisposedOnce: [...geometryDisposeCounts.values()]
      .every((record) => record.count === 1),
    borrowedPaletteDisposals: [...borrowedDisposeCounts.values()]
      .reduce((sum, record) => sum + record.count, 0),
    ownedFirstDispose,
    ownedSecondDispose,
    ownedResources: Object.fromEntries(Object.entries(ownedDisposeRecords)
      .map(([kind, records]) => [kind, records.size])),
    everyOwnedResourceDisposedOnce: everyDisposedOnce(ownedDisposeRecords),
    plateauStable,
    plateaus,
  },
};
window.__SHOT_READY = true;
</script>
</body>
</html>`;

const server = createServer(async (request, response) => {
  const pathname = request.url.split('?')[0];
  if (pathname === '/__mja_house') {
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

await new Promise((resolveListen, rejectListen) => {
  server.listen(0, '127.0.0.1', resolveListen).on('error', rejectListen);
});
const port = server.address().port;
const shots = ['close', 'aerial'];
const audits = {};
const failures = [];
let browser;

try {
  browser = await launchVerificationBrowser();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (error) => failures.push(`page: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' && !/favicon|404/i.test(message.text())) {
      failures.push(`console: ${message.text()}`);
    }
  });

  for (const view of shots) {
    await page.goto(`http://127.0.0.1:${port}/__mja_house?view=${view}`, {
      waitUntil: 'load',
      timeout: 60_000,
    });
    await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 60_000 });
    await page.waitForTimeout(120);
    audits[view] = await page.evaluate(() => window.__MJA_AUDIT);
    const imagePath = join(OUT, `mja-house-${view}.png`);
    await page.locator('canvas').screenshot({ path: imagePath });
    console.log(`${view} ${JSON.stringify(audits[view])} ${imagePath}`);
  }
  await reportWebGLRenderer(page, 'mja-house');
  if (audits.close.transformHash !== audits.aerial.transformHash) {
    failures.push('close/aerial transform hashes differ');
  }
} catch (error) {
  failures.push(error instanceof Error ? error.stack || error.message : String(error));
} finally {
  await browser?.close();
  server.close();
}

console.log(`shoot-mja-house: ${failures.length ? 'FAIL' : 'PASS'} output=${OUT}`);
if (failures.length) {
  for (const failure of failures) console.error(failure);
  process.exitCode = 1;
}
