import { deepFreeze } from '../core/stable-seed.js';
import { makeRng } from '../rng.js';
import { terrainMeshHeightAt, streamSurfaceHeightAt } from './terrain-grid.js';

// ── 개천 호안(護岸) 계획 — #20 R4 Phase B ────────────────────────────────────
// THREE·DOM 비의존, JSON-safe. 렌더러(creek-bank-geometry.js)는 이 불변 spec 만 소비하고
//   자기 자리에서 지형·수면을 다시 풀지 않는다(계획-렌더 이중 진실 금지).
//
// 고증(docs/joseon-city.md §개천):
//   - 개천은 개착·준설된 도시 하천이고, 1773년(영조 49) 6월~8월 **개천 양안 석축** 공역이
//     "양쪽 제방에 돌을 쌓아 튼튼하게 하고, 구불구불한 수로를 곧게 바로 잡았다"
//     (서울시설공단 「영조 개천을 치다」). 즉 호안 석축은 도성 개천의 확정된 시설이다.
//   - 구한말 도성 사진 판독의 4단 단면: ① 자갈 위 얕은 물 ② **메쌓기 화강암 막돌 호안벽**
//     (줄눈 어긋남, 중간에 배수 구멍) ③ 호안 위 좁은 흙길 ④ 길에 접한 단층 기와 행렬.
//     그래서 이 계획의 도성 구간 위계는 '가공석 다듬돌'이 아니라 **막돌 메쌓기**다 — 가공석
//     (다듬은 켜쌓기)은 성벽·수문 석축의 위계이고, 호안은 그보다 한 급 아래다. 세 급 위계:
//       성벽·수문 가공석  >  도성 개천 호안 막돌 메쌓기  >  성 밖 자연석·토안.
//   - 미검증(§9.3 관례): 호안이 도성 전 구간에 연속했는지, 구간별 호안 높이의 실측값.
//     이 계획의 높이·켜 수·배수 구멍 간격은 전부 **지형 파생값**이며 고증 수치의 이식이 아니다.
//
// 위계는 site 가 소유한 개착 가중(streamUrban01At)을 그대로 쓴다. 렌더러나 이 모듈이 반경으로
//   다시 추론하면 지형 단차와 호안 위계가 어긋난다.

export const CREEK_BANK_PLAN_SCHEMA_VERSION = 1;

export const CREEK_BANK_LIMITS = deepFreeze({
  sampleSpacing: 4,        // m — 중심선 표본 간격(호안 리본 해상도)
  minHeight: 0.7,          // m — 이보다 낮은 둑은 석축이 아니라 자연 물가다
  // 호안 높이 상한. 구한말 사진 판독의 호안벽 높이는 1~1.5m 이고(§9.3 관례에 따라 실측이 아닌
  //   판독값), 제품 값은 그 판독 대역에 소폭 여유만 준다. 상한이 없으면 둑 상면 표본이 도성 밖
  //   산 사면까지 올라가 "호안"이 38m 짜리 옹벽이 된다(실측 2026-08-01, 상한 도입 전 2.0~39.9m).
  maxHeight: 1.8,
  // 천단(갓돌)까지 도달하는 지형을 찾는 바깥 방향 탐색. 완경사 사면에 붙는 석축이므로 벽 두께는
  //   지형이 그 높이만큼 올라오는 수평 거리이고, 시드마다 다르다.
  backStep: 0.5,           // m — 탐색 간격
  maxBack: 12,             // m — 이 안에서 못 찾으면 그 표본은 자연석·토안으로 넘긴다
  maxSamples: 640,         // 한쪽 호안 표본 상한(퇴화 방어)
  courses: 5,              // 막돌 메쌓기 켜 수(줄눈 어긋남은 켜 경계 지터로)
  courseJitter: 0.16,      // 켜 경계 높이 지터(비율) — 줄눈이 수평 일직선이 되지 않게
  faceJitter: 0.055,       // m — 켜별 면 요철(막돌 메쌓기의 들쭉날쭉한 면)
  copingDepth: 0.34,       // m — 갓돌 두께(천단 마감)
  copingOverhang: 0.13,    // m — 갓돌이 면보다 하도 쪽으로 내미는 양
  embed: 0.5,              // m — 하상 아래로 묻는 기초 깊이
  weepSpacing: 26,         // m — 배수 구멍 평균 간격(사진 판독의 "중간에 배수 구멍")
  weepSize: 0.42,          // m — 배수 구멍 한 변
  weepRecess: 0.16,        // m — 배수 구멍 함몰 깊이
  naturalStoneSpacing: 7,  // m — 성 밖 자연석 물가돌 평균 간격
  naturalStoneRadius: 0.46, // m — 자연석 기준 반경
  // 이 값 이상이면 석축 호안, 이 값 이하면 자연석·토안. 사이 구간은 두 위계가 이어지도록
  //   석축을 계속 세우되 높이가 자연히 줄어든다(지형 단차 자체가 완만해지므로).
  revetmentUrban01: 0.5,
});

const clamp01 = (value) => Math.min(1, Math.max(0, value));

// 중심선 접선에서 만든 바깥 법선(하도 밖 방향). site.stream.pts 는 x 단조 증가다.
function normalAt(pts, index) {
  const a = pts[Math.max(0, index - 1)];
  const b = pts[Math.min(pts.length - 1, index + 1)];
  const tx = b.x - a.x, tz = b.z - a.z;
  const length = Math.hypot(tx, tz) || 1;
  return { x: -tz / length, z: tx / length };
}

/**
 * 개천 양안 호안 계획. 개착 하천(도성 개천)만 대상이다 — 농촌 개울은 이 라운드 이전과 같이
 * 자연 물가로 남는다(다른 규모의 형상·드로우콜 불변이 그 증거).
 */
export function planCreekBanks(site) {
  const L = CREEK_BANK_LIMITS;
  const empty = deepFreeze({
    version: CREEK_BANK_PLAN_SCHEMA_VERSION,
    urban: false, runs: [], stats: { samples: 0, revetment: 0, natural: 0 },
  });
  if (!site?.stream?.urban || !site.stream.pts?.length) return empty;
  if (!site.streamValleyFlatHalfAt || !site.streamBankTopHalfAt || !site.streamUrban01At) return empty;

  const pts = site.stream.pts;
  const x0 = pts[0].x, x1 = pts[pts.length - 1].x;
  const span = x1 - x0;
  const steps = Math.min(L.maxSamples, Math.max(2, Math.round(span / L.sampleSpacing)));
  const runs = [];
  let sampleCount = 0, revetmentCount = 0, naturalCount = 0;

  for (const side of [-1, 1]) {
    // 시드는 side 를 포함해 양안이 같은 요철을 거울처럼 반복하지 않게 한다.
    const rng = makeRng(((site.seed ^ 0x0cee2b) + (side > 0 ? 7717 : 3313)) >>> 0);
    let open = null;
    const closeRun = () => {
      if (open && open.points.length >= 2) {
        runs.push(open);
        if (open.rank === 'seokchuk') revetmentCount += open.points.length;
        else naturalCount += open.points.length;
      }
      open = null;
    };
    for (let i = 0; i <= steps; i++) {
      const x = x0 + span * (i / steps);
      const centerZ = site.streamZat(x);
      const faceHalf = site.streamValleyFlatHalfAt(x);
      const topHalf = site.streamBankTopHalfAt(x);
      const urban01 = clamp01(site.streamUrban01At(x));
      // 법선은 중심선 폴리라인에서 뜬다(해석 접선 근사는 사행 굽이에서 어긋난다).
      const index = Math.round((x - x0) / Math.max(1e-6, span) * (pts.length - 1));
      const normal = normalAt(pts, Math.min(pts.length - 1, Math.max(0, index)));
      const faceX = x + normal.x * side * faceHalf;
      const faceZ = centerZ + normal.z * side * faceHalf;
      const toeY = terrainMeshHeightAt(site, faceX, faceZ);
      // 천단은 지형이 maxHeight 만큼 올라오는 첫 지점이다 — 그래서 이 호안은 수직 옹벽이 아니라
      //   완경사 둑에 붙는 석축이고, 두께(back 까지의 거리)는 그 사면의 기울기가 정한다. 12m 안에서
      //   그 높이를 못 채우는 표본은 애초에 석축을 세울 둑이 없다는 뜻이라 자연석·토안으로 넘긴다.
      const target = toeY + L.maxHeight;
      let backOffset = faceHalf, topY = toeY, backX = faceX, backZ = faceZ;
      for (let step = L.backStep; step <= L.maxBack; step += L.backStep) {
        const offset = faceHalf + step;
        if (offset > topHalf) break;
        const px = x + normal.x * side * offset;
        const pz = centerZ + normal.z * side * offset;
        const py = terrainMeshHeightAt(site, px, pz);
        backOffset = offset; backX = px; backZ = pz; topY = py;
        if (py >= target) break;
      }
      const height = Math.min(topY, target) - toeY;
      topY = toeY + height;
      const rank = urban01 >= L.revetmentUrban01 && height >= L.minHeight ? 'seokchuk' : 'natural';
      if (!open || open.rank !== rank) { closeRun(); open = { side, rank, points: [] }; }
      open.points.push({
        // 중심선 표본 위치도 함께 싣는다 — 수면 표고는 중심선 기준이라 소비자·계약이 같은 입력으로
        //   재현할 수 있어야 한다(면 좌표로 다시 풀면 사행만큼 어긋난다).
        cx: x, cz: centerZ,
        x: faceX, z: faceZ,
        nx: normal.x * side, nz: normal.z * side,
        backX, backZ, backOffset,
        toeY, topY,
        waterY: streamSurfaceHeightAt(site, x, centerZ),
        // 켜·면 요철·배수 구멍은 계획이 결정한다 — 렌더러가 자기 rng 를 돌리면 재현되지 않는다.
        jitter: rng() * 2 - 1,
        weep: rng(),
      });
      sampleCount++;
    }
    closeRun();
  }

  return deepFreeze({
    version: CREEK_BANK_PLAN_SCHEMA_VERSION,
    urban: true,
    limits: L,
    runs,
    stats: { samples: sampleCount, revetment: revetmentCount, natural: naturalCount },
  });
}
