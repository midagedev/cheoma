// 감상 뷰 자동 회전 검증 (task #8 마지막 항목). 출력: shots/ui-orbit-*.png 전용.
//   실행: node tools/shoot-orbit.mjs
// 빌드된 app/dist 를 정적 서버로 띄워 검증(HMR 함정 회피). 검증 신호는 렌더 픽셀이 아니라
// 카메라 위치/방위각 델타 — 앰비언트 파티클(모트·연기·물결)이 매 프레임 움직이므로
// "픽셀 동일"은 성립하지 않고, "카메라가 도느냐/멈췄느냐"가 자동 회전의 실제 지표다.
// (PNG 쌍은 사람이 직접 Read 로 시각 확인하는 산출물.)
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

const shot = async (name) => { await page.screenshot({ path: join(OUT, `ui-${name}.png`) }); console.log('  saved', `ui-${name}.png`); };
const ready = () => page.waitForFunction('window.__engine', null, { timeout: 30000 });
const settle = (ms) => page.waitForTimeout(ms);
// 카메라 위치 + 페이지 시계. three-quarter 타깃은 xz=원점이라 방위각=atan2(x,z).
const sample = () => page.evaluate(() => {
  const p = window.__engine.camera.position;
  return { t: performance.now(), x: p.x, y: p.y, z: p.z, selected: window.__engine.getState().selected };
});
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const azim = (s) => Math.atan2(s.x, s.z) * 180 / Math.PI;
const dAng = (a, b) => { let d = azim(b) - azim(a); while (d > 180) d -= 360; while (d < -180) d += 360; return d; };

let asserts = 0, fails = 0;
function check(name, cond, extra = '') {
  asserts++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`);
  if (!cond) fails++;
}
// 캔버스 위 수평 드래그(>6px → 선택 아닌 궤도 회전). 사용자 조작 신호로 자동 회전 즉시 정지.
async function dragCanvas() {
  await page.mouse.move(680, 300);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(680 + i * 22, 300);
  await page.mouse.up();
}
async function clickAt(x, y) { await page.mouse.click(x, y); await settle(500); }

const URL = `${SPA}/?hero=0&seed=20260716&time=day`;

// ---------- 1) 자동 회전 + 조작 정지 ----------
async function autorotateAndDrag() {
  console.log('\n== autorotate + drag-pause ==');
  await page.goto(URL, { waitUntil: 'load' });
  await ready();
  // 로드 직후 마우스 조작 없이 대기 → idle(9s)+ramp(2.6s) 지나 궤도 회전 최대 속도.
  await settle(13000);
  const a = await sample(); await shot('orbit-a');
  await settle(5000);
  const b = await sample(); await shot('orbit-b');
  const moved = dist(a, b), deg = dAng(a, b), secs = (b.t - a.t) / 1000;
  const period = Math.abs(deg) > 0.01 ? Math.abs(360 / (deg / secs)) : Infinity;
  check('자동 회전: 카메라 이동', moved > 0.5, `dist=${moved.toFixed(2)} deg=${deg.toFixed(2)}/${secs.toFixed(1)}s`);
  check('자동 회전: 주기 2~4분대(60fps기준 ~3분)', period > 90 && period < 360, `period≈${period.toFixed(0)}s`);

  // 드래그(조작) → autoRotate 즉시 0. 드래그 놓을 때의 damping 관성(≈3s 활강)이 자연
  // 소멸한 뒤 두 컷을 재어 자동 회전이 정지 상태인지(카메라 불변) 확인. 두 컷 모두 drag+9s
  // idle 문턱 이전이라 자동 회전은 계속 꺼져 있어야 함.
  await dragCanvas();
  await settle(3200);
  const d0 = await sample(); await shot('orbit-drag-a');
  await settle(1600);
  const d1 = await sample(); await shot('orbit-drag-b');
  check('조작 직후 정지: 카메라 불변', dist(d0, d1) < 0.2, `dist=${dist(d0, d1).toFixed(3)}`);
}

// ---------- 2) 패널 열림(집 선택) 정지 ----------
async function panelPause() {
  console.log('\n== panel-open pause ==');
  await page.goto(URL, { waitUntil: 'load' });
  await ready();
  await settle(1500);
  let sel = false;
  for (const [x, y] of [[680, 480], [680, 540], [700, 440]]) {
    await clickAt(x, y);
    if ((await sample()).selected) { sel = true; break; }
  }
  check('집 선택(패널 열림)', sel);
  // 선택 트윈 종료 + idle(9s) 초과까지 대기 — 게이트 없으면 회전할 시점인데도 멈춰 있어야 함.
  await settle(12000);
  const p0 = await sample(); await shot('orbit-panel-a');
  await settle(5000);
  const p1 = await sample(); await shot('orbit-panel-b');
  check('패널 열림 정지: 여전히 selected', p1.selected === true);
  check('패널 열림 정지: 카메라 불변', dist(p0, p1) < 0.2, `dist=${dist(p0, p1).toFixed(3)}`);
}

// ---------- 3) 재개 이즈-인 램프 (조작 후 재개) ----------
async function resumeRamp() {
  console.log('\n== resume ease-in ramp ==');
  await page.goto(URL, { waitUntil: 'load' });
  await ready();
  await settle(1200);
  await dragCanvas();                          // 조작 → 정지, 여기부터 idle 카운트
  const t0 = (await sample()).t;
  const series = [];
  let shotA = false, shotB = false;
  // ~19초간 1초 간격 샘플 — 정지(≈0)→램프 상승→최대 속도. 12s/17s 컷 캡처(스펙: 12초+5초).
  for (let i = 0; i <= 18; i++) {
    const s = await sample();
    series.push({ el: (s.t - t0) / 1000, s });
    if (!shotA && (s.t - t0) / 1000 >= 12) { await shot('orbit-resume-a'); shotA = true; }
    if (!shotB && (s.t - t0) / 1000 >= 17) { await shot('orbit-resume-b'); shotB = true; }
    await settle(1000);
  }
  // 구간 회전 속도(deg/s) 산출.
  const rate = (lo, hi) => {
    const seg = series.filter((p) => p.el >= lo && p.el <= hi);
    if (seg.length < 2) return 0;
    const f = seg[0], l = seg[seg.length - 1];
    return Math.abs(dAng(f.s, l.s) / (l.el - f.el));
  };
  // [0-4]s 는 드래그 관성(damping) 활강이 섞여 있으므로 정지 판정에서 제외.
  const early = rate(4, 8.5);    // 관성 안착 후 ~ idle 전 — 정지
  const ramp = rate(9, 11.5);    // 램프 중 — 상승
  const full = rate(13, 18);     // 재개 완료 — 최대
  console.log('  series el(s)→az/s:', series.slice(1).map((p, i) =>
    `${p.el.toFixed(1)}:${(dAng(series[i].s, p.s) / (p.el - series[i].el)).toFixed(1)}`).join(' '));
  console.log(`  rate deg/s  idle[4-8.5]=${early.toFixed(3)}  ramp[9-11.5]=${ramp.toFixed(3)}  full[13-18]=${full.toFixed(3)}`);
  check('조작 후 idle 전 정지(≈0)', early < 0.15, `${early.toFixed(3)}`);
  check('재개: full 속도 회전', full > 1.0, `${full.toFixed(2)} deg/s`);
  check('이즈-인: ramp 구간이 full 보다 느림', ramp < full * 0.9, `ramp=${ramp.toFixed(2)} full=${full.toFixed(2)}`);
  // 12s/17s 컷 사이 실제 회전(재개 확인).
  const a = series.find((p) => p.el >= 12)?.s, b = series.find((p) => p.el >= 17)?.s;
  if (a && b) check('12s→17s 컷 사이 회전 재개', dist(a, b) > 0.5, `dist=${dist(a, b).toFixed(2)}`);
}

const only = process.argv[2] || 'all';
const steps = { autorotateAndDrag, panelPause, resumeRamp };
for (const [name, fn] of Object.entries(steps)) {
  if (only === 'all' || only === name) {
    try { await fn(); } catch (e) { console.error(`ERROR [${name}]`, e.message); errors++; }
  }
}

await browser.close();
server.close();
console.log(`\nasserts: ${asserts - fails}/${asserts} passed`);
console.log(`pageerror/console-error total: ${errors}`);
process.exit(errors > 0 || fails > 0 ? 1 : 0);
