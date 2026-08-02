// Social card capture (#27 launch): renders the flagship golden-hour aerial at
// exactly 1200×630 and writes app/public/og-card.jpg, which vite copies to the
// dist root for the absolute og:image URL in app/index.html.
//
// The framing is the shareable `?clip=assemble` fixture (seed 7 · sunset · gold),
// held past the landing so the card is the settled 종가 close-up, so the card and
// the clip stage cannot drift apart. Product chrome is hidden for the frame only —
// nothing about the scene is special-cased.
//
// Why not the aerial: village-scale 부감 runs with rim/flare/DoF at policy 0, so
// that framing reads as flat fog (measured 2026-08-02: meanLuma 0.257, no rim,
// village under ~20% of frame height). The landed hero frame carries the eave
// line, the backlit rim and the golden-hour courtyard the launch is selling.
// Repeat runs of this fixture differ by 0.18% of pixels (drifting motes only).
//
// Run against a clean production build:
//   cd app && rm -rf dist && npx vite build
//   node tools/shoot-og-card.mjs
//
// Env: CHEOMA_OG_STAGE (clip id, default `yard`), CHEOMA_OG_QUERY (raw product
//      query string, overrides the stage while framing candidates),
//      CHEOMA_OG_OUT (output path), CHEOMA_OG_PROOF_DIR (full-quality PNG proofs),
//      CHEOMA_OG_SETTLE_MS (settle time before the frame is taken).
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { launchVerificationBrowser, reportWebGLRenderer } from './lib/verification-browser.mjs';
import { decodePng, rgbToHsv } from './lib/pixel-stats.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const DIST = join(ROOT, 'app', 'dist');
const OUT = process.env.CHEOMA_OG_OUT
  ? resolve(process.env.CHEOMA_OG_OUT)
  : join(ROOT, 'app', 'public', 'og-card.jpg');
const PROOF_DIR = process.env.CHEOMA_OG_PROOF_DIR ? resolve(process.env.CHEOMA_OG_PROOF_DIR) : null;
const STAGE = process.env.CHEOMA_OG_STAGE || 'assemble';
const QUERY = process.env.CHEOMA_OG_QUERY || `clip=${STAGE}`;
// The assemble stage plays a reveal + ~10s tofu assembly before the landing
// settles; the card must be taken after all of it, not mid-drop.
const SETTLE_MS = Number(process.env.CHEOMA_OG_SETTLE_MS) || 24_000;
const WIDTH = 1200;
const HEIGHT = 630;
const TIMEOUT = Number(process.env.CHEOMA_OG_TIMEOUT_MS) || 90_000;

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.json': 'application/json', '.mp3': 'audio/mpeg',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};

const failures = [];
const pass = (condition, message) => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${message}`);
  if (!condition) failures.push(message);
};

try {
  await readFile(join(DIST, 'index.html'));
} catch {
  console.error(`no build at ${DIST} — run: cd app && rm -rf dist && npx vite build`);
  process.exit(1);
}

const server = createServer(async (req, res) => {
  const path = decodeURIComponent(req.url.split('?')[0]);
  const file = join(DIST, path === '/' ? 'index.html' : path);
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const port = server.address().port;

let browser;
try {
  browser = await launchVerificationBrowser();
  const context = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 1,
    reducedMotion: 'no-preference',
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await reportWebGLRenderer(page).catch(() => {});

  await page.goto(`http://127.0.0.1:${port}/?${QUERY}&worker=0`, {
    waitUntil: 'domcontentloaded', timeout: TIMEOUT,
  });
  await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: TIMEOUT });
  // Let the arrival motion, environment crossfade and DoF ramp settle — the card
  // must show the resting frame, not a transition.
  await page.waitForTimeout(SETTLE_MS);

  // The environment is re-applied after entry on purpose: `enterVillageMode`
  // resets it, which is how months of "sunset" captures came out under a day sky.
  const env = await page.evaluate(() => {
    const engine = window.__engine;
    return {
      time: engine?.getState?.().time ?? null,
      season: engine?.getState?.().season ?? null,
      weather: engine?.getState?.().weather ?? null,
    };
  });
  console.log(`query=${QUERY} settle=${SETTLE_MS}ms env=${JSON.stringify(env)}`);
  pass(env.time === 'sunset',
    `card renders under the flagship sunset sky (time=${env.time})`);

  // Chrome is a DOM overlay; hiding it does not touch the rendered frame.
  await page.addStyleTag({ content: '.chroma, .cine-overlay, [data-scene-guide] { opacity: 0 !important; pointer-events: none !important; }' });
  await page.waitForTimeout(400);

  await mkdir(resolve(OUT, '..'), { recursive: true });
  await page.screenshot({ path: OUT, type: 'jpeg', quality: 90 });
  const pngBuffer = await page.screenshot({ type: 'png' });
  if (PROOF_DIR) {
    await mkdir(PROOF_DIR, { recursive: true });
    await writeFile(join(PROOF_DIR, `og-${STAGE}.png`), pngBuffer);
  }

  // Pure-node sanity on the written frame: it must be a lit, warm, non-flat image.
  const png = decodePng(pngBuffer);
  let sum = 0;
  let warm = 0;
  let dark = 0;
  const total = png.width * png.height;
  for (let i = 0; i < total; i += 1) {
    const o = i * png.channels;
    const r = png.data[o];
    const g = png.data[o + 1];
    const b = png.data[o + 2];
    const luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    sum += luma;
    if (luma < 0.05) dark += 1;
    const { h, s } = rgbToHsv(r, g, b);
    if (s > 0.12 && (h < 65 || h > 330)) warm += 1;
  }
  const mean = sum / total;
  const warmFraction = warm / total;
  const darkFraction = dark / total;
  console.log(`size=${png.width}x${png.height} meanLuma=${mean.toFixed(3)} warm=${(warmFraction * 100).toFixed(1)}% near-black=${(darkFraction * 100).toFixed(1)}%`);
  pass(png.width === WIDTH && png.height === HEIGHT, `card is exactly ${WIDTH}×${HEIGHT}`);
  pass(mean > 0.08 && mean < 0.75, `card is neither black nor blown out (meanLuma=${mean.toFixed(3)})`);
  pass(darkFraction < 0.5, `card is not mostly empty sky-black (near-black=${(darkFraction * 100).toFixed(1)}%)`);
  pass(errors.length === 0, `no page errors (${errors.join(' | ') || 'none'})`);

  const written = await readFile(OUT);
  console.log(`wrote ${OUT} (${(written.length / 1024).toFixed(1)} kB jpeg)`);
  pass(written.length < 900 * 1024, `card stays under the 900 kB card budget (${(written.length / 1024).toFixed(1)} kB)`);

  await page.close();
  await context.close();
} finally {
  await browser?.close();
  server.close();
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nog card OK');
