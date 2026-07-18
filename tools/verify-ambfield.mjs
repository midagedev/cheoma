// #105 카메라 앵커 앰비언스 필드 + #106 길가 바람 풀 — 코드·수치 검증(스크린샷·PNG Read 없음).
//   전용 포트 4224. WebGL2 헤드리스에서 실제 field/grass/lantern 모듈을 직접 구동하고 수치 단언.
//   드로우콜은 WebGL draw 호출 패치로 실측(렌더 전후 증분). 결정론은 planVillage 이중 해시(check-determinism 동형).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

const HTML = `<!DOCTYPE html><html><head><meta charset="utf-8">
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.185.1/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.185.1/examples/jsm/"}}</script>
</head><body><script type="module">
import * as THREE from 'three';
import { createAmbientField } from '/src/env/focus.js';
import { setupGrass } from '/src/env/grass.js';
import { setupLanternSway } from '/src/env/motes.js';
import { attachOverlayLanterns } from '/src/layout/props.js';
import { planVillage } from '/src/village/plan.js';

const out = { errors: [] };
try {
  // ── 렌더러(드로우콜 실측용) ──
  const canvas = document.createElement('canvas'); canvas.width = 800; canvas.height = 600;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
  renderer.setPixelRatio(1);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;   // 앱과 동일(기본 NoToneMapping 은 motes.js 가 ink 로 오인해 모트 은닉)
  const scene = new THREE.Scene();
  const sun = new THREE.DirectionalLight(0xffffff, 1.0); sun.position.set(30, 60, 20); sun.castShadow = false; scene.add(sun);
  scene.add(new THREE.HemisphereLight(0xbcd4ec, 0x8a7a63, 0.6));
  const camera = new THREE.PerspectiveCamera(45, 800 / 600, 0.1, 4000);

  const drawDelta = (fn) => { const a = window.__gl; fn(); return window.__gl - a; };
  const render = () => renderer.render(scene, camera);
  const baseDraws = drawDelta(render);   // 씬(조명만) 기저 드로우콜

  // ── 합성 필지 격자(49) — 16m 간격 ──
  const descs = []; let n = 0;
  for (let gx = -3; gx <= 3; gx++) for (let gz = -3; gz <= 3; gz++) {
    const cx = gx * 16, cz = gz * 16; n++;
    descs.push({ id: 'p' + n, cx, cz, baseY: 0, rotY: 0, W: 18, D: 16,
      style: (n % 3 === 0) ? 'choga' : 'giwa', seed: (n * 2654435761) >>> 0,
      chimney: { x: cx + 3.6, y: 4.5, z: cz - 4.5 } });
  }

  // 카메라를 진탑다운(y=50)으로 두면 지면 앵커 = 카메라 XZ (거리 = 수평오프셋으로 정밀 제어).
  const topDown = (ax, az, y = 50) => { camera.position.set(ax, y, az); camera.lookAt(ax, 0, az); camera.updateMatrixWorld(true); };
  const dt = 1 / 60;
  const runFrames = (k, field) => { for (let i = 0; i < k; i++) field.update(dt, camera); };

  const field = createAmbientField(scene, { sun, renderer });
  field.setParcels(descs);
  field.setTime('sunset', true);

  // ── ① 계층 카운트 + 캡 (부감→중경→근접) ──
  // 부감: 카메라 매우 높음, 원점 응시 → 앵커=원점. 중심 필지가 근접/중간.
  topDown(0, 0, 140); runFrames(240, field);
  const aerial = field._debug();
  // 근접: 특정 필지(p25=원점 근방) 프레이밍 거리 ~20m. 진탑다운 근접.
  topDown(20, 0, 26); runFrames(240, field);
  const near = field._debug();
  out.tier = {
    aerial: { near: aerial.near, mid: aerial.mid },
    near: { near: near.near, mid: near.mid, nearIds: near.nearIds, midIds: near.midIds },
    NEAR_CAP_ok: near.near <= 2 && aerial.near <= 2,
    MID_CAP_ok: near.mid <= 8 && aerial.mid <= 8,
  };

  // ── ① LRU 교체: 중간 범위에 다수 필지 → 캡 6, 앵커 이동 시 교체 발생 ──
  topDown(0, 0, 8); runFrames(300, field);   // 진탑다운 근접, 다수 필지가 근접/중간
  const lruA = field._debug();
  const midSetA = new Set(lruA.midIds);
  topDown(40, 40, 8); runFrames(300, field);   // 앵커 이동 → 다른 필지군
  const lruB = field._debug();
  const midSetB = new Set(lruB.midIds);
  const dropped = [...midSetA].filter((id) => !midSetB.has(id)).length;
  const added = [...midSetB].filter((id) => !midSetA.has(id)).length;
  out.lru = { midA: lruA.mid, midB: lruB.mid, dropped, added,
    capHeld: lruA.mid <= 6 && lruB.mid <= 6, replaced: dropped > 0 && added > 0 };

  // ── ② 히스테리시스: 근접 필지를 경계 밴드 안에서 왕복 → 토글 최소 ──
  // p 원점 필지(cx=0,cz=0)를 근접시킨 뒤, 카메라 앵커 거리를 28↔32(밴드 [26,34]) 왕복.
  topDown(0, 0, 6); runFrames(200, field);   // 원점 필지 근접 확보
  const originId = 'p25';   // gx=0,gz=0 → n = ((0+3)*7 + (0+3)) +1 = 25
  const wasNear = field._debug().nearIds.includes(originId);
  let toggles = 0; let prevNear = wasNear;
  for (let c = 0; c < 24; c++) {
    const d = (c % 2 === 0) ? 28 : 32;   // 밴드 안 왕복(진탑다운: 앵커=카메라XZ, 거리=d)
    topDown(d, 0, 50); field.update(dt, camera);
    const isNear = field._debug().nearIds.includes(originId);
    if (isNear !== prevNear) toggles++;
    prevNear = isNear;
  }
  // 밴드 밖(먼 거리)으로 빼면 반드시 이탈(메커니즘 응답 확인).
  topDown(90, 0, 50); runFrames(60, field);
  const droppedOut = !field._debug().nearIds.includes(originId) && !field._debug().midIds.includes(originId);
  out.hysteresis = { wasNear, toggles, droppedOut, ok: toggles <= 2 && droppedOut };

  // ── ③ 속도 게이트: 고속 이동 중 신규 점등 0 ──
  topDown(0, 0, 10); runFrames(200, field);   // 정지 상태에서 셀 확보
  // 고속 워밍업(speed>GATE 로 올림).
  let px = 0;
  for (let i = 0; i < 8; i++) { px += 40; topDown(px, 0, 10); field.update(dt, camera); }
  const hot = field._debug().speedHot;
  const snap = new Set([...field._debug().nearIds, ...field._debug().midIds]);
  let newDuringFast = 0;
  for (let i = 0; i < 24; i++) {
    px += 40; topDown(px, 0, 10); field.update(dt, camera);
    for (const id of [...field._debug().nearIds, ...field._debug().midIds]) if (!snap.has(id)) newDuringFast++;
  }
  out.speedGate = { hot, speed: field._debug().speed, newDuringFast, ok: hot && newDuringFast === 0 };

  // ── ④ 프리워밍 훅: __ambLookahead → 원격 지점 선행 점등 ──
  topDown(200, 200, 40); runFrames(120, field);   // 필지 없는 먼 곳(정지 → 속도 냉각)
  const beforeLA = field._debug().near + field._debug().mid;
  window.__ambLookahead(0, 0);   // 원점 필지군 선행 점등 요청
  runFrames(200, field);
  const afterLA = field._debug();
  const laHasCentral = [...afterLA.nearIds, ...afterLA.midIds].some((id) => {
    const d = descs.find((x) => x.id === id); return d && Math.hypot(d.cx, d.cz) < 30;
  });
  out.lookahead = { beforeLA, afterLA: afterLA.near + afterLA.mid, laHasCentral,
    ok: typeof window.__ambLookahead === 'function' && afterLA.near + afterLA.mid > beforeLA && laHasCentral };

  // ── ⑦ 드로우콜 표: 필드 활성 상태(근접+중간 populated) 델타 ──
  // 안정 상태 확보(연기 게이트·페이드 램프 포함) 후, 업데이트 정지 + 광각 프레이밍으로 모든 활성
  //   셀·연기를 프러스텀에 담아 실측(top-down 좁은 프러스텀 컬링 언더카운트 방지). 연기 토글로 구조/연기 분해.
  topDown(20, 0, 24); runFrames(340, field);
  const dbgDraw = field._debug();
  const wide = () => { camera.position.set(10, 90, 150); camera.lookAt(10, 0, 10); camera.updateMatrixWorld(true); };
  wide(); renderer.render(scene, camera);   // 워밍(프레임버퍼·프러스텀 정착)
  const dFull = drawDelta(render);
  field._setSmokeVisible(false);
  render(); const dStruct = drawDelta(render);   // 연기 제외 = 구조(모트+등롱 bulb)
  field._setSmokeVisible(true);
  out.draw = {
    base: baseDraws, full: dFull, delta: dFull - baseDraws,
    structural: dStruct - baseDraws, smoke: dFull - dStruct,
    tiers: { near: dbgDraw.near, mid: dbgDraw.mid, smokeAnchors: dbgDraw.smokeAnchors },
    // 구조(모트+등롱 bulb) ≤12 예산 준수. 연기는 THREE.Sprite 특성상 파티클당 1콜(불가피) — 캡으로 상한만.
    structOk: (dStruct - baseDraws) <= 12,
    boundedOk: dFull < 60,   // 총량 상한(마을 천장 <1000 대비 여유)
  };

  field.dispose();
  render(); const afterDisposeDraws = drawDelta(render);
  out.draw.afterDispose = afterDisposeDraws;
  out.draw.disposeClean = Math.abs(afterDisposeDraws - baseDraws) <= 1;
  out.lookaheadCleared = typeof window.__ambLookahead === 'undefined';

  // ── ⑤ 정규 필지 등롱 sway (props.attachOverlayLanterns + motes.setupLanternSway) ──
  const swScene = new THREE.Scene();
  const scope = new THREE.Group(); scope.position.set(0, 0, 0); swScene.add(scope);
  attachOverlayLanterns(scope, { style: 'giwa', W: 18, D: 16, seed: 12345 });
  const bulbs = scope.children.filter((c) => c.name === 'lantern-bulb');
  const bases = bulbs.map((b) => b.position.clone());
  const sway = setupLanternSway({ scene: swScene, scope });
  sway.setEnabled(true);
  let maxMove = 0;
  for (let i = 0; i < 360; i++) {   // ~6s
    sway.update(1 / 60);
    for (let j = 0; j < bulbs.length; j++) maxMove = Math.max(maxMove, bulbs[j].position.distanceTo(bases[j]));
  }
  out.lanternSway = { bulbPairs: bulbs.length, maxMove: +maxMove.toFixed(4),
    ok: bulbs.length > 0 && maxMove > 1e-3 };

  // ── ⑥ 길가 풀 분포·밀도·드로우콜(#106) ──
  const gScene = new THREE.Scene();
  gScene.add(new THREE.HemisphereLight(0xffffff, 0x808080, 0.6));
  const gCam = new THREE.PerspectiveCamera(45, 800 / 600, 0.1, 2000); gCam.position.set(0, 8, 30); gCam.lookAt(0, 0, 0);
  const gBase = drawDelta(() => renderer.render(gScene, gCam));
  const grass = setupGrass(gScene, { bounds: { W: 24, D: 20 }, sun, seed: 777, style: 'giwa', gateW: 5.2 });
  grass.setFade(1); grass.update(1 / 60);
  const gWith = drawDelta(() => renderer.render(gScene, gCam));
  const L = grass.drawInfo.lanes || { road: 0, alley: 0, rest: 0, yard: 0 };
  const roadside = L.road + L.alley + L.rest;   // 길가/외곽(담장 바깥)
  const baseN = grass.drawInfo.baseN;
  const density = grass.drawInfo.instances / baseN;
  out.grass = {
    instances: grass.drawInfo.instances, baseN, density: +density.toFixed(3),
    lanes: L, roadside, yard: L.yard, drawDelta: gWith - gBase,
    ok: (gWith - gBase) === 1 && roadside > L.yard && density >= 1.5 && density <= 2.0,
  };
  grass.dispose();

  // ── ⑨ 결정론(planVillage 이중 해시) ──
  const hashPlan = (scale) => {
    const includePalace = typeof scale === 'number' ? scale >= 213 : (scale === 'hanyang' || scale === 'capital');
    const p = planVillage({ scale, seed: 20260716, includePalace, includeTemple: true });
    const parts = [];
    for (const pc of p.parcels) parts.push(pc.id, pc.kind, pc.center.x.toFixed(3), pc.center.z.toFixed(3), pc.variant, (pc.rank || 0).toFixed(3));
    return parts.join('|');
  };
  const det = {};
  for (const scale of ['hamlet', 'village', 'town', 'capital', 'hanyang', 210, 440]) {
    det[typeof scale === 'number' ? 'R' + scale : scale] = hashPlan(scale) === hashPlan(scale);
  }
  out.determinism = det;
  out.determinismAllPass = Object.values(det).every(Boolean);
} catch (e) {
  out.errors.push(String(e && e.stack ? e.stack : e));
}
window.__AMB = out; window.__READY = true;
</script></body></html>`;

const server = createServer(async (req, res) => {
  const path = req.url.split('?')[0];
  if (path === '/__amb') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(HTML); return; }
  try {
    const data = await readFile(join(ROOT, path === '/' ? 'index.html' : path));
    res.writeHead(200, { 'content-type': MIME[extname(path)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise((ok) => server.listen(4224, '127.0.0.1', ok));

let browser;
try { browser = await chromium.launch({ channel: 'chrome' }); } catch { browser = await chromium.launch(); }
const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
let pageErrors = 0;
page.on('pageerror', (e) => { pageErrors++; console.error('[pageerror]', e.message); });
page.on('console', (m) => { if (m.type() === 'error') console.error('[console.error]', m.text()); });

await page.addInitScript(() => {
  window.__gl = 0;
  const patch = (proto) => { if (!proto) return;
    for (const fn of ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced']) {
      const orig = proto[fn]; if (!orig) continue;
      proto[fn] = function (...a) { window.__gl++; return orig.apply(this, a); };
    }
  };
  patch(window.WebGL2RenderingContext && window.WebGL2RenderingContext.prototype);
  patch(window.WebGLRenderingContext && window.WebGLRenderingContext.prototype);
});

await page.goto('http://127.0.0.1:4224/__amb', { waitUntil: 'load' });
await page.waitForFunction('window.__READY === true', null, { timeout: 60000 });
const R = await page.evaluate(() => window.__AMB);
await browser.close(); server.close();

// ── 리포트 + 판정 ──
const P = (b) => (b ? 'PASS' : 'FAIL');
const line = (s) => console.log(s);
line('\n════════ #105 카메라 앵커 앰비언스 필드 + #106 길가 풀 검증 ════════');
if (R.errors && R.errors.length) { line('‼ 런타임 에러:'); for (const e of R.errors) line('  ' + e); }

line('\n① 계층 카운트·캡');
line(`   부감  near=${R.tier.aerial.near} mid=${R.tier.aerial.mid}`);
line(`   근접  near=${R.tier.near.near} mid=${R.tier.near.mid}  [${R.tier.near.nearIds.join(',')}]`);
line(`   근접 캡(≤2) ${P(R.tier.NEAR_CAP_ok)} · 중간 캡(≤8) ${P(R.tier.MID_CAP_ok)}`);
line(`   LRU  midA=${R.lru.midA} midB=${R.lru.midB} dropped=${R.lru.dropped} added=${R.lru.added} → 캡유지 ${P(R.lru.capHeld)} 교체 ${P(R.lru.replaced)}`);

line('\n② 히스테리시스(경계 왕복)');
line(`   근접확보=${R.hysteresis.wasNear} 토글=${R.hysteresis.toggles}(≤2) 밴드밖이탈=${R.hysteresis.droppedOut} → ${P(R.hysteresis.ok)}`);

line('\n③ 속도 게이트');
line(`   speedHot=${R.speedGate.hot} speed=${R.speedGate.speed} 고속중신규점등=${R.speedGate.newDuringFast} → ${P(R.speedGate.ok)}`);

line('\n④ 프리워밍 훅(__ambLookahead)');
line(`   전=${R.lookahead.beforeLA} 후=${R.lookahead.afterLA} 중심점등=${R.lookahead.laHasCentral} → ${P(R.lookahead.ok)}`);
line(`   dispose 후 훅 정리=${R.lookaheadCleared ? 'PASS' : 'FAIL'}`);

line('\n⑤ 정규 필지 등롱 sway');
line(`   bulb짝=${R.lanternSway.bulbPairs} maxMove=${R.lanternSway.maxMove} → ${P(R.lanternSway.ok)}`);

line('\n⑥ 길가 풀(#106)');
line(`   인스턴스=${R.grass.instances} baseN=${R.grass.baseN} 밀도=${R.grass.density}× (1.5~2.0)`);
line(`   lanes road=${R.grass.lanes.road} alley=${R.grass.lanes.alley} rest=${R.grass.lanes.rest} yard=${R.grass.lanes.yard} → 길가=${R.grass.roadside} > 마당=${R.grass.yard}`);
line(`   드로우콜 델타=${R.grass.drawDelta}(+1 유지) → ${P(R.grass.ok)}`);

line('\n⑦ 드로우콜 표(before/after, 광각 프레이밍 실측)');
line(`   씬 기저=${R.draw.base}  필드활성=${R.draw.full}  필드델타=+${R.draw.delta}`);
line(`   └ 구조(모트+등롱 bulb)=+${R.draw.structural}(≤12) ${P(R.draw.structOk)}  연기(스프라이트)=+${R.draw.smoke} [Sprite 파티클당 1콜·불가피]`);
line(`   (활성 티어: near=${R.draw.tiers.near} mid=${R.draw.tiers.mid} 연기앵커=${R.draw.tiers.smokeAnchors}) 총량상한(<60) ${P(R.draw.boundedOk)}`);
line(`   dispose 후=${R.draw.afterDispose} 기저복귀 ${P(R.draw.disposeClean)}`);

line('\n⑧ pageerror');
line(`   pageerror=${pageErrors} 런타임에러=${(R.errors || []).length} → ${P(pageErrors === 0 && (R.errors || []).length === 0)}`);

line('\n⑨ 결정론(planVillage 이중 해시)');
line(`   ${Object.entries(R.determinism).map(([k, v]) => k + ':' + (v ? 'ok' : 'X')).join(' ')} → ${P(R.determinismAllPass)}`);

const gates = [
  R.tier.NEAR_CAP_ok, R.tier.MID_CAP_ok, R.lru.capHeld, R.lru.replaced,
  R.hysteresis.ok, R.speedGate.ok, R.lookahead.ok, R.lookaheadCleared,
  R.lanternSway.ok, R.grass.ok, R.draw.disposeClean, R.draw.structOk, R.draw.boundedOk,
  pageErrors === 0 && (R.errors || []).length === 0, R.determinismAllPass,
];
const allPass = gates.every(Boolean);
line(`\n════════ 종합: ${allPass ? 'ALL PASS' : 'FAIL (' + gates.filter((x) => !x).length + '개)'} ════════\n`);
process.exit(allPass ? 0 : 1);
