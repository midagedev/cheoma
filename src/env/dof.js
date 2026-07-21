// Depth-of-field contracts shared by the standalone core and the app wrapper.
// Three's BokehPass `focus` is camera-space axial depth, not Euclidean distance.

const EPSILON = 1e-6;
export const DEFAULT_DOF_APERTURE = 0.00015;

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function focusBounds(camera) {
  const near = Number.isFinite(camera?.near) ? Math.max(EPSILON, camera.near) : EPSILON;
  const far = Number.isFinite(camera?.far) ? Math.max(near, camera.far) : Infinity;
  return { near, far };
}

// Keep this module-scoped: StableBokeh calls it for every visible mesh in its depth prepass.
function materialContributesDofDepth(material) {
  return !!material
    && material.visible !== false
    && material.depthWrite !== false
    && !(material.alphaHash === true && material.opacity < 0.999);
}

/** Return a world point's positive depth along the camera forward axis. */
export function focusDepthForPoint(camera, point) {
  if (!camera || !point || ![point.x, point.y, point.z].every(Number.isFinite)) return null;
  // Public core callers may mount the camera under a moving rig. Updating only the camera leaves
  // a dirty parent transform stale, so refresh ancestors as well before reading matrixWorldInverse.
  if (camera.updateWorldMatrix) camera.updateWorldMatrix(true, false);
  else camera.updateMatrixWorld?.();
  const e = camera.matrixWorldInverse?.elements;
  if (!e) return null;
  const depth = -(e[2] * point.x + e[6] * point.y + e[10] * point.z + e[14]);
  if (!Number.isFinite(depth) || depth <= 0) return null;
  const { near, far } = focusBounds(camera);
  return Math.min(far, Math.max(near, depth));
}

/**
 * Whether an object should contribute to the opaque depth texture used by DoF.
 * Transparent particles and overlays must not become moving opaque occluders when
 * BokehPass temporarily replaces every scene material with MeshDepthMaterial.
 */
export function contributesDofDepth(object) {
  if (!object?.visible) return false;
  if (object.userData?.dofDepth === false) return false;
  if (object.isPoints || object.isLine || object.isSprite) return false;
  if (!object.isMesh) return false;
  if (object.userData?.dofDepth === true) return true;
  // Built-in BokehPass replaces the source material with one opaque depth material, so it
  // cannot reproduce an alphaHash opacity fade. Exclude intermediate hashed fades just as the
  // former transparent/depthWrite=false path did; full-weight hashed meshes still contribute.
  const material = object.material;
  if (!Array.isArray(material)) {
    return materialContributesDofDepth(material);
  }
  // Hot depth-pass path: avoid filter()/some() and temporary arrays across thousands of meshes.
  for (let i = 0; i < material.length; i++) {
    const part = material[i];
    if (materialContributesDofDepth(part)) return true;
  }
  return false;
}

/** Own BokehPass enablement, focus depth, and aperture strength in one place. */
export function createDofController({ camera, pass, aperture = DEFAULT_DOF_APERTURE } = {}) {
  const uniforms = pass?.uniforms;
  if (!camera || !uniforms?.focus || !uniforms?.aperture) {
    throw new TypeError('createDofController requires a camera and BokehPass uniforms');
  }

  let baseAperture = Number.isFinite(aperture) ? Math.max(0, aperture) : 0;
  let amount = pass.enabled ? 1 : 0;

  function applyAperture() {
    uniforms.aperture.value = baseAperture * amount;
  }

  function setAmount(value) {
    amount = clamp01(value);
    applyAperture();
    pass.enabled = amount > EPSILON;
    return amount;
  }

  function setEnabled(on) {
    return setAmount(on ? 1 : 0) > 0;
  }

  function setAperture(value) {
    if (Number.isFinite(value)) baseAperture = Math.max(0, value);
    applyAperture();
    return baseAperture;
  }

  function setFocus(value) {
    if (!Number.isFinite(value) || value <= 0) return uniforms.focus.value;
    const { near, far } = focusBounds(camera);
    uniforms.focus.value = Math.min(far, Math.max(near, value));
    return uniforms.focus.value;
  }

  function focusAt(point) {
    const depth = focusDepthForPoint(camera, point);
    return depth == null ? uniforms.focus.value : setFocus(depth);
  }

  function depthAt(point) {
    return focusDepthForPoint(camera, point);
  }

  applyAperture();
  return {
    setEnabled,
    setAmount,
    setAperture,
    setFocus,
    focusAt,
    depthAt,
    get aperture() { return baseAperture; },
    get enabled() { return !!pass.enabled; },
    get focus() { return uniforms.focus.value; },
    get amount() { return amount; },
  };
}
