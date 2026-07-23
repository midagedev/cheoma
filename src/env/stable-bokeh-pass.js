import { BokehPass } from "three/addons/postprocessing/BokehPass.js";
import { MeshDepthMaterial, NoBlending, RGBADepthPacking } from "three";
import { contributesDofDepth, dofDepthMaterialForObject } from "./dof.js";
import {
  CIRCULAR_BOKEH_SAMPLE_COUNT,
  MOVING_BOKEH_SAMPLE_COUNT,
  installCircularBokeh,
} from "./circular-bokeh-shader.js";
import { BokehHighlightPrefilter } from "./bokeh-highlight-prefilter.js";
import { BokehSourceScatter } from "./bokeh-source-scatter.js";
import {
  INST_FADE_PROGRAM_VERSION,
  patchInstFadeShader,
} from "./inst-fade-shader.js";
import {
  hasLodScreenDoor,
  LOD_SCREEN_DOOR_PROGRAM_VERSION,
  patchLodScreenDoorMaterial,
} from "../render/lod-screen-door.js";

function createInstFadeDepthMaterial() {
  const material = new MeshDepthMaterial();
  material.depthPacking = RGBADepthPacking;
  material.blending = NoBlending;
  // WebGLRenderer only substitutes materials whose allowOverride is true. This one must survive
  // BokehPass's scene override so instFade can cut the same screen-door holes as the color pass.
  material.allowOverride = false;
  material.onBeforeCompile = (shader) => {
    patchInstFadeShader(shader);
  };
  material.customProgramCacheKey = () =>
    `cheoma-dof-depth|${INST_FADE_PROGRAM_VERSION}`;
  return material;
}

function createLodScreenDoorDepthMaterial() {
  const material = new MeshDepthMaterial();
  material.depthPacking = RGBADepthPacking;
  material.blending = NoBlending;
  material.allowOverride = false;
  patchLodScreenDoorMaterial(material);
  material.customProgramCacheKey = () =>
    `cheoma-dof-depth|${LOD_SCREEN_DOOR_PROGRAM_VERSION}`;
  return material;
}

/**
 * BokehPass whose depth prepass contains only opaque depth contributors.
 * The stock pass uses one opaque override material for the entire scene, which
 * otherwise turns drifting particles, smoke, clouds, and overlays into fake depth.
 */
export class StableBokehPass extends BokehPass {
  constructor(scene, camera, params) {
    super(scene, camera, params);
    installCircularBokeh(this.materialBokeh, params?.bokeh);
    this.bokehSampleCount = CIRCULAR_BOKEH_SAMPLE_COUNT;
    this.depthExcludedCount = 0;
    this.depthDitheredCount = 0;
    this.instFadeDepthCount = 0;
    this.lodScreenDoorDepthCount = 0;
    this.sourceDepthMaterialCount = 0;
    this._hiddenForDepth = [];
    this._materialsForDepth = [];
    this._instFadeDepthMaterial = createInstFadeDepthMaterial();
    this._lodScreenDoorDepthMaterial = createLodScreenDoorDepthMaterial();
    this.highlightPrefilter = new BokehHighlightPrefilter();
    this.uniforms.tHighlight.value = this.highlightPrefilter.target.texture;
    this._sourceScatter = new BokehSourceScatter();
    this._sourceScatterEnabled = true;
    this._width = 1;
    this._height = 1;
  }

  render(renderer, writeBuffer, readBuffer, deltaTime, maskActive) {
    const hidden = this._hiddenForDepth;
    const materials = this._materialsForDepth;
    const previousOverride = this.scene.overrideMaterial;
    const previousBackground = this.scene.background;
    hidden.length = 0;
    materials.length = 0;
    let instFadeDepthCount = 0;
    let lodScreenDoorDepthCount = 0;
    let sourceDepthMaterialCount = 0;
    // Match WebGLRenderer's effective visibility. A visible child beneath a hidden
    // group cannot reach either pass, so walking that subtree only burns CPU and
    // can inflate the diagnostic counts in large village scenes.
    this.scene.traverseVisible((object) => {
      const renderable =
        object.isMesh || object.isPoints || object.isLine || object.isSprite;
      const sourceDepthMaterial = renderable
        ? dofDepthMaterialForObject(object)
        : null;
      const contributes =
        !!sourceDepthMaterial || (renderable && contributesDofDepth(object));
      if (renderable && !contributes) hidden.push(object);
      if (sourceDepthMaterial) {
        // This material has allowOverride=false and therefore preserves the
        // source primitive's exact vertex size and fragment silhouette while
        // the rest of the scene uses BokehPass's packed MeshDepthMaterial.
        materials.push(object, object.material, sourceDepthMaterial);
        sourceDepthMaterialCount++;
      } else if (
        contributes &&
        object.isMesh &&
        object.geometry?.getAttribute?.("instFade")
      ) {
        materials.push(object, object.material, this._instFadeDepthMaterial);
        instFadeDepthCount++;
      } else if (contributes && object.isMesh && hasLodScreenDoor(object)) {
        materials.push(
          object,
          object.material,
          this._lodScreenDoorDepthMaterial,
        );
        lodScreenDoorDepthCount++;
      }
    });
    for (const object of hidden) object.visible = false;
    for (let i = 0; i < materials.length; i += 3)
      materials[i].material = materials[i + 2];
    this.depthExcludedCount = hidden.length;
    this.depthDitheredCount = instFadeDepthCount + lodScreenDoorDepthCount;
    this.instFadeDepthCount = instFadeDepthCount;
    this.lodScreenDoorDepthCount = lodScreenDoorDepthCount;
    this.sourceDepthMaterialCount = sourceDepthMaterialCount;
    // BokehPass clears its packed-depth target to white (far). A Scene Color background would
    // immediately clear over that with arbitrary RGB, which unpackRGBAToDepth interprets as a
    // time/weather-dependent fake distance. Keep sky pixels at the deliberate far-depth clear.
    this.scene.background = null;
    try {
      this._renderWithHighlightPrefilter(renderer, writeBuffer, readBuffer);
    } finally {
      this.scene.overrideMaterial = previousOverride;
      this.scene.background = previousBackground;
      for (let i = 0; i < materials.length; i += 3)
        materials[i].material = materials[i + 1];
      for (const object of hidden) object.visible = true;
      hidden.length = 0;
      materials.length = 0;
    }
  }

  _renderWithHighlightPrefilter(renderer, writeBuffer, readBuffer) {
    this.scene.overrideMaterial = this._materialDepth;
    renderer.getClearColor(this._oldClearColor);
    const oldClearAlpha = renderer.getClearAlpha();
    const oldAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    try {
      renderer.setClearColor(0xffffff);
      renderer.setClearAlpha(1);
      renderer.setRenderTarget(this._renderTargetDepth);
      renderer.clear();
      renderer.render(this.scene, this.camera);

      this.uniforms.tHighlight.value = this.highlightPrefilter.render(
        renderer,
        {
          colorTexture: readBuffer.texture,
          threshold: this.uniforms.highlightThreshold.value,
          knee: this.uniforms.highlightKnee.value,
        },
      );
      this.uniforms.tColor.value = readBuffer.texture;
      this.uniforms.nearClip.value = this.camera.near;
      this.uniforms.farClip.value = this.camera.far;
      this.uniforms.bokehSourceScatter.value = this._sourceScatterEnabled
        ? 1
        : 0;

      renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
      if (!this.renderToScreen) renderer.clear();
      this._fsQuad.render(renderer);
      if (this._sourceScatterEnabled) {
        this._sourceScatter.render(
          renderer,
          this.renderToScreen ? null : writeBuffer,
          this.highlightPrefilter.target.texture,
          readBuffer.texture,
          this._renderTargetDepth.texture,
          this.camera,
          this.uniforms.focus.value,
          this.uniforms.aperture.value,
          this.uniforms.maxblur.value,
          this.uniforms.bokehRadiusScale.value,
          this.uniforms.highlightThreshold.value,
          this.uniforms.highlightKnee.value,
        );
      }
    } finally {
      renderer.setClearColor(this._oldClearColor);
      renderer.setClearAlpha(oldClearAlpha);
      renderer.autoClear = oldAutoClear;
    }
  }

  setSize(width, height) {
    super.setSize(width, height);
    this._width = Math.max(1, width);
    this._height = Math.max(1, height);
    this.materialBokeh.uniforms.viewportWidth.value = Math.max(1, width);
    this.highlightPrefilter.setSize(width, height);
    this._sourceScatter.setSize(this._width, this._height);
  }

  /** Verification counterfactual; the product path keeps source scatter enabled. */
  setSourceScatterEnabled(enabled) {
    this._sourceScatterEnabled = !!enabled;
    return this._sourceScatterEnabled;
  }

  debugSourceScatter() {
    return {
      enabled: this._sourceScatterEnabled,
      allocated: !!this._sourceScatter,
      gridWidth: this._sourceScatter?.gridWidth || 0,
      gridHeight: this._sourceScatter?.gridHeight || 0,
      vertexCount: this._sourceScatter?.vertexCount || 0,
      renderCount: this._sourceScatter?.renderCount || 0,
      backend: this._sourceScatter?.backend || null,
      pointSizeRange: this._sourceScatter?.pointSizeRange || null,
      requiredPointDiameter: this._sourceScatter?.requiredPointDiameter || 0,
    };
  }

  debugResources() {
    return {
      highlightPrefilter: this.highlightPrefilter,
      highlightTarget: this.highlightPrefilter?.target || null,
      highlightMaterial: this.highlightPrefilter?.material || null,
      sourceScatter: this._sourceScatter,
      sourceScatterMaterial: this._sourceScatter?.material || null,
      sourcePointGeometry: this._sourceScatter?.pointGeometry || null,
      sourceTriangleGeometry: this._sourceScatter?.triangleGeometry || null,
    };
  }

  setBokehQuality(value) {
    const quality = Math.max(0, Math.min(1, Number(value) || 0));
    this.materialBokeh.uniforms.bokehQuality.value = quality;
    this.bokehSampleCount =
      quality > 0 ? CIRCULAR_BOKEH_SAMPLE_COUNT : MOVING_BOKEH_SAMPLE_COUNT;
    return quality;
  }

  dispose() {
    this._hiddenForDepth.length = 0;
    this._materialsForDepth.length = 0;
    this._instFadeDepthMaterial.dispose();
    this._lodScreenDoorDepthMaterial.dispose();
    this.highlightPrefilter.dispose();
    this._sourceScatter?.dispose();
    this._sourceScatter = null;
    super.dispose();
  }
}
