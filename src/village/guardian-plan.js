import { makeRng } from '../rng.js';
import * as G from '../core/math/geom2.js';
import {
  CITY_WALL_DIMENSIONS,
  cityWallVegetationBlocked,
  worldEdgeClearance,
} from './citywall-contour.js';

// 보호수(당산나무) 위치만 다루는 순수 계획 단계. THREE 지오메트리와 분리해 작은 성곽을
// 강제한 경우에도 수관 전체가 성벽·문루·접근로를 침범하지 않는지 빠르게 계약 검사할 수 있다.
// 기존 선형 탐색을 먼저 유지하고, 막혔을 때만 동심 탐색으로 입구 주변의 빈터를 찾는다.
const TAU = Math.PI * 2;
const SEARCH_STEP = 2.4;
const LINEAR_ATTEMPTS = 12;
const RADIAL_RINGS = 8;

export function planGuardianTrees(plan, site, seed) {
  const rng = makeRng((seed ^ 0x60a2d) >>> 0);
  const C = site.center, R = site.R, scale = plan.scale;
  const cityWall = plan.features?.cityWall || null;
  const southGate = cityWall?.gates.find((gate) => gate.name === 'south') || null;
  const E = southGate || site.entrance;
  const toC = southGate
    ? { x: -southGate.dirX, z: -southGate.dirZ }
    : G.norm(G.sub(C, E));
  const perp = G.perpL(toC);
  const parcels = plan.parcels || [];
  const clearOfParcels = (x, z) => {
    for (const p of parcels) {
      const radius = Math.max(p.plotW, p.plotD) * 0.5 + 6;
      if ((x - p.center.x) ** 2 + (z - p.center.z) ** 2 < radius * radius) return false;
    }
    return true;
  };
  const clearAt = (x, z, visualRadius = 0) => clearOfParcels(x, z)
    // 무성곽 마을의 기존 보호수 배치는 그대로 둔다. 성곽 회피로 재탐색할 때만 수관이
    // 지형 끝을 벗어나지 않도록 같은 footprint 계약을 추가한다.
    && (!cityWall || !site.edge || worldEdgeClearance(site.edge, { x, z }) >= visualRadius)
    && !cityWallVegetationBlocked(cityWall, { x, z }, {
      corridor: visualRadius + CITY_WALL_DIMENSIONS.vegetationClearance,
      gateMargin: visualRadius + CITY_WALL_DIMENSIONS.gateVegetationMargin,
      gateApproachMargin: visualRadius,
    });
  const nudge = (x0, z0, dx, dz, visualRadius = 0) => {
    for (let k = 0; k < LINEAR_ATTEMPTS; k++) {
      const x = x0 + dx * k * SEARCH_STEP, z = z0 + dz * k * SEARCH_STEP;
      if (clearAt(x, z, visualRadius)) return { x, z };
    }
    // 성곽이 없는 기존 마을은 12회 실패 시 원래 후보를 쓰던 장면 계약을 보존한다.
    // 아래의 충돌 회피 확장은 성곽을 강제한 새 경로에만 적용한다.
    if (!cityWall) return { x: x0, z: z0 };
    // 작은 성곽은 입구 축·필지·성벽 여유가 겹칠 수 있다. 한 방향만 계속 밀지 말고 주변 빈터를
    // 가까운 순서로 훑는다. 끝까지 없으면 null을 반환해 충돌한 나무를 억지로 만들지 않는다.
    const baseAngle = Math.atan2(dz, dx);
    for (let ring = 1; ring <= RADIAL_RINGS; ring++) {
      const radius = ring * SEARCH_STEP * 2;
      const steps = 8 + ring * 2;
      const phase = baseAngle + ring * Math.PI * (3 - Math.sqrt(5));
      for (let i = 0; i < steps; i++) {
        const angle = phase + i / steps * TAU;
        const x = x0 + Math.cos(angle) * radius, z = z0 + Math.sin(angle) * radius;
        if (clearAt(x, z, visualRadius)) return { x, z };
      }
    }
    return null;
  };

  const out = [];
  // 동구/남문 보호수: 종류·크기·회전 RNG 순서는 기존 출력과 동일하다.
  {
    const kind = rng() < 0.85 ? 'zelkova' : 'ginkgo';
    const treeScale = rng.range(0.95, 1.15), spin = rng() * TAU;
    const visualRadius = 12 * treeScale;
    const lateral = southGate
      ? Math.max(R * 0.11, southGate.width * 0.5 + CITY_WALL_DIMENSIONS.gateVegetationMargin + visualRadius + 4)
      : R * 0.11;
    const inward = southGate
      ? Math.max(R * 0.05, CITY_WALL_DIMENSIONS.vegetationClearance + visualRadius + 4)
      : R * 0.05;
    const bx = E.x + perp.x * lateral + toC.x * inward;
    const bz = E.z + perp.z * lateral + toC.z * inward;
    const pos = nudge(bx, bz, perp.x, perp.z, visualRadius);
    if (pos) out.push({ ...pos, kind, scale: treeScale, spin, props: true });
  }
  // 중심 명당(종가/관아 옆) — 실제 수관 반경으로 검사한다.
  if (scale === 'town' || scale === 'capital') {
    const treeScale = rng.range(1.0, 1.2), spin = rng() * TAU;
    const pos = nudge(
      C.x + perp.x * R * 0.15,
      C.z + perp.z * R * 0.03,
      perp.x,
      perp.z,
      12 * treeScale,
    );
    if (pos) out.push({ ...pos, kind: 'zelkova', scale: treeScale, spin, props: true });
  }
  // 개울가 — 실제 수관 반경으로 검사한다.
  if (scale === 'capital') {
    const kind = rng() < 0.6 ? 'zelkova' : 'ginkgo';
    const treeScale = rng.range(0.9, 1.1), spin = rng() * TAU;
    const pos = nudge(R * 0.3, site.streamZ - R * 0.02, 1, 0, 12 * treeScale);
    if (pos) out.push({ ...pos, kind, scale: treeScale, spin, props: false });
  }
  return out;
}
