// AA A/B 판정 컷 — 같은 페이지·같은 카메라·같은 구름 상태에서 samples 만 뒤집는다.
//
// 통제변수 (라운드 1 판정에서 실패했던 지점이다):
//   `?msaa=0` 재로딩으로 짝을 찍으면 두 컷이 서로 다른 실시간을 지난다. 마을 도착 돌리는
//   시간 기반이라 프레임이 느린 쪽이 덜 진행되어 **구도가 달라지고**, 마을 구름은 shot 모드에서도
//   `t` 로 표류하므로 **구름 그림자·노출이 달라진다**. 그 상태에서는 AA 만의 차이를 분리할 수 없다.
//   그래서 이 도구는 페이지를 한 번만 로드하고,
//     ① 카메라가 실제로 정착할 때까지 상태로 기다린 뒤(프레임 수 대기 금지 — 머신 속도 종속),
//     ② `window.__aa.setSamples()` 로 같은 프레임 근방에서 4 → 0 을 뒤집어 두 장을 찍는다.
//   두 컷 간 실시간 간격은 수십 ms 라 구름 위상 차이가 무시할 수준이다. 아래 `control` 행이
//   평탄 하늘 패치와 카메라 pose 로 그 통제가 실제로 성립했는지 스스로 보고한다.
//
// 장면 3종:
//   ① aerial-sunset : 마을 부감. 골든아워 역광(앱 기본 프레이밍). DoF amount 0 → 프레임 전체 선명.
//   ② focus-sunset  : 근접 기와집. 처마선·기왓골. DoF 판정문(_wt-out/verdict-round1.md 항목 3)의
//                     배경 지붕 스펙클 좌표를 같은 프레임·같은 크롭으로 정량 재측정한다.
//   ③ focus-night   : 야간. 등롱·창불 주변 고대비 에지.
//
// URL 은 shoot-dof-layers.mjs 와 동일하게 유지한다(판정문 좌표 유효).
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "../app/node_modules/vite/dist/node/index.js";
import {
  launchVerificationBrowser,
  reportWebGLRenderer,
} from "./lib/verification-browser.mjs";
import { edgeStepProfile, isolatedBrightSpecks } from "./lib/png-metrics.mjs";
import { PNG } from "pngjs";

const ROOT = resolve(import.meta.dirname, "..");
const APP_ROOT = join(ROOT, "app");
const VIEWPORT = { width: 1280, height: 720 };
// 판정문 항목 3 이 지목한 배경 지붕 영역(1280x720 focus 프레임 좌표계).
const SPECKLE_CROP = { x0: 430, y0: 160, x1: 760, y1: 270 };
const FRAME_CROP = { x0: 180, y0: 130, x1: 1100, y1: 620 };
// 통제 확인용 평탄 패치: 기하가 없는 하늘. MSAA 는 매끈한 그라디언트를 바꿀 수 없으므로 여기의
//   평균이 움직이면 그건 AA 가 아니라 조명·구름 상태 차이다.
const SKY_PATCHES = [
  { name: "skyTopLeft", x0: 40, y0: 8, x1: 200, y1: 40 },
  { name: "skyTopMid", x0: 600, y0: 4, x1: 720, y1: 24 },
];

const outputDir = process.env.CHEOMA_AA_SHOT_OUT
  ? resolve(process.env.CHEOMA_AA_SHOT_OUT)
  : await mkdtemp(join(tmpdir(), "cheoma-aa-shot-"));
await mkdir(outputDir, { recursive: true });
const cacheDir = await mkdtemp(join(tmpdir(), "cheoma-aa-shot-cache-"));

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
  page.on("pageerror", (error) => console.error(`  page error: ${error.message}`));

  let reported = false;
  const load = async (timeOfDay) => {
    const q =
      `?hero=0&village=1&worker=0&shot=1&seed=42&vseed=20260716` +
      `&time=${timeOfDay}&season=autumn&weather=clear`;
    await page.goto(`http://127.0.0.1:${port}/${q}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__SHOT_READY === true && !!window.__engine);
    await page.waitForFunction(
      () => window.__engine?.village?.debugPlan?.()?.seed === 20260716,
    );
    if (!reported) { await reportWebGLRenderer(page, "aa-shot"); reported = true; }
  };

  // 상태 기반 정착: 마을 카메라 전환·DoF 트윈이 끝나고, 카메라 pose 가 연속 프레임에서
  //   실제로 멈출 때까지 기다린다. rAF 개수 대기는 머신 속도에 종속돼 이 라운드의 구도
  //   불일치를 만들었다.
  const settleCamera = async () => {
    await page.waitForFunction(() => {
      const engine = window.__engine;
      if (!engine) return false;
      if (engine.village?.debugCamera?.()?.transitioning) return false;
      return engine.debugDof?.().tweenProgress == null;
    });
    return page.evaluate(() => new Promise((done) => {
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
        if (stable >= 6 || ++frames > 600) {
          done({ frames, moved: Number(moved.toFixed(6)) });
          return;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }));
  };

  // shoot-dof-layers.mjs 와 동일한 결정론 초점 시퀀스.
  const focusSubject = () => page.evaluate(async () => {
    const engine = window.__engine;
    const parcels = engine.village.debugParcels();
    const regular = parcels.filter((p) => !p.hero && p.editable);
    const id = regular.find((p) => p.kind === "giwa")?.parcelId || regular[0]?.parcelId;
    if (!id) throw new Error("no deterministic focus candidate");
    engine.village.focus(id);
    for (let i = 0; i < 4; i++) await Promise.resolve();
    engine.debugDofSeek(1, { finish: true });
    for (let i = 0; i < 40; i++) engine.debugAdvancePostQuality(1 / 60);
    engine.debugAdvanceFocusRing(0);
    engine.debugRenderDofFrame();
    const dof = engine.debugDof();
    return { parcelId: id, focus: dof.focus, amount: dof.amount, taps: dof.taps };
  });

  const applySamples = (samples) => page.evaluate(async (n) => {
    const applied = window.__aa.setSamples(n);
    await new Promise((done) => {
      let i = 0;
      const tick = () => (++i < 3 ? requestAnimationFrame(tick) : done());
      requestAnimationFrame(tick);
    });
    const engine = window.__engine;
    const c = engine.camera.position, t = engine.__controls.target;
    return {
      applied,
      allocated: window.__aa.allocated,
      sampleBytes: window.__aa.sampleBytes,
      pose: [c.x, c.y, c.z, t.x, t.y, t.z].map((v) => Number(v.toFixed(4))),
    };
  }, samples);

  // 한 장면에서 samples 4 → 0 짝을 연속 캡처하고, 통제(카메라 pose·평탄 하늘)를 함께 보고한다.
  const shootPair = async (scene) => {
    const shots = {};
    for (const [label, samples] of [["after", 4], ["before-msaa0", 0]]) {
      const state = await applySamples(samples);
      const buffer = await page.screenshot();
      await writeFile(join(outputDir, `${label}-${scene}.png`), buffer);
      const frame = edgeStepProfile(buffer, FRAME_CROP);
      const speck = isolatedBrightSpecks(buffer, SPECKLE_CROP);
      shots[label] = { state, buffer, frame, speck };
      rows.push([`${label}-${scene}`, JSON.stringify({
        samples: state.applied,
        allocated: state.allocated,
        hardDensity: Number(frame.hardDensity.toFixed(5)),
        softRatio: Number(frame.softRatio.toFixed(2)),
        meanGradient: Number(frame.meanGradient.toFixed(3)),
        specksInVerdictCrop: speck.specks,
        speckPeakDelta: Number(speck.peakDelta.toFixed(1)),
      })]);
    }
    // 통제 증거: 카메라 pose 완전 일치 + 평탄 하늘 패치 채널 평균 차이.
    const poseEqual = JSON.stringify(shots.after.state.pose)
      === JSON.stringify(shots["before-msaa0"].state.pose);
    const sky = SKY_PATCHES.map((patch) => {
      const a = patchMean(shots.after.buffer, patch);
      const b = patchMean(shots["before-msaa0"].buffer, patch);
      return `${patch.name} d=[${a.map((v, i) => (v - b[i]).toFixed(2)).join(",")}]`;
    });
    rows.push([`${scene}/control`, JSON.stringify({
      cameraPoseIdentical: poseEqual,
      pose: shots.after.state.pose,
      flatSky: sky,
      hardDrop: Number((1 - shots.after.frame.hardDensity
        / shots["before-msaa0"].frame.hardDensity).toFixed(4)),
      softRatioGain: Number((shots.after.frame.softRatio
        / shots["before-msaa0"].frame.softRatio - 1).toFixed(4)),
      specks: [shots["before-msaa0"].speck.specks, shots.after.speck.specks],
    })]);
  };

  // ① 부감 골든아워 (역광 기본 프레이밍)
  await load("sunset");
  rows.push(["aerial-sunset/settle", JSON.stringify(await settleCamera())]);
  await shootPair("aerial-sunset");

  // ② 근접 기와집 (판정문 스펙클 좌표와 같은 프레임)
  rows.push(["focus-sunset/focus", JSON.stringify(await focusSubject())]);
  rows.push(["focus-sunset/settle", JSON.stringify(await settleCamera())]);
  await shootPair("focus-sunset");

  // ③ 야간 근접
  await load("night");
  await settleCamera();
  rows.push(["focus-night/focus", JSON.stringify(await focusSubject())]);
  rows.push(["focus-night/settle", JSON.stringify(await settleCamera())]);
  await shootPair("focus-night");
} finally {
  if (browser) await browser.close().catch(() => {});
  await server.close().catch(() => {});
  await rm(cacheDir, { recursive: true, force: true }).catch(() => {});
}

const pad = Math.max(...rows.map(([k]) => k.length), 8);
for (const [k, v] of rows) console.log(`${k.padEnd(pad)}  ${v}`);
console.log(`captures: ${outputDir}`);
