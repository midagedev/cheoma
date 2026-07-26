// Pure roof-rank + palace-ornament contract (#150 item C).
// Hierarchy: palace > magistracy/gaeksa > city-gate > giwa.
// Only rank palace may emit palace-japsang / palace-chwidu; temple contracts stay ornament-free.
// Geometry counts for the same names stay in check:app / check:temple:browser; this gate is
// browser-free and asserts the pure policy, plan wiring, and source consumers.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ROOF_RANK,
  ROOF_RANK_ORDER,
  PALACE_CHWIDU_NAME,
  PALACE_JAPSANG_NAME,
  allowsPalaceRoofOrnaments,
  compareRoofRank,
  normalizeRoofRank,
  planHeroRoofRank,
  resolveRoofRank,
  roofOrnamentPolicy,
  roofRankLevel,
} from '../src/builder/roof-rank.js';
import { planVillage } from '../src/api/village-plan.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const invariant = (condition, message) => {
  if (!condition) throw new Error(message);
};

// ── 1) Pure rank ladder ────────────────────────────────────────────────────
invariant(
  ROOF_RANK_ORDER.join('>') === 'palace>magistracy>city-gate>giwa',
  `public rank order drifted: ${ROOF_RANK_ORDER.join('>')}`,
);
invariant(
  compareRoofRank(ROOF_RANK.PALACE, ROOF_RANK.MAGISTRACY) > 0
    && compareRoofRank(ROOF_RANK.MAGISTRACY, ROOF_RANK.CITY_GATE) > 0
    && compareRoofRank(ROOF_RANK.CITY_GATE, ROOF_RANK.GIWA) > 0,
  'rank ladder is not strictly descending',
);
invariant(
  roofRankLevel('palace') === 3
    && roofRankLevel('magistracy') === 2
    && roofRankLevel('city-gate') === 1
    && roofRankLevel('giwa') === 0,
  'rank levels drifted',
);
invariant(
  normalizeRoofRank('gaeksa') === ROOF_RANK.MAGISTRACY
    && normalizeRoofRank('guest-house') === ROOF_RANK.MAGISTRACY
    && normalizeRoofRank('munru') === ROOF_RANK.CITY_GATE
    && normalizeRoofRank('temple') === ROOF_RANK.GIWA
    && normalizeRoofRank('unknown-rank') === null,
  'rank aliases drifted',
);

// ── 2) Context resolution ──────────────────────────────────────────────────
invariant(resolveRoofRank({ style: 'palace' }) === ROOF_RANK.PALACE,
  'standalone palace style must remain full palace rank');
invariant(resolveRoofRank({ kind: 'palace', placement: 'landmark' }) === ROOF_RANK.PALACE,
  'landmark palace feature lost palace rank');
invariant(resolveRoofRank({ family: 'palace-compound' }) === ROOF_RANK.PALACE,
  'palace compound family lost palace rank');
invariant(resolveRoofRank({ heroStyle: 'palace' }) === ROOF_RANK.MAGISTRACY,
  'heroStyle palace must resolve to magistracy, not full palace');
invariant(resolveRoofRank({ heroStyle: 'palace', kind: 'giwa' }) === ROOF_RANK.MAGISTRACY,
  'town/capital magistracy core misclassified');
invariant(resolveRoofRank({ roofRank: 'magistracy', style: 'palace' }) === ROOF_RANK.MAGISTRACY,
  'explicit magistracy rank lost to style');
invariant(resolveRoofRank({ roofRank: 'gaeksa' }) === ROOF_RANK.MAGISTRACY,
  'gaeksa alias must collapse to magistracy');
invariant(resolveRoofRank({ kind: 'city-gate' }) === ROOF_RANK.CITY_GATE,
  'city-gate kind lost its rank');
invariant(resolveRoofRank({ family: 'city-gate' }) === ROOF_RANK.CITY_GATE,
  'city-gate family lost its rank');
invariant(resolveRoofRank({ style: 'giwa' }) === ROOF_RANK.GIWA,
  'giwa style lost base rank');
invariant(resolveRoofRank({ style: 'temple' }) === ROOF_RANK.GIWA,
  'temple must deny palace ornaments via giwa-equivalent rank');
invariant(resolveRoofRank({ style: 'choga' }) === ROOF_RANK.GIWA,
  'choga must deny palace ornaments');
invariant(planHeroRoofRank('palace') === ROOF_RANK.MAGISTRACY
  && planHeroRoofRank('hanok') === ROOF_RANK.GIWA
  && planHeroRoofRank(null) === null,
  'plan hero roofRank helper drifted');

// ── 3) Ornament policy ─────────────────────────────────────────────────────
for (const rank of ROOF_RANK_ORDER) {
  const policy = roofOrnamentPolicy(rank);
  const allow = rank === ROOF_RANK.PALACE;
  invariant(policy.rank === rank, `ornament policy rank drifted for ${rank}`);
  invariant(policy.chwidu === allow && policy.japsang === allow,
    `${rank} ornament flags drifted (chwidu=${policy.chwidu}, japsang=${policy.japsang})`);
  invariant(policy.chwiduName === PALACE_CHWIDU_NAME
    && policy.japsangName === PALACE_JAPSANG_NAME,
    'palace ornament mesh names drifted');
  invariant(allowsPalaceRoofOrnaments(rank) === allow,
    `allowsPalaceRoofOrnaments(${rank}) drifted`);
}
invariant(!allowsPalaceRoofOrnaments({ heroStyle: 'palace' }),
  'magistracy hero context must not allow palace ornaments');
invariant(!allowsPalaceRoofOrnaments({ kind: 'city-gate' }),
  'city-gate context must not allow palace ornaments');
invariant(!allowsPalaceRoofOrnaments({ style: 'temple', roofType: 'paljak' }),
  'paljak temple must not allow palace ornaments');
invariant(allowsPalaceRoofOrnaments({ style: 'palace' }),
  'standalone palace style lost ornaments');
invariant(allowsPalaceRoofOrnaments({ roofRank: 'palace', style: 'giwa' }),
  'explicit palace rank must win over style');

// ── 4) Plan wiring: heroStyle cores expose roofRank ────────────────────────
function heroCore(scale) {
  const plan = planVillage({ seed: 7, scale });
  return plan.parcels.find((parcel) => parcel.hero) || null;
}

const townCore = heroCore('town');
invariant(townCore && townCore.heroStyle === 'palace',
  'town plan no longer reserves a palace-style magistracy core');
invariant(townCore.roofRank === ROOF_RANK.MAGISTRACY,
  `town magistracy core roofRank=${townCore.roofRank}, expected magistracy`);
invariant(resolveRoofRank(townCore) === ROOF_RANK.MAGISTRACY,
  'town core resolveRoofRank drifted');
invariant(!allowsPalaceRoofOrnaments(townCore),
  'town magistracy core must not allow japsang/chwidu');

const capitalCore = heroCore('capital');
// capital/hanyang may reserve multi-곽 palace instead of a hero magistracy.
if (capitalCore) {
  if (capitalCore.heroStyle === 'palace') {
    invariant(capitalCore.roofRank === ROOF_RANK.MAGISTRACY,
      `capital magistracy roofRank=${capitalCore.roofRank}`);
    invariant(!allowsPalaceRoofOrnaments(capitalCore),
      'capital magistracy must deny palace ornaments');
  }
}

const hanyang = planVillage({ seed: 7, scale: 'hanyang' });
invariant(hanyang.features?.palace?.roofRank === ROOF_RANK.PALACE
  || hanyang.features?.palace?.kind === 'palace',
  'hanyang palace feature lost palace rank wiring');
if (hanyang.features?.palace) {
  invariant(resolveRoofRank(hanyang.features.palace) === ROOF_RANK.PALACE,
    'hanyang palace feature must resolve to palace rank');
  invariant(allowsPalaceRoofOrnaments(hanyang.features.palace),
    'true palace feature must keep ornaments');
}

const hamlet = heroCore('hamlet');
invariant(hamlet && hamlet.heroStyle === 'hanok',
  'hamlet lost residential hero');
invariant(hamlet.roofRank === ROOF_RANK.GIWA || hamlet.roofRank == null,
  `hamlet hero roofRank unexpected: ${hamlet.roofRank}`);
invariant(!allowsPalaceRoofOrnaments(hamlet),
  'residential hero must not receive palace ornaments');

// ── 5) Source wiring: consumers must keep the pure policy as the ornament gate ─
const citywallSource = readFileSync(join(ROOT, 'src/village/citywall.js'), 'utf8');
invariant(!citywallSource.includes(PALACE_CHWIDU_NAME)
  && !citywallSource.includes(PALACE_JAPSANG_NAME),
  'citywall gate roof must not name palace ornaments');
invariant(citywallSource.includes("userData.roofRank = 'city-gate'"),
  'city-gate roof rank wiring missing from citywall.js');

const roofSource = readFileSync(join(ROOT, 'src/builder/roof.js'), 'utf8');
invariant(roofSource.includes('roofOrnamentPolicy')
  && roofSource.includes('resolveRoofRank'),
  'buildRoof no longer consumes roof-rank policy');
invariant(roofSource.includes('ornaments.chwidu') && roofSource.includes('ornaments.japsang'),
  'buildRoof must gate figures through roofOrnamentPolicy flags');
invariant(roofSource.includes(PALACE_CHWIDU_NAME) === false
  || roofSource.includes('ornaments.chwiduName')
  || roofSource.includes("name = ornaments.chwiduName")
  || roofSource.includes('chwidu.name = ornaments.chwiduName'),
  'chwidu mesh name must come from ornament policy');

const palaceSource = readFileSync(join(ROOT, 'src/village/palace.js'), 'utf8');
invariant(palaceSource.includes("roofRank: 'palace'"),
  'palace compound halls must pin roofRank palace');

const planSource = readFileSync(join(ROOT, 'src/village/plan.js'), 'utf8');
invariant(planSource.includes("roofRank: 'magistracy'"),
  'plan magistracy cores must author roofRank magistracy');
invariant(planSource.includes("roofRank: 'palace'"),
  'plan palace landmarks must author roofRank palace');

const featuresSource = readFileSync(join(ROOT, 'src/generators/village/features.js'), 'utf8');
invariant(featuresSource.includes('roofRank'),
  'hero parcel builder must forward roofRank');

const parcelSource = readFileSync(join(ROOT, 'src/layout/parcel.js'), 'utf8');
invariant(parcelSource.includes('roofRank'),
  'buildParcel must accept and forward roofRank into buildBuilding');

console.log(
  'ROOF RANK CONTRACT: PASS (ladder, plan wiring, ornament policy, source consumers, city-gate denial)',
);
