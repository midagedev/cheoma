// 애니메이션 시간 클록 — 벽시계 델타에 스파이크 클램프만 적용한다.
//
// 이 값 하나가 리빌 카메라·조립·트윈·웨이브·먹안개·입자를 모두 구동하므로, 클램프 정책이
// authored 길이(예: 히어로 arrival 8.1초)가 벽시계로 지켜지는지를 단독으로 결정한다.
//
// 왜 별도 모듈인가: 종전 정책은 engine.js 렌더 루프 안의 `Math.min(elapsed, 0.05)` 한 줄이었고,
// 그것이 스파이크 가드가 아니라 **20fps 천장**이라는 사실을 22개 게이트가 하나도 잡지 못했다.
// 프레임이 0.05초보다 길어지는 순간부터 모든 연출이 (0.05 / 실제 프레임 시간) 배로 느려진다 —
// 실측으로 폰 에뮬레이션에서 8.1초 안무가 벽시계 8초에 progress 0.0147 까지만 진행했다.
// three 의존이 없는 순수 모듈로 떼어 두면 이 정책 자체를 계약으로 고정할 수 있다
// (tools/check-frame-clock.mjs).
//
// 정책: 지속적인 저fps 와 단발 스톨은 구분할 수 있다 — 전자는 프레임 시간이 일정하고, 후자는
// 최근 평균에서 튄다. 그래서 천장을 고정값이 아니라 **최근 프레임 시간 추정치의 배수**로 잡는다.
//   - 저fps: 추정치가 따라 올라가 raw 가 그대로 통과한다(벽시계 충실 → 연출이 제 길이로 완주).
//   - 단발 스톨(탭 복귀·동기 생성 블로킹·셰이더 링크): 추정치의 배수에서 잘려 텔레포트하지 않는다.
// 추정치는 **클램프된 값**으로 갱신한다 — 스파이크가 스스로 천장을 밀어올리지 못하게 하려고.
// 상승은 빠르고 하강은 느린 비대칭이라, 저fps 구간에 들어가면 두세 프레임 안에 추적에 든다.
//
// 감쇠(OrbitControls)는 raw 를 따로 받아 프레임레이트 독립을 유지하므로 이 클램프와 무관하다.

export const FRAME_SPIKE_FLOOR = 0.05;   // 60fps 에서의 천장 하한 — 종전 동작을 그대로 포함한다
export const FRAME_SPIKE_FACTOR = 8;     // 최근 프레임 시간의 이 배수까지 허용
const RISE = 0.5;                        // 추정치 상승 계수(저fps 진입을 빠르게 추적)
const FALL = 0.05;                       // 추정치 하강 계수(회복은 느리게 — 가드를 성급히 조이지 않는다)

/**
 * @param {object} [options]
 * @param {number} [options.initialFrame] 초기 프레임 시간 추정치(초). 기본 1/60.
 * @returns {{ step(raw: number): number, debug(): object }}
 */
export function createFrameClock({ initialFrame = 1 / 60 } = {}) {
  let estimate = initialFrame > 0 ? initialFrame : 1 / 60;
  let lastRaw = 0, lastDt = 0;
  return {
    /** 실제 벽시계 델타를 넣고, 이 프레임에 소비할 애니메이션 시간을 받는다. */
    step(raw) {
      const wall = Number.isFinite(raw) && raw > 0 ? raw : 0;
      const ceiling = Math.max(FRAME_SPIKE_FLOOR, estimate * FRAME_SPIKE_FACTOR);
      const dt = Math.min(wall, ceiling);
      estimate += (dt - estimate) * (dt > estimate ? RISE : FALL);
      lastRaw = wall; lastDt = dt;
      return dt;
    },
    /** 검증용 상태. ratio=1 이면 이 프레임이 벽시계에 충실했다는 뜻. */
    debug() {
      return {
        lastRaw,
        lastDt,
        estimate,
        ceiling: Math.max(FRAME_SPIKE_FLOOR, estimate * FRAME_SPIKE_FACTOR),
        ratio: lastRaw > 0 ? lastDt / lastRaw : 1,
        spikeFloor: FRAME_SPIKE_FLOOR,
        spikeFactor: FRAME_SPIKE_FACTOR,
      };
    },
  };
}
