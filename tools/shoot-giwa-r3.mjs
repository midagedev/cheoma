// giwa 3R 전용 캡처 → shots/giwa-r3-*.png (+ 회귀 컷 giwa-r3-reg-*.png)
// 실행: NODE_PATH=/Users/hckim/repo/threesur/node_modules node tools/shoot-giwa-r3.mjs [preset|only=angle]
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

const arg = process.argv[2] || 'all';
// [preset, angle, env, outname]
let jobs = [
  ['giwa', 'closeup', 0, 'giwa-r3-closeup'],
  ['giwa', 'roof', 0, 'giwa-r3-roof'],
  ['giwa', 'front', 0, 'giwa-r3-front'],
  ['giwa', 'side', 0, 'giwa-r3-side'],
  ['giwa', 'three-quarter', 0, 'giwa-r3-three-quarter'],
];
const reg = [
  ['korea', 'roof', 0, 'giwa-r3-reg-korea-roof'],
  ['korea', 'three-quarter', 0, 'giwa-r3-reg-korea'],
  ['temple', 'roof', 0, 'giwa-r3-reg-temple-roof'],
  ['temple', 'three-quarter', 0, 'giwa-r3-reg-temple'],
  ['choga', 'three-quarter', 0, 'giwa-r3-reg-choga'],
];
if (arg === 'reg') jobs = reg;
else if (arg === 'all') jobs = [...jobs, ...reg];
else if (arg.startsWith('only=')) {
  const a = arg.slice(5);
  jobs = [['giwa', a, 0, `giwa-r3-${a}`]];
}

let browser;
try { browser = await chromium.launch({ channel: 'chrome' }); }
catch { browser = await chromium.launch(); }
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
let errors = 0;
page.on('console', (msg) => { if (msg.type() === 'error') { errors++; console.error('[page]', msg.text()); } });
page.on('pageerror', (err) => { errors++; console.error('[pageerror]', err.message); });

// ISO=1 → env/main/weather 를 우회하는 격리 하네스(다른 에이전트 churn 무관).
const ISO = process.env.ISO === '1';
for (const [preset, angle, env, name] of jobs) {
  const sunQ = process.env.SUN ? `&sun=${process.env.SUN}` : '';
  const url = ISO
    ? `http://127.0.0.1:${port}/tools/giwa-r3-harness.html?preset=${preset}&angle=${angle}${sunQ}`
    : `http://127.0.0.1:${port}/index.html?shot=1&preset=${preset}&angle=${angle}&env=${env}`;
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 30000 });
  await page.waitForTimeout(300);
  const file = join(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  console.log('saved', file);
}

await browser.close();
server.close();
console.log(errors ? `ERRORS: ${errors}` : 'errors: 0');
