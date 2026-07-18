// 결정론 데이터 검증: 같은 seed → 같은 plan(필지 위치·종류·성곽 게이트·시전). 픽셀(AA·물글린트
//   비결정)이 아니라 배치 데이터의 동일성을 판정한다. 모든 scale 을 2회 생성해 깊은 해시 비교.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

const HTML = `<!DOCTYPE html><html><head><meta charset="utf-8">
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.185.1/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.185.1/examples/jsm/"}}</script>
</head><body><script type="module">
import { planVillage } from '/src/village/plan.js';
function hashPlan(scale) {
  // 연속 스케일(#89): scale 은 프리셋명 또는 숫자 siteR(m). 궁은 capital tier(R≥213) 이상에서.
  const includePalace = typeof scale === 'number' ? scale >= 213 : (scale === 'hanyang' || scale === 'capital');
  const p = planVillage({ scale, seed: 20260716, includePalace, includeTemple: true });
  const parts = [];
  for (const pc of p.parcels) parts.push(pc.id, pc.kind, pc.center.x.toFixed(3), pc.center.z.toFixed(3), pc.variant, (pc.rank||0).toFixed(3));
  const F = p.features || {};
  if (F.cityWall) for (const g of F.cityWall.gates) parts.push('g', g.name, g.x.toFixed(2), g.z.toFixed(2));
  if (F.sijeon) for (const s of F.sijeon) parts.push('s', s.center.x.toFixed(2), s.center.z.toFixed(2));
  return parts.join('|');
}
const out = {};
// 5 이산 앵커(프리셋명) + 중간 임의 R 2곳(숫자 siteR) 자기일관성.
for (const scale of ['hamlet','village','town','capital','hanyang', 210, 440]) {
  const a = hashPlan(scale), b = hashPlan(scale);
  out[typeof scale === 'number' ? 'R' + scale : scale] = { equal: a === b, len: a.length, houses: a.split('|').length };
}
window.__DET = out; window.__READY = true;
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
await page.goto(`http://127.0.0.1:${port}/__det`, { waitUntil: 'load' });
await page.waitForFunction('window.__READY === true', null, { timeout: 30000 });
const det = await page.evaluate(() => window.__DET);
let allPass = true;
for (const [scale, r] of Object.entries(det)) {
  console.log(`${scale}: ${r.equal ? 'PASS' : 'FAIL'} (data-items=${r.houses})`);
  if (!r.equal) allPass = false;
}
console.log(allPass && err === 0 ? 'DETERMINISM: ALL PASS' : 'DETERMINISM: FAIL');
await browser.close();
server.close();
