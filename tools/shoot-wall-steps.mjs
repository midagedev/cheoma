import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import {
  launchVerificationBrowser,
  reportWebGLRenderer,
} from './lib/verification-browser.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const OUTPUT = process.env.CHEOMA_CAPTURE_DIR || join('/tmp', 'cheoma-wall-steps');
mkdirSync(OUTPUT, { recursive: true });

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
<html><head><meta charset="utf-8">
<style>html,body,#app{margin:0;width:100%;height:100%;overflow:hidden;background:#c9d5dc}</style>
<script type="importmap">{"imports":{
  "three":"/app/node_modules/three/build/three.module.js",
  "three/addons/":"/app/node_modules/three/examples/jsm/"
}}</script></head><body><div id="app"></div><script type="module">
import * as THREE from 'three';
import { createVillage } from '/src/village/adapter.js';
import { villageWallLayout } from '/src/village/wall-contract.js';
import { makeRng } from '/src/rng.js';

let randomState = 0x2545f491;
Math.random = () => {
  randomState ^= randomState << 13;
  randomState ^= randomState >>> 17;
  randomState ^= randomState << 5;
  return (randomState >>> 0) / 4294967296;
};

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
document.getElementById('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xc9d5dc);
const handle = createVillage({ scale: 'village', seed: 1, character: 'yeoyeom' });
scene.add(handle.group);
const target = handle.plan.parcels.find((parcel) => parcel.id === 'p8');
if (!target) throw new Error('wall-step visual fixture p8 is missing');
handle.rebuildParcel(target.id, {});
const inspectionLayers = new Set(['terrain', 'village-pads', 'village-roads', 'village-overrides']);
for (const child of handle.group.children) child.visible = inspectionLayers.has(child.name);

const layout = villageWallLayout(target.shape, {
  style: target.wallType,
  kind: target.kind,
  seed: target.seed,
  char01: handle.plan.opts.char01,
  wallHeightK: target.wallHeightK,
  plotW: target.plotW,
  plotD: target.plotD,
  gateEdge: target.access?.gateEdge,
  gateT: target.access?.gateT,
  parcel: target,
  site: handle.plan.site,
  baseY: target.baseY,
}, makeRng((((target.seed | 0) || 7) ^ 0x51de) >>> 0));
const steppedRuns = layout.edgeLayouts.flatMap((edge) => edge.runs)
  .filter((run) => (run.bottomOffset || 0) !== 0 || (run.topOffset || 0) !== 0).length;
if (steppedRuns < 8) throw new Error('visual fixture no longer exercises a strong stepped wall');

const R = handle.plan.site.R;
const sun = new THREE.DirectionalLight(0xffe4bd, 3.1);
sun.position.set(target.center.x - R * 0.32, target.baseY + R * 0.7, target.center.z + R * 0.4);
sun.target.position.set(target.center.x, target.baseY, target.center.z);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -40, right: 40, top: 40, bottom: -40, near: 1, far: R * 3 });
sun.shadow.bias = -0.0002;
sun.shadow.normalBias = 0.05;
scene.add(sun, sun.target);
scene.add(new THREE.HemisphereLight(0xd7e3ed, 0x74644f, 1.35));
scene.fog = new THREE.Fog(scene.background, R * 1.5, R * 5);

const camera = new THREE.PerspectiveCamera(38, innerWidth / innerHeight, 0.25, R * 5);
const front = target.frontDir;
const right = { x: front.z, z: -front.x };
const side = Number(new URLSearchParams(location.search).get('side') || 1);
const distance = Math.max(target.plotW, target.plotD) * 1.3;
camera.position.set(
  target.center.x + front.x * distance + right.x * distance * 0.65 * side,
  target.baseY + Math.max(4.8, distance * 0.18),
  target.center.z + front.z * distance + right.z * distance * 0.65 * side,
);
camera.lookAt(
  target.center.x + front.x * target.plotD * 0.36,
  target.baseY + 0.95,
  target.center.z + front.z * target.plotD * 0.36,
);

let frame = 0;
renderer.setAnimationLoop(() => {
  handle.update(1 / 60);
  renderer.render(scene, camera);
  if (++frame === 18) {
    window.__WALL_STEP_RESULT = {
      parcelId: target.id,
      style: target.wallType,
      steppedRuns,
      calls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
    };
  }
});
</script></body></html>`;

const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
  if (pathname === '/__wall_steps') {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(HTML);
    return;
  }
  try {
    const file = join(ROOT, pathname === '/' ? 'index.html' : pathname);
    const body = await readFile(file);
    response.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end('not found');
  }
});
await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const port = server.address().port;

const browser = await launchVerificationBrowser();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error' && !/favicon|404/.test(message.text())) errors.push(message.text());
});

try {
  for (const side of [-1, 1]) {
    await page.goto(`http://127.0.0.1:${port}/__wall_steps?side=${side}`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__WALL_STEP_RESULT, null, { timeout: 45000 });
    const result = await page.evaluate(() => window.__WALL_STEP_RESULT);
    const path = join(OUTPUT, `wall-steps-${side < 0 ? 'left' : 'right'}.png`);
    await page.locator('canvas').screenshot({ path });
    console.log(`wall-step ${side < 0 ? 'left' : 'right'}: ${JSON.stringify(result)} saved=${path}`);
  }
  await reportWebGLRenderer(page, 'wall-step');
  if (errors.length) throw new Error(`wall-step browser errors:\n${errors.join('\n')}`);
} finally {
  await browser.close();
  await new Promise((resolveClose) => server.close(resolveClose));
}
