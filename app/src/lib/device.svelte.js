// 반응형 디바이스 상태 — matchMedia 기반 단일 소스. CSS 미디어쿼리와 판정을 일치시켜
// (같은 브레이크포인트) JS(바텀 시트 동작)와 CSS(레이아웃)가 어긋나지 않게 한다.
//
//   sheet          : 바텀 시트 레이아웃 사용(세로 좁은 화면). 우측 한지 패널·마을 옵션이 시트로.
//   touch          : 거친 포인터(폰·태블릿) — 터치 타깃 확대·다이얼 밴드 확대.
//   landscapePhone : 가로 폰(짧은 높이) — 시트 대신 축소된 우측 패널.
//   phone          : 진짜 폰(거친 포인터 + 최소변 ≤ 520) — 아래 두 성능 술어의 유일한 축.
//   compact        : 픽셀 예산 하향(pixelRatio 1.5·저해상 bloom).
//   perf           : 성능 하향 프로파일(그림자맵 하향·눈비 지붕 충돌 생략).
//
// perf/compact 는 2026-07-25 감사(docs/mobile-effects-audit.md P1·P2)에서 **진짜 폰**으로 좁혔다.
// 종전 술어는 `perf = touch || w <= 900`, `compact = min(w,h) <= 520` 이었고 둘 다 너무 넓었다 —
// 데스크톱 브라우저를 반쪽 창으로 쓰면 데스크톱 GPU인데도 DoF·플레어·히어로 선회를 전부 잃었고,
// 데스크톱급 GPU 태블릿(iPad Pro)도 터치라는 이유만으로 폰과 같은 취급을 받았다. 좁힌 술어는
// 폰에서 무엇을 줄이느냐를 바꾸지 않고, 폰이 아닌 기기를 게이트에서 빼기만 한다.
//
// 폰의 픽셀 예산 자체(감사 M1: pixelRatio 상한 1.5)는 이 라운드에서 올리지 않는다 — 헤드리스로
// 판정 불가한 유일한 필레이트 곱셈 항목이라 실기기 A/B가 선행이다(감사 §7·R9). 대신 아래
// fx 훅으로 같은 URL에서 프로파일을 뒤집어 실기기에서 바로 비교할 수 있게 했다.
//
// $state 로 노출해 컴포넌트가 읽으면 회전/리사이즈 시 자동 반영된다.

export const device = $state({
  w: 1360, h: 850,
  sheet: false,
  touch: false,
  landscapePhone: false,
  phone: false,
  compact: false,
  perf: false,
  portrait: false,
});

const Q = {
  sheet: '(max-width: 768px) and (orientation: portrait)',
  touch: '(pointer: coarse)',
  landscapePhone: '(max-height: 520px) and (orientation: landscape)',
};

// 프로파일 오버라이드 검증 훅(docs/verification.md) — `?fxperf=0|1`, `?fxcompact=0|1`.
// 0 = 강제 해제(데스크톱 룩), 1 = 강제 적용(폰 프로파일). 실기기 A/B와 A/B 게이트가 같은 URL로
// 축 하나만 뒤집을 수 있게 하는 것이 목적이다(감사 §2·§7). 부팅 시 한 번만 읽는다 — syncUrl 이
// 씬 주소를 다시 쓰면 쿼리에서 사라지므로, 리사이즈·회전 recompute 가 오버라이드를 잃지 않게.
let fxPerf = null, fxCompact = null;
function readFxOverride(params, name) {
  const v = params.get(name);
  return v === '0' ? false : v === '1' ? true : null;
}

let inited = false;
export function initDevice() {
  if (inited || typeof window === 'undefined') return () => {};
  inited = true;
  const params = new URLSearchParams(window.location.search);
  fxPerf = readFxOverride(params, 'fxperf');
  fxCompact = readFxOverride(params, 'fxcompact');
  const recompute = () => {
    const w = window.innerWidth, h = window.innerHeight;
    device.w = w; device.h = h;
    device.portrait = h >= w;
    device.touch = window.matchMedia(Q.touch).matches || 'ontouchstart' in window;
    device.landscapePhone = window.matchMedia(Q.landscapePhone).matches && device.touch;
    // 시트: 세로 좁은 화면. 가로 폰은 축소 사이드 패널이 더 쾌적(세로 여유가 없어 시트가 씬을 덮음).
    device.sheet = window.matchMedia(Q.sheet).matches;
    // 진짜 폰만: 거친 포인터 + 최소변이 폰급. 가로 폰(852×393)도 최소변으로 걸리고, 태블릿
    // (최소변 > 520)과 좁은 데스크톱 창(비터치)은 빠진다.
    device.phone = device.touch && Math.min(w, h) <= 520;
    device.perf = fxPerf ?? device.phone;
    device.compact = fxCompact ?? device.phone;
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
