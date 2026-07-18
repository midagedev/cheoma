// 배치 어휘 헤드리스 캡처: layout.html?case=... → shots/layout-{case}.png
// 사용법: node tools/shoot-layout.mjs [case ...]  (인자 없으면 전체)
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'shots');
mkdirSync(OUT, { recursive: true });

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json',
};

const server = createServer(async (req, res) => {
  try {
    const path = req.url.split('?')[0];
    const file = join(ROOT, path === '/' ? 'layout.html' : path);
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('not found');
  }
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const port = server.address().port;

const ALL = ['skeleton-rect', 'skeleton-L', 'skeleton-U',
  'roof-L', 'roof-U', 'corridor', 'corridor-court', 'fence',
  'gate-soseul', 'gate-iljak', 'parcel-palace', 'parcel-temple', 'parcel-choga', 'parcel-hanok'];
const cases = process.argv.slice(2).length ? process.argv.slice(2) : ALL;

let browser;
try { browser = await chromium.launch({ channel: 'chrome' }); }
catch { browser = await chromium.launch(); }
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on('console', (m) => { if (m.type() === 'error') console.error('[page]', m.text()); });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));

for (const c of cases) {
  const url = `http://127.0.0.1:${port}/layout.html?shot=1&case=${c}`;
  await page.goto(url, { waitUntil: 'load' });
  try {
    await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 30000 });
  } catch { console.error('timeout', c); }
  await page.waitForTimeout(250);
  const file = join(OUT, `layout-${c}.png`);
  await page.screenshot({ path: file });
  console.log('saved', file);
}

await browser.close();
server.close();
