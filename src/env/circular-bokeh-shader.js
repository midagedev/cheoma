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

const SAMPLE_LINES = CIRCULAR_BOKEH_KERNEL.map(([x, y]) => (
  `accumulateSample(vUv + vec2(${glslFloat(x)}, ${glslFloat(y)}) * discRadius, colorSum, brightnessSum, peakBrightness);`
)).join('\n      ');

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

  void accumulateSample(
    vec2 uv,
    inout vec3 colorSum,
    inout float brightnessSum,
    inout float peakBrightness
  ) {
    vec3 sampleColor = texture2D(tColor, uv).rgb;
    float brightness = max(max(sampleColor.r, sampleColor.g), sampleColor.b);
    colorSum += sampleColor;
    brightnessSum += brightness;
    peakBrightness = max(peakBrightness, brightness);
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

      ${SAMPLE_LINES}

    float sampleCount = ${glslFloat(CIRCULAR_BOKEH_SAMPLE_COUNT)};
    vec3 color = colorSum / sampleCount;
    float meanBrightness = brightnessSum / sampleCount;
    // One post-average highlight decision replaces one smoothstep per tap. Bloom
    // has already softened real emitters. Peak-vs-mean isolation keeps their disc
    // luminous without boosting uniformly bright plaster or sky.
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
    color *= 1.0 + highlight * highlightGain;
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
  material.fragmentShader = CIRCULAR_BOKEH_FRAGMENT_SHADER;
  material.needsUpdate = true;
  return material.uniforms;
}
