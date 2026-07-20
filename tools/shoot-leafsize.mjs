// #125 낙엽 크기 검증 샷 — 가을 히어로 근경(사람/담장 스케일 대비). 인자: dist(dist-bench|dist-prof) port tag.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';
const ROOT = resolve(import.meta.dirname, '..');
const DISTNAME = process.argv[2] || 'dist-prof';
const PORT = +(process.argv[3] || 4254);
const TAG = process.argv[4] || 'after';
const DIST = join(ROOT, 'app', DISTNAME);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json', '.woff': 'font/woff', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
const server = createServer(async (req, res) => { const p = decodeURIComponent(req.url.split('?')[0]); try { const f = join(DIST, p === '/' ? 'index.html' : p); const d = await readFile(f); res.writeHead(200, { 'content-type': MIME[extname(f)] || 'application/octet-stream' }); res.end(d); } catch { res.writeHead(404); res.end('nf'); } });
await new Promise((ok) => server.listen(PORT, '127.0.0.1', ok));
let browser; try { browser = await chromium.launch({ channel: 'chrome', args: ['--use-angle=default', '--ignore-gpu-blocklist'] }); } catch { browser = await chromium.launch({ args: ['--use-angle=default'] }); }
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
let pageErr = 0; page.on('pageerror', (e) => { pageErr++; console.error('[pageerror]', e.message); });
const ev = (fn, a) => page.evaluate(fn, a);
const wait = (ms) => page.waitForTimeout(ms);

// 히어로 랜딩(종가 근경) 진입 → 가을 → 낙엽 낙하 관측 → 샷.
await page.goto(`http://127.0.0.1:${PORT}/?seed=42&vseed=20260716&lang=ko`, { waitUntil: 'load' });
await page.waitForFunction('!!window.__engine', null, { timeout: 30000 });
await wait(1500);
await page.mouse.move(640, 400); await wait(80);
await ev(() => { const h = document.querySelector('.hero'); if (h) h.click(); });
await wait(9000);   // 랜딩 시퀀스(리빌·조립·정착)
await ev(() => window.__engine.setSeason('autumn'));
await ev(() => window.__engine.setTime && window.__engine.setTime('sunset'));
await wait(5000);   // 낙엽 낙하 + 계절 크로스페이드 정착
await page.screenshot({ path: join(ROOT, 'shots', `fix-perf-leaf-${TAG}.png`) });
// 지면 낙엽 누적도 확인용: litter 최대 고정.
await ev(() => window.__season && window.__season.setLitter(1.0));
await wait(1200);
await page.screenshot({ path: join(ROOT, 'shots', `fix-perf-leaf-${TAG}-litter.png`) });
console.log(`[${TAG}] shot saved (dist=${DISTNAME}) pageErr=${pageErr}`);
await browser.close(); server.close();
