// 게이트: 4프리셋 index.html?assemble=1 로드 pageerror 0 + giwa 조립 태그(asmChunked/asmGroup) 보존.
// node tools/_tmp-roofw-gate.mjs
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { chromium } from 'playwright';

const ROOT = '/Users/hckim/repo/asiahouse';
const OUT = '/private/tmp/claude-501/-Users-hckim-repo-asiahouse/7a15478e-68e3-4ad3-b08a-bdb86ae4fe92/scratchpad/roofw';
mkdirSync(OUT, { recursive: true });
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg' };

// 조립 태그 계약 검증용 별도 페이지: 코어 buildBuilding 직접 호출.
const CONTRACT_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8">
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.185.1/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.185.1/examples/jsm/"}}</script>
</head><body><script type="module">
import { buildBuilding } from '/src/builder/index.js';
import { PRESETS } from '/src/params.js';
const r = {};
for (const key of ['korea','temple','giwa','choga']) {
  try {
    const b = buildBuilding({ ...PRESETS[key] });
    const roof = b.getObjectByName('roof');
    let asmChunked = false, asmGroups = {};
    if (roof) { asmChunked = !!roof.userData?.asmChunked; roof.traverse((o)=>{ const g=o.userData?.asmGroup; if(g) asmGroups[g]=(asmGroups[g]||0)+1; }); }
    r[key] = { ok: true, hasRoof: !!roof, asmChunked, asmGroups };
  } catch(e) { r[key] = { ok: false, err: e.message }; }
}
window.__CONTRACT = r; window.__DONE = true;
</script></body></html>`;

const server = createServer(async (req,res)=>{
  const p = req.url.split('?')[0];
  const nc = { 'cache-control': 'no-store, max-age=0' };
  if (p === '/__contract') { res.writeHead(200,{'content-type':'text/html',...nc}); res.end(CONTRACT_HTML); return; }
  let fp = p === '/' ? '/index.html' : p;
  try { const d = await readFile(join(ROOT, fp)); res.writeHead(200,{'content-type':MIME[extname(fp)]||'application/octet-stream',...nc}); res.end(d); }
  catch { res.writeHead(404); res.end('nf'); }
});
await new Promise((ok)=>server.listen(0,'127.0.0.1',ok));
const port = server.address().port;
let browser; try{browser=await chromium.launch({channel:'chrome'});}catch{browser=await chromium.launch();}

let totalErr = 0;
// ── 게이트 3a: 실제 index.html ?assemble=1 로드 pageerror 0 (4프리셋) ──
console.log('=== index.html ?assemble=1 로드 (pageerror 0 게이트) ===');
for (const preset of ['korea','temple','giwa','choga']) {
  const page = await browser.newPage({ viewport:{width:900,height:700} });
  let errs = 0; const msgs = [];
  page.on('pageerror',(e)=>{ errs++; totalErr++; msgs.push(e.message); });
  await page.goto(`http://127.0.0.1:${port}/index.html?preset=${preset}&assemble=1&shot=1`,{waitUntil:'load'});
  await page.waitForTimeout(3500);   // 조립 애니 재생 구간
  await page.screenshot({ path: join(OUT, `roofw-assemble-${preset}.png`) });
  console.log(`  ${preset}: pageerror=${errs}${msgs.length?' :: '+msgs.slice(0,2).join(' | '):''}`);
  await page.close();
}
// ── 게이트 3b: 조립 태그 계약 (asmChunked + asmGroup) ──
console.log('=== 조립 태그 계약 (buildBuilding 직접) ===');
{
  const page = await browser.newPage();
  let cerr=0; page.on('pageerror',(e)=>{cerr++;totalErr++;console.error('[contract pageerror]',e.message);});
  await page.goto(`http://127.0.0.1:${port}/__contract`,{waitUntil:'load'});
  try { await page.waitForFunction('window.__DONE===true',null,{timeout:20000}); } catch { console.error('CONTRACT TIMEOUT'); }
  const c = await page.evaluate(()=>window.__CONTRACT);
  for (const k of Object.keys(c||{})) console.log('  '+k+':', JSON.stringify(c[k]));
  await page.close();
}
console.log('TOTAL pageerror=' + totalErr);
await browser.close(); server.close();
