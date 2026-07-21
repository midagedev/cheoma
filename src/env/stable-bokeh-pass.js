import { BokehPass } from 'three/addons/postprocessing/BokehPass.js';
import { MeshDepthMaterial, NoBlending, RGBADepthPacking } from 'three';
import { contributesDofDepth } from './dof.js';
import { CIRCULAR_BOKEH_SAMPLE_COUNT, installCircularBokeh } from './circular-bokeh-shader.js';
import { INST_FADE_PROGRAM_VERSION, patchInstFadeShader } from './inst-fade-shader.js';

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
  material.customProgramCacheKey = () => `cheoma-dof-depth|${INST_FADE_PROGRAM_VERSION}`;
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
    this._hiddenForDepth = [];
    this._materialsForDepth = [];
    this._instFadeDepthMaterial = createInstFadeDepthMaterial();
  }

  render(renderer, writeBuffer, readBuffer, deltaTime, maskActive) {
    const hidden = this._hiddenForDepth;
    const materials = this._materialsForDepth;
    const previousOverride = this.scene.overrideMaterial;
    const previousBackground = this.scene.background;
    hidden.length = 0;
    materials.length = 0;
    // Match WebGLRenderer's effective visibility. A visible child beneath a hidden
    // group cannot reach either pass, so walking that subtree only burns CPU and
    // can inflate the diagnostic counts in large village scenes.
    this.scene.traverseVisible((object) => {
      const renderable = object.isMesh || object.isPoints || object.isLine || object.isSprite;
      const contributes = renderable && contributesDofDepth(object);
      if (renderable && !contributes) hidden.push(object);
      if (contributes && object.isMesh && object.geometry?.getAttribute?.('instFade')) {
        materials.push(object, object.material);
      }
    });
    for (const object of hidden) object.visible = false;
    for (let i = 0; i < materials.length; i += 2) materials[i].material = this._instFadeDepthMaterial;
    this.depthExcludedCount = hidden.length;
    this.depthDitheredCount = materials.length / 2;
    // BokehPass clears its packed-depth target to white (far). A Scene Color background would
    // immediately clear over that with arbitrary RGB, which unpackRGBAToDepth interprets as a
    // time/weather-dependent fake distance. Keep sky pixels at the deliberate far-depth clear.
    this.scene.background = null;
    try {
      super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
    } finally {
      this.scene.overrideMaterial = previousOverride;
      this.scene.background = previousBackground;
      for (let i = 0; i < materials.length; i += 2) materials[i].material = materials[i + 1];
      for (const object of hidden) object.visible = true;
      hidden.length = 0;
      materials.length = 0;
    }
  }

  setSize(width, height) {
    super.setSize(width, height);
    this.materialBokeh.uniforms.viewportWidth.value = Math.max(1, width);
  }

  dispose() {
    this._hiddenForDepth.length = 0;
    this._materialsForDepth.length = 0;
    this._instFadeDepthMaterial.dispose();
    super.dispose();
  }
}
