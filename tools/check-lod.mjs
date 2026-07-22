// 마을 LOD의 순수 계약 검사. DOM/THREE 없이 청크 분할·3단계 히스테리시스·
// 카메라 로컬 생활 디테일·필지 표현 소유권을 한곳에서 검증한다.
import {
  fadeBeyond,
  presentationWeight,
  waveFadeController,
} from '../src/core/lod.js';
import {
  VILLAGE_FOCUS_ELEVATION,
  VILLAGE_LENS,
  VILLAGE_ZOOM,
  dollyDistanceForFov,
  lensScaleForCamera,
  referenceFovForCamera,
  referenceVillageFov,
  villageScreenDistance,
  VILLAGE_FOCUS_CONTEXT_ELEVATION,
  villageFocusContextElevation,
  villageFocusEffectWeight,
  villageZoomReferenceBounds,
} from '../src/camera/optics.js';
import { planParcelFocus } from '../src/generators/shared/parcel-spatial.js';
import {
  createVillageDetailLodState,
  villageDetailWeightAt,
  VILLAGE_DETAIL_TIER,
} from '../src/runtime/village/detail-lod.js';
import {
  parcelRepresentationState,
  setParcelBaseHidden,
} from '../src/runtime/village/parcel-representation.js';
import { chunkLodDistance, partitionParcels } from '../src/village/chunks.js';
import { IMPOSTOR_VARIANT_COUNTS, impostorHouseSpec } from '../src/village/impostor-spec.js';
import {
  CHUNK_LOD_LEVEL,
  nextChunkLodLevel,
  villageChunkLodPolicy,
} from '../src/village/lod-policy.js';
import { planVillage } from '../src/village/plan.js';
import { parcelLocalPoint } from '../src/village/parcel-contract.js';

const EPS = 1e-9;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function near(actual, expected, message, epsilon = EPS) {
  invariant(Math.abs(actual - expected) <= epsilon,
    `${message} (${actual} != ${expected})`);
}

function assertLevel(actual, expected, message) {
  invariant(actual === expected, `${message} (${actual} != ${expected})`);
}

// 광각/망원 변화는 화면 점유율을 유지하는 실제 dolly이고, 그 물리 거리는 LOD에서
// 이전 렌즈의 등가 거리로 환산돼 소동물·낙엽이 조기 소거되지 않아야 한다.
{
  near(VILLAGE_FOCUS_ELEVATION, 20 * Math.PI / 180,
    'optics: reviewed residential focus elevation drift');
  for (const profile of Object.values(VILLAGE_LENS)) {
    const referenceDistance = 100;
    const opticalDistance = dollyDistanceForFov(
      referenceDistance, profile.referenceFov, profile.fov,
    );
    near(villageScreenDistance(
      opticalDistance, profile.fov, profile.referenceFov,
    ), referenceDistance,
      `optics: ${profile.fov}° dolly changed screen-equivalent distance`);
  }
  invariant(VILLAGE_LENS.aerial.fov > VILLAGE_LENS.aerial.referenceFov
      && VILLAGE_LENS.parcel.fov < VILLAGE_LENS.parcel.referenceFov
      && VILLAGE_LENS.hero.fov < VILLAGE_LENS.parcel.fov
      && VILLAGE_LENS.palace.fov < VILLAGE_LENS.palace.referenceFov
      && VILLAGE_LENS.temple.fov < VILLAGE_LENS.temple.referenceFov,
  'optics: wide-aerial/telephoto-close continuum inverted');
  near(referenceVillageFov(VILLAGE_LENS.aerial.fov), VILLAGE_LENS.aerial.referenceFov,
    'optics: aerial reference mapping drift');
  near(referenceVillageFov(VILLAGE_LENS.parcel.fov), VILLAGE_LENS.parcel.referenceFov,
    'optics: parcel reference mapping drift');
  near(referenceVillageFov(VILLAGE_LENS.hero.fov), VILLAGE_LENS.hero.referenceFov,
    'optics: hero reference mapping drift');

  const standalone = { fov: 28, userData: {} };
  near(referenceFovForCamera(standalone), 28,
    'optics: an unprofiled house camera was inferred as a village lens');
  near(lensScaleForCamera(standalone), 1,
    'optics: an unprofiled house camera changed point-sprite scale');
  const landmark = {
    fov: VILLAGE_LENS.palace.fov,
    userData: { villageReferenceFov: VILLAGE_LENS.palace.referenceFov },
  };
  near(referenceFovForCamera(landmark), VILLAGE_LENS.palace.referenceFov,
    'optics: named landmark reference lens was ignored');

  // #14: 줌은 보기 상태를 전환하지 않고 각 보기의 카메라 범위만 소유한다. 규모가 커져도
  // 둘러보기 최소 거리는 24m에서 멈춰 한양 안으로 내려갈 수 있고, focus 최대 범위는 부감 전체
  // 컨텍스트까지 열어 두되 선택은 유지한다.
  const exploreSmall = villageZoomReferenceBounds('explore', 20);
  const exploreLarge = villageZoomReferenceBounds('explore', 1000);
  const focusLarge = villageZoomReferenceBounds('focus', 1000, 18);
  near(exploreSmall.min, VILLAGE_ZOOM.explore.minReferenceFloor,
    'optics: small-site explore minimum escaped its floor');
  near(exploreLarge.min, VILLAGE_ZOOM.explore.minReferenceCap,
    'optics: large-site explore minimum kept scaling with city radius');
  near(exploreLarge.max, 1000 * VILLAGE_ZOOM.explore.maxReferenceFraction,
    'optics: explore context maximum drift');
  near(focusLarge.max, exploreLarge.max,
    'optics: focused zoom-out cannot reach the full village context');
  near(focusLarge.min, 18 * VILLAGE_ZOOM.focus.minCloseupFraction,
    'optics: focus close-up minimum no longer protects the building shell');
  near(villageFocusEffectWeight(18, 1000, 18), 1,
    'optics: close house lost its full bokeh weight');
  near(villageFocusEffectWeight(focusLarge.max, 1000, 18), 0,
    'optics: wide focused context kept the close-up bokeh pass alive');
  const focusWeights = [18, 100, 300, 600, focusLarge.max]
    .map((distance) => villageFocusEffectWeight(distance, 1000, 18));
  invariant(focusWeights.every((weight, index) => index === 0 || weight <= focusWeights[index - 1]),
    'optics: focused bokeh weight is not monotonic across zoom-out');
  const baseElevation = 9 * Math.PI / 180;
  near(villageFocusContextElevation(18, 1000, 18, baseElevation), baseElevation,
    'optics: close house camera lost its authored elevation');
  near(villageFocusContextElevation(focusLarge.max, 1000, 18, baseElevation),
    VILLAGE_FOCUS_CONTEXT_ELEVATION,
    'optics: wide house context did not crane above foreground architecture');
  const contextElevations = [18, 100, 300, 600, focusLarge.max]
    .map((distance) => villageFocusContextElevation(distance, 1000, 18, baseElevation));
  invariant(contextElevations.every((elevation, index) => (
    index === 0 || elevation >= contextElevations[index - 1]
  )), 'optics: focus context crane is not monotonic across zoom-out');
  let invalidModeRejected = false;
  try { villageZoomReferenceBounds('automatic', 100); } catch { invalidModeRejected = true; }
  invariant(invalidModeRejected, 'optics: unknown zoom mode silently acquired camera bounds');
}

// 공통 fade는 경계에서 튀지 않고, 잘못된 밴드에도 결정적인 계단 fallback을 쓴다.
{
  near(fadeBeyond(10, 10, 20), 1, 'fade: full boundary drift');
  invariant(fadeBeyond(15, 10, 20) > 0 && fadeBeyond(15, 10, 20) < 1,
    'fade: transition stopped interpolating');
  near(fadeBeyond(20, 10, 20), 0, 'fade: hidden boundary drift');
  near(fadeBeyond(Infinity, 10, 20), 0, 'fade: non-finite value remained visible');
  near(fadeBeyond(10, 10, 10), 1, 'fade: degenerate band lost lower step');
  near(fadeBeyond(11, 10, 10), 0, 'fade: degenerate band lost upper step');
}

// 거리 LOD·focus·wave는 last-writer-wins가 아니라 곱으로 합성한다. wave가 소유권
// controller를 찾는 계약도 THREE 없이 검증해 scale reframe 중 visible/opacity 덮어쓰기를 막는다.
{
  near(presentationWeight(1, 0.5, 0.4), 0.2,
    'presentation: detail/focus/wave weights were not multiplied');
  near(presentationWeight(0.4, 0.5, 1), presentationWeight(1, 0.5, 0.4),
    'presentation: owner order changed the final weight');
  near(presentationWeight(1, 1, 0), 0,
    'presentation: zero wave phase left dynamic detail visible');
  near(presentationWeight(1, NaN, 1), 0,
    'presentation: non-finite owner weight failed open');

  let applied = null;
  const object = { userData: { waveFade: { setWeight(v) { applied = v; } } } };
  const controller = waveFadeController(object);
  invariant(!!controller, 'presentation: dynamic wave owner marker was not resolved');
  controller.setWeight(0.375);
  near(applied, 0.375, 'presentation: wave multiplier did not reach its owner');
  invariant(waveFadeController({ userData: { waveFade: {} } }) === null,
    'presentation: invalid wave owner marker was accepted');
}

// FAR↔MID와 MID↔FULL은 서로 다른 진입/이탈 경계를 가져 카메라가 경계에서 흔들려도
// 매 프레임 표현을 교체하지 않는다. 비교 연산의 포함 여부도 시각적 안정성 계약이다.
{
  invariant(CHUNK_LOD_LEVEL.IMPOSTOR === CHUNK_LOD_LEVEL.FAR,
    'chunk LOD: legacy IMPOSTOR alias split from FAR');
  const policy = { midIn: 30, midOut: 36, fullIn: 10, fullOut: 14 };

  assertLevel(nextChunkLodLevel(CHUNK_LOD_LEVEL.FAR, 30, policy), CHUNK_LOD_LEVEL.FAR,
    'chunk LOD: FAR entered MID on the boundary');
  assertLevel(nextChunkLodLevel(CHUNK_LOD_LEVEL.FAR, 29.999, policy), CHUNK_LOD_LEVEL.MID,
    'chunk LOD: FAR failed to enter MID');
  assertLevel(nextChunkLodLevel(CHUNK_LOD_LEVEL.MID, 36, policy), CHUNK_LOD_LEVEL.MID,
    'chunk LOD: MID left for FAR on the boundary');
  assertLevel(nextChunkLodLevel(CHUNK_LOD_LEVEL.MID, 36.001, policy), CHUNK_LOD_LEVEL.FAR,
    'chunk LOD: MID failed to leave for FAR');
  assertLevel(nextChunkLodLevel(CHUNK_LOD_LEVEL.MID, 10, policy), CHUNK_LOD_LEVEL.MID,
    'chunk LOD: MID entered FULL on the boundary');
  assertLevel(nextChunkLodLevel(CHUNK_LOD_LEVEL.MID, 9.999, policy), CHUNK_LOD_LEVEL.FULL,
    'chunk LOD: MID failed to enter FULL');
  assertLevel(nextChunkLodLevel(CHUNK_LOD_LEVEL.FULL, 14, policy), CHUNK_LOD_LEVEL.FULL,
    'chunk LOD: FULL left on the boundary');
  assertLevel(nextChunkLodLevel(CHUNK_LOD_LEVEL.FULL, 14.001, policy), CHUNK_LOD_LEVEL.MID,
    'chunk LOD: FULL failed to leave for MID');

  let level = CHUNK_LOD_LEVEL.FAR;
  for (const distance of [29, 32, 35, 31]) level = nextChunkLodLevel(level, distance, policy);
  assertLevel(level, CHUNK_LOD_LEVEL.MID,
    'chunk LOD: FAR/MID hysteresis oscillated inside its dead band');
  for (const distance of [9, 12, 13, 11]) level = nextChunkLodLevel(level, distance, policy);
  assertLevel(level, CHUNK_LOD_LEVEL.FULL,
    'chunk LOD: MID/FULL hysteresis oscillated inside its dead band');
  assertLevel(nextChunkLodLevel(level, NaN, policy), level,
    'chunk LOD: non-finite distance changed representation');

  const scaled = villageChunkLodPolicy({ R: 500, bowlR: 200 });
  invariant(scaled.enabled, 'chunk LOD: hanyang-sized site did not enable policy');
  invariant(scaled.fullIn < scaled.fullOut && scaled.fullOut < scaled.midIn
    && scaled.midIn < scaled.midOut,
  'chunk LOD: scaled thresholds are not strictly nested');
  near(scaled.swapIn, scaled.fullIn, 'chunk LOD: swapIn compatibility alias drift');
  near(scaled.swapOut, scaled.fullOut, 'chunk LOD: swapOut compatibility alias drift');
  invariant(Number.isFinite(scaled.maxArcLength) && scaled.maxArcLength < scaled.ringW,
    'chunk LOD: spatial cell cap no longer tightens the ring');
  const disabled = villageChunkLodPolicy({ R: 339, bowlR: 200 });
  invariant(!disabled.enabled && disabled.farDist === Infinity,
    'chunk LOD: small site unexpectedly enabled far representation');
}

// 청크 거리는 centroid가 아니라 소유 필지 중 최단 거리이며, y가 제공되면 필지 대지까지의
// 실제 3D 거리를 쓴다. 부감 카메라가 수평상 겹쳤다는 이유로 전체 디테일을 켜지 않게 한다.
{
  const chunk = {
    parcels: [
      { id: 'near', center: { x: 3, z: 4 }, baseY: 12 },
      { id: 'far', center: { x: 30, z: 40 }, baseY: 0 },
    ],
  };
  near(chunkLodDistance(chunk, 0, 0), 5, 'chunk distance: XZ nearest parcel drift');
  near(chunkLodDistance(chunk, 0, 0, 0), 13, 'chunk distance: 3D baseY ignored');
  near(chunkLodDistance(chunk, 3, 4, 12), 0, 'chunk distance: owned parcel did not reach zero');
  near(chunkLodDistance({ center: { x: 3, z: 4 } }, 0, 0, 99), 5,
    'chunk distance: empty-chunk center fallback drift');
}

// 소규모와 maxArcLength를 생략한 호출은 기존 count 기반 분할을 보존한다. LOD 호출만
// 외곽 링을 공간적으로 쪼개고, footprint가 farDist 경계에 걸치면 근경으로 분류한다.
{
  const anchor = { x: 0, z: 0 };
  const parcel = (id, x, z, plotW = 10, plotD = 10) =>
    ({ id, center: { x, z }, plotW, plotD });
  const sparseOuter = [
    parcel('e', 300, 0), parcel('w', -300, 0), parcel('s', 0, 300), parcel('n', 0, -300),
  ];
  const legacy = partitionParcels(sparseOuter, anchor);
  invariant(legacy.length === 1 && legacy[0].ring === 2 && !legacy[0].far,
    'chunks: farDist=Infinity changed sparse outer-ring partition');
  const classified = partitionParcels(sparseOuter, anchor, { ringW: 140, farDist: 100 });
  invariant(classified.length === 1 && classified[0].far,
    'chunks: far classification unexpectedly changed public partition');
  const lod = partitionParcels(sparseOuter, anchor, {
    ringW: 140, farDist: 100, maxArcLength: 140,
  });
  invariant(lod.length === 4 && lod.every((chunk) => chunk.far),
    'chunks: maxArcLength did not spatialize sparse outer ring');
  near(chunkLodDistance(lod.find((chunk) => chunk.parcels[0].id === 'e'), 300, 0), 0,
    'chunks: LOD distance ignored owned parcel');
  invariant(!partitionParcels([parcel('edge', 110, 0, 40, 40)], anchor, { farDist: 100 })[0].far,
    'chunks: footprint crossing farDist was classified by centroid');
  invariant(partitionParcels([parcel('far', 140, 0)], anchor, { farDist: 100 })[0].far,
    'chunks: wholly distant footprint was not classified far');
}

// 생활 디테일은 카메라 절대 Y가 아니라 현재 시선 셀의 지형을 기준으로 한다. 셀 밀도의
// FAR/MID/NEAR는 히스테리시스를 갖고, 실제 지상/입자 가시성은 연속 weight로 자연스럽게 페이드한다.
{
  const flat = { heightAt: () => 0 };
  const raised = { heightAt: () => 100 };
  const cameraAt = (y, x = 20, z = -10) => ({ position: { x, y, z } });
  const target = { x: 7, y: 999, z: 11 };
  const low = createVillageDetailLodState(cameraAt(38), target, flat);
  const highGround = createVillageDetailLodState(cameraAt(138), target, raised);
  near(low.altitude, 38, 'detail LOD: target-relative altitude drift');
  near(highGround.altitude, low.altitude, 'detail LOD: raised terrain used absolute camera Y');
  invariant(low.anchor.x === target.x && low.anchor.z === target.z && low.anchor.y === 0,
    'detail LOD: target XZ/terrain anchor drift');
  near(low.groundWeight, 1, 'detail LOD: ground full boundary drift');
  assertLevel(low.tier, VILLAGE_DETAIL_TIER.NEAR,
    'detail LOD: initial near boundary drift');

  let state = createVillageDetailLodState(cameraAt(37), target, flat);
  state = createVillageDetailLodState(cameraAt(45.999), target, flat, state);
  assertLevel(state.tier, VILLAGE_DETAIL_TIER.NEAR,
    'detail LOD: NEAR left before hysteresis boundary');
  state = createVillageDetailLodState(cameraAt(46), target, flat, state);
  assertLevel(state.tier, VILLAGE_DETAIL_TIER.MID,
    'detail LOD: NEAR failed to leave at boundary');
  state = createVillageDetailLodState(cameraAt(65.999), target, flat, state);
  assertLevel(state.tier, VILLAGE_DETAIL_TIER.MID,
    'detail LOD: MID left before FAR boundary');
  state = createVillageDetailLodState(cameraAt(66), target, flat, state);
  assertLevel(state.tier, VILLAGE_DETAIL_TIER.FAR,
    'detail LOD: MID failed to leave at FAR boundary');
  state = createVillageDetailLodState(cameraAt(58.001), target, flat, state);
  assertLevel(state.tier, VILLAGE_DETAIL_TIER.FAR,
    'detail LOD: FAR re-entered MID inside dead band');
  state = createVillageDetailLodState(cameraAt(58), target, flat, state);
  assertLevel(state.tier, VILLAGE_DETAIL_TIER.MID,
    'detail LOD: FAR failed to re-enter MID at boundary');
  state = createVillageDetailLodState(cameraAt(38), target, flat, state);
  assertLevel(state.tier, VILLAGE_DETAIL_TIER.NEAR,
    'detail LOD: MID failed to re-enter NEAR at boundary');

  const hidden = createVillageDetailLodState(cameraAt(62), target, flat);
  near(hidden.groundWeight, 0, 'detail LOD: ground hidden boundary drift');
  const lowAngleFar = createVillageDetailLodState(
    { position: { x: 150, y: 20, z: 0 } }, { x: 0, z: 0 }, flat,
  );
  near(lowAngleFar.particleWeight, 0,
    'detail LOD: low-altitude distant view kept particles active');
  const lowAngleFade = createVillageDetailLodState(
    { position: { x: 92, y: 20, z: 0 } }, { x: 0, z: 0 }, flat,
  );
  invariant(lowAngleFade.tier === VILLAGE_DETAIL_TIER.FAR
    && lowAngleFade.groundWeight > 0 && lowAngleFade.groundActive,
  'detail LOD: FAR cell tier hard-cut the remaining ground fade');
  const fallback = createVillageDetailLodState(cameraAt(20, 3, 4), null, flat);
  invariant(fallback.anchor.x === 3 && fallback.anchor.z === 4,
    'detail LOD: missing-target fallback ignored camera cell');

  const local = { ...low, anchor: { x: 0, y: 0, z: 0 } };
  near(villageDetailWeightAt(local, { x: 32, z: 0 }), 1,
    'detail LOD: spatial full boundary drift');
  invariant(villageDetailWeightAt(local, { x: 52, z: 0 }) > 0
    && villageDetailWeightAt(local, { x: 52, z: 0 }) < 1,
  'detail LOD: spatial transition stopped interpolating');
  near(villageDetailWeightAt(local, { x: 72, z: 0 }), 0,
    'detail LOD: spatial hidden boundary drift');
  near(villageDetailWeightAt(hidden, hidden.anchor), 0,
    'detail LOD: aerial altitude left local fauna visible');
  near(villageDetailWeightAt(local, { x: NaN, z: 0 }), 0,
    'detail LOD: invalid spatial anchor failed open');

  const referenceCamera = {
    position: { x: 0, y: 28, z: 42 },
  };
  const focusScale = dollyDistanceForFov(
    1, VILLAGE_LENS.parcel.referenceFov, VILLAGE_LENS.parcel.fov,
  );
  const telephotoCamera = {
    fov: VILLAGE_LENS.parcel.fov,
    userData: { villageReferenceFov: VILLAGE_LENS.parcel.referenceFov },
    position: {
      x: 0,
      y: referenceCamera.position.y * focusScale,
      z: referenceCamera.position.z * focusScale,
    },
  };
  const referenceLod = createVillageDetailLodState(referenceCamera, { x: 0, z: 0 }, flat);
  const telephotoLod = createVillageDetailLodState(telephotoCamera, { x: 0, z: 0 }, flat);
  near(telephotoLod.visualAltitude, referenceLod.altitude,
    'detail LOD: telephoto dolly changed apparent altitude');
  near(telephotoLod.visualDistance, referenceLod.viewDistance,
    'detail LOD: telephoto dolly changed apparent distance');
  near(telephotoLod.groundWeight, referenceLod.groundWeight,
    'detail LOD: telephoto dolly changed ground detail weight');
  near(telephotoLod.particleWeight, referenceLod.particleWeight,
    'detail LOD: telephoto dolly changed particle detail weight');
  near(telephotoLod.lensScale, focusScale,
    'detail LOD: telephoto point-size compensation drifted from its dolly');

  // Palace/temple FOVs overlap the ordinary continuum numerically, so their
  // authored reference lens must travel with the camera instead of being guessed.
  for (const name of ['palace', 'temple']) {
    const profile = VILLAGE_LENS[name];
    const scale = dollyDistanceForFov(1, profile.referenceFov, profile.fov);
    const landmarkCamera = {
      fov: profile.fov,
      userData: { villageReferenceFov: profile.referenceFov },
      position: { x: 0, y: referenceCamera.position.y * scale, z: referenceCamera.position.z * scale },
    };
    const landmarkLod = createVillageDetailLodState(landmarkCamera, { x: 0, z: 0 }, flat);
    near(landmarkLod.visualDistance, referenceLod.viewDistance,
      `detail LOD: ${name} named lens changed apparent distance`);
    near(landmarkLod.lensScale, scale,
      `detail LOD: ${name} point-size scale drifted from its compensated dolly`);
  }
}

function makeHideSource(ids) {
  const owned = new Set(ids);
  const hidden = new Set();
  return {
    locate: new Map([...owned].map((id) => [id, true])),
    setHidden(id, on) {
      if (!owned.has(id)) return;
      if (on) hidden.add(id); else hidden.delete(id);
    },
    isHidden(id) { return owned.has(id) && hidden.has(id); },
  };
}

function makeRepresentationHandle(parcel, level) {
  const lod = {
    chunkId: 'chunk-test',
    level,
    distance: 12.34567,
    midIn: 30,
    midOut: 36,
    fullIn: 10,
    fullOut: 14,
    swapIn: 10,
    swapOut: 14,
    farRoot: { visible: level === CHUNK_LOD_LEVEL.FAR },
    midRoot: { visible: level === CHUNK_LOD_LEVEL.MID },
    fullRoot: { visible: level === CHUNK_LOD_LEVEL.FULL },
  };
  lod.impostorRoot = lod.farRoot;
  const houses = makeHideSource([parcel.id]);
  const walls = makeHideSource([parcel.id]);
  const impostors = makeHideSource([parcel.id]);
  impostors.locate.set(parcel.id, { lod });
  return {
    [parcel.kind]: { userData: houses },
    walls,
    impostors,
    lod,
  };
}

// 필지의 base(FAR/MID/FULL)와 선택 overlay는 정확히 하나만 소유해야 한다. 은닉은 집·담·
// 원경 mass에 원자적으로 전파돼 전환 중 중복 지붕이나 담 잔상이 남지 않는다.
{
  const parcel = { id: 'p-test', kind: 'choga' };
  for (const level of [CHUNK_LOD_LEVEL.FAR, CHUNK_LOD_LEVEL.MID, CHUNK_LOD_LEVEL.FULL]) {
    const handle = makeRepresentationHandle(parcel, level);
    const state = parcelRepresentationState(handle, parcel, false);
    invariant(state.valid && state.representations === 1,
      `parcel ownership: ${level} base is not exclusive`);
    assertLevel(state.level, level, `parcel ownership: ${level} level drift`);
    near(state.distance, 12.346, `parcel ownership: ${level} distance debug rounding`, 1e-6);

    invariant(setParcelBaseHidden(handle, parcel, true),
      `parcel ownership: ${level} hide reported no change`);
    invariant(!setParcelBaseHidden(handle, parcel, true),
      `parcel ownership: ${level} repeated hide was not idempotent`);
    const overlay = parcelRepresentationState(handle, parcel, true);
    invariant(overlay.valid && overlay.representations === 1 && overlay.overlay,
      `parcel ownership: ${level} overlay did not become sole owner`);
    invariant(overlay.baseHidden && overlay.wallHidden && overlay.impostorHidden,
      `parcel ownership: ${level} hide did not cover all base sources`);

    invariant(setParcelBaseHidden(handle, parcel, false),
      `parcel ownership: ${level} show reported no change`);
    const duplicate = parcelRepresentationState(handle, parcel, true);
    invariant(!duplicate.valid && duplicate.representations === 2,
      `parcel ownership: ${level} failed to expose overlay/base duplication`);
  }

  const handle = makeRepresentationHandle(parcel, CHUNK_LOD_LEVEL.MID);
  handle.lod.farRoot.visible = true;
  const rootsOverlap = parcelRepresentationState(handle, parcel, false);
  invariant(!rootsOverlap.valid && rootsOverlap.representations === 2,
    'parcel ownership: simultaneous FAR/MID roots passed exclusivity check');
}

// 원거리 mass도 실제 건물 variant 어휘·역할별 선형 팔레트를 보존한다.
{
  const specs = { choga: [], giwa: [] };
  for (const kind of ['choga', 'giwa']) {
    for (let variant = 0; variant < IMPOSTOR_VARIANT_COUNTS[kind]; variant++) {
      const spec = impostorHouseSpec({ kind, variant });
      specs[kind].push(spec);
      const giwaBodyPoints = { single: 4, l: 6, u: 8 };
      const giwaRoofCount = { single: 1, l: 2, u: 3 };
      invariant(spec.body.polygon.length === (kind === 'giwa' ? giwaBodyPoints[spec.planShape] : 4),
        `far mass ${kind}/${variant}: wrong body plan`);
      invariant(spec.roofs.length === (kind === 'giwa' ? giwaRoofCount[spec.planShape] : 1),
        `far mass ${kind}/${variant}: wrong roof vocabulary`);
      invariant(spec.roofs.every((roof) => roof.x1 > roof.x0 && roof.z1 > roof.z0
        && roof.ridgeY > roof.eaveY && roof.ridgeHalf > 0),
      `far mass ${kind}/${variant}: invalid hip roof`);
      invariant(Object.values(spec.colors).flat().every((channel) =>
        Number.isFinite(channel) && channel >= 0 && channel <= 1.2),
      `far mass ${kind}/${variant}: invalid linear palette`);
    }
  }
  invariant(specs.choga[2].roofs[0].x1 - specs.choga[2].roofs[0].x0
    > specs.choga[0].roofs[0].x1 - specs.choga[0].roofs[0].x0,
  'far mass choga: five-bay rich variant lost wider silhouette');
  for (const [base, flipped] of [[0, 1]]) {
    const expected = specs.giwa[base].body.polygon
      .map((point) => `${(-point.x).toFixed(6)},${point.z.toFixed(6)}`)
      .sort();
    const actual = specs.giwa[flipped].body.polygon
      .map((point) => `${point.x.toFixed(6)},${point.z.toFixed(6)}`)
      .sort();
    invariant(JSON.stringify(actual) === JSON.stringify(expected),
      `far mass giwa ${base}/${flipped}: L-plan mirror drift`);
  }
  invariant(JSON.stringify([...new Set(specs.giwa.map((spec) => spec.planShape))].sort())
    === JSON.stringify(['l', 'single', 'u']),
  'far mass giwa: ㅡ/ㄱ/ㄷ repertoire drifted');
  invariant(specs.giwa.filter((spec) => spec.planShape === 'u')
    .every((spec) => spec.bays >= 4),
  'far mass giwa: U-plan dropped below four bays');
  invariant(Math.max(...specs.giwa[0].colors.roof) < 0.15
    && Math.min(...specs.giwa[0].colors.wall) > 0.5,
  'far mass giwa: tile/plaster palette drifted from full-detail materials');
  invariant(specs.giwa[0].colors.stone
    && specs.giwa[0].foundation.y1 > specs.giwa[0].foundation.y0,
    'far mass giwa: role-tagged foundation was lost');
  const fresh = impostorHouseSpec({ kind: 'choga', variant: 2, thatchAge: 0 }).colors.roof;
  const old = impostorHouseSpec({ kind: 'choga', variant: 0, thatchAge: 1 }).colors.roof;
  invariant(fresh.reduce((sum, value) => sum + value, 0)
    > old.reduce((sum, value) => sum + value, 0),
  'far mass choga: thatch ageing lost fresh-to-old value contrast');
}

function assertPlanChunkContract(plan, label) {
  const policy = villageChunkLodPolicy(plan.site);
  invariant(policy.enabled, `${label}: LOD policy unexpectedly disabled`);
  const regular = plan.parcels.filter((parcel) => !parcel.hero);
  const chunks = partitionParcels(regular, plan.site.center, policy);
  const nearestFootprint = (chunk) => Math.min(...chunk.parcels.map((parcel) =>
    Math.hypot(parcel.center.x - plan.site.center.x, parcel.center.z - plan.site.center.z)
      - Math.hypot(parcel.plotW || 10, parcel.plotD || 10) * 0.5));
  for (const chunk of chunks) {
    const nearest = nearestFootprint(chunk);
    invariant(chunk.far === (nearest > policy.farDist),
      `${label}: chunk ${chunk.ring}/${chunk.sector} used centroid instead of nearest footprint`);
    for (const parcel of chunk.parcels) {
      const focus = planParcelFocus(parcel);
      invariant(focus.targetLift >= 1.65 && focus.targetLift <= 2.5,
        `${label}/${parcel.id}: focus target escaped door-height band (${focus.targetLift})`);
      invariant(focus.targetLift < focus.height * 0.34,
        `${label}/${parcel.id}: focus target drifted back toward the roof (${focus.targetLift}/${focus.height})`);
      const focusHorizontal = Math.hypot(
        focus.cameraX - focus.worldX,
        focus.cameraZ - focus.worldZ,
      );
      near(Math.atan2(focus.cameraLift, focusHorizontal), VILLAGE_FOCUS_ELEVATION,
        `${label}/${parcel.id}: focus camera left the shared courtyard elevation`);
      const localTarget = parcelLocalPoint(parcel, { x: focus.worldX, z: focus.worldZ });
      const localCamera = parcelLocalPoint(parcel, { x: focus.cameraX, z: focus.cameraZ });
      const solar = parcel.solarAccess;
      const solarT = (solar.localEnd - localTarget.z) / (localCamera.z - localTarget.z);
      const solarX = localTarget.x + (localCamera.x - localTarget.x) * solarT;
      invariant(solarT > 0 && solarT < 1 && Math.abs(solarX) <= solar.halfWidth - 0.2,
        `${label}/${parcel.id}: focus camera left its south-light opening (${solarX}/${solar.halfWidth})`);
      const cameraY = (parcel.baseY || 0) + focus.targetLift + focus.cameraLift;
      const distance = chunkLodDistance(chunk, focus.cameraX, focus.cameraZ, cameraY);
      invariant(distance < policy.fullIn,
        `${label}/${parcel.id}: focus camera cannot reach FULL for chunk ${chunk.ring}/${chunk.sector} `
        + `(${distance.toFixed(2)} >= ${policy.fullIn.toFixed(2)})`);
    }
  }
  invariant(chunks.every((chunk) => chunk.parcels.length > 0),
    `${label}: empty LOD chunk escaped partition`);
  return chunks.length;
}

let planCount = 0;
let chunkCount = 0;
for (const [siteR, seed] of [
  [340, 1], [340, 42], [400, 1], [400, 42],
  [500, 25], [500, 108], [500, 112], [500, 142], [500, 20260716],
]) {
  const plan = planVillage(siteR === 500 ? { scale: 'hanyang', seed } : { siteR, seed });
  chunkCount += assertPlanChunkContract(plan, `LOD R${siteR}/${seed}`);
  planCount++;
}

console.log(`LOD: PASS (${planCount} plans, ${chunkCount} chunks)`);
