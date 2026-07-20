// #91 마을 생성 옵션 표면화 검증 — 부감 컷(shots/vopts-*.png) + 게이트 메타(호수·성곽·시전·논·트리·성능).
//   어댑터(createVillage) 경로로 렌더 → 옵션이 실제 앱 경로(planVillage→populateVillage)로 흐르는지 확인.
//   opts 는 JSON 으로 ?o= 에 실어 브라우저가 createVillage 로 그대로 spread. 전용 포트 4211(사용자 dev 5174
//   미접촉), 소스 직접 서빙 + importmap(shoot-scale/templesite 패턴).
// 사용법: node tools/shoot-vopts.mjs [필터] [--tmp]
//   --tmp: 중간 검증컷을 scratchpad/vopts 로(shots 오염 방지). 기본은 shots/vopts-*.png(게이트 증거).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..');
const PORT = 4211;
const args = process.argv.slice(2);
const useTmp = args.includes('--tmp');
const filter = args.find((a) => !a.startsWith('--')) || '';
const OUT = useTmp
  ? '/private/tmp/claude-501/-Users-hckim-repo-asiahouse/7a15478e-68e3-4ad3-b08a-bdb86ae4fe92/scratchpad/vopts'
  : join(ROOT, 'shots');
mkdirSync(OUT, { recursive: true });
const prefix = useTmp ? '' : 'vopts-';

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
const opts = JSON.parse(q.get('o') || '{}');
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

if (opts.seed == null) opts.seed = 20260716;
const handle = createVillage(opts);
handle.setTime(time);
scene.add(handle.group);
const plan = handle.plan;
const site = plan.site;
const R = site.R;
const F = plan.features || {};
const tri = plan.opts.tuning || {};
window.__PLAN = {
  R: +R.toFixed(1), tier: plan.opts.scale, char01: +(plan.opts.char01||0).toFixed(3),
  charOverride: !!plan.opts.charOverride,
  houses: plan.stats.houses, giwa: plan.stats.giwa, choga: plan.stats.choga,
  paddies: plan.stats.paddies,
  hasStream: !!site.stream,
  cityWall: !!F.cityWall, gates: F.cityWall ? F.cityWall.gates.length : 0,
  sijeon: F.sijeon ? F.sijeon.length : 0,
  palace: F.palace ? F.palace.tier : (F.govCore ? 'govCore' : null),
  temple: !!F.temple,
  tuning: tri, warnings: plan.warnings,
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

// 부감(마을 전규모 프레이밍, shoot-scale 과 동일 앵글)
const camera = new THREE.PerspectiveCamera(44, innerWidth / innerHeight, 0.5, R * 8);
camera.position.set(0.18 * R, 1.02 * R, 1.98 * R);
camera.lookAt(0, 0.06 * R, -0.16 * R);

let frames = 0;
renderer.setAnimationLoop(() => {
  handle.update(1 / 60);
  renderer.render(scene, camera);
  frames++;
  if (frames === 14) {
    const ri = renderer.info;
    window.__PLAN.perf = { calls: ri.render.calls, triangles: ri.render.triangles };
    window.__SHOT_READY = true;
  }
});
</script></body></html>`;

const server = createServer(async (req, res) => {
  const path = req.url.split('?')[0];
  if (path === '/__vopts') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(HTML); return; }
  try {
    const file = join(ROOT, path === '/' ? 'index.html' : path);
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise((ok, no) => server.listen(PORT, '127.0.0.1', ok).on('error', no));

// ── 게이트 컷 목록 ── ① 대표 옵션 min/max 대비 쌍(village 규모) ② 극단 조합 스트레스 ③ 무옵션 앵커 ④ capital
const V = { scale: 'village' };
const shots = [
  // ③ 무옵션 앵커(scale-village.png 와 동일해야 — 무회귀)
  ['anchor-village', { ...V }],
  // ① 지형: 기복(undAmp)
  ['undamp-min', { ...V, undAmpK: 0 }],
  ['undamp-max', { ...V, undAmpK: 2.2 }],
  // ① 지형: 배산 능선 높이(ridgeH)
  ['ridge-min', { ...V, ridgeHK: 0.5 }],
  ['ridge-max', { ...V, ridgeHK: 1.6 }],
  // ① 지형: 개울 사행(meander) + 개울 유무
  ['stream-straight', { ...V, streamMeanderK: 0 }],
  ['stream-winding', { ...V, streamMeanderK: 2.5 }],
  ['stream-off', { ...V, stream: false }],
  // ① 구성: 논 밀도
  ['paddy-min', { ...V, paddyDensityK: 0.2 }],
  ['paddy-max', { ...V, paddyDensityK: 2.0 }],
  // ① 구성: 나무 밀도
  ['tree-min', { ...V, treeDensityK: 0.15 }],
  ['tree-max', { ...V, treeDensityK: 2.0 }],
  // ① 어휘: 담장 스타일 분포(전부 개방·울 vs 전부 기와담)
  ['wall-rustic', { ...V, wallWeights: { open: 3, brush: 3, hedge: 2, tile: 0, stone: 0.2, mud: 0.5 } }],
  ['wall-masonry', { ...V, wallWeights: { tile: 3, stone: 1.5, mud: 0.2, brush: 0, hedge: 0, open: 0 } }],
  // ① 어휘: 초가/기와 비율(char01 오버라이드)
  ['char-minchon', { ...V, char01: 0.05 }],
  ['char-banchon', { ...V, char01: 0.95 }],
  // ① 어휘: 다양성 강도
  ['diversity-min', { ...V, diversityK: 0 }],
  ['diversity-max', { ...V, diversityK: 2.0 }],
  // ① 구성: 성곽 강제 ON(hanyang 미만에서도 완전형)
  ['citywall-force-village', { ...V, cityWall: true }],
  ['citywall-force-town', { scale: 'town', cityWall: true }],
  // ② 극단 조합 스트레스(전부 max)
  ['stress-allmax-village', { ...V, undAmpK: 2.2, ridgeHK: 1.6, streamMeanderK: 2.5, treeDensityK: 2.0, paddyDensityK: 2.0, diversityK: 2.0, char01: 0.9, cityWall: true, wallWeights: { tile: 3, stone: 2 } }],
  // ④ capital 1컷(궁 + 시전 강제 ON + 담장 격식)
  ['capital-sijeon-force', { scale: 'capital', includePalace: true, sijeon: true, char01: 0.9 }],
].filter(([name]) => !filter || name.includes(filter));

let browser;
try { browser = await chromium.launch({ channel: 'chrome' }); }
catch { browser = await chromium.launch(); }
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
let pageErrs = 0, consoleErrs = 0;
page.on('console', (m) => { if (m.type() !== 'error') return; const t = m.text(); if (/favicon|404/.test(t)) return; consoleErrs++; console.error('[console]', t); });
page.on('pageerror', (e) => { pageErrs++; console.error('[pageerror]', e.message); });

console.log('name                      | R    tier    | c01(ov) | houses(g/c)  | pad | strm | wall  | sije | tris(M) | calls');
for (const [name, opts] of shots) {
  const url = `http://127.0.0.1:${PORT}/__vopts?o=${encodeURIComponent(JSON.stringify(opts))}`;
  await page.goto(url, { waitUntil: 'load' });
  try { await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 45000 }); }
  catch { console.error('TIMEOUT', name); continue; }
  await page.waitForTimeout(160);
  const p = await page.evaluate(() => window.__PLAN);
  const file = join(OUT, `${prefix}${name}.png`);
  await page.screenshot({ path: file });
  const pf = p.perf || {};
  const row = [
    (name + '                          ').slice(0, 25),
    (Math.round(p.R) + '  ').slice(0, 4) + (p.tier + '       ').slice(0, 8),
    (p.char01.toFixed(2) + (p.charOverride ? '*' : ' ')).padEnd(7),
    ((p.houses + '(' + p.giwa + '/' + p.choga + ')') + '          ').slice(0, 12),
    (p.paddies + '').padEnd(3),
    (p.hasStream ? 'Y' : '-').padEnd(4),
    (p.cityWall ? 'W' + p.gates : '-').padEnd(5),
    (p.sijeon + '').padEnd(4),
    ((pf.triangles / 1e6).toFixed(2)).padEnd(7),
    (pf.calls + ''),
  ].join(' | ');
  console.log(row + (p.warnings && p.warnings.length ? '  WARN:' + p.warnings.join(';') : ''));
}
console.log(`\nsaved to ${OUT}/${prefix}*.png   pageerror=${pageErrs} console-error=${consoleErrs}`);
await browser.close();
server.close();
