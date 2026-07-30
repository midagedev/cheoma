// 카메라 전환 연속성 순수 계약 (task #22) — 브라우저 없음.
//
// 사용자 보고 3건의 **원인 수학**을 렌더러 없이 판정한다. 원인은 노드 수치로 단정하고 브라우저는
// 효과 확인 1회에만 쓴다는 저장소 규약(docs/verification.md)을 따른다.
//
// 판정 항목
//   ① 뷰 시프트(렌즈 시프트) 추종이 속도 연속이다: 목표가 계단으로 바뀌어도 첫 프레임 이동이
//      1px 이하이고(정지에서 출발), 프레임간 속도 점프가 임계감쇠 스프링의 해석 상한 안에 있다.
//      종전 1차 지연은 목표가 바뀐 **그 프레임에 최대 속도**를 내므로 첫 프레임에 10px 급 이동을
//      한다 — 히어로 정착 직후 인스펙터가 열릴 때 "화면 중심이 튀는" 원인.
//   ② 구도 밴드(가용 높이)가 계단으로 바뀌어도 적용 렌즈 시프트는 연속이다(크롬 등장/소멸).
//   ③ 전환(lock) 구간에는 OrbitControls 거리 클램프가 열려 있어 저작된 트윈 종점이 잘리지 않고,
//      정착 시 새 규모의 범위로 **이징**되어 들어온다. 종전에는 옛 마을 maxDistance 가 남아
//      리프레임 트윈 종료 프레임에 카메라가 한 프레임에 줌인됐다(실측 119~178m).
//   ④ 부감 줌 단위가 정착 시 현재 핸들/aspect 로 재동기된다(리롤로 반경이 바뀐 마을).
//
// 변경 전 코드에서 실패하는 단언: 세 모듈이 모두 `window.__camFlowLegacy` 로 종전 경로를 그대로
//   재현하므로, 이 게이트는 같은 소스에서 legacy=ON 케이스가 ①③ 을 위반함을 함께 단언한다
//   (게이트가 수정 전 코드에서 실패한다는 증거를 영구 픽스처로 들고 있는 셈).
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const requireApp = createRequire(join(ROOT, 'app', 'package.json'));
const esbuild = requireApp('esbuild');
const THREE_MAIN = join(ROOT, 'app/node_modules/three/build/three.module.js');
const THREE_ADDONS = join(ROOT, 'app/node_modules/three/examples/jsm');

const built = await esbuild.build({
  stdin: {
    contents: "export { createViewShift } from './app/src/engine/view-shift.js';"
      + " export { createVillageCameraRuntime } from './app/src/engine/village-camera-runtime.js';"
      + " export { VILLAGE_LENS, villageAerialReferenceDistance, dollyDistanceForFov,"
      + " villageZoomReferenceBounds } from './src/api/cinematic.js';"
      + " export * as THREE from 'three';",
    resolveDir: ROOT,
    sourcefile: 'camera-continuity-entry.js',
  },
  alias: { 'three/addons': THREE_ADDONS, three: THREE_MAIN },
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  write: false,
  logLevel: 'silent',
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString('base64')}`;
const {
  createViewShift,
  createVillageCameraRuntime,
  VILLAGE_LENS,
  villageAerialReferenceDistance,
  dollyDistanceForFov,
  villageZoomReferenceBounds,
  THREE,
} = await import(moduleUrl);

let checks = 0;
let failures = 0;
function check(name, condition, detail = '') {
  checks++;
  if (!condition) failures++;
  console.log(`  ${condition ? 'PASS' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}`);
}
const fixed2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : String(v));

// ── 최소 DOM 스텁: view-shift 는 실제 제품 경로(오버레이 수집 → safe rect)를 그대로 돈다.
//    오버레이는 "세로 시트"처럼 컨테이너 하단을 점유해 tgtY 를 만든다.
function makeElement(rect) {
  const element = {
    hidden: false,
    inert: false,
    getAttribute: () => null,
    getBoundingClientRect: () => rect,
    parentElement: null,
  };
  return element;
}
function installDom({ width, height, overlays = [] }) {
  const container = {
    clientWidth: width,
    clientHeight: height,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: width, bottom: height, width, height }),
  };
  globalThis.document = {
    body: {},
    querySelectorAll: () => overlays,
  };
  globalThis.getComputedStyle = () => ({ visibility: 'visible', display: 'block', opacity: '1' });
  return container;
}

const VIEWPORT = { width: 1024, height: 640 };
// 하단 240px 시트(모바일 반쪽 시트 상당) — 피사체를 위로 올려야 하므로 tgtY 가 크게 생긴다.
const sheet = makeElement({
  left: 0, right: VIEWPORT.width, top: VIEWPORT.height - 240, bottom: VIEWPORT.height,
});

function runShift({ legacy, dt = 1 / 60, frames = 120, overlays = [sheet] }) {
  const container = installDom({ ...VIEWPORT, overlays });
  globalThis.window = { __camFlowLegacy: legacy === true };
  const camera = new THREE.PerspectiveCamera(46, VIEWPORT.width / VIEWPORT.height, 0.1, 5000);
  const runtime = createViewShift({ container, camera, isBusy: () => false });
  // 크롬 없는 프레임에서 정지 상태로 출발(히어로 정착 = busy 해제 직전 상태).
  globalThis.document.querySelectorAll = () => [];
  runtime.update(dt);
  runtime.update(dt);
  const samples = [];
  // 이 프레임에 크롬이 나타난다(패널 등장) → 목표가 계단으로 바뀐다.
  globalThis.document.querySelectorAll = () => overlays;
  runtime.state.lastSample = -1e9;   // 다음 update 가 즉시 재샘플하도록(48ms 캐던스 우회)
  let previous = { x: runtime.state.curX, y: runtime.state.curY };
  for (let i = 0; i < frames; i++) {
    runtime.update(dt);
    const current = { x: runtime.state.curX, y: runtime.state.curY };
    samples.push({
      i,
      step: Math.hypot(current.x - previous.x, current.y - previous.y),
      x: current.x,
      y: current.y,
    });
    previous = current;
  }
  return { runtime, samples, target: Math.hypot(runtime.state.tgtX, runtime.state.tgtY) };
}

console.log('\n① 뷰 시프트 추종: 목표 계단 변화에서 속도 연속(정지에서 출발)');
{
  const fix = runShift({ legacy: false });
  const old = runShift({ legacy: true });
  const delta = fix.target;
  check('시프트 목표가 실제로 계단이다(> 40px)', delta > 40, `${fixed2(delta)}px`);

  const firstFixed = fix.samples[0].step;
  const firstLegacy = old.samples[0].step;
  check('수정본: 첫 프레임 이동 ≤ 목표의 1.5%(v0 = 0)', firstFixed <= delta * 0.015,
    `${fixed2(firstFixed)}px ≤ ${fixed2(delta * 0.015)}px`);
  check('종전(legacy): 첫 프레임에 이미 최대 속도(≥ 목표의 4%)', firstLegacy >= delta * 0.04,
    `${fixed2(firstLegacy)}px`);
  check('첫 프레임 개선 ≥ 4배', firstLegacy / Math.max(firstFixed, 1e-6) >= 4,
    `${(firstLegacy / Math.max(firstFixed, 1e-6)).toFixed(1)}×`);

  // 프레임간 속도 점프(= 가속). 목표가 바뀐 프레임 직전은 정지(속도 0)이므로 그 0 도 수열에
  // 포함해야 진짜 불연속이 보인다. 임계감쇠 스프링은 Δω² 로 유계이고, 1차 지연은 그 프레임에
  // Δ/τ/dt 를 낸다(dt→0 에서 발산).
  const jumps = (samples) => {
    let max = 0;
    const steps = [0, ...samples.map((s) => s.step)];
    for (let i = 1; i < steps.length; i++) {
      max = Math.max(max, Math.abs(steps[i] - steps[i - 1]) / (1 / 60));
    }
    return max / (1 / 60);   // px/s^2
  };
  const jumpFixed = jumps(fix.samples);
  const jumpLegacy = jumps(old.samples);
  const analytic = delta * 7 * 7;   // Δω², SHIFT_OMEGA = 7
  check('수정본: 최대 가속이 스프링 해석 상한 안', jumpFixed <= analytic * 1.6,
    `${jumpFixed.toFixed(0)} ≤ ${(analytic * 1.6).toFixed(0)} px/s^2`);
  check('종전: 최대 가속이 그 상한을 크게 넘는다', jumpLegacy > analytic * 2.5,
    `${jumpLegacy.toFixed(0)} px/s^2`);

  // 정착: 두 경로 모두 같은 시간대에 목표에 도달해야 한다(연출 길이 회귀 금지).
  const settleFrame = (samples, runtime) => {
    for (let i = 0; i < samples.length; i++) {
      if (Math.hypot(runtime.state.tgtX - samples[i].x, runtime.state.tgtY - samples[i].y) < 1) return i;
    }
    return Infinity;
  };
  const sFixed = settleFrame(fix.samples, fix.runtime);
  const sLegacy = settleFrame(old.samples, old.runtime);
  check('수정본: 1.4초 안에 1px 이내 정착', sFixed <= 84, `${sFixed}프레임`);
  check('정착 지연이 종전의 2.2배 이내', sFixed <= Math.max(30, sLegacy * 2.2),
    `fixed ${sFixed} / legacy ${sLegacy}`);
  // 단조성: 임계감쇠라 오버슛이 없어야 한다(오버슛은 되돌아오는 두 번째 움직임 = 두 번 튄다).
  let overshoot = 0;
  for (const s of fix.samples) {
    overshoot = Math.max(overshoot, Math.max(0, Math.abs(s.y) - Math.abs(fix.runtime.state.tgtY)));
  }
  check('수정본: 오버슛 없음(≤ 0.5px)', overshoot <= 0.5, `${fixed2(overshoot)}px`);
}

console.log('\n② 구도 밴드 계단 변화(크롬 등장)에서도 적용 시프트가 연속');
{
  const container = installDom({ ...VIEWPORT, overlays: [] });
  globalThis.window = { __camFlowLegacy: false };
  const camera = new THREE.PerspectiveCamera(16, VIEWPORT.width / VIEWPORT.height, 0.1, 5000);
  const runtime = createViewShift({ container, camera, isBusy: () => false });
  runtime.setCompositionY(-0.2);            // focus 구도(하늘 확보) 정착값
  for (let i = 0; i < 30; i++) runtime.update(1 / 60);
  const before = camera.view?.enabled ? camera.view.offsetY : 0;
  // 세로로 크롬이 크게 들어와 가용 밴드가 줄어드는 프레임(폰 편집 시트).
  const tall = makeElement({ left: 0, right: VIEWPORT.width, top: 380, bottom: VIEWPORT.height });
  globalThis.document.querySelectorAll = () => [tall];
  runtime.state.lastSample = -1e9;
  let maxStep = 0;
  let previousOffset = before;
  for (let i = 0; i < 90; i++) {
    runtime.update(1 / 60);
    const offset = camera.view?.enabled ? camera.view.offsetY : 0;
    maxStep = Math.max(maxStep, Math.abs(offset - previousOffset));
    previousOffset = offset;
  }
  const total = Math.abs(previousOffset - before);
  check('밴드 변화가 실제로 렌즈 시프트를 바꿨다(> 4px)', total > 4, `${fixed2(total)}px`);
  check('밴드 변화의 단일 프레임 이동 ≤ 총 변화의 12%', maxStep <= Math.max(0.6, total * 0.12),
    `${fixed2(maxStep)}px / ${fixed2(total)}px`);
}

console.log('\n③④ 줌 범위 핸드오프: 전환 중 클램프 해제 + 정착 이징 + 부감 단위 재동기');
{
  const makeRig = (radius) => {
    const container = installDom({ ...VIEWPORT, overlays: [] });
    const camera = new THREE.PerspectiveCamera(
      VILLAGE_LENS.aerial.fov, VIEWPORT.width / VIEWPORT.height, 0.1, 8000,
    );
    camera.userData.villageReferenceFov = VILLAGE_LENS.aerial.referenceFov;
    const controls = {
      target: new THREE.Vector3(),
      enableZoom: true,
      minDistance: 0,
      maxDistance: Infinity,
      update: () => {},
    };
    const village = {
      active: true,
      selected: null,
      transitioning: false,
      wave: null,
      handle: { plan: { site: { R: radius / 0.56, bowlR: radius } } },
      __outerR: null,
      aerialReferenceDist: 0,
      aerialDist: 0,
    };
    const runtime = createVillageCameraRuntime({
      camera, container, controls, scene: { fog: null }, village,
    });
    return { camera, controls, village, runtime };
  };
  // 저작된 부감 포즈로 세운다.
  const placeAerial = ({ camera, controls, runtime }) => {
    const frame = runtime.aerial();
    camera.position.copy(frame.pos);
    controls.target.copy(frame.target);
    camera.updateProjectionMatrix();
    return camera.position.distanceTo(controls.target);
  };

  for (const legacy of [false, true]) {
    globalThis.window = { __camFlowLegacy: legacy };
    const label = legacy ? '종전' : '수정본';
    const rig = makeRig(200);
    const distance = placeAerial(rig);
    rig.runtime.setRegime('explore');
    const settledMax = rig.controls.maxDistance;
    check(`${label}: 저작 부감이 정착 범위 안`, distance <= settledMax + 1e-6,
      `dist ${fixed2(distance)} ≤ max ${fixed2(settledMax)}`);

    // 규모 커밋: 새 마을이 더 크므로 리프레임 트윈이 옛 max 를 넘어 바깥으로 나간다.
    rig.runtime.setRegime('lock');
    if (legacy) {
      check('종전: lock 이 옛 클램프를 그대로 남긴다', rig.controls.maxDistance === settledMax,
        `max ${fixed2(rig.controls.maxDistance)}`);
    } else {
      check('수정본: lock 이 거리 클램프를 놓는다', rig.controls.maxDistance === Infinity
        && rig.controls.minDistance <= 0.1, `min ${rig.controls.minDistance} max ${rig.controls.maxDistance}`);
    }
    // 리프레임 트윈이 새 규모(반경 1.6배) 부감으로 카메라를 밀어낸다 — 아직 웨이브 중(lock)이다.
    rig.village.handle.plan.site = { R: 320 / 0.56, bowlR: 320 };
    rig.village.__outerR = null;
    const grownDistance = placeAerial(rig);
    check(`${label}: 새 규모 부감이 옛 클램프 밖이다(재현 조건)`, grownDistance > settledMax + 1e-3,
      `dist ${fixed2(grownDistance)} vs 옛 max ${fixed2(settledMax)}`);
    // 실측 결함이 발생한 지점: 트윈 종료 프레임의 OrbitControls 핸드오프(settleControls → update(0)).
    //   이 시점의 클램프가 종점을 자르면 한 프레임에 그만큼 줌인된다.
    const truncatedAtHandoff = grownDistance > rig.controls.maxDistance + 1e-3;
    if (legacy) {
      check('종전: 트윈 종료 핸드오프에서 종점이 잘린다(= 급줌인)', truncatedAtHandoff,
        `max ${fixed2(rig.controls.maxDistance)} < dist ${fixed2(grownDistance)} `
        + `→ 한 프레임 ${fixed2(grownDistance - rig.controls.maxDistance)}m`);
    } else {
      check('수정본: 트윈 종료 핸드오프에서 종점이 잘리지 않는다', !truncatedAtHandoff,
        `max ${rig.controls.maxDistance} ≥ dist ${fixed2(grownDistance)}`);
    }
    // 웨이브 완료 → 정착. 두 경로 모두 새 단위로 범위를 세워야 하고, 포즈는 잘리지 않아야 한다.
    rig.runtime.setRegime('explore');
    const expected = dollyDistanceForFov(
      villageZoomReferenceBounds('explore',
        villageAerialReferenceDistance(320 * 1.12, VIEWPORT.width / VIEWPORT.height)).max,
      VILLAGE_LENS.aerial.referenceFov, VILLAGE_LENS.aerial.fov,
    );
    check(`${label}: 정착 범위가 새 마을 반경에서 유도된다`,
      Math.abs(rig.controls.maxDistance - expected) < 1,
      `max ${fixed2(rig.controls.maxDistance)} vs 기대 ${fixed2(expected)}`);
    check(`${label}: 정착 프레임에 포즈가 잘리지 않는다`,
      grownDistance <= rig.controls.maxDistance + 1e-3,
      `max ${fixed2(rig.controls.maxDistance)} ≥ dist ${fixed2(grownDistance)}`);
  }

  // 리롤로 반경이 **줄어든** 경우: 정착 범위가 현재 포즈를 자르므로 이징으로 들어와야 한다.
  globalThis.window = { __camFlowLegacy: false };
  const rig = makeRig(200);
  const distance = placeAerial(rig);
  rig.runtime.setRegime('explore');
  rig.runtime.setRegime('lock');
  rig.village.handle.plan.site = { R: 160 / 0.56, bowlR: 160 };   // 새 시드가 20% 작다
  rig.village.__outerR = null;
  rig.runtime.setRegime('explore');
  const easeStart = rig.controls.maxDistance;
  check('축소 리롤: 정착 직후 클램프가 현재 포즈를 자르지 않는다', easeStart >= distance - 1e-3,
    `max ${fixed2(easeStart)} ≥ dist ${fixed2(distance)}`);
  check('축소 리롤: 이징이 걸려 있다', rig.runtime.debugContinuum().boundsEasing === true);
  let previousMax = easeStart;
  let maxStep = 0;
  let steps = 0;
  while (rig.runtime.updateZoomBounds(1 / 60) && steps < 300) {
    maxStep = Math.max(maxStep, Math.abs(rig.controls.maxDistance - previousMax));
    previousMax = rig.controls.maxDistance;
    steps++;
  }
  const finalMax = rig.controls.maxDistance;
  const total = Math.abs(easeStart - finalMax);
  check('축소 리롤: 0.75초 안에 목표 범위로 수렴', steps <= 46 && steps >= 30, `${steps}프레임`);
  check('축소 리롤: 단일 프레임 범위 이동 ≤ 총량의 8%', maxStep <= total * 0.08,
    `${fixed2(maxStep)} / ${fixed2(total)}`);
  const expectedFinal = dollyDistanceForFov(
    villageZoomReferenceBounds('explore',
      villageAerialReferenceDistance(160 * 1.12, VIEWPORT.width / VIEWPORT.height)).max,
    VILLAGE_LENS.aerial.referenceFov, VILLAGE_LENS.aerial.fov,
  );
  check('축소 리롤: 최종 범위가 새 반경 값과 일치', Math.abs(finalMax - expectedFinal) < 1,
    `${fixed2(finalMax)} vs ${fixed2(expectedFinal)}`);

  // ④ 종전 대조: 리롤은 aerial() 을 부르지 않으므로(재프레이밍 생략) 정착 범위가 **옛 마을**
  //    단위에 머문다 — 줌 한계가 실제 마을 크기와 어긋난 채 남는다.
  globalThis.window = { __camFlowLegacy: true };
  const stale = makeRig(200);
  placeAerial(stale);
  stale.runtime.setRegime('explore');
  const staleMax = stale.controls.maxDistance;
  stale.runtime.setRegime('lock');
  stale.village.handle.plan.site = { R: 160 / 0.56, bowlR: 160 };
  stale.village.__outerR = null;
  stale.runtime.setRegime('explore');
  check('종전: 축소 리롤 뒤 줌 범위가 옛 마을 단위에 머문다',
    Math.abs(stale.controls.maxDistance - staleMax) < 1e-6
      && Math.abs(stale.controls.maxDistance - expectedFinal) > 1,
    `max ${fixed2(stale.controls.maxDistance)} (옛 ${fixed2(staleMax)} / 새 기대 ${fixed2(expectedFinal)})`);
}

console.log(`\n=== camera continuity: ${checks - failures}/${checks} PASS ===`);
process.exit(failures === 0 ? 0 : 1);
