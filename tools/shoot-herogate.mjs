// 히어로 타임라인 검증(#61): 조기 노출 게이트 — 빈 터(building.visible=false) 동안 건물 종속
// 이펙트(굴뚝 연기·적설 쉘)가 뜨지 않고, 건물이 서고 정착한 뒤 스멀스멀 등장하는지 프레임 시퀀스로 확인.
// 비-shot 모드(히어로 활성). 출력=세션 스크래치패드.
//   node tools/shoot-herogate.mjs
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = process.env.OUT
  || '/private/tmp/claude-501/-Users-hckim-repo-asiahouse/7a15478e-68e3-4ad3-b08a-bdb86ae4fe92/scratchpad';
mkdirSync(OUT, { recursive: true });
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  try { const p = req.url.split('?')[0]; const d = await readFile(join(ROOT, p === '/' ? 'index.html' : p));
    res.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream' }); res.end(d); }
  catch { res.writeHead(404); res.end('x'); }
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const port = server.address().port;
const b = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch());

// scenario: {name, q, preEval}. 각 시나리오: 로드→(preEval)→히어로 클릭→빈터/등장/정착 3컷.
const scenarios = [
  { name: 'snow', q: 'env=1&preset=korea&weather=snow&time=day&occ=0', preEval: 'window.__wx.setAccum(1.0)' },
  { name: 'smoke', q: 'env=1&preset=giwa&weather=clear&time=sunset&occ=0', preEval: null },
];

for (const s of scenarios) {
  const page = await b.newPage({ viewport: { width: 1100, height: 700 } });
  page.on('pageerror', (e) => console.log('ERR', s.name, e.message));
  await page.goto(`http://127.0.0.1:${port}/index.html?${s.q}`, { waitUntil: 'load' });
  await page.waitForTimeout(1500);                       // 로드+첫 렌더
  if (s.preEval) await page.evaluate(s.preEval);
  // 히어로 오버레이 클릭 → reveal 시작(building.visible=false 유지, ~6.6s 뒤 건물 등장+조립)
  await page.click('#hero').catch(() => {});
  await page.waitForTimeout(3000);                       // reveal 중 빈 터(건물 숨김)
  if (s.preEval) await page.evaluate(s.preEval);         // accum 재고정(리롤 아님이라 유지되나 안전)
  await page.screenshot({ path: join(OUT, `herogate-${s.name}-1empty.png`) });
  await page.waitForTimeout(5000);                       // 건물 등장(≈6.6s)+지연 직후
  await page.screenshot({ path: join(OUT, `herogate-${s.name}-2appear.png`) });
  await page.waitForTimeout(6000);                       // 조립 정착+이펙트 상승
  await page.screenshot({ path: join(OUT, `herogate-${s.name}-3settled.png`) });
  await page.close();
}
await b.close(); server.close(); console.log('done');
