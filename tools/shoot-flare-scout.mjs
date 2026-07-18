// 플레어 프레이밍 스카우트: 태양이 처마선에 걸리는 az/el 조합 탐색. sunUV.y 가 0.4~0.8(처마~지붕)
//   근처면 헤일로가 처마 끝을 스친다. 결과: scratchpad/flare/scout-*.png + sunUV 로그.
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

const combos = [];
for (const az of [12, 24, 34]) for (const el of [-10, -5, 0, 5]) combos.push([az, el]);
for (const [az, el] of combos) {
  await page.goto(`http://127.0.0.1:${port}/index.html?shot=1&env=1&preset=korea&time=sunset&az=${az}&el=${el}`, { waitUntil: 'load' });
  await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 30000 });
  await page.waitForTimeout(200);
  const st = await page.evaluate(() => window.__flare ? { uv: window.__flare.sunUV, amt: window.__flare.amt, front: window.__flare.front } : null);
  const nm = `scout-az${az}-el${el}`;
  await page.screenshot({ path: join(SCRATCH, nm + '.png') });
  console.log(`${nm}: sunUV=[${st ? st.uv.map(v => v.toFixed(2)) : '?'}] amt=${st ? st.amt.toFixed(2) : '?'} front=${st ? st.front : '?'}`);
}
await browser.close(); server.close();
