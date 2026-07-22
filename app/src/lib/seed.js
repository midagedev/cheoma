// 씨앗(seed) → 결정적 마을 설정. 같은 seed 는 항상 같은 건물·환경을 재현한다
// (?seed= 공유 시 동일 결과). main.js 의 surpriseMe 큐레이션을 계승하되 Date.now 대신
// seed 로 완전히 결정적으로 만든다.
import { PRESETS } from '../../../src/api/building.js';
import {
  DEFAULT_SUNSET_LOOK,
  SUNSET_LOOK_IDS,
  pickEnvironmentScene,
} from '../../../src/api/environment.js';

// 유형 탭 ↔ 프리셋 키 매핑. (궁=korea, 절=temple, 기와집=giwa, 초가=choga)
export const TYPES = [
  { key: 'korea', label: '궁', sub: '전각' },
  { key: 'temple', label: '절', sub: '불전' },
  { key: 'giwa', label: '기와집', sub: '반가' },
  { key: 'choga', label: '초가', sub: '민가' },
];

// 플래그십 첫인상 기본 시간대(골든아워 역광 = 메인 룩). 신선 방문(seed·time 파라미터
// 모두 없음)에만 강제한다 — 공유된 ?seed 링크는 시드에서 파생된 시간대를 그대로 재현.
// NOTE: 코어가 기본 시간대를 export 하면(task #25 역광 기본 뷰) 그 값을 읽도록 교체할 것.
export const FLAGSHIP_TIME = 'sunset';

export function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function weightedPick(rng, pairs) {
  const tot = pairs.reduce((s, p) => s + p[1], 0);
  let r = rng() * tot;
  for (const [val, w] of pairs) { if ((r -= w) <= 0) return val; }
  return pairs[pairs.length - 1][0];
}

// 6자리대 표시용 씨앗 생성 (URL·라벨에 예쁘게). 32bit 부호없는 정수.
export function newSeed() {
  return (Date.now() ^ (Math.random() * 1e9)) >>> 0;
}

// seed → { preset, time, sunsetLook, season, weather, params }. params 는 프리셋 복사 + 미세 지터.
export function configFromSeed(seed) {
  const rng = mulberry32(seed >>> 0);

  const presetPairs = [['korea', 3], ['temple', 2]];
  if (PRESETS.choga) presetPairs.push(['choga', 1.6]);
  if (PRESETS.giwa) presetPairs.push(['giwa', 1.2]);
  const preset = weightedPick(rng, presetPairs);

  // Keep the legacy three environment draws on the main stream so building parameter
  // hashes remain stable. A fork selects one complete, compatible, curated scene.
  weightedPick(rng, [['day', 4], ['sunset', 3], ['dawn', 2], ['night', 1.5]]);
  weightedPick(rng, [['autumn', 3], ['spring', 2.2], ['summer', 2]]);
  weightedPick(rng, [['clear', 4], ['snow', 2.2], ['rain', 1.8]]);
  const environmentRng = mulberry32((seed ^ 0xe1710f) >>> 0);
  const environment = pickEnvironmentScene(environmentRng);
  let time = environment.ti;

  // A separate fork keeps a latent sunset look for non-sunset scenes.
  const sunsetRng = mulberry32((seed ^ 0x51a7e7) >>> 0);
  const latentSunsetLook = weightedPick(sunsetRng, [
    [DEFAULT_SUNSET_LOOK, 5],
    [SUNSET_LOOK_IDS[1], 2.8],
    [SUNSET_LOOK_IDS[2], 2.2],
  ]);
  const sunsetLook = environment.su || latentSunsetLook;
  const season = environment.se;
  const weather = environment.we;
  if (weather === 'rain' && time === 'dawn') time = 'day';
  if (weather === 'rain' && time === 'night') time = 'sunset';

  const params = paramsFor(preset, rng);
  return { preset, time, sunsetLook, season, weather, params };
}

// 프리셋 파라미터 복사 + 정체성을 지키는 ±6% 지터(giwa 는 L 전용이라 지터 생략).
export function paramsFor(preset, rng = mulberry32(1)) {
  const P = { ...PRESETS[preset] };
  if (preset === 'giwa') return P;
  const jit = (k, lo, hi) => {
    if (typeof P[k] !== 'number') return;
    P[k] = Math.min(hi, Math.max(lo, P[k] * (1 + (rng() * 2 - 1) * 0.06)));
  };
  jit('columnHeight', 2.6, 5.5); jit('roofPitch', 0.4, 0.95); jit('profileCurve', 0, 1);
  jit('cornerLift', 0, 1.6); jit('planCurve', 0, 1.2); jit('eaveOverhang', 1.0, 3.0);
  jit('entasis', 0, 1);
  if (rng() < 0.4) P.frontBays = Math.min(9, Math.max(3, P.frontBays + (rng() < 0.5 ? -2 : 2)));
  return P;
}
