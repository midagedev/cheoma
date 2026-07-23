import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VERIFICATION_GATES } from './lib/verification-gates.mjs';
import { acquireAdvisoryLockSync } from './lib/advisory-lock.mjs';
import { runCommandSuite } from './lib/verification-runner.mjs';

for (const id of [
  'app', 'ink-app', 'petals', 'winter-app', 'worker', 'audio', 'temple-browser',
  'dof-app', 'rim', 'lod-focus', 'lod-wave', 'lod-app', 'parcel-rebuild-browser',
  'surface-browser', 'cinematic-app',
]) {
  assert.equal(VERIFICATION_GATES[id].resource, 'browser', `${id} must stay in the browser lane`);
}
assert.equal(VERIFICATION_GATES['bokeh-fixture'].resource, 'exclusive');

const packageScripts = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).scripts;
const lockedScripts = new Set([
  ...Object.values(VERIFICATION_GATES)
    .filter((gate) => ['browser', 'exclusive'].includes(gate.resource))
    .map((gate) => gate.script),
  ...Object.keys(packageScripts).filter((name) => name.startsWith('shoot:')),
  'check:residential-edit-url:browser', 'check:dancheong:browser',
  'check:dancheong:app', 'check:live-edit:browser',
]);
for (const script of lockedScripts) {
  assert.match(
    packageScripts[script],
    /^node tools\/run-browser-locked\.mjs -- /,
    `${script} must take the shared browser lock`,
  );
}

const scratch = mkdtempSync(join(tmpdir(), 'cheoma-runner-contract-'));
const lock = join(scratch, 'browser.lock');
const browserScript = [
  'const fs=require("node:fs");',
  'const lock=process.argv[1];',
  'try{fs.mkdirSync(lock);}catch{process.exit(9);}',
  'setTimeout(()=>{fs.rmdirSync(lock);},60);',
].join('');

try {
  const result = await runCommandSuite([
    { id: 'browser-a', command: process.execPath, args: ['-e', browserScript, lock], resource: 'browser' },
    { id: 'cpu', command: process.execPath, args: ['-e', 'setTimeout(()=>{},40)'], resource: 'cpu' },
    { id: 'browser-b', command: process.execPath, args: ['-e', browserScript, lock], resource: 'browser' },
  ], {
    jobs: 2,
    browserJobs: 1,
    sharedBrowserLockPath: join(scratch, 'local-browser.lock'),
  });
  assert.equal(result.ok, true);
  assert.equal(result.results.length, 3);
  assert.equal(result.browserJobs, 1);

  const sharedLock = join(scratch, 'shared-browser.lock');
  const crossProcessSentinel = join(scratch, 'cross-suite.lock');
  const [suiteA, suiteB] = await Promise.all(['a', 'b'].map((id) => runCommandSuite([
    {
      id: `cross-${id}`,
      command: process.execPath,
      args: ['-e', browserScript, crossProcessSentinel],
      resource: 'browser',
    },
  ], { jobs: 1, browserJobs: 1, sharedBrowserLockPath: sharedLock })));
  assert.equal(suiteA.ok, true);
  assert.equal(suiteB.ok, true);

  const abortLockPath = join(scratch, 'abort-browser.lock');
  const abortSentinel = join(scratch, 'browser-must-not-run');
  const held = acquireAdvisoryLockSync(abortLockPath, { label: 'external browser' });
  const aborted = await runCommandSuite([
    { id: 'fast-fail', command: process.execPath, args: ['-e', 'process.exit(4)'], resource: 'cpu' },
    {
      id: 'waiting-browser',
      command: process.execPath,
      args: ['-e', 'require("node:fs").writeFileSync(process.argv[1], "ran")', abortSentinel],
      resource: 'browser',
    },
  ], { jobs: 2, browserJobs: 1, sharedBrowserLockPath: abortLockPath });
  held.release();
  assert.equal(aborted.ok, false);
  assert.equal(aborted.skipped, 1);
  assert.equal(existsSync(abortSentinel), false);

  const damagedLockPath = join(scratch, 'damaged-release.lock');
  const damaged = await runCommandSuite([{
    id: 'damaged-release',
    command: process.execPath,
    args: ['-e', 'require("node:fs").unlinkSync(process.argv[1])', join(damagedLockPath, 'owner.json')],
    resource: 'browser',
  }], { jobs: 1, browserJobs: 1, sharedBrowserLockPath: damagedLockPath });
  assert.equal(damaged.ok, false);
  assert.match(damaged.failures[0].spawnError.message, /owner\.json/);

  const failed = await runCommandSuite([
    { id: 'fail', command: process.execPath, args: ['-e', 'process.exit(3)'], resource: 'cpu' },
    { id: 'never', command: process.execPath, args: ['-e', 'process.exit(0)'], resource: 'cpu' },
  ], { jobs: 1, browserJobs: 1 });
  assert.equal(failed.ok, false);
  assert.equal(failed.skipped, 1);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log('VERIFICATION RUNNER: PASS (bounded browser lane, CPU overlap, fail-fast)');
