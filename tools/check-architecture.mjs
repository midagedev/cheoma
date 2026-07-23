// 빠른 정적 구조 게이트: 경계, 상대 import 해석, src 순환, public API 방향, 순수 plan closure.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');
const APP = join(ROOT, 'app', 'src');
const API_BUILDING_EXAMPLE = join(ROOT, 'examples', 'api-building');
const API_BUILDING_EXAMPLE_HTML = join(API_BUILDING_EXAMPLE, 'index.html');
const API_BUILDING = join(SRC, 'api', 'building.js');
const API_PLAN = join(SRC, 'api', 'village-plan.js');
const API_PARTICLE_STATE = join(SRC, 'api', 'particle-state.js');
const API_RENDER_STYLE = join(SRC, 'api', 'render-style.js');
const API_RESIDENTIAL_OPENINGS = join(SRC, 'api', 'residential-openings.js');
const APP_COMPONENT = join(APP, 'App.svelte');
const APP_MAIN = join(APP, 'main.js');
const BOTTOM_SHEET = join(APP, 'components', 'BottomSheet.svelte');
const LEGACY_VILLAGE_PANEL = join(APP, 'components', 'VillagePanel.svelte');
const VIEW_SHIFT = join(APP, 'engine', 'view-shift.js');
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

const files = [...walk(SRC), ...walk(APP), ...walk(API_BUILDING_EXAMPLE)];
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
      if (file.startsWith(API_BUILDING_EXAMPLE + sep)
        && specifier !== 'three'
        && !specifier.startsWith('three/addons/')) {
        errors.push(`building example imports unsupported package: ${relative(ROOT, file)} -> ${specifier}`);
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
    if (file.startsWith(API_BUILDING_EXAMPLE + sep)
      && !target.startsWith(API_BUILDING_EXAMPLE + sep)
      && target !== API_BUILDING) {
      errors.push(`building example bypasses its public API: ${relative(ROOT, file)} -> ${relative(ROOT, target)}`);
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

// Copyable browser import maps must resolve the core and every transitive addon
// through one exact three release. Runtime instanceof checks cover identity; this
// static check keeps the example itself honest before a browser is started.
const exampleHtml = readFileSync(API_BUILDING_EXAMPLE_HTML, 'utf8');
const importMapSource = exampleHtml.match(
  /<script\s+type=["']importmap["']\s*>([\s\S]*?)<\/script>/i,
)?.[1];
if (!importMapSource) {
  errors.push('building example has no import map');
} else {
  try {
    const importMap = JSON.parse(importMapSource);
    const imports = importMap.imports || {};
    const expected = {
      three: 'https://cdn.jsdelivr.net/npm/three@0.185.1/build/three.module.js',
      'three/addons/': 'https://cdn.jsdelivr.net/npm/three@0.185.1/examples/jsm/',
    };
    for (const [specifier, url] of Object.entries(expected)) {
      if (imports[specifier] !== url) {
        errors.push(`building example import map must pin ${specifier} to ${url}`);
      }
    }
    const unsupported = Object.keys(imports).filter((specifier) => !Object.hasOwn(expected, specifier));
    if (unsupported.length) {
      errors.push(`building example import map has unsupported entries: ${unsupported.join(', ')}`);
    }
    const unsupportedSections = Object.keys(importMap)
      .filter((section) => section !== 'imports');
    if (unsupportedSections.length) {
      errors.push(`building example import map has unsupported sections: ${unsupportedSections.join(', ')}`);
    }
  } catch (error) {
    errors.push(`building example import map is invalid JSON: ${error.message}`);
  }
}

const moduleScripts = [...exampleHtml.matchAll(/<script\b([^>]*)>/gi)]
  .map((match) => match[1])
  .filter((attributes) => /\btype\s*=\s*["']module["']/i.test(attributes))
  .map((attributes) => attributes.match(/\bsrc\s*=\s*["']([^"']+)["']/i)?.[1] || null);
if (moduleScripts.length !== 1 || moduleScripts[0] !== './main.js') {
  errors.push(`building example must load only ./main.js as a module: ${moduleScripts.join(', ')}`);
}

// App teardown is one explicit ownership boundary.  Scheduling primitives may
// occur only inside the lifecycle wrapper block at the top of App.svelte; every
// feature below it must use that cancellable epoch instead of escaping unmount.
const appSource = readFileSync(APP_COMPONENT, 'utf8');
const schedulerEnd = appSource.indexOf('  let ui = $state(');
const appFeatureSource = schedulerEnd >= 0 ? appSource.slice(schedulerEnd) : appSource;
const executableAppFeatures = appFeatureSource
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/.*$/gm, '')
  .replace(/(['"])(?:\\.|(?!\1)[^\\\r\n])*\1/g, '');
for (const primitive of ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame']) {
  if (new RegExp(`\\b${primitive}\\s*\\(`).test(executableAppFeatures)) {
    errors.push(`App feature bypasses lifecycle scheduler: ${primitive}`);
  }
}
const mainSource = readFileSync(APP_MAIN, 'utf8');
if (!/export\s+function\s+disposeApp\s*\(/.test(mainSource)
  || !/\bunmount\s*\(\s*app\s*\)/.test(mainSource)
  || !/if\s*\(\s*!disposePromise\s*\)/.test(mainSource)) {
  errors.push('main.js must expose one idempotent Svelte disposeApp boundary');
}

// ContextPanel replaced the old split village card.  Keep the deleted module,
// its BottomSheet variant/CSS, and its view-shift selector out of the app graph.
if (existsSync(LEGACY_VILLAGE_PANEL)) errors.push('legacy VillagePanel.svelte must stay deleted');
for (const file of [BOTTOM_SHEET, VIEW_SHIFT]) {
  const source = readFileSync(file, 'utf8');
  if (/leftCard|\.vcard\b/.test(source)) {
    errors.push(`legacy village-card branch remains: ${relative(ROOT, file)}`);
  }
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

function dependencyClosure(entry) {
  const closure = new Set();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop();
    if (closure.has(file)) continue;
    closure.add(file);
    for (const dep of graph.get(file) || []) if (dep.startsWith(SRC + sep)) queue.push(dep);
  }
  return closure;
}

const browserGlobal = /\b(?:window|document|location|navigator|Worker|requestAnimationFrame|AudioContext)\b/;

function checkPureClosure(closure, label) {
  for (const file of closure) {
    const rel = relative(ROOT, file);
    for (const specifier of externals.get(file) || []) {
      if (specifier === 'three' || specifier.startsWith('three/')) {
        errors.push(`${label} closure imports THREE: ${rel} -> ${specifier}`);
      }
    }
    // 주석·문자열 속 단어로 오탐하지 않도록 실행 토큰만 확인한다.
    const code = sourceByFile.get(file)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
      .replace(/(['"])(?:\\.|(?!\1)[^\\\r\n])*\1/g, '');
    if (browserGlobal.test(code)) errors.push(`${label} closure uses browser global: ${rel}`);
  }
}

// 순수 planner의 전체 dependency closure에는 THREE·DOM·browser scheduling이 없어야 한다.
const planClosure = dependencyClosure(API_PLAN);
checkPureClosure(planClosure, 'pure plan');

// Worker/external particle simulation must not instantiate a WebGL dependency.
const particleStateClosure = dependencyClosure(API_PARTICLE_STATE);
checkPureClosure(particleStateClosure, 'particle-state');

// #10 주거 개구 계획은 renderer/UI가 함께 쓰는 JSON-safe 재사용 경계다.
const residentialOpeningClosure = dependencyClosure(API_RESIDENTIAL_OPENINGS);
checkPureClosure(residentialOpeningClosure, 'residential-opening');

// URL/state consumers must not pull the WebGL ink renderer (and therefore THREE/DOM) at app boot.
const renderStyleClosure = dependencyClosure(API_RENDER_STYLE);
checkPureClosure(renderStyleClosure, 'render-style');

const hotspots = [...walk(SRC), ...walk(APP)]
  .map((file) => ({ file: relative(ROOT, file), lines: sourceByFile.get(file).split('\n').length }))
  .filter((item) => item.lines >= 750)
  .sort((a, b) => b.lines - a.lines);

if (errors.length) {
  console.error('ARCHITECTURE: FAIL');
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

console.log(`ARCHITECTURE: PASS (${walk(SRC).length} src modules, ${planClosure.size} pure-plan modules, ${particleStateClosure.size} particle-state modules, ${residentialOpeningClosure.size} residential-opening modules, ${renderStyleClosure.size} pure render-style modules, 0 cycles)`);
if (hotspots.length) {
  console.log('Refactor hotspots (warning only):');
  for (const item of hotspots) console.log(`  ${String(item.lines).padStart(4)}  ${item.file}`);
}
