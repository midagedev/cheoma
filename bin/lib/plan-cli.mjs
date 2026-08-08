// Shared helpers for the cheoma plan CLI. Node-only; imports village-plan façade.
import { readFileSync, writeFileSync } from 'node:fs';
import {
  planVillage,
  SCALE_ANCHORS,
  validateDangsanPlan,
  validateMjaHousePlan,
  validateRoadsideDrainagePlan,
} from '../../src/api/village-plan.js';

export const SCALE_NAMES = SCALE_ANCHORS.map((a) => a.name);

/** Stable plan JSON: insertion-order stringify (plan determinism includes key order). */
export function stringifyPlan(plan, { pretty = false } = {}) {
  return pretty ? `${JSON.stringify(plan, null, 2)}\n` : JSON.stringify(plan);
}

/**
 * Rebuild generative inputs from a stored plan so planVillage(opts) round-trips.
 *
 * Stored `opts` always includes derived fields (char01, character, scale, scale01,
 * target). Re-feeding `char01` as an input would flip `charOverride` true and change
 * the emitted opts even when the map is identical — so char01 is only passed when
 * the stored plan recorded an override.
 *
 * Source: src/village/plan.js planVillage — charOverride = typeof opts.char01 === 'number'
 */
export function inputOptsFromPlan(plan) {
  if (!plan || typeof plan !== 'object') {
    throw new TypeError('plan must be an object');
  }
  const o = plan.opts && typeof plan.opts === 'object' ? plan.opts : {};
  const seed = plan.seed ?? o.seed;
  if (typeof seed !== 'number' && typeof seed !== 'string') {
    throw new TypeError('plan.seed / plan.opts.seed is required');
  }
  const input = { seed };
  if (typeof o.siteR === 'number' && Number.isFinite(o.siteR)) {
    input.siteR = o.siteR;
  } else if (o.scale != null) {
    input.scale = o.scale;
  } else if (typeof plan.site?.siteR === 'number') {
    input.siteR = plan.site.siteR;
  } else {
    throw new TypeError('plan has no siteR or scale to regenerate from');
  }

  for (const key of [
    'includePalace',
    'includeTemple',
    'tuning',
    'bowlK',
    'mjaHouse',
    'dangsan',
    'houses',
  ]) {
    if (o[key] !== undefined) input[key] = o[key];
  }
  if (o.charOverride === true && typeof o.char01 === 'number' && Number.isFinite(o.char01)) {
    input.char01 = o.char01;
  }
  return input;
}

export function loadPlanJson(path) {
  const text = readFileSync(path, 'utf8');
  let plan;
  try {
    plan = JSON.parse(text);
  } catch (err) {
    throw new Error(`invalid JSON in ${path}: ${err.message}`);
  }
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    throw new Error(`${path}: plan root must be a JSON object`);
  }
  return { plan, text };
}

export function writePlanJson(path, text) {
  writeFileSync(path, text, 'utf8');
}

export function generatePlan(cliOpts) {
  return planVillage(cliOpts);
}

/**
 * Domain validators available from src/api/village-plan.js and applicable to
 * a village planVillage() product.
 *
 * Wired (see comments for signature + plan path):
 * - validateDangsanPlan(plan) — expects dangsan plan object → plan.dangsan
 * - validateRoadsideDrainagePlan(plan) — expects drainage plan object → plan.drainage
 * - validateMjaHousePlan(plan) — expects mja house plan → parcels[].mjaHouse when present
 *
 * Not wired (reasons):
 * - validateGateQuarterPlan — not re-exported from village-plan.js (only
 *   src/api/gate-quarter-plan.js / index.js); CLI may import village-plan only.
 * - validateMudWallSurfacePlan — per-wall surface detail contract; not a field
 *   of planVillage() JSON.
 * - validateYardLifeRecords(records, heightAt) — seasonal yard-life records are
 *   produced at populate time, not stored on the village plan; also requires a
 *   live heightAt function that JSON cannot carry.
 */
export function runDomainValidations(plan) {
  const results = [];

  // validateDangsanPlan(plan): dangsan-plan.js — schema/sites/reason object.
  results.push(runOne('validateDangsanPlan(plan.dangsan)', () => {
    if (!plan.dangsan || typeof plan.dangsan !== 'object') {
      throw new TypeError('plan.dangsan missing');
    }
    validateDangsanPlan(plan.dangsan);
  }));

  // validateRoadsideDrainagePlan(plan): drainage-plan.js — schema/frame/runs/crossings.
  results.push(runOne('validateRoadsideDrainagePlan(plan.drainage)', () => {
    if (!plan.drainage || typeof plan.drainage !== 'object') {
      throw new TypeError('plan.drainage missing');
    }
    validateRoadsideDrainagePlan(plan.drainage);
  }));

  // validateMjaHousePlan(plan): mja-house-plan-contract.js — opt-in ㅁ plan on parcel.
  const mjaParcels = Array.isArray(plan.parcels)
    ? plan.parcels.filter((p) => p && p.mjaHouse && typeof p.mjaHouse === 'object')
    : [];
  if (mjaParcels.length) {
    for (const parcel of mjaParcels) {
      const id = parcel.id ?? '?';
      results.push(runOne(`validateMjaHousePlan(parcels[${id}].mjaHouse)`, () => {
        validateMjaHousePlan(parcel.mjaHouse);
      }));
    }
  }

  return results;
}

function runOne(name, fn) {
  try {
    fn();
    return { name, ok: true };
  } catch (err) {
    return { name, ok: false, error: err?.message || String(err) };
  }
}

export function runDeterminismValidation(plan) {
  const name = 'determinism (planVillage(opts) re-emit byte match)';
  try {
    const input = inputOptsFromPlan(plan);
    const again = planVillage(input);
    const expected = stringifyPlan(plan);
    const actual = stringifyPlan(again);
    if (expected !== actual) {
      return {
        name,
        ok: false,
        error: `byte mismatch (stored ${expected.length} B vs regen ${actual.length} B)`,
      };
    }
    return { name, ok: true };
  } catch (err) {
    return { name, ok: false, error: err?.message || String(err) };
  }
}

export function summarizePlan(plan, jsonText) {
  const parcels = Array.isArray(plan.parcels) ? plan.parcels : [];
  const byKind = {};
  for (const p of parcels) {
    const k = p?.kind || 'unknown';
    byKind[k] = (byKind[k] || 0) + 1;
  }
  const features = plan.features && typeof plan.features === 'object' ? plan.features : {};
  const featureKeys = Object.keys(features).filter((k) => {
    const v = features[k];
    if (v == null) return false;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === 'object') return Object.keys(v).length > 0;
    return !!v;
  });
  const warnings = Array.isArray(plan.warnings) ? plan.warnings : [];
  const bytes = Buffer.byteLength(jsonText ?? stringifyPlan(plan), 'utf8');
  return {
    seed: plan.seed,
    opts: plan.opts || null,
    scale: plan.scale,
    siteR: plan.opts?.siteR ?? plan.site?.siteR,
    parcelCount: parcels.length,
    parcelsByKind: byKind,
    roadCount: Array.isArray(plan.roads) ? plan.roads.length : 0,
    paddyCount: Array.isArray(plan.paddies) ? plan.paddies.length : 0,
    features: featureKeys,
    warnings,
    bytes,
  };
}

export function formatInspect(summary) {
  const kindParts = Object.entries(summary.parcelsByKind)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, n]) => `${k}:${n}`);
  const lines = [
    `seed: ${summary.seed}`,
    `scale/tier: ${summary.scale}`,
    `siteR: ${summary.siteR} m`,
    `parcels: ${summary.parcelCount}${kindParts.length ? ` (${kindParts.join(', ')})` : ''}`,
    `roads: ${summary.roadCount}`,
    `paddies: ${summary.paddyCount}`,
    `features: ${summary.features.length ? summary.features.join(', ') : '(none)'}`,
    `warnings (${summary.warnings.length}):`,
  ];
  if (summary.warnings.length) {
    for (const w of summary.warnings) lines.push(`  - ${w}`);
  } else {
    lines.push('  (none)');
  }
  lines.push(`json bytes: ${summary.bytes}`);
  if (summary.opts) {
    lines.push(`opts: ${JSON.stringify(summary.opts)}`);
  }
  return lines.join('\n');
}

export function formatPlanSummaryLine(plan) {
  const nParcels = Array.isArray(plan.parcels) ? plan.parcels.length : 0;
  const nWarn = Array.isArray(plan.warnings) ? plan.warnings.length : 0;
  const siteR = plan.opts?.siteR ?? plan.site?.siteR;
  return `plan scale=${plan.scale} siteR=${siteR} parcels=${nParcels} warnings=${nWarn}`;
}

export function parseArgs(argv) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next != null && !next.startsWith('-')) {
        // boolean flags that take no value
        if (key === 'pretty' || key === 'help') {
          flags[key] = true;
        } else {
          flags[key] = next;
          i += 1;
        }
      } else {
        flags[key] = true;
      }
    } else if (a.startsWith('-') && a !== '-') {
      // short flags unused; treat as error later if needed
      flags[a] = true;
    } else {
      positionals.push(a);
    }
  }
  return { flags, positionals };
}

export function printHelp(command) {
  if (command === 'plan') {
    return [
      'Usage: cheoma plan [options]',
      '',
      'Generate a deterministic village plan JSON (three-free).',
      '',
      'Options:',
      '  --seed <n>           Plan seed (number or string)',
      `  --scale <name>       Named scale anchor: ${SCALE_NAMES.join('|')}`,
      '  --site-r <m>         Basin radius in meters (mutually exclusive with --scale)',
      '  --out <path>         Write JSON to path (default: stdout)',
      '  --pretty             Indent JSON (2 spaces)',
      '  --help               Show this help',
      '',
      'Notes:',
      '  - stdout is JSON only (pipe-safe); a one-line summary goes to stderr.',
      '  - --scale and --site-r cannot be combined.',
    ].join('\n');
  }
  if (command === 'inspect') {
    return [
      'Usage: cheoma inspect <plan.json>',
      '',
      'Print a one-screen summary of a plan JSON (seed, scale, parcel counts, features, warnings).',
      '',
      'Options:',
      '  --help               Show this help',
    ].join('\n');
  }
  if (command === 'validate') {
    return [
      'Usage: cheoma validate <plan.json>',
      '',
      'Validate a plan JSON:',
      '  1) determinism — re-run planVillage from stored opts/seed and compare bytes',
      '  2) domain — validateDangsanPlan, validateRoadsideDrainagePlan, and',
      '     validateMjaHousePlan (when parcels[].mjaHouse is present)',
      '',
      'Exits 0 when every check PASSes; exits 1 on any FAIL.',
      '',
      'Options:',
      '  --help               Show this help',
    ].join('\n');
  }
  if (command === 'map-data') {
    return [
      'Usage: cheoma map-data <plan.json> --out-dir <dir> [options]',
      '',
      'Write pure JSON map export files from a village plan (three-free):',
      '  colliders.json  — walk solids for game engines',
      '  metadata.json   — buildings, roads, site summary',
      '  terrain.json    — regular height grid',
      '',
      'Options:',
      '  --out-dir <dir>           Output directory (required)',
      '  --terrain-step <m>        Terrain grid step in meters (default: 4)',
      '  --polygonize-citywall     Replace analytic citywall solids with poly strips',
      '  --help                    Show this help',
      '',
      'Notes:',
      '  - stdout is quiet; a one-line solids/buildings/grid summary goes to stderr.',
      '  - Same plan input always yields the same file bytes.',
    ].join('\n');
  }
  if (command === 'glb') {
    return [
      'Usage: cheoma glb --preset <name> --out <file.glb> [options]',
      '',
      'Bake a standalone building to binary glTF (GLB) in plain Node.',
      '',
      'Options:',
      '  --preset <name>     Building preset (see error list for names)',
      '  --out <file.glb>    Output path (required)',
      '  --seed <n>          Palette paint RNG seed (LCG; default: 0)',
      '  --help              Show this help',
      '',
      'Notes:',
      '  - Textures are omitted in the node path; use the in-app export for textured GLB.',
      '  - Same preset+seed always yields the same GLB bytes.',
    ].join('\n');
  }
  return [
    'Usage: cheoma <command> [options]',
    '',
    'Commands:',
    '  plan       Generate a village plan JSON',
    '  inspect    Summarize a plan JSON',
    '  validate   Determinism + domain validation of a plan JSON',
    '  map-data   Write colliders/metadata/terrain JSON from a plan',
    '  glb        Bake a standalone building GLB (textures omitted in Node)',
    '',
    'Run `cheoma <command> --help` for command options.',
  ].join('\n');
}
