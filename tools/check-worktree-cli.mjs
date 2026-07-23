import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const tool = fileURLToPath(new URL('./worktree.mjs', import.meta.url));
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'cheoma-worktree-cli-')));
const repo = join(scratch, 'repo');
const taskPath = join(scratch, 'repo-task');

function run(command, args, cwd = repo) {
  return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function wt(args) {
  return run(process.execPath, [tool, ...args]);
}

try {
  mkdirSync(join(repo, 'app'), { recursive: true });
  mkdirSync(join(repo, 'node_modules'));
  mkdirSync(join(repo, 'app', 'node_modules'));
  writeFileSync(join(repo, '.gitignore'), '/node_modules\n/app/node_modules\nshots/\n');
  writeFileSync(join(repo, 'package-lock.json'), '{"lockfileVersion":3}\n');
  writeFileSync(join(repo, 'app', 'package-lock.json'), '{"lockfileVersion":3}\n');
  run('git', ['init', '-b', 'main']);
  run('git', ['config', 'user.email', 'check@example.invalid']);
  run('git', ['config', 'user.name', 'Worktree Contract']);
  run('git', ['add', '.gitignore', 'package-lock.json', 'app/package-lock.json']);
  run('git', ['commit', '-m', 'fixture']);

  const created = JSON.parse(wt([
    'create', 'task', '--base', 'main', '--issue', '92', '--owner', 'fixture',
    '--owns', 'src/', '--gate', 'check:pr',
  ]));
  assert.equal(created.path, taskPath);
  assert.equal(created.dependencies.root, 'linked');
  assert.equal(created.dependencies.app, 'linked');
  assert.equal(JSON.parse(wt(['doctor', 'task', '--json'])).ok, true);

  const duplicate = spawnSync(process.execPath, [tool, 'create', 'task', '--base', 'main'], {
    cwd: repo, encoding: 'utf8',
  });
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr, /already exists|already registered/);
  assert.equal(JSON.parse(wt(['doctor', 'task', '--json'])).ok, true);

  const updated = JSON.parse(wt(['claim', 'task', '--owner', 'fixture-updated']));
  assert.equal(updated.path, taskPath);
  assert.equal(updated.owner, 'fixture-updated');

  const ignoredEvidence = join(taskPath, 'shots', 'evidence.txt');
  mkdirSync(join(taskPath, 'shots'));
  writeFileSync(ignoredEvidence, 'must survive refused cleanup\n');
  const ignoredCleanup = spawnSync(process.execPath, [tool, 'cleanup', 'task'], {
    cwd: repo, encoding: 'utf8',
  });
  assert.notEqual(ignoredCleanup.status, 0);
  assert.match(ignoredCleanup.stderr, /worktree is dirty/);
  assert.equal(readFileSync(ignoredEvidence, 'utf8'), 'must survive refused cleanup\n');
  rmSync(join(taskPath, 'shots'), { recursive: true });

  wt(['cleanup', 'task']);
  assert.equal(existsSync(taskPath), false);
  const commonDir = run('git', ['rev-parse', '--git-common-dir']).trim();
  const claimPath = join(repo, commonDir, 'cheoma-worktrees', 'claims', 'task.json');
  assert.equal(existsSync(claimPath), false);
  assert.equal(run('git', ['branch', '--list', 'codex/task']).trim(), '');
  assert.equal(readFileSync(join(repo, 'package-lock.json'), 'utf8'), '{"lockfileVersion":3}\n');

  const unexpected = join(repo, 'app', 'node_modules', 'unexpected.txt');
  writeFileSync(unexpected, 'preserve me\n');
  run('git', ['add', '-f', 'app/node_modules/unexpected.txt']);
  run('git', ['commit', '-m', 'tracked dependency collision fixture']);
  const occupied = spawnSync(process.execPath, [
    tool, 'create', 'occupied', '--base', 'main', '--owns', 'src/',
  ], { cwd: repo, encoding: 'utf8' });
  assert.notEqual(occupied.status, 0);
  assert.match(occupied.stderr, /preserve unexpected dependency content/);
  const occupiedPath = join(scratch, 'repo-occupied');
  assert.equal(readFileSync(join(occupiedPath, 'app', 'node_modules', 'unexpected.txt'), 'utf8'), 'preserve me\n');
  const recoveryClaim = JSON.parse(readFileSync(
    join(repo, commonDir, 'cheoma-worktrees', 'claims', 'occupied.json'),
    'utf8',
  ));
  assert.equal(recoveryClaim.state, 'recovery');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log('WORKTREE CLI: PASS (create, dependency links, claim update, duplicate refusal, cleanup)');
