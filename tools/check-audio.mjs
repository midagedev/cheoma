// 사운드 레이어 헤드리스 검증.
// audio.html 을 열어 각 버튼을 눌러 콘솔 에러 0 · AudioContext 'running' 확인,
// OfflineAudioContext 로 풍경 합성 1회를 렌더해 RMS>0(무음 아님)을 확인한다.
// 사용법: node tools/check-audio.mjs
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

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
try { browser = await chromium.launch({ channel: 'chrome', args: ARGS }); }
catch { browser = await chromium.launch({ args: ARGS }); }

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

try {
  await page.goto(`http://127.0.0.1:${port}/audio.html`, { waitUntil: 'load' });
  await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 30000 });
  ok('page loads + render loop', true);

  // start (user gesture → resume)
  await page.click('#start');
  await page.waitForTimeout(400);
  let state = await page.evaluate(() => window.__audioState());
  ok("AudioContext 'running'", state === 'running', `state=${state}`);

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
