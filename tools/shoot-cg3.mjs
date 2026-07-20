// critic-giwa-r3 전용 원오프 캡처 → shots/cg3-*.png
// 실행: node tools/shoot-cg3.mjs
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

// kind: 'app' → index.html(실제 앱, env=0), 'iso' → cg3-harness(격리)
// [kind, urlSuffix, outname, extraQuery]
const jobs = [
  // ── 실제 앱 경로(env=0) 표준 앵글 ──
  ['app', 'preset=giwa&angle=front&env=0',         'cg3-front'],
  ['app', 'preset=giwa&angle=three-quarter&env=0', 'cg3-tq'],
  ['app', 'preset=giwa&angle=side&env=0',          'cg3-side'],
  ['app', 'preset=giwa&angle=roof&env=0',          'cg3-roof'],
  ['app', 'preset=giwa&angle=closeup&env=0',       'cg3-closeup'],
  ['app', 'preset=giwa&angle=three-quarter&env=1', 'cg3-env'], // 환경 포함 인상컷
  // ── 격리 하네스 정밀 결함 앵글 ──
  ['iso', 'preset=giwa&angle=roof-tight',  'cg3-roof-tight'],  // ① 수키와 롤
  ['iso', 'preset=giwa&angle=junction',    'cg3-junction'],    // ② ㄱ자 접합
  ['iso', 'preset=giwa&angle=gapcheck',    'cg3-gapcheck'],    // ② 삼각 공극
  ['iso', 'preset=giwa&angle=eave-under',  'cg3-eave-under'],  // ③ 서까래/부연 언더뷰
  ['iso', 'preset=giwa&angle=closeup',     'cg3-closeup-iso'], // ③ 처마밑(격리)
  ['iso', 'preset=giwa&angle=chimney',     'cg3-chimney'],     // ⑤ 굴뚝·연가
  ['iso', 'preset=giwa&angle=gidan',       'cg3-gidan'],       // ④ 기단 줄눈
  ['iso', 'preset=giwa&angle=gable',       'cg3-gable'],       // ⑦ 합각
  ['iso', 'preset=giwa&angle=front&sun=back', 'cg3-front-backlit'], // ⑥ 역광 정면
  // ── 회귀: 공유 파일(roof.js/roof-skeleton.js) 영향 확인 ──
  ['iso', 'preset=korea&angle=roof',           'cg3-reg-korea-roof'],
  ['iso', 'preset=korea&angle=three-quarter',  'cg3-reg-korea'],
  ['iso', 'preset=temple&angle=roof',          'cg3-reg-temple-roof'],
  ['iso', 'preset=temple&angle=three-quarter', 'cg3-reg-temple'],
  ['iso', 'preset=choga&angle=three-quarter',  'cg3-reg-choga'],
];

let browser;
try { browser = await chromium.launch({ channel: 'chrome' }); }
catch { browser = await chromium.launch(); }
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
let errors = 0;
page.on('console', (msg) => { if (msg.type() === 'error') { errors++; console.error('[page]', msg.text()); } });
page.on('pageerror', (err) => { errors++; console.error('[pageerror]', err.message); });

for (const [kind, suffix, name] of jobs) {
  const base = kind === 'app' ? 'index.html?shot=1&' : 'tools/cg3-harness.html?';
  const url = `http://127.0.0.1:${port}/${base}${suffix}`;
  try {
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 30000 });
    await page.waitForTimeout(300);
    const file = join(OUT, `${name}.png`);
    await page.screenshot({ path: file });
    console.log('saved', file);
  } catch (e) {
    console.error('FAILED', name, e.message);
  }
}

await browser.close();
server.close();
console.log(errors ? `ERRORS: ${errors}` : 'errors: 0');
