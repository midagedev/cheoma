import { spawn } from 'node:child_process';

// package.json acquires the shared browser lane once around this suite. Invoke
// the constituent harnesses directly: wrapping any child in
// run-browser-locked.mjs would try to acquire the same advisory lock again.
if (process.env.CHEOMA_BROWSER_LOCK_HELD !== '1') {
  throw new Error('check-api-reuse-suite must run through npm run check:api-reuse');
}

const checks = [
  {
    label: 'standalone building API',
    args: ['tools/check-api-reuse-example.mjs'],
  },
  {
    label: 'standalone sijeon API',
    // One representative PBR street frame is enough here; shoot:sijeon remains
    // the manual six-frame art matrix.
    args: ['tools/shoot-sijeon.mjs', 'street-day'],
  },
  {
    label: 'product sijeon camera',
    args: ['tools/shoot-sijeon-app.mjs'],
  },
];

for (const check of checks) {
  console.log(`api-reuse suite: ${check.label}`);
  const child = spawn(process.execPath, check.args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  });
  const result = await new Promise((resolve) => {
    child.on('error', (error) => resolve({ error }));
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
  if (result.error) throw result.error;
  if (result.signal) {
    throw new Error(`${check.label} terminated by ${result.signal}`);
  }
  if (result.code !== 0) {
    process.exitCode = result.code ?? 1;
    break;
  }
}

if (!process.exitCode) console.log('API REUSE SUITE: PASS');
