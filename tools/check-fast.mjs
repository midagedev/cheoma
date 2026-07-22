// 에이전트가 코드 변경 직후 돌리는 네트워크·브라우저 없는 빠른 게이트.
import { runVerificationChecks } from './lib/verification-runner.mjs';

const checks = [
  './check-architecture.mjs',
  './check-residential-openings.mjs',
  './check-atmosphere-contract.mjs',
  './check-environment-state.mjs',
  './check-house-diversity.mjs',
  './check-opening-detail-contract.mjs',
  './check-threshold-life-contract.mjs',
  './check-door-motion-contract.mjs',
  './check-door-occlusion-contract.mjs',
  './check-building-clearance.mjs',
  './check-cinematic-turns.mjs',
  './check-cinematic-reveal.mjs',
  './check-dof.mjs',
  './check-dancheong-contract.mjs',
  './check-plan-contract.mjs',
  './check-temple-contract.mjs',
  './check-road-contract.mjs',
  './check-surface-materials.mjs',
  './check-layout-contract.mjs',
  './check-wall-gate-contract.mjs',
  './check-wave-contract.mjs',
  './check-yard-layout-contract.mjs',
  './check-parcel-rebuild-contract.mjs',
  './check-live-edit-scheduler.mjs',
  './check-shader-warm.mjs',
  './check-shadow-framing.mjs',
  './check-directional-shadow-runtime.mjs',
  './check-lod.mjs',
  './check-citywall.mjs',
  './check-choga-roof.mjs',
  './check-roof-seams.mjs',
  './check-verification-plan.mjs',
  './check-verification-browser.mjs',
];

const result = await runVerificationChecks(checks, { baseUrl: import.meta.url });
if (!result.ok) process.exitCode = 1;
