// Reusable physical HDR light-source geometry. Product lighting policy and
// village owner selection remain outside this low-level factory.
export { createPhysicalNightlightBatch } from '../village/nightlight-physical-geometry.js';

// 히어로 랜딩 역광 태양 해(2026-08-07). 종가 배면은 배산임수 규약상 곧 배산이라, 배면에 고정된
// 상수 방위는 저고도 석양을 능선 뒤에 묻는다(실측 −7.08°, 직사광 0). 지형을 읽어 방위·고도를
// 함께 고르는 순수 수치 해다 — 렌더러 없이 게이트가 전 부지를 훑을 수 있어야 한다.
export {
  solveHeroBacklight,
  terrainHorizonAngle,
  altitudeGate,
  backlitGate,
  HERO_SUN_SOLVE,
} from '../env/hero-sun.js';
