// 한양 성곽의 단일-contour 계약: 좌표계·사대문·world edge·도로 폭·식생 여유·지형 밀착을
// DOM/THREE 없이 검증한다. 넓은 wall-only seed sweep과 회귀 이력이 있는 production seed를 함께 둔다.
import * as G from '../src/core/math/geom2.js';
import { makeSite } from '../src/village/site.js';
import { planVillage } from '../src/village/plan.js';
import { planGuardianTrees } from '../src/village/guardian-plan.js';
import { terrainMeshHeightAt, terrainWarpInner } from '../src/village/terrain-surface.js';
import {
  ROAD_SURFACE_MIN_JOIN_GAP,
  roadSurfaceUpArea,
  sampleRoadSurface,
} from '../src/village/road-surface.js';
import {
  CITY_WALL_DIMENSIONS,
  CITY_WALL_MIN_SITE_R,
  cityGateFootprint,
  cityGateApproachFootprint,
  cityGateLocalPoint,
  cityGatePierTerrainProfile,
  cityGateStructureProfile,
  cityGateStreamClearance,
  cityGateTerrainProfile,
  cityWallAngleInGate,
  cityWallClearance,
  cityWallContainsPolygon,
  cityWallOutsidePolygon,
  cityWallSegmentCapProfile,
  cityWallSegmentFootprint,
  cityWallVegetationBlocked,
  normalOnCityWall,
  planCityWall,
  pointOnCityWall,
  sampleCityWallSegments,
  worldEdgeClearance,
  worldEdgeContainsPolygon,
} from '../src/village/citywall-contour.js';

const TAU = Math.PI * 2;
const EPS = 1e-6;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function assertGuardianClearance(plan, label, expectedCount) {
  const wall = plan.features?.cityWall;
  if (!wall) return 0;
  const guardians = planGuardianTrees(plan, plan.site, plan.seed);
  invariant(guardians.length === expectedCount,
    `${label}: expected ${expectedCount} collision-free guardian trees, got ${guardians.length}`);
  for (const [index, guardian] of guardians.entries()) {
    const radius = guardian.radius;
    invariant(!cityWallVegetationBlocked(wall, guardian, {
      corridor: radius + CITY_WALL_DIMENSIONS.vegetationClearance,
      gateMargin: radius + CITY_WALL_DIMENSIONS.gateVegetationMargin,
      gateApproachMargin: radius,
    }), `${label}: guardian ${index} canopy reaches wall/gate/approach`);
    invariant(worldEdgeClearance(plan.site.edge, guardian) >= radius - EPS,
      `${label}: guardian ${index} canopy left terrain`);
  }
  return guardians.length;
}

const near = (a, b, eps = EPS) => Math.abs(a - b) <= eps;
const pointNear = (a, b, eps = EPS) => G.dist(a, b) <= eps;
const angleDistance = (a, b) => {
  let d = Math.abs(a - b) % TAU;
  return d > Math.PI ? TAU - d : d;
};

function assertSimpleContour(spec, label) {
  const points = spec.radii.map((_, i) => pointOnCityWall(spec, i / spec.radii.length * TAU));
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    for (let j = i + 1; j < points.length; j++) {
      if (j === i || j === i + 1 || (i === 0 && j === points.length - 1)) continue;
      const c = points[j], d = points[(j + 1) % points.length];
      invariant(!G.segIntersect(a, b, c, d), `${label}: contour self-intersection ${i}/${j}`);
    }
  }
}

function assertGate(spec, site, gate, label) {
  const onWall = pointOnCityWall(spec, gate.angle);
  invariant(pointNear(onWall, gate), `${label}/${gate.name}: gate drifted from contour`);
  const normal = normalOnCityWall(spec, gate.angle);
  invariant(near(normal.x, gate.dirX) && near(normal.z, gate.dirZ), `${label}/${gate.name}: stale normal`);
  invariant(near(Math.hypot(gate.dirX, gate.dirZ), 1), `${label}/${gate.name}: non-unit normal`);
  invariant((gate.x - spec.cx) * gate.dirX + (gate.z - spec.cz) * gate.dirZ > 0,
    `${label}/${gate.name}: normal points inward`);
  invariant(cityWallAngleInGate(spec, gate.angle), `${label}/${gate.name}: opening misses gate center`);
  invariant(!cityWallAngleInGate(spec, gate.angle - gate.halfAngle), `${label}/${gate.name}: fuzzy opening start`);
  invariant(!cityWallAngleInGate(spec, gate.angle + gate.halfAngle), `${label}/${gate.name}: fuzzy opening end`);

  for (const point of cityGateFootprint(gate)) {
    invariant(worldEdgeClearance(site.edge, point) >= -EPS, `${label}/${gate.name}: footprint left terrain`);
  }
  if (site.R >= 250) {
    invariant(cityGateStreamClearance(gate, site) >= CITY_WALL_DIMENSIONS.gateStreamClearance - EPS,
      `${label}/${gate.name}: gate overlaps the stream bank`);
  }
  const structure = cityGateStructureProfile(gate, site);
  const denseRoad = cityGateTerrainProfile(gate, site, { extraWidth: 0, widthSamples: 17, depthSamples: 13 });
  invariant(structure.archBottomY <= denseRoad.min, `${label}/${gate.name}: floating passage mask`);
  invariant(structure.archTopY >= denseRoad.max
    + CITY_WALL_DIMENSIONS.gateArchClearance * gate.scale - EPS,
  `${label}/${gate.name}: road lacks arch clearance`);
  invariant(structure.baseTopY >= Math.max(denseRoad.max, ...structure.piers.map((pier) => pier.max))
    + CITY_WALL_DIMENSIONS.gateTerrainReveal * gate.scale - EPS,
  `${label}/${gate.name}: terrain covers gate deck`);
  let maxPierHeight = 0;
  for (const side of [-1, 1]) {
    const pier = cityGatePierTerrainProfile(gate, site, side);
    const bottomY = pier.min - CITY_WALL_DIMENSIONS.gateFoundationSink * gate.scale;
    maxPierHeight = Math.max(maxPierHeight, structure.baseTopY - bottomY);
    let denseMin = Infinity;
    for (let ix = 0; ix <= 24; ix++) for (let iz = 0; iz <= 24; iz++) {
      const localX = pier.centerX - pier.pierWidth * 0.5 + pier.pierWidth * ix / 24;
      const localZ = -pier.depth * 0.5 + pier.depth * iz / 24;
      const point = cityGateLocalPoint(gate, localX, localZ);
      denseMin = Math.min(denseMin, terrainMeshHeightAt(site, point.x, point.z));
    }
    invariant(bottomY <= denseMin + EPS, `${label}/${gate.name}: pier ${side} floats ${Number(bottomY - denseMin).toFixed(3)}m`);
  }
  invariant(maxPierHeight <= CITY_WALL_DIMENSIONS.gateMaxPierHeight + EPS,
    `${label}/${gate.name}: ${maxPierHeight.toFixed(2)}m cliff pier`);
  invariant(cityWallVegetationBlocked(spec, gate), `${label}/${gate.name}: vegetation reaches gate`);
  const approach = CITY_WALL_DIMENSIONS.gateApproachLength * Math.max(0.6, gate.scale || 1);
  for (const sign of [-1, 1]) {
    const point = { x: gate.x + gate.dirX * approach * 0.9 * sign, z: gate.z + gate.dirZ * approach * 0.9 * sign };
    invariant(cityWallVegetationBlocked(spec, point), `${label}/${gate.name}: vegetation blocks approach`);
  }
}

function assertGateSpacing(spec, label) {
  const gates = [...spec.gates].sort((a, b) => a.angle - b.angle);
  for (let i = 0; i < gates.length; i++) {
    const a = gates[i], b = gates[(i + 1) % gates.length];
    const separation = (b.angle - a.angle + TAU) % TAU;
    const gapAngle = separation - a.halfAngle - b.halfAngle;
    const gapMetres = gapAngle * spec.meanRadius;
    invariant(gapMetres >= 2 - EPS, `${label}: gates ${a.name}/${b.name} overlap (${gapMetres.toFixed(2)}m)`);
  }
}

function bilerpQuad(corners, values, u, v) {
  const inner = G.lerp(corners[0], corners[3], u);
  const outer = G.lerp(corners[1], corners[2], u);
  const point = G.lerp(inner, outer, v);
  const innerValue = values[0] + (values[3] - values[0]) * u;
  const outerValue = values[1] + (values[2] - values[1]) * u;
  return { point, value: innerValue + (outerValue - innerValue) * v };
}

function assertSegments(spec, site, label) {
  const segments = sampleCityWallSegments(spec, site);
  invariant(segments.length > 0, `${label}: no wall segments`);
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    invariant(segment.length <= CITY_WALL_DIMENSIONS.maxSegmentLength + EPS, `${label}: segment too long`);
    invariant(segment.terrainError <= CITY_WALL_DIMENSIONS.maxTerrainError + EPS, `${label}: terrain chord error`);
    invariant(!cityWallAngleInGate(spec, (segment.angle0 + segment.angle1) * 0.5), `${label}: wall crosses gate`);
    invariant(cityWallVegetationBlocked(spec, G.lerp(segment.p0, segment.p1, 0.5)), `${label}: vegetation reaches wall`);
    const cap = cityWallSegmentCapProfile(segment, CITY_WALL_DIMENSIONS.thickness * 0.7);
    const narrow = cityWallSegmentFootprint(segment, CITY_WALL_DIMENSIONS.thickness * 0.7);
    invariant(narrow.corners.length === 4, `${label}: invalid cap footprint`);
    for (let c = 0; c < 4; c++) {
      invariant(pointNear(cap.corners[c], narrow.corners[c], 1e-9), `${label}: cap footprint drift`);
    }
    const bodyTop = segment.ground.map(
      (ground) => ground + CITY_WALL_DIMENSIONS.bodyHeight - CITY_WALL_DIMENSIONS.foundationSink,
    );
    const capEdgeMix = (1 - 0.7) * 0.5;
    const capEdgeSamples = [
      bilerpQuad(segment.corners, bodyTop, 0, capEdgeMix).value,
      bilerpQuad(segment.corners, bodyTop, 0, 1 - capEdgeMix).value,
      bilerpQuad(segment.corners, bodyTop, 1, 1 - capEdgeMix).value,
      bilerpQuad(segment.corners, bodyTop, 1, capEdgeMix).value,
    ];
    for (let c = 0; c < 4; c++) {
      invariant(near(cap.baseY[c], capEdgeSamples[c], 1e-9),
        `${label}: cap/body seam split ${Number(cap.baseY[c] - capEdgeSamples[c]).toFixed(3)}m`);
    }

    for (let c = 0; c < 4; c++) {
      const point = segment.corners[c];
      invariant(near(segment.ground[c], terrainMeshHeightAt(site, point.x, point.z)),
        `${label}: stale corner ground`);
      invariant(worldEdgeClearance(site.edge, point) >= -EPS, `${label}: segment corner left terrain`);
    }
    for (const u of [0, 0.125, 0.25, 0.5, 0.75, 0.875, 1]) {
      for (const v of [0, 0.25, 0.5, 0.75, 1]) {
      const sample = bilerpQuad(segment.corners, segment.ground, u, v);
      // 화면에 보이는 것은 해석 heightAt가 아니라 정규 grid 삼각형의 선형면이다.
      const terrainY = terrainMeshHeightAt(site, sample.point.x, sample.point.z);
      const bottomY = sample.value - CITY_WALL_DIMENSIONS.foundationSink;
      const topY = sample.value + CITY_WALL_DIMENSIONS.bodyHeight - CITY_WALL_DIMENSIONS.foundationSink;
      invariant(bottomY <= terrainY + EPS, `${label}: wall bottom floats ${Number(bottomY - terrainY).toFixed(3)}m`);
      invariant(topY >= terrainY + 4, `${label}: wall body buried (${Number(topY - terrainY).toFixed(3)}m exposed)`);
      }
    }

    const next = segments[i + 1];
    if (next && near(segment.angle1, next.angle0, 1e-9)) {
      invariant(segment.joinedEnd && next.joinedStart, `${label}: continuous run lost join metadata`);
      invariant(pointNear(segment.corners[2], next.corners[1], 1e-9), `${label}: outer miter split`);
      invariant(pointNear(segment.corners[3], next.corners[0], 1e-9), `${label}: inner miter split`);
    } else if (!(i === segments.length - 1 && !cityWallAngleInGate(spec, 0))) {
      invariant(!segment.joinedEnd, `${label}: gate opening lost end-cap`);
    }
  }
  const first = segments[0], last = segments.at(-1);
  if (!cityWallAngleInGate(spec, 0)) {
    invariant(last.joinedEnd && first.joinedStart, `${label}: cyclic seam lost join metadata`);
    invariant(pointNear(last.corners[2], first.corners[1], 1e-9), `${label}: cyclic outer miter split`);
    invariant(pointNear(last.corners[3], first.corners[0], 1e-9), `${label}: cyclic inner miter split`);
  }
  return segments;
}

function assertWallOnly(seed, siteR) {
  const label = `seed=${seed}/R=${siteR}`;
  const site = makeSite({ siteR, seed });
  const hw = Math.min(50, siteR * 0.10), hd = Math.min(85, siteR * 0.18);
  const core = [[
    { x: site.center.x - hw, z: site.center.z - hd },
    { x: site.center.x + hw, z: site.center.z - hd },
    { x: site.center.x + hw, z: site.center.z + hd },
    { x: site.center.x - hw, z: site.center.z + hd },
  ]];
  const wall = planCityWall(site, seed, core);
  invariant(wall.version === 3, `${label}: stale wall schema`);
  invariant(wall.radii.length >= 96 && wall.radii.length <= 256, `${label}: sample budget`);
  invariant(wall.radii.every((radius) => Number.isFinite(radius) && radius > 0), `${label}: invalid radius`);
  invariant(pointNear(pointOnCityWall(wall, 0), pointOnCityWall(wall, TAU)), `${label}: open seam`);
  invariant(pointOnCityWall(wall, 0).z > wall.cz, `${label}: angle 0 is not south/+z`);
  invariant(pointOnCityWall(wall, Math.PI / 2).x > wall.cx, `${label}: angle π/2 is not east/+x`);
  invariant(cityWallContainsPolygon(wall, core[0], 5), `${label}: reserved core escaped`);
  assertSimpleContour(wall, label);

  for (let i = 0; i < 1024; i++) {
    const angle = i / 1024 * TAU;
    const point = pointOnCityWall(wall, angle);
    const normal = normalOnCityWall(wall, angle);
    for (const offset of [-CITY_WALL_DIMENSIONS.thickness / 2, 0, CITY_WALL_DIMENSIONS.thickness / 2]) {
      const q = { x: point.x + normal.x * offset, z: point.z + normal.z * offset };
      invariant(worldEdgeClearance(site.edge, q) >= -EPS, `${label}: wall footprint left terrain at ${i}`);
    }
  }

  const byName = Object.fromEntries(wall.gates.map((gate) => [gate.name, gate]));
  invariant(wall.gates.length === 4, `${label}: four gates required`);
  invariant(angleDistance(byName.south.angle, 0) <= 0.7 + EPS, `${label}: south gate left sector`);
  invariant(angleDistance(byName.north.angle, Math.PI) <= 1.2 + EPS, `${label}: north gate left sector`);
  invariant(byName.east.x > wall.cx && byName.west.x < wall.cx, `${label}: east/west gates swapped`);
  invariant(near(byName.east.z, wall.axes.jongnoZ) && near(byName.west.z, wall.axes.jongnoZ), `${label}: Jongno gate drift`);
  invariant(wall.axes.jongnoZ >= wall.cz + site.R * 0.13 - EPS,
    `${label}: Jongno crossed north of the palace approach`);
  assertGateSpacing(wall, label);
  for (const gate of wall.gates) assertGate(wall, site, gate, label);
  return assertSegments(wall, site, label);
}

function pointInGateOpening(wall, point, roadWidth) {
  const angle = Math.atan2(point.x - wall.cx, point.z - wall.cz);
  return cityWallAngleInGate(wall, angle)
    && wall.gates.some((gate) => G.dist(gate, point) <= roadWidth + CITY_WALL_DIMENSIONS.gateDepth);
}

function triangleSurfacePoint(a, b, c, u, v) {
  const wa = 1 - u - v;
  return {
    x: a.x * wa + b.x * u + c.x * v,
    y: a.y * wa + b.y * u + c.y * v,
    z: a.z * wa + b.z * u + c.z * v,
  };
}

function pointInTriangleXZ(point, [a, b, c]) {
  const cross = (p, q, r) => (q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x);
  const ab = cross(a, b, point), bc = cross(b, c, point), ca = cross(c, a, point);
  return (ab >= -EPS && bc >= -EPS && ca >= -EPS)
    || (ab <= EPS && bc <= EPS && ca <= EPS);
}

function assertRoadTriangleDraped(p, q, r, road, site, label) {
  invariant(roadSurfaceUpArea(p, q, r) > EPS,
    `${label}/${road.level}: road triangle faces down or degenerates`);
  for (let iu = 0; iu <= 4; iu++) for (let iv = 0; iv <= 4 - iu; iv++) {
    const point = triangleSurfacePoint(p, q, r, iu / 4, iv / 4);
    const terrainY = terrainMeshHeightAt(site, point.x, point.z);
    invariant(point.y >= terrainY - EPS,
      `${label}/${road.level}: road surface entered terrain by ${(terrainY - point.y).toFixed(3)}m`);
  }
}

function assertRoadSurfaceDraped(road, site, label) {
  const { centerline, strips, joins } = sampleRoadSurface(site, road);
  invariant(centerline.length === road.pts.length
    && centerline.every((point, i) => pointNear(point, road.pts[i])),
  `${label}/${road.level}: renderer changed the shared road centerline`);
  for (const strip of strips) {
    const tangent = G.norm(G.sub(strip.b, strip.a));
    const normal = G.perpR(tangent);
    const length = G.dist(strip.a, strip.b);
    invariant(strip.triangles.length > 0, `${label}/${road.level}: empty rendered ribbon`);
    for (const triangle of strip.triangles) {
      for (const point of triangle) {
        const relative = G.sub(point, strip.a);
        const along = G.dot(relative, tangent), across = G.dot(relative, normal);
        invariant(along >= -EPS && along <= length + EPS
          && Math.abs(across) <= strip.width * 0.5 + EPS,
        `${label}/${road.level}: rendered ribbon left its plan segment`);
      }
      assertRoadTriangleDraped(...triangle, road, site, label);
    }
    // Production clipper와 독립적으로 원래 직사각형을 표본화해 grid/diagonal seam의 구멍을 잡는다.
    for (const alongK of [0, 0.125, 0.25, 0.5, 0.75, 0.875, 1]) {
      const center = G.lerp(strip.a, strip.b, alongK);
      for (const acrossK of [-0.98, -0.5, 0, 0.5, 0.98]) {
        const point = G.add(center, G.mul(normal, strip.width * 0.5 * acrossK));
        invariant(strip.triangles.some((triangle) => pointInTriangleXZ(point, triangle)),
          `${label}/${road.level}: terrain-clipped ribbon leaves a coverage gap`);
      }
    }
  }
  for (const join of joins) for (const triangle of join.triangles) {
    assertRoadTriangleDraped(...triangle, road, site, label);
  }

  // Production triangulator를 되읽지 않고 계획선 회전에서 기대 부채꼴을 독립 계산한다. 각 내부
  // vertex의 외측 반경·각도 표본이 실제 join triangle에 들어가야 코너 구멍을 회귀로 잡는다.
  const joinByPoint = new Map(joins.map((join) => [join.pointIndex, join]));
  let expectedJoins = 0;
  for (let i = 1; i < centerline.length - 1; i++) {
    const incoming = G.norm(G.sub(centerline[i], centerline[i - 1]));
    const outgoing = G.norm(G.sub(centerline[i + 1], centerline[i]));
    const turn = incoming.x * outgoing.z - incoming.z * outgoing.x;
    const directionDot = G.dot(incoming, outgoing);
    const turnAngle = Math.abs(Math.atan2(turn, directionDot));
    if (directionDot > 0 && road.width * 0.5 * turnAngle <= ROAD_SURFACE_MIN_JOIN_GAP) continue;
    expectedJoins++;
    const side = turn === 0 ? 1 : turn;
    const startNormal = side > 0 ? G.perpL(incoming) : G.perpR(incoming);
    const endNormal = side > 0 ? G.perpL(outgoing) : G.perpR(outgoing);
    const startAngle = Math.atan2(startNormal.z, startNormal.x);
    const sweep = Math.atan2(
      startNormal.x * endNormal.z - startNormal.z * endNormal.x,
      G.dot(startNormal, endNormal),
    );
    const join = joinByPoint.get(i);
    invariant(join, `${label}/${road.level}: missing outer join at point ${i}`);
    for (const radiusK of [0.25, 0.5, 0.75, 0.98]) for (const arcK of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      const angle = startAngle + sweep * arcK;
      const point = {
        x: centerline[i].x + Math.cos(angle) * road.width * 0.5 * radiusK,
        z: centerline[i].z + Math.sin(angle) * road.width * 0.5 * radiusK,
      };
      invariant(join.triangles.some((triangle) => pointInTriangleXZ(point, triangle)),
        `${label}/${road.level}: outer join leaves a coverage gap at point ${i}`);
    }
  }
  invariant(joins.length === expectedJoins, `${label}/${road.level}: unexpected road joins`);
  return strips.reduce((sum, strip) => sum + strip.triangles.length, 0)
    + joins.reduce((sum, join) => sum + join.triangles.length, 0);
}

function assertGateRoadThroats(road, wall, site, label) {
  let gateLinked = false;
  const crossings = [];
  for (let index = 0; index < road.pts.length; index++) {
    const gate = wall.gates.find((candidate) => pointNear(candidate, road.pts[index]));
    if (gate) crossings.push({ gate, index });
  }
  for (const { gate, index } of crossings) {
    gateLinked = true;
    const inward = { x: -gate.dirX, z: -gate.dirZ };
    const outward = { x: gate.dirX, z: gate.dirZ };
    const sides = [];
    if (index > 0) sides.push({ step: -1, point: road.pts[index - 1] });
    if (index < road.pts.length - 1) sides.push({ step: 1, point: road.pts[index + 1] });
    const classified = sides.map((side) => {
      const tangent = G.norm(G.sub(side.point, gate));
      const inwardDot = G.dot(tangent, inward);
      return { ...side, tangent, inwardDot, kind: inwardDot >= 0 ? 'inside' : 'outside' };
    });
    const approach = road.wallApproach?.gate === gate.name;
    invariant(classified.some((side) => side.kind === 'inside'),
      `${label}/${gate.name}: road lacks an interior throat`);
    invariant(!approach || (classified.length === 2
      && classified.filter((side) => side.kind === 'outside').length === 1),
    `${label}/${gate.name}: exterior approach does not cross the gate once`);
    if (classified.length === 2) {
      invariant(G.dot(classified[0].tangent, classified[1].tangent) <= -1 + 1e-9,
        `${label}/${gate.name}: road bends inside the opening`);
    }
    for (const side of classified) {
      const direction = side.kind === 'inside' ? inward : outward;
      const cosine = G.dot(side.tangent, direction);
      invariant(cosine >= 1 - 1e-9, `${label}/${gate.name}: ${side.kind} road misses gate normal`);
      const requiredOpening = road.width / Math.max(cosine, EPS) + CITY_WALL_DIMENSIONS.gateRoadClearance;
      invariant(requiredOpening <= gate.width + EPS,
        `${label}/${gate.name}: ${road.level} road clips gate (${requiredOpening.toFixed(2)}m > ${gate.width.toFixed(2)}m)`);
      if (side.kind === 'inside') {
        invariant(cityWallClearance(wall, side.point) >= road.width * 0.5
          + CITY_WALL_DIMENSIONS.roadEdgeMargin - EPS,
        `${label}/${gate.name}: aligned throat lacks wall clearance`);
      }
      const local = [gate];
      for (let cursor = index + side.step; cursor >= 0 && cursor < road.pts.length && local.length < 6; cursor += side.step) {
        local.push(road.pts[cursor]);
      }
      let previousAlong = -EPS;
      for (const point of local) {
        const along = G.dot(G.sub(point, gate), direction);
        invariant(along >= previousAlong - EPS, `${label}/${gate.name}: ${side.kind} transition doubles back`);
        previousAlong = along;
      }
      for (let i = 1; i < local.length - 1; i++) {
        const before = G.norm(G.sub(local[i], local[i - 1]));
        const after = G.norm(G.sub(local[i + 1], local[i]));
        const turn = Math.acos(Math.min(1, Math.max(-1, G.dot(before, after))));
        invariant(turn <= Math.PI * 35 / 180 + EPS,
          `${label}/${gate.name}: ${side.kind} transition folds ${(turn * 180 / Math.PI).toFixed(1)}°`);
      }
    }
  }
  if (road.wallApproach) invariant(crossings.length === 1,
    `${label}/${road.level}: exterior approach has ${crossings.length} gate crossings`);
  if (gateLinked) assertRoadSurfaceDraped(road, site, label);
}

function assertRoads(plan, label) {
  const wall = plan.features.cityWall;
  const warpInner = terrainWarpInner(plan, plan.site);
  for (const road of plan.roads) {
    for (const point of road.pts) {
      invariant(Math.hypot(point.x, point.z) + road.width * 0.5 <= warpInner + EPS,
        `${label}/${road.level}: road footprint entered warped terrain band`);
    }
    assertGateRoadThroats(road, wall, plan.site, label);
    const approachGate = road.wallApproach
      ? wall.gates.find((gate) => gate.name === road.wallApproach.gate)
      : null;
    const gateIndex = approachGate
      ? road.pts.findIndex((point) => pointNear(point, approachGate))
      : -1;
    for (let i = 0; i < road.pts.length - 1; i++) {
      const a = road.pts[i], b = road.pts[i + 1];
      const tangent = G.norm(G.sub(b, a));
      const side = G.perpL(tangent);
      const exterior = approachGate && (road.wallApproach.side === 'start' ? i < gateIndex : i >= gateIndex);
      for (const u of [0, 0.25, 0.5, 0.75, 1]) {
        const point = G.lerp(a, b, u);
        invariant(worldEdgeClearance(plan.site.edge, point) >= -EPS,
          `${label}: road center left terrain`);
        if (exterior) {
          if (!pointInGateOpening(wall, point, road.width)) {
            invariant(cityWallClearance(wall, point) <= -EPS,
              `${label}: exterior approach re-entered the wall`);
          }
          continue;
        }
        invariant(cityWallClearance(wall, point) >= -EPS, `${label}: road center crossed wall`);
        if (pointInGateOpening(wall, point, road.width)) continue;
        for (const sign of [-1, 1]) {
          const edge = G.add(point, G.mul(side, road.width * 0.5 * sign));
          invariant(cityWallClearance(wall, edge) >= -EPS, `${label}: ${road.level} road edge crossed wall`);
          invariant(worldEdgeClearance(plan.site.edge, edge) >= -EPS, `${label}: ${road.level} road edge left terrain`);
        }
      }
    }
  }
}

function assertPlan(options, { expectedWall = true, repeat = false } = {}) {
  const label = JSON.stringify(options);
  const before = Math.random;
  Math.random = () => { throw new Error(`${label}: consumed global Math.random`); };
  let plan;
  try { plan = planVillage(options); }
  finally { Math.random = before; }
  if (repeat) {
    const again = planVillage(options);
    const pick = (p) => JSON.stringify({ roads: p.roads, parcels: p.parcels, wall: p.features.cityWall, sijeon: p.features.sijeon });
    invariant(pick(plan) === pick(again), `${label}: repeated plan differs`);
  }

  const wall = plan.features.cityWall;
  invariant(Boolean(wall) === expectedWall, `${label}: unexpected wall availability`);
  if (!wall) return plan;
  assertGateSpacing(wall, label);
  for (const gate of wall.gates) assertGate(wall, plan.site, gate, label);
  for (const parcel of plan.parcels) {
    invariant(worldEdgeContainsPolygon(plan.site.edge, parcel.poly, 6 - EPS), `${label}/${parcel.id}: parcel left terrain`);
    if (parcel.satellite) invariant(cityWallOutsidePolygon(wall, parcel.poly, 4 - EPS), `${label}/${parcel.id}: satellite inside wall`);
    else invariant(cityWallContainsPolygon(wall, parcel.poly, 6 - EPS), `${label}/${parcel.id}: parcel crossed wall`);
  }
  for (const shop of plan.features.sijeon || []) {
    invariant(cityWallContainsPolygon(wall, shop.poly, 4 - EPS), `${label}: sijeon crossed wall`);
  }
  assertRoads(plan, label);
  const southApproach = plan.roads.find((road) => road.wallApproach?.gate === 'south');
  invariant(southApproach, `${label}: south gate lacks an exterior approach`);
  const approachEnd = southApproach.wallApproach.side === 'start'
    ? southApproach.pts[0] : southApproach.pts.at(-1);
  invariant(cityWallClearance(wall, approachEnd) <= -southApproach.width * 0.5 + EPS,
    `${label}: south approach endpoint is not outside the wall`);
  invariant(worldEdgeClearance(plan.site.edge, approachEnd) >= southApproach.width * 0.5 - EPS,
    `${label}: south approach endpoint left terrain`);
  if (plan.site.stream && plan.features.bridges?.length) {
    const bridge = plan.features.bridges[0];
    invariant(G.distToPolyline(bridge, southApproach.pts).d <= EPS,
      `${label}: gate road misses its stream bridge`);
  }
  for (const gate of wall.gates) {
    const approach = cityGateApproachFootprint(gate);
    for (const parcel of plan.parcels.filter((candidate) => candidate.satellite)) {
      invariant(!G.polysOverlap(parcel.poly, approach), `${label}/${parcel.id}: satellite blocks ${gate.name} gate`);
    }
  }
  if (plan.scale === 'hamlet' || plan.scale === 'village') {
    const south = wall.gates.find((gate) => gate.name === 'south');
    invariant(plan.roads.some((road) => road.pts.some((point) => pointNear(point, south))),
      `${label}: village spine misses south gate`);
  } else {
    const east = wall.gates.find((gate) => gate.name === 'east');
    const west = wall.gates.find((gate) => gate.name === 'west');
    const jongno = plan.roads.find((road) => pointNear(road.pts[0], west) && pointNear(road.pts.at(-1), east));
    invariant(jongno, `${label}: east/west trunk misses gates`);
    if (plan.scale === 'hanyang') {
      invariant(jongno.pts.some((point) => near(point.x, wall.cx) && near(point.z, wall.axes.jongnoZ)), `${label}: Jongno misses T`);
    }
  }
  return plan;
}

// 작은 외부 contour 재사용부터 한양까지 고르게 훑는다. 회귀 seed는 production 계획에서도 별도 검사한다.
const RADII = [74, 128, 176, 250, 400, 440, 500];
let terrainSegments = 0;
let contourCount = 0;
for (let seed = 0; seed < 64; seed++) {
  terrainSegments += assertWallOnly(seed, RADII[seed % RADII.length]).length;
  contourCount++;
}
// 육축 높이·고밀도 도로 표본·동서문 산사면 회귀를 실제로 일으켰던 seed들.
const REGRESSION_SITES = [
  [88, 128], [6, 128], [1, 176], [58, 176], [5, 250], [17, 250], [24, 250], [33, 250],
  [96, 250], [125, 250],
  [115, 500], [317, 500], [555, 500], [657, 500], [974, 500],
];
for (const [seed, siteR] of REGRESSION_SITES) {
  terrainSegments += assertWallOnly(seed, siteR).length;
  contourCount++;
}

const solo = assertPlan({ scale: 'solo', seed: 1, cityWall: true }, { expectedWall: false, repeat: true });
invariant(solo.warnings.some((warning) => warning.includes(`R≥${CITY_WALL_MIN_SITE_R}`)), 'solo: missing graceful wall warning');
for (const [scale, seed, guardians] of [
  ['hamlet', 20, 1], ['hamlet', 1, 1], ['village', 88, 1], ['village', 42, 1],
  ['town', 42, 2], ['capital', 42, 3],
]) {
  const plan = assertPlan({ scale, seed, cityWall: true });
  assertGuardianClearance(plan, `forced ${scale}/${seed}`, guardians);
}

// 호수 기반 bowl 축소가 고정 폭 성문·육축보다 지형을 작게 만들면 강제 성곽이 예외로
// 앱 생성을 중단했다. 최소 호수와 건천/개울 양쪽을 전 tier에서 훑고, 실제 회귀 seed의
// hamlet은 반복 계획까지 비교해 wall을 조용히 버리지도 결정론을 흔들지도 않게 잠근다.
for (const scale of ['hamlet', 'village', 'town', 'capital', 'hanyang']) {
  for (const stream of [true, false]) {
    const options = {
      scale,
      seed: 13,
      cityWall: true,
      houses: 1,
      stream,
      includePalace: false,
    };
    const plan = assertPlan(options, { repeat: scale === 'hamlet' });
    invariant(near(plan.opts.bowlK, 0.8),
      `${JSON.stringify(options)}: wall did not reserve its minimum terrain span`);
  }
}
assertPlan({ scale: 'hanyang', seed: 13, houses: 1 }, { repeat: true });
assertPlan({ scale: 'hanyang', seed: 1, cityWall: false }, { expectedWall: false, repeat: true });

const defaultPlan = assertPlan({ scale: 'hanyang', seed: 20260716 }, { repeat: true });
assertGuardianClearance(defaultPlan, 'default hanyang', 3);
const defaultRoadTriangles = defaultPlan.roads.reduce(
  (sum, road, index) => sum
    + assertRoadSurfaceDraped(road, defaultPlan.site, `default hanyang/road-${index}`), 0,
);
invariant(defaultRoadTriangles <= 40000,
  `default hanyang: road surface budget exceeded (${defaultRoadTriangles} triangles)`);
invariant(defaultPlan.parcels.some((parcel) => parcel.satellite), 'default hanyang: satellite belt regressed to empty');
invariant(cityGateStreamClearance(
  defaultPlan.features.cityWall.gates.find((gate) => gate.name === 'south'), defaultPlan.site,
) >= CITY_WALL_DIMENSIONS.gateStreamClearance - EPS, 'default hanyang: south gate flooded');
assertPlan({ scale: 'hanyang', seed: 20260716, includePalace: false });
for (const seed of [25, 108, 112, 142]) {
  assertPlan({ scale: 'hanyang', seed });
}
assertPlan({ scale: 'hanyang', seed: 7, houses: 0, includePalace: false });

console.log(`CITY WALL: PASS (${contourCount} contours, ${terrainSegments} terrain segments, ${defaultPlan.parcels.length} default parcels, ${defaultRoadTriangles} road triangles)`);
