// Fast, renderer-free contract for #56. Keep historical scope, rank defaults and
// public edit routing testable without starting Vite/Chromium.
import { readFileSync } from 'node:fs';
import {
  DANCHEONG_BUCKET_STEPS,
  DANCHEONG_DEFAULTS,
  dancheongGrade,
  dancheongSourceKey,
  resolveDancheong,
  resolveTempleRoleDancheong,
} from '../src/builder/dancheong.js';
import { PRESETS } from '../src/params.js';
import { buildRebuildPayload, schemaFor } from '../app/src/lib/edit-schema.js';

const invariant = (condition, message) => {
  if (!condition) throw new Error(message);
};

const fieldKeys = (schema) => schema.sections.flatMap((section) => section.fields.map((field) => field.key));
const dancheongKeys = ['dancheongClarity', 'dancheongSplendor'];
const includesDancheong = (schema) => dancheongKeys.every((key) => fieldKeys(schema).includes(key));

const palace = resolveDancheong('palace');
const temple = resolveDancheong('temple');
invariant(palace.grade === 'moro', `palace default must be moro, got ${palace.grade}`);
invariant(temple.grade === 'geum', `temple main-hall default must be geum, got ${temple.grade}`);
invariant(PRESETS.korea.dancheongClarity === DANCHEONG_DEFAULTS.palace.dancheongClarity,
  'palace preset drifted from reusable dancheong defaults');
invariant(PRESETS.temple.dancheongSplendor === DANCHEONG_DEFAULTS.temple.dancheongSplendor,
  'temple preset drifted from reusable dancheong defaults');

const clamped = resolveDancheong('palace', { dancheongClarity: -8, dancheongSplendor: 9 });
invariant(clamped.dancheongClarity === 0 && clamped.dancheongSplendor === 1,
  'public dancheong axes are not clamped');
invariant(clamped.clarityBucket === 0 && clamped.splendorBucket === DANCHEONG_BUCKET_STEPS,
  'source bucket clamp drifted');
invariant(resolveDancheong('giwa') === null && resolveDancheong('choga') === null,
  'ordinary giwa/choga must not receive dancheong');
invariant(dancheongGrade(0.2) === 'moro'
  && dancheongGrade(0.55) === 'geummoro'
  && dancheongGrade(0.9) === 'geum', 'rank thresholds drifted');
invariant(dancheongSourceKey(palace, 'band') === dancheongSourceKey(resolveDancheong('palace'), 'band'),
  'same dancheong input produced an unstable source key');

const mainHall = resolveTempleRoleDancheong(temple, { role: 'main-hall', formality: 'hall' });
const subsidiary = resolveTempleRoleDancheong(temple, { role: 'subsidiary-hall', formality: 'hall' });
const domestic = resolveTempleRoleDancheong(temple, { role: 'yosa', formality: 'domestic' });
invariant(mainHall.grade === 'geum', 'temple central worship hall lost geum rank');
invariant(subsidiary.grade === 'geummoro', 'temple subsidiary hall should step down to geummoro');
invariant(domestic.grade === 'moro', 'temple domestic hall should step down to moro');
invariant(mainHall.dancheongSplendor > subsidiary.dancheongSplendor
  && subsidiary.dancheongSplendor > domestic.dancheongSplendor,
  'temple rank hierarchy is not strictly descending');

const palaceHero = { hero: true, heroStyle: 'palace', family: 'hero' };
const palaceCompound = { family: 'palace-compound' };
const templeCompound = {
  family: 'temple',
  params: { variant: 'courtyard' },
  variantOptions: ['compact', 'courtyard'],
  hallRange: { min: 3, max: 4 },
};
invariant(includesDancheong(schemaFor(palaceHero)), 'palace hero panel hides dancheong controls');
invariant(includesDancheong(schemaFor(palaceCompound)), 'palace compound panel hides dancheong controls');
invariant(includesDancheong(schemaFor(templeCompound)), 'temple panel hides dancheong controls');
invariant(!includesDancheong(schemaFor({ kind: 'giwa' })), 'giwa panel leaked dancheong controls');
invariant(!includesDancheong(schemaFor({ kind: 'choga' })), 'choga panel leaked dancheong controls');

const palacePayload = buildRebuildPayload(palaceCompound, {
  dancheongClarity: 0.24, dancheongSplendor: 0.76,
});
invariant(palacePayload.presetOverrides?.dancheongClarity === 0.24
  && palacePayload.presetOverrides?.dancheongSplendor === 0.76,
  'palace controls do not route through public presetOverrides');
const templePayload = buildRebuildPayload(templeCompound, {
  variant: 'courtyard', dancheongClarity: 0.34, dancheongSplendor: 0.88,
});
invariant(templePayload.templeOptions?.dancheongClarity === 0.34
  && templePayload.templeOptions?.dancheongSplendor === 0.88,
  'temple controls do not route through public templeOptions');

const source = readFileSync(new URL('../src/builder/dancheong.js', import.meta.url), 'utf8');
invariant(!source.includes('Math.random'), 'dancheong painter consumed global Math.random');

console.log('DANCHEONG CONTRACT: PASS (scope, rank hierarchy, buckets, public panel routing)');
