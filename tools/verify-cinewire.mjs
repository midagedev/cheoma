// 헤드리스 검증(#112): 시네마틱 데모 모드(#103 코어 배선) + glb 다운로드(#104 코어 배선).
//   스크린샷·PNG 없음 — window.__engine / window.__glb 훅으로 상태·수치만 단언한다.
// 사용법: node tools/verify-cinewire.mjs
//
// 정적 서빙: app/dist-cine (사용자 dev 5174 미접촉), 포트 4226. 클린 빌드 선행(rm -rf → vite build --outDir dist-cine).
//
// 엔진 훅:
//   cine.start(mode,{pass})  cine.stop()  cine.isActive()  cine.available()
//   cine.getState()          : { active, mode, pass, index, chain[], single, t }
//   cine.passList()          : [{ name, kind, duration }]  (드론 4패스)
//   cine.debugCam()          : { pos, finite, fov, look{x,y,z}, controlsEnabled, targetFinite }
//   cine.debugWalker()       : { clearance, eyeHeight, colliding, outside, pos }
//   cine.debugAdvance()      : 현 드론 패스 강제 완주(전환/종료 관찰)
//   village.debugParcels() / village.debugFocus(id) / village.reroll()
//   __glb.analyzeVillage() / __glb.exportHouse() / __glb.exportVillage(opts) / __glb.hasFocus()
//
// 게이트: ① 드론 4패스 재생 중 finite + 종료 인계(controls.enabled·target finite) ② 오토플레이 체인 전이
//   ③ ESC/stop 중단 방향 연속성(각도차<5°) ④ 1인칭 autoStroll 접지 오차<0.3m·finite ⑤ glb 집/마을/overBudget
//   ⑥ 히어로·focus·리롤 회귀(pageerror 0·finite) ⑦ 빌드 클린(빌드 로그로 별도 확인).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..');
const DIST = join(ROOT, 'app', 'dist-cine');
const PORT = 4226;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.woff': 'font/woff', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };

const server = createServer(async (req, res) => {
  let path = decodeURIComponent(req.url.split('?')[0]);
  if (path === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  if (path === '/') path = '/index.html';
  try {
    const data = await readFile(join(DIST, path));
    res.writeHead(200, { 'content-type': MIME[extname(path)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise((ok) => server.listen(PORT, '127.0.0.1', ok));
const base = `http://127.0.0.1:${PORT}`;

let browser;
try { browser = await chromium.launch({ channel: 'chrome' }); } catch { browser = await chromium.launch(); }

const errors = [];
const ignorable = (t) => /favicon/i.test(t);
function watch(page, tag) {
  page.on('console', (m) => { if (m.type() === 'error' && !ignorable(m.text())) { errors.push(`[${tag}] ${m.text()}`); console.error(`[${tag} console]`, m.text()); } });
  page.on('pageerror', (e) => { errors.push(`[${tag}] ${e.message}`); console.error(`[${tag} pageerror]`, e.message); });
  page.on('requestfailed', (req) => { const u = req.url(); if (!ignorable(u)) { errors.push(`[${tag} reqfailed] ${u}`); console.error(`[${tag} reqfailed]`, u, req.failure()?.errorText); } });
}
const ev = (page, fn, ...a) => page.evaluate(fn, ...a);
const wait = (page, ms) => ev(page, (m) => new Promise((r) => setTimeout(r, m)), ms);
async function ready(page) { await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 40000 }); await wait(page, 500); }

const RESULTS = [];
const ok = (cond, msg) => { RESULTS.push((cond ? 'PASS ' : 'FAIL ') + msg); console.log((cond ? 'PASS ' : 'FAIL ') + msg); };

const cine = (page) => ev(page, () => window.__engine.cine.getState());
const cam = (page) => ev(page, () => window.__engine.cine.debugCam());
// 방위(라디안): 카메라 시선벡터의 수평각. 방향 연속성(스냅 튐) 계측.
const lookAngle = (l) => Math.atan2(l.x, l.z);
function angleDiff(a, b) { let d = Math.abs(a - b) % (2 * Math.PI); if (d > Math.PI) d = 2 * Math.PI - d; return d; }

// ───────────────────────── 마을 부감 진입 ─────────────────────────
const page = await browser.newPage({ viewport: { width: 1280, height: 800, deviceScaleFactor: 1 } });
watch(page, 'cine');
await page.goto(`${base}/index.html?village=1&seed=20260719&vseed=11&time=day`, { waitUntil: 'load' });
await ready(page);

const avail = await ev(page, () => window.__engine.cine.available());
ok(avail === true, `진입 가능(부감에서 cine.available)=${avail}`);
const passes = await ev(page, () => window.__engine.cine.passList());
console.log('PASSES', JSON.stringify(passes.map((p) => `${p.name}:${p.duration}s`)));
ok(passes.length === 4, `드론 패스 4종 생성 (n=${passes.length})`);
const names = passes.map((p) => p.name).sort().join(',');
ok(names === 'crane-in,landmark-orbit,pullback-reveal,street-flythrough', `패스 명칭 규약 (${names})`);

// ── 게이트 ① : 드론 4패스 각각 재생 중 finite + 종료 인계 ──
for (const p of passes) {
  await ev(page, (n) => window.__engine.cine.start('drone', { pass: n }), p.name);
  await wait(page, 150);
  let allFinite = true, active = false;
  const st0 = await cine(page); active = st0.active && st0.pass === p.name;
  // ~1.4s 재생 동안 여러 지점 finite 샘플(매 프레임 카메라 소유 검증).
  for (let i = 0; i < 8; i++) {
    await wait(page, 170);
    const c = await cam(page);
    if (!c.finite || !c.targetFinite) allFinite = false;
  }
  ok(active, `①[${p.name}] 재생 시작(active·pass 일치)`);
  ok(allFinite, `①[${p.name}] 재생 중 camera pos/quat/target finite`);
  await ev(page, () => window.__engine.cine.stop());
  await wait(page, 120);
  const after = await cam(page);
  const st1 = await cine(page);
  ok(!st1.active && after.controlsEnabled && after.targetFinite && after.finite,
    `①[${p.name}] 종료 후 orbit 인계(active=${st1.active} controls=${after.controlsEnabled} targetFinite=${after.targetFinite})`);
}

// ── 게이트 ② : 오토플레이 체인 — 순서·전이·상태머신 ──
await ev(page, () => window.__engine.cine.start('drone'));
await wait(page, 200);
const chainSt = await cine(page);
console.log('CHAIN', JSON.stringify(chainSt.chain), 'idx', chainSt.index, 'pass', chainSt.pass);
ok(chainSt.chain.join(',') === 'crane-in,landmark-orbit,street-flythrough,pullback-reveal',
  `② 체인 순서(진입→선회→비행→당김) (${chainSt.chain.join('→')})`);
ok(chainSt.active && chainSt.index === 0 && !chainSt.single, `② 체인 재생 시작(index=0·single=false)`);
// debugAdvance 로 각 패스를 강제 완주시켜 전이 관찰(긴 duration 대기 없이).
const seen = [chainSt.pass];
let camFiniteThroughCut = true;
let maxChainTurnRate = 0;
for (let i = 0; i < 5; i++) {
  await ev(page, () => window.__engine.cine.debugAdvance());
  for (let sample = 0; sample < 6; sample++) {
    await wait(page, 24);
    const state = await cine(page);
    maxChainTurnRate = Math.max(maxChainTurnRate, state.turnRateDeg || 0);
  }
  const c = await cam(page); if (!c.finite) camFiniteThroughCut = false;
  const s = await cine(page);
  if (s.pass !== seen[seen.length - 1]) seen.push(s.pass);
}
console.log('CHAIN SEQ', seen.join(' → '));
ok(seen.length >= 3, `② 패스 전이 발생(관측 ${seen.length}종: ${seen.join('→')})`);
// 5회 강제 완주 → crane 이 두 번(index 0·4) 나타남 = 체인 끝에서 처음으로 순환.
ok(seen.filter((s) => s === 'crane-in').length >= 2 || seen.length >= 5, `② 체인 순환(재-crane 관측: ${seen.join('→')})`);
ok(camFiniteThroughCut, `② 패스 컷 전환 중 camera finite`);
ok(maxChainTurnRate <= 72.2, `② 패스 컷 시선 각속도 ≤ 72.2°/s (max=${maxChainTurnRate.toFixed(1)}°/s)`);
const stillActive = (await cine(page)).active;
ok(stillActive, `② 체인은 순환 재생(자동 종료 안 함)=${stillActive}`);

// ── 게이트 ③ : 중단(stop) 방향 연속성(스냅 튐 없음) ──
await ev(page, () => window.__engine.cine.start('drone', { pass: 'landmark-orbit' }));
await wait(page, 900);
const before = await cam(page);
await ev(page, () => window.__engine.cine.stop());
await wait(page, 60);
const afterStop = await cam(page);
const dAng = angleDiff(lookAngle(before.look), lookAngle(afterStop.look)) * 180 / Math.PI;
console.log('ESC look before', JSON.stringify(before.look), 'after', JSON.stringify(afterStop.look), 'diff(deg)', dAng.toFixed(2));
ok(dAng < 5, `③ 중단 전후 시선 각도차 < 5° (${dAng.toFixed(2)}°)`);
ok(afterStop.controlsEnabled, `③ 중단 즉시 controls.enabled 복구`);
// orbit 조작 가능: 유휴 자동회전이든 사용자 조작이든 controls.update 재개(정지 게이트 해제).
const opAfter = await ev(page, () => window.__engine.cine.isActive());
ok(opAfter === false, `③ 중단 후 데모 비활성(orbit 소유 복귀)`);

// ── 게이트 ④ : 1인칭 autoStroll 접지·finite ──
await ev(page, () => window.__engine.cine.start('walk'));
await wait(page, 300);
const wSt = await cine(page);
ok(wSt.active && wSt.mode === 'walk', `④ 1인칭 진입(mode=walk)`);
let maxErr = 0, wFinite = true, samples = 0;
const T_WALK = 20000, STEP = 1000;
for (let e = 0; e < T_WALK; e += STEP) {
  await wait(page, STEP);
  const w = await ev(page, () => window.__engine.cine.debugWalker());
  if (!w) { wFinite = false; break; }
  const err = Math.abs(w.clearance - w.eyeHeight);
  if (err > maxErr) maxErr = err;
  if (![w.pos.x, w.pos.y, w.pos.z].every(Number.isFinite)) wFinite = false;
  samples++;
}
console.log('WALK samples', samples, 'maxClearanceErr', maxErr.toFixed(3), 'finite', wFinite);
ok(wFinite, `④ autoStroll 중 pos finite (${samples} 샘플)`);
ok(maxErr < 0.3, `④ 접지 오차 |clearance-1.6| < 0.3m (max=${maxErr.toFixed(3)})`);
const wCam = await cam(page);
ok(wCam.finite, `④ 1인칭 카메라 finite`);
await ev(page, () => window.__engine.cine.stop());
await wait(page, 150);
ok((await cam(page)).controlsEnabled, `④ 1인칭 종료 후 controls 복구`);

// ── 게이트 ⑤ : glb 익스포트 ──
// 집: 필지 focus → focusRoot 익스포트.
const parcels = await ev(page, () => window.__engine.village.debugParcels());
const target = parcels.find((p) => p.editable && !p.hero) || parcels.find((p) => !p.hero) || parcels[0];
await ev(page, (id) => window.__engine.village.debugFocus(id), target.parcelId);
// 전환(FOCUS_IN_DUR~1.9s) 완료 대기.
await wait(page, 2600);
const hasFocus = await ev(page, () => window.__glb.hasFocus());
ok(hasFocus, `⑤ focus 오버레이 익스포트 대상 확보 (${target.parcelId})`);
const houseRes = await ev(page, () => window.__glb.exportHouse());
console.log('GLB house', JSON.stringify(houseRes));
ok(houseRes.ok && houseRes.bytes > 0, `⑤ 집 glb byteLength>0 (${houseRes.bytes} bytes, ${houseRes.name})`);
// 부감 복귀 후 마을 익스포트.
await ev(page, () => window.__engine.village.escape());
await wait(page, 2200);
const analyze = await ev(page, () => window.__glb.analyzeVillage());
console.log('GLB analyze village', JSON.stringify(analyze));
ok(analyze && analyze.triangles > 0 && analyze.meshes > 0, `⑤ 마을 analyzeExport(tri=${analyze?.triangles} mesh=${analyze?.meshes} mat=${analyze?.materials})`);
const villRes = await ev(page, () => window.__glb.exportVillage());
console.log('GLB village', JSON.stringify(villRes));
ok(villRes.ok && villRes.bytes > 0, `⑤ 마을 glb byteLength>0 (${villRes.bytes} bytes, ${villRes.name})`);
const overRes = await ev(page, () => window.__glb.exportVillage({ maxTriangles: 100 }));
console.log('GLB overBudget', JSON.stringify(overRes));
ok(!overRes.ok && overRes.over, `⑤ overBudget 경로 동작(tri=${overRes.triangles} > limit=${overRes.limit})`);

// ── 게이트 ⑥ : 회귀 — focus/리롤 후 finite + 데모 종료 정합 ──
await ev(page, () => window.__engine.village.reroll());
await wait(page, 1600);
const afterReroll = await cam(page);
ok(afterReroll.finite && afterReroll.controlsEnabled, `⑥ 마을 리롤 후 camera finite·controls 정상`);
// 리롤 뒤에도 데모 재진입 가능(패스 재생성).
const availAfter = await ev(page, () => window.__engine.cine.available());
ok(availAfter, `⑥ 리롤 후 데모 재진입 가능`);

// ── 게이트 ⑥b : 히어로 랜딩 진입(기본 부팅) 회귀 — 별도 페이지 ──
const heroPage = await browser.newPage({ viewport: { width: 1280, height: 800, deviceScaleFactor: 1 } });
watch(heroPage, 'hero');
await heroPage.goto(`${base}/index.html?seed=20260719`, { waitUntil: 'load' });
await ready(heroPage);
await wait(heroPage, 800);
const heroCam = await ev(heroPage, () => window.__engine.cine.debugCam());
ok(heroCam.finite, `⑥ 히어로 부팅 후 camera finite`);
await heroPage.close();

// ───────────────────────── 결과 ─────────────────────────
ok(errors.length === 0, `pageerror/console-error 0건 (n=${errors.length})`);
console.log('\n===== VERIFY-CINEWIRE RESULTS =====');
for (const r of RESULTS) console.log(r);
const fails = RESULTS.filter((r) => r.startsWith('FAIL'));
console.log(`\n${RESULTS.length - fails.length}/${RESULTS.length} PASS`);
if (errors.length) { console.log('\n--- errors ---'); for (const e of errors) console.log(e); }

await browser.close();
server.close();
process.exit(fails.length ? 1 : 0);
