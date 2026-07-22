// Fixed-camera OFF/ON visual, lifecycle, mip/filter, export, and texture plateau gate.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { PNG } from 'pngjs';
import { launchVerificationBrowser, reportWebGLRenderer } from './lib/verification-browser.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml',
};
const invariant = (condition, message) => { if (!condition) throw new Error(message); };

const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    if (pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
    const file = resolve(ROOT, `.${pathname === '/' ? '/tools/surface-materials-harness.html' : pathname}`);
    if (file !== ROOT && !file.startsWith(`${ROOT}${sep}`)) throw new Error('unsafe path');
    const body = await readFile(file);
    response.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    response.end(body);
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain' }); response.end('not found');
  }
});
await new Promise((done, reject) => server.listen(0, '127.0.0.1', done).on('error', reject));

function imageStats(buffer) {
  const image = PNG.sync.read(buffer);
  let luminance = 0, edge = 0;
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    const offset = (y * image.width + x) * 4;
    const value = image.data[offset] * 0.2126
      + image.data[offset + 1] * 0.7152 + image.data[offset + 2] * 0.0722;
    luminance += value;
    if (x > 0) {
      const left = offset - 4;
      const leftValue = image.data[left] * 0.2126
        + image.data[left + 1] * 0.7152 + image.data[left + 2] * 0.0722;
      edge += Math.abs(value - leftValue);
    }
  }
  const pixels = image.width * image.height;
  return { luminance: luminance / pixels, edge: edge / (pixels - image.height) };
}

function meanDifference(a, b) {
  const left = PNG.sync.read(a), right = PNG.sync.read(b);
  invariant(left.width === right.width && left.height === right.height, 'frame dimensions drifted');
  let total = 0;
  for (let index = 0; index < left.data.length; index += 4) {
    total += Math.abs(left.data[index] - right.data[index]);
    total += Math.abs(left.data[index + 1] - right.data[index + 1]);
    total += Math.abs(left.data[index + 2] - right.data[index + 2]);
  }
  return total / (left.width * left.height * 3);
}

const browser = await launchVerificationBrowser();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (error) => errors.push(`page: ${error.message}`));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(`console: ${message.text()}`);
});
const captures = await mkdtemp(join(tmpdir(), 'cheoma-packed-earth-'));
const port = server.address().port;
const load = async (mode, shift = 0, probe = false) => {
  await page.goto(`http://127.0.0.1:${port}/tools/surface-materials-harness.html?mode=${mode}&shift=${shift}${probe ? '&probe=1' : ''}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__SURFACE_READY === true, null, { timeout: 60_000 });
  const diag = await page.evaluate(() => window.__SURFACE_DIAG);
  const path = join(captures, `${mode}${shift ? '-shift' : ''}.png`);
  const buffer = await page.screenshot({ path });
  return { diag, path, buffer, stats: imageStats(buffer) };
};

try {
  const off = await load('off');
  const on = await load('on', 0, true);
  const offShift = await load('off', 0.012);
  const onShift = await load('on', 0.012);

  invariant(off.diag.drawCalls === on.diag.drawCalls,
    `surface changed draw calls ${off.diag.drawCalls} -> ${on.diag.drawCalls}`);
  invariant(off.diag.triangles === on.diag.triangles,
    `surface changed triangles ${off.diag.triangles} -> ${on.diag.triangles}`);
  invariant(off.diag.materialCount === 1 && on.diag.materialCount === 1,
    'surface changed production road material count');
  invariant(on.diag.textureCount === 2, 'surface pilot does not own exactly two textures');
  invariant(on.diag.rendererTextures === off.diag.rendererTextures + 2,
    `uploaded texture delta is not +2 (${off.diag.rendererTextures} -> ${on.diag.rendererTextures})`);
  invariant(on.diag.programs <= off.diag.programs + 1,
    `surface added more than one program family (${off.diag.programs} -> ${on.diag.programs})`);
  invariant(on.diag.source.seamRatioX < 1.25 && on.diag.source.seamRatioY < 1.25,
    `tile seam escaped field gradient ${JSON.stringify(on.diag.source)}`);
  invariant(Math.abs(on.diag.source.halfCorrelationX) < 0.55
    && Math.abs(on.diag.source.halfCorrelationY) < 0.55,
  `half-tile repetition is conspicuous ${JSON.stringify(on.diag.source)}`);
  invariant(on.diag.lifecycle?.disposedOnce && on.diag.lifecycle.textures === 2,
    `surface lifecycle failed ${JSON.stringify(on.diag.lifecycle)}`);
  invariant(on.diag.plateau?.spread <= 1,
    `surface texture count did not plateau ${JSON.stringify(on.diag.plateau)}`);
  invariant(on.diag.export?.images >= 1 && on.diag.export?.textures >= 1,
    `DataTexture albedo did not survive glTF export ${JSON.stringify(on.diag.export)}`);

  const visualDelta = meanDifference(off.buffer, on.buffer);
  const meanShift = Math.abs(off.stats.luminance - on.stats.luminance);
  invariant(visualDelta >= 0.35, `packed earth is not visibly distinct (${visualDelta.toFixed(3)})`);
  invariant(meanShift <= 5.0, `packed earth shifted frame luminance by ${meanShift.toFixed(3)}`);
  invariant(meanShift / off.stats.luminance <= 0.03,
    `packed earth shifted mean luminance more than 3% (${meanShift.toFixed(3)})`);
  invariant(on.stats.edge <= off.stats.edge * 1.22,
    `packed earth became noisy (${off.stats.edge.toFixed(3)} -> ${on.stats.edge.toFixed(3)})`);
  const offMotion = meanDifference(off.buffer, offShift.buffer);
  const onMotion = meanDifference(on.buffer, onShift.buffer);
  invariant(onMotion <= offMotion + 0.8,
    `sub-pixel motion suggests shimmer (${offMotion.toFixed(3)} -> ${onMotion.toFixed(3)})`);
  invariant(errors.length === 0, errors.join(' | '));

  await reportWebGLRenderer(page, 'surface-materials');
  console.log(`SURFACE MATERIALS BROWSER: PASS (delta=${visualDelta.toFixed(3)}, luminance=${meanShift.toFixed(3)}, motion=${offMotion.toFixed(3)}/${onMotion.toFixed(3)}, calls=${off.diag.drawCalls}->${on.diag.drawCalls}, triangles=${off.diag.triangles}->${on.diag.triangles}, programs=${off.diag.programs}->${on.diag.programs}, textures=${off.diag.rendererTextures}->${on.diag.rendererTextures})`);
  console.log(`captures=${captures}`);
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
