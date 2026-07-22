// Focused WebGL/lifecycle/export gate for #56. It avoids the full Svelte village,
// then emits four OS-temp frames for direct visual review.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { PNG } from 'pngjs';
import { launchVerificationBrowser, reportWebGLRenderer } from './lib/verification-browser.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const MIME = {
  '.css': 'text/css', '.html': 'text/html', '.js': 'text/javascript',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
};
const invariant = (condition, message) => {
  if (!condition) throw new Error(message);
};

const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    if (pathname === '/favicon.ico') {
      response.writeHead(204); response.end(); return;
    }
    const file = resolve(ROOT, `.${pathname === '/' ? '/tools/dancheong-harness.html' : pathname}`);
    if (file !== ROOT && !file.startsWith(`${ROOT}${sep}`)) throw new Error('unsafe path');
    const body = await readFile(file);
    response.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    response.end(body);
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('not found');
  }
});
await new Promise((done, reject) => server.listen(0, '127.0.0.1', done).on('error', reject));

const port = server.address().port;
const browser = await launchVerificationBrowser();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const pageErrors = [];
const consoleErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});

function meanRgbDifference(a, b) {
  const left = PNG.sync.read(a), right = PNG.sync.read(b);
  invariant(left.width === right.width && left.height === right.height, 'comparison frame size drift');
  let delta = 0;
  for (let index = 0; index < left.data.length; index += 4) {
    delta += Math.abs(left.data[index] - right.data[index]);
    delta += Math.abs(left.data[index + 1] - right.data[index + 1]);
    delta += Math.abs(left.data[index + 2] - right.data[index + 2]);
  }
  return delta / (left.width * left.height * 3);
}

const captures = await mkdtemp(join(tmpdir(), 'cheoma-dancheong-'));
try {
  await page.goto(`http://127.0.0.1:${port}/tools/dancheong-harness.html?probe=1`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__DANCHEONG_READY === true, null, { timeout: 120000 });
  const diag = await page.evaluate(() => window.__DANCHEONG_DIAG);
  console.log(`lifecycle=${JSON.stringify(diag.lifecycle)}`);

  invariant(diag.source.immutable, 'building a second variant mutated the first Canvas source');
  invariant(diag.source.lowHash !== diag.source.highHash, 'clarity/splendour extremes produced identical pixels');
  invariant(diag.source.sameBucketSharesCanvas && diag.source.separateTextureObjects,
    'source reuse and texture ownership are not separated');
  invariant(diag.source.cache.size <= diag.source.cache.max && diag.source.cache.max === 96,
    `source LRU escaped its bound: ${JSON.stringify(diag.source.cache)}`);
  for (const ordinary of diag.scope) {
    invariant(ordinary.config === null && ordinary.maps.length === 0,
      `${ordinary.style} received dancheong resources`);
  }
  invariant(diag.lifecycle.buildingDisposed && diag.lifecycle.twinTextureDisposed === 0,
    'standalone building disposal crossed palette ownership');
  invariant(diag.lifecycle.palaceDisposed && diag.lifecycle.palaceCallerDisposed === 0
    && diag.lifecycle.palaceDerivedDisposed === 1,
  'palace derived/caller material lifecycle is incorrect');
  invariant(diag.lifecycle.templeDisposed && diag.lifecycle.templeCallerDisposed === 0
    && diag.lifecycle.templeDerivedDisposed === 1,
    'temple disposal invalidated caller materials');
  invariant(diag.palace.defaultGrade === 'moro', 'palace default is not restrained moro');
  invariant(diag.palace.callsDefault === diag.palace.callsHigh,
    `palace slider changed draw calls ${diag.palace.callsDefault} -> ${diag.palace.callsHigh}`);
  invariant(diag.palace.materialCountDefault === diag.palace.materialCountHigh,
    'palace slider changed palette material count');
  invariant(diag.temple.mainGrade === 'geum'
    && diag.temple.subsidiaryGrade === 'geummoro'
    && diag.temple.domesticGrade === 'moro',
  `temple rank hierarchy drifted: ${JSON.stringify(diag.temple)}`);
  invariant(diag.temple.paletteCount <= 3, `temple created ${diag.temple.paletteCount} rank palettes`);
  invariant(diag.temple.mergedCalls <= 160,
    `temple merged draw calls escaped safety bound: ${diag.temple.mergedCalls}`);
  invariant(diag.programs <= 4, `dancheong generated too many WebGL programs: ${diag.programs}`);
  invariant(diag.export.canvasMaps > 0 && diag.export.glbBytes > 10_000,
    `dancheong export failed: ${JSON.stringify(diag.export)}`);

  const buffers = {};
  const cases = [
    ['palace-low', 'palace', 0.08, 0.08],
    ['palace-high', 'palace', 0.96, 0.96],
    ['temple-low', 'temple', 0.08, 0.08],
    ['temple-high', 'temple', 0.96, 0.96],
  ];
  for (const [label, style, clarity, splendor] of cases) {
    const url = `http://127.0.0.1:${port}/tools/dancheong-harness.html?style=${style}&clarity=${clarity}&splendor=${splendor}`;
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__DANCHEONG_READY === true, null, { timeout: 45000 });
    const path = join(captures, `${label}.png`);
    buffers[label] = await page.screenshot({ path });
  }
  const palaceDelta = meanRgbDifference(buffers['palace-low'], buffers['palace-high']);
  const templeDelta = meanRgbDifference(buffers['temple-low'], buffers['temple-high']);
  invariant(palaceDelta >= 2.0 && templeDelta >= 2.0,
    `rendered slider difference too small (palace=${palaceDelta.toFixed(2)}, temple=${templeDelta.toFixed(2)})`);

  await reportWebGLRenderer(page, 'dancheong');
  invariant(pageErrors.length === 0, `page errors: ${pageErrors.join(' | ')}`);
  invariant(consoleErrors.length === 0, `console errors: ${consoleErrors.join(' | ')}`);
  console.log(`DANCHEONG BROWSER: PASS (programs=${diag.programs}, palace calls=${diag.palace.callsDefault}, temple merged=${diag.temple.mergedCalls})`);
  console.log(`visual deltas palace=${palaceDelta.toFixed(2)} temple=${templeDelta.toFixed(2)}`);
  console.log(`captures=${captures}`);
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
