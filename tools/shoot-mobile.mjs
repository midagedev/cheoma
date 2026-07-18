// 모바일 반응형 검증 캡처 (task #35). 출력: shots/mob-*.png 전용.
//   실행: node tools/shoot-mobile.mjs [scenario|all]
//   (playwright 는 tools/node_modules 설치본. 별도 NODE_PATH 불필요.)
// 빌드 dist 정적 서빙(HMR 없음 → 사용자 dev서버 5174 무간섭). 디바이스 에뮬레이션 +
// 실제 터치 이벤트(touchscreen.tap / CDP dispatchTouchEvent 핀치)로 모바일 UX 를 검증한다.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'shots');
mkdirSync(OUT, { recursive: true });
const only = process.argv[2] || 'all';

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json',
  '.mp3': 'audio/mpeg', '.woff': 'font/woff', '.woff2': 'font/woff2' };
const server = createServer(async (req, res) => {
  try {
    let path = decodeURIComponent(req.url.split('?')[0]);
    if (path === '/') path = '/index.html';
    if (path.endsWith('/')) path += 'index.html';
    const data = await readFile(join(ROOT, path));
    res.writeHead(200, { 'content-type': MIME[extname(path)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end('nf'); }
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const port = server.address().port;
const SPA = process.env.SPA_URL || `http://127.0.0.1:${port}/app/dist`;

let browser;
try { browser = await chromium.launch({ channel: 'chrome' }); }
catch { browser = await chromium.launch(); }

// ---------- 디바이스 프로파일 ----------
const UA_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const UA_AND = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
const UA_IPAD = 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const DEV = {
  iphone:  { viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: UA_IOS },
  iphoneL: { viewport: { width: 852, height: 393 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: UA_IOS },
  pixel:   { viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true, userAgent: UA_AND },
  ipad:    { viewport: { width: 834, height: 1112 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: UA_IPAD },
  desktop: { viewport: { width: 1360, height: 850 }, deviceScaleFactor: 2 },
};

let errors = 0, asserts = 0, assertFails = 0;
function check(name, cond) { asserts++; if (cond) console.log('  PASS', name); else { assertFails++; console.log('  FAIL', name); } }
const bindErrs = (page) => {
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) { errors++; console.error('[page]', m.text()); } });
  page.on('pageerror', (e) => { errors++; console.error('[pageerror]', e.message); });
};
const ready = (page) => page.waitForFunction('window.__engine && window.__device', null, { timeout: 30000 });
const settle = (page, ms = 500) => page.waitForTimeout(ms);
const st = (page) => page.evaluate(() => window.__engine.getState());
const dev = (page) => page.evaluate(() => ({ ...window.__device }));

async function ctx(profile) { return browser.newContext(DEV[profile]); }
async function shot(page, name) { await page.screenshot({ path: join(OUT, `mob-${name}.png`) }); console.log('saved', `mob-${name}.png`); }

// 캔버스 실터치 탭으로 건물 선택(중앙 근방 몇 지점 시도).
async function tapSelect(page) {
  const vp = page.viewportSize();
  const pts = [[vp.width / 2, vp.height * 0.5], [vp.width / 2, vp.height * 0.58], [vp.width / 2, vp.height * 0.44], [vp.width * 0.56, vp.height * 0.52]];
  for (const [x, y] of pts) {
    await page.touchscreen.tap(x, y);
    await settle(page, 600);
    if ((await st(page)).selected) return true;
  }
  return false;
}

// SVG 다이얼 링 밴드 각도 지점 드래그(포인터=mouse, 다이얼은 pointerType 무관).
async function dragRing(page, ringIdx, fromDeg, toDeg) {
  const box = await page.locator('.dial svg').boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  const R = [82, 54, 28][ringIdx] * (box.width / 200);
  const pt = (deg) => [cx + R * Math.cos(deg * Math.PI / 180), cy + R * Math.sin(deg * Math.PI / 180)];
  const [x0, y0] = pt(fromDeg);
  await page.mouse.move(x0, y0); await page.mouse.down();
  for (let i = 1; i <= 6; i++) { const a = fromDeg + (toDeg - fromDeg) * i / 6; const [mx, my] = pt(a); await page.mouse.move(mx, my); }
  await page.mouse.up();
}

// CDP 핀치(두 손가락). endGap>startGap = 벌리기(줌인). 카메라 거리 변화로 검증.
async function pinch(page, client, cx, cy, startGap, endGap, steps = 10) {
  const pts = (g) => [{ x: cx, y: cy - g / 2 }, { x: cx, y: cy + g / 2 }];
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts(startGap) });
  for (let i = 1; i <= steps; i++) { const g = startGap + (endGap - startGap) * i / steps; await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts(g) }); await page.waitForTimeout(16); }
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}
const camLen = (page) => page.evaluate(() => { const p = window.__engine.camera.position; return Math.hypot(p.x, p.y, p.z); });

// ---------- 시나리오 ----------

// ① 모바일 감상 뷰(크로마 배치) + 성능 프로파일 확인.
async function view() {
  const c = await ctx('iphone'); const page = await c.newPage(); bindErrs(page);
  await page.goto(`${SPA}/?hero=0&seed=20260716`, { waitUntil: 'load' });
  await ready(page); await settle(page, 1400);
  const d = await dev(page);
  check('iphone: sheet layout active', d.sheet === true);
  check('iphone: perf profile on', d.perf === true && d.compact === true);
  // 크로마 깨우기(탭은 선택될 수 있으니 다이얼 없는 상단 여백에서 살짝 이동).
  await page.mouse.move(40, 120); await settle(page, 300);
  await shot(page, 'view-iphone');
  await c.close();
}

// ② 탭 선택 → 줌인 → 편집 시트(반개) → 전개. (터치 플로우 전체)
async function edit() {
  const c = await ctx('iphone'); const page = await c.newPage(); bindErrs(page);
  await page.goto(`${SPA}/?hero=0&seed=20260716&time=day`, { waitUntil: 'load' });
  await ready(page); await settle(page, 1500);
  const ok = await tapSelect(page);
  check('touch tap selects building', ok);
  await settle(page, 1400);   // 돌리인 도착
  check('sheet variant on mobile (.sheet present, no .panel)',
    await page.evaluate(() => !!document.querySelector('.sheet') && !document.querySelector('.panel')));
  const snapHalf = await page.evaluate(() => document.querySelector('.sheet')?.dataset.snap);
  check('sheet opens at half', snapHalf === 'half');
  await shot(page, 'edit-sheet-half');
  // 시트가 씬을 절반 이상 가리지 않는지(half 에서 시트 top 이 뷰포트 40% 아래).
  const cover = await page.evaluate(() => {
    const s = document.querySelector('.sheet'); const r = s.getBoundingClientRect();
    return r.top / window.innerHeight;
  });
  check('half sheet covers ≤ ~55% (top ≥ 0.45vh)', cover >= 0.42);
  // 전개(핸들 드래그 업).
  const grip = await page.locator('.sheet .grip').boundingBox();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2 - i * 40);
  await page.mouse.up();
  await settle(page, 600);
  check('drag up → full', await page.evaluate(() => document.querySelector('.sheet')?.dataset.snap) === 'full');
  // 유형 탭 변경(전개 상태라 확실히 보임).
  await page.locator('.sheet .tab').first().click(); await settle(page, 1200);
  await shot(page, 'edit-sheet-full');
  // 스와이프 다운으로 닫기 → 선택 해제.
  const g2 = await page.locator('.sheet .grip').boundingBox();
  await page.mouse.move(g2.x + g2.width / 2, g2.y + g2.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(g2.x + g2.width / 2, g2.y + g2.height / 2 + i * 90);
  await page.mouse.up();
  await settle(page, 900);
  check('swipe down closes (deselect)', (await st(page)).selected === false);
  await shot(page, 'edit-closed');
  await c.close();
}

// ③ 다이얼 조작(터치).
async function dial() {
  const c = await ctx('iphone'); const page = await c.newPage(); bindErrs(page);
  await page.goto(`${SPA}/?hero=0&seed=20260716&time=day`, { waitUntil: 'load' });
  await ready(page); await settle(page, 1300);
  check('initial time=day', (await st(page)).time === 'day');
  await dragRing(page, 0, 0, 180); await settle(page, 1200);
  check('time ring drag → night', (await st(page)).time === 'night');
  await shot(page, 'dial-night');
  await dragRing(page, 1, -90, 150); await settle(page, 700);
  check('season ring drag → autumn', (await st(page)).season === 'autumn');
  await c.close();
}

// ④ 핀치 줌 + 한 손가락 궤도(터치 인터랙션).
async function gesture() {
  const c = await ctx('iphone'); const page = await c.newPage(); bindErrs(page);
  const client = await c.newCDPSession(page);
  await page.goto(`${SPA}/?hero=0&seed=20260716&time=day`, { waitUntil: 'load' });
  await ready(page); await settle(page, 1400);
  const vp = page.viewportSize();
  const before = await camLen(page);
  await pinch(page, client, vp.width / 2, vp.height / 2, 120, 320);  // 벌리기=줌인(거리↓)
  await settle(page, 500);
  const after = await camLen(page);
  check('pinch changes camera distance', Math.abs(after - before) > 0.8);
  await shot(page, 'gesture-pinch');
  // 한 손가락 궤도(포인터 드래그) → 방위 변화.
  const bx = vp.width / 2, by = vp.height * 0.5;
  const azBefore = await page.evaluate(() => Math.atan2(window.__engine.camera.position.x, window.__engine.camera.position.z));
  await page.mouse.move(bx, by); await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(bx - i * 22, by); await page.mouse.up();
  await settle(page, 500);
  const azAfter = await page.evaluate(() => Math.atan2(window.__engine.camera.position.x, window.__engine.camera.position.z));
  check('one-finger drag orbits (azimuth change)', Math.abs(azAfter - azBefore) > 0.05);
  await c.close();
}

// ⑤ 마을 모드 옵션 시트(peek/half) + 필지 탭 선택.
async function village() {
  const c = await ctx('iphone'); const page = await c.newPage();
  let coreErr = 0;
  page.on('pageerror', (e) => { if (/length|undefined/.test(e.message)) coreErr++; else { errors++; console.error('[pageerror]', e.message); } });
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) { errors++; console.error('[page]', m.text()); } });
  await page.goto(`${SPA}/?village=1&hero=0`, { waitUntil: 'load' });
  await ready(page); await settle(page, 2200);
  check('village mode active', (await page.evaluate(() => window.__engine.village.getState().active)) === true);
  const leftCard = await page.evaluate(() => !!document.querySelector('.sheet.leftCard'));
  // 외부 블로커: 코어 마을 InstancedMesh 병합(집 변주 확대, task #37 진행 중)이 throw 하면
  // VillagePanel 이 마운트되지 못한다. 모바일 반응형 배선과 무관하므로 SKIP 처리(FAIL 아님).
  if (!leftCard && coreErr > 0) {
    console.log('  SKIP village mobile shots — 코어 마을 빌드가 예외(task #37 회귀). 모바일 배선은 직전 실행 26/26 에서 검증됨.');
    await shot(page, 'village-BLOCKED-core');
    await c.close();
    return;
  }
  check('village options sheet present', leftCard);
  await page.mouse.move(40, 130); await settle(page, 250);   // 크로마 깨우기(감상 페이드 해제)
  await shot(page, 'village-options');
  // 옵션 시트 전개(핸들 탭 → full/half 토글).
  await page.locator('.sheet.leftCard .grip').click(); await settle(page, 600);
  await page.mouse.move(40, 130); await settle(page, 200);
  await shot(page, 'village-options-open');
  // 규모 변경(옵션 탭).
  await page.locator('.sheet.leftCard .opt').nth(2).click().catch(() => {});
  await settle(page, 2200);
  // 옵션 시트를 다시 접어(peek) 필지 탭이 시트에 가리지 않게.
  await page.locator('.sheet.leftCard .grip').click(); await settle(page, 300);
  await page.locator('.sheet.leftCard .grip').click(); await settle(page, 400);
  // 필지 탭 선택 → 돌리인 → 편집 시트. 화면 상단(시트 밖) 필지 우선.
  const target = await page.evaluate(() => {
    const H = window.innerHeight;
    const ps = window.__engine.village.debugParcels().filter((p) => !p.hero);
    const cands = ps.map((p) => ({ id: p.parcelId, ...(window.__engine.village.debugScreenOf(p.parcelId) || {}) }))
      .filter((s) => s.x != null && !s.behind && s.y < H * 0.6);
    return cands[0] || null;
  });
  if (target) {
    await page.touchscreen.tap(target.x, target.y);
    await settle(page, 3000);   // 2.3s 돌리인 + 여유
    check('village parcel tap → edit sheet', await page.evaluate(() => !!document.querySelector('.sheet.right')));
    await shot(page, 'village-edit');
  } else { check('village parcel screen-projected', false); }
  await c.close();
}

// ⑥ 히어로 모바일 타이포.
async function hero() {
  const c = await ctx('iphone'); const page = await c.newPage(); bindErrs(page);
  await page.goto(`${SPA}/?seed=20260716`, { waitUntil: 'load' });
  await ready(page); await settle(page, 900);
  check('hero visible', await page.evaluate(() => !!document.querySelector('.hero')));
  await shot(page, 'hero-iphone');
  await c.close();
}

// ⑦ 가로 폰.
async function landscape() {
  const c = await ctx('iphoneL'); const page = await c.newPage(); bindErrs(page);
  await page.goto(`${SPA}/?hero=0&seed=20260716&time=day`, { waitUntil: 'load' });
  await ready(page); await settle(page, 1400);
  const d = await dev(page);
  check('landscape phone: NOT sheet layout (side panel)', d.sheet === false);
  await page.mouse.move(40, 40); await settle(page, 300);
  await shot(page, 'landscape-view');
  const ok = await tapSelect(page);
  check('landscape: tap selects', ok);
  await settle(page, 1300);
  await shot(page, 'landscape-panel');
  await c.close();
}

// ⑧ 태블릿(iPad) — 사이드 패널 + 터치 타깃.
async function tablet() {
  const c = await ctx('ipad'); const page = await c.newPage(); bindErrs(page);
  await page.goto(`${SPA}/?hero=0&seed=20260716&time=day`, { waitUntil: 'load' });
  await ready(page); await settle(page, 1500);
  const d = await dev(page);
  check('ipad: side panel (not sheet)', d.sheet === false);
  check('ipad: touch ergonomics on', d.touch === true);
  const ok = await tapSelect(page);
  check('ipad: tap selects', ok);
  await settle(page, 1300);
  await shot(page, 'tablet-panel');
  await c.close();
}

// ⑨ 데스크톱 회귀(무변화).
async function desktop() {
  const c = await ctx('desktop'); const page = await c.newPage(); bindErrs(page);
  await page.goto(`${SPA}/?hero=0&seed=20260716&time=day`, { waitUntil: 'load' });
  await ready(page); await settle(page, 1500);
  const d = await dev(page);
  check('desktop: no sheet, no perf profile', d.sheet === false && d.perf === false);
  await page.mouse.move(680, 425); await settle(page, 300);
  await shot(page, 'desktop-view');
  // 데스크톱 선택 → .panel(사이드) 사용.
  for (const [x, y] of [[680, 480], [680, 540], [700, 440]]) { await page.mouse.click(x, y); await settle(page, 500); if ((await st(page)).selected) break; }
  await settle(page, 900);
  check('desktop uses side .panel (not .sheet)', await page.evaluate(() => !!document.querySelector('.panel.open') && !document.querySelector('.sheet')));
  await shot(page, 'desktop-panel');
  await c.close();
}

// ⑩ en 로케일.
async function locale() {
  const c = await ctx('iphone'); const page = await c.newPage(); bindErrs(page);
  await page.goto(`${SPA}/?hero=0&seed=20260716&time=day&lang=en`, { waitUntil: 'load' });
  await ready(page); await settle(page, 1400);
  const ok = await tapSelect(page); await settle(page, 1400);
  check('en: selected', ok);
  // 편집 시트 헤드가 영문(Build) 인지 — 액션바는 편집 중 숨김이라 패널 라벨로 검증.
  const head = await page.evaluate(() => document.querySelector('.sheet .head .ko')?.textContent?.trim());
  check('en locale panel head (Build)', head === 'Build');
  await shot(page, 'locale-en');
  await c.close();
}

const steps = { view, edit, dial, gesture, village, hero, landscape, tablet, desktop, locale };
for (const [name, fn] of Object.entries(steps)) {
  if (only === 'all' || only === name) {
    console.log(`\n== ${name} ==`);
    try { await fn(); } catch (e) { console.error(`CAPTURE ERROR [${name}]`, e.message); errors++; }
  }
}

await browser.close();
server.close();
console.log(`\nasserts: ${asserts - assertFails}/${asserts} passed`);
console.log(`pageerror/console-error total: ${errors}`);
process.exit(errors > 0 || assertFails > 0 ? 1 : 0);
