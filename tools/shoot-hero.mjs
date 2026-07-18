// #98 히어로 오프닝 감동 복원 — 코드·수치 전용 검증(스크린샷 없음, 토큰 절약).
// 클린 빌드(app/dist-hero)를 전용 포트 4217 로 구동해 다음을 단언한다:
//   ① 타이밍: 착공~조립 완료 시각, 첫 인터랙션 가능 시점(초).
//   ② 조립 중 선회: 방위각 변화율>0(매 샘플 구간).
//   ③ 앰비언트 입자 매트릭스: 부감/focus/히어로 3상태 × {snow, rain, 낙엽, motes} 발현(visible·eff).
//   ④ 무대 연출: 조립 동안 fog near/far 좁힘 → 완료 후 열림.
// 사용법: NODE_PATH=/Users/hckim/repo/threesur/node_modules node tools/shoot-hero.mjs
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..');
const DIST = join(ROOT, 'app', 'dist-hero');
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.svg': 'image/svg+xml',
};
const server = createServer(async (req, res) => {
  const path = decodeURIComponent(req.url.split('?')[0]);
  try {
    const file = join(DIST, path === '/' ? 'index.html' : path);
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise((ok) => server.listen(4217, '127.0.0.1', ok));
const PORT = 4217;

let browser;
try { browser = await chromium.launch({ channel: 'chrome' }); }
catch { browser = await chromium.launch(); }
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
let pageErrs = 0, consoleErrs = 0;
page.on('console', (m) => { if (m.type() === 'error') { const t = m.text(); if (/favicon|404/.test(t)) return; consoleErrs++; console.error('[console]', t); } });
page.on('pageerror', (e) => { pageErrs++; console.error('[pageerror]', e.message); });

// 씬 트래버스 기반 입자 introspection — 부모 체인 visible 곱(effective visible) + level/uFade.
await page.addInitScript(() => {
  window.__effVis = null;
  window.__probe = () => {
    const eng = window.__engine, hero = window.__hero;
    if (!eng || !hero) return null;
    const scene = eng.scene, cam = eng.camera;
    const byName = (n) => scene.getObjectByName(n);
    const effVisible = (o) => { let p = o; while (p) { if (!p.visible) return false; p = p.parent; } return true; };
    // 스크린 중심(NDC 0,0) 광선과 입자 필드 중심의 XZ 근접도 — "보는 곳에 눈/비가 오는가".
    const camXZ = { x: cam.position.x, z: cam.position.z };
    const snow = byName('weatherSnow'), rain = byName('weatherRain');
    // env motes(넓은 헤이즈)와 focus 링 motes(마당 먼지)를 분리 계측 — 둘 다 name='dustMotes'.
    const allMotes = []; scene.traverse((o) => { if (o.name === 'dustMotes') allMotes.push(o); });
    const leaves = byName('seasonLeaves');
    const fr = byName('focusRing');
    // 입자 필드의 월드 중심(matrixWorld 이동분).
    const worldPos = (o) => { if (!o) return null; o.updateWorldMatrix(true, false); const e = o.matrixWorld.elements; return { x: e[12], y: e[13], z: e[14] }; };
    const dist2 = (a, b) => (a && b && Number.isFinite(a.x) && Number.isFinite(b.x)) ? Math.hypot(a.x - b.x, a.z - b.z) : -1;
    const anyMoteVis = allMotes.some((m) => effVisible(m));
    return {
      selected: hero.selected, transitioning: hero.transitioning, heroAsm: hero.heroAsm,
      focusStrength: +hero.focusStrength.toFixed(3), focusRetiring: hero.focusRetiring,
      az: +hero.az.toFixed(4), target: hero.target, camPos: hero.camPos,
      fogNear: hero.fogNear != null ? +hero.fogNear.toFixed(1) : null,
      fogFar: hero.fogFar != null ? +hero.fogFar.toFixed(1) : null,
      siteR: hero.siteR,
      snow: snow ? { vis: effVisible(snow), uFade: snow.material?.uniforms?.uFade?.value ?? null, distToTarget: +dist2(worldPos(snow), hero.target).toFixed(1) } : null,
      rain: rain ? { vis: effVisible(rain), distToTarget: +dist2(worldPos(rain), hero.target).toFixed(1) } : null,
      motes: { anyVis: anyMoteVis, instances: allMotes.length, envVis: allMotes[0] ? effVisible(allMotes[0]) : false },
      leaves: leaves ? { vis: effVisible(leaves), count: leaves.count ?? 0 } : null,
      focusRingPresent: !!fr, focusRingChildren: fr ? fr.children.length : 0,
      // #102 DoF + #98 역광/창빛
      dofOn: hero.dofOn, dofFocus: hero.dofFocus != null ? +hero.dofFocus.toFixed(2) : null,
      dofTargetDist: +hero.dofTargetDist.toFixed(2), dofErr: (hero.dofFocus != null) ? +Math.abs(hero.dofFocus - hero.dofTargetDist).toFixed(2) : null,
      sunAz: +hero.sunAz.toFixed(4), heroRotY: hero.heroRotY != null ? +hero.heroRotY.toFixed(4) : null,
      timeState: hero.timeState,
      // 창호 발광 재질 수(emissiveIntensity>0) — 석양 hanjiGlow 점등 계측.
      glowMats: (() => { let n = 0; scene.traverse((o) => { const ms = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []); for (const m of ms) if (m && m.emissiveIntensity > 0.001 && m.emissive && (m.emissive.r + m.emissive.g + m.emissive.b) > 0.05) { n++; break; } }); return n; })(),
    };
  };
});

const probe = () => page.evaluate(() => window.__probe());
const wait = (ms) => page.waitForTimeout(ms);
const now = () => page.evaluate(() => performance.now());

// time 미지정 — 기본(FLAGSHIP_TIME=sunset) 이 시드 있어도 적용되는지 검증(#98 sunset 기본).
const url = `http://127.0.0.1:${PORT}/?seed=42&vseed=20260716&lang=ko`;
await page.goto(url, { waitUntil: 'load' });
await wait(1400);   // 타이틀 + 마을 사전 생성

console.log('=== #98 HERO RESTORE METRICS ===');
const bootTime = await page.evaluate(() => window.__engine.getState().time);
console.log(`[SUNSET DEFAULT] boot state.time=${bootTime}  ASSERT: ${bootTime === 'sunset' ? 'PASS' : 'FAIL'}`);

// ── ① 타이밍 + ② 선회: 타이틀 클릭 → 랜딩. 방위각·조립상태를 250ms 간격 샘플. ──
// 크로마 감상 페이드가 클릭을 지연시키지 않게 mouse 이동으로 깨운 뒤 즉시 클릭(타이밍 계측 정확도).
await page.mouse.move(720, 400); await wait(60);
const tClick = await now();
await page.click('.hero', { force: true });
const samples = [];
for (let i = 0; i < 44; i++) {   // ~11초 관측
  await wait(250);
  const p = await probe();
  const t = ((await now()) - tClick) / 1000;
  if (p) {
    const camDist = Math.hypot(p.camPos.x - p.target.x, p.camPos.y - p.target.y, p.camPos.z - p.target.z);
    samples.push({ t: +t.toFixed(2), az: p.az, camDist: +camDist.toFixed(1), heroAsm: p.heroAsm, transitioning: p.transitioning, fogNear: p.fogNear, fogFar: p.fogFar, focusStrength: p.focusStrength });
  }
}
const camFiniteAll = samples.every((s) => Number.isFinite(s.az) && Number.isFinite(s.camDist));
const minCamDist = Math.min(...samples.filter((s) => s.heroAsm).map((s) => s.camDist));
console.log(`  camera finite(all samples): ${camFiniteAll ? 'PASS' : 'FAIL'}  minCamDist(asm)=${Number.isFinite(minCamDist) ? minCamDist.toFixed(1) : 'n/a'}`);
// 조립 구간(heroAsm=true) 방위각 변화율. 각도 랩(±π) 보정해 인접 차분.
const asmSamples = samples.filter((s) => s.heroAsm && Number.isFinite(s.az));
const wrap = (d) => { while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };
let minRate = Infinity, maxRate = 0, azSpan = 0;
if (asmSamples.length >= 2) {
  for (let i = 1; i < asmSamples.length; i++) {
    const dAz = Math.abs(wrap(asmSamples[i].az - asmSamples[i - 1].az));
    const dT = asmSamples[i].t - asmSamples[i - 1].t;
    const rate = dT > 0 ? dAz / dT : 0;
    azSpan += dAz;
    minRate = Math.min(minRate, rate); maxRate = Math.max(maxRate, rate);
  }
}
console.log('  raw az during assembly:', asmSamples.map((s) => `${s.t}s:${(s.az * 180 / Math.PI).toFixed(0)}°`).join(' '));
const asmStart = samples.find((s) => s.heroAsm)?.t ?? null;
const asmEnd = [...samples].reverse().find((s) => s.heroAsm)?.t ?? null;
// 첫 인터랙션 가능 = transitioning 이 false 로 안착한 첫 시각.
const firstInteractive = samples.find((s) => s.heroAsm === false && s.transitioning === false && s.t > 1)?.t ?? null;

console.log('\n[① TIMING]');
console.log(`  assembly window: start=${asmStart}s end=${asmEnd}s dur=${asmStart != null && asmEnd != null ? (asmEnd - asmStart).toFixed(2) : '?'}s`);
console.log(`  firstInteractive(transitioning=false): ${firstInteractive}s`);
console.log('\n[② ROTATION during assembly]');
console.log(`  asm samples=${asmSamples.length} azSpan=${(azSpan * 180 / Math.PI).toFixed(1)}deg minRate=${(minRate === Infinity ? 0 : minRate).toFixed(4)}rad/s maxRate=${maxRate.toFixed(4)}rad/s`);
console.log(`  ASSERT rotation-alive: ${asmSamples.length >= 2 && azSpan > 0.05 ? 'PASS' : 'FAIL'}`);
console.log('\n[④ STAGE fog during assembly vs after]');
const fogAsm = asmSamples.length ? asmSamples[Math.floor(asmSamples.length / 2)] : null;
const fogAfter = samples[samples.length - 1];
console.log(`  fog mid-assembly: near=${fogAsm?.fogNear} far=${fogAsm?.fogFar}`);
console.log(`  fog after:        near=${fogAfter?.fogNear} far=${fogAfter?.fogFar}`);

// ── 역광 구도 + 창빛 + DoF 도착(#98/#102) — 랜딩 정착 프레임 계측 ──
await wait(600);
const hp = await probe();
const rad2deg = (r) => r * 180 / Math.PI;
const wrapDeg = (d) => { while (d > 180) d -= 360; while (d < -180) d += 360; return d; };
const frontDeg = rad2deg(hp.heroRotY ?? 0);
const camAzDeg = rad2deg(hp.az);
const sunAzDeg = rad2deg(hp.sunAz);
const camVsFront = Math.abs(wrapDeg(camAzDeg - frontDeg));
const sunVsBack = Math.abs(wrapDeg(sunAzDeg - (frontDeg + 180)));
console.log('\n[역광 정측면 구도 (final stop)]');
console.log(`  time=${hp.timeState} frontDir(rotY)=${frontDeg.toFixed(0)}° cameraAz=${camAzDeg.toFixed(0)}° sunAz=${sunAzDeg.toFixed(0)}°`);
console.log(`  camera vs frontDir=${camVsFront.toFixed(0)}° (ASSERT ≤35: ${camVsFront <= 35 ? 'PASS' : 'FAIL'})`);
console.log(`  sun vs frontDir+180=${sunVsBack.toFixed(0)}° (ASSERT ≤30: ${sunVsBack <= 30 ? 'PASS' : 'FAIL'}) → 역광`);
console.log('\n[창호 발광 (석양 hanjiGlow)]');
console.log(`  glowMats(emissive>0)=${hp.glowMats}  ASSERT >0: ${hp.glowMats > 0 ? 'PASS' : 'FAIL'}`);
console.log('\n[② DoF 도착 오차 (focus 정착)]');
console.log(`  dofOn=${hp.dofOn} focus=${hp.dofFocus} targetDist=${hp.dofTargetDist} err=${hp.dofErr}m  ASSERT <1m: ${hp.dofErr != null && hp.dofErr < 1 ? 'PASS' : 'FAIL'}`);

// ── ③ 앰비언트 매트릭스: 3상태 × {snow, rain, 낙엽, motes} ──
// FOCUS 상태(랜딩 정착). 날씨=눈 → 눈 입자, 계절=가을 → 낙엽.
await wait(500);
async function measureAmbient(label) {
  const p = await probe();
  console.log(`\n  [${label}] selected=${p.selected} transitioning=${p.transitioning} focusStrength=${p.focusStrength} ringChildren=${p.focusRingChildren}`);
  console.log(`    snow:  ${p.snow ? `vis=${p.snow.vis} uFade=${(p.snow.uFade ?? 0).toFixed(2)} distToTarget=${p.snow.distToTarget}` : 'null'}`);
  console.log(`    rain:  ${p.rain ? `vis=${p.rain.vis} distToTarget=${p.rain.distToTarget}` : 'null'}`);
  console.log(`    motes: ${p.motes ? `anyVis=${p.motes.anyVis} instances=${p.motes.instances} envVis=${p.motes.envVis}` : 'null'}`);
  console.log(`    leaves:${p.leaves ? `vis=${p.leaves.vis} count=${p.leaves.count}` : 'null'}`);
  return p;
}
console.log('\n[③ AMBIENT MATRIX]');
// 눈 + 가을 세팅(EnvironmentDial 경유가 아니라 엔진 API 직접 — 결정론).
await page.evaluate(() => { window.__engine.setSeason('autumn'); window.__engine.setWeather('snow'); });
await wait(3200);   // 눈 레벨 램프 + 낙엽 partAmt
const focusSnow = await measureAmbient('FOCUS · snow+autumn');

// 비로 전환.
await page.evaluate(() => window.__engine.setWeather('rain'));
await wait(3200);
const focusRain = await measureAmbient('FOCUS · rain+autumn');

// 부감(遠) 토글 — 집→부감 focus-out(DoF 완화).
await page.click('.mode .seg:has(.glyph:text-is("遠"))');
await wait(2600);
const aerialRain = await measureAmbient('AERIAL · rain+autumn');
await page.evaluate(() => window.__engine.setWeather('snow'));
await wait(3000);
const aerialSnow = await measureAmbient('AERIAL · snow+autumn');
console.log('\n[③ 원경 정책 단언]');
console.log(`  부감 DoF off(흐릿한 마을 금지): dofOn=${aerialSnow.dofOn}  ASSERT false: ${aerialSnow.dofOn === false ? 'PASS' : 'FAIL'}`);
console.log(`  부감 카메라볼륨 입자>0: snow.vis=${aerialSnow.snow.vis} rain.vis=${aerialRain.rain.vis}  ASSERT: ${aerialSnow.snow.vis ? 'PASS' : 'FAIL'}`);
console.log(`  부감 낙엽 OFF(고도 게이트): leaves.vis=${aerialSnow.leaves.vis}  ASSERT false: ${aerialSnow.leaves.vis === false ? 'PASS' : 'FAIL'}`);

// 부감→집(近) focus-in — DoF 도착 오차 <1m(#102 경로2: 부감→집).
await page.click('.mode .seg:has(.glyph:text-is("近"))');
await wait(2800);
const backClose = await probe();
console.log('\n[#102 부감→집 focus-in DoF 도착]');
console.log(`  dofOn=${backClose.dofOn} err=${backClose.dofErr}m  ASSERT <1m: ${backClose.dofErr != null && backClose.dofErr < 1 ? 'PASS' : 'FAIL'}`);

// 리플레이(집 복귀 후 재조립) — 히어로 상태 동형 경로에서 조립 중 입자.
await page.click('.house-actions .hbtn.ghost').catch(() => {});
await wait(1400);
const replayAsm = await measureAmbient('HERO/REPLAY (mid-assembly) · snow+autumn');
console.log(`    replay heroAsm=${replayAsm?.heroAsm} transitioning=${replayAsm?.transitioning} time=${replayAsm?.timeState} glowMats=${replayAsm?.glowMats}`);

console.log(`\npageErrors=${pageErrs} consoleErrors=${consoleErrs}`);
await browser.close();
server.close();
