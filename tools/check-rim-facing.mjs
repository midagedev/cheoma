// Regression gate for the material Fresnel rim: broad oblique building planes must stay dark
// while the true tangent silhouette remains bright.  The controlled WebGL scene also proves
// that the onBeforeCompile chain, role classification, instanceColor, and program plateau
// survive the shader patch.
//
// Usage: node tools/check-rim-facing.mjs
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { VILLAGE_FOCUS_ELEVATION } from '../src/camera/optics.js';
import { launchVerificationBrowser, reportWebGLRenderer } from './lib/verification-browser.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const FOCUS_ELEVATION_DEG = VILLAGE_FOCUS_ELEVATION * 180 / Math.PI;
const VIEWPORT = { width: 128, height: 96 };
const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
};

const HARNESS = `<!doctype html><html><body style="margin:0;background:#000">
<script type="importmap">{"imports":{"three":"/app/node_modules/three/build/three.module.js"}}</script>
<script type="module">
import * as THREE from 'three';
import {
  createFresnelRim,
  RIM_BASE_ENERGY_CAP,
  RIM_FACING_GATE,
  RIM_SOLAR_GATE,
} from '/src/env/rim.js';
import { injectCloudShadow } from '/src/builder/palette.js';
import { createCloudUniforms } from '/src/env/clouds.js';

const W = 128;
const H = 96;
const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setPixelRatio(1);
renderer.setSize(W, H, false);
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.append(renderer.domElement);
const rt = new THREE.WebGLRenderTarget(W, H, {
  minFilter: THREE.NearestFilter,
  magFilter: THREE.NearestFilter,
  format: THREE.RGBAFormat,
  type: THREE.UnsignedByteType,
});

function readPatch(rendererRef, material) {
  const shader = {
    uniforms: {},
    vertexShader: THREE.ShaderLib.standard.vertexShader,
    fragmentShader: THREE.ShaderLib.standard.fragmentShader,
  };
  material.onBeforeCompile(shader, rendererRef);
  return {
    fragment: shader.fragmentShader,
    vertex: shader.vertexShader,
    mul: shader.uniforms.uRimGroupMul?.value ?? null,
    key: material.customProgramCacheKey(),
  };
}

function pixelAt(camera, world, radius = 1) {
  const p = world.clone().project(camera);
  const cx = Math.round((p.x * 0.5 + 0.5) * (W - 1));
  const cy = Math.round((p.y * 0.5 + 0.5) * (H - 1));
  const buf = new Uint8Array(W * H * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, W, H, buf);
  let r = 0, g = 0, b = 0, n = 0;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || x >= W || y < 0 || y >= H) continue;
      const i = (y * W + x) * 4;
      r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; n++;
    }
  }
  return { r: r / (255 * n), g: g / (255 * n), b: b / (255 * n) };
}

function luminance(c) {
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

function facingProbe() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);
  const material = new THREE.MeshStandardMaterial({ color: 0x606060, roughness: 1 });
  material.userData.role = 'roof';
  // A pre-existing patch is representative of seasonal/cloud/material extensions.  Rim must
  // call it first and retain its source marker rather than replacing the chain.
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <common>',
      '#include <common>\\n#define CHEOMA_RIM_CHAIN_MARKER 1',
    );
  };
  // Real village roofs receive this patch before post.rimRescan().  Exercise the production
  // callback and explicit program-key chain rather than a hand-written stand-in.
  injectCloudShadow(material, createCloudUniforms());
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(3, 3), material);
  plane.frustumCulled = false;
  plane.receiveShadow = true;
  scene.add(plane);
  const sun = new THREE.DirectionalLight(0xffffff, 2.3);
  sun.castShadow = true;
  sun.shadow.mapSize.set(512, 512);
  sun.shadow.camera.left = -4; sun.shadow.camera.right = 4;
  sun.shadow.camera.top = 4; sun.shadow.camera.bottom = -4;
  sun.shadow.camera.near = 0.1; sun.shadow.camera.far = 30;
  sun.shadow.bias = -0.0002; sun.shadow.normalBias = 0.015;
  // Product villages add a warm, unshadowed anti-solar DirectionalLight after the main sun.
  // Its upward component can illuminate a roof normal even when the main sun is occluded.
  const fill = new THREE.DirectionalLight(0xecc09c, 0);
  fill.castShadow = false;
  // Add fill first deliberately: Three must still sort the sole shadow caster into slot zero.
  scene.add(fill, fill.target, sun, sun.target);
  const blocker = new THREE.Mesh(
    new THREE.BoxGeometry(1.2, 1.2, 0.7),
    new THREE.MeshStandardMaterial({ color: 0x111111 }),
  );
  blocker.castShadow = true;
  blocker.frustumCulled = false;
  scene.add(blocker);
  // Reverse-order composition probe: some reusable consumers may install rim before village
  // cloud wiring.  Keep it out of frame but in the traversed subtree.
  const reverseMaterial = new THREE.MeshStandardMaterial({ color: 0x333333, roughness: 1 });
  reverseMaterial.userData.role = 'roof';
  const reverseMesh = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), reverseMaterial);
  reverseMesh.position.set(100, 0, 0);
  scene.add(reverseMesh);
  const camera = new THREE.PerspectiveCamera(40, W / H, 0.1, 30);
  camera.position.set(0, 0, 5);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();

  const rim = createFresnelRim(scene);
  rim.apply(scene);
  injectCloudShadow(reverseMaterial, createCloudUniforms());
  rim.setColor(new THREE.Color(0xffffff));
  rim.setStrength(0.35);
  rim.setPower(5.12);
  rim.setWrap(0);
  rim.setScale(1);
  rim.setNearFar(0, 20);

  const patch = readPatch(renderer, material);
  const reversePatch = readPatch(renderer, reverseMaterial);
  function renderSample(degrees, sunDegrees, {
    blocked = false,
    strength = 0.35,
    color = 0xffffff,
    sunIntensity = 2.3,
    sunElevation = 0,
    fillIntensity = 0,
    fillElevation = 0.42,
    upwardNormal = 0,
    albedo = 0x606060,
    receiveShadow = true,
    shadowIntensity = 1,
    wrap = 0,
  } = {}) {
    const radians = THREE.MathUtils.degToRad(degrees);
    const sunRadians = THREE.MathUtils.degToRad(sunDegrees);
    const sunHorizontal = Math.sqrt(Math.max(0, 1 - sunElevation * sunElevation));
    const sunDir = new THREE.Vector3(
      Math.sin(sunRadians) * sunHorizontal,
      sunElevation,
      Math.cos(sunRadians) * sunHorizontal,
    ).normalize();
    const normalHorizontal = Math.sqrt(Math.max(0, 1 - upwardNormal * upwardNormal));
    const surfaceNormal = new THREE.Vector3(
      Math.sin(radians) * normalHorizontal,
      upwardNormal,
      Math.cos(radians) * normalHorizontal,
    ).normalize();
    plane.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), surfaceNormal);
    plane.updateMatrixWorld(true);
    plane.receiveShadow = receiveShadow;
    material.color.setHex(albedo);
    sun.position.copy(sunDir).multiplyScalar(10);
    sun.target.position.set(0, 0, 0);
    sun.target.updateMatrixWorld(true);
    sun.intensity = sunIntensity;
    sun.shadow.intensity = shadowIntensity;
    const fillDir = new THREE.Vector3(
      -Math.sin(sunRadians),
      fillElevation,
      -Math.cos(sunRadians),
    ).normalize();
    fill.position.copy(fillDir).multiplyScalar(10);
    fill.target.position.set(0, 0, 0);
    fill.target.updateMatrixWorld(true);
    fill.intensity = fillIntensity;
    blocker.visible = blocked;
    blocker.position.copy(sunDir).multiplyScalar(1.6);
    blocker.lookAt(0, 0, 0);
    blocker.updateMatrixWorld(true);
    rim.setSunViewDir(sunDir);
    rim.setWrap(wrap);
    rim.setColor(new THREE.Color(color));
    rim.setStrength(0);
    renderer.setRenderTarget(rt);
    renderer.setClearColor(0x000000, 1);
    renderer.clear();
    renderer.render(scene, camera);
    const off = pixelAt(camera, new THREE.Vector3(), degrees >= 84 ? 0 : 1);
    rim.setStrength(strength);
    renderer.clear();
    renderer.render(scene, camera);
    const on = pixelAt(camera, new THREE.Vector3(), degrees >= 84 ? 0 : 1);
    return {
      off,
      on,
      deltaRgb: {
        r: Math.max(0, on.r - off.r),
        g: Math.max(0, on.g - off.g),
        b: Math.max(0, on.b - off.b),
      },
      offLuma: luminance(off),
      onLuma: luminance(on),
      delta: Math.max(0, luminance(on) - luminance(off)),
      ndv: surfaceNormal.z,
      ndl: surfaceNormal.dot(sunDir),
      fillNdl: surfaceNormal.dot(fillDir),
      viewSun: sunDir.z,
    };
  }

  // Each broad-plane probe is genuinely sun-facing and backlit; its zero delta therefore
  // proves the silhouette gate rather than accidentally testing an unlit face.
  const result = {
    front: renderSample(0, 110),
    broad60: renderSample(60, 130),
    broad75: renderSample(75, 145),
    litEdge: renderSample(86, 156),
    // Same visible edge, but the normal faces away from the behind-camera sun. wrap=1 proves
    // that the legacy compatibility setter can no longer invent a dark-side glow.
    unlitEdge: renderSample(86, 204, { wrap: 1 }),
    cameraSideSun: renderSample(86, 60),
    noDirect: renderSample(86, 156, { sunIntensity: 0 }),
    shadowedEdge: renderSample(86, 156, { blocked: true }),
    productFillShadow: renderSample(86, 156, {
      blocked: true,
      sunElevation: 0.18,
      fillIntensity: 0.62,
      upwardNormal: 0.85,
      albedo: 0xaaa29c,
    }),
    // receiveShadow=false leaves Three's stock sun unattenuated even behind the blocker.  Rim
    // must explicitly opt that object out rather than pretending this is physical visibility.
    shadowBypassedReceiver: renderSample(86, 156, {
      blocked: true,
      receiveShadow: false,
      fillIntensity: 0.62,
      upwardNormal: 0.85,
      albedo: 0xaaa29c,
    }),
    ratioLit: renderSample(86, 156, { strength: 0.08, albedo: 0xffffff }),
    ratioHalfShadow: renderSample(86, 156, {
      blocked: true,
      shadowIntensity: 0.5,
      strength: 0.08,
      albedo: 0xffffff,
    }),
  };
  // The real sunset maximum is 2.05 (profile) × 1.6 (runtime compensation).  At that
  // strength the tangent stays warm and bounded rather than clipping to white before bloom.
  const sunsetPeak = renderSample(86, 156, { strength: 2.05 * 1.6, color: 0xffc070 });
  renderer.setRenderTarget(null);
  return {
    samples: result,
    gate: RIM_FACING_GATE,
    solarGate: RIM_SOLAR_GATE,
    energyCap: RIM_BASE_ENERGY_CAP,
    sunsetPeak,
    chainKept: patch.fragment.includes('CHEOMA_RIM_CHAIN_MARKER'),
    cloudFragmentInjected: patch.fragment.includes('uCloudStr'),
    rimFragmentInjected: patch.fragment.includes('_mainSunVisibility'),
    composedProgramKey: patch.key,
    reverseCloudChainKept: reversePatch.fragment.includes('uCloudStr')
      && reversePatch.fragment.includes('_mainSunVisibility'),
    reverseComposedProgramKey: reversePatch.key,
    silhouetteInjected: patch.fragment.includes('_fres * _silhouette'),
    physicalGatesInjected: patch.fragment.includes('_sunFacing * _backlit * _directGate'),
    mainSunCaptureInjected: patch.fragment.includes('_rimMainSunUnshadowed = directLight.color')
      && patch.fragment.includes('_rimMainSunShadowed = directLight.color')
      && patch.fragment.includes('_mainSunAfter / max(_mainSunBefore'),
    receiveShadowGateInjected: patch.fragment.includes('(receiveShadow ? 1.0 : 0.0)'),
    shadowFetchCount: (patch.fragment.match(/getShadow\\s*\\(/g) || []).length,
    stockShadowFetchCount: (THREE.ShaderChunk.lights_fragment_begin.match(/getShadow\\s*\\(/g) || []).length,
    syntheticWrapAbsent: !patch.fragment.includes('uRimWrap'),
    buildingMul: patch.mul,
  };
}

function instanceAndProgramProbe() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);
  scene.add(new THREE.AmbientLight(0xffffff, 1));
  const camera = new THREE.OrthographicCamera(-3, 3, 2.25, -2.25, 0.1, 20);
  camera.position.set(0, 0, 5);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();

  const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1 });
  material.userData.role = 'roof';
  const instances = new THREE.InstancedMesh(new THREE.PlaneGeometry(1.5, 1.5), material, 2);
  const matrix = new THREE.Matrix4();
  instances.setMatrixAt(0, matrix.makeTranslation(-1.4, 0, 0));
  instances.setMatrixAt(1, matrix.makeTranslation(1.4, 0, 0));
  instances.setColorAt(0, new THREE.Color(0xff0000));
  instances.setColorAt(1, new THREE.Color(0x00ff00));
  instances.instanceMatrix.needsUpdate = true;
  instances.instanceColor.needsUpdate = true;
  instances.frustumCulled = false;
  scene.add(instances);

  const trees = new THREE.Group();
  trees.name = 'trees';
  const organicMaterial = new THREE.MeshStandardMaterial({ color: 0x333333 });
  const organic = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), organicMaterial);
  organic.position.set(20, 0, 0); trees.add(organic); scene.add(trees);
  const miscMaterial = new THREE.MeshStandardMaterial({ color: 0x333333 });
  const misc = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), miscMaterial);
  misc.position.set(22, 0, 0); scene.add(misc);
  const openingMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff });
  openingMaterial.userData.role = 'opening';
  const opening = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.2), openingMaterial);
  opening.position.set(24, 0, 0); scene.add(opening);

  const rim = createFresnelRim(scene);
  rim.apply(scene);
  rim.setStrength(0);
  renderer.compile(scene, camera);
  renderer.setRenderTarget(rt);
  renderer.setClearColor(0x000000, 1);
  renderer.clear();
  renderer.render(scene, camera);
  const red = pixelAt(camera, new THREE.Vector3(-1.4, 0, 0));
  const green = pixelAt(camera, new THREE.Vector3(1.4, 0, 0));
  const programs0 = renderer.info.programs?.length ?? -1;
  for (let i = 0; i < 5; i++) rim.apply(scene);
  renderer.render(scene, camera);
  const programs1 = renderer.info.programs?.length ?? -1;
  renderer.setRenderTarget(null);

  return {
    red,
    green,
    programs0,
    programs1,
    coverage: rim.coverage,
    multipliers: rim.groupMultipliers,
    roleKept: material.userData.role,
    openingPatched: !!openingMaterial.userData.__rimPatched,
    organicMul: readPatch(renderer, organicMaterial).mul,
    miscMul: readPatch(renderer, miscMaterial).mul,
  };
}

window.__result = {
  facing: facingProbe(),
  contracts: instanceAndProgramProbe(),
};
window.__READY = true;
</script></body></html>`;

const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
  if (pathname === '/__rim-facing') {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(HARNESS);
    return;
  }
  if (pathname === '/favicon.ico') {
    response.writeHead(204);
    response.end();
    return;
  }
  try {
    const file = join(ROOT, pathname);
    const data = await readFile(file);
    response.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    response.end(data);
  } catch {
    response.writeHead(404);
    response.end('not found');
  }
});
await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));

let browser;
let failures = 0;
const check = (condition, message) => {
  console.log(`  ${condition ? 'PASS' : 'FAIL'} — ${message}`);
  if (!condition) failures++;
};

try {
  browser = await launchVerificationBrowser();
  const page = await browser.newPage({ viewport: VIEWPORT });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/__rim-facing`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__READY === true, null, { timeout: 30000 });
  await reportWebGLRenderer(page, 'rim-facing');
  const result = await page.evaluate(() => window.__result);

  console.log('\n=== physical solar rim energy ===');
  const sample = result.facing.samples;
  console.log('  additive luma:', Object.fromEntries(Object.entries(sample)
    .map(([name, value]) => [name, +value.delta.toFixed(4)])));
  check(sample.front.delta <= 0.005, `front-facing plane stays dark (${sample.front.delta.toFixed(4)})`);
  check(sample.broad60.offLuma > 0.01 && sample.broad60.delta <= 0.005,
    `sunlit broad 60° plane has no rim (base=${sample.broad60.offLuma.toFixed(4)}, delta=${sample.broad60.delta.toFixed(4)})`);
  check(sample.broad75.offLuma > 0.01 && sample.broad75.delta <= 0.020,
    `sunlit broad 75° plane is not emissive (base=${sample.broad75.offLuma.toFixed(4)}, delta=${sample.broad75.delta.toFixed(4)})`);
  check(sample.litEdge.ndl > 0 && sample.litEdge.viewSun < 0 && sample.litEdge.delta >= 0.05,
    `sun-facing backlit 86° edge remains legible (N·L=${sample.litEdge.ndl.toFixed(3)}, V·L=${sample.litEdge.viewSun.toFixed(3)}, delta=${sample.litEdge.delta.toFixed(4)})`);
  check(sample.unlitEdge.ndl < 0 && sample.unlitEdge.delta <= 0.003,
    `sun-opposite edge stays dark even with setWrap(1) (N·L=${sample.unlitEdge.ndl.toFixed(3)}, delta=${sample.unlitEdge.delta.toFixed(4)})`);
  check(sample.cameraSideSun.ndl > 0 && sample.cameraSideSun.viewSun > 0 && sample.cameraSideSun.delta <= 0.003,
    `camera-side sun cannot fake backlight (V·L=${sample.cameraSideSun.viewSun.toFixed(3)}, delta=${sample.cameraSideSun.delta.toFixed(4)})`);
  check(sample.noDirect.offLuma <= 0.003 && sample.noDirect.delta <= 0.003,
    `directDiffuse=0 produces no rim (base=${sample.noDirect.offLuma.toFixed(4)}, delta=${sample.noDirect.delta.toFixed(4)})`);
  check(sample.shadowedEdge.offLuma <= sample.litEdge.offLuma * 0.20
      && sample.shadowedEdge.delta <= sample.litEdge.delta * 0.20,
    `directional shadow rejects the same edge (base=${sample.shadowedEdge.offLuma.toFixed(4)}, delta=${sample.shadowedEdge.delta.toFixed(4)})`);
  check(sample.productFillShadow.ndl > 0 && sample.productFillShadow.fillNdl > 0
      && sample.productFillShadow.delta <= 0.003,
    `main-sun shadow stays rim-dark with product unshadowed fill (sun N·L=${sample.productFillShadow.ndl.toFixed(3)}, fill N·L=${sample.productFillShadow.fillNdl.toFixed(3)}, delta=${sample.productFillShadow.delta.toFixed(4)})`);
  check(sample.shadowBypassedReceiver.offLuma > sample.productFillShadow.offLuma
      && sample.shadowBypassedReceiver.delta <= 0.003,
    `receiveShadow=false cannot bypass physical rim visibility (base=${sample.shadowBypassedReceiver.offLuma.toFixed(4)}, delta=${sample.shadowBypassedReceiver.delta.toFixed(4)})`);
  const halfVisibilityRatio = sample.ratioHalfShadow.delta / Math.max(sample.ratioLit.delta, 1e-6);
  check(halfVisibilityRatio >= 0.40 && halfVisibilityRatio <= 0.60,
    `50% stock penumbra remains proportional at sun intensity 2.3 (${halfVisibilityRatio.toFixed(3)}×, not saturated)`);
  check(sample.litEdge.delta >= sample.unlitEdge.delta * 20,
    `lit/unlit edge separation is at least 20× (${(sample.litEdge.delta / Math.max(sample.unlitEdge.delta, 1e-6)).toFixed(1)}×)`);
  check(result.facing.gate.full === 0.08 && result.facing.gate.cutoff === 0.30,
    `facing gate contract ${JSON.stringify(result.facing.gate)}`);
  check(result.facing.solarGate.facingStart === 0.005
      && result.facing.solarGate.backlitStart === 0.15
      && result.facing.solarGate.directStart === 0.002
      && result.facing.solarGate.directFull === 0.08,
    `solar gate contract ${JSON.stringify(result.facing.solarGate)}`);
  const peak = result.facing.sunsetPeak.deltaRgb;
  const peakLuma = result.facing.sunsetPeak.delta;
  console.log(`  sunset peak additive: rgb=(${peak.r.toFixed(4)}, ${peak.g.toFixed(4)}, ${peak.b.toFixed(4)}) luma=${peakLuma.toFixed(4)}`);
  check(result.facing.energyCap === 0.26, `base HDR rim cap ${result.facing.energyCap}`);
  check(Math.max(peak.r, peak.g, peak.b) <= 0.40 && peakLuma <= 0.25,
    `sunset 2.05×1.6 building edge stays warm/bounded (max=${Math.max(peak.r, peak.g, peak.b).toFixed(4)}, luma=${peakLuma.toFixed(4)})`);
  check(result.facing.energyCap * 0.7 < 0.19,
    `organic peak remains below 0.19 additive energy (${(result.facing.energyCap * 0.7).toFixed(3)})`);

  console.log('\n=== shader and runtime contracts ===');
  check(result.facing.chainKept, 'pre-existing onBeforeCompile patch remains chained');
  check(result.facing.cloudFragmentInjected && result.facing.rimFragmentInjected,
    `real cloud-shadow and physical rim shader bodies coexist on one roof material (cloud=${result.facing.cloudFragmentInjected}, rim=${result.facing.rimFragmentInjected})`);
  check(result.facing.composedProgramKey.startsWith('cheoma-rim-physical-v1|cloudshadow|'),
    `cloud→rim customProgramCacheKey is composed (${result.facing.composedProgramKey})`);
  check(result.facing.reverseCloudChainKept
      && result.facing.reverseComposedProgramKey.startsWith('cloudshadow|cheoma-rim-physical-v1|'),
    `rim→cloud callback/cache-key is composed (${result.facing.reverseComposedProgramKey})`);
  check(result.facing.silhouetteInjected, 'compiled rim source multiplies the silhouette gate');
  check(result.facing.physicalGatesInjected && result.facing.mainSunCaptureInjected
      && result.facing.receiveShadowGateInjected,
    'shader requires solar-facing, actual backlight, stock shadow ratio, and receiveShadow');
  check(result.facing.syntheticWrapAbsent, 'synthetic dark-side wrap is absent from rim energy');
  check(result.facing.shadowFetchCount === result.facing.stockShadowFetchCount,
    `rim adds no duplicate shadow-map fetch (${result.facing.shadowFetchCount} stock calls)`);
  check(result.facing.buildingMul === 1.5, 'building role multiplier remains 1.5');
  const contracts = result.contracts;
  check(contracts.red.r > contracts.red.g * 2 && contracts.red.r > contracts.red.b * 2,
    `instanceColor red survives (${JSON.stringify(contracts.red)})`);
  check(contracts.green.g > contracts.green.r * 2 && contracts.green.g > contracts.green.b * 2,
    `instanceColor green survives (${JSON.stringify(contracts.green)})`);
  check(contracts.programs1 === contracts.programs0,
    `rescan program plateau ${contracts.programs0}→${contracts.programs1}`);
  check(contracts.coverage.building === 1 && contracts.coverage.organic === 1 && contracts.coverage.misc === 1,
    `role coverage ${JSON.stringify(contracts.coverage)}`);
  check(contracts.roleKept === 'roof' && !contracts.openingPatched,
    `role tag/opening exclusion preserved (${contracts.roleKept}, patched=${contracts.openingPatched})`);
  check(contracts.organicMul === 0.7 && contracts.miscMul === 1,
    `shared shader keeps per-material multipliers organic=${contracts.organicMul} misc=${contracts.miscMul}`);
  check(errors.length === 0, `browser and shader errors: ${errors.length}`);
  if (errors.length) console.log(errors.slice(0, 8));
} finally {
  await browser?.close();
  server.close();
}

if (failures === 0 && process.argv.includes('--app')) {
  const { createServer: createViteServer } = await import('../app/node_modules/vite/dist/node/index.js');
  const appRoot = join(ROOT, 'app');
  const cacheDir = await mkdtemp(join(tmpdir(), 'cheoma-rim-focus-cache-'));
  const outputDir = await mkdtemp(join(tmpdir(), 'cheoma-rim-focus-shots-'));
  const vite = await createViteServer({
    root: appRoot,
    configFile: join(appRoot, 'vite.config.js'),
    cacheDir,
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false },
  });
  let appBrowser;
  try {
    await vite.listen();
    const port = vite.httpServer.address().port;
    appBrowser = await launchVerificationBrowser();
    const page = await appBrowser.newPage({ viewport: { width: 1440, height: 900 } });
    const appErrors = [];
    page.on('pageerror', (error) => appErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') appErrors.push(message.text());
    });
    await page.addInitScript(() => { window.__noWarm = true; });
    await page.goto(
      `http://127.0.0.1:${port}/?hero=0&village=1&worker=0&shot=1&vscale=village&vtemple=0&seed=20260718&vseed=7&time=sunset&weather=clear`,
      { waitUntil: 'domcontentloaded', timeout: 90_000 },
    );
    await page.waitForFunction(
      () => window.__SHOT_READY === true
        && window.__engine?.village?.getState()?.active
        && !window.__engine.village.debugCamera().transitioning,
      null,
      { timeout: 90_000 },
    );
    const subject = await page.evaluate(async () => {
      const engine = window.__engine;
      const parcel = engine.village.debugParcels()
        .find((candidate) => candidate.family === 'regular' && candidate.kind === 'giwa');
      if (!parcel) throw new Error('rim app probe could not find a regular giwa parcel');
      engine.village.debugFocus(parcel.parcelId);
      for (let index = 0; index < 6; index++) await Promise.resolve();
      engine.debugDofSeek(1, { finish: true });
      await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
      const framing = engine.village.debugCamera();
      const rise = framing.targetY - framing.y;
      const horizontal = Math.sqrt(Math.max(0, framing.dist * framing.dist - rise * rise));
      return {
        parcelId: parcel.parcelId,
        pitchDeg: Math.atan2(rise, horizontal) * 180 / Math.PI,
        coverage: window.__rim.coverage,
      };
    });
    // Let the authored environment/post tween and focus ambience finish before bracketing the
    // one-frame rim toggle; otherwise the sunset transition itself dominates the A/B delta.
    await page.waitForTimeout(2500);
    await page.evaluate(() => {
      window.__engine.debugSetPaused(true);
      // The first paused draw can still settle a deferred shadow/program upload.  Prime the
      // exact same zero-dt renderer several times before the OFF/ON bracket so that upload is
      // not mistaken for rim energy.
      for (let index = 0; index < 4; index++) window.__engine.debugRenderDofFrame();
    });

    async function capture(enabled, name) {
      const stats = await page.evaluate((rimEnabled) => {
        window.__rim.setEnabled(rimEnabled);
        // One draw commits the shared material uniform; the second is the measured steady
        // frame.  Both use dt=0, so environment, camera and cloud shadow remain unchanged.
        window.__engine.debugRenderDofFrame();
        window.__engine.debugRenderDofFrame();
        const source = [...document.querySelectorAll('canvas')]
          .find((canvas) => canvas.width > 400 && canvas.height > 250);
        const width = 360;
        const height = 225;
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        context.drawImage(source, 0, 0, width, height);
        const data = context.getImageData(0, 0, width, height).data;
        let count = 0, sum = 0, bright = 0, clipped = 0;
        // Lower-center excludes sky and most UI while covering the focused house and yard.
        for (let y = Math.floor(height * 0.42); y < Math.floor(height * 0.94); y++) {
          for (let x = Math.floor(width * 0.10); x < Math.floor(width * 0.90); x++) {
            const offset = (y * width + x) * 4;
            const luma = (0.2126 * data[offset] + 0.7152 * data[offset + 1] + 0.0722 * data[offset + 2]) / 255;
            sum += luma; count++;
            if (luma > 0.90) bright++;
            if (data[offset] > 250 && data[offset + 1] > 250 && data[offset + 2] > 250) clipped++;
          }
        }
        return {
          mean: sum / count,
          brightFraction: bright / count,
          clippedFraction: clipped / count,
          strength: window.__rim.strength,
          scale: window.__rim.scale,
        };
      }, enabled);
      await page.locator('canvas').first().screenshot({ path: join(outputDir, `${name}.png`) });
      return stats;
    }

    const offA = await capture(false, 'sunset-focus-rim-off-a');
    const on = await capture(true, 'sunset-focus-rim-on');
    const offB = await capture(false, 'sunset-focus-rim-off-b');
    const off = {
      mean: (offA.mean + offB.mean) * 0.5,
      brightFraction: (offA.brightFraction + offB.brightFraction) * 0.5,
      clippedFraction: (offA.clippedFraction + offB.clippedFraction) * 0.5,
    };
    console.log('\n=== real app sunset focus A/B (diagnostic) ===');
    console.log(`  subject=${subject.parcelId} pitch=${subject.pitchDeg.toFixed(2)}° cloud+rim roofs=${subject.coverage?.cloudRoof ?? 0}`);
    console.log(`  OFF bracket mean=${off.mean.toFixed(4)} bright>0.90=${(off.brightFraction * 100).toFixed(3)}% clipped=${(off.clippedFraction * 100).toFixed(3)}%`);
    console.log(`  ON  mean=${on.mean.toFixed(4)} bright>0.90=${(on.brightFraction * 100).toFixed(3)}% clipped=${(on.clippedFraction * 100).toFixed(3)}% strength=${on.strength.toFixed(3)} scale=${on.scale}`);
    console.log(`  screenshots: ${outputDir}`);
    check((subject.coverage?.cloudRoof ?? 0) > 0,
      `actual village roof keeps cloud-shadow + rim composition (${subject.coverage?.cloudRoof ?? 0} materials)`);
    check(Math.abs(Math.abs(subject.pitchDeg) - FOCUS_ELEVATION_DEG) <= 1,
      `A/B uses the final ~${FOCUS_ELEVATION_DEG.toFixed(0)}° focus pitch (${subject.pitchDeg.toFixed(2)}°)`);
    check(on.clippedFraction === 0 && on.brightFraction < 0.001,
      `final focus rim avoids white/clipped surfaces (${(on.brightFraction * 100).toFixed(3)}% bright)`);
    check(appErrors.length === 0, `actual village cloud+rim shader errors: ${appErrors.length}`);
    if (appErrors.length) console.log(appErrors.slice(0, 8));
  } finally {
    await appBrowser?.close();
    await vite.close();
    await rm(cacheDir, { recursive: true, force: true });
  }
}

console.log(`\n${failures === 0 ? 'ALL GATES PASS' : `GATES FAILED: ${failures}`}`);
process.exit(failures === 0 ? 0 : 1);
