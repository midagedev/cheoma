// 헤드리스 스크린샷: 소품 세트 5장 + 대표 소품 확대 5장 → shots/props-*.png
// 사용법: node tools/shoot-props.mjs
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

const sets = ['temple', 'palace', 'giwa', 'choga', 'common'];
// 대표 소품 확대(석탑·석등·해태·장독대·장승) + 시드 변형 확인용
const singles = ['pagoda', 'stone-lantern', 'haetae', 'jangdokdae', 'jangseung-pair'];

let browser;
try { browser = await chromium.launch({ channel: 'chrome' }); }
catch { browser = await chromium.launch(); }
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('console', (msg) => { if (msg.type() === 'error') console.error('[page]', msg.text()); });
page.on('pageerror', (err) => console.error('[pageerror]', err.message));

async function shoot(url, file) {
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 30000 });
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(OUT, file) });
  console.log('saved', file);
}

for (const s of sets) {
  await shoot(`http://127.0.0.1:${port}/props.html?shot=1&set=${s}`, `props-set-${s}.png`);
}
for (const p of singles) {
  await shoot(`http://127.0.0.1:${port}/props.html?shot=1&prop=${p}&seed=7`, `props-${p}.png`);
}
// 시드 변형(같은 소품 3종 시드) — 석탑·해태·장독대
for (const p of ['pagoda', 'jangdokdae']) {
  for (const sd of [3, 11, 29]) {
    await shoot(`http://127.0.0.1:${port}/props.html?shot=1&prop=${p}&seed=${sd}`, `props-${p}-seed${sd}.png`);
  }
}

await browser.close();
server.close();
