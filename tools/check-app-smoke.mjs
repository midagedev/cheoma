// Full-app browser smoke: app bootstrap → village → focus wiring.
// Uses an isolated Vite cache and ephemeral port, leaving any user dev server untouched.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from '../app/node_modules/vite/dist/node/index.js';

const ROOT = resolve(import.meta.dirname, '..');
const APP_ROOT = join(ROOT, 'app');
const cacheDir = await mkdtemp(join(tmpdir(), 'cheoma-app-smoke-'));
const timeout = Number(process.env.CHEOMA_APP_SMOKE_TIMEOUT_MS) || 90_000;
const failures = [];
const pass = (condition, message) => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${message}`);
  if (!condition) failures.push(message);
};

const server = await createServer({
  root: APP_ROOT,
  configFile: join(APP_ROOT, 'vite.config.js'),
  cacheDir,
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false },
});

let browser;
let runtimeErrors = [];
try {
  await server.listen();
  const port = server.httpServer.address().port;
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  runtimeErrors = [];
  page.on('pageerror', (error) => runtimeErrors.push(`page: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' && !/favicon|404/i.test(message.text())) {
      runtimeErrors.push(`console: ${message.text()}`);
    }
  });

  const url = `http://127.0.0.1:${port}/?hero=0&village=1&worker=0&seed=42&vseed=20260716&time=day`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
  await page.waitForFunction(() => window.__SHOT_READY === true && !!window.__engine, null, { timeout });
  await page.waitForFunction(() => !!window.__engine.village.debugPlan(), null, { timeout });

  const boot = await page.evaluate(() => {
    const engine = window.__engine;
    return {
      state: engine.getState(),
      village: engine.village.getState(),
      plan: engine.village.debugPlan(),
      continuum: engine.village.debugContinuum(),
      camera: engine.village.debugCamera(),
      sceneChildren: engine.scene.children.length,
      canvas: {
        width: engine.renderer.domElement.width,
        height: engine.renderer.domElement.height,
      },
    };
  });
  pass(boot.village.active, 'village mode becomes active');
  pass(boot.plan.seed === 20260716 && boot.plan.scale === 'village', 'URL seed and scale reach the planner');
  pass(boot.plan.houses > 0 && boot.sceneChildren > 0, 'village scene contains planned houses and scene objects');
  pass(boot.canvas.width > 0 && boot.canvas.height > 0, 'renderer owns a sized canvas');
  pass(
    boot.continuum.aerialDist > 0
      && boot.continuum.enterDist < boot.continuum.exitDist
      && Number.isFinite(boot.camera.near),
    'village camera exposes valid aerial, zoom, and near-plane contracts',
  );

  const fallbackContract = await page.evaluate(async ({ environmentModuleUrl, threeModuleUrl }) => {
    const [{ captureEnvironmentFallback, restoreEnvironmentFallback }, THREE] = await Promise.all([
      import(environmentModuleUrl),
      import(threeModuleUrl),
    ]);
    const scene = new THREE.Scene();
    const background = new THREE.Texture();
    const fog = new THREE.FogExp2(new THREE.Color().setRGB(0.12, 0.34, 0.56), 0.0123);
    scene.background = background;
    scene.fog = fog;
    const sun = new THREE.DirectionalLight();
    sun.position.set(2.5, 4.5, -7.5);
    sun.color.setRGB(0.17, 0.43, 0.81);
    sun.intensity = 2.37;
    const hemi = new THREE.HemisphereLight();
    hemi.color.setRGB(0.21, 0.38, 0.62);
    hemi.groundColor.setRGB(0.51, 0.27, 0.13);
    hemi.intensity = 0.73;
    const renderer = { toneMappingExposure: 1.17 };
    const original = {
      fogColor: fog.color.clone(), fogDensity: fog.density,
      sunPosition: sun.position.clone(), sunColor: sun.color.clone(), sunIntensity: sun.intensity,
      hemiSky: hemi.color.clone(), hemiGround: hemi.groundColor.clone(), hemiIntensity: hemi.intensity,
      exposure: renderer.toneMappingExposure,
    };
    const fallback = captureEnvironmentFallback(scene, { sun, hemi, renderer });
    scene.background = new THREE.Color(0xffffff);
    scene.fog = new THREE.Fog(0xffffff, 1, 2);
    fog.color.set(0); fog.density = 0.5;
    sun.position.set(0, 0, 0); sun.color.set(0); sun.intensity = 0;
    hemi.color.set(0); hemi.groundColor.set(0); hemi.intensity = 0;
    renderer.toneMappingExposure = 0;
    restoreEnvironmentFallback(scene, { sun, hemi, renderer }, fallback);
    const restored = scene.background === background
      && scene.fog === fog
      && scene.fog.isFogExp2
      && fog.color.equals(original.fogColor)
      && fog.density === original.fogDensity
      && sun.position.equals(original.sunPosition)
      && sun.color.equals(original.sunColor)
      && sun.intensity === original.sunIntensity
      && hemi.color.equals(original.hemiSky)
      && hemi.groundColor.equals(original.hemiGround)
      && hemi.intensity === original.hemiIntensity
      && renderer.toneMappingExposure === original.exposure;
    background.dispose();
    return restored;
  }, {
    environmentModuleUrl: `/@fs${join(ROOT, 'src/env/index.js')}`,
    threeModuleUrl: `/@fs${join(APP_ROOT, 'node_modules/three/build/three.module.js')}`,
  });
  pass(fallbackContract, 'environment fallback preserves Texture and FogExp2 identity, type, and exact light values');

  const cinematic = await page.evaluate(() => {
    const { cine } = window.__engine;
    const available = cine.available();
    const droneStarted = cine.start('drone', { pass: 'crane-in' });
    const drone = cine.getState();
    cine.stop();
    const droneStopped = cine.getState();
    const walkStarted = cine.start('walk');
    const walker = cine.debugWalker();
    cine.stop();
    return { available, droneStarted, drone, droneStopped, walkStarted, walker };
  });
  pass(
    cinematic.available && cinematic.droneStarted
      && cinematic.drone.active && cinematic.drone.pass === 'crane-in',
    'cinematic runtime starts a named drone path',
  );
  pass(!cinematic.droneStopped.active, 'cinematic runtime returns control after stop');
  pass(
    cinematic.walkStarted && cinematic.walker
      && Number.isFinite(cinematic.walker.clearance),
    'walk runtime initializes with finite terrain clearance',
  );

  const postOrder = await page.evaluate(() => window.__engine.debugPostPassOrder());
  pass(
    JSON.stringify(postOrder) === JSON.stringify([
      'RenderPass', 'GradePass', 'UnrealBloomPass', 'BokehPass',
      'FlarePass', 'OutlinePass', 'OutputPass',
    ]),
    `post passes preserve the output-last contract (${postOrder.join(' → ')})`,
  );

  const postResolution = await page.evaluate(() => {
    const engine = window.__engine;
    const renderer = engine.renderer;
    const previousRatio = renderer.getPixelRatio();
    const width = renderer.domElement.clientWidth;
    const height = renderer.domElement.clientHeight;
    let state;
    try {
      renderer.setPixelRatio(1.5);
      engine.resize();
      state = engine.debugPostResolution();
    } finally {
      renderer.setPixelRatio(previousRatio);
      engine.resize();
    }
    return {
      ...state,
      expectedWidth: Math.round(width * 1.5),
      expectedHeight: Math.round(height * 1.5),
    };
  });
  pass(
    postResolution.composer.width === postResolution.expectedWidth
      && postResolution.composer.height === postResolution.expectedHeight
      && postResolution.outline.width === postResolution.expectedWidth
      && postResolution.outline.height === postResolution.expectedHeight,
    `composer and outline follow renderer DPR (${postResolution.expectedWidth}×${postResolution.expectedHeight})`,
  );

  const heroId = await page.evaluate(() => window.__engine.village.heroId());
  pass(typeof heroId === 'string' && heroId.length > 0, 'hero parcel is addressable through the app API');
  const focused = await page.evaluate(() => {
    const engine = window.__engine;
    engine.setTime('night');
    engine.setSeason('autumn');
    engine.setWeather('clear');
    const parcelId = engine.village.heroId();
    engine.village.focus(parcelId);
    const state = engine.village.getState();
    return { selected: state.selected, spec: state.spec, overlay: engine.village.debugOverlayBox(state.selected) };
  });
  // Headless ANGLE may produce fewer than one frame per second while linking shaders, so this
  // fast smoke asserts synchronous focus setup rather than wall-clock tween completion.
  pass(focused.selected === heroId && !!focused.spec, 'focus setup targets the requested parcel');
  pass(!!focused.overlay, 'focused parcel exposes a measurable detail overlay');

  const typeChange = await page.evaluate(() => {
    window.__engine.setType('choga');
    return window.__engine.getState().preset;
  });
  pass(typeChange === 'choga', 'setType uses the shared building framing path without a runtime error');

  const expansionContract = await page.evaluate(async () => {
    const { ghostSpec, nextWingPlacement } = await import('/src/engine/expansion.js');
    const params = window.__engine.getParams();
    const samePlacement = [2, 3].every((target) => {
      const ghost = ghostSpec(params, target);
      const placement = nextWingPlacement(params, target);
      return !!ghost && !!placement
        && ghost.pStart.equals(placement.pStart)
        && ghost.size.W === placement.size.W
        && ghost.size.D === placement.size.D
        && ghost.size.H === placement.size.H;
    });
    const originalRandom = Math.random;
    const originalCreateElement = document.createElement;
    let randomCalls = 0;
    let canvasCalls = 0;
    Math.random = () => { randomCalls++; return 0.5; };
    document.createElement = function(tagName, options) {
      if (String(tagName).toLowerCase() === 'canvas') canvasCalls++;
      return originalCreateElement.call(this, tagName, options);
    };
    try { ghostSpec(params, 2); } finally {
      Math.random = originalRandom;
      document.createElement = originalCreateElement;
    }
    return {
      samePlacement,
      invalidRanges: ghostSpec(params, 1) === null && ghostSpec(params, 4) === null,
      randomCalls,
      canvasCalls,
    };
  });
  pass(
    expansionContract.samePlacement
      && expansionContract.invalidRanges
      && expansionContract.randomCalls === 0
      && expansionContract.canvasCalls === 0,
    `wing ghost shares pure placement without hidden generation (random ${expansionContract.randomCalls}, canvas ${expansionContract.canvasCalls})`,
  );

  const buildingApiUrl = `/@fs${join(ROOT, 'src/api/building.js')}`;
  const resourceApiUrl = `/@fs${join(ROOT, 'src/core/three-resources.js')}`;
  const lifecycleContract = await page.evaluate(async ({ buildingModuleUrl, resourceModuleUrl }) => {
    const { PRESETS, buildBuilding, disposeBuilding } = await import(buildingModuleUrl);
    const { isSharedResource } = await import(resourceModuleUrl);
    const owner = buildBuilding({ ...PRESETS.choga });
    const sharedMats = owner.userData.materials;
    const borrower = buildBuilding({ ...PRESETS.choga, mats: sharedMats });
    const sharedResources = new Set();
    for (const value of Object.values(sharedMats)) {
      if (value?.isMaterial) {
        sharedResources.add(value);
        for (const property of Object.values(value)) {
          if (property?.isTexture) sharedResources.add(property);
        }
      } else if (value?.isTexture) sharedResources.add(value);
    }
    const ownedResources = new Set();
    const moduleSharedResources = new Set();
    const addOwnedTexture = (texture) => {
      if (!texture || sharedResources.has(texture)) return;
      (isSharedResource(texture) ? moduleSharedResources : ownedResources).add(texture);
    };
    const addOwnedMaterial = (material) => {
      if (!material || sharedResources.has(material)) return;
      if (isSharedResource(material)) moduleSharedResources.add(material);
      else ownedResources.add(material);
      for (const value of Object.values(material)) {
        if (value?.isTexture) addOwnedTexture(value);
      }
      for (const uniform of Object.values(material.uniforms || {})) {
        const value = uniform?.value;
        if (value?.isTexture) addOwnedTexture(value);
        else if (Array.isArray(value)) {
          for (const item of value) if (item?.isTexture) addOwnedTexture(item);
        }
      }
    };
    borrower.traverse((object) => {
      if (object.geometry?.dispose) {
        (isSharedResource(object.geometry) ? moduleSharedResources : ownedResources).add(object.geometry);
      }
      const objectMaterials = Array.isArray(object.material)
        ? object.material
        : (object.material ? [object.material] : []);
      for (const material of objectMaterials) addOwnedMaterial(material);
    });
    let sharedDisposeEvents = 0;
    let moduleSharedDisposeEvents = 0;
    const ownedDisposeCounts = new Map();
    const onDispose = () => { sharedDisposeEvents++; };
    const onModuleSharedDispose = () => { moduleSharedDisposeEvents++; };
    const onOwnedDispose = (event) => ownedDisposeCounts.set(
      event.target, (ownedDisposeCounts.get(event.target) || 0) + 1,
    );
    for (const resource of sharedResources) resource.addEventListener('dispose', onDispose);
    for (const resource of moduleSharedResources) resource.addEventListener('dispose', onModuleSharedDispose);
    for (const resource of ownedResources) resource.addEventListener('dispose', onOwnedDispose);
    const borrowerFirst = disposeBuilding(borrower);
    const afterBorrower = sharedDisposeEvents;
    const borrowerSecond = disposeBuilding(borrower);
    const afterDuplicate = sharedDisposeEvents;
    const ownerFirst = disposeBuilding(owner);
    const afterOwner = sharedDisposeEvents;
    for (const resource of sharedResources) resource.removeEventListener('dispose', onDispose);
    for (const resource of moduleSharedResources) resource.removeEventListener('dispose', onModuleSharedDispose);
    for (const resource of ownedResources) resource.removeEventListener('dispose', onOwnedDispose);
    return {
      borrowerFirst,
      borrowerSecond,
      ownerFirst,
      afterBorrower,
      afterDuplicate,
      afterOwner,
      sharedCount: sharedResources.size,
      moduleSharedCount: moduleSharedResources.size,
      moduleSharedDisposeEvents,
      ownedCount: ownedResources.size,
      ownedDisposed: ownedDisposeCounts.size,
      ownedDuplicates: [...ownedDisposeCounts.values()].filter((count) => count !== 1).length,
    };
  }, { buildingModuleUrl: buildingApiUrl, resourceModuleUrl: resourceApiUrl });
  pass(
    lifecycleContract.borrowerFirst
      && !lifecycleContract.borrowerSecond
      && lifecycleContract.ownerFirst
      && lifecycleContract.afterBorrower === 0
      && lifecycleContract.afterDuplicate === 0
      && lifecycleContract.afterOwner === lifecycleContract.sharedCount
      && lifecycleContract.moduleSharedDisposeEvents === 0
      && lifecycleContract.ownedDisposed === lifecycleContract.ownedCount
      && lifecycleContract.ownedDuplicates === 0,
    `building lifecycle preserves ${lifecycleContract.sharedCount} injected + ${lifecycleContract.moduleSharedCount} module-shared resources and releases ${lifecycleContract.ownedDisposed}/${lifecycleContract.ownedCount} owned resources exactly once`,
  );

  const texturePlateau = await page.evaluate(() => {
    const engine = window.__engine;
    engine.village.exit();
    engine.setType('choga');
    // setType의 조립 초반에는 아직 숨은 재질이 있어 첫 렌더가 전체 텍스처를 업로드하지 않는다.
    // 완성 상태 1회를 워밍한 뒤, 같은 완성 상태의 교체들만 steady-state로 비교한다.
    engine.__debugFreezeRebuild(1);
    engine.renderer.render(engine.scene, engine.camera);
    const samples = [engine.renderer.info.memory.textures];
    for (let i = 0; i < 6; i++) {
      engine.__debugFreezeRebuild(1);
      engine.renderer.render(engine.scene, engine.camera);
      samples.push(engine.renderer.info.memory.textures);
    }
    return { samples, stable: samples.every((count) => count === samples[0]) };
  });
  pass(
    texturePlateau.stable && texturePlateau.samples[0] > 0,
    `repeated visible building rebuilds keep GPU textures flat (${texturePlateau.samples.join(' → ')})`,
  );

  const teardown = await page.evaluate(() => {
    const engine = window.__engine;
    const canvas = engine.renderer.domElement;
    const environment = engine.scene.getObjectByName('environment');
    const geometries = new Set();
    const materials = new Set();
    const textures = new Set();
    const addTextures = (material) => {
      for (const value of Object.values(material || {})) if (value?.isTexture) textures.add(value);
      for (const uniform of Object.values(material?.uniforms || {})) {
        const value = uniform?.value;
        if (value?.isTexture) textures.add(value);
        else if (Array.isArray(value)) for (const item of value) if (item?.isTexture) textures.add(item);
      }
    };
    environment?.traverse((object) => {
      if (object.geometry?.dispose) geometries.add(object.geometry);
      const objectMaterials = Array.isArray(object.material)
        ? object.material
        : (object.material ? [object.material] : []);
      for (const material of objectMaterials) {
        materials.add(material);
        addTextures(material);
      }
    });
    const disposedGeometries = new Set();
    const disposedMaterials = new Set();
    const disposedTextures = new Set();
    const disposeCounts = new Map();
    const recordDispose = (target) => disposeCounts.set(target, (disposeCounts.get(target) || 0) + 1);
    const onGeometryDispose = (event) => { disposedGeometries.add(event.target); recordDispose(event.target); };
    const onMaterialDispose = (event) => { disposedMaterials.add(event.target); recordDispose(event.target); };
    const onTextureDispose = (event) => { disposedTextures.add(event.target); recordDispose(event.target); };
    for (const resource of geometries) resource.addEventListener('dispose', onGeometryDispose);
    for (const resource of materials) resource.addEventListener('dispose', onMaterialDispose);
    for (const resource of textures) resource.addEventListener('dispose', onTextureDispose);
    engine.dispose();
    engine.dispose();
    return {
      canvasConnected: canvas.isConnected,
      canvasCount: document.querySelectorAll('canvas').length,
      environmentConnected: !!environment?.parent,
      environmentResources: {
        geometries: [disposedGeometries.size, geometries.size],
        materials: [disposedMaterials.size, materials.size],
        textures: [disposedTextures.size, textures.size],
      },
      duplicateDisposals: [...disposeCounts.values()].filter((count) => count !== 1).length,
      hooks: ['__engine', '__viewshift', '__hero', '__asm', '__wx', '__rim', '__flare', '__season']
        .filter((name) => name in window),
    };
  });
  await page.waitForTimeout(100);
  pass(!teardown.canvasConnected && teardown.canvasCount === 0, 'engine.dispose removes the renderer canvas');
  pass(
    !teardown.environmentConnected
      && Object.values(teardown.environmentResources).every(([disposedCount, ownedCount]) => (
        ownedCount > 0 && disposedCount === ownedCount
      ))
      && teardown.duplicateDisposals === 0,
    `engine.dispose releases each environment resource exactly once (${JSON.stringify(teardown.environmentResources)}, duplicates ${teardown.duplicateDisposals})`,
  );
  pass(teardown.hooks.length === 0, `engine.dispose removes owned debug hooks (${teardown.hooks.join(', ') || 'none'})`);
  pass(runtimeErrors.length === 0, `browser reports no runtime errors (${runtimeErrors.length})`);
  if (runtimeErrors.length) console.log(runtimeErrors.slice(0, 5).join('\n'));

  await page.close();
} catch (error) {
  failures.push(error.message);
  console.error(error.stack || error);
  if (runtimeErrors.length) console.error(runtimeErrors.slice(0, 10).join('\n'));
} finally {
  await browser?.close();
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
}

console.log(failures.length ? `\nAPP SMOKE: ${failures.length} FAIL` : '\nAPP SMOKE: PASS');
process.exit(failures.length ? 1 : 0);
