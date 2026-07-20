// 일회성 측정: 집 프로토타입(giwa/choga) 메시·재질·지오메트리 구성 + capital 마을 draw calls.
// node tools/measure-proto.mjs
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

const HTML = `<!DOCTYPE html><html><head><meta charset="utf-8">
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.185.1/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.185.1/examples/jsm/"}}</script>
</head><body><div id="app"></div>
<script type="module">
import * as THREE from 'three';
import { buildBuilding } from '/src/builder/index.js';
import { PRESETS } from '/src/params.js';
import { planVillage } from '/src/village/plan.js';
import { populateVillage } from '/src/village/populate.js';

function inspect(root) {
  let meshes = 0, instanced = 0, verts = 0, tris = 0;
  const mats = new Set(), geos = new Set();
  const matByName = {};
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    if (o.isInstancedMesh) { instanced++; }
    if (o.isMesh) {
      meshes++;
      const g = o.geometry; geos.add(g);
      if (g.attributes.position) verts += g.attributes.position.count;
      if (g.index) tris += g.index.count / 3; else if (g.attributes.position) tris += g.attributes.position.count / 3;
      const ms = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of ms) { mats.add(m); matByName[m.name || m.type] = (matByName[m.name || m.type] || 0) + 1; }
    }
  });
  return { meshes, instanced, uniqueMats: mats.size, uniqueGeos: geos.size, verts, tris: Math.round(tris) };
}

const out = {};
out.giwa = inspect(buildBuilding(PRESETS.giwa));
out.choga = inspect(buildBuilding(PRESETS.choga));

// capital 마을 전체 — 실제 render.calls + 카테고리별 분해
const renderer = new THREE.WebGLRenderer();
renderer.setSize(1440, 900);
const scene = new THREE.Scene();
const cam = new THREE.PerspectiveCamera(45, 1440 / 900, 1, 5000);
cam.position.set(0, 500, 700); cam.lookAt(0, 0, 0);
scene.add(new THREE.HemisphereLight(0xffffff, 0x888888, 1));

const plan = planVillage({ scale: 'capital', seed: 20260716, includePalace: true, includeTemple: true, character: 'yeoyeom' });
const vg = populateVillage(plan);
scene.add(vg);
out.capital = inspect(vg);
out.capitalStats = plan.stats;

// 카테고리별 분해: 최상위 자식 이름별
const cat = {};
vg.updateMatrixWorld(true);
for (const child of vg.children) {
  const key = child.name || child.type;
  let m = 0, mats = new Set();
  child.traverse((o) => { if (o.isMesh) { m++; (Array.isArray(o.material) ? o.material : [o.material]).forEach((x) => mats.add(x)); } });
  cat[key] = cat[key] ? { meshes: cat[key].meshes + m, count: cat[key].count + 1 } : { meshes: m, count: 1, mats: mats.size };
}
out.capitalByChild = cat;

renderer.render(scene, cam);
out.capitalRenderCalls = renderer.info.render.calls;

window.__M = out;
window.__READY = true;
</script></body></html>`;

const server = createServer(async (req, res) => {
  const path = req.url.split('?')[0];
  if (path === '/__m') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(HTML); return; }
  try {
    const data = await readFile(join(ROOT, path));
    res.writeHead(200, { 'content-type': MIME[extname(path)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end('nf'); }
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const port = server.address().port;

let browser;
try { browser = await chromium.launch({ channel: 'chrome' }); } catch { browser = await chromium.launch(); }
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.error('[console]', m.text()); });
await page.goto(`http://127.0.0.1:${port}/__m`, { waitUntil: 'load' });
await page.waitForFunction('window.__READY === true', null, { timeout: 60000 });
const M = await page.evaluate(() => window.__M);
console.log(JSON.stringify(M, null, 2));
await browser.close();
server.close();
