// 에이전트가 코드 변경 직후 돌리는 네트워크·브라우저 없는 빠른 게이트.
import { runVerificationChecks } from './lib/verification-runner.mjs';
import { FAST_CHECKS } from './lib/fast-checks.mjs';

const result = await runVerificationChecks(FAST_CHECKS, { baseUrl: import.meta.url });
if (!result.ok) process.exitCode = 1;
