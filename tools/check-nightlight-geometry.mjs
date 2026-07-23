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
      export { buildNightLights } from './src/village/nightlights.js';
      export { dofDepthMaterialForObject } from './src/env/dof.js';
    `,
    resolveDir: ROOT,
    sourcefile: 'nightlight-physical-contract-entry.js',
  },
  alias: { three: join(ROOT, 'app/node_modules/three/build/three.module.js') },
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
const { THREE, buildNightLights, dofDepthMaterialForObject } = await import(url);

const anchor = (id, x, y, z, outward, width = 1.2, height = 0.8) =>
  Object.freeze({
    openingId: id,
    kind: 'window',
    style: 'giwa',
    primary: false,
    width,
    height,
    position: Object.freeze({ x, y, z }),
    outward: Object.freeze(outward),
  });

function fixture(ownerCount) {
  const parcels = [];
  const owners = new Map();
  for (let index = 0; index < ownerCount; index++) {
    const id = `owner-${index}`;
    parcels.push({
      id,
      kind: 'giwa',
      hero: true,
      seed: 1000 + index,
      wealth: 0.8,
      center: { x: index * 2, z: 0 },
      frontDir: { x: 0, z: 1 },
    });
    owners.set(id, [
      anchor(
        `${id}-front`,
        index * 2,
        1.6,
        0,
        { x: 0, y: 0, z: 1 },
        1.1 + (index % 3) * 0.1,
        0.72,
      ),
      anchor(
        `${id}-side`,
        index * 2 + 0.7,
        1.5,
        -0.4,
        { x: 1, y: 0, z: 0 },
        0.8,
        0.65,
      ),
    ]);
  }
  return [{ parcels, features: {} }, { owners }];
}

const bytes = (attribute) =>
  Buffer.from(
    attribute.array.buffer,
    attribute.array.byteOffset,
    attribute.array.byteLength,
  ).toString('hex');

function buildBoth(ownerCount) {
  const [plan, sources] = fixture(ownerCount);
  return {
    points: buildNightLights(plan, null, sources, { representation: 'points' }),
    physical: buildNightLights(plan, null, sources, { representation: 'physical' }),
  };
}

const originalRandom = Math.random;
let randomCalls = 0;
Math.random = () => {
  randomCalls++;
  return 0.25;
};
let pair;
try {
  pair = buildBoth(8);
} finally {
  Math.random = originalRandom;
}
// Three resource UUID generation uses Math.random; the policy itself must not.
// Both paths allocate the same geometry/material/Object3D count, so equal UUID
// overhead proves the representation did not add policy randomness.
const baselineCalls = randomCalls;
randomCalls = 0;
Math.random = () => {
  randomCalls++;
  return 0.25;
};
let repeat;
try {
  repeat = buildBoth(8);
} finally {
  Math.random = originalRandom;
}
assert.equal(randomCalls, baselineCalls, 'physical representation changed random consumption');

const points = pair.points.group.getObjectByName('nightlight-points');
const physical = pair.physical.group.getObjectByName('nightlight-physical');
const repeatPhysical = repeat.physical.group.getObjectByName('nightlight-physical');
assert(points?.isPoints, 'A/B fixture lost FAR Points');
assert(physical?.isMesh && physical.geometry.isInstancedBufferGeometry,
  'FULL proxy is not one instanced physical batch');
assert.equal(pair.physical.group.children.length, 1,
  'physical path allocated a per-owner Object3D');
assert.equal(physical.geometry.instanceCount, points.geometry.getAttribute('position').count,
  'physical and point paths changed slot identity');

for (const [pointName, physicalName] of [
  ['position', 'aAnchor'],
  ['aPhase', 'aPhase'],
  ['aLit', 'aLit'],
  ['aThreshold', 'aThreshold'],
  ['aWarm', 'aWarm'],
]) {
  assert.equal(
    bytes(points.geometry.getAttribute(pointName)),
    bytes(physical.geometry.getAttribute(physicalName)),
    `${pointName} diverged between FAR and physical representations`,
  );
  assert.equal(
    bytes(physical.geometry.getAttribute(physicalName)),
    bytes(repeatPhysical.geometry.getAttribute(physicalName)),
    `${physicalName} is not byte deterministic`,
  );
}

const physicalState = pair.physical.debugState();
assert.deepEqual(physicalState, {
  pointCount: 24,
  ownerCount: 8,
  drawCalls: 1,
  dofDepthDrawCalls: 1,
  triangles: 48,
  materials: 2,
  programs: 2,
  textures: 0,
  lights: 0,
  depthTest: true,
}, 'physical batch resource contract changed');
assert.deepEqual(pair.physical.debugRepresentation(), {
  representation: 'physical',
  attributeBytes: 80 + 24 * (3 + 3 + 2 + 1 + 1 + 1 + 1) * 4,
  activeObject: 'nightlight-physical',
  allocatedRepresentations: ['physical'],
}, 'physical attribute-memory accounting changed');
assert.equal(physical.material.side, THREE.FrontSide,
  'rear-facing physical windows can leak through a house');
assert.equal(physical.material.depthWrite, false,
  'additive physical windows started writing scene depth');
assert.equal(physical.material.depthTest, true,
  'physical windows stopped respecting walls and roofs');
assert.equal(physical.material.uniforms, physical.userData.dofDepthMaterial.uniforms,
  'physical color/depth paths do not share one visibility state');
assert.equal(physical.material.vertexShader, physical.userData.dofDepthMaterial.vertexShader,
  'physical color/depth paths do not share exact world placement');
assert.equal(dofDepthMaterialForObject(physical), physical.userData.dofDepthMaterial,
  'physical source depth is not published to #88');
assert.equal(physical.userData.dofDepthMaterial.allowOverride, false,
  'physical source depth can be replaced by the generic override');
assert(
  physical.material.vertexShader.includes('aAnchor')
    && physical.material.vertexShader.includes('aOutward')
    && physical.material.vertexShader.includes('aOpeningSize')
    && physical.material.vertexShader.includes('outward * 0.004')
    && physical.material.vertexShader.includes('smoothstep(uFadeNear, uFadeNearEnd'),
  'physical proxy lost authored surface placement or near hanji handoff',
);
assert(
  physical.userData.dofDepthMaterial.fragmentShader
    .includes('packDepthToRGBA(gl_FragCoord.z)'),
  'physical proxy lost packed source depth',
);

// A hundred houses remain one color/depth program family; only instance bytes
// and submitted triangles scale with source count.
const large = buildBoth(100);
const largePhysicalState = large.physical.debugState();
assert.equal(large.physical.group.children.length, 1);
assert.equal(largePhysicalState.drawCalls, physicalState.drawCalls);
assert.equal(largePhysicalState.dofDepthDrawCalls, physicalState.dofDepthDrawCalls);
assert.equal(largePhysicalState.materials, physicalState.materials);
assert.equal(largePhysicalState.programs, physicalState.programs);
assert.equal(largePhysicalState.lights, 0);
assert.equal(largePhysicalState.textures, 0);
assert.equal(
  largePhysicalState.triangles,
  largePhysicalState.pointCount * 2,
  'physical triangle budget stopped matching one quad per slot',
);

// Refresh updates the same instance attributes and resources in place.
const beforeGeometry = physical.geometry;
const beforeMaterial = physical.material;
const beforeAnchorAttribute = physical.geometry.getAttribute('aAnchor');
const overlay = new THREE.Group();
overlay.userData.openingGlowAnchors = [
  anchor('replacement', 7, 2, 4, { x: -1, y: 0, z: 0 }, 1.8, 1.1),
];
assert.equal(pair.physical.refreshOwner('owner-0', overlay), true);
assert.equal(physical.geometry, beforeGeometry);
assert.equal(physical.material, beforeMaterial);
assert.equal(physical.geometry.getAttribute('aAnchor'), beforeAnchorAttribute);
assert.equal(beforeAnchorAttribute.needsUpdate, undefined);
assert.equal(beforeAnchorAttribute.version, 1,
  'physical refresh did not mark the fixed instance buffer dirty exactly once');

// Physical and point paths share the same near handoff and become visible only
// when the village night/wave contracts permit them.
pair.physical.setLevel(1);
assert.equal(physical.visible, true);
pair.physical.group.userData.waveFade.setWeight(0);
assert.equal(physical.visible, false);
pair.physical.group.userData.waveFade.setWeight(1);
pair.physical.update(0.5, 1, 1.4);
assert.equal(physical.material.uniforms.uTime.value, 0.5);

let geometryDisposals = 0;
let materialDisposals = 0;
let depthDisposals = 0;
physical.geometry.addEventListener('dispose', () => geometryDisposals++);
physical.material.addEventListener('dispose', () => materialDisposals++);
physical.userData.dofDepthMaterial.addEventListener('dispose', () => depthDisposals++);
pair.physical.dispose();
pair.physical.dispose();
assert.equal(geometryDisposals, 1);
assert.equal(materialDisposals, 1);
assert.equal(depthDisposals, 1);
assert.equal(pair.physical.group.children.length, 0);
assert.equal(physical.userData.dofDepthMaterial, undefined);
assert.equal(physical.visible, false);

// The real-app A/B hook allocates the alternate path lazily, keeps exactly one
// child active, and releases both representations when the owner is disposed.
assert.equal(pair.points.debugSetRepresentationForTest('physical'), true);
const lazyPhysical = pair.points.group.getObjectByName('nightlight-physical');
assert(lazyPhysical?.isMesh);
assert.equal(pair.points.group.children.length, 1);
assert.deepEqual(
  pair.points.debugRepresentation().allocatedRepresentations,
  ['physical', 'points'],
);
assert.equal(pair.points.debugSetRepresentationForTest('points'), true);
let switchedGeometryDisposals = 0;
points.geometry.addEventListener('dispose', () => switchedGeometryDisposals++);
lazyPhysical.geometry.addEventListener('dispose', () => switchedGeometryDisposals++);
pair.points.dispose();
pair.points.dispose();
assert.equal(switchedGeometryDisposals, 2,
  'A/B owner did not dispose both lazily allocated geometries exactly once');
assert.equal(pair.points.group.children.length, 0);

for (const api of [
  repeat.points,
  repeat.physical,
  large.points,
  large.physical,
]) api.dispose();

console.log(
  'NIGHTLIGHT PHYSICAL GEOMETRY: PASS '
  + '(same deterministic slots, 1+1 draws, front-only depth, dispose plateau)',
);
