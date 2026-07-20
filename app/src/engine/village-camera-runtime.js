import * as THREE from 'three';

const DEG = Math.PI / 180;
const AERIAL_FOV = 42;
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
    const distance = radius / (0.40 * fill * aspect);
    village.aerialDist = distance;
    const target = new THREE.Vector3(0, radius * 0.05, -radius * 0.10);
    const pos = new THREE.Vector3(
      target.x + distance * Math.cos(AERIAL_ELEVATION) * Math.sin(AERIAL_AZIMUTH),
      target.y + distance * Math.sin(AERIAL_ELEVATION),
      target.z + distance * Math.cos(AERIAL_ELEVATION) * Math.cos(AERIAL_AZIMUTH),
    );
    return { pos, target, fov: AERIAL_FOV };
  }

  function setRegime(mode, closeupDistance = 0) {
    const aerialDistance = village.aerialDist || 150;
    if (mode === 'aerial') {
      controls.enableZoom = true;
      controls.minDistance = aerialDistance * (ZOOM_ENTER_FRAC * 0.82);
      controls.maxDistance = aerialDistance * 1.06;
    } else if (mode === 'focus') {
      controls.enableZoom = true;
      controls.minDistance = Math.max(1.2, closeupDistance * 0.16);
      controls.maxDistance = aerialDistance * (ZOOM_EXIT_FRAC * 1.06);
    } else {
      controls.enableZoom = false;
    }
  }

  function parcelDistance(parcelId) {
    if (!parcelId || !village.handle) return Infinity;
    const proxy = village.handle.getPickProxies().find((item) => item.parcelId === parcelId);
    return proxy ? camera.position.distanceTo(proxy.worldCenter) : Infinity;
  }

  function updateContinuum() {
    if (!village.active || isBusy()) return;
    const aerialDistance = village.aerialDist || 0;
    if (aerialDistance <= 0) return;
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
      const distance = parcelDistance(candidate);
      if (distance < aerialDistance * (ZOOM_ENTER_FRAC + 0.28)
        && candidate !== getHoverParcel()) {
        village.handle.highlightParcel(candidate, true);
      }
      if (distance < aerialDistance * ZOOM_ENTER_FRAC) {
        village.zoomCand = null;
        onSelect(candidate);
      }
    } else if (camera.position.distanceTo(controls.target) > aerialDistance * ZOOM_EXIT_FRAC) {
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

  return {
    aerial,
    near,
    outerRadius,
    reapplyFog,
    setRegime,
    updateContinuum,
    debugContinuum: () => ({
      active: village.active,
      selected: village.selected,
      transitioning: village.transitioning,
      wave: !!village.wave,
      zoomCand: village.zoomCand,
      aerialDist: +(village.aerialDist || 0).toFixed(1),
      dist: +camera.position.distanceTo(controls.target).toFixed(1),
      enterDist: +((village.aerialDist || 0) * ZOOM_ENTER_FRAC).toFixed(1),
      exitDist: +((village.aerialDist || 0) * ZOOM_EXIT_FRAC).toFixed(1),
    }),
  };
}
