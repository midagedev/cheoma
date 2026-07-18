// 원오프: index.html 로드 헬스체크 (스크린샷 없음, pageerror 카운트만)
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { chromium } from 'playwright';

const ROOT = '/Users/hckim/repo/asiahouse';
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json',
};
const server = createServer(async (req, res) => {
  try {
    const path = req.url.split('?')[0];
    const data = await readFile(join(ROOT, path === '/' ? 'index.html' : path));
    res.writeHead(200, { 'content-type': MIME[extname(path)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const port = server.address().port;

let browser;
try { browser = await chromium.launch({ channel: 'chrome' }); }
catch { browser = await chromium.launch(); }
const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
const errors = [];
page.on('pageerror', (err) => errors.push(err.message));

const presets = ['korea', 'giwa', 'choga', 'temple'];
for (const preset of presets) {
  const url = `http://127.0.0.1:${port}/index.html?shot=1&preset=${preset}&env=1`;
  await page.goto(url, { waitUntil: 'load' });
  try {
    await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 30000 });
    console.log(`${preset}: READY, pageerrors so far = ${errors.length}`);
  } catch {
    console.log(`${preset}: TIMEOUT waiting __SHOT_READY, pageerrors so far = ${errors.length}`);
  }
}
console.log('TOTAL pageerrors:', errors.length);
for (const e of errors) console.log(' -', e);
await browser.close();
server.close();
