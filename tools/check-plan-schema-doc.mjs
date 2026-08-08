// Packaging P1: docs/plan-schema.md path inventory must match measured planVillage keys.
// 표본 = 실제 SCALE_ANCHORS 5규모(CLI --scale이 내는 바로 그 plan) + packaging-plan §1.2의
// 임의 밴드 4개. 2026-08-08 계측기 수정(FAIL-first): 고정 밴드 60/120/250/400만 돌면
// capital 티어 대역(앵커 siteR 280)을 건너뛰어 features.govCore 등 티어 전용 키가
// 문서 inventory에서 새는 것을 실측으로 확인했다.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planVillage, SCALE_ANCHORS } from '../src/api/village-plan.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOC = join(ROOT, 'docs/plan-schema.md');
const BANDS = [
  { label: 'hamlet-band', siteR: 60 },
  { label: 'village-band', siteR: 120 },
  { label: 'town-band', siteR: 250 },
  { label: 'capital-band', siteR: 400 },
  ...SCALE_ANCHORS.map((a) => ({ label: `anchor-${a.name}`, siteR: a.siteR })),
];
const SEED = 7;

function collectPaths(plan) {
  const paths = new Set();
  if (!plan || typeof plan !== 'object') return paths;
  for (const key of Object.keys(plan)) paths.add(key);

  if (plan.site && typeof plan.site === 'object' && !Array.isArray(plan.site)) {
    for (const key of Object.keys(plan.site)) paths.add(`site.${key}`);
  }
  if (Array.isArray(plan.roads)) {
    for (const road of plan.roads) {
      if (!road || typeof road !== 'object') continue;
      for (const key of Object.keys(road)) paths.add(`roads[].${key}`);
    }
  }
  if (Array.isArray(plan.parcels)) {
    for (const parcel of plan.parcels) {
      if (!parcel || typeof parcel !== 'object') continue;
      for (const key of Object.keys(parcel)) paths.add(`parcels[].${key}`);
    }
  }
  if (Array.isArray(plan.paddies)) {
    for (const paddy of plan.paddies) {
      if (!paddy || typeof paddy !== 'object') continue;
      for (const key of Object.keys(paddy)) paths.add(`paddies[].${key}`);
    }
  }
  if (plan.features && typeof plan.features === 'object' && !Array.isArray(plan.features)) {
    for (const key of Object.keys(plan.features)) paths.add(`features.${key}`);
  }
  return paths;
}

function parseDocPaths(markdown) {
  const fence = markdown.match(/```plan-paths\r?\n([\s\S]*?)```/);
  if (!fence) {
    throw new Error('docs/plan-schema.md missing ```plan-paths fenced inventory');
  }
  const paths = new Set();
  for (const line of fence[1].split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    paths.add(trimmed);
  }
  if (paths.size === 0) {
    throw new Error('docs/plan-schema.md plan-paths inventory is empty');
  }
  return paths;
}

function measurePaths() {
  const all = new Set();
  const perBand = [];
  for (const band of BANDS) {
    const live = planVillage({ seed: SEED, siteR: band.siteR });
    // JSON contract only (functions dropped) — same surface as CLI output.
    const plan = JSON.parse(JSON.stringify(live));
    const paths = collectPaths(plan);
    perBand.push({ ...band, count: paths.size, parcels: plan.parcels?.length ?? 0 });
    for (const p of paths) all.add(p);
  }
  return { all, perBand };
}

const docText = readFileSync(DOC, 'utf8');
const documented = parseDocPaths(docText);
const { all: measured, perBand } = measurePaths();

const missingInDoc = [...measured].filter((p) => !documented.has(p)).sort();
const extraInDoc = [...documented].filter((p) => !measured.has(p)).sort();

console.log('check-plan-schema-doc: measured bands');
for (const b of perBand) {
  console.log(`  ${b.label} siteR=${b.siteR} parcels=${b.parcels} paths=${b.count}`);
}
console.log(`  union paths: ${measured.size}`);
console.log(`  documented paths: ${documented.size}`);

if (missingInDoc.length || extraInDoc.length) {
  console.error('FAIL: plan-schema path inventory mismatch');
  if (missingInDoc.length) {
    console.error(`  measured but not documented (${missingInDoc.length}):`);
    for (const p of missingInDoc) console.error(`    + ${p}`);
  }
  if (extraInDoc.length) {
    console.error(`  documented but not measured (${extraInDoc.length}):`);
    for (const p of extraInDoc) console.error(`    - ${p}`);
  }
  process.exit(1);
}

console.log('PASS: plan-schema path inventory matches measured planVillage keys');
