// Svelte SPA UI 검증 캡처 (task #8). 출력: shots/ui-*.png 전용.
// 전제: app dev 서버가 http://localhost:4318 에서 구동 중(npm run dev -- --port 4318).
//   실행: node tools/shoot-ui.mjs
// 두부 이징 + 데모셸 회귀는 정적 ROOT 서버로 기존 index.html ?assemble=1&t= 를 캡처.
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'shots');
mkdirSync(OUT, { recursive: true });
const only = process.argv[2] || 'all';

// 정적 서버(ROOT). SPA 는 빌드된 app/dist(HMR 없음 → 다른 에이전트의 src 편집에 영향 안 받음),
// 데모셸 회귀는 ROOT/index.html. SPA_URL 로 외부 dev 서버를 강제할 수도 있다.
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
const demoBase = `http://127.0.0.1:${port}/index.html`;

let browser;
try { browser = await chromium.launch({ channel: 'chrome' }); }
catch { browser = await chromium.launch(); }
const page = await browser.newPage({ viewport: { width: 1360, height: 850 }, deviceScaleFactor: 2 });

let errors = 0;
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) { errors++; console.error('[page]', m.text()); } });
page.on('pageerror', (e) => { errors++; console.error('[pageerror]', e.message); });

const shot = async (name) => { await page.screenshot({ path: join(OUT, `ui-${name}.png`) }); console.log('saved', `ui-${name}.png`); };
const ready = () => page.waitForFunction('window.__engine || window.__SHOT_READY === true', null, { timeout: 30000 });
const settle = (ms = 500) => page.waitForTimeout(ms);

let asserts = 0, assertFails = 0;
const st = () => page.evaluate(() => window.__engine.getState());
function check(name, cond) {
  asserts++;
  if (cond) console.log('  PASS', name);
  else { assertFails++; console.log('  FAIL', name); }
}
// SVG 다이얼 링 밴드 위 각도(deg, top 기준 시계방향) 지점을 실제 좌표로 드래그.
async function dragRing(ringIdx, fromDeg, toDeg) {
  const box = await page.locator('.dial svg').boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  const R = [82, 54, 28][ringIdx] * (box.width / 200); // viewBox 200 → 렌더 px
  const pt = (deg) => [cx + R * Math.cos(deg * Math.PI / 180), cy + R * Math.sin(deg * Math.PI / 180)];
  const [x0, y0] = pt(fromDeg), [x1, y1] = pt(toDeg);
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) {
    const k = i / 6, a = fromDeg + (toDeg - fromDeg) * k;
    const [mx, my] = pt(a);
    await page.mouse.move(mx, my);
  }
  await page.mouse.up();
}

// ---------- SPA 캡처 ----------
async function base() {
  // 기본 감상 뷰: 신선 방문(골든아워), hero off, 조작 없이 크로마 표시.
  await page.goto(`${SPA}/?hero=0`, { waitUntil: 'load' });
  await ready(); await settle(1200);
  await page.mouse.move(680, 425); // 크로마 깨우기
  await settle(300);
  await shot('base-chroma');
  // 3.5s 무조작 → 크로마 페이드(감상 모드)
  await settle(3600);
  await shot('base-faded');
}

async function hero() {
  await page.goto(`${SPA}/?seed=20260716`, { waitUntil: 'load' });
  await ready(); await settle(700);
  await shot('hero-title');
  // 입장 → reveal 중간
  await page.mouse.click(680, 425);
  await settle(3200);
  await shot('hero-mid');
  // 완료까지 대기(reveal ~12s + 여유), 낙관(조선 전각) 표시
  await settle(11000);
  await page.mouse.move(680, 700);
  await settle(400);
  await shot('hero-done');
}

// 캔버스 클릭으로 건물 선택(실패 시 한 번 더 아래를 시도). 선택 성공 여부 반환.
async function selectByClick() {
  for (const [x, y] of [[680, 480], [680, 540], [700, 440]]) {
    await page.mouse.click(x, y);
    await settle(500);
    if ((await st()).selected) return true;
  }
  return false;
}

async function selectPanel() {
  await page.goto(`${SPA}/?hero=0&seed=20260716&time=day`, { waitUntil: 'load' });
  await ready(); await settle(1500);
  const ok = await selectByClick();     // 실제 건물 클릭 → 패널 열림 + 카메라 포커스
  check('canvas click selects building', ok);
  await settle(1000);
  check('panel open (selected)', (await st()).selected === true);
  await shot('select-panel');
}

async function expansion() {
  // 격자 프리셋(궁)에서 칸 확장 1R→2R→3R — 스테퍼 실제 버튼 클릭 + 상태 단언.
  await page.goto(`${SPA}/?hero=0&seed=20260716&time=day`, { waitUntil: 'load' });
  await ready(); await settle(1200);
  const ok = await selectByClick();        // 먼저 선택 → 패널 열림
  check('select for panel', ok);
  await settle(600);
  await page.locator('.tab', { hasText: '궁' }).click();  // 유형 탭 실제 클릭 → 궁
  await settle(1500);
  check('type tab → 궁(korea)', (await st()).preset === 'korea');
  await shot('exp-1R');
  // 2R (ㄱ) — 스테퍼 버튼 실제 클릭
  await page.locator('.step').nth(1).click();
  await settle(700); await shot('exp-2R-growing');   // 두부 조립 중
  await settle(1800);
  check('stepper→2R (ㄱ)', (await st()).expansion === 2);
  await shot('exp-2R');
  // 3R (ㄷ) — 스테퍼 버튼 실제 클릭
  await page.locator('.step').nth(2).click();
  await settle(700); await shot('exp-3R-growing');
  await settle(1800);
  check('stepper→3R (ㄷ)', (await st()).expansion === 3);
  await shot('exp-3R');
  // 1R 로 되돌리기(스테퍼 감소)
  await page.locator('.step').nth(0).click();
  await settle(1000);
  check('stepper→1R', (await st()).expansion === 1);
}

async function dial() {
  await page.goto(`${SPA}/?hero=0&seed=20260716&time=day`, { waitUntil: 'load' });
  await ready(); await settle(1200);
  check('initial time=day', (await st()).time === 'day');
  await shot('dial-day');
  // 시간 링(외곽) 실제 드래그: day(0°/우) → night(180°/좌)
  await dragRing(0, 0, 180);
  await settle(1400);
  check('drag time ring → night', (await st()).time === 'night');
  await shot('dial-night');
  // 계절 링(중간, 4분할) 드래그 → autumn(90°)
  await dragRing(1, -90, 90);
  await settle(600);
  check('drag season ring → autumn', (await st()).season === 'autumn');
  // 날씨 링(안쪽) 드래그 → snow(150°)
  await dragRing(2, -90, 150);
  await settle(2200);
  check('drag weather ring → snow', (await st()).weather === 'snow');
  check('snow 선택 → winter 자동 정합', (await st()).season === 'winter');
  await shot('dial-winter-snow');
  // 석양 전환(플래그십)도 드래그로 — 씬 화이트아웃과 무관히 상태 전이 확인
  await dragRing(0, 180, 90);
  await settle(1000);
  check('drag time ring → sunset', (await st()).time === 'sunset');
}

async function types() {
  await page.goto(`${SPA}/?hero=0&seed=20260716`, { waitUntil: 'load' });
  await ready(); await settle(1000);
  for (const t of ['korea', 'temple', 'giwa', 'choga']) {
    await page.evaluate((v) => window.__engine.setType(v), t);
    await settle(2000);
    await shot(`type-${t}`);
  }
}

async function postcardShot() {
  await page.goto(`${SPA}/?hero=0&seed=20260716`, { waitUntil: 'load' });
  await ready(); await settle(1500);
  const dataUrl = await page.evaluate(() => window.__engine.postcard({ download: false }));
  const buf = Buffer.from(dataUrl.split(',')[1], 'base64');
  await writeFile(join(OUT, 'ui-postcard.png'), buf);
  console.log('saved', 'ui-postcard.png');
}

async function reroll() {
  await page.goto(`${SPA}/?hero=0`, { waitUntil: 'load' });
  await ready(); await settle(1000);
  // 실제 "다시 짓기" 도장 버튼 클릭 → 재조립
  const btn = page.locator('.seal.primary');
  await btn.click();
  await settle(700);
  await shot('reroll-growing');
  await settle(2200);
  await shot('reroll-done');
}

async function merge() {
  await page.goto(`${SPA}/?hero=0&seed=20260716&time=day`, { waitUntil: 'load' });
  await ready(); await settle(1200);
  const ok = await selectByClick();        // 먼저 선택 → 패널 열림
  check('merge: select by click', ok);
  await settle(600);
  await page.locator('.tab', { hasText: '궁' }).click();  // 유형 탭 → 궁
  await settle(1500);
  check('merge: type → 궁', (await st()).preset === 'korea');
  check('merge candidate available', (await st()).canMerge === true);
  await shot('merge-candidate');          // 부속채 점선 후보
  // 실제 "이웃과 합치기" 도장 버튼 클릭 → 두부처럼 끌려와 ㄱ자
  await page.locator('.merge').click();
  await settle(500);
  await shot('merge-pulling');            // 끌려오는 중(두부)
  await settle(1600);
  check('merge → 2R (ㄱ)', (await st()).expansion === 2);
  await shot('merge-done-2R');
  // 후보 재등장 대기 후 한 번 더 → ㄷ자
  await page.waitForFunction('window.__engine.getState().canMerge === true', null, { timeout: 5000 }).catch(() => {});
  await page.locator('.merge').click();
  await settle(500);
  await shot('merge-pulling-2');
  await settle(1600);
  check('merge → 3R (ㄷ)', (await st()).expansion === 3);
  await shot('merge-done-3R');
}

// 특정 page 로 건물 선택(패널 열기). 성공 여부 반환.
async function selectOn(pg) {
  for (const [x, y] of [[680, 480], [680, 540], [700, 440]]) {
    await pg.mouse.click(x, y);
    await pg.waitForTimeout(500);
    if (await pg.evaluate(() => window.__engine.getState().selected)) return true;
  }
  return false;
}
const faceText = (pg) => pg.evaluate(() => document.querySelector('.seal.primary .face')?.textContent?.trim());
const secText = (pg) => pg.evaluate(() => document.querySelector('.panel h4')?.textContent?.trim());

// 석양 골든아워 폴리시 컷 (조명 R3 안정화 후). 선택·확장·머지를 역광 룩으로.
async function sunsetPolish() {
  await page.goto(`${SPA}/?hero=0&seed=20260716&time=sunset`, { waitUntil: 'load' });
  await ready(); await settle(1400);
  await selectByClick();
  await settle(1000);
  await page.locator('.tab', { hasText: '궁' }).click();   // 궁으로
  await settle(1600);
  await shot('sunset-select');                             // 석양 선택+포커스(궁)
  await page.locator('.step').nth(2).click();              // 3R ㄷ자
  await settle(700); await shot('sunset-exp-3R-growing');  // 두부 성장 중(역광)
  await settle(1900);
  await shot('sunset-exp-3R');                             // ㄷ자 궁 마당, 골든아워
  // 머지 한 컷: 1R 로 리셋 후 합치기로 끌려오는 순간
  await page.locator('.step').nth(0).click();
  await settle(1400);
  await page.waitForFunction('window.__engine.getState().canMerge === true', null, { timeout: 5000 }).catch(() => {});
  await page.locator('.merge').click();
  await settle(560);
  await shot('sunset-merge-pulling');                      // 부속채 말랑 끌려오기(역광)
}

async function i18n() {
  // 1) 명시 ?lang=en / ?lang=ko — 패널 열어 라벨 다수 노출.
  for (const lang of ['en', 'ko']) {
    await page.goto(`${SPA}/?hero=0&seed=20260716&time=day&lang=${lang}`, { waitUntil: 'load' });
    await ready(); await settle(1200);
    await selectByClick();
    await settle(1000);
    const face = await faceText(page), sec = await secText(page);
    check(`lang=${lang}: 버튼 라벨`, lang === 'en' ? face === 'Rebuild' : face === '다시 짓기');
    check(`lang=${lang}: 섹션 라벨`, lang === 'en' ? sec === 'Type' : sec === '유형');
    await shot(`i18n-${lang}`);
  }
  // 2) navigator.language 모킹(playwright locale) — ?lang 없이 자동 판정. 컨텍스트 격리.
  for (const [loc, expect] of [['en-US', 'en'], ['ko-KR', 'ko']]) {
    const ctx = await browser.newContext({ viewport: { width: 1360, height: 850 }, deviceScaleFactor: 2, locale: loc });
    const pg = await ctx.newPage();
    await pg.goto(`${SPA}/?hero=0&seed=20260716&time=day`, { waitUntil: 'load' });
    await pg.waitForFunction('window.__engine', null, { timeout: 30000 });
    await pg.waitForTimeout(1200);
    await selectOn(pg);
    await pg.waitForTimeout(1000);
    const face = await faceText(pg);
    check(`navigator=${loc} → ${expect} 자동판정`, expect === 'en' ? face === 'Rebuild' : face === '다시 짓기');
    await pg.screenshot({ path: join(OUT, `ui-i18n-auto-${expect}.png`) });
    console.log('saved', `ui-i18n-auto-${expect}.png`);
    await ctx.close();
  }
}

// ---------- 두부 이징 + 데모셸 회귀 (기존 index.html ?assemble=1&t=) ----------
async function tofu() {
  const dp = await browser.newPage({ viewport: { width: 1000, height: 800 }, deviceScaleFactor: 2 });
  const dready = () => dp.waitForFunction('window.__SHOT_READY === true', null, { timeout: 30000 });
  // 기둥 스쿼시 시퀀스(closeup) : 눌림→오버슛→안착
  for (const t of [0.26, 0.29, 0.33]) {
    await dp.goto(`${demoBase}?shot=1&assemble=1&t=${t}&env=0&preset=korea&angle=closeup`, { waitUntil: 'load' });
    await dready(); await dp.waitForTimeout(150);
    await dp.screenshot({ path: join(OUT, `ui-tofu-col-${t}.png`) });
    console.log('saved', `ui-tofu-col-${t}.png`);
  }
  // 지붕 출렁 시퀀스(three-quarter)
  for (const t of [0.80, 0.84, 0.90]) {
    await dp.goto(`${demoBase}?shot=1&assemble=1&t=${t}&env=0&preset=korea&angle=three-quarter`, { waitUntil: 'load' });
    await dready(); await dp.waitForTimeout(150);
    await dp.screenshot({ path: join(OUT, `ui-tofu-roof-${t}.png`) });
    console.log('saved', `ui-tofu-roof-${t}.png`);
  }
  // 회귀: 완성(t=1) 1컷
  await dp.goto(`${demoBase}?shot=1&assemble=1&t=1&env=1&time=day&preset=korea&angle=three-quarter`, { waitUntil: 'load' });
  await dready(); await dp.waitForTimeout(150);
  await dp.screenshot({ path: join(OUT, 'ui-regress-assemble-done.png') });
  console.log('saved', 'ui-regress-assemble-done.png');
  await dp.close();
}

// 우측 흰 윤곽 아티팩트 판별: 궁(우측 언덕에 우후면이 가려지는 base 구도) 강제 + 호버 유무.
async function ghostdiag() {
  await page.goto(`${SPA}/?hero=0&preset=korea&time=sunset`, { waitUntil: 'load' });
  await ready(); await settle(1600);
  await page.mouse.move(8, 838);            // 건물 밖(코너) — 호버 없음
  await settle(500);
  const s1 = await st();
  console.log('  no-hover state:', JSON.stringify({ selected: s1.selected, canMerge: s1.canMerge }));
  await shot('diag-nohover');
  await page.mouse.move(700, 470);          // 건물 중앙 호버 → OutlinePass 트리거
  await settle(500);
  await shot('diag-hover');
}

async function diag() {
  // 데모셸(=main.js, setupPost 미사용) 석양 — 씬 과노출이 post 경로 전용인지 판별.
  await page.goto(`${demoBase}?shot=1&env=1&time=sunset&preset=korea&angle=three-quarter&weather=clear`, { waitUntil: 'load' });
  await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 30000 });
  await settle(300);
  await page.screenshot({ path: join(OUT, 'ui-diag-demoshell-sunset.png') });
  console.log('saved ui-diag-demoshell-sunset.png (no post path)');
}

const steps = { base, hero, selectPanel, expansion, merge, dial, types, postcardShot, reroll, i18n, sunsetPolish, ghostdiag, tofu, diag };
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
