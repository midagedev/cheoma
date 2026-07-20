// 태양 렌즈 플레어(#67) 검증. src/env/post.js 의 FlarePass 를 index.html(main.js 경로)로 구동.
// 사용: node tools/shoot-flare.mjs
// 산출: 실행 중 OS 임시 디렉터리에 전 컷(종료 시 삭제), shots/flare-*.png 에 게이트 증거만.
//   각 컷에서 window.__flare(amt·sunUV·front) 를 읽고, 같은 프레임의 flareON/flareOFF 를
//   토글 재캡처해 '플레어 기여분'(ON-OFF)을 분리 측정 → 절제(에너지 국소성)·연속성·소멸 판정.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
const { PNG } = createRequire(import.meta.url)('pngjs');

const ROOT = resolve(import.meta.dirname, '..');
const SCRATCH = mkdtempSync(join(tmpdir(), 'cheoma-flare-'));
const SHOTS = join(ROOT, 'shots');
mkdirSync(SHOTS, { recursive: true });

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  try {
    const path = req.url.split('?')[0];
    if (path === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    const file = join(ROOT, path === '/' ? 'index.html' : path);
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const port = server.address().port;

function luma(r, g, b) { return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; }

// 플레어 기여분(ON-OFF): 프레임 전체 가산 에너지와 태양 주변 박스 내 에너지. 국소성이 높을수록
//   '절제'(시선을 뺏지 않음). sunUV(GL uv, y↑) → PNG 행(y↓) 변환.
function flareDiff(on, off, sunUV) {
  const { width, height, data: A } = on; const B = off.data;
  let addTotal = 0, addSun = 0, maxAdd = 0, warmSum = 0, warmN = 0;
  const sx = sunUV ? sunUV[0] * width : -1;
  const sy = sunUV ? (1 - sunUV[1]) * height : -1;
  const R = Math.min(width, height) * 0.16;   // 태양 주변 박스 반경
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    const dl = luma(A[i], A[i + 1], A[i + 2]) - luma(B[i], B[i + 1], B[i + 2]);
    if (dl > 0.004) {
      addTotal += dl;
      if (dl > maxAdd) maxAdd = dl;
      // 가산 픽셀 웜니스(R-B, 양수=웜)
      const dr = A[i] - B[i], db = A[i + 2] - B[i + 2];
      warmSum += (dr - db); warmN++;
      if (sx >= 0 && Math.abs(x - sx) < R && Math.abs(y - sy) < R) addSun += dl;
    }
  }
  const px = width * height;
  return {
    addPerPx: (addTotal / px).toFixed(5),
    sunFrac: addTotal > 0 ? (addSun / addTotal * 100).toFixed(1) : '0.0',   // 태양 박스에 몰린 비율
    maxAdd: maxAdd.toFixed(3),
    warm: warmN ? (warmSum / warmN).toFixed(1) : '0',
    litPx: (100 * warmN / px).toFixed(2),   // 플레어가 닿은 픽셀 비율(과하면 화면 뒤덮음)
  };
}

let browser;
try { browser = await chromium.launch({ channel: 'chrome' }); }
catch { browser = await chromium.launch(); }
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
let failures = 0;
const check = (condition, message) => {
  console.log(`  ${condition ? 'PASS' : 'FAIL'} — ${message}`);
  if (!condition) failures++;
};
page.on('console', (m) => { if (m.type() === 'error') { console.error('[page]', m.text()); errors.push(m.text()); } });
page.on('pageerror', (e) => { console.error('[pageerror]', e.message); errors.push('PAGEERROR: ' + e.message); });

async function load(qs) {
  const before = errors.length;
  await page.goto(`http://127.0.0.1:${port}/index.html?shot=1&${qs}`, { waitUntil: 'load' });
  await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 30000 });
  await page.evaluate(() => { try { window.__wx && window.__wx.setAccum && window.__wx.setAccum(0); } catch {} });
  await page.waitForTimeout(250);
  return errors.length - before;
}
async function flareState() {
  return page.evaluate(() => {
    const f = window.__flare; if (!f) return null;
    // eff: 셰이더가 실제 렌더하는 실효 강도 프록시(가림 vis 제외한 CPU 항). amt × front × edgeFade.
    //   화면 밖 태양은 amt(CPU)가 1이어도 eff≈0 → 육안 팟 없음을 이 값의 연속성으로 검증.
    const uv = f.sunUV;
    const ox = Math.max(-uv[0], uv[0] - 1, 0), oy = Math.max(-uv[1], uv[1] - 1, 0);
    const ss = (e) => { const t = Math.min(1, Math.max(0, e / 0.55)); return t * t * (3 - 2 * t); };
    const edge = 1 - ss(Math.max(ox, oy));
    const eff = f.front ? f.amt * edge : 0;
    return { amt: f.amt, sunUV: uv, front: f.front, eff };
  });
}
async function shot(name) {
  const buf = await page.screenshot({ path: join(SCRATCH, name + '.png') });
  return PNG.sync.read(buf);
}
async function toggleFlare(v) {
  await page.evaluate((on) => { try { window.__flare && window.__flare.setEnabled(on); } catch {} }, v);
  await page.waitForTimeout(120);
}
function gate(name) { copyFileSync(join(SCRATCH, name + '.png'), join(SHOTS, 'flare-' + name + '.png')); }

// ── 게이트 1: 골든아워 역광 — 처마 킥 시그니처 + 기본 뷰 + 기여분 분리 ──────────────
// hero-eave: 태양이 우측 처마 뒤에서 드러나는 시그니처(az=30,el=-6, sunUV≈[0.73,0.63]).
// hero-tq: 앱 기본 뷰(three-quarter, 태양 프레임 위 → 은은한 상단 번짐+미세 고스트, 절제).
console.log('\n=== GATE 1: 골든아워 역광 (처마 킥 시그니처 + 기본 뷰) ===');
// 픽셀 골든은 브라우저/GPU에 너무 민감하다. 대신 승인한 룩의 넓은 에너지 봉투로
// 이중 색공간 변환·전면 번짐·플레어 소실 같은 의미 있는 회귀만 실패시킨다.
const heroEnvelopes = {
  'hero-eave': { add: [0.002, 0.008], max: [0.4, 0.9], lit: [5, 20], sun: [40, 85] },
  'hero-tq': { add: [0.0002, 0.0045], max: [0.2, 0.9], lit: [0.2, 5] },
  'hero-front': { add: [0.0004, 0.007], max: [0.2, 0.9], lit: [1, 12] },
};
for (const [nm, qs] of [
  ['hero-eave', 'env=1&preset=korea&time=sunset&az=30&el=-6'],
  ['hero-tq', 'env=1&preset=korea&angle=three-quarter&time=sunset'],
  ['hero-front', 'env=1&preset=korea&angle=front&time=sunset'],
]) {
  const errd = await load(qs);
  const st = await flareState();
  const on = await shot(nm + '-on');
  await toggleFlare(false); const off = await shot(nm + '-off'); await toggleFlare(true);
  const d = flareDiff(on, off, st && st.sunUV);
  gate(nm + '-on'); gate(nm + '-off');
  console.log(`${nm}: amt=${st ? st.amt.toFixed(3) : 'n/a'} eff=${st ? st.eff.toFixed(3) : '?'} sunUV=[${st ? st.sunUV.map(v => v.toFixed(2)) : '?'}] front=${st ? st.front : '?'}${errd ? ` ERR:${errd}` : ''}`);
  console.log(`  diff addPerPx=${d.addPerPx} sunFrac=${d.sunFrac}% maxAdd=${d.maxAdd} warm=${d.warm} litPx=${d.litPx}%`);
  const e = heroEnvelopes[nm];
  const add = Number(d.addPerPx), peak = Number(d.maxAdd), lit = Number(d.litPx), sun = Number(d.sunFrac);
  check(errd === 0 && !!st, `${nm}: 런타임 에러 없이 플레어 상태 제공`);
  check(add >= e.add[0] && add <= e.add[1], `${nm}: 가산 에너지 ${add} ∈ [${e.add.join(', ')}]`);
  check(peak >= e.max[0] && peak <= e.max[1], `${nm}: 피크 ${peak} ∈ [${e.max.join(', ')}]`);
  check(lit >= e.lit[0] && lit <= e.lit[1], `${nm}: 영향 면적 ${lit}% ∈ [${e.lit.join(', ')}]`);
  if (e.sun) check(sun >= e.sun[0] && sun <= e.sun[1], `${nm}: 태양 주변 국소성 ${sun}% ∈ [${e.sun.join(', ')}]`);
}

// ── 게이트 2: 카메라 궤도 스윕 (태양 화면밖→안→건물가림) 연속성·팟 없음 ───────────
console.log('\n=== GATE 2: 궤도 스윕 (az 스윕, 연속 생성·감쇠) ===');
// el=-6 로 태양을 처마선 높이에 두고 az 를 훑는다: 태양이 화면 밖(좌)→처마 뒤 등장→반대편으로.
const sweep = [];
for (const az of [-18, -13, -9, -4, 3, 12, 21, 30, 39, 45, 50, 55, 61, 68, 82]) {
  const errd = await load(`env=1&preset=korea&time=sunset&az=${az}&el=-6`);
  const st = await flareState();
  await shot(`sweep-az${az}`);
  sweep.push({ az, eff: st ? st.eff : 0, uv: st ? st.sunUV : [0, 0], front: st ? st.front : 0 });
  console.log(`  az=${az}: eff=${st ? st.eff.toFixed(3) : 'n/a'} sunUV=[${st ? st.sunUV.map(v => v.toFixed(2)) : '?'}] front=${st ? st.front : '?'}${errd ? ` ERR:${errd}` : ''}`);
}
// 인접 az 간 실효강도(eff) 점프 검사: 셰이더 렌더 강도의 연속성 = 육안 팟 부재. 큰 급점프 없어야.
let maxJump = 0;
for (let i = 1; i < sweep.length; i++) maxJump = Math.max(maxJump, Math.abs(sweep[i].eff - sweep[i - 1].eff));
console.log(`  최대 인접 eff 점프 = ${maxJump.toFixed(3)} (샘플 간 국소 점등을 포함해 0.45 이하)`);
check(maxJump <= 0.45, `궤도 스윕 최대 인접 점프 ${maxJump.toFixed(3)} ≤ 0.45`);
for (const az of [3, 30, 55]) gate(`sweep-az${az}`);

// ── 게이트 3: 시간대·날씨·모드 스윕 (정오미세/석양최대/밤소멸, 비·눈 소멸, ink·post0 무영향) ─
console.log('\n=== GATE 3: 시간대·날씨·모드 소멸 게이트 ===');
async function amtOnly(nm, qs, setW) {
  const errd = await load(qs);
  if (setW) { await page.evaluate((w) => { try { window.__flare.setWeather(w); } catch {} }, setW); await page.waitForTimeout(600); }
  const st = await flareState();
  await shot(nm);
  console.log(`  ${nm}: amt=${st ? st.amt.toFixed(3) : 'n/a'} front=${st ? st.front : '?'}${errd ? ` ERR:${errd}` : ''}`);
  return st ? st.amt : null;
}
// 날씨 소멸은 플레어가 강한 처마킥 프레이밍(az=30,el=-6)에서 테스트해 시각적으로도 대비되게.
const aDay = await amtOnly('time-day', 'env=1&preset=korea&time=day&az=30&el=-6');
const aSun = await amtOnly('time-sunset', 'env=1&preset=korea&time=sunset&az=30&el=-6');
const aNight = await amtOnly('time-night', 'env=1&preset=korea&time=night&az=30&el=-6');
const aRain = await amtOnly('wx-rain', 'env=1&preset=korea&time=sunset&az=30&el=-6', 'rain');
const aSnow = await amtOnly('wx-snow', 'env=1&preset=korea&time=sunset&az=30&el=-6', 'snow');
// ink: 별도 컴포저(post 미사용) → 플레어 무. post=0: post 컴포저 자체 미사용.
const errdInk = await load('env=1&preset=korea&angle=three-quarter&time=sunset&mode=ink');
await shot('mode-ink'); gate('mode-ink');
console.log(`  mode-ink: (별도 컴포저, 플레어 패스 미실행)${errdInk ? ` ERR:${errdInk}` : ''}`);
const errdP0 = await load('env=1&preset=korea&angle=three-quarter&time=sunset&post=0');
await shot('post0'); gate('post0');
console.log(`  post0: (post 컴포저 미사용)${errdP0 ? ` ERR:${errdP0}` : ''}`);
gate('time-sunset'); gate('time-day'); gate('time-night'); gate('wx-rain');
console.log(`  판정: day<sunset? ${aDay < aSun} | night≈0? ${aNight < 0.02} | rain소멸? ${aRain < aSun * 0.25} | snow소멸? ${aSnow < aSun * 0.25}`);
check([aDay, aSun, aNight, aRain, aSnow].every(Number.isFinite), '시간대·날씨별 플레어 강도 모두 유한');
check(aDay < aSun, `정오(${aDay}) < 석양(${aSun})`);
check(aNight < 0.02, `밤 플레어 소멸(${aNight})`);
check(aRain < aSun * 0.25 && aSnow < aSun * 0.25, `비·눈 플레어가 석양의 25% 미만(${aRain}, ${aSnow})`);
check(errdInk === 0 && errdP0 === 0, 'ink·post=0 경로 런타임 에러 0');

// ── 게이트 4: shot 결정론 (같은 URL 2회 픽셀 동일) ────────────────────────────────
// 플레어는 시간항이 없어 카메라·시간 고정 시 결정론이다. 잔차가 있다면 베이스 씬(모트·새 등
//   벽시계 애니). 이를 분리하려 플레어가 강한 처마킥(eave)과 플레어가 없는 post=0 을 각각 2회 비교:
//   두 잔차가 비슷하면 플레어는 비결정성을 추가하지 않은 것.
console.log('\n=== GATE 4: 결정론 (같은 URL 2회) — 플레어 추가 비결정성 격리 ===');
async function detDiff(qs) {
  await load(qs); const a = await shot('det-a');
  await load(qs); const b = await shot('det-b');
  let n = 0; for (let i = 0; i < a.data.length; i += 4) {
    if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2]) n++;
  }
  return { n, total: a.width * a.height };
}
const detFlare = await detDiff('env=1&preset=korea&time=sunset&az=30&el=-6');
const detNoPost = await detDiff('env=1&preset=korea&time=sunset&az=30&el=-6&post=0');
console.log(`  처마킥(플레어 강): 다른 픽셀 ${detFlare.n}/${detFlare.total} (${(100 * detFlare.n / detFlare.total).toFixed(2)}%)`);
console.log(`  post=0(플레어 무): 다른 픽셀 ${detNoPost.n}/${detNoPost.total} (${(100 * detNoPost.n / detNoPost.total).toFixed(2)}%)`);
console.log(`  → 두 잔차가 비슷하면 비결정성은 베이스 씬 몫(플레어 추가분 없음).`);
const flareResidual = 100 * detFlare.n / detFlare.total;
const baseResidual = 100 * detNoPost.n / detNoPost.total;
check(Math.abs(flareResidual - baseResidual) <= 2, `플레어/베이스 결정론 잔차 차이 ${Math.abs(flareResidual - baseResidual).toFixed(2)}%p ≤ 2%p`);

// ── 게이트 5: 마을 진입 정상(부감 저각 플레어 성립) ───────────────────────────────
console.log('\n=== GATE 5: 4프리셋 pageerror 0 ===');
for (const p of ['korea', 'temple', 'choga', 'giwa']) {
  const errd = await load(`env=1&preset=${p}&angle=three-quarter&time=sunset`);
  const st = await flareState();
  console.log(`  ${p}: amt=${st ? st.amt.toFixed(3) : 'n/a'}${errd ? ` ERR:${errd}` : ' ok'}`);
}

await browser.close();
await new Promise((resolveClose) => server.close(resolveClose));
rmSync(SCRATCH, { recursive: true, force: true });
check(errors.length === 0, `전체 브라우저 런타임 에러 0 (실제 ${errors.length})`);
console.log(`\n${failures === 0 ? 'VISUAL GATES: PASS' : `VISUAL GATES: FAIL (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);
