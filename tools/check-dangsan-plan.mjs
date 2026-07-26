import { performance } from 'node:perf_hooks';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { planVillage } from '../src/api/village-plan.js';
import {
  DANGSAN_PLAN_LIMITS,
  DANGSAN_PLAN_SCHEMA_VERSION,
  dangsanHardObstacles,
  planDangsan,
  validateDangsanPlan,
} from '../src/api/dangsan-plan.js';
import * as G from '../src/core/math/geom2.js';
import { createRoadSpatialIndex } from '../src/village/road-spatial.js';
import { streamClearanceAt } from '../src/village/stream-spatial.js';
import { circleBlocksSolarAccess } from '../src/village/solar-access.js';
import { circleIntersectsPolygon } from '../src/village/parcel-contract.js';

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function deepFrozen(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return true;
  seen.add(value);
  return Object.isFrozen(value) && Object.values(value).every((child) => deepFrozen(child, seen));
}

function inputSnapshot(village) {
  return JSON.stringify({
    guardians: village.features?.guardianTrees,
    parcels: village.parcels,
    roads: village.roads,
    paddies: village.paddies,
    props: village.features?.props,
    pavilion: village.features?.pavilion,
  });
}

function planFromVillage(village, dangsanOpt) {
  const before = inputSnapshot(village);
  const originalRandom = Math.random;
  Math.random = () => { throw new Error('dangsan plan consumed global Math.random'); };
  let plan;
  try {
    plan = planDangsan({
      scale: village.scale,
      seed: village.seed,
      site: village.site,
      guardians: village.features.guardianTrees,
      parcels: village.parcels,
      roads: village.roads,
      paddies: village.paddies || [],
      pavilion: village.features.pavilion,
      props: village.features.props,
      cityWall: village.features.cityWall,
      dangsan: dangsanOpt,
    });
  } finally {
    Math.random = originalRandom;
  }
  invariant(inputSnapshot(village) === before, `${village.scale} dangsan mutated village inputs`);
  return plan;
}

function assertSpatial(village, plan) {
  validateDangsanPlan(plan);
  validateDangsanPlan(JSON.parse(JSON.stringify(plan)));
  invariant(plan.schema === DANGSAN_PLAN_SCHEMA_VERSION, 'schema version drift');
  invariant(deepFrozen(plan), `${village.scale} dangsan is not deeply frozen`);
  invariant(plan.sites.length <= DANGSAN_PLAN_LIMITS.maxSites, 'site cap exceeded');

  if (!DANGSAN_PLAN_LIMITS.eligibleScales.includes(village.scale)) {
    invariant(plan.sites.length === 0,
      `${village.scale} must fail closed without dangsan cultural landscape`);
  }

  const roadSpatial = createRoadSpatialIndex(village.roads || []);
  const guardians = village.features?.guardianTrees || [];
  for (const site of plan.sites) {
    const host = guardians.find((tree) => (
      Math.abs(tree.x - site.tree.x) <= 1e-9
      && Math.abs(tree.z - site.tree.z) <= 1e-9
    ));
    invariant(host, `${site.id} lost its host guardian`);
    invariant(
      G.dist(site.clearing, site.tree) + site.clearing.radius <= site.tree.radius + 1e-6,
      `${site.id} clearing escapes host canopy`,
    );
    invariant(
      G.dist(site.clearing, site.tree) + 1e-6
        >= DANGSAN_PLAN_LIMITS.trunkClearance + site.clearing.radius,
      `${site.id} clearing collides with trunk base`,
    );
    invariant(
      !roadSpatial.withinRoadClearance(
        site.clearing,
        null,
        site.clearing.radius + DANGSAN_PLAN_LIMITS.roadClearance,
      ),
      `${site.id} clearing enters a road corridor`,
    );
    invariant(
      streamClearanceAt(village.site, site.clearing)
        + 1e-7 >= site.clearing.radius + DANGSAN_PLAN_LIMITS.streamClearance,
      `${site.id} clearing enters the stream reservation`,
    );
    for (const parcel of village.parcels || []) {
      invariant(
        !circleIntersectsPolygon(
          site.clearing,
          site.clearing.radius + DANGSAN_PLAN_LIMITS.parcelClearance,
          parcel.poly,
        ),
        `${site.id} clearing intersects parcel ${parcel.id}`,
      );
    }
    if (site.dangjip) {
      const shed = site.dangjip;
      const radius = Math.hypot(
        shed.body.width * 0.5 + shed.roof.overhang,
        shed.body.depth * 0.5 + shed.roof.overhang,
      );
      invariant(
        G.dist(shed, site.tree) + radius <= site.tree.radius + 1e-6,
        `${site.id} dangjip escapes host canopy`,
      );
      const obstacle = {
        x: shed.x,
        z: shed.z,
        radius,
        height: shed.body.height + shed.roof.rise,
        baseY: shed.surfaceY,
      };
      for (const parcel of village.parcels || []) {
        invariant(
          !circleBlocksSolarAccess(parcel, obstacle, village.site),
          `${site.id} dangjip blocks solar of ${parcel.id}`,
        );
      }
      invariant(
        !roadSpatial.withinRoadClearance(
          shed,
          null,
          radius + DANGSAN_PLAN_LIMITS.roadClearance,
        ),
        `${site.id} dangjip enters a road corridor`,
      );
    }
  }

  const hard = dangsanHardObstacles(plan);
  invariant(hard.length === 0 || plan.sites.length > 0, 'hard obstacles without sites');
}

const source = readFileSync(fileURLToPath(
  new URL('../src/village/dangsan-plan.js', import.meta.url),
), 'utf8');
invariant(!/from\s+['"]three['"]|\bTHREE\b|\bdocument\b|\bwindow\b/.test(source),
  'dangsan plan imported a renderer or DOM dependency');

const started = performance.now();
let forcedHits = 0;
let autoHits = 0;
let autoTrials = 0;

// Forced opt-in must place a site on ordinary rural fixtures when a guardian exists.
for (const scale of ['hamlet', 'village']) {
  for (const seed of [7, 11, 42, 91, 20260716, 150, 314]) {
    const village = planVillage({ scale, seed, dangsan: true });
    const first = planFromVillage(village, true);
    const second = planFromVillage(village, true);
    invariant(JSON.stringify(first) === JSON.stringify(second),
      `${scale}/${seed} forced dangsan is not deterministic`);
    invariant(JSON.stringify(village.dangsan) === JSON.stringify(first),
      `${scale}/${seed} integrated village dangsan drifted from pure planner`);
    assertSpatial(village, first);
    if (first.sites.length) forcedHits++;
    console.log(`${scale.padEnd(8)} seed=${String(seed).padStart(8)} forced `
      + `sites=${first.sites.length} dangjip=${first.sites[0]?.dangjip ? 1 : 0} `
      + `reason=${first.reason}`);
  }
}
invariant(forcedHits >= 4, `forced opt-in placed too few sites (${forcedHits})`);

// Auto low-rate: most seeds empty; at least one hit across a broad seed sweep is required
// so the feature is not permanently dead, without claiming a national frequency.
for (const scale of ['hamlet', 'village']) {
  for (let seed = 0; seed < 48; seed++) {
    const village = planVillage({ scale, seed });
    const plan = planFromVillage(village, undefined);
    assertSpatial(village, plan);
    autoTrials++;
    if (plan.sites.length) autoHits++;
  }
}
const autoRate = autoHits / autoTrials;
invariant(autoRate > 0 && autoRate < 0.45,
  `auto rate out of product band: ${(autoRate * 100).toFixed(1)}% of ${autoTrials}`);
console.log(`auto-rate ${(autoRate * 100).toFixed(1)}% (${autoHits}/${autoTrials})`);

// Off and ineligible scales stay empty.
for (const scale of ['hamlet', 'village', 'town', 'capital', 'hanyang']) {
  const village = planVillage({
    scale,
    seed: 11,
    dangsan: false,
    includePalace: scale === 'capital' || scale === 'hanyang',
  });
  const plan = planFromVillage(village, false);
  assertSpatial(village, plan);
  invariant(plan.sites.length === 0, `${scale} dangsan:false must be empty`);
}
for (const scale of ['town', 'capital', 'hanyang']) {
  const village = planVillage({
    scale,
    seed: 11,
    dangsan: true,
    includePalace: scale === 'capital' || scale === 'hanyang',
  });
  const plan = planFromVillage(village, true);
  assertSpatial(village, plan);
  invariant(plan.sites.length === 0, `${scale} remains ineligible even when forced`);
}

console.log(`DANGSAN PLAN: PASS (forcedHits=${forcedHits}, auto=${autoHits}/${autoTrials}, `
  + `${(performance.now() - started).toFixed(0)}ms)`);
