// Selective cinematic DoF composite for StableBokehPass.
//
// Compact HDR sources are transferred to the source-driven filled-disc scatter,
// which owns the large optical aperture image. Ordinary surfaces use a separate,
// capped 13-tap reconstruction only where the sampled luminance contrast makes
// defocus visible. During camera motion that surface reconstruction sleeps and
// the stable source scatter remains active, avoiding sparse-kernel crawl.
import { BOKEH_SOURCE_CONTRACT } from "./bokeh-source-contract.js";

export const CIRCULAR_BOKEH_SAMPLE_COUNT = 13;
export const MOVING_BOKEH_SAMPLE_COUNT = 1;
export const CIRCULAR_BOKEH_DEFAULTS = Object.freeze({
  highlightThreshold: 1.2,
  highlightKnee: 0.52,
  // Source scatter spends the complete bounded maxblur disc. Its normalized
  // profile conserves energy, so a larger circle is also dimmer at its core.
  radiusScale: 4.4,
  // Non-emissive surfaces never spend the huge source radius. A small physical
  // defocus is enough at a real brightness edge and is materially more stable.
  surfaceRadiusPx: 3.25,
  surfaceContrastLow: 0.06,
  surfaceContrastHigh: 0.24,
});

function glslFloat(value) {
  const text = value.toFixed(7).replace(/0+$/, "").replace(/\.$/, "");
  return text.includes(".") ? text : `${text}.0`;
}

// Center plus three four-sample concentric rings. Every non-center sample has an
// exact opposite, so the fixed kernel preserves the optical center without
// screen-space noise or a dynamically indexed GLSL array.
function makeSurfaceKernel() {
  const points = [[0, 0]];
  const rings = [
    { radius: Math.sqrt(0.1), phase: 0 },
    { radius: Math.sqrt(0.35), phase: Math.PI / 4 },
    { radius: Math.sqrt(0.75), phase: (Math.PI * 39) / 400 },
  ];
  for (const ring of rings) {
    for (let index = 0; index < 2; index++) {
      const angle = ring.phase + (index * Math.PI) / 2;
      const x = Math.cos(angle) * ring.radius;
      const y = Math.sin(angle) * ring.radius;
      points.push([x, y], [-x, -y]);
    }
  }
  return points;
}

export const CIRCULAR_BOKEH_KERNEL = Object.freeze(
  makeSurfaceKernel().map((point) => Object.freeze(point)),
);
export const CIRCULAR_BOKEH_MOVING_KERNEL = Object.freeze([
  CIRCULAR_BOKEH_KERNEL[0],
]);

function sampleUv([x, y]) {
  return `vUv + vec2(${glslFloat(x)}, ${glslFloat(y)}) * discRadius`;
}

const SURFACE_SAMPLE_LINES = CIRCULAR_BOKEH_KERNEL.slice(1)
  .map(
    (point, index) =>
      `vec3 surfaceSample${index + 1}` +
      ` = texture2D(tColor, ${sampleUv(point)}).rgb;\n` +
      `    vec4 surfaceHighlight${index + 1}` +
      ` = texture2D(tHighlight, ${sampleUv(point)});\n` +
      `    accumulateSurface(surfaceSample${index + 1},` +
      ` surfaceHighlight${index + 1}, colorSum, lumaMin, lumaMax);`,
  )
  .join("\n    ");

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
  uniform float bokehRadiusScale;
  uniform float viewportWidth;
  uniform float bokehQuality;
  uniform float bokehSourceScatter;
  uniform float surfaceRadiusPx;
  uniform float surfaceContrastLow;
  uniform float surfaceContrastHigh;

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

  float surfaceLuminance(vec3 color) {
    return dot(color, vec3(0.2126, 0.7152, 0.0722));
  }

  vec3 withoutTransferredSource(vec3 color, vec4 highlightSample) {
    float brightness = max(max(color.r, color.g), color.b);
    float compactSource =
      step(
        ${glslFloat(BOKEH_SOURCE_CONTRACT.gatherSupportCutoff)},
        highlightSample.a
      )
      // Once an exact 2x2 block owns an HDR source, transfer its antialiased
      // shoulder with the core so the source remains one energy-conserving unit.
      * step(highlightThreshold * 0.05, brightness)
      * step(0.5, bokehSourceScatter);
    return max(color - color * compactSource, vec3(0.0));
  }

  void accumulateSurface(
    vec3 sampleColor,
    vec4 highlightSample,
    inout vec3 colorSum,
    inout float lumaMin,
    inout float lumaMax
  ) {
    float sampleLuma = surfaceLuminance(sampleColor);
    colorSum += withoutTransferredSource(sampleColor, highlightSample);
    lumaMin = min(lumaMin, sampleLuma);
    lumaMax = max(lumaMax, sampleLuma);
  }

  void main() {
    float viewZ = getViewZ(getDepth(vUv));
    float signedBlur = clamp((focus + viewZ) * aperture, -maxblur, maxblur);
    float coc = abs(signedBlur) / max(maxblur, 0.000001);
    // The authored outer ring radius is sqrt(0.75).
    float blurRadiusPx =
      abs(signedBlur) * bokehRadiusScale * viewportWidth * 0.8660254;
    if (blurRadiusPx < ${glslFloat(BOKEH_SOURCE_CONTRACT.sharpRadiusPx)}) {
      gl_FragColor = vec4(texture2D(tColor, vUv).rgb, 1.0);
      return;
    }

    vec3 centerColor = texture2D(tColor, vUv).rgb;
    vec4 centerHighlight = texture2D(tHighlight, vUv);
    vec3 centerBase = withoutTransferredSource(centerColor, centerHighlight);

    // Camera motion keeps the original surface sample while compact HDR discs
    // remain fully optical in the following scatter pass. This is both cheaper
    // and calmer than changing between two sparse surface kernels.
    float cappedRadiusPx = min(blurRadiusPx, surfaceRadiusPx);
    if (bokehQuality <= 0.0 || cappedRadiusPx < 0.65) {
      gl_FragColor = vec4(centerBase, 1.0);
      return;
    }

    float radiusFraction = cappedRadiusPx / max(blurRadiusPx, 0.0001);
    vec2 discRadius =
      vec2(1.0, aspect) * signedBlur * bokehRadiusScale * radiusFraction;
    vec3 colorSum = vec3(0.0);
    float centerLuma = surfaceLuminance(centerColor);
    float lumaMin = centerLuma;
    float lumaMax = centerLuma;
    accumulateSurface(
      centerColor,
      centerHighlight,
      colorSum,
      lumaMin,
      lumaMax
    );
    ${SURFACE_SAMPLE_LINES}

    float lumaSpan = lumaMax - lumaMin;
    float relativeSpan = lumaSpan / max(lumaMax, 0.12);
    float contrastGate =
      smoothstep(surfaceContrastLow, surfaceContrastHigh, lumaSpan)
      * smoothstep(0.15, 0.55, relativeSpan);
    float radiusGate = smoothstep(0.65, 2.0, cappedRadiusPx);
    float cocGate = smoothstep(0.06, 0.35, coc);
    float surfaceMix =
      contrastGate * radiusGate * cocGate * clamp(bokehQuality, 0.0, 1.0);
    vec3 surfaceColor =
      colorSum / ${glslFloat(CIRCULAR_BOKEH_SAMPLE_COUNT)};
    gl_FragColor = vec4(mix(centerBase, surfaceColor, surfaceMix), 1.0);
  }
`;

/** Install the selective HDR composite without replacing BokehPass's public API. */
export function installCircularBokeh(material, options = {}) {
  if (!material?.uniforms)
    throw new TypeError("installCircularBokeh requires a ShaderMaterial");
  const tuning = { ...CIRCULAR_BOKEH_DEFAULTS, ...options };
  material.uniforms.highlightThreshold = { value: tuning.highlightThreshold };
  material.uniforms.highlightKnee = { value: tuning.highlightKnee };
  material.uniforms.tHighlight = { value: null };
  material.uniforms.bokehRadiusScale = { value: tuning.radiusScale };
  material.uniforms.viewportWidth = { value: 1 };
  material.uniforms.bokehQuality = { value: 1 };
  material.uniforms.bokehSourceScatter = { value: 0 };
  material.uniforms.surfaceRadiusPx = { value: tuning.surfaceRadiusPx };
  material.uniforms.surfaceContrastLow = {
    value: tuning.surfaceContrastLow,
  };
  material.uniforms.surfaceContrastHigh = {
    value: tuning.surfaceContrastHigh,
  };
  material.fragmentShader = CIRCULAR_BOKEH_FRAGMENT_SHADER;
  material.needsUpdate = true;
  return material.uniforms;
}
