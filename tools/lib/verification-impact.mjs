import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FAST_CHECKS, FAST_CHECK_PATHS } from './fast-checks.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TOOLS = join(ROOT, 'tools');
const SOURCE_EXTENSIONS = ['', '.js', '.mjs', '.json', '.svelte'];
const IMPORT_RE = /(?:import|export)\s+(?:[^'";]*?\s+from\s*)?['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const DOC_PATH = /^(?:docs\/|README\.md$|AGENTS\.md$|CLAUDE\.md$|SANSA-HANDOFF\.md$|LICENSE(?:\.|$))/;

const FIXTURE_OWNERS = new Map([
  ['tools/plan-contract.json', 'tools/check-plan-contract.mjs'],
]);

// High-fanout policy modules sit inside the whole village-plan closure. Their
// reviewed contract gates are narrower than every incidental plan consumer.
const EXACT_IMPACT = new Map([
  ['.gitignore', [
    './check-verification-plan.mjs',
    './check-worktree-contract.mjs',
  ]],
  ['src/camera/optics.js', [
    './check-dof.mjs',
    './check-plan-contract.mjs',
    './check-lod.mjs',
  ]],
]);

function resolveImport(from, specifier) {
  if (!specifier?.startsWith('.')) return null;
  const raw = resolve(dirname(from), specifier.split('?')[0].split('#')[0]);
  for (const suffix of SOURCE_EXTENSIONS) {
    const candidate = suffix ? `${raw}${suffix}` : raw;
    if (existsSync(candidate)) return candidate;
  }
  for (const name of ['index.js', 'index.mjs']) {
    const candidate = join(raw, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function staticImports(path) {
  if (!['.js', '.mjs', '.svelte'].includes(extname(path))) return [];
  const source = readFileSync(path, 'utf8');
  const imports = [];
  for (const match of source.matchAll(IMPORT_RE)) {
    const target = resolveImport(path, match[1] || match[2]);
    if (target) imports.push(target);
  }
  return imports;
}

function dependencyClosure(entry) {
  const closure = new Set();
  const pending = [entry];
  while (pending.length) {
    const path = pending.pop();
    if (closure.has(path)) continue;
    closure.add(path);
    for (const dependency of staticImports(path)) pending.push(dependency);
  }
  return closure;
}

const CHECK_CLOSURES = new Map(FAST_CHECKS.map((check) => {
  const entry = resolve(TOOLS, check);
  return [check, new Set([...dependencyClosure(entry)].map((path) => relative(ROOT, path).split(sep).join('/')))];
}));

/** Select only browser-free contracts whose static dependency closure intersects the patch. */
export function impactedFastChecks(paths) {
  const changed = new Set(paths);
  const selected = new Set();
  const hasCode = paths.some((path) => !DOC_PATH.test(path));
  if (hasCode) selected.add('./check-architecture.mjs');

  for (const path of paths) {
    for (const check of EXACT_IMPACT.get(path) || []) selected.add(check);
    const fixtureOwner = FIXTURE_OWNERS.get(path);
    if (fixtureOwner) selected.add(`./${fixtureOwner.slice('tools/'.length)}`);
    const directIndex = FAST_CHECK_PATHS.indexOf(path);
    if (directIndex >= 0) selected.add(FAST_CHECKS[directIndex]);
  }

  for (const check of FAST_CHECKS) {
    const closure = CHECK_CLOSURES.get(check);
    if (paths.some((path) => !EXACT_IMPACT.has(path) && closure.has(path))) selected.add(check);
  }

  return FAST_CHECKS.filter((check) => selected.has(check));
}

export function isDocumentationPath(path) {
  return DOC_PATH.test(path);
}
