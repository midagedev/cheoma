// 남향·도로 접근·지붕·일조/수관 계약의 빠른 순수 회귀 게이트.
// THREE·브라우저 없이 plan과 worker가 소비하는 동일 공간 함수를 검사한다.
import * as G from '../src/core/math/geom2.js';
import { planVillage } from '../src/api/village-plan.js';
import {
  CITY_WALL_DIMENSIONS,
  cityWallContainsPolygon,
  cityWallVegetationBlocked,
  worldEdgeClearance,
} from '../src/village/citywall-contour.js';
import {
  canopyBlocksSolarAccess,
  circleIntersectsPolygon,
  parcelHouseTranslation,
  parcelSolarAccessPolygon,
  parcelWorldPoint,
  parcelWorldPolygon,
  preferredParcelHouseTranslation,
} from '../src/village/parcel-contract.js';
import {
  HOUSE_ROOF_CLEARANCE,
  assignFittedVariationSequence,
  parcelRoofPolygons,
} from '../src/village/house-footprint.js';
import { GUARDIAN_BASE_CLEARANCE } from '../src/village/guardian-plan.js';
import { createRoadSpatialIndex } from '../src/village/road-spatial.js';
import {
  PAVILION_PARCEL_CLEARANCE,
  PAVILION_GUARDIAN_CLEARANCE,
  PAVILION_MAX_RELIEF,
  PAVILION_ROAD_CLEARANCE,
  PAVILION_ROOF_RADIUS,
  PAVILION_STREAM_CLEARANCE,
  pavilionBlocksParcelFocus,
  pavilionBlocksParcelSolarAccess,
  pavilionFootprint,
  pavilionTerrainRelief,
} from '../src/village/pavilion-plan.js';
import { publicPropObstruction } from '../src/village/public-props-plan.js';
import { makeVegetationMask } from '../src/village/vegetation-spatial.js';
import {
  buildingBlocksSolarAccess,
  circleBlocksSolarAccess,
} from '../src/village/solar-access.js';
import { templeFootprint } from '../src/village/temple-plan.js';
import {
  STREAM_GUARDIAN_BASE_CLEARANCE,
  STREAM_PADDY_BANK_CLEARANCE,
  STREAM_PARCEL_BANK_CLEARANCE,
  createStreamSpatialIndex,
  streamClearanceAt,
} from '../src/village/stream-spatial.js';
import {
  circleBlocksParcelFocusFrame,
  parcelFocusViewEnvelope,
} from '../src/village/view-clearance.js';

const SCALES = ['hamlet', 'village', 'town', 'capital', 'hanyang'];
const SEEDS = [7, 42, 20260716];
const MAX_FACING = 65 * Math.PI / 180;
// 개별 seed는 수변·성곽 형상에 따라 흔들리되 aggregate는 이전 전체 밀도(990)를 지킨다.
const DENSITY_FLOOR = { hamlet: 10, village: 28, town: 60, capital: 42, hanyang: 305 };
const DENSITY_TOTAL_FLOOR = { hamlet: 32, village: 90, town: 180, capital: 140, hanyang: 990 };
const PADDY_TOTAL_FLOOR = { hamlet: 5, village: 3, town: 2, capital: 5, hanyang: 6 };
const EXPECTED_GUARDIAN_ROLES = {
  hamlet: ['entrance'],
  village: ['entrance'],
  town: ['entrance', 'central'],
  capital: ['entrance', 'central', 'stream'],
  hanyang: ['entrance', 'central', 'stream'],
};
// 기존 7/42/default 표본은 출력 안정성을 지키고, 한때 조밀한 필지 바로 너머에서 탐색이
// 끝나 필수 중앙 보호수가 사라졌던 경계 seed를 별도 회귀 표본으로 둔다.
const ADVERSARIAL_GUARDIAN_SEEDS = {
  town: [13],
  hanyang: [1, 5, 8, 10, 12, 13],
};

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function buildWithoutGlobalRandom(options) {
  const original = Math.random;
  Math.random = () => { throw new Error('layout consumed global Math.random'); };
  try { return planVillage(options); }
  finally { Math.random = original; }
}

function pointError(a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function pointPolygonClearance(point, polygon) {
  let distance = Infinity;
  for (let i = 0; i < polygon.length; i++) {
    distance = Math.min(distance, G.distToSeg(point, polygon[i], polygon[(i + 1) % polygon.length]).d);
  }
  return distance;
}

function assertGuardianContract(plan, label, scale, {
  mask = makeVegetationMask(plan, plan.site),
  roadSpatial = createRoadSpatialIndex(plan.roads),
} = {}) {
  const planned = plan.features.guardianTrees;
  invariant(Array.isArray(planned), `${label} has no guardian reservation list`);
  const expectedRoles = EXPECTED_GUARDIAN_ROLES[scale];
  invariant(JSON.stringify(planned.map((guardian) => guardian.role)) === JSON.stringify(expectedRoles),
    `${label} guardian roles ${planned.map((guardian) => guardian.role).join(',')} != ${expectedRoles.join(',')}`);

  const spatialParcels = [
    ...plan.parcels,
    ...(plan.features.palace?.poly ? [plan.features.palace] : []),
  ];
  const cityWall = plan.features.cityWall || null;
  const pavilionPoly = pavilionFootprint(plan.features.pavilion, PAVILION_GUARDIAN_CLEARANCE);
  for (let i = 0; i < planned.length; i++) {
    const guardian = planned[i];
    invariant(mask(guardian.x, guardian.z, 0.1), `${label} guardian ${guardian.role} is not masked`);
    invariant(!roadSpatial.withinRoadClearance(guardian, null, GUARDIAN_BASE_CLEARANCE),
      `${label} guardian ${guardian.role} base overlaps a road`);
    invariant(streamClearanceAt(plan.site, guardian) >= STREAM_GUARDIAN_BASE_CLEARANCE,
      `${label} guardian ${guardian.role} base overlaps the stream`);
    if (plan.site.edge) {
      invariant(worldEdgeClearance(plan.site.edge, guardian) >= guardian.radius,
        `${label} guardian ${guardian.role} canopy left the world edge`);
    }
    invariant(!cityWallVegetationBlocked(cityWall, guardian, {
      corridor: guardian.radius + CITY_WALL_DIMENSIONS.vegetationClearance,
      gateMargin: guardian.radius + CITY_WALL_DIMENSIONS.gateVegetationMargin,
      gateApproachMargin: guardian.radius,
    }), `${label} guardian ${guardian.role} canopy overlaps the city wall or gate approach`);
    for (const parcel of spatialParcels) {
      invariant(!circleIntersectsPolygon(guardian, guardian.radius + 1.5, parcel.poly),
        `${label} guardian ${guardian.role} canopy overlaps ${parcel.id || 'palace'}`);
      invariant(!canopyBlocksSolarAccess(parcel, guardian, guardian.radius),
        `${label} guardian ${guardian.role} blocks ${parcel.id || 'palace'} solar access`);
    }
    for (const [fieldIndex, field] of (plan.paddies || []).entries()) {
      invariant(!circleIntersectsPolygon(guardian, guardian.radius, field.poly),
        `${label} guardian ${guardian.role} overlaps paddy ${fieldIndex}`);
    }
    invariant(!circleIntersectsPolygon(guardian, guardian.radius, pavilionPoly),
      `${label} guardian ${guardian.role} overlaps the pavilion`);
    for (let j = 0; j < i; j++) {
      const other = planned[j];
      invariant(G.dist(guardian, other) >= guardian.radius + other.radius + 2,
        `${label} guardian canopies overlap`);
    }
  }
  return planned.length;
}

let parcels = 0, accesses = 0, guardians = 0, pavilions = 0, solarBuildings = 0, solarProbes = 0, south45 = 0;
let roofPolygons = 0, maxFacing = 0, maxAccess = 0, indexedCells = 0;
let minHouseFit = 1, minHouseScale = 1, minRoofClearance = Infinity;
let rerollChecks = 0;
let paddyFields = 0;
let publicProps = 0;

for (const scale of SCALES) {
  let scaleHouseCount = 0;
  let scalePaddyCount = 0;
  for (const seed of SEEDS) {
    const label = `${scale}:${seed}`;
    const options = { scale, seed, includePalace: scale === 'capital' || scale === 'hanyang' };
    const plan = buildWithoutGlobalRandom(options);
    const repeat = buildWithoutGlobalRandom(options);
    invariant(JSON.stringify(plan.roads) === JSON.stringify(repeat.roads), `${label} roads drift`);
    invariant(JSON.stringify(plan.parcels) === JSON.stringify(repeat.parcels), `${label} parcels drift`);
    invariant(JSON.stringify(plan.features.pavilion) === JSON.stringify(repeat.features.pavilion),
      `${label} pavilion plan drift`);
    invariant(JSON.stringify(plan.features.props) === JSON.stringify(repeat.features.props),
      `${label} public prop plan drift`);
    invariant(JSON.stringify(plan.features.guardianTrees) === JSON.stringify(repeat.features.guardianTrees),
      `${label} guardian plan drift`);
    invariant(plan.parcels.length >= DENSITY_FLOOR[scale],
      `${label} density ${plan.parcels.length} < ${DENSITY_FLOOR[scale]}`);
    scaleHouseCount += plan.parcels.length;
    scalePaddyCount += plan.paddies?.length || 0;
    paddyFields += plan.paddies?.length || 0;
    if (scale === 'hamlet') {
      invariant((plan.paddies?.length || 0) >= 1, `${label} lost its stream-bank paddies`);
    }

    for (const feature of [plan.features.palace, plan.features.govCore].filter(Boolean)) {
      invariant(feature.frontDir?.z > 0.999, `${label} core feature is not south-facing`);
    }

    const roadById = new Map(plan.roads.map((road) => [road.id, road]));
    const roadSpatial = createRoadSpatialIndex(plan.roads);
    const streamSpatial = createStreamSpatialIndex(plan.site);
    const roofsByParcel = plan.parcels.map(parcelRoofPolygons);
    const spatialParcels = [
      ...plan.parcels,
      ...(plan.features.palace?.poly ? [plan.features.palace] : []),
    ];
    const solarProbeTarget = spatialParcels.find((parcel) => parcel.kind === 'giwa' || parcel.kind === 'choga');
    if (solarProbeTarget) {
      const makeProbe = (z) => ({
        ...solarProbeTarget,
        center: parcelWorldPoint(solarProbeTarget, { x: 0, z }),
      });
      const southBlocker = makeProbe(solarProbeTarget.solarAccess.localStart + 4);
      const northNonBlocker = makeProbe(solarProbeTarget.solarAccess.localStart - 40);
      invariant(buildingBlocksSolarAccess(solarProbeTarget, southBlocker, plan.site),
        `${label} winter-sun probe missed a south-side roof`);
      invariant(!buildingBlocksSolarAccess(solarProbeTarget, northNonBlocker, plan.site),
        `${label} winter-sun probe rejected a north-side roof`);
      solarProbes += 2;
    }
    const pavilion = plan.features.pavilion;
    const pavilionPoly = pavilionFootprint(pavilion);
    invariant(pavilion && pavilionPoly.length >= 8, `${label} missing planned pavilion footprint`);
    invariant(!roadSpatial.intersectsRoadCorridor(pavilionPoly, PAVILION_ROAD_CLEARANCE),
      `${label} pavilion overlaps a road corridor`);
    invariant(pavilionTerrainRelief(plan.site, pavilion) <= PAVILION_MAX_RELIEF,
      `${label} pavilion exceeds terrain relief limit`);
    invariant(streamClearanceAt(plan.site, pavilion)
      >= PAVILION_ROOF_RADIUS + PAVILION_STREAM_CLEARANCE,
    `${label} pavilion overlaps the stream bank`);
    if (plan.site.edge) {
      invariant(worldEdgeClearance(plan.site.edge, pavilion) >= PAVILION_ROOF_RADIUS + 4,
        `${label} pavilion left the world edge`);
    }
    if (plan.features.cityWall) {
      invariant(cityWallContainsPolygon(plan.features.cityWall, pavilionPoly, 3),
        `${label} pavilion left the city wall`);
    }
    for (const parcel of spatialParcels) {
      invariant(!circleIntersectsPolygon(
        pavilion,
        PAVILION_ROOF_RADIUS + PAVILION_PARCEL_CLEARANCE,
        parcel.poly,
      ), `${label} pavilion overlaps ${parcel.id || 'palace'}`);
      invariant(!pavilionBlocksParcelSolarAccess(parcel, pavilion, plan.site),
        `${label} pavilion blocks ${parcel.id || 'palace'} solar access`);
      invariant(!pavilionBlocksParcelFocus(parcel, pavilion),
        `${label} pavilion blocks ${parcel.id || 'palace'} focus frame`);
    }
    for (const [fieldIndex, field] of (plan.paddies || []).entries()) {
      invariant(!G.polysOverlap(pavilionPoly, field.poly),
        `${label} pavilion overlaps paddy ${fieldIndex}`);
    }
    pavilions++;
    for (let propIndex = 0; propIndex < (plan.features.props || []).length; propIndex++) {
      const prop = plan.features.props[propIndex];
      const obstruction = publicPropObstruction(prop);
      invariant(obstruction, `${label} public prop ${prop.name} has no obstruction contract`);
      invariant(!roadSpatial.withinRoadClearance(prop, null, obstruction.radius + 0.35),
        `${label} public prop ${prop.name} overlaps a road`);
      invariant(streamClearanceAt(plan.site, prop) >= obstruction.radius + 0.8,
        `${label} public prop ${prop.name} overlaps the stream bank`);
      if (plan.site.edge) {
        invariant(worldEdgeClearance(plan.site.edge, prop) >= obstruction.radius + 2,
          `${label} public prop ${prop.name} left the world edge`);
      }
      for (const parcel of spatialParcels) {
        invariant(!circleIntersectsPolygon(prop, obstruction.radius + 0.35, parcel.poly),
          `${label} public prop ${prop.name} overlaps ${parcel.id || 'palace'}`);
        invariant(!circleBlocksSolarAccess(parcel, obstruction, plan.site),
          `${label} public prop ${prop.name} blocks ${parcel.id || 'palace'} solar access`);
        if (obstruction.viewRadius > 0) {
          invariant(!circleBlocksParcelFocusFrame(parcel, prop, obstruction.viewRadius, 0.3),
            `${label} public prop ${prop.name} blocks ${parcel.id || 'palace'} focus frame`);
        }
      }
      for (let otherIndex = 0; otherIndex < propIndex; otherIndex++) {
        const other = plan.features.props[otherIndex];
        const otherObstruction = publicPropObstruction(other);
        invariant(G.dist(prop, other)
          >= obstruction.radius + otherObstruction.radius + 0.5,
        `${label} public props ${prop.name}/${other.name} overlap`);
      }
      publicProps++;
    }
    const tallPublicObstacles = [
      ...(plan.features.temple ? [templeFootprint(plan.features.temple, 2)] : []),
      ...(plan.features.sijeon || []).map((shop) => shop.poly),
    ];
    for (let targetIndex = 0; targetIndex < plan.parcels.length; targetIndex++) {
      const target = plan.parcels[targetIndex];
      for (const obstacle of tallPublicObstacles) {
        invariant(!G.polysOverlap(parcelSolarAccessPolygon(target), obstacle),
          `${label} a tall public structure blocks ${target.id || 'palace'} solar access`);
      }
      for (let blockerIndex = 0; blockerIndex < spatialParcels.length; blockerIndex++) {
        const blocker = spatialParcels[blockerIndex];
        if (target === blocker) continue;
        invariant(!buildingBlocksSolarAccess(target, blocker, plan.site),
          `${label} ${blocker.id || 'palace'} blocks ${target.id || 'palace'} winter solar access`);
      }
      solarBuildings++;
    }
    let seedSouth60 = 0;

    for (let parcelIndex = 0; parcelIndex < plan.parcels.length; parcelIndex++) {
      const parcel = plan.parcels[parcelIndex];
      const parcelLabel = `${label}:${parcel.id}`;
      const facing = Math.abs(Math.atan2(parcel.frontDir.x, parcel.frontDir.z));
      parcels++;
      maxFacing = Math.max(maxFacing, facing);
      invariant(facing <= MAX_FACING,
        `${parcelLabel} facing ${(facing * 180 / Math.PI).toFixed(2)}°`);
      if (facing <= Math.PI / 4) south45++;
      if (facing <= Math.PI / 3) seedSouth60++;
      if (parcel.placement === 'core') {
        invariant(parcel.frontDir.z > 0.999, `${parcelLabel} core parcel is not south-facing`);
      }
      invariant((parcel.yaw || 0) === 0, `${parcelLabel} has a second yaw`);
      invariant(!streamSpatial.intersectsPolygon(parcel.poly, STREAM_PARCEL_BANK_CLEARANCE),
        `${parcelLabel} parcel overlaps the stream bank`);

      invariant(Number.isFinite(parcel.houseFitFactor), `${parcelLabel} missing house fit`);
      invariant(parcel.hero || parcel.houseFitFactor >= 0.7 - 1e-7,
        `${parcelLabel} miniature house fit ${parcel.houseFitFactor}`);
      const effectiveScale = Math.min(parcel.sx, parcel.sy, parcel.sz);
      invariant(parcel.hero || effectiveScale >= 0.68 - 1e-7,
        `${parcelLabel} miniature effective scale ${effectiveScale}`);
      const preferredHouse = preferredParcelHouseTranslation(parcel);
      const actualHouse = parcelHouseTranslation(parcel);
      invariant(Math.abs(actualHouse.z - preferredHouse.z) <= 0.5 + 1e-7,
        `${parcelLabel} house left rear yard by ${actualHouse.z - preferredHouse.z}m`);
      minHouseFit = Math.min(minHouseFit, parcel.houseFitFactor);
      minHouseScale = Math.min(minHouseScale, effectiveScale);

      const expected = parcelWorldPolygon(parcel);
      invariant(expected.length === parcel.poly.length, `${parcelLabel} polygon length drift`);
      for (let i = 0; i < expected.length; i++) {
        invariant(pointError(expected[i], parcel.poly[i]) <= 1e-9,
          `${parcelLabel} canonical polygon drift at ${i}`);
      }

      const corridor = parcel.solarAccess;
      invariant(corridor && corridor.localStart < corridor.localEnd && corridor.halfWidth > 0,
        `${parcelLabel} missing solar corridor`);

      if (parcel.placement === 'frontage' || parcel.placement === 'infill') {
        invariant(parcel.access, `${parcelLabel} missing road ownership`);
      }
      if (parcel.placement !== 'core') {
        invariant(!roadSpatial.intersectsRoadCorridor(parcel.poly, 0.2),
          `${parcelLabel} overlaps a road ribbon`);
      }
      if (parcel.access) {
        accesses++;
        const road = roadById.get(parcel.access.roadId);
        invariant(road, `${parcelLabel} references ${parcel.access.roadId}`);
        invariant(Number.isInteger(parcel.access.gateEdge)
          && parcel.access.gateEdge >= 0 && parcel.access.gateEdge < parcel.poly.length,
        `${parcelLabel} has an invalid road-side gate edge`);
        invariant(parcel.access.gateT >= 0 && parcel.access.gateT <= 1,
          `${parcelLabel} has an invalid gate parameter`);
        const gateEdge = parcel.access.gateEdge;
        const expectedGate = G.lerp(
          parcel.poly[gateEdge],
          parcel.poly[(gateEdge + 1) % parcel.poly.length],
          parcel.access.gateT,
        );
        const expectedLocalGate = G.lerp(
          parcel.shape.pts[gateEdge],
          parcel.shape.pts[(gateEdge + 1) % parcel.shape.pts.length],
          parcel.access.gateT,
        );
        invariant(pointError(expectedGate, parcel.access.gatePoint) <= 1e-9,
          `${parcelLabel} gate point drifted from its edge`);
        invariant(pointError(expectedLocalGate, parcel.access.gateLocalPoint) <= 1e-9,
          `${parcelLabel} local gate point drifted from its edge`);
        if (parcel.shape.edges) {
          invariant(parcel.shape.edges[gateEdge]?.gate === true
            && parcel.shape.edges[gateEdge].share === false,
          `${parcelLabel} road-side gate edge was shared or omitted`);
        }
        invariant(G.distToPolyline(parcel.access.roadPoint, road.pts).d <= 1e-8,
          `${parcelLabel} road point is off its road`);
        const distance = G.dist(parcel.access.gatePoint, parcel.access.roadPoint);
        invariant(Math.abs(distance - parcel.access.distance) <= 1e-9,
          `${parcelLabel} access distance drift`);
        maxAccess = Math.max(maxAccess, distance);
        const limit = scale === 'hanyang' ? 70 : 45;
        invariant(distance <= limit,
          `${parcelLabel} gate is ${distance.toFixed(2)}m from road`);
        const towardRoad = G.norm(G.sub(parcel.access.roadPoint, parcel.access.gatePoint));
        const outsideProbe = G.add(parcel.access.gatePoint, G.mul(towardRoad, 0.01));
        invariant(!G.pointInPoly(outsideProbe, parcel.poly),
          `${parcelLabel} gate does not open toward the road side`);
      }

      const roofs = roofsByParcel[parcelIndex];
      roofPolygons += roofs.length;
      for (const roof of roofs) {
        if (parcel.access) {
          invariant(G.segmentPolygonDistance(
            parcel.access.gatePoint,
            parcel.access.roadPoint,
            roof,
          ) > 1e-6, `${parcelLabel} gate approach crosses its own roof`);
        }
        invariant(!streamSpatial.intersectsPolygon(roof),
          `${parcelLabel} roof overlaps the stream`);
        invariant(!roadSpatial.intersectsRoadCorridor(roof, 0.2),
          `${parcelLabel} roof overlaps a road ribbon`);
        for (const point of roof) {
          invariant(G.pointInPoly(point, parcel.poly), `${parcelLabel} roof left its own parcel`);
          const clearance = pointPolygonClearance(point, parcel.poly);
          minRoofClearance = Math.min(minRoofClearance, clearance);
          invariant(clearance >= HOUSE_ROOF_CLEARANCE - 1e-6,
            `${parcelLabel} roof clearance ${clearance} < ${HOUSE_ROOF_CLEARANCE}`);
        }
      }
      for (const other of spatialParcels) {
        if (other === parcel) continue;
        invariant(!G.polysOverlap(parcel.poly, other.poly),
          `${parcelLabel} parcel overlaps ${other.id || 'palace'}`);
        for (const roof of roofs) {
          invariant(!G.polysOverlap(roof, other.poly),
            `${parcelLabel} roof overlaps foreign parcel ${other.id || 'palace'}`);
        }
      }
      for (let otherIndex = parcelIndex + 1; otherIndex < plan.parcels.length; otherIndex++) {
        for (const roof of roofs) for (const otherRoof of roofsByParcel[otherIndex]) {
          invariant(!G.polysOverlap(roof, otherRoof),
            `${parcelLabel} roof overlaps ${plan.parcels[otherIndex].id} roof`);
        }
      }
    }
    invariant(seedSouth60 / plan.parcels.length >= 0.7,
      `${label} south-facing cluster too weak (${(seedSouth60 / plan.parcels.length).toFixed(3)})`);

    // runtime의 '이 집만 다시 굴리기'가 호출하는 동일 순수 경로를 대표 필지에서 재현한다.
    const regular = plan.parcels.filter((parcel) => !parcel.hero);
    const rerollSamples = [regular[0], regular[Math.floor(regular.length / 2)], regular.at(-1)]
      .filter((parcel, index, list) => parcel && list.indexOf(parcel) === index);
    for (let sampleIndex = 0; sampleIndex < rerollSamples.length; sampleIndex++) {
      const rerolled = structuredClone(rerollSamples[sampleIndex]);
      const rerollSeed = (seed ^ 0x12345678 ^ (sampleIndex * 0x45d9f3b)) >>> 0;
      const fitted = assignFittedVariationSequence(rerolled, plan.opts.char01, plan.opts.tuning, {
        baseSeed: rerollSeed,
        attempts: 16,
      });
      invariant(fitted,
        `${label}:${rerolled.id} reroll cannot fit`);
      invariant(Math.min(rerolled.sx, rerolled.sy, rerolled.sz) >= 0.68 - 1e-7,
        `${label}:${rerolled.id} reroll became miniature`);
      for (const roof of parcelRoofPolygons(rerolled)) for (const point of roof) {
        invariant(G.pointInPoly(point, rerolled.poly)
          && pointPolygonClearance(point, rerolled.poly) >= HOUSE_ROOF_CLEARANCE - 1e-6,
        `${label}:${rerolled.id} reroll roof left parcel`);
      }
      rerollChecks++;
    }

    const mask = makeVegetationMask(plan, plan.site);
    indexedCells += mask.spatial.stats.cells;
    if (plan.site.stream) {
      invariant(mask(plan.site.stream.cross.x, plan.site.stream.cross.z, 0.5),
        `${label} stream is not protected from vegetation`);
    }
    for (let i = 0; i < (plan.paddies || []).length; i++) {
      for (let j = i + 1; j < plan.paddies.length; j++) {
        invariant(!G.polysOverlap(plan.paddies[i].poly, plan.paddies[j].poly),
          `${label}:paddy ${i} overlaps paddy ${j}`);
      }
    }
    for (const parcel of spatialParcels) {
      const sample = parcelWorldPoint(parcel, {
        x: 0,
        z: parcel.solarAccess.localEnd - 0.5,
      });
      invariant(mask(sample.x, sample.z, 0.5), `${label}:${parcel.id || 'palace'} solar corridor is unprotected`);
      for (const [fieldIndex, field] of (plan.paddies || []).entries()) {
        invariant(!streamSpatial.intersectsPolygon(field.poly, STREAM_PADDY_BANK_CLEARANCE),
          `${label}:paddy ${fieldIndex} overlaps the stream bank`);
        invariant(!G.polysOverlap(parcel.poly, field.poly),
          `${label}:${parcel.id || 'palace'} overlaps paddy ${fieldIndex}`);
        if (parcel.kind !== 'palace') for (const roof of parcelRoofPolygons(parcel)) {
          invariant(!G.polysOverlap(roof, field.poly),
            `${label}:${parcel.id || 'palace'} roof overlaps paddy ${fieldIndex}`);
        }
      }
    }

    guardians += assertGuardianContract(plan, label, scale, { mask, roadSpatial });
  }
  invariant(scaleHouseCount >= DENSITY_TOTAL_FLOOR[scale],
    `${scale} aggregate density ${scaleHouseCount} < ${DENSITY_TOTAL_FLOOR[scale]}`);
  invariant(scalePaddyCount >= PADDY_TOTAL_FLOOR[scale],
    `${scale} aggregate paddies ${scalePaddyCount} < ${PADDY_TOTAL_FLOOR[scale]}`);
}

// A broad pavilion roof can miss the old camera center ray while still covering
// one side of the house. Keep a synthetic off-axis case so the frame-width part
// of the contract cannot silently collapse back to a line test.
{
  const plan = buildWithoutGlobalRandom({ scale: 'town', seed: 2 });
  const parcel = plan.parcels[8];
  const envelope = parcelFocusViewEnvelope(parcel);
  const t = 0.55;
  const lateral = PAVILION_ROOF_RADIUS + 1.6;
  const offAxis = {
    x: envelope.target.x + envelope.forward.x * envelope.distance * t + envelope.right.x * lateral,
    z: envelope.target.z + envelope.forward.z * envelope.distance * t + envelope.right.z * lateral,
  };
  invariant(lateral > PAVILION_ROOF_RADIUS,
    'focus-frame probe still intersects the obsolete center-ray cylinder');
  invariant(circleBlocksParcelFocusFrame(parcel, offAxis, PAVILION_ROOF_RADIUS),
    'focus-frame probe missed an off-axis pavilion roof');
}

let adversarialGuardianPlans = 0, adversarialGuardians = 0;
for (const [scale, seeds] of Object.entries(ADVERSARIAL_GUARDIAN_SEEDS)) {
  for (const seed of seeds) {
    const label = `${scale}:${seed}:guardian-adversarial`;
    const options = { scale, seed, includePalace: scale === 'capital' || scale === 'hanyang' };
    const plan = buildWithoutGlobalRandom(options);
    const repeat = buildWithoutGlobalRandom(options);
    invariant(JSON.stringify(plan.features.guardianTrees) === JSON.stringify(repeat.features.guardianTrees),
      `${label} guardian plan drift`);
    adversarialGuardians += assertGuardianContract(plan, label, scale);
    adversarialGuardianPlans++;
  }
}

console.log(
  `LAYOUT CONTRACT: PASS (${parcels} parcels, ${roofPolygons} roof polygons, ${rerollChecks} rerolls, `
  + `${accesses} road links, `
  + `${solarBuildings} solar-safe buildings + ${solarProbes} direction probes, `
  + `${pavilions} solar/view-safe pavilions, `
  + `${publicProps} solar/view-safe public props, `
  + `${guardians} guardians + ${adversarialGuardians} in ${adversarialGuardianPlans} adversarial plans, `
  + `${(south45 / parcels * 100).toFixed(1)}% within south±45°, max facing `
  + `${(maxFacing * 180 / Math.PI).toFixed(1)}°, max access ${maxAccess.toFixed(1)}m, `
  + `min house fit ${minHouseFit.toFixed(2)}, min scale ${minHouseScale.toFixed(2)}, `
  + `min roof clearance ${minRoofClearance.toFixed(2)}m, `
  + `${paddyFields} paddies, ${indexedCells} indexed cells)`,
);
