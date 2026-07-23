// Lightweight cinematic DoF composite for StableBokehPass.
//
// Three's stock BokehShader averages 41 taps whose furthest offset is only 0.4 of
// maxblur. That is a serviceable soft blur, but it dims tiny HDR emitters before
// they can read as an aperture image. This kernel spends the same 41 color fetches
// on three phase-offset aperture rings, then makes one post-average HDR-isolation
// decision. The fixed rings remain calm in motion and avoid coherent flower petals
// without screen-space noise. Focused pixels remain neutral, while mobile/low-perf
// paths still skip the pass entirely.
//
// Compact HDR emitters are transferred once into a source-driven filled-disc
// scatter after this gather. The gather keeps broad HDR fields and ordinary
// surfaces; one isolation decision removes a compact source as a complete unit.
import { BOKEH_SOURCE_CONTRACT } from "./bokeh-source-contract.js";

export const CIRCULAR_BOKEH_SAMPLE_COUNT = 41;
export const MOVING_BOKEH_SAMPLE_COUNT = 13;
export const CIRCULAR_BOKEH_DEFAULTS = Object.freeze({
  highlightThreshold: 0.78,
  highlightKnee: 0.52,
  highlightGain: 0.55,
  // Spend the complete bounded maxblur disc. The authored outer ring remains at
  // sqrt(0.75) of that radius, while a tiny lantern face expands into a legible
  // telephoto aperture image instead of reading as a softened point.
  radiusScale: 3.1,
});

function glslFloat(value) {
  const text = value.toFixed(7).replace(/0+$/, "").replace(/\.$/, "");
  return text.includes(".") ? text : `${text}.0`;
}

// Center + three phase-offset concentric rings. The outer ring receives half the
// budget because that circumference defines whether a point light reads as a disc
// or a flower. Each even ring is emitted as exact opposite pairs, preserving the
// optical center without a dynamic GLSL array or screen-space noise.
function makeDiscKernel() {
  const points = [[0, 0]];
  const rings = [
    { count: 8, radius: Math.sqrt(0.1), phase: 0.0 },
    // Stagger the two outer axes for the smallest deterministic coverage hole at
    // the authored radii. Counts, exact opposite pairs, and the 41-fetch budget
    // stay unchanged; only reconstruction texture is reduced.
    { count: 12, radius: Math.sqrt(0.35), phase: Math.PI / 12 },
    { count: 20, radius: Math.sqrt(0.75), phase: (Math.PI * 39) / 400 },
  ];
  for (const ring of rings) {
    for (let i = 0; i < ring.count / 2; i++) {
      const angle = ring.phase + (i * Math.PI * 2) / ring.count;
      const x = Math.cos(angle) * ring.radius;
      const y = Math.sin(angle) * ring.radius;
      points.push([x, y], [-x, -y]);
    }
  }
  return points;
}

export const CIRCULAR_BOKEH_KERNEL = Object.freeze(
  makeDiscKernel().map((point) => Object.freeze(point)),
);

// Center plus two opposite pairs from every authored ring. Keeping all three
// radii in the moving kernel prevents the aperture disc from changing size when
// the camera settles. These are indexes into the unchanged 41-tap kernel.
const MOVING_KERNEL_INDEXES = Object.freeze([
  0, 1, 2, 5, 6, 11, 12, 17, 18, 27, 28, 37, 38,
]);
export const CIRCULAR_BOKEH_MOVING_KERNEL = Object.freeze(
  MOVING_KERNEL_INDEXES.map((index) => CIRCULAR_BOKEH_KERNEL[index]),
);

function sampleUv([x, y]) {
  return `vUv + vec2(${glslFloat(x)}, ${glslFloat(y)}) * discRadius`;
}

function samplePoint([x, y]) {
  return `vec2(${glslFloat(x)}, ${glslFloat(y)})`;
}

const MOVING_INDEX_TO_SAMPLE = new Map(
  MOVING_KERNEL_INDEXES.map((kernelIndex, sampleIndex) => [
    kernelIndex,
    sampleIndex,
  ]),
);
const MOVING_SAMPLE_LINES = CIRCULAR_BOKEH_MOVING_KERNEL.map(
  (point, index) =>
    `vec3 movingSample${index} = texture2D(tColor, ${sampleUv(point)}).rgb;\n` +
    `      vec4 movingHighlight${index} = texture2D(tHighlight, ${sampleUv(point)});\n` +
    `      accumulateColor(movingSample${index}, movingHighlight${index}, ${samplePoint(point)}, movingColorSum, movingRawHighlightSum, movingTransferHighlightSum, movingHighlightSum, movingHighlightOffsetSum, movingHighlightWeightSum, movingHighlightPeak);`,
).join("\n      ");

// The 13 moving samples are fetched first. If the pixel sees an HDR emitter we
// replay those stored values plus the 28 remaining gathers in the original
// 41-sample order. This keeps luminous bokeh round during motion without paying
// the full kernel across ordinary surfaces; stable quality is pixel-identical.
const FULL_SAMPLE_LINES = CIRCULAR_BOKEH_KERNEL.map((point, kernelIndex) => {
  const movingIndex = MOVING_INDEX_TO_SAMPLE.get(kernelIndex);
  return movingIndex == null
    ? `accumulateFullSample(${sampleUv(point)}, ${samplePoint(point)}, colorSum, rawHighlightSum, transferHighlightSum, highlightSum, highlightOffsetSum, highlightWeightSum, highlightPeak);`
    : `accumulateColor(movingSample${movingIndex}, movingHighlight${movingIndex}, ${samplePoint(point)}, colorSum, rawHighlightSum, transferHighlightSum, highlightSum, highlightOffsetSum, highlightWeightSum, highlightPeak);`;
}).join("\n        ");

export const CIRCULAR_BOKEH_FRAGMENT_SHADER = /* glsl */ `
  #include <common>

  varying vec2 vUv;

  uniform sampler2D tColor;
  uniform sampler2D tDepth;
  uniform sampler2D tHighlight;
  uniform float maxblur;
  uniform float aperture;
  uniform float nearClip;
  uniform float farClip;
  uniform float focus;
  uniform float aspect;
  uniform float highlightThreshold;
  uniform float highlightKnee;
  uniform float highlightGain;
  uniform float bokehRadiusScale;
  uniform float viewportWidth;
  uniform float bokehQuality;
  uniform float bokehSourceScatter;

  #include <packing>

  float getDepth(const in vec2 screenPosition) {
    #if DEPTH_PACKING == 1
      return unpackRGBAToDepth(texture2D(tDepth, screenPosition));
    #else
      return texture2D(tDepth, screenPosition).x;
    #endif
  }

  float getViewZ(const in float depth) {
    #if PERSPECTIVE_CAMERA == 1
      return perspectiveDepthToViewZ(depth, nearClip, farClip);
    #else
      return orthographicDepthToViewZ(depth, nearClip, farClip);
    #endif
  }

  void accumulateColor(
    vec3 sampleColor,
    vec4 highlightSample,
    vec2 samplePoint,
    inout vec3 colorSum,
    inout vec3 rawHighlightSum,
    inout vec3 transferHighlightSum,
    inout vec3 highlightSum,
    inout vec2 highlightOffsetSum,
    inout float highlightWeightSum,
    inout float highlightPeak
  ) {
    float brightness = max(max(sampleColor.r, sampleColor.g), sampleColor.b);
    float rawHighlightGate = smoothstep(
      highlightThreshold,
      highlightThreshold + max(highlightKnee, 0.0001),
      brightness
    );
    float sourceWeight = dot(highlightSample.rgb, vec3(0.2126, 0.7152, 0.0722));
    vec3 rawHighlight = sampleColor * rawHighlightGate;
    float compactWeight =
      step(
        ${glslFloat(BOKEH_SOURCE_CONTRACT.gatherSupportCutoff)},
        highlightSample.a
      )
      * step(highlightThreshold * 0.05, brightness);
    // Source scatter makes one compactness decision for the complete gathered
    // emitter below. Keep every bright candidate here so antialiased edge texels
    // cannot survive as a scalloped residual around the transferred source.
    vec3 scatterCandidate = sampleColor * compactWeight;
    colorSum += sampleColor;
    rawHighlightSum += rawHighlight;
    transferHighlightSum += scatterCandidate;
    highlightSum += highlightSample.rgb;
    highlightOffsetSum += samplePoint * sourceWeight;
    highlightWeightSum += sourceWeight;
    highlightPeak = max(highlightPeak, sourceWeight);
  }

  void accumulateFullSample(
    vec2 uv,
    vec2 samplePoint,
    inout vec3 colorSum,
    inout vec3 rawHighlightSum,
    inout vec3 transferHighlightSum,
    inout vec3 highlightSum,
    inout vec2 highlightOffsetSum,
    inout float highlightWeightSum,
    inout float highlightPeak
  ) {
    vec3 sampleColor = texture2D(tColor, uv).rgb;
    vec4 highlightSample = texture2D(tHighlight, uv);
    accumulateColor(
      sampleColor,
      highlightSample,
      samplePoint,
      colorSum,
      rawHighlightSum,
      transferHighlightSum,
      highlightSum,
      highlightOffsetSum,
      highlightWeightSum,
      highlightPeak
    );
  }

  vec3 finishBokeh(
    vec3 colorSum,
    vec3 rawHighlightSum,
    vec3 transferHighlightSum,
    vec3 highlightSum,
    vec2 highlightOffsetSum,
    float highlightWeightSum,
    float highlightPeak,
    float sampleCount,
    float cocMix
  ) {
    vec3 color = colorSum / sampleCount;
    vec3 rawHighlightMean = rawHighlightSum / sampleCount;
    vec3 transferHighlightMean = transferHighlightSum / sampleCount;
    // Product source scatter owns exactly the continuously accepted compact
    // fraction. The gather removes that same energy once; ordinary/broad light
    // remains the physical fixed-kernel mean without an analytic additive path.
    if (bokehSourceScatter > 0.5) {
      return max(color - transferHighlightMean, vec3(0.0));
    }
    vec3 highlightMean = highlightSum / sampleCount;
    float highlightMeanPeak = dot(highlightMean, vec3(0.2126, 0.7152, 0.0722));
    float isolation = clamp(
      (highlightPeak - highlightMeanPeak) / max(highlightPeak, 0.0001),
      0.0,
      1.0
    );
    float highlightGate = smoothstep(
      highlightThreshold * 0.01,
      highlightThreshold * 0.12 + 0.0001,
      highlightPeak
    ) * cocMix;
    float highlight = highlightGate * isolation;
    // Estimate the isolated emitter's offset from the same fixed samples. The
    // radial reconstruction redistributes only the gathered source excess: the
    // floor stays with the scene, while the bounded profile cannot brighten the
    // source above its fixed-kernel mean. This gives a larger aperture image a
    // lower peak/mean instead of inventing a threshold-derived luminance floor.
    vec2 sourcePoint = highlightOffsetSum / max(highlightWeightSum, 0.0001);
    float sourceRadius = length(sourcePoint) / 0.8660254;
    float coverage = 1.0 - smoothstep(0.88, 1.12, sourceRadius);
    vec3 preservedColor = max(color - rawHighlightMean, vec3(0.0));
    // highlightGain controls redistribution contrast, not net light. For a unit
    // disc the area mean of a + b*r^4 is a + 2b/6, so dividing by that exact
    // integral makes the brighter rim borrow from the dimmer core. Coverage only
    // antialiases the outer shoulder; it is not an additive halo.
    float radial = min(sourceRadius, 1.0);
    float rimStrength = min(0.36, max(0.0, highlightGain * 0.65));
    float profileIntegral = 0.82 + 2.0 * rimStrength / 6.0;
    float energyProfile = coverage
      * (0.82 + rimStrength * radial * radial * radial * radial)
      / profileIntegral;
    vec3 analyticColor = preservedColor + highlightMean * energyProfile;
    return mix(color, analyticColor, highlight);
  }

  void main() {
    float viewZ = getViewZ(getDepth(vUv));
    float signedBlur = clamp((focus + viewZ) * aperture, -maxblur, maxblur);
    float coc = abs(signedBlur) / max(maxblur, 0.000001);
    // Below half a device pixel the 41 bilinear samples are visually equivalent to
    // the center texel. Keep that near-focus band exact and avoid redundant fetches.
    // The outer ring radius is sqrt(0.75), hence the 0.8660254 factor.
    float blurRadiusPx = abs(signedBlur) * bokehRadiusScale * viewportWidth * 0.8660254;
    if (blurRadiusPx < ${glslFloat(BOKEH_SOURCE_CONTRACT.sharpRadiusPx)}) {
      gl_FragColor = vec4(texture2D(tColor, vUv).rgb, 1.0);
      return;
    }
    float cocMix = smoothstep(0.06, 0.35, coc);
    // aspect = width / height. Scaling Y by aspect makes this a circle in pixels.
    vec2 discRadius = vec2(1.0, aspect) * signedBlur * bokehRadiusScale;
    vec3 colorSum = vec3(0.0);
    vec3 rawHighlightSum = vec3(0.0);
    vec3 transferHighlightSum = vec3(0.0);
    vec3 highlightSum = vec3(0.0);
    vec2 highlightOffsetSum = vec2(0.0);
    float highlightWeightSum = 0.0;
    float highlightPeak = 0.0;
    vec3 movingColorSum = vec3(0.0);
    vec3 movingRawHighlightSum = vec3(0.0);
    vec3 movingTransferHighlightSum = vec3(0.0);
    vec3 movingHighlightSum = vec3(0.0);
    vec2 movingHighlightOffsetSum = vec2(0.0);
    float movingHighlightWeightSum = 0.0;
    float movingHighlightPeak = 0.0;

      ${MOVING_SAMPLE_LINES}

    vec3 movingColor = finishBokeh(
      movingColorSum,
      movingRawHighlightSum,
      movingTransferHighlightSum,
      movingHighlightSum,
      movingHighlightOffsetSum,
      movingHighlightWeightSum,
      movingHighlightPeak,
      ${glslFloat(MOVING_BOKEH_SAMPLE_COUNT)},
      cocMix
    );
    vec3 color = movingColor;
    // A sparse kernel is acceptable on moving surfaces but turns tiny HDR lamps
    // into a visible star. Preserve the full aperture wherever the moving subset
    // already sees highlight energy; this remains one program and at most 41 reads.
    float movingHighlightMean = dot(
      movingHighlightSum,
      vec3(0.2126, 0.7152, 0.0722)
    ) / ${glslFloat(MOVING_BOKEH_SAMPLE_COUNT)};
    float movingIsolation = clamp(
      (movingHighlightPeak - movingHighlightMean) / max(movingHighlightPeak, 0.0001),
      0.0,
      1.0
    );
    bool preserveHighlight = movingHighlightPeak >= highlightThreshold * 0.01
      && movingIsolation >= ${glslFloat(BOKEH_SOURCE_CONTRACT.isolation)};
    if (bokehQuality > 0.0 || preserveHighlight) {
      ${FULL_SAMPLE_LINES}
      vec3 fullColor = finishBokeh(
        colorSum,
        rawHighlightSum,
        transferHighlightSum,
        highlightSum,
        highlightOffsetSum,
        highlightWeightSum,
        highlightPeak,
        ${glslFloat(CIRCULAR_BOKEH_SAMPLE_COUNT)},
        cocMix
      );
      float outputQuality = preserveHighlight ? 1.0 : bokehQuality;
      color = outputQuality >= 1.0
        ? fullColor
        : mix(movingColor, fullColor, clamp(outputQuality, 0.0, 1.0));
    }
    gl_FragColor = vec4(color, 1.0);
  }
`;

/** Install the circular HDR composite without replacing BokehPass's public API. */
export function installCircularBokeh(material, options = {}) {
  if (!material?.uniforms)
    throw new TypeError("installCircularBokeh requires a ShaderMaterial");
  const tuning = { ...CIRCULAR_BOKEH_DEFAULTS, ...options };
  material.uniforms.highlightThreshold = { value: tuning.highlightThreshold };
  material.uniforms.highlightKnee = { value: tuning.highlightKnee };
  material.uniforms.highlightGain = { value: tuning.highlightGain };
  material.uniforms.tHighlight = { value: null };
  material.uniforms.bokehRadiusScale = { value: tuning.radiusScale };
  material.uniforms.viewportWidth = { value: 1 };
  material.uniforms.bokehQuality = { value: 1 };
  material.uniforms.bokehSourceScatter = { value: 0 };
  material.fragmentShader = CIRCULAR_BOKEH_FRAGMENT_SHADER;
  material.needsUpdate = true;
  return material.uniforms;
}
