import { spawn } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { performance } from 'node:perf_hooks';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

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
