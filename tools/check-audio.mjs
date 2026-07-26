// 사운드 레이어 헤드리스 검증 — **실제 AudioContext 가 필요한 것만** 여기 있다.
// audio.html 을 열어 각 버튼을 눌러 콘솔 에러 0 · AudioContext 'running' 확인,
// OfflineAudioContext 로 풍경 합성 1회를 렌더해 RMS>0(무음 아님)을 확인한다.
// 여기에 더해, 귀 없이 판정 가능한 계측점으로 **오디오 그래프 자체**를 단언한다:
//   ctx.state / 마스터 게인 / BGM 트랙 이름·보이스 게인·보이스 수 / 각 레이어 게인 /
//   mp3 실제 디코드 성공(genesis 포함) / 진입 트랙 → 시간대 트랙 인계 크로스페이드.
//
// 트랙 선택 라우팅·진입 뮤트 복원 상태기계·자산 도달성은 브라우저가 필요 없으므로
// tools/check-audio-policy.mjs(순수, `npm run check` 에 포함)가 담당한다. 여기서 중복하지 않는다.
//
// 한계(솔직히): Playwright Chromium 은 **iOS Safari 의 autoplay 정책을 재현하지 않는다**.
// 이 게이트의 PASS 는 "그래프가 소리를 낼 상태"라는 뜻이고, 실기 iOS 무음(무음 스위치·인터럽션)
// 판정은 사용자 기기에서 window.__engine.audioDiag() 로만 가능하다.
// 사용법: node tools/check-audio.mjs
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { launchVerificationBrowser, reportWebGLRenderer } from './lib/verification-browser.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.json': 'application/json', '.mp3': 'audio/mpeg',
};

const server = createServer(async (req, res) => {
  try {
    const path = req.url.split('?')[0];
    if (path === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    const file = join(ROOT, path === '/' ? 'index.html' : path);
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('not found');
  }
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const port = server.address().port;

const ARGS = ['--autoplay-policy=no-user-gesture-required'];
let browser;
browser = await launchVerificationBrowser({ args: ARGS });

const page = await browser.newPage({ viewport: { width: 1000, height: 720 } });
// 실제 Web Audio native 메서드를 계측한다. 모듈 내부 카운터가 아니라 브라우저가 본
// start/stop/connect/disconnect 쌍을 비교해 종료 계약의 빈틈을 잡는다.
await page.addInitScript(() => {
  const connected = new Set();
  const disconnected = new Set();
  const started = new Set();
  const stopped = new Set();

  const nodeProto = globalThis.AudioNode?.prototype;
  if (nodeProto) {
    const connect = nodeProto.connect;
    const disconnect = nodeProto.disconnect;
    nodeProto.connect = function(...args) {
      connected.add(this);
      return connect.apply(this, args);
    };
    nodeProto.disconnect = function(...args) {
      disconnected.add(this);
      return disconnect.apply(this, args);
    };
  }

  const sourceProto = globalThis.AudioScheduledSourceNode?.prototype;
  if (sourceProto) {
    const start = sourceProto.start;
    const stop = sourceProto.stop;
    sourceProto.start = function(...args) {
      started.add(this);
      return start.apply(this, args);
    };
    sourceProto.stop = function(...args) {
      stopped.add(this);
      return stop.apply(this, args);
    };
  }

  globalThis.__audioLifecycleProbe = () => ({
    connected: connected.size,
    disconnected: [...connected].filter((node) => disconnected.has(node)).length,
    started: started.size,
    stopped: [...started].filter((source) => stopped.has(source)).length,
  });
});
const errors = [];
const warnings = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(msg.text());
  if (msg.type() === 'warning') warnings.push(msg.text());
});
page.on('pageerror', (err) => errors.push('pageerror: ' + err.message));

const results = [];
const ok = (name, pass, extra = '') => { results.push({ name, pass, extra }); };

// 오디오 그래프 스냅샷 폴링 — 화면이 아니라 게인·보이스·트랙 이름을 기다린다.
async function waitForDiag(page, predicate, { timeout = 20000, label = 'diag' } = {}) {
  const deadline = Date.now() + timeout;
  let last = null;
  let maxVoices = 0;
  for (;;) {
    last = await page.evaluate(() => window.__audio.diagnostics());
    maxVoices = Math.max(maxVoices, last.bgm.voices.length);
    if (predicate(last)) return { state: last, maxVoices, timedOut: false };
    if (Date.now() > deadline) return { state: last, maxVoices, timedOut: true };
    await page.waitForTimeout(120);
  }
}

try {
  await page.goto(`http://127.0.0.1:${port}/audio.html`, { waitUntil: 'load' });
  await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 30000 });
  await reportWebGLRenderer(page, 'audio');
  ok('page loads + render loop', true);

  // start (user gesture → resume)
  await page.click('#start');
  await page.waitForTimeout(400);
  let state = await page.evaluate(() => window.__audioState());
  ok("AudioContext 'running'", state === 'running', `state=${state}`);

  // ---------- 오디오 그래프 계측(귀 없이 무음 판정) ----------
  // 기본 트랙이 실제로 디코드되고 **게인이 오르는 보이스**가 되었는지. 로드 실패는 console.warn
  // 으로 삼켜지던 무음 원인이므로 diagnostics().bgm.failures 로 직접 본다.
  const bootAudio = await waitForDiag(page,
    (d) => d.bgm.voices.some((v) => v.to > 0 && v.gain > 0), { label: 'boot voice' });
  ok('BGM decodes and becomes a rising voice', !bootAudio.timedOut,
    `track=${bootAudio.state.bgm.track} voices=${JSON.stringify(bootAudio.state.bgm.voices)}`);
  ok('BGM bus and master are audible', bootAudio.state.master === 1
    && bootAudio.state.bgmBusGain === 1 && bootAudio.state.bgm.master > 0,
  `master=${bootAudio.state.master} bus=${bootAudio.state.bgmBusGain} bgmMaster=${bootAudio.state.bgm.master}`);
  ok('audio graph reports started + enabled', bootAudio.state.started && bootAudio.state.enabled,
    JSON.stringify({ started: bootAudio.state.started, enabled: bootAudio.state.enabled }));
  // 합성 환경음 레이어가 실제 레벨을 갖는지(무음 레이어 회귀 검출).
  const amb = await waitForDiag(page, (d) => d.ambience.levels.wind > 0.01, { label: 'ambience' });
  ok('ambience wind layer reaches a real level', !amb.timedOut,
    `levels=${JSON.stringify(amb.state.ambience.levels)}`);
  ok('positional layers are live (chime bus, stream, dog)',
    amb.state.chimes.started && amb.state.chimes.busGain > 0
      && !!amb.state.stream && amb.state.stream.enabled && amb.state.stream.target > 0
      && !!amb.state.dog && amb.state.dog.enabled,
    JSON.stringify({ chimes: amb.state.chimes, stream: amb.state.stream, dog: amb.state.dog }));

  // ---------- 첫 진입 트랙 → 시간대 트랙 인계(실 컨텍스트) ----------
  const armed = await page.evaluate(() => {
    window.__audio.introEvent('arm');
    return window.__audio.diagnostics();
  });
  ok("introEvent('arm') mutes BGM for the title window",
    armed.intro.phase === 'armed' && armed.bgm.volMul === 0,
    `intro=${JSON.stringify(armed.intro)} volMul=${armed.bgm.volMul}`);
  const entered = await page.evaluate(() => {
    window.__audio.introEvent('enter');
    return window.__audio.diagnostics();
  });
  ok("introEvent('enter') selects the prepared first-entry track",
    entered.intro.track === 'genesis' && entered.bgm.track === 'genesis',
    `intro=${JSON.stringify(entered.intro)} track=${entered.bgm.track}`);
  const entryVoice = await waitForDiag(page,
    (d) => d.bgm.loaded.includes('genesis') && d.bgm.voices.some((v) => v.to > 0),
    { label: 'genesis voice', timeout: 30000 });
  ok('assets/audio/genesis.mp3 actually decodes and plays', !entryVoice.timedOut,
    `loaded=${JSON.stringify(entryVoice.state.bgm.loaded)} failures=${JSON.stringify(entryVoice.state.bgm.failures)}`);
  // 스웰: 코어 update 가 볼륨을 0→1 로 올린다(엔진 프레임 콜백 없음).
  const swelled = await page.evaluate(() => {
    for (let i = 0; i < 12; i++) window.__audio.update(0.25);   // 3s > INTRO_FADE
    return window.__audio.diagnostics();
  });
  ok('the entry swell reaches full volume through core update()',
    swelled.intro.volume === 1 && swelled.bgm.volMul === 1,
    `intro=${JSON.stringify(swelled.intro)} volMul=${swelled.bgm.volMul}`);
  const settled = await page.evaluate(() => {
    window.__audio.introEvent('settle');
    return window.__audio.diagnostics();
  });
  ok("introEvent('settle') hands the entry track over to the time-mapped track",
    settled.bgm.track === 'main-theme' && settled.intro.track === null && settled.intro.volume === 1,
    `track=${settled.bgm.track} intro=${JSON.stringify(settled.intro)}`);
  const handover = await waitForDiag(page,
    (d) => d.bgm.voices.length >= 2 && d.bgm.voices.some((v) => v.to === 0) && d.bgm.voices.some((v) => v.to > 0),
    { label: 'handover crossfade' });
  ok('the handover is an equal-power crossfade, not a cut', !handover.timedOut,
    `voices=${JSON.stringify(handover.state.bgm.voices)} maxVoices=${handover.maxVoices}`);
  ok('no swallowed mp3 load failure', Object.keys(handover.state.bgm.failures).length === 0,
    JSON.stringify(handover.state.bgm.failures));

  // 각 시간대
  for (const t of ['dawn', 'day', 'sunset', 'night']) {
    await page.click(`#times button[data-time="${t}"]`);
    await page.waitForTimeout(150);
  }
  ok('time buttons (dawn/day/sunset/night)', true);

  // 각 날씨
  for (const w of ['rain', 'snow', 'clear']) {
    await page.click(`#weathers button[data-weather="${w}"]`);
    await page.waitForTimeout(150);
  }
  ok('weather buttons (rain/snow/clear)', true);

  // 풍경 타종
  await page.click('#strike');
  await page.click('#strike4');
  await page.waitForTimeout(200);
  ok('chime strike buttons', true);

  // 개울 물소리 토글
  await page.click('#streamToggle'); // OFF
  await page.waitForTimeout(120);
  await page.click('#streamToggle'); // ON
  await page.waitForTimeout(120);
  ok('stream toggle', true);

  // 개 짖음(위치성) — 즉시 짖음 + 앉음 시뮬레이션
  await page.click('#dogBark');
  await page.click('#dogSit');
  await page.waitForTimeout(300);
  ok('dog bark buttons', true);

  // BGM 트랙 버튼(첫 옵션 트랙 하나)
  const trackBtns = await page.$$('#tracks button');
  if (trackBtns.length) { await trackBtns[trackBtns.length - 1].click(); await page.waitForTimeout(150); }
  ok('bgm track buttons present', trackBtns.length > 0, `count=${trackBtns.length}`);

  // enable 토글
  await page.click('#toggle');
  await page.waitForTimeout(100);
  await page.click('#toggle');
  ok('enable toggle', true);

  // 종료 계약: 두 번 호출해도 안전하고, 모든 시작 소스·연결 그래프를 정리하며,
  // dispose 뒤 public API 호출은 새 source/node를 만들지 않는다.
  const detached = await page.evaluate(() => {
    window.__audio.dispose();
    window.__audio.dispose();
    return window.__audio.listener.parent === null;
  });
  await page.waitForTimeout(250);
  const disposedProbe = await page.evaluate(() => window.__audioLifecycleProbe());
  ok('dispose is idempotent + listener detached', detached);
  const disposedDiag = await page.evaluate(() => {
    try { return { ok: true, diag: window.__audio.diagnostics() }; } catch (e) { return { ok: false, message: e.message }; }
  });
  ok('diagnostics() stays callable and honest after dispose',
    disposedDiag.ok && disposedDiag.diag.disposed === true && disposedDiag.diag.ctxState === 'disposed'
      && disposedDiag.diag.started === false,
    JSON.stringify(disposedDiag.ok ? { disposed: disposedDiag.diag.disposed, ctxState: disposedDiag.diag.ctxState } : disposedDiag));
  ok('all started sources stopped on dispose', disposedProbe.started === disposedProbe.stopped,
    `started=${disposedProbe.started} stopped=${disposedProbe.stopped}`);
  ok('all connected nodes disconnected on dispose', disposedProbe.connected === disposedProbe.disconnected,
    `connected=${disposedProbe.connected} disconnected=${disposedProbe.disconnected}`);

  await page.evaluate(async () => {
    await window.__audio.start();
    window.__audio.strike();
    window.__audio.barkDog();
    window.__audio.playTrack('night');
    window.__audio.setTime('night');
    window.__audio.setWeather('rain');
    window.__audio.update(1 / 60);
  });
  await page.waitForTimeout(100);
  const afterDisposedCalls = await page.evaluate(() => window.__audioLifecycleProbe());
  ok('public API is inert after dispose',
    afterDisposedCalls.started === disposedProbe.started && afterDisposedCalls.connected === disposedProbe.connected,
    `before=${JSON.stringify(disposedProbe)} after=${JSON.stringify(afterDisposedCalls)}`);

  // 오프라인 풍경 합성 RMS
  const rms = await page.evaluate(() => window.__renderBellRMS());
  ok('offline bell RMS > 0 (not silent)', rms > 1e-4, `rms=${rms.toExponential(3)}`);

  // 오프라인 개울 물바닥 RMS
  const srms = await page.evaluate(() => window.__renderStreamRMS());
  ok('offline stream RMS > 0 (not silent)', srms > 1e-4, `rms=${srms.toExponential(3)}`);

  // 오디오 관련 콘솔 에러 0 (mp3 디코드 경고는 warning 이라 별도 집계)
  ok('no console errors', errors.length === 0, errors.length ? errors.join(' | ') : '');
} catch (e) {
  ok('run', false, e.message);
} finally {
  await browser.close();
  await new Promise((resolveClose) => server.close(resolveClose));
}

// ---------- 리포트 ----------
let allPass = true;
console.log('\n=== check-audio ===');
for (const r of results) {
  const mark = r.pass ? 'PASS' : 'FAIL';
  if (!r.pass) allPass = false;
  console.log(`  [${mark}] ${r.name}${r.extra ? '  (' + r.extra + ')' : ''}`);
}
if (warnings.length) {
  console.log('\n  warnings (non-fatal):');
  for (const w of warnings.slice(0, 6)) console.log('    - ' + w);
}
console.log(allPass ? '\nALL PASS\n' : '\nFAILURES PRESENT\n');
process.exit(allPass ? 0 : 1);
