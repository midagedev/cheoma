export const PAVILION_DEFAULTS = Object.freeze({
  radius: 2.5,
  postH: 3.0,
  eaveOverhang: 1.55,
  roofRise: 2.55,
  cornerLift: 0.55,
  planCurve: 0.42,
  profileCurve: 0.6,
  finialAllowance: 1.5,
});

// 석재 기단 최하단(p1) 의 바닥 반경. pavilion.js 가 굽는 ngonPrism(n, radius+0.85,
// radius+0.9, …) 의 넓은 쪽이다 — 접지면 계약(#56)이 이 값을 재추정하면 기단 밑을 못 덮는다.
// planning 반경(pavilionPlanningRoofRadius, 처마 기준 4.5m)과 혼동 금지: 기단은 3.4m.
export function pavilionPodiumFootprintRadius(spec = PAVILION_DEFAULTS) {
  return spec.radius + 0.9;
}

export function pavilionPlanningRoofRadius(spec = PAVILION_DEFAULTS) {
  const exact = spec.radius + spec.eaveOverhang + spec.planCurve;
  return Math.ceil(exact * 10) / 10;
}

export function pavilionPlanningHeight(spec = PAVILION_DEFAULTS) {
  const podium = 0.5;
  const eaveAboveColumns = 0.35;
  return podium + spec.postH + eaveAboveColumns + spec.roofRise + spec.finialAllowance;
}
