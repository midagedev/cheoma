// Reusable temple planner and village-adapter contract. This is intentionally a
// DOM-, THREE-, and browser-free gate so agents can validate layout edits in well
// under a full visual run.
import { readFileSync } from 'node:fs';
import {
  TEMPLE_PLAN_SCHEMA_VERSION,
  TEMPLE_ROLE_HIERARCHY,
  TEMPLE_VARIANTS,
  TEMPLE_VARIANT_SPECS,
  normalizeTemplePlan,
  planTempleCompound,
  templeHallBuilderParams,
  templeHallEaveFootprint,
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
