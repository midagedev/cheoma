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
import {
  palaceGatePoint,
  palaceUrbanFrontPlan,
} from '../src/village/palace-precinct-plan.js';
import {
  boundsOfPoints,
  createVerificationSpatialGrid,
} from './lib/verification-spatial-grid.mjs';

const SCALES = ['hamlet', 'village', 'town', 'capital', 'hanyang'];
const SEEDS = [7, 42, 20260716];
const MAX_TURN = Math.PI / 4;
const POSITION_EPSILON = 2e-4;
const INTERSECTION_EPSILON = 1e-5;

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

function tolerantSegmentIntersection(a, b, c, d, epsilon = INTERSECTION_EPSILON) {
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

function bruteRoadIntersections(a, b, segmentPairs = null) {
  const intersections = [];
  const visit = (ai, bi) => {
    const hit = tolerantSegmentIntersection(
      a.pts[ai], a.pts[ai + 1], b.pts[bi], b.pts[bi + 1],
    );
    if (hit) intersections.push(hit);
  };
  if (segmentPairs) {
    for (const [ai, bi] of segmentPairs) visit(ai, bi);
  } else {
    for (let ai = 0; ai < a.pts.length - 1; ai++) {
      for (let bi = 0; bi < b.pts.length - 1; bi++) visit(ai, bi);
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

function allPairs(length) {
  const pairs = [];
  for (let left = 0; left < length; left++) {
    for (let right = left + 1; right < length; right++) pairs.push([left, right]);
  }
  return pairs;
}

function intersectionSnapshot(roads, pairs, segmentPairsByRoadPair = null) {
  return JSON.stringify(pairs.flatMap(([left, right]) => (
    uniqueIntersections(bruteRoadIntersections(
      roads[left],
      roads[right],
      segmentPairsByRoadPair?.get(`${left}:${right}`) || null,
    )).map((point) => ({
      left: roads[left].id,
      right: roads[right].id,
      x: point.x,
      z: point.z,
    }))
  )));
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
let segmentPairCandidates = 0;
let segmentPairBrute = 0;

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
    const segments = roadArray.flatMap((road, roadIndex) => (
      road.pts.slice(0, -1).map((point, segmentIndex) => ({
        roadIndex,
        segmentIndex,
        points: [point, road.pts[segmentIndex + 1]],
      }))
    ));
    const segmentGrid = createVerificationSpatialGrid(
      segments,
      (segment) => boundsOfPoints(segment.points, INTERSECTION_EPSILON),
    );
    const segmentPairsByRoadPair = new Map();
    for (const [left, right] of segmentGrid.candidatePairs()) {
      const segmentA = segments[left], segmentB = segments[right];
      if (segmentA.roadIndex === segmentB.roadIndex) continue;
      const key = `${segmentA.roadIndex}:${segmentB.roadIndex}`;
      let pairs = segmentPairsByRoadPair.get(key);
      if (!pairs) {
        pairs = [];
        segmentPairsByRoadPair.set(key, pairs);
      }
      pairs.push([segmentA.segmentIndex, segmentB.segmentIndex]);
      segmentPairCandidates++;
    }
    const candidatePairs = [...segmentPairsByRoadPair.keys()]
      .map((key) => key.split(':').map(Number))
      .sort(([leftA, rightA], [leftB, rightB]) => leftA - leftB || rightA - rightB);
    for (let left = 0; left < roadArray.length; left++) {
      for (let right = left + 1; right < roadArray.length; right++) {
        segmentPairBrute += (roadArray[left].pts.length - 1) * (roadArray[right].pts.length - 1);
      }
    }
    if (scale === 'town' && seed === 7) {
      invariant(
        intersectionSnapshot(roadArray, candidatePairs, segmentPairsByRoadPair)
          === intersectionSnapshot(roadArray, allPairs(roadArray.length)),
        'town:7 road grid changed brute-force intersection results or order',
      );
    }
    for (const [a, b] of candidatePairs) {
      const roadA = roadArray[a], roadB = roadArray[b];
      const hits = uniqueIntersections(bruteRoadIntersections(
        roadA,
        roadB,
        segmentPairsByRoadPair.get(`${a}:${b}`),
      ));
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

    // ── 궁역 앞 도시면 (#21 R5 D8·E, 재저작 2026-08-02) ─────────────────────────
    // 종전 단언은 궁 구성의 주작대로가 **상수점** `C.z + R × (0.13|0.11)` 에서 시작하는지만
    //   봤다. 그 상수는 궁 정문의 실제 위치가 아니다 — 실측 2026-08-02(hanyang 4시드): 대로
    //   시점이 광화문에서 4.00m 떨어져 있었고 대로 자체도 완만히 휘어 정문 법선과 어긋났다.
    //   구한말 사진 판독(#15 D8)이 "정문 앞에 광장도, 정문에서 간선대로로 직결되는 축선도
    //   없다"로 지목한 지점이다. 상수점 대신 **정문 법선 위 광장 바깥 변**을 잠그고, 길이
    //   궁역·광장을 침범하지 않는다는 계약을 새로 건다.
    //
    // 완화가 아니라 강화다. 종전 트리 실측: ① 대로 시점이 축선 위 광장 변이 아니라 정문에서
    //   4.00m(≠ plazaLength) ② 궁역 안을 지나는 길 3~14개(정점 40~118) ③ 정문 앞 마당 안
    //   도로 정점 28~96개. 세 단언 모두 종전 소스에서 실패한다.
    const palace = planVillage({ scale, seed, includePalace: true });
    const palaceParcel = palace.features.palace;
    invariant(palaceParcel, `${scale}:${seed}:palace plan has no palace feature`);
    const palaceGate = palaceGatePoint(palaceParcel);
    const direction = G.norm(palaceParcel.frontDir);
    const jongnoZ = palace.features.cityWall?.axes?.jongnoZ;
    const axisSpan = Number.isFinite(jongnoZ)
      ? Math.max(0, G.dot(G.sub({ x: 0, z: jongnoZ }, palaceGate), direction))
      : Infinity;
    const front = palaceUrbanFrontPlan(palaceParcel, { axisSpan });
    const axisHead = {
      x: palaceGate.x + direction.x * front.straightLength,
      z: palaceGate.z + direction.z * front.straightLength,
    };
    invariant(G.dist(palace.nodes.palaceFront, palaceGate) <= POSITION_EPSILON,
      `${scale}:${seed}:palace front anchor is not the gate`);
    invariant(nearestRoadEndpoint(palace.roads, axisHead, 'daero').distance <= POSITION_EPSILON,
      `${scale}:${seed}:palace daero does not start on the gate axis at the plaza edge`);

    // 길은 궁역도 정문 앞 마당도 지나지 않는다. 유일한 예외는 축선 대로이고, 그것도
    //   정문 법선 **위에서만** 들어갈 수 있다(광장이 없는 capital 프로필에서 대로가 문에
    //   직접 닿는 경우).
    const keepOut = [front.clearance, ...(front.plaza ? [front.plaza] : [])];
    const lateral = { x: direction.z, z: -direction.x };
    const axisRoad = palace.roads.find((road) => road.level === 'daero'
      && [road.pts[0], road.pts.at(-1)].some((end) => G.dist(end, axisHead) <= POSITION_EPSILON));
    for (const road of palace.roads) {
      for (const point of road.pts) {
        for (const polygon of keepOut) {
          if (!G.pointInPoly(point, polygon)) continue;
          invariant(road === axisRoad,
            `${scale}:${seed}:road ${road.id} enters the palace keep-out`);
          invariant(Math.abs(G.dot(G.sub(point, palaceGate), lateral)) <= POSITION_EPSILON,
            `${scale}:${seed}:the axis daero enters the palace keep-out off the gate normal`);
        }
      }
    }

    // 관아 슬롯은 궁과 같은 좌향으로 정렬한다(#21 R5 D14). 거리를 향한 좌향이 아니라
    //   궁 축선과 같은 방위인 이유는 palace-precinct-plan#palaceMagistracySlots 주석 참조.
    for (const magistracy of palace.parcels.filter((parcel) => parcel.magistracySlot)) {
      const alignment = G.dot(G.norm(magistracy.frontDir), direction);
      invariant(alignment >= 1 - 1e-9,
        `${scale}:${seed}:magistracy ${magistracy.id} does not share the palace facing`);
    }
  }
}

console.log(
  `ROAD CONTRACT: PASS (${roadCount} roads, ${junctionCount} junctions, `
  + `${geometricConnections} geometric connections, ${spatialProbes} spatial probes, `
  + `${segmentPairCandidates}/${segmentPairBrute} segment intersection pairs, `
  + `max turn ${(maxTurn * 180 / Math.PI).toFixed(2)}°)`,
);
