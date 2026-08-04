// #53 핫픽스 게이트 — 부감에서 페이드 아웃되는 상공 구름 빌보드가 "하늘에 매직펜으로 그린
// 윤곽선"으로 남지 않는가.
//
// 왜 이 게이트가 필요했나. S4(v4 마칭)·S6(실루엣 패밀리)의 A/B 프로브는 **env 단일건물 경로**에서
//   찍었다(tools/probe-cloud-v4.mjs 주석: "env 경로는 overheadFade 가 없어 빌보드가 온전하고").
//   그 경로에는 마을 부감의 시선각 페이드(overheadFade)가 아예 없어서, 제품 부감에서만 나오는
//   실패 모드를 어느 프로브도 잡지 못했다 — 최종 클립 6컷(c14·c16·c17·c21·c22·c23)에서 구름이
//   내부가 빈 파스텔 윤곽선 루프로 렌더됐다.
//
// 실패의 기제(같은 부팅 절제 실측, 2026-08-04, village 부감 sunset, vseed 20260716):
//   페이드는 material.opacity 만 낮춘다. 그런데 이 빌보드의 화면 기여는 균일하지 않다 —
//   바디는 그늘색이 haze 를 따라가 하늘과 거의 같은 복사도인데, 림(uCloudRimColor·1.28)과
//   역광 투과(uCloudGain.z)는 하늘의 여러 배인 HDR 항이고 둘 다 실루엣 경계에 몰려 있다.
//   fade 0.018~0.080 에서 바디 ΔL 2~6 vs 림 스트로크 ΔL 20~50(비 8~10 배) → 바디만 지각
//   문턱 아래로 사라지고 경계만 남는다. 림 세기를 0 으로 두면 그 크리스프 스트로크가 사라진다.
//
// 그래서 두 축을 단언한다.
//   ① 계약(픽셀 무관): 페이드 계수 fade 가 opacity 뿐 아니라 림·역광 투과 게인에도 걸린다.
//      기준값은 **같은 프레임의 원경 뱅크**에서 읽는다(뱅크는 시선각 페이드를 받지 않는다).
//      게이트가 저작 상수를 복사해 두면 그 순간 계측기가 자기증명이 되므로 그렇게 하지 않는다.
//   ② 픽셀: 하늘에 남는 잔여가 (a) 절대 강도 상한 아래이고 (b) '윤곽선 스트로크'로 구조화되지
//      않는다(p99.9 / 중앙값 비). 동시에 (c) 구름을 아예 지워 통과하는 길을 막는다 — 빌보드는
//      여전히 하늘에 실측 가능한 바디를 남겨야 한다.
//
// 계측기 규율(레포 규약 "계측기를 한 번 의심한다"):
//   · 하늘 ROI 를 픽셀 좌표로 고정하지 않는다. 부감 프레이밍 자세는 부팅마다 흔들리므로
//     (CLAUDE.md), 기준 캡처의 국소 표준편차가 낮은 상단 영역을 하늘로 **자동 판정**한다.
//   · 같은 상태를 두 번 찍어 프레임간 노이즈(연기·모트·풀)를 마스크로 제외한다. 그 노이즈가
//     ROI 를 잡아먹으면 판정 대신 실패를 보고한다.
//   · 구름 표류는 ?shot=1 로 정지시킨다(clouds.js SHOT: t=0 고정). 표류가 살아 있으면 변주가
//     서로 다른 순간을 비교하게 되어 A/B 자체가 성립하지 않는다(첫 시도에서 실제로 겪었다).
//
// FAIL-first: CHEOMA_CLOUD_FADE_FAILFIRST=1 로 실행하면 제품 코드가 쓴 뒤 림·역광 게인을
//   **저작값으로 되돌려** 수정 전 동작을 같은 부팅에서 정확히 재현한다 → ①②가 함께 실패한다.
//   (git 상태를 건드리지 않고 pre-fix 를 재현하는 방법이라 스태시보다 안전하다.)
//
// 픽스처: capital 부감 sunset(결함 컷 4/6 이 이 규모였고 수정 전/후 분리가 가장 크다).
//   CHEOMA_CLOUD_FADE_SCALE=village 로 참고 규모도 돌 수 있다.
//
// 실행: node tools/run-browser-locked.mjs -- node tools/check-cloud-fade-residue.mjs
//   PNG 보존: CHEOMA_CLOUD_FADE_OUT=<dir>
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from '../app/node_modules/vite/dist/node/index.js';
import { launchVerificationBrowser, reportWebGLRenderer } from './lib/verification-browser.mjs';
import { readPng, luma709 } from './lib/pixel-stats.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const APP_ROOT = join(ROOT, 'app');
const FAIL_FIRST = process.env.CHEOMA_CLOUD_FADE_FAILFIRST === '1';
const timeout = Number(process.env.CHEOMA_CLOUD_FADE_TIMEOUT_MS) || 240_000;
const W = 1920, H = 1080;
// 기본 픽스처는 **capital 부감**이다(리드 결정 2026-08-04). 근거는 두 가지다: 최종 클립의 결함
//   컷 6 개 중 4 개(c17·c21·c22·c23)가 capital 규모였고, 아래 임계 표대로 수정 전/후 분리가
//   village 의 4.3 배에서 capital 의 10.1 배로 깨끗해진다. 분리가 큰 쪽을 계약으로 둔다.
//   CHEOMA_CLOUD_FADE_SCALE=village 로 참고 픽스처도 돌릴 수 있다(픽셀 임계는 capital 산정치이므로
//   village 로 돌릴 때는 계약 단언 ①만 계약으로 읽어야 한다).
const SCALE = process.env.CHEOMA_CLOUD_FADE_SCALE || 'capital';

// ── 임계 ─────────────────────────────────────────────────────────────────────
// 전부 같은 부팅·같은 프레이밍의 실측 사이에서 골랐다(2026-08-04, village 부감 sunset,
//   seed 20260718 / vseed 20260716, shot=1). 실측값은 라운드 보고에 첨부한다.
// FADE_CEIL: 이 픽스처가 정말 '페이드 영역'인지 확인하는 값. 프레이밍이 흘러 빌보드가 온전히
//   보이는 자세가 되면 조용히 통과하는 대신 게이트가 픽스처 드리프트를 보고해야 한다.
const FADE_CEIL = 0.25;
// 계약 오차: fade·저작값 곱과 실제 uniform 의 상대 오차. 같은 프레임의 두 값을 비교하므로
//   부동소수 오차 수준만 허용한다.
const CONTRACT_REL_TOL = 2e-3;
const SKY_MIN_FRAC = 0.04;      // 자동 판정된 하늘 ROI 가 프레임에서 차지해야 하는 최소 비율
const NOISE_MAX_FRAC = 0.25;    // ROI 안 프레임간 노이즈 픽셀 허용 비율(넘으면 판정 불가)
const FOOT_TAU = 0.75;          // 빌보드 흔적으로 셀 |ΔL| 문턱
const BODY_MIN_L = 0.8;         // 바디가 남아 있어야 한다(구름을 지워 통과하는 길 차단)
const FOOT_MIN_FRAC = 0.02;     // 빌보드 흔적이 ROI 에서 차지해야 하는 최소 비율
// ── 스트로크 판별식 ─────────────────────────────────────────────────────────
// "매직펜 선"은 **하나의 긴 연속 곡선**이다. 그래서 잔여장의 고역통과(9×9 국소평균 대비)를 문턱화한
//   뒤 최대 8-연결성분 크기를 본다. 절대 강도(maxΔL)나 분위수만으로는 못 가른다 — 태양 쪽 밝은
//   하늘을 지나는 정상적인 밝은 구름 바디도 ΔL 이 30 을 넘고, 스크리블은 화면의 0.1% 밖에 안 되므로
//   p99.9 조차 얕다(실측: p99.9 6.99 → 4.35 로 1.6 배 차이뿐).
// 같은 부팅·같은 프레이밍 실측(2026-08-04, **capital 부감 sunset**, shot=1, seed 20260718 /
//   vseed 20260716, palace·temple 포함; 기준 캡처 프레이밍의 부팅 간 차이는 |ΔL|>2 픽셀 655 개
//   = 0.032% 로 무시 가능 → 두 실행의 A/B 가 성립한다):
//     고역통과 문턱 T   최대연결성분 (수정 전 FAIL-first / 수정 후)   분리
//       T=3              4152 / 481                                 8.6×
//       T=4              2677 / 313                                 8.6×
//       T=5              1521 / 151                                10.1×   ← 채택
//       T=6              1056 /  92                                11.5×
//       T=7               659 /  80                                 8.2×
//   T=5 가 분리 최대(10.1×)이고 두 값의 기하평균이 479 이므로 상한 480 을 쓴다 — 수정 후 대비
//   3.2 배 여유, 수정 전 대비 3.2 배 미달로 양쪽이 대칭이다.
//   [참고] 같은 계측기를 village 픽스처로 돌리면 T=5 에서 427 / 100 (4.3×)이다. 결함이 약하게
//   나타나는 규모라 계약 픽스처로는 쓰지 않는다(리드 결정 2026-08-04).
//   이 축은 지각 주장을 픽셀로 옮긴 근사치이므로 여유를 넉넉히 두고, 영구 계약은 위의
//   ①(페이드가 림·투과광을 탄다)이 담당한다.
const STROKE_HP_TAU = 5;
const STROKE_RUN_MAX = Number(process.env.CHEOMA_CLOUD_STROKE_RUN_MAX) || 480;

const failures = [];
const invariant = (ok, message, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${message}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures.push(message);
};

const cacheDir = await mkdtemp(join(tmpdir(), 'cheoma-cloudfade-cache-'));
const shotDir = process.env.CHEOMA_CLOUD_FADE_OUT
  ? resolve(process.env.CHEOMA_CLOUD_FADE_OUT)
  : await mkdtemp(join(tmpdir(), 'cheoma-cloudfade-shots-'));
await mkdir(shotDir, { recursive: true });

const server = await createServer({
  root: APP_ROOT,
  configFile: join(APP_ROOT, 'vite.config.js'),
  cacheDir,
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, fs: { allow: [ROOT] } },
});

// ── 픽셀 유틸 ────────────────────────────────────────────────────────────────
const lumaOf = (img) => {
  const { width: w, height: h, channels: c, data } = img;
  const out = new Float32Array(w * h);
  for (let i = 0, p = 0; i < w * h; i++, p += c) out[i] = luma709(data[p], data[p + 1], data[p + 2]);
  return out;
};
// 3×3 국소 표준편차 — 매끄러운 하늘(≈0)과 식생·건물·지형(≫0)을 가른다.
const localStdField = (L, w, h) => {
  const out = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      let s = 0, s2 = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const v = L[(y + dy) * w + (x + dx)];
          s += v; s2 += v * v;
        }
      }
      const m = s / 9;
      out[y * w + x] = Math.sqrt(Math.max(0, s2 / 9 - m * m));
    }
  }
  return out;
};
const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * q)))];

let browser;
const runtimeErrors = [];
try {
  await server.listen();
  const base = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await launchVerificationBrowser();
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => runtimeErrors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') runtimeErrors.push(`console: ${m.text()}`); });

  // shot=1 은 구름 표류를 t=0 으로 고정한다. time 은 명시해야 한다 — shot 기본이 day 이고
  //   림·역광 투과는 저고도 태양에서만 서므로 sunset 이 아니면 판정 대상이 존재하지 않는다.
  const url = `${base}/?shot=1&hero=0&village=1&seed=20260718&vseed=20260716`
    + `&vscale=${SCALE}&vpalace=${SCALE === 'village' ? 0 : 1}&vtemple=${SCALE === 'village' ? 0 : 1}`
    + '&time=sunset&weather=clear&season=summer&lang=ko&sunset=gold';
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
  await page.waitForFunction(() => window.__SHOT_READY === true
    && window.__engine?.village?.getState()?.active === true, null, { timeout });
  await page.addStyleTag({
    content: 'body *:not(canvas){visibility:hidden !important}html body canvas{visibility:visible !important}',
  });
  await reportWebGLRenderer(page, 'cloud-fade-residue');
  await page.waitForTimeout(2600);
  await page.evaluate(() => {
    const c = window.__engine.__controls;
    c.autoRotate = false; c.autoRotateSpeed = 0;
  });
  await page.waitForTimeout(700);

  // 층 선별. window.__clouds.layers 에는 env 단일건물 층도 등록되어 있고, 마을 모드에서 그 층은
  //   update()·onBeforeRender 가 한 번도 돌지 않는 **휴면** 상태다(root.visible 은 true 일 수 있어
  //   가시성만으로는 갈리지 않는다 — 첫 실행에서 휴면 층의 뱅크를 저작 기준으로 읽어 계약 단언이
  //   전부 want=0 으로 무너졌다). 판별 기준은 "상공 빌보드가 부감 페이드를 실제로 통과했는가"다.
  const wired = await page.evaluate((failFirst) => {
    let picked = null;
    for (const layer of (window.__clouds?.layers || [])) {
      const highs = [];
      const banks = [];
      layer.root.traverse((o) => {
        if (o.name && o.name.startsWith('high-cloud')) highs.push(o);
        if (o.name === 'horizon-cloud-bank') banks.push(o);
      });
      if (highs.some((m) => m.userData.cloudFade != null)) { picked = { highs, banks }; break; }
    }
    if (!picked) return { highs: [], banks: [], picked: false };
    const { highs, banks } = picked;
    window.__cfr = { highs, banks };
    if (failFirst) {
      // pre-fix 재현: 제품이 fade 를 걸어 대입한 뒤 저작값으로 되돌린다.
      //   저작값은 같은 프레임 뱅크에서 읽는다(뱅크 림 = 저작 림 × 1.08).
      for (const m of highs) {
        const orig = m.onBeforeRender;
        m.onBeforeRender = function (...a) {
          orig.apply(this, a);
          const bank = window.__cfr.banks[0];
          const br = bank && bank.material.userData.cloudRim;
          const r = m.material.userData.cloudRim;
          if (br && r) { r.strength.value = br.strength.value / 1.08; r.gain.z = br.gain.z; }
        };
      }
    }
    return { highs: highs.map((m) => m.name), banks: banks.map((m) => m.name), picked: true };
  }, FAIL_FIRST);
  console.log(`[cloud-fade] live high billboards=${JSON.stringify(wired.highs)} bank=${JSON.stringify(wired.banks)}`);
  invariant(wired.picked === true,
    'a live village cloud layer was identified (a high billboard published its overhead fade)');
  if (!wired.picked) throw new Error('no live village cloud layer — fixture did not reach village aerial');

  const readState = () => page.evaluate(() => {
    const bank = window.__cfr.banks[0];
    const bankRim = bank ? bank.material.userData.cloudRim : null;
    return {
      bank: bankRim ? {
        rimStrength: bankRim.strength.value,
        glowGain: bankRim.gain.z,
        opacity: bank.material.opacity,
        visible: bank.visible,
      } : null,
      highs: window.__cfr.highs.map((m) => {
        const r = m.material.userData.cloudRim;
        return {
          name: m.name,
          fade: m.userData.cloudFade == null ? null : m.userData.cloudFade,
          opacity: m.material.opacity,
          opNow: m.userData.opNow,
          rimStrength: r.strength.value,
          glowGain: r.gain.z,
        };
      }),
    };
  });

  const capture = async (name) => {
    const file = join(shotDir, `${name}.png`);
    await page.screenshot({ path: file, type: 'png' });
    return file;
  };
  const setBillboards = async (visible) => {
    await page.evaluate((v) => { for (const m of window.__cfr.highs) m.visible = v; }, visible);
    await page.waitForTimeout(360);
  };

  // ── ① 계약: fade 가 림·역광 투과에도 걸린다 ────────────────────────────────
  // uniform 은 onBeforeRender 가 쓴다. 배선 직후에 읽으면 **배선 이전 프레임**의 값을 읽게 되므로
  //   (FAIL-first 모드에서 실제로 그렇게 오독했다) 최소 한 프레임을 더 흘린 뒤 읽는다.
  await page.waitForTimeout(400);
  const state = await readState();
  console.log(`[cloud-fade] state=${JSON.stringify(state)}`);
  invariant(state.bank != null, 'horizon bank rim state readable (authored reference)');
  const bankRim = state.bank?.rimStrength ?? 0;
  const bankGlow = state.bank?.glowGain ?? 0;
  // 뱅크 림 = 저작 림 × 1.08 (clouds.js update: horizonRim.strength = rimStrength * 1.08).
  const authoredRim = bankRim / 1.08;
  invariant(authoredRim > 0.2, 'sunset fixture has the backlit rim armed',
    `authoredRimStrength=${authoredRim.toFixed(4)}`);
  invariant(bankGlow > 0.2, 'sunset fixture has backlit transmission armed',
    `authoredGlowGain=${bankGlow.toFixed(4)}`);
  invariant(state.highs.length >= 1, 'village overhead billboards present',
    `count=${state.highs.length}`);
  for (const h of state.highs) {
    invariant(h.fade != null, `${h.name}: overhead fade factor is published for verification`);
    if (h.fade == null) continue;
    invariant(h.fade <= FADE_CEIL, `${h.name}: fixture is in the faded regime (fade <= ${FADE_CEIL})`,
      `fade=${h.fade.toFixed(4)}`);
    const wantRim = authoredRim * h.fade;
    const wantGlow = bankGlow * h.fade;
    const relRim = Math.abs(h.rimStrength - wantRim) / Math.max(1e-6, authoredRim);
    const relGlow = Math.abs(h.glowGain - wantGlow) / Math.max(1e-6, bankGlow);
    invariant(relRim <= CONTRACT_REL_TOL,
      `${h.name}: rim strength rides the overhead fade`,
      `rim=${h.rimStrength.toFixed(5)} want=${wantRim.toFixed(5)} rel=${relRim.toExponential(2)}`);
    invariant(relGlow <= CONTRACT_REL_TOL,
      `${h.name}: backlit transmission gain rides the overhead fade`,
      `glow=${h.glowGain.toFixed(5)} want=${wantGlow.toFixed(5)} rel=${relGlow.toExponential(2)}`);
    // 알파는 종전과 같아야 한다 — 이 라운드는 페이드 세기를 재조정하지 않는다.
    const wantOpacity = h.opNow * h.fade;
    invariant(Math.abs(h.opacity - wantOpacity) <= 1e-4,
      `${h.name}: opacity still equals base * fade (fade curve untouched)`,
      `opacity=${h.opacity.toFixed(5)} want=${wantOpacity.toFixed(5)}`);
  }

  // ── ② 픽셀: 하늘 잔여 ──────────────────────────────────────────────────────
  await setBillboards(true);
  const fileA1 = await capture('with-billboards-1');
  await page.waitForTimeout(220);
  const fileA2 = await capture('with-billboards-2');
  await setBillboards(false);
  const fileB1 = await capture('no-billboards-1');
  await page.waitForTimeout(220);
  const fileB2 = await capture('no-billboards-2');
  await setBillboards(true);

  const A1 = lumaOf(readPng(fileA1)), A2 = lumaOf(readPng(fileA2));
  const B1 = lumaOf(readPng(fileB1)), B2 = lumaOf(readPng(fileB2));
  const std = localStdField(B1, W, H);
  const yLimit = Math.round(H * 0.42);

  // 잔여장 Δ 와 그 유효 마스크를 먼저 만든다(고역통과를 재려면 이웃이 필요하다).
  const delta = new Float32Array(W * H);
  const valid = new Uint8Array(W * H);
  let skyPx = 0, noisePx = 0;
  for (let y = 1; y < yLimit; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      if (std[i] >= 0.6) continue;                 // 매끄러운 하늘만
      skyPx++;
      // 프레임간 노이즈(연기·모트) 제외 — 같은 상태 두 캡처의 차이로 자동 판정.
      if (Math.abs(A1[i] - A2[i]) > 1 || Math.abs(B1[i] - B2[i]) > 1) { noisePx++; continue; }
      delta[i] = Math.abs((A1[i] + A2[i]) * 0.5 - (B1[i] + B2[i]) * 0.5);
      valid[i] = 1;
    }
  }
  // 스트로크 지표 = 잔여장의 고역통과. "매직펜 선"은 폭 2~4px 의 밝은 능선이므로 국소 평균과
  //   크게 벌어진다. 반면 부드러운 바디(넓은 그라디언트)는 아무리 밝아도 고역통과가 작다.
  //   이 축이 지각 불만("윤곽선만 남았다")과 직접 대응하고, 태양 쪽 밝은 하늘을 지나는 정상적인
  //   밝은 구름 바디를 벌점하지 않는다 — 절대 강도(maxAbs)만으로는 그 둘을 못 가른다.
  const HP_R = 4;                                  // 국소 평균 반경(9×9)
  const deltas = [];
  const footprint = [];
  const highpass = [];
  const strokeMask = new Uint8Array(W * H);
  for (let y = 1; y < yLimit; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      if (!valid[i]) continue;
      const d = delta[i];
      deltas.push(d);
      if (d > FOOT_TAU) footprint.push(d);
      let sum = 0, n = 0;
      for (let dy = -HP_R; dy <= HP_R; dy++) {
        const yy = y + dy; if (yy < 1 || yy >= yLimit) continue;
        for (let dx = -HP_R; dx <= HP_R; dx++) {
          const xx = x + dx; if (xx < 1 || xx >= W - 1) continue;
          const j = yy * W + xx; if (!valid[j]) continue;
          sum += delta[j]; n++;
        }
      }
      if (n < 20) continue;
      const hp = Math.abs(d - sum / n);
      highpass.push(hp);
      if (hp > STROKE_HP_TAU) strokeMask[i] = 1;
    }
  }
  // 최대 8-연결성분 = "한 줄로 이어진 펜 선"의 길이. 흩어진 그레인은 작은 성분으로 쪼개진다.
  let strokeRun = 0, strokeComps = 0, strokePx = 0;
  {
    const seen = new Uint8Array(W * H);
    const stack = new Int32Array(W * H);
    for (let i = 0; i < W * H; i++) if (strokeMask[i]) strokePx++;
    for (let y = 1; y < yLimit; y++) {
      for (let x = 1; x < W - 1; x++) {
        const s = y * W + x;
        if (!strokeMask[s] || seen[s]) continue;
        let sp = 0, size = 0;
        stack[sp++] = s; seen[s] = 1;
        while (sp > 0) {
          const p = stack[--sp]; size++;
          const py = (p / W) | 0, px = p - py * W;
          for (let dy = -1; dy <= 1; dy++) {
            const yy = py + dy; if (yy < 1 || yy >= yLimit) continue;
            for (let dx = -1; dx <= 1; dx++) {
              const xx = px + dx; if (xx < 1 || xx >= W - 1) continue;
              const q = yy * W + xx;
              if (strokeMask[q] && !seen[q]) { seen[q] = 1; stack[sp++] = q; }
            }
          }
        }
        strokeComps++;
        if (size > strokeRun) strokeRun = size;
      }
    }
  }
  const skyFrac = skyPx / (W * H);
  invariant(skyFrac >= SKY_MIN_FRAC, 'auto-detected smooth sky ROI is large enough to judge',
    `skyFrac=${skyFrac.toFixed(4)} px=${skyPx}`);
  const noiseFrac = skyPx ? noisePx / skyPx : 1;
  invariant(noiseFrac <= NOISE_MAX_FRAC, 'frame-to-frame noise leaves the ROI judgeable',
    `noiseFrac=${noiseFrac.toFixed(4)}`);

  deltas.sort((a, b) => a - b);
  footprint.sort((a, b) => a - b);
  highpass.sort((a, b) => a - b);
  const maxAbs = deltas.length ? deltas[deltas.length - 1] : 0;
  const footFrac = deltas.length ? footprint.length / deltas.length : 0;
  const bodyMedian = footprint.length ? quantile(footprint, 0.5) : 0;
  const strokeP999 = highpass.length ? quantile(highpass, 0.999) : 0;
  const strokeMax = highpass.length ? highpass[highpass.length - 1] : 0;
  console.log(`[cloud-fade] residue maxAbsDeltaL=${maxAbs.toFixed(2)} footFrac=${footFrac.toFixed(4)}`
    + ` bodyMedian=${bodyMedian.toFixed(3)} strokeHP_p999=${strokeP999.toFixed(2)}`
    + ` strokeHP_max=${strokeMax.toFixed(2)}`
    + ` strokePx=${strokePx} strokeComps=${strokeComps} strokeRun=${strokeRun}`);

  invariant(footFrac >= FOOT_MIN_FRAC,
    'faded billboards still leave a measurable body in the sky (not deleted)',
    `footFrac=${footFrac.toFixed(4)} >= ${FOOT_MIN_FRAC}`);
  invariant(bodyMedian >= BODY_MIN_L,
    'that body has real contrast (a rim-only ghost would not)',
    `bodyMedian=${bodyMedian.toFixed(3)} >= ${BODY_MIN_L}`);
  invariant(strokeRun <= STROKE_RUN_MAX,
    'faded billboards leave no connected pen stroke in the sky',
    `strokeRun=${strokeRun} <= ${STROKE_RUN_MAX} (hp>${STROKE_HP_TAU})`);

  invariant(runtimeErrors.length === 0, 'no runtime errors', runtimeErrors.slice(0, 3).join(' | '));
} finally {
  if (browser) await browser.close();
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
  if (!process.env.CHEOMA_CLOUD_FADE_OUT) await rm(shotDir, { recursive: true, force: true });
  else console.log(`[cloud-fade] shots kept in ${shotDir}`);
}

if (failures.length) {
  console.error(`\ncheck-cloud-fade-residue FAILED (${failures.length})`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('\ncheck-cloud-fade-residue PASSED');
