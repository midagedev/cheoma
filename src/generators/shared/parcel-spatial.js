import { facingY } from '../../core/math/geom2.js';
import { VILLAGE_LENS, dollyDistanceForFov } from '../../camera/optics.js';

const DEG = Math.PI / 180;
// Stay inside the south-light opening instead of orbiting far enough sideways for
// public structures to enter the view axis. A shallow three-quarter angle still
// reveals bay depth while reading primarily as the house's south-facing elevation.
const FOCUS_AZIMUTH_MAX = 14 * DEG;
// Aim at the doors while retaining enough physical camera height to see across a
// dense village. The protected south-light opening now keeps the foreground corridor
// clear enough for a lower architectural viewpoint: 3° reads from the yard toward the
// eaves and sky, while still retaining enough lift to see across a wall or gate.
const FOCUS_ELEVATION = 3 * DEG;
const FOCUS_DISTANCE = dollyDistanceForFov(
  2.25,
  VILLAGE_LENS.parcel.referenceFov,
  VILLAGE_LENS.parcel.fov,
);

// A focused house is composed around its doors, not the roof mass. Keeping this
// pure value beside the XZ framing lets picking, hero landing, and regression
// checks share one semantic aim point without renderer-only corrections.
export function parcelFocusTargetLift(height) {
  return Math.max(1.65, Math.min(2.5, height * 0.26));
}

// THREE.Vector3.applyAxisAngle(Y, angle)의 연산 순서를 그대로 옮긴 순수 helper. 단순 cos/sin
// 전개는 수학적으로 같아도 마지막 비트가 달라 기존 pick-proxy 결정론 해시가 바뀐다.
function rotateFocusOffsetY(x, y, z, angle) {
  const half = angle / 2, s = Math.sin(half);
  const qx = 0 * s, qy = s, qz = 0 * s, qw = Math.cos(half);
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  return {
    x: x + qw * tx + qy * tz - qz * ty,
    y: y + qw * ty + qz * tx - qx * tz,
    z: z + qw * tz + qx * ty - qy * tx,
  };
}

// 필지와 집 생성기가 공유하는 월드 회전 계약. THREE가 필요 없는 계획/회귀 검사에서도
// 포커스 카메라와 실제 인스턴스가 같은 방향을 사용하도록 순수 모듈에 둔다.
export function parcelRotY(parcel) {
  return facingY(parcel.frontDir) + (parcel.yaw || 0);
}

function parcelBounds(parcel) {
  const points = parcel.shape?.pts;
  if (!points || points.length < 3) {
    return { width: parcel.plotW, depth: parcel.plotD, centerX: 0, centerZ: 0 };
  }
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x);
    minZ = Math.min(minZ, point.z); maxZ = Math.max(maxZ, point.z);
  }
  return {
    width: maxX - minX,
    depth: maxZ - minZ,
    centerX: (minX + maxX) / 2,
    centerZ: (minZ + maxZ) / 2,
  };
}

function parcelFocusAzimuth(parcel, bounds) {
  const corridor = parcel.solarAccess;
  if (!corridor) return FOCUS_AZIMUTH_MAX;
  const forward = Math.max(1, corridor.localEnd - bounds.centerZ);
  // Turn away from an off-centre fitted house, then clamp the angle so the ray at
  // the end of the reserved solar opening still keeps a small lateral margin.
  const sign = bounds.centerX > 0 ? -1 : 1;
  const available = Math.max(0.2, corridor.halfWidth - 0.3 + Math.abs(bounds.centerX));
  return sign * Math.min(FOCUS_AZIMUTH_MAX, Math.atan2(available, forward));
}

// 필지 포커스 프록시와 카메라의 순수 XZ 계획. picking.js가 THREE 객체를 조립하고,
// DOM/THREE 없는 계약 검사는 같은 결과를 직접 소비한다.
export function planParcelFocus(parcel) {
  const bounds = parcelBounds(parcel);
  const width = bounds.width * 1.08;
  const depth = bounds.depth * 1.08;
  const height = parcel.hero ? 14 : (parcel.kind === 'giwa' ? 9 : 6.5);
  const rotationY = parcelRotY(parcel);
  const azimuth = parcelFocusAzimuth(parcel, bounds);
  const cos = Math.cos(rotationY), sin = Math.sin(rotationY);
  const worldX = parcel.center.x + bounds.centerX * cos + bounds.centerZ * sin;
  const worldZ = parcel.center.z - bounds.centerX * sin + bounds.centerZ * cos;
  const radius = FOCUS_DISTANCE * Math.max(width, depth, height);
  const horizontal = radius * Math.cos(FOCUS_ELEVATION);
  const localX = horizontal * Math.sin(azimuth);
  const localZ = horizontal * Math.cos(azimuth);
  const offset = rotateFocusOffsetY(
    localX,
    radius * Math.sin(FOCUS_ELEVATION),
    localZ,
    rotationY,
  );
  return {
    width,
    depth,
    height,
    rotationY,
    worldX,
    worldZ,
    cameraX: worldX + offset.x,
    cameraZ: worldZ + offset.z,
    cameraLift: offset.y,
    targetLift: parcelFocusTargetLift(height),
    fov: VILLAGE_LENS.parcel.fov,
    referenceFov: VILLAGE_LENS.parcel.referenceFov,
  };
}
