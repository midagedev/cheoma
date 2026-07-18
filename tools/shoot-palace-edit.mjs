// #93 궁궐 다일곽 편집 승격 게이트 — 빌트 앱(app/dist-palace-edit)을 실제 구동해 촬영.
// 실행: node tools/shoot-palace-edit.mjs   (playwright 는 threesur node_modules 에서 createRequire 로 로드)
//   포트 4208 고정(사용자 dev 5174 불침해). 게이트 컷 shots/palaceedit-*, 중간 컷 스크래치.
// 게이트: ① 궁 focus-in 2컷(부감→궁역 근접, 브레드크럼 '궁궐') ② 편집 대비 2쌍(공포단수·지붕물매 — 지오+패널숫자 동기)
//   ③ 드로우콜(편집 전/후/재생성) ④ 정규 필지 편집 무회귀 1컷 ⑤ 모바일 1컷
// 코어(populate palaceCore 미병합 + palace.js presetOverrides) 미반영 빌드에선 궁 편집 불가 →
//   focus·프레이밍·드로우콜·정규·모바일만 검증하고 편집 게이트는 SKIP(AWAIT-CORE) 로깅.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { createRequire } from 'node:module';
const { chromium } = createRequire('/Users/hckim/repo/threesur/node_modules/')('playwright');

const ROOT = '/Users/hckim/repo/asiahouse';
const DIST = join(ROOT, 'app', 'dist-palace-edit');
const OUT = join(ROOT, 'shots');
const SCRATCH = '/private/tmp/claude-501/-Users-hckim-repo-asiahouse/7a15478e-68e3-4ad3-b08a-bdb86ae4fe92/scratchpad/palace-edit';
mkdirSync(OUT, { recursive: true });
mkdirSync(SCRATCH, { recursive: true });
const PORT = 4208;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.woff': 'font/woff', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
const server = createServer(async (req, res) => {
  let path = decodeURIComponent(req.url.split('?')[0]);
  if (path === '/') path = '/index.html';
  try { const data = await readFile(join(DIST, path)); res.writeHead(200, { 'content-type': MIME[extname(path)] || 'application/octet-stream' }); res.end(data); }
  catch { res.writeHead(404); res.end('not found'); }
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
async function shot(page, name, gate = false) { const file = join(gate ? OUT : SCRATCH, `palaceedit-${name}.png`); await page.screenshot({ path: file }); console.log('saved', file); }
async function ready(page) { await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 40000 }); await wait(page, 500); }
const cont = (page) => ev(page, () => window.__engine.village.debugContinuum());
async function waitFocused(page, t = 12000) { await page.waitForFunction(() => { const c = window.__engine.village.debugContinuum(); return c.selected && !c.transitioning; }, null, { timeout: t }); }
async function waitAerial(page, t = 12000) { await page.waitForFunction(() => { const c = window.__engine.village.debugContinuum(); return !c.selected && !c.transitioning; }, null, { timeout: t }); }
const crumb = (page) => ev(page, () => document.querySelector('.crumb.leaf')?.textContent?.trim() || '');
const dc = (page) => ev(page, () => window.__engine.village.debugDrawCalls?.() ?? null);
const box = (page, id) => ev(page, (id) => window.__engine.village.debugOverlayBox?.(id) ?? null, id);

// ─────────────────── 부팅: capital + 궁 ───────────────────
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
watch(page, 'desk');
await page.goto(`${base}/?village=1&vscale=capital&vpalace=1&vseed=20260716&seed=42&time=day&lang=ko`, { waitUntil: 'load' });
await ready(page);
await wait(page, 1400);
await waitAerial(page);

const parcels = await ev(page, () => window.__engine.village.debugParcels());
const palace = parcels.find((p) => p.parcelId === 'palace');
console.log('palace proxy:', JSON.stringify(palace));
console.log('total parcels:', parcels.length, ' aerial continuum:', JSON.stringify(await cont(page)));
const palaceEditable = !!(palace && palace.editable);
console.log(palaceEditable ? '=== PALACE EDITABLE (core landed) ===' : '=== PALACE FOCUS-ONLY (AWAIT-CORE: populate palaceCore + palace.js presetOverrides) ===');

// ─────────────────── ① 궁 focus-in 2컷 ───────────────────
await shot(page, '01-aerial', true);   // 부감(마을 › ...)
const dcAerial = await dc(page);
if (palace) {
  await ev(page, () => window.__engine.village.focus('palace'));
  await wait(page, 900); await shot(page, '02-dolly', true);   // 돌리 중
  await waitFocused(page); await wait(page, 700);
  await shot(page, '03-closeup', true);   // 궁역 근접
  console.log('focus continuum:', JSON.stringify(await cont(page)), ' breadcrumb leaf =', JSON.stringify(await crumb(page)));
} else {
  console.log('WARN: no palace proxy — features.palace 미생성? URL/scale 확인');
}
const dcFocus = await dc(page);

// ─────────────────── ② 편집 대비 2쌍 (편집 가능 시) ───────────────────
let dcEdit = null;
const editPairs = {};
if (palaceEditable) {
  // 패널 stepper(bracketTiers) 로 공포 단수 1 → 3. 지오(overlayBox)·패널 .num 동기 확인.
  async function setStepperTo(target) {
    // .row.bays 중 bracketTiers 스텝퍼(라벨 's_bracketTiers'). 여러 개면 첫번째.
    for (let i = 0; i < 6; i++) {
      const cur = await ev(page, () => { const n = document.querySelector('.row.bays .num'); return n ? parseInt(n.textContent, 10) : null; });
      if (cur == null || cur === target) break;
      await ev(page, (dir) => { const b = document.querySelectorAll('.row.bays .stepper button'); b[dir > 0 ? 1 : 0].click(); }, target - cur > 0 ? 1 : -1);
      await wait(page, 300);
    }
    return ev(page, () => { const n = document.querySelector('.row.bays .num'); return n ? n.textContent.trim() : null; });
  }
  async function setSlider(key, value) {
    return ev(page, ({ key, value }) => {
      const el = document.querySelector(`input[data-key="${key}"]`);
      if (!el) return false;
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      set.call(el, String(value)); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }, { key, value });
  }
  const readRV = (key) => ev(page, (key) => { const el = document.querySelector(`input[data-key="${key}"]`); return el ? { v: el.value, rv: el.closest('.row')?.querySelector('.rv')?.textContent?.trim() } : null; }, key);

  // 공포 단수 1
  const n1 = await setStepperTo(1); const box1 = await box(page, 'palace');
  await shot(page, '04-bracket1', true);
  // 공포 단수 3
  const n3 = await setStepperTo(3); const box3 = await box(page, 'palace');
  await shot(page, '05-bracket3', true);
  dcEdit = await dc(page);
  editPairs.bracket = { panel1: n1, panel3: n3, box1, box3 };
  console.log('bracketTiers panel/geo:', JSON.stringify(editPairs.bracket));

  // 지붕 물매 낮음 → 높음
  await setSlider('roofPitch', 0.62); await wait(page, 400); const rpLow = await readRV('roofPitch'); const boxLow = await box(page, 'palace');
  await shot(page, '06-pitch-low', true);
  await setSlider('roofPitch', 0.98); await wait(page, 400); const rpHigh = await readRV('roofPitch'); const boxHigh = await box(page, 'palace');
  await shot(page, '07-pitch-high', true);
  editPairs.pitch = { rpLow, rpHigh, boxLow, boxHigh };
  console.log('roofPitch panel/geo:', JSON.stringify(editPairs.pitch));

  // ── 리플레이(再) 후 패널 값 유지(desync 수정 확인) ──
  await ev(page, () => window.__engine.village.replay());
  await waitFocused(page); await wait(page, 600);
  const afterReplay = await readRV('roofPitch');
  await shot(page, '08-replay', true);
  console.log('after replay roofPitch panel (desync fix, 0.98 유지 기대):', JSON.stringify(afterReplay));
} else {
  console.log('SKIP ② 편집 게이트 — 코어 미반영. 궁 focus/프레이밍/드로우콜/정규/모바일만 검증.');
}

// ─────────────────── ③ 드로우콜 표 ───────────────────
console.log('=== DRAW CALLS ===', JSON.stringify({ aerial: dcAerial, focus: dcFocus, edit: dcEdit }));

// focus-out 복귀
await ev(page, () => window.__engine.village.return());
await waitAerial(page); await wait(page, 500);
await shot(page, '09-return-aerial', true);

// ─────────────────── ④ 정규 필지 편집 무회귀 ───────────────────
{
  const rp = parcels.find((p) => !p.hero && p.parcelId !== 'palace' && p.editable && p.kind === 'giwa')
    || parcels.find((p) => !p.hero && p.parcelId !== 'palace' && p.editable);
  if (rp) {
    await ev(page, (id) => window.__engine.village.focus(id), rp.parcelId);
    await waitFocused(page); await wait(page, 500);
    const b0 = await box(page, rp.parcelId);
    await ev(page, () => { const el = document.querySelector('input[data-key="riseScale"]') || document.querySelector('input[data-key="roofPitch"]'); if (el) { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, el.getAttribute('max')); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); } });
    await wait(page, 500);
    const b1 = await box(page, rp.parcelId);
    await shot(page, '10-regular-edit', true);
    console.log('regular parcel edit box before/after (지오 변화 = 무회귀):', rp.parcelId, JSON.stringify(b0), JSON.stringify(b1));
    await ev(page, () => window.__engine.village.return());
    await waitAerial(page);
  } else { console.log('WARN no editable regular parcel'); }
}

// ─────────────────── ⑤ 모바일 1컷(궁 편집 시트 half) ───────────────────
{
  const m = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  watch(m, 'mobile');
  await m.goto(`${base}/?village=1&vscale=capital&vpalace=1&vseed=20260716&seed=42&time=day&lang=ko`, { waitUntil: 'load' });
  await ready(m); await wait(m, 1400);
  await m.waitForFunction(() => { const c = window.__engine.village.debugContinuum(); return !c.selected && !c.transitioning; }, null, { timeout: 12000 });
  await ev(m, () => window.__engine.village.focus('palace'));
  await m.waitForFunction(() => { const c = window.__engine.village.debugContinuum(); return c.selected && !c.transitioning; }, null, { timeout: 12000 });
  await wait(m, 900);
  await m.screenshot({ path: join(OUT, 'palaceedit-11-mobile.png') }); console.log('saved mobile');
  await m.close();
}

// ─────────────────── 회귀: 부팅·shot ───────────────────
async function regress(url, name) {
  const p = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  watch(p, name);
  await p.goto(`${base}/${url}`, { waitUntil: 'load' });
  try { await ready(p); } catch { /* shot */ }
  await wait(p, 1200);
  await p.screenshot({ path: join(SCRATCH, `palaceedit-${name}.png`) });
  console.log('saved regress', name);
  await p.close();
}
await regress('?shot=1&seed=42&time=sunset&lang=ko', 'reg-shot');
await regress('?village=1&vscale=hanyang&vseed=20260716&seed=42&time=day&lang=ko', 'reg-hanyang');

console.log('\n=== ERRORS (' + errors.length + ') ===');
for (const e of errors) console.log(e);
await browser.close();
server.close();
console.log('DONE');
