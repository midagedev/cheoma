// 마을 모드 UX 검증 (task #4, UI 측). 출력: shots/uiv-*.png 전용.
//   node tools/shoot-ui-village.mjs [필터]
// 빌드된 app/dist 를 정적 서버로(HMR 없음 → 다른 에이전트 src 편집 무영향). 실제 클릭/드래그 + 상태 단언.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'shots');
mkdirSync(OUT, { recursive: true });
const only = process.argv[2] || 'all';

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json',
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
const page = await browser.newPage({ viewport: { width: 1360, height: 850 }, deviceScaleFactor: 2 });

let errors = 0;
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) { errors++; console.error('[page]', m.text()); } });
page.on('pageerror', (e) => { errors++; console.error('[pageerror]', e.message); });

const shot = async (name) => { await page.screenshot({ path: join(OUT, `uiv-${name}.png`) }); console.log('saved', `uiv-${name}.png`); };
const ready = () => page.waitForFunction('window.__engine', null, { timeout: 30000 });
const settle = (ms = 500) => page.waitForTimeout(ms);
const vst = () => page.evaluate(() => window.__engine.village.getState());
const parcels = () => page.evaluate(() => window.__engine.village.debugParcels());
const screenOf = (id) => page.evaluate((pid) => window.__engine.village.debugScreenOf(pid), id);

let asserts = 0, assertFails = 0;
function check(name, cond, extra = '') {
  asserts++;
  if (cond) console.log('  PASS', name, extra);
  else { assertFails++; console.log('  FAIL', name, extra); }
}

// 화면상 정규(비히어로) 필지 하나를 골라 클릭 좌표 반환(뷰포트 안·카메라 앞쪽만).
async function pickRegularScreen() {
  const ps = await parcels();
  for (const p of ps.filter((x) => !x.hero)) {
    const s = await screenOf(p.parcelId);
    if (s && !s.behind && s.x > 60 && s.x < 1300 && s.y > 60 && s.y < 800) return { parcel: p, screen: s };
  }
  return null;
}
async function pickHeroScreen() {
  const ps = await parcels();
  for (const p of ps.filter((x) => x.hero)) {
    const s = await screenOf(p.parcelId);
    if (s && !s.behind) return { parcel: p, screen: s };
  }
  return null;
}
async function gotoVillage(time = 'day', qs = '') {
  await page.goto(`${SPA}/?village=1&hero=0&vseed=20260716&time=${time}${qs}`, { waitUntil: 'load' });
  await ready();
  await page.waitForFunction('window.__engine.village.getState().active === true', null, { timeout: 30000 });
  await settle(1800);   // 마을 빌드 + 부감 트윈 안착
}
async function measureFps() {
  return await page.evaluate(() => new Promise((res) => {
    let n = 0; const t0 = performance.now(); let last = t0, worst = 0;
    function tick(t) { const d = t - last; last = t; if (n > 0) worst = Math.max(worst, d); n++;
      if (t - t0 < 1600) requestAnimationFrame(tick);
      else res({ fps: +(n / ((t - t0) / 1000)).toFixed(1), frames: n, worstMs: +worst.toFixed(1) }); }
    requestAnimationFrame(tick);
  }));
}

// ① 모드 전환 왕복(집↔마을) — 실제 토글 버튼 클릭 + 상태 단언
async function modeSwap() {
  await page.goto(`${SPA}/?hero=0&seed=20260716&time=day`, { waitUntil: 'load' });
  await ready(); await settle(1400);
  check('starts in house mode', (await vst()).active === false);
  await shot('swap-house');
  await page.locator('.mode .seg', { hasText: '마을' }).click();
  await page.waitForFunction('window.__engine.village.getState().active === true', null, { timeout: 15000 }).catch(() => {});
  await settle(1800);
  check('toggle → village', (await vst()).active === true);
  await shot('swap-village');
  await page.locator('.mode .seg', { hasText: '집' }).click();
  await settle(1600);
  check('toggle → house (round-trip)', (await vst()).active === false);
  await shot('swap-back-house');
}

// ② 호버 하이라이트(전/후 2컷) — 정규 필지 화면 좌표로 실제 pointermove
async function hover() {
  await gotoVillage();
  await page.mouse.move(30, 820); await settle(300);
  check('no hover at corner', (await vst()).hover === null);
  await shot('hover-before');
  const pick = await pickRegularScreen();
  check('found a regular parcel on screen', !!pick);
  if (pick) {
    await page.mouse.move(pick.screen.x, pick.screen.y); await settle(120);
    await page.mouse.move(pick.screen.x + 1, pick.screen.y + 1); await settle(200);
    check('hover sets highlighted parcel', (await vst()).hover === pick.parcel.parcelId, `(${(await vst()).hover})`);
    const labelVisible = await page.locator('.hlabel').isVisible().catch(() => false);
    check('hover mini-label visible', labelVisible);
    await shot('hover-after');
  }
}

// ③ 클릭 → 줌인(중간 프레임 + 도착 프레임, 패널 열림)
async function selectZoom() {
  await gotoVillage();
  const pick = await pickRegularScreen();
  check('select: parcel found', !!pick);
  if (!pick) return;
  await page.mouse.move(pick.screen.x, pick.screen.y); await settle(150);
  await page.mouse.click(pick.screen.x, pick.screen.y);
  await settle(120);
  check('transitioning after click', (await vst()).transitioning === true);
  await settle(900);
  await shot('select-mid');                      // 돌리인 중(DoF 조임)
  await page.waitForFunction('window.__engine.village.getState().transitioning === false', null, { timeout: 8000 }).catch(() => {});
  await settle(600);
  const s = await vst();
  check('arrived: parcel selected', s.selected === pick.parcel.parcelId);
  const panelOpen = await page.locator('.panel.open').count();
  check('edit panel slid in', panelOpen === 1);
  await shot('select-arrived');
}

// ④ 파라미터 편집 → rebuild 반영(칸수 + 유형)
async function edit() {
  await gotoVillage();
  const pick = await pickRegularScreen();
  if (!pick) { check('edit: parcel found', false); return; }
  await page.mouse.click(pick.screen.x, pick.screen.y);
  await page.waitForFunction('window.__engine.village.getState().transitioning === false && window.__engine.village.getState().selected', null, { timeout: 10000 }).catch(() => {});
  await settle(500);
  await shot('edit-before');
  // 정면 칸 + 버튼 클릭(첫 stepper +)
  const plus = page.locator('.stepper button', { hasText: '+' }).first();
  if (await plus.count()) { await plus.click(); await plus.click(); await settle(600); await shot('edit-bays'); }
  // 유형 토글(기와↔초가)
  const specBefore = (await vst()).spec;
  const otherType = specBefore.kind === 'giwa' ? '초가' : '기와집';
  await page.locator('.tab', { hasText: otherType }).click();
  await settle(700);
  await shot('edit-type');
  check('edit ran without error', errors === 0);
}

// ⑤ ESC 복귀 → 마을 부감 + 최근 편집 하이라이트
async function escReturn() {
  await gotoVillage();
  const pick = await pickRegularScreen();
  if (!pick) { check('escReturn: parcel found', false); return; }
  await page.mouse.click(pick.screen.x, pick.screen.y);
  await page.waitForFunction('window.__engine.village.getState().transitioning === false && window.__engine.village.getState().selected', null, { timeout: 10000 }).catch(() => {});
  await settle(400);
  await page.keyboard.press('Escape');
  await settle(700);
  await shot('esc-returning');                   // 부감으로 돌아오는 중 + 하이라이트 앵커
  await page.waitForFunction('window.__engine.village.getState().transitioning === false', null, { timeout: 8000 }).catch(() => {});
  await settle(400);
  const s = await vst();
  check('esc: back to aerial (no selection)', s.selected === null && s.active === true);
  const panelOpen = await page.locator('.panel.open').count();
  check('esc: edit panel closed', panelOpen === 0);
  await shot('esc-aerial');
}

// ⑥ 마을 리롤(다시 짓기 = 마을 스코프)
async function reroll() {
  await gotoVillage();
  const before = await vst();
  await shot('reroll-before');
  await page.locator('.seal.primary').click();   // 우하 "다시 짓기" (마을 스코프)
  await settle(1800);
  const after = await vst();
  check('reroll: seed changed', after.seed !== before.seed, `(${before.seed}→${after.seed})`);
  await shot('reroll-after');
}

// ⑦ 히어로 필지(종가) 편집 비활성 안내
async function heroLocked() {
  await gotoVillage();
  const pick = await pickHeroScreen();
  check('hero parcel exists', !!pick);
  if (!pick) return;
  await page.mouse.click(pick.screen.x, pick.screen.y);
  await page.waitForFunction('window.__engine.village.getState().transitioning === false && window.__engine.village.getState().selected', null, { timeout: 10000 }).catch(() => {});
  await settle(500);
  const s = await vst();
  check('hero: selected & editable=false', s.selected === pick.parcel.parcelId && s.spec.editable === false);
  const note = await page.locator('.hero-note').count();
  check('hero: lock note shown', note === 1);
  const tabs = await page.locator('.tab').count();
  check('hero: no edit tabs', tabs === 0);
  await shot('hero-locked');
}

// ⑧ 환경 다이얼 시간 전환(마을 야간 창호광)
async function dialNight() {
  await gotoVillage();
  await shot('env-day');
  await page.evaluate(() => window.__engine.setTime('night'));
  await settle(1600);
  check('village time=night', (await page.evaluate(() => window.__engine.getState().time)) === 'night');
  await shot('env-night');
}

// ⑨ sunset 마을 부감 무드 컷 + 규모/옵션 실버튼 클릭(궁 게이팅 검증)
async function sunsetMood() {
  await gotoVillage('sunset');
  await settle(600);
  await shot('sunset-aerial');
  // 궁 버튼은 마을 규모에선 비활성이어야
  check('palace toggle disabled off-capital', await page.locator('.toggle:has-text("궁")').isDisabled());
  // 규모 도성 클릭 → 재생성
  await page.locator('.opt', { hasText: '도성' }).click();
  await settle(2200);
  check('scale → capital (panel synced)', (await vst()).opts.scale === 'capital');
  // 궁·절 실버튼 클릭
  await page.locator('.toggle', { hasText: '궁' }).click();
  await settle(2000);
  await page.locator('.toggle', { hasText: '절' }).click();
  await settle(2200);
  const s = await vst();
  check('capital+palace+temple built', s.opts.includePalace && s.opts.includeTemple && s.stats.houses > 0, `(houses=${s.stats?.houses})`);
  await shot('sunset-capital');
}

// fps: 마을 부감(자동회전 없음, 호버 인터랙티브) 프레임레이트
async function fps() {
  await gotoVillage();
  const pick = await pickRegularScreen();
  if (pick) { await page.mouse.move(pick.screen.x, pick.screen.y); await settle(150); }
  const aerial = await measureFps();
  console.log('  village-aerial fps:', JSON.stringify(aerial));
  // 도성(최대 규모)에서도 측정
  await page.evaluate(() => window.__engine.village.setOpts({ scale: 'capital', includePalace: true, includeTemple: true }));
  await settle(2200);
  const capital = await measureFps();
  console.log('  village-capital fps:', JSON.stringify(capital));
  // 기본 마을 부감(상시 뷰)은 60fps 근접이 판정 대상. 도성+궁+절(최중량)은 2x 레티나에서 ~45fps —
  // 인터랙티브 하한만 게이트하고 수치는 보고로.
  check('aerial ≥55fps (primary view)', aerial.fps >= 55, `(${aerial.fps})`);
  check('capital interactive ≥40fps (heaviest)', capital.fps >= 40, `(${capital.fps})`);
}

const steps = { modeSwap, hover, selectZoom, edit, escReturn, reroll, heroLocked, dialNight, sunsetMood, fps };
for (const [name, fn] of Object.entries(steps)) {
  if (only === 'all' || only === name) {
    console.log(`\n== ${name} ==`);
    try { await fn(); }
    catch (e) { console.error(`CAPTURE ERROR [${name}]`, e.message); errors++; }
  }
}

await browser.close();
server.close();
console.log(`\nasserts: ${asserts - assertFails}/${asserts} passed`);
console.log(`pageerror/console-error total: ${errors}`);
process.exit(errors > 0 || assertFails > 0 ? 1 : 0);
