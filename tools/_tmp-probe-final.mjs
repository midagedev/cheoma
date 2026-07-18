import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
const { PNG } = createRequire(import.meta.url)('pngjs');
const ROOT='/Users/hckim/repo/asiahouse';
const MIME={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.json':'application/json','.mp3':'audio/mpeg','.svg':'image/svg+xml'};
const s=await new Promise(ok=>{const s=createServer(async(req,res)=>{try{const p=req.url.split('?')[0];const f=join(ROOT,'app','dist-probe',p==='/'?'index.html':p);const d=await readFile(f);res.writeHead(200,{'content-type':MIME[extname(f)]||'application/octet-stream'});res.end(d);}catch{res.writeHead(404);res.end('nf');}});s.listen(0,'127.0.0.1',()=>ok(s));});
const port=s.address().port;
function luma(buf){const png=PNG.sync.read(buf);const d=png.data;let t=0,n=0;for(let i=0;i<d.length;i+=4*37){t+=0.299*d[i]+0.587*d[i+1]+0.114*d[i+2];n++;}return t/n;}
const browser=await chromium.launch().catch(()=>chromium.launch({channel:'chrome'}));
for(const q of ['shot=1&time=dawn&season=autumn&lang=en&seed=7','shot=1&time=dawn&season=autumn&lang=en&seed=7','hero=0&time=dawn&season=autumn&seed=7']){
 const page=await browser.newPage({viewport:{width:1280,height:800}});
 const errs=[];page.on('pageerror',e=>errs.push(e.message));
 await page.goto(`http://127.0.0.1:${port}/?${q}`,{waitUntil:'load'});
 await page.waitForTimeout(6000);
 console.log(`luma=${luma(await page.screenshot()).toFixed(1)} errs=${errs.length}  ${q}`);
 await page.close();
}
await browser.close();s.close();
