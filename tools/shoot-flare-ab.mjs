// 플레어 ON/OFF A/B: 같은 프레이밍에서 flare 토글만 바꿔 기여분을 육안 분리. 베이스 씬 표류를
//   최소화하려 토글 후 대기를 짧게. 결과: scratchpad/flare/ab-*-on.png / -off.png.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..');
const SCRATCH = '/private/tmp/claude-501/-Users-hckim-repo-asiahouse/7a15478e-68e3-4ad3-b08a-bdb86ae4fe92/scratchpad/flare';
mkdirSync(SCRATCH, { recursive: true });
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  try { const p = req.url.split('?')[0]; const f = join(ROOT, p === '/' ? 'index.html' : p);
    const d = await readFile(f); res.writeHead(200, { 'content-type': MIME[extname(f)] || 'application/octet-stream' }); res.end(d);
  } catch { res.writeHead(404); res.end('nf'); }
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const port = server.address().port;
let browser; try { browser = await chromium.launch({ channel: 'chrome' }); } catch { browser = await chromium.launch(); }
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));

const frames = process.argv.slice(2);
const list = frames.length ? frames : ['az24-el-5', 'az24-el-8', 'az24-el0', 'az12-el-6', 'az30-el-6'];
for (const key of list) {
  const m = key.match(/az(-?\d+)-el(-?\d+)/); const az = m[1], el = m[2];
  await page.goto(`http://127.0.0.1:${port}/index.html?shot=1&env=1&preset=korea&time=sunset&az=${az}&el=${el}`, { waitUntil: 'load' });
  await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 30000 });
  await page.waitForTimeout(200);
  const st = await page.evaluate(() => window.__flare ? { uv: window.__flare.sunUV, amt: window.__flare.amt } : null);
  await page.screenshot({ path: join(SCRATCH, `ab-${key}-on.png`) });
  await page.evaluate(() => window.__flare.setEnabled(false));
  await page.waitForTimeout(80);
  await page.screenshot({ path: join(SCRATCH, `ab-${key}-off.png`) });
  await page.evaluate(() => window.__flare.setEnabled(true));
  console.log(`ab-${key}: sunUV=[${st ? st.uv.map(v => v.toFixed(2)) : '?'}] amt=${st ? st.amt.toFixed(2) : '?'}`);
}
await browser.close(); server.close();
