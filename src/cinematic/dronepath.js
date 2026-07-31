import * as THREE from 'three';

// 시네마틱 데모 — 드론샷 패스 제너레이터 (태스크 #103, 화면 품질 라운드 #30).
//   createDronePaths({ site, plan, heightAt, seed, sunAzimuth }) → [ pass, ... ]  (명명된 패스 목록, 4종)
//     pass = { name, kind, duration, sample(t01) → { pos:Vector3, lookAt:Vector3, fov } }
//     sunAzimuth: 라디안, atan2(sunDir.x, sunDir.z) 규약(engine debugEnv.sunAz 와 동일). 주면
//       crane-in·pullback·orbit 의 방위를 태양 기준으로 재배치한다(피사체가 카메라와 태양 사이 =
//       역광). 안 주면 남향 고정이던 종전 방위를 그대로 쓴다(하위 호환).
//
// 좌표 규약(site.js): +z=남(앞·진입·개울), -z=북(뒤·주산·고지). center≈(0,-0.24R), mountainZ≈-1.0R,
//   streamZ≈0.30R, bowlR=0.56R. 모든 거리·고도는 site.R·Hmax 로 파생 → 규모 연속 대응(village↔hanyang).
//
// 경로는 CatmullRomCurve3(centripetal, C¹)·해석적 원(orbit)으로 구성하고 시간축을 easeInOutCubic 로
//   매핑해 시작/끝 속도 0(속도 급변 없음). lookAt 은 고정점·타깃곡선·전방접선(flythrough) 중 하나.
//
// 수치 안전(하네스 verify-cine.mjs 가 단언):
//   (a) 지형 클리어런스: 매 샘플 pos.y - heightAt(pos) > 1.5m  — safeFloor 하한으로 보장.
//   (b) 건물 관통 0: plan.parcels(+궁·절) 지붕 추정 볼륨 침범 없음. flythrough 는 지붕 위 ≥2m.
//   (c) lookAt 각속도 상한: 타깃을 부드럽게(고정/곡선/접선) 두고 easeInOut 로 등가속 → 상한 이내.
// (a)·(b) 의 하한은 **샘플별 클램프가 아니라 u 그리드에서 미리 푼 뒤 smootherstep 으로 확산시킨
//   리프트**로 적용된다(pass 팩토리 floorLift). 클램프로 걸면 필지 경계를 넘는 한 프레임에 고도가
//   계단으로 튀어 시선 각속도가 69~152°/s 로 폭발한다(저작된 각속도는 3~25°/s 다). 화면 품질 계약은
//   tools/check-cine-quality.mjs 가 지킨다.

const DEG = Math.PI / 180;
const clamp01 = (t) => Math.min(1, Math.max(0, t));
// smootherstep(C²): 시작/끝 속도 0 + 중간 최대 기울기 1.875(easeInOutCubic 의 3보다 완만) → 각속도 상한 여유.
const smootherstep = (t) => t * t * t * (t * (t * 6 - 15) + 10);
const V = (x, y, z) => new THREE.Vector3(x, y, z);

// 지형 위 최소 클리어런스(>1.5m 요구, 여유 포함)와 필지 지붕 위 최소 클리어런스(관통 방지 + flythrough 스침).
const GROUND_CLEAR = 2.0;
const ROOF_CLEAR = 2.0;
// 프록시(adapter buildProxies)와 동일한 필지 여유(8%보다 살짝 넉넉히) — 관통 판정 보수화.
const FOOT_PAD = 1.12;

// ── 시가지 밀도 스캔(#30) ── 도로 폴리라인의 어느 구간이 "시가지"인지 지붕 히트로 판정한다.
// 최장 도로를 그대로 쓰면 capital 처럼 대로가 도성 밖까지 뻗은 규모에서 경로 후반이 빈 들판이 된다.
export const DENSITY_DISC_RATIO = 0.12;   // 원판 반경 = R * 0.12
const DENSITY_MIN_ROAD_LEN = 60;          // 이보다 짧은 도로는 트리밍할 구조가 없다(합성 픽스처 포함)
const DENSITY_MIN_SPAN_RATIO = 0.22;      // 목표 스팬 길이(도로 길이 비율)
const DENSITY_MIN_SPAN_ABS = 90;          // 목표 스팬 길이(절대, m) — 12s 패스가 기어가지 않게
const DENSITY_THRESHOLD_RATIO = 0.3;      // 시가지 판정 문턱 = max(1, 0.3 × 최대 히트)

// flythrough 스침 고도 — 경로 국소 지붕 상단 이동평균 위 이 높이(브리프 3.0~4.0m).
const FLY_ROOF_CLEAR = 3.5;
// flythrough 시선: 진행방향 대비 요 오프액시스(기와골·용마루가 면으로 열리게) + 하향 비율.
const FLY_YAW_OFF = 20 * DEG;
const FLY_DROP_RATIO = 0.5;               // atan(0.5) = 26.6° 하향

// 안전 하한(지형·지붕) 램프 — 모든 패스가 공유하는 단일 방식. 그리드는 한 번만(패스 생성 시) 돈다.
const FLOOR_GRID = 384;
const FLOOR_RAMP_U = 0.06;   // 패스 길이의 6% (16s 패스에서 ~1s) 로 확산

// landmark-orbit 수관 회피 — 브리프의 "캐노피 top + 2.5m" 는 하한이고, 실제 시선이 수관을 벗어나는
// 정확 고도를 함께 푼다(수관이 랜드마크에 가까우면 top+2.5 만으로는 시선이 여전히 잎을 지난다).
const ORBIT_CANOPY_CLEAR = 2.5;
const ORBIT_CANOPY_MARGIN = 1.0;          // 정확 해에 얹는 여유(그리드 사이 보간 오차 흡수)
const ORBIT_CANOPY_RAMP = 20 * DEG;       // 히트 구간 진입·이탈 램프 폭
const ORBIT_GRID = 360;                   // 리프트 프로파일 그리드(결정론적)
const ORBIT_LIFT_SCAN = 48;               // 정확 해 선형 스캔 단계

// 역광 방위 — 카메라가 태양 반대편에 서면 피사체가 카메라와 태양 사이에 놓인다(rim 성립).
const CRANE_AZ_OFFSETS = [14 * DEG, 8 * DEG, 0, -10 * DEG];
const CRANE_DIST_RATIOS = [0.95, 0.78, 0.62, 0.48];
// t∈[0.2,0.5] 이 22~26° 밴드에 들어오도록 제어점별 시선 하향각을 직접 authoring 한다(고도가 파생).
const CRANE_PITCHES = [25.5 * DEG, 24 * DEG, 22.5 * DEG, 19 * DEG];
// 후퇴 4점(시작 마당점 + 3 단계)의 방위 오프셋 — 순수 방사 후퇴가 아니라 살짝 흐르게.
const PULLBACK_AZ_OFFSETS = [0, 6 * DEG, 2 * DEG, 0];
const PULLBACK_DIST_RATIOS = [0.32, 0.58, 0.85];
// 엔딩 컷 상단 하늘 비율 목표 → 최종 하향각. skyFrac = (1 - tan(p)/tan(fovV/2)) / 2.
const PULLBACK_END_SKY = 0.375;
const PULLBACK_MID_PITCH = 9 * DEG;
// 완전 역광각이 스윕의 이 시간 지점(eased)에 오도록 orbit 시작 위상을 역산.
const ORBIT_BACKLIT_AT = 0.4;

// 필지 유형별 지붕 상단 높이 추정(m). adapter buildProxies 의 H 와 동일 축척.
const parcelRoofH = (p) => (p.hero ? 14 : (p.kind === 'giwa' ? 9 : 6.5));
const facingY = (dir) => (dir ? Math.atan2(dir.x, dir.z) : 0);

// ── 장애물(건물 볼륨) 모델 ── 필지·궁·절을 회전 바운딩박스(OBB) + 지붕 상단 y 로. 드론 패스 생성과
//    검증이 이 단일 정의를 공유(계약면). world 매핑은 parcelMatrix/buildProxies 규약과 정합:
//    (wx-cx, wz-cz) = (lx·cos + lz·sin, -lx·sin + lz·cos).
export function buildObstacles(plan, heightAt) {
  const H = typeof heightAt === 'function' ? heightAt
    : (plan && plan.site && plan.site.heightAt) || (() => 0);
  const obs = [];
  const add = (cx, cz, bw, bd, rotY, top) => {
    obs.push({
      cx, cz, hw: bw * 0.5 * FOOT_PAD, hd: bd * 0.5 * FOOT_PAD,
      cos: Math.cos(rotY), sin: Math.sin(rotY), top,
    });
  };
  for (const p of (plan.parcels || [])) {
    let bw = p.plotW, bd = p.plotD, lcx = 0, lcz = 0;
    const pts = p.shape && p.shape.pts;
    if (pts && pts.length >= 3) {
      let mnx = Infinity, mxx = -Infinity, mnz = Infinity, mxz = -Infinity;
      for (const q of pts) { if (q.x < mnx) mnx = q.x; if (q.x > mxx) mxx = q.x; if (q.z < mnz) mnz = q.z; if (q.z > mxz) mxz = q.z; }
      bw = mxx - mnx; bd = mxz - mnz; lcx = (mnx + mxx) / 2; lcz = (mnz + mxz) / 2;
    }
    const rotY = facingY(p.frontDir) + (p.yaw || 0);
    const cos = Math.cos(rotY), sin = Math.sin(rotY);
    const wcx = p.center.x + lcx * cos + lcz * sin;
    const wcz = p.center.z - lcx * sin + lcz * cos;
    const baseY = (p.baseY != null) ? p.baseY : H(p.center.x, p.center.z);
    add(wcx, wcz, bw, bd, rotY, baseY + parcelRoofH(p));
  }
  const f = plan.features || {};
  if (f.palace) add(f.palace.x, f.palace.z, f.palace.plotW || 60, f.palace.plotD || 90, facingY(f.palace.frontDir), H(f.palace.x, f.palace.z) + 18);
  if (f.temple) add(f.temple.x, f.temple.z, 40, 40, 0, H(f.temple.x, f.temple.z) + 13);
  return obs;
}

// (x,z) 위에 있는 건물의 최고 지붕 상단 y(없으면 null).
export function roofTopAt(obs, x, z) {
  let top = -Infinity;
  for (const o of obs) {
    const dx = x - o.cx, dz = z - o.cz;
    const lx = dx * o.cos - dz * o.sin, lz = dx * o.sin + dz * o.cos;
    if (Math.abs(lx) <= o.hw && Math.abs(lz) <= o.hd && o.top > top) top = o.top;
  }
  return top > -Infinity ? top : null;
}

// ── 수관(보호수) 볼륨 ── plan.features.guardianTrees 만이 계획 단계에 존재하는 유일한 수목 소스다.
//   마당 과실수(gardens.js yardTreeAnchors)는 렌더 시점에 tree-rng 로 결정되므로 plan 에 없다 —
//   외부에서 그 앵커를 얻은 호출자는 createDronePaths({ canopies }) 로 같은 형식으로 덧붙일 수 있다.
//   형상은 gardens.js 의 우산형 수관과 정합: 전고 h = 14*scale(guardianAnchors.h), 중심 h*0.72,
//   수평 반경 gp.radius, 수직 반경 h*0.26 인 편평 타원체(느티나무 수관은 y 로 0.6 눌려 있다).
export function buildCanopies(plan, heightAt) {
  const H = typeof heightAt === 'function' ? heightAt
    : (plan && plan.site && plan.site.heightAt) || (() => 0);
  return ((plan.features && plan.features.guardianTrees) || []).map((g) => {
    const ground = H(g.x, g.z);
    const h = 14 * (g.scale || 1);
    return { x: g.x, z: g.z, y: ground + h * 0.72, r: g.radius, ry: h * 0.26, top: ground + h };
  });
}

// 선분(카메라→타깃)과 수관 타원체의 최소여유. 음수면 시선이 잎을 지난다.
//   y 를 r/ry 로 늘려 구 문제로 환원한 뒤 선분-점 최소거리.
export function segmentCanopyGap(p, q, c) {
  const k = c.r / c.ry;
  const py = c.y + (p.y - c.y) * k;
  const qy = c.y + (q.y - c.y) * k;
  const vx = q.x - p.x, vy = qy - py, vz = q.z - p.z;
  const vv = vx * vx + vy * vy + vz * vz || 1;
  let t = ((c.x - p.x) * vx + (c.y - py) * vy + (c.z - p.z) * vz) / vv;
  t = Math.min(1, Math.max(0, t));
  return Math.hypot(p.x + vx * t - c.x, py + vy * t - c.y, p.z + vz * t - c.z) - c.r;
}

// (x,z) 주변 원판의 지붕 히트 수와 상단 통계 — 시가지 밀도의 단일 정의(중심 + 0.45/0.85 링 각 8방).
export function roofDensityAt(obs, x, z, radius) {
  let hits = 0, sum = 0, max = -Infinity;
  const at = (px, pz) => {
    const t = roofTopAt(obs, px, pz);
    if (t == null) return;
    hits++; sum += t; if (t > max) max = t;
  };
  at(x, z);
  for (const f of [0.45, 0.85]) {
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      at(x + Math.cos(a) * f * radius, z + Math.sin(a) * f * radius);
    }
  }
  return { hits, meanTop: hits ? sum / hits : null, maxTop: hits ? max : null };
}

// 도로 폴리라인 길이.
function polyLen(pts) {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
  return L;
}
// 주 도로 선택(대로 우선, 길이 가중). flythrough·초기 스폰 공용.
export function mainRoad(plan) {
  const roads = plan.roads || [];
  let best = null, bestScore = -1;
  for (const r of roads) {
    if (!r.pts || r.pts.length < 2) continue;
    const w = r.level === 'daero' ? 3 : r.level === 'jungno' ? 2 : r.level === 'soro' ? 1.2 : 1;
    const s = polyLen(r.pts) * w;
    if (s > bestScore) { bestScore = s; best = r; }
  }
  return best;
}
// 폴리라인 누적 호길이와 임의 호길이 지점.
function polyCum(pts) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
  }
  return cum;
}
function polyAt(pts, cum, s) {
  const total = cum[cum.length - 1] || 1;
  const t = Math.min(total, Math.max(0, s));
  let i = 1; while (i < cum.length && cum[i] < t) i++;
  const a = pts[i - 1], b = pts[Math.min(i, pts.length - 1)];
  const seg = (cum[Math.min(i, cum.length - 1)] - cum[i - 1]) || 1;
  const f = (t - cum[i - 1]) / seg;
  return { x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f };
}

// ── 시가지 밀도 스팬(#30) ── 폴리라인을 따라 밀도를 스캔하고 문턱을 넘는 **연속 최장 구간**만 남긴다.
//   드론 flythrough 와 도보 자동산책이 이 단일 정의를 공유한다(둘 다 밀도 0 구간을 지나지 않는다).
//   짧은 도로(합성 픽스처·좁은 골목)는 트리밍할 구조가 없으므로 원본을 그대로 돌려준다.
export function denseRoadSpan(pts, obs, R) {
  const empty = { pts, trimmed: false, total: pts.length > 1 ? polyLen(pts) : 0, span: null };
  if (!pts || pts.length < 2) return empty;
  const total = polyLen(pts);
  if (total < DENSITY_MIN_ROAD_LEN) return empty;
  const cum = polyCum(pts);
  const radius = R * DENSITY_DISC_RATIO;
  const step = Math.max(4, R * 0.02);
  const n = Math.min(400, Math.max(8, Math.round(total / step)));
  const hits = new Array(n + 1);
  let maxHits = 0;
  for (let i = 0; i <= n; i++) {
    const p = polyAt(pts, cum, (i / n) * total);
    hits[i] = roofDensityAt(obs, p.x, p.z, radius).hits;
    if (hits[i] > maxHits) maxHits = hits[i];
  }
  if (maxHits === 0) return empty;
  const thr = Math.max(1, Math.ceil(DENSITY_THRESHOLD_RATIO * maxHits));
  let bestA = -1, bestB = -1, runA = -1;
  for (let i = 0; i <= n; i++) {
    if (hits[i] >= thr) {
      if (runA < 0) runA = i;
      if (bestA < 0 || i - runA > bestB - bestA) { bestA = runA; bestB = i; }
    } else runA = -1;
  }
  if (bestA < 0) return empty;
  // 코어(문턱 이상)만 남기면 조밀한 시드에서 스팬이 40m 로 짧아져 패스가 기어간다(duration 하한 12s).
  // 목표 길이까지 **밀도가 0 이 아닌 동안만** 바깥으로 넓힌다 — 빈 들판은 어떤 경우에도 들이지 않는다.
  const targetSpan = Math.min(total, Math.max(total * DENSITY_MIN_SPAN_RATIO, DENSITY_MIN_SPAN_ABS));
  const probeStep = total / n;
  let a = bestA, b = bestB;
  while ((b - a) * probeStep < targetSpan) {
    const canA = a > 0 && hits[a - 1] > 0;
    const canB = b < n && hits[b + 1] > 0;
    if (!canA && !canB) break;
    // 더 조밀한 쪽으로 먼저 넓힌다.
    if (canB && (!canA || hits[b + 1] >= hits[a - 1])) b++;
    else a--;
  }
  const half = probeStep / 2;
  const s0 = Math.max(0, (a / n) * total - half);
  const s1 = Math.min(total, (b / n) * total + half);
  if (s1 - s0 >= total - 1e-6) return empty;
  // 부분 폴리라인 추출 — 원래 정점을 보존하고 양 끝만 보간(형상 왜곡 없음).
  const out = [polyAt(pts, cum, s0)];
  for (let i = 0; i < pts.length; i++) {
    if (cum[i] > s0 + 1e-6 && cum[i] < s1 - 1e-6) out.push({ x: pts[i].x, z: pts[i].z });
  }
  out.push(polyAt(pts, cum, s1));
  if (out.length < 2) return empty;
  return { pts: out, trimmed: true, total, span: [s0, s1] };
}

// 폴리라인을 호길이 등간격 n점으로 재샘플(제어점 등속화).
function resample(pts, n) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
  const total = cum[cum.length - 1] || 1;
  const out = [];
  for (let k = 0; k < n; k++) {
    const s = (k / (n - 1)) * total;
    let i = 1; while (i < cum.length && cum[i] < s) i++;
    const a = pts[i - 1], b = pts[Math.min(i, pts.length - 1)];
    const seg = (cum[Math.min(i, cum.length - 1)] - cum[i - 1]) || 1;
    const f = (s - cum[i - 1]) / seg;
    out.push({ x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f });
  }
  return out;
}

export function createDronePaths({
  site, plan, heightAt, seed = 0, sunAzimuth = null, canopies: extraCanopies = null,
} = {}) {
  const H = typeof heightAt === 'function' ? heightAt : (site && site.heightAt) || (() => 0);
  const R = site.R, C = site.center, Hmax = site.Hmax;
  const obstacles = buildObstacles(plan, H);
  const roofTop = (x, z) => roofTopAt(obstacles, x, z);
  const canopies = buildCanopies(plan, H).concat(extraCanopies || []);
  // 역광 카메라 방위 — 태양 반대편에 서면 피사체가 카메라와 태양 사이에 놓인다. 태양 방위를 받지
  // 못하면 종전의 남향(+z) 고정을 그대로 쓴다.
  //   태양 방위를 모르면 backAz=0 → +z(남) 이며, 이는 종전 crane-in 착지 방위·pullback 후퇴 방위와
  //   같은 축이다(경로 형상만 바뀌고 방위 규약은 유지).
  const sunKnown = Number.isFinite(sunAzimuth);
  const backAz = sunKnown ? Math.atan2(-Math.sin(sunAzimuth), -Math.cos(sunAzimuth)) : 0;
  // 중심 기준 극좌표(방위 az, 수평거리 d) — az=0 이 +z(남)이라 종전 배치와 규약이 같다.
  const polar = (o, az, d) => ({ x: o.x + Math.sin(az) * d, z: o.z + Math.cos(az) * d });

  // 지형·지붕 위 안전 하한 — pos.y 는 항상 이 값 이상(클리어런스·관통 보장).
  const safeFloor = (x, z, clear) => {
    const g = H(x, z) + GROUND_CLEAR;
    const rt = roofTop(x, z);
    return rt != null ? Math.max(g, rt + (clear != null ? clear : ROOF_CLEAR)) : g;
  };
  // 필지 안이면 지정 방향으로 밀어 열린 지점(마당·도로) 찾기. 저고도 시작점 안전 스폰.
  const openPointNear = (x, z, dir) => {
    if (roofTop(x, z) == null) return { x, z };
    const d = dir || { x: 0, z: 1 };
    const step = Math.max(2.5, R * 0.02);
    let px = x, pz = z;
    for (let i = 0; i < 48; i++) { px += d.x * step; pz += d.z * step; if (roofTop(px, pz) == null) break; }
    return { x: px, z: pz };
  };

  // ── 랜드마크(궁 우선, 없으면 종가 hero 필지, 없으면 마을 중심) ──
  const f = plan.features || {};
  let L, lext, lH;
  if (f.palace) { L = { x: f.palace.x, z: f.palace.z }; lext = Math.max(f.palace.plotW || 60, f.palace.plotD || 90); lH = 18; }
  else {
    const hp = (plan.parcels || []).find((p) => p.hero);
    if (hp) { L = { x: hp.center.x, z: hp.center.z }; lext = Math.max(hp.plotW, hp.plotD) * 1.2; lH = 14; }
    else { L = { x: C.x, z: C.z }; lext = 40; lH = 12; }
  }
  const lbaseY = H(L.x, L.z);

  // ── 공통 패스 팩토리 ──
  function pass(name, kind, duration, cfg) {
    const posCurve = cfg.pos ? new THREE.CatmullRomCurve3(cfg.pos, false, 'centripetal') : null;
    const tgtCurve = Array.isArray(cfg.target) ? new THREE.CatmullRomCurve3(cfg.target, false, 'centripetal') : null;
    const fixed = (cfg.target && cfg.target.isVector3) ? cfg.target : null;
    const ease = cfg.ease || smootherstep;
    const roofClear = cfg.roofClear != null ? cfg.roofClear : ROOF_CLEAR;
    const lead = cfg.lead != null ? cfg.lead : 0.05;
    const drop = cfg.drop != null ? cfg.drop : 4;
    const aheadDist = cfg.aheadDist != null ? cfg.aheadDist : Math.max(16, R * 0.12);
    const getPos = cfg.custom ? cfg.custom : (u) => posCurve.getPoint(u);
    // 안전 하한(지형·지붕)을 샘플별 클램프로 걸면 필지 경계를 넘는 한 프레임에 고도가 계단으로 튀고
    // 시선 각속도가 수십~150°/s 로 폭발한다(저작된 각속도는 3~25°/s 다). 그래서 "저작 곡선 위로
    // 얼마나 들어올려야 하는가"를 u 그리드에서 미리 풀고 smootherstep 으로 확산시킨다. 델타를
    // 확산시키므로 피크에서는 필요량 전부가, 주변에서는 그 일부만 적용된다 — 항상 하한 이상이다.
    const floorLift = new Float64Array(FLOOR_GRID + 1);
    {
      const raw = new Float64Array(FLOOR_GRID + 1);
      for (let i = 0; i <= FLOOR_GRID; i++) {
        const p = getPos(i / FLOOR_GRID);
        raw[i] = Math.max(0, safeFloor(p.x, p.z, roofClear) - p.y);
      }
      const w = Math.max(1, Math.round(FLOOR_RAMP_U * FLOOR_GRID));
      for (let i = 0; i <= FLOOR_GRID; i++) {
        let best = 0;
        for (let j = Math.max(0, i - w); j <= Math.min(FLOOR_GRID, i + w); j++) {
          if (raw[j] <= 0) continue;
          const v = raw[j] * smootherstep(1 - Math.abs(i - j) / (w + 1));
          if (v > best) best = v;
        }
        floorLift[i] = best;
      }
    }
    const liftAt = (u) => {
      const g = clamp01(u) * FLOOR_GRID;
      const i0 = Math.floor(g), i1 = Math.min(FLOOR_GRID, i0 + 1);
      return floorLift[i0] + (floorLift[i1] - floorLift[i0]) * (g - i0);
    };
    return {
      name, kind, duration,
      sample(t01) {
        const u = ease(clamp01(t01));
        const pos = getPos(u);
        pos.y += liftAt(u);
        // 그리드 사이(호길이 ≲1m)에 대한 하드 안전망. 램프가 이미 거의 다 올라와 있어 계단이 아니다.
        const fl = safeFloor(pos.x, pos.z, roofClear);
        if (pos.y < fl) pos.y = fl;
        let lookAt;
        if (cfg.target === 'lookAhead') {
          const a = getPos(Math.max(0, u - lead));
          const b = getPos(Math.min(1, u + lead));
          let dx = b.x - a.x, dz = b.z - a.z;
          const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
          // 진행방향 대비 요 오프액시스 — 정면 접선이면 기와골·용마루가 선으로만 보인다. 회전 부호는
          // 시선이 시가지 쪽(yawToward)으로 가까워지는 쪽으로 결정(결정론적, 빈 외곽을 보지 않게).
          if (cfg.yawOff) {
            const base = Math.atan2(dx, dz);
            let sign = 1;
            if (cfg.yawToward) {
              const want = Math.atan2(cfg.yawToward.x - pos.x, cfg.yawToward.z - pos.z);
              const d = Math.atan2(Math.sin(want - base), Math.cos(want - base));
              sign = d >= 0 ? 1 : -1;
            }
            const az = base + sign * cfg.yawOff;
            dx = Math.sin(az); dz = Math.cos(az);
          }
          lookAt = V(pos.x + dx * aheadDist, pos.y - drop, pos.z + dz * aheadDist);
        } else if (fixed) lookAt = fixed.clone();
        else lookAt = tgtCurve.getPoint(u);
        const fov = cfg.fov1 != null ? cfg.fov + (cfg.fov1 - cfg.fov) * u : cfg.fov;
        return { pos, lookAt, fov };
      },
    };
  }

  // ① crane-in — 마을 밖 높은 곳에서 내려앉는 진입 크레인(히어로/타이틀).
  //   방위: 태양을 알면 태양 반대편(피사체가 카메라와 태양 사이 = 역광)에서 반경만 좁히며 하강한다.
  //     종전처럼 마을 위를 넘어가면 후반이 순광이 되고 통과 순간 시선각이 -68° 로 튄다.
  //   고도: 절대 고도가 아니라 **제어점별 시선 하향각**을 authoring 하고 고도를 파생시킨다(규모 무관).
  //   타깃: 지면 중심이 아니라 능선 어깨 높이 — 하향각이 줄어 프레임에 대기·하늘 밴드가 들어온다.
  const craneTgtY = H(C.x, C.z) + Math.max(R * 0.06, Hmax * 0.46);
  const cranePos = CRANE_DIST_RATIOS.map((ratio, i) => {
    const d = R * ratio;
    const p = polar(C, backAz + CRANE_AZ_OFFSETS[i], d);
    return V(p.x, craneTgtY + d * Math.tan(CRANE_PITCHES[i]), p.z);
  });
  const craneIn = pass('crane-in', 'establish', 14, {
    pos: cranePos,
    target: V(C.x, craneTgtY, C.z),
    fov: 34, fov1: 42,
  });

  // ② street-flythrough — 시가지 대로를 따라 지붕 위를 스치는 비행(지붕 바다).
  //   경로: 최장 도로 전체가 아니라 밀도 스팬(연속 최장 시가지 구간)만 12점 리샘플 — capital 처럼
  //     대로가 도성 밖까지 뻗는 규모에서 경로 후반이 빈 들판이 되는 것을 막는다.
  //   고도: 지형 추종(+12 고정)이 아니라 **경로 국소 지붕 상단의 이동평균 + 3.5m** — 초가 구간에서
  //     7~8m 부감으로 떠오르지 않고, 기와 구간에서도 스침이 유지된다.
  const road = mainRoad(plan);
  const flySpan = road ? denseRoadSpan(road.pts, obstacles, R) : null;
  const flyBase = flySpan ? flySpan.pts : [
    { x: C.x, z: C.z + 0.5 * R }, { x: C.x, z: C.z }, { x: C.x, z: C.z - 0.4 * R },
  ];
  const roadPts = resample(flyBase, 12);
  const discR = R * DENSITY_DISC_RATIO;
  const localTop = roadPts.map((p) => roofDensityAt(obstacles, p.x, p.z, discR).meanTop);
  const flyPos = roadPts.map((p, i) => {
    let sum = 0, n = 0;
    for (let k = i - 1; k <= i + 1; k++) {
      if (k < 0 || k >= localTop.length || localTop[k] == null) continue;
      sum += localTop[k]; n++;
    }
    // 지붕이 전혀 없는 제어점(짧은 폴백 경로)만 종전 지형 추종으로 되돌린다.
    const base = n ? sum / n : H(p.x, p.z) + 9;
    return V(p.x, base + FLY_ROOF_CLEAR, p.z);
  });
  const flyAhead = Math.max(16, R * 0.12);
  const flyDur = Math.max(12, Math.min(40, polyLen(flyBase) / 22));
  const flythrough = pass('street-flythrough', 'flythrough', flyDur, {
    pos: flyPos, target: 'lookAhead', roofClear: 2.0, lead: 0.06,
    aheadDist: flyAhead, drop: flyAhead * FLY_DROP_RATIO,
    yawOff: FLY_YAW_OFF, yawToward: { x: C.x, z: C.z },
    fov: 40,
  });

  // ③ landmark-orbit — 궁/종가 저속 선회(역광 실루엣). 해석적 원(정확 외접) + 고정 타깃.
  //   위상: 태양을 알면 완전 역광각이 스윕의 40% 시간 지점에 오도록 시작 위상을 역산.
  //   고도: 보호수 수관이 시선을 가리는 구간에서만 들어올린다. **선회 반경은 건드리지 않는다**
  //     (반경을 늘리면 랜드마크가 작아진다 — 그게 이 패스의 유일한 피사체다).
  const orbitR = 0.5 * lext * 1.5 + Math.max(R * 0.07, 10);
  const orbitY0 = lbaseY + Math.max(lH * 0.85, 12);
  const sweep = 300 * DEG;
  // th=0 → +z(남/정면). 태양 방위를 받으면 backAz 가 ORBIT_BACKLIT_AT 시점에 오도록 뒤로 민다.
  const th0 = sunKnown ? backAz - sweep * smootherstep(ORBIT_BACKLIT_AT) : 0;
  const orbitTarget = V(L.x, lbaseY + lH * 0.5, L.z);
  const orbitXZ = (th) => ({ x: L.x + orbitR * Math.sin(th), z: L.z + orbitR * Math.cos(th) });
  const orbitClears = (x, y, z) => {
    for (const c of canopies) {
      if (segmentCanopyGap({ x, y, z }, orbitTarget, c) < ORBIT_CANOPY_MARGIN) return false;
    }
    return true;
  };
  // 수관 회피 고도 프로파일. 브리프의 top+2.5 를 하한으로 두고, 그것으로도 시선이 잎을 지나면
  // 스캔 + 이분으로 실제로 벗어나는 최소 고도를 찾는다(랜드마크에 붙은 당산나무가 그렇다).
  // 히트 구간 진입·이탈은 20° smootherstep 램프로 확산 — 지형·지붕 하한은 패스 팩토리가 따로 맡는다.
  // 선회 반경은 어느 경우에도 건드리지 않는다.
  const orbitLift = new Float64Array(ORBIT_GRID + 1);
  {
    const raw = new Float64Array(ORBIT_GRID + 1);
    const cap = orbitY0 + Math.max(40, Hmax * 0.6);
    for (let i = 0; i <= ORBIT_GRID; i++) {
      const p = orbitXZ(th0 + sweep * (i / ORBIT_GRID));
      let need = orbitY0;
      if (canopies.length && !orbitClears(p.x, need, p.z)) {
        for (const c of canopies) {
          if (segmentCanopyGap({ x: p.x, y: need, z: p.z }, orbitTarget, c) < ORBIT_CANOPY_MARGIN) {
            need = Math.max(need, c.top + ORBIT_CANOPY_CLEAR);
          }
        }
        if (!orbitClears(p.x, need, p.z)) {
          let lo = need, hi = cap, found = false;
          for (let k = 1; k <= ORBIT_LIFT_SCAN; k++) {
            const y = need + (cap - need) * (k / ORBIT_LIFT_SCAN);
            if (orbitClears(p.x, y, p.z)) {
              lo = need + (cap - need) * ((k - 1) / ORBIT_LIFT_SCAN); hi = y; found = true; break;
            }
          }
          if (found) {
            for (let k = 0; k < 10; k++) {
              const mid = (lo + hi) / 2;
              if (orbitClears(p.x, mid, p.z)) hi = mid; else lo = mid;
            }
          }
          need = hi;
        }
      }
      raw[i] = need;
    }
    const w = Math.max(1, Math.round(ORBIT_CANOPY_RAMP / (sweep / ORBIT_GRID)));
    for (let i = 0; i <= ORBIT_GRID; i++) {
      let best = orbitY0;
      for (let j = Math.max(0, i - w); j <= Math.min(ORBIT_GRID, i + w); j++) {
        if (raw[j] <= orbitY0) continue;
        const s = smootherstep(1 - Math.abs(i - j) / (w + 1));
        const y = orbitY0 + (raw[j] - orbitY0) * s;
        if (y > best) best = y;
      }
      orbitLift[i] = best;
    }
  }
  const orbitCustom = (u) => {
    const th = th0 + sweep * u;
    const { x, z } = orbitXZ(th);
    const g = clamp01(u) * ORBIT_GRID;
    const i0 = Math.floor(g), i1 = Math.min(ORBIT_GRID, i0 + 1);
    const y = orbitLift[i0] + (orbitLift[i1] - orbitLift[i0]) * (g - i0);
    return V(x, y, z);
  };
  const landmarkOrbit = pass('landmark-orbit', 'orbit', 22, {
    custom: orbitCustom,
    target: orbitTarget,
    fov: 30,
  });

  // ④ pullback-reveal — 마당 근접(저고도) → 마을 전경 당김(엔딩). 타깃곡선으로 근경 디테일→전경.
  //   후퇴 방향은 태양 반대편(역광 유지). 마지막 두 타깃점은 능선 위로 올려 최종 컷 상단이
  //   하늘·역광으로 열리게 한다 — 종전에는 -21° 하향으로 갈색 지형이 화면을 닫았다.
  const startDir = { x: Math.sin(backAz), z: Math.cos(backAz) };
  const s0 = openPointNear(
    L.x + startDir.x * lext * 0.5, L.z + startDir.z * lext * 0.5, startDir,
  );
  const pbXZ = PULLBACK_DIST_RATIOS.map((ratio, i) => polar(C, backAz + PULLBACK_AZ_OFFSETS[i + 1], R * ratio));
  const pbY = [Hmax * 0.30 + R * 0.06, Hmax * 0.55 + R * 0.12, Hmax * 0.72 + R * 0.18];
  // 타깃 xz — 3·4번째는 카메라 반대편(중심 너머)으로 조금 더 밀어 원경이 열리게.
  const pbTgtXZ = [
    { x: (L.x + C.x) / 2, z: (L.z + C.z) / 2 },
    { x: C.x, z: C.z },
    polar(C, backAz + Math.PI, R * 0.05),
  ];
  // 최종 하향각은 목표 하늘 비율에서 역산: skyFrac = (1 - tan(p)/tan(fovV/2)) / 2.
  const endFov = 32;
  const endPitch = Math.atan((1 - 2 * PULLBACK_END_SKY) * Math.tan(endFov * 0.5 * DEG));
  const tgtYFor = (ci, ti, pitch) => {
    const hd = Math.hypot(pbXZ[ci].x - pbTgtXZ[ti].x, pbXZ[ci].z - pbTgtXZ[ti].z);
    return pbY[ci] - hd * Math.tan(pitch);
  };
  const pullback = pass('pullback-reveal', 'reveal', 16, {
    pos: [
      V(s0.x, H(s0.x, s0.z) + 4.5, s0.z),
      V(pbXZ[0].x, pbY[0], pbXZ[0].z),
      V(pbXZ[1].x, pbY[1], pbXZ[1].z),
      V(pbXZ[2].x, pbY[2], pbXZ[2].z),
    ],
    target: [
      V(L.x, H(L.x, L.z) + 3, L.z),
      V(pbTgtXZ[0].x, H(C.x, C.z) + R * 0.03, pbTgtXZ[0].z),
      V(pbTgtXZ[1].x, tgtYFor(1, 1, PULLBACK_MID_PITCH), pbTgtXZ[1].z),
      V(pbTgtXZ[2].x, tgtYFor(2, 2, endPitch), pbTgtXZ[2].z),
    ],
    fov: 40, fov1: endFov,
  });

  return [craneIn, flythrough, landmarkOrbit, pullback];
}
