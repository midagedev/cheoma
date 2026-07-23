// Public src/api/building.js browser contract without booting Svelte, Vite,
// village runtime, or post-processing.
// The checked-in import map remains copyable CDN syntax while Playwright fulfills
// that exact pinned three release from app/node_modules for an offline-stable gate.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { launchVerificationBrowser, reportWebGLRenderer } from './lib/verification-browser.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const THREE_ROOT = resolve(ROOT, 'app/node_modules/three');
const THREE_CDN = 'https://cdn.jsdelivr.net/npm/three@0.185.1/';
const MIME = {
  '.css': 'text/css',
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function safeFile(root, relativePath) {
  const file = resolve(root, relativePath);
  if (file !== root && !file.startsWith(`${root}${sep}`)) throw new Error('unsafe path');
  return file;
}

const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    if (pathname === '/favicon.ico') {
      response.writeHead(204);
      response.end();
      return;
    }
    const relativePath = pathname === '/'
      ? 'examples/api-building/index.html'
      : `${pathname.slice(1)}${pathname.endsWith('/') ? 'index.html' : ''}`;
    const file = safeFile(ROOT, relativePath);
    const body = await readFile(file);
    response.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    response.end(body);
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('not found');
  }
});
await new Promise((resolveListen, reject) => {
  server.listen(0, '127.0.0.1', resolveListen).on('error', reject);
});

let browser = null;
try {
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  browser = await launchVerificationBrowser();
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const pageErrors = [];
  const consoleErrors = [];
  const unexpectedExternalRequests = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.startsWith(THREE_CDN)) {
      try {
        const relativePath = decodeURIComponent(url.slice(THREE_CDN.length));
        const file = safeFile(THREE_ROOT, relativePath);
        const body = await readFile(file);
        await route.fulfill({ status: 200, contentType: 'text/javascript', body });
      } catch {
        await route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' });
      }
      return;
    }
    if (url === origin || url.startsWith(`${origin}/`)) {
      await route.continue();
      return;
    }
    unexpectedExternalRequests.push(url);
    await route.abort('blockedbyclient');
  });

  await page.goto(`${origin}/examples/api-building/?smoke=1`, {
    waitUntil: 'load',
  });
  await page.waitForFunction(
    () => document.documentElement.dataset.apiBuildingReady === 'true'
      && !!window.__CHEOMA_API_BUILDING__,
    null,
    { timeout: 45000 },
  );

  const initial = await page.evaluate(() => window.__CHEOMA_API_BUILDING__.diagnostics());
  const buildingOnly = await page.evaluate(() => {
    const example = window.__CHEOMA_API_BUILDING__.example;
    const ground = example.scene.getObjectByName('api-building-example-ground');
    const sun = example.scene.children.find((object) => object.isDirectionalLight);
    ground.visible = false;
    example.renderer.render(example.scene, example.camera);
    const render = {
      calls: example.renderer.info.render.calls,
      triangles: example.renderer.info.render.triangles,
    };
    ground.visible = true;
    example.renderer.render(example.scene, example.camera);
    return {
      ...render,
      shadow: {
        left: sun.shadow.camera.left,
        right: sun.shadow.camera.right,
        near: sun.shadow.camera.near,
        far: sun.shadow.camera.far,
        projectionX: sun.shadow.camera.projectionMatrix.elements[0],
      },
    };
  });
  invariant(initial.revision === '185', `unexpected THREE.REVISION ${initial.revision}`);
  invariant(Object.values(initial.identity).every(Boolean),
    `building does not share the consumer's THREE prototypes: ${JSON.stringify(initial.identity)}`);
  invariant(initial.canvasConnected, 'renderer canvas is not connected');
  invariant(initial.render.calls > 0 && initial.render.triangles > 0,
    `building did not render: ${JSON.stringify(initial.render)}`);
  invariant(buildingOnly.calls > 0 && buildingOnly.triangles > 0,
    `building-only render submitted no geometry: ${JSON.stringify(buildingOnly)}`);
  invariant(
    buildingOnly.shadow.left === -18
      && buildingOnly.shadow.right === 18
      && buildingOnly.shadow.near === 1
      && buildingOnly.shadow.far === 120
      && Math.abs(buildingOnly.shadow.projectionX - 1 / 18) < 1e-9,
    `directional shadow camera was not projected from its authored frustum: ${JSON.stringify(buildingOnly.shadow)}`,
  );
  invariant(initial.bounds?.size.every((value) => Number.isFinite(value) && value > 0),
    `building bounds are invalid: ${JSON.stringify(initial.bounds)}`);

  if (process.env.CHEOMA_API_REUSE_CAPTURE) {
    await page.screenshot({ path: process.env.CHEOMA_API_REUSE_CAPTURE, fullPage: true });
    console.log(`api reuse capture=${process.env.CHEOMA_API_REUSE_CAPTURE}`);
  }
  await reportWebGLRenderer(page, 'api-reuse');

  const lifecycle = await page.evaluate(async () => {
    const apiUrl = new URL('/src/api/building.js', location.origin).href;
    const { PRESETS, buildBuilding, disposeBuilding } = await import(apiUrl);

    const owner = buildBuilding({ ...PRESETS.giwa });
    const sharedMaterials = owner.userData.materials;
    const paletteResources = new Set();
    for (const value of Object.values(sharedMaterials)) {
      if (value?.isTexture) paletteResources.add(value);
      if (!value?.isMaterial) continue;
      paletteResources.add(value);
      for (const property of Object.values(value)) {
        if (property?.isTexture) paletteResources.add(property);
      }
    }
    const sharedDisposals = new Map();
    for (const resource of paletteResources) {
      resource.addEventListener('dispose', () => {
        sharedDisposals.set(resource, (sharedDisposals.get(resource) || 0) + 1);
      });
    }
    const sharedDisposalCounts = () => [...paletteResources]
      .map((resource) => sharedDisposals.get(resource) || 0);

    const borrower = buildBuilding({ ...PRESETS.giwa, mats: sharedMaterials });
    const borrowerFirst = disposeBuilding(borrower);
    const borrowerSecond = disposeBuilding(borrower);
    const afterBorrower = sharedDisposalCounts();
    const ownerFirst = disposeBuilding(owner);
    const ownerSecond = disposeBuilding(owner);
    const afterOwner = sharedDisposalCounts();

    const samples = [];
    for (let index = 0; index < 6; index++) {
      const example = window.__CHEOMA_API_BUILDING__.example;
      const previous = example.building;
      const next = example.rebuild({ ...PRESETS.giwa });
      samples.push({
        geometries: example.renderer.info.memory.geometries,
        textures: example.renderer.info.memory.textures,
        programs: example.renderer.info.programs?.length ?? 0,
        replaced: next !== previous,
        previousDetached: previous.parent === null,
        previousAlreadyDisposed: disposeBuilding(previous) === false,
        currentAttached: next.parent === example.scene,
        buildingRoots: example.scene.children.filter(
          (object) => !!object.userData?.materials,
        ).length,
      });
    }

    const hook = window.__CHEOMA_API_BUILDING__;
    const ground = hook.example.scene.getObjectByName('api-building-example-ground');
    const sun = hook.example.scene.children.find((object) => object.isDirectionalLight);
    const ownedDisposals = {
      groundGeometry: 0,
      groundMaterial: 0,
      shadowMap: 0,
      renderer: 0,
    };
    ground.geometry.addEventListener('dispose', () => { ownedDisposals.groundGeometry++; });
    ground.material.addEventListener('dispose', () => { ownedDisposals.groundMaterial++; });
    const shadowMap = sun.shadow.map;
    shadowMap?.addEventListener('dispose', () => { ownedDisposals.shadowMap++; });
    const rendererDispose = hook.example.renderer.dispose.bind(hook.example.renderer);
    hook.example.renderer.dispose = () => {
      ownedDisposals.renderer++;
      return rendererDispose();
    };
    const currentRoot = hook.example.building;
    const resizeBefore = hook.diagnostics().resizeCalls;
    const firstDispose = hook.dispose();
    window.dispatchEvent(new Event('resize'));
    const resizeAfter = hook.diagnostics().resizeCalls;
    const secondDispose = hook.example.dispose();
    let rebuildRejected = false;
    try {
      hook.example.rebuild({ ...PRESETS.giwa });
    } catch {
      rebuildRejected = true;
    }

    return {
      borrowerFirst,
      borrowerSecond,
      ownerFirst,
      ownerSecond,
      afterBorrower,
      afterOwner,
      samples,
      firstDispose,
      secondDispose,
      rebuildRejected,
      resizeBefore,
      resizeAfter,
      canvasCount: document.querySelectorAll('canvas').length,
      hookPresent: '__CHEOMA_API_BUILDING__' in window,
      readyPresent: document.documentElement.dataset.apiBuildingReady !== undefined,
      sceneChildren: hook.example.scene.children.length,
      currentAlreadyDisposed: disposeBuilding(currentRoot) === false,
      ownedDisposals,
      shadowTextureRegistered: shadowMap
        ? hook.example.renderer.properties.has(shadowMap.texture)
        : null,
    };
  });

  invariant(lifecycle.borrowerFirst && !lifecycle.borrowerSecond,
    'borrower disposal is not successful and idempotent');
  invariant(lifecycle.ownerFirst && !lifecycle.ownerSecond,
    'owner disposal is not successful and idempotent');
  invariant(
    lifecycle.afterBorrower.length > 0
      && lifecycle.afterBorrower.every((count) => count === 0),
    `borrower disposed caller-owned resources: ${JSON.stringify(lifecycle.afterBorrower)}`);
  invariant(lifecycle.afterOwner.every((count) => count === 1),
    `owner resources were not released exactly once: ${JSON.stringify(lifecycle.afterOwner)}`);

  const plateau = lifecycle.samples.slice(-3);
  invariant(
    lifecycle.samples.every(
      (sample) => sample.replaced
        && sample.previousDetached
        && sample.previousAlreadyDisposed
        && sample.currentAttached
        && sample.buildingRoots === 1,
    ),
    `rebuild did not replace, detach, and release exactly one root: ${JSON.stringify(lifecycle.samples)}`,
  );
  for (const key of ['geometries', 'textures', 'programs']) {
    invariant(plateau.every((sample) => sample[key] === plateau[0][key]),
      `rebuild ${key} did not plateau: ${lifecycle.samples.map((sample) => sample[key]).join(' → ')}`);
  }
  invariant(
    lifecycle.firstDispose
      && !lifecycle.secondDispose
      && lifecycle.rebuildRejected
      && lifecycle.currentAlreadyDisposed,
    'example teardown is not idempotent and terminal');
  invariant(lifecycle.resizeBefore === lifecycle.resizeAfter,
    'resize listener remained active after example disposal');
  invariant(
    lifecycle.canvasCount === 0
      && !lifecycle.hookPresent
      && !lifecycle.readyPresent
      && lifecycle.sceneChildren === 0,
    `example cleanup left canvas/hook state: ${JSON.stringify({
      canvasCount: lifecycle.canvasCount,
      hookPresent: lifecycle.hookPresent,
      readyPresent: lifecycle.readyPresent,
      sceneChildren: lifecycle.sceneChildren,
    })}`);
  invariant(
    lifecycle.ownedDisposals.groundGeometry === 1
      && lifecycle.ownedDisposals.groundMaterial === 1
      && lifecycle.ownedDisposals.shadowMap === 1
      && lifecycle.ownedDisposals.renderer === 1
      && lifecycle.shadowTextureRegistered === false,
    `example-owned GPU resources were not released exactly once: ${JSON.stringify({
      ownedDisposals: lifecycle.ownedDisposals,
      shadowTextureRegistered: lifecycle.shadowTextureRegistered,
    })}`,
  );

  invariant(pageErrors.length === 0, `page errors: ${pageErrors.join(' | ')}`);
  invariant(consoleErrors.length === 0, `console errors: ${consoleErrors.join(' | ')}`);
  invariant(
    unexpectedExternalRequests.length === 0,
    `example made unexpected network requests: ${unexpectedExternalRequests.join(' | ')}`,
  );
  console.log(
    `API REUSE: PASS (three r${initial.revision}, calls ${initial.render.calls}, `
      + `triangles ${initial.render.triangles}, plateau ${JSON.stringify(plateau[0])})`,
  );
} finally {
  if (browser) await browser.close();
  await new Promise((resolveClose) => server.close(resolveClose));
}
