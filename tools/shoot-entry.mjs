// 진입 대개편(#62 마을 우선 진입 · #59 모드 일원화·리플레이 · #72 브랜딩) 게이트 검증.
// 빌트 앱(app/dist-entry)을 실제로 구동해 부팅 시퀀스·모드 토글·리플레이를 촬영한다.
// 사용법: node tools/shoot-entry.mjs
//   포트 4188 고정(사용자 dev 5174 불침해). 결과: shots/entry-*.png + 콘솔에 pageerror·프레임갭 로그.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..');
const DIST = join(ROOT, 'app', 'dist-entry');
const OUT = join(ROOT, 'shots');
mkdirSync(OUT, { recursive: true });
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.svg': 'image/svg+xml',
};
const server = createServer(async (req, res) => {
  const path = decodeURIComponent(req.url.split('?')[0]);
  try {
    const file = join(DIST, path === '/' ? 'index.html' : path);
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise((ok) => server.listen(4188, '127.0.0.1', ok));
const port = 4188;

let browser;
try { browser = await chromium.launch({ channel: 'chrome' }); }
catch { browser = await chromium.launch(); }
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
let pageErrs = 0, consoleErrs = 0;
page.on('console', (m) => { if (m.type() === 'error') { const t = m.text(); if (/favicon|404/.test(t)) return; consoleErrs++; console.error('[console]', t); } });
page.on('pageerror', (e) => { pageErrs++; console.error('[pageerror]', e.message); });

// 프레임 갭 프로브(프리징 계측) — window.__frameGaps 에 rAF 간격(ms) 적산.
await page.addInitScript(() => {
  window.__frameGaps = []; let last = 0;
  const loop = (t) => { if (last) window.__frameGaps.push(t - last); last = t; requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
});

const shot = async (name) => {
  const file = join(OUT, `entry-${name}.png`);
  await page.screenshot({ path: file });
  console.log('saved', file);
};
const maxGap = async (label) => {
  const g = await page.evaluate(() => { const a = window.__frameGaps || []; window.__frameGaps = []; return a.length ? Math.max(...a) : 0; });
  console.log(`framegap[${label}] max=${g.toFixed(0)}ms`);
  return g;
};

// 기본 인터랙티브 부팅(마을 우선). vseed·seed 고정으로 결정론, sunset(플래그십 기본 뷰).
// weather=rain 강제 = 단일건물 날씨 입자가 마을 랜딩에 잔류하지 않는지 스트레스 검증(억제 확인).
const url = `http://127.0.0.1:${port}/?seed=42&weather=rain&vseed=20260716&time=sunset&lang=ko`;
await page.goto(url, { waitUntil: 'load' });
await page.waitForTimeout(1200);      // 타이틀 + 마을 사전 생성
await shot('01-title');

// 타이틀 클릭 → 종가 클로즈업 랜딩 + 조립
await page.evaluate(() => { window.__frameGaps = []; });
await page.click('.hero');
await page.waitForTimeout(1600); await shot('02-landing-early'); await maxGap('landing-early');
await page.waitForTimeout(2400); await shot('03-landing-mid');
await page.waitForTimeout(3200); await shot('04-landing-done'); await maxGap('landing-total');

// 모드 토글: 집(클로즈업) → 마을(부감) 왕복. ModeToggle 세그 클릭(실제 UX 경로).
await page.evaluate(() => { window.__frameGaps = []; });
await page.click('.mode .seg:has(.glyph:text-is("村"))');   // 마을 둘러보기
await page.waitForTimeout(1800); await shot('05-aerial'); await maxGap('to-aerial');
await page.click('.mode .seg:has(.glyph:text-is("家"))');   // 종가 집 보기
await page.waitForTimeout(2600); await shot('06-closeup'); await maxGap('to-closeup');

// 히어로 리플레이 엔진 계약(UI 버튼은 #19에서 제거, 내부 조립 회귀는 유지)
await page.evaluate(() => { window.__frameGaps = []; });
await page.evaluate(() => window.__engine.village.replay());
await page.waitForTimeout(1800); await shot('07-replay-mid');
await page.waitForTimeout(3600); await shot('08-replay-done'); await maxGap('replay-total');

// 연타 안정: 리플레이 3연타
await page.evaluate(() => window.__engine.village.replay()); await page.waitForTimeout(120);
await page.evaluate(() => window.__engine.village.replay()); await page.waitForTimeout(120);
await page.evaluate(() => window.__engine.village.replay()); await page.waitForTimeout(2500);
await shot('09-replay-spam'); await maxGap('replay-spam');

console.log(`\npageErrors=${pageErrs} consoleErrors=${consoleErrs}`);
await browser.close();
server.close();
