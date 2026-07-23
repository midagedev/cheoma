import * as THREE from 'three';
import {
  VILLAGE_FOCUS_CONTEXT_ELEVATION,
  VILLAGE_LENS,
  dollyDistanceForFov,
  referenceFovForCamera,
  villageScreenDistance,
  villageScreenDistanceForCamera,
  villageFocusContextElevation,
  villageFocusEffectWeight as focusEffectWeightForDistance,
  villageZoomReferenceBounds,
} from '../../../src/api/cinematic.js';
import {
  captureSemanticOrbit,
  restoreSemanticOrbit,
} from './semantic-view-runtime.js';

const DEG = Math.PI / 180;
const AERIAL_AZIMUTH = 9 * DEG;
const NEAR_FRAC = 0.02;
const NEAR_MIN = 0.08;
const NEAR_MAX = 2.5;

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

  function aerial(handle = village.handle) {
    const radius = outerRadius(handle);
    const aspect = camera.aspect || (container.clientWidth / container.clientHeight) || 1.6;
    const fill = aspect >= 1 ? 0.60 : 0.70;
    const referenceDistance = radius / (0.40 * fill * aspect);
    const distance = dollyDistanceForFov(
      referenceDistance,
      VILLAGE_LENS.aerial.referenceFov,
      VILLAGE_LENS.aerial.fov,
    );
    village.aerialReferenceDist = referenceDistance;
    village.aerialDist = distance;
    const target = new THREE.Vector3(0, radius * 0.05, -radius * 0.10);
    const pos = new THREE.Vector3(
      target.x + distance * Math.cos(VILLAGE_FOCUS_CONTEXT_ELEVATION) * Math.sin(AERIAL_AZIMUTH),
      target.y + distance * Math.sin(VILLAGE_FOCUS_CONTEXT_ELEVATION),
      target.z + distance * Math.cos(VILLAGE_FOCUS_CONTEXT_ELEVATION) * Math.cos(AERIAL_AZIMUTH),
    );
    return {
      pos,
      target,
      fov: VILLAGE_LENS.aerial.fov,
      referenceFov: VILLAGE_LENS.aerial.referenceFov,
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
  function setRegime(mode, closeupDistance = 0) {
    regime = mode;
    if (mode === 'lock') {
      controls.enableZoom = false;
      return;
    }
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
    controls.minDistance = actualDistance(bounds.min);
    controls.maxDistance = actualDistance(bounds.max);
  }

  function near() {
    const distance = camera.position.distanceTo(controls.target);
    return Math.min(NEAR_MAX, Math.max(NEAR_MIN, distance * NEAR_FRAC));
  }

  function reapplyFog() {
    if (!village.active || !village.handle) return;
    const radius = village.handle.plan.site.R;
    if (scene.fog) {
      scene.fog.near = radius * 2.2;
      scene.fog.far = radius * 7.0;
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
      const frame = aerial();
      return {
        target: semanticTarget.copy(frame.target),
        scale: Math.max(1, outerRadius()),
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
    near,
    outerRadius,
    reapplyFog,
    setRegime,
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
      aerialDist: +(village.aerialDist || 0).toFixed(1),
      aerialReferenceDist: +referenceAerialDistance().toFixed(1),
      dist: +camera.position.distanceTo(controls.target).toFixed(1),
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
      elevation: +(Math.asin(Math.max(-1, Math.min(1,
        focusDirection.subVectors(camera.position, controls.target).y
          / Math.max(1e-6, camera.position.distanceTo(controls.target)),
      ))) / DEG).toFixed(1),
    }),
  };
}
