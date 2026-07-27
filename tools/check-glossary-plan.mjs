// Pure focus glossary anchor contract (#216).
// Browser-free: plan is Three/DOM-free; layout comes from computeLayout.
import assert from 'node:assert/strict';
import {
  GLOSSARY_DISCLAIMER_KO,
  GLOSSARY_LABEL_IDS,
  GLOSSARY_SCHEMA_VERSION,
  glossaryHasBrackets,
  glossaryLocalToWorld,
  glossaryRoofCover,
  isGlossarySubject,
  planGlossaryAnchors,
} from '../src/api/glossary-plan.js';
// params.js is Three-free; do not import api/building (builder graph pulls three).
import { PRESETS, computeLayout } from '../src/params.js';

const EPS = 1e-6;

assert.equal(GLOSSARY_SCHEMA_VERSION, 1);
assert.equal(GLOSSARY_DISCLAIMER_KO, '제품 해석 · 실측 복원 아님');
assert.ok(GLOSSARY_LABEL_IDS.includes('eave') && GLOSSARY_LABEL_IDS.includes('bracket'));

// ── Subject eligibility ────────────────────────────────────────────────────
assert.equal(isGlossarySubject(null), false);
assert.equal(isGlossarySubject({ family: 'palace-compound' }), false);
assert.equal(isGlossarySubject({ family: 'temple' }), false);
assert.equal(isGlossarySubject({ family: 'mja', kind: 'giwa' }), false);
assert.equal(isGlossarySubject({ mjaHouse: true, kind: 'giwa' }), false);
assert.equal(isGlossarySubject({ kind: 'giwa', family: 'regular' }), true);
assert.equal(isGlossarySubject({ kind: 'choga', family: 'regular' }), true);
assert.equal(isGlossarySubject({ hero: true, heroStyle: 'hanok', kind: 'giwa' }), true);
assert.equal(isGlossarySubject({ hero: true, heroStyle: 'palace', kind: 'korea' }), true);

assert.equal(glossaryHasBrackets({ kind: 'giwa', family: 'regular' }), false);
assert.equal(glossaryHasBrackets({ kind: 'choga', family: 'regular' }), false);
assert.equal(glossaryHasBrackets({ hero: true, heroStyle: 'hanok' }), false);
assert.equal(glossaryHasBrackets({ hero: true, heroStyle: 'palace' }), true);

assert.equal(glossaryRoofCover({ kind: 'choga', family: 'regular' }), 'thatch');
assert.equal(glossaryRoofCover({ kind: 'giwa', family: 'regular' }), 'tile');
assert.equal(glossaryRoofCover({ hero: true, heroStyle: 'hanok', kind: 'giwa' }), 'tile');

// ── Layout-backed plans ────────────────────────────────────────────────────
function planFor(kind, flags = {}) {
  const layout = computeLayout({ ...PRESETS[kind], style: kind });
  return planGlossaryAnchors({
    layout,
    hasBrackets: flags.hasBrackets === true,
    roofCover: flags.roofCover || (kind === 'choga' ? 'thatch' : 'tile'),
  });
}

const giwa = planFor('giwa');
const choga = planFor('choga');
const palace = planGlossaryAnchors({
  layout: computeLayout({ ...PRESETS.korea, style: 'palace' }),
  hasBrackets: true,
  roofCover: 'tile',
});

for (const [name, plan] of [['giwa', giwa], ['choga', choga], ['palace', palace]]) {
  assert.ok(plan, `${name} plan null`);
  assert.ok(Object.isFrozen(plan) && Object.isFrozen(plan.labels), `${name} not frozen`);
  assert.equal(plan.disclaimer, GLOSSARY_DISCLAIMER_KO, `${name} disclaimer`);
  assert.ok(plan.labels.length >= 3 && plan.labels.length <= 8, `${name} count ${plan.labels.length}`);
  assert.doesNotThrow(() => JSON.stringify(plan), `${name} not JSON-safe`);
  const ids = plan.labels.map((label) => label.id);
  assert.ok(ids.includes('eave'), `${name} missing eave`);
  assert.ok(ids.includes('ridge'), `${name} missing ridge`);
  assert.ok(ids.includes('podium'), `${name} missing podium`);
  assert.ok(ids.includes('changho'), `${name} missing changho`);
  for (const label of plan.labels) {
    assert.ok(Object.isFrozen(label) && Object.isFrozen(label.local), `${name}.${label.id} not frozen`);
    assert.ok(
      Number.isFinite(label.local.x) && Number.isFinite(label.local.y) && Number.isFinite(label.local.z),
      `${name}.${label.id} nonfinite`,
    );
  }
  // Byte-stable for identical layout input.
  const again = planGlossaryAnchors({
    layout: computeLayout({ ...PRESETS[name === 'palace' ? 'korea' : name], style: name === 'palace' ? 'palace' : name }),
    hasBrackets: name === 'palace',
    roofCover: name === 'choga' ? 'thatch' : 'tile',
  });
  assert.equal(JSON.stringify(plan), JSON.stringify(again), `${name} not byte-stable`);
}

assert.ok(giwa.labels.some((l) => l.id === 'changbang'), 'giwa mindori needs 창방');
assert.ok(!giwa.labels.some((l) => l.id === 'bracket'), 'giwa must not label 공포');
assert.ok(giwa.labels.some((l) => l.id === 'giwa'), 'giwa roof cover');
assert.ok(choga.labels.some((l) => l.id === 'ieung'), 'choga roof cover 이엉');
assert.ok(!choga.labels.some((l) => l.id === 'giwa'), 'choga must not label 기와');
assert.ok(palace.labels.some((l) => l.id === 'bracket'), 'palace needs 공포');
assert.ok(palace.labels.some((l) => l.id === 'rafter'), 'palace needs 서까래 slot');
assert.ok(!palace.labels.some((l) => l.id === 'changbang'), 'palace uses 서까래 not 창방');

// Vertical stack: podium < changho < eave ≤ ridge (teaching points stay ordered).
function yOf(plan, id) {
  return plan.labels.find((label) => label.id === id)?.local.y;
}
assert.ok(yOf(giwa, 'podium') < yOf(giwa, 'changho'), 'podium below 창호');
assert.ok(yOf(giwa, 'changho') < yOf(giwa, 'eave'), '창호 below 처마');
assert.ok(yOf(giwa, 'eave') <= yOf(giwa, 'ridge') + EPS, '처마 not above 용마루');
assert.ok(yOf(palace, 'bracket') > yOf(palace, 'podium'), '공포 above 기단');

// ── Pure world transform (chime/houseMatrix order) ─────────────────────────
const parcel = {
  center: { x: 100, z: -40 },
  baseY: 3,
};
const local = { x: 1, y: 2, z: 0 };
const world = glossaryLocalToWorld(local, parcel, {
  sx: 1, sy: 1, sz: 1, mirrorX: 1, houseLocalX: 0, houseLocalZ: 0, rotY: 0,
});
assert.ok(world);
assert.ok(Math.abs(world.x - 101) < EPS && Math.abs(world.y - 5) < EPS && Math.abs(world.z - (-40)) < EPS);

const flipped = glossaryLocalToWorld(local, parcel, {
  sx: 1, sy: 1, sz: 1, mirrorX: -1, houseLocalX: 2, houseLocalZ: 1, rotY: Math.PI / 2,
});
assert.ok(flipped);
assert.ok(Number.isFinite(flipped.x) && Number.isFinite(flipped.y) && Number.isFinite(flipped.z));

// Fail closed on bad layout.
assert.equal(planGlossaryAnchors({ layout: null }), null);
assert.equal(planGlossaryAnchors({ layout: { W: 1 } }), null);

console.log('check-glossary-plan: ok');
