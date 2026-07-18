import * as THREE from 'three';
import { buildObstacles, mainRoad } from './dronepath.js';

// 시네마틱 데모 — 1인칭 골목 탐색 (태스크 #103).
//   createWalker({ site, plan, heightAt }) → walker
//     walker.update(dt, input) → { pos, dir }    input:{ fwd, strafe, yaw, pitch, run }
//       fwd/strafe ∈ [-1,1] 이동 의도, yaw/pitch 는 이번 프레임 시선 회전 증분(rad, 호출부가 감도 적용),
//       run: true 면 달리기(2.8m/s).
//     walker.pos  Vector3(x, 시선고 y, z)      walker.dir  Vector3 시선 단위벡터
//     walker.startAutoStroll() / stopAutoStroll()  — 도로 폴리라인 따라 자동 산책(데모 클립)
//     walker.setPos(x,z) / walker.yaw / walker.pitch
//
// 접지: 시선고 = heightAt + 1.6m, 계단·성토 패드 단차를 지수 스무딩(단차에서 튀지 않게). 하한 클램프로
//   지면 침하(발이 땅 아래) 0 보장. 충돌: 필지 풋프린트(담 포함)를 solid OBB 로 보고 축분리 슬라이드
//   (뚫고 들어가기 금지). 대문 개구 통과는 미구현(간이) — 필지 전체를 solid 로 취급, 담을 따라 미끄러짐.
//   경계: 마을 분지(bowlR) 밖으로 소프트 클램프(bowlR·1.12 하드 캡).

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const EYE = 1.6;
const WALK = 1.4, RUN = 2.8;
const BODY = 0.45;              // 몸 반경(담과의 이격)

// 최단각 보간(±π 래핑).
function lerpAngle(a, b, t) {
  let d = ((b - a + Math.PI) % (2 * Math.PI)) - Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return a + d * t;
}

export function createWalker({ site, plan, heightAt } = {}) {
  const H = typeof heightAt === 'function' ? heightAt : (site && site.heightAt) || (() => 0);
  const C = site.center, bowlR = site.bowlR, R = site.R;
  const MAXR = bowlR * 1.12;                 // 경계 하드 캡
  const SOFTR = bowlR * 1.0;                 // 여기서부터 바깥 성분 감쇠(소프트)
  const obstacles = buildObstacles(plan, H); // 지붕 top 은 미사용, 풋프린트 OBB 만 사용

  // (x,z) 가 어떤 담(풋프린트+몸 반경) 안이면 true.
  const collides = (nx, nz) => {
    for (const o of obstacles) {
      const dx = nx - o.cx, dz = nz - o.cz;
      const lx = dx * o.cos - dz * o.sin, lz = dx * o.sin + dz * o.cos;
      if (Math.abs(lx) <= o.hw + BODY && Math.abs(lz) <= o.hd + BODY) return true;
    }
    return false;
  };
  // 필지 안이면 남(+z)으로 밀어 열린 지점 확보(안전 스폰).
  const nudgeOut = (x, z) => {
    if (!collides(x, z)) return { x, z };
    const step = Math.max(2, R * 0.02);
    let px = x, pz = z;
    for (let i = 0; i < 60; i++) { pz += step; if (!collides(px, pz)) break; }
    return { x: px, z: pz };
  };

  // ── 상태 ──
  const spawn = nudgeOut(
    site.entrance ? site.entrance.x : C.x,
    site.entrance ? site.entrance.z : (C.z + bowlR * 0.3),
  );
  let x = spawn.x, z = spawn.z;
  let yaw = Math.atan2(C.x - x, C.z - z);    // 초기 시선: 마을 중심
  let pitch = 0;
  let eyeY = H(x, z) + EYE;

  const pos = new THREE.Vector3(x, eyeY, z);
  const dir = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));

  // ── 자동 산책 경로(도로 폴리라인) ──
  let auto = false, routeS = 0, routeDir = 1;
  const road = mainRoad(plan);
  const routePts = road ? road.pts.slice() : [{ x: C.x, z: C.z + bowlR * 0.4 }, { x: C.x, z: C.z - bowlR * 0.4 }];
  const routeCum = [0];
  for (let i = 1; i < routePts.length; i++) routeCum.push(routeCum[i - 1] + Math.hypot(routePts[i].x - routePts[i - 1].x, routePts[i].z - routePts[i - 1].z));
  const routeLen = routeCum[routeCum.length - 1] || 1;
  const sampleRoute = (s) => {
    s = clamp(s, 0, routeLen);
    let i = 1; while (i < routeCum.length && routeCum[i] < s) i++;
    const a = routePts[i - 1], b = routePts[Math.min(i, routePts.length - 1)];
    const seg = (routeCum[Math.min(i, routeCum.length - 1)] - routeCum[i - 1]) || 1;
    const f = (s - routeCum[i - 1]) / seg;
    return { x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f };
  };

  // 축분리 이동+슬라이드: 각 축을 독립 시도, 충돌하면 그 축만 취소(담을 따라 미끄러짐).
  function tryStep(dx, dz) {
    if (!collides(x + dx, z)) x += dx;
    if (!collides(x, z + dz)) z += dz;
  }

  function freeStep(dt) {
    let f = clamp(cur.fwd, -1, 1), s = clamp(cur.strafe, -1, 1);
    const mag = Math.hypot(f, s); if (mag > 1) { f /= mag; s /= mag; }
    const spd = (cur.run ? RUN : WALK) * dt;
    const fdx = Math.sin(yaw), fdz = Math.cos(yaw);
    const rdx = Math.cos(yaw), rdz = -Math.sin(yaw);
    tryStep((fdx * f + rdx * s) * spd, (fdz * f + rdz * s) * spd);
  }

  function strollStep(dt) {
    routeS += WALK * dt * routeDir;
    if (routeS >= routeLen) { routeS = routeLen; routeDir = -1; }
    else if (routeS <= 0) { routeS = 0; routeDir = 1; }
    const look = sampleRoute(routeS + routeDir * 3.0);
    const ty = Math.atan2(look.x - x, look.z - z);
    yaw = lerpAngle(yaw, ty, 1 - Math.exp(-dt * 4));
    const fdx = Math.sin(yaw), fdz = Math.cos(yaw);
    tryStep(fdx * WALK * dt, fdz * WALK * dt);
  }

  const cur = { fwd: 0, strafe: 0, run: false };

  function update(dt, input = {}) {
    dt = Math.min(Math.max(dt, 0), 0.1);      // 큰 dt 터널링 방지
    if (auto) {
      strollStep(dt);
    } else {
      if (input.yaw) yaw += input.yaw;
      if (input.pitch) pitch = clamp(pitch + input.pitch, -1.2, 1.2);
      cur.fwd = input.fwd || 0; cur.strafe = input.strafe || 0; cur.run = !!input.run;
      freeStep(dt);
    }

    // 경계: SOFTR..MAXR 사이는 바깥 성분 감쇠, MAXR 초과는 하드 캡.
    const rr = Math.hypot(x - C.x, z - C.z);
    if (rr > MAXR) { const k = MAXR / rr; x = C.x + (x - C.x) * k; z = C.z + (z - C.z) * k; }

    // 접지: 목표 시선고로 지수 스무딩(단차 완화) + 침하 방지 하한.
    const ground = H(x, z);
    const desired = ground + EYE;
    eyeY += (desired - eyeY) * (1 - Math.exp(-dt * 8));
    if (eyeY < ground + 0.1) eyeY = ground + 0.1;

    pos.set(x, eyeY, z);
    dir.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)).normalize();
    return { pos, dir };
  }

  return {
    update, pos, dir,
    get yaw() { return yaw; }, set yaw(v) { yaw = v; },
    get pitch() { return pitch; }, set pitch(v) { pitch = clamp(v, -1.2, 1.2); },
    get autoStroll() { return auto; },
    startAutoStroll() { auto = true; },
    stopAutoStroll() { auto = false; cur.fwd = cur.strafe = 0; cur.run = false; },
    setPos(nx, nz) { const p = nudgeOut(nx, nz); x = p.x; z = p.z; eyeY = H(x, z) + EYE; pos.set(x, eyeY, z); },
    lookAt() { return pos.clone().add(dir); },
    // 검증·엔진 배선용 디버그/조회 훅.
    eyeHeight: EYE, bodyRadius: BODY, maxRadius: MAXR, center: { x: C.x, z: C.z },
    groundClearance() { return eyeY - H(x, z); },
    isColliding() { return collides(x, z); },
    outsideBoundary() { return Math.hypot(x - C.x, z - C.z) > MAXR + 1e-3; },
  };
}
