// 헤드리스 스크린샷: 마을 리롤 웨이브(#56) 검증.
// 사용법: NODE_PATH=/Users/hckim/repo/threesur/node_modules node tools/shoot-wave.mjs [필터]
//   앱 경로 독립 — createVillage(구/신 시드) 2벌을 씬에 얹고 createRerollWave 로 구동, progress 를
//   seek(t01) 로 고정해 각 시점을 캡처(/__valley·/__focus 하네스 문법 계승, 전용 포트 4200).
//   모든 컷은 스크래치패드(SCRATCH)에, 게이트 증거 컷만 shots/wave-*.png 로도 저장.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'shots');
const SCRATCH = '/private/tmp/claude-501/-Users-hckim-repo-asiahouse/7a15478e-68e3-4ad3-b08a-bdb86ae4fe92/scratchpad';
mkdirSync(OUT, { recursive: true });
mkdirSync(SCRATCH, { recursive: true });
const PORT = 4200;

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json',
};

const HTML = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>html,body{margin:0;height:100%;overflow:hidden}#app{width:100%;height:100%}</style>
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.185.1/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.185.1/examples/jsm/"}}</script>
</head><body><div id="app"></div>
<script type="module">
import * as THREE from 'three';
import { createVillage } from '/src/village/adapter.js';
import { createRerollWave } from '/src/village/wave.js';
const q = new URLSearchParams(location.search);
const scale = q.get('scale') || 'village';
const seedA = +(q.get('seedA') || 20260716);
const seedB = +(q.get('seedB') || 777);
const character = q.get('char') || 'yeoyeom';
const includePalace = q.get('palace') === '1';
const includeTemple = q.get('temple') === '1';
const view = q.get('view') || 'aerial';
const time = q.get('time') || 'day';
const mode = q.get('mode') || 'wave';        // wave | direct(신 마을 단독=완료 기준 비교)
const t = parseFloat(q.get('t') || '0');     // progress 0..1 (seek 고정)
const num = (k, d) => { const v = parseFloat(q.get(k)); return Number.isFinite(v) ? v : d; };

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight); renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.getElementById('app').appendChild(renderer.domElement);
const scene = new THREE.Scene();

const L = {
  day:    { bg: 0xcfd8e0, sun: [0xfff0dd, 2.5, [0.42,1.25,0.30]], hemi: [0xc4d6e8, 0x9a8c72, 1.25], exp: 1.05 },
  sunset: { bg: 0xe7b98f, sun: [0xffb066, 2.1, [0.7,0.7,0.42]], hemi: [0xd7b48c, 0x7a6a54, 1.0], exp: 1.0 },
}[time] || {};
scene.background = new THREE.Color(L.bg);
renderer.toneMappingExposure = L.exp;

// 신 마을(항상) — 완료 기준·direct 모드 공용
const newH = createVillage({ scale, seed: seedB, character, includePalace, includeTemple });
scene.add(newH.group);
const site = newH.plan.site;
let wave = null, oldH = null;
if (mode === 'wave') {
  oldH = createVillage({ scale, seed: seedA, character, includePalace, includeTemple });
  scene.add(oldH.group);
  wave = createRerollWave({
    oldRoot: oldH.group, newRoot: newH.group,
    center: site.center, heightAt: site.heightAt, seed: seedB,
  });
  wave.seek(t);
}

window.__PLAN = { scale, seedA, seedB, mode, t, R: site.R, stats: newH.plan.stats };

const R = site.R;
scene.fog = new THREE.Fog(L.bg, R * 2.4, R * 7.0);

const sun = new THREE.DirectionalLight(L.sun[0], L.sun[1]);
sun.position.set(L.sun[2][0] * R, L.sun[2][1] * R, L.sun[2][2] * R);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
const TR = site.terrainR || R;
const sc = sun.shadow.camera;
sc.left = -TR * 1.05; sc.right = TR * 1.05; sc.top = TR * 1.05; sc.bottom = -TR * 1.05;
sc.near = 1; sc.far = TR * 8;
sun.shadow.bias = -0.0003; sun.shadow.normalBias = 0.08;
scene.add(sun);
scene.add(new THREE.HemisphereLight(L.hemi[0], L.hemi[1], L.hemi[2]));

let campos, target, fov;
if (view === 'aerial') {
  fov = 44;
  campos = new THREE.Vector3(0.18 * R, 1.02 * R, 1.98 * R);
  target = new THREE.Vector3(0, 0.06 * R, -0.16 * R);
} else {
  const camZ = site.streamZ + R * 0.34;
  const cx0 = R * 0.04;
  const gy = site.heightAt(cx0, camZ);
  fov = 52;
  campos = new THREE.Vector3(cx0, gy + 2.4, camZ);
  target = new THREE.Vector3(0, site.heightAt(0, site.center.z) + 5, site.center.z * 0.55);
}
const camera = new THREE.PerspectiveCamera(fov, innerWidth / innerHeight, 0.5, R * 8);
camera.position.set(num('cx', campos.x), num('cy', campos.y), num('cz', campos.z));
camera.lookAt(num('tx', target.x), num('ty', target.y), num('tz', target.z));

let frames = 0;
renderer.setAnimationLoop(() => {
  renderer.render(scene, camera); frames++;
  if (frames === 10) {
    const ri = renderer.info;
    window.__PLAN.perf = { calls: ri.render.calls, triangles: ri.render.triangles };
    window.__SHOT_READY = true;
  }
});
</script></body></html>`;

const server = createServer(async (req, res) => {
  const path = req.url.split('?')[0];
  if (path === '/__wave') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(HTML); return; }
  try {
    const file = join(ROOT, path === '/' ? 'index.html' : path);
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise((ok) => server.listen(PORT, '127.0.0.1', ok));

const filter = process.argv[2] || '';
// gate=true → shots/wave-*.png 로도 저장(게이트 증거). 그 외는 스크래치패드 전용.
const P = (scale, tags) => tags.map(([tag, qs, gate]) => [`${scale}-${tag}`, `/__wave?scale=${scale}&${qs}`, gate]);
const seq = (scale) => [
  ['t00',         `t=0&view=aerial&time=day`, true],    // progress 0: 옛 마을 온전
  ['t25',         `t=0.25&view=aerial&time=day`, true],  // progress .25: 해체 진행
  ['t35-disasm',  `t=0.35&view=aerial&time=day`, true],  // 해체 중간(중심 빔·외곽 초가 잔존)
  ['t50-terrain', `t=0.50&view=aerial&time=day`, true],  // progress .5: 지형 크로스페이드(집 전무)
  ['t65-asm',     `t=0.65&view=aerial&time=day`, true],  // 조립 중간(중심 완성·외곽 상승 중)
  ['t75',         `t=0.75&view=aerial&time=day`, true],  // progress .75: 조립 확산
  ['t100',        `t=1.0&view=aerial&time=day`, true],   // progress 1.0: 완료(신 마을 정상)
  ['direct',      `mode=direct&view=aerial&time=day`, true], // 신 마을 단독(=완료 픽셀 기준)
];
const shots = [...P('village', seq('village')), ...P('hanyang', seq('hanyang'))]
  .filter(([name]) => !filter || name.includes(filter));

let browser;
try { browser = await chromium.launch({ channel: 'chrome' }); }
catch { browser = await chromium.launch(); }
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
let pageErrs = 0, consoleErrs = 0;
page.on('console', (msg) => {
  if (msg.type() !== 'error') return;
  const tx = msg.text();
  if (/favicon\.ico/.test(tx) || /status of 404/.test(tx)) return;
  consoleErrs++; console.error('[console]', tx);
});
page.on('pageerror', (err) => { pageErrs++; console.error('[pageerror]', err.message); });

for (const [name, qs, gate] of shots) {
  const url = `http://127.0.0.1:${PORT}${qs}`;
  await page.goto(url, { waitUntil: 'load' });
  try { await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 60000 }); }
  catch { console.error('TIMEOUT', name); }
  await page.waitForTimeout(200);
  const info = await page.evaluate(() => window.__PLAN || null);
  if (info) console.log(name, 'perf=' + JSON.stringify(info.perf || {}), 'stats=' + JSON.stringify(info.stats || {}));
  await page.screenshot({ path: join(SCRATCH, `wave-${name}.png`) });
  if (gate) await page.screenshot({ path: join(OUT, `wave-${name}.png`) });
  console.log('saved', name, gate ? '(gate)' : '');
}
console.log(`pageerror=${pageErrs} console-error=${consoleErrs} (favicon 404 제외)`);

await browser.close();
server.close();
