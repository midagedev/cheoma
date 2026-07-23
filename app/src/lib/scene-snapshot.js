// Versioned, canonical transport for a settled cheoma scene.
//
// This module deliberately has no DOM, Svelte, Three, clock, or global RNG
// dependency. Product state is normalized at the boundary, defaults are omitted,
// and one compact semantic camera view replaces renderer-specific pose vectors.

import {
  decodeResidentialEditState,
  encodeResidentialEditState,
} from './residential-edit-url.js';
import { weatherOkForSeason } from '../../../src/api/environment-state.js';
import {
  VILLAGE_NUMBER_OPTION_SPECS,
  VILLAGE_OPTION_DEFAULTS,
  VILLAGE_WALL_STYLE_IDS,
  VILLAGE_WALL_WEIGHT_SPEC,
} from '../../../src/api/village-options.js';
import {
  STANDALONE_PARAM_SPECS,
  normalizeStandaloneParamPatch,
  standaloneMaxExpansion,
} from './standalone-param-spec.js';
import {
  MAX_SEMANTIC_VIEW_ELEVATION,
  MAX_SEMANTIC_VIEW_PAN,
  MIN_SEMANTIC_VIEW_ELEVATION,
} from '../engine/semantic-view-runtime.js';

export const SCENE_SNAPSHOT_QUERY_KEY = 'scene';
export const SCENE_SNAPSHOT_VERSION = 1;
export const MAX_SCENE_SNAPSHOT_PAYLOAD_LENGTH = 1536;
export const MAX_SCENE_SNAPSHOT_URL_LENGTH = 1900;

const TIMES = ['dawn', 'day', 'sunset', 'night'];
const PRESETS = ['korea', 'temple', 'giwa', 'choga'];
const SUNSETS = ['gold', 'crimson', 'violet'];
const SEASONS = ['spring', 'summer', 'autumn', 'winter'];
const WEATHERS = ['clear', 'rain', 'snow'];
const STYLES = ['pbr', 'ink'];
const SCALES = ['solo', 'hamlet', 'village', 'town', 'capital', 'hanyang'];
const CHARACTERS = ['minchon', 'yeoyeom', 'banchon'];
const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
// Newer schema writers may add descriptive keys. Bound their shape/size for
// untrusted URLs without coupling fail-soft parsing to v1's terse key lengths.
const FIELD_KEY_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const BASE36_RE = /^[0-9a-z]+$/;
const KNOWN_FIELDS = new Set([
  's', 't', 'p', 'su', 'se', 'we', 'm', 'x', 'fl',
  'vs', 'z', 'ch', 'pa', 'te',
  'sr', 'u', 'rh', 'sm', 'st', 'rv', 'pd', 'td', 'cw', 'sj', 'c1', 'dv', 'hs', 'ww',
  'f', 'vw', 'ed', 'hp',
]);

const FIELD_SEPARATOR = '~';
const VALUE_SEPARATOR = '.';
const EMBEDDED_SEPARATOR = '!';
const TIME_CODES = makeCodes(TIMES);
const PRESET_CODES = makeCodes(PRESETS);
const SUNSET_CODES = makeCodes(SUNSETS);
const SEASON_CODES = makeCodes(SEASONS);
const WEATHER_CODES = makeCodes(WEATHERS);
const STYLE_CODES = makeCodes(STYLES);
const SCALE_CODES = makeCodes(SCALES);
const CHARACTER_CODES = makeCodes(CHARACTERS);

const VILLAGE_NUMBER_FIELDS = Object.freeze({
  sr: Object.freeze({ key: 'siteR', ...VILLAGE_NUMBER_OPTION_SPECS.siteR }),
  u: Object.freeze({ key: 'undAmpK', ...VILLAGE_NUMBER_OPTION_SPECS.undAmpK }),
  rh: Object.freeze({ key: 'ridgeHK', ...VILLAGE_NUMBER_OPTION_SPECS.ridgeHK }),
  sm: Object.freeze({ key: 'streamMeanderK', ...VILLAGE_NUMBER_OPTION_SPECS.streamMeanderK }),
  pd: Object.freeze({ key: 'paddyDensityK', ...VILLAGE_NUMBER_OPTION_SPECS.paddyDensityK }),
  td: Object.freeze({ key: 'treeDensityK', ...VILLAGE_NUMBER_OPTION_SPECS.treeDensityK }),
  c1: Object.freeze({ key: 'char01', ...VILLAGE_NUMBER_OPTION_SPECS.char01 }),
  dv: Object.freeze({ key: 'diversityK', ...VILLAGE_NUMBER_OPTION_SPECS.diversityK }),
  hs: Object.freeze({ key: 'houses', ...VILLAGE_NUMBER_OPTION_SPECS.houses }),
});

export const SCENE_VIEW_QUANTIZATION = Object.freeze({
  azimuthDegrees: 0.1,
  elevationDegrees: 0.1,
  zoom: 0.001,
  pan: 0.001,
});

function makeCodes(values) {
  const encode = new Map();
  const decode = new Map();
  values.forEach((value, index) => {
    const code = index.toString(36);
    encode.set(value, code);
    decode.set(code, value);
  });
  return Object.freeze({ encode, decode });
}

function validUint32(value) {
  return Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
}

function encodeUint32(value) {
  return validUint32(value) ? value.toString(36) : null;
}

function decodeUint32(token) {
  if (!BASE36_RE.test(token) || token.length > 7) return null;
  const value = Number.parseInt(token, 36);
  return validUint32(value) ? value : null;
}

function encodeEnum(value, codes) {
  return codes.encode.get(value) ?? null;
}

function decodeEnum(token, codes) {
  return codes.decode.get(token) ?? null;
}

function encodeBoolean(value) {
  return value === true ? '1' : value === false ? '0' : null;
}

function decodeBoolean(token) {
  return token === '1' ? true : token === '0' ? false : null;
}

function roundDecimal(value, places = 6) {
  return Number(value.toFixed(places));
}

function encodeStepped(value, spec) {
  if (!Number.isFinite(value) || value < spec.min || value > spec.max) return null;
  const units = Math.round(value / spec.step);
  if (Math.abs(units * spec.step - value) > 1e-8) return null;
  return units.toString(36);
}

function decodeStepped(token, spec) {
  if (!BASE36_RE.test(token) || token.length > 4) return null;
  const units = Number.parseInt(token, 36);
  const value = roundDecimal(units * spec.step);
  return value >= spec.min && value <= spec.max ? value : null;
}

function normalizeDegrees(value, fullTurn = 360) {
  if (!Number.isFinite(value)) return null;
  const normalized = ((value % fullTurn) + fullTurn) % fullTurn;
  return normalized === fullTurn ? 0 : normalized;
}

export function normalizeSceneView(view) {
  if (!view || typeof view !== 'object') return null;
  const azimuth = normalizeDegrees(view.azimuth);
  const elevation = view.elevation;
  const zoom = view.zoom;
  const panEast = view.panEast ?? 0;
  const panUp = view.panUp ?? 0;
  const panSouth = view.panSouth ?? 0;
  if (azimuth == null || !Number.isFinite(elevation)
      || elevation < MIN_SEMANTIC_VIEW_ELEVATION || elevation > MAX_SEMANTIC_VIEW_ELEVATION
      || !Number.isFinite(zoom) || zoom < 0 || zoom > 1
      || !Number.isFinite(panEast) || Math.abs(panEast) > MAX_SEMANTIC_VIEW_PAN
      || !Number.isFinite(panUp) || Math.abs(panUp) > MAX_SEMANTIC_VIEW_PAN
      || !Number.isFinite(panSouth) || Math.abs(panSouth) > MAX_SEMANTIC_VIEW_PAN) return null;
  // Quantization can round 359.96° to 360°. Normalize once more so the
  // canonical bytes cannot change to 0° after a decode/re-encode.
  const quantizedAzimuth = normalizeDegrees(Math.round(azimuth * 10) / 10);
  return Object.freeze({
    azimuth: roundDecimal(quantizedAzimuth, 1),
    elevation: roundDecimal(Math.round(elevation * 10) / 10, 1),
    zoom: roundDecimal(Math.round(zoom * 1000) / 1000, 3),
    panEast: roundDecimal(Math.round(panEast * 1000) / 1000, 3),
    panUp: roundDecimal(Math.round(panUp * 1000) / 1000, 3),
    panSouth: roundDecimal(Math.round(panSouth * 1000) / 1000, 3),
  });
}

function encodeSigned(value) {
  const integer = Math.round(value);
  return (integer >= 0 ? integer * 2 : -integer * 2 - 1).toString(36);
}

function decodeSigned(token) {
  if (!BASE36_RE.test(token) || token.length > 4) return null;
  const zigzag = Number.parseInt(token, 36);
  return zigzag % 2 === 0 ? zigzag / 2 : -(zigzag + 1) / 2;
}

function encodeView(view) {
  const normalized = normalizeSceneView(view);
  if (!normalized) return null;
  const fields = [
    Math.round(normalized.azimuth * 10).toString(36),
    Math.round(normalized.elevation * 10).toString(36),
    Math.round(normalized.zoom * 1000).toString(36),
  ];
  if (normalized.panEast || normalized.panUp || normalized.panSouth) {
    fields.push(
      encodeSigned(normalized.panEast * 1000),
      encodeSigned(normalized.panUp * 1000),
      encodeSigned(normalized.panSouth * 1000),
    );
  }
  return fields.join('.');
}

function decodeView(token) {
  const fields = token.split('.');
  if ((fields.length !== 3 && fields.length !== 6)
      || fields.some((field) => !BASE36_RE.test(field) || field.length > 4)) return null;
  const azimuthUnits = Number.parseInt(fields[0], 36);
  const elevationUnits = Number.parseInt(fields[1], 36);
  const zoomUnits = Number.parseInt(fields[2], 36);
  if (azimuthUnits > 3599
      || elevationUnits < MIN_SEMANTIC_VIEW_ELEVATION * 10
      || elevationUnits > MAX_SEMANTIC_VIEW_ELEVATION * 10
      || zoomUnits > 1000) return null;
  const pan = fields.length === 6 ? fields.slice(3).map(decodeSigned) : [0, 0, 0];
  if (pan.some((value) => value == null)) return null;
  return normalizeSceneView({
    azimuth: azimuthUnits / 10,
    elevation: elevationUnits / 10,
    zoom: zoomUnits / 1000,
    panEast: pan[0] / 1000,
    panUp: pan[1] / 1000,
    panSouth: pan[2] / 1000,
  });
}

function encodeStandaloneParams(value) {
  const normalized = normalizeStandaloneParamPatch(value);
  if (!normalized) return null;
  let mask = 0;
  const values = [];
  STANDALONE_PARAM_SPECS.forEach((spec, index) => {
    if (!Object.hasOwn(normalized, spec.key)) return;
    mask |= 1 << index;
    values.push(Math.round((normalized[spec.key] - spec.min) / spec.step).toString(36));
  });
  return mask ? `${mask.toString(36)}.${values.join('.')}` : '';
}

function decodeStandaloneParams(token) {
  const fields = token.split('.');
  if (fields.length < 2 || !fields.every((field) => BASE36_RE.test(field) && field.length <= 3)) {
    return null;
  }
  const mask = Number.parseInt(fields[0], 36);
  const maxMask = (1 << STANDALONE_PARAM_SPECS.length) - 1;
  if (!(mask > 0) || mask > maxMask) return null;
  const expected = STANDALONE_PARAM_SPECS.reduce(
    (count, _spec, index) => count + ((mask >> index) & 1),
    0,
  );
  if (fields.length !== expected + 1) return null;
  const decoded = {};
  let valueIndex = 1;
  for (let index = 0; index < STANDALONE_PARAM_SPECS.length; index++) {
    if (!((mask >> index) & 1)) continue;
    const spec = STANDALONE_PARAM_SPECS[index];
    const units = Number.parseInt(fields[valueIndex++], 36);
    const value = roundDecimal(spec.min + units * spec.step);
    if (value < spec.min || value > spec.max) return null;
    decoded[spec.key] = value;
  }
  return normalizeStandaloneParamPatch(decoded);
}

function canonicalWallWeights(value) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return undefined;
  if (Object.keys(value).some((key) => !VILLAGE_WALL_STYLE_IDS.includes(key))) return undefined;
  const normalized = {};
  let meaningful = false;
  for (const key of VILLAGE_WALL_STYLE_IDS) {
    const weight = value[key] ?? VILLAGE_WALL_WEIGHT_SPEC.default;
    if (encodeStepped(weight, VILLAGE_WALL_WEIGHT_SPEC) == null) return undefined;
    normalized[key] = weight;
    meaningful ||= weight !== VILLAGE_WALL_WEIGHT_SPEC.default;
  }
  return meaningful ? normalized : null;
}

function encodeWallWeights(value) {
  if (!value) return null;
  return VILLAGE_WALL_STYLE_IDS.map((key) => (
    encodeStepped(value[key], VILLAGE_WALL_WEIGHT_SPEC)
  )).join('.');
}

function decodeWallWeights(token) {
  const fields = token.split('.');
  if (fields.length !== VILLAGE_WALL_STYLE_IDS.length) return undefined;
  const weights = {};
  let meaningful = false;
  for (let index = 0; index < VILLAGE_WALL_STYLE_IDS.length; index++) {
    const value = decodeStepped(fields[index], VILLAGE_WALL_WEIGHT_SPEC);
    if (value == null) return undefined;
    weights[VILLAGE_WALL_STYLE_IDS[index]] = value;
    meaningful ||= value !== VILLAGE_WALL_WEIGHT_SPEC.default;
  }
  return meaningful ? weights : undefined;
}

function canonicalVillage(village) {
  if (!village || typeof village !== 'object') return null;
  const seed = validUint32(village.seed) ? village.seed : null;
  const scale = SCALES.includes(village.scale) ? village.scale : null;
  if (seed == null || !scale) return null;
  if (village.character != null && !CHARACTERS.includes(village.character)) return null;
  if (village.includePalace != null && typeof village.includePalace !== 'boolean') return null;
  if (village.includeTemple != null && typeof village.includeTemple !== 'boolean') return null;
  if (village.stream != null && typeof village.stream !== 'boolean') return null;
  if (village.river != null && typeof village.river !== 'boolean') return null;
  const character = village.character ?? 'yeoyeom';
  const options = { ...VILLAGE_OPTION_DEFAULTS };
  for (const spec of Object.values(VILLAGE_NUMBER_FIELDS)) {
    const value = village[spec.key];
    if (value == null && spec.default == null) continue;
    if (encodeStepped(value ?? spec.default, spec) == null) return null;
    options[spec.key] = value ?? spec.default;
  }
  if (village.stream === false) options.stream = false;
  if (village.river === true) options.river = true;
  for (const key of ['cityWall', 'sijeon']) {
    const value = village[key];
    if (value === true || value === false) options[key] = value;
    else if (value != null && value !== 'auto') return null;
  }
  const wallWeights = canonicalWallWeights(village.wallWeights);
  if (wallWeights === undefined) return null;
  options.wallWeights = wallWeights;
  return {
    seed,
    scale,
    character,
    includePalace: village.includePalace === true,
    includeTemple: village.includeTemple === true,
    ...options,
  };
}

function pushField(fields, key, value, condition = value != null) {
  if (condition) fields.push(`${key}${VALUE_SEPARATOR}${value}`);
}

/**
 * Encode authoritative product state. Returns null rather than truncating an
 * invalid or over-budget snapshot.
 */
export function encodeSceneSnapshot({
  state,
  overrides = {},
  village = null,
  flow = false,
  residentialEdits = [],
  focusedParcelId = null,
  view = null,
  standaloneParams = {},
} = {}) {
  if (!state || !validUint32(state.seed) || !TIMES.includes(state.time)
      || !Array.isArray(residentialEdits) || typeof flow !== 'boolean'
      || !overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return null;
  for (const key of ['preset', 'time', 'sunsetLook', 'season', 'weather']) {
    if (overrides[key] != null && typeof overrides[key] !== 'boolean') return null;
  }
  if (!PRESETS.includes(state.preset) || !SUNSETS.includes(state.sunsetLook)
      || !SEASONS.includes(state.season) || !WEATHERS.includes(state.weather)
      || !STYLES.includes(state.renderStyle)
      || !weatherOkForSeason(state.weather, state.season)) return null;
  if (!Number.isInteger(state.expansion) || state.expansion < 1
      || state.expansion > standaloneMaxExpansion(state.preset)) return null;
  if (focusedParcelId != null && !SAFE_ID_RE.test(focusedParcelId)) return null;
  const normalizedVillage = canonicalVillage(village);
  if (village && !normalizedVillage) return null;
  const normalizedStandaloneParams = normalizeStandaloneParamPatch(standaloneParams);
  if (!normalizedStandaloneParams) return null;
  const hasStandaloneParams = Object.keys(normalizedStandaloneParams).length > 0;
  if (!normalizedVillage && (focusedParcelId || residentialEdits.length)) return null;
  if (normalizedVillage && hasStandaloneParams) return null;

  const fields = [String(SCENE_SNAPSHOT_VERSION)];
  pushField(fields, 's', encodeUint32(state.seed));
  // The named environment time is committed state, not a seed default: it is
  // always pinned so removing runtime entry flags cannot change the scene.
  pushField(fields, 't', encodeEnum(state.time, TIME_CODES));
  // Expansion limits are preset-specific. Pin the preset whenever x is present
  // so a decoder never needs to reproduce seed-derived defaults to validate it.
  pushField(fields, 'p', encodeEnum(state.preset, PRESET_CODES),
    !!overrides.preset || state.expansion > 1);
  pushField(fields, 'su', encodeEnum(state.sunsetLook, SUNSET_CODES), !!overrides.sunsetLook);
  pushField(fields, 'se', encodeEnum(state.season, SEASON_CODES), !!overrides.season);
  pushField(fields, 'we', encodeEnum(state.weather, WEATHER_CODES), !!overrides.weather);
  pushField(fields, 'm', encodeEnum(state.renderStyle, STYLE_CODES), state.renderStyle === 'ink');
  pushField(fields, 'x', Number(state.expansion).toString(36),
    state.expansion > 1);
  pushField(fields, 'fl', '1', flow === true);

  if (normalizedVillage) {
    pushField(fields, 'vs', encodeUint32(normalizedVillage.seed));
    pushField(fields, 'z', encodeEnum(normalizedVillage.scale, SCALE_CODES),
      normalizedVillage.scale !== 'village');
    pushField(fields, 'ch', encodeEnum(normalizedVillage.character, CHARACTER_CODES),
      normalizedVillage.character !== 'yeoyeom');
    const palaceDefault = normalizedVillage.scale === 'hanyang';
    pushField(fields, 'pa', encodeBoolean(normalizedVillage.includePalace),
      normalizedVillage.includePalace !== palaceDefault);
    pushField(fields, 'te', '1', normalizedVillage.includeTemple);

    for (const [field, spec] of Object.entries(VILLAGE_NUMBER_FIELDS)) {
      const value = normalizedVillage[spec.key];
      pushField(fields, field, encodeStepped(value, spec), value !== spec.default);
    }
    pushField(fields, 'st', '0', normalizedVillage.stream === false);
    pushField(fields, 'rv', '1', normalizedVillage.river === true);
    for (const [field, key] of [['cw', 'cityWall'], ['sj', 'sijeon']]) {
      pushField(fields, field, encodeBoolean(normalizedVillage[key]), normalizedVillage[key] !== 'auto');
    }
    pushField(fields, 'ww', encodeWallWeights(normalizedVillage.wallWeights),
      !!normalizedVillage.wallWeights);
    pushField(fields, 'f', focusedParcelId, !!focusedParcelId);
    if (residentialEdits.length) {
      const edits = encodeResidentialEditState({ records: residentialEdits });
      if (!edits) return null;
      pushField(fields, 'ed', edits.replaceAll(FIELD_SEPARATOR, EMBEDDED_SEPARATOR));
    }
  }
  pushField(fields, 'hp', encodeStandaloneParams(normalizedStandaloneParams), hasStandaloneParams);
  pushField(fields, 'vw', encodeView(view), !!view);

  if (fields.some((field) => field.endsWith(VALUE_SEPARATOR + 'null'))) return null;
  const payload = fields.join(FIELD_SEPARATOR);
  return payload.length <= MAX_SCENE_SNAPSHOT_PAYLOAD_LENGTH ? payload : null;
}

function parseFields(payload) {
  if (typeof payload !== 'string' || payload.length === 0
      || payload.length > MAX_SCENE_SNAPSHOT_PAYLOAD_LENGTH) return null;
  const tokens = payload.split(FIELD_SEPARATOR);
  if (tokens.shift() !== String(SCENE_SNAPSHOT_VERSION)) return null;
  const fields = new Map();
  for (const token of tokens) {
    const split = token.indexOf(VALUE_SEPARATOR);
    if (split <= 0) return null;
    const key = token.slice(0, split);
    const value = token.slice(split + 1);
    if (!FIELD_KEY_RE.test(key) || !value) return null;
    // Fields introduced by a newer writer are ignored by this version. Known
    // fields stay strict and unique so a malformed URL cannot partially apply.
    if (!KNOWN_FIELDS.has(key)) continue;
    if (fields.has(key)) return null;
    fields.set(key, value);
  }
  return fields;
}

function readOptionalEnum(fields, key, codes, fallback) {
  if (!fields.has(key)) return fallback;
  return decodeEnum(fields.get(key), codes);
}

/**
 * Decode one current-version snapshot. Unknown fields fail soft; malformed
 * known fields and unknown schema versions return null without partial state.
 */
export function decodeSceneSnapshot(payload) {
  const fields = parseFields(payload);
  if (!fields) return null;
  const seed = fields.has('s') ? decodeUint32(fields.get('s')) : null;
  const time = fields.has('t') ? decodeEnum(fields.get('t'), TIME_CODES) : null;
  if (seed == null || !time) return null;

  const preset = readOptionalEnum(fields, 'p', PRESET_CODES, null);
  const sunsetLook = readOptionalEnum(fields, 'su', SUNSET_CODES, null);
  const season = readOptionalEnum(fields, 'se', SEASON_CODES, null);
  const weather = readOptionalEnum(fields, 'we', WEATHER_CODES, null);
  const renderStyle = readOptionalEnum(fields, 'm', STYLE_CODES, 'pbr');
  if ((fields.has('p') && !preset) || (fields.has('su') && !sunsetLook)
      || (fields.has('se') && !season) || (fields.has('we') && !weather)
      || !renderStyle) return null;
  if (fields.has('se') && fields.has('we') && !weatherOkForSeason(weather, season)) return null;
  let expansion = 1;
  if (fields.has('x')) {
    if (!BASE36_RE.test(fields.get('x'))) return null;
    expansion = Number.parseInt(fields.get('x'), 36);
    if (!preset || !Number.isInteger(expansion) || expansion < 2
        || expansion > standaloneMaxExpansion(preset)) return null;
  }
  if (fields.has('fl') && fields.get('fl') !== '1') return null;

  let village = null;
  let residentialEdits = [];
  let focusedParcelId = null;
  let view = null;
  let standaloneParams = {};
  if (fields.has('vs')) {
    const villageSeed = decodeUint32(fields.get('vs'));
    const scale = readOptionalEnum(fields, 'z', SCALE_CODES, 'village');
    const character = readOptionalEnum(fields, 'ch', CHARACTER_CODES, 'yeoyeom');
    if (villageSeed == null || !scale || !character) return null;
    const palaceDefault = scale === 'hanyang';
    const includePalace = fields.has('pa') ? decodeBoolean(fields.get('pa')) : palaceDefault;
    const includeTemple = fields.has('te') ? decodeBoolean(fields.get('te')) : false;
    if (includePalace == null || includeTemple == null) return null;
    village = {
      seed: villageSeed,
      scale,
      character,
      includePalace,
      includeTemple,
      ...VILLAGE_OPTION_DEFAULTS,
    };
    for (const [field, spec] of Object.entries(VILLAGE_NUMBER_FIELDS)) {
      if (!fields.has(field)) continue;
      const value = decodeStepped(fields.get(field), spec);
      if (value == null) return null;
      village[spec.key] = value;
    }
    if (fields.has('st')) {
      const value = decodeBoolean(fields.get('st'));
      if (value !== false) return null;
      village.stream = false;
    }
    if (fields.has('rv')) {
      const value = decodeBoolean(fields.get('rv'));
      if (value !== true) return null;
      village.river = true;
    }
    for (const [field, key] of [['cw', 'cityWall'], ['sj', 'sijeon']]) {
      if (!fields.has(field)) continue;
      const value = decodeBoolean(fields.get(field));
      if (value == null) return null;
      village[key] = value;
    }
    if (fields.has('ww')) {
      const wallWeights = decodeWallWeights(fields.get('ww'));
      if (!wallWeights) return null;
      village.wallWeights = wallWeights;
    }
    if (fields.has('f')) {
      focusedParcelId = fields.get('f');
      if (!SAFE_ID_RE.test(focusedParcelId)) return null;
    }
    if (fields.has('ed')) {
      const edits = decodeResidentialEditState(
        fields.get('ed').replaceAll(EMBEDDED_SEPARATOR, FIELD_SEPARATOR),
      );
      if (!edits) return null;
      residentialEdits = edits.records;
      focusedParcelId ||= edits.focusedParcelId;
    }
  } else if ([...fields.keys()].some((key) => (
    ['z', 'ch', 'pa', 'te', 'sr', 'u', 'rh', 'sm', 'st', 'rv', 'pd', 'td', 'cw', 'sj',
      'c1', 'dv', 'hs', 'ww', 'f', 'ed'].includes(key)
  ))) {
    return null;
  }
  if (fields.has('hp')) {
    if (village) return null;
    standaloneParams = decodeStandaloneParams(fields.get('hp'));
    if (!standaloneParams) return null;
  }
  if (fields.has('vw')) {
    view = decodeView(fields.get('vw'));
    if (!view) return null;
  }

  return {
    version: SCENE_SNAPSHOT_VERSION,
    seed,
    time,
    preset,
    sunsetLook,
    season,
    weather,
    renderStyle,
    expansion,
    flow: fields.has('fl'),
    village,
    residentialEdits,
    focusedParcelId,
    view,
    standaloneParams,
    overrides: {
      preset: fields.has('p'),
      time: true,
      sunsetLook: fields.has('su'),
      season: fields.has('se'),
      weather: fields.has('we'),
    },
  };
}

export function buildSceneSnapshotUrl({ baseUrl, ...snapshot } = {}) {
  let base;
  try {
    base = new URL(baseUrl);
  } catch {
    return null;
  }
  const payload = encodeSceneSnapshot(snapshot);
  if (!payload) return null;
  const query = new URLSearchParams({ [SCENE_SNAPSHOT_QUERY_KEY]: payload });
  const url = `${base.origin}${base.pathname}?${query.toString()}`;
  return url.length <= MAX_SCENE_SNAPSHOT_URL_LENGTH ? url : null;
}
