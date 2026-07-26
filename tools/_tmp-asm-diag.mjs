import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { chromium } from 'playwright';

const ROOT = '/Users/hckim/repo/asiahouse/.claude/worktrees/agent-addfb80313bf43ede';
const DIST = join(ROOT, 'app', 'dist-asm');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2', '.mp3': 'audio/mpeg', '.json': 'application/json', '.svg': 'image/svg+xml' };
const server = createServer(async (req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]);
  try {
    const f = join(DIST, p === '/' ? 'index.html' : p);
    const d = await readFile(f);
    res.writeHead(200, { 'content-type': MIME[extname(f)] || 'application/octet-stream' });
    res.end(d);
  } catch { res.writeHead(404); res.end('nf'); }
});
await new Promise((ok) => server.listen(4232, '127.0.0.1', ok));
let browser;
try { browser = await chromium.launch({ channel: 'chrome' }); } catch { browser = await chromium.launch(); }
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) console.error('[console]', m.text()); });
await page.goto('http://127.0.0.1:4232/?seed=42&vseed=20260716&worker=0&lang=en', { waitUntil: 'load' });
for (let i = 0; i < 24; i++) {
  const s = await page.evaluate(() => ({
    t: Math.round(performance.now()),
    engine: !!window.__engine, asm: !!window.__asm,
    active: window.__asm?.active ?? null, starts: window.__asm?.starts ?? null,
    vstate: window.__engine ? JSON.stringify(window.__engine.village.getState()) : null,
    heroFns: window.__engine ? Object.keys(window.__engine.village).join(',') : null,
    overlay: document.querySelector('.hero, .title, .intro') ? 'present' : 'none',
    buttons: [...document.querySelectorAll('button')].map((b) => (b.textContent || '').trim()).filter(Boolean).slice(0, 8),
  }));
  console.log(JSON.stringify(s));
  await page.waitForTimeout(700);
}
await browser.close();
server.close();
