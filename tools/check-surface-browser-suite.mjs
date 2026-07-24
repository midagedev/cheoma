import { spawn } from 'node:child_process';

if (process.env.CHEOMA_BROWSER_LOCK_HELD !== '1') {
  throw new Error('check-surface-browser-suite must run through npm run check:surface:browser');
}

const checks = [
  ['packed-earth road surface', 'tools/check-surface-materials-browser.mjs'],
  ['physical mud-wall surface', 'tools/shoot-mud-wall.mjs'],
  ['physical roadside drainage', 'tools/shoot-drainage.mjs'],
];

for (const [label, script] of checks) {
  console.log(`surface-browser suite: ${label}`);
  const child = spawn(process.execPath, [script], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  });
  const result = await new Promise((resolve) => {
    child.on('error', (error) => resolve({ error }));
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`${label} terminated by ${result.signal}`);
  if (result.code !== 0) {
    process.exitCode = result.code ?? 1;
    break;
  }
}

if (!process.exitCode) console.log('SURFACE BROWSER SUITE: PASS');
