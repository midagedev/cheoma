import { posix } from 'node:path';

const SLUG = /^[a-z0-9][a-z0-9-]*$/;

export function normalizeWorktreeSlug(value) {
  if (typeof value !== 'string' || !SLUG.test(value)) {
    throw new Error('worktree slug must match ^[a-z0-9][a-z0-9-]*$');
  }
  return value;
}

export function normalizeClaimPath(value) {
  if (typeof value !== 'string') throw new TypeError('claim path must be a string');
  const directory = value.endsWith('/');
  const path = value.trim().replaceAll('\\', '/').replace(/^\.\//, '');
  if (!path || path.startsWith('/') || path.split('/').includes('..') || /[*?\[\]{}]/.test(path)) {
    throw new Error(`unsafe claim path: ${JSON.stringify(value)}`);
  }
  const normalized = posix.normalize(path).replace(/^\.\//, '');
  return directory && !normalized.endsWith('/') ? `${normalized}/` : normalized;
}

function ownsPath(claim, path) {
  return claim.endsWith('/') ? path.startsWith(claim) : path === claim;
}

export function claimCoversPath(claims, path) {
  const normalized = normalizeClaimPath(path);
  return claims.some((claim) => ownsPath(normalizeClaimPath(claim), normalized));
}

export function claimsOverlap(left, right) {
  const a = normalizeClaimPath(left);
  const b = normalizeClaimPath(right);
  return ownsPath(a, b) || ownsPath(b, a);
}

export function findClaimConflicts(candidate, activeClaims) {
  const conflicts = [];
  for (const own of candidate.owns || []) {
    for (const active of activeClaims) {
      if (active.slug === candidate.slug) continue;
      for (const other of active.owns || []) {
        if (claimsOverlap(own, other)) conflicts.push({ own, slug: active.slug, other });
      }
    }
  }
  return conflicts;
}

export function claimIdentityProblem(existing, candidate) {
  if (!existing || existing.slug !== candidate.slug) return null;
  if (existing.path === candidate.path && existing.branch === candidate.branch) return null;
  return `claim slug ${candidate.slug} already belongs to ${existing.path} (${existing.branch})`;
}

export function parseStatusPorcelainZ(source) {
  const fields = source.split('\0');
  const paths = [];
  for (let index = 0; index < fields.length;) {
    const record = fields[index++];
    if (!record) continue;
    if (record.length < 4 || record[2] !== ' ') {
      throw new Error(`invalid porcelain v1 record: ${JSON.stringify(record)}`);
    }
    const status = record.slice(0, 2);
    paths.push(record.slice(3));
    if (/[RC]/.test(status)) {
      const original = fields[index++];
      if (!original) throw new Error(`rename/copy record has no source: ${JSON.stringify(record)}`);
      paths.push(original);
    }
  }
  return paths;
}

export function parseWorktreePorcelain(source) {
  const worktrees = [];
  let current = null;
  for (const line of source.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current) worktrees.push(current);
      current = { path: line.slice('worktree '.length), bare: false, detached: false, prunable: false };
    } else if (!current || !line) {
      continue;
    } else if (line.startsWith('HEAD ')) current.head = line.slice(5);
    else if (line.startsWith('branch ')) current.branch = line.slice(7).replace(/^refs\/heads\//, '');
    else if (line === 'bare') current.bare = true;
    else if (line === 'detached') current.detached = true;
    else if (line.startsWith('prunable')) current.prunable = true;
  }
  if (current) worktrees.push(current);
  return worktrees;
}

export function dependencyState({ exists, isSymlink, actualTarget, expectedTarget, lockMatches }) {
  if (!lockMatches) return 'lock-mismatch';
  if (!exists) return 'missing';
  if (!isSymlink) return 'occupied';
  return actualTarget === expectedTarget ? 'linked' : 'wrong-target';
}

export function filterManagedDependencyPaths(paths, managedLinks) {
  const managed = new Set(managedLinks);
  return paths.filter((path) => !managed.has(path));
}

export function cleanupProblems({ primary, worktree, dirtyPaths, merged, dependencyStates }) {
  const problems = [];
  if (worktree.path === primary.path) problems.push('primary worktree cannot be cleaned up');
  if (worktree.bare || worktree.detached) problems.push('bare or detached worktree is not managed');
  if (worktree.prunable) problems.push('prunable metadata must be inspected manually');
  if (dirtyPaths.length) problems.push(`worktree is dirty: ${dirtyPaths.join(', ')}`);
  if (!merged) problems.push('branch is not merged into origin/main or main');
  for (const [name, state] of Object.entries(dependencyStates)) {
    if (!['linked', 'missing'].includes(state)) problems.push(`${name} dependency is ${state}`);
  }
  return problems;
}
