// #109 진단: walk 모드 9초 프리즈 귀속 — 셰이더 컴파일(programs 급증) vs JS 블록 구분.
// walk 시작 후 renderer.info.programs / calls / geos 를 1.5s 간격 폴링. 프리즈 구간에서 wall 점프 관찰.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';
const ROOT = resolve(import.meta.dirname, '..');
const DIST = join(ROOT, 'app', 'dist-bench');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff': 'font/woff', '.woff2': 'font/woff2', '.json': 'application/json' };
const server = createServer(async (req, res) => { const p = decodeURIComponent(req.url.split('?')[0]); try { const f = join(DIST, p === '/' ? 'index.html' : p); const d = await readFile(f); res.writeHead(200, { 'content-type': MIME[extname(f)] || 'application/octet-stream' }); res.end(d); } catch { res.writeHead(404); res.end('x'); } });
await new Promise((ok) => server.listen(4233, '127.0.0.1', ok));
let browser; try { browser = await chromium.launch({ channel: 'chrome', args: ['--use-angle=default'] }); } catch { browser = await chromium.launch(); }
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => console.log('[pageerr]', e.message));
await page.goto('http://127.0.0.1:4233/?village=1&vseed=20260716&lang=ko', { waitUntil: 'load' });
await page.waitForFunction('!!window.__engine', null, { timeout: 30000 });
await page.waitForTimeout(2600);
const probe = () => page.evaluate(() => { const e = window.__engine; const i = e.renderer.info; const w = e.cine.debugWalker && e.cine.debugWalker(); return { t: +performance.now().toFixed(0), programs: (i.programs ? i.programs.length : -1), calls: i.render.calls, tris: +(i.render.triangles / 1e6).toFixed(2), geos: i.memory.geometries, tex: i.memory.textures, wpos: w ? w.pos : null }; });
console.log('aerial:', JSON.stringify(await probe()));
await page.evaluate(() => window.__engine.cine.start('walk'));
const t0 = Date.now();
for (let i = 0; i < 14; i++) { const p = await probe(); console.log(`+${((Date.now() - t0) / 1000).toFixed(1)}s wall | ${JSON.stringify(p)}`); await page.waitForTimeout(1500); }
await browser.close(); server.close();
