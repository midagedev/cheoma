import { readFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { planVerification, verificationCommands } from './lib/verification-plan.mjs';

function parseArgs(argv) {
  const options = { dryRun: false, json: false, full: false, base: null, filesFrom: null };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--full') options.full = true;
    else if (arg === '--base' || arg === '--files-from') {
      const value = argv[++index];
      if (!value) throw new Error(`${arg} requires a value`);
      if (arg === '--base') options.base = value;
      else options.filesFrom = value;
    } else if (arg === '--help') options.help = true;
    else throw new Error(`unknown option: ${arg}`);
  }
  return options;
}

function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || `git ${args.join(' ')} failed`).trim());
  return result.stdout;
}

function parseNameStatus(output) {
  const fields = output.split('\0');
  const records = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    if (!status) continue;
    if (/^[RC]/.test(status)) {
      const oldPath = fields[index++];
      const newPath = fields[index++];
      if (oldPath) records.push({ path: oldPath, status, isNew: false });
      if (newPath) records.push({ path: newPath, status, isNew: true });
    } else {
      const path = fields[index++];
      if (path) records.push({ path, status, isNew: status.startsWith('A') });
    }
  }
  return records;
}

function defaultBase(options) {
  if (options.base) return options.base;
  if (process.env.CHEOMA_CHECK_BASE) return process.env.CHEOMA_CHECK_BASE;
  if (process.env.GITHUB_BASE_REF) return `origin/${process.env.GITHUB_BASE_REF}`;
  return 'origin/main';
}

async function readInjectedFiles(source) {
  const text = source === '-'
    ? await new Promise((resolve, reject) => {
      let value = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => { value += chunk; });
      process.stdin.on('end', () => resolve(value));
      process.stdin.on('error', reject);
    })
    : await readFile(source, 'utf8');
  return text.split(/\0|\r?\n/).map((value) => value.trim()).filter(Boolean);
}

async function collectChangedFiles(options) {
  const base = defaultBase(options);
  const mergeBase = git(['merge-base', 'HEAD', base]).trim();
  if (!mergeBase) throw new Error(`no merge base for ${base}`);
  if (options.filesFrom) {
    const files = await readInjectedFiles(options.filesFrom);
    const basePaths = new Set(git(['ls-tree', '-r', '--name-only', mergeBase]).split('\n').filter(Boolean));
    return { files, newPaths: files.filter((path) => !basePaths.has(path)), base };
  }
  const committed = parseNameStatus(git([
    'diff', '--name-status', '-z', '--find-renames', `${mergeBase}..HEAD`,
  ]));
  const working = parseNameStatus(git(['diff', '--name-status', '-z', '--find-renames', 'HEAD']));
  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z'])
    .split('\0').filter((path) => path && !path.startsWith('.claude/'));
  const records = [...committed, ...working];
  return {
    files: [...records.map((record) => record.path), ...untracked],
    newPaths: [...records.filter((record) => record.isNew).map((record) => record.path), ...untracked],
    base,
  };
}

function printableCommand(command) {
  return [command.command, ...command.args].join(' ');
}

function printHuman(plan, commands, { base, collectionError }) {
  console.log(`VERIFY base=${base || '(injected)'} files=${plan.files.length} mode=${plan.full ? 'full' : 'affected'}`);
  if (collectionError) console.log(`FULL   ${collectionError}`);
  for (const route of plan.routes) {
    const selection = route.full ? 'full' : (route.gates.join(',') || 'core only');
    console.log(`FILE   ${route.path} -> ${selection} (${route.reasons.join('; ')})`);
  }
  for (const command of commands) console.log(`RUN    ${printableCommand(command)}`);
}

async function runCommand(command) {
  const executable = process.platform === 'win32' && command.command === 'npm' ? 'npm.cmd' : command.command;
  const started = performance.now();
  const code = await new Promise((resolve, reject) => {
    const child = spawn(executable, command.args, { stdio: 'inherit', env: process.env });
    child.on('error', reject);
    child.on('exit', (exitCode, signal) => {
      if (signal) reject(new Error(`${command.id} terminated by ${signal}`));
      else resolve(exitCode ?? 1);
    });
  });
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  if (code !== 0) throw new Error(`${command.id} failed with exit ${code} after ${seconds}s`);
  console.log(`DONE   ${command.id} ${seconds}s`);
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  console.log('Usage: node tools/check-pr.mjs [--dry-run] [--json] [--full] [--base REF] [--files-from FILE|-]');
  console.log('       --json prints the plan without executing it');
  process.exit(0);
}

let collected = { files: [], newPaths: [], base: null };
let collectionError = null;
if (!options.full) {
  try {
    collected = await collectChangedFiles(options);
  } catch (error) {
    collectionError = `change discovery failed closed: ${error.message}`;
  }
}
const forceFullReason = options.full ? '--full requested' : collectionError;
let plan;
try {
  plan = planVerification(collected.files, { forceFullReason, newPaths: collected.newPaths });
} catch (error) {
  collectionError ||= `verification planning failed closed: ${error.message}`;
  plan = planVerification([], { forceFullReason: collectionError });
}
const commands = verificationCommands(plan);

if (options.json) {
  console.log(JSON.stringify({ ...plan, base: collected.base, collectionError, commands }, null, 2));
} else {
  printHuman(plan, commands, { base: collected.base, collectionError });
}

// JSON is a machine-readable plan. Never append child-process logs to it.
if (!options.dryRun && !options.json) {
  for (const command of commands) await runCommand(command);
}
