import assert from 'node:assert/strict';
import { planOpeningDetail } from '../src/api/opening-detail.js';
import { planThresholdLife } from '../src/api/threshold-life.js';

const opening = (style, overrides = {}) => planOpeningDetail({
  kind: 'door',
  style,
  width: style === 'choga' ? 0.9 : 1.9,
  height: 1.8,
  wallThickness: style === 'choga' ? 0.06 : 0.13,
  primary: true,
  seed: 17,
  footwear: {
    y: 0.4,
    outward: style === 'choga' ? 0.3 : 0.78,
    surface: style === 'choga' ? 'jjokmaru' : 'toenmaru',
    clearSide: style === 'giwa' ? 1 : null,
  },
  ...overrides,
});

const randomBefore = Math.random;
const dry = planThresholdLife({ opening: opening('choga'), seed: 91, condition: 'dry' });
const wet = planThresholdLife({ opening: opening('giwa'), seed: 91, condition: 'wet' });
assert.equal(Math.random, randomBefore, 'threshold plan replaced global Math.random');
assert.equal(dry.kind, 'jipsin');
assert.equal(wet.kind, 'namaksin');
assert.equal(dry.items.length, 2);
assert.equal(wet.items.length, 2);
assert.equal(dry.visibility.tier, 'focus');
assert.equal(dry.visibility.owner, 'focus-overlay');
assert.equal(dry.surface, 'jjokmaru');
assert.equal(wet.clearance.placementSide, 1,
  'giwa threshold life ignored its authored railing-free landing side');

for (const plan of [dry, wet]) {
  assert.ok(Object.isFrozen(plan) && Object.isFrozen(plan.items)
    && Object.isFrozen(plan.placement)
    && plan.items.every((item) => Object.isFrozen(item) && Object.isFrozen(item.bounds)),
  `${plan.kind} plan is not deeply frozen`);
  assert.doesNotThrow(() => JSON.stringify(plan));
  assert.ok(plan.clearance.threshold > 0.005, `${plan.kind} clips threshold`);
  assert.ok(plan.clearance.approach > 0.04, `${plan.kind} blocks clear opening`);
  assert.ok(plan.clearance.jamb > 0.04, `${plan.kind} crossed its selected jamb`);
  for (const item of plan.items) {
    assert.ok(item.length >= 0.22 && item.length <= 0.28, `${plan.kind} length lost human scale`);
    assert.ok(item.width >= 0.07 && item.width <= 0.115, `${plan.kind} width lost human scale`);
    assert.equal(item.y, 0.4, `${plan.kind} lost authored landing contact`);
    if (plan.clearance.placementSide < 0) {
      assert.ok(item.bounds.uMax < plan.clearance.jambU - 0.04, `${plan.kind} crossed the selected jamb`);
    } else {
      assert.ok(item.bounds.uMin > plan.clearance.jambU + 0.04, `${plan.kind} crossed the selected jamb`);
    }
  }
}

const signatureBaseOpening = opening('giwa', { width: 1.662, height: 1.8 });
const signatureWidthOpening = opening('giwa', { width: 2.245, height: 1.8 });
assert.equal(signatureBaseOpening.id, signatureWidthOpening.id,
  'signature fixture no longer reproduces one seed across a width/topology change');
const signatureBase = planThresholdLife({ opening: signatureBaseOpening, seed: 91 });
const signatureSamePlacement = planThresholdLife({
  opening: opening('giwa', { width: 1.662, height: 2.1 }), seed: 91,
});
const signatureWidth = planThresholdLife({ opening: signatureWidthOpening, seed: 91 });
const signatureSurface = planThresholdLife({
  opening: opening('giwa', {
    width: 1.662,
    footwear: { y: 0.4, outward: 0.78, surface: 'podium-step' },
  }),
  seed: 91,
});
assert.equal(signatureBase.placement.signature, signatureSamePlacement.placement.signature,
  'irrelevant opening height disabled safe preview reuse');
assert.notEqual(signatureBase.placement.signature, signatureWidth.placement.signature,
  'door width/topology change retained stale footwear placement');
assert.notEqual(signatureBase.placement.signature, signatureSurface.placement.signature,
  'landing surface change retained stale footwear placement');
const oppositeLanding = planThresholdLife({
  opening: opening('giwa', {
    width: 1.662,
    footwear: { y: 0.4, outward: 0.78, surface: 'toenmaru', clearSide: -1 },
  }),
  seed: 91,
});
assert.equal(oppositeLanding.clearance.placementSide, -1,
  'negative local landing guidance was replaced by a style-wide side');
assert(oppositeLanding.items.every((item) => item.bounds.uMax < oppositeLanding.clearance.jambU),
  'negative local landing guidance left footwear across its selected jamb');
assert.notEqual(signatureBase.placement.signature, oppositeLanding.placement.signature,
  'landing-side change retained stale footwear placement');

const seedA = { household: 3, nested: { wet: true }, bigint: 9n };
const seedB = { bigint: 9n, nested: { wet: true }, household: 3 };
const stableA = planThresholdLife({ opening: opening('giwa'), seed: seedA, condition: 'wet' });
const stableB = planThresholdLife({ opening: opening('giwa'), seed: seedB, condition: 'wet' });
assert.deepEqual(stableA, stableB, 'object key order changed threshold variation');
assert.equal(seedA.bigint, 9n, 'planner mutated caller seed');

const cyclic = { name: 'house' };
cyclic.self = cyclic;
assert.doesNotThrow(() => JSON.stringify(planThresholdLife({
  opening: opening('choga'), seed: cyclic,
})));

assert.equal(planThresholdLife({ opening: opening('giwa', { primary: false }) }), null);
assert.equal(planThresholdLife({ opening: planOpeningDetail({
  kind: 'window', style: 'giwa', width: 1, height: 0.7,
}) }), null);
assert.equal(planThresholdLife({ opening: opening('palace') }), null);

console.log('THRESHOLD LIFE CONTRACT: PASS');
