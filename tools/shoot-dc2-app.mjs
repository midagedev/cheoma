// #25(플래그십 조명 R2) 정착 후, 실제 앱 경로(index.html)에서 단청이 잘 읽히는지 확인 → shots/dc2app-*.png
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'shots');
mkdirSync(OUT, { recursive: true });
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  try {
    const path = req.url.split('?')[0];
    const data = await readFile(join(ROOT, path === '/' ? 'index.html' : path));
    res.writeHead(200, { 'content-type': MIME[extname(path)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const port = server.address().port;

// [preset, angle, time] — day(정면 색 판정) + sunset(플래그십 히어로 룩)
const jobs = [
  ['korea', 'three-quarter', 'day'],
  ['korea', 'three-quarter', 'sunset'],
  ['korea', 'closeup', 'day'],
  ['temple', 'three-quarter', 'day'],
  ['temple', 'three-quarter', 'sunset'],
  ['temple', 'closeup', 'day'],
];

let browser;
try { browser = await chromium.launch({ channel: 'chrome' }); }
catch { browser = await chromium.launch(); }
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on('pageerror', (err) => console.error('[pageerror]', err.message));

for (const [preset, angle, time] of jobs) {
  // env=1 실제 환경, post 기본 ON(플래그십), time 지정
  const url = `http://127.0.0.1:${port}/index.html?shot=1&preset=${preset}&angle=${angle}&env=1&time=${time}`;
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 30000 });
  await page.waitForTimeout(400);
  const file = join(OUT, `dc2app-${preset}-${angle}-${time}.png`);
  await page.screenshot({ path: file });
  console.log('saved', file);
}
await browser.close();
server.close();
