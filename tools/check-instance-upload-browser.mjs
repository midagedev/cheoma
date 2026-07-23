// Actual WebGL bufferSubData proof for issue #102. Run through the repository
// browser lock: node tools/run-browser-locked.mjs -- node tools/check-instance-upload-browser.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import {
  launchVerificationBrowser,
  reportWebGLRenderer,
} from './lib/verification-browser.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const esbuild = require(resolve(ROOT, 'app/node_modules/esbuild'));

const ENTRY = `
import * as THREE from 'three';
import {
  buildHouseInstances,
  mergeStatic,
} from ${JSON.stringify(resolve(ROOT, 'src/village/instancing.js'))};
import { buildNightLights } from ${JSON.stringify(resolve(ROOT, 'src/village/nightlights.js'))};
import { createRerollWave } from ${JSON.stringify(resolve(ROOT, 'src/village/wave.js'))};
import {
  markAttributeFull,
  markAttributeItems,
} from ${JSON.stringify(resolve(ROOT, 'src/core/buffer-update-range.js'))};

const canvas = document.createElement('canvas');
canvas.width = 320;
canvas.height = 180;
document.body.appendChild(canvas);
const gl = canvas.getContext('webgl2', { antialias: false });
if (!gl) throw new Error('WebGL2 is required for partial typed-array bufferSubData');

const tracked = new Map();
let uploads = [];
let allocations = [];
const nativeBufferSubData = gl.bufferSubData.bind(gl);
const nativeBufferData = gl.bufferData.bind(gl);
gl.bufferSubData = (...args) => {
  const source = args[2];
  const label = tracked.get(source);
  if (label) {
    const rangeOverload = args.length >= 5;
    const sourceOffset = rangeOverload ? args[3] : 0;
    const componentCount = rangeOverload ? args[4] : source.length;
    uploads.push({
      label,
      rangeOverload,
      destinationByteOffset: args[1],
      sourceOffset,
      componentCount,
      bytes: componentCount * source.BYTES_PER_ELEMENT,
    });
  }
  return nativeBufferSubData(...args);
};
gl.bufferData = (...args) => {
  const label = tracked.get(args[1]);
  if (label) allocations.push(label);
  return nativeBufferData(...args);
};

const renderer = new THREE.WebGLRenderer({ canvas, context: gl, antialias: false });
renderer.setPixelRatio(1);
renderer.setSize(320, 180, false);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, 320 / 180, 0.1, 100);
camera.position.set(0, 6, 18);
camera.lookAt(0, 0, 0);

const parcels = Array.from({ length: 8 }, (_, index) => ({
  id: 'parcel-' + index,
  kind: 'giwa',
  variant: 0,
  seed: 100 + index,
  center: { x: (index - 3.5) * 1.5, z: 0 },
  frontDir: { x: 0, z: 1 },
  plotD: 10,
  houseLocal: { x: 0, z: 0 },
}));
const houseGeometry = new THREE.BoxGeometry(0.8, 0.8, 0.8);
const houseMaterials = [
  new THREE.MeshBasicMaterial({ color: 0xffffff }),
  new THREE.MeshBasicMaterial({ color: 0x777777, wireframe: true }),
];
const houses = buildHouseInstances('giwa', parcels, [[
  { geometry: houseGeometry, material: houseMaterials[0], castShadow: false, receiveShadow: false },
  { geometry: houseGeometry, material: houseMaterials[1], castShadow: false, receiveShadow: false },
]]);
scene.add(houses);
houses.children.forEach((mesh, index) => {
  tracked.set(mesh.instanceMatrix.array, 'house-' + index);
});

const mergedMaterial = new THREE.MeshBasicMaterial({ color: 0x445566 });
const mergedObjects = Array.from({ length: 8 }, (_, index) => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.45, 0.45), mergedMaterial);
  mesh.position.set((index - 3.5) * 1.5, -1.3, 0);
  return mesh;
});
const merged = mergeStatic(mergedObjects, 'partial-upload-browser-fixture', {
  ids: parcels.map((parcel) => parcel.id),
});
scene.add(merged);
const mergedPosition = merged.children[0].geometry.attributes.position;
tracked.set(mergedPosition.array, 'merged-position');

const anchor = (id, x, z = -2) => ({
  openingId: id,
  kind: 'window',
  style: 'giwa',
  width: 0.8,
  height: 0.5,
  position: { x, y: 1.2, z },
  outward: { x: 0, y: 0, z: 1 },
});
const owners = new Map();
for (const parcel of parcels) owners.set(parcel.id, [
  anchor(parcel.id + '-a', parcel.center.x),
  anchor(parcel.id + '-b', parcel.center.x + 0.25),
]);
const lights = buildNightLights({
  parcels: parcels.map((parcel) => ({ ...parcel, hero: true })),
  features: {},
}, null, { owners });
lights.setLevel(1);
scene.add(lights.group);
const lightMesh = lights.group.getObjectByName('nightlight-physical');
const lightAttributes = [
  'aAnchor', 'aOutward', 'aOpeningSize', 'aPhase', 'aLit', 'aThreshold', 'aWarm',
];
for (const name of lightAttributes) {
  tracked.set(lightMesh.geometry.attributes[name].array, 'light-' + name);
}

const waveGeometry = new THREE.BoxGeometry(0.6, 0.6, 0.6);
const waveMaterial = new THREE.MeshBasicMaterial({ color: 0x886644 });
const makeWaveRoot = (label) => {
  const root = new THREE.Group();
  root.name = label;
  const chunk = new THREE.Group();
  chunk.name = 'village-chunk-' + label;
  const instance = new THREE.InstancedMesh(waveGeometry, waveMaterial, 4);
  const matrix = new THREE.Matrix4();
  for (let index = 0; index < instance.count; index++) {
    instance.setMatrixAt(index, matrix.makeTranslation(index * 1.4 - 2.1, 2.2, 0));
  }
  instance.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  chunk.add(instance);
  root.add(chunk);
  return { root, instance };
};
const waveOld = makeWaveRoot('old');
const waveIncoming = makeWaveRoot('incoming');
const wave = createRerollWave({
  oldRoot: waveOld.root,
  newRoot: waveIncoming.root,
  center: { x: 0, z: 0 },
  seed: 20260716,
  duration: 1,
});
scene.add(waveOld.root, waveIncoming.root);
tracked.set(waveOld.instance.instanceMatrix.array, 'wave-old-matrix');

renderer.render(scene, camera);
waveOld.instance.instanceMatrix.clearUpdateRanges();
uploads = [];
allocations = [];
function measure(mutation) {
  uploads = [];
  allocations = [];
  mutation();
  renderer.render(scene, camera);
  return {
    uploads: uploads.map((call) => ({ ...call })),
    allocations: [...allocations],
  };
}

const housePartial = measure(() => houses.userData.setHidden('parcel-3', true));
const houseFull = measure(() => {
  for (const mesh of houses.children) {
    markAttributeFull(mesh.instanceMatrix);
    markAttributeItems(mesh.instanceMatrix, 6);
  }
});
const houseAdjacent = measure(() => {
  houses.userData.setHidden('parcel-3', false);
  houses.userData.setHidden('parcel-4', true);
});
measure(() => houses.userData.setHidden('parcel-4', false));

const mergedPartial = measure(() => merged.userData.setHidden('parcel-3', true));
const mergedFull = measure(() => {
  markAttributeFull(mergedPosition);
});
measure(() => merged.userData.setHidden('parcel-3', false));

const overlay = new THREE.Group();
overlay.userData.openingGlowAnchors = [anchor('replacement', 0, -1.5)];
const nightlightPartial = measure(() => lights.refreshOwner('parcel-2', overlay));
const nightlightDuplicate = measure(() => lights.refreshOwner('parcel-2', overlay));
const nightlightFull = measure(() => {
  for (const name of lightAttributes) {
    const attribute = lightMesh.geometry.attributes[name];
    markAttributeFull(attribute);
    markAttributeItems(attribute, 1);
  }
});
const waveFull = measure(() => wave.seek(0.25));

const remainingRanges = [
  ...houses.children.map((mesh) => mesh.instanceMatrix.updateRanges.length),
  mergedPosition.updateRanges.length,
  ...lightAttributes.map((name) => lightMesh.geometry.attributes[name].updateRanges.length),
  waveOld.instance.instanceMatrix.updateRanges.length,
];
const result = {
  housePartial,
  houseFull,
  houseAdjacent,
  mergedPartial,
  mergedFull,
  nightlightPartial,
  nightlightDuplicate,
  nightlightFull,
  waveFull,
  remainingRanges,
  houseArrayBytes: houses.children[0].instanceMatrix.array.byteLength,
  mergedArrayBytes: mergedPosition.array.byteLength,
  mergedSourceComponents: mergedPosition.array.length / 8,
  lightArrayBytes: Object.fromEntries(lightAttributes.map((name) => [
    name,
    lightMesh.geometry.attributes[name].array.byteLength,
  ])),
  owner: lights.debugOwner('parcel-2'),
  waveArrayBytes: waveOld.instance.instanceMatrix.array.byteLength,
};

wave.cancel();
lights.dispose();
for (const mesh of mergedObjects) mesh.geometry.dispose();
merged.children[0].geometry.dispose();
mergedMaterial.dispose();
houseGeometry.dispose();
for (const material of houseMaterials) material.dispose();
waveGeometry.dispose();
waveMaterial.dispose();
renderer.dispose();
window.__result = result;
window.__ready = true;
`;

const built = await esbuild.build({
  stdin: {
    contents: ENTRY,
    resolveDir: ROOT,
    sourcefile: 'instance-upload-browser-check.js',
    loader: 'js',
  },
  bundle: true,
  format: 'iife',
  write: false,
  nodePaths: [resolve(ROOT, 'app/node_modules')],
  logLevel: 'silent',
});
const html = `<!doctype html><meta charset="utf-8"><body><script>${built.outputFiles[0].text}</script>`;
const server = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
  response.end(html);
});
await new Promise((done, reject) => server.listen(0, '127.0.0.1', done).on('error', reject));

let browser;
try {
  browser = await launchVerificationBrowser();
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ready === true);
  await reportWebGLRenderer(page, 'instance-upload');
  const result = await page.evaluate(() => window.__result);
  assert.deepEqual(pageErrors, []);

  const assertNoAllocation = (sample) => assert.deepEqual(sample.allocations, []);
  for (const sample of [
    result.housePartial,
    result.houseFull,
    result.houseAdjacent,
    result.mergedPartial,
    result.mergedFull,
    result.nightlightPartial,
    result.nightlightDuplicate,
    result.nightlightFull,
    result.waveFull,
  ]) assertNoAllocation(sample);

  assert.equal(result.housePartial.uploads.length, 2);
  for (const call of result.housePartial.uploads) {
    assert.equal(call.rangeOverload, true);
    assert.equal(call.destinationByteOffset, 3 * 16 * Float32Array.BYTES_PER_ELEMENT);
    assert.equal(call.sourceOffset, 3 * 16);
    assert.equal(call.componentCount, 16);
    assert.equal(call.bytes, 64);
  }
  assert.equal(result.houseFull.uploads.length, 2);
  for (const call of result.houseFull.uploads) {
    assert.equal(call.rangeOverload, true);
    assert.equal(call.destinationByteOffset, 0);
    assert.equal(call.sourceOffset, 0);
    assert.equal(call.bytes, result.houseArrayBytes);
  }
  assert.equal(result.houseAdjacent.uploads.length, 2);
  for (const call of result.houseAdjacent.uploads) {
    assert.equal(call.rangeOverload, true);
    assert.equal(call.sourceOffset, 3 * 16);
    assert.equal(call.componentCount, 2 * 16);
  }

  assert.equal(result.mergedPartial.uploads.length, 1);
  assert.equal(result.mergedPartial.uploads[0].rangeOverload, true);
  assert.equal(result.mergedPartial.uploads[0].bytes, result.mergedArrayBytes / 8);
  assert.equal(
    result.mergedPartial.uploads[0].sourceOffset,
    3 * result.mergedSourceComponents,
  );
  assert.equal(
    result.mergedPartial.uploads[0].destinationByteOffset,
    3 * result.mergedSourceComponents * Float32Array.BYTES_PER_ELEMENT,
  );
  assert.equal(result.mergedFull.uploads.length, 1);
  assert.equal(result.mergedFull.uploads[0].rangeOverload, true);
  assert.equal(result.mergedFull.uploads[0].sourceOffset, 0);
  assert.equal(result.mergedFull.uploads[0].destinationByteOffset, 0);
  assert.equal(result.mergedFull.uploads[0].bytes, result.mergedArrayBytes);

  assert.equal(result.nightlightPartial.uploads.length, 7);
  const expectedLightComponents = {
    'light-aAnchor': 9,
    'light-aOutward': 9,
    'light-aOpeningSize': 6,
    'light-aPhase': 3,
    'light-aLit': 3,
    'light-aThreshold': 3,
    'light-aWarm': 3,
  };
  for (const call of result.nightlightPartial.uploads) {
    assert.equal(call.rangeOverload, true);
    assert.equal(call.componentCount, expectedLightComponents[call.label]);
    assert.equal(call.bytes, expectedLightComponents[call.label] * Float32Array.BYTES_PER_ELEMENT);
    const name = call.label.slice('light-'.length);
    const itemSize = expectedLightComponents[call.label] / result.owner.capacity;
    assert.equal(call.sourceOffset, result.owner.start * itemSize, `${name} source offset`);
    assert.equal(
      call.destinationByteOffset,
      result.owner.start * itemSize * Float32Array.BYTES_PER_ELEMENT,
      `${name} destination offset`,
    );
  }
  assert.deepEqual(result.nightlightDuplicate.uploads, []);
  assert.equal(result.nightlightFull.uploads.length, 7);
  for (const call of result.nightlightFull.uploads) {
    assert.equal(call.rangeOverload, true);
    assert.equal(call.sourceOffset, 0);
    assert.equal(call.destinationByteOffset, 0);
    const name = call.label.slice('light-'.length);
    assert.equal(call.bytes, result.lightArrayBytes[name]);
  }
  assert.equal(result.waveFull.uploads.length, 1);
  assert.deepEqual(result.waveFull.uploads[0], {
    label: 'wave-old-matrix',
    rangeOverload: true,
    destinationByteOffset: 0,
    sourceOffset: 0,
    componentCount: result.waveArrayBytes / Float32Array.BYTES_PER_ELEMENT,
    bytes: result.waveArrayBytes,
  });
  assert(result.remainingRanges.every((count) => count === 0),
    `renderer did not consume updateRanges: ${result.remainingRanges.join(',')}`);

  const partialBytes = result.housePartial.uploads.reduce((sum, call) => sum + call.bytes, 0)
    + result.mergedPartial.uploads.reduce((sum, call) => sum + call.bytes, 0)
    + result.nightlightPartial.uploads.reduce((sum, call) => sum + call.bytes, 0);
  const fullBytes = result.houseFull.uploads.reduce((sum, call) => sum + call.bytes, 0)
    + result.mergedFull.uploads.reduce((sum, call) => sum + call.bytes, 0)
    + result.nightlightFull.uploads.reduce((sum, call) => sum + call.bytes, 0);
  assert.equal(partialBytes / fullBytes, 1 / 8);
  console.log(
    `INSTANCE UPLOAD BROWSER: PASS (${partialBytes}/${fullBytes}B, `
    + `${((1 - partialBytes / fullBytes) * 100).toFixed(1)}% less, bufferData=0)`,
  );
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
}
