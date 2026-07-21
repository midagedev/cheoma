// 실제 담 생성기를 Node에서 빠르게 번들해 road-side gate의 plan/render 계약을 검사한다.
// six wall styles와 shape.edges가 없는 hero의 non-front gate를 모두 통과해야 한다.
import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as G from '../src/core/math/geom2.js';
import { planVillage } from '../src/api/village-plan.js';
import { parcelRoofPolygons } from '../src/village/house-footprint.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const requireApp = createRequire(join(ROOT, 'app', 'package.json'));
const esbuild = requireApp('esbuild');
const THREE_MAIN = join(ROOT, 'app/node_modules/three/build/three.module.js');
const EPSILON = 1e-9;
const STYLES = ['tile', 'stone', 'mud', 'brush', 'hedge', 'open'];

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function pointError(a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function angleError(a, b) {
  return Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
}

const startedAt = performance.now();
const built = await esbuild.build({
  stdin: {
    contents: [
      "import * as THREE from './app/node_modules/three/build/three.module.js';",
      "export { THREE };",
      "export { buildVillageWall } from './src/village/walls.js';",
    ].join('\n'),
    resolveDir: ROOT,
    sourcefile: 'wall-gate-contract-entry.js',
  },
  alias: { three: THREE_MAIN },
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  write: false,
  logLevel: 'silent',
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString('base64')}`;
const { THREE, buildVillageWall } = await import(moduleUrl);

const plan = planVillage({ scale: 'town', seed: 7 });
const regular = plan.parcels.find((parcel) => !parcel.hero
  && parcel.access
  && parcel.access?.gateRole !== 'front'
  && parcel.shape?.edges);
const hero = plan.parcels.find((parcel) => parcel.hero
  && parcel.access
  && parcel.access?.gateRole !== 'front'
  && !parcel.shape?.edges);
invariant(regular, 'town:7 has no regular non-front gate fixture');
invariant(hero, 'town:7 has no shape.edges-free hero non-front gate fixture');

function verifyPlanGate(parcel, label) {
  const access = parcel.access;
  invariant(Number.isInteger(access?.gateEdge)
    && access.gateEdge >= 0 && access.gateEdge < parcel.shape.pts.length,
  `${label} has an invalid gate edge`);
  invariant(Number.isFinite(access.gateT) && access.gateT >= 0 && access.gateT <= 1,
    `${label} has an invalid gate parameter`);

  const edge = access.gateEdge;
  const next = (edge + 1) % parcel.shape.pts.length;
  const expectedLocal = G.lerp(parcel.shape.pts[edge], parcel.shape.pts[next], access.gateT);
  const expectedWorld = G.lerp(parcel.poly[edge], parcel.poly[next], access.gateT);
  invariant(pointError(expectedLocal, access.gateLocalPoint) <= EPSILON,
    `${label} local gate drifted from edge/t`);
  invariant(pointError(expectedWorld, access.gatePoint) <= EPSILON,
    `${label} world gate drifted from edge/t`);
  if (parcel.shape.edges) {
    invariant(parcel.shape.edges[edge]?.gate === true
      && parcel.shape.edges[edge].share === false,
    `${label} gate edge was shared or omitted`);
  }

  const outside = G.lerp(access.gatePoint, access.roadPoint, 0.001);
  invariant(!G.pointInPoly(outside, parcel.poly), `${label} gate opens into its parcel`);
  for (const roof of parcelRoofPolygons(parcel)) {
    invariant(G.segmentPolygonDistance(access.gatePoint, access.roadPoint, roof) > 1e-6,
      `${label} gate approach crosses its own roof`);
  }
  return expectedLocal;
}

const material = new THREE.MeshStandardMaterial();
const materialKeys = [
  'fieldstone', 'mud', 'plaster', 'wood', 'woodDark', 'jipjul', 'thatch',
  'tileConvex', 'tileRidge', 'eaveBand', 'stoneDark',
];
const wallMats = Object.fromEntries(materialKeys.map((key) => [key, material]));

let objects = 0;
let vertices = 0;

function verifyFiniteGeometry(group, label) {
  group.updateMatrixWorld(true);
  let localGeometryCount = 0;
  group.traverse((object) => {
    objects++;
    invariant(object.matrixWorld.elements.every(Number.isFinite),
      `${label} has a non-finite world matrix`);
    if (!object.geometry) return;
    localGeometryCount++;
    for (const [name, attribute] of Object.entries(object.geometry.attributes)) {
      invariant(Array.from(attribute.array).every(Number.isFinite),
        `${label} has non-finite ${name} geometry`);
    }
    if (object.geometry.index) {
      invariant(Array.from(object.geometry.index.array).every(Number.isFinite),
        `${label} has a non-finite geometry index`);
    }
    vertices += object.geometry.attributes.position?.count || 0;
  });
  invariant(localGeometryCount > 0, `${label} produced no geometry`);
}

function verifyRenderedGate(parcel, style, suffix = '') {
  const label = `${style}${suffix}:${parcel.id}`;
  const expected = verifyPlanGate(parcel, label);
  const wall = buildVillageWall(parcel.shape, wallMats, {
    style,
    kind: parcel.kind,
    seed: parcel.seed,
    char01: plan.opts.char01,
    plotW: parcel.plotW,
    plotD: parcel.plotD,
    gateEdge: parcel.access.gateEdge,
    gateT: parcel.access.gateT,
  });

  invariant(wall.userData.gate?.edge === parcel.access.gateEdge,
    `${label} renderer lost gateEdge`);
  invariant(Math.abs(wall.userData.gate.t - parcel.access.gateT) <= EPSILON,
    `${label} renderer lost gateT`);
  invariant(pointError(wall.userData.gate.point, expected) <= EPSILON,
    `${label} renderer gate metadata moved from the planned center`);

  const edge = parcel.access.gateEdge;
  const a = parcel.shape.pts[edge];
  const b = parcel.shape.pts[(edge + 1) % parcel.shape.pts.length];
  const expectedYaw = Math.atan2(-(b.z - a.z), b.x - a.x);
  const physicalGate = wall.children.find((child) => child.isGroup
    && pointError({ x: child.position.x, z: child.position.z }, expected) <= EPSILON
    && angleError(child.rotation.y, expectedYaw) <= EPSILON
    && child.children.length >= 3);
  invariant(physicalGate, `${label} has no physical gate at the planned center`);
  verifyFiniteGeometry(wall, label);
}

for (const style of STYLES) verifyRenderedGate(regular, style);
verifyRenderedGate(hero, 'tile', ':hero');

console.log(
  `WALL GATE CONTRACT: PASS (${STYLES.length} styles, hero ${hero.access.gateRole} gate, `
  + `${objects} objects, ${vertices} vertices, ${(performance.now() - startedAt).toFixed(0)}ms)`,
);
