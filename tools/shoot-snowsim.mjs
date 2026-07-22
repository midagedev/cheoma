// 헤드리스 스크린샷: 적설 볼륨 시뮬(#52) — 눈 쉘 두께 성장·낙설·처마 립·드리프트 + 빗물 흐름.
// 사용법: node tools/shoot-snowsim.mjs
// 중간 검증 컷은 세션 스크래치패드로(shots/ 오염 방지). 게이트 증거만 shots/ 에 snowsim- 접두사로 수동 복사.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = process.env.SNOWSIM_OUT
  || '/private/tmp/claude-501/-Users-hckim-repo-asiahouse/7a15478e-68e3-4ad3-b08a-bdb86ae4fe92/scratchpad';
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
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const port = server.address().port;

const B = 'shot=1&env=1';
// name, q(쿼리), wind(초기 __windScale), eval(ready 후 실행), wait(추가 대기 ms)
const only = process.argv[2]; // 부분집합 실행: 이름에 포함되는 컷만
let shots = [
  // ── 적설 두께 성장 타임랩스(같은 앵글, accum 0/25/50/75/100%) — 실루엣으로 두께가 자람 ──
  { name: 'accum-t00', q: `${B}&preset=korea&angle=three-quarter&time=day&weather=snow`, eval: 'window.__wx.setAccum(0.0)', wait: 700 },
  { name: 'accum-t25', q: `${B}&preset=korea&angle=three-quarter&time=day&weather=snow`, eval: 'window.__wx.setAccum(0.25)', wait: 700 },
  { name: 'accum-t50', q: `${B}&preset=korea&angle=three-quarter&time=day&weather=snow`, eval: 'window.__wx.setAccum(0.5)', wait: 700 },
  { name: 'accum-t75', q: `${B}&preset=korea&angle=three-quarter&time=day&weather=snow`, eval: 'window.__wx.setAccum(0.75)', wait: 700 },
  { name: 'accum-t100', q: `${B}&preset=korea&angle=three-quarter&time=day&weather=snow`, eval: 'window.__wx.setAccum(1.0)', wait: 700 },
  // ── 지붕 부감(두께·기왓골 요철 확인) ──
  { name: 'roof-full', q: `${B}&preset=korea&angle=roof&time=day&weather=snow`, eval: 'window.__wx.setAccum(1.0)', wait: 700 },
  // ── 처마 눈처마 립·담장 근접 ──
  { name: 'eavelip-closeup', q: `${B}&preset=korea&angle=closeup&time=day&weather=snow`, eval: 'window.__wx.setAccum(1.0)', wait: 700 },
  // ── 지면 드리프트 바람 쏠림(무풍 vs 강풍) accum 0.8 ──
  { name: 'drift-calm', q: `${B}&preset=korea&angle=three-quarter&time=day&weather=snow`, wind: 0, eval: 'window.__wx.setAccum(0.8)', wait: 1400 },
  { name: 'drift-wind', q: `${B}&preset=korea&angle=three-quarter&time=day&weather=snow`, wind: 2.6, eval: 'window.__wx.setAccum(0.8)', wait: 1400 },
  // ── 낙설 이벤트 3컷(미끄러짐→처마 넘어감/퍼프→낙하) ──
  { name: 'slip-a-slide', q: `${B}&preset=korea&angle=three-quarter&time=day&weather=snow`, eval: 'window.__wx.setAccum(1.0); window.__wx.setSlip(0.25)', wait: 500 },
  { name: 'slip-b-puff', q: `${B}&preset=korea&angle=three-quarter&time=day&weather=snow`, eval: 'window.__wx.setAccum(1.0); window.__wx.setSlip(0.55)', wait: 500 },
  { name: 'slip-c-fall', q: `${B}&preset=korea&angle=three-quarter&time=day&weather=snow`, eval: 'window.__wx.setAccum(1.0); window.__wx.setSlip(0.82)', wait: 500 },
  // ── 타입 커버리지(giwa·choga·temple 눈 쉘) ──
  { name: 'type-giwa', q: `${B}&preset=giwa&angle=three-quarter&time=day&weather=snow`, eval: 'window.__wx.setAccum(1.0)', wait: 700 },
  { name: 'type-choga', q: `${B}&preset=choga&angle=three-quarter&time=day&weather=snow`, eval: 'window.__wx.setAccum(1.0)', wait: 700 },
  { name: 'type-temple', q: `${B}&preset=temple&angle=three-quarter&time=day&weather=snow`, eval: 'window.__wx.setAccum(1.0)', wait: 700 },
  // ── 비: 리벌릿(흐름 방향=경사 아래)·젖은 시트 ──
  { name: 'rain-3q', q: `${B}&preset=korea&angle=three-quarter&time=day&weather=rain`, wind: 1.4, wait: 1600 },
  { name: 'rain-roof', q: `${B}&preset=korea&angle=roof&time=day&weather=rain`, wind: 1.0, wait: 1600 },
  { name: 'rain-closeup', q: `${B}&preset=korea&angle=closeup&time=day&weather=rain`, wind: 1.0, wait: 1600 },
  // ── 웅덩이 성장(비 시작 직후 vs 충분히 젖은 뒤) ──
  { name: 'puddle-early', q: `${B}&preset=korea&angle=three-quarter&time=day&weather=rain`, wind: 0.8, wait: 900 },
  { name: 'puddle-grown', q: `${B}&preset=korea&angle=three-quarter&time=day&weather=rain`, wind: 0.8, wait: 5000 },
  { name: 'rain-sunset', q: `${B}&preset=korea&angle=three-quarter&time=sunset&weather=rain`, wind: 1.4, wait: 1600 },
  // ── 회귀: 야간+눈 / 수묵+눈 / 맑음(accum=0) / 겨울+눈 콤보 / 폴백(snowvol=0) ──
  { name: 'reg-night-snow', q: `${B}&preset=korea&angle=three-quarter&time=night&weather=snow`, eval: 'window.__wx.setAccum(1.0)', wait: 700 },
  { name: 'reg-ink-snow', q: `${B}&preset=korea&angle=three-quarter&time=day&weather=snow&mode=ink`, eval: 'window.__wx.setAccum(1.0)', wait: 700 },
  { name: 'reg-clear', q: `${B}&preset=korea&angle=three-quarter&time=day&weather=clear`, wait: 500 },
  { name: 'reg-winter-snow', q: `${B}&preset=korea&angle=three-quarter&time=day&weather=snow&season=winter`, eval: 'window.__wx.setAccum(1.0)', wait: 700 },
  { name: 'reg-fallback', q: `${B}&preset=korea&angle=three-quarter&time=day&weather=snow&snowvol=0`, eval: 'window.__wx.setAccum(1.0)', wait: 700 },
];
if (only) shots = shots.filter((s) => s.name.includes(only));

let browser;
try { browser = await chromium.launch({ channel: 'chrome' }); }
catch { browser = await chromium.launch(); }

let errors = 0;
for (const s of shots) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('console', (m) => { if (m.type() === 'error') { console.error('[page]', s.name, m.text()); errors++; } });
  page.on('pageerror', (e) => { console.error('[pageerror]', s.name, e.message); errors++; });
  if (s.wind != null) await page.addInitScript((v) => { window.__windScale = v; }, s.wind);
  await page.goto(`http://127.0.0.1:${port}/index.html?${s.q}`, { waitUntil: 'load' });
  await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 30000 });
  if (s.eval) await page.evaluate(s.eval);
  await page.waitForTimeout(s.wait || 600);
  const file = join(OUT, `snowsim-${s.name}.png`);
  await page.screenshot({ path: file });
  console.log('saved', file);
  await page.close();
}
await browser.close();
server.close();
console.log(errors ? `DONE with ${errors} console/page errors` : 'DONE — 0 errors');
