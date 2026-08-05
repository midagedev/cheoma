// Reusable temple planner and village-adapter contract. This is intentionally a
// DOM-, THREE-, and browser-free gate so agents can validate layout edits in well
// under a full visual run.
import { readFileSync } from 'node:fs';
import {
  TEMPLE_ENTRY_PROFILES,
  TEMPLE_ENTRY_SEQUENCE_SCHEMA_VERSION,
  TEMPLE_ENTRY_STAGE_KINDS,
  TEMPLE_PLAN_SCHEMA_VERSION,
  TEMPLE_PLAQUE_SCHEMA_VERSION,
  TEMPLE_ROLE_HIERARCHY,
  TEMPLE_VARIANTS,
  TEMPLE_VARIANT_SPECS,
  normalizeTemplePlan,
  planTempleCompound,
  planTempleEntrySequence,
  templeEntrySequenceIssues,
  templeEntrySequenceKinds,
  templeHallBuilderParams,
  templeHallBuilderPreset,
  templeHallEaveFootprint,
  templeHallHasPlaque,
  templeHallPlaquePlan,
  templePlanIssues,
  templeRoleArchitecture,
  templeVariantsForSize,
} from '../src/api/temple-plan.js';
import { planVillage } from '../src/api/village-plan.js';

const repoFile = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
import * as G from '../src/core/math/geom2.js';
import { parcelWorldPoint } from '../src/village/parcel-contract.js';
import {
  templeCompoundDepth,
  templeCompoundWidth,
  templeFootprint,
} from '../src/village/temple-plan.js';
import { buildRebuildPayload, schemaFor } from '../app/src/lib/edit-schema.js';

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function withoutGlobalRandom(build, label) {
  const original = Math.random;
  Math.random = () => { throw new Error(`${label} consumed global Math.random`); };
  try { return build(); }
  finally { Math.random = original; }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// 주불전 무자 현판(懸板): exactly one per compound, on the principal hall only,
// horizontally centered in the 어칸, and inside the 창방-above / 공포대-below band
// under the eave. See docs/temple-generator.md §8.
function assertHallPlaques(plan, label) {
  const hosts = plan.buildings.filter((building) => templeHallHasPlaque(building));
  invariant(hosts.length === 1 && hosts[0].architecturalRank === 4,
    `${label}: exactly one principal-hall plaque host expected, got ${hosts.length}`);
  for (const building of plan.buildings) {
    const plaque = templeHallPlaquePlan(building);
    if (building !== hosts[0]) {
      invariant(plaque === null,
        `${label}:${building.id}: a hall below principal rank grew a plaque`);
      continue;
    }
    invariant(plaque?.schemaVersion === TEMPLE_PLAQUE_SCHEMA_VERSION,
      `${label}:${building.id}: plaque schema missing`);
    // 무자 현판: geometry only — no glyph, text, or inscription payload.
    invariant(plaque.lettering === 'none'
        && !('text' in plaque) && !('glyphs' in plaque) && !('inscription' in plaque),
    `${label}:${building.id}: plaque is no longer uninscribed`);
    const { board, molding, band } = plaque;
    invariant(plaque.local.x === 0 && board.width / 2 + 0.5 <= band.centerBayHalf,
      `${label}:${building.id}: plaque is not centered inside the 어칸 with column clearance`);
    // 공포대(평방 윗면부터)를 침범하지 않는다.
    invariant(plaque.topY <= band.bracketBaseY - 0.02,
      `${label}:${building.id}: plaque intrudes into the bracket band`);
    // 창방 대역에 걸린다: 상단은 기둥머리 위, 하단은 판 높이의 60% 이상 아래로 못 내려간다.
    invariant(plaque.topY >= band.columnTopY + 0.25,
      `${label}:${building.id}: plaque sank below the 창방 band`);
    invariant(plaque.bottomY >= band.columnTopY - board.height * 0.6,
      `${label}:${building.id}: plaque hangs too far down the front wall`);
    // 처마 밑: 처마 끝선보다 낮고, 처마 그늘 안쪽에 있다.
    invariant(plaque.topY < band.eaveEdgeY,
      `${label}:${building.id}: plaque is not under the eave line`);
    invariant(plaque.local.z + board.thickness / 2 + molding.proud <= band.eaveFrontZ - 1,
      `${label}:${building.id}: plaque leaves the eave shelter`);
    invariant(plaque.local.z - board.thickness / 2 >= band.frontFaceZ + 0.1,
      `${label}:${building.id}: plaque is not fastened in front of the 창방 face`);
    // 테두리 몰딩은 테두리로 남아야 한다(판을 덮지 않는다).
    invariant(molding.rail >= 0.05 && molding.rail * 4 < board.height && molding.proud > 0,
      `${label}:${building.id}: border molding is not a proud border rail`);
    // 실물 관례 비례: 공북루 편액 280×120cm(세로/가로 0.43)을 상한 표본으로 삼은 밴드.
    const aspect = board.height / board.width;
    invariant(aspect > 0.36 && aspect < 0.5,
      `${label}:${building.id}: plaque aspect ${aspect.toFixed(3)} outside the documented band`);
    invariant(plaque.world.width > 1.4 && plaque.world.width <= 2.8,
      `${label}:${building.id}: plaque world width ${plaque.world.width.toFixed(3)} outside 1.4–2.8m`);
    invariant(plaque.world.height > 0.55 && plaque.world.height <= 1.2,
      `${label}:${building.id}: plaque world height ${plaque.world.height.toFixed(3)} outside 0.55–1.2m`);
    // The plaque must be planned against the very preset the renderer builds.
    const preset = templeHallBuilderPreset(building);
    invariant(preset.centerBayW === band.centerBayHalf * 2
        && preset.columnHeight === building.massingGrammar.columnHeight,
    `${label}:${building.id}: plaque band drifted from the renderer preset`);
  }
}

// ── 가람 밀집 계약 (2026-08-05, refs/temple-old 구조 대조 라운드) ──────────────────
// 사료 사진(장안사 1930 사선 부감, 정양사 1930 눈높이)에서 전각들은 지붕이 거의 맞닿을
// 만큼 붙어 용마루 방향이 채마다 달라 지붕면이 조각보로 얽힌다. 종전 배치의 실측값:
//   extended 최근접 처마간격 median 11.13m · 처마합/클러스터 hull 20% · 직교채 2/8(25%)
//   courtyard median 6.81m
// 그래서 마당이 화면 절반을 먹고 "소규모 궁"으로 읽혔다(docs/temple-generator.md §9 갭 ①).
// 재배치 후 실측(126개 마을 실사용 크기 스윕): median 1.6m · 점유 36~39% · 직교 50~60%.
// 아래 임계는 실측 프런티어가 아니라 그 사이의 여유를 둔 계약선이다.
//   FAIL-first 확인: 재배치 전 소스에서 extended/courtyard 가 median·점유·직교 세 단언을
//   모두 실제로 깬다(이 라운드에서 직접 확인).
// 전각 1채(암자)는 이웃이 없어 밀집이 성립하지 않으므로 제외한다.
const GATHERING = Object.freeze({
  maxMedianGap: 3.0,
  minHullOccupancy: 0.30,
  minCrossRidgeRatio: 0.40,
});

function polygonArea(polygon) {
  let total = 0;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    total += polygon[j].x * polygon[i].z - polygon[i].x * polygon[j].z;
  }
  return Math.abs(total) / 2;
}

// 두 볼록 사각형 사이 실간격(겹치면 0). 분리축 정리의 최대 간격.
function polygonGap(a, b) {
  const axes = [];
  for (const polygon of [a, b]) {
    for (let index = 0; index < polygon.length; index++) {
      const next = polygon[(index + 1) % polygon.length];
      const dx = next.x - polygon[index].x;
      const dz = next.z - polygon[index].z;
      const length = Math.hypot(dx, dz) || 1;
      axes.push({ x: -dz / length, z: dx / length });
    }
  }
  let best = -Infinity;
  for (const axis of axes) {
    const pa = a.map((corner) => corner.x * axis.x + corner.z * axis.z);
    const pb = b.map((corner) => corner.x * axis.x + corner.z * axis.z);
    best = Math.max(best,
      Math.max(Math.min(...pb) - Math.max(...pa), Math.min(...pa) - Math.max(...pb)));
  }
  return Math.max(0, best);
}

function assertGathering(plan, label) {
  const polygons = plan.buildings.map((building) => building.eaveFootprint.polygon);
  if (polygons.length < 2) return;
  const nearest = polygons.map((polygon, index) => {
    let closest = Infinity;
    for (let other = 0; other < polygons.length; other++) {
      if (other !== index) closest = Math.min(closest, polygonGap(polygon, polygons[other]));
    }
    return closest;
  }).sort((a, b) => a - b);
  const median = nearest[Math.floor(nearest.length / 2)];
  invariant(median <= GATHERING.maxMedianGap,
    `${label}: gathered eave gap median ${median.toFixed(2)}m exceeds ${GATHERING.maxMedianGap}m`);

  const corners = polygons.flat();
  const xs = corners.map((corner) => corner.x);
  const zs = corners.map((corner) => corner.z);
  const hull = (Math.max(...xs) - Math.min(...xs)) * (Math.max(...zs) - Math.min(...zs));
  const roof = polygons.reduce((sum, polygon) => sum + polygonArea(polygon), 0);
  const occupancy = hull > 0 ? roof / hull : 0;
  invariant(occupancy >= GATHERING.minHullOccupancy,
    `${label}: roofs fill ${(occupancy * 100).toFixed(1)}% of the cluster hull`
    + ` (< ${(GATHERING.minHullOccupancy * 100).toFixed(0)}%) — the yard reads as a palace court`);

  // 용마루 교차: 주축과 직교한 채가 있어야 지붕면이 조각보로 얽힌다.
  const across = plan.buildings.filter((building) => Math.abs(Math.sin(building.yaw)) > 0.5).length;
  const ratio = across / plan.buildings.length;
  invariant(ratio >= GATHERING.minCrossRidgeRatio,
    `${label}: only ${across}/${plan.buildings.length} ridges cross the main axis`
    + ` (< ${(GATHERING.minCrossRidgeRatio * 100).toFixed(0)}%)`);
}

// ── 단(段)·막돌 석축 계약 ───────────────────────────────────────────────────────
// 사료: 정양사(등고 따라 다른 높이 → 지붕선 계단), 마하연(축대–마당–전각 3단, 막돌
// 상단이 오르내림), 장안사(주불전 최고단·최북단), 신계사(계단 편심).
// FAIL-first: `applyTempleTerraces()` 를 no-op 으로 되돌리면 첫 단언이 실제로 깨진다.
function assertTerraces(plan, label) {
  const terraces = plan.terraces;
  invariant(terraces && Array.isArray(terraces.tiers) && terraces.tiers.length >= 1,
    `${label}: terrace record missing`);
  const profile = plan.settings?.entryProfile;
  invariant(terraces.profile === profile,
    `${label}: terrace profile ${terraces.profile} != ${profile}`);
  if (profile !== 'mountain') {
    invariant(terraces.tierCount === 1 && terraces.rise === 0 && terraces.risers.length === 0,
      `${label}: flat precinct grew terraces`);
    invariant(plan.buildings.every((building) => building.elevation === 0),
      `${label}: flat precinct lifted halls`);
    return;
  }
  const singleHall = plan.buildings.length < 2;
  invariant(terraces.tierCount >= (singleHall ? 1 : 2),
    `${label}: mountain precinct did not step (${terraces.tierCount} tier)`);
  if (terraces.tierCount < 2) return;
  const main = plan.buildings.find((building) => building.role === 'main-hall');
  invariant(main.terraceLevel === terraces.tiers[0].level,
    `${label}: main hall is not on the highest terrace`);
  // 같은 행(z 겹침)의 전각은 같은 단이어야 한다 — 어긋나면 나란한 기단이 붕괴로 읽힌다.
  for (const first of plan.buildings) {
    for (const second of plan.buildings) {
      if (first.id >= second.id) continue;
      const a = first.eaveFootprint.polygon.map((corner) => corner.z);
      const b = second.eaveFootprint.polygon.map((corner) => corner.z);
      const overlap = Math.min(Math.max(...a), Math.max(...b)) - Math.max(Math.min(...a), Math.min(...b));
      if (overlap > 1.2) {
        invariant(first.terraceLevel === second.terraceLevel,
          `${label}: ${first.id}/${second.id} share a row but sit on different terraces`);
      }
    }
  }
  for (const riser of terraces.risers) {
    const tops = riser.segments.map((segment) => segment.topY);
    invariant(new Set(tops).size >= 2 && Math.max(...tops) - Math.min(...tops) > 0.02,
      `${label}: ${riser.id} rubble top line is regular coursing`);
    invariant(Math.abs(riser.stair.offsetFromAxis) > 1e-6,
      `${label}: ${riser.id} terrace stair is dead-centred on the axis`);
  }
}

function assertLocalPlan(plan, label) {
  const spec = TEMPLE_VARIANT_SPECS[plan.variant];
  invariant(plan.schemaVersion === TEMPLE_PLAN_SCHEMA_VERSION, `${label}: wrong schema version`);
  invariant(plan.width >= spec.min && plan.width <= spec.max, `${label}: width outside variant range`);
  invariant(plan.depth >= spec.min && plan.depth <= spec.max, `${label}: depth outside variant range`);
  invariant(plan.buildings.some((building) => building.role === 'main-hall'), `${label}: main hall missing`);
  invariant(plan.enclosures.some((enclosure) => enclosure.id === 'outer-precinct'), `${label}: outer wall missing`);
  invariant(plan.gates.some((gate) => gate.id === 'south-gate'), `${label}: south gate missing`);
  invariant(plan.paths.some((path) => path.role === 'entry'), `${label}: entry path missing`);
  invariant(plan.courtyards.length >= 1, `${label}: courtyard missing`);
  invariant(plan.solarAccess?.role === 'main-hall', `${label}: main-hall solar contract missing`);
  const mainHall = plan.buildings.find((building) => building.role === 'main-hall');
  invariant(mainHall?.architecturalRank === 4, `${label}: main hall lost principal rank`);
  invariant(plan.buildings.every((building) => (
    Number.isInteger(building.architecturalRank)
    && building.architectureId
    && building.roofGrammar?.type
    && building.bracketGrammar?.family
    && Number.isFinite(building.eaveGrammar?.overhang)
    && Number.isFinite(building.massingGrammar?.columnHeight)
  )), `${label}: an architectural role grammar is incomplete`);
  invariant(plan.buildings.every((building) => (
    building.role === 'main-hall' || building.architecturalRank < mainHall.architecturalRank
  )), `${label}: a secondary building rivals the principal worship hall`);
  for (const building of plan.buildings) {
    const architecture = {
      architecturalRank: building.architecturalRank,
      roofGrammar: building.roofGrammar,
      bracketGrammar: building.bracketGrammar,
      eaveGrammar: building.eaveGrammar,
      massingGrammar: building.massingGrammar,
    };
    const builder = templeHallBuilderParams(architecture);
    invariant(builder.roofType === building.roofGrammar.type
        && builder.bracketTiers === building.bracketGrammar.tiers
        && builder.eaveOverhang === building.eaveGrammar.overhang
        && builder.columnHeight === building.massingGrammar.columnHeight
        && builder.centerBayW === 4.2 && builder.endBayW === 3.4
        && builder.centerBayD === 2.4 && builder.endBayD === 2.4,
    `${label}:${building.id}: renderer parameters drifted from the pure grammar`);
    const eave = templeHallEaveFootprint({
      architecture,
      frontBays: building.frontBays,
      sideBays: building.sideBays,
      scale: building.scale,
      yaw: building.yaw,
      position: building.position,
    });
    invariant(building.eaveFootprint.polygon.length === 4
        && Math.abs(eave.width - building.eaveFootprint.width) < 0.002
        && Math.abs(eave.depth - building.eaveFootprint.depth) < 0.002
        && building.footprint.width === building.eaveFootprint.width
        && building.footprint.depth === building.eaveFootprint.depth,
    `${label}:${building.id}: actual eave footprint is not the collision footprint`);
  }
  assertHallPlaques(plan, label);
  assertGathering(plan, label);
  assertTerraces(plan, label);
  const issues = templePlanIssues(plan);
  invariant(!issues.length, `${label}: ${issues.join('; ')}`);

  const southGate = plan.gates.find((gate) => gate.id === 'south-gate');
  invariant(Math.abs(southGate.position.z - plan.depth / 2) < 1e-3,
    `${label}: south gate is not on the south boundary`);
  if (plan.variant !== 'compact') {
    invariant(plan.buildings.length >= 3, `${label}: compound regressed to a single building`);
    invariant(plan.props.some((item) => item.role === 'worship-pagoda'), `${label}: pagoda missing`);
  }
  if (plan.variant === 'extended') {
    const inner = plan.enclosures.find((enclosure) => enclosure.id === 'inner-precinct');
    const gate = plan.gates.find((candidate) => candidate.id === inner?.gateId);
    invariant(inner && gate, `${label}: inner court gate contract missing`);
    const southZ = Math.max(...inner.polygon.map((point) => point.z));
    invariant(Math.abs(gate.position.z - southZ) < 1e-3, `${label}: inner gate misses its wall opening`);
    invariant(plan.courtyards.length >= 2, `${label}: extended compound needs two courts`);
  }

  // #150 item E — processional entry sequence (gate | stair-apron | pass-under | court).
  const sequence = plan.entrySequence;
  invariant(sequence?.schemaVersion === TEMPLE_ENTRY_SEQUENCE_SCHEMA_VERSION,
    `${label}: entry sequence schema missing`);
  invariant(TEMPLE_ENTRY_PROFILES.includes(sequence.profile),
    `${label}: entry profile ${sequence.profile} is not flat|mountain`);
  const expectedKinds = templeEntrySequenceKinds(plan.variant, sequence.profile);
  const actualKinds = sequence.stages.map((stage) => stage.kind);
  invariant(stableJson(actualKinds) === stableJson([...expectedKinds]),
    `${label}: entry order ${actualKinds.join('|')} != ${expectedKinds.join('|')}`);
  for (let index = 0; index < sequence.stages.length; index++) {
    const stage = sequence.stages[index];
    invariant(stage.order === index, `${label}: entry stage order drifted at ${index}`);
    invariant(TEMPLE_ENTRY_STAGE_KINDS.includes(stage.kind),
      `${label}: unknown entry stage kind ${stage.kind}`);
    if (index > 0) {
      invariant(stage.position.z <= sequence.stages[index - 1].position.z + 0.05,
        `${label}: entry stages are not south→north`);
    }
  }
  if (plan.variant === 'courtyard' || plan.variant === 'extended') {
    const passUnder = sequence.stages.find((stage) => stage.kind === 'pass-under');
    invariant(passUnder?.passUnder?.openLower, `${label}: pass-under lost open lower corridor`);
    const pavilion = plan.buildings.find((building) => (
      building.id === passUnder.refId || building.passUnder?.openLower
    ));
    invariant(pavilion?.role === 'gate-pavilion' && pavilion.passUnder?.openLower,
      `${label}: pass-under pavilion building missing`);
    invariant(pavilion.architecturalRank < 4, `${label}: pass-under rivalled the main hall`);
  }
  const entryIssues = templeEntrySequenceIssues(plan);
  invariant(!entryIssues.length, `${label}: entry sequence ${entryIssues.join('; ')}`);
}

let pureCases = 0;
const architectureFamilies = new Map(TEMPLE_VARIANTS.map((variant) => [variant, new Set()]));
for (const variant of TEMPLE_VARIANTS) {
  const spec = TEMPLE_VARIANT_SPECS[variant];
  for (const seed of [1, 42, 122, 20260716]) {
    for (const size of [spec.min, spec.max]) {
      const label = `${variant}:${size}:${seed}`;
      const options = { variant, seed, width: size, depth: size };
      const first = withoutGlobalRandom(() => planTempleCompound(options), label);
      const repeat = withoutGlobalRandom(() => planTempleCompound(options), `${label}:repeat`);
      invariant(stableJson(first) === stableJson(repeat), `${label}: plan is not deterministic`);
      assertLocalPlan(first, label);
      architectureFamilies.get(variant).add(
        first.buildings.find((building) => building.role === 'main-hall').architectureId,
      );
      pureCases++;
    }
  }
}

for (const [variant, families] of architectureFamilies) {
  invariant(families.size >= 2,
    `${variant}: seeds no longer vary the principal roof/bracket repertoire`);
}

for (const role of [
  'main-hall', 'subsidiary-hall', 'lecture-hall', 'yosa', 'seonbang',
  'gate-pavilion', 'bell-pavilion',
]) {
  invariant(Object.isFrozen(TEMPLE_ROLE_HIERARCHY[role])
      && templeRoleArchitecture(role, { seed: 122, id: `probe-${role}` }).architecturalRank >= 1,
  `${role}: reusable hierarchy entry is missing or mutable`);
}
let rejectedUnknownRole = false;
try { templeRoleArchitecture('generic-house'); }
catch (error) { rejectedUnknownRole = error instanceof RangeError; }
invariant(rejectedUnknownRole, 'unknown temple role silently acquired a residential-looking grammar');

const principalFamilies = TEMPLE_ROLE_HIERARCHY['main-hall'].map((architecture) => (
  `${architecture.id}:${architecture.roofGrammar.type}:${architecture.bracketGrammar.family}`
)).sort();
invariant(stableJson(principalFamilies) === stableJson([
  'principal-matbae-dapo:matbae:dapo',
  'principal-paljak-jusimpo:paljak:jusimpo',
]), `principal roof/bracket evidence pairing drifted: ${principalFamilies.join(', ')}`);

const currentFixture = planTempleCompound({
  variant: 'courtyard', seed: 122, width: 42, depth: 46,
});
const legacyFixture = JSON.parse(JSON.stringify(currentFixture));
legacyFixture.schemaVersion = 1;
for (const building of legacyFixture.buildings) {
  delete building.architecturalRank;
  delete building.architectureId;
  delete building.roofGrammar;
  delete building.bracketGrammar;
  delete building.eaveGrammar;
  delete building.massingGrammar;
  delete building.eaveFootprint;
  building.footprint = { width: 1, depth: 1 };
}
const legacyBefore = stableJson(legacyFixture);
const upgradedFixture = withoutGlobalRandom(
  () => normalizeTemplePlan(legacyFixture),
  'TemplePlan v1 upgrade',
);
const upgradedRepeat = withoutGlobalRandom(
  () => normalizeTemplePlan(legacyFixture),
  'TemplePlan v1 repeat upgrade',
);
invariant(stableJson(legacyFixture) === legacyBefore, 'TemplePlan v1 upgrade mutated its input');
invariant(stableJson(upgradedFixture) === stableJson(upgradedRepeat),
  'TemplePlan v1 upgrade is not deterministic');
invariant(stableJson(upgradedFixture) === stableJson(currentFixture),
  'TemplePlan v1 upgrade did not reconstruct the canonical v2 architecture');
invariant(normalizeTemplePlan(currentFixture) === currentFixture,
  'canonical TemplePlan v2 should cross the input boundary without cloning');

for (const version of [0, 3, 99]) {
  let rejected = false;
  try { normalizeTemplePlan({ ...currentFixture, schemaVersion: version }); }
  catch (error) { rejected = error instanceof RangeError && error.message.includes('unsupported TemplePlan'); }
  invariant(rejected, `unsupported TemplePlan schema ${version} was not rejected explicitly`);
}
let rejectedMissingSchema = false;
try {
  const { schemaVersion: _ignored, ...missingSchema } = currentFixture;
  normalizeTemplePlan(missingSchema);
} catch (error) {
  rejectedMissingSchema = error instanceof TypeError && error.message.includes('schemaVersion is required');
}
invariant(rejectedMissingSchema, 'TemplePlan without a schema was not rejected explicitly');
let rejectedMalformedV2 = false;
try {
  normalizeTemplePlan({
    ...currentFixture,
    buildings: currentFixture.buildings.map((building, index) => (
      index ? building : { ...building, roofGrammar: undefined }
    )),
  });
} catch (error) {
  rejectedMalformedV2 = error instanceof TypeError && error.message.includes('incomplete architecture');
}
invariant(rejectedMalformedV2, 'TemplePlan v2 with missing grammar reached a consumer');

// 현판: pure, deterministic, RNG-free, and actually consumed by the renderer with
// borrowed palette materials (no new material/texture/program family).
const plaqueHost = currentFixture.buildings.find((building) => building.architecturalRank === 4);
const plaqueFirst = withoutGlobalRandom(() => templeHallPlaquePlan(plaqueHost), 'plaque plan');
const plaqueRepeat = withoutGlobalRandom(() => templeHallPlaquePlan(plaqueHost), 'plaque repeat');
invariant(plaqueFirst && stableJson(plaqueFirst) === stableJson(plaqueRepeat),
  'principal-hall plaque plan is not deterministic');
invariant(templeHallPlaquePlan({ ...plaqueHost, frontBays: 4 }) === null,
  'plaque was placed on an even bay count that has a column on the center axis');
invariant(templeHallPlaquePlan({ ...plaqueHost, architecturalRank: 3 }) === null,
  'plaque is not gated on principal architectural rank');
const compoundSource = repoFile('src/temple/compound.js');
invariant(compoundSource.includes('templeHallPlaquePlan(spec)')
    && compoundSource.includes("group.name = 'hall-plaque'"),
'temple renderer no longer builds the plan-owned principal-hall plaque');
const plaqueBuilder = compoundSource.match(/function buildHallPlaque[\s\S]*?\n}\n/)?.[0] || '';
invariant(plaqueBuilder.includes('mats.planwall') && plaqueBuilder.includes('mats.wood'),
  'plaque stopped borrowing the hall palette for its board and molding');
invariant(!/\.metalness\s*=/.test(plaqueBuilder) && !plaqueBuilder.includes('.clone()'),
  'plaque mutated or cloned a borrowed material instead of choosing a matte palette entry');
invariant(!/new THREE\.(\w*Material|\w*Texture)\b/.test(plaqueBuilder),
  'plaque allocated its own material or texture instead of borrowing the palette');
invariant(!/plaque[\s\S]{0,40}(fillText|font|glyph|label)/i.test(plaqueBuilder),
  'plaque grew lettering — the contract is a 무자 현판');

const creditsSource = repoFile('docs/credits.md');
const referenceModalSource = repoFile('app/src/components/ReferenceModal.svelte');
const templeReference = creditsSource.match(
  /### 39\. 국가유산청 · 국립문화유산연구원 · 한국학중앙연구원 — 사찰 전각 역할과 건축 위계([\s\S]*?)(?=\n### |\n---)/,
)?.[0] || '';
for (const required of [
  '국립문화유산연구원 「가람배치」',
  '한국민족문화대백과사전 「절」·「보제루」',
  '국가유산포털 「칠곡 송림사 대웅전」',
  '국가유산 디지털 서비스 「영주 부석사 실측조사보고서(도판)」',
  '송림사 맞배·다포와 부석사 무량수전 팔작·주심포',
  '**활용 / Use:**',
  '전국 사찰의 보편 높이 비율이나 공포 빈도 통계를 제공하지 않는다',
  '라이선스:',
  '공공누리 제4유형',
  '원문 문장·사진·도면·보호 자산을 복제하지 않는다',
]) {
  invariant(templeReference.includes(required),
    `Product References temple hierarchy item lost: ${required}`);
}
invariant((templeReference.match(/https?:\/\//g) || []).length === 7,
  'Product References temple hierarchy item must retain seven canonical institution links');
for (const field of ['title', 'scope', 'application', 'sources', 'license']) {
  invariant(referenceModalSource.includes(`data-reference-field="${field}"`),
    `ReferenceModal lost the ${field} evidence surface`);
}

for (const variant of TEMPLE_VARIANTS) {
  const spec = TEMPLE_VARIANT_SPECS[variant];
  for (const axisBend of [-1, 1]) {
    const label = `${variant}:editor-edge:${axisBend}`;
    const edgePlan = planTempleCompound({
      variant, seed: 17, width: spec.min, depth: spec.min,
      axisBend, courtScale: axisBend < 0 ? 0.82 : 1.18,
      hallCount: 99, pagoda: 'pair', stoneLanterns: 2,
      includeBellPavilion: true, includeDanggan: true, includeBudo: true,
    });
    assertLocalPlan(edgePlan, label);
    pureCases++;
  }
}

// Mountain profile: same kind order for courtyard/extended, but stair-apron is
// expressed as apron tiers rather than a free-standing single run.
for (const variant of ['courtyard', 'extended']) {
  const label = `${variant}:mountain-entry`;
  const mountain = withoutGlobalRandom(() => planTempleCompound({
    variant, seed: 150, entryProfile: 'mountain',
    width: TEMPLE_VARIANT_SPECS[variant].width,
    depth: TEMPLE_VARIANT_SPECS[variant].depth,
  }), label);
  assertLocalPlan(mountain, label);
  invariant(mountain.entrySequence.profile === 'mountain', `${label}: profile not mountain`);
  const stair = mountain.entrySequence.stages.find((stage) => stage.kind === 'stair-apron');
  invariant(stair?.stairMode === 'apron-tiers' && stair.tiers.length >= 2,
    `${label}: mountain stair did not use apron tiers`);
  const derived = planTempleEntrySequence(mountain, { profile: 'mountain' });
  invariant(stableJson(derived.stages.map((stage) => stage.kind))
    === stableJson(mountain.entrySequence.stages.map((stage) => stage.kind)),
  `${label}: pure entry derive drifted from plan-owned sequence`);
  pureCases++;
}

// The solar gate must reject tall architecture, including a pavilion, in front of
// the main hall. This guards the exact failure mode where a visually open-looking
// pavilion still stole the south-light and camera corridor.
const obstructionProbe = planTempleCompound({ variant: 'courtyard', seed: 91, pagoda: 'none' });
obstructionProbe.buildings.push({
  id: 'probe-pavilion', role: 'bell-pavilion', position: { ...obstructionProbe.solarAccess.origin },
  footprint: { width: 5, depth: 5 }, yaw: 0,
});
invariant(templePlanIssues(obstructionProbe).some((issue) => issue.includes('blocks main-hall south-light lane')),
  'solar contract did not detect a pavilion in the south-light lane');

const siteCases = [
  ['solo', 'compact'],
  ['hamlet', 'compact'],
  ['village', 'courtyard'],
  ['town', 'courtyard'],
  ['capital', 'extended'],
  ['hanyang', 'extended'],
];
for (const [scale, expectedVariant] of siteCases) {
  const label = `village:${scale}`;
  const plan = withoutGlobalRandom(() => planVillage({
    scale, seed: 20260716, includeTemple: true,
    includePalace: scale === 'capital' || scale === 'hanyang',
  }), label);
  const temple = plan.features?.temple;
  invariant(temple?.compound, `${label}: compound plan missing from village plan`);
  invariant(temple.compound.variant === expectedVariant,
    `${label}: ${temple.compound.variant} != ${expectedVariant}`);
  assertLocalPlan(temple.compound, label);
  invariant(templeCompoundWidth(temple) === temple.compound.width, `${label}: reserved width drift`);
  invariant(templeCompoundDepth(temple) === temple.compound.depth, `${label}: reserved depth drift`);
  invariant(templeFootprint(temple).length === 4, `${label}: invalid footprint`);

  const frame = { center: temple, frontDir: temple.frontDir };
  const southGate = parcelWorldPoint(frame, { x: 0, z: templeCompoundDepth(temple) / 2 });
  invariant(G.dist(temple.path[0], southGate) < 1e-8, `${label}: approach misses south gate`);
  if (scale === 'solo') {
    invariant(plan.parcels.length === 0 && plan.roads.length === 0,
      `${label}: minimum precinct must remain a road-free temple-only composition`);
    invariant(temple.placement.pathSource === 'center', `${label}: solo approach does not terminate at center`);
  } else {
    invariant(['road', 'gate'].includes(temple.placement.pathSource),
      `${label}: populated site approach is not connected to circulation`);
  }
}

invariant(stableJson(templeVariantsForSize(51)) === stableJson(['compact', 'courtyard']),
  'site-safe editor variants cross the 52m extended minimum');
invariant(stableJson(templeVariantsForSize(72)) === stableJson(TEMPLE_VARIANTS),
  '72m site does not expose all variants');

const compactSpec = {
  family: 'temple', variantOptions: TEMPLE_VARIANTS,
  hallRange: { min: 1, max: 2 }, params: { variant: 'compact' },
};
const compactSchema = schemaFor(compactSpec);
const compactFields = compactSchema.sections.flatMap((section) => section.fields.map((field) => field.key));
invariant(!compactFields.includes('pagoda') && !compactFields.includes('includeBellPavilion')
  && !compactFields.includes('includeBudo'), 'compact editor exposes controls the planner does not consume');
const payload = buildRebuildPayload(compactSpec, {
  variant: 'extended', hallCount: 7, courtScale: 1, axisBend: 0,
  pagoda: 'pair', stoneLanterns: 2, includeBellPavilion: true,
  includeDanggan: true, includeBudo: true,
});
invariant(payload.templeOptions.includeBudo && payload.templeOptions.pagoda === 'pair',
  'variant switch dropped newly visible temple defaults from the rebuild payload');

console.log(`TEMPLE CONTRACT: PASS (${pureCases} pure plans, ${siteCases.length} village adapters, solar/UI probes)`);
