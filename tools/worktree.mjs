import {
  existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync,
  renameSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { acquireAdvisoryLockSync } from './lib/advisory-lock.mjs';
import {
  claimCoversPath,
  claimIdentityProblem,
  cleanupProblems,
  dependencyState,
  filterManagedDependencyPaths,
  findClaimConflicts,
  normalizeClaimPath,
  normalizeWorktreeSlug,
  parseWorktreePorcelain,
  parseStatusPorcelainZ,
} from './lib/worktree-contract.mjs';

function run(command, args, { cwd = process.cwd(), allowFailure = false } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (!allowFailure && result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `${command} failed`).trim());
  }
  return result;
}

function git(args, options) {
  return run('git', args, options);
}

function parseOptions(argv) {
  const options = { owns: [], gates: [], json: false };
  const positionals = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--json') options.json = true;
    else if (['--base', '--issue', '--owner', '--owns', '--gate'].includes(arg)) {
      const value = argv[++index];
      if (!value) throw new Error(`${arg} requires a value`);
      if (arg === '--owns') options.owns.push(normalizeClaimPath(value));
      else if (arg === '--gate') options.gates.push(value);
      else options[arg.slice(2)] = value;
    } else if (arg.startsWith('--')) throw new Error(`unknown option: ${arg}`);
    else positionals.push(arg);
  }
  return { options, positionals };
}

const currentRoot = git(['rev-parse', '--show-toplevel']).stdout.trim();
const worktrees = () => parseWorktreePorcelain(
  git(['-C', currentRoot, 'worktree', 'list', '--porcelain']).stdout,
);
const primary = worktrees()[0];
if (!primary?.path) throw new Error('could not resolve the primary worktree');
const commonRaw = git(['-C', primary.path, 'rev-parse', '--git-common-dir']).stdout.trim();
const commonDir = resolve(primary.path, commonRaw);
const claimsDir = join(commonDir, 'cheoma-worktrees', 'claims');
const claimLock = join(commonDir, 'cheoma-worktrees', 'claims.lock');

function withClaimLock(callback) {
  const lock = acquireAdvisoryLockSync(claimLock, {
    label: 'worktree claim registry', timeoutMs: 10_000, pollMs: 50,
  });
  try { return callback(); }
  finally { lock.release(); }
}

function readClaims() {
  if (!existsSync(claimsDir)) return [];
  return readdirSync(claimsDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(readFileSync(join(claimsDir, name), 'utf8')));
}

function writeClaimUnlocked(claim) {
  normalizeWorktreeSlug(claim.slug);
  const normalized = { ...claim, owns: [...new Set((claim.owns || []).map(normalizeClaimPath))] };
  const activePaths = new Set(worktrees().map((worktree) => worktree.path));
  const claims = readClaims();
  const identityProblem = claimIdentityProblem(
    claims.find((item) => item.slug === normalized.slug),
    normalized,
  );
  if (identityProblem) throw new Error(identityProblem);
  const activeClaims = claims.filter((item) => activePaths.has(item.path));
  const conflicts = findClaimConflicts(normalized, activeClaims);
  if (conflicts.length) {
    throw new Error(`claim overlaps ${conflicts.map((item) => `${item.slug}:${item.other}`).join(', ')}`);
  }
  mkdirSync(claimsDir, { recursive: true });
  const target = join(claimsDir, `${normalized.slug}.json`);
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, { flag: 'wx' });
  renameSync(temporary, target);
  return normalized;
}

function writeClaim(claim) {
  return withClaimLock(() => writeClaimUnlocked(claim));
}

function assertClaimAvailable(claim) {
  const activePaths = new Set(worktrees().map((worktree) => worktree.path));
  const claims = readClaims();
  const identityProblem = claimIdentityProblem(claims.find((item) => item.slug === claim.slug), claim);
  if (identityProblem) throw new Error(identityProblem);
  const activeClaims = claims.filter((item) => activePaths.has(item.path));
  const conflicts = findClaimConflicts(claim, activeClaims);
  if (conflicts.length) {
    throw new Error(`claim overlaps ${conflicts.map((item) => `${item.slug}:${item.other}`).join(', ')}`);
  }
}

function removeClaimUnlocked(slug) {
  const target = join(claimsDir, `${normalizeWorktreeSlug(slug)}.json`);
  if (!existsSync(target)) return;
  unlinkSync(target);
}

function claimFor(worktree) {
  return readClaims().find((claim) => claim.path === worktree.path || claim.branch === worktree.branch) || null;
}

function resolveWorktree(selector) {
  const candidates = worktrees();
  const claims = readClaims();
  const claim = claims.find((item) => item.slug === selector);
  const absolute = isAbsolute(selector) ? resolve(selector) : null;
  const matches = candidates.filter((worktree) => (
    worktree.path === absolute
    || worktree.path === claim?.path
    || worktree.branch === selector
    || worktree.branch === `codex/${selector}`
    || basename(worktree.path) === selector
  ));
  if (matches.length !== 1) throw new Error(`selector must resolve one registered worktree: ${selector}`);
  return matches[0];
}

const dependencies = (worktree) => ([
  {
    name: 'root',
    source: join(primary.path, 'node_modules'),
    destination: join(worktree.path, 'node_modules'),
    primaryLock: join(primary.path, 'package-lock.json'),
    worktreeLock: join(worktree.path, 'package-lock.json'),
  },
  {
    name: 'app',
    source: join(primary.path, 'app', 'node_modules'),
    destination: join(worktree.path, 'app', 'node_modules'),
    primaryLock: join(primary.path, 'app', 'package-lock.json'),
    worktreeLock: join(worktree.path, 'app', 'package-lock.json'),
  },
]);

function sameFile(left, right) {
  return existsSync(left) && existsSync(right) && readFileSync(left).equals(readFileSync(right));
}

function pathEntryExists(path) {
  try { lstatSync(path); return true; } catch { return false; }
}

function inspectDependency(item) {
  const lockMatches = sameFile(item.primaryLock, item.worktreeLock);
  let stats = null;
  try { stats = lstatSync(item.destination); } catch {}
  if (!stats) {
    return dependencyState({ exists: false, lockMatches });
  }
  const actualTarget = stats.isSymbolicLink()
    ? resolve(dirname(item.destination), readlinkSync(item.destination)) : null;
  return dependencyState({
    exists: true,
    isSymlink: stats.isSymbolicLink(),
    actualTarget,
    expectedTarget: resolve(item.source),
    lockMatches,
  });
}

function dependencyStates(worktree) {
  return Object.fromEntries(dependencies(worktree).map((item) => [item.name, inspectDependency(item)]));
}

function linkDependencies(worktree) {
  if (worktree.path === primary.path) throw new Error('primary worktree owns dependencies directly');
  const items = dependencies(worktree);
  for (const item of items) {
    const state = inspectDependency(item);
    if (!['linked', 'missing'].includes(state)) {
      throw new Error(`${item.name} dependency cannot be linked: ${state}`);
    }
    if (!existsSync(item.source)) throw new Error(`${item.name} dependency source is missing; install in ${primary.path}`);
  }
  const created = [];
  try {
    for (const item of items) {
      if (inspectDependency(item) === 'linked') continue;
      symlinkSync(item.source, item.destination, 'dir');
      created.push(item);
    }
  } catch (error) {
    const recovery = [];
    for (const item of created.reverse()) {
      if (inspectDependency(item) === 'linked') unlinkSync(item.destination);
      else recovery.push(`${item.name} link changed during rollback`);
    }
    throw new Error(`${error.message}${recovery.length ? `; ${recovery.join(', ')}` : ''}`);
  }
}

function unlinkDependencies(worktree) {
  const items = dependencies(worktree);
  for (const item of items) {
    const state = inspectDependency(item);
    if (!['linked', 'missing'].includes(state)) {
      throw new Error(`${item.name} dependency cannot be unlinked: ${state}`);
    }
  }
  const moved = [];
  try {
    for (const item of items) {
      if (inspectDependency(item) === 'missing') continue;
      const quarantine = `${item.destination}.cheoma-unlink-${process.pid}-${randomUUID()}`;
      renameSync(item.destination, quarantine);
      const movedItem = { ...item, quarantine };
      moved.push(movedItem);
      const state = inspectDependency({ ...item, destination: quarantine });
      if (state !== 'linked') throw new Error(`${item.name} dependency changed during unlink: ${state}`);
    }
  } catch (error) {
    const recovery = [];
    for (const item of moved.reverse()) {
      if (!pathEntryExists(item.destination)) renameSync(item.quarantine, item.destination);
      else recovery.push(`${item.name} destination became occupied; preserved ${item.quarantine}`);
    }
    throw new Error(`${error.message}${recovery.length ? `; ${recovery.join(', ')}` : ''}`);
  }
  const removed = [];
  const newlyOccupied = items.filter((item) => pathEntryExists(item.destination));
  if (newlyOccupied.length) {
    const recovery = [];
    for (const item of moved.reverse()) {
      try {
        if (!pathEntryExists(item.destination)) renameSync(item.quarantine, item.destination);
        else recovery.push(`${item.name} quarantine preserved at ${item.quarantine}`);
      } catch (restoreError) {
        recovery.push(`${item.name}: ${restoreError.message}`);
      }
    }
    throw new Error(
      `dependency destination became occupied during unlink: ${newlyOccupied.map((item) => item.name).join(', ')}`
      + `${recovery.length ? `; ${recovery.join(', ')}` : ''}`,
    );
  }
  try {
    for (const item of moved) {
      unlinkSync(item.quarantine);
      removed.push(item);
    }
  } catch (error) {
    const recovery = [];
    for (const item of moved) {
      try {
        if (pathEntryExists(item.quarantine) && !pathEntryExists(item.destination)) {
          renameSync(item.quarantine, item.destination);
        } else if (removed.includes(item) && !pathEntryExists(item.destination)) {
          symlinkSync(item.source, item.destination, 'dir');
        }
      } catch (restoreError) {
        recovery.push(`${item.name}: ${restoreError.message}`);
      }
    }
    throw new Error(`${error.message}${recovery.length ? `; recovery failed: ${recovery.join(', ')}` : ''}`);
  }
  const occupiedAfterCommit = items.filter((item) => pathEntryExists(item.destination));
  if (occupiedAfterCommit.length) {
    throw new Error(
      `dependency destination became occupied after unlink: ${occupiedAfterCommit.map((item) => item.name).join(', ')}`,
    );
  }
}

function dirtyPaths(worktree) {
  const output = git([
    '-C', worktree.path, 'status', '--porcelain=v1', '-z',
    '--untracked-files=all', '--ignored=matching',
  ]).stdout;
  const linkedDependencies = new Set(dependencies(worktree)
    .filter((item) => inspectDependency(item) === 'linked')
    .map((item) => relative(worktree.path, item.destination)));
  const paths = parseStatusPorcelainZ(output);
  return filterManagedDependencyPaths(paths, linkedDependencies);
}

function merged(worktree) {
  for (const ref of ['origin/main', 'main']) {
    const exists = git(['-C', primary.path, 'rev-parse', '--verify', '--quiet', ref], { allowFailure: true });
    if (exists.status === 0 && git(
      ['-C', primary.path, 'merge-base', '--is-ancestor', worktree.head, ref],
      { allowFailure: true },
    ).status === 0) return true;
  }
  return false;
}

function aheadBehind(worktree) {
  const result = git(
    ['-C', worktree.path, 'rev-list', '--left-right', '--count', 'origin/main...HEAD'],
    { allowFailure: true },
  );
  if (result.status !== 0) return null;
  const [behind, ahead] = result.stdout.trim().split(/\s+/).map(Number);
  return { ahead, behind };
}

function statusRecord(worktree) {
  const claim = claimFor(worktree);
  const dirty = worktree.bare || !existsSync(worktree.path) ? [] : dirtyPaths(worktree);
  return {
    path: worktree.path,
    branch: worktree.branch || null,
    head: worktree.head || null,
    primary: worktree.path === primary.path,
    dirty,
    aheadBehind: worktree.bare ? null : aheadBehind(worktree),
    dependencies: worktree.path === primary.path ? { root: 'owned', app: 'owned' } : dependencyStates(worktree),
    claim,
  };
}

function doctor(worktree) {
  const record = statusRecord(worktree);
  const problems = [];
  if (!record.primary) {
    for (const [name, state] of Object.entries(record.dependencies)) {
      if (state !== 'linked') problems.push(`${name} dependency is ${state}`);
    }
    if (!record.claim) problems.push('worktree has no ownership claim');
    else for (const path of record.dirty) {
      if (!claimCoversPath(record.claim.owns || [], path)) problems.push(`unclaimed change: ${path}`);
    }
  }
  return { ...record, problems, ok: problems.length === 0 };
}

function printRecord(record) {
  const distance = record.aheadBehind
    ? `+${record.aheadBehind.ahead}/-${record.aheadBehind.behind}` : '-';
  const owner = record.claim?.owner || '-';
  const issue = record.claim?.issue ? `#${record.claim.issue}` : '-';
  console.log(`${record.primary ? '*' : ' '} ${record.branch || '(detached)'} ${distance} dirty=${record.dirty.length} deps=${Object.values(record.dependencies).join('/')} owner=${owner} issue=${issue}`);
  console.log(`  ${record.path}`);
}

function makeClaim(slug, worktree, options, previous = null) {
  const issue = options.issue === undefined ? previous?.issue : Number(options.issue);
  if (issue !== undefined && (!Number.isInteger(issue) || issue < 1)) throw new Error('--issue must be a positive integer');
  return {
    version: 1,
    slug,
    path: worktree.path,
    branch: worktree.branch,
    baseRef: options.base || previous?.baseRef || 'origin/main',
    baseSha: previous?.baseSha || worktree.head,
    issue,
    owner: options.owner || previous?.owner || null,
    owns: options.owns.length ? options.owns : (previous?.owns || []),
    gates: options.gates.length ? [...new Set(options.gates)] : (previous?.gates || []),
  };
}

function usage() {
  console.log('Usage: npm run wt -- create <slug> [--base REF] [--issue N] [--owner ID] [--owns PATH] [--gate SCRIPT]');
  console.log('       npm run wt -- status [--json]');
  console.log('       npm run wt -- claim <selector> [--issue N] [--owner ID] [--owns PATH] [--gate SCRIPT]');
  console.log('       npm run wt -- deps <status|link|unlink> <selector> [--json]');
  console.log('       npm run wt -- doctor <selector> [--json]');
  console.log('       npm run wt -- handoff <selector> [--json]');
  console.log('       npm run wt -- cleanup <selector>');
}

const [command, ...rest] = process.argv.slice(2);
const { options, positionals } = parseOptions(rest);

if (!command || command === 'help' || command === '--help') {
  usage();
} else if (command === 'create') {
  const slug = normalizeWorktreeSlug(positionals[0]);
  if (positionals.length !== 1) throw new Error('create requires one slug');
  const path = join(dirname(primary.path), `${basename(primary.path)}-${slug}`);
  const branch = `codex/${slug}`;
  const base = options.base || 'origin/main';
  if (existsSync(path)) throw new Error(`worktree path already exists: ${path}`);
  if (worktrees().some((item) => item.branch === branch)) throw new Error(`branch is already checked out: ${branch}`);
  if (git(['-C', primary.path, 'rev-parse', '--verify', '--quiet', base], { allowFailure: true }).status !== 0) {
    throw new Error(`base ref does not exist: ${base}`);
  }
  for (const lock of ['package-lock.json', 'app/package-lock.json']) {
    const baseLock = git(['-C', primary.path, 'show', `${base}:${lock}`], { allowFailure: true });
    if (baseLock.status !== 0 || !existsSync(join(primary.path, lock))
      || baseLock.stdout !== readFileSync(join(primary.path, lock), 'utf8')) {
      throw new Error(`${base} ${lock} differs from the primary worktree; update primary or use an independent install`);
    }
  }
  for (const source of [join(primary.path, 'node_modules'), join(primary.path, 'app', 'node_modules')]) {
    if (!existsSync(source)) throw new Error(`dependency source is missing; install first: ${source}`);
  }
  const created = withClaimLock(() => {
    if (existsSync(path)) throw new Error(`worktree path already exists: ${path}`);
    if (worktrees().some((item) => item.branch === branch)) {
      throw new Error(`branch is already checked out: ${branch}`);
    }
    if (readClaims().some((item) => item.slug === slug)) {
      throw new Error(`claim slug is already registered; use wt claim to update it: ${slug}`);
    }
    assertClaimAvailable({ slug, path, branch, owns: options.owns });
    let worktree = null;
    try {
      git(['-C', primary.path, 'worktree', 'add', '-b', branch, path, base]);
      worktree = resolveWorktree(path);
      linkDependencies(worktree);
      const dependencySnapshot = dependencyStates(worktree);
      const claim = writeClaimUnlocked(makeClaim(slug, worktree, { ...options, base }));
      return { path, branch, claim, dependencies: dependencySnapshot };
    } catch (error) {
      worktree ||= worktrees().find((item) => item.path === path) || null;
      let rollbackProblem = '';
      if (worktree) {
        try {
          unlinkDependencies(worktree);
        } catch (unlinkError) {
          const recoveryClaim = writeClaimUnlocked({
            ...makeClaim(slug, worktree, { ...options, base }),
            state: 'recovery',
          });
          throw new Error(
            `${error.message}; rollback stopped to preserve unexpected dependency content; `
            + `recovery claim ${recoveryClaim.slug} was preserved: ${unlinkError.message}`,
          );
        }
        const removed = git(['-C', primary.path, 'worktree', 'remove', worktree.path], { allowFailure: true });
        if (removed.status !== 0) {
          let relinkProblem = '';
          try { linkDependencies(worktree); }
          catch (relinkError) { relinkProblem = `; dependency relink failed: ${relinkError.message}`; }
          const recoveryClaim = writeClaimUnlocked({
            ...makeClaim(slug, worktree, { ...options, base }),
            state: 'recovery',
          });
          rollbackProblem = `; rollback failed, recovery claim ${recoveryClaim.slug} was preserved${relinkProblem}`;
        } else if (worktree.branch?.startsWith('codex/')) {
          git(['-C', primary.path, 'update-ref', '-d', `refs/heads/${worktree.branch}`, worktree.head], { allowFailure: true });
        }
      }
      throw new Error(`${error.message}${rollbackProblem}`);
    }
  });
  console.log(JSON.stringify(created, null, 2));
} else if (command === 'status') {
  if (positionals.length) throw new Error('status takes no selector');
  const records = worktrees().map(statusRecord);
  if (options.json) console.log(JSON.stringify(records, null, 2));
  else records.forEach(printRecord);
} else if (command === 'claim') {
  if (positionals.length !== 1) throw new Error('claim requires one selector');
  const worktree = resolveWorktree(positionals[0]);
  if (worktree.path === primary.path) throw new Error('primary worktree does not need a claim');
  const previous = claimFor(worktree);
  const slug = previous?.slug || normalizeWorktreeSlug(worktree.branch?.replace(/^codex\//, '') || basename(worktree.path));
  const claim = writeClaim(makeClaim(slug, worktree, options, previous));
  console.log(JSON.stringify(claim, null, 2));
} else if (command === 'deps') {
  const [action, selector] = positionals;
  if (!['status', 'link', 'unlink'].includes(action) || !selector || positionals.length !== 2) {
    throw new Error('deps requires status|link|unlink and one selector');
  }
  const worktree = resolveWorktree(selector);
  if (action === 'link') linkDependencies(worktree);
  if (action === 'unlink') unlinkDependencies(worktree);
  const states = dependencyStates(worktree);
  if (options.json) console.log(JSON.stringify(states, null, 2));
  else console.log(Object.entries(states).map(([name, state]) => `${name}=${state}`).join(' '));
} else if (command === 'doctor' || command === 'handoff') {
  if (positionals.length !== 1) throw new Error(`${command} requires one selector`);
  const result = doctor(resolveWorktree(positionals[0]));
  if (options.json || command === 'handoff') console.log(JSON.stringify(result, null, 2));
  else {
    printRecord(result);
    for (const problem of result.problems) console.error(`  - ${problem}`);
  }
  if (!result.ok) process.exitCode = 1;
} else if (command === 'cleanup') {
  if (positionals.length !== 1) throw new Error('cleanup requires one selector');
  const cleaned = withClaimLock(() => {
    const worktree = resolveWorktree(positionals[0]);
    const claim = claimFor(worktree);
    const problems = cleanupProblems({
      primary,
      worktree,
      dirtyPaths: dirtyPaths(worktree),
      merged: merged(worktree),
      dependencyStates: dependencyStates(worktree),
    });
    if (!claim) problems.push('worktree has no ownership claim');
    if (problems.length) throw new Error(`cleanup refused:\n- ${problems.join('\n- ')}`);
    unlinkDependencies(worktree);
    const removed = git(
      ['-C', primary.path, 'worktree', 'remove', worktree.path],
      { allowFailure: true },
    );
    if (removed.status !== 0) {
      let recovery = '';
      try { linkDependencies(worktree); }
      catch (error) { recovery = `; dependency relink also failed: ${error.message}`; }
      throw new Error(`git worktree remove failed; claim preserved and links restored${recovery}: ${(removed.stderr || removed.stdout).trim()}`);
    }
    let branchRetained = false;
    if (worktree.branch?.startsWith('codex/')) {
      branchRetained = git(
        ['-C', primary.path, 'update-ref', '-d', `refs/heads/${worktree.branch}`, worktree.head],
        { allowFailure: true },
      ).status !== 0;
    }
    removeClaimUnlocked(claim.slug);
    return { path: worktree.path, branchRetained };
  });
  console.log(`cleaned ${cleaned.path}${cleaned.branchRetained ? ' (branch retained because its ref changed)' : ''}`);
} else {
  usage();
  throw new Error(`unknown command: ${command}`);
}
