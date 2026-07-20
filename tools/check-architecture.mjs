// 빠른 정적 구조 게이트: 경계, 상대 import 해석, src 순환, public API 방향, 순수 plan closure.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');
const APP = join(ROOT, 'app', 'src');
const API_PLAN = join(SRC, 'api', 'village-plan.js');
const SOURCE_EXT = new Set(['.js', '.mjs', '.svelte']);

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else if (SOURCE_EXT.has(extname(entry.name))) out.push(path);
  }
  return out;
}

function specifiers(source) {
  const found = [];
  const staticRe = /(?:import|export)\s+(?:[^'";]*?\s+from\s*)?['"]([^'"]+)['"]/g;
  const dynamicRe = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const re of [staticRe, dynamicRe]) {
    for (const match of source.matchAll(re)) found.push(match[1]);
  }
  return [...new Set(found)];
}

function resolveRelative(from, specifier) {
  const raw = resolve(dirname(from), specifier.split('?')[0].split('#')[0]);
  const candidates = [raw, `${raw}.js`, `${raw}.mjs`, `${raw}.svelte`, join(raw, 'index.js')];
  return candidates.find((path) => {
    try { return statSync(path).isFile(); } catch { return false; }
  }) || null;
}

const files = [...walk(SRC), ...walk(APP)];
const sourceByFile = new Map(files.map((file) => [file, readFileSync(file, 'utf8')]));
const graph = new Map();
const externals = new Map();
const errors = [];

for (const file of files) {
  const deps = [];
  const bare = [];
  for (const specifier of specifiers(sourceByFile.get(file))) {
    if (!specifier.startsWith('.')) {
      bare.push(specifier);
      if (file.startsWith(SRC + sep) && (specifier === 'svelte' || specifier.startsWith('svelte/'))) {
        errors.push(`src must not import Svelte: ${relative(ROOT, file)} -> ${specifier}`);
      }
      continue;
    }
    const target = resolveRelative(file, specifier);
    if (!target) {
      errors.push(`unresolved relative import: ${relative(ROOT, file)} -> ${specifier}`);
      continue;
    }
    deps.push(target);
    if (file.startsWith(SRC + sep) && !target.startsWith(SRC + sep)) {
      errors.push(`src import escapes core boundary: ${relative(ROOT, file)} -> ${relative(ROOT, target)}`);
    }
    if (file.startsWith(SRC + sep) && !file.startsWith(join(SRC, 'api') + sep)
      && target.startsWith(join(SRC, 'api') + sep)) {
      errors.push(`internal module imports public facade: ${relative(ROOT, file)} -> ${relative(ROOT, target)}`);
    }
    if (file.startsWith(APP + sep) && target.startsWith(SRC + sep)
      && !target.startsWith(join(SRC, 'api') + sep)) {
      errors.push(`app bypasses public facade: ${relative(ROOT, file)} -> ${relative(ROOT, target)}`);
    }
    if (file.startsWith(join(SRC, 'core') + sep)
      && !target.startsWith(join(SRC, 'core') + sep)
      && target !== join(SRC, 'rng.js')
      && target !== join(SRC, 'params.js')) {
      errors.push(`core imports higher-level module: ${relative(ROOT, file)} -> ${relative(ROOT, target)}`);
    }
    if (file.startsWith(join(SRC, 'generators') + sep)
      && target.startsWith(join(SRC, 'runtime') + sep)) {
      errors.push(`generator imports runtime: ${relative(ROOT, file)} -> ${relative(ROOT, target)}`);
    }
    if (file.startsWith(join(SRC, 'village') + sep)
      && target.startsWith(join(SRC, 'runtime') + sep)
      && file !== join(SRC, 'village', 'adapter.js')) {
      errors.push(`legacy village module imports runtime outside adapter shim: ${relative(ROOT, file)} -> ${relative(ROOT, target)}`);
    }
  }
  graph.set(file, [...new Set(deps)]);
  externals.set(file, bare);
}

// Tarjan SCC: src 내부 순환은 병렬 변경과 재사용 경계를 흐리므로 즉시 실패시킨다.
let nextIndex = 0;
const index = new Map();
const low = new Map();
const stack = [];
const onStack = new Set();
const cycles = [];

function visit(node) {
  index.set(node, nextIndex);
  low.set(node, nextIndex++);
  stack.push(node);
  onStack.add(node);
  for (const dep of graph.get(node) || []) {
    if (!dep.startsWith(SRC + sep)) continue;
    if (!index.has(dep)) {
      visit(dep);
      low.set(node, Math.min(low.get(node), low.get(dep)));
    } else if (onStack.has(dep)) {
      low.set(node, Math.min(low.get(node), index.get(dep)));
    }
  }
  if (low.get(node) !== index.get(node)) return;
  const component = [];
  let item;
  do {
    item = stack.pop();
    onStack.delete(item);
    component.push(item);
  } while (item !== node);
  if (component.length > 1) cycles.push(component);
}

for (const file of walk(SRC)) if (!index.has(file)) visit(file);
for (const cycle of cycles) {
  errors.push(`src import cycle: ${cycle.map((file) => relative(SRC, file)).join(' -> ')}`);
}

// 순수 planner의 전체 dependency closure에는 THREE·DOM·browser scheduling이 없어야 한다.
const planClosure = new Set();
const queue = [API_PLAN];
while (queue.length) {
  const file = queue.pop();
  if (planClosure.has(file)) continue;
  planClosure.add(file);
  for (const dep of graph.get(file) || []) if (dep.startsWith(SRC + sep)) queue.push(dep);
}
const browserGlobal = /\b(?:window|document|location|navigator|Worker|requestAnimationFrame|AudioContext)\b/;
for (const file of planClosure) {
  const rel = relative(ROOT, file);
  for (const specifier of externals.get(file) || []) {
    if (specifier === 'three' || specifier.startsWith('three/')) {
      errors.push(`pure plan closure imports THREE: ${rel} -> ${specifier}`);
    }
  }
  // 주석 속 단어로 오탐하지 않도록 실행 코드에서 흔히 쓰는 토큰 형태만 확인한다.
  const code = sourceByFile.get(file)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  if (browserGlobal.test(code)) errors.push(`pure plan closure uses browser global: ${rel}`);
}

const hotspots = [...walk(SRC), ...walk(APP)]
  .map((file) => ({ file: relative(ROOT, file), lines: sourceByFile.get(file).split('\n').length }))
  .filter((item) => item.lines >= 750)
  .sort((a, b) => b.lines - a.lines);

if (errors.length) {
  console.error('ARCHITECTURE: FAIL');
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

console.log(`ARCHITECTURE: PASS (${walk(SRC).length} src modules, ${planClosure.size} pure-plan modules, 0 cycles)`);
if (hotspots.length) {
  console.log('Refactor hotspots (warning only):');
  for (const item of hotspots) console.log(`  ${String(item.lines).padStart(4)}  ${item.file}`);
}
