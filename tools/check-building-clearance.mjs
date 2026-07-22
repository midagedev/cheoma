import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from '../app/node_modules/vite/dist/node/index.js';
import {
  COURTYARD_SURFACE_LIFT,
  FOUNDATION_SINK,
  OPENING_FACE_CLEARANCE,
  ROOF_WALL_TUCK,
  overlayCenterOffset,
  sunkPrism,
} from '../src/core/surface-clearance.js';
import { planGiwaKitchenOpening } from '../src/api/residential-openings.js';

const ROOT = resolve(import.meta.dirname, '..');
const EPS = 1e-5;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

async function inspectProductionGeometry() {
  const cacheDir = await mkdtemp(join(tmpdir(), 'cheoma-building-clearance-'));
  const threeMain = join(ROOT, 'app/node_modules/three/build/three.module.js');
  const threeAddons = join(ROOT, 'app/node_modules/three/examples/jsm/');
  const vite = await createServer({
    appType: 'custom',
    cacheDir,
    configFile: false,
    root: ROOT,
    logLevel: 'error',
    resolve: {
      alias: [
        { find: /^three\/addons\//, replacement: threeAddons },
        { find: /^three$/, replacement: threeMain },
      ],
      dedupe: ['three'],
    },
    optimizeDeps: { noDiscovery: true },
    server: { middlewareMode: true, hmr: false },
    ssr: { noExternal: true },
  });
  try {
    const probe = await vite.ssrLoadModule('/tools/lib/building-clearance-production.mjs');
    return probe.inspectBuildingClearance();
  } finally {
    await vite.close();
    await rm(cacheDir, { recursive: true, force: true });
  }
}

const prism = sunkPrism(0.5);
invariant(Math.abs(prism.bottom + FOUNDATION_SINK) < EPS, 'foundation sink helper drifted');
invariant(Math.abs(prism.top - 0.5) < EPS, 'foundation sink changed the visible top');
invariant(
  Math.abs(overlayCenterOffset(0.13, 0.10) - 0.035) < EPS,
  'overlay center no longer preserves the face clearance',
);
invariant(ROOF_WALL_TUCK >= 0.1, 'gable wall no longer tucks safely below the roof');

const production = await inspectProductionGeometry();
invariant(production.ownedMergeFailure.threw
    && production.ownedMergeFailure.disposed.every((count) => count === 1),
  `owned geometry merge failure leaked inputs (${JSON.stringify(production.ownedMergeFailure)})`);
const finiteValues = (value) => {
  if (typeof value === 'number') return Number.isFinite(value);
  if (!value || typeof value !== 'object') return true;
  return Object.values(value).every(finiteValues);
};
invariant(finiteValues(production.chogaNonfinite),
  'production choga nonfinite fallback leaked NaN/Infinity into geometry');
invariant(
  Math.abs(production.chogaNonfinite.W - 8.2) < EPS
    && Math.abs(production.chogaNonfinite.D - 4.4) < EPS
    && production.chogaNonfinite.xCount === 4
    && production.chogaNonfinite.zCount === 3,
  `production choga fallback footprint drifted (${JSON.stringify(production.chogaNonfinite)})`,
);
function checkGiwaPodium(label, shape) {
  for (const [name, count] of Object.entries(shape.layerCounts)) {
    invariant(count === 1, `${label} ${name} has ${count} depth owners`);
  }
  invariant(shape.podiumChildren <= 5, `${label} drawables regressed to ${shape.podiumChildren}`);
  for (const [name, hits] of Object.entries(shape.layerHits)) {
    invariant(hits.insideWing > 0, `${label} ${name} lost its wing`);
    invariant(hits.emptyNotch === 0, `${label} ${name} filled the L-plan notch`);
  }
}

checkGiwaPodium('giwa default podium', production.giwa);
for (const shape of production.giwaBoundaryShapes) {
  checkGiwaPodium(`giwa ${shape.name} podium`, shape);
}
invariant(
  production.giwa.lowerBounds.min.y <= -FOUNDATION_SINK + EPS,
  `giwa foundation stops at ${production.giwa.lowerBounds.min.y}`,
);
invariant(
  Math.abs(production.giwa.openingFaceClearance - OPENING_FACE_CLEARANCE) < EPS,
  `plank opening face clearance is ${production.giwa.openingFaceClearance}`,
);

for (const [style, foundation] of Object.entries(production.foundations)) {
  invariant(
    foundation.bounds.min.y <= -FOUNDATION_SINK + EPS,
    `${style} foundation stops at ${foundation.bounds.min.y}`,
  );
  invariant(
    Math.abs(foundation.bounds.max.y - foundation.expectedTop) < EPS,
    `${style} foundation changed its visible top to ${foundation.bounds.max.y}`,
  );
}
invariant(
  production.hanokFoundation.min.y <= -FOUNDATION_SINK + EPS,
  `hanok foundation stops at ${production.hanokFoundation.min.y}`,
);
invariant(
  Math.abs(production.courtyardY - COURTYARD_SURFACE_LIFT) < EPS,
  `courtyard lift is ${production.courtyardY}`,
);
invariant(production.matbaeGableTucks.length === 2, 'matbae lost one of its gable walls');
for (const tuck of production.matbaeGableTucks) {
  invariant(
    tuck >= ROOF_WALL_TUCK - EPS,
    `matbae gable wall tucks only ${tuck}m below the roof ridge`,
  );
}

for (const [style, hearth] of Object.entries(production.hearths)) {
  for (const [name, count] of Object.entries(hearth.counts)) {
    invariant(count === 1, `${style} kitchen hearth has ${count} ${name} objects`);
  }
  invariant(
    hearth.bounds.max.x <= hearth.wallX + 0.45 + EPS,
    `${style} kitchen projects ${(hearth.bounds.max.x - hearth.wallX).toFixed(3)}m beyond its wall`,
  );
  invariant(
    hearth.openingBounds.max.x <= hearth.wallX + 0.18 + EPS,
    `${style} kitchen opening became a projecting solid`,
  );
  invariant(
    hearth.thresholdBounds.min.y >= -EPS && hearth.thresholdBounds.max.y <= 0.13 + EPS,
    `${style} kitchen threshold left the yard-level floor`,
  );
}
const giwaKitchen = planGiwaKitchenOpening(production.hearths.giwa.wallX);
invariant(
  Math.abs(production.hearths.giwa.openingSpanZ.min - giwaKitchen.openingSpanZ.min) < EPS
    && Math.abs(production.hearths.giwa.openingSpanZ.max - giwaKitchen.openingSpanZ.max) < EPS,
  'production giwa kitchen no longer consumes the shared pure opening span',
);

for (const [style, opening] of Object.entries(production.openings)) {
  invariant(opening.counts.frame === 1,
    `${style} openings use ${opening.counts.frame} frame batches instead of one`);
  invariant(opening.counts.hardware === 1,
    `${style} openings use ${opening.counts.hardware} hardware batches instead of one`);
  invariant(opening.counts.primaryAnchor === 1 && opening.counts.primaryPanel === 1,
    `${style} does not expose exactly one primary entrance`);
  invariant(opening.frameVertices > 0 && opening.hardwareVertices > 0,
    `${style} opening detail batch is empty`);
  invariant(opening.frameTriangles <= (style === 'hanok' ? 2400 : 1600)
      && opening.hardwareTriangles <= 240,
    `${style} opening detail budget grew to ${opening.frameTriangles}+${opening.hardwareTriangles} triangles`);
  invariant(opening.frameEnvelope,
    `${style} frame no longer shares the MID envelope wood material`);
  invariant(!opening.hardwareEnvelope && opening.hardwarePaletteKey === 'hardware',
    `${style} ironwork leaked into MID or lost its shared palette key`);
  invariant(opening.plan?.primary && opening.plan?.anchors?.pivot && opening.plan?.anchors?.footwear,
    `${style} primary entrance lost its pure pivot/footwear contract`);
  const expectedHardware = style === 'korea' ? 5 : 3;
  invariant(opening.plan.hardware.length === expectedHardware,
    `${style} primary entrance ironwork drifted to ${opening.plan.hardware.length} pieces`);
  invariant(opening.plan.meoreum.height === 0 && opening.plan.lowerPanel.height > 0,
    `${style} primary door conflates its lower panel with a window meoreum`);
  if (style === 'hanok') {
    invariant(opening.primaryFace?.clearance > 0,
      `hanok frame front fell ${Math.abs(opening.primaryFace?.clearance || 0).toFixed(3)}m behind its panel`);
    invariant(Math.abs(
      opening.primaryFace.clearance - opening.primaryFace.expectedClearance,
    ) <= EPS,
    `hanok frame/panel clearance drifted to ${opening.primaryFace.clearance.toFixed(3)}m `
      + `(expected ${opening.primaryFace.expectedClearance.toFixed(3)}m)`);
  }
}

console.log(
  `giwa podium=${production.giwa.podiumChildren} drawables, opening clearance=`
  + `${production.giwa.openingFaceClearance.toFixed(3)}m`,
);
console.log(
  `foundation sink=${FOUNDATION_SINK.toFixed(2)}m, courtyard lift=`
  + `${production.courtyardY.toFixed(2)}m, roof tuck=${ROOF_WALL_TUCK.toFixed(2)}m`,
);
console.log(
  `recessed kitchens: giwa +${(production.hearths.giwa.bounds.max.x - production.hearths.giwa.wallX).toFixed(2)}m, `
  + `choga +${(production.hearths.choga.bounds.max.x - production.hearths.choga.wallX).toFixed(2)}m`,
);
console.log(
  `opening batches: ${Object.entries(production.openings).map(([style, opening]) => (
    `${style} tris=${opening.frameTriangles}+${opening.hardwareTriangles}`
  )).join(', ')}`,
);
console.log(
  `hanok primary frame/panel clearance=${production.openings.hanok.primaryFace.clearance.toFixed(3)}m`,
);
console.log(
  `choga nonfinite fallback=${production.chogaNonfinite.W.toFixed(1)}×`
  + `${production.chogaNonfinite.D.toFixed(1)}m, bays=`
  + `${production.chogaNonfinite.xCount - 1}×${production.chogaNonfinite.zCount - 1}`,
);
console.log('BUILDING CLEARANCE: PASS');
