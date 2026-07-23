import { ALL_PROFILE, FULL_PROFILE, gateCommand } from './lib/verification-gates.mjs';
import { runCommandSuite } from './lib/verification-runner.mjs';

const args = new Set(process.argv.slice(2));
const full = args.has('--full');
const all = args.has('--all');
const serial = args.has('--serial');
if (full === all || [...args].some((arg) => !['--full', '--all', '--serial'].includes(arg))) {
  throw new Error('Usage: node tools/check-suite.mjs (--all | --full) [--serial]');
}

const profile = full ? FULL_PROFILE : ALL_PROFILE;
const result = await runCommandSuite(
  profile.map(gateCommand),
  serial ? { jobs: 1, browserJobs: 1 } : {},
);
if (!result.ok) process.exitCode = 1;
