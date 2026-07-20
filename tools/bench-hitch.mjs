// #125 전환 히치 프로파일러 — CDP CPU 프로파일로 전환 시나리오별 히치를 함수 단위로 귀속한다.
// 계측 전용(src 무수정). unminified 프로파일 빌드(app/dist-prof, `vite build --outDir dist-prof
// --minify false`)를 전용 포트로 구동해야 함수명이 살아 귀속표가 의미를 가진다.
//
// 두 축:
//   (1) 페이지측 rAF 델타 — 전환 창에서 히치(>50/>100ms) 발생 여부·최장 갭(존재 증명).
//   (2) CDP Profiler 셀프타임 — 그 창 동안 메인스레드를 붙든 함수(귀속). 100ms 빈 타임라인으로
//       "언제" 스파이크가 났는지도 잡고, 가장 바쁜 빈의 top 함수를 따로 뽑아 정밀 귀속한다.
//
// 사용법: node tools/bench-hitch.mjs [only=T1,T3]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..');
const DIST = join(ROOT, 'app', 'dist-prof');
const PORT = 4247;
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

const INIT = () => {
  window.__gap = { max: 0, last: 0, c50: 0, c100: 0, n: 0, active: false,
    reset() { this.max = 0; this.c50 = 0; this.c100 = 0; this.n = 0; this.last = performance.now(); this.active = true; },
    read() { this.active = false; return { max: +this.max.toFixed(1), c50: this.c50, c100: this.c100, frames: this.n }; } };
  (function g() {
    requestAnimationFrame(g);
    const o = window.__gap; const n = performance.now();
    if (o.active && o.last) { const d = n - o.last; o.n++; if (d > o.max) o.max = d; if (d > 50) o.c50++; if (d > 100) o.c100++; }
    o.last = n;
  })();
  window.__blockMs = (code) => { const t = performance.now(); let err = null; try { (new Function(code))(); } catch (e) { err = String(e); } return { ms: +(performance.now() - t).toFixed(1), err }; };
};

// ── 프로파일 집계 ──
function shortUrl(u) {
  if (!u) return '(native)';
  const m = u.match(/\/assets\/([^?]+)$/); if (m) return m[1];
  const m2 = u.match(/([^/?]+)$/); return m2 ? m2[1] : u;
}
function fnKey(cf) {
  const nm = cf.functionName || '(anonymous)';
  if (!cf.url) return `${nm}  <native>`;
  return `${nm}  ${shortUrl(cf.url)}:${cf.lineNumber + 1}`;
}
// 셀프타임(us) per 노드 → 함수 키 집계. + 100ms 빈 타임라인(바쁜 정도) + 최다 빈 top.
function analyze(profile) {
  const { nodes, samples, timeDeltas, startTime, endTime } = profile;
  const byId = new Map();
  for (const n of nodes) byId.set(n.id, n);
  const isIdle = (n) => { const nm = n.callFrame.functionName; return nm === '(idle)' || nm === '(program)'; };

  const selfByFn = new Map();      // key -> us
  const binMs = [];                // 100ms 빈: busy us(비-idle)
  const binTop = [];               // 빈별 함수 셀프 us
  let tcur = startTime;            // us
  let busyTotal = 0, idleTotal = 0;
  for (let i = 0; i < samples.length; i++) {
    const dt = timeDeltas[i] || 0;
    tcur += dt;
    const n = byId.get(samples[i]);
    if (!n) continue;
    const idle = isIdle(n);
    if (idle) idleTotal += dt; else busyTotal += dt;
    const key = fnKey(n.callFrame);
    if (!idle) selfByFn.set(key, (selfByFn.get(key) || 0) + dt);
    const bin = Math.floor((tcur - startTime) / 100000);   // 100ms 빈
    while (binMs.length <= bin) { binMs.push(0); binTop.push(new Map()); }
    if (!idle) { binMs[bin] += dt; const m = binTop[bin]; m.set(key, (m.get(key) || 0) + dt); }
  }
  const top = [...selfByFn].sort((a, b) => b[1] - a[1]);
  // 가장 바쁜 빈
  let bBin = 0; for (let i = 1; i < binMs.length; i++) if (binMs[i] > binMs[bBin]) bBin = i;
  const busiest = binTop[bBin] ? [...binTop[bBin]].sort((a, b) => b[1] - a[1]) : [];
  return {
    durMs: +((endTime - startTime) / 1000).toFixed(0),
    busyMs: +(busyTotal / 1000).toFixed(0), idleMs: +(idleTotal / 1000).toFixed(0),
    top, binMs: binMs.map((x) => +(x / 1000).toFixed(0)), bBin, bBinMs: +((binMs[bBin] || 0) / 1000).toFixed(0), busiest,
  };
}

let browser;
const launchArgs = ['--use-angle=default', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'];
try { browser = await chromium.launch({ channel: 'chrome', args: launchArgs }); }
catch { browser = await chromium.launch({ args: launchArgs }); }
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
await page.addInitScript(INIT);
let pageErrs = 0;
page.on('pageerror', (e) => { pageErrs++; console.error('[pageerror]', e.message); });

const client = await page.context().newCDPSession(page);
await client.send('Profiler.enable');
await client.send('Profiler.setSamplingInterval', { interval: 80 }); // us

const wait = (ms) => page.waitForTimeout(ms);
const ev = (fn, arg) => page.evaluate(fn, arg);
const V = '?village=1&vseed=20260716&lang=ko';
const NOCHECK = process.argv.includes('nocheck');   // renderer.debug.checkShaderErrors=false 실증 비교
async function boot(qs = V) {
  await page.goto(`http://127.0.0.1:${PORT}/${qs}`, { waitUntil: 'load' });
  await page.waitForFunction('!!window.__engine', null, { timeout: 30000 });
  if (NOCHECK) await ev(() => { try { window.__engine.renderer.debug.checkShaderErrors = false; } catch (_) {} });
}

// 프로파일된 액션 실행: reset gap → Profiler.start → action → 관측창 대기 → stop.
async function profiled(label, actionCode, watchMs) {
  await ev(() => window.__gap.reset());
  await client.send('Profiler.start');
  const t0 = Date.now();
  const blk = await ev((c) => window.__blockMs(c), actionCode);   // 동기 블로킹(그 호출 자체)
  await wait(watchMs);
  const { profile } = await client.send('Profiler.stop');
  const gap = await ev(() => window.__gap.read());
  const a = analyze(profile);
  console.log(`\n──────── [${label}] ────────`);
  console.log(`  action sync-block=${blk.ms}ms${blk.err ? ' ERR=' + blk.err : ''}  | rAF gap max=${gap.max}ms  >50:${gap.c50} >100:${gap.c100} (${gap.frames}f)`);
  console.log(`  profile window=${a.durMs}ms busy=${a.busyMs}ms idle=${a.idleMs}ms  wall=${Date.now() - t0}ms`);
  console.log(`  busy/100ms-bin: [${a.binMs.join(' ')}]  ← busiest bin#${a.bBin} (${a.bBin * 100}~${a.bBin * 100 + 100}ms) = ${a.bBinMs}ms busy`);
  console.log('  ▼ top self-time (whole window):');
  for (const [k, us] of a.top.slice(0, 14)) console.log(`     ${(us / 1000).toFixed(1).padStart(7)}ms  ${k}`);
  if (a.busiest.length && a.bBinMs > 40) {
    console.log(`  ▼ top self-time (busiest bin#${a.bBin}):`);
    for (const [k, us] of a.busiest.slice(0, 8)) console.log(`     ${(us / 1000).toFixed(1).padStart(7)}ms  ${k}`);
  }
  return { gap, a, blk };
}

const only = (process.argv.find((a) => a.startsWith('only=')) || '').slice(5).split(',').filter(Boolean);
const want = (id) => !only.length || only.includes(id);

// ═══ T1 focus-in (부감→근접 줌인) ═══
if (want('T1')) {
  await boot(); await wait(2800);
  const heroId = await ev(() => window.__engine.village.heroId());
  await profiled('T1 focus-in (부감→근접, clear)', `window.__engine.village.focus(${JSON.stringify(heroId)})`, 3000);
}

// ═══ T2 hop (필지→필지 직접 전환) ═══
if (want('T2')) {
  await boot(); await wait(2800);
  const heroId = await ev(() => window.__engine.village.heroId());
  const parcels = await ev(() => window.__engine.village.debugParcels ? window.__engine.village.debugParcels() : []);
  await ev((id) => window.__engine.village.focus(id), heroId);
  await page.waitForFunction('window.__engine.village.getState().selected != null', null, { timeout: 8000 }).catch(() => {});
  await wait(2600);
  const editable = (parcels || []).filter((p) => p.editable).map((p) => p.parcelId);
  const sel = await ev(() => window.__engine.village.getState().selected);
  const target = editable.find((id) => id !== sel) ?? editable[0];
  await profiled(`T2 hop (${sel}→${target})`, `window.__engine.village.switchTo(${JSON.stringify(target)})`, 3000);
}

// ═══ T3 focus-out (근접→부감) ═══
if (want('T3')) {
  await boot(); await wait(2800);
  const heroId = await ev(() => window.__engine.village.heroId());
  await ev((id) => window.__engine.village.focus(id), heroId);
  await page.waitForFunction('window.__engine.village.getState().selected != null', null, { timeout: 8000 }).catch(() => {});
  await wait(2600);
  await profiled('T3 focus-out (근접→부감)', `window.__engine.village.return()`, 2600);
}

// ═══ T4 zoom continuum (dolly 부감→근접) ═══
if (want('T4')) {
  await boot(); await wait(2800);
  const heroId = await ev(() => window.__engine.village.heroId());
  // 연속 dolly 램프를 페이지측 rAF 루프로 구동하며 프로파일.
  const code = `(() => { const id=${JSON.stringify(heroId)}; let s=0; const t0=performance.now();
    (function d(){ const k=Math.min(1,(performance.now()-t0)/1600); const frac=1.0+(0.14-1.0)*k;
      try{ window.__engine.village.debugDolly(frac, id); }catch(e){}
      if(k<1) requestAnimationFrame(d); })(); })()`;
  await profiled('T4 zoom-continuum (dolly 1.0→0.14)', code, 3000);
}

// ═══ T5 season autumn (첫 가을 진입) ═══
if (want('T5')) {
  await boot(); await wait(2800);
  await profiled('T5 season →autumn (첫 진입)', `window.__engine.setSeason('autumn')`, 3200);
}

// ═══ T6 aerial orbit (앰비언트 필드 셀 스핀업) ═══
if (want('T6')) {
  await boot(); await wait(2800);
  // 부감에서 천천히 궤도 회전 → 카메라 앵커 필드 셀 스핀업 히치 관측.
  const code = `(() => { const e=window.__engine, tg=e.__controls.target, cam=e.camera; const t0=performance.now();
    (function o(){ const dt=16/1000; const dx=cam.position.x-tg.x, dz=cam.position.z-tg.z, r=Math.hypot(dx,dz);
      const ang=Math.atan2(dx,dz)+18*dt*Math.PI/180; cam.position.x=tg.x+r*Math.sin(ang); cam.position.z=tg.z+r*Math.cos(ang);
      cam.lookAt(tg.x,tg.y,tg.z); if(performance.now()-t0<2600) requestAnimationFrame(o); })(); })()`;
  await profiled('T6 aerial-orbit (앰비언트 필드)', code, 2800);
}

console.log(`\n\npageErr=${pageErrs}`);
await browser.close();
server.close();
