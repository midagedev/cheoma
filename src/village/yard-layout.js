// Pure, renderer-independent layout contract for the hard objects that share a
// parcel yard with fruit trees. `walls.js` consumes the placement helpers while
// `gardens.js` consumes the matching obstacle footprints. Keeping the arithmetic
// here prevents a visually harmless renderer refactor from silently moving a shed
// or jar platform through an already accepted tree.

export const YARD_HARD_GAP = 0.12;

const AUX_ROOF_OVERHANG = 0.28;
const AUX_MAX_YAW = 0.1;
const JAR_OVERHANG = 0.12;
const GARDEN_STONE_MARGIN = 0.08;

function rectangle(kind, mode, x, z, halfWidth, halfDepth) {
  return { kind, mode, shape: 'rect', x, z, halfWidth, halfDepth };
}

function circle(kind, mode, x, z, radius) {
  return { kind, mode, shape: 'circle', x, z, radius };
}

export function yardAuxLayout(plotW, plotD) {
  const width = Math.min(plotW * 0.3, 3.2);
  const depth = Math.min(plotD * 0.22, 2.6);
  return {
    width,
    depth,
    roofOverhang: AUX_ROOF_OVERHANG,
    x: plotW / 2 - width / 2 - 0.4,
    z: -plotD / 2 + depth / 2 + 0.6,
  };
}

export function yardJangdokLayout(plotW, plotD, level) {
  const rows = Math.max(0, level | 0);
  const perRow = 2 + rows;
  const width = Math.min(plotW * 0.4, perRow * 0.62 + 0.4);
  const depth = rows * 0.56 + 0.3;
  return {
    rows,
    perRow,
    width,
    depth,
    x: -plotW / 2 + width / 2 + 0.5,
    z: -plotD / 2 + depth / 2 + 0.5,
  };
}

export function yardStackLayout(plotW, plotD, radius) {
  return {
    x: plotW / 2 - radius - 0.6,
    z: -plotD / 2 + radius + 0.7,
  };
}

export function yardClotheslineLayout(plotW, plotD, angle) {
  const span = Math.min(plotW * 0.44, 3.6);
  return {
    span,
    height: 1.7,
    angle,
    x: -plotW * 0.25,
    z: plotD * 0.225,
    dx: Math.cos(angle),
    dz: Math.sin(angle),
  };
}

export function yardGardenPatchLayout(plotW, plotD, offsetX = 0, offsetZ = 0) {
  return {
    width: Math.min(plotW * 0.46, 4.6),
    depth: Math.min(plotD * 0.3, 3.4),
    x: -plotW * 0.16 + offsetX,
    z: plotD * 0.18 + offsetZ,
  };
}

export function yardHwagyePosition(parcel, x, hero = parcel.hero) {
  return { x, z: -parcel.plotD * (hero ? 0.45 : 0.425) };
}

export function yardGwaeseokPosition(parcel, side, hero = parcel.hero) {
  return {
    x: side * parcel.plotW * (hero ? 0.25 : 0.29),
    z: -parcel.plotD * (hero ? 0.43 : 0.25),
  };
}

export function yardSeokjiPosition(parcel, side, hero = parcel.hero) {
  const rock = yardGwaeseokPosition(parcel, side, hero);
  return hero
    ? { x: rock.x - side * 1.2, z: -parcel.plotD * 0.41 }
    : { x: rock.x - side * 1.1, z: rock.z + 1.0 };
}

function auxObstacle(plotW, plotD) {
  const layout = yardAuxLayout(plotW, plotD);
  const rawHalfWidth = layout.width / 2 + layout.roofOverhang;
  const rawHalfDepth = layout.depth / 2 + layout.roofOverhang;
  const c = Math.cos(AUX_MAX_YAW), s = Math.sin(AUX_MAX_YAW);
  return rectangle(
    'aux', 'canopy', layout.x, layout.z,
    rawHalfWidth * c + rawHalfDepth * s,
    rawHalfWidth * s + rawHalfDepth * c,
  );
}

function stackObstacle(plotW, plotD) {
  // The rendered stack radius is sampled in [0.7, 1.05]. This rectangle is the
  // exact XZ envelope of every possible circle and does not consume the wall RNG.
  return rectangle(
    'yard-stack', 'canopy',
    plotW / 2 - 1.65,
    -plotD / 2 + 1.75,
    1.05,
    1.05,
  );
}

function gardenHardObstacles(parcel, { exact = false, side = 1, hwagyeX = 0 } = {}) {
  const level = parcel.gardenLevel || 0;
  if (!parcel.hero && level < 2) return [];
  const hero = !!parcel.hero;
  const sides = exact ? [side] : [-1, 1];
  const out = [];

  if (hero || level >= 3) {
    const position = yardHwagyePosition(parcel, exact ? hwagyeX : 0, hero);
    out.push(rectangle(
      'hwagye', 'trunk',
      position.x,
      position.z - 0.26,
      1.3 + (exact ? 0 : 1),
      0.54 + GARDEN_STONE_MARGIN,
    ));
  }
  for (const gardenSide of sides) {
    const rock = yardGwaeseokPosition(parcel, gardenSide, hero);
    out.push(circle('gwaeseok', 'trunk', rock.x, rock.z, 0.5 + GARDEN_STONE_MARGIN));
    if (hero || level >= 3) {
      const pond = yardSeokjiPosition(parcel, gardenSide, hero);
      out.push(circle('seokji', 'trunk', pond.x, pond.z, 0.58 + GARDEN_STONE_MARGIN));
    }
  }
  return out;
}

export function yardHardObstacles(parcel, gardenOptions) {
  const plotW = parcel.plotW;
  const plotD = parcel.plotD;
  const out = [];

  if (parcel.aux) out.push(auxObstacle(plotW, plotD));

  const jangdok = yardJangdokLayout(plotW, plotD, parcel.jangdok || 0);
  if (jangdok.rows > 0) {
    out.push(rectangle(
      'jangdok', 'trunk', jangdok.x, jangdok.z,
      jangdok.width / 2 + JAR_OVERHANG,
      jangdok.depth / 2 + JAR_OVERHANG,
    ));
  }

  if (parcel.yardStack && !parcel.aux) out.push(stackObstacle(plotW, plotD));

  if (parcel.clothesline) {
    const line = yardClotheslineLayout(plotW, plotD, 0);
    out.push(circle('clothesline', 'canopy', line.x, line.z, line.span / 2 + 0.28));
  }

  if (parcel.vegBed) {
    const patch = yardGardenPatchLayout(plotW, plotD, plotW * 0.3, plotD * 0.1);
    out.push(rectangle('vegetable-bed', 'trunk', patch.x, patch.z, patch.width / 2, patch.depth / 2));
  }
  if ((parcel.wallType || 'stone') === 'open') {
    const patch = yardGardenPatchLayout(plotW, plotD);
    out.push(rectangle('open-garden', 'trunk', patch.x, patch.z, patch.width / 2, patch.depth / 2));
  }

  out.push(...gardenHardObstacles(parcel, gardenOptions));
  return out;
}

export function yardTreeIntersectsHardObstacle(point, footprint, obstacles) {
  for (const obstacle of obstacles || []) {
    const rawRadius = obstacle.mode === 'canopy'
      ? footprint?.canopyRadius : footprint?.trunkRadius;
    const radius = Math.max(0, Number.isFinite(rawRadius) ? rawRadius : 0) + YARD_HARD_GAP;
    if (obstacle.shape === 'circle') {
      if (Math.hypot(point.x - obstacle.x, point.z - obstacle.z)
        <= radius + obstacle.radius) return true;
      continue;
    }
    const dx = point.x < obstacle.x - obstacle.halfWidth
      ? obstacle.x - obstacle.halfWidth - point.x
      : point.x > obstacle.x + obstacle.halfWidth
        ? point.x - obstacle.x - obstacle.halfWidth : 0;
    const dz = point.z < obstacle.z - obstacle.halfDepth
      ? obstacle.z - obstacle.halfDepth - point.z
      : point.z > obstacle.z + obstacle.halfDepth
        ? point.z - obstacle.z - obstacle.halfDepth : 0;
    if (Math.hypot(dx, dz) <= radius) return true;
  }
  return false;
}
