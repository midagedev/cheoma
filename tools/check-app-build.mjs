import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const outDir = await mkdtemp(join(tmpdir(), 'cheoma-production-build-'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const started = performance.now();

try {
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(npm, [
      '--prefix', 'app', 'run', 'build', '--', '--outDir', outDir, '--emptyOutDir',
    ], { stdio: 'inherit', env: process.env });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (signal) reject(new Error(`production build terminated by ${signal}`));
      else resolve(code ?? 1);
    });
  });
  if (exitCode !== 0) throw new Error(`production build failed with exit ${exitCode}`);
  console.log(`APP BUILD: PASS (${((performance.now() - started) / 1000).toFixed(1)}s, isolated outDir)`);
} finally {
  await rm(outDir, { recursive: true, force: true });
}
