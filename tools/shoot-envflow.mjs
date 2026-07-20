// env 오토로테이션 "시간 흐르기" 토글 검증 (task #64). 출력: shots/envflow-*.png.
//   node tools/shoot-envflow.mjs
// dist-envflow 를 전용 포트(4185)로 정적 서빙(HMR 없음 → 다른 에이전트 src 편집 무영향, dev 5174 미접촉).
// 게이트:
//   ① 간격 오버라이드(flowsec)로 스텝마다 자동 전진 + 다이얼 활성 라벨/URL 추종 + 크로스페이드(스냅 아님)
//   ② 하루 한 바퀴 후 계절 전진 + 눈→맑음 정리(비는 유지)
//   ③ 수동 다이얼 변경 시 타이머 리셋(직후 간격 내 자동 전진 없음), 모드 유지
//   ④ 토글 URL 왕복(flow=1 로드 → 자동 흐름 재개 / 토글 시 URL 기록)
//   ⑤ ?shot=1 완전 정지(시간 불변 + 픽셀 불변)
//   ⑥ 데스크톱 + 모바일(iPhone) 배치 — 버튼 겹침 없음, 터치 타깃 ≥44px
//   ⑦ 콘솔/페이지 에러 0
//   (+) 마을 모드에서도 자동 전진 동작 확인
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
const { PNG } = createRequire(import.meta.url)('pngjs');

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
    const data = await readFile(join(ROOT, 'app/dist-envflow', path));
    res.writeHead(200, { 'content-type': MIME[extname(path)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end('nf'); }
});
await new Promise((ok) => server.listen(4185, '127.0.0.1', ok));
const BASE = 'http://127.0.0.1:4185';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!cond) fails++;
};

const browser = await chromium.launch();
const errors = [];

// 새 페이지 오픈: 앱 준비(__engine·__envflow) 대기 + 렌더 정착. query 예: 'hero=0&flow=1&flowsec=2'
async function open(query, { ctx } = {}) {
  const context = ctx || (await browser.newContext({ viewport: { width: 1280, height: 800 } }));
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`[console] ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
  await page.goto(`${BASE}/?${query}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__engine && window.__envflow, { timeout: 15000 });
  await sleep(1300); // 첫 렌더 + 페이드인 정착
  return { page, context };
}
const state = (page) => page.evaluate(() => window.__engine.getState());
const flowing = (page) => page.evaluate(() => window.__envflow.flowing);
const search = (page) => page.evaluate(() => location.search);
// 스크린샷 → 평균 luma(0..255). 합성 결과라 preserveDrawingBuffer 무관.
async function luma(page) {
  const buf = await page.screenshot();
  const png = PNG.sync.read(buf);
  const d = png.data; let sum = 0, n = 0;
  for (let i = 0; i < d.length; i += 4 * 37) { // 서브샘플(성능)
    sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; n++;
  }
  return sum / n;
}
async function wake(page) { // 크로마 페이드 깨우기 + 버튼 상시 노출
  await page.mouse.move(640, 700); await page.mouse.move(650, 690);
  await page.addStyleTag({ content: '.chroma{opacity:1 !important; pointer-events:auto !important;}' });
}
// 다이얼 time 링 세그먼트 중심 픽셀 계산(viewBox 200, C=100, r=82, angle: dawn -90/day 0/sunset 90/night 180).
async function dialSegPoint(page, deg) {
  const box = await page.locator('.dial svg').boundingBox();
  const s = box.width / 200, r = 82;
  const rad = (deg * Math.PI) / 180;
  return { x: box.x + box.width / 2 + r * s * Math.cos(rad), y: box.y + box.height / 2 + r * s * Math.sin(rad) };
}
// 시간·계절 사이클(고정 sleep 대신 폴링으로 전이 관측 → 병렬/소프트웨어GL 부하에 견고).
const CYCLE = ['dawn', 'day', 'sunset', 'night'];
const SEASONS = ['spring', 'summer', 'autumn'];               // 겨울 없음(#58 축)
const nextT = (t) => CYCLE[(CYCLE.indexOf(t) + 1) % 4];
const nextS = (s) => SEASONS[(SEASONS.indexOf(s) + 1) % 3];
// ms 동안 fine-poll → 연속 중복을 접은 전이 시퀀스 [{t, at}] (첫 요소 = 관측 시작 상태).
async function transitions(page, ms, step = 120) {
  const seq = []; let last = null; const end = Date.now() + ms;
  while (Date.now() < end) {
    const t = (await state(page)).time;
    if (t !== last) { seq.push({ t, at: Date.now() }); last = t; }
    await sleep(step);
  }
  return seq;
}
// 전체 env 전이 시퀀스 [{time, season, weather, at}] — time 이 바뀔 때마다 그 시점 상태 스냅.
// 랩/계절/날씨 규칙을 "관측된 전이"로 판정하기 위한 것(관측 시작 시점이 URL 초기값이라 가정하지 않음:
// 소프트웨어GL 은 로드가 끝나기 전 앱이 이미 수 초 렌더·전진하므로 시작 상태를 특정할 수 없다).
async function envSeq(page, ms, step = 120) {
  const seq = []; let lastT = null; const end = Date.now() + ms;
  while (Date.now() < end) {
    const s = await state(page);
    if (s.time !== lastT) { seq.push({ time: s.time, season: s.season, weather: s.weather, at: Date.now() }); lastT = s.time; }
    await sleep(step);
  }
  return seq;
}
// cond(state) 가 참이 될 때까지 폴링(최대 ms). 마지막 상태 반환.
async function until(page, cond, ms, step = 100) {
  const end = Date.now() + ms;
  let s = await state(page);
  while (!cond(s) && Date.now() < end) { await sleep(step); s = await state(page); }
  return s;
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n=== ① 간격 오버라이드 자동 전진 + 정확히 1스텝 불변식 + 라벨/URL 추종 ===');
{
  const { page, context } = await open('hero=0&flow=1&flowsec=2&time=dawn&season=spring&weather=clear&lang=en&seed=7');
  check('시작 상태 flowing=true', await flowing(page));
  // 고정 sleep 대신 fine-poll 로 전이 시퀀스 관측(부하에 견고). 소프트웨어GL 은 렌더 루프가
  // setTimeout 을 기아시켜 실효 케이던스가 늘어나므로(≈2배) 창을 넉넉히(12s).
  const seq = await transitions(page, 12000);
  check('자동 전진 발생(≥2 전이)', seq.length >= 3, `n=${seq.length - 1}회 [${seq.map((s) => s.t).join('→')}]`);
  // 모든 전이가 사이클 정확히 1스텝(스킵/중복/역행 없음) — 이중 전진이면 스킵으로 드러남.
  let stepBad = '';
  for (let i = 1; i < seq.length; i++) if (seq[i].t !== nextT(seq[i - 1].t)) stepBad = `${seq[i - 1].t}→${seq[i].t}`;
  check('모든 전이가 정확히 1스텝(스킵/중복/역행 없음)', !stepBad, stepBad || seq.map((s) => s.t).join('→'));
  // 인접 전이 간격 — 이중 전진이면 <1s 스파이크로 드러남(폴링 지터 감안 800ms 하한). seq[0] 은 관측
  // 시작 상태(부분 interval: acc 가 이미 일부 적산된 상태)이므로 seq[0]→seq[1] 은 온전한 전진 간격이
  // 아니다. 온전한 전진 간격은 seq[1]→seq[2] 부터(둘 다 실제 전진). 그 구간만으로 판정.
  let minGap = 1e9;
  for (let i = 2; i < seq.length; i++) minGap = Math.min(minGap, seq[i].at - seq[i - 1].at);
  check('전이 간격이 서브초 스파이크 없음(이중 예약 아님)', seq.length < 3 || minGap >= 800, `minGap=${minGap === 1e9 ? 'n/a' : minGap + 'ms'}`);
  // URL 추종(라이브 상태 기준) — 흐름을 멈추기 전에 확인.
  const q = await search(page);
  check('URL flow=1 유지', /(\?|&)flow=1(&|$)/.test(q), q);
  check('URL time override 기록됨(자동 전진 반영)', /[?&]time=(dawn|day|sunset|night)/.test(q), q);
  // 라벨 정합: 흐름이 살아있으면 다이얼 라벨(reactive ui.time)과 엔진 상태를 서로 다른 순간에 읽어
  // 최대 한 칸 어긋난다(레이스). 흐름을 멈춰 안정화한 뒤 라벨↔현재 시간 정합을 확인한다(라벨이
  // 오토로테이션 결과를 실제로 따라왔는지 = 수렴 검증).
  await page.evaluate(() => window.__envflow.toggle());
  await sleep(700); // reactive prop + 크로스페이드 라벨 반영 정착
  await wake(page);
  const cur = (await state(page)).time;
  const onLabs = await page.$$eval('.dial text.lab.on', (els) => els.map((e) => e.textContent));
  const timeLabel = { dawn: 'Dawn', day: 'Day', sunset: 'Sunset', night: 'Night' }[cur];
  check('다이얼 활성 라벨이 현재 시간과 일치', onLabs.includes(timeLabel), `on=[${onLabs}] cur=${cur}`);
  await context.close();
}

console.log('\n=== ① 크로스페이드(스냅 아님) — 전이 구간 luma 분산 ===');
{
  const { page, context } = await open('hero=0&flow=1&flowsec=4&time=night&season=autumn&weather=clear&lang=en&seed=7');
  // 첫 전진(night→dawn, 큰 밝기 변화) 발생 순간을 포착 후 세밀 샘플. 부하로 전진이 늦어질 수 있어 넉넉히.
  const t0 = (await state(page)).time;
  const deadline = Date.now() + 12000;
  while ((await state(page)).time === t0 && Date.now() < deadline) await sleep(80);
  const series = [];
  for (let i = 0; i < 11; i++) { series.push(await luma(page)); if (i < 3) await page.screenshot({ path: join(OUT, `envflow-crossfade-${i + 1}.png`) }); await sleep(180); }
  const deltas = series.slice(1).map((v, i) => Math.abs(v - series[i]));
  const total = Math.abs(series[series.length - 1] - series[0]);
  const peak = Math.max(...deltas);
  check('전이가 실제로 발생(luma 총변화 > 6)', total > 6, `total=${total.toFixed(1)}`);
  // 소프트웨어GL 저fps 에선 스크린샷 간격 사이에 트윈이 성큼 진행돼 peak 비중이 흔들린다.
  // 스냅의 시그니처는 "정확히 한 델타에 변화 전부"(peak≈1.0, 유의 델타 1개) — 그것만 배제한다.
  const sig = deltas.filter((d) => d > total * 0.02).length;
  check('스냅 아님(peak<90% & 유의 델타 ≥2 — 복수 프레임에 분산)', peak / total < 0.9 && sig >= 2,
    `peak/total=${(peak / total).toFixed(2)} sig=${sig}`);
  await context.close();
}

console.log('\n=== ② 하루 한 바퀴 랩 → 계절 전진 / 비-랩 스텝엔 계절 불변 ===');
{
  // 관측된 전이 시퀀스로 판정 — 시작 상태를 URL 초기값이라 가정하지 않는다(소프트웨어GL 은 로드가
  // 끝나기 전 앱이 이미 여러 스텝 전진하므로 시작점이 고정되지 않음). flowsec=2·창 14s 면 랩
  // (night→dawn)·비랩이 여러 번 관측된다. 불변식: 랩마다 계절 +1(nextS), 비랩마다 계절 불변.
  const { page, context } = await open('hero=0&flow=1&flowsec=2&time=night&season=spring&weather=clear&lang=en&seed=7');
  const seq = await envSeq(page, 14000);
  let stepBad = '', wrapSeen = 0, wrapBad = '', nonwrapSeen = 0, nonwrapBad = '';
  for (let i = 1; i < seq.length; i++) {
    const a = seq[i - 1], b = seq[i];
    if (b.time !== nextT(a.time)) stepBad = `${a.time}→${b.time}`;
    if (a.time === 'night' && b.time === 'dawn') { wrapSeen++; if (b.season !== nextS(a.season)) wrapBad = `${a.season}→${b.season}`; }
    else { nonwrapSeen++; if (b.season !== a.season) nonwrapBad = `${a.time}/${a.season}→${b.time}/${b.season}`; }
  }
  const path = seq.map((s) => `${s.time}/${s.season[0]}`).join('→');
  check('모든 시간 전이가 정확히 1스텝(스킵/역행 없음)', !stepBad, stepBad || path);
  check('night→dawn 랩에서 계절 정확히 1칸 전진', wrapSeen >= 1 && !wrapBad, wrapBad || `랩 ${wrapSeen}회 [${path}]`);
  check('비-랩 스텝에선 계절 불변(조기 전진 없음)', nonwrapSeen >= 1 && !nonwrapBad, nonwrapBad || `비랩 ${nonwrapSeen}회`);
  await context.close();
}

console.log('\n=== ② 눈 정리(가을 밖) + 비 유지 ===');
{
  // 초기 autumn+snow 는 랩(autumn→spring)에서 눈→맑음 정리되는 일회성 이벤트 → 이 이벤트를 실제로
  // 관측하려면 관측 시작 시점에 아직 초기 autumn 이어야 한다. flowsec=6 은 로드 중(렌더된 시간 기준)
  // 첫 전진 전에 관측이 시작되게 하는 하한(실측: obs-start=night/autumn/snow 보존). 랩 전후 상태로 판정.
  const { page, context } = await open('hero=0&flow=1&flowsec=6&time=night&season=autumn&weather=snow&lang=en&seed=7');
  const seq = await envSeq(page, 18000);
  const w = seq.findIndex((s, i) => i > 0 && seq[i - 1].season === 'autumn' && s.season === 'spring');
  const pre = w > 0 ? seq[w - 1] : null, post = w > 0 ? seq[w] : null;
  check('가을→봄 전진', !!post && post.season === 'spring', post ? post.season : 'no-wrap');
  check('가을 밖으로 나가며 눈→맑음 정리', !!pre && pre.weather === 'snow' && post.weather === 'clear', pre ? `${pre.weather}→${post.weather}` : 'no-wrap');
  check('URL weather=clear 반영', (await search(page)).includes('weather=clear'));
  await context.close();
}
{
  const { page, context } = await open('hero=0&flow=1&flowsec=6&time=night&season=autumn&weather=rain&lang=en&seed=7');
  const seq = await envSeq(page, 18000);
  const w = seq.findIndex((s, i) => i > 0 && seq[i - 1].season === 'autumn' && s.season === 'spring');
  const post = w > 0 ? seq[w] : null;
  check('비는 계절 전진에도 유지(사용자 설정 존중)', !!post && post.season === 'spring' && post.weather === 'rain', post ? `${post.season}/${post.weather}` : 'no-wrap');
  await context.close();
}

console.log('\n=== ③ 수동 다이얼 변경 → 타이머 리셋, 모드 유지 ===');
{
  // flowsec=4 로 리셋 검증 창(간격의 50%=2.0s)과 실제 전진(리셋 후 4.0s 렌더시간, 벽시계로는 그 이상
  // — 흐름 클록은 표시된 프레임만 적산)의 마진을 넉넉히(≥~1.9s) 둔다. 부하 지터에 견고.
  const IV = 4000;
  const { page, context } = await open(`hero=0&flow=1&flowsec=${IV / 1000}&time=dawn&season=autumn&weather=clear&lang=en&seed=7`);
  await wake(page);
  const p = await dialSegPoint(page, 90); // sunset(하단)
  await page.mouse.click(p.x, p.y);
  await sleep(150);
  const tm = (await state(page)).time;
  const tClick = Date.now();
  check('수동 다이얼 클릭이 시간 변경(→sunset)', tm === 'sunset', tm);
  // 리셋 검증: 간격의 50%(2.0s) 동안 전진이 없어야 한다(클릭이 흐름 클록을 0 으로 리셋).
  let held = true;
  while (Date.now() - tClick < IV * 0.5) { await sleep(100); if ((await state(page)).time !== tm) held = false; }
  check('수동 직후 간격 내 자동 전진 없음(타이머 리셋)', held, (await state(page)).time);
  check('수동 개입 후에도 flowing 유지(모드 유지)', await flowing(page));
  check('마을 아님(집 모드 유지)', !(await page.evaluate(() => window.__engine.village.getState().active)));
  // 리셋된 클록 만료 → 이후 정확히 1스텝 전진(sunset→night). 부하 스톨 지연 감안 넉넉히.
  const after = await until(page, (s) => s.time !== tm, 12000);
  check('리셋 타이머 만료 후 전진(sunset→night)', after.time === 'night', after.time);
  await context.close();
}

console.log('\n=== ④ 토글 URL 왕복 ===');
{
  // 4a: flow=1 URL 을 새 컨텍스트에 로드 → 복원 + 자동 흐름 재개(전이 폴링)
  const { page, context } = await open('hero=0&flow=1&flowsec=2&time=dawn&season=spring&weather=clear&lang=en&seed=7', { ctx: await browser.newContext({ viewport: { width: 1280, height: 800 } }) });
  check('공유 URL 로드 시 flowing 복원=true', await flowing(page));
  const s0 = await state(page);
  const cur = await until(page, (s) => s.time !== s0.time, 6000);
  check('로드 후 자동 흐름 재개(전이 발생)', cur.time !== s0.time, `${s0.time}→${cur.time}`);
  check('재개 첫 전이는 정확히 1스텝', cur.time === nextT(s0.time), `${s0.time}→${cur.time}`);
  await context.close();
}
{
  // 4b: flow 없는 로드 → 토글 켜면 URL flow=1 기록, 끄면 제거
  const { page, context } = await open('hero=0&time=dawn&lang=en&seed=7');
  check('flow 없이 로드 시 flowing=false', !(await flowing(page)));
  check('초기 URL 에 flow 없음', !/[?&]flow=1/.test(await search(page)));
  await wake(page);
  await page.click('.env-flow');
  await sleep(120);
  check('토글 켬 → flowing=true', await flowing(page));
  check('토글 켬 → URL flow=1 기록', /[?&]flow=1/.test(await search(page)), await search(page));
  await page.click('.env-flow');
  await sleep(120);
  check('토글 끔 → flowing=false', !(await flowing(page)));
  check('토글 끔 → URL flow 제거', !/[?&]flow=1/.test(await search(page)), await search(page));
  await context.close();
}

console.log('\n=== ⑤ ?shot=1 완전 정지(결정론) ===');
{
  // weather=clear 고정 — seed 7 은 configFromSeed 상 눈이라 shot 모드에서도 눈 입자가 luma 를
  // 흔든다(오토로테이션과 무관·기존 동작). clear 로 고정해야 "픽셀 불변" 검사가 의미를 가진다.
  const { page, context } = await open('shot=1&flow=1&flowsec=1&time=day&season=spring&weather=clear&lang=en&seed=7');
  check('shot 에서 flowing 강제 false', !(await flowing(page)));
  const t0 = (await state(page)).time;
  const l0 = await luma(page);
  await page.screenshot({ path: join(OUT, 'envflow-shot.png') });
  // 버튼 클릭해도 무동작(toggleFlow 가 shot 에서 return). 오토로테이션은 정지여야 한다.
  await wake(page);
  await page.click('.env-flow').catch(() => {});
  // 3.2s 동안 여러 샘플 → l0 대비 최대 편차. 임계 4.0 은 앰비언트 노이즈 플로어(모트#32·등롱
  // 흔들림·FXAA — shot 모드에서도 엔진이 계속 돌리는, 오토로테이션과 무관한 미세 움직임) 위에 둔
  // 값이다. 실측: shot day/clear 씬의 8샘플 최대 편차 ≈2.4. 반면 실제 시간 전진 1스텝은 luma 를
  // 30↑ 바꾼다(①크로스페이드 total>6 게이트, 실측 36). 즉 4.0 은 노이즈는 통과·전진 누수는 확실히 검출.
  const samples = [l0];
  for (let i = 0; i < 4; i++) { await sleep(800); samples.push(await luma(page)); }
  const drift = Math.max(...samples.map((v) => Math.abs(v - l0)));
  check('shot: 토글 클릭해도 flowing false 유지', !(await flowing(page)));
  check('shot: 시간 불변(자동 전진 없음)', (await state(page)).time === t0, `${t0}→${(await state(page)).time}`);
  check('shot: 픽셀(luma) 불변(앰비언트 노이즈 이내)', drift < 4.0, `maxΔ=${drift.toFixed(2)}`);
  await context.close();
}

console.log('\n=== ⑥ 데스크톱 + 모바일 배치 ===');
{
  const { page, context } = await open('hero=0&flow=1&time=sunset&season=autumn&lang=ko&seed=7');
  await wake(page);
  await sleep(300);
  await page.screenshot({ path: join(OUT, 'envflow-desktop.png') });
  const roll = await page.locator('.env-roll').boundingBox();
  const flow = await page.locator('.env-flow').boundingBox();
  const overlap = !(roll.x + roll.width <= flow.x || flow.x + flow.width <= roll.x);
  check('데스크톱: 두 버튼 가로 겹침 없음', !overlap, `roll@${roll.x.toFixed(0)} flow@${flow.x.toFixed(0)}`);
  check('데스크톱: 버튼이 뷰포트 안', flow.x >= 0 && flow.x + flow.width <= 1280 && flow.y + flow.height <= 800);
  await context.close();
}
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  const { page, context } = await open('hero=0&flow=1&time=sunset&season=autumn&lang=ko&seed=7', { ctx });
  await wake(page);
  await sleep(300);
  await page.screenshot({ path: join(OUT, 'envflow-mobile.png') });
  const roll = await page.locator('.env-roll').boundingBox();
  const flow = await page.locator('.env-flow').boundingBox();
  const overlap = !(roll.x + roll.width <= flow.x || flow.x + flow.width <= roll.x);
  check('모바일: 두 버튼 겹침 없음', !overlap);
  check('모바일: 흐르기 터치 타깃 ≥44px', flow.width >= 44 && flow.height >= 44, `${flow.width}x${flow.height}`);
  check('모바일: 리롤 터치 타깃 ≥44px', roll.width >= 44 && roll.height >= 44, `${roll.width}x${roll.height}`);
  check('모바일: 버튼이 뷰포트 안(우측 이탈 없음)', flow.x + flow.width <= 390 && roll.x >= 0);
  await context.close();
}

console.log('\n=== (+) 마을 모드 자동 전진 ===');
{
  const { page, context } = await open('village=1&flow=1&flowsec=2&time=dawn&weather=clear&lang=en&seed=7&vseed=7');
  // 마을 생성이 무거우니 active 를 먼저 폴링 대기.
  await page.waitForFunction(() => window.__engine?.village?.getState?.().active, { timeout: 15000 }).catch(() => {});
  check('마을 진입 + flowing=true', await flowing(page) && (await page.evaluate(() => window.__engine.village.getState().active)));
  // 마을 생성 + GPU 프리워밍은 소프트웨어GL 에서 수 초간 프레임을 스톨시킨다. 흐름 클록은 스톨
  // 프레임을 흐름 시간에서 제외하므로(의도: 프리징 동안 시간이 흐르지 않음) 그 구간엔 전진이 없다.
  // 생성이 정착해 프레임이 다시 흐르기 시작하면 적산이 재개되며 전진한다 → 창을 넉넉히(22s) 둔다.
  const t0 = (await state(page)).time;
  const cur = await until(page, (s) => s.time !== t0, 22000);
  check('마을 모드에서 시간 자동 전진', cur.time !== t0, `${t0}→${cur.time}`);
  await page.screenshot({ path: join(OUT, 'envflow-village.png') });
  await context.close();
}

console.log('\n=== ⑦ 콘솔/페이지 에러 ===');
check('콘솔/페이지 에러 0', errors.length === 0, errors.slice(0, 6).join(' | '));

await browser.close();
server.close();
console.log(`\n${fails === 0 ? '✅ ALL PASS' : `❌ ${fails} FAIL`}`);
process.exit(fails === 0 ? 0 : 1);
