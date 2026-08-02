// #36 드론 투어 셰이더 링크 히치 — 투어 중 프로그램 수 증가 0 계약 (미등록 standalone).
//
// 원인(확정): warmShaders 가 진입 부감 카메라 상태로만 신규 서브트리를 데워, 드론 저공 FULL LOD
//   스왑·근접 디테일 재질이 첫 드로우에서 지연 링크된다. 판정은 frame ms 가 아니라
//   renderer.info.programs 길이 델타만(헤드리스 ANGLE 링크 직렬화 → wall ms 무효).
//
// 규모: village · hanyang. 비트: far-approach(t≥0.60), rooftop-glide(t≥0.25) —
//   용량-반응 실측 hitch 지점(t0.60 / t0.219)을 덮는다.
//
// 실행:
//   node tools/run-browser-locked.mjs -- node tools/check-cine-warm.mjs
// FAIL-first 확인(수정 전): 위 명령이 FAIL 하고 programsMaxJump ≥ 1 을 보고해야 한다.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from '../app/node_modules/vite/dist/node/index.js';
import { launchVerificationBrowser, reportWebGLRenderer } from './lib/verification-browser.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const APP_ROOT = join(ROOT, 'app');
const cacheDir = await mkdtemp(join(tmpdir(), 'cheoma-cine-warm-'));
const timeout = Number(process.env.CHEOMA_CINE_WARM_TIMEOUT_MS) || 300_000;

// 실측 hitch 지점(+여유). 패스 단독 재생 후 해당 t 에 도달하면 샘플 종료.
const SCALES = [
  {
    id: 'village',
    vseed: 20260716,
    query: 'vscale=village&vpalace=0&vtemple=0',
  },
  {
    id: 'hanyang',
    vseed: 2026,
    query: 'vscale=hanyang&vpalace=1&vtemple=1',
  },
];
const PASSES = [
  { name: 'far-approach', untilT: 0.60 },
  { name: 'rooftop-glide', untilT: 0.25 },
];

const failures = [];
function pass(condition, message) {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${message}`);
  if (!condition) failures.push(message);
}

const server = await createServer({
  root: APP_ROOT,
  configFile: join(APP_ROOT, 'vite.config.js'),
  cacheDir,
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false },
});

let browser;
const runtimeErrors = [];
try {
  await server.listen();
  const port = server.httpServer.address().port;
  const base = `http://127.0.0.1:${port}`;
  browser = await launchVerificationBrowser();
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  page.setDefaultTimeout(timeout);
  page.on('pageerror', (error) => runtimeErrors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' && !/favicon|404|Failed to load resource/i.test(message.text())) {
      runtimeErrors.push(`console: ${message.text()}`);
    }
  });

  // rAF 프로브 — shoot-cine 와 동일 계약(active 구간만 샘플, hold 중 제외).
  await page.addInitScript(() => {
    window.__cineWarmProbe = { on: false, hold: false, samples: [], warm: null, jumps: [] };
    let last = performance.now();
    let prevProg = -1;
    let prevKeySet = null;
    const tick = () => {
      requestAnimationFrame(tick);
      const now = performance.now();
      const dt = now - last;
      last = now;
      const probe = window.__cineWarmProbe;
      const engine = window.__engine;
      if (!probe?.on || probe.hold || !engine?.cine) return;
      let state;
      try { state = engine.cine.getState(); } catch { return; }
      if (!state.active) return;
      let programs = -1;
      try { programs = engine.village.debugProgramCount(); } catch {}
      let warmPending = false;
      try {
        const w = engine.cine.debugWarm?.();
        warmPending = !!(w && w.pending);
      } catch {}
      // warm hold 구간은 투어 전 예열 — 투어 중 델타 단언에서 제외.
      if (warmPending) return;
      if (programs >= 0 && prevProg >= 0 && programs > prevProg) {
        const keys = (engine.renderer.info.programs || []).map((p) => p.cacheKey || '');
        const added = prevKeySet
          ? keys.filter((k) => !prevKeySet.has(k))
          : [];
        probe.jumps.push({
          t: state.t,
          from: prevProg,
          to: programs,
          camY: +engine.camera.position.y.toFixed(2),
          added: added.map((k) => {
            const c = k.match(/cheoma-[a-z0-9|-]+/i);
            return `${k.split(',').slice(0, 2).join(',')} :: ${c ? c[0] : k.slice(-48)}`;
          }),
        });
        prevKeySet = new Set(keys);
      } else if (programs >= 0) {
        prevKeySet = new Set((engine.renderer.info.programs || []).map((p) => p.cacheKey || ''));
      }
      if (programs >= 0) prevProg = programs;
      probe.samples.push({
        programs,
        ms: +dt.toFixed(2),
        t: state.t,
        pass: state.pass,
      });
    };
    requestAnimationFrame(tick);
  });

  async function loadScale(scale) {
    const url = `${base}/?hero=0&village=1&worker=0&seed=20260718&vseed=${scale.vseed}`
      + `&${scale.query}&time=sunset&weather=clear&season=summer&lang=ko`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    await page.waitForFunction(
      () => window.__SHOT_READY === true && window.__engine?.village?.getState()?.active === true,
      null,
      { timeout },
    );
    await page.waitForFunction(() => window.__engine.cine.available() === true, null, { timeout });
    await page.addStyleTag({ content: '.chroma { visibility: hidden !important; }' });
    await reportWebGLRenderer(page, `cine-warm/${scale.id}`);
    // 부감 진입 warm·reveal 정착. Chrome 은 링크 완료 프로그램을 몇 rAF 뒤에
    // info.programs 에 붙이므로, 짧은 settle 은 투어 중 거짓 점프(+1~2)를 만든다.
    await page.evaluate(() => new Promise((resolve) => {
      let prev = -1;
      let stable = 0;
      let frames = 0;
      const step = () => {
        frames += 1;
        const n = window.__engine.village.debugProgramCount();
        stable = n === prev ? stable + 1 : 0;
        prev = n;
        if (stable >= 18 || frames >= 90) resolve(n);
        else requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }));
  }

  async function runPass(scaleId, passSpec) {
    const started = await page.evaluate((name) => {
      const engine = window.__engine;
      window.__cineWarmProbe.samples.length = 0;
      window.__cineWarmProbe.hold = false;
      window.__cineWarmProbe.on = true;
      window.__cineWarmProbe.warm = null;
      const ok = engine.cine.start('drone', { pass: name });
      const state = engine.cine.getState();
      return { ok, pass: state.pass, single: state.single, programs: engine.village.debugProgramCount() };
    }, passSpec.name);

    if (!started.ok || started.pass !== passSpec.name) {
      pass(false, `${scaleId}/${passSpec.name}: cine.start rejected (ok=${started.ok}, pass=${started.pass})`);
      return null;
    }

    // warm hold 해제 + 프로그램 목록 settle 까지 대기. warm 직후 목록에 늦게 붙는
    // 항목이 투어 샘플에 섞이면 거짓 FAIL 이 된다.
    await page.waitForFunction(() => {
      const engine = window.__engine;
      const w = engine.cine.debugWarm?.();
      if (w && w.pending) return false;
      const state = engine.cine.getState();
      return state.active === true;
    }, null, { timeout: 60_000 }).catch(() => {});

    await page.evaluate(() => new Promise((resolve) => {
      let prev = window.__engine.village.debugProgramCount();
      let stable = 0;
      let frames = 0;
      const step = () => {
        frames += 1;
        const n = window.__engine.village.debugProgramCount();
        stable = n === prev ? stable + 1 : 0;
        prev = n;
        if (stable >= 12 || frames >= 60) resolve(n);
        else requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }));

    // settle 구간 샘플은 버리고, 투어 진행 구간만 측정한다.
    await page.evaluate(() => {
      window.__cineWarmProbe.samples.length = 0;
      window.__cineWarmProbe.jumps.length = 0;
    });

    const afterWarm = await page.evaluate(() => {
      const engine = window.__engine;
      return {
        programs: engine.village.debugProgramCount(),
        warm: engine.cine.debugWarm?.() || null,
        t: engine.cine.getState().t,
      };
    });

    // 목표 t 도달 또는 패스 종료.
    await page.waitForFunction((untilT) => {
      const live = window.__engine.cine.getState();
      return !live.active || live.t >= untilT;
    }, passSpec.untilT, { timeout });

    const summary = await page.evaluate(() => {
      window.__cineWarmProbe.on = false;
      const samples = window.__cineWarmProbe.samples.slice();
      const liveJumps = window.__cineWarmProbe.jumps.slice();
      let progMin = Infinity;
      let progMax = -Infinity;
      let progJump = 0;
      let progJumpAt = null;
      let progJumpPass = null;
      for (let i = 0; i < samples.length; i++) {
        const s = samples[i];
        if (s.programs < 0) continue;
        if (s.programs < progMin) progMin = s.programs;
        if (s.programs > progMax) progMax = s.programs;
        if (i > 0) {
          const prev = samples[i - 1];
          if (prev.programs >= 0 && s.programs - prev.programs > progJump) {
            progJump = s.programs - prev.programs;
            progJumpAt = s.t;
            progJumpPass = s.pass;
          }
        }
      }
      return {
        count: samples.length,
        programsMin: Number.isFinite(progMin) ? progMin : null,
        programsMax: progMax >= 0 ? progMax : null,
        programsMaxJump: progJump,
        programsMaxJumpAt: progJumpAt,
        programsMaxJumpPass: progJumpPass,
        liveJumps,
        tFinal: samples.length ? samples[samples.length - 1].t : null,
        warm: window.__engine.cine.debugWarm?.() || null,
      };
    });

    await page.evaluate(() => window.__engine.cine.stop());
    // 부감 복귀 트윈이 다음 start 를 오염시키지 않게 짧게 대기.
    await page.waitForTimeout(400);
    await page.waitForFunction(() => window.__engine.cine.available() === true, null, { timeout: 30_000 });

    return { started, afterWarm, summary };
  }

  console.log('check-cine-warm (#36 drone tour program growth)\n');

  for (const scale of SCALES) {
    console.log(`\n=== ${scale.id} (vseed=${scale.vseed}) ===`);
    await loadScale(scale);
    const bootPrograms = await page.evaluate(() => window.__engine.village.debugProgramCount());
    console.log(`  boot programs=${bootPrograms}`);

    for (const passSpec of PASSES) {
      const result = await runPass(scale.id, passSpec);
      if (!result) continue;
      const { summary, afterWarm, started } = result;
      console.log(
        `  ${passSpec.name}: samples=${summary.count}`
        + ` programs ${summary.programsMin}→${summary.programsMax}`
        + ` jump=+${summary.programsMaxJump}`
        + (summary.programsMaxJumpAt != null ? ` @t=${summary.programsMaxJumpAt}` : '')
        + ` startPrograms=${started.programs} afterWarm=${afterWarm.programs}`
        + (summary.warm
          ? ` warm={rafs:${summary.warm.rafs}, Δprog:${summary.warm.programsWarmed}, pending:${summary.warm.pending}}`
          : ' warm=n/a'),
      );
      if (summary.liveJumps?.length) {
        console.log(`    liveJumps: ${JSON.stringify(summary.liveJumps)}`);
      }

      pass(summary.count >= 8,
        `${scale.id}/${passSpec.name}: collected ≥8 in-tour samples (got ${summary.count})`);
      pass(summary.tFinal == null || summary.tFinal >= passSpec.untilT * 0.9,
        `${scale.id}/${passSpec.name}: reached t≈${passSpec.untilT} (tFinal=${summary.tFinal})`);
      // 투어 중(warm hold 제외) 프로그램 수 증가 0.
      pass(summary.programsMaxJump === 0,
        `${scale.id}/${passSpec.name}: tour program growth 0 `
          + `(jump=+${summary.programsMaxJump}`
          + (summary.programsMaxJumpAt != null
            ? ` @t=${summary.programsMaxJumpAt}`
            : '')
          + `, range ${summary.programsMin}→${summary.programsMax})`);
    }
  }

  pass(runtimeErrors.length === 0,
    `no runtime errors (${runtimeErrors.length}: ${runtimeErrors.slice(0, 3).join(' | ')})`);
} finally {
  await browser?.close().catch(() => {});
  await server.close().catch(() => {});
  await rm(cacheDir, { recursive: true, force: true }).catch(() => {});
}

if (failures.length) {
  console.error(`\nCINE WARM: FAIL (${failures.length})`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('\nCINE WARM: PASS');
