import { spawn } from 'node:child_process';
import { acquireAdvisoryLock, gitCommonLockPath } from './lib/advisory-lock.mjs';

const args = process.argv.slice(2);
if (args[0] === '--') args.shift();
if (!args.length) throw new Error('Usage: node tools/run-browser-locked.mjs -- <command> [args...]');

let lock = null;
if (process.env.CHEOMA_BROWSER_LOCK_HELD !== '1') {
  lock = await acquireAdvisoryLock(gitCommonLockPath(process.cwd(), 'browser.lock'), {
    label: `direct browser command: ${args.join(' ')}`,
  });
}

const child = spawn(args[0], args.slice(1), {
  env: { ...process.env, CHEOMA_BROWSER_LOCK_HELD: '1' },
  stdio: 'inherit',
});
const result = await new Promise((resolve) => {
  child.on('error', (error) => resolve({ error }));
  child.on('exit', (code, signal) => resolve({ code, signal }));
});

try { lock?.release(); }
catch (error) {
  console.error(`browser lock release failed: ${error.message}`);
  process.exitCode = 1;
}
if (result.error) throw result.error;
if (result.signal) {
  console.error(`browser command terminated by ${result.signal}`);
  process.exitCode = 1;
} else if (result.code !== 0) {
  process.exitCode = result.code ?? 1;
}
