// Regression gate for the material Fresnel rim: the true tangent silhouette must read as a bright
// thread while a broad oblique building plane stays a surface rather than an emitter.  The three
// physical conditions (solar facing, backlight, main-sun visibility) are asserted as *floored
// attenuation*, not as an all-or-nothing switch — see docs/look-audit-2026-07.md R2, which found
// that hard gates plus a 0.26 energy cap had closed the flagship rim entirely.  The controlled
// WebGL scene also proves that the onBeforeCompile chain, role classification, instanceColor, and
// program plateau survive the shader patch.
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
import { patchSnowMaterial } from '/src/env/snow-material.js';
import { attachLodScreenDoorRoot } from '/src/render/lod-screen-door.js';

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
    // Same visible edge, but the normal faces away from the behind-camera sun. wrap=1 proves the
    // anti-solar residual setter is a live look control again (product default is RIM_WRAP_FLOOR).
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
    // 세 물리 조건은 남지만 곱하기 0 이 아니라 바닥값 있는 감쇠로 합성된다(look-audit R2).
    flooredGatesInjected: patch.fragment.includes('mix(uRimWrap, 1.0,')
      && patch.fragment.includes('mix(' + RIM_SOLAR_GATE.backlitFloor.toFixed(2) + ', 1.0,')
      && patch.fragment.includes('mix(' + RIM_SOLAR_GATE.shadowFloor.toFixed(2) + ', 1.0,'),
    shadowFetchCount: (patch.fragment.match(/getShadow\\s*\\(/g) || []).length,
    stockShadowFetchCount: (THREE.ShaderChunk.lights_fragment_begin.match(/getShadow\\s*\\(/g) || []).length,
    wrapComposed: patch.fragment.includes('uRimWrap'),
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
  // 제품 마을의 실제 그룹/메시 이름. env 하네스 이름('trees')만 등재돼 있던 동안 마을 숲·스캐터
  // 나무·개화 관목이 misc(건물급)로, 마을 지형·수면이 일반 표면으로 분류되던 결함을 고정한다.
  const villageGroups = ['village-trees', 'forest-trees', 'village-bloom', 'village-flora'];
  const villageOrganicMaterials = villageGroups.map((name, index) => {
    const group = new THREE.Group();
    group.name = name;
    const mat = new THREE.MeshStandardMaterial({ color: 0x2a2a2a });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), mat);
    mesh.position.set(30 + index * 2, 0, 0);
    group.add(mesh);
    scene.add(group);
    return mat;
  });
  const groundNames = ['village-terrain', 'village-stream'];
  const groundMaterials = groundNames.map((name, index) => {
    const mat = new THREE.MeshStandardMaterial({ color: 0x2a2a2a });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), mat);
    mesh.name = name;
    mesh.position.set(40 + index * 2, 0, 0);
    scene.add(mesh);
    return mat;
  });

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
    villageOrganicMuls: villageOrganicMaterials.map((m) => readPatch(renderer, m).mul),
    // 지면은 패치를 유지해야 한다(프로그램 분기 방지) — 계수만 0.
    groundPatched: groundMaterials.map((m) => !!m.userData.__rimPatched),
    groundMuls: groundMaterials.map((m) => readPatch(renderer, m).mul),
    miscMul: readPatch(renderer, miscMaterial).mul,
  };
}

function lodProgramCompositionProbe() {
  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, 1));
  const camera = new THREE.OrthographicCamera(-2, 2, 2, -2, 0.1, 20);
  camera.position.set(0, 0, 5);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  const geometry = new THREE.BoxGeometry(0.5, 0.5, 0.5);
  const plainMaterial = new THREE.MeshStandardMaterial({ color: 0x777777, roughness: 1 });
  const lodMaterial = new THREE.MeshStandardMaterial({ color: 0x777777, roughness: 1 });
  const lateSnowLodMaterial = new THREE.MeshStandardMaterial({ color: 0x777777, roughness: 1 });
  plainMaterial.userData.role = 'roof';
  lodMaterial.userData.role = 'roof';
  lateSnowLodMaterial.userData.role = 'roof';
  const plain = new THREE.Mesh(geometry, plainMaterial);
  const lod = new THREE.Mesh(geometry, lodMaterial);
  const lateSnowLod = new THREE.Mesh(geometry, lateSnowLodMaterial);
  plain.position.x = -0.5;
  lod.position.x = 0.5;
  lateSnowLod.position.y = 0.8;
  plain.frustumCulled = false;
  lod.frustumCulled = false;
  lateSnowLod.frustumCulled = false;
  attachLodScreenDoorRoot(lod);
  attachLodScreenDoorRoot(lateSnowLod);
  const cloudUniforms = createCloudUniforms();
  injectCloudShadow(plainMaterial, cloudUniforms);
  injectCloudShadow(lodMaterial, cloudUniforms);
  injectCloudShadow(lateSnowLodMaterial, cloudUniforms);
  const snowAmount = { value: 0.7 };
  patchSnowMaterial(plainMaterial, snowAmount, { profile: 'tile' });
  patchSnowMaterial(lodMaterial, snowAmount, { profile: 'tile' });
  scene.add(plain, lod, lateSnowLod);
  const rim = createFresnelRim(scene);
  rim.apply(scene);
  // Real lifecycle counterpart: clear weather warms/rim-patches first, then snow arrives.
  patchSnowMaterial(lateSnowLodMaterial, snowAmount, { profile: 'tile' });
  rim.setStrength(0);
  renderer.compile(scene, camera);
  renderer.setRenderTarget(rt);
  renderer.clear();
  renderer.render(scene, camera);
  renderer.setRenderTarget(null);
  const plainProgram = renderer.properties.get(plainMaterial).currentProgram;
  const lodProgram = renderer.properties.get(lodMaterial).currentProgram;
  const lateSnowLodProgram = renderer.properties.get(lateSnowLodMaterial).currentProgram;
  const plainPatch = readPatch(renderer, plainMaterial);
  const lodPatch = readPatch(renderer, lodMaterial);
  const result = {
    plainKey: plainMaterial.customProgramCacheKey(),
    lodKey: lodMaterial.customProgramCacheKey(),
    lateSnowLodKey: lateSnowLodMaterial.customProgramCacheKey(),
    // R8 program diet: rim always installs the LOD screen-door shader path, so plain cloud+
    // snow+rim and true LOD roots share one WebGLProgram. Matrix channel stays object-local.
    sharedPrograms: !!plainProgram && !!lodProgram && plainProgram === lodProgram,
    orderIndependentProgram: !!lodProgram && lodProgram === lateSnowLodProgram,
    plainProgramKey: plainProgram?.cacheKey || null,
    lodProgramKey: lodProgram?.cacheKey || null,
    discardInjected: lodPatch.fragment.includes('_screenDoorIgn')
      && plainPatch.fragment.includes('_screenDoorIgn'),
    worldPositionRepaired: lodPatch.vertex.includes('worldPosition.w = 1.0')
      && plainPatch.vertex.includes('worldPosition.w = 1.0'),
  };
  rim.dispose();
  plainMaterial.dispose();
  lodMaterial.dispose();
  lateSnowLodMaterial.dispose();
  geometry.dispose();
  return result;
}

window.__result = {
  facing: facingProbe(),
  contracts: instanceAndProgramProbe(),
  lodComposition: lodProgramCompositionProbe(),
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
  const shadowFloor = result.facing.solarGate.shadowFloor;
  console.log('  additive luma:', Object.fromEntries(Object.entries(sample)
    .map(([name, value]) => [name, +value.delta.toFixed(4)])));
  check(sample.front.delta <= 0.005, `front-facing plane stays dark (${sample.front.delta.toFixed(4)})`);
  check(sample.broad60.offLuma > 0.01 && sample.broad60.delta <= 0.005,
    `sunlit broad 60° plane has no rim (base=${sample.broad60.offLuma.toFixed(4)}, delta=${sample.broad60.delta.toFixed(4)})`);
  // 접선 밴드가 넓어져(cutoff 0.42) 75° 면도 약한 광택은 받는다. 지켜야 하는 것은
  // "면이 발광체가 되지 않는다" — 자기 기저 밝기의 절반 이하이고 진짜 접선 에지보다 훨씬 어둡다.
  check(sample.broad75.offLuma > 0.01
      && sample.broad75.delta <= 0.05
      && sample.broad75.delta <= sample.broad75.offLuma * 0.5
      && sample.broad75.delta <= sample.litEdge.delta * 0.35,
    `sunlit broad 75° plane stays a surface, not an emitter (base=${sample.broad75.offLuma.toFixed(4)}, delta=${sample.broad75.delta.toFixed(4)})`);
  check(sample.litEdge.ndl > 0 && sample.litEdge.viewSun < 0 && sample.litEdge.delta >= 0.05,
    `sun-facing backlit 86° edge remains legible (N·L=${sample.litEdge.ndl.toFixed(3)}, V·L=${sample.litEdge.viewSun.toFixed(3)}, delta=${sample.litEdge.delta.toFixed(4)})`);
  // setWrap 은 다시 살아 있는 룩 컨트롤이다(하네스가 1 로 올린다). wrap=1 이면 태양 반대편도
  // 태양쪽과 같은 잔여를 받는 것이 정의 — 값이 반영되는지만 본다. 제품 기본값에서의 방향성은
  // 아래 defaultWrapSeparation 이 검사한다.
  check(sample.unlitEdge.ndl < 0 && sample.unlitEdge.delta > 0.02,
    `setWrap(1) is honored on the sun-opposite edge (N·L=${sample.unlitEdge.ndl.toFixed(3)}, delta=${sample.unlitEdge.delta.toFixed(4)})`);
  // 순광 뷰는 감쇠하되 소거되지 않는다(backlitFloor). 역광 에지보다 확실히 어두워야 한다.
  check(sample.cameraSideSun.ndl > 0 && sample.cameraSideSun.viewSun > 0
      && sample.cameraSideSun.delta <= sample.litEdge.delta * 0.45,
    `camera-side sun is attenuated, not backlight (V·L=${sample.cameraSideSun.viewSun.toFixed(3)}, delta=${sample.cameraSideSun.delta.toFixed(4)})`);
  // 직사광 0(그늘)에서도 실루엣 에지는 하늘 산란광으로 읽힌다 — 소거가 아니라 shadowFloor 감쇠.
  check(sample.noDirect.offLuma <= 0.003
      && sample.noDirect.delta > 0
      && sample.noDirect.delta <= sample.litEdge.delta * 0.75,
    `directDiffuse=0 keeps only the sky-scatter residual (base=${sample.noDirect.offLuma.toFixed(4)}, delta=${sample.noDirect.delta.toFixed(4)})`);
  check(sample.shadowedEdge.offLuma <= sample.litEdge.offLuma * 0.20
      && sample.shadowedEdge.delta < sample.litEdge.delta,
    `directional shadow still attenuates the same edge (base=${sample.shadowedEdge.offLuma.toFixed(4)}, delta=${sample.shadowedEdge.delta.toFixed(4)})`);
  // 같은 지오메트리·같은 fill 을 쓰되 receiveShadow 로만 갈리는 shadowBypassedReceiver 가
  // "가려지지 않은 경우"의 대조군이다. 비그림자 fill 은 주 태양 그림자 안의 림을 바닥값 위로
  // 되살릴 수 없다(감쇠는 shadowFloor 까지만).
  const fillShadowRatio = sample.productFillShadow.delta
    / Math.max(sample.shadowBypassedReceiver.delta, 1e-6);
  check(sample.productFillShadow.ndl > 0 && sample.productFillShadow.fillNdl > 0
      && fillShadowRatio > 0 && fillShadowRatio <= shadowFloor + 0.15,
    `unshadowed fill cannot restore full rim inside the main-sun shadow (sun N·L=${sample.productFillShadow.ndl.toFixed(3)}, fill N·L=${sample.productFillShadow.fillNdl.toFixed(3)}, ${fillShadowRatio.toFixed(3)}× of the unshadowed control)`);
  check(sample.shadowBypassedReceiver.offLuma > sample.productFillShadow.offLuma,
    `receiveShadow=false brightens the surface without owning rim visibility (base=${sample.shadowBypassedReceiver.offLuma.toFixed(4)}, delta=${sample.shadowBypassedReceiver.delta.toFixed(4)})`);
  // 그림자 비율은 여전히 단조롭게 반영된다. 바닥값이 있으므로 0.5 가시율은
  // mix(shadowFloor,1,0.5) = 0.725 로 나타난다(포화 아님).
  const halfVisibilityRatio = sample.ratioHalfShadow.delta / Math.max(sample.ratioLit.delta, 1e-6);
  const halfExpected = shadowFloor + (1 - shadowFloor) * 0.5;
  check(halfVisibilityRatio > shadowFloor * 0.9
      && halfVisibilityRatio <= halfExpected + 0.12,
    `50% stock penumbra stays monotonic at sun intensity 2.3 (${halfVisibilityRatio.toFixed(3)}×, expected ≈${halfExpected.toFixed(2)}×)`);
  check(result.facing.gate.full === 0.10 && result.facing.gate.cutoff === 0.42,
    `facing gate contract ${JSON.stringify(result.facing.gate)}`);
  check(result.facing.solarGate.facingStart === -0.05
      && result.facing.solarGate.backlitStart === 0.02
      && result.facing.solarGate.backlitFloor === 0.20
      && result.facing.solarGate.shadowFloor === 0.45
      && result.facing.solarGate.directStart === 0.002
      && result.facing.solarGate.directFull === 0.08,
    `solar gate contract ${JSON.stringify(result.facing.solarGate)}`);
  const peak = result.facing.sunsetPeak.deltaRgb;
  const peakLuma = result.facing.sunsetPeak.delta;
  console.log(`  sunset peak additive: rgb=(${peak.r.toFixed(4)}, ${peak.g.toFixed(4)}, ${peak.b.toFixed(4)}) luma=${peakLuma.toFixed(4)}`);
  // 접선 실선은 클리핑해 bloom 을 먹이는 것이 룩이다(look-audit R2). 상한은 "면 전체가
  // HDR 백색 발광체가 되지 않는" 지점에만 둔다. 골든 실측 대비로 재조정한 값.
  check(result.facing.energyCap === 0.34, `base HDR rim cap ${result.facing.energyCap}`);
  check(Math.max(peak.r, peak.g, peak.b) <= 0.55 && peakLuma <= 0.34,
    `sunset 2.05×1.6 building edge stays warm/bounded (max=${Math.max(peak.r, peak.g, peak.b).toFixed(4)}, luma=${peakLuma.toFixed(4)})`);
  check(result.facing.energyCap * 0.7 < 0.25,
    `organic peak remains below 0.25 additive energy (${(result.facing.energyCap * 0.7).toFixed(3)})`);

  console.log('\n=== shader and runtime contracts ===');
  check(result.facing.chainKept, 'pre-existing onBeforeCompile patch remains chained');
  check(result.facing.cloudFragmentInjected && result.facing.rimFragmentInjected,
    `real cloud-shadow and physical rim shader bodies coexist on one roof material (cloud=${result.facing.cloudFragmentInjected}, rim=${result.facing.rimFragmentInjected})`);
  // Sorted token chain: LOD screen-door is always installed with rim (R8 diet), then physical
  // rim + cloud shadow. Order of installation must not change the key.
  check(result.facing.composedProgramKey
      === 'cheoma-lod-screen-door-v1|cheoma-rim-physical-v1|cloudshadow-v2',
    `cloud→rim customProgramCacheKey is composed (${result.facing.composedProgramKey})`);
  check(result.facing.reverseCloudChainKept
      && result.facing.reverseComposedProgramKey === result.facing.composedProgramKey,
    `rim→cloud callback/cache-key is composed (${result.facing.reverseComposedProgramKey})`);
  check(result.facing.silhouetteInjected, 'compiled rim source multiplies the silhouette gate');
  check(result.facing.physicalGatesInjected && result.facing.mainSunCaptureInjected
      && result.facing.flooredGatesInjected,
    'shader composes solar-facing, backlight, and stock shadow ratio as floored attenuation');
  check(result.facing.wrapComposed, 'anti-solar wrap residual is part of rim energy again');
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
  // building 1 + misc 1 + organic 5(env 'trees' 1 + 마을 식생 4) + ground 2. opening 은 제외되므로
  // total 이 9 라는 것 자체가 "제외 대상은 세지 않는다"는 계약이다.
  check(contracts.coverage.building === 1
      && contracts.coverage.misc === 1
      && contracts.coverage.organic === 5
      && contracts.coverage.ground === 2
      && contracts.coverage.total === 9,
    `role coverage ${JSON.stringify(contracts.coverage)}`);
  check(contracts.roleKept === 'roof' && !contracts.openingPatched,
    `role tag/opening exclusion preserved (${contracts.roleKept}, patched=${contracts.openingPatched})`);
  check(contracts.organicMul === 0.7 && contracts.miscMul === 1,
    `shared shader keeps per-material multipliers organic=${contracts.organicMul} misc=${contracts.miscMul}`);
  // 마을 식생 그룹 이름이 organic 명단에 없으면 숲이 건물급 림을 받는다(docs/tree-look.md 0-3).
  check(contracts.villageOrganicMuls.every((mul) => mul === 0.7),
    `village vegetation groups classify as organic (${JSON.stringify(contracts.villageOrganicMuls)})`);
  // 마을 지형·수면: 패치는 유지(프로그램 분기 방지)하고 계수만 0 — 광역 그레이징 워시 차단.
  check(contracts.groundPatched.every(Boolean) && contracts.groundMuls.every((mul) => mul === 0),
    `village ground/water stays patched at zero contribution (patched=${JSON.stringify(contracts.groundPatched)}, mul=${JSON.stringify(contracts.groundMuls)})`);
  const lodComposition = result.lodComposition;
  // R8: collapsing plain vs LOD families — both keys must carry screen-door and compile as one
  // program. Coverage defaults to 1 on non-channel objects so plain draws stay a discard no-op.
  check(lodComposition.sharedPrograms
      && lodComposition.lodKey.includes('cheoma-lod-screen-door-v1')
      && lodComposition.plainKey.includes('cheoma-lod-screen-door-v1')
      && lodComposition.plainKey === lodComposition.lodKey,
    `LOD and plain cloud+snow+rim materials share one program family `
      + `(${lodComposition.plainKey} / ${lodComposition.lodKey})`);
  check(lodComposition.discardInjected && lodComposition.worldPositionRepaired,
    'compiled plain and LOD color shaders keep screen-door discard and affine worldPosition');
  check(lodComposition.lodKey === lodComposition.lateSnowLodKey
      && lodComposition.orderIndependentProgram,
    `snow-before-rim and rim-before-snow reuse one canonical LOD program `
      + `(${lodComposition.lodKey} / ${lodComposition.lateSnowLodKey})`);
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
