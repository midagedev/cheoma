// 헤드리스 스크린샷: 계절 × 앵글 → shots/season-*.png
// 사용법: node tools/shoot-seasons.mjs [season...]  (기본: spring summer autumn winter)
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
    const file = join(ROOT, path === '/' ? 'index.html' : path);
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('not found');
  }
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const port = server.address().port;

const seasons = process.argv.slice(2).length ? process.argv.slice(2) : ['spring', 'summer', 'autumn', 'winter'];
const angles = ['three-quarter', 'front'];
const time = process.env.TIME || 'day';

let browser;
try {
  browser = await chromium.launch({ channel: 'chrome' });
} catch {
  browser = await chromium.launch();
}
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('console', (msg) => { if (msg.type() === 'error') console.error('[page]', msg.text()); });
page.on('pageerror', (err) => console.error('[pageerror]', err.message));

for (const season of seasons) {
  for (const angle of angles) {
    const url = `http://127.0.0.1:${port}/seasons.html?shot=1&season=${season}&angle=${angle}&time=${time}`;
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 30000 });
    await page.waitForTimeout(300);
    const file = join(OUT, `season-${season}-${angle}.png`);
    await page.screenshot({ path: file });
    console.log('saved', file);
  }
}

await browser.close();
server.close();
