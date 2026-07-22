import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const requireApp = createRequire(join(ROOT, 'app', 'package.json'));
const esbuild = requireApp('esbuild');
const built = await esbuild.build({
  stdin: {
    contents: `
      export * as THREE from 'three';
      export { createPackedEarthTile } from './src/surfaces/packed-earth.js';
      export { createPackedEarthTextures } from './src/surfaces/packed-earth-textures.js';
      export { buildRoads } from './src/generators/village/roads.js';
      export { disposeObjectTree } from './src/core/three-resources.js';
    `,
    resolveDir: ROOT,
    sourcefile: 'surface-material-contract-entry.js',
  },
  alias: { three: join(ROOT, 'app/node_modules/three/build/three.module.js') },
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  write: false,
  logLevel: 'silent',
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString('base64')}`;
const {
  THREE, createPackedEarthTile, createPackedEarthTextures, buildRoads, disposeObjectTree,
} = await import(moduleUrl);

const EXPECTED_HASH = '9a9d1a1429853899457e91699bffca4be33b207a010594812ada1ee430e0b489';
const luminance = (data, offset) => (
  data[offset] * 0.2126 + data[offset + 1] * 0.7152 + data[offset + 2] * 0.0722
);

const originalRandom = Math.random;
Math.random = () => { throw new Error('packed-earth source consumed global Math.random'); };
let first;
try {
  first = createPackedEarthTile();
} finally {
  Math.random = originalRandom;
}
const repeat = createPackedEarthTile();
const different = createPackedEarthTile({ seed: first.seed + 1 });
const digest = (tile) => createHash('sha256').update(tile.albedo).update(tile.heightMap).digest('hex');
assert.equal(digest(first), EXPECTED_HASH, 'default packed-earth source drifted');
assert.equal(digest(repeat), EXPECTED_HASH, 'packed-earth source is not deterministic');
assert.notEqual(digest(different), EXPECTED_HASH, 'packed-earth seed does not alter the source');
const callerOwned = createPackedEarthTile();
callerOwned.albedo[0] = 0;
assert.equal(digest(createPackedEarthTile()), EXPECTED_HASH,
  'a caller mutation leaked into a later packed-earth source');
assert.throws(() => createPackedEarthTile({ size: 96 }), /power of two/);

let sum = 0, sumSq = 0, internalDelta = 0, internalSamples = 0;
let seamX = 0, seamY = 0;
const size = first.width;
const at = (x, y) => luminance(first.albedo, (y * size + x) * 4);
for (let y = 0; y < size; y++) {
  seamX += Math.abs(at(size - 1, y) - at(0, y));
  for (let x = 0; x < size; x++) {
    const value = at(x, y);
    sum += value; sumSq += value * value;
    if (x + 1 < size) {
      internalDelta += Math.abs(value - at(x + 1, y));
      internalSamples++;
    }
  }
}
for (let x = 0; x < size; x++) seamY += Math.abs(at(x, size - 1) - at(x, 0));
const samples = size * size;
const mean = sum / samples;
const deviation = Math.sqrt(sumSq / samples - mean * mean);
const internalMeanDelta = internalDelta / internalSamples;
assert(mean >= 244 && mean <= 251, `albedo mean escaped neutral modulation: ${mean}`);
assert(deviation >= 1.4 && deviation <= 3.5, `albedo contrast escaped low range: ${deviation}`);
assert(seamX / size <= internalMeanDelta * 1.25, 'horizontal tile seam is stronger than its field');
assert(seamY / size <= internalMeanDelta * 1.25, 'vertical tile seam is stronger than its field');

const textures = createPackedEarthTextures(first);
assert.notEqual(textures.albedo.image.data, first.albedo,
  'GPU adapter exposed the reusable source bytes');
const originalFirstByte = first.albedo[0];
textures.albedo.image.data[0] = 0;
assert.equal(first.albedo[0], originalFirstByte, 'GPU texture mutation reached the source bytes');
assert.equal(textures.albedo.colorSpace, THREE.SRGBColorSpace);
assert.equal(textures.height.colorSpace, THREE.NoColorSpace);
for (const texture of Object.values(textures)) {
  assert.equal(texture.wrapS, THREE.RepeatWrapping);
  assert.equal(texture.wrapT, THREE.RepeatWrapping);
  assert.equal(texture.magFilter, THREE.LinearFilter);
  assert.equal(texture.minFilter, THREE.LinearMipmapLinearFilter);
  assert.equal(texture.generateMipmaps, true);
  assert.equal(texture.anisotropy, 4);
  texture.dispose();
}
const fallbackTextures = createPackedEarthTextures(first, { anisotropy: Number.NaN });
assert.equal(fallbackTextures.albedo.anisotropy, 4, 'invalid anisotropy did not use the safe default');
assert.equal(fallbackTextures.height.anisotropy, 4, 'invalid height anisotropy did not use the safe default');
fallbackTextures.albedo.dispose(); fallbackTextures.height.dispose();

const site = {
  R: 80,
  terrainR: 80,
  heightAt: (x, z) => Math.sin(x * 0.035) * 0.12 + Math.cos(z * 0.04) * 0.1,
  hillAt: () => 0,
};
const roads = [{
  id: 'fixture-000', level: 'soro', width: 4.2,
  pts: [{ x: -30, z: 18 }, { x: -7, z: 4 }, { x: 18, z: -8 }, { x: 34, z: -28 }],
}];
const roadGroup = buildRoads(site, roads);
const roadMesh = roadGroup.getObjectByName('village-roads-m0');
assert(roadMesh?.isMesh, 'production road did not create its single mesh');
assert.equal(roadGroup.children.length, 1, 'surface pilot changed road draw grouping');
assert.equal(roadMesh.material.name, 'packed-earth-road');
assert.equal(roadMesh.material.userData.snowSurface, false,
  'packed road lost its explicit trodden-snow policy');
assert(roadMesh.material.map?.isDataTexture && roadMesh.material.bumpMap?.isDataTexture,
  'production road did not own its albedo and height DataTextures');
const positions = roadMesh.geometry.getAttribute('position');
const uvs = roadMesh.geometry.getAttribute('uv');
assert.equal(uvs.count, positions.count, 'road UV count differs from positions');
for (let index = 0; index < positions.count; index++) {
  const x = positions.getX(index), z = positions.getZ(index);
  assert(Math.abs(uvs.getX(index) - (x * 0.8910065242 + z * 0.4539904997) / 16) <= 2e-6,
    'road U is not world-space continuous');
  assert(Math.abs(uvs.getY(index) - (-x * 0.4539904997 + z * 0.8910065242) / 16) <= 2e-6,
    'road V is not world-space continuous');
}

const owned = [roadMesh.geometry, roadMesh.material, roadMesh.material.map, roadMesh.material.bumpMap];
const disposals = new Map(owned.map((resource) => [resource, 0]));
for (const resource of owned) resource.addEventListener('dispose', () => {
  disposals.set(resource, disposals.get(resource) + 1);
});
const released = disposeObjectTree(roadGroup);
assert.equal(released.materials.size, 1, 'road material count changed');
assert.equal(released.textures.size, 2, 'road texture ownership changed');
assert([...disposals.values()].every((count) => count === 1), 'road resources were not disposed once');

const empty = buildRoads(site, []);
assert.equal(empty.children.length, 0, 'empty roads allocated render objects');
assert.equal(disposeObjectTree(empty).textures.size, 0, 'empty roads allocated textures');

console.log(`SURFACE MATERIALS: PASS (hash=${EXPECTED_HASH.slice(0, 12)}, mean=${mean.toFixed(2)}, sd=${deviation.toFixed(2)}, seam=${(seamX / size).toFixed(3)}/${(seamY / size).toFixed(3)})`);
