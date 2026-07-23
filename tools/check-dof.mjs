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
  CIRCULAR_BOKEH_DEFAULTS,
  CIRCULAR_BOKEH_FRAGMENT_SHADER,
  CIRCULAR_BOKEH_KERNEL,
  CIRCULAR_BOKEH_MOVING_KERNEL,
  CIRCULAR_BOKEH_SAMPLE_COUNT,
  MOVING_BOKEH_SAMPLE_COUNT,
  installCircularBokeh,
} from "../src/env/circular-bokeh-shader.js";
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

invariant(
  CIRCULAR_BOKEH_SAMPLE_COUNT === CIRCULAR_BOKEH_KERNEL.length,
  "circular bokeh sample contract diverged from its generated kernel",
);
invariant(
  CIRCULAR_BOKEH_SAMPLE_COUNT <= 41,
  "cinematic bokeh exceeded the stock pass color-fetch budget",
);
near(
  CIRCULAR_BOKEH_DEFAULTS.radiusScale,
  2.4,
  "cinematic bokeh lost its expanded telephoto aperture radius",
);
invariant(
  MOVING_BOKEH_SAMPLE_COUNT === 13 &&
    MOVING_BOKEH_SAMPLE_COUNT === CIRCULAR_BOKEH_MOVING_KERNEL.length,
  "moving bokeh lost its 13-tap budget",
);
invariant(
  CIRCULAR_BOKEH_KERNEL.every(([x, y]) => Math.hypot(x, y) <= 1 + EPS),
  "circular bokeh kernel escaped its unit aperture",
);
const radialCounts = new Map();
for (const [x, y] of CIRCULAR_BOKEH_KERNEL) {
  const radius = Math.hypot(x, y).toFixed(6);
  radialCounts.set(radius, (radialCounts.get(radius) || 0) + 1);
}
invariant(
  JSON.stringify([...radialCounts.values()].sort((a, b) => a - b)) ===
    "[1,8,12,20]",
  "circular bokeh lost its center + 8/12/20 concentric aperture budget",
);
for (let i = 1; i < CIRCULAR_BOKEH_KERNEL.length; i += 2) {
  const a = CIRCULAR_BOKEH_KERNEL[i];
  const b = CIRCULAR_BOKEH_KERNEL[i + 1];
  near(a[0], -b[0], `bokeh pair ${i} shifted the optical center`);
  near(a[1], -b[1], `bokeh pair ${i} shifted the optical center`);
}
const movingRadialCounts = new Map();
for (const [x, y] of CIRCULAR_BOKEH_MOVING_KERNEL) {
  const radius = Math.hypot(x, y).toFixed(6);
  movingRadialCounts.set(radius, (movingRadialCounts.get(radius) || 0) + 1);
}
invariant(
  JSON.stringify([...movingRadialCounts.values()].sort((a, b) => a - b)) ===
    "[1,4,4,4]",
  "moving bokeh stopped sampling every authored aperture ring",
);
near(
  CIRCULAR_BOKEH_MOVING_KERNEL[0][0],
  0,
  "moving bokeh lost its optical center",
);
near(
  CIRCULAR_BOKEH_MOVING_KERNEL[0][1],
  0,
  "moving bokeh lost its optical center",
);
for (let i = 1; i < CIRCULAR_BOKEH_MOVING_KERNEL.length; i += 2) {
  const a = CIRCULAR_BOKEH_MOVING_KERNEL[i];
  const b = CIRCULAR_BOKEH_MOVING_KERNEL[i + 1];
  near(a[0], -b[0], `moving bokeh pair ${i} shifted the optical center`);
  near(a[1], -b[1], `moving bokeh pair ${i} shifted the optical center`);
}
invariant(
  !/uniform\s+\w+\s+\w+\s*\[/.test(CIRCULAR_BOKEH_FRAGMENT_SHADER),
  "circular bokeh introduced a dynamically indexed custom uniform array",
);
invariant(
  !CIRCULAR_BOKEH_FRAGMENT_SHADER.includes("gl_FragCoord"),
  "circular bokeh reintroduced screen-space stochastic tap crawl",
);
invariant(
  !/uniform\s+float\s+(?:u)?time\b/i.test(CIRCULAR_BOKEH_FRAGMENT_SHADER),
  "circular bokeh became time-varying",
);
const movingCalls = (
  CIRCULAR_BOKEH_FRAGMENT_SHADER.match(
    /\bvec3\s+movingSample\d+\s*=\s*texture2D\s*\(/g,
  ) || []
).length;
const fullOnlyCalls =
  (CIRCULAR_BOKEH_FRAGMENT_SHADER.match(/\baccumulateFullSample\s*\(/g) || [])
    .length - 1;
invariant(
  movingCalls === MOVING_BOKEH_SAMPLE_COUNT &&
    movingCalls + fullOnlyCalls === CIRCULAR_BOKEH_SAMPLE_COUNT,
  "adaptive bokeh shader fetch counts diverged from the 13/41 contract",
);
const movingHighlightCalls = (
  CIRCULAR_BOKEH_FRAGMENT_SHADER.match(
    /\bvec4\s+movingHighlight\d+\s*=\s*texture2D\s*\(\s*tHighlight/g,
  ) || []
).length;
invariant(
  movingHighlightCalls === MOVING_BOKEH_SAMPLE_COUNT &&
    CIRCULAR_BOKEH_FRAGMENT_SHADER.includes(
      "vec4 highlightSample = texture2D(tHighlight, uv);",
    ),
  "adaptive bokeh stopped consuming the normalized highlight prefilter",
);
const sharpBranch = CIRCULAR_BOKEH_FRAGMENT_SHADER.slice(
  CIRCULAR_BOKEH_FRAGMENT_SHADER.indexOf("if (blurRadiusPx < 0.45)"),
  CIRCULAR_BOKEH_FRAGMENT_SHADER.indexOf("float cocMix ="),
);
invariant(
  (sharpBranch.match(/texture2D\s*\(\s*tColor\b/g) || []).length === 1 &&
    !sharpBranch.includes("considerForegroundSource") &&
    !CIRCULAR_BOKEH_FRAGMENT_SHADER.includes("resolvedPeak") &&
    !CIRCULAR_BOKEH_FRAGMENT_SHADER.includes("20.0 / max("),
  "obsolete reverse source probe or fitted source-area constant survived",
);
invariant(
  CIRCULAR_BOKEH_FRAGMENT_SHADER.includes(
    "return max(color - transferHighlightMean, vec3(0.0));",
  ) &&
    CIRCULAR_BOKEH_FRAGMENT_SHADER.includes(
      "rawHighlightSum += rawHighlight;",
    ) &&
    CIRCULAR_BOKEH_FRAGMENT_SHADER.includes(
      "transferHighlightSum += scatterCandidate;",
    ) &&
    CIRCULAR_BOKEH_FRAGMENT_SHADER.includes(
      "vec3 scatterCandidate = sampleColor",
    ) &&
    CIRCULAR_BOKEH_FRAGMENT_SHADER.includes("* compactWeight;") &&
    CIRCULAR_BOKEH_FRAGMENT_SHADER.includes(
      `${BOKEH_SOURCE_CONTRACT.gatherSupportCutoff}`,
    ) &&
    CIRCULAR_BOKEH_FRAGMENT_SHADER.includes(
      "step(highlightThreshold * 0.05, brightness)",
    ) &&
    !CIRCULAR_BOKEH_FRAGMENT_SHADER.includes("compactPeak") &&
    !CIRCULAR_BOKEH_FRAGMENT_SHADER.includes(
      "sampleColor * step(0.0001, highlightSample.a)",
    ) &&
    CIRCULAR_BOKEH_FRAGMENT_SHADER.includes("if (bokehSourceScatter > 0.5)"),
  "compact source gather stopped transferring the continuous gated candidate",
);
const samplerUniforms = [
  ...CIRCULAR_BOKEH_FRAGMENT_SHADER.matchAll(
    /uniform\s+sampler2D\s+(\w+)\s*;/g,
  ),
]
  .map((match) => match[1])
  .sort();
invariant(
  JSON.stringify(samplerUniforms) === '["tColor","tDepth","tHighlight"]',
  "source-depth repair lost original color/depth or the separate source prefilter",
);
invariant(
  !/\b(?:for|while)\s*\(/.test(CIRCULAR_BOKEH_FRAGMENT_SHADER),
  "source-depth repair replaced fixed probes with a runtime loop",
);
invariant(
  /uniform\s+float\s+bokehQuality\s*;/.test(CIRCULAR_BOKEH_FRAGMENT_SHADER) &&
    CIRCULAR_BOKEH_FRAGMENT_SHADER.includes(
      "if (bokehQuality > 0.0 || preserveHighlight)",
    ) &&
    CIRCULAR_BOKEH_FRAGMENT_SHADER.includes("preserveHighlight") &&
    CIRCULAR_BOKEH_FRAGMENT_SHADER.includes("outputQuality >= 1.0"),
  "adaptive bokeh lost its moving/HDR branch or exact stable result",
);
invariant(
  !/#define[^\n]*bokehQuality/.test(CIRCULAR_BOKEH_FRAGMENT_SHADER),
  "adaptive bokeh quality created a shader-program variant",
);
invariant(
  (CIRCULAR_BOKEH_FRAGMENT_SHADER.match(/\bsmoothstep\s*\(/g) || []).length ===
    4 &&
    CIRCULAR_BOKEH_FRAGMENT_SHADER.includes(
      "vec3 color = colorSum / sampleCount;",
    ) &&
    CIRCULAR_BOKEH_FRAGMENT_SHADER.includes(
      "vec3 rawHighlightMean = rawHighlightSum / sampleCount;",
    ) &&
    CIRCULAR_BOKEH_FRAGMENT_SHADER.includes(
      "vec3 preservedColor = max(color - rawHighlightMean, vec3(0.0));",
    ) &&
    CIRCULAR_BOKEH_FRAGMENT_SHADER.includes(
      "return mix(color, analyticColor, highlight);",
    ) &&
    CIRCULAR_BOKEH_FRAGMENT_SHADER.includes(
      "float profileIntegral = 0.82 + 2.0 * rimStrength / 6.0;",
    ) &&
    !CIRCULAR_BOKEH_FRAGMENT_SHADER.includes("reconstructionBrightness"),
  "bounded reconstruction stopped redistributing the gathered source mean",
);
const fakeBokehMaterial = {
  uniforms: { focus: { value: 1 } },
  fragmentShader: "",
  needsUpdate: false,
};
installCircularBokeh(fakeBokehMaterial);
invariant(
  fakeBokehMaterial.uniforms.focus.value === 1 &&
    fakeBokehMaterial.uniforms.highlightGain.value > 0 &&
    fakeBokehMaterial.uniforms.bokehRadiusScale.value === 2.4 &&
    fakeBokehMaterial.uniforms.bokehQuality.value === 1 &&
    fakeBokehMaterial.uniforms.tHighlight.value === null &&
    fakeBokehMaterial.fragmentShader === CIRCULAR_BOKEH_FRAGMENT_SHADER &&
    fakeBokehMaterial.needsUpdate,
  "circular bokeh installation broke BokehPass uniforms or shader ownership",
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
      "float ownedDepth${index} = viewDepth(ownedUv${index})",
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
  "source scatter lost single acceptance, owned depth, procedural instancing, cap fallback, or +0 RT",
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

const highlightPrefilterSource = await readFile(
  new URL("../src/env/bokeh-highlight-prefilter.js", import.meta.url),
  "utf8",
);
invariant(
  BOKEH_HIGHLIGHT_PREFILTER_ANALYTIC_TAP_COUNT === 37 &&
    BOKEH_HIGHLIGHT_PREFILTER_OWNERSHIP_TAP_COUNT === 4 &&
    BOKEH_HIGHLIGHT_PREFILTER_GUARD_EXTRA_TAP_COUNT === 12 &&
    BOKEH_HIGHLIGHT_PREFILTER_TOTAL_TAP_COUNT === 53 &&
  highlightPrefilterSource.includes(
    "PREFILTER_KERNEL.length !==",
  ) &&
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
