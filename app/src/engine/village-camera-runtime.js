import * as THREE from 'three';
import {
  VILLAGE_LENS,
  dollyDistanceForFov,
  referenceFovForCamera,
  villageScreenDistance,
  villageScreenDistanceForCamera,
} from '../../../src/api/cinematic.js';

const DEG = Math.PI / 180;
const AERIAL_ELEVATION = 31 * DEG;
const AERIAL_AZIMUTH = 9 * DEG;
const ZOOM_ENTER_FRAC = 0.52;
const ZOOM_EXIT_FRAC = 0.72;
const NEAR_FRAC = 0.02;
const NEAR_MIN = 0.08;
const NEAR_MAX = 2.5;

// 마을 배율의 카메라 프레이밍·줌 연속체·깊이 범위를 한곳에서 관리한다.
export function createVillageCameraRuntime({
  camera,
  centerParcel,
  container,
  controls,
  getHoverParcel,
  isBusy,
  onReturn,
  onSelect,
  scene,
  village,
} = {}) {
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
      target.x + distance * Math.cos(AERIAL_ELEVATION) * Math.sin(AERIAL_AZIMUTH),
      target.y + distance * Math.sin(AERIAL_ELEVATION),
      target.z + distance * Math.cos(AERIAL_ELEVATION) * Math.cos(AERIAL_AZIMUTH),
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

  function setRegime(mode, closeupDistance = 0) {
    const aerialReference = referenceAerialDistance();
    if (mode === 'aerial') {
      controls.enableZoom = true;
      controls.minDistance = actualDistance(aerialReference * (ZOOM_ENTER_FRAC * 0.82));
      controls.maxDistance = actualDistance(aerialReference * 1.06);
    } else if (mode === 'focus') {
      controls.enableZoom = true;
      controls.minDistance = Math.max(1.2, closeupDistance * 0.16);
      controls.maxDistance = actualDistance(aerialReference * (ZOOM_EXIT_FRAC * 1.06));
    } else {
      controls.enableZoom = false;
    }
  }

  let distanceHandle = null;
  let distanceParcelId = null;
  let distanceWorldCenter = null;
  function parcelDistance(parcelId) {
    const handle = village.handle;
    if (!parcelId || !handle) {
      distanceHandle = null;
      distanceParcelId = null;
      distanceWorldCenter = null;
      return Infinity;
    }
    // zoom candidate는 여러 프레임 유지된다. 같은 handle/id에서는 첫 단건 조회의
    // 복제본을 재사용해, steady-state 거리 계산을 무할당으로 유지한다.
    if (handle !== distanceHandle || parcelId !== distanceParcelId) {
      const proxy = handle.getPickProxy(parcelId);
      distanceHandle = handle;
      distanceParcelId = parcelId;
      distanceWorldCenter = proxy?.worldCenter || null;
    }
    return distanceWorldCenter ? camera.position.distanceTo(distanceWorldCenter) : Infinity;
  }

  function updateContinuum() {
    if (!village.active || isBusy()) return;
    const aerialReference = referenceAerialDistance();
    if (aerialReference <= 0) return;
    if (!village.selected) {
      const now = performance.now();
      if (now - village.lastCenterT > 90) {
        village.lastCenterT = now;
        const candidate = centerParcel();
        if (candidate !== village.zoomCand) {
          if (village.zoomCand && village.zoomCand !== getHoverParcel()) {
            village.handle.highlightParcel(village.zoomCand, false);
          }
          village.zoomCand = candidate;
        }
      }
      const candidate = village.zoomCand;
      if (!candidate) return;
      const distance = villageScreenDistanceForCamera(parcelDistance(candidate), camera);
      if (distance < aerialReference * (ZOOM_ENTER_FRAC + 0.28)
        && candidate !== getHoverParcel()) {
        village.handle.highlightParcel(candidate, true);
      }
      if (distance < aerialReference * ZOOM_ENTER_FRAC) {
        village.zoomCand = null;
        onSelect(candidate);
      }
    } else if (villageScreenDistanceForCamera(
      camera.position.distanceTo(controls.target), camera,
    ) > aerialReference * ZOOM_EXIT_FRAC) {
      onReturn();
    }
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

  return {
    aerial,
    near,
    outerRadius,
    reapplyFog,
    setRegime,
    updateContinuum,
    distanceAtFraction,
    debugContinuum: () => ({
      active: village.active,
      selected: village.selected,
      transitioning: village.transitioning,
      wave: !!village.wave,
      zoomCand: village.zoomCand,
      aerialDist: +(village.aerialDist || 0).toFixed(1),
      aerialReferenceDist: +referenceAerialDistance().toFixed(1),
      dist: +camera.position.distanceTo(controls.target).toFixed(1),
      visualDist: +villageScreenDistanceForCamera(
        camera.position.distanceTo(controls.target), camera,
      ).toFixed(1),
      referenceFov: +referenceFovForCamera(camera).toFixed(2),
      enterDist: +(referenceAerialDistance() * ZOOM_ENTER_FRAC).toFixed(1),
      exitDist: +(referenceAerialDistance() * ZOOM_EXIT_FRAC).toFixed(1),
      enterActualDist: +actualDistance(referenceAerialDistance() * ZOOM_ENTER_FRAC).toFixed(1),
      exitActualDist: +actualDistance(referenceAerialDistance() * ZOOM_EXIT_FRAC).toFixed(1),
    }),
  };
}
