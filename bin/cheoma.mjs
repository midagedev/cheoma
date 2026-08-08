#!/usr/bin/env node
// cheoma CLI — plan / inspect / validate (packaging P1).
// Imports only src/api/village-plan.js (three-free plan façade).
import {
  SCALE_NAMES,
  formatInspect,
  formatPlanSummaryLine,
  generatePlan,
  loadPlanJson,
  parseArgs,
  printHelp,
  runDeterminismValidation,
  runDomainValidations,
  stringifyPlan,
  summarizePlan,
  writePlanJson,
} from './lib/plan-cli.mjs';

const argv = process.argv.slice(2);
const command = argv[0] && !argv[0].startsWith('-') ? argv[0] : null;
const rest = command ? argv.slice(1) : argv;
const { flags, positionals } = parseArgs(rest);

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
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

fail(`error: unknown command "${command}"\n\n${printHelp(null)}`);
