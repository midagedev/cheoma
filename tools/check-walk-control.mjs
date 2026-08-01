// 1인칭 수동 조작 계약(#33) — 순수 node, 렌더 없음.
//
// 워킹뷰는 자동 산책 데모에서 **사용자가 키로 돌아다니는 탐험 모드**로 바뀌었다. 그 전환은 화면이
// 아니라 입력→상태 사상(寫像)에서 판정된다: 명령을 준 만큼 움직이고, 놓으면 멈추고, 드래그한 만큼만
// 돌아보고, 담을 뚫지 않는다. 전부 카메라 없이 dt 스텝으로 단언할 수 있다.
//
// 계약 (F = 변경 전 소스(HEAD)에서 실제로 FAIL 함을 확인한 단언 — 2026-08-01 FAIL-first 확인:
//   M2·M3·M5·M7·R1 이 HEAD 에서 실패, M1·M8 은 HEAD 에서도 통과한다):
//   M1    진입 기본이 정지다. 생성 직후 autoStroll 이 꺼져 있고, 무입력으로 5초를 돌려도 위치 변화 0.
//         코어 단독은 종전에도 auto=false 로 시작했으므로 실제 회귀(런타임이 startAutoStroll() 을
//         걸어 스스로 걷던 것)를 잡는 것은 아래 R1 이다. 여기는 코어 쪽 재발 방지용.
//   M2  F 전진 명령 t초의 이동 거리가 램프를 포함한 해석해와 일치한다(±1mm). 걷기·달리기 양쪽.
//         (종전에는 램프가 없어 첫 프레임부터 최고속 — 해석해가 다르다.)
//   M3  F 정지 명령 후 완전 정지까지의 시간 상한(≤0.10s)과, 그 뒤 위치 변화 0.
//         (지수 감쇠였다면 속도가 정확히 0 이 되지 않아 이 등식이 성립하지 않는다.)
//   M4    대각 입력이 최고속을 넘지 않는다(정규화).
//   M5  F 시선 감도: look(dxPx,dyPx) 가 정확히 dx·LOOK_YAW_PER_PX / dy·LOOK_PITCH_PER_PX 만큼 돌린다.
//   M6  F 피치 클램프 |pitch| ≤ PITCH_LIMIT, 그리고 시선 벡터가 항상 유한 단위벡터.
//   M7  F 시선 델타는 한 프레임에 **1회 소비**된다. 같은 델타가 다음 프레임에 재적용되면 드래그 한 번이
//         무한 회전이 된다(런타임이 update(dt, state.input) 로 매 프레임 넘기던 결함의 회귀 게이트).
//   M8    회전이 이동 방향에 즉시 반영된다(월드 속도 관성 이월 = 빙판 금지). 관성이 아예 없던 HEAD
//         에서는 자명하게 통과한다 — 이번에 들어온 속도 상태가 나중에 월드 속도로 바뀌지 않게 막는
//         전방 보호막이다.
//   M9    경사 지형 추종: 정상 보행 중 눈높이 오차가 상한 이내이고 지면 아래로 내려가지 않는다.
//   M10 F 실제 마을 plan 위 장기 주행 불변식: 매 프레임 충돌 0, 경계 이탈 0, 프레임 이동량이 최고속을
//         넘지 않는다(터널링 0).
//   M11   자동 산책은 삭제되지 않았고 명시 호출로만 켜진다(데모 경로 회귀 방지).
//   M12   하위 호환: update(dt, {fwd,strafe,run,yaw,pitch}) 가 setInput+lookRadians 와 동일 결과.
//   R1  F 런타임 배선: cine.start('walk') 직후 walker 가 자동 산책이 아니고 무입력으로 정지해 있으며,
//         input({lookDX}) 한 번이 정확히 한 번만 회전에 반영된다(카메라·컨트롤은 스텁).
//
// 실행: node tools/check-walk-control.mjs

import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planVillage } from '../src/api/village-plan.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const requireApp = createRequire(join(ROOT, 'app', 'package.json'));
const esbuild = requireApp('esbuild');
const THREE_MAIN = join(ROOT, 'app/node_modules/three/build/three.module.js');
const THREE_ADDONS = join(ROOT, 'app/node_modules/three/examples/jsm');

const DT = 1 / 60;
const DEG = Math.PI / 180;
const WALK = 1.4, RUN = 2.8;

const invariant = (condition, message) => {
  if (!condition) throw new Error(message);
};

async function bundle(contents, sourcefile) {
  const built = await esbuild.build({
    stdin: { contents, resolveDir: ROOT, sourcefile },
    alias: { 'three/addons': THREE_ADDONS, three: THREE_MAIN },
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    write: false,
    logLevel: 'silent',
  });
  const url = `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString('base64')}`;
  return import(url);
}

const M = await bundle(
  "export * from './src/api/cinematic.js';\nexport { createCinematicRuntime } from './app/src/engine/cinematic-runtime.js';\nexport * as THREE from 'three';\n",
  'walk-control-entry.js',
);
const {
  createWalker, createCinematicRuntime, THREE,
  LOOK_PITCH_PER_PX, LOOK_YAW_PER_PX, MOVE_ACCEL, MOVE_DECEL, PITCH_LIMIT,
} = M;

// ── 평지 합성 픽스처: 이동 해석해를 장애물 간섭 없이 본다 ──
const flatSite = {
  R: 400, bowlR: 320, center: { x: 0, z: 0 }, entrance: { x: 0, z: 60 },
  heightAt: () => 0,
};
const flatPlan = {
  site: flatSite,
  parcels: [],
  features: {},
  roads: [{ level: 'soro', pts: [{ x: 0, z: 120 }, { x: 0, z: -120 }] }],
};
const flatWalker = () => createWalker({ site: flatSite, plan: flatPlan, heightAt: flatSite.heightAt });

// ── M1 진입 기본은 정지 ──
{
  const w = flatWalker();
  invariant(w.autoStroll === false, 'M1: walker starts in auto-stroll (manual must be the default)');
  const x0 = w.pos.x, z0 = w.pos.z;
  for (let i = 0; i < 300; i++) w.update(DT);
  const moved = Math.hypot(w.pos.x - x0, w.pos.z - z0);
  invariant(moved === 0, `M1: walker drifted ${moved.toFixed(4)}m with no input (must stand still)`);
  invariant(w.speed() === 0, `M1: idle speed ${w.speed()} ≠ 0`);
}

// ── M2 전진 거리 = 램프 해석해 ──
// 연속해: 정지에서 top 까지 선형 가속(도달시간 top/ACCEL, 거리 top²/(2·ACCEL)) 후 등속.
// 적분기는 프레임마다 속도를 먼저 갱신하고 그 속도로 한 스텝 나아가는 전진 오일러다. 램프 구간의
// 이산 합은 A·dt²·n(n+1)/2 (n = top/(A·dt)) 이고, 이는 연속해보다 정확히 **top·dt/2** 만큼 크다.
// 그 항을 기대값에 넣으면 허용오차를 늘리지 않고 등식으로 단언할 수 있다(A·dt 로 n 이 정수인 값들).
const rampDistance = (top, t) => {
  const tAccel = top / MOVE_ACCEL;
  const discrete = top * DT / 2;
  if (t <= tAccel) return 0.5 * MOVE_ACCEL * t * t + discrete;
  return top * top / (2 * MOVE_ACCEL) + top * (t - tAccel) + discrete;
};
const m2 = [];
for (const [label, run, top] of [['walk', false, WALK], ['run', true, RUN]]) {
  const w = flatWalker();
  w.yaw = 0;                       // dir = +z
  const z0 = w.pos.z;
  const frames = 120;              // 2.0s
  w.setInput({ fwd: 1, strafe: 0, run });
  for (let i = 0; i < frames; i++) w.update(DT);
  const travelled = w.pos.z - z0;
  const expected = rampDistance(top, frames * DT);
  const err = Math.abs(travelled - expected);
  m2.push({ label, travelled: +travelled.toFixed(4), expected: +expected.toFixed(4), err: +err.toFixed(5) });
  invariant(err < 0.001,
    `M2 ${label}: 2s 전진 ${travelled.toFixed(4)}m ≠ 해석해 ${expected.toFixed(4)}m (오차 ${err.toFixed(5)}m)`);
}

// ── M3 정지 시간 상한 ──
// 감속은 DECEL(20m/s²) 선형이므로 정지 시간 = top/DECEL + 이산화 한 프레임 이내.
//   걷기 1.4m/s → 0.070s(이산 0.083s), 달리기 2.8m/s → 0.140s(이산 0.150s).
const m3 = (() => {
  const stopFrom = (run) => {
    const w = flatWalker();
    w.yaw = 0;
    w.setInput({ fwd: 1, run });
    for (let i = 0; i < 120; i++) w.update(DT);
    const top = run ? RUN : WALK;
    invariant(Math.abs(w.speed() - top) < 1e-9, `M3: top speed ${w.speed()} ≠ ${top}`);
    w.setInput({ fwd: 0, strafe: 0, run: false });
    let frames = 0;
    while (w.speed() > 0 && frames < 60) { w.update(DT); frames++; }
    invariant(w.speed() === 0, `M3: 감속 후 속도 ${w.speed()} ≠ 0 (완전 정지하지 않음)`);
    const x0 = w.pos.x, z0 = w.pos.z;
    for (let i = 0; i < 180; i++) w.update(DT);
    invariant(Math.hypot(w.pos.x - x0, w.pos.z - z0) === 0, 'M3: 정지 후에도 위치가 변한다');
    return frames * DT;
  };
  const walkStop = stopFrom(false), runStop = stopFrom(true);
  invariant(walkStop <= 0.10 + 1e-9, `M3: 걷기 정지까지 ${walkStop.toFixed(3)}s > 0.100s 상한`);
  invariant(runStop <= 0.16 + 1e-9, `M3: 달리기 정지까지 ${runStop.toFixed(3)}s > 0.160s 상한`);
  return { walkStop: +walkStop.toFixed(4), runStop: +runStop.toFixed(4), decel: MOVE_DECEL };
})();

// ── M4 대각 정규화 ──
{
  const w = flatWalker();
  w.setInput({ fwd: 1, strafe: 1, run: false });
  for (let i = 0; i < 120; i++) w.update(DT);
  invariant(w.speed() <= WALK + 1e-9, `M4: 대각 속력 ${w.speed().toFixed(4)} > ${WALK}`);
  invariant(w.speed() > WALK - 1e-6, `M4: 대각 속력 ${w.speed().toFixed(4)} 가 최고속에 못 미친다`);
}

// ── M5 시선 감도 ── / ── M6 피치 클램프 ── / ── M7 1회 소비 ──
const m5 = (() => {
  const w = flatWalker();
  w.yaw = 0; w.pitch = 0;
  w.look(100, 0);
  w.update(DT);
  const dYaw = w.yaw;
  invariant(Math.abs(dYaw - (-100 * LOOK_YAW_PER_PX)) < 1e-12,
    `M5: yaw ${dYaw} ≠ ${-100 * LOOK_YAW_PER_PX} (100px 드래그)`);
  // M7 — 같은 델타가 다음 프레임에 재적용되면 안 된다.
  w.update(DT); w.update(DT);
  invariant(w.yaw === dYaw, `M7: 시선 델타가 반복 적용됐다 (${dYaw} → ${w.yaw})`);

  const w2 = flatWalker();
  w2.pitch = 0;
  w2.look(0, 100);
  w2.update(DT);
  invariant(Math.abs(w2.pitch - (-100 * LOOK_PITCH_PER_PX)) < 1e-12,
    `M5: pitch ${w2.pitch} ≠ ${-100 * LOOK_PITCH_PER_PX}`);

  // M6 — 위·아래로 크게 끌어도 클램프 안에 머물고 시선이 유한 단위벡터다.
  for (const sign of [-1, 1]) {
    const w3 = flatWalker();
    for (let i = 0; i < 60; i++) { w3.look(0, sign * 500); w3.update(DT); }
    invariant(Math.abs(w3.pitch) <= PITCH_LIMIT + 1e-12,
      `M6: pitch ${(w3.pitch / DEG).toFixed(2)}° 가 클램프 ±${(PITCH_LIMIT / DEG).toFixed(2)}° 를 넘었다`);
    invariant(Math.abs(Math.abs(w3.pitch) - PITCH_LIMIT) < 1e-9,
      `M6: 클램프에 붙지 않았다 (${(w3.pitch / DEG).toFixed(2)}°)`);
    const d = w3.dir;
    invariant([d.x, d.y, d.z].every(Number.isFinite) && Math.abs(d.length() - 1) < 1e-6,
      'M6: 시선 벡터가 유한 단위벡터가 아니다');
  }
  return { yawPerPx: LOOK_YAW_PER_PX, pitchPerPx: LOOK_PITCH_PER_PX, pitchLimitDeg: +(PITCH_LIMIT / DEG).toFixed(2) };
})();

// ── M8 회전 즉시 반영(관성 이월 없음) ──
{
  const w = flatWalker();
  w.yaw = 0;
  w.setInput({ fwd: 1 });
  for (let i = 0; i < 120; i++) w.update(DT);      // +z 로 최고속
  w.yaw = Math.PI / 2;                             // +x 로 즉시 회전
  const x0 = w.pos.x, z0 = w.pos.z;
  w.update(DT);
  const dx = w.pos.x - x0, dz = w.pos.z - z0;
  invariant(Math.abs(dz) < 1e-9, `M8: 회전 후에도 옛 방향으로 ${dz.toFixed(5)}m 미끄러진다`);
  invariant(dx > 0, 'M8: 회전 후 새 방향으로 진행하지 않는다');
}

// ── M9 경사 지형 추종 ──
const m9 = (() => {
  const slope = 0.15;                              // 8.5° 비탈
  const site = { ...flatSite, heightAt: (x, z) => z * slope };
  const plan = { ...flatPlan, site };
  const w = createWalker({ site, plan, heightAt: site.heightAt });
  w.yaw = 0; w.setInput({ fwd: 1 });
  let worst = 0, minClear = Infinity;
  for (let i = 0; i < 600; i++) {
    w.update(DT);
    if (i < 30) continue;                          // 초기 램프·스무딩 수렴 구간 제외
    worst = Math.max(worst, Math.abs(w.groundClearance() - w.eyeHeight));
    minClear = Math.min(minClear, w.groundClearance());
  }
  invariant(worst < 0.05, `M9: 눈높이 오차 ${worst.toFixed(4)}m > 0.05m`);
  invariant(minClear > 0.1 - 1e-9, `M9: 지면 침하 (여유 ${minClear.toFixed(3)}m)`);
  return { eyeErr: +worst.toFixed(4), minClearance: +minClear.toFixed(3) };
})();

// ── M10 실제 마을 plan 위 장기 주행 불변식 ──
const m10 = (() => {
  const plan = planVillage({ scale: 'village', seed: 20260716, includePalace: false, includeTemple: false });
  const site = plan.site;
  const w = createWalker({ site, plan, heightAt: (x, z) => site.heightAt(x, z) });
  // 결정론 시퀀스(LCG) — 무작위 조작을 재현 가능하게 흉내낸다.
  let s = 123456789 >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  let collisions = 0, outside = 0, maxStep = 0;
  const capStep = RUN * DT * 1.0001 + 1e-9;
  let px = w.pos.x, pz = w.pos.z;
  for (let i = 0; i < 7200; i++) {                 // 120s
    if (i % 30 === 0) {
      w.setInput({
        fwd: [1, 1, 1, 0, -1][Math.floor(rnd() * 5)],
        strafe: [0, 0, 1, -1][Math.floor(rnd() * 4)],
        run: rnd() < 0.3,
      });
      w.look((rnd() - 0.5) * 220, (rnd() - 0.5) * 60);
    }
    w.update(DT);
    if (w.isColliding()) collisions++;
    if (w.outsideBoundary()) outside++;
    maxStep = Math.max(maxStep, Math.hypot(w.pos.x - px, w.pos.z - pz));
    px = w.pos.x; pz = w.pos.z;
  }
  invariant(collisions === 0, `M10: 담·건물 관통 ${collisions} 프레임`);
  invariant(outside === 0, `M10: 분지 경계 이탈 ${outside} 프레임`);
  invariant(maxStep <= capStep,
    `M10: 프레임 이동 ${maxStep.toFixed(5)}m > 상한 ${capStep.toFixed(5)}m (터널링)`);
  return { frames: 7200, collisions, outside, maxStep: +maxStep.toFixed(5) };
})();

// ── M11 자동 산책은 명시 호출로만 ──
{
  const w = flatWalker();
  w.startAutoStroll();
  invariant(w.autoStroll === true, 'M11: startAutoStroll() 가 무시됐다');
  const x0 = w.pos.x, z0 = w.pos.z;
  for (let i = 0; i < 300; i++) w.update(DT);
  invariant(Math.hypot(w.pos.x - x0, w.pos.z - z0) > 1,
    'M11: 자동 산책이 더 이상 스스로 걷지 않는다(데모 경로 회귀)');
  w.stopAutoStroll();
  invariant(w.autoStroll === false && w.speed() === 0, 'M11: stopAutoStroll 후 정지 상태가 아니다');
}

// ── M12 하위 호환 (update(dt, input) 경로) ──
{
  const a = flatWalker(); a.yaw = 0;
  const b = flatWalker(); b.yaw = 0;
  for (let i = 0; i < 90; i++) {
    a.update(DT, { fwd: 1, strafe: 0, run: false, yaw: i === 0 ? 0.2 : 0, pitch: i === 0 ? -0.1 : 0 });
    if (i === 0) { b.setInput({ fwd: 1, strafe: 0, run: false }); b.lookRadians(0.2, -0.1); }
    b.update(DT);
  }
  invariant(Math.abs(a.pos.x - b.pos.x) < 1e-12 && Math.abs(a.pos.z - b.pos.z) < 1e-12
    && Math.abs(a.yaw - b.yaw) < 1e-12 && Math.abs(a.pitch - b.pitch) < 1e-12,
    'M12: update(dt,input) 하위 호환 경로가 setInput/lookRadians 와 다른 결과를 낸다');
}

// ── R1 런타임 배선 (카메라·컨트롤 스텁, GL 없음) ──
const r1 = (() => {
  const plan = planVillage({ scale: 'village', seed: 20260716, includePalace: false, includeTemple: false });
  const camera = new THREE.PerspectiveCamera(35, 16 / 9, 0.1, 2000);
  camera.position.set(0, 40, 120);
  const controls = { enabled: true, target: new THREE.Vector3() };
  const village = {
    active: true, handle: { plan }, wave: false, heroAsm: false,
    transitioning: false, selected: null, seed: 7,
  };
  const noop = () => {};
  const runtime = createCinematicRuntime({
    camera,
    controls,
    village,
    cancelTween: noop,
    focusOutDuration: 0.6,
    clearHover: noop,
    emit: noop,
    getAerial: () => ({ pos: camera.position.clone(), target: new THREE.Vector3(), fov: 35, referenceFov: 35 }),
    getSunAzimuth: () => 0,
    markActivity: noop,
    reapplyVillageFog: noop,
    returnFromFocus: noop,
    setPostFocus: noop,
    setZoomRegime: noop,
    settleControls: noop,
    stopHeroDrive: noop,
    tweenTo: noop,
  });
  invariant(runtime.start('walk') === true, 'R1: cine.start("walk") 실패');
  const dbg0 = runtime.debugWalker();
  invariant(dbg0.autoStroll === false, 'R1: 진입 직후 자동 산책이 켜져 있다 (기본은 수동)');

  // 무입력 정지
  const p0 = { ...dbg0.pos };
  for (let i = 0; i < 180; i++) runtime.update(DT);
  const p1 = runtime.debugWalker().pos;
  invariant(Math.hypot(p1.x - p0.x, p1.z - p0.z) === 0,
    `R1: 무입력인데 (${p0.x},${p0.z}) → (${p1.x},${p1.z}) 로 움직였다`);

  // 시선 델타는 한 번만 반영된다(런타임이 매 프레임 재적용하지 않는다).
  const yaw0 = runtime.debugWalker().yawDeg;
  runtime.input({ lookDX: 100, lookDY: 0 });
  runtime.update(DT);
  const yaw1 = runtime.debugWalker().yawDeg;
  const expected = +(-100 * LOOK_YAW_PER_PX / DEG).toFixed(2);
  invariant(Math.abs((yaw1 - yaw0) - expected) < 0.02,
    `R1: 드래그 100px 회전 ${(yaw1 - yaw0).toFixed(2)}° ≠ ${expected}°`);
  for (let i = 0; i < 60; i++) runtime.update(DT);
  invariant(runtime.debugWalker().yawDeg === yaw1,
    `R1: 시선 델타가 이후 프레임에도 계속 적용된다 (${yaw1}° → ${runtime.debugWalker().yawDeg}°)`);

  // 이동 명령 → 전진, 놓으면 정지.
  runtime.input({ fwd: 1, strafe: 0, run: false });
  const q0 = runtime.debugWalker().pos;
  for (let i = 0; i < 120; i++) runtime.update(DT);
  const q1 = runtime.debugWalker().pos;
  const advanced = Math.hypot(q1.x - q0.x, q1.z - q0.z);
  invariant(advanced > 1.5, `R1: 전진 명령 2s 이동 ${advanced.toFixed(2)}m — 너무 짧다`);
  runtime.input({ fwd: 0, strafe: 0, run: false });
  for (let i = 0; i < 12; i++) runtime.update(DT);
  const q2 = runtime.debugWalker().pos;
  for (let i = 0; i < 60; i++) runtime.update(DT);
  const q3 = runtime.debugWalker().pos;
  invariant(q2.x === q3.x && q2.z === q3.z,
    'R1: 이동 명령을 놓았는데 계속 나아간다 (지속 상태가 0 으로 갱신되지 않음)');
  runtime.dispose();
  return { advanced2s: +advanced.toFixed(2), yawPer100px: +(yaw1 - yaw0).toFixed(2) };
})();

console.log('walk-control contract: PASS', JSON.stringify({
  accel: MOVE_ACCEL, decel: MOVE_DECEL, ...m5,
  forward2s: m2, ...m3, ...m9, ...m10, runtime: r1,
}));
