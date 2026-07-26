// AA 회귀 게이트 — 컴포저 경로의 기하 에지 안티에일리어싱.
//
// 왜 필요한가: `new THREE.WebGLRenderer({ antialias: true })` 는 기본 프레임버퍼에만 MSAA 를
//   건다. 컴포저(`?post=0` 이 아닌 한 상시 ON)가 씬을 오프스크린 HalfFloat 타깃에 그리는 순간
//   그 플래그는 무효가 되고, three 의 `EffectComposer` 는 기본 타깃에 `samples` 를 주지 않는다.
//   즉 **제품 화면 전체가 AA 없이** 렌더됐고, 이를 잡는 게이트가 없어서 결함이 계속 남았다.
//   이 게이트가 그 축을 고정한다.
//
// 판정 축 두 개:
//   (1) 계약: 앱 기본 경로의 samples > 0, 씬 전용 멀티샘플 타깃이 실제 할당됨,
//       패스 순서가 Render… → Output 계약을 유지(Output 이 마지막).
//   (2) 픽셀: 같은 결정론 씬을 `?msaa=0`(회귀 상태)과 기본값으로 각각 렌더해
//       인접 픽셀 휘도 스텝 분포를 비교한다(tools/lib/png-metrics.mjs edgeStepProfile).
//       MSAA 는 하드 스텝(전대비 1픽셀 점프 = 계단)을 부분피복 소프트 스텝으로 쪼갠다.
//
// 통제변수 — 이 게이트가 지켜야 하는 가장 중요한 성질이다.
//   `?msaa=0` 을 별도로 재로딩해 짝을 찍으면 두 컷이 서로 다른 실시간을 지난다. 마을 도착
//   돌리는 시간 기반이라 프레임이 느린 쪽이 덜 진행되어 구도가 달라지고, 마을 구름은 shot
//   모드에서도 표류해 구름 그림자·노출이 달라진다. 그러면 측정된 델타에 AA 가 아닌 성분이
//   섞인다. 그래서 이 게이트는 **한 번만 로드하고**, 카메라가 실제로 정착할 때까지 상태로
//   기다린 뒤(rAF 개수 대기 금지 — 머신 속도 종속), `window.__aa.setSamples()` 로 같은 프레임
//   근방에서 4 → 0 을 뒤집는다. 카메라 pose 완전 일치와 평탄 하늘 패치 차이를 함께 단정한다.
//
// 임계값은 추측이 아니라 그 통제 아래 실측으로 정했다
// (1280x720 / DPR 1 / 정착 부감 / sunset / autumn, Chrome ANGLE Metal Apple M1 Pro, maxSamples=4):
//   회귀(samples=0) : hardDensity 0.02101  softRatio 3.79  meanGradient 3.768
//   수정본(samples=4): hardDensity 0.01309  softRatio 7.07  meanGradient 3.416
//   → hardDensity −37.7%, softRatio +86.4%. 요구 폭은 그 절반 수준(hard −20% 이상,
//     softRatio +40% 이상)으로 잡았다. 남은 여유는 백엔드 차이(Playwright 번들 Chromium
//     소프트 렌더러)와 씬 튜닝 드리프트 몫이다. 회귀 상태의 델타는 정의상 0% 이므로 이
//     임계는 samples=0 을 항상 잡는다.
//
// 부감 프레임을 쓰는 이유: DoF amount 가 0 이고 flare 가 off 라 프레임 전체가 선명해 이 축이
//   순수하게 기하 에지만 본다. **근접 DoF 프레임에서는 이 축을 쓸 수 없다** — 같은 통제 아래
//   측정하면 근접 프레임의 hardDensity 는 오히려 +27~30% 오른다. MSAA 가 점표집이 통째로
//   놓치던 서브픽셀 기왓골 스페큘러를 부분피복으로 회복시켜 in-focus 피사체의 국소 대비를
//   올리기 때문이다(같은 프레임에서 고립 스펙클의 peak 진폭은 야간 −68% 로 내려간다).
//   즉 근접 프레임의 상승은 AA 결함이 아니라 회복된 디테일이며, 자동 판정이 아니라
//   `shoot:aa` 직접 판정 대상이다.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "../app/node_modules/vite/dist/node/index.js";
import {
  launchVerificationBrowser,
  reportWebGLRenderer,
} from "./lib/verification-browser.mjs";
import { edgeStepProfile, lineEdgeProfile } from "./lib/png-metrics.mjs";
import { PNG } from "pngjs";

// 평탄 패치 채널 평균. 통제(구름·조명 무변)를 스스로 확인하기 위한 최소 계산이다.
function patchMean(buffer, patch) {
  const png = PNG.sync.read(buffer);
  const { width, data } = png;
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = patch.y0; y <= patch.y1; y++) {
    for (let x = patch.x0; x <= patch.x1; x++) {
      const i = (y * width + x) * 4;
      r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
    }
  }
  return n ? [r / n, g / n, b / n] : [0, 0, 0];
}

const ROOT = resolve(import.meta.dirname, "..");
const APP_ROOT = join(ROOT, "app");

// 결정론 부감 프레임. shot=1 은 UI 크롬을 걷어내고 시간 스냅을 강제한다(트윈-인 배제).
const SCENE_QUERY =
  "?hero=0&village=1&worker=0&shot=1&seed=42&vseed=20260716" +
  "&time=sunset&season=autumn&weather=clear&vscale=village";
const VIEWPORT = { width: 1280, height: 720 };
// 마을 지붕·담장·능선이 드는 중앙 크롭. 상단 하늘과 하단 프레임 밖 여백을 제외한다.
const CROP = { x0: 180, y0: 130, x1: 1100, y1: 620 };
// 기하가 없는 평탄 하늘 패치. MSAA 는 매끈한 그라디언트를 바꿀 수 없으므로 여기의 평균이 크게
//   움직이면 통제가 깨진 것이다(구름 표류·조명 트윈이 두 컷 사이에 진행됐다는 뜻).
const SKY_PATCH = { x0: 40, y0: 8, x1: 200, y1: 40 };
const MAX_FLAT_SKY_DRIFT = 3.0;
// 실측 델타의 약 절반 — 회귀/수정본 분리는 보장하고 씬 튜닝 드리프트에는 견딘다.
const MIN_HARD_DROP = 0.20;
const MIN_SOFT_RATIO_GAIN = 0.40;
// 보조축(수묵 트랙과 공유하는 정의 — png-metrics.mjs lineEdgeProfile).
//   이 크롭 실측: cliffRatio 18.8% → 15.7% (상대 −16.7%), lineMeanGradient 41.8 → 38.7 (−7.4%).
//   요구 폭은 그 절반(−8%). 프레임 전체로 재면 분리 폭이 −8.0% 로 좁아지는데(UI·하늘 여백이
//   선 화소 분모를 부풀린다) 게이트는 크롭으로만 판정한다.
//   선 화소 조건부 meanGrad 는 근접 DoF 프레임까지 부호를 지키는 유일한 축이라 함께 기록한다.
const MIN_CLIFF_DROP = 0.08;
// 앱 데스크톱 프로파일. 하드웨어 상한이 더 낮으면 그 상한이 정답이므로 min 으로 판정한다
//   (M1 Pro ANGLE Metal 의 MAX_SAMPLES 는 정확히 4).
const REQUESTED_DESKTOP_SAMPLES = 4;

const outputDir = process.env.CHEOMA_AA_OUT
  ? resolve(process.env.CHEOMA_AA_OUT)
  : await mkdtemp(join(tmpdir(), "cheoma-aa-"));
await mkdir(outputDir, { recursive: true });
const cacheDir = await mkdtemp(join(tmpdir(), "cheoma-aa-cache-"));

const failures = [];
const rows = [];
const server = await createServer({
  root: APP_ROOT,
  configFile: join(APP_ROOT, "vite.config.js"),
  cacheDir,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false },
});

let browser;
try {
  await server.listen();
  const port = server.httpServer.address().port;
  browser = await launchVerificationBrowser();
  const page = await browser.newPage({ viewport: VIEWPORT });
  page.setDefaultTimeout(180_000);
  await page.addInitScript(() => { window.__noWarm = true; });
  const errors = [];
  page.on("pageerror", (error) => errors.push(`page: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error" && !/favicon|404/i.test(message.text()))
      errors.push(`console: ${message.text()}`);
  });

  await page.goto(`http://127.0.0.1:${port}/${SCENE_QUERY}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__SHOT_READY === true && !!window.__engine);
  await page.waitForFunction(
    () => window.__engine?.village?.debugPlan?.()?.seed === 20260716,
  );
  await reportWebGLRenderer(page, "aa");

  // 상태 기반 정착: 마을 카메라 전환·DoF 트윈 종료 + 연속 프레임 pose 정지.
  await page.waitForFunction(() => {
    const engine = window.__engine;
    if (!engine) return false;
    if (engine.village?.debugCamera?.()?.transitioning) return false;
    return engine.debugDof?.().tweenProgress == null;
  });
  const settle = await page.evaluate(() => new Promise((done) => {
    const engine = window.__engine;
    const pose = () => {
      const c = engine.camera.position, t = engine.__controls.target;
      return [c.x, c.y, c.z, t.x, t.y, t.z];
    };
    let previous = pose();
    let stable = 0, frames = 0;
    const tick = () => {
      const now = pose();
      const moved = now.reduce((m, v, i) => Math.max(m, Math.abs(v - previous[i])), 0);
      previous = now;
      stable = moved < 1e-4 ? stable + 1 : 0;
      if (stable >= 6 || ++frames > 600) { done({ frames, settled: stable >= 6 }); return; }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }));
  rows.push(["settle", JSON.stringify(settle)]);
  if (!settle.settled) failures.push("카메라가 정착하지 않았다 — 통제되지 않은 A/B");

  const capture = async (label, samples) => {
    const state = await page.evaluate(async (n) => {
      window.__aa.setSamples(n);
      await new Promise((done) => {
        let i = 0;
        const tick = () => (++i < 3 ? requestAnimationFrame(tick) : done());
        requestAnimationFrame(tick);
      });
      const engine = window.__engine;
      const c = engine.camera.position, t = engine.__controls.target;
      return {
        aa: {
          samples: window.__aa.samples,
          allocated: window.__aa.allocated,
          resolveCount: window.__aa.resolveCount,
          sampleBytes: window.__aa.sampleBytes,
          pixelRatio: window.__aa.pixelRatio,
          width: window.__aa.width,
          height: window.__aa.height,
          maxSamples: window.__aa.maxSamples,
        },
        passes: engine.debugPostPassOrder?.() ?? null,
        resolution: engine.debugPostResolution?.() ?? null,
        dofAmount: engine.debugDof?.()?.amount ?? null,
        pose: [c.x, c.y, c.z, t.x, t.y, t.z].map((v) => Number(v.toFixed(4))),
      };
    }, samples);
    const buffer = await page.screenshot();
    await writeFile(join(outputDir, `aa-${label}.png`), buffer);
    const profile = edgeStepProfile(buffer, CROP);
    const lineProfile = lineEdgeProfile(buffer, CROP);
    rows.push([label, JSON.stringify({
      aa: state.aa, dofAmount: state.dofAmount, pose: state.pose, resolution: state.resolution,
    })]);
    rows.push([`${label}/edges`, JSON.stringify({
      hardDensity: Number(profile.hardDensity.toFixed(5)),
      softRatio: Number(profile.softRatio.toFixed(2)),
      meanGradient: Number(profile.meanGradient.toFixed(3)),
      pairs: profile.pairs,
    })]);
    rows.push([`${label}/lineEdges`, JSON.stringify({
      lineRatio: Number((lineProfile.lineRatio * 100).toFixed(2)),
      lineMeanGradient: Number(lineProfile.lineMeanGradient.toFixed(1)),
      cliffRatio: Number((lineProfile.cliffRatio * 100).toFixed(1)),
      rampRatio: Number((lineProfile.rampRatio * 100).toFixed(1)),
    })]);
    return { state, profile, lineProfile, buffer, errors: errors.slice() };
  };

  const product = await capture("product", REQUESTED_DESKTOP_SAMPLES);
  const regression = await capture("regression-msaa0", 0);

  // 통제 단정: 같은 카메라 pose, 평탄 하늘 무변.
  if (JSON.stringify(product.state.pose) !== JSON.stringify(regression.state.pose)) {
    failures.push(
      `두 컷의 카메라 pose 가 다르다 — AA 만의 델타가 아니다 ` +
      `(${JSON.stringify(product.state.pose)} vs ${JSON.stringify(regression.state.pose)})`,
    );
  }
  const skyProduct = patchMean(product.buffer, SKY_PATCH);
  const skyRegression = patchMean(regression.buffer, SKY_PATCH);
  const skyDrift = Math.max(...skyProduct.map((v, i) => Math.abs(v - skyRegression[i])));
  rows.push(["flatSky", JSON.stringify({
    product: skyProduct.map((v) => Number(v.toFixed(2))),
    regression: skyRegression.map((v) => Number(v.toFixed(2))),
    drift: Number(skyDrift.toFixed(2)),
  })]);
  if (!(skyDrift <= MAX_FLAT_SKY_DRIFT)) {
    failures.push(
      `평탄 하늘 패치가 ${skyDrift.toFixed(2)} 만큼 변했다(상한 ${MAX_FLAT_SKY_DRIFT}) — ` +
      `MSAA 는 매끈한 그라디언트를 바꿀 수 없으므로 구름/조명 상태가 두 컷 사이에 진행됐다`,
    );
  }

  // ---- (1) 계약 ----
  if (!product.state.aa) failures.push("window.__aa 훅이 없다 — post.js MSAA 배선 누락");
  else {
    const expected = Math.min(REQUESTED_DESKTOP_SAMPLES, product.state.aa.maxSamples || 0);
    if (!(expected >= 2)) {
      failures.push(`하드웨어 maxSamples=${product.state.aa.maxSamples} — MSAA 불가 환경`);
    } else if (product.state.aa.samples !== expected) {
      failures.push(
        `기본 samples=${product.state.aa.samples} (기대 ${expected}); ` +
        `maxSamples=${product.state.aa.maxSamples}`,
      );
    }
    if (!product.state.aa.allocated) failures.push("멀티샘플 씬 타깃이 할당되지 않았다");
    if (!(product.state.aa.resolveCount > 0)) failures.push("resolve blit 이 한 번도 실행되지 않았다");
    if (!(product.state.aa.sampleBytes > 0)) failures.push("sampleBytes=0 — 멀티샘플 버퍼 미할당");
  }
  if (regression.state.aa && regression.state.aa.samples !== 0) {
    failures.push(`?msaa=0 이 회귀 상태를 만들지 못했다 (samples=${regression.state.aa.samples})`);
  }
  if (regression.state.aa?.allocated) {
    failures.push("samples=0 인데 멀티샘플 타깃이 할당됐다 — stock 경로 폴백 실패");
  }
  const passes = product.state.passes;
  if (!Array.isArray(passes) || passes.length === 0) failures.push("패스 순서를 읽을 수 없다");
  else {
    if (passes[0] !== "RenderPass") failures.push(`첫 패스가 RenderPass 가 아니다: ${passes[0]}`);
    if (passes[passes.length - 1] !== "OutputPass") {
      failures.push(`마지막 패스가 OutputPass 가 아니다: ${passes.join(" → ")}`);
    }
  }
  rows.push(["passOrder", (passes || []).join(" → ")]);

  // ---- (2) 픽셀 ----
  const hardDrop = regression.profile.hardDensity > 0
    ? 1 - product.profile.hardDensity / regression.profile.hardDensity
    : 0;
  const softGain = regression.profile.softRatio > 0
    ? product.profile.softRatio / regression.profile.softRatio - 1
    : 0;
  rows.push(["delta", JSON.stringify({
    hardDrop: Number(hardDrop.toFixed(4)),
    softRatioGain: Number(softGain.toFixed(4)),
  })]);
  if (!(hardDrop >= MIN_HARD_DROP)) {
    failures.push(
      `하드 스텝 밀도 감소 ${(hardDrop * 100).toFixed(1)}% < 요구 ${(MIN_HARD_DROP * 100).toFixed(0)}% ` +
      `(회귀 ${regression.profile.hardDensity.toFixed(5)} → 제품 ${product.profile.hardDensity.toFixed(5)})`,
    );
  }
  const cliffDrop = regression.lineProfile.cliffRatio > 0
    ? 1 - product.lineProfile.cliffRatio / regression.lineProfile.cliffRatio
    : 0;
  const lineGradDrop = regression.lineProfile.lineMeanGradient > 0
    ? 1 - product.lineProfile.lineMeanGradient / regression.lineProfile.lineMeanGradient
    : 0;
  rows.push(["lineDelta", JSON.stringify({
    cliffDrop: Number(cliffDrop.toFixed(4)),
    lineMeanGradientDrop: Number(lineGradDrop.toFixed(4)),
  })]);
  if (!(cliffDrop >= MIN_CLIFF_DROP)) {
    failures.push(
      `선 화소 절벽 비율 감소 ${(cliffDrop * 100).toFixed(1)}% < 요구 ${(MIN_CLIFF_DROP * 100).toFixed(0)}% ` +
      `(회귀 ${(regression.lineProfile.cliffRatio * 100).toFixed(1)}% → ` +
      `제품 ${(product.lineProfile.cliffRatio * 100).toFixed(1)}%)`,
    );
  }
  if (!(softGain >= MIN_SOFT_RATIO_GAIN)) {
    failures.push(
      `softRatio 증가 ${(softGain * 100).toFixed(1)}% < 요구 ${(MIN_SOFT_RATIO_GAIN * 100).toFixed(0)}% ` +
      `(회귀 ${regression.profile.softRatio.toFixed(2)} → 제품 ${product.profile.softRatio.toFixed(2)})`,
    );
  }

  if (product.errors.length) failures.push(`페이지 오류: ${product.errors.join(" | ")}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  await server.close().catch(() => {});
  await rm(cacheDir, { recursive: true, force: true }).catch(() => {});
}

const pad = Math.max(...rows.map(([k]) => k.length), 8);
for (const [k, v] of rows) console.log(`${k.padEnd(pad)}  ${v}`);
console.log(`captures: ${outputDir}`);
if (failures.length) {
  console.error("\nAA: FAIL");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("\nAA: PASS");
