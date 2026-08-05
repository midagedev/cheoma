// Renderer-free 산지 가람 단(段)·막돌 석축 계약.
//
// 사료 근거 (refs/temple-old, 1910~1930년대 PD 사진 6점의 형태 판독):
//   - 정양사(1930): 전각들이 하나의 평탄지에 정렬하지 않고 **등고를 따라 서로 다른
//     높이에 앉아** 지붕선이 계단처럼 어긋난다.
//   - 마하연(1930): 축대–마당–전각의 수직 3단이 또렷하고, 석축은 정연한 켜쌓기가
//     아니라 크기가 뒤섞인 **막돌**이며 **상단이 지형에 맞춰 오르내린다**.
//   - 장안사(1930): 가람의 정점인 대웅보전이 **가장 뒤·가장 높은 단**에 앉는다.
//   - 신계사 대웅전(1928): 정면 계단이 **한쪽으로 치우쳐** 붙는다.
// 사진은 형태 자료로만 쓴다(전부 일제강점기 일본 측 간행물 — 캡션 서술은 인용하지 않음).
//
// 종전 구현은 전각 elevation 이 사실상 1단(mountain 에서도 누하 한 채만 0.55m)이어서
// 55.8×59.0m 일곽에 전각이 한 높이로 깔렸다. 그것이 "소규모 궁으로 읽힌다"는
// 실측 갭 ③⑤의 절반이다(docs/temple-generator.md §9).
//
// 이 모듈은 순수 데이터만 만든다. 단의 높이·경계·석축 세그먼트 상단 요철·계단 편심까지
// 전부 여기서 확정하므로, renderer 와 village adapter 는 어느 것도 다시 추론하지 않는다.

import { makeRng } from '../rng.js';

export const TEMPLE_TERRACE_SCHEMA_VERSION = 1;

// 단 사이 높이차. 규모가 클수록 터의 경사 구간이 길어 단차도 커진다.
// 사람 무릎~허리 높이(0.6~1.0m)를 벗어나지 않게 잡았다 — 그 이상은 석축이 아니라
// 옹벽으로 읽히고, 그 이하는 부감에서 지붕선 어긋남을 만들지 못한다.
const TIER_RISE = Object.freeze({ compact: 0.62, courtyard: 0.78, extended: 0.95 });
const MAX_TIERS = Object.freeze({ compact: 2, courtyard: 3, extended: 3 });

// 막돌 석축 상단 요철. 한 세그먼트 = 막돌 한 켜 폭 정도.
const RISER_SEGMENT = 2.2;
const RISER_TOP_DROP = 0.22;
// 단 상면이 전각 처마보다 밖으로 나오는 여유. 처마 물이 단 위로 떨어지게.
const TIER_MARGIN = 1.9;
// 계단: 예불축 위에 놓이지만 정확히 중심은 아니다. 답도 폭(1.45)이 계단 위에
// 남을 만큼만 편심시킨다 — 사진의 편심 계단은 기단 계단이고 단 계단은 축을 벗어나면
// 답도가 끊기므로, 이 값은 사진의 인상을 옮긴 것이지 실측 복제가 아니다.
const STAIR_WIDTH = 3.2;
const STAIR_RUN = 1.5;
const STAIR_MAX_OFFSET = 0.7;

const round = (value, digits = 3) => {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
};
const point = (x, z) => ({ x: round(x), z: round(z) });
const rect = (minX, maxX, northZ, southZ) => [
  point(minX, southZ), point(maxX, southZ), point(maxX, northZ), point(minX, northZ),
];

function buildingZRange(building) {
  const polygon = building.eaveFootprint?.polygon;
  if (polygon?.length) {
    const zs = polygon.map((corner) => corner.z);
    return { northZ: Math.min(...zs), southZ: Math.max(...zs) };
  }
  const half = (building.footprint?.depth || 0) / 2;
  return { northZ: building.position.z - half, southZ: building.position.z + half };
}

function buildingXRange(building) {
  const polygon = building.eaveFootprint?.polygon;
  if (polygon?.length) {
    const xs = polygon.map((corner) => corner.x);
    return { minX: Math.min(...xs), maxX: Math.max(...xs) };
  }
  const half = (building.footprint?.width || 0) / 2;
  return { minX: building.position.x - half, maxX: building.position.x + half };
}

/**
 * 전각을 z 로 겹치는 묶음(행)으로 나눈다. 한 행은 같은 단에 앉는다 — 행 내부에서
 * 높이가 갈리면 나란히 선 전각의 기단이 서로 어긋나 붕괴한 것처럼 읽힌다.
 * `id` 비교는 `localeCompare` 를 쓰지 않는다(로케일 의존 = 결정론 파괴).
 */
function buildingRows(buildings) {
  const items = buildings.map((building) => ({
    building,
    ...buildingZRange(building),
    ...buildingXRange(building),
  })).sort((a, b) => (a.northZ - b.northZ) || (a.building.id < b.building.id ? -1 : 1));
  const rows = [];
  for (const item of items) {
    const row = rows[rows.length - 1];
    if (row && item.northZ < row.southZ) {
      row.members.push(item);
      row.northZ = Math.min(row.northZ, item.northZ);
      row.southZ = Math.max(row.southZ, item.southZ);
      row.minX = Math.min(row.minX, item.minX);
      row.maxX = Math.max(row.maxX, item.maxX);
    } else {
      rows.push({
        members: [item],
        northZ: item.northZ, southZ: item.southZ,
        minX: item.minX, maxX: item.maxX,
      });
    }
  }
  return rows;
}

function riserSegments(minX, maxX, z, topY, seed) {
  const span = maxX - minX;
  const count = Math.max(2, Math.round(span / RISER_SEGMENT));
  const rng = makeRng(seed);
  const segments = [];
  for (let index = 0; index < count; index++) {
    const x0 = minX + span * index / count;
    const x1 = minX + span * (index + 1) / count;
    segments.push({
      x0: round(x0), x1: round(x1), z: round(z),
      // 상단 요철: 막돌마다 조금씩 낮게 물린다. 0 이면 정연한 켜쌓기로 읽힌다.
      topY: round(topY - rng() * RISER_TOP_DROP),
    });
  }
  return segments;
}

/**
 * 단의 동·서 마구리 석축.
 *
 * 남쪽 면만 쌓으면 부감에서 단 상면이 **측면 없는 종이 판**으로 읽힌다(2026-08-05 실측
 * 렌더 r7-temple-oblique 에서 확인). 마하연 사진의 축대도 마당 앞면만이 아니라 옆구리까지
 * 막돌로 마감된 단 덩어리다. z 방향으로 같은 켜 폭으로 쪼개고 상단 요철을 준다.
 */
function flankSegments(x, northZ, southZ, topY, seed, inward) {
  const span = southZ - northZ;
  const count = Math.max(2, Math.round(span / RISER_SEGMENT));
  const rng = makeRng(seed);
  const segments = [];
  for (let index = 0; index < count; index++) {
    const z0 = northZ + span * index / count;
    const z1 = northZ + span * (index + 1) / count;
    segments.push({
      z0: round(z0), z1: round(z1), x: round(x),
      inward,
      topY: round(topY - rng() * RISER_TOP_DROP),
    });
  }
  return segments;
}

/**
 * Derive the pure terrace record from an assembled TemplePlan.
 * Does not mutate; `applyTempleTerraces()` writes the result onto the plan.
 *
 * `flat` 프로파일은 단을 만들지 않는다(단일 단, 석축 0). 평지 가람의 진입 계약은
 * `entry-sequence.js` 의 `single-run` 계단이며, 거기에 단차를 얹으면 두 문법이 충돌한다.
 */
export function templeTerracePlan(plan) {
  if (!plan || typeof plan !== 'object') {
    throw new TypeError('TemplePlan is required for terraces');
  }
  const variant = plan.variant;
  if (!Object.hasOwn(TIER_RISE, variant)) {
    throw new RangeError(`unsupported temple terrace variant: ${variant}`);
  }
  const profile = plan.entrySequence?.profile ?? plan.settings?.entryProfile ?? 'flat';
  const bounds = plan.bounds || {
    minX: -plan.width / 2, maxX: plan.width / 2,
    minZ: -plan.depth / 2, maxZ: plan.depth / 2,
  };
  const rows = buildingRows(plan.buildings || []);
  const rise = profile === 'mountain' ? TIER_RISE[variant] : 0;
  const tierCount = profile === 'mountain'
    ? Math.max(1, Math.min(MAX_TIERS[variant], rows.length))
    : 1;
  // 단 스택의 기준면은 진입 에이프런이 끌어올린 예불 마당 높이다. 에이프런은 일곽
  // 밖에서 지형을 오르고, 단은 그 위에서 이어 오른다 — 두 문법이 같은 datum 을 쓰지
  // 않으면 에이프런이 1.15m 올린 뒤 마당이 0 으로 떨어진다.
  const worship = plan.courtyards?.find((court) => court.role === 'worship');
  const base = round(Number.isFinite(worship?.elevation) ? worship.elevation : 0);

  if (tierCount < 2 || !rows.length) {
    const polygon = rect(
      bounds.minX + 0.6, bounds.maxX - 0.6, bounds.minZ + 0.6, bounds.maxZ - 0.6,
    );
    return {
      schemaVersion: TEMPLE_TERRACE_SCHEMA_VERSION,
      profile, rise: 0, base, tierCount: 1,
      tiers: [{
        id: 'terrace-0', level: 0, elevation: base,
        northZ: round(bounds.minZ + 0.6), southZ: round(bounds.maxZ - 0.6),
        minX: round(bounds.minX + 0.6), maxX: round(bounds.maxX - 0.6),
        polygon, buildingIds: rows.flatMap((row) => row.members.map((item) => item.building.id)),
      }],
      risers: [],
    };
  }

  // 북쪽 행이 높은 단. 행 수가 단 수보다 많으면 균등 분할한다.
  const levelOfRow = rows.map((_, index) =>
    tierCount - 1 - Math.floor(index * tierCount / rows.length));
  const groups = [];
  for (let level = tierCount - 1; level >= 0; level--) {
    const members = rows.filter((_, index) => levelOfRow[index] === level);
    groups.push({ level, rows: members });
  }

  // 단 경계는 행 사이 빈틈의 중점이다. 전각을 자르지 않고, 석축이 처마 밑으로
  // 파고들지도 않는다.
  const southEdgeOf = (groupIndex) => {
    const current = groups[groupIndex];
    const next = groups[groupIndex + 1];
    const currentSouth = Math.max(...current.rows.map((row) => row.southZ));
    if (!next) return round(Math.min(bounds.maxZ - 0.6, currentSouth + TIER_MARGIN));
    const nextNorth = Math.min(...next.rows.map((row) => row.northZ));
    return round((currentSouth + nextNorth) / 2);
  };

  // 단 상면은 그 단의 전각뿐 아니라 마당 폭까지 덮어야 한다. 전각 윤곽만 쓰면
  // 하단이 자기 채 밑에만 깔린 좁은 벤치가 되어 연속한 단으로 읽히지 않는다.
  const courtPolygon = worship?.polygon?.length ? worship.polygon : null;
  const courtMinX = courtPolygon ? Math.min(...courtPolygon.map((corner) => corner.x)) : Infinity;
  const courtMaxX = courtPolygon ? Math.max(...courtPolygon.map((corner) => corner.x)) : -Infinity;

  const tiers = [];
  const risers = [];
  for (let index = 0; index < groups.length; index++) {
    const group = groups[index];
    const rowsOf = group.rows;
    const northZ = index === 0
      ? round(Math.max(bounds.minZ + 0.6,
        Math.min(...rowsOf.map((row) => row.northZ)) - TIER_MARGIN))
      : tiers[index - 1].southZ;
    const southZ = southEdgeOf(index);
    // 아래 단은 위 단보다 좁을 수 없다 — 내리막이므로 위 단을 받쳐야 하고, 좁으면
    // 석축이 받칠 것 없는 허공에 걸린다.
    const above = tiers[index - 1];
    const minX = round(Math.max(bounds.minX + 0.6, Math.min(
      Math.min(...rowsOf.map((row) => row.minX)) - TIER_MARGIN,
      courtMinX, above ? above.minX : Infinity,
    )));
    const maxX = round(Math.min(bounds.maxX - 0.6, Math.max(
      Math.max(...rowsOf.map((row) => row.maxX)) + TIER_MARGIN,
      courtMaxX, above ? above.maxX : -Infinity,
    )));
    const elevation = round(base + group.level * rise);
    tiers.push({
      id: `terrace-${group.level}`,
      level: group.level,
      elevation,
      northZ, southZ, minX, maxX,
      polygon: rect(minX, maxX, northZ, southZ),
      buildingIds: rowsOf.flatMap((row) => row.members.map((item) => item.building.id)),
    });
  }

  // 석축은 단의 남쪽 면이다(북쪽 면은 산에 묻힌다). 최하단은 받칠 것이 없으므로 없다.
  for (const tier of tiers) {
    if (tier.level === 0) continue;
    const axisX = Number.isFinite(plan.axis?.offsetX) ? plan.axis.offsetX : 0;
    const rng = makeRng((plan.seed ^ 0x7e44a1 ^ (tier.level * 0x9e37)) >>> 0);
    // 계단 편심: 사진의 손으로 놓은 계단 인상. 결정론 rng 로 방향·양을 고정한다.
    const offset = round((rng() * 2 - 1) * STAIR_MAX_OFFSET);
    const stairX = round(Math.min(
      tier.maxX - STAIR_WIDTH / 2 - 0.4,
      Math.max(tier.minX + STAIR_WIDTH / 2 + 0.4, axisX + offset),
    ));
    risers.push({
      id: `terrace-riser-${tier.level}`,
      level: tier.level,
      // 아래 단의 상면에서 이 단의 상면까지.
      baseElevation: round(tier.elevation - rise),
      topElevation: tier.elevation,
      rise: round(rise),
      z: tier.southZ,
      minX: tier.minX,
      maxX: tier.maxX,
      segments: riserSegments(tier.minX, tier.maxX, tier.southZ, tier.elevation,
        (plan.seed ^ 0x51b3 ^ (tier.level * 0x2f19)) >>> 0),
      // 마구리: 서(inward +1) · 동(inward -1). 단 상면이 덩어리로 읽히게 한다.
      flanks: [
        flankSegments(tier.minX, tier.northZ, tier.southZ, tier.elevation,
          (plan.seed ^ 0x2c81 ^ (tier.level * 0x4d0b)) >>> 0, 1),
        flankSegments(tier.maxX, tier.northZ, tier.southZ, tier.elevation,
          (plan.seed ^ 0x63f5 ^ (tier.level * 0x4d0b)) >>> 0, -1),
      ],
      stair: {
        id: `terrace-stair-${tier.level}`,
        x: stairX,
        z: tier.southZ,
        width: STAIR_WIDTH,
        run: STAIR_RUN,
        offsetFromAxis: round(stairX - axisX),
        steps: Math.max(2, Math.round(rise / 0.18)),
      },
    });
  }

  return {
    schemaVersion: TEMPLE_TERRACE_SCHEMA_VERSION,
    profile,
    rise: round(rise),
    base,
    tierCount,
    tiers,
    risers,
  };
}

function tierForZ(terraces, z) {
  let best = terraces.tiers[terraces.tiers.length - 1];
  for (const tier of terraces.tiers) {
    if (z >= tier.northZ && z <= tier.southZ) return tier;
    if (z < tier.northZ) return tier;
    best = tier;
  }
  return best;
}

/**
 * 단 상면 위에 놓이는 것(문·프롭·답도)의 높이. 단 스택 **밖**(남쪽 진입 에이프런)은
 * null 을 돌려준다 — 그쪽 높이는 진입 시퀀스와 지형 pad 가 소유한다.
 */
export function templeTierAtZ(terraces, z) {
  for (const tier of terraces?.tiers || []) {
    if (z >= tier.northZ - 1e-6 && z <= tier.southZ + 1e-6) return tier;
  }
  return null;
}

/**
 * Write terraces onto the plan: `plan.terraces` plus each building's
 * `terraceLevel`/`elevation`. Mutates `plan` and returns it.
 *
 * 반드시 `applyTempleEntrySequence()` **뒤에** 불러야 한다 — 누하 전각은 그때 추가되고,
 * 그 전각도 단을 배정받아야 한다.
 *
 * 마당 레코드(`plan.courtyards`)의 elevation 은 건드리지 않는다. 마당 폴리곤은 여러 단을
 * 가로지르므로 단일 높이를 갖는 것이 애초에 성립하지 않고, 그 높이는 진입 에이프런이
 * 소유한다. 단이 둘 이상이면 마당 **바닥**은 단 상면이 그린다(compound.js).
 */
export function applyTempleTerraces(plan) {
  const terraces = templeTerracePlan(plan);
  plan.terraces = terraces;
  const levelById = new Map();
  for (const tier of terraces.tiers) {
    for (const id of tier.buildingIds) levelById.set(id, tier);
  }
  for (const building of plan.buildings || []) {
    const tier = levelById.get(building.id) || tierForZ(terraces, building.position.z);
    building.terraceLevel = tier.level;
    building.elevation = tier.elevation;
  }
  // 단 위에 앉는 것들도 같은 기록에서 높이를 받는다. 이것을 렌더러가 다시 유도하면
  // 프롭이 단 상면 아래로 잠기고(석탑·석등) 답도가 석축을 관통한다.
  for (const gate of plan.gates || []) {
    gate.elevation = round(templeTierAtZ(terraces, gate.position.z)?.elevation ?? 0);
  }
  for (const item of plan.props || []) {
    item.elevation = round(templeTierAtZ(terraces, item.position.z)?.elevation ?? 0);
  }
  for (const path of plan.paths || []) {
    path.elevations = (path.points || []).map((corner) =>
      round(templeTierAtZ(terraces, corner.z)?.elevation ?? 0));
  }
  applyPrecinctWallReinterpretation(plan, terraces);
  return plan;
}

/**
 * 일곽 담의 재해석 (실측 갭 ③, docs/temple-generator.md §9).
 *
 * 사료 사진의 산사는 담이 한 겹 회랑으로 일곽을 돌지 않는다 — 높이가 다른 막돌 석축
 * 단이 느슨하게 감싸고, 담은 진입부에만 남는다. 균일한 사각 `precinct-wall` 을 단과
 * 함께 그대로 두면 두 가지가 동시에 깨진다:
 *   (a) 상단 단(extended 3.05m)이 담 높이(2.05m)를 넘어 담이 지면에 묻힌다.
 *   (b) 정연한 사각 회랑이 남아 "소규모 궁"으로 읽힌다.
 * 그래서 단이 둘 이상이면 외곽 담을 **진입부를 감싸는 열린 담 run** 으로 바꾸고,
 * 단 스택의 남단부터 위쪽은 석축이 경계를 맡는다. 남문은 그 run 의 남쪽 변에 남는다.
 */
function applyPrecinctWallReinterpretation(plan, terraces) {
  if (terraces.tierCount < 2) return;
  const outer = plan.enclosures?.find((enclosure) => enclosure.role === 'precinct-wall');
  if (!outer?.polygon?.length) return;
  const xs = outer.polygon.map((corner) => corner.x);
  const zs = outer.polygon.map((corner) => corner.z);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const southZ = Math.max(...zs);
  const stackSouth = terraces.tiers[terraces.tiers.length - 1].southZ;
  const topElevation = terraces.tiers[0].elevation;
  // 담을 여는 조건은 두 개이고, 둘 다 물리적이다.
  //   ① 담이 실제로 묻힐 때만 연다. 최상단 단이 담 높이에 못 미치면 폐곡선 담이
  //      그대로 성립한다 — compact 암자(단 1.02m vs 담 1.75m)가 그 경우이고,
  //      마하연 사진의 석축 위 담장도 그렇게 읽힌다.
  //   ② 열린 run 이 감쌀 진입부가 남아 있어야 한다. 단 스택이 남문까지 내려오면
  //      run 의 날개가 생기지 않아 담이 남변 한 조각으로 떠 버린다.
  if (topElevation <= outer.height - 0.5) return;
  if (southZ - stackSouth < 4) return;
  outer.polygon = [
    point(maxX, stackSouth), point(maxX, southZ),
    point(minX, southZ), point(minX, stackSouth),
  ];
  outer.closed = false;
  // 열린 run 의 세그먼트: 0=동측 날개, 1=남변(남문), 2=서측 날개.
  outer.gateSeg = 1;
}

/** Renderer-free semantic safety for the terrace record. */
export function templeTerraceIssues(plan) {
  const issues = [];
  const terraces = plan?.terraces;
  if (!terraces) {
    issues.push('terraces missing');
    return issues;
  }
  if (terraces.schemaVersion !== TEMPLE_TERRACE_SCHEMA_VERSION) {
    issues.push(`terrace schema ${terraces.schemaVersion} unsupported`);
  }
  const tiers = Array.isArray(terraces.tiers) ? terraces.tiers : [];
  if (!tiers.length) issues.push('terrace tiers missing');
  // 단은 남 → 북으로 단조 상승하고 z 대역이 겹치지 않는다.
  for (let index = 1; index < tiers.length; index++) {
    const previous = tiers[index - 1];
    const current = tiers[index];
    if (current.level >= previous.level) {
      issues.push(`${current.id}: tier level is not descending southward`);
    }
    if (current.elevation > previous.elevation - (terraces.rise > 0 ? 1e-6 : -1e-6)) {
      issues.push(`${current.id}: tier elevation does not step down southward`);
    }
    if (current.northZ < previous.southZ - 1e-6) {
      issues.push(`${current.id}: tier z band overlaps ${previous.id}`);
    }
  }
  if (terraces.rise > 0) {
    const main = plan.buildings?.find((building) => building.role === 'main-hall');
    const top = tiers[0];
    if (main && main.terraceLevel !== top?.level) {
      issues.push('main-hall is not on the highest terrace');
    }
    // 석축은 최하단을 제외한 모든 단에 하나씩.
    const expected = tiers.filter((tier) => tier.level > 0).length;
    if ((terraces.risers?.length || 0) !== expected) {
      issues.push(`terrace risers ${terraces.risers?.length || 0} != ${expected}`);
    }
    for (const riser of terraces.risers || []) {
      if (!Array.isArray(riser.segments) || riser.segments.length < 2) {
        issues.push(`${riser.id}: rubble segments missing`);
      }
      const tops = new Set((riser.segments || []).map((segment) => segment.topY));
      if (tops.size < 2) {
        issues.push(`${riser.id}: rubble top line is regular coursing`);
      }
      for (const segment of riser.segments || []) {
        if (segment.topY > riser.topElevation + 1e-6
          || segment.topY < riser.topElevation - RISER_TOP_DROP - 1e-6) {
          issues.push(`${riser.id}: rubble top leaves the retained envelope`);
        }
      }
      if (!riser.stair || riser.stair.width <= 0) {
        issues.push(`${riser.id}: terrace stair missing`);
      } else if (Math.abs(riser.stair.offsetFromAxis) > STAIR_MAX_OFFSET + 1e-6) {
        issues.push(`${riser.id}: terrace stair left the processional axis band`);
      }
    }
  } else if ((terraces.risers?.length || 0) !== 0) {
    issues.push('flat precinct must not carry retaining risers');
  }
  return issues;
}

export const TEMPLE_TERRACE_DEFAULTS = Object.freeze({
  tierRise: TIER_RISE,
  maxTiers: MAX_TIERS,
  riserSegment: RISER_SEGMENT,
  riserTopDrop: RISER_TOP_DROP,
  tierMargin: TIER_MARGIN,
  stairWidth: STAIR_WIDTH,
  stairRun: STAIR_RUN,
  stairMaxOffset: STAIR_MAX_OFFSET,
});
