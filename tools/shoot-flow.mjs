// SPA 인터랙션 폴리시 검증 (task #38 ①②). 출력: shots/flow-*.png.
//   NODE_PATH=/Users/hckim/repo/threesur/node_modules node tools/shoot-flow.mjs
// dist-flow 를 전용 포트(4180)로 정적 서빙(HMR 없음 → 다른 에이전트 src 편집 무영향).
// ① 카메라 전환 왕복에서 프레임 단위 camera.position/controls.target/forward-dir 샘플링 →
//    before(구버그 window.__flowNoFix)/after(수정본) 스파이크 수치 비교.
// ② rebuild 두부 애니: __debugFreezeRebuild 로 스쿼시 정지 프레임 3컷 + minScaleY 수치.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'shots');
mkdirSync(OUT, { recursive: true });

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json',
  '.mp3': 'audio/mpeg', '.woff': 'font/woff', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
const server = createServer(async (req, res) => {
  try {
    let path = decodeURIComponent(req.url.split('?')[0]);
    if (path === '/') path = '/index.html';
    if (path.endsWith('/')) path += 'index.html';
    const data = await readFile(join(ROOT, 'app/dist-flow', path));
    res.writeHead(200, { 'content-type': MIME[extname(path)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end('nf'); }
});
await new Promise((ok) => server.listen(4180, '127.0.0.1', ok));
const BASE = 'http://127.0.0.1:4180';

let browser;
try { browser = await chromium.launch({ channel: 'chrome' }); }
catch { browser = await chromium.launch(); }

let errors = 0;
function wireErrors(page) {
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) { errors++; console.error('[page]', m.text()); } });
  page.on('pageerror', (e) => { errors++; console.error('[pageerror]', e.message); });
}
let asserts = 0, fails = 0;
function check(name, cond, extra = '') {
  asserts++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`);
  if (!cond) fails++;
}

// ---- 프레임 샘플러 (rAF 훅) ----
async function samplerStart(page) {
  await page.evaluate(() => {
    const eng = window.__engine, cam = eng.camera, ctr = eng.__controls;
    const V = cam.position.constructor;
    window.__cam = []; window.__samp = true;
    const loop = () => {
      if (!window.__samp) return;
      const d = cam.getWorldDirection(new V());
      window.__cam.push({
        p: [cam.position.x, cam.position.y, cam.position.z],
        g: [ctr.target.x, ctr.target.y, ctr.target.z],
        f: [d.x, d.y, d.z],
      });
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
}
async function samplerStop(page) {
  return await page.evaluate(() => { window.__samp = false; return window.__cam; });
}
function analyze(s) {
  let posMax = 0, tgtMax = 0;
  const angs = [];
  const perFrame = [];
  for (let i = 1; i < s.length; i++) {
    const a = s[i - 1], b = s[i];
    const dp = Math.hypot(b.p[0] - a.p[0], b.p[1] - a.p[1], b.p[2] - a.p[2]);
    const dg = Math.hypot(b.g[0] - a.g[0], b.g[1] - a.g[1], b.g[2] - a.g[2]);
    let dot = a.f[0] * b.f[0] + a.f[1] * b.f[1] + a.f[2] * b.f[2];
    dot = Math.max(-1, Math.min(1, dot));
    const ang = Math.acos(dot) * 180 / Math.PI;
    angs.push(ang);
    perFrame.push({ i, ang: +ang.toFixed(3), dp: +dp.toFixed(3), dg: +dg.toFixed(3) });
    if (dp > posMax) posMax = dp;
    if (dg > tgtMax) tgtMax = dg;
  }
  const sorted = [...angs].sort((x, y) => x - y);
  const med = sorted[Math.floor(sorted.length / 2)] || 0;
  const angMax = sorted[sorted.length - 1] || 0;
  const top3 = [...perFrame].sort((x, y) => y.ang - x.ang).slice(0, 3);
  // 불연속(스냅) 판정 = 카메라가 거의 정지(dp<0.2)한 프레임에서의 방향 점프.
  // 정상적인 빠른 스윕은 dp 가 크므로 제외된다(방향 변화가 위치 이동과 커플).
  let snapMax = 0;
  for (const f of perFrame) if (f.dp < 0.2 && f.ang > snapMax) snapMax = f.ang;
  // 피크가 '고립된 스파이크'인지 '매끄러운 피크'인지: 최대각 프레임의 이웃 대비 비율.
  const peakIdx = perFrame.reduce((m, f, k) => (f.ang > perFrame[m].ang ? k : m), 0);
  const nb = 0.5 * ((perFrame[peakIdx - 1]?.ang || 0) + (perFrame[peakIdx + 1]?.ang || 0));
  const peakNeighborRatio = nb > 1e-6 ? +(perFrame[peakIdx].ang / nb).toFixed(1) : Infinity;
  return {
    frames: s.length,
    posDeltaMax: +posMax.toFixed(4),
    tgtDeltaMax: +tgtMax.toFixed(4),
    fwdAngMaxDeg: +angMax.toFixed(3),
    fwdAngMedDeg: +med.toFixed(3),
    snapAngMaxDeg: +snapMax.toFixed(3),   // 정지 프레임 방향 점프 = 불연속 신호
    peakNeighborRatio,                     // ≈1 매끄러운 피크 / ≫1 고립 스파이크
    top3,
  };
}
const settle = (page, ms) => page.waitForTimeout(ms);

// ---- ① 마을 왕복(select 돌리인 → return 부감) : before/after ----
async function villageRoundTrip(page, noFix) {
  await page.goto(`${BASE}/?village=1&hero=0&vseed=20260716&time=day`, { waitUntil: 'load' });
  await page.waitForFunction('window.__engine && window.__engine.village.getState().active === true', null, { timeout: 30000 });
  await settle(page, 2000);
  // 화면상 정규 필지 하나 선택
  const pick = await page.evaluate(() => {
    const ps = window.__engine.village.debugParcels().filter((x) => !x.hero);
    for (const p of ps) {
      const s = window.__engine.village.debugScreenOf(p.parcelId);
      if (s && !s.behind && s.x > 80 && s.x < 1280 && s.y > 80 && s.y < 760) return { id: p.parcelId, s };
    }
    return null;
  });
  if (!pick) return null;
  await page.evaluate((v) => { window.__flowNoFix = v; }, noFix);
  await samplerStart(page);
  await page.mouse.click(pick.s.x, pick.s.y);
  // 돌리인 2.3s + 도착
  await page.waitForFunction('window.__engine.village.getState().transitioning === false', null, { timeout: 8000 }).catch(() => {});
  await settle(page, 500);
  const shots = {};
  // return(부감 복귀)
  await page.evaluate(() => window.__engine.village.return());
  await settle(page, 600);
  shots.midReturn = true;
  await page.waitForFunction('window.__engine.village.getState().transitioning === false', null, { timeout: 8000 }).catch(() => {});
  await settle(page, 400);
  const samples = await samplerStop(page);
  await page.evaluate(() => { window.__flowNoFix = false; });
  return analyze(samples);
}

// ---- ① 단일 집 select/deselect : before/after ----
async function houseRoundTrip(page, noFix) {
  await page.goto(`${BASE}/?hero=0&seed=20260716&time=day`, { waitUntil: 'load' });
  await page.waitForFunction('window.__engine', null, { timeout: 30000 });
  await settle(page, 1600);
  await page.evaluate((v) => { window.__flowNoFix = v; }, noFix);
  await samplerStart(page);
  await page.evaluate(() => window.__engine.select());
  await settle(page, 1400);
  await page.evaluate(() => window.__engine.clearSelection());
  await settle(page, 1400);
  const samples = await samplerStop(page);
  await page.evaluate(() => { window.__flowNoFix = false; });
  return analyze(samples);
}

// ============ RUN ============
console.log('\n=== ① 카메라 전환 중심 튐 (before=구버그 / after=수정본) ===');
{
  const page = await browser.newPage({ viewport: { width: 1360, height: 850 }, deviceScaleFactor: 2 });
  wireErrors(page);

  const vBefore = await villageRoundTrip(page, true);
  const vAfter = await villageRoundTrip(page, false);
  console.log('\n[마을 왕복] before(noFix):', JSON.stringify(vBefore));
  console.log('[마을 왕복] after (fix) :', JSON.stringify(vAfter));
  if (vBefore && vAfter) {
    check('마을 before: 정지 프레임 방향 스냅 큼(>8°)', vBefore.snapAngMaxDeg > 8, `${vBefore.snapAngMaxDeg}°`);
    check('마을 before: 고립 스파이크(이웃비≫)', vBefore.peakNeighborRatio > 20 || vBefore.peakNeighborRatio === null, `${vBefore.peakNeighborRatio}×`);
    check('마을 after: 정지 프레임 스냅 소멸(<1°)', vAfter.snapAngMaxDeg < 1, `${vAfter.snapAngMaxDeg}°`);
    check('마을 after: 최대각도 매끄러운 피크(이웃비<2)', vAfter.peakNeighborRatio < 2, `${vAfter.peakNeighborRatio}×`);
    check('마을: 스냅 개선 ≥10×', vBefore.snapAngMaxDeg / Math.max(vAfter.snapAngMaxDeg, 1e-3) >= 10, `${(vBefore.snapAngMaxDeg / Math.max(vAfter.snapAngMaxDeg, 1e-3)).toFixed(1)}×`);
  }

  const hBefore = await houseRoundTrip(page, true);
  const hAfter = await houseRoundTrip(page, false);
  console.log('\n[집 select/deselect] before(noFix):', JSON.stringify(hBefore));
  console.log('[집 select/deselect] after (fix) :', JSON.stringify(hAfter));
  if (hBefore && hAfter) {
    check('집 before: 정지 프레임 방향 스냅 큼(>3°)', hBefore.snapAngMaxDeg > 3, `${hBefore.snapAngMaxDeg}°`);
    check('집 after: 정지 프레임 스냅 소멸(<0.6°)', hAfter.snapAngMaxDeg < 0.6, `${hAfter.snapAngMaxDeg}°`);
  }

  // 전환 중간 프레임 스크린샷(수정본, 마을 돌리인)
  await page.goto(`${BASE}/?village=1&hero=0&vseed=20260716&time=day`, { waitUntil: 'load' });
  await page.waitForFunction('window.__engine && window.__engine.village.getState().active === true', null, { timeout: 30000 });
  await settle(page, 2000);
  const pk = await page.evaluate(() => {
    const ps = window.__engine.village.debugParcels().filter((x) => !x.hero);
    for (const p of ps) { const s = window.__engine.village.debugScreenOf(p.parcelId); if (s && !s.behind && s.x > 80 && s.x < 1280 && s.y > 80 && s.y < 760) return { id: p.parcelId, s }; }
    return null;
  });
  if (pk) {
    await page.mouse.click(pk.s.x, pk.s.y);
    await settle(page, 700); await page.screenshot({ path: join(OUT, 'flow-cam-dollyin-a.png') });
    await settle(page, 700); await page.screenshot({ path: join(OUT, 'flow-cam-dollyin-b.png') });
    await page.waitForFunction('window.__engine.village.getState().transitioning === false', null, { timeout: 8000 }).catch(() => {});
    await settle(page, 400); await page.screenshot({ path: join(OUT, 'flow-cam-arrived.png') });
    console.log('saved flow-cam-dollyin-a/b, flow-cam-arrived');
  }
  await page.close();
}

console.log('\n=== ② rebuild 두부 애니 (스쿼시 정지 프레임 + minScaleY) ===');
{
  const page = await browser.newPage({ viewport: { width: 1360, height: 850 }, deviceScaleFactor: 2 });
  wireErrors(page);
  await page.goto(`${BASE}/?hero=0&seed=20260716&time=day`, { waitUntil: 'load' });
  await page.waitForFunction('window.__engine', null, { timeout: 30000 });
  await settle(page, 1600);
  await page.evaluate(() => window.__engine.select());   // 편집 포커스
  await settle(page, 1400);

  // 정지 프레임 3컷(스쿼시 진행) + 수치
  const diags = [];
  const ts = [0.14, 0.34, 0.6];
  for (let i = 0; i < ts.length; i++) {
    const d = await page.evaluate((t) => window.__engine.__debugFreezeRebuild(t), ts[i]);
    diags.push(d);
    await settle(page, 250);
    await page.screenshot({ path: join(OUT, `flow-rebuild-${i + 1}.png`) });
  }
  console.log('freeze diags:', JSON.stringify(diags));
  const minAcross = Math.min(...diags.map((d) => d.minScaleY));
  const maxAcross = Math.max(...diags.map((d) => d.maxScaleY));
  check('rebuild: 스쿼시 눌림 존재(minScaleY<0.92)', minAcross < 0.92, `min=${minAcross}`);
  check('rebuild: 스트레치/오버슛 존재(maxScaleY>1.03)', maxAcross > 1.03, `max=${maxAcross}`);

  // 실제 setParam 경로: 디바운스 후 조립이 '태워지는지' + 종료 후 원복(자동진행 완주) 확인.
  const before = await page.evaluate(() => window.__engine.__debugAssemblyActive());
  await page.evaluate(() => window.__engine.setParam('roofPitch', Math.min(0.95, (window.__engine.getParams().roofPitch || 0.7) + 0.12)));
  await settle(page, 220);   // UI 디바운스 없이 직접 호출 → 90ms 후 조립 시작, 여유 있게 대기
  const during = await page.evaluate(() => window.__engine.__debugAssemblyActive());
  await settle(page, 1000);  // 0.8s 조립 완주
  const after = await page.evaluate(() => window.__engine.__debugAssemblyActive());
  console.log('live setParam active before/during/after:', before, during, after);
  check('rebuild: setParam 이 flat 스왑 아님 — 조립 재생 시작', during === true);
  check('rebuild: 애니 자동 완주 후 정지', before === false && after === false);
  await page.close();
}

// ---- 모바일 뷰포트 회귀(각 1컷) ----
console.log('\n=== 모바일 회귀(390×844) ===');
{
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  wireErrors(page);
  await page.goto(`${BASE}/?hero=0&seed=20260716&time=day`, { waitUntil: 'load' });
  await page.waitForFunction('window.__engine', null, { timeout: 30000 });
  await settle(page, 1600);
  await page.evaluate(() => window.__engine.select());
  await settle(page, 1400);
  await page.screenshot({ path: join(OUT, 'flow-mobile-select.png') });
  await page.evaluate(() => window.__engine.setParam('roofPitch', 0.85));
  await settle(page, 1100);
  await page.screenshot({ path: join(OUT, 'flow-mobile-rebuild.png') });
  console.log('saved flow-mobile-select, flow-mobile-rebuild');
  await page.close();
}

console.log(`\n=== 결과: ${asserts - fails}/${asserts} PASS, page errors=${errors} ===`);
await browser.close();
server.close();
process.exit(fails === 0 && errors === 0 ? 0 : 1);
