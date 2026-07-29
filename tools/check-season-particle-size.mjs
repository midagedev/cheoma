// Pure contract: seasonal petal/leaf world sizes stay in the authored centimetre
// bands (docs/project-status — snow 1.3–3.2cm, spring petals 2–5.4cm, autumn
// leaves ≤ ~29cm after the 2026-07-25 2.4× silhouette raise). Measurement is
// geometry long-axis × aSize × uWorldScale × speciesScale (or instance scale for
// seasonLeaves) — never the unit saddle bbox alone (that misreads as ~0.62×1.0m).
// Browser-free. Run: node tools/check-season-particle-size.mjs
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const requireApp = createRequire(join(ROOT, 'app', 'package.json'));
const esbuild = requireApp('esbuild');
const THREE_MAIN = join(ROOT, 'app/node_modules/three/build/three.module.js');
const THREE_ADDONS = join(ROOT, 'app/node_modules/three/examples/jsm');

function makeCanvas() {
  const noop = () => {};
  const gradient = Object.freeze({ addColorStop: noop });
  let canvas;
  const context = new Proxy({}, {
    get(t, k) {
      if (k === 'canvas') return canvas;
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => gradient;
      if (k === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
      if (!(k in t)) t[k] = noop;
      return t[k];
    },
    set(t, k, v) { t[k] = v; return true; },
  });
  canvas = { width: 0, height: 0, getContext: () => context };
  return canvas;
}
globalThis.document = { createElement: () => makeCanvas() };

process.on('uncaughtException', (error) => {
  console.error(`SEASON PARTICLE SIZE: FAIL — ${error.message}`);
  process.exit(1);
});

// Document bands (metres). Autumn max is the reviewed 2.4× raise ceiling (~29cm).
const SPRING_PETAL_MAX_M = 0.054;
const SPRING_PETAL_MIN_M = 0.013;
const AUTUMN_LEAF_MAX_M = 0.29;
const AUTUMN_LEAF_MIN_M = 0.06;
// Unit saddle misread ceiling — product sizes must stay well below this.
const DOOR_CARD_M = 0.55;

const built = await esbuild.build({
  stdin: {
    contents: `
      export { createPetalField } from './src/env/petals.js';
      export { createLeafSaddleGeometry } from './src/env/detail-particle-geometry.js';
      export { setupSeasons } from './src/env/seasons.js';
      export * as THREE from 'three';
    `,
    resolveDir: ROOT,
    sourcefile: 'season-particle-size-entry.js',
  },
  alias: { 'three/addons': THREE_ADDONS, three: THREE_MAIN },
  bundle: true, format: 'esm', platform: 'node', target: 'node20', write: false, logLevel: 'silent',
});
const { createPetalField, createLeafSaddleGeometry, setupSeasons, THREE } = await import(
  `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString('base64')}`
);

const geo = createLeafSaddleGeometry();
geo.computeBoundingBox();
const spanY = geo.boundingBox.max.y - geo.boundingBox.min.y;
const spanX = geo.boundingBox.max.x - geo.boundingBox.min.x;
// Unit saddle is ~0.62×1.0 — the audit misread this as world metres.
assert.ok(spanY > 0.9 && spanY < 1.1, `leaf saddle long axis drifted: ${spanY}`);
assert.ok(spanX > 0.5 && spanX < 0.7, `leaf saddle width drifted: ${spanX}`);

function petalWorldMajors(field) {
  const aSize = field.object.geometry.attributes.aSize.array;
  const aSpecies = field.object.geometry.attributes.aSpecies.array;
  const worldScale = field.object.material.uniforms.uWorldScale.value;
  const majors = [];
  for (let i = 0; i < aSize.length; i++) {
    const speciesScale = aSpecies[i] >= 0.5 ? 1.0 : 0.48;
    majors.push(aSize[i] * worldScale * speciesScale * spanY);
  }
  majors.sort((a, b) => a - b);
  return {
    min: majors[0],
    max: majors[majors.length - 1],
    median: majors[majors.length >> 1],
    worldScale,
  };
}

const field = createPetalField({});
field.setSeason('spring');
const spring = petalWorldMajors(field);
assert.ok(spring.worldScale > 0.01 && spring.worldScale < 0.06,
  `petal uWorldScale out of product band: ${spring.worldScale}`);
assert.ok(spring.max <= SPRING_PETAL_MAX_M + 1e-6,
  `spring petal major ${spring.max}m exceeds document ${SPRING_PETAL_MAX_M}m`);
assert.ok(spring.min >= SPRING_PETAL_MIN_M - 0.005,
  `spring petal major ${spring.min}m below document floor`);
assert.ok(spring.max < DOOR_CARD_M, `spring petals regressed toward door-card size (${spring.max}m)`);

field.setSeason('autumn');
const autumn = petalWorldMajors(field);
assert.ok(autumn.max <= AUTUMN_LEAF_MAX_M + 1e-6,
  `autumn petal/leaf major ${autumn.max}m exceeds ${AUTUMN_LEAF_MAX_M}m ceiling`);
assert.ok(autumn.min >= AUTUMN_LEAF_MIN_M - 0.02,
  `autumn leaf major ${autumn.min}m unexpectedly tiny`);
assert.ok(autumn.max < DOOR_CARD_M, `autumn leaves regressed toward door-card size (${autumn.max}m)`);

// seasonLeaves (tree-canopy emitters) — instance matrix scale is the world size.
const envGroup = new THREE.Group();
const trees = new THREE.Group();
trees.name = 'trees';
// Minimal InstancedMesh emitter so buildLeaves has a canopy to hang from.
const dummyGeo = new THREE.BoxGeometry(1, 1, 1);
const dummyMat = new THREE.MeshStandardMaterial();
const canopy = new THREE.InstancedMesh(dummyGeo, dummyMat, 4);
canopy.name = 'ginkgo';
const dummy = new THREE.Object3D();
for (let i = 0; i < 4; i++) {
  dummy.position.set((i - 1.5) * 6, 0, (i % 2) * 4);
  dummy.scale.setScalar(1.4);
  dummy.updateMatrix();
  canopy.setMatrixAt(i, dummy.matrix);
}
trees.add(canopy);
envGroup.add(trees);
const seasons = setupSeasons(envGroup, { layout: { plotW: 20, plotD: 18 } });
const leaves = envGroup.getObjectByName('seasonLeaves');
assert.ok(leaves?.isInstancedMesh, 'seasonLeaves InstancedMesh missing');
seasons.setSeason('autumn', { immediate: true });
// Drive a few frames so writeOne fills instance matrices at autumn sizeScale.
for (let i = 0; i < 8; i++) seasons.update(1 / 30);
const pos = new THREE.Vector3();
const quat = new THREE.Quaternion();
const scl = new THREE.Vector3();
const m4 = new THREE.Matrix4();
const scales = [];
for (let i = 0; i < leaves.count; i++) {
  leaves.getMatrixAt(i, m4);
  m4.decompose(pos, quat, scl);
  // Long-axis world size ≈ unit spanY * uniform scale.
  scales.push(Math.max(scl.x, scl.y, scl.z) * spanY);
}
scales.sort((a, b) => a - b);
const leafMax = scales[scales.length - 1] || 0;
const leafMed = scales[scales.length >> 1] || 0;
assert.ok(leafMax <= AUTUMN_LEAF_MAX_M + 0.02,
  `seasonLeaves world major ${leafMax}m exceeds ${AUTUMN_LEAF_MAX_M}m (median ${leafMed})`);
assert.ok(leafMed < DOOR_CARD_M,
  `seasonLeaves median ${leafMed}m looks like unit-saddle door cards`);
assert.ok(leafMed > 0.04, `seasonLeaves median ${leafMed}m — matrices may still be identity`);

// seasonLitter clumps are intentional 0.45–1.35m piles, not individual particles.
// Only assert falling systems here.

seasons.dispose?.();
field.dispose?.();

console.log('SEASON PARTICLE SIZE: PASS');
console.log(JSON.stringify({
  unitSaddle: { spanX, spanY },
  spring,
  autumn,
  seasonLeaves: { min: scales[0], median: leafMed, max: leafMax, count: scales.length },
}, null, 2));
