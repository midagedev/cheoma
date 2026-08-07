// 히어로 랜딩 역광 태양 해 — 지형 인지 (2026-08-07).
//
// 왜 상수로는 안 되는가. 랜딩은 종가 **배면**에 태양을 두어 처마 실루엣에 골든 림을 만든다(#98).
// 그런데 배산임수 규약상 종가 배면은 곧 **배산**이다. 시드 20260716 실측:
//
//     태양 고도 9.51°  ·  배면(+55°) 방위의 지형 수평선 16.59°  →  여유 −7.08° (가려짐)
//
// 즉 시그니처 역광의 태양이 산 뒤 7° 아래에 박혀 있어 종가에 직사광이 한 줄기도 닿지 않았다.
// rim.js `_directGate` 는 그림자 항(_mainSunVisibility)이 0 이면 바닥값 0.45 로 눌리므로 림은
// 절반 이하로 시작하고, 무엇보다 씬 전체가 앰비언트만 받아 골든아워로 읽히지 않는다.
// 배면 오프셋별 수평선(같은 시드, 원점=종가 용마루):
//
//     off  0° : 25.3°     off 55° : 16.3°(현행)     off 70° : 12.0°     off 90° : 9.0°
//
// 종전 상수 `rotY + π + 55°` 는 2026-07-31 판정("정배면은 프레임을 실루엣으로 붕괴시킨다")이 고른
// 값인데, 그때 조정한 축(방위)과 가림을 만드는 축(고도)이 서로 달랐다. 그리고 능선 윤곽은 시드마다
// 다르므로 어떤 상수를 골라도 다른 부지에서 같은 사고가 재발한다 → 상수 재조정이 아니라 해로 간다.
//
// 해가 고르는 것: ① 배면 대역 안에서 능선이 낮은 방위 ② 그 방위에서 능선을 넘길 만큼만의 고도.
// 목적함수는 실제로 림을 만드는 두 게이트의 곱이다 — 고도 게이트(post.js altGate)와 역광 게이트
// (rim.js RIM_SOLAR_GATE). 태양을 올리면 능선은 넘지만 골든아워 저고도 게이트를 잃고, 배면에서
// 옆으로 돌리면 능선은 낮아지지만 역광 게이트를 잃는다. 곱이 그 상충을 한 수치로 만든다.
//
// 이 모듈은 three 를 쓰지 않는다(순수 수치) — 게이트가 렌더러 없이 전 부지를 훑을 수 있어야 한다.

import { RIM_SOLAR_GATE } from './rim-solar-gate.js';

const DEG = Math.PI / 180;

export const HERO_SUN_SOLVE = Object.freeze({
  // 배면 대역. 하한 35° — 정배면(0°)은 카메라를 향한 모든 면이 음영측이 되어 프레임이 실루엣
  //   하나로 붕괴한다(2026-07-31 실측: 피사체 밴드 중값 14/255, 룩 계약 "크러시드 블랙 금지" 위반).
  //   상한 115° — 그 밖은 측광을 지나 순광으로 넘어가 역광 게이트가 바닥에 닿는다.
  offsetMin: 35 * DEG,
  offsetMax: 115 * DEG,
  offsetStep: 2.5 * DEG,
  // 능선 위로 확보할 여유. 0 이면 태양이 능선에 접해 그림자 맵 경계에서 깜빡인다.
  ridgeMargin: 2.0 * DEG,
  // 이 위로 올리면 골든아워가 아니라 오후다. 넘겨야만 능선을 넘는 부지는 그냥 넘기지 않는다
  //   (가려진 채로 최선의 방위를 고르고, 아래 solve 가 occluded=true 로 알린다).
  elevationMax: 22 * DEG,
  // 수평선 탐사: 종가에서 이 거리까지 이 간격으로 지면 높이를 훑어 최대 앙각을 찾는다.
  //   1200m 는 마을(siteR 180)부터 한양(siteR 500)까지 배산 능선을 모두 포함한다.
  probeStep: 8,
  probeRange: 1200,
  probeSkip: 20,      // 종가 자신의 성토 패드·담장은 수평선이 아니다
  // post.js applyPS: altGate = 1 - smoothstep(sunDir.y, 0.20, 0.52). 림은 태양이 낮을 때만 성립한다.
  altGateStart: 0.20,
  altGateFull: 0.52,
});

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

/** post.js 의 저고도 게이트. 태양 고도(라디안) → 림 기본 강도 배수. */
export function altitudeGate(elevation) {
  return 1 - smoothstep(HERO_SUN_SOLVE.altGateStart, HERO_SUN_SOLVE.altGateFull, Math.sin(elevation));
}

/**
 * rim.js 의 역광 게이트. 카메라·태양 방향이 표면을 사이에 두고 마주볼수록 1 에 가깝다.
 * 셰이더는 프래그먼트마다 `-dot(표면→카메라, 표면→태양)` 을 쓰므로, 여기서는 피사체 중심을
 * 표면으로 삼은 그 값의 대표치를 쓴다(피사체가 프레임을 채우므로 화면 전반의 좋은 근사).
 */
export function backlitGate(cameraAzimuth, cameraElevation, sunAzimuth, sunElevation) {
  const cc = Math.cos(cameraElevation), cs = Math.sin(cameraElevation);
  const sc = Math.cos(sunElevation), ss2 = Math.sin(sunElevation);
  const dot = cc * sc * Math.cos(sunAzimuth - cameraAzimuth) + cs * ss2;
  const back = -dot;
  return RIM_SOLAR_GATE.backlitFloor
    + (1 - RIM_SOLAR_GATE.backlitFloor)
    * smoothstep(RIM_SOLAR_GATE.backlitStart, RIM_SOLAR_GATE.backlitFull, back);
}

/**
 * 한 방위선의 지형 수평선 앙각(라디안). heightAt(x, z) 는 월드 지면 높이.
 * origin 은 피사체 상단(용마루 부근) — 태양이 그 점에 닿는가가 직사광 판정이다.
 */
export function terrainHorizonAngle(heightAt, origin, azimuth, cfg = HERO_SUN_SOLVE) {
  if (typeof heightAt !== 'function') return -Math.PI / 2;
  const dx = Math.sin(azimuth), dz = Math.cos(azimuth);
  let best = -Math.PI / 2;
  for (let d = cfg.probeSkip; d <= cfg.probeRange; d += cfg.probeStep) {
    const y = heightAt(origin.x + dx * d, origin.z + dz * d);
    if (!Number.isFinite(y)) continue;
    const ang = Math.atan2(y - origin.y, d);
    if (ang > best) best = ang;
  }
  return best;
}

/**
 * 히어로 역광 태양 해.
 *
 *   backAzimuth      종가 배면 방위(rotY + π)
 *   cameraAzimuth    정착 카메라가 피사체를 기준으로 서 있는 방위(atan2(cam.x-t.x, cam.z-t.z))
 *   cameraElevation  같은 포즈의 앙각(피사체에서 카메라를 올려다본 각)
 *   sunElevation     시간대 프로필의 태양 고도(하한 — 해는 이보다 낮추지 않는다)
 *   heightAt/origin  지형 조회와 피사체 상단
 *
 * → { azimuth, elevation, offset, horizon, clearance, occluded, score }
 */
export function solveHeroBacklight({
  backAzimuth,
  cameraAzimuth,
  cameraElevation = 0,
  sunElevation,
  heightAt,
  origin,
  cfg = HERO_SUN_SOLVE,
} = {}) {
  const elevMax = Math.max(sunElevation, cfg.elevationMax);
  let best = null;
  for (let mag = cfg.offsetMin; mag <= cfg.offsetMax + 1e-9; mag += cfg.offsetStep) {
    for (const sign of [1, -1]) {
      const offset = mag * sign;
      const azimuth = backAzimuth + offset;
      const horizon = terrainHorizonAngle(heightAt, origin, azimuth, cfg);
      // 능선을 넘길 만큼만 올린다. 프로필 고도로 이미 넘으면 그대로 둔다(골든아워 유지).
      const need = horizon + cfg.ridgeMargin;
      const elevation = clamp(Math.max(sunElevation, need), sunElevation, elevMax);
      const clearance = elevation - horizon;
      const score = altitudeGate(elevation)
        * backlitGate(cameraAzimuth, cameraElevation, azimuth, elevation)
        // 그림자 항: 가려지면 rim.js `_directGate` 가 바닥값으로 눌린다. 넘기지 못하는 방위는
        //   그 손실을 그대로 안고 경쟁해야 실제 화면과 같은 순위가 나온다.
        * (clearance > 0 ? 1 : RIM_SOLAR_GATE.shadowFloor);
      if (!best || score > best.score) {
        best = { azimuth, elevation, offset, horizon, clearance, occluded: clearance <= 0, score };
      }
    }
  }
  return best;
}
