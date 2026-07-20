import * as THREE from 'three';

const DEG = Math.PI / 180;

function orbitSpot(target, maxDim, { az, el, r }) {
  const azimuth = az * DEG;
  const elevation = el * DEG;
  const radius = r * maxDim;
  return new THREE.Vector3(
    target.x + radius * Math.cos(elevation) * Math.sin(azimuth),
    target.y + radius * Math.sin(elevation),
    target.z + radius * Math.cos(elevation) * Math.cos(azimuth),
  );
}

// 단일 건물 카메라 프리셋. layout만 입력받아 scene 상태와 무관하게 계산한다.
export function buildingSpot(name, layout) {
  const maxDim = Math.max(layout.W + 4, layout.D + 4, layout.totalH);
  const target = new THREE.Vector3(0, layout.totalH * 0.42, 0);
  const spots = {
    front: { az: 0, el: 7, r: 2.9 },
    'three-quarter': { az: 38, el: 13, r: 3.0 },
    side: { az: 90, el: 8, r: 2.9 },
    roof: { az: 42, el: 36, r: 2.9 },
    closeup: { az: 42, el: -12, r: 0.76, ty: layout.plateY + 0.8 },
    focus: { az: 34, el: 10, r: 2.35 },
  };
  const spot = spots[name] || spots['three-quarter'];
  if (spot.ty !== undefined) target.y = spot.ty;
  return { pos: orbitSpot(target, maxDim, spot), target };
}

// 선택·확장 프레이밍. 날개가 늘어날수록 마당 전체가 들어오도록 반경과 고도를 넓힌다.
export function expandedBuildingSpot(layout, expansion) {
  const maxDim = Math.max(layout.W + 4, layout.D + 4, layout.totalH)
    * (1 + 0.34 * (expansion - 1));
  const target = new THREE.Vector3(
    0,
    layout.totalH * 0.42,
    expansion > 1 ? layout.D * 0.35 : 0,
  );
  const spot = {
    az: 34,
    el: expansion > 1 ? 17 : 11,
    r: expansion > 1 ? 2.55 : 2.35,
  };
  return { pos: orbitSpot(target, maxDim, spot), target };
}
