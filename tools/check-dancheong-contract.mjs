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

// 사대문 문루 단청(#19 R3, 2026-07-31 사용자 승인). 궁과 같은 모로 축을 쓰되 위계는 한 단 아래이고,
// source bucket 은 자기 이름공간을 가져 궁 캐시를 오염시키지 않는다. giwa/choga 거부는 불변이다.
const cityGate = resolveDancheong('city-gate');
invariant(cityGate, 'city gate 문루는 단청 대상이어야 한다(2026-07-31 승인)');
invariant(cityGate.grade === 'moro', `city gate must stay moro-class, got ${cityGate.grade}`);
invariant(cityGate.dancheongSplendor < DANCHEONG_DEFAULTS.palace.dancheongSplendor
  && cityGate.dancheongClarity < DANCHEONG_DEFAULTS.palace.dancheongClarity,
'city gate 단청이 궁 정전보다 화려하다 — 위계가 뒤집혔다');
invariant(PRESETS.korea.dancheongClarity !== undefined, 'palace preset lost its dancheong axes');
const cityGateKey = dancheongSourceKey(cityGate, 'band');
invariant(cityGateKey.startsWith('city-gate:'), `city gate bucket is not namespaced: ${cityGateKey}`);
for (const kind of ['band', 'face', 'round', 'square']) {
  invariant(dancheongSourceKey(cityGate, kind) !== dancheongSourceKey(palace, kind),
    `city gate shares the palace ${kind} source bucket`);
  invariant(dancheongSourceKey(cityGate, kind) !== dancheongSourceKey(temple, kind),
    `city gate shares the temple ${kind} source bucket`);
}
invariant(dancheongSourceKey(cityGate, 'band') === dancheongSourceKey(resolveDancheong('city-gate'), 'band'),
  'city gate source key is unstable');
// 축 자체는 살아 있어야 한다(리드가 격식을 올릴 여지). 다만 기본값은 모로로 고정된다.
invariant(resolveDancheong('city-gate', { dancheongSplendor: 0.9 }).grade === 'geum',
  'city gate splendour axis is dead');
// 승인 범위는 성문 문루뿐이다 — 이 확장으로 민가·반가에 단청이 새면 무효.
invariant(resolveDancheong('giwa') === null && resolveDancheong('choga') === null,
  'city-gate rank extension leaked dancheong into giwa/choga');
invariant(resolveDancheong('hanok') === null && resolveDancheong('gate') === null
  && resolveDancheong(undefined) === null,
'unknown styles must not resolve dancheong');
const citywallSource = readFileSync(new URL('../src/village/citywall.js', import.meta.url), 'utf8');
invariant(citywallSource.includes('makeCityGateDancheong'),
  '문루 단청이 정식 rank 경로(palette 팩토리)로 오지 않는다');
for (const literal of ['noerok', 'juhong', 'samcheong', '0x2e7257', '0xc84631']) {
  invariant(!citywallSource.includes(literal),
    `citywall.js hardcodes a dancheong pigment (${literal}) instead of the rank policy`);
}

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
