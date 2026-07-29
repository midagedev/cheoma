// Pure contract: rim distance band scales for telephoto but floors at the parcel lens.
// Browser-free — imports rim.js via esbuild three alias (same pattern as assembly/roof-shell).
import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const requireApp = createRequire(join(ROOT, 'app', 'package.json'));
const esbuild = requireApp('esbuild');
const THREE_MAIN = join(ROOT, 'app/node_modules/three/build/three.module.js');
const THREE_ADDONS = join(ROOT, 'app/node_modules/three/examples/jsm');

const built = await esbuild.build({
  stdin: {
    contents: "export { rimDistanceGateForFov, RIM_DISTANCE_GATE } from './src/env/rim.js';",
    resolveDir: ROOT,
    sourcefile: 'rim-gate-entry.js',
  },
  alias: { 'three/addons': THREE_ADDONS, three: THREE_MAIN },
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  write: false,
  logLevel: 'silent',
});

const { rimDistanceGateForFov, RIM_DISTANCE_GATE } = await import(
  `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString('base64')}`
);

let failed = 0;
function ok(cond, msg) {
  if (cond) console.log(`PASS ${msg}`);
  else {
    console.error(`FAIL ${msg}`);
    failed++;
  }
}

const aerial = rimDistanceGateForFov(46);
const parcel = rimDistanceGateForFov(16);
const hero = rimDistanceGateForFov(7);
const nanGate = rimDistanceGateForFov(NaN);
const zeroGate = rimDistanceGateForFov(0);

ok(
  Math.abs(aerial.far - parcel.far) < 1e-9,
  `wide-angle far floors at parcel band (46.far=${aerial.far}, 16.far=${parcel.far})`,
);
ok(
  aerial.far > 200,
  `aerial far restored above 200m (far=${aerial.far})`,
);
ok(
  hero.near >= 79 && hero.near <= 81,
  `hero near in 79–81 (near=${hero.near})`,
);
ok(
  hero.far >= 570 && hero.far <= 595,
  `hero far in 570–595 (far=${hero.far})`,
);

let mono = true;
let prevFar = parcel.far;
for (const fov of [15, 12, 10, 9, 8, 7]) {
  const far = rimDistanceGateForFov(fov).far;
  if (!(far >= prevFar - 1e-9)) mono = false;
  prevFar = far;
}
ok(mono, `far monotone non-decreasing from 16°→7° (7.far=${hero.far})`);

ok(
  Number.isFinite(nanGate.near) && nanGate.near > 0
    && Number.isFinite(nanGate.far) && nanGate.far > 0
    && nanGate.far > nanGate.near,
  `NaN fov returns finite positive band (near=${nanGate.near}, far=${nanGate.far})`,
);
ok(
  Number.isFinite(zeroGate.near) && zeroGate.near > 0
    && Number.isFinite(zeroGate.far) && zeroGate.far > 0
    && zeroGate.far > zeroGate.near,
  `0 fov returns finite positive band (near=${zeroGate.near}, far=${zeroGate.far})`,
);

// Sanity: parcel constant matches live parcel FOV solve.
ok(
  Math.abs(RIM_DISTANCE_GATE.far - parcel.far) < 1e-9
    && Math.abs(RIM_DISTANCE_GATE.near - parcel.near) < 1e-9,
  `RIM_DISTANCE_GATE matches parcel FOV (near=${RIM_DISTANCE_GATE.near}, far=${RIM_DISTANCE_GATE.far})`,
);

if (failed) {
  console.error(`RIM GATE: FAIL (${failed})`);
  process.exit(1);
}
console.log('RIM GATE: PASS');
