// 헤드리스 검증: focus-in 상세 편집 패널(#48) + 라이브 반영(#69) → shots/editpanel-*.png
// 사용법: node tools/shoot-editpanel.mjs
//
// 빌드된 dist-editpanel 을 정적 서빙(포트 4203, 사용자 dev 5174 미접촉). window.__engine 훅으로 구동:
//   village.debugParcels()  : [{parcelId, kind, hero, heroStyle, family, editable}]
//   village.debugFocus(id)  : 좌표 클릭 없이 필지 focus-in(돌리인+패널)
//   village.getState()      : { selected, spec, ... }
// 게이트: ① 정규 패널(choga/giwa, 기본+고급, 데스크톱+모바일) ② 종가 컴파운드 ③ 관아 편집 before/after
//   ④ 라이브 반영 연속 프레임 + 프레임갭 ⑤ 담장 어휘 before/after ⑥ 회귀(진입·리플레이·shot·4프리셋)
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..');
const DIST = join(ROOT, 'app', 'dist-editpanel');
const OUT = join(ROOT, 'shots');
const SCRATCH = '/private/tmp/claude-501/-Users-hckim-repo-asiahouse/7a15478e-68e3-4ad3-b08a-bdb86ae4fe92/scratchpad';
mkdirSync(OUT, { recursive: true });
mkdirSync(SCRATCH, { recursive: true });
const PORT = 4203;
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
  page.on('console', (m) => { if (m.type() === 'error') { errors.push(`[${tag}] ${m.text()}`); console.error(`[${tag} console]`, m.text()); } });
  page.on('pageerror', (e) => { errors.push(`[${tag}] ${e.message}`); console.error(`[${tag} pageerror]`, e.message); });
}
const ev = (page, fn, ...a) => page.evaluate(fn, ...a);
async function ready(page) { await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 40000 }); await ev(page, () => new Promise((r) => setTimeout(r, 400))); }
async function shot(page, name, toShots = false) {
  const file = join(toShots ? OUT : SCRATCH, `editpanel-${name}.png`);
  await page.screenshot({ path: file });
  console.log('saved', file);
}

// 마을 부감 진입 후 필지 focus-in → 패널 오픈까지 대기(돌리인 2.3s).
async function focusParcel(page, id, panelSel = '.panel.open') {
  await ev(page, (pid) => window.__engine.village.debugFocus(pid), id);
  await page.waitForSelector(panelSel, { timeout: 12000 });
  await ev(page, () => new Promise((r) => setTimeout(r, 500)));   // 슬라이드 인 정착
}
async function expandAdvanced(page, scope = '.panel') {
  const btn = await page.$(`${scope} .advtoggle`);
  if (!btn) return;
  if ((await btn.getAttribute('aria-expanded')) === 'true') return;   // 이미 펼침 — 재클릭(접힘) 방지
  await btn.click(); await ev(page, () => new Promise((r) => setTimeout(r, 260)));
}
const box = (page, id) => ev(page, (i) => window.__engine.village.debugOverlayBox(i), id);

// ───────────────────────── 데스크톱 게이트 ─────────────────────────
const desk = await browser.newPage({ viewport: { width: 1280, height: 800, deviceScaleFactor: 2 } });
watch(desk, 'desk');

// 부감 진입(village 규모) — 종가(hanok) 히어로 + 정규 필지.
await desk.goto(`${base}/index.html?village=1&seed=20260718&vseed=7&time=day`, { waitUntil: 'load' });
await ready(desk);
let parcels = await ev(desk, () => window.__engine.village.debugParcels());
console.log('PARCELS(village) n=%d hero=%s', parcels.length, JSON.stringify(parcels.filter((p) => p.hero)));
const choga = parcels.find((p) => p.family === 'regular' && p.kind !== 'giwa' && p.editable);
const giwa = parcels.find((p) => p.family === 'regular' && p.kind === 'giwa' && p.editable);
const hanok = parcels.find((p) => p.hero && p.heroStyle === 'hanok');
console.log('PICK choga=%s giwa=%s hanok=%s', choga?.parcelId, giwa?.parcelId, hanok?.parcelId);

// 부감 마을 옵션 패널(규모 슬라이더 단일 컨트롤·character 미노출·궁/절 토글) + setSeason(focusRing.setSeason 배선) 무에러
await shot(desk, 'aerial-panel', true);
const aerialHasSlider = await ev(desk, () => !!document.querySelector('.vcard input.scale'));
const aerialHasChar = await ev(desk, () => [...document.querySelectorAll('.vcard .opt, .vcard h4')].some((n) => /성격|character|민촌|여염|반촌/i.test(n.textContent || '')));
console.log('AERIAL scaleSlider=%s characterExposed=%s (기대 true/false)', aerialHasSlider, aerialHasChar);
await ev(desk, () => window.__engine.setSeason('autumn'));
await ev(desk, () => new Promise((r) => setTimeout(r, 400)));
await ev(desk, () => window.__engine.setSeason('summer'));

// ① 정규 필지(초가) — 기본 + 고급 펼침
await focusParcel(desk, choga.parcelId);
await shot(desk, 'regular-choga-basic', true);
await expandAdvanced(desk);
await shot(desk, 'regular-choga-advanced', true);
let specChoga = await ev(desk, () => window.__engine.village.getState().spec);
console.log('SPEC choga family=%s kind=%s params=%s', specChoga.family, specChoga.kind, JSON.stringify(specChoga.params));

// ⑤ 담장 어휘 before/after (초가 → 싸리울) — 편집 패널 wallType segment
await shot(desk, 'wall-before', true);
await ev(desk, () => {
  const btns = [...document.querySelectorAll('.seg .segbtn')];
  const b = btns.find((x) => x.textContent.trim() === '싸리울' || x.textContent.trim() === 'Brush');
  if (b) b.click();
});
await ev(desk, () => new Promise((r) => setTimeout(r, 400)));
await shot(desk, 'wall-after', true);
const wallAfter = await ev(desk, () => window.__engine.village.getState().spec.params.wallType);
console.log('WALL after=%s (brush 기대)', wallAfter);

// ④ 라이브 반영 — footprintScale 드래그 연속 프레임 + 프레임갭(정규=드래그 즉시 변형)
await ev(desk, () => window.__engine.village.return());
await ev(desk, () => new Promise((r) => setTimeout(r, 2400)));   // 부감 복귀
await focusParcel(desk, choga.parcelId);
await expandAdvanced(desk);
// 라이브 드래그 연속 3컷(input 만, change 미발생 = 드래그 중) — footprintScale 로 집이 커지는 변형 진행.
const sel = '.panel input[data-key="footprintScale"]';
let hasSlider = await desk.$(sel);
if (!hasSlider) { await expandAdvanced(desk); hasSlider = await desk.$(sel); }
if (hasSlider) {
  for (const v of [0.75, 1.05, 1.38]) {
    await ev(desk, ({ s, val }) => {
      const el = document.querySelector(s); el.value = String(val);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, { s: sel, val: v });
    await ev(desk, () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await ev(desk, () => new Promise((r) => setTimeout(r, 140)));
    console.log('LIVE box@%s = %s', v, JSON.stringify(await box(desk, choga.parcelId)));
    await shot(desk, `live-${String(v).replace('.', '')}`, true);
  }
  // 프레임갭 측정: 매 프레임 input 발생(실경로 villageLive→rAF 병합 rebuild) 하며 rAF 델타 수집.
  const gap = await ev(desk, (s) => new Promise((resolve) => {
    const el = document.querySelector(s); const from = 0.7, to = 1.4, ms = 1400;
    const gaps = []; let last = performance.now(); const t0 = last;
    function frame(now) {
      gaps.push(now - last); last = now;
      const k = Math.min(1, (now - t0) / ms);
      el.value = String(from + (to - from) * k);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      if (k < 1) requestAnimationFrame(frame);
      else { el.dispatchEvent(new Event('change', { bubbles: true })); gaps.shift(); gaps.sort((a, b) => a - b);
        resolve({ frames: gaps.length, med: +gaps[gaps.length >> 1].toFixed(1), p90: +gaps[Math.floor(gaps.length * 0.9)].toFixed(1), max: +gaps[gaps.length - 1].toFixed(1), avg: +(gaps.reduce((a, b) => a + b, 0) / gaps.length).toFixed(1) }); }
    }
    requestAnimationFrame(frame);
  }), sel);
  console.log('LIVE-FRAMEGAP(choga footprintScale) %s ms — med/p90/max/avg', JSON.stringify(gap));
  // 직접 rebuild 1회 비용(어댑터 재생성 순수 시간)
  const cost = await ev(desk, (id) => {
    const runs = []; for (let i = 0; i < 6; i++) { const t = performance.now(); window.__engine.village.rebuild(id, { kind: 'choga', building: { columnHeight: 2.2 + i * 0.05 }, footprintScale: 1.0 + i * 0.03 }); runs.push(performance.now() - t); }
    runs.sort((a, b) => a - b); return +runs[runs.length >> 1].toFixed(1);
  }, choga.parcelId);
  console.log('REBUILD-COST(choga) median=%s ms', cost);
} else console.error('LIVE: footprintScale 슬라이더 없음');

// ① 정규 필지(기와) — 다른 스키마(풋프린트·창살)
await ev(desk, () => window.__engine.village.return());
await ev(desk, () => new Promise((r) => setTimeout(r, 2400)));
if (giwa) {
  await focusParcel(desk, giwa.parcelId);
  await shot(desk, 'regular-giwa-basic', true);
  await expandAdvanced(desk);
  await shot(desk, 'regular-giwa-advanced', true);
  const sg = await ev(desk, () => window.__engine.village.getState().spec);
  console.log('SPEC giwa family=%s params=%s', sg.family, JSON.stringify(sg.params));
}

// ② 종가(hanok 컴파운드) 편집 패널
await ev(desk, () => window.__engine.village.return());
await ev(desk, () => new Promise((r) => setTimeout(r, 2400)));
if (hanok) {
  await focusParcel(desk, hanok.parcelId);
  const sh = await ev(desk, () => window.__engine.village.getState().spec);
  console.log('SPEC hanok family=%s heroStyle=%s editable=%s params=%s', sh.family, sh.heroStyle, sh.editable, JSON.stringify(sh.params));
  await shot(desk, 'hero-hanok', true);
  // 종가 지붕 물매 편집 before/after(놓을 때 정착 — commit)
  await shot(desk, 'hero-hanok-before', true);
  const hb0 = await box(desk, hanok.parcelId);
  await ev(desk, () => {
    const el = document.querySelector('.panel input[data-key="riseScale"]');
    if (el) { el.value = '1.75'; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }
  });
  await ev(desk, () => new Promise((r) => setTimeout(r, 800)));
  const hb1 = await box(desk, hanok.parcelId);
  console.log('HANOK box before=%s after=%s (riseScale 1.3→1.75 → y 증가 기대)', JSON.stringify(hb0), JSON.stringify(hb1));
  await shot(desk, 'hero-hanok-after', true);
}

// ③ 관아(palace, 다포) 편집 before/after — town 규모 재진입
await desk.goto(`${base}/index.html?village=1&vscale=town&seed=20260718&vseed=7&time=day`, { waitUntil: 'load' });
await ready(desk);
parcels = await ev(desk, () => window.__engine.village.debugParcels());
const palace = parcels.find((p) => p.hero && p.heroStyle === 'palace');
console.log('PARCELS(town) hero=%s', JSON.stringify(parcels.filter((p) => p.hero)));
if (palace) {
  await focusParcel(desk, palace.parcelId);
  const sp = await ev(desk, () => window.__engine.village.getState().spec);
  console.log('SPEC palace family=%s heroStyle=%s editable=%s params=%s', sp.family, sp.heroStyle, sp.editable, JSON.stringify(sp.params));
  await shot(desk, 'palace-panel', true);
  await shot(desk, 'palace-before', true);
  const pb0 = await box(desk, palace.parcelId);
  // 처마 깊이↑ + 공포 크기↑(기본 섹션) — 다포 격식 변형 가시
  await ev(desk, () => {
    const eave = document.querySelector('.panel input[data-key="eaveOverhang"]');
    if (eave) { eave.value = '2.15'; eave.dispatchEvent(new Event('input', { bubbles: true })); eave.dispatchEvent(new Event('change', { bubbles: true })); }
    const bs = document.querySelector('.panel input[data-key="bracketScale"]');
    if (bs) { bs.value = '1.4'; bs.dispatchEvent(new Event('input', { bubbles: true })); bs.dispatchEvent(new Event('change', { bubbles: true })); }
  });
  await ev(desk, () => new Promise((r) => setTimeout(r, 600)));
  // 고급: 기단 켜 + 버튼(스테퍼) 로 월대 격상, 월대 난간 토글
  await expandAdvanced(desk);
  await ev(desk, () => {
    const rows = [...document.querySelectorAll('.panel section')].flatMap((s) => [...s.querySelectorAll('.row.bays')]);
    const podRow = rows.find((r) => /기단 켜|Podium tiers/.test(r.querySelector('.rl')?.textContent || ''));
    if (podRow) { const plus = podRow.querySelectorAll('.stepper button')[1]; if (plus) plus.click(); }
    const tgls = [...document.querySelectorAll('.panel .tgl')];
    if (tgls[0]) tgls[0].click();   // podiumRailing 토글
  });
  await ev(desk, () => new Promise((r) => setTimeout(r, 800)));
  const pb1 = await box(desk, palace.parcelId);
  console.log('PALACE box before=%s after=%s (eave↑·공포↑·기단켜↑ → x/z·y 증가 기대)', JSON.stringify(pb0), JSON.stringify(pb1));
  await shot(desk, 'palace-after', true);
}

// ⑥ 회귀 — ?shot 베이스라인 + 4 프리셋(단일건물) 무에러
await desk.goto(`${base}/index.html?shot=1&seed=20260718`, { waitUntil: 'load' });
await ready(desk);
await shot(desk, 'regress-shot', true);
for (const preset of ['korea', 'temple', 'giwa', 'choga']) {
  await desk.goto(`${base}/index.html?hero=0&shot=1&preset=${preset}&seed=20260718`, { waitUntil: 'load' });
  await ready(desk);
  await shot(desk, `regress-${preset}`);
}
console.log('REGRESS presets done');

// 진입 시퀀스(히어로 랜딩) + 리플레이 무에러
const hp = await browser.newPage({ viewport: { width: 1280, height: 800, deviceScaleFactor: 2 } });
watch(hp, 'hero');
await hp.goto(`${base}/index.html?seed=20260718&vseed=7`, { waitUntil: 'load' });
await ready(hp);
// 타이틀 클릭 진입(.hero div 자체가 onclick — role=button)
await ev(hp, () => { const h = document.querySelector('.hero'); if (h) h.click(); });
await ev(hp, () => new Promise((r) => setTimeout(r, 9000)));   // 랜딩+조립 완주
await shot(hp, 'regress-hero-landing', true);
await ev(hp, () => window.__engine.village.replay());
await ev(hp, () => new Promise((r) => setTimeout(r, 7000)));
await shot(hp, 'regress-hero-replay');
await hp.close();

// ───────────────────────── 모바일 게이트(바텀시트) ─────────────────────────
const mob = await browser.newPage({ viewport: { width: 390, height: 844, deviceScaleFactor: 2 }, hasTouch: true, isMobile: true });
watch(mob, 'mob');
await mob.goto(`${base}/index.html?village=1&seed=20260718&vseed=7&time=day`, { waitUntil: 'load' });
await ready(mob);
const mparcels = await ev(mob, () => window.__engine.village.debugParcels());
const mchoga = mparcels.find((p) => p.family === 'regular' && p.kind !== 'giwa' && p.editable);
await focusParcel(mob, mchoga.parcelId, '.sheet.open');
await ev(mob, () => new Promise((r) => setTimeout(r, 500)));
await shot(mob, 'mobile-sheet', true);
// 시트 full 로 끌어올린 뒤 고급 펼침(핸들 탭 = detent 토글, evaluate-click 로 뷰포트 밖도 구동)
await ev(mob, () => { const grip = document.querySelector('.sheet .grip'); if (grip) grip.click(); });
await ev(mob, () => new Promise((r) => setTimeout(r, 500)));
await ev(mob, () => { const b = document.querySelector('.sheet .advtoggle'); if (b) b.click(); });
await ev(mob, () => new Promise((r) => setTimeout(r, 400)));
await shot(mob, 'mobile-sheet-advanced', true);
await mob.close();

// 규모 슬라이더 → setScale 스냅 경로(village→town) end-to-end
await desk.goto(`${base}/index.html?village=1&seed=20260718&vseed=7&time=day`, { waitUntil: 'load' });
await ready(desk);
await ev(desk, () => { const s = document.querySelector('.vcard input.scale'); if (s) { s.value = '2'; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true })); } });
await ev(desk, () => new Promise((r) => setTimeout(r, 2800)));   // withVeil 마스킹 + 마을 재생성 + 부감 트윈
await shot(desk, 'aerial-scale-town', true);
const townParcels = await ev(desk, () => window.__engine.village.debugParcels());
console.log('SLIDER→town palaceHero=%s (스냅 재생성 확인)', JSON.stringify(townParcels.filter((p) => p.heroStyle === 'palace').map((p) => p.parcelId)));

console.log('\n=== ERRORS (%d) ===', errors.length);
for (const e of errors) console.log(e);

await browser.close();
server.close();
console.log('DONE');
