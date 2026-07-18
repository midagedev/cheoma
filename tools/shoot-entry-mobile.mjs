// 진입 대개편 모바일 게이트: 세로 폰 뷰포트에서 부팅→랜딩→클로즈업(시트)→부감(peek 카드).
//   브랜딩(낙관 1회·태그라인 부재)·바텀 시트 정합·모드 토글 접근성 확인.
// 빌트 앱(app/dist-entry) 서빙, 포트 4190. 결과: shots/entry-mob-*.png.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium, devices } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..');
const DIST = join(ROOT, 'app', 'dist-entry');
const OUT = join(ROOT, 'shots');
mkdirSync(OUT, { recursive: true });
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff': 'font/woff', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  const path = decodeURIComponent(req.url.split('?')[0]);
  const file = join(DIST, path === '/' ? 'index.html' : path);
  try { const data = await readFile(file); res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' }); res.end(data); }
  catch { res.writeHead(404); res.end('nf'); }
});
await new Promise((ok) => server.listen(4190, '127.0.0.1', ok));

let browser;
try { browser = await chromium.launch({ channel: 'chrome' }); } catch { browser = await chromium.launch(); }
const ctx = await browser.newContext({ ...devices['iPhone 13'] });
const page = await ctx.newPage();
let perr = 0, cerr = 0;
page.on('console', (m) => { if (m.type() === 'error') { const t = m.text(); if (/favicon|404/.test(t)) return; cerr++; console.error('[console]', t); } });
page.on('pageerror', (e) => { perr++; console.error('[pageerror]', e.message); });

const shot = async (n) => { await page.screenshot({ path: join(OUT, `entry-mob-${n}.png`) }); console.log('saved', n); };

await page.goto('http://127.0.0.1:4190/?vseed=20260716&time=sunset&lang=ko', { waitUntil: 'load' });
await page.waitForTimeout(1200); await shot('01-title');
await page.tap('.hero');
await page.waitForTimeout(3000); await shot('02-landing');
await page.waitForTimeout(3600); await shot('03-closeup');       // 랜딩 완료 → 클로즈업(시트 half)
await page.tap('.mode .seg:has(.glyph:text-is("村"))');           // 부감
await page.waitForTimeout(1900); await shot('04-aerial');         // VillagePanel peek 카드
await page.tap('.mode .seg:has(.glyph:text-is("家"))');           // 종가 클로즈업
await page.waitForTimeout(2600); await shot('05-closeup2');

console.log(`\npageErrors=${perr} consoleErrors=${cerr}`);
await browser.close();
server.close();
