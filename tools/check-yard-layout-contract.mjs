// 마당나무와 부속채·장독대 등 hard yard object의 공유 배치 계약.
// 실제 gardens renderer를 Node에서 번들해 대표 seed의 최종 anchor를 검사한다.
import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planVillage } from '../src/api/village-plan.js';
import { parcelLocalPoint } from '../src/village/parcel-contract.js';
import {
  JANGDOK_JAR_GAP,
  JANGDOK_JAR_INSET,
  JANGDOK_JAR_JS_MAX,
  JANGDOK_JAR_JS_MIN,
  JANGDOK_JAR_JS_SPAN,
  JANGDOK_JAR_MAX_R,
  JANGDOK_JAR_PITCH,
  JANGDOK_JAR_R,
  jangdokJarCentres,
  jangdokPlatformDepth,
  jangdokPlatformWidth,
  yardHardObstacles,
  yardJangdokLayout,
  yardTreeIntersectsHardObstacle,
} from '../src/village/yard-layout.js';
import { auxiliaryLocalFootprint } from '../src/village/auxiliary-building-plan.js';

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
  // #21 R5 궁 위계(2026-08-02) 재기준: capital 3케이스만 이동한다. 궁이 있는 계획에만
  //   ① 궁역 폭 변경(60→58) ② 궁장 밖 8m 이격 링 ③ 궁역·광장 도로 금지 구역이 들어갔고,
  //   그 결과 capital 필지가 80→73 으로 줄면서 마당나무를 가진 필지도 함께 줄었다
  //   (실측 6→3 · 8→4 · 7→5). 단독 변인 증거: 궁이 없는 hamlet·village·town 의 기준선과
  //   실측은 이 라운드 전후로 동일하고(실측 5/5/2 · 20/15/11 · 62/56/44), 계획 골든도
  //   같은 네 케이스(capital/hanyang × base/temple)만 움직였다.
  //   **완화가 아니라 재기준이다**: 유지율 하한(케이스 0.80 · 전체 0.94)과 모든 교차 단언은
  //   그대로다. 여기서 바뀌는 것은 "그 시드가 몇 그루를 가질 수 있는가"라는 계획 사실뿐이다.
  'capital:7': 3, 'capital:42': 4, 'capital:20260716': 5,
  // R2 지붕 바다(2026-07-30): 한양 필지 밀집(폭 0.78·깊이 0.92·고샅 0.6×·초가 처마 +0.15)으로
  // 마당이 작아져 렌더 앵커가 새 설계점으로 이동(실측 91/61/64). capital 은 깊이 복원(0.88)으로
  // 구 기준 이상 유지. 수관의 지붕 위 자연 월경 허용(사진 근거)은 후속 라운드 후보.
  'hanyang:7': 91, 'hanyang:42': 61, 'hanyang:20260716': 64,
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

// ── 장독 항아리 군집: 최대 스케일에서도 침투·단 밖 돌출 0 ─────────────────────
// 수정 전: 행 피치 0.52 < 평균 지름 ~0.58, 가장자리 인셋 0.3 < maxR 0.396.
const JAR_PACK_EPS = 1e-9;
invariant(Math.abs(JANGDOK_JAR_JS_MAX - (JANGDOK_JAR_JS_MIN + JANGDOK_JAR_JS_SPAN)) < JAR_PACK_EPS,
  'JANGDOK_JAR_JS_MAX drifted from MIN+SPAN');
invariant(Math.abs(JANGDOK_JAR_MAX_R - JANGDOK_JAR_R * JANGDOK_JAR_JS_MAX) < JAR_PACK_EPS,
  'JANGDOK_JAR_MAX_R drifted from R·JS_MAX');
invariant(Math.abs(JANGDOK_JAR_PITCH - (2 * JANGDOK_JAR_MAX_R + JANGDOK_JAR_GAP)) < JAR_PACK_EPS,
  'JANGDOK_JAR_PITCH drifted from 2·maxR+gap');
invariant(Math.abs(JANGDOK_JAR_INSET - JANGDOK_JAR_MAX_R) < JAR_PACK_EPS,
  'JANGDOK_JAR_INSET must equal max jar radius so full footprint stays on the platform');
invariant(JANGDOK_JAR_PITCH + JAR_PACK_EPS >= 2 * JANGDOK_JAR_MAX_R,
  `row/column pitch ${JANGDOK_JAR_PITCH} < max jar diameter ${2 * JANGDOK_JAR_MAX_R}`);
// Pre-fix measurements (must stay worse than the fixed contract so the gate is not vacuous).
invariant(0.52 < 2 * JANGDOK_JAR_MAX_R, 'pre-fix row pitch was already ≥ max diameter');
invariant(0.3 < JANGDOK_JAR_MAX_R, 'pre-fix edge inset already covered max jar radius');

for (let level = 1; level <= 3; level++) {
  const layout = yardJangdokLayout(40, 40, level);
  const { rows, perRow, width, depth } = layout;
  invariant(rows === level, `level ${level} rows=${rows}`);
  invariant(perRow === 2 + level, `level ${level} perRow=${perRow}`);
  invariant(Math.abs(width - jangdokPlatformWidth(perRow)) < JAR_PACK_EPS,
    `level ${level} width ${width} ≠ platform formula`);
  invariant(Math.abs(depth - jangdokPlatformDepth(rows)) < JAR_PACK_EPS,
    `level ${level} depth ${depth} ≠ platform formula`);
  // Envelope grows with packing; must not shrink back to the old undersized formulas.
  invariant(width + JAR_PACK_EPS >= 2 * JANGDOK_JAR_INSET + Math.max(0, perRow - 1) * JANGDOK_JAR_PITCH,
    `level ${level} width too small for ${perRow} max-radius jars`);
  invariant(depth + JAR_PACK_EPS >= 2 * JANGDOK_JAR_INSET + Math.max(0, rows - 1) * JANGDOK_JAR_PITCH,
    `level ${level} depth too small for ${rows} max-radius rows`);

  const jars = jangdokJarCentres(rows, perRow, width, depth);
  invariant(jars.length > 0, `level ${level} produced no jar centres`);
  for (const jar of jars) {
    invariant(jar.x - jar.radius >= -width / 2 - JAR_PACK_EPS,
      `level ${level} jar overhangs -x (x=${jar.x}, r=${jar.radius}, halfW=${width / 2})`);
    invariant(jar.x + jar.radius <= width / 2 + JAR_PACK_EPS,
      `level ${level} jar overhangs +x (x=${jar.x}, r=${jar.radius}, halfW=${width / 2})`);
    invariant(jar.z - jar.radius >= -depth / 2 - JAR_PACK_EPS,
      `level ${level} jar overhangs -z (z=${jar.z}, r=${jar.radius}, halfD=${depth / 2})`);
    invariant(jar.z + jar.radius <= depth / 2 + JAR_PACK_EPS,
      `level ${level} jar overhangs +z (z=${jar.z}, r=${jar.radius}, halfD=${depth / 2})`);
  }
  for (let i = 0; i < jars.length; i++) {
    for (let k = i + 1; k < jars.length; k++) {
      const dist = Math.hypot(jars[i].x - jars[k].x, jars[i].z - jars[k].z);
      const minDist = jars[i].radius + jars[k].radius;
      invariant(dist + JAR_PACK_EPS >= minDist,
        `level ${level} jars ${i}/${k} interpenetrate (dist=${dist.toFixed(4)} < ${minDist.toFixed(4)})`);
    }
  }
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
const hanyangParcel = hanyang.plan.parcels.find(
  (parcel) => hanyangAnchorOwners.has(parcel.id) && parcel.auxiliary,
);
invariant(hanyangParcel, 'hanyang:7 lost the aux-building collision fixture');
const hanyangAuxFootprint = auxiliaryLocalFootprint(hanyangParcel.auxiliary);
const hanyangAuxCenter = hanyangAuxFootprint.reduce(
  (center, point) => ({ x: center.x + point.x, z: center.z + point.z }),
  { x: 0, z: 0 },
);
hanyangAuxCenter.x /= hanyangAuxFootprint.length;
hanyangAuxCenter.z /= hanyangAuxFootprint.length;
const hanyangAuxObstacle = yardHardObstacles(hanyangParcel)
  .find((obstacle) => obstacle.kind === 'auxiliary-building');
invariant(
  JSON.stringify(hanyangAuxObstacle?.points) === JSON.stringify(hanyangAuxFootprint),
  'hanyang:7 auxiliary hard obstacle drifted from its planned roof footprint',
);
invariant(yardTreeIntersectsHardObstacle(
  hanyangAuxCenter,
  { trunkRadius: 0.1, canopyRadius: 0.1 },
  yardHardObstacles(hanyangParcel),
), 'hanyang:7 planned auxiliary footprint is not reserved');
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
