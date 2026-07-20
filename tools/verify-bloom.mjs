// #107 봄 개화 관목 검증(캡처 없음, 수치 단언만) — 진달래(산비탈)·개나리(담장가·길가).
//   전체 마을은 palette.js 가 canvas 텍스처를 쓰므로 headless chromium(playwright)에서 빌드한다.
//   ① 규모 3종 진달래·개나리 인스턴스 카운트  ② 부유 검사(각 인스턴스 y vs site.heightAt < 0.5m)
//   ③ 드로우콜 격리(bloom 그룹 on/off delta ≤ 2, 메인패스 총계 참고)  ④ 계절 토글(spring=visible·autumn=hidden)
//   ⑤ 결정론(같은 seed 2회 빌드 → 개화 위치 동일)  ⑥ pageerror 0.
// 실행: node tools/verify-bloom.mjs
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

const HTML = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>html,body{margin:0;height:100%;overflow:hidden}#app{width:100%;height:100%}</style>
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.185.1/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.185.1/examples/jsm/"}}</script>
</head><body><div id="app"></div>
<script type="module">
import * as THREE from 'three';
import { planVillage } from '/src/village/plan.js';
import { populateVillage } from '/src/village/populate.js';
// 팔레트·사립문 Math.random 시드 고정(앱 소스 불침해) — 텍스처 결정론(개화는 자체 rng 라 무관).
{ let s = 0x2545f491 >>> 0; Math.random = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setSize(1280, 800); renderer.setPixelRatio(1);
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.getElementById('app').appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xcfd8e0);
const sun = new THREE.DirectionalLight(0xfff0dd, 2.5);
sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048); scene.add(sun);
scene.add(new THREE.HemisphereLight(0xc4d6e8, 0x9a8c72, 1.25));
const camera = new THREE.PerspectiveCamera(60, 1280 / 800, 0.5, 40000);

const SEED = 20260716;
const includePalace = (scale) => (scale === 'hanyang' || scale === 'capital');
function buildVillage(scale) {
  const plan = planVillage({ scale, seed: SEED, includePalace: includePalace(scale), includeTemple: true });
  return { plan, group: populateVillage(plan) };
}
function disposeGroup(group) {
  group.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
}
function bloomVisible(bloom) {
  let all = true, any = false;
  bloom.group.traverse((o) => { if (o.isMesh) { any = true; if (!o.visible || !bloom.group.visible) all = false; } });
  return any && all;
}
function floatCheck(positions, site) {
  let maxErr = 0, bad = 0;
  for (const p of positions) {
    const e = Math.abs(p.y - site.heightAt(p.x, p.z));
    if (e > maxErr) maxErr = e;
    if (e >= 0.5) bad++;
  }
  return { maxErr, bad, n: positions.length };
}
function posHash(bloom) {
  const parts = [];
  const add = (arr) => { for (const p of arr) parts.push(p.x.toFixed(3), p.y.toFixed(3), p.z.toFixed(3)); };
  add(bloom.azalea.positions); parts.push('|'); add(bloom.forsythia.positions);
  return parts.join(',');
}

function measure(scale) {
  const { plan, group } = buildVillage(scale);
  const U = group.userData, bloom = U.bloom, site = plan.site;
  const R = site.R;

  // 부유 검사
  const azFloat = floatCheck(bloom.azalea.positions, site);
  const foFloat = floatCheck(bloom.forsythia.positions, site);

  // 계절 토글
  U.setSeason('spring'); const springVis = bloomVisible(bloom);
  U.setSeason('autumn'); const autumnHidden = !bloomVisible(bloom);
  U.setSeason('spring');

  // 드로우콜 격리: 봄에서 bloom 그룹 on/off delta(부감 프레이밍, 셰이더 프리컴파일 후 측정)
  scene.add(group);
  camera.position.set(0.2 * R, 2.6 * R, 1.4 * R); camera.lookAt(0, 0, 0);
  sun.position.set(0.42 * R, 1.25 * R, 0.30 * R);
  const sc = sun.shadow.camera, TR = site.terrainR || R;
  sc.left = -TR; sc.right = TR; sc.top = TR; sc.bottom = -TR; sc.near = 1; sc.far = TR * 8; sc.updateProjectionMatrix();
  // 메인패스 드로우콜(shadow pass 제외) — 통상적 "드로우콜 예산" 기준. bloom 은 castShadow=false 라
  //   shadow pass 에 미기여하므로 delta 는 메인패스에서만 발생한다.
  renderer.shadowMap.enabled = false;
  renderer.render(scene, camera); renderer.render(scene, camera);   // 프리컴파일
  const mainWith = renderer.info.render.calls;
  bloom.group.visible = false;
  renderer.render(scene, camera); renderer.render(scene, camera);
  const mainWithout = renderer.info.render.calls;
  // 참고용: shadow pass 포함 총 드로우콜(bloom on)
  renderer.shadowMap.enabled = true;
  bloom.group.visible = true;
  renderer.render(scene, camera); renderer.render(scene, camera);
  const totalWith = renderer.info.render.calls;
  scene.remove(group);
  const callsWith = mainWith, callsWithout = mainWithout;

  const hash = posHash(bloom);
  disposeGroup(group);
  return {
    scale, R,
    azalea: bloom.azalea.count, forsythia: bloom.forsythia.count, drawCalls: bloom.drawCalls,
    azFloat, foFloat, springVis, autumnHidden,
    callsWith, callsWithout, delta: callsWith - callsWithout, totalWith,
    hash,
  };
}

const out = {};
for (const scale of ['hamlet', 'town', 'capital']) out[scale] = measure(scale);
// 결정론: town 2회 빌드 → 개화 위치 해시 동일
const detA = measure('town').hash, detB = measure('town').hash;
out.determinism = { equal: detA === detB, len: detA.length };
window.__BLOOM = out;
window.__READY = true;
</script></body></html>`;

const server = createServer(async (req, res) => {
  const path = req.url.split('?')[0];
  if (path === '/__bloom') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(HTML); return; }
  try {
    const data = await readFile(join(ROOT, path === '/' ? 'index.html' : path));
    res.writeHead(200, { 'content-type': MIME[extname(path)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const port = server.address().port;

let browser;
try { browser = await chromium.launch({ channel: 'chrome' }); } catch { browser = await chromium.launch(); }
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
let pageErrs = 0;
page.on('pageerror', (e) => { pageErrs++; console.error('[pageerror]', e.message); });
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) console.error('[console]', m.text()); });
await page.goto(`http://127.0.0.1:${port}/__bloom`, { waitUntil: 'load' });
try { await page.waitForFunction('window.__READY === true', null, { timeout: 120000 }); }
catch { console.error('TIMEOUT'); }
const R = await page.evaluate(() => window.__BLOOM);

const fails = [];
const ok = (cond, msg) => { if (!cond) fails.push(msg); return cond; };

console.log('\n── ① 인스턴스 카운트 + ② 부유 검사(y vs heightAt) ──');
console.log('  규모       R     진달래  개나리   drawCalls   진달래부유(max/bad)   개나리부유(max/bad)');
for (const scale of ['hamlet', 'town', 'capital']) {
  const r = R[scale];
  console.log(`  ${scale.padEnd(9)} ${String(Math.round(r.R)).padStart(4)}  ${String(r.azalea).padStart(5)}  ${String(r.forsythia).padStart(5)}      ${r.drawCalls}       ${r.azFloat.maxErr.toFixed(3)}m/${r.azFloat.bad}            ${r.foFloat.maxErr.toFixed(3)}m/${r.foFloat.bad}`);
  ok(r.azalea > 0, `${scale}: 진달래 인스턴스 0 (배치 실패)`);
  ok(r.forsythia > 0, `${scale}: 개나리 인스턴스 0 (배치 실패)`);
  ok(r.azFloat.bad === 0, `${scale}: 진달래 부유 ${r.azFloat.bad}개(max ${r.azFloat.maxErr.toFixed(3)}m ≥ 0.5)`);
  ok(r.foFloat.bad === 0, `${scale}: 개나리 부유 ${r.foFloat.bad}개(max ${r.foFloat.maxErr.toFixed(3)}m ≥ 0.5)`);
  ok(r.drawCalls <= 2, `${scale}: bloom.drawCalls ${r.drawCalls} > 2`);
}

console.log('\n── ③ 드로우콜 격리(bloom on/off delta ≤ 2) ──');
console.log('  규모       메인패스(on)  bloom제외(off)  delta   +shadow총계');
for (const scale of ['hamlet', 'town', 'capital']) {
  const r = R[scale];
  console.log(`  ${scale.padEnd(9)}   ${String(r.callsWith).padStart(5)}        ${String(r.callsWithout).padStart(5)}        ${String(r.delta).padStart(2)}      ${r.totalWith}`);
  ok(r.delta <= 2, `${scale}: bloom 드로우콜 delta ${r.delta} > 2`);
  ok(r.delta >= 1, `${scale}: bloom 드로우콜 delta ${r.delta} < 1 (안 그려짐?)`);
}
// 천장: bloom 자체 비용(delta)이 아닌 마을 전체 규모는 궁·나이트라이트·성곽 등 누적으로 자라 있음.
//   bloom 은 메인패스 +2 만 더한다(shadow pass 미기여). 메인패스 전체가 1000 밑이면 예산 내.
const capMain = R.capital.callsWith;
console.log(`  → capital 메인패스 전체(bloom 포함) = ${capMain}  ${capMain < 1000 ? '< 1000 (예산 내)' : '≥ 1000'}`);

console.log('\n── ④ 계절 토글(spring=visible·autumn=hidden) ──');
for (const scale of ['hamlet', 'town', 'capital']) {
  const r = R[scale];
  console.log(`  ${scale.padEnd(9)}  spring visible=${r.springVis}  autumn hidden=${r.autumnHidden}`);
  ok(r.springVis, `${scale}: 봄에 개화 관목이 보이지 않음`);
  ok(r.autumnHidden, `${scale}: 가을에 개화 관목이 숨겨지지 않음`);
}

console.log('\n── ⑤ 결정론(같은 seed 2회 → 위치 동일) + ⑥ pageerror ──');
console.log(`  determinism equal=${R.determinism.equal} (hashLen=${R.determinism.len})   pageerror=${pageErrs}`);
ok(R.determinism.equal, '결정론 실패: 같은 seed 두 빌드의 개화 위치가 다름');
ok(pageErrs === 0, `pageerror ${pageErrs}건`);

console.log('\n' + '─'.repeat(56));
if (fails.length) { console.log(`FAIL — ${fails.length}건`); for (const m of fails) console.log('  ✗ ' + m); }
else console.log('PASS — 모든 단언 통과, 0 에러');
await browser.close();
server.close();
process.exit(fails.length ? 1 : 0);
