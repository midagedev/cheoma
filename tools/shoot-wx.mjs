// 헤드리스 스크린샷: 날씨 물리(바람·쌓임·스플래시) 검증 → shots/wx-*.png (이 태스크 전용 출력)
// 사용법: NODE_PATH=/Users/hckim/repo/threesur/node_modules node tools/shoot-wx.mjs
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

// name: 파일접미사, q: 쿼리, wind: window.__windScale(초기 주입), eval: ready 후 실행할 JS, wait: 추가 대기(ms)
const BASE = 'shot=1&env=1&preset=korea';
const shots = [
  // 눈 쌓임 시간경과(같은 앵글, 쌓임 진행도 0 / 0.5 / 1.0)
  { name: 'snow-accum-t0',  q: `${BASE}&angle=three-quarter&time=day&weather=snow`, eval: 'window.__wx.setAccum(0)', wait: 700 },
  { name: 'snow-accum-t30', q: `${BASE}&angle=three-quarter&time=day&weather=snow`, eval: 'window.__wx.setAccum(0.5)', wait: 700 },
  { name: 'snow-accum-t60', q: `${BASE}&angle=three-quarter&time=day&weather=snow`, eval: 'window.__wx.setAccum(1.0)', wait: 700 },
  // 바람 유/무 눈 비교(무풍 vs 강풍) — 같은 쌓임 0.55
  { name: 'snow-calm', q: `${BASE}&angle=three-quarter&time=day&weather=snow`, wind: 0, eval: 'window.__wx.setAccum(0.55)', wait: 1400 },
  { name: 'snow-wind', q: `${BASE}&angle=three-quarter&time=day&weather=snow`, wind: 2.4, eval: 'window.__wx.setAccum(0.55)', wait: 1400 },
  // 비: 기울기 streak + 스플래시 + 젖음
  { name: 'rain-3q',      q: `${BASE}&angle=three-quarter&time=day&weather=rain`, wind: 1.6, wait: 900 },
  { name: 'rain-front',   q: `${BASE}&angle=front&time=day&weather=rain`, wind: 1.6, wait: 900 },
  { name: 'rain-closeup', q: `${BASE}&angle=closeup&time=day&weather=rain`, wind: 1.2, wait: 900 },
  { name: 'rain-sunset',  q: `${BASE}&angle=three-quarter&time=sunset&weather=rain`, wind: 1.8, wait: 900 },
  // 가을 낙엽 누적(없음 → 가득) + 바람 소용돌이
  { name: 'autumn-litter-t0',   q: `${BASE}&angle=three-quarter&time=day&season=autumn`, eval: 'window.__season.setLitter(0)', wait: 700 },
  { name: 'autumn-litter-full', q: `${BASE}&angle=three-quarter&time=day&season=autumn`, eval: 'window.__season.setLitter(1)', wait: 700 },
  { name: 'autumn-wind',        q: `${BASE}&angle=three-quarter&time=day&season=autumn`, wind: 2.4, eval: 'window.__season.setLitter(0.7)', wait: 1400 },
  // 회귀: 야간+눈 / 수묵+눈 / 맑은 낮
  { name: 'night-snow-front', q: `${BASE}&angle=front&time=night&weather=snow`, wait: 700 },
  { name: 'night-snow-3q',    q: `${BASE}&angle=three-quarter&time=night&weather=snow`, wait: 700 },
  { name: 'ink-snow',         q: `${BASE}&angle=three-quarter&time=day&weather=snow&mode=ink`, wait: 700 },
  { name: 'day-clear',        q: `${BASE}&angle=three-quarter&time=day&weather=clear`, wait: 500 },
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
  const file = join(OUT, `wx-${s.name}.png`);
  await page.screenshot({ path: file });
  console.log('saved', file);
  await page.close();
}

await browser.close();
server.close();
console.log(errors ? `DONE with ${errors} console/page errors` : 'DONE — 0 errors');
