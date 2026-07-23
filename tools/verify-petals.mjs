// 계절 입자 필드(#111) 수치 검증 — 스크린샷·PNG 없이 코드·WebGL 픽셀 단언.
//   node tools/verify-petals.mjs
//
// 방식: esbuild(app/node_modules)로 src/env/weather.js(+petals.js) 를 브라우저 번들로 묶어 전용 포트
//   4225 에 자체 하네스 HTML 로 서빙 → playwright(chrome)가 weather 를 결정론적으로 구동하며
//   window 노출 API 로 상태를 읽어 단언한다. 앱(dev 5174)·dist 무접촉, 시각 판정 없음.
//
// 검증 항목:
//   ① 발현 매트릭스: {spring,summer,autumn,winter} × {근경(camDist 30), 부감(camDist 210)}
//   ② 팔랑거림: 무풍에서 입자 x 변위 비단조(플러터) + 낙하 y 단조 감소
//   ③ 카메라 추종: 중심 ±80m 이동 후 입자 AABB 가 카메라 주변을 감쌈
//   ④ 눈·비 회귀: 물리 geometry count·world scale·부감 CPU/draw 휴면, rain count
//   ⑤ 조기노출: 원점 빈 터(building 숨김·중심 원점)에서 count 0, 건물 복귀 후 상승(게이트 미고착)
//   ⑥ 광학 계약: 눈·꽃잎은 픽셀 크기 보상이 아니라 실제 월드 크기와 명시적 DoF depth를 유지
//   ⑦ pageerror 0

import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { launchVerificationBrowser, reportWebGLRenderer } from './lib/verification-browser.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const esbuild = require(resolve(ROOT, 'app/node_modules/esbuild'));

// ── 하네스 엔트리(브라우저에서 실행, window 에 결정론 구동 API 노출) ──
const ENTRY = `
import * as THREE from 'three';
import { setupWeather } from ${JSON.stringify(resolve(ROOT, 'src/env/weather.js'))};
const LAYOUT = { totalH:20, xEave:9, zEave:6, W:12, D:8, podTopY:1, eaveEdgeY:6.5 };
window.__mk = (o={}) => {
  if (window.__W) window.__W.dispose();
  const scene = new THREE.Scene();
  const building = { visible: o.bv !== false };
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(2,2), new THREE.MeshStandardMaterial());
  scene.add(ground);
  const W = setupWeather(scene, { layout: LAYOUT, getBuilding: () => building, getGround: () => ground, lowPerf: true });
  window.__W = W; window.__scene = scene; window.__b = building;
  return true;
};
window.__drive = (frames, dt, c) => {
  for (let i=0;i<frames;i++){ if (c) window.__W.setWeatherCenter(c.x, c.z, c.d, c.y, c.w, c.v); window.__W.update(dt); }
};
window.__record = (frames, dt, c, idx) => {
  const out=[];
  for (let i=0;i<frames;i++){
    if (c) window.__W.setWeatherCenter(c.x, c.z, c.d, c.y);
    window.__W.update(dt);
    const a = window.__W._petals.object.geometry.attributes.aOffset.array;
    out.push([a[idx*3], a[idx*3+1], a[idx*3+2]]);
  }
  return out;
};
window.__level = () => window.__W._petals.level;
window.__count = () => window.__W._petals.count;
window.__season = (n) => window.__W.setSeason(n);
window.__weather = (n,o) => window.__W.setWeather(n,o);
window.__ppos = () => { const p = window.__W._petals.object.position; return [p.x,p.y,p.z]; };
window.__aabb = () => { const b = window.__W._petals.aabb(); return { min:[b.min.x,b.min.y,b.min.z], max:[b.max.x,b.max.y,b.max.z] }; };
window.__snow = () => { const s = window.__scene.getObjectByName('weatherSnowPhysical'); return { worldScale: s.material.uniforms.uWorldScale.value, vis: s.visible, n: s.geometry.instanceCount, depth: !!s.userData.dofDepthMaterial }; };
window.__petalOptics = () => { const p = window.__W._petals.object; return { worldScale: p.material.uniforms.uWorldScale.value, level: window.__W._petals.level, depth: !!p.userData.dofDepthMaterial }; };
window.__rain = () => { const r = window.__scene.getObjectByName('weatherRainPhysical'); return { vis: r.visible, n: r.geometry.instanceCount, depth: !!r.userData.dofDepthMaterial }; };
window.__precipState = (kind) => {
  const name = kind === 'rain' ? 'weatherRainPhysical' : 'weatherSnowPhysical';
  const values = window.__scene.getObjectByName(name).geometry.attributes.aCenter.array;
  return Array.from(values.slice(0, 24));
};
window.__setWind = (v) => { window.__windScale = v; };
window.__ready = true;
`;

const built = await esbuild.build({
  stdin: { contents: ENTRY, resolveDir: ROOT, sourcefile: 'harness.js', loader: 'js' },
  bundle: true, format: 'iife', write: false,
  nodePaths: [resolve(ROOT, 'app/node_modules')],
  logLevel: 'silent',
});
const BUNDLE = built.outputFiles[0].text;
const HTML = `<!doctype html><meta charset=utf8><body><script>${BUNDLE}</script>`;

const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' }); res.end(HTML);
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const port = server.address().port;

const browser = await launchVerificationBrowser();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
await page.waitForFunction('window.__ready === true', { timeout: 15000 });
await reportWebGLRenderer(page, 'petals');

const results = [];
const approx = (a, b, tol) => Math.abs(a - b) <= tol;
function check(name, cond, detail) { results.push({ name, ok: !!cond, detail }); }

// ── ① 발현 매트릭스 ──
const DT = 1 / 30;
const matrix = await page.evaluate((dt) => {
  const near = { x: 0, z: 0, d: 30 }, aerial = { x: 0, z: 0, d: 210 };
  const out = {};
  for (const s of ['spring', 'summer', 'autumn', 'winter']) {
    for (const [tag, c] of [['near', near], ['aerial', aerial]]) {
      window.__mk({ bv: true }); window.__season(s); window.__setWind(1);
      window.__drive(40, dt, c);
      out[s + '_' + tag] = window.__level();
    }
  }
  return out;
}, DT);
check('①spring 근경 발현', matrix.spring_near > 0.3, `level=${matrix.spring_near.toFixed(3)}`);
check('①spring 부감 소거', matrix.spring_aerial < 0.02, `level=${matrix.spring_aerial.toFixed(3)}`);
check('①autumn 근경 발현', matrix.autumn_near > 0.3, `level=${matrix.autumn_near.toFixed(3)}`);
check('①autumn 부감 소거', matrix.autumn_aerial < 0.02, `level=${matrix.autumn_aerial.toFixed(3)}`);
check('①summer 근경 무발현', matrix.summer_near < 0.001, `level=${matrix.summer_near.toFixed(3)}`);
check('①summer 부감 무발현', matrix.summer_aerial < 0.001, `level=${matrix.summer_aerial.toFixed(3)}`);
check('①winter 근경 무발현', matrix.winter_near < 0.001, `level=${matrix.winter_near.toFixed(3)}`);
check('①winter 부감 무발현', matrix.winter_aerial < 0.001, `level=${matrix.winter_aerial.toFixed(3)}`);

// ── ② 팔랑거림(무풍: 순수 플러터+낙하) ──
const traj = await page.evaluate((dt) => {
  window.__mk({ bv: true }); window.__season('spring'); window.__setWind(0);
  window.__drive(5, dt, { x: 0, z: 0, d: 30 });          // present 프라임+중심 고정
  return window.__record(600, dt, { x: 0, z: 0, d: 30 }, 0); // 입자 0 궤적 20초
}, DT);
{
  let xSign = 0, prevDx = 0, yNeg = 0, yBadPos = 0;
  const H = 41.0; // yTop-yBottom (petals.js)
  for (let i = 1; i < traj.length; i++) {
    const dx = traj[i][0] - traj[i - 1][0];
    if (prevDx !== 0 && Math.sign(dx) !== Math.sign(prevDx) && Math.abs(dx) > 1e-4) xSign++;
    if (Math.abs(dx) > 1e-4) prevDx = dx;
    const dy = traj[i][1] - traj[i - 1][1];
    if (dy < 0) yNeg++;
    else if (dy > 0 && dy < H * 0.5) yBadPos++;   // 작은 양의 dy = 비단조 상승(랩 아님) → 결함
  }
  check('②플러터 x 비단조', xSign >= 2, `x부호전환=${xSign}`);
  check('②낙하 y 단조감소', yNeg > traj.length * 0.9 && yBadPos === 0, `y감소프레임=${yNeg}/${traj.length}, 비정상상승=${yBadPos}`);
}

// ── ③ 카메라 추종 ──
const follow = await page.evaluate((dt) => {
  window.__mk({ bv: true }); window.__season('autumn'); window.__setWind(1);
  window.__drive(20, dt, { x: 80, z: -80, d: 30 });
  return { ppos: window.__ppos(), aabb: window.__aabb() };
}, DT);
check('③중심 이설', approx(follow.ppos[0], 80, 0.01) && approx(follow.ppos[2], -80, 0.01), `ppos=${JSON.stringify(follow.ppos)}`);
check('③AABB 카메라 주변', follow.aabb.min[0] < 80 && follow.aabb.max[0] > 80 && follow.aabb.min[2] < -80 && follow.aabb.max[2] > -80,
  `x[${follow.aabb.min[0].toFixed(1)},${follow.aabb.max[0].toFixed(1)}] z[${follow.aabb.min[2].toFixed(1)},${follow.aabb.max[2].toFixed(1)}]`);

// ── ④ 눈·비 물리 geometry 회귀 ──
const wx = await page.evaluate((dt) => {
  window.__mk({ bv: true }); window.__weather('snow', { immediate: true });
  window.__drive(30, dt, { x: 0, z: 0, d: 42, w: 1 });
  const snowNear = window.__snow();
  const snowStateBeforeSleep = window.__precipState('snow');
  window.__drive(5, dt, { x: 0, z: 0, d: 210, w: 0 });
  const snowAerial = window.__snow();
  const snowStateAfterSleep = window.__precipState('snow');
  window.__mk({ bv: true }); window.__weather('rain', { immediate: true });
  window.__drive(30, dt, { x: 0, z: 0, d: 42, w: 1 });
  const rain = window.__rain();
  return { snowNear, snowAerial, rain, snowStateBeforeSleep, snowStateAfterSleep };
}, DT);
check('④snow count', wx.snowNear.n === 3600 && wx.snowNear.vis, `n=${wx.snowNear.n} vis=${wx.snowNear.vis}`);
check('④snow 실제 크기', approx(wx.snowNear.worldScale, 0.012, 1e-6), `worldScale=${wx.snowNear.worldScale}`);
check('④snow 부감 휴면', !wx.snowAerial.vis, `vis=${wx.snowAerial.vis}`);
check('④snow 부감 CPU state 휴면',
  JSON.stringify(wx.snowStateBeforeSleep) === JSON.stringify(wx.snowStateAfterSleep),
  `stable=${JSON.stringify(wx.snowStateBeforeSleep) === JSON.stringify(wx.snowStateAfterSleep)}`);
check('④snow 물리 depth', wx.snowNear.depth, `depth=${wx.snowNear.depth}`);
check('④rain count·depth', wx.rain.n === 2600 && wx.rain.vis && wx.rain.depth, `n=${wx.rain.n} vis=${wx.rain.vis} depth=${wx.rain.depth}`);

// ── ⑤ 조기노출 게이트(원점 빈 터 count 0, 건물 복귀 후 상승) ──
const gate = await page.evaluate((dt) => {
  window.__mk({ bv: false }); window.__season('spring'); window.__setWind(1);
  window.__drive(60, dt, null);          // 중심 미이설(원점)+건물 숨김 → present 거짓
  const empty = window.__level();
  window.__b.visible = true;             // 건물 복귀
  window.__drive(60, dt, { x: 0, z: 0, d: 30 });
  const recovered = window.__level();
  return { empty, recovered };
}, DT);
check('⑤빈 터 조기노출 차단', gate.empty < 0.02, `level=${gate.empty.toFixed(3)}`);
check('⑤정착 후 발현(미고착)', gate.recovered > 0.5, `level=${gate.recovered.toFixed(3)}`);

// ── ⑥ 광학 계약: compensated dolly에서도 실제 world 크기·depth 불변 ──
const optical = await page.evaluate((dt) => {
  window.__mk({ bv: true }); window.__season('spring'); window.__weather('snow', { immediate: true });
  window.__drive(30, dt, { x: 0, z: 0, d: 56.7, v: 42, y: 28, w: 1 });
  return { snow: window.__snow(), petal: window.__petalOptics() };
}, DT);
check('⑥snow world 크기·depth', approx(optical.snow.worldScale, 0.012, 1e-6)
    && optical.snow.depth,
`worldScale=${optical.snow.worldScale} depth=${optical.snow.depth}`);
check('⑥petal world 크기·depth·발현', approx(optical.petal.worldScale, 0.03, 1e-6)
    && optical.petal.depth && optical.petal.level > 0.3,
`worldScale=${optical.petal.worldScale} depth=${optical.petal.depth} level=${optical.petal.level.toFixed(3)}`);

// ── ⑦ pageerror ──
check('⑦pageerror 0', errors.length === 0, errors.join(' | ') || 'none');

await browser.close(); server.close();

let pass = 0;
for (const r of results) { console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  — ${r.detail}`); if (r.ok) pass++; }
console.log(`\n${pass}/${results.length} passed`);
process.exit(pass === results.length ? 0 : 1);
