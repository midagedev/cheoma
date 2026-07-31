import * as G from '../core/math/geom2.js';
import { parcelLocalBodyPolygons } from '../village/house-footprint.js';
import { parcelWorldPoint } from '../village/parcel-contract.js';
import {
  splitVillageWallGate,
  villageWallProfile,
  VILLAGE_SOLID_WALL_THICKNESS,
} from '../village/wall-contract.js';
import {
  CITY_WALL_DIMENSIONS,
  cityGateLocalPoint,
  cityGateMasonryProfile,
  cityWallAngleInGate,
  cityWallClearance,
  normalOnCityWall,
} from '../village/citywall-contour.js';

// First-person walk collision solids (#150 item J).
//   buildWalkSolids(plan) → oriented xz solids the walker treats as solid.
//
// Regular residential parcels no longer use the whole lot as one OBB. Solids are:
//   - wall run segments from wall-contract / plan access (gate gap open)
//   - house body polygons (not roof eaves; not a fat AABB that fills ㄱ/ㄷ courtyards)
// Hero compounds, palace, and temple keep conservative footprint solids so free
// walk cannot slip through multi-hall complexes that lack a walker gate contract.
// Auto-stroll still follows road polylines only — these solids only affect free
// walk / collision queries. No mesh-bvh; pure plan geometry.
//
// 도성 성곽(hanyang) — R3 Phase B. 성벽 몸통과 성문 육축은 여기 들어오기 전까지 **아무 solid 도
//   없었다**: 1인칭 자유 이동이 여장·홍예·육축을 그대로 통과했다. 몸통은 3m 지형 세그먼트가 한양에서
//   800개를 넘으므로 OBB 로 펼치지 않고 극좌표 contour 의 해석적 환대(annulus) 한 개로 표현한다
//   (점 질의 O(1)). 문 각도 구간은 몸통에서 빼고 육축 두 덩이가 대신 solid 가 되므로, 홍예 통로는
//   통행 가능하게 남는다 — 성문의 존재 이유다. 육축 footprint 는 citywall-contour 의 masonry spec
//   최저 켜(배터 인셋 0 = 가장 넓은 단면)를 그대로 쓴다(계획-충돌 이중 진실 금지).

const FOOT_PAD = 1.12;
// 방사→수직 두께 환산의 하한(contour 기울기가 극단적인 지점에서 band 폭발 방지).
const CITY_WALL_RADIAL_MIN_COS = 0.35;
const MIN_SEG = 0.08;

const facingY = (dir) => (dir ? Math.atan2(dir.x, dir.z) : 0);

/** Oriented box in the walker's inverse-local convention (same as dronepath). */
export function makeWalkSolid(cx, cz, fullW, fullD, rotY, meta = {}) {
  return {
    type: 'obb',
    cx,
    cz,
    hw: fullW * 0.5,
    hd: fullD * 0.5,
    cos: Math.cos(rotY),
    sin: Math.sin(rotY),
    ...meta,
  };
}

/** World-space polygon solid (house body). Supports L/U without fat AABB courtyard fill. */
export function makeWalkPolySolid(pts, meta = {}) {
  if (!pts || pts.length < 3) return null;
  return { type: 'poly', pts: pts.map((p) => ({ x: p.x, z: p.z })), ...meta };
}

export function pointHitsWalkSolid(solid, x, z, bodyRadius = 0) {
  const r = bodyRadius > 0 ? bodyRadius : 0;
  if (solid.type === 'poly' || solid.pts) {
    const pt = { x, z };
    if (G.pointInPoly(pt, solid.pts)) return true;
    if (r > 0) {
      const pts = solid.pts;
      for (let i = 0; i < pts.length; i++) {
        if (G.distToSeg(pt, pts[i], pts[(i + 1) % pts.length]).d <= r) return true;
      }
    }
    return false;
  }
  if (solid.type === 'citywall') {
    const spec = solid.spec;
    const dx = x - spec.cx, dz = z - spec.cz;
    const angle = Math.atan2(dx, dz);
    // 문 각도 구간은 육축 solid 가 맡는다(홍예는 통행 가능해야 한다).
    if (cityWallAngleInGate(spec, angle)) return false;
    const clearance = Math.abs(cityWallClearance(spec, { x, z }));
    // 대부분의 질의는 성벽에서 멀다 — 최대 밴드로 먼저 걸러 법선 계산을 피한다(핫 패스).
    const maxBand = (solid.half + r) / CITY_WALL_RADIAL_MIN_COS;
    if (clearance > maxBand) return false;
    // cityWallClearance 는 **방사** 여유다. 비원형 contour 에서는 방사 방향이 벽면 법선과 어긋나므로
    //   수직 두께를 방사 두께로 환산해야 얇은 띠로 새어나가지 않는다.
    const normal = normalOnCityWall(spec, angle);
    const cosT = Math.abs(normal.x * Math.sin(angle) + normal.z * Math.cos(angle));
    return clearance <= (solid.half + r) / Math.max(CITY_WALL_RADIAL_MIN_COS, cosT);
  }
  const dx = x - solid.cx, dz = z - solid.cz;
  const lx = dx * solid.cos - dz * solid.sin;
  const lz = dx * solid.sin + dz * solid.cos;
  return Math.abs(lx) <= solid.hw + r && Math.abs(lz) <= solid.hd + r;
}

/** 성벽 몸통 — 극좌표 contour 의 해석적 환대. 문 각도 구간은 제외된다. */
export function cityWallBodySolid(spec, thickness = CITY_WALL_DIMENSIONS.thickness) {
  return { type: 'citywall', spec, half: thickness * 0.5, kind: 'citywall' };
}

/** 성문 육축 두 덩이 — masonry spec 최저 켜(가장 넓은 단면) footprint 를 월드 폴리곤으로. */
export function cityGateMasonrySolids(gate, site) {
  const masonry = cityGateMasonryProfile(gate, site);
  const out = [];
  for (const zone of masonry.zones) {
    const rect = zone.courses[0].bottom;
    const pts = [
      cityGateLocalPoint(gate, rect.x0, rect.z0),
      cityGateLocalPoint(gate, rect.x1, rect.z0),
      cityGateLocalPoint(gate, rect.x1, rect.z1),
      cityGateLocalPoint(gate, rect.x0, rect.z1),
    ];
    out.push(makeWalkPolySolid(pts, { kind: 'citygate', gate: gate.name, side: zone.side }));
  }
  return out;
}

export function pointHitsWalkSolids(solids, x, z, bodyRadius = 0) {
  for (let i = 0; i < solids.length; i++) {
    if (pointHitsWalkSolid(solids[i], x, z, bodyRadius)) return true;
  }
  return false;
}

function wallHalfDepth(style, thickness) {
  if (style === 'hedge') return 0.74;
  if (style === 'brush') return 0.12;
  if (style === 'open') return 0;
  const body = Number.isFinite(thickness) ? thickness : (VILLAGE_SOLID_WALL_THICKNESS[style] ?? 0.5);
  return Math.max(0.12, body * 0.5 + 0.04);
}

/** Segment solid along world polyline a→b; local +x along the run, +z through thickness. */
export function wallSegmentSolid(a, b, halfDepth, meta = {}) {
  const dx = b.x - a.x, dz = b.z - a.z;
  const length = Math.hypot(dx, dz);
  if (length < MIN_SEG || halfDepth <= 0) return null;
  // rotY maps local +x to world tangent (cos, -sin) = unit (dx, dz)/len
  // → cos = dx/len, sin = -dz/len → rotY = atan2(-dz, dx)
  const rotY = Math.atan2(-dz, dx);
  return makeWalkSolid(
    (a.x + b.x) * 0.5,
    (a.z + b.z) * 0.5,
    length,
    halfDepth * 2,
    rotY,
    meta,
  );
}

/**
 * Wall run slabs for one parcel. Gate edge is split with the same
 * villageWallProfile + splitVillageWallGate math the renderer uses, so the
 * access.gateEdge/gateT opening is not solid.
 */
export function parcelWallWalkSolids(parcel) {
  if (!parcel || parcel.hero || !parcel.shape?.pts?.length) return [];
  const style = parcel.wallType || 'stone';
  if (style === 'open') return [];

  const profile = villageWallProfile(parcel.shape, {
    style,
    plotW: parcel.plotW,
    plotD: parcel.plotD,
    gateEdge: parcel.access?.gateEdge,
    gateT: parcel.access?.gateT,
  });
  const { pts, gateEdge, gateT, gap } = profile;
  const thickness = VILLAGE_SOLID_WALL_THICKNESS[style] ?? (style === 'brush' || style === 'hedge' ? 0.24 : 0.5);
  const halfDepth = wallHalfDepth(style, thickness);
  if (halfDepth <= 0) return [];

  const solids = [];
  const n = pts.length;
  for (let index = 0; index < n; index++) {
    const aLocal = pts[index];
    const bLocal = pts[(index + 1) % n];
    const a = parcelWorldPoint(parcel, aLocal);
    const b = parcelWorldPoint(parcel, bLocal);

    if (index === gateEdge) {
      const split = splitVillageWallGate(aLocal, bLocal, gateT, gap);
      if (!split) {
        // Edge too short for a gate: treat as continuous wall (fail closed).
        const solid = wallSegmentSolid(a, b, halfDepth, {
          kind: 'wall',
          parcelId: parcel.id,
          edge: index,
        });
        if (solid) solids.push(solid);
        continue;
      }
      const left = parcelWorldPoint(parcel, split.left);
      const right = parcelWorldPoint(parcel, split.right);
      const leftSolid = wallSegmentSolid(a, left, halfDepth, {
        kind: 'wall',
        parcelId: parcel.id,
        edge: index,
        side: 'left',
      });
      const rightSolid = wallSegmentSolid(right, b, halfDepth, {
        kind: 'wall',
        parcelId: parcel.id,
        edge: index,
        side: 'right',
      });
      if (leftSolid) solids.push(leftSolid);
      if (rightSolid) solids.push(rightSolid);
      continue;
    }

    const solid = wallSegmentSolid(a, b, halfDepth, {
      kind: 'wall',
      parcelId: parcel.id,
      edge: index,
    });
    if (solid) solids.push(solid);
  }
  return solids;
}

/**
 * House body mass as world polygons (not roof eaves, not fat AABB).
 * L/U plans keep their courtyard open; only the wall body blocks.
 */
export function parcelHouseWalkSolids(parcel) {
  if (!parcel || (parcel.kind !== 'choga' && parcel.kind !== 'giwa')) return [];
  const polygons = parcelLocalBodyPolygons(parcel);
  if (!polygons.length) return [];
  const solids = [];
  for (let i = 0; i < polygons.length; i++) {
    const world = polygons[i].map((p) => parcelWorldPoint(parcel, p));
    // Optional uniform pad: expand polygon slightly so the body radius does not
    // need to swallow every corner alone. Skip when pad is ~1.
    const solid = makeWalkPolySolid(world, {
      kind: 'house',
      parcelId: parcel.id,
      part: i,
    });
    if (solid) solids.push(solid);
  }
  return solids;
}

/** First house solid (single-body parcels); null if none. */
export function parcelHouseWalkSolid(parcel) {
  return parcelHouseWalkSolids(parcel)[0] || null;
}

/**
 * Representative point on/inside a house solid for pure gates.
 * Vertex average of an L/U polygon can land in the courtyard hole — prefer a
 * triangle centroid that is actually inside, else a vertex (edge-distance hit).
 */
export function houseSolidProbePoint(solid) {
  if (!solid) return null;
  if (solid.type === 'poly' || solid.pts) {
    const pts = solid.pts;
    if (pts.length < 3) return null;
    for (let i = 1; i < pts.length - 1; i++) {
      const c = {
        x: (pts[0].x + pts[i].x + pts[i + 1].x) / 3,
        z: (pts[0].z + pts[i].z + pts[i + 1].z) / 3,
      };
      if (G.pointInPoly(c, pts)) return c;
    }
    return { x: pts[0].x, z: pts[0].z };
  }
  return { x: solid.cx, z: solid.cz };
}

/** Conservative full-lot OBB for hero compounds and non-gate-aware footprints. */
export function parcelFootprintWalkSolid(parcel, heightAt) {
  if (!parcel?.center) return null;
  let bw = parcel.plotW, bd = parcel.plotD, lcx = 0, lcz = 0;
  const pts = parcel.shape?.pts;
  if (pts && pts.length >= 3) {
    let mnx = Infinity, mxx = -Infinity, mnz = Infinity, mxz = -Infinity;
    for (const q of pts) {
      if (q.x < mnx) mnx = q.x;
      if (q.x > mxx) mxx = q.x;
      if (q.z < mnz) mnz = q.z;
      if (q.z > mxz) mxz = q.z;
    }
    bw = mxx - mnx;
    bd = mxz - mnz;
    lcx = (mnx + mxx) * 0.5;
    lcz = (mnz + mxz) * 0.5;
  }
  if (!(bw > 0) || !(bd > 0)) return null;
  const rotY = facingY(parcel.frontDir) + (parcel.yaw || 0);
  const cos = Math.cos(rotY), sin = Math.sin(rotY);
  const wcx = parcel.center.x + lcx * cos + lcz * sin;
  const wcz = parcel.center.z - lcx * sin + lcz * cos;
  const H = typeof heightAt === 'function' ? heightAt : () => 0;
  const baseY = Number.isFinite(parcel.baseY) ? parcel.baseY : H(parcel.center.x, parcel.center.z);
  const roofH = parcel.hero ? 14 : (parcel.kind === 'giwa' ? 9 : 6.5);
  return makeWalkSolid(
    wcx,
    wcz,
    bw * FOOT_PAD,
    bd * FOOT_PAD,
    rotY,
    {
      kind: parcel.hero ? 'hero' : 'footprint',
      parcelId: parcel.id,
      top: baseY + roofH,
    },
  );
}

function featureSolids(plan, heightAt) {
  const H = typeof heightAt === 'function' ? heightAt : () => 0;
  const out = [];
  const f = plan?.features || {};
  if (f.palace) {
    out.push(makeWalkSolid(
      f.palace.x,
      f.palace.z,
      (f.palace.plotW || 60) * FOOT_PAD,
      (f.palace.plotD || 90) * FOOT_PAD,
      facingY(f.palace.frontDir),
      { kind: 'palace', top: H(f.palace.x, f.palace.z) + 18 },
    ));
  }
  if (f.temple) {
    out.push(makeWalkSolid(
      f.temple.x,
      f.temple.z,
      40 * FOOT_PAD,
      40 * FOOT_PAD,
      0,
      { kind: 'temple', top: H(f.temple.x, f.temple.z) + 13 },
    ));
  }
  return out;
}

/**
 * Build the walker's solid set for a village plan.
 * @param {object} plan village plan (parcels + features)
 * @param {function} [heightAt] optional height sampler (only for feature/hero tops)
 */
export function buildWalkSolids(plan, heightAt) {
  const H = typeof heightAt === 'function' ? heightAt
    : (plan && plan.site && plan.site.heightAt) || (() => 0);
  const solids = [];

  for (const parcel of (plan?.parcels || [])) {
    if (parcel.hero) {
      const footprint = parcelFootprintWalkSolid(parcel, H);
      if (footprint) solids.push(footprint);
      continue;
    }

    // Gate-aware residential: walls with gap + house body mass.
    if (parcel.kind === 'giwa' || parcel.kind === 'choga') {
      for (const house of parcelHouseWalkSolids(parcel)) solids.push(house);
      for (const w of parcelWallWalkSolids(parcel)) solids.push(w);
      continue;
    }

    // Other parcel kinds: conservative footprint.
    const footprint = parcelFootprintWalkSolid(parcel, H);
    if (footprint) solids.push(footprint);
  }

  for (const solid of featureSolids(plan, H)) solids.push(solid);

  // 도성 성곽(hanyang 전용) — 몸통 해석적 환대 1개 + 성문마다 육축 2덩이.
  const cityWall = plan?.features?.cityWall;
  if (cityWall) {
    solids.push(cityWallBodySolid(cityWall));
    for (const gate of (cityWall.gates || [])) {
      for (const solid of cityGateMasonrySolids(gate, plan.site)) solids.push(solid);
    }
  }
  return solids;
}

/**
 * Sample whether free-walk may pass a road-side → gate → courtyard probe.
 *
 * The corridor is the gate-edge outward normal (not the raw road→gate chord).
 * access.roadPoint only chooses which side of the ring is "outside"; a skewed
 * road chord near a corner can skim a wall end without meaning the gap is closed
 * (parcel-contract documents that road→gate is not a guaranteed alley path).
 * Returns { clear, blockedAt }. Does not claim multi-parcel 고샅 topology.
 */
export function sampleGateCourtyardPath(parcel, solids, {
  bodyRadius = 0.45,
  steps = 12,
  outsideDist = 1.2,
  insideDist = 0.9,
} = {}) {
  const access = parcel?.access;
  const pts = parcel?.shape?.pts;
  if (!access?.gatePoint || !Number.isInteger(access.gateEdge) || !pts?.length || !parcel?.center) {
    return { clear: false, reason: 'no-access' };
  }
  const edge = access.gateEdge;
  const aLocal = pts[edge];
  const bLocal = pts[(edge + 1) % pts.length];
  const a = parcelWorldPoint(parcel, aLocal);
  const b = parcelWorldPoint(parcel, bLocal);
  const ex = b.x - a.x, ez = b.z - a.z;
  const el = Math.hypot(ex, ez) || 1;
  // Outward normal of the ring: edge tangent × up, oriented away from parcel center.
  let nx = ez / el, nz = -ex / el;
  const mid = { x: (a.x + b.x) * 0.5, z: (a.z + b.z) * 0.5 };
  if ((parcel.center.x - mid.x) * nx + (parcel.center.z - mid.z) * nz > 0) {
    nx = -nx;
    nz = -nz;
  }
  // Prefer the road side when roadPoint is known (should match outward for regular lots).
  if (access.roadPoint) {
    const rx = access.roadPoint.x - access.gatePoint.x;
    const rz = access.roadPoint.z - access.gatePoint.z;
    if (rx * nx + rz * nz < 0) {
      nx = -nx;
      nz = -nz;
    }
  }

  const gate = access.gatePoint;
  const outside = {
    x: gate.x + nx * outsideDist,
    z: gate.z + nz * outsideDist,
  };
  const courtyard = {
    x: gate.x - nx * insideDist,
    z: gate.z - nz * insideDist,
  };

  const path = [outside, gate, courtyard];
  for (let s = 0; s < path.length - 1; s++) {
    const pa = path[s], pb = path[s + 1];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = pa.x + (pb.x - pa.x) * t;
      const z = pa.z + (pb.z - pa.z) * t;
      if (pointHitsWalkSolids(solids, x, z, bodyRadius)) {
        return { clear: false, blockedAt: { x, z }, segment: s, t, outside, gate, courtyard };
      }
    }
  }
  return { clear: true, outside, gate, courtyard, normal: { x: nx, z: nz } };
}

/** Mid-edge of a non-gate wall should be solid (blocked for a body-radius probe). */
export function sampleWallMidBlocked(parcel, solids, bodyRadius = 0.45) {
  if (!parcel?.shape?.pts?.length) return { blocked: false, reason: 'no-shape' };
  const style = parcel.wallType || 'stone';
  if (style === 'open') return { blocked: false, reason: 'open-wall' };
  const profile = villageWallProfile(parcel.shape, {
    style,
    plotW: parcel.plotW,
    plotD: parcel.plotD,
    gateEdge: parcel.access?.gateEdge,
    gateT: parcel.access?.gateT,
  });
  const { pts, gateEdge } = profile;
  const n = pts.length;
  for (let index = 0; index < n; index++) {
    if (index === gateEdge) continue;
    const a = parcelWorldPoint(parcel, pts[index]);
    const b = parcelWorldPoint(parcel, pts[(index + 1) % n]);
    const mid = { x: (a.x + b.x) * 0.5, z: (a.z + b.z) * 0.5 };
    if (pointHitsWalkSolids(solids, mid.x, mid.z, bodyRadius)) {
      return { blocked: true, edge: index, mid };
    }
  }
  return { blocked: false, reason: 'no-mid-hit' };
}
