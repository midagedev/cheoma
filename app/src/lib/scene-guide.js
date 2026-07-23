// First-scene guide policy. This module deliberately has no DOM, Svelte, URL,
// timer, or locale dependency: App owns lifecycle/input wiring and injects the
// storage capability at its browser boundary.

export const SCENE_GUIDE_STORAGE_KEY = 'cheoma-scene-guide-v1';
export const SCENE_GUIDE_DISMISSED_VALUE = 'dismissed';

export function sceneGuideWasDismissed(storage) {
  if (!storage || typeof storage.getItem !== 'function') return false;
  try {
    return storage.getItem(SCENE_GUIDE_STORAGE_KEY) === SCENE_GUIDE_DISMISSED_VALUE;
  } catch {
    // Storage can be denied in private/embedded contexts. Fail open so the
    // useful guide remains available instead of treating an error as "seen".
    return false;
  }
}

export function persistSceneGuideDismissal(storage) {
  if (!storage || typeof storage.setItem !== 'function') return false;
  try {
    storage.setItem(SCENE_GUIDE_STORAGE_KEY, SCENE_GUIDE_DISMISSED_VALUE);
    return true;
  } catch {
    return false;
  }
}

export function sceneGuideIsVisible({
  dismissed = false,
  sceneVillage = false,
  stable = false,
  heroVisible = false,
  heroLanding = false,
  waving = false,
  veil = false,
  cinematic = false,
  references = false,
  toast = false,
} = {}) {
  return !dismissed
    && sceneVillage
    && stable
    && !heroVisible
    && !heroLanding
    && !waving
    && !veil
    && !cinematic
    && !references
    && !toast;
}
