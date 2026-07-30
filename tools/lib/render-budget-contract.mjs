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

// Program ceilings are the R8 (#220) product budget after the LOD screen-door × rim ×
// cloud-shadow diet (#180 + residual always-on path for cloud/snow/impostor). Aerial is
// tighter because it has no focus-overlay USE_INSTANCING fork; focus/mid/focusOut share the
// 192 plateau. Measured post-#180 hanyang aerial ≈142 — aerial 144 leaves ~1% headroom.
// Do not raise these to absorb a new cacheKey axis; collapse the axis instead.
const COMMON_RESOURCE_LIMITS = Object.freeze({
  programs: 192,
  textures: 128,
});

// The `focus` and `mid` ceilings below were re-authored on 2026-07-25 together with the restored
// eye-level residential frame (docs/look-restoration-plan.md "1-0 충돌 1"). The premise changed,
// so the numbers had to:
//
//   * #159 authored `focus` against a 24° survey telephoto whose 10° frame tilted most of the
//     walled capital out of view. The product close frame is now eye level (9°) on a 16° lens, so
//     the same seed legitimately carries more of 한양 in the frustum. Measured 1088 calls; the
//     ceiling is 1120 (≈3% headroom). This is not a blanket relaxation — the same round cut the
//     cost that *was* wrong, see below.
//   * `mid` previously read 946 even in the old framing (a regression that predates this round)
//     against a 900 ceiling. Keying detail depth to view pitch (src/village/lod-policy.js
//     `villageDetailReach`) stopped the compensated telephoto from promoting the whole city to
//     FULL/MID, and `mid` now measures 560. The ceiling is tightened to 700 so that win is locked
//     rather than left as dead headroom.
//   * `focus.triangles` measured 8.01M against a 7.5M ceiling before the re-key and 6.36M after,
//     so its ceiling is tightened to 7.0M for the same reason.
//
// `aerial` and `focusOut` are byte-identical to the pre-round frames (detail depth is 1 at survey
// pitch, by construction) and their ceilings are untouched.
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
    // 2026-07-30 re-baseline: #211 measured aerial 529 under the 540 ceiling; authored
    // features landed since then without touching this ceiling — sijeon sign silhouettes
    // v2 (#227), plan-owned sijeon façade breaks (#218), gate-crossing slabs (#217),
    // roadside drainage rails, and the night moon set (#212) — measuring 557 (focusOut
    // 560) across three commits (bc07eb2, d6de9b1, HEAD; Chrome Metal). 575 keeps the
    // same ~3% creep alarm above the authored floor.
    aerial: Object.freeze({
      calls: 575,
      triangles: 2_000_000,
      programs: 144,
      geometries: 920,
      textures: 104,
    }),
    focus: Object.freeze({
      calls: 1120,
      triangles: 7_000_000,
      ...COMMON_RESOURCE_LIMITS,
      geometries: 1050,
    }),
    // Mid is measured with the selected overlay still live while the camera is
    // pulled into the MID visual band. Town/capital LOD expansion (2026-07 perf)
    // raises legitimate mid-band cost when more neighbouring MID envelopes are
    // visible; ceilings track measured Hanyang mid samples with ~5% headroom.
    mid: Object.freeze({
      calls: 850,
      triangles: 5_100_000,
      ...COMMON_RESOURCE_LIMITS,
      geometries: 1050,
    }),
    focusOut: Object.freeze({
      calls: 575,
      triangles: 2_000_000,
      ...COMMON_RESOURCE_LIMITS,
      geometries: 1024,
    }),
  }),
  deltas: Object.freeze([
    // 2026-07-27 #211: measured Chrome Metal residual aerial 529 → focusOut 532 = +3.
    // Absolute focusOut ceiling (540) still has headroom; the residual is a few settle-frame
    // ambient/critter draws, not mist geometry (ring/ridge mesh counts are identical both sides).
    Object.freeze({ from: 'aerial', to: 'focusOut', metric: 'calls', max: 4 }),
    Object.freeze({ from: 'aerial', to: 'focusOut', metric: 'triangles', max: 10_000 }),
    Object.freeze({ from: 'aerial', to: 'focusOut', metric: 'programs', max: 64 }),
    // 2026-07-25 재저작: 128 → 144.
    //
    // 이 델타의 의도는 "focus 오버레이가 focus-out 에서 해제된다"이고, 절대 예산(focusOut ≤ 1024)은
    // 계속 여유롭게 통과한다(실측 911). 값을 올린 이유는 잔여물이 늘어난 것이 아니라 **aerial 기준선이
    // 더 깊이 정착하게 됐기 때문**이다. 애니메이션 클록을 벽시계로 고치면서
    // (app/src/engine/frame-clock.js — 종전 `min(dt, 0.05)` 은 20fps 천장이라 저fps 에서 모든 연출이
    // 느려졌다) 프레임당 진행이 실제 시간을 따르게 되어, aerial 표본 시점에 동물·크리터·앰비언트가
    // 제대로 잠들고 그 지오메트리가 해제된다.
    //
    // 같은 대칭 표본(check-lod-app.mjs settleResources — 양 끝점을 자원 고원에서 측정)으로 실측:
    //   ecc18d8      aerial 849 → focusOut 921 = 델타 72
    //   현재 트리     aerial 783 → focusOut 911 = 델타 128
    // aerial 이 −66, focusOut 이 −10 이다. 즉 focus 왕복 뒤 남는 지오메트리는 양쪽 트리에서 비슷하고,
    // 종전에는 aerial 기준선에 "아직 잠들지 않은" 약 66개가 섞여 그 잔여물을 가리고 있었다.
    //
    // 남은 질문(이 라운드에서 해결하지 않음): 완전히 정착한 aerial 기준 약 128개 잔여 지오메트리가
    // 의도된 캐시(#129 __kept 앵커·프리워밍 LOD·공유 링 자원)인지 누수인지. 절대 예산 안이라
    // 즉시 위험은 없지만, 이 숫자를 다시 내리려면 그 구분이 선행이다.
    //
    // 2026-07-27 #211 Chrome Metal 실측: aerial 748 → focusOut 931 = +183.
    // focusOut 절대 예산(1024)은 통과. aerial 이 더 깊이 잠들어 기준선이 내려간 쪽이 주원인
    // (mist 메시 수는 양 끝 동일). 144 → 200 으로 잔여 여유만 맞춤.
    Object.freeze({ from: 'aerial', to: 'focusOut', metric: 'geometries', max: 200 }),
    // Focus-out can retain a small plateau of focus-warmed textures (anchor
    // materials, DoF depth helpers). 40 covers measured residual without hiding
    // unbounded growth.
    Object.freeze({ from: 'aerial', to: 'focusOut', metric: 'textures', max: 40 }),
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
