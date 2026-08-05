// Renderer-free architectural hierarchy for temple halls.
//
// The planner writes one complete grammar onto every building. Renderers consume
// those values directly; they must not recover roof/bracket/eave choices from a
// role name. Ratios are restrained product translations of the institutional
// evidence documented in docs/temple-generator.md, not measurements copied from
// one monument.

import { PRESETS } from '../params.js';

const BASE_BAYS = Object.freeze({
  front: Object.freeze({ center: 4.2, middle: 3.4, end: 3.4 }),
  side: Object.freeze({ center: 2.4, middle: 2.4, end: 2.4 }),
});

const freezeGrammar = (grammar) => Object.freeze({
  ...grammar,
  roofGrammar: Object.freeze({ ...grammar.roofGrammar }),
  bracketGrammar: Object.freeze({ ...grammar.bracketGrammar }),
  eaveGrammar: Object.freeze({ ...grammar.eaveGrammar }),
  massingGrammar: Object.freeze({ ...grammar.massingGrammar }),
});

const MAIN_MATBAE = freezeGrammar({
  // Chilgok Songnimsa Daeungjeon: matbae roof with dapo brackets.
  id: 'principal-matbae-dapo',
  architecturalRank: 4,
  formality: 'hall',
  roofGrammar: {
    family: 'matbae',
    type: 'matbae',
    pitch: 0.62,
    profileCurve: 0.50,
    ridgeHeight: 0.44,
    gableOverhang: 0.92,
    cornerLift: 0.20,
    planCurve: 0.08,
  },
  bracketGrammar: {
    family: 'dapo',
    tiers: 2,
    interBrackets: 1,
    scale: 1.18,
    density: 'column-and-intercolumn',
  },
  eaveGrammar: {
    overhang: 1.82,
    drop: 0.29,
    layers: 2,
  },
  massingGrammar: {
    columnHeight: 4.08,
    podiumTiers: 1,
    podiumTierHeight: 1.42,
  },
});

const MAIN_PALJAK = freezeGrammar({
  // Buseoksa Muryangsujeon: paljak roof with jusimpo brackets.
  id: 'principal-paljak-jusimpo',
  architecturalRank: 4,
  formality: 'hall',
  roofGrammar: {
    family: 'paljak',
    type: 'paljak',
    pitch: 0.68,
    profileCurve: 0.54,
    ridgeHeight: 0.48,
    gableOverhang: 0,
    cornerLift: 0.48,
    planCurve: 0.18,
  },
  bracketGrammar: {
    family: 'jusimpo',
    tiers: 1,
    interBrackets: 0,
    scale: 1.42,
    density: 'column-head',
  },
  eaveGrammar: {
    overhang: 1.88,
    drop: 0.31,
    layers: 2,
  },
  massingGrammar: {
    columnHeight: 4.18,
    podiumTiers: 1,
    podiumTierHeight: 1.42,
  },
});

const SUBSIDIARY_MATBAE = freezeGrammar({
  id: 'subsidiary-matbae-jusimpo',
  architecturalRank: 3,
  formality: 'hall',
  roofGrammar: {
    family: 'matbae',
    type: 'matbae',
    pitch: 0.58,
    profileCurve: 0.46,
    ridgeHeight: 0.38,
    gableOverhang: 0.70,
    cornerLift: 0.14,
    planCurve: 0.05,
  },
  bracketGrammar: {
    family: 'jusimpo',
    tiers: 1,
    interBrackets: 0,
    scale: 1.16,
    density: 'column-head',
  },
  eaveGrammar: {
    overhang: 1.52,
    drop: 0.29,
    layers: 2,
  },
  massingGrammar: {
    columnHeight: 3.58,
    podiumTiers: 1,
    podiumTierHeight: 0.92,
  },
});

const SUBSIDIARY_PALJAK = freezeGrammar({
  id: 'subsidiary-paljak-jusimpo',
  architecturalRank: 3,
  formality: 'hall',
  roofGrammar: {
    family: 'paljak',
    type: 'paljak',
    pitch: 0.60,
    profileCurve: 0.48,
    ridgeHeight: 0.40,
    gableOverhang: 0,
    cornerLift: 0.34,
    planCurve: 0.12,
  },
  bracketGrammar: {
    family: 'jusimpo',
    tiers: 1,
    interBrackets: 0,
    scale: 1.12,
    density: 'column-head',
  },
  eaveGrammar: {
    overhang: 1.58,
    drop: 0.30,
    layers: 2,
  },
  massingGrammar: {
    columnHeight: 3.62,
    podiumTiers: 1,
    podiumTierHeight: 0.92,
  },
});

const LECTURE = freezeGrammar({
  id: 'lecture-matbae-minimal',
  architecturalRank: 2,
  formality: 'domestic',
  roofGrammar: {
    family: 'matbae',
    type: 'matbae',
    pitch: 0.50,
    profileCurve: 0.38,
    ridgeHeight: 0.30,
    gableOverhang: 0.46,
    cornerLift: 0.07,
    planCurve: 0.03,
  },
  bracketGrammar: {
    family: 'minimal-column-head',
    tiers: 0,
    interBrackets: 0,
    scale: 0.96,
    density: 'column-head',
  },
  eaveGrammar: {
    // Share the modest service-hall roof skin; the lecture hall's hierarchy is
    // carried by its taller columns, podium, and bracket scale, not a material
    // variant that would buy no additional silhouette.
    overhang: 1.12,
    drop: 0.27,
    layers: 1,
  },
  massingGrammar: {
    columnHeight: 3.22,
    podiumTiers: 1,
    podiumTierHeight: 0.62,
  },
});

const DOMESTIC = freezeGrammar({
  id: 'domestic-matbae-minimal',
  architecturalRank: 1,
  formality: 'domestic',
  roofGrammar: {
    family: 'matbae',
    type: 'matbae',
    pitch: 0.50,
    profileCurve: 0.38,
    ridgeHeight: 0.30,
    gableOverhang: 0.46,
    cornerLift: 0.07,
    planCurve: 0.03,
  },
  bracketGrammar: {
    family: 'minimal-column-head',
    tiers: 0,
    interBrackets: 0,
    scale: 0.84,
    density: 'column-head',
  },
  eaveGrammar: {
    overhang: 1.12,
    drop: 0.27,
    layers: 1,
  },
  massingGrammar: {
    columnHeight: 2.88,
    podiumTiers: 1,
    podiumTierHeight: 0.46,
  },
});

const PAVILION = freezeGrammar({
  id: 'ritual-pavilion-paljak',
  architecturalRank: 2,
  formality: 'pavilion',
  roofGrammar: {
    family: 'paljak',
    type: 'paljak',
    pitch: 0.60,
    profileCurve: 0.50,
    ridgeHeight: 0.38,
    gableOverhang: 0,
    cornerLift: 0.38,
    planCurve: 0.14,
  },
  bracketGrammar: {
    family: 'jusimpo',
    tiers: 1,
    interBrackets: 0,
    scale: 1.04,
    density: 'column-head',
  },
  eaveGrammar: {
    overhang: 1.52,
    drop: 0.29,
    layers: 1,
  },
  massingGrammar: {
    columnHeight: 3.48,
    podiumTiers: 1,
    podiumTierHeight: 0.48,
  },
});

export const TEMPLE_ROLE_HIERARCHY = Object.freeze({
  // Repertoire order is part of the seed-stable public contract. The canonical
  // product seed selects the restrained matbae family; other seeds still expose
  // the documented paljak/dapo alternative without raising the default budget.
  'main-hall': Object.freeze([MAIN_PALJAK, MAIN_MATBAE]),
  'subsidiary-hall': Object.freeze([SUBSIDIARY_PALJAK, SUBSIDIARY_MATBAE]),
  'lecture-hall': Object.freeze([LECTURE]),
  yosa: Object.freeze([DOMESTIC]),
  seonbang: Object.freeze([DOMESTIC]),
  'gate-pavilion': Object.freeze([PAVILION]),
  'bell-pavilion': Object.freeze([PAVILION]),
});

function stringHash(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function cloneArchitecture(source) {
  return {
    id: source.id,
    architecturalRank: source.architecturalRank,
    formality: source.formality,
    roofGrammar: { ...source.roofGrammar },
    bracketGrammar: { ...source.bracketGrammar },
    eaveGrammar: { ...source.eaveGrammar },
    massingGrammar: { ...source.massingGrammar },
  };
}

export function templeRoleArchitecture(role, { seed = 1, id = role } = {}) {
  const repertoire = TEMPLE_ROLE_HIERARCHY[role];
  if (!repertoire) throw new RangeError(`unsupported temple architectural role: ${role}`);
  const index = (stringHash(`${seed >>> 0}:${id}:${role}`) % repertoire.length);
  return cloneArchitecture(repertoire[index]);
}

export function templeHallBuilderParams(architecture) {
  if (!architecture?.roofGrammar || !architecture?.bracketGrammar
    || !architecture?.eaveGrammar || !architecture?.massingGrammar) {
    throw new TypeError('complete temple hall architecture is required');
  }
  const roof = architecture.roofGrammar;
  const bracket = architecture.bracketGrammar;
  const eave = architecture.eaveGrammar;
  const massing = architecture.massingGrammar;
  return {
    centerBayW: BASE_BAYS.front.center,
    middleBayW: BASE_BAYS.front.middle,
    endBayW: BASE_BAYS.front.end,
    centerBayD: BASE_BAYS.side.center,
    endBayD: BASE_BAYS.side.end,
    roofType: roof.type,
    roofPitch: roof.pitch,
    profileCurve: roof.profileCurve,
    ridgeH: roof.ridgeHeight,
    gableOverhang: roof.gableOverhang,
    cornerLift: roof.cornerLift,
    planCurve: roof.planCurve,
    bracketTiers: bracket.tiers,
    interBrackets: bracket.interBrackets,
    bracketScale: bracket.scale,
    eaveOverhang: eave.overhang,
    eaveDrop: eave.drop,
    doubleEave: eave.layers === 2,
    columnHeight: massing.columnHeight,
    podiumTiers: massing.podiumTiers,
    podiumTierH: massing.podiumTierHeight,
  };
}

/**
 * The complete builder parameter set for one planned hall: the temple preset
 * overridden by this hall's own grammar. `buildTempleCompound` and the pure
 * plaque planner both consume this single composition, so a plan-side detail can
 * never be positioned against a layout the renderer does not actually build.
 * `spec` is a plan building (it carries the grammar fields directly).
 */
export function templeHallBuilderPreset(spec) {
  return {
    ...PRESETS.temple,
    ...templeHallBuilderParams(spec),
    frontBays: spec.frontBays,
    sideBays: spec.sideBays,
  };
}

// 중층(重層) 주불전 — 대찰의 주불전만.
//
// 사료: 금강산 장안사 대웅보전은 **중층**이라 가람의 정점이 확실하다(徳田写真館 1930 도판).
// 같은 계보의 현존례가 금산사 미륵전(3층)·법주사 팔상전(5층)이고, 그 형태는 층마다 자기
// 지붕을 갖고 위 층이 안으로 물러앉는 적층이다. 그래서 새 지붕 문법을 지어내지 않고 같은
// 칸 모듈을 칸수만 줄여 한 층 더 올린다 — 상층 기둥이 하층 내부 기둥 위에 서는 실제 구조와
// 같은 조작이고, 새 재질·프로그램 계열이 0 이다.
//
// 이것을 `TEMPLE_ROLE_HIERARCHY['main-hall']` 의 세 번째 repertoire 항목으로 넣지 않는다:
// `templeRoleArchitecture` 가 `seed:id:role` 해시로 고르므로 항목을 늘리면 **모든** 절의
// 주불전 형식이 재추첨되고, 중층은 어느 산사에나 있는 형식이 아니다. 규모 규칙(대찰만)이
// 더 정확하고 골든 파급도 없다.
const TWO_STOREY_UPPER = Object.freeze({
  frontBayReduction: 2,
  sideBayReduction: 1,
  minFrontBays: 3,
  minSideBays: 2,
  // 상층 층고는 하층보다 **훨씬** 낮다. 0.70 은 상층이 하층의 축소 복제(2층 누각)로 읽혔다
  // (2026-08-05 사용자 판정 "2층짜리 좀 보기 어색한데"). 현존 중층 불전 — 화엄사 각황전·
  // 무량사 극락전·금산사 미륵전 — 의 상층 몸체는 '두 지붕 사이의 창호 띠'로 읽히는 높이다.
  columnHeightRatio: 0.45,
  // 같은 판정의 두 번째 축: 상층 벽은 하층과 같은 황토벽 위주가 아니라 창호가 우세한 띠다.
  // buildWalls 의 협칸 상부 창 높이 비율(winFrac)로 번역된다 — 하층 협칸 0.34 대비 0.5.
  wallWindowFrac: 0.5,
  // 상층 몸체를 하층 지붕 곡면에 물리는 깊이 — 하층 낙차(ridgeY − eaveInnerY)의 비율.
  // 0 이면 용마루선에 얹혀 상층 옆구리 밑에 빈틈이 보이고, 너무 크면 하층 지붕이 삼켜진다.
  seatDropRatio: 0.32,
});

/**
 * 중층 주불전의 상층 제원. Renderer-free — 플랜이 이 기록을 저장하고 렌더러는 소비만 한다.
 *
 * `building` 은 하층(= 플랜에 저장된 전각) 이고, 반환하는 `columnHeight`·`seatDrop` 은
 * **하층과 같은 미축척 단위**다. 전각 그룹 전체에 `scale` 이 걸리므로 여기서 곱하지 않는다.
 */
export function templeUpperStoreySpec(building) {
  if (!building?.massingGrammar || !building?.roofGrammar || !building?.eaveGrammar) {
    throw new TypeError('complete temple hall architecture is required');
  }
  const frontBays = Math.max(TWO_STOREY_UPPER.minFrontBays,
    building.frontBays - TWO_STOREY_UPPER.frontBayReduction);
  const sideBays = Math.max(TWO_STOREY_UPPER.minSideBays,
    building.sideBays - TWO_STOREY_UPPER.sideBayReduction);
  const round = (value) => Math.round(value * 1000) / 1000;
  return {
    frontBays,
    sideBays,
    columnHeight: round(building.massingGrammar.columnHeight * TWO_STOREY_UPPER.columnHeightRatio),
    podiumTiers: 0,
    seatDropRatio: TWO_STOREY_UPPER.seatDropRatio,
    wallWindowFrac: TWO_STOREY_UPPER.wallWindowFrac,
  };
}

/** Builder preset for the upper storey of a 중층 hall. */
export function templeUpperStoreyPreset(building) {
  const upper = building.upperStorey || templeUpperStoreySpec(building);
  return {
    ...templeHallBuilderPreset(building),
    frontBays: upper.frontBays,
    sideBays: upper.sideBays,
    columnHeight: upper.columnHeight,
    podiumTiers: upper.podiumTiers,
    // 저장된 플랜에 wallWindowFrac 이 없으면(스펙 개정 전 레코드) 현행 상수로 보충한다.
    wallWinFrac: upper.wallWindowFrac ?? TWO_STOREY_UPPER.wallWindowFrac,
  };
}

export const TEMPLE_TWO_STOREY_UPPER = TWO_STOREY_UPPER;

function baySpan(count, widths) {
  let total = 0;
  for (let index = 0; index < count; index++) {
    const fromCenter = Math.abs(index - (count - 1) / 2);
    total += fromCenter < 0.6
      ? widths.center
      : (index === 0 || index === count - 1) ? widths.end : widths.middle;
  }
  return total;
}

export function templeHallEaveFootprint({
  architecture,
  frontBays = 3,
  sideBays = 2,
  scale = 1,
  yaw = 0,
  position = { x: 0, z: 0 },
} = {}) {
  const roof = architecture?.roofGrammar;
  const eave = architecture?.eaveGrammar;
  if (!roof || !eave) throw new TypeError('complete temple roof/eave grammar is required');
  const columnWidth = baySpan(frontBays, BASE_BAYS.front);
  const columnDepth = baySpan(sideBays, BASE_BAYS.side);
  const curvedExtra = roof.planCurve || 0;
  const localHalfWidth = roof.type === 'matbae'
    ? columnWidth / 2 + (roof.gableOverhang || 0) + curvedExtra
    : columnWidth / 2 + eave.overhang + curvedExtra;
  const localHalfDepth = columnDepth / 2 + eave.overhang + curvedExtra;
  const halfWidth = localHalfWidth * scale;
  const halfDepth = localHalfDepth * scale;
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  const polygon = [
    { x: -halfWidth, z: halfDepth },
    { x: halfWidth, z: halfDepth },
    { x: halfWidth, z: -halfDepth },
    { x: -halfWidth, z: -halfDepth },
  ].map((point) => ({
    x: position.x + point.x * cos + point.z * sin,
    z: position.z - point.x * sin + point.z * cos,
  }));
  const xs = polygon.map((point) => point.x);
  const zs = polygon.map((point) => point.z);
  return {
    localWidth: localHalfWidth * 2 * scale,
    localDepth: localHalfDepth * 2 * scale,
    width: Math.max(...xs) - Math.min(...xs),
    depth: Math.max(...zs) - Math.min(...zs),
    polygon,
  };
}
