// v4 마을 어댑터 검증 → shots/v4-*.png
//   node tools/shoot-v4.mjs [필터]
// 커버: ①인스턴싱 전/후 draw calls·fps(capital) ②픽킹 프록시 시각화 ③rebuildParcel 전/후
//       ④야간 마을 창호광 ⑤같은 seed 재현성. adapter.js 가 텍스처/게이트 난수를 자체 시드.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'shots');
mkdirSync(OUT, { recursive: true });
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };

const HTML = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>html,body{margin:0;height:100%;overflow:hidden}#app{width:100%;height:100%}</style>
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.185.1/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.185.1/examples/jsm/"}}</script>
</head><body><div id="app"></div>
<script type="module">
import * as THREE from 'three';
import { createVillage } from '/src/village/adapter.js';
import { planVillage } from '/src/village/plan.js';
import { populateVillage } from '/src/village/populate.js';
const q = new URLSearchParams(location.search);
const scale = q.get('scale') || 'village';
const seedRaw = q.get('seed');
const seed = seedRaw != null ? (isNaN(+seedRaw) ? seedRaw : +seedRaw) : 20260716;
const includePalace = q.get('palace') === '1';
const includeTemple = q.get('temple') === '1';
const character = q.get('char') || 'yeoyeom';
const view = q.get('view') || 'aerial';
const time = q.get('time') || 'day';
const legacy = q.get('legacy') === '1';       // optimize=false(인스턴싱 전) 비교
const proxy = q.get('proxy') === '1';         // 픽킹 프록시 와이어 노출
const measureFps = q.get('fps') === '1';

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight); renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.getElementById('app').appendChild(renderer.domElement);
const scene = new THREE.Scene();

const L = {
  day:    { bg: 0xcfd8e0, sun: [0xfff0dd, 2.5, [0.42,1.25,0.30]], hemi: [0xc4d6e8, 0x9a8c72, 1.25], exp: 1.05 },
  sunset: { bg: 0xe7b98f, sun: [0xffb066, 2.1, [0.7,0.7,0.42]], hemi: [0xd7b48c, 0x7a6a54, 1.0], exp: 1.0 },
  night:  { bg: 0x1a2436, sun: [0x9fb6d8, 0.35, [0.3,0.9,0.4]], hemi: [0x35425c, 0x1b1c24, 0.5], exp: 1.1 },
}[time] || {};
scene.background = new THREE.Color(L.bg);
renderer.toneMappingExposure = L.exp;

// 마을 — adapter(기본) 또는 legacy(optimize=false)
let vg, api = null, plan;
if (legacy) {
  plan = planVillage({ scale, seed, includePalace, includeTemple, character });
  vg = populateVillage(plan, { optimize: false });
  scene.add(vg);
} else {
  api = createVillage({ scale, seed, includePalace, includeTemple, character });
  plan = api.plan; vg = api.group;
  api.enterVillageMode({ scene });
  if (proxy) api.debugShowProxies(true);
  api.setTime(time);
}
window.__api = api;

const R = plan.site.R;
scene.fog = new THREE.Fog(L.bg, R * 2.4, R * 7.0);
const sun = new THREE.DirectionalLight(L.sun[0], L.sun[1]);
sun.position.set(L.sun[2][0] * R, L.sun[2][1] * R, L.sun[2][2] * R);
sun.castShadow = true; sun.shadow.mapSize.set(4096, 4096);
const TR = plan.site.terrainR || R;
const sc = sun.shadow.camera;
sc.left = -TR*1.05; sc.right = TR*1.05; sc.top = TR*1.05; sc.bottom = -TR*1.05; sc.near = 1; sc.far = TR*8;
sun.shadow.bias = -0.0003; sun.shadow.normalBias = 0.08;
scene.add(sun);
scene.add(new THREE.HemisphereLight(L.hemi[0], L.hemi[1], L.hemi[2]));

const cen = plan.site.center;
let campos, target, fov;
if (view === 'aerial') { fov = 44; campos = new THREE.Vector3(0.18*R, 1.02*R, 1.98*R); target = new THREE.Vector3(0, 0.06*R, -0.16*R); }
else if (view === 'closeup') {
  // 한 필지 근경(프록시/rebuild 확인용): 중앙 필지 프레이밍 사용
  fov = 34; campos = new THREE.Vector3(0.35*R, 0.5*R, 0.9*R); target = new THREE.Vector3(0, 0.05*R, 0.1*R);
} else { const camZ = plan.site.streamZ + R*0.34; const gy = plan.site.heightAt(R*0.04, camZ); fov = 52; campos = new THREE.Vector3(R*0.04, gy+2.4, camZ); target = new THREE.Vector3(0, plan.site.heightAt(0, cen.z)+5, cen.z*0.55); }
const num = (k, d) => { const v = parseFloat(q.get(k)); return Number.isFinite(v) ? v : d; };
const camera = new THREE.PerspectiveCamera(fov, innerWidth/innerHeight, 0.5, R*8);
camera.position.set(num('cx', campos.x), num('cy', campos.y), num('cz', campos.z));
camera.lookAt(num('tx', target.x), num('ty', target.y), num('tz', target.z));

// 중앙 근처 정규 필지 하나 골라 노출(rebuild 데모 타깃)
window.__pickTarget = () => {
  const reg = plan.parcels.filter((p) => !p.hero);
  reg.sort((a,b) => (a.center.x**2+a.center.z**2) - (b.center.x**2+b.center.z**2));
  const choga = reg.find((p) => p.kind !== 'giwa') || reg[0];
  return choga ? { id: choga.id, kind: choga.kind, x: choga.center.x, z: choga.center.z } : null;
};
window.__frameParcel = (id) => {
  const pr = api.getPickProxies().find((p) => p.parcelId === id);
  if (!pr) return false;
  camera.position.copy(pr.cameraFraming.position);
  camera.fov = pr.cameraFraming.fov; camera.updateProjectionMatrix();
  camera.lookAt(pr.cameraFraming.target);
  return true;
};

let frames = 0, fpsT0 = 0, fpsFrames = 0, fpsMs = 0;
const freeze = q.get('freeze') === '1';   // 애니메이션 정지(재현성 순수 비교용)
renderer.setAnimationLoop(() => {
  if (!freeze) { if (api) api.update(1/60); else if (vg.userData.update) vg.userData.update(1/60); }
  const t = performance.now();
  renderer.render(scene, camera);
  frames++;
  if (frames === 12) {
    const ri = renderer.info;
    window.__V4 = {
      calls: ri.render.calls, triangles: ri.render.triangles,
      geometries: ri.memory.geometries, textures: ri.memory.textures,
      houses: plan.stats.houses, giwa: plan.stats.giwa, choga: plan.stats.choga,
      scale, seed, legacy, warnings: plan.warnings,
    };
    window.__SHOT_READY = true;
    fpsT0 = performance.now();
  }
  if (measureFps && frames > 12 && frames <= 112) {
    fpsMs += performance.now() - t; fpsFrames++;
    if (fpsFrames === 100) { window.__V4.fpsAvgMs = +(fpsMs/100).toFixed(3); window.__V4.fps = +(1000/(fpsMs/100)).toFixed(1); window.__FPS_READY = true; }
  }
});
</script></body></html>`;

const server = createServer(async (req, res) => {
  const path = req.url.split('?')[0];
  if (path === '/__v4') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(HTML); return; }
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
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
let pageErrs = 0, consoleErrs = 0;
page.on('console', (m) => { if (m.type() === 'error') { const t = m.text(); if (/favicon|404/.test(t)) return; consoleErrs++; console.error('[console]', t); } });
page.on('pageerror', (e) => { pageErrs++; console.error('[pageerror]', e.message); });

async function shoot(name, qs, { fps = false, after } = {}) {
  await page.goto(`http://127.0.0.1:${port}${qs}`, { waitUntil: 'load' });
  try { await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 60000 }); }
  catch { console.error('TIMEOUT', name); }
  if (fps) { try { await page.waitForFunction('window.__FPS_READY === true', null, { timeout: 60000 }); } catch { console.error('FPS TIMEOUT', name); } }
  if (after) await after();
  await page.waitForTimeout(200);
  const info = await page.evaluate(() => window.__V4 || null);
  if (info) console.log(name, JSON.stringify(info));
  await page.screenshot({ path: join(OUT, `v4-${name}.png`) });
  console.log('saved', `v4-${name}.png`);
  return info;
}

const filter = process.argv[2] || '';
const run = async (name, fn) => { if (!filter || name.includes(filter)) await fn(); };

// ① 인스턴싱 전/후 draw calls·fps (capital)
await run('capital-legacy',  () => shoot('capital-legacy',  '/__v4?scale=capital&palace=1&temple=1&view=aerial&time=day&legacy=1&fps=1', { fps: true }));
await run('capital-instanced', () => shoot('capital-instanced', '/__v4?scale=capital&palace=1&temple=1&view=aerial&time=day&fps=1', { fps: true }));
// ② 픽킹 프록시 시각화(마을 부감 + 와이어)
await run('proxy', () => shoot('proxy', '/__v4?scale=village&view=aerial&time=day&proxy=1'));
// ③ rebuildParcel 전/후 (중앙 필지 유형 교체) — 같은 페이지에서 evaluate 로 변경
await run('rebuild-before', () => shoot('rebuild-before', '/__v4?scale=village&view=closeup&time=day', {
  after: async () => {
    const t = await page.evaluate(() => window.__pickTarget());
    if (t) await page.evaluate((id) => window.__frameParcel(id), t.id);
    console.log('  rebuild target:', JSON.stringify(t));
  },
}));
await run('rebuild-after', () => shoot('rebuild-after', '/__v4?scale=village&view=closeup&time=day', {
  after: async () => {
    const t = await page.evaluate(() => window.__pickTarget());
    if (t) {
      await page.evaluate((id) => window.__frameParcel(id), t.id);
      const newKind = t.kind === 'giwa' ? 'choga' : 'giwa';
      const ok = await page.evaluate(({ id, k }) => !!window.__api.rebuildParcel(id, { kind: k }), { id: t.id, k: newKind });
      console.log('  rebuilt', t.id, t.kind, '->', newKind, 'ok=' + ok);
    }
  },
}));
// ④ 야간 마을 창호광
await run('night', () => shoot('night', '/__v4?scale=village&view=aerial&time=night'));
await run('night-eye', () => shoot('night-eye', '/__v4?scale=village&view=eye&time=night'));
// ⑤ 재현성(같은 seed 2컷 픽셀 동일) — adapter 자체 시드
await run('repro-a', () => shoot('repro-a', '/__v4?scale=village&view=aerial&time=day&seed=20260716'));
await run('repro-b', () => shoot('repro-b', '/__v4?scale=village&view=aerial&time=day&seed=20260716'));
// 애니메이션 정지 재현(순수 지오·텍스처 결정론 확인 — 물결 셰이더 제외)
await run('froze-a', () => shoot('froze-a', '/__v4?scale=village&view=aerial&time=day&seed=20260716&freeze=1'));
await run('froze-b', () => shoot('froze-b', '/__v4?scale=village&view=aerial&time=day&seed=20260716&freeze=1'));
// 일반 룩 sanity
await run('village-aerial', () => shoot('village-aerial', '/__v4?scale=village&view=aerial&time=day'));
await run('town-aerial', () => shoot('town-aerial', '/__v4?scale=town&view=aerial&time=sunset'));
await run('capital-eye', () => shoot('capital-eye', '/__v4?scale=capital&palace=1&temple=1&view=eye&time=sunset'));

console.log(`pageerror=${pageErrs} console-error=${consoleErrs}`);
await browser.close();
server.close();
