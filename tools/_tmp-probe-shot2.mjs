// ?shot=1 렌더 회귀 프로브: dist-envroll(#58 시점) vs dist-envflow(#64) 동일 URL 비교
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
const { PNG } = createRequire(import.meta.url)('pngjs');

const ROOT = '/Users/hckim/repo/asiahouse';
const OUT = '/private/tmp/claude-501/-Users-hckim-repo-asiahouse/7a15478e-68e3-4ad3-b08a-bdb86ae4fe92/scratchpad';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.mp3': 'audio/mpeg', '.svg': 'image/svg+xml' };

function serve(dir) {
  return new Promise((ok) => {
    const s = createServer(async (req, res) => {
      try {
        const p = req.url.split('?')[0];
        const f = join(ROOT, 'app', dir, p === '/' ? 'index.html' : p);
        const d = await readFile(f);
        res.writeHead(200, { 'content-type': MIME[extname(f)] || 'application/octet-stream' });
        res.end(d);
      } catch { res.writeHead(404); res.end('nf'); }
    });
    s.listen(0, '127.0.0.1', () => ok(s));
  });
}

function luma(buf) {
  const png = PNG.sync.read(buf);
  const d = png.data; let sum = 0, n = 0;
  for (let i = 0; i < d.length; i += 4 * 37) { sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; n++; }
  return sum / n;
}

const browser = await chromium.launch().catch(() => chromium.launch({ channel: 'chrome' }));
for (const dir of ['dist-probe']) {
  const s = await serve(dir);
  const port = s.address().port;
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  await page.goto(`http://127.0.0.1:${port}/?shot=1&time=dawn&season=autumn&lang=en&seed=7`, { waitUntil: 'load' });
  await page.waitForTimeout(9000); // 히어로 스킵·프리워밍 여유
  const buf = await page.screenshot({ path: join(OUT, `probe-shot-${dir}.png`) });
  console.log(dir, 'luma=', luma(buf).toFixed(1), 'errors=', errs.length ? errs.slice(0, 5) : 0);
  await page.close(); s.close();
}
await browser.close();
