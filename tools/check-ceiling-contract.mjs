// Pure ceiling finish contract — room banja vs daecheong yeondeung vs structural gaepan.
// See docs/ceiling.md. No browser.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CEILING_FINISH,
  CEILING_ZONE_STATUS,
  assertCeilingPlan,
  planCeiling,
  planGiwaCeiling,
  planRankedHallCeiling,
} from '../src/builder/ceiling-plan.js';
import { ROOF_SHELL_THICKNESS } from '../src/core/surface-clearance.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const requireApp = createRequire(join(ROOT, 'app', 'package.json'));
const esbuild = requireApp('esbuild');
const THREE_MAIN = join(ROOT, 'app/node_modules/three/build/three.module.js');
const THREE_ADDONS = join(ROOT, 'app/node_modules/three/examples/jsm');

process.on('uncaughtException', (error) => {
  console.error(`CEILING CONTRACT: FAIL — ${error.message}`);
  process.exit(1);
});

// ── Pure plan ───────────────────────────────────────────────────────────────
assert.ok(ROOF_SHELL_THICKNESS > 0, 'shell thickness must be positive');

const giwaPlan = planGiwaCeiling({
  podiumTopY: 0.46,
  columnTopY: 3.36,
  eaveY: 3.71,
  daecheong: { bounds: { x0: -1, x1: 1, z0: -1.5, z1: 1.8 } },
  rooms: [
    { spaceId: 'room-front-west', bounds: { x0: -4, x1: -1.1, z0: -1.5, z1: 1.8 } },
    { spaceId: 'room-front-east', bounds: { x0: 1.1, x1: 4, z0: -1.5, z1: 1.8 } },
  ],
});
assertCeilingPlan(giwaPlan);
assert.equal(giwaPlan.roofStructure.undersideIsRoomBanja, false,
  'structural gaepan must never claim to be room banja');
assert.equal(giwaPlan.banjaGeometry, 'deferred');

const byId = new Map(giwaPlan.zones.map((z) => [z.spaceId, z]));
assert.equal(byId.get('daecheong').finish, CEILING_FINISH.YEONDEUNG);
assert.equal(byId.get('daecheong').status, CEILING_ZONE_STATUS.STRUCTURE);
assert.equal(byId.get('room-front-west').finish, CEILING_FINISH.BANJA);
assert.equal(byId.get('room-front-west').status, CEILING_ZONE_STATUS.PLANNED);
assert.equal(byId.get('eave-underside').finish, CEILING_FINISH.YEONDEUNG);

// Banja plane must sit below eave (under the frame), not at the tile shell.
assert.ok(byId.get('room-front-west').ceilingY < 3.71 - 0.05,
  'room banja ceilingY must sit under the eave frame');

const palacePlan = planRankedHallCeiling({ style: 'palace', podiumTopY: 1, columnTopY: 4, eaveY: 5 });
assertCeilingPlan(palacePlan);
assert.equal(palacePlan.zones.find((z) => z.spaceId === 'main-hall').finish, CEILING_FINISH.WELL);

const chogaPlan = planRankedHallCeiling({ style: 'choga', podiumTopY: 0.3, columnTopY: 2.5, eaveY: 2.9 });
assertCeilingPlan(chogaPlan);
assert.equal(chogaPlan.zones.find((z) => z.spaceId === 'main-hall').finish, CEILING_FINISH.YEONDEUNG);

// assertCeilingPlan rejects if someone mutates underside into "room banja".
const bad = {
  ...giwaPlan,
  roofStructure: { ...giwaPlan.roofStructure, undersideIsRoomBanja: true },
};
assert.throws(() => assertCeilingPlan(bad), /undersideIsRoomBanja/);

// JSON-safe
assert.equal(JSON.parse(JSON.stringify(giwaPlan)).schemaVersion, 1);

// ── Production attach + mesh layer tags ──────────────────────────────────────
function makeCanvas() {
  const noop = () => {};
  const gradient = Object.freeze({ addColorStop: noop });
  let canvas;
  const context = new Proxy({}, {
    get(t, k) {
      if (k === 'canvas') return canvas;
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => gradient;
      if (k === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
      if (!(k in t)) t[k] = noop;
      return t[k];
    },
    set(t, k, v) { t[k] = v; return true; },
  });
  canvas = { width: 0, height: 0, getContext: () => context };
  return canvas;
}
globalThis.document = { createElement: () => makeCanvas() };

const built = await esbuild.build({
  stdin: {
    contents: "export { buildBuilding } from './src/api/building.js';"
      + " export { makeMaterials } from './src/builder/palette.js';"
      + " export { PRESETS } from './src/params.js';"
      + " export * as THREE from 'three';",
    resolveDir: ROOT,
    sourcefile: 'ceiling-contract-entry.js',
  },
  alias: { 'three/addons': THREE_ADDONS, three: THREE_MAIN },
  bundle: true, format: 'esm', platform: 'node', target: 'node20', write: false, logLevel: 'silent',
});
const { buildBuilding, makeMaterials, PRESETS, THREE } = await import(
  `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString('base64')}`
);

const giwa = buildBuilding({
  style: 'giwa',
  mats: makeMaterials('giwa'),
  planShape: 'l',
  bays: 4,
  mainHalfW: 4.4,
  mainHalfD: 2.2,
  wingLen: 3.8,
  wingW: 2.2,
  columnHeight: 2.9,
  podiumTierH: 0.46,
  ridgeH: 0.4,
  eaveOverhang: 1.4,
  riseScale: 0.85,
  profileCurve: 0.5,
  cornerLift: 0.45,
  planCurve: 0.35,
});
assertCeilingPlan(giwa.userData.ceilingPlan);
assert.ok(giwa.userData.ceilingPlan.zones.some((z) => z.finish === CEILING_FINISH.BANJA),
  'giwa plan must plan room banja zones');
assert.ok(giwa.userData.ceilingPlan.zones.some((z) => z.spaceId === 'daecheong'
  && z.finish === CEILING_FINISH.YEONDEUNG),
  'giwa plan must keep daecheong as yeondeung');

let gaepan = 0;
let outer = 0;
let banjaMesh = 0;
giwa.traverse((o) => {
  if (!o.isMesh) return;
  if (o.name === 'roof-gaepan') {
    gaepan++;
    assert.equal(o.userData.isRoomBanja, false, 'gaepan mesh must not claim room banja');
    assert.equal(o.userData.roofLayer, 'gaepan');
  }
  if (o.name === 'roof-tile-outer') outer++;
  if (o.userData?.isRoomBanja === true) banjaMesh++;
});
assert.ok(gaepan >= 1 && outer === gaepan, `outer/gaepan pair mismatch ${outer}/${gaepan}`);
assert.equal(banjaMesh, 0, 'no room banja mesh until interior volume pass');

const palace = buildBuilding({ ...PRESETS.korea, style: 'palace', mats: makeMaterials('palace') });
assertCeilingPlan(palace.userData.ceilingPlan);
assert.equal(
  palace.userData.ceilingPlan.zones.find((z) => z.spaceId === 'main-hall').finish,
  CEILING_FINISH.WELL,
);

// DoubleSide tileSurface still forbidden on roof.
giwa.getObjectByName('roof').traverse((o) => {
  if (o.isMesh && o.material?.userData?.paletteKey === 'tileSurface') {
    assert.equal(o.material.side, THREE.FrontSide, 'tileSurface must stay FrontSide');
  }
});

console.log('CEILING CONTRACT: PASS (room banja planned, daecheong yeondeung, gaepan≠banja, deferred mesh)');
