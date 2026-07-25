// 애니메이션 시간 클록 — 벽시계 델타에 스파이크 클램프만 적용한다.
//
// 이 값 하나가 리빌 카메라·조립·트윈·웨이브·먹안개·입자를 모두 구동하므로, 클램프 정책이
// authored 길이(예: 히어로 arrival 8.1초)가 벽시계로 지켜지는지를 단독으로 결정한다.
//
// ── 무엇이 잘못돼 있었나
// 종전 정책은 engine.js 렌더 루프 안의 `Math.min(elapsed, 0.05)` 한 줄이었고, 그것은 스파이크 가드가
// 아니라 **20fps 천장**이었다. `clock.getDelta()` 자체는 벽시계지만, 프레임이 0.05초를 넘는 순간부터
// 연출 배속이 `0.05 / 실제 프레임 시간`으로 떨어진다. 실측으로 폰 에뮬레이션에서 8.1초 안무가 벽시계
// 8초에 progress 0.0147 까지만 갔고(배속 0.035), 사용자에게는 "모바일에서 히어로 카메라가 회전하지
// 않는다"로 보였다. 저fps 데스크톱도 같은 비율로 늘어졌으므로 모바일 전용 결함이 아니다.
// 22개 게이트가 하나도 이것을 잡지 못했다 — 안무 게이트가 전부 결정론 seek 로 벽시계를 우회한다.
// 그래서 정책을 three 의존 없는 이 모듈로 떼어 계약으로 고정한다(tools/check-frame-clock.mjs).
//
// ── 왜 한 클록인가 (카메라 안무만 분리하지 않는 이유)
// 리빌 카메라의 길이는 조립 길이에서 파생된다 — engine 은
// `duration: HERO_ASSEMBLE_DELAY + HERO_ASSEMBLE_DUR - HERO_REVEAL_TAIL` 로 카메라가 조립 완주보다
// 1.3초 먼저 도착하게 해 "완성 비트를 고정된 프레임에서 보는" 무대를 만든다. 진입 먹안개
// (startVillageReveal)와 규모 커밋 웨이브도 같은 조립 시계에 맞춰져 있다. 카메라만 벽시계로 옮기고
// 조립을 클램프에 두면 저fps 에서 둘이 어긋나, 카메라가 도착한 뒤에도 건물이 한참 올라가고 베일이
// 열리지 않는다 — 고치려던 것보다 나쁜 아티팩트다. 그래서 클램프 값만 바꾸고 클록은 하나로 둔다.
//
// ── 정책: 0.25초 상한
// 20fps 이상에서는 raw 가 항상 상한 아래이므로 **종전과 완전히 동일**하다(정상 주행 무변). 프레임이
// 0.05초를 넘는 깨진 구간에서만 달라져 벽시계 속도로 재생된다. 탭 복귀·동기 생성 블로킹·셰이더 링크
// 같은 단발 스톨은 0.25초에서 흡수되어 텔레포트하지 않는다. 4fps 미만에서는 여전히 늘어지지만 배율이
// (프레임 시간 / 0.25)로 유계이고, 실기기는 그 구간에 들어가지 않는다 — 헤드리스 소프트웨어 GL 의
// 0.2~0.3fps 는 제품 신호가 아니다(docs/verification.md).
//
// 감쇠(OrbitControls)는 raw 를 따로 받아 프레임레이트 독립을 유지하므로 이 클램프와 무관하다.

export const FRAME_SPIKE_CLAMP = 0.25;

/** @returns {{ step(raw: number): number, debug(): object }} */
export function createFrameClock({ spikeClamp = FRAME_SPIKE_CLAMP } = {}) {
  const clamp = spikeClamp > 0 ? spikeClamp : FRAME_SPIKE_CLAMP;
  let lastRaw = 0, lastDt = 0;
  return {
    /** 실제 벽시계 델타를 넣고, 이 프레임에 소비할 애니메이션 시간을 받는다. */
    step(raw) {
      const wall = Number.isFinite(raw) && raw > 0 ? raw : 0;
      const dt = Math.min(wall, clamp);
      lastRaw = wall; lastDt = dt;
      return dt;
    },
    /** 검증용. ratio=1 이면 이 프레임이 벽시계에 충실했다는 뜻(<1 이면 그만큼 연출이 느려진다). */
    debug() {
      return {
        lastRaw,
        lastDt,
        clamp,
        ratio: lastRaw > 0 ? lastDt / lastRaw : 1,
      };
    },
  };
}
