// 에이전트가 코드 변경 직후 돌리는 네트워크·브라우저 없는 빠른 게이트.
//
// 게이트 대축소(2026-08-02, 사용자 지시): 기본 실행은 CORE_CHECKS(불변식 3종)만 돈다 —
// 커밋·CI 를 막는 것은 이것뿐이다. `--deep` 은 종전 전체 목록(FAST_CHECKS)을 돌리는
// opt-in 이며, 기능 라운드는 check:pr(영향 라우팅) 또는 개별 게이트를 쓴다.
import { runVerificationChecks } from './lib/verification-runner.mjs';
import { CORE_CHECKS, FAST_CHECKS } from './lib/fast-checks.mjs';

const deep = process.argv.includes('--deep');
const result = await runVerificationChecks(deep ? FAST_CHECKS : CORE_CHECKS, { baseUrl: import.meta.url });
if (!result.ok) process.exitCode = 1;
