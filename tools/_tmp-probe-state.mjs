// 검정 케이스 엔진 상태 덤프
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { chromium } from 'playwright';

const ROOT = '/Users/hckim/repo/asiahouse';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.mp3': 'audio/mpeg', '.svg': 'image/svg+xml' };
const server = createServer(async (req, res) => {
  try {
    const p = req.url.split('?')[0];
    const f = join(ROOT, 'app', 'dist-probe', p === '/' ? 'index.html' : p);
    const d = await readFile(f);
    res.writeHead(200, { 'content-type': MIME[extname(f)] || 'application/octet-stream' });
    res.end(d);
  } catch { res.writeHead(404); res.end('nf'); }
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const port = server.address().port;

const browser = await chromium.launch().catch(() => chromium.launch({ channel: 'chrome' }));
for (const q of ['hero=0&time=dawn&season=autumn&seed=7', 'hero=0&time=dawn&season=autumn&weather=clear&seed=7']) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto(`http://127.0.0.1:${port}/?${q}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__engine, null, { timeout: 15000 }).catch(() => console.log('no __engine'));
  await page.waitForTimeout(5000);
  const st = await page.evaluate(() => {
    const s = window.__engine?.getState?.() || null;
    let extra = {};
    try {
      const th = window.__engine?.__scene || null;
      extra.hasScene = !!th;
    } catch {}
    return { state: s, ...extra };
  });
  console.log(q, '\n  ', JSON.stringify(st));
  await page.close();
}
await browser.close(); server.close();
