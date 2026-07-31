import { smoothstep } from '../core/math/scalar.js';

// A horizontal transparent annulus reads as distant ground mist from an eye-level
// view, but its triangles become broad overlapping wedges when the camera looks
// down through the surface. The separate upright ridge mist remains visible after
// this weight settles and continues to own focused/aerial atmosphere.
//
// 부감을 0 으로 끄지는 않는다(R5/U1 #211): 이 링은 지형 절단면과 외곽 수관 실루엣을 대기로 녹이는
//   장치라, 부감에서 완전히 꺼지면 마을이 하늘에 하드컷으로 붙은 "떠 있는 디오라마 원반"이 된다.
//   웨지가 두드러지지 않는 수준의 바닥 가중치만 남긴다 — 부감에서 링은 마을 바깥 외곽 밴드에만
//   걸리므로(populate 의 rIn≈0.78), 분지 내부를 흐리게 덮던 구 룩으로는 돌아가지 않는다.
//   아이레벨 10° 시작 → 30° 전이 대역은 유지(고도 감쇠 계약). 부감 제품 피치(≈31°) 는 이미 바닥값.
const FADE_START = Math.sin(10 * Math.PI / 180);
const FADE_END = Math.sin(30 * Math.PI / 180);
// 1/2 — dyadic fraction for exact gate equality.
//
// #211 은 이 바닥을 15/16(0.9375)로 두었다. 근거는 "마을 fog near=R*2.2 는 terrainR 보다 멀어
//   절단면이 scene fog 에 전혀 안 걸리므로 이 링이 사실상 유일한 로컬 소실 레버"였다 — 즉 **fog
//   부재 보상**이었고, #31 에서 그 전제가 버그로 확정됐다(fog 가 한 번도 발화하지 않았다).
// #31 되감기: fog 가 살아난 지금 0.9375 를 그대로 두면 같은 소실을 두 번 계상해 부감이 유백색으로
//   덮인다. 링을 부감의 **주** 소실 장치에서 **보조** 로 되돌린다 — 부감 절단면의 깊이 성분은 fog
//   가 갖고, 링은 fog 로 분리되지 않는 수평 접선 몫만 남긴다. 0.5 는 이 수직 링을 부감에서 절반까지
//   내려 웨지 가시성을 줄이면서(원래 고도 감쇠를 넣은 이유) 하드컷 방지 하한은 유지하는 값이다.
export const EDGE_MIST_AERIAL_FLOOR = 0.5;

export function edgeMistViewWeight(cameraForwardY) {
  if (!Number.isFinite(cameraForwardY)) return 0;
  const down = Math.max(0, -cameraForwardY);
  return 1 - (1 - EDGE_MIST_AERIAL_FLOOR) * smoothstep(FADE_START, FADE_END, down);
}

// 능선 물안개(직립 카메라 대면 뱅크)는 아이레벨이 주역·부감이 보조다. 그 뱅크는 아이레벨에서
//   배경 사면을 여백으로 소실시키는 장치이고, 부감에서는 yaw 만 카메라를 따르므로 31° 내려봐도
//   거의 정면 그대로 남아 산 사면에 넓은 회색 얼룩으로 얹힐 수 있다. 부감에서 0 으로 끄지도
//   않는다 — 능선 겹침·원경 절단 몫은 남겨야 하드컷 원반이 다시 선다(U1 #211).
// 3/8 — dyadic fraction; always below the ring floor so aerial keeps the horizontal ring as
//   the primary cut softener and the upright banks as a secondary layer only.
// #31 되감기: 3/4 → 3/8. 이 뱅크가 부감에서 높게 유지된 이유도 같은 fog 부재 보상이었다("부감에서
//   0 이 되면 능선 겹침 소실이 사라져 하드컷 원반이 다시 선다"). 배산 사면의 대기 원근은 이제 fog
//   가 실제로 공급하므로(아이레벨 배경 사면 ≈0.30 fogFactor), 카메라 대면 평면이 31° 부감에서
//   산 사면에 넓은 회색 얼룩으로 얹히던 몫을 절반으로 줄인다. 링 바닥(0.5)보다 낮은 불변은 유지.
export const RIDGE_MIST_AERIAL_FLOOR = 0.375;

export function ridgeMistViewWeight(cameraForwardY) {
  if (!Number.isFinite(cameraForwardY)) return 0;
  const down = Math.max(0, -cameraForwardY);
  return 1 - (1 - RIDGE_MIST_AERIAL_FLOOR) * smoothstep(FADE_START, FADE_END, down);
}
