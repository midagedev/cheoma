// 지오메트리 라이브러리 채택 스파이크 실행기.
// tools/spike-libs.html 을 헤드리스 크롬에서 로드 → CDN 로드/트리비얼 연산 결과 수집.
// 네트워크 실패(특히 .wasm)·콘솔 오류를 함께 기록. 결과 JSON 을 stdout + 파일로 출력.
// 사용법: node tools/spike-libs.mjs
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = process.env.SPIKE_OUT ||
  '/private/tmp/claude-501/-Users-hckim-repo-asiahouse/7a15478e-68e3-4ad3-b08a-bdb86ae4fe92/scratchpad/spike-results.json';

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json',
};
const server = createServer(async (req, res) => {
  try {
    const path = req.url.split('?')[0];
    const file = join(ROOT, path === '/' ? 'tools/spike-libs.html' : path);
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const port = server.address().port;

let browser;
try { browser = await chromium.launch({ channel: 'chrome' }); }
catch { browser = await chromium.launch(); }
const page = await browser.newPage();

const netlog = [];
page.on('requestfailed', (r) => netlog.push({ kind: 'requestfailed', url: r.url(), err: r.failure()?.errorText }));
page.on('response', (r) => {
  const u = r.url();
  if (/\.wasm(\?|$)/.test(u) || /manifold|clipper2|three-mesh-bvh/.test(u))
    netlog.push({ kind: 'response', status: r.status(), url: u });
});
page.on('console', (m) => { if (m.type() === 'error') netlog.push({ kind: 'console.error', text: m.text() }); });
page.on('pageerror', (e) => netlog.push({ kind: 'pageerror', text: e.message }));

const url = `http://127.0.0.1:${port}/tools/spike-libs.html`;
await page.goto(url, { waitUntil: 'load' });
let results = {};
try {
  await page.waitForFunction('window.__SPIKE_DONE === true', null, { timeout: 60000 });
  results = await page.evaluate('window.__SPIKE_RESULTS');
} catch (e) {
  results = { error: 'timeout — __SPIKE_DONE 신호 없음', partial: await page.evaluate('window.__SPIKE_RESULTS || null') };
}

const report = { generatedAt: new Date().toISOString(), results, network: netlog };
await writeFile(OUT, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
console.error('\nwrote', OUT);

await browser.close();
server.close();
