// 4프리셋 회귀 대조: 궁 폴리시(#9)가 타 유형에 영향 없는지 확인.
// 출력: scratchpad/palace/reg-<preset>-<angle>.png  + ?assemble=1 pageerror 카운트.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = '/private/tmp/claude-501/-Users-hckim-repo-asiahouse/7a15478e-68e3-4ad3-b08a-bdb86ae4fe92/scratchpad/palace';
mkdirSync(OUT, { recursive: true });
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  try {
    const path = req.url.split('?')[0];
    const data = await readFile(join(ROOT, path === '/' ? 'index.html' : path));
    res.writeHead(200, { 'content-type': MIME[extname(path)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end('nf'); }
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const port = server.address().port;

let browser;
try { browser = await chromium.launch({ channel: 'chrome' }); }
catch { browser = await chromium.launch(); }
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
let perr = 0;
page.on('pageerror', (e) => { perr++; console.error('[pageerror]', e.message); });

async function cap(url, name) {
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 30000 });
  await page.waitForTimeout(200);
  await page.screenshot({ path: join(OUT, name) });
  console.log('saved', name);
}

for (const preset of ['temple', 'choga', 'giwa']) {
  for (const angle of ['three-quarter', 'roof']) {
    await cap(`http://127.0.0.1:${port}/index.html?shot=1&preset=${preset}&angle=${angle}`, `reg-${preset}-${angle}.png`);
  }
}
// 조립 애니 pageerror 게이트 (궁)
await cap(`http://127.0.0.1:${port}/index.html?shot=1&preset=korea&assemble=1&t=0.5`, `reg-korea-assemble.png`);
console.log('ASSEMBLE+REGRESS pageerrors:', perr);
await browser.close(); server.close();
