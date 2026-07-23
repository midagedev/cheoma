// Current-scene link sharing. This module is deliberately DOM-, Svelte-, and
// three-free so URL canonicalization and the Web Share/clipboard decision can
// be checked without booting the product.
import { buildSceneSnapshotUrl } from './scene-snapshot.js';

export const VILLAGE_SCALE_IDS = Object.freeze([
  'solo', 'hamlet', 'village', 'town', 'capital', 'hanyang',
]);

export const SHARE_OUTCOMES = Object.freeze([
  'shared', 'copied', 'cancelled', 'failed',
]);

/**
 * Build the portable scene URL from authoritative product state.
 *
 * The address bar can intentionally remain terse during the default village
 * landing. Sharing must not copy that shorthand: one versioned snapshot
 * serializes the active village, committed edits, and semantic view. Building
 * the query from scratch keeps runtime and verification controls out.
 */
export function buildSceneShareUrl({
  baseUrl,
  state,
  overrides = {},
  village = null,
  flow = false,
  residentialEdits = [],
  focusedParcelId = null,
  view = null,
  standaloneParams = {},
} = {}) {
  return buildSceneSnapshotUrl({
    baseUrl,
    state,
    overrides,
    village,
    flow,
    residentialEdits,
    focusedParcelId,
    view,
    standaloneParams,
  });
}

function isAbortError(error) {
  return error?.name === 'AbortError';
}

/**
 * Prefer the native share sheet, then fall back to copying only the canonical
 * URL. Dependencies are injected to keep the policy independently testable.
 */
export async function shareSceneLink(payload, {
  share = null,
  writeText = null,
} = {}) {
  if (!payload || typeof payload.url !== 'string' || payload.url.length === 0) return 'failed';

  if (typeof share === 'function') {
    try {
      await share(payload);
      return 'shared';
    } catch (error) {
      // A dismissed native sheet is a completed user choice, not a clipboard
      // request and not an error toast.
      if (isAbortError(error)) return 'cancelled';
    }
  }

  if (typeof writeText === 'function') {
    try {
      await writeText(payload.url);
      return 'copied';
    } catch {}
  }
  return 'failed';
}
