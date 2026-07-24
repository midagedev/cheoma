// Isolated browser proof for the reusable #131 seasonal yard-life renderer.
//
// The fixture consumes only the renderer's exported controller API. It verifies
// deterministic physical geometry, the six-role draw ceiling, color/depth/distance
// screen-door parity, season/weather/LOD/wave composition, rebuild plateaus, and
// borrowed-resource ownership. Captures default to an OS scratch directory.
//
// Usage:
//   node tools/run-browser-locked.mjs -- node tools/shoot-yard-life.mjs
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import {
  launchVerificationBrowser,
  reportWebGLRenderer,
} from './lib/verification-browser.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = process.env.CHEOMA_YARD_LIFE_OUT
  ? resolve(process.env.CHEOMA_YARD_LIFE_OUT)
  : mkdtempSync(join(tmpdir(), 'cheoma-yard-life-'));
mkdirSync(OUT, { recursive: true });

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
};

const HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    html, body, #app { width: 100%; height: 100%; margin: 0; overflow: hidden; }
    body { background: #c7d0c2; }
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
import {
  buildYardLife,
  disposeYardLife,
  YARD_LIFE_MATERIAL_ROLES,
} from '/src/api/yard-life.js';
import { createVillageYardLife } from '/src/runtime/village/yard-life.js';

const renderer = new THREE.WebGLRenderer({
  antialias: true,
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(1);
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.08;
document.getElementById('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xc7d0c2);
scene.fog = new THREE.Fog(0xc7d0c2, 13, 27);

const camera = new THREE.PerspectiveCamera(39, innerWidth / innerHeight, 0.05, 60);
camera.position.set(2.75, 1.85, 3.2);
camera.lookAt(0, 0.35, 0);

const hemi = new THREE.HemisphereLight(0xdde7e7, 0x645845, 1.5);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffe1b6, 3.1);
sun.position.set(-4.5, 8, 5);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
sun.shadow.camera.left = -6;
sun.shadow.camera.right = 6;
sun.shadow.camera.top = 6;
sun.shadow.camera.bottom = -6;
sun.shadow.camera.near = 0.1;
sun.shadow.camera.far = 24;
scene.add(sun);

const groundMaterial = new THREE.MeshStandardMaterial({
  color: 0x817a5d,
  roughness: 1,
  metalness: 0,
});
const ground = new THREE.Mesh(new THREE.PlaneGeometry(18, 14), groundMaterial);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -0.015;
ground.receiveShadow = true;
scene.add(ground);

function material(name, color, role) {
  const value = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.96,
    metalness: 0,
  });
  value.name = 'yard-life-fixture-' + name;
  value.userData.role = role;
  return value;
}

const materials = {
  wood: material('wood', 0x60402a, 'wood'),
  onggi: material('onggi', 0x4b2920, 'stone'),
  straw: material('straw', 0xb69550, 'wood'),
  stone: material('stone', 0x716f69, 'stone'),
  chaff: material('chaff', 0xc4a35b, 'wood'),
  fiber: material('fiber', 0x866f43, 'wood'),
};

const BASE_RECORDS = Object.freeze([
  {
    schema: 1,
    id: 'fixture:spring',
    owner: { parcelId: 'fixture-house' },
    season: 'spring',
    motif: 'spring-seed-prep',
    variant: 'onggi-bowl',
    weather: { allow: ['clear', 'rain'] },
    footprint: { shape: 'rect', halfX: 0.72, halfZ: 0.56, yaw: 0 },
    world: { x: 0, y: 0.18, z: 0, yaw: -0.18 },
    scale: 1,
    height: 0.43,
    materialRoles: ['onggi', 'fiber'],
    parts: [
      { kind: 'water-bowl', materialRole: 'onggi', count: 1 },
      { kind: 'seed-basket', materialRole: 'fiber', count: 2 },
    ],
  },
  {
    schema: 1,
    id: 'fixture:autumn',
    owner: { parcelId: 'fixture-house' },
    season: 'autumn',
    motif: 'autumn-threshing',
    variant: 'gesang',
    weather: { allow: ['clear'] },
    footprint: { shape: 'rect', halfX: 1.08, halfZ: 0.73, yaw: 0 },
    world: { x: 0, y: 0.18, z: 0, yaw: -0.18 },
    scale: 1,
    height: 0.97,
    materialRoles: ['wood', 'straw', 'chaff'],
    parts: [
      { kind: 'threshing-bench', materialRole: 'wood', count: 1 },
      { kind: 'bound-sheaf', materialRole: 'straw', count: 4 },
      { kind: 'chaff-patch', materialRole: 'chaff', count: 1 },
    ],
  },
  {
    schema: 1,
    id: 'fixture:winter',
    owner: { parcelId: 'fixture-house' },
    season: 'winter',
    motif: 'winter-fuel',
    variant: 'straw-covered-firewood',
    weather: { allow: ['clear', 'rain', 'snow'] },
    footprint: { shape: 'rect', halfX: 0.88, halfZ: 0.62, yaw: 0 },
    world: { x: 0, y: 0.18, z: 0, yaw: -0.18 },
    scale: 1,
    height: 1.08,
    materialRoles: ['wood', 'straw'],
    parts: [
      { kind: 'split-log', materialRole: 'wood', count: 12 },
      { kind: 'stack-support', materialRole: 'wood', count: 1 },
      { kind: 'straw-cover', materialRole: 'straw', count: 1 },
    ],
  },
]);

function cloneRecords(x = 0, y = 0.18, suffix = '') {
  return BASE_RECORDS.map((record) => ({
    ...record,
    id: record.id + suffix,
    owner: { ...record.owner },
    weather: { allow: [...record.weather.allow] },
    footprint: { ...record.footprint },
    world: { ...record.world, x, y },
    materialRoles: [...record.materialRoles],
    parts: record.parts.map((part) => ({ ...part })),
  }));
}

function geometryHash(root) {
  let hash = 2166136261 >>> 0;
  const scratch = new ArrayBuffer(4);
  const view = new DataView(scratch);
  root.traverse((object) => {
    const positions = object.geometry?.attributes?.position?.array;
    if (!positions) return;
    for (const value of positions) {
      view.setFloat32(0, value, true);
      for (let byte = 0; byte < 4; byte++) {
        hash ^= view.getUint8(byte);
        hash = Math.imul(hash, 16777619) >>> 0;
      }
    }
  });
  return hash.toString(16).padStart(8, '0');
}

function ownedGeometries(root) {
  const result = new Set();
  root.traverse((object) => {
    if (object.geometry) result.add(object.geometry);
  });
  return result;
}

function ownedMaterials(root) {
  const result = new Set();
  root.traverse((object) => {
    if (object.material) result.add(object.material);
    if (object.customDepthMaterial) result.add(object.customDepthMaterial);
    if (object.customDistanceMaterial) result.add(object.customDistanceMaterial);
  });
  return result;
}

function render() {
  renderer.render(scene, camera);
}

let heightFallbackCalls = 0;
const yardLife = buildYardLife(cloneRecords(), {
  materials,
  season: 'spring',
  weather: 'clear',
  transitionSeconds: 1,
  heightAt() {
    heightFallbackCalls++;
    return 9;
  },
});
scene.add(yardLife.group);
render();

function usePresentation(season, weather = 'clear', wave = 1, detailWeight = 1) {
  yardLife.setSeason(season, { immediate: true });
  yardLife.setWeather(weather, { immediate: true });
  yardLife.setWaveFade(wave);
  yardLife.updateLod(null, { groundActive: detailWeight > 0, groundWeight: detailWeight });
  render();
  return yardLife.debug();
}

function assert(condition, message, detail = null) {
  if (condition) return;
  throw new Error(message + (detail == null ? '' : ': ' + JSON.stringify(detail)));
}

async function runContracts() {
  assert(heightFallbackCalls === 0, 'finite record.world.y did not remain authoritative');
  assert(YARD_LIFE_MATERIAL_ROLES.length === 6, 'semantic role ceiling changed');
  const initial = yardLife.debug();
  assert(initial.recordCount === 3, 'fixture record count changed', initial);
  assert(initial.allocatedDrawCalls > 0 && initial.allocatedDrawCalls <= 6,
    'yard-life exceeded the six-role draw ceiling', initial);
  assert(initial.textures === 0, 'yard-life allocated a texture', initial);
  assert(initial.resources.geometries === initial.allocatedDrawCalls,
    'geometry count diverged from role batches', initial);

  const beforeRejectedTransition = yardLife.debug();
  let rejectedSeasonDuration = false;
  try {
    yardLife.setSeason('autumn', { duration: Number.NaN });
  } catch {
    rejectedSeasonDuration = true;
  }
  const afterRejectedSeason = yardLife.debug();
  assert(rejectedSeasonDuration
    && afterRejectedSeason.season === beforeRejectedTransition.season
    && afterRejectedSeason.seasonTransitioning === beforeRejectedTransition.seasonTransitioning
    && JSON.stringify(afterRejectedSeason.weights)
      === JSON.stringify(beforeRejectedTransition.weights),
  'invalid season duration mutated presentation state', afterRejectedSeason);
  let rejectedWeatherDuration = false;
  try {
    yardLife.setWeather('rain', { duration: Number.NaN });
  } catch {
    rejectedWeatherDuration = true;
  }
  const afterRejectedWeather = yardLife.debug();
  assert(rejectedWeatherDuration
    && afterRejectedWeather.weather === beforeRejectedTransition.weather
    && afterRejectedWeather.weatherTransitioning === beforeRejectedTransition.weatherTransitioning
    && JSON.stringify(afterRejectedWeather.weights)
      === JSON.stringify(beforeRejectedTransition.weights),
  'invalid weather duration mutated presentation state', afterRejectedWeather);

  const meshes = [];
  yardLife.group.traverse((object) => {
    if (object.isMesh) meshes.push(object);
  });
  assert(meshes.length === initial.allocatedDrawCalls,
    'mesh count diverged from role batches', meshes.map((mesh) => mesh.name));
  for (const mesh of meshes) {
    assert(mesh.material.transparent === false, 'yard-life material became transparent', mesh.name);
    assert(mesh.material.depthWrite === true, 'yard-life material disabled depthWrite', mesh.name);
    assert(mesh.geometry.getAttribute('instFade'), 'color mesh lacks instFade coverage', mesh.name);
    assert(mesh.geometry.getAttribute('instFade').usage === THREE.DynamicDrawUsage,
      'per-frame instFade coverage is not marked for dynamic uploads', mesh.name);
    assert(mesh.customDepthMaterial?.allowOverride === false,
      'custom depth material allows override', mesh.name);
    assert(mesh.customDistanceMaterial?.allowOverride === false,
      'custom distance material allows override', mesh.name);
    assert(mesh.userData.dofDepthMaterial === mesh.customDepthMaterial,
      'DoF depth material diverged from shadow depth material', mesh.name);
    assert(mesh.customDepthMaterial?.userData?.__instFadePatchVersion
      === mesh.material.userData.__instFadePatchVersion,
      'color and depth instFade patch versions diverged', mesh.name);
    assert(mesh.customDistanceMaterial?.userData?.__instFadePatchVersion
      === mesh.material.userData.__instFadePatchVersion,
      'color and distance instFade patch versions diverged', mesh.name);
  }
  for (const source of Object.values(materials)) {
    assert(source.vertexColors === false, 'borrowed material was mutated');
    assert(!source.userData.__instFadePatchVersion, 'borrowed material was shader-patched');
  }

  await renderer.compileAsync(scene, camera);
  render();
  const baselinePrograms = renderer.info.programs.length;
  const baselineMemory = { ...renderer.info.memory };
  const initialHash = geometryHash(yardLife.group);

  yardLife.setSeason('autumn', { duration: 1 });
  const seasonAdvanced = yardLife.update(0.45);
  const mixedSeason = yardLife.debug();
  assert(seasonAdvanced, 'active season transition did not invalidate presentation/depth');
  assert(mixedSeason.seasonTransitioning, 'season transition hard-cut');
  assert(mixedSeason.weights[0] > 0 && mixedSeason.weights[0] < 1,
    'outgoing season did not crossfade', mixedSeason.weights);
  assert(mixedSeason.weights[1] > 0 && mixedSeason.weights[1] < 1,
    'incoming season did not crossfade', mixedSeason.weights);

  const transitionMeshes = [...yardLife.group.children];
  const transitionGeometries = [...ownedGeometries(yardLife.group)];
  const transitionDisposals = transitionGeometries.map((geometry) => {
    const state = { count: 0 };
    geometry.addEventListener('dispose', () => state.count++);
    return state;
  });
  const skippedBefore = mixedSeason.skippedRebuilds;
  assert(!yardLife.rebuild(cloneRecords()),
    'byte-identical records replaced live geometry');
  const afterNoopRebuild = yardLife.debug();
  assert(afterNoopRebuild.skippedRebuilds === skippedBefore + 1
      && afterNoopRebuild.seasonTransitioning
      && JSON.stringify(afterNoopRebuild.weights) === JSON.stringify(mixedSeason.weights)
      && yardLife.group.children.every((mesh, index) => mesh === transitionMeshes[index])
      && transitionDisposals.every((state) => state.count === 0),
  'byte-identical rebuild disturbed an active transition or ownership',
  afterNoopRebuild);

  const changedRecords = cloneRecords(0.018);
  const addedAutumn = cloneRecords(0.55)[1];
  addedAutumn.id = 'fixture:autumn-added';
  changedRecords.push(addedAutumn);
  assert(yardLife.rebuild(changedRecords),
    'changed records did not rebuild');
  const afterChangedRebuild = yardLife.debug();
  assert(afterChangedRebuild.seasonTransitioning
      && afterChangedRebuild.weights.slice(0, 3).every((value, index) => (
        Math.abs(value - mixedSeason.weights[index]) < 1e-6
      ))
      && afterChangedRebuild.weights[3] === 1
      && yardLife.group.children.some((mesh, index) => mesh !== transitionMeshes[index])
      && transitionDisposals.every((state) => state.count === 1),
  'changed rebuild hard-cut the active transition or leaked old geometry',
  afterChangedRebuild);

  yardLife.update(0.1);
  const afterRebuildAdvance = yardLife.debug();
  // update() caps the first 0.45s sample to 0.25s, then advances another 0.1s.
  const expectedSeasonMix = 0.35 * 0.35 * (3 - 2 * 0.35);
  assert(Math.abs(afterRebuildAdvance.weights[0] - (1 - expectedSeasonMix)) < 1e-6
      && Math.abs(afterRebuildAdvance.weights[1] - expectedSeasonMix) < 1e-6
      && afterRebuildAdvance.weights[3] === 1,
  'changed rebuild distorted the carried transition or a new record target',
  afterRebuildAdvance);

  yardLife.update(0.45);
  yardLife.setWeather('rain', { duration: 1 });
  const weatherAdvanced = yardLife.update(0.45);
  const mixedWeather = yardLife.debug();
  assert(weatherAdvanced, 'active weather transition did not invalidate presentation/depth');
  assert(mixedWeather.weatherTransitioning, 'weather transition hard-cut');
  assert(mixedWeather.weights[1] > 0 && mixedWeather.weights[1] < 1,
    'autumn clear-only activity did not crossfade in rain', mixedWeather.weights);

  const winterClear = usePresentation('winter', 'clear');
  const winterHash = geometryHash(yardLife.group);
  const winterSnow = usePresentation('winter', 'snow');
  assert(winterClear.activeRecords === 1 && winterSnow.activeRecords === 1,
    'seed-stable winter cover changed across clear/snow', { winterClear, winterSnow });
  assert(winterHash === geometryHash(yardLife.group),
    'weather changed physical winter geometry');

  usePresentation('winter', 'snow', 1, 1);
  const detailChanged = yardLife.updateLod(
    null,
    { groundActive: true, groundWeight: 0.43 },
  );
  render();
  const partialDetail = yardLife.debug();
  assert(detailChanged, 'detail coverage change did not invalidate cached depth/shadows');
  assert(!yardLife.updateLod(null, { groundActive: true, groundWeight: 0.43 }),
    'stable detail coverage reported a false invalidation');
  assert(Math.abs(partialDetail.weights[2] - 0.43) < 1e-5,
    'detail weight was not composed', partialDetail.weights);
  const sleeping = usePresentation('winter', 'snow', 1, 0);
  assert(!yardLife.group.visible && sleeping.submittedDrawCalls === 0,
    'aerial LOD did not sleep the whole layer', sleeping);
  const sleepScanCount = sleeping.lodScanCount;
  const sleepCount = sleeping.lodSleepCount;
  for (let frame = 0; frame < 20; frame++) {
    assert(!yardLife.updateLod(null, { groundActive: false, groundWeight: 0 }),
      'steady aerial LOD reported a false invalidation');
  }
  const steadySleep = yardLife.debug();
  assert(steadySleep.detailSleeping
      && steadySleep.lodScanCount === sleepScanCount
      && steadySleep.lodSleepCount === sleepCount + 20,
  'steady aerial LOD scanned or allocated instead of taking the O(1) sleep path',
  steadySleep);
  const halfWave = usePresentation('winter', 'snow', 0.36, 1);
  assert(Math.abs(halfWave.weights[2] - 0.36) < 1e-5,
    'wave weight was not composed', halfWave.weights);
  usePresentation('spring', 'clear');

  const disposedGeometries = [];
  for (let iteration = 0; iteration < 4; iteration++) {
    const previous = ownedGeometries(yardLife.group);
    const counters = [...previous].map((geometry) => {
      const state = { count: 0 };
      geometry.addEventListener('dispose', () => state.count++);
      return state;
    });
    disposedGeometries.push(...counters);
    yardLife.rebuild(cloneRecords(iteration * 0.025, 0.18, ':r' + iteration));
    usePresentation('spring', 'clear');
    assert(counters.every((state) => state.count === 1),
      'rebuild did not dispose each replaced geometry exactly once', counters);
    assert(yardLife.debug().resources.geometries === initial.resources.geometries,
      'rebuild changed owned geometry count', yardLife.debug());
    assert(renderer.info.memory.geometries === baselineMemory.geometries,
      'rebuild escaped the renderer geometry plateau', {
        baseline: baselineMemory,
        current: renderer.info.memory,
      });
    assert(renderer.info.memory.textures === baselineMemory.textures,
      'rebuild allocated a texture', {
        baseline: baselineMemory,
        current: renderer.info.memory,
      });
    assert(renderer.info.programs.length === baselinePrograms,
      'season/rebuild path allocated a new shader program', {
        baselinePrograms,
        currentPrograms: renderer.info.programs.length,
      });
  }

  yardLife.rebuild(cloneRecords());
  usePresentation('spring', 'clear');
  assert(initialHash === geometryHash(yardLife.group),
    'same records did not rebuild byte-identical physical geometry');
  const beforeRejectedRebuild = yardLife.debug();
  const invalidRecords = cloneRecords();
  invalidRecords[0].scale = -1;
  let rejectedRebuild = false;
  try {
    yardLife.rebuild(invalidRecords);
  } catch {
    rejectedRebuild = true;
  }
  assert(rejectedRebuild, 'invalid rebuild payload was accepted');
  assert(initialHash === geometryHash(yardLife.group)
    && yardLife.debug().recordCount === beforeRejectedRebuild.recordCount,
  'rejected rebuild disturbed the live geometry');

  const atomic = buildYardLife(cloneRecords(0, 0.18, ':atomic'), {
    materials,
    season: 'spring',
    weather: 'clear',
  });
  let rejectStoredLod = false;
  const storedWeightAt = () => {
    if (rejectStoredLod) throw new Error('intentional stored LOD failure');
    return 0.72;
  };
  atomic.updateLod(null, { groundActive: true, groundWeight: 1 }, storedWeightAt);
  const atomicBefore = atomic.debug();
  const atomicHash = geometryHash(atomic.group);
  const atomicMeshes = [...atomic.group.children];
  const atomicGeometryDisposals = [...ownedGeometries(atomic.group)].map((geometry) => {
    const state = { count: 0 };
    geometry.addEventListener('dispose', () => state.count++);
    return state;
  });
  rejectStoredLod = true;
  let rejectedStoredLod = false;
  try {
    atomic.rebuild(cloneRecords(0.2, 0.18, ':atomic-next'));
  } catch {
    rejectedStoredLod = true;
  }
  const atomicAfter = atomic.debug();
  assert(rejectedStoredLod
    && atomicAfter.rebuildCount === atomicBefore.rebuildCount
    && atomicAfter.records[0].id === atomicBefore.records[0].id
    && geometryHash(atomic.group) === atomicHash
    && atomic.group.children.length === atomicMeshes.length
    && atomic.group.children.every((mesh, index) => mesh === atomicMeshes[index])
    && atomicGeometryDisposals.every((state) => state.count === 0),
  'throwing stored LOD callback disturbed live rebuild ownership', atomicAfter);
  assert(disposeYardLife(atomic) && atomicGeometryDisposals.every((state) => state.count === 1),
    'atomic rebuild fixture did not dispose the preserved live geometry exactly once');

  let fallbackCalls = 0;
  const missingY = cloneRecords().slice(0, 1);
  delete missingY[0].world.y;
  const fallback = buildYardLife(missingY, {
    materials,
    season: 'spring',
    heightAt() {
      fallbackCalls++;
      return 1.25;
    },
  });
  assert(fallbackCalls === 1, 'heightAt fallback count changed', fallbackCalls);
  let fallbackMinimum = Infinity;
  fallback.group.traverse((object) => {
    const positions = object.geometry?.attributes?.position?.array;
    if (!positions) return;
    for (let index = 1; index < positions.length; index += 3) {
      fallbackMinimum = Math.min(fallbackMinimum, positions[index]);
    }
  });
  assert(fallbackMinimum >= 1.249, 'heightAt fallback did not ground geometry', fallbackMinimum);
  assert(disposeYardLife(fallback) && !disposeYardLife(fallback),
    'disposeYardLife was not idempotent');

  const borrowedDisposeCounts = new Map(Object.values(materials).map((source) => {
    const state = { count: 0 };
    source.addEventListener('dispose', () => state.count++);
    return [source, state];
  }));
  const disposable = buildYardLife(cloneRecords(), {
    materials,
    season: 'winter',
    weather: 'snow',
  });
  const disposableGeometries = ownedGeometries(disposable.group);
  const disposableMaterials = ownedMaterials(disposable.group);
  const geometryDisposeCounts = [...disposableGeometries].map((geometry) => {
    const state = { count: 0 };
    geometry.addEventListener('dispose', () => state.count++);
    return state;
  });
  const ownedMaterialDisposeCounts = [...disposableMaterials].map((ownedMaterial) => {
    const state = { count: 0 };
    ownedMaterial.addEventListener('dispose', () => state.count++);
    return state;
  });
  assert(disposeYardLife(disposable) && !disposeYardLife(disposable),
    'renderer dispose was not idempotent');
  assert(geometryDisposeCounts.every((state) => state.count === 1),
    'dispose did not release each owned geometry exactly once', geometryDisposeCounts);
  assert(ownedMaterialDisposeCounts.every((state) => state.count === 1),
    'dispose did not release each reachable owned material exactly once',
    ownedMaterialDisposeCounts);
  assert([...borrowedDisposeCounts.values()].every((state) => state.count === 0),
    'renderer disposed caller-owned materials');

  const product = createVillageYardLife(cloneRecords(), {
    season: 'autumn',
    weather: 'clear',
  });
  const productChaff = product.group.getObjectByName('yard-life-chaff');
  assert(productChaff?.material?.userData?.role === 'wood',
    'product chaff source received a non-physical semantic role',
    productChaff?.material?.userData);
  assert(product.debug().productBorrowedMaterials === 6,
    'product adapter material contract changed', product.debug());
  assert(product.dispose() && !product.dispose(), 'product adapter dispose was not idempotent');
  assert(product.debug().productMaterialsDisposed === true,
    'product adapter retained its source materials', product.debug());

  return {
    initial,
    baselinePrograms,
    baselineMemory,
    finalPrograms: renderer.info.programs.length,
    finalMemory: { ...renderer.info.memory },
    deterministicHash: initialHash,
    rebuildCount: yardLife.debug().rebuildCount,
    disposedGeometrySets: disposedGeometries.length,
  };
}

window.__yardLifeFixture = {
  renderer,
  camera,
  yardLife,
  render,
  usePresentation,
  runContracts,
};
window.__yardLifeReady = true;
</script>
</body>
</html>`;

const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    if (pathname === '/__yard-life') {
      response.writeHead(200, {
        'content-type': 'text/html',
        'cache-control': 'no-store',
      });
      response.end(HTML);
      return;
    }
    if (pathname === '/favicon.ico') {
      response.writeHead(204);
      response.end();
      return;
    }
    const file = resolve(ROOT, pathname.replace(/^\/+/, ''));
    if (file !== ROOT && !file.startsWith(ROOT + sep)) {
      response.writeHead(403);
      response.end('forbidden');
      return;
    }
    const body = await readFile(file);
    response.writeHead(200, {
      'content-type': MIME[extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end('not found');
  }
});

await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const port = server.address().port;
let browser;
try {
  browser = await launchVerificationBrowser();
  const page = await browser.newPage({ viewport: { width: 900, height: 650 } });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(message.text());
  });
  await page.goto(`http://127.0.0.1:${port}/__yard-life`, {
    waitUntil: 'networkidle',
  });
  await page.waitForFunction(() => window.__yardLifeReady === true);
  await reportWebGLRenderer(page, 'yard-life');

  const report = await page.evaluate(() => window.__yardLifeFixture.runContracts());
  if (pageErrors.length) {
    throw new Error(`yard-life browser errors: ${JSON.stringify(pageErrors)}`);
  }

  const captures = [
    ['spring', 'clear', 1, 'yard-life-spring.png'],
    ['autumn', 'clear', 1, 'yard-life-autumn.png'],
    ['winter', 'snow', 1, 'yard-life-winter.png'],
    ['winter', 'snow', 0.42, 'yard-life-wave-half.png'],
  ];
  for (const [season, weather, wave, filename] of captures) {
    const state = await page.evaluate(
      ({ seasonName, weatherName, waveWeight }) => (
        window.__yardLifeFixture.usePresentation(
          seasonName,
          weatherName,
          waveWeight,
          1,
        )
      ),
      { seasonName: season, weatherName: weather, waveWeight: wave },
    );
    const path = join(OUT, filename);
    await page.locator('canvas').screenshot({ path });
    console.log(`saved ${path} active=${state.activeRecords} weight=${state.weights.join(',')}`);
  }

  const aerial = await page.evaluate(() => (
    window.__yardLifeFixture.usePresentation('winter', 'snow', 1, 0)
  ));
  if (aerial.submittedDrawCalls !== 0) {
    throw new Error(`yard-life aerial sleep regressed: ${JSON.stringify(aerial)}`);
  }

  console.log('yard-life renderer contracts: PASS');
  console.log(JSON.stringify(report, null, 2));
  console.log(`screenshots: ${OUT}`);
} finally {
  await browser?.close();
  await new Promise((resolveClose) => server.close(resolveClose));
}
