import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const OWNER_FILE = 'owner.json';
const OWNERLESS_GRACE_MS = 30_000;

export function gitCommonLockPath(cwd, name) {
  const result = spawnSync('git', ['-C', cwd, 'rev-parse', '--git-common-dir'], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || 'could not resolve git common directory').trim());
  }
  return join(resolve(cwd, result.stdout.trim()), 'cheoma-worktrees', name);
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'ESRCH' ? false : true;
  }
}

function ownerPath(path) {
  return join(path, OWNER_FILE);
}

function removeOwnedDirectory(path) {
  const file = ownerPath(path);
  if (existsSync(file)) unlinkSync(file);
  rmdirSync(path);
}

function createOwnedDirectory(path, owner) {
  mkdirSync(path);
  try {
    writeFileSync(ownerPath(path), `${JSON.stringify(owner)}\n`, { flag: 'wx' });
  } catch (error) {
    // Only remove the empty directory we created. If another process recovered
    // an ownerless lock while this process was paused, never touch its owner.
    try { rmdirSync(path); } catch {}
    throw error;
  }
}

function reclaimOwnerFromName(name) {
  const match = /^\.reclaim-(\d+)-([0-9a-f-]+)\.json$/.exec(name);
  return match ? { pid: Number(match[1]), token: match[2] } : null;
}

function readOwner(path) {
  const file = ownerPath(path);
  if (!existsSync(file)) {
    const reclaimFiles = readdirSync(path).filter((name) => name.startsWith('.reclaim-'));
    if (reclaimFiles.length > 1) throw new Error(`multiple advisory reclaim owners: ${path}`);
    if (reclaimFiles.length === 1) {
      const reclaimOwner = reclaimOwnerFromName(reclaimFiles[0]);
      if (!reclaimOwner) throw new Error(`malformed advisory reclaim owner: ${path}`);
      return processAlive(reclaimOwner.pid)
        ? { busy: true, owner: reclaimOwner }
        : { stale: true, owner: reclaimOwner, claimFile: join(path, reclaimFiles[0]) };
    }
    const age = Date.now() - statSync(path).mtimeMs;
    return age >= OWNERLESS_GRACE_MS
      ? { stale: true, owner: null, claimFile: null }
      : { busy: true };
  }
  try {
    const owner = JSON.parse(readFileSync(file, 'utf8'));
    const alive = processAlive(owner.pid);
    if (alive === null || typeof owner.token !== 'string') {
      throw new Error(`malformed advisory lock owner: ${file}`);
    }
    return alive ? { busy: true, owner } : { stale: true, owner, claimFile: file };
  } catch (error) {
    if (error.code === 'ENOENT') return { busy: true };
    let young = false;
    try { young = Date.now() - statSync(path).mtimeMs < OWNERLESS_GRACE_MS; } catch {}
    if (young) return { busy: true };
    if (/malformed advisory lock owner/.test(error.message)) throw error;
    throw new Error(`malformed advisory lock owner: ${file}`);
  }
}

function releaseFactory(path, token) {
  let released = false;
  return () => {
    if (released) return;
    const owner = JSON.parse(readFileSync(ownerPath(path), 'utf8'));
    if (owner.token !== token) {
      throw new Error(`advisory lock ownership changed before release: ${path}`);
    }
    removeOwnedDirectory(path);
    released = true;
  };
}

export function tryAcquireAdvisoryLock(path, label = 'shared task') {
  mkdirSync(dirname(path), { recursive: true });
  const owner = {
    pid: process.pid,
    token: randomUUID(),
    label,
    createdAt: new Date().toISOString(),
  };
  try {
    createOwnedDirectory(path, owner);
    return { acquired: true, owner, release: releaseFactory(path, owner.token) };
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }

  let state;
  try { state = readOwner(path); }
  catch (error) {
    if (error.code === 'ENOENT') return { acquired: false, owner: null };
    throw error;
  }
  if (state.busy) return { acquired: false, owner: state.owner || null };

  const reclaim = join(path, `.reclaim-${owner.pid}-${owner.token}.json`);
  try {
    if (state.claimFile) renameSync(state.claimFile, reclaim);
    else rmdirSync(path);
  } catch {
    return { acquired: false, owner: null };
  }
  if (state.claimFile) {
    try {
      unlinkSync(reclaim);
      rmdirSync(path);
    } catch (error) {
      throw new Error(`advisory lock reclaim needs inspection: ${path}: ${error.message}`);
    }
  }
  try {
    createOwnedDirectory(path, owner);
    return { acquired: true, owner, release: releaseFactory(path, owner.token) };
  } catch (error) {
    if (error.code === 'EEXIST') return { acquired: false, owner: null };
    throw error;
  }
}

export function acquireAdvisoryLockSync(path, options = {}) {
  const timeoutMs = options.timeoutMs ?? 0;
  const pollMs = options.pollMs ?? 50;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const result = tryAcquireAdvisoryLock(path, options.label);
    if (result.acquired) return result;
    if (Date.now() >= deadline) {
      const holder = result.owner?.pid ? ` by pid ${result.owner.pid}` : '';
      throw new Error(`${options.label || 'shared task'} is locked${holder}: ${path}`);
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pollMs);
  }
}

export async function acquireAdvisoryLock(path, options = {}) {
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;
  const pollMs = options.pollMs ?? 200;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (options.signal?.aborted) {
      const error = new Error(`${options.label || 'shared task'} lock wait aborted`);
      error.name = 'AbortError';
      throw error;
    }
    const result = tryAcquireAdvisoryLock(path, options.label);
    if (result.acquired) return result;
    if (Date.now() >= deadline) {
      throw new Error(`${options.label || 'shared task'} lock timed out: ${path}`);
    }
    await new Promise((resolve, reject) => {
      let timer = null;
      const finish = (callback) => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
        callback();
      };
      const abort = () => {
        const error = new Error(`${options.label || 'shared task'} lock wait aborted`);
        error.name = 'AbortError';
        finish(() => reject(error));
      };
      timer = setTimeout(() => finish(resolve), pollMs);
      options.signal?.addEventListener('abort', abort, { once: true });
    });
  }
}
