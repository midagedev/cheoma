// #149 결정론 게이트: 궁 재질 공유가 마을 지오메트리 재현성을 흔들지 않음을 실측.
//   createVillage(실앱 시드창 경로)로 hanyang(궁 포함) 마을을 2회 생성해 전 지오메트리(정점·인스턴스
//   행렬) + palaceMerged 메시 수를 해시 비교. 지오는 plan.seed 유래 makeRng 전용 스트림이라 makeMaterials
//   (texRng) 소비 변화와 무관해야 한다(= 두 해시 동일).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

const HTML = `<!DOCTYPE html><html><head><meta charset="utf-8">
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.185.1/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.185.1/examples/jsm/"}}</script>
</head><body><script type="module">
import { createVillage } from '/src/village/adapter.js';
// worker 는 CDN importmap 하네스에서 bare three 미해결로 폴백되므로 명시적으로 끈다(동기 경로 결정론 측정).
function fnv(str, h = 2166136261) { for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function hashGeometry(group) {
  let h = 2166136261 >>> 0, meshes = 0, palaceMeshes = 0;
  const buf = [];
  group.traverse((o) => {
    if (!o.isMesh && !o.isInstancedMesh) return;
    meshes++;
    let anc = o; while (anc && anc.name !== 'palace-merged' && anc.parent) anc = anc.parent;
    // 정점 위치(반올림)로 지오 해시
    const pos = o.geometry && o.geometry.attributes && o.geometry.attributes.position;
    if (pos) {
      const a = pos.array; let s = o.name + ':' + a.length + ':';
      for (let i = 0; i < a.length; i += Math.max(1, (a.length / 300) | 0)) s += Math.round(a[i] * 100) + ',';
      h = fnv(s, h);
    }
    if (o.isInstancedMesh) { const m = new Float32Array(16); const im = o.instanceMatrix.array; let s = 'IM' + o.count + ':'; for (let i = 0; i < im.length; i += 7) s += Math.round(im[i] * 100) + ','; h = fnv(s, h); }
  });
  // palaceMerged 메시 수(부감 궁 드로우콜 바닥)
  const pm = group.getObjectByName ? null : null;
  group.traverse((o) => { if (o.name === 'palace-merged') { o.traverse((c) => { if (c.isMesh || c.isInstancedMesh) palaceMeshes++; }); } });
  return { hash: h >>> 0, meshes, palaceMeshes };
}
const OPTS = { scale: 'hanyang', seed: 20260716, includePalace: true, includeTemple: true, worker: false };
const results = [];
for (let i = 0; i < 2; i++) {
  const v = createVillage(OPTS);
  results.push(hashGeometry(v.group));
  if (v.dispose) try { v.dispose(); } catch {}
}
window.__DET = {
  equal: results[0].hash === results[1].hash,
  h0: results[0].hash, h1: results[1].hash,
  meshes: results[0].meshes, palaceMeshes: results[0].palaceMeshes,
};
window.__READY = true;
</script></body></html>`;

const server = createServer(async (req, res) => {
  const path = req.url.split('?')[0];
  if (path === '/__det') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(HTML); return; }
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
const page = await browser.newPage();
let err = 0; page.on('pageerror', (e) => { err++; console.error('[pageerror]', e.message); });
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) console.error('[console]', m.text()); });
await page.goto(`http://127.0.0.1:${port}/__det`, { waitUntil: 'load' });
try { await page.waitForFunction('window.__READY === true', null, { timeout: 60000 }); }
catch { console.error('TIMEOUT'); }
const det = await page.evaluate(() => window.__DET);
console.log('hanyang(sync) geometry determinism:', det);
console.log(det && det.equal && err === 0 ? 'DETERMINISM: PASS' : 'DETERMINISM: FAIL');
await browser.close();
server.close();
