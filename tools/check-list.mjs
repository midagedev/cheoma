import { ALL_PROFILE, FULL_PROFILE, VERIFICATION_GATES } from './lib/verification-gates.mjs';

console.log('id'.padEnd(24), 'tier'.padEnd(12), 'resource'.padEnd(10), 'npm script / purpose');
for (const [id, gate] of Object.entries(VERIFICATION_GATES)) {
  console.log(
    id.padEnd(24),
    gate.tier.padEnd(12),
    gate.resource.padEnd(10),
    `${gate.script} — ${gate.description}`,
  );
}
console.log(`\ncheck:all  ${ALL_PROFILE.join(', ')}`);
console.log(`check:full ${FULL_PROFILE.join(', ')}`);
