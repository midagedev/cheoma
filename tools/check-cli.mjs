// Packaging P1: cheoma CLI smoke (plan / inspect / validate).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'bin/cheoma.mjs');
const TMP = mkdtempSync(join(tmpdir(), 'cheoma-cli-'));

function run(args, { expectStatus = 0 } = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== expectStatus) {
    const detail = [
      `cheoma ${args.join(' ')}`,
      `expected exit ${expectStatus}, got ${result.status}`,
      result.stdout ? `stdout:\n${result.stdout}` : '',
      result.stderr ? `stderr:\n${result.stderr}` : '',
      result.error ? String(result.error) : '',
    ].filter(Boolean).join('\n');
    throw new Error(detail);
  }
  return result;
}

try {
  const planPath = join(TMP, 'plan.json');

  // plan → file exists, parses
  {
    const r = run(['plan', '--seed', '42', '--scale', 'village', '--out', planPath]);
    assert.ok(existsSync(planPath), 'plan output file missing');
    const text = readFileSync(planPath, 'utf8');
    const plan = JSON.parse(text);
    assert.equal(plan.seed, 42);
    assert.ok(Array.isArray(plan.parcels) && plan.parcels.length > 0, 'expected parcels');
    assert.ok(r.stderr.includes('parcels='), `stderr summary missing parcels=: ${r.stderr}`);
    console.log('PASS plan: wrote parseable village plan');
  }

  // determinism: two plan runs → identical bytes
  {
    const aPath = join(TMP, 'a.json');
    const bPath = join(TMP, 'b.json');
    run(['plan', '--seed', '42', '--scale', 'village', '--out', aPath]);
    run(['plan', '--seed', '42', '--scale', 'village', '--out', bPath]);
    const a = readFileSync(aPath);
    const b = readFileSync(bPath);
    assert.ok(a.equals(b), 'two plan runs must produce identical bytes');
    console.log('PASS plan: byte-identical across two runs');
  }

  // inspect includes seed and parcel count
  {
    const r = run(['inspect', planPath]);
    assert.match(r.stdout, /seed:\s*42/);
    assert.match(r.stdout, /parcels:\s*\d+/);
    console.log('PASS inspect: seed and parcel count present');
  }

  // validate all PASS
  {
    const r = run(['validate', planPath]);
    assert.match(r.stdout, /PASS/);
    assert.doesNotMatch(r.stdout, /^FAIL/m);
    assert.match(r.stdout, /validate: \d+ PASS/);
    console.log('PASS validate: all checks pass on good plan');
  }

  // tampered seed → determinism FAIL, exit 1
  {
    const badPath = join(TMP, 'bad.json');
    const plan = JSON.parse(readFileSync(planPath, 'utf8'));
    plan.seed = (plan.seed | 0) + 1;
    if (plan.opts) plan.opts.seed = plan.seed;
    writeFileSync(badPath, JSON.stringify(plan));
    const r = run(['validate', badPath], { expectStatus: 1 });
    assert.match(r.stdout, /FAIL\s+determinism/);
    console.log('PASS validate: tampered seed fails determinism');
  }

  // --help for root + three subcommands
  for (const args of [['--help'], ['plan', '--help'], ['inspect', '--help'], ['validate', '--help']]) {
    const r = run(args, { expectStatus: 0 });
    assert.ok(r.stdout.includes('Usage:'), `help missing Usage for ${args.join(' ')}`);
    console.log(`PASS help: ${args.join(' ') || '(root --help)'}`);
  }

  console.log('check-cli: PASS');
} finally {
  rmSync(TMP, { recursive: true, force: true });
}
