// 오토로테이션 케이던스 결정 프로브: 4s 간격, 전이 시퀀스+간격 실측
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { chromium } from 'playwright';
const ROOT='/Users/hckim/repo/asiahouse';
const MIME={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.json':'application/json','.mp3':'audio/mpeg','.svg':'image/svg+xml'};
const s=await new Promise(ok=>{const s=createServer(async(req,res)=>{try{const p=req.url.split('?')[0];const f=join(ROOT,'app','dist-envflow',p==='/'?'index.html':p);const d=await readFile(f);res.writeHead(200,{'content-type':MIME[extname(f)]||'application/octet-stream'});res.end(d);}catch{res.writeHead(404);res.end('nf');}});s.listen(0,'127.0.0.1',()=>ok(s));});
const port=s.address().port;
const browser=await chromium.launch().catch(()=>chromium.launch({channel:'chrome'}));
const page=await browser.newPage({viewport:{width:1280,height:800}});
page.on('pageerror',e=>console.log('[pageerror]',e.message));
await page.goto(`http://127.0.0.1:${port}/?hero=0&flow=1&flowsec=4&time=dawn&season=summer&weather=clear&lang=en&seed=1`,{waitUntil:'load'});
await page.waitForFunction(()=>window.__engine&&window.__envflow,null,{timeout:15000});
const t0=Date.now();
let last=null; const transitions=[];
while(Date.now()-t0<26000){
  const cur=await page.evaluate(()=>window.__engine.getState().time);
  if(cur!==last){ transitions.push({at:((Date.now()-t0)/1000).toFixed(1), time:cur}); last=cur; }
  await new Promise(r=>setTimeout(r,150));
}
console.log('전이 시퀀스:', transitions.map(t=>`${t.time}@${t.at}s`).join(' → '));
const gaps=[];for(let i=2;i<transitions.length;i++)gaps.push((transitions[i].at-transitions[i-1].at).toFixed(1));
console.log('전이 간격(s):', gaps.join(', '));
await browser.close();s.close();
