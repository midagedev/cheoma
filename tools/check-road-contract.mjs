// Pure road-network contract: deterministic IDs, smooth non-self-intersecting
// centerlines, and serializable junction metadata with valid road backrefs.
import * as G from '../src/core/math/geom2.js';
import { planVillage } from '../src/api/village-plan.js';
import {
  maxPolylineTurn,
  polylineSelfIntersections,
} from '../src/village/road-topology.js';
import { createRoadSpatialIndex } from '../src/village/road-spatial.js';
import { parcelWorldPoint } from '../src/village/parcel-contract.js';

const SCALES = ['hamlet', 'village', 'town', 'capital', 'hanyang'];
const SEEDS = [7, 42, 20260716];
const MAX_TURN = Math.PI / 4;
const POSITION_EPSILON = 2e-4;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function networkSnapshot(plan) {
  return JSON.stringify({
    roads: plan.roads.map((road) => ({
      id: road.id,
      level: road.level,
      width: road.width,
      pts: road.pts,
      junctionIds: road.junctionIds,
      wallApproach: road.wallApproach,
    })),
    junctions: plan.nodes.junctions,
  });
}

function bruteNearest(roads, point, limit) {
  let best = { d: Infinity, pt: null, seg: 0, road: null };
  for (const road of roads) {
    const result = G.distToPolyline(point, road.pts);
    if (result.d < best.d) best = { ...result, road };
  }
  return best.d <= limit ? best : { d: Infinity, pt: null, seg: 0, road: null };
}

function bruteClearance(roads, point, ownRoad, margin) {
  return roads.some((road) => road !== ownRoad
    && G.distToPolyline(point, road.pts).d < road.width * 0.5 + margin);
}

function tolerantSegmentIntersection(a, b, c, d, epsilon = 1e-5) {
  const hit = G.segIntersect(a, b, c, d);
  if (hit) return hit;
  for (const [point, otherA, otherB] of [
    [a, c, d], [b, c, d], [c, a, b], [d, a, b],
  ]) {
    const nearest = G.distToSeg(point, otherA, otherB);
    if (nearest.d <= epsilon) {
      return {
        x: (point.x + nearest.pt.x) * 0.5,
        z: (point.z + nearest.pt.z) * 0.5,
      };
    }
  }
  return null;
}

function bruteRoadIntersections(a, b) {
  const intersections = [];
  for (let ai = 0; ai < a.pts.length - 1; ai++) {
    for (let bi = 0; bi < b.pts.length - 1; bi++) {
      const hit = tolerantSegmentIntersection(
        a.pts[ai], a.pts[ai + 1], b.pts[bi], b.pts[bi + 1],
      );
      if (hit) intersections.push(hit);
    }
  }
  return intersections;
}

function uniqueIntersections(intersections) {
  const unique = [];
  for (const hit of intersections) {
    if (!unique.some((point) => G.dist(point, hit) <= POSITION_EPSILON)) unique.push(hit);
  }
  return unique;
}

function nearestRoadEndpoint(roads, point, level = null) {
  let nearest = { distance: Infinity, road: null, point: null };
  for (const road of roads) {
    if (level && road.level !== level) continue;
    for (const endpoint of [road.pts[0], road.pts.at(-1)]) {
      const distance = G.dist(endpoint, point);
      if (distance < nearest.distance) nearest = { distance, road, point: endpoint };
    }
  }
  return nearest;
}

let roadCount = 0;
let junctionCount = 0;
let maxTurn = 0;
let spatialProbes = 0;
let geometricConnections = 0;

for (const scale of SCALES) {
  for (const seed of SEEDS) {
    const options = {
      scale,
      seed,
      includePalace: scale === 'capital' || scale === 'hanyang',
    };
    const plan = planVillage(options);
    const repeat = planVillage(options);
    invariant(networkSnapshot(plan) === networkSnapshot(repeat),
      `${scale}:${seed} road network is not deterministic`);

    const roads = new Map();
    for (const road of plan.roads) {
      invariant(/^\w+-\d{3}$/.test(road.id), `${scale}:${seed} invalid road id ${road.id}`);
      invariant(!roads.has(road.id), `${scale}:${seed} duplicate road id ${road.id}`);
      invariant(Array.isArray(road.junctionIds), `${road.id} has no junction backrefs`);
      invariant(new Set(road.junctionIds).size === road.junctionIds.length,
        `${road.id} has duplicate junction backrefs`);
      const self = polylineSelfIntersections(road.pts);
      invariant(self.length === 0, `${road.id} self-intersects ${self.length} time(s)`);
      const turn = maxPolylineTurn(road.pts);
      maxTurn = Math.max(maxTurn, turn);
      invariant(turn <= MAX_TURN,
        `${road.id} turn ${(turn * 180 / Math.PI).toFixed(2)}° exceeds 45°`);
      roads.set(road.id, road);
      roadCount++;
    }

    const junctions = plan.nodes.junctions;
    invariant(Array.isArray(junctions), `${scale}:${seed} has no junction metadata`);
    const junctionIds = new Set(junctions.map((junction) => junction.id));
    invariant(junctionIds.size === junctions.length, `${scale}:${seed} duplicate junction id`);
    for (const junction of junctions) {
      invariant(junction.kind === 'connection' || junction.kind === 'crossing',
        `${junction.id} invalid kind ${junction.kind}`);
      invariant(junction.connections.length >= 2, `${junction.id} has fewer than two roads`);
      const connectionRoads = new Set();
      for (const connection of junction.connections) {
        const road = roads.get(connection.roadId);
        invariant(road, `${junction.id} references missing ${connection.roadId}`);
        invariant(!connectionRoads.has(connection.roadId),
          `${junction.id} repeats ${connection.roadId}`);
        invariant(road.junctionIds.includes(junction.id),
          `${connection.roadId} misses backref to ${junction.id}`);
        invariant(connection.segment >= 0 && connection.segment < road.pts.length - 1,
          `${junction.id} invalid segment for ${connection.roadId}`);
        invariant(connection.t >= 0 && connection.t <= 1,
          `${junction.id} invalid segment parameter for ${connection.roadId}`);
        const point = G.lerp(
          road.pts[connection.segment],
          road.pts[connection.segment + 1],
          connection.t,
        );
        invariant(G.dist(point, junction.point) <= POSITION_EPSILON,
          `${junction.id} is off ${connection.roadId} by ${G.dist(point, junction.point)}`);
        connectionRoads.add(connection.roadId);
      }
      junctionCount++;
    }
    for (const road of roads.values()) {
      for (const junctionId of road.junctionIds) {
        invariant(junctionIds.has(junctionId), `${road.id} references missing ${junctionId}`);
      }
    }

    // 정방향 검사(기록된 junction이 유효함)만으로는 빠진 T접속을 찾지 못한다. 모든 실제
    // centerline 교차/끝점 접속을 독립 brute-force로 훑어 metadata와 backref가 존재하는지 역검사한다.
    const junctionRoadSets = junctions.map((junction) => ({
      junction,
      roads: new Set(junction.connections.map((connection) => connection.roadId)),
    }));
    const roadArray = [...roads.values()];
    for (let a = 0; a < roadArray.length; a++) {
      for (let b = a + 1; b < roadArray.length; b++) {
        const roadA = roadArray[a], roadB = roadArray[b];
        const hits = uniqueIntersections(bruteRoadIntersections(roadA, roadB));
        const physicalMergeRadius = Math.min(roadA.width, roadB.width) * 0.5 + POSITION_EPSILON;
        for (let first = 0; first < hits.length; first++) {
          for (let second = first + 1; second < hits.length; second++) {
            invariant(G.dist(hits[first], hits[second]) > physicalMergeRadius,
              `${scale}:${seed} narrow road lens ${roadA.id}/${roadB.id}`);
          }
        }
        for (const hit of hits) {
          const match = junctionRoadSets.find((entry) => entry.roads.has(roadA.id)
            && entry.roads.has(roadB.id)
            && G.dist(entry.junction.point, hit) <= physicalMergeRadius);
          invariant(match,
            `${scale}:${seed} missing junction ${roadA.id}/${roadB.id} at ${hit.x},${hit.z}`);
          invariant(roadA.junctionIds.includes(match.junction.id)
            && roadB.junctionIds.includes(match.junction.id),
          `${scale}:${seed} missing junction backref ${roadA.id}/${roadB.id}`);
          geometricConnections++;
        }
      }
    }

    const roadList = roadArray;
    const spatial = createRoadSpatialIndex(roadList);
    const probes = [];
    const stride = Math.max(1, Math.floor(plan.parcels.length / 12));
    for (let i = 0; i < plan.parcels.length; i += stride) probes.push(plan.parcels[i].center);
    const center = plan.site.center, span = plan.site.bowlR * 0.72;
    for (const x of [-1, -0.5, 0, 0.5, 1]) for (const z of [-1, -0.5, 0, 0.5, 1]) {
      probes.push({ x: center.x + x * span, z: center.z + z * span });
    }
    const limit = scale === 'hanyang' ? 70 : 45;
    for (const point of probes) {
      const actual = spatial.nearest(point, limit);
      const expected = bruteNearest(roadList, point, limit);
      invariant(actual.road?.id === expected.road?.id,
        `${scale}:${seed} nearest road index drift at ${point.x},${point.z}`);
      invariant(Math.abs(actual.d - expected.d) <= 1e-9 || actual.d === expected.d,
        `${scale}:${seed} nearest distance index drift at ${point.x},${point.z}`);
      if (actual.pt) invariant(G.dist(actual.pt, expected.pt) <= 1e-9,
        `${scale}:${seed} nearest point index drift at ${point.x},${point.z}`);
      invariant(spatial.withinRoadClearance(point, null, 2.5)
        === bruteClearance(roadList, point, null, 2.5),
      `${scale}:${seed} road clearance index drift at ${point.x},${point.z}`);
      spatialProbes++;
    }
  }
}

// 궁 없는 도성은 궁 전용 상수점이 아니라 예약 관아의 실제 남문에서 주작대로가 시작한다.
// 두 tier의 과거 단절(각각 32.5m/55m)을 endpoint로 직접 잠그고, 궁 구성의 기존 상수점은
// 별도 비교해 이 수정이 궁 배치와 그 RNG 경로를 건드리지 않았음을 보장한다.
for (const scale of ['capital', 'hanyang']) {
  for (const seed of SEEDS) {
    const options = { scale, seed, includePalace: false };
    const plan = planVillage(options);
    const repeat = planVillage(options);
    invariant(networkSnapshot(plan) === networkSnapshot(repeat),
      `${scale}:${seed}:no-palace road network is not deterministic`);

    const core = plan.parcels.find((parcel) => parcel.hero && parcel.heroStyle === 'palace');
    invariant(core, `${scale}:${seed}:no-palace has no government core`);
    const gate = parcelWorldPoint(core, { x: 0, z: core.plotD * 0.5 });
    invariant(G.dist(plan.nodes.palaceFront, gate) <= POSITION_EPSILON,
      `${scale}:${seed}:no-palace core road anchor misses government gate`);
    const endpoint = nearestRoadEndpoint(plan.roads, gate, 'daero');
    invariant(endpoint.distance <= POSITION_EPSILON,
      `${scale}:${seed}:no-palace daero ends ${endpoint.distance.toFixed(3)}m from government gate`);

    const palace = planVillage({ scale, seed, includePalace: true });
    const legacyFront = {
      x: 0,
      z: palace.site.center.z + palace.site.R * (scale === 'capital' ? 0.13 : 0.11),
    };
    invariant(G.dist(palace.nodes.palaceFront, legacyFront) <= POSITION_EPSILON,
      `${scale}:${seed}:palace front anchor drifted`);
    invariant(nearestRoadEndpoint(palace.roads, legacyFront, 'daero').distance <= POSITION_EPSILON,
      `${scale}:${seed}:palace daero endpoint drifted`);
  }
}

console.log(
  `ROAD CONTRACT: PASS (${roadCount} roads, ${junctionCount} junctions, `
  + `${geometricConnections} geometric connections, ${spatialProbes} spatial probes, `
  + `max turn ${(maxTurn * 180 / Math.PI).toFixed(2)}°)`,
);
