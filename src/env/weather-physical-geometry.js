import * as THREE from 'three';

function disposeOwned(...resources) {
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    for (const resource of resources) resource.dispose();
  };
}

function disposeRepresentation(object, ...resources) {
  const disposeResources = disposeOwned(...resources);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    object.visible = false;
    object.removeFromParent();
    delete object.userData.dofDepthMaterial;
    disposeResources();
  };
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
    -0.304878, 0, 0, 0, 0.5, 0, 0.304878, 0, 0,
    -0.304878, 0, 0, 0, -0.5, 0, 0.304878, 0, 0,
    0, 0, -0.304878, 0, 0.5, 0, 0, 0, 0.304878,
    0, 0, -0.304878, 0, -0.5, 0, 0, 0, 0.304878,
    -0.304878, 0, 0, 0, 0, -0.304878, 0.304878, 0, 0,
    -0.304878, 0, 0, 0, 0, 0.304878, 0.304878, 0, 0,
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
    vec4 world = modelMatrix * vec4(aCenter + local, 1.0);
    gl_Position = projectionMatrix * viewMatrix * world;
    vOpacity = aOpacity;
  }`;

const PHYSICAL_RAIN_VERTEX = `
  attribute vec3 aCenter;
  attribute float aLength;
  attribute float aOpacity;
  uniform vec2 uLean;
  uniform float uRadius;
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
    vec4 world = modelMatrix * vec4(aCenter + local, 1.0);
    gl_Position = projectionMatrix * viewMatrix * world;
    vOpacity = aOpacity;
  }`;

const PHYSICAL_DEPTH_FRAGMENT = `
  #include <packing>
  uniform float uFade;
  uniform float uAlphaScale;
  varying float vOpacity;
  float weatherDepthHash(vec2 point) {
    return fract(52.9829189 * fract(dot(point, vec2(0.06711056, 0.00583715))));
  }
  void main() {
    // Match transition coverage with a stable screen door instead of turning a
    // translucent fade into one opaque packed-depth plate. At FULL weight every
    // real flake/streak triangle owns its exact depth.
    float coverage = clamp(uFade * uAlphaScale * vOpacity, 0.0, 1.0);
    if (weatherDepthHash(gl_FragCoord.xy) > coverage) discard;
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
      uAlphaScale: { value: 0.72 },
    },
    transparent: true,
    depthTest: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    vertexShader: PHYSICAL_SNOW_VERTEX,
    fragmentShader: `
      uniform float uFade;
      uniform float uAlphaScale;
      varying float vOpacity;
      void main() {
        float alpha = uAlphaScale * uFade * vOpacity;
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
    dispose: disposeRepresentation(object, geometry, material, depthMaterial),
  };
}

function physicalRainMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uFade: { value: 0 },
      uLean: { value: new THREE.Vector2() },
      // An 8mm triangular volume is already a generous visual upper bound for rain.
      uRadius: { value: 0.004 },
      uAlphaScale: { value: 0.26 },
    },
    transparent: true,
    depthTest: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    vertexShader: PHYSICAL_RAIN_VERTEX,
    fragmentShader: `
      uniform float uFade;
      uniform float uAlphaScale;
      varying float vOpacity;
      void main() {
        float alpha = uAlphaScale * uFade * vOpacity;
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
    dispose: disposeRepresentation(object, geometry, material, depthMaterial),
  };
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
