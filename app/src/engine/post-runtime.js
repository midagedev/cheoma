import * as THREE from 'three';
import { OutlinePass } from 'three/addons/postprocessing/OutlinePass.js';
import { setupPost } from '../../../src/api/environment.js';

/** Wire the app's flagship post-processing pipeline and its hover outline. */
export function createPostRuntime({ renderer, scene, camera, width, height, perf = false, compact = false }) {
  const post = setupPost({ renderer, scene, camera });
  post.setDof(!perf);
  post.setFlareEnabled(!perf);

  const applyBloomResolution = (w, h) => {
    if (compact) post.bloomPass.setSize(Math.max(1, w >> 1), Math.max(1, h >> 1));
  };
  applyBloomResolution(width, height);

  const outline = new OutlinePass(new THREE.Vector2(width, height), scene, camera);
  outline.edgeStrength = 2.2;
  outline.edgeGlow = 0;
  outline.edgeThickness = 1;
  outline.pulsePeriod = 0;
  outline.visibleEdgeColor.set('#2c2620');
  // OutlinePass always renders hidden edges; black makes the additive result invisible.
  outline.hiddenEdgeColor.set('#000000');
  outline.selectedObjects = [];
  post.composer.insertPass(outline, post.composer.passes.length - 1);

  return {
    post,
    outline,
    dofOn: !perf,
    resize(w, h) {
      post.setSize(w, h);
      // composer.setSize restores bloom to full resolution, so compact mode reapplies its cap.
      applyBloomResolution(w, h);
      outline.setSize(w, h);
    },
  };
}
