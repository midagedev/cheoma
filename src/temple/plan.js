import { makeRng } from '../rng.js';
import {
  applyTempleEntrySequence,
  planTempleEntrySequence,
  templeBuildingIsOpenPassUnder,
  templeEntrySequenceIssues,
} from './entry-sequence.js';
import { applyTempleTerraces, templeTerraceIssues } from './terrace-plan.js';
import { computeLayout } from '../params.js';
import {
  templeHallBuilderPreset,
  templeHallEaveFootprint,
  templeRoleArchitecture,
  templeUpperStoreySpec,
} from './role-hierarchy.js';

// 가람 밀집 간격 (2026-08-05, refs/temple-old 대조 라운드).
// 사료 사진(장안사 1930 사선 부감, 정양사 1930 눈높이)에서 전각들은 지붕이 거의 맞닿을
// 만큼 붙어 용마루 방향이 채마다 달라 지붕면이 조각보로 얽힌다. 종전 배치는 일곽 폭·깊이
// 비율로 전각을 흩어 놓아 최근접 처마 간격 median 11.13m(extended)·6.81m(courtyard),
// 처마합이 일곽의 12%뿐이었다 — 마당이 화면 절반을 먹고 소규모 궁으로 읽힌 원인이다.
// 이 값은 처마 사이 실간격이며 templePlanIssues 의 0.45m 겹침 한계보다 크게 잡는다.
const CLUSTER_GAP = 1.6;
// 주불전 북단이 일곽 담과 두는 여유. 담 두께 0.46 + 시공 여유.
const CLUSTER_NORTH_MARGIN = 3.3;

// Framework- and renderer-free Korean temple compound planner.
// Local coordinates follow the repository convention: +z is south/entrance,
// -z is north/backdrop. Every renderer and village adapter consumes this data;
// none of them may infer a second layout from the variant name.

export const TEMPLE_VARIANTS = Object.freeze(['compact', 'courtyard', 'extended']);
export const TEMPLE_PLAN_SCHEMA_VERSION = 2;

export const TEMPLE_VARIANT_SPECS = Object.freeze({
  compact: Object.freeze({ min: 22, max: 30, width: 26, depth: 28, minHalls: 1, maxHalls: 2 }),
  courtyard: Object.freeze({ min: 36, max: 48, width: 42, depth: 46, minHalls: 3, maxHalls: 4 }),
  extended: Object.freeze({ min: 52, max: 72, width: 64, depth: 68, minHalls: 5, maxHalls: 7 }),
});

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const finite = (value, fallback) => Number.isFinite(value) ? value : fallback;
const round = (value, digits = 3) => {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
};
const point = (x, z) => ({ x: round(x), z: round(z) });
const rect = (cx, cz, width, depth) => [
  point(cx - width / 2, cz + depth / 2),
  point(cx + width / 2, cz + depth / 2),
  point(cx + width / 2, cz - depth / 2),
  point(cx - width / 2, cz - depth / 2),
];

// siteR 임계는 SCALE_ANCHORS 명명 tier 중점과 동기(solo·hamlet=compact,
// village·town=courtyard, capital·hanyang=extended).
export function templeVariantForSite(siteR) {
  if (siteR < 143) return 'compact';
  if (siteR < 260) return 'courtyard';
  return 'extended';
}

export function templeVariantsForSize(size) {
  const limit = finite(size, TEMPLE_VARIANT_SPECS.compact.max);
  return TEMPLE_VARIANTS.filter((variant) => TEMPLE_VARIANT_SPECS[variant].min <= limit);
}

export function templeCompoundDefaultsForSite(siteR, seed = 1) {
  const variant = templeVariantForSite(siteR);
  const spec = TEMPLE_VARIANT_SPECS[variant];
  let size;
  if (variant === 'compact') size = clamp(siteR * 0.30, spec.min, spec.max - 2);
  else if (variant === 'courtyard') size = clamp(38 + (siteR - 101) * 0.07, spec.min, spec.max);
  else size = clamp(56 + (siteR - 213) * 0.045, spec.min, spec.max);
  // Slightly rectangular precincts read as authored sites while the maximum
  // dimension remains the single reservation scalar used by legacy consumers.
  const rng = makeRng((seed ^ 0x12a7c0) >>> 0);
  const width = clamp(size * (0.92 + rng() * 0.05), spec.min, spec.max);
  const depth = clamp(size, spec.min, spec.max);
  return { variant, width: round(width), depth: round(depth) };
}

function withHallArchitecture(building, seed) {
  const architecture = templeRoleArchitecture(building.role, { seed, id: building.id });
  const eave = templeHallEaveFootprint({
    architecture,
    frontBays: building.frontBays,
    sideBays: building.sideBays,
    scale: building.scale,
    yaw: building.yaw,
    position: building.position,
  });
  return {
    ...building,
    formality: architecture.formality,
    architecturalRank: architecture.architecturalRank,
    architectureId: architecture.id,
    roofGrammar: architecture.roofGrammar,
    bracketGrammar: architecture.bracketGrammar,
    eaveGrammar: architecture.eaveGrammar,
    massingGrammar: architecture.massingGrammar,
    eaveFootprint: {
      localWidth: round(eave.localWidth),
      localDepth: round(eave.localDepth),
      width: round(eave.width),
      depth: round(eave.depth),
      polygon: eave.polygon.map((corner) => point(corner.x, corner.z)),
    },
    // Compatibility consumers use the already-oriented AABB. It is derived
    // from the same actual eave rectangle rather than a hand-authored plot box.
    footprint: { width: round(eave.width), depth: round(eave.depth) },
  };
}

function hall(id, role, x, z, {
  yaw = 0, frontBays = 3, sideBays = 2, scale = 0.8,
  seed = 1,
} = {}) {
  return withHallArchitecture({
    id,
    role,
    style: 'temple',
    position: point(x, z),
    yaw: round(yaw, 6),
    frontBays,
    sideBays,
    scale: round(scale),
  }, seed);
}

/**
 * Oriented eave extent of a hall that has not been placed yet.
 *
 * Layout must be derived from the real eave rectangle, never from hand-authored
 * coordinates: `templeRoleArchitecture` picks between the matbae and paljak
 * repertoire by `seed:id:role`, and those two differ by 1.9m of eave width on the
 * 5-bay main hall. Fixed coordinates therefore drift the gathered spacing by more
 * than the whole CLUSTER_GAP budget on half of all seeds.
 */
function hallExtent(role, id, seed, frontBays, sideBays, scale, yaw = 0) {
  const architecture = templeRoleArchitecture(role, { seed, id });
  const eave = templeHallEaveFootprint({ architecture, frontBays, sideBays, scale });
  const across = Math.abs(Math.sin(yaw)) > 0.5;
  return {
    w: across ? eave.localDepth : eave.localWidth,
    d: across ? eave.localWidth : eave.localDepth,
  };
}

/**
 * 대찰(extended)의 주불전만 중층(重層)으로 올린다.
 *
 * 사료 근거와 왜 repertoire 항목이 아닌지는 `role-hierarchy.js` 의 `TWO_STOREY_UPPER` 주석
 * 참조. 여기서 상층 제원과 **앉힘 높이까지 확정**하므로 렌더러는 layout 을 다시 풀어
 * 층고를 추론하지 않는다.
 *
 * `seatY` 는 하층과 같은 미축척 단위다(전각 그룹 전체에 `scale` 이 걸린다). 하층 지붕의
 * 낙차 `ridgeY − eaveInnerY` 에 `seatDropRatio` 를 곱한 만큼 용마루선 아래로 물려, 상층
 * 옆구리가 하층 지붕 곡면과 맞물리게 한다 — 용마루선에 그대로 얹으면 상층 밑에 빈틈이 보인다.
 */
function applyTwoStoreyPrincipal(plan) {
  if (plan.variant !== 'extended') return plan;
  const main = plan.buildings?.find((building) => building.role === 'main-hall');
  if (!main || main.upperStorey) return plan;
  const layout = computeLayout(templeHallBuilderPreset(main));
  const spec = templeUpperStoreySpec(main);
  const drop = Math.max(0, layout.ridgeY - layout.eaveInnerY) * spec.seatDropRatio;
  main.storeys = 2;
  main.upperStorey = {
    ...spec,
    seatY: round(layout.ridgeY - drop),
    // 검수·게이트가 관계를 재계산하지 않고 확인할 수 있게 유도 근거를 함께 남긴다.
    lowerRidgeY: round(layout.ridgeY),
    lowerEaveInnerY: round(layout.eaveInnerY),
  };
  return plan;
}

const PLAN_ARRAY_FIELDS = Object.freeze([
  'courtyards', 'enclosures', 'buildings', 'gates', 'props', 'paths',
]);

function assertPlanCollections(plan) {
  for (const field of PLAN_ARRAY_FIELDS) {
    if (!Array.isArray(plan[field])) throw new TypeError(`TemplePlan.${field} must be an array`);
  }
}

function completeHallArchitecture(building) {
  const finiteFields = (object, fields) => fields.every((field) => Number.isFinite(object?.[field]));
  return Number.isInteger(building?.architecturalRank)
    && typeof building.architectureId === 'string' && building.architectureId.length > 0
    && typeof building.formality === 'string' && building.formality.length > 0
    && typeof building.roofGrammar?.family === 'string'
    && typeof building.roofGrammar?.type === 'string'
    && finiteFields(building.roofGrammar, [
      'pitch', 'profileCurve', 'ridgeHeight', 'gableOverhang', 'cornerLift', 'planCurve',
    ])
    && typeof building.bracketGrammar?.family === 'string'
    && Number.isInteger(building.bracketGrammar?.tiers)
    && Number.isInteger(building.bracketGrammar?.interBrackets)
    && Number.isFinite(building.bracketGrammar?.scale)
    && typeof building.bracketGrammar?.density === 'string'
    && finiteFields(building.eaveGrammar, ['overhang', 'drop'])
    && Number.isInteger(building.eaveGrammar?.layers)
    && finiteFields(building.massingGrammar, ['columnHeight', 'podiumTierHeight'])
    && Number.isInteger(building.massingGrammar?.podiumTiers);
}

function expectedHallEave(building) {
  return templeHallEaveFootprint({
    architecture: {
      roofGrammar: building.roofGrammar,
      eaveGrammar: building.eaveGrammar,
    },
    frontBays: building.frontBays,
    sideBays: building.sideBays,
    scale: building.scale,
    yaw: building.yaw,
    position: building.position,
  });
}

function hallEaveMatches(building, tolerance = 0.002) {
  const polygon = building.eaveFootprint?.polygon;
  if (polygon?.length !== 4) return false;
  const expected = expectedHallEave(building);
  return expected.polygon.every((corner, index) => (
    Math.hypot(corner.x - polygon[index].x, corner.z - polygon[index].z) <= tolerance
  ))
    && Math.abs(expected.width - building.eaveFootprint.width) <= tolerance
    && Math.abs(expected.depth - building.eaveFootprint.depth) <= tolerance
    && Math.abs(expected.width - building.footprint?.width) <= tolerance
    && Math.abs(expected.depth - building.footprint?.depth) <= tolerance;
}

/**
 * Normalize the pure TemplePlan input boundary.
 *
 * Schema v1 did not own hall architecture. Its deterministic upgrade is the
 * only compatibility layer allowed to recover grammar from a role; renderers
 * and all v2 consumers receive the complete plan-owned grammar.
 */
export function normalizeTemplePlan(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    throw new TypeError('TemplePlan must be an object');
  }
  if (!Number.isInteger(plan.schemaVersion)) {
    throw new TypeError('TemplePlan.schemaVersion is required');
  }
  if (!Number.isInteger(plan.seed) || plan.seed < 0 || plan.seed > 0xffffffff) {
    throw new TypeError('TemplePlan.seed must be an unsigned 32-bit integer');
  }
  if (plan.schemaVersion !== 1 && plan.schemaVersion !== TEMPLE_PLAN_SCHEMA_VERSION) {
    throw new RangeError(
      `unsupported TemplePlan schemaVersion ${plan.schemaVersion}; expected 1 or ${TEMPLE_PLAN_SCHEMA_VERSION}`,
    );
  }
  assertPlanCollections(plan);
  if (plan.schemaVersion === 1) {
    return normalizeTemplePlan({
      ...plan,
      schemaVersion: TEMPLE_PLAN_SCHEMA_VERSION,
      buildings: plan.buildings.map((building) => withHallArchitecture({ ...building }, plan.seed)),
    });
  }
  for (const building of plan.buildings) {
    if (!completeHallArchitecture(building)) {
      throw new TypeError(`TemplePlan v2 building ${building?.id || '<unknown>'} has incomplete architecture`);
    }
    if (!hallEaveMatches(building)) {
      throw new TypeError(`TemplePlan v2 building ${building.id} has a stale eave footprint`);
    }
  }
  // Entry sequence is plan-owned. Recover it on the same object so v2 stays an
  // identity pass when already complete, and older pure payloads still gain the
  // gate | stair-apron | pass-under | court contract without a schema bump.
  if (!plan.entrySequence) {
    applyTempleEntrySequence(plan, { profile: plan.settings?.entryProfile });
  }
  applyTwoStoreyPrincipal(plan);
  // 단 기록도 같은 방식으로 회복한다 — 완비된 v2 는 그대로 통과(identity)하고, 이전
  // 순수 페이로드는 스키마 범프 없이 단·석축 계약을 얻는다.
  if (!plan.terraces) applyTempleTerraces(plan);
  return plan;
}

function prop(id, role, kind, x, z, {
  yaw = 0, scale = 1, radius = 0.8, heightClass = 'low', stories,
} = {}) {
  return {
    id, role, kind, position: point(x, z), yaw: round(yaw, 6),
    scale: round(scale), radius: round(radius), heightClass,
    ...(stories ? { stories } : {}),
  };
}

function commonPlan(seed, variant, width, depth, settings) {
  const halfW = width / 2, halfD = depth / 2;
  return {
    schemaVersion: TEMPLE_PLAN_SCHEMA_VERSION,
    seed,
    variant,
    width: round(width),
    depth: round(depth),
    axis: { front: point(0, 1), bend: round(settings.axisBend), offsetX: 0 },
    boundary: rect(0, 0, width, depth),
    courtyards: [],
    enclosures: [{
      id: 'outer-precinct', role: 'precinct-wall', polygon: rect(0, 0, width, depth),
      height: variant === 'compact' ? 1.75 : 2.05,
      gateId: 'south-gate',
    }],
    buildings: [],
    gates: [{
      id: 'south-gate', role: 'entry-gate', type: variant === 'compact' ? 'iljakmun' : 'soseuldaemun',
      position: point(0, halfD), yaw: 0, width: variant === 'compact' ? 2.2 : 3.0,
    }],
    props: [],
    paths: [],
    solarAccess: null,
    settings,
    bounds: { minX: round(-halfW), maxX: round(halfW), minZ: round(-halfD), maxZ: round(halfD) },
  };
}

function planCompact(plan) {
  const { width, depth, settings, seed } = plan;
  const minZ = -depth / 2;
  const main = hallExtent('main-hall', 'main-hall', seed, 3, 2, 0.82);
  const yosa = hallExtent('yosa', 'west-yosa', seed, 3, 2, 0.66, -Math.PI / 2);

  // 암자도 같은 밀집 문법을 쓴다. 종전에는 요사를 `-width * 0.35` 에 두어 30m 일곽에서
  // 처마 간격이 3.12m 로 벌어졌다(마하연 사진은 큰 전각 하나에 부속이 붙어 있다).
  const mainZ = round(minZ + CLUSTER_NORTH_MARGIN + main.d / 2);
  const mainSouth = mainZ + main.d / 2;
  const westFace = -main.w / 2 - CLUSTER_GAP;
  const yosaZ = round(mainSouth + CLUSTER_GAP + yosa.d / 2);
  const courtSouthZ = round(Math.min(depth / 2 - 2.4, yosaZ + yosa.d / 2 + 1.9));

  plan.courtyards.push({
    id: 'worship-court', role: 'worship',
    polygon: rect(
      (westFace + main.w / 2) / 2, (mainSouth + courtSouthZ) / 2,
      round((main.w / 2 - westFace) * clamp(settings.courtScale, 0.9, 1.1)),
      round(courtSouthZ - mainSouth),
    ),
    level: 0,
  });
  const candidates = [
    hall('main-hall', 'main-hall', 0, mainZ, {
      frontBays: 3, sideBays: 2, scale: 0.82, seed,
    }),
    hall('west-yosa', 'yosa', round(westFace - yosa.w / 2), yosaZ, {
      yaw: -Math.PI / 2, frontBays: 3, sideBays: 2, scale: 0.66, seed,
    }),
  ];
  plan.buildings = candidates.slice(0, settings.hallCount);
  if (settings.stoneLanterns > 0) {
    plan.props.push(prop('main-lantern', 'worship-lantern', 'stone-lantern',
      2.1, round(mainSouth + 2.4), { scale: 0.92, radius: 0.55 }));
  }
  plan.paths.push({
    id: 'entry-path', role: 'entry', width: 1.35,
    points: [point(0, depth / 2 - 0.8), point(0, round(mainSouth + 1.4))],
  });
  plan.solarAccess = {
    role: 'main-hall', origin: point(0, round(mainSouth + 0.6)),
    halfWidth: round(main.w / 2), southZ: round(depth / 2),
  };
}

function pagodaMode(settings, variant, seed) {
  if (settings.pagoda !== 'auto') return settings.pagoda;
  if (variant === 'compact') return 'none';
  if (variant === 'extended') return 'pair';
  return ((seed ^ 0x70a9) & 1) ? 'pair' : 'single';
}

/**
 * Lateral offset for a paired 석탑 inside a gathered court.
 *
 * The court is only `main.w + 2 * CLUSTER_GAP` wide once the halls close around
 * it, so the pair has to stay clear of both the 요사/선방 eaves and the court edge.
 */
function pagodaSpread(mainWidth) {
  return round(Math.min(mainWidth * 0.34, mainWidth / 2 + CLUSTER_GAP - 1.95));
}

function addCourtProps(plan, mainSouth, axisX, spread) {
  const mode = pagodaMode(plan.settings, plan.variant, plan.seed);
  const court = plan.courtyards.find((candidate) => candidate.role === 'worship');
  const courtSouth = court ? Math.max(...court.polygon.map((corner) => corner.z)) : mainSouth + 12;
  // 석탑은 예불축 위 마당 앞쪽(주불전 정면)에 선다 — 탑–금당 정형.
  const propZ = round(mainSouth + (courtSouth - mainSouth) * 0.42);
  if (mode === 'single') {
    plan.props.push(prop('central-pagoda', 'worship-pagoda', 'pagoda', axisX, propZ, {
      scale: plan.variant === 'extended' ? 1.05 : 0.92, radius: 1.35, heightClass: 'tall', stories: 3,
    }));
  } else if (mode === 'pair') {
    for (const side of [-1, 1]) {
      plan.props.push(prop(`pagoda-${side < 0 ? 'west' : 'east'}`, 'worship-pagoda', 'pagoda', round(axisX + side * spread), propZ, {
        scale: plan.variant === 'extended' ? 1.02 : 0.88,
        radius: 1.3, heightClass: 'tall', stories: 3,
      }));
    }
  }
  const lanternCount = plan.settings.stoneLanterns;
  for (let index = 0; index < lanternCount; index++) {
    const side = lanternCount === 1 ? 1 : (index ? 1 : -1);
    plan.props.push(prop(
      lanternCount === 1 ? 'main-lantern' : `main-lantern-${side < 0 ? 'west' : 'east'}`,
      'worship-lantern', 'stone-lantern', round(axisX + side * 2.4), round(mainSouth + 2.4),
      { scale: 1, radius: 0.55 },
    ));
  }
}

/**
 * `templePassUnderPlacement()` seats the 누문 `min(4.2, span * 0.18)` north of the
 * worship court's south edge. The gathered layout wants the pavilion flush with
 * the 강당·종각 line instead, so solve that relation backwards for the court edge
 * rather than duplicating the processional grammar here.
 */
function courtSouthForPassUnder(targetZ, northZ) {
  const wide = targetZ + 4.2;
  if ((wide - northZ) * 0.18 >= 4.2) return wide;
  return (targetZ - 0.18 * northZ) / 0.82;
}

function planCourtyard(plan) {
  const { width, depth, settings, seed } = plan;
  const axisX = round(settings.axisBend * width * 0.035);
  plan.axis.offsetX = axisX;
  const minZ = -depth / 2;

  const main = hallExtent('main-hall', 'main-hall', seed, 3, 3, 0.9);
  const yosa = hallExtent('yosa', 'west-yosa', seed, 3, 2, 0.72, -Math.PI / 2);
  const seonbang = hallExtent('seonbang', 'east-seonbang', seed, 3, 2, 0.72, Math.PI / 2);
  const bell = hallExtent('bell-pavilion', 'bell-pavilion', seed, 3, 2, 0.62, Math.PI / 2);

  // 주불전은 가람의 정점이므로 최북단·(mountain 이면) 최고단에 앉는다.
  const mainZ = round(minZ + CLUSTER_NORTH_MARGIN + main.d / 2);
  const mainSouth = mainZ + main.d / 2;
  const westFace = axisX - main.w / 2 - CLUSTER_GAP;
  const eastFace = axisX + main.w / 2 + CLUSTER_GAP;

  // 요사·선방이 마당의 동·서 변을 이룬다. yaw ±90° 라 용마루가 주불전과 직교해
  // 사료 사진의 조각보 지붕 읽기를 만든다.
  const yosaZ = round(mainSouth + CLUSTER_GAP + yosa.d / 2);
  const seonbangZ = round(mainSouth + CLUSTER_GAP + seonbang.d / 2);
  const bellZ = round(seonbangZ + seonbang.d / 2 + CLUSTER_GAP + bell.d / 2);

  const courtNorthZ = round(mainSouth);
  // 누문 줄은 요사·선방 줄 바로 남쪽이다. 종각(측방으로 물러난 채)에서 유도하면 36m
  // 최소 일곽에서 마당 남단이 남문 z 를 넘어가 진입 순서 단언까지 깨진다.
  const passUnder = hallExtent('gate-pavilion', 'entry-pavilion', seed, 3, 2, 0.62);
  const southRowZ = round(Math.max(yosaZ + yosa.d / 2, seonbangZ + seonbang.d / 2)
    + CLUSTER_GAP + passUnder.d / 2);
  const courtSouthZ = round(courtSouthForPassUnder(southRowZ, courtNorthZ));
  // courtScale 은 마당의 폭만 조절한다. 깊이는 누문 위치를 결정하므로 진입 문법이
  // 사용자 파라미터로 흔들리지 않게 군집에서 그대로 유도한다.
  const courtWidth = round((eastFace - westFace) * clamp(settings.courtScale, 0.9, 1.1));
  plan.courtyards.push({
    id: 'worship-court', role: 'worship',
    polygon: rect((westFace + eastFace) / 2, (courtNorthZ + courtSouthZ) / 2,
      courtWidth, courtSouthZ - courtNorthZ),
    level: 0,
  });

  const candidates = [
    hall('main-hall', 'main-hall', axisX, mainZ, {
      frontBays: 3, sideBays: 3, scale: 0.9, seed,
    }),
    hall('west-yosa', 'yosa', round(westFace - yosa.w / 2), yosaZ, {
      yaw: -Math.PI / 2, scale: 0.72, seed,
    }),
    hall('east-seonbang', 'seonbang', round(eastFace + seonbang.w / 2), seonbangZ, {
      yaw: Math.PI / 2, scale: 0.72, seed,
    }),
    hall('bell-pavilion', 'bell-pavilion', round(eastFace + bell.w / 2), bellZ, {
      yaw: Math.PI / 2, frontBays: 3, sideBays: 2, scale: 0.62, seed,
    }),
  ];
  plan.buildings = candidates.slice(0, settings.hallCount)
    .filter((building) => building.role !== 'bell-pavilion' || settings.includeBellPavilion);
  addCourtProps(plan, mainSouth, axisX, pagodaSpread(main.w));
  if (settings.includeDanggan) {
    plan.props.push(prop('entry-danggan', 'entry-marker', 'danggan', axisX - 8.2, depth / 2 - 6.2, {
      scale: 0.92, radius: 0.9, heightClass: 'tall',
    }));
  }
  plan.paths.push({
    id: 'entry-path', role: 'entry', width: 1.5,
    points: [point(0, depth / 2 - 1), point(axisX * 0.45, courtSouthZ), point(axisX, mainSouth + 1.4)],
  });
  plan.solarAccess = {
    role: 'main-hall', origin: point(axisX, round(mainSouth + 0.6)),
    halfWidth: round(main.w / 2), southZ: round(depth / 2),
  };
}

function planExtended(plan) {
  const { width, depth, settings, seed } = plan;
  const axisX = round(settings.axisBend * width * 0.055);
  plan.axis.offsetX = axisX;
  const minZ = -depth / 2;

  const main = hallExtent('main-hall', 'main-hall', seed, 5, 3, 0.9);
  const westSub = hallExtent('subsidiary-hall', 'west-subsidiary', seed, 3, 2, 0.78);
  const eastSub = hallExtent('subsidiary-hall', 'east-subsidiary', seed, 3, 2, 0.78);
  const yosa = hallExtent('yosa', 'west-yosa', seed, 3, 2, 0.72, -Math.PI / 2);
  const seonbang = hallExtent('seonbang', 'east-seonbang', seed, 3, 2, 0.72, Math.PI / 2);
  const lecture = hallExtent('lecture-hall', 'lecture-hall', seed, 3, 2, 0.68, -Math.PI / 2);
  const bell = hallExtent('bell-pavilion', 'bell-pavilion', seed, 3, 2, 0.68, Math.PI / 2);

  const mainZ = round(minZ + CLUSTER_NORTH_MARGIN + main.d / 2);
  const mainSouth = mainZ + main.d / 2;
  const westFace = axisX - main.w / 2 - CLUSTER_GAP;
  const eastFace = axisX + main.w / 2 + CLUSTER_GAP;

  // 좌우 보전은 주불전과 용마루가 나란하되 z 를 남으로 물려 지붕면이 어긋나게 겹친다.
  // 정면에서 한 줄로 정렬되면 사료 사진의 조각보 읽기가 사라진다.
  const subZ = round(mainZ + Math.min(2.4, main.d * 0.24));
  const westSubSouth = subZ + westSub.d / 2;
  const eastSubSouth = subZ + eastSub.d / 2;

  // 요사·선방·강당·종각은 yaw ±90° 로 마당의 동·서 변을 이룬다(용마루 직교).
  const yosaZ = round(westSubSouth + CLUSTER_GAP + yosa.d / 2);
  const seonbangZ = round(eastSubSouth + CLUSTER_GAP + seonbang.d / 2);
  const lectureZ = round(yosaZ + yosa.d / 2 + CLUSTER_GAP + lecture.d / 2);
  const bellZ = round(seonbangZ + seonbang.d / 2 + CLUSTER_GAP + bell.d / 2);

  const courtNorthZ = round(mainSouth);
  // 누문은 강당·종각과 같은 줄(요사·선방 남쪽)에 앉아 마당의 남변을 닫는다
  // — 보제루 곁에 종각이 놓이는 배치(docs/temple-generator.md §2.1).
  const passUnder = hallExtent('gate-pavilion', 'entry-pavilion', seed, 3, 2, 0.62);
  const southRowZ = round(Math.max(yosaZ + yosa.d / 2, seonbangZ + seonbang.d / 2)
    + CLUSTER_GAP + passUnder.d / 2);
  const courtSouthZ = round(courtSouthForPassUnder(southRowZ, courtNorthZ));
  const courtWidth = round((eastFace - westFace) * clamp(settings.courtScale, 0.9, 1.1));

  // 일곽 내부 담은 군집 실측 윤곽을 감싼다. 종전처럼 depth 비율로 잡으면 밀집 군집의
  // 강당·종각과 누문을 담선이 관통한다. 남변은 가장 남쪽 전각(강당 또는 종각)보다
  // 더 남쪽이어야 하고, 중문(일주문)은 그 담선 위에 선다.
  const clusterMinX = Math.min(westFace - westSub.w, westFace - yosa.w, westFace - lecture.w);
  const clusterMaxX = Math.max(eastFace + eastSub.w, eastFace + seonbang.w, eastFace + bell.w);
  const innerSouth = round(Math.max(lectureZ + lecture.d / 2, bellZ + bell.d / 2) + 1.9);
  const innerNorth = round(mainZ - main.d / 2 - 1.9);

  plan.courtyards.push(
    {
      id: 'entry-court', role: 'entry',
      polygon: rect(0, (innerSouth + 3 + depth / 2 - 2) / 2, width - 5,
        Math.max(6, depth / 2 - 2 - (innerSouth + 3))),
      level: 0,
    },
    {
      id: 'worship-court', role: 'worship',
      polygon: rect((westFace + eastFace) / 2, (courtNorthZ + courtSouthZ) / 2,
        courtWidth, courtSouthZ - courtNorthZ),
      level: 0,
    },
  );
  plan.enclosures.push({
    id: 'inner-precinct', role: 'worship-wall',
    polygon: rect((clusterMinX + clusterMaxX) / 2, (innerNorth + innerSouth) / 2,
      round(clusterMaxX - clusterMinX + 3.2), round(innerSouth - innerNorth)),
    height: 1.8, gateId: 'inner-gate',
  });
  plan.gates.push({
    id: 'inner-gate', role: 'court-gate', type: 'iljakmun',
    position: point(axisX, innerSouth), yaw: 0, width: 2.4,
  });

  const candidates = [
    hall('main-hall', 'main-hall', axisX, mainZ, {
      frontBays: 5, sideBays: 3, scale: 0.9, seed,
    }),
    hall('west-subsidiary', 'subsidiary-hall', round(westFace - westSub.w / 2), subZ, {
      scale: 0.78, seed,
    }),
    hall('east-subsidiary', 'subsidiary-hall', round(eastFace + eastSub.w / 2), subZ, {
      scale: 0.78, seed,
    }),
    hall('west-yosa', 'yosa', round(westFace - yosa.w / 2), yosaZ, {
      yaw: -Math.PI / 2, scale: 0.72, seed,
    }),
    hall('east-seonbang', 'seonbang', round(eastFace + seonbang.w / 2), seonbangZ, {
      yaw: Math.PI / 2, scale: 0.72, seed,
    }),
    hall('lecture-hall', 'lecture-hall', round(westFace - lecture.w / 2), lectureZ, {
      yaw: -Math.PI / 2, scale: 0.68, seed,
    }),
    hall('bell-pavilion', 'bell-pavilion', round(eastFace + bell.w / 2), bellZ, {
      yaw: Math.PI / 2, scale: 0.68, seed,
    }),
  ];
  plan.buildings = candidates.slice(0, settings.hallCount)
    .filter((building) => building.role !== 'bell-pavilion' || settings.includeBellPavilion);
  addCourtProps(plan, mainSouth, axisX, pagodaSpread(main.w));
  if (settings.includeDanggan) {
    plan.props.push(prop('entry-danggan', 'entry-marker', 'danggan', -14, depth / 2 - 6, {
      scale: 1, radius: 0.9, heightClass: 'tall',
    }));
  }
  if (settings.includeBudo) {
    plan.props.push(prop('outer-budo', 'memorial-budo', 'budo', -width / 2 + 3.1, -depth / 2 + 4.2, {
      scale: 0.92, radius: 0.65,
    }));
  }
  plan.paths.push(
    { id: 'entry-path', role: 'entry', width: 1.7, points: [point(0, depth / 2 - 1), point(0, innerSouth + 1)] },
    { id: 'worship-path', role: 'worship', width: 1.45, points: [point(axisX, innerSouth - 1), point(axisX, round(mainSouth + 1.6))] },
  );
  plan.solarAccess = {
    role: 'main-hall', origin: point(axisX, round(mainSouth + 0.6)),
    halfWidth: round(main.w / 2), southZ: round(depth / 2),
  };
}

export function planTempleCompound(options = {}) {
  const seed = (finite(options.seed, 1) >>> 0);
  const variant = TEMPLE_VARIANTS.includes(options.variant) ? options.variant : 'compact';
  const spec = TEMPLE_VARIANT_SPECS[variant];
  const width = clamp(finite(options.width, spec.width), spec.min, spec.max);
  const depth = clamp(finite(options.depth, spec.depth), spec.min, spec.max);
  const rng = makeRng((seed ^ 0x7e6d1e) >>> 0);
  const entryProfile = options.entryProfile === 'mountain' || options.profile === 'mountain'
    ? 'mountain'
    : 'flat';
  const settings = {
    hallCount: clamp(Math.round(finite(options.hallCount, spec.maxHalls)), spec.minHalls, spec.maxHalls),
    axisBend: round(clamp(finite(options.axisBend, rng.range(-0.55, 0.55)), -1, 1)),
    courtScale: round(clamp(finite(options.courtScale, 1), 0.82, 1.18)),
    includeBellPavilion: options.includeBellPavilion !== false,
    pagoda: ['auto', 'none', 'single', 'pair'].includes(options.pagoda) ? options.pagoda : 'auto',
    stoneLanterns: clamp(Math.round(finite(options.stoneLanterns, variant === 'extended' ? 2 : 1)), 0, 2),
    includeDanggan: options.includeDanggan ?? (variant !== 'compact'),
    includeBudo: options.includeBudo ?? (variant === 'extended'),
    entryProfile,
  };
  // The 22m solo precinct is a deliberate hermitage: its optional yosa only
  // appears once the wall has enough lateral breathing room.
  if (variant === 'compact' && Math.min(width, depth) < 25) settings.hallCount = 1;
  const plan = commonPlan(seed, variant, width, depth, settings);
  if (variant === 'compact') planCompact(plan);
  else if (variant === 'courtyard') planCourtyard(plan);
  else planExtended(plan);
  // Gate | stair-apron | pass-under | court is owned here so village adapters
  // and editors cannot invent a second processional grammar.
  applyTwoStoreyPrincipal(plan);
  applyTempleEntrySequence(plan, { profile: entryProfile });
  // 단(段)은 진입 시퀀스 뒤에 확정한다 — 누하 전각이 그때 추가되고, 그 전각도 단을
  // 배정받아야 한다. 단이 전각 elevation 을 확정한 뒤 스테이지를 다시 유도해 두 기록이
  // 같은 높이를 말하게 한다.
  applyTempleTerraces(plan);
  plan.entrySequence = planTempleEntrySequence(plan, { profile: entryProfile });
  return plan;
}

function buildingPolygon(building) {
  if (building.eaveFootprint?.polygon?.length === 4) return building.eaveFootprint.polygon;
  const width = building.footprint?.width || 0;
  const depth = building.footprint?.depth || 0;
  return rect(building.position.x, building.position.z, width, depth);
}

function polygonBounds(polygon) {
  const xs = polygon.map((corner) => corner.x);
  const zs = polygon.map((corner) => corner.z);
  return {
    minX: Math.min(...xs), maxX: Math.max(...xs),
    minZ: Math.min(...zs), maxZ: Math.max(...zs),
  };
}

const boxesOverlap = (a, b, gap = 0) => a.minX < b.maxX + gap && a.maxX > b.minX - gap
  && a.minZ < b.maxZ + gap && a.maxZ > b.minZ - gap;

function polygonAxes(polygon) {
  return polygon.map((corner, index) => {
    const next = polygon[(index + 1) % polygon.length];
    const dx = next.x - corner.x;
    const dz = next.z - corner.z;
    const length = Math.hypot(dx, dz) || 1;
    return { x: -dz / length, z: dx / length };
  });
}

function projection(polygon, axis) {
  const values = polygon.map((corner) => corner.x * axis.x + corner.z * axis.z);
  return { min: Math.min(...values), max: Math.max(...values) };
}

function polygonsOverlap(a, b, gap = 0) {
  for (const axis of [...polygonAxes(a), ...polygonAxes(b)]) {
    const pa = projection(a, axis);
    const pb = projection(b, axis);
    if (pa.max + gap <= pb.min || pb.max + gap <= pa.min) return false;
  }
  return true;
}

function pointInPolygon(pointValue, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if (((a.z > pointValue.z) !== (b.z > pointValue.z))
      && pointValue.x < (b.x - a.x) * (pointValue.z - a.z) / (b.z - a.z) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

function pointSegmentDistance(pointValue, a, b) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const denom = dx * dx + dz * dz;
  const t = denom > 1e-12
    ? clamp(((pointValue.x - a.x) * dx + (pointValue.z - a.z) * dz) / denom, 0, 1)
    : 0;
  return Math.hypot(pointValue.x - (a.x + dx * t), pointValue.z - (a.z + dz * t));
}

function circleIntersectsPolygon(center, radius, polygon) {
  if (pointInPolygon(center, polygon)) return true;
  return polygon.some((corner, index) =>
    pointSegmentDistance(center, corner, polygon[(index + 1) % polygon.length]) <= radius);
}

// Lightweight invariant helper used by Node gates and downstream consumers.
// It deliberately checks semantic safety (bounds, overlaps, south-light lane)
// without importing THREE or the village geometry package.
export function templePlanIssues(plan) {
  const issues = [];
  const bounds = plan.bounds;
  const buildings = plan.buildings.map((building) => {
    const polygon = buildingPolygon(building);
    return { building, polygon, box: polygonBounds(polygon) };
  });
  for (const { building, polygon, box } of buildings) {
    if (!completeHallArchitecture(building)) {
      issues.push(`${building.id}: architectural hierarchy is incomplete`);
    } else if (!hallEaveMatches(building)) {
      issues.push(`${building.id}: eave footprint drifted from architecture`);
    }
    if (box.minX < bounds.minX + 0.6 || box.maxX > bounds.maxX - 0.6
      || box.minZ < bounds.minZ + 0.6 || box.maxZ > bounds.maxZ - 0.6) {
      issues.push(`${building.id}: footprint leaves precinct`);
    }
  }
  for (let i = 0; i < buildings.length; i++) for (let j = i + 1; j < buildings.length; j++) {
    if (boxesOverlap(buildings[i].box, buildings[j].box, 0.45)
      && polygonsOverlap(buildings[i].polygon, buildings[j].polygon, 0.45)) {
      issues.push(`${buildings[i].building.id}/${buildings[j].building.id}: building eaves overlap`);
    }
  }
  for (const item of plan.props) {
    if (item.position.x - item.radius < bounds.minX || item.position.x + item.radius > bounds.maxX
      || item.position.z - item.radius < bounds.minZ || item.position.z + item.radius > bounds.maxZ) {
      issues.push(`${item.id}: prop leaves precinct`);
    }
    for (const { building, box, polygon } of buildings) {
      if (item.position.x + item.radius > box.minX && item.position.x - item.radius < box.maxX
        && item.position.z + item.radius > box.minZ && item.position.z - item.radius < box.maxZ
        && circleIntersectsPolygon(item.position, item.radius, polygon)) {
        issues.push(`${item.id}/${building.id}: prop overlaps building eave`);
      }
    }
  }
  const solar = plan.solarAccess;
  if (solar) {
    const lane = {
      minX: solar.origin.x - solar.halfWidth, maxX: solar.origin.x + solar.halfWidth,
      minZ: solar.origin.z, maxZ: solar.southZ,
    };
    const lanePolygon = rect(
      solar.origin.x,
      (solar.origin.z + solar.southZ) / 2,
      solar.halfWidth * 2,
      solar.southZ - solar.origin.z,
    );
    for (const { building, box, polygon } of buildings) {
      // Open lower corridors (누하) keep the processional axis and winter sun.
      if (templeBuildingIsOpenPassUnder(building)) continue;
      if (building.role !== solar.role && boxesOverlap(lane, box)
        && polygonsOverlap(lanePolygon, polygon)) {
        issues.push(`${building.id}: blocks main-hall south-light lane`);
      }
    }
    for (const item of plan.props) {
      if (item.heightClass !== 'tall') continue;
      // 석탑은 이 레인이 존재하는 이유 자체다 — 탑–금당 정형과 부석사 예불축 석등이
      // 모두 주불전 정면 축선 위에 선다(docs/temple-generator.md §2). 레인 규칙의 목적은
      // 전각 매스가 정면을 가리는 것을 막는 것이고, 반경 1.35m 슬렌더 석탑은 그 대상이
      // 아니다. 종전에는 이 규칙 때문에 석탑을 마당 밖까지 측방으로 밀어냈는데,
      // 밀집 가람(2026-08-05)에서는 그럴 폭이 남지 않아 예외를 명시한다.
      // 당간·그 밖의 tall 프롭은 계속 레인에서 배제된다.
      if (item.role === 'worship-pagoda') continue;
      const box = {
        minX: item.position.x - item.radius, maxX: item.position.x + item.radius,
        minZ: item.position.z - item.radius, maxZ: item.position.z + item.radius,
      };
      if (boxesOverlap(lane, box)) issues.push(`${item.id}: blocks main-hall south-light lane`);
    }
  }
  for (const issue of templeEntrySequenceIssues(plan)) issues.push(issue);
  for (const issue of templeTerraceIssues(plan)) issues.push(issue);
  return issues;
}
