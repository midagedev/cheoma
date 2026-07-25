// 애니메이션 클록 계약 — authored 연출 길이가 프레임레이트와 무관하게 벽시계로 지켜지는지.
//
// 이 게이트가 존재하는 이유: 종전 정책은 렌더 루프 안의 `Math.min(elapsed, 0.05)` 한 줄이었고
// 그것은 스파이크 가드가 아니라 20fps 천장이었다. 프레임이 0.05초를 넘는 순간부터 히어로 arrival,
// 조립, 트윈, 웨이브, 먹안개가 모두 (0.05 / 프레임 시간) 배로 느려졌다 — 폰 에뮬레이션에서 8.1초
// 안무가 벽시계 8초에 progress 0.0147 까지만 갔고, 사용자에게는 "카메라가 회전하지 않는다"로
// 보였다. 22개 게이트가 하나도 이것을 잡지 못했으므로 정책을 순수 모듈로 떼어 여기서 고정한다.
import {
  createFrameClock,
  FRAME_SPIKE_FLOOR,
  FRAME_SPIKE_FACTOR,
} from '../app/src/engine/frame-clock.js';

const failures = [];
const check = (pass, message) => {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${message}`);
  if (!pass) failures.push(message);
};

// 고정 프레임 시간으로 authored 길이만큼 진행시키고, 소비된 애니메이션 시간과 벽시계를 비교한다.
function playAtFixedFrameRate(frameSeconds, authoredSeconds) {
  const clock = createFrameClock();
  let animated = 0, wall = 0, frames = 0;
  // 벽시계로 authored 길이의 4배까지 돌려 본다. 정상이면 1배 근방에서 완주한다.
  while (animated < authoredSeconds && wall < authoredSeconds * 4) {
    animated += clock.step(frameSeconds);
    wall += frameSeconds;
    frames++;
  }
  return { animated, wall, frames, completed: animated >= authoredSeconds, debug: clock.debug() };
}

const HERO = 8.1;   // 히어로 arrival 총 길이(engine HERO_ASSEMBLE_DELAY_MS + HERO_ASSEMBLE_DUR)

// 1) 정상 프레임레이트는 종전과 동일해야 한다(회귀 없음).
for (const [fps, frame] of [[120, 1 / 120], [60, 1 / 60], [30, 1 / 30]]) {
  const run = playAtFixedFrameRate(frame, HERO);
  check(run.completed && Math.abs(run.wall - HERO) < HERO * 0.05,
    `${fps}fps: 8.1초 안무가 벽시계 ${run.wall.toFixed(2)}초에 완주 (${run.frames} 프레임)`);
}

// 2) 저fps 에서도 벽시계로 완주해야 한다 — 이것이 회귀의 본체다. 20fps(=종전 천장) 아래를 촘촘히
//    본다. 추정치 램프에 두세 프레임이 들어가므로 허용 오차는 프레임 몇 개 분량으로 둔다.
for (const [label, frame] of [
  ['20fps', 1 / 20], ['15fps', 1 / 15], ['10fps', 0.1], ['5fps', 0.2], ['2fps', 0.5], ['1fps', 1.0],
]) {
  const run = playAtFixedFrameRate(frame, HERO);
  const slack = Math.max(HERO * 0.08, frame * 4);
  check(run.completed && run.wall <= HERO + slack,
    `${label}: 8.1초 안무가 벽시계 ${run.wall.toFixed(2)}초에 완주 (허용 ${(HERO + slack).toFixed(2)}초, ${run.frames} 프레임)`);
}

// 3) 종전 정책이라면 위 저fps 케이스가 실패한다는 것을 같은 자리에서 보여 둔다 — 이 게이트가
//    무엇을 지키는지 회귀 시 바로 읽히게 하려고 반례를 함께 고정한다.
{
  const frame = 0.2;                       // 5fps
  let animated = 0, wall = 0;
  while (animated < HERO && wall < HERO * 20) {
    animated += Math.min(frame, 0.05);     // 종전 정책
    wall += frame;
  }
  check(wall > HERO * 3,
    `반례: 종전 20fps 천장이면 5fps 에서 같은 안무가 벽시계 ${wall.toFixed(1)}초로 늘어진다`);
}

// 4) 단발 스파이크는 여전히 잘려야 한다(텔레포트 금지). 60fps 정상 주행 뒤 10초 스톨.
{
  const clock = createFrameClock();
  for (let i = 0; i < 120; i++) clock.step(1 / 60);
  const spike = clock.step(10);
  check(spike < 0.2 && spike <= FRAME_SPIKE_FLOOR * FRAME_SPIKE_FACTOR,
    `60fps 주행 중 10초 스톨은 ${spike.toFixed(4)}초로 잘린다(텔레포트 방지)`);
  // 스파이크 하나가 천장을 밀어올려 다음 스파이크를 통과시키면 안 된다.
  const second = clock.step(10);
  check(second < 1.0,
    `연속 스톨도 계속 잘린다(두 번째 ${second.toFixed(4)}초 — 추정치를 클램프된 값으로 갱신)`);
}

// 5) 60fps 에서의 천장은 종전 값(0.05)을 하한으로 포함한다 — 정상 주행 동작 불변의 증거.
{
  const clock = createFrameClock();
  for (let i = 0; i < 60; i++) clock.step(1 / 60);
  const d = clock.debug();
  check(d.ceiling >= FRAME_SPIKE_FLOOR && Math.abs(d.ratio - 1) < 1e-9,
    `60fps 정상 주행은 클램프에 걸리지 않는다(ratio ${d.ratio.toFixed(6)}, 천장 ${d.ceiling.toFixed(4)}초)`);
}

// 6) 저fps 진입 시 추적까지 걸리는 프레임 수 — 램프가 길면 짧은 연출이 앞부분을 잃는다.
{
  const clock = createFrameClock();
  for (let i = 0; i < 60; i++) clock.step(1 / 60);   // 60fps 정상 주행 뒤
  let frames = 0;
  while (frames < 20) {
    frames++;
    if (Math.abs(clock.step(0.2) - 0.2) < 1e-9) break;   // 5fps 로 급락
  }
  check(frames <= 4, `5fps 급락 후 ${frames} 프레임 안에 벽시계 추적에 든다`);
}

console.log(failures.length
  ? `\nFRAME CLOCK: FAIL (${failures.length})`
  : '\nFRAME CLOCK: PASS (벽시계 완주, 스파이크 클램프, 정상 주행 불변)');
if (failures.length) process.exitCode = 1;
