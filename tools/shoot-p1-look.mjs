// P1′ 조명 리그·하늘 돔 라운드 캡처 하네스 (2026-08-01, 미등록 standalone).
//
// shoot-village-light.mjs 의 "앱 경로" 셋업을 그대로 따르되 세 가지를 더한다:
//   ① mode=solo — 마을 없이 단독 건물 + env 만. mountains(능선·mist 띠)가 보이는 유일한 모드라
//      ⑤ "mist·ridgeFar 가 fog 보다 8~10배 밝다" 의 지평 띠 실재 여부를 여기서 판정한다.
//   ② view=eye — 아이레벨 카메라를 **지형에 대해 푼다**. 기존 eye 프레이밍은 근평면 지형판에
//      막혀 판정이 불가능했다. 후보 방위·거리를 돌면서 카메라→피사체 시선이 지형을 뚫지 않는
//      (최소 여유 ≥ EYE_MIN_CLEARANCE) 첫 해를 고르고, 고른 파라미터를 window.__PLAN.camera 로
//      노출한다. 해가 없으면 실패를 명시하고 가장 여유가 큰 후보를 쓴다.
//   ③ 밴드별 휘도·채도 표 — 프레임을 가로 6밴드로 잘라 mean/채도를 낸다(비전 브리핑용 수치).
//
// 출력 디렉터리는 CHEOMA_P1_OUT (기본: OS temp). shots/ 에는 쓰지 않는다.
// 사용법: node tools/run-browser-locked.mjs -- node tools/shoot-p1-look.mjs [필터]
import { createServer } from 'node:http';
import { readFile, mkdtemp, writeFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = process.env.CHEOMA_P1_OUT || await mkdtemp(join(tmpdir(), 'cheoma-p1-'));
mkdirSync(OUT, { recursive: true });

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json',
};

const HTML = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>html,body{margin:0;height:100%;overflow:hidden;background:#000}#app{width:100%;height:100%}</style>
<script type="importmap">{"imports":{"three":"/vendor/three.module.js","three/addons/":"/vendor/addons/"}}</script>
</head><body><div id="app"></div>
<script type="module">
import * as THREE from 'three';
import { computeLayout, PRESETS } from '/src/params.js';
import { setupEnvironment } from '/src/env/index.js';
import { setupPost } from '/src/env/post.js';
import { createVillage } from '/src/village/adapter.js';
import { buildBuilding } from '/src/builder/index.js';

const q = new URLSearchParams(location.search);
const mode = q.get('mode') || 'village';
const scale = q.get('scale') || 'village';
const seedRaw = q.get('seed');
const seed = seedRaw != null ? (isNaN(+seedRaw) ? seedRaw : +seedRaw) : 20260716;
const view = q.get('view') || 'aerial';
const time = q.get('time') || 'sunset';
const look = q.get('look') || '';
const num = (k, d) => { const v = parseFloat(q.get(k)); return Number.isFinite(v) ? v : d; };

{ let s = 0x2545f491 >>> 0; Math.random = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

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

const ground = new THREE.Mesh(
  new THREE.CircleGeometry(160, 48),
  new THREE.MeshStandardMaterial({ color: 0xb5a893, roughness: 1 }));
ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true;
scene.add(ground);

const camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, 0.1, 500);
const P = PRESETS.korea;
const env = setupEnvironment(scene, { sun, hemi, renderer, layout: computeLayout(P) });
const post = setupPost({ renderer, scene, camera });
post.setSize(innerWidth, innerHeight);
env.setEnabled(true);
if (look && env.setSunsetLook) env.setSunsetLook(look, { immediate: true });
env.setTime(time, { immediate: true });
post.setTime(time);

const info = { mode, scale, seed, time, look, view };

if (mode === 'solo') {
  // 단독 건물 모드 — 마을을 만들지 않으므로 env 의 mountains/mist 가 그대로 보인다.
  const building = buildBuilding(P);
  scene.add(building);
  const L = computeLayout(P);
  // 지평선을 프레임 중앙에 두는 아이레벨. 능선 띠 판정이 목적이므로 건물은 화면 하단 1/3.
  camera.fov = num('fov', 46);
  camera.near = 0.5; camera.far = 900;
  camera.position.set(num('cx', 26), num('cy', L.totalH * 0.55 + 1.6), num('cz', 34));
  camera.lookAt(num('tx', 0), num('ty', L.totalH * 0.42 + 6), num('tz', 0));
  camera.updateProjectionMatrix();
  info.layoutH = L.totalH;
} else {
  const villageHandle = createVillage({ scale, seed, includePalace: false, includeTemple: false, character: 'yeoyeom' });
  villageHandle.enterVillageMode({ scene, building: null, ground, env });
  villageHandle.setTime(time);
  // enterVillageMode 가 env 를 day 로 되돌린다 — 요청 시간대를 다시 건다(2026-08-01 계측기 버그).
  env.setTime(time, { immediate: true });
  if (look && env.setSunsetLook) env.setSunsetLook(look, { immediate: true });
  post.setTime(time);
  window.__VH = villageHandle;

  const site = villageHandle.plan.site;
  const R = site.R;
  if (scene.fog) { scene.fog.near = R * 2.2; scene.fog.far = R * 7.0; }
  camera.far = R * 8; camera.near = 0.5;
  info.R = R;

  if (view === 'aerial') {
    camera.fov = num('fov', 42);
    camera.position.set(num('cx', 0.20 * R), num('cy', 1.02 * R), num('cz', 1.98 * R));
    camera.lookAt(num('tx', 0), num('ty', 0.06 * R), num('tz', -0.10 * R));
  } else {
    // ⑥ 지형에 막히지 않는 아이레벨 해 찾기.
    //   피사체 = 마을 중심 위 EYE_TARGET_H. 후보 = 남쪽 반원 방위 × 거리.
    //   판정 = 시선을 200 스텝으로 샘플링해 지형 위 여유의 최솟값.
    const EYE_H = 1.65;                 // 서 있는 눈높이
    const EYE_TARGET_H = 9;             // 마을 중심 지붕 능선 근처
    const EYE_MIN_CLEARANCE = 1.5;
    const cy0 = site.heightAt(0, 0);
    const target = new THREE.Vector3(0, cy0 + EYE_TARGET_H, 0);
    const clearanceFor = (px, pz) => {
      const py = site.heightAt(px, pz) + EYE_H;
      let min = Infinity;
      for (let i = 1; i < 200; i++) {
        const t = i / 200;
        const x = px + (target.x - px) * t;
        const z = pz + (target.z - pz) * t;
        const y = py + (target.y - py) * t;
        min = Math.min(min, y - site.heightAt(x, z));
      }
      return { min, py };
    };
    // 시선 여유만 푸는 것으로는 부족했다(첫 해: 여유 1.55 m 인데 프레임 전체가 배산 숲으로
    //   균일하게 덮여 최상단 행부터 L≈46 — 하늘이 한 줄도 없어 여전히 판정 불가였다).
    //   그래서 두 조건을 함께 푼다: ① 시선이 지형을 뚫지 않을 것 ② 카메라가 분지 바닥보다
    //   높은 지대에 설 것(남쪽 어깨에 서서 마을 너머 배산과 그 위 하늘을 함께 보는 자리).
    const candidates = [];
    for (let deg = 40; deg <= 140; deg += 10) {
      const a = deg * Math.PI / 180;
      for (const dist of [0.90, 1.05, 1.20, 1.40, 1.60, 1.80, 2.00, 2.30]) {
        const px = Math.cos(a) * R * dist;
        const pz = Math.sin(a) * R * dist;
        const c = clearanceFor(px, pz);
        candidates.push({ deg, dist, px, pz, py: c.py, min: c.min, rise: c.py - EYE_H - cy0 });
      }
    }
    const clear = candidates.filter((c) => c.min >= EYE_MIN_CLEARANCE);
    // 여유가 확보된 후보 중 가장 높은 지대. 하나도 없으면 여유가 가장 큰 후보로 물러선다.
    const best = (clear.length ? clear : candidates).sort((a, b) => (
      clear.length ? b.rise - a.rise : b.min - a.min
    ))[0];

    // 시선 피치: 카메라 방위 반대편(배산 쪽)으로 지형을 훑어 능선 마루의 앙각을 구하고,
    //   그 마루가 프레임 세로 55% 지점에 앉도록 중심 광선을 기울인다 → 상단 45% 가 하늘.
    const fovDeg = num('fov', 50);
    const aspect = innerWidth / innerHeight;
    const fovV = fovDeg * Math.PI / 180;
    const dirX = -best.px, dirZ = -best.pz;
    const dirLen = Math.hypot(dirX, dirZ) || 1;
    const ux = dirX / dirLen, uz = dirZ / dirLen;
    let crest = -Infinity;
    for (let d = R * 0.2; d <= R * 3.2; d += R * 0.04) {
      const x = best.px + ux * d, z = best.pz + uz * d;
      const ang = Math.atan2(site.heightAt(x, z) - best.py, d);
      if (ang > crest) crest = ang;
    }
    const CREST_FRAME_FRACTION = 0.55;
    const pitch = crest + (CREST_FRAME_FRACTION - 0.5) * fovV;
    const reach = R * 1.6;
    const tx = best.px + ux * reach;
    const tz = best.pz + uz * reach;
    const ty = best.py + Math.tan(pitch) * reach;

    camera.fov = fovDeg;
    camera.position.set(num('cx', best.px), num('cy', best.py), num('cz', best.pz));
    camera.lookAt(num('tx', tx), num('ty', ty), num('tz', tz));
    info.eyeSolve = {
      azimuthDeg: best.deg, distanceR: best.dist, minClearance: +best.min.toFixed(2),
      solved: best.min >= EYE_MIN_CLEARANCE, riseAboveBasin: +best.rise.toFixed(2),
      crestElevationDeg: +(crest * 180 / Math.PI).toFixed(2),
      pitchDeg: +(pitch * 180 / Math.PI).toFixed(2),
      pos: [+best.px.toFixed(2), +best.py.toFixed(2), +best.pz.toFixed(2)],
      target: [+tx.toFixed(2), +ty.toFixed(2), +tz.toFixed(2)], fov: fovDeg, aspect: +aspect.toFixed(3),
    };
  }
  camera.updateProjectionMatrix();
}

// 프레임 통계 — 전체 mean 과 가로 6밴드(위→아래) mean/채도.
function stats() {
  const cvs = renderer.domElement;
  const w = cvs.width, h = cvs.height;
  const c2 = document.createElement('canvas'); c2.width = w; c2.height = h;
  const ctx = c2.getContext('2d');
  ctx.drawImage(cvs, 0, 0);
  const d = ctx.getImageData(0, 0, w, h).data;
  const BANDS = 6;
  const bands = [];
  let allL = 0, allN = 0;
  for (let b = 0; b < BANDS; b++) {
    const y0 = Math.floor(h * b / BANDS), y1 = Math.floor(h * (b + 1) / BANDS);
    let sL = 0, sS = 0, n = 0, sR = 0, sB = 0;
    for (let y = y0; y < y1; y += 2) for (let x = 0; x < w; x += 2) {
      const i = (y * w + x) * 4;
      const r = d[i], g = d[i + 1], bl = d[i + 2];
      const L = 0.2126 * r + 0.7152 * g + 0.0722 * bl;
      const mx = Math.max(r, g, bl), mn = Math.min(r, g, bl);
      sL += L; sS += mx ? (mx - mn) / mx : 0; sR += r; sB += bl; n++;
    }
    bands.push({ band: b, mean: +(sL / n).toFixed(1), sat: +(sS / n).toFixed(3), rb: +((sR - sB) / n).toFixed(1) });
    allL += sL; allN += n;
  }
  return { frameMean: +(allL / allN).toFixed(1), bands };
}

let frames = 0;
renderer.setAnimationLoop(() => {
  if (window.__VH) window.__VH.update(1 / 60);
  env.update(1 / 60);
  post.update();
  post.composer.render();
  frames++;
  if (frames === 20) {
    window.__PLAN = { ...info, camera: {
      pos: camera.position.toArray().map((v) => +v.toFixed(2)),
      fov: camera.fov,
    }, stats: stats() };
    window.__SHOT_READY = true;
  }
});
</script></body></html>`;

const THREE_DIR = join(ROOT, 'app/node_modules/three/build');
const ADDONS_DIR = join(ROOT, 'app/node_modules/three/examples/jsm');

const server = createServer(async (req, res) => {
  const path = decodeURIComponent(req.url.split('?')[0]);
  if (path === '/__p1') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(HTML); return; }
  try {
    let file;
    // three.module.js 는 ./three.core.js 를 상대경로로 부른다 — /vendor/ 전체를 build 로 넘긴다.
    if (path.startsWith('/vendor/addons/')) file = join(ADDONS_DIR, path.slice('/vendor/addons/'.length));
    else if (path.startsWith('/vendor/')) file = join(THREE_DIR, path.slice('/vendor/'.length));
    else file = join(ROOT, path === '/' ? 'index.html' : path);
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const port = server.address().port;

const filter = process.argv[2] || '';
const SHOTS = [
  ['sunset-aerial', '/__p1?mode=village&scale=village&view=aerial&time=sunset', 1440, 900],
  ['dawn-aerial', '/__p1?mode=village&scale=village&view=aerial&time=dawn', 1440, 900],
  ['sunset-eye', '/__p1?mode=village&scale=village&view=eye&time=sunset', 1440, 900],
  ['dawn-eye', '/__p1?mode=village&scale=village&view=eye&time=dawn', 1440, 900],
  ['sunset-solo', '/__p1?mode=solo&time=sunset', 1440, 900],
  ['dawn-solo', '/__p1?mode=solo&time=dawn', 1440, 900],
  ['day-solo', '/__p1?mode=solo&time=day', 1440, 900],
  ['sunset-town-aerial', '/__p1?mode=village&scale=town&view=aerial&time=sunset', 1440, 900],
].filter(([name]) => !filter || name.includes(filter));

const browser = await chromium.launch({ args: ['--use-gl=angle', '--enable-unsafe-swiftshader'] });
const report = [];
for (const [name, url, w, h] of SHOTS) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`http://127.0.0.1:${port}${url}`, { waitUntil: 'load' });
  let plan = null;
  try {
    await page.waitForFunction('window.__SHOT_READY === true', { timeout: 120_000 });
    plan = await page.evaluate('window.__PLAN');
  } catch (e) {
    console.log(`FAIL ${name}: ${e.message}`);
    errors.forEach((x) => console.log(`   ${x}`));
  }
  const file = join(OUT, `p1-${name}.png`);
  await page.screenshot({ path: file });
  report.push({ name, file, plan, errors: errors.slice(0, 3) });
  console.log(`\n${name}  → ${file}`);
  if (plan) {
    console.log(`  frameMean ${plan.stats.frameMean}  camera ${JSON.stringify(plan.camera)}`);
    if (plan.eyeSolve) console.log(`  eyeSolve ${JSON.stringify(plan.eyeSolve)}`);
    console.log('  band  mean    sat     r-b');
    for (const b of plan.stats.bands) {
      console.log(`   ${b.band}    ${String(b.mean).padStart(5)}  ${b.sat.toFixed(3)}  ${String(b.rb).padStart(6)}`);
    }
  }
  errors.slice(0, 3).forEach((x) => console.log(`  ERR ${x}`));
  await page.close();
}
await browser.close();
server.close();
await writeFile(join(OUT, 'p1-report.json'), JSON.stringify(report, null, 2));
console.log(`\nreport → ${join(OUT, 'p1-report.json')}`);
