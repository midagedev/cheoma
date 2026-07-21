// Small, world-space separations shared by building generators.
//
// Coplanar decoration should be fixed in geometry, not with polygonOffset: the
// latter makes the result camera-dependent and can still flicker at village
// scale. Six centimetres matches the terrain-road/pad lift contract and stays
// resolvable with the aerial camera's adaptive near plane.
export const FOUNDATION_SINK = 0.06;
export const COURTYARD_SURFACE_LIFT = 0.06;
export const OPENING_FACE_CLEARANCE = 0.02;
export const ROOF_WALL_TUCK = 0.16;

// Preserve the visible top while extending the lowest solid below grade.
export function sunkPrism(top, bottom = 0, sink = FOUNDATION_SINK) {
  const sunkBottom = bottom - sink;
  return {
    bottom: sunkBottom,
    top,
    height: top - sunkBottom,
    center: (top + sunkBottom) * 0.5,
  };
}

// Put an overlay's visible face beyond its host without pulling the whole
// overlay out of the wall. The rear may remain embedded; only the two visible
// faces need a stable depth ordering.
export function overlayCenterOffset(
  hostThickness,
  overlayThickness,
  clearance = OPENING_FACE_CLEARANCE,
) {
  return (hostThickness - overlayThickness) * 0.5 + clearance;
}
