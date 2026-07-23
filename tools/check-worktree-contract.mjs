import assert from 'node:assert/strict';
import {
  claimCoversPath,
  claimIdentityProblem,
  claimsOverlap,
  cleanupProblems,
  dependencyState,
  filterManagedDependencyPaths,
  findClaimConflicts,
  normalizeClaimPath,
  normalizeWorktreeSlug,
  parseWorktreePorcelain,
  parseStatusPorcelainZ,
} from './lib/worktree-contract.mjs';

assert.equal(normalizeWorktreeSlug('issue-92-speed'), 'issue-92-speed');
assert.throws(() => normalizeWorktreeSlug('../main'), /slug/);
assert.throws(() => normalizeWorktreeSlug('Issue-92'), /slug/);
assert.equal(normalizeClaimPath('./src/env/'), 'src/env/');
assert.throws(() => normalizeClaimPath('../src'), /unsafe/);
assert.throws(() => normalizeClaimPath('src/**/*.js'), /unsafe/);

assert.equal(claimCoversPath(['src/env/'], 'src/env/post.js'), true);
assert.equal(claimCoversPath(['src/env/post.js'], 'src/env/post.js'), true);
assert.equal(claimCoversPath(['src/env/post.js'], 'src/env/post-quality-state.js'), false);
assert.equal(claimsOverlap('src/env/', 'src/env/post.js'), true);
assert.equal(claimsOverlap('src/env/post.js', 'src/env/post-quality-state.js'), false);
assert.deepEqual(findClaimConflicts({ slug: 'b', owns: ['src/env/'] }, [
  { slug: 'a', owns: ['src/env/post.js'] },
]), [{ own: 'src/env/', slug: 'a', other: 'src/env/post.js' }]);
assert.equal(claimIdentityProblem(
  { slug: 'a', path: '/repo-a', branch: 'codex/a' },
  { slug: 'a', path: '/repo-a', branch: 'codex/a' },
), null);
assert.match(claimIdentityProblem(
  { slug: 'a', path: '/repo-a', branch: 'codex/a' },
  { slug: 'a', path: '/repo-b', branch: 'codex/a' },
), /already belongs/);

const parsed = parseWorktreePorcelain([
  'worktree /repo',
  'HEAD aaa',
  'branch refs/heads/main',
  '',
  'worktree /repo-task',
  'HEAD bbb',
  'branch refs/heads/codex/task',
  '',
].join('\n'));
assert.deepEqual(parsed.map(({ path, head, branch }) => ({ path, head, branch })), [
  { path: '/repo', head: 'aaa', branch: 'main' },
  { path: '/repo-task', head: 'bbb', branch: 'codex/task' },
]);
assert.deepEqual(parseStatusPorcelainZ(' M src/a.js\0R  src/new.js\0src/old.js\0'), [
  'src/a.js', 'src/new.js', 'src/old.js',
]);
assert.throws(() => parseStatusPorcelainZ('R  src/new.js\0'), /no source/);

assert.equal(dependencyState({
  exists: true, isSymlink: true, actualTarget: '/repo/node_modules',
  expectedTarget: '/repo/node_modules', lockMatches: true,
}), 'linked');
assert.equal(dependencyState({ exists: false, lockMatches: false }), 'lock-mismatch');
assert.deepEqual(filterManagedDependencyPaths(
  ['src/a.js', 'node_modules', 'app/node_modules', 'node_modules/unexpected'],
  ['node_modules', 'app/node_modules'],
), ['src/a.js', 'node_modules/unexpected']);
assert.deepEqual(cleanupProblems({
  primary: parsed[0], worktree: parsed[1], dirtyPaths: [], merged: true,
  dependencyStates: { root: 'linked', app: 'missing' },
}), []);
assert.equal(cleanupProblems({
  primary: parsed[0], worktree: parsed[0], dirtyPaths: ['src/a.js'], merged: false,
  dependencyStates: { root: 'wrong-target' },
}).length, 4);

console.log('WORKTREE CONTRACT: PASS (slug, claims, porcelain, dependencies, cleanup refusal)');
