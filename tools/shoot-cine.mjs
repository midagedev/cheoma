// #30 마을 감상 모드(드론·도보) 현행 품질 캡처 하네스.
//
// 판정 게이트가 아니라 **증거 수집기**다. 실제 제품 경로(Svelte SPA, post 컴포저 ON, sunset 역광)를
// 격리 vite dev 서버에서 부팅하고 `engine.cine` 을 실시간 rAF 재생시켜 프레임과 수치 로그를 남긴다.
// 통과/실패를 선언하지 않는다 — 미감 판정은 사람/비전 에이전트가 프레임을 보고 한다.
//
// 왜 실시간 재생인가: 드론 패스에는 t 시크 API 가 없다(`cinematic-runtime.js` 는 `debugAdvance()` 로
// 현재 패스를 강제 완주시킬 뿐 임의 t 로 점프하지 못한다). 그래서 t 는 폴링으로 관측하고, 목표 t 에
// 도달한 프레임에서 엔진을 정지(`debugSetPaused`)한 뒤 그 프레임을 다시 그려(`debugRenderDofFrame`)
// 캡처한다. 정지 중에는 in-page 프로브가 샘플을 버려(hold) 프레임타임 통계가 오염되지 않는다.
//
// 시간 절약: 각 드론 패스는 `cine.start('drone', { pass })` 로 단독 재생하고 t=0.8 캡처 직후
// `cine.stop()` 한다(패스 꼬리 20% 는 대기하지 않는다). 그래도 authored duration 이 그대로 흐르므로
// 전체 실행은 부팅 2회 + 재생 약 2.5분 수준이다.
//
// 사용:
//   node tools/run-browser-locked.mjs -- node tools/shoot-cine.mjs [필터...]
//   필터는 시나리오 id 부분일치: drone-village / drone-capital / walk-village / walk-capital
//   CHEOMA_CINE_OUT 으로 출력 디렉터리 변경, CHEOMA_CINE_TIMEOUT_MS 로 페이지 타임아웃 변경.
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createServer } from '../app/node_modules/vite/dist/node/index.js';
import { launchVerificationBrowser, reportWebGLRenderer } from './lib/verification-browser.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const APP_ROOT = join(ROOT, 'app');
const OUT = process.env.CHEOMA_CINE_OUT
  || '/private/tmp/claude-501/-Users-hckim-orca-workspaces-asiahouse-starfish/ab438db7-9318-4b2b-9d67-2426f5d51f63/scratchpad/cine';
const timeout = Number(process.env.CHEOMA_CINE_TIMEOUT_MS) || 120_000;
const filters = process.argv.slice(2).filter((arg) => !arg.startsWith('-'));

// 규모별 부팅 쿼리. 집 시드(seed)를 고정해 sunset 룩 롤이 재현되게 한다(시드에서 굴리면 회차마다 색이 변한다).
// worker=0 은 워커 스테일/비결정 변수를 제거하기 위한 것으로 픽셀에는 영향이 없다.
const SCALES = {
  village: { vseed: 20260716, query: 'vscale=village&vpalace=0&vtemple=0' },
  capital: { vseed: 7, query: 'vscale=capital&vpalace=1&vtemple=1' },
};
// 드론 패스 시나리오. 캡처 t 지점은 진입·중반·이탈 직전.
const T_POINTS = [0.2, 0.5, 0.8];
const SCENARIOS = [
  { id: 'drone-village', mode: 'drone', scale: 'village', passes: ['crane-in', 'street-flythrough', 'landmark-orbit', 'pullback-reveal'] },
  { id: 'drone-capital', mode: 'drone', scale: 'capital', passes: ['landmark-orbit', 'street-flythrough'] },
  // 도보는 벽시계 오프셋 캡처(자동산책에 진행률 개념이 없다). 마지막 지점은 골목 진입 이후를 노린다.
  { id: 'walk-village', mode: 'walk', scale: 'village', marks: [2, 10, 20, 30] },
  { id: 'walk-capital', mode: 'walk', scale: 'capital', marks: [3, 14, 25] },
];

const selected = SCENARIOS.filter((s) => !filters.length || filters.some((f) => s.id.includes(f)));
if (!selected.length) throw new Error(`no scenario matches ${JSON.stringify(filters)}`);

const runtimeErrors = [];
const frames = [];   // { file, scenario, mode, pass, scale, t, seconds, cam, walker }
const metrics = [];  // { scenario, pass, ...수치 진단 }
const notes = [];

// ── in-page 프로브 ── 매 rAF 마다 카메라/패스/도보 상태와 프레임 델타를 기록한다.
// hold 중(엔진 정지·스크린샷)에는 버려 프레임타임 p95 가 캡처 오버헤드를 세지 않게 한다.
const PROBE = () => {
  window.__cineProbe = { on: false, hold: false, samples: [] };
  let last = performance.now();
  const tick = () => {
    requestAnimationFrame(tick);
    const now = performance.now();
    const dt = now - last;
    last = now;
    const probe = window.__cineProbe;
    const engine = window.__engine;
    if (!probe || !probe.on || probe.hold || !engine || !engine.cine) return;
    let state;
    let cam;
    let walker;
    try {
      state = engine.cine.getState();
      cam = engine.cine.debugCam();
      walker = engine.cine.debugWalker();
    } catch { return; }
    if (!state.active) return;
    probe.samples.push({
      ms: +dt.toFixed(2),
      t: state.t,
      pass: state.pass,
      turn: state.turnRateDeg,
      x: cam.pos.x, y: cam.pos.y, z: cam.pos.z,
      fov: cam.fov,
      finite: cam.finite && cam.targetFinite,
      clr: walker ? walker.clearance : null,
      coll: walker ? walker.colliding : null,
      out: walker ? walker.outside : null,
      ta: walker ? walker.turnarounds : null,
    });
  };
  requestAnimationFrame(tick);
};

const quantile = (sorted, q) => {
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[index];
};
const round = (value, digits = 3) => (value == null || !Number.isFinite(value) ? null : +value.toFixed(digits));

// 프로브 샘플 → 수치 진단. 수직 저크는 프레임간 |Δy| 의 최대치와 그 초당 환산(m/s)을 함께 본다.
function summarize(samples) {
  if (!samples.length) return { count: 0 };
  let maxDy = 0; let maxDyAt = null; let maxDyRate = 0;
  let maxDfov = 0;
  let maxTurn = 0;
  let nonFinite = 0;
  let colliding = 0;
  let outside = 0;
  let clrMin = Infinity; let clrMax = -Infinity; let clrSum = 0; let clrCount = 0;
  const ms = [];
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    if (!s.finite) nonFinite++;
    if (s.turn > maxTurn) maxTurn = s.turn;
    if (s.clr != null) {
      clrCount++; clrSum += s.clr;
      if (s.clr < clrMin) clrMin = s.clr;
      if (s.clr > clrMax) clrMax = s.clr;
    }
    if (s.coll) colliding++;
    if (s.out) outside++;
    if (i > 0) {
      const prev = samples[i - 1];
      ms.push(s.ms);
      const dy = Math.abs(s.y - prev.y);
      if (dy > maxDy) { maxDy = dy; maxDyAt = s.t; }
      const rate = s.ms > 0 ? dy / (s.ms / 1000) : 0;
      if (rate > maxDyRate) maxDyRate = rate;
      const dfov = Math.abs(s.fov - prev.fov);
      if (dfov > maxDfov) maxDfov = dfov;
    }
  }
  const sortedMs = ms.slice().sort((a, b) => a - b);
  const fovs = samples.map((s) => s.fov);
  return {
    count: samples.length,
    maxDy: round(maxDy), maxDyAt: maxDyAt, maxDyRate: round(maxDyRate, 2),
    fovMin: round(Math.min(...fovs), 2), fovMax: round(Math.max(...fovs), 2), maxDfov: round(maxDfov),
    maxTurnDeg: round(maxTurn, 2),
    frameMsP50: round(quantile(sortedMs, 0.5), 2),
    frameMsP95: round(quantile(sortedMs, 0.95), 2),
    frameMsMax: round(sortedMs[sortedMs.length - 1], 2),
    nonFinite,
    clrMin: clrCount ? round(clrMin) : null,
    clrMax: clrCount ? round(clrMax) : null,
    clrMean: clrCount ? round(clrSum / clrCount) : null,
    collidingFrames: colliding,
    outsideFrames: outside,
    turnarounds: samples[samples.length - 1].ta,
  };
}

await mkdir(OUT, { recursive: true });
const server = await createServer({
  root: APP_ROOT,
  configFile: join(APP_ROOT, 'vite.config.js'),
  cacheDir: join(OUT, '.vite-cache'),
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false },
});

let browser;
const started = Date.now();
try {
  await server.listen();
  const port = server.httpServer.address().port;
  const base = `http://127.0.0.1:${port}`;
  browser = await launchVerificationBrowser();
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  page.setDefaultTimeout(timeout);
  await page.addInitScript(PROBE);
  page.on('pageerror', (error) => runtimeErrors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' && !/favicon|404|Failed to load resource/i.test(message.text())) {
      runtimeErrors.push(`console: ${message.text()}`);
    }
  });

  async function loadScale(scale) {
    const conf = SCALES[scale];
    const url = `${base}/?hero=0&village=1&worker=0&seed=20260718&vseed=${conf.vseed}`
      + `&${conf.query}&time=sunset&weather=clear&season=summer&lang=ko`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    await page.waitForFunction(
      () => window.__SHOT_READY === true && window.__engine?.village?.getState()?.active === true,
      null,
      { timeout },
    );
    // 감상 모드는 진입 베일·웨이브·히어로 조립이 모두 끝난 뒤에만 시작할 수 있다(available()).
    await page.waitForFunction(() => window.__engine.cine.available() === true, null, { timeout });
    // .chroma 페이드는 시네마틱 중 자동 은퇴하지만, 캡처가 그 트랜지션에 걸리지 않도록 확실히 숨긴다.
    await page.addStyleTag({ content: '.chroma { visibility: hidden !important; }' });
    await reportWebGLRenderer(page, scale);
    return page.evaluate(() => window.__engine.cine.passList());
  }

  // 정지 → 그 프레임 재렌더 → 캡처 → 재개. 프로브는 hold 로 이 구간을 통계에서 제외한다.
  async function capture(file, meta) {
    const info = await page.evaluate(() => {
      const engine = window.__engine;
      window.__cineProbe.hold = true;
      engine.debugSetPaused(true);
      engine.debugRenderDofFrame(0);
      return {
        state: engine.cine.getState(),
        cam: engine.cine.debugCam(),
        walker: engine.cine.debugWalker(),
      };
    });
    await page.screenshot({ path: join(OUT, file) });
    await page.evaluate(() => {
      window.__engine.debugSetPaused(false);
      window.__cineProbe.hold = false;
    });
    frames.push({ file, ...meta, state: info.state, cam: info.cam, walker: info.walker });
    return info;
  }

  const startProbe = () => page.evaluate(() => {
    window.__cineProbe.samples.length = 0;
    window.__cineProbe.hold = false;
    window.__cineProbe.on = true;
  });
  const stopProbe = () => page.evaluate(() => {
    window.__cineProbe.on = false;
    return window.__cineProbe.samples;
  });

  // 감상 모드 종료 후 부감 복귀 트윈(1.0~1.3s)이 끝나기를 기다린다. 다음 start() 가 트윈을
  // 취소하긴 하지만, 취소 시점의 카메라를 물려받으므로 다음 패스의 첫 프레임이 오염된다.
  async function settleAfterStop() {
    await page.evaluate(() => window.__engine.cine.stop());
    await page.waitForTimeout(1700);
    await page.waitForFunction(() => window.__engine.cine.available() === true, null, { timeout });
  }

  async function runDronePass(scenario, passName, duration) {
    const ok = await page.evaluate((name) => window.__engine.cine.start('drone', { pass: name }), passName);
    const state = await page.evaluate(() => window.__engine.cine.getState());
    if (!ok || state.pass !== passName || state.single !== passName) {
      notes.push(`${scenario.id}/${passName}: start 거부 또는 패스 불일치 (ok=${ok}, state=${JSON.stringify(state)})`);
      return;
    }
    await startProbe();
    for (const t of T_POINTS) {
      await page.waitForFunction((target) => {
        const live = window.__engine.cine.getState();
        return !live.active || live.t >= target;
      }, t, { timeout });
      const live = await page.evaluate(() => window.__engine.cine.getState());
      if (!live.active) {
        notes.push(`${scenario.id}/${passName}: t=${t} 도달 전에 패스가 종료됨`);
        break;
      }
      const tag = String(Math.round(t * 100)).padStart(3, '0');
      await capture(`drone-${passName}-${scenario.scale}-t${tag}.png`, {
        scenario: scenario.id, mode: 'drone', pass: passName, scale: scenario.scale, t, duration,
      });
    }
    const samples = await stopProbe();
    metrics.push({ scenario: scenario.id, label: `${passName} (${duration}s)`, ...summarize(samples) });
    await settleAfterStop();
  }

  async function runWalk(scenario) {
    const ok = await page.evaluate(() => window.__engine.cine.start('walk'));
    if (!ok) {
      notes.push(`${scenario.id}: walk start 거부`);
      return;
    }
    await startProbe();
    let elapsed = 0;
    for (const [index, mark] of scenario.marks.entries()) {
      await page.waitForTimeout(Math.max(0, (mark - elapsed) * 1000));
      elapsed = mark;
      const live = await page.evaluate(() => window.__engine.cine.getState());
      if (!live.active) {
        notes.push(`${scenario.id}: ${mark}s 전에 walk 종료됨`);
        break;
      }
      await capture(`walk-${scenario.scale}-${index + 1}.png`, {
        scenario: scenario.id, mode: 'walk', pass: 'autoStroll', scale: scenario.scale, seconds: mark,
      });
    }
    const samples = await stopProbe();
    metrics.push({ scenario: scenario.id, label: `autoStroll (${elapsed}s)`, ...summarize(samples) });
    await settleAfterStop();
  }

  // 규모별로 한 번만 부팅하고 그 규모의 시나리오를 순서대로 돈다(부팅 비용 절감).
  // walk 는 camera.near 를 0.08 로 내리고 종료 후에도 복원하지 않으므로 항상 드론 뒤에 둔다.
  const passListByScale = {};
  for (const scale of Object.keys(SCALES)) {
    const group = selected.filter((s) => s.scale === scale);
    if (!group.length) continue;
    console.log(`\n=== ${scale} 부팅 (vseed=${SCALES[scale].vseed}) ===`);
    passListByScale[scale] = await loadScale(scale);
    console.log(`passList: ${JSON.stringify(passListByScale[scale])}`);
    for (const scenario of group.sort((a, b) => (a.mode === b.mode ? 0 : a.mode === 'drone' ? -1 : 1))) {
      console.log(`--- ${scenario.id}`);
      if (scenario.mode === 'drone') {
        for (const passName of scenario.passes) {
          const found = passListByScale[scale].find((p) => p.name === passName);
          if (!found) {
            notes.push(`${scenario.id}: 패스 ${passName} 가 passList 에 없음`);
            continue;
          }
          console.log(`    ${passName} duration=${found.duration}s`);
          await runDronePass(scenario, passName, found.duration);
        }
      } else {
        await runWalk(scenario);
      }
    }
  }

  // ── MANIFEST ──
  const lines = [];
  lines.push('# 감상 모드 캡처 (#30)');
  lines.push('');
  lines.push(`- 생성: ${new Date().toISOString()} · 소요 ${Math.round((Date.now() - started) / 1000)}s`);
  lines.push('- 하네스: `tools/shoot-cine.mjs` (판정 없음 — 프레임·수치 증거만)');
  lines.push('- 경로: 실제 앱(post ON, time=sunset, season=summer, weather=clear, worker=0, seed=20260718)');
  lines.push(`- 뷰포트 1600×900 dsf1 · 시나리오 ${selected.map((s) => s.id).join(', ')}`);
  for (const [scale, list] of Object.entries(passListByScale)) {
    lines.push(`- ${scale} (vseed=${SCALES[scale].vseed}) passList: ${list.map((p) => `${p.name} ${p.duration}s`).join(' · ')}`);
  }
  lines.push('');
  lines.push('## 프레임');
  lines.push('');
  lines.push('| 파일 | 시나리오 | 패스 | t / s | pos (x,y,z) | fov | look | turn°/s |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const frame of frames) {
    const at = frame.mode === 'drone' ? `t=${frame.state.t}` : `${frame.seconds}s`;
    const pos = `${frame.cam.pos.x}, ${frame.cam.pos.y}, ${frame.cam.pos.z}`;
    const look = `${frame.cam.look.x}, ${frame.cam.look.y}, ${frame.cam.look.z}`;
    lines.push(`| ${frame.file} | ${frame.scenario} | ${frame.pass} | ${at} | ${pos} | ${frame.cam.fov} | ${look} | ${frame.state.turnRateDeg} |`);
  }
  lines.push('');
  lines.push('## 드론 수치 진단');
  lines.push('');
  lines.push('| 시나리오 | 패스 | 프레임 | 최대 프레임간 Δy (m) @t | Δy 속도 (m/s) | fov 범위 | 최대 Δfov | 최대 turn°/s | frame ms p50 / p95 / max | 비유한 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const m of metrics.filter((x) => x.scenario.startsWith('drone'))) {
    lines.push(`| ${m.scenario} | ${m.label} | ${m.count} | ${m.maxDy} @${m.maxDyAt} | ${m.maxDyRate} | ${m.fovMin}–${m.fovMax} | ${m.maxDfov} | ${m.maxTurnDeg} | ${m.frameMsP50} / ${m.frameMsP95} / ${m.frameMsMax} | ${m.nonFinite} |`);
  }
  lines.push('');
  lines.push('## 도보 수치 진단');
  lines.push('');
  lines.push('| 시나리오 | 구간 | 프레임 | groundClearance min/mean/max (m) | 최대 turn°/s | 충돌 프레임 | 경계이탈 프레임 | 반환수 | frame ms p50 / p95 / max |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const m of metrics.filter((x) => x.scenario.startsWith('walk'))) {
    lines.push(`| ${m.scenario} | ${m.label} | ${m.count} | ${m.clrMin} / ${m.clrMean} / ${m.clrMax} | ${m.maxTurnDeg} | ${m.collidingFrames} | ${m.outsideFrames} | ${m.turnarounds} | ${m.frameMsP50} / ${m.frameMsP95} / ${m.frameMsMax} |`);
  }
  lines.push('');
  lines.push('## 도보 위치 로그');
  lines.push('');
  for (const frame of frames.filter((f) => f.mode === 'walk')) {
    lines.push(`- ${frame.file} @${frame.seconds}s — pos ${JSON.stringify(frame.walker?.pos)} clearance ${frame.walker?.clearance} eye ${frame.walker?.eyeHeight} colliding ${frame.walker?.colliding} outside ${frame.walker?.outside} turnarounds ${frame.walker?.turnarounds}`);
  }
  lines.push('');
  lines.push('## 특이사항');
  lines.push('');
  if (!notes.length) lines.push('- 없음');
  for (const note of notes) lines.push(`- ${note}`);
  lines.push('');
  lines.push('## 런타임 에러');
  lines.push('');
  if (!runtimeErrors.length) lines.push('- 없음');
  for (const error of runtimeErrors) lines.push(`- ${error}`);
  lines.push('');
  await writeFile(join(OUT, 'MANIFEST.md'), `${lines.join('\n')}\n`, 'utf8');
  await writeFile(join(OUT, 'cine-frames.json'), `${JSON.stringify({ frames, metrics, notes, runtimeErrors }, null, 2)}\n`, 'utf8');

  console.log(`\n프레임 ${frames.length}장 → ${OUT}`);
  console.log(`특이사항 ${notes.length}건 · 런타임 에러 ${runtimeErrors.length}건`);
  for (const note of notes) console.log(`  NOTE ${note}`);
  for (const error of runtimeErrors) console.log(`  ERROR ${error}`);
} finally {
  await browser?.close();
  await server.close();
}
