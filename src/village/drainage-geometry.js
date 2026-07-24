import * as THREE from 'three';
import { mergeOwnedGeometries } from '../core/merge-owned-geometries.js';

// Lightweight Three adapter for the renderer-free roadside-drainage plan.
//
// The plan is already in the world frame: run point y is the authoritative bed
// elevation, surfaceY is the exact terrain under it, and y + depth is its lip.
// Crossing center.y is the top of the deck,
// while yaw aligns local +Z with the gate-to-road travel axis. This module does
// not resample terrain, choose placements, or consume global RNG.

export const DRAINAGE_MATERIAL_ROLES = Object.freeze(['ground']);

const lifecycleByRoot = new WeakMap();
const EPSILON = 1e-8;
const CROSSING_SLAB_COUNT = 3;
const CROSSING_SLAB_TOP_VARIATION = 0.0025;

function linearColor(hex) {
  const color = new THREE.Color().setHex(hex, THREE.SRGBColorSpace);
  return Object.freeze([color.r, color.g, color.b]);
}

const DITCH_COLORS = Object.freeze({
  outer: linearColor(0x9a865f),
  lip: linearColor(0x88795d),
  bed: linearColor(0x706858),
});

const CROSSING_COLORS = Object.freeze({
  top: linearColor(0x918b7d),
  side: linearColor(0x716c62),
  bottom: linearColor(0x56534c),
});

function requireFinite(value, label) {
  if (!Number.isFinite(value)) throw new TypeError(`${label} must be finite`);
  return value;
}

function requirePositive(value, label) {
  const resolved = requireFinite(value, label);
  if (resolved <= 0) throw new RangeError(`${label} must be positive`);
  return resolved;
}

function validatePoint(point, label) {
  if (!point || typeof point !== 'object') {
    throw new TypeError(`${label} must be an object`);
  }
  requireFinite(point.x, `${label}.x`);
  requireFinite(point.y, `${label}.y`);
  requireFinite(point.z, `${label}.z`);
  requireFinite(point.surfaceY, `${label}.surfaceY`);
  requireFinite(point.depth, `${label}.depth`);
  if (point.depth <= 0) throw new RangeError(`${label}.depth must be positive`);
  if (point.y <= point.surfaceY) {
    throw new RangeError(`${label}.y must remain above its terrain surface`);
  }
}

function validateRun(run, index) {
  const label = `drainage runs[${index}]`;
  if (!run || typeof run !== 'object') throw new TypeError(`${label} must be an object`);
  requirePositive(run.width, `${label}.width`);
  requirePositive(run.bedWidth, `${label}.bedWidth`);
  if (run.bedWidth >= run.width) {
    throw new RangeError(`${label}.bedWidth must be smaller than width`);
  }
  if (!Array.isArray(run.points) || run.points.length < 2) {
    throw new RangeError(`${label}.points must contain at least two points`);
  }
  run.points.forEach((point, pointIndex) => validatePoint(
    point,
    `${label}.points[${pointIndex}]`,
  ));
  for (let pointIndex = 1; pointIndex < run.points.length; pointIndex++) {
    const previous = run.points[pointIndex - 1];
    const point = run.points[pointIndex];
    if (Math.hypot(point.x - previous.x, point.z - previous.z) <= EPSILON) {
      throw new RangeError(`${label}.points must not contain consecutive duplicate positions`);
    }
  }
}

function validateCrossing(crossing, index) {
  const label = `drainage crossings[${index}]`;
  if (!crossing || typeof crossing !== 'object') {
    throw new TypeError(`${label} must be an object`);
  }
  if (crossing.kind !== 'stone-slab') {
    throw new RangeError(`${label}.kind must be stone-slab`);
  }
  const center = crossing.center;
  if (!center || typeof center !== 'object') {
    throw new TypeError(`${label}.center must be an object`);
  }
  requireFinite(center.x, `${label}.center.x`);
  requireFinite(center.y, `${label}.center.y`);
  requireFinite(center.z, `${label}.center.z`);
  requireFinite(crossing.yaw, `${label}.yaw`);
  requirePositive(crossing.span, `${label}.span`);
  requirePositive(crossing.width, `${label}.width`);
  requirePositive(crossing.thickness, `${label}.thickness`);
}

function validateGeometryInput(plan) {
  if (!plan || typeof plan !== 'object') {
    throw new TypeError('drainage plan must be an object');
  }
  if (!Array.isArray(plan.runs)) throw new TypeError('drainage plan.runs must be an array');
  if (!Array.isArray(plan.crossings)) {
    throw new TypeError('drainage plan.crossings must be an array');
  }
  plan.runs.forEach(validateRun);
  plan.crossings.forEach(validateCrossing);
}

function pointFrame(points, index) {
  const current = points[index];
  const previous = points[Math.max(0, index - 1)];
  const next = points[Math.min(points.length - 1, index + 1)];
  let tx = next.x - previous.x;
  let tz = next.z - previous.z;
  let length = Math.hypot(tx, tz);
  if (length <= EPSILON && index > 0) {
    tx = current.x - previous.x;
    tz = current.z - previous.z;
    length = Math.hypot(tx, tz);
  }
  if (length <= EPSILON && index + 1 < points.length) {
    tx = next.x - current.x;
    tz = next.z - current.z;
    length = Math.hypot(tx, tz);
  }
  if (length <= EPSILON) {
    throw new RangeError('drainage run contains a zero-length local frame');
  }
  // geom2 perpL: +1 is the left side of the plan's road start-to-end frame.
  return { nx: -tz / length, nz: tx / length };
}

function pushColor(colors, color) {
  colors.push(color[0], color[1], color[2]);
}

function buildDitchGeometry(runs) {
  if (!runs.length) return null;
  const positions = [];
  const colors = [];
  const indices = [];

  for (const run of runs) {
    const baseVertex = positions.length / 3;
    const halfWidth = run.width * 0.5;
    const halfBed = run.bedWidth * 0.5;
    const halfLip = (halfWidth + halfBed) * 0.5;
    const offsets = [-halfWidth, -halfLip, -halfBed, halfBed, halfLip, halfWidth];
    for (let pointIndex = 0; pointIndex < run.points.length; pointIndex++) {
      const point = run.points[pointIndex];
      const { nx, nz } = pointFrame(run.points, pointIndex);
      // The outer rails return to the same shallow raised bed plane instead of
      // ending as vertical ribbons. One-metre plan sampling follows exact terrain
      // triangle changes closely enough to keep this blend above the shared mesh.
      const outerY = point.y;
      const heights = [
        outerY,
        point.y + point.depth,
        point.y,
        point.y,
        point.y + point.depth,
        outerY,
      ];
      const railColors = [
        DITCH_COLORS.outer,
        DITCH_COLORS.lip,
        DITCH_COLORS.bed,
        DITCH_COLORS.bed,
        DITCH_COLORS.lip,
        DITCH_COLORS.outer,
      ];
      for (let rail = 0; rail < offsets.length; rail++) {
        positions.push(
          point.x + nx * offsets[rail],
          heights[rail],
          point.z + nz * offsets[rail],
        );
        pushColor(colors, railColors[rail]);
      }
    }

    // The cross-section advances from -perpL to +perpL. This winding keeps the
    // open earth channel front-facing toward +Y without a double-sided material.
    for (let pointIndex = 0; pointIndex < run.points.length - 1; pointIndex++) {
      const row = baseVertex + pointIndex * offsets.length;
      const nextRow = row + offsets.length;
      for (let rail = 0; rail < offsets.length - 1; rail++) {
        const a = row + rail;
        const b = nextRow + rail;
        const c = nextRow + rail + 1;
        const d = row + rail + 1;
        indices.push(a, c, b, a, d, c);
      }
    }
  }

  if (!indices.length) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function stableUnit(seed, channel) {
  const text = `${seed ?? 'crossing'}:${channel}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) / 0x100000000;
}

function applyCrossingColors(geometry, shade = 1) {
  const normals = geometry.getAttribute('normal');
  const colors = new Float32Array(normals.count * 3);
  for (let index = 0; index < normals.count; index++) {
    const ny = normals.getY(index);
    const color = ny > 0.5
      ? CROSSING_COLORS.top
      : (ny < -0.5 ? CROSSING_COLORS.bottom : CROSSING_COLORS.side);
    colors[index * 3] = Math.min(1, color[0] * shade);
    colors[index * 3 + 1] = Math.min(1, color[1] * shade);
    colors[index * 3 + 2] = Math.min(1, color[2] * shade);
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

function crossingSlabLayout(crossing) {
  const gap = Math.min(0.018, crossing.span * 0.022);
  const usableSpan = crossing.span - gap * (CROSSING_SLAB_COUNT - 1);
  if (usableSpan <= EPSILON) {
    throw new RangeError('drainage crossing span is too short for three slabs');
  }
  const weights = Array.from(
    { length: CROSSING_SLAB_COUNT },
    (_unused, index) => 0.94 + stableUnit(crossing.id, `span-${index}`) * 0.12,
  );
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);
  const fullWidthSlab = Math.floor(
    stableUnit(crossing.id, 'full-width') * CROSSING_SLAB_COUNT,
  );
  let cursor = -crossing.span * 0.5;
  return weights.map((weight, index) => {
    const span = index === CROSSING_SLAB_COUNT - 1
      ? crossing.span * 0.5 - cursor
      : usableSpan * weight / weightTotal;
    const widthScale = index === fullWidthSlab
      ? 1
      : 0.965 + stableUnit(crossing.id, `width-${index}`) * 0.02;
    const width = crossing.width * widthScale;
    const xFreedom = Math.max(0, (crossing.width - width) * 0.5);
    const x = index === fullWidthSlab
      ? 0
      : (stableUnit(crossing.id, `x-${index}`) * 2 - 1) * xFreedom;
    const top = (
      stableUnit(crossing.id, `top-${index}`) * 2 - 1
    ) * CROSSING_SLAB_TOP_VARIATION;
    const thickness = crossing.thickness * (
      0.95 + stableUnit(crossing.id, `thickness-${index}`) * 0.1
    );
    const slab = {
      x,
      z: cursor + span * 0.5,
      top,
      span,
      width,
      thickness,
      shade: 0.965 + stableUnit(crossing.id, `shade-${index}`) * 0.07,
    };
    cursor += span + gap;
    return slab;
  });
}

function makeCrossingGeometries(crossing) {
  return crossingSlabLayout(crossing).map((slab) => {
    const geometry = applyCrossingColors(new THREE.BoxGeometry(
      slab.width,
      slab.thickness,
      slab.span,
    ), slab.shade);
    // center.y is the authoritative nominal deck top. Three deterministic,
    // narrowly separated slabs remain within ±2.5 mm of that landing plane.
    geometry.translate(slab.x, slab.top - slab.thickness * 0.5, slab.z);
    geometry.rotateY(crossing.yaw);
    geometry.translate(
      crossing.center.x,
      crossing.center.y,
      crossing.center.z,
    );
    return geometry;
  });
}

function buildCrossingGeometry(crossings) {
  if (!crossings.length) return null;
  const sources = [];
  try {
    for (const crossing of crossings) {
      sources.push(...makeCrossingGeometries(crossing));
    }
  } catch (error) {
    for (const geometry of sources) geometry.dispose();
    throw error;
  }
  const geometry = mergeOwnedGeometries(sources, 'Drainage crossing geometries');
  if (!geometry) throw new Error('Drainage crossing geometry merge returned null');
  geometry.clearGroups();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function createDefaultMaterial() {
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.98,
    metalness: 0,
  });
  material.name = 'roadside-drainage-ground';
  material.userData = {
    ...material.userData,
    role: 'ground',
    snowSurface: true,
    drainageOwned: true,
  };
  return material;
}

function resolveMaterial(materials) {
  if (materials == null) {
    const material = createDefaultMaterial();
    return { material, owned: true };
  }
  const material = materials.ground;
  if (!material?.isMeshStandardMaterial) {
    throw new TypeError('drainage materials.ground must be a MeshStandardMaterial');
  }
  if (material.vertexColors !== true) {
    throw new RangeError('drainage materials.ground must enable vertexColors');
  }
  return { material, owned: false };
}

function makePhysicalMesh(geometry, material, name) {
  if (!geometry) return null;
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  return mesh;
}

function finiteGeometryBounds(geometry) {
  const box = geometry?.boundingBox;
  return !!box && [
    box.min.x, box.min.y, box.min.z,
    box.max.x, box.max.y, box.max.z,
  ].every(Number.isFinite);
}

/**
 * Build at most two physical, world-space meshes from a roadside-drainage plan.
 *
 * `materials.ground` is borrowed when supplied and must have vertexColors=true.
 * With no material input, the adapter owns one texture-free standard material.
 * In both cases the result owns only its geometries plus any default material.
 */
export function buildDrainage(plan, { materials = null } = {}) {
  validateGeometryInput(plan);
  const root = new THREE.Group();
  root.name = 'roadside-drainage-ground';
  const geometries = new Set();
  const ownedMaterials = new Set();

  try {
    const ditchGeometry = buildDitchGeometry(plan.runs);
    if (ditchGeometry) geometries.add(ditchGeometry);
    const crossingGeometry = buildCrossingGeometry(plan.crossings);
    if (crossingGeometry) geometries.add(crossingGeometry);
    const resolved = geometries.size ? resolveMaterial(materials) : null;
    if (resolved?.owned) ownedMaterials.add(resolved.material);

    for (const [geometry, name] of [
      [ditchGeometry, 'road-drainage-ground'],
      [crossingGeometry, 'road-drainage-stone-crossings'],
    ]) {
      if (!geometry) continue;
      if (!finiteGeometryBounds(geometry)) {
        throw new RangeError(`${name} produced non-finite bounds`);
      }
      root.add(makePhysicalMesh(geometry, resolved.material, name));
    }

    root.userData.drainage = {
      schema: plan.schema,
      runCount: plan.runs.length,
      crossingCount: plan.crossings.length,
      meshCount: root.children.length,
      materialOwnership: resolved
        ? (resolved.owned ? 'renderer' : 'caller')
        : 'none',
      geometryOwnership: 'renderer',
    };
    lifecycleByRoot.set(root, {
      disposed: false,
      geometries,
      ownedMaterials,
    });
    return root;
  } catch (error) {
    for (const geometry of geometries) geometry.dispose();
    for (const material of ownedMaterials) material.dispose();
    root.clear();
    throw error;
  }
}

/**
 * Dispose renderer-owned resources exactly once. Detaching the root from its
 * scene remains the caller's responsibility; borrowed materials are untouched.
 */
export function disposeDrainage(root) {
  const lifecycle = root && lifecycleByRoot.get(root);
  if (!lifecycle || lifecycle.disposed) return false;
  lifecycle.disposed = true;
  for (const geometry of lifecycle.geometries) geometry.dispose();
  for (const material of lifecycle.ownedMaterials) material.dispose();
  lifecycle.geometries.clear();
  lifecycle.ownedMaterials.clear();
  root.clear();
  root.visible = false;
  root.userData.drainage = null;
  return true;
}
