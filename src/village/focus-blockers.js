import * as G from '../core/math/geom2.js';
import { parcelRotY } from '../generators/shared/parcel-spatial.js';
import { parcelEffectiveRoofBounds } from './house-footprint.js';
import { PAVILION_HEIGHT, PAVILION_ROOF_RADIUS } from './pavilion-plan.js';
import { publicPropObstruction } from './public-props-plan.js';
import { parcelGroundY, parcelRoofTopY } from './solar-access.js';

// Pure, renderer-independent focus blockers. Ray-picking keeps its generous parcel
// box, while visibility and camera collision use the actual fitted roof envelope.
// This keeps FULL/MID/FAR, focus, rerolls, and public-object planning on one shape.

function volumeBounds(volume) {
  const cos = Math.abs(Math.cos(volume.rotationY || 0));
  const sin = Math.abs(Math.sin(volume.rotationY || 0));
  const halfX = cos * volume.half.x + sin * volume.half.z;
  const halfZ = sin * volume.half.x + cos * volume.half.z;
  return {
    min: {
      x: volume.center.x - halfX,
      y: volume.center.y - volume.half.y,
      z: volume.center.z - halfZ,
    },
    max: {
      x: volume.center.x + halfX,
      y: volume.center.y + volume.half.y,
      z: volume.center.z + halfZ,
    },
  };
}

function blocker(id, center, half, rotationY = 0) {
  const volume = { center, half, rotationY };
  return { id, volume, bounds: volumeBounds(volume) };
}

export function parcelFocusBlocker(parcel, site) {
  if (!parcel || (parcel.kind !== 'choga' && parcel.kind !== 'giwa')) return null;
  const roof = parcelEffectiveRoofBounds(parcel);
  if (![roof.minX, roof.maxX, roof.minZ, roof.maxZ].every(Number.isFinite)) return null;
  const rotationY = parcelRotY(parcel);
  const localX = (roof.minX + roof.maxX) * 0.5;
  const localZ = (roof.minZ + roof.maxZ) * 0.5;
  const cos = Math.cos(rotationY), sin = Math.sin(rotationY);
  const baseY = parcelGroundY(parcel, site);
  const topY = parcelRoofTopY(parcel, site);
  return blocker(parcel.id, {
    x: parcel.center.x + localX * cos + localZ * sin,
    y: (baseY + topY) * 0.5,
    z: parcel.center.z - localX * sin + localZ * cos,
  }, {
    x: Math.max(0.05, (roof.maxX - roof.minX) * 0.5),
    y: Math.max(0.05, (topY - baseY) * 0.5),
    z: Math.max(0.05, (roof.maxZ - roof.minZ) * 0.5),
  }, rotationY);
}

function circularFeatureBlocker(id, feature, radius, height, site) {
  if (!Number.isFinite(feature?.x) || !Number.isFinite(feature?.z)
    || !Number.isFinite(radius) || radius <= 0 || !Number.isFinite(height) || height <= 0) return null;
  const baseY = Number.isFinite(feature.baseY)
    ? feature.baseY
    : site.heightAt(feature.x, feature.z);
  return blocker(id, {
    x: feature.x,
    y: baseY + height * 0.5,
    z: feature.z,
  }, { x: radius, y: height * 0.5, z: radius });
}

function landmarkBlocker(id, feature, width, depth, height, site) {
  if (!Number.isFinite(feature?.x) || !Number.isFinite(feature?.z)
    || !Number.isFinite(width) || width <= 0 || !Number.isFinite(depth) || depth <= 0) return null;
  const baseY = Number.isFinite(feature.baseY)
    ? feature.baseY
    : site.heightAt(feature.x, feature.z);
  return blocker(id, {
    x: feature.x,
    y: baseY + height * 0.5,
    z: feature.z,
  }, { x: width * 0.5, y: height * 0.5, z: depth * 0.5 }, G.facingY(feature.frontDir || { x: 0, z: 1 }));
}

export function focusFeatureBlockers(plan, site) {
  if (!plan?.features || !site?.heightAt) return [];
  const features = plan.features;
  const result = [];
  const pavilion = circularFeatureBlocker(
    'feature:pavilion',
    features.pavilion,
    features.pavilion?.radius || PAVILION_ROOF_RADIUS,
    PAVILION_HEIGHT,
    site,
  );
  if (pavilion) result.push(pavilion);

  for (let index = 0; index < (features.props || []).length; index++) {
    const prop = features.props[index];
    const obstruction = publicPropObstruction(prop);
    const entry = obstruction && circularFeatureBlocker(
      `feature:prop:${index}:${prop.name}`,
      prop,
      obstruction.radius,
      obstruction.height,
      site,
    );
    if (entry) result.push(entry);
  }

  const palace = landmarkBlocker(
    'feature:palace',
    features.palace,
    features.palace?.plotW || 60,
    features.palace?.plotD || 90,
    20,
    site,
  );
  if (palace) result.push(palace);
  const temple = landmarkBlocker(
    'feature:temple',
    features.temple,
    (features.temple?.compoundWidth || features.temple?.compoundSize || 33) + 2,
    (features.temple?.compoundDepth || features.temple?.compoundSize || 33) + 2,
    18,
    site,
  );
  if (temple) result.push(temple);
  return result;
}

export function focusVisibilityBlockers(plan, site) {
  return [
    ...(plan?.parcels || []).map((parcel) => parcelFocusBlocker(parcel, site)).filter(Boolean),
    ...focusFeatureBlockers(plan, site),
  ];
}
