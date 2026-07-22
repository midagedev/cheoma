// Three adapter contract: the product sun stays at its authored direction while
// only LightShadow receives a translated, texel-stable proxy.
import * as THREE from '../app/node_modules/three/build/three.module.js';
import { createDirectionalShadowRuntime } from '../app/src/engine/directional-shadow-runtime.js';

const EPS = 1e-7;
const invariant = (condition, message) => {
  if (!condition) throw new Error(message);
};
const near = (actual, expected, message, epsilon = EPS) => {
  invariant(Math.abs(actual - expected) <= epsilon, `${message}: ${actual} != ${expected}`);
};

const light = new THREE.DirectionalLight(0xffffff, 2.6);
light.position.set(30, 42, 26);
light.target.position.set(0, 0, 0);
light.shadow.camera.left = -22;
light.shadow.camera.right = 22;
light.shadow.camera.top = 22;
light.shadow.camera.bottom = -22;
light.shadow.mapSize.set(4096, 4096);
light.updateMatrixWorld(true);
light.target.updateMatrixWorld(true);

const authoredPosition = light.position.clone();
const authoredTarget = light.target.position.clone();
const authoredDirection = light.position.clone().sub(light.target.position).normalize();
const originalUpdateMatrices = light.shadow.updateMatrices;
const runtime = createDirectionalShadowRuntime(light);

const requested = new THREE.Vector3(312.25, 8.4, -271.75);
invariant(runtime.setAnchor(requested), 'first outer-parcel anchor did not invalidate shadow state');
light.shadow.updateMatrices(light);
const first = runtime.debugState();
invariant(first?.installed, 'directional shadow proxy was not installed');
invariant(first.anchor.every(Number.isFinite), 'resolved outer-parcel anchor is non-finite');
invariant(light.position.equals(authoredPosition), 'shadow framing moved the product sun position');
invariant(light.target.position.equals(authoredTarget), 'shadow framing moved the product sun target');

const shadowDirection = new THREE.Vector3(...first.direction);
near(shadowDirection.dot(authoredDirection), 1, 'shadow proxy changed the authored light direction');
const anchor = new THREE.Vector3(...first.anchor);
const shadowCameraDirection = new THREE.Vector3();
light.shadow.camera.getWorldDirection(shadowCameraDirection);
near(shadowCameraDirection.dot(authoredDirection.clone().negate()), 1,
  'shadow camera does not look along the authored light ray');

// The snapped anchor is the centre of the orthographic X/Y plane, so even a far
// world-space parcel target projects to the middle of the shadow texture.
const projected = anchor.clone().project(light.shadow.camera);
near(projected.x, 0, 'outer-parcel anchor is not centred in shadow X');
near(projected.y, 0, 'outer-parcel anchor is not centred in shadow Y');
invariant(projected.z >= -1 && projected.z <= 1, 'outer-parcel anchor left shadow near/far bounds');

const right = new THREE.Vector3(...first.right);
const sameCell = requested.clone().addScaledVector(right, first.texel * 0.2);
invariant(!runtime.setAnchor(sameCell), 'sub-texel right-axis motion invalidated the shadow cache');
const nextCell = requested.clone().addScaledVector(right, first.texel * 0.8);
invariant(runtime.setAnchor(nextCell), 'cross-texel right-axis motion did not invalidate shadow cache');

runtime.dispose();
invariant(light.shadow.updateMatrices === originalUpdateMatrices,
  'dispose did not restore the original LightShadow matrix updater');
invariant(runtime.debugState() === null, 'disposed runtime still exposed mutable shadow state');

console.log('DIRECTIONAL SHADOW RUNTIME: PASS');
