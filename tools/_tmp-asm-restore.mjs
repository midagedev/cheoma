// 앱 경로(playCompoundAssembly + 위임된 playAssembly) 의 정확한 원상복구 + mid-flight skip 검증.
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
await new Promise((ok) => server.listen(4233, '127.0.0.1', ok));
let browser;
try { browser = await chromium.launch({ channel: 'chrome' }); } catch { browser = await chromium.launch(); }
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
let pageErrs = 0;
page.on('pageerror', (e) => { pageErrs++; console.error('[pageerror]', e.message); });

await page.addInitScript(() => {
  window.__snap = () => {
    const g = window.__engine.village.focusRoot?.() || null;
    const root = g || window.__engine.scene.getObjectByName('village-overrides');
    const rows = [];
    root.traverse((o) => rows.push([o.uuid, o.position.y, o.scale.x, o.scale.y, o.scale.z, o.visible]));
    return rows;
  };
  window.__diff = (a, b) => {
    if (a.length !== b.length) return { lengthChanged: [a.length, b.length] };
    let bad = 0, sample = null;
    for (let i = 0; i < a.length; i++) {
      for (let k = 1; k < 6; k++) {
        if (a[i][k] !== b[i][k]) { bad++; if (!sample) sample = { i, k, a: a[i][k], b: b[i][k] }; }
      }
    }
    return { bad, sample };
  };
});

await page.goto('http://127.0.0.1:4233/?seed=42&vseed=20260716&worker=0&lang=en', { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__engine && !!window.__asm, null, { timeout: 60000 });
await page.mouse.move(640, 400);
await page.waitForTimeout(1200);
await page.locator('button', { hasText: 'Enter' }).first().click({ timeout: 20000 });
await page.waitForFunction(() => window.__asm?.active === true, null, { timeout: 90000 });
await page.waitForFunction(() => window.__asm?.active === false, null, { timeout: 60000 });
await page.waitForTimeout(1500);

const rest = await page.evaluate(() => (window.__rest = window.__snap()).length);
console.log(`rest snapshot rows: ${rest}`);

// ① seek 왕복 후 finish → 정확 복원
const r1 = await page.evaluate(() => {
  window.__engine.village.replay();
  return new Promise((ok) => setTimeout(() => ok(window.__asm.active), 300));
});
console.log(`replay active: ${r1}`);
const r2 = await page.evaluate(() => {
  window.__asm.freeze(true);
  window.__asm.seek(0.43);
  const mid = window.__diff(window.__rest, window.__snap());
  window.__asm.seek(1);
  const atOne = window.__diff(window.__rest, window.__snap());
  window.__asm.freeze(false);
  window.__asm.finish();
  const after = window.__diff(window.__rest, window.__snap());
  return { mid, atOne, after };
});
console.log(`  mid-flight t=0.43 differing fields: ${r2.mid.bad} (must be > 0 — animation is doing something)`);
console.log(`  seek(1) differing fields:            ${r2.atOne.bad} (must be 0)  ${JSON.stringify(r2.atOne.sample)}`);
console.log(`  finish() differing fields:           ${r2.after.bad} (must be 0)  ${JSON.stringify(r2.after.sample)}`);

// ② mid-flight skip (실 루프 진행 중 즉시 중단)
await page.waitForTimeout(800);
const r3 = await page.evaluate(async () => {
  window.__engine.village.replay();
  await new Promise((ok) => setTimeout(ok, 2600));
  const activeBefore = window.__asm.active;
  window.__asm.finish();
  await new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)));
  return { activeBefore, activeAfter: window.__asm.active, diff: window.__diff(window.__rest, window.__snap()) };
});
console.log(`  mid-flight skip: active ${r3.activeBefore} -> ${r3.activeAfter}, differing fields ${r3.diff.bad} (must be 0) ${JSON.stringify(r3.diff.sample)}`);
console.log(`  asmStarts total: ${await page.evaluate(() => window.__asm.starts)}`);
console.log(`pageerrors=${pageErrs}`);
await browser.close();
server.close();
