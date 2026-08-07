// 히어로 랜딩 역광 태양 해 계약 (2026-08-07) — 순수 노드, 렌더러 없음.
//
// 왜 이 게이트가 있는가. 랜딩은 종가 **배면**에 태양을 두어 처마에 골든 림을 만든다(#98). 그런데
// 배산임수 규약상 종가 배면은 곧 배산이라, 배면 고정 상수(`rotY + π + 55°`)는 저고도 석양을
// 능선 뒤에 묻었다 — 실측(vseed 20260716): 태양 고도 9.51° vs 그 방위 지형 수평선 16.59°,
// 여유 −7.08°. 종가에 직사광이 0 이고 rim.js `_directGate` 가 그림자 바닥값 0.45 로 눌린 채
// 시작해 "조립 후 림라이트가 거의 없다"(사용자 보고)가 되었다.
//
// 능선 윤곽은 시드마다 다르므로 상수로는 어떤 값을 골라도 다른 부지에서 재발한다. 그래서 해로
// 갔고, 이 게이트가 그 해의 계약을 못박는다. §1 은 **수정 전 소스가 실제로 실패함**을 같은
// 픽스처에서 재현한다(FAIL-first) — 게이트가 이미 녹색인 조건을 단언하고 있지 않다는 증거다.
//
// 실행: node tools/check-hero-sun.mjs
import {
  solveHeroBacklight,
  terrainHorizonAngle,
  altitudeGate,
  backlitGate,
  HERO_SUN_SOLVE,
} from '../src/env/hero-sun.js';   // 순수 모듈 직접 임포트 — api/lighting.js 는 three 의존 모듈을
                                   // 함께 재수출해 레포 루트(three 없음)에서 해석되지 않는다.

const DEG = Math.PI / 180;
const R2D = 180 / Math.PI;
let failures = 0;
const ok = (cond, label, detail = '') => {
  if (cond) console.log(`  PASS  ${label}${detail ? `  ${detail}` : ''}`);
  else { failures++; console.log(`  FAIL  ${label}${detail ? `  ${detail}` : ''}`); }
};

// ── 픽스처: 배산임수 ────────────────────────────────────────────────────────────
// 종가는 원점, 남향(rotY=0, 배면 = +π = 북 = -z). 북쪽에 능선, 남쪽은 열린 들.
// 실측 부지(vseed 20260716)의 배면 수평선 25.3° / +55° 방위 16.3° / +90° 방위 9.0° 를 재현한다.
// 실측을 재현하도록 맞춘 값: 배면 25.3° · +55° 15.5° · +72.5° 12.7° · +90° 10.1° · +115° 6.7°.
// (원 실측: 25.3 / 16.3 / — / 9.0). 첫 시도의 falloff 150 은 +55° 에서 이미 9.2° 로 떨어져
// §1 의 FAIL-first 조건 자체가 성립하지 않았다 — 픽스처가 배산임수를 재현하지 못한 것이다.
const RIDGE = {
  distance: 220,
  crest: 110,          // atan2(110-6, 220) ≈ 25.3°
  falloffDeg: 250,     // 이 각도만큼 벗어나면 평지
};
function bacsanHeightAt(x, z) {
  // 능선 마루선까지의 방위·거리 기반 단순 지형. 남(+z)은 0.
  const d = Math.hypot(x, z);
  if (d < 1) return 0;
  const az = Math.atan2(x, z);                    // 0 = 남(+z), ±π = 북(-z)
  const offFromBack = Math.abs(Math.abs(az) - Math.PI) * R2D;  // 배면(북)에서 벗어난 각
  const lateral = Math.max(0, 1 - offFromBack / RIDGE.falloffDeg);
  const crest = RIDGE.crest * lateral * lateral;
  // 마루 거리에서 최고, 그 앞뒤로 완만히 낮아진다.
  const t = Math.min(1, d / RIDGE.distance);
  return crest * t * t;
}
const flatHeightAt = () => 0;

const ORIGIN = { x: 0, y: 6, z: 0 };
const BACK = Math.PI;                 // rotY 0 → 배면 = 북
const CAM_AZ = 14 * DEG;              // 실측 정착 카메라 방위(남남동)
const CAM_EL = 9 * DEG;
const SUN_EL = 9.51 * DEG;            // sunset 프로필(atmosphere-profiles sunDir [-16,8,-45])

console.log('§1  FAIL-first — 종전 상수(배면 +55°)는 같은 픽스처에서 가려진다');
const legacyAz = BACK + 55 * DEG;
const legacyHorizon = terrainHorizonAngle(bacsanHeightAt, ORIGIN, legacyAz);
ok(legacyHorizon > SUN_EL,
  '종전 상수 방위의 지형 수평선이 석양 고도보다 높다(= 직사광 0)',
  `horizon ${(legacyHorizon * R2D).toFixed(2)}° > sun ${(SUN_EL * R2D).toFixed(2)}°`);
const headOnHorizon = terrainHorizonAngle(bacsanHeightAt, ORIGIN, BACK);
ok(headOnHorizon > legacyHorizon,
  '정배면이 가장 심하게 가려진다(픽스처가 배산임수를 재현한다)',
  `back ${(headOnHorizon * R2D).toFixed(2)}° > +55° ${(legacyHorizon * R2D).toFixed(2)}°`);

console.log('§2  해는 능선을 넘긴다');
const solved = solveHeroBacklight({
  backAzimuth: BACK,
  cameraAzimuth: CAM_AZ,
  cameraElevation: CAM_EL,
  sunElevation: SUN_EL,
  heightAt: bacsanHeightAt,
  origin: ORIGIN,
});
ok(!!solved, '해가 결과를 낸다');
ok(solved.clearance > 0,
  '태양이 지형 수평선 위에 있다(= _directGate 가 그림자 바닥값에 눌리지 않는다)',
  `clearance +${(solved.clearance * R2D).toFixed(2)}°`);
ok(solved.clearance >= HERO_SUN_SOLVE.ridgeMargin - 1e-6 || solved.elevation >= HERO_SUN_SOLVE.elevationMax,
  '여유가 ridgeMargin 이상이거나 고도 상한에 닿아 있다',
  `clearance ${(solved.clearance * R2D).toFixed(2)}° · elev ${(solved.elevation * R2D).toFixed(2)}°`);

console.log('§3  배면 대역과 골든아워 고도를 벗어나지 않는다');
const mag = Math.abs(solved.offset);
ok(mag >= HERO_SUN_SOLVE.offsetMin - 1e-9 && mag <= HERO_SUN_SOLVE.offsetMax + 1e-9,
  '오프셋이 [35°, 115°] 안 — 정배면 실루엣 붕괴도, 순광도 아니다',
  `${(solved.offset * R2D).toFixed(1)}°`);
ok(solved.elevation >= SUN_EL - 1e-9,
  '해는 태양을 시간대 프로필보다 **낮추지 않는다**',
  `${(solved.elevation * R2D).toFixed(2)}° ≥ ${(SUN_EL * R2D).toFixed(2)}°`);
ok(solved.elevation <= HERO_SUN_SOLVE.elevationMax + 1e-9,
  '고도 상한(22°)을 넘지 않는다 — 그 위는 골든아워가 아니라 오후다',
  `${(solved.elevation * R2D).toFixed(2)}°`);

console.log('§4  역광이 유지된다(측광으로 도망가지 않는다)');
const gate = backlitGate(CAM_AZ, CAM_EL, solved.azimuth, solved.elevation);
ok(gate >= 0.60,
  'rim.js 역광 게이트가 0.60 이상',
  `${gate.toFixed(3)}`);
const legacyGate = backlitGate(CAM_AZ, CAM_EL, legacyAz, SUN_EL);
ok(solved.score >= legacyGate * altitudeGate(SUN_EL) * 0.45,
  '해의 점수가 종전 상수(그림자 바닥값 0.45 포함)보다 높다',
  `solved ${solved.score.toFixed(3)} vs legacy ${(legacyGate * altitudeGate(SUN_EL) * 0.45).toFixed(3)}`);

console.log('§5  평지 항등 경로 — 넘길 능선이 없으면 고도를 올리지 않는다');
const flat = solveHeroBacklight({
  backAzimuth: BACK,
  cameraAzimuth: CAM_AZ,
  cameraElevation: CAM_EL,
  sunElevation: SUN_EL,
  heightAt: flatHeightAt,
  origin: ORIGIN,
});
ok(Math.abs(flat.elevation - SUN_EL) < 1e-9,
  '평지에서는 프로필 고도 그대로(골든아워 저고도를 불필요하게 잃지 않는다)',
  `${(flat.elevation * R2D).toFixed(2)}°`);
ok(flat.clearance > 0 && !flat.occluded, '평지에서는 가림이 없다');

console.log('§6  수평선 산출이 해석적으로 맞다');
// 원점에서 정확히 200 m 떨어진 곳에 높이 100 m → atan2(100-6, 200) = 25.19°
const rampAt = (x, z) => (Math.hypot(x, z) >= 200 && Math.hypot(x, z) <= 208 ? 100 : 0);
const rampAngle = terrainHorizonAngle(rampAt, ORIGIN, 0);
ok(Math.abs(rampAngle - Math.atan2(94, 200)) < 1.5 * DEG,
  '단일 계단 지형의 앙각이 해석해와 일치',
  `${(rampAngle * R2D).toFixed(2)}° vs ${(Math.atan2(94, 200) * R2D).toFixed(2)}°`);

console.log('§7  고도 게이트가 post.js 저고도 램프와 같다');
ok(Math.abs(altitudeGate(0) - 1) < 1e-9, '수평(0°)에서 1.0');
ok(altitudeGate(40 * DEG) < 0.05, '40°에서 사실상 0 — 정오에는 림이 없다',
  `${altitudeGate(40 * DEG).toFixed(4)}`);
ok(altitudeGate(SUN_EL) > altitudeGate(HERO_SUN_SOLVE.elevationMax),
  '고도가 오를수록 단조 감소');

console.log(failures === 0 ? '\nhero-sun OK' : `\nhero-sun FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
