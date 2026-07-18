import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { chromium } from 'playwright';
const ROOT='/Users/hckim/repo/asiahouse';
const MIME={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.json':'application/json','.mp3':'audio/mpeg','.svg':'image/svg+xml'};
const s=await new Promise(ok=>{const s=createServer(async(req,res)=>{try{const p=req.url.split('?')[0];const f=join(ROOT,'app','dist-envflow',p==='/'?'index.html':p);const d=await readFile(f);res.writeHead(200,{'content-type':MIME[extname(f)]||'application/octet-stream'});res.end(d);}catch{res.writeHead(404);res.end('nf');}});s.listen(0,"127.0.0.1",()=>ok(s));});
const port=s.address().port;
const browser=await chromium.launch().catch(()=>chromium.launch({channel:'chrome'}));
const page=await browser.newPage({viewport:{width:1280,height:800}});
page.on('pageerror',e=>console.log('[pageerror]',e.message));
await page.goto(`http://127.0.0.1:${port}/?village=1&flow=1&flowsec=2&time=dawn&lang=en&seed=7&vseed=7`,{waitUntil:'load'});
await page.waitForFunction(()=>window.__engine&&window.__envflow,null,{timeout:20000});
const t0=Date.now();
let last=null;
while(Date.now()-t0<12000){
  const st=await page.evaluate(()=>({t:window.__engine.getState().time, fl:window.__envflow.flowing, v:window.__engine.village.getState().active, hero:window.__envflow.heroVisible??null, timer:window.__envflow.timerArmed??null}));
  const key=JSON.stringify(st);
  if(key!==last){ console.log(((Date.now()-t0)/1000).toFixed(1)+'s', key); last=key; }
  await new Promise(r=>setTimeout(r,200));
}
await browser.close();s.close();
