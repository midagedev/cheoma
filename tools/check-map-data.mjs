// Pure Node contract for packaging-plan P3 map-data export.
// Village (siteR 120) + hanyang-with-citywall: colliders, polygonize, metadata, terrain grid.
// Not registered in fast-checks — lead owns gate registration.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildMapColliders,
  buildMapMetadata,
  sampleTerrainHeightGrid,
} from '../src/api/map-data.js';
import { planVillage, CITY_WALL_MIN_SITE_R } from '../src/api/village-plan.js';
import {
  buildWalkSolids,
  pointHitsWalkSolids,
} from '../src/cinematic/walk-solids.js';
import { cityWallClearance, cityWallRadiusAt } from '../src/village/citywall-contour.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRATCH = join(ROOT, 'scratch', 'map-data-check');

const SEED = 7;
const VILLAGE_R = 120;
// Hanyang tier with a real city wall (CITY_WALL_MIN_SITE_R is far below hanyang; use R≥400).
const HANYANG_R = 450;
const CITY_WALL_STEP = 3;
const HIT_SAMPLES = 500;
const POLY_SAMPLES = 2000;
const POLY_MISMATCH_MAX = 0.02;
const BODY_R = 0.45;

const invariant = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

/** Deterministic LCG in [0,1). No Math.random. */
function makeLcg(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') {
    // Distinguish NaN (should not appear) and -0.
    if (typeof a === 'number') return Object.is(a, b);
    return false;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEqual(a[k], b[k])) return false;
  }
  return true;
}

/** Walk value tree: no function, undefined, or non-finite number. */
function assertJsonClean(value, label) {
  const seen = new Set();
  const walk = (v, path) => {
    if (v === undefined) throw new Error(`${label}: undefined at ${path}`);
    if (typeof v === 'function') throw new Error(`${label}: function at ${path}`);
    if (typeof v === 'number' && !Number.isFinite(v)) {
      throw new Error(`${label}: non-finite number at ${path}`);
    }
    if (v === null || typeof v !== 'object') return;
    if (seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) walk(v[i], `${path}[${i}]`);
      return;
    }
    for (const k of Object.keys(v)) walk(v[k], `${path}.${k}`);
  };
  walk(value, '$');
  // stringify must succeed and not emit undefined holes that drop keys silently in a bad way —
  // we already forbade undefined. Parse back and deep-equal.
  const text = JSON.stringify(value);
  invariant(typeof text === 'string' && text.length > 0, `${label}: empty stringify`);
  const parsed = JSON.parse(text);
  invariant(deepEqual(value, parsed), `${label}: JSON round-trip deepEqual failed`);
  return text;
}

function sampleBounds(plan) {
  const b = plan.bounds;
  if (b && Number.isFinite(b.minX)) {
    return { minX: b.minX, maxX: b.maxX, minZ: b.minZ, maxZ: b.maxZ };
  }
  const R = plan.site?.terrainR || plan.site?.R || 100;
  return { minX: -R, maxX: R, minZ: -R, maxZ: R };
}

function randomPoint(rand, bounds) {
  return {
    x: bounds.minX + rand() * (bounds.maxX - bounds.minX),
    z: bounds.minZ + rand() * (bounds.maxZ - bounds.minZ),
  };
}

function checkColliders(plan, label) {
  const a = buildMapColliders(plan);
  const b = buildMapColliders(plan);
  const textA = assertJsonClean(a, `${label} colliders A`);
  const textB = JSON.stringify(b);
  invariant(textA === textB, `${label}: colliders not deterministic`);
  invariant(a.schemaVersion === 1, `${label}: colliders schemaVersion`);
  invariant(a.convention?.south === '+z', `${label}: south convention`);
  invariant(a.convention?.units === 'meters', `${label}: units convention`);
  invariant(Array.isArray(a.solids) && a.solids.length > 0, `${label}: solids empty`);

  // JSON round-trip deep equal already in assertJsonClean; hit-test 500 seeded points.
  const original = buildWalkSolids(plan);
  const roundTripped = JSON.parse(textA).solids;
  const bounds = sampleBounds(plan);
  const rand = makeLcg(0xC0FFEE ^ (label.length * 997));
  let mismatches = 0;
  for (let i = 0; i < HIT_SAMPLES; i++) {
    const p = randomPoint(rand, bounds);
    const h0 = pointHitsWalkSolids(original, p.x, p.z, BODY_R);
    const h1 = pointHitsWalkSolids(roundTripped, p.x, p.z, BODY_R);
    if (h0 !== h1) mismatches++;
  }
  invariant(mismatches === 0, `${label}: collider hit mismatch ${mismatches}/${HIT_SAMPLES}`);

  return { colliders: a, bytes: textA.length, solidCount: a.solids.length };
}

function checkPolygonize(plan, label) {
  const cityWall = plan.features?.cityWall;
  if (!cityWall) {
    // Village scale has no city wall — still ensure option does not throw.
    const emptyPoly = buildMapColliders(plan, { polygonizeCityWall: true });
    assertJsonClean(emptyPoly, `${label} polygonize(no-wall)`);
    const hasCity = emptyPoly.solids.some((s) => s.type === 'citywall');
    invariant(!hasCity, `${label}: unexpected citywall after polygonize`);
    return { skipped: true, reason: 'no cityWall' };
  }

  const analytic = buildMapColliders(plan, { polygonizeCityWall: false });
  const polyPack = buildMapColliders(plan, {
    polygonizeCityWall: true,
    cityWallStep: CITY_WALL_STEP,
  });
  assertJsonClean(polyPack, `${label} polygonized colliders`);
  invariant(
    !polyPack.solids.some((s) => s.type === 'citywall'),
    `${label}: citywall solid remained after polygonize`,
  );
  invariant(
    polyPack.solids.some((s) => s.type === 'poly' && s.source === 'citywall-polygonized'),
    `${label}: no polygonized citywall strips`,
  );

  const analyticSolids = analytic.solids;
  const polySolids = polyPack.solids;
  const half = analyticSolids.find((s) => s.type === 'citywall')?.half ?? 1.3;
  const spec = cityWall;

  // Sample in a radial band around the wall so the comparison is meaningful.
  // 2026-08-08 계측기 수정(FAIL-first: meanRadius 중심 밴드는 비원형 contour에서
  // 표본 2000 중 120개만 벽 근처에 떨어져 mismatch 0%가 허공 측정이었다 —
  // 실측 contour 반경 변동 196~324m vs 밴드 ±11m). 각도별 실제 contour 반경을
  // 중심으로 밴드를 잡아 모든 표본이 벽면 판정 대역을 지나게 한다.
  const rand = makeLcg(0xBEEF ^ Math.round(spec.meanRadius || 200));
  let mismatches = 0;
  let offBand = 0;
  for (let i = 0; i < POLY_SAMPLES; i++) {
    const angle = rand() * Math.PI * 2;
    // Radial offset: wall centerline ± a few half-thicknesses + step.
    const radial = cityWallRadiusAt(spec, angle) + (rand() - 0.5) * (half * 8 + CITY_WALL_STEP * 4);
    const x = spec.cx + Math.sin(angle) * radial;
    const z = spec.cz + Math.cos(angle) * radial;
    const h0 = pointHitsWalkSolids(analyticSolids, x, z, 0);
    const h1 = pointHitsWalkSolids(polySolids, x, z, 0);
    if (h0 === h1) continue;
    mismatches++;
    // Boundary band: radial distance to wall surface within ±step.
    const clearance = Math.abs(cityWallClearance(spec, { x, z }));
    const distToSurface = Math.abs(clearance - half);
    if (distToSurface > CITY_WALL_STEP) offBand++;
  }
  const rate = mismatches / POLY_SAMPLES;
  invariant(
    rate < POLY_MISMATCH_MAX,
    `${label}: polygonize mismatch rate ${(rate * 100).toFixed(2)}% >= ${POLY_MISMATCH_MAX * 100}% (${mismatches}/${POLY_SAMPLES})`,
  );
  invariant(
    offBand === 0,
    `${label}: ${offBand} polygonize mismatches outside ±${CITY_WALL_STEP}m wall-surface band`,
  );
  return {
    skipped: false,
    mismatchRate: rate,
    mismatches,
    polyStrips: polyPack.solids.filter((s) => s.source === 'citywall-polygonized').length,
  };
}

function checkMetadata(plan, label) {
  const a = buildMapMetadata(plan);
  const b = buildMapMetadata(plan);
  const textA = assertJsonClean(a, `${label} metadata A`);
  const textB = JSON.stringify(b);
  invariant(textA === textB, `${label}: metadata not deterministic`);
  invariant(a.schemaVersion === 1, `${label}: metadata schemaVersion`);
  invariant(a.buildings.length === (plan.parcels || []).length, `${label}: buildings count != parcels`);
  invariant(a.seed === plan.seed, `${label}: seed`);
  invariant(a.scale === plan.scale, `${label}: scale`);
  // House bodies only for giwa/choga non-empty when walk-solids would emit them.
  for (const bld of a.buildings) {
    invariant(bld.parcelId != null, `${label}: building missing parcelId`);
    invariant(bld.center && Number.isFinite(bld.center.x), `${label}: building center`);
    invariant(Array.isArray(bld.houseBodies), `${label}: houseBodies array`);
    if (bld.gate) {
      invariant(Number.isFinite(bld.gate.x) && Number.isFinite(bld.gate.z), `${label}: gate xz`);
    }
  }
  return { metadata: a, bytes: textA.length };
}

function checkTerrain(plan, label) {
  const a = sampleTerrainHeightGrid(plan, { step: 4 });
  const b = sampleTerrainHeightGrid(plan, { step: 4 });
  const textA = assertJsonClean(a, `${label} terrain A`);
  const textB = JSON.stringify(b);
  invariant(textA === textB, `${label}: terrain not deterministic`);
  invariant(a.schemaVersion === 1, `${label}: terrain schemaVersion`);
  invariant(a.nx * a.nz === a.heights.length, `${label}: nx*nz != heights.length`);
  invariant(a.heights.every((h) => Number.isFinite(h)), `${label}: non-finite height`);
  invariant(a.nx > 1 && a.nz > 1, `${label}: grid too small`);
  return { terrain: a, bytes: textA.length };
}

function runScale(siteR, label) {
  console.log(`\n── ${label} (seed=${SEED}, siteR=${siteR}) ──`);
  const plan = planVillage({ seed: SEED, siteR });
  invariant(plan?.parcels?.length > 0, `${label}: plan has no parcels`);
  console.log(`  scale=${plan.scale} parcels=${plan.parcels.length} cityWall=${!!plan.features?.cityWall}`);
  if (label === 'hanyang') {
    invariant(plan.features?.cityWall, `${label}: expected cityWall (siteR ${siteR} >= ${CITY_WALL_MIN_SITE_R})`);
  }

  const col = checkColliders(plan, label);
  console.log(`  colliders: solids=${col.solidCount} json=${(col.bytes / 1024).toFixed(1)} KB`);

  const poly = checkPolygonize(plan, label);
  if (poly.skipped) {
    console.log(`  polygonize: skipped (${poly.reason})`);
  } else {
    console.log(
      `  polygonize: strips=${poly.polyStrips} mismatch=${(poly.mismatchRate * 100).toFixed(3)}% (${poly.mismatches}/${POLY_SAMPLES})`,
    );
  }

  const meta = checkMetadata(plan, label);
  console.log(`  metadata: buildings=${meta.metadata.buildings.length} json=${(meta.bytes / 1024).toFixed(1)} KB`);

  const terr = checkTerrain(plan, label);
  console.log(
    `  terrain: ${terr.terrain.nx}×${terr.terrain.nz} step=${terr.terrain.step} json=${(terr.bytes / 1024).toFixed(1)} KB`,
  );

  return { plan, col, poly, meta, terr };
}

// ── main ──────────────────────────────────────────────────────────────
const village = runScale(VILLAGE_R, 'village');
const hanyang = runScale(HANYANG_R, 'hanyang');

// Real JSON files for village (size report for the completion gate).
mkdirSync(SCRATCH, { recursive: true });
const files = {
  colliders: join(SCRATCH, 'village-colliders.json'),
  metadata: join(SCRATCH, 'village-metadata.json'),
  terrain: join(SCRATCH, 'village-terrain.json'),
};
writeFileSync(files.colliders, JSON.stringify(village.col.colliders));
writeFileSync(files.metadata, JSON.stringify(village.meta.metadata));
writeFileSync(files.terrain, JSON.stringify(village.terr.terrain));

const { statSync } = await import('node:fs');
const sizes = Object.fromEntries(
  Object.entries(files).map(([k, p]) => [k, (statSync(p).size / 1024).toFixed(1) + ' KB']),
);

console.log('\n── village JSON files ──');
for (const [k, p] of Object.entries(files)) {
  console.log(`  ${k}: ${p} (${sizes[k]})`);
}

console.log('\ncheck-map-data: PASS');
console.log(JSON.stringify({
  village: {
    solids: village.col.solidCount,
    buildings: village.meta.metadata.buildings.length,
    terrain: `${village.terr.terrain.nx}x${village.terr.terrain.nz}`,
    files: sizes,
  },
  hanyang: {
    solids: hanyang.col.solidCount,
    buildings: hanyang.meta.metadata.buildings.length,
    cityWall: true,
    polyMismatchPct: hanyang.poly.skipped ? null : +(hanyang.poly.mismatchRate * 100).toFixed(3),
  },
}, null, 2));
