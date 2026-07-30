// #26 고쳐짓기 — parameter live-morph plan contract (pure, browser-free).
//
// planRebuildMorph turns the focused parcel's edit schema into a seeded,
// deterministic morph plan (continuous eased windows + one-shot discrete
// flips); advanceRebuildMorph is its pure evaluator. The App drives the plan
// through the existing live-edit scheduler, so everything assertable about
// the motion lives here: seed determinism, boundary exactness (t=0 → from,
// t=duration → to), easing monotonicity without overshoot, single discrete
// flips at window start, meaningful-but-bounded field selection, group
// stagger ordering (roof → form → skin), and value continuity across a
// cancel → restart handoff.
import assert from 'node:assert/strict';
import { schemaFor } from '../app/src/lib/edit-schema.js';
import { planRebuildMorph, advanceRebuildMorph } from '../app/src/lib/rebuild-morph.js';

const DURATION = 2800;
const ROOF_SECTIONS = new Set(['roof', 'roofadv']);
const FORM_SECTIONS = new Set(['plan', 'plandims', 'proportion', 'structure', 'podium', 'bracket', 'temple-plan']);

const SPECS = {
  choga: { kind: 'choga', params: {} },
  giwa: { kind: 'giwa', params: { planShape: 'l', bays: 3, bay: 2.2 } },
  heroHanok: { hero: true, heroStyle: 'hanok', params: {} },
  magistracy: { hero: true, heroStyle: 'palace', params: {} },
  palaceCompound: { family: 'palace-compound', params: {} },
  temple: {
    family: 'temple',
    params: { variant: 'axis' },
    variantOptions: ['compact', 'axis', 'extended'],
    hallRange: { min: 1, max: 4 },
  },
};

function fieldIndex(schema) {
  const byKey = new Map();
  for (const section of schema.sections) {
    for (const field of section.fields) byKey.set(field.key, { ...field, sectionId: section.id });
  }
  return byKey;
}

// Simulated live editParams: every schema key seeded like the panel would be
// (def wins, else range midpoint / first option), deliberately off the step
// grid for one axis to prove t=0 continuity never quantizes the from value.
function liveParams(schema) {
  const params = {};
  for (const [key, f] of fieldIndex(schema)) {
    if (f.ctrl === 'range') {
      params[key] = Number.isFinite(f.def) ? f.def : (f.min + f.max) / 2;
    } else if (f.ctrl === 'stepper') {
      params[key] = Number.isFinite(f.def) ? f.def : f.min;
    } else if (f.ctrl === 'segment') {
      params[key] = f.def ?? f.options?.[0];
    } else if (f.ctrl === 'toggle') {
      params[key] = false;
    }
  }
  return params;
}

function groupOf(sectionId) {
  if (ROOF_SECTIONS.has(sectionId)) return 0;
  if (FORM_SECTIONS.has(sectionId)) return 1;
  return 2;
}

let plansChecked = 0;
for (const [name, spec] of Object.entries(SPECS)) {
  const schema = schemaFor(spec);
  const byKey = fieldIndex(schema);
  const rangeCandidates = [...byKey.values()].filter((f) => f.ctrl === 'range').length;
  assert.ok(rangeCandidates >= 4, `${name}: fixture must expose >=4 continuous axes (got ${rangeCandidates})`);
  const current = liveParams(schema);
  // Off-grid from value: prove continuity holds for a mid-drag live value.
  const anyRangeKey = [...byKey.values()].find((f) => f.ctrl === 'range').key;
  current[anyRangeKey] += 0.001234;

  for (let seed = 1; seed <= 24; seed++) {
    const plan = planRebuildMorph({ schema, current, seed, duration: DURATION, excludeKeys: ['variant'] });
    plansChecked++;

    // ── determinism ──────────────────────────────────────────────────────
    const replay = planRebuildMorph({ schema, current, seed, duration: DURATION, excludeKeys: ['variant'] });
    assert.deepEqual(replay, plan, `${name}/${seed}: same seed must reproduce the identical plan`);

    // ── field selection bounds ───────────────────────────────────────────
    const cont = plan.fields.filter((f) => f.kind === 'range');
    const disc = plan.fields.filter((f) => f.kind === 'discrete');
    assert.ok(cont.length >= Math.min(4, rangeCandidates) && cont.length <= 7,
      `${name}/${seed}: continuous axis count ${cont.length} outside the 4–7 window`);
    assert.ok(disc.length <= 2, `${name}/${seed}: discrete axis count ${disc.length} exceeds 2`);
    const keys = plan.fields.map((f) => f.key);
    assert.equal(new Set(keys).size, keys.length, `${name}/${seed}: duplicate morph field`);
    assert.ok(!keys.includes('variant'), `${name}/${seed}: excluded key was selected`);
    for (const f of plan.fields) {
      const schemaField = byKey.get(f.key);
      assert.ok(schemaField, `${name}/${seed}: ${f.key} is not a schema field`);
      assert.ok(f.t0 >= 0 && f.t1 <= plan.duration && f.t0 < f.t1,
        `${name}/${seed}: ${f.key} window [${f.t0}, ${f.t1}] escapes [0, ${plan.duration}]`);
      if (f.kind === 'range') {
        const range = schemaField.max - schemaField.min;
        assert.ok(f.to >= schemaField.min - 1e-9 && f.to <= schemaField.max + 1e-9,
          `${name}/${seed}: ${f.key} target ${f.to} escapes [${schemaField.min}, ${schemaField.max}]`);
        assert.ok(Math.abs(f.to - f.from) >= 0.2 * range - 1e-9,
          `${name}/${seed}: ${f.key} morph ${f.from}→${f.to} is not a meaningful change`);
      } else {
        assert.ok(f.t0 > 0, `${name}/${seed}: discrete ${f.key} may not flip at t=0`);
        assert.notDeepEqual(f.to, f.from, `${name}/${seed}: discrete ${f.key} is a no-op flip`);
        if (schemaField.ctrl === 'segment') {
          assert.ok(schemaField.options.includes(f.to), `${name}/${seed}: ${f.key} target off the option list`);
        }
        if (schemaField.ctrl === 'stepper') {
          assert.equal(f.to, Math.round(f.to), `${name}/${seed}: stepper ${f.key} target not an integer`);
          assert.ok(f.to >= schemaField.min && f.to <= schemaField.max,
            `${name}/${seed}: stepper ${f.key} target ${f.to} escapes bounds`);
        }
      }
    }

    // ── group stagger: roof leads, skin trails ───────────────────────────
    const groupStarts = new Map();
    for (const f of plan.fields) {
      const g = groupOf(byKey.get(f.key).sectionId);
      if (!groupStarts.has(g)) groupStarts.set(g, []);
      groupStarts.get(g).push(f.t0);
    }
    const present = [...groupStarts.keys()].sort();
    for (let i = 1; i < present.length; i++) {
      const earlier = Math.min(...groupStarts.get(present[i - 1]));
      const later = Math.min(...groupStarts.get(present[i]));
      assert.ok(earlier <= later,
        `${name}/${seed}: group ${present[i - 1]} must open no later than group ${present[i]}`);
    }
    if (plan.fields.length >= 3) {
      assert.ok(new Set(plan.fields.map((f) => f.t0)).size >= 2,
        `${name}/${seed}: no stagger — every window starts at the same time`);
    }

    // ── boundaries: t=0 exact from, t=duration exact to, done flag ───────
    const start = advanceRebuildMorph(plan, 0);
    assert.equal(start.done, false, `${name}/${seed}: done at t=0`);
    for (const f of plan.fields) {
      assert.deepEqual(start.values[f.key], f.from,
        `${name}/${seed}: ${f.key} at t=0 must equal from exactly (continuity)`);
    }
    const mid = advanceRebuildMorph(plan, plan.duration * 0.999);
    assert.equal(mid.done, false, `${name}/${seed}: done before duration`);
    const end = advanceRebuildMorph(plan, plan.duration);
    assert.equal(end.done, true, `${name}/${seed}: not done at t=duration`);
    for (const f of plan.fields) {
      assert.deepEqual(end.values[f.key], f.to,
        `${name}/${seed}: ${f.key} at t=duration must equal to exactly`);
    }
    assert.equal(advanceRebuildMorph(plan, plan.duration + 500).done, true,
      `${name}/${seed}: overrun time must stay done`);

    // ── easing monotonicity without overshoot; single discrete flip ──────
    const STEPS = 200;
    const samples = [];
    for (let i = 0; i <= STEPS; i++) samples.push(advanceRebuildMorph(plan, (plan.duration * i) / STEPS).values);
    for (const f of plan.fields) {
      if (f.kind === 'range') {
        const dir = Math.sign(f.to - f.from);
        const lo = Math.min(f.from, f.to) - 1e-9;
        const hi = Math.max(f.from, f.to) + 1e-9;
        for (let i = 1; i <= STEPS; i++) {
          const prev = samples[i - 1][f.key];
          const next = samples[i][f.key];
          assert.ok((next - prev) * dir >= -1e-9,
            `${name}/${seed}: ${f.key} regressed at sample ${i} (${prev} → ${next})`);
          assert.ok(next >= lo && next <= hi,
            `${name}/${seed}: ${f.key} overshot to ${next} outside [${lo}, ${hi}]`);
        }
      } else {
        let flips = 0;
        let flipAt = -1;
        for (let i = 1; i <= STEPS; i++) {
          if (!Object.is(samples[i][f.key], samples[i - 1][f.key])) { flips++; flipAt = (plan.duration * i) / STEPS; }
        }
        assert.equal(flips, 1, `${name}/${seed}: discrete ${f.key} flipped ${flips} times`);
        assert.ok(flipAt >= f.t0 && flipAt <= f.t0 + plan.duration / STEPS + 1e-9,
          `${name}/${seed}: discrete ${f.key} flipped at ${flipAt}, window opens at ${f.t0}`);
      }
    }
  }

  // ── cancel → restart continuity ────────────────────────────────────────
  const planA = planRebuildMorph({ schema, current, seed: 11, duration: DURATION, excludeKeys: ['variant'] });
  const midway = advanceRebuildMorph(planA, DURATION * 0.4).values;
  const handoff = { ...current, ...midway };
  const planB = planRebuildMorph({ schema, current: handoff, seed: 99, duration: DURATION, excludeKeys: ['variant'] });
  const resumed = advanceRebuildMorph(planB, 0).values;
  for (const f of planB.fields) {
    assert.deepEqual(resumed[f.key], handoff[f.key],
      `${name}: restart of ${f.key} must depart from the interpolated value, not snap`);
  }
}

// ── seed variety: the selection window must actually vary by seed ────────
{
  const schema = schemaFor(SPECS.choga);
  const current = liveParams(schema);
  const signatures = new Set();
  for (let seed = 1; seed <= 20; seed++) {
    const plan = planRebuildMorph({ schema, current, seed, duration: DURATION });
    signatures.add(plan.fields.map((f) => `${f.key}:${f.kind === 'range' ? f.to.toFixed(4) : String(f.to)}`).join('|'));
  }
  assert.ok(signatures.size >= 10, `seed variety too low: ${signatures.size}/20 distinct plans`);
}

// ── degenerate inputs stay safe ───────────────────────────────────────────
{
  const empty = planRebuildMorph({ schema: { family: 'regular', sections: [] }, current: {}, seed: 3, duration: DURATION });
  assert.deepEqual(empty.fields, [], 'empty schema must plan zero fields');
  assert.equal(advanceRebuildMorph(empty, 0).done, false, 'empty plan still reports time progress');
  assert.equal(advanceRebuildMorph(empty, DURATION).done, true, 'empty plan finishes on schedule');
}

console.log(`REBUILD MORPH: PASS (${plansChecked} plans across ${Object.keys(SPECS).length} families — `
  + 'seed determinism, 4–7+≤2 selection, roof→form→skin stagger, exact boundaries, '
  + 'monotone no-overshoot easing, single discrete flips, restart continuity)');
