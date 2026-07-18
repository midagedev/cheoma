// 코어 경로(index.html) ?shot=1 렌더 프로브 — 범인 격리용 (#52 env vs #64 app)
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
const { PNG } = createRequire(import.meta.url)('pngjs');

const ROOT = '/Users/hckim/repo/asiahouse';
const OUT = '/private/tmp/claude-501/-Users-hckim-repo-asiahouse/7a15478e-68e3-4ad3-b08a-bdb86ae4fe92/scratchpad';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  try {
    const p = req.url.split('?')[0];
    const f = join(ROOT, p === '/' ? 'index.html' : p);
    const d = await readFile(f);
    res.writeHead(200, { 'content-type': MIME[extname(f)] || 'application/octet-stream' });
    res.end(d);
  } catch { res.writeHead(404); res.end('nf'); }
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const port = server.address().port;

function luma(buf) {
  const png = PNG.sync.read(buf);
  const d = png.data; let sum = 0, n = 0;
  for (let i = 0; i < d.length; i += 4 * 37) { sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; n++; }
  return sum / n;
}

const browser = await chromium.launch().catch(() => chromium.launch({ channel: 'chrome' }));
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errs = [];
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
await page.goto(`http://127.0.0.1:${port}/index.html?shot=1&env=1&preset=korea&season=autumn&time=dawn`, { waitUntil: 'load' });
await page.waitForFunction('window.__SHOT_READY===true', null, { timeout: 40000 }).catch(() => console.log('SHOT_READY timeout'));
await page.waitForTimeout(500);
const buf = await page.screenshot({ path: join(OUT, 'probe-core-shot.png') });
console.log('core shot luma=', luma(buf).toFixed(1), 'errors=', errs.length ? errs.slice(0, 5) : 0);
await browser.close(); server.close();
