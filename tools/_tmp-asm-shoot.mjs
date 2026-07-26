// 히어로 랜딩 조립 검증 — 연속 프레임 캡처 + 수치 계약.
//   ① village.asmStarts === 1 (히어로 랜딩 1회)
//   ② __asm.plan(): 몸채 위임 여부·부재 리플 이웃 간격(ms)
//   ③ 연속 프레임: 실제 rAF 루프를 돌리며 조립 구간 PNG 를 촘촘히 캡처(시간적 형태 판정용)
//   ④ seek 래더: 정지 프레임(부재 순서 판정)
//   ⑤ renderer.info: 직접 render 로 draw call / program / texture / triangle
//   ⑥ 완료 시 잔여 변형 0(maxScaleDev), skip() 즉시 복원
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const ROOT = '/Users/hckim/repo/asiahouse/.claude/worktrees/agent-addfb80313bf43ede';
const DIST = join(ROOT, 'app', 'dist-asm');
const OUT = resolve('/private/tmp/claude-501/-Users-hckim-repo-asiahouse/7a15478e-68e3-4ad3-b08a-bdb86ae4fe92/scratchpad/asm-shots2');
await mkdir(OUT, { recursive: true });
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg',
};
const server = createServer(async (req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]);
  try {
    const file = join(DIST, p === '/' ? 'index.html' : p);
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end('nf'); }
});
const PORT = 4231;
await new Promise((ok) => server.listen(PORT, '127.0.0.1', ok));

let browser;
try { browser = await chromium.launch({ channel: 'chrome' }); }
catch { browser = await chromium.launch(); }
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
let pageErrs = 0;
page.on('pageerror', (e) => { pageErrs++; console.error('[pageerror]', e.message); });
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) console.error('[console]', m.text()); });

await page.goto(`http://127.0.0.1:${PORT}/?seed=42&vseed=20260716&worker=0&lang=en`, { waitUntil: 'load' });
await page.addStyleTag({ content: '.chroma{opacity:1!important;pointer-events:auto!important}' });
await page.waitForFunction(() => !!window.__engine && !!window.__asm, null, { timeout: 60000 });
// 타이틀의 Enter 를 실제로 눌러 제품 랜딩 경로를 탄다(자동 진입 없음).
await page.mouse.move(640, 400);
await page.waitForTimeout(1200);
const enter = page.locator('button', { hasText: 'Enter' }).first();
await enter.click({ timeout: 20000 });
await page.waitForFunction(() => window.__asm?.active === true, null, { timeout: 90000, polling: 50 });

const plan = await page.evaluate(() => window.__asm.plan());
console.log('\n[② PLAN]');
console.log(`  duration=${plan.duration}s  delay(dead time)=${plan.delay}s`);
for (const c of plan.chunks) {
  console.log(`  chunk ${c.name.padEnd(18)} body=${c.body} delegated=${c.delegated} window=${c.windowSec[0]}..${c.windowSec[1]}s`);
  for (const p of c.parts || []) {
    console.log(`      ${p.part.padEnd(9)} members=${String(p.members).padStart(3)} ripple=${(p.rippleSec * 1000).toFixed(1)}ms`
      + ` ranks=${p.ranks}/${p.rawRanks} item=${p.itemSec}s end=${p.endSec}s courseFlow=${p.courseFlow}`);
  }
}

// ③ 연속 프레임: 실 루프를 그대로 돌리며 촘촘히 캡처(조립의 시간적 형태 판정).
console.log('\n[③ CONTINUOUS FRAMES] real rAF loop, 110ms cadence');
const seq = [];
for (let i = 0; i < 150; i++) {
  const s = await page.evaluate(() => ({
    t: +(performance.now() / 1000).toFixed(2),
    active: window.__asm.active,
    dev: window.__asm.maxScaleDev(),
    starts: window.__asm.starts,
  }));
  seq.push(s);
  if (i >= 108) {
    await page.screenshot({ path: join(OUT, `roof-${String(i).padStart(3, '0')}.png`) });
  }
  await page.waitForTimeout(60);
}
console.log('  maxScaleDev trace:', seq.map((s) => `${s.dev}`).join(' '));
console.log(`  asmStarts during landing: ${[...new Set(seq.map((s) => s.starts))].join(',')}`);

// ⑥ 완료 대기 → 잔여 변형 0
await page.waitForFunction(() => window.__asm?.active === false, null, { timeout: 40000 });
const settled = await page.evaluate(() => ({
  dev: window.__asm.maxScaleDev(), starts: window.__asm.starts,
}));
console.log(`\n[⑥ SETTLED] maxScaleDev=${settled.dev} (must be 0) asmStarts=${settled.starts} (must be 1)`);
await page.screenshot({ path: join(OUT, 'settled.png') });

// ⑤ renderer.info — composer 를 우회한 직접 render (그림자 태양 포함)
const info = await page.evaluate(() => {
  const e = window.__engine;
  e.renderer.info.reset();
  e.renderer.render(e.scene, e.camera);
  const i = e.renderer.info;
  return {
    calls: i.render.calls, triangles: i.render.triangles,
    programs: i.programs?.length ?? null,
    textures: i.memory.textures, geometries: i.memory.geometries,
  };
});
console.log('\n[⑤ BUDGET after settle]', JSON.stringify(info));

// ④ seek 래더 — 리플레이를 시작해 정지 프레임으로 부재 순서를 본다.
console.log('\n[④ SEEK LADDER] focus replay');
await page.evaluate(() => { window.__engine.village.replay?.() ?? window.__engine.village.replayFocus?.(); });
await page.waitForFunction(() => window.__asm?.active === true, null, { timeout: 30000 });
await page.evaluate(() => window.__asm.freeze(true));
for (const t of [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]) {
  await page.evaluate((tt) => window.__asm.seek(tt), t);
  await page.screenshot({ path: join(OUT, `seek-${String(t).replace('.', '_')}.png`) });
}
const afterSeek = await page.evaluate(() => {
  window.__asm.seek(1);
  const dev = window.__asm.maxScaleDev();
  window.__asm.freeze(false);
  window.__asm.finish();
  return { dev, devAfterFinish: window.__asm.maxScaleDev(), active: window.__asm.active };
});
console.log(`  seek(1) maxScaleDev=${afterSeek.dev}  finish() dev=${afterSeek.devAfterFinish} active=${afterSeek.active}`);

console.log(`\npageerrors=${pageErrs}`);
console.log(`PNG dir: ${OUT}`);
await browser.close();
server.close();
