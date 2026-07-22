// Shared lens and view-relative zoom policy for the village camera.
//
// A focal-length change only becomes visible as perspective when the camera also
// dollies: wide aerial views move closer, telephoto house views move farther away.
// The helpers below preserve projected subject scale while changing that depth
// compression, and let screen-space LOD ignore the compensating dolly distance.

const DEG = Math.PI / 180;
export const VILLAGE_FOCUS_CONTEXT_ELEVATION = 31 * DEG;
// Shared close-parcel pose. Eighteen degrees keeps the courtyard readable while retaining
// an architectural, rather than aerial, view across the tested residential variants.
// Keep the projection centered: a sky-biased lens shift crops the foreground yard and
// hides the animals and household details this elevation is meant to reveal.
export const VILLAGE_FOCUS_ELEVATION = 18 * DEG;
export const VILLAGE_FOCUS_SKY_FRACTION = 0;

const lens = (fov, referenceFov) => Object.freeze({ fov, referenceFov });

export const VILLAGE_LENS = Object.freeze({
  aerial: lens(46, 42),
  parcel: lens(20, 23),
  hero: lens(18, 21),
  palace: lens(24, 32),
  temple: lens(26, 34),
});

// 휠/핀치는 현재 보기 안의 구도만 바꾸고 explore↔focus 상태를 전환하지 않는다.
// 화면 등가 거리(reference FOV 기준)로 한 번 정의해 광각 부감·망원 근경이 같은 범위를 소비한다.
export const VILLAGE_ZOOM = Object.freeze({
  explore: Object.freeze({
    minReferenceFraction: 0.16,
    minReferenceFloor: 6,
    minReferenceCap: 24,
    maxReferenceFraction: 1.06,
  }),
  focus: Object.freeze({
    minCloseupFraction: 0.42,
    minReferenceFloor: 1.2,
    maxReferenceFraction: 1.06,
  }),
});

export function villageZoomReferenceBounds(mode, aerialReference, closeupReference = 0) {
  const aerial = Number.isFinite(aerialReference) && aerialReference > 0 ? aerialReference : 150;
  if (mode === 'explore') {
    const policy = VILLAGE_ZOOM.explore;
    return {
      min: Math.max(policy.minReferenceFloor, Math.min(
        policy.minReferenceCap,
        aerial * policy.minReferenceFraction,
      )),
      max: aerial * policy.maxReferenceFraction,
    };
  }
  if (mode === 'focus') {
    const policy = VILLAGE_ZOOM.focus;
    const closeup = Number.isFinite(closeupReference) && closeupReference > 0
      ? closeupReference : policy.minReferenceFloor;
    return {
      min: Math.max(policy.minReferenceFloor, closeup * policy.minCloseupFraction),
      max: aerial * policy.maxReferenceFraction,
    };
  }
  throw new Error(`Unknown village zoom mode: ${mode}`);
}

const smoothstep = (edge0, edge1, value) => {
  if (edge1 <= edge0) return value < edge0 ? 0 : 1;
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

// 선택은 유지하되 근경용 얕은 심도는 넓은 문맥에서 사라진다. 화면 등가 거리로 계산해
// 렌즈 dolly만으로 보케 양이 달라지지 않으며, 0에 도달하면 Bokeh pass도 쉴 수 있다.
export function villageFocusEffectWeight(referenceDistance, aerialReference, closeupReference) {
  const bounds = villageZoomReferenceBounds('focus', aerialReference, closeupReference);
  const closeup = Number.isFinite(closeupReference) && closeupReference > 0
    ? closeupReference : bounds.min;
  const fullUntil = Math.min(bounds.max, Math.max(bounds.min, closeup * 1.35));
  const clearAt = Math.max(fullUntil + 1e-6, Math.min(
    bounds.max,
    Math.max(closeup * 3, bounds.max * 0.5),
  ));
  return 1 - smoothstep(fullUntil, clearAt, referenceDistance);
}

export function villageFocusContextElevation(
  referenceDistance,
  aerialReference,
  closeupReference,
  baseElevation,
) {
  const base = Number.isFinite(baseElevation) ? baseElevation : 0;
  const context = 1 - villageFocusEffectWeight(
    referenceDistance, aerialReference, closeupReference,
  );
  return base + (Math.max(base, VILLAGE_FOCUS_CONTEXT_ELEVATION) - base) * context;
}

function validFov(value) {
  return Number.isFinite(value) && value > 0 && value < 179;
}

/** Dolly multiplier that holds a subject's projected height while FOV changes. */
export function dollyScaleForFov(fromFov, toFov) {
  if (!validFov(fromFov) || !validFov(toFov)) return 1;
  return Math.tan(fromFov * DEG * 0.5) / Math.tan(toFov * DEG * 0.5);
}

export function dollyDistanceForFov(distance, fromFov, toFov) {
  if (!Number.isFinite(distance)) return distance;
  return distance * dollyScaleForFov(fromFov, toFov);
}

/** Compensating FOV after multiplying camera-to-target distance by `scale`. */
export function fovForDollyScale(fov, scale) {
  if (!validFov(fov) || !Number.isFinite(scale) || scale <= 0) return fov;
  return 2 * Math.atan(Math.tan(fov * DEG * 0.5) / scale) / DEG;
}

/** Distance as perceived at referenceFov; useful for screen-space LOD decisions. */
export function equivalentDistanceAtFov(distance, actualFov, referenceFov) {
  if (!Number.isFinite(distance) || !validFov(actualFov) || !validFov(referenceFov)) return distance;
  return distance / dollyScaleForFov(referenceFov, actualFov);
}

// Map the new optical continuum back to the former FOV continuum. This keeps fauna,
// motes, leaves, and other detail at the same apparent size after a compensated dolly.
export function referenceVillageFov(actualFov) {
  if (!validFov(actualFov)) return actualFov;
  const H = VILLAGE_LENS.hero;
  const P = VILLAGE_LENS.parcel;
  const A = VILLAGE_LENS.aerial;
  if (actualFov <= P.fov) {
    const span = P.fov - H.fov;
    const t = span > 0 ? Math.max(0, Math.min(1, (actualFov - H.fov) / span)) : 1;
    return H.referenceFov + (P.referenceFov - H.referenceFov) * t;
  }
  const span = A.fov - P.fov;
  const t = span > 0 ? Math.max(0, Math.min(1, (actualFov - P.fov) / span)) : 0;
  return P.referenceFov + (A.referenceFov - P.referenceFov) * t;
}

/**
 * Resolve the authored reference lens carried by a camera.
 *
 * Generic/standalone cameras are authored at their physical FOV, so missing village
 * metadata must be the identity lens. Village camera paths carry an explicit
 * `villageReferenceFov`; inferring a village profile here would silently opt house
 * cameras into a compensated dolly and make particles/LOD change size on mode exit.
 */
export function referenceFovForCamera(camera) {
  const explicit = camera?.userData?.villageReferenceFov;
  return validFov(explicit) ? explicit : camera?.fov;
}

/** Point-sprite multiplier matching geometry under a compensated lens dolly. */
export function lensScaleForCamera(camera) {
  return dollyScaleForFov(referenceFovForCamera(camera), camera?.fov);
}

export function villageScreenDistance(
  distance,
  actualFov,
  referenceFov = referenceVillageFov(actualFov),
) {
  return equivalentDistanceAtFov(distance, actualFov, referenceFov);
}

export function villageScreenDistanceForCamera(distance, camera) {
  return villageScreenDistance(distance, camera?.fov, referenceFovForCamera(camera));
}
