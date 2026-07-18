// 실제 앱 dist 빌드(dist-parcels)를 정적 서빙 → ?village=1 부감 캡처. #54 판정 컷.
//   NODE_PATH=/Users/hckim/repo/threesur/node_modules node tools/shoot-parcels-app.mjs
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { extname, join, resolve, normalize } from 'node:path';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..');
const DIST = join(ROOT, 'app', 'dist-parcels');
const OUT = join(ROOT, 'shots');
mkdirSync(OUT, { recursive: true });
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json', '.woff2': 'font/woff2', '.woff': 'font/woff', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg' };

const server = createServer(async (req, res) => {
  let path = decodeURIComponent(req.url.split('?')[0]);
  if (path === '/') path = '/index.html';
  const file = normalize(join(DIST, path));
  if (!file.startsWith(DIST)) { res.writeHead(403); res.end(); return; }
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise((ok) => server.listen(4183, '127.0.0.1', ok));

let browser;
try { browser = await chromium.launch({ channel: 'chrome' }); }
catch { browser = await chromium.launch(); }
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
let pageErrs = 0, consoleErrs = 0;
page.on('console', (msg) => { if (msg.type() !== 'error') return; const t = msg.text(); if (/favicon\.ico/.test(t) || /status of 404/.test(t)) return; consoleErrs++; console.error('[console]', t); });
page.on('pageerror', (err) => { pageErrs++; console.error('[pageerror]', err.message); });

const shots = [
  ['app-village-day', 'village=1&vscale=village&vchar=yeoyeom&time=day'],
  ['app-village-minchon', 'village=1&vscale=village&vchar=minchon&time=day'],
  ['app-village-sunset', 'village=1&vscale=village&vchar=yeoyeom'],
];
for (const [name, qs] of shots) {
  await page.goto(`http://127.0.0.1:4183/?${qs}`, { waitUntil: 'load' });
  await page.waitForTimeout(6000);   // 히어로 스킵·마을 진입·돌리인·리빌 안착 대기
  await page.screenshot({ path: join(OUT, `parcels-app-${name}.png`) });
  console.log('saved', name);
}
console.log(`pageerror=${pageErrs} console-error=${consoleErrs}`);
await browser.close();
server.close();
