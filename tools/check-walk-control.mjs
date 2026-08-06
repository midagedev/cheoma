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
// ── #43 FPS 문법 (2026-08-02 사용자 지시: "도보 뷰에서 WASD에 좌우가 반전되어 있고, 스페이스 점프,
//    그리고 기본 이동속도를 기존보다 한참 더 빠르게 할 것. 이건 좀 더 FPS 문법을 따르면 좋겠네.")
//    귀속: 아래 M2·M3 의 속도·램프 재핀과 M13~M15·R2 신규 단언은 그 지시가 근거다. 파생 근거는
//    walker.js 상수 주석의 FPS 레퍼런스(Source/HL2/Quake III)와 한옥 수직 어휘(기단 0.5m / 조적 담
//    최저 1.44m). FAIL-first 는 2026-08-02 확인: 변경 전 walker.js 로 되돌리면 M2·M3·M13·M14·M15·R2
//    가 실패하고(부호·속도·점프 전 항목), 나머지는 그대로 통과한다.
//   M13 F 횡이동 부호 = FPS 표준. strafe +1(=D) 이 시선 기준 오른쪽 cross(forward, worldUp) 과
//         **정확히** 같은 방향이다. 변경 전 소스는 cross(worldUp, forward)= 왼쪽이라 dot = −1 로 실패.
//   M14 F 점프 포물선: 정점 높이가 저작값과 등가속 정확적분으로 일치하고(±1mm), 체공 시간이 2v₀/g
//         한 프레임 이내이며, 착지 후 눈높이가 지형 클램프로 복귀한다. 기단(0.5m)은 넘고 조적 담
//         최저(1.44m)는 못 넘는다. 이단 점프 없음(체공 중 재입력이 정점을 바꾸지 못한다).
//   M15 F 체공 관성: 무입력 체공은 세계 수평 속도를 유지하고(공중 제동 금지), 공중에서 뒤돌아봐도
//         포물선의 진행 방향이 시선을 따라가지 않는다. 방향 전환은 AIR_CONTROL 감쇠를 따른다.
//   M10+  점프를 섞은 장기 주행에서도 충돌 0·경계 이탈 0·터널링 0(점프 중 벽 관통 금지).
//   R2  F 런타임 배선: input({jump:true}) 가 walker 를 실제로 띄우고(눈높이 여유 > 눈높이),
//         input({strafe:1}) 이 오른쪽으로 보낸다.
//
// ── #44 포인터 락 (2026-08-03) ── 데스크톱 walk 의 시선이 드래그 전용이라 FPS 로 읽히지 않았다.
//    락 상태의 mousemove(movementX/Y)와 기존 드래그(clientX/Y 차분)는 **같은** look(dxPx,dyPx) 로
//    들어가므로, 두 규약의 부호 관계가 배선의 유일한 실질 결정이다. 그 관계는 추론이 아니라 측정으로
//    정했고(R3a), 코어 상수 LOOK_POINTER_LOCK_SIGN 하나가 들고 있다. FAIL-first 는 2026-08-03 확인:
//    walker.js 의 그 상수를 −1 로 뒤집으면 R3a·R3b 가 실패하고 나머지 전 항목은 그대로 통과한다.
//   R3a F 락 규약이 FPS 방향이다. movementX>0 을 LOOK_POINTER_LOCK_SIGN 으로 변환해 런타임
//         input({lookDX}) 에 넣으면 시선이 M13 이 확정한 오른쪽 축(cross(forward,worldUp)) 쪽으로
//         돈다. 세로는 movementY>0 → 아래를 본다(논인버트).
//   R3b F 부호 관계가 측정치와 일치한다. 코어 look(+px) 이 실제로 도는 방향을 재서 필요한 계수를
//         유도하고, 상수가 그 값인지 대조한다(상수를 상수로 검증하지 않는다). 실측 결론: 드래그
//         규약은 이미 시선 규약이라 락과 부호가 같다 = 계수 +1.
//   R3c   배선 계약(App.svelte 텍스트): movementX/Y 에 매직 부호가 없고 상수만 곱한다, 락 리스너의
//         add/remove 가 짝을 이룬다, ESC 가 락 해제로 먼저 소비된다(walk 종료 오인 금지), 락 경로가
//         (pointer: fine) 뒤에 갇혀 터치에서 실행되지 않는다.
//
// 실행: node tools/check-walk-control.mjs

import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
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
// 저작값을 게이트가 직접 들고 있다(모듈에서 import 하면 값이 바뀌어도 자기 자신과 일치해 통과한다).
// 아래 M0 이 이 상수와 walker 의 export 가 같은지 대조한다.
const WALK = 4.5, RUN = 7.5;
const JUMP_H = 1.05, GRAVITY = 20;
const PODIUM_TOP = 0.5;         // hanok.js podiumH 기본 — 기단 상면
const MASONRY_WALL_MIN = 1.7 * 0.88 * 0.96;   // wall-contract 조적 담 최저 실효 높이 = 1.436m

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
  "export * from './src/api/cinematic.js';\n"
  + "export { AIR_CONTROL, JUMP_GRAVITY, JUMP_HEIGHT, JUMP_SPEED, RUN_SPEED, WALK_SPEED,"
  + " FLY_CEILING, FLY_DOUBLE_TAP_SEC, FLY_SOLID_CLEARANCE, FLY_SPEED, FLY_VERTICAL_SPEED"
  + " } from './src/cinematic/walker.js';\n"
  + "export { LAND_MIN_MPS, STRIDE_RUN, STRIDE_WALK } from './src/audio/footsteps.js';\n"
  + "export { createCinematicRuntime } from './app/src/engine/cinematic-runtime.js';\nexport * as THREE from 'three';\n",
  'walk-control-entry.js',
);
const {
  buildWalkSolids, createWalker, createCinematicRuntime, THREE,
  LOOK_PITCH_PER_PX, LOOK_POINTER_LOCK_SIGN, LOOK_YAW_PER_PX, MOVE_ACCEL, MOVE_DECEL, PITCH_LIMIT,
  AIR_CONTROL, JUMP_GRAVITY, JUMP_HEIGHT, JUMP_SPEED, RUN_SPEED, WALK_SPEED,
  FLY_CEILING, FLY_DOUBLE_TAP_SEC, FLY_SOLID_CLEARANCE, FLY_SPEED, FLY_VERTICAL_SPEED,
  LAND_MIN_MPS, STRIDE_RUN, STRIDE_WALK,
} = M;

// ── M0 저작값 핀 ── 게이트 상수 = 코어 export. 속도·점프 재저작은 이 줄까지 같이 고쳐야 한다.
invariant(WALK_SPEED === WALK && RUN_SPEED === RUN,
  `M0: 이동 속도 저작값 불일치 — walker ${WALK_SPEED}/${RUN_SPEED} vs 게이트 ${WALK}/${RUN}`);
invariant(JUMP_HEIGHT === JUMP_H && JUMP_GRAVITY === GRAVITY,
  `M0: 점프 저작값 불일치 — walker ${JUMP_HEIGHT}m/${JUMP_GRAVITY} vs 게이트 ${JUMP_H}m/${GRAVITY}`);
invariant(Math.abs(JUMP_SPEED - Math.sqrt(2 * GRAVITY * JUMP_H)) < 1e-12,
  `M0: 도약 초속 ${JUMP_SPEED} ≠ √(2gh) ${Math.sqrt(2 * GRAVITY * JUMP_H)}`);
// 걷기는 종전 1.4m/s 의 3배 이상이어야 한다(사용자 지시 "한참 더 빠르게").
invariant(WALK_SPEED >= 1.4 * 3, `M0: 걷기 ${WALK_SPEED}m/s 가 종전 1.4m/s 의 3배에 못 미친다`);
// 점프는 기단 위·조적 담 아래.
invariant(JUMP_HEIGHT > PODIUM_TOP + 0.3,
  `M0: 점프 ${JUMP_HEIGHT}m 가 기단 ${PODIUM_TOP}m 를 여유 있게 넘지 못한다`);
invariant(JUMP_HEIGHT < MASONRY_WALL_MIN - 0.2,
  `M0: 점프 ${JUMP_HEIGHT}m 가 조적 담 최저 ${MASONRY_WALL_MIN.toFixed(3)}m 에 너무 가깝다`);

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
// 감속은 DECEL(75m/s²) 선형이므로 정지 시간 = top/DECEL + 이산화 한 프레임 이내.
//   걷기 4.5m/s → 0.060s(이산 0.067s), 달리기 7.5m/s → 0.100s(이산 0.117s). #43 에서 최고속이
//   3배가 됐어도 정지 시간은 0.1s대에 묶어 둔다 — 늘어지면 FPS 즉답성이 죽는다.
const m3 = (() => {
  const stopFrom = (run) => {
    const w = flatWalker();
    w.yaw = 0;
    w.setInput({ fwd: 1, run });
    for (let i = 0; i < 120; i++) w.update(DT);
    const top = run ? RUN : WALK;
    invariant(Math.abs(w.speed() - top) < 1e-9, `M3: top speed ${w.speed()} ≠ ${top}`);
    const zRelease = w.pos.z;
    w.setInput({ fwd: 0, strafe: 0, run: false });
    let frames = 0;
    while (w.speed() > 0 && frames < 60) { w.update(DT); frames++; }
    invariant(w.speed() === 0, `M3: 감속 후 속도 ${w.speed()} ≠ 0 (완전 정지하지 않음)`);
    const x0 = w.pos.x, z0 = w.pos.z;
    for (let i = 0; i < 180; i++) w.update(DT);
    invariant(Math.hypot(w.pos.x - x0, w.pos.z - z0) === 0, 'M3: 정지 후에도 위치가 변한다');
    return { t: frames * DT, dist: Math.abs(z0 - zRelease) };
  };
  const walk = stopFrom(false), run = stopFrom(true);
  const walkStop = walk.t, runStop = run.t;
  invariant(walkStop <= 0.08 + 1e-9, `M3: 걷기 정지까지 ${walkStop.toFixed(3)}s > 0.080s 상한`);
  invariant(runStop <= 0.13 + 1e-9, `M3: 달리기 정지까지 ${runStop.toFixed(3)}s > 0.130s 상한`);
  return {
    walkStop: +walkStop.toFixed(4), runStop: +runStop.toFixed(4),
    walkStopDist: +walk.dist.toFixed(4), runStopDist: +run.dist.toFixed(4),
    decel: MOVE_DECEL,
  };
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
  let collisions = 0, outside = 0, maxStep = 0, airFrames = 0;
  const capStep = RUN * DT * 1.0001 + 1e-9;
  let px = w.pos.x, pz = w.pos.z;
  for (let i = 0; i < 7200; i++) {                 // 120s
    if (i % 30 === 0) {
      w.setInput({
        fwd: [1, 1, 1, 0, -1][Math.floor(rnd() * 5)],
        strafe: [0, 0, 1, -1][Math.floor(rnd() * 4)],
        run: rnd() < 0.3,
        // #43: 점프를 섞는다. 체공 중 수평은 월드 속도라 접지와 다른 코드 경로다 — 그 경로에서도
        //   담 관통·터널링이 0 이어야 한다(높이 없는 2D solid 라 점프가 면제를 주지 않는다).
        jump: rnd() < 0.25,
      });
      w.look((rnd() - 0.5) * 220, (rnd() - 0.5) * 60);
    }
    w.update(DT);
    if (!w.grounded()) airFrames++;
    if (w.isColliding()) collisions++;
    if (w.outsideBoundary()) outside++;
    maxStep = Math.max(maxStep, Math.hypot(w.pos.x - px, w.pos.z - pz));
    px = w.pos.x; pz = w.pos.z;
  }
  invariant(collisions === 0, `M10: 담·건물 관통 ${collisions} 프레임`);
  invariant(outside === 0, `M10: 분지 경계 이탈 ${outside} 프레임`);
  invariant(maxStep <= capStep,
    `M10: 프레임 이동 ${maxStep.toFixed(5)}m > 상한 ${capStep.toFixed(5)}m (터널링)`);
  invariant(airFrames > 600, `M10: 체공 프레임 ${airFrames} — 점프 경로가 실질적으로 실행되지 않았다`);
  return {
    frames: 7200, collisions, outside, maxStep: +maxStep.toFixed(5), airFrames,
  };
})();

// ── M10b 담을 향해 달리며 점프해도 관통하지 않는다 ──
// 실제 마을 담 solid 하나를 골라 법선 바깥에서 정면으로 돌진 + 점프. 충돌 프레임 0 이고, 담
//   반대편으로 넘어가지 않는다(부호 반전 0). 무작위 주행이 우연히 놓칠 수 있는 결정론 픽스처다.
const m10b = (() => {
  const plan = planVillage({ scale: 'village', seed: 20260716, includePalace: false, includeTemple: false });
  const site = plan.site;
  const solids = buildWalkSolids(plan, (x, z) => site.heightAt(x, z));
  const wall = solids.find((s) => s.kind === 'wall' && s.hd > 0.1);
  invariant(!!wall, 'M10b: 담 solid 를 찾지 못했다(픽스처 무효)');
  // OBB 로컬 +z(두께 축)의 월드 방향 — pointHitsWalkSolid 의 lz = dx·sin + dz·cos 와 같은 축.
  const nx = wall.sin, nz = wall.cos;
  const standoff = wall.hd + 0.45 + 1.4;
  const w = createWalker({ site, plan, heightAt: (x, z) => site.heightAt(x, z) });
  w.setPos(wall.cx + nx * standoff, wall.cz + nz * standoff);
  invariant(!w.isColliding(), 'M10b: 시작 지점이 이미 solid 안이다(픽스처 무효)');
  const side0 = Math.sign((w.pos.x - wall.cx) * nx + (w.pos.z - wall.cz) * nz);
  w.yaw = Math.atan2(-nx, -nz);                    // 담을 정면으로
  w.setInput({ fwd: 1, strafe: 0, run: true, jump: true });
  let collisions = 0, crossed = 0, air = 0, closest = Infinity;
  for (let i = 0; i < 360; i++) {                  // 6s
    w.update(DT);
    if (!w.grounded()) air++;
    if (w.isColliding()) collisions++;
    const proj = (w.pos.x - wall.cx) * nx + (w.pos.z - wall.cz) * nz;
    if (Math.sign(proj) !== side0) crossed++;
    closest = Math.min(closest, Math.abs(proj));
  }
  invariant(collisions === 0, `M10b: 점프 돌진 중 담 관통 ${collisions} 프레임`);
  invariant(crossed === 0, `M10b: 점프로 담 반대편으로 ${crossed} 프레임 넘어갔다`);
  invariant(air > 0, 'M10b: 점프가 발동하지 않았다(픽스처 무효)');
  invariant(closest >= wall.hd, `M10b: 담 중심선까지 ${closest.toFixed(3)}m < 반두께 ${wall.hd.toFixed(3)}m`);
  return {
    airFrames: air, collisions, crossed,
    closest: +closest.toFixed(3), wallHalf: +wall.hd.toFixed(3),
  };
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

// ── M13 횡이동 부호(FPS 표준) ──
// forward = (sin yaw, 0, cos yaw), worldUp = +Y 인 오른손 좌표계에서 오른쪽은 cross(forward, up)
//   = (−cos yaw, 0, sin yaw) 다. strafe +1(=D 키)이 정확히 그 방향이어야 한다. 변경 전 소스는
//   cross(up, forward)= 반대 벡터를 써서 아래 dot 이 −1 이 된다(A/D 반전의 근원).
const m13 = (() => {
  const rows = [];
  for (const yaw of [0, Math.PI / 2, -Math.PI / 3, 2.4]) {
    const w = flatWalker();
    w.yaw = yaw;
    const x0 = w.pos.x, z0 = w.pos.z;
    w.setInput({ fwd: 0, strafe: 1 });
    for (let i = 0; i < 60; i++) w.update(DT);
    const mx = w.pos.x - x0, mz = w.pos.z - z0;
    const ml = Math.hypot(mx, mz);
    invariant(ml > 0.1, `M13: strafe 입력에 이동이 없다 (yaw ${(yaw / DEG).toFixed(1)}°)`);
    const dot = (mx / ml) * (-Math.cos(yaw)) + (mz / ml) * Math.sin(yaw);
    invariant(dot > 1 - 1e-9,
      `M13: yaw ${(yaw / DEG).toFixed(1)}° 에서 strafe +1(D) 이 오른쪽이 아니다 (dot ${dot.toFixed(6)}${dot < -0.9 ? ' — 좌우 반전' : ''})`);
    rows.push({ yawDeg: +(yaw / DEG).toFixed(1), dot: +dot.toFixed(6) });
  }
  // A(=strafe −1)는 정확히 반대여야 한다(부호 이중 반전·비대칭 금지).
  const a = flatWalker(); a.yaw = 0.7;
  const b = flatWalker(); b.yaw = 0.7;
  const ax0 = a.pos.x, az0 = a.pos.z, bx0 = b.pos.x, bz0 = b.pos.z;
  a.setInput({ strafe: 1 }); b.setInput({ strafe: -1 });
  for (let i = 0; i < 60; i++) { a.update(DT); b.update(DT); }
  invariant(Math.abs((a.pos.x - ax0) + (b.pos.x - bx0)) < 1e-9
    && Math.abs((a.pos.z - az0) + (b.pos.z - bz0)) < 1e-9,
    'M13: A 와 D 가 정확히 반대 방향이 아니다');
  return rows;
})();

// ── M14 점프 포물선 ──
// 등가속 정확적분이므로 샘플이 연속해 위에 놓인다: 정점 = JUMP_HEIGHT (프레임 이산화로 최대
//   g·dt²/8 = 0.7mm 미달), 체공 = 2v₀/g 의 한 프레임 이내. 착지 후 눈높이는 지형 클램프로 복귀.
const m14 = (() => {
  const w = flatWalker();
  const base = w.pos.y;                            // 평지 = ground + EYE
  invariant(w.grounded(), 'M14: 생성 직후가 접지 상태가 아니다');
  w.setInput({ jump: true });
  let peak = 0, frames = 0;
  w.update(DT);
  invariant(!w.grounded(), 'M14: 점프 입력 후에도 접지 상태다(도약하지 않음)');
  while (!w.grounded() && frames < 600) {
    peak = Math.max(peak, w.pos.y - base);
    // 체공 중 재입력은 무시되어야 한다(이단 점프 금지) — 매 프레임 jump 를 계속 눌러 둔다.
    w.update(DT);
    frames++;
  }
  const airTime = (frames + 1) * DT;
  const analytic = 2 * JUMP_SPEED / GRAVITY;
  invariant(Math.abs(peak - JUMP_H) < 0.001,
    `M14: 정점 ${peak.toFixed(4)}m ≠ 저작값 ${JUMP_H}m (오차 ${Math.abs(peak - JUMP_H).toFixed(5)}m)`);
  invariant(airTime >= analytic - DT && airTime <= analytic + 2 * DT,
    `M14: 체공 ${airTime.toFixed(4)}s ∉ [${(analytic - DT).toFixed(4)}, ${(analytic + 2 * DT).toFixed(4)}]s (해석해 ${analytic.toFixed(4)}s)`);
  invariant(Math.abs(w.pos.y - base) < 1e-9,
    `M14: 착지 후 눈높이 ${w.pos.y.toFixed(4)} ≠ 지형 클램프 ${base.toFixed(4)}`);
  // 저작 의도: 기단은 넘고 조적 담은 못 넘는다.
  invariant(peak > PODIUM_TOP, `M14: 정점 ${peak.toFixed(3)}m 가 기단 ${PODIUM_TOP}m 를 못 넘는다`);
  invariant(peak < MASONRY_WALL_MIN,
    `M14: 정점 ${peak.toFixed(3)}m 가 조적 담 최저 ${MASONRY_WALL_MIN.toFixed(3)}m 를 넘는다`);
  // 이단 점프 금지 — 체공 중 최고점을 지난 뒤 다시 눌러도 정점이 갱신되지 않는다.
  const w2 = flatWalker();
  const base2 = w2.pos.y;
  w2.setInput({ jump: true });
  for (let i = 0; i < 30; i++) w2.update(DT);
  const midY = w2.pos.y;
  w2.setInput({ jump: false }); w2.update(DT); w2.setInput({ jump: true });
  let peak2 = 0, guard = 0;
  while (!w2.grounded() && guard++ < 600) { peak2 = Math.max(peak2, w2.pos.y - base2); w2.update(DT); }
  invariant(peak2 < JUMP_H + 1e-9,
    `M14: 체공 중 재입력이 이단 점프를 만들었다 (정점 ${peak2.toFixed(3)}m > ${JUMP_H}m, 중간고 ${(midY - base2).toFixed(3)}m)`);
  return {
    peak: +peak.toFixed(4), authored: JUMP_H,
    airTime: +airTime.toFixed(4), analyticAirTime: +analytic.toFixed(4),
    v0: +JUMP_SPEED.toFixed(4),
  };
})();

// ── M15 체공 관성 ──
// (a) 무입력 체공은 세계 수평 속도를 유지한다(공중 제동 금지).
// (b) 공중에서 뒤돌아봐도 포물선의 진행 방향이 시선을 따라가지 않는다. 접지 속도는 로컬 축이라
//     회전이 즉시 반영되지만(M8), 체공에서 같은 규칙을 쓰면 도약이 시선을 따라 휘어 물성이 죽는다.
const m15 = (() => {
  const w = flatWalker();
  w.yaw = 0;
  w.setInput({ fwd: 1, run: false });
  for (let i = 0; i < 120; i++) w.update(DT);      // +z 최고속
  const vTakeoff = w.speed();
  w.setInput({ fwd: 0, strafe: 0, jump: true });
  w.update(DT);
  w.setInput({ jump: false });                     // 이후 무입력 체공
  const zA = w.pos.z;
  for (let i = 0; i < 12; i++) w.update(DT);
  const drift = (w.pos.z - zA) / (12 * DT);
  invariant(Math.abs(drift - vTakeoff) < 1e-6,
    `M15: 무입력 체공 수평속도 ${drift.toFixed(4)} ≠ 이륙 속도 ${vTakeoff.toFixed(4)} (공중 제동)`);
  // 시선을 180° 돌려도 진행 방향 유지.
  w.yaw = Math.PI;
  const zB = w.pos.z;
  for (let i = 0; i < 6; i++) w.update(DT);
  invariant(w.pos.z - zB > 0,
    `M15: 공중에서 뒤돌아보자 진행 방향이 뒤집혔다 (Δz ${(w.pos.z - zB).toFixed(5)})`);
  // 방향 전환은 AIR_CONTROL 감쇠를 따른다 — 같은 시간 지상 가속의 30%.
  const w2 = flatWalker();
  w2.yaw = 0;
  w2.setInput({ jump: true });
  w2.update(DT);
  w2.setInput({ jump: false, fwd: 1 });
  const n = 6;
  for (let i = 0; i < n; i++) w2.update(DT);
  const gained = w2.speed();
  const expected = MOVE_ACCEL * AIR_CONTROL * n * DT;
  invariant(Math.abs(gained - expected) < 1e-6,
    `M15: 체공 가속 ${gained.toFixed(4)}m/s ≠ MOVE_ACCEL·AIR_CONTROL·t ${expected.toFixed(4)}m/s`);
  return {
    airControl: AIR_CONTROL,
    driftKept: +drift.toFixed(4),
    airAccel: +(MOVE_ACCEL * AIR_CONTROL).toFixed(2),
  };
})();

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

  // ── R2 #43 배선 ── Space(jump) 와 D(strafe +1) 가 engine.cine.input 채널을 그대로 통과한다.
  //   App.svelte 는 이 채널에 { jump: walkKeys.has(' ') } 와 { strafe: D?1:0 − A?1:0 } 을 민다.
  const eye = runtime.debugWalker().eyeHeight;
  runtime.input({ fwd: 0, strafe: 0, run: false, jump: true });
  runtime.update(DT);
  let airborneFrames = 0, peakClearance = 0;
  for (let i = 0; i < 60; i++) {
    const d = runtime.debugWalker();
    if (d.clearance > eye + 1e-3) { airborneFrames++; peakClearance = Math.max(peakClearance, d.clearance); }
    runtime.update(DT);
  }
  invariant(airborneFrames > 20,
    `R2: input({jump:true}) 로 뜨지 않았다 (체공 프레임 ${airborneFrames})`);
  invariant(peakClearance - eye > JUMP_H * 0.9,
    `R2: 런타임 경유 점프 최고 여유 ${(peakClearance - eye).toFixed(3)}m < 저작 ${JUMP_H}m 의 90%`);
  runtime.input({ jump: false, fwd: 0, strafe: 0 });
  for (let i = 0; i < 60; i++) runtime.update(DT);   // 착지 대기

  const s0 = runtime.debugWalker();
  const yawRad = s0.yawDeg * DEG;
  runtime.input({ fwd: 0, strafe: 1, run: false });
  for (let i = 0; i < 30; i++) runtime.update(DT);
  const s1 = runtime.debugWalker();
  const sx = s1.pos.x - s0.pos.x, sz = s1.pos.z - s0.pos.z;
  const sl = Math.hypot(sx, sz);
  invariant(sl > 0.1, `R2: strafe 입력에 이동이 없다 (${sl.toFixed(4)}m)`);
  const sdot = (sx / sl) * (-Math.cos(yawRad)) + (sz / sl) * Math.sin(yawRad);
  invariant(sdot > 0.99,
    `R2: 런타임 경유 strafe +1(D) 이 오른쪽이 아니다 (dot ${sdot.toFixed(4)}${sdot < -0.9 ? ' — 좌우 반전' : ''})`);

  runtime.dispose();
  return {
    advanced2s: +advanced.toFixed(2),
    yawPer100px: +(yaw1 - yaw0).toFixed(2),
    jumpAirFrames: airborneFrames,
    jumpPeak: +(peakClearance - eye).toFixed(3),
    strafeRightDot: +sdot.toFixed(4),
  };
})();

// ── R3 포인터 락 규약(#44) ──
// 오른쪽 축은 M13 이 FPS 오른쪽으로 확정한 cross(forward, worldUp) = (−cos yaw, 0, sin yaw) 다.
const rightAxis = (yaw) => ({ x: -Math.cos(yaw), z: Math.sin(yaw) });
const forwardAxis = (yaw) => ({ x: Math.sin(yaw), z: Math.cos(yaw) });

// R3b 부호 유도 — 코어 look() 이 실제로 도는 방향을 재서 필요한 계수를 만든다. 상수를 상수와
//   비교하면 뒤집어도 자기 자신과 일치해 통과하므로, 기준은 반드시 측정치여야 한다.
const r3b = (() => {
  const YAW0 = 0.7;
  const w = flatWalker();
  w.yaw = YAW0; w.pitch = 0;
  w.look(100, 0);                        // 드래그 규약으로 +100px
  w.update(DT);
  const r = rightAxis(YAW0);
  const alongRight = w.dir.x * r.x + w.dir.z * r.z;
  invariant(Math.abs(alongRight) > 1e-3, 'R3b: look(+px) 이 요를 전혀 돌리지 않았다(측정 무효)');
  // look(+px) 이 오른쪽으로 돌면 dragYawSign = +1. FPS 락은 movementX>0 → 오른쪽이어야 하므로
  //   필요한 계수는 S·dragYawSign = +1, 즉 S = dragYawSign 이다(±1 이라 역수 = 자기 자신).
  const dragYawSign = Math.sign(alongRight);
  // 세로도 같은 계수 하나로 맞아야 한다. FPS 논인버트는 마우스 아래(movementY>0) → 아래를 봄
  //   (dir.y < 0). look(0,+px) 의 실측 방향이 dragPitchSign 이면 필요한 계수는 −dragPitchSign.
  const w2 = flatWalker();
  w2.pitch = 0;
  w2.look(0, 100);
  w2.update(DT);
  invariant(Math.abs(w2.dir.y) > 1e-3, 'R3b: look(0,+px) 이 피치를 전혀 돌리지 않았다(측정 무효)');
  const dragPitchSign = Math.sign(w2.dir.y);
  invariant(dragYawSign === -dragPitchSign,
    `R3b: 요(${dragYawSign})와 피치(${dragPitchSign}) 가 계수 하나로 정리되지 않는다 — 두 축이 서로 다른 반전을 요구한다`);
  const derived = dragYawSign;
  invariant(LOOK_POINTER_LOCK_SIGN === derived,
    `R3b: LOOK_POINTER_LOCK_SIGN ${LOOK_POINTER_LOCK_SIGN} ≠ 실측 유도값 ${derived}`
    + ` (look(+px) 이 ${dragYawSign > 0 ? '오른쪽' : '왼쪽'}으로 돈다 → movementX>0 을 FPS 오른쪽으로 보내려면 ${derived})`);
  return { dragYawSign, dragPitchSign, derived, constant: LOOK_POINTER_LOCK_SIGN };
})();

// R3a 락 규약이 런타임 채널을 통과해도 FPS 방향이다. App.svelte 는 락 중 mousemove 에서
//   lookDX = movementX · LOOK_POINTER_LOCK_SIGN 을 이 채널로 민다.
const r3a = (() => {
  const plan = planVillage({ scale: 'village', seed: 20260716, includePalace: false, includeTemple: false });
  const camera = new THREE.PerspectiveCamera(35, 16 / 9, 0.1, 2000);
  camera.position.set(0, 40, 120);
  const noop = () => {};
  const runtime = createCinematicRuntime({
    camera,
    controls: { enabled: true, target: new THREE.Vector3() },
    village: { active: true, handle: { plan }, wave: false, heroAsm: false, transitioning: false, selected: null, seed: 7 },
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
  invariant(runtime.start('walk') === true, 'R3a: cine.start("walk") 실패');

  const MOVEMENT_X = 240;              // 마우스를 오른쪽으로 240px 이동한 락 델타
  const yaw0 = runtime.debugWalker().yawDeg * DEG;
  runtime.input({ lookDX: MOVEMENT_X * LOOK_POINTER_LOCK_SIGN, lookDY: 0 });
  runtime.update(DT);
  const yaw1 = runtime.debugWalker().yawDeg * DEG;
  const r = rightAxis(yaw0), f = forwardAxis(yaw1);
  const turned = f.x * r.x + f.z * r.z;
  invariant(turned > 0,
    `R3a: movementX>0 인데 시선이 오른쪽으로 돌지 않았다 (dir·right ${turned.toFixed(4)}${turned < 0 ? ' — 좌우 반전' : ''})`);
  // 감도는 코어 소유(새 상수 금지) — 락 경유 회전량이 드래그와 정확히 같은 크기여야 한다.
  const expectedRad = MOVEMENT_X * LOOK_YAW_PER_PX;
  invariant(Math.abs(Math.abs(yaw1 - yaw0) - expectedRad) < 0.02 * DEG + 1e-6,
    `R3a: 락 240px 회전 ${Math.abs(yaw1 - yaw0).toFixed(5)}rad ≠ 드래그 감도 해석해 ${expectedRad.toFixed(5)}rad`);

  const MOVEMENT_Y = 180;              // 마우스를 아래로 180px
  const pitch0 = runtime.debugWalker().pitchDeg * DEG;
  runtime.input({ lookDX: 0, lookDY: MOVEMENT_Y * LOOK_POINTER_LOCK_SIGN });
  runtime.update(DT);
  const pitch1 = runtime.debugWalker().pitchDeg * DEG;
  invariant(pitch1 < pitch0,
    `R3a: movementY>0(마우스 아래)인데 시선이 아래를 향하지 않았다 (pitch ${(pitch0 / DEG).toFixed(2)}° → ${(pitch1 / DEG).toFixed(2)}° — 상하 반전)`);
  runtime.dispose();
  return {
    lockYawDeg: +((yaw1 - yaw0) / DEG).toFixed(3),
    lockPitchDeg: +((pitch1 - pitch0) / DEG).toFixed(3),
    rightDot: +turned.toFixed(4),
  };
})();

// R3c 배선 계약 — App.svelte 는 노드에서 import 할 수 없으므로 텍스트로 단언한다. 여기서 잡는 것은
//   "코드가 있는가"가 아니라 이 라운드가 실제로 틀릴 수 있는 지점들이다: 매직 부호, 리스너 누수,
//   ESC 오인, 터치 경로 오염.
const r3c = (() => {
  const src = readFileSync(join(ROOT, 'app/src/App.svelte'), 'utf8');
  const has = (s) => src.includes(s);
  const count = (s) => src.split(s).length - 1;

  // ① 부호는 상수로만 — movementX/Y 에 붙은 매직 반전 부호 금지.
  invariant(has("import { LOOK_POINTER_LOCK_SIGN } from '../../src/api/cinematic.js';"),
    'R3c: App.svelte 가 LOOK_POINTER_LOCK_SIGN 을 src/api 파사드에서 import 하지 않는다');
  invariant(has('walkLookDX += e.movementX * LOOK_POINTER_LOCK_SIGN;')
    && has('walkLookDY += e.movementY * LOOK_POINTER_LOCK_SIGN;'),
    'R3c: 락 델타가 LOOK_POINTER_LOCK_SIGN 을 거치지 않는다');
  invariant(!/[-]\s*e\.movement[XY]/.test(src),
    'R3c: movementX/Y 에 매직 반전 부호가 붙어 있다 (부호는 LOOK_POINTER_LOCK_SIGN 한 곳에서만)');

  // ② 리스너 누수 금지 — walk 종료 시 문서 리스너가 전부 풀리고 락도 정리된다.
  // add 는 removeEventListener 안에 포함되지 않는 문자열이므로(remove‥는 'moveEventListener')
  //   두 카운트는 독립이다. 각각 정확히 1 이어야 짝이 맞는다.
  for (const [label, addSig, removeSig] of [
    ['pointerlockchange', "addEventListener('pointerlockchange'", "removeEventListener('pointerlockchange'"],
    ['pointerlockerror', "addEventListener('pointerlockerror'", "removeEventListener('pointerlockerror'"],
    ['락 mousemove', "addEventListener('mousemove', onWalkLockMove", "removeEventListener('mousemove', onWalkLockMove"],
  ]) {
    const adds = count(addSig), removes = count(removeSig);
    invariant(adds === 1 && removes === 1,
      `R3c: ${label} 리스너 add/remove 가 짝이 아니다 (add ${adds} / remove ${removes})`);
  }
  invariant(has('document.exitPointerLock()'),
    'R3c: walk 종료 경로에 exitPointerLock 정리가 없다');
  // walk → drone 처럼 stop 없이 모드만 바뀌는 전환에서도 락을 반납해야 한다(커서 실종 방지).
  invariant(has("if (cine.mode !== 'walk') { stopWalkFeed(); return; }"),
    'R3c: walk 이 아닌 모드로 전환될 때 락·피드를 반납하지 않는다');

  // ③ ESC 는 락 해제로 **먼저** 소비된다 — 그 뒤에야 기존 walk 종료가 온다.
  const escGuard = src.indexOf('if (walkEscapeReleasedLock()) return;');
  const cineStop = src.indexOf('if (cine.active) { engine.cine.stop(); return; }');
  invariant(escGuard > 0 && cineStop > 0 && escGuard < cineStop,
    'R3c: ESC 락 해제 가드가 engine.cine.stop() 보다 앞서지 않는다 (락 해제가 walk 종료로 오인된다)');

  // ④ 터치 경로 불변 — 락은 (pointer: fine) 판정 뒤에 갇혀 있고, 등록도 그 판정 결과로 게이트한다.
  invariant(/function walkLockEligible\(\)[\s\S]{0,400}matchMedia\('\(pointer: fine\)'\)/.test(src),
    'R3c: 락 적격 판정이 (pointer: fine) 를 보지 않는다');
  invariant(/walkLockable = walkLockEligible\(\);[\s\S]{0,400}if \(walkLockable\) \{[\s\S]{0,200}addEventListener\('mousemove', onWalkLockMove/.test(src),
    'R3c: 락 mousemove 등록이 walkLockable 게이트 안에 있지 않다 (터치 경로 오염)');
  return { guarded: true, escGuardBeforeStop: true };
})();

// ── M16 크리에이티브 비행(2026-08-06 사용자 요청 "하늘도 날 수 있고") ────────────────────────
//   조작 규약(MC 크리에이티브): 점프 **더블탭**으로 토글 · 비행 중 점프=상승 / Shift=하강 · 중력 없음.
//   여기서 단언하는 것은 ① 한 번 탭은 비행을 켜지 않는다(평소 도약) ② 판정 창 안의 두 번째 탭이
//   켠다 ③ 비행 중 중력이 없다(입력 없으면 고도 유지) ④ 상승·하강 속도가 저작값 ⑤ 천장·바닥 클램프
//   ⑥ 다시 더블탭하면 낙하로 인수된다.
const m16 = (() => {
  const w = flatWalker();
  const ground = w.pos.y - w.eyeHeight;
  // ① 단일 탭 — 도약만 하고 비행은 꺼진 채다.
  w.setInput({ jump: true }); w.update(DT);
  w.setInput({ jump: false }); w.update(DT);
  invariant(!w.flying(), 'M16①: 점프 한 번에 비행이 켜졌다 (더블탭 규약 위반)');
  // 착지까지 기다린다(단일 도약).
  for (let i = 0; i < 200 && !w.grounded(); i++) w.update(DT);
  invariant(w.grounded(), 'M16①: 단일 도약이 착지하지 않았다');

  // ② 판정 창 안의 두 번째 탭 — 비행 ON. 탭 사이는 프레임 두 개(0.033s < 0.35s).
  w.setInput({ jump: true }); w.update(DT);
  w.setInput({ jump: false }); w.update(DT);
  w.setInput({ jump: true }); w.update(DT);
  invariant(w.flying(), 'M16②: 판정 창 안의 더블탭이 비행을 켜지 않았다');
  invariant(!w.grounded(), 'M16②: 비행 중인데 grounded() 가 참이다');

  // ③ 무입력 비행 = 고도 유지(중력 없음). 상승 입력을 놓고 속도가 0 으로 램프된 뒤를 본다.
  w.setInput({ jump: false, run: false, fwd: 0, strafe: 0 });
  for (let i = 0; i < 30; i++) w.update(DT);
  const hold0 = w.pos.y;
  for (let i = 0; i < 90; i++) w.update(DT);          // 1.5s 방치
  invariant(Math.abs(w.pos.y - hold0) < 1e-6,
    `M16③: 비행 중 무입력에 고도가 변했다 (${hold0} → ${w.pos.y}) — 중력이 남아 있다`);

  // ④ 상승·하강 속도 — 램프가 끝난 뒤 1초 이동량이 저작값과 같다.
  w.setInput({ jump: true });
  for (let i = 0; i < 30; i++) w.update(DT);          // FLY_ACCEL 램프 소진
  const y0 = w.pos.y;
  for (let i = 0; i < 60; i++) w.update(DT);
  const upMps = (w.pos.y - y0) / (60 * DT);
  invariant(Math.abs(upMps - FLY_VERTICAL_SPEED) < 0.02,
    `M16④: 상승 속도 ${upMps.toFixed(3)} != 저작 ${FLY_VERTICAL_SPEED}`);
  w.setInput({ jump: false, run: true });
  for (let i = 0; i < 30; i++) w.update(DT);
  const y1 = w.pos.y;
  for (let i = 0; i < 60; i++) w.update(DT);
  const downMps = (y1 - w.pos.y) / (60 * DT);
  invariant(Math.abs(downMps - FLY_VERTICAL_SPEED) < 0.02,
    `M16④: 하강 속도 ${downMps.toFixed(3)} != 저작 ${FLY_VERTICAL_SPEED}`);

  // ⑤ 천장·바닥 클램프.
  w.setInput({ jump: true, run: false });
  for (let i = 0; i < 3000; i++) w.update(DT);        // 50s 상승 — 천장에 붙는다
  const ceilY = w.pos.y - ground;
  invariant(Math.abs(ceilY - FLY_CEILING) < 0.05,
    `M16⑤: 상한 고도 ${ceilY.toFixed(2)}m != 저작 ${FLY_CEILING}m`);
  w.setInput({ jump: false, run: true });
  for (let i = 0; i < 3000; i++) w.update(DT);        // 바닥까지 하강
  invariant(Math.abs((w.pos.y - ground) - w.eyeHeight) < 1e-6,
    `M16⑤: 바닥 클램프가 눈높이(${w.eyeHeight}m)가 아니다 (${(w.pos.y - ground).toFixed(3)}m)`);

  // ⑥ 다시 더블탭 = 비행 OFF → 낙하로 인수.
  //   ★ 끄는 순간의 수직 속도는 **물려받는다**(운동량 연속). 그래서 상승 중에 끄면 탄도로 잠시
  //   더 올라간 뒤 떨어진다 — 그것이 의도된 동작이므로, 낙하 판정은 상승을 멈춘 **호버 상태**에서
  //   해야 한다(이 순서를 지키지 않으면 게이트가 정상 동작을 실패로 읽는다).
  w.setInput({ jump: true, run: false });
  for (let i = 0; i < 120; i++) w.update(DT);   // 고도 확보
  w.setInput({ jump: false, run: false });
  for (let i = 0; i < 30; i++) w.update(DT);    // 수직 속도 0 으로 램프(호버)
  const offFrom = w.pos.y;
  w.setInput({ jump: true }); w.update(DT);
  w.setInput({ jump: false }); w.update(DT);
  w.setInput({ jump: true }); w.update(DT);
  invariant(!w.flying(), 'M16⑥: 두 번째 더블탭이 비행을 끄지 않았다');
  w.setInput({ jump: false });
  for (let i = 0; i < 60; i++) w.update(DT);    // 1s — 중력이 탭 잔여 상승을 압도한다
  invariant(w.pos.y < offFrom - 0.2,
    `M16⑥: 비행을 끈 뒤 낙하하지 않는다 (${offFrom.toFixed(2)} → ${w.pos.y.toFixed(2)})`);
  return { ceilingM: +ceilY.toFixed(2), upMps: +upMps.toFixed(3), downMps: +downMps.toFixed(3) };
})();

// ── M17 발소리 케이던스(2026-08-06 사용자 요청 "걷는 효과음도 나고") ─────────────────────────
//   발소리는 시간이 아니라 **보폭 누적**으로 난다. 그래야 케이던스가 속도에서 파생되고 저fps 에서도
//   걸음 수가 어긋나지 않는다. 여기서 단언하는 것은 ① 접지 이동만 적립된다(비행·체공은 0)
//   ② 걷기 케이던스가 사람 보행 밴드(2~3.2 걸음/s) ③ 달리기가 걷기보다 잦다 ④ 착지 충격이
//   한 번만 소비된다.
const m17 = (() => {
  const w = flatWalker();
  w.yaw = 0;
  const cadence = (run) => {
    const ww = flatWalker();
    ww.yaw = 0;
    ww.setInput({ fwd: 1, run });
    for (let i = 0; i < 60; i++) ww.update(DT);       // 최고속 도달
    const d0 = ww.strideDistance();
    for (let i = 0; i < 300; i++) ww.update(DT);      // 5s
    const dist = ww.strideDistance() - d0;
    const stride = run ? STRIDE_RUN : STRIDE_WALK;
    return dist / stride / (300 * DT);               // 걸음/s
  };
  const walkHz = cadence(false);
  const runHz = cadence(true);
  invariant(walkHz > 2.0 && walkHz < 3.2,
    `M17②: 걷기 케이던스 ${walkHz.toFixed(2)} 걸음/s 가 보행 밴드(2.0~3.2)를 벗어났다`);
  invariant(runHz > walkHz + 0.2,
    `M17③: 달리기 케이던스(${runHz.toFixed(2)})가 걷기(${walkHz.toFixed(2)})보다 잦지 않다`);

  // ① 비행 중에는 적립되지 않는다.
  w.setInput({ jump: true }); w.update(DT);
  w.setInput({ jump: false }); w.update(DT);
  w.setInput({ jump: true }); w.update(DT);
  invariant(w.flying(), 'M17①: 비행 진입 실패');
  w.setInput({ fwd: 1, jump: false });
  const flyD0 = w.strideDistance();
  for (let i = 0; i < 180; i++) w.update(DT);
  invariant(w.strideDistance() === flyD0,
    'M17①: 비행 중 보행거리가 적립됐다 — 발이 닿지 않는데 발소리가 난다');

  // ④ 착지 충격은 한 번만 소비된다.
  const j = flatWalker();
  j.setInput({ jump: true }); j.update(DT);
  j.setInput({ jump: false });
  for (let i = 0; i < 200 && !j.grounded(); i++) j.update(DT);
  const impact = j.takeLandImpact();
  invariant(impact > 3 && impact < 8, `M17④: 착지 충격 ${impact.toFixed(2)} m/s 가 도약 밴드를 벗어났다`);
  invariant(j.takeLandImpact() === 0, 'M17④: 착지 충격이 두 번 소비된다 (착지음 중복)');
  return {
    walkHz: +walkHz.toFixed(2), runHz: +runHz.toFixed(2), landMps: +impact.toFixed(2),
  };
})();

console.log('walk-control contract: PASS', JSON.stringify({
  speeds: { walk: WALK_SPEED, run: RUN_SPEED }, accel: MOVE_ACCEL, decel: MOVE_DECEL, ...m5,
  forward2s: m2, ...m3, ...m9, ...m10, wallJump: m10b,
  strafeRight: m13, jump: m14, air: m15, runtime: r1,
  pointerLock: { ...r3b, ...r3a, ...r3c },
  fly: m16, footsteps: m17,
}));
