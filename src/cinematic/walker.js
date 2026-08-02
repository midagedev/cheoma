import * as THREE from 'three';
import { createHeadingController, shortestAngleDelta } from '../camera/heading.js';
import {
  DENSITY_DISC_RATIO, buildObstacles, denseRoadSpan, mainRoad, roofDensityAt,
} from './dronepath.js';
import { buildWalkSolids, pointHitsWalkSolids } from './walk-solids.js';

// 시네마틱 데모 — 1인칭 골목 탐색 (태스크 #103, 대문 진입 #150-J, 수동 조작 #33, FPS 문법 #43).
//   createWalker({ site, plan, heightAt }) → walker
//     walker.setInput({ fwd, strafe, run, jump })  지속 이동 의도. 놓을 때까지 유지된다.
//       fwd/strafe ∈ [-1,1] (strafe +1 = 오른쪽), run: true 면 달리기, jump: true 면 지상에서 도약.
//     walker.look(dxPx, dyPx)                   포인터 이동 델타(px). 감도는 코어 소유(아래 상수).
//     walker.lookRadians(dYaw, dPitch)          라디안 증분(감도 이미 적용된 경로·게이트용).
//     walker.update(dt, input?) → { pos, dir }  input 을 주면 setInput + lookRadians(yaw/pitch) 와 동치.
//     walker.pos  Vector3(x, 시선고 y, z)      walker.dir  Vector3 시선 단위벡터
//     walker.startAutoStroll() / stopAutoStroll()  — 도로 폴리라인 따라 자동 산책(데모 클립)
//     walker.setPos(x,z) / walker.yaw / walker.pitch
//
// #33 이후 이 모드의 **기본은 수동**이다: 생성 직후 walker 는 정지해 있고, 호출부가 매 프레임
//   setInput/look 으로 사용자 입력을 밀어넣는다. 자동 산책은 명시 호출(startAutoStroll)로만 켜지는
//   데모 경로로 남는다. 코어는 DOM 을 모른다 — 키/포인터 수집은 app 소유, 여기는 dt 기반 순수 상태기.
//
// 접지: 시선고 = heightAt + 1.6m, 계단·성토 패드 단차를 지수 스무딩(단차에서 튀지 않게). 하한 클램프로
//   지면 침하(발이 땅 아래) 0 보장. 충돌: walk-solids — 담 런 세그먼트 + 집 지붕 OBB(대문 틈 open).
//   필지 전체를 solid 로 쓰지 않으므로 free walk 가 도로→대문→마당으로 들어갈 수 있다. 종가·궁·절은
//   보수적 풋프린트 solid. auto-stroll 은 계속 도로 폴리라인만 따른다(마당 진입 없음). mesh-bvh 불필요.
//   경계: 마을 분지(bowlR)·1.12 밖으로 나가지 않는 하드 캡.
//   자동산책 종점: 먼저 멈춰 바라본 뒤 24°/s·120°/s² 제한으로 회전하고 다시 걷는다. 정확히 반대인
//   ±π 목표도 회전면을 고정해 한 프레임 급회전이나 좌우 부호 진동을 만들지 않는다.
//
// 자동산책 화면 품질(#30) — 아래 셋은 auto 경로에만 적용된다(자유 이동·폰 조작은 종전 그대로):
//   (a) 시선을 살짝 내려본다(-7.5°). pitch 0 은 화면 하단 절반 이상이 빈 노면이 된다.
//   (b) 경로를 시가지 밀도 스팬으로 제한한다. 최장 도로 끝은 capital 에서 건축이 0 이다.
//   (c) 회전 상한을 24°/s 로 낮춘다(52°/s 는 1인칭에서 급회전으로 읽힌다).
//   (d) 스폰을 스팬 끝점이 아니라 스팬 내 밀도 최대 지점에 둔다(끝점은 시가지 경계 = 공터다).
//   (e) 노면 중앙이 아니라 담장선 안쪽 1.5~2m 로 붙여 화면 하단을 담·기단이 먹게 한다.

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const EYE = 1.6;
const BODY = 0.45;              // 몸 반경(담과의 이격)
const DEG = Math.PI / 180;
// ── 이동 속도(#43, 2026-08-02 사용자 지시 "기본 이동속도를 기존보다 한참 더 빠르게 … 좀 더 FPS
//   문법을 따르면 좋겠네") ── 종전 1.4/2.8m/s 는 실측 보행 속도(사람 1.4m/s)라 물리적으로는 옳지만
//   1인칭 조작에서는 마을 한 블록이 지루하게 길어진다. FPS 는 관례적으로 실측보다 3~4배 빠르다:
//   Source 엔진 지상 상한 sv_maxspeed 320u/s = 6.10m/s, HL2 기본 보행 190u/s = 3.62m/s, 스프린트
//   320u/s = 6.10m/s, Quake III 러닝 320u/s ≈ 8.1m/s. 그 밴드 안에서 걷기를 HL2 스프린트 아래,
//   달리기를 Quake 러닝 아래로 잡는다(종전 대비 걷기 3.21배·달리기 2.68배).
export const WALK_SPEED = 4.5;  // m/s — 기본 이동(Source 지상 상한 6.10 아래, HL2 보행 3.62 위)
export const RUN_SPEED = 7.5;   // m/s — Shift 달리기(Quake III 러닝 ≈8.1 아래)
const WALK = WALK_SPEED, RUN = RUN_SPEED;
// 자동 산책(데모 클립) 속도는 종전값 유지 — #30 이 저작한 24°/s 회전·담장선 접근 리듬은 산책
//   속도를 전제로 맞춰져 있고, 조작 속도 상향은 사용자 입력 경로에만 해당한다.
const STROLL = 1.4;
// ── 수동 조작 상수(#33) ── 값은 전부 즉답성 기준의 수치 근거를 갖는다. 미감이 아니라 지연 예산이다.
//   #43 에서 최고속이 3배가 되면서 종전 램프(14/20)를 그대로 두면 걷기 정지 시간이 0.067s →
//   0.233s 로 늘어(게이트 M3 실측) FPS 감이 죽는다. **도달·정지 시간**을 종전 예산에 맞춰
//   재저작한다(비율 보존).
export const MOVE_ACCEL = 45;   // m/s² — 정지→4.5m/s 0.100s, 정지→7.5m/s(달리기) 0.167s
export const MOVE_DECEL = 75;   // m/s² — M3 실측 4.5→0 0.067s·0.100m, 7.5→0 0.100s·0.313m
// ── 점프(#43) ── 지상에서만 발동하는 단일 도약. 높이는 한옥 수직 어휘로 저작한다:
//   기단(hanok.js podiumH 기본 0.5m, 댓돌·섬돌은 그 아래)은 넘고, 담(wall-contract 의 조적 담
//   최저값 = mud 1.7m × 0.88 × 0.96 = 1.44m)은 못 넘는 구간. 1.05m 는 기단 대비 +0.55m,
//   최저 조적 담 대비 −0.39m 여유다. 충돌은 xz 2D(walk-solids)라 높이와 무관하게 담을 통과할 수
//   없으므로 이 값은 "무엇을 뛰어넘는 동작으로 읽히는가"의 저작이고, 관통 금지는 별개 계약이다.
//   중력 20m/s² 는 FPS 관례(Source sv_gravity 800u/s² = 15.24m/s²)의 밴드로, 실중력 9.81 을 쓰면
//   같은 높이에서 체공이 0.93s 로 늘어져 점프가 둥실거린다.
export const JUMP_HEIGHT = 1.05;   // m — 기단 0.5 ↑ / 최저 조적 담 1.44 ↓
export const JUMP_GRAVITY = 20;    // m/s²
export const JUMP_SPEED = Math.sqrt(2 * JUMP_GRAVITY * JUMP_HEIGHT);  // 6.481 m/s
// 체공 중 방향 전환 감쇠 — 지상 가속의 30%(Source 계열 air accel 이 지상보다 훨씬 낮은 관례).
//   입력이 없으면 세계 속도를 그대로 유지한다(공중 제동 금지: 관성이 점프의 물성이다).
export const AIR_CONTROL = 0.3;
// 접지 추종 스무딩(계단·성토 패드 단차 완화). 이 스무딩의 실효 단위는 시간이 아니라 **거리**다:
//   지연 길이 = 속도 / rate. 종전 1.4m/s ÷ 8 = 0.175m 였는데, 속도만 3배로 올리고 rate 를 두면
//   같은 섬돌 하나가 0.53m 에 걸쳐 뭉개져 시선이 지형에서 뜬 채로 걷는다(M9 눈높이 오차 79mm).
//   같은 공간 지연 0.173m 를 유지하도록 4.5 / 0.175 ≈ 26 으로 재저작한다.
export const GROUND_FOLLOW_RATE = 26;
// 포인터 감도. 종전 App.svelte 가 쓰던 값을 그대로 코어로 옮긴 것이라 조작감은 불변이고, 대신
//   노드에서 단언 가능해진다. 부호는 look() 이 dx>0 → yaw 감소로 정의한다.
export const LOOK_YAW_PER_PX = 0.0026;    // rad/px = 0.149°/px
export const LOOK_PITCH_PER_PX = 0.0022;  // rad/px = 0.126°/px
export const PITCH_LIMIT = 1.2;           // rad = 68.75° — 종전 수동 클램프 값 유지
// 포인터 락(#44) 델타 → look() px 변환 계수. 락 상태의 mousemove 는 movementX/Y 를, 드래그는
//   clientX/Y 차분을 주는데 둘 다 같은 look(dxPx, dyPx) 로 들어간다. 두 규약이 같은 부호를 써도
//   되는지는 추론이 아니라 측정이 정한다(2026-08-03, node 실측):
//     look(+100, 0) → Δyaw = −0.26 rad. forward = (sin yaw, 0, cos yaw) 이고 오른쪽은
//     cross(forward, worldUp) = (−cos yaw, 0, sin yaw)(M13 이 FPS 오른쪽으로 확정한 축)인데
//     d(forward)/d(yaw) = −right 이므로 **yaw 감소 = 오른쪽 회전**이다. 실측 dir·right = +0.257
//     (yaw 0 / 1.0 / −2.2 전부 동일). 세로도 같아서 look(0, +100) → pitch −0.22 → dir.y = −0.218,
//     즉 마우스를 내리면 아래를 본다(논인버트).
//   그러므로 종전 주석이 부르던 "화면을 잡아 끄는 규약"은 사실이 아니다. 드래그는 이미 시선 규약
//   (오른쪽으로 끌면 오른쪽을 본다)이고, FPS 락 규약(movementX>0 → 오른쪽)과 **부호가 같다**.
//   값이 1 이라서 상수를 없애지 않는 이유: 두 입력 규약의 관계를 배선부에 매직 부호로 흩뿌리지
//   않고 한 곳에서 단언하기 위해서다(check-walk-control R3 이 이 상수를 import 해 고정한다).
export const LOOK_POINTER_LOCK_SIGN = 1;

// 목표 속도로의 선형 램프. 감속(0 으로 가거나 방향이 뒤집히거나 상한이 낮아질 때)은 더 센 비율을
//   쓴다. 지수 스무딩과 달리 **정확히 target 에 도달**하므로 "정지 명령 후 t초 내 완전 정지"를
//   부등식이 아니라 등식으로 단언할 수 있다.
function rampTo(v, target, dt, fixedRate = 0) {
  const rate = fixedRate > 0
    ? fixedRate
    : (Math.abs(target) < Math.abs(v) || target * v < 0) ? MOVE_DECEL : MOVE_ACCEL;
  const d = target - v;
  const step = rate * dt;
  return Math.abs(d) <= step ? target : v + Math.sign(d) * step;
}
const AUTO_LOOK_AHEAD = 3.0;
const AUTO_TURN_SPEED = 24 * DEG;
const AUTO_TURN_ACCELERATION = 120 * DEG;
const AUTO_MOVE_CONE = 62 * DEG;
const AUTO_TURN_PAUSE = 0.35;
const AUTO_PITCH = -7.5 * DEG;  // 골목 노면이 화면을 채우지 않을 만큼만 내려본다
const AUTO_PITCH_RATE = 4;      // 지수 스무딩(1초에 ~98% 수렴) — 수동 전환 시점의 값을 사용자가 인수
// 담장선 접근(#30 R3): 노면 중앙 대신 담 쪽으로 붙여 화면 하단을 담·기단·풀언저리가 먹게 한다.
const WALL_KEEP_MIN = 1.5, WALL_KEEP_MAX = 2.0;   // 최근접 solid 까지 목표 거리 밴드
const WALL_OFFSET_STEP = 0.25, WALL_OFFSET_MAX = 4.0;
const WALL_HUG_SPACING = 3;     // 담 붙이기 전 중앙선 리샘플 간격(m)
const WALL_SIDE_PROBE = 1.0;    // 좌우 어느 쪽에 담이 가까운지 볼 때의 시험 오프셋
const WALL_SAFE_MIN = 1.1;      // 경로 점·중간점이 지켜야 할 최소 여유(BODY 0.45 + 슬랙)
const WALL_PROBE_MAX = 8;       // 이 거리 안에 담이 없으면 붙일 담이 없는 것으로 본다
// 산책 가로 선택(#30 R3): 담이 늘어선 조밀한 골목을 고른다. mainRoad 는 가장 넓은 대로를 준다.
const STROLL_MIN_SPAN = 40;         // 이보다 짧은 스팬은 산책로로 쓰지 않는다
const STROLL_TARGET_SPAN = 100;     // 길이 보너스 포화 지점
const STROLL_WALL_NEAR = 4;         // 담이 이 거리 안에 있으면 '담이 늘어선' 지점
const STROLL_WALKABLE_MIN = 0.98;   // 중앙선이 solid 안에 들어가는 후보는 탈락
const ROUTE_END_MARGIN = 0.6;       // 이 안에 들면 종점 도달로 보고 되돌아선다
const ROUTE_PROJECT_WINDOW = 8;     // 투영 탐색 창(m) — 자기 근처로 되돌아오는 골목 오검출 방지
const AUTO_LOOK_MIN_DIST = 1.2;     // 전방점이 이보다 가까우면 접선으로 대체(자기 위치 붕괴 방지)

export function createWalker({ site, plan, heightAt } = {}) {
  const H = typeof heightAt === 'function' ? heightAt : (site && site.heightAt) || (() => 0);
  const C = site.center, bowlR = site.bowlR, R = site.R;
  const MAXR = bowlR * 1.12;                 // 경계 하드 캡
  // Gate-aware semantic solids (walls + house OBB); drone still uses buildObstacles.
  const obstacles = buildWalkSolids(plan, H);

  // (x,z) 가 어떤 solid(+몸 반경) 안이면 true.
  const collides = (nx, nz) => pointHitsWalkSolids(obstacles, nx, nz, BODY);
  // 필지 안이면 남(+z)으로 밀어 열린 지점 확보(안전 스폰).
  const nudgeOut = (x, z) => {
    if (!collides(x, z)) return { x, z };
    const step = Math.max(2, R * 0.02);
    let px = x, pz = z;
    for (let i = 0; i < 60; i++) { pz += step; if (!collides(px, pz)) break; }
    return { x: px, z: pz };
  };

  // ── 자동 산책 경로(도로 폴리라인) ── 드론 flythrough 와 같은 시가지 밀도 스팬만 쓴다. 밀도 판정은
  //   드론과 동일한 buildObstacles/roofTopAt 계약면이며(담 solid 가 아니라 지붕), 짧은 도로는
  //   트리밍 없이 원본을 돌려받는다.
  const entrance = site.entrance || { x: C.x, z: C.z + bowlR * 0.3 };
  const roofObstacles = buildObstacles(plan, H);

  // 최근접 solid 까지의 거리 — pointHitsWalkSolids 의 팽창 반경을 이분해 구한다(담·집 OBB 공용).
  const solidClearance = (px, pz) => {
    let lo = 0, hi = WALL_PROBE_MAX;
    if (!pointHitsWalkSolids(obstacles, px, pz, hi)) return hi;
    for (let k = 0; k < 20; k++) {
      const mid = (lo + hi) / 2;
      if (pointHitsWalkSolids(obstacles, px, pz, mid)) hi = mid; else lo = mid;
    }
    return hi;
  };

  // ── 산책 가로 선택(#30 R3) ── 이 모드는 문서대로 "1인칭 골목 탐색"이다. mainRoad(길이×등급)는
  //   가장 넓은 대로를 주는데, capital 의 그 대로는 담이 8m 안에 하나도 없는 빈 회랑이라 화면 하단이
  //   전부 흙바닥이 된다. 그래서 담이 가까이 늘어선 조밀한 가로를 고른다: 중앙선이 실제로 걸을 수
  //   있어야 하고(도로 리본이 담 런과 겹치는 후보는 탈락), 담 근접률 × 지붕 밀도 × 길이로 점수를 낸다.
  //   후보가 없으면 mainRoad 로 폴백한다(단일 도로 픽스처는 그 도로가 그대로 선택된다).
  const roadSpanOf = (r) => denseRoadSpan(r.pts, roofObstacles, R).pts;
  const spanLenOf = (pts) => {
    let l = 0;
    for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
    return l;
  };
  const scoreStrollSpan = (pts) => {
    const len = spanLenOf(pts);
    if (len < STROLL_MIN_SPAN) return null;
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
    const total = cum[cum.length - 1] || 1;
    const at = (s) => {
      let i = 1; while (i < cum.length && cum[i] < s) i++;
      const a = pts[i - 1], b = pts[Math.min(i, pts.length - 1)];
      const seg = (cum[Math.min(i, cum.length - 1)] - cum[i - 1]) || 1;
      const f = (s - cum[i - 1]) / seg;
      return { x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f };
    };
    const disc = R * DENSITY_DISC_RATIO;
    let walkable = 0, wallNear = 0, dens = 0;
    const n = 20;
    for (let k = 0; k <= n; k++) {
      const p = at((k / n) * total);
      const clr = solidClearance(p.x, p.z);
      if (clr > BODY) walkable++;
      if (clr < STROLL_WALL_NEAR) wallNear++;
      dens += roofDensityAt(roofObstacles, p.x, p.z, disc).hits;
    }
    if (walkable / (n + 1) < STROLL_WALKABLE_MIN) return null;
    const score = (wallNear / (n + 1)) * (dens / (n + 1)) * Math.min(1, len / STROLL_TARGET_SPAN);
    return { score, len };
  };
  let centreline = null;
  {
    let best = null;
    for (const r of (plan.roads || [])) {
      if (!r.pts || r.pts.length < 2) continue;
      const pts = roadSpanOf(r);
      const scored = scoreStrollSpan(pts);
      if (!scored) continue;
      if (!best || scored.score > best.score || (scored.score === best.score && scored.len > best.len)) {
        best = { ...scored, pts };
      }
    }
    if (best) centreline = best.pts.slice();
  }
  if (!centreline) {
    const road = mainRoad(plan);
    centreline = road
      ? roadSpanOf(road).slice()
      : [{ x: C.x, z: C.z + bowlR * 0.4 }, { x: C.x, z: C.z - bowlR * 0.4 }];
  }
  const endpointDistance = (point) => Math.hypot(point.x - entrance.x, point.z - entrance.z);
  if (endpointDistance(centreline[centreline.length - 1]) < endpointDistance(centreline[0])) centreline.reverse();
  // ── 담장선 접근(#30 R3) ── 노면 중앙을 걷으면 화면 하단 1/3 이 빈 흙바닥이다. 각 정점을 밀집측
  //   법선으로 밀어 최근접 solid 가 WALL_KEEP 밴드에 들어오는 가장 큰 오프셋을 고른다. 담이 탐색
  //   범위 안에 없으면(넓은 대로) 중앙을 그대로 쓴다 — 없는 담에 붙일 수는 없다. BODY(0.45)보다
  //   한참 여유가 있는 밴드라 충돌 슬라이드가 상시 발생하지 않는다.
  // 정점만 밀면 정점 사이 긴 직선 구간은 여전히 노면 중앙이다. 먼저 ~3m 간격으로 리샘플한 뒤 민다.
  const hugSource = (() => {
    const cum = [0];
    for (let i = 1; i < centreline.length; i++) {
      cum.push(cum[i - 1] + Math.hypot(centreline[i].x - centreline[i - 1].x, centreline[i].z - centreline[i - 1].z));
    }
    const total = cum[cum.length - 1] || 1;
    const steps = Math.max(2, Math.min(200, Math.round(total / WALL_HUG_SPACING)));
    const out = [];
    for (let k = 0; k <= steps; k++) {
      const s = (k / steps) * total;
      let i = 1; while (i < cum.length && cum[i] < s) i++;
      const a = centreline[i - 1], b = centreline[Math.min(i, centreline.length - 1)];
      const seg = (cum[Math.min(i, cum.length - 1)] - cum[i - 1]) || 1;
      const f = (s - cum[i - 1]) / seg;
      out.push({ x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f });
    }
    return out;
  })();
  const hugCandidate = hugSource.map((p, i) => {
    const a = hugSource[Math.max(0, i - 1)], b = hugSource[Math.min(hugSource.length - 1, i + 1)];
    const tx = b.x - a.x, tz = b.z - a.z;
    const tl = Math.hypot(tx, tz);
    if (tl < 1e-6) return { x: p.x, z: p.z };
    const nx = -tz / tl, nz = tx / tl;
    // 담이 어느 쪽에 더 가까운지로 정한다(지붕 밀도가 아니라 실제 담 거리 — 붙을 대상이 담이다).
    const probe = (sgn) => solidClearance(p.x + nx * sgn * WALL_SIDE_PROBE, p.z + nz * sgn * WALL_SIDE_PROBE);
    const side = probe(1) <= probe(-1) ? 1 : -1;
    if (solidClearance(p.x, p.z) <= WALL_KEEP_MAX) return { x: p.x, z: p.z };  // 이미 붙어 있다
    let picked = null;
    for (let d = WALL_OFFSET_STEP; d <= WALL_OFFSET_MAX + 1e-6; d += WALL_OFFSET_STEP) {
      const qx = p.x + nx * side * d, qz = p.z + nz * side * d;
      const clr = solidClearance(qx, qz);
      if (clr < WALL_KEEP_MIN) break;       // 더 밀면 담을 침범한다
      if (clr <= WALL_KEEP_MAX) picked = { x: qx, z: qz };
    }
    return picked || { x: p.x, z: p.z };
  });
  // 점만 밴드에 넣으면 점 사이 직선이 튀어나온 담 코너를 스쳐 보행자가 끼인다(village golmok 에서
  //   중앙값 이격이 0.45m = BODY 로 눌려 200s 동안 62m 만 이동했다). 이웃과의 중간점까지 안전
  //   여유를 확인하고, 실패하면 그 점만 중앙선으로 되돌린다.
  const routePts = hugCandidate.map((q) => ({ x: q.x, z: q.z }));
  for (let i = 0; i < routePts.length; i++) {
    const mids = [];
    if (i > 0) mids.push({ x: (routePts[i - 1].x + routePts[i].x) / 2, z: (routePts[i - 1].z + routePts[i].z) / 2 });
    if (i < routePts.length - 1) mids.push({ x: (routePts[i].x + hugCandidate[i + 1].x) / 2, z: (routePts[i].z + hugCandidate[i + 1].z) / 2 });
    const unsafe = solidClearance(routePts[i].x, routePts[i].z) < WALL_SAFE_MIN
      || mids.some((m) => solidClearance(m.x, m.z) < WALL_SAFE_MIN);
    if (unsafe) routePts[i] = { x: hugSource[i].x, z: hugSource[i].z };
  }
  const routeCum = [0];
  for (let i = 1; i < routePts.length; i++) {
    routeCum.push(routeCum[i - 1] + Math.hypot(
      routePts[i].x - routePts[i - 1].x,
      routePts[i].z - routePts[i - 1].z,
    ));
  }
  const routeLen = routeCum[routeCum.length - 1] || 1;
  const sampleRoute = (s) => {
    s = clamp(s, 0, routeLen);
    let i = 1; while (i < routeCum.length && routeCum[i] < s) i++;
    const a = routePts[i - 1], b = routePts[Math.min(i, routePts.length - 1)];
    const seg = (routeCum[Math.min(i, routeCum.length - 1)] - routeCum[i - 1]) || 1;
    const f = (s - routeCum[i - 1]) / seg;
    return { x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f };
  };

  // 실제 위치를 경로에 투영해 호길이를 얻는다. 이동량 적분(routeS += moved)은 코너를 자르거나
  //   담에 막혀 미끄러지는 순간부터 실제 위치와 어긋나고, 한번 어긋나면 종점 판정이 영원히 오지
  //   않는다 — 그러면 전방점이 자기 위치로 붕괴해 선호 회전측 힌트가 제자리 무한 회전을 만든다.
  //   이전 값 주변 창만 탐색해 자기 근처로 되돌아오는 골목에서 엉뚱한 구간으로 튀지 않게 한다.
  const projectRoute = (px, pz, aroundS) => {
    const lo = aroundS - ROUTE_PROJECT_WINDOW, hi = aroundS + ROUTE_PROJECT_WINDOW;
    let bestS = aroundS, bestD = Infinity;
    for (let i = 1; i < routePts.length; i++) {
      const s0 = routeCum[i - 1], s1 = routeCum[i];
      if (s1 < lo || s0 > hi) continue;
      const a = routePts[i - 1], b = routePts[i];
      const vx = b.x - a.x, vz = b.z - a.z;
      const vv = vx * vx + vz * vz || 1;
      const t = clamp(((px - a.x) * vx + (pz - a.z) * vz) / vv, 0, 1);
      const qx = a.x + vx * t, qz = a.z + vz * t;
      const d = (px - qx) * (px - qx) + (pz - qz) * (pz - qz);
      if (d < bestD) { bestD = d; bestS = s0 + (s1 - s0) * t; }
    }
    return clamp(bestS, 0, routeLen);
  };

  // ── 스폰 ── 스팬 끝점은 시가지 경계라 capital 에서는 시전 밖 공터로 떨어진다. 스팬 안에서 밀도가
  //   가장 높은 지점(= 가로가 가장 조밀한 곳)에서 시작하고, 남은 거리가 더 긴 쪽으로 먼저 걷는다.
  //   지붕이 하나도 없는 합성 픽스처에서는 종전대로 첫 끝점에서 시작한다.
  let spawnS = 0;
  {
    const disc = R * DENSITY_DISC_RATIO;
    let bestHits = 0;
    const probes = Math.max(16, Math.min(600, Math.round(routeLen)));   // ~1m 간격
    for (let i = 0; i <= probes; i++) {
      const s = (i / probes) * routeLen;
      const p = sampleRoute(s);
      const hits = roofDensityAt(roofObstacles, p.x, p.z, disc).hits;
      if (hits > bestHits) { bestHits = hits; spawnS = s; }
    }
  }
  const spawnPoint = sampleRoute(spawnS);
  const spawn = nudgeOut(spawnPoint.x, spawnPoint.z);
  let x = spawn.x, z = spawn.z;
  const routeS0 = spawnS;
  const routeDir0 = routeLen - spawnS >= spawnS ? 1 : -1;
  const initialLook = sampleRoute(spawnS + routeDir0 * AUTO_LOOK_AHEAD);
  let yaw = Math.atan2(initialLook.x - x, initialLook.z - z);
  let pitch = 0;
  let eyeY = H(x, z) + EYE;
  const heading = createHeadingController({
    angle: yaw,
    maxSpeed: AUTO_TURN_SPEED,
    maxAcceleration: AUTO_TURN_ACCELERATION,
  });

  const pos = new THREE.Vector3(x, eyeY, z);
  const dir = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));

  let auto = false, routeS = routeS0, routeDir = routeDir0, turnPause = 0, turnarounds = 0;
  let turnArmed = true;

  // 축분리 이동+슬라이드: 각 축을 독립 시도, 충돌하면 그 축만 취소(담을 따라 미끄러짐).
  function tryStep(dx, dz) {
    const ox = x, oz = z;
    if (!collides(x + dx, z)) x += dx;
    if (!collides(x, z + dz)) z += dz;
    return Math.hypot(x - ox, z - oz);
  }

  // 시선 기준 축. forward = (sin yaw, 0, cos yaw), 오른쪽 = cross(forward, worldUp) = (−cos, 0, sin).
  //   #43 이전에는 여기가 cross(worldUp, forward) = (cos, 0, −sin) 였다. 그 벡터는 **왼쪽**이라
  //   D(strafe +1)가 좌로, A 가 우로 갔다(A/D 반전의 유일한 근원 — App.svelte 의 D=+1/A=−1 키
  //   매핑과 CinematicOverlay 조이스틱 kx/JOY_R 은 둘 다 FPS 표준으로 이미 옳았다).
  const rightX = (a) => -Math.cos(a);
  const rightZ = (a) => Math.sin(a);

  // 자유 이동 — 접지 중 속도는 **로컬 축(전후·좌우)** 에 저장하고 방향은 매 프레임 현재 yaw 로
  //   합성한다. 월드 속도를 관성으로 끌면 돌아설 때 옛 방향으로 미끄러진다(빙판). 로컬 저장은
  //   회전을 즉시 반영하므로 짧은 램프의 즉답성을 지키면서 시작·정지의 뚝뚝 끊김만 없앤다.
  //   체공 중에는 반대다: 속도를 **월드 축**으로 옮겨 든다. 로컬 저장을 그대로 두면 공중에서
  //   뒤돌아보는 것만으로 이동 방향이 따라 꺾여(포물선이 시선을 따라다녀) 도약이 물체가 아니라
  //   커서처럼 읽힌다. 이륙에서 로컬→월드, 착지에서 월드→로컬로 환산해 운동량은 연속이다.
  function freeStep(dt) {
    let f = clamp(cur.fwd, -1, 1), s = clamp(cur.strafe, -1, 1);
    const mag = Math.hypot(f, s); if (mag > 1) { f /= mag; s /= mag; }
    const top = cur.run ? RUN : WALK;
    const fdx = Math.sin(yaw), fdz = Math.cos(yaw);
    const rdx = rightX(yaw), rdz = rightZ(yaw);

    // 이륙 — 접지 중이고 점프 입력이 있을 때만. 체공 중 재입력은 무시된다(이단 점프 금지).
    if (!airborne && cur.jump) {
      airborne = true;
      vy = JUMP_SPEED;
      wvx = fdx * vf + rdx * vs;
      wvz = fdz * vf + rdz * vs;
    }

    if (airborne) {
      // 입력이 있을 때만 월드 속도를 목표 방향으로 끈다. 무입력 체공은 관성 유지(공중 제동 금지).
      if (mag > 0) {
        const air = MOVE_ACCEL * AIR_CONTROL;
        wvx = rampTo(wvx, (fdx * f + rdx * s) * top, dt, air);
        wvz = rampTo(wvz, (fdz * f + rdz * s) * top, dt, air);
        const sp = Math.hypot(wvx, wvz);
        if (sp > RUN) { const k = RUN / sp; wvx *= k; wvz *= k; }
      }
      tryStep(wvx * dt, wvz * dt);
      return;
    }

    vf = rampTo(vf, f * top, dt);
    vs = rampTo(vs, s * top, dt);
    // 두 축은 독립 램프라 방향을 꺾는 과도구간에 합속력이 top 을 넘을 수 있다(전진축이 아직
    //   최고속인 채로 횡축이 붙는다 — 대각 정상상태를 보는 M4 로는 안 잡힌다). 절대 상한 RUN 으로
    //   눌러 프레임 이동량이 RUN·dt 를 넘지 않게 한다(M10 터널링 상한의 근거). Shift 를 놓는
    //   경우는 top 이 아니라 RUN 으로 자르므로 감속이 스냅되지 않고 rampTo 가 그대로 처리한다.
    const sp = Math.hypot(vf, vs);
    if (sp > RUN) { const k = RUN / sp; vf *= k; vs *= k; }
    if (vf === 0 && vs === 0) return;
    tryStep((fdx * vf + rdx * vs) * dt, (fdz * vf + rdz * vs) * dt);
  }

  // 누적 시선 델타 — update 에서 한 번 소비한다. 호출부가 이벤트마다 즉시 회전시키면 렌더 프레임과
  //   포인터 이벤트 빈도가 어긋나 같은 드래그가 기기마다 다른 회전량을 준다.
  function applyLook() {
    if (pendYaw) { yaw += pendYaw; heading.reset(yaw); pendYaw = 0; }
    if (pendPitch) { pitch = clamp(pitch + pendPitch, -PITCH_LIMIT, PITCH_LIMIT); pendPitch = 0; }
  }

  function strollStep(dt) {
    // 시선을 밴드로 스무스하게 끌어내린다. 수동 전환 시 이 값이 그대로 사용자 입력의 시작점이 된다.
    pitch += (AUTO_PITCH - pitch) * (1 - Math.exp(-dt * AUTO_PITCH_RATE));

    // 경로 위 위치는 실제 좌표의 투영으로 재동기한다(적분 누적 오차 없음).
    routeS = projectRoute(x, z, routeS);

    let look = sampleRoute(routeS + routeDir * AUTO_LOOK_AHEAD);
    if (Math.hypot(look.x - x, look.z - z) < AUTO_LOOK_MIN_DIST) {
      // 종점에 붙어 전방점이 자기 위치로 붕괴한 경우 — 경로 접선으로 시선을 유지한다.
      const f = sampleRoute(clamp(routeS + routeDir * 1.0, 0, routeLen));
      const b = sampleRoute(clamp(routeS - routeDir * 1.0, 0, routeLen));
      const tx = f.x - b.x, tz = f.z - b.z;
      const tl = Math.hypot(tx, tz) || 1;
      look = { x: x + (tx / tl) * AUTO_LOOK_AHEAD, z: z + (tz / tl) * AUTO_LOOK_AHEAD };
    }
    const ty = Math.atan2(look.x - x, look.z - z);
    yaw = heading.step(ty, dt, -routeDir);
    const turnError = Math.abs(shortestAngleDelta(yaw, ty, -routeDir));
    turnPause = Math.max(0, turnPause - dt);

    // A walker looks through the turn before moving again. This removes the
    // endpoint skid while preserving gradual motion through ordinary corners.
    const alignment = turnPause > 0
      ? 0
      : clamp((Math.cos(turnError) - Math.cos(AUTO_MOVE_CONE)) / (1 - Math.cos(AUTO_MOVE_CONE)), 0, 1);
    const fdx = Math.sin(yaw), fdz = Math.cos(yaw);
    tryStep(fdx * STROLL * dt * alignment, fdz * STROLL * dt * alignment);

    // 종점 판정은 **투영된 호길이**로 한다. 한 번 뒤집으면 밴드를 벗어날 때까지 재무장하지 않아
    //   경계에서 좌우로 떠는 일이 없다.
    const atEnd = routeDir > 0 ? routeS >= routeLen - ROUTE_END_MARGIN : routeS <= ROUTE_END_MARGIN;
    if (turnArmed && atEnd) {
      routeDir = -routeDir;
      turnPause = AUTO_TURN_PAUSE;
      turnarounds++;
      turnArmed = false;
    } else if (!turnArmed
      && routeS > ROUTE_END_MARGIN * 3 && routeS < routeLen - ROUTE_END_MARGIN * 3) {
      turnArmed = true;
    }
  }

  const cur = { fwd: 0, strafe: 0, run: false, jump: false };
  let vf = 0, vs = 0;               // 접지 중 로컬 전후·좌우 속도(m/s)
  let wvx = 0, wvz = 0;             // 체공 중 월드 수평 속도(m/s)
  let vy = 0, airborne = false;     // 수직 속도(m/s)·체공 여부
  let pendYaw = 0, pendPitch = 0;   // 미소비 시선 증분(rad)

  function setInput(partial = {}) {
    if ('fwd' in partial) cur.fwd = partial.fwd || 0;
    if ('strafe' in partial) cur.strafe = partial.strafe || 0;
    if ('run' in partial) cur.run = !!partial.run;
    if ('jump' in partial) cur.jump = !!partial.jump;
  }

  function update(dt, input) {
    dt = Math.min(Math.max(dt, 0), 0.1);      // 큰 dt 터널링 방지
    if (input) {
      setInput(input);
      if (input.yaw) pendYaw += input.yaw;
      if (input.pitch) pendPitch += input.pitch;
    }
    if (auto) {
      strollStep(dt);
    } else {
      applyLook();
      freeStep(dt);
    }

    // 경계: MAXR 초과는 원형 분지 안으로 하드 캡.
    const rr = Math.hypot(x - C.x, z - C.z);
    if (rr > MAXR) { const k = MAXR / rr; x = C.x + (x - C.x) * k; z = C.z + (z - C.z) * k; }

    const ground = H(x, z);
    if (airborne) {
      // 포물선 — 등가속 **정확적분**(y += v·dt − ½g·dt², v −= g·dt)이라 샘플이 연속해 위에 정확히
      //   놓인다. 심플렉틱 오일러(v 먼저 갱신)를 쓰면 정점이 v₀·dt/2 = 54mm 낮아져 저작한 높이와
      //   실제 도달 높이가 갈린다 — 그러면 "기단은 넘고 담은 못 넘는다"를 수치로 단언할 수 없다.
      eyeY += vy * dt - 0.5 * JUMP_GRAVITY * dt * dt;
      vy -= JUMP_GRAVITY * dt;
      const landY = ground + EYE;
      if (vy <= 0 && eyeY <= landY) {
        // 착지 — 눈높이를 지형에 클램프하고 월드 수평 속도를 로컬 축으로 되돌린다(운동량 연속).
        eyeY = landY;
        vy = 0;
        airborne = false;
        const fdx = Math.sin(yaw), fdz = Math.cos(yaw);
        vf = wvx * fdx + wvz * fdz;
        vs = wvx * rightX(yaw) + wvz * rightZ(yaw);
        wvx = wvz = 0;
      }
    } else {
      // 접지: 목표 시선고로 지수 스무딩(단차 완화) + 침하 방지 하한.
      const desired = ground + EYE;
      eyeY += (desired - eyeY) * (1 - Math.exp(-dt * GROUND_FOLLOW_RATE));
      if (eyeY < ground + 0.1) eyeY = ground + 0.1;
    }

    pos.set(x, eyeY, z);
    dir.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)).normalize();
    return { pos, dir };
  }

  return {
    update, pos, dir, setInput,
    // 포인터 델타(px) → 시선. 감도는 코어가 소유하므로 데스크톱 드래그·터치 드래그가 같은 값을 쓴다.
    look(dxPx = 0, dyPx = 0) { pendYaw -= dxPx * LOOK_YAW_PER_PX; pendPitch -= dyPx * LOOK_PITCH_PER_PX; },
    lookRadians(dYaw = 0, dPitch = 0) { pendYaw += dYaw; pendPitch += dPitch; },
    get yaw() { return yaw; }, set yaw(v) { yaw = v; heading.reset(v); },
    get pitch() { return pitch; }, set pitch(v) { pitch = clamp(v, -PITCH_LIMIT, PITCH_LIMIT); },
    get autoStroll() { return auto; },
    startAutoStroll() { auto = true; heading.reset(yaw); vf = vs = wvx = wvz = vy = 0; airborne = false; },
    stopAutoStroll() {
      auto = false; heading.reset(yaw);
      cur.fwd = cur.strafe = 0; cur.run = cur.jump = false;
      vf = vs = wvx = wvz = vy = 0; airborne = false; pendYaw = pendPitch = 0;
    },
    setPos(nx, nz) {
      const p = nudgeOut(nx, nz); x = p.x; z = p.z; eyeY = H(x, z) + EYE; pos.set(x, eyeY, z);
      vy = 0; airborne = false; wvx = wvz = 0;
    },
    lookAt() { return pos.clone().add(dir); },
    // 검증·엔진 배선용 디버그/조회 훅.
    eyeHeight: EYE, bodyRadius: BODY, maxRadius: MAXR, center: { x: C.x, z: C.z },
    walkSpeed: WALK, runSpeed: RUN, jumpHeight: JUMP_HEIGHT, gravity: JUMP_GRAVITY,
    speed() { return airborne ? Math.hypot(wvx, wvz) : Math.hypot(vf, vs); },
    velocity() {
      if (!airborne) return { fwd: vf, strafe: vs };
      const fdx = Math.sin(yaw), fdz = Math.cos(yaw);
      return { fwd: wvx * fdx + wvz * fdz, strafe: wvx * rightX(yaw) + wvz * rightZ(yaw) };
    },
    grounded() { return !airborne; },
    verticalSpeed() { return vy; },
    groundClearance() { return eyeY - H(x, z); },
    isColliding() { return collides(x, z); },
    outsideBoundary() { return Math.hypot(x - C.x, z - C.z) > MAXR + 1e-3; },
    turnRate() { return heading.velocity; },
    turnaroundCount() { return turnarounds; },
  };
}
