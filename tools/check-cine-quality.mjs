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
//   D2 F street-flythrough 고도는 경로 국소 지붕 위 좁은 띠에 머문다(min≥2.0, max≤6.5, 스프레드≤3.0).
//   D2 F flythrough 시선 하향 24~29°.
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
//   W3 F 자동산책 스폰·경로가 밀도 0 구간에 놓이지 않는다.
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
const { buildObstacles, createDronePaths, roofTopAt } = M.drone;

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
  const paths = createDronePaths({ site, plan, heightAt: H, seed: c.seed, sunAzimuth: SUN_AZ });
  const byName = Object.fromEntries(paths.map((p) => [p.name, p]));
  const row = { scale: c.label || c.scale, R: Math.round(R) };

  // ── D1 · D2 street-flythrough ──
  {
    const p = byName['street-flythrough'];
    let zeroDensity = 0;
    let clrMin = Infinity, clrMax = -Infinity, clrSum = 0, clrN = 0;
    let pitchMin = Infinity, pitchMax = -Infinity;
    for (let i = 0; i < N; i++) {
      const s = p.sample(i / (N - 1));
      const d = densityProbe(obs, s.pos.x, s.pos.z, discR);
      if (d.hits === 0) zeroDensity++;
      else {
        const clr = s.pos.y - d.meanTop;
        clrN++; clrSum += clr;
        if (clr < clrMin) clrMin = clr;
        if (clr > clrMax) clrMax = clr;
      }
      const pd = lookMetrics(s).pitchDown / DEG;
      if (pd < pitchMin) pitchMin = pd;
      if (pd > pitchMax) pitchMax = pd;
    }
    const mean = clrN ? clrSum / clrN : NaN;
    row.flyZeroDensity = `${zeroDensity}/${N}`;
    row.flyClr = clrN
      ? [+clrMin.toFixed(2), +mean.toFixed(2), +clrMax.toFixed(2)]
      : ['-', '-', '-'];
    row.flyPitch = [+pitchMin.toFixed(1), +pitchMax.toFixed(1)];
    check(zeroDensity === 0,
      `D1 ${row.scale}: street-flythrough 가 밀도 0 구간을 ${zeroDensity}/${N} 샘플 통과`);
    check(clrN > 0 && clrMin >= 2.0,
      `D2 ${row.scale}: 지붕 위 최소 클리어런스 ${clrMin.toFixed(2)}m < 2.0m`);
    check(clrN > 0 && clrMax <= 6.5,
      `D2 ${row.scale}: 지붕 위 최대 클리어런스 ${clrMax.toFixed(2)}m > 6.5m (부감 스침이 아니다)`);
    check(clrN > 0 && clrMax - clrMin <= 3.0,
      `D2 ${row.scale}: 지붕 위 클리어런스 스프레드 ${(clrMax - clrMin).toFixed(2)}m > 3.0m (지형 추종)`);
    check(pitchMin >= 24 && pitchMax <= 29,
      `D2 ${row.scale}: flythrough 시선 하향 ${pitchMin.toFixed(1)}~${pitchMax.toFixed(1)}° 가 24~29° 밖`);
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
        if (densityProbe(obs, walker.pos.x, walker.pos.z, discR).hits === 0) {
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
  console.log(`  flythrough : 밀도0 ${r.flyZeroDensity}  지붕위 클리어런스 min/mean/max ${r.flyClr.join(' / ')}m  시선하향 ${r.flyPitch.join('~')}°`);
  console.log(`  orbit      : 수관관통 ${r.orbitIntersect} (종전위상 ${r.orbitLegacyIntersect})  최소여유 ${r.orbitCanopyGap}m  리프트 ${r.orbitLift}m  반경 ${r.orbitR.join('~')}m  역광 t=${r.orbitBacklitAt} (이각 ${r.orbitBacklitAng}°)`);
  console.log(`  crane-in   : t0.2~0.5 시선하향 ${r.cranePitch.join('~')}°`);
  console.log(`  pullback   : 최종 하향 ${r.endPitch}°  하늘 ${(r.endSky * 100).toFixed(1)}%`);
  console.log(`  역광방위   : crane/pullback 최대 이각 ${r.rimWorstDeg}°`);
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
