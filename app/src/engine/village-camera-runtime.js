import * as THREE from 'three';
import {
  VILLAGE_LENS,
  dollyDistanceForFov,
  referenceFovForCamera,
  villageAerialElevation,
  villageAerialReferenceDistance,
  villageScreenDistance,
  villageScreenDistanceForCamera,
  villageFocusContextElevation,
  villageFocusEaveWeight as focusEaveWeightForDistance,
  villageFocusEffectWeight as focusEffectWeightForDistance,
  villageZoomReferenceBounds,
} from '../../../src/api/cinematic.js';
import {
  captureSemanticOrbit,
  restoreSemanticOrbit,
} from './semantic-view-runtime.js';

const DEG = Math.PI / 180;
const AERIAL_AZIMUTH = 9 * DEG;
const BASE_NEAR_FRAC = 0.02;
const BASE_NEAR_MIN = 0.08;
const BASE_NEAR_MAX = 2.5;

// 마을 배율의 카메라 프레이밍·보기별 줌·깊이 범위를 한곳에서 관리한다.
export function createVillageCameraRuntime({
  camera,
  container,
  controls,
  scene,
  village,
} = {}) {
  const focusDirection = new THREE.Vector3();
  const semanticTarget = new THREE.Vector3();
  // Time only affects the *default aerial pose* (U2 moon-in-frame). Focus continuum
  // elevations stay on VILLAGE_FOCUS_CONTEXT_ELEVATION via villageFocusContextElevation.
  let timeOfDay = 'day';
  function outerRadius(handle = village.handle) {
    if (handle === village.handle && village.__outerR != null) return village.__outerR;
    const plan = handle.plan;
    let radius = plan.site.bowlR || plan.site.R * 0.56;
    for (const parcel of plan.parcels || []) {
      radius = Math.max(radius, Math.hypot(parcel.center.x, parcel.center.z));
    }
    radius *= 1.12;
    if (handle === village.handle) village.__outerR = radius;
    return radius;
  }

  function setTimeOfDay(name) {
    timeOfDay = typeof name === 'string' && name ? name : 'day';
  }

  // Continuum math follows camera.aspect. resizeAll captures *before* writing the
  // new aspect so preserve measures against the outgoing frame; aerial()/restore
  // then match the container when the live box has moved without a camera write.
  function framingAspect() {
    if (Number.isFinite(camera.aspect) && camera.aspect > 0) return camera.aspect;
    const cw = container?.clientWidth;
    const ch = container?.clientHeight;
    if (cw > 0 && ch > 0) return cw / ch;
    return 1.6;
  }

  function matchCameraAspectToContainer() {
    const cw = container?.clientWidth;
    const ch = container?.clientHeight;
    if (!(cw > 1 && ch > 1)) return false;
    const next = cw / ch;
    if (!(next > 0) || !Number.isFinite(next)) return false;
    if (Math.abs(next - (camera.aspect || 0)) <= 1e-6) return false;
    camera.aspect = next;
    camera.updateProjectionMatrix();
    return true;
  }

  // Refresh the explore zoom continuum unit for the current camera.aspect without
  // moving the camera. Capture/restore/resize must share this unit so a zoom
  // fraction is measured and reapplied against the same aerialReferenceDist.
  function syncAerialReference(handle = village.handle) {
    if (!handle) {
      return { radius: 0, aspect: framingAspect(), referenceDistance: 0, distance: 0 };
    }
    const radius = outerRadius(handle);
    const aspect = framingAspect();
    // Portrait must not fit width via aspect < 1 — that over-distances and fog-bleaches
    // the village. Pure solve lives in src/camera/optics.js (desktop aspect ≥ 1 identical).
    const referenceDistance = villageAerialReferenceDistance(radius, aspect);
    const distance = dollyDistanceForFov(
      referenceDistance,
      VILLAGE_LENS.aerial.referenceFov,
      VILLAGE_LENS.aerial.fov,
    );
    village.aerialReferenceDist = referenceDistance;
    village.aerialDist = distance;
    return { radius, aspect, referenceDistance, distance };
  }

  function exploreTarget(radius) {
    return semanticTarget.set(0, radius * 0.05, -radius * 0.10);
  }

  function aerial(handle = village.handle) {
    // Pose solves follow the live stage box (entry can run before the first
    // resizeAll after chrome layout). Capture preserve must NOT call this — it
    // uses syncAerialReference against the still-outgoing camera.aspect.
    matchCameraAspectToContainer();
    const { radius, distance } = syncAerialReference(handle);
    const elev = villageAerialElevation(timeOfDay);
    const target = exploreTarget(radius).clone();
    const pos = new THREE.Vector3(
      target.x + distance * Math.cos(elev) * Math.sin(AERIAL_AZIMUTH),
      target.y + distance * Math.sin(elev),
      target.z + distance * Math.cos(elev) * Math.cos(AERIAL_AZIMUTH),
    );
    return {
      pos,
      target,
      fov: VILLAGE_LENS.aerial.fov,
      referenceFov: VILLAGE_LENS.aerial.referenceFov,
      elevation: elev,
    };
  }

  function referenceAerialDistance() {
    if (village.aerialReferenceDist > 0) return village.aerialReferenceDist;
    if (village.aerialDist > 0) {
      return villageScreenDistance(
        village.aerialDist,
        VILLAGE_LENS.aerial.fov,
        VILLAGE_LENS.aerial.referenceFov,
      );
    }
    return 150;
  }

  function actualDistance(referenceDistance) {
    return dollyDistanceForFov(referenceDistance, referenceFovForCamera(camera), camera.fov);
  }

  let regime = 'lock';
  let focusCloseupReference = 0;
  let focusBaseElevation = 0;
  let focusElevationOffset = 0;
  let focusAppliedElevation = null;
  let focusCutawayState = null;

  function readFocusCutaway() {
    if (!village.active || !village.selected || !village.handle?.focusTerrainCutaway) {
      focusCutawayState = null;
      return null;
    }
    focusCutawayState = village.handle.focusTerrainCutaway(
      village.selected,
      camera.position,
      controls.target,
    );
    return focusCutawayState;
  }
  // OrbitControls.update() 는 enableZoom 과 무관하게 매 프레임 궤도 반경을 [minDistance, maxDistance]
  //   로 자른다. 그래서 옛 장면의 클램프가 남아 있으면 **저작된 트윈 종점이 핸드오프 프레임에서 잘려**
  //   한 프레임에 줌인된다: 실측(규모 커밋 village→town) 리프레임 트윈이 656m 에 도착한 다음 프레임에
  //   구 마을 max(536.9m)로 119.4m 스냅되고, 그 뒤로도 저작된 부감 거리로 돌아오지 못했다.
  //   그러므로 전환(lock) 구간에는 거리 클램프도 함께 놓고, 정착 시 다시 세운다.
  const LOCK_MIN_DISTANCE = 0.05;
  const LOCK_MAX_DISTANCE = Infinity;
  // 정착 시 현재 거리가 새 범위 밖이면 클램프를 즉시 조이지 않고 이 시간 동안 목표 범위로 좁힌다.
  //   OrbitControls 가 매 프레임 그 움직이는 경계로 자르므로, 카메라는 별도 writer 없이 같은 이징을
  //   따라 들어온다(리롤로 마을 반경이 줄어든 경우가 이 경로다).
  const BOUNDS_EASE_DUR = 0.7;
  let boundsEase = null;
  const smoothstep01 = (t) => t * t * (3 - 2 * t);

  function writeDistanceBounds(min, max) {
    controls.minDistance = min;
    controls.maxDistance = max;
  }

  // 새 범위가 현재 포즈를 자르지 않는다면 그대로 쓰고, 자른다면 현재 거리에서 시작해 좁혀 들어간다.
  function applyDistanceBounds(min, max) {
    const distance = camera.position.distanceTo(controls.target);
    const needsEase = Number.isFinite(distance)
      && distance > 1e-6
      && (distance > max + 1e-3 || distance < min - 1e-3);
    if (!needsEase) {
      boundsEase = null;
      writeDistanceBounds(min, max);
      return;
    }
    boundsEase = {
      fromMin: Math.min(min, distance),
      fromMax: Math.max(max, distance),
      toMin: min,
      toMax: max,
      e: 0,
      dur: BOUNDS_EASE_DUR,
    };
    writeDistanceBounds(boundsEase.fromMin, boundsEase.fromMax);
  }

  // 렌더 루프가 OrbitControls.update 전에 호출한다.
  function updateZoomBounds(dt) {
    if (!boundsEase) return false;
    boundsEase.e += Math.max(0, dt);
    const k = smoothstep01(Math.min(1, boundsEase.e / boundsEase.dur));
    const min = boundsEase.fromMin + (boundsEase.toMin - boundsEase.fromMin) * k;
    const max = boundsEase.fromMax + (boundsEase.toMax - boundsEase.fromMax) * k;
    writeDistanceBounds(min, max);
    if (k >= 1) boundsEase = null;
    return true;
  }

  function setRegime(mode, closeupDistance = 0) {
    regime = mode;
    const legacyFlow = typeof window !== 'undefined' && window.__camFlowLegacy === true;
    if (mode === 'lock') {
      controls.enableZoom = false;
      if (!legacyFlow) {
        boundsEase = null;
        writeDistanceBounds(LOCK_MIN_DISTANCE, LOCK_MAX_DISTANCE);
      }
      return;
    }
    // 리롤·규모 커밋 뒤 부감 단위는 새 핸들·현재 aspect 에서 다시 읽어야 한다. 종전에는 웨이브 완료
    //   시점의 setRegime('explore') 이 **옛 마을** aerialReferenceDist 로 범위를 세웠다.
    if (mode === 'explore' && !legacyFlow) syncAerialReference();
    const aerialReference = referenceAerialDistance();
    if (mode === 'focus' && closeupDistance > 0) {
      focusCloseupReference = villageScreenDistanceForCamera(closeupDistance, camera);
      const direction = focusDirection.subVectors(camera.position, controls.target);
      const distance = direction.length();
      focusBaseElevation = distance > 1e-6
        ? Math.asin(Math.max(-1, Math.min(1, direction.y / distance))) : 0;
      focusElevationOffset = 0;
      focusAppliedElevation = focusBaseElevation;
    }
    const bounds = villageZoomReferenceBounds(mode, aerialReference, focusCloseupReference);
    controls.enableZoom = true;
    if (legacyFlow) {
      boundsEase = null;
      writeDistanceBounds(actualDistance(bounds.min), actualDistance(bounds.max));
      return;
    }
    applyDistanceBounds(actualDistance(bounds.min), actualDistance(bounds.max));
  }

  // 컷어웨이가 지형을 걷어낸 프레임만 그 전경 식생도 동반 은닉한다(부유 수관 해소). 코어가 컷 깊이
  //   여유·인스턴스 은닉을 소유하므로 여기서는 실제로 적용한 near 하나만 넘긴다. 미적용 프레임의 0 은
  //   해제 신호이며 코어가 이징으로 되돌린다(팝 없음).
  function applyVegetationCut(nearPlane) {
    village.handle?.setFocusVegetationCut?.(nearPlane);
    return nearPlane || 0;
  }

  function near() {
    let distance = camera.position.distanceTo(controls.target);
    const baseNear = () => Math.min(
      BASE_NEAR_MAX,
      Math.max(BASE_NEAR_MIN, distance * BASE_NEAR_FRAC),
    );
    let cutaway = readFocusCutaway();
    if (!cutaway) {
      applyVegetationCut(0);
      return baseNear();
    }
    // A plane that reaches the nearest house surface is rejected. Only this
    // exceptional case moves the real camera into the first terrain-safe
    // interval, retaining the current narrow lens instead of widening it.
    for (let attempt = 0; attempt < 3
      && cutaway?.active && !cutaway.available
      && cutaway.safeScale > 1e-6 && cutaway.safeScale < 1 - 1e-6; attempt++) {
      camera.position.lerp(controls.target, 1 - cutaway.safeScale);
      camera.lookAt(controls.target);
      distance = camera.position.distanceTo(controls.target);
      cutaway = readFocusCutaway();
    }
    focusCutawayState = cutaway;
    if (!cutaway?.active || !cutaway.available) {
      applyVegetationCut(0);
      return baseNear();
    }
    // Leave a finite interval before the sampled front face even when floating
    // point noise puts a plane exactly on its accepted limit.
    return applyVegetationCut(Math.min(
      cutaway.subjectNear - 0.5,
      Math.max(baseNear(), cutaway.near),
    ));
  }

  // 대기 밴드의 권위는 코어 핸들(env/village-fog-band.js)이 갖는다. 밴드는 카메라→분지 중심 거리
  //   파생이므로 부감·드론·아이레벨·망원 근접이 모두 같은 식에서 나온다(#31).
  //   구 규약은 분지 반경 파생(near=R*2.2)이었고 근접 프레임만 예외적으로 카메라 거리 바닥을
  //   덧댔다: 측정(village/7 히어로) — 피사체 155m, 그 뒤 배산 사면 232m, fog near 396m. 배경이
  //   안개 밴드 **앞**에 있어 대기 원근이 0 이었고, 리빌이 열리는 동안(near 90→396m) 프레임이
  //   점점 어두워졌다(상단 밴드 중값 165 → 36). #31 진단에서 그 결함이 근접 전용이 아니라 **전
  //   프레이밍**이었음이 확인됐다(부감 capital near 616m vs 최원 지오메트리 279m → fogFactor 0).
  //   그래서 카메라 거리 파생이 예외가 아니라 기본이 됐고, fogBandFloor 는 그보다 더 당겨야 하는
  //   프레임(망원 근접 정착)만 추가로 조이는 상한으로 남는다.
  let fogBandFloor = null;   // { nearScale, spanScale } — 카메라→피사체 거리 배수. null=코어 밴드 그대로
  function setFogBandFloor(floor) {
    fogBandFloor = floor && Number.isFinite(floor.nearScale) && Number.isFinite(floor.spanScale)
      ? { nearScale: floor.nearScale, spanScale: floor.spanScale } : null;
  }
  function fogBand({ snap = false } = {}) {
    const handle = village.handle;
    const radius = handle?.plan?.site?.R || 180;
    const base = (snap ? handle?.snapFogBand?.(camera) : handle?.fogBand?.())
      || { near: radius * 2.2, far: radius * 7.0 };
    if (!fogBandFloor) return base;
    const distance = camera.position.distanceTo(controls.target);
    if (!(distance > 1e-3)) return base;
    const near = Math.min(base.near, distance * fogBandFloor.nearScale);
    return { near, far: Math.min(base.far, near + distance * fogBandFloor.spanScale) };
  }

  function reapplyFog() {
    if (!village.active || !village.handle) return;
    const radius = village.handle.plan.site.R;
    if (scene.fog) {
      // 즉시 경로(마을 진입·시네마틱 시작/종료·규모 커밋 직후)라 추종을 기다리지 않고 스냅한다.
      //   여기서 추종을 쓰면 진입 첫 프레임이 폴백 거리(부감 기준)의 밴드로 한 번 그려진다.
      const band = fogBand({ snap: true });
      scene.fog.near = band.near;
      scene.fog.far = band.far;
    }
    camera.far = radius * 8;
    camera.near = near();
    camera.updateProjectionMatrix();
  }

  function distanceAtFraction(fraction) {
    return actualDistance(referenceAerialDistance() * fraction);
  }

  function focusEffectWeight() {
    return focusEffectWeightForDistance(
      villageScreenDistanceForCamera(camera.position.distanceTo(controls.target), camera),
      referenceAerialDistance(),
      focusCloseupReference,
    );
  }

  function semanticBounds(mode) {
    return villageZoomReferenceBounds(
      mode,
      referenceAerialDistance(),
      mode === 'focus' ? focusCloseupReference : 0,
    );
  }

  function semanticTargetContract(mode) {
    if (mode === 'explore') {
      // Target only — never call aerial() here. Capture used to measure zoom
      // against pre-aerial bounds then mutate aerialReferenceDist as a side
      // effect; restore called setRegime before that mutation and OrbitControls
      // maxDistance clamped the restored dolly (share zoom round-trip break).
      const radius = outerRadius();
      return {
        target: exploreTarget(radius),
        scale: Math.max(1, radius),
      };
    }
    const framing = village.handle?.getPickProxy?.(village.selected)?.cameraFraming;
    if (!framing?.target || !(focusCloseupReference > 0)) return null;
    return {
      target: semanticTarget.copy(framing.target),
      scale: Math.max(1, focusCloseupReference),
    };
  }

  // A shareable view is relative to the current semantic target. It intentionally
  // omits raw world position/target/quaternion: those become stale when a
  // deterministic planner improves while parcel identity and composition remain
  // meaningful.
  function captureView() {
    const mode = village.selected ? 'focus' : 'explore';
    if (!village.active || village.transitioning || village.wave || regime !== mode) return null;
    const direction = focusDirection.subVectors(camera.position, controls.target);
    const distance = direction.length();
    if (!(distance > 1e-6)) return null;
    // Explore zoom is a fraction of the aspect-dependent aerial unit. Sync the
    // unit to the live container aspect before measuring so share/restore and
    // resize preserve agree (stale aerialReferenceDist from a portrait solve
    // would otherwise re-encode the same pose as a different zoom).
    if (mode === 'explore') syncAerialReference();
    const referenceDistance = villageScreenDistanceForCamera(distance, camera);
    const bounds = semanticBounds(mode);
    const span = bounds.max - bounds.min;
    const targetContract = semanticTargetContract(mode);
    if (!(span > 1e-6) || !targetContract) return null;
    return captureSemanticOrbit({
      position: camera.position,
      target: controls.target,
      canonicalTarget: targetContract.target,
      panScale: targetContract.scale,
      zoom: (referenceDistance - bounds.min) / span,
    });
  }

  function restoreView(view) {
    if (!view || !village.active || village.transitioning || village.wave) return false;
    const mode = village.selected ? 'focus' : 'explore';
    const zoom = Number(view.zoom);
    if (!Number.isFinite(zoom) || zoom < 0 || zoom > 1) return false;

    if (mode === 'explore') {
      camera.fov = VILLAGE_LENS.aerial.fov;
      camera.userData.villageReferenceFov = VILLAGE_LENS.aerial.referenceFov;
      camera.updateProjectionMatrix();
      // Live stage box first, then continuum + OrbitControls min/max *before*
      // placing the camera. setRegime-after-stale-aerialReferenceDist left
      // maxDistance short of the restored dolly; controls.update(0) then clamped
      // share restores (e.g. zoom 0.882 → visual 1.06×stale unit).
      matchCameraAspectToContainer();
      syncAerialReference();
      setRegime('explore');
    } else if (regime !== 'focus' || !(focusCloseupReference > 0)) {
      return false;
    }
    const targetContract = semanticTargetContract(mode);
    if (!targetContract) return false;
    const bounds = semanticBounds(mode);
    const referenceDistance = bounds.min + (bounds.max - bounds.min) * zoom;
    const distance = actualDistance(referenceDistance);
    const orbit = restoreSemanticOrbit(view, {
      canonicalTarget: targetContract.target,
      panScale: targetContract.scale,
      distance,
    });
    if (!orbit) return false;
    controls.target.set(orbit.target.x, orbit.target.y, orbit.target.z);
    camera.position.set(orbit.position.x, orbit.position.y, orbit.position.z);
    // Re-assert regime bounds after the pose write so a prior shorter maxDistance
    // cannot survive into the next OrbitControls frame.
    if (mode === 'explore') setRegime('explore');
    camera.near = near();
    camera.updateProjectionMatrix();
    camera.lookAt(controls.target);
    controls.update(0);
    if (mode === 'focus') {
      const elevation = Number(view.elevation) * DEG;
      const pathElevation = villageFocusContextElevation(
        referenceDistance,
        referenceAerialDistance(),
        focusCloseupReference,
        focusBaseElevation,
      );
      focusElevationOffset = elevation - pathElevation;
      focusAppliedElevation = elevation;
    }
    return true;
  }

  // 망원 근경을 남측 축으로 직선 후퇴시키면 근경 프레임 밖에 예약된 정자·높은 공공 오브젝트가
  // 넓어진 시야에서 선택 집을 가릴 수 있다. 같은 일조 개방축 위에서 줌아웃 진행도만큼 크레인 업하되,
  // 사용자가 OrbitControls로 더한 수직 오프셋은 다음 프레임에도 보존한다.
  function updateFocusContext() {
    if (regime !== 'focus' || !village.selected) return 0;
    const direction = focusDirection.subVectors(camera.position, controls.target);
    const distance = direction.length();
    if (distance <= 1e-6) return 0;
    const currentElevation = Math.asin(Math.max(-1, Math.min(1, direction.y / distance)));
    if (focusAppliedElevation != null) {
      focusElevationOffset += currentElevation - focusAppliedElevation;
    }
    const referenceDistance = villageScreenDistanceForCamera(distance, camera);
    const effectWeight = focusEffectWeightForDistance(
      referenceDistance, referenceAerialDistance(), focusCloseupReference,
    );
    const pathElevation = villageFocusContextElevation(
      referenceDistance,
      referenceAerialDistance(),
      focusCloseupReference,
      focusBaseElevation,
    );
    const desiredElevation = Math.max(0.02, Math.min(
      Math.PI / 2 - 0.03,
      pathElevation + focusElevationOffset,
    ));
    const horizontal = Math.hypot(direction.x, direction.z);
    if (horizontal > 1e-6) {
      const horizontalDistance = Math.cos(desiredElevation) * distance;
      const scale = horizontalDistance / horizontal;
      camera.position.set(
        controls.target.x + direction.x * scale,
        controls.target.y + Math.sin(desiredElevation) * distance,
        controls.target.z + direction.z * scale,
      );
      camera.lookAt(controls.target);
    }
    focusAppliedElevation = desiredElevation;
    return effectWeight;
  }

  return {
    aerial,
    syncAerialReference,
    setTimeOfDay,
    near,
    outerRadius,
    reapplyFog,
    fogBand,
    setFogBandFloor,
    setRegime,
    updateZoomBounds,
    distanceAtFraction,
    focusEffectWeight,
    updateFocusContext,
    captureView,
    restoreView,
    debugContinuum: () => ({
      mode: regime,
      active: village.active,
      selected: village.selected,
      transitioning: village.transitioning,
      wave: !!village.wave,
      timeOfDay,
      aerialElevationDeg: +(villageAerialElevation(timeOfDay) / DEG).toFixed(2),
      aerialDist: +(village.aerialDist || 0).toFixed(1),
      aerialReferenceDist: +referenceAerialDistance().toFixed(1),
      dist: +camera.position.distanceTo(controls.target).toFixed(1),
      minDistance: +controls.minDistance.toFixed(1),
      maxDistance: Number.isFinite(controls.maxDistance) ? +controls.maxDistance.toFixed(1) : null,
      boundsEasing: !!boundsEase,
      visualDist: +villageScreenDistanceForCamera(
        camera.position.distanceTo(controls.target), camera,
      ).toFixed(1),
      referenceFov: +referenceFovForCamera(camera).toFixed(2),
      exploreMinReferenceDist: +villageZoomReferenceBounds(
        'explore', referenceAerialDistance(),
      ).min.toFixed(1),
      exploreMaxReferenceDist: +villageZoomReferenceBounds(
        'explore', referenceAerialDistance(),
      ).max.toFixed(1),
      focusMaxReferenceDist: +villageZoomReferenceBounds(
        'focus', referenceAerialDistance(), focusCloseupReference,
      ).max.toFixed(1),
      focusMaxActualDist: +actualDistance(villageZoomReferenceBounds(
        'focus', referenceAerialDistance(), focusCloseupReference,
      ).max).toFixed(1),
      focusEffectWeight: +focusEffectWeight().toFixed(3),
      // 1 at the protected focus minimum (eave-appreciation pose), 0 at the authored
      // closeup and beyond. Residential path elevation reads this same continuum.
      focusEaveWeight: +focusEaveWeightForDistance(
        villageScreenDistanceForCamera(
          camera.position.distanceTo(controls.target), camera,
        ),
        referenceAerialDistance(),
        focusCloseupReference,
      ).toFixed(3),
      focusCutaway: focusCutawayState ? {
        active: focusCutawayState.active,
        available: focusCutawayState.available,
        near: +focusCutawayState.near.toFixed(3),
        subjectNear: +focusCutawayState.subjectNear.toFixed(3),
        blockedRays: focusCutawayState.blockedRays,
        contactRays: focusCutawayState.contactRays,
        boundaryRays: focusCutawayState.boundaryRays,
        minClearance: +focusCutawayState.minClearance.toFixed(3),
        cameraClearance: +focusCutawayState.cameraClearance.toFixed(3),
        safeScale: +focusCutawayState.safeScale.toFixed(6),
        reason: focusCutawayState.reason,
      } : null,
      elevation: +(Math.asin(Math.max(-1, Math.min(1,
        focusDirection.subVectors(camera.position, controls.target).y
          / Math.max(1e-6, camera.position.distanceTo(controls.target)),
      ))) / DEG).toFixed(1),
    }),
  };
}
