import * as THREE from 'three';
import { mergeOwnedGeometries } from '../../core/merge-owned-geometries.js';
import { patchInstFadeMaterial } from '../../env/inst-fade-shader.js';

// Reusable physical renderer for the renderer-free yard-life record contract.
//
// This module owns no placement, parcel selection, product palette, season clock,
// camera thresholds, or global RNG. It consumes JSON records plus semantic
// caller-owned MeshStandardMaterial inputs. Derived fade materials and all
// geometries belong to the returned handle; the borrowed inputs remain untouched.

export const YARD_LIFE_MATERIAL_ROLES = Object.freeze([
  'wood',
  'onggi',
  'straw',
  'stone',
  'chaff',
  'fiber',
]);

export const YARD_LIFE_SEASONS = Object.freeze([
  'spring',
  'summer',
  'autumn',
  'winter',
]);

export const YARD_LIFE_WEATHER = Object.freeze([
  'clear',
  'rain',
  'snow',
]);

const MOTIFS = Object.freeze({
  'spring-seed-prep': {
    season: 'spring',
    variants: new Set(['onggi-bowl', 'wooden-bowl']),
    kinds: new Set(['water-bowl', 'seed-basket']),
  },
  'autumn-threshing': {
    season: 'autumn',
    variants: new Set(['gesang', 'taetdol']),
    kinds: new Set([
      'threshing-bench',
      'threshing-stone',
      'bound-sheaf',
      'chaff-patch',
    ]),
  },
  'winter-fuel': {
    season: 'winter',
    variants: new Set(['firewood-stack', 'straw-covered-firewood']),
    kinds: new Set(['split-log', 'stack-support', 'straw-cover']),
  },
});

const EXPECTED_ROLES = Object.freeze({
  'water-bowl': new Set(['onggi', 'wood']),
  'seed-basket': new Set(['fiber']),
  'threshing-bench': new Set(['wood']),
  'threshing-stone': new Set(['stone']),
  'bound-sheaf': new Set(['straw']),
  'chaff-patch': new Set(['chaff']),
  'split-log': new Set(['wood']),
  'stack-support': new Set(['wood']),
  'straw-cover': new Set(['straw']),
});

const COUNT_LIMITS = Object.freeze({
  'water-bowl': [1, 1],
  'seed-basket': [1, 2],
  'threshing-bench': [1, 1],
  'threshing-stone': [1, 1],
  'bound-sheaf': [2, 4],
  'chaff-patch': [1, 1],
  'split-log': [8, 14],
  'stack-support': [1, 1],
  'straw-cover': [1, 1],
});

const LOD_EPSILON = 0.002;
const BOUNDS_EPSILON = 1e-4;
const UP = new THREE.Vector3(0, 1, 0);

function clamp01(value) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function finite(value, label) {
  if (!Number.isFinite(value)) throw new TypeError(`${label} must be finite`);
  return value;
}

function positive(value, label) {
  const result = finite(value, label);
  if (!(result > 0)) throw new RangeError(`${label} must be positive`);
  return result;
}

function countOf(part, label) {
  const count = part?.count ?? 1;
  if (!Number.isInteger(count)) throw new TypeError(`${label}.count must be an integer`);
  const limits = COUNT_LIMITS[part.kind];
  if (!limits || count < limits[0] || count > limits[1]) {
    throw new RangeError(
      `${label}.count for ${part.kind} must be ${limits?.[0] ?? 0}..${limits?.[1] ?? 0}`,
    );
  }
  return count;
}

function normalizeRecord(record, index, heightAt) {
  const label = `yard-life record[${index}]`;
  if (!record || typeof record !== 'object') throw new TypeError(`${label} must be an object`);
  if (record.schema !== 1) throw new RangeError(`${label}.schema must be 1`);
  if (typeof record.id !== 'string' || !record.id || record.id.length > 160) {
    throw new TypeError(`${label}.id must be a non-empty string no longer than 160 characters`);
  }
  if (typeof record.owner?.parcelId !== 'string' || !record.owner.parcelId) {
    throw new TypeError(`${label}.owner.parcelId must be a non-empty string`);
  }
  const motif = MOTIFS[record.motif];
  if (!motif) throw new RangeError(`${label}.motif is unsupported`);
  if (record.season !== motif.season) {
    throw new RangeError(`${label}.season does not match ${record.motif}`);
  }
  if (!motif.variants.has(record.variant)) {
    throw new RangeError(`${label}.variant is unsupported for ${record.motif}`);
  }
  if (record.footprint?.shape !== 'rect') {
    throw new RangeError(`${label}.footprint must be an oriented rect`);
  }
  const halfX = positive(record.footprint.halfX, `${label}.footprint.halfX`);
  const halfZ = positive(record.footprint.halfZ, `${label}.footprint.halfZ`);
  const x = finite(record.world?.x, `${label}.world.x`);
  const z = finite(record.world?.z, `${label}.world.z`);
  let y = record.world?.y;
  if (!Number.isFinite(y)) {
    if (typeof heightAt !== 'function') {
      throw new TypeError(`${label}.world.y must be finite when heightAt is absent`);
    }
    y = heightAt(x, z);
  }
  finite(y, `${label} base height`);
  const yaw = finite(record.world?.yaw, `${label}.world.yaw`);
  const scale = positive(record.scale ?? 1, `${label}.scale`);
  positive(record.height, `${label}.height`);

  if (!Array.isArray(record.weather?.allow) || record.weather.allow.length === 0) {
    throw new TypeError(`${label}.weather.allow must be a non-empty array`);
  }
  const allowedWeather = new Set();
  for (const name of record.weather.allow) {
    if (!YARD_LIFE_WEATHER.includes(name)) {
      throw new RangeError(`${label}.weather.allow contains unsupported weather ${name}`);
    }
    allowedWeather.add(name);
  }
  if (!Array.isArray(record.parts) || record.parts.length === 0) {
    throw new TypeError(`${label}.parts must be a non-empty array`);
  }
  const parts = record.parts.map((part, partIndex) => {
    const partLabel = `${label}.parts[${partIndex}]`;
    if (!part || !motif.kinds.has(part.kind)) {
      throw new RangeError(`${partLabel}.kind is unsupported for ${record.motif}`);
    }
    if (!EXPECTED_ROLES[part.kind]?.has(part.materialRole)) {
      throw new RangeError(`${partLabel}.materialRole is unsupported for ${part.kind}`);
    }
    return {
      kind: part.kind,
      materialRole: part.materialRole,
      count: countOf(part, partLabel),
    };
  });

  const kinds = new Set(parts.map((part) => part.kind));
  if (record.variant === 'onggi-bowl'
    && !parts.some((part) => part.kind === 'water-bowl' && part.materialRole === 'onggi')) {
    throw new RangeError(`${label} onggi-bowl requires an onggi water-bowl`);
  }
  if (record.variant === 'wooden-bowl'
    && !parts.some((part) => part.kind === 'water-bowl' && part.materialRole === 'wood')) {
    throw new RangeError(`${label} wooden-bowl requires a wood water-bowl`);
  }
  if (record.variant === 'gesang'
    && (!kinds.has('threshing-bench') || kinds.has('threshing-stone'))) {
    throw new RangeError(`${label} gesang requires only the threshing-bench primary`);
  }
  if (record.variant === 'taetdol'
    && (!kinds.has('threshing-stone') || kinds.has('threshing-bench'))) {
    throw new RangeError(`${label} taetdol requires only the threshing-stone primary`);
  }
  const hasCover = kinds.has('straw-cover');
  if ((record.variant === 'straw-covered-firewood') !== hasCover) {
    throw new RangeError(`${label} winter cover must match the seed-stable variant`);
  }

  const materialRoles = new Set(record.materialRoles || []);
  for (const part of parts) {
    if (!materialRoles.has(part.materialRole)) {
      throw new RangeError(`${label}.materialRoles is missing ${part.materialRole}`);
    }
  }

  return {
    source: record,
    id: record.id,
    ownerId: record.owner.parcelId,
    season: record.season,
    motif: record.motif,
    variant: record.variant,
    weather: allowedWeather,
    parts,
    world: { x, y, z, yaw },
    footprint: { halfX, halfZ },
    scale,
  };
}

function validateRecords(records, heightAt) {
  if (!Array.isArray(records)) throw new TypeError('yard-life records must be an array');
  const ids = new Set();
  return records.map((record, index) => {
    const normalized = normalizeRecord(record, index, heightAt);
    if (ids.has(normalized.id)) throw new RangeError(`duplicate yard-life id ${normalized.id}`);
    ids.add(normalized.id);
    return normalized;
  });
}

function materialTextures(material) {
  const textures = [];
  for (const value of Object.values(material || {})) if (value?.isTexture) textures.push(value);
  return textures;
}

function createDerivedMaterials(materials) {
  const borrowed = {};
  const derived = {};
  try {
    for (const role of YARD_LIFE_MATERIAL_ROLES) {
      const source = materials?.[role];
      if (!source?.isMeshStandardMaterial) {
        throw new TypeError(`yard-life materials.${role} must be a MeshStandardMaterial`);
      }
      if (materialTextures(source).length) {
        throw new RangeError(`yard-life materials.${role} must not contain textures`);
      }
      borrowed[role] = source;
      const material = source.clone();
      material.name = `yard-life-${role}`;
      material.transparent = false;
      material.opacity = 1;
      material.depthTest = true;
      material.depthWrite = true;
      material.alphaHash = false;
      material.vertexColors = true;
      material.flatShading = true;
      material.userData = {
        ...source.userData,
        yardLifeRole: role,
        borrowedFromCaller: true,
      };
      patchInstFadeMaterial(material);
      material.needsUpdate = true;
      derived[role] = material;
    }
    return { borrowed, derived };
  } catch (error) {
    for (const material of Object.values(derived)) material.dispose();
    throw error;
  }
}

function matrix({
  x = 0,
  y = 0,
  z = 0,
  rx = 0,
  ry = 0,
  rz = 0,
  sx = 1,
  sy = 1,
  sz = 1,
} = {}) {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
    new THREE.Vector3(sx, sy, sz),
  );
}

function place(geometry, transform) {
  geometry.applyMatrix4(matrix(transform));
  return geometry;
}

function box(width, height, depth, transform = {}) {
  return place(
    new THREE.BoxGeometry(width, height, depth, 1, 1, 1),
    { y: height / 2, ...transform },
  );
}

function cylinder(radiusTop, radiusBottom, height, segments, transform = {}, openEnded = false) {
  return place(
    new THREE.CylinderGeometry(
      radiusTop,
      radiusBottom,
      height,
      segments,
      1,
      openEnded,
    ),
    { y: height / 2, ...transform },
  );
}

function torus(radius, tube, segments, transform = {}) {
  return place(
    new THREE.TorusGeometry(radius, tube, 4, segments),
    transform,
  );
}

function dodeca(radius, transform = {}) {
  return place(new THREE.DodecahedronGeometry(radius, 0), transform);
}

function circle(radius, segments, transform = {}) {
  return place(new THREE.CircleGeometry(radius, segments), transform);
}

function strawCoverGeometry() {
  const hx = 0.67;
  const hz = 0.34;
  const baseY = 0.43;
  const ridgeY = 0.62;
  const positions = [
    -hx, baseY, -hz,
    hx, baseY, -hz,
    hx, baseY, hz,
    -hx, baseY, hz,
    -hx, ridgeY, 0,
    hx, ridgeY, 0,
  ];
  const indices = [
    0, 4, 5, 0, 5, 1,
    4, 3, 2, 4, 2, 5,
    0, 4, 3,
    1, 2, 5,
  ];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function springGeometries(record, part) {
  if (part.kind === 'water-bowl') {
    return [
      cylinder(0.29, 0.24, 0.14, 10, { x: -0.25 }, true),
      circle(0.235, 10, { x: -0.25, y: 0.012, rx: -Math.PI / 2 }),
      torus(0.29, 0.025, 10, { x: -0.25, y: 0.14, rx: Math.PI / 2 }),
    ];
  }
  const geometries = [];
  for (let index = 0; index < part.count; index++) {
    const radius = part.count === 1 ? 0.2 : 0.18;
    const x = part.count === 1 ? 0.24 : 0.25;
    const z = part.count === 1 ? 0 : (index === 0 ? -0.18 : 0.18);
    const height = index === 0 ? 0.24 : 0.22;
    geometries.push(
      cylinder(radius * 1.05, radius * 0.82, height, 8, { x, z }, true),
      torus(radius * 1.05, 0.022, 8, { x, y: height, z, rx: Math.PI / 2 }),
    );
  }
  return geometries;
}

function autumnGeometries(record, part) {
  if (part.kind === 'threshing-bench') {
    const geometries = [];
    for (const z of [-0.16, 0, 0.16]) {
      geometries.push(cylinder(0.075, 0.075, 1.55, 7, {
        y: 0.46,
        z,
        rz: Math.PI / 2,
      }));
    }
    for (const x of [-0.58, 0.58]) {
      for (const z of [-0.16, 0.16]) {
        geometries.push(box(0.12, 0.42, 0.12, { x, z }));
      }
    }
    return geometries;
  }
  if (part.kind === 'threshing-stone') {
    return [dodeca(1, {
      y: 0.16,
      sx: 0.36,
      sy: 0.16,
      sz: 0.28,
    })];
  }
  if (part.kind === 'bound-sheaf') {
    const positions = [
      [-0.58, -0.22],
      [0.58, -0.2],
      [-0.48, 0.21],
      [0.48, 0.22],
    ];
    const geometries = [];
    for (let index = 0; index < part.count; index++) {
      const [x, z] = positions[index];
      const height = 0.78 + index * 0.045;
      const tieY = height * 0.55;
      geometries.push(
        cylinder(0.08, 0.13, tieY, 7, { x, z }),
        cylinder(0.18, 0.075, height - tieY, 7, {
          x,
          y: tieY + (height - tieY) / 2,
          z,
        }),
        torus(0.105, 0.018, 7, {
          x,
          y: tieY,
          z,
          rx: Math.PI / 2,
        }),
      );
    }
    return geometries;
  }
  return [circle(1, 12, {
    y: 0.012,
    rx: -Math.PI / 2,
    sx: 0.6,
    sy: 0.375,
  })];
}

function winterGeometries(record, part) {
  if (part.kind === 'stack-support') {
    return [
      cylinder(0.045, 0.045, 1.18, 7, {
        y: 0.045,
        z: -0.19,
        rz: Math.PI / 2,
      }),
      cylinder(0.045, 0.045, 1.18, 7, {
        y: 0.045,
        z: 0.19,
        rz: Math.PI / 2,
      }),
    ];
  }
  if (part.kind === 'split-log') {
    const geometries = [];
    const columns = 4;
    for (let index = 0; index < part.count; index++) {
      const layer = Math.floor(index / columns);
      const column = index % columns;
      const x = (column - 1.5) * 0.3 + (layer % 2 ? 0.045 : 0);
      const y = 0.15 + layer * 0.13;
      const z = index % 2 ? 0.012 : -0.012;
      const radius = 0.047 + (index % 3) * 0.004;
      geometries.push(cylinder(radius, radius * 0.88, 0.5, 7, {
        x,
        y,
        z,
        rx: Math.PI / 2,
      }));
    }
    return geometries;
  }
  return [strawCoverGeometry()];
}

function partGeometries(record, part) {
  if (record.season === 'spring') return springGeometries(record, part);
  if (record.season === 'autumn') return autumnGeometries(record, part);
  return winterGeometries(record, part);
}

function hashString(value) {
  let hash = 2166136261 >>> 0;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash;
}

function normalizeGeometry(source, record, part, primitiveIndex) {
  const geometry = source.index ? source.toNonIndexed() : source;
  if (geometry !== source) source.dispose();
  const transform = matrix({
    x: record.world.x,
    y: record.world.y,
    z: record.world.z,
    ry: record.world.yaw,
    sx: record.scale,
    sy: record.scale,
    sz: record.scale,
  });
  geometry.applyMatrix4(transform);
  if (!geometry.attributes.normal) geometry.computeVertexNormals();
  const count = geometry.attributes.position.count;
  if (!geometry.attributes.uv) {
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(count * 2), 2));
  }
  const tint = new Float32Array(count * 3);
  const seed = hashString(`${record.id}|${part.kind}|${primitiveIndex}`);
  for (let vertex = 0; vertex < count; vertex++) {
    const bits = Math.imul(seed ^ (vertex + 1), 2246822519) >>> 0;
    const value = 0.88 + (bits / 0xffffffff) * 0.18;
    tint[vertex * 3] = value;
    tint[vertex * 3 + 1] = value;
    tint[vertex * 3 + 2] = value;
  }
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(tint, 3));
  geometry.setAttribute('instFade', new THREE.Float32BufferAttribute(new Float32Array(count), 1));
  for (const name of Object.keys(geometry.attributes)) {
    if (name === 'position' || name === 'normal' || name === 'uv'
      || name === 'color' || name === 'instFade') continue;
    geometry.deleteAttribute(name);
  }
  geometry.morphAttributes = {};
  return geometry;
}

function createShadowMaterial(kind) {
  const material = kind === 'distance'
    ? new THREE.MeshDistanceMaterial()
    : new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  material.name = `yard-life-${kind}`;
  material.allowOverride = false;
  patchInstFadeMaterial(material);
  return material;
}

function disposeBatches(batches) {
  for (const batch of batches) batch.geometry.dispose();
}

function recordBoundsFromBatches(batches, records) {
  const bounds = records.map((record) => ({
    id: record.id,
    minX: Infinity,
    maxX: -Infinity,
    minZ: Infinity,
    maxZ: -Infinity,
    halfX: record.footprint.halfX,
    halfZ: record.footprint.halfZ,
  }));
  for (const batch of batches) {
    const positions = batch.geometry.attributes.position.array;
    for (const range of batch.ranges) {
      const record = records[range.recordIndex];
      const result = bounds[range.recordIndex];
      const cosine = Math.cos(record.world.yaw);
      const sine = Math.sin(record.world.yaw);
      const end = range.start + range.count;
      for (let vertex = range.start; vertex < end; vertex++) {
        const offset = vertex * 3;
        const dx = positions[offset] - record.world.x;
        const dz = positions[offset + 2] - record.world.z;
        const localX = cosine * dx - sine * dz;
        const localZ = sine * dx + cosine * dz;
        result.minX = Math.min(result.minX, localX);
        result.maxX = Math.max(result.maxX, localX);
        result.minZ = Math.min(result.minZ, localZ);
        result.maxZ = Math.max(result.maxZ, localZ);
      }
    }
  }
  for (const result of bounds) {
    if (result.minX < -result.halfX - BOUNDS_EPSILON
      || result.maxX > result.halfX + BOUNDS_EPSILON
      || result.minZ < -result.halfZ - BOUNDS_EPSILON
      || result.maxZ > result.halfZ + BOUNDS_EPSILON) {
      throw new RangeError(`yard-life geometry escaped planned footprint for ${result.id}`);
    }
  }
  return bounds;
}

function createBatches(records, derivedMaterials, depthMaterial, distanceMaterial) {
  const byRole = new Map(YARD_LIFE_MATERIAL_ROLES.map((role) => [role, []]));
  const batches = [];
  try {
    for (let recordIndex = 0; recordIndex < records.length; recordIndex++) {
      const record = records[recordIndex];
      for (let partIndex = 0; partIndex < record.parts.length; partIndex++) {
        const part = record.parts[partIndex];
        const geometries = partGeometries(record, part);
        for (let primitiveIndex = 0; primitiveIndex < geometries.length; primitiveIndex++) {
          byRole.get(part.materialRole).push({
            geometry: normalizeGeometry(
              geometries[primitiveIndex],
              record,
              part,
              partIndex * 32 + primitiveIndex,
            ),
            recordIndex,
          });
        }
      }
    }

    for (const role of YARD_LIFE_MATERIAL_ROLES) {
      const entries = byRole.get(role);
      if (!entries.length) continue;
      let cursor = 0;
      const ranges = [];
      for (const entry of entries) {
        const count = entry.geometry.attributes.position.count;
        ranges.push({ recordIndex: entry.recordIndex, start: cursor, count });
        cursor += count;
      }
      const sourceGeometries = entries.map((entry) => entry.geometry);
      byRole.set(role, []);
      const geometry = mergeOwnedGeometries(
        sourceGeometries,
        `Yard-life ${role} geometries`,
      );
      const mesh = new THREE.Mesh(geometry, derivedMaterials[role]);
      mesh.name = `yard-life-${role}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.customDepthMaterial = depthMaterial;
      mesh.customDistanceMaterial = distanceMaterial;
      mesh.userData.dofDepthMaterial = depthMaterial;
      batches.push({ role, mesh, geometry, ranges });
    }
    const bounds = recordBoundsFromBatches(batches, records);
    return { batches, bounds };
  } catch (error) {
    disposeBatches(batches);
    for (const entries of byRole.values()) {
      for (const entry of entries) entry.geometry.dispose();
    }
    throw error;
  }
}

/**
 * Build a stable, role-batched yard-life controller.
 *
 * The input materials are borrowed. The controller clones them once to install
 * vertex-color and opaque screen-door presentation without mutating a material
 * that the caller may also use on meshes lacking `instFade`.
 */
export function buildYardLife(records, {
  materials,
  heightAt,
  season = 'summer',
  weather = 'clear',
  transitionSeconds = 0.9,
} = {}) {
  if (!YARD_LIFE_SEASONS.includes(season)) throw new RangeError(`unsupported yard-life season ${season}`);
  if (!YARD_LIFE_WEATHER.includes(weather)) throw new RangeError(`unsupported yard-life weather ${weather}`);
  const defaultDuration = Math.max(0, finite(transitionSeconds, 'yard-life transitionSeconds'));
  const { borrowed, derived } = createDerivedMaterials(materials);
  const depthMaterial = createShadowMaterial('depth');
  const distanceMaterial = createShadowMaterial('distance');
  const group = new THREE.Group();
  group.name = 'village-yard-life';

  let normalizedRecords;
  let batches = [];
  let recordBounds = [];
  let disposed = false;
  let waveWeight = 1;
  let currentSeason = season;
  let currentWeather = weather;
  let rebuildCount = 0;
  let updateCount = 0;
  let skippedUpdates = 0;
  let lastDetail = null;
  let lastWeightAt = null;

  let seasonState;
  let weatherState;
  let detailWeights;
  let presentationWeights;

  function makeTransitionState(length, name) {
    return {
      name,
      from: new Float32Array(length),
      current: new Float32Array(length),
      target: new Float32Array(length),
      elapsed: 0,
      duration: defaultDuration,
      active: false,
    };
  }

  function seasonTarget(record) {
    return record.season === currentSeason ? 1 : 0;
  }

  function weatherTarget(record) {
    return record.weather.has(currentWeather) ? 1 : 0;
  }

  function initializeStates(nextRecords) {
    const length = nextRecords.length;
    seasonState = makeTransitionState(length, currentSeason);
    weatherState = makeTransitionState(length, currentWeather);
    detailWeights = new Float32Array(length);
    presentationWeights = new Float32Array(length);
    detailWeights.fill(1);
    for (let index = 0; index < length; index++) {
      const seasonValue = seasonTarget(nextRecords[index]);
      const weatherValue = weatherTarget(nextRecords[index]);
      seasonState.current[index] = seasonState.target[index] = seasonValue;
      weatherState.current[index] = weatherState.target[index] = weatherValue;
    }
  }

  function applyPresentation() {
    if (disposed) return false;
    let anyVisible = false;
    for (let index = 0; index < normalizedRecords.length; index++) {
      const value = clamp01(
        seasonState.current[index]
        * weatherState.current[index]
        * detailWeights[index]
        * waveWeight,
      );
      presentationWeights[index] = value;
      if (value > LOD_EPSILON) anyVisible = true;
    }

    let visibilityChanged = group.visible !== anyVisible;
    group.visible = anyVisible;
    for (const batch of batches) {
      const attribute = batch.geometry.attributes.instFade;
      const array = attribute.array;
      let dirty = false;
      for (const range of batch.ranges) {
        const value = presentationWeights[range.recordIndex];
        const end = range.start + range.count;
        if (array[range.start] === value) continue;
        array.fill(value, range.start, end);
        dirty = true;
      }
      if (dirty) attribute.needsUpdate = true;
      // Keep every stable role batch eligible whenever the layer is awake. The
      // zero-coverage records still discard before depth/color, while the product
      // subtree prewarm sees every future seasonal material before a transition.
      // Aerial sleep happens at the parent, so distant scenes submit zero draws.
      batch.mesh.visible = true;
    }
    return visibilityChanged;
  }

  function installRecords(nextRecords, nextHeightAt) {
    const validated = validateRecords(nextRecords, nextHeightAt);
    const next = createBatches(validated, derived, depthMaterial, distanceMaterial);
    const previous = batches;
    for (const batch of previous) group.remove(batch.mesh);
    batches = next.batches;
    normalizedRecords = validated;
    recordBounds = next.bounds;
    initializeStates(validated);
    for (const batch of batches) group.add(batch.mesh);
    disposeBatches(previous);
    if (lastDetail || lastWeightAt) api.updateLod(null, lastDetail, lastWeightAt);
    else applyPresentation();
  }

  function beginTransition(state, targetForRecord, {
    immediate = false,
    duration = defaultDuration,
  } = {}) {
    const nextDuration = Math.max(0, finite(duration, 'yard-life transition duration'));
    state.from.set(state.current);
    let changed = false;
    for (let index = 0; index < normalizedRecords.length; index++) {
      const target = targetForRecord(normalizedRecords[index]);
      state.target[index] = target;
      if (Math.abs(state.current[index] - target) > 1e-6) changed = true;
    }
    state.elapsed = 0;
    state.duration = nextDuration;
    state.active = changed && !immediate && nextDuration > 0;
    if (!state.active) state.current.set(state.target);
    return changed;
  }

  function advanceTransition(state, dt) {
    if (!state.active) return false;
    state.elapsed = Math.min(state.duration, state.elapsed + dt);
    const linear = state.duration > 0 ? state.elapsed / state.duration : 1;
    const eased = linear * linear * (3 - 2 * linear);
    for (let index = 0; index < state.current.length; index++) {
      state.current[index] = THREE.MathUtils.lerp(
        state.from[index],
        state.target[index],
        eased,
      );
    }
    if (linear >= 1) {
      state.current.set(state.target);
      state.active = false;
    }
    return true;
  }

  const api = {
    group,
    setSeason(name, opts = {}) {
      if (disposed) return false;
      if (!YARD_LIFE_SEASONS.includes(name)) throw new RangeError(`unsupported yard-life season ${name}`);
      currentSeason = name;
      seasonState.name = name;
      const changed = beginTransition(seasonState, seasonTarget, opts);
      applyPresentation();
      return changed;
    },
    setWeather(name, opts = {}) {
      if (disposed) return false;
      if (!YARD_LIFE_WEATHER.includes(name)) throw new RangeError(`unsupported yard-life weather ${name}`);
      currentWeather = name;
      weatherState.name = name;
      const changed = beginTransition(weatherState, weatherTarget, opts);
      applyPresentation();
      return changed;
    },
    update(dt) {
      if (disposed) return false;
      const delta = Math.max(0, Math.min(0.25, Number.isFinite(dt) ? dt : 0));
      const seasonChanged = advanceTransition(seasonState, delta);
      const weatherChanged = advanceTransition(weatherState, delta);
      const changed = seasonChanged || weatherChanged;
      if (!changed) {
        skippedUpdates++;
        return false;
      }
      updateCount++;
      applyPresentation();
      return true;
    },
    updateLod(_camera, detail = null, weightAt = null) {
      if (disposed) return false;
      lastDetail = detail;
      lastWeightAt = typeof weightAt === 'function' ? weightAt : null;
      const allowed = detail?.groundActive !== false;
      const fallback = allowed ? clamp01(detail?.groundWeight ?? 1) : 0;
      let weightChanged = false;
      for (let index = 0; index < normalizedRecords.length; index++) {
        const record = normalizedRecords[index];
        const resolved = allowed && lastWeightAt
          ? lastWeightAt(record.world)
          : fallback;
        const nextWeight = clamp01(resolved);
        if (Math.abs(detailWeights[index] - nextWeight) > 1e-6) weightChanged = true;
        detailWeights[index] = nextWeight;
      }
      const visibilityChanged = applyPresentation();
      return weightChanged || visibilityChanged;
    },
    setWaveFade(value) {
      if (disposed) return false;
      waveWeight = clamp01(value);
      return applyPresentation();
    },
    rebuild(nextRecords, { heightAt: nextHeightAt = heightAt } = {}) {
      if (disposed) return false;
      installRecords(nextRecords, nextHeightAt);
      rebuildCount++;
      return true;
    },
    debug() {
      let triangles = 0;
      let activeRecords = 0;
      for (const batch of batches) {
        triangles += batch.geometry.attributes.position.count / 3;
      }
      for (const value of presentationWeights) if (value > LOD_EPSILON) activeRecords++;
      return {
        disposed,
        season: currentSeason,
        weather: currentWeather,
        transitioning: seasonState.active || weatherState.active,
        seasonTransitioning: seasonState.active,
        weatherTransitioning: weatherState.active,
        waveWeight,
        recordCount: normalizedRecords.length,
        activeRecords,
        allocatedDrawCalls: batches.length,
        submittedDrawCalls: batches.filter((batch) => batch.mesh.visible && group.visible).length,
        triangles,
        textures: 0,
        resources: {
          geometries: disposed ? 0 : batches.length,
          derivedMaterials: disposed ? 0 : Object.keys(derived).length + 2,
          borrowedMaterials: Object.keys(borrowed).length,
        },
        materialRoles: batches.map((batch) => batch.role),
        records: normalizedRecords.map((record) => ({
          id: record.id,
          owner: { parcelId: record.ownerId },
          motif: record.motif,
          season: record.season,
          variant: record.variant,
          world: { ...record.world },
          footprint: {
            shape: 'rect',
            halfX: record.footprint.halfX,
            halfZ: record.footprint.halfZ,
            yaw: Number.isFinite(record.source.footprint?.yaw)
              ? record.source.footprint.yaw
              : record.world.yaw,
          },
        })),
        recordBounds: recordBounds.map((bounds) => ({ ...bounds })),
        weights: [...presentationWeights],
        rebuildCount,
        updateCount,
        skippedUpdates,
      };
    },
    dispose() {
      if (disposed) return false;
      disposed = true;
      disposeBatches(batches);
      batches = [];
      group.clear();
      for (const material of Object.values(derived)) material.dispose();
      depthMaterial.dispose();
      distanceMaterial.dispose();
      group.userData.waveFade = null;
      group.userData.yardLife = null;
      group.visible = false;
      return true;
    },
  };

  group.userData.waveFade = { setWeight: (value) => api.setWaveFade(value) };
  group.userData.yardLife = api;
  try {
    installRecords(records, heightAt);
    api.setSeason(season, { immediate: true });
    api.setWeather(weather, { immediate: true });
  } catch (error) {
    api.dispose();
    throw error;
  }
  return api;
}

export function disposeYardLife(handle) {
  return handle?.dispose?.() === true;
}
