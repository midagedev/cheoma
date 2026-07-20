// 헤드리스 스크린샷: 마당 과실수·반가 정원·마을 보호수·동물(#41) 검증 → shots/gardens-*.png
// 사용법: node tools/shoot-gardens.mjs [필터]
//   /__flora 하네스: village group.userData 의 앵커(보호수·과실수·정원·닭·소)로 프레이밍,
//   setSeason/setAnimalsTime/update 를 직접 구동(앱 경로 불침해). 고정 dt 로 결정론.
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
import { planVillage } from '/src/village/plan.js';
import { populateVillage } from '/src/village/populate.js';
const q = new URLSearchParams(location.search);
const scale = q.get('scale') || 'village';
const seed = (() => { const s = q.get('seed'); return s != null ? (isNaN(+s) ? s : +s) : 20260716; })();
const character = q.get('char') || 'yeoyeom';
const time = q.get('time') || 'day';
const num = (k, d) => { const v = parseFloat(q.get(k)); return Number.isFinite(v) ? v : d; };
// 결정론: 팔레트·사립문이 Math.random 을 쓰므로 하네스에서 시드 고정(앱 소스 불침해).
{ let s = 0x2545f491 >>> 0; Math.random = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(innerWidth, innerHeight); renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.getElementById('app').appendChild(renderer.domElement);
const scene = new THREE.Scene();
const L = {
  day:    { bg: 0xcfd8e0, sun: [0xfff0dd, 2.5, [0.42,1.25,0.30]], hemi: [0xc4d6e8, 0x9a8c72, 1.25], exp: 1.05 },
  sunset: { bg: 0xe7b98f, sun: [0xffb066, 2.1, [0.7,0.7,0.42]], hemi: [0xd7b48c, 0x7a6a54, 1.0], exp: 1.0 },
}[time] || {};
scene.background = new THREE.Color(L.bg); renderer.toneMappingExposure = L.exp;

const plan = planVillage({ scale, seed, character });
const group = populateVillage(plan);
scene.add(group);
const R = plan.site.R;
scene.fog = new THREE.Fog(L.bg, R * 2.4, R * 7.0);
const sun = new THREE.DirectionalLight(L.sun[0], L.sun[1]);
sun.position.set(L.sun[2][0] * R, L.sun[2][1] * R, L.sun[2][2] * R);
sun.castShadow = true; sun.shadow.mapSize.set(4096, 4096);
const TR = plan.site.terrainR || R, sc = sun.shadow.camera;
sc.left = -TR * 1.05; sc.right = TR * 1.05; sc.top = TR * 1.05; sc.bottom = -TR * 1.05; sc.near = 1; sc.far = TR * 8;
sun.shadow.bias = -0.0003; sun.shadow.normalBias = 0.08; scene.add(sun);
scene.add(new THREE.HemisphereLight(L.hemi[0], L.hemi[1], L.hemi[2]));

const camera = new THREE.PerspectiveCamera(44, innerWidth / innerHeight, 0.5, R * 8);
// 기본 부감(보호수가 동구 전경에 걸리는 구도)
camera.position.set(0.18 * R, 1.02 * R, 1.98 * R);
camera.lookAt(0, 0.06 * R, -0.16 * R);

const U = group.userData;
window.__ANCH = {
  guardian: U.guardianAnchors || [], yardTree: U.yardTreeAnchors || [], garden: U.gardenAnchors || [],
  flock: U.flockCenters || [], cow: U.cowAnchors || [],
};
window.__STATS = { scale, seed, character: plan.opts.character, stats: plan.stats, floraDraws: U.flora ? U.flora.drawCalls : 0, flocks: (U.flockCenters||[]).length, cows: (U.cowAnchors||[]).length };
window.__setSeason = (s) => U.setSeason && U.setSeason(s);
window.__setAnimTime = (t) => U.setAnimalsTime && U.setAnimalsTime(t);
window.__advance = (secs) => { const n = Math.max(1, Math.round(secs / 0.05)); for (let i = 0; i < n; i++) U.update && U.update(0.05); };
window.__aim = (cx, cy, cz, tx, ty, tz, fov) => { camera.fov = fov || 44; camera.updateProjectionMatrix(); camera.position.set(cx, cy, cz); camera.lookAt(tx, ty, tz); };
window.__fov = (f) => { camera.fov = f; camera.updateProjectionMatrix(); };

// 프레임 12에서 sim 을 얼린다(캡처 결정론) — 이후 진행은 명시적 __advance 로만(재현 컷 픽셀 동일).
let frames = 0, frozen = false;
renderer.setAnimationLoop(() => {
  if (!frozen && U.update) U.update(1 / 60);
  renderer.render(scene, camera); frames++;
  if (frames === 12) {
    const ri = renderer.info;
    window.__STATS.perf = { calls: ri.render.calls, triangles: ri.render.triangles, geometries: ri.memory.geometries, textures: ri.memory.textures };
    frozen = true;
    window.__SHOT_READY = true;
  }
});
</script></body></html>`;

const server = createServer(async (req, res) => {
  const path = req.url.split('?')[0];
  if (path === '/__flora') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(HTML); return; }
  try {
    const file = join(ROOT, path === '/' ? 'index.html' : path);
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

let browser;
try { browser = await chromium.launch({ channel: 'chrome' }); }
catch { browser = await chromium.launch(); }
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
let pageErrs = 0, consoleErrs = 0;
page.on('console', (m) => { if (m.type() !== 'error') return; const t = m.text(); if (/favicon|404/.test(t)) return; consoleErrs++; console.error('[console]', t); });
page.on('pageerror', (e) => { pageErrs++; console.error('[pageerror]', e.message); });

async function open(qs) {
  await page.goto(`${base}/__flora?${qs}`, { waitUntil: 'load' });
  try { await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 45000 }); }
  catch { console.error('TIMEOUT', qs); }
  return page.evaluate(() => window.__STATS);
}
async function save(name) { const f = join(OUT, `gardens-${name}.png`); await page.screenshot({ path: f }); console.log('saved', f); }
const A = () => page.evaluate(() => window.__ANCH);

const filter = process.argv[2] || '';
const want = (n) => !filter || n.includes(filter);

// ① 부감 — 보호수 실루엣이 동구 전경을 지배
if (want('aerial')) {
  const s = await open('scale=village&time=day');
  console.log('village', JSON.stringify(s.stats), 'flora=' + s.floraDraws, 'flocks=' + s.flocks, 'cows=' + s.cows, 'perf=' + JSON.stringify(s.perf));
  await save('aerial-day');
  await open('scale=village&time=sunset');
  await save('aerial-sunset');
}

// ② 동구 진입 eye — 보호수 + 평상 프레임(키 샷)
if (want('donggu')) {
  await open('scale=village&time=day');
  const a = await A();
  if (a.guardian.length) {
    const g = a.guardian[0];
    // 보호수 남쪽(개울측, +z)에서 낮게 올려다보며 마을을 향함
    await page.evaluate(([x, y, z]) => window.__aim(x + 3, y + 3.5, z + 15, x, y + 6, z - 10, 46), [g.x, g.y, g.z]);
    await page.evaluate(() => window.__advance(0.4));
    await save('donggu-eye');
  } else console.log('보호수 앵커 없음');
}

// ③ 마당 클로즈업 — 과실수 + 닭 공존
if (want('yard')) {
  await open('scale=village&time=day');
  const a = await A();
  if (a.flock.length) {
    const f = a.flock[0];
    await page.evaluate(([x, y, z]) => window.__aim(x + 2.6, y + 1.7, z + 3.6, x, y - 0.1, z - 0.6, 40), [f.x, f.y, f.z]);
    await page.evaluate(() => window.__advance(0.7));
    await save('yard-chicken');
  } else console.log('닭 무리 없음');
}

// ④ 반가 정원 클로즈업 — 화계·괴석·석지 (뒤안을 뒷담 밖에서 본다)
if (want('garden')) {
  await open('scale=village&char=banchon&time=day');
  const a = await A();
  const g = a.garden[0] || a.yardTree[0];
  if (g) {
    // 담으로 둘러싸인 정원은 담 밖 눈높이로는 안 보임 → 상공 대각으로 담 너머 뒤안·사랑마당을 내려다봄.
    await page.evaluate(([x, y, z]) => window.__aim(x + 9, y + 11, z + 12, x, y, z - 1, 42), [g.x, g.y, g.z]);
    await page.evaluate(() => window.__advance(0.3));
    await save('banga-garden');
  } else console.log('정원 앵커 없음');
}

// ⑤ 계절 4종 — 봄 매화·살구 꽃 / 여름 신록 / 가을 감 열매 / 겨울 나목 (과실수 군집 프레임)
//   열매 수종을 중심에 두고 넓게 잡아 이웃 꽃 수종까지 프레임에 들어오게(같은 구도 4장 비교).
if (want('season')) {
  await open('scale=village&time=day');
  const a = await A();
  const t = a.yardTree.find((q) => q.accent === 'fruit') || a.yardTree[0] || a.guardian[0];
  if (t) {
    for (const sn of ['spring', 'summer', 'autumn', 'winter']) {
      await page.evaluate((s) => window.__setSeason(s), sn);
      await page.evaluate(([x, y, z]) => window.__aim(x + 9, y + 7, z + 13, x, y + 0.5, z - 2, 46), [t.x, t.y, t.z]);
      await page.evaluate(() => window.__advance(0.2));
      await save('season-' + sn);
    }
    await page.evaluate(() => window.__setSeason('summer'));
  }
}

// ⑥ 논 소 배치 컷
if (want('cow')) {
  await open('scale=village&time=day');
  const a = await A();
  if (a.cow.length) {
    const c = a.cow[0];
    await page.evaluate(([x, y, z]) => window.__aim(x - 8, y + 2.6, z + 5, x, y + 0.6, z, 42), [c.x, c.y, c.z]);
    await page.evaluate(() => window.__advance(2.0));
    await save('cow-paddy');
  } else console.log('소 없음(논 없는 규모?)');
}

// ⑦ 캐릭터 3종 회귀 + 규모 회귀(크래시·앵커 카운트 점검)
if (want('regress')) {
  for (const ch of ['minchon', 'yeoyeom', 'banchon']) {
    const s = await open(`scale=village&char=${ch}&time=day`);
    console.log('char', ch, 'flora=' + s.floraDraws, 'flocks=' + s.flocks, 'cows=' + s.cows, 'perf=' + JSON.stringify(s.perf));
    await save('regress-' + ch);
  }
  for (const sk of ['hamlet', 'town', 'capital']) {
    const s = await open(`scale=${sk}&time=day`);
    console.log('scale', sk, JSON.stringify(s.stats), 'flora=' + s.floraDraws, 'flocks=' + s.flocks, 'cows=' + s.cows, 'perf=' + JSON.stringify(s.perf));
    await save('regress-' + sk);
  }
}

// 재현성(같은 seed 2컷 픽셀 동일)
if (want('repro')) {
  await open('scale=village&time=day'); await save('repro-a');
  await open('scale=village&time=day'); await save('repro-b');
}

console.log(`pageerror=${pageErrs} console-error=${consoleErrs}`);
await browser.close();
server.close();
