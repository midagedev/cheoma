import { VILLAGE_SITE_R_MAX, VILLAGE_SITE_R_MIN } from './site.js';

// Renderer-free source of truth for village option meaning. The planner, app
// controls, preload cache, and portable scene codec consume these same bounds
// so adding a generation axis cannot silently make shared scenes incomplete.
export const VILLAGE_WALL_STYLE_IDS = Object.freeze([
  'tile', 'stone', 'mud', 'brush', 'hedge', 'open',
]);

export const VILLAGE_NUMBER_OPTION_SPECS = Object.freeze({
  siteR: Object.freeze({
    min: VILLAGE_SITE_R_MIN, max: VILLAGE_SITE_R_MAX, step: 0.1, default: null,
  }),
  undAmpK: Object.freeze({ min: 0, max: 2.2, step: 0.05, default: 1 }),
  ridgeHK: Object.freeze({ min: 0.5, max: 1.6, step: 0.02, default: 1 }),
  streamMeanderK: Object.freeze({ min: 0, max: 2.5, step: 0.05, default: 1 }),
  paddyDensityK: Object.freeze({ min: 0, max: 2, step: 0.05, default: 1 }),
  treeDensityK: Object.freeze({ min: 0, max: 2, step: 0.05, default: 1 }),
  char01: Object.freeze({ min: 0, max: 1, step: 0.02, default: null }),
  diversityK: Object.freeze({ min: 0, max: 2, step: 0.05, default: 1 }),
  houses: Object.freeze({ min: 0, max: 400, step: 1, default: null }),
});

export const VILLAGE_WALL_WEIGHT_SPEC = Object.freeze({
  min: 0,
  max: 3,
  step: 0.05,
  default: 1,
});

export const VILLAGE_OPTION_DEFAULTS = Object.freeze({
  siteR: null,
  undAmpK: 1,
  ridgeHK: 1,
  streamMeanderK: 1,
  stream: true,
  river: false,
  paddyDensityK: 1,
  treeDensityK: 1,
  cityWall: 'auto',
  sijeon: 'auto',
  char01: null,
  diversityK: 1,
  houses: null,
  wallWeights: null,
});

const finiteClamped = (value, spec) => (
  typeof value === 'number' && Number.isFinite(value)
    ? Math.min(spec.max, Math.max(spec.min, value))
    : spec.default
);

export function normalizeVillageWallWeights(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const normalized = {};
  let any = false;
  for (const key of VILLAGE_WALL_STYLE_IDS) {
    if (typeof value[key] !== 'number' || !Number.isFinite(value[key])) continue;
    const weight = finiteClamped(value[key], VILLAGE_WALL_WEIGHT_SPEC);
    normalized[key] = weight;
    any = true;
  }
  return any ? normalized : null;
}

const triState = (value) => (
  value === true ? true : value === false ? false : 'auto'
);

export function normalizeVillageTuningOptions(value = {}) {
  return {
    undAmpK: finiteClamped(value.undAmpK, VILLAGE_NUMBER_OPTION_SPECS.undAmpK),
    ridgeHK: finiteClamped(value.ridgeHK, VILLAGE_NUMBER_OPTION_SPECS.ridgeHK),
    streamMeanderK: finiteClamped(
      value.streamMeanderK,
      VILLAGE_NUMBER_OPTION_SPECS.streamMeanderK,
    ),
    stream: value.stream === false ? false : true,
    river: value.river === true,
    paddyDensityK: finiteClamped(
      value.paddyDensityK,
      VILLAGE_NUMBER_OPTION_SPECS.paddyDensityK,
    ),
    treeDensityK: finiteClamped(
      value.treeDensityK,
      VILLAGE_NUMBER_OPTION_SPECS.treeDensityK,
    ),
    cityWall: triState(value.cityWall),
    sijeon: triState(value.sijeon),
    diversityK: finiteClamped(
      value.diversityK,
      VILLAGE_NUMBER_OPTION_SPECS.diversityK,
    ),
    wallWeights: normalizeVillageWallWeights(value.wallWeights),
  };
}

export function villageOptionDefaults() {
  return {
    ...VILLAGE_OPTION_DEFAULTS,
    wallWeights: null,
  };
}
