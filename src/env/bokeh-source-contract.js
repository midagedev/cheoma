// Renderer-free source-scatter contract shared by the gather, scatter, and gates.
export const BOKEH_HIGHLIGHT_PREFILTER_ANALYTIC_TAP_COUNT = 37;
export const BOKEH_HIGHLIGHT_PREFILTER_OWNERSHIP_TAP_COUNT = 4;
export const BOKEH_HIGHLIGHT_PREFILTER_GUARD_EXTRA_TAP_COUNT = 12;
export const BOKEH_HIGHLIGHT_PREFILTER_TOTAL_TAP_COUNT =
  BOKEH_HIGHLIGHT_PREFILTER_ANALYTIC_TAP_COUNT +
  BOKEH_HIGHLIGHT_PREFILTER_OWNERSHIP_TAP_COUNT +
  BOKEH_HIGHLIGHT_PREFILTER_GUARD_EXTRA_TAP_COUNT;

export const BOKEH_SOURCE_CONTRACT = Object.freeze({
  blockSize: 2,
  exactOwnershipAlpha: 1,
  gatherSupportAlpha: 0.25,
  gatherSupportCutoff: 0.125,
  exactOwnershipCutoff: 0.75,
  ownershipBroadSupportCutoff: 0.3,
  sharpRadiusPx: 0.45,
  isolation: 0.35,
  pointCoverage: 2,
  profileCore: 0.72,
  profileRim: 0.9,
  profilePower: 12,
  profileIntegral: 0.8485714286,
});

export function bokehSourceGridDimensions(width, height) {
  const safeWidth = Math.max(1, Math.floor(width));
  const safeHeight = Math.max(1, Math.floor(height));
  return Object.freeze({
    width: safeWidth,
    height: safeHeight,
    columns: Math.ceil(safeWidth / BOKEH_SOURCE_CONTRACT.blockSize),
    rows: Math.ceil(safeHeight / BOKEH_SOURCE_CONTRACT.blockSize),
  });
}

export function bokehSourceCellUv(width, height, column, row) {
  const grid = bokehSourceGridDimensions(width, height);
  const halfBlock = BOKEH_SOURCE_CONTRACT.blockSize * 0.5;
  return Object.freeze([
    (column * BOKEH_SOURCE_CONTRACT.blockSize + halfBlock) / grid.width,
    (row * BOKEH_SOURCE_CONTRACT.blockSize + halfBlock) / grid.height,
  ]);
}

export function bokehSourceNeedsTriangles(requiredDiameter, maxPointSize) {
  return (
    Math.ceil(Math.max(0, requiredDiameter)) >
    Math.floor(Math.max(0, maxPointSize))
  );
}

export function selectBokehSourceBackend(
  currentBackend,
  requiredDiameter,
  maxPointSize,
) {
  return currentBackend === "triangles" ||
    bokehSourceNeedsTriangles(requiredDiameter, maxPointSize)
    ? "triangles"
    : "points";
}
