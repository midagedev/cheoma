// #89 스케일 연속화 검증 — 부감 컷(shots/scale-*.png) + 게이트 메타(호수·성곽·시전·궁 tier·char01·성능).
//   어댑터(createVillage) 경로로 렌더 → baseY·char01 자동화·성곽/시전/궁 임계까지 실제 앱 경로로 확인.
//   scale 은 프리셋명 또는 숫자 siteR(m). 전용 포트 4207(사용자 dev 5174 미접촉), 소스 직접 서빙+importmap.
// 사용법: node tools/shoot-scale.mjs [필터] [--tmp]
//   --tmp: 중간 검증컷을 scratchpad/scale 로(shots 오염 방지). 기본은 shots/scale-*.png(게이트 증거).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..');
const PORT = 4207;
const args = process.argv.slice(2);
const useTmp = args.includes('--tmp');
const filter = args.find((a) => !a.startsWith('--')) || '';
const OUT = useTmp
  ? '/private/tmp/claude-501/-Users-hckim-repo-asiahouse/7a15478e-68e3-4ad3-b08a-bdb86ae4fe92/scratchpad/scale'
  : join(ROOT, 'shots');
mkdirSync(OUT, { recursive: true });
const prefix = useTmp ? '' : 'scale-';

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
const q = new URLSearchParams(location.search);
const scaleRaw = q.get('scale') || 'village';
const scale = isNaN(+scaleRaw) ? scaleRaw : +scaleRaw;     // 숫자면 siteR(m), 아니면 프리셋명
const seed = q.get('seed') != null ? (isNaN(+q.get('seed')) ? q.get('seed') : +q.get('seed')) : 20260716;
const includePalace = q.get('palace') === '1';
const includeTemple = q.get('temple') === '1';
const time = q.get('time') || 'day';

// 결정론 렌더(팔레트·싸리문 Math.random 고정) — 재현 컷 픽셀 동일.
{ let s = 0x2545f491 >>> 0; Math.random = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

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

const handle = createVillage({ scale, seed, includePalace, includeTemple });
handle.setTime(time);
scene.add(handle.group);
const plan = handle.plan;
const site = plan.site;
const R = site.R;
const F = plan.features || {};
window.__PLAN = {
  scaleIn: scaleRaw, R: +R.toFixed(1), siteR: +(plan.opts.siteR||R).toFixed(1),
  tier: plan.opts.scale, scale01: +(plan.opts.scale01||0).toFixed(3),
  char01: +(plan.opts.char01||0).toFixed(3), character: plan.opts.character,
  terrainR: +(site.terrainR||R).toFixed(0), bowlR: +site.bowlR.toFixed(0),
  houses: plan.stats.houses, giwa: plan.stats.giwa, choga: plan.stats.choga,
  cityWall: !!F.cityWall, gates: F.cityWall ? F.cityWall.gates.length : 0,
  sijeon: F.sijeon ? F.sijeon.length : 0,
  palace: F.palace ? F.palace.tier : (F.govCore ? 'govCore' : null),
  paddies: plan.stats.paddies, warnings: plan.warnings,
};

scene.fog = new THREE.Fog(L.bg, R * 2.4, R * 7.0);
const sun = new THREE.DirectionalLight(L.sun[0], L.sun[1]);
sun.position.set(L.sun[2][0] * R, L.sun[2][1] * R, L.sun[2][2] * R);
sun.castShadow = true; sun.shadow.mapSize.set(4096, 4096);
const TR = site.terrainR || R;
const sc = sun.shadow.camera;
sc.left = -TR * 1.05; sc.right = TR * 1.05; sc.top = TR * 1.05; sc.bottom = -TR * 1.05;
sc.near = 1; sc.far = TR * 8; sun.shadow.bias = -0.0003; sun.shadow.normalBias = 0.08;
scene.add(sun);
scene.add(new THREE.HemisphereLight(L.hemi[0], L.hemi[1], L.hemi[2]));

// 부감(마을 전규모 프레이밍, shoot-relief aerial 과 동일 앵글)
const fov = 44;
const camera = new THREE.PerspectiveCamera(fov, innerWidth / innerHeight, 0.5, R * 8);
camera.position.set(0.18 * R, 1.02 * R, 1.98 * R);
camera.lookAt(0, 0.06 * R, -0.16 * R);

let frames = 0;
renderer.setAnimationLoop(() => {
  handle.update(1 / 60);
  renderer.render(scene, camera);
  frames++;
  if (frames === 14) {
    const ri = renderer.info;
    window.__PLAN.perf = { calls: ri.render.calls, triangles: ri.render.triangles, geometries: ri.memory.geometries, textures: ri.memory.textures };
    window.__SHOT_READY = true;
  }
});
</script></body></html>`;

const server = createServer(async (req, res) => {
  const path = req.url.split('?')[0];
  if (path === '/__scale') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(HTML); return; }
  try {
    const file = join(ROOT, path === '/' ? 'index.html' : path);
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise((ok, no) => server.listen(PORT, '127.0.0.1', ok).on('error', no));

// 게이트 컷 목록 — ① 5앵커 회귀 ② 연속성(중간 R) ③ 성곽 등장 전후 쌍 ④ char01 지터(동R 2시드)
const shots = [
  // ① 5 앵커(프리셋명) — 궁은 capital/hanyang
  ['hamlet',  'scale=hamlet'],
  ['village', 'scale=village'],
  ['town',    'scale=town'],
  ['capital', 'scale=capital&palace=1'],
  ['hanyang', 'scale=hanyang&palace=1'],
  // ② 연속성 — 중간 임의 R
  ['R100', 'scale=100'],
  ['R210', 'scale=210'],
  ['R370', 'scale=370&palace=1'],
  ['R440', 'scale=440&palace=1'],
  // ③ 성곽 등장 전후 쌍(임계 R400): 380=성곽 없는 대형 도성, 420=성곽 도성
  ['R380-precwall', 'scale=380&palace=1'],
  ['R420-wall',     'scale=420&palace=1'],
  // ④ char01 자동화(동일 R=176, 시드 2종 — 지터 확인)
  ['R176-seedA', 'scale=176&seed=20260716'],
  ['R176-seedB', 'scale=176&seed=77777'],
].filter(([name]) => !filter || name.includes(filter));

let browser;
try { browser = await chromium.launch({ channel: 'chrome' }); }
catch { browser = await chromium.launch(); }
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
let pageErrs = 0, consoleErrs = 0;
page.on('console', (m) => { if (m.type() !== 'error') return; const t = m.text(); if (/favicon|404/.test(t)) return; consoleErrs++; console.error('[console]', t); });
page.on('pageerror', (e) => { pageErrs++; console.error('[pageerror]', e.message); });

console.log('name         | in    | R    tier    | c01  | houses(g/c)  | pad | trR/bwR| wall | sije | palace  | calls | tris(M)');
for (const [name, qs] of shots) {
  await page.goto(`http://127.0.0.1:${PORT}/__scale?${qs}`, { waitUntil: 'load' });
  try { await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 45000 }); }
  catch { console.error('TIMEOUT', name); continue; }
  await page.waitForTimeout(200);
  const p = await page.evaluate(() => window.__PLAN);
  const file = join(OUT, `${prefix}${name}.png`);
  await page.screenshot({ path: file });
  const pf = p.perf || {};
  const row = [
    (name + '            ').slice(0, 12),
    (p.scaleIn + '     ').slice(0, 5),
    (Math.round(p.R) + '  ').slice(0, 4) + (p.tier + '       ').slice(0, 8),
    p.char01.toFixed(2),
    ((p.houses + '(' + p.giwa + '/' + p.choga + ')') + '          ').slice(0, 12),
    (p.paddies + '').padEnd(3),
    (p.terrainR + '/' + p.bowlR).padEnd(6).slice(0, 6),
    (p.cityWall ? 'Y' + p.gates : '-').padEnd(4),
    (p.sijeon + '').padEnd(4),
    (p.palace || '-').padEnd(7),
    (pf.calls + '').padEnd(5),
    ((pf.triangles / 1e6).toFixed(2)),
  ].join(' | ');
  console.log(row + (p.warnings && p.warnings.length ? '  WARN:' + p.warnings.join(';') : ''));
}
console.log(`\nsaved to ${OUT}/${prefix}*.png   pageerror=${pageErrs} console-error=${consoleErrs}`);
await browser.close();
server.close();
