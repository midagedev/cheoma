// Pure contract for viral clip stages (#255–#260). No browser.
import assert from 'node:assert/strict';
import {
  CLIP_STAGE_IDS,
  CLIP_STAGES,
  buildClipStageUrl,
  clipStageFor,
  clipStageQuery,
  normalizeClipStageId,
} from '../src/api/clip-stage.js';

assert.deepEqual(
  CLIP_STAGE_IDS.slice().sort(),
  ['aerial', 'assemble', 'ink', 'night', 'yard'],
  'clip stage id set drifted',
);
assert.ok(Object.isFrozen(CLIP_STAGES) && CLIP_STAGE_IDS.every((id) => Object.isFrozen(CLIP_STAGES[id])));

for (const id of CLIP_STAGE_IDS) {
  const stage = CLIP_STAGES[id];
  assert.equal(stage.id, id);
  assert.equal(normalizeClipStageId(id), id);
  assert.equal(normalizeClipStageId(id.toUpperCase()), id);
  assert.equal(clipStageFor(id), stage);
  assert.ok(Number.isFinite(stage.seed) && stage.seed === 7, `${id} seed must pin fixture 7`);
  assert.ok(Number.isFinite(stage.vseed) && stage.vseed === 7, `${id} vseed must pin fixture 7`);
  assert.ok(['hero', 'village-aerial', 'village-focus'].includes(stage.boot), `${id} boot unknown`);
  assert.equal(typeof stage.autoEnter, 'boolean');
  const q = clipStageQuery(id);
  assert.equal(q.clip, id);
  assert.equal(q.seed, '7');
  assert.equal(q.time, stage.time);
  if (stage.boot !== 'hero') assert.equal(q.village, '1');
  if (stage.renderStyle === 'ink') assert.equal(q.mode, 'ink');
  const url = buildClipStageUrl('https://cheoma.midagedev.com/', id);
  assert.ok(url.includes(`clip=${id}`), `${id} url missing clip key`);
  assert.ok(url.includes('seed=7'), `${id} url missing seed`);
}

assert.equal(normalizeClipStageId('nope'), null);
assert.equal(clipStageFor(null), null);
assert.equal(clipStageQuery('nope'), null);
assert.equal(buildClipStageUrl('https://example.com/', 'nope'), null);

// Assemble is the flagship high-원 path.
assert.equal(CLIP_STAGES.assemble.boot, 'hero');
assert.equal(CLIP_STAGES.assemble.time, 'sunset');
assert.equal(CLIP_STAGES.assemble.renderStyle, 'pbr');
// Yard focuses a residential parcel under sunset DoF.
assert.equal(CLIP_STAGES.yard.boot, 'village-focus');
assert.ok(CLIP_STAGES.yard.parcelId);
// Night is a separate time; ink is a separate render style (never mixed into assemble).
assert.equal(CLIP_STAGES.night.time, 'night');
assert.equal(CLIP_STAGES.ink.renderStyle, 'ink');
assert.notEqual(CLIP_STAGES.ink.time, CLIP_STAGES.assemble.time);

console.log(`CLIP STAGE: PASS (${CLIP_STAGE_IDS.length} stages, seed-7 fixtures, query builders)`);
