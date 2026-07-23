// Browser-side counterexamples for the compact-source ownership contract.
import { BOKEH_SOURCE_CONTRACT } from "../../src/env/bokeh-source-contract.js";

export async function runBokehSourceStress(page, threeModuleUrl) {
  return page.evaluate(
    async ({ moduleUrl }) => {
      const THREE = await import(moduleUrl);
      const engine = window.__engine;
      const resources = engine.debugPostResources();
      const pass = resources.bokehPass;
      const renderer = engine.renderer;
      const gl = renderer.getContext();
      const chart = engine.scene.getObjectByName("bokeh-optical-chart");
      const previousChartVisible = chart.visible;
      const previousScatterEnabled = pass.debugSourceScatter().enabled;
      const stress = new THREE.Group();
      stress.name = "bokeh-source-stress";
      engine.scene.add(stress);
      chart.visible = false;
      const disposables = [];

      try {
        const makeMaterial = (color) =>
          new THREE.MeshBasicMaterial({
            color: new THREE.Color(...color),
            fog: false,
          });
        const broad = new THREE.Mesh(
          new THREE.PlaneGeometry(220, 140),
          makeMaterial([1.4, 1.2, 1.0]),
        );
        disposables.push(broad.geometry, broad.material);
        broad.name = "broad-hdr-stress";
        broad.position.z = 70;
        stress.add(broad);
        const card = new THREE.Mesh(
          new THREE.PlaneGeometry(1, 1),
          makeMaterial([0.02, 0.02, 0.02]),
        );
        disposables.push(card.geometry, card.material);
        card.name = "narrow-depth-card-stress";
        stress.add(card);
        const productSunGlow = resources.sunGlow;
        if (!productSunGlow?.isSprite || !productSunGlow.material?.map) {
          throw new Error("missing product sunGlow sprite texture");
        }
        const sunProbe = new THREE.Sprite(productSunGlow.material.clone());
        sunProbe.name = "product-sunglow-compact-evidence-stress";
        sunProbe.material.color.setRGB(8, 4, 1);
        sunProbe.material.opacity = 1;
        sunProbe.material.toneMapped = false;
        sunProbe.scale.set(40, 40, 1);
        sunProbe.visible = false;
        stress.add(sunProbe);
        disposables.push(sunProbe.material);
        const pointVertex = `
      uniform float uPointSize;
      void main() {
        gl_PointSize = uPointSize;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `;
        const pointFragment = `
      uniform vec3 uColor;
      void main() {
        if (length(gl_PointCoord - 0.5) > 0.5) discard;
        gl_FragColor = vec4(uColor, 1.0);
      }
    `;
        const pointDepthFragment = `
      #include <packing>
      void main() {
        if (length(gl_PointCoord - 0.5) > 0.5) discard;
        gl_FragColor = packDepthToRGBA(gl_FragCoord.z);
      }
    `;
        const makeAdditivePoint = (color) => {
          const geometry = new THREE.BufferGeometry();
          geometry.setAttribute(
            "position",
            new THREE.Float32BufferAttribute([0, 0, 0], 3),
          );
          const uniforms = {
            uColor: { value: new THREE.Color(...color) },
            uPointSize: { value: 4 },
          };
          const material = new THREE.ShaderMaterial({
            uniforms,
            vertexShader: pointVertex,
            fragmentShader: pointFragment,
            transparent: true,
            depthTest: true,
            depthWrite: false,
            blending: THREE.CustomBlending,
            blendEquation: THREE.AddEquation,
            blendSrc: THREE.OneFactor,
            blendDst: THREE.OneFactor,
            toneMapped: false,
          });
          // Keep the fixture's color mutation API aligned with built-in materials.
          material.color = uniforms.uColor.value;
          const depthMaterial = new THREE.ShaderMaterial({
            uniforms,
            vertexShader: pointVertex,
            fragmentShader: pointDepthFragment,
            depthTest: true,
            depthWrite: true,
            blending: THREE.NoBlending,
          });
          depthMaterial.allowOverride = false;
          const points = new THREE.Points(geometry, material);
          points.frustumCulled = false;
          points.userData.dofDepthMaterial = depthMaterial;
          return points;
        };
        const near = makeAdditivePoint([11.0, 4.2, 0.75]);
        disposables.push(
          near.geometry,
          near.material,
          near.userData.dofDepthMaterial,
        );
        near.name = "near-compact-stress";
        stress.add(near);
        const far = makeAdditivePoint([2.4, 5.0, 11.5]);
        disposables.push(
          far.geometry,
          far.material,
          far.userData.dofDepthMaterial,
        );
        far.name = "far-compact-stress";
        stress.add(far);

        engine.camera.position.set(0, 0, 100);
        engine.__controls.target.set(0, 0, 0);
        engine.camera.lookAt(engine.__controls.target);
        engine.camera.updateMatrixWorld(true);
        const width = gl.drawingBufferWidth;
        const height = gl.drawingBufferHeight;
        const captureWidth = 160;
        const captureHeight = 120;
        const captureX = Math.floor((width - captureWidth) * 0.5);
        const captureY = Math.floor((height - captureHeight) * 0.5);
        const halfToFloat = (half) => {
          const sign = half & 0x8000 ? -1 : 1;
          const exponent = (half >> 10) & 0x1f;
          const fraction = half & 0x03ff;
          if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
          if (exponent === 31) return fraction ? NaN : sign * Infinity;
          return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
        };
        const toLuminance = (raw) =>
          Float64Array.from(
            { length: raw.length / 4 },
            (_, index) =>
              0.2126 * halfToFloat(raw[index * 4]) +
              0.7152 * halfToFloat(raw[index * 4 + 1]) +
              0.0722 * halfToFloat(raw[index * 4 + 2]),
          );
        const captureRegion = (
          scatterEnabled,
          region,
          includeInput = false,
          drawScatter = scatterEnabled,
        ) => {
          let raw = null;
          let inputRaw = null;
          const originalRender = pass.render;
          const sourceScatter = pass.debugResources().sourceScatter;
          const originalScatterRender = sourceScatter.render;
          pass.setSourceScatterEnabled(scatterEnabled);
          if (scatterEnabled && !drawScatter) {
            sourceScatter.render = () => {};
          }
          pass.render = function captureStress(
            rendererArg,
            writeBuffer,
            ...args
          ) {
            if (includeInput) {
              inputRaw = new Uint16Array(region.width * region.height * 4);
              rendererArg.readRenderTargetPixels(
                args[0],
                region.x,
                region.y,
                region.width,
                region.height,
                inputRaw,
              );
            }
            originalRender.call(this, rendererArg, writeBuffer, ...args);
            raw = new Uint16Array(region.width * region.height * 4);
            rendererArg.readRenderTargetPixels(
              writeBuffer,
              region.x,
              region.y,
              region.width,
              region.height,
              raw,
            );
          };
          try {
            engine.debugRenderDofFrame();
          } finally {
            pass.render = originalRender;
            sourceScatter.render = originalScatterRender;
          }
          const output = toLuminance(raw);
          return includeInput
            ? { output, input: toLuminance(inputRaw) }
            : output;
        };
        const capture = (
          scatterEnabled,
          includeInput = false,
          drawScatter = scatterEnabled,
        ) =>
          captureRegion(
            scatterEnabled,
            {
              x: captureX,
              y: captureY,
              width: captureWidth,
              height: captureHeight,
            },
            includeInput,
            drawScatter,
          );
        const setVisible = ({
          broad: showBroad,
          card: showCard = false,
          sun: showSun = false,
          near: showNear,
          far: showFar,
        }) => {
          broad.visible = showBroad;
          card.visible = showCard;
          sunProbe.visible = showSun;
          near.visible = showNear;
          far.visible = showFar;
          stress.updateMatrixWorld(true);
        };
        const placeAtPixel = (object, pixelX, pixelY, z) => {
          const distance = engine.camera.position.z - z;
          const tan = Math.tan(
            THREE.MathUtils.degToRad(engine.camera.fov * 0.5),
          );
          object.position.set(
            ((pixelX / width) * 2 - 1) * distance * tan * engine.camera.aspect,
            (1 - (pixelY / height) * 2) * distance * tan,
            z,
          );
        };
        const placePlaneAtPixels = (
          object,
          pixelX,
          pixelY,
          pixelWidth,
          pixelHeight,
          z,
        ) => {
          const distance = engine.camera.position.z - z;
          const tan = Math.tan(
            THREE.MathUtils.degToRad(engine.camera.fov * 0.5),
          );
          const worldHeight = 2 * distance * tan;
          const worldWidth = worldHeight * engine.camera.aspect;
          object.scale.set(
            (pixelWidth / width) * worldWidth,
            (pixelHeight / height) * worldHeight,
            1,
          );
          placeAtPixel(object, pixelX, pixelY, z);
        };
        const deltaStats = (a, b) => {
          let positive = 0;
          let negative = 0;
          let signed = 0;
          let absolute = 0;
          for (let index = 0; index < a.length; index++) {
            const delta = a[index] - b[index];
            signed += delta;
            positive += Math.max(0, delta);
            negative += Math.max(0, -delta);
            absolute += Math.abs(delta);
          }
          return { positive, negative, signed, absolute };
        };
        const differentialStats = (
          a,
          b,
          baselineA,
          baselineB,
        ) => {
          let positive = 0;
          let negative = 0;
          let signed = 0;
          let absolute = 0;
          for (let index = 0; index < a.length; index++) {
            const delta =
              a[index] -
              b[index] -
              (baselineA[index] - baselineB[index]);
            signed += delta;
            positive += Math.max(0, delta);
            negative += Math.max(0, -delta);
            absolute += Math.abs(delta);
          }
          return { positive, negative, signed, absolute };
        };
        const positivePeak = (a, b) => {
          let peak = 0;
          for (let index = 0; index < a.length; index++) {
            peak = Math.max(peak, a[index] - b[index]);
          }
          return peak;
        };
        const deltaStatsInRect = (a, b, rect, include = () => true) => {
          let positive = 0;
          let negative = 0;
          let signed = 0;
          let absolute = 0;
          let samples = 0;
          const minX = rect.centerX - rect.width * 0.5;
          const maxX = rect.centerX + rect.width * 0.5;
          const centerYGl = height - rect.centerY;
          const minY = centerYGl - rect.height * 0.5;
          const maxY = centerYGl + rect.height * 0.5;
          for (let row = 0; row < captureHeight; row++) {
            const pixelY = captureY + row + 0.5;
            if (pixelY < minY || pixelY > maxY) continue;
            for (let column = 0; column < captureWidth; column++) {
              const pixelX = captureX + column + 0.5;
              if (pixelX < minX || pixelX > maxX) continue;
              const index = row * captureWidth + column;
              if (!include(index)) continue;
              const delta = a[index] - b[index];
              signed += delta;
              positive += Math.max(0, delta);
              negative += Math.max(0, -delta);
              absolute += Math.abs(delta);
              samples++;
            }
          }
          return {
            positive,
            negative,
            signed,
            absolute,
            samples,
          };
        };
        const superposition = (both, first, second, none) => {
          let error = 0;
          let reference = 0;
          let signedError = 0;
          for (let index = 0; index < both.length; index++) {
            const actual = both[index] - none[index];
            const expected = first[index] + second[index] - none[index] * 2;
            const delta = actual - expected;
            error += Math.abs(delta);
            signedError += delta;
            reference += Math.abs(expected);
          }
          return {
            relativeAbsoluteError: error / Math.max(reference, 1e-9),
            relativeSignedError:
              Math.abs(signedError) / Math.max(reference, 1e-9),
          };
        };

        const sourceRadiusAtZ = (z) => {
          const uniforms = pass.materialBokeh.uniforms;
          const viewDepth = engine.camera.position.z - z;
          const signedBlur = THREE.MathUtils.clamp(
            (uniforms.focus.value - viewDepth) * uniforms.aperture.value,
            -uniforms.maxblur.value,
            uniforms.maxblur.value,
          );
          return (
            Math.abs(signedBlur) *
            uniforms.bokehRadiusScale.value *
            width *
            Math.sqrt(3) *
            0.5
          );
        };
        const rawPointRadius = far.material.uniforms.uPointSize.value * 0.5;
        const nearZ = 60;
        const farZ = -140;
        const sourceRadii = {
          near: sourceRadiusAtZ(nearZ),
          far: sourceRadiusAtZ(farZ),
        };

        setVisible({ broad: false, near: false, far: false });
        const noneFrame = capture(true, true);
        const none = noneFrame.output;
        const noneInput = noneFrame.input;
        const noneNoScatterDraw = capture(true, false, false);
        const captureClosePair = (separation) => {
          placeAtPixel(
            near,
            width * 0.5 - separation * 0.5,
            height * 0.5,
            nearZ,
          );
          placeAtPixel(far, width * 0.5 + separation * 0.5, height * 0.5, farZ);
          setVisible({ broad: false, near: true, far: false });
          const nearOnly = capture(true);
          setVisible({ broad: false, near: false, far: true });
          const farOnly = capture(true);
          setVisible({ broad: false, near: true, far: true });
          const both = capture(true);
          return {
            separation,
            sourceRadii,
            sourceDepthMaterialCount: pass.sourceDepthMaterialCount,
            ...superposition(both, nearOnly, farOnly, none),
            near: deltaStats(nearOnly, none),
            far: deltaStats(farOnly, none),
            both: deltaStats(both, none),
          };
        };
        const closePairs = [4, 8].map(captureClosePair);

        const originalFarColor = far.material.color.clone();
        far.material.color.copy(near.material.color);
        const sameHueClosePairs = [2, 4].map(captureClosePair);

        const sameHueDepthIsolation = [4].map((separation) => {
          const centerX = width * 0.5;
          const centerY = height * 0.5;
          const nearX = centerX - separation * 0.5;
          const farX = centerX + separation * 0.5;
          const cardRect = {
            centerX: centerX + 18,
            centerY,
            width: 6,
            height: 80,
          };
          placeAtPixel(near, nearX, centerY, nearZ);
          placeAtPixel(far, farX, centerY, farZ);
          placePlaneAtPixels(
            card,
            cardRect.centerX,
            cardRect.centerY,
            cardRect.width,
            cardRect.height,
            0,
          );
          setVisible({ broad: false, card: true, near: false, far: false });
          const cardOnly = capture(true);
          setVisible({ broad: false, card: true, near: false, far: true });
          const cardAndFar = capture(true);
          setVisible({ broad: false, card: true, near: true, far: false });
          const nearOnly = capture(true);
          setVisible({ broad: false, card: true, near: true, far: true });
          const both = capture(true);
          setVisible({ broad: false, card: false, near: false, far: true });
          const farOpen = capture(true);
          const frontControlZ = nearZ;
          placeAtPixel(far, farX, centerY, frontControlZ);
          setVisible({ broad: false, card: true, near: false, far: true });
          const cardAndFrontFar = capture(true);
          placeAtPixel(far, farX, centerY, farZ);
          const isRenderedCardPixel = (index) =>
            Math.abs(cardOnly[index] - none[index]) > 0.001;
          const nearReference = deltaStatsInRect(
            nearOnly,
            cardOnly,
            cardRect,
            isRenderedCardPixel,
          );
          const farLeak = deltaStatsInRect(
            both,
            nearOnly,
            cardRect,
            isRenderedCardPixel,
          );
          const directFarLeak = deltaStatsInRect(
            cardAndFar,
            cardOnly,
            cardRect,
            isRenderedCardPixel,
          );
          const frontDepthControl = deltaStatsInRect(
            cardAndFrontFar,
            cardOnly,
            cardRect,
            isRenderedCardPixel,
          );
          const farReference = deltaStats(farOpen, none);
          const cardMinX = cardRect.centerX - cardRect.width * 0.5;
          return {
            separation,
            sourceRadii,
            cardRect,
            farCenterX: farX,
            rawFarRadius: rawPointRadius,
            emitterOutsideCard: farX + rawPointRadius < cardMinX,
            apertureOverlapsCard: farX + sourceRadii.far > cardMinX,
            nearReference,
            farReference,
            farLeak,
            directFarLeak,
            frontDepthControl,
            frontControlRatio:
              frontDepthControl.positive /
              Math.max(farReference.positive, 1e-9),
            rearPositiveLeakRatio:
              directFarLeak.positive /
              Math.max(frontDepthControl.positive, 1e-9),
            rearAbsoluteLeakRatio:
              directFarLeak.absolute /
              Math.max(frontDepthControl.absolute, 1e-9),
            ownershipSignedResidualRatio:
              Math.abs(farLeak.signed) /
              Math.max(frontDepthControl.positive, 1e-9),
          };
        });
        far.material.color.copy(originalFarColor);

        const nearLayerOccluder = (() => {
          const centerX = width * 0.5;
          const centerY = height * 0.5;
          const sourceX = centerX - 16;
          const cardRect = {
            centerX: centerX - 10,
            centerY,
            width: 6,
            height: 80,
          };
          placeAtPixel(near, sourceX, centerY, nearZ);
          placePlaneAtPixels(
            card,
            cardRect.centerX,
            cardRect.centerY,
            cardRect.width,
            cardRect.height,
            nearZ + 0.1,
          );
          setVisible({ broad: false, card: true, near: false, far: false });
          const cardOnly = capture(true);
          setVisible({ broad: false, card: true, near: true, far: false });
          const occluded = capture(true);
          setVisible({ broad: false, card: false, near: true, far: false });
          const open = capture(true);
          placePlaneAtPixels(
            card,
            cardRect.centerX,
            cardRect.centerY,
            cardRect.width,
            cardRect.height,
            nearZ - 0.1,
          );
          setVisible({ broad: false, card: true, near: false, far: false });
          const backCardOnly = capture(true);
          setVisible({ broad: false, card: true, near: true, far: false });
          const frontControl = capture(true);
          const isRenderedCardPixel = (index) =>
            Math.abs(cardOnly[index] - none[index]) > 0.001;
          const leak = deltaStatsInRect(
            occluded,
            cardOnly,
            cardRect,
            isRenderedCardPixel,
          );
          const front = deltaStatsInRect(
            frontControl,
            backCardOnly,
            cardRect,
            isRenderedCardPixel,
          );
          const openReference = deltaStats(open, none);
          return {
            sourceDepth: engine.camera.position.z - nearZ,
            occluderDepth: engine.camera.position.z - (nearZ + 0.1),
            cardRect,
            sourceX,
            apertureRadius: sourceRadiusAtZ(nearZ),
            sourceOutsideCard:
              sourceX + rawPointRadius <
              cardRect.centerX - cardRect.width * 0.5,
            apertureOverlapsCard:
              sourceX + sourceRadiusAtZ(nearZ) >
              cardRect.centerX - cardRect.width * 0.5,
            openReference,
            leak,
            front,
            leakRatio:
              leak.positive / Math.max(front.positive, 1e-9),
          };
        })();

        const originalNearColor = near.material.color.clone();
        const originalPointSize = near.material.uniforms.uPointSize.value;
        const originalAperture =
          pass.materialBokeh.uniforms.aperture.value;
        const captureSameBlockPair = ({
          name,
          firstColor,
          secondColor,
          firstDepth,
          secondDepth,
          aperture = originalAperture,
          secondPixelOffset = [1.5, 0.5],
        }) => {
          engine.debugTuneDof({ aperture });
          near.material.uniforms.uPointSize.value = 1;
          far.material.uniforms.uPointSize.value = 1;
          near.material.color.setRGB(...firstColor);
          far.material.color.setRGB(...secondColor);
          const blockX = Math.floor(width * 0.25) * 2;
          const blockY = Math.floor(height * 0.25) * 2;
          const firstZ = engine.camera.position.z - firstDepth;
          const secondZ = engine.camera.position.z - secondDepth;
          placeAtPixel(near, blockX + 0.5, blockY + 0.5, firstZ);
          placeAtPixel(
            far,
            blockX + secondPixelOffset[0],
            blockY + secondPixelOffset[1],
            secondZ,
          );
          setVisible({ broad: false, near: false, far: false });
          const baseline = capture(true);
          setVisible({ broad: false, near: true, far: false });
          const first = capture(true);
          setVisible({ broad: false, near: false, far: true });
          const second = capture(true);
          setVisible({ broad: false, near: true, far: true });
          const both = capture(true);
          return {
            name,
            blockOrigin: [blockX, blockY],
            sourcePixels: [
              [blockX + 0.5, blockY + 0.5],
              [
                blockX + secondPixelOffset[0],
                blockY + secondPixelOffset[1],
              ],
            ],
            depths: [firstDepth, secondDepth],
            radii: [sourceRadiusAtZ(firstZ), sourceRadiusAtZ(secondZ)],
            aperture,
            first: deltaStats(first, baseline),
            second: deltaStats(second, baseline),
            both: deltaStats(both, baseline),
            ...superposition(both, first, second, baseline),
          };
        };
        const sameBlockDifferentDepthHue = captureSameBlockPair({
          name: "same-block-different-depth-hue",
          firstColor: [11.0, 4.2, 0.75],
          secondColor: [2.4, 5.0, 11.5],
          firstDepth: engine.camera.position.z - nearZ,
          secondDepth: engine.camera.position.z - farZ,
        });
        const sameBlockOppositeFocus = captureSameBlockPair({
          name: "same-block-opposite-focus",
          firstColor: [7.0, 2.8, 0.7],
          secondColor: [0.3, 0.12, 0.03],
          firstDepth: pass.materialBokeh.uniforms.focus.value - 0.15,
          secondDepth: pass.materialBokeh.uniforms.focus.value + 0.2,
          aperture: 0.002,
          secondPixelOffset: [1.5, 1.5],
        });
        const sameBlockNearDepthDifferentHueOccluder = (() => {
          const sourceColor = [11.0, 4.2, 0.75];
          const destinationColor = [2.4, 5.0, 11.5];
          const sourceDepth = engine.camera.position.z - nearZ;
          const frontDestinationDepth = sourceDepth - 0.1;
          const backDestinationDepth = sourceDepth + 0.1;
          const blockX = Math.floor(width * 0.25) * 2;
          const blockY = Math.floor(height * 0.25) * 2;
          const sourcePixel = [blockX + 0.5, blockY + 0.5];
          const destinationPixel = [blockX + 1.5, blockY + 0.5];
          const destinationRect = {
            centerX: destinationPixel[0],
            centerY: destinationPixel[1],
            width: 1,
            height: 1,
          };
          engine.debugTuneDof({ aperture: originalAperture });
          near.material.uniforms.uPointSize.value = 1;
          far.material.uniforms.uPointSize.value = 1;
          near.material.color.setRGB(...sourceColor);
          far.material.color.setRGB(...destinationColor);
          placeAtPixel(
            near,
            sourcePixel[0],
            sourcePixel[1],
            engine.camera.position.z - sourceDepth,
          );
          placeAtPixel(
            far,
            destinationPixel[0],
            destinationPixel[1],
            engine.camera.position.z - frontDestinationDepth,
          );
          setVisible({ broad: false, near: false, far: false });
          const baseline = capture(true);
          setVisible({ broad: false, near: false, far: true });
          const frontDestinationOnly = capture(true);
          setVisible({ broad: false, near: true, far: true });
          const frontBoth = capture(true);
          const ownershipRaw = new Uint16Array(4);
          const ownershipTarget = pass.highlightPrefilter.target;
          const ownershipX = Math.floor((destinationPixel[0] - 0.5) / 2);
          const destinationGlY = height - destinationPixel[1];
          const ownershipY = Math.floor((destinationGlY - 0.5) / 2);
          renderer.readRenderTargetPixels(
            ownershipTarget,
            ownershipX,
            ownershipY,
            1,
            1,
            ownershipRaw,
          );
          setVisible({ broad: false, near: true, far: false });
          const sourceOpen = capture(true);
          placeAtPixel(
            far,
            destinationPixel[0],
            destinationPixel[1],
            engine.camera.position.z - backDestinationDepth,
          );
          setVisible({ broad: false, near: false, far: true });
          const backDestinationOnly = capture(true);
          setVisible({ broad: false, near: true, far: true });
          const backBoth = capture(true);
          const hueDot = sourceColor.reduce(
            (sum, value, index) => sum + value * destinationColor[index],
            0,
          );
          const sourceLengthSquared = sourceColor.reduce(
            (sum, value) => sum + value * value,
            0,
          );
          const destinationLengthSquared = destinationColor.reduce(
            (sum, value) => sum + value * value,
            0,
          );
          return {
            blockOrigin: [blockX, blockY],
            sourcePixel,
            destinationPixel,
            sourceDepth,
            sourceRadius: sourceRadiusAtZ(
              engine.camera.position.z - sourceDepth,
            ),
            frontDestinationDepth,
            backDestinationDepth,
            sourceColor,
            destinationColor,
            destinationPeak: Math.max(...destinationColor),
            destinationFloor:
              pass.materialBokeh.uniforms.highlightThreshold.value * 0.05,
            hueCosineSquared:
              (hueDot * hueDot) /
              (sourceLengthSquared * destinationLengthSquared),
            ownershipAlpha: halfToFloat(ownershipRaw[3]),
            sourceOpen: deltaStats(sourceOpen, baseline),
            frontDestination: deltaStatsInRect(
              frontDestinationOnly,
              baseline,
              destinationRect,
            ),
            frontLeak: deltaStatsInRect(
              frontBoth,
              frontDestinationOnly,
              destinationRect,
            ),
            backControl: deltaStatsInRect(
              backBoth,
              backDestinationOnly,
              destinationRect,
            ),
          };
        })();
        engine.debugTuneDof({ aperture: originalAperture });
        near.material.uniforms.uPointSize.value = originalPointSize;
        far.material.uniforms.uPointSize.value = originalPointSize;
        near.material.color.copy(originalNearColor);
        far.material.color.copy(originalFarColor);

        const highlightThreshold =
          pass.materialBokeh.uniforms.highlightThreshold.value;
        const highlightKnee = pass.materialBokeh.uniforms.highlightKnee.value;
        const thresholdLevels = [
          highlightThreshold - 0.34,
          highlightThreshold - 0.18,
          highlightThreshold - 0.06,
          highlightThreshold,
          highlightThreshold + 0.005,
          highlightThreshold + 0.02,
          highlightThreshold + 0.06,
          highlightThreshold + 0.22,
          highlightThreshold + 0.3,
          highlightThreshold + highlightKnee,
          highlightThreshold + highlightKnee + 0.2,
        ];
        placeAtPixel(near, width * 0.5, height * 0.5, nearZ);
        const thresholdSamples = thresholdLevels.map((level) => {
          near.material.color.setRGB(level, level * 0.42, level * 0.12);
          setVisible({ broad: false, near: true, far: false });
          const scatterOnFrame = capture(true, true);
          const scatterOn = scatterOnFrame.output;
          const on = deltaStats(scatterOn, none);
          const input = deltaStats(scatterOnFrame.input, noneInput);
          return {
            level,
            on,
            input,
            signedEnergyRatio: on.signed / Math.max(input.signed, 1e-9),
            peakRatio:
              positivePeak(scatterOn, none) /
              Math.max(positivePeak(scatterOnFrame.input, noneInput), 1e-9),
          };
        });
        const thresholdContinuity = {
          highlightThreshold,
          highlightKnee,
          samples: thresholdSamples,
        };
        const captureBlockSeamSweep = ({ name, level, pointSize }) => {
          near.material.color.setRGB(level, level * 0.42, level * 0.12);
          near.material.uniforms.uPointSize.value = pointSize;
          const blockX = Math.floor(width * 0.25) * 2;
          const blockY = Math.floor(height * 0.25) * 2;
          const samples = [0.25, 0.75, 1.25, 1.75].map((phase) => {
            placeAtPixel(near, blockX + phase, blockY + 0.5, nearZ);
            setVisible({ broad: false, near: true, far: false });
            const frame = capture(true, true);
            const input = deltaStats(frame.input, noneInput);
            const output = deltaStats(frame.output, none);
            return {
              phase,
              input,
              output,
              signedEnergyRatio:
                output.signed / Math.max(input.signed, 1e-9),
            };
          });
          return { name, level, pointSize, blockOrigin: [blockX, blockY], samples };
        };
        const blockSeamSweeps = [
          captureBlockSeamSweep({
            name: "threshold-knee",
            level: highlightThreshold + 0.02,
            pointSize: 4,
          }),
          captureBlockSeamSweep({
            name: "visibility-floor",
            level: highlightThreshold * 0.05 * 1.05,
            pointSize: 1,
          }),
        ];
        const oddViewportEdge = (() => {
          const viewport = [width, height];
          if (width % 2 !== 1 || height % 2 !== 1) {
            return { viewport, exercised: false };
          }
          const edgeSize = 16;
          const region = {
            x: width - edgeSize,
            y: height - edgeSize,
            width: edgeSize,
            height: edgeSize,
          };
          near.material.color.setRGB(11.0, 4.2, 0.75);
          near.material.uniforms.uPointSize.value = 1;
          placeAtPixel(near, width - 0.5, 0.5, nearZ);
          setVisible({ broad: false, near: false, far: false });
          const baseline = captureRegion(true, region, true);
          setVisible({ broad: false, near: true, far: false });
          const edgeFrame = captureRegion(true, region, true);
          const ownershipTarget = pass.highlightPrefilter.target;
          const ownershipRaw = new Uint16Array(4);
          renderer.readRenderTargetPixels(
            ownershipTarget,
            ownershipTarget.width - 1,
            ownershipTarget.height - 1,
            1,
            1,
            ownershipRaw,
          );
          const input = deltaStats(edgeFrame.input, baseline.input);
          const output = deltaStats(edgeFrame.output, baseline.output);
          return {
            viewport,
            exercised: true,
            sourcePixel: [width - 0.5, 0.5],
            sourceCell: [
              ownershipTarget.width - 1,
              ownershipTarget.height - 1,
            ],
            gridSize: [ownershipTarget.width, ownershipTarget.height],
            ownershipAlpha: halfToFloat(ownershipRaw[3]),
            input,
            output,
            signedEnergyRatio:
              output.signed / Math.max(input.signed, 1e-9),
          };
        })();
        near.material.uniforms.uPointSize.value = originalPointSize;
        near.material.color.setRGB(11.0, 4.2, 0.75);

        const focalBoundary = [0, 0.35, 0.44, 0.46, 0.6, 1.0].map(
          (authoredRadius) => {
            const uniforms = pass.materialBokeh.uniforms;
            const depthOffset =
              authoredRadius /
              Math.max(
                uniforms.aperture.value *
                  uniforms.bokehRadiusScale.value *
                  width *
                  Math.sqrt(3) *
                  0.5,
                1e-9,
              );
            const z =
              engine.camera.position.z - (uniforms.focus.value + depthOffset);
            placeAtPixel(near, width * 0.5, height * 0.5, z);
            setVisible({ broad: false, near: true, far: false });
            const scatterOnFrame = capture(true, true);
            const scatterOff = capture(true, false, false);
            const input = deltaStats(scatterOnFrame.input, noneInput);
            const on = deltaStats(scatterOnFrame.output, none);
            const off = deltaStats(scatterOff, noneNoScatterDraw);
            const onOff = differentialStats(
              scatterOnFrame.output,
              scatterOff,
              none,
              noneNoScatterDraw,
            );
            return {
              authoredRadius,
              measuredRadius: sourceRadiusAtZ(z),
              input,
              on,
              off,
              onOff: {
                ...onOff,
                relativeAbsolute:
                  onOff.absolute / Math.max(input.absolute, 1e-9),
              },
              energyRatio: on.signed / Math.max(input.signed, 1e-9),
              peakRatio:
                positivePeak(scatterOnFrame.output, none) /
                Math.max(positivePeak(scatterOnFrame.input, noneInput), 1e-9),
            };
          },
        );
        near.material.color.setRGB(11.0, 4.2, 0.75);

        placeAtPixel(sunProbe, width * 0.5, height * 0.5, -330);
        setVisible({
          broad: false,
          sun: true,
          near: false,
          far: false,
        });
        const sunScatterOn = capture(true);
        const sunScatterOff = capture(true, false, false);
        const sunScatterDelta = differentialStats(
          sunScatterOn,
          sunScatterOff,
          none,
          noneNoScatterDraw,
        );
        const sunReference = deltaStats(
          sunScatterOff,
          noneNoScatterDraw,
        );
        const prefilterTarget = pass.highlightPrefilter.target;
        const prefilterProbeSize = 9;
        const prefilterRaw = new Uint16Array(
          prefilterProbeSize * prefilterProbeSize * 4,
        );
        renderer.readRenderTargetPixels(
          prefilterTarget,
          Math.floor(prefilterTarget.width * 0.5 - prefilterProbeSize * 0.5),
          Math.floor(prefilterTarget.height * 0.5 - prefilterProbeSize * 0.5),
          prefilterProbeSize,
          prefilterProbeSize,
          prefilterRaw,
        );
        let maxCompactEvidence = 0;
        for (let index = 3; index < prefilterRaw.length; index += 4) {
          maxCompactEvidence = Math.max(
            maxCompactEvidence,
            halfToFloat(prefilterRaw[index]),
          );
        }
        const sunGlowCompactExclusion = {
          sourceClassMarker: productSunGlow.userData.dofSourceClass || null,
          productMapIdentity:
            sunProbe.material.map === productSunGlow.material.map,
          authoredWorldSize: 40,
          maxCompactEvidence,
          referenceEnergy: sunReference.absolute,
          scatterDelta: {
            ...sunScatterDelta,
            relativeAbsolute:
              sunScatterDelta.absolute / Math.max(sunReference.absolute, 1e-9),
          },
        };

        placeAtPixel(near, width * 0.5, height * 0.5, nearZ);
        setVisible({ broad: true, near: false, far: false });
        const broadOn = capture(true);
        const broadOff = capture(true, false, false);
        const broadDelta = differentialStats(
          broadOn,
          broadOff,
          none,
          noneNoScatterDraw,
        );
        const broadReference = deltaStats(
          broadOff,
          noneNoScatterDraw,
        ).absolute;
        setVisible({ broad: true, near: true, far: false });
        const mixed = capture(true);
        setVisible({ broad: false, near: true, far: false });
        const nearDark = capture(true);
        const mixedLamp = deltaStats(mixed, broadOn);
        const darkLamp = deltaStats(nearDark, none);
        const broadBase = deltaStats(broadOn, none);
        const broadWithLamp = deltaStats(mixed, nearDark);
        const mixedCompactBroad = {
          broadDelta: {
            ...broadDelta,
            relativeAbsolute:
              broadDelta.absolute / Math.max(broadReference, 1e-9),
          },
          lampEnergyRatio: mixedLamp.signed / Math.max(darkLamp.signed, 1e-9),
          negativeRatio:
            mixedLamp.negative / Math.max(mixedLamp.positive, 1e-9),
          broadPreservationRatio:
            broadWithLamp.signed / Math.max(broadBase.signed, 1e-9),
        };

        setVisible({ broad: true, near: false, far: false });
        pass.setSourceScatterEnabled(true);
        engine.debugRenderDofFrame();
        const timingBuffers = engine.debugPostResources();
        const ext = gl.getExtension("EXT_disjoint_timer_query_webgl2");
        const sequence = [false, true, true, false, true, false, false, true];
        const samples = [];
        let disjoint = false;
        if (ext && typeof gl.createQuery === "function") {
          const batchSize = 12;
          for (const enabled of sequence) {
            pass.setSourceScatterEnabled(enabled);
            const query = gl.createQuery();
            try {
              gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
              for (let index = 0; index < batchSize; index++) {
                pass.render(
                  renderer,
                  timingBuffers.composerWriteBuffer,
                  timingBuffers.composerReadBuffer,
                  0,
                  false,
                );
              }
              gl.endQuery(ext.TIME_ELAPSED_EXT);
              gl.flush();
              const deadline = performance.now() + 2000;
              while (
                performance.now() < deadline &&
                !gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)
              ) {
                await new Promise((resolve) => setTimeout(resolve, 4));
              }
              const available = gl.getQueryParameter(
                query,
                gl.QUERY_RESULT_AVAILABLE,
              );
              samples.push({
                enabled,
                milliseconds: available
                  ? gl.getQueryParameter(query, gl.QUERY_RESULT) /
                    1e6 /
                    batchSize
                  : null,
              });
              disjoint ||= !!gl.getParameter(ext.GPU_DISJOINT_EXT);
            } finally {
              gl.deleteQuery(query);
            }
          }
        }
        const median = (values) => {
          const sorted = [...values].sort((a, b) => a - b);
          const middle = sorted.length >> 1;
          return sorted.length % 2
            ? sorted[middle]
            : (sorted[middle - 1] + sorted[middle]) * 0.5;
        };
        const offTimes = samples
          .filter((sample) => !sample.enabled)
          .map((sample) => sample.milliseconds);
        const onTimes = samples
          .filter((sample) => sample.enabled)
          .map((sample) => sample.milliseconds);
        const scatterProgram = renderer.properties.get(
          pass._sourceScatter.material,
        )?.currentProgram;
        const ownedProgramCount =
          scatterProgram &&
          (renderer.info.programs || []).includes(scatterProgram)
            ? 1
            : 0;
        const ownedRenderTargetCount = Object.values(
          pass._sourceScatter,
        ).filter((value) => value?.isWebGLRenderTarget).length;

        return {
          closePairs,
          sameHueClosePairs,
          sameHueDepthIsolation,
          nearLayerOccluder,
          sameBlockDifferentDepthHue,
          sameBlockOppositeFocus,
          sameBlockNearDepthDifferentHueOccluder,
          thresholdContinuity,
          blockSeamSweeps,
          oddViewportEdge,
          focalBoundary,
          sunGlowCompactExclusion,
          mixedCompactBroad,
          broadGpu: {
            available:
              samples.length === sequence.length &&
              samples.every((sample) => sample.milliseconds != null),
            disjoint,
            samples,
            offMedianMs: median(offTimes),
            onMedianMs: median(onTimes),
            ratio: median(onTimes) / median(offTimes),
          },
          resources: { ownedProgramCount, ownedRenderTargetCount },
        };
      } finally {
        engine.scene.remove(stress);
        for (const disposable of disposables) disposable.dispose();
        chart.visible = previousChartVisible;
        pass.setSourceScatterEnabled(previousScatterEnabled);
        engine.debugRenderDofFrame();
      }
    },
    { moduleUrl: threeModuleUrl },
  );
}

export function assertBokehSourceStress(sourceStress) {
  if (
    sourceStress.closePairs.some(
      (sample) =>
        sample.sourceDepthMaterialCount !== 2 ||
        Math.abs(sample.sourceRadii.near - sample.sourceRadii.far) < 1.5,
    )
  ) {
    throw new Error(
      `additive point sources lost explicit depth or distinct CoCs: ${JSON.stringify(sourceStress)}`,
    );
  }
  if (
    sourceStress.closePairs.some(
      (sample) =>
        sample.relativeAbsoluteError >
          (sample.separation === 4 ? 0.15 : 0.03) ||
        sample.relativeSignedError > 0.02 ||
        sample.near.negative / Math.max(sample.near.positive, 1e-9) > 0.03 ||
        sample.far.negative / Math.max(sample.far.positive, 1e-9) > 0.03,
    )
  ) {
    throw new Error(
      `close near/far source ownership merged: ${JSON.stringify(sourceStress)}`,
    );
  }
  if (
    sourceStress.sameHueClosePairs.some(
      (sample) =>
        (sample.separation >= 4 &&
          (sample.relativeAbsoluteError > 0.3 ||
            sample.relativeSignedError > 0.02)) ||
        sample.near.negative / Math.max(sample.near.positive, 1e-9) > 0.03 ||
        sample.far.negative / Math.max(sample.far.positive, 1e-9) > 0.03,
    )
  ) {
    throw new Error(
      `same-hue close source ownership merged: ${JSON.stringify(sourceStress)}`,
    );
  }
  // The rear emitter's raw pixels remain visibly outside the foreground card,
  // while only its aperture disc reaches across it. A shared front-depth shortcut
  // therefore leaks measurable energy into the card ROI; source-local depth does not.
  if (
    sourceStress.sameHueDepthIsolation.some(
      (sample) =>
        !sample.emitterOutsideCard ||
        !sample.apertureOverlapsCard ||
        sample.nearReference.positive <= 0 ||
        sample.farReference.positive <= 0 ||
        sample.frontDepthControl.positive <= 0 ||
        sample.frontControlRatio < 0.02 ||
        sample.farLeak.samples <= 0 ||
        sample.rearPositiveLeakRatio > 0.01 ||
        sample.rearAbsoluteLeakRatio > 0.02 ||
        sample.ownershipSignedResidualRatio > 0.1,
    )
  ) {
    throw new Error(
      `same-hue rear source pulled onto front depth: ${JSON.stringify(sourceStress)}`,
    );
  }
  if (
    !sourceStress.nearLayerOccluder.sourceOutsideCard ||
    !sourceStress.nearLayerOccluder.apertureOverlapsCard ||
    sourceStress.nearLayerOccluder.openReference.positive <= 0 ||
    sourceStress.nearLayerOccluder.front.positive <= 0 ||
    sourceStress.nearLayerOccluder.leakRatio > 0.01
  ) {
    throw new Error(
      `near-depth occluder entered the source aperture: ${JSON.stringify(sourceStress)}`,
    );
  }
  const focalBoundary = sourceStress.focalBoundary;
  const focalSharp = focalBoundary.filter(
    (sample) => sample.authoredRadius < 0.45,
  );
  if (
    focalSharp.some(
      (sample) =>
        sample.onOff.relativeAbsolute > 0.001 ||
        Math.abs(sample.energyRatio - 1) > 0.02 ||
        Math.abs(sample.peakRatio - 1) > 0.02,
    ) ||
    focalBoundary.some(
      (sample) =>
        sample.energyRatio < 0.9 ||
        sample.energyRatio > 1.1 ||
        sample.peakRatio > 1.2,
    ) ||
    focalBoundary.some(
      (sample, index) =>
        index > 0 &&
        (Math.abs(sample.energyRatio - focalBoundary[index - 1].energyRatio) >
          0.08 ||
          Math.abs(sample.peakRatio - focalBoundary[index - 1].peakRatio) >
            0.35),
    )
  ) {
    throw new Error(
      `focal compact source doubled or popped at 0.45px: ${JSON.stringify(sourceStress)}`,
    );
  }
  const thresholdSamples = sourceStress.thresholdContinuity.samples;
  const thresholdPeaks = thresholdSamples.map((sample) => sample.peakRatio);
  const threshold = sourceStress.thresholdContinuity.highlightThreshold;
  const knee = sourceStress.thresholdContinuity.highlightKnee;
  const belowThreshold = thresholdSamples.filter(
    (sample) => sample.level <= threshold,
  );
  const fullAperture = thresholdSamples.find(
    (sample) => sample.level >= threshold + knee,
  );
  if (
    thresholdSamples.some(
      (sample) =>
        sample.signedEnergyRatio < 0.97 ||
        sample.signedEnergyRatio > 1.03 ||
        sample.peakRatio > 1.03 ||
        sample.on.negative / Math.max(sample.input.positive, 1e-9) > 0.03,
    ) ||
    belowThreshold.some((sample) => sample.peakRatio < 0.95) ||
    !fullAperture ||
    fullAperture.peakRatio > 0.05 ||
    thresholdPeaks.some(
      (value, index) =>
        index > 0 &&
        (value - thresholdPeaks[index - 1] > 0.03 ||
          thresholdPeaks[index - 1] - value > 0.55),
    )
  ) {
    throw new Error(
      `compact-source threshold transfer popped or lost energy: ${JSON.stringify(sourceStress)}`,
    );
  }
  for (const sweep of sourceStress.blockSeamSweeps) {
    const ratios = sweep.samples.map((sample) => sample.signedEnergyRatio);
    if (
      sweep.samples.some(
        (sample) =>
          sample.input.positive <= 0 ||
          sample.signedEnergyRatio < 0.97 ||
          sample.signedEnergyRatio > 1.03,
      ) ||
      Math.max(...ratios) - Math.min(...ratios) > 0.03
    ) {
      throw new Error(
        `block-seam source transfer diverged: ${JSON.stringify(sweep)}`,
      );
    }
  }
  const oddEdge = sourceStress.oddViewportEdge;
  if (
    !oddEdge.exercised ||
    oddEdge.viewport[0] !== 961 ||
    oddEdge.viewport[1] !== 601 ||
    oddEdge.gridSize[0] !== 481 ||
    oddEdge.gridSize[1] !== 301 ||
    oddEdge.sourceCell[0] !== 480 ||
    oddEdge.sourceCell[1] !== 300 ||
    oddEdge.ownershipAlpha <
      BOKEH_SOURCE_CONTRACT.exactOwnershipCutoff ||
    oddEdge.input.positive <= 0 ||
    oddEdge.output.positive <= 0 ||
    oddEdge.signedEnergyRatio <= 0
  ) {
    throw new Error(
      `odd 961x601 final ownership cell was lost on GPU: ${JSON.stringify(sourceStress)}`,
    );
  }
  for (const sample of [
    sourceStress.sameBlockDifferentDepthHue,
    sourceStress.sameBlockOppositeFocus,
  ]) {
    const sameBlock =
      Math.floor(sample.sourcePixels[0][0] / 2) ===
        Math.floor(sample.sourcePixels[1][0] / 2) &&
      Math.floor(sample.sourcePixels[0][1] / 2) ===
        Math.floor(sample.sourcePixels[1][1] / 2);
    if (
      !sameBlock ||
      sample.radii.some((radius) => radius <= 0.45) ||
      sample.first.positive <= 0 ||
      sample.second.positive <= 0 ||
      sample.relativeAbsoluteError > 0.15 ||
      sample.relativeSignedError > 0.03
    ) {
      throw new Error(
        `same-block source components coupled: ${JSON.stringify(sample)}`,
      );
    }
  }
  const sameBlockOccluder =
    sourceStress.sameBlockNearDepthDifferentHueOccluder;
  const sourceInputEnergy =
    0.2126 * sameBlockOccluder.sourceColor[0] +
    0.7152 * sameBlockOccluder.sourceColor[1] +
    0.0722 * sameBlockOccluder.sourceColor[2];
  const expectedBackControl =
    sourceInputEnergy *
    BOKEH_SOURCE_CONTRACT.profileCore /
    (Math.PI *
      sameBlockOccluder.sourceRadius *
      sameBlockOccluder.sourceRadius *
      BOKEH_SOURCE_CONTRACT.profileIntegral);
  const sharesOwnershipBlock =
    Math.floor((sameBlockOccluder.sourcePixel[0] - 0.5) / 2) ===
      Math.floor((sameBlockOccluder.destinationPixel[0] - 0.5) / 2) &&
    Math.floor((sameBlockOccluder.sourcePixel[1] - 0.5) / 2) ===
      Math.floor((sameBlockOccluder.destinationPixel[1] - 0.5) / 2);
  if (
    !sharesOwnershipBlock ||
    sameBlockOccluder.sourceDepth <=
      sameBlockOccluder.frontDestinationDepth ||
    sameBlockOccluder.destinationPeak <
      sameBlockOccluder.destinationFloor ||
    sameBlockOccluder.hueCosineSquared >= 0.990025 ||
    sameBlockOccluder.ownershipAlpha <
      BOKEH_SOURCE_CONTRACT.exactOwnershipCutoff ||
    sameBlockOccluder.sourceOpen.positive < sourceInputEnergy * 0.97 ||
    sameBlockOccluder.sourceOpen.positive > sourceInputEnergy * 1.03 ||
    sameBlockOccluder.frontDestination.positive <= 0 ||
    sameBlockOccluder.frontLeak.samples !== 1 ||
    sameBlockOccluder.backControl.positive < expectedBackControl * 0.8 ||
    sameBlockOccluder.backControl.positive > expectedBackControl * 1.2 ||
    sameBlockOccluder.frontLeak.positive /
      sameBlockOccluder.backControl.positive >
      0.01 ||
    sameBlockOccluder.frontLeak.absolute /
      sameBlockOccluder.backControl.absolute >
      0.01
  ) {
    throw new Error(
      `same-block near-depth different-hue occluder entered source self identity: ${JSON.stringify({ sourceInputEnergy, expectedBackControl, sourceStress })}`,
    );
  }
  if (
    sourceStress.mixedCompactBroad.broadDelta.relativeAbsolute > 0.001 ||
    sourceStress.mixedCompactBroad.broadPreservationRatio < 0.97 ||
    sourceStress.mixedCompactBroad.broadPreservationRatio > 1.03
  ) {
    throw new Error(
      `compact/broad ownership diverged: ${JSON.stringify(sourceStress)}`,
    );
  }
  if (
    sourceStress.sunGlowCompactExclusion.sourceClassMarker !== null ||
    !sourceStress.sunGlowCompactExclusion.productMapIdentity ||
    sourceStress.sunGlowCompactExclusion.referenceEnergy <= 1 ||
    sourceStress.sunGlowCompactExclusion.maxCompactEvidence > 0.001 ||
    sourceStress.sunGlowCompactExclusion.scatterDelta.relativeAbsolute > 0.001
  ) {
    throw new Error(
      `product sunGlow entered compact-source transfer: ${JSON.stringify(sourceStress)}`,
    );
  }
  if (
    !sourceStress.broadGpu.available ||
    sourceStress.broadGpu.disjoint ||
    sourceStress.broadGpu.ratio > 2.5
  ) {
    throw new Error(
      `broad HDR GPU ABBA failed: ${JSON.stringify(sourceStress)}`,
    );
  }
  if (
    sourceStress.resources.ownedProgramCount !== 1 ||
    sourceStress.resources.ownedRenderTargetCount !== 0
  ) {
    throw new Error(
      `scatter renderer resources changed: ${JSON.stringify(sourceStress)}`,
    );
  }
  console.log(
    `source-stress-critical: ${JSON.stringify({
      oddViewportEdge: sourceStress.oddViewportEdge,
      blockSeamSweeps: sourceStress.blockSeamSweeps,
      sameBlockNearDepthDifferentHueOccluder:
        sourceStress.sameBlockNearDepthDifferentHueOccluder,
    })}`,
  );
}
