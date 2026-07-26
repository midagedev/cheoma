// 고해상도(R9) 판정 — 폰 pixelRatio 상한 1.5 vs 2, MSAA 유무와 교차.
//
// 감사 M1·R9 가 "실기기 A/B 미실시"를 이유로 PR_CAP 1.5 를 동결해 두었다. 헤드리스에서 절대
// 프레임 ms 는 증거가 못 되므로(ANGLE 이 셰이더 링크를 직렬화한다) 이 도구는 **픽셀 수·
// 렌더타깃 바이트·프로그램/텍스처 수**만 측정하고, 시각 차이는 같은 프레임 캡처로 남긴다.
//
// 통제변수: `?pr=N` 은 pixelRatio 상한만 뒤집는다(engine.js). 종전 `?fxcompact=0` 은 pixelRatio
//   와 저해상 bloom·수묵 타깃을 함께 되돌려 "1.5 대 2" 단독 비교가 불가능했다.
//   MSAA 축은 재로딩하지 않고 `window.__aa.setSamples()` 로 같은 페이지에서 뒤집는다 —
//   마을 도착 돌리가 시간 기반이라 재로딩 짝은 프레임이 느린 쪽이 덜 진행되어 구도가 달라지고,
//   그 상태의 에지 수치·시각 비교는 무효다. PR 축은 부팅 값이라 로드가 갈리지만, 두 로드 모두
//   카메라가 실제로 정착할 때까지 상태로 기다려 같은 pose 에서 찍는다(아래 pose 행이 증거다).
//
// 에뮬레이션: 390×844 논리 뷰포트 + deviceScaleFactor 3 (iPhone 14/15 급). 실제 폰 GPU 성능은
//   재현하지 않는다 — 그래서 결론은 "메모리·픽셀 수 상한"과 "시각 차이" 두 축으로만 낸다.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "../app/node_modules/vite/dist/node/index.js";
import {
  launchVerificationBrowser,
  reportWebGLRenderer,
} from "./lib/verification-browser.mjs";
import { edgeStepProfile } from "./lib/png-metrics.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const APP_ROOT = join(ROOT, "app");
const VIEWPORT = { width: 390, height: 844 };
const DEVICE_SCALE = 3;
// **스크린샷은 device 픽셀**이므로(390x844 논리 × deviceScaleFactor 3 = 1170x2532) 좌표도
//   device px 다. 네 변주 모두 같은 1170x2532 PNG 로 나오는 것이 오히려 정확한 비교다 —
//   실제 DPR 3 패널에서 PR 1.5 는 2배, PR 2 는 1.5배로 업스케일되어 보이는 그 상태를 담는다.
//
// 크롭은 **캔버스만** 덮어야 한다. 반투명 프로스트 패널을 통과한 DOM 텍스트 엣지가 섞이면
//   에지 수치가 UI 글자에 지배된다(전체 프레임으로 재면 3D 개선폭이 −8% 로 부풀고, 캔버스만
//   재면 실제값은 −2% 대다 — 라운드 2 판정 항목 3).
const CROP = { x0: 60, y0: 150, x1: 1110, y1: 1600 };

const outputDir = process.env.CHEOMA_DPR_OUT
  ? resolve(process.env.CHEOMA_DPR_OUT)
  : await mkdtemp(join(tmpdir(), "cheoma-dpr-"));
await mkdir(outputDir, { recursive: true });
const cacheDir = await mkdtemp(join(tmpdir(), "cheoma-dpr-cache-"));

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
  const page = await browser.newPage({
    viewport: VIEWPORT,
    deviceScaleFactor: DEVICE_SCALE,
    hasTouch: true,
    isMobile: true,
  });
  page.setDefaultTimeout(180_000);
  await page.addInitScript(() => { window.__noWarm = true; });
  page.on("pageerror", (error) => console.error(`  page error: ${error.message}`));

  let reported = false;
  // PR 축만 로드가 갈린다. 각 로드 안에서 MSAA 2 / 0 을 in-page 로 뒤집어 4조합을 만든다.
  //   pr1.5-msaa0 = 이 브랜치 이전의 현행 출하 폰 상태, pr1.5-msaa2 = 이 브랜치의 폰 기본값,
  //   pr2-msaa0 = R9 (ㄱ) "해상도만 올린다" 안, pr2-msaa2 = 폰 메모리 최악 조합.
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
        if (stable >= 6 || ++frames > 600) { done({ settled: stable >= 6, frames }); return; }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }));
  };

  for (const [pr, prLabel] of [[1.5, "pr1.5"], [2, "pr2"]]) {
    const q =
      `?hero=0&village=1&worker=0&shot=1&seed=42&vseed=20260716` +
      `&time=sunset&season=autumn&weather=clear&vscale=village&pr=${pr}`;
    await page.goto(`http://127.0.0.1:${port}/${q}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__SHOT_READY === true && !!window.__engine);
    await page.waitForFunction(
      () => window.__engine?.village?.debugPlan?.()?.seed === 20260716,
    );
    if (!reported) { await reportWebGLRenderer(page, "dpr"); reported = true; }
    rows.push([`${prLabel}/settle`, JSON.stringify(await settleCamera())]);

    for (const [scene, samples] of [
      ["aerial", 2], ["aerial", 0], ["focus", 2], ["focus", 0],
    ]) {
    // 근접 한옥 프레임: 폰에서 AA 가 실제로 갈리는 지점은 처마·기왓골·창호 살이고, 정착 부감은
    //   안개 지배 원경이라 세 안을 분리하지 못한다(라운드 2 판정 항목 4). 부감 짝을 찍은 뒤
    //   같은 로드에서 결정론 필지로 focus-in 해 근접 짝을 이어 찍는다.
    if (scene === "focus" && samples === 2) {
      rows.push([`${prLabel}/focus`, JSON.stringify(await page.evaluate(async () => {
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
        return { parcelId: id, focus: engine.debugDof().focus };
      }))]);
      rows.push([`${prLabel}/focusSettle`, JSON.stringify(await settleCamera())]);
    }
    const label = `${prLabel}-${scene}-msaa${samples}`;
    const stats = await page.evaluate(async (n) => {
      window.__aa.setSamples(n);
      await new Promise((done) => {
        let i = 0;
        const tick = () => (++i < 3 ? requestAnimationFrame(tick) : done());
        requestAnimationFrame(tick);
      });
      const engine = window.__engine;
      const res = engine.debugPostResolution?.() ?? {};
      // 노출된 풀스크린 타깃만 합산한다(bloom 밉·bokeh 내부 타깃·그림자맵은 제외 — 그 항목들은
      //   compact 프로파일이 별도로 관리하고, 여기서는 pixelRatio 에 정비례하는 축만 본다).
      const bytesOf = (t, bpp = 8) => (t ? t.width * t.height * bpp : 0);
      const r = engine.debugPostResources?.() ?? {};
      const c = engine.camera.position, tg = engine.__controls.target;
      const composerBytes = bytesOf(r.composerTarget1) + bytesOf(r.composerTarget2);
      const msaaResolveBytes = bytesOf(r.msaaTarget);
      const buffer = window.__aa
        ? { w: window.__aa.width, h: window.__aa.height }
        : { w: res.composer?.width ?? 0, h: res.composer?.height ?? 0 };
      return {
        devicePixelRatio: window.devicePixelRatio,
        rendererPixelRatio: res.pixelRatio ?? null,
        drawingBuffer: `${buffer.w}x${buffer.h}`,
        drawingBufferPx: buffer.w * buffer.h,
        msaaSamples: res.msaaSamples ?? null,
        msaaSampleBytes: res.msaaSampleBytes ?? 0,
        msaaResolveBytes,
        composerBytes,
        fullScreenTargetBytes: composerBytes + msaaResolveBytes + (res.msaaSampleBytes ?? 0),
        textures: res.textures ?? null,
        programs: res.programs ?? null,
        pose: [c.x, c.y, c.z, tg.x, tg.y, tg.z].map((v) => Number(v.toFixed(3))),
      };
    }, samples);

    const buffer = await page.screenshot();
    await writeFile(join(outputDir, `dpr-${label}.png`), buffer);
    const edges = edgeStepProfile(buffer, CROP);
    rows.push([label, JSON.stringify({
      ...stats,
      fullScreenTargetMB: Number((stats.fullScreenTargetBytes / 1048576).toFixed(1)),
      hardDensity: Number(edges.hardDensity.toFixed(5)),
      softRatio: Number(edges.softRatio.toFixed(2)),
    })]);
    }
  }
} finally {
  if (browser) await browser.close().catch(() => {});
  await server.close().catch(() => {});
  await rm(cacheDir, { recursive: true, force: true }).catch(() => {});
}

const pad = Math.max(...rows.map(([k]) => k.length), 8);
for (const [k, v] of rows) console.log(`${k.padEnd(pad)}  ${v}`);
console.log(`captures: ${outputDir}`);
