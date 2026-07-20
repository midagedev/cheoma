// #125 진단: 전환별 신규 셰이더 프로그램 개수 + checkShaderErrors/KHR 가용성 (dist-prof 구동).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';
const ROOT = resolve(import.meta.dirname, '..'), DIST = join(ROOT, 'app', 'dist-prof'), PORT = 4248;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json', '.woff': 'font/woff', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.glb': 'model/gltf-binary' };
const server = createServer(async (req, res) => { const p = decodeURIComponent(req.url.split('?')[0]); try { const f = join(DIST, p === '/' ? 'index.html' : p); const d = await readFile(f); res.writeHead(200, { 'content-type': MIME[extname(f)] || 'application/octet-stream' }); res.end(d); } catch { res.writeHead(404); res.end('nf'); } });
await new Promise((ok) => server.listen(PORT, '127.0.0.1', ok));
let browser; try { browser = await chromium.launch({ channel: 'chrome', args: ['--use-angle=default', '--ignore-gpu-blocklist'] }); } catch { browser = await chromium.launch({ args: ['--use-angle=default'] }); }
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
const ev = (fn, a) => page.evaluate(fn, a);
const wait = (ms) => page.waitForTimeout(ms);
await page.goto(`http://127.0.0.1:${PORT}/?village=1&vseed=20260716&lang=ko`, { waitUntil: 'load' });
await page.waitForFunction('!!window.__engine && !!window.__engine.renderer', null, { timeout: 30000 });
await wait(2800);

const caps = await ev(() => {
  const r = window.__engine.renderer;
  const gl = r.getContext();
  return {
    checkShaderErrors: r.debug ? r.debug.checkShaderErrors : 'n/a',
    khrParallel: !!gl.getExtension('KHR_parallel_shader_compile'),
    hasCompileAsync: typeof r.compileAsync === 'function',
    programs: r.info.programs ? r.info.programs.length : -1,
  };
});
console.log('CAPS:', JSON.stringify(caps));

// 신규 프로그램 추적: transition 전/후 programs 목록 diff(cacheKey 접두).
const snapshot = () => ev(() => (window.__engine.renderer.info.programs || []).map((p) => p.cacheKey || p.name || '?'));
async function measure(label, code, settleMs) {
  const before = await snapshot();
  const beforeSet = new Set(before);
  await ev((c) => { window.__t0 = performance.now(); (new Function(c))(); }, code);
  await wait(settleMs);
  const after = await snapshot();
  const added = after.filter((k) => !beforeSet.has(k));
  console.log(`\n[${label}] programs ${before.length} → ${after.length}  (+${added.length} new)`);
  // 새 프로그램 cacheKey 를 재질 종류로 요약(맨 앞 토큰 몇 개).
  const summ = {};
  for (const k of added) { const tag = String(k).slice(0, 42); summ[tag] = (summ[tag] || 0) + 1; }
  for (const [k, n] of Object.entries(summ).slice(0, 20)) console.log(`    +${n}  ${k}`);
}

const heroId = await ev(() => window.__engine.village.heroId());
await measure('focus-in', `window.__engine.village.focus(${JSON.stringify(heroId)})`, 3000);
const parcels = await ev(() => window.__engine.village.debugParcels ? window.__engine.village.debugParcels() : []);
const sel = await ev(() => window.__engine.village.getState().selected);
const editable = (parcels || []).filter((p) => p.editable).map((p) => p.parcelId);
const target = editable.find((id) => id !== sel) ?? editable[0];
await measure(`hop ${sel}→${target}`, `window.__engine.village.switchTo(${JSON.stringify(target)})`, 3000);
await measure('focus-out', `window.__engine.village.return()`, 2600);
await measure('season→autumn', `window.__engine.setSeason('autumn')`, 3200);
await measure('time→night', `window.__engine.setTime('night')`, 2600);

console.log('\ndone.');
await browser.close(); server.close();
