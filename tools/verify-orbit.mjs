// 기본 카메라 자동 궤도 회전 검증(사용자 스펙).
// 사용: node tools/verify-orbit.mjs
// 판정:
//  A 회전(일반 ?hero=0): 5초 간격 2컷 diff 高 (카메라가 돌고 있음)
//  B 정지(?shot=1)     : 5초 간격 2컷 diff ≈0 (자동 회전 완전 비활성 → 캡처 재현성)
//  C 조작 일시정지     : 드래그 후 유휴 창(10초) 동안 diff 低, 유휴 경과 후 diff 高(재개)
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
const { PNG } = createRequire(import.meta.url)('pngjs');

const ROOT = resolve(import.meta.dirname, '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  try {
    const p = req.url.split('?')[0];
    const d = await readFile(join(ROOT, p === '/' ? 'index.html' : p));
    res.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream' }); res.end(d);
  } catch { res.writeHead(404); res.end('nf'); }
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const port = server.address().port;

// 두 PNG 버퍼의 "유의미하게 바뀐 픽셀" 비율(%). 임계 24(채널 최대 델타).
function diffPct(a, b) {
  const pa = PNG.sync.read(a), pb = PNG.sync.read(b);
  const n = Math.min(pa.data.length, pb.data.length);
  let changed = 0, total = 0;
  for (let i = 0; i < n; i += 4) {
    total++;
    const d = Math.max(Math.abs(pa.data[i] - pb.data[i]), Math.abs(pa.data[i + 1] - pb.data[i + 1]), Math.abs(pa.data[i + 2] - pb.data[i + 2]));
    if (d > 24) changed++;
  }
  return (100 * changed / total).toFixed(2);
}

let browser;
try { browser = await chromium.launch({ channel: 'chrome' }); }
catch { browser = await chromium.launch(); }
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const base = `http://127.0.0.1:${port}/index.html`;

// ---- A. 회전(일반 모드, 히어로만 끔 → 로드 직후 자동 회전 허용) ----
await page.goto(`${base}?hero=0&env=1&time=sunset`, { waitUntil: 'load' });
await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 30000 });
await page.waitForTimeout(4000);              // 이즈-업(2.6s) 지나 회전 안정
const a1 = await page.screenshot();
await page.waitForTimeout(5000);
const a2 = await page.screenshot();
console.log(`A 회전(일반):        5초 diff = ${diffPct(a1, a2)}%   (기대: 高, 카메라 공전)`);

// ---- B. 정지(shot 모드 → ORBIT 비활성) ----
await page.goto(`${base}?shot=1&preset=korea&env=1&time=sunset`, { waitUntil: 'load' });
await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 30000 });
await page.evaluate(() => { try { window.__wx?.setAccum?.(0); } catch {} });
await page.waitForTimeout(1500);
const b1 = await page.screenshot();
await page.waitForTimeout(5000);
const b2 = await page.screenshot();
console.log(`B 정지(shot):         5초 diff = ${diffPct(b1, b2)}%   (기대: ≈0, 자동회전 OFF)`);

// ---- C. 조작 일시정지 → 유휴 후 재개 ----
await page.goto(`${base}?hero=0&env=1&time=sunset`, { waitUntil: 'load' });
await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 30000 });
await page.waitForTimeout(4000);
// 캔버스 중앙에 짧은 드래그(OrbitControls 'start'→'end' 발생 → 즉시 정지 + 10초 유휴 예약)
const box = await page.locator('canvas').first().boundingBox();
const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
await page.mouse.move(cx, cy);
await page.mouse.down();
await page.mouse.move(cx + 20, cy + 6, { steps: 4 });
await page.mouse.up();
await page.waitForTimeout(500);
const c1 = await page.screenshot();
await page.waitForTimeout(3000);              // 유휴 창(10초) 이내 → 정지 유지
const c2 = await page.screenshot();
console.log(`C 조작후 유휴(≤10s):  3초 diff = ${diffPct(c1, c2)}%   (기대: 低, 일시정지 유지)`);
await page.waitForTimeout(9000);              // 총 ~12.5초 경과 → 재개 + 이즈업
const c3 = await page.screenshot();
await page.waitForTimeout(3500);
const c4 = await page.screenshot();
console.log(`C 유휴 경과후(>10s):  3.5초 diff = ${diffPct(c3, c4)}%   (기대: 高, 부드럽게 재개)`);

console.log(errors.length ? `\nPAGEERRORS: ${errors.length}\n - ${errors.join('\n - ')}` : '\nNO PAGEERRORS');
await browser.close();
server.close();
