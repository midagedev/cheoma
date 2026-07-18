// #114 외딴집 앱 배선 검증 — dist-panels 빌드 재사용(클린 빌드 선행 필수), 전용 포트 4231, 무캡처.
//   ① 부팅 → 마을 상세 기본 펼침(aria-expanded=true, 클릭 없이 필드 가시)
//   ② setOpts scale:'solo' → debugPlan houses=1(예약 종가), 슬라이더 solo 앵커 존재
//   ③ solo + houses:0 + 절 → houses=0 + temple (= "절 하나만")
//   ④ 규모 복귀(village) → houses 오버라이드 자동 해제 경로는 App.setScale 소관(엔진 레벨은 opts 그대로) — UI 토글 존재만 확인
//   실행: node tools/verify-solo-ui.mjs
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const ROOT = resolve(import.meta.dirname, '..');
const reqTools = createRequire(join(ROOT, 'tools', 'package.json'));
const { chromium } = reqTools('playwright');
const DIST = join(ROOT, 'app', 'dist-panels');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

const server = createServer(async (req, res) => {
  let path = decodeURIComponent(req.url.split('?')[0]);
  if (path === '/') path = '/index.html';
  try {
    const data = await readFile(join(DIST, path));
    res.writeHead(200, { 'content-type': MIME[extname(path)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end('nf'); }
});
await new Promise((r) => server.listen(4231, '127.0.0.1', r));

let fails = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) fails++; };

const pageErrors = [];
let browser;
try { browser = await chromium.launch({ channel: 'chrome' }); } catch { browser = await chromium.launch(); }
const page = await browser.newPage();
page.on('pageerror', (e) => pageErrors.push(e.message));

await page.goto('http://127.0.0.1:4231/?village=1&seed=42', { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(() => window.__engine?.village?.getState?.()?.active === true, null, { timeout: 90000 });
await page.evaluate(() => new Promise((r) => setTimeout(r, 1500)));

// ① 기본 펼침
const expanded = await page.evaluate(() => {
  const b = document.querySelector('.ctx.village .advtoggle');
  return b ? b.getAttribute('aria-expanded') : null;
});
ok(expanded === 'true', `① 마을 상세 기본 펼침 (aria-expanded=${expanded})`);
const fieldVisible = await page.evaluate(() => !!document.querySelector('.ctx.village input[type="range"]:not(.scale)'));
ok(fieldVisible, '① 상세 필드 클릭 없이 가시');

// ② solo 스케일 → 집 1채(예약 종가)
const solo = await page.evaluate(async () => {
  window.__engine.village.setOpts({ scale: 'solo' });
  await new Promise((r) => setTimeout(r, 2500));
  const p = window.__engine.village.debugPlan ? window.__engine.village.debugPlan() : null;
  return p ? { plan: p, houses: p.houses ?? p.stats?.houses } : null;
});
console.log('  solo debugPlan:', solo && JSON.stringify(solo.plan));
ok(solo && solo.houses === 1, `② scale:'solo' → houses=1 (실측 ${solo && solo.houses})`);

// ③ 절 하나만: solo + houses:0 + includeTemple (집 0 — 절 존재는 코어 verify-solo 에서 증명됨)
const temple = await page.evaluate(async () => {
  window.__engine.village.setOpts({ scale: 'solo', houses: 0, includeTemple: true });
  await new Promise((r) => setTimeout(r, 2500));
  const p = window.__engine.village.debugPlan ? window.__engine.village.debugPlan() : null;
  const st = window.__engine.village.getState ? window.__engine.village.getState() : null;
  return p ? { houses: p.houses ?? p.stats?.houses, active: !!(st && st.active) } : null;
});
ok(temple && temple.houses === 0, `③ solo+houses:0+절 → 집 0 (실측 ${temple && temple.houses})`);
ok(temple && temple.active, '③ 집 없는 마을에서도 씬 활성(부감 폴백 경로 무붕괴)');

// ④ 슬라이더 solo 앵커 + 집 없이 토글 노출 — 실제 UI 경로(슬라이더 조작 → onScale → App state)로 구동
//   (엔진 setOpts 직접 호출은 App villageOpts 를 안 바꿔 패널 prop 이 그대로 — UI 검증은 UI 로).
const ui = await page.evaluate(async () => {
  const slider = document.querySelector('.ctx.village input.scale');
  if (!slider) return { max: null, toggles: [] };
  const max = slider.max;
  const setVal = (v) => {
    const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    proto.set.call(slider, v);
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    slider.dispatchEvent(new Event('change', { bubbles: true }));
  };
  setVal('0');   // SCALES[0] = 'solo'
  await new Promise((r) => setTimeout(r, 3000));   // 먹 안개 재생성 정착
  const toggles = [...document.querySelectorAll('.ctx.village .toggle')].map((b) => b.textContent.trim());
  const scaleLabel = document.querySelector('.ctx.village .scaleval')?.textContent || '';
  return { max, toggles, scaleLabel };
});
ok(ui.max === '5', `④ 슬라이더 6앵커 (max=${ui.max})`);
ok(ui.scaleLabel.includes('외딴집') || ui.scaleLabel.toLowerCase().includes('lone'), `④ 규모 라벨 = 외딴집 (실측 '${ui.scaleLabel}')`);
ok(ui.toggles.some((t) => t.includes('집 없이') || t.includes('No houses')), `④ '집 없이' 토글 노출 (${ui.toggles.join('/')})`);

ok(pageErrors.length === 0, `pageerror 0 (실측 ${pageErrors.length})`);
if (pageErrors.length) console.log(pageErrors.slice(0, 3).join('\n'));

await browser.close();
await new Promise((r) => server.close(r));
console.log(fails === 0 ? '\nVERIFY-SOLO-UI: ALL PASS' : `\nVERIFY-SOLO-UI: ${fails} FAIL`);
process.exit(fails === 0 ? 0 : 1);
