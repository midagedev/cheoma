import { spawn } from 'node:child_process';

// package.json owns the shared browser lane once around both proofs. Running the
// child harnesses directly avoids trying to acquire the same advisory lock twice.
if (process.env.CHEOMA_BROWSER_LOCK_HELD !== '1') {
  throw new Error(
    'check-yard-life-browser must run through npm run check:yard-life:browser',
  );
}

const checks = [
  {
    label: 'reusable renderer',
    args: ['tools/shoot-yard-life.mjs'],
  },
  {
    label: 'product camera and LOD',
    args: ['tools/shoot-yard-life-app.mjs'],
  },
];

for (const check of checks) {
  console.log(`yard-life browser suite: ${check.label}`);
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

if (!process.exitCode) console.log('YARD LIFE BROWSER SUITE: PASS');
