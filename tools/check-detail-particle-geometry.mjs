// Issue #96 close-detail particle contract.
// Run through the repository browser lock:
//   node tools/run-browser-locked.mjs -- node tools/check-detail-particle-geometry.mjs

import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import {
  launchVerificationBrowser,
  reportWebGLRenderer,
} from './lib/verification-browser.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const esbuild = require(resolve(ROOT, 'app/node_modules/esbuild'));

const ENTRY = `
import * as THREE from 'three';
import { createPetalField } from ${JSON.stringify(resolve(ROOT, 'src/env/petals.js'))};
import { setupMotes } from ${JSON.stringify(resolve(ROOT, 'src/env/motes.js'))};
import {
  createPetalWorldRepresentation,
  createMoteWorldRepresentation,
} from ${JSON.stringify(resolve(ROOT, 'src/env/detail-particle-geometry.js'))};
import {
  contributesDofDepth,
  dofDepthMaterialForObject,
} from ${JSON.stringify(resolve(ROOT, 'src/env/dof.js'))};

const W = 192, H = 128;
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(1);
renderer.setSize(W, H, false);
renderer.toneMapping = THREE.NoToneMapping;
renderer.setClearColor(0x000000, 1);
document.body.appendChild(renderer.domElement);

const camera = new THREE.PerspectiveCamera(45, W / H, 0.1, 30);
camera.position.set(0, 0, 5);
camera.lookAt(0, 0, 0);
camera.updateMatrixWorld();

function renderPixels(scene, target, clear = 0x000000) {
  renderer.setClearColor(clear, 1);
  renderer.setRenderTarget(target);
  renderer.clear();
  renderer.render(scene, camera);
  const pixels = new Uint8Array(W * H * 4);
  renderer.readRenderTargetPixels(target, 0, 0, W, H, pixels);
  renderer.setRenderTarget(null);
  return pixels;
}

function writtenDepth(pixels, x0, x1) {
  const values = [];
  const unpack = (o) => {
    const r = pixels[o] / 255, g = pixels[o + 1] / 255;
    const b = pixels[o + 2] / 255, a = pixels[o + 3] / 255;
    return r * (255 / 256)
      + g * (255 / 256 / 256)
      + b * (255 / 256 / 65536)
      + a / 16777216;
  };
  for (let y = 0; y < H; y++) for (let x = x0; x < x1; x++) {
    const o = (y * W + x) * 4;
    if (pixels[o] === 255 && pixels[o + 1] === 255
      && pixels[o + 2] === 255 && pixels[o + 3] === 255) continue;
    values.push(unpack(o));
  }
  values.sort((a, b) => a - b);
  return {
    count: values.length,
    median: values.length ? values[Math.floor(values.length / 2)] : null,
  };
}

function hashFloatArrays(...arrays) {
  let h = 2166136261 >>> 0;
  for (const array of arrays) {
    const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
    for (const value of bytes) {
      h ^= value;
      h = Math.imul(h, 16777619) >>> 0;
    }
  }
  return h.toString(16).padStart(8, '0');
}

function petalFixture() {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    -0.72, 0, 0,
    0.72, 0, -1.5,
  ], 3));
  geometry.setAttribute('aSize', new THREE.Float32BufferAttribute([1, 1], 1));
  geometry.setAttribute('aColor', new THREE.Float32BufferAttribute([1, 0.3, 0.4, 1, 0.6, 0.1], 3));
  geometry.setAttribute('aRot', new THREE.Float32BufferAttribute([0, 0], 1));
  geometry.setAttribute('aRotSpd', new THREE.Float32BufferAttribute([0, 0], 1));
  geometry.setAttribute('aOpacity', new THREE.Float32BufferAttribute([1, 1], 1));
  geometry.setAttribute('aSpecies', new THREE.Float32BufferAttribute([0, 2], 1));
  geometry.setAttribute('aThresh', new THREE.Float32BufferAttribute([0.8, 0.8], 1));
  const world = createPetalWorldRepresentation(geometry, { worldScale: 0.34 });
  world.object.visible = true;
  world.material.uniforms.uFade.value = 1;
  world.material.uniforms.uActive.value = 1;
  world.material.uniforms.uTime.value = 0.4;
  return { geometry, world };
}

function moteFixture() {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    -0.72, 0, 0,
    0.72, 0, -1.5,
  ], 3));
  geometry.setAttribute('aRand', new THREE.Float32BufferAttribute([
    0, 1, -0.32, 1,
    0, 1, -0.28, 1,
  ], 4));
  const world = createMoteWorldRepresentation(geometry, {
    dustRadius: 0.3,
    fireflyRadius: 0.3,
  });
  world.object.visible = true;
  const u = world.material.uniforms;
  u.uTime.value = Math.PI / (2 * 1.03);
  u.uIntensity.value = 1;
  u.uFirefly.value = 1;
  u.uDrift.value = 0;
  u.uWindSway.value = 0;
  u.uNearA.value = 0;
  u.uNearB.value = 1;
  u.uSunDir.value.set(0, 0, 1);
  return { geometry, world };
}

function renderExplicitDepth(world) {
  const scene = new THREE.Scene();
  scene.add(world.object);
  const colorMaterial = world.object.material;
  world.object.material = world.object.userData.dofDepthMaterial;
  const target = new THREE.WebGLRenderTarget(W, H, {
    depthBuffer: true,
    stencilBuffer: false,
  });
  const pixels = renderPixels(scene, target, 0xffffff);
  world.object.material = colorMaterial;
  target.dispose();
  return {
    left: writtenDepth(pixels, 0, W / 2),
    right: writtenDepth(pixels, W / 2, W),
  };
}

function countNonBlack(pixels) {
  let count = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i] + pixels[i + 1] + pixels[i + 2] > 5) count++;
  }
  return count;
}

function renderColor(world, wall = false) {
  const scene = new THREE.Scene();
  scene.add(world.object);
  if (wall) {
    const blocker = new THREE.Mesh(
      new THREE.PlaneGeometry(3, 3),
      new THREE.MeshBasicMaterial({ color: 0x000000 }),
    );
    blocker.position.z = 1;
    scene.add(blocker);
  }
  const target = new THREE.WebGLRenderTarget(W, H, {
    depthBuffer: true,
    stencilBuffer: false,
  });
  const pixels = renderPixels(scene, target);
  target.dispose();
  for (const child of scene.children) {
    if (child !== world.object) {
      child.geometry?.dispose();
      child.material?.dispose();
    }
  }
  return countNonBlack(pixels);
}

function renderHalfFloatPeak(world) {
  const scene = new THREE.Scene();
  scene.add(world.object);
  const target = new THREE.WebGLRenderTarget(W, H, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    depthBuffer: true,
    stencilBuffer: false,
  });
  renderer.setClearColor(0x000000, 1);
  renderer.setRenderTarget(target);
  renderer.clear();
  renderer.render(scene, camera);
  const pixels = new Uint16Array(W * H * 4);
  renderer.readRenderTargetPixels(target, 0, 0, W, H, pixels);
  renderer.setRenderTarget(null);
  let peak = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    peak = Math.max(
      peak,
      THREE.DataUtils.fromHalfFloat(pixels[i]),
      THREE.DataUtils.fromHalfFloat(pixels[i + 1]),
      THREE.DataUtils.fromHalfFloat(pixels[i + 2]),
    );
  }
  target.dispose();
  return peak;
}

async function resourcePlateau() {
  const baseline = {
    geometries: renderer.info.memory.geometries,
    textures: renderer.info.memory.textures,
  };
  const samples = [];
  for (let cycle = 0; cycle < 5; cycle++) {
    const scene = new THREE.Scene();
    const petals = createPetalField({
      lowPerf: true,
      getWind: () => ({ dirX: 1, dirZ: 0, speed: 0.3, gust: 1 }),
    });
    petals.setSeason('spring');
    const petalWorld = petals.getWorldRepresentation();
    scene.add(petals.points, petalWorld.object);
    for (let frame = 0; frame < 12; frame++) {
      petals.update(1 / 30, {
        t: frame / 30, viewHeight: 8, present: 1,
        wind: { dirX: 1, dirZ: 0, speed: 0.3, gust: 1 },
      });
    }
    petals.setRepresentation(cycle % 2 ? 'points' : 'world');
    renderer.render(scene, camera);
    const petalColor = petalWorld.object.material;
    petalWorld.object.material = petalWorld.object.userData.dofDepthMaterial;
    petalWorld.object.visible = true;
    renderer.render(scene, camera);
    petalWorld.object.material = petalColor;

    const motes = setupMotes({
      scene, renderer, count: 24, fireflies: true, representation: 'world',
    });
    scene.add(motes.group);
    motes.setEnabled(true);
    motes.setSeason('summer', { immediate: true });
    motes.setTime('night', { immediate: true });
    motes.update(1 / 30);
    const moteWorld = motes.getWorldRepresentation();
    renderer.render(scene, camera);
    const moteColor = moteWorld.object.material;
    moteWorld.object.material = moteWorld.object.userData.dofDepthMaterial;
    renderer.render(scene, camera);
    moteWorld.object.material = moteColor;

    scene.remove(petals.points, petalWorld.object);
    petals.dispose();
    scene.remove(motes.group);
    motes.dispose();
    renderer.render(new THREE.Scene(), camera);
    samples.push({
      geometries: renderer.info.memory.geometries,
      textures: renderer.info.memory.textures,
      programs: renderer.info.programs?.length || 0,
    });
  }
  return { baseline, samples };
}

window.__run = async () => {
  const petalA = createPetalField({ lowPerf: true });
  const petalB = createPetalField({ lowPerf: true });
  petalA.setSeason('autumn');
  petalB.setSeason('autumn');
  const wind = { dirX: 0.7, dirZ: -0.3, speed: 0.4, gust: 0.8 };
  for (let i = 0; i < 24; i++) {
    const args = { t: i / 30, viewHeight: 8, present: 1, wind };
    petalA.update(1 / 30, args);
    petalB.update(1 / 30, args);
  }
  const petalWorld = petalA.getWorldRepresentation();
  petalWorld.object.visible = true;
  const petalHashA = hashFloatArrays(
    petalA.points.geometry.attributes.position.array,
    petalA.points.geometry.attributes.aSize.array,
    petalA.points.geometry.attributes.aRot.array,
  );
  const petalHashB = hashFloatArrays(
    petalB.points.geometry.attributes.position.array,
    petalB.points.geometry.attributes.aSize.array,
    petalB.points.geometry.attributes.aRot.array,
  );

  const moteSceneA = new THREE.Scene();
  const moteSceneB = new THREE.Scene();
  const motesA = setupMotes({
    scene: moteSceneA, renderer, count: 160, fireflies: true,
  });
  const motesB = setupMotes({
    scene: moteSceneB, renderer, count: 160, fireflies: true,
  });
  const moteWorld = motesA.getWorldRepresentation();
  moteWorld.object.visible = true;
  const moteHashA = hashFloatArrays(
    motesA.points.geometry.attributes.position.array,
    motesA.points.geometry.attributes.aRand.array,
  );
  const moteHashB = hashFloatArrays(
    motesB.points.geometry.attributes.position.array,
    motesB.points.geometry.attributes.aRand.array,
  );

  const petalDepthFixture = petalFixture();
  const petalDepth = renderExplicitDepth(petalDepthFixture.world);
  petalDepthFixture.world.material.uniforms.uActive.value = 0;
  const petalInactiveDepth = renderExplicitDepth(petalDepthFixture.world);

  const moteDepthFixture = moteFixture();
  const moteDepth = renderExplicitDepth(moteDepthFixture.world);
  const fireflyPeak = renderHalfFloatPeak(moteDepthFixture.world);
  const visiblePixels = renderColor(moteDepthFixture.world, false);
  const occludedPixels = renderColor(moteDepthFixture.world, true);
  moteDepthFixture.world.material.uniforms.uFirefly.value = 0;
  const moteInactiveDepth = renderExplicitDepth(moteDepthFixture.world);

  const plateau = await resourcePlateau();
  const gl = renderer.getContext();
  const debug = gl.getExtension('WEBGL_debug_renderer_info');
  const backend = debug
    ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)
    : gl.getParameter(gl.RENDERER);

  const result = {
    backend,
    petal: {
      hashes: [petalHashA, petalHashB],
      shared: petalWorld.sharesSourceArrays(),
      stats: petalWorld.stats,
      dofContract: contributesDofDepth(petalWorld.object)
        && dofDepthMaterialForObject(petalWorld.object)
          === petalWorld.object.userData.dofDepthMaterial,
      depth: petalDepth,
      inactiveDepth: petalInactiveDepth,
      depthUsesOffset: petalWorld.object.userData.dofDepthMaterial.vertexShader.includes('aOffset'),
    },
    mote: {
      hashes: [moteHashA, moteHashB],
      shared: moteWorld.sharesSourceArrays(),
      stats: moteWorld.stats,
      dofContract: contributesDofDepth(moteWorld.object)
        && dofDepthMaterialForObject(moteWorld.object)
          === moteWorld.object.userData.dofDepthMaterial,
      depth: moteDepth,
      inactiveDepth: moteInactiveDepth,
      depthUsesOffset: moteWorld.object.userData.dofDepthMaterial.vertexShader.includes('aOffset'),
      fireflyPeak,
      visiblePixels,
      occludedPixels,
    },
    plateau,
  };

  petalA.dispose();
  petalB.dispose();
  motesA.dispose();
  motesB.dispose();
  petalDepthFixture.world.dispose();
  petalDepthFixture.geometry.dispose();
  moteDepthFixture.world.dispose();
  moteDepthFixture.geometry.dispose();
  renderer.dispose();
  return result;
};
window.__ready = true;
`;

const built = await esbuild.build({
  stdin: { contents: ENTRY, resolveDir: ROOT, sourcefile: 'detail-particle-check.js', loader: 'js' },
  bundle: true,
  format: 'iife',
  write: false,
  nodePaths: [resolve(ROOT, 'app/node_modules')],
  logLevel: 'silent',
});
const html = `<!doctype html><meta charset="utf-8"><body><script>${built.outputFiles[0].text}</script>`;
const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(html);
});
await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));

const browser = await launchVerificationBrowser();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load' });
await page.waitForFunction('window.__ready === true');
await reportWebGLRenderer(page, 'detail-particle-check');
const result = await page.evaluate(() => window.__run());
await browser.close();
server.close();

const checks = [];
function check(name, condition, detail) {
  checks.push({ name, ok: !!condition, detail });
}
function separatedDepth(depth) {
  return depth.left.count > 4
    && depth.right.count > 4
    && Number.isFinite(depth.left.median)
    && Number.isFinite(depth.right.median)
    && Math.abs(depth.left.median - depth.right.median) > 0.001;
}

check('petal deterministic buffers', result.petal.hashes[0] === result.petal.hashes[1],
  result.petal.hashes.join(' / '));
check('petal single CPU owner', result.petal.shared, JSON.stringify(result.petal.stats));
check('petal explicit DoF material', result.petal.dofContract && result.petal.depthUsesOffset,
  `contract=${result.petal.dofContract} aOffset=${result.petal.depthUsesOffset}`);
check('petal two-instance physical depth', separatedDepth(result.petal.depth),
  JSON.stringify(result.petal.depth));
check('petal inactive gust writes no depth',
  result.petal.inactiveDepth.left.count + result.petal.inactiveDepth.right.count === 0,
  JSON.stringify(result.petal.inactiveDepth));
check('mote deterministic buffers', result.mote.hashes[0] === result.mote.hashes[1],
  result.mote.hashes.join(' / '));
check('mote single CPU owner', result.mote.shared, JSON.stringify(result.mote.stats));
check('mote explicit DoF material', result.mote.dofContract && result.mote.depthUsesOffset,
  `contract=${result.mote.dofContract} aOffset=${result.mote.depthUsesOffset}`);
check('mote two-instance physical depth', separatedDepth(result.mote.depth),
  JSON.stringify(result.mote.depth));
check('disabled firefly writes no depth',
  result.mote.inactiveDepth.left.count + result.mote.inactiveDepth.right.count === 0,
  JSON.stringify(result.mote.inactiveDepth));
check('firefly is compact HDR source', result.mote.fireflyPeak > 1.0,
  `linear peak=${result.mote.fireflyPeak.toFixed(3)}`);
check('world volume obeys opaque occlusion',
  result.mote.visiblePixels > 10 && result.mote.occludedPixels === 0,
  `visible=${result.mote.visiblePixels}px occluded=${result.mote.occludedPixels}px`);
const plateauTail = result.plateau.samples.slice(-3);
check('dispose resource plateau',
  plateauTail.every((sample) => sample.geometries === result.plateau.baseline.geometries
    && sample.textures === result.plateau.baseline.textures)
  && new Set(plateauTail.map((sample) => sample.programs)).size === 1,
  JSON.stringify(result.plateau));
check('page errors', errors.length === 0, errors.join(' | ') || 'none');

let passed = 0;
console.log(`backend: ${result.backend}`);
for (const item of checks) {
  if (item.ok) passed++;
  console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name} — ${item.detail}`);
}
console.log(`\n${passed}/${checks.length} passed`);
process.exitCode = passed === checks.length ? 0 : 1;
