import * as THREE from 'three';

// Close-detail particle candidates for issue #96.
//
// Point and world representations intentionally wrap the same TypedArrays. The
// simulation owns each array once; these views only describe how WebGL reads it.

function sharedInstanceAttribute(attribute) {
  const view = new THREE.InstancedBufferAttribute(
    attribute.array,
    attribute.itemSize,
    attribute.normalized,
  );
  view.setUsage(attribute.usage);
  return view;
}

function attributeBytes(attributes) {
  const arrays = new Set();
  let bytes = 0;
  for (const attribute of Object.values(attributes)) {
    if (!attribute?.array || arrays.has(attribute.array)) continue;
    arrays.add(attribute.array);
    bytes += attribute.array.byteLength;
  }
  return bytes;
}

function baseGeometryBytes(geometry) {
  let bytes = geometry.index?.array?.byteLength || 0;
  const arrays = new Set();
  for (const attribute of Object.values(geometry.attributes)) {
    if (!attribute?.array || attribute.isInstancedBufferAttribute || arrays.has(attribute.array)) continue;
    arrays.add(attribute.array);
    bytes += attribute.array.byteLength;
  }
  return bytes;
}

function bindOwnedDepthMaterial(material, depthMaterial) {
  const disposeColor = material.dispose.bind(material);
  let disposed = false;
  material.dispose = () => {
    if (disposed) return;
    disposed = true;
    depthMaterial.dispose();
    disposeColor();
  };
}

function makePetalBaseGeometry() {
  // Four triangles around a raised centre form a shallow, light-catching saddle.
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0, 0.16,
    0, 1, 0,
    0.62, 0.05, -0.08,
    0, -1, 0.02,
    -0.62, 0.05, -0.08,
  ], 3));
  geometry.setIndex([0, 1, 2, 0, 2, 3, 0, 3, 4, 0, 4, 1]);
  geometry.computeVertexNormals();
  return geometry;
}

function makeOctahedronBaseGeometry() {
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    1, 0, 0, -1, 0, 0,
    0, 1, 0, 0, -1, 0,
    0, 0, 1, 0, 0, -1,
  ], 3));
  geometry.setIndex([
    0, 2, 4, 4, 2, 1, 1, 2, 5, 5, 2, 0,
    0, 4, 3, 4, 1, 3, 1, 5, 3, 5, 0, 3,
  ]);
  geometry.computeVertexNormals();
  return geometry;
}

const ROTATE_GLSL = /* glsl */`
vec3 rotateXYZ(vec3 p, vec3 a) {
  vec3 s = sin(a), c = cos(a);
  p.yz = mat2(c.x, -s.x, s.x, c.x) * p.yz;
  p.xz = mat2(c.y, s.y, -s.y, c.y) * p.xz;
  p.xy = mat2(c.z, -s.z, s.z, c.z) * p.xy;
  return p;
}
`;

export function createPetalWorldRepresentation(pointGeometry, {
  renderOrder = 18,
  // aSize is an artistic scalar, not metres. Species scaling maps the current
  // ranges to ~1.9–4.0cm spring petals and ~5.7–12cm autumn leaves end-to-end.
  worldScale = 0.015,
} = {}) {
  const geometry = makePetalBaseGeometry();
  const source = pointGeometry.attributes;
  geometry.setAttribute('aOffset', sharedInstanceAttribute(source.position));
  geometry.setAttribute('aSize', sharedInstanceAttribute(source.aSize));
  geometry.setAttribute('aColor', sharedInstanceAttribute(source.aColor));
  geometry.setAttribute('aRot', sharedInstanceAttribute(source.aRot));
  geometry.setAttribute('aRotSpd', sharedInstanceAttribute(source.aRotSpd));
  geometry.setAttribute('aOpacity', sharedInstanceAttribute(source.aOpacity));
  geometry.setAttribute('aSpecies', sharedInstanceAttribute(source.aSpecies));
  geometry.setAttribute('aThresh', sharedInstanceAttribute(source.aThresh));
  geometry.instanceCount = source.position.count;

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uFade: { value: 0 },
      uTime: { value: 0 },
      uActive: { value: 0 },
      uWorldScale: { value: worldScale },
      uLightDir: { value: new THREE.Vector3(-0.35, 0.82, 0.44).normalize() },
    },
    vertexShader: /* glsl */`
      attribute vec3 aOffset;
      attribute float aSize;
      attribute vec3 aColor;
      attribute float aRot;
      attribute float aRotSpd;
      attribute float aOpacity;
      attribute float aSpecies;
      attribute float aThresh;
      uniform float uTime;
      uniform float uWorldScale;
      varying vec3 vColor;
      varying vec3 vNormal;
      varying float vOpacity;
      varying float vThreshold;
      ${ROTATE_GLSL}
      void main() {
        float speed = abs(aRotSpd);
        vec3 angles = vec3(
          sin(uTime * (0.72 + speed * 0.13) + aRot * 1.7) * (0.52 + aSpecies * 0.11),
          aRot * 0.61 + uTime * aRotSpd * 0.23,
          aRot + uTime * aRotSpd
        );
        vec3 silhouette = position;
        silhouette.x *= mix(0.72, 1.12, step(0.5, aSpecies));
        float speciesScale = mix(0.48, 1.0, step(0.5, aSpecies));
        vec3 local = rotateXYZ(silhouette * (aSize * uWorldScale * speciesScale), angles);
        vec3 rotatedNormal = normalize(rotateXYZ(normal, angles));
        vec4 world = modelMatrix * vec4(aOffset + local, 1.0);
        gl_Position = projectionMatrix * viewMatrix * world;
        vColor = aColor;
        vNormal = normalize(mat3(modelMatrix) * rotatedNormal);
        vOpacity = aOpacity;
        vThreshold = aThresh;
      }`,
    fragmentShader: /* glsl */`
      precision highp float;
      uniform float uFade;
      uniform float uActive;
      uniform vec3 uLightDir;
      varying vec3 vColor;
      varying vec3 vNormal;
      varying float vOpacity;
      varying float vThreshold;
      void main() {
        float gust = smoothstep(vThreshold - 0.16, vThreshold + 0.04, uActive);
        float alpha = vOpacity * uFade * gust;
        if (alpha < 0.02) discard;
        float wrap = 0.58 + 0.42 * max(dot(normalize(vNormal), normalize(uLightDir)), 0.0);
        gl_FragColor = vec4(vColor * wrap, alpha);
      }`,
    side: THREE.DoubleSide,
    transparent: true,
    depthTest: true,
    depthWrite: true,
  });

  const depthMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uFade: material.uniforms.uFade,
      uTime: material.uniforms.uTime,
      uActive: material.uniforms.uActive,
      uWorldScale: material.uniforms.uWorldScale,
    },
    vertexShader: /* glsl */`
      attribute vec3 aOffset;
      attribute float aSize;
      attribute float aRot;
      attribute float aRotSpd;
      attribute float aOpacity;
      attribute float aSpecies;
      attribute float aThresh;
      uniform float uTime;
      uniform float uWorldScale;
      varying float vOpacity;
      varying float vThreshold;
      ${ROTATE_GLSL}
      void main() {
        float speed = abs(aRotSpd);
        vec3 angles = vec3(
          sin(uTime * (0.72 + speed * 0.13) + aRot * 1.7) * (0.52 + aSpecies * 0.11),
          aRot * 0.61 + uTime * aRotSpd * 0.23,
          aRot + uTime * aRotSpd
        );
        vec3 silhouette = position;
        silhouette.x *= mix(0.72, 1.12, step(0.5, aSpecies));
        float speciesScale = mix(0.48, 1.0, step(0.5, aSpecies));
        vec3 local = rotateXYZ(silhouette * (aSize * uWorldScale * speciesScale), angles);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(aOffset + local, 1.0);
        vOpacity = aOpacity;
        vThreshold = aThresh;
      }`,
    fragmentShader: /* glsl */`
      #include <packing>
      uniform float uFade;
      uniform float uActive;
      varying float vOpacity;
      varying float vThreshold;
      void main() {
        float gust = smoothstep(vThreshold - 0.16, vThreshold + 0.04, uActive);
        if (vOpacity * uFade * gust < 0.02) discard;
        gl_FragColor = packDepthToRGBA(gl_FragCoord.z);
      }`,
    side: THREE.DoubleSide,
    blending: THREE.NoBlending,
    depthTest: true,
    depthWrite: true,
  });
  depthMaterial.allowOverride = false;
  bindOwnedDepthMaterial(material, depthMaterial);

  const object = new THREE.Mesh(geometry, material);
  object.name = 'seasonPetalsWorld';
  object.renderOrder = renderOrder;
  object.frustumCulled = false;
  object.visible = false;
  object.userData.dofDepthMaterial = depthMaterial;

  const seasonAttributes = [
    geometry.attributes.aColor,
    geometry.attributes.aSize,
    geometry.attributes.aRotSpd,
    geometry.attributes.aSpecies,
  ];

  return {
    object,
    material,
    geometry,
    syncPosition() {
      geometry.attributes.aOffset.needsUpdate = true;
    },
    syncSeasonAttributes() {
      for (const attribute of seasonAttributes) attribute.needsUpdate = true;
    },
    stats: {
      instances: geometry.instanceCount,
      triangles: geometry.instanceCount * 4,
      sharedCpuBytes: attributeBytes(source),
      baseGeometryBytes: baseGeometryBytes(geometry),
      colorPrograms: 1,
      dofDepthPrograms: 1,
    },
    sharesSourceArrays() {
      return geometry.attributes.aOffset.array === source.position.array
        && geometry.attributes.aSize.array === source.aSize.array
        && geometry.attributes.aRot.array === source.aRot.array;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}

export function createMoteWorldRepresentation(pointGeometry, {
  renderOrder = 4,
  // Dust is a visible scattering clump; the firefly includes its luminous
  // envelope as a 2–3cm volume and lets optics, rather than geometry, make the
  // resulting bokeh large.
  dustRadius = 0.006,
  fireflyRadius = 0.014,
} = {}) {
  const geometry = makeOctahedronBaseGeometry();
  const source = pointGeometry.attributes;
  geometry.setAttribute('aOffset', sharedInstanceAttribute(source.position));
  geometry.setAttribute('aRand', sharedInstanceAttribute(source.aRand));
  geometry.instanceCount = source.position.count;

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uIntensity: { value: 1 },
      uColor: { value: new THREE.Color(0xffdca8) },
      uFirefly: { value: 0 },
      uFireflyColor: { value: new THREE.Color(0xe8f58a) },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uDrift: { value: 0.75 },
      uWindDir: { value: new THREE.Vector3(1, 0, 0) },
      uWindSway: { value: 0.6 },
      uGust: { value: 0 },
      uNearA: { value: 3 },
      uNearB: { value: 9 },
      uLensScale: { value: 1 },
      uDustRadius: { value: dustRadius },
      uFireflyRadius: { value: fireflyRadius },
    },
    vertexShader: /* glsl */`
      attribute vec3 aOffset;
      attribute vec4 aRand;
      uniform float uTime;
      uniform vec3 uSunDir;
      uniform float uDrift;
      uniform vec3 uWindDir;
      uniform float uWindSway;
      uniform float uGust;
      uniform float uNearA;
      uniform float uNearB;
      uniform float uLensScale;
      uniform float uDustRadius;
      uniform float uFireflyRadius;
      varying float vAlpha;
      varying float vFirefly;
      varying float vFacing;
      ${ROTATE_GLSL}
      void main() {
        vec3 p = aOffset;
        float ph = aRand.x;
        float fm = aRand.y;
        p.x += uDrift * sin(uTime * 0.50 * fm + ph);
        p.y += uDrift * 0.55 * sin(uTime * 0.37 * fm + ph * 1.7 + 1.3);
        p.z += uDrift * cos(uTime * 0.43 * fm + ph * 2.1);
        float windAmp = uWindSway * (0.35 + uGust);
        float ws = 0.5 + 0.5 * sin(uTime * 0.30 + ph);
        p.x += uWindDir.x * windAmp * ws;
        p.z += uWindDir.z * windAmp * ws;

        float ff = step(aRand.z, -0.0001);
        float radius = mix(uDustRadius, uFireflyRadius, ff) * aRand.w;
        vec3 angles = vec3(
          ph + uTime * (0.31 + fm * 0.11),
          ph * 1.7 + uTime * 0.23,
          ph * 2.3 - uTime * 0.19
        );
        vec3 local = rotateXYZ(position * radius, angles);
        vec3 n = normalize(rotateXYZ(normal, angles));
        vec4 world = modelMatrix * vec4(p + local, 1.0);
        vec4 mv = viewMatrix * world;
        gl_Position = projectionMatrix * mv;

        float visualDepth = -mv.z / max(uLensScale, 0.0001);
        float nearFade = smoothstep(uNearA, uNearB, visualDepth);
        vec3 viewDir = normalize(world.xyz - cameraPosition);
        float forward = max(dot(viewDir, normalize(uSunDir)), 0.0);
        float shimmer = 0.12 + 0.88 * forward * forward * forward;
        float twinkle = 0.72 + 0.28 * sin(uTime * (1.7 + fm) + ph * 3.1);
        float dustAlpha = abs(aRand.z) * shimmer * twinkle * nearFade;
        float pulseBase = 0.5 + 0.5 * sin(uTime * (0.72 + fm * 0.31) + ph * 2.7);
        float pulse = pulseBase * pulseBase;
        pulse *= pulse * pulse * pulse;
        float fireflyAlpha = (0.18 + 0.82 * pulse) * 0.88 * nearFade;
        vFirefly = ff;
        vAlpha = mix(dustAlpha, fireflyAlpha, ff);
        vFacing = 0.35 + 0.65 * abs(dot(normalize(mat3(modelMatrix) * n), -viewDir));
      }`,
    fragmentShader: /* glsl */`
      precision highp float;
      uniform float uIntensity;
      uniform float uFirefly;
      uniform vec3 uColor;
      uniform vec3 uFireflyColor;
      varying float vAlpha;
      varying float vFirefly;
      varying float vFacing;
      void main() {
        float enabledFirefly = vFirefly * uFirefly;
        if (vFirefly > 0.5 && enabledFirefly < 0.001) discard;
        float alpha = vAlpha * mix(uIntensity, enabledFirefly, vFirefly);
        if (alpha < 0.008) discard;
        // A compact HDR centre is a real world volume, allowing source-depth DoF
        // to form an aperture image without a camera-facing sprite.
        float emission = mix(1.0, 7.0, vFirefly);
        vec3 color = mix(uColor * vFacing, uFireflyColor * emission, vFirefly);
        gl_FragColor = vec4(color, min(alpha, 1.0));
      }`,
    side: THREE.DoubleSide,
    transparent: true,
    depthTest: true,
    depthWrite: true,
  });

  const depthMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uTime: material.uniforms.uTime,
      uIntensity: material.uniforms.uIntensity,
      uFirefly: material.uniforms.uFirefly,
      uSunDir: material.uniforms.uSunDir,
      uDrift: material.uniforms.uDrift,
      uWindDir: material.uniforms.uWindDir,
      uWindSway: material.uniforms.uWindSway,
      uGust: material.uniforms.uGust,
      uNearA: material.uniforms.uNearA,
      uNearB: material.uniforms.uNearB,
      uLensScale: material.uniforms.uLensScale,
      uDustRadius: material.uniforms.uDustRadius,
      uFireflyRadius: material.uniforms.uFireflyRadius,
    },
    vertexShader: /* glsl */`
      attribute vec3 aOffset;
      attribute vec4 aRand;
      uniform float uTime;
      uniform float uIntensity;
      uniform float uFirefly;
      uniform vec3 uSunDir;
      uniform float uDrift;
      uniform vec3 uWindDir;
      uniform float uWindSway;
      uniform float uGust;
      uniform float uNearA;
      uniform float uNearB;
      uniform float uLensScale;
      uniform float uDustRadius;
      uniform float uFireflyRadius;
      varying float vVisibleAlpha;
      ${ROTATE_GLSL}
      void main() {
        vec3 p = aOffset;
        float ph = aRand.x;
        float fm = aRand.y;
        p.x += uDrift * sin(uTime * 0.50 * fm + ph);
        p.y += uDrift * 0.55 * sin(uTime * 0.37 * fm + ph * 1.7 + 1.3);
        p.z += uDrift * cos(uTime * 0.43 * fm + ph * 2.1);
        float windAmp = uWindSway * (0.35 + uGust);
        float ws = 0.5 + 0.5 * sin(uTime * 0.30 + ph);
        p.x += uWindDir.x * windAmp * ws;
        p.z += uWindDir.z * windAmp * ws;

        float ff = step(aRand.z, -0.0001);
        float radius = mix(uDustRadius, uFireflyRadius, ff) * aRand.w;
        vec3 angles = vec3(
          ph + uTime * (0.31 + fm * 0.11),
          ph * 1.7 + uTime * 0.23,
          ph * 2.3 - uTime * 0.19
        );
        vec3 local = rotateXYZ(position * radius, angles);
        vec4 world = modelMatrix * vec4(p + local, 1.0);
        vec4 mv = viewMatrix * world;
        gl_Position = projectionMatrix * mv;

        float visualDepth = -mv.z / max(uLensScale, 0.0001);
        float nearFade = smoothstep(uNearA, uNearB, visualDepth);
        vec3 viewDir = normalize(world.xyz - cameraPosition);
        float forward = max(dot(viewDir, normalize(uSunDir)), 0.0);
        float shimmer = 0.12 + 0.88 * forward * forward * forward;
        float twinkle = 0.72 + 0.28 * sin(uTime * (1.7 + fm) + ph * 3.1);
        float dustAlpha = abs(aRand.z) * uIntensity * shimmer * twinkle * nearFade;
        float pulseBase = 0.5 + 0.5 * sin(uTime * (0.72 + fm * 0.31) + ph * 2.7);
        float pulse = pulseBase * pulseBase;
        pulse *= pulse * pulse * pulse;
        float fireflyAlpha = (0.18 + 0.82 * pulse) * 0.88 * nearFade * uFirefly;
        vVisibleAlpha = mix(dustAlpha, fireflyAlpha, ff);
      }`,
    fragmentShader: /* glsl */`
      #include <packing>
      varying float vVisibleAlpha;
      void main() {
        if (vVisibleAlpha < 0.008) discard;
        gl_FragColor = packDepthToRGBA(gl_FragCoord.z);
      }`,
    side: THREE.DoubleSide,
    blending: THREE.NoBlending,
    depthTest: true,
    depthWrite: true,
  });
  depthMaterial.allowOverride = false;
  bindOwnedDepthMaterial(material, depthMaterial);

  const object = new THREE.Mesh(geometry, material);
  object.name = 'dustMotesWorld';
  object.renderOrder = renderOrder;
  object.frustumCulled = false;
  object.visible = false;
  object.userData.dofDepthMaterial = depthMaterial;

  return {
    object,
    material,
    geometry,
    stats: {
      instances: geometry.instanceCount,
      triangles: geometry.instanceCount * 8,
      sharedCpuBytes: attributeBytes(source),
      baseGeometryBytes: baseGeometryBytes(geometry),
      colorPrograms: 1,
      dofDepthPrograms: 1,
    },
    sharesSourceArrays() {
      return geometry.attributes.aOffset.array === source.position.array
        && geometry.attributes.aRand.array === source.aRand.array;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
