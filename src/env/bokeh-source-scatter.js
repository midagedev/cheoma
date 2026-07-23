import {
  AddEquation,
  CustomBlending,
  Float32BufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  OneFactor,
  OrthographicCamera,
  Points,
  Scene,
  ShaderMaterial,
  Vector2,
  ZeroFactor,
} from "three";
import {
  BOKEH_SOURCE_CONTRACT,
  bokehSourceGridDimensions,
  selectBokehSourceBackend,
} from "./bokeh-source-contract.js";

function glslFloat(value) {
  const text = Number(value).toFixed(10).replace(/0+$/, "").replace(/\.$/, "");
  return text.includes(".") ? text : `${text}.0`;
}

const OWNED_OFFSETS = Object.freeze(
  Array.from({ length: BOKEH_SOURCE_CONTRACT.blockSize }, (_, y) =>
    Array.from({ length: BOKEH_SOURCE_CONTRACT.blockSize }, (_, x) => [
      x + 0.5 - BOKEH_SOURCE_CONTRACT.blockSize * 0.5,
      y + 0.5 - BOKEH_SOURCE_CONTRACT.blockSize * 0.5,
    ]),
  ).flat(),
);
const VECTOR_COMPONENTS = Object.freeze(["x", "y", "z", "w"]);
const OWNED_SAMPLE_LINES = OWNED_OFFSETS.map(
  ([x, y], index) =>
    `vec2 ownedUv${index} = cellUv` +
    ` + vec2(${x.toFixed(1)}, ${y.toFixed(1)}) * sourceTexel;\n` +
    `    vec3 ownedSource${index} = gatedRawSource(ownedUv${index});\n` +
    `    float ownedLuminance${index} = luminance(ownedSource${index});\n` +
    `    if (ownedLuminance${index} > 0.0) {\n` +
    `      float ownedDepth${index} = viewDepth(ownedUv${index});\n` +
    `      float ownedRadius${index} = sourceRadiusAtDepth(ownedDepth${index});\n` +
    `      float ownedPeak${index} = max(max(ownedSource${index}.r,` +
    ` ownedSource${index}.g), ownedSource${index}.b);\n` +
    `      if (ownedRadius${index}` +
    ` < ${glslFloat(BOKEH_SOURCE_CONTRACT.sharpRadiusPx)}) {\n` +
    `        ownedSource${index} = vec3(0.0);\n` +
    "      } else {\n" +
    `        sourceDepths.${VECTOR_COMPONENTS[index]} = ownedDepth${index};\n` +
    `        sourceRadii.${VECTOR_COMPONENTS[index]} = ownedRadius${index};\n` +
    `        sourceNormalizations.${VECTOR_COMPONENTS[index]}` +
    ` = kernelNormalization(ownedRadius${index});\n` +
    `        sourcePeaks.${VECTOR_COMPONENTS[index]} = ownedPeak${index};\n` +
    `        maxSourceRadius = max(maxSourceRadius, ownedRadius${index});\n` +
    `        activeSourceLuminance += ownedLuminance${index};\n` +
    "      }\n" +
    "    }",
).join("\n    ");
const SOURCE_ENERGY_VARYINGS = OWNED_OFFSETS.map(
  (_, index) => `varying vec3 vSourceEnergy${index};`,
).join("\n  ");
const SOURCE_ENERGY_ASSIGN_LINES = OWNED_OFFSETS.map(
  (_, index) => `vSourceEnergy${index} = ownedSource${index};`,
).join("\n    ");
const SOURCE_COMPONENT_PEAK_LINES = OWNED_OFFSETS.map(
  (_, sourceIndex) =>
    `float componentPeak${sourceIndex}` +
    ` = sourcePeaks.${VECTOR_COMPONENTS[sourceIndex]};`,
).join("\n    ");
const SOURCE_COMPONENT_PAIR_LINES = OWNED_OFFSETS.flatMap((_, sourceIndex) =>
  OWNED_OFFSETS.slice(sourceIndex + 1).map((__, peerOffset) => {
    const peerIndex = sourceIndex + peerOffset + 1;
    const sourceComponent = VECTOR_COMPONENTS[sourceIndex];
    const peerComponent = VECTOR_COMPONENTS[peerIndex];
    return (
      `if (sharesSourceComponent(ownedSource${sourceIndex},` +
      ` sourceDepths.${sourceComponent}, ownedSource${peerIndex},` +
      ` sourceDepths.${peerComponent})) {\n` +
      `      float sharedPeak${sourceIndex}${peerIndex}` +
      ` = max(sourcePeaks.${sourceComponent}, sourcePeaks.${peerComponent});\n` +
      `      componentPeak${sourceIndex}` +
      ` = max(componentPeak${sourceIndex}, sharedPeak${sourceIndex}${peerIndex});\n` +
      `      componentPeak${peerIndex}` +
      ` = max(componentPeak${peerIndex}, sharedPeak${sourceIndex}${peerIndex});\n` +
      "    }"
    );
  }),
).join("\n    ");
const SOURCE_WEIGHT_LINES = OWNED_OFFSETS.map(
  (_, sourceIndex) =>
    `vSourceWeights.${VECTOR_COMPONENTS[sourceIndex]} = smoothstep(\n` +
    "      highlightThreshold,\n" +
    "      highlightThreshold + max(highlightKnee, 0.0001),\n" +
    `      componentPeak${sourceIndex}\n` +
    "    );",
).join("\n    ");
const SOURCE_PROFILE_LINES = OWNED_OFFSETS.map(
  ([x, y], index) =>
    `if (vSourceRadii.${VECTOR_COMPONENTS[index]} > 0.0) {\n` +
    `      float sourceDistance${index} = length(destinationPixel` +
    ` - (vCellPixel + vec2(${x.toFixed(1)}, ${y.toFixed(1)})));\n` +
    `      bool acceptsSource${index} =` +
    ` vSourceDepths.${VECTOR_COMPONENTS[index]}` +
    " <= destinationDepth + depthEpsilon;\n" +
    `      if (!acceptsSource${index}` +
    ` && sharesDepthLayer(vSourceDepths.${VECTOR_COMPONENTS[index]},` +
    " destinationDepth)) {\n" +
    "        if (destinationPeak < 0.0) {\n" +
    "          destinationColor = texture2D(tColor, destinationUv).rgb;\n" +
    "          destinationPeak = max(max(destinationColor.r," +
    " destinationColor.g), destinationColor.b);\n" +
    "          vec2 destinationBlock = floor(" +
    "(gl_FragCoord.xy - vec2(0.5)) / " +
    `${glslFloat(BOKEH_SOURCE_CONTRACT.blockSize)});\n` +
    "          vec2 destinationOwnershipUv =" +
    " (destinationBlock + vec2(0.5)) / gridSize;\n" +
    "          destinationCompact = step(" +
    `${glslFloat(BOKEH_SOURCE_CONTRACT.exactOwnershipCutoff)},` +
    " texture2D(tSource, destinationOwnershipUv).a);\n" +
    "        }\n" +
    `        acceptsSource${index} = destinationCompact > 0.5` +
    " && destinationPeak >= highlightThreshold * 0.05" +
    ` && hueAligned(vSourceEnergy${index}, destinationColor);\n` +
    "      }\n" +
    `      if (acceptsSource${index}) {\n` +
    `      float identityWeight${index} = 1.0` +
    ` - step(0.5, sourceDistance${index});\n` +
    `      float apertureWeight${index} = rawProfile(sourceDistance${index},` +
    ` vSourceRadii.${VECTOR_COMPONENTS[index]})` +
    ` / vSourceNormalizations.${VECTOR_COMPONENTS[index]};\n` +
    `      float replacementWeight${index} = mix(identityWeight${index},` +
    ` apertureWeight${index}, vSourceWeights.${VECTOR_COMPONENTS[index]});\n` +
    `      scatteredEnergy += vSourceEnergy${index}` +
    ` * replacementWeight${index};\n` +
    "      }\n" +
    "    }",
).join("\n    ");
const LATTICE_RADIUS = 7;
const latticeDistanceCounts = new Map();
for (let y = -LATTICE_RADIUS; y <= LATTICE_RADIUS; y++) {
  for (let x = -LATTICE_RADIUS; x <= LATTICE_RADIUS; x++) {
    const distanceSquared = x * x + y * y;
    latticeDistanceCounts.set(
      distanceSquared,
      (latticeDistanceCounts.get(distanceSquared) || 0) + 1,
    );
  }
}
const DISCRETE_NORMALIZATION_LINES = [...latticeDistanceCounts]
  .sort(([a], [b]) => a - b)
  .map(
    ([distanceSquared, count]) =>
      `discreteNormalization += ${glslFloat(count)} * rawProfile(` +
      `${glslFloat(Math.sqrt(distanceSquared))}, radiusPx);`,
  )
  .join("\n    ");
export const BOKEH_SCATTER_VERTEX_SHADER = /* glsl */ `
  #include <common>
  #include <packing>

  uniform sampler2D tSource;
  uniform sampler2D tColor;
  uniform sampler2D tDepth;
  uniform vec2 sourceTexel;
  uniform vec2 gridSize;
  uniform vec2 viewportSize;
  uniform float focus;
  uniform float aperture;
  uniform float maxblur;
  uniform float nearClip;
  uniform float farClip;
  uniform float radiusScale;
  uniform float viewportWidth;
  uniform float highlightThreshold;
  uniform float highlightKnee;
  uniform float triangleBackend;

  ${SOURCE_ENERGY_VARYINGS}
  varying vec4 vSourceDepths;
  varying vec4 vSourceRadii;
  varying vec4 vSourceNormalizations;
  varying vec4 vSourceWeights;
  varying vec2 vCellPixel;

  float luminance(vec3 color) {
    return dot(color, vec3(0.2126, 0.7152, 0.0722));
  }

  float rawProfile(float distancePx, float radiusPx) {
    float coverage = 1.0 - smoothstep(
      max(radiusPx - 0.5, 0.0),
      radiusPx + 0.5,
      distancePx
    );
    float radial = min(distancePx / max(radiusPx, 0.0001), 1.0);
    float radial2 = radial * radial;
    float radial4 = radial2 * radial2;
    float radial12 = radial4 * radial4 * radial4;
    return coverage * (
      ${glslFloat(BOKEH_SOURCE_CONTRACT.profileCore)}
      + ${glslFloat(BOKEH_SOURCE_CONTRACT.profileRim)} * radial12
    );
  }

  float kernelNormalization(float radiusPx) {
    float continuousNormalization =
      3.141592653589793 * radiusPx * radiusPx
      * ${glslFloat(BOKEH_SOURCE_CONTRACT.profileIntegral)};
    if (radiusPx >= 7.0) {
      return max(continuousNormalization, 0.0001);
    }
    float discreteNormalization = 0.0;
    ${DISCRETE_NORMALIZATION_LINES}
    return max(
      mix(
        discreteNormalization,
        continuousNormalization,
        smoothstep(6.0, 7.0, radiusPx)
      ),
      0.0001
    );
  }

  float sourceRadiusAtDepth(float sourceDepth) {
    float signedBlur = clamp(
      (focus - sourceDepth) * aperture,
      -maxblur,
      maxblur
    );
    return abs(signedBlur) * radiusScale * viewportWidth * 0.8660254;
  }

  float viewDepth(vec2 uv) {
    float packedDepth = unpackRGBAToDepth(texture2D(tDepth, uv));
    return -perspectiveDepthToViewZ(packedDepth, nearClip, farClip);
  }

  float compactWeight(vec2 uv) {
    return step(
      ${glslFloat(BOKEH_SOURCE_CONTRACT.exactOwnershipCutoff)},
      texture2D(tSource, uv).a
    );
  }

  bool sharesDepthLayer(float firstDepth, float secondDepth) {
    float signedSide = (focus - firstDepth) * (focus - secondDepth);
    float relativeDepthTolerance =
      max(0.02, min(firstDepth, secondDepth) * 0.005);
    return signedSide >= 0.0
      && abs(firstDepth - secondDepth) <= relativeDepthTolerance;
  }

  bool sharesSourceComponent(
    vec3 firstSource,
    float firstDepth,
    vec3 secondSource,
    float secondDepth
  ) {
    float firstPeak = max(max(firstSource.r, firstSource.g), firstSource.b);
    float secondPeak = max(max(secondSource.r, secondSource.g), secondSource.b);
    if (min(firstPeak, secondPeak) <= 0.0) return false;
    float hueDot = dot(firstSource, secondSource);
    return hueDot > 0.0
      && hueDot * hueDot
        >= 0.990025 * dot(firstSource, firstSource)
          * dot(secondSource, secondSource)
      && sharesDepthLayer(firstDepth, secondDepth);
  }

  vec3 gatedRawSource(vec2 uv) {
    if (any(lessThan(uv, vec2(0.0)))
      || any(greaterThan(uv, vec2(1.0)))) return vec3(0.0);
    vec3 color = texture2D(tColor, uv).rgb;
    float peak = max(max(color.r, color.g), color.b);
    vec3 gatedSource = color * step(highlightThreshold * 0.05, peak);
    return gatedSource;
  }

  void rejectVertex() {
    gl_PointSize = 0.0;
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  }

  void main() {
    int gridColumns = int(gridSize.x);
    int column = gl_InstanceID % gridColumns;
    int row = gl_InstanceID / gridColumns;
    vec2 cellIndex = vec2(float(column), float(row));
    vec2 cellPixel = min(cellIndex * ${glslFloat(BOKEH_SOURCE_CONTRACT.blockSize)}
      + ${glslFloat(BOKEH_SOURCE_CONTRACT.blockSize * 0.5)}, viewportSize);
    vec2 cellUv = cellPixel / viewportSize;
    // One nearest-filtered half-resolution ownership texel maps exactly to this
    // 2x2 source block. Reject empty blocks before any full-resolution color or
    // depth reads; only sparse compact emitters pay the four-texel work.
    if (compactWeight(cellUv) < 0.5) {
      rejectVertex();
      return;
    }
    vec4 sourceDepths = vec4(farClip);
    vec4 sourceRadii = vec4(0.0);
    vec4 sourceNormalizations = vec4(1.0);
    vec4 sourcePeaks = vec4(0.0);
    float maxSourceRadius = 0.0;
    float activeSourceLuminance = 0.0;
    ${OWNED_SAMPLE_LINES}
    if (activeSourceLuminance <= 0.0) {
      rejectVertex();
      return;
    }
    float pointRadiusPx = maxSourceRadius + 1.0;
    float triangleRadiusPx = maxSourceRadius + 1.2071067812;

    // Each primitive owns four disjoint full-resolution source texels and
    // evaluates their shifted aperture profiles in the fragment shader.
    ${SOURCE_ENERGY_ASSIGN_LINES}
    vSourceDepths = sourceDepths;
    vSourceRadii = sourceRadii;
    vSourceNormalizations = sourceNormalizations;
    ${SOURCE_COMPONENT_PEAK_LINES}
    ${SOURCE_COMPONENT_PAIR_LINES}
    ${SOURCE_WEIGHT_LINES}
    vCellPixel = cellPixel;
    gl_PointSize = pointRadiusPx
      * ${glslFloat(BOKEH_SOURCE_CONTRACT.pointCoverage)};
    vec2 triangleClipOffset = position.xy * triangleRadiusPx
      * vec2(2.0 / viewportSize.x, 2.0 / viewportSize.y)
      * step(0.5, triangleBackend);
    gl_Position = vec4(cellUv * 2.0 - 1.0 + triangleClipOffset, 0.0, 1.0);
  }
`;

export const BOKEH_SCATTER_FRAGMENT_SHADER = /* glsl */ `
  #include <common>
  #include <packing>

  uniform sampler2D tSource;
  uniform sampler2D tColor;
  uniform sampler2D tDepth;
  uniform vec2 viewportSize;
  uniform vec2 gridSize;
  uniform float nearClip;
  uniform float farClip;
  uniform float focus;
  uniform float highlightThreshold;
  ${SOURCE_ENERGY_VARYINGS}
  varying vec4 vSourceDepths;
  varying vec4 vSourceRadii;
  varying vec4 vSourceNormalizations;
  varying vec4 vSourceWeights;
  varying vec2 vCellPixel;

  float rawProfile(float distancePx, float radiusPx) {
    float coverage = 1.0 - smoothstep(
      max(radiusPx - 0.5, 0.0),
      radiusPx + 0.5,
      distancePx
    );
    float radial = min(distancePx / max(radiusPx, 0.0001), 1.0);
    float radial2 = radial * radial;
    float radial4 = radial2 * radial2;
    float radial12 = radial4 * radial4 * radial4;
    return coverage * (
      ${glslFloat(BOKEH_SOURCE_CONTRACT.profileCore)}
      + ${glslFloat(BOKEH_SOURCE_CONTRACT.profileRim)} * radial12
    );
  }

  bool sharesDepthLayer(float sourceDepth, float destinationDepth) {
    float signedSide =
      (focus - sourceDepth) * (focus - destinationDepth);
    float relativeDepthTolerance =
      max(0.02, min(sourceDepth, destinationDepth) * 0.005);
    return signedSide >= 0.0
      && abs(sourceDepth - destinationDepth) <= relativeDepthTolerance;
  }

  bool hueAligned(vec3 sourceColor, vec3 destinationColor) {
    float hueDot = dot(sourceColor, destinationColor);
    return hueDot > 0.0
      && hueDot * hueDot
        >= 0.990025 * dot(sourceColor, sourceColor)
          * dot(destinationColor, destinationColor);
  }

  void main() {
    vec2 destinationUv = gl_FragCoord.xy / viewportSize;
    float packedDepth = unpackRGBAToDepth(texture2D(tDepth, destinationUv));
    float destinationDepth = -perspectiveDepthToViewZ(
      packedDepth,
      nearClip,
      farClip
    );
    float depthEpsilon = max(0.01, destinationDepth * 0.0001);

    vec2 destinationPixel = gl_FragCoord.xy;
    vec3 destinationColor = vec3(0.0);
    float destinationPeak = -1.0;
    float destinationCompact = 0.0;
    vec3 scatteredEnergy = vec3(0.0);
    ${SOURCE_PROFILE_LINES}
    if (max(max(scatteredEnergy.r, scatteredEnergy.g), scatteredEnergy.b)
      <= 0.0) discard;
    gl_FragColor = vec4(scatteredEnergy, 0.0);
  }
`;

function makeInstancedGeometry(positions) {
  const geometry = new InstancedBufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.instanceCount = 0;
  return geometry;
}

/**
 * Source-driven compact bokeh splats. The caller owns all textures and the
 * destination; this class adds one program/draw and owns no render target.
 */
export class BokehSourceScatter {
  constructor() {
    this.uniforms = {
      tSource: { value: null },
      tColor: { value: null },
      tDepth: { value: null },
      sourceTexel: { value: new Vector2(1, 1) },
      gridSize: { value: new Vector2(1, 1) },
      viewportSize: { value: new Vector2(1, 1) },
      focus: { value: 100 },
      aperture: { value: 0.00015 },
      maxblur: { value: 0.01 },
      nearClip: { value: 0.1 },
      farClip: { value: 2000 },
      radiusScale: { value: 1.55 },
      viewportWidth: { value: 1 },
      highlightThreshold: { value: 0.78 },
      highlightKnee: { value: 0.52 },
      triangleBackend: { value: 0 },
    };
    this.material = new ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: BOKEH_SCATTER_VERTEX_SHADER,
      fragmentShader: BOKEH_SCATTER_FRAGMENT_SHADER,
      transparent: true,
      blending: CustomBlending,
      blendEquation: AddEquation,
      blendSrc: OneFactor,
      blendDst: OneFactor,
      blendEquationAlpha: AddEquation,
      blendSrcAlpha: ZeroFactor,
      blendDstAlpha: OneFactor,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.pointGeometry = makeInstancedGeometry([0, 0, 0]);
    // One counter-clockwise triangle circumscribes the unit aperture disc.
    // It is only rendered when the device point-size cap cannot contain the
    // requested circle of confusion.
    this.triangleGeometry = makeInstancedGeometry([
      0,
      2,
      0,
      -Math.sqrt(3),
      -1,
      0,
      Math.sqrt(3),
      -1,
      0,
    ]);
    this.points = new Points(this.pointGeometry, this.material);
    this.points.frustumCulled = false;
    this.triangles = new Mesh(this.triangleGeometry, this.material);
    this.triangles.frustumCulled = false;
    this.triangles.visible = false;
    this.scene = new Scene();
    this.scene.add(this.points);
    this.scene.add(this.triangles);
    this.camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.width = 0;
    this.height = 0;
    this.gridWidth = 0;
    this.gridHeight = 0;
    this.vertexCount = 0;
    this.renderCount = 0;
    this.backend = "points";
    this.pointSizeRange = null;
    this.requiredPointDiameter = 0;
  }

  setSize(width, height) {
    const nextWidth = Math.max(1, Math.floor(width));
    const nextHeight = Math.max(1, Math.floor(height));
    this.uniforms.viewportSize.value.set(nextWidth, nextHeight);
    this.uniforms.viewportWidth.value = nextWidth;
    if (nextWidth === this.width && nextHeight === this.height) return;
    const grid = bokehSourceGridDimensions(nextWidth, nextHeight);
    this.width = nextWidth;
    this.height = nextHeight;
    this.gridWidth = grid.columns;
    this.gridHeight = grid.rows;
    this.vertexCount = grid.columns * grid.rows;
    this.pointGeometry.instanceCount = this.vertexCount;
    this.triangleGeometry.instanceCount = this.vertexCount;
    this.uniforms.gridSize.value.set(grid.columns, grid.rows);
    this.uniforms.sourceTexel.value.set(1 / nextWidth, 1 / nextHeight);
  }

  _selectBackend(renderer, maxblur, radiusScale) {
    if (!this.pointSizeRange) {
      const range = renderer
        .getContext()
        .getParameter(renderer.getContext().ALIASED_POINT_SIZE_RANGE);
      this.pointSizeRange = [range[0], range[1]];
    }
    this.requiredPointDiameter =
      (maxblur *
        radiusScale *
        this.uniforms.viewportWidth.value *
        0.8660254 +
        1.0) *
      BOKEH_SOURCE_CONTRACT.pointCoverage;
    const nextBackend = selectBokehSourceBackend(
      this.backend,
      this.requiredPointDiameter,
      this.pointSizeRange[1],
    );
    if (this.backend !== nextBackend) {
      this.backend = "triangles";
      this.points.visible = false;
      this.triangles.visible = true;
      this.uniforms.triangleBackend.value = 1;
    }
  }

  render(
    renderer,
    destination,
    sourceTexture,
    colorTexture,
    depthTexture,
    camera,
    focus,
    aperture,
    maxblur,
    radiusScale,
    highlightThreshold,
    highlightKnee,
  ) {
    this.uniforms.tSource.value = sourceTexture;
    this.uniforms.tColor.value = colorTexture;
    this.uniforms.tDepth.value = depthTexture;
    this.uniforms.focus.value = focus;
    this.uniforms.aperture.value = aperture;
    this.uniforms.maxblur.value = maxblur;
    this.uniforms.nearClip.value = camera.near;
    this.uniforms.farClip.value = camera.far;
    this.uniforms.radiusScale.value = radiusScale;
    this.uniforms.highlightThreshold.value = highlightThreshold;
    this.uniforms.highlightKnee.value = highlightKnee;
    this._selectBackend(renderer, maxblur, radiusScale);
    const previousTarget = renderer.getRenderTarget();
    const previousAutoClear = renderer.autoClear;
    try {
      renderer.autoClear = false;
      renderer.setRenderTarget(destination);
      renderer.render(this.scene, this.camera);
    } finally {
      renderer.setRenderTarget(previousTarget);
      renderer.autoClear = previousAutoClear;
    }
    this.renderCount++;
  }

  dispose() {
    this.pointGeometry.dispose();
    this.triangleGeometry.dispose();
    this.material.dispose();
    this.scene.remove(this.points);
    this.scene.remove(this.triangles);
  }
}
