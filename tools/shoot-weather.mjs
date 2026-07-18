// 헤드리스 스크린샷: 날씨(눈·비) 조합 → shots/korea-weather-*.png
// 사용법: node tools/shoot-weather.mjs
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

// env=1 · three-quarter 앵글 고정. 파일명 → 쿼리
const shots = [
  { name: 'korea-weather-snow-day',   q: 'time=day&weather=snow' },
  { name: 'korea-weather-snow-night', q: 'time=night&weather=snow' },
  { name: 'korea-weather-rain-sunset', q: 'time=sunset&weather=rain' },
  { name: 'korea-weather-rain-day',   q: 'time=day&weather=rain' },
  // 보너스: 수묵 + 눈
  { name: 'korea-inksnow',            q: 'time=day&weather=snow&mode=ink' },
];

let browser;
try {
  browser = await chromium.launch({ channel: 'chrome' });
} catch {
  browser = await chromium.launch();
}
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('console', (msg) => { if (msg.type() === 'error') console.error('[page]', msg.text()); });
page.on('pageerror', (err) => console.error('[pageerror]', err.message));

for (const { name, q } of shots) {
  const url = `http://127.0.0.1:${port}/index.html?shot=1&env=1&preset=korea&angle=three-quarter&${q}`;
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 30000 });
  // 파티클이 낙하·재순환하며 자연스러운 분포가 되도록 추가 프레임 대기
  await page.waitForTimeout(900);
  const file = join(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  console.log('saved', file);
}

await browser.close();
server.close();
