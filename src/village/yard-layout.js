// Pure, renderer-independent layout contract for the hard objects that share a
// parcel yard with fruit trees. `walls.js` consumes the placement helpers while
// `gardens.js` consumes the matching obstacle footprints. Keeping the arithmetic
// here prevents a visually harmless renderer refactor from silently moving a shed
// or jar platform through an already accepted tree.

import * as G from '../core/math/geom2.js';
import { parcelEffectiveRoofBounds } from './house-footprint.js';
import {
  localCanopyBlocksSolarAccess,
  parcelHouseTranslation,
} from './parcel-contract.js';
import { VILLAGE_SOLID_WALL_THICKNESS } from './wall-contract.js';
import { auxiliaryHardObstacle } from './auxiliary-building-plan.js';

export const YARD_HARD_GAP = 0.12;
export const YARD_LIFE_MAX_HEIGHT = 1.2;

const JAR_OVERHANG = 0.12;
const GARDEN_STONE_MARGIN = 0.08;
const YARD_LIFE_WALL_GAP = 0.18;
const HEDGE_MAX_BLOB_RADIUS = 0.70;
const HEDGE_MAX_NORMAL_JITTER = 0.04;
// `walls.js#makeHedgeRun` places at most 0.70m-radius blobs with ±0.04m
// normal jitter. Yard-life footprints therefore reserve that whole inward
// vegetation band plus the shared hard-object breathing room.
export const YARD_HEDGE_INWARD_CLEARANCE =
  HEDGE_MAX_BLOB_RADIUS + HEDGE_MAX_NORMAL_JITTER + YARD_HARD_GAP;
const YARD_LIFE_ROOF_GAP = 0.22;
const YARD_LIFE_GATE_GAP = 0.82;

export function yardLifeWallInwardClearance(style = 'stone') {
  if (style === 'hedge') return YARD_HEDGE_INWARD_CLEARANCE;
  const solidThickness = VILLAGE_SOLID_WALL_THICKNESS[style] || 0;
  return Math.max(YARD_LIFE_WALL_GAP, solidThickness * 0.5 + YARD_HARD_GAP);
}

function rectangle(kind, mode, x, z, halfWidth, halfDepth) {
  return { kind, mode, shape: 'rect', x, z, halfWidth, halfDepth };
}

function circle(kind, mode, x, z, radius) {
  return { kind, mode, shape: 'circle', x, z, radius };
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

  const auxiliary = auxiliaryHardObstacle(parcel.auxiliary);
  if (auxiliary) out.push(auxiliary);

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

export function yardCircleIntersectsHardObstacle(point, radius, obstacles, gap = YARD_HARD_GAP) {
  const safeRadius = Math.max(0, Number.isFinite(radius) ? radius : 0);
  const safeGap = Math.max(0, Number.isFinite(gap) ? gap : 0);
  for (const obstacle of obstacles || []) {
    if (obstacle.shape === 'polygon') {
      const points = obstacle.points || [];
      if (points.length >= 3 && (
        G.pointInPoly(point, points)
        || points.some((edge, index) =>
          G.distToSeg(point, edge, points[(index + 1) % points.length]).d <= safeRadius + safeGap)
      )) return true;
      continue;
    }
    if (obstacle.shape === 'circle') {
      if (Math.hypot(point.x - obstacle.x, point.z - obstacle.z)
        <= safeRadius + safeGap + obstacle.radius) return true;
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
    if (Math.hypot(dx, dz) <= safeRadius + safeGap) return true;
  }
  return false;
}

function circleIntersectsRectangle(point, radius, rectangle) {
  const dx = point.x < rectangle.minX
    ? rectangle.minX - point.x
    : point.x > rectangle.maxX ? point.x - rectangle.maxX : 0;
  const dz = point.z < rectangle.minZ
    ? rectangle.minZ - point.z
    : point.z > rectangle.maxZ ? point.z - rectangle.maxZ : 0;
  return Math.hypot(dx, dz) <= radius;
}

function normalizedLifeRect(footprint) {
  if (footprint?.shape !== 'rect'
    || !Number.isFinite(footprint.halfX)
    || !Number.isFinite(footprint.halfZ)) return null;
  const yaw = Number.isFinite(footprint.yaw) ? footprint.yaw : 0;
  const halfX = Math.max(0.05, footprint.halfX);
  const halfZ = Math.max(0.05, footprint.halfZ);
  const c = Math.abs(Math.cos(yaw)), s = Math.abs(Math.sin(yaw));
  return {
    shape: 'rect',
    halfX,
    halfZ,
    yaw,
    envelopeX: halfX * c + halfZ * s,
    envelopeZ: halfX * s + halfZ * c,
  };
}

function lifeRectPolygon(point, footprint) {
  const c = Math.cos(footprint.yaw), s = Math.sin(footprint.yaw);
  return [
    { x: footprint.halfX, z: footprint.halfZ },
    { x: -footprint.halfX, z: footprint.halfZ },
    { x: -footprint.halfX, z: -footprint.halfZ },
    { x: footprint.halfX, z: -footprint.halfZ },
  ].map((corner) => ({
    x: point.x + corner.x * c + corner.z * s,
    z: point.z - corner.x * s + corner.z * c,
  }));
}

function polygonDistance(left, right) {
  if (left.some((point) => G.pointInPoly(point, right))
    || right.some((point) => G.pointInPoly(point, left))) return 0;
  let distance = Infinity;
  for (let i = 0; i < left.length; i++) {
    distance = Math.min(
      distance,
      G.segmentPolygonDistance(left[i], left[(i + 1) % left.length], right),
    );
  }
  return distance;
}

function pointToLifeRectDistance(point, center, footprint) {
  const c = Math.cos(footprint.yaw), s = Math.sin(footprint.yaw);
  const dx = point.x - center.x, dz = point.z - center.z;
  const localX = dx * c - dz * s;
  const localZ = dx * s + dz * c;
  const outsideX = Math.max(0, Math.abs(localX) - footprint.halfX);
  const outsideZ = Math.max(0, Math.abs(localZ) - footprint.halfZ);
  return Math.hypot(outsideX, outsideZ);
}

function lifeRectIntersectsHardObstacle(point, footprint, obstacles) {
  const polygon = lifeRectPolygon(point, footprint);
  for (const obstacle of obstacles || []) {
    if (obstacle.shape === 'circle') {
      if (pointToLifeRectDistance(
        { x: obstacle.x, z: obstacle.z },
        point,
        footprint,
      ) <= obstacle.radius + YARD_HARD_GAP) return true;
      continue;
    }
    const obstaclePolygon = obstacle.shape === 'polygon'
      ? obstacle.points
      : [
          { x: obstacle.x - obstacle.halfWidth, z: obstacle.z - obstacle.halfDepth },
          { x: obstacle.x + obstacle.halfWidth, z: obstacle.z - obstacle.halfDepth },
          { x: obstacle.x + obstacle.halfWidth, z: obstacle.z + obstacle.halfDepth },
          { x: obstacle.x - obstacle.halfWidth, z: obstacle.z + obstacle.halfDepth },
        ];
    if (!obstaclePolygon?.length) continue;
    if (polygonDistance(polygon, obstaclePolygon) <= YARD_HARD_GAP) return true;
  }
  return false;
}

function circleFitsParcel(
  point,
  radius,
  points,
  edgeClearance = YARD_LIFE_WALL_GAP,
  allowExactClearance = false,
) {
  if (!points?.length || !G.pointInPoly(point, points)) return false;
  const clearance = radius + edgeClearance;
  for (let i = 0; i < points.length; i++) {
    const distance = G.distToSeg(point, points[i], points[(i + 1) % points.length]).d;
    if (allowExactClearance ? distance < clearance : distance <= clearance) {
      return false;
    }
  }
  return true;
}

function lifeRectFitsParcel(
  point,
  footprint,
  points,
  edgeClearance = YARD_LIFE_WALL_GAP,
  allowExactClearance = false,
) {
  if (!points?.length) return false;
  return lifeRectPolygon(point, footprint).every((corner) => G.pointInPoly(corner, points)
    && points.every((edge, index) =>
      allowExactClearance
        ? G.distToSeg(corner, edge, points[(index + 1) % points.length]).d >= edgeClearance
        : G.distToSeg(corner, edge, points[(index + 1) % points.length]).d > edgeClearance));
}

function lifeRectIntersectsRoof(point, footprint, roof) {
  const roofPolygon = [
    { x: roof.minX, z: roof.minZ },
    { x: roof.maxX, z: roof.minZ },
    { x: roof.maxX, z: roof.maxZ },
    { x: roof.minX, z: roof.maxZ },
  ];
  return polygonDistance(lifeRectPolygon(point, footprint), roofPolygon) <= YARD_LIFE_ROOF_GAP;
}

function lifeRectBlocksSolarAccess(parcel, point, footprint) {
  const corridor = parcel.solarAccess;
  if (!corridor) return localCanopyBlocksSolarAccess(
    parcel,
    point,
    Math.hypot(footprint.halfX, footprint.halfZ),
  );
  const corridorPolygon = [
    { x: -corridor.halfWidth, z: corridor.localStart },
    { x: corridor.halfWidth, z: corridor.localStart },
    { x: corridor.halfWidth, z: corridor.localEnd },
    { x: -corridor.halfWidth, z: corridor.localEnd },
  ];
  return polygonDistance(lifeRectPolygon(point, footprint), corridorPolygon) <= 1e-9;
}

function gateApproach(parcel, roof) {
  const house = parcelHouseTranslation(parcel);
  const start = { x: house.x, z: roof.maxZ + 0.15 };
  const gate = parcel.access?.gateLocalPoint;
  if (Number.isFinite(gate?.x) && Number.isFinite(gate?.z)) return { start, gate };
  const front = parcel.shape?.pts?.reduce(
    (best, point) => !best || point.z > best.z ? point : best,
    null,
  );
  return { start, gate: front ? { x: 0, z: front.z } : { x: 0, z: parcel.plotD * 0.5 } };
}

function lifeSlotTemplates(parcel, envelopeX, envelopeZ, slotClass, roof) {
  const halfW = parcel.plotW * 0.5;
  const halfD = parcel.plotD * 0.5;
  const edgeInset = yardLifeWallInwardClearance(parcel.wallType);
  const sideX = Math.max(0, halfW - envelopeX - edgeInset);
  const solarHalfWidth = Number.isFinite(parcel.solarAccess?.halfWidth)
    ? parcel.solarAccess.halfWidth : 0;
  const innerX = Math.min(
    sideX,
    Math.max(envelopeX + YARD_HARD_GAP, solarHalfWidth + envelopeX + YARD_HARD_GAP),
  );
  const roofClearZ = roof.maxZ + envelopeZ + YARD_LIFE_ROOF_GAP;
  const serviceZ = Math.min(
    halfD - envelopeZ - edgeInset,
    Math.max(-parcel.plotD * 0.02, roof.maxZ + envelopeZ + YARD_LIFE_ROOF_GAP),
  );
  const frontZ = Math.min(
    halfD - envelopeZ - edgeInset,
    Math.max(parcel.plotD * 0.24, roofClearZ),
  );
  const middleZ = Math.min(halfD - envelopeZ - edgeInset, parcel.plotD * 0.11);
  if (slotClass === 'open-work-yard') {
    return [
      { id: 'work-right-front', x: sideX, z: frontZ },
      { id: 'work-left-front', x: -sideX, z: frontZ },
      { id: 'work-right-inner-front', x: innerX, z: frontZ },
      { id: 'work-left-inner-front', x: -innerX, z: frontZ },
      { id: 'work-right-middle', x: sideX, z: middleZ },
      { id: 'work-left-middle', x: -sideX, z: middleZ },
      { id: 'work-right-inner-middle', x: innerX, z: middleZ },
      { id: 'work-left-inner-middle', x: -innerX, z: middleZ },
    ];
  }
  return [
    { id: 'service-right-near', x: sideX, z: serviceZ },
    { id: 'service-left-near', x: -sideX, z: serviceZ },
    { id: 'service-right-front', x: sideX, z: frontZ },
    { id: 'service-left-front', x: -sideX, z: frontZ },
  ];
}

// 계절 생활상은 필지 RNG와 독립된 후보 슬롯만 요청한다. 이 함수는 후보 순서를
// 고정하고 실제 지붕·대문 접근·일조·담·기존 hard object를 모두 통과한 자리만 돌려준다.
// 호출자는 parcel 전용 hash RNG로 하나를 고르며, 선택된 모든 계절 record를 flora obstacle로
// 바꿔 아직 심지 않은 마당나무의 trunk를 예약한다.
export function yardLifePotentialSlots(
  parcel,
  { footprint, radius = 0.6, height = 1, slotClass = 'service-edge', obstacles } = {},
) {
  const safeRect = normalizedLifeRect(footprint);
  const safeRadius = Math.max(0.05, Number.isFinite(radius) ? radius : 0.6);
  const safeHeight = Number.isFinite(height) ? height : Infinity;
  if (!parcel || parcel.hero || !['giwa', 'choga'].includes(parcel.kind)
    || !Number.isFinite(parcel.plotW) || !Number.isFinite(parcel.plotD)
    || safeHeight <= 0 || safeHeight > YARD_LIFE_MAX_HEIGHT) return [];

  const roof = parcelEffectiveRoofBounds(parcel);
  if (![roof.minX, roof.maxX, roof.minZ, roof.maxZ].every(Number.isFinite)) return [];
  const hard = obstacles || yardHardObstacles(parcel);
  const approach = gateApproach(parcel, roof);
  const envelopeX = safeRect?.envelopeX ?? safeRadius;
  const envelopeZ = safeRect?.envelopeZ ?? safeRadius;
  const edgeClearance = yardLifeWallInwardClearance(parcel.wallType);
  return lifeSlotTemplates(parcel, envelopeX, envelopeZ, slotClass, roof).filter((slot) => {
    const point = { x: slot.x, z: slot.z };
    if (safeRect) {
      if (!lifeRectFitsParcel(
        point,
        safeRect,
        parcel.shape?.pts,
        edgeClearance,
        true,
      )) return false;
      if (lifeRectIntersectsRoof(point, safeRect, roof)) return false;
      if (lifeRectIntersectsHardObstacle(point, safeRect, hard)) return false;
      if (lifeRectBlocksSolarAccess(parcel, point, safeRect)) return false;
      if (G.segmentPolygonDistance(
        approach.start,
        approach.gate,
        lifeRectPolygon(point, safeRect),
      ) <= YARD_LIFE_GATE_GAP) return false;
      return true;
    }
    if (!circleFitsParcel(
      point,
      safeRadius,
      parcel.shape?.pts,
      edgeClearance,
      true,
    )) return false;
    if (circleIntersectsRectangle(point, safeRadius + YARD_LIFE_ROOF_GAP, roof)) return false;
    if (yardCircleIntersectsHardObstacle(point, safeRadius, hard)) return false;
    if (localCanopyBlocksSolarAccess(parcel, point, safeRadius)) return false;
    if (G.distToSeg(point, approach.start, approach.gate).d <= safeRadius + YARD_LIFE_GATE_GAP) {
      return false;
    }
    return true;
  }).map((slot) => ({
    id: slot.id,
    class: slotClass,
    x: slot.x,
    z: slot.z,
    ...(safeRect ? { footprint: { ...safeRect } } : {}),
    radius: safeRadius,
    height: safeHeight,
  }));
}

export function yardTreeIntersectsHardObstacle(point, footprint, obstacles) {
  for (const obstacle of obstacles || []) {
    const rawRadius = obstacle.mode === 'canopy'
      ? footprint?.canopyRadius : footprint?.trunkRadius;
    const radius = Math.max(0, Number.isFinite(rawRadius) ? rawRadius : 0) + YARD_HARD_GAP;
    if (yardCircleIntersectsHardObstacle(point, radius, [obstacle], 0)) return true;
  }
  return false;
}
