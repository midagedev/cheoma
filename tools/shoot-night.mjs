// 헤드리스 스크린샷: 야간 씬(창호 실내광 + 달·달빛) 검증 → shots/night-*.png
// 사용법: node tools/shoot-night.mjs
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

// [파일접미사, 쿼리]  — index.html shot 경로 재사용(기존 korea-env-*-night 와 직접 비교 가능)
const shots = [
  ['front', 'env=1&preset=korea&angle=front&time=night'],
  ['three-quarter', 'env=1&preset=korea&angle=three-quarter&time=night'],
  ['snow-front', 'env=1&preset=korea&angle=front&time=night&weather=snow'],
  ['snow-three-quarter', 'env=1&preset=korea&angle=three-quarter&time=night&weather=snow'],
  ['ink', 'env=1&preset=korea&angle=three-quarter&time=night&mode=ink'],
  // 창호 클로즈업(실내광 편차 확인)
  ['closeup', 'env=1&preset=korea&angle=closeup&time=night'],
];

let browser;
try { browser = await chromium.launch({ channel: 'chrome' }); }
catch { browser = await chromium.launch(); }
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('console', (msg) => { if (msg.type() === 'error') console.error('[page]', msg.text()); });
page.on('pageerror', (err) => console.error('[pageerror]', err.message));

for (const [name, qs] of shots) {
  const url = `http://127.0.0.1:${port}/index.html?shot=1&${qs}`;
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 30000 });
  await page.waitForTimeout(300);
  const file = join(OUT, `night-${name}.png`);
  await page.screenshot({ path: file });
  console.log('saved', file);
}

await browser.close();
server.close();
