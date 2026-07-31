import * as G from '../core/math/geom2.js';
import { createRoadSpatialIndex } from './road-spatial.js';

// 렌더러(buildWaterRibbon)가 소비하는 동일 centerline·half-width를 기준으로 한 개울 계약.
// analytic streamZat(center.x) 근사는 회전된 필지 모서리와 사행 접선을 놓치므로 배치·식생·
// 회귀 검사는 이 모듈을 통해 실제 폴리라인 리본과 비교한다.
// 중심점 근사의 옛 +4.5m는 필지 반폭을 대신하려던 휴리스틱이었다. 폴리곤 자체를 재므로
// 실제 물가 밖 배수 여유까지 직접 재므로 더 강한 안전 계약을 유지하면서 수변 취락 밀도를 잃지 않는다.
export const STREAM_PARCEL_BANK_CLEARANCE = 1.2;
export const STREAM_SATELLITE_BANK_CLEARANCE = 1.2;
export const STREAM_PADDY_BANK_CLEARANCE = 2;
export const STREAM_VEGETATION_BANK_CLEARANCE = 1.2;
export const STREAM_GUARDIAN_BASE_CLEARANCE = 2.5;

export function streamClearanceAt(site, point) {
  if (!site?.stream?.pts?.length) return Infinity;
  return G.distToPolyline(point, site.stream.pts).d - Math.max(0, site.streamHalf || 0);
}

export function streamIntersectsPolygon(site, poly, margin = 0) {
  if (!site?.stream?.pts?.length || !poly?.length) return false;
  const corridor = Math.max(0, site.streamHalf || 0) + Math.max(0, margin || 0);
  return G.polylinePolygonDistance(site.stream.pts, poly) < corridor;
}

export function streamBlocksCircle(site, point, radius = 0, margin = 0) {
  return streamClearanceAt(site, point) < Math.max(0, radius || 0) + Math.max(0, margin || 0);
}

// 수백~수만 필지 후보를 검사하는 배치 경로는 centerline 전수 순회를 반복하지 않는다.
// 도로와 개울은 모두 폭을 가진 polyline corridor이므로 이미 검증된 uniform-grid broad phase를
// 그대로 재사용한다. 저빈도 단건 소비자는 위의 stateless 함수만 써도 된다.
export function createStreamSpatialIndex(site) {
  if (!site?.stream?.pts?.length) {
    return Object.freeze({
      intersectsPolygon: () => false,
      stats: Object.freeze({ cellSize: 0, cells: 0, segments: 0 }),
    });
  }
  const spatial = createRoadSpatialIndex([site.stream]);
  return Object.freeze({
    intersectsPolygon(poly, margin = 0) {
      return spatial.intersectsRoadCorridor(poly, Math.max(0, margin || 0), site.stream);
    },
    stats: spatial.stats,
  });
}

// ── 개울·개천 다리 접지(단일 진실원) ────────────────────────────────────────
// 판석교(평석교) 데크 표고는 렌더러가 즉석에서 계산하면 계약이 검사할 수 없다. 배치 산술을
//   여기 한 곳에 두고 generators/village/features.js 가 그대로 소비한다(계획-렌더 이중 진실 금지).
// 옛 식은 둑 표본을 `streamHalf + 3` 고정 오프셋에서 떴는데, 데크 **양 끝**은 span/2 에 있어
//   둑이 그보다 높은 시드에서 널돌이 둑을 파고들었다(실측 2026-08-01: village 20260716 −0.08m,
//   town 5 −0.26m, hanyang −0.18m). 실제 접지면인 데크 양 끝 지반을 표본에 포함해 접지를 정한다.
export const BRIDGE_SLAB_DECK_LIFT = 0.55;   // 판석 상면 = 배치 y + 이 값(builder/bridge.js 규약)
export const BRIDGE_BANK_INSET = 0.35;       // 데크를 둑 상면보다 이만큼 낮춰 문턱 단차를 줄인다

export function bridgeDeckPlacement(site, spec, { surfaceY } = {}) {
  const span = spec.span || 5;
  const rot = spec.rot || 0;
  const centerZ = site.streamZat(spec.x);
  const across = { x: Math.cos(rot), z: -Math.sin(rot) };
  const ends = [-1, 1].map((side) => ({
    x: spec.x + across.x * side * span * 0.5,
    z: spec.z + across.z * side * span * 0.5,
  }));
  const endGround = ends.map((point) => site.heightAt(point.x, point.z));
  const bankOffset = Math.max(0, site.streamHalf || 0) + 3;
  const bankGround = [-1, 1].map((side) => site.heightAt(spec.x, centerZ + side * bankOffset));
  const contactY = Math.max(...bankGround, ...endGround);
  const waterY = typeof surfaceY === 'number'
    ? surfaceY
    : (site.streamY ? site.streamY(spec.x) : 0);
  const deckY = spec.type === 'arch'
    ? waterY
    : Math.max(waterY, contactY - BRIDGE_BANK_INSET);
  return {
    deckY,
    deckTopY: deckY + BRIDGE_SLAB_DECK_LIFT,
    ends,
    endGround,
    bankGround,
    contactY,
    waterY,
  };
}
