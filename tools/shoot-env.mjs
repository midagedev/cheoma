// 헤드리스 스크린샷: 환경 레이어 ON, 앵글 × 시간대 → shots/korea-env-*.png
// 사용법: node tools/shoot-env.mjs
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

// 앵글 × 시간대 → 6장
const angles = ['three-quarter', 'front'];
const times = ['day', 'sunset', 'night'];

let browser;
try {
  browser = await chromium.launch({ channel: 'chrome' });
} catch {
  browser = await chromium.launch();
}
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('console', (msg) => { if (msg.type() === 'error') console.error('[page]', msg.text()); });
page.on('pageerror', (err) => console.error('[pageerror]', err.message));

for (const angle of angles) {
  for (const time of times) {
    const url = `http://127.0.0.1:${port}/index.html?shot=1&env=1&preset=korea&angle=${angle}&time=${time}`;
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 30000 });
    await page.waitForTimeout(300);
    const file = join(OUT, `korea-env-${angle}-${time}.png`);
    await page.screenshot({ path: file });
    console.log('saved', file);
  }
}

await browser.close();
server.close();
