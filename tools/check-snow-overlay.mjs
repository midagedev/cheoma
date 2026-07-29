// Pure contract: focus FULL giwa overlay roof materials receive snow and the
// tile/thatch profile covers inverted FrontSide outer-tile normals (A2).
// Browser-free. Run: node tools/check-snow-overlay.mjs
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const requireApp = createRequire(join(ROOT, 'app', 'package.json'));
const esbuild = requireApp('esbuild');
const THREE_MAIN = join(ROOT, 'app/node_modules/three/build/three.module.js');
const THREE_ADDONS = join(ROOT, 'app/node_modules/three/examples/jsm');

function makeCanvas() {
  const noop = () => {};
  const gradient = Object.freeze({ addColorStop: noop });
  let canvas;
  const context = new Proxy({}, {
    get(t, k) {
      if (k === 'canvas') return canvas;
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => gradient;
      if (k === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
      if (!(k in t)) t[k] = noop;
      return t[k];
    },
    set(t, k, v) { t[k] = v; return true; },
  });
  canvas = { width: 0, height: 0, getContext: () => context };
  return canvas;
}
globalThis.document = { createElement: () => makeCanvas() };

process.on('uncaughtException', (error) => {
  console.error(`SNOW OVERLAY: FAIL — ${error.message}`);
  process.exit(1);
});

const built = await esbuild.build({
  stdin: {
    contents: "export { buildBuilding } from './src/api/building.js';"
      + " export { makeMaterials } from './src/builder/palette.js';"
      + " export { PRESETS } from './src/params.js';"
      + " export { createVillageSnowController } from './src/runtime/village/snow.js';"
      + " export { snowProfileForObject, patchSnowMaterial } from './src/env/snow-material.js';"
      + " export * as THREE from 'three';",
    resolveDir: ROOT,
    sourcefile: 'snow-overlay-contract-entry.js',
  },
  alias: { 'three/addons': THREE_ADDONS, three: THREE_MAIN },
  bundle: true, format: 'esm', platform: 'node', target: 'node20', write: false, logLevel: 'silent',
});
const {
  buildBuilding, makeMaterials, PRESETS,
  createVillageSnowController, snowProfileForObject, patchSnowMaterial, THREE,
} = await import(
  `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString('base64')}`
);

const house = buildBuilding({ ...PRESETS.giwa, style: 'giwa', mats: makeMaterials('giwa') });
const group = new THREE.Group();
group.name = 'override-p0';
group.userData.snowRoofKind = 'giwa';
group.add(house);

// Dump roof materials vs inject selection (A2 diagnostic).
const roofDump = [];
const nrm = new THREE.Vector3();
const nMat = new THREE.Matrix3();
house.updateWorldMatrix(true, true);
group.traverse((object) => {
  if (!object.isMesh && !object.isInstancedMesh) return;
  const materials = Array.isArray(object.material) ? object.material : (object.material ? [object.material] : []);
  for (const material of materials) {
    if (!material) continue;
    const profile = snowProfileForObject(object, material);
    const skipSurface = profile === 'surface';
    const skipSnowSurface = (profile === 'tile' || profile === 'thatch') && !material.userData?.snowSurface;
    let avgNy = null;
    if (material.userData?.paletteKey === 'tileSurface' && object.geometry?.attributes?.normal) {
      object.updateWorldMatrix(true, false);
      nMat.getNormalMatrix(object.matrixWorld);
      const nor = object.geometry.attributes.normal;
      let sum = 0;
      let count = 0;
      const step = Math.max(1, Math.floor(nor.count / 80));
      for (let i = 0; i < nor.count; i += step) {
        nrm.fromBufferAttribute(nor, i).applyMatrix3(nMat).normalize();
        sum += nrm.y;
        count++;
      }
      avgNy = sum / count;
    }
    roofDump.push({
      name: object.name || object.type,
      role: material.userData?.role ?? null,
      paletteKey: material.userData?.paletteKey ?? null,
      snowSurface: material.userData?.snowSurface ?? null,
      profile,
      wouldInject: !skipSurface && !skipSnowSurface && !!material.isMeshStandardMaterial,
      avgNy,
      side: material.side,
    });
  }
});

const tileSurfaces = roofDump.filter((row) => row.paletteKey === 'tileSurface');
assert.ok(tileSurfaces.length > 0, 'giwa FULL overlay has no tileSurface roof meshes');
for (const row of tileSurfaces) {
  assert.equal(row.role, 'roof', 'tileSurface missing role=roof');
  assert.equal(row.snowSurface, true, 'tileSurface missing snowSurface=true');
  assert.equal(row.profile, 'tile', 'tileSurface snow profile is not tile');
  assert.equal(row.wouldInject, true, 'tileSurface would be skipped by inject filters');
  // The real bug: FrontSide outer tiles wind with ny < 0, so signed up-facing
  // coverage was zero even after a successful inject.
  assert.ok(row.avgNy != null && row.avgNy < -0.5,
    `expected inverted outer-tile normals for A2 fixture, avgNy=${row.avgNy}`);
  assert.equal(row.side, THREE.FrontSide, 'tileSurface should stay FrontSide (gaepan pair)');
}

const snow = createVillageSnowController(group);
// inject before setWeather so the return count is meaningful (setWeather also injects).
const patched = snow.inject(group);
assert.ok(patched > 0, `inject patched 0 materials on giwa overlay (dump=${JSON.stringify(tileSurfaces)})`);
snow.setWeather('snow', { immediate: true, accum: 1 });

let tilePatched = 0;
let tileAbsUp = 0;
group.traverse((object) => {
  if (!object.isMesh && !object.isInstancedMesh) return;
  const materials = Array.isArray(object.material) ? object.material : (object.material ? [object.material] : []);
  for (const material of materials) {
    if (material?.userData?.paletteKey !== 'tileSurface') continue;
    if (material.userData?.__snowPatched) tilePatched++;
    if (material.userData?.__snowAbsUp) tileAbsUp++;
  }
});
assert.ok(tilePatched > 0, 'tileSurface materials were not snow-patched after inject');
assert.equal(tileAbsUp, tilePatched,
  'tile/thatch snow must force abs(ny) on FrontSide outer tiles so inverted normals still accumulate');

// Compile path: onBeforeCompile must emit abs(wn.y) for tile even when side is FrontSide.
const amount = { value: 0.82 };
const probe = new THREE.MeshStandardMaterial({ color: 0x666666, side: THREE.FrontSide });
probe.userData.role = 'roof';
probe.userData.snowSurface = true;
assert.equal(patchSnowMaterial(probe, amount, { profile: 'tile' }), true);
const shader = {
  uniforms: {},
  vertexShader: '#include <common>\n#include <beginnormal_vertex>\n#include <begin_vertex>\n',
  fragmentShader: '#include <common>\n#include <normal_fragment_maps>\n#include <color_fragment>\n'
    + '#include <roughnessmap_fragment>\n#include <metalnessmap_fragment>\n#include <dithering_fragment>\n',
};
probe.onBeforeCompile(shader, null);
assert.match(shader.fragmentShader, /mix\(wn\.y, abs\(wn\.y\), 1\.0\)/,
  'tile snow fragment must use abs(ny) (1.0), not FrontSide-only signed ny');
assert.match(shader.fragmentShader, /uSnowAmount/,
  'snow patch marker uniform missing from compiled fragment');

// Signed-ny coverage on inverted tiles would be zero; abs path is the product contract.
const invertedNy = -0.87;
const signedUp = invertedNy; // twoSided=0 path
const absUp = Math.abs(invertedNy);
assert.ok(signedUp < 0.2, 'fixture inverted normal still faces up under signed test');
assert.ok(absUp > 0.7, 'abs-up coverage input must remain high on inverted outer tiles');

console.log('SNOW OVERLAY: PASS');
console.log(JSON.stringify({
  tileSurfaces: tileSurfaces.length,
  injectPatched: patched,
  tilePatched,
  tileAbsUp,
  sampleAvgNy: tileSurfaces[0]?.avgNy,
}, null, 2));
