// 헤드리스 성능 실측: 규모별 생성 ms · 드로우콜 · 삼각형 · 프레임타임 + 그룹 구조 분해.
// 사용법: node tools/shoot-cityperf.mjs [scale...]
//   인자 없으면 전 규모(hamlet..hanyang) 측정. 컬링 실효 드로우콜(aerial vs eye)도 함께.
//   PNG는 안 찍고 표만 출력(설계·리포트용). shots/ 오염 없음.
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
const q = new URLSearchParams(location.search);
const scale = q.get('scale') || 'village';
const seed = 20260716;
const includePalace = q.get('palace') === '1';
const view = q.get('view') || 'aerial';
{ let s = 0x2545f491 >>> 0; Math.random = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight); renderer.setPixelRatio(1);
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.getElementById('app').appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xcfd8e0);

const t0 = performance.now();
const plan = planVillage({ scale, seed, includePalace });
const t1 = performance.now();
const group = populateVillage(plan);
const t2 = performance.now();
scene.add(group);

const R = plan.site.R;
scene.fog = new THREE.Fog(0xcfd8e0, R * 2.4, R * 7.0);
const sun = new THREE.DirectionalLight(0xfff0dd, 2.5);
sun.position.set(0.42 * R, 1.25 * R, 0.30 * R);
sun.castShadow = true; sun.shadow.mapSize.set(4096, 4096);
const TR = plan.site.terrainR || R;
const sc = sun.shadow.camera;
sc.left = -TR * 1.05; sc.right = TR * 1.05; sc.top = TR * 1.05; sc.bottom = -TR * 1.05;
sc.near = 1; sc.far = TR * 8; sun.shadow.bias = -0.0003; sun.shadow.normalBias = 0.08;
scene.add(sun);
scene.add(new THREE.HemisphereLight(0xc4d6e8, 0x9a8c72, 1.25));

let campos, target, fov;
if (view === 'eye') {
  const camZ = plan.site.streamZ + R * 0.34, cx0 = R * 0.04;
  const gy = plan.site.heightAt(cx0, camZ);
  fov = 52; campos = new THREE.Vector3(cx0, gy + 2.4, camZ);
  target = new THREE.Vector3(0, plan.site.heightAt(0, plan.site.center.z) + 5, plan.site.center.z * 0.55);
} else {
  fov = 44; campos = new THREE.Vector3(0.18 * R, 1.02 * R, 1.98 * R);
  target = new THREE.Vector3(0, 0.06 * R, -0.16 * R);
}
const camera = new THREE.PerspectiveCamera(fov, innerWidth / innerHeight, 0.5, R * 8);
camera.position.copy(campos); camera.lookAt(target);
// 제품 렌더 루프와 같이 현재 카메라를 먼저 반영한다. Hanyang은 boot FAR가 기본이므로 이 호출이
// 없으면 eye/aerial 두 행이 실제 줌 LOD가 아니라 같은 초기 표현만 재는 잘못된 성능 표가 된다.
group.userData.updateChunkLod?.(camera);

function lodCounts(root) {
  const counts = { far: 0, mid: 0, full: 0 };
  for (const child of root.children) {
    const level = child.userData?.lod?.level;
    if (level && counts[level] != null) counts[level]++;
  }
  return counts;
}

// 그룹 구조 분해: 이름 프리픽스별 메시/인스턴스드메시 수 + 인스턴스 수.
function structure(root) {
  const byGroup = {};
  root.traverse((o) => {
    if (!o.isMesh && !o.isInstancedMesh) return;
    // 최상위 명명 조상 찾기
    let anc = o, label = o.name || '?';
    while (anc.parent && anc.parent !== root) { anc = anc.parent; if (anc.name) label = anc.name; }
    const e = byGroup[label] || (byGroup[label] = { meshes: 0, instanced: 0, instances: 0 });
    if (o.isInstancedMesh) { e.instanced++; e.instances += o.count; } else e.meshes++;
  });
  return byGroup;
}

// 프레임타임: M프레임 평균(ms).
function frameTime(M) {
  const times = [];
  for (let i = 0; i < M; i++) {
    const a = performance.now();
    renderer.render(scene, camera);
    times.push(performance.now() - a);
  }
  times.sort((x, y) => x - y);
  return { median: times[Math.floor(M / 2)], min: times[0], max: times[M - 1] };
}

renderer.render(scene, camera);
renderer.render(scene, camera);
const ri = renderer.info;
const ft = frameTime(30);
const st = structure(group);
const treeInst = (st['village-trees'] && st['village-trees'].instances) || 0;
window.__PERF = {
  scale, view, R,
  bowlR: +plan.site.bowlR.toFixed(0), terrainR: +plan.site.terrainR.toFixed(0),
  planMs: +(t1 - t0).toFixed(1), popMs: +(t2 - t1).toFixed(1), genMs: +(t2 - t0).toFixed(1),
  houses: plan.stats.houses, giwa: plan.stats.giwa, choga: plan.stats.choga, trees: treeInst,
  calls: ri.render.calls, triangles: ri.render.triangles,
  geometries: ri.memory.geometries, textures: ri.memory.textures,
  frameMedian: +ft.median.toFixed(2), frameMax: +ft.max.toFixed(2),
  lod: lodCounts(group),
  structure: st,
  warnings: plan.warnings,
};
window.__READY = true;
</script></body></html>`;

const server = createServer(async (req, res) => {
  const path = req.url.split('?')[0];
  if (path === '/__perf') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(HTML); return; }
  try {
    const file = join(ROOT, path === '/' ? 'index.html' : path);
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const port = server.address().port;

const scales = process.argv.slice(2).length ? process.argv.slice(2)
  : ['hamlet', 'village', 'town', 'capital', 'hanyang'];

let browser;
try { browser = await chromium.launch({ channel: 'chrome' }); }
catch { browser = await chromium.launch(); }
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
let pageErrs = 0;
page.on('pageerror', (err) => { pageErrs++; console.error('[pageerror]', err.message); });
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) console.error('[console]', m.text()); });

const rows = [];
for (const scale of scales) {
  for (const view of ['aerial', 'eye']) {
    const palace = (scale === 'capital' || scale === 'hanyang') ? '&palace=1' : '';
    const url = `http://127.0.0.1:${port}/__perf?scale=${scale}&view=${view}${palace}`;
    await page.goto(url, { waitUntil: 'load' });
    try { await page.waitForFunction('window.__READY === true', null, { timeout: 60000 }); }
    catch { console.error('TIMEOUT', scale, view); continue; }
    const p = await page.evaluate(() => window.__PERF);
    rows.push(p);
    if (view === 'aerial') {
      console.log(`\n=== ${scale} (R=${p.R}) ===`);
      console.log(`  houses=${p.houses} (giwa ${p.giwa} / choga ${p.choga})  gen=${p.genMs}ms (plan ${p.planMs} + pop ${p.popMs})`);
      if (p.warnings.length) console.log('  WARN:', p.warnings.join(';'));
      console.log('  structure:', JSON.stringify(p.structure));
    }
    console.log(`  [${view}] calls=${p.calls} tris=${(p.triangles / 1e6).toFixed(2)}M geo=${p.geometries} tex=${p.textures} frame(med/max)=${p.frameMedian}/${p.frameMax}ms lod=${JSON.stringify(p.lod)}`);
  }
}
console.log('\n=== SUMMARY (지형 비율) ===');
console.log('scale     | bowlR | terrR | R비 | 면적비 | trees | aerial tris');
for (let i = 0; i < rows.length; i += 2) {
  const a = rows[i];
  const rr = a.terrainR / a.bowlR, area = rr * rr;
  console.log(`${(a.scale + '        ').slice(0, 9)} | ${(a.bowlR + '     ').slice(0, 5)} | ${(a.terrainR + '     ').slice(0, 5)} | ${rr.toFixed(2)} | ${area.toFixed(1)}x  | ${(a.trees + '     ').slice(0, 5)} | ${(a.triangles / 1e6).toFixed(1)}M`);
}
console.log('\n=== SUMMARY (성능) ===');
console.log('scale     | houses | gen ms | aerial calls | aerial tris | eye calls | eye tris | eye frame');
for (let i = 0; i < rows.length; i += 2) {
  const a = rows[i], e = rows[i + 1] || a;
  console.log(`${(a.scale + '        ').slice(0, 9)} | ${(a.houses + '   ').slice(0, 6)} | ${(a.genMs + '     ').slice(0, 6)} | ${(a.calls + '           ').slice(0, 12)} | ${((a.triangles / 1e6).toFixed(1) + 'M    ').slice(0, 10)} | ${(e.calls + '        ').slice(0, 9)} | ${((e.triangles / 1e6).toFixed(1) + 'M   ').slice(0, 8)} | ${e.frameMedian}ms`);
}
console.log(`pageerror=${pageErrs}`);
await browser.close();
server.close();
