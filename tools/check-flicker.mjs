// 촛불 플리커 검증: 같은 night 페이지에서 1.5초 간격 2프레임의 창호 영역을 캡처해
// 밝기(픽셀)가 변하는지 확인한다. 정적 emissive라면 두 크롭이 동일 → 플리커면 상이.
// 사용법: node tools/check-flicker.mjs
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
    const file = join(ROOT, path === '/' ? 'index.html' : path);
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const port = server.address().port;

let browser;
try { browser = await chromium.launch({ channel: 'chrome' }); }
catch { browser = await chromium.launch(); }
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (err) => console.error('[pageerror]', err.message));

await page.goto(`http://127.0.0.1:${port}/index.html?shot=1&env=1&preset=korea&angle=front&time=night&hero=0`, { waitUntil: 'load' });
await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 30000 });

// 창호 패널 영역(정면 뷰). 크리터/눈 없는 정적 창 → 변화는 촛불 플리커에 기인.
const clip = { x: 400, y: 390, width: 480, height: 130 };
const a = await page.screenshot({ clip, path: join(OUT, 'night-flick-a.png') });
await page.waitForTimeout(1500);
const b = await page.screenshot({ clip, path: join(OUT, 'night-flick-b.png') });

const identical = Buffer.compare(a, b) === 0;
console.log('flick crop A vs B (1.5s apart) PNG identical:', identical);
console.log(identical ? 'FAIL: 두 프레임 동일 — 플리커 미동작' : 'PASS: 두 프레임 상이 — 촛불 플리커 동작');

await browser.close();
server.close();
