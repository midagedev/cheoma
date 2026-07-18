// 경험 레이어 검증 캡처: 조립 정지프레임 · 히어로 오버레이 · 포스트카드 + 셔플/드라이브 스모크.
// 사용법: node tools/shoot-experience.mjs
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
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
const base = `http://127.0.0.1:${port}/index.html`;

let browser;
try { browser = await chromium.launch({ channel: 'chrome' }); }
catch { browser = await chromium.launch(); }
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

let errors = 0;
const consoleLines = [];
page.on('console', (msg) => {
  const t = msg.text();
  // favicon 등 리소스 404 는 앱 JS 오류가 아니므로 계수 제외.
  if (msg.type() === 'error' && !/Failed to load resource/.test(t)) { errors++; console.error('[page]', t); }
  if (t.startsWith('[surprise]')) consoleLines.push(t);
});
page.on('pageerror', (err) => { errors++; console.error('[pageerror]', err.message); });

const ready = () => page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 30000 });
const save = (name, buf) => writeFile(join(OUT, name), buf).then(() => console.log('saved', name));

// 1) 조립 정지 프레임 (t = 0.2 / 0.5 / 0.8) — 환경 켜고 3/4 앵글.
for (const t of [0.2, 0.5, 0.8]) {
  await page.goto(`${base}?shot=1&assemble=1&t=${t}&env=1&time=day&preset=korea&angle=three-quarter`, { waitUntil: 'load' });
  await ready();
  await page.waitForTimeout(200);
  await page.screenshot({ path: join(OUT, `exp-assemble-${t}.png`) });
  console.log('saved', `exp-assemble-${t}.png`);
}

// 2) 히어로 오버레이 (비-shot, hero 기본 ON).
await page.goto(`${base}?preset=korea`, { waitUntil: 'load' });
await ready();
await page.waitForTimeout(400);
await page.screenshot({ path: join(OUT, 'exp-hero.png') });
console.log('saved', 'exp-hero.png');

// 3) 포스트카드 — 페이지에서 capture 함수 직접 호출해 dataURL 저장 (pbr+DoF, ink).
for (const [tag, extra] of [['pbr', 'env=1&dof=1'], ['ink', 'env=1&mode=ink']]) {
  await page.goto(`${base}?shot=1&${extra}&time=day&preset=korea&angle=three-quarter`, { waitUntil: 'load' });
  await ready();
  await page.waitForTimeout(200);
  const dataUrl = await page.evaluate(() => window.__postcard());
  const buf = Buffer.from(dataUrl.split(',')[1], 'base64');
  await save(`exp-postcard-${tag}.png`, buf);
}

// 4) 드라이브 스모크 (기존 파이프라인 무손상 확인) — orbit 정지 프레임.
await page.goto(`${base}?shot=1&drive=orbit&t=0.5&env=1&preset=korea`, { waitUntil: 'load' });
await ready();
await page.waitForTimeout(150);
await page.screenshot({ path: join(OUT, 'exp-drive-orbit.png') });
console.log('saved', 'exp-drive-orbit.png');

// 5) 셔플 스모크 — surprise 10회, 파라미터/재생성 에러 감시.
await page.goto(`${base}?preset=korea`, { waitUntil: 'load' });
await ready();
for (let i = 0; i < 10; i++) {
  await page.evaluate(() => window.__surprise());
  await page.waitForTimeout(120);
}
await page.waitForTimeout(200);

await browser.close();
server.close();

console.log('\n--- shuffle configs ---');
for (const l of consoleLines) console.log(l);
console.log(`\npageerror/console-error total: ${errors}`);
process.exit(errors > 0 ? 1 : 0);
