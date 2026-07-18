// 시네마틱 드라이브 프레임 캡처: 드라이브 × t → shots/drive-*.png
// 사용법: node tools/shoot-drive.mjs [drive...]  (기본: orbit approach crane flyby reveal)
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

const drives = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['orbit', 'approach', 'crane', 'flyby', 'reveal'];
const ts = [0.15, 0.5, 0.85];

let browser;
try {
  browser = await chromium.launch({ channel: 'chrome' });
} catch {
  browser = await chromium.launch(); // 설치된 chromium 폴백
}
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('console', (msg) => { if (msg.type() === 'error') console.error('[page]', msg.text()); });
page.on('pageerror', (err) => console.error('[pageerror]', err.message));

for (const drive of drives) {
  for (const t of ts) {
    const url = `http://127.0.0.1:${port}/index.html?shot=1&env=1&drive=${drive}&t=${t}`;
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 30000 });
    await page.waitForTimeout(250);
    const file = join(OUT, `drive-${drive}-${t}.png`);
    await page.screenshot({ path: file });
    console.log('saved', file);
  }
}

await browser.close();
server.close();
