// 지붕 "낫 모양 갈고리" 원인 판별 A/B: 같은 정지 진행도에서 두부 변형만 껐다(__tofuStretch=0)
// 켠다. 갈고리가 두 조건에서 동일하면 원인은 탄성이 아니라 서까래(선자연) 청크 노출 순서다.
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { chromium } from 'playwright';

const ROOT = '/Users/hckim/repo/asiahouse/.claude/worktrees/agent-addfb80313bf43ede';
const DIST = join(ROOT, 'app', 'dist-asm');
const OUT = '/private/tmp/claude-501/-Users-hckim-repo-asiahouse/7a15478e-68e3-4ad3-b08a-bdb86ae4fe92/scratchpad/asm-ab3';
await mkdir(OUT, { recursive: true });
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
await new Promise((ok) => server.listen(4234, '127.0.0.1', ok));
let browser;
try { browser = await chromium.launch({ channel: 'chrome' }); } catch { browser = await chromium.launch(); }
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.goto('http://127.0.0.1:4234/?seed=42&vseed=20260716&worker=0&lang=en', { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__engine && !!window.__asm, null, { timeout: 60000 });
await page.mouse.move(640, 400);
await page.waitForTimeout(1200);
await page.locator('button', { hasText: 'Enter' }).first().click({ timeout: 20000 });
await page.waitForFunction(() => window.__asm?.active === true, null, { timeout: 90000 });
await page.waitForFunction(() => window.__asm?.active === false, null, { timeout: 60000 });
await page.waitForTimeout(1500);
// UI 를 접어 패널 레이아웃 팝이 판정을 방해하지 않게 한다.
await page.addStyleTag({ content: '.chroma{opacity:0!important;pointer-events:none!important}' });

const TS = [0.78, 0.80, 0.82, 0.84, 0.86, 0.88, 0.90, 0.92];
// 완전 정합 A/B: 조립 인스턴스 하나 + 루프 정지 + 같은 카메라. 각 t 에서 __tofuStretch 만 토글해
//   두 장을 뽑는다(두 이미지의 유일한 차이가 탄성이다).
await page.evaluate(() => window.__engine.village.replay());
await page.waitForFunction(() => window.__asm?.active === true, null, { timeout: 30000 });
await page.evaluate(() => { window.__asm.freeze(true); window.__engine.debugSetPaused(true); });
const cams = new Set();
for (const t of TS) {
  const tag = `t${String(t).replace('.', '_')}`;
  for (const mode of ['on', 'off']) {
    const cam = await page.evaluate(({ tt, m }) => {
      if (m === 'off') window.__tofuStretch = 0; else delete window.__tofuStretch;
      window.__asm.seek(tt);
      const c = window.__engine.camera;
      return `${c.position.x.toFixed(3)},${c.position.y.toFixed(3)},${c.position.z.toFixed(3)},${c.fov.toFixed(3)}`;
    }, { tt: t, m: mode });
    cams.add(cam);
    await page.screenshot({ path: join(OUT, `${tag}-${mode}.png`) });
  }
}
console.log(`distinct cameras across all 16 shots: ${cams.size} (must be 1) -> ${[...cams][0]}`);
await page.evaluate(() => { delete window.__tofuStretch; window.__engine.debugSetPaused(false); window.__asm.freeze(false); window.__asm.finish(); });
console.log(`PNG dir: ${OUT}`);
await browser.close();
server.close();
