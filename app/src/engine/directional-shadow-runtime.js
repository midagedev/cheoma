import * as THREE from 'three';
import { snapDirectionalShadowAnchor } from '../../../src/api/shadow-framing.js';

const EPS = 1e-7;

// Ortho span ladder for the sun shadow, in metres of half-width.
//
// 22 is the authored eye-level/close-focus rung and stays the floor, so a focused house keeps
// its 0.011 m/texel eave detail. The upper rungs exist because the aerial pose shows the whole
// basin: at the settled village aerial the camera sits ~340 m out, and a 44 m box covered only
// 15% of the frame width — houses, walls and the 당산나무 cast nothing and the frame lost its
// parallel sun shadows entirely (look-grammar §3 "Sun shadows must read parallel").
// 220 m half-width over a 4096 map is 0.107 m/texel, still ~3x finer than that frame's
// 0.3 m/px, so the widest rung costs no perceptible softness where it is used.
//
// Discrete rungs (not a continuous ramp) matter for two reasons: the texel grid the anchor
// snaps to stays stable, and the static shadow cache only rebuilds when a rung changes
// instead of on every metre of orbit/dolly.
//
// The ramp is offset rather than proportional, so every close pose keeps the authored rung
// exactly. Proportional widening (0.6 x distance) also lifted close-focus and mid poses off
// 22, and the extra casters entering the box uploaded +49 geometries there — enough to break
// the hanyang focus/mid geometry ceiling for no visual gain, because a 44 m box already holds
// the whole subject compound at those distances. Widening only earns its cost once the frame
// shows more than one compound, which starts past the hero landing pose (~170 m).
const SPAN_LADDER = Object.freeze([22, 44, 88, 132, 176, 220]);
const SPAN_RAMP_START = 190;
const SPAN_PER_VIEW_DISTANCE = 1.1;

export function shadowSpanForViewDistance(distance) {
  if (!Number.isFinite(distance) || distance <= 0) return SPAN_LADDER[0];
  const wanted = Math.max(0, distance - SPAN_RAMP_START) * SPAN_PER_VIEW_DISTANCE;
  for (const rung of SPAN_LADDER) if (rung >= wanted) return rung;
  return SPAN_LADDER[SPAN_LADDER.length - 1];
}

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
  const viewCamera = light.userData?.shadowViewCamera || null;
  const authoredFar = camera.far;
  const authoredNormalBias = shadow.normalBias;
  const viewDistance = new THREE.Vector3();

  const requested = new THREE.Vector3();
  const lightWorld = new THREE.Vector3();
  const targetWorld = new THREE.Vector3();
  const direction = new THREE.Vector3();
  const snapped = new THREE.Vector3();
  let lastSignature = null;
  let disposed = false;

  // Resize the ortho box to the rung the current frame needs. Without a view camera the
  // authored box is left exactly as configured, so non-app harnesses are unaffected.
  function applySpan() {
    if (!viewCamera) return;
    viewCamera.getWorldPosition(viewDistance);
    const span = shadowSpanForViewDistance(viewDistance.distanceTo(requested));
    if (Math.abs(camera.right - span) < 1e-6) return;
    camera.left = -span; camera.right = span;
    camera.top = span; camera.bottom = -span;
    camera.updateProjectionMatrix();
  }

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
    applySpan();
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

  // The span is part of the signature so a rung change invalidates the static shadow cache;
  // otherwise a widened box would keep serving the map rendered for the narrow one.
  function signatureFor(result, span) {
    const d = result.direction;
    const a = result.anchor;
    return `${a.x}:${a.y}:${a.z}|${d.x}:${d.y}:${d.z}|${span}`;
  }

  const updateMatrices = function updateAnchoredDirectionalShadow() {
    const { result, sourceDirection, size } = resolve();
    // A wide box needs the light camera pushed back far enough that terrain and buildings on
    // the sunward side of the anchor stay in front of its near plane — a low sunset sun rakes
    // shadows a long way, and clipped casters read as arbitrarily missing shadows.
    const span = size.span * 0.5;
    const distance = Math.max(EPS, sourceDirection.length(), span * 2);
    camera.far = Math.max(authoredFar, distance + span * 3);
    camera.updateProjectionMatrix();
    // normalBias is a world-space offset, so it has to grow with the texel the wide rungs buy.
    // The giwa roof carries modelled 수키와 rows about 0.1 m across; at the widest rung one texel
    // is 0.107 m, so the authored 0.05 m offset no longer clears the relief and the roof shadows
    // itself — measured as the tile field collapsing to sRGB(2,3,8) while walls stayed readable.
    // 1.6 texels clears it, and at aerial scale the resulting peter-panning is sub-pixel.
    shadow.normalBias = Math.max(authoredNormalBias, (size.span / size.mapSize) * 1.6);
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
      const { result, size } = resolve();
      const signature = signatureFor(result, size.span);
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
