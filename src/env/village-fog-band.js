// 마을 대기(fog) 거리 밴드 — 카메라 거리 파생 단일 진실원(#31).
//
// 왜 규모(siteR) 파생이 아니라 카메라 거리 파생인가. 이전 규약은 `near = R*2.2`, `far = R*7.0`
// 였고, 그 상수는 "부감 카메라는 마을에서 멀다"는 사정을 규모로 근사한 값이다. 그런데 지형은
// `terrainR = nearR + 12`(site.js #143)로 잘려 있어서 `R*2.2` 는 **지형 지름보다도 멀다**:
//   village  R150 지름 285m vs near 330 / capital R400 지름 631m vs near 880 /
//   hanyang  R500 지름 760m vs near 1100.
// 실측(#31 진단, capital vseed 7 제품 경로 drone landmark-orbit t=0.2): fog near/far = 616/1960m
// 인데 카메라→숲 인스턴스 거리는 77~279m 였다 → 씬 안의 모든 지오메트리에서 fogFactor 가 정확히
// 0. 즉 `scene.fog` 는 마을 모드에서 한 번도 발화하지 않았다. 지형만 자체 로컬 헤이즈(정점색
// cFar + aEdge 셰이더 믹스)로 혼자 씻겨 나가고, 그 위에 얹힌 수관·암반은 대기 참여도 0이라
// 산 표면에서 분리된 별개 레이어로 읽혔다(중단 밴드 실측 나무/지형 휘도비 0.53x).
//
// fog 는 카메라 거리 함수이므로 규모 상수로는 어떤 프레이밍도 맞출 수 없다. 대신 카메라→분지
// 중심 거리 d 를 기준으로 매 프레임 밴드를 옮긴다. 부감·드론 궤도·아이레벨 도보가 모두 같은
// 식으로 "근경은 선명, 원경은 대기로 소실"을 얻는다.
//
//   near = max(nearFloor, d - terrainR*nearPull)
//   far  = near + terrainR*farSpan
//
// nearPull 0.60 — 분지 앞쪽 테두리(d - terrainR)보다 살짝 뒤에서 대기가 시작한다. 근경 필지·
//   처마는 항상 fog 밖이어야 한다(플래그십 룩은 근경 선명 + 원경 소실이다).
// farSpan 3.40 — near 기준 스팬을 지형 반경 배수로 고정한다. 두 상수를 이렇게 잡으면 씬 최원단
//   (d + terrainR)의 fogFactor 가 프레이밍·규모와 무관하게 상수로 떨어진다:
//     (d + TR - near) / (far - near) = 1.6·TR / 3.4·TR = 0.4706
//   즉 부감·드론 궤도·아이레벨 테두리가 모두 최원단 ≈47% 를 받고, 최근접단은 항상 0% 다
//   (d - TR < near 이므로). 카메라가 분지 안쪽 깊이 들어와 near 가 nearFloor 로 클램프되는
//   아이레벨(d ≈ 0.14R)만 예외로 최원단 32~34% 를 받는다 — 그 프레임에서는 배경 사면이 화면의
//   주역이라 오히려 이 감쇠가 알맞다. 스팬을 더 좁히면 능선 실루엣이 소실되고(즉시 실패),
//   더 넓히면 fog 부재 시절로 되돌아간다. 파생 검증은 tools/check-village-fog-band.mjs.
// nearFloor 8m — 아이레벨에서 카메라가 분지 안에 있으면 d - terrainR*0.6 이 음수가 된다.
//   0 이하 near 는 three 에서 카메라 바로 앞부터 안개를 씌우므로 8m 를 바닥으로 둔다.
// followPerSec 2.6 — 지수 추종. focus 줌·드론 컷처럼 d 가 프레임당 크게 튀는 구간에서 밴드가
//   같이 튀면 fog 가 펄스친다. 환경 전환 크로스페이드 계약(팝 금지)과 같은 성격의 시정수다.
//   snap 경로(진입·프리워밍·shot)는 추종을 건너뛰고 목표 밴드를 그대로 쓴다.

export const VILLAGE_FOG_BAND = Object.freeze({
  nearPull: 0.60,
  farSpan: 3.40,
  nearFloor: 8,
  followPerSec: 2.6,
  minSpan: 0.5,        // terrainR 배수 — 퇴화 입력에서도 near < far 를 보장
  fallbackDistance: 2.3, // siteR 배수 — 카메라를 아직 못 읽은 첫 틱의 부감 기준 거리
});

const finitePositive = (value, fallback) => (
  Number.isFinite(value) && value > 0 ? value : fallback
);

/** 카메라→분지 중심 거리와 지형 반경에서 fog 밴드를 만든다. 순수·Three 비의존. */
export function villageFogBand(cameraDistance, terrainR) {
  const R = finitePositive(terrainR, 150);
  const d = finitePositive(cameraDistance, R * VILLAGE_FOG_BAND.fallbackDistance);
  const near = Math.max(VILLAGE_FOG_BAND.nearFloor, d - R * VILLAGE_FOG_BAND.nearPull);
  const far = Math.max(
    near + R * VILLAGE_FOG_BAND.minSpan,
    near + R * VILLAGE_FOG_BAND.farSpan,
  );
  return { near, far };
}

/**
 * 카메라 거리를 지수 추종한다. previous 가 없거나(진입) dt 가 비정상이면 목표로 스냅한다.
 * 밴드를 near/far 두 값으로 따로 스무딩하지 않는 이유: 스칼라 하나만 추종하면 전이 중에도
 * 밴드 형상(nearPull·farSpan 비율)이 그대로 유지돼 near 와 far 가 서로 다른 속도로 움직이며
 * 대기 기울기가 일그러지는 일이 없다.
 */
export function followFogDistance(previous, target, dt) {
  const goal = finitePositive(target, 0);
  if (!Number.isFinite(previous) || previous <= 0) return goal;
  if (!Number.isFinite(dt) || dt <= 0) return goal;
  const k = 1 - Math.exp(-VILLAGE_FOG_BAND.followPerSec * Math.min(dt, 0.25));
  return previous + (goal - previous) * k;
}
