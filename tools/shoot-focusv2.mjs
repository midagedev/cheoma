// focus 연속체 v2(#92) 게이트 검증 — 빌트 앱(app/dist-focusv2)을 실제 구동해 촬영.
// 사용법: node tools/shoot-focusv2.mjs
//   포트 4205 고정(사용자 dev 5174 불침해). 게이트 컷은 shots/focusv2-*, 중간 컷은 스크래치패드.
// 게이트: ① 줌 연속체 4컷 ② 패널 모프 before/mid/after ③ 리플레이 비종가 ④ 리롤 웨이브 3컷
//   ⑤ 모바일 2컷 ⑥ 회귀(부팅·shot·hero0·village1·4프리셋 0에러) ⑦ 크리틱 3건(월대난간·물매 라이브·기와 접힘)
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..');
const DIST = join(ROOT, 'app', 'dist-focusv2');
const OUT = join(ROOT, 'shots');
const SCRATCH = '/private/tmp/claude-501/-Users-hckim-repo-asiahouse/7a15478e-68e3-4ad3-b08a-bdb86ae4fe92/scratchpad';
mkdirSync(OUT, { recursive: true });
mkdirSync(SCRATCH, { recursive: true });
const PORT = 4205;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.woff': 'font/woff', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
const server = createServer(async (req, res) => {
  let path = decodeURIComponent(req.url.split('?')[0]);
  if (path === '/') path = '/index.html';
  try {
    const data = await readFile(join(DIST, path));
    res.writeHead(200, { 'content-type': MIME[extname(path)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise((ok) => server.listen(PORT, '127.0.0.1', ok));
const base = `http://127.0.0.1:${PORT}`;

let browser;
try { browser = await chromium.launch({ channel: 'chrome' }); } catch { browser = await chromium.launch(); }

const errors = [];
function watch(page, tag) {
  page.on('console', (m) => { if (m.type() === 'error') { const t = m.text(); if (/favicon|404/.test(t)) return; errors.push(`[${tag}] ${t}`); console.error(`[${tag}]`, t); } });
  page.on('pageerror', (e) => { errors.push(`[${tag}] ${e.message}`); console.error(`[${tag} pageerror]`, e.message); });
}
const ev = (page, fn, ...a) => page.evaluate(fn, ...a);
const wait = (page, ms) => ev(page, (m) => new Promise((r) => setTimeout(r, m)), ms);
async function shot(page, name, gate = false) {
  const file = join(gate ? OUT : SCRATCH, `focusv2-${name}.png`);
  await page.screenshot({ path: file });
  console.log('saved', file);
}
async function ready(page) { await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 40000 }); await wait(page, 400); }
const cont = (page) => ev(page, () => window.__engine.village.debugContinuum());
// focus 완료 대기(transitioning=false && selected)
async function waitFocused(page, timeout = 8000) {
  await page.waitForFunction(() => { const c = window.__engine.village.debugContinuum(); return c.selected && !c.transitioning; }, null, { timeout });
}
async function waitAerial(page, timeout = 8000) {
  await page.waitForFunction(() => { const c = window.__engine.village.debugContinuum(); return !c.selected && !c.transitioning; }, null, { timeout });
}

// ─────────────────────── 부팅 + 마을 진입 ───────────────────────
async function boot(page, extra = '') {
  await page.goto(`${base}/?seed=42&vseed=20260716&time=sunset&lang=ko${extra}`, { waitUntil: 'load' });
  await ready(page);
  await wait(page, 900);            // 타이틀 + 사전 생성
}

const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
watch(page, 'desk');
await boot(page);
await shot(page, 'reg-01-title');
// 히어로 랜딩(#6 회귀 + 패널 숨김 확인)
await page.click('.hero');
await wait(page, 1800); await shot(page, 'landing-early');
await waitFocused(page); await wait(page, 800);
await shot(page, 'reg-02-landing', true);

// 부감 복귀(近→遠 토글) — 이후 모든 연속체 테스트의 출발점.
await ev(page, () => window.__engine.village.return());
await waitAerial(page); await wait(page, 600);
console.log('aerial continuum:', JSON.stringify(await cont(page)));

// 편집 가능한 정규 giwa·choga·palace 필지 id 확보.
const parcels = await ev(page, () => window.__engine.village.debugParcels());
const giwa = parcels.find((p) => p.kind === 'giwa' && !p.hero && p.editable);
const choga = parcels.find((p) => p.kind === 'choga' && !p.hero && p.editable);
const anyRegular = giwa || choga;
console.log('parcels giwa=', giwa?.parcelId, 'choga=', choga?.parcelId, 'total=', parcels.length);

// ─────────────────── ① 줌 연속체 4컷 ───────────────────
await shot(page, 'zoom-01-aerial', true);
// 중간 줌(임계 위 — 후보 하이라이트, 자동 focus 미발동)
await ev(page, (id) => window.__engine.village.debugDolly(0.62, id), anyRegular.parcelId);
await wait(page, 350); await shot(page, 'zoom-02-mid', true);
console.log('mid continuum:', JSON.stringify(await cont(page)));
// 임계 이하 → 자동 focus-in(스냅 돌리). 전환 중 컷.
await ev(page, (id) => window.__engine.village.debugDolly(0.46, id), anyRegular.parcelId);
await wait(page, 700); await shot(page, 'zoom-03-dolly', true);
const midC = await cont(page);
console.log('dolly continuum:', JSON.stringify(midC));
await waitFocused(page); await wait(page, 700);
await shot(page, 'zoom-04-closeup', true);
console.log('focused continuum:', JSON.stringify(await cont(page)));

// ─────────────────── ② 패널 모프 before/mid/after ───────────────────
// focus-out 으로 돌아가며 패널이 집→마을 역모프. 그리고 다시 focus-in 하며 모프 캡처.
await ev(page, () => window.__engine.village.return());
await waitAerial(page); await wait(page, 500);
await shot(page, 'morph-before', true);         // 마을 섹션(부감)
await ev(page, (id) => window.__engine.village.focus(id), (giwa || choga).parcelId);
await wait(page, 850); await shot(page, 'morph-mid', true);   // 돌리 중 crossfade
await waitFocused(page); await wait(page, 600);
await shot(page, 'morph-after', true);          // 집 섹션(근접)

// ─────────────────── ⑦ 크리틱: 기와 basic 접힘 + 물매 라이브 3컷 ───────────────────
// (지금 giwa focus 상태) 기와 basic 패널(고급 접힘) 컷.
await shot(page, 'critic-giwa-basic', true);
// 지붕 물매(riseScale, route building) 라이브 드래그 3컷 — App 라이브 경로(input 이벤트).
async function setSlider(key, value) {
  const ok = await ev(page, ({ key, value }) => {
    const el = document.querySelector(`input[data-key="${key}"]`);
    if (!el) return false;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(el, String(value));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }, { key, value });
  return ok;
}
const box0 = await ev(page, (id) => window.__engine.village.debugOverlayBox(id), (giwa || choga).parcelId);
const hasRise = await setSlider('riseScale', giwa ? 0.7 : 0.55);
await wait(page, 250); await shot(page, 'critic-live-01', true);
await setSlider('riseScale', giwa ? 0.95 : 0.68);
await wait(page, 250); await shot(page, 'critic-live-02', true);
await setSlider('riseScale', giwa ? 1.18 : 0.77);
await wait(page, 300); await shot(page, 'critic-live-03', true);
const box1 = await ev(page, (id) => window.__engine.village.debugOverlayBox(id), (giwa || choga).parcelId);
console.log('live roof-pitch box before/after:', JSON.stringify(box0), JSON.stringify(box1), 'sliderFound=', hasRise);

// ─────────────────── ③ 리플레이 비종가 필지 ───────────────────
// 현재 정규 필지 focus 중. 再(replay) → 오버레이 재조립. 조립 중 컷.
await ev(page, () => window.__engine.village.replay());
await wait(page, 900); await shot(page, 'replay-regular-mid', true);
await waitFocused(page); await wait(page, 500);
await shot(page, 'replay-regular-done', true);

// ─────────────────── ④ 리롤 웨이브 in-app 3컷 ───────────────────
await ev(page, () => window.__engine.village.return());
await waitAerial(page); await wait(page, 500);
await ev(page, () => { window.__waveT0 = performance.now(); window.__engine.village.rerollWave(); });
await wait(page, 700); await shot(page, 'wave-01-disasm', true);
await wait(page, 1100); await shot(page, 'wave-02-terrain', true);
await wait(page, 1000); await shot(page, 'wave-03-asm', true);
await page.waitForFunction(() => !window.__engine.village.isWaving(), null, { timeout: 8000 });
await wait(page, 700); await shot(page, 'wave-04-done', true);
console.log('after wave continuum:', JSON.stringify(await cont(page)));

// ─────────────────── ⑦ 크리틱: 관아 월대난간 before/after ───────────────────
{
  const pp = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  watch(pp, 'palace');
  // 관아(heroStyle 'palace')는 town·capital(궁 없이)의 고을 중심 코어로 생성된다(궁을 켜면 궁역은 랜드마크).
  await pp.goto(`${base}/?village=1&vscale=town&seed=7&time=day&lang=ko`, { waitUntil: 'load' });
  await ready(pp); await wait(pp, 1400);
  const pl = await ev(pp, () => window.__engine.village.debugParcels());
  const palace = pl.find((p) => p.hero && p.heroStyle === 'palace');
  console.log('palace parcel:', palace?.parcelId, 'heroes:', pl.filter((p) => p.hero).map((p) => p.heroStyle));
  if (palace) {
    await ev(pp, (id) => window.__engine.village.focus(id), palace.parcelId);
    await pp.waitForFunction(() => { const c = window.__engine.village.debugContinuum(); return c.selected && !c.transitioning; }, null, { timeout: 9000 });
    await wait(pp, 700);
    // 월대(기단) 난간이 프레임에 크게 잡히도록 근접 돌리(줌 연속체 등가) — off/on 대비 가독.
    await ev(pp, (id) => window.__engine.village.debugDolly(0.18, id), palace.parcelId);
    await wait(pp, 400);
    // 월대난간 OFF
    await ev(pp, (id) => window.__engine.village.rebuild(id, { presetOverrides: { podiumRailing: false } }), palace.parcelId);
    await wait(pp, 600); await pp.screenshot({ path: join(OUT, 'focusv2-critic-woldae-off.png') }); console.log('saved woldae-off');
    // 월대난간 ON
    await ev(pp, (id) => window.__engine.village.rebuild(id, { presetOverrides: { podiumRailing: true } }), palace.parcelId);
    await wait(pp, 600); await pp.screenshot({ path: join(OUT, 'focusv2-critic-woldae-on.png') }); console.log('saved woldae-on');
    const bOff = await ev(pp, (id) => { window.__engine.village.rebuild(id, { presetOverrides: { podiumRailing: false } }); return window.__engine.village.debugOverlayBox(id); }, palace.parcelId);
    const bOn = await ev(pp, (id) => { window.__engine.village.rebuild(id, { presetOverrides: { podiumRailing: true } }); return window.__engine.village.debugOverlayBox(id); }, palace.parcelId);
    console.log('woldae box off/on:', JSON.stringify(bOff), JSON.stringify(bOn));
    // 공포 단수(bracketTiers) 1↔3 — 관아 특수건물 편집이 명확히 반영됨을 보이는 보조 컷(처마 밑 공포 변화).
    await ev(pp, (id) => window.__engine.village.rebuild(id, { presetOverrides: { bracketTiers: 1, podiumRailing: true } }), palace.parcelId);
    await wait(pp, 600); await pp.screenshot({ path: join(OUT, 'focusv2-critic-palace-bracket1.png') }); console.log('saved palace-bracket1');
    await ev(pp, (id) => window.__engine.village.rebuild(id, { presetOverrides: { bracketTiers: 3, podiumRailing: true } }), palace.parcelId);
    await wait(pp, 600); await pp.screenshot({ path: join(OUT, 'focusv2-critic-palace-bracket3.png') }); console.log('saved palace-bracket3');
  } else { console.log('WARN no palace hero parcel'); }
  await pp.close();
}

// ─────────────────── ⑤ 모바일 2컷(핀치 상당·바텀시트) ───────────────────
{
  const m = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  watch(m, 'mobile');
  await m.goto(`${base}/?seed=42&vseed=20260716&time=sunset&lang=ko`, { waitUntil: 'load' });
  await ready(m); await wait(m, 900);
  await m.click('.hero');
  await m.waitForFunction(() => { const c = window.__engine.village.debugContinuum(); return c.selected && !c.transitioning; }, null, { timeout: 12000 });
  await ev(m, () => window.__engine.village.return());
  await m.waitForFunction(() => { const c = window.__engine.village.debugContinuum(); return !c.selected && !c.transitioning; }, null, { timeout: 9000 });
  await wait(m, 700); await m.screenshot({ path: join(OUT, 'focusv2-mobile-aerial.png') }); console.log('saved mobile-aerial');
  const mp = await ev(m, () => window.__engine.village.debugParcels());
  const mg = mp.find((p) => !p.hero && p.editable) || mp[0];
  await ev(m, (id) => window.__engine.village.debugDolly(0.46, id), mg.parcelId);   // 핀치인 등가
  await m.waitForFunction(() => { const c = window.__engine.village.debugContinuum(); return c.selected && !c.transitioning; }, null, { timeout: 9000 });
  await wait(m, 900); await m.screenshot({ path: join(OUT, 'focusv2-mobile-focus.png') }); console.log('saved mobile-focus');
  await m.close();
}

// ─────────────────── ⑥ 회귀: shot·hero0·village1·4프리셋 ───────────────────
async function regress(url, name) {
  const p = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  watch(p, name);
  await p.goto(`${base}/${url}`, { waitUntil: 'load' });
  try { await ready(p); } catch { /* shot 은 __SHOT_READY 뜸 */ }
  await wait(p, 1200);
  await p.screenshot({ path: join(SCRATCH, `focusv2-${name}.png`) });
  console.log('saved regress', name);
  await p.close();
}
await regress('?shot=1&seed=42&time=sunset&lang=ko', 'reg-shot');
await regress('?hero=0&seed=42&time=sunset&lang=ko', 'reg-hero0');
await regress('?village=1&vseed=20260716&seed=42&time=day&lang=ko', 'reg-village1');
for (const pr of ['korea', 'temple', 'giwa', 'choga']) await regress(`?hero=0&preset=${pr}&seed=9&time=day&lang=ko`, `reg-preset-${pr}`);

console.log('\n=== ERRORS (' + errors.length + ') ===');
for (const e of errors) console.log(e);
await browser.close();
server.close();
console.log('DONE');
