import * as G from '../core/math/geom2.js';
import { impostorHouseSpec } from './impostor-spec.js';
import {
  parcelSolarAccessPolygon,
  parcelWorldPoint,
} from './parcel-contract.js';
import { parcelRoofPolygons } from './house-footprint.js';

// A conservative low winter-sun design angle. This is a layout invariant rather
// than a real-time sun simulation: roofs that cannot shadow a 1.5m south window
// at this angle need not consume the whole vegetation/camera corridor.
export const BUILDING_SOLAR_ALTITUDE = 30 * Math.PI / 180;
export const BUILDING_SOLAR_TARGET_LIFT = 1.5;

function parcelGroundY(parcel, site) {
  if (Number.isFinite(parcel.baseY)) return parcel.baseY;
  if (Number.isFinite(parcel.padY)) return parcel.padY;
  return site.heightAt(parcel.center.x, parcel.center.z);
}

export function parcelObstructionPolygons(parcel) {
  if (parcel.kind === 'choga' || parcel.kind === 'giwa') return parcelRoofPolygons(parcel);
  return parcel.poly?.length ? [parcel.poly] : [];
}

export function parcelRoofTopY(parcel, site) {
  const baseY = parcelGroundY(parcel, site);
  if (parcel.kind !== 'choga' && parcel.kind !== 'giwa') return baseY + 14;
  const spec = impostorHouseSpec(parcel);
  const sy = Number.isFinite(parcel.sy) ? parcel.sy : 1;
  return baseY + Math.max(...spec.roofs.map((roof) => roof.ridgeY * sy));
}

export function parcelBuildingSolarAccessPolygon(target, blocker, site) {
  const corridor = target.solarAccess;
  if (!corridor) return parcelSolarAccessPolygon(target);
  const targetY = parcelGroundY(target, site) + BUILDING_SOLAR_TARGET_LIFT;
  const shadowLength = Math.max(
    0,
    (parcelRoofTopY(blocker, site) - targetY) / Math.tan(BUILDING_SOLAR_ALTITUDE),
  );
  const localEnd = Math.min(corridor.localEnd, corridor.localStart + shadowLength);
  return [
    parcelWorldPoint(target, { x: -corridor.halfWidth, z: corridor.localStart }),
    parcelWorldPoint(target, { x: corridor.halfWidth, z: corridor.localStart }),
    parcelWorldPoint(target, { x: corridor.halfWidth, z: localEnd }),
    parcelWorldPoint(target, { x: -corridor.halfWidth, z: localEnd }),
  ];
}

export function buildingBlocksSolarAccess(target, blocker, site) {
  const corridor = parcelBuildingSolarAccessPolygon(target, blocker, site);
  return parcelObstructionPolygons(blocker).some((roof) => G.polysOverlap(corridor, roof));
}
