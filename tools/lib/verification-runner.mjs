import { spawn } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { performance } from 'node:perf_hooks';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireAdvisoryLock, gitCommonLockPath } from './advisory-lock.mjs';

const DEFAULT_JOB_LIMIT = 4;

function parseJobCount(value, checkCount) {
  if (value === undefined || value === '') {
    return Math.max(1, Math.min(DEFAULT_JOB_LIMIT, availableParallelism(), checkCount));
  }

  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw new Error('CHEOMA_CHECK_JOBS must be a positive integer');
  }

  return Math.min(Number(value), checkCount);
}

function elapsed(startedAt) {
  return performance.now() - startedAt;
}

function formatDuration(milliseconds) {
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
  return `${(milliseconds / 1000).toFixed(2)} s`;
}

function runChild(check, baseUrl, cwd, env) {
  const startedAt = performance.now();
  const url = new URL(check, baseUrl);
  const path = fileURLToPath(url);

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let spawnError = null;

    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (error) => { spawnError = error; });
    child.on('close', (code, signal) => {
      resolve({
        check,
        label: basename(path),
        code,
        signal,
        spawnError,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        duration: elapsed(startedAt),
      });
    });
  });
}

function statusFor(result) {
  if (result.spawnError) return `FAIL spawn: ${result.spawnError.message}`;
  if (result.signal) return `FAIL signal: ${result.signal}`;
  if (result.code !== 0) return `FAIL exit: ${result.code}`;
  return 'PASS';
}

function writeBlock(stream, value) {
  if (!value) return;
  stream.write(value);
  if (!value.endsWith('\n')) stream.write('\n');
}

function positiveJobCount(value, fallback, label) {
  if (value === undefined || value === '') return fallback;
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return Number(value);
}

function runCommand(command, cwd, env) {
  const startedAt = performance.now();
  const executable = process.platform === 'win32' && command.command === 'npm'
    ? 'npm.cmd' : command.command;
  return new Promise((resolve) => {
    const child = spawn(executable, command.args || [], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let spawnError = null;
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (error) => { spawnError = error; });
    child.on('close', (code, signal) => resolve({
      ...command,
      code,
      signal,
      spawnError,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
      duration: elapsed(startedAt),
    }));
  });
}

async function runManagedCommand(command, cwd, env, sharedBrowserLockPath, signal) {
  const startedAt = performance.now();
  let lock = null;
  let result = null;
  try {
    if (command.resource === 'browser' || command.resource === 'exclusive') {
      lock = await acquireAdvisoryLock(sharedBrowserLockPath, {
        label: `browser verification: ${command.id}`,
        signal,
      });
      if (signal.aborted) {
        const error = new Error(`browser verification aborted before start: ${command.id}`);
        error.name = 'AbortError';
        throw error;
      }
    }
    result = await runCommand(command, cwd, lock
      ? { ...env, CHEOMA_BROWSER_LOCK_HELD: '1' }
      : env);
    result.duration = elapsed(startedAt);
  } catch (spawnError) {
    result = {
      ...command,
      code: null,
      signal: null,
      spawnError: spawnError.name === 'AbortError' ? null : spawnError,
      skipped: spawnError.name === 'AbortError',
      stdout: '',
      stderr: '',
      duration: elapsed(startedAt),
    };
  }
  if (lock) {
    try { lock.release(); }
    catch (spawnError) {
      result = {
        ...command,
        code: null,
        signal: null,
        spawnError,
        stdout: result?.stdout || '',
        stderr: result?.stderr || '',
        duration: elapsed(startedAt),
      };
    }
  }
  return result;
}

/**
 * Run independent repository gates with bounded resources.
 *
 * Browser gates stay in one lane by default because several contracts sample rAF
 * cadence. A CPU contract may overlap that lane, which removes idle wall time
 * without contaminating browser-to-browser measurements.
 */
export async function runCommandSuite(commands, options = {}) {
  if (!Array.isArray(commands) || commands.length === 0) {
    return { ok: true, failures: [], results: [], jobs: 0, browserJobs: 0, skipped: 0, duration: 0 };
  }
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const defaultJobs = Math.max(1, Math.min(2, availableParallelism(), commands.length));
  const jobs = Math.min(
    positiveJobCount(options.jobs ?? env.CHEOMA_GATE_JOBS, defaultJobs, 'CHEOMA_GATE_JOBS'),
    commands.length,
  );
  const browserJobs = Math.min(
    positiveJobCount(options.browserJobs ?? env.CHEOMA_BROWSER_JOBS, 1, 'CHEOMA_BROWSER_JOBS'),
    jobs,
  );
  const startedAt = performance.now();
  const needsBrowserLock = commands.some((command) => (
    command.resource === 'browser' || command.resource === 'exclusive'
  ));
  const sharedBrowserLockPath = needsBrowserLock
    ? (options.sharedBrowserLockPath ?? gitCommonLockPath(cwd, 'browser.lock'))
    : null;
  const pending = commands.map((command, index) => ({ ...command, index }));
  const running = new Map();
  const results = Array(commands.length);
  let activeBrowsers = 0;
  let activeExclusive = false;
  let stopped = false;
  const abortController = new AbortController();

  process.stdout.write(
    `Verification suite: ${commands.length} gates, ${jobs} jobs, ${browserJobs} browser lane${browserJobs === 1 ? '' : 's'}\n`,
  );

  const canStart = (command) => {
    if (activeExclusive) return false;
    if (command.resource === 'exclusive') return running.size === 0;
    return command.resource !== 'browser' || activeBrowsers < browserJobs;
  };
  const start = (command) => {
    if (command.resource === 'browser') activeBrowsers += 1;
    if (command.resource === 'exclusive') activeExclusive = true;
    const promise = runManagedCommand(
      command, cwd, env, sharedBrowserLockPath, abortController.signal,
    )
      .then((result) => ({ command, result }));
    running.set(command.index, promise);
  };

  while ((!stopped && pending.length) || running.size) {
    while (!stopped && running.size < jobs) {
      const nextIndex = pending.findIndex(canStart);
      if (nextIndex < 0) break;
      start(pending.splice(nextIndex, 1)[0]);
    }
    if (!running.size) break;
    const { command, result } = await Promise.race(running.values());
    running.delete(command.index);
    if (command.resource === 'browser') activeBrowsers -= 1;
    if (command.resource === 'exclusive') activeExclusive = false;
    results[command.index] = result;
    if (result.skipped) {
      process.stdout.write(`SKIP   ${result.id} aborted after another gate failed\n`);
      continue;
    }
    const failed = result.spawnError || result.signal || result.code !== 0;
    if (failed) {
      stopped = true;
      abortController.abort();
    }
    process.stdout.write(
      `DONE   ${result.id} ${failed ? statusFor(result) : 'PASS'} ${formatDuration(result.duration)}\n`,
    );
    writeBlock(process.stdout, result.stdout);
    writeBlock(process.stderr, result.stderr);
  }

  const aborted = results.filter((result) => result?.skipped).length;
  const completed = results.filter((result) => result && !result.skipped);
  const failures = completed.filter((result) => result.spawnError || result.signal || result.code !== 0);
  const duration = elapsed(startedAt);
  const skipped = pending.length + aborted;
  const slowest = [...completed].sort((a, b) => b.duration - a.duration).slice(0, 3);
  process.stdout.write(
    `Verification suite: ${completed.length - failures.length}/${commands.length} passed in ${formatDuration(duration)}`
      + `${skipped ? `, ${skipped} skipped after failure` : ''}\n`,
  );
  if (slowest.length) {
    process.stdout.write(`Slowest: ${slowest.map((item) => `${item.id} ${formatDuration(item.duration)}`).join(', ')}\n`);
  }
  return { ok: failures.length === 0, failures, results: completed, jobs, browserJobs, skipped, duration };
}

export async function runVerificationChecks(checks, options = {}) {
  if (!Array.isArray(checks) || checks.length === 0) {
    throw new Error('runVerificationChecks requires at least one check');
  }

  const baseUrl = options.baseUrl ?? import.meta.url;
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const jobs = parseJobCount(env.CHEOMA_CHECK_JOBS, checks.length);
  const startedAt = performance.now();
  const results = Array(checks.length);
  let nextIndex = 0;
  let stopped = false;

  const jobLabel = `${jobs} job${jobs === 1 ? '' : 's'}`;
  process.stdout.write(`Fast contracts: running ${checks.length} checks with ${jobLabel}\n`);

  async function worker() {
    while (!stopped && nextIndex < checks.length) {
      const index = nextIndex;
      nextIndex += 1;
      const result = await runChild(checks[index], baseUrl, cwd, env);
      results[index] = result;
      if (result.spawnError || result.signal || result.code !== 0) {
        stopped = true;
        process.stderr.write(
          `Fast contract failed: ${result.label} — ${statusFor(result)} (${formatDuration(result.duration)})\n`,
        );
      }
    }
  }

  await Promise.all(Array.from({ length: jobs }, () => worker()));

  for (const [index, result] of results.entries()) {
    if (!result) continue;
    const status = statusFor(result);
    process.stdout.write(
      `\n[${index + 1}/${checks.length}] ${result.label} — ${status} (${formatDuration(result.duration)})\n`,
    );
    writeBlock(process.stdout, result.stdout);
    writeBlock(process.stderr, result.stderr);
  }

  const completed = results.filter(Boolean);
  const failures = completed.filter((result) => (
    result.spawnError || result.signal || result.code !== 0
  ));
  const duration = elapsed(startedAt);
  const passed = completed.length - failures.length;
  const skipped = checks.length - completed.length;
  process.stdout.write(
    `\nFast contracts: ${passed}/${checks.length} passed in ${formatDuration(duration)} `
      + `(${jobLabel}${skipped ? `, ${skipped} skipped after failure` : ''})\n`,
  );

  return { ok: failures.length === 0, failures, results: completed, jobs, skipped, duration };
}
