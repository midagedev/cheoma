// Visual capture for viral clip stages (#261). Writes PNGs under scratch/clip-stages/.
// Not a merge gate — human / vision review of stop frames.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../app/node_modules/vite/dist/node/index.js';
import { chromium } from 'playwright';
import { CLIP_STAGE_IDS, CLIP_STAGES } from '../src/api/clip-stage.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.env.CHEOMA_CLIP_OUT
  || join(ROOT, 'scratch/clip-stages');
const STAGES = (process.env.CHEOMA_CLIP_STAGES || CLIP_STAGE_IDS.join(','))
  .split(',')
  .map((s) => s.trim())
  .filter((id) => CLIP_STAGES[id]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await mkdir(OUT, { recursive: true });
  const cacheDir = join(OUT, '.vite-cache');
  const vite = await createServer({
    configFile: join(ROOT, 'app/vite.config.js'),
    root: join(ROOT, 'app'),
    cacheDir,
    server: { host: '127.0.0.1', port: 0, strictPort: false },
    logLevel: 'error',
  });
  await vite.listen();
  const port = vite.config.server.port;
  const base = `http://127.0.0.1:${port}/`;
  const browser = await chromium.launch({
    channel: process.env.CHEOMA_BROWSER === 'chromium' ? undefined : 'chrome',
    headless: true,
  }).catch(() => chromium.launch({ headless: true }));

  const results = [];
  try {
    for (const id of STAGES) {
      const stage = CLIP_STAGES[id];
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      const url = new URL(base);
      url.searchParams.set('clip', id);
      // Deterministic capture: skip long hero title wait by forcing ready path.
      url.searchParams.set('shot', '0');
      console.log(`→ ${id} ${url.search}`);
      await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 120_000 });
      // Allow village gen + auto boot.
      const waitMs = stage.boot === 'hero' ? 18_000 : 12_000;
      await sleep(waitMs);
      // Force chrome / scene-guide off for clean stop frames.
      await page.addStyleTag({
        content: `
          .chroma, .scene-guide, [class*="SceneGuide"], .guide {
            opacity: 0 !important; pointer-events: none !important; visibility: hidden !important;
          }
        `,
      });
      await page.evaluate(() => {
        document.querySelectorAll('button, [role="dialog"]').forEach((el) => {
          if (/둘러보기|가이드|닫기|×|X/.test(el.textContent || '')) {
            try { el.click(); } catch { /* ignore */ }
          }
        });
      }).catch(() => {});
      await sleep(500);
      const file = join(OUT, `clip-${id}.png`);
      await page.screenshot({ path: file, type: 'png' });
      const meta = await page.evaluate(() => ({
        title: document.title,
        href: location.href,
        hasCanvas: !!document.querySelector('canvas'),
      }));
      results.push({ id, file, ...meta, stage });
      console.log(`  saved ${file}`);
      await page.close();
    }
  } finally {
    await browser.close();
    await vite.close();
  }
  await writeFile(join(OUT, 'manifest.json'), JSON.stringify({
    out: OUT,
    stages: results,
    at: new Date().toISOString(),
  }, null, 2));
  console.log(`CLIP STAGES SHOOT: ${results.length} frames → ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
