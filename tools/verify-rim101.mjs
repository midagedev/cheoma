// #101 재질 프레넬 림 전 오브젝트 확장 — 코드/로그 전용 검증(시각 캡처 없음, 사용자 토큰 절약).
//   env/post.js·rim.js 를 코어 직접 import 하는 하네스(포트 4215)에서:
//     ① 씬 유형별(단일건물+env / 소품+풀 확장) 패치 재질 재질군 커버리지 카운트
//        — 나무·풀·소품 포함 증명 + 제외 목록(지형·물·개구부·발광·먹) 준수 확인
//     ② 셰이더 컴파일 에러·pageerror 0 (sunset·night·autumn 각 로드; renderer.compile 로 전 재질 강제 컴파일)
//     ③ seasons 활성 + 반복 rescan 에서 프로그램 재컴파일 폭주 없음(programs 카운트 안정)
//     ④ ink / ?post=0 / ?rim=pass 각 로드 클린(강도·마스터 0 / 미패치 / 폴백)
// 사용: NODE_PATH=/Users/hckim/repo/threesur/node_modules node tools/verify-rim101.mjs
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

// 하네스 HTML: 건물 3채 + 전 env(나무/지형/물/논/동물) + 소품 세트 + focus 풀을 배선하고
//   post(fresnel)를 붙인 뒤 renderer.compile 로 전 재질을 강제 컴파일한다.
const HARNESS = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>html,body{margin:0;height:100%;overflow:hidden;background:#cfd8e0}#app{width:100%;height:100%}</style>
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.185.1/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.185.1/examples/jsm/"}}</script>
</head><body><div id="app"></div>
<script type="module">
import * as THREE from 'three';
import { PRESETS, computeLayout } from '/src/params.js';
import { buildBuilding } from '/src/builder/index.js';
import { setupEnvironment, setupGrass } from '/src/env/index.js';
import { setupPost } from '/src/env/post.js';
import { setupInk } from '/src/render/ink.js';
import { buildProp } from '/src/props/index.js';

const q = new URLSearchParams(location.search);
const time = q.get('time') || 'sunset';
const season = q.get('season') || 'summer';
const ink = q.get('ink') === '1';
const post0 = q.get('post') === '0';

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(1);
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = ink ? THREE.NoToneMapping : THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
document.getElementById('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xcfd8e0);
scene.fog = new THREE.Fog(0xcfd8e0, 60, 320);
const sun = new THREE.DirectionalLight(0xfff0dd, 2.6); sun.position.set(30, 42, 26); sun.castShadow = true;
scene.add(sun);
const hemi = new THREE.HemisphereLight(0xbdd0e4, 0x8a7a63, 0.9); scene.add(hemi);

// 건물 3채(giwa/choga/korea) — roof/wall/wood/stone 역할 재질 다수.
function place(x, z, name, preset) {
  const b = buildBuilding({ ...PRESETS[preset] });
  b.position.set(x, 0, z); b.name = name; scene.add(b); return b;
}
place(0, 0, 'building', 'giwa');
place(40, 0, 'b1', 'choga');
place(-40, 0, 'b2', 'korea');
const layout0 = computeLayout({ ...PRESETS.giwa });

// 전 env: 나무(organic)·지형/물/논(제외 대상)·동물(misc).
const env = setupEnvironment(scene, { sun, hemi, renderer, layout: layout0 });

// 소품 세트: 장독대·정원석·석축(담장)·해태·석탑·우물·솟대·낟가리·싸리울타리 + 석등(hanjiGlow 제외 검증).
const propNames = ['jangdokdae', 'garden-rock', 'stone-wall', 'haetae', 'pagoda', 'well', 'sotdae', 'haystack', 'brush-fence', 'stone-lantern'];
const propGroup = new THREE.Group(); propGroup.name = 'props-test';
propNames.forEach((nm, i) => {
  try { const g = buildProp(nm, { seed: 100 + i }); g.position.set((i - 5) * 5, 0, 25); propGroup.add(g); }
  catch (e) { console.error('prop build fail ' + nm + ': ' + e.message); }
});
scene.add(propGroup);

// focus 풀(organic) — 필지 마당 풀.
try { setupGrass(scene, { bounds: { W: 20, D: 18 }, sun, seed: 4343 }); } catch (e) { console.error('grass fail: ' + e.message); }

// 합성 snowvol 재질(#52 델리킷 캐시키 재정의) — 실제 날씨 없이 제외 경로를 직접 증명한다.
const fakeSnow = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 });
fakeSnow.customProgramCacheKey = () => 'snowvol_shell';
const fakeSnowMesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), fakeSnow);
fakeSnowMesh.name = 'fake-snowvol'; fakeSnowMesh.position.set(0, 3, -20);
scene.add(fakeSnowMesh);

env.setSeason(season, { immediate: true });
env.setTime(time);
env.setEnabled(true);

const camera = new THREE.PerspectiveCamera(30, innerWidth / innerHeight, 0.1, 900);
camera.position.set(30, 14, 40); camera.lookAt(0, 4, 0);

let post = null, inkPipe = null;
if (ink) {
  inkPipe = setupInk(renderer, scene, camera); inkPipe.setSize(innerWidth, innerHeight);
  post = setupPost({ renderer, scene, camera }); post.setTime(time); post.setEnabled(false);
} else if (!post0) {
  post = setupPost({ renderer, scene, camera }); post.setSize(innerWidth, innerHeight); post.setTime(time); post.setEnabled(true);
}
window.__post = post;

// 전 재질 강제 컴파일(오프스크린 프리워밍) → 패치된 셰이더의 GLSL 에러를 즉시 표면화.
renderer.compile(scene, camera);

// 씬 감사: 오브젝트별 재질 속성/패치 여부. 제외 검증에 이름·role·hanji·emissive 를 함께 수집.
window.__rimAudit = () => {
  const lum = (e, ei) => e ? (0.2126 * e.r + 0.7152 * e.g + 0.0722 * e.b) * (ei ?? 1) : 0;
  const rows = [];
  scene.traverse((o) => {
    const m = o.material; if (!m) return;
    const arr = Array.isArray(m) ? m : [m];
    for (const mm of arr) {
      if (!mm || !mm.isMaterial) continue;
      rows.push({
        name: o.name || '', parent: (o.parent && o.parent.name) || '',
        type: mm.type, isPoints: !!o.isPoints, isSprite: !!o.isSprite,
        flat: !!mm.flatShading, transparent: !!mm.transparent,
        role: (mm.userData && mm.userData.role) || null,
        hanji: !!(mm.userData && mm.userData.hanjiGlow),
        emiss: +lum(mm.emissive, mm.emissiveIntensity).toFixed(4),
        patched: !!(mm.userData && mm.userData.__rimPatched),
        // rim.js 와 동일 판정: 프로토타입 기본 메서드는 제외(기본 onBeforeCompile.toString() 오탐 회피).
        cck: (() => { try {
          if (!mm.customProgramCacheKey || mm.customProgramCacheKey === THREE.Material.prototype.customProgramCacheKey) return false;
          const k = mm.customProgramCacheKey();
          return typeof k === 'string' && k.length > 0 && (k.startsWith('snowvol_') || Object.prototype.hasOwnProperty.call(mm, 'customProgramCacheKey'));
        } catch { return false; } })(),
      });
    }
  });
  return rows;
};
window.__programs = () => renderer.info.programs ? renderer.info.programs.length : -1;
window.__seasonNow = (nm) => { env.setSeason(nm, { immediate: true }); for (let i = 0; i < 8; i++) env.update(0.05); renderer.compile(scene, camera); };

let frames = 0;
renderer.setAnimationLoop(() => {
  env.update(0.016);
  if (post) post.update(0.016);
  if (ink) inkPipe.composer.render();
  else if (post0) renderer.render(scene, camera);
  else post.composer.render();
  frames++;
  if (frames === 5) window.__READY = true;
});
</script></body></html>`;

const server = createServer(async (req, res) => {
  const path = req.url.split('?')[0];
  if (path === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  if (path === '/__rim101') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(HARNESS); return; }
  try {
    const file = join(ROOT, path === '/' ? 'index.html' : path);
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise((ok) => server.listen(4215, '127.0.0.1', ok));
const base = 'http://127.0.0.1:4215';

let browser;
try { browser = await chromium.launch({ channel: 'chrome' }); }
catch { browser = await chromium.launch(); }
const page = await browser.newPage({ viewport: { width: 1000, height: 700, deviceScaleFactor: 1 } });

let errors = [];
const isCompileErr = (t) => /shader error|webglprogram|compile|glsl|program info/i.test(t);
const ignorable = (t) => /favicon/i.test(t);
page.on('console', (m) => { if (m.type() === 'error' && !ignorable(m.text())) errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));

async function open(qs) {
  errors = [];
  await page.goto(`${base}/__rim101?${qs}`, { waitUntil: 'load' });
  await page.waitForFunction('window.__READY === true', null, { timeout: 30000 });
  await page.waitForTimeout(150);
}
const audit = () => page.evaluate(() => window.__rimAudit());
const rimInfo = () => page.evaluate(() => window.__rim ? ({ mode: window.__rim.mode, patched: window.__rim.patched, coverage: window.__rim.coverage, strength: +window.__rim.strength.toFixed(3), scale: window.__rim.scale }) : null);
const programs = () => page.evaluate(() => window.__programs());

let FAIL = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? 'PASS' : 'FAIL'} — ${msg}`); if (!cond) FAIL++; };
const compileErrs = () => errors.filter(isCompileErr);

console.log('\\n=== GATE 1: 커버리지 (fresnel, sunset) — 나무·풀·소품 포함 · 제외 준수 ===');
await open('rim=fresnel&time=sunset&season=summer');
{
  const rows = await audit();
  const ri = await rimInfo();
  const cov = ri.coverage;
  console.log(`  coverage: ${JSON.stringify(cov)}`);
  // 재질군별 포함 증명
  ok(cov.building >= 4, `건물 재질 패치 ${cov.building} (>=4)`);
  ok(cov.organic >= 2, `유기물(나무+풀) 재질 패치 ${cov.organic} (>=2: 나무·풀 공유재질)`);
  ok(cov.misc >= 5, `소품·동물·담장 재질 패치 ${cov.misc} (>=5)`);
  // 나무 재질 실제 패치
  const treeRows = rows.filter((r) => r.parent === 'trees');
  ok(treeRows.length > 0 && treeRows.every((r) => r.patched), `나무(trees) 재질 전부 패치 (${treeRows.length}개 인스턴스)`);
  ok(treeRows.some((r) => r.flat), `나무 flatShading 재질 패치 성공(vNormal 미선언 함정 회피)`);
  // 풀 재질 패치
  const grassRows = rows.filter((r) => r.name === 'focusGrass');
  ok(grassRows.length > 0 && grassRows.every((r) => r.patched), `풀(focusGrass) 재질 패치`);
  // 소품 재질 패치(props-test 하위, flat granite 포함)
  const propRows = rows.filter((r) => { let p = r; return r.parent && r.name !== '' ; });
  const patchedProps = rows.filter((r) => r.patched && r.type === 'MeshStandardMaterial' && !r.role && !r.hanji && r.parent !== 'trees' && r.name !== 'focusGrass');
  ok(patchedProps.length > 0, `소품/동물/담장(role 없는 misc) 재질 패치 ${patchedProps.length}개`);

  console.log('\\n  --- 제외 목록 준수 ---');
  const terrainRows = rows.filter((r) => r.name === 'terrain');
  ok(terrainRows.length > 0 && terrainRows.every((r) => !r.patched), `지형(terrain) 미패치 (그레이징 오탐 방지)`);
  const streamRows = rows.filter((r) => r.name === 'stream');
  ok(streamRows.length === 0 || streamRows.every((r) => !r.patched), `개울(stream) 물면 미패치`);
  const paddyRows = rows.filter((r) => r.name === 'paddyField');
  ok(paddyRows.length === 0 || paddyRows.every((r) => !r.patched), `다랑이 논(paddyField) 미패치`);
  const hanjiRows = rows.filter((r) => r.hanji);
  ok(hanjiRows.length > 0 && hanjiRows.every((r) => !r.patched), `야간 발광 hanjiGlow(석등 화창 등) 미패치 (${hanjiRows.length}개)`);
  const openingRows = rows.filter((r) => r.role === 'opening');
  ok(openingRows.length === 0 || openingRows.every((r) => !r.patched), `개구부(창호 opening) 미패치`);
  const basicPatched = rows.filter((r) => r.patched && r.type === 'MeshBasicMaterial');
  ok(basicPatched.length === 0, `MeshBasic(하늘·능선·구름·낙엽·창불) 미패치`);
  const pointsSpritePatched = rows.filter((r) => r.patched && (r.isPoints || r.isSprite));
  ok(pointsSpritePatched.length === 0, `입자(Points)·스프라이트 미패치`);
  const transpPatched = rows.filter((r) => r.patched && r.transparent);
  ok(transpPatched.length === 0, `반투명 재질 미패치`);
  const cckPatched = rows.filter((r) => r.patched && r.cck);
  ok(cckPatched.length === 0, `customProgramCacheKey 재정의 재질(snowvol류) 미패치`);
  const fakeSnow = rows.filter((r) => r.name === 'fake-snowvol');
  ok(fakeSnow.length > 0 && fakeSnow.every((r) => !r.patched && r.cck), `합성 snowvol_ 재질 제외 확인(cck 감지·미패치)`);

  const ce = compileErrs();
  ok(ce.length === 0, `셰이더 컴파일 에러 0 (총 콘솔에러 ${errors.length})`);
  if (errors.length) console.log('    errors:', errors.slice(0, 6));
}

console.log('\\n=== GATE 2: 시간대/계절 로드 클린 (night · autumn) ===');
for (const qs of ['rim=fresnel&time=night&season=summer', 'rim=fresnel&time=sunset&season=autumn', 'rim=fresnel&time=day&season=spring']) {
  await open(qs);
  const ce = compileErrs();
  ok(errors.length === 0, `${qs}: 콘솔에러 0`);
  if (errors.length) console.log('    errors:', errors.slice(0, 6));
}

console.log('\\n=== GATE 3: rim 재컴파일 폭주 없음 (rescan 멱등 · 계절 토글 plateau) ===');
await open('rim=fresnel&time=sunset&season=summer');
{
  const p0 = await programs();
  // 반복 rescan(멱등) — 이미 패치된 재질 스킵이라 rim 이 신규 프로그램을 만들지 않아야.
  for (let i = 0; i < 5; i++) await page.evaluate(() => window.__rim && window.__rim.rescan());
  await page.waitForTimeout(120);
  const p1 = await programs();
  // 계절 첫 진입(가을): seasons 자체 재질(낙엽·논 가을변주)이 1회 컴파일된다(rim 무관). 이후
  //   토글을 반복해도 새 프로그램이 안 늘면(plateau) rim 이 재컴파일 폭주를 일으키지 않음이 증명된다.
  await page.evaluate(() => window.__seasonNow('autumn'));
  await page.waitForTimeout(120);
  const p2 = await programs();
  await page.evaluate(() => window.__seasonNow('summer'));
  await page.evaluate(() => window.__seasonNow('autumn'));
  await page.waitForTimeout(120);
  const p3 = await programs();
  console.log(`  programs: 초기 ${p0} → rescan×5 후 ${p1} → autumn(1회) ${p2} → 토글 반복 후 ${p3}`);
  ok(p1 === p0, `rim rescan 반복해도 프로그램 수 불변(${p0}→${p1})`);
  ok(p3 === p2, `계절 토글 반복 시 프로그램 plateau(${p2}→${p3}) — 재컴파일 폭주 없음`);
  ok(compileErrs().length === 0, `seasons 활성 컴파일 에러 0`);
}

console.log('\\n=== GATE 4: ink · post=0 · rim=pass 무회귀 ===');
{
  await open('rim=fresnel&time=sunset&ink=1');
  const ri = await rimInfo();
  ok(ri && ri.strength === 0 && ri.scale === 0, `ink: 림 강도·마스터 0 (${JSON.stringify({ s: ri && ri.strength, sc: ri && ri.scale })})`);
  ok(errors.length === 0, `ink: 콘솔에러 0`);

  await open('time=sunset&post=0');
  const rows = await audit();
  const anyPatched = rows.some((r) => r.patched);
  ok(!anyPatched, `post=0: 재질 미패치(컴포저 미사용)`);
  ok(errors.length === 0, `post=0: 콘솔에러 0`);

  await open('rim=pass&time=sunset');
  const rp = await rimInfo();
  ok(rp && rp.mode === 'pass', `rim=pass: 폴백 모드 활성(${rp && rp.mode})`);
  ok(errors.length === 0, `rim=pass: 콘솔에러 0`);
}

await browser.close();
server.close();
console.log(`\\n${FAIL === 0 ? 'ALL GATES PASS' : 'GATES FAILED: ' + FAIL}`);
process.exit(FAIL === 0 ? 0 : 1);
