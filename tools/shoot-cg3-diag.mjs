// cg3 진단 컷: ㄱ자 오목코너 용마루 접합부 삼각 하늘 공극 정밀 확인 → shots/cg3-diag-*.png
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'shots');
mkdirSync(OUT, { recursive: true });
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  try {
    const path = req.url.split('?')[0];
    const file = join(ROOT, path === '/' ? 'index.html' : path);
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const port = server.address().port;

// 오목 코너(1.6, 2.2) 접합부를 여러 각에서. tx/tz=코너, ty≈용마루. az/el/r 로 스윕.
// 하늘 공극이 있으면 리그 배경(#c9d3dc 밝은 청회색)이 지붕 사이로 비친다.
// bg=ff00ff → 형광 마젠타 배경/지면. 관통(하늘 공극)이 있으면 접합부에 마젠타가 보인다.
const MAG = '&bg=ff00ff';
const jobs = [
  // 안마당(오목코너 안쪽, +x-ish)에서 접합부 올려다봄
  ['az=-25&el=8&r=0.7&tx=1.6&tz=2.2&ty=5.4' + MAG,  'cg3-diag-corner-up-mag'],
  // 정면 아래에서 접합부 올려다봄(closeup 재현 각)
  ['az=42&el=-6&r=0.7&tx=1.2&tz=2.0&ty=5.2' + MAG,  'cg3-diag-front-up-mag'],
  // closeup 원각 재현(정면 처마 밑에서 올려다봄)
  ['az=42&el=-12&r=0.76&tx=0&tz=0&ty=3.6' + MAG,    'cg3-diag-closeup-mag'],
  // 바로 위에서 내려다봄 — 골(회첨) 상단 마감
  ['az=30&el=52&r=0.8&tx=1.4&tz=1.8&ty=5.0' + MAG,  'cg3-diag-top-mag'],
  // 측면(날개쪽)에서 접합부
  ['az=95&el=10&r=0.9&tx=1.8&tz=2.4&ty=5.4' + MAG,  'cg3-diag-wingside-mag'],
];

let browser;
try { browser = await chromium.launch({ channel: 'chrome' }); }
catch { browser = await chromium.launch(); }
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
for (const [ov, name] of jobs) {
  const url = `http://127.0.0.1:${port}/tools/cg3-harness.html?preset=giwa&${ov}`;
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 30000 });
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  console.log('saved', name);
}
await browser.close();
server.close();
