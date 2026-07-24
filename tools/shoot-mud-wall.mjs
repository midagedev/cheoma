import { createServer } from 'node:http';
import { readFile, mkdtemp } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { PNG } from 'pngjs';
import {
  launchVerificationBrowser,
  reportWebGLRenderer,
} from './lib/verification-browser.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
};
const invariant = (condition, message) => {
  if (!condition) throw new Error(message);
};

const PRODUCT_HTML = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#c5d0d1}canvas{display:block}</style>
<script type="importmap">{"imports":{
  "three":"/app/node_modules/three/build/three.module.js",
  "three/addons/":"/app/node_modules/three/examples/jsm/"
}}</script></head><body><script type="module">
import * as THREE from 'three';
import { createVillage } from '/src/village/adapter.js';

const view = new URLSearchParams(location.search).get('view') || 'close';
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(1);
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.04;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xc5d0d1);
const handle = createVillage({ scale: 'village', seed: 1, character: 'yeoyeom' });
scene.add(handle.group);
const target = handle.plan.parcels.find((parcel) => parcel.id === 'p3');
if (!target || target.wallType !== 'mud') throw new Error('product mud-wall fixture p3 drifted');
handle.rebuildParcel(target.id, {});
const inspectionLayers = new Set([
  'village-terrain',
  'village-pads',
  'village-roads',
  'village-overrides',
]);
for (const child of handle.group.children) child.visible = inspectionLayers.has(child.name);

const sun = new THREE.DirectionalLight(0xffd2a1, 3.6);
sun.position.set(target.center.x - 18, target.baseY + 24, target.center.z + 17);
sun.target.position.set(target.center.x, target.baseY + 1, target.center.z);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
Object.assign(sun.shadow.camera, { left: -25, right: 25, top: 25, bottom: -25, near: 1, far: 80 });
scene.add(sun, sun.target);
scene.add(new THREE.HemisphereLight(0xe2e8df, 0x645540, 1.3));
scene.fog = new THREE.Fog(scene.background, 75, 180);

const camera = new THREE.PerspectiveCamera(view === 'aerial' ? 36 : 28, innerWidth / innerHeight, 0.15, 260);
const front = target.frontDir;
const right = { x: front.z, z: -front.x };
const span = Math.max(target.plotW, target.plotD);
const distance = view === 'aerial' ? span * 3.2 : span * 1.15;
camera.position.set(
  target.center.x + front.x * distance + right.x * distance * 0.78,
  target.baseY + (view === 'aerial' ? span * 2.1 : Math.max(3.8, span * 0.24)),
  target.center.z + front.z * distance + right.z * distance * 0.78,
);
camera.lookAt(
  target.center.x + front.x * target.plotD * 0.28,
  target.baseY + (view === 'aerial' ? 0.5 : 1.05),
  target.center.z + front.z * target.plotD * 0.28,
);

let frames = 0;
renderer.setAnimationLoop(() => {
  handle.update(1 / 60);
  renderer.render(scene, camera);
  if (++frames !== 18) return;
  let bodies = 0;
  let fibres = 0;
  let enabled = 0;
  handle.group.traverse((object) => {
    if (object.name === 'mud-wall-body') {
      bodies++;
      if (object.userData.mudWallSurface?.enabled) enabled++;
    }
    if (object.name === 'mud-wall-fibres') fibres++;
  });
  window.__MUD_WALL_PRODUCT = {
    view,
    parcelId: target.id,
    wallType: target.wallType,
    bodies,
    fibres,
    enabled,
    calls: renderer.info.render.calls,
    triangles: renderer.info.render.triangles,
    programs: renderer.info.programs.length,
  };
});
</script></body></html>`;

const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    if (pathname === '/favicon.ico') {
      response.writeHead(204);
      response.end();
      return;
    }
    if (pathname === '/__mud_wall_product') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(PRODUCT_HTML);
      return;
    }
    const file = resolve(
      ROOT,
      `.${pathname === '/' ? '/tools/mud-wall-surface-harness.html' : pathname}`,
    );
    if (file !== ROOT && !file.startsWith(`${ROOT}${sep}`)) throw new Error('unsafe path');
    const body = await readFile(file);
    response.writeHead(200, {
      'content-type': MIME[extname(file)] || 'application/octet-stream',
    });
    response.end(body);
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('not found');
  }
});
await new Promise((done, reject) =>
  server.listen(0, '127.0.0.1', done).on('error', reject));

function meanDifference(leftBuffer, rightBuffer) {
  const left = PNG.sync.read(leftBuffer);
  const right = PNG.sync.read(rightBuffer);
  invariant(
    left.width === right.width && left.height === right.height,
    'mud-wall frame dimensions drifted',
  );
  let total = 0;
  for (let offset = 0; offset < left.data.length; offset += 4) {
    total += Math.abs(left.data[offset] - right.data[offset]);
    total += Math.abs(left.data[offset + 1] - right.data[offset + 1]);
    total += Math.abs(left.data[offset + 2] - right.data[offset + 2]);
  }
  return total / (left.width * left.height * 3);
}

const output = process.env.CHEOMA_CAPTURE_DIR
  || await mkdtemp(join(tmpdir(), 'cheoma-mud-wall-'));
const browser = await launchVerificationBrowser();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (error) => errors.push(`page: ${error.message}`));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(`console: ${message.text()}`);
});
const port = server.address().port;

async function capture(mode, view = 'close') {
  await page.goto(
    `http://127.0.0.1:${port}/tools/mud-wall-surface-harness.html?mode=${mode}&view=${view}`,
    { waitUntil: 'load' },
  );
  await page.waitForFunction(() => window.__MUD_WALL_READY === true, null, {
    timeout: 60_000,
  });
  const diag = await page.evaluate(() => window.__MUD_WALL_DIAG);
  const path = join(output, `mud-wall-${view}-${mode}.png`);
  const buffer = await page.locator('canvas').screenshot({ path });
  return { mode, view, diag, path, buffer };
}

async function captureProduct(view) {
  await page.goto(
    `http://127.0.0.1:${port}/__mud_wall_product?view=${view}`,
    { waitUntil: 'load' },
  );
  await page.waitForFunction(() => window.__MUD_WALL_PRODUCT, null, {
    timeout: 60_000,
  });
  const diag = await page.evaluate(() => window.__MUD_WALL_PRODUCT);
  const path = join(output, `mud-wall-product-${view}.png`);
  const buffer = await page.locator('canvas').screenshot({ path });
  return { view, diag, path, buffer };
}

try {
  const close = {};
  for (const mode of ['base', 'no-packed', 'no-fibres', 'no-damp', 'full']) {
    close[mode] = await capture(mode);
  }
  const aerialBase = await capture('base', 'aerial');
  const aerialFull = await capture('full', 'aerial');
  const productClose = await captureProduct('close');
  const productAerial = await captureProduct('aerial');
  const full = close.full.diag;

  invariant(errors.length === 0, errors.join(' | '));
  invariant(full.insideEnvelope, `detail escaped wall envelope ${JSON.stringify(full.bounds)}`);
  invariant(full.plan.lifts >= 2 && full.plan.joints === full.plan.lifts - 1,
    `packed lift plan is incomplete ${JSON.stringify(full.plan)}`);
  invariant(full.plan.fibres > 0 && full.plan.damp === 2,
    `fibre/damp plan is incomplete ${JSON.stringify(full.plan)}`);
  invariant(full.disposalCounts.body === 1 && full.disposalCounts.fibres === 1,
    `owned geometry lifecycle failed ${JSON.stringify(full.disposalCounts)}`);
  invariant(full.materialTextures === 0,
    `mud-wall geometry unexpectedly required material textures (${full.materialTextures})`);
  invariant(full.bodyTriangles <= 3_000 && full.fibreTriangles <= 500,
    `mud-wall geometry exceeded bounded fixture budget ${JSON.stringify(full)}`);
  invariant(full.programs <= close.base.diag.programs + 2,
    `mud-wall added too many program families (${close.base.diag.programs} -> ${full.programs})`);

  const deltas = {
    full: meanDifference(close.base.buffer, close.full.buffer),
    packed: meanDifference(close['no-packed'].buffer, close.full.buffer),
    fibres: meanDifference(close['no-fibres'].buffer, close.full.buffer),
    damp: meanDifference(close['no-damp'].buffer, close.full.buffer),
    aerial: meanDifference(aerialBase.buffer, aerialFull.buffer),
  };
  invariant(deltas.full >= 0.3, `full mud-wall detail is not visible (${deltas.full.toFixed(3)})`);
  invariant(deltas.packed >= 0.03, `packed lifts are not visible (${deltas.packed.toFixed(3)})`);
  invariant(deltas.fibres >= 0.005, `physical fibres are not visible (${deltas.fibres.toFixed(3)})`);
  invariant(deltas.damp >= 0.01, `lower damp tone is not visible (${deltas.damp.toFixed(3)})`);
  invariant(deltas.aerial < deltas.full,
    `detail did not reduce with distance (${deltas.full.toFixed(3)} -> ${deltas.aerial.toFixed(3)})`);
  for (const product of [productClose, productAerial]) {
    invariant(product.diag.wallType === 'mud'
      && product.diag.bodies > 0
      && product.diag.bodies === product.diag.enabled
      && product.diag.fibres > 0,
    `product mud-wall contribution is missing ${JSON.stringify(product.diag)}`);
  }

  await reportWebGLRenderer(page, 'mud-wall');
  console.log(
    `MUD WALL BROWSER: PASS (delta full/packed/fibre/damp/aerial=`
    + `${deltas.full.toFixed(3)}/${deltas.packed.toFixed(3)}/`
    + `${deltas.fibres.toFixed(3)}/${deltas.damp.toFixed(3)}/`
    + `${deltas.aerial.toFixed(3)}, triangles body/fibre=`
    + `${full.bodyTriangles}/${full.fibreTriangles}, programs=`
    + `${close.base.diag.programs}->${full.programs}, materialTextures=`
    + `${full.materialTextures}, rendererTextures=${full.rendererTextures})`,
  );
  console.log(
    `product close/aerial calls=${productClose.diag.calls}/${productAerial.diag.calls}, `
    + `triangles=${productClose.diag.triangles}/${productAerial.diag.triangles}, `
    + `programs=${productClose.diag.programs}/${productAerial.diag.programs}`,
  );
  console.log(`captures=${output}`);
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
