export const RENDER_BUDGET_STATES = Object.freeze([
  'aerial',
  'focus',
  'mid',
  'focusOut',
]);

export const RENDER_BUDGET_METRICS = Object.freeze([
  'calls',
  'triangles',
  'programs',
  'geometries',
  'textures',
]);

const COMMON_RESOURCE_LIMITS = Object.freeze({
  programs: 192,
  textures: 128,
});

export const HANYANG_RENDER_BUDGET = Object.freeze({
  schemaVersion: 1,
  fixture: Object.freeze({
    scale: 'hanyang',
    seed: 20260716,
    viewport: Object.freeze({ width: 960, height: 640 }),
    worker: false,
    post: false,
  }),
  limits: Object.freeze({
    aerial: Object.freeze({
      calls: 540,
      triangles: 2_000_000,
      programs: 144,
      geometries: 920,
      textures: 104,
    }),
    focus: Object.freeze({
      calls: 1000,
      triangles: 7_500_000,
      ...COMMON_RESOURCE_LIMITS,
      geometries: 1050,
    }),
    mid: Object.freeze({
      calls: 900,
      triangles: 3_500_000,
      ...COMMON_RESOURCE_LIMITS,
      geometries: 1050,
    }),
    focusOut: Object.freeze({
      calls: 540,
      triangles: 2_000_000,
      ...COMMON_RESOURCE_LIMITS,
      geometries: 1024,
    }),
  }),
  deltas: Object.freeze([
    Object.freeze({ from: 'aerial', to: 'focusOut', metric: 'calls', max: 2 }),
    Object.freeze({ from: 'aerial', to: 'focusOut', metric: 'triangles', max: 10_000 }),
    Object.freeze({ from: 'aerial', to: 'focusOut', metric: 'programs', max: 64 }),
    Object.freeze({ from: 'aerial', to: 'focusOut', metric: 'geometries', max: 128 }),
    Object.freeze({ from: 'aerial', to: 'focusOut', metric: 'textures', max: 32 }),
  ]),
});

function isCounter(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function fixtureEntries(fixture) {
  return [
    ['scale', fixture?.scale],
    ['seed', fixture?.seed],
    ['viewport.width', fixture?.viewport?.width],
    ['viewport.height', fixture?.viewport?.height],
    ['worker', fixture?.worker],
    ['post', fixture?.post],
  ];
}

function validateFixture(expected, actual, violations) {
  const actualByKey = new Map(fixtureEntries(actual));
  for (const [key, value] of fixtureEntries(expected)) {
    if (actualByKey.get(key) !== value) {
      violations.push(`fixture.${key} expected ${JSON.stringify(value)}, got ${JSON.stringify(actualByKey.get(key))}`);
    }
  }
}

function validateMetrics(metrics, label, violations) {
  let valid = true;
  for (const metric of RENDER_BUDGET_METRICS) {
    if (!isCounter(metrics?.[metric])) {
      violations.push(`${label}.${metric} must be a non-negative safe integer`);
      valid = false;
    }
  }
  return valid;
}

export function evaluateRenderBudget(contract, report) {
  const violations = [];
  if (contract?.schemaVersion !== 1) {
    violations.push(`contract.schemaVersion expected 1, got ${JSON.stringify(contract?.schemaVersion)}`);
  }
  validateFixture(contract?.fixture, report?.fixture, violations);

  const validLimits = new Map();
  for (const state of RENDER_BUDGET_STATES) {
    const limits = contract?.limits?.[state];
    if (validateMetrics(limits, `contract.limits.${state}`, violations)) {
      validLimits.set(state, limits);
    }
  }

  const records = Array.isArray(report?.states) ? report.states : [];
  if (!Array.isArray(report?.states)) violations.push('report.states must be an array');
  const recordsByState = new Map();
  for (const record of records) {
    const state = record?.state;
    if (!RENDER_BUDGET_STATES.includes(state)) {
      violations.push(`report state ${JSON.stringify(state)} is not supported`);
      continue;
    }
    if (recordsByState.has(state)) {
      violations.push(`report state ${state} is duplicated`);
      continue;
    }
    recordsByState.set(state, record);
  }

  const measured = {};
  for (const state of RENDER_BUDGET_STATES) {
    const record = recordsByState.get(state);
    if (!record) {
      violations.push(`report state ${state} is missing`);
      continue;
    }
    if (!Array.isArray(record.samples) || record.samples.length !== 2) {
      violations.push(`report state ${state} must contain exactly 2 measured samples`);
      continue;
    }
    const samplesValid = record.samples.map((sample, index) => (
      validateMetrics(sample, `report.${state}.samples[${index}]`, violations)
    ));
    if (!samplesValid.every(Boolean)) continue;
    for (const metric of RENDER_BUDGET_METRICS) {
      if (record.samples[0][metric] !== record.samples[1][metric]) {
        violations.push(
          `report state ${state}.${metric} did not plateau: `
          + `${record.samples[0][metric]} -> ${record.samples[1][metric]}`,
        );
      }
    }
    const value = { ...record.samples[1] };
    measured[state] = value;
    const limits = validLimits.get(state);
    if (!limits) continue;
    for (const metric of RENDER_BUDGET_METRICS) {
      if (value[metric] > limits[metric]) {
        violations.push(
          `report state ${state}.${metric} ${value[metric]} exceeds ${limits[metric]}`,
        );
      }
    }
  }

  if (!Array.isArray(contract?.deltas)) {
    violations.push('contract.deltas must be an array');
  } else {
    for (let index = 0; index < contract.deltas.length; index++) {
      const delta = contract.deltas[index];
      const validStates = RENDER_BUDGET_STATES.includes(delta?.from)
        && RENDER_BUDGET_STATES.includes(delta?.to);
      const validMetric = RENDER_BUDGET_METRICS.includes(delta?.metric);
      const validMax = isCounter(delta?.max);
      if (!validStates || !validMetric || !validMax) {
        violations.push(`contract.deltas[${index}] is invalid`);
        continue;
      }
      const from = measured[delta.from]?.[delta.metric];
      const to = measured[delta.to]?.[delta.metric];
      if (!isCounter(from) || !isCounter(to)) continue;
      if (to - from > delta.max) {
        violations.push(
          `report delta ${delta.from}->${delta.to}.${delta.metric} `
          + `${to - from} exceeds ${delta.max}`,
        );
      }
    }
  }

  return {
    ok: violations.length === 0,
    violations,
    measured,
  };
}
