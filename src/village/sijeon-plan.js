import * as G from '../core/math/geom2.js';

// Renderer-free sijeon (licensed-market row) contract.
//
// Placement deliberately preserves the legacy village-plan number path. The
// facade plan uses local coordinates centred on the planned shop:
//   +x = along the row, +z = road/front, +y = up.
// Renderers may merge these records, but must not infer a second footprint or
// move solid storage/wall mass into the road-side corridor.

export const SIJEON_PLACEMENT = Object.freeze({
  pitch: 6.2,
  depth: 8.5,
  setback: 1.4,
  runCap: 26,
});

export const SIJEON_FACADE_SCHEMA_VERSION = 1;
export const SIJEON_FACADE_BAYS = 2;

const BODY_HEIGHT = 3;
const MIN_WIDTH = 4.4;
const MIN_DEPTH = 5.6;

function finiteDimension(value, name) {
  if (!Number.isFinite(value)) throw new TypeError(`sijeon ${name} must be finite`);
  if (value <= 0) throw new RangeError(`sijeon ${name} must be positive`);
  return value;
}

function box(role, x, y, z, width, height, depth, extra = {}) {
  return {
    role,
    center: { x, y, z },
    size: { width, height, depth },
    ...extra,
  };
}

/**
 * Preserve the original Hanyang market-row placement exactly.
 *
 * `char01` remains in the signature because the village planner already passes
 * it, although the historical placement never consumed it. Keeping that no-op
 * input avoids changing callers or the downstream random stream.
 */
export function planSijeon(roadsResult, site, _char01 = 0.5) {
  const shops = [];
  const arterials = (roadsResult?.roads || []).filter((road) => road.level === 'daero');
  const {
    pitch,
    depth,
    setback,
    runCap,
  } = SIJEON_PLACEMENT;
  const bowlR = site.bowlR;
  const others = (road) => arterials.filter((candidate) => candidate !== road);
  let sid = 0;

  for (const road of arterials) {
    const fine = G.resample(road.pts, pitch);
    if (fine.length < 8) continue;
    const halfRoadWidth = road.width / 2;
    const crossingArterials = others(road);
    for (let side = 1; side >= -1; side -= 2) {
      let run = 0;
      for (let i = 3; i < fine.length - 3 && run < runCap; i++) {
        const sample = fine[i];
        if (G.dist(sample.pt, site.center) > bowlR * 0.9) continue;
        const inward = G.mul(G.perpL(sample.tan), side);
        const base = G.add(sample.pt, G.mul(inward, halfRoadWidth + setback));
        let clashes = false;
        for (const other of crossingArterials) {
          if (G.distToPolyline(base, other.pts).d < other.width / 2 + depth) {
            clashes = true;
            break;
          }
        }
        if (clashes) continue;

        const poly = G.frontageParcel(base, sample.tan, inward, pitch * 0.5, depth, 0);
        shops.push({
          id: `s${sid++}`,
          poly,
          center: G.polyCentroid(poly),
          frontDir: G.norm(G.mul(inward, -1)),
          x: base.x,
          z: base.z,
          w: pitch,
          d: depth,
        });
        run++;
      }
    }
  }
  return shops;
}

/**
 * Derive a restrained two-bay shop facade from one placement record.
 *
 * The output is plain serializable data. It describes only physical members;
 * materials, textures, Three.js objects, merge strategy, and LOD remain renderer
 * concerns. Eaves are the sole planned solid allowed beyond `streetEdgeZ`.
 */
export function planSijeonFacade(shop) {
  const lotWidth = finiteDimension(shop?.w, 'width');
  const lotDepth = finiteDimension(shop?.d, 'depth');
  if (lotWidth < MIN_WIDTH) {
    throw new RangeError(`sijeon width must be at least ${MIN_WIDTH}m for two bays`);
  }
  if (lotDepth < MIN_DEPTH) {
    throw new RangeError(`sijeon depth must be at least ${MIN_DEPTH}m`);
  }

  // Preserve the former visible mass while replacing its blank front wall.
  const width = lotWidth * 0.96;
  const depth = lotDepth * 0.86;
  const halfWidth = width / 2;
  const halfDepth = depth / 2;
  const streetEdgeZ = lotDepth / 2;
  const frontZ = halfDepth;
  const backZ = -halfDepth;
  const bayWidth = width / SIJEON_FACADE_BAYS;

  const columnWidth = Math.min(0.26, bayWidth * 0.1);
  const columnDepth = 0.26;
  const columnHeight = BODY_HEIGHT - 0.22;
  const columnZ = frontZ - columnDepth / 2;
  const columnInset = columnWidth / 2;
  const columns = [-halfWidth + columnInset, 0, halfWidth - columnInset]
    .map((x, index) => box(
      'front-column',
      x,
      columnHeight / 2,
      columnZ,
      columnWidth,
      columnHeight,
      columnDepth,
      { index },
    ));

  const lintelHeight = 0.28;
  const lintelDepth = 0.3;
  const lintelWidth = bayWidth - columnWidth;
  const lintelY = columnHeight - lintelHeight / 2;
  const lintels = [-bayWidth / 2, bayWidth / 2].map((x, bay) => box(
    'front-lintel',
    x,
    lintelY,
    frontZ - lintelDepth / 2,
    lintelWidth,
    lintelHeight,
    lintelDepth,
    { bay },
  ));

  const openingRecess = 0.46;
  const openingDepth = 0.12;
  const openingWidth = bayWidth - columnWidth * 1.55;
  const openingSill = 0.22;
  const openingTop = lintelY - lintelHeight / 2 - 0.08;
  const openingHeight = openingTop - openingSill;
  const openings = [-bayWidth / 2, bayWidth / 2].map((x, bay) => box(
    'recessed-opening',
    x,
    openingSill + openingHeight / 2,
    frontZ - openingRecess - openingDepth / 2,
    openingWidth,
    openingHeight,
    openingDepth,
    { bay, recessed: true },
  ));

  const benchHeight = 0.58;
  const benchDepth = Math.min(0.62, lotDepth * 0.075);
  const benchWidth = openingWidth * 0.88;
  const benchFrontZ = Math.min(streetEdgeZ, frontZ + benchDepth * 0.48);
  const benches = [-bayWidth / 2, bayWidth / 2].map((x, bay) => box(
    'display-bench',
    x,
    benchHeight / 2,
    benchFrontZ - benchDepth / 2,
    benchWidth,
    benchHeight,
    benchDepth,
    { bay },
  ));

  const storageDepth = Math.min(2.5, depth * 0.34);
  const storageClearance = 0.16;
  const storage = box(
    'rear-storage',
    0,
    (BODY_HEIGHT - 0.22) / 2,
    backZ + storageDepth / 2,
    width - storageClearance * 2,
    BODY_HEIGHT - 0.22,
    storageDepth,
  );

  const roofWidth = width + 1.4;
  const roofDepth = depth + 1.6;
  const roof = {
    role: 'gable-roof',
    center: { x: 0, y: BODY_HEIGHT, z: 0 },
    width: roofWidth,
    depth: roofDepth,
    rise: 1.7,
    eaveProjection: {
      side: (roofWidth - width) / 2,
      front: Math.max(0, roofDepth / 2 - streetEdgeZ),
      rear: Math.max(0, roofDepth / 2 - lotDepth / 2),
    },
  };

  return {
    schemaVersion: SIJEON_FACADE_SCHEMA_VERSION,
    bayCount: SIJEON_FACADE_BAYS,
    axis: { front: { x: 0, z: 1 } },
    lot: {
      width: lotWidth,
      depth: lotDepth,
      bounds: {
        minX: -lotWidth / 2,
        maxX: lotWidth / 2,
        minZ: -lotDepth / 2,
        maxZ: streetEdgeZ,
      },
    },
    building: {
      width,
      depth,
      height: BODY_HEIGHT,
      bounds: {
        minX: -halfWidth,
        maxX: halfWidth,
        minZ: backZ,
        maxZ: frontZ,
      },
    },
    corridor: {
      streetEdgeZ,
      maxNonEaveZ: streetEdgeZ,
      maxEaveZ: roofDepth / 2,
    },
    columns,
    lintels,
    openings,
    benches,
    storage,
    roof,
  };
}
