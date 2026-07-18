// ?shot=1 검은 화면 진단 — 오버레이/캔버스/엔진 상태 덤프
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
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(`http://127.0.0.1:${port}/?shot=1&time=dawn&season=autumn&lang=en&seed=7`, { waitUntil: 'load' });
await page.waitForTimeout(8000);
const info = await page.evaluate(() => {
  const out = {};
  const canvas = document.querySelector('canvas');
  out.canvas = canvas ? { w: canvas.width, h: canvas.height, rect: canvas.getBoundingClientRect().toJSON(), style: canvas.getAttribute('style') } : null;
  out.overlays = [...document.querySelectorAll('body *')].filter((el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 1000 && r.height > 600 && parseFloat(cs.opacity) > 0.5 && cs.display !== 'none' && el.tagName !== 'CANVAS' && (cs.backgroundColor !== 'rgba(0, 0, 0, 0)' || cs.backdropFilter !== 'none');
  }).map((el) => ({ tag: el.tagName, cls: el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className, bg: getComputedStyle(el).backgroundColor, op: getComputedStyle(el).opacity, z: getComputedStyle(el).zIndex }));
  const veil = document.querySelector('.veil');
  out.veil = veil ? { cls: veil.className, op: getComputedStyle(veil).opacity } : null;
  out.bodyBg = getComputedStyle(document.body).backgroundColor;
  out.htmlBg = getComputedStyle(document.documentElement).backgroundColor;
  return out;
});
console.log(JSON.stringify(info, null, 1));
await browser.close(); server.close();
