import * as G from '../core/math/geom2.js';
import { planParcelFocus } from '../generators/shared/parcel-spatial.js';
import {
  canopyBlocksSolarAccess,
  circleIntersectsPolygon,
} from './parcel-contract.js';
import {
  cityWallContainsPolygon,
  worldEdgeClearance,
} from './citywall-contour.js';
import { createRoadSpatialIndex } from './road-spatial.js';
import { streamClearanceAt } from './stream-spatial.js';

const TAU = Math.PI * 2;
const SEARCH_STEP = 4;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

// buildPavilion defaults: radius 2.5 + eaveOverhang 1.55 + planCurve 0.42.
// Round upward so planning reserves the actual scalloped roof, not only its posts.
export const PAVILION_ROOF_RADIUS = 4.5;
export const PAVILION_PARCEL_CLEARANCE = 1;
export const PAVILION_ROAD_CLEARANCE = 0.6;
export const PAVILION_STREAM_CLEARANCE = 2;
export const PAVILION_VIEW_CLEARANCE = 0.8;
export const PAVILION_MAX_RELIEF = 1.4;
export const PAVILION_GUARDIAN_CLEARANCE = 1;

export function pavilionFootprint(pavilion, margin = 0, segments = 16) {
  if (!pavilion || !Number.isFinite(pavilion.x) || !Number.isFinite(pavilion.z)) return [];
  const radius = Math.max(0, pavilion.radius || PAVILION_ROOF_RADIUS) + Math.max(0, margin);
  const count = Math.max(8, Math.round(segments));
  return Array.from({ length: count }, (_, index) => {
    const angle = index / count * TAU;
    return {
      x: pavilion.x + Math.cos(angle) * radius,
      z: pavilion.z + Math.sin(angle) * radius,
    };
  });
}

function parcelFocusSegment(parcel) {
  const focus = planParcelFocus(parcel);
  return {
    target: { x: focus.worldX, z: focus.worldZ },
    camera: { x: focus.cameraX, z: focus.cameraZ },
  };
}

export function pavilionBlocksParcelFocus(parcel, pavilion, margin = PAVILION_VIEW_CLEARANCE) {
  if (!parcel || !pavilion) return false;
  const segment = parcelFocusSegment(parcel);
  const hit = G.distToSeg(pavilion, segment.target, segment.camera);
  const radius = (pavilion.radius || PAVILION_ROOF_RADIUS) + Math.max(0, margin);
  // End caps belong to the selected parcel/camera rather than the intervening view.
  return hit.t > 0.04 && hit.t < 0.96 && hit.d <= radius;
}

export function pavilionTerrainRelief(site, point) {
  let min = Infinity, max = -Infinity;
  for (let index = 0; index < 9; index++) {
    const radius = index === 0 ? 0 : PAVILION_ROOF_RADIUS * 0.72;
    const angle = (index - 1) / 8 * TAU;
    const height = site.heightAt(
      point.x + Math.cos(angle) * radius,
      point.z + Math.sin(angle) * radius,
    );
    min = Math.min(min, height);
    max = Math.max(max, height);
  }
  return max - min;
}

function candidatesAround(preferred, lateral, maxRadius) {
  const candidates = [{ ...preferred }];
  const phase = Math.atan2(lateral.z, lateral.x);
  const rings = Math.ceil(maxRadius / SEARCH_STEP);
  for (let ring = 1; ring <= rings; ring++) {
    const radius = ring * SEARCH_STEP;
    const steps = Math.max(8, Math.ceil(TAU * radius / SEARCH_STEP));
    const ringPhase = phase + ring * GOLDEN_ANGLE;
    for (let index = 0; index < steps; index++) {
      const angle = ringPhase + index / steps * TAU;
      candidates.push({
        x: preferred.x + Math.cos(angle) * radius,
        z: preferred.z + Math.sin(angle) * radius,
      });
    }
  }
  return candidates;
}

// A pavilion is a small building, not vegetation. It nevertheless consumes the same
// south-light corridor as tree canopies and the exact focus ray used by the camera.
// The nearest valid public clearing is selected after parcels are known, while the
// function remains pure/worker-safe and independent from THREE/rendering.
export function planPavilion({
  site,
  scale,
  roads = [],
  parcels = [],
  occupied = [],
  reservedCircles = [],
  cityWall = null,
  rotationJitter = 0,
}) {
  const center = site.center;
  const entrance = cityWall?.gates?.find((gate) => gate.name === 'south') || site.entrance;
  const axis = G.norm(G.sub(entrance, center));
  const lateral = G.perpL(axis);
  const entryPavilion = scale === 'hamlet' || scale === 'village';
  const preferred = entryPavilion
    ? G.add(entrance, G.add(G.mul(lateral, site.R * 0.10), G.mul(axis, site.R * 0.05)))
    : G.add(G.lerp(center, entrance, 0.30), G.mul(lateral, site.R * 0.06));
  const roadSpatial = createRoadSpatialIndex(roads);
  const maxRadius = Math.max(36, site.R * 0.68);

  const clearAt = (point) => {
    const footprint = pavilionFootprint({ ...point, radius: PAVILION_ROOF_RADIUS });
    if (site.edge && worldEdgeClearance(site.edge, point) < PAVILION_ROOF_RADIUS + 4) return false;
    if (cityWall && !cityWallContainsPolygon(cityWall, footprint, 3)) return false;
    if (streamClearanceAt(site, point) < PAVILION_ROOF_RADIUS + PAVILION_STREAM_CLEARANCE) return false;
    if (roadSpatial.intersectsRoadCorridor(footprint, PAVILION_ROAD_CLEARANCE)) return false;
    if (occupied.some((polygon) => circleIntersectsPolygon(
      point,
      PAVILION_ROOF_RADIUS + PAVILION_PARCEL_CLEARANCE,
      polygon,
    ))) return false;
    if (reservedCircles.some((circle) => G.dist(point, circle)
      < PAVILION_ROOF_RADIUS + circle.radius + PAVILION_GUARDIAN_CLEARANCE)) return false;
    for (const parcel of parcels) {
      if (canopyBlocksSolarAccess(parcel, point, PAVILION_ROOF_RADIUS)) return false;
      if (pavilionBlocksParcelFocus(parcel, point)) return false;
    }
    return pavilionTerrainRelief(site, point) <= PAVILION_MAX_RELIEF;
  };

  const point = candidatesAround(preferred, lateral, maxRadius).find(clearAt);
  if (!point) throw new Error(`pavilion-plan could not find a solar-safe clearing for ${scale}`);
  const road = roadSpatial.nearest(point, site.R * 2);
  const towardRoad = road.pt ? G.norm(G.sub(road.pt, point)) : axis;
  return {
    x: point.x,
    z: point.z,
    sides: 6,
    radius: PAVILION_ROOF_RADIUS,
    rot: G.facingY(towardRoad) + rotationJitter,
    placement: entryPavilion ? 'entrance' : 'civic',
    roadId: road.road?.id || null,
  };
}
