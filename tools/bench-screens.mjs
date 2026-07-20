// #109 파트A: 화면·전환별 성능 벤치마크 (계측 전용 — src 무수정).
// 클린 빌드 app/dist-bench 를 전용 포트 4232 로 구동, window.__engine/__hero 훅으로 시나리오를 구동한다.
// 두 축으로 계측한다:
//   (1) 정상상태/애니메이션 프레임 매끄러움 — 페이지측 rAF 델타 시계열(push 만). p95/p99 중심(절대 fps
//       과신 금지; 헤드리스 GPU·호스트 경합 편차 큼). max·>100ms 갭은 상대·이벤트정렬로만 신뢰.
//   (2) 재생성·익스포트 동기 블로킹 — 페이지 내 performance.now() 로 그 호출 자체의 메인스레드 정지
//       시간을 직접 측정(프레임 샘플링·경합 무관, 결정적). "rAF 정지 최장 구간" 의 진짜 값.
// 사용법: node tools/bench-screens.mjs [only=S1,S9]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..');
const DIST = join(ROOT, 'app', 'dist-bench');
const PORT = 4232;
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.glb': 'model/gltf-binary',
};
const server = createServer(async (req, res) => {
  const path = decodeURIComponent(req.url.split('?')[0]);
  try {
    const file = join(DIST, path === '/' ? 'index.html' : path);
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise((ok) => server.listen(PORT, '127.0.0.1', ok));

// ── 페이지측 수집기 ─────────────────────────────────────────────────────────
const INIT = () => {
  window.__bench = {
    gap: { max: 0, last: 0, c50: 0, c100: 0, n: 0, active: false,
      reset() { this.max = 0; this.c50 = 0; this.c100 = 0; this.n = 0; this.last = performance.now(); this.active = true; },
      read() { this.active = false; return { max: +this.max.toFixed(1), c50: this.c50, c100: this.c100, frames: this.n }; } },
  };
  (function g() {
    requestAnimationFrame(g);
    const o = window.__bench.gap; const n = performance.now();
    if (o.active && o.last) { const d = n - o.last; o.n++; if (d > o.max) o.max = d; if (d > 50) o.c50++; if (d > 100) o.c100++; }
    o.last = n;
  })();
  const snap = () => {
    const e = window.__engine, h = window.__hero; let wave = false, cine = false, dist = 0;
    try { wave = !!(e && e.village && e.village.isWaving && e.village.isWaving()); } catch (_) {}
    try { cine = !!(e && e.cine && e.cine.isActive && e.cine.isActive()); } catch (_) {}
    return { asm: h ? !!h.heroAsm : false, trans: h ? !!h.transitioning : false,
      sel: h ? (h.selected == null ? '-' : String(h.selected)) : '-', wave, cine };
  };
  window.__benchRun = (durMs, opts) => new Promise((res) => {
    opts = opts || {};
    const buf = [], events = []; let last = performance.now(); const t0 = last; let prev = snap();
    const loop = () => {
      const now = performance.now(); const dt = now - last; last = now;
      buf.push([+(now - t0).toFixed(1), +dt.toFixed(2)]);
      const s = snap(); const ch = [];
      for (const k in s) if (s[k] !== prev[k]) ch.push(k + '=' + s[k]);
      if (ch.length) { events.push([+(now - t0).toFixed(1), ch.join(' ')]); prev = s; }
      if (opts.orbitDps) { try {
        const cam = window.__engine.camera, tg = window.__engine.__controls.target;
        const dx = cam.position.x - tg.x, dz = cam.position.z - tg.z, r = Math.hypot(dx, dz);
        const ang = Math.atan2(dx, dz) + opts.orbitDps * (dt / 1000) * Math.PI / 180;
        cam.position.x = tg.x + r * Math.sin(ang); cam.position.z = tg.z + r * Math.cos(ang);
        cam.lookAt(tg.x, tg.y, tg.z);
      } catch (_) {} }
      if (opts.dolly) { const d = opts.dolly; const k = Math.min(1, (now - t0) / d.rampMs); const frac = d.from + (d.to - d.from) * k;
        try { window.__engine.village.debugDolly(frac, d.parcelId); } catch (_) {} }
      if (now - t0 < durMs) requestAnimationFrame(loop); else res({ buf, events });
    };
    if (opts.actions) for (const a of opts.actions) setTimeout(() => { try { (new Function(a[1]))(); } catch (err) { (window.__benchErr = window.__benchErr || []).push(a[1] + ' :: ' + err); } }, a[0]);
    requestAnimationFrame(loop);
  });
  // 동기 블로킹 직접 측정: 코드 1회 실행의 메인스레드 정지 시간(ms). 애니 트윈은 비동기라 미포함.
  window.__blockMs = (code) => { const t = performance.now(); let err = null; try { (new Function(code))(); } catch (e) { err = String(e); } return { ms: +(performance.now() - t).toFixed(1), err }; };
};

// ── node측 통계 ────────────────────────────────────────────────────────────
function stats(buf) {
  let dts = buf.map((x) => x[1]).filter((x) => x > 0 && x < 30000);
  if (dts.length > 2) dts = dts.slice(1);
  const n = dts.length; if (!n) return null;
  const sorted = [...dts].sort((a, b) => a - b); const sum = dts.reduce((a, b) => a + b, 0);
  const pick = (p) => sorted[Math.min(n - 1, Math.floor(n * p))];
  return { frames: n, avg: +(sum / n).toFixed(1), fps: +(1000 / (sum / n)).toFixed(0),
    p50: +pick(0.5).toFixed(1), p95: +pick(0.95).toFixed(1), p99: +pick(0.99).toFixed(1),
    max: +sorted[n - 1].toFixed(1), long: dts.filter((x) => x > 50).length, hitch: dts.filter((x) => x > 100).length };
}
function hitches(run, thr = 100) {
  const evs = run.events || [];
  const nearest = (to) => { let e = null; for (const ev of evs) { if (ev[0] <= to) e = ev; else break; } return e ? `${e[1]}@${e[0]}` : '-'; };
  return run.buf.filter((x) => x[1] > thr).map((x) => ({ t: x[0], ms: x[1], phase: nearest(x[0]) }));
}
const fmt = (s) => s ? `p50 ${s.p50} p95 ${s.p95} p99 ${s.p99} max ${s.max} | avg ${s.avg}(${s.fps}f) long>50:${s.long} hitch>100:${s.hitch} (${s.frames}f)` : 'n/a';

// ── 브라우저 ──────────────────────────────────────────────────────────────
let browser;
const launchArgs = ['--use-angle=default', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'];
try { browser = await chromium.launch({ channel: 'chrome', args: launchArgs }); }
catch { browser = await chromium.launch({ args: launchArgs }); }
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
await page.addInitScript(INIT);
let pageErrs = 0, consoleErrs = 0;
page.on('pageerror', (e) => { pageErrs++; console.error('[pageerror]', e.message); });
page.on('console', (m) => { if (m.type() === 'error') { const t = m.text(); if (/favicon|404|Failed to load resource/.test(t)) return; consoleErrs++; if (consoleErrs <= 8) console.error('[console]', t.slice(0, 200)); } });

const wait = (ms) => page.waitForTimeout(ms);
const run = (durMs, opts) => page.evaluate(({ d, o }) => window.__benchRun(d, o), { d: durMs, o: opts || {} });
const ev = (fn, arg) => page.evaluate(fn, arg);
const blockMs = async (code) => (await page.evaluate((c) => window.__blockMs(c), code));
const gapReset = () => ev(() => window.__bench.gap.reset());
const gapRead = () => ev(() => window.__bench.gap.read());
const results = {}; const allHitch = []; const blocks = {};

async function boot(qs) {
  await page.goto(`http://127.0.0.1:${PORT}/${qs}`, { waitUntil: 'load' });
  await page.waitForFunction('!!window.__engine', null, { timeout: 30000 });
}
function record(label, run, thr = 100) {
  const s = stats(run.buf); results[label] = s;
  const hs = hitches(run, thr); for (const h of hs) allHitch.push({ scenario: label, ...h });
  console.log(`\n[${label}] ${fmt(s)}`);
  if (run.events && run.events.length) console.log('  ev:', run.events.map((e) => `${e[0]}:${e[1]}`).slice(0, 12).join(' | '));
  if (hs.length) console.log('  hitch:', hs.slice(0, 8).map((h) => `${h.t}ms:+${h.ms}[${h.phase}]`).join('  '));
  return s;
}
const worseOf = (a, b) => { if (!a) return b; if (!b) return a; const sa = stats(a.buf), sb = stats(b.buf); return (sb.p95 > sa.p95) ? b : a; };

const only = (process.argv.find((a) => a.startsWith('only=')) || '').slice(5).split(',').filter(Boolean);
const want = (id) => !only.length || only.includes(id);
const V = '?village=1&vseed=20260716&lang=ko';

// ═══════════════ S1 히어로 랜딩(부팅→조립 종료) — 2회, 나쁜 쪽 ═══════════════
if (want('S1')) {
  console.log('\n════════ S1 HERO LANDING ════════');
  let worst = null;
  for (let rep = 0; rep < 2; rep++) {
    await boot('?seed=42&vseed=20260716&lang=ko');
    await wait(1500);
    await page.mouse.move(640, 400); await wait(80);
    await ev(() => document.querySelector('.hero') && document.querySelector('.hero').click());
    const r = await run(11000, {}); // 랜딩 시퀀스(리빌·조립·정착) 관측, 유휴꼬리 제외
    console.log(`  rep${rep}: ${fmt(stats(r.buf))}`);
    worst = worseOf(worst, r); await wait(400);
  }
  record('S1 hero-landing', worst);
}

// ═══════════════ S2 부감 궤도 (village / hanyang) — 각 2회 ═══════════════
if (want('S2')) {
  console.log('\n════════ S2 AERIAL ORBIT ════════');
  let worst = null;
  for (let rep = 0; rep < 2; rep++) { await boot(V); await wait(2500); const r = await run(9000, { orbitDps: 14 }); console.log(`  village rep${rep}: ${fmt(stats(r.buf))}`); worst = worseOf(worst, r); await wait(300); }
  record('S2 orbit-village', worst);
  worst = null;
  for (let rep = 0; rep < 2; rep++) {
    await boot('?village=1&vscale=hanyang&vpalace=1&vseed=20260716&lang=ko'); await wait(3500);
    if (rep === 0) console.log('  hanyang plan:', JSON.stringify(await ev(() => window.__engine.village.debugPlan())));
    const r = await run(9000, { orbitDps: 14 }); console.log(`  hanyang rep${rep}: ${fmt(stats(r.buf))}`); worst = worseOf(worst, r); await wait(300);
  }
  record('S2 orbit-hanyang', worst);
}

// ═══════════════ S3 zoom 연속체 (부감→근접 휠줌 + focus-in 트윈) ═══════════════
if (want('S3') || want('S4') || want('S8h')) {
  await boot(V); await wait(2500);
  const heroId = await ev(() => window.__engine.village.heroId());
  const parcels = await ev(() => window.__engine.village.debugParcels());
  if (want('S3')) {
    console.log('\n════════ S3 ZOOM CONTINUUM (부감→근접) ════════');
    const cont0 = await ev(() => window.__engine.village.debugContinuum());
    const r = await run(6000, { dolly: { parcelId: heroId, from: 1.0, to: 0.14, rampMs: 1800 } });
    console.log('  continuum(before):', JSON.stringify(cont0), ' after selected=', await ev(() => window.__engine.village.getState().selected));
    record('S3 zoom-continuum', r);
  } else { await ev((id) => window.__engine.village.focus(id), heroId); await wait(2600); }

  // ═══════════════ S4 필지 hop (집→집 직접 전환) ×3 ═══════════════
  if (want('S4')) {
    console.log('\n════════ S4 PARCEL HOP ×3 ════════');
    await page.waitForFunction('window.__engine.village.getState().selected != null', null, { timeout: 8000 }).catch(() => {});
    const editable = parcels.filter((p) => p.editable).map((p) => p.parcelId);
    const sel = await ev(() => window.__engine.village.getState().selected);
    const targets = editable.filter((id) => id !== sel).slice(0, 3);
    while (targets.length < 3) targets.push(editable[targets.length % editable.length]);
    const sw = (id) => `window.__engine.village.switchTo(${JSON.stringify(id)})`;
    const acts = [[400, sw(targets[0])], [2400, sw(targets[1])], [4400, sw(targets[2])]];
    const r = await run(6600, { actions: acts });
    console.log('  hop targets:', targets.join(','), 'from', sel);
    record('S4 hop-x3', r);
  }

  // ═══════════════ S8(house) glb 익스포트 — focus 필지 ═══════════════
  if (want('S8h') || want('S8')) {
    console.log('\n════════ S8a GLB EXPORT house (focus) ════════');
    await page.waitForFunction('window.__engine.village.getState().selected != null', null, { timeout: 8000 }).catch(() => {});
    const hasFocus = await ev(() => window.__glb.hasFocus());
    await gapReset();
    const rr = await page.evaluate(async () => { const t = performance.now(); const res = await window.__glb.exportHouse(); return { ms: +(performance.now() - t).toFixed(1), res }; });
    const g = await gapRead();
    console.log(`  hasFocus=${hasFocus} wall=${rr.ms}ms rAFgap(max/c50/c100/frames)=${g.max}/${g.c50}/${g.c100}/${g.frames} res=${JSON.stringify(rr.res)}`);
    blocks['S8a glb-house'] = { wallMs: rr.ms, gapMax: g.max, extra: rr.res };
  }
}

// ═══════════════ S8(village) glb 익스포트 — 부감 마을 전체 ═══════════════
if (want('S8') || want('S8v')) {
  console.log('\n════════ S8b GLB EXPORT village (aerial) ════════');
  await boot(V); await wait(2600);
  const analyze = await ev(() => window.__glb.analyzeVillage());
  await gapReset();
  const rr = await page.evaluate(async () => { const t = performance.now(); const res = await window.__glb.exportVillage(); return { ms: +(performance.now() - t).toFixed(1), res }; });
  const g = await gapRead();
  console.log(`  analyze=${JSON.stringify(analyze)}`);
  console.log(`  wall=${rr.ms}ms rAFgap(max/c50/c100/frames)=${g.max}/${g.c50}/${g.c100}/${g.frames} res=${JSON.stringify(rr.res)}`);
  blocks['S8b glb-village'] = { wallMs: rr.ms, gapMax: g.max, extra: rr.res };
}

// ═══════════════ S5 리롤 웨이브 (해체→재생성→조립) — 2회 ═══════════════
if (want('S5')) {
  console.log('\n════════ S5 REROLL WAVE ════════');
  let worst = null;
  for (let rep = 0; rep < 2; rep++) {
    await boot(V); await wait(2600);
    const r = await run(12000, { actions: [[300, 'window.__engine.village.rerollWave()']] });
    console.log(`  rep${rep}: ${fmt(stats(r.buf))}`);
    worst = worseOf(worst, r); await wait(300);
  }
  record('S5 reroll-wave', worst);
}

// ═══════════════ S6 env 크로스페이드 (시간·계절·날씨) ═══════════════
if (want('S6')) {
  console.log('\n════════ S6 ENV CROSSFADE ════════');
  await boot(V); await wait(2600);
  // 각각: 블로킹(setter 자체) + 크로스페이드 애니 프레임.
  for (const [label, code] of [
    ['time sunset→night', "window.__engine.setTime('night')"],
    ['season summer→autumn', "window.__engine.setSeason('autumn')"],
    ['weather clear→snow', "window.__engine.setWeather('snow')"],
  ]) {
    await gapReset();
    const b = await blockMs(code);
    const r = await run(3200, {});
    const g = await gapRead();
    const s = stats(r.buf);
    console.log(`  [${label}] setterBlock=${b.ms}ms | crossfade ${fmt(s)} (gapMax ${g.max})`);
    results['S6 ' + label] = s; blocks['S6 ' + label] = { wallMs: b.ms, gapMax: g.max };
    const hs = hitches(r); for (const h of hs) allHitch.push({ scenario: 'S6 ' + label, ...h });
    await wait(400);
  }
}

// ═══════════════ S7 시네마틱 (드론 체인 + 1인칭 walk) ═══════════════
if (want('S7')) {
  console.log('\n════════ S7 CINEMATIC ════════');
  await boot(V); await wait(2600);
  console.log('  drone passes:', JSON.stringify(await ev(() => window.__engine.cine.passList())));
  // 드론: 오토플레이 체인. 각 패스 진입 + 전환점 관측(강제 advance 로 전환 히치 유도).
  const rDrone = await run(18000, { actions: [
    [200, "window.__engine.cine.start('drone')"],
    [4500, 'window.__engine.cine.debugAdvance()'],
    [9000, 'window.__engine.cine.debugAdvance()'],
    [13000, 'window.__engine.cine.debugAdvance()'],
  ] });
  record('S7 cine-drone', rDrone);
  await ev(() => window.__engine.cine.stop()); await wait(1500);
  // 1인칭 walk autoStroll 15s.
  const rWalk = await run(15000, { actions: [[200, "window.__engine.cine.start('walk')"], [500, 'window.__engine.cine.setAutoStroll(true)']] });
  record('S7 cine-walk', rWalk);
  console.log('  walker end:', JSON.stringify(await ev(() => window.__engine.cine.debugWalker())));
  await ev(() => window.__engine.cine.stop());
}

// ═══════════════ S9 규모 슬라이더 커밋 (village→capital) — 블로킹 직접 측정 ═══════════════
if (want('S9')) {
  console.log('\n════════ S9 SCALE COMMIT village→capital ════════');
  await boot(V); await wait(2600);
  const before = await ev(() => window.__engine.village.debugPlan());
  await gapReset();
  const b = await blockMs("window.__engine.village.setOpts({ scale:'capital' })");
  const r = await run(2500, {}); // 커밋 직후 트윈/프리워밍 프레임
  const g = await gapRead();
  const after = await ev(() => window.__engine.village.debugPlan());
  console.log(`  before houses=${before.houses}(${before.scale}) → after houses=${after.houses}(${after.scale})`);
  console.log(`  setOpts BLOCK(재생성 메인스레드 정지)=${b.ms}ms  rAFgapMax=${g.max}ms  postFrames ${fmt(stats(r.buf))}`);
  blocks['S9 scale village→capital'] = { wallMs: b.ms, gapMax: g.max };
  // 추가: capital→hanyang(최대) 커밋도 참고 측정
  await gapReset();
  const b2 = await blockMs("window.__engine.village.setOpts({ scale:'hanyang' })");
  await run(1500, {}); const g2 = await gapRead();
  console.log(`  (참고) capital→hanyang BLOCK=${b2.ms}ms rAFgapMax=${g2.max}ms`);
  blocks['S9b scale capital→hanyang'] = { wallMs: b2.ms, gapMax: g2.max };
}

// ═══════════════ S10 solo (외딴집) — 경량 기준선 ═══════════════
if (want('S10')) {
  console.log('\n════════ S10 SOLO (외딴집 기준선) ════════');
  await boot(V); await wait(2600);
  await gapReset();
  const b = await blockMs("window.__engine.village.setOpts({ scale:'solo' })");
  await wait(1600);
  const dp = await ev(() => window.__engine.village.debugPlan());
  const r = await run(6000, { orbitDps: 14 });
  console.log(`  solo plan houses=${dp.houses} siteR=${dp.siteR} | setOpts BLOCK=${b.ms}ms`);
  record('S10 solo-orbit', r);
}

// ── 요약 ──
console.log('\n\n════════════════ SUMMARY: 정상상태/애니 프레임 ════════════════');
console.log('(p50/p95/p99 = 프레임 델타 ms; 낮을수록 매끄러움. max·hitch 는 호스트 경합 오염 가능 — 상대·이벤트정렬만 신뢰)');
for (const [k, s] of Object.entries(results)) console.log(`${(k + '                             ').slice(0, 30)} ${fmt(s)}`);
console.log('\n════════════════ SUMMARY: 동기 블로킹(메인스레드 정지) ════════════════');
console.log('(wallMs = 그 호출 1회의 메인스레드 정지 시간; gapMax = 그 구간 최장 rAF 공백)');
for (const [k, b] of Object.entries(blocks)) console.log(`${(k + '                             ').slice(0, 30)} wall=${b.wallMs}ms gapMax=${b.gapMax}ms${b.extra ? ' ' + JSON.stringify(b.extra) : ''}`);
console.log(`\nhitch(>100ms) total across scenarios: ${allHitch.length}   pageErr=${pageErrs} consoleErr=${consoleErrs}`);
const be = await ev(() => window.__benchErr || []);
if (be.length) console.log('benchErr:', be.slice(0, 8));
await browser.close();
server.close();
