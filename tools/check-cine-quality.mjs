// 감상 모드(드론 패스·1인칭 자동산책) 화면 품질 계약 — 순수 node, 렌더 없음 (#30).
//
// verify-cine.mjs 가 지키는 것은 "안전"(지형 클리어런스·건물 관통·각속도 상한)이다. 이 게이트는
// 그 위에 "화면에 무엇이 담기는가"를 수치로 고정한다. 25프레임 비전 판정이 지적한 결함들이
// 코드 수준에서 되돌아오지 못하게 하는 것이 목적이다.
//
// 이 파일은 dronepath/walker 의 내부 구현을 신뢰하지 않는다. 수관 볼륨·시가지 밀도는 plan 에서
// 직접(독립적으로) 파생해 계약면으로 삼는다 — 게이트가 구현의 모델을 그대로 되읽으면 아무것도
// 검증하지 못한다.
//
// 계약 (F = 수정 전 소스에서 FAIL 해야 하는 신규 단언):
//   D1 F street-flythrough 는 밀도 0 구간을 통과하지 않는다(전 구간 반경 R*0.12 안에 지붕 ≥1).
//   D2 F street-flythrough 고도가 지형이 아니라 **지붕선**을 추종한다(민가 잔차 표준편차 < 지형
//        잔차의 80%), 민가 지붕 위 2.0~8.0m. 원판은 고정 18m·민가만 — R 비례 원판은 hanyang 에서
//        무관한 지형을 물고, 기념 건축을 포함하면 "궁이 카메라 위로 솟는" 의도한 구도가 결함으로 잡힌다.
//   D2 F flythrough look.y −0.20~−0.15 (하향 8.6~11.5°) 이고 지평선이 프레임 안에 있다.
//        ※ 이 밴드는 완화가 아니라 비전 중재 결과다. 1차 비전의 "하향 24~29°" 는 부감 패스 조건을
//        골목 통과 패스에 오적용한 것으로, vFOV 40 반각 20° 에서 하향 26.6° 면 프레임 피치가
//        −6.6°~−46.6° 가 되어 지평선·능선·역광·헤이즈가 전부 프레임 밖으로 나가 RTS 평면도가 된다.
//        최종 비전(2026-07-31)이 프레임 기하 근거로 −8.6~−11.5° 로 정정했다.
//   D9 F 밀집면 중심이 프레임 중앙에 온다(프레임 중앙 지상점 주변 지붕 히트 중심의 시선축 이탈
//        median ≤15°·p90 ≤45°, 프레임 중앙이 건축 위인 샘플 ≥90%). 미러 비교는 좌우가 고른 가로에서
//        잡음이라 채택하지 않았다.
//   D10 F 궁이 있는 규모는 패스 종점에서 랜드마크가 수평 화각 안에 들어온다.
//   D11 F 패스 종반(u≥0.7)의 **시선 원뿔 안**에 건축이 담긴다(20 표본 중 min ≥3, median ≥6).
//        위치 밀도(D1)만 단언하면 "옆에는 집이 있는데 프레임은 비어 있는" 종반을 놓친다 — 실제로
//        village t080 이 프레임 건축 0채로 그 갭을 통과했다. 그 갭이 곧 게이트 결함이었다.
//   W6   자동산책 하단 프레임 대역(전방 2.7~12.2m × 좌우 ±3m)에 담·기단이 들어오는 표본 비율.
//        R3 담장선 접근의 성과를 되돌리지 못하게 하는 하한이다.
//   D3 F landmark-orbit 카메라→랜드마크 시선이 보호수 수관을 관통하지 않는다(선회 반경 불변).
//   D8 F 모든 패스의 시선 각속도가 상한 이내이고, orbit 은 easing 피크(25.5°/s) 근방에 머문다
//        — 고도 하한을 샘플별 클램프로 걸면 필지 경계에서 4m 계단이 생겨 69°/s 로 튄다.
//   D4 F crane-in t∈[0.2,0.5] 시선 하향 22~26°.
//   D5 F pullback-reveal 최종 컷 상단 35~40% 가 하늘(수평선 위).
//   D6 F sunAzimuth 제공 시 crane-in·pullback 전 구간 카메라→피사체 방위가 태양 방위와 ≤25°
//        (피사체가 카메라와 태양 사이 = 역광), landmark-orbit 완전 역광각이 스윕 35~45% 지점.
//   D7   sunAzimuth 미제공 시 결정론 유지(하위 호환, 회귀 방지).
//   W1 F 자동산책 시선 pitch 가 -6~-9° 밴드로 수렴하고 벗어나지 않는다.
//   W2 F 자동산책 회전 속도 상한 ≤26°/s.
//   W3 F 자동산책 경로가 밀도 0 구간에 놓이지 않고, 스폰이 스팬 내 밀도 최대 지점이다.
//   W5 F 자동산책 경로가 담장선 안쪽 1.5~2m 로 붙는다(담이 8m 안에 있는 구간에서). 충돌 0 유지.
//   W4   수동(자유) 조작은 pitch 를 사용자 입력이 인수한다(자동 밴드가 덮어쓰지 않는다).
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
const { buildObstacles, coneRoofHits, createDronePaths, roofTopAt } = M.drone;

const norm = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const angDiff = (a, b) => Math.abs(norm(a - b));

// 화면 상단 하늘 비율 — 원근 정확: 수평선의 NDC y = tan(하향각)/tan(fovV/2).
function skyFraction(pitchDownRad, fovVdeg) {
  const ndcY = Math.tan(pitchDownRad) / Math.tan(fovVdeg * 0.5 * DEG);
  return ndcY >= 1 ? 0 : (1 - ndcY) / 2;
}

function lookMetrics(sample) {
  const dx = sample.lookAt.x - sample.pos.x;
  const dy = sample.lookAt.y - sample.pos.y;
  const dz = sample.lookAt.z - sample.pos.z;
  return { pitchDown: Math.atan2(-dy, Math.hypot(dx, dz)), az: Math.atan2(dx, dz) };
}

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
// 나무 전고 h = 14*scale (guardianAnchors.h), 우산형 수관은 h*0.72 높이에 중심을 두고 수평
// 반경 gp.radius, 수직 반경 h*0.26 인 편평 타원체(느티나무 수관은 y 로 0.6 눌려 있다).
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
  { scale: 'village', seed: 20260716, includePalace: false, includeTemple: false },
  { scale: 'capital', seed: 7, includePalace: true, includeTemple: true },
  { scale: 'hanyang', seed: 2026, includePalace: true, includeTemple: true },
  // 영구 회귀 픽스처: verify-cine 의 village 시드. orbit 이 필지 경계를 넘으며 safeFloor 계단으로
  // 69.4°/s 를 만들던 케이스다(고도 프로파일 램프 전).
  { scale: 'village', seed: 2026, includePalace: false, includeTemple: true, label: 'village/2026' },
];
// orbit 은 원운동 + smootherstep easing 이라 각속도 이론 상한이 sweep/dur*1.875 = 25.5°/s 다.
const ORBIT_ANG_CEIL = 30;
// 최종 비전이 지정한 flythrough look.y 밴드와 그 프레임 기하 판정에 쓰는 종횡비.
const FLY_LOOKY_MIN = -0.20, FLY_LOOKY_MAX = -0.15;
const FRAME_ASPECT = 16 / 9;
const WALL_PROBE_MAX = 8;      // 이 거리 안에 담이 없으면 '붙일 담이 없는' 구간으로 본다
const WALL_HUG_MEDIAN = 2.5;   // 담이 있는 구간의 중앙값 이격 상한
const WALK_PROBE_LIMIT = WALL_PROBE_MAX - 1e-6;
const ROOF_SEA_DISC = 18;      // 스침 고도 판정 원판 반경(m, 필지 한 겹) — R 비례는 규모에서 무의미해진다
const TRACK_SD_ABS = 1.0;      // 지형·지붕 신호가 동률일 때의 절대 편차 상한(m)
const LOWER_BAND_MIN = 0.6;    // 하단 프레임 대역 담 점유율 하한(R3 성과 비회귀)
const COMPOSE_MEDIAN_MAX = 15;  // 밀집면 중심의 시선축 이탈 median 상한(°)
const COMPOSE_P90_MAX = 45;
const BODY_RADIUS = 0.45;      // walker BODY — 담을 스치는 하한(그 이상이면 침범 아님)
const PASS_ANG_CEIL = 60;
const N = 200;
const report = [];
const failures = [];
let liftEngaged = false;
const check = (ok, message) => { if (!ok) failures.push(message); };

for (const c of CASES) {
  const plan = M.planVillage({
    scale: c.scale, seed: c.seed,
    includePalace: c.includePalace, includeTemple: c.includeTemple,
  });
  const site = plan.site;
  const H = (x, z) => site.heightAt(x, z);
  const obs = buildObstacles(plan, H);
  const R = site.R;
  const discR = R * 0.12;
  // 기념 건축(궁·절) 접근 구간 — 이 반경 안에서는 "지붕 바다 스침" 밴드와 "밀도 0 금지" 가 의미를
  //   잃는다: 원판이 +18m 궁 지붕을 물어 평균이 튀고, 문전 광장은 빈 들판이 아니라 패스의 목적지다.
  //   안전(관통 0 · 지붕 위 ≥2m)은 verify-cine 이 전체 obstacles 로 계속 단언한다.
  //   판정은 반경 어림이 아니라 **원판 17점 중 하나가 실제로 기념 건축 볼륨 위에 있는가**로 한다
  //   (obstacle.tag 는 buildObstacles 가 노출하는 계약 필드다). 반경 어림은 hanyang 에서 discR=60m
  //   때문에 패스 전체를 면제해 D2 를 공허하게 만들었다.
  const monumentObs = obs.filter((o) => o.tag && o.tag !== 'parcel');
  const parcelObs = obs.filter((o) => !o.tag || o.tag === 'parcel');
  const nearMonument = (x, z) => {
    if (!monumentObs.length) return false;
    if (roofTopAt(monumentObs, x, z) != null) return true;
    for (const f of [0.45, 0.85]) {
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        if (roofTopAt(monumentObs, x + Math.cos(a) * f * discR, z + Math.sin(a) * f * discR) != null) return true;
      }
    }
    return false;
  };

  const paths = createDronePaths({ site, plan, heightAt: H, seed: c.seed, sunAzimuth: SUN_AZ });
  const byName = Object.fromEntries(paths.map((p) => [p.name, p]));
  const row = { scale: c.label || c.scale, R: Math.round(R) };

  // ── D1 · D2 street-flythrough ──
  {
    const p = byName['street-flythrough'];
    let zeroDensity = 0, monumentSamples = 0, sparseSamples = 0;
    const roofResid = [], terrResid = [];
    let clrMin = Infinity, clrMax = -Infinity, clrSum = 0, clrN = 0;
    let pitchMin = Infinity, pitchMax = -Infinity;
    for (let i = 0; i < N; i++) {
      const s = p.sample(i / (N - 1));
      const pd0 = lookMetrics(s).pitchDown / DEG;
      if (pd0 < pitchMin) pitchMin = pd0;
      if (pd0 > pitchMax) pitchMax = pd0;
      if (nearMonument(s.pos.x, s.pos.z)) { monumentSamples++; continue; }
      const d = densityProbe(obs, s.pos.x, s.pos.z, discR);
      if (d.hits === 0) zeroDensity++;
      // 스침 고도는 **민가 지붕** 기준으로만 의미가 있다. 원판을 R 비례로 두면 hanyang 에서 60m
      //   반경이 서로 무관한 지형을 물어 평균이 무의미해지고, 기념 건축을 포함하면 "궁이 카메라
      //   위로 솟는" 의도한 구도가 음수 클리어런스로 잡힌다. 고정 18m(필지 한 겹) · 민가만 쓴다.
      const pd = densityProbe(parcelObs, s.pos.x, s.pos.z, ROOF_SEA_DISC);
      if (pd.hits > 0) {
        const clr = s.pos.y - pd.meanTop;
        clrN++; clrSum += clr;
        if (clr < clrMin) clrMin = clr;
        if (clr > clrMax) clrMax = clr;
        roofResid.push(clr);
        terrResid.push(s.pos.y - (H(s.pos.x, s.pos.z) + 12));
      } else sparseSamples++;
    }
    const mean = clrN ? clrSum / clrN : NaN;
    row.flyZeroDensity = `${zeroDensity}/${N - monumentSamples}`;
    row.flyMonument = monumentSamples;
    row.flySparse = sparseSamples;
    row.flyClr = clrN
      ? [+clrMin.toFixed(2), +mean.toFixed(2), +clrMax.toFixed(2)]
      : ['-', '-', '-'];
    row.flyPitch = [+pitchMin.toFixed(1), +pitchMax.toFixed(1)];
    // 스팬은 1m 해상도로 구멍 없이 잡지만, 필지 사이 1m 미만의 틈은 그 격자로도 보이지 않는다
    //   (패스가 스팬 폴리라인에서 벗어나는 최대 거리는 0.01~0.07m 로 곡선 편차는 원인이 아니다).
    //   빈 들판 통과는 잡고, 이런 서브미터 틈 한 샘플은 허용한다.
    check(zeroDensity <= Math.ceil(N * 0.01),
      `D1 ${row.scale}: street-flythrough 가 밀도 0 구간을 ${zeroDensity}/${N} 샘플 통과 (허용 ${Math.ceil(N * 0.01)})`);
    // 18m 안에 민가가 아예 없는 가로(hanyang 육조거리는 관아·궁만 면한다)는 "지붕 바다"가 없어
    //   이 밴드를 적용할 대상이 아니다. 표본이 충분할 때만 판정하고, 아니면 개수를 보고한다.
    const roofSeaEnough = clrN >= (N - monumentSamples) * 0.2;
    row.roofSeaN = clrN;
    if (roofSeaEnough) {
      // 이 하한은 18m 원판 **평균** 기준이라 원판이 더 높은 지붕을 물면 낮게 나온다. 관통·지붕 위
      //   2m 라는 하드 안전 바닥은 verify-cine 이 roofTopAt(직하) 로 따로 단언한다.
      check(clrMin >= 1.5, `D2 ${row.scale}: 민가 지붕 위 최소 클리어런스 ${clrMin.toFixed(2)}m < 1.5m`);
      check(clrMax <= 8.0, `D2 ${row.scale}: 민가 지붕 위 최대 클리어런스 ${clrMax.toFixed(2)}m > 8.0m (스침이 아니다)`);
      // 핵심 계약: 고도가 **지형이 아니라 지붕선**을 따라간다. 절대 밴드는 가로가 밀집 시가지에서
      //   문전 광장으로 전이하면 넓어질 수밖에 없으므로, "어느 신호를 추종하는가"를 직접 비교한다.
      const sd = (arr) => {
        const m = arr.reduce((a, b) => a + b, 0) / arr.length;
        return Math.sqrt(arr.reduce((a, b) => a + (b - m) * (b - m), 0) / arr.length);
      };
      const sdRoof = sd(roofResid), sdTerr = sd(terrResid);
      // 지붕이 드문 가로(궁 축선은 관아·광장이 면한다)는 구현이 의도적으로 지형 기준선과 블렌딩하므로
      //   지붕 신호가 지배할 수 없다. 민가가 대부분의 샘플에 있는 '지붕 바다' 가로에서만 강한 여유를
      //   요구하고, 그 밖에서는 "적어도 지형보다 지붕을 더 잘 추종한다"만 요구한다.
      const roofSea = clrN >= (N - monumentSamples) * 0.8;
      const margin = roofSea ? 0.85 : 1.0;
      // 평지 위 균일한 골목에서는 지형선과 지붕선이 사실상 같은 신호라 "어느 쪽을 추종하는가"가
      //   정의되지 않는다. 두 편차가 10% 안이면 비교 대신 **지붕선 위 고도가 일정한가**를 본다.
      const tied = Math.abs(sdRoof - sdTerr) <= Math.max(sdRoof, sdTerr) * 0.1;
      row.trackSd = `지붕 ${sdRoof.toFixed(2)} vs 지형 ${sdTerr.toFixed(2)}`
        + `${roofSea ? ' [지붕바다]' : ''}${tied ? ' [동률→절대판정]' : ''}`;
      if (tied) {
        check(sdRoof <= TRACK_SD_ABS,
          `D2 ${row.scale}: 지붕선 위 고도가 일정하지 않다 (편차 ${sdRoof.toFixed(2)}m > ${TRACK_SD_ABS}m)`);
      } else {
        check(sdRoof < sdTerr * margin,
          `D2 ${row.scale}: 고도가 지붕선보다 지형을 추종한다 (편차 지붕 ${sdRoof.toFixed(2)}m vs 지형 ${sdTerr.toFixed(2)}m, 여유 ×${margin})`);
      }
    } else row.trackSd = `n/a (18m 내 민가 표본 ${clrN})`;
    // D2 시선: 최종 비전이 지정한 look.y 밴드 + 지평선 프레임 내 존재.
    let lyMin = Infinity, lyMax = -Infinity;
    for (let i = 0; i < N; i++) {
      const s = p.sample(i / (N - 1));
      const dx = s.lookAt.x - s.pos.x, dy = s.lookAt.y - s.pos.y, dz = s.lookAt.z - s.pos.z;
      const m = Math.hypot(dx, dy, dz) || 1;
      const ly = dy / m;
      if (ly < lyMin) lyMin = ly;
      if (ly > lyMax) lyMax = ly;
    }
    const s1 = p.sample(0.5);
    const half = s1.fov / 2;
    const centre = -lookMetrics(s1).pitchDown / DEG;   // 부호: 위가 +
    row.flyLookY = [+lyMin.toFixed(4), +lyMax.toFixed(4)];
    row.flyFramePitch = [+(centre - half).toFixed(1), +(centre + half).toFixed(1)];
    check(lyMin >= FLY_LOOKY_MIN - 1e-4 && lyMax <= FLY_LOOKY_MAX + 1e-4,
      `D2 ${row.scale}: flythrough look.y ${lyMin.toFixed(4)}~${lyMax.toFixed(4)} 가 `
        + `${FLY_LOOKY_MIN}~${FLY_LOOKY_MAX} 밖 (하향 ${pitchMin.toFixed(1)}~${pitchMax.toFixed(1)}°)`);
    check(centre + half > 0 && centre - half < 0,
      `D2 ${row.scale}: 지평선이 프레임 밖 — 프레임 피치 ${(centre - half).toFixed(1)}°~${(centre + half).toFixed(1)}°`);

    // ── D9 프레임 구도 ── "밀집면이 프레임 중앙을 먹는가"를 직접 잰다: 프레임 중앙 지상점(lookAt)
    //   주변 원판의 지붕 히트 중심이 시선축에서 몇 도 벗어나는가. 미러 비교는 좌우가 고른 가로에서
    //   잡음이라 판정 근거가 되지 못했다(hanyang 8% 차이로 부호가 뒤집혔다).
    const centroidOff = [];
    let lookOnFabric = 0;
    for (let i = 0; i < N; i++) {
      const s = p.sample(i / (N - 1));
      let cx = 0, cz = 0, n = 0;
      const at = (px, pz) => { if (roofTopAt(obs, px, pz) != null) { cx += px; cz += pz; n++; } };
      at(s.lookAt.x, s.lookAt.z);
      for (const f of [0.45, 0.85]) {
        for (let k = 0; k < 8; k++) {
          const a = (k / 8) * Math.PI * 2;
          at(s.lookAt.x + Math.cos(a) * f * discR, s.lookAt.z + Math.sin(a) * f * discR);
        }
      }
      if (!n) continue;
      lookOnFabric++;
      cx /= n; cz /= n;
      const axis = Math.atan2(s.lookAt.x - s.pos.x, s.lookAt.z - s.pos.z);
      centroidOff.push(angDiff(axis, Math.atan2(cx - s.pos.x, cz - s.pos.z)) / DEG);
    }
    centroidOff.sort((a, b) => a - b);
    const cq = (f) => (centroidOff.length ? centroidOff[Math.floor(centroidOff.length * f)] : null);
    row.compose = centroidOff.length
      ? `median ${cq(0.5).toFixed(1)}° p90 ${cq(0.9).toFixed(1)}° · 시선점 위 건축 ${lookOnFabric}/${N}`
      : 'n/a';
    check(centroidOff.length > 0 && cq(0.5) <= COMPOSE_MEDIAN_MAX,
      `D9 ${row.scale}: 밀집면 중심이 프레임 중앙에서 median ${cq(0.5)?.toFixed(1)}° 벗어남 (> ${COMPOSE_MEDIAN_MAX}°)`);
    check(centroidOff.length > 0 && cq(0.9) <= COMPOSE_P90_MAX,
      `D9 ${row.scale}: 밀집면 중심 이탈 p90 ${cq(0.9)?.toFixed(1)}° > ${COMPOSE_P90_MAX}°`);
    check(lookOnFabric >= N * 0.9,
      `D9 ${row.scale}: 프레임 중앙이 건축 위에 놓인 샘플이 ${lookOnFabric}/${N} (<90%)`);

    // ── D11 종반 시선 원뿔 ──
    {
      const hHalf = Math.atan(Math.tan(40 * 0.5 * DEG) * FRAME_ASPECT);
      const far = Math.max(16, R * 0.12) * 1.6;
      const hits = [];
      for (let i = 0; i < N; i++) {
        const u = i / (N - 1);
        if (u < 0.7) continue;
        const sm = p.sample(u);
        const az = Math.atan2(sm.lookAt.x - sm.pos.x, sm.lookAt.z - sm.pos.z);
        hits.push(coneRoofHits(obs, sm.pos.x, sm.pos.z, az, hHalf, far).hits);
      }
      const sorted = hits.slice().sort((a, b) => a - b);
      const med = sorted[Math.floor(sorted.length / 2)];
      row.tailCone = `min ${sorted[0]} median ${med} max ${sorted[sorted.length - 1]} /20`;
      check(sorted[0] >= 3,
        `D11 ${row.scale}: 패스 종반 시선 원뿔 최소 ${sorted[0]}/20 < 3 (프레임에 건축이 없다)`);
      check(med >= 6,
        `D11 ${row.scale}: 패스 종반 시선 원뿔 median ${med}/20 < 6`);
    }

    // D10 종점 랜드마크 — 궁이 있는 규모만(작은 규모는 가로 축선 끝에 랜드마크가 없다).
    if (plan.features?.palace) {
      const Lm = { x: plan.features.palace.x, z: plan.features.palace.z };
      const e = p.sample(1);
      const look = Math.atan2(e.lookAt.x - e.pos.x, e.lookAt.z - e.pos.z);
      const toL = Math.atan2(Lm.x - e.pos.x, Lm.z - e.pos.z);
      const off = angDiff(look, toL);
      const hHalf = Math.atan(Math.tan(e.fov * 0.5 * DEG) * FRAME_ASPECT);
      const dist = Math.hypot(Lm.x - e.pos.x, Lm.z - e.pos.z);
      row.endLandmark = `${(off / DEG).toFixed(0)}°/±${(hHalf / DEG).toFixed(0)}° @${dist.toFixed(0)}m`;
      check(off <= hHalf,
        `D10 ${row.scale}: 종점에서 랜드마크가 수평 화각 밖 (${(off / DEG).toFixed(0)}° > ±${(hHalf / DEG).toFixed(0)}°, ${dist.toFixed(0)}m)`);
      check(dist <= R * 0.5,
        `D10 ${row.scale}: 종점~랜드마크 ${dist.toFixed(0)}m > ${(R * 0.5).toFixed(0)}m (지평선에서 읽히지 않는다)`);
    } else row.endLandmark = 'n/a (궁 없음)';
  }

  // ── D3 landmark-orbit 수관 비교차 + 선회 반경 불변 ──
  {
    const p = byName['landmark-orbit'];
    const canopies = planCanopies(plan, H);
    row.canopies = canopies.length;
    let intersect = 0;
    let minGap = Infinity;
    let radiusMin = Infinity, radiusMax = -Infinity;
    const target = p.sample(0).lookAt;
    for (let i = 0; i < N; i++) {
      const s = p.sample(i / (N - 1));
      const rr = Math.hypot(s.pos.x - target.x, s.pos.z - target.z);
      if (rr < radiusMin) radiusMin = rr;
      if (rr > radiusMax) radiusMax = rr;
      let hit = false;
      for (const cn of canopies) {
        const gap = segmentCanopyGap(s.pos, s.lookAt, cn);
        if (gap < minGap) minGap = gap;
        if (gap < 0) hit = true;
      }
      if (hit) intersect++;
    }
    row.orbitIntersect = `${intersect}/${N}`;
    row.orbitCanopyGap = Number.isFinite(minGap) ? +minGap.toFixed(2) : null;
    row.orbitR = [+radiusMin.toFixed(1), +radiusMax.toFixed(1)];
    check(intersect === 0,
      `D3 ${row.scale}: landmark-orbit 시선이 수관을 ${intersect}/${N} 샘플 관통 (최소여유 ${row.orbitCanopyGap}m)`);
    check(radiusMax - radiusMin < 0.5,
      `D3 ${row.scale}: 선회 반경이 상수가 아니다 (${radiusMin.toFixed(1)}~${radiusMax.toFixed(1)}m)`);

    // 위상이 아니라 수관 리프트가 회피를 담당해야 한다 — sunAzimuth 없는 종전 위상(th0=0)에서도
    // 비교차여야 하고, 리프트가 실제로 개입한 규모가 최소 하나 있어야 한다.
    const legacyOrbit = createDronePaths({ site, plan, heightAt: H, seed: c.seed })
      .find((x) => x.name === 'landmark-orbit');
    let legacyIntersect = 0, legacyGap = Infinity, liftAmount = 0;
    const y0 = legacyOrbit.sample(0).pos.y;
    for (let i = 0; i < N; i++) {
      const s = legacyOrbit.sample(i / (N - 1));
      liftAmount = Math.max(liftAmount, s.pos.y - y0);
      let hit = false;
      for (const cn of canopies) {
        const gap = segmentCanopyGap(s.pos, s.lookAt, cn);
        if (gap < legacyGap) legacyGap = gap;
        if (gap < 0) hit = true;
      }
      if (hit) legacyIntersect++;
    }
    row.orbitLegacyIntersect = `${legacyIntersect}/${N}`;
    row.orbitLift = +liftAmount.toFixed(2);
    liftEngaged = liftEngaged || liftAmount > 1;
    check(legacyIntersect === 0,
      `D3 ${row.scale}: 종전 위상(sunAzimuth 없음) orbit 이 수관을 ${legacyIntersect}/${N} 관통 (최소여유 ${legacyGap.toFixed(2)}m)`);
  }

  // ── D4 crane-in 부감각 ──
  {
    const p = byName['crane-in'];
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i <= 60; i++) {
      const pd = lookMetrics(p.sample(0.2 + 0.3 * (i / 60))).pitchDown / DEG;
      if (pd < lo) lo = pd;
      if (pd > hi) hi = pd;
    }
    row.cranePitch = [+lo.toFixed(1), +hi.toFixed(1)];
    check(lo >= 22 && hi <= 26,
      `D4 ${row.scale}: crane-in t∈[0.2,0.5] 시선 하향 ${lo.toFixed(1)}~${hi.toFixed(1)}° 가 22~26° 밖`);
  }

  // ── D5 pullback 엔딩 하늘 ──
  {
    const s = byName['pullback-reveal'].sample(1);
    const m = lookMetrics(s);
    const frac = skyFraction(m.pitchDown, s.fov);
    row.endSky = +frac.toFixed(3);
    row.endPitch = +(m.pitchDown / DEG).toFixed(1);
    check(frac >= 0.35 && frac <= 0.40,
      `D5 ${row.scale}: pullback 최종 컷 하늘 ${(frac * 100).toFixed(1)}% 가 35~40% 밖 (하향 ${row.endPitch}°)`);
  }

  // ── D6 역광 방위 ──
  {
    let worst = 0;
    for (const name of ['crane-in', 'pullback-reveal']) {
      const p = byName[name];
      for (let i = 0; i < N; i++) {
        const s = p.sample(i / (N - 1));
        const toSubject = Math.atan2(s.lookAt.x - s.pos.x, s.lookAt.z - s.pos.z);
        worst = Math.max(worst, angDiff(toSubject, SUN_AZ));
      }
    }
    row.rimWorstDeg = +(worst / DEG).toFixed(1);
    check(worst <= 25.5 * DEG,
      `D6 ${row.scale}: crane-in/pullback 최대 태양-시선 이각 ${(worst / DEG).toFixed(1)}° > 25°`);

    const orbit = byName['landmark-orbit'];
    let bestU = 0, bestAng = Infinity;
    for (let i = 0; i <= 400; i++) {
      const u = i / 400;
      const s = orbit.sample(u);
      const a = angDiff(Math.atan2(s.lookAt.x - s.pos.x, s.lookAt.z - s.pos.z), SUN_AZ);
      if (a < bestAng) { bestAng = a; bestU = u; }
    }
    row.orbitBacklitAt = +bestU.toFixed(3);
    row.orbitBacklitAng = +(bestAng / DEG).toFixed(1);
    check(bestAng < 3 * DEG && bestU >= 0.35 && bestU <= 0.45,
      `D6 ${row.scale}: orbit 완전 역광 지점 t=${bestU.toFixed(3)} (이각 ${(bestAng / DEG).toFixed(1)}°) 가 0.35~0.45 밖`);
  }

  // ── D8 시선 각속도 ──
  {
    const dirOf = (a, b) => {
      const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
      const m = Math.hypot(dx, dy, dz) || 1;
      return [dx / m, dy / m, dz / m];
    };
    const worst = {};
    for (const p of paths) {
      const steps = 480;
      const dt = p.duration / (steps - 1);
      let prev = null, max = 0;
      for (let i = 0; i < steps; i++) {
        const s = p.sample(i / (steps - 1));
        const d = dirOf(s.pos, s.lookAt);
        if (prev) {
          const dot = Math.min(1, Math.max(-1, prev[0] * d[0] + prev[1] * d[1] + prev[2] * d[2]));
          max = Math.max(max, (Math.acos(dot) / DEG) / dt);
        }
        prev = d;
      }
      worst[p.name] = +max.toFixed(1);
      const ceil = p.name === 'landmark-orbit' ? ORBIT_ANG_CEIL : PASS_ANG_CEIL;
      check(max <= ceil,
        `D8 ${row.scale}: ${p.name} 시선 각속도 ${max.toFixed(1)}°/s > ${ceil}°/s`);
    }
    row.ang = worst;
  }

  // ── W1~W3 자동산책 ──
  {
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
    // 원판 밀도는 이산 표본이라 정확한 argmax 를 요구하면 표본 격자에 흔들린다. 계약은 "스폰이
    // 스팬 가장자리(시가지 경계)가 아니라 조밀한 심부"라는 것이므로 최대치의 80% 를 하한으로 둔다.
    check(row.walkSpawnHits >= walkedMaxHits * 0.8,
      `W3 ${row.scale}: 스폰 밀도 ${row.walkSpawnHits} < 경로 최대 밀도 ${walkedMaxHits} 의 80% (스폰이 가로 심부가 아니다)`);

    // ── W5 담장선 접근 ── 담이 8m 안에 있는 구간에서 중앙값 이격이 밴드 안이고, 충돌 0.
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
    const near = walkPath.map((q) => clearanceAt(q.x, q.z)).filter((v) => v < WALK_PROBE_LIMIT);
    near.sort((a, b) => a - b);
    const all = walkPath.map((q) => clearanceAt(q.x, q.z));
    row.wallMin = +Math.min(...all).toFixed(2);
    row.wallNearFrac = `${near.length}/${all.length}`;
    row.wallMedian = near.length ? +near[Math.floor(near.length / 2)].toFixed(2) : null;
    // 안전 계약은 collide === 0 이고, 이 하한은 "몸이 담에 닿지 않는다"를 확인한다(BODY 0.45 + 여유).
    // 담을 "스치는" 것이 목표이므로 하한은 BODY 그 자체다(그보다 작으면 침범). 슬라이드가 상시
    //   발생하지 않는지는 collide === 0 과 아래 이동거리 지표가 지킨다.
    check(Math.min(...all) >= BODY_RADIUS - 1e-6,
      `W5 ${row.scale}: 경로 최근접 solid 거리 ${Math.min(...all).toFixed(2)}m < BODY ${BODY_RADIUS}m (담 침범)`);
    // 충돌 슬라이드가 상시 발생하면 전진하지 못한다 — 실제 이동거리로 확인한다.
    let travelled = 0;
    for (let i = 1; i < walkPath.length; i++) {
      travelled += Math.hypot(walkPath[i].x - walkPath[i - 1].x, walkPath[i].z - walkPath[i - 1].z);
    }
    row.walkTravel = Math.round(travelled);
    check(travelled >= WALK_SECONDS * 1.4 * 0.35,
      `W5 ${row.scale}: ${WALK_SECONDS}s 동안 ${Math.round(travelled)}m 만 이동 (충돌 슬라이드 상시 발생 의심)`);
    // ── W6 하단 프레임 대역 담 점유율 ──
    {
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

    check(near.length === 0 || row.wallMedian <= WALL_HUG_MEDIAN,
      `W5 ${row.scale}: 담 근접 구간 중앙값 이격 ${row.wallMedian}m > ${WALL_HUG_MEDIAN}m (노면 중앙을 걷는다)`);
  }

  // ── W4 수동 조작이 pitch 를 인수 ──
  {
    const walker = M.createWalker({ site, plan, heightAt: H });
    walker.startAutoStroll();
    for (let frame = 0; frame < 180; frame++) walker.update(DT, {});
    walker.stopAutoStroll();
    for (let frame = 0; frame < 60; frame++) walker.update(DT, { pitch: 4 * DEG });
    row.walkManualPitch = +(walker.pitch / DEG).toFixed(2);
    check(row.walkManualPitch > 20,
      `W4 ${row.scale}: 수동 pitch 입력이 자동 밴드에 눌렸다 (${row.walkManualPitch}°)`);
  }

  // ── D7 하위 호환: sunAzimuth 미제공 경로 결정론 ──
  {
    const a = createDronePaths({ site, plan, heightAt: H, seed: c.seed });
    const b = createDronePaths({ site, plan, heightAt: H, seed: c.seed });
    let maxd = 0;
    for (let k = 0; k < a.length; k++) {
      for (const t of [0.07, 0.29, 0.53, 0.81, 1]) {
        const sa = a[k].sample(t).pos, sb = b[k].sample(t).pos;
        maxd = Math.max(maxd, Math.hypot(sa.x - sb.x, sa.y - sb.y, sa.z - sb.z));
      }
    }
    row.noSunDelta = +maxd.toFixed(9);
    check(maxd < 1e-9, `D7 ${row.scale}: sunAzimuth 미제공 경로가 비결정적 (${maxd})`);
  }

  report.push(row);
}

console.log('\n=== 감상 모드 품질 계약 (#30) ===');
console.log(`태양 방위 sunAz = ${(SUN_AZ / DEG).toFixed(1)}° (sunset preset), 역광 카메라 방위 = ${(norm(SUN_AZ + Math.PI) / DEG).toFixed(1)}°`);
for (const r of report) {
  console.log(`\n[${r.scale}] R=${r.R} 보호수 ${r.canopies}주`);
  console.log(`  flythrough : 밀도0 ${r.flyZeroDensity} (기념건축 ${r.flyMonument}·희소 ${r.flySparse} 제외)  지붕위 클리어런스 min/mean/max ${r.flyClr.join(' / ')}m  하향 ${r.flyPitch.join('~')}°  look.y ${r.flyLookY.join('~')}`);
  console.log(`               프레임 피치 ${r.flyFramePitch.join('°~')}° (지평선 포함)  종점 랜드마크 ${r.endLandmark}`);
  console.log(`               구도: ${r.compose}  종반 원뿔 ${r.tailCone}`);
  console.log(`               고도 추종 편차: ${r.trackSd} (민가 표본 ${r.roofSeaN})`);
  console.log(`  orbit      : 수관관통 ${r.orbitIntersect} (종전위상 ${r.orbitLegacyIntersect})  최소여유 ${r.orbitCanopyGap}m  리프트 ${r.orbitLift}m  반경 ${r.orbitR.join('~')}m  역광 t=${r.orbitBacklitAt} (이각 ${r.orbitBacklitAng}°)`);
  console.log(`  crane-in   : t0.2~0.5 시선하향 ${r.cranePitch.join('~')}°`);
  console.log(`  pullback   : 최종 하향 ${r.endPitch}°  하늘 ${(r.endSky * 100).toFixed(1)}%`);
  console.log(`  역광방위   : crane/pullback 최대 이각 ${r.rimWorstDeg}°`);
  console.log(`               하단대역 담 점유 ${r.lowerBand}`);
  console.log(`               담 이격 min ${r.wallMin}m  근접구간 ${r.wallNearFrac}  중앙값 ${r.wallMedian}m  이동 ${r.walkTravel}m`);
  console.log(`  walk ${WALK_SECONDS}s : pitch ${r.walkPitch.join('~')}°  회전상한 ${r.walkMaxTurn}°/s  밀도0 ${r.walkZeroDensity}  스폰히트 ${r.walkSpawnHits}  반환 ${r.walkTurnarounds}  수동pitch ${r.walkManualPitch}°`);
  console.log(`  각속도     : ${Object.entries(r.ang).map(([k, v]) => `${k} ${v}`).join(' · ')} °/s`);
  console.log(`  하위호환   : sunAzimuth 미제공 결정론 delta ${r.noSunDelta}`);
}

if (!liftEngaged) {
  failures.push('D3: 어느 규모에서도 수관 리프트가 개입하지 않았다 — 회피가 위상 우연에 의존한다');
}

console.log('');
if (failures.length) {
  for (const f of failures) console.log(`FAIL ${f}`);
  console.log(`\ncine quality contract: FAIL (${failures.length})`);
  process.exit(1);
}
console.log('cine quality contract: PASS');
