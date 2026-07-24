import assert from 'node:assert/strict';
import {
  VILLAGE_FOCUS_ELEVATION,
  VILLAGE_LENS,
  dollyDistanceForFov,
  dollyScaleForFov,
  equivalentDistanceAtFov,
} from '../src/camera/optics.js';
import {
  createArchitecturalReveal,
  createArchitecturalRevealTimeline,
  sampleArchitecturalReveal,
} from '../src/cinematic/architectural-reveal.js';
import {
  createFocusVisibilityIndex,
  sampleFocusSubjectSurface,
  selectSafeFocusEndpoint,
} from '../src/camera/focus-visibility.js';
import {
  fitFocusFraming,
  focusSubjectFitPoints,
  safeViewportRect,
  transformFocusSubject,
} from '../src/camera/focus-framing.js';
import {
  focusFeatureBlockers,
  focusPlanningBlockers,
  parcelFocusBlocker,
  parcelFocusDetailAnchors,
  parcelWallFocusBlockers,
} from '../src/village/focus-blockers.js';
import {
  terrainMeshCameraSafeScale,
  terrainMeshFocusCutaway,
  terrainMeshSegmentClearance,
} from '../src/village/terrain-grid.js';

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

// #155: UI adapters provide only physical viewport insets. The reusable camera
// policy must preserve lens/axis/elevation while dollying a representative hall
// and its flat courtyard into that safe rectangle.
const semanticSubject = transformFocusSubject({
  id: 'fixture-compound',
  representative: {
    id: 'main-hall',
    role: 'main-hall',
    footprint: [
      { x: -9, z: 1 }, { x: 9, z: 1 }, { x: 9, z: -6 }, { x: -9, z: -6 },
    ],
    minY: 0,
    maxY: 11,
  },
  courtyard: {
    id: 'court',
    role: 'worship',
    footprint: [
      { x: -14, z: 20 }, { x: 14, z: 20 }, { x: 14, z: -1 }, { x: -14, z: -1 },
    ],
    y: 0.02,
  },
  target: { x: 0, y: 3.2, z: 2 },
}, { x: 21, y: 4, z: -13, rotationY: 0.37 });
const semanticFrame = frame(
  { x: 42, y: 20, z: 54 },
  semanticSubject.target,
  VILLAGE_LENS.temple.fov,
  VILLAGE_LENS.temple.referenceFov,
);
const desktopLayout = {
  width: 1440,
  height: 900,
  insets: { left: 322, right: 186, top: 0, bottom: 138 },
  gutter: 16,
};
const safeDesktop = safeViewportRect(desktopLayout);
assert.deepEqual(
  [safeDesktop.left, safeDesktop.right, safeDesktop.top, safeDesktop.bottom],
  [338, 1238, 16, 746],
  'actual product chrome must reduce to one stable safe rectangle',
);
const fittedSemantic = fitFocusFraming({
  framing: semanticFrame,
  subject: semanticSubject,
  viewport: desktopLayout,
});
assert.ok(fittedSemantic.fitted && !fittedSemantic.overflow && fittedSemantic.scale > 1,
  'semantic compound fixture must require and receive a physical dolly-out');
assert.ok(
  fittedSemantic.projectedBounds.left >= safeDesktop.left - EPS
    && fittedSemantic.projectedBounds.right <= safeDesktop.right + EPS
    && fittedSemantic.projectedBounds.top >= safeDesktop.top - EPS
    && fittedSemantic.projectedBounds.bottom <= safeDesktop.bottom + EPS,
  'representative hall and courtyard fit points must remain inside the safe viewport',
);
assert.equal(fittedSemantic.framing.fov, semanticFrame.fov,
  'safe viewport fitting must preserve the authored physical lens');
near(fittedSemantic.framing.target, semanticFrame.target);
const semanticBaseDirection = direction(semanticFrame);
const semanticFitDirection = direction(fittedSemantic.framing);
assert.ok(angle(semanticBaseDirection, semanticFitDirection) < EPS,
  'safe viewport fitting must preserve approach axis and elevation');
assert.equal(focusSubjectFitPoints(semanticSubject).length, 12,
  'semantic fitting must sample a hall volume plus only the courtyard ground plane');
const unusableSemantic = fitFocusFraming({
  framing: semanticFrame,
  subject: semanticSubject,
  viewport: {
    width: 390,
    height: 844,
    insets: { left: 0, right: 0, top: 0, bottom: 760 },
    gutter: 16,
  },
});
assert.ok(!unusableSemantic.fitted && unusableSemantic.overflow
  && unusableSemantic.scale === 1,
'a nearly full sheet must fail closed instead of shrinking architecture into a thumbnail');

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

// #95: the product hero now ends on a 200mm-like 7° vertical FOV. The reveal
// must make that compression emerge continuously while compensated distance
// preserves a monotonic subject build-up; an endpoint-only assertion misses a
// mid-path zoom reversal or a final framing pop.
const heroTarget = { x: 0, y: 5.2, z: 0 };
const heroPhysicalDistance = dollyDistanceForFov(
  50,
  VILLAGE_LENS.hero.referenceFov,
  VILLAGE_LENS.hero.fov,
);
const heroAzimuth = 14 / DEG;
const heroClose = frame({
  x: Math.sin(heroAzimuth) * Math.cos(VILLAGE_FOCUS_ELEVATION) * heroPhysicalDistance,
  y: heroTarget.y + Math.sin(VILLAGE_FOCUS_ELEVATION) * heroPhysicalDistance,
  z: Math.cos(heroAzimuth) * Math.cos(VILLAGE_FOCUS_ELEVATION) * heroPhysicalDistance,
}, heroTarget, VILLAGE_LENS.hero.fov, VILLAGE_LENS.hero.referenceFov, 0);
const opticalArrival = createArchitecturalReveal({
  kind: 'arrival', from, to: heroClose, seed: 20260716, subjectSize: 22, motion: 'full',
});
const opticalSamples = Array.from({ length: 241 }, (_, index) => (
  sampleArchitecturalReveal(opticalArrival, index / 240)
));
const nondecreasing = (values, epsilon = 1e-9) => values.every((value, index) => (
  index === 0 || value >= values[index - 1] - epsilon
));
const nonincreasing = (values, epsilon = 1e-9) => values.every((value, index) => (
  index === 0 || value <= values[index - 1] + epsilon
));
assert.ok(nonincreasing(opticalSamples.map((sample) => sample.fov)),
  '200mm-like arrival actual FOV must narrow monotonically');
assert.ok(nonincreasing(opticalSamples.map((sample) => sample.referenceFov)),
  '200mm-like arrival reference FOV must narrow monotonically');
assert.ok(nondecreasing(opticalSamples.map((sample) => (
  dollyScaleForFov(sample.referenceFov, sample.fov)
))), '200mm-like arrival compression must emerge monotonically');
assert.ok(nondecreasing(opticalSamples.map((sample) => 1 / (
  distance(sample.position, sample.target) * Math.tan(sample.fov * Math.PI / 360)
)), 1e-7), '200mm-like arrival must not shrink the architecture mid-transition');
near(opticalSamples.at(-1).position, heroClose.position);
near(opticalSamples.at(-1).target, heroClose.target);
assert.ok(distance(opticalSamples.at(-1).position, opticalSamples.at(-2).position) < 0.01,
  '200mm-like arrival must settle without an endpoint position snap');

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

// #151: stable renderer-free household anchors may open the opposite side of
// the same solar corridor. The selected house remains the architectural subject,
// but its fitted roof must still act as the first surface for low yard details.
const detailIndex = createFocusVisibilityIndex([
  { id: 'subject', bounds: subjectBounds },
]);
const oppositeDetail = [{ id: 'yard:jangdok', point: { x: -6.5, y: 0.3, z: -15 } }];
const detailFocus = selectSafeFocusEndpoint({
  subjectId: 'subject',
  framing: focusBase,
  subjectBounds,
  index: detailIndex,
  detailAnchors: oppositeDetail,
});
assert.equal(detailFocus.candidates.length, 3,
  'yard-aware focus must retain exactly three bounded camera candidates');
assert.deepEqual(detailFocus.candidates.map((candidate) => Math.round(candidate.azimuth * DEG)), [14, 0, -14],
  'planned detail direction may sample the opposite edge but never leave the solar opening');
assert.deepEqual(detailFocus.candidates.map((candidate) => candidate.requestedScale), [1, 0.9, 0.8],
  'detail-aware candidates must preserve the existing safe telephoto dolly contract');
assert.equal(detailFocus.baseDetailVisibleCount, 0,
  'same-side authored camera must begin behind the fitted subject roof');
assert.deepEqual(detailFocus.baseDetailBlockers, ['subject'],
  'the selected house remains a first-surface blocker for its yard-detail rays');
assert.equal(detailFocus.detailVisibleCount, 1);
assert.equal(detailFocus.detailVisibleRatio, 1);
assert.equal(Math.round(detailFocus.azimuth * DEG), -14,
  'an equally safe opposite-side view must win when it alone reveals the yard detail');
assert.equal(detailFocus.visibleRatio, 1,
  'detail preference must preserve complete architectural surface visibility');
assert.ok(Math.abs(focusElevation(detailFocus.framing) - focusElevation(focusBase)) < EPS,
  'detail-aware candidate must preserve the authored camera elevation');
assert.deepEqual(selectSafeFocusEndpoint({
  subjectId: 'subject',
  framing: focusBase,
  subjectBounds,
  index: detailIndex,
  detailAnchors: oppositeDetail,
}), detailFocus, 'detail-aware focus selection must be deterministic');

const detailTradeoff = (height) => selectSafeFocusEndpoint({
  subjectId: 'subject',
  framing: focusBase,
  subjectBounds,
  index: createFocusVisibilityIndex([
    { id: 'subject', bounds: subjectBounds },
    {
      id: 'opposite-low-obstruction',
      bounds: { min: { x: -12, y: 0, z: 0 }, max: { x: -4, y: height, z: 7 } },
    },
  ]),
  detailAnchors: [{ id: 'yard:work', point: { x: -15, y: 0.3, z: 0 } }],
});
const oneSampleTradeoff = detailTradeoff(1.5);
assert.equal(oneSampleTradeoff.visibleRatio, 8 / 9);
assert.equal(oneSampleTradeoff.detailVisibleRatio, 1,
  'detail may resolve an exact one-of-nine architectural hysteresis choice');
assert.equal(Math.round(oneSampleTradeoff.azimuth * DEG), -14);
const unsafeTradeoff = detailTradeoff(4);
assert.equal(unsafeTradeoff.visibleRatio, 1);
assert.equal(unsafeTradeoff.detailVisibleRatio, 0);
assert.equal(Math.round(unsafeTradeoff.azimuth * DEG), 14,
  'detail must not outweigh a loss of more than one architectural surface sample');

// #132: a telephoto endpoint may sit behind the rendered terrain even when no
// building proxy blocks it. Safety shortening keeps the 24° ray and projected
// house size, while the authored reference lens stays fixed so LOD does not pop.
const terrainSite = {
  R: 150,
  terrainR: 150,
  heightAt(x, z) {
    const ridge = Math.max(0, 12 - Math.abs(z - 21) * 1.4);
    return ridge + x * 0;
  },
};
const terrainTarget = { x: 0, y: 2.2, z: 0 };
const terrainCamera = { x: 0, y: 18, z: 42 };
const unsafeTerrainRay = terrainMeshSegmentClearance(
  terrainSite,
  terrainTarget,
  terrainCamera,
);
assert.ok(unsafeTerrainRay.min < 0, 'fixture telephoto ray must cross the rendered ridge');
const terrainSafety = terrainMeshCameraSafeScale(
  terrainSite,
  terrainTarget,
  terrainCamera,
  { clearance: 1, endpointClearance: 1.2, maxRadius: 140 },
);
assert.ok(terrainSafety.scale > 0 && terrainSafety.scale < 1,
  'terrain safety must retain the first connected ray interval');
assert.ok(terrainSafety.minClearance >= 1 - 1e-8);
assert.ok(terrainSafety.endpointClearance >= 1.2 - 1e-8);

// #136: the product keeps the authored distant telephoto frame when the whole
// terrain obstruction can be removed by one projection near plane before the
// nearest sampled house face. The same camera-facing 3×3 surface used for object
// visibility owns this pure cutaway, so a clear centre cannot hide a clipped
// eave corner.
const terrainSubjectSamples = sampleFocusSubjectSurface(terrainCamera, subjectBounds);
const terrainCutaway = terrainMeshFocusCutaway(
  terrainSite,
  terrainCamera,
  terrainTarget,
  terrainSubjectSamples,
  { maxRadius: 140 },
);
assert.equal(terrainSubjectSamples.length, 9);
assert.ok(terrainCutaway.active && terrainCutaway.available,
  'rendered ridge must resolve to an available focus near-plane cutaway');
assert.ok(terrainCutaway.minClearance < 0 && terrainCutaway.blockedRays > 0,
  'cutaway fixture must prove the authored telephoto rays cross terrain');
assert.ok(terrainCutaway.near > terrainCutaway.requiredNear
  && terrainCutaway.near <= terrainCutaway.subjectNear - 1.2,
  'cutaway plane must clear the ridge while retaining the complete house interval');
assert.deepEqual(
  terrainMeshFocusCutaway(
    terrainSite,
    terrainCamera,
    terrainTarget,
    terrainSubjectSamples,
    { maxRadius: 140 },
  ),
  terrainCutaway,
  'focus terrain cutaway must be deterministic',
);
const highContextCamera = { x: 0, y: 80, z: 100 };
const highContextCutaway = terrainMeshFocusCutaway(
  { R: 150, terrainR: 150, heightAt: () => 0 },
  highContextCamera,
  terrainTarget,
  sampleFocusSubjectSurface(highContextCamera, subjectBounds),
  { maxRadius: 30 },
);
assert.ok(highContextCutaway.boundaryRays > 0
  && !highContextCutaway.active
  && highContextCutaway.available,
  'leaving the exact outer-grid radius must not erase a clear high village-context frame');
const contactBounds = {
  min: { x: -4, y: -4, z: -2 },
  max: { x: 4, y: 8, z: 2 },
};
const groundContactCutaway = terrainMeshFocusCutaway(
  { R: 150, terrainR: 150, heightAt: () => 0 },
  terrainCamera,
  terrainTarget,
  sampleFocusSubjectSurface(terrainCamera, contactBounds),
);
assert.ok(groundContactCutaway.contactRays > 0
  && groundContactCutaway.blockedRays === 0
  && !groundContactCutaway.active,
  'a low house-face sample may leave its ground contact without inventing a foreground ridge');

const constrainedFocus = selectSafeFocusEndpoint({
  subjectId: 'subject',
  framing: focusBase,
  subjectBounds,
  index: createFocusVisibilityIndex([{ id: 'subject', bounds: subjectBounds }]),
  telephotoFovMax: 45,
  constrainEndpoint: () => ({
    scale: 0.5,
    limited: true,
    minClearance: 1,
    endpointClearance: 1.2,
  }),
});
assert.equal(constrainedFocus.candidates.length, 3,
  'terrain safety must preserve the exact three authored focus candidates');
assert.equal(constrainedFocus.scale, 0.5);
assert.equal(constrainedFocus.framing.referenceFov, focusBase.referenceFov,
  'safety dolly must not rewrite the authored LOD reference lens');
assert.ok(Math.abs(
  distance(constrainedFocus.framing.position, constrainedFocus.framing.target)
    / distance(focusBase.position, focusBase.target)
    - 0.5
) < EPS);
assert.ok(Math.abs(
  Math.tan(constrainedFocus.framing.fov * Math.PI / 360) * constrainedFocus.scale
    - Math.tan(focusBase.fov * Math.PI / 360)
) < EPS, 'terrain dolly must preserve projected architecture size');
assert.ok(Math.abs(
  equivalentDistanceAtFov(
    distance(constrainedFocus.framing.position, constrainedFocus.framing.target),
    constrainedFocus.framing.fov,
    constrainedFocus.framing.referenceFov,
  )
    - equivalentDistanceAtFov(
      distance(focusBase.position, focusBase.target),
      focusBase.fov,
      focusBase.referenceFov,
    )
) < EPS, 'terrain dolly must preserve screen-equivalent LOD distance');
assert.throws(() => selectSafeFocusEndpoint({
  subjectId: 'invalid-subject',
  framing: focusBase,
  subjectBounds,
  index: createFocusVisibilityIndex([{ id: 'invalid-subject', bounds: subjectBounds }]),
  constrainEndpoint: () => ({ scale: Number.NaN }),
}), /No target-connected terrain-safe focus endpoint/,
'invalid terrain constraints must fail closed instead of placing the camera at the target');

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
const plannedHousehold = {
  ...houseParcel,
  id: 'yard-detail-owner',
  center: { x: 10, z: 20 },
  frontDir: { x: 0, z: 1 },
  baseY: 3,
  plotW: 20,
  plotD: 18,
  jangdok: 2,
};
const plannedDetailAnchors = parcelFocusDetailAnchors(plannedHousehold, site);
assert.equal(plannedDetailAnchors.length, 1,
  'one planned jangdok platform must yield one representative detail anchor');
assert.ok(Object.isFrozen(plannedDetailAnchors[0])
  && Object.isFrozen(plannedDetailAnchors[0].point),
  'planned detail anchor and its world point must be immutable');
near(plannedDetailAnchors[0].point, { x: 1.94, y: 3.5, z: 12.21 });
assert.deepEqual(parcelFocusDetailAnchors(plannedHousehold, site), plannedDetailAnchors,
  'planned household detail anchors must be stable without RNG');
assert.deepEqual(parcelFocusDetailAnchors({
  ...plannedHousehold,
  jangdok: 0,
}, site), [], 'an empty enclosed yard must not invent a camera detail target');
assert.deepEqual(parcelFocusDetailAnchors({
  ...plannedHousehold,
  hero: true,
}, site), [], 'a hero compound must not inherit regular-house yard anchors');
const walledHousehold = {
  ...plannedHousehold,
  center: { x: 0, z: 0 },
  yaw: 0,
  baseY: 0,
  wallType: 'stone',
  wallHeightK: 1,
  shape: {
    pts: [
      { x: 10, z: 9 }, { x: -10, z: 9 },
      { x: -10, z: -9 }, { x: 10, z: -9 },
    ],
    roles: ['front', 'left', 'back', 'right'],
  },
  access: { gateEdge: 0, gateT: 0.5 },
};
const plannedWallBlockers = parcelWallFocusBlockers(walledHousehold, site, 0.5);
assert.ok(plannedWallBlockers.some((entry) => entry.id.startsWith('wall:yard-detail-owner:0:'))
  && plannedWallBlockers.some((entry) => entry.id.startsWith('gate:yard-detail-owner:post:')),
  'planned detail blockers must preserve the actual split wall runs and gate opening');
assert.deepEqual(parcelWallFocusBlockers(walledHousehold, site, 0.5), plannedWallBlockers,
  'wall and gate first-surface blockers must be deterministic without global RNG');
assert.deepEqual(parcelWallFocusBlockers({
  ...walledHousehold,
  hero: true,
}, site, 0.5), [], 'a hero compound must not inherit the regular parcel wall layout');
const wallRayFraming = {
  position: { x: 0, y: 5, z: 30 },
  target: { x: 0, y: 1, z: -6 },
  fov: 10,
  referenceFov: 10,
};
const wallRaySubject = {
  min: { x: -1, y: 0, z: -7 },
  max: { x: 1, y: 3, z: -5 },
};
const wallRayIndex = createFocusVisibilityIndex([
  { id: 'yard-detail-owner', bounds: wallRaySubject },
]);
const wallRayAnchor = [{ id: 'yard:work', point: { x: 4, y: 0.5, z: 0 } }];
const wallBlindResult = selectSafeFocusEndpoint({
  subjectId: 'yard-detail-owner',
  framing: wallRayFraming,
  subjectBounds: wallRaySubject,
  index: wallRayIndex,
  detailAnchors: wallRayAnchor,
});
const wallAwareResult = selectSafeFocusEndpoint({
  subjectId: 'yard-detail-owner',
  framing: wallRayFraming,
  subjectBounds: wallRaySubject,
  index: wallRayIndex,
  detailIndex: createFocusVisibilityIndex([
    { id: 'yard-detail-owner', bounds: wallRaySubject },
    ...plannedWallBlockers,
  ]),
  detailAnchors: wallRayAnchor,
});
assert.equal(wallBlindResult.baseDetailVisibleCount, 1,
  'fixture must prove the wall-free detail query would report a false clear ray');
assert.equal(wallAwareResult.baseDetailVisibleCount, 0);
assert.ok(wallAwareResult.baseDetailBlockers.some((id) => id.startsWith('wall:yard-detail-owner:0:')),
  'actual front-wall runs must be the first surface for a low yard-detail ray outside the gate');
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

const auxiliaryParcel = {
  id: 'auxiliary-owner',
  kind: 'choga',
  center: { x: focusBase.position.x, z: focusBase.position.z },
  frontDir: { x: 0, z: 1 },
  baseY: 0,
  auxiliary: {
    id: 'aux-0',
    local: { x: 0, z: 0, yaw: 0 },
    body: { width: 2.4, depth: 2.2 },
    roof: { overhang: 0.28 },
    roofTopY: 3,
  },
};
const plannedAuxiliary = focusPlanningBlockers({
  parcels: [auxiliaryParcel],
  features: {},
}, site);
assert.equal(plannedAuxiliary.length, 1,
  'planned auxiliary must enter the production external-blocker set exactly once');
const auxiliaryFocus = selectSafeFocusEndpoint({
  subjectId: 'subject',
  framing: focusBase,
  subjectBounds,
  index: createFocusVisibilityIndex([
    { id: 'subject', bounds: subjectBounds },
    ...plannedAuxiliary,
  ]),
});
assert.ok(auxiliaryFocus.candidates[0].cameraBlocked,
  'planned auxiliary must reject a camera physically placed inside it');
assert.ok(!auxiliaryFocus.candidates.find((candidate) => (
  Math.abs(candidate.azimuth - auxiliaryFocus.azimuth) < EPS
    && Math.abs(candidate.scale - auxiliaryFocus.scale) < EPS
))?.cameraBlocked,
'selector must hand off to an unblocked endpoint around a planned auxiliary');

console.log(`CINEMATIC REVEAL: PASS (arrival max look turn ${maxTurnRate.toFixed(2)}°/s, exact endpoints, compact/reduced policies, ${Math.round(safeFocus.baseVisibleRatio * 100)}%→${Math.round(safeFocus.visibleRatio * 100)}% safe focus visibility)`);
