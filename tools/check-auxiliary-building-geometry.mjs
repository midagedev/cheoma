import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const requireApp = createRequire(join(ROOT, 'app', 'package.json'));
const esbuild = requireApp('esbuild');
const built = await esbuild.build({
  stdin: {
    contents: `
      export * as THREE from 'three';
      export {
        AUXILIARY_BUILDING_MATERIAL_ROLES,
        buildAuxiliaryBuilding,
        disposeAuxiliaryBuilding,
      } from './src/village/auxiliary-building-geometry.js';
    `,
    resolveDir: ROOT,
    sourcefile: 'auxiliary-building-geometry-contract-entry.js',
  },
  alias: {
    'three/addons/utils/BufferGeometryUtils.js': join(
      ROOT,
      'app/node_modules/three/examples/jsm/utils/BufferGeometryUtils.js',
    ),
    three: join(ROOT, 'app/node_modules/three/build/three.module.js'),
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  write: false,
  logLevel: 'silent',
});
const url = `data:text/javascript;base64,${Buffer.from(
  built.outputFiles[0].contents,
).toString('base64')}`;
const {
  THREE,
  AUXILIARY_BUILDING_MATERIAL_ROLES,
  buildAuxiliaryBuilding,
  disposeAuxiliaryBuilding,
} = await import(url);

const EPSILON = 1e-5;

function rotatedFootprint(local, width, depth, overhang) {
  const halfX = width * 0.5 + overhang;
  const halfZ = depth * 0.5 + overhang;
  const cosine = Math.cos(local.yaw);
  const sine = Math.sin(local.yaw);
  return [
    { x: -halfX, z: -halfZ },
    { x: halfX, z: -halfZ },
    { x: halfX, z: halfZ },
    { x: -halfX, z: halfZ },
  ].map((point) => ({
    x: local.x + point.x * cosine + point.z * sine,
    z: local.z - point.x * sine + point.z * cosine,
  }));
}

function fixture(covering = 'tile') {
  const local = { x: 4.25, z: -3.5, yaw: 0.083 };
  const body = { width: 3.2, depth: 2.42, height: 1.84 };
  const roof = {
    form: 'gable',
    covering,
    overhang: 0.28,
    rise: 0.6,
  };
  return Object.freeze({
    id: `aux-${covering}`,
    role: 'storehouse',
    local: Object.freeze(local),
    body: Object.freeze(body),
    roof: Object.freeze(roof),
    footprint: Object.freeze(
      rotatedFootprint(local, body.width, body.depth, roof.overhang)
        .map((point) => Object.freeze(point)),
    ),
    roofTopY: body.height + roof.rise,
  });
}

function makePalette() {
  return {
    plaster: new THREE.MeshStandardMaterial(),
    tileConvex: new THREE.MeshStandardMaterial(),
    tileRidge: new THREE.MeshStandardMaterial(),
    mud: new THREE.MeshStandardMaterial(),
    thatch: new THREE.MeshStandardMaterial(),
    jipjul: new THREE.MeshStandardMaterial(),
  };
}

function triangles(geometry) {
  return geometry.index
    ? geometry.index.count / 3
    : geometry.getAttribute('position').count / 3;
}

function attributeBytes(attribute) {
  if (!attribute) return null;
  return Buffer.from(
    attribute.array.buffer,
    attribute.array.byteOffset,
    attribute.array.byteLength,
  ).toString('hex');
}

function meshes(root) {
  const result = [];
  root.traverse((object) => {
    if (object.isMesh) result.push(object);
  });
  return result;
}

function worldVertices(root) {
  root.updateWorldMatrix(true, true);
  const vertices = [];
  for (const mesh of meshes(root)) {
    const positions = mesh.geometry.getAttribute('position');
    for (let index = 0; index < positions.count; index++) {
      vertices.push(new THREE.Vector3(
        positions.getX(index),
        positions.getY(index),
        positions.getZ(index),
      ).applyMatrix4(mesh.matrixWorld));
    }
  }
  return vertices;
}

function assertPhysicalEnvelope(root, spec) {
  const inverseYaw = -spec.local.yaw;
  const cosine = Math.cos(inverseYaw);
  const sine = Math.sin(inverseYaw);
  const halfX = spec.body.width * 0.5 + spec.roof.overhang;
  const halfZ = spec.body.depth * 0.5 + spec.roof.overhang;
  const vertices = worldVertices(root);
  const ys = [];
  for (const point of vertices) {
    const dx = point.x - spec.local.x;
    const dz = point.z - spec.local.z;
    const localX = dx * cosine + dz * sine;
    const localZ = -dx * sine + dz * cosine;
    assert(
      localX >= -halfX - EPSILON && localX <= halfX + EPSILON,
      `auxiliary geometry crossed its planned footprint on X (${localX})`,
    );
    assert(
      localZ >= -halfZ - EPSILON && localZ <= halfZ + EPSILON,
      `auxiliary geometry crossed its planned footprint on Z (${localZ})`,
    );
    assert(
      point.y >= -EPSILON && point.y <= spec.roofTopY + EPSILON,
      `auxiliary geometry crossed its planned vertical envelope (${point.y})`,
    );
    ys.push(point.y);
  }
  assert(Math.abs(Math.min(...ys)) <= EPSILON, 'body no longer rests at local y=0');
  assert(
    Math.abs(Math.max(...ys) - spec.roofTopY) <= EPSILON,
    'rendered ridge no longer matches spec.roofTopY',
  );
}

const palette = makePalette();
const tileSpec = fixture('tile');
const tileSpecSnapshot = JSON.stringify(tileSpec);
const originalRandom = Math.random;
let randomCalls = 0;
Math.random = () => {
  randomCalls++;
  return 0.123456789;
};
let tile;
try {
  tile = buildAuxiliaryBuilding(tileSpec, palette);
} finally {
  Math.random = originalRandom;
}
const allocationRandomCalls = randomCalls;
randomCalls = 0;
Math.random = () => {
  randomCalls++;
  return 0.87654321;
};
let tileRepeat;
try {
  tileRepeat = buildAuxiliaryBuilding(tileSpec, palette);
} finally {
  Math.random = originalRandom;
}
assert.equal(
  randomCalls,
  allocationRandomCalls,
  'same auxiliary spec changed Three allocation UUID overhead',
);
assert(
  !readFileSync(
    join(ROOT, 'src/village/auxiliary-building-geometry.js'),
    'utf8',
  ).includes('Math.random'),
  'auxiliary geometry added policy randomness on top of Three UUID allocation',
);
assert.equal(JSON.stringify(tileSpec), tileSpecSnapshot, 'builder mutated the renderer-free spec');
assert.equal(tile.name, 'auxiliary-building');
assert.equal(tile.position.x, tileSpec.local.x);
assert.equal(tile.position.y, 0);
assert.equal(tile.position.z, tileSpec.local.z);
assert.equal(tile.rotation.y, tileSpec.local.yaw);
assert.equal(tile.userData.auxiliarySpec, tileSpec, 'root copied or replaced the plan record');
assert.deepEqual(tile.userData.auxiliaryBuilding, {
  id: tileSpec.id,
  role: tileSpec.role,
  covering: 'tile',
  geometryOwnership: 'builder',
  materialOwnership: 'caller',
});

const tileMeshes = meshes(tile);
const repeatedTileMeshes = meshes(tileRepeat);
assert.deepEqual(
  tileMeshes.map((mesh) => ({
    position: attributeBytes(mesh.geometry.getAttribute('position')),
    normal: attributeBytes(mesh.geometry.getAttribute('normal')),
    uv: attributeBytes(mesh.geometry.getAttribute('uv')),
    index: attributeBytes(mesh.geometry.index),
  })),
  repeatedTileMeshes.map((mesh) => ({
    position: attributeBytes(mesh.geometry.getAttribute('position')),
    normal: attributeBytes(mesh.geometry.getAttribute('normal')),
    uv: attributeBytes(mesh.geometry.getAttribute('uv')),
    index: attributeBytes(mesh.geometry.index),
  })),
  'same auxiliary spec did not produce byte-identical geometry',
);
assert.deepEqual(
  tileMeshes.map((mesh) => mesh.name),
  [
    'auxiliary-building-body',
    'auxiliary-building-gable-roof',
    'auxiliary-building-roof-ridge',
  ],
  'auxiliary semantic mesh names changed',
);
assert.deepEqual(
  tileMeshes.map((mesh) => mesh.userData.auxiliaryMaterialRole),
  ['plaster', 'tileConvex', 'tileRidge'],
  'tile covering stopped using the existing wall palette roles',
);
assert.deepEqual(
  tileMeshes.map((mesh) => mesh.material),
  [palette.plaster, palette.tileConvex, palette.tileRidge],
  'tile covering cloned or replaced caller materials',
);
assert(tileMeshes.every((mesh) => mesh.castShadow && mesh.receiveShadow),
  'auxiliary physical surfaces lost their shadow contract');
assert.equal(tileMeshes.reduce((sum, mesh) => sum + triangles(mesh.geometry), 0), 48);
assert.deepEqual(tileMeshes.map((mesh) => triangles(mesh.geometry)), [12, 24, 12]);
assert.equal(new Set(tileMeshes.map((mesh) => mesh.geometry)).size, 3,
  'temporary roof panels survived the owned merge');
assertPhysicalEnvelope(tile, tileSpec);

const thatchSpec = fixture('thatch');
const thatch = buildAuxiliaryBuilding(thatchSpec, palette);
const thatchMeshes = meshes(thatch);
assert.deepEqual(
  thatchMeshes.map((mesh) => mesh.userData.auxiliaryMaterialRole),
  ['mud', 'thatch', 'jipjul'],
  'thatch covering stopped using the existing wall palette roles',
);
assert.deepEqual(
  thatchMeshes.map((mesh) => mesh.material),
  [palette.mud, palette.thatch, palette.jipjul],
  'thatch covering cloned or replaced caller materials',
);
assertPhysicalEnvelope(thatch, thatchSpec);

assert.deepEqual(AUXILIARY_BUILDING_MATERIAL_ROLES, {
  tile: { body: 'plaster', roof: 'tileConvex', ridge: 'tileRidge' },
  thatch: { body: 'mud', roof: 'thatch', ridge: 'jipjul' },
});

const geometryDisposals = new Map();
for (const mesh of tileMeshes) {
  geometryDisposals.set(mesh.geometry, 0);
  mesh.geometry.addEventListener('dispose', () => {
    geometryDisposals.set(mesh.geometry, geometryDisposals.get(mesh.geometry) + 1);
  });
}
const materialDisposals = new Map(Object.values(palette).map((material) => [material, 0]));
for (const material of Object.values(palette)) {
  material.addEventListener('dispose', () => {
    materialDisposals.set(material, materialDisposals.get(material) + 1);
  });
}
assert.equal(disposeAuxiliaryBuilding(tile), true);
assert.equal(disposeAuxiliaryBuilding(tile), false);
assert.deepEqual([...geometryDisposals.values()], [1, 1, 1],
  'builder-owned geometry was leaked or disposed more than once');
assert([...materialDisposals.values()].every((count) => count === 0),
  'disposeAuxiliaryBuilding released caller-owned materials');
assert.equal(tile.children.length, 0);
assert.equal(tile.visible, false);
assert.equal(tile.userData.auxiliarySpec, null);
assert.equal(disposeAuxiliaryBuilding(tileRepeat), true);

const badTop = {
  ...tileSpec,
  roofTopY: tileSpec.roofTopY + 0.01,
};
assert.throws(
  () => buildAuxiliaryBuilding(badTop, palette),
  /roofTopY/,
  'renderer accepted a plan/render height split',
);
assert.throws(
  () => buildAuxiliaryBuilding(
    { ...tileSpec, roof: { ...tileSpec.roof, covering: 'metal' } },
    palette,
  ),
  /covering/,
  'renderer accepted an unplanned material family',
);
assert.throws(
  () => buildAuxiliaryBuilding(tileSpec, { ...palette, tileRidge: null }),
  /tileRidge/,
  'renderer allocated geometry without the complete borrowed palette',
);

assert.equal(disposeAuxiliaryBuilding(thatch), true);
for (const material of Object.values(palette)) material.dispose();

console.log(
  'AUXILIARY BUILDING GEOMETRY: PASS '
  + '(RNG-free 48 triangles, exact local envelope, borrowed materials, idempotent dispose)',
);
