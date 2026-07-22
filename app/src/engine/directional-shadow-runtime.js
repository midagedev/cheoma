import * as THREE from 'three';
import { snapDirectionalShadowAnchor } from '../../../src/api/shadow-framing.js';

const EPS = 1e-7;

function finitePoint(value) {
  return value && Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z);
}

/**
 * Move only the directional shadow camera, not the product sun.
 *
 * Environment effects intentionally read `light.position` as a direction vector.
 * Moving the real light and target to a focused parcel would make clouds, motes,
 * grass, flare, and rim disagree. Instead LightShadow receives a matrix-only proxy
 * with the same direction and distance, translated over a texel-stable anchor.
 */
export function createDirectionalShadowRuntime(light) {
  const shadow = light?.shadow;
  const camera = shadow?.camera;
  if (!shadow || !camera || typeof shadow.updateMatrices !== 'function') {
    return {
      setAnchor() { return false; },
      debugState() { return null; },
      dispose() {},
    };
  }

  const originalUpdateMatrices = shadow.updateMatrices;
  const proxyLight = new THREE.Object3D();
  const proxyTarget = new THREE.Object3D();
  proxyLight.target = proxyTarget;

  const requested = new THREE.Vector3();
  const lightWorld = new THREE.Vector3();
  const targetWorld = new THREE.Vector3();
  const direction = new THREE.Vector3();
  const snapped = new THREE.Vector3();
  let lastSignature = null;
  let disposed = false;

  function dimensions() {
    const width = Math.abs(camera.right - camera.left);
    const height = Math.abs(camera.top - camera.bottom);
    const mapWidth = Math.max(1, Math.round(shadow.mapSize?.x || 1));
    const mapHeight = Math.max(1, Math.round(shadow.mapSize?.y || 1));
    return {
      width,
      height,
      mapWidth,
      mapHeight,
      // The product camera/map are square. Conservative maxima keep a future
      // rectangular configuration covered without inventing two snap grids.
      span: Math.max(width, height),
      mapSize: Math.min(mapWidth, mapHeight),
    };
  }

  function currentDirection() {
    light.updateWorldMatrix?.(true, false);
    light.target?.updateWorldMatrix?.(true, false);
    light.getWorldPosition(lightWorld);
    if (light.target?.getWorldPosition) light.target.getWorldPosition(targetWorld);
    else targetWorld.set(0, 0, 0);
    direction.subVectors(lightWorld, targetWorld);
    return direction;
  }

  function resolve() {
    const size = dimensions();
    const sourceDirection = currentDirection();
    const result = snapDirectionalShadowAnchor(
      requested,
      sourceDirection,
      size.span,
      size.mapSize,
    );
    snapped.set(result.anchor.x, result.anchor.y, result.anchor.z);
    return { result, sourceDirection, size };
  }

  function signatureFor(result) {
    const d = result.direction;
    const a = result.anchor;
    return `${a.x}:${a.y}:${a.z}|${d.x}:${d.y}:${d.z}`;
  }

  const updateMatrices = function updateAnchoredDirectionalShadow() {
    const { result, sourceDirection } = resolve();
    const distance = Math.max(EPS, sourceDirection.length());
    proxyTarget.position.copy(snapped);
    proxyLight.position.set(
      snapped.x + result.direction.x * distance,
      snapped.y + result.direction.y * distance,
      snapped.z + result.direction.z * distance,
    );
    proxyTarget.updateMatrixWorld(true);
    proxyLight.updateMatrixWorld(true);
    return originalUpdateMatrices.call(shadow, proxyLight);
  };
  shadow.updateMatrices = updateMatrices;

  return {
    setAnchor(value) {
      if (disposed) return false;
      if (finitePoint(value)) requested.set(value.x, value.y, value.z);
      else requested.set(0, 0, 0);
      const { result } = resolve();
      const signature = signatureFor(result);
      const changed = signature !== lastSignature;
      lastSignature = signature;
      return changed;
    },
    debugState() {
      if (disposed) return null;
      const { result, size } = resolve();
      const requestedNdc = requested.clone().project(camera);
      return {
        requested: requested.toArray(),
        anchor: [result.anchor.x, result.anchor.y, result.anchor.z],
        direction: [result.direction.x, result.direction.y, result.direction.z],
        right: [result.basis.right.x, result.basis.right.y, result.basis.right.z],
        up: [result.basis.up.x, result.basis.up.y, result.basis.up.z],
        texel: result.texel.size,
        span: [size.width, size.height],
        mapSize: [size.mapWidth, size.mapHeight],
        requestedNdc: requestedNdc.toArray(),
        cameraPosition: camera.position.toArray(),
        installed: shadow.updateMatrices === updateMatrices,
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (shadow.updateMatrices === updateMatrices) shadow.updateMatrices = originalUpdateMatrices;
      proxyLight.target = null;
    },
  };
}
