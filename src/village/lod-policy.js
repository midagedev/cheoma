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
  // 화면상 약 10m(Hanyang bowlR=280) 안에서만 인접 두 단계를 보색 screen-door로
  // 이행한다. 가장 좁은 FULL hysteresis dead band보다 짧아 방향 반전에도 안정적이다.
  transitionWidthFactor: 0.035,
});

// screen-door coverage의 고정 단계 수. 순수 정책이 먼저 양자화해 같은 거리의 반복 평가가
// draw-local 채널 변경이나 그림자 캐시 무효화를 만들지 않는다.
export const CHUNK_LOD_TRANSITION_STEPS = 127;

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
    transitionWidth: bowlR * VILLAGE_CHUNK_LOD.transitionWidthFactor,
    // 하위호환: 기존 소비자의 swap 경계는 full-detail 경계를 뜻한다.
    swapIn: fullIn,
    swapOut: fullOut,
  };
}

function quantizedProgress(value) {
  const clamped = Math.max(0, Math.min(1, value));
  return Math.round(clamped * CHUNK_LOD_TRANSITION_STEPS) / CHUNK_LOD_TRANSITION_STEPS;
}

function setStablePresentation(state, level) {
  state.level = level;
  state.transition.active = false;
  state.transition.from = null;
  state.transition.to = null;
  state.transition.progress = 0;
  state.transition.start = 0;
  state.transition.direction = 0;
  state.weights.far = level === CHUNK_LOD_LEVEL.FAR ? 1 : 0;
  state.weights.mid = level === CHUNK_LOD_LEVEL.MID ? 1 : 0;
  state.weights.full = level === CHUNK_LOD_LEVEL.FULL ? 1 : 0;
  state.channels.far = 1;
  state.channels.mid = 1;
  state.channels.full = 1;
}

function setActivePresentation(state, from, to, progress, start, direction) {
  const fromWeight = 1 - progress;
  state.level = from;
  state.transition.active = true;
  state.transition.from = from;
  state.transition.to = to;
  state.transition.progress = progress;
  state.transition.start = start;
  state.transition.direction = direction;
  state.weights.far = 0;
  state.weights.mid = 0;
  state.weights.full = 0;
  state.channels.far = 1;
  state.channels.mid = 1;
  state.channels.full = 1;
  state.weights[from] = fromWeight;
  state.weights[to] = progress;
  // 양수(outgoing)는 낮은 IGN 부분집합, 음수(incoming)는 그 보집합을 소유한다.
  // 따라서 모든 진행도에서 픽셀 구멍·중복 없이 정확히 한 표현만 깊이를 쓴다.
  state.channels[from] = fromWeight;
  state.channels[to] = -progress;
}

export function createChunkLodPresentation(level = CHUNK_LOD_LEVEL.FAR) {
  const state = {
    level,
    transition: {
      active: false, from: null, to: null, progress: 0, start: 0, direction: 0,
    },
    weights: { far: 0, mid: 0, full: 0 },
    channels: { far: 1, mid: 1, full: 1 },
  };
  setStablePresentation(state, level);
  return state;
}

// THREE/DOM/시간에 의존하지 않는 거리 기반 상태 머신. state를 제자리 갱신해 매 프레임 할당을
// 피하고, 실제 표현 또는 screen-door 단계가 달라진 경우에만 true를 반환한다.
export function stepChunkLodPresentation(state, distance, policy) {
  if (!state || !Number.isFinite(distance)) return false;
  const width = Number.isFinite(policy?.transitionWidth) && policy.transitionWidth > 1e-6
    ? policy.transitionWidth : 1;
  const previousLevel = state.level;
  const previousActive = state.transition.active;
  const previousFrom = state.transition.from;
  const previousTo = state.transition.to;
  const previousProgress = state.transition.progress;

  // A wheel/teleport can cross both boundaries between frames. Settle completed adjacent hops in
  // this same distance sample so the final presentation is independent of callback/frame count;
  // an in-band hop still exposes exactly its adjacent pair. Three levels require at most two hops.
  for (let hop = 0; hop < 3; hop++) {
    let from = null, to = null, start = 0, direction = 0;
    if (state.transition.active) {
      ({ from, to, start, direction } = state.transition);
    } else if (state.level === CHUNK_LOD_LEVEL.FAR && distance < policy.midIn) {
      from = CHUNK_LOD_LEVEL.FAR; to = CHUNK_LOD_LEVEL.MID;
      start = policy.midIn; direction = -1;
    } else if (state.level === CHUNK_LOD_LEVEL.MID && distance < policy.fullIn) {
      from = CHUNK_LOD_LEVEL.MID; to = CHUNK_LOD_LEVEL.FULL;
      start = policy.fullIn; direction = -1;
    } else if (state.level === CHUNK_LOD_LEVEL.MID && distance > policy.midOut) {
      from = CHUNK_LOD_LEVEL.MID; to = CHUNK_LOD_LEVEL.FAR;
      start = policy.midOut; direction = 1;
    } else if (state.level === CHUNK_LOD_LEVEL.FULL && distance > policy.fullOut) {
      from = CHUNK_LOD_LEVEL.FULL; to = CHUNK_LOD_LEVEL.MID;
      start = policy.fullOut; direction = 1;
    }
    if (!from) break;
    const progress = quantizedProgress(direction < 0
      ? (start - distance) / width : (distance - start) / width);
    if (progress <= 0) setStablePresentation(state, from);
    else if (progress >= 1) setStablePresentation(state, to);
    else {
      setActivePresentation(state, from, to, progress, start, direction);
      break;
    }
  }

  return state.level !== previousLevel
    || state.transition.active !== previousActive
    || state.transition.from !== previousFrom
    || state.transition.to !== previousTo
    || state.transition.progress !== previousProgress;
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
