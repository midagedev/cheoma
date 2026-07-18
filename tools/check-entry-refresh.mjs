// #59 검증: 새로고침 시 히어로 랜딩이 재발생하는지 + villageHome URL 이 담백한지(village=1 미기록).
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
await new Promise((ok) => server.listen(4191, '127.0.0.1', ok));
let browser; try { browser = await chromium.launch({ channel: 'chrome' }); } catch { browser = await chromium.launch(); }
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
let perr = 0; page.on('pageerror', (e) => { perr++; console.error('[pageerror]', e.message); });
const heroShown = () => page.evaluate(() => !!document.querySelector('.hero'));

// 1) 기본 부팅 → 타이틀(히어로) 노출?
await page.goto('http://127.0.0.1:4191/?time=sunset', { waitUntil: 'load' });
await page.waitForTimeout(1000);
console.log('boot   hero overlay present:', await heroShown());
// 2) 클릭 → 랜딩 → URL 확인(village=1 없어야)
await page.click('.hero');
await page.waitForTimeout(7000);
const url1 = await page.evaluate(() => location.search);
console.log('after landing  URL:', url1, '  → village=1 present:', /village=1/.test(url1));
// 3) 새로고침 → 히어로 다시?
await page.reload({ waitUntil: 'load' });
await page.waitForTimeout(1000);
console.log('reload hero overlay present:', await heroShown());
console.log(`\npageErrors=${perr}`);
await browser.close(); server.close();
