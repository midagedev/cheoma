// Product-owned, renderer-free contract for the five committed standalone
// building controls. ParamPanel, the snapshot codec, and the engine boundary
// consume the same ordered definitions so ranges cannot drift.

export const STANDALONE_PARAM_SPECS = Object.freeze([
  Object.freeze({ key: 'roofPitch', min: 0.4, max: 0.95, step: 0.01 }),
  Object.freeze({ key: 'riseScale', min: 0.6, max: 1.3, step: 0.01 }),
  Object.freeze({ key: 'eaveOverhang', min: 1, max: 3, step: 0.05 }),
  Object.freeze({ key: 'cornerLift', min: 0, max: 1.6, step: 0.01 }),
  Object.freeze({ key: 'profileCurve', min: 0, max: 1, step: 0.01 }),
]);

export const STANDALONE_PARAM_KEYS = Object.freeze(
  STANDALONE_PARAM_SPECS.map(({ key }) => key),
);

export const STANDALONE_PARAM_SPEC_BY_KEY = Object.freeze(
  Object.fromEntries(STANDALONE_PARAM_SPECS.map((spec) => [spec.key, spec])),
);

// One main building plus the authored dependent wings. Keep this renderer-free
// so the engine stepper and the URL boundary reject the same impossible state.
export const STANDALONE_MAX_EXPANSION_BY_PRESET = Object.freeze({
  korea: 3,
  temple: 3,
  giwa: 1,
  choga: 3,
});

export function standaloneMaxExpansion(preset) {
  return STANDALONE_MAX_EXPANSION_BY_PRESET[preset] ?? 1;
}

function steppedValue(value, spec) {
  if (!Number.isFinite(value) || value < spec.min || value > spec.max) return null;
  const units = Math.round((value - spec.min) / spec.step);
  const normalized = Number((spec.min + units * spec.step).toFixed(6));
  return Math.abs(normalized - value) <= 1e-8 && normalized <= spec.max
    ? normalized
    : null;
}

export function normalizeStandaloneParamPatch(value, {
  allowedKeys = STANDALONE_PARAM_KEYS,
} = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const allowed = new Set(allowedKeys);
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.has(key) || !STANDALONE_PARAM_SPEC_BY_KEY[key])) return null;
  const normalized = {};
  for (const { key, ...spec } of STANDALONE_PARAM_SPECS) {
    if (!Object.hasOwn(value, key)) continue;
    const stepped = steppedValue(value[key], spec);
    if (stepped == null) return null;
    normalized[key] = stepped;
  }
  return normalized;
}

export function pickStandaloneParams(value) {
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(STANDALONE_PARAM_SPECS
    .filter(({ key }) => Number.isFinite(value[key]))
    .map(({ key }) => [key, value[key]]));
}
