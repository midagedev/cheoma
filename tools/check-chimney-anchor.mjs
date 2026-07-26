// Pure chimney plan + production builder smoke-anchor contract (#150 A).
// Browser-free: plan is Three-free; builders are loaded once via esbuild.
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CHIMNEY_KINDS,
  planChogaChimney,
  planGiwaChimney,
  planResidentialChimney,
  resolveChimneyKind,
} from '../src/builder/chimney-plan.js';
import {
  planChogaKitchenOpening,
  planGiwaKitchenOpening,
} from '../src/layout/kitchen-opening-spatial.js';
import { PRESETS, computeLayout, giwaFootprint } from '../src/params.js';
import { createThatchRoofProfile } from '../src/builder/thatch-profile.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const EPS = 1e-6;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

// ── 1. Pure plan grammar ───────────────────────────────────────────────────
invariant(
  CHIMNEY_KINDS.join(',') === 'mud-stack,jeondol,none',
  `CHIMNEY_KINDS drifted: ${CHIMNEY_KINDS.join(',')}`,
);
invariant(resolveChimneyKind('choga') === 'mud-stack', 'choga kind');
invariant(resolveChimneyKind('giwa') === 'jeondol', 'giwa kind');
invariant(resolveChimneyKind('palace') === 'none', 'palace has no residential stack');
invariant(resolveChimneyKind('temple') === 'none', 'temple has no residential stack');

const kitchenGiwa = planGiwaKitchenOpening(4.2);
const giwaPlan = planGiwaChimney({ halfWidthA: 4.2, halfDepthB: 3.1, kitchen: kitchenGiwa });
const giwaAgain = planGiwaChimney({ halfWidthA: 4.2, halfDepthB: 3.1, kitchen: kitchenGiwa });
invariant(Object.isFrozen(giwaPlan) && Object.isFrozen(giwaPlan.emission), 'giwa plan not frozen');
invariant(JSON.stringify(giwaPlan) === JSON.stringify(giwaAgain), 'giwa plan not byte-stable');
invariant(giwaPlan.kind === 'jeondol' && giwaPlan.style === 'giwa', 'giwa kind/style');
invariant(giwaPlan.kitchenEnd.wall === 'east', 'giwa kitchen end wall');
invariant(Math.abs(giwaPlan.kitchenEnd.wallX - 4.2) < EPS, 'giwa kitchen wallX');
invariant(Math.abs(giwaPlan.kitchenEnd.centerZ - kitchenGiwa.centerZ) < EPS, 'giwa kitchen centerZ');
invariant(giwaPlan.emission.x > 4.2, 'giwa emission must clear east wall toward eave outside');
invariant(giwaPlan.emission.y > giwaPlan.bodyTopY, 'giwa emission above body');
invariant(
  Number.isFinite(giwaPlan.emission.x)
    && Number.isFinite(giwaPlan.emission.y)
    && Number.isFinite(giwaPlan.emission.z),
  'giwa emission nonfinite',
);

const kitchenChoga = planChogaKitchenOpening(5.1);
const chogaPlan = planChogaChimney({
  eastWallX: 5.1,
  zEave: 3.4,
  backWallZ: -2.0,
  kitchen: kitchenChoga,
});
invariant(Object.isFrozen(chogaPlan) && Object.isFrozen(chogaPlan.stack), 'choga plan not frozen');
invariant(chogaPlan.kind === 'mud-stack' && chogaPlan.style === 'choga', 'choga kind/style');
invariant(chogaPlan.kitchenEnd.wall === 'east', 'choga kitchen end wall');
invariant(Math.abs(chogaPlan.kitchenEnd.wallX - 5.1) < EPS, 'choga kitchen wallX');
invariant(chogaPlan.emission.z < -3.4, 'choga emission must clear rear eave (-zEave)');
invariant(chogaPlan.emission.y > chogaPlan.stack.height, 'choga emission above stack');
invariant(
  chogaPlan.stack.profile.at(-1)[1] === chogaPlan.stack.height,
  'choga profile top must match stack height',
);

// Unified entry + none path.
const none = planResidentialChimney({ style: 'palace' });
invariant(none.kind === 'none' && none.emission == null, 'palace plan should be none');
const viaUnified = planResidentialChimney({
  style: 'giwa', halfWidthA: 4.2, halfDepthB: 3.1,
});
invariant(viaUnified.kind === 'jeondol', 'unified giwa kind');
invariant(
  Math.abs(viaUnified.emission.x - giwaPlan.emission.x) < EPS
    && Math.abs(viaUnified.emission.y - giwaPlan.emission.y) < EPS,
  'unified giwa emission drifted from direct plan',
);

// Kitchen mismatch fails closed.
let threw = false;
try {
  planGiwaChimney({
    halfWidthA: 4.2,
    halfDepthB: 3.1,
    kitchen: planGiwaKitchenOpening(5.0),
  });
} catch {
  threw = true;
}
invariant(threw, 'giwa plan must reject kitchen wallX ≠ halfWidthA');

// No global RNG.
const originalRandom = Math.random;
let randomCalls = 0;
Math.random = () => { randomCalls += 1; return 0.5; };
try {
  planChogaChimney({ eastWallX: 4, zEave: 3, backWallZ: -1.5 });
  planGiwaChimney({ halfWidthA: 3.5, halfDepthB: 2.8 });
} finally {
  Math.random = originalRandom;
}
invariant(randomCalls === 0, 'chimney plan consumed Math.random');

// Preset envelopes: emission stays outside eave for default choga/giwa.
const chogaPreset = { ...PRESETS.choga };
const L = computeLayout(chogaPreset);
const roof = createThatchRoofProfile(chogaPreset, L);
const east = L.xPos.at(-1);
const chogaDefault = planChogaChimney({
  eastWallX: east,
  zEave: roof.zEave,
  backWallZ: L.zPos[0],
});
invariant(
  chogaDefault.emission.z < -roof.zEave - 1e-6,
  `default choga emission inside eave (z=${chogaDefault.emission.z}, zEave=${roof.zEave})`,
);
invariant(
  Math.abs(chogaDefault.kitchenEnd.wallX - east) < EPS,
  'default choga kitchen end not on east wall line',
);

const giwaFp = giwaFootprint(PRESETS.giwa);
const giwaDefault = planGiwaChimney({
  halfWidthA: giwaFp.a,
  halfDepthB: giwaFp.b,
});
invariant(
  giwaDefault.emission.x > giwaFp.a + 1.0,
  `default giwa emission not past east eave (x=${giwaDefault.emission.x}, a=${giwaFp.a})`,
);

// ── 2. Production builders wire plan → name='chimney' + smokeEmission ──────
// Palette textures need a canvas stub (same pattern as check-assembly-contract).
function makeCanvas() {
  const noop = () => {};
  const gradient = Object.freeze({ addColorStop: noop });
  let canvas;
  const context = new Proxy({}, {
    get(target, key) {
      if (key === 'canvas') return canvas;
      if (key === 'createLinearGradient' || key === 'createRadialGradient') return () => gradient;
      if (key === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
      if (!(key in target)) target[key] = noop;
      return target[key];
    },
    set(target, key, value) { target[key] = value; return true; },
  });
  canvas = { width: 0, height: 0, getContext: () => context };
  return canvas;
}
globalThis.document = globalThis.document || { createElement: () => makeCanvas() };

const requireApp = createRequire(join(ROOT, 'app', 'package.json'));
const esbuild = requireApp('esbuild');
const THREE_MAIN = join(ROOT, 'app/node_modules/three/build/three.module.js');
const THREE_ADDONS = join(ROOT, 'app/node_modules/three/examples/jsm');

const built = await esbuild.build({
  stdin: {
    contents:
      "export { buildBuilding } from './src/api/building.js';"
      + " export { setupSmoke } from './src/env/smoke.js';"
      + " export * as THREE from 'three';",
    resolveDir: ROOT,
    sourcefile: 'chimney-anchor-entry.js',
  },
  alias: { 'three/addons': THREE_ADDONS, three: THREE_MAIN },
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  write: false,
  logLevel: 'silent',
});
const modUrl = `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString('base64')}`;
let buildBuilding;
let setupSmoke;
let THREE;
try {
  ({ buildBuilding, setupSmoke, THREE } = await import(modUrl));
} catch (err) {
  // data: URL stacks dump the whole bundle — keep only the message.
  throw new Error(`chimney-anchor bundle import failed: ${err.message}`);
}

function findChimneys(root) {
  const found = [];
  root.traverse((o) => { if (o.name === 'chimney') found.push(o); });
  return found;
}

function countMudIdentityMeshes(root) {
  const M = root.userData?.materials;
  if (!M?.mud) return 0;
  let n = 0;
  root.traverse((o) => { if (o.isMesh && o.material === M.mud) n += 1; });
  return n;
}

/** Mirror smoke.js detect: plan emission wins; no material===M.mud path. */
function detectSmokeAnchors(building) {
  building.updateMatrixWorld(true);
  const anchors = [];
  const local = new THREE.Vector3();
  building.traverse((o) => {
    if (o.name !== 'chimney') return;
    const emission = o.userData?.smokeEmission;
    if (emission && Number.isFinite(emission.x) && Number.isFinite(emission.y) && Number.isFinite(emission.z)) {
      local.set(emission.x, emission.y, emission.z);
      o.localToWorld(local);
      anchors.push({ x: local.x, y: local.y, z: local.z });
    }
  });
  return anchors;
}

for (const style of ['choga', 'giwa']) {
  let building;
  try {
    building = buildBuilding({ ...PRESETS[style] });
  } catch (err) {
    throw new Error(`${style} buildBuilding failed: ${err.message}`);
  }
  const chimneys = findChimneys(building);
  invariant(chimneys.length === 1, `${style}: expected exactly one name=chimney, got ${chimneys.length}`);
  const ch = chimneys[0];
  const plan = ch.userData?.chimneyPlan;
  const emission = ch.userData?.smokeEmission;
  invariant(plan && plan.kind, `${style}: missing userData.chimneyPlan`);
  invariant(emission && Number.isFinite(emission.x), `${style}: missing userData.smokeEmission`);
  invariant(
    Math.abs(emission.x - plan.emission.x) < EPS
      && Math.abs(emission.y - plan.emission.y) < EPS
      && Math.abs(emission.z - plan.emission.z) < EPS,
    `${style}: smokeEmission diverged from plan.emission`,
  );
  if (style === 'choga') {
    invariant(plan.kind === 'mud-stack', 'choga plan kind on mesh');
    // Shared mud material may appear on stack + flue; smoke must not key off it.
    const mudMeshes = countMudIdentityMeshes(building);
    invariant(mudMeshes >= 2, 'choga should share M.mud on stack and flue (no clone)');
  } else {
    invariant(plan.kind === 'jeondol', 'giwa plan kind on mesh');
  }
  // agungi names preserved.
  let ember = 0;
  let fire = 0;
  building.traverse((o) => {
    if (o.name === 'agungiEmber') ember += 1;
    if (o.name === 'agungiFire') fire += 1;
  });
  invariant(ember === 1 && fire === 1, `${style}: agungiEmber/agungiFire count ${ember}/${fire}`);

  const anchors = detectSmokeAnchors(building);
  invariant(anchors.length === 1, `${style}: smoke plan anchors ${anchors.length}`);
  invariant(
    Math.abs(anchors[0].x - emission.x) < 1e-4
      && Math.abs(anchors[0].y - emission.y) < 1e-4
      && Math.abs(anchors[0].z - emission.z) < 1e-4,
    `${style}: smoke world anchor drifted from plan emission `
      + `(got ${JSON.stringify(anchors[0])}, want ${JSON.stringify(emission)})`,
  );

  // setupSmoke boots without material-identity side effects (canvas-stubbed texture).
  const scene = new THREE.Scene();
  const smoke = setupSmoke({
    scene,
    getBuilding: () => building,
    particles: 2,
    maxAnchors: 1,
  });
  smoke.onBuildingChanged();
  smoke.setEnabled(true);
  smoke.setTime('dawn', { immediate: true });
  smoke.update(0.02);
  let visibleSprites = 0;
  smoke.group.traverse((o) => {
    if (o.isSprite && o.visible) visibleSprites += 1;
  });
  invariant(visibleSprites === 2, `${style}: setupSmoke did not arm sprites from name=chimney`);
}

// Palace must not invent a residential chimney via the plan entry.
const palacePlan = planResidentialChimney({ style: 'palace' });
invariant(palacePlan.kind === 'none', 'palace residential chimney must be none');

console.log('check-chimney-anchor: ok');
