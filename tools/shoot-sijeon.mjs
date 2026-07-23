// Deterministic #128 sijeon renderer proof.
//
// Renders the pure placement/facade plan through the dedicated low-draw Three
// renderer at street, oblique, and row-overview scales. PBR day/sunset and the real
// ink composer share the same geometry. Captures always default to an OS scratch
// directory; set CHEOMA_SIJEON_OUT to retain them elsewhere.
//
// Usage:
//   node tools/run-browser-locked.mjs -- node tools/shoot-sijeon.mjs [filter]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import {
  launchVerificationBrowser,
  reportWebGLRenderer,
} from './lib/verification-browser.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = process.env.CHEOMA_SIJEON_OUT
  ? resolve(process.env.CHEOMA_SIJEON_OUT)
  : mkdtempSync(join(tmpdir(), 'cheoma-sijeon-'));
const filter = process.argv.slice(2).find((arg) => !arg.startsWith('--')) || '';
mkdirSync(OUT, { recursive: true });

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
};

const HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    html, body, #app { width: 100%; height: 100%; margin: 0; overflow: hidden; }
    body { background: #cfd8de; }
    canvas { display: block; }
  </style>
  <script type="importmap">
    {"imports":{
      "three":"/app/node_modules/three/build/three.module.js",
      "three/addons/":"/app/node_modules/three/examples/jsm/"
    }}
  </script>
</head>
<body>
<div id="app"></div>
<script type="module">
import * as THREE from 'three';
import { setupInk } from '/src/render/ink.js';
import { createFresnelRim } from '/src/env/rim.js';
import { createVillageSnowController } from '/src/runtime/village/snow.js';
import { planSijeon } from '/src/api/sijeon-plan.js';
import { createRerollWave } from '/src/village/wave.js';
import {
  buildSijeon,
  disposeSijeon,
} from '/src/api/sijeon.js';

const query = new URLSearchParams(location.search);
const view = query.get('view') || 'street';
const time = query.get('time') || 'day';
const mode = query.get('mode') || 'pbr';

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = time === 'sunset' ? 1.02 : 1.08;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.getElementById('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
const lighting = time === 'sunset'
  ? {
      background: 0xe6af80,
      fog: 0xd5a57d,
      sunColor: 0xffae68,
      sunIntensity: 3.2,
      sunPosition: [-42, 24, 34],
      hemiSky: 0xe3b893,
      hemiGround: 0x635344,
      hemiIntensity: 0.72,
    }
  : {
      background: 0xcfd9df,
      fog: 0xc8d2d7,
      sunColor: 0xffedcf,
      sunIntensity: 2.55,
      sunPosition: [34, 58, 45],
      hemiSky: 0xc6d9e6,
      hemiGround: 0x80745f,
      hemiIntensity: 1.15,
    };
scene.background = new THREE.Color(lighting.background);
scene.fog = new THREE.Fog(lighting.fog, 82, 190);

const semanticMaterial = (name, color, roughness, role, extra = {}) => {
  const material = new THREE.MeshStandardMaterial({
    color,
    roughness,
    metalness: 0,
    ...extra,
  });
  material.name = 'sijeon-' + name;
  material.userData.role = role;
  return material;
};
const materials = {
  frame: semanticMaterial('frame', 0x4b2e1d, 0.88, 'wood'),
  opening: semanticMaterial('opening', 0x241a14, 0.96, 'opening'),
  bench: semanticMaterial('bench', 0x765031, 0.9, 'wood'),
  storage: semanticMaterial('storage', 0xc8b995, 0.98, 'wall'),
  roof: semanticMaterial('roof', 0x3f454b, 0.91, 'roof'),
};
materials.roof.userData.snowSurface = true;

const placementSite = {
  center: { x: 0, z: 0 },
  bowlR: 100,
};
const roads = {
  roads: [{
    id: 'market-daero',
    level: 'daero',
    width: 10,
    pts: [{ x: -55, z: 0 }, { x: 55, z: 0 }],
  }],
};
const shops = planSijeon(roads, placementSite);
const heightAt = () => 0;

function geometryHash(root) {
  let hash = 2166136261 >>> 0;
  const floats = [];
  root.traverse((object) => {
    const position = object.geometry?.attributes?.position?.array;
    if (position) floats.push(position);
  });
  const scratch = new ArrayBuffer(4);
  const view = new DataView(scratch);
  for (const array of floats) {
    for (let index = 0; index < array.length; index++) {
      view.setFloat32(0, array[index], true);
      for (let byte = 0; byte < 4; byte++) {
        hash ^= view.getUint8(byte);
        hash = Math.imul(hash, 16777619) >>> 0;
      }
    }
  }
  return hash.toString(16).padStart(8, '0');
}

const sijeon = buildSijeon(shops, { materials, heightAt });
const repeated = buildSijeon(shops, { materials, heightAt });
const firstHash = geometryHash(sijeon);
const repeatHash = geometryHash(repeated);
if (firstHash !== repeatHash) throw new Error('sijeon geometry is not deterministic');

const materialDisposeCounts = new Map(Object.values(materials).map((material) => {
  const record = { count: 0 };
  material.addEventListener('dispose', () => { record.count++; });
  return [material, record];
}));
const repeatedGeometries = new Set();
repeated.traverse((object) => {
  if (object.geometry) repeatedGeometries.add(object.geometry);
});
const geometryDisposeCounts = new Map([...repeatedGeometries].map((geometry) => {
  const record = { count: 0 };
  geometry.addEventListener('dispose', () => { record.count++; });
  return [geometry, record];
}));
const firstDispose = disposeSijeon(repeated);
const secondDispose = disposeSijeon(repeated);
if (!firstDispose || secondDispose) throw new Error('sijeon dispose is not idempotent');
if ([...geometryDisposeCounts.values()].some((record) => record.count !== 1)) {
  throw new Error('sijeon did not dispose each owned geometry exactly once');
}
if ([...materialDisposeCounts.values()].some((record) => record.count !== 0)) {
  throw new Error('sijeon disposed caller-owned materials');
}

// The production wave classifies this exact semantic root as one group unit.
// Exercise a partial build, then require dispose() to restore the incoming
// renderer to its original affine/visibility state.
const outgoing = buildSijeon(shops.slice(0, 2), { materials, heightAt });
const oldWaveRoot = new THREE.Group();
const newWaveRoot = new THREE.Group();
oldWaveRoot.add(outgoing);
newWaveRoot.add(sijeon);
const wave = createRerollWave({
  oldRoot: oldWaveRoot,
  newRoot: newWaveRoot,
  center: placementSite.center,
  seed: 20260716,
});
// Global 0.59 maps the one group unit into u≈0.23–0.41 despite its
// deterministic ±0.025 jitter: visibly transformed, but before the u=0.5
// no-bounce settle boundary.
wave.seek(0.59);
const waveTouched = !sijeon.visible
  || sijeon.scale.distanceTo(new THREE.Vector3(1, 1, 1)) > 1e-6
  || sijeon.position.lengthSq() > 1e-12;
const waveAnimatedState = {
  visible: sijeon.visible,
  position: sijeon.position.toArray(),
  scale: sijeon.scale.toArray(),
};
wave.dispose();
const waveRestored = sijeon.visible
  && sijeon.position.lengthSq() < 1e-12
  && sijeon.scale.distanceTo(new THREE.Vector3(1, 1, 1)) < 1e-9;
newWaveRoot.remove(sijeon);
disposeSijeon(outgoing);
if (!waveTouched || !waveRestored) {
  throw new Error('sijeon wave transform did not animate and restore exactly: '
    + JSON.stringify({
      waveTouched,
      waveRestored,
      waveAnimatedState,
      visible: sijeon.visible,
      position: sijeon.position.toArray(),
      scale: sijeon.scale.toArray(),
    }));
}

// Patch the real product snow shader into the roof material, then clear it
// immediately so the visual fixtures stay day/sunset while still compiling the
// snow+rim chain on the rendered geometry.
const snow = createVillageSnowController(sijeon);
const snowPatchedCount = snow.inject(sijeon);
snow.setWeather('snow', { immediate: true, accum: 0.35 });
const snowPatched = materials.roof.userData.__snowPatched === true
  && materials.roof.userData.__snowProfile === 'tile';
snow.setWeather('clear', { immediate: true });
const snowCleared = sijeon.userData.getSnowInfo?.().value === 0;
if (snowPatchedCount !== 1 || !snowPatched || !snowCleared) {
  throw new Error('sijeon roof did not compose and clear the product snow shader');
}

scene.add(sijeon);

const groundMaterial = new THREE.MeshStandardMaterial({
  color: 0xab9d80,
  roughness: 1,
  metalness: 0,
});
const ground = new THREE.Mesh(new THREE.PlaneGeometry(150, 72), groundMaterial);
ground.name = 'market-ground';
ground.rotation.x = -Math.PI / 2;
ground.position.y = -0.035;
ground.receiveShadow = true;
scene.add(ground);

const roadMaterial = new THREE.MeshStandardMaterial({
  color: 0x8c795d,
  roughness: 1,
  metalness: 0,
});
const road = new THREE.Mesh(new THREE.PlaneGeometry(112, 10), roadMaterial);
road.name = 'market-road';
road.rotation.x = -Math.PI / 2;
road.position.y = -0.012;
road.receiveShadow = true;
scene.add(road);

const sun = new THREE.DirectionalLight(lighting.sunColor, lighting.sunIntensity);
sun.position.set(...lighting.sunPosition);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.bias = -0.00035;
sun.shadow.normalBias = 0.045;
sun.shadow.camera.left = -62;
sun.shadow.camera.right = 62;
sun.shadow.camera.top = 46;
sun.shadow.camera.bottom = -46;
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 180;
scene.add(sun, sun.target);
scene.add(new THREE.HemisphereLight(
  lighting.hemiSky,
  lighting.hemiGround,
  lighting.hemiIntensity,
));

const camera = new THREE.PerspectiveCamera(
  view === 'street' ? 37 : 43,
  innerWidth / innerHeight,
  0.1,
  300,
);
if (view === 'street') {
  camera.position.set(-27, 1.75, 0.65);
  camera.lookAt(8, 1.55, -10.3);
} else if (view === 'oblique') {
  // Stay above the daero centreline so both inward-facing rows remain legible;
  // a camera outside either row sees only the rear roof mass.
  camera.position.set(40, 11.5, 0);
  camera.lookAt(0, 1.8, 0);
} else {
  camera.position.set(0, 57, 57);
  camera.lookAt(0, 1.4, 0);
}
camera.updateMatrixWorld(true);

const rim = createFresnelRim(scene);
rim.apply(sijeon);
rim.setColor(new THREE.Color(0xffbd76));
rim.setStrength(time === 'sunset' ? 1.55 : 0.22);
rim.setNearFar(0, 190);

const ink = mode === 'ink'
  ? setupInk(renderer, scene, camera, {
      uniforms: {
        edgeStrength: 1.05,
        inkDensity: 0.94,
        washStrength: 0.72,
      },
    })
  : null;

const sijeonMeshes = [];
const sijeonMaterials = new Set();
const sijeonGeometries = new Set();
let sijeonTriangles = 0;
sijeon.traverse((object) => {
  if (!object.isMesh) return;
  sijeonMeshes.push(object);
  sijeonMaterials.add(object.material);
  sijeonGeometries.add(object.geometry);
  sijeonTriangles += object.geometry.index
    ? object.geometry.index.count / 3
    : object.geometry.attributes.position.count / 3;
});
const textureCount = [...sijeonMaterials].reduce((count, material) => (
  count + Object.values(material).filter((value) => value?.isTexture).length
), 0);
if (sijeon.name !== 'village-sijeon') throw new Error('wave semantic name drifted');
if (sijeonMeshes.length !== 5 || sijeonMaterials.size !== 5) {
  throw new Error('sijeon draw/material budget drifted');
}
if (textureCount !== 0) throw new Error('sijeon renderer introduced a texture');
if (sijeon.userData.sijeon?.materialOwnership !== 'caller'
    || sijeon.userData.sijeon?.geometryOwnership !== 'renderer') {
  throw new Error('sijeon ownership metadata is incomplete');
}
if (rim.coverage.building !== 4 || rim.coverage.total !== 4) {
  throw new Error('sijeon rim role coverage drifted');
}
if (!materials.roof.userData.__snowPatched) {
  throw new Error('sijeon roof lost its snow shader before render');
}

let frames = 0;
renderer.setAnimationLoop(() => {
  camera.updateMatrixWorld();
  const sunViewDirection = sun.position.clone().normalize()
    .transformDirection(camera.matrixWorldInverse);
  rim.setSunViewDir(sunViewDirection);
  if (ink) ink.composer.render();
  else renderer.render(scene, camera);
  frames++;
  if (frames === 12) {
    window.__SIJEON_AUDIT = {
      view,
      time,
      mode,
      shops: shops.length,
      geometryHash: firstHash,
      deterministic: firstHash === repeatHash,
      sijeon: {
        calls: sijeonMeshes.length,
        triangles: sijeonTriangles,
        rimPatchedMaterials: rim.coverage.total,
        resources: {
          geometries: sijeonGeometries.size,
          materials: sijeonMaterials.size,
          textures: textureCount,
        },
      },
      frame: {
        calls: renderer.info.render.calls,
        triangles: renderer.info.render.triangles,
        programs: renderer.info.programs?.length ?? 0,
        resources: { ...renderer.info.memory },
      },
      ownership: {
        firstDispose,
        secondDispose,
        geometryDisposeCounts: [...geometryDisposeCounts.values()].map((record) => record.count),
        materialDisposeCounts: [...materialDisposeCounts.values()].map((record) => record.count),
      },
      snow: {
        patched: snowPatched,
        patchedCount: snowPatchedCount,
        cleared: snowCleared,
        profile: materials.roof.userData.__snowProfile,
      },
      wave: {
        touched: waveTouched,
        restored: waveRestored,
      },
    };
    window.__SHOT_READY = true;
  }
});
</script>
</body>
</html>`;

const server = createServer(async (request, response) => {
  const pathname = request.url.split('?')[0];
  if (pathname === '/__sijeon') {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(HTML);
    return;
  }
  try {
    const file = join(ROOT, pathname === '/' ? 'index.html' : pathname);
    const data = await readFile(file);
    response.writeHead(200, {
      'content-type': MIME[extname(file)] || 'application/octet-stream',
    });
    response.end(data);
  } catch {
    response.writeHead(404);
    response.end('not found');
  }
});

await new Promise((resolveListen, rejectListen) => {
  server.listen(0, '127.0.0.1', resolveListen).on('error', rejectListen);
});
const port = server.address().port;
const shots = [
  ['street-day', 'view=street&time=day&mode=pbr'],
  ['street-sunset', 'view=street&time=sunset&mode=pbr'],
  ['oblique-day', 'view=oblique&time=day&mode=pbr'],
  ['row-overview-day', 'view=overview&time=day&mode=pbr'],
  ['street-ink', 'view=street&time=day&mode=ink'],
  ['oblique-ink', 'view=oblique&time=day&mode=ink'],
].filter(([name]) => !filter || name.includes(filter));

let browser;
const failures = [];
try {
  browser = await launchVerificationBrowser();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (error) => failures.push(`page: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' && !/favicon|404/i.test(message.text())) {
      failures.push(`console: ${message.text()}`);
    }
  });

  for (const [name, params] of shots) {
    await page.goto(`http://127.0.0.1:${port}/__sijeon?${params}`, {
      waitUntil: 'load',
      timeout: 45_000,
    });
    await page.waitForFunction('window.__SHOT_READY === true', null, {
      timeout: 45_000,
    });
    await page.waitForTimeout(160);
    const audit = await page.evaluate(() => window.__SIJEON_AUDIT);
    const imagePath = join(OUT, `${name}.png`);
    await page.locator('canvas').screenshot({ path: imagePath });
    console.log(`${name} ${JSON.stringify(audit)} ${imagePath}`);
  }
  await reportWebGLRenderer(page, 'sijeon');
} catch (error) {
  failures.push(error instanceof Error ? error.stack || error.message : String(error));
} finally {
  await browser?.close();
  server.close();
}

console.log(`shoot-sijeon: ${failures.length ? 'FAIL' : 'PASS'} output=${OUT}`);
if (failures.length) {
  for (const failure of failures) console.error(failure);
  process.exitCode = 1;
}
