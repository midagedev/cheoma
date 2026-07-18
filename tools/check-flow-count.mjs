// envflow ① "자동 전진 ≥2 전이" FAIL 이 환경(번들 chromium 소프트웨어GL 저fps) 요인인지 확증:
// 하드웨어GL(channel:chrome)로 ?hero=0&flow=1&flowsec=2 를 열고 12초간 시간 전이 횟수를 센다.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';
const ROOT = resolve(import.meta.dirname, '..');
const DIST = join(ROOT, 'app', 'dist-entry');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff': 'font/woff', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]); const f = join(DIST, p === '/' ? 'index.html' : p);
  try { const d = await readFile(f); res.writeHead(200, { 'content-type': MIME[extname(f)] || 'application/octet-stream' }); res.end(d); } catch { res.writeHead(404); res.end('nf'); }
});
await new Promise((ok) => server.listen(4192, '127.0.0.1', ok));
const browser = await chromium.launch({ channel: 'chrome' });   // 하드웨어GL
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
let fps = 0;
await page.addInitScript(() => { let n = 0, t0 = 0; const l = (t) => { if (!t0) t0 = t; n++; if (t - t0 < 3000) requestAnimationFrame(l); else window.__fps = n / ((t - t0) / 1000); }; requestAnimationFrame(l); });
await page.goto('http://127.0.0.1:4192/?hero=0&flow=1&flowsec=2&time=dawn&season=spring&weather=clear&seed=7', { waitUntil: 'load' });
await page.waitForFunction(() => window.__engine && window.__envflow, { timeout: 15000 });
await new Promise((r) => setTimeout(r, 1300));
fps = await page.evaluate(() => window.__fps || 0);
const seq = []; let last = null; const end = Date.now() + 12000;
while (Date.now() < end) { const t = (await page.evaluate(() => window.__engine.getState().time)); if (t !== last) { seq.push(t); last = t; } await new Promise((r) => setTimeout(r, 120)); }
console.log(`fps≈${fps.toFixed(0)}  transitions n=${seq.length - 1}  [${seq.join('→')}]`);
console.log(seq.length - 1 >= 2 ? 'PASS (하드웨어GL 에선 ≥2 전이 — envflow ① FAIL 은 번들 소프트웨어GL 저fps 환경 요인)' : 'still low');
await browser.close(); server.close();
