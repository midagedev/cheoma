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
// This remains a central-depth screen-space gather: an out-of-focus foreground
// emitter directly over an opaque focus-plane surface cannot scatter into those
// sharp neighboring pixels. Fixing that boundary needs source-depth fetches or a
// scatter pass; the controlled fixture keeps the limitation visible and measured.

export const CIRCULAR_BOKEH_SAMPLE_COUNT = 41;
export const MOVING_BOKEH_SAMPLE_COUNT = 13;
export const CIRCULAR_BOKEH_DEFAULTS = Object.freeze({
  highlightThreshold: 0.78,
  highlightKnee: 0.52,
  highlightGain: 0.55,
  radiusScale: 0.62,
});

function glslFloat(value) {
  const text = value.toFixed(7).replace(/0+$/, '').replace(/\.$/, '');
  return text.includes('.') ? text : `${text}.0`;
}

// Center + three phase-offset concentric rings. The outer ring receives half the
// budget because that circumference defines whether a point light reads as a disc
// or a flower. Each even ring is emitted as exact opposite pairs, preserving the
// optical center without a dynamic GLSL array or screen-space noise.
function makeDiscKernel() {
  const points = [[0, 0]];
  const rings = [
    { count: 8, radius: Math.sqrt(0.10), phase: 0.00 },
    { count: 12, radius: Math.sqrt(0.35), phase: Math.PI / 12 },
    { count: 20, radius: Math.sqrt(0.75), phase: Math.PI / 20 + 0.11 },
  ];
  for (const ring of rings) {
    for (let i = 0; i < ring.count / 2; i++) {
      const angle = ring.phase + i * Math.PI * 2 / ring.count;
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
const MOVING_KERNEL_INDEXES = Object.freeze([0, 1, 2, 5, 6, 11, 12, 17, 18, 27, 28, 37, 38]);
export const CIRCULAR_BOKEH_MOVING_KERNEL = Object.freeze(
  MOVING_KERNEL_INDEXES.map((index) => CIRCULAR_BOKEH_KERNEL[index]),
);

function sampleUv([x, y]) {
  return `vUv + vec2(${glslFloat(x)}, ${glslFloat(y)}) * discRadius`;
}

const MOVING_INDEX_TO_SAMPLE = new Map(
  MOVING_KERNEL_INDEXES.map((kernelIndex, sampleIndex) => [kernelIndex, sampleIndex]),
);
const MOVING_SAMPLE_LINES = CIRCULAR_BOKEH_MOVING_KERNEL.map((point, index) => (
  `vec3 movingSample${index} = texture2D(tColor, ${sampleUv(point)}).rgb;\n`
  + `      accumulateColor(movingSample${index}, movingColorSum, movingBrightnessSum, movingPeakBrightness);`
)).join('\n      ');

// The 13 moving samples are fetched first. If the pixel sees an HDR emitter we
// replay those stored values plus the 28 remaining gathers in the original
// 41-sample order. This keeps luminous bokeh round during motion without paying
// the full kernel across ordinary surfaces; stable quality is pixel-identical.
const FULL_SAMPLE_LINES = CIRCULAR_BOKEH_KERNEL.map((point, kernelIndex) => {
  const movingIndex = MOVING_INDEX_TO_SAMPLE.get(kernelIndex);
  return movingIndex == null
    ? `accumulateFullSample(${sampleUv(point)}, colorSum, brightnessSum, peakBrightness);`
    : `accumulateColor(movingSample${movingIndex}, colorSum, brightnessSum, peakBrightness);`;
}).join('\n        ');

export const CIRCULAR_BOKEH_FRAGMENT_SHADER = /* glsl */`
  #include <common>

  varying vec2 vUv;

  uniform sampler2D tColor;
  uniform sampler2D tDepth;
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
    inout vec3 colorSum,
    inout float brightnessSum,
    inout float peakBrightness
  ) {
    float brightness = max(max(sampleColor.r, sampleColor.g), sampleColor.b);
    colorSum += sampleColor;
    brightnessSum += brightness;
    peakBrightness = max(peakBrightness, brightness);
  }

  void accumulateFullSample(
    vec2 uv,
    inout vec3 colorSum,
    inout float brightnessSum,
    inout float peakBrightness
  ) {
    vec3 sampleColor = texture2D(tColor, uv).rgb;
    accumulateColor(sampleColor, colorSum, brightnessSum, peakBrightness);
  }

  vec3 finishBokeh(
    vec3 colorSum,
    float brightnessSum,
    float peakBrightness,
    float sampleCount,
    float cocMix
  ) {
    vec3 color = colorSum / sampleCount;
    float meanBrightness = brightnessSum / sampleCount;
    float isolation = clamp(
      (peakBrightness - meanBrightness) / max(peakBrightness, 0.0001),
      0.0,
      1.0
    );
    float highlight = smoothstep(
      highlightThreshold,
      highlightThreshold + max(highlightKnee, 0.0001),
      peakBrightness
    ) * cocMix * isolation;
    return color * (1.0 + highlight * highlightGain);
  }

  void main() {
    float viewZ = getViewZ(getDepth(vUv));
    float signedBlur = clamp((focus + viewZ) * aperture, -maxblur, maxblur);
    float coc = abs(signedBlur) / max(maxblur, 0.000001);
    // Below half a device pixel the 41 bilinear samples are visually equivalent to
    // the center texel. Keep that near-focus band exact and avoid redundant fetches.
    // The outer ring radius is sqrt(0.75), hence the 0.8660254 factor.
    float blurRadiusPx = abs(signedBlur) * bokehRadiusScale * viewportWidth * 0.8660254;
    if (blurRadiusPx < 0.45) {
      gl_FragColor = texture2D(tColor, vUv);
      return;
    }
    float cocMix = smoothstep(0.06, 0.35, coc);
    // aspect = width / height. Scaling Y by aspect makes this a circle in pixels.
    vec2 discRadius = vec2(1.0, aspect) * signedBlur * bokehRadiusScale;
    vec3 colorSum = vec3(0.0);
    float brightnessSum = 0.0;
    float peakBrightness = 0.0;
    vec3 movingColorSum = vec3(0.0);
    float movingBrightnessSum = 0.0;
    float movingPeakBrightness = 0.0;

      ${MOVING_SAMPLE_LINES}

    vec3 movingColor = finishBokeh(
      movingColorSum,
      movingBrightnessSum,
      movingPeakBrightness,
      ${glslFloat(MOVING_BOKEH_SAMPLE_COUNT)},
      cocMix
    );
    vec3 color = movingColor;
    // A sparse kernel is acceptable on moving surfaces but turns tiny HDR lamps
    // into a visible star. Preserve the full aperture wherever the moving subset
    // already sees highlight energy; this remains one program and at most 41 reads.
    bool preserveHighlight = movingPeakBrightness >= highlightThreshold;
    if (bokehQuality > 0.0 || preserveHighlight) {
      ${FULL_SAMPLE_LINES}
      vec3 fullColor = finishBokeh(
        colorSum,
        brightnessSum,
        peakBrightness,
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
  if (!material?.uniforms) throw new TypeError('installCircularBokeh requires a ShaderMaterial');
  const tuning = { ...CIRCULAR_BOKEH_DEFAULTS, ...options };
  material.uniforms.highlightThreshold = { value: tuning.highlightThreshold };
  material.uniforms.highlightKnee = { value: tuning.highlightKnee };
  material.uniforms.highlightGain = { value: tuning.highlightGain };
  material.uniforms.bokehRadiusScale = { value: tuning.radiusScale };
  material.uniforms.viewportWidth = { value: 1 };
  material.uniforms.bokehQuality = { value: 1 };
  material.fragmentShader = CIRCULAR_BOKEH_FRAGMENT_SHADER;
  material.needsUpdate = true;
  return material.uniforms;
}
