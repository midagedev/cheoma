// 마당나무와 부속채·장독대 등 hard yard object의 공유 배치 계약.
// 실제 gardens renderer를 Node에서 번들해 대표 seed의 최종 anchor를 검사한다.
import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planVillage } from '../src/api/village-plan.js';
import { parcelLocalPoint } from '../src/village/parcel-contract.js';
import {
  yardHardObstacles,
  yardTreeIntersectsHardObstacle,
} from '../src/village/yard-layout.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const requireApp = createRequire(join(ROOT, 'app', 'package.json'));
const esbuild = requireApp('esbuild');
const THREE_MAIN = join(ROOT, 'app/node_modules/three/build/three.module.js');
const THREE_ADDONS = join(ROOT, 'app/node_modules/three/examples/jsm');
const SCALES = ['hamlet', 'village', 'town', 'capital', 'hanyang'];
const SEEDS = [7, 42, 20260716];
const PR36_TREE_BASELINES = {
  'hamlet:7': 2, 'hamlet:42': 3, 'hamlet:20260716': 2,
  'village:7': 5, 'village:42': 3, 'village:20260716': 2,
  'town:7': 17, 'town:42': 14, 'town:20260716': 6,
  'capital:7': 6, 'capital:42': 8, 'capital:20260716': 7,
  'hanyang:7': 134, 'hanyang:42': 116, 'hanyang:20260716': 108,
};
const PR36_TREE_BASELINE = Object.values(PR36_TREE_BASELINES)
  .reduce((sum, count) => sum + count, 0);
const MIN_TREE_RETENTION = 0.94;
// #40 changes the ground under otherwise identical yard grammar, so one seed may
// move enough valid parcels to retain 80% of the old PR #36 tree count. The 94%
// aggregate floor and every exact hard-object intersection assertion stay strict.
const MIN_CASE_TREE_RETENTION = 0.80;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

const built = await esbuild.build({
  stdin: {
    contents: "export { buildVillageFlora } from './src/village/gardens.js';",
    resolveDir: ROOT,
    sourcefile: 'yard-layout-contract-entry.js',
  },
  alias: { 'three/addons': THREE_ADDONS, three: THREE_MAIN },
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  write: false,
  logLevel: 'silent',
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString('base64')}`;
const { buildVillageFlora } = await import(moduleUrl);

function disposeFlora(flora) {
  flora.group.traverse((object) => object.geometry?.dispose?.());
}

function buildFixture(scale, seed) {
  const plan = planVillage({
    scale,
    seed,
    includePalace: scale === 'capital' || scale === 'hanyang',
  });
  const flora = buildVillageFlora(plan, plan.site, plan.seed);
  return { plan, flora };
}

function snapshotParcel(fixture, parcelId) {
  const parcel = fixture.plan.parcels.find((candidate) => candidate.id === parcelId);
  invariant(parcel, `${fixture.plan.scale}:${fixture.plan.seed} lost ${parcelId}`);
  return fixture.flora.yardTreeAnchors
    .filter((anchor) => anchor.parcelId === parcelId)
    .map((anchor) => ({
      species: anchor.species,
      radius: anchor.radius,
      trunkRadius: anchor.trunkRadius,
      local: parcelLocalPoint(parcel, anchor),
    }));
}

// Low objects use the trunk/base radius so natural crown overhang remains possible;
// roofs, stacks, and tall lines use the full canopy radius.
const semanticPoint = { x: 2, z: 0 };
const footprint = { trunkRadius: 0.1, canopyRadius: 2 };
const lowObstacle = [{
  kind: 'low', mode: 'trunk', shape: 'rect', x: 0, z: 0, halfWidth: 1, halfDepth: 1,
}];
const tallObstacle = [{ ...lowObstacle[0], kind: 'tall', mode: 'canopy' }];
invariant(!yardTreeIntersectsHardObstacle(semanticPoint, footprint, lowObstacle),
  'low hard props incorrectly reject natural canopy overhang');
invariant(yardTreeIntersectsHardObstacle(semanticPoint, footprint, tallObstacle),
  'tall hard props ignored the canopy footprint');

let plans = 0, plannedTrees = 0, renderedTrees = 0;
const fixtures = new Map();
for (const scale of SCALES) for (const seed of SEEDS) {
  const fixture = buildFixture(scale, seed);
  fixtures.set(`${scale}:${seed}`, fixture);
  const parcelById = new Map(fixture.plan.parcels.map((parcel) => [parcel.id, parcel]));
  plannedTrees += fixture.plan.parcels.reduce(
    (count, parcel) => count + (parcel.courtyardTree?.species?.length || 0), 0,
  );
  const renderedInCase = fixture.flora.yardTreeAnchors.length;
  const caseKey = `${scale}:${seed}`;
  const caseBaseline = PR36_TREE_BASELINES[caseKey];
  invariant(caseBaseline > 0, `${caseKey} has no PR #36 tree baseline`);
  invariant(renderedInCase / caseBaseline >= MIN_CASE_TREE_RETENTION,
    `${caseKey} hard-yard clearance over-pruned trees (${renderedInCase}/${caseBaseline})`);
  renderedTrees += renderedInCase;
  plans++;

  for (const [index, anchor] of fixture.flora.yardTreeAnchors.entries()) {
    const parcel = parcelById.get(anchor.parcelId);
    invariant(parcel, `${scale}:${seed}:yard ${index} lost owner ${anchor.parcelId}`);
    invariant(anchor.radius > 0 && anchor.trunkRadius > 0,
      `${scale}:${seed}:${anchor.parcelId} has an invalid tree footprint`);
    const local = parcelLocalPoint(parcel, anchor);
    const gardenOptions = Number.isFinite(anchor.hwagyeX)
      ? { exact: true, side: anchor.gardenSide, hwagyeX: anchor.hwagyeX }
      : undefined;
    const blocked = yardTreeIntersectsHardObstacle(local, {
      canopyRadius: anchor.radius,
      trunkRadius: anchor.trunkRadius,
    }, yardHardObstacles(parcel, gardenOptions));
    invariant(!blocked,
      `${scale}:${seed}:${anchor.parcelId} ${anchor.species} intersects a hard yard object`);
  }
}

const retention = renderedTrees / PR36_TREE_BASELINE;
invariant(retention >= MIN_TREE_RETENTION,
  `hard-yard clearance over-pruned trees (${renderedTrees}/${PR36_TREE_BASELINE}, ${(retention * 100).toFixed(1)}%)`);

// Exact pre-fix collisions found while triaging #17. The bad points must remain
// reserved, while their parcels retain the intended fruit-tree presence elsewhere.
const hamlet = fixtures.get('hamlet:7');
const hamletHero = hamlet.plan.parcels.find((parcel) => parcel.id === 'p0');
invariant(yardTreeIntersectsHardObstacle(
  { x: -12, z: -11 }, { trunkRadius: 0.1, canopyRadius: 0.1 }, yardHardObstacles(hamletHero),
), 'hamlet:7:p0 old jangdok collision is no longer reserved');
const hamletAnchors = snapshotParcel(hamlet, 'p0');
invariant(hamletAnchors.length === 2, `hamlet:7:p0 retained ${hamletAnchors.length}/2 trees`);

const hanyang = fixtures.get('hanyang:7');
const hanyangAnchorOwners = new Set(hanyang.flora.yardTreeAnchors.map((anchor) => anchor.parcelId));
const hanyangParcel = hanyang.plan.parcels.find((parcel) => hanyangAnchorOwners.has(parcel.id)
  && yardTreeIntersectsHardObstacle(
    { x: 7.67, z: -7.41 },
    { trunkRadius: 0.1, canopyRadius: 0.1 },
    yardHardObstacles(parcel),
  ));
invariant(hanyangParcel, 'hanyang:7 lost the aux-building collision fixture');
const hanyangParcelId = hanyangParcel.id;
const hanyangAnchors = snapshotParcel(hanyang, hanyangParcelId);
invariant(hanyangAnchors.length >= 1,
  `hanyang:7:${hanyangParcelId} lost its fruit tree instead of relocating it`);

// Rebuild the two targeted fixtures to pin the new slot choice and RNG contract.
for (const [scale, seed, parcelId, expected] of [
  ['hamlet', 7, 'p0', hamletAnchors],
  ['hanyang', 7, hanyangParcelId, hanyangAnchors],
]) {
  const repeat = buildFixture(scale, seed);
  invariant(JSON.stringify(snapshotParcel(repeat, parcelId)) === JSON.stringify(expected),
    `${scale}:${seed}:${parcelId} yard-tree placement drifted`);
  disposeFlora(repeat.flora);
}

for (const fixture of fixtures.values()) disposeFlora(fixture.flora);

console.log(
  `YARD LAYOUT CONTRACT: PASS (${plans} plans, ${renderedTrees}/${plannedTrees} rendered, `
  + `${(retention * 100).toFixed(1)}% of PR #36 tree baseline, p0/${hanyangParcelId} relocated)`,
);
