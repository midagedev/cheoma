import { FAST_CHECKS } from './lib/fast-checks.mjs';
import { runVerificationChecks } from './lib/verification-runner.mjs';

const requested = process.argv.slice(2);
const checks = requested.length ? [...new Set(requested)] : ['./check-architecture.mjs'];
for (const check of checks) {
  if (!FAST_CHECKS.includes(check)) {
    throw new Error(`unknown browser-free contract: ${JSON.stringify(check)}`);
  }
}

const result = await runVerificationChecks(checks, { baseUrl: import.meta.url });
if (!result.ok) process.exitCode = 1;
