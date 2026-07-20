// giwa 좁은 폭 지붕 파탄 재현/검증 — mainHalfW 파라미터 스윕 + sx/sz 비균등 스케일 스윕.
// node tools/_tmp-roofw-sweep.mjs [outTag]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { chromium } from 'playwright';

const ROOT = '/Users/hckim/repo/asiahouse';
const TAG = process.argv[2] || 'before';
const OUT = '/private/tmp/claude-501/-Users-hckim-repo-asiahouse/7a15478e-68e3-4ad3-b08a-bdb86ae4fe92/scratchpad/roofw';
mkdirSync(OUT, { recursive: true });
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };

const HTML = `<!DOCTYPE html><html><head><meta charset="utf-8">
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.185.1/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.185.1/examples/jsm/"}}</script>
</head><body><div id="app"></div>
<script type="module">
import * as THREE from 'three';
import { buildBuilding } from '/src/builder/index.js';
import { PRESETS } from '/src/params.js';
const q = new URLSearchParams(location.search);
const halfW = q.get('halfW') != null ? parseFloat(q.get('halfW')) : undefined;
const sx = q.get('sx') != null ? parseFloat(q.get('sx')) : 1;
const sz = q.get('sz') != null ? parseFloat(q.get('sz')) : 1;
const angle = q.get('angle') || 'tq';
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(900, 700); renderer.setPixelRatio(1);
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
document.getElementById('app').appendChild(renderer.domElement);
const scene = new THREE.Scene(); scene.background = new THREE.Color(0xcfd8e0);
const P = { ...PRESETS.giwa };
if (halfW != null) P.mainHalfW = halfW;
let root;
try { root = buildBuilding(P); } catch(e){ window.__ERR = e.message; window.__READY = true; }
if (root) {
  root.scale.set(sx, 1, sz);       // 마을 sx/sz 비균등 스케일 재현
  scene.add(root);
  root.traverse((o)=>{ if(o.isMesh){o.castShadow=true;o.receiveShadow=true;} });
  // NaN·파탄 정량화: 지붕 그룹 정점 스캔 + 스켈레톤 마루 길이.
  let nanCount = 0, ridgeLenMin = Infinity, ridgeCount = 0;
  const roof = root.getObjectByName('roof');
  if (roof) {
    const sk = roof.userData && roof.userData.skeleton;
    if (sk && sk.ridges) { ridgeCount = sk.ridges.length; for (const s of sk.ridges) { const L = Math.hypot(s.a.x-s.b.x, s.a.z-s.b.z); ridgeLenMin = Math.min(ridgeLenMin, L); } }
    roof.traverse((o)=>{ if (o.isMesh && o.geometry) { const pa = o.geometry.attributes.position; if (pa) for (let i=0;i<pa.count*3;i++){ if(!isFinite(pa.array[i])) nanCount++; } } });
  }
  const box = new THREE.Box3().setFromObject(root);
  const bad = !isFinite(box.min.x)||!isFinite(box.max.y)||nanCount>0;
  const size = new THREE.Vector3(); box.getSize(size);
  const ctr = new THREE.Vector3(); box.getCenter(ctr);
  window.__INFO = { halfW, sx, sz, size:size.toArray(), nanCount, ridgeCount, ridgeLenMin: isFinite(ridgeLenMin)?ridgeLenMin:null, bad };
  const md = Math.max(size.x, size.z, size.y);
  const cam = new THREE.PerspectiveCamera(34, 900/700, 0.1, 200);
  if (angle === 'roof') { cam.position.set(ctr.x+md*0.55, ctr.y+md*1.6, ctr.z+md*1.0); }
  else if (angle === 'side') { cam.position.set(ctr.x+md*2.0, ctr.y+md*0.5, ctr.z+md*0.2); }
  else { cam.position.set(ctr.x+md*1.5, ctr.y+md*0.7, ctr.z+md*1.7); }
  cam.lookAt(ctr.x, ctr.y+size.y*0.1, ctr.z);
  const sun = new THREE.DirectionalLight(0xfff0dd, 2.6); sun.position.set(md*1.2, md*2.2, md*1.4);
  sun.castShadow=true; sun.shadow.mapSize.set(2048,2048);
  const sc=sun.shadow.camera; sc.left=-md*2;sc.right=md*2;sc.top=md*2;sc.bottom=-md*2;sc.near=0.1;sc.far=md*8;
  scene.add(sun);
  scene.add(new THREE.HemisphereLight(0xc4d6e8,0x9a8c72,1.2));
  let f=0; renderer.setAnimationLoop(()=>{ renderer.render(scene,cam); if(++f===4){window.__READY=true;} });
}
</script></body></html>`;

const server = createServer(async (req,res)=>{ const p=req.url.split('?')[0]; const nc={'cache-control':'no-store, max-age=0'}; if(p==='/__g'){res.writeHead(200,{'content-type':'text/html',...nc});res.end(HTML);return;} try{const d=await readFile(join(ROOT,p));res.writeHead(200,{'content-type':MIME[extname(p)]||'application/octet-stream',...nc});res.end(d);}catch{res.writeHead(404);res.end('nf');} });
await new Promise((ok)=>server.listen(0,'127.0.0.1',ok));
const port=server.address().port;
let browser; try{browser=await chromium.launch({channel:'chrome'});}catch{browser=await chromium.launch();}
const page=await browser.newPage({viewport:{width:900,height:700}});
let errs=0; page.on('pageerror',(e)=>{errs++;console.error('[pageerror]',e.message);});

// wingW 고정 2.6. mainHalfW 표준 4.2 → 좁게 스윕. a-w<0 (=2.6 미만)에서 풋프린트 역전 예상.
const widths=[4.2, 3.4, 2.8, 2.6, 2.4, 2.0];
console.log('=== mainHalfW 파라미터 스윕 (wingW=2.6 고정) ===');
for(const angle of ['tq','roof','side']){
  for(const hw of widths){
    await page.goto(`http://127.0.0.1:${port}/__g?halfW=${hw}&angle=${angle}`,{waitUntil:'load'});
    try{await page.waitForFunction('window.__READY===true',null,{timeout:20000});}catch{console.error('TIMEOUT',hw,angle);}
    const info=await page.evaluate(()=>window.__INFO||{err:window.__ERR});
    if(angle==='tq') console.log('halfW='+hw, 'a-w='+(hw-2.6).toFixed(2), 'nan='+info.nanCount, 'ridges='+info.ridgeCount, 'ridgeMin='+(info.ridgeLenMin!=null?info.ridgeLenMin.toFixed(2):'-'), 'bad='+info.bad, 'size='+(info.size?info.size.map(v=>+v.toFixed(2)):info));
    await page.screenshot({path:join(OUT,`${TAG}-w${String(hw).replace('.','_')}-${angle}.png`)});
  }
}
// 마을 실제 도달: sx 비균등 스케일 (0.82~1.19). sx 최소 + sz 최대 = 가장 납작.
console.log('=== sx/sz 비균등 스케일 스윕 (halfW=4.2) ===');
const scales=[[1,1],[0.82,1.19],[0.82,0.82],[1.19,0.82]];
for(const [ssx,ssz] of scales){
  await page.goto(`http://127.0.0.1:${port}/__g?sx=${ssx}&sz=${ssz}&angle=tq`,{waitUntil:'load'});
  try{await page.waitForFunction('window.__READY===true',null,{timeout:20000});}catch{console.error('TIMEOUT scale',ssx,ssz);}
  const info=await page.evaluate(()=>window.__INFO||{err:window.__ERR});
  console.log('sx='+ssx,'sz='+ssz,'nan='+info.nanCount,'bad='+info.bad,'size='+(info.size?info.size.map(v=>+v.toFixed(2)):info));
  await page.screenshot({path:join(OUT,`${TAG}-scale-${ssx}-${ssz}.png`)});
}
console.log('pageerror='+errs);
await browser.close(); server.close();
