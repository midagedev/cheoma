// 궁 단일 씬 프레임당 GL draw 호출 실측(post=0,dof=0,env off 로 씬만 격리).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';
const ROOT = resolve(import.meta.dirname, '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  try { const p = req.url.split('?')[0]; const d = await readFile(join(ROOT, p === '/' ? 'index.html' : p));
    res.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream' }); res.end(d);
  } catch { res.writeHead(404); res.end('nf'); }
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const port = server.address().port;
let browser; try { browser = await chromium.launch({ channel: 'chrome' }); } catch { browser = await chromium.launch(); }
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
await page.addInitScript(() => {
  window.__gl = 0;
  const patch = (proto) => { if (!proto) return;
    for (const fn of ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced']) {
      const orig = proto[fn]; if (!orig) continue;
      proto[fn] = function (...a) { window.__gl++; return orig.apply(this, a); };
    }
  };
  patch(window.WebGL2RenderingContext && window.WebGL2RenderingContext.prototype);
  patch(window.WebGLRenderingContext && window.WebGLRenderingContext.prototype);
});
const preset = process.argv[2] || 'korea';
await page.goto(`http://127.0.0.1:${port}/index.html?shot=1&preset=${preset}&angle=three-quarter&post=0&dof=0`, { waitUntil: 'load' });
await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 30000 });
// 한 프레임의 draw 수 = 두 rAF 사이 증분
const perFrame = await page.evaluate(() => new Promise((res) => {
  requestAnimationFrame(() => { const a = window.__gl; requestAnimationFrame(() => res(window.__gl - a)); });
}));
console.log(preset, 'GL draws/frame (main+shadow, post off):', perFrame);
await browser.close(); server.close();
