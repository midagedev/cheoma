// heroHandle 도착 후 히어로(종가) 편집 플러밍 확인: rebuildParcel(hero) → buildParcel roofOpts 반영.
// 마을 우선 부팅 → 종가 랜딩 → 종가 focus → roofPitch/eaveOverhang 크게 바꿔 지붕이 실제로 변하는지.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';
const ROOT = resolve(import.meta.dirname, '..');
const DIST = join(ROOT, 'app', 'dist-entry');
const OUT = join(ROOT, 'shots');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff': 'font/woff', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]); const f = join(DIST, p === '/' ? 'index.html' : p);
  try { const d = await readFile(f); res.writeHead(200, { 'content-type': MIME[extname(f)] || 'application/octet-stream' }); res.end(d); } catch { res.writeHead(404); res.end('nf'); }
});
await new Promise((ok) => server.listen(4194, '127.0.0.1', ok));
let browser; try { browser = await chromium.launch({ channel: 'chrome' }); } catch { browser = await chromium.launch(); }
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
let perr = 0; page.on('pageerror', (e) => { perr++; console.error('[pageerror]', e.message); });
await page.goto('http://127.0.0.1:4194/?vseed=20260716&time=day&lang=ko', { waitUntil: 'load' });
await page.waitForTimeout(1000);
await page.click('.hero');
await page.waitForTimeout(7500);   // 랜딩 완료(종가 focus)
const info = await page.evaluate(() => {
  const v = window.__engine.village;
  return { heroId: v.heroId(), editable: window.__engine.village.getState ? undefined : null, heroEditable: !!(window.__engine.scene && v.heroId()) };
});
const heroEditable = await page.evaluate(() => window.__engine.village.getState().selected);
console.log('heroId(selected)=', heroEditable, 'heroId=', info.heroId);
await page.screenshot({ path: join(OUT, 'entry-heroedit-before.png') });
// 종가 편집: roofPitch(=riseScale) 크게 + eaveOverhang 크게 → 지붕이 급하고 처마 깊어져야.
const changed = await page.evaluate(() => {
  const v = window.__engine.village; const id = v.heroId();
  v.rebuild(id, { kind: 'giwa', building: { roofPitch: 0.95, eaveOverhang: 2.8, profileCurve: 0.9 } });
  return id;
});
await page.waitForTimeout(1200);
await page.screenshot({ path: join(OUT, 'entry-heroedit-after.png') });
console.log('rebuild(hero) called for', changed, ' pageErrors=', perr);
await browser.close(); server.close();
