// Browser-free camera-turn contract: shortest wrapped angles, bounded angular
// velocity/acceleration, and a real walker reversing repeatedly on a dead end.
import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createDirectionController,
  createHeadingController,
  shortestAngleDelta,
} from '../src/camera/heading.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const requireApp = createRequire(join(ROOT, 'app', 'package.json'));
const esbuild = requireApp('esbuild');
const THREE_MAIN = join(ROOT, 'app/node_modules/three/build/three.module.js');
const THREE_ADDONS = join(ROOT, 'app/node_modules/three/examples/jsm');
const DEG = Math.PI / 180;
const DT = 1 / 60;

const invariant = (condition, message) => {
  if (!condition) throw new Error(message);
};
const near = (actual, expected, epsilon, message) => {
  invariant(Math.abs(actual - expected) <= epsilon, `${message} (${actual} != ${expected})`);
};

near(shortestAngleDelta(179 * DEG, -179 * DEG), 2 * DEG, 1e-10,
  'heading crossed the wrap seam by the long arc');
near(shortestAngleDelta(0, Math.PI, 1), Math.PI, 1e-10,
  'opposite heading ignored the preferred positive side');
near(shortestAngleDelta(0, Math.PI, -1), -Math.PI, 1e-10,
  'opposite heading ignored the preferred negative side');
let invalidLimitRejected = false;
try {
  createHeadingController({ maxAcceleration: 0 });
} catch (error) {
  invalidLimitRejected = error instanceof RangeError;
}
invariant(invalidLimitRejected, 'heading controller accepted an invalid acceleration limit');

const heading = createHeadingController({
  angle: 0,
  maxSpeed: 52 * DEG,
  maxAcceleration: 120 * DEG,
});
let headingMaxSpeed = 0;
let headingMaxAcceleration = 0;
let previousVelocity = 0;
let previousAngle = heading.angle;
for (let frame = 0; frame < 300; frame++) {
  const target = Math.PI + (frame % 2 ? -5e-10 : 5e-10);
  const angle = heading.step(target, DT, 1);
  const advance = shortestAngleDelta(previousAngle, angle, 1);
  const previousRemaining = Math.abs(shortestAngleDelta(previousAngle, target, 1));
  invariant(previousRemaining < 2 * DEG || advance >= -1e-9,
    `opposite-heading tie changed turn side at frame ${frame}`);
  headingMaxSpeed = Math.max(headingMaxSpeed, Math.abs(heading.velocity));
  headingMaxAcceleration = Math.max(
    headingMaxAcceleration,
    Math.abs(heading.velocity - previousVelocity) / DT,
  );
  previousVelocity = heading.velocity;
  previousAngle = angle;
  if (Math.abs(shortestAngleDelta(angle, target, 1)) < 1e-7 && Math.abs(heading.velocity) < 1e-7) break;
}
invariant(headingMaxSpeed <= 52.01 * DEG,
  `heading exceeded max angular speed (${headingMaxSpeed / DEG} deg/s)`);
invariant(headingMaxAcceleration <= 120.01 * DEG,
  `heading exceeded max angular acceleration (${headingMaxAcceleration / DEG} deg/s²)`);

const view = createDirectionController({
  direction: { x: 0, y: 0, z: 1 },
  maxYawSpeed: 60 * DEG,
  maxYawAcceleration: 150 * DEG,
  maxPitchSpeed: 40 * DEG,
  maxPitchAcceleration: 100 * DEG,
});
let previousDirection = { ...view.value };
let viewMaxFrameTurn = 0;
for (let frame = 0; frame < 300; frame++) {
  const direction = view.step({ x: 0, y: Math.SQRT1_2, z: -Math.SQRT1_2 }, DT);
  const dot = Math.min(1, Math.max(-1,
    previousDirection.x * direction.x
      + previousDirection.y * direction.y
      + previousDirection.z * direction.z));
  viewMaxFrameTurn = Math.max(viewMaxFrameTurn, Math.acos(dot) / DT);
  previousDirection = { ...direction };
}
invariant(viewMaxFrameTurn <= 72.2 * DEG,
  `3D view exceeded max angular speed (${viewMaxFrameTurn / DEG} deg/s)`);
invariant(previousDirection.y > 0.707 && previousDirection.z < -0.707,
  '3D view controller did not settle on the opposite direction');

// Bundle the production walker against the app's single pinned Three instance.
const built = await esbuild.build({
  stdin: {
    contents: "export { createWalker } from './src/cinematic/walker.js';",
    resolveDir: ROOT,
    sourcefile: 'cinematic-turn-contract-entry.js',
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
const { createWalker } = await import(moduleUrl);

const site = {
  R: 40,
  bowlR: 30,
  center: { x: 0, z: 6 },
  entrance: { x: 0, z: 0 },
  heightAt: () => 0,
};
const plan = {
  site,
  parcels: [],
  features: {},
  roads: [{ level: 'daero', pts: [{ x: 0, z: 0 }, { x: 0, z: 12 }] }],
};

const offsetEntranceSite = { ...site, entrance: { x: 20, z: 12 } };
const routeSpawnWalker = createWalker({
  site: offsetEntranceSite,
  plan: { ...plan, site: offsetEntranceSite },
  heightAt: offsetEntranceSite.heightAt,
});
near(routeSpawnWalker.pos.x, 0, 1e-9,
  'walker spawned at the site entrance instead of the selected road endpoint');
near(routeSpawnWalker.pos.z, 12, 1e-9,
  'walker did not orient the selected road from its entrance-nearest endpoint');

const walker = createWalker({ site, plan, heightAt: site.heightAt });
walker.startAutoStroll();
let walkerMaxSpeed = 0;
let walkerMaxAcceleration = 0;
let walkerMaxFrameTurn = 0;
let walkerPreviousRate = 0;
let walkerPreviousYaw = walker.yaw;
let walkerMaxLateral = 0;
for (let frame = 0; frame < 50 / DT; frame++) {
  walker.update(DT, {});
  const rate = walker.turnRate();
  walkerMaxSpeed = Math.max(walkerMaxSpeed, Math.abs(rate));
  walkerMaxAcceleration = Math.max(walkerMaxAcceleration, Math.abs(rate - walkerPreviousRate) / DT);
  walkerMaxFrameTurn = Math.max(
    walkerMaxFrameTurn,
    Math.abs(shortestAngleDelta(walkerPreviousYaw, walker.yaw)) / DT,
  );
  walkerMaxLateral = Math.max(walkerMaxLateral, Math.abs(walker.pos.x));
  walkerPreviousRate = rate;
  walkerPreviousYaw = walker.yaw;
}

invariant(walker.turnaroundCount() >= 2,
  `dead-end fixture did not exercise repeated turnarounds (${walker.turnaroundCount()})`);
invariant(walkerMaxSpeed <= 52.01 * DEG,
  `walker exceeded max angular speed (${walkerMaxSpeed / DEG} deg/s)`);
invariant(walkerMaxFrameTurn <= 52.01 * DEG,
  `walker camera jumped between frames (${walkerMaxFrameTurn / DEG} deg/s)`);
invariant(walkerMaxAcceleration <= 120.01 * DEG,
  `walker exceeded max angular acceleration (${walkerMaxAcceleration / DEG} deg/s²)`);
invariant(walkerMaxLateral < 2.5,
  `walker U-turn arc strayed too far from the road (${walkerMaxLateral}m)`);
invariant(!walker.isColliding() && !walker.outsideBoundary(),
  'walker turnaround violated collision or site boundary constraints');

console.log('cinematic turn contract: PASS', JSON.stringify({
  headingMaxDegS: +(headingMaxSpeed / DEG).toFixed(2),
  viewMaxDegS: +(viewMaxFrameTurn / DEG).toFixed(2),
  walkerMaxDegS: +(walkerMaxFrameTurn / DEG).toFixed(2),
  walkerMaxAccelDegS2: +(walkerMaxAcceleration / DEG).toFixed(2),
  turnarounds: walker.turnaroundCount(),
  lateralMeters: +walkerMaxLateral.toFixed(2),
}));
