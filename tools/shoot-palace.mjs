// 궁(korea) 프리셋 폴리시 대조 하네스 (태스크 #9).
// 출력: scratchpad/palace/<tag>-<angle>.png  (기본 tag=base)
// 사용: node tools/shoot-palace.mjs [tag]
//   clean day 비교컷(refs 대조) + flagship(env sunset 역광) 인상컷.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = '/private/tmp/claude-501/-Users-hckim-repo-asiahouse/7a15478e-68e3-4ad3-b08a-bdb86ae4fe92/scratchpad/palace';
mkdirSync(OUT, { recursive: true });

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json',
};
const server = createServer(async (req, res) => {
  try {
    const path = req.url.split('?')[0];
    const file = join(ROOT, path === '/' ? 'index.html' : path);
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const port = server.address().port;

const tag = process.argv[2] || 'base';
// clean day 비교컷(구조 대조) — env off, post on(기본)
const cleanAngles = ['front', 'three-quarter', 'side', 'roof', 'closeup'];
// flagship 인상컷 — env sunset 역광 3/4
const url = (params) => `http://127.0.0.1:${port}/index.html?shot=1&preset=korea&${params}`;

let browser;
try { browser = await chromium.launch({ channel: 'chrome' }); }
catch { browser = await chromium.launch(); }
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
let perr = 0;
page.on('console', (m) => { if (m.type() === 'error') console.error('[page]', m.text()); });
page.on('pageerror', (e) => { perr++; console.error('[pageerror]', e.message); });

async function cap(params, name) {
  await page.goto(url(params), { waitUntil: 'load' });
  await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 30000 });
  await page.waitForTimeout(300);
  const file = join(OUT, `${tag}-${name}.png`);
  await page.screenshot({ path: file });
  console.log('saved', file);
}

for (const a of cleanAngles) await cap(`angle=${a}`, a);
// flagship: env on, sunset, autumn 무드, 3/4
await cap('angle=three-quarter&env=1&time=sunset&season=autumn', 'flagship');
// front closeup of eave/bracket band under sunset for detail read
await cap('angle=closeup&env=1&time=sunset', 'flagship-closeup');

console.log('pageerrors:', perr);
await browser.close();
server.close();
