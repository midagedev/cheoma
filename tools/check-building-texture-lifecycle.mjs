// Isolated WebGL contract for the public building API's shadow-texture lifecycle.
// Runs without Svelte, village generation, post-processing, or another app boot.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { launchVerificationBrowser, reportWebGLRenderer } from './lib/verification-browser.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const THREE_ROOT = resolve(ROOT, 'app/node_modules/three');
const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
};
const HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <script type="importmap">
      {
        "imports": {
          "three": "/@three/build/three.module.js",
          "three/addons/": "/@three/examples/jsm/"
        }
      }
    </script>
  </head>
  <body></body>
</html>`;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function safeFile(root, relativePath) {
  const file = resolve(root, relativePath);
  if (file !== root && !file.startsWith(`${root}${sep}`)) throw new Error('unsafe path');
  return file;
}

const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    if (pathname === '/') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(HTML);
      return;
    }
    if (pathname === '/favicon.ico') {
      response.writeHead(204);
      response.end();
      return;
    }
    const three = pathname.startsWith('/@three/');
    const relativePath = pathname.slice(three ? '/@three/'.length : 1);
    const file = safeFile(three ? THREE_ROOT : ROOT, relativePath);
    const body = await readFile(file);
    response.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    response.end(body);
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('not found');
  }
});
await new Promise((resolveListen, reject) => {
  server.listen(0, '127.0.0.1', resolveListen).on('error', reject);
});

const browser = await launchVerificationBrowser();
const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
const errors = [];
page.on('pageerror', (error) => errors.push(`page: ${error.message}`));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(`console: ${message.text()}`);
});

try {
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load' });
  const result = await page.evaluate(async () => {
    const [
      THREE,
      { PRESETS, buildBuilding, disposeBuilding },
      { attachShadowDepthTextureLifecycle },
      {
        attachLodScreenDoorRoot,
        hasLodScreenDoor,
        hasLodScreenDoorMaterial,
        patchLodScreenDoorMaterial,
      },
    ] = await Promise.all([
      import('three'),
      import('/src/api/building.js'),
      import('/src/render/shadow-depth-texture-lifecycle.js'),
      import('/src/render/lod-screen-door.js'),
    ]);

    const renderer = new THREE.WebGLRenderer({ antialias: false });
    document.body.appendChild(renderer.domElement);
    renderer.setPixelRatio(1);
    renderer.setSize(384, 256, false);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(34, 384 / 256, 0.1, 200);
    camera.position.set(20, 16, 24);
    camera.lookAt(0, 3, 0);
    const hemi = new THREE.HemisphereLight(0xffffff, 0x554433, 1.2);
    const sun = new THREE.DirectionalLight(0xffffff, 3);
    sun.position.set(18, 28, 16);
    sun.castShadow = true;
    sun.shadow.mapSize.set(256, 256);
    Object.assign(sun.shadow.camera, {
      left: -22, right: 22, top: 22, bottom: -22, near: 1, far: 90,
    });
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(60, 60),
      new THREE.MeshStandardMaterial({ color: 0xb0a894 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(hemi, sun, ground);

    function setShadows(root) {
      root.traverse((object) => {
        if (!object.isMesh && !object.isInstancedMesh) return;
        object.castShadow = true;
        object.receiveShadow = true;
      });
    }

    function texturesOf(root) {
      const textures = new Set();
      const add = (material) => {
        for (const value of Object.values(material || {})) {
          if (value?.isTexture) textures.add(value);
        }
      };
      root.traverse((object) => {
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) add(material);
      });
      for (const value of Object.values(root.userData.materials || {})) {
        if (value?.isTexture) textures.add(value);
        else if (value?.isMaterial) add(value);
      }
      return [...textures];
    }

    let current = null;
    let currentTextures = [];
    const disposedTextures = [];
    const textureDisposeCounts = new Map();
    const watchedTextures = new Set();
    function watchOwnedTextures(textures) {
      for (const texture of textures) {
        if (watchedTextures.has(texture)) continue;
        watchedTextures.add(texture);
        texture.addEventListener('dispose', () => {
          textureDisposeCounts.set(texture, (textureDisposeCounts.get(texture) || 0) + 1);
        });
      }
    }

    function runPublicRebuilds(preset) {
      const samples = [];
      current = null;
      currentTextures = [];
      for (let index = 0; index < 6; index++) {
        const next = buildBuilding({ ...preset });
        setShadows(next);
        scene.add(next);
        if (current) {
          scene.remove(current);
          watchOwnedTextures(currentTextures);
          disposeBuilding(current);
          disposedTextures.push(...currentTextures);
        }
        current = next;
        currentTextures = texturesOf(current);
        renderer.render(scene, camera);
        samples.push({
          textures: renderer.info.memory.textures,
          geometries: renderer.info.memory.geometries,
          calls: renderer.info.render.calls,
          triangles: renderer.info.render.triangles,
          staleRegistered:
            disposedTextures.filter((texture) => renderer.properties.has(texture)).length,
        });
      }
      scene.remove(current);
      watchOwnedTextures(currentTextures);
      disposeBuilding(current);
      disposedTextures.push(...currentTextures);
      return samples;
    }

    const giwaSamples = runPublicRebuilds(PRESETS.giwa);
    const chogaSamples = runPublicRebuilds(PRESETS.choga);
    const priorDisposeCounts = [...watchedTextures]
      .map((texture) => textureDisposeCounts.get(texture) || 0);

    function paletteResources(palette) {
      const materials = new Set();
      const textures = new Set();
      const textureSlots = [];
      for (const value of Object.values(palette || {})) {
        if (value?.isTexture) textures.add(value);
        if (!value?.isMaterial) continue;
        materials.add(value);
        for (const [key, property] of Object.entries(value)) {
          if (!property?.isTexture) continue;
          textures.add(property);
          textureSlots.push({ material: value, key, texture: property });
        }
      }
      return { materials: [...materials], textures: [...textures], textureSlots };
    }

    // A caller-owned palette is a separate lifetime. Disposing a borrower must release
    // only builder-derived resources, while disposing the original owner still releases
    // each palette resource exactly once.
    const paletteOwner = buildBuilding({ ...PRESETS.giwa });
    const sharedPalette = paletteOwner.userData.materials;
    const shared = paletteResources(sharedPalette);
    const sharedMaterialDisposes = new Map();
    const sharedTextureDisposes = new Map();
    for (const material of shared.materials) {
      material.addEventListener('dispose', () => {
        sharedMaterialDisposes.set(
          material, (sharedMaterialDisposes.get(material) || 0) + 1,
        );
      });
    }
    for (const texture of shared.textures) {
      texture.addEventListener('dispose', () => {
        sharedTextureDisposes.set(texture, (sharedTextureDisposes.get(texture) || 0) + 1);
      });
    }
    const paletteBorrower = buildBuilding({ ...PRESETS.giwa, mats: sharedPalette });
    setShadows(paletteOwner);
    setShadows(paletteBorrower);
    paletteOwner.position.x = -8;
    paletteBorrower.position.x = 8;
    scene.add(paletteOwner, paletteBorrower);
    renderer.render(scene, camera);
    scene.remove(paletteBorrower);
    const borrowerDisposed = disposeBuilding(paletteBorrower);
    const borrowerDisposedAgain = disposeBuilding(paletteBorrower);
    const sharedAfterBorrower = {
      materials: shared.materials.map((material) => sharedMaterialDisposes.get(material) || 0),
      textures: shared.textures.map((texture) => sharedTextureDisposes.get(texture) || 0),
      mapsIntact: shared.textureSlots.every(
        ({ material, key, texture }) => material[key] === texture,
      ),
    };
    renderer.render(scene, camera);
    scene.remove(paletteOwner);
    const ownerDisposed = disposeBuilding(paletteOwner);
    const sharedAfterOwner = {
      materials: shared.materials.map((material) => sharedMaterialDisposes.get(material) || 0),
      textures: shared.textures.map((texture) => sharedTextureDisposes.get(texture) || 0),
    };

    const point = new THREE.PointLight(0xffffff, 0.1);
    point.position.set(0, 12, 6);
    point.castShadow = true;
    point.shadow.mapSize.set(64, 64);
    point.shadow.camera.near = 1;
    point.shadow.camera.far = 45;
    scene.add(point);

    function makeSilhouetteCase({
      x,
      alphaTest = 0,
      alphaHash = false,
      custom = 'stock',
      lifecycleFirst = true,
    }) {
      const data = new Uint8Array([
        255, 255, 255, 255, 255, 255, 255, 0,
        255, 255, 255, 0, 255, 255, 255, 255,
      ]);
      const texture = new THREE.DataTexture(data, 2, 2);
      texture.needsUpdate = true;
      const material = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        map: texture,
        alphaMap: texture,
        alphaTest,
        side: THREE.DoubleSide,
      });
      material.alphaHash = alphaHash;
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(3, 3), material);
      mesh.position.set(x, 3, 0);
      mesh.castShadow = true;
      let priorHookCalls = 0;
      mesh.onBeforeShadow = () => { priorHookCalls++; };
      const root = new THREE.Group();
      root.add(mesh);
      if (lifecycleFirst) attachShadowDepthTextureLifecycle(root);

      let depth = null;
      let distance = null;
      let channel = null;
      if (custom !== 'stock') {
        depth = new THREE.MeshDepthMaterial({
          map: texture,
          alphaMap: texture,
          alphaTest,
          side: THREE.DoubleSide,
        });
        distance = new THREE.MeshDistanceMaterial({
          map: texture,
          alphaMap: texture,
          alphaTest,
          side: THREE.DoubleSide,
        });
        if (custom === 'lod') {
          patchLodScreenDoorMaterial(depth);
          patchLodScreenDoorMaterial(distance);
          channel = attachLodScreenDoorRoot(root, { depth, distance });
          channel.set(0.37);
        } else {
          mesh.customDepthMaterial = depth;
          mesh.customDistanceMaterial = distance;
        }
      }
      if (!lifecycleFirst) attachShadowDepthTextureLifecycle(root);
      const lifecycleHook = mesh.onBeforeShadow;
      attachShadowDepthTextureLifecycle(root);
      const lifecycleIdempotent = mesh.onBeforeShadow === lifecycleHook;

      const chained = mesh.onBeforeShadow;
      const observations = [];
      mesh.onBeforeShadow = function observeShadow(...args) {
        chained.apply(this, args);
        const depthMaterial = args[5];
        observations.push({
          kind: depthMaterial.isMeshDistanceMaterial ? 'distance' : 'depth',
          map: depthMaterial.map === texture,
          alphaMap: depthMaterial.alphaMap === texture,
          alphaTest: depthMaterial.alphaTest,
          alphaHash: depthMaterial.alphaHash,
          matrixW: this.matrixWorld.elements[15],
        });
      };
      scene.add(root);
      return {
        root, mesh, material, depth, distance, texture, channel, observations, custom,
        lifecycleIdempotent,
        priorHookCalls: () => priorHookCalls,
      };
    }

    const stockOpaque = makeSilhouetteCase({ x: -12 });
    const stockTested = makeSilhouetteCase({ x: -7, alphaTest: 0.5 });
    const stockHashed = makeSilhouetteCase({ x: -2, alphaHash: true });
    const authored = makeSilhouetteCase({ x: 3, custom: 'authored' });
    const lodOpaque = makeSilhouetteCase({ x: 8, custom: 'lod' });
    const lodTested = makeSilhouetteCase({
      x: 13,
      alphaTest: 0.5,
      custom: 'lod',
      lifecycleFirst: false,
    });
    renderer.render(scene, camera);

    const fixtures = [
      stockOpaque, stockTested, stockHashed, authored, lodOpaque, lodTested,
    ];
    const shadowHooks = fixtures.map((fixture) => {
      const observations = Object.fromEntries(['depth', 'distance'].map((kind) => [
        kind,
        fixture.observations.filter((entry) => entry.kind === kind).at(-1) || null,
      ]));
      return {
        custom: fixture.custom,
        observations,
        priorHookCalls: fixture.priorHookCalls(),
        lodAttached: hasLodScreenDoor(fixture.mesh),
        sourcePatched: hasLodScreenDoorMaterial(fixture.material),
        depthPatched: fixture.depth ? hasLodScreenDoorMaterial(fixture.depth) : false,
        distancePatched:
          fixture.distance ? hasLodScreenDoorMaterial(fixture.distance) : false,
        lifecycleIdempotent: fixture.lifecycleIdempotent,
        restoredMatrixW: fixture.mesh.matrixWorld.elements[15],
      };
    });

    for (const fixture of fixtures) {
      scene.remove(fixture.root);
      fixture.mesh.geometry.dispose();
      fixture.material.dispose();
      fixture.depth?.dispose();
      fixture.distance?.dispose();
      fixture.texture.dispose();
    }
    ground.geometry.dispose();
    ground.material.dispose();
    sun.shadow.map?.dispose();
    point.shadow.map?.dispose();
    renderer.dispose();

    return {
      revision: THREE.REVISION,
      giwaSamples,
      chogaSamples,
      priorDisposeCounts,
      finalDisposeCounts: [...watchedTextures]
        .map((texture) => textureDisposeCounts.get(texture) || 0),
      watchedTextureCount: watchedTextures.size,
      borrowerDisposed,
      borrowerDisposedAgain,
      ownerDisposed,
      sharedAfterBorrower,
      sharedAfterOwner,
      shadowHooks,
    };
  });

  invariant(result.revision === '185', `unexpected THREE.REVISION ${result.revision}`);
  function assertPlateau(label, samples) {
    for (const key of ['textures', 'geometries', 'calls', 'triangles']) {
      invariant(samples.every((sample) => sample[key] === samples[0][key]),
        `${label} rebuild ${key} did not plateau: ${samples.map((sample) => sample[key]).join(' → ')}`);
    }
    invariant(samples.every((sample) => sample.staleRegistered === 0),
      `${label} disposed textures were re-registered: ${samples.map((sample) => sample.staleRegistered).join(' → ')}`);
  }
  assertPlateau('public giwa', result.giwaSamples);
  assertPlateau('public choga', result.chogaSamples);
  invariant(result.watchedTextureCount > 0
      && result.priorDisposeCounts.length === result.watchedTextureCount
      && result.finalDisposeCounts.length === result.watchedTextureCount
      && result.priorDisposeCounts.every((count) => count === 1)
      && result.finalDisposeCounts.every((count) => count === 1),
  `owned textures were not disposed exactly once: ${JSON.stringify(result.finalDisposeCounts)}`);

  invariant(result.borrowerDisposed && !result.borrowerDisposedAgain && result.ownerDisposed,
    'shared P.mats owner/borrower disposal was not idempotent');
  invariant(result.sharedAfterBorrower.materials.every((count) => count === 0)
      && result.sharedAfterBorrower.textures.every((count) => count === 0)
      && result.sharedAfterBorrower.mapsIntact,
  `borrower disposed caller-owned P.mats: ${JSON.stringify(result.sharedAfterBorrower)}`);
  invariant(result.sharedAfterOwner.materials.every((count) => count === 1)
      && result.sharedAfterOwner.textures.every((count) => count === 1),
  `P.mats owner did not dispose shared resources exactly once: ${JSON.stringify(result.sharedAfterOwner)}`);

  const [
    stockOpaque, stockTested, stockHashed, authored, lodOpaque, lodTested,
  ] = result.shadowHooks;
  const both = (hook, predicate) => ['depth', 'distance']
    .every((kind) => predicate(hook.observations[kind]));
  invariant(stockOpaque.priorHookCalls > 0
      && both(stockOpaque, (observation) => observation?.map === false
        && observation.alphaMap === false),
  `stock opaque shadow maps were retained or prior hook was replaced: ${JSON.stringify(stockOpaque)}`);
  invariant(stockTested.priorHookCalls > 0
      && both(stockTested, (observation) => observation?.map === true
        && observation.alphaMap === true
        && observation.alphaTest === 0.5),
  `alphaTest shadow silhouette was lost: ${JSON.stringify(stockTested)}`);
  invariant(stockHashed.priorHookCalls > 0
      && both(stockHashed, (observation) => observation?.map === false
        && observation.alphaMap === false
        && observation.alphaHash === false),
  `source alphaHash incorrectly retained a shared stock shadow map: ${JSON.stringify(stockHashed)}`);
  invariant(authored.priorHookCalls > 0
      && both(authored, (observation) => observation?.map === true
        && observation.alphaMap === true),
  `authored custom depth/distance maps were scrubbed: ${JSON.stringify(authored)}`);
  invariant(lodOpaque.priorHookCalls > 0
      && both(lodOpaque, (observation) => observation?.map === true
        && observation.alphaMap === true),
  `LOD custom shadow maps were scrubbed: ${JSON.stringify(lodOpaque)}`);
  invariant(lodTested.priorHookCalls > 0
      && both(lodTested, (observation) => observation?.map === true
        && observation.alphaMap === true
        && observation.alphaTest === 0.5),
  `Cheoma LOD alphaTest shadow silhouette was lost: ${JSON.stringify(lodTested)}`);
  for (const hook of result.shadowHooks) {
    invariant(hook.lifecycleIdempotent,
      `shadow lifecycle hook was installed twice: ${JSON.stringify(hook)}`);
  }
  for (const hook of [lodOpaque, lodTested]) {
    invariant(hook.lodAttached && hook.sourcePatched
        && hook.depthPatched && hook.distancePatched,
    `LOD screen-door material hook was replaced: ${JSON.stringify(hook)}`);
    invariant(both(hook, (observation) => Math.abs(observation?.matrixW - 0.37) < 1e-6)
        && Math.abs(hook.restoredMatrixW - 1) < 1e-6,
    `LOD shadow channel was not applied/restored: ${JSON.stringify(hook)}`);
  }
  invariant(errors.length === 0, `browser errors: ${errors.join(' | ')}`);
  await reportWebGLRenderer(page, 'building-texture-lifecycle');
  console.log(
    `BUILDING TEXTURE LIFECYCLE: PASS (r${result.revision}, textures `
      + `giwa ${result.giwaSamples.map((sample) => sample.textures).join(' → ')}, `
      + `choga ${result.chogaSamples.map((sample) => sample.textures).join(' → ')}, `
      + 'hooks composed)',
  );
} finally {
  await browser.close();
  await new Promise((resolveClose) => server.close(resolveClose));
}
