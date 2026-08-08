// Public façade for pure JSON map export (colliders, metadata, terrain grid).
// Re-exports only — implementation lives in src/export/map-data.js.
export {
  buildMapColliders,
  buildMapMetadata,
  polygonizeCityWallSolid,
  sampleTerrainHeightGrid,
} from '../export/map-data.js';
