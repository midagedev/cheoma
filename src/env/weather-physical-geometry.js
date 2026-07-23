import * as THREE from 'three';
import { makeRng } from '../rng.js';

const TAU = Math.PI * 2;
const DEFAULT_HALF = 46;
const DEFAULT_BOTTOM = -1;

export const WEATHER_PARTICLE_SEED = 0x5e450;
export const SNOW_PARTICLE_COUNT = 3600;
export const RAIN_PARTICLE_COUNT = 2600;

function finite(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function centerSpread(value) {
  return Math.min(3, Math.max(1, finite(value, 1)));
}

function disposeOwned(...resources) {
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    for (const resource of resources) resource.dispose();
  };
}

function wrap(value, half) {
  const span = half * 2;
  if (value > half) return value - span;
  if (value < -half) return value + span;
  return value;
}

// A deterministic respawn hash keeps the simulation reproducible without allocating
// a second RNG stream or reaching for global Math.random() after setup.
function respawnUnit(index, generation, salt) {
  let value = Math.imul((index + 1) ^ salt, 0x45d9f3b);
  value = Math.imul(value ^ (value >>> 16) ^ generation, 0x45d9f3b);
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967296;
}

function ownsState(kind, count, half, bottom, top, positions) {
  return {
    kind,
    count,
    half,
    bottom,
    top,
    height: top - bottom,
    positions,
    generations: new Uint32Array(count),
  };
}

export function createSnowPrecipitationState({
  seed = WEATHER_PARTICLE_SEED ^ 0x1111,
  count = SNOW_PARTICLE_COUNT,
  half = DEFAULT_HALF,
  bottom = DEFAULT_BOTTOM,
  top = 54,
} = {}) {
  const rng = makeRng(seed);
  const positions = new Float32Array(count * 3);
  const state = ownsState('snow', count, half, bottom, top, positions);
  state.seed = seed >>> 0;
  state.baseX = new Float32Array(count);
  state.baseZ = new Float32Array(count);
  state.speeds = new Float32Array(count);
  state.phases = new Float32Array(count);
  state.sways = new Float32Array(count);
  state.sizes = new Float32Array(count);
  state.opacities = new Float32Array(count);

  for (let index = 0; index < count; index++) {
    const offset = index * 3;
    state.baseX[index] = (rng() * 2 - 1) * half;
    state.baseZ[index] = (rng() * 2 - 1) * half;
    positions[offset + 1] = bottom + rng() * state.height;
    state.speeds[index] = rng.range(2.4, 6);
    state.phases[index] = rng() * TAU;
    state.sways[index] = rng.range(0.3, 1.1);
    state.sizes[index] = rng.range(1.1, 2.7);
    state.opacities[index] = rng.range(0.45, 1);
    positions[offset] = state.baseX[index];
    positions[offset + 2] = state.baseZ[index];
  }
  return state;
}

export function createRainPrecipitationState({
  seed = WEATHER_PARTICLE_SEED ^ 0x2222,
  count = RAIN_PARTICLE_COUNT,
  half = DEFAULT_HALF,
  bottom = DEFAULT_BOTTOM,
  top = 54,
} = {}) {
  const rng = makeRng(seed);
  const positions = new Float32Array(count * 3);
  const state = ownsState('rain', count, half, bottom, top, positions);
  state.seed = seed >>> 0;
  state.speeds = new Float32Array(count);
  state.lengths = new Float32Array(count);
  state.opacities = new Float32Array(count);
  state.leanX = 0.14;
  state.leanZ = 0.05;

  for (let index = 0; index < count; index++) {
    const offset = index * 3;
    positions[offset] = (rng() * 2 - 1) * half;
    // Preserve the historical x,z,y,speed,length RNG consumption exactly.
    // Opacity derives from a hash, so visual metadata never moves the trajectory stream.
    positions[offset + 2] = (rng() * 2 - 1) * half;
    positions[offset + 1] = bottom + rng() * state.height;
    state.speeds[index] = rng.range(30, 46);
    state.lengths[index] = rng.range(1.4, 2.6);
    state.opacities[index] = 0.72 + respawnUnit(index, 0, 0xa53d) * 0.28;
  }
  return state;
}

function hitsRoof(x, y, z, colliders) {
  for (let index = 0; index < colliders.length; index++) {
    const box = colliders[index];
    if (
      x >= box.min.x && x <= box.max.x
      && z >= box.min.z && z <= box.max.z
      && y >= box.min.y && y <= box.max.y
    ) return true;
  }
  return false;
}

export function advanceSnowPrecipitation(state, {
  dt,
  time,
  wind,
  centerX = 0,
  centerZ = 0,
  roofColliders = [],
  collide = true,
  top = state.top,
} = {}) {
  const step = Math.max(0, finite(dt, 0));
  const now = finite(time, 0);
  const wx = finite(wind?.dirX, 0) * finite(wind?.speed, 0);
  const wz = finite(wind?.dirZ, 0) * finite(wind?.speed, 0);
  const windSpeed = Math.max(0, finite(wind?.speed, 0));
  const gust = Math.max(0, finite(wind?.gust, 0));
  const swirl = 1 + gust * 2.6;
  const fall = 0.85 + 0.15 * (1 - Math.min(1, windSpeed));
  const positions = state.positions;
  const half = state.half;

  for (let index = 0; index < state.count; index++) {
    const offset = index * 3;
    let y = positions[offset + 1] - state.speeds[index] * fall * step;
    const hit = collide && hitsRoof(
      positions[offset] + centerX,
      y,
      positions[offset + 2] + centerZ,
      roofColliders,
    );

    if (hit) {
      const generation = ++state.generations[index];
      y = top - respawnUnit(index, generation, 0x31f7) * 4;
      state.baseX[index] = (respawnUnit(index, generation, 0x8843) * 2 - 1) * half;
      state.baseZ[index] = (respawnUnit(index, generation, 0x19db) * 2 - 1) * half;
    } else if (y < state.bottom) {
      y += state.height;
    }

    state.baseX[index] = wrap(state.baseX[index] + wx * 7 * step, half);
    state.baseZ[index] = wrap(state.baseZ[index] + wz * 7 * step, half);
    positions[offset] = state.baseX[index]
      + Math.sin(now * 0.6 + state.phases[index]) * state.sways[index] * swirl
      + Math.sin(now * 1.9 + state.phases[index] * 2.1) * 0.6 * gust;
    positions[offset + 1] = y;
    positions[offset + 2] = state.baseZ[index]
      + Math.cos(now * 0.45 + state.phases[index]) * state.sways[index] * 0.6 * swirl;
  }
}

export function advanceRainPrecipitation(state, {
  dt,
  wind,
  centerX = 0,
  centerZ = 0,
  roofColliders = [],
  collide = true,
  top = state.top,
} = {}) {
  const step = Math.max(0, finite(dt, 0));
  const wx = finite(wind?.dirX, 0) * finite(wind?.speed, 0);
  const wz = finite(wind?.dirZ, 0) * finite(wind?.speed, 0);
  state.leanX = wx * 3.4 / 38;
  state.leanZ = wz * 3.4 / 38;
  const driftX = wx * 6.5;
  const driftZ = wz * 6.5;
  const positions = state.positions;
  const half = state.half;

  for (let index = 0; index < state.count; index++) {
    const offset = index * 3;
    let x = positions[offset] + driftX * step;
    let y = positions[offset + 1] - state.speeds[index] * step;
    let z = positions[offset + 2] + driftZ * step;
    const hit = collide && hitsRoof(x + centerX, y, z + centerZ, roofColliders);

    if (hit) {
      const generation = ++state.generations[index];
      y = top - respawnUnit(index, generation, 0x7723) * 4;
      x = (respawnUnit(index, generation, 0x91b5) * 2 - 1) * half;
      z = (respawnUnit(index, generation, 0x2eb7) * 2 - 1) * half;
    } else if (y < state.bottom) {
      y += state.height;
    }

    positions[offset] = wrap(x, half);
    positions[offset + 1] = y;
    positions[offset + 2] = wrap(z, half);
  }
}

function copyBaseGeometry(base, count) {
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.index = base.index;
  // The custom materials consume only position. Carrying generated normal/uv buffers
  // would spend geometry memory without changing the result.
  geometry.setAttribute('position', base.getAttribute('position'));
  geometry.instanceCount = count;
  return geometry;
}

function createCrossedFlakeGeometry() {
  const positions = new Float32Array([
    -0.5, 0, 0, 0, 0.82, 0, 0.5, 0, 0,
    -0.5, 0, 0, 0, -0.82, 0, 0.5, 0, 0,
    0, 0, -0.5, 0, 0.82, 0, 0, 0, 0.5,
    0, 0, -0.5, 0, -0.82, 0, 0, 0, 0.5,
    -0.5, 0, 0, 0, 0, -0.5, 0.5, 0, 0,
    -0.5, 0, 0, 0, 0, 0.5, 0.5, 0, 0,
  ]);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  return geometry;
}

const PHYSICAL_SNOW_VERTEX = `
  attribute vec3 aCenter;
  attribute float aSize;
  attribute float aOpacity;
  attribute float aPhase;
  uniform float uTime;
  uniform float uWorldScale;
  uniform float uCenterSpread;
  varying float vOpacity;
  mat3 rotX(float a) {
    float c = cos(a), s = sin(a);
    return mat3(1.0,0.0,0.0, 0.0,c,s, 0.0,-s,c);
  }
  mat3 rotY(float a) {
    float c = cos(a), s = sin(a);
    return mat3(c,0.0,-s, 0.0,1.0,0.0, s,0.0,c);
  }
  void main() {
    float turn = aPhase + uTime * (0.32 + 0.11 * sin(aPhase));
    float tumble = aPhase * 0.73 + uTime * 0.21;
    vec3 local = rotY(turn) * rotX(tumble) * position * (aSize * uWorldScale);
    vec3 center = vec3(aCenter.x * uCenterSpread, aCenter.y, aCenter.z * uCenterSpread);
    vec4 world = modelMatrix * vec4(center + local, 1.0);
    gl_Position = projectionMatrix * viewMatrix * world;
    vOpacity = aOpacity;
  }`;

const PHYSICAL_RAIN_VERTEX = `
  attribute vec3 aCenter;
  attribute float aLength;
  attribute float aOpacity;
  uniform vec2 uLean;
  uniform float uRadius;
  uniform float uCenterSpread;
  varying float vOpacity;
  void main() {
    vec3 axis = normalize(vec3(-uLean.x, -1.0, -uLean.y));
    vec3 tangent = normalize(cross(
      abs(axis.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0),
      axis
    ));
    vec3 bitangent = cross(axis, tangent);
    vec3 local = tangent * position.x * uRadius
      + axis * position.y * aLength
      + bitangent * position.z * uRadius;
    vec3 center = vec3(aCenter.x * uCenterSpread, aCenter.y, aCenter.z * uCenterSpread);
    vec4 world = modelMatrix * vec4(center + local, 1.0);
    gl_Position = projectionMatrix * viewMatrix * world;
    vOpacity = aOpacity;
  }`;

const PHYSICAL_DEPTH_FRAGMENT = `
  #include <packing>
  uniform float uFade;
  float weatherDepthHash(vec2 point) {
    return fract(52.9829189 * fract(dot(point, vec2(0.06711056, 0.00583715))));
  }
  void main() {
    // Match transition coverage with a stable screen door instead of turning a
    // translucent fade into one opaque packed-depth plate. At FULL weight every
    // real flake/streak triangle owns its exact depth.
    if (weatherDepthHash(gl_FragCoord.xy) > clamp(uFade, 0.0, 1.0)) discard;
    gl_FragColor = packDepthToRGBA(gl_FragCoord.z);
  }`;

function createPhysicalDepthMaterial(uniforms, vertexShader, name) {
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader,
    fragmentShader: PHYSICAL_DEPTH_FRAGMENT,
    depthTest: true,
    depthWrite: true,
    blending: THREE.NoBlending,
    side: THREE.DoubleSide,
  });
  material.allowOverride = false;
  material.name = name;
  return material;
}

function physicalSnowMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uFade: { value: 0 },
      uTime: { value: 0 },
      // 1.3–3.2cm across for the product's 1.1–2.7 size range. Close flakes
      // grow by projection instead of a camera-facing pixel-size floor.
      uWorldScale: { value: 0.012 },
      uCenterSpread: { value: 1 },
    },
    transparent: true,
    depthTest: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    vertexShader: PHYSICAL_SNOW_VERTEX,
    fragmentShader: `
      uniform float uFade;
      varying float vOpacity;
      void main() {
        float alpha = 0.72 * uFade * vOpacity;
        if (alpha < 0.01) discard;
        gl_FragColor = vec4(0.96, 0.985, 1.0, alpha);
      }`,
  });
}

export function createPhysicalSnowRepresentation(state) {
  const base = createCrossedFlakeGeometry();
  const geometry = copyBaseGeometry(base, state.count);
  base.dispose();
  const center = new THREE.InstancedBufferAttribute(state.positions, 3);
  geometry.setAttribute('aCenter', center);
  geometry.setAttribute('aSize', new THREE.InstancedBufferAttribute(state.sizes, 1));
  geometry.setAttribute('aOpacity', new THREE.InstancedBufferAttribute(state.opacities, 1));
  geometry.setAttribute('aPhase', new THREE.InstancedBufferAttribute(state.phases, 1));
  const material = physicalSnowMaterial();
  const depthMaterial = createPhysicalDepthMaterial(
    material.uniforms,
    PHYSICAL_SNOW_VERTEX,
    'weather-snow-physical-dof-depth',
  );
  const object = new THREE.Mesh(geometry, material);
  object.name = 'weatherSnowPhysical';
  object.frustumCulled = false;
  object.renderOrder = 20;
  object.visible = false;
  object.userData.dofDepthMaterial = depthMaterial;

  return {
    kind: 'snow-physical',
    object,
    sourcePositions: state.positions,
    triangles: 6 * state.count,
    sync({ level = 1, time = 0 } = {}) {
      center.needsUpdate = true;
      material.uniforms.uFade.value = level;
      material.uniforms.uTime.value = time;
    },
    setLens() {},
    setCenterSpread(value = 1) {
      material.uniforms.uCenterSpread.value = centerSpread(value);
    },
    get centerSpread() { return material.uniforms.uCenterSpread.value; },
    dispose: disposeOwned(geometry, material, depthMaterial),
  };
}

function physicalRainMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uFade: { value: 0 },
      uLean: { value: new THREE.Vector2() },
      // An 8mm triangular volume is already a generous visual upper bound for rain.
      uRadius: { value: 0.004 },
      uCenterSpread: { value: 1 },
    },
    transparent: true,
    depthTest: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    vertexShader: PHYSICAL_RAIN_VERTEX,
    fragmentShader: `
      uniform float uFade;
      varying float vOpacity;
      void main() {
        float alpha = 0.26 * uFade * vOpacity;
        if (alpha < 0.01) discard;
        gl_FragColor = vec4(0.67, 0.78, 0.9, alpha);
      }`,
  });
}

export function createPhysicalRainRepresentation(state) {
  const base = new THREE.CylinderGeometry(1, 1, 1, 3, 1, false);
  const geometry = copyBaseGeometry(base, state.count);
  base.dispose();
  const center = new THREE.InstancedBufferAttribute(state.positions, 3);
  geometry.setAttribute('aCenter', center);
  geometry.setAttribute('aLength', new THREE.InstancedBufferAttribute(state.lengths, 1));
  geometry.setAttribute('aOpacity', new THREE.InstancedBufferAttribute(state.opacities, 1));
  const material = physicalRainMaterial();
  const depthMaterial = createPhysicalDepthMaterial(
    material.uniforms,
    PHYSICAL_RAIN_VERTEX,
    'weather-rain-physical-dof-depth',
  );
  const object = new THREE.Mesh(geometry, material);
  object.name = 'weatherRainPhysical';
  object.frustumCulled = false;
  object.renderOrder = 21;
  object.visible = false;
  object.userData.dofDepthMaterial = depthMaterial;

  return {
    kind: 'rain-physical',
    object,
    sourcePositions: state.positions,
    triangles: 12 * state.count,
    sync({ level = 1 } = {}) {
      center.needsUpdate = true;
      material.uniforms.uFade.value = level;
      material.uniforms.uLean.value.set(state.leanX, state.leanZ);
    },
    setLens() {},
    setCenterSpread(value = 1) {
      material.uniforms.uCenterSpread.value = centerSpread(value);
    },
    get centerSpread() { return material.uniforms.uCenterSpread.value; },
    dispose: disposeOwned(geometry, material, depthMaterial),
  };
}

export function precipitationStateBytes(state) {
  let bytes = 0;
  for (const value of Object.values(state)) {
    if (ArrayBuffer.isView(value)) bytes += value.byteLength;
  }
  return bytes;
}

export function representationAttributeBytes(representation) {
  const geometry = representation.object.geometry;
  const arrays = new Set();
  let bytes = 0;
  for (const attribute of Object.values(geometry.attributes)) {
    const array = attribute?.array;
    if (!array || arrays.has(array)) continue;
    arrays.add(array);
    bytes += array.byteLength;
  }
  if (geometry.index?.array && !arrays.has(geometry.index.array)) {
    bytes += geometry.index.array.byteLength;
  }
  return bytes;
}
