import { DEFAULT_DETAIL_BANDS } from '../core/lod.js';

// 한양급 주택 청크의 단일 LOD 정책. 계획·런타임·계약 검사가 같은 임계값과
// 히스테리시스 전이를 사용하도록 THREE 없는 순수 모듈에 둔다.
export const CHUNK_LOD_LEVEL = Object.freeze({
  FAR: 'far',
  // 이전 디버그/하네스가 쓰던 이름. 값은 FAR와 같아 표현 상태가 둘로 갈라지지 않는다.
  IMPOSTOR: 'far',
  MID: 'mid',
  FULL: 'full',
});

export const VILLAGE_CHUNK_LOD = Object.freeze({
  minSiteR: 340,
  farDistanceFactor: 0.40,
  ringWidthFactor: 0.50,
  maxArcFactor: 0.30,
  // 원거리 mass는 넓은 부감에서만 쓴다. 그보다 가까우면 실제 빌더에서 추출한
  // envelope로 넘어가 색·지붕선이 갑자기 다른 집처럼 바뀌지 않게 한다.
  midInFactor: 0.75,
  midOutFactor: 0.90,
  fullInFactor: 0.45,
  fullOutFactor: 0.53,
});

// 카메라가 보는 지면 셀의 생활 디테일 정책. 절대 월드 Y가 아니라 카메라-시선 타깃의 수직차를
// 사용하므로 산지의 높은 필지에서도 근접 동물·입자가 사라지지 않는다. spatial은 소동물,
// altitude는 비선택 필지 앰비언스, particles는 낙엽/꽃잎처럼 지면 맥락이 필요한 입자에 쓴다.
export const VILLAGE_DETAIL_LOD = Object.freeze({
  spatial: Object.freeze({ full: 32, hidden: 72 }),
  view: Object.freeze({ full: 56, hidden: 104 }),
  particleView: DEFAULT_DETAIL_BANDS.particleView,
  altitude: DEFAULT_DETAIL_BANDS.altitude,
  particles: DEFAULT_DETAIL_BANDS.particles,
});

export function villageChunkLodPolicy(site) {
  const siteR = Number(site?.R) || 0;
  const bowlR = Number(site?.bowlR) || 0;
  const enabled = siteR >= VILLAGE_CHUNK_LOD.minSiteR && bowlR > 0;
  const ringW = enabled ? bowlR * VILLAGE_CHUNK_LOD.ringWidthFactor : undefined;
  const fullIn = bowlR * VILLAGE_CHUNK_LOD.fullInFactor;
  const fullOut = bowlR * VILLAGE_CHUNK_LOD.fullOutFactor;
  return {
    enabled,
    farDist: enabled ? bowlR * VILLAGE_CHUNK_LOD.farDistanceFactor : Infinity,
    ringW,
    maxArcLength: enabled ? bowlR * VILLAGE_CHUNK_LOD.maxArcFactor : undefined,
    midIn: bowlR * VILLAGE_CHUNK_LOD.midInFactor,
    midOut: bowlR * VILLAGE_CHUNK_LOD.midOutFactor,
    fullIn,
    fullOut,
    // 하위호환: 기존 소비자의 swap 경계는 full-detail 경계를 뜻한다.
    swapIn: fullIn,
    swapOut: fullOut,
  };
}

export function nextChunkLodLevel(level, distance, policy) {
  if (!Number.isFinite(distance)) return level;
  if (level === CHUNK_LOD_LEVEL.FULL) {
    if (distance > policy.midOut) return CHUNK_LOD_LEVEL.FAR;
    return distance > policy.fullOut ? CHUNK_LOD_LEVEL.MID : level;
  }
  if (level === CHUNK_LOD_LEVEL.MID) {
    if (distance < policy.fullIn) return CHUNK_LOD_LEVEL.FULL;
    if (distance > policy.midOut) return CHUNK_LOD_LEVEL.FAR;
    return level;
  }
  if (distance < policy.fullIn) return CHUNK_LOD_LEVEL.FULL;
  return distance < policy.midIn ? CHUNK_LOD_LEVEL.MID : CHUNK_LOD_LEVEL.FAR;
}
