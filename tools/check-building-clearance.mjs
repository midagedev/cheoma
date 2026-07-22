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
console.log('BUILDING CLEARANCE: PASS');
