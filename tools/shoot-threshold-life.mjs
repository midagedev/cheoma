// Focused threshold-life visual matrix. Writes only to an OS temp directory by default.
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from '../app/node_modules/vite/dist/node/index.js';
import { launchVerificationBrowser, reportWebGLRenderer } from './lib/verification-browser.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const cacheDir = await mkdtemp(join(tmpdir(), 'cheoma-threshold-life-cache-'));
const outputDir = process.env.CHEOMA_THRESHOLD_LIFE_OUT
  || await mkdtemp(join(tmpdir(), 'cheoma-threshold-life-shots-'));
await mkdir(outputDir, { recursive: true });

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body,#app{width:100%;height:100%;margin:0;overflow:hidden} body{background:#c8c4b7}
</style></head><body><div id="app"></div><script type="module">
import * as THREE from 'three';
import { PRESETS } from '/src/params.js';
import { buildBuilding } from '/src/builder/index.js';
import { planThresholdLife } from '/src/props/threshold-life-plan.js';
import { createThresholdLifeMaterial, createThresholdLifeMesh } from '/src/props/threshold-life.js';
const query = new URLSearchParams(location.search);
const style = query.get('style') || 'giwa';
const condition = query.get('condition') || 'dry';
const season = query.get('season') || 'summer';
const scaleX = Number(query.get('sx') || 1);
const scaleY = Number(query.get('sy') || 1);
const scaleZ = Number(query.get('sz') || 1);
const mainHalfW = Number(query.get('mainHalfW'));
const renderer = new THREE.WebGLRenderer({ antialias:true, preserveDrawingBuffer:true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
document.querySelector('#app').appendChild(renderer.domElement);
const scene = new THREE.Scene();
const palette = season === 'winter'
  ? { bg:0xc9d1d2, ground:0xdfe3df, sun:0xe9efff }
  : season === 'autumn'
    ? { bg:0xd9c3a1, ground:0x8d8062, sun:0xffd197 }
    : { bg:0xbeced0, ground:0x8e8a6c, sun:0xffe2ae };
scene.background = new THREE.Color(palette.bg);
scene.fog = new THREE.Fog(palette.bg, 16, 42);
const building = buildBuilding({
  ...PRESETS[style], seed: style === 'choga' ? 31 : 17,
  ...(Number.isFinite(mainHalfW) ? { planShape:'single', bays:3, mainHalfW } : {}),
});
building.scale.set(scaleX, scaleY, scaleZ);
scene.add(building);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(60,60), new THREE.MeshStandardMaterial({
  color: palette.ground, roughness:1,
}));
ground.rotation.x = -Math.PI/2; ground.position.y = -0.065; ground.receiveShadow = true; scene.add(ground);
const sun = new THREE.DirectionalLight(palette.sun, condition === 'wet' ? 1.5 : 2.7);
sun.position.set(-8,14,10); sun.castShadow=true; sun.shadow.mapSize.set(1024,1024);
sun.shadow.camera.left=-10;sun.shadow.camera.right=10;sun.shadow.camera.top=10;sun.shadow.camera.bottom=-10;
scene.add(sun); scene.add(new THREE.HemisphereLight(0xdce8ed,0x635847,1.25));
const anchor = building.getObjectByName('primary-opening-anchor');
if (!anchor) throw new Error('threshold life fixture missing production opening anchor');
building.updateWorldMatrix(true, true);
const lifePlan = planThresholdLife({
  opening:anchor.userData.openingDetailPlan, condition, seed:style === 'choga' ? 31 : 17,
});
const life = createThresholdLifeMesh(lifePlan, anchor.matrixWorld, createThresholdLifeMaterial());
// Scene ownership keeps the batch outside the scaled building subtree, matching
// the focused-village owner boundary.
scene.add(life);
const box = new THREE.Box3().setFromObject(life); const center=box.getCenter(new THREE.Vector3());
const outward = new THREE.Vector3(0,0,1).transformDirection(anchor.matrixWorld).normalize();
const tangent = new THREE.Vector3(1,0,0).transformDirection(anchor.matrixWorld).normalize();
const camera = new THREE.PerspectiveCamera(34,innerWidth/innerHeight,0.03,100);
camera.position.copy(center)
  .addScaledVector(outward, style === 'giwa' ? 1.65 : 2.25)
  .addScaledVector(tangent, style === 'giwa' ? 0.75 : 1.35);
camera.position.y += style === 'giwa' ? 1.65 : 1.0;
camera.lookAt(center.x,center.y+0.08,center.z);
renderer.info.autoReset=false;
life.visible=false; renderer.render(scene,camera); renderer.info.reset(); renderer.render(scene,camera);
const withoutLife={calls:renderer.info.render.calls,triangles:renderer.info.render.triangles,programs:renderer.info.programs?.length||0};
life.visible=true; renderer.info.reset(); renderer.render(scene,camera);
const withLife={calls:renderer.info.render.calls,triangles:renderer.info.render.triangles,programs:renderer.info.programs?.length||0};
window.__THRESHOLD_LIFE={
  ready:true, style, condition, season, plan:life.userData.thresholdLifePlan,
  openingWidth:anchor.userData.openingDetailPlan.width,
  hostScale:[scaleX,scaleY,scaleZ],
  bounds:{min:box.min.toArray(),max:box.max.toArray(),size:box.getSize(new THREE.Vector3()).toArray()}, withoutLife,withLife,
  delta:{calls:withLife.calls-withoutLife.calls,triangles:withLife.triangles-withoutLife.triangles,
    programs:withLife.programs-withoutLife.programs},
};
</script></body></html>`;

const server = await createServer({
  root: ROOT,
  configFile: false,
  cacheDir,
  logLevel: 'error',
  resolve: {
    alias: [
      { find: /^three\/addons\//, replacement: join(ROOT, 'app/node_modules/three/examples/jsm/') },
      { find: /^three$/, replacement: join(ROOT, 'app/node_modules/three/build/three.module.js') },
    ],
    dedupe: ['three'],
  },
  optimizeDeps: { noDiscovery: true },
  plugins: [{
    name: 'threshold-life-fixture',
    configureServer(dev) {
      dev.middlewares.use('/__threshold-life', async (_req, response) => {
        response.setHeader('content-type', 'text/html; charset=utf-8');
        response.end(await dev.transformIndexHtml('/__threshold-life', html));
      });
    },
  }],
  server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false },
});

let browser;
try {
  await server.listen();
  const port = server.httpServer.address().port;
  browser = await launchVerificationBrowser();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (error) => { errors.push(error.message); console.error('[page]', error.message); });
  page.on('console', (message) => {
    if (message.type() === 'error' && !/favicon|404/i.test(message.text())) {
      errors.push(message.text()); console.error('[console]', message.text());
    }
  });
  const cases = [
    ['choga-dry-scale070-autumn', 'choga', 'dry', 'autumn', 0.7, 0.7, 0.7, null],
    ['choga-dry-scale140-winter', 'choga', 'dry', 'winter', 1.4, 1.4, 1.4, null],
    ['giwa-dry-mainhalf390-scale070', 'giwa', 'dry', 'summer', 0.7, 0.7, 0.7, 3.9],
    ['giwa-dry-mainhalf380-scale140', 'giwa', 'dry', 'summer', 1.4, 1.4, 1.4, 3.8],
    ['giwa-wet-mainhalf380-anisotropic', 'giwa', 'wet', 'summer', 1.4, 0.75, 1.2, 3.8],
  ];
  for (const [name, style, condition, season, sx, sy, sz, mainHalfW] of cases) {
    const params = new URLSearchParams({ style, condition, season, sx, sy, sz });
    if (mainHalfW != null) params.set('mainHalfW', mainHalfW);
    await page.goto(`http://127.0.0.1:${port}/__threshold-life?${params}`,
      { waitUntil:'domcontentloaded', timeout:60_000 });
    await page.waitForFunction(() => window.__THRESHOLD_LIFE?.ready === true, null, { timeout:60_000 });
    await reportWebGLRenderer(page, name);
    const state = await page.evaluate(() => window.__THRESHOLD_LIFE);
    const file = join(outputDir, `${name}.png`);
    await page.screenshot({ path:file });
    console.log(`${name}: ${file}`);
    console.log(JSON.stringify({
      kind:state.plan.kind, openingWidth:state.openingWidth, hostScale:state.hostScale,
      size:state.bounds.size, signature:state.plan.placement.signature,
      clearance:state.plan.clearance, delta:state.delta,
    }));
  }
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(`THRESHOLD LIFE SHOTS: ${outputDir}`);
} finally {
  if (browser) await browser.close();
  await server.close();
  await rm(cacheDir, { recursive:true, force:true });
}
