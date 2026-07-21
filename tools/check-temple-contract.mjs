// Reusable temple planner and village-adapter contract. This is intentionally a
// DOM-, THREE-, and browser-free gate so agents can validate layout edits in well
// under a full visual run.
import {
  TEMPLE_VARIANTS,
  TEMPLE_VARIANT_SPECS,
  planTempleCompound,
  templePlanIssues,
  templeVariantsForSize,
} from '../src/api/temple-plan.js';
import { planVillage } from '../src/api/village-plan.js';
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
  invariant(plan.schemaVersion === 1, `${label}: wrong schema version`);
  invariant(plan.width >= spec.min && plan.width <= spec.max, `${label}: width outside variant range`);
  invariant(plan.depth >= spec.min && plan.depth <= spec.max, `${label}: depth outside variant range`);
  invariant(plan.buildings.some((building) => building.role === 'main-hall'), `${label}: main hall missing`);
  invariant(plan.enclosures.some((enclosure) => enclosure.id === 'outer-precinct'), `${label}: outer wall missing`);
  invariant(plan.gates.some((gate) => gate.id === 'south-gate'), `${label}: south gate missing`);
  invariant(plan.paths.some((path) => path.role === 'entry'), `${label}: entry path missing`);
  invariant(plan.courtyards.length >= 1, `${label}: courtyard missing`);
  invariant(plan.solarAccess?.role === 'main-hall', `${label}: main-hall solar contract missing`);
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
for (const variant of TEMPLE_VARIANTS) {
  const spec = TEMPLE_VARIANT_SPECS[variant];
  for (const seed of [1, 42, 20260716]) {
    for (const size of [spec.min, spec.max]) {
      const label = `${variant}:${size}:${seed}`;
      const options = { variant, seed, width: size, depth: size };
      const first = withoutGlobalRandom(() => planTempleCompound(options), label);
      const repeat = withoutGlobalRandom(() => planTempleCompound(options), `${label}:repeat`);
      invariant(stableJson(first) === stableJson(repeat), `${label}: plan is not deterministic`);
      assertLocalPlan(first, label);
      pureCases++;
    }
  }
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
