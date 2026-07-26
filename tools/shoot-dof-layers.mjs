// Depth-layer judgment cuts for the physical CoC restoration.
//
// docs/dof-cinematic-research.md §6.1: hold the camera and the scene fixed and
// move only the focus plane. If the three cuts are not visibly different, the
// frame has no depth layers. Under the former 3.25px surface cap they were
// effectively identical, which is the regression this round removes.
//
// Also captures the aerial zero-cost frame (criterion 5) and a night frame where
// the compact-source scatter owns the lantern discs (criterion 3).
//
// Captures go to a scratch directory and are meant for direct inspection.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "../app/node_modules/vite/dist/node/index.js";
import {
  launchVerificationBrowser,
  reportWebGLRenderer,
} from "./lib/verification-browser.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const APP_ROOT = join(ROOT, "app");
const outputDir = process.env.CHEOMA_DOF_LAYERS_OUT
  ? resolve(process.env.CHEOMA_DOF_LAYERS_OUT)
  : await mkdtemp(join(tmpdir(), "cheoma-dof-layers-"));
await mkdir(outputDir, { recursive: true });
const cacheDir = await mkdtemp(join(tmpdir(), "cheoma-dof-layers-cache-"));
const label = process.env.CHEOMA_DOF_LAYERS_LABEL || "current";
// Same-binary counterfactual: force the CoC clamp back down to the former 3.25px
// surface radius. Everything else - kernel, gather, composite, scatter - is
// identical, so a flat three-cut result under this override and a separated one
// without it isolates that clamp as the cause (docs/dof-cinematic-research.md §3.1).
const forcedMaxCocPx = Number(process.env.CHEOMA_DOF_LAYERS_MAX_COC_PX) || 0;

const server = await createServer({
  root: APP_ROOT,
  configFile: join(APP_ROOT, "vite.config.js"),
  cacheDir,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false },
});

let browser;
const errors = [];
const rows = [];
try {
  await server.listen();
  const port = server.httpServer.address().port;
  browser = await launchVerificationBrowser();
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.setDefaultTimeout(180_000);
  await page.addInitScript(() => {
    window.__noWarm = true;
  });
  page.on("pageerror", (error) => errors.push(`page: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error" && !/favicon|404/i.test(message.text()))
      errors.push(`console: ${message.text()}`);
  });

  const shoot = async (name) => {
    const file = join(outputDir, `${label}-${name}.png`);
    await page.screenshot({ path: file });
    return file;
  };

  for (const [sceneName, timeOfDay] of [
    ["sunset", "sunset"],
    ["night", "night"],
  ]) {
    await page.goto(
      `http://127.0.0.1:${port}/?hero=0&village=1&worker=0&shot=1` +
        `&seed=42&vseed=20260716&time=${timeOfDay}&season=autumn&weather=clear`,
      { waitUntil: "domcontentloaded" },
    );
    await page.waitForFunction(
      () => window.__SHOT_READY === true && !!window.__engine,
    );
    await page.waitForFunction(
      () => window.__engine?.village?.debugPlan?.()?.seed === 20260716,
    );
    if (sceneName === "sunset") await reportWebGLRenderer(page, "dof-layers");

    // Aerial: amount 0, pass disabled, and the half-resolution targets must not
    // even be allocated yet.
    const aerial = await page.evaluate(() => {
      const dof = window.__engine.debugDof();
      return {
        enabled: dof.enabled,
        amount: dof.amount,
        aperture: dof.aperture,
        cocScalePx: dof.cocScalePx,
        gatherAllocated: dof.gatherAllocated,
        gatherRenderCount: dof.gatherRenderCount,
      };
    });
    rows.push([`${sceneName}/aerial`, JSON.stringify(aerial)]);
    if (sceneName === "sunset") await shoot("aerial");

    const parcelId = await page.evaluate(() => {
      const parcels = window.__engine.village.debugParcels();
      const regular = parcels.filter(
        (parcel) => !parcel.hero && parcel.editable,
      );
      return (
        regular.find((parcel) => parcel.kind === "giwa")?.parcelId ||
        regular[0]?.parcelId
      );
    });
    if (!parcelId) throw new Error("no deterministic focus candidate");

    const settled = await page.evaluate(async (id) => {
      const engine = window.__engine;
      engine.village.focus(id);
      for (let i = 0; i < 4; i++) await Promise.resolve();
      engine.debugDofSeek(1, { finish: true });
      for (let i = 0; i < 40; i++) engine.debugAdvancePostQuality(1 / 60);
      engine.debugAdvanceFocusRing(0);
      engine.debugRenderDofFrame();
      const dof = engine.debugDof();
      return {
        parcelId: id,
        focus: dof.focus,
        anchorWorld: dof.anchorWorld,
        fov: dof.fov,
        cocScalePx: dof.cocScalePx,
        maxCocPx: dof.maxCocPx,
        farAsymptotePx: dof.farAsymptotePx,
        apertureMeters: dof.apertureMeters,
        taps: dof.taps,
        baseTaps: dof.baseTaps,
        fillWeight: dof.fillWeight,
        gatherAllocated: dof.gatherAllocated,
        gatherWidth: dof.gatherWidth,
        gatherHeight: dof.gatherHeight,
        sourceRadiusScale: dof.sourceRadiusScale,
      };
    }, parcelId);
    rows.push([`${sceneName}/settled`, JSON.stringify(settled)]);

    if (forcedMaxCocPx > 0) {
      const forced = await page.evaluate((maxCocPx) => {
        const engine = window.__engine;
        const height = engine.renderer.domElement.height;
        const fraction = maxCocPx / height;
        engine.debugTuneDof({ maxCocFraction: fraction });
        engine.debugRenderDofFrame();
        const dof = engine.debugDof();
        return { height, fraction, maxCocPx: dof.maxCocPx };
      }, forcedMaxCocPx);
      rows.push([`${sceneName}/forcedClamp`, JSON.stringify(forced)]);
    }

    // Three cuts: only the focus plane moves. The anchor is pushed along the
    // camera forward axis so the pose, the lens, and the scene are untouched.
    // The product focus is captured once: reading it back inside the loop would
    // measure the previous cut's displaced plane instead of the subject's.
    const productFocus = settled.focus;
    for (const [cut, delta] of [
      ["front", -25],
      ["subject", 0],
      ["back", 60],
    ]) {
      const state = await page.evaluate(
        ({ delta, id, productFocus }) => {
          const engine = window.__engine;
          const THREE_UP = engine.camera;
          const forward = { x: 0, y: 0, z: 0 };
          THREE_UP.updateMatrixWorld(true);
          const e = THREE_UP.matrixWorld.elements;
          // Third column negated is the camera's forward direction.
          forward.x = -e[8];
          forward.y = -e[9];
          forward.z = -e[10];
          const depth = productFocus + delta;
          const anchor = [
            THREE_UP.position.x + forward.x * depth,
            THREE_UP.position.y + forward.y * depth,
            THREE_UP.position.z + forward.z * depth,
          ];
          engine.debugSetDofAnchor(anchor);
          for (let i = 0; i < 20; i++) engine.debugAdvancePostQuality(1 / 60);
          engine.debugRenderDofFrame();
          const dof = engine.debugDof();
          return {
            parcel: id,
            focus: dof.focus,
            amount: dof.amount,
            cocScalePx: dof.cocScalePx,
            maxCocPx: dof.maxCocPx,
            farAsymptotePx: dof.farAsymptotePx,
          };
        },
        { delta, id: parcelId, productFocus },
      );
      rows.push([`${sceneName}/${cut}`, JSON.stringify(state)]);
      await shoot(`${sceneName}-${cut}`);
    }

    // Restore the product anchor and capture the real settled product frame.
    await page.evaluate(() => {
      const engine = window.__engine;
      engine.debugSetDofAnchor(null);
      for (let i = 0; i < 20; i++) engine.debugAdvancePostQuality(1 / 60);
      engine.debugRenderDofFrame();
    });
    await shoot(`${sceneName}-product`);

    // Moving state: base rings must keep running, so depth of field exists during
    // a dolly and settling cannot pop (criterion 4).
    const moving = await page.evaluate(() => {
      const engine = window.__engine;
      const fov = engine.camera.fov;
      engine.camera.fov = fov + 0.5;
      engine.camera.updateProjectionMatrix();
      engine.debugAdvancePostQuality(1 / 60);
      engine.camera.fov = fov;
      engine.camera.updateProjectionMatrix();
      const sample = engine.debugAdvancePostQuality(1 / 60);
      engine.debugRenderDofFrame();
      const dof = engine.debugDof();
      return {
        postQuality: sample.postQuality,
        mode: sample.postQualityMode,
        taps: dof.taps,
        baseTaps: dof.baseTaps,
        fillWeight: dof.fillWeight,
        activeBokehTaps: sample.activeBokehTaps,
      };
    });
    rows.push([`${sceneName}/moving`, JSON.stringify(moving)]);
    await shoot(`${sceneName}-moving`);
  }

  await page.close();
} catch (error) {
  errors.push(error.stack || error.message);
} finally {
  await browser?.close();
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
}

for (const [name, value] of rows) console.log(`${name}: ${value}`);
console.log(`\nshots: ${outputDir}`);
if (errors.length) {
  console.error(`\nERRORS (${errors.length}):`);
  for (const error of errors.slice(0, 10)) console.error(error);
  process.exitCode = 1;
}
