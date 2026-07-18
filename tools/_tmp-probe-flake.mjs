import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
const { PNG } = createRequire(import.meta.url)('pngjs');
const ROOT='/Users/hckim/repo/asiahouse';
const MIME={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.json':'application/json','.mp3':'audio/mpeg','.svg':'image/svg+xml'};
function serve(base){return new Promise(ok=>{const s=createServer(async(req,res)=>{try{const p=req.url.split('?')[0];const f=join(base,p==='/'?'index.html':p);const d=await readFile(f);res.writeHead(200,{'content-type':MIME[extname(f)]||'application/octet-stream'});res.end(d);}catch{res.writeHead(404);res.end('nf');}});s.listen(0,'127.0.0.1',()=>ok(s));});}
function luma(buf){const png=PNG.sync.read(buf);const d=png.data;let s=0,n=0;for(let i=0;i<d.length;i+=4*37){s+=0.299*d[i]+0.587*d[i+1]+0.114*d[i+2];n++;}return s/n;}
const browser=await chromium.launch().catch(()=>chromium.launch({channel:'chrome'}));
const sApp=await serve(join(ROOT,'app','dist-probe'));const pApp=sApp.address().port;
for(let i=0;i<5;i++){
 const page=await browser.newPage({viewport:{width:1280,height:800}});
 const errs=[];page.on('pageerror',e=>errs.push(e.message));
 await page.goto(`http://127.0.0.1:${pApp}/?shot=1&time=dawn&season=autumn&weather=snow&seed=7`,{waitUntil:'load'});
 await page.waitForTimeout(6000);
 console.log(`app snow #${i+1}: luma=${luma(await page.screenshot()).toFixed(1)} errs=${errs.length}`);
 await page.close();
}
sApp.close();
const sCore=await serve(ROOT);const pCore=sCore.address().port;
for(let i=0;i<3;i++){
 const page=await browser.newPage({viewport:{width:1280,height:800}});
 const errs=[];page.on('pageerror',e=>errs.push(e.message));
 await page.goto(`http://127.0.0.1:${pCore}/index.html?shot=1&env=1&preset=korea&season=autumn&time=dawn&weather=snow`,{waitUntil:'load'});
 await page.waitForFunction('window.__SHOT_READY===true',null,{timeout:40000}).catch(()=>console.log('  (SHOT_READY timeout)'));
 await page.waitForTimeout(500);
 console.log(`core snow #${i+1}: luma=${luma(await page.screenshot()).toFixed(1)} errs=${errs.length}`);
 await page.close();
}
sCore.close();await browser.close();
