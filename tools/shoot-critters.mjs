// 헤드리스 스크린샷: 생물 앰비언트(새 떼·개·고양이·까치) 검증 → shots/critters-*.png
// 사용법: node tools/shoot-critters.mjs
//  - flock-0/1/2: 같은 페이지를 열어둔 채 시간 간격을 두고 3장(무리 위치가 변하는지)
//  - dog / cat / magpie: 앵글별 지상·건물 생물
//  - ink: 수묵 모드에서 새 떼가 먹점으로 읽히는지
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'shots');
mkdirSync(OUT, { recursive: true });

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json',
};

const server = createServer(async (req, res) => {
  try {
    const path = req.url.split('?')[0];
    const file = join(ROOT, path === '/' ? 'index.html' : path);
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('not found');
  }
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const port = server.address().port;
const base = `http://127.0.0.1:${port}/index.html?shot=1&env=1&preset=korea`;

let browser;
try { browser = await chromium.launch({ channel: 'chrome' }); }
catch { browser = await chromium.launch(); }
const page = await browser.newPage({ viewport: { width: 1280, height: 800, deviceScaleFactor: 2 } });
page.on('console', (msg) => { if (msg.type() === 'error') console.error('[page]', msg.text()); });
page.on('pageerror', (err) => console.error('[pageerror]', err.message));

async function open(url) {
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 30000 });
}
async function shot(name, clip) {
  const file = join(OUT, `critters-${name}.png`);
  await page.screenshot(clip ? { path: file, clip } : { path: file });
  console.log('saved', file);
}

// 1) 새 떼: 같은 페이지에서 시간 간격 3장 (boids 가 움직이는지 확인)
await open(`${base}&angle=three-quarter&time=day`);
await page.waitForTimeout(400);
await shot('flock-0');
await page.waitForTimeout(4500);
await shot('flock-1');
await page.waitForTimeout(4500);
await shot('flock-2');

// 2) 개: 앞마당이 넓게 보이는 front 앵글
await open(`${base}&angle=front&time=day`);
await page.waitForTimeout(600);
await shot('dog');

// 3) 고양이: 기단이 보이는 three-quarter (지붕 까치도 함께 검증). 기단 영역 크롭 확대도.
await open(`${base}&angle=three-quarter&time=day`);
await page.waitForTimeout(600);
await shot('cat');
await shot('cat-zoom', { x: 680, y: 440, width: 300, height: 220 });

// 4) 지붕 까치: three-quarter 는 용마루 끝이 하늘을 배경으로 선다 → 크롭 확대.
await open(`${base}&angle=three-quarter&time=day`);
await page.waitForTimeout(600);
await shot('magpie-zoom', { x: 340, y: 150, width: 620, height: 260 });
// roof 앵글 전체도.
await open(`${base}&angle=roof&time=day`);
await page.waitForTimeout(600);
await shot('magpie');

// 5) 수묵 모드 새 떼(먹점 확인)
await open(`${base}&angle=three-quarter&time=day&mode=ink`);
await page.waitForTimeout(800);
await shot('ink');

// 6) 밤: 새 떼 없음 확인
await open(`${base}&angle=three-quarter&time=night`);
await page.waitForTimeout(600);
await shot('night');

await browser.close();
server.close();
