// 헤드리스 검증: focus 중 필지→필지 직접 전환(#95) + 리롤 분리(#100) → shots/hop-*.png
// 사용법: NODE_PATH=/Users/hckim/repo/threesur/node_modules node tools/shoot-hop.mjs
//
// 빌드된 dist-hop 을 정적 서빙(포트 4213, 사용자 dev 5174 미접촉). window.__engine 훅으로 구동:
//   village.debugParcels()            : [{parcelId, kind, hero, heroStyle, family, editable}]
//   village.debugFocus(id)            : 부감→집 focus-in(돌리인)
//   village.switchTo(id)              : focus 중 A→B 직접 전환(부감 미경유) — #95
//   village.rerollParcel()            : 현재 focus 필지만 새 시드 재생성 — #100
//   village.replay()                  : 현재 focus 필지 같은 시드 재조립
//   village.rerollWave()              : 마을 전체 리롤 웨이브 — #56
//   village.getState()                : { selected, spec:{kind,seed,...}, seed, ... }
//   village.debugCamera()             : { y, targetY, dist, selected, transitioning } — 고도 계측
// 게이트: #95 ① A→B 4컷(전환 중 고도 부감 미상승) ② 브레드크럼 유형 변화 ③ 민가↔궁 ④ 재클릭 no-op
//   ⑤ 모바일 탭 / #100 ⑥ 집 리롤 before/after ⑦ 마을 웨이브 ⑧ 버튼 라벨 구분 / ⑨ 회귀·0 pageerror
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..');
const DIST = join(ROOT, 'app', 'dist-hop');
const OUT = join(ROOT, 'shots');
const SCRATCH = '/private/tmp/claude-501/-Users-hckim-repo-asiahouse/7a15478e-68e3-4ad3-b08a-bdb86ae4fe92/scratchpad/hop';
mkdirSync(OUT, { recursive: true });
mkdirSync(SCRATCH, { recursive: true });
const PORT = 4213;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.woff': 'font/woff', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };

const server = createServer(async (req, res) => {
  let path = decodeURIComponent(req.url.split('?')[0]);
  if (path === '/favicon.ico') { res.writeHead(204); res.end(); return; }
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
const ignorable = (t) => /favicon/i.test(t);
function watch(page, tag) {
  page.on('console', (m) => {
    if (m.type() === 'error' && !ignorable(m.text())) {
      errors.push(`[${tag}] ${m.text()}`);
      console.error(`[${tag} console]`, m.text());
    }
  });
  page.on('pageerror', (e) => {
    errors.push(`[${tag}] ${e.message}`);
    console.error(`[${tag} pageerror]`, e.message);
  });
  page.on('requestfailed', (req) => {
    const url = req.url();
    if (!ignorable(url)) {
      errors.push(`[${tag} reqfailed] ${url} - ${req.failure().errorText}`);
      console.error(`[${tag} requestfailed]`, url, req.failure().errorText);
    }
  });
}
const ev = (page, fn, ...a) => page.evaluate(fn, ...a);
const wait = (page, ms) => ev(page, (m) => new Promise((r) => setTimeout(r, m)), ms);
async function ready(page) { await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 40000 }); await wait(page, 500); }
async function shot(page, name) {
  const file = join(OUT, `hop-${name}.png`);
  await page.screenshot({ path: file });
  console.log('saved', file);
}
async function scratch(page, name) { await page.screenshot({ path: join(SCRATCH, `${name}.png`) }); }
const state = (page) => ev(page, () => window.__engine.village.getState());
const cam = (page) => ev(page, () => window.__engine.village.debugCamera());
// 전환/조립 종료까지 대기(transitioning=false). 타임아웃 방어.
async function settle(page, budgetMs = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < budgetMs) {
    const c = await cam(page);
    if (!c.transitioning) return c;
    await wait(page, 120);
  }
  return cam(page);
}

const RESULTS = [];
const ok = (cond, msg) => { RESULTS.push((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) console.error('FAIL', msg); else console.log('PASS', msg); };

// ───────────────────────── 데스크톱 게이트 ─────────────────────────
const desk = await browser.newPage({ viewport: { width: 1280, height: 800, deviceScaleFactor: 2 } });
watch(desk, 'desk');
await desk.goto(`${base}/index.html?village=1&seed=20260718&vseed=7&time=day`, { waitUntil: 'load' });
await ready(desk);

const parcels = await ev(desk, () => window.__engine.village.debugParcels());
console.log('PARCELS n=%d', parcels.length);
const regGiwa = parcels.find((p) => p.family === 'regular' && p.kind === 'giwa' && p.editable);
const regChoga = parcels.find((p) => p.family === 'regular' && p.kind !== 'giwa' && p.editable);
const hero = parcels.find((p) => p.hero);
const palace = parcels.find((p) => p.parcelId === 'palace');
console.log('PICK giwa=%s choga=%s hero=%s palace=%s', regGiwa?.parcelId, regChoga?.parcelId, hero?.parcelId, palace?.parcelId);

// 부감 기준 고도(전환 중 이 값 근처로 안 올라감을 증명).
const aerialCam = await cam(desk);
console.log('AERIAL cam', JSON.stringify(aerialCam));

// ── 게이트 ① + ② : A(giwa) focus → B(choga) 직접 전환 4컷 + 유형 변화 ──
const A = regGiwa || regChoga;
const B = (A === regGiwa ? regChoga : regGiwa) || parcels.find((p) => p.family === 'regular' && p.editable && p.parcelId !== A.parcelId);
await ev(desk, (id) => window.__engine.village.debugFocus(id), A.parcelId);
await settle(desk);
await wait(desk, 400);
const camA = await cam(desk); const stA = await state(desk);
await shot(desk, '95-1-a-focus');
console.log('A focus cam', JSON.stringify(camA), 'kind', stA.spec?.kind || stA.spec?.family);

// switchTo(B) → 전환 중 2컷(고도 계측) → 도착.
await ev(desk, (id) => window.__engine.village.switchTo(id), B.parcelId);
await wait(desk, 450);
const camMid1 = await cam(desk); await shot(desk, '95-2-transition-early');
await wait(desk, 550);
const camMid2 = await cam(desk); await shot(desk, '95-3-transition-mid');
console.log('transition early', JSON.stringify(camMid1), 'mid', JSON.stringify(camMid2));
await settle(desk);
await wait(desk, 400);
const camB = await cam(desk); const stB = await state(desk);
await shot(desk, '95-4-b-focus');
console.log('B focus cam', JSON.stringify(camB), 'kind', stB.spec?.kind || stB.spec?.family);

// 전환 중 두 컷에서 카메라 고도가 부감으로 안 올라감(근접권 유지). aerialCam.y 대비 크게 낮음.
const midMaxY = Math.max(camMid1.y, camMid2.y);
ok(camMid1.transitioning || camMid2.transitioning, '#95① 전환 중 transitioning=true 관측');
ok(midMaxY < aerialCam.y * 0.72, `#95① 전환 중 고도 부감 미상승 (mid maxY=${midMaxY} < aerial ${aerialCam.y}×0.72=${(aerialCam.y * 0.72).toFixed(1)})`);
ok(stB.selected === B.parcelId, `#95① 전환 후 focus=B (${stB.selected})`);
ok((stA.spec?.kind || stA.spec?.family) !== (stB.spec?.kind || stB.spec?.family), `#95② 브레드크럼 유형 변화 (${stA.spec?.kind}→${stB.spec?.kind})`);

// ── 게이트 ③ : 민가 → 궁 → 민가 ──
if (palace) {
  await ev(desk, (id) => window.__engine.village.switchTo(id), palace.parcelId);
  await settle(desk, 9000); await wait(desk, 400);
  const stP = await state(desk); const camP = await cam(desk);
  await shot(desk, '95-5-house-to-palace');
  ok(stP.selected === 'palace', `#95③ 민가→궁 전환 (focus=${stP.selected})`);
  ok(camP.y < aerialCam.y * 0.85, `#95③ 궁 도착 고도 근접권 (${camP.y} < ${(aerialCam.y * 0.85).toFixed(1)})`);
  // 궁 → 민가
  await ev(desk, (id) => window.__engine.village.switchTo(id), A.parcelId);
  await settle(desk, 9000); await wait(desk, 400);
  const stH = await state(desk);
  await shot(desk, '95-6-palace-to-house');
  ok(stH.selected === A.parcelId, `#95③ 궁→민가 전환 (focus=${stH.selected})`);
} else {
  console.log('SKIP palace gate (no palace in this village) — hero 로 대체');
  if (hero) {
    await ev(desk, (id) => window.__engine.village.switchTo(id), hero.parcelId);
    await settle(desk, 9000); await wait(desk, 400);
    const stP = await state(desk);
    await shot(desk, '95-5-house-to-hero');
    ok(stP.selected === hero.parcelId, `#95③ 민가→종가 전환 (focus=${stP.selected})`);
    await ev(desk, (id) => window.__engine.village.switchTo(id), A.parcelId);
    await settle(desk, 9000); await wait(desk, 400);
    const stH = await state(desk);
    await shot(desk, '95-6-hero-to-house');
    ok(stH.selected === A.parcelId, `#95③ 종가→민가 전환 (focus=${stH.selected})`);
  }
}

// ── 게이트 ④ : 재클릭 no-op (현 focus 필지 자신 switchTo → 상태 불변) ──
const stCur = await state(desk);
await ev(desk, (id) => window.__engine.village.switchTo(id), stCur.selected);
await wait(desk, 400);
const stRe = await state(desk); const camRe = await cam(desk);
await shot(desk, '95-7-reclick-noop');
ok(stRe.selected === stCur.selected && !camRe.transitioning, `#95④ 재클릭 no-op (focus 불변=${stRe.selected}, transitioning=${camRe.transitioning})`);

// ── 게이트 ⑧ : 집 패널 버튼 라벨 구분 (다시 보기 / 이 집 다시 짓기) ──
const houseBtns = await ev(desk, () => Array.from(document.querySelectorAll('.house-actions .hbtn')).map((b) => b.textContent.trim()));
console.log('HOUSE BTN LABELS', JSON.stringify(houseBtns));
await shot(desk, '100-8-house-labels');
ok(houseBtns.length === 2 && houseBtns.some((s) => s.includes('다시 보기')) && houseBtns.some((s) => s.includes('이 집 다시 짓기')),
  `#100⑧ 집 패널 라벨 구분 (${JSON.stringify(houseBtns)})`);

// ── 게이트 ⑥ : 집 리롤 before/after (그 집만 변경, 마을 시드 불변) ──
// A 로 다시 focus(재클릭 no-op 뒤 현 focus 가 A 라고 보장 못하므로 명시 전환).
if (stRe.selected !== A.parcelId) { await ev(desk, (id) => window.__engine.village.switchTo(id), A.parcelId); await settle(desk, 9000); await wait(desk, 300); }
const beforeReroll = await state(desk);
const villSeedBefore = beforeReroll.seed;
await shot(desk, '100-6-reroll-before');
await ev(desk, () => window.__engine.village.rerollParcel());
await settle(desk, 9000); await wait(desk, 500);
const afterReroll = await state(desk);
await shot(desk, '100-6-reroll-after');
console.log('REROLL seed', beforeReroll.spec?.seed, '→', afterReroll.spec?.seed, 'villageSeed', villSeedBefore, '→', afterReroll.seed);
ok(beforeReroll.spec?.seed !== afterReroll.spec?.seed, `#100⑥ 집 시드 변경 (${beforeReroll.spec?.seed}→${afterReroll.spec?.seed})`);
ok(villSeedBefore === afterReroll.seed, `#100⑥ 마을 시드 불변 (${villSeedBefore}=${afterReroll.seed}) → 이웃·마을 그대로`);
ok(afterReroll.selected === A.parcelId, `#100⑥ 리롤 후 같은 필지 focus 유지 (${afterReroll.selected})`);

// ── 게이트 ⑦ : 마을 웨이브(부감 복귀 후) ──
await ev(desk, () => window.__engine.village.return());
await settle(desk, 6000); await wait(desk, 400);
await shot(desk, '100-7-aerial-before-wave');
const beforeWave = await state(desk);
await ev(desk, () => window.__engine.village.rerollWave());
// 웨이브 완료 대기(isWaving=false).
{ const t0 = Date.now(); while (Date.now() - t0 < 12000) { const w = await ev(desk, () => window.__engine.village.getState()); if (!(await ev(desk, () => window.__engine.village.isWaving()))) break; await wait(desk, 200); void w; } }
await wait(desk, 600);
const afterWave = await state(desk);
await shot(desk, '100-7-wave-after');
console.log('WAVE villageSeed', beforeWave.seed, '→', afterWave.seed);
ok(beforeWave.seed !== afterWave.seed, `#100⑦ 마을 웨이브 → 마을 시드 변경 (${beforeWave.seed}→${afterWave.seed})`);

// 아직 aerial? 웨이브 후 부감 → 아무 필지 focus 재개 정상성.
const parcels2 = await ev(desk, () => window.__engine.village.debugParcels());
const reg2 = parcels2.find((p) => p.family === 'regular' && p.editable);
if (reg2) { await ev(desk, (id) => window.__engine.village.debugFocus(id), reg2.parcelId); await settle(desk, 9000); await wait(desk, 300); await shot(desk, '100-7b-refocus-after-wave'); const s = await state(desk); ok(s.selected === reg2.parcelId, `#100⑦ 웨이브 후 focus 재개 정상 (${s.selected})`); }

// ── 게이트 ⑨ : 회귀 — 정규 편집(라이브 슬라이더) + 줌 연속체 ──
// 정규 편집: 슬라이더 드래그 시뮬(값 변경). (현 focus reg2)
try {
  const range = await desk.$('.ctx.house input[type="range"]');
  if (range) { await range.focus(); for (let i = 0; i < 6; i++) { await desk.keyboard.press('ArrowRight'); await wait(desk, 60); } await wait(desk, 400); await shot(desk, '100-9-live-edit'); }
} catch (e) { console.error('live-edit err', e.message); }
// 줌 연속체: 부감 복귀 → 줌인 임계로 자동 focus-in.
await ev(desk, () => window.__engine.village.return()); await settle(desk, 6000);
await ev(desk, (id) => window.__engine.village.debugDolly(0.45, id), reg2 ? reg2.parcelId : A.parcelId);
await wait(desk, 2600);
const zc = await ev(desk, () => window.__engine.village.debugContinuum());
console.log('ZOOM CONTINUUM', JSON.stringify(zc));
await shot(desk, '100-9-zoom-continuum');
ok(true, '#⑨ 줌 연속체 구동(무크래시)');

// ───────────────────────── 모바일 게이트 ⑤ ─────────────────────────
const mob = await browser.newPage({ viewport: { width: 390, height: 844, deviceScaleFactor: 3 }, isMobile: true, hasTouch: true });
watch(mob, 'mob');
await mob.goto(`${base}/index.html?village=1&seed=20260718&vseed=7&time=day`, { waitUntil: 'load' });
await ready(mob);
const mparcels = await ev(mob, () => window.__engine.village.debugParcels());
const mA = mparcels.find((p) => p.family === 'regular' && p.editable);
const mB = mparcels.find((p) => p.family === 'regular' && p.editable && p.parcelId !== mA.parcelId);
await ev(mob, (id) => window.__engine.village.debugFocus(id), mA.parcelId);
await settle(mob, 9000); await wait(mob, 400);
await shot(mob, '95-mobile-a');
await ev(mob, (id) => window.__engine.village.switchTo(id), mB.parcelId);
await settle(mob, 9000); await wait(mob, 400);
const mSt = await state(mob);
await shot(mob, '95-mobile-b-switch');
ok(mSt.selected === mB.parcelId, `#95⑤ 모바일 탭 직접 전환 (focus=${mSt.selected})`);

// ───────────────────────── 궁 전용 게이트 ③ (capital+palace) ─────────────────────────
const pal = await browser.newPage({ viewport: { width: 1280, height: 800, deviceScaleFactor: 2 } });
watch(pal, 'pal');
await pal.goto(`${base}/index.html?village=1&vscale=capital&vpalace=1&seed=20260718&vseed=3&time=day`, { waitUntil: 'load' });
await ready(pal);
const pparcels = await ev(pal, () => window.__engine.village.debugParcels());
const pPalace = pparcels.find((p) => p.parcelId === 'palace');
const pHouse = pparcels.find((p) => p.family === 'regular' && p.editable);
console.log('CAPITAL parcels n=%d palace=%s house=%s', pparcels.length, !!pPalace, pHouse?.parcelId);
if (pPalace && pHouse) {
  const palAerialY = (await cam(pal)).y;
  await ev(pal, (id) => window.__engine.village.debugFocus(id), pHouse.parcelId);
  await settle(pal, 10000); await wait(pal, 400);
  await ev(pal, (id) => window.__engine.village.switchTo(id), 'palace');
  await wait(pal, 500); const pmid = await cam(pal);
  await settle(pal, 10000); await wait(pal, 400);
  const pSt = await state(pal); const pCam = await cam(pal);
  await shot(pal, '95-palace-house-to-palace');
  ok(pSt.selected === 'palace', `#95③ (capital) 민가→궁 직접 전환 (focus=${pSt.selected})`);
  ok(pmid.y < palAerialY * 0.85 && pCam.y < palAerialY * 0.9, `#95③ (capital) 궁 전환 고도 근접권 (mid=${pmid.y}, arr=${pCam.y} < aerial ${palAerialY})`);
  await ev(pal, (id) => window.__engine.village.switchTo(id), pHouse.parcelId);
  await settle(pal, 10000); await wait(pal, 400);
  const pSt2 = await state(pal);
  await shot(pal, '95-palace-palace-to-house');
  ok(pSt2.selected === pHouse.parcelId, `#95③ (capital) 궁→민가 직접 전환 (focus=${pSt2.selected})`);
  // 궁 리롤(#100) — 궁만 재굴림, 마을 시드 불변.
  await ev(pal, (id) => window.__engine.village.switchTo(id), 'palace');
  await settle(pal, 10000); await wait(pal, 400);
  const palBefore = await state(pal);
  await ev(pal, () => window.__engine.village.rerollParcel());
  await settle(pal, 11000); await wait(pal, 500);
  const palAfter = await state(pal);
  ok(palBefore.seed === palAfter.seed && palAfter.selected === 'palace', `#100 (capital) 궁 리롤 후 마을 시드 불변·궁 focus 유지 (${palBefore.seed}=${palAfter.seed})`);
} else {
  console.log('WARN capital village produced no palace — 궁 게이트 미검증(hero 대체본으로 커버)');
}

// ── 부팅 회귀(기본 히어로 랜딩) — 0 pageerror ──
const boot = await browser.newPage({ viewport: { width: 1280, height: 800, deviceScaleFactor: 2 } });
watch(boot, 'boot');
await boot.goto(`${base}/index.html`, { waitUntil: 'load' });
await ready(boot);
await wait(boot, 1200);
await shot(boot, '9-boot');

// ───────────────────────── 요약 ─────────────────────────
console.log('\n===== HOP GATE RESULTS =====');
for (const r of RESULTS) console.log(r);
console.log('pageerrors:', errors.length);
for (const e of errors) console.log('  ', e);
const failed = RESULTS.filter((r) => r.startsWith('FAIL')).length;
console.log(`\n${failed === 0 && errors.length === 0 ? 'ALL GREEN' : `${failed} FAIL / ${errors.length} ERR`}`);

await browser.close();
server.close();
process.exit(failed === 0 && errors.length === 0 ? 0 : 1);
