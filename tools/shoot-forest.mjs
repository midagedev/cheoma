// 산 숲·암봉 시각 비교 하네스(#113, 사용자 지시로 이 태스크 한정 시각검증 허용). 전용 포트 4229.
//   금강산·설악산 레퍼런스(refs/mountains) 대비용 마을 배산 중경·부감 스크린샷.
//   사용: NODE_PATH=/Users/hckim/repo/threesur/node_modules node tools/shoot-forest.mjs [out=scratch|shots] [view] [season] [scale]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..');
const dest = process.argv[2] === 'shots' ? 'shots' : 'scratch';
const SCRATCH = '/private/tmp/claude-501/-Users-hckim-repo-asiahouse/7a15478e-68e3-4ad3-b08a-bdb86ae4fe92/scratchpad/forest';
const OUT = dest === 'shots' ? join(ROOT, 'shots') : SCRATCH;
mkdirSync(OUT, { recursive: true });
const PFX = dest === 'shots' ? 'forest-' : '';
const PORT = 4229;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

const HTML = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>html,body{margin:0;height:100%;overflow:hidden}#app{width:100%;height:100%}</style>
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.185.1/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.185.1/examples/jsm/"}}</script>
</head><body><div id="app"></div>
<script type="module">
import * as THREE from 'three';
import { planVillage } from '/src/village/plan.js';
import { populateVillage } from '/src/village/populate.js';
const q = new URLSearchParams(location.search);
const scale = q.get('scale') || 'town';
const view = q.get('view') || 'backmt';
const season = q.get('season') || 'summer';
const time = q.get('time') || 'day';
{ let s = 0x2545f491 >>> 0; Math.random = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight); renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.getElementById('app').appendChild(renderer.domElement);
const scene = new THREE.Scene();
const L = {
  day:    { bg: 0xc4d3dd, sun: [0xfff2e0, 2.6, [0.30,1.15,0.55]], hemi: [0xbcd2e6, 0x8a8262, 1.15], exp: 1.05 },
  sunset: { bg: 0xe4b088, sun: [0xffb066, 2.1, [0.55,0.4,0.62]], hemi: [0xd7b48c, 0x7a6a54, 1.0], exp: 1.0 },
}[time] || {};
scene.background = new THREE.Color(L.bg);
renderer.toneMappingExposure = L.exp;

const plan = planVillage({ scale, seed: 20260716, includePalace: scale==='capital'||scale==='hanyang', includeTemple: true });
const group = populateVillage(plan);
if (group.userData.setSeason) group.userData.setSeason(season);
scene.add(group);
const site = plan.site; const R = site.R; const TR = site.terrainR || R; const C = site.center;
scene.fog = new THREE.Fog(L.bg, R * 2.6, R * 8.0);
const sun = new THREE.DirectionalLight(L.sun[0], L.sun[1]);
sun.position.set(L.sun[2][0]*R, L.sun[2][1]*R, L.sun[2][2]*R);
sun.castShadow = true; sun.shadow.mapSize.set(4096,4096);
const sc = sun.shadow.camera; sc.left=-TR*1.05; sc.right=TR*1.05; sc.top=TR*1.05; sc.bottom=-TR*1.05; sc.near=1; sc.far=TR*8; sun.shadow.bias=-0.0003; sun.shadow.normalBias=0.08;
scene.add(sun); scene.add(new THREE.HemisphereLight(L.hemi[0], L.hemi[1], L.hemi[2]));

const hAt = (x,z) => site.heightAt(x,z);
let campos, target, fov = 46;
if (view === 'backmt') {
  // 마을 앞(남)에서 배산(북 주산)을 바라봄 — 레퍼런스처럼 산 사면이 프레임을 채움(중경).
  const px = C.x + 0.1*R, pz = C.z + 0.95*R;
  campos = new THREE.Vector3(px, hAt(px,pz)+0.10*R, pz);
  target = new THREE.Vector3(C.x, site.Hmax*0.5, C.z - 0.7*R);
  fov = 50;
} else if (view === 'ridge') {
  // 능선 스카이라인 리듬(측면 오블리크) — 암봉이 하늘선을 뚫는지.
  const px = C.x + 0.9*R, pz = C.z - 0.2*R;
  campos = new THREE.Vector3(px, site.Hmax*0.55, pz);
  target = new THREE.Vector3(C.x - 0.3*R, site.Hmax*0.5, C.z - 0.6*R);
  fov = 52;
} else { // aerial
  campos = new THREE.Vector3(0.16*R, 0.98*R, 1.9*R);
  target = new THREE.Vector3(0, 0.02*R, -0.12*R);
}
const cam = new THREE.PerspectiveCamera(fov, innerWidth/innerHeight, 1, TR*12);
cam.position.copy(campos); cam.lookAt(target);
renderer.render(scene, cam);
requestAnimationFrame(() => { renderer.render(scene, cam); window.__READY = true; });
</script></body></html>`;

const server = createServer(async (req, res) => {
  const path = req.url.split('?')[0];
  if (path === '/__forest') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(HTML); return; }
  try { const data = await readFile(join(ROOT, path === '/' ? 'index.html' : path));
    res.writeHead(200, { 'content-type': MIME[extname(path)] || 'application/octet-stream' }); res.end(data);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise((ok) => server.listen(PORT, '127.0.0.1', ok));
let browser; try { browser = await chromium.launch({ channel: 'chrome' }); } catch { browser = await chromium.launch(); }
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
let errs = 0; page.on('pageerror', (e) => { errs++; console.error('[pageerror]', e.message); });

// 촬영 조합: 인자 지정 시 단발, 아니면 대표 세트.
const argView = process.argv[3], argSeason = process.argv[4], argScale = process.argv[5];
let combos;
if (argView) combos = [{ view: argView, season: argSeason || 'summer', scale: argScale || 'town' }];
else combos = [
  { view:'backmt', season:'summer', scale:'town' },
  { view:'backmt', season:'autumn', scale:'town' },
  { view:'backmt', season:'spring', scale:'town' },
  { view:'ridge',  season:'summer', scale:'town' },
  { view:'aerial', season:'summer', scale:'town' },
];
for (const c of combos) {
  const url = `http://127.0.0.1:${PORT}/__forest?view=${c.view}&season=${c.season}&scale=${c.scale}`;
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction('window.__READY === true', { timeout: 30000 }).catch(()=>{});
  const name = `${PFX}${c.view}-${c.season}-${c.scale}.png`;
  await page.screenshot({ path: join(OUT, name) });
  console.log('shot', join(OUT, name));
}
console.log('pageerrors', errs);
await browser.close(); server.close();
