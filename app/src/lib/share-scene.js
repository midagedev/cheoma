// Current-scene link sharing. This module is deliberately DOM-, Svelte-, and
// three-free so URL canonicalization and the Web Share/clipboard decision can
// be checked without booting the product.
import {
  RESIDENTIAL_EDIT_QUERY_KEY,
  encodeResidentialEditState,
} from './residential-edit-url.js';

export const VILLAGE_SCALE_IDS = Object.freeze([
  'solo', 'hamlet', 'village', 'town', 'capital', 'hanyang',
]);

export const SHARE_OUTCOMES = Object.freeze([
  'shared', 'copied', 'cancelled', 'failed',
]);

function put(query, key, value, condition) {
  if (condition) query.set(key, String(value));
}

/**
 * Build the portable scene URL from authoritative product state.
 *
 * The address bar can intentionally remain terse during the default village
 * landing. Sharing must not copy that shorthand: it serializes the active
 * village seed/options and committed residential edits explicitly. Starting
 * with an empty query also keeps runtime and verification controls
 * (`hero`, `worker`, `shot`, `lang`, ...) out of shared links.
 */
export function buildSceneShareUrl({
  baseUrl,
  state,
  overrides = {},
  village = null,
  flow = false,
  residentialEdits = [],
  focusedParcelId = null,
} = {}) {
  const base = new URL(baseUrl);
  const query = new URLSearchParams();
  query.set('seed', String(state.seed >>> 0));
  // Runtime-only entry flags can select a different seed-derived startup time
  // (notably shot=1 bypasses the product's sunset default). Since those flags
  // are intentionally stripped, pin the currently rendered time explicitly.
  query.set('time', String(state.time));
  put(query, 'preset', state.preset, overrides.preset);
  put(query, 'sunset', state.sunsetLook, overrides.sunsetLook);
  put(query, 'season', state.season, overrides.season);
  put(query, 'weather', state.weather, overrides.weather);
  put(query, 'mode', state.renderStyle, state.renderStyle === 'ink');
  put(query, 'exp', state.expansion, state.expansion > 1);
  put(query, 'flow', 1, flow);

  if (village) {
    query.set('village', '1');
    query.set('vseed', String(village.seed >>> 0));
    put(query, 'vscale', village.scale, village.scale !== 'village');
    put(query, 'vchar', village.character, village.character !== 'yeoyeom');
    put(query, 'vpalace', 1, village.includePalace);
    put(query, 'vtemple', 1, village.includeTemple);
    const editPayload = encodeResidentialEditState({
      records: residentialEdits,
      focusedParcelId,
    });
    put(query, RESIDENTIAL_EDIT_QUERY_KEY, editPayload, !!editPayload);
  }

  return `${base.origin}${base.pathname}?${query.toString()}`;
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
