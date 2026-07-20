import * as THREE from 'three';

const MAX_AMOUNT = 0.82;
const ACCUMULATE_SECONDS = 46;
const MELT_SECONDS = 16;

function roofIsThatch(object) {
  for (let node = object; node; node = node.parent) {
    if (node.userData?.snowRoofKind) return node.userData.snowRoofKind === 'choga';
  }
  for (let node = object; node; node = node.parent) {
    const name = node.name || '';
    if (name.includes('-choga')) return true;
    if (name.includes('-giwa')) return false;
  }
  return false;
}

export function createVillageSnowController(villageGroup) {
  const amountUniform = { value: 0 };
  let target = 0;
  let accumulated = 0;
  let pinned = null;

  function patchRoof(material, isThatch) {
    if (!material?.isMeshStandardMaterial || material.userData?.__snowPatched) return false;
    material.userData = material.userData || {};
    material.userData.__snowPatched = true;

    // 볏짚은 성글게, 기와는 급경사면을 감쇠해 작은 지붕과 담 코핑의 bloom 포화를 막는다.
    const white = isThatch ? 'vec3(0.80, 0.80, 0.78)' : 'vec3(0.92, 0.93, 0.95)';
    const ceiling = isThatch ? '0.50' : '1.0';
    const thickFill = isThatch ? '0.28' : '0.62';
    const backfaceBoost = isThatch ? '0.30' : '0.78';
    const steepMinimum = isThatch ? '1.0' : '0.55';
    const previousCompile = material.onBeforeCompile;
    material.onBeforeCompile = (shader, renderer) => {
      if (previousCompile) previousCompile(shader, renderer);
      shader.uniforms.uSnowAmount = amountUniform;
      const twoSided = material.side === THREE.DoubleSide ? '1.0' : '0.0';
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vSnowWN;\nvarying vec3 vSnowWP;')
        .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
        #ifdef USE_INSTANCING
          vSnowWN = mat3(modelMatrix) * mat3(instanceMatrix) * objectNormal;
        #else
          vSnowWN = mat3(modelMatrix) * objectNormal;
        #endif`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef USE_INSTANCING
          vSnowWP = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
        #else
          vSnowWP = (modelMatrix * vec4(transformed, 1.0)).xyz;
        #endif`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vSnowWN;\nvarying vec3 vSnowWP;\nuniform float uSnowAmount;\nfloat snowCov = 0.0;\nfloat snowFix = 0.0;')
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          vec3 swn = normalize(vSnowWN);
          float fixup = ${twoSided} * step(swn.y, -0.05)
                      * smoothstep(0.30, 0.55, abs(swn.y))
                      * smoothstep(0.0, 0.20, uSnowAmount);
          vec3 vUp = normalize((viewMatrix * vec4(-swn, 0.0)).xyz);
          normal = normalize(mix(normal, vUp, fixup));
          snowFix = fixup;
        }`)
        .replace('#include <color_fragment>', `#include <color_fragment>
        {
          vec3 wn = normalize(vSnowWN);
          float ny = mix(wn.y, abs(wn.y), ${twoSided});
          float thresh = mix(0.72, 0.20, uSnowAmount);
          float up = smoothstep(thresh - 0.10, thresh + 0.18, ny);
          float ridge = 0.5 + 0.5 * sin(vSnowWP.x * 3.0 + vSnowWP.z * 0.6);
          float blotch = 0.55 + 0.45 * sin(vSnowWP.x * 1.3) * sin(vSnowWP.z * 1.7);
          float flatFace = smoothstep(0.80, 0.97, wn.y);
          float slopeCov = (0.72 + 0.28 * blotch) * (0.86 + 0.14 * ridge);
          float floorCov = 0.90 + 0.10 * blotch;
          float thick = smoothstep(0.35, 0.85, uSnowAmount);
          slopeCov = mix(slopeCov, 0.98, thick * ${thickFill});
          float cov = up * mix(slopeCov, floorCov, flatFace);
          cov *= smoothstep(0.0, 0.14, uSnowAmount);
          cov *= mix(${steepMinimum}, 1.0, smoothstep(0.34, 0.66, ny));
          cov = clamp(cov * ${ceiling}, 0.0, 1.0);
          snowCov = cov;
          diffuseColor.rgb = mix(diffuseColor.rgb, ${white}, cov);
        }`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 0.96, snowCov);`)
        .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
        metalnessFactor = mix(metalnessFactor, 0.0, snowCov);`)
        .replace('#include <dithering_fragment>', `{
          gl_FragColor.rgb *= 1.0 + snowFix * snowCov * ${backfaceBoost};
        }
        #include <dithering_fragment>`);
    };
    const baseKey = material.customProgramCacheKey
      && material.customProgramCacheKey !== THREE.Material.prototype.customProgramCacheKey
      ? material.customProgramCacheKey() : '';
    material.customProgramCacheKey = () => `snowtint${isThatch ? '-th' : ''}|${baseKey}`;
    material.needsUpdate = true;
    return true;
  }

  function inject(root) {
    if (!root) return 0;
    let patched = 0;
    root.traverse((object) => {
      const materials = Array.isArray(object.material) ? object.material : (object.material ? [object.material] : []);
      const isThatch = roofIsThatch(object);
      for (const material of materials) {
        if (material?.userData?.role === 'roof' && patchRoof(material, isThatch)) patched++;
      }
    });
    return patched;
  }

  function setAccumulation(value) {
    pinned = value;
    if (value != null) {
      accumulated = value;
      amountUniform.value = value * MAX_AMOUNT;
    }
  }

  villageGroup.userData.setSnowAccum = setAccumulation;
  villageGroup.userData.getSnowInfo = () => ({
    target,
    accum: +accumulated.toFixed(3),
    value: +amountUniform.value.toFixed(3),
    pinned,
  });

  return {
    inject,
    isActive: () => target > 0,
    setWeather(name) {
      target = name === 'snow' ? 1 : 0;
      if (target > 0) inject(villageGroup);
    },
    update(dt) {
      if (pinned != null) accumulated = pinned;
      else if (target > 0) accumulated = Math.min(1, accumulated + dt / ACCUMULATE_SECONDS);
      else accumulated = Math.max(0, accumulated - dt / MELT_SECONDS);
      amountUniform.value = accumulated * MAX_AMOUNT;
    },
  };
}
