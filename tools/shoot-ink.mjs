// 수묵 렌더 헤드리스 캡처: ink.html → shots/korea-ink-{front,three-quarter,side}.png
// 사용법: node tools/shoot-ink.mjs [preset]  (기본: korea)
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
    const file = join(ROOT, path === '/' ? 'ink.html' : path);
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('not found');
  }
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const port = server.address().port;

const preset = process.argv[2] || 'korea';
const angles = ['front', 'three-quarter', 'side'];

let browser;
try {
  browser = await chromium.launch({ channel: 'chrome' });
} catch {
  browser = await chromium.launch(); // 설치된 chromium 폴백
}
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('console', (msg) => { if (msg.type() === 'error') console.error('[page]', msg.text()); });
page.on('pageerror', (err) => console.error('[pageerror]', err.message));

for (const angle of angles) {
  const url = `http://127.0.0.1:${port}/ink.html?shot=1&preset=${preset}&angle=${angle}`;
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 30000 });
  await page.waitForTimeout(300);
  const file = join(OUT, `${preset}-ink-${angle}.png`);
  await page.screenshot({ path: file });
  console.log('saved', file);
}

await browser.close();
server.close();
