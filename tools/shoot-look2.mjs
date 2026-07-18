// 플래그십 룩 R2 검증: 광학 림(역광 게이트) + 역광 기본뷰 + 지면 톤다운 → shots/look2-*.png
// 사용법: NODE_PATH=/Users/hckim/repo/threesur/node_modules node tools/shoot-look2.mjs
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
  // ① 기본 뷰(앱 오픈 동등): 골든아워 역광 + 금빛 림 (shot=1&time=sunset&angle=three-quarter = 비-shot 기본)
  ['default', 'env=1&preset=korea&angle=three-quarter&time=sunset'],
  ['default-front', 'env=1&preset=korea&angle=front&time=sunset'],
  // ② 동일 앵글 day 정오 — 저고도 게이트+순광 게이트로 림 소멸 확인
  ['day-tq', 'env=1&preset=korea&angle=three-quarter&time=day'],
  // ③ 태양이 카메라 뒤로 가는 앵글(sunset, 카메라를 태양 방위 az≈213 로) — 림 소멸/미약 확인
  ['sunset-behind', 'env=1&preset=korea&angle=three-quarter&time=sunset&az=213&el=14'],
  // ④ sunset 지면 톤(정면) — 건물보다 어두운지 (구 look-sunset-front.png 와 비교)
  ['sunset-front', 'env=1&preset=korea&angle=front&time=sunset'],
  ['sunset-closeup', 'env=1&preset=korea&angle=closeup&time=sunset'],
  // R3 처마 언더뷰(클램프 완화) — 서까래 보이고 ㄱ자 하늘 슬리버 없어야
  ['closeup-giwa', 'env=1&preset=giwa&angle=closeup&time=sunset'],
  ['closeup-korea', 'env=1&preset=korea&angle=closeup&time=day'],
  // R3 평행 그림자(부감) — 나무 그림자 서로 평행한지
  ['shadow-top', 'env=1&preset=korea&angle=three-quarter&time=sunset&az=30&el=58'],
  // 시간대 회귀
  ['dawn-tq', 'env=1&preset=korea&angle=three-quarter&time=dawn'],
  ['sunset-autumn', 'env=1&preset=korea&angle=three-quarter&time=sunset&season=autumn'],
  ['day-autumn', 'env=1&preset=korea&angle=three-quarter&time=day&season=autumn'],
  // ⑤ 회귀: night · ink · post0
  ['night-tq', 'env=1&preset=korea&angle=three-quarter&time=night'],
  ['ink-sunset', 'env=1&preset=korea&angle=three-quarter&time=sunset&mode=ink'],
  ['post0-sunset', 'env=1&preset=korea&angle=three-quarter&time=sunset&post=0'],
  // ⑥ 4 프리셋 각 1컷 (pageerror 0 확인, 석양 역광 3/4)
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
  await page.waitForTimeout(300);
  const file = join(OUT, `look2-${name}.png`);
  await page.screenshot({ path: file });
  const errd = errors.length - before;
  console.log('saved', file, errd ? `(errors: ${errd})` : '');
}

await browser.close();
server.close();
console.log(errors.length ? `\nTOTAL ERRORS: ${errors.length}` : '\nNO ERRORS');
