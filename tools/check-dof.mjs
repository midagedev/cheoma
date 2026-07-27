// Fast, browser-free DoF contract: camera-axis focus, single amount ownership,
// and transparent/decorative depth exclusion.
import * as THREE from "../app/node_modules/three/build/three.module.js";
import { readFile } from "node:fs/promises";
import {
  contributesDofDepth,
  createDofController,
  dofDepthMaterialForObject,
  focusDepthForPoint,
} from "../src/env/dof.js";
import {
  CIRCULAR_BOKEH_COMPOSITE_TAP_COUNT,
  CIRCULAR_BOKEH_DEFAULTS,
  CIRCULAR_BOKEH_FRAGMENT_SHADER,
  installCircularBokeh,
} from "../src/env/circular-bokeh-shader.js";
import {
  BOKEH_COC_DEFAULTS,
  BOKEH_GATHER_BASE_KERNEL,
  BOKEH_GATHER_BASE_PER_RING,
  BOKEH_GATHER_BASE_RINGS,
  BOKEH_GATHER_BASE_TAP_COUNT,
  BOKEH_GATHER_FILL_KERNEL,
  BOKEH_GATHER_FILL_PER_RING,
  BOKEH_GATHER_FILL_RINGS,
  BOKEH_GATHER_FILL_TAP_COUNT,
  BOKEH_GATHER_NEAR_DILATE_TAP_COUNT,
  BOKEH_GATHER_TAP_COUNT,
  BOKEH_LONG_FOCUS_BOOST_MAX,
  BOKEH_LONG_FOCUS_REF_M,
  bokehCocLadder,
  bokehCocRadiusPx,
  bokehCocScalePx,
  bokehFarAsymptotePx,
  bokehLongFocusApertureMeters,
  bokehMaxCocPx,
  bokehSignedCocPx,
  bokehTiltFarAsymptoteHeadroom,
  decodeBokehCoc,
  encodeBokehCoc,
} from "../src/env/bokeh-coc-contract.js";
// bokeh-coc-shaders.js and bokeh-coc-contract.js are deliberately Three-free, so
// the generated GLSL and the numeric optics are both asserted directly here with
// no renderer. Only bokeh-coc-pass.js (render targets, materials, draws) imports
// three, and it is asserted as text like the source scatter.
import {
  BOKEH_COC_GATHER_FRAGMENT_SHADER,
  BOKEH_COC_GATHER_TEXTURE_TAP_COUNT,
  BOKEH_COC_NEAR_DILATE_OFFSETS,
  BOKEH_COC_PREFILTER_BLOCK_TAP_COUNT,
  BOKEH_COC_PREFILTER_FRAGMENT_SHADER,
} from "../src/env/bokeh-coc-shaders.js";
import {
  BOKEH_HIGHLIGHT_PREFILTER_ANALYTIC_TAP_COUNT,
  BOKEH_HIGHLIGHT_PREFILTER_GUARD_EXTRA_TAP_COUNT,
  BOKEH_HIGHLIGHT_PREFILTER_OWNERSHIP_TAP_COUNT,
  BOKEH_HIGHLIGHT_PREFILTER_TOTAL_TAP_COUNT,
  BOKEH_SOURCE_CONTRACT,
  bokehSourceCellUv,
  bokehSourceGridDimensions,
  bokehSourceNeedsTriangles,
  selectBokehSourceBackend,
} from "../src/env/bokeh-source-contract.js";
import { createPostQualityState } from "../src/env/post-quality-state.js";
import { createCameraMotionTracker } from "../app/src/engine/post-quality-runtime.js";

const EPS = 1e-9;
const invariant = (condition, message) => {
  if (!condition) throw new Error(message);
};
const near = (actual, expected, message, epsilon = EPS) => {
  invariant(
    Math.abs(actual - expected) <= epsilon,
    `${message} (${actual} != ${expected})`,
  );
};

const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
camera.position.set(0, 0, 0);
camera.lookAt(0, 0, -1);
camera.updateMatrixWorld(true);

const offAxis = new THREE.Vector3(10, 0, -10);
near(
  focusDepthForPoint(camera, offAxis),
  10,
  "off-axis focus used Euclidean distance instead of camera-axis depth",
);
invariant(
  Math.abs(camera.position.distanceTo(offAxis) - 10) > 4,
  "off-axis fixture did not distinguish axial and Euclidean distance",
);
near(
  focusDepthForPoint(camera, new THREE.Vector3(-25, 8, -10)),
  10,
  "lateral target motion changed a constant focus plane",
);
invariant(
  focusDepthForPoint(camera, new THREE.Vector3(0, 0, 1)) === null,
  "behind-camera target was clamped into a visible focus plane",
);
near(
  focusDepthForPoint(camera, new THREE.Vector3(0, 0, -1000)),
  100,
  "focus depth ignored the camera far bound",
);

const rig = new THREE.Group();
const rigCamera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
rig.add(rigCamera);
rig.position.z = 5;
near(
  focusDepthForPoint(rigCamera, new THREE.Vector3(0, 0, -10)),
  15,
  "focus depth read a stale parent camera rig transform",
);

const pass = {
  enabled: false,
  uniforms: {
    focus: { value: 40 },
    aperture: { value: 0.00012 },
  },
};
const dof = createDofController({ camera, pass, aperture: 0.00012 });
near(dof.amount, 0, "disabled pass did not initialize with zero amount");
near(pass.uniforms.aperture.value, 0, "zero amount left a residual aperture");
near(dof.focusAt(offAxis), 10, "controller did not apply camera-axis focus");

const fadeIn = [0, 0.08, 0.25, 0.5, 0.82, 1].map((amount) => {
  dof.setAmount(amount);
  return {
    amount: dof.amount,
    aperture: pass.uniforms.aperture.value,
    enabled: pass.enabled,
  };
});
invariant(
  fadeIn.every(
    (sample, index) => index === 0 || sample.amount >= fadeIn[index - 1].amount,
  ),
  "focus-in amount was not monotonic",
);
invariant(
  fadeIn.every(
    (sample) => sample.aperture >= 0 && sample.aperture <= dof.aperture + EPS,
  ),
  "focus-in aperture overshot its base value",
);
invariant(
  fadeIn[0].enabled === false &&
    fadeIn.slice(1).every((sample) => sample.enabled),
  "amount did not exclusively own Bokeh pass enablement",
);

// Reversing a transition continues from its current amount and cannot strand an inflated aperture.
dof.setAmount(0.63);
const reverse = [0, 0.25, 0.5, 0.75, 1].map((k) =>
  dof.setAmount(0.63 * (1 - k)),
);
invariant(
  reverse.every((amount, index) => index === 0 || amount <= reverse[index - 1]),
  "focus reversal was not monotonic",
);
near(dof.amount, 0, "focus reversal left a residual amount");
near(
  pass.uniforms.aperture.value,
  0,
  "focus reversal left a residual aperture",
);
invariant(pass.enabled === false, "zero amount left the Bokeh pass enabled");

dof.setEnabled(true);
dof.setAperture(0.0002);
near(dof.amount, 1, "compatibility enable split from amount ownership");
near(
  pass.uniforms.aperture.value,
  0.0002,
  "base aperture update ignored current amount",
);

const material = (overrides = {}) => ({
  visible: true,
  depthWrite: true,
  transparent: false,
  ...overrides,
});
invariant(
  contributesDofDepth({ visible: true, isMesh: true, material: material() }),
  "opaque mesh was removed from DoF depth",
);
invariant(
  !contributesDofDepth({
    visible: true,
    isMesh: true,
    material: material({ depthWrite: false }),
  }),
  "non-depth-writing mesh became an opaque DoF occluder",
);
invariant(
  contributesDofDepth({
    visible: true,
    isMesh: true,
    material: material({ transparent: true }),
  }),
  "transparent mesh with explicit depth writing lost its depth contract",
);
invariant(
  !contributesDofDepth({
    visible: true,
    isMesh: true,
    material: material({ alphaHash: true, opacity: 0.5 }),
  }),
  "intermediate alphaHash fade became an opaque DoF occluder",
);
invariant(
  contributesDofDepth({
    visible: true,
    isMesh: true,
    material: material({ alphaHash: true, opacity: 1 }),
  }),
  "full-weight alphaHash mesh lost its DoF depth contract",
);
invariant(
  !contributesDofDepth({ visible: true, isPoints: true }),
  "Points became an opaque DoF occluder",
);
invariant(
  !contributesDofDepth({ visible: true, isSprite: true }),
  "Sprite became an opaque DoF occluder",
);
invariant(
  !contributesDofDepth({ visible: true, isLine: true }),
  "Line became an opaque DoF occluder",
);
invariant(
  !contributesDofDepth({
    visible: true,
    isMesh: true,
    material: material(),
    userData: { dofDepth: false },
  }),
  "explicit DoF depth exclusion was ignored",
);
invariant(
  contributesDofDepth({
    visible: true,
    isMesh: true,
    material: material({ depthWrite: false }),
    userData: { dofDepth: true },
  }),
  "explicit mesh DoF depth inclusion was ignored",
);
invariant(
  !contributesDofDepth({
    visible: true,
    isPoints: true,
    userData: { dofDepth: true },
  }),
  "explicit DoF depth inclusion admitted an incompatible Points primitive",
);
invariant(
  !contributesDofDepth({ visible: false, isMesh: true, material: material() }),
  "hidden mesh contributed DoF depth",
);
const explicitPackedDepth = {
  isMaterial: true,
  visible: true,
  depthWrite: true,
  allowOverride: false,
};
const compactPoint = {
  visible: true,
  isPoints: true,
  userData: {
    dofDepthMaterial: explicitPackedDepth,
  },
};
invariant(
  dofDepthMaterialForObject(compactPoint) === explicitPackedDepth,
  "explicit Points source lost its owned packed-depth material",
);
const unclassifiedSprite = {
  visible: true,
  isSprite: true,
  userData: {
    dofDepthMaterial: explicitPackedDepth,
  },
};
invariant(
  dofDepthMaterialForObject(unclassifiedSprite) === explicitPackedDepth,
  "explicit Sprite source lost its owned packed-depth material",
);
invariant(
  dofDepthMaterialForObject({
    ...compactPoint,
    userData: {
      dofDepthMaterial: { ...explicitPackedDepth, allowOverride: true },
    },
  }) === null,
  "overrideable source material entered the packed-depth prepass",
);
invariant(
  dofDepthMaterialForObject({
    ...compactPoint,
    userData: {
      dofDepthMaterial: { ...explicitPackedDepth, depthWrite: false },
    },
  }) === null,
  "non-depth-writing source material entered the packed-depth prepass",
);
invariant(
  dofDepthMaterialForObject({ ...compactPoint, visible: false }) ===
    explicitPackedDepth,
  "hidden source lost its declarative packed-depth ownership",
);

// ---------------------------------------------------------------------------
// Physical circle of confusion.
//
// Re-authored for the layer-separation restoration. The old contract in this
// place pinned the very thing that removed depth layers from the frame: a
// 13-tap kernel, `surfaceRadiusPx <= 3.25`, a luminance contrast gate, and a
// full stop of surface defocus during camera motion. Those were correct guards
// for a sparse full-resolution kernel and are meaningless once radius is bought
// with resolution (docs/dof-cinematic-research.md §3, §4).
//
// What is pinned now is the optics itself, executed with no renderer:
// monotonicity, subject sharpness, distinguishable layers, near/far asymmetry,
// an unclamped background asymptote, and fov dependence.
// ---------------------------------------------------------------------------

const VIEWPORT_HEIGHT = 1080;
const PARCEL_FOV = 16;
const SUBJECT_DEPTH = 60;
const cocScale = bokehCocScalePx(
  BOKEH_COC_DEFAULTS.apertureMeters,
  VIEWPORT_HEIGHT,
  PARCEL_FOV,
);
const maxCoc = bokehMaxCocPx(VIEWPORT_HEIGHT, BOKEH_COC_DEFAULTS.maxCocFraction);
const radiusAt = (z) => bokehCocRadiusPx(cocScale, SUBJECT_DEPTH, z, maxCoc);

invariant(
  cocScale > 0 && maxCoc > 0,
  "physical CoC scale collapsed for the product close-parcel lens",
);

// (1) Monotonicity in both directions. This is the whole acceptance criterion
// "the further away, the blurrier" and it holds by construction because
// signedCoc = scale * (1/focus - 1/z) is strictly increasing in z.
const farSweep = [60, 64, 70, 75, 90, 120, 150, 220, 300, 600];
const nearSweep = [59, 55, 50, 45, 40, 34, 28, 24];
invariant(
  farSweep.every(
    (z, index) => index === 0 || radiusAt(z) > radiusAt(farSweep[index - 1]),
  ),
  "background CoC stopped increasing monotonically with depth",
);
invariant(
  nearSweep.every(
    (z, index) => index === 0 || radiusAt(z) > radiusAt(nearSweep[index - 1]),
  ),
  "foreground CoC stopped increasing monotonically toward the camera",
);
invariant(
  nearSweep.every((z, index) => {
    if (index === 0) return true;
    const signed = bokehSignedCocPx(cocScale, SUBJECT_DEPTH, z);
    return signed < 0;
  }),
  "foreground lost its negative signed CoC side",
);
invariant(
  bokehSignedCocPx(cocScale, SUBJECT_DEPTH, 150) > 0,
  "background lost its positive signed CoC side",
);

// (2) "Only that house is sharp": one whole 9m house straddling the focus plane
// must stay under the perceptual limit, so focus can be a plane rather than a
// point and still render the subject crisp front to back.
for (const z of [55, 57, 60, 63, 64, 65]) {
  invariant(
    radiusAt(z) <= VIEWPORT_HEIGHT * 0.0025,
    `subject depth ${z}m left the sharp band (${radiusAt(z).toFixed(2)}px)`,
  );
}

// (3) Distinguishable layers. The former 3.25px cap gave every one of these the
// same radius, which is exactly what "no depth separation" looked like.
// A fixed per-step ratio is the wrong test: perspective compression flattens the
// curve toward its asymptote on purpose, so the last step is always the smallest
// (§4.4's own table goes 4.3 -> 7.2 -> 10.8 -> 13.0, a 1.20x final step). Assert
// what the eye actually needs instead - every step separates by at least a pixel
// and the whole ladder spreads several-fold end to end.
const layers = [75, 90, 120, 150];
for (let index = 1; index < layers.length; index++) {
  const nearer = radiusAt(layers[index - 1]);
  const further = radiusAt(layers[index]);
  invariant(
    further - nearer >= 1 && further >= nearer * 1.15,
    `background layers ${layers[index - 1]}m and ${layers[index]}m collapsed ` +
      `into one blur (${nearer.toFixed(2)}px vs ${further.toFixed(2)}px)`,
  );
}
invariant(
  radiusAt(150) / radiusAt(75) >= 2.5,
  `the background ladder lost its end-to-end spread ` +
    `(${(radiusAt(150) / radiusAt(75)).toFixed(2)}x from 75m to 150m)`,
);
invariant(
  radiusAt(75) > 2 && radiusAt(150) > 8,
  "neighbouring parcel and background ridge stayed effectively sharp",
);

// (4) Near/far asymmetry at equal distance from the focus plane. A real lens
// releases the foreground harder, which is what restores the out-of-focus eave
// in the foreground without a separate dial.
const asymmetry = radiusAt(SUBJECT_DEPTH - 20) / radiusAt(SUBJECT_DEPTH + 20);
invariant(
  asymmetry >= 2,
  `near/far asymmetry disappeared (${asymmetry.toFixed(2)}x)`,
);

// (5) The background runs the pure physical curve: its asymptote must sit under
// the clamp, so only the foreground is ever clamped.
const asymptote = bokehFarAsymptotePx(cocScale, SUBJECT_DEPTH);
invariant(
  asymptote < maxCoc,
  `background asymptote ${asymptote.toFixed(2)}px reached the ${maxCoc.toFixed(2)}px clamp`,
);
// Foreground clamp sample: with the product aperture (0.52 m) a 20 m plane no
// longer saturates maxCoc — that is intentional (courtyard life stays readable).
// Closer near planes still hit the cap so only the extreme foreground is clamped.
invariant(
  radiusAt(1e9) < maxCoc - 1e-6 && radiusAt(15) >= maxCoc - 1e-6,
  "the CoC clamp stopped being foreground-only",
);
// Product telephoto focus (~50 m, 16°) with the authored tilt dial must keep the
// far asymptote under the clamp even at the worst-case anchor offset. A ratio > 1
// means tilt re-clamped the background and the near/far asymmetry contract is
// no longer guaranteed (bokeh-coc-contract.js tilt headroom).
const productTiltHeadroom = bokehTiltFarAsymptoteHeadroom({
  scalePx: cocScale,
  focus: 50,
  tiltStrength: BOKEH_COC_DEFAULTS.tiltStrength,
  maxCocPx: maxCoc,
});
invariant(
  productTiltHeadroom.ratio <= 1,
  `product tilt ${BOKEH_COC_DEFAULTS.tiltStrength} saturates the far clamp at 50 m ` +
    `(worst asymptote ${productTiltHeadroom.worstAsymptotePx.toFixed(2)}px / ` +
    `max ${productTiltHeadroom.maxCocPx.toFixed(2)}px, ratio ${productTiltHeadroom.ratio.toFixed(3)})`,
);
invariant(
  BOKEH_COC_DEFAULTS.tiltStrength >= 0.4,
  "product tilt dial fell below the diorama floor that narrows the sharp band",
);

// (6) fov dependence. One aperture constant has to make the telephoto hero lens
// shallow and the wide aerial lens deep, with no per-lens aperture.
const heroScale = bokehCocScalePx(BOKEH_COC_DEFAULTS.apertureMeters, VIEWPORT_HEIGHT, 7);
const aerialScale = bokehCocScalePx(BOKEH_COC_DEFAULTS.apertureMeters, VIEWPORT_HEIGHT, 46);
invariant(
  heroScale > cocScale && cocScale > aerialScale,
  "CoC stopped following the lens continuum (hero > parcel > aerial)",
);

// (6b) Long-focus aperture compensation (#214). Compensated hero dolly parks the
// focus plane near the ridge (~170 m at 7°); without a focus-proportional boost
// the far asymptote collapses and the settle frame has no soft separation.
// Residential focus (≤ ref) must stay at boost 1 so #207's near band is intact.
near(
  bokehLongFocusApertureMeters(BOKEH_COC_DEFAULTS.apertureMeters, 40),
  BOKEH_COC_DEFAULTS.apertureMeters,
  "short-focus aperture was boosted and re-softened the residential near band",
  1e-12,
);
near(
  bokehLongFocusApertureMeters(BOKEH_COC_DEFAULTS.apertureMeters, BOKEH_LONG_FOCUS_REF_M),
  BOKEH_COC_DEFAULTS.apertureMeters,
  "reference-focus aperture left its authored base",
  1e-12,
);
near(
  bokehLongFocusApertureMeters(BOKEH_COC_DEFAULTS.apertureMeters, BOKEH_LONG_FOCUS_REF_M * 1.5),
  BOKEH_COC_DEFAULTS.apertureMeters * 1.5,
  "mid long-focus aperture did not scale with focus / ref",
  1e-12,
);
near(
  bokehLongFocusApertureMeters(BOKEH_COC_DEFAULTS.apertureMeters, 500),
  BOKEH_COC_DEFAULTS.apertureMeters * BOKEH_LONG_FOCUS_BOOST_MAX,
  "long-focus aperture boost escaped its cap",
  1e-12,
);
invariant(
  BOKEH_LONG_FOCUS_REF_M === 60 && BOKEH_LONG_FOCUS_BOOST_MAX === 2,
  "long-focus compensation dials left the product values the hero ladder pins",
);

// Hero settle ladder: 7° · 170 m focus · product tilt, ridge band 220–300 m.
// Untilted ridge must separate from the subject, and the tilted upper frame
// (v=0.75, ridge) must clear a perceptible soft-separation floor while the
// door/eave band (±12 m of focus) stays inside the sharp band.
const HERO_FOCUS = 170;
const HERO_FOV = 7;
const heroEffectiveAperture = bokehLongFocusApertureMeters(
  BOKEH_COC_DEFAULTS.apertureMeters,
  HERO_FOCUS,
);
const heroCocScale = bokehCocScalePx(heroEffectiveAperture, VIEWPORT_HEIGHT, HERO_FOV);
const heroRadiusAt = (z) => bokehCocRadiusPx(heroCocScale, HERO_FOCUS, z, maxCoc);
const heroSettleLadder = bokehCocLadder({
  focus: HERO_FOCUS,
  viewportHeight: VIEWPORT_HEIGHT,
  fovDegrees: HERO_FOV,
  depths: [158, 170, 182, 220, 250, 300],
  tiltStrength: BOKEH_COC_DEFAULTS.tiltStrength,
  screenV: 0.75,
  anchorV: 0.5,
});
invariant(
  heroEffectiveAperture > BOKEH_COC_DEFAULTS.apertureMeters * 1.5,
  "hero settle focus no longer multiplies the product aperture",
);
for (const z of [158, 170, 182]) {
  invariant(
    heroRadiusAt(z) <= VIEWPORT_HEIGHT * 0.0025,
    `hero subject depth ${z}m left the sharp band (${heroRadiusAt(z).toFixed(2)}px)`,
  );
}
invariant(
  heroRadiusAt(220) > 4 && heroRadiusAt(300) > 8,
  `hero settle ridge stayed sharp (220 m ${heroRadiusAt(220).toFixed(2)}px, ` +
    `300 m ${heroRadiusAt(300).toFixed(2)}px)`,
);
invariant(
  heroRadiusAt(300) / heroRadiusAt(220) >= 1.4,
  "hero settle ridge layers collapsed into one blur",
);
const heroRidgeTilted = heroSettleLadder.find((entry) => entry.z === 250);
invariant(
  heroRidgeTilted && heroRidgeTilted.radiusPx > 8,
  `hero settle tilted ridge lost soft separation (${heroRidgeTilted?.radiusPx?.toFixed(2)}px)`,
);
const heroTiltHeadroom = bokehTiltFarAsymptoteHeadroom({
  scalePx: heroCocScale,
  focus: HERO_FOCUS,
  tiltStrength: BOKEH_COC_DEFAULTS.tiltStrength,
  maxCocPx: maxCoc,
});
invariant(
  heroTiltHeadroom.ratio <= 1,
  `hero long-focus boost saturates the far clamp ` +
    `(worst asymptote ${heroTiltHeadroom.worstAsymptotePx.toFixed(2)}px / ` +
    `max ${heroTiltHeadroom.maxCocPx.toFixed(2)}px, ratio ${heroTiltHeadroom.ratio.toFixed(3)})`,
);
// Without compensation the same framing is the pre-#214 failure mode: a near
// ridge (220 m) stays under a perceptual 4 px floor at 1080p.
const heroBareScale = bokehCocScalePx(
  BOKEH_COC_DEFAULTS.apertureMeters,
  VIEWPORT_HEIGHT,
  HERO_FOV,
);
invariant(
  bokehCocRadiusPx(heroBareScale, HERO_FOCUS, 220, maxCoc) < 4,
  "hero settle bare-aperture fixture no longer demonstrates the missing-separation failure",
);
invariant(
  bokehCocScalePx(BOKEH_COC_DEFAULTS.apertureMeters, VIEWPORT_HEIGHT, 0) === 0 &&
    bokehCocScalePx(BOKEH_COC_DEFAULTS.apertureMeters, 0, PARCEL_FOV) === 0 &&
    bokehCocScalePx(Number.NaN, VIEWPORT_HEIGHT, PARCEL_FOV) === 0,
  "CoC scale accepted a degenerate lens, viewport, or aperture",
);
// Viewport-relative, not pixel-absolute: the same frame must look the same at a
// different resolution.
near(
  bokehCocScalePx(BOKEH_COC_DEFAULTS.apertureMeters, 2160, PARCEL_FOV),
  cocScale * 2,
  "CoC stopped scaling with viewport height",
  1e-9,
);

// (7) The ladder helper the app gate and the docs share must agree with the
// direct calls, so one table drives every consumer.
const ladder = bokehCocLadder({
  focus: SUBJECT_DEPTH,
  viewportHeight: VIEWPORT_HEIGHT,
  fovDegrees: PARCEL_FOV,
  depths: [40, 60, 90, 150],
});
invariant(
  ladder.length === 4 &&
    ladder.every((entry) => Math.abs(entry.radiusPx - radiusAt(entry.z)) < 1e-9),
  "the shared CoC ladder diverged from the direct CoC evaluation",
);

// (8) Signed CoC round-trips through one alpha channel, which is how near/far
// split costs no second render target and no second program.
for (const signed of [-maxCoc, -7.5, 0, 4.25, maxCoc]) {
  near(
    decodeBokehCoc(encodeBokehCoc(signed, maxCoc), maxCoc),
    signed,
    `signed CoC ${signed} did not survive the alpha round trip`,
    1e-9,
  );
}
near(encodeBokehCoc(0, maxCoc), 0.5, "zero CoC left the encoding midpoint");
invariant(
  encodeBokehCoc(maxCoc * 4, maxCoc) === 1 &&
    encodeBokehCoc(-maxCoc * 4, maxCoc) === 0,
  "CoC encoding stopped saturating at the clamp",
);

// ---------------------------------------------------------------------------
// Gather kernel. Generated, deterministic, exact antipodal pairs.
// ---------------------------------------------------------------------------

invariant(
  BOKEH_GATHER_BASE_TAP_COUNT === BOKEH_GATHER_BASE_KERNEL.length &&
    BOKEH_GATHER_BASE_TAP_COUNT ===
      1 + BOKEH_GATHER_BASE_RINGS * BOKEH_GATHER_BASE_PER_RING,
  "gather base kernel diverged from its centre + rings contract",
);
invariant(
  BOKEH_GATHER_FILL_TAP_COUNT === BOKEH_GATHER_FILL_KERNEL.length &&
    BOKEH_GATHER_TAP_COUNT ===
      BOKEH_GATHER_BASE_TAP_COUNT + BOKEH_GATHER_FILL_TAP_COUNT,
  "gather fill kernel diverged from the total tap budget",
);
// Half-resolution equivalence: the whole point is that a large radius costs less
// than the former small one. 61 half-res taps ~ 15.25 full-res taps, against the
// old 13 full-res gather plus 53 half-res prefilter taps (~26.25).
invariant(
  BOKEH_GATHER_TAP_COUNT * BOKEH_COC_DEFAULTS.gatherScale ** 2 < 20,
  "gather tap budget left its half-resolution equivalence",
);
invariant(
  BOKEH_COC_DEFAULTS.gatherScale === 0.5,
  "gather stopped buying radius with resolution",
);
for (const [name, kernel] of [
  ["base", BOKEH_GATHER_BASE_KERNEL],
  ["fill", BOKEH_GATHER_FILL_KERNEL],
]) {
  invariant(
    kernel.every(([x, y]) => Math.hypot(x, y) <= 1 + EPS),
    `gather ${name} kernel escaped its unit aperture`,
  );
  const offset = name === "base" ? 1 : 0;
  if (offset) {
    near(kernel[0][0], 0, "gather base kernel lost its optical centre");
    near(kernel[0][1], 0, "gather base kernel lost its optical centre");
  }
  for (let i = offset; i < kernel.length; i += 2) {
    near(kernel[i][0], -kernel[i + 1][0], `gather ${name} pair ${i} shifted the optical centre`);
    near(kernel[i][1], -kernel[i + 1][1], `gather ${name} pair ${i} shifted the optical centre`);
  }
  const radii = new Map();
  for (const [x, y] of kernel) {
    const radius = Math.hypot(x, y).toFixed(6);
    radii.set(radius, (radii.get(radius) || 0) + 1);
  }
  const rings = name === "base" ? BOKEH_GATHER_BASE_RINGS : BOKEH_GATHER_FILL_RINGS;
  const perRing = name === "base" ? BOKEH_GATHER_BASE_PER_RING : BOKEH_GATHER_FILL_PER_RING;
  const expected = [...Array(rings).fill(perRing), ...(offset ? [1] : [])].sort(
    (a, b) => a - b,
  );
  invariant(
    JSON.stringify([...radii.values()].sort((a, b) => a - b)) ===
      JSON.stringify(expected),
    `gather ${name} kernel lost its concentric ring structure`,
  );
}
// Equal-area radii: the taps must spread over the disc rather than crowd its
// centre, or a large disc bands.
const baseRadii = [
  ...new Set(
    BOKEH_GATHER_BASE_KERNEL.slice(1).map(([x, y]) => Math.hypot(x, y).toFixed(9)),
  ),
]
  .map(Number)
  .sort((a, b) => a - b);
invariant(
  baseRadii.length === BOKEH_GATHER_BASE_RINGS &&
    baseRadii.every(
      (radius, index) =>
        Math.abs(radius - Math.sqrt((index + 0.5) / BOKEH_GATHER_BASE_RINGS)) < 1e-9,
    ),
  "gather base rings left their equal-area radii",
);
// The fill ring must land in the base kernel's angular gaps or max() has nothing
// to fill.
const baseAngles = BOKEH_GATHER_BASE_KERNEL.slice(1).map(([x, y]) =>
  ((Math.atan2(y, x) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2),
);
invariant(
  BOKEH_GATHER_FILL_KERNEL.every(([x, y]) => {
    const angle = ((Math.atan2(y, x) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    return baseAngles.every((baseAngle) => Math.abs(angle - baseAngle) > 1e-6);
  }),
  "gather fill ring stopped straddling the base kernel's angular gaps",
);

// ---------------------------------------------------------------------------
// Shader discipline, shared by all three programs.
// ---------------------------------------------------------------------------

const cocShaderSource = await readFile(
  new URL("../src/env/bokeh-coc-shaders.js", import.meta.url),
  "utf8",
);
const cocPassSource = await readFile(
  new URL("../src/env/bokeh-coc-pass.js", import.meta.url),
  "utf8",
);
const prefilterFragment = BOKEH_COC_PREFILTER_FRAGMENT_SHADER;
const gatherFragment = BOKEH_COC_GATHER_FRAGMENT_SHADER;

for (const [name, body] of [
  ["composite", CIRCULAR_BOKEH_FRAGMENT_SHADER],
  ["CoC prefilter", prefilterFragment],
  ["CoC gather", gatherFragment],
]) {
  invariant(
    !/\b(?:for|while)\s*\(/.test(body),
    `${name} replaced its fixed unrolled probes with a runtime loop`,
  );
  invariant(
    !/uniform\s+\w+\s+\w+\s*\[/.test(body),
    `${name} introduced a dynamically indexed custom uniform array`,
  );
  invariant(
    !/uniform\s+float\s+(?:u)?time\b/i.test(body),
    `${name} became time-varying`,
  );
}
// Determinism: no screen-space stochastic taps anywhere in the aperture image.
// dof2 trades ringing for temporal noise; this project has hash gates and an
// explicit no-crawl policy, so the fill ring closes the gaps instead.
invariant(
  !CIRCULAR_BOKEH_FRAGMENT_SHADER.includes("gl_FragCoord") &&
    !gatherFragment.includes("gl_FragCoord"),
  "the aperture image reintroduced screen-space stochastic tap crawl",
);
invariant(
  !/\b(?:noise|dither|hash|rand)\b/i.test(gatherFragment),
  "gather traded deterministic rings for noise",
);

// ---------------------------------------------------------------------------
// The suppressors are gone, and cannot come back silently.
// ---------------------------------------------------------------------------
invariant(
  !CIRCULAR_BOKEH_FRAGMENT_SHADER.includes("surfaceRadiusPx") &&
    !CIRCULAR_BOKEH_FRAGMENT_SHADER.includes("cappedRadiusPx") &&
    !("surfaceRadiusPx" in CIRCULAR_BOKEH_DEFAULTS),
  "the 3.25px surface radius cap returned and flattened the depth layers again",
);
invariant(
  !CIRCULAR_BOKEH_FRAGMENT_SHADER.includes("contrastGate") &&
    !CIRCULAR_BOKEH_FRAGMENT_SHADER.includes("lumaSpan") &&
    !CIRCULAR_BOKEH_FRAGMENT_SHADER.includes("surfaceContrast") &&
    !("surfaceContrastLow" in CIRCULAR_BOKEH_DEFAULTS),
  "the luminance contrast gate returned and re-sharpened uniform surfaces",
);
invariant(
  !/bokehQuality\s*<=\s*0\.0/.test(CIRCULAR_BOKEH_FRAGMENT_SHADER) &&
    !/bokehQuality\s*<=\s*0\.0/.test(gatherFragment),
  "adaptive quality resumed switching depth of field off entirely",
);
// bokehQuality may only weight the fill term. The base rings run in every state,
// which is what removes the settling pop (§5.3, acceptance criterion 4).
invariant(
  gatherFragment.includes("mix(base, max(base, fill), clamp(bokehQuality, 0.0, 1.0))"),
  "bokehQuality stopped being confined to the gather's fill ring",
);
invariant(
  !/#define[^\n]*bokehQuality/.test(gatherFragment),
  "adaptive bokeh quality created a shader-program variant",
);

// ---------------------------------------------------------------------------
// Composite: one physical CoC, one upsampled gather, source transferred once.
// ---------------------------------------------------------------------------
const compositeSamplers = [
  ...CIRCULAR_BOKEH_FRAGMENT_SHADER.matchAll(/uniform\s+sampler2D\s+(\w+)\s*;/g),
]
  .map((match) => match[1])
  .sort();
invariant(
  JSON.stringify(compositeSamplers) ===
    '["tColor","tDepth","tGather","tHighlight"]',
  "composite lost original colour/depth, source ownership, or the CoC gather",
);
invariant(
  compositeSamplers.length === CIRCULAR_BOKEH_COMPOSITE_TAP_COUNT,
  "composite tap contract diverged from its sampler set",
);
invariant(
  // Tilt ramps invFocus across frame height; tiltStrength = 0 recovers the
  // ordinary thin-lens (★) curve exactly (docs/dof-cinematic-research.md §1, §4.7).
  CIRCULAR_BOKEH_FRAGMENT_SHADER.includes(
    "float invFocus = (1.0 / focus) * (1.0 + tiltStrength * (vUv.y - tiltAnchorV));",
  ) &&
    CIRCULAR_BOKEH_FRAGMENT_SHADER.includes(
      "float signedCoc = cocScalePx * (invFocus - 1.0 / max(axialDepth, nearClip));",
    ) &&
    CIRCULAR_BOKEH_FRAGMENT_SHADER.includes(
      "float cocPx = min(abs(signedCoc), maxCocPx);",
    ),
  "composite stopped evaluating the shared physical CoC curve",
);
// The gather's alpha is the radius it spent, including the near dilation. Reading
// it is what lets a defocused foreground cross a sharp subject instead of being
// clipped to its own silhouette.
invariant(
  CIRCULAR_BOKEH_FRAGMENT_SHADER.includes("float dilatedPx = gather.a * maxCocPx;") &&
    CIRCULAR_BOKEH_FRAGMENT_SHADER.includes(
      "float effectivePx = max(cocPx, dilatedPx);",
    ),
  "composite stopped honouring the gather's dilated foreground radius",
);
const sharpBranch = CIRCULAR_BOKEH_FRAGMENT_SHADER.slice(
  CIRCULAR_BOKEH_FRAGMENT_SHADER.indexOf("if (effectivePx < 0.45)"),
  CIRCULAR_BOKEH_FRAGMENT_SHADER.indexOf("vec3 centerColor ="),
);
invariant(
  (sharpBranch.match(/texture2D\s*\(\s*tColor\b/g) || []).length === 1 &&
    !sharpBranch.includes("tHighlight"),
  "sharp focus stopped taking the direct one-fetch path",
);
invariant(
  CIRCULAR_BOKEH_FRAGMENT_SHADER.includes("vec3 withoutTransferredSource") &&
    CIRCULAR_BOKEH_FRAGMENT_SHADER.includes(
      "step(highlightThreshold * 0.05, brightness)",
    ) &&
    CIRCULAR_BOKEH_FRAGMENT_SHADER.includes("step(0.5, bokehSourceScatter)") &&
    CIRCULAR_BOKEH_FRAGMENT_SHADER.includes(
      `${BOKEH_SOURCE_CONTRACT.gatherSupportCutoff}`,
    ) &&
    CIRCULAR_BOKEH_FRAGMENT_SHADER.includes("vec3 centerBase ="),
  "compact source stopped transferring exactly once out of the surface image",
);
invariant(
  CIRCULAR_BOKEH_FRAGMENT_SHADER.includes(
    "gl_FragColor = vec4(mix(centerBase, gather.rgb, mixWeight), 1.0);",
  ),
  "composite stopped blending the gather over the transferred-source base",
);

// ---------------------------------------------------------------------------
// CoC prefilter: exactly the scatter's 2x2 ownership grid, conservative peak.
// ---------------------------------------------------------------------------
invariant(
  cocShaderSource.includes("BOKEH_COC_PREFILTER_BLOCK_TAP_COUNT = BLOCK_OFFSETS.length") &&
    (prefilterFragment.match(/texture2D\(tColor/g) || []).length ===
      BOKEH_SOURCE_CONTRACT.blockSize ** 2 &&
    (prefilterFragment.match(/texture2D\(tHighlight/g) || []).length === 1,
  "CoC prefilter left the 2x2 colour block or refetched source ownership per tap",
);
invariant(
  prefilterFragment.includes("vec2 blockCenterUv = min(") &&
    prefilterFragment.includes("gl_FragCoord.xy *"),
  "CoC prefilter lost the exact block-centre alignment the scatter grid needs",
);
invariant(
  prefilterFragment.includes("if (abs(blockSigned0) > abs(peakSigned))") &&
    prefilterFragment.includes("bokehEncodeCoc(peakSigned)"),
  "CoC downsample stopped taking the conservative largest-magnitude CoC",
);
invariant(
  prefilterFragment.includes("withoutTransferredSource(blockColor0, ownership)"),
  "CoC prefilter stopped removing the transferred HDR source at downsample time",
);
invariant(
  prefilterFragment.includes("bokehSignedCocAt(getAxialDepth(") &&
    prefilterFragment.includes("float bokehSignedCocAt(float axialDepth, float screenV)") &&
    prefilterFragment.includes(
      "float bokehInvFocus(float screenV)",
    ) &&
    prefilterFragment.includes(
      "cocScalePx * (bokehInvFocus(screenV) - 1.0 / max(axialDepth, nearClip))",
    ),
  "CoC prefilter stopped sharing the composite's CoC curve",
);

// ---------------------------------------------------------------------------
// Gather: fixed rings, near dilation, background bleed rejection.
// ---------------------------------------------------------------------------
invariant(
  (gatherFragment.match(/texture2D\(tCoc/g) || []).length ===
    BOKEH_COC_GATHER_TEXTURE_TAP_COUNT &&
    BOKEH_COC_GATHER_TEXTURE_TAP_COUNT ===
      1 + BOKEH_GATHER_NEAR_DILATE_TAP_COUNT + BOKEH_GATHER_TAP_COUNT &&
    BOKEH_COC_NEAR_DILATE_OFFSETS.length === BOKEH_GATHER_NEAR_DILATE_TAP_COUNT,
  "gather fetch count diverged from centre + near dilate + base + fill",
);
invariant(
  cocShaderSource.includes("BOKEH_COC_NEAR_DILATE_OFFSETS = Object.freeze") &&
    cocShaderSource.includes("[-1, 0, 1].flatMap") &&
    gatherFragment.includes("nearDilatedPx = max(nearDilatedPx, max(0.0, -dilateSigned0));") &&
    gatherFragment.includes(
      "float centerRadiusPx = max(abs(centerSigned), nearDilatedPx) * 0.5;",
    ),
  "gather lost the 3x3 near max-dilate that lets the foreground leave its silhouette",
);
// Background may not bleed onto a sharper centre; foreground keeps only its own
// reach so it can spread inward. This is pmndrs' MaskMaterial without the pass.
invariant(
  gatherFragment.includes("float behind = step(centerSigned, tapSigned);") &&
    gatherFragment.includes(
      "float reachPx = mix(tapRadiusPx, min(centerRadiusPx, tapRadiusPx), behind);",
    ) &&
    gatherFragment.includes("clamp(reachPx - offsetPx + 1.0, 0.0, 1.0)"),
  "gather lost its scatter-as-gather acceptance and will halo sharp silhouettes",
);
invariant(
  gatherFragment.includes("if (centerRadiusPx < 0.5)"),
  "gather stopped short-circuiting the in-focus region",
);

// ---------------------------------------------------------------------------
// Installation.
// ---------------------------------------------------------------------------
near(
  CIRCULAR_BOKEH_DEFAULTS.sourceRadiusScale,
  BOKEH_COC_DEFAULTS.sourceRadiusScale,
  "composite and CoC contract disagree on the compact-source multiplier",
);
invariant(
  CIRCULAR_BOKEH_DEFAULTS.sourceRadiusScale > 1,
  "compact HDR sources lost their deliberately larger disc",
);
const fakeBokehMaterial = {
  uniforms: { focus: { value: 1 } },
  fragmentShader: "",
  needsUpdate: false,
};
installCircularBokeh(fakeBokehMaterial);
invariant(
  fakeBokehMaterial.uniforms.focus.value === 1 &&
    fakeBokehMaterial.uniforms.cocScalePx.value === 0 &&
    fakeBokehMaterial.uniforms.maxCocPx.value === 0 &&
    fakeBokehMaterial.uniforms.bokehRadiusScale.value ===
      CIRCULAR_BOKEH_DEFAULTS.sourceRadiusScale &&
    fakeBokehMaterial.uniforms.bokehQuality.value === 1 &&
    fakeBokehMaterial.uniforms.tHighlight.value === null &&
    fakeBokehMaterial.uniforms.tGather.value === null &&
    fakeBokehMaterial.fragmentShader === CIRCULAR_BOKEH_FRAGMENT_SHADER &&
    fakeBokehMaterial.needsUpdate,
  "circular bokeh installation broke BokehPass uniforms or shader ownership",
);
// cocScalePx must start at zero and be resolved from the live camera: baking it
// would freeze the depth of field at one lens.
invariant(
  !CIRCULAR_BOKEH_FRAGMENT_SHADER.includes(`${cocScale}`) &&
    !gatherFragment.includes(`${cocScale}`) &&
    !prefilterFragment.includes(`${cocScale}`) &&
    /uniform\s+float\s+cocScalePx\s*;/.test(prefilterFragment),
  "the CoC pixel scale was baked into a shader instead of resolved per frame",
);

invariant(
    BOKEH_SOURCE_CONTRACT.blockSize === 2 &&
    BOKEH_SOURCE_CONTRACT.exactOwnershipAlpha === 1 &&
    BOKEH_SOURCE_CONTRACT.gatherSupportAlpha === 0.25 &&
    BOKEH_SOURCE_CONTRACT.gatherSupportCutoff === 0.125 &&
    BOKEH_SOURCE_CONTRACT.exactOwnershipCutoff === 0.75 &&
    BOKEH_SOURCE_CONTRACT.ownershipBroadSupportCutoff === 0.3 &&
    BOKEH_SOURCE_CONTRACT.sharpRadiusPx === 0.45 &&
    BOKEH_SOURCE_CONTRACT.pointCoverage === 2 &&
    BOKEH_SOURCE_CONTRACT.profileCore > 0 &&
    BOKEH_SOURCE_CONTRACT.profileRim > 0,
  "source scatter lost disjoint ownership or its filled optical profile",
);
const oddGrid = bokehSourceGridDimensions(961, 601);
invariant(
  oddGrid.columns === 481 && oddGrid.rows === 301,
  "source scatter dropped the partial ownership block at an odd viewport edge",
);
const oddLastUv = bokehSourceCellUv(961, 601, 480, 300);
near(
  oddLastUv[0],
  961 / 961,
  "odd viewport source-cell U lost its exact block centre",
);
near(
  oddLastUv[1],
  601 / 601,
  "odd viewport source-cell V lost its exact block centre",
);
for (const [required, cap, expected] of [
  [64, 64, false],
  [64.01, 64, true],
  [69.5, 70, false],
  [70.01, 70, true],
  [255.1, 256, false],
  [256.01, 256, true],
]) {
  invariant(
    bokehSourceNeedsTriangles(required, cap) === expected,
    `point-cap raster boundary diverged for ${required}px against ${cap}px`,
  );
}
invariant(
  selectBokehSourceBackend("points", 70.01, 70) === "triangles" &&
    selectBokehSourceBackend("triangles", 1, 256) === "triangles",
  "source scatter no longer promotes safely or its triangle promotion reversed",
);
near(
  BOKEH_SOURCE_CONTRACT.profileCore +
    (2 * BOKEH_SOURCE_CONTRACT.profileRim) /
      (BOKEH_SOURCE_CONTRACT.profilePower + 2),
  BOKEH_SOURCE_CONTRACT.profileIntegral,
  "source scatter hard-disc profile normalization stopped conserving continuous energy",
  1e-8,
);
const sourceScatterSource = await readFile(
  new URL("../src/env/bokeh-source-scatter.js", import.meta.url),
  "utf8",
);
const rejectVertexBody =
  sourceScatterSource.match(/void rejectVertex\(\) \{([\s\S]*?)\n  \}/)?.[1] ||
  "";
invariant(
  rejectVertexBody.includes("gl_PointSize = 0.0;") &&
    rejectVertexBody.includes(
      "gl_Position = vec4(2.0, 2.0, 2.0, 1.0);",
    ) &&
    !rejectVertexBody.includes("vSource") &&
    !rejectVertexBody.includes("vCellPixel"),
  "empty source blocks resumed initializing varyings that clipped primitives cannot read",
);
invariant(
  !sourceScatterSource.includes("compactCore(") &&
    sourceScatterSource.includes("return gatedSource;") &&
    sourceScatterSource.includes("if (compactWeight(cellUv) < 0.5)") &&
    sourceScatterSource.includes(
      "BOKEH_SOURCE_CONTRACT.exactOwnershipCutoff",
    ) &&
    (
      sourceScatterSource.match(/uniform sampler2D tSource;/g) || []
    ).length === 2 &&
    (
      sourceScatterSource.match(/uniform sampler2D tColor;/g) || []
    ).length === 2 &&
    sourceScatterSource.includes(
      "step(highlightThreshold * 0.05, peak);",
    ) &&
    sourceScatterSource.includes("sharesSourceComponent(") &&
    sourceScatterSource.includes("sharesDepthLayer(") &&
    sourceScatterSource.includes("hueAligned(") &&
    sourceScatterSource.includes(
      "(destinationBlock + vec2(0.5)) / gridSize",
    ) &&
    sourceScatterSource.includes("if (destinationPeak < 0.0)") &&
    sourceScatterSource.includes(
      "if (vSourceRadii.${VECTOR_COMPONENTS[index]} > 0.0)",
    ) &&
    !sourceScatterSource.includes("pow(radial,") &&
    sourceScatterSource.includes("componentPeak${sourceIndex}") &&
    !sourceScatterSource.includes("considerPeak(") &&
    !sourceScatterSource.includes("resolveSourceDepth(") &&
    !sourceScatterSource.includes("sharesSourceSurface(") &&
    sourceScatterSource.includes("vec3 ownedSource${index} = gatedRawSource") &&
    sourceScatterSource.includes(
      "ownedDepth${index} = viewDepth(ownedUv${index})",
    ) &&
    // Depth stays a per-texel read, but the *radius* comes from the block's elected
    // emitter depth. A partial-coverage silhouette texel holds the background's depth
    // while carrying the emitter's radiance, so taking its own depth splatted the
    // emitter's energy at the background's circle of confusion - measured as a 5.25px
    // hot core inside a 35.97px disc once the scene render became multisampled.
    // Hue alignment is the whole test on purpose: requiring the depths to agree first
    // (sharesSourceComponent) can never repair a silhouette.
    sourceScatterSource.includes("float blockSourceDepth${index} =") &&
    sourceScatterSource.includes(
      "hueAligned(ownedSource${index}, dominantSource)",
    ) &&
    sourceScatterSource.includes(
      "sourceRadiusAtDepth(blockSourceDepth${index})",
    ) &&
    sourceScatterSource.includes(" = blockSourceDepth${index};") &&
    !/sourceRadiusAtDepth\(ownedDepth\$\{index\}\)/.test(
      sourceScatterSource,
    ) &&
    sourceScatterSource.includes(
      "sourceNormalizations.${VECTOR_COMPONENTS[index]}",
    ) &&
    sourceScatterSource.includes(
      "scatteredEnergy += vSourceEnergy${index}",
    ) &&
    sourceScatterSource.includes(
      "bool acceptsSource${index} =",
    ) &&
    sourceScatterSource.indexOf("if (radiusPx >= 7.0)") <
      sourceScatterSource.indexOf(
        "float discreteNormalization = 0.0;",
      ) &&
    sourceScatterSource.includes("float discreteNormalization = 0.0;") &&
    sourceScatterSource.includes("smoothstep(6.0, 7.0, radiusPx)") &&
    sourceScatterSource.includes(
      "float pointRadiusPx = maxSourceRadius + 1.0;",
    ) &&
    sourceScatterSource.includes(
      "float triangleRadiusPx = maxSourceRadius + 1.2071067812;",
    ) &&
    sourceScatterSource.includes("BOKEH_SOURCE_CONTRACT.sharpRadiusPx") &&
    sourceScatterSource.includes("this.renderCount++") &&
    sourceScatterSource.includes("int column = gl_InstanceID % gridColumns;") &&
    !sourceScatterSource.includes("float(gl_InstanceID)") &&
    sourceScatterSource.includes("new InstancedBufferGeometry()") &&
    sourceScatterSource.includes("selectBokehSourceBackend(") &&
    !sourceScatterSource.includes("setAttribute('cellUv'") &&
    !sourceScatterSource.includes("WebGLRenderTarget"),
  "source scatter lost single acceptance, block-elected emitter depth, procedural instancing, cap fallback, or +0 RT",
);

// The scatter now evaluates the same thin-lens curve the surface gather does,
// with one deliberate source-only multiplier on top (docs/dof-cinematic-research.md
// sections 4.3 and 8). The former linear `(focus - z) * aperture` had no
// perspective falloff and no near/far asymmetry.
invariant(
  // Same Scheimpflug invFocus the surface gather uses, evaluated at the
  // block's cellUv so a lantern and the wall behind it agree on radius.
  sourceScatterSource.includes(
    "gInvFocus = (1.0 / focus) * (1.0 + tiltStrength * (cellUv.y - tiltAnchorV));",
  ) &&
    sourceScatterSource.includes(
      "cocScalePx * (gInvFocus - 1.0 / max(sourceDepth, nearClip))",
    ) &&
    sourceScatterSource.includes("min(abs(signedCoc), maxCocPx) * radiusScale") &&
    sourceScatterSource.includes("uniform float cocScalePx;") &&
    sourceScatterSource.includes("uniform float maxCocPx;") &&
    sourceScatterSource.includes("uniform float tiltStrength;") &&
    !/uniform float maxblur;/.test(sourceScatterSource) &&
    !/\(focus - sourceDepth\) \* aperture/.test(sourceScatterSource),
  "source scatter kept the old linear blur curve instead of the shared CoC",
);
// Its point-size cap fallback must be bounded by the absolute clamped disc, not
// by a maxblur/viewport-width product that grows with a wider window.
invariant(
  sourceScatterSource.includes(
    "(maxCocPx * radiusScale + 1.0) * BOKEH_SOURCE_CONTRACT.pointCoverage",
  ),
  "source scatter point-size promotion stopped following the clamped CoC",
);

const stableBokehSource = await readFile(
  new URL("../src/env/stable-bokeh-pass.js", import.meta.url),
  "utf8",
);
invariant(
  stableBokehSource.includes("dofDepthMaterialForObject(object)") &&
    stableBokehSource.indexOf("if (sourceDepthMaterial)") <
      stableBokehSource.indexOf(
        'object.geometry?.getAttribute?.("instFade")',
      ) &&
    stableBokehSource.includes("sourceDepthMaterialCount") &&
    stableBokehSource.includes(
      "materials.push(object, object.material, sourceDepthMaterial);",
    ) &&
    stableBokehSource.includes("debugResources()"),
  "StableBokehPass lost the explicit source-depth material precedence or diagnostics",
);

// The one CPU resolver that folds aperture, viewport height, and live fov into
// that uniform must stay in the pass, and must read fov every frame.
invariant(
  stableBokehSource.includes("_resolveCocScale()") &&
    stableBokehSource.includes("this.camera.fov") &&
    stableBokehSource.includes("bokehCocScalePx(") &&
    stableBokehSource.includes("this.uniforms.aperture.value"),
  "the live CoC resolver lost the aperture ramp or the live lens fov",
);
invariant(
  stableBokehSource.includes("this._cocPass.render(renderer, {") &&
    stableBokehSource.includes("this.uniforms.tGather.value =") &&
    stableBokehSource.indexOf("this._cocPass.render(renderer, {") <
      stableBokehSource.indexOf("this._fsQuad.render(renderer)") &&
    stableBokehSource.indexOf("this._fsQuad.render(renderer)") <
      stableBokehSource.indexOf("this._sourceScatter.render("),
  "the DoF pass order left depth prepass -> CoC gather -> composite -> scatter",
);
// The source scatter must spend the same CoC curve, or a lantern and the wall
// behind it disagree about how defocused they are.
invariant(
  stableBokehSource.includes("this.cocScalePx,") &&
    stableBokehSource.includes("this.maxCocPx,") &&
    !stableBokehSource.includes("this.uniforms.maxblur.value,"),
  "the source scatter stopped sharing the physical CoC curve",
);

const highlightPrefilterSource = await readFile(
  new URL("../src/env/bokeh-highlight-prefilter.js", import.meta.url),
  "utf8",
);
invariant(
  BOKEH_HIGHLIGHT_PREFILTER_ANALYTIC_TAP_COUNT === 37 &&
  BOKEH_HIGHLIGHT_PREFILTER_OWNERSHIP_TAP_COUNT === 4 &&
    BOKEH_HIGHLIGHT_PREFILTER_GUARD_EXTRA_TAP_COUNT === 12 &&
    BOKEH_HIGHLIGHT_PREFILTER_TOTAL_TAP_COUNT === 53 &&
    highlightPrefilterSource.includes("PREFILTER_KERNEL.length !==") &&
    highlightPrefilterSource.includes(
      "const PREFILTER_SAMPLE_LINES = PREFILTER_KERNEL.map",
    ) &&
    highlightPrefilterSource.includes("[12, 1.5, false]") &&
    highlightPrefilterSource.includes("[16, 3.5, false]") &&
    highlightPrefilterSource.includes("[8, 9, true]") &&
    highlightPrefilterSource.includes("vec2 blockCenterUv = min(") &&
    highlightPrefilterSource.includes("gl_FragCoord.xy *"),
  "highlight prefilter lost its half-resolution analytic 37 + ownership 4 + guard 12 = 53 fetch budget",
);
const highlightPrefilterFragment = highlightPrefilterSource.slice(
  highlightPrefilterSource.indexOf(
    "export const BOKEH_HIGHLIGHT_PREFILTER_FRAGMENT_SHADER",
  ),
  highlightPrefilterSource.indexOf("const VERTEX_SHADER"),
);
invariant(
  !/\b(?:for|while)\s*\(/.test(highlightPrefilterFragment),
  "highlight prefilter introduced a runtime shader loop",
);
invariant(
  highlightPrefilterSource.includes("const OWNERSHIP_OFFSETS = Object.freeze") &&
    highlightPrefilterSource.includes("[-0.5, -0.5]") &&
    highlightPrefilterSource.includes("[0.5, 0.5]") &&
    highlightPrefilterSource.includes(
      "const GATHER_SUPPORT_OFFSETS = Object.freeze",
    ) &&
    highlightPrefilterSource.includes("[-1.5, -0.5, 0.5, 1.5].flatMap") &&
    highlightPrefilterFragment.includes("${OWNERSHIP_SAMPLE_LINES}") &&
    highlightPrefilterFragment.includes("${GATHER_SUPPORT_SAMPLE_LINES}"),
  "highlight prefilter lost its exact 2x2 ownership or adjacent 4x4 gather footprint",
);
invariant(
    highlightPrefilterFragment.includes("float blockPeakRawEnergy = max(") &&
    highlightPrefilterFragment.includes(
      "float gatherSupportPeakRawEnergy = 0.0",
    ) &&
    highlightPrefilterFragment.includes(
      "float analyticPeakRawEnergy = 0.0",
    ) &&
    highlightPrefilterFragment.includes("float broadSupport = 0.0") &&
    highlightPrefilterFragment.includes(
      "any(greaterThan(uv, vec2(1.0)))",
    ) &&
    highlightPrefilterFragment.includes("broadSupport /= 8.0") &&
    highlightPrefilterSource.includes(
      "max(analyticPeakRawEnergy, 0.0001)",
    ) &&
    highlightPrefilterFragment.includes("float compactSupport = (") &&
    highlightPrefilterFragment.includes("gatherSupportPeakRawEnergy") &&
    highlightPrefilterFragment.includes(
      "float compactOwnership = compactSupport * step(",
    ) &&
    highlightPrefilterFragment.includes("float encodedCompact = max(") &&
    highlightPrefilterFragment.includes(
      "BOKEH_SOURCE_CONTRACT.exactOwnershipAlpha",
    ) &&
    highlightPrefilterFragment.includes(
      "BOKEH_SOURCE_CONTRACT.gatherSupportAlpha",
    ) &&
    highlightPrefilterFragment.includes(
      "BOKEH_SOURCE_CONTRACT.ownershipBroadSupportCutoff",
    ) &&
    highlightPrefilterFragment.includes(
      "gl_FragColor = vec4(source, encodedCompact);",
    ) &&
    !highlightPrefilterFragment.includes("? rawPeak"),
  "highlight prefilter compact ownership lost broad-support classification",
);
invariant(
    !highlightPrefilterFragment.includes("tDepth") &&
    !highlightPrefilterFragment.includes("sourceRadiusPx") &&
    highlightPrefilterFragment.includes("compactSupport = ("),
  "highlight prefilter mixed source-local CoC into shared compact evidence",
);
invariant(
  highlightPrefilterSource.includes("Math.ceil(this.sourceWidth * 0.5)") &&
    highlightPrefilterSource.includes("Math.ceil(this.sourceHeight * 0.5)") &&
    highlightPrefilterSource.includes("depthBuffer: false") &&
    highlightPrefilterSource.includes("stencilBuffer: false") &&
    highlightPrefilterSource.includes(
      "renderer.setRenderTarget(previousTarget);",
    ) &&
    highlightPrefilterSource.includes("this.target.dispose()"),
  "highlight prefilter lost its one half-resolution color-only target",
);

const qualitySource = await readFile(
  new URL("../src/env/post-quality-state.js", import.meta.url),
  "utf8",
);
invariant(
  !/\b(?:three|document|window|performance|Date|requestAnimationFrame|setTimeout)\b/.test(
    qualitySource,
  ),
  "pure post quality state acquired a renderer, DOM, wall-clock, or timer dependency",
);

function advanceQuality(state, duration, speed, step) {
  let elapsed = 0;
  while (elapsed < duration - EPS) {
    const dt = Math.min(step, duration - elapsed);
    const same = state.update(dt, speed * dt);
    invariant(
      same === state,
      "post quality update replaced its mutable state object",
    );
    elapsed += dt;
  }
  return state.quality;
}

function qualityTrace(step) {
  const state = createPostQualityState();
  const checkpoints = [];
  for (const [duration, speed] of [
    [0.2, 30],
    [0.1, 0],
    [0.05, 0],
    [0.07, 0],
    [0.12, 0],
  ])
    checkpoints.push(advanceQuality(state, duration, speed, step));
  return { state, checkpoints };
}

const quality60 = qualityTrace(1 / 60);
const quality120 = qualityTrace(1 / 120);
const qualityLong = qualityTrace(0.1);
for (let i = 0; i < quality60.checkpoints.length; i++) {
  near(
    quality60.checkpoints[i],
    quality120.checkpoints[i],
    `60/120Hz quality diverged at ${i}`,
    1e-3,
  );
  near(
    quality60.checkpoints[i],
    qualityLong.checkpoints[i],
    `long-frame quality diverged at ${i}`,
    1e-3,
  );
}
invariant(
  quality60.checkpoints[0] === 0 && quality60.checkpoints[1] === 0,
  "moving and hold phases did not stay at exact low quality",
);
invariant(
  quality60.checkpoints[2] > 0 && quality60.checkpoints[2] < 1,
  "settling did not begin continuously after the hold",
);
near(quality60.state.quality, 1, "settling did not end at exact full quality");
invariant(
  quality60.state.mode === "stable",
  "settling did not end in stable mode",
);
// Binary fill scale + motionBudget: low for any non-stable mode (no per-frame
// RT thrash), full only when fully settled. Bokeh quality may still ramp.
{
  const fill = createPostQualityState();
  fill.update(0.05, 30 * 0.05);
  invariant(
    fill.mode === "moving" && fill.fillScale < 1 && fill.fillScale >= 0.5,
    "moving mode did not drop composer fill scale",
  );
  invariant(
    fill.motionBudget === true,
    "moving mode did not raise motionBudget",
  );
  const movingScale = fill.fillScale;
  advanceQuality(fill, 0.15, 0, 0.05);
  invariant(
    fill.mode === "settling" && fill.fillScale === movingScale,
    "settling changed fill scale mid-ramp (would reallocate every RT)",
  );
  invariant(
    fill.motionBudget === true,
    "settling cleared motionBudget mid-ramp",
  );
  advanceQuality(fill, 0.3, 0, 0.05);
  invariant(
    fill.mode === "stable" && fill.fillScale === 1,
    "stable mode did not restore full fill scale",
  );
  invariant(
    fill.motionBudget === false,
    "stable mode left motionBudget raised",
  );
  invariant(
    fill.reset().fillScale === 1 && fill.motionBudget === false,
    "reset did not restore full fill scale / clear motionBudget",
  );
}

const hysteresis = createPostQualityState();
hysteresis.update(0.05, 30 * 0.05);
hysteresis.update(0.1, 10 * 0.1);
invariant(
  hysteresis.mode === "moving" && hysteresis.quality === 0,
  "between-threshold speed caused moving/stable chatter",
);
advanceQuality(hysteresis, 0.2, 0, 0.05);
const beforeReverse = hysteresis.quality;
invariant(
  beforeReverse > 0 && beforeReverse < 1,
  "reversal fixture never entered settling",
);
hysteresis.update(0.05, 30 * 0.05);
invariant(
  hysteresis.mode === "moving" && hysteresis.quality === 0,
  "settling reversal overshot or failed to return immediately to moving",
);
invariant(
  hysteresis.reset() === hysteresis &&
    hysteresis.quality === 1 &&
    hysteresis.mode === "stable",
  "post quality reset did not restore the same object to stable quality",
);

const trackedCamera = {
  position: { x: 0, y: 0, z: 0 },
  quaternion: { x: 0, y: 0, z: 0, w: 1 },
  fov: 40,
  zoom: 1,
  view: null,
};
const cameraMotion = createCameraMotionTracker();
near(
  cameraMotion.sample(trackedCamera, 1000, 600, 10),
  0,
  "first camera snapshot created synthetic motion",
);
trackedCamera.position.x = 0.1;
invariant(
  cameraMotion.sample(trackedCamera, 1000, 600, 10) > 0,
  "position-only camera motion was not measured",
);
near(
  cameraMotion.sample(trackedCamera, 1000, 600, 10),
  0,
  "static camera snapshot retained prior motion",
);
cameraMotion.reset();
cameraMotion.sample(trackedCamera, 1000, 600, 10);
trackedCamera.quaternion.w = -1;
near(
  cameraMotion.sample(trackedCamera, 1000, 600, 10),
  0,
  "quaternion sign-equivalent snapshot created synthetic rotation",
);
trackedCamera.quaternion.z = Math.sin(0.01);
trackedCamera.quaternion.w = -Math.cos(0.01);
invariant(
  cameraMotion.sample(trackedCamera, 1000, 600, 10) > 0,
  "quaternion-only camera motion was not measured",
);
trackedCamera.fov = 41;
invariant(
  cameraMotion.sample(trackedCamera, 1000, 600, 10) > 0,
  "FOV-only camera motion was not measured",
);
trackedCamera.view = {
  enabled: true,
  fullWidth: 1000,
  fullHeight: 600,
  offsetX: 12,
  offsetY: -8,
  width: 1000,
  height: 600,
};
invariant(
  cameraMotion.sample(trackedCamera, 1000, 600, 10) > 0,
  "view-offset-only camera motion was not measured",
);
cameraMotion.reset();
trackedCamera.position.x = 5;
near(
  cameraMotion.sample(trackedCamera, 1200, 700, 10),
  0,
  "resize/reset snapshot created synthetic camera motion",
);

console.log("DOF CONTRACT: PASS");
