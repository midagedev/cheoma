// Regular tiled-house footprint grammar shared by the builder, village planner,
// impostor LOD, and editor readback.  Coordinates follow the village contract:
// local +z is the south/front courtyard side.  Polygons are clockwise because
// roof-skeleton derives its exterior normals from that winding.

export const GIWA_PLAN_SHAPES = Object.freeze(['single', 'l', 'u']);
export const GIWA_U_MIN_BAYS = 4;

const GIWA_MIN = Object.freeze({ a: 2.4, b: 1.6, c: 2.6, w: 1.6 });
const GIWA_WING_MAX_K = 0.72;

export function normalizeGiwaPlan(shape = 'l', bays = 3) {
  const planShape = GIWA_PLAN_SHAPES.includes(shape) ? shape : 'l';
  const requested = Number.isFinite(bays) ? Math.round(bays) : 3;
  return {
    planShape,
    bays: Math.max(planShape === 'u' ? GIWA_U_MIN_BAYS : 3, Math.min(5, requested)),
  };
}

export function giwaFootprintMetrics(P = {}) {
  const plan = normalizeGiwaPlan(P.planShape, P.bays);
  const bay = Math.max(1.8, Number.isFinite(P.bay) ? P.bay : 2.2);
  // A declared bay count is a lower bound on the actual main range.  This keeps
  // a four-bay U legible even when an edit supplies a stale narrow mainHalfW.
  const a = Math.max(GIWA_MIN.a, plan.bays * bay * 0.5, Number(P.mainHalfW) || 0);
  const b = Math.max(GIWA_MIN.b, Number(P.mainHalfD) || 0);
  const c = Math.max(GIWA_MIN.c, Number(P.wingLen) || 0);
  const w = Math.min(
    Math.max(GIWA_MIN.w, Number(P.wingW) || 0),
    GIWA_WING_MAX_K * a,
  );
  return { ...plan, a, b, w, c };
}

export function giwaFootprintPoints(P = {}) {
  const { planShape, a, b, w, c } = giwaFootprintMetrics(P);
  if (planShape === 'single') {
    return [
      { x: -a, z: b }, { x: a, z: b },
      { x: a, z: -b }, { x: -a, z: -b },
    ];
  }
  if (planShape === 'u') {
    return [
      { x: -a, z: b + c }, { x: -a + w, z: b + c },
      { x: -a + w, z: b }, { x: a - w, z: b },
      { x: a - w, z: b + c }, { x: a, z: b + c },
      { x: a, z: -b }, { x: -a, z: -b },
    ];
  }
  return [
    { x: -a, z: b }, { x: a - w, z: b }, { x: a - w, z: b + c },
    { x: a, z: b + c }, { x: a, z: -b }, { x: -a, z: -b },
  ];
}

// Courtyard-facing main range used for doors, daecheong, and toenmaru.
export function giwaFrontRange(P = {}) {
  const foot = giwaFootprintMetrics(P);
  if (foot.planShape === 'single') return { x0: -foot.a, x1: foot.a, z: foot.b };
  if (foot.planShape === 'u') return { x0: -foot.a + foot.w, x1: foot.a - foot.w, z: foot.b };
  return { x0: -foot.a, x1: foot.a - foot.w, z: foot.b };
}
