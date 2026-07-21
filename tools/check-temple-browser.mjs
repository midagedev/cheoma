// Standalone TemplePlan -> THREE lifecycle and render-budget gate. It serves the
// reusable root harness directly, so Svelte and the full village do not inflate
// the edit/renderer feedback loop.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { launchVerificationBrowser, reportWebGLRenderer } from './lib/verification-browser.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const MIME = {
  '.css': 'text/css', '.html': 'text/html', '.js': 'text/javascript',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
};

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    if (pathname === '/favicon.ico') {
      response.writeHead(204);
      response.end();
      return;
    }
    const file = resolve(ROOT, `.${pathname === '/' ? '/temple.html' : pathname}`);
    if (file !== ROOT && !file.startsWith(`${ROOT}${sep}`)) throw new Error('unsafe path');
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

const port = server.address().port;
const browser = await launchVerificationBrowser();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const pageErrors = [];
const consoleErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});

const variants = ['compact', 'courtyard', 'extended'];
const diagnostics = new Map();
try {
  for (const variant of variants) {
    for (const merged of [false, true]) {
      const label = `${variant}:${merged ? 'merged' : 'raw'}`;
      const url = `http://127.0.0.1:${port}/temple.html?variant=${variant}&shot=1&probe=1${merged ? '&merged=1' : ''}`;
      await page.goto(url, { waitUntil: 'load' });
      await page.waitForFunction(() => document.documentElement.dataset.templeReady === 'true', null, { timeout: 45000 });
      const diag = await page.evaluate(() => JSON.parse(document.getElementById('app').dataset.templeDiag));
      diagnostics.set(label, diag);

      invariant(diag.variant === variant && diag.merged === merged, `${label}: wrong render mode`);
      invariant(diag.issues.length === 0, `${label}: ${diag.issues.join('; ')}`);
      invariant(diag.camera.fov === 26 && diag.camera.southOffset > 0,
        `${label}: focus camera is not on the south-facing telephoto approach`);
      invariant(diag.renderedBounds.x <= diag.size.width + 2.5,
        `${label}: rendered width escaped the reserved precinct`);
      invariant(diag.renderedBounds.z <= diag.size.depth + 2.5,
        `${label}: rendered depth escaped the reserved precinct`);
      invariant(diag.lifecycle.first && !diag.lifecycle.second && diag.lifecycle.owned,
        `${label}: disposal is not successful and idempotent`);
      invariant(diag.lifecycle.sharedGeometryDisposed === 1, `${label}: caller-palette geometry leaked`);
      invariant(diag.lifecycle.callerMaterialDisposed === 0, `${label}: caller-owned palette was disposed`);
      invariant(diag.lifecycle.ownedMaterialDisposed === 1, `${label}: owned palette was not disposed`);
      if (merged) invariant(diag.render.calls <= 140, `${label}: ${diag.render.calls} merged draw calls exceed 140`);
      console.log(`${label.padEnd(19)} calls=${String(diag.render.calls).padStart(4)} tris=${diag.render.triangles}`);
    }
  }

  for (const variant of variants) {
    const raw = diagnostics.get(`${variant}:raw`);
    const merged = diagnostics.get(`${variant}:merged`);
    invariant(raw.render.triangles === merged.render.triangles, `${variant}: merge changed triangle content`);
    invariant(merged.render.calls <= raw.render.calls * 0.15,
      `${variant}: merge reduced ${raw.render.calls} calls by less than 85%`);
    invariant(JSON.stringify(raw.counts) === JSON.stringify(merged.counts), `${variant}: semantic counts drifted`);
  }
  await reportWebGLRenderer(page, 'temple');
  invariant(pageErrors.length === 0, `page errors: ${pageErrors.join(' | ')}`);
  invariant(consoleErrors.length === 0, `console errors: ${consoleErrors.join(' | ')}`);
  console.log('TEMPLE BROWSER: PASS (3 variants, lifecycle, south camera, raw/merged parity)');
} finally {
  await browser.close();
  await new Promise((resolveClose) => server.close(resolveClose));
}
