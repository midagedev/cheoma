// Pure R8 program-family diet contract (#220).
//
// Browser measurement of hanyang programs lives in check:lod:app / render-budget ceilings.
// This gate freezes the *cause* side: every composable stock patch that participates in the
// LOD × rim × cloud × snow product must install the shared screen-door path at source so
// plain×lod never forks an independent WebGLProgram family. No WebGL, no forest thinning.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  MATERIAL_PROGRAM_PATCH,
  addMaterialProgramKey,
  hasOnlyMaterialProgramKeys,
  materialProgramKeyTokens,
} from '../src/render/material-program-key.js';
import {
  LOD_SCREEN_DOOR_PROGRAM_VERSION,
  hasLodScreenDoorMaterial,
  patchLodScreenDoorMaterial,
} from '../src/render/lod-screen-door.js';
import {
  HANYANG_RENDER_BUDGET,
  RENDER_BUDGET_STATES,
} from './lib/render-budget-contract.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const read = (rel) => readFileSync(resolve(ROOT, rel), 'utf8');

let failed = 0;
function ok(cond, msg) {
  if (cond) console.log(`  ok  ${msg}`);
  else { console.error(`  FAIL ${msg}`); failed++; }
}

// Strip comments so historical notes cannot false-pass required call sites.
function activeSource(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

console.log('check-program-diet (R8 / #220)\n');

// ── 1. Known token vocabulary ──────────────────────────────────────────────
ok(MATERIAL_PROGRAM_PATCH.LOD_SCREEN_DOOR === 'cheoma-lod-screen-door-v1',
  'LOD screen-door token is cheoma-lod-screen-door-v1');
ok(MATERIAL_PROGRAM_PATCH.PHYSICAL_RIM === 'cheoma-rim-physical-v1',
  'physical rim token is cheoma-rim-physical-v1');
ok(MATERIAL_PROGRAM_PATCH.CLOUD_SHADOW === 'cloudshadow-v2',
  'cloud-shadow token is cloudshadow-v2');
ok(MATERIAL_PROGRAM_PATCH.SNOW === 'snow-v2',
  'snow token is snow-v2');
ok(LOD_SCREEN_DOOR_PROGRAM_VERSION === MATERIAL_PROGRAM_PATCH.LOD_SCREEN_DOOR,
  'lod-screen-door export matches MATERIAL_PROGRAM_PATCH');

// ── 2. Order-independent key composition ───────────────────────────────────
{
  const mat = { isMaterial: true, userData: {} };
  addMaterialProgramKey(mat, MATERIAL_PROGRAM_PATCH.PHYSICAL_RIM);
  addMaterialProgramKey(mat, MATERIAL_PROGRAM_PATCH.CLOUD_SHADOW);
  addMaterialProgramKey(mat, MATERIAL_PROGRAM_PATCH.LOD_SCREEN_DOOR);
  const forward = mat.customProgramCacheKey();
  const matRev = { isMaterial: true, userData: {} };
  addMaterialProgramKey(matRev, MATERIAL_PROGRAM_PATCH.LOD_SCREEN_DOOR);
  addMaterialProgramKey(matRev, MATERIAL_PROGRAM_PATCH.CLOUD_SHADOW);
  addMaterialProgramKey(matRev, MATERIAL_PROGRAM_PATCH.PHYSICAL_RIM);
  ok(forward === matRev.customProgramCacheKey(),
    `token chain is order-independent (${forward})`);
  ok(forward === 'cheoma-lod-screen-door-v1|cheoma-rim-physical-v1|cloudshadow-v2',
    'canonical sorted lod|rim|cloud key');
  ok(hasOnlyMaterialProgramKeys(mat, new Set(Object.values(MATERIAL_PROGRAM_PATCH))),
    'composed tokens stay inside the known patch vocabulary');
}

// ── 3. patchLodScreenDoorMaterial is idempotent and key-stable ─────────────
{
  const mat = {
    isMaterial: true,
    userData: {},
    needsUpdate: false,
    onBeforeCompile: null,
    onBeforeRender: null,
  };
  ok(patchLodScreenDoorMaterial(mat) === true, 'first LOD path install returns true');
  ok(patchLodScreenDoorMaterial(mat) === false, 'second LOD path install is a no-op');
  ok(hasLodScreenDoorMaterial(mat), 'hasLodScreenDoorMaterial after install');
  ok(materialProgramKeyTokens(mat).includes(LOD_SCREEN_DOOR_PROGRAM_VERSION),
    'customProgramCacheKey carries the screen-door token');
}

// ── 4. Product install sites always call patchLodScreenDoorMaterial ────────
const rimSrc = activeSource(read('src/env/rim.js'));
const cloudSrc = activeSource(read('src/builder/palette.js'));
const snowSrc = activeSource(read('src/env/snow-material.js'));
const impostorSrc = activeSource(read('src/village/instancing.js'));
const lodSrc = activeSource(read('src/render/lod-screen-door.js'));
const lodRaw = read('src/render/lod-screen-door.js');

ok(rimSrc.includes('patchLodScreenDoorMaterial(mat)'),
  'rim patchMaterial always installs LOD screen-door (#180)');
ok(rimSrc.includes('patchLodScreenDoorMaterial'),
  'rim imports/uses patchLodScreenDoorMaterial');
ok(/function injectCloudShadow[\s\S]*patchLodScreenDoorMaterial\(mat\)/.test(cloudSrc),
  'injectCloudShadow always installs LOD screen-door (#220 residual)');
ok(/function patchSnowMaterial[\s\S]*patchLodScreenDoorMaterial\(material\)/.test(snowSrc),
  'patchSnowMaterial always installs LOD screen-door (#220 residual)');
ok(/function createImpostorMaterial[\s\S]*patchLodScreenDoorMaterial\(mat\)/.test(impostorSrc),
  'FAR impostor materials install LOD screen-door at birth (#220 residual)');
// Contract text + live early-out threshold (threshold lives in screen-door.js shared helper).
const screenDoorSrc = activeSource(read('src/render/screen-door.js'));
ok(/Coverage defaults to/i.test(lodRaw) && /affine 1/.test(lodRaw)
    && screenDoorSrc.includes('0.999'),
  'LOD screen-door documents coverage-1 early-out for non-LOD draws');

// ── 5. Documented hanyang program ceilings (product target) ────────────────
// Measured post-#180 aerial ≈142 (PR body). Aerial limit 144 locks that diet;
// focus/mid/focusOut share the 192 resource plateau (overlay USE_INSTANCING fork
// is residual and owned by #129 anchors, not by plain×lod tags).
const limits = HANYANG_RENDER_BUDGET.limits;
ok(limits.aerial.programs === 144,
  `hanyang aerial program ceiling is 144 (got ${limits.aerial.programs})`);
ok(limits.focus.programs === 192,
  `hanyang focus program ceiling is 192 (got ${limits.focus.programs})`);
ok(limits.mid.programs === 192,
  `hanyang mid program ceiling is 192 (got ${limits.mid.programs})`);
ok(limits.focusOut.programs === 192,
  `hanyang focusOut program ceiling is 192 (got ${limits.focusOut.programs})`);
for (const state of RENDER_BUDGET_STATES) {
  ok(Number.isSafeInteger(limits[state].programs) && limits[state].programs > 0,
    `${state} program ceiling is a positive safe integer`);
}
const programDelta = HANYANG_RENDER_BUDGET.deltas.find(
  (d) => d.from === 'aerial' && d.to === 'focusOut' && d.metric === 'programs',
);
ok(programDelta && programDelta.max === 64,
  `aerial→focusOut program residual ceiling is 64 (got ${programDelta?.max})`);

// ── 6. No forest-thinning lever in the diet path ───────────────────────────
ok(!/thinForest|forestDensity\s*\*|MAX_TREES\s*=\s*[0-9]{1,3}\b/.test(rimSrc + cloudSrc + lodSrc),
  'R8 diet sites do not introduce forest-thinning levers');

if (failed) {
  console.error(`\nPROGRAM DIET: FAIL (${failed})`);
  process.exit(1);
}
console.log('\nPROGRAM DIET: PASS (R8 token share + install sites + hanyang ceilings)');
