#!/usr/bin/env node
// cheoma CLI — plan / inspect / validate / map-data / glb (packaging P1+P3b).
// plan/inspect/validate stay three-free via bin/lib/plan-cli.mjs.
// map-data and glb dynamic-import their façades so plan commands never load three.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  SCALE_NAMES,
  formatInspect,
  formatPlanSummaryLine,
  generatePlan,
  inputOptsFromPlan,
  loadPlanJson,
  parseArgs,
  printHelp,
  runDeterminismValidation,
  runDomainValidations,
  stringifyPlan,
  summarizePlan,
  writePlanJson,
} from './lib/plan-cli.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const argv = process.argv.slice(2);
const command = argv[0] && !argv[0].startsWith('-') ? argv[0] : null;
const rest = command ? argv.slice(1) : argv;
const { flags, positionals } = parseArgs(rest);

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

/** Deterministic LCG in [0,1). No Math.random / Date.now. */
function makeLcg(seed) {
  let s = (Number(seed) >>> 0) || 1;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * three's GLTFExporter binary path merges buffers into a Blob then reads it with
 * FileReader (browser API). Node has Blob but not FileReader — install a minimal
 * polyfill before exportGLB. Texture embeds are already stripped; this only
 * serves the final buffer assembly.
 */
function ensureNodeFileReader() {
  if (typeof globalThis.FileReader !== 'undefined') return;
  globalThis.FileReader = class FileReader {
    constructor() {
      this.result = null;
      this.onloadend = null;
      this.onload = null;
      this.onerror = null;
    }
    readAsArrayBuffer(blob) {
      const finish = (buf) => {
        this.result = buf;
        if (typeof this.onload === 'function') this.onload();
        if (typeof this.onloadend === 'function') this.onloadend();
      };
      const fail = (err) => {
        if (typeof this.onerror === 'function') this.onerror(err);
        else throw err;
      };
      if (!blob || typeof blob.arrayBuffer !== 'function') {
        fail(new TypeError('FileReader polyfill: expected Blob with arrayBuffer()'));
        return;
      }
      blob.arrayBuffer().then(finish, fail);
    }
    readAsDataURL(blob) {
      const finish = (buf) => {
        const b64 = Buffer.from(buf).toString('base64');
        const type = (blob && blob.type) || 'application/octet-stream';
        this.result = `data:${type};base64,${b64}`;
        if (typeof this.onload === 'function') this.onload();
        if (typeof this.onloadend === 'function') this.onloadend();
      };
      const fail = (err) => {
        if (typeof this.onerror === 'function') this.onerror(err);
        else throw err;
      };
      if (!blob || typeof blob.arrayBuffer !== 'function') {
        fail(new TypeError('FileReader polyfill: expected Blob with arrayBuffer()'));
        return;
      }
      blob.arrayBuffer().then(finish, fail);
    }
  };
}

function parseSeedFlag(raw, { required = false, defaultSeed = 0 } = {}) {
  if (raw == null || raw === true) {
    if (required) fail('error: --seed is required\n\n' + printHelp(command));
    return defaultSeed;
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) fail(`error: --seed must be a number (got ${raw})`);
  return n;
}

// Top-level help: `cheoma --help`, `cheoma help`, or no args.
if (!command || command === 'help') {
  if (!command && argv.length > 0 && !flags.help) {
    fail(`${printHelp(null)}\n\nerror: missing command`);
  }
  console.log(printHelp(null));
  process.exit(0);
}

if (command === 'plan') {
  if (flags.help) {
    console.log(printHelp('plan'));
    process.exit(0);
  }
  const hasScale = flags.scale != null && flags.scale !== true;
  const hasSiteR = flags['site-r'] != null && flags['site-r'] !== true;
  if (hasScale && hasSiteR) {
    fail('error: --scale and --site-r are mutually exclusive');
  }
  if (!hasScale && !hasSiteR) {
    fail('error: provide --scale <name> or --site-r <m>\n\n' + printHelp('plan'));
  }
  if (flags.seed == null || flags.seed === true) {
    fail('error: --seed is required\n\n' + printHelp('plan'));
  }

  const opts = {};
  const seedRaw = flags.seed;
  const seedNum = Number(seedRaw);
  opts.seed = Number.isFinite(seedNum) && String(seedNum) === String(seedRaw).trim()
    ? seedNum
    : seedRaw;

  if (hasScale) {
    if (!SCALE_NAMES.includes(flags.scale)) {
      fail(`error: unknown --scale "${flags.scale}" (expected ${SCALE_NAMES.join('|')})`);
    }
    opts.scale = flags.scale;
  } else {
    const siteR = Number(flags['site-r']);
    if (!Number.isFinite(siteR) || siteR <= 0) {
      fail(`error: --site-r must be a positive number (got ${flags['site-r']})`);
    }
    opts.siteR = siteR;
  }

  const plan = generatePlan(opts);
  const text = stringifyPlan(plan, { pretty: !!flags.pretty });
  if (flags.out && flags.out !== true) {
    writePlanJson(flags.out, text.endsWith('\n') ? text : `${text}\n`);
  } else {
    process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
  }
  console.error(formatPlanSummaryLine(plan));
  process.exit(0);
}

if (command === 'inspect') {
  if (flags.help) {
    console.log(printHelp('inspect'));
    process.exit(0);
  }
  const path = positionals[0];
  if (!path) fail('error: inspect requires <plan.json>\n\n' + printHelp('inspect'));
  const { plan, text } = loadPlanJson(path);
  const summary = summarizePlan(plan, text);
  console.log(formatInspect(summary));
  process.exit(0);
}

if (command === 'validate') {
  if (flags.help) {
    console.log(printHelp('validate'));
    process.exit(0);
  }
  const path = positionals[0];
  if (!path) fail('error: validate requires <plan.json>\n\n' + printHelp('validate'));
  const { plan } = loadPlanJson(path);
  const results = [
    runDeterminismValidation(plan),
    ...runDomainValidations(plan),
  ];
  let failed = 0;
  for (const r of results) {
    if (r.ok) {
      console.log(`PASS  ${r.name}`);
    } else {
      failed += 1;
      console.log(`FAIL  ${r.name}`);
      console.log(`      ${r.error}`);
    }
  }
  console.log(failed ? `validate: ${failed} FAIL` : `validate: ${results.length} PASS`);
  process.exit(failed ? 1 : 0);
}

if (command === 'map-data') {
  if (flags.help) {
    console.log(printHelp('map-data'));
    process.exit(0);
  }
  const planPath = positionals[0];
  if (!planPath) fail('error: map-data requires <plan.json>\n\n' + printHelp('map-data'));
  if (!flags['out-dir'] || flags['out-dir'] === true) {
    fail('error: --out-dir <dir> is required\n\n' + printHelp('map-data'));
  }
  const outDir = flags['out-dir'];
  let terrainStep = 4;
  if (flags['terrain-step'] != null && flags['terrain-step'] !== true) {
    terrainStep = Number(flags['terrain-step']);
    if (!Number.isFinite(terrainStep) || terrainStep <= 0) {
      fail(`error: --terrain-step must be a positive number (got ${flags['terrain-step']})`);
    }
  }
  const polygonizeCityWall = !!flags['polygonize-citywall'];

  const { buildMapColliders, buildMapMetadata, sampleTerrainHeightGrid } = await import(
    pathToFileURL(join(ROOT, 'src/api/map-data.js')).href
  );
  // plan.json is pure JSON — functions like site.heightAt do not survive stringify.
  // sampleTerrainHeightGrid needs the live height sampler, so rehydrate via
  // planVillage from the stored generative inputs (seed/siteR/opts). Same seed
  // always rebuilds the same plan; colliders/metadata/terrain stay deterministic.
  const { plan: stored } = loadPlanJson(planPath);
  let plan;
  try {
    plan = generatePlan(inputOptsFromPlan(stored));
  } catch (err) {
    fail(`error: cannot rehydrate plan for map-data: ${err.message}`);
  }
  const colliders = buildMapColliders(plan, { polygonizeCityWall });
  const metadata = buildMapMetadata(plan);
  const terrain = sampleTerrainHeightGrid(plan, { step: terrainStep });

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'colliders.json'), JSON.stringify(colliders));
  writeFileSync(join(outDir, 'metadata.json'), JSON.stringify(metadata));
  writeFileSync(join(outDir, 'terrain.json'), JSON.stringify(terrain));

  const solids = Array.isArray(colliders.solids) ? colliders.solids.length : 0;
  const buildings = Array.isArray(metadata.buildings) ? metadata.buildings.length : 0;
  const nx = terrain.nx ?? 0;
  const nz = terrain.nz ?? 0;
  console.error(`map-data solids=${solids} buildings=${buildings} terrain=${nx}x${nz}`);
  process.exit(0);
}

if (command === 'glb') {
  if (flags.help) {
    console.log(printHelp('glb'));
    process.exit(0);
  }
  if (!flags.preset || flags.preset === true) {
    fail('error: --preset <name> is required\n\n' + printHelp('glb'));
  }
  if (!flags.out || flags.out === true) {
    fail('error: --out <file.glb> is required\n\n' + printHelp('glb'));
  }
  const seed = parseSeedFlag(flags.seed, { defaultSeed: 0 });
  const outPath = flags.out;
  const presetName = String(flags.preset);

  const { PRESETS, buildBuilding, disposeBuilding } = await import(
    pathToFileURL(join(ROOT, 'src/api/building.js')).href
  );
  const presetNames = Object.keys(PRESETS || {}).sort();
  if (!PRESETS[presetName]) {
    fail(
      `error: unknown --preset "${presetName}" (available: ${presetNames.join(', ')})`,
    );
  }

  const { setPaletteContext, createPaletteContext } = await import(
    pathToFileURL(join(ROOT, 'src/builder/palette.js')).href
  );
  const { makeRecordingCanvasFactory } = await import(
    pathToFileURL(join(ROOT, 'tools/lib/node-canvas-stub.mjs')).href
  );
  const { exportGLB, analyzeExport, stripMaterialTextures } = await import(
    pathToFileURL(join(ROOT, 'src/api/export.js')).href
  );

  ensureNodeFileReader();

  const factory = makeRecordingCanvasFactory();
  setPaletteContext(createPaletteContext({
    random: makeLcg(seed),
    createCanvas: factory.createCanvas,
  }));

  const root = buildBuilding({ ...PRESETS[presetName] });
  try {
    // Export-only material clones with texture slots nulled so GLTFExporter never
    // enters processImage (which needs document). Original palette materials intact.
    stripMaterialTextures(root);
    const stats = analyzeExport(root);
    if (!(stats.triangles > 0)) {
      fail('error: export has zero triangles');
    }
    const result = await exportGLB(root, { binary: true });
    if (result && result.overBudget) {
      fail(`error: GLB over triangle budget (${result.triangles} > ${result.limit})`);
    }
    if (!(result instanceof ArrayBuffer)) {
      fail(`error: exportGLB did not return ArrayBuffer (got ${typeof result})`);
    }
    const u8 = new Uint8Array(result);
    if (u8.byteLength < 12) fail('error: GLB too short for header');
    const magic = String.fromCharCode(u8[0], u8[1], u8[2], u8[3]);
    if (magic !== 'glTF') fail(`error: GLB magic is "${magic}", expected "glTF"`);
    const declared = new DataView(result).getUint32(8, true);
    if (declared !== result.byteLength) {
      fail(`error: GLB declared length ${declared} != actual ${result.byteLength}`);
    }
    writeFileSync(outPath, Buffer.from(result));
    console.error(`glb preset=${presetName} seed=${seed} triangles=${stats.triangles} bytes=${result.byteLength}`);
  } finally {
    disposeBuilding(root);
  }
  process.exit(0);
}

fail(`error: unknown command "${command}"\n\n${printHelp(null)}`);
