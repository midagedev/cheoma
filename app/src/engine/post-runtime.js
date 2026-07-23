import * as THREE from 'three';
import { OutlinePass } from 'three/addons/postprocessing/OutlinePass.js';
import { setupPost } from '../../../src/api/environment.js';
import { createPostQualityRuntime } from './post-quality-runtime.js';

/** Wire the app's flagship post-processing pipeline and its hover outline. */
export function createPostRuntime({ renderer, scene, camera, width, height, perf = false, compact = false }) {
  const post = setupPost({ renderer, scene, camera });
  post.setDof(!perf);
  post.setFlareEnabled(!perf);
  const qualityRuntime = createPostQualityRuntime({
    camera,
    bokehPass: post.bokehPass,
    width,
    height,
  });

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

  // constructor.name 은 three 배포 빌드에서 선행 '_'가 붙거나 minify될 수 있다. 소유한 패스
  // 참조로 이름을 고정해 브라우저/빌드 종류와 무관한 검증 계약을 제공한다.
  const debugNames = new Map([
    [post.renderPass, 'RenderPass'],
    [post.gradePass, 'GradePass'],
    [post.rimPass, 'RimPass'],
    [post.bloomPass, 'UnrealBloomPass'],
    [post.bokehPass, 'BokehPass'],
    [post.flarePass, 'FlarePass'],
    [outline, 'OutlinePass'],
    [post.outputPass, 'OutputPass'],
  ].filter(([pass]) => !!pass));

  let disposed = false;
  return {
    post,
    outline,
    dofOn: !perf,
    updateQuality(dt, referenceDepth) {
      if (disposed) return null;
      return qualityRuntime.update(dt, referenceDepth);
    },
    debugQuality() {
      return qualityRuntime.debug();
    },
    debugPassOrder() {
      return post.composer.passes.map((pass) => debugNames.get(pass) || pass?.name || 'Pass');
    },
    debugResolution() {
      return {
        pixelRatio: renderer.getPixelRatio(),
        composer: {
          width: post.composer.renderTarget1.width,
          height: post.composer.renderTarget1.height,
        },
        outline: {
          width: outline.renderTargetMaskBuffer.width,
          height: outline.renderTargetMaskBuffer.height,
        },
      };
    },
    debugResources() {
      const bokehResources = post.bokehPass.debugResources();
      return {
        bokehPass: post.bokehPass,
        depthTarget: post.bokehPass._renderTargetDepth,
        depthTexture: post.bokehPass._renderTargetDepth?.texture,
        bokehMaterial: post.bokehPass.materialBokeh,
        instFadeDepthMaterial: post.bokehPass._instFadeDepthMaterial,
        lodScreenDoorDepthMaterial: post.bokehPass._lodScreenDoorDepthMaterial,
        sunGlow: post.sunGlow,
        ...bokehResources,
        composerTarget1: post.composer.renderTarget1,
        composerTarget2: post.composer.renderTarget2,
        composerReadBuffer: post.composer.readBuffer,
        composerWriteBuffer: post.composer.writeBuffer,
        passCount: post.composer.passes.length,
      };
    },
    addPassBeforeOutput(pass, name = 'Pass') {
      if (disposed || !pass || post.composer.passes.includes(pass)) return pass;
      post.composer.insertPass(pass, post.composer.passes.indexOf(post.outputPass));
      debugNames.set(pass, name);
      return pass;
    },
    addPassAfterRender(pass, name = 'Pass') {
      if (disposed || !pass || post.composer.passes.includes(pass)) return pass;
      const renderIndex = post.composer.passes.indexOf(post.renderPass);
      post.composer.insertPass(pass, Math.max(0, renderIndex) + 1);
      debugNames.set(pass, name);
      return pass;
    },
    removePass(pass) {
      if (!pass) return;
      post.composer.removePass(pass);
      debugNames.delete(pass);
    },
    resize(w, h) {
      if (disposed) return;
      post.setSize(w, h);
      qualityRuntime.resize(w, h);
      // composer.setSize restores bloom to full resolution, so compact mode reapplies its cap.
      applyBloomResolution(w, h);
      // OutlinePass 크기는 composer가 현재 DPR을 반영한 device px로 이미 전파한다.
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      outline.selectedObjects = [];
      post.composer.removePass(outline);
      outline.dispose();
      post.dispose();
    },
  };
}
