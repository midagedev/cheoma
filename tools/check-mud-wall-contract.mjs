import assert from 'node:assert/strict';
import {
  MUD_WALL_SURFACE_LIMITS,
  MUD_WALL_SURFACE_SCHEMA_VERSION,
  planMudWallSurface,
  validateMudWallSurfacePlan,
} from '../src/api/mud-wall-plan.js';

function assertDeepFrozen(value, label = 'plan') {
  if (!value || typeof value !== 'object') return;
  assert(Object.isFrozen(value), `${label} is mutable`);
  for (const [key, child] of Object.entries(value)) {
    assertDeepFrozen(child, `${label}.${key}`);
  }
}

const fixtureInput = {
  length: 7.4,
  height: 1.52,
  footHeight: 0.36,
  seed: 'mud-wall-contract',
};
let ambientRandomCalls = 0;
const ambientRandom = Math.random;
Math.random = () => {
  ambientRandomCalls++;
  return 0.123456789;
};
let fixture;
try {
  fixture = planMudWallSurface(fixtureInput);
} finally {
  Math.random = ambientRandom;
}

assert.equal(ambientRandomCalls, 0, 'pure mud-wall planning consumed ambient Math.random');
assert.equal(fixture.schema, MUD_WALL_SURFACE_SCHEMA_VERSION);
assert.deepEqual(fixture, planMudWallSurface(fixtureInput), 'same input changed the surface plan');
assertDeepFrozen(fixture);
assert.equal(validateMudWallSurfacePlan(fixture), fixture);
assert.deepEqual(
  validateMudWallSurfacePlan(JSON.parse(JSON.stringify(fixture))),
  fixture,
  'JSON round-trip changed the renderer boundary',
);

assert(fixture.lifts.length >= 2
  && fixture.lifts.length <= MUD_WALL_SURFACE_LIMITS.maxLifts,
'representative wall does not exercise bounded packed lifts');
assert.equal(fixture.joints.length, fixture.lifts.length - 1);
assert(fixture.fibres.length > 0
  && fixture.fibres.length <= MUD_WALL_SURFACE_LIMITS.maxFibresPerFace * 2);
assert.equal(fixture.damp.length, 2);
assert(fixture.damp.every((profile) =>
  profile.points.length <= MUD_WALL_SURFACE_LIMITS.maxDampPointsPerFace));
assert(fixture.joints.every((joint) =>
  joint.depth >= 0 && joint.depth <= MUD_WALL_SURFACE_LIMITS.maxDetailDepth));
assert(fixture.joints.every((joint) =>
  Math.abs(joint.tilt) * 0.5 + Math.abs(joint.wave)
    <= MUD_WALL_SURFACE_LIMITS.maxJointDrift));
assert(fixture.fibres.every((fibre) =>
  fibre.depth >= 0 && fibre.depth <= MUD_WALL_SURFACE_LIMITS.maxDetailDepth));
assert(fixture.damp.every((profile) =>
  profile.depth >= 0 && profile.depth <= MUD_WALL_SURFACE_LIMITS.maxDetailDepth));

const compact = planMudWallSurface({
  length: 0.28,
  height: 0.34,
  footHeight: 0.1,
  seed: 9,
});
assert.equal(compact.fibres.length, 0);
assert.equal(compact.damp.length, 0);
assert.equal(validateMudWallSurfacePlan(compact), compact);

const long = planMudWallSurface({
  length: 1000,
  height: 100,
  footHeight: 0.1,
  seed: 9,
});
assert.equal(long.lifts.length, MUD_WALL_SURFACE_LIMITS.maxLifts);
assert.equal(long.joints.length, MUD_WALL_SURFACE_LIMITS.maxJoints);
assert.equal(long.fibres.length, MUD_WALL_SURFACE_LIMITS.maxFibresPerFace * 2);
assert(long.damp.every((profile) =>
  profile.points.length === MUD_WALL_SURFACE_LIMITS.maxDampPointsPerFace));

const malformed = JSON.parse(JSON.stringify(fixture));
malformed.fibres[0].depth = MUD_WALL_SURFACE_LIMITS.maxDetailDepth + 0.001;
assert.throws(
  () => validateMudWallSurfacePlan(malformed),
  /maxDetailDepth/,
  'outward or unbounded relief crossed the public validation boundary',
);

console.log(
  `MUD WALL CONTRACT: PASS (schema v${fixture.schema}, `
  + `${fixture.lifts.length} lifts/${fixture.joints.length} joints/`
  + `${fixture.fibres.length} fibres/${fixture.damp.length} damp faces, `
  + `caps ${long.lifts.length}/${long.fibres.length}/${long.damp[0].points.length})`,
);
