// 부감·드론 프레임의 역광 림 증거 수집기 (#35-1).
//
// 판정 게이트가 아니다 — 수치 계약은 `tools/check-rim-master.mjs`(순수)가 갖고, 이 도구는
// 브라우저에서만 확인 가능한 세 가지를 남긴다:
//   1) 살아 있는 `uRimScale` / 거리 밴드 / 커버리지 실측 (window.__rim)
//   2) 림 마스터 0 ↔ 부감 마스터 사이의 `renderer.info.programs` 델타 (유니폼 변경이므로 0 이어야 한다)
//   3) 같은 포즈의 OFF/ON 한 쌍 + 정오 프레임 (미감·수목 림 판정은 사람/비전 에이전트가 한다)
//
// 사용:
//   node tools/run-browser-locked.mjs -- node tools/shoot-rim-aerial.mjs [필터...]
//   CHEOMA_RIM_OUT 으로 출력 디렉터리 변경.
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createServer } from '../app/node_modules/vite/dist/node/index.js';
import { launchVerificationBrowser, reportWebGLRenderer } from './lib/verification-browser.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const APP_ROOT = join(ROOT, 'app');
const OUT = process.env.CHEOMA_RIM_OUT
  || '/private/tmp/claude-501/-Users-hckim-orca-workspaces-asiahouse-starfish/ab438db7-9318-4b2b-9d67-2426f5d51f63/scratchpad/rim-aerial';
const timeout = Number(process.env.CHEOMA_RIM_TIMEOUT_MS) || 180_000;
const filters = process.argv.slice(2).filter((arg) => !arg.startsWith('-'));
// 기본 worker=0(결정론 변수 제거, 픽셀 불변). 한양 동기 forest 크런치가 타임아웃을 넘길 때
//   CHEOMA_RIM_WORKER=1 로 실제 워커 경로를 쓴다 — 어느 쪽이든 림 유니폼과는 무관하다.
const workerParam = process.env.CHEOMA_RIM_WORKER === '1' ? 1 : 0;
// 유기물 위계 A/B 용 값. 제품 값은 rim.js RIM_GROUP_MUL/RIM_GROUP_POWER_MUL 이 소유하고,
//   여기서는 "피드백 이전 위계"를 같은 포즈에서 재현하기 위한 대조군만 적는다.
//   organic070 = 피드백 이전 위계. organic015 = 계수만으로 목표 루마(~10)를 맞추는 후보 —
//   실측상 프레넬 지수는 실제 수관 픽셀 대역(저 ndv)에서 거의 작동하지 않아 계수가 유일한 축이다.
const ORGANIC_VARIANTS = [
  { tag: 'organic070', label: 'organic 0.7 · power x1 (pre-vision)', mul: { organic: 0.7 }, powerMul: { organic: 1.0 } },
  { tag: 'organic015', label: 'organic 0.15 · power x1.8 (target-luma candidate)', mul: { organic: 0.15 }, powerMul: { organic: 1.8 } },
];
const PRODUCT_ORGANIC = { mul: { organic: 0.30 }, powerMul: { organic: 1.8 } };

const SCALES = {
  village: { vseed: 20260716, query: 'vscale=village&vpalace=0&vtemple=0' },
  capital: { vseed: 7, query: 'vscale=capital&vpalace=1&vtemple=1' },
  hanyang: { vseed: 2026, query: 'vscale=hanyang&vpalace=1&vtemple=1' },
};
// 시나리오: 규모 × 시간대. drone 은 실시간 재생이라 규모당 한 구간·한 지점만 잡는다.
const SCENARIOS = [
  { id: 'village-sunset', scale: 'village', time: 'sunset', drone: { pass: 'far-approach', t: 0.5 } },
  { id: 'capital-sunset', scale: 'capital', time: 'sunset', drone: { pass: 'landmark-flyby', t: 0.5 } },
  { id: 'hanyang-sunset', scale: 'hanyang', time: 'sunset', drone: { pass: 'far-approach', t: 0.5 } },
  { id: 'village-noon', scale: 'village', time: 'day' },
  { id: 'hanyang-noon', scale: 'hanyang', time: 'day' },
];

const selected = SCENARIOS.filter((s) => !filters.length || filters.some((f) => s.id.includes(f)));
if (!selected.length) throw new Error(`no scenario matches ${JSON.stringify(filters)}`);

const runtimeErrors = [];
const rows = [];   // { file, scenario, mode, master, rim, programs }
const notes = [];

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
  page.on('pageerror', (error) => runtimeErrors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' && !/favicon|404|Failed to load resource/i.test(message.text())) {
      runtimeErrors.push(`console: ${message.text()}`);
    }
  });

  async function load(scenario) {
    const conf = SCALES[scenario.scale];
    const url = `${base}/?hero=0&village=1&worker=${workerParam}&seed=20260718&vseed=${conf.vseed}`
      + `&${conf.query}&time=${scenario.time}&weather=clear&season=summer&lang=ko&post=1`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    await page.waitForFunction(
      () => window.__SHOT_READY === true && window.__engine?.village?.getState()?.active === true,
      null,
      { timeout },
    );
    // 감상 모드는 진입 베일·웨이브·히어로 조립이 모두 끝난 뒤에만 시작할 수 있다(available()).
    //   한양은 이 조건이 오래(또는 끝내) 성립하지 않을 수 있으므로 부감 증거를 잃지 않도록
    //   별도의 짧은 대기로 두고, 실패하면 그 시나리오만 드론 없이 진행한다.
    let cineReady = true;
    try {
      await page.waitForFunction(() => window.__engine.cine.available() === true, null,
        { timeout: Math.min(timeout, 90_000) });
    } catch {
      cineReady = false;
      notes.push(`${scenario.id}: cine.available() 미성립 → 부감 프레임만 캡처`);
    }
    await page.addStyleTag({ content: '.chroma { visibility: hidden !important; }' });
    // 부감 프레이밍 트윈(1.4s)과 fog 추종이 멎기를 기다린다. cine.available() 은 트윈을 보지 않아
    //   그대로 캡처하면 실행마다 카메라→피사체 거리가 230~460m 로 흔들리고(실측) 같은 규모끼리도
    //   프레임이 달라져 A/B 가 통제되지 않는다. 엔진이 매 프레임 publish 하는 거리를 그대로 읽는다.
    await page.waitForFunction(() => {
      const d = window.__rim?.viewDistance;
      if (!Number.isFinite(d) || d <= 0) return false;
      const log = (window.__rimSettle ||= []);
      log.push(d);
      if (log.length < 12) return false;
      const recent = log.slice(-12);
      return Math.max(...recent) - Math.min(...recent) < 0.5;
    }, null, { timeout: Math.min(timeout, 60_000), polling: 120 }).catch(() => {
      notes.push(`${scenario.id}: 부감 카메라가 정착하지 않음 — 포즈가 흔들릴 수 있다`);
    });
    await page.evaluate(() => { delete window.__rimSettle; });
    await reportWebGLRenderer(page, scenario.id);
    return cineReady;
  }

  // 정지 → 그 프레임 재렌더 → 캡처. 림 판독은 정지 상태에서 하므로 프레임과 값이 같은 프레임이다.
  async function capture(file, meta, master, groups = null) {
    const info = await page.evaluate(([m, g]) => {
      const engine = window.__engine;
      engine.debugSetPaused(true);
      if (Number.isFinite(m)) window.__rim.setMaster(m);
      if (g) window.__rim.setGroups(g.mul, g.powerMul);
      engine.debugRenderDofFrame(0);
      const rim = window.__rim;
      return {
        rim: {
          mode: rim.mode,
          scale: rim.scale,
          master: rim.master,
          strength: rim.strength,
          near: rim.near,
          far: rim.far,
          viewDistance: rim.viewDistance,
          patched: rim.patched,
          coverage: rim.coverage,
          groupMultipliers: rim.groupMultipliers,
          groupPowerMultipliers: rim.groupPowerMultipliers,
        },
        programs: engine.debugPostResolution?.().programs ?? null,
        camera: engine.cine.debugCam(),
      };
    }, [master, groups]);
    await page.screenshot({ path: join(OUT, file) });
    rows.push({ file, ...meta, ...info });
    return info;
  }

  // 프로그램 델타: 마스터는 유니폼이므로 0 ↔ aerial ↔ focus 를 왕복해도 프로그램이 늘면 안 된다.
  async function programSweep(scenarioId) {
    const sweep = await page.evaluate(async () => {
      const engine = window.__engine;
      const read = () => engine.debugPostResolution().programs;
      const step = (m) => {
        window.__rim.setMaster(m);
        engine.debugRenderDofFrame(0);
        return read();
      };
      const out = { start: read(), steps: [] };
      for (const m of [0, 0.75, 1, 0.75, 0]) out.steps.push([m, step(m)]);
      // enable 축도 같은 확인(패스 폴백이 아닌 fresnel 경로는 uRimScale 만 움직인다).
      window.__rim.setEnabled(false); engine.debugRenderDofFrame(0);
      out.disabled = read();
      window.__rim.setEnabled(true); engine.debugRenderDofFrame(0);
      out.reenabled = read();
      return out;
    });
    notes.push(`${scenarioId} programs: start=${sweep.start} `
      + sweep.steps.map(([m, p]) => `master${m}=${p}`).join(' ')
      + ` disabled=${sweep.disabled} reenabled=${sweep.reenabled}`);
    return sweep;
  }

  async function runScenario(scenario) {
    console.log(`\n=== ${scenario.id} ===`);
    const cineReady = await load(scenario);
    const suffix = scenario.time === 'day' ? 'noon' : 'sunset';

    // 제품이 실제로 적용한 부감 마스터(정책 경로가 세팅한 값). A/B 의 ON 쪽 기준이다.
    const productMaster = await page.evaluate(() => window.__rim.master);
    console.log(`  product aerial master = ${productMaster}`);
    // 부감 A/B: 같은 포즈에서 림 OFF(구 정책의 0) ↔ 제품 부감 마스터.
    const on = await capture(`aerial-${scenario.scale}-${suffix}-rimaerial.png`,
      { scenario: scenario.id, mode: 'aerial', label: `aerial master ${productMaster}` }, productMaster);
    const off = await capture(`aerial-${scenario.scale}-${suffix}-rim000.png`,
      { scenario: scenario.id, mode: 'aerial', label: 'master 0 (shipped policy)' }, 0);
    // 같은 포즈에서 유기물 위계만 바꾼 A/B 프레임들. 부감 포즈가 부팅마다 미세하게 달라 실행 간
    //   픽셀 비교가 통제되지 않으므로 통제 변인을 한 포즈 안에서 확보한다. 이후 제품 값으로 복원.
    for (const variant of ORGANIC_VARIANTS) {
      await capture(`aerial-${scenario.scale}-${suffix}-${variant.tag}.png`,
        { scenario: scenario.id, mode: 'aerial', label: variant.label },
        productMaster, { mul: variant.mul, powerMul: variant.powerMul });
    }
    await page.evaluate((g) => window.__rim.setGroups(g.mul, g.powerMul), PRODUCT_ORGANIC);
    console.log(`  aerial: viewDistance=${on.rim.viewDistance?.toFixed?.(1)} band=${on.rim.near?.toFixed?.(1)}/${on.rim.far?.toFixed?.(1)} `
      + `scale=${on.rim.scale} strength=${on.rim.strength?.toFixed?.(4)} patched=${on.rim.patched} (off scale=${off.rim.scale})`);
    await programSweep(scenario.id);
    // sweep 이 마스터를 굴렸으므로 제품 값으로 복원하고 재개한다.
    await page.evaluate((m) => {
      window.__rim.setMaster(m);
      window.__engine.debugSetPaused(false);
    }, productMaster);

    if (!scenario.drone || !cineReady) return;
    const passes = await page.evaluate(() => window.__engine.cine.passList());
    const found = passes.find((p) => p.name === scenario.drone.pass);
    if (!found) { notes.push(`${scenario.id}: ${scenario.drone.pass} 없음 (${passes.map((p) => p.name)})`); return; }
    const ok = await page.evaluate((name) => window.__engine.cine.start('drone', { pass: name }), scenario.drone.pass);
    if (!ok) { notes.push(`${scenario.id}: drone start 거부`); return; }
    console.log(`  drone ${found.name} duration=${found.duration}s → t=${scenario.drone.t}`);
    await page.waitForFunction((t) => {
      const live = window.__engine.cine.getState();
      return !live.active || live.t >= t;
    }, scenario.drone.t, { timeout });
    const live = await page.evaluate(() => window.__engine.cine.getState());
    if (!live.active) { notes.push(`${scenario.id}: t 도달 전 종료`); return; }
    const droneOn = await capture(`drone-${scenario.drone.pass}-${scenario.scale}-${suffix}.png`, {
      scenario: scenario.id, mode: 'drone', label: `${scenario.drone.pass} t=${scenario.drone.t} · master ${productMaster}`,
    }, productMaster);
    console.log(`  drone: viewDistance=${droneOn.rim.viewDistance?.toFixed?.(1)} band=${droneOn.rim.near?.toFixed?.(1)}/${droneOn.rim.far?.toFixed?.(1)} `
      + `scale=${droneOn.rim.scale} strength=${droneOn.rim.strength?.toFixed?.(4)}`);
    await capture(`drone-${scenario.drone.pass}-${scenario.scale}-${suffix}-rim000.png`, {
      scenario: scenario.id, mode: 'drone', label: `${scenario.drone.pass} t=${scenario.drone.t} · master 0`,
    }, 0);
    for (const variant of ORGANIC_VARIANTS) {
      await capture(`drone-${scenario.drone.pass}-${scenario.scale}-${suffix}-${variant.tag}.png`, {
        scenario: scenario.id, mode: 'drone', label: `${scenario.drone.pass} t=${scenario.drone.t} · ${variant.label}`,
      }, productMaster, { mul: variant.mul, powerMul: variant.powerMul });
    }
    await page.evaluate((g) => window.__rim.setGroups(g.mul, g.powerMul), PRODUCT_ORGANIC);
    await page.evaluate((m) => {
      window.__rim.setMaster(m);
      window.__engine.debugSetPaused(false);
      window.__engine.cine.stop();
    }, productMaster);
    await page.waitForTimeout(1500);
  }

  async function writeManifest() {
    const lines = ['# 부감·드론 역광 림 캡처 (#35-1 P2a/P2b)', ''];
    lines.push(`- 생성: ${new Date().toISOString()} · 소요 ${Math.round((Date.now() - started) / 1000)}s`);
    lines.push('');
    lines.push('| png | 시나리오 | 모드 | 상태 | uRimScale | uRimStrength | viewDist(m) | band near/far(m) |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const r of rows) {
      const n = (v, d = 3) => (typeof v === 'number' ? v.toFixed(d) : String(v));
      lines.push(`| ${r.file} | ${r.scenario} | ${r.mode} | ${r.label} | ${n(r.rim.scale)} | ${n(r.rim.strength, 4)} `
        + `| ${n(r.rim.viewDistance, 1)} | ${n(r.rim.near, 1)}/${n(r.rim.far, 1)} |`);
    }
    lines.push('');
    lines.push('## 커버리지 (재질군별 패치 수 · 그룹 계수)');
    const last = rows[rows.length - 1];
    if (last) {
      lines.push('```');
      lines.push(`coverage        ${JSON.stringify(last.rim.coverage)}`);
      lines.push(`groupMultipliers ${JSON.stringify(last.rim.groupMultipliers)}`);
      lines.push('```');
    }
    lines.push('');
    lines.push('## 프로그램 수 / 비고');
    for (const note of notes) lines.push(`- ${note}`);
    if (runtimeErrors.length) {
      lines.push('');
      lines.push('## 런타임 오류');
      for (const error of runtimeErrors.slice(0, 20)) lines.push(`- ${error}`);
    }
    await writeFile(join(OUT, 'MANIFEST.md'), `${lines.join('\n')}\n`, 'utf8');
    await writeFile(join(OUT, 'rim-frames.json'), `${JSON.stringify({ rows, notes, runtimeErrors }, null, 2)}\n`, 'utf8');
  }

  for (const scenario of selected) {
    // 한 시나리오의 부팅·재생 실패가 나머지 증거를 버리지 않게 한다(한양 동기 생성은 느리다).
    try {
      await runScenario(scenario);
    } catch (error) {
      notes.push(`${scenario.id}: 중단 — ${error.message.split('\n')[0]}`);
      console.log(`  ${scenario.id} 중단: ${error.message.split('\n')[0]}`);
    }
    await writeManifest();
  }
  console.log(`\n출력: ${OUT}`);
  for (const note of notes) console.log(`  ${note}`);
  if (runtimeErrors.length) console.log(`  런타임 오류 ${runtimeErrors.length}건`);
} finally {
  if (browser) await browser.close();
  await server.close();
}
