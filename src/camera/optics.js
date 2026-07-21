// Shared lens policy for the village zoom continuum.
//
// A focal-length change only becomes visible as perspective when the camera also
// dollies: wide aerial views move closer, telephoto house views move farther away.
// The helpers below preserve projected subject scale while changing that depth
// compression, and let screen-space LOD ignore the compensating dolly distance.

const DEG = Math.PI / 180;

const lens = (fov, referenceFov) => Object.freeze({ fov, referenceFov });

export const VILLAGE_LENS = Object.freeze({
  aerial: lens(46, 42),
  parcel: lens(20, 23),
  hero: lens(18, 21),
  palace: lens(24, 32),
  temple: lens(26, 34),
});

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
