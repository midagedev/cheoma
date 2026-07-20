// 플래그십 룩 R3 검증(사용자 정정 2건): 바닥 바운스·HDR 충만 + 평행(비-부채꼴) 그림자.
// 사용: node tools/shoot-look3.mjs
// 산출: shots/look3-*.png. weather clear 이지만 적설 오염 방지 위해 __wx.setAccum(0) 훅 호출.
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

// [파일접미사, 쿼리]
const shots = [
  // ① 기본 뷰(look2-default 동일 조건) — 그늘 리프트 + HDR 충만 비교
  ['default', 'env=1&preset=korea&angle=three-quarter&time=sunset'],
  ['default-front', 'env=1&preset=korea&angle=front&time=sunset'],
  // ② 탑뷰 그림자 평행성(부채꼴 수렴 판정) — 부감으로 원근 수렴 최소화해 물리 평행 확인
  ['top', 'env=1&preset=korea&angle=roof&time=sunset&az=25&el=80'],
  ['top-side', 'env=1&preset=korea&angle=roof&time=sunset&az=90&el=78'],
  // ③ sunset front(단청·창호 가독)
  ['sunset-front', 'env=1&preset=korea&angle=front&time=sunset'],
  ['sunset-closeup', 'env=1&preset=korea&angle=closeup&time=sunset'],
  // ④ day 정오 — 새 바운스가 낮을 안 망치는지 + 림 0 유지
  ['day-tq', 'env=1&preset=korea&angle=three-quarter&time=day'],
  // ⑤ night — 달빛 무드 유지(밤 그늘까지 들리면 안 됨)
  ['night-tq', 'env=1&preset=korea&angle=three-quarter&time=night'],
  // ⑥ ink 회귀
  ['ink-sunset', 'env=1&preset=korea&angle=three-quarter&time=sunset&mode=ink'],
  // dawn 회귀(골든아워 프론트라이트 — 바운스 과하지 않은지)
  ['dawn-tq', 'env=1&preset=korea&angle=three-quarter&time=dawn'],
  ['post0-sunset', 'env=1&preset=korea&angle=three-quarter&time=sunset&post=0'],
  // ⑦ 4 프리셋 각 1컷(pageerror 0, 석양 역광 3/4)
  ['preset-korea', 'env=1&preset=korea&angle=three-quarter&time=sunset'],
  ['preset-temple', 'env=1&preset=temple&angle=three-quarter&time=sunset'],
  ['preset-choga', 'env=1&preset=choga&angle=three-quarter&time=sunset'],
  ['preset-giwa', 'env=1&preset=giwa&angle=three-quarter&time=sunset'],
];

let browser;
try { browser = await chromium.launch({ channel: 'chrome' }); }
catch { browser = await chromium.launch(); }
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const errors = [];
page.on('console', (msg) => { if (msg.type() === 'error') { console.error('[page]', msg.text()); errors.push(msg.text()); } });
page.on('pageerror', (err) => { console.error('[pageerror]', err.message); errors.push('PAGEERROR: ' + err.message); });

for (const [name, qs] of shots) {
  const before = errors.length;
  const url = `http://127.0.0.1:${port}/index.html?shot=1&${qs}`;
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 30000 });
  // clear 인데 적설 누적 버그(weather.js) 방어: 적설 0 고정 후 몇 프레임 안정화.
  await page.evaluate(() => { try { window.__wx && window.__wx.setAccum && window.__wx.setAccum(0); } catch {} });
  await page.waitForTimeout(300);
  const file = join(OUT, `look3-${name}.png`);
  await page.screenshot({ path: file });
  const errd = errors.length - before;
  console.log('saved', file, errd ? `(errors: ${errd})` : '');
}

await browser.close();
server.close();
console.log(errors.length ? `\nTOTAL ERRORS: ${errors.length}` : '\nNO ERRORS');
