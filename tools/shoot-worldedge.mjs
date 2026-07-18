// 헤드리스 검증: 비정형 월드 테두리(엣지 후보 비교) + 산 구름·물안개 + 흐르는 구름 그림자.
//   → shots/edge-*.png
// 직접 env 하네스(/__edge): setupEnvironment 를 그대로 import(병렬 중 main.js WIP 우회).
//   자유 카메라(cx..tz), ?edge=ink|mist|diorama, ?time, ?season, ?snow=1, ?steps=N&dt= 로
//   가상시간 결정론 스텝(드리프트 diff·shot 재현성 양쪽 커버), ?clouds=0 옵트아웃.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'shots');
mkdirSync(OUT, { recursive: true });
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json' };

// 격리 하네스 페이지(내 모듈만 직접 import — index.js/sky.js 타 에이전트 WIP 우회).
const EDGE_HTML = await readFile(join(ROOT, 'tools/_edge_min.html'), 'utf8');

const server = createServer(async (req, res) => {
  const path = req.url.split('?')[0];
  if (path === '/__edge') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(EDGE_HTML); return; }
  try {
    const file = join(ROOT, path === '/' ? 'index.html' : path);
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const port = server.address().port;

// ── 캡처 목록 ──
const shots = [];
// R1 엣지 후보 비교: 같은 오빗/석양에서 ink·mist·diorama
for (const edge of ['ink', 'mist', 'diorama']) {
  shots.push([`cand-${edge}`, `/__edge?edge=${edge}&time=sunset&season=summer&steps=30`]);
}
// R2 최종(mist) 다각도
shots.push(['final-3q-day', `/__edge?edge=mist&time=day&season=summer&cx=90&cy=60&cz=150&tx=0&ty=2&tz=-10&steps=30`]);
shots.push(['final-eye', `/__edge?edge=mist&time=sunset&season=summer&cx=40&cy=9&cz=120&tx=0&ty=6&tz=-40&steps=30`]);
shots.push(['final-sunset-wide', `/__edge?edge=mist&time=sunset&season=summer&cx=150&cy=95&cz=150&tx=0&ty=0&tz=-20&steps=60`]);
shots.push(['final-night', `/__edge?edge=mist&time=night&season=summer&cx=120&cy=88&cz=175&steps=30`]);
// 엣지 클로즈업 3방위(경계가 "의도된 여백"으로 읽히는지)
shots.push(['edge-az-w', `/__edge?edge=mist&time=day&cx=-40&cy=30&cz=40&tx=-150&ty=6&tz=0&steps=30`]);
shots.push(['edge-az-n', `/__edge?edge=mist&time=day&cx=0&cy=34&cz=-40&tx=0&ty=6&tz=-150&steps=30`]);
shots.push(['edge-az-e', `/__edge?edge=mist&time=day&cx=40&cy=30&cz=40&tx=150&ty=6&tz=0&steps=30`]);
// 계절 가을 + 눈 교차(패치 체인 무결)
shots.push(['chain-autumn', `/__edge?edge=mist&time=day&season=autumn&steps=30`]);
shots.push(['chain-autumn-snow', `/__edge?edge=mist&time=day&season=autumn&snow=1&steps=30`]);
// 구름 그림자 드리프트 diff: 같은 뷰, 가상시간 t 상이(60 vs 220 스텝)
shots.push(['drift-a', `/__edge?edge=mist&time=day&season=summer&cx=110&cy=100&cz=150&tx=0&ty=0&tz=0&steps=60`]);
shots.push(['drift-b', `/__edge?edge=mist&time=day&season=summer&cx=110&cy=100&cz=150&tx=0&ty=0&tz=0&steps=220`]);
// shot 모드 결정론(동일 파라미터 2회 → 픽셀 동일해야)
shots.push(['det-1', `/__edge?edge=mist&time=sunset&shot=1&steps=30`]);
shots.push(['det-2', `/__edge?edge=mist&time=sunset&shot=1&steps=30`]);
// 구름 옵트아웃
shots.push(['clouds-off', `/__edge?edge=mist&time=day&clouds=0&cx=110&cy=100&cz=150&tx=0&ty=0&tz=0&steps=60`]);

let browser;
try { browser = await chromium.launch({ channel: 'chrome' }); }
catch { browser = await chromium.launch(); }
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') console.error('[page]', m.text()); });
page.on('pageerror', (e) => { errors.push(e.message); console.error('[pageerror]', e.message); });

for (const [name, qs] of shots) {
  const url = `http://127.0.0.1:${port}${qs}`;
  await page.goto(url, { waitUntil: 'load' });
  try { await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 30000 }); }
  catch { console.error('TIMEOUT', name); }
  await page.waitForTimeout(150);
  const file = join(OUT, `edge-${name}.png`);
  await page.screenshot({ path: file });
  console.log('saved', file);
}
console.log('TOTAL pageerrors:', errors.length);
await browser.close();
server.close();
