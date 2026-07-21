// 마을 재생성 wave의 프레임워크 독립 계약.
// scenery는 material alpha 없이 한 root만 소유하고, palace를 포함한 구조물만 tofu wave를 탄다.
import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const requireApp = createRequire(join(ROOT, 'app', 'package.json'));
const esbuild = requireApp('esbuild');
const THREE_MAIN = join(ROOT, 'app/node_modules/three/build/three.module.js');
const THREE_ADDONS = join(ROOT, 'app/node_modules/three/examples/jsm');

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

const built = await esbuild.build({
  stdin: {
    contents: "export { createRerollWave } from './src/village/wave.js'; export * as THREE from 'three';",
    resolveDir: ROOT,
    sourcefile: 'wave-contract-entry.js',
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
const { createRerollWave, THREE } = await import(moduleUrl);

function fixture() {
  const geometry = new THREE.BoxGeometry(2, 2, 2);
  const material = new THREE.MeshStandardMaterial({
    opacity: 1,
    transparent: false,
    depthWrite: true,
  });
  const materialVersion = material.version;

  const makeRoot = () => {
    const root = new THREE.Group();
    const roads = new THREE.Group();
    roads.name = 'village-roads';
    const roadMesh = new THREE.Mesh(geometry, material);
    roads.add(roadMesh);

    const palace = new THREE.Group();
    palace.name = 'palace-merged';
    palace.add(new THREE.Mesh(geometry, material));

    const ambient = new THREE.Group();
    ambient.name = 'village-ambient-wave-owner';
    const weights = [];
    ambient.userData.waveFade = { setWeight: (value) => weights.push(value) };

    root.add(roads, palace, ambient);
    return { root, roads, roadMesh, palace, weights };
  };

  const old = makeRoot();
  const incoming = makeRoot();
  const wave = createRerollWave({
    oldRoot: old.root,
    newRoot: incoming.root,
    center: { x: 0, z: 0 },
    seed: 20260716,
    duration: 1,
  });
  const materialIntact = () => old.roadMesh.material === material
    && incoming.roadMesh.material === material
    && material.opacity === 1
    && material.transparent === false
    && material.depthWrite === true
    && material.version === materialVersion;
  const dispose = () => { geometry.dispose(); material.dispose(); };
  return { old, incoming, wave, materialIntact, dispose };
}

const handoff = fixture();
invariant(handoff.materialIntact(), 'wave construction mutated or cloned a shared scenery material');

for (const t of [0, 0.19, 0.20, 0.35, 0.49, 0.50, 0.51, 0.80, 1]) {
  handoff.wave.seek(t);
  invariant(handoff.old.roads.visible !== handoff.incoming.roads.visible,
    `scenery ownership overlapped or went blank at t=${t}`);
  invariant(handoff.wave.sceneryOwner === (t < 0.5 ? 'old' : 'new'),
    `scenery owner drifted at t=${t}`);
  invariant(Math.abs(handoff.wave.veil + handoff.wave.shadowWeight - 1) < 1e-12,
    `veil/shadow complement drifted at t=${t}`);
  const oldWeight = handoff.old.weights.at(-1);
  const incomingWeight = handoff.incoming.weights.at(-1);
  invariant(Math.abs(oldWeight - (t < 0.5 ? handoff.wave.shadowWeight : 0)) < 1e-12
      && Math.abs(incomingWeight - (t >= 0.5 ? handoff.wave.shadowWeight : 0)) < 1e-12,
    `dynamic scenery did not fade through the exclusive owner at t=${t}`);
  invariant(handoff.materialIntact(), `scenery material mutated at t=${t}`);
}
handoff.wave.seek(0.5);
invariant(handoff.wave.veil === 1 && handoff.wave.shadowWeight === 0,
  'ink veil does not fully cover the scenery handoff peak');
invariant(handoff.old.weights.at(-1) === 0 && handoff.incoming.weights.at(-1) === 0,
  'dynamic scenery remained visible at the handoff peak');

let oldPalaceAnimated = false;
for (let t = 0.001; t < 0.42; t += 0.005) {
  handoff.wave.seek(t);
  oldPalaceAnimated ||= handoff.old.palace.visible
    && Math.abs(handoff.old.palace.scale.x - 1) > 1e-3;
}
invariant(oldPalaceAnimated, 'palace-merged did not participate in old structure disassembly');
let incomingPalaceAnimated = false;
for (let t = 0.551; t < 1; t += 0.005) {
  handoff.wave.seek(t);
  incomingPalaceAnimated ||= handoff.incoming.palace.visible
    && Math.abs(handoff.incoming.palace.scale.x - 1) > 1e-3;
}
invariant(incomingPalaceAnimated, 'palace-merged did not participate in incoming structure assembly');

handoff.wave.seek(0.45);
handoff.wave.cancel();
handoff.wave.cancel();
invariant(handoff.wave.isDone() && handoff.wave.progress === 0
    && handoff.wave.veil === 0 && handoff.wave.sceneryOwner === 'old',
  'cancel did not restore the old presentation state idempotently');
invariant(handoff.old.roads.visible && !handoff.incoming.roads.visible
    && handoff.old.palace.visible && !handoff.incoming.palace.visible,
  'cancel did not restore exclusive old-root ownership');
invariant(handoff.old.palace.scale.x === 1 && handoff.materialIntact(),
  'cancel left a structure transform or material mutation behind');
handoff.dispose();

const finish = fixture();
finish.wave.seek(0.45);
finish.wave.dispose();
finish.wave.dispose();
invariant(finish.wave.isDone() && finish.wave.progress === 1
    && finish.wave.veil === 0 && finish.wave.sceneryOwner === 'new',
  'dispose did not settle the incoming presentation idempotently');
invariant(!finish.old.roads.visible && finish.incoming.roads.visible
    && !finish.old.palace.visible && finish.incoming.palace.visible,
  'dispose did not settle exclusive incoming-root ownership');
invariant(finish.incoming.palace.scale.x === 1 && finish.materialIntact(),
  'dispose left a structure transform or material mutation behind');
finish.dispose();

console.log('WAVE CONTRACT: PASS (exclusive scenery handoff, opaque materials, palace tofu, cancel/dispose)');
