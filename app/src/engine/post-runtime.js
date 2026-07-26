import * as THREE from 'three';
import { OutlinePass } from 'three/addons/postprocessing/OutlinePass.js';
import { setupPost, MSAA_SAMPLES_COMPACT, MSAA_SAMPLES_DESKTOP } from '../../../src/api/environment.js';
import { VILLAGE_FOCUS_DOF_APERTURE } from '../../../src/api/cinematic.js';
import { createPostQualityRuntime } from './post-quality-runtime.js';

/** Wire the app's flagship post-processing pipeline and its hover outline. */
export function createPostRuntime({ renderer, scene, camera, width, height, compact = false }) {
  // 기하 에지 MSAA. 컴포저가 켜진 순간 렌더러의 antialias 플래그는 무효이므로 이 값이 제품
  //   화면의 유일한 AA 소스다(src/env/msaa-render-pass.js). 폰이 2x 인 이유는 필레이트가 아니라
  //   멀티샘플 컬러 버퍼 메모리다 — SHADOW_SIZE 와 같은 iOS Safari 상한 제약.
  const post = setupPost({
    renderer,
    scene,
    camera,
    msaaSamples: compact ? MSAA_SAMPLES_COMPACT : MSAA_SAMPLES_DESKTOP,
  });
  post.setDofAperture(VILLAGE_FOCUS_DOF_APERTURE);
  // DoF·플레어는 전 디바이스에서 살아 있다. 둘은 focus 문맥이 소유하고(engine setPostFocus), 부감은
  // amount=0·flare off 계약이라 근접 프레임에만 비용이 든다. 종전의 폰 하드 OFF 는 측정된 대가가
  // 프로그램 +9(focus 136→145)뿐이었는데 앱의 서명 광학을 통째로 지웠다 —
  // docs/mobile-effects-audit.md M3·M4, docs/look-grammar.md §5.
  post.setDof(true);
  post.setFlareEnabled(true);

  let cssW = Math.max(1, width);
  let cssH = Math.max(1, height);
  const applyBloomResolution = (w, h) => {
    if (compact) post.bloomPass.setSize(Math.max(1, w >> 1), Math.max(1, h >> 1));
  };
  applyBloomResolution(cssW, cssH);

  const qualityRuntime = createPostQualityRuntime({
    camera,
    bokehPass: post.bokehPass,
    width: cssW,
    height: cssH,
    // Camera orbits cut fill-rate via a binary composer pixel-ratio scale while
    // settled frames restore full density (src/env/post-quality-state.js).
    // composer.setSize restores bloom to full CSS size, so compact re-caps after.
    setFillScale: (scale) => {
      post.setFillScale?.(scale);
      applyBloomResolution(cssW, cssH);
    },
  });

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
        // AA 회귀 게이트 판독축: samples=0 이면 컴포저 경로에 AA 가 전혀 없다.
        //   setSamples 로 런타임 교체될 수 있으므로 패스에서 라이브로 읽는다.
        msaaSamples: post.renderPass.samples,
        msaaAllocated: post.renderPass.allocated,
        msaaSampleBytes: post.renderPass.sampleBytes,
        composer: {
          width: post.composer.renderTarget1.width,
          height: post.composer.renderTarget1.height,
        },
        outline: {
          width: outline.renderTargetMaskBuffer.width,
          height: outline.renderTargetMaskBuffer.height,
        },
        // 프로그램·텍스처 수는 해상도/AA 판정의 유일하게 신뢰 가능한 성능 축이다
        // (헤드리스 ANGLE 의 절대 프레임 ms 는 증거가 못 된다 — CLAUDE.md 검증 절).
        programs: renderer.info.programs?.length ?? null,
        textures: renderer.info.memory.textures,
        geometries: renderer.info.memory.geometries,
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
        msaaTarget: post.renderPass.target,
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
      cssW = Math.max(1, w);
      cssH = Math.max(1, h);
      post.setSize(cssW, cssH);
      qualityRuntime.resize(cssW, cssH);
      // composer.setSize restores bloom to full resolution, so compact mode reapplies its cap.
      applyBloomResolution(cssW, cssH);
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
