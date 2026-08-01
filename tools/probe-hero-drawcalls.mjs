// Scratch probe (not registered): hanyang aerial draw calls + village-heroes share.
// Uses direct renderer.render via village.debugDrawCalls (not the composer path).
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from '../app/node_modules/vite/dist/node/index.js';
import { launchVerificationBrowser, reportWebGLRenderer } from './lib/verification-browser.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const APP_ROOT = join(ROOT, 'app');
const cacheDir = await mkdtemp(join(tmpdir(), 'cheoma-hero-draw-'));

const server = await createServer({
  root: APP_ROOT,
  configFile: join(APP_ROOT, 'vite.config.js'),
  cacheDir,
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false },
});

let browser;
try {
  await server.listen();
  const port = server.httpServer.address().port;
  const base = `http://127.0.0.1:${port}`;
  browser = await launchVerificationBrowser();
  const context = await browser.newContext({ viewport: { width: 960, height: 640 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));

  // Match check-lod-app boot: skip title (hero=0), direct village (village=1).
  await page.goto(
    `${base}/?hero=0&village=1&worker=0&post=0&seed=42&vseed=20260716&vscale=hanyang&time=day`,
    { waitUntil: 'domcontentloaded', timeout: 120000 },
  );
  await page.waitForFunction(
    () => window.__SHOT_READY === true && !!window.__engine,
    null,
    { timeout: 120000 },
  );
  await page.waitForFunction(({ scale, seed }) => {
    const plan = window.__engine?.village?.debugPlan?.();
    return plan?.scale === scale && plan?.seed === seed;
  }, { scale: 'hanyang', seed: 20260716 }, { timeout: 120000 });
  await reportWebGLRenderer(page);

  await page.waitForFunction(
    () => !!window.__engine?.village?.exportRoot?.(),
    null,
    { timeout: 120000 },
  );

  await page.evaluate(() => new Promise((resolveFrame) => {
    let stable = 0;
    let previous = -1;
    let frames = 0;
    const step = () => {
      const geometries = window.__engine.renderer.info.memory.geometries;
      stable = geometries === previous ? stable + 1 : 0;
      previous = geometries;
      if (stable >= 8 || ++frames > 240) resolveFrame();
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }));

  const report = await page.evaluate(() => {
    const eng = window.__engine;
    const root = eng.village.exportRoot();
    const heroesGroup = root.getObjectByName('village-heroes');
    const heroHandle = root.userData.heroHandle;
    const heroIds = heroHandle ? [...heroHandle.keys()] : [];

    const measure = () => {
      eng.village.debugDrawCalls();
      return {
        calls: eng.renderer.info.render.calls,
        triangles: eng.renderer.info.render.triangles,
      };
    };

    const a = measure();
    const b = measure();

    let heroShare = null;
    const heroesChildren = heroesGroup ? heroesGroup.children.length : 0;
    if (heroesGroup) {
      const was = heroesGroup.visible;
      heroesGroup.visible = false;
      const off = measure();
      heroesGroup.visible = was;
      const on = measure();
      heroShare = {
        onCalls: on.calls,
        offCalls: off.calls,
        delta: on.calls - off.calls,
      };
    }

    const proxyKinds = heroIds.map((id) => {
      const h = heroHandle.get(id);
      return {
        id,
        isObject3D: !!(h && h.isObject3D),
        hasDispose: !!h?.userData?.disposeCompound,
      };
    });

    return {
      total: b,
      firstSample: a,
      plateau: a.calls === b.calls,
      heroesChildren,
      heroShare,
      heroIds,
      proxyKinds,
      handleSize: heroHandle?.size ?? 0,
    };
  });

  console.log(JSON.stringify(report, null, 2));
  console.log('--- summary ---');
  console.log(`total aerial calls: ${report.total.calls} (plateau=${report.plateau})`);
  console.log(`village-heroes material meshes: ${report.heroesChildren}`);
  console.log(`hero share delta (on-off): ${report.heroShare?.delta}`);
  console.log(`heroHandle size: ${report.handleSize}`);

  let ok = true;
  if (!report.heroesChildren || report.heroesChildren > 90) {
    console.error('FAIL: village-heroes material mesh count out of range', report.heroesChildren);
    ok = false;
  }
  if (report.heroShare && report.heroShare.delta > 90) {
    console.error('FAIL: hero share draw-call delta > 90', report.heroShare.delta);
    ok = false;
  }
  if (report.total.calls > 370) {
    console.error(`FAIL: total aerial calls ${report.total.calls} > 370`);
    ok = false;
  }
  if (!ok) process.exitCode = 1;
  else console.log('PROBE HERO DRAWCALLS: PASS');
} finally {
  if (browser) await browser.close();
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
}
