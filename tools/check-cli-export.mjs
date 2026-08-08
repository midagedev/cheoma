// Packaging P3b: cheoma map-data + glb CLI smoke (determinism, GLB magic, bad preset).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'bin/cheoma.mjs');
const TMP = mkdtempSync(join(tmpdir(), 'cheoma-cli-export-'));

function run(args, { expectStatus = 0 } = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
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

function assertGlbBuffer(buf, label) {
  assert.ok(buf.byteLength >= 12, `${label}: GLB shorter than header`);
  const magic = buf.subarray(0, 4).toString('ascii');
  assert.equal(magic, 'glTF', `${label}: magic is ${JSON.stringify(magic)}`);
  const declared = buf.readUInt32LE(8);
  assert.equal(declared, buf.byteLength, `${label}: declared length ${declared} != ${buf.byteLength}`);
}

try {
  // ── 1) map-data: plan → three JSON files, parseable, byte-identical twice ──
  const planPath = join(TMP, 'village-plan.json');
  {
    run(['plan', '--seed', '7', '--scale', 'village', '--out', planPath]);
    assert.ok(existsSync(planPath), 'plan file missing');
  }

  const mapDirA = join(TMP, 'map-a');
  const mapDirB = join(TMP, 'map-b');
  {
    const r = run(['map-data', planPath, '--out-dir', mapDirA]);
    assert.ok(r.stderr.includes('solids='), `map-data stderr summary: ${r.stderr}`);
    assert.ok(r.stderr.includes('buildings='), `map-data stderr buildings: ${r.stderr}`);
    assert.ok(r.stderr.includes('terrain='), `map-data stderr terrain: ${r.stderr}`);
    // File-output mode: stdout should stay quiet (no JSON dump).
    assert.equal(r.stdout.trim(), '', `map-data stdout not quiet: ${JSON.stringify(r.stdout)}`);

    for (const name of ['colliders.json', 'metadata.json', 'terrain.json']) {
      const p = join(mapDirA, name);
      assert.ok(existsSync(p), `missing ${name}`);
      const text = readFileSync(p, 'utf8');
      const parsed = JSON.parse(text);
      assert.equal(typeof parsed, 'object');
      assert.ok(parsed && parsed.schemaVersion === 1, `${name} schemaVersion`);
    }

    const colliders = JSON.parse(readFileSync(join(mapDirA, 'colliders.json'), 'utf8'));
    const metadata = JSON.parse(readFileSync(join(mapDirA, 'metadata.json'), 'utf8'));
    const terrain = JSON.parse(readFileSync(join(mapDirA, 'terrain.json'), 'utf8'));
    assert.ok(Array.isArray(colliders.solids) && colliders.solids.length > 0, 'solids empty');
    assert.ok(Array.isArray(metadata.buildings) && metadata.buildings.length > 0, 'buildings empty');
    assert.ok(terrain.nx > 1 && terrain.nz > 1, 'terrain grid too small');
    assert.equal(terrain.nx * terrain.nz, terrain.heights.length, 'terrain heights length');

    run(['map-data', planPath, '--out-dir', mapDirB]);
    for (const name of ['colliders.json', 'metadata.json', 'terrain.json']) {
      const a = readFileSync(join(mapDirA, name));
      const b = readFileSync(join(mapDirB, name));
      assert.ok(a.equals(b), `map-data ${name} not byte-identical across two runs`);
    }
    console.log('PASS map-data: 3 files parseable and byte-identical across two runs');
  }

  // ── 2) glb: two runs identical + magic/length ──
  const glbA = join(TMP, 'a.glb');
  const glbB = join(TMP, 'b.glb');
  {
    const r = run(['glb', '--preset', 'giwa', '--seed', '7', '--out', glbA]);
    assert.ok(existsSync(glbA), 'glb A missing');
    assert.ok(statSync(glbA).size > 12, 'glb A too small');
    assert.ok(r.stderr.includes('triangles='), `glb stderr: ${r.stderr}`);

    run(['glb', '--preset', 'giwa', '--seed', '7', '--out', glbB]);
    const a = readFileSync(glbA);
    const b = readFileSync(glbB);
    assert.ok(a.equals(b), 'two glb runs must produce identical bytes');
    assertGlbBuffer(a, 'glb A');
    assertGlbBuffer(b, 'glb B');
    console.log(`PASS glb: byte-identical giwa seed=7 (${a.byteLength} bytes, magic glTF)`);
  }

  // ── 3) unknown preset → exit 1 + available list ──
  {
    const r = run(['glb', '--preset', 'nonexist', '--out', join(TMP, 'x.glb')], {
      expectStatus: 1,
    });
    const err = `${r.stderr}\n${r.stdout}`;
    assert.match(err, /unknown --preset/i);
    assert.match(err, /available:/i);
    assert.match(err, /giwa/);
    console.log('PASS glb: unknown preset exits 1 with available list');
  }

  // Help surfaces for the new commands
  for (const args of [['map-data', '--help'], ['glb', '--help']]) {
    const r = run(args, { expectStatus: 0 });
    assert.ok(r.stdout.includes('Usage:'), `help missing Usage for ${args.join(' ')}`);
    if (args[0] === 'glb') {
      assert.match(r.stdout, /textures are omitted in the node path/i);
    }
    console.log(`PASS help: ${args.join(' ')}`);
  }

  console.log('check-cli-export: PASS');
} finally {
  rmSync(TMP, { recursive: true, force: true });
}
