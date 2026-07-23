import * as THREE from 'three';
import { normalizeVillageLensScale } from '../camera/optics.js';
import { hashString, makeRng } from '../rng.js';
import { collectOpeningGlowAnchors } from '../builder/opening-glow-anchors.js';
import { houseMatrix } from '../generators/shared/parcel-transform.js';
import {
  NIGHTLIGHT_FLICK_GLSL,
  createPhysicalNightlightBatch,
} from './nightlight-physical-geometry.js';

// 원경 창불 발광 포인트(태스크 #60, #81) — 부감 야경의 마법.
//   실제 renderer가 확정한 고정 한지 면 anchor만 소비한다. 필지 크기나 처마 치수를 이 레이어에서
//   재추정하지 않으며, 깊이 테스트로 집·담·지형 뒤의 불빛을 정상적으로 가린다. 가까워지면 실제
//   창호 emissive가 바통을 이어받는다.
//
//   설계:
//   · 단일 THREE.Points(1 드로우콜) — 집당 1~2점, 종가·궁·절은 밝게 여러 점. 호수 무관.
//   · 점등 곡선: uNight(0..1) = adapter vnight 를 매 프레임 그대로 받음(#50 크로스페이드 자동 정합).
//     각 점은 aThreshold(집집이 다른 점등 문턱)를 uNight 이 넘어설 때 smoothstep 으로 서서히 켜짐
//     → 석양(vnight≈0.42) 절반, 밤(1.0) 대부분. 팟 없이 차오름.
//   · 분포 서사: per-parcel wealth 상관 — 부유·격식 높은 집은 일찍(낮은 문턱)·밝게, 가난한 집은
//     늦게·어둡게, 일부는 아예 불 꺼짐(빈집·잠듦). 결정론(parcel.seed) — 같은 시드 같은 점등.
//   · 거리 곡선: gl_PointSize 는 거리 감쇠하되 min/max 로 클램프(원거리에서도 읽히는 하한). 근접
//     밴드(uFadeNear..uFadeNearEnd)에서 투명도 0 으로 페이드 아웃 → 눈높이에선 점광 잔재 없음.
//   · #96 A/B: 동일 owner/slot 배열은 저작된 한지 면 방향·크기도 보관한다. 선택적 physical 경로는
//     그 배열을 단일 InstancedBufferGeometry로 그리며 같은 near fade 뒤 실제 FULL 한지가 이어받는다.
//     기본 제품 경로 변경은 제품 count의 GPU·시각 판정과 함께 상위 통합에서 한 번만 결정한다.
//
//   드로우콜: Points 1개. 결정론: Math.random 미사용(전부 parcel/plan seed).

const TAU = Math.PI * 2;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const clamp01 = (v) => clamp(v, 0, 1);

// 창불 팔레트(호롱·등잔) — night-glow WARM(0xffb35c) 계열. 촛불 주황 ↔ 등잔 노랑 사이 개체차.
const COLOR_CANDLE = new THREE.Color(0xff9a45);
const COLOR_LAMP = new THREE.Color(0xffcf88);

function regularProfile(parcel, kind = parcel.kind) {
  const rng = makeRng((parcel.seed ^ 0x9117e5) >>> 0);
  const wealth = clamp01(parcel.wealth != null ? parcel.wealth : 0.5);
  const dark = rng() < 0.06;
  const threshold = clamp(0.16 + (1 - wealth) * 0.4 + (rng() * 2 - 1) * 0.13, 0.06, 0.9);
  const lit = clamp01(0.5 + wealth * 0.5 + (rng() * 2 - 1) * 0.16);
  const warm = rng();
  const isGiwa = kind === 'giwa';
  const desired = dark ? 0 : ((isGiwa || wealth > 0.62) ? 2 : 1);
  const slots = [{
    lit, threshold, phase: rng() * TAU, warm, scale: isGiwa ? 1.12 : 1.0,
  }, {
      lit: lit * (0.55 + rng() * 0.2), threshold: clamp(threshold + 0.06 + rng() * 0.08, 0.06, 0.95),
      phase: rng() * TAU, warm: clamp01(warm + (rng() * 2 - 1) * 0.2), scale: isGiwa ? 0.95 : 0.85,
  }];
  return { capacity: 2, desired, kind: isGiwa ? 'giwa' : 'choga', slots };
}

function heroProfile(parcel) {
  const rng = makeRng((parcel.seed ^ 0x9117e5) >>> 0);
  return {
    capacity: 3,
    desired: 3,
    slots: Array.from({ length: 3 }, () => ({
      lit: 0.95 + rng() * 0.15,
      threshold: 0.10 + rng() * 0.06,
      phase: rng() * TAU,
      warm: 0.2 + rng() * 0.3,
      scale: 1.5,
    })),
  };
}

function featureProfile(feature, count, litBase, scale, seedSalt) {
  const featureSeed = Number.isFinite(feature?.seed) ? feature.seed : 7;
  const rng = makeRng((featureSeed ^ seedSalt) >>> 0);
  return {
    capacity: count,
    desired: count,
    slots: Array.from({ length: count }, () => ({
      lit: litBase + rng() * 0.2,
      threshold: 0.08 + rng() * 0.05,
      phase: rng() * TAU,
      warm: 0.15 + rng() * 0.25,
      scale,
    })),
  };
}

function transformAnchors(anchors, matrix) {
  const linear = new THREE.Matrix3().setFromMatrix4(matrix);
  return (anchors || []).map((anchor) => {
    const sourceOutward = new THREE.Vector3(
      anchor.outward.x, anchor.outward.y, anchor.outward.z,
    ).normalize();
    const position = new THREE.Vector3(
      anchor.position.x, anchor.position.y, anchor.position.z,
    ).applyMatrix4(matrix);
    const outward = sourceOutward.clone().transformDirection(matrix);
    const sourceRight = new THREE.Vector3()
      .crossVectors(new THREE.Vector3(0, 1, 0), sourceOutward)
      .normalize();
    const widthScale = sourceRight.applyMatrix3(linear).length();
    const heightScale = new THREE.Vector3(0, 1, 0).applyMatrix3(linear).length();
    return {
      ...anchor,
      position,
      outward,
      width: anchor.width * widthScale,
      height: anchor.height * heightScale,
    };
  });
}

function regularBaseAnchors(parcel, sources) {
  const kind = parcel.kind === 'giwa' ? 'giwa' : 'choga';
  const source = sources.regular?.[kind];
  const variants = source?.variants || [];
  const requested = source?.variantAware === false ? 0 : (parcel.variant | 0);
  const index = clamp(requested, 0, Math.max(0, variants.length - 1));
  return transformAnchors(variants[index] || variants[0] || [], houseMatrix(parcel));
}

function stableAnchorScore(ownerSeed, anchor, index) {
  return hashString(`${ownerSeed}|${anchor.openingId || 'opening'}|${index}`) >>> 0;
}

function selectAnchors(anchors, count, ownerSeed) {
  if (!anchors?.length || count <= 0) return [];
  const ranked = anchors.map((anchor, index) => ({
    anchor,
    index,
    score: stableAnchorScore(ownerSeed, anchor, index),
  })).sort((a, b) => a.score - b.score || a.index - b.index);
  // The first lit room should read from the normal south/front presentation
  // when one exists. Remaining rooms retain a deterministic facade spread.
  const front = ranked.find((entry) => (entry.anchor.outward?.z || 0) > 0.35);
  const selected = front ? [front.anchor] : [];
  for (const entry of ranked) {
    if (selected.length >= count) break;
    if (front && entry === front) continue;
    selected.push(entry.anchor);
  }
  return selected;
}

const VERT = `
uniform float uNight;
uniform float uTime;
uniform float uPixelRatio;
uniform float uSizeBase;
uniform float uMinPx;
uniform float uMaxPx;
uniform float uFadeNear;
uniform float uFadeNearEnd;
uniform float uLensScale;
uniform float uWave;
attribute float aPhase;
attribute float aLit;
attribute float aThreshold;
attribute float aWarm;
attribute float aScale;
varying float vIntensity;
varying float vWarm;

${NIGHTLIGHT_FLICK_GLSL}

void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  // Point primitives with negative clip-space w are driver-sensitive. Reject
  // sources behind the camera before point-size clamping can turn them into
  // large screen-edge cards during a wide aerial orbit.
  if (mv.z >= -0.001 || aLit <= 0.002) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    return;
  }
  float dist = max(-mv.z, 0.001);
  float visualDist = dist / max(uLensScale, 0.0001);
  // 근접 페이드는 실제 FULL 창호 emissive와의 중복을 막는다.
  float base = aLit
    * smoothstep(aThreshold, aThreshold + 0.16, uNight)
    * nightlightFlick(uTime, aPhase);
  vIntensity = nightlightIntensity(aLit, aThreshold, aPhase, visualDist);
  vWarm = aWarm;
  if (vIntensity <= 0.002) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
  // 거리 감쇠 + 하/상한 클램프(원거리에서도 읽히는 최소 픽셀).
  float px = uSizeBase * aScale * uPixelRatio * uLensScale / dist;
  px = clamp(px, uMinPx * uPixelRatio, uMaxPx * uPixelRatio);
  gl_PointSize = px * (0.55 + 0.45 * smoothstep(0.0, 0.6, base));
  gl_Position = projectionMatrix * mv;
}
`;

const FRAG = `
precision mediump float;
uniform vec3 uColorCandle;
uniform vec3 uColorLamp;
varying float vIntensity;
varying float vWarm;
void main() {
  vec2 uv = gl_PointCoord - 0.5;
  float r = length(uv);
  if (r > 0.5) discard;
  // 밝은 코어 + 부드러운 헤일로(post bloom 과 협력).
  float core = smoothstep(0.5, 0.0, r);
  float glow = pow(core, 1.8) + 0.35 * pow(core, 5.0);
  vec3 col = mix(uColorCandle, uColorLamp, vWarm);
  // #66 광량 톤다운(0.6): 부감 창불이 형광처럼 쨍하지 않게. bloom 임계 위 코어는 유지해
  //   헤일로(점점이 번짐)는 살리되 전반 휘도만 낮춘다(물글린트<창불 위계 보존).
  gl_FragColor = vec4(col * glow * vIntensity * 0.6, 1.0);   // CustomBlending One/One → 순수 가산
}
`;

// The color Points material does not write scene depth, but compact HDR source
// transfer needs the light's own camera-space depth rather than the wall behind
// it. This companion uses the exact same vertex shader and uniform objects, then
// repeats only the color shader's circular discard before packing depth.
const DOF_DEPTH_FRAG = `
precision highp float;
#include <packing>
varying float vIntensity;
void main() {
  vec2 uv = gl_PointCoord - 0.5;
  float r = length(uv);
  if (r > 0.5 || vIntensity <= 0.002) discard;
  float core = smoothstep(0.5, 0.0, r);
  float glow = pow(core, 1.8) + 0.35 * pow(core, 5.0);
  // Match the visible radial profile and retain only the source-bright core.
  // The dim additive tail remains bloom haze, not an opaque DoF source plane.
  if (glow * vIntensity * 0.6 <= 0.18) discard;
  gl_FragColor = packDepthToRGBA(gl_FragCoord.z);
}
`;

// `sources` contains renderer-authored variant catalogs and already-placed
// compound anchors. It is deliberately assembled by populate rather than
// reconstructed from plan dimensions here.
export function buildNightLights(plan, _site, sources = {}, options = {}) {
  const group = new THREE.Group();
  group.name = 'village-nightlights';
  const representation = options.representation === 'physical'
    ? 'physical'
    : 'points';

  const ownerAnchors = sources.owners instanceof Map ? sources.owners : new Map();
  const records = [];
  const recordById = new Map();
  let pointCount = 0;
  const addOwner = (id, seed, profile, baseAnchors, parcel = null) => {
    if (!id || !profile?.capacity || recordById.has(id)) return;
    const record = {
      id,
      seed: seed >>> 0,
      start: pointCount,
      profile,
      parcel,
      baseAnchors: baseAnchors || [],
      selected: [],
    };
    pointCount += profile.capacity;
    records.push(record);
    recordById.set(id, record);
  };

  for (const parcel of plan.parcels || []) {
    const anchors = parcel.hero
      ? (ownerAnchors.get(parcel.id) || [])
      : regularBaseAnchors(parcel, sources);
    addOwner(
      parcel.id,
      Number.isFinite(parcel.seed) ? parcel.seed : hashString(parcel.id),
      parcel.hero ? heroProfile(parcel) : regularProfile(parcel),
      anchors,
      parcel,
    );
  }
  const features = plan.features || {};
  const featureSpecs = [
    ['palace', features.palace, 4, 1.05, 1.8, 0x9a11],
    ['temple', features.temple, 3, 0.95, 1.6, 0x7e12],
    // There is no authored pavilion window/lantern anchor today. It remains
    // dark rather than falling back to an inferred polar landmark light.
    ['pavilion', features.pavilion, 1, 0.7, 1.2, 0x5a13],
  ];
  for (const [id, feature, count, lit, scale, salt] of featureSpecs) {
    const anchors = ownerAnchors.get(id) || [];
    if (!feature || anchors.length === 0) continue;
    addOwner(
      id,
      Number.isFinite(feature.seed) ? feature.seed : hashString(id),
      featureProfile(feature, count, lit, scale, salt),
      anchors,
    );
  }

  if (pointCount === 0) {
    const empty = {
      group,
      refreshOwner() { return false; },
      setLevel() {},
      setPixelRatio() {},
      update() {},
      setDepthTestForTest() {},
      debugOwner() { return null; },
      debugState() {
        return {
          pointCount: 0,
          ownerCount: 0,
          drawCalls: 0,
          dofDepthDrawCalls: 0,
          triangles: 0,
          materials: 0,
          programs: 0,
          textures: 0,
          lights: 0,
          depthTest: true,
        };
      },
      debugRepresentation() {
        return { representation, attributeBytes: 0 };
      },
      dispose() {},
    };
    group.userData.nightLights = empty;
    return empty;
  }

  const pos = new Float32Array(pointCount * 3);
  const aPhase = new Float32Array(pointCount);
  const aLit = new Float32Array(pointCount);
  const aThreshold = new Float32Array(pointCount);
  const aWarm = new Float32Array(pointCount);
  const aScale = new Float32Array(pointCount);
  const outward = new Float32Array(pointCount * 3);
  const openingSize = new Float32Array(pointCount * 2);

  function writeOwner(record, anchors) {
    const selected = selectAnchors(anchors, record.profile.desired, record.seed);
    record.selected = selected.map((anchor) => ({
      openingId: anchor.openingId,
      x: anchor.position.x,
      y: anchor.position.y,
      z: anchor.position.z,
      outwardX: anchor.outward?.x || 0,
      outwardY: anchor.outward?.y || 0,
      outwardZ: anchor.outward?.z || 0,
    }));
    for (let slot = 0; slot < record.profile.capacity; slot++) {
      const index = record.start + slot;
      const anchor = selected[slot];
      const values = record.profile.slots[slot];
      pos[index * 3] = anchor ? anchor.position.x : 0;
      pos[index * 3 + 1] = anchor ? anchor.position.y : 0;
      pos[index * 3 + 2] = anchor ? anchor.position.z : 0;
      outward[index * 3] = anchor ? anchor.outward.x : 0;
      outward[index * 3 + 1] = anchor ? anchor.outward.y : 0;
      outward[index * 3 + 2] = anchor ? anchor.outward.z : 1;
      // Keep the luminous paper inside the authored frame. This remains a
      // shallow proxy and fades before the actual FULL hanji emissive takes
      // over; it never becomes a second close-up window surface.
      openingSize[index * 2] = anchor ? anchor.width * 0.88 : 0;
      openingSize[index * 2 + 1] = anchor ? anchor.height * 0.82 : 0;
      aPhase[index] = values.phase;
      aLit[index] = anchor ? values.lit : 0;
      aThreshold[index] = values.threshold;
      aWarm[index] = values.warm;
      aScale[index] = values.scale;
    }
  }
  for (const record of records) writeOwner(record, record.baseAnchors);

  const dpr = clamp(typeof window !== 'undefined' && window.devicePixelRatio ? window.devicePixelRatio : 1, 1, 2);
  const uniforms = {
    uNight: { value: 0 },
    uTime: { value: 0 },
    uPixelRatio: { value: dpr },
    uSizeBase: { value: 1900 },
    uMinPx: { value: 3.2 },
    uMaxPx: { value: 17 },
    uFadeNear: { value: 15 },
    uFadeNearEnd: { value: 62 },
    uLensScale: { value: 1 },
    uWave: { value: 1 },
    uColorCandle: { value: COLOR_CANDLE.clone() },
    uColorLamp: { value: COLOR_LAMP.clone() },
  };
  const sourceArrays = Object.freeze({
    position: pos,
    outward,
    openingSize,
    phase: aPhase,
    lit: aLit,
    threshold: aThreshold,
    warm: aWarm,
  });
  function createRepresentation(mode) {
    if (mode === 'physical') {
      return createPhysicalNightlightBatch({
        count: pointCount,
        arrays: sourceArrays,
        uniforms,
      });
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geometry.setAttribute('aPhase', new THREE.BufferAttribute(aPhase, 1));
    geometry.setAttribute('aLit', new THREE.BufferAttribute(aLit, 1));
    geometry.setAttribute('aThreshold', new THREE.BufferAttribute(aThreshold, 1));
    geometry.setAttribute('aWarm', new THREE.BufferAttribute(aWarm, 1));
    geometry.setAttribute('aScale', new THREE.BufferAttribute(aScale, 1));
    geometry.computeBoundingSphere();

    const material = new THREE.ShaderMaterial({
      uniforms, vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, depthTest: true, depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
    });
    const depthMaterial = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: VERT,
      fragmentShader: DOF_DEPTH_FRAG,
      depthTest: true,
      depthWrite: true,
      blending: THREE.NoBlending,
      toneMapped: false,
    });
    depthMaterial.name = 'nightlight-dof-depth';
    depthMaterial.allowOverride = false;
    depthMaterial.customProgramCacheKey = () => 'cheoma-nightlight-dof-depth-v1';

    const object = new THREE.Points(geometry, material);
    object.name = 'nightlight-points';
    object.frustumCulled = false;
    return {
      object,
      geometry,
      material,
      depthMaterial,
      dynamicAttributes: Object.freeze([
        'position', 'aPhase', 'aLit', 'aThreshold', 'aWarm', 'aScale',
      ]),
      resource: Object.freeze({
        drawCalls: 1,
        dofDepthDrawCalls: 1,
        triangles: 0,
        materials: 2,
        programs: 2,
        textures: 0,
        lights: 0,
        attributeBytes:
          pos.byteLength
          + aPhase.byteLength
          + aLit.byteLength
          + aThreshold.byteLength
          + aWarm.byteLength
          + aScale.byteLength,
      }),
    };
  }
  const renderers = new Map();
  let activeRepresentation = representation;
  const initial = createRepresentation(activeRepresentation);
  renderers.set(activeRepresentation, initial);
  let drawable = initial.object;
  let mat = initial.material;
  let dofDepthMat = initial.depthMaterial;
  let resource = initial.resource;
  function bindActive(batch) {
    drawable = batch.object;
    mat = batch.material;
    dofDepthMat = batch.depthMaterial;
    resource = batch.resource;
  }
  // Transparent ordering stays stable while the normal depth buffer still
  // occludes lights behind walls, terrain, roofs, and courtyard objects.
  drawable.renderOrder = 4;
  drawable.visible = false;
  drawable.userData.dofDepthMaterial = dofDepthMat;
  group.add(drawable);

  let level = 0;
  let waveWeight = 1;
  let disposed = false;
  const syncVisibility = () => {
    drawable.visible = !disposed && level > 0.001 && waveWeight > 0.001;
  };
  group.userData.waveFade = {
    setWeight(value) {
      if (disposed) return;
      waveWeight = clamp01(Number.isFinite(value) ? value : 0);
      uniforms.uWave.value = waveWeight;
      syncVisibility();
    },
  };

  function overlayAnchorsInVillageSpace(overlayRoot) {
    const world = collectOpeningGlowAnchors(overlayRoot, { space: 'world' });
    const parent = group.parent;
    if (!parent?.isObject3D) return world;
    parent.updateWorldMatrix(true, false);
    return transformAnchors(world, new THREE.Matrix4().copy(parent.matrixWorld).invert());
  }

  const api = {
    group,
    refreshOwner(ownerId, overlayRoot = null) {
      if (disposed) return false;
      const record = recordById.get(ownerId);
      if (!record) return false;
      if (record.parcel) {
        record.seed = Number.isFinite(record.parcel.seed)
          ? record.parcel.seed >>> 0
          : hashString(record.id);
        const overlayKind = overlayRoot?.userData?.style;
        const regularKind = overlayKind === 'giwa' || overlayKind === 'choga'
          ? overlayKind : record.parcel.kind;
        record.profile = record.parcel.hero
          ? heroProfile(record.parcel)
          : regularProfile(record.parcel, regularKind);
      }
      writeOwner(record, overlayRoot
        ? overlayAnchorsInVillageSpace(overlayRoot)
        : record.baseAnchors);
      for (const batch of renderers.values()) {
        for (const name of batch.dynamicAttributes) {
          batch.geometry.attributes[name].needsUpdate = true;
        }
      }
      return true;
    },
    setLevel(value) {
      if (disposed) return;
      level = clamp01(value || 0);
      uniforms.uNight.value = level;
      syncVisibility();
    },
    setPixelRatio(value) {
      if (!disposed) uniforms.uPixelRatio.value = clamp(value || 1, 0.5, 3);
    },
    update(dt, value, lensScale = 1) {
      if (disposed) return;
      if (value != null) {
        level = clamp01(value);
        uniforms.uNight.value = level;
      }
      uniforms.uLensScale.value = normalizeVillageLensScale(lensScale);
      syncVisibility();
      if (drawable.visible) uniforms.uTime.value += dt || 0;
    },
    setDepthTestForTest(value) {
      if (!disposed) mat.depthTest = value !== false;
    },
    debugSetRepresentationForTest(nextRepresentation) {
      if (disposed) return false;
      const nextMode = nextRepresentation === 'physical' ? 'physical' : 'points';
      if (nextMode === activeRepresentation) return true;
      let next = renderers.get(nextMode);
      if (!next) {
        next = createRepresentation(nextMode);
        renderers.set(nextMode, next);
      }
      drawable.visible = false;
      group.remove(drawable);
      activeRepresentation = nextMode;
      bindActive(next);
      drawable.renderOrder = 4;
      drawable.userData.dofDepthMaterial = dofDepthMat;
      group.add(drawable);
      syncVisibility();
      return true;
    },
    debugOwner(ownerId) {
      const record = recordById.get(ownerId);
      if (!record) return null;
      return {
        id: record.id,
        start: record.start,
        capacity: record.profile.capacity,
        desired: record.profile.desired,
        kind: record.profile.kind || null,
        selected: record.selected.map((anchor) => ({ ...anchor })),
      };
    },
    debugState() {
      return {
        pointCount,
        ownerCount: records.length,
        drawCalls: resource.drawCalls,
        dofDepthDrawCalls: resource.dofDepthDrawCalls,
        triangles: resource.triangles,
        materials: resource.materials,
        programs: resource.programs,
        textures: resource.textures,
        lights: resource.lights,
        depthTest: mat.depthTest,
      };
    },
    debugRepresentation() {
      return {
        representation: activeRepresentation,
        attributeBytes: resource.attributeBytes,
        activeObject: drawable.name,
        allocatedRepresentations: [...renderers.keys()].sort(),
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const batch of renderers.values()) {
        batch.object.visible = false;
        group.remove(batch.object);
        if (batch.object.userData.dofDepthMaterial === batch.depthMaterial) {
          delete batch.object.userData.dofDepthMaterial;
        }
        batch.geometry.dispose();
        batch.material.dispose();
        batch.depthMaterial.dispose();
      }
      renderers.clear();
    },
  };
  group.userData.nightLights = api;
  return api;
}
