// Renderer-free changho grammar: deterministic dimensions, hierarchy and future
// interaction/footwear anchors without THREE, DOM or global RNG.
import { OPENING_FACE_CLEARANCE } from '../src/core/surface-clearance.js';
import {
  OPENING_DETAIL_STYLES,
  planOpeningDetail,
} from '../src/api/opening-detail.js';

const EPS = 1e-9;
function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

const input = {
  kind: 'door', style: 'giwa', seed: 'contract:17',
  width: 1.72, height: 2.04, wallThickness: 0.13,
  lowerPanelHeight: 0.42, primary: true, leafOutward: 0.035,
  footwear: { y: 0.4, outward: 0.78, surface: 'toenmaru', clearSide: -1 },
};
Object.freeze(input.footwear);
Object.freeze(input);
const inputSnapshot = JSON.stringify(input);

const originalRandom = Math.random;
let randomCalls = 0;
Math.random = () => { randomCalls++; throw new Error('opening plan consumed global RNG'); };
let first;
try {
  first = planOpeningDetail(input);
} finally {
  Math.random = originalRandom;
}
const second = planOpeningDetail(input);
invariant(randomCalls === 0, 'opening plan touched global Math.random');
invariant(JSON.stringify(input) === inputSnapshot, 'opening plan mutated caller input');
invariant(JSON.stringify(first) === JSON.stringify(second), 'same opening seed is not byte-stable');
invariant(Object.isFrozen(first) && Object.isFrozen(first.frame.parts), 'opening plan is mutable');
invariant(Object.isFrozen(first.anchors) && Object.isFrozen(first.anchors.focus),
  'primary focus anchor is mutable');
const differentSeed = planOpeningDetail({ ...input, seed: 'contract:18' });
invariant(first.id !== differentSeed.id,
  'opening seed does not reach stable identity');
invariant(JSON.stringify(first.anchors.focus) === JSON.stringify(differentSeed.anchors.focus),
  'semantic focus anchor depends on the cosmetic opening seed');

const objectSeed = Object.freeze({
  z: 19n,
  nested: Object.freeze({ tone: 'pine', values: Object.freeze([3, 1]) }),
});
const nonJsonFootwear = Object.freeze({ y: 0.4, outward: 0.78, surface: 17n });
const objectSeedPlan = planOpeningDetail({
  ...input,
  seed: objectSeed,
  footwear: nonJsonFootwear,
});
const reorderedSeedPlan = planOpeningDetail({
  ...input,
  seed: { nested: { values: [3, 1], tone: 'pine' }, z: 19n },
});
invariant(typeof objectSeedPlan.seed === 'string', 'non-JSON seed was not normalized');
invariant(JSON.stringify(objectSeedPlan).includes(objectSeedPlan.seed),
  'normalized opening plan is not JSON-safe');
invariant(objectSeedPlan.anchors.footwear.surface === 'threshold',
  'non-string footwear surface escaped into the JSON-safe result');
invariant(objectSeedPlan.id === reorderedSeedPlan.id,
  'equivalent object seeds depend on property insertion order');
invariant(objectSeed.z === 19n && objectSeed.nested.tone === 'pine',
  'opening plan mutated an object seed owned by the caller');
invariant(nonJsonFootwear.surface === 17n, 'opening plan mutated caller-owned footwear data');

invariant(first.primary && first.kind === 'door', 'primary entrance semantics were lost');
invariant(first.version === 4, `opening schema version drifted to ${first.version}`);
invariant(first.hardware.length === 3, 'civilian primary door does not own the restrained 2 straps/ring set');
invariant(first.hardware.filter((part) => part.kind === 'hinge-strap').length === 2,
  'primary door hinge straps drifted');
invariant(first.hardware.filter((part) => part.kind === 'pivot-cap').length === 0,
  'palace-only visible pivot caps leaked onto a civilian door');
invariant(first.hardware.filter((part) => part.kind === 'ring-handle').length === 1,
  'primary door ring handle drifted');
invariant(first.anchors.pivot && first.anchors.footwear && first.anchors.focus,
  'primary entrance lost pivot, footwear, or focus anchor');
invariant(first.anchors.focus.u === 0
    && Math.abs(first.anchors.focus.y - first.height * 0.5) < EPS
    && Math.abs(first.anchors.focus.outward - first.reveal.face) < EPS,
  'primary focus escaped the fixed opening center');
invariant(Math.abs(Math.abs(first.anchors.pivot.u) - first.width * 0.5) < EPS,
  'door pivot escaped the opening');
invariant(Math.abs(first.anchors.pivot.leafWidth - first.width / first.leafCount) < EPS,
  'door pivot describes a leaf wider than the opening');
invariant(Math.abs(first.anchors.pivot.outward - input.leafOutward) < EPS,
  'moving leaf lost its renderer-free outward pivot coordinate');
invariant(first.anchors.footwear.outward > first.threshold.depth,
  'footwear anchor does not clear the threshold');
invariant(first.anchors.footwear.surface === 'toenmaru',
  'builder-authored entrance landing was discarded');
invariant(first.anchors.footwear.clearSide === -1,
  'footwear landing side was coupled to the moving leaf');
const narrower = planOpeningDetail({ ...input, width: 1.28 });
const wider = planOpeningDetail({ ...input, width: 2.42 });
const taller = planOpeningDetail({ ...input, height: 2.7 });
invariant(narrower.anchors.pivot.hingeSide === first.anchors.pivot.hingeSide
    && wider.anchors.pivot.hingeSide === first.anchors.pivot.hingeSide,
  'continuous width editing flips the primary hinge side');
invariant(narrower.anchors.focus.u === 0 && wider.anchors.focus.u === 0
    && Math.abs(narrower.anchors.focus.y - first.anchors.focus.y) < EPS
    && Math.abs(wider.anchors.focus.y - first.anchors.focus.y) < EPS,
  'continuous width editing moved the fixed opening focus');
invariant(Math.abs(taller.anchors.focus.y - taller.height * 0.5) < EPS
    && taller.anchors.focus.y > first.anchors.focus.y
    && Math.abs(taller.anchors.focus.outward - taller.reveal.face) < EPS,
  'height editing did not keep focus at the fixed opening center');
invariant(first.meoreum.height === 0, 'door passage incorrectly acquired a window meoreum');
invariant(Math.abs(first.lowerPanel.height - input.lowerPanelHeight) < EPS,
  'door lower-panel height drifted');
invariant(Math.abs(first.reveal.faceClearance - OPENING_FACE_CLEARANCE) < EPS,
  'opening detail escaped the shared surface-clearance contract');
invariant(first.frame.parts.some((part) => part.kind === 'lower-panel-rail')
    && !first.frame.parts.some((part) => part.kind.startsWith('meoreum-')),
  'door lower cheongpan rail and window meoreum semantics were conflated');
for (const part of [...first.frame.parts, ...first.hardware]) {
  invariant(Number.isFinite(part.u) && Number.isFinite(part.y) && Number.isFinite(part.outward),
    `${part.kind} has a non-finite placement`);
  invariant(part.outward >= first.reveal.face,
    `${part.kind} returned behind the visible opening face`);
}

const secondary = planOpeningDetail({ ...input, primary: false });
invariant(!secondary.primary && secondary.hardware.length === 0,
  'secondary door acquired repeated ironwork');
invariant(secondary.anchors.pivot === null && secondary.anchors.footwear === null
    && secondary.anchors.focus === null,
  'secondary door acquired interaction/life anchors');

for (const style of OPENING_DETAIL_STYLES) {
  const windowPlan = planOpeningDetail({
    kind: 'window', style, seed: `window:${style}`,
    width: style === 'choga' ? 0.5 : 1.2,
    height: style === 'choga' ? 0.5 : 0.7,
    wallThickness: 0.1,
    ...(style === 'giwa' ? { meoreumHeight: 0.36 } : {}),
  });
  invariant(windowPlan.meoreum.height > 0, `${style} window lost its lower meoreum facility`);
  if (style === 'giwa') {
    invariant(Math.abs(windowPlan.meoreum.height - 0.36) < EPS,
      'explicit window meoreum height drifted');
  }
  invariant(windowPlan.hardware.length === 0, `${style} window acquired door hardware`);
  invariant(windowPlan.frame.parts.some((part) => part.kind === 'meoreum-apron')
      && windowPlan.frame.parts.some((part) => part.kind === 'meoreum-rail')
      && windowPlan.meoreum.apronBottomY < windowPlan.meoreum.apertureSillY,
  `${style} window lost its meoreum apron/rail below the aperture sill`);
  invariant(windowPlan.anchors.pivot === null && windowPlan.anchors.footwear === null
      && windowPlan.anchors.focus === null,
    `${style} window acquired entrance anchors`);
}

const palaceDoor = planOpeningDetail({ ...input, style: 'palace' });
invariant(palaceDoor.hardware.length === 5
    && palaceDoor.hardware.filter((part) => part.kind === 'pivot-cap').length === 2,
  'palace door lost the restrained full measured-vocabulary interpretation');

let rejected = 0;
for (const bad of [
  { kind: 'hatch' },
  { style: 'generic' },
  { kind: 'door', meoreumHeight: 0.3 },
  { kind: 'window', lowerPanelHeight: 0.3 },
]) {
  try { planOpeningDetail(bad); } catch { rejected++; }
}
invariant(rejected === 4, 'opening vocabulary or door/window lower-part semantics failed open');

console.log(
  `OPENING DETAIL CONTRACT: PASS (frame=${first.frame.parts.length}, hardware=${first.hardware.length}, `
  + `pivot=${first.anchors.pivot.hingeSide < 0 ? 'left' : 'right'})`,
);
