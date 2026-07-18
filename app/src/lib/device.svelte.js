// 반응형 디바이스 상태 — matchMedia 기반 단일 소스. CSS 미디어쿼리와 판정을 일치시켜
// (같은 브레이크포인트) JS(바텀 시트 동작)와 CSS(레이아웃)가 어긋나지 않게 한다.
//
//   sheet          : 바텀 시트 레이아웃 사용(세로 좁은 화면). 우측 한지 패널·마을 옵션이 시트로.
//   touch          : 거친 포인터(폰·태블릿) — 터치 타깃 확대·다이얼 밴드 확대.
//   landscapePhone : 가로 폰(짧은 높이) — 시트 대신 축소된 우측 패널.
//   compact        : 폰급(최소변 ≤ 520) — 성능 프로파일 공격적(pixelRatio 1.5·저해상 bloom).
//   perf           : 성능 하향 프로파일 적용 대상(폰·태블릿 등 터치 디바이스).
//
// $state 로 노출해 컴포넌트가 읽으면 회전/리사이즈 시 자동 반영된다.

export const device = $state({
  w: 1360, h: 850,
  sheet: false,
  touch: false,
  landscapePhone: false,
  compact: false,
  perf: false,
  portrait: false,
});

const Q = {
  sheet: '(max-width: 768px) and (orientation: portrait)',
  touch: '(pointer: coarse)',
  landscapePhone: '(max-height: 520px) and (orientation: landscape)',
};

let inited = false;
export function initDevice() {
  if (inited || typeof window === 'undefined') return () => {};
  inited = true;
  const recompute = () => {
    const w = window.innerWidth, h = window.innerHeight;
    device.w = w; device.h = h;
    device.portrait = h >= w;
    device.touch = window.matchMedia(Q.touch).matches || 'ontouchstart' in window;
    device.landscapePhone = window.matchMedia(Q.landscapePhone).matches && device.touch;
    // 시트: 세로 좁은 화면. 가로 폰은 축소 사이드 패널이 더 쾌적(세로 여유가 없어 시트가 씬을 덮음).
    device.sheet = window.matchMedia(Q.sheet).matches;
    device.compact = Math.min(w, h) <= 520;
    // 성능 하향: 터치 디바이스(폰·태블릿) 또는 좁은 뷰포트.
    device.perf = device.touch || w <= 900;
  };
  recompute();
  const mqs = Object.values(Q).map((q) => window.matchMedia(q));
  for (const mq of mqs) mq.addEventListener?.('change', recompute);
  window.addEventListener('resize', recompute, { passive: true });
  window.addEventListener('orientationchange', recompute, { passive: true });
  return () => {
    for (const mq of mqs) mq.removeEventListener?.('change', recompute);
    window.removeEventListener('resize', recompute);
    window.removeEventListener('orientationchange', recompute);
    inited = false;
  };
}
