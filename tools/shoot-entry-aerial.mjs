// #80 부감 기본 뷰 프레이밍: 규모별(hamlet~hanyang) 마을이 화면을 ~72% 채우는지 + 프레임 가시반경 실측표.
// ?village=1&vscale=X 로 직행 부감. 데스크톱 16:9 + 모바일 세로. 결과: shots/entry-aerial-*.png + 실측 로그.
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
  const p = decodeURIComponent(req.url.split('?')[0]); const f = join(DIST, p === '/' ? 'index.html' : p);
  try { const d = await readFile(f); res.writeHead(200, { 'content-type': MIME[extname(f)] || 'application/octet-stream' }); res.end(d); } catch { res.writeHead(404); res.end('nf'); }
});
await new Promise((ok) => server.listen(4193, '127.0.0.1', ok));
let browser; try { browser = await chromium.launch({ channel: 'chrome' }); } catch { browser = await chromium.launch(); }
let perr = 0;
const measure = async (page, label) => {
  const m = await page.evaluate(() => window.__engine.village.debugFrameRadius());
  console.log(`${label.padEnd(22)} outerR=${m.outerR}  frameMaxR=${m.frameMaxR}  fill%=${(m.outerR / m.frameMaxR * 100).toFixed(0)}  aspect=${m.aspect}  corners=${JSON.stringify(m.corners)}`);
  return m;
};
// 데스크톱 16:9
const dtel = await browser.newPage({ viewport: { width: 1440, height: 810 } });
dtel.on('pageerror', (e) => { perr++; console.error('[pageerror]', e.message); });
for (const s of ['hamlet', 'village', 'town', 'capital', 'hanyang']) {
  await dtel.goto(`http://127.0.0.1:4193/?village=1&vscale=${s}&vseed=20260716&time=day`, { waitUntil: 'load' });
  try { await dtel.waitForFunction('window.__SHOT_READY === true', null, { timeout: 40000 }); } catch { console.error('TIMEOUT', s); }
  await dtel.waitForTimeout(1800);
  await measure(dtel, `desktop ${s}`);
  await dtel.screenshot({ path: join(OUT, `entry-aerial-${s}.png`) });
}
await dtel.close();
// 모바일 세로 (village + hanyang)
const ctx = await browser.newContext({ ...devices['iPhone 13'] });
const mob = await ctx.newPage();
mob.on('pageerror', (e) => { perr++; console.error('[pageerror]', e.message); });
for (const s of ['village', 'hanyang']) {
  await mob.goto(`http://127.0.0.1:4193/?village=1&vscale=${s}&vseed=20260716&time=day`, { waitUntil: 'load' });
  try { await mob.waitForFunction('window.__SHOT_READY === true', null, { timeout: 40000 }); } catch { console.error('TIMEOUT mob', s); }
  await mob.waitForTimeout(1800);
  await measure(mob, `mobile ${s}`);
  await mob.screenshot({ path: join(OUT, `entry-aerial-mob-${s}.png`) });
}
console.log(`\npageErrors=${perr}`);
await browser.close(); server.close();
