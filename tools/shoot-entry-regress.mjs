// 진입 대개편 회귀 게이트: 기존 URL 계약(?shot=1·?hero=0·?village=1·프리셋)이 불변인지.
//   ?shot=1  → 단일건물 씬 부팅(마을 아님), 오토로테이션 off.
//   ?hero=0  → 타이틀 없이 단일건물 인터랙티브.
//   ?village=1 → 곧장 마을 부감.
//   ?shot=1&preset=* → 4유형 로드 pageerror 0.
// 빌트 앱(app/dist-entry) 서빙, 포트 4189. 결과: shots/entry-reg-*.png + 씬 상태·pageerror 로그.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

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
await new Promise((ok) => server.listen(4189, '127.0.0.1', ok));

let browser;
try { browser = await chromium.launch({ channel: 'chrome' }); } catch { browser = await chromium.launch(); }
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
let perr = 0, cerr = 0;
page.on('console', (m) => { if (m.type() === 'error') { const t = m.text(); if (/favicon|404/.test(t)) return; cerr++; console.error('[console]', t); } });
page.on('pageerror', (e) => { perr++; console.error('[pageerror]', e.message); });

const load = async (qs, name, { waitReady = true, settle = 600 } = {}) => {
  await page.goto(`http://127.0.0.1:4189/${qs}`, { waitUntil: 'load' });
  if (waitReady) { try { await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 30000 }); } catch { console.error('TIMEOUT', name); } }
  await page.waitForTimeout(settle);
  const st = await page.evaluate(() => { try { return { village: window.__engine.village.getState().active, sel: window.__engine.getState().selected, preset: window.__engine.getState().preset }; } catch { return null; } });
  console.log(name.padEnd(22), JSON.stringify(st));
  await page.screenshot({ path: join(OUT, `entry-reg-${name}.png`) });
};

await load('?shot=1&seed=20260716&time=sunset', 'shot', { settle: 500 });
await load('?hero=0&seed=20260716&time=day', 'hero0');
await load('?village=1&vseed=20260716&time=day', 'village1', { settle: 1400 });
for (const p of ['korea', 'temple', 'giwa', 'choga']) await load(`?shot=1&preset=${p}&seed=7`, `preset-${p}`, { settle: 350 });

console.log(`\npageErrors=${perr} consoleErrors=${cerr}`);
await browser.close();
server.close();
