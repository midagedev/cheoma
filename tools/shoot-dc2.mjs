// 단청 고증 수정(태스크 #23) 검증 캡처 → shots/dc2-*.png
// 감사 캡처(audit-dc-*)와 같은 앵글로 before/after 대비.
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

// [preset, angle]
const jobs = [
  ['korea', 'closeup'],
  ['korea', 'brackets'],
  ['korea', 'front'],
  ['korea', 'three-quarter'],
  ['temple', 'closeup'],
  ['temple', 'brackets'],
  ['temple', 'front'],
  ['temple', 'three-quarter'],
  ['giwa', 'closeup'],
  ['giwa', 'three-quarter'],
  ['choga', 'closeup'],
];

let browser;
try {
  browser = await chromium.launch({ channel: 'chrome' });
} catch {
  browser = await chromium.launch();
}
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on('console', (msg) => { if (msg.type() === 'error') console.error('[page]', msg.text()); });
page.on('pageerror', (err) => console.error('[pageerror]', err.message));

for (const [preset, angle] of jobs) {
  const url = `http://127.0.0.1:${port}/tools/dc2-harness.html?preset=${preset}&angle=${angle}`;
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 30000 });
  await page.waitForTimeout(300);
  const file = join(OUT, `dc2-${preset}-${angle}.png`);
  await page.screenshot({ path: file });
  console.log('saved', file);
}

await browser.close();
server.close();
