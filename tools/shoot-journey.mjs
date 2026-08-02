// #42 여정 스토리보드 — 하나의 연속 비행을 **τ 등간격**으로 훑는다.
//
// shoot-cine.mjs 는 leg 을 단독 재생해 구간마다 두 지점을 찍는다(구문법 유산: 구간마다 시계가
//   따로 있어 임의 지점으로 점프할 수 없었다). 새 런타임은 재생이 단일 τ 라 `cine.debugSeek(τ)` 로
//   여정의 어느 지점이든 바로 갈 수 있고, 그래서 **여정 전체를 균등하게 훑은 한 장의 스토리보드**를
//   만들 수 있다 — 비전 판정이 보아야 하는 것이 정확히 그것이다(비트별 대표컷이 아니라 흐름).
//
// 판정 게이트가 아니라 증거 수집기다. 통과/실패를 선언하지 않는다.
//
// 사용:
//   node tools/run-browser-locked.mjs -- node tools/shoot-journey.mjs [village|hanyang|capital]
//   CHEOMA_JOURNEY_OUT 으로 출력 디렉터리 변경.
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createServer } from '../app/node_modules/vite/dist/node/index.js';
import { launchVerificationBrowser, reportWebGLRenderer } from './lib/verification-browser.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const APP_ROOT = join(ROOT, 'app');
const OUT = process.env.CHEOMA_JOURNEY_OUT
  || join(ROOT, 'scratch', 'journey', 'storyboard');
const FRAMES = Number(process.env.CHEOMA_JOURNEY_FRAMES) || 28;
const timeout = Number(process.env.CHEOMA_JOURNEY_TIMEOUT_MS) || 180_000;

const SCALES = {
  village: { vseed: 20260716, query: 'vscale=village&vpalace=0&vtemple=0' },
  capital: { vseed: 7, query: 'vscale=capital&vpalace=1&vtemple=1' },
  hanyang: { vseed: 2026, query: 'vscale=hanyang&vpalace=1&vtemple=1' },
};
const filters = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const selected = Object.keys(SCALES).filter((k) => (filters.length ? filters.includes(k) : k !== 'capital'));
if (!selected.length) throw new Error(`no scale matches ${JSON.stringify(filters)}`);

await mkdir(OUT, { recursive: true });
const manifest = [];
const errors = [];

const server = await createServer({
  root: APP_ROOT,
  configFile: join(APP_ROOT, 'vite.config.js'),
  cacheDir: join(APP_ROOT, 'node_modules/.vite-journey'),
  server: { host: '127.0.0.1', port: 0, strictPort: false },
  logLevel: 'error',
});
await server.listen();
const port = server.config.server.port || server.httpServer.address().port;
const base = `http://127.0.0.1:${port}`;

// launchVerificationBrowser 는 Browser 를 그대로 돌려준다(구조분해 아님).
const browser = await launchVerificationBrowser();
console.log(`[journey] frames=${FRAMES} · scales=${selected.join(',')}`);

try {
  for (const scale of selected) {
    const cfg = SCALES[scale];
    const page = await browser.newPage();
    await page.setViewportSize({ width: 1600, height: 900 });
    page.on('pageerror', (e) => errors.push(`[${scale}] ${e.message}`));
    // shot=1 은 day 로 고정되므로 쓰지 않는다 — 여정의 셀링 포인트가 sunset 역광이다.
    //   hero=0&village=1 이 타이틀·히어로 랜딩을 건너뛰고 마을 모드로 바로 부팅한다(shoot-cine 과 동일).
    const url = `${base}/?hero=0&village=1&worker=0&seed=20260718&vseed=${cfg.vseed}`
      + `&${cfg.query}&time=sunset&weather=clear&season=summer&lang=ko`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    await page.waitForFunction(
      () => window.__SHOT_READY === true && window.__engine?.village?.getState()?.active === true,
      null, { timeout });
    // 감상 모드는 진입 베일·웨이브·히어로 조립이 모두 끝난 뒤에만 시작할 수 있다.
    await page.waitForFunction(() => window.__engine.cine.available() === true, null, { timeout });
    await page.addStyleTag({ content: '.chroma { visibility: hidden !important; }' });
    await reportWebGLRenderer(page, `journey/${scale}`);

    const started = await page.evaluate(() => window.__engine.cine.start('drone'));
    if (!started) { errors.push(`[${scale}] cine.start failed`); await page.close(); continue; }
    await page.waitForTimeout(600);
    const info = await page.evaluate(() => {
      const st = window.__engine.cine.getState();
      return { chain: st.chain, passes: window.__engine.cine.passList() };
    });
    const total = info.passes.reduce((a, p) => a + p.duration, 0);
    console.log(`[journey] ${scale} tour ${total.toFixed(1)}s · ${info.chain.join(' → ')}`);

    for (let k = 0; k < FRAMES; k++) {
      const tau = k / FRAMES;
      const state = await page.evaluate((t) => {
        window.__engine.debugSetPaused?.(false);
        window.__engine.cine.debugSeek(t);
        window.__engine.debugSetPaused?.(true);
        window.__engine.debugRenderDofFrame?.();
        const st = window.__engine.cine.getState();
        const cam = window.__engine.cine.debugCam();
        return { pass: st.pass, tau: st.tau, roll: st.rollDeg, cam };
      }, tau);
      const file = `sb-${scale}-${String(k).padStart(2, '0')}.png`;
      await page.screenshot({ path: join(OUT, file) });
      manifest.push({ scale, k, tau: +tau.toFixed(4), file, ...state });
      await page.evaluate(() => window.__engine.debugSetPaused?.(false));
    }
    await page.evaluate(() => window.__engine.cine.stop());
    await page.close();
  }
} finally {
  await browser.close();
  await server.close();
}

await writeFile(join(OUT, 'MANIFEST.json'), JSON.stringify({
  generated: new Date().toISOString(), frames: FRAMES, rows: manifest, errors,
}, null, 2));
console.log(`[journey] wrote ${manifest.length} frames → ${OUT}`);
if (errors.length) { console.error('runtime errors:'); for (const e of errors) console.error('  ' + e); }
