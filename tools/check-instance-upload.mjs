import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const requireApp = createRequire(join(ROOT, 'app', 'package.json'));
const esbuild = requireApp('esbuild');
const built = await esbuild.build({
  stdin: {
    contents: `
      export * as THREE from 'three';
      export { buildHouseInstances, mergeStatic } from './src/village/instancing.js';
      export { buildNightLights } from './src/village/nightlights.js';
      export * from './src/core/buffer-update-range.js';
    `,
    resolveDir: ROOT,
    sourcefile: 'instance-upload-contract-entry.js',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  write: false,
  nodePaths: [join(ROOT, 'app/node_modules')],
  logLevel: 'silent',
});
const url = `data:text/javascript;base64,${Buffer.from(
  built.outputFiles[0].contents,
).toString('base64')}`;
const {
  THREE,
  buildHouseInstances,
  buildNightLights,
  markAttributeFull,
  markAttributeItems,
  markAttributeRange,
  mergeStatic,
} = await import(url);

const bytes = (array) => Buffer.from(
  array.buffer,
  array.byteOffset,
  array.byteLength,
).toString('hex');
const ranges = (attribute) => attribute.updateRanges.map(({ start, count }) => ({ start, count }));
const clearRanges = (object, attribute = 'instanceMatrix') => {
  for (const child of object.children) child[attribute]?.clearUpdateRanges();
};

// The helper owns Three's component-unit contract, including clipping and an
// explicit full range that cannot be weakened by a later partial write before render.
const helper = new THREE.BufferAttribute(new Float32Array(12), 3);
assert.equal(markAttributeRange(helper, -2, 3), true);
assert.deepEqual(ranges(helper), [{ start: 0, count: 1 }]);
helper.clearUpdateRanges();
assert.equal(markAttributeItems(helper, 2), true);
assert.deepEqual(ranges(helper), [{ start: 6, count: 3 }]);
assert.equal(markAttributeRange(helper, 20, 3), false);
markAttributeFull(helper);
assert.deepEqual(ranges(helper), [{ start: 0, count: 12 }]);
markAttributeItems(helper, 2);
assert.deepEqual(ranges(helper), [
  { start: 0, count: 12 },
  { start: 6, count: 3 },
]);

const parcels = Array.from({ length: 8 }, (_, index) => ({
  id: `parcel-${index}`,
  kind: 'giwa',
  variant: 0,
  seed: 100 + index,
  center: { x: index * 3, z: 0 },
  frontDir: { x: 0, z: 1 },
  plotD: 10,
  houseLocal: { x: 0, z: 0 },
}));
const houseGeometry = new THREE.BoxGeometry(1, 1, 1);
const houseMaterials = [
  new THREE.MeshBasicMaterial({ color: 0xffffff }),
  new THREE.MeshBasicMaterial({ color: 0x777777 }),
];
const house = buildHouseInstances('giwa', parcels, [[
  { geometry: houseGeometry, material: houseMaterials[0], castShadow: false, receiveShadow: false },
  { geometry: houseGeometry, material: houseMaterials[1], castShadow: false, receiveShadow: false },
]]);
const pristineSymbol = Symbol.for('cheoma.export.pristineInstanceMatrix');
const liveBefore = house.children.map((mesh) => bytes(mesh.instanceMatrix.array));
const exportBefore = house.children.map((mesh) => bytes(mesh[pristineSymbol].array));
for (const mesh of house.children) {
  assert.equal(mesh.instanceMatrix.usage, THREE.DynamicDrawUsage);
  mesh.instanceMatrix.clearUpdateRanges();
}

assert.equal(house.userData.setHidden('parcel-3', true), true);
for (const mesh of house.children) {
  assert.deepEqual(ranges(mesh.instanceMatrix), [{ start: 3 * 16, count: 16 }]);
}
const hiddenVersions = house.children.map((mesh) => mesh.instanceMatrix.version);
clearRanges(house);
assert.equal(house.userData.setHidden('parcel-3', true), false);
assert.deepEqual(house.children.map((mesh) => mesh.instanceMatrix.version), hiddenVersions);
assert(house.children.every((mesh) => ranges(mesh.instanceMatrix).length === 0));
assert.deepEqual(house.children.map((mesh) => bytes(mesh[pristineSymbol].array)), exportBefore,
  'presentation hiding mutated the export snapshot');

assert.equal(house.userData.setHidden('parcel-3', false), true);
assert.deepEqual(house.children.map((mesh) => bytes(mesh.instanceMatrix.array)), liveBefore,
  'house matrix bytes did not restore exactly');
clearRanges(house);
assert.equal(house.userData.setHidden('parcel-2', true), true);
assert.equal(house.userData.setHidden('parcel-3', true), true);
for (const mesh of house.children) {
  assert.deepEqual(ranges(mesh.instanceMatrix), [
    { start: 2 * 16, count: 16 },
    { start: 3 * 16, count: 16 },
  ]);
}
house.userData.setHidden('parcel-2', false);
house.userData.setHidden('parcel-3', false);

// Merged walls and FAR masses share one source-range hide contract. Only one
// source object's non-indexed position lane may be uploaded and export reads
// an independent pristine snapshot without touching GPU dirtiness.
const mergedMaterial = new THREE.MeshBasicMaterial({ color: 0x888888 });
const mergedObjects = Array.from({ length: 8 }, (_, index) => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mergedMaterial);
  mesh.position.x = index * 2;
  return mesh;
});
const merged = mergeStatic(mergedObjects, 'partial-upload-fixture', {
  ids: parcels.map((parcel) => parcel.id),
});
assert.equal(merged.children.length, 1);
const mergedPosition = merged.children[0].geometry.attributes.position;
const sourceComponents = mergedObjects[0].geometry.toNonIndexed().attributes.position.array.length;
const mergedBefore = bytes(mergedPosition.array);
assert.equal(mergedPosition.usage, THREE.DynamicDrawUsage);
assert.equal(merged.userData.setHidden('parcel-3', true), undefined);
assert.deepEqual(ranges(mergedPosition), [{
  start: 3 * sourceComponents,
  count: sourceComponents,
}]);
const exportPosition = merged.children[0][Symbol.for('cheoma.export.pristinePositionSnapshot')];
const versionBeforeExport = mergedPosition.version;
assert.equal(bytes(exportPosition()), mergedBefore,
  'live merged hiding leaked into the export snapshot');
assert.equal(mergedPosition.version, versionBeforeExport,
  'CPU-only export snapshot dirtied the GPU attribute');
mergedPosition.clearUpdateRanges();
const mergedHiddenVersion = mergedPosition.version;
merged.userData.setHidden('parcel-3', true);
assert.equal(mergedPosition.version, mergedHiddenVersion);
assert.deepEqual(ranges(mergedPosition), []);
merged.userData.setHidden('parcel-3', false);
assert.equal(bytes(mergedPosition.array), mergedBefore,
  'merged source position bytes did not restore exactly');

const anchor = (id, x, outward = { x: 0, y: 0, z: 1 }) => ({
  openingId: id,
  kind: 'window',
  style: 'giwa',
  width: 1.2,
  height: 0.8,
  position: { x, y: 1.5, z: 0 },
  outward,
});
const owners = new Map();
for (const parcel of parcels) owners.set(parcel.id, [
  anchor(`${parcel.id}-front`, parcel.center.x),
  anchor(`${parcel.id}-side`, parcel.center.x + 0.5, { x: 1, y: 0, z: 0 }),
]);
const lights = buildNightLights({
  parcels: parcels.map((parcel) => ({ ...parcel, hero: true })),
  features: {},
}, null, { owners });
const lightMesh = lights.group.getObjectByName('nightlight-physical');
const dynamicNames = [
  'aAnchor', 'aOutward', 'aOpeningSize', 'aPhase', 'aLit', 'aThreshold', 'aWarm',
];
for (const name of dynamicNames) {
  const attribute = lightMesh.geometry.attributes[name];
  assert.equal(attribute.usage, THREE.DynamicDrawUsage);
  attribute.clearUpdateRanges();
}
const overlay = new THREE.Group();
overlay.userData.openingGlowAnchors = [anchor('replacement', 30)];
assert.equal(lights.refreshOwner('parcel-2', overlay), true);
const owner = lights.debugOwner('parcel-2');
assert.equal(owner.start, 6);
assert.equal(owner.capacity, 3);
for (const name of dynamicNames) {
  const attribute = lightMesh.geometry.attributes[name];
  assert.deepEqual(ranges(attribute), [{
    start: owner.start * attribute.itemSize,
    count: owner.capacity * attribute.itemSize,
  }], `${name} did not use its owner item range`);
}
for (const name of dynamicNames) lightMesh.geometry.attributes[name].clearUpdateRanges();
const lightVersions = dynamicNames.map((name) => lightMesh.geometry.attributes[name].version);
assert.equal(lights.refreshOwner('parcel-2', overlay), false,
  'identical nightlight source was not a no-op');
assert.deepEqual(
  dynamicNames.map((name) => lightMesh.geometry.attributes[name].version),
  lightVersions,
  'identical nightlight source dirtied attributes',
);
assert(dynamicNames.every((name) => ranges(lightMesh.geometry.attributes[name]).length === 0));

const houseFullBytes = house.children.reduce(
  (sum, mesh) => sum + mesh.instanceMatrix.array.byteLength, 0,
);
const housePartialBytes = house.children.length * 16 * Float32Array.BYTES_PER_ELEMENT;
const lightFullBytes = dynamicNames.reduce(
  (sum, name) => sum + lightMesh.geometry.attributes[name].array.byteLength, 0,
);
const lightPartialBytes = dynamicNames.reduce(
  (sum, name) => sum + owner.capacity
    * lightMesh.geometry.attributes[name].itemSize
    * Float32Array.BYTES_PER_ELEMENT, 0,
);
assert.equal(housePartialBytes / houseFullBytes, 1 / parcels.length);
assert.equal(lightPartialBytes / lightFullBytes, 1 / parcels.length);

lights.dispose();
for (const mesh of mergedObjects) mesh.geometry.dispose();
merged.children[0].geometry.dispose();
mergedMaterial.dispose();
houseGeometry.dispose();
for (const material of houseMaterials) material.dispose();

console.log(
  'INSTANCE UPLOAD: PASS '
  + `(house ${housePartialBytes}/${houseFullBytes}B, `
  + `nightlight ${lightPartialBytes}/${lightFullBytes}B, exact restore/export invariant)`,
);
