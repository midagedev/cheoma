import * as G from '../core/math/geom2.js';
import { rectangularParcelShape } from './parcel-contract.js';

// Renderer-free geometry decisions shared by the village wall builder and
// pointer occlusion. Keeping the gate split and height RNG consumption here
// prevents an invisible interaction wall from drifting away from what is drawn.
export const VILLAGE_WALL_STYLE_HEIGHT = Object.freeze({
  tile: 2.2,
  stone: 1.8,
  mud: 1.7,
  brush: 1.25,
  hedge: 1.1,
});

export function villageWallProfile(shape, {
  style = 'stone',
  plotW,
  plotD,
  gateEdge: requestedGateEdge,
  gateT: requestedGateT,
} = {}) {
  const fallbackW = Number.isFinite(plotW) ? plotW : 12;
  const fallbackD = Number.isFinite(plotD) ? plotD : 10;
  const resolved = shape?.pts?.length >= 3
    ? shape
    : rectangularParcelShape(fallbackW, fallbackD);
  const pts = resolved.pts;
  const roles = resolved.roles || new Array(pts.length).fill(null);
  const defaultGateEdge = Math.max(0, roles.indexOf('front'));
  const gateEdge = Number.isInteger(requestedGateEdge)
    && requestedGateEdge >= 0 && requestedGateEdge < pts.length
    ? requestedGateEdge
    : defaultGateEdge;
  const gateT = Number.isFinite(requestedGateT)
    ? Math.max(0, Math.min(1, requestedGateT))
    : 0.5;
  const width = Number.isFinite(plotW) ? plotW : fallbackW;
  const gap = Math.min(width * 0.34, style === 'tile' ? 3.0 : 2.6);
  return {
    style,
    pts,
    roles,
    edges: resolved.edges || null,
    gateEdge,
    gateT,
    gap,
  };
}

// `rng` is passed by the renderer so its later cosmetic draws keep their exact
// historical sequence. A semantic consumer may pass a fresh seed-local RNG and
// obtains the same first height decision without touching global Math.random.
export function villageWallBaseHeight(style, {
  char01 = 0.5,
  wallHeightK = null,
} = {}, rng = Math.random) {
  const base = VILLAGE_WALL_STYLE_HEIGHT[style];
  if (!Number.isFinite(base)) return 0;
  const variation = wallHeightK != null ? wallHeightK : 0.96 + rng() * 0.1;
  return base * (0.88 + char01 * 0.2) * variation;
}

export function splitVillageWallGate(a, b, requestedT, requestedGap) {
  const length = G.dist(a, b);
  if (length < 0.8) return null;
  const gap = Math.min(requestedGap, Math.max(0.6, length - 0.8));
  const halfT = gap * 0.5 / length;
  const centerT = Math.max(
    halfT + 0.2 / length,
    Math.min(1 - halfT - 0.2 / length, requestedT),
  );
  return {
    length,
    gap,
    centerT,
    center: G.lerp(a, b, centerT),
    left: G.lerp(a, b, centerT - halfT),
    right: G.lerp(a, b, centerT + halfT),
  };
}

// Complete structural wall layout. Cosmetic stone/thatch jitter remains in the
// renderer, while every solid run, skipped shared edge, height multiplier, and
// gate opening is resolved here for renderer/interaction parity.
export function villageWallLayout(shape, opts = {}, rng = Math.random) {
  const style = opts.style || 'stone';
  const profile = villageWallProfile(shape, { ...opts, style });
  const { pts, roles, edges, gateEdge, gateT, gap } = profile;
  const count = pts.length;
  let centerX = 0, centerZ = 0;
  for (const point of pts) { centerX += point.x; centerZ += point.z; }
  centerX /= count; centerZ /= count;

  if (style === 'open') {
    return {
      ...profile,
      baseHeight: 0,
      thickness: 0,
      centerX,
      centerZ,
      edgeLayouts: [],
      cornerPosts: [],
      gate: { edge: gateEdge, centerT: gateT, gap, height: 1.25 },
    };
  }

  const baseHeight = villageWallBaseHeight(style, {
    char01: typeof opts.char01 === 'number' ? opts.char01 : 0.5,
    wallHeightK: opts.wallHeightK,
  }, rng);
  const thickness = style === 'tile' ? 0.42 : 0.5;
  const solid = style !== 'brush' && style !== 'hedge';
  const grow = solid ? 0.4 : 0;
  const edgeLayouts = [];
  let gate = null;
  for (let index = 0; index < count; index++) {
    const edge = edges ? edges[index] : null;
    if (index !== gateEdge && edge?.share) continue;
    const heightK = index === gateEdge ? 1
      : edge ? edge.heightK
        : roles[index] === 'front' ? 1 : roles[index] === 'back' ? 0.72 : 0.7;
    const height = baseHeight * heightK;
    const a = pts[index], b = pts[(index + 1) % count];
    if (index !== gateEdge) {
      edgeLayouts.push({ index, height, runs: [{ a, b, grow }], gate: null });
      continue;
    }
    const split = splitVillageWallGate(a, b, gateT, gap);
    const runs = [];
    if (split) {
      if (G.dist(a, split.left) > 0.05) runs.push({ a, b: split.left, grow });
      if (G.dist(split.right, b) > 0.05) runs.push({ a: split.right, b, grow });
      gate = {
        edge: index,
        centerT: split.centerT,
        gap: split.gap,
        height,
      };
    }
    edgeLayouts.push({ index, height, runs, gate });
  }

  const cornerPosts = [];
  if (style === 'stone' || style === 'mud' || style === 'tile') {
    for (let index = 0; index < count; index++) {
      if (roles[(index - 1 + count) % count] === roles[index]) continue;
      cornerPosts.push({ point: pts[index], height: baseHeight, thickness });
    }
  }
  return {
    ...profile,
    baseHeight,
    thickness,
    centerX,
    centerZ,
    edgeLayouts,
    cornerPosts,
    gate,
  };
}
