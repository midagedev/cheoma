// Packaging P2b (2026-08-08): skill reference docs may only document real
// src/api named exports. Machine-readable blocks:
//
//   ```api-symbols
//   src/api/environment.js#setupEnvironment
//   ```
//
// Each line is dynamic-imported under plain Node (root three@0.185.1). Missing
// exports fail the gate. Module load failures fail the gate — do not document
// surfaces that cannot load.
//
// Run: node tools/check-skill-refs.mjs
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REFS_DIR = join(
  ROOT,
  'plugin/cheoma-worldgen/skills/cheoma-worldgen/references',
);

// Files that must carry at least one api-symbols block (P2b runtime surfaces +
// map-data pure export). Other references (limitations, plan-schema, quickstart)
// stay free-form.
const REQUIRED_BLOCK_FILES = new Set([
  'environment-and-look.md',
  'scene-integration.md',
  'map-data.md',
]);

const BLOCK_RE = /```api-symbols\s*\n([\s\S]*?)```/g;
const LINE_RE = /^(src\/api\/[A-Za-z0-9._/-]+\.js)#([A-Za-z_$][\w$]*)$/;

function collectMarkdownFiles() {
  return readdirSync(REFS_DIR)
    .filter((name) => name.endsWith('.md'))
    .sort();
}

function parseBlocks(source, fileLabel) {
  const entries = [];
  let match;
  BLOCK_RE.lastIndex = 0;
  while ((match = BLOCK_RE.exec(source)) !== null) {
    const body = match[1];
    const lines = body.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i].trim();
      if (!raw || raw.startsWith('#')) continue;
      const m = LINE_RE.exec(raw);
      if (!m) {
        throw new Error(
          `${fileLabel}: invalid api-symbols line ${JSON.stringify(raw)} `
          + `(expected src/api/<file>.js#exportName)`,
        );
      }
      entries.push({ module: m[1], symbol: m[2], line: raw });
    }
  }
  return entries;
}

const moduleCache = new Map();

async function loadModule(modulePath) {
  if (moduleCache.has(modulePath)) return moduleCache.get(modulePath);
  const abs = resolve(ROOT, modulePath);
  const href = pathToFileURL(abs).href;
  let record;
  try {
    const mod = await import(href);
    record = { ok: true, mod, error: null };
  } catch (error) {
    record = {
      ok: false,
      mod: null,
      error: error && error.message ? error.message.split('\n')[0] : String(error),
    };
  }
  moduleCache.set(modulePath, record);
  return record;
}

const files = collectMarkdownFiles();
assert.ok(files.length > 0, `no markdown under ${REFS_DIR}`);

let blockFiles = 0;
let symbolCount = 0;
const failures = [];

for (const name of files) {
  const abs = join(REFS_DIR, name);
  const source = readFileSync(abs, 'utf8');
  const label = `plugin/.../references/${name}`;
  const entries = parseBlocks(source, label);

  if (REQUIRED_BLOCK_FILES.has(name)) {
    if (entries.length === 0) {
      failures.push(`${label}: required api-symbols block missing or empty`);
      continue;
    }
    blockFiles += 1;
  } else if (entries.length === 0) {
    continue;
  } else {
    blockFiles += 1;
  }

  // De-dupe within a file so repeated listings do not re-import.
  const seen = new Set();
  for (const { module, symbol, line } of entries) {
    const key = `${module}#${symbol}`;
    if (seen.has(key)) continue;
    seen.add(key);
    symbolCount += 1;

    const loaded = await loadModule(module);
    if (!loaded.ok) {
      failures.push(
        `${label}: MODULE LOAD FAIL ${module} — ${loaded.error} (documented as ${line})`,
      );
      continue;
    }
    if (!(symbol in loaded.mod)) {
      failures.push(
        `${label}: missing export ${module}#${symbol}`,
      );
      continue;
    }
  }
}

for (const required of REQUIRED_BLOCK_FILES) {
  if (!files.includes(required)) {
    failures.push(`required reference file missing: ${required}`);
  }
}

if (failures.length) {
  console.error(`SKILL-REFS: FAIL (${failures.length})`);
  for (const line of failures) console.error(`  - ${line}`);
  process.exit(1);
}

console.log(
  `SKILL-REFS: PASS (${blockFiles} file(s) with api-symbols, ${symbolCount} unique symbol checks)`,
);
