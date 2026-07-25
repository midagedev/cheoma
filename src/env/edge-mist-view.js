import { smoothstep } from '../core/math/scalar.js';

// A horizontal transparent annulus reads as distant ground mist from an eye-level
// view, but its triangles become broad overlapping wedges when the camera looks
// down through the surface. The separate upright ridge mist remains visible after
// this weight settles and continues to own focused/aerial atmosphere.
//
// 부감을 0 으로 끄지는 않는다(R5/U1): 이 링은 지형 절단면과 외곽 수관 실루엣을 대기로 녹이는
//   유일한 장치라, 부감에서 완전히 꺼지면 마을이 하늘에 하드컷으로 붙은 "떠 있는 디오라마 원반"이
//   된다. 대신 웨지가 두드러지지 않는 수준의 바닥 가중치만 남긴다 — 부감에서 링은 마을 바깥
//   외곽 밴드에만 걸리므로(populate 의 rIn), 분지 내부를 흐리게 덮던 구 룩으로는 돌아가지 않는다.
const FADE_START = Math.sin(10 * Math.PI / 180);
const FADE_END = Math.sin(30 * Math.PI / 180);
export const EDGE_MIST_AERIAL_FLOOR = 0.8;

export function edgeMistViewWeight(cameraForwardY) {
  if (!Number.isFinite(cameraForwardY)) return 0;
  const down = Math.max(0, -cameraForwardY);
  return 1 - (1 - EDGE_MIST_AERIAL_FLOOR) * smoothstep(FADE_START, FADE_END, down);
}

// 능선 물안개(직립 카메라 대면 뱅크)는 반대 방향의 가중치를 쓴다. 그 뱅크는 아이레벨에서 배경 사면을
//   여백으로 소실시키는 장치이고, 부감에서는 yaw 만 카메라를 따르므로 31° 내려봐도 거의 정면 그대로
//   남아 산 사면에 넓은 회색 얼룩으로 얹힌다(구 골든의 "탁한" 원경 처리). 부감에서 0 으로 끄지도
//   않는다 — 능선 겹침을 부드럽게 하는 몫은 남겨야 한다.
export const RIDGE_MIST_AERIAL_FLOOR = 0.5;   // 2 의 거듭제곱 분수 — 게이트가 정확 비교 가능

export function ridgeMistViewWeight(cameraForwardY) {
  if (!Number.isFinite(cameraForwardY)) return 0;
  const down = Math.max(0, -cameraForwardY);
  return 1 - (1 - RIDGE_MIST_AERIAL_FLOOR) * smoothstep(FADE_START, FADE_END, down);
}
