// 빠른 순수 plan 회귀 게이트. Playwright·THREE·네트워크 없이 5규모 × 절 OFF/ON을 검사한다.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planVillage } from '../src/api/village-plan.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(HERE, 'plan-contract.json'), 'utf8'));
const scales = ['hamlet', 'village', 'town', 'capital', 'hanyang'];

function canonical(value, seen = new WeakSet()) {
  if (typeof value === 'function' || value === undefined) return undefined;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`non-finite number in plan: ${value}`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (ArrayBuffer.isView(value)) return Array.from(value);
  if (Array.isArray(value)) return value.map((item) => canonical(item, seen));
  if (typeof value === 'object') {
    if (seen.has(value)) throw new Error('cycle in plan data');
    seen.add(value);
    const out = {};
    for (const key of Object.keys(value).sort()) {
      const item = canonical(value[key], seen);
      if (item !== undefined) out[key] = item;
    }
    seen.delete(value);
    return out;
  }
  return String(value);
}

function buildWithoutGlobalRandom(options) {
  const original = Math.random;
  Math.random = () => { throw new Error('planVillage consumed global Math.random'); };
  try { return planVillage(options); }
  finally { Math.random = original; }
}

function snapshot(options) {
  const before = JSON.stringify(options);
  const plan = buildWithoutGlobalRandom(options);
  if (JSON.stringify(options) !== before) throw new Error('planVillage mutated input options');
  const json = JSON.stringify(canonical(plan));
  return {
    plan,
    json,
    bytes: Buffer.byteLength(json),
    hash: createHash('sha256').update(json).digest('hex'),
  };
}

const errors = [];
for (const includeTemple of [false, true]) {
  for (const scale of scales) {
    const label = `${scale}:${includeTemple ? 'temple' : 'base'}`;
    const options = Object.freeze({
      scale,
      seed: fixture.seed,
      includeTemple,
      includePalace: scale === 'capital' || scale === 'hanyang',
    });
    const a = snapshot(options);
    const b = snapshot(options);
    const expected = fixture.cases[label];

    if (a.hash !== b.hash) errors.push(`${label}: repeated builds differ (${a.hash} != ${b.hash})`);
    if (!includeTemple && a.plan.features?.temple) errors.push(`${label}: temple exists while includeTemple=false`);
    if (includeTemple && !a.plan.features?.temple) errors.push(`${label}: temple missing while includeTemple=true`);
    if (!expected) errors.push(`${label}: fixture missing`);
    else {
      if (a.hash !== expected.hash) errors.push(`${label}: hash ${a.hash} != ${expected.hash}`);
      if (a.bytes !== expected.bytes) errors.push(`${label}: bytes ${a.bytes} != ${expected.bytes}`);
    }

    console.log(
      `${label.padEnd(18)} ${a.hash.slice(0, 12)}  bytes=${String(a.bytes).padStart(6)}`
      + `  parcels=${String(a.plan.parcels.length).padStart(3)}`,
    );
  }
}

if (errors.length) {
  console.error(`PLAN CONTRACT: FAIL (${errors.length})`);
  for (const error of errors) console.error(`  - ${error}`);
  console.error('If the plan change is intentional, review every diff before updating tools/plan-contract.json.');
  process.exit(1);
}

console.log(`PLAN CONTRACT: PASS (${Object.keys(fixture.cases).length} golden cases, baseline ${fixture.baselineCommit})`);
