// Pure contract: instance/merge assembly is seed-stable.
// Same fixture inputs yield identical geometry attribute digests and material order
// across two independent builds (guards against scratch-transform cross-talk or
// non-deterministic merge group order). Browser-free.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const requireApp = createRequire(join(ROOT, 'app', 'package.json'));
const esbuild = requireApp('esbuild');
const built = await esbuild.build({
  stdin: {
    contents: `
      export * as THREE from 'three';
      export {
        buildHouseInstances,
        decomposeByMaterial,
        mergeStatic,
        materialShareKey,
      } from './src/village/instancing.js';
    `,
    resolveDir: ROOT,
    sourcefile: 'instance-merge-immutability-entry.js',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  write: false,
  nodePaths: [join(ROOT, 'app/node_modules')],
  logLevel: 'silent',
});
const url = `data:text/javascript;base64,${Buffer.from(
  built.outputFiles[0].contents,
).toString('base64')}`;
const {
  THREE,
  buildHouseInstances,
  decomposeByMaterial,
  mergeStatic,
  materialShareKey,
} = await import(url);

function digestTyped(array) {
  const view = Buffer.from(array.buffer, array.byteOffset, array.byteLength);
  return createHash('sha256').update(view).digest('hex');
}

function digestGeometry(geometry) {
  const names = Object.keys(geometry.attributes).sort();
  const parts = names.map((name) => {
    const attr = geometry.attributes[name];
    return `${name}:${attr.itemSize}:${attr.normalized ? 1 : 0}:${digestTyped(attr.array)}`;
  });
  if (geometry.index) {
    parts.push(`index:${geometry.index.itemSize}:${digestTyped(geometry.index.array)}`);
  }
  return parts.join('|');
}

// Material uuid is allocated per construction and is not part of visual identity.
// Order + share key + shadow flags must match across same-seed builds.
function materialOrder(entries) {
  return entries.map((entry, index) => {
    const mat = entry.material;
    const key = materialShareKey(mat);
    return [
      index,
      mat?.name || '',
      mat?.userData?.role || '',
      mat?.userData?.paletteKey || '',
      key ?? `type:${mat?.type || 'none'}`,
      entry.castShadow ? 1 : 0,
      entry.receiveShadow ? 1 : 0,
    ].join('~');
  });
}

function digestDecomp(decomp) {
  return {
    count: decomp.length,
    materials: materialOrder(decomp),
    geometries: decomp.map((entry) => digestGeometry(entry.geometry)),
  };
}

function digestGroup(group) {
  const meshes = [];
  group.traverse((object) => {
    if (!object.isMesh && !object.isInstancedMesh) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    const rec = {
      name: object.name,
      type: object.type,
      castShadow: !!object.castShadow,
      receiveShadow: !!object.receiveShadow,
      materials: materials.map((mat) => [
        mat?.name || '',
        mat?.userData?.role || '',
        materialShareKey(mat) ?? (mat?.type || 'none'),
      ].join('~')),
      geometry: object.geometry ? digestGeometry(object.geometry) : null,
    };
    if (object.isInstancedMesh) {
      rec.count = object.count;
      rec.instanceMatrix = digestTyped(object.instanceMatrix.array);
      if (object.instanceColor) rec.instanceColor = digestTyped(object.instanceColor.array);
    }
    meshes.push(rec);
  });
  return meshes;
}

function makeParcels(seed, count = 6) {
  // Deterministic fixture parcels — seed only shifts positions so "same seed"
  // produces bit-identical matrices and "different seed" changes digests.
  return Array.from({ length: count }, (_, index) => ({
    id: `p${seed}-${index}`,
    kind: index % 2 === 0 ? 'giwa' : 'choga',
    variant: index % 2,
    seed: seed + index,
    center: { x: (index - count / 2) * 4 + (seed % 7) * 0.01, z: (seed % 5) * 0.02 },
    frontDir: { x: 0, z: 1 },
    plotD: 10,
    baseY: (seed % 3) * 0.05,
    houseLocal: { x: 0, z: 0 },
    sx: 1, sy: 1, sz: 1,
    roofTone: [1, 0.95 + (index % 3) * 0.01, 0.9],
    wallTone: [0.98, 1, 0.96],
    woodTone: [1, 0.97, 0.94],
    stoneTone: [0.95, 0.95, 0.97],
  }));
}

function makeDecompFixture(THREE, seed) {
  // Shared material refs across meshes exercise Map insertion order stability.
  const roof = new THREE.MeshStandardMaterial({ color: 0x4a4a4a, name: 'roof-fixture' });
  roof.userData.role = 'roof';
  roof.userData.paletteKey = 'fixture-roof';
  const wall = new THREE.MeshStandardMaterial({ color: 0xc8b7a0, name: 'wall-fixture' });
  wall.userData.role = 'wall';
  wall.userData.paletteKey = 'fixture-wall';
  const wood = new THREE.MeshStandardMaterial({ color: 0x6b4a2e, name: 'wood-fixture' });
  wood.userData.role = 'wood';
  wood.userData.paletteKey = 'fixture-wood';

  const root = new THREE.Group();
  root.name = `proto-${seed}`;

  // Ordinary meshes at distinct local poses.
  const a = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.8, 2.0), wall);
  a.position.set(0.1 * seed, 0.4, 0);
  a.castShadow = true;
  a.receiveShadow = true;
  const b = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.2, 2.2), roof);
  b.position.set(0, 0.95, 0);
  b.castShadow = true;
  const c = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.9, 0.15), wood);
  c.position.set(-0.5, 0.45, 0.9);
  root.add(a, b, c);

  // Instanced contribution — the hot path that previously allocated Matrix4 per instance.
  const inst = new THREE.InstancedMesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), wood, 5);
  const m = new THREE.Matrix4();
  for (let i = 0; i < inst.count; i++) {
    m.makeTranslation((i - 2) * 0.35 + seed * 0.001, 0.2, -0.6);
    inst.setMatrixAt(i, m);
  }
  inst.castShadow = true;
  root.add(inst);

  root.updateMatrixWorld(true);
  return { root, materials: { roof, wall, wood } };
}

function buildOnce(seed) {
  const { root, materials } = makeDecompFixture(THREE, seed);
  // preMatrix path (prototype-local bake): identity-like frame at origin with tiny offset
  // so invert · matrixWorld is non-trivial.
  const pre = new THREE.Matrix4().makeTranslation(seed * 0.01, 0, 0);
  const decomp = decomposeByMaterial(root, pre);
  const decompStrict = decomposeByMaterial(root, null, { partitionShadowFlags: true });

  // World-placed static merge with source tracking (walls path).
  const worldObjects = [];
  const ids = [];
  for (let i = 0; i < 4; i++) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1.2, 0.2), materials.wall);
    mesh.position.set(i * 2.5 + seed * 0.02, 0.6, seed * 0.01);
    mesh.updateMatrixWorld(true);
    worldObjects.push(mesh);
    ids.push(`wall-${seed}-${i}`);
  }
  // Detached sources (no parent) — mergeStatic reparents temporarily.
  const merged = mergeStatic(worldObjects, `merged-${seed}`, { ids });

  const parcels = makeParcels(seed);
  // Two decomp variants so material order across variant groups is covered.
  const v0 = [
    {
      geometry: new THREE.BoxGeometry(1, 1, 1),
      material: materials.wall,
      castShadow: true,
      receiveShadow: true,
    },
    {
      geometry: new THREE.BoxGeometry(1.1, 0.25, 1.1),
      material: materials.roof,
      castShadow: true,
      receiveShadow: false,
    },
  ];
  const v1 = [
    {
      geometry: new THREE.BoxGeometry(1, 1, 1.2),
      material: materials.wall,
      castShadow: true,
      receiveShadow: true,
    },
    {
      geometry: new THREE.BoxGeometry(0.12, 0.9, 0.12),
      material: materials.wood,
      castShadow: false,
      receiveShadow: true,
    },
    {
      geometry: new THREE.BoxGeometry(1.2, 0.2, 1.3),
      material: materials.roof,
      castShadow: true,
      receiveShadow: false,
    },
  ];
  const houses = buildHouseInstances('giwa', parcels, [v0, v1]);

  return {
    decomp: digestDecomp(decomp),
    decompStrict: digestDecomp(decompStrict),
    merged: digestGroup(merged),
    houses: digestGroup(houses),
    // Material identity order from decomp (uuid stable only within a build; compare roles/keys).
    decompMaterialKeys: decomp.map((e) => materialShareKey(e.material) || e.material.name),
    strictMaterialKeys: decompStrict.map((e) => materialShareKey(e.material) || e.material.name),
  };
}

function assertDeepEqualDigest(a, b, label) {
  assert.deepEqual(a, b, `${label} drifted between two same-seed builds`);
}

// ── same seed, two independent builds ──────────────────────────────────────
const SEED = 20260726;
const runA = buildOnce(SEED);
const runB = buildOnce(SEED);

assertDeepEqualDigest(runA.decomp, runB.decomp, 'decomposeByMaterial(preMatrix)');
assertDeepEqualDigest(runA.decompStrict, runB.decompStrict, 'decomposeByMaterial(strict shadow)');
assertDeepEqualDigest(runA.merged, runB.merged, 'mergeStatic');
assertDeepEqualDigest(runA.houses, runB.houses, 'buildHouseInstances');
assert.deepEqual(runA.decompMaterialKeys, runB.decompMaterialKeys,
  'material order (share keys) drifted for default decomp');
assert.deepEqual(runA.strictMaterialKeys, runB.strictMaterialKeys,
  'material order (share keys) drifted for strict decomp');

// ── different seed must not collide with the fixed digest (fixture is live) ─
const runOther = buildOnce(SEED + 99);
assert.notDeepEqual(runA.houses, runOther.houses,
  'different seed produced identical house digests — fixture is inert');
assert.notDeepEqual(runA.merged, runOther.merged,
  'different seed produced identical merge digests — fixture is inert');

// ── hide/show restores instance matrix digest (export snapshot untouched) ──
const parcels = makeParcels(SEED, 4);
const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, name: 'hide-mat' });
mat.userData.role = 'wall';
const house = buildHouseInstances('giwa', parcels, [[
  { geometry: new THREE.BoxGeometry(1, 1, 1), material: mat, castShadow: false, receiveShadow: false },
]]);
const before = house.children.map((mesh) => digestTyped(mesh.instanceMatrix.array));
const pristine = Symbol.for('cheoma.export.pristineInstanceMatrix');
const exportBefore = house.children.map((mesh) => digestTyped(mesh[pristine].array));
assert.equal(house.userData.setHidden(parcels[1].id, true), true);
assert.notDeepEqual(
  house.children.map((mesh) => digestTyped(mesh.instanceMatrix.array)),
  before,
  'setHidden did not change live matrices',
);
assert.deepEqual(
  house.children.map((mesh) => digestTyped(mesh[pristine].array)),
  exportBefore,
  'presentation hide mutated export snapshot',
);
assert.equal(house.userData.setHidden(parcels[1].id, false), true);
assert.deepEqual(
  house.children.map((mesh) => digestTyped(mesh.instanceMatrix.array)),
  before,
  'setHidden restore did not recover instance matrix bytes',
);

// ── InstancedMesh bake path digests stay stable under repeated decomp ──────
// Re-decomposing the same root twice without rebuild must also match (scratches
// must not leak across calls via residual matrix state).
const { root } = makeDecompFixture(THREE, SEED);
const pre = new THREE.Matrix4().makeTranslation(0.25, 0, -0.1);
const d1 = digestDecomp(decomposeByMaterial(root, pre));
const d2 = digestDecomp(decomposeByMaterial(root, pre));
const d3 = digestDecomp(decomposeByMaterial(root, null));
const d4 = digestDecomp(decomposeByMaterial(root, null));
assert.deepEqual(d1, d2, 'repeated preMatrix decomp drifted (scratch leak?)');
assert.deepEqual(d3, d4, 'repeated identity-pre decomp drifted (scratch leak?)');
assert.notDeepEqual(d1, d3, 'preMatrix vs identity decomp unexpectedly identical');

console.log('check-instance-merge-immutability: ok');
console.log(`  seed=${SEED} decomp materials=${runA.decomp.count} house meshes=${runA.houses.length}`);
console.log(`  geometry digests stable across twin builds; hide/restore byte-identical`);
