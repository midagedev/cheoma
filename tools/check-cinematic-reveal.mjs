import assert from 'node:assert/strict';
import {
  createArchitecturalReveal,
  createArchitecturalRevealTimeline,
  sampleArchitecturalReveal,
} from '../src/cinematic/architectural-reveal.js';
import {
  createFocusVisibilityIndex,
  selectSafeFocusEndpoint,
} from '../src/camera/focus-visibility.js';
import {
  focusFeatureBlockers,
  parcelFocusBlocker,
} from '../src/village/focus-blockers.js';

const EPS = 1e-9;
const DEG = 180 / Math.PI;
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const direction = (frame) => {
  const dx = frame.target.x - frame.position.x;
  const dy = frame.target.y - frame.position.y;
  const dz = frame.target.z - frame.position.z;
  const length = Math.hypot(dx, dy, dz) || 1;
  return { x: dx / length, y: dy / length, z: dz / length };
};
const angle = (a, b) => Math.acos(Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z)));
const frame = (position, target, fov, referenceFov = fov, composition = 0) => ({
  position, target, fov, referenceFov, composition,
});
const near = (a, b, epsilon = EPS) => assert.ok(distance(a, b) <= epsilon, `${JSON.stringify(a)} != ${JSON.stringify(b)}`);

const from = frame({ x: -14, y: 9, z: 29 }, { x: 0, y: 4.2, z: 0 }, 28, 28, 0);
const close = frame({ x: 1.5, y: 1.35, z: 34 }, { x: 0, y: 5.2, z: 0 }, 18, 21, 1);
const arrival = createArchitecturalReveal({
  kind: 'arrival', from, to: close, seed: 20260716, subjectSize: 22, motion: 'full',
});
const arrivalAgain = createArchitecturalReveal({
  kind: 'arrival', from, to: close, seed: 20260716, subjectSize: 22, motion: 'full',
});
assert.deepEqual(arrival, arrivalAgain, 'same seed must reproduce the same immutable shot');
assert.ok(Object.isFrozen(arrival) && Object.isFrozen(arrival.start) && Object.isFrozen(arrival.end));

const arrivalStart = sampleArchitecturalReveal(arrival, 0);
const arrivalEnd = sampleArchitecturalReveal(arrival, 1);
near(arrivalStart.position, arrival.start.position);
near(arrivalStart.target, arrival.start.target);
near(arrivalEnd.position, close.position);
near(arrivalEnd.target, close.target);
assert.equal(arrivalEnd.fov, close.fov);
assert.equal(arrivalEnd.referenceFov, close.referenceFov);
assert.equal(arrivalEnd.composition, close.composition);
assert.ok(distance(arrivalStart.position, arrivalStart.target) > distance(close.position, close.target) * 1.5);
assert.ok(arrivalStart.fov >= 32 && arrivalEnd.fov === 18, 'arrival must settle wide-to-telephoto');

let maxTurnRate = 0;
let previous = direction(arrivalStart);
const samples = 240;
for (let index = 1; index <= samples; index++) {
  const current = direction(sampleArchitecturalReveal(arrival, index / samples));
  maxTurnRate = Math.max(maxTurnRate, angle(previous, current) / (arrival.duration / samples) * DEG);
  previous = current;
}
assert.ok(maxTurnRate < 28, `arrival look direction turns too quickly (${maxTurnRate.toFixed(2)}°/s)`);

const rebuilt = frame({ x: 2.8, y: 1.35, z: 32.5 }, { x: 0.6, y: 4.8, z: -0.4 }, 20, 23, 1);
const rebuild = createArchitecturalReveal({
  kind: 'rebuild', from: close, to: rebuilt, seed: 9172, subjectSize: 18, motion: 'full',
});
const rebuildStart = sampleArchitecturalReveal(rebuild, 0);
const rebuildMid = sampleArchitecturalReveal(rebuild, 0.5);
const rebuildEnd = sampleArchitecturalReveal(rebuild, 1);
near(rebuildStart.position, close.position);
near(rebuildStart.target, close.target);
near(rebuildEnd.position, rebuilt.position);
near(rebuildEnd.target, rebuilt.target);

const directMid = {
  x: (close.position.x + rebuilt.position.x) / 2,
  y: (close.position.y + rebuilt.position.y) / 2,
  z: (close.position.z + rebuilt.position.z) / 2,
};
assert.ok(distance(rebuildMid.position, directMid) > 0.4, 'rebuild needs a visible but restrained breathing arc');
const startStep = sampleArchitecturalReveal(rebuild, 0.001);
const endStep = sampleArchitecturalReveal(rebuild, 0.999);
assert.ok(distance(rebuildStart.position, startStep.position) < 0.001, 'rebuild start velocity must settle to zero');
assert.ok(distance(rebuildEnd.position, endStep.position) < 0.001, 'rebuild end velocity must settle to zero');

const compact = createArchitecturalReveal({
  kind: 'rebuild', from: close, to: rebuilt, seed: 9172, subjectSize: 18, motion: 'compact',
});
const compactMid = sampleArchitecturalReveal(compact, 0.5);
assert.ok(
  distance(compactMid.position, directMid) < distance(rebuildMid.position, directMid) * 0.7,
  'compact motion must materially reduce the desktop arc',
);

const reduced = createArchitecturalReveal({
  kind: 'arrival', from, to: close, seed: 1, subjectSize: 100, motion: 'reduced', duration: 99,
});
assert.equal(reduced.duration, 0, 'reduced-motion must override an authored duration');
near(sampleArchitecturalReveal(reduced, 0).position, close.position);
near(sampleArchitecturalReveal(reduced, 0.4).target, close.target);
near(sampleArchitecturalReveal(reduced, 1).position, close.position);

const timeline = createArchitecturalRevealTimeline(rebuild);
assert.equal(timeline.progress(), 0);
timeline.advance(rebuild.duration * 0.4);
assert.ok(Math.abs(timeline.progress() - 0.4) < EPS);
timeline.advance(rebuild.duration);
assert.ok(timeline.isDone());
assert.equal(timeline.progress(), 1);
near(timeline.sample().position, rebuilt.position);

// A neighbouring roof can occupy the authored yard ray without invalidating the
// village layout. The safe endpoint may use another angle inside the same solar
// opening, but must retain the authored elevation and projected size without
// generation RNG.
const subjectBounds = { min: { x: -4, y: 0, z: -2 }, max: { x: 4, y: 8, z: 2 } };
const baseAzimuth = 14 * Math.PI / 180;
const focusBase = frame({ x: Math.sin(baseAzimuth) * 30, y: 1.35, z: Math.cos(baseAzimuth) * 30 }, { x: 0, y: 4, z: 0 }, 20, 23, 1);
const focusIndex = createFocusVisibilityIndex([
  { id: 'subject', bounds: subjectBounds },
  { id: 'foreground-roof', bounds: { min: { x: 2, y: 0, z: 23 }, max: { x: 9, y: 6.5, z: 27 } } },
]);
const safeFocus = selectSafeFocusEndpoint({
  subjectId: 'subject', framing: focusBase, subjectBounds, index: focusIndex,
});
assert.equal(safeFocus.baseVisibleRatio, 0, 'fixture default endpoint must be occluded');
assert.equal(safeFocus.visibleRatio, 1, 'safe endpoint must restore the complete sampled house bounds');
assert.equal(safeFocus.azimuth, 0, 'selector must choose the unblocked centre of the solar opening');
assert.equal(safeFocus.scale, 0.8, 'selector must choose the bounded owner-yard dolly');
const focusElevation = (framing) => Math.atan2(
  framing.position.y - framing.target.y,
  Math.hypot(
    framing.position.x - framing.target.x,
    framing.position.z - framing.target.z,
  ),
);
assert.ok(Math.abs(focusElevation(safeFocus.framing) - focusElevation(focusBase)) < EPS,
  'solar-opening candidate must preserve the authored camera elevation');
assert.ok(safeFocus.framing.fov < 26, 'safe solar-opening candidate must preserve a telephoto lens');
assert.ok(Math.abs(
  Math.tan(safeFocus.framing.fov * Math.PI / 360) * safeFocus.scale
    - Math.tan(focusBase.fov * Math.PI / 360)
) < EPS, 'bounded dolly must preserve the authored projected house size');
assert.deepEqual(
  selectSafeFocusEndpoint({ subjectId: 'subject', framing: focusBase, subjectBounds, index: focusIndex }),
  safeFocus,
  'safe endpoint selection must be deterministic',
);

const trappedIndex = createFocusVisibilityIndex([
  { id: 'subject', bounds: subjectBounds },
  { id: 'foreground-roof', bounds: { min: { x: 2, y: 0, z: 23 }, max: { x: 9, y: 6.5, z: 27 } } },
  {
    id: 'camera-trap',
    bounds: { min: { x: -1, y: 0, z: 23 }, max: { x: 1, y: 3, z: 25 } },
    volume: {
      center: { x: 0, y: 1.5, z: 24 }, half: { x: 1, y: 1.5, z: 1 }, rotationY: Math.PI / 7,
    },
  },
]);
const trappedFocus = selectSafeFocusEndpoint({
  subjectId: 'subject', framing: focusBase, subjectBounds, index: trappedIndex,
});
const centreCandidate = trappedFocus.candidates.find((candidate) => candidate.scale === 0.8);
assert.ok(centreCandidate?.cameraBlocked, 'candidate inside a rotated neighbouring proxy must be rejected');
assert.notEqual(trappedFocus.scale, 0.8, 'selector must never choose a camera-blocked endpoint');

// A blocked authored endpoint cannot win the one-sample hysteresis tie. This is
// intentionally an equal-visibility fixture: it catches collision fallback even
// when every camera sees the house equally well.
const baseTrapIndex = createFocusVisibilityIndex([
  { id: 'subject', bounds: subjectBounds },
  {
    id: 'base-camera-trap',
    bounds: {
      min: { x: focusBase.position.x - 0.8, y: 0, z: focusBase.position.z - 0.8 },
      max: { x: focusBase.position.x + 0.8, y: 3, z: focusBase.position.z + 0.8 },
    },
  },
]);
const baseTrapFocus = selectSafeFocusEndpoint({
  subjectId: 'subject', framing: focusBase, subjectBounds, index: baseTrapIndex,
});
assert.ok(baseTrapFocus.candidates[0].cameraBlocked, 'fixture authored endpoint must begin inside a blocker');
assert.ok(!baseTrapFocus.candidates.find((candidate) => (
  Math.abs(candidate.azimuth - baseTrapFocus.azimuth) < EPS
    && Math.abs(candidate.scale - baseTrapFocus.scale) < EPS
))?.cameraBlocked, 'an equal-visibility unblocked alternative must beat the blocked authored endpoint');

// Visibility uses the fitted eave envelope rather than the generous parcel pick
// box, and planned public structures participate without renderer traversal.
const site = { heightAt: () => 0 };
const houseParcel = {
  id: 'house', kind: 'choga', variant: 0, seed: 17,
  center: { x: 0, z: 0 }, frontDir: { x: 0, z: 1 }, yaw: Math.PI / 9,
  plotW: 20, plotD: 18, sx: 1, sy: 1, sz: 1, baseY: 0,
};
const houseBlocker = parcelFocusBlocker(houseParcel, site);
assert.ok(houseBlocker, 'residential parcel must produce an actual fitted-roof focus blocker');
assert.ok(houseBlocker.bounds.max.x - houseBlocker.bounds.min.x < houseParcel.plotW,
  'actual roof blocker must remain narrower than the generous parcel pick proxy');
const editedHouseBlocker = parcelFocusBlocker({
  ...houseParcel,
  editRoofBounds: { minX: -6, maxX: 6, minZ: -4, maxZ: 4 },
}, site);
assert.ok(Math.abs(editedHouseBlocker.volume.half.x - 6) < EPS
  && Math.abs(editedHouseBlocker.volume.half.z - 4) < EPS,
  'committed edited eaves must replace the generated variant envelope for focus safety');
const plannedProps = focusFeatureBlockers({
  features: {
    props: [{
      name: 'well', x: focusBase.position.x, z: focusBase.position.z, scale: 1,
    }],
  },
}, site);
assert.equal(plannedProps.length, 1, 'planned public well must become a visibility/camera blocker');
const publicPropFocus = selectSafeFocusEndpoint({
  subjectId: 'subject',
  framing: focusBase,
  subjectBounds,
  index: createFocusVisibilityIndex([
    { id: 'subject', bounds: subjectBounds },
    ...plannedProps,
  ]),
});
assert.ok(publicPropFocus.candidates[0].cameraBlocked,
  'planned public well must block a camera physically placed inside it');
assert.ok(!publicPropFocus.candidates.find((candidate) => (
  Math.abs(candidate.azimuth - publicPropFocus.azimuth) < EPS
    && Math.abs(candidate.scale - publicPropFocus.scale) < EPS
))?.cameraBlocked, 'selector must hand off to an unblocked endpoint around planned public objects');

console.log(`CINEMATIC REVEAL: PASS (arrival max look turn ${maxTurnRate.toFixed(2)}°/s, exact endpoints, compact/reduced policies, ${Math.round(safeFocus.baseVisibleRatio * 100)}%→${Math.round(safeFocus.visibleRatio * 100)}% safe focus visibility)`);
