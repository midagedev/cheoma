// Renderer-free orbit semantics shared by the standalone and village camera
// adapters. World vectors are accepted as plain {x,y,z} values and the result
// never retains caller-owned objects.

const DEG = Math.PI / 180;
const LOG_ZOOM_RANGE = 8;
export const MIN_SEMANTIC_VIEW_ELEVATION = 1.1;
export const MAX_SEMANTIC_VIEW_ELEVATION = 88.3;
export const MAX_SEMANTIC_VIEW_PAN = 2;

export function captureSemanticOrbit({
  position,
  target,
  canonicalTarget,
  panScale,
  zoom,
} = {}) {
  const scale = Number(panScale);
  const dx = Number(position?.x) - Number(target?.x);
  const dy = Number(position?.y) - Number(target?.y);
  const dz = Number(position?.z) - Number(target?.z);
  const distance = Math.hypot(dx, dy, dz);
  if (!(distance > 1e-6) || !(scale > 0)
      || !Number.isFinite(zoom) || zoom < 0 || zoom > 1) return null;
  const values = [
    target?.x, target?.y, target?.z,
    canonicalTarget?.x, canonicalTarget?.y, canonicalTarget?.z,
  ].map(Number);
  if (!values.every(Number.isFinite)) return null;
  const result = {
    azimuth: Math.atan2(dx, dz) / DEG,
    elevation: Math.asin(Math.max(-1, Math.min(1, dy / distance))) / DEG,
    zoom,
    panEast: (values[0] - values[3]) / scale,
    panUp: (values[1] - values[4]) / scale,
    panSouth: (values[2] - values[5]) / scale,
  };
  if (result.elevation < MIN_SEMANTIC_VIEW_ELEVATION
      || result.elevation > MAX_SEMANTIC_VIEW_ELEVATION
      || [result.panEast, result.panUp, result.panSouth]
        .some((value) => !Number.isFinite(value) || Math.abs(value) > MAX_SEMANTIC_VIEW_PAN)) return null;
  return result;
}

export function restoreSemanticOrbit(view, {
  canonicalTarget,
  panScale,
  distance,
} = {}) {
  const azimuth = Number(view?.azimuth) * DEG;
  const elevation = Number(view?.elevation) * DEG;
  const zoom = Number(view?.zoom);
  const panEast = Number(view?.panEast ?? 0);
  const panUp = Number(view?.panUp ?? 0);
  const panSouth = Number(view?.panSouth ?? 0);
  const scale = Number(panScale);
  const radius = Number(distance);
  const base = [canonicalTarget?.x, canonicalTarget?.y, canonicalTarget?.z].map(Number);
  if (![azimuth, elevation, zoom, panEast, panUp, panSouth, scale, radius, ...base]
    .every(Number.isFinite)
    || elevation < MIN_SEMANTIC_VIEW_ELEVATION * DEG
    || elevation > MAX_SEMANTIC_VIEW_ELEVATION * DEG
    || zoom < 0 || zoom > 1 || !(scale > 0) || !(radius > 1e-6)) return null;
  const target = {
    x: base[0] + panEast * scale,
    y: base[1] + panUp * scale,
    z: base[2] + panSouth * scale,
  };
  const horizontal = Math.cos(elevation) * radius;
  return {
    target,
    position: {
      x: target.x + Math.sin(azimuth) * horizontal,
      y: target.y + Math.sin(elevation) * radius,
      z: target.z + Math.cos(azimuth) * horizontal,
    },
  };
}

export function semanticLogZoom(distanceRatio) {
  if (!(distanceRatio > 0) || !Number.isFinite(distanceRatio)) return null;
  const logRatio = Math.log(distanceRatio);
  if (logRatio < -LOG_ZOOM_RANGE || logRatio > LOG_ZOOM_RANGE) return null;
  return (logRatio + LOG_ZOOM_RANGE) / (LOG_ZOOM_RANGE * 2);
}

export function semanticLogZoomRatio(zoom) {
  if (!Number.isFinite(zoom) || zoom < 0 || zoom > 1) return null;
  return Math.exp(zoom * LOG_ZOOM_RANGE * 2 - LOG_ZOOM_RANGE);
}
