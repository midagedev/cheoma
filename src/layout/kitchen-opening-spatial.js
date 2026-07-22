// Renderer-independent east-wall reservation for the giwa kitchen opening.
// The builder owns Three.js assembly; residential opening planning owns which
// remaining wall spans may receive habitable windows.

const GIWA_KITCHEN = Object.freeze({
  centerZ: 0.7,
  openingWidth: 1.38,
  openingHeight: 1.58,
  frameThickness: 0.11,
  lightRange: 3.6,
});

export function planGiwaKitchenOpening(wallX) {
  if (!Number.isFinite(wallX)) throw new TypeError('giwa kitchen wallX must be finite');
  const openingHalf = GIWA_KITCHEN.openingWidth / 2;
  const reservedHalf = openingHalf + GIWA_KITCHEN.frameThickness;
  return Object.freeze({
    wall: 'east',
    wallX,
    ...GIWA_KITCHEN,
    openingSpanZ: Object.freeze({
      min: GIWA_KITCHEN.centerZ - openingHalf,
      max: GIWA_KITCHEN.centerZ + openingHalf,
    }),
    spanZ: Object.freeze({
      min: GIWA_KITCHEN.centerZ - reservedHalf,
      max: GIWA_KITCHEN.centerZ + reservedHalf,
    }),
  });
}
