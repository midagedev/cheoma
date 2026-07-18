import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { chromium } from 'playwright';
const ROOT = '/Users/hckim/repo/asiahouse';
const MIME={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.png':'image/png','.json':'application/json'};
const server=createServer(async(req,res)=>{try{const p=req.url.split('?')[0];const d=await readFile(join(ROOT,p==='/'?'index.html':p));res.writeHead(200,{'content-type':MIME[extname(p)]||'application/octet-stream'});res.end(d);}catch{res.writeHead(404);res.end('nf');}});
await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
const port=server.address().port;
let b;try{b=await chromium.launch({channel:'chrome'});}catch{b=await chromium.launch();}
const page=await b.newPage({viewport:{width:1280,height:800}});
const OUT='/Users/hckim/repo/asiahouse/shots';
// 팀리드 재현 URL 그대로
const url=`http://127.0.0.1:${port}/index.html?shot=1&env=1&time=sunset&preset=korea&weather=clear`;
const url0=`http://127.0.0.1:${port}/index.html?shot=1&env=1&time=sunset&preset=korea&weather=clear&post=0`;
async function shoot(u,name,waitMs){
 await page.goto(u,{waitUntil:'load'});
 await page.waitForFunction('window.__SHOT_READY===true',null,{timeout:30000});
 await page.waitForTimeout(waitMs);
 await page.screenshot({path:join(OUT,name+'.png')});
 console.log('saved',name,'(wait',waitMs,'ms), accum=', await page.evaluate(()=>{try{return window.__wx?window.__wx.accum:'na'}catch{return 'err'}}));
}
await shoot(url,'wo-post-300ms',300);
await shoot(url,'wo-post-5s',5000);
await shoot(url0,'wo-post0-5s',5000);
await b.close();server.close();
