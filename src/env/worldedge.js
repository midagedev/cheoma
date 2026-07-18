import { makeRng } from '../rng.js';

// 비정형(유기적) 월드 외곽선 — 씬 중심 기준 반경을 저주파 "각도 노이즈"로 변조해
// 사각/정원(正圓)이 아닌 자연스러운 해안선을 만든다. 단일 씬(env/terrain.js)과
// 마을(village/site.js)이 공유하도록 중심(cx,cz)·반경(radius)을 파라미터화한 순수
// 데이터 모듈(THREE 비의존).
//
//   makeWorldEdge({ cx, cz, radius, seed, amp, harmonics, band })
//     → { cx, cz, radius, amp, band, edgeRadiusAt(theta), edgeK(x,z) }
//   edgeRadiusAt(theta): 각도 theta(rad, atan2(dz,dx) 규약)에서의 유기적 경계 반경.
//   edgeK(x,z): 경계 안쪽 0 → 경계선에서 1 (엣지 처리 밴드 폭 = band·R). 지형 엣지
//     처리(수묵 소실·절단면·안개 링)와 필지/수목 배제 마스크가 공유하는 단일 진실원.

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// 정수 하모닉 합 각도 프로파일 — 주파수를 정수로 두면 2π 에서 이음매 없이 닫힌다
// (mountains.js 능선 프로파일과 같은 기법). 저주파(2~5)만 써서 "몇 개의 완만한 만(灣)과
// 곶(串)"이 생기고, 고주파 톱니(잘린 티)는 나오지 않는다.
function makeAngularProfile(seed, harmonics) {
  const rng = makeRng(seed >>> 0);
  const harm = [];
  let peak = 0;
  for (let o = 0; o < harmonics; o++) {
    const amp = Math.pow(0.66, o) * rng.range(0.6, 1.0);
    harm.push({ freq: 2 + o + rng.int(0, 1), amp, phase: rng.range(0, Math.PI * 2) });
    peak += amp;
  }
  return (theta) => {
    let v = 0;
    for (const h of harm) v += h.amp * Math.sin(h.freq * theta + h.phase);
    return v / peak;                    // -1..1
  };
}

export function makeWorldEdge({
  cx = 0, cz = 0, radius = 152, seed = 0x7ed9e,
  amp = 0.15, harmonics = 4, band = 0.24,
} = {}) {
  const profile = makeAngularProfile(seed, harmonics);
  // 경계 반경: 평균 radius, ±amp 로 유기적 출렁임. 곶(볼록)이 만(오목)보다 살짝 완만하도록
  // profile 을 약간 부풀린다(pow<1) — 바다로 뻗는 곶이 더 자연스럽게 읽힌다.
  const edgeRadiusAt = (theta) => {
    const p = profile(theta);
    const shaped = Math.sign(p) * Math.pow(Math.abs(p), 0.85);
    return radius * (1 + amp * shaped);
  };
  const edgeK = (x, z) => {
    const dx = x - cx, dz = z - cz;
    const r = Math.hypot(dx, dz);
    const th = Math.atan2(dz, dx);
    const R = edgeRadiusAt(th);
    return smoothstep(R * (1 - band), R, r);
  };
  return { cx, cz, radius, amp, band, edgeRadiusAt, edgeK };
}
