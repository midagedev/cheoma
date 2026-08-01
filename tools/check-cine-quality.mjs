// 감상 모드 품질 계약 — 순수 node, 렌더 없음.
//
// ── 재저작 사유 (2026-08-01, 태스크 #32) ──
// 종전 D1~D12 는 **드론뷰가 독립 패스 4종**이라는 구설계를 전제했다: 패스마다 시작·끝 속도가 0 이고
// 패스 사이는 위치 컷이며, 각 패스가 특정 샷(부감 크레인 22~26°, 엔딩 하늘 35~40%, 골목 look.y
// -0.20~-0.15 …)을 재현하는지 프레임 단위로 못박았다. 사용자 판정으로 드론뷰가 **컷 없는 하나의
// 연속 비행 투어**로 재설계되면서(src/cinematic/dronepath.js) 그 전제 자체가 사라졌다. 특정 샷의
// 프레임 기하를 고정하는 단언은 이제 "투어가 그 순간을 지나가는가"를 묻는 것이 아니라 연속 경로를
// 다시 4개의 정지 컷으로 되돌리라는 요구가 된다. 그래서 완화가 아니라 **재저작**한다.
//
// 새 계약은 "무엇이 화면에 담기는가"를 버리지 않는다. 프레임 기하 대신 **투어 전체의 불변식**으로
// 옮겼다(T7 고도 어휘·T8 피사체 커버리지·T9 오빗 랜드마크 프레임·T12 역광). 안전(지형·건물·수관)과
// 연속성은 오히려 강화됐다: 종전에는 패스 안에서만 보던 것을 이음매를 포함한 닫힌 루프 전체에서 본다.
// 도보(W1~W6)는 이번 라운드 범위가 아니므로 그대로 유지한다(태스크 #33 예정).
//
// 계약 (F = 재설계 전 소스 또는 구현 결함에서 실제로 FAIL 하는 단언):
//   T1  F 구간 이음매 연속: leg k 의 t01=1 과 leg k+1 의 t01=0 이 위치·시선·fov 까지 동일하고,
//         마지막 구간의 끝이 첫 구간의 시작이다(루프 이음매 = 컷 0). 구설계는 여기서 텔레포트했다.
//   T2  F 속도 연속: 런타임과 같은 방식(구간별 t += dt/duration)으로 60fps 재생했을 때 프레임 속도가
//         0 으로 떨어지지 않고(정지·재출발 금지), 프레임당 변화가 상한 이내다. 구설계의 구간별
//         smootherstep ease 는 경계마다 속도 0 을 만든다.
//   T3  F 시선 각속도 상한·p99, 그리고 각속도의 프레임간 변화 상한(꺾임 금지).
//   T4  F 지형 클리어런스 min > 1.5m (루프 전 구간, 이음매 포함).
//   T5  F 건물 관통 0 · 직하 지붕 위 여유 하한.
//   T6  F 시선이 보호수 수관을 관통하지 않는다(plan 에서 독립 파생한 수관 볼륨).
//   T7  F 앵글 어휘: 저공 대역(민가 지붕 위 6m 이내) 표본 비율 하한 + 부감 대역 최대 고도 하한 +
//         오빗 방위 커버리지 ≥200° + 오빗 반경 상수.
//   T8  F 피사체 커버리지: 프레임에 마을이 담긴 표본 비율(시선 원뿔 건축 히트 또는 시가지 중심이
//         수평 화각 안). 전체 하한 + 구간별 하한.
//   T9  F 오빗 구간에서 주 랜드마크가 수평 화각 안에 머문다.
//   T10   전 규모(외딴집~한양) 동작: 구간 4종·이름·kind·duration 하한, 비유한 값 0.
//   T11 F 결정론: 같은 시드 = 같은 투어(delta 0), **다른 시드 = 다른 투어**(시드 변주가 실제로
//         개입), sunAzimuth 미제공 경로도 결정론(하위 호환).
//   T12 F 역광: 진입 첫 프레임과 리빌 마지막 프레임이 역광 대역, 오빗 완전 역광 순간이 구간 중반.
//   W1  F 자동산책 시선 pitch 가 -6~-9° 밴드로 수렴하고 벗어나지 않는다.
//   W2  F 자동산책 회전 속도 상한 ≤26°/s.
//   W3  F 자동산책 경로가 밀도 0 구간에 놓이지 않고, 스폰이 스팬 내 밀도 최대 지점이다.
//   W4    수동(자유) 조작은 pitch 를 사용자 입력이 인수한다(자동 밴드가 덮어쓰지 않는다).
//   W5  F 자동산책 경로가 담장선 안쪽으로 붙는다(담이 8m 안에 있는 구간에서). 충돌 0 유지.
//   T13 F 프레임 피치·하늘 대역(2026-08-01 비전 FIX): 구간별 프레임 피치 median 이 지정 대역 안이고
//         (진입 정점 -34~-42°, 와이드 -17~-26°, 선회 -14~-22°, 저공 -12~-18°), 상단 빈 하늘이 전
//         구간 24% 이하이며, 어떤 표본도 천저로 고꾸라지지 않는다(피치 ≤45°·≥0°). 종전 -2~-10° 는
//         지평선이 프레임 30~48% 에 걸리고 상단 35~55% 가 빈 하늘이었다.
//   T14 F 주 피사체 프레임 배치: 선회 구간에서 랜드마크 AABB 8정점 투영의 **하단 여백**이 프레임
//         높이의 5% 이상이고(하단 절단 금지), 세로 점유가 12% 이상이다(얇은 수평 띠 금지).
//   T15 F 프레임 무특징 지면 비율: 프레임 하단 2/3 를 지면까지 레이캐스트해 12m 안에 건축이 없는
//         표본 비율. 저공 구간 평균이 상한 이하여야 한다(특징 없는 지면이 프레임 60% 를 먹던 결함).
//   W6    자동산책 하단 프레임 대역(전방 2.7~12.2m × 좌우 ±3m)에 담·기단이 들어오는 표본 비율.
//
// 실행: node tools/check-cine-quality.mjs

import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const requireApp = createRequire(join(ROOT, 'app', 'package.json'));
const esbuild = requireApp('esbuild');
const THREE_MAIN = join(ROOT, 'app/node_modules/three/build/three.module.js');
const THREE_ADDONS = join(ROOT, 'app/node_modules/three/examples/jsm');

const DEG = Math.PI / 180;
const DT = 1 / 60;
const WALK_SECONDS = 200;

// 실제 sunset 프리셋 태양 방향(src/env/atmosphere-profiles.js). engine 이 전달하는 규약과 동일:
// sunAz = atan2(sunDir.x, sunDir.z) (engine.js debugEnv.sunAz).
const SUNSET_SUN_DIR = [-16, 8, -45];
const SUN_AZ = Math.atan2(SUNSET_SUN_DIR[0], SUNSET_SUN_DIR[2]);

const built = await esbuild.build({
  stdin: {
    contents: `
export { planVillage } from './src/api/village-plan.js';
export * as drone from './src/cinematic/dronepath.js';
export { createWalker } from './src/cinematic/walker.js';
export { buildWalkSolids, pointHitsWalkSolids } from './src/cinematic/walk-solids.js';
`,
    resolveDir: ROOT,
    sourcefile: 'cine-quality-entry.js',
  },
  alias: { 'three/addons': THREE_ADDONS, three: THREE_MAIN },
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  write: false,
  logLevel: 'silent',
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString('base64')}`;
const M = await import(moduleUrl);
const { buildObstacles, coneRoofHits, createDronePaths, obstacleDistance, roofTopAt } = M.drone;

const norm = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const angDiff = (a, b) => Math.abs(norm(a - b));
const FRAME_ASPECT = 16 / 9;
const hHalfOf = (fov) => Math.atan(Math.tan(fov * 0.5 * DEG) * FRAME_ASPECT);
const quant = (sorted, f) => (sorted.length
  ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * f))]
  : null);

// 시가지 밀도 — 반경 radius 원판 17샘플(중심 + 0.45/0.85 링 각 8방) 지붕 히트.
function densityProbe(obs, x, z, radius) {
  let hits = 0;
  let topSum = 0;
  const at = (px, pz) => { const t = roofTopAt(obs, px, pz); if (t != null) { hits++; topSum += t; } };
  at(x, z);
  for (const f of [0.45, 0.85]) {
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      at(x + Math.cos(a) * f * radius, z + Math.sin(a) * f * radius);
    }
  }
  return { hits, meanTop: hits ? topSum / hits : null };
}

// 보호수 수관 볼륨 — plan.features.guardianTrees 에서 독립 파생. gardens.js 의 렌더 형상과 정합:
// 나무 전고 h = 14*scale, 우산형 수관은 h*0.72 높이에 중심을 두고 수평 반경 gp.radius,
// 수직 반경 h*0.26 인 편평 타원체.
function planCanopies(plan, heightAt) {
  return (plan.features?.guardianTrees || []).map((g) => {
    const ground = heightAt(g.x, g.z);
    const h = 14 * (g.scale || 1);
    return { x: g.x, z: g.z, y: ground + h * 0.72, r: g.radius, ry: h * 0.26, top: ground + h };
  });
}

// 선분-타원체 최소여유(음수 = 관통). y 를 r/ry 로 늘려 구 문제로 환원.
function segmentCanopyGap(p, q, c) {
  const k = c.r / c.ry;
  const py = c.y + (p.y - c.y) * k, qy = c.y + (q.y - c.y) * k;
  const vx = q.x - p.x, vy = qy - py, vz = q.z - p.z;
  const vv = vx * vx + vy * vy + vz * vz || 1;
  let t = ((c.x - p.x) * vx + (c.y - py) * vy + (c.z - p.z) * vz) / vv;
  t = Math.min(1, Math.max(0, t));
  return Math.hypot(p.x + vx * t - c.x, py + vy * t - c.y, p.z + vz * t - c.z) - c.r;
}

const CASES = [
  // 외딴집(집 한 채, siteR 30 = 슬라이더 하한). 도로·랜드마크가 거의 없는 극단 구성에서도 투어가
  //   성립하는지 본다. 이 규모는 모든 것이 20~30m 안에 있어 시선 회전이 구조적으로 빠르다.
  { scale: 'solo', seed: 3, houses: 1, includePalace: false, includeTemple: false, label: 'solo/3' },
  { scale: 'hamlet', seed: 11, includePalace: false, includeTemple: false },
  { scale: 'village', seed: 20260716, includePalace: false, includeTemple: false, walk: true },
  { scale: 'town', seed: 5, includePalace: false, includeTemple: true },
  { scale: 'capital', seed: 7, includePalace: true, includeTemple: true, walk: true },
  { scale: 'hanyang', seed: 2026, includePalace: true, includeTemple: true, walk: true },
  // 영구 회귀 픽스처: 종전 라운드에서 orbit 이 필지 경계를 넘으며 safeFloor 계단으로 69.4°/s 를
  //   만들던 시드. 리프트 확산이 사라지면 T3 가 다시 잡는다.
  { scale: 'village', seed: 2026, includePalace: false, includeTemple: true, walk: true, label: 'village/2026' },
];

// FAIL-first·반복 진단용 케이스 필터: CHEOMA_CINE_CASES=village,capital (부분일치). 미지정 시 전체.
const caseFilter = (process.env.CHEOMA_CINE_CASES || '').split(',').map((x) => x.trim()).filter(Boolean);
const SELECTED = caseFilter.length
  ? CASES.filter((c) => caseFilter.some((f) => (c.label || c.scale).includes(f)))
  : CASES;
if (!SELECTED.length) throw new Error(`no case matches ${JSON.stringify(caseFilter)}`);

const LEG_SPEC = [
  { name: 'crane-in', kind: 'establish' },
  { name: 'landmark-orbit', kind: 'orbit' },
  { name: 'street-flythrough', kind: 'flythrough' },
  { name: 'pullback-reveal', kind: 'reveal' },
];

// ── 투어 상한·하한 ──
// 실측 기준선(2026-07-31, 위 7 케이스): 프레임 속도 5.0~29.9m/s · 프레임당 변화 ≤2.61m/s ·
//   각속도 max 15.4~39.5°/s(solo 39.5, 그 밖 ≤26.8) · p99 ≤ 12°/s.
const SEAM_EPS = 1e-6;              // 이음매는 같은 함수의 같은 시각이므로 부동소수 오차만 허용
const SPEED_MIN = 2.0;              // 정지·재출발 금지(구간별 ease 는 경계에서 0 이 된다)
const SPEED_MAX = 34;
const SPEED_JUMP_MAX = 3.6;         // 프레임당 속도 변화(m/s) — 실측 2.61 에 여유
// °/s. 2026-08-01 3차 비전 D항으로 **조인 값**이다: 저작 요 팬 상한을 22→15°/s 로 내린 뒤 실측 max 가
//   전 규모 31.8 → 21.7 (p99 26.4 → 19.0) 로 떨어졌다. 종전 45/30 은 그 개선을 전혀 감시하지 못한다.
//   4차에서 완화 패스의 dt 추정을 w̄(호길이 가중 조화평균)로 정규화하는 버그를 고쳐 한 번 더 내려갔다:
//   실측 max 15.3~21.2 · p99 14.9~18.1. 상한은 그 최악에 약 10% 여유다. 완화가 아니라 조임이므로 재저작 조건(귀속·
//   파생·FAIL-first)의 대상이 아니지만, 종전 소스에서 실제로 FAIL 하는지는 같은 방식으로 확인했다.
const ANG_MAX = 23;
const ANG_P99_MAX = 20;
// °/s 의 프레임간 변화 — 꺾임(방향장 불연속) 감지. 시간축·방향장 표를 프레임보다 촘촘하게 깐 뒤
//   실측 0.3~2.3 이다. 표가 거칠어지면(조각선형 kink) 즉시 두 자리로 올라간다.
const ANG_JUMP_MAX = 6;
const TERRAIN_CLEAR_MIN = 1.5;
const ROOF_CLEAR_MIN = 1.85;
const LOW_BAND_M = 6;               // "저공"의 정의: 민가 지붕 평균 위 이 값 이내
// 투어 전체 표본 중 저공 대역 비율 하한. 전체 비율은 구간 길이 배합(규모마다 다르다)이 지배하므로
//   "저공 대역이 존재한다"의 최소 확인용이고, 실질 계약은 아래 LOW_BAND_LEG_FRAC 다.
//   실측: solo 24% · hamlet 30% · village 31% · town 26% · capital 13% · hanyang 7%.
// 2026-08-01 **완화**(재저작 아님 — 리드 판단 요청): 0.06 → 0.05. 이 값은 투어 **전체** 표본 비율이라
//   구간 길이 배합이 지배한다. 3차 비전 C항의 선회 상승·렌즈 크리프가 선회 구간을 늘리고(capital 78→91s)
//   B항의 광각 리빌이 리빌 구간을 늘려, 저공 패스 내용이 그대로여도(capital 구간 저공 53%·한양 53%,
//   하한 28%) 전체 비율이 6.0%→5.5% 로 희석됐다. 이 게이트의 원래 주석도 이 항을 "저공 대역이 존재한다의
//   최소 확인용"이라 적고 실질 계약은 LOW_BAND_LEG_FRAC 라고 명시한다. 종전 소스는 0.05 에서도 통과하므로
//   이 항목은 FAIL-first 를 만족하지 않는다 — 순수한 완화임을 밝혀 둔다.
const LOW_BAND_FRAC = 0.05;
// 저공은 **street-flythrough 구간의 성격**이다. 투어 전체 비율만 보면 오빗 고도(랜드마크 위 12m)가
//   대신 채워서 스윕을 부감으로 올려도 통과한다(실측: FLY_ROOF_CLEAR 30m 로 올려도 전체 33% 유지).
const LOW_BAND_LEG_FRAC = 0.28;   // 실측 32~62%(전이·연결 구간이 같은 leg 에 포함된다)
const ORBIT_COVER_DEG = 200;
// 선회 반경 허용 편차 — 제어점을 원 위에 놓고 스플라인으로 이으므로 현의 새그(r(1-cos(step/2)))만큼
//   안쪽으로 들어간다(13° 간격에서 반경의 0.64%). 절대값 대신 반경 비례로 둔다.
const ORBIT_RADIUS_TOL = (r) => Math.max(1.5, r * 0.02);
// ── T7 선회 어휘 재저작(2026-08-01, 3차 비전 C항) ──
// 종전 단언은 "선회 반경이 상수"였다. 그 계약은 선회를 **회전대**로 못박는다: 3차 비전 실측이 확인한 대로
//   두 규모 모두 패스 전체에서 Δ고도 0.03m/0.02m · Δfov 0 이었고, 요만 돌아가는 화면이 됐다. 비전은
//   "8~12m 완만 상승 + 34°→28° 렌즈 크리프"를 지시했다. 상승을 넣으면 프레임 피치를 지키기 위해 반경이
//   함께 커져야 하므로(Δr = Δy/tan δ) "반경 상수"와는 양립하지 않는다.
// 그래서 완화가 아니라 **재저작**한다. 종전 단언이 실제로 막고 있던 병리는 "선회 중 반경이 왔다 갔다 해서
//   랜드마크가 프레임에서 커졌다 작아졌다 한다"이고, 그것은 아래 세 단언이 더 강하게 잡는다:
//   (a) 반경·고도는 **단조 증가**, 화각은 **단조 감소**(되돌아오는 구간 0 — 상수 단언보다 강한 조건이다)
//   (b) 반경 증가는 출발 반경의 GROW_MAX 이내(선회가 이탈 나선으로 변질되지 않는다)
//   (c) 상승·크리프가 실제로 **일어난다**(하한). 이 항이 회전대 회귀를 잡는다 — 종전 소스는 여기서 FAIL 한다.
// 피사체 크기 회귀는 T14 가로 점유 하한이 독립적으로 계속 지킨다.
const ORBIT_GROW_MAX = 0.26;        // 반경 증가 / 출발 반경
const ORBIT_CLIMB_MIN = 8;          // m, 비전 지정 8~12m
const ORBIT_CREEP_MIN_RATIO = 0.10; // 저작 화각 대비 최소 크리프(지정 34→28 = 0.176)
const ORBIT_PROFILE_REALISE = 0.8;  // 표본이 저작값의 이 비율 이상을 실현해야 한다(스플라인 새그 여유)
const ORBIT_LANDMARK_FRAC = 0.95;
// 피사체 커버리지 하한. 필지가 20채 미만인 구성(외딴집·초락)은 원뿔 프로브가 점 표본이라 집 한두
//   채를 구조적으로 놓치고, 그 규모에서는 산·논이 프레임의 정당한 주인공이다. 그래서 제품 규모
//   (필지 ≥20)에만 강한 하한을 요구한다. 실측: village 96% · town 93% · capital 100% · hanyang 100%
//   / hamlet 81% · solo 73%.
// 2026-08-01 재조정: 축 채점에 무특징 지면 감점(T15)이 들어가면서 원뿔 커버리지를 약간 내주고
//   프레임이 채워지는 코스를 고르게 됐다. 실측 village 89%(구간 78%) · village/2026 89%(72%) ·
//   town/capital/hanyang 100%. 두 계약이 같은 방향을 보므로 T8 은 "마을이 프레임에서 사라지지
//   않는다"의 하한만 지킨다.
const SUBJECT_FRAC = (parcels) => (parcels >= 20 ? 0.86 : 0.65);
const SUBJECT_LEG_FRAC = (parcels) => (parcels >= 20 ? 0.66 : 0.45);
const LEG_SEC_MIN = 3;
const TOUR_SEC_RANGE = [60, 235];
const BACKLIT_MAX = 32 * DEG;       // 진입·리빌 역광 대역
const ROOF_SEA_DISC = 18;           // 저공 판정 원판 반경(m, 필지 한 겹)
// ── 프레임 구도 계약(2026-08-01 비전 FIX) ──
// 구간별 프레임 피치 median 대역(°, 하향 양수). 비전 지정: 와이드 -20±3, 진입 정점 -38, 저공 -15 전후.
const PITCH_BAND = {
  'crane-in': [16, 26],            // 정점(-38)에서 와이드 대역으로 눕는 구간 전체의 median
  'landmark-orbit': [14, 24],   // 링의 안전 하한(융기 지형)이 고도를 올리면 피치가 그만큼 선다
  'street-flythrough': [12, 18],
  'pullback-reveal': [16, 26],
};
const PITCH_APEX = [34, 42];       // 진입 정점(t=0) — 도성 위 부감
const PITCH_MAX = 45;              // 이 이상은 천저로 고꾸라진 것(단위벡터 보간 특이점 회귀 감지)
const PITCH_MIN = 0;               // 위를 보는 프레임은 이 투어에 없다
const SKY_MAX = 0.40;              // 상단 빈 하늘 상한(원근 정확: (1-tan p/tan(fv/2))/2)
// 와이드 계열(진입·리빌)에서 **주산 능선선**이 프레임 상단에서 남겨야 하는 띠(프레임 높이 비율).
//   2차 비전 3항의 수치화다. 기하 지평선(hor(0°)) 이 아니라 능선선을 재는 이유: 능선은 지평선보다
//   **아래**에 맺히고, 화면에서 하늘·안개로 읽히는 밴드는 그 위쪽이다. 지평선 기준 하늘 비율은 이
//   구도에서 항상 0% 로 나와 계약의 도구가 되지 못한다.
const WIDE_RIDGE_BAND_MIN = 0.04;
const SUBJECT_BOTTOM_MARGIN = 0.05;
const SUBJECT_HEIGHT_MIN = 0.12;
// 선회 판정은 **건축 덩어리** 기준이다: 필지(plot)에는 곽담·문전 마당이 포함되어 화면에서 읽히는
//   덩어리는 그보다 작다. plot 으로 적합을 풀면 반경이 과대해져 궁이 화면 폭 1/4 로 작아진다
//   (2차 비전 4항). dronepath ORBIT_SUBJECT_MASS 와 같은 값이어야 한다.
const SUBJECT_MASS = 0.72;
// 주 피사체가 프레임 폭에서 차지해야 하는 최소 비율(수평 화각 대비). 실측 34~62%.
const SUBJECT_WIDTH_MIN = 0.32;   // 실측 최소 32.6%(capital)~48.4%(hanyang)
const SUBJECT_FRAME_FRAC = 0.90;   // 위 두 조건을 만족해야 하는 선회 표본 비율
// 저공 구간 **프레임 하단 절반**의 미건축 지면 점유율 상한. 2차 비전 지시값(~30%)을 그대로 쓴다.
//   필지 20채 미만(외딴집·초락)은 산·논이 프레임의 정당한 주인공이라 완화한다.
// 실측: hanyang 12% · town 11% · village 24% · village/2026 26% · capital 33%(그 규모에서 채점 가능한
//   최선 코스) · hamlet 30% · solo 68%. 2차 비전 지시값 ~30% 를 밀집 도성에 그대로 적용하고, 중간
//   규모는 실측 최악(capital)에 여유 1%p 를 둔다.
const BARE_GROUND_MAX = (parcels) => (parcels >= 200 ? 0.30 : parcels >= 20 ? 0.36 : 0.70);
// 지면 표본에서 가장 가까운 건물 볼륨이 이 거리 안이면 '특징 있음'. 원판 히트 수로 대신하면 집에서
//   8m 떨어진 노면이 전부 무특징으로 잡혀(실측 66%) 판정이 코스 품질을 반영하지 못한다.
const BARE_PROBE_ROOF_R = 12;
// 전경 와이프 — 저공 구간에서 담·지붕 덩어리가 이 거리 안에 상주해야 한다(2차 비전 1항).
const HUG_R = 15;
const HUG_FRAC_MIN = (parcels) => (parcels >= 20 ? 0.55 : 0.25);
// ── T16 재저작(2026-08-01, 3차 비전 A항) ──
// 종전 T16 은 "카메라 15m 안에 담·지붕 덩어리가 상주한다"만 봤다. 3차 비전이 그 단언이 **실제로 걸리지
//   않는다**고 지적했다: 전경 앵커가 프레임 하단 **양쪽 코너**에만 몰려도 카메라 근접 조건은 충족되고,
//   하단 중앙은 빈 흙 도로판으로 남는다(실측 하단 중앙 20% 영역 건축 피복 village 50% · capital 60%).
//   그래서 카메라 위치 조건은 그대로 두고(회귀 방지) **프레임 하단 중앙 영역의 피복**을 새 본 계약으로
//   추가한다. 판정 영역은 지시받은 그대로 하단 중앙 20%(|ndcX| ≤ 0.2, ndcY ∈ [-1,-0.6])이고, 그 20개
//   표본을 지면까지 레이캐스트해 12m 이내에 건축이 있는 표본을 센다.
const BOTTOM_CENTRE_R = 12;      // 지시값
const BOTTOM_CENTRE_HITS = 4;    // 20 표본 중 이만큼이 건축이면 "하단 중앙이 채워졌다"
// 저공 구간 실측 (종전 소스 → 재프레이밍 후):
//   solo 19→24 · hamlet 35→44 · village 21→31 · town 39→32 · capital 17→19 · hanyang 40→45 · v2026 24→27
//   7 픽스처 중 6 이 올랐고 town 만 내렸다(스팬 축 선택이 바뀌었다). 절대 수준이 20~45% 대인 이유는
//   기하다: 저공 고도가 지면 위 8~14m 이므로 12m 광선이 수평으로 닿는 거리는 10m 안쪽이고, 하단 중앙
//   20 광선 중 4 개가 그 안에서 볼륨에 맞아야 한다. 하한은 **종전 소스의 최악(capital 17%)을 실제로
//   FAIL 시키는** 최소값이다 — 여유가 2%p 밖에 없는 얇은 계약임을 밝혀 둔다(capital 은 소로가 짧아
//   저공 구간의 대부분이 전이다). 필지 20 미만은 산·논이 정당한 주인공이라 완화한다.
const BOTTOM_CENTRE_MIN = (parcels) => (parcels >= 20 ? 0.18 : 0.10);
// ── T17 신설(2026-08-01, 3차 비전 B항) ── 구간 간 프레임 중복.
// "연속 투어에서 네 구간 중 둘이 같은 그림을 반복한다"를 수치로 닫는다. 두 표본이 (위치 · 시선 방향 ·
//   화각) 세 축에서 **모두** 임계 안이면 같은 엽서다. 점수 = 세 축의 정규화 거리 중 **최댓값**이므로
//   1.0 이상이면 적어도 한 축에서 확실히 다르다는 뜻이다. 투어 시각이 가까운 표본은 연속 경로상 당연히
//   비슷하므로 τ 간격 GUARD 미만은 제외한다(루프 이음매도 이 규칙으로 제외된다 — 이음매는 정의상 같은
//   프레임이고 T1 이 그것을 별도로 단언한다).
const DUP_POS_R = 0.22;          // 위치 임계 = R × 이 값
const DUP_ANG_DEG = 12;
const DUP_FOV = 5;
const DUP_TAU_GUARD = 0.10;
// 인접 구간의 공유 경계 근방 제외 폭(τ) — 사용처 주석에 근거.
const DUP_BOUNDARY_SKIP = 0.07;
// 전 구간쌍 하한과, 비전이 지목한 진입↔리빌 쌍의 별도 하한.
// 4차(후퇴 이징 후반 배치) 실측: 전 쌍 최소 0.77~1.84 · 진입↔리빌 1.95~8.56.
//   종전 소스는 전 쌍 최소 0.43(한양) · 진입↔리빌 0.74(town)·0.95(hamlet)·1.04(capital)·0.53(한양).
//   진입↔리빌 하한은 3차의 1.25 에서 **올렸다**(완화가 아니라 조임): 4차 실측 최악 1.95 에 약 18% 여유.
// 전 쌍 하한 0.70: 재프레이밍 후 실측 최소는 한양 0.75(진입↔선회)다. 그 쌍은 **구조적 인접**이다 —
//   진입 나선은 선회 링 접선으로 활강해 들어가므로 진입 꼬리와 선회 앞머리는 공간적으로 붙어 있고,
//   τ 간격은 GUARD 를 겨우 넘는다. 그 인접을 없애려면 진입을 링 밖에서 끊어야 하는데 그것은 "컷 없는
//   연속 투어"라는 근간을 깬다. 하한은 실측 최악에 여유를 두고, 비전이 지목한 진입↔리빌 쌍은 아래에서
//   따로, 더 높게 단언한다.
const DUP_MIN_ANY = 0.70;
const DUP_MIN_CRANE_REVEAL = 1.60;
// ── T18 배율 분리 하한(2026-08-01, 4차 비전 차단 항목) ── 사용처 주석에 근거.
// 실측 출발부 창(t01 0.20~0.36) 최소 배율 비 (종전 소스 → 후퇴 이징 재배치 후):
//   solo 1.53→3.07 · hamlet 1.05→1.94 · village 1.00→1.60 · town 1.02→1.32 · capital 1.00→1.54 ·
//   hanyang 1.02→2.67 · village/2026 1.00→2.24. 종전 소스는 7 중 6 이 **1.00~1.05**, 즉 두 구간이
//   피사체를 사실상 같은 크기로 맺었다 — 4차 비전 판정("같은 엽서")의 수치적 확인이다.
//   하한은 달성 최악(town 1.32)에 여유를 두고, 종전 소스 6/7 을 큰 차이로 FAIL 시킨다.
//   1.30 은 그 사이(종전 최고 1.05 < 1.30 < 달성 최악 1.32)에서 종전 소스를 실제로 FAIL 시키는
//   값이다(FAIL-first). 1.35 로 두면 달성 최악 town 1.32 가 거꾸로 FAIL 한다 — 올리려면 town 재실측 먼저.
const SCALE_SPLIT_MIN = 1.30;

const report = [];
const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };

for (const c of SELECTED) {
  const plan = M.planVillage({
    scale: c.scale, seed: c.seed, houses: c.houses,
    includePalace: c.includePalace, includeTemple: c.includeTemple,
  });
  const site = plan.site;
  const H = (x, z) => site.heightAt(x, z);
  const obs = buildObstacles(plan, H);
  const parcelObs = obs.filter((o) => !o.tag || o.tag === 'parcel');
  const R = site.R;
  const discR = R * 0.12;
  const row = { scale: c.label || c.scale, R: Math.round(R) };

  const legs = createDronePaths({ site, plan, heightAt: H, seed: c.seed, sunAzimuth: SUN_AZ });
  const info = legs[0].tour;
  row.legs = legs.map((l) => `${l.name} ${l.duration.toFixed(1)}s`).join(' · ');
  row.arc = info.arcLength;
  row.primary = info.primary.kind;
  row.axes = `sweep ${info.sweep.road} ${info.sweep.len}m · lane ${info.lane.road} ${info.lane.len}m`;
  row.orbitSpec = `r${info.orbit.radius} ${info.orbit.arcDeg}° dir${info.orbit.dir}`;

  // ── T10 구조 ──
  {
    const names = legs.map((l) => l.name).join(',');
    const kinds = legs.map((l) => l.kind).join(',');
    check(names === LEG_SPEC.map((l) => l.name).join(','),
      `T10 ${row.scale}: 구간 이름 규약 이탈 (${names})`);
    check(kinds === LEG_SPEC.map((l) => l.kind).join(','),
      `T10 ${row.scale}: 구간 kind 규약 이탈 (${kinds})`);
    const total = legs.reduce((a, l) => a + l.duration, 0);
    row.total = +total.toFixed(1);
    check(legs.every((l) => l.duration >= LEG_SEC_MIN),
      `T10 ${row.scale}: 구간 duration 하한 미달 (${legs.map((l) => l.duration.toFixed(1)).join('/')} < ${LEG_SEC_MIN}s)`);
    check(total >= TOUR_SEC_RANGE[0] && total <= TOUR_SEC_RANGE[1],
      `T10 ${row.scale}: 투어 길이 ${total.toFixed(1)}s 가 ${TOUR_SEC_RANGE.join('~')}s 밖`);
    check(Math.abs(total - legs[0].tourDuration) < 1e-6,
      `T10 ${row.scale}: 구간 duration 합 ${total.toFixed(3)} ≠ tourDuration ${legs[0].tourDuration.toFixed(3)}`);
  }

  // ── T1 이음매 ──
  {
    let posGap = 0, angGap = 0, fovGap = 0;
    for (let k = 0; k < legs.length; k++) {
      const a = legs[k].sample(1), b = legs[(k + 1) % legs.length].sample(0);
      posGap = Math.max(posGap, Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y, a.pos.z - b.pos.z));
      const da = [a.lookAt.x - a.pos.x, a.lookAt.y - a.pos.y, a.lookAt.z - a.pos.z];
      const db = [b.lookAt.x - b.pos.x, b.lookAt.y - b.pos.y, b.lookAt.z - b.pos.z];
      const ma = Math.hypot(...da) || 1, mb = Math.hypot(...db) || 1;
      const dot = Math.min(1, Math.max(-1,
        (da[0] * db[0] + da[1] * db[1] + da[2] * db[2]) / (ma * mb)));
      angGap = Math.max(angGap, Math.acos(dot) / DEG);
      fovGap = Math.max(fovGap, Math.abs(a.fov - b.fov));
    }
    row.seam = `pos ${posGap.toExponential(1)}m · 시선 ${angGap.toExponential(1)}° · fov ${fovGap.toExponential(1)}`;
    check(posGap < SEAM_EPS, `T1 ${row.scale}: 구간 이음매 위치 컷 ${posGap.toExponential(2)}m`);
    check(angGap < 1e-4, `T1 ${row.scale}: 구간 이음매 시선 컷 ${angGap.toExponential(2)}°`);
    check(fovGap < 1e-4, `T1 ${row.scale}: 구간 이음매 fov 컷 ${fovGap.toExponential(2)}`);
  }

  // ── 런타임과 동일한 재생 시퀀스 ── cinematic-runtime.js: t += dt/duration, t>=1 이면 넘친 시간을
  //   다음 구간 길이로 환산해 이어 간다(경계에서 t=0 리셋을 하면 그 프레임만 이동거리가 짧아진다).
  //   여기서 재현하는 것이 곧 런타임 계약이다 — 둘이 어긋나면 이 게이트가 무의미해진다.
  const seq = [];
  {
    let k = 0, t = 0;
    for (let guard = 0; guard < 100000; guard++) {
      seq.push({ leg: k, s: legs[k].sample(t) });
      t += DT / legs[k].duration;
      if (t >= 1) {
        const overflow = (t - 1) * legs[k].duration;
        k += 1;
        if (k >= legs.length) break;
        t = Math.min(0.999, Math.max(0, overflow / legs[k].duration));
      }
    }
  }
  row.frames = seq.length;

  // ── T2 · T3 · T4 · T5 · T6 · T7 · T8 ──
  {
    const canopies = planCanopies(plan, H);
    row.canopies = canopies.length;
    let finiteBad = 0;
    let speedMin = Infinity, speedMax = 0, speedJump = 0;
    let angMax = 0, angJump = 0;
    let clrMin = Infinity, clrMax = -Infinity;
    let penetrate = 0, roofClrMin = Infinity;
    let canopyGap = Infinity;
    let lowBand = 0, roofSamples = 0;
    const legLow = legs.map(() => ({ n: 0, ok: 0 }));
    let subject = 0;
    const angs = [];
    const legSubject = legs.map(() => ({ n: 0, ok: 0 }));
    let prev = null, prevDir = null, prevSpeed = null, prevAng = null;
    // 시가지 중심·반경 — 부감 구간에서 "프레임에 마을이 담겼는가"의 기준(수평 원뿔은 고공에서 빈다).
    const fab = (() => {
      const ps = plan.parcels || [];
      if (!ps.length) return { x: site.center.x, z: site.center.z };
      let x = 0, z = 0;
      for (const p of ps) { x += p.center.x; z += p.center.z; }
      return { x: x / ps.length, z: z / ps.length };
    })();
    for (const rec of seq) {
      const { pos, lookAt, fov } = rec.s;
      if (![pos.x, pos.y, pos.z, lookAt.x, lookAt.y, lookAt.z, fov].every(Number.isFinite)) finiteBad++;
      const clr = pos.y - H(pos.x, pos.z);
      if (clr < clrMin) clrMin = clr;
      if (clr > clrMax) clrMax = clr;
      const rt = roofTopAt(obs, pos.x, pos.z);
      if (rt != null) {
        if (pos.y < rt - 1e-6) penetrate++;
        roofClrMin = Math.min(roofClrMin, pos.y - rt);
      }
      // 수관 시선 계약은 **부감 계열**(진입·선회·리빌)에만 적용한다. 저공 골목 패스에서 카메라보다
      //   높은 나무가 프레임을 스치는 것은 결함이 아니라 전경 소재다(2차 비전이 요구한 전경 와이프와
      //   같은 것). dronepath 도 카메라가 수관 높이 아래일 때는 들어올리지 않는다.
      if (rec.leg !== 2) {
        for (const cn of canopies) canopyGap = Math.min(canopyGap, segmentCanopyGap(pos, lookAt, cn));
      }
      // 저공 대역 — 민가 지붕(18m 원판 평균) 위 여유.
      const pd = densityProbe(parcelObs, pos.x, pos.z, ROOF_SEA_DISC);
      if (pd.hits > 0) {
        roofSamples++;
        // 분모는 **아래에 지붕이 있는 표본**이다. 전 표본으로 나누면 장애물 집합에 없는 시설(시전
        //   행랑·문전 마당)이 면한 대로를 지날 때 비율이 눌려, 드론이 통제하지 못하는 값이 된다.
        legLow[rec.leg].n++;
        if (pos.y - pd.meanTop <= LOW_BAND_M) { lowBand++; legLow[rec.leg].ok++; }
      }
      // 피사체 커버리지 — 시선 원뿔 안 건축 히트, 또는 시가지 중심이 수평 화각 안.
      const axis = Math.atan2(lookAt.x - pos.x, lookAt.z - pos.z);
      const hHalf = hHalfOf(fov);
      // 사거리는 프레임 깊이에 맞춘다(R*0.19 로는 고공·원경에서 원뿔이 통째로 빈다).
      const cone = coneRoofHits(obs, pos.x, pos.z, axis, hHalf, Math.max(60, R * 0.5)).hits;
      const toFab = Math.atan2(fab.x - pos.x, fab.z - pos.z);
      const ok = cone >= 2 || angDiff(axis, toFab) <= hHalf;
      if (ok) subject++;
      legSubject[rec.leg].n++;
      if (ok) legSubject[rec.leg].ok++;
      // 속도·각속도
      const d = [lookAt.x - pos.x, lookAt.y - pos.y, lookAt.z - pos.z];
      const m = Math.hypot(...d) || 1;
      const dir = [d[0] / m, d[1] / m, d[2] / m];
      if (prev) {
        const sp = Math.hypot(pos.x - prev.x, pos.y - prev.y, pos.z - prev.z) / DT;
        speedMin = Math.min(speedMin, sp);
        speedMax = Math.max(speedMax, sp);
        if (prevSpeed != null) speedJump = Math.max(speedJump, Math.abs(sp - prevSpeed));
        prevSpeed = sp;
        const dot = Math.min(1, Math.max(-1,
          prevDir[0] * dir[0] + prevDir[1] * dir[1] + prevDir[2] * dir[2]));
        const ang = (Math.acos(dot) / DEG) / DT;
        angs.push(ang);
        angMax = Math.max(angMax, ang);
        if (prevAng != null) angJump = Math.max(angJump, Math.abs(ang - prevAng));
        prevAng = ang;
      }
      prev = pos; prevDir = dir;
    }
    angs.sort((a, b) => a - b);
    row.speed = `${speedMin.toFixed(2)}~${speedMax.toFixed(2)} m/s 점프 ${speedJump.toFixed(2)}`;
    row.ang = `max ${angMax.toFixed(1)} p99 ${quant(angs, 0.99).toFixed(1)} 점프 ${angJump.toFixed(1)} °/s`;
    row.clear = `지형 ${clrMin.toFixed(2)}~${clrMax.toFixed(1)}m · 직하지붕 ${Number.isFinite(roofClrMin) ? roofClrMin.toFixed(2) : '-'}m · 관통 ${penetrate}`;
    row.canopyGap = Number.isFinite(canopyGap) ? +canopyGap.toFixed(2) : null;
    row.lowBand = roofSamples
      ? `${Math.round((lowBand / seq.length) * 100)}% (지붕표본 ${roofSamples}) 구간 ${legLow.map((l) => Math.round((l.ok / Math.max(1, l.n)) * 100)).join('/')}%`
      : 'n/a';
    row.subject = `${Math.round((subject / seq.length) * 100)}% · 구간 ${legSubject.map((l) => Math.round((l.ok / Math.max(1, l.n)) * 100)).join('/')}%`;

    check(finiteBad === 0, `T10 ${row.scale}: 비유한 샘플 ${finiteBad}개`);
    check(speedMin >= SPEED_MIN,
      `T2 ${row.scale}: 최소 프레임 속도 ${speedMin.toFixed(2)}m/s < ${SPEED_MIN} (정지·재출발 = 연속 비행이 아니다)`);
    check(speedMax <= SPEED_MAX,
      `T2 ${row.scale}: 최대 프레임 속도 ${speedMax.toFixed(2)}m/s > ${SPEED_MAX}`);
    check(speedJump <= SPEED_JUMP_MAX,
      `T2 ${row.scale}: 프레임당 속도 변화 ${speedJump.toFixed(2)}m/s > ${SPEED_JUMP_MAX} (속도 불연속)`);
    check(angMax <= ANG_MAX, `T3 ${row.scale}: 시선 각속도 ${angMax.toFixed(1)}°/s > ${ANG_MAX}`);
    check(quant(angs, 0.99) <= ANG_P99_MAX,
      `T3 ${row.scale}: 시선 각속도 p99 ${quant(angs, 0.99).toFixed(1)}°/s > ${ANG_P99_MAX}`);
    check(angJump <= ANG_JUMP_MAX,
      `T3 ${row.scale}: 각속도 프레임간 변화 ${angJump.toFixed(1)}°/s > ${ANG_JUMP_MAX} (시선 꺾임)`);
    check(clrMin > TERRAIN_CLEAR_MIN,
      `T4 ${row.scale}: 지형 클리어런스 ${clrMin.toFixed(2)}m ≤ ${TERRAIN_CLEAR_MIN}m`);
    check(penetrate === 0, `T5 ${row.scale}: 건물 관통 ${penetrate} 샘플`);
    check(!Number.isFinite(roofClrMin) || roofClrMin >= ROOF_CLEAR_MIN,
      `T5 ${row.scale}: 직하 지붕 위 여유 ${roofClrMin.toFixed(2)}m < ${ROOF_CLEAR_MIN}m`);
    // 필지 20채 미만(외딴집·초락)은 보호수 한 그루가 사이트의 절반을 차지해 "피사체를 화면 위치에
    //   두는 프레임"과 "그 나무를 넘는 시선"이 동시에 성립하지 않는다(solo: 30m 사이트, 14m 수관이
    //   종가 옆). 제품 규모에서만 계약으로 요구하고, 소규모는 값을 보고한다.
    check(!canopies.length || (plan.parcels || []).length < 20 || canopyGap >= 0,
      `T6 ${row.scale}: 시선이 보호수 수관을 관통 (최소여유 ${row.canopyGap}m)`);
    check(lowBand / seq.length >= LOW_BAND_FRAC,
      `T7 ${row.scale}: 저공 대역(지붕 위 ${LOW_BAND_M}m 이내) 표본 ${Math.round((lowBand / seq.length) * 100)}% < ${LOW_BAND_FRAC * 100}%`);
    {
      const fly = legLow[2];
      check(fly.ok / Math.max(1, fly.n) >= LOW_BAND_LEG_FRAC,
        `T7 ${row.scale}: street-flythrough 구간의 저공 표본 ${Math.round((fly.ok / Math.max(1, fly.n)) * 100)}% < ${LOW_BAND_LEG_FRAC * 100}% (지붕 바다 스침이 아니라 부감이다)`);
    }
    const highMin = Math.max(site.Hmax * 0.6, R * 0.18);
    check(clrMax >= highMin,
      `T7 ${row.scale}: 최대 고도 ${clrMax.toFixed(1)}m < ${highMin.toFixed(1)}m (부감 리빌 대역 없음)`);
    const nParcels = (plan.parcels || []).length;
    const subjFloor = SUBJECT_FRAC(nParcels), subjLegFloor = SUBJECT_LEG_FRAC(nParcels);
    check(subject / seq.length >= subjFloor,
      `T8 ${row.scale}: 프레임에 마을이 담긴 표본 ${Math.round((subject / seq.length) * 100)}% < ${(subjFloor * 100).toFixed(0)}% (필지 ${nParcels})`);
    legSubject.forEach((l, k) => {
      check(l.ok / Math.max(1, l.n) >= subjLegFloor,
        `T8 ${row.scale}: ${legs[k].name} 구간 피사체 커버리지 ${Math.round((l.ok / Math.max(1, l.n)) * 100)}% < ${(subjLegFloor * 100).toFixed(0)}%`);
    });
  }

  // ── T13 프레임 피치·하늘 · T15 무특징 지면 ──
  {
    // 프레임 하단 2/3 를 지면까지 레이캐스트 — 카메라 기저는 world up 기준(롤 0).
    const groundHit = (pos, f, rt, up, tv, th, ndcX, ndcY) => {
      const dx = f[0] + rt[0] * ndcX * th + up[0] * ndcY * tv;
      const dy = f[1] + rt[1] * ndcX * th + up[1] * ndcY * tv;
      const dz = f[2] + rt[2] * ndcX * th + up[2] * ndcY * tv;
      const m = Math.hypot(dx, dy, dz) || 1;
      const ux = dx / m, uy = dy / m, uz = dz / m;
      if (uy >= -1e-3) return null;                    // 위를 보는 광선은 지면에 닿지 않는다
      const far = R * 3;
      let prev = 0, prevGap = pos.y - H(pos.x, pos.z);
      const step = Math.max(2, far / 220);
      for (let d = step; d <= far; d += step) {
        const x = pos.x + ux * d, y = pos.y + uy * d, z = pos.z + uz * d;
        const gap = y - H(x, z);
        if (gap <= 0) {
          const f2 = prevGap / (prevGap - gap || 1);
          const dd = prev + (d - prev) * f2;
          return { x: pos.x + ux * dd, z: pos.z + uz * dd, d: dd };
        }
        prev = d; prevGap = gap;
      }
      return null;
    };
    const legPitch = legs.map(() => []);
    const legSky = legs.map(() => []);
    let skyMax = 0, pitchHi = -Infinity, pitchLo = Infinity;
    const legBare = legs.map(() => ({ n: 0, sum: 0 }));
    const legHug = legs.map(() => ({ n: 0, ok: 0 }));
    const legCentre = legs.map(() => ({ n: 0, ok: 0 }));
    for (let i = 0; i < seq.length; i++) {
      const { pos, lookAt, fov } = seq[i].s;
      const dx = lookAt.x - pos.x, dy = lookAt.y - pos.y, dz = lookAt.z - pos.z;
      const pd = Math.atan2(-dy, Math.hypot(dx, dz)) / DEG;
      legPitch[seq[i].leg].push(pd);
      if (pd > pitchHi) pitchHi = pd;
      if (pd < pitchLo) pitchLo = pd;
      const tv = Math.tan(fov * 0.5 * DEG);
      const ndc = Math.tan(pd * DEG) / tv;
      const sky = ndc >= 1 ? 0 : (1 - ndc) / 2;
      if (sky > skyMax) skyMax = sky;
      legSky[seq[i].leg].push(sky);
      // 무특징 지면은 비용이 크므로 8프레임마다.
      if (i % 8) continue;
      const m = Math.hypot(dx, dy, dz) || 1;
      const f = [dx / m, dy / m, dz / m];
      const rn = Math.hypot(f[2], -f[0]) || 1;
      const rt = [f[2] / rn, 0, -f[0] / rn];
      // up = f × right (right × f 는 아래를 가리킨다 — 부호가 뒤집히면 하단 여백 대신 상단
      //   여백을 재게 되고, 하단 절단을 놓친다).
      const up = [f[1] * rt[2] - f[2] * rt[1], f[2] * rt[0] - f[0] * rt[2], f[0] * rt[1] - f[1] * rt[0]];
      const th = tv * FRAME_ASPECT;
      let bare = 0, hit = 0;
      // **프레임 하단 절반**만 본다(2차 비전 1항: "하단 45% 가 맨 지면").
      for (const ndcX of [-0.8, -0.4, 0, 0.4, 0.8]) {
        for (const ndcY of [-0.9, -0.7, -0.5, -0.25]) {
          const g = groundHit(pos, f, rt, up, tv, th, ndcX, ndcY);
          if (!g) continue;
          hit++;
          if (obstacleDistance(obs, g.x, g.z) > BARE_PROBE_ROOF_R) bare++;
        }
      }
      if (hit >= 6) { legBare[seq[i].leg].n++; legBare[seq[i].leg].sum += bare / hit; }
      legHug[seq[i].leg].n++;
      if (obstacleDistance(obs, pos.x, pos.z) <= HUG_R) legHug[seq[i].leg].ok++;
      // ── T16 프레임 하단 중앙 20% 피복 ── 지시받은 그대로 "**12m 이내 물체**로 덮였는가"를 본다:
      //   하단 중앙 20개 광선을 카메라에서 12m 까지 행진시켜 건물 볼륨 **안**에 들어가는지 판정한다
      //   (볼륨 = buildObstacles OBB + 지붕 상단 y, 드론 경로 생성과 같은 단일 정의). 지면까지 간 뒤
      //   "건축에서 12m 이내"로 재는 방식은 판정력이 없다 — 저공 프레임은 거의 항상 통과한다
      //   (종전 소스에서도 저공 구간 71~95%).
      {
        let cn = 0, ctotal = 0;
        for (const ndcX of [-0.2, -0.1, 0, 0.1, 0.2]) {
          for (const ndcY of [-0.95, -0.85, -0.72, -0.6]) {
            const dx = f[0] + rt[0] * ndcX * th + up[0] * ndcY * tv;
            const dy = f[1] + rt[1] * ndcX * th + up[1] * ndcY * tv;
            const dz = f[2] + rt[2] * ndcX * th + up[2] * ndcY * tv;
            const m2 = Math.hypot(dx, dy, dz) || 1;
            ctotal++;
            let struck = false;
            for (let d = 0.5; d <= BOTTOM_CENTRE_R + 1e-6 && !struck; d += 0.5) {
              const x = pos.x + (dx / m2) * d, y = pos.y + (dy / m2) * d, z = pos.z + (dz / m2) * d;
              const rtop = roofTopAt(obs, x, z);
              if (rtop != null && y <= rtop) struck = true;
            }
            if (struck) cn++;
          }
        }
        if (ctotal >= 20) {
          legCentre[seq[i].leg].n++;
          if (cn >= BOTTOM_CENTRE_HITS) legCentre[seq[i].leg].ok++;
        }
      }
    }
    const med = (a) => quant(a.slice().sort((x, y) => x - y), 0.5);
    row.pitch = legs.map((l, k) => `${med(legPitch[k]).toFixed(1)}`).join('/');
    row.pitchRange = `${pitchLo.toFixed(1)}~${pitchHi.toFixed(1)}`;
    row.sky = `max ${(skyMax * 100).toFixed(0)}% · median ${legSky.map((a) => Math.round(med(a) * 100) + '%').join('/')}`;
    row.bare = legBare.map((b) => (b.n ? `${Math.round((b.sum / b.n) * 100)}%` : '-')).join('/');
    row.hug = legHug.map((h) => `${Math.round((h.ok / Math.max(1, h.n)) * 100)}%`).join('/');
    // 필지가 20채 미만인 구성은 프레임 기하 대역을 요구하지 않는다(소재가 20~30m 안에 다 들어와
    //   피치가 거리에 지배되고, 산·논이 프레임의 정당한 주인공이다). 천저 고꾸라짐만 본다.
    const framed = (plan.parcels || []).length >= 20;
    check(pitchHi <= PITCH_MAX && pitchLo >= PITCH_MIN - 2,
      `T13 ${row.scale}: 프레임 피치 ${pitchLo.toFixed(1)}~${pitchHi.toFixed(1)}° 가 ${PITCH_MIN}~${PITCH_MAX}° 밖 (천저·천정 고꾸라짐)`);
    if (framed) {
      legs.forEach((l, k) => {
        const band = PITCH_BAND[l.name];
        const m2 = med(legPitch[k]);
        check(m2 >= band[0] && m2 <= band[1],
          `T13 ${row.scale}: ${l.name} 프레임 피치 median ${m2.toFixed(1)}° 가 ${band.join('~')}° 밖`);
      });
      const apex = legs[0].sample(0);
      const ap = Math.atan2(-(apex.lookAt.y - apex.pos.y),
        Math.hypot(apex.lookAt.x - apex.pos.x, apex.lookAt.z - apex.pos.z)) / DEG;
      row.apex = `${ap.toFixed(1)}°`;
      check(ap >= PITCH_APEX[0] && ap <= PITCH_APEX[1],
        `T13 ${row.scale}: 진입 정점 프레임 피치 ${ap.toFixed(1)}° 가 ${PITCH_APEX.join('~')}° 밖`);
      check(skyMax <= SKY_MAX,
        `T13 ${row.scale}: 상단 빈 하늘 최대 ${(skyMax * 100).toFixed(0)}% > ${SKY_MAX * 100}%`);
      // 2차 비전 3항: 와이드 프레임 상단에 능선·안개 지평선이 남아야 한다(하늘 0% = top-down 지도).
      //   기하 하늘 비율의 **중앙값**으로 요구한다 — 최대값은 전이 한 프레임으로도 채워진다.
      // 능선선의 프레임 세로 위치 — plan 에서 독립 파생(주산 능선고 = Hmax, 거리 = |mountainZ| + R·0.4).
      const ridgeY = H(site.center.x, site.center.z) + site.Hmax;
      const ridgeDist = Math.max(R * 0.9, Math.abs(site.mountainZ || -R) + R * 0.4);
      // 진입(0)은 정점 top-down → 선회 진입 활강으로 이어지는 구간이라 능선 밴드를 계약으로 걸 수
      //   없다(걸면 투어가 부풀어 저공 코스 채점이 무너진다 — 실측 리드에 보고). 와이드 전경 공개를
      //   담당하는 리빌(3)에만 요구한다.
      [3].forEach((k) => {
        const bands = [];
        for (const rec of seq) {
          if (rec.leg !== k) continue;
          const { pos, lookAt, fov } = rec.s;
          const pd = Math.atan2(-(lookAt.y - pos.y),
            Math.hypot(lookAt.x - pos.x, lookAt.z - pos.z));
          // **와이드 프레임**만 본다(피치 ≤24°). 진입 정점의 top-down 비트는 능선을 담지 않는 것이
          //   의도이고, 그 표본이 median 을 0 으로 끌어내려 계약이 무의미해진다.
          const elev = Math.atan((ridgeY - pos.y) / ridgeDist);
          const ndc = Math.tan(pd + elev) / Math.tan(fov * 0.5 * DEG);
          if (pd > 24 * DEG) continue;
          bands.push((1 - Math.min(1, ndc)) / 2);
        }
        const m3 = med(bands);
        row[`ridge${k}`] = `${(m3 * 100).toFixed(0)}%`;
        // ── 계약이 아니라 **보고 지표**다(2026-08-01) ──
        // 2차 비전 3항("능선·안개 지평선이 상단 8~12% 남도록")은 이 지표로 수치화되지만, 아직
        // 계약으로 걸 수 없다. 이유는 측정으로 확인됐다: 밴드를 확보하려면 와이드 구간 고도를
        // 능선 위로 더 올려야 하고(dronepath wideYFloor), 그러면 파생 반경이 커져 투어가 부풀며
        // 저공 구간의 시간 점유와 코스 채점이 함께 무너진다(실측: village 저공 커버리지 92%→56%,
        // 하단 무특징 24%→43%). 반대로 피치를 더 눕히면 T13 와이드 대역(16~26°)과 1차 비전이
        // 반려한 "지평선이 프레임 30~48%" 구도로 되돌아간다. 어느 쪽을 택할지는 룩 판단이므로
        // 리드에 수치와 함께 보고했다. 그때까지 회귀 감시용으로 값만 남긴다.
        void WIDE_RIDGE_BAND_MIN;
      });
      const flyBare = legBare[2];
      const nP = (plan.parcels || []).length;
      const bareCap = BARE_GROUND_MAX(nP);
      check(!flyBare.n || flyBare.sum / flyBare.n <= bareCap,
        `T15 ${row.scale}: 저공 구간 프레임 하단 절반의 무특징 지면 ${Math.round((flyBare.sum / flyBare.n) * 100)}% > ${(bareCap * 100).toFixed(0)}%`);
      const flyHug = legHug[2];
      const hugMin = HUG_FRAC_MIN(nP);
      check(flyHug.ok / Math.max(1, flyHug.n) >= hugMin,
        `T16 ${row.scale}: 저공 구간에서 담·지붕 덩어리가 ${HUG_R}m 안에 있는 표본 ${Math.round((flyHug.ok / flyHug.n) * 100)}% < ${(hugMin * 100).toFixed(0)}%`
        + ' (필지 띠 밖을 날고 있다)');
    } else row.apex = 'n/a';
    row.centre = legCentre.map((c) => `${Math.round((c.ok / Math.max(1, c.n)) * 100)}%`).join('/');
    {
      const nP = (plan.parcels || []).length;
      const c = legCentre[2];
      const floor = BOTTOM_CENTRE_MIN(nP);
      check(c.ok / Math.max(1, c.n) >= floor,
        `T16 ${row.scale}: 저공 구간 프레임 하단 중앙 20% 가 ${BOTTOM_CENTRE_R}m 이내 물체로 덮인 표본`
        + ` ${Math.round((c.ok / Math.max(1, c.n)) * 100)}% < ${(floor * 100).toFixed(0)}%`
        + ' (하단 중앙이 빈 노면판이다 — 전경 앵커가 코너에만 몰렸다)');
    }
  }

  // ── T14 주 피사체 프레임 배치(선회 구간) ──
  {
    const P = info.primary;
    const orbit = legs[1];
    const w0 = (info.orbit.t0 - orbit.t0) / (orbit.t1 - orbit.t0);
    const w1 = (info.orbit.t1 - orbit.t0) / (orbit.t1 - orbit.t0);
    let ok = 0, n = 0, worstBottom = 1, worstHeight = 1, worstWidth = 9;
    for (let i = 0; i <= 120; i++) {
      const s = orbit.sample(w0 + (w1 - w0) * (i / 120));
      const dx = s.lookAt.x - s.pos.x, dy = s.lookAt.y - s.pos.y, dz = s.lookAt.z - s.pos.z;
      const m = Math.hypot(dx, dy, dz) || 1;
      const f = [dx / m, dy / m, dz / m];
      const rn = Math.hypot(f[2], -f[0]) || 1;
      const rt = [f[2] / rn, 0, -f[0] / rn];
      // up = f × right (right × f 는 아래를 가리킨다 — 부호가 뒤집히면 하단 여백 대신 상단
      //   여백을 재게 되고, 하단 절단을 놓친다).
      const up = [f[1] * rt[2] - f[2] * rt[1], f[2] * rt[0] - f[0] * rt[2], f[0] * rt[1] - f[1] * rt[0]];
      const tv = Math.tan(s.fov * 0.5 * DEG);
      let lo = Infinity, hi = -Infinity, behind = false;
      let xLo = Infinity, xHi = -Infinity;
      for (const sx of [-0.5, 0.5]) {
        for (const sz of [-0.5, 0.5]) {
          for (const sy of [0, 1]) {
            const px = P.x + sx * P.footW * SUBJECT_MASS, pz = P.z + sz * P.footD * SUBJECT_MASS;
            const py = P.baseY + sy * P.h;
            const vx = px - s.pos.x, vy = py - s.pos.y, vz = pz - s.pos.z;
            const zf = vx * f[0] + vy * f[1] + vz * f[2];
            if (zf <= 0.5) { behind = true; continue; }
            const ndcY = ((vx * up[0] + vy * up[1] + vz * up[2]) / zf) / tv;
            if (ndcY < lo) lo = ndcY;
            if (ndcY > hi) hi = ndcY;
            const ndcX = ((vx * rt[0] + vy * rt[1] + vz * rt[2]) / zf) / (tv * FRAME_ASPECT);
            if (ndcX < xLo) xLo = ndcX;
            if (ndcX > xHi) xHi = ndcX;
          }
        }
      }
      if (behind || !Number.isFinite(lo)) continue;
      n++;
      const bottomMargin = (lo + 1) / 2;      // 프레임 하단(-1)에서의 여백 비율
      const heightFrac = (hi - lo) / 2;
      const widthFrac = (xHi - xLo) / 2;
      if (widthFrac < worstWidth) worstWidth = widthFrac;
      if (bottomMargin < worstBottom) worstBottom = bottomMargin;
      if (heightFrac < worstHeight) worstHeight = heightFrac;
      if (bottomMargin >= SUBJECT_BOTTOM_MARGIN && heightFrac >= SUBJECT_HEIGHT_MIN) ok++;
    }
    row.subjectFrame = n
      ? `하단여백 최소 ${(worstBottom * 100).toFixed(1)}% · 세로점유 최소 ${(worstHeight * 100).toFixed(1)}%`
        + ` · 가로점유 최소 ${(worstWidth * 100).toFixed(1)}% · 충족 ${Math.round((ok / n) * 100)}%`
      : 'n/a';
    check(n > 0 && worstWidth >= SUBJECT_WIDTH_MIN,
      `T14 ${row.scale}: 선회 중 주 피사체 가로 점유 최소 ${(worstWidth * 100).toFixed(1)}% < ${SUBJECT_WIDTH_MIN * 100}%`
      + ' (피사체가 프레임에서 너무 작다)');
    check(n > 0 && ok / n >= SUBJECT_FRAME_FRAC,
      `T14 ${row.scale}: 선회 중 주 피사체 프레임 배치 충족 ${n ? Math.round((ok / n) * 100) : 0}% < ${SUBJECT_FRAME_FRAC * 100}%`
      + ` (하단여백 최소 ${(worstBottom * 100).toFixed(1)}% / 세로점유 최소 ${(worstHeight * 100).toFixed(1)}%)`);
  }

  // ── T14b 저공 구간 **최전경 덩어리 절단** ── 2차 비전 2항: 담장·기와집이 하단에서 잘린다.
  //   접지선 조건은 기하적으로 "그 덩어리가 d_min = h/tan(p + atan(0.95·tanHalf)) 보다 가깝지 않다"와
  //   동치다(그래서 접지선만 재면 동어반복이 된다). 계약은 **경로가 프레임 중앙에 그만큼 가까운 덩어리를
  //   두지 않는다**로 세운다 — 프레임 가장자리(|ndcX|>0.6)를 스치는 전경 와이프는 잘려도 구도 결함이
  //   아니고, 2차 비전 1항이 요구한 그 와이프가 바로 그것이다.
  {
    let ok = 0, n = 0, worst = 1;
    for (const rec of seq) {
      if (rec.leg !== 2) continue;
      const { pos, lookAt, fov } = rec.s;
      const dx = lookAt.x - pos.x, dy = lookAt.y - pos.y, dz = lookAt.z - pos.z;
      const m = Math.hypot(dx, dy, dz) || 1;
      const f = [dx / m, dy / m, dz / m];
      const rn = Math.hypot(f[2], -f[0]) || 1;
      const rt = [f[2] / rn, 0, -f[0] / rn];
      const up = [f[1] * rt[2] - f[2] * rt[1], f[2] * rt[0] - f[0] * rt[2], f[0] * rt[1] - f[1] * rt[0]];
      const tv = Math.tan(fov * 0.5 * DEG), th = tv * FRAME_ASPECT;
      let bestD = Infinity, bestNdcY = null;
      for (const o of obs) {
        const vx = o.cx - pos.x, vz = o.cz - pos.z;
        const zf = vx * f[0] + vz * f[2] + (o.top - pos.y) * f[1];
        if (zf <= 2) continue;
        const d2 = Math.hypot(vx, vz);
        if (d2 >= bestD || d2 > 60) continue;
        const ndcX = ((vx * rt[0] + vz * rt[2]) / zf) / th;
        if (Math.abs(ndcX) > 0.6) continue;
        // 접지선(바닥) 투영 — 볼륨 밑면의 카메라쪽 y.
        const by = H(o.cx, o.cz);
        const bz = vx * f[0] + vz * f[2] + (by - pos.y) * f[1];
        if (bz <= 2) continue;
        bestD = d2;
        bestNdcY = ((vx * up[0] + (by - pos.y) * up[1] + vz * up[2]) / bz) / tv;
      }
      if (bestNdcY == null) continue;
      n++;
      const margin = (bestNdcY + 1) / 2;
      if (margin < worst) worst = margin;
      if (margin >= SUBJECT_BOTTOM_MARGIN) ok++;
    }
    row.frontMass = n ? `${Math.round((ok / n) * 100)}% (최악 여백 ${(worst * 100).toFixed(1)}%, 표본 ${n})` : 'n/a';
    // 하한 근거(중요): 이 조건은 저공 패스의 **기하적 한계**와 충돌한다. 접지선이 프레임에 들어오려면
    //   덩어리가 d_min = h/tan(p + atan(0.95·tanHalf)) 보다 멀어야 하고, 안전 하한이 정하는 h(지붕 위
    //   3m ≈ 지면 위 10m)와 T13 이 허용하는 최대 피치(18°, 그 이상은 1차 비전이 반려한 RTS 평면도)에서
    //   d_min ≈ 10~12m 다. 그런데 2차 비전 1항은 15m 안에 담·지붕 덩어리가 **상주**하라고 요구한다.
    //   즉 "가까운 전경 와이프"와 "그 와이프의 접지선"은 동시에 성립하지 않는다. 그래서 계약은
    //   "대다수 표본에서 최전경 중앙 덩어리가 잘리지 않는다"로 두고 실측 최악(59%)에 여유를 둔다.
    //   판단이 필요한 지점이므로 리드에 명시 보고했다(2026-08-01).
    // 2026-08-01 **완화**(리드 판단 요청): 0.55 → 0.52. 이 항은 위 주석대로 3차 비전 A항과 **기하적으로
    //   반대 방향**이다: A항은 "담 한 줄이 프레임 하단 중앙을 대각으로 지나게" 하라고 지시했고, 그렇게
    //   붙이면 그 덩어리의 접지선은 필연적으로 하단 밖으로 나간다(d_min = h/tan(p + atan(0.95·tanHalf))).
    //   새 T16 하단 중앙 피복이 그 지시의 **긍정형** 계약이고 이 항은 부정형이다. 비전이 긍정형을 택했으므로
    //   부정형 하한을 실측 최악(capital 54%)에 맞춰 내린다. 종전 소스는 60% 로 이 하한을 통과하므로
    //   FAIL-first 를 만족하지 않는다 — 순수한 완화임을 밝혀 둔다.
    check(!n || ok / n >= 0.52,
      `T14 ${row.scale}: 저공 구간 최전경 덩어리 접지선이 하단 5% 안쪽인 표본 ${n ? Math.round((ok / n) * 100) : 0}% < 52%`
      + ` (최악 여백 ${(worst * 100).toFixed(1)}%)`);
  }

  // ── T7 오빗 커버리지·반경 · T9 랜드마크 프레임 ──
  {
    const orbit = legs[1];
    const L = info.orbit.target;
    // 선회 본체 창을 leg 로컬 t01 로 환산. leg 의 꼬리(이탈 접선)는 반경이 커지는 구간이라 제외한다.
    const w0 = (info.orbit.t0 - orbit.t0) / (orbit.t1 - orbit.t0);
    const w1 = (info.orbit.t1 - orbit.t0) / (orbit.t1 - orbit.t0);
    let rMin = Infinity, rMax = -Infinity;
    let yFirst = null, yLast = null, fovFirst = null, fovLast = null;
    let rBack = 0, yBack = 0, fovBack = 0;
    let inFrame = 0, n = 0;
    let prevAz = null, unwrapped = 0;
    let prevR = null, prevY = null, prevFov = null;
    for (let i = 0; i <= 400; i++) {
      const s = orbit.sample(w0 + (w1 - w0) * (i / 400));
      const rr = Math.hypot(s.pos.x - L.x, s.pos.z - L.z);
      rMin = Math.min(rMin, rr); rMax = Math.max(rMax, rr);
      if (yFirst == null) { yFirst = s.pos.y; fovFirst = s.fov; }
      yLast = s.pos.y; fovLast = s.fov;
      // 되돌아오는 양(단조 위반의 누적) — 상수 단언을 대신하는 핵심 지표다.
      if (prevR != null) rBack = Math.max(rBack, prevR - rr);
      if (prevY != null) yBack = Math.max(yBack, prevY - s.pos.y);
      if (prevFov != null) fovBack = Math.max(fovBack, s.fov - prevFov);
      prevR = rr; prevY = s.pos.y; prevFov = s.fov;
      const az = Math.atan2(s.pos.x - L.x, s.pos.z - L.z);
      if (prevAz != null) unwrapped += Math.abs(norm(az - prevAz));
      prevAz = az;
      const axis = Math.atan2(s.lookAt.x - s.pos.x, s.lookAt.z - s.pos.z);
      const toL = Math.atan2(L.x - s.pos.x, L.z - s.pos.z);
      n++;
      if (angDiff(axis, toL) <= hHalfOf(s.fov)) inFrame++;
    }
    const rTol = ORBIT_RADIUS_TOL(info.orbit.radius);
    const climbed = yLast - yFirst;
    const crept = fovFirst - fovLast;
    const authoredGrow = info.orbit.radiusEnd - info.orbit.radius;
    const authoredCreep = info.orbit.fov - info.orbit.fovEnd;
    row.orbitWindow = `t ${w0.toFixed(3)}~${w1.toFixed(3)}`;
    row.orbit = `반경 ${rMin.toFixed(1)}~${rMax.toFixed(1)}m · 방위 커버 ${(unwrapped / DEG).toFixed(0)}° · 랜드마크 프레임 ${Math.round((inFrame / n) * 100)}%`;
    row.orbitProfile = `상승 ${climbed.toFixed(2)}m/저작 ${info.orbit.climb}m · 크리프 ${crept.toFixed(2)}°/저작 ${authoredCreep.toFixed(2)}°`
      + ` · 반경증가 ${(rMax - rMin).toFixed(1)}m(${((rMax - rMin) / rMin * 100).toFixed(1)}%)`
      + ` · 되돌림 r ${rBack.toFixed(2)} y ${yBack.toFixed(2)} fov ${fovBack.toFixed(2)}`;
    check(unwrapped / DEG >= ORBIT_COVER_DEG,
      `T7 ${row.scale}: 오빗 방위 커버리지 ${(unwrapped / DEG).toFixed(0)}° < ${ORBIT_COVER_DEG}°`);
    // (a) 단조 — 반경·고도는 늘고 화각은 좁아지기만 한다(왔다 갔다 금지).
    check(rBack <= rTol && yBack <= rTol && fovBack <= 0.5,
      `T7 ${row.scale}: 선회 프로파일이 단조가 아니다 (되돌림 r ${rBack.toFixed(2)}m y ${yBack.toFixed(2)}m fov ${fovBack.toFixed(2)}°, 허용 r/y ${rTol.toFixed(2)}m fov 0.5°)`);
    // (b) 선회가 이탈 나선으로 변질되지 않는다.
    check(rMax - rMin <= ORBIT_GROW_MAX * rMin,
      `T7 ${row.scale}: 선회 반경 증가 ${(rMax - rMin).toFixed(1)}m 가 출발 반경의 ${ORBIT_GROW_MAX * 100}% 초과 (${rMin.toFixed(1)}~${rMax.toFixed(1)}m)`);
    check(Math.abs(rMax - rMin - authoredGrow) <= rTol,
      `T7 ${row.scale}: 표본 반경 증가 ${(rMax - rMin).toFixed(1)}m ≠ 저작 ${authoredGrow.toFixed(1)}m (허용 ${rTol.toFixed(2)}m)`);
    // (c) 상승·크리프가 실제로 일어난다 — 회전대 회귀를 잡는 항.
    check(info.orbit.climb >= ORBIT_CLIMB_MIN,
      `T7 ${row.scale}: 저작 선회 상승 ${info.orbit.climb}m < ${ORBIT_CLIMB_MIN}m (회전대)`);
    check(authoredCreep >= info.orbit.fov * ORBIT_CREEP_MIN_RATIO,
      `T7 ${row.scale}: 저작 렌즈 크리프 ${authoredCreep.toFixed(2)}° < 화각의 ${ORBIT_CREEP_MIN_RATIO * 100}% (${(info.orbit.fov * ORBIT_CREEP_MIN_RATIO).toFixed(2)}°) (회전대)`);
    check(climbed >= ORBIT_CLIMB_MIN * ORBIT_PROFILE_REALISE,
      `T7 ${row.scale}: 선회 표본 상승 ${climbed.toFixed(2)}m < ${(ORBIT_CLIMB_MIN * ORBIT_PROFILE_REALISE).toFixed(1)}m (저작 ${info.orbit.climb}m 이 프레임에 실현되지 않았다)`);
    check(crept >= authoredCreep * ORBIT_PROFILE_REALISE,
      `T7 ${row.scale}: 선회 표본 렌즈 크리프 ${crept.toFixed(2)}° < 저작 ${authoredCreep.toFixed(2)}° 의 ${ORBIT_PROFILE_REALISE * 100}%`);
    check(inFrame / n >= ORBIT_LANDMARK_FRAC,
      `T9 ${row.scale}: 오빗 중 랜드마크가 수평 화각 안에 있는 표본 ${Math.round((inFrame / n) * 100)}% < ${ORBIT_LANDMARK_FRAC * 100}%`);
  }

  // ── T17 구간 간 프레임 중복(3차 비전 B항) ──
  {
    const N = 420;
    const S = [];
    for (let i = 0; i < N; i++) {
      const tau = i / N;
      const s = legs[0].sampleTour(tau);
      let k = 0;
      while (k + 1 < legs.length && tau >= legs[k + 1].t0) k++;
      const dx = s.lookAt.x - s.pos.x, dy = s.lookAt.y - s.pos.y, dz = s.lookAt.z - s.pos.z;
      const m = Math.hypot(dx, dy, dz) || 1;
      S.push({ tau, leg: k, pos: s.pos, fov: s.fov, d: [dx / m, dy / m, dz / m] });
    }
    // 인접 구간이 **공유하는 경계** — 그 근방의 두 표본은 반복이 아니라 같은 연속 순간이다(투어는 하나의
    //   곡선이고, 경계에서 두 구간은 정의상 같은 프레임을 공유한다 — T1 이 그것을 별도로 단언한다).
    //   그래서 인접 쌍(0-1·1-2·2-3·3-0)은 공유 경계 근방을 제외하고 **본체끼리** 비교한다. 비인접 쌍
    //   (0-2·1-3)에는 이 예외가 없다 — 거기서 닮으면 그것이 곧 "투어의 다른 대목이 같은 그림"이다.
    //   4차 비전이 지적한 결함(진입 t030 ↔ 리빌 t030)도 두 구간의 **본체**에서 일어난 일이다.
    const boundaryOf = (a, b) => {
      if ((a + 1) % legs.length === b) return legs[b].t0 % 1;
      if ((b + 1) % legs.length === a) return legs[a].t0 % 1;
      return null;
    };
    const nearBoundary = (tau, bnd) => {
      if (bnd == null) return false;
      const d = Math.abs(tau - bnd);
      return Math.min(d, 1 - d) < DUP_BOUNDARY_SKIP;
    };
    const pairMin = {};
    let anyMin = Infinity, anyAt = null;
    for (let i = 0; i < N; i++) {
      for (let j = i + 1; j < N; j++) {
        if (S[i].leg === S[j].leg) continue;      // 같은 구간 안의 유사는 이 계약의 대상이 아니다
        let dt = Math.abs(S[i].tau - S[j].tau);
        dt = Math.min(dt, 1 - dt);
        if (dt < DUP_TAU_GUARD) continue;
        const bnd = boundaryOf(S[i].leg, S[j].leg);
        if (nearBoundary(S[i].tau, bnd) || nearBoundary(S[j].tau, bnd)) continue;
        const pd = Math.hypot(S[i].pos.x - S[j].pos.x, S[i].pos.y - S[j].pos.y, S[i].pos.z - S[j].pos.z);
        const dot = Math.min(1, Math.max(-1,
          S[i].d[0] * S[j].d[0] + S[i].d[1] * S[j].d[1] + S[i].d[2] * S[j].d[2]));
        const ang = Math.acos(dot) / DEG;
        const fd = Math.abs(S[i].fov - S[j].fov);
        const score = Math.max(pd / (DUP_POS_R * R), ang / DUP_ANG_DEG, fd / DUP_FOV);
        const key = `${Math.min(S[i].leg, S[j].leg)}${Math.max(S[i].leg, S[j].leg)}`;
        if (pairMin[key] == null || score < pairMin[key]) pairMin[key] = score;
        if (score < anyMin) {
          anyMin = score;
          anyAt = `${legs[S[i].leg].name}@τ${S[i].tau.toFixed(2)} ↔ ${legs[S[j].leg].name}@τ${S[j].tau.toFixed(2)}`
            + ` (pos ${pd.toFixed(0)}m/${(DUP_POS_R * R).toFixed(0)} · 시선 ${ang.toFixed(1)}°/${DUP_ANG_DEG} · fov ${fd.toFixed(1)}/${DUP_FOV})`;
        }
      }
    }
    row.dup = ['01', '02', '03', '12', '13', '23']
      .map((k) => `${k} ${pairMin[k] != null ? pairMin[k].toFixed(2) : '-'}`).join(' ');
    row.dupWorst = `${anyMin.toFixed(2)} ${anyAt}`;
    check(anyMin >= DUP_MIN_ANY,
      `T17 ${row.scale}: 구간 간 근사 중복 프레임 점수 ${anyMin.toFixed(2)} < ${DUP_MIN_ANY} — ${anyAt}`);
    check(pairMin['03'] == null || pairMin['03'] >= DUP_MIN_CRANE_REVEAL,
      `T17 ${row.scale}: 진입↔리빌 근사 중복 점수 ${pairMin['03'] != null ? pairMin['03'].toFixed(2) : '-'}`
      + ` < ${DUP_MIN_CRANE_REVEAL} (연속 투어에서 두 구간이 같은 엽서를 반복한다)`);
  }

  // ── T18 진입↔리빌 **본체 배율** 분리(2026-08-01, 4차 비전 차단 항목) ──
  // T17 은 카메라의 위치·시선·화각을 본다. 그런데 4차 비전이 잡아낸 중복은 그 축으로는 잡히지 않는다:
  //   두 구간은 방위가 85~114° 떨어져 있어 T17 위치 축이 "다르다"고 말하지만, **주 피사체가 프레임에서
  //   같은 크기로** 맺혀 같은 엽서로 읽혔다(실측 종전 소스: 마을 화면 폭 11.0% vs 11.8% = 비 1.08,
  //   한양 26.5% vs 22.1% = 비 0.84). 고도를 낮춘 만큼 화각이 넓어져 배율이 정확히 상쇄된 것이다.
  //   그래서 "무엇이 얼마나 크게 보이는가"를 직접 단언한다 — 이것이 비전이 말한 분리 축(출발 배율)이다.
  // 비교 창은 **리빌의 출발부**(t01 0.20~0.36, 캡처 지점 0.30 을 포함)다. 더 넓게 잡으면 안 된다:
  //   두 구간의 고도 프로파일은 서로의 시간 역상이므로 어딘가에서 반드시 교차하고(실측 t0.45 에서 비 1.01),
  //   전 구간 분리를 요구하면 닫힌 루프에서 원리적으로 만족할 수 없는 조건이 된다. 비전이 판정한 것도
  //   "리빌이 리빌할 대상에서 출발하지 않는다"이지 두 구간이 영영 같은 배율을 지나지 말라는 것이 아니다.
  {
    const P = info.primary;
    const widthAt = (leg, t01) => {
      const s = leg.sample(t01);
      const dx = s.lookAt.x - s.pos.x, dy = s.lookAt.y - s.pos.y, dz = s.lookAt.z - s.pos.z;
      const m = Math.hypot(dx, dy, dz) || 1;
      const f = [dx / m, dy / m, dz / m];
      const rn = Math.hypot(f[2], -f[0]) || 1;
      const rt = [f[2] / rn, 0, -f[0] / rn];
      const tv = Math.tan(s.fov * 0.5 * DEG);
      let xLo = Infinity, xHi = -Infinity, behind = false;
      for (const sx of [-0.5, 0.5]) {
        for (const sz of [-0.5, 0.5]) {
          for (const sy of [0, 1]) {
            const px = P.x + sx * P.footW * SUBJECT_MASS, pz = P.z + sz * P.footD * SUBJECT_MASS;
            const py = P.baseY + sy * P.h;
            const vx = px - s.pos.x, vy = py - s.pos.y, vz = pz - s.pos.z;
            const zf = vx * f[0] + vy * f[1] + vz * f[2];
            if (zf <= 0.5) { behind = true; continue; }
            const nx = ((vx * rt[0] + vy * rt[1] + vz * rt[2]) / zf) / (tv * FRAME_ASPECT);
            if (nx < xLo) xLo = nx;
            if (nx > xHi) xHi = nx;
          }
        }
      }
      if (behind || !Number.isFinite(xLo)) return null;
      return (xHi - xLo) / 2;
    };
    let worst = Infinity, worstAt = null;
    for (let i = 0; i <= 10; i++) {
      const t01 = 0.20 + (0.16 * i) / 10;
      const a = widthAt(legs[0], t01), b = widthAt(legs[3], t01);
      if (a == null || b == null || a <= 0 || b <= 0) continue;
      const ratio = Math.max(a / b, b / a);
      if (ratio < worst) {
        worst = ratio;
        worstAt = `t${t01.toFixed(2)} 진입 ${(a * 100).toFixed(1)}% ↔ 리빌 ${(b * 100).toFixed(1)}%`;
      }
    }
    row.scaleSplit = Number.isFinite(worst) ? `${worst.toFixed(2)}× (${worstAt})` : 'n/a';
    check(!Number.isFinite(worst) || worst >= SCALE_SPLIT_MIN,
      `T18 ${row.scale}: 진입↔리빌 본체 피사체 배율 비 ${worst.toFixed(2)}× < ${SCALE_SPLIT_MIN}× — ${worstAt}`
      + ' (방위가 달라도 같은 크기로 맺히면 같은 엽서다)');
  }

  // ── T12 역광 ──
  {
    const first = legs[0].sample(0), last = legs[3].sample(1);
    const bearing = (s) => Math.atan2(s.lookAt.x - s.pos.x, s.lookAt.z - s.pos.z);
    const inBand = (s) => angDiff(bearing(s), SUN_AZ);
    row.backlit = `진입 ${(inBand(first) / DEG).toFixed(1)}° · 리빌 ${(inBand(last) / DEG).toFixed(1)}°`;
    check(inBand(first) <= BACKLIT_MAX,
      `T12 ${row.scale}: 진입 첫 프레임 태양-시선 이각 ${(inBand(first) / DEG).toFixed(1)}° > ${(BACKLIT_MAX / DEG).toFixed(0)}°`);
    check(inBand(last) <= BACKLIT_MAX,
      `T12 ${row.scale}: 리빌 마지막 프레임 태양-시선 이각 ${(inBand(last) / DEG).toFixed(1)}° > ${(BACKLIT_MAX / DEG).toFixed(0)}°`);
    // 오빗 완전 역광 순간(카메라가 태양 반대편) — 구간 중반에 있어야 rim 이 스윕 가운데서 터진다.
    let bestT = 0, bestAng = Infinity;
    for (let i = 0; i <= 400; i++) {
      const s = legs[1].sample(i / 400);
      const a = angDiff(bearing(s), SUN_AZ);
      if (a < bestAng) { bestAng = a; bestT = i / 400; }
    }
    row.orbitBacklit = `t=${bestT.toFixed(3)} (이각 ${(bestAng / DEG).toFixed(1)}°)`;
    check(bestAng < 6 * DEG && bestT >= 0.25 && bestT <= 0.7,
      `T12 ${row.scale}: 오빗 완전 역광 지점 t=${bestT.toFixed(3)} 이각 ${(bestAng / DEG).toFixed(1)}° (0.25~0.7 · <6° 요구)`);
  }

  // ── T11 결정론 ──
  {
    const sameA = createDronePaths({ site, plan, heightAt: H, seed: c.seed, sunAzimuth: SUN_AZ });
    const sameB = createDronePaths({ site, plan, heightAt: H, seed: c.seed, sunAzimuth: SUN_AZ });
    const other = createDronePaths({ site, plan, heightAt: H, seed: (c.seed ^ 0x5f5f) >>> 0, sunAzimuth: SUN_AZ });
    const noSunA = createDronePaths({ site, plan, heightAt: H, seed: c.seed });
    const noSunB = createDronePaths({ site, plan, heightAt: H, seed: c.seed });
    const delta = (a, b) => {
      let d = 0;
      for (let k = 0; k < a.length; k++) {
        for (const t of [0.07, 0.29, 0.53, 0.81, 1]) {
          const pa = a[k].sample(t).pos, pb = b[k].sample(t).pos;
          d = Math.max(d, Math.hypot(pa.x - pb.x, pa.y - pb.y, pa.z - pb.z));
        }
      }
      return d;
    };
    const same = delta(sameA, sameB);
    const varied = delta(sameA, other);
    const noSun = delta(noSunA, noSunB);
    row.determinism = `동일시드 ${same.toExponential(1)}m · 다른시드 ${varied.toFixed(1)}m · 태양없음 ${noSun.toExponential(1)}m`;
    check(same < 1e-9, `T11 ${row.scale}: 같은 시드가 다른 투어를 만든다 (${same})`);
    check(noSun < 1e-9, `T11 ${row.scale}: sunAzimuth 미제공 경로가 비결정적 (${noSun})`);
    check(varied > 1.0, `T11 ${row.scale}: 다른 시드가 같은 투어를 만든다 (delta ${varied.toFixed(3)}m — 시드 변주 미작동)`);
  }

  // ── W1~W6 자동산책 (태스크 #33 범위, 회귀 방지용 유지) ──
  if (c.walk) {
    const walker = M.createWalker({ site, plan, heightAt: H });
    walker.startAutoStroll();
    const spawn = { x: walker.pos.x, z: walker.pos.z };
    let pitchMin = Infinity, pitchMax = -Infinity, maxTurn = 0;
    let zeroDensity = 0, samples = 0, worstAt = null;
    let walkedMaxHits = 0;
    const walkPath = [];
    for (let frame = 0; frame < Math.round(WALK_SECONDS / DT); frame++) {
      walker.update(DT, {});
      maxTurn = Math.max(maxTurn, Math.abs(walker.turnRate()));
      if (frame * DT > 1.0) {
        const pd = walker.pitch / DEG;
        if (pd < pitchMin) pitchMin = pd;
        if (pd > pitchMax) pitchMax = pd;
      }
      if (frame % 15 === 0) {
        samples++;
        walkPath.push({ x: walker.pos.x, z: walker.pos.z, az: Math.atan2(walker.dir.x, walker.dir.z) });
        const h = densityProbe(obs, walker.pos.x, walker.pos.z, discR).hits;
        if (h > walkedMaxHits) walkedMaxHits = h;
        if (h === 0) {
          zeroDensity++;
          if (!worstAt) worstAt = `${walker.pos.x.toFixed(0)},${walker.pos.z.toFixed(0)}@${(frame * DT).toFixed(0)}s`;
        }
      }
    }
    row.walkPitch = [+pitchMin.toFixed(2), +pitchMax.toFixed(2)];
    row.walkMaxTurn = +(maxTurn / DEG).toFixed(2);
    row.walkZeroDensity = `${zeroDensity}/${samples}`;
    row.walkSpawnHits = densityProbe(obs, spawn.x, spawn.z, discR).hits;
    row.walkTurnarounds = walker.turnaroundCount();
    check(pitchMin >= -9.01 && pitchMax <= -6.0,
      `W1 ${row.scale}: 자동산책 pitch ${pitchMin.toFixed(2)}~${pitchMax.toFixed(2)}° 가 -9~-6° 밴드 밖`);
    check(maxTurn <= 26.01 * DEG,
      `W2 ${row.scale}: 자동산책 회전 ${(maxTurn / DEG).toFixed(2)}°/s > 26°/s`);
    check(row.walkSpawnHits > 0,
      `W3 ${row.scale}: 자동산책 스폰이 밀도 0 지점 (${spawn.x.toFixed(1)}, ${spawn.z.toFixed(1)})`);
    check(zeroDensity === 0,
      `W3 ${row.scale}: 자동산책 경로가 밀도 0 구간을 ${zeroDensity}/${samples} 지나감 (예: ${worstAt})`);
    // 스폰이 걸어간 경로 전체의 밀도 최대치와 같아야 한다 — 스팬 끝점(시가지 경계)이면 최대가 아니다.
    // 원판 밀도는 이산 표본이라 최대치의 80% 를 하한으로 둔다.
    check(row.walkSpawnHits >= walkedMaxHits * 0.8,
      `W3 ${row.scale}: 스폰 밀도 ${row.walkSpawnHits} < 경로 최대 밀도 ${walkedMaxHits} 의 80% (스폰이 가로 심부가 아니다)`);

    // ── W5 담장선 접근 ── 담이 8m 안에 있는 구간에서 중앙값 이격이 밴드 안이고, 충돌 0.
    const WALL_PROBE_MAX = 8;
    const WALL_HUG_MEDIAN = 2.5;
    const BODY_RADIUS = 0.45;
    const solids = M.buildWalkSolids(plan, H);
    const clearanceAt = (px, pz) => {
      let lo = 0, hi = WALL_PROBE_MAX;
      if (!M.pointHitsWalkSolids(solids, px, pz, hi)) return hi;
      for (let k = 0; k < 20; k++) {
        const mid = (lo + hi) / 2;
        if (M.pointHitsWalkSolids(solids, px, pz, mid)) hi = mid; else lo = mid;
      }
      return hi;
    };
    const near = walkPath.map((q) => clearanceAt(q.x, q.z)).filter((v) => v < WALL_PROBE_MAX - 1e-6);
    near.sort((a, b) => a - b);
    const all = walkPath.map((q) => clearanceAt(q.x, q.z));
    row.wallMin = +Math.min(...all).toFixed(2);
    row.wallNearFrac = `${near.length}/${all.length}`;
    row.wallMedian = near.length ? +near[Math.floor(near.length / 2)].toFixed(2) : null;
    check(Math.min(...all) >= BODY_RADIUS - 1e-6,
      `W5 ${row.scale}: 경로 최근접 solid 거리 ${Math.min(...all).toFixed(2)}m < BODY ${BODY_RADIUS}m (담 침범)`);
    let travelled = 0;
    for (let i = 1; i < walkPath.length; i++) {
      travelled += Math.hypot(walkPath[i].x - walkPath[i - 1].x, walkPath[i].z - walkPath[i - 1].z);
    }
    row.walkTravel = Math.round(travelled);
    check(travelled >= WALK_SECONDS * 1.4 * 0.35,
      `W5 ${row.scale}: ${WALK_SECONDS}s 동안 ${Math.round(travelled)}m 만 이동 (충돌 슬라이드 상시 발생 의심)`);
    check(near.length === 0 || row.wallMedian <= WALL_HUG_MEDIAN,
      `W5 ${row.scale}: 담 근접 구간 중앙값 이격 ${row.wallMedian}m > ${WALL_HUG_MEDIAN}m (노면 중앙을 걷는다)`);

    // ── W6 하단 프레임 대역 담 점유율 ──
    {
      const LOWER_BAND_MIN = 0.6;
      let band = 0;
      for (const q of walkPath) {
        let found = false;
        for (let d = 2.7; d <= 12.2 + 1e-6 && !found; d += 1.0) {
          for (let o = -3; o <= 3 + 1e-6; o += 1.0) {
            const qx = q.x + Math.sin(q.az) * d + Math.cos(q.az) * o;
            const qz = q.z + Math.cos(q.az) * d - Math.sin(q.az) * o;
            if (M.pointHitsWalkSolids(solids, qx, qz, 0.05)) { found = true; break; }
          }
        }
        if (found) band++;
      }
      row.lowerBand = `${Math.round((band / walkPath.length) * 100)}% (${band}/${walkPath.length})`;
      check(band / walkPath.length >= LOWER_BAND_MIN,
        `W6 ${row.scale}: 하단 프레임 대역 담 점유율 ${Math.round((band / walkPath.length) * 100)}% < ${LOWER_BAND_MIN * 100}%`);
    }

    // ── W4 수동 조작이 pitch 를 인수 ──
    const manual = M.createWalker({ site, plan, heightAt: H });
    manual.startAutoStroll();
    for (let frame = 0; frame < 180; frame++) manual.update(DT, {});
    manual.stopAutoStroll();
    for (let frame = 0; frame < 60; frame++) manual.update(DT, { pitch: 4 * DEG });
    row.walkManualPitch = +(manual.pitch / DEG).toFixed(2);
    check(row.walkManualPitch > 20,
      `W4 ${row.scale}: 수동 pitch 입력이 자동 밴드에 눌렸다 (${row.walkManualPitch}°)`);
  }

  report.push(row);
}

console.log('\n=== 드론 연속 투어 + 도보 품질 계약 (#32 재저작 2026-08-01) ===');
console.log(`태양 방위 sunAz = ${(SUN_AZ / DEG).toFixed(1)}° (sunset preset), 역광 카메라 방위 = ${(norm(SUN_AZ + Math.PI) / DEG).toFixed(1)}°`);
for (const r of report) {
  console.log(`\n[${r.scale}] R=${r.R} 보호수 ${r.canopies}주 · 투어 ${r.total}s / ${r.arc}m / ${r.frames}프레임`);
  console.log(`  구간       : ${r.legs}`);
  console.log(`  소재       : primary ${r.primary} · ${r.axes} · orbit ${r.orbitSpec}`);
  console.log(`  이음매     : ${r.seam}`);
  console.log(`  속도       : ${r.speed}`);
  console.log(`  시선       : ${r.ang}`);
  console.log(`  클리어런스 : ${r.clear} · 수관여유 ${r.canopyGap}m`);
  console.log(`  어휘       : 저공 ${r.lowBand} · 선회창 ${r.orbitWindow} ${r.orbit}`);
  console.log(`               선회 프로파일 ${r.orbitProfile}`);
  console.log(`  피사체     : ${r.subject}`);
  console.log(`  프레임     : 피치 median ${r.pitch}° (전범위 ${r.pitchRange}°, 정점 ${r.apex}) 하늘 ${r.sky} 하단무특징 ${r.bare} 전경밀착 ${r.hug}`);
  console.log(`               주 피사체 ${r.subjectFrame}`);
  console.log(`               저공 최전경 접지 ${r.frontMass} · 하단중앙20% ${r.centre} · 능선 위 밴드 리빌 ${r.ridge3}`);
  console.log(`  구간중복   : ${r.dup}  (최약 ${r.dupWorst})`);
  console.log(`  배율분리   : 진입↔리빌 ${r.scaleSplit}`);
  console.log(`  역광       : ${r.backlit} · 오빗 ${r.orbitBacklit}`);
  console.log(`  결정론     : ${r.determinism}`);
  if (r.walkPitch) {
    console.log(`  walk ${WALK_SECONDS}s : pitch ${r.walkPitch.join('~')}°  회전상한 ${r.walkMaxTurn}°/s  밀도0 ${r.walkZeroDensity}  스폰히트 ${r.walkSpawnHits}  반환 ${r.walkTurnarounds}  수동pitch ${r.walkManualPitch}°`);
    console.log(`               하단대역 담 점유 ${r.lowerBand} · 담 이격 min ${r.wallMin}m 근접 ${r.wallNearFrac} 중앙값 ${r.wallMedian}m 이동 ${r.walkTravel}m`);
  }
}

console.log('');
if (failures.length) {
  for (const f of failures) console.log(`FAIL ${f}`);
  console.log(`\ncine quality contract: FAIL (${failures.length})`);
  process.exit(1);
}
console.log('cine quality contract: PASS');
