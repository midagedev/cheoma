// 헤드리스 스크린샷: 날씨 결함 2건 수정 검증 → shots/wxfix-*.png (전용 출력)
// 사용법: node tools/shoot-wxfix.mjs
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'shots');
mkdirSync(OUT, { recursive: true });

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json',
};

const server = createServer(async (req, res) => {
  try {
    const path = req.url.split('?')[0];
    const file = join(ROOT, path === '/' ? 'index.html' : path);
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('not found');
  }
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const port = server.address().port;

const shots = [
  // ── 결함 ①: 지붕 우측(동측) 면 적설 — 무풍에서 전 지붕면 커버 확인 ──
  { name: 'snow-korea-3q-t60',  q: 'shot=1&env=1&preset=korea&angle=three-quarter&time=day&weather=snow',  wind: 0, eval: 'window.__wx.setAccum(1.0)',  wait: 1300 },
  { name: 'snow-korea-3q-t55',  q: 'shot=1&env=1&preset=korea&angle=three-quarter&time=day&weather=snow',  wind: 0, eval: 'window.__wx.setAccum(0.55)', wait: 1300 },
  { name: 'snow-giwa-3q',       q: 'shot=1&env=1&preset=giwa&angle=three-quarter&time=day&weather=snow',   wind: 0, eval: 'window.__wx.setAccum(1.0)',  wait: 1300 },
  { name: 'snow-choga-3q',      q: 'shot=1&env=1&preset=choga&angle=three-quarter&time=day&weather=snow',  wind: 0, eval: 'window.__wx.setAccum(1.0)',  wait: 1300 },
  { name: 'snow-temple-3q',     q: 'shot=1&env=1&preset=temple&angle=three-quarter&time=day&weather=snow', wind: 0, eval: 'window.__wx.setAccum(1.0)',  wait: 1300 },
  // ── 결함 ②: 낙수 스플래시 착지점 — 공중 링 소멸, 지면·기단 파문만 ──
  { name: 'rain-korea-front',   q: 'shot=1&env=1&preset=korea&angle=front&time=day&weather=rain',   wind: 1.6, wait: 1000 },
  { name: 'rain-korea-closeup', q: 'shot=1&env=1&preset=korea&angle=closeup&time=day&weather=rain', wind: 1.2, wait: 1000 },
  { name: 'rain-korea-3q',      q: 'shot=1&env=1&preset=korea&angle=three-quarter&time=day&weather=rain', wind: 1.6, wait: 1000 },
  // ── 결함 ③: weather=clear day 는 적설 0 (백색 렌더 아님) ──
  { name: 'clear-korea-day-3q',  q: 'shot=1&env=1&preset=korea&angle=three-quarter&time=day&weather=clear', wait: 1000 },
  { name: 'clear-korea-day',     q: 'shot=1&env=1&preset=korea&time=day&weather=clear', wait: 1000 },
  // ── 회귀: 야간+눈(창호광·달 무드) ──
  { name: 'night-snow-korea-3q', q: 'shot=1&env=1&preset=korea&angle=three-quarter&time=night&weather=snow', wind: 0, eval: 'window.__wx.setAccum(0.8)', wait: 1000 },
];

let browser;
try { browser = await chromium.launch({ channel: 'chrome' }); }
catch { browser = await chromium.launch(); }

let errors = 0;
for (const s of shots) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('console', (msg) => { if (msg.type() === 'error') { console.error('[page]', s.name, msg.text()); errors++; } });
  page.on('pageerror', (err) => { console.error('[pageerror]', s.name, err.message); errors++; });
  if (s.wind != null) await page.addInitScript((v) => { window.__windScale = v; }, s.wind);
  const url = `http://127.0.0.1:${port}/index.html?${s.q}`;
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 30000 });
  if (s.eval) await page.evaluate(s.eval);
  await page.waitForTimeout(s.wait || 600);
  // clear 컷은 적설 진행도(accum)가 0 이어야 함 — 게이트 자동 확인
  if (s.name.startsWith('clear')) {
    const accum = await page.evaluate(() => (window.__wx ? window.__wx.accum : -1));
    console.log(`  [${s.name}] accum=${accum}${accum > 0.001 ? '  <-- FAIL: clear 인데 적설 진행' : '  (OK, 눈 0)'}`);
  }
  const file = join(OUT, `wxfix-${s.name}.png`);
  await page.screenshot({ path: file });
  console.log('saved', file);
  await page.close();
}

console.log('CONSOLE/PAGE errors:', errors);
await browser.close();
server.close();
