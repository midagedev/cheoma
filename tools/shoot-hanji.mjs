// 헤드리스 검증(태스크 #66): 야간 창호·문 발광 현실화(톤다운 + 문(門) 발광).
//   단일 씬 4프리셋(korea/temple/giwa/choga)을 밤에 3/4·closeup 으로 렌더.
//   → 기본 출력 scratchpad/hanji/ (반복), HANJI_OUT=shots 로 최종 게이트(hanji-*.png).
// 앱 단일건물 경로 재현(main.js 준용): scene sun/hemi/fill → setupEnvironment → setupPost →
//   buildBuilding → setupNightGlow(setEnabled·setTime·update) → post.composer.render.
//   매 프레임 nightGlow.update(dt) 로 창호 emissive·실내 등불 크로스페이드/촛불 일렁임.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = process.env.HANJI_OUT
  ? (process.env.HANJI_OUT === 'shots' ? join(ROOT, 'shots') : resolve(process.env.HANJI_OUT))
  : '/private/tmp/claude-501/-Users-hckim-repo-asiahouse/7a15478e-68e3-4ad3-b08a-bdb86ae4fe92/scratchpad/hanji';
const PREFIX = process.env.HANJI_OUT === 'shots' ? 'hanji-' : '';
mkdirSync(OUT, { recursive: true });

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json',
};

const HTML = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>html,body{margin:0;height:100%;overflow:hidden;background:#000}#app{width:100%;height:100%}</style>
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.185.1/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.185.1/examples/jsm/"}}</script>
</head><body><div id="app"></div>
<script type="module">
import * as THREE from 'three';
import { computeLayout, PRESETS } from '/src/params.js';
import { buildBuilding } from '/src/builder/index.js';
import { setupEnvironment } from '/src/env/index.js';
import { setupPost } from '/src/env/post.js';
import { setupNightGlow } from '/src/env/night-glow.js';

const q = new URLSearchParams(location.search);
const preset = q.get('preset') || 'korea';
const time = q.get('time') || 'night';
const view = q.get('view') || '3q';         // 3q | closeup | back
const num = (k, d) => { const v = parseFloat(q.get(k)); return Number.isFinite(v) ? v : d; };

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
document.getElementById('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xcfd8e0);
scene.fog = new THREE.Fog(0xcfd8e0, 60, 220);

const sun = new THREE.DirectionalLight(0xfff0dd, 2.6);
sun.position.set(30, 42, 26);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -22; sun.shadow.camera.right = 22;
sun.shadow.camera.top = 22; sun.shadow.camera.bottom = -22;
sun.shadow.bias = -0.0001; sun.shadow.normalBias = 0.05;
scene.add(sun);
const hemi = new THREE.HemisphereLight(0xbdd0e4, 0x8a7a63, 0.9);
scene.add(hemi);
const fill = new THREE.DirectionalLight(0xff9a5c, 0);
fill.castShadow = false; scene.add(fill); scene.add(fill.target);

const ground = new THREE.Mesh(
  new THREE.CircleGeometry(160, 48),
  new THREE.MeshStandardMaterial({ color: 0xb5a893, roughness: 1 }));
ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);

const P = { ...PRESETS[preset] };
const env = setupEnvironment(scene, { sun, hemi, renderer, layout: computeLayout(P) });
const camera = new THREE.PerspectiveCamera(38, innerWidth / innerHeight, 0.1, 500);
const post = setupPost({ renderer, scene, camera });
post.setSize(innerWidth, innerHeight);

env.setTime(time); env.setEnabled(true); post.setTime(time);

let building = buildBuilding(P);
scene.add(building);

const nightGlow = setupNightGlow({ getBuilding: () => building });
nightGlow.setEnabled(true);
nightGlow.setTime(time);

// 건물 바운딩으로 자동 프레이밍(프리셋 무관 일관 컷).
const box = new THREE.Box3().setFromObject(building);
const c = box.getCenter(new THREE.Vector3());
const size = box.getSize(new THREE.Vector3());
const maxDim = Math.max(size.x, size.y, size.z);
window.__PLAN = { preset, time, view, size: [size.x, size.y, size.z].map((v)=>+v.toFixed(2)) };

let campos, target, fov;
const DEG = Math.PI / 180;
if (view === 'closeup') {
  // 정면(+z) 창호·문 근접(살·한지 발광 편차 확인).
  fov = 34;
  campos = new THREE.Vector3(c.x - size.x * 0.18, c.y + size.y * 0.05, c.z + maxDim * 0.95);
  target = new THREE.Vector3(c.x - size.x * 0.18, c.y - size.y * 0.05, c.z);
} else if (view === 'back') {
  fov = 40;
  campos = new THREE.Vector3(c.x + maxDim * 0.9, c.y + size.y * 0.35, c.z - maxDim * 0.9);
  target = new THREE.Vector3(c.x, c.y, c.z);
} else { // 3q: 정면+측면 함께(문 발광 + 창 발광 위계)
  fov = 36;
  const az = 32 * DEG, el = 16 * DEG, r = maxDim * 2.0;
  campos = new THREE.Vector3(c.x + r * Math.cos(el) * Math.sin(az), c.y + size.y * 0.28 + r * Math.sin(el), c.z + r * Math.cos(el) * Math.cos(az));
  target = new THREE.Vector3(c.x, c.y + size.y * 0.02, c.z);
}
camera.fov = num('fov', fov);
camera.position.set(num('cx', campos.x), num('cy', campos.y), num('cz', campos.z));
camera.lookAt(num('tx', target.x), num('ty', target.y), num('tz', target.z));
camera.updateProjectionMatrix();

// 발광 계측: 화면 웜(붉은기) 밝은 픽셀 분포 — 형광등(과다 blowout) 판정용.
function glowStats() {
  const cvs = renderer.domElement, w = cvs.width, h = cvs.height;
  const c2 = document.createElement('canvas'); c2.width = w; c2.height = h;
  const ctx = c2.getContext('2d'); ctx.drawImage(cvs, 0, 0);
  const data = ctx.getImageData(0, 0, w, h).data;
  let hot = 0, warm = 0, sum = 0, maxL = 0, npx = w * h;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const L = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    sum += L; if (L > maxL) maxL = L;
    if (r > b + 18 && L > 0.30) warm++;         // 따뜻한 발광 픽셀
    if (r > 210 && g > 190 && L > 0.82) hot++;   // 형광 blowout(거의 흰 크림)
  }
  return { warmPct: +(100 * warm / npx).toFixed(3), hotPct: +(100 * hot / npx).toFixed(3), maxL: +maxL.toFixed(3), meanL: +(sum / npx).toFixed(4) };
}
// 패치된 창호 재질 덤프(문 발광 검증): 이름/역할/emissiveIntensity.
function glowDump() {
  const seen = new Map();
  building.traverse((o) => {
    const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
    for (const m of mats) {
      if (!m) continue;
      const hg = m.userData && m.userData.hanjiGlow;
      const ei = m.emissiveIntensity;
      const emHex = m.emissive ? m.emissive.getHexString() : '?';
      if (hg != null || (m.emissive && (m.emissive.r + m.emissive.g + m.emissive.b) > 0.15)) {
        const key = (m.name || '') + ':' + emHex + ':' + (+ei.toFixed(3)) + ':hg' + (hg ?? '-');
        seen.set(key, (seen.get(key) || 0) + 1);
      }
    }
  });
  return Array.from(seen.entries()).map(([k, n]) => k + ' x' + n);
}

let frame = 0;
renderer.setAnimationLoop(() => {
  env.update(1 / 60);            // #50 시간대 크로스페이드(fog/sky/exposure) 수렴
  nightGlow.update(1 / 60);
  post.update();
  frame++;
  if (frame === 20) {
    post.composer.render();
    window.__STATS = glowStats();
    window.__GLOW = glowDump();
    window.__SHOT_READY = true;
  } else { post.composer.render(); }
});
</script></body></html>`;

const server = createServer(async (req, res) => {
  const path = req.url.split('?')[0];
  if (path === '/__hanji') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(HTML); return; }
  try {
    const file = join(ROOT, path === '/' ? 'index.html' : path);
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const port = server.address().port;

const filter = process.argv[2] || '';
const presets = ['korea', 'temple', 'giwa', 'choga'];
const views = ['3q', 'closeup'];
const shots = [];
for (const p of presets) for (const v of views) shots.push([`${p}-${v}`, `/__hanji?preset=${p}&view=${v}&time=night`, 1280, 800]);
const list = shots.filter(([name]) => !filter || name.includes(filter));

let browser;
try { browser = await chromium.launch({ channel: 'chrome' }); }
catch { browser = await chromium.launch(); }

let pageErrs = 0, consoleErrs = 0;
for (const [name, qs, vw, vh] of list) {
  const page = await browser.newPage({ viewport: { width: vw, height: vh } });
  page.on('console', (msg) => { if (msg.type() === 'error') { const t = msg.text(); if (!/favicon|404/.test(t)) { consoleErrs++; console.error('[console]', name, t); } } });
  page.on('pageerror', (err) => { pageErrs++; console.error('[pageerror]', name, err.message); });
  await page.goto(`http://127.0.0.1:${port}${qs}`, { waitUntil: 'load' });
  try { await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 40000 }); }
  catch { console.error('TIMEOUT', name); }
  await page.waitForTimeout(120);
  const info = await page.evaluate(() => ({ plan: window.__PLAN, stats: window.__STATS, glow: window.__GLOW }));
  await page.screenshot({ path: join(OUT, `${PREFIX}${name}.png`) });
  const s = info.stats || {};
  console.log(`${name.padEnd(16)} warm%=${s.warmPct} hot%=${s.hotPct} maxL=${s.maxL} meanL=${s.meanL} sz=${JSON.stringify(info.plan?.size)}`);
  if (info.glow && info.glow.length) console.log('   glow:', info.glow.join(' | '));
  await page.close();
}
console.log(`pageerror=${pageErrs} console-error=${consoleErrs}`);
await browser.close();
server.close();
