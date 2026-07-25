// 애니메이션 클록 계약 — authored 연출 길이가 프레임레이트와 무관하게 벽시계로 지켜지는지.
//
// 이 게이트가 존재하는 이유: 종전 정책은 렌더 루프 안의 `Math.min(elapsed, 0.05)` 한 줄이었고
// 그것은 스파이크 가드가 아니라 20fps 천장이었다. 프레임이 0.05초를 넘는 순간부터 히어로 arrival,
// 조립, 트윈, 웨이브, 먹안개가 모두 (0.05 / 프레임 시간) 배로 느려졌다 — 폰 에뮬레이션에서 8.1초
// 안무가 벽시계 8초에 progress 0.0147 까지만 갔고, 사용자에게는 "카메라가 회전하지 않는다"로 보였다.
// 기존 22개 게이트가 하나도 잡지 못한 이유는 안무 게이트가 전부 `debugArchitecturalRevealSeek`로
// 결정론 샘플만 검사해 벽시계를 우회하기 때문이다. 그 빈 축만 여기서 담당한다.
import { createFrameClock, FRAME_SPIKE_CLAMP } from '../app/src/engine/frame-clock.js';

const failures = [];
const check = (pass, message) => {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${message}`);
  if (!pass) failures.push(message);
};

// 고정 프레임 시간으로 authored 길이만큼 진행시키고, 소비된 애니메이션 시간과 벽시계를 비교한다.
function playAtFixedFrameRate(frameSeconds, authoredSeconds, stepFn) {
  let animated = 0, wall = 0, frames = 0;
  while (animated < authoredSeconds && wall < authoredSeconds * 40) {
    animated += stepFn(frameSeconds);
    wall += frameSeconds;
    frames++;
  }
  return { animated, wall, frames, completed: animated >= authoredSeconds };
}
const withClock = () => { const clock = createFrameClock(); return (raw) => clock.step(raw); };
const legacyClamp = () => (raw) => Math.min(raw, 0.05);   // 종전 정책

const HERO = 8.1;   // 히어로 arrival 총 길이(engine HERO_ASSEMBLE_DELAY_MS + HERO_ASSEMBLE_DUR)

// 1) 상한(0.25초) 이내의 모든 프레임레이트에서 authored 길이가 벽시계로 정확히 지켜진다.
//    4fps == 0.25초 프레임이 경계이며, 실기기 범위(10fps 이상)는 전부 이 안에 있다.
for (const [label, frame] of [
  ['120fps', 1 / 120], ['60fps', 1 / 60], ['30fps', 1 / 30], ['20fps', 1 / 20],
  ['15fps', 1 / 15], ['10fps', 0.1], ['5fps', 0.2], ['4fps', 0.25],
]) {
  const run = playAtFixedFrameRate(frame, HERO, withClock());
  check(run.completed && Math.abs(run.wall - HERO) <= frame,
    `${label}: 8.1초 안무가 벽시계 ${run.wall.toFixed(2)}초에 완주 (${run.frames} 프레임, 오차 ≤ 1프레임)`);
}

// 2) 같은 케이스가 종전 정책에서는 실패한다 — 이 게이트가 무엇을 지키는지 회귀 시 바로 읽히게
//    반례를 같은 자리에 고정한다. 20fps 까지는 종전도 정상이었고 그 아래에서만 늘어졌다.
for (const [label, frame, minStretch] of [['10fps', 0.1, 1.9], ['5fps', 0.2, 3.9]]) {
  const run = playAtFixedFrameRate(frame, HERO, legacyClamp());
  check(run.wall >= HERO * minStretch,
    `반례(종전 20fps 천장) ${label}: 같은 안무가 벽시계 ${run.wall.toFixed(1)}초로 늘어진다 `
    + `(${(run.wall / HERO).toFixed(1)}배)`);
}

// 3) 4fps 미만은 여전히 늘어지지만 배율이 (프레임 시간 / 상한)으로 유계다. 헤드리스 소프트웨어 GL
//    만 들어가는 구간이므로 정확한 완주가 아니라 "유계"를 계약으로 잡는다.
for (const [label, frame] of [['2fps', 0.5], ['1fps', 1.0], ['0.25fps', 4.0]]) {
  const run = playAtFixedFrameRate(frame, HERO, withClock());
  const bound = HERO * (frame / FRAME_SPIKE_CLAMP);
  check(run.completed && run.wall <= bound + frame,
    `${label}: 늘어짐이 유계 — 벽시계 ${run.wall.toFixed(1)}초 ≤ 상한 ${bound.toFixed(1)}초 `
    + `(${(run.wall / HERO).toFixed(1)}배)`);
}

// 4) 20fps 이상에서는 종전 정책과 **완전히 동일**해야 한다(정상 주행 무변의 증거).
for (const [label, frame] of [['120fps', 1 / 120], ['60fps', 1 / 60], ['30fps', 1 / 30], ['20fps', 1 / 20]]) {
  const now = playAtFixedFrameRate(frame, HERO, withClock());
  const legacy = playAtFixedFrameRate(frame, HERO, legacyClamp());
  check(now.frames === legacy.frames && Math.abs(now.wall - legacy.wall) < 1e-9,
    `${label}: 종전 정책과 프레임 단위로 동일 (${now.frames} 프레임)`);
}

// 5) 단발 스톨은 상한에서 흡수된다(텔레포트 금지). 60fps 정상 주행 뒤 10초 블로킹.
{
  const clock = createFrameClock();
  for (let i = 0; i < 120; i++) clock.step(1 / 60);
  const spike = clock.step(10);
  check(spike === FRAME_SPIKE_CLAMP,
    `60fps 주행 중 10초 스톨은 ${spike}초로 흡수된다(텔레포트 방지)`);
  check(clock.step(10) === FRAME_SPIKE_CLAMP, '연속 스톨도 계속 흡수된다(상태 누적 없음)');
  check(Math.abs(clock.step(1 / 60) - 1 / 60) < 1e-12,
    '스톨 직후 정상 프레임은 즉시 raw 로 복귀한다(가드가 뒤끝을 남기지 않음)');
}

// 6) 비정상 입력 방어 — NaN·음수·0 은 0 으로 접힌다(시간이 거꾸로 가지 않게).
{
  const clock = createFrameClock();
  check([NaN, -1, 0, undefined].every((value) => clock.step(value) === 0),
    'NaN·음수·0 델타는 0 으로 접힌다');
}

console.log(failures.length
  ? `\nFRAME CLOCK: FAIL (${failures.length})`
  : `\nFRAME CLOCK: PASS (벽시계 완주, ${FRAME_SPIKE_CLAMP}초 스파이크 흡수, 20fps 이상 종전과 동일)`);
if (failures.length) process.exitCode = 1;
