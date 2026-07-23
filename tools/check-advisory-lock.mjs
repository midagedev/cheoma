import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireAdvisoryLock,
  acquireAdvisoryLockSync,
  tryAcquireAdvisoryLock,
} from './lib/advisory-lock.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'cheoma-advisory-lock-'));
const path = join(scratch, 'browser.lock');

try {
  const first = acquireAdvisoryLockSync(path, { label: 'first' });
  assert.equal(tryAcquireAdvisoryLock(path, 'second').acquired, false);
  await assert.rejects(
    acquireAdvisoryLock(path, { label: 'second', timeoutMs: 10, pollMs: 2 }),
    /timed out/,
  );
  first.release();
  first.release();
  const second = acquireAdvisoryLockSync(path, { label: 'second' });
  second.release();

  const deadPid = 99_999_999;
  const deadToken = '00000000-0000-4000-8000-000000000000';
  mkdirSync(path);
  writeFileSync(join(path, 'owner.json'), `${JSON.stringify({ pid: deadPid, token: deadToken })}\n`);
  const recoveredOwner = acquireAdvisoryLockSync(path, { label: 'dead-owner recovery' });
  recoveredOwner.release();

  mkdirSync(path);
  writeFileSync(
    join(path, `.reclaim-${deadPid}-${deadToken}.json`),
    `${JSON.stringify({ pid: deadPid, token: deadToken })}\n`,
  );
  const recoveredReclaimer = acquireAdvisoryLockSync(path, { label: 'dead-reclaimer recovery' });
  recoveredReclaimer.release();
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log('ADVISORY LOCK: PASS (contention, timeout, token-safe idempotent release)');
