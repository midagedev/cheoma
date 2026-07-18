// 엣지 후보 3안 직접 비교 — 림을 정면으로 보는 카메라(edge-az-w 계열)에서 ink/mist/diorama.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';
const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'shots'); mkdirSync(OUT, { recursive: true });
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };
const HTML = await readFile(join(ROOT, 'tools/_edge_min.html'), 'utf8');
const server = createServer(async (req, res) => {
  const path = req.url.split('?')[0];
  if (path === '/__edge') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(HTML); return; }
  try { const d = await readFile(join(ROOT, path === '/' ? 'index.html' : path)); res.writeHead(200, { 'content-type': MIME[extname(path)] || 'application/octet-stream' }); res.end(d); }
  catch { res.writeHead(404); res.end('nf'); }
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const port = server.address().port;
// 림 정면 카메라 + 부감(엣지가 확실히 프레임에 들어오게)
const cam = 'cx=-25&cy=26&cz=28&tx=-135&ty=6&tz=6';
const cam2 = 'cx=110&cy=120&cz=118&tx=-30&ty=0&tz=-30';   // 부감(엣지 링 전체가 보이게)
const shots = [];
for (const edge of ['ink', 'mist', 'diorama']) {
  shots.push([`cmp-rim-${edge}`, `/__edge?edge=${edge}&time=day&season=summer&steps=30&${cam}`]);
  shots.push([`cmp-aer-${edge}`, `/__edge?edge=${edge}&time=sunset&season=summer&steps=30&${cam2}`]);
}
let browser; try { browser = await chromium.launch({ channel: 'chrome' }); } catch { browser = await chromium.launch(); }
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
for (const [name, qs] of shots) {
  await page.goto(`http://127.0.0.1:${port}${qs}`, { waitUntil: 'load' });
  try { await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 20000 }); } catch { console.log('TIMEOUT', name); }
  await page.waitForTimeout(120);
  await page.screenshot({ path: join(OUT, `edge-${name}.png`) });
  console.log('saved', name);
}
console.log('pageerrors', errs.length);
await browser.close(); server.close();
