// 플래그십 룩 R4 검증(골든아워 색온도·색분리). 사용자 정정: "전부 노랗게만 보이지 않게".
// 사용: NODE_PATH=/Users/hckim/repo/threesur/node_modules node tools/shoot-look4.mjs
// 산출: shots/look4-*.png. 각 컷 저장 직후 hue/휘도 통계를 stdout 에 찍는다(주황 단일 피크 감지).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
// pngjs 는 CJS + NODE_PATH 로만 접근 → require 로(ESM 베어 임포트는 NODE_PATH 미존중).
const { PNG } = createRequire(import.meta.url)('pngjs');

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
  // ① 기본 뷰(look3-default 동일 조건) — 색분리 전/후 비교
  ['default', 'env=1&preset=korea&angle=three-quarter&time=sunset'],
  ['default-front', 'env=1&preset=korea&angle=front&time=sunset'],
  // ② sunset front — 단청 뇌록·주홍 가독
  ['sunset-front', 'env=1&preset=korea&angle=front&time=sunset'],
  ['sunset-closeup', 'env=1&preset=korea&angle=closeup&time=sunset'],
  // ③ dawn — 같은 처방(쿨 앰비언트+채도 그레이드)이 새벽에도 적용되는지
  ['dawn-tq', 'env=1&preset=korea&angle=three-quarter&time=dawn'],
  // ④ day/night/ink 회귀 — sat=1.0, 무드 보존
  ['day-tq', 'env=1&preset=korea&angle=three-quarter&time=day'],
  ['night-tq', 'env=1&preset=korea&angle=three-quarter&time=night'],
  ['ink-sunset', 'env=1&preset=korea&angle=three-quarter&time=sunset&mode=ink'],
  ['post0-sunset', 'env=1&preset=korea&angle=three-quarter&time=sunset&post=0'],
  // ⑤ 4 프리셋 각 1컷(pageerror 0, 석양 역광 3/4)
  ['preset-korea', 'env=1&preset=korea&angle=three-quarter&time=sunset'],
  ['preset-temple', 'env=1&preset=temple&angle=three-quarter&time=sunset'],
  ['preset-choga', 'env=1&preset=choga&angle=three-quarter&time=sunset'],
  ['preset-giwa', 'env=1&preset=giwa&angle=three-quarter&time=sunset'],
  // ⑥ 가을 sunset — 단풍 붉음이 주황 배경에 안 먹히는지
  ['autumn-sunset', 'env=1&preset=korea&angle=three-quarter&time=sunset&season=autumn'],
];

function rgb2hsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d > 1e-6) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  return [h, mx === 0 ? 0 : d / mx, mx];
}
function band(h) {
  if (h < 20 || h >= 345) return 'redpink';
  if (h < 50) return 'orange';
  if (h < 70) return 'yellow';
  if (h < 165) return 'green';
  if (h < 200) return 'cyan';
  if (h < 255) return 'blue';
  return 'purple';
}
function stats(png, rowFrom, rowTo) {
  const { width, height, data } = png;
  const y0 = Math.floor(height * rowFrom), y1 = Math.floor(height * rowTo);
  const b = { redpink: 0, orange: 0, yellow: 0, green: 0, cyan: 0, blue: 0, purple: 0 };
  let colored = 0, total = 0, nearBlack = 0, greenDom = 0, coolDom = 0, lumaSum = 0;
  for (let y = y0; y < y1; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4, r = data[i], g = data[i + 1], bl = data[i + 2];
    total++;
    const luma = (0.2126 * r + 0.7152 * g + 0.0722 * bl) / 255;
    lumaSum += luma;
    if (luma < 0.02) nearBlack++;
    if (g > r + 6 && g >= bl - 2) greenDom++;
    if (bl > r + 4 && bl >= g - 2) coolDom++;
    const [h, s, v] = rgb2hsv(r, g, bl);
    if (s > 0.12 && v > 0.06) { b[band(h)]++; colored++; }
  }
  const p = (n) => (100 * n / Math.max(1, colored)).toFixed(1);
  const pt = (n) => (100 * n / Math.max(1, total)).toFixed(1);
  return { meanLuma: (lumaSum / total).toFixed(3), nearBlack: pt(nearBlack), greenDom: pt(greenDom), coolDom: pt(coolDom), band: Object.fromEntries(Object.entries(b).map(([k, v]) => [k, p(v)])) };
}

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
  await page.evaluate(() => { try { window.__wx && window.__wx.setAccum && window.__wx.setAccum(0); } catch {} });
  await page.waitForTimeout(300);
  const file = join(OUT, `look4-${name}.png`);
  const buf = await page.screenshot({ path: file });
  const errd = errors.length - before;
  const png = PNG.sync.read(buf);
  const f = stats(png, 0, 1), sky = stats(png, 0, 0.28);
  console.log(`saved look4-${name}.png ${errd ? `(errors: ${errd})` : ''}`);
  console.log(`  luma=${f.meanLuma} nearBlack=${f.nearBlack}% greenDom=${f.greenDom}% coolDom=${f.coolDom}% | orange=${f.band.orange} redpink=${f.band.redpink} yellow=${f.band.yellow} green=${f.band.green} cyan=${f.band.cyan} blue=${f.band.blue} purple=${f.band.purple}`);
  console.log(`  SKY orange=${sky.band.orange} redpink=${sky.band.redpink} green=${sky.band.green} blue=${sky.band.blue} purple=${sky.band.purple}`);
}

await browser.close();
server.close();
console.log(errors.length ? `\nTOTAL ERRORS: ${errors.length}` : '\nNO ERRORS');
