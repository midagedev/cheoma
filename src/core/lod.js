import { smoothstep } from './math/scalar.js';

// 지면 맥락이 필요한 생활 디테일의 기본 수직 밴드. 카메라의 절대 Y가 아니라 시선 타깃과의
// 수직차에 적용한다. 마을·단일 건물·산지 필지가 같은 전환 감각을 공유할 수 있는 가벼운 기본값이다.
export const DEFAULT_DETAIL_BANDS = Object.freeze({
  altitude: Object.freeze({ full: 38, hidden: 62 }),
  particles: Object.freeze({ full: 40, hidden: 52 }),
  particleView: Object.freeze({ full: 46, hidden: 82 }),
});

/** Smoothly keep full detail through `fullUntil`, then fade to zero at `hiddenAt`. */
export function fadeBeyond(value, fullUntil, hiddenAt) {
  if (!Number.isFinite(value)) return 0;
  if (!(hiddenAt > fullUntil)) return value <= fullUntil ? 1 : 0;
  return 1 - smoothstep(fullUntil, hiddenAt, value);
}

// 서로 다른 런타임 소유자(거리 LOD·focus handoff·wave)가 같은 표현의 최종 강도를
// 덮어쓰지 않고 곱으로 합성한다. 비정상 입력은 보이게 남기지 않고 0으로 닫는다.
export function presentationWeight(...weights) {
  let result = 1;
  for (const value of weights) {
    if (!Number.isFinite(value)) return 0;
    result *= Math.max(0, Math.min(1, value));
  }
  return result;
}

// wave가 일반 Object3D visible/material을 직접 소유하면 거리 LOD와 last-writer-wins가 된다.
// 동적 표현은 이 작은 duck-typed controller를 userData.waveFade에 달아 자기 내부에서
// detail/focus/wave 강도를 합성한다. THREE 없는 순수 계약이라 코어·검증 도구가 함께 쓴다.
export function waveFadeController(object) {
  const controller = object?.userData?.waveFade;
  return typeof controller?.setWeight === 'function' ? controller : null;
}

/** Horizontal distance without temporary vectors; useful for camera-local detail cells. */
export function distance2D(a, b) {
  if (!a || !b) return Infinity;
  const ax = Number(a.x), az = Number(a.z), bx = Number(b.x), bz = Number(b.z);
  if (!Number.isFinite(ax) || !Number.isFinite(az)
    || !Number.isFinite(bx) || !Number.isFinite(bz)) return Infinity;
  return Math.hypot(ax - bx, az - bz);
}
