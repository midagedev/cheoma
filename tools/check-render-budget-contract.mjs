import assert from 'node:assert/strict';
import {
  HANYANG_RENDER_BUDGET,
  RENDER_BUDGET_METRICS,
  RENDER_BUDGET_STATES,
  evaluateRenderBudget,
} from './lib/render-budget-contract.mjs';

const clone = (value) => structuredClone(value);

function atLimits() {
  return {
    fixture: clone(HANYANG_RENDER_BUDGET.fixture),
    states: RENDER_BUDGET_STATES.map((state) => ({
      state,
      samples: [
        clone(HANYANG_RENDER_BUDGET.limits[state]),
        clone(HANYANG_RENDER_BUDGET.limits[state]),
      ],
    })),
  };
}

function expectFailure(contract, report, pattern) {
  const result = evaluateRenderBudget(contract, report);
  assert.equal(result.ok, false);
  assert.match(result.violations.join('\n'), pattern);
  return result;
}

assert.equal(evaluateRenderBudget(HANYANG_RENDER_BUDGET, atLimits()).ok, true);

let ceilingChecks = 0;
for (const state of RENDER_BUDGET_STATES) {
  for (const metric of RENDER_BUDGET_METRICS) {
    const report = atLimits();
    const record = report.states.find((entry) => entry.state === state);
    record.samples[0][metric]++;
    record.samples[1][metric]++;
    // A cheaper unrelated metric may never compensate for an exceeded metric.
    const otherMetric = metric === 'calls' ? 'triangles' : 'calls';
    record.samples[0][otherMetric] = 0;
    record.samples[1][otherMetric] = 0;
    expectFailure(
      HANYANG_RENDER_BUDGET,
      report,
      new RegExp(`${state}\\.${metric} .* exceeds`),
    );
    ceilingChecks++;
  }
}

{
  const report = atLimits();
  report.states.pop();
  expectFailure(HANYANG_RENDER_BUDGET, report, /state focusOut is missing/);
}
{
  const report = atLimits();
  report.states.push(clone(report.states[0]));
  expectFailure(HANYANG_RENDER_BUDGET, report, /state aerial is duplicated/);
}
{
  const report = atLimits();
  report.states[0].state = 'unknown';
  expectFailure(HANYANG_RENDER_BUDGET, report, /state "unknown" is not supported/);
}
{
  const report = atLimits();
  report.fixture.viewport.width++;
  expectFailure(HANYANG_RENDER_BUDGET, report, /fixture\.viewport\.width expected/);
}
for (const invalid of [Number.NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
  const report = atLimits();
  report.states[0].samples[0].calls = invalid;
  expectFailure(HANYANG_RENDER_BUDGET, report, /must be a non-negative safe integer/);
}
{
  const contract = clone(HANYANG_RENDER_BUDGET);
  contract.schemaVersion = 2;
  expectFailure(contract, atLimits(), /schemaVersion expected 1/);
}
{
  const contract = clone(HANYANG_RENDER_BUDGET);
  contract.limits.focus.calls = -1;
  expectFailure(contract, atLimits(), /contract\.limits\.focus\.calls must be/);
}
{
  const report = atLimits();
  report.states[0].samples.pop();
  expectFailure(HANYANG_RENDER_BUDGET, report, /must contain exactly 2 measured samples/);
}
{
  const report = atLimits();
  report.states[0].samples[1].calls--;
  expectFailure(HANYANG_RENDER_BUDGET, report, /did not plateau/);
}
{
  const report = atLimits();
  const aerial = report.states.find((entry) => entry.state === 'aerial');
  const focusOut = report.states.find((entry) => entry.state === 'focusOut');
  aerial.samples[0].geometries = 0;
  aerial.samples[1].geometries = 0;
  focusOut.samples[0].geometries = 129;
  focusOut.samples[1].geometries = 129;
  expectFailure(HANYANG_RENDER_BUDGET, report, /delta aerial->focusOut\.geometries 129 exceeds 128/);
}
{
  const report = atLimits();
  report.states.reverse();
  const first = evaluateRenderBudget(HANYANG_RENDER_BUDGET, report);
  report.states.reverse();
  const second = evaluateRenderBudget(HANYANG_RENDER_BUDGET, report);
  assert.deepEqual(first, second);
}

console.log(
  `RENDER BUDGET CONTRACT: PASS (${ceilingChecks} independent metric ceilings, `
  + 'plateau, fixture, schema, counter, state, order and residue failures)',
);
