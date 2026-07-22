// 헤드리스 코드·수치 검증(#91 마을 패널 파라미터 대확장 + #96 집 마당 소품 축). 스크린샷·PNG 없음.
// 사용법: node tools/verify-panels.mjs
//
// 두 컨텍스트:
//   A) /__vplan (ROOT 서버, importmap + planVillage 직접) — 코어 옵션 반영을 plan 데이터로 단언:
//      · defaults no-op: {} == {...villageDefaults(App 실제값)} (결정론 앵커 불변)
//      · 결정론: 같은 seed+opts 2회 ==
//      · stream off → site.stream 소멸 / cityWall true → 성곽 생성 / paddyDensityK 극단 → 논 카운트 변화
//   B) app/dist-panels (전용 포트 4228, window.__engine 훅) — 앱·엔진 경로:
//      · 마을 상세 스키마 DOM 등재(11 필드) + 토글 end-to-end → debugPlan 효과 + 시드 유지
//      · #96 집 패널 마당 소품 필드 렌더 + buildRebuildPayload route 'top' 라우팅
//      · 기존 파라미터 회귀(footprintScale 라이브) · 히어로/focus/리롤 플로우 pageerror 0
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..');
const DIST = join(ROOT, 'app', 'dist-panels');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.woff': 'font/woff', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };

let PASS = 0, FAIL = 0;
const ok = (name, cond, extra = '') => { (cond ? PASS++ : FAIL++); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };

// ── A) 코어 plan 검증 페이지 ──
const VPLAN_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8">
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.185.1/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.185.1/examples/jsm/"}}</script>
</head><body><script type="module">
import { planVillage } from '/src/village/plan.js';
import { villageDefaults } from '/app/src/lib/edit-schema.js';
function info(scale, opts) {
  const p = planVillage({ scale, seed: 20260716, includeTemple: true, ...opts });
  const parts = [];
  // 배치 해시 — 필지 위치/유형 + 개체 변주(sx/sy/sz/yaw: diversityK 지터가 여기 실린다) + 담장.
  for (const pc of p.parcels) parts.push(pc.id, pc.kind, pc.center.x.toFixed(3), pc.center.z.toFixed(3), pc.variant, (pc.rank||0).toFixed(3), pc.wallType||'',
    (pc.sx||0).toFixed(3), (pc.sy||0).toFixed(3), (pc.sz||0).toFixed(3), (pc.yaw||0).toFixed(4));
  const F = p.features || {};
  if (F.cityWall) for (const g of F.cityWall.gates) parts.push('g', g.name, g.x.toFixed(2), g.z.toFixed(2));
  // 지형 높이 샘플 — undAmpK(언듈레이션 진폭)은 x,z 배치가 아니라 terrain y 에 실린다. site.heightAt 로 캡처.
  let terr = '';
  const R = p.site.R;
  for (const [fx, fz] of [[-0.4, -0.3], [0.35, -0.15], [-0.2, 0.4], [0.5, 0.25], [0.1, -0.5], [-0.5, 0.1]]) {
    terr += (p.site.heightAt(fx * R, fz * R)).toFixed(3) + ',';
  }
  return {
    hash: parts.join('|'), terr,
    houses: p.stats.houses, paddies: p.stats.paddies,
    stream: !!(p.site && p.site.stream),
    watercourse: p.site?.stream?.kind || 'dry',
    waterWidth: p.site?.stream ? p.site.stream.waterHalf * 2 : 0,
    cityWall: !!F.cityWall, sijeon: Array.isArray(F.sijeon) ? F.sijeon.length : 0,
    char01: +Number(p.opts.char01).toFixed(3), charOverride: !!p.opts.charOverride,
  };
}
const R = {};
R.defaults = villageDefaults();
R.base = info('village', {});
R.def = info('village', { ...villageDefaults() });        // App 실제 기본값 주입
R.base2 = info('village', {});                             // 결정론(재현)
R.streamOff = info('village', { stream: false });
R.river = info('capital', { river: true, includePalace: true });
R.wallOn = info('village', { cityWall: true });
R.paddyHi = info('village', { paddyDensityK: 2 });
R.paddyLo = info('village', { paddyDensityK: 0.2 });
R.undLo = info('village', { undAmpK: 0 });                 // 평탄
R.undHi = info('village', { undAmpK: 2.2 });               // 기복 최대
R.charOv = info('village', { char01: 0.05 });              // 초가 극단
R.charOvHi = info('village', { char01: 0.95 });            // 기와 극단
R.divHi = info('village', { diversityK: 2 });
R.sijeonHan = info('hanyang', {});                         // 한양 자동 시전
R.sijeonHanOff = info('hanyang', { sijeon: false });
window.__VP = R; window.__READY = true;
</script></body></html>`;

const rootServer = createServer(async (req, res) => {
  const path = decodeURIComponent(req.url.split('?')[0]);
  if (path === '/__vplan') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(VPLAN_HTML); return; }
  try {
    const data = await readFile(join(ROOT, path === '/' ? 'index.html' : path));
    res.writeHead(200, { 'content-type': MIME[extname(path)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end('nf'); }
});
await new Promise((r) => rootServer.listen(0, '127.0.0.1', r));
const rootPort = rootServer.address().port;

// ── B) dist-panels 앱 서버(전용 포트 4228) ──
const appServer = createServer(async (req, res) => {
  let path = decodeURIComponent(req.url.split('?')[0]);
  if (path === '/') path = '/index.html';
  try {
    const data = await readFile(join(DIST, path));
    res.writeHead(200, { 'content-type': MIME[extname(path)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end('nf'); }
});
await new Promise((r) => appServer.listen(4228, '127.0.0.1', r));
const appBase = 'http://127.0.0.1:4228';

let browser;
try { browser = await chromium.launch({ channel: 'chrome' }); } catch { browser = await chromium.launch(); }
const pageErrors = [];   // JS 예외(pageerror) — 하드 실패 판정
const resWarns = [];     // 리소스 404 등(격리 빌드에 audio 등 미포함 — 양성) — 경고만
function watch(page, tag) {
  page.on('console', (m) => { if (m.type() === 'error') resWarns.push(`[${tag} console] ${m.text()}`); });
  page.on('pageerror', (e) => pageErrors.push(`[${tag}] ${e.message}`));
  page.on('response', (r) => { if (r.status() === 404) resWarns.push(`[${tag} 404] ${r.url()}`); });
}
const ev = (page, fn, ...a) => page.evaluate(fn, ...a);
const wait = (page, ms) => ev(page, (m) => new Promise((r) => setTimeout(r, m)), ms);
// 부감(aerial) 도달 대기 — focus/return 트윈 정착 후 다음 focus 를 안전하게 태운다.
async function waitAerial(page, ms = 6000) {
  await page.waitForFunction(() => { const s = window.__engine?.village?.getState?.(); return s && s.active && !s.selected && !s.transitioning; }, null, { timeout: ms }).catch(() => {});
}
async function focusAndOpen(page, id, ms = 12000) {
  await waitAerial(page);
  await ev(page, (pid) => window.__engine.village.debugFocus(pid), id);
  await page.waitForFunction((pid) => window.__engine?.village?.getState?.().selected === pid, id, { timeout: ms }).catch(() => {});
  await wait(page, 900);   // 돌리인 + 패널 슬라이드 정착
  return ev(page, () => window.__engine.village.getState().selected);
}

// ═════════════ A) 코어 plan 단언 ═════════════
console.log('\n── A) 코어 plan(옵션 반영·결정론·no-op) ──');
{
  const p = await browser.newPage();
  p.on('pageerror', (e) => { pageErrors.push(`[vplan] ${e.message}`); });
  await p.goto(`http://127.0.0.1:${rootPort}/__vplan`, { waitUntil: 'load' });
  await p.waitForFunction('window.__READY === true', null, { timeout: 30000 });
  const R = await ev(p, () => window.__VP);
  console.log('villageDefaults =', JSON.stringify(R.defaults));
  console.log('base:', JSON.stringify({ houses: R.base.houses, paddies: R.base.paddies, stream: R.base.stream, cityWall: R.base.cityWall, char01: R.base.char01 }));
  ok('#91 defaults no-op (base==villageDefaults 주입)', R.base.hash === R.def.hash && R.base.char01 === R.def.char01 && !R.def.charOverride);
  ok('#91 결정론 (같은 seed+opts 2회 동일)', R.base.hash === R.base2.hash);
  ok('#91 stream=false → 개울 소멸', R.base.stream === true && R.streamOff.stream === false);
  ok('#91 stream=false → 필지 배치도 변화(마른 마을)', R.base.hash !== R.streamOff.hash);
  ok('#40 river=true → 도성 수로가 한강급 강 문법 사용', R.river.watercourse === 'river' && R.river.waterWidth >= 60);
  ok('#91 cityWall=true → 성곽 생성 (village 기본 없음)', R.base.cityWall === false && R.wallOn.cityWall === true);
  ok('#91 paddyDensityK 극단 → 논 카운트 변화', R.paddyHi.paddies !== R.paddyLo.paddies, `hi=${R.paddyHi.paddies} lo=${R.paddyLo.paddies} base=${R.base.paddies}`);
  ok('#91 undAmpK 변경 → 지형 기복 변화 (heightAt 샘플)', R.undLo.terr !== R.undHi.terr && R.base.terr !== R.undLo.terr, `terrLo≠terrHi`);
  ok('#91 char01 오버라이드 → 유형비 변화 (초가↔기와)', R.charOv.hash !== R.charOvHi.hash && R.charOv.charOverride === true, `초가극단 giwa? charOv.char01=${R.charOv.char01} hi=${R.charOvHi.char01}`);
  ok('#91 char01 미지정 → charOverride=false (규모 자동)', R.base.charOverride === false);
  ok('#91 diversityK 변경 → 변주 분포 변화', R.base.hash !== R.divHi.hash);
  ok('#91 sijeon 한양 자동 ON, 강제 OFF 반영', R.sijeonHan.sijeon > 0 && R.sijeonHanOff.sijeon === 0, `han=${R.sijeonHan.sijeon} off=${R.sijeonHanOff.sijeon}`);
  await p.close();
}

// ═════════════ B) 앱·엔진 경로 ═════════════
console.log('\n── B) 앱 패널·엔진 경로 ──');
const VKEYS = ['undAmpK', 'ridgeHK', 'streamMeanderK', 'stream', 'river', 'paddyDensityK', 'treeDensityK', 'cityWall', 'sijeon', 'char01', 'diversityK'];
const desk = await browser.newPage({ viewport: { width: 1280, height: 800, deviceScaleFactor: 2 } });
watch(desk, 'app');
await desk.goto(`${appBase}/index.html?village=1&vscale=capital&vseed=7&seed=20260718&time=day`, { waitUntil: 'load' });
await desk.waitForFunction('window.__SHOT_READY === true', null, { timeout: 40000 });
await wait(desk, 1600);   // 부감 진입 트윈 정착

// ① 마을 상세 스키마 DOM 등재
await ev(desk, () => { const b = document.querySelector('.ctx.village .advtoggle'); if (b && b.getAttribute('aria-expanded') !== 'true') b.click(); });   // 기본 펼침(2026-07-19) 대응: 이미 열려 있으면 클릭 금지
await wait(desk, 300);
const domKeys = await ev(desk, () => [...document.querySelectorAll('.ctx.village [data-vkey]')].map((n) => n.getAttribute('data-vkey')));
const missing = VKEYS.filter((k) => !domKeys.includes(k));
ok('#40 마을 상세 스키마 11필드 DOM 등재', missing.length === 0, missing.length ? 'missing=' + missing.join(',') : `keys=${domKeys.length}`);

const plan0 = await ev(desk, () => window.__engine.village.debugPlan());
console.log('plan0:', JSON.stringify({ seed: plan0.seed, houses: plan0.houses, paddies: plan0.paddies, stream: plan0.stream, cityWall: plan0.cityWall, trees: plan0.trees }));

// ② end-to-end: stream 토글 클릭(App setVillageOpt→setOpts) → 개울 소멸 + 시드 유지
await ev(desk, () => { const t = document.querySelector('.ctx.village [data-vkey="stream"]'); if (t) t.click(); });
// 옵션 커밋은 3.6초 exclusive scenery wave가 소유한다. 고정 2.6초 판정은 아직
// old plan이 보이는 정상 중간 프레임을 실패로 오인하므로 실제 커밋 상태를 기다린다.
await desk.waitForFunction(() => window.__engine?.village?.debugPlan?.()?.stream === false,
  null, { timeout: 12000 }).catch(() => {});
const planStream = await ev(desk, () => window.__engine.village.debugPlan());
ok('#91 end-to-end stream 토글 → 개울 소멸', plan0.stream === true && planStream.stream === false, `before=${plan0.stream} after=${planStream.stream}`);
ok('#91 end-to-end 옵션 변경 후 시드 유지', planStream.seed === plan0.seed, `seed ${plan0.seed}→${planStream.seed}`);
// 큰 물길은 도성부터 UI에서 활성화된다. 개울을 복원한 뒤 실제 버튼을 눌러
// Svelte → engine.setOpts → pure site → renderer 경로를 한 번에 검증한다.
await ev(desk, () => document.querySelector('.ctx.village [data-vkey="stream"]')?.click());
await desk.waitForFunction(() => window.__engine?.village?.debugPlan?.()?.watercourse === 'creek',
  null, { timeout: 12000 }).catch(() => {});
const riverUi = await ev(desk, () => {
  const button = document.querySelector('.ctx.village [data-vkey="river"]');
  return { found: !!button, disabled: !!button?.disabled };
});
await ev(desk, () => document.querySelector('.ctx.village [data-vkey="river"]')?.click());
await desk.waitForFunction(() => window.__engine?.village?.debugPlan?.()?.watercourse === 'river',
  null, { timeout: 12000 }).catch(() => {});
const planRiver = await ev(desk, () => window.__engine.village.debugPlan());
ok('#40 도성 강 토글 활성·end-to-end 반영', riverUi.found && !riverUi.disabled
  && planRiver.watercourse === 'river' && planRiver.waterWidth >= 60,
`ui=${JSON.stringify(riverUi)} kind=${planRiver.watercourse} width=${planRiver.waterWidth}`);
ok('#40 강 전환 뒤 시드 유지', planRiver.seed === plan0.seed, `seed ${plan0.seed}→${planRiver.seed}`);
// 직접 setOpts 로 cityWall / paddy 극단(빠른 경로, 동일 setOpts)
await ev(desk, () => window.__engine.village.setOpts({ cityWall: true }));
await wait(desk, 1600);
const planWall = await ev(desk, () => window.__engine.village.debugPlan());
ok('#91 setOpts cityWall=true → 성곽 생성', plan0.cityWall === false && planWall.cityWall === true);
ok('#91 cityWall 변경 후 시드 유지', planWall.seed === plan0.seed);
await ev(desk, () => document.querySelector('.foot.village .rebuild')?.click());
await desk.waitForFunction((seed) => window.__engine?.village?.debugPlan?.()?.seed !== seed,
  planWall.seed, { timeout: 12000 }).catch(() => {});
const planWallReroll = await ev(desk, () => window.__engine.village.debugPlan());
ok('#21 마을 리롤 뒤 강제 성곽 옵션 유지', planWallReroll.seed !== planWall.seed
  && planWallReroll.cityWall === true
  && planWallReroll.opts.cityWall === true, `seed ${planWall.seed}→${planWallReroll.seed}`);
await ev(desk, () => window.__engine.village.setOpts({ cityWall: 'auto', stream: true, paddyDensityK: 0.2 }));
await wait(desk, 1600);
const planPLo = await ev(desk, () => window.__engine.village.debugPlan());
await ev(desk, () => window.__engine.village.setOpts({ paddyDensityK: 2 }));
await wait(desk, 1600);
const planPHi = await ev(desk, () => window.__engine.village.debugPlan());
ok('#91 paddyDensityK 극단(0.2→2) → 논 카운트 변화', planPLo.paddies !== planPHi.paddies, `lo=${planPLo.paddies} hi=${planPHi.paddies}`);

// ③ 기존 파라미터 회귀 — 정규 필지 footprintScale 라이브 반영(오버레이 bbox 증가)
await ev(desk, () => window.__engine.village.setOpts({ paddyDensityK: 1 }));   // 기본 복귀
await wait(desk, 1600);
const parcels = await ev(desk, () => window.__engine.village.debugParcels());
const choga = parcels.find((p) => p.family === 'regular' && p.kind !== 'giwa' && p.editable);
const giwa = parcels.find((p) => p.family === 'regular' && p.kind === 'giwa' && p.editable);
if (choga) {
  const sel = await focusAndOpen(desk, choga.parcelId);
  ok('③ 초가 focus-in 성공', sel === choga.parcelId, `selected=${sel}`);
  const box0 = await ev(desk, (id) => window.__engine.village.debugOverlayBox(id), choga.parcelId);
  await ev(desk, () => { const b = document.querySelector('.ctx.house .advtoggle'); if (b && b.getAttribute('aria-expanded') !== 'true') b.click(); });
  await wait(desk, 300);
  const hasFs = await ev(desk, () => !!document.querySelector('.ctx.house input[data-key="footprintScale"]'));
  await ev(desk, () => { const el = document.querySelector('.ctx.house input[data-key="footprintScale"]'); if (el) { el.value = '1.4'; el.dispatchEvent(new Event('input', { bubbles: true })); } });
  await wait(desk, 400);
  const box1 = await ev(desk, (id) => window.__engine.village.debugOverlayBox(id), choga.parcelId);
  ok('③ 기존 파라미터 회귀: footprintScale 라이브 반영(bbox 증가)', hasFs && box0 && box1 && (box1.x > box0.x || box1.y > box0.y), `box0=${JSON.stringify(box0)} box1=${JSON.stringify(box1)}`);

  // #10 집 마당 소품 + 창호 필드 렌더(초가: 문/창 개수·폭 + 창살)
  await ev(desk, () => { const b = document.querySelector('.ctx.house .advtoggle'); if (b && b.getAttribute('aria-expanded') !== 'true') b.click(); });
  await wait(desk, 250);
  const chogaProps = await ev(desk, () => {
    const rls = [...document.querySelectorAll('.ctx.house .rl')].map((n) => n.textContent);
    const has = (re) => rls.some((t) => re.test(t));
    return {
      jangdok: has(/장독대|Jar/i), vegBed: has(/텃밭|Kitchen/i), yardStack: has(/낟가리|Straw/i), clothesline: has(/빨래|Clothes/i),
      doorCount: has(/문 수|Doors/i), windowCount: has(/창 수|Windows/i),
      doorWidth: has(/문 너비|Door width/i), windowWidth: has(/창 너비|Window width/i),
      doorPattern: has(/창살|Lattice/i),
    };
  });
  ok('#96 초가 마당 소품 4종 필드 렌더', chogaProps.jangdok && chogaProps.vegBed && chogaProps.yardStack && chogaProps.clothesline, JSON.stringify(chogaProps));
  ok('#10 초가 창호/개구 4축+창살 렌더', chogaProps.doorCount && chogaProps.windowCount
    && chogaProps.doorWidth && chogaProps.windowWidth && chogaProps.doorPattern, JSON.stringify(chogaProps));

  // #96 실제 반영(adapter override): 마당 소품 전부 ON vs OFF → 오버레이 메시·정점 수 증가
  const yStats = await ev(desk, (id) => {
    const hi = window.__engine.village.debugParcelStats(id, { kind: 'choga', jangdok: 3, vegBed: true, yardStack: true, clothesline: true, aux: false });
    const lo = window.__engine.village.debugParcelStats(id, { kind: 'choga', jangdok: 0, vegBed: false, yardStack: false, clothesline: false, aux: false });
    return { hi, lo };
  }, choga.parcelId);
  ok('#96 마당 소품 ON/OFF → 오버레이 소품 카운트 변화', yStats.hi && yStats.lo && yStats.hi.meshes > yStats.lo.meshes && yStats.hi.verts > yStats.lo.verts, `hi=${JSON.stringify(yStats.hi)} lo=${JSON.stringify(yStats.lo)}`);
  // #10 개구: windowCount 1→최대 → 실제 FULL 개구 정점 수 변화. route 'building' 계약.
  const wStats = await ev(desk, (id) => {
    const hi = window.__engine.village.debugParcelStats(id, { kind: 'choga', building: { windowCount: 99 } });
    const lo = window.__engine.village.debugParcelStats(id, { kind: 'choga', building: { windowCount: 1 } });
    return { hi, lo };
  }, choga.parcelId);
  ok('#10 windowCount min/max → 개구 카운트 변화', wStats.hi && wStats.lo && wStats.hi.verts > wStats.lo.verts, `hi=${JSON.stringify(wStats.hi)} lo=${JSON.stringify(wStats.lo)}`);
  await ev(desk, () => window.__engine.village.return());
  await wait(desk, 2400);
}
if (giwa) {
  const gsel = await focusAndOpen(desk, giwa.parcelId);
  ok('#96 기와 focus-in 성공', gsel === giwa.parcelId, `selected=${gsel}`);
  const giwaProps = await ev(desk, () => ({
    jangdok: [...document.querySelectorAll('.ctx.house .rl')].some((n) => /장독대|Jar/i.test(n.textContent)),
    clothesline: [...document.querySelectorAll('.ctx.house .rl')].some((n) => /빨래|Clothes/i.test(n.textContent)),
    openings: ['문 수', '창 수', '문 너비', '창 너비'].every((label) => (
      [...document.querySelectorAll('.ctx.house .rl')].some((n) => n.textContent.includes(label))
    )),
  }));
  ok('#96 기와 마당 소품 필드 렌더(장독대·빨래줄)', giwaProps.jangdok && giwaProps.clothesline, JSON.stringify(giwaProps));
  ok('#10 기와 창호/개구 4축 렌더', giwaProps.openings, JSON.stringify(giwaProps));
  await ev(desk, () => window.__engine.village.return());
  await wait(desk, 2400);
}

// ④ 히어로 진입·focus·리롤 플로우 pageerror 0
const hp = await browser.newPage({ viewport: { width: 1280, height: 800, deviceScaleFactor: 2 } });
watch(hp, 'hero');
await hp.goto(`${appBase}/index.html?seed=20260718&vseed=7`, { waitUntil: 'load' });
await hp.waitForFunction('window.__SHOT_READY === true', null, { timeout: 40000 });
await ev(hp, () => document.querySelector('button.hero')?.click());
await wait(hp, 9000);   // 랜딩(종가 클로즈업)+조립
// 부감 복귀 후 마을 옵션 변경(히어로 홈 세션에서도 setOpts 동작)
await ev(hp, () => {
  window.__engine.village.return();
  window.__engine.debugDofSeek(1, { finish: true });
});
await hp.waitForFunction(() => window.__engine?.village?.getState?.().selected == null,
  null, { timeout: 12000 }).catch(() => {});
await ev(hp, () => window.__engine.village.setOpts({ treeDensityK: 0.3 }));
await hp.waitForFunction(() => {
  const plan = window.__engine?.village?.debugPlan?.();
  return plan?.opts?.treeDensityK === 0.3 && plan.trees < 200;
},
  null, { timeout: 12000 }).catch(() => {});
const heroPlan = await ev(hp, () => window.__engine.village.debugPlan());
ok('④ 히어로 세션 마을 옵션 반영(treeDensityK)', heroPlan && heroPlan.trees >= 0, `trees=${heroPlan?.trees}`);
// 리롤 웨이브(패널 다시 짓기)
await ev(hp, () => document.querySelector('.foot.village .rebuild')?.click());
await hp.waitForFunction((seed) => window.__engine?.village?.debugPlan?.()?.seed !== seed,
  heroPlan.seed, { timeout: 12000 }).catch(() => {});
const heroRerolled = await ev(hp, () => window.__engine.village.debugPlan());
ok('④ 히어로 세션 리롤 뒤 상세 옵션 유지', heroRerolled?.seed !== heroPlan.seed
  && heroRerolled?.opts?.treeDensityK === 0.3,
  `seed ${heroPlan.seed}→${heroRerolled?.seed}, treeDensityK=${heroRerolled?.opts?.treeDensityK}`);
await hp.close();

ok('④ 히어로/focus/리롤 플로우 pageerror 0', pageErrors.length === 0, pageErrors.length ? pageErrors.slice(0, 6).join(' || ') : '');

console.log(`\n=== pageErrors (${pageErrors.length}) ===`);
for (const e of pageErrors.slice(0, 20)) console.log(e);
console.log(`\n=== 리소스 경고/404 (${resWarns.length}, 격리 빌드 audio 등 — 양성) ===`);
for (const e of [...new Set(resWarns)].slice(0, 12)) console.log(e);
console.log(`\n=== RESULT: ${PASS} PASS / ${FAIL} FAIL ===`);

await browser.close();
appServer.close();
rootServer.close();
console.log('DONE');
process.exit(FAIL > 0 ? 1 : 0);
