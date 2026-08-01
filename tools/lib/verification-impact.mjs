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
  // Catalog metadata lives in docs/credits.md; the pure parser + gate stay in lockstep.
  ['docs/credits.md', [
    './check-credits-catalog.mjs',
  ]],
  ['app/src/lib/credits-parse.js', [
    './check-credits-catalog.mjs',
  ]],
  ['app/src/lib/credits.js', [
    './check-credits-catalog.mjs',
  ]],
  ['app/src/components/ReferenceModal.svelte', [
    './check-credits-catalog.mjs',
  ]],
  ['src/camera/optics.js', [
    './check-dof.mjs',
    './check-plan-contract.mjs',
    './check-lod.mjs',
    './check-camera-continuity.mjs',
  ]],
  // #22 전환 연속성: 두 앱 런타임은 esbuild 로 번들되어 정적 import 폐쇄에 잡히지 않으므로
  // 소유 계약을 명시한다(브라우저 게이트 라우팅은 verification-plan 의 'camera runtime changed').
  ['app/src/engine/view-shift.js', [
    './check-camera-continuity.mjs',
    './check-architecture.mjs',
  ]],
  ['app/src/engine/village-camera-runtime.js', [
    './check-camera-continuity.mjs',
    './check-architecture.mjs',
  ]],
  // #33 워킹뷰 수동 조작: 진입 기본(자동 산책 금지)·시선 델타 1회 소비는 이 런타임이 소유하고,
  // check-walk-control 이 스텁 카메라로 그 배선을 직접 돌려 본다. esbuild 번들이라 정적 폐쇄에
  // 잡히지 않으므로 소유를 명시한다.
  ['app/src/engine/cinematic-runtime.js', [
    './check-architecture.mjs',
    './check-walk-control.mjs',
  ]],
  // #20 R4: 성곽 렌더러와 지형 정점색은 어떤 fast check 도 import 하지 않으므로(three 의존)
  // 정적 폐쇄로는 잡히지 않는다. 개천 계약이 두 파일의 소비 문자열(수문 spec 소비·건천 하상 항)을
  // 검사하므로 소유를 명시한다.
  ['src/village/citywall.js', [
    './check-architecture.mjs',
    './check-citywall.mjs',
    './check-creek.mjs',
  ]],
  ['src/generators/village/terrain.js', [
    './check-architecture.mjs',
    './check-creek.mjs',
  ]],
  ['src/env/weather-physical-geometry.js', [
    './check-weather-geometry.mjs',
  ]],
  // #219 / U4: pure ground-carpet plan is not imported by browser harnesses that
  // pull three; keep the placement/budget contract in the FAST impact set.
  // seasons.js / focus.js stay on the normal import-closure router (they pull three
  // and already select petals/lod browser gates via routePath).
  ['src/env/season-ground-plan.js', [
    './check-season-ground-contract.mjs',
  ]],
  ['src/env/season-ground-carpet.js', [
    './check-season-ground-contract.mjs',
  ]],
  ['src/core/buffer-update-range.js', [
    './check-instance-upload.mjs',
    './check-wave-contract.mjs',
  ]],
  ['src/village/instancing.js', [
    './check-instance-upload.mjs',
    './check-instance-merge-immutability.mjs',
    // R8 (#220): FAR impostor birth always installs LOD screen-door (source-inspected;
    // check-program-diet only readFileSyncs this module, so it is not in its import closure).
    './check-program-diet.mjs',
  ]],
  ['src/village/wave.js', [
    './check-instance-upload.mjs',
    './check-wave-contract.mjs',
  ]],
  // #150 F: pad geometry consumes the pure pad-landing plan; keep the coherence
  // gate in the FAST impact set even though the renderer module itself is not
  // imported by any pure check (it pulls three).
  ['src/generators/village/pads.js', [
    './check-pad-landing.mjs',
  ]],
  ['src/village/nightlight-physical-geometry.js', [
    './check-nightlight-geometry.mjs',
    './check-instance-upload.mjs',
  ]],
  ['src/village/nightlights.js', [
    './check-nightlight-geometry.mjs',
    './check-instance-upload.mjs',
  ]],
  // 소동물 렌더러는 순수 계획(critter-plan/critter-station-plan)과 함께 하나의 계약이 소유한다.
  ['src/env/critters.js', [
    './check-critter-contract.mjs',
  ]],
  ['src/runtime/village/fauna.js', [
    './check-critter-contract.mjs',
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
export const API_REUSE_DEPENDENCIES = Object.freeze(
  [...dependencyClosure(join(ROOT, 'examples', 'api-building', 'main.js'))]
    .map((path) => relative(ROOT, path).split(sep).join('/')),
);
const API_REUSE_CLOSURE = new Set(API_REUSE_DEPENDENCIES);

/** Keep the standalone browser gate aligned with the example's real ESM graph. */
export function isApiReuseDependency(path) {
  return API_REUSE_CLOSURE.has(path);
}

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
