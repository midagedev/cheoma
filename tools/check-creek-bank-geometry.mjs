// 개천 호안 형상 계약 — #20 R4 Phase B.
//
// 이 게이트가 존재하는 이유(회귀 사고 2026-08-01): 호안 자연석 배치가 `boulderGeometry()` 결과를
//   인덱스 지오메트리로 가정하고 `getIndex().count` 를 읽었다. 그 지오메트리는 IcosahedronGeometry
//   (= PolyhedronGeometry) 라 **비인덱스**이고 `getIndex()` 가 null 이라 TypeError 가 났다. 그 호출이
//   buildFeatureObjects 안에 있어 **호안을 만드는 유일한 규모인 한양이 통째로 생성되지 않았다**
//   (독립 관측 3건: populateVillage 안 `Cannot read properties of null (reading 'count')`,
//   App.svelte $effect pageerror, worker 0/1 각각 420초 타임아웃). 순수 plan 게이트는 이 계열을
//   절대 잡을 수 없다 — 계획은 정상이고 **형상 조립**이 죽었기 때문이다.
//
// 그래서 이 게이트는 실제 `buildCreekBanks` 를 돌린다. props 재질은 캔버스 텍스처(=DOM)를 만들므로
//   drainage 와 같은 **재질 주입** 규약으로 평범한 MeshStandardMaterial 을 넣어 노드에서 돌린다.
//   그 덕분에 "재질을 차용만 한다"는 예산 계약도 같은 자리에서 검사된다.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const requireApp = createRequire(join(ROOT, 'app', 'package.json'));
const esbuild = requireApp('esbuild');
const built = await esbuild.build({
  stdin: {
    contents: `
      export * as THREE from 'three';
      export { planVillage } from './src/api/village-plan.js';
      export { planCreekBanks } from './src/api/creek-bank-plan.js';
      export {
        CREEK_BANK_MATERIAL_ROLES,
        buildCreekBanks,
        disposeCreekBanks,
      } from './src/api/creek-bank.js';
    `,
    resolveDir: ROOT,
    sourcefile: 'creek-bank-geometry-contract-entry.js',
  },
  alias: {
    'three/addons/utils/BufferGeometryUtils.js': join(
      ROOT, 'app/node_modules/three/examples/jsm/utils/BufferGeometryUtils.js',
    ),
    three: join(ROOT, 'app/node_modules/three/build/three.module.js'),
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  write: false,
  logLevel: 'silent',
});
const url = `data:text/javascript;base64,${Buffer.from(
  built.outputFiles[0].contents,
).toString('base64')}`;
const {
  THREE,
  planVillage,
  planCreekBanks,
  CREEK_BANK_MATERIAL_ROLES,
  buildCreekBanks,
  disposeCreekBanks,
} = await import(url);

const started = performance.now();

function makeMaterials() {
  const made = {};
  for (const role of CREEK_BANK_MATERIAL_ROLES) made[role] = new THREE.MeshStandardMaterial();
  return made;
}

// 회귀 픽스처: check-creek 과 같은 도성 시드. 자연석(natural) 구간이 0 이 아닌 시드가 반드시
//   포함되어야 한다 — 사고를 일으킨 코드 경로가 바로 그 구간이다(아래에서 단언한다).
const SEEDS = [2026, 7, 99, 777, 55, 4242, 1];
const rows = [];

for (const seed of SEEDS) {
  const label = `hanyang/${seed}`;
  const plan = planVillage({ scale: 'hanyang', seed, includePalace: true });
  const banks = planCreekBanks(plan.site);
  assert.equal(banks.urban, true, `${label}: 도성 개천에 호안 계획이 없다`);
  assert.ok(banks.stats.natural > 0,
    `${label}: 자연석 구간이 0 — 사고를 일으킨 경로가 이 픽스처에서 실행되지 않는다`);
  assert.ok(banks.stats.revetment > 0, `${label}: 석축 구간이 0`);

  const materials = makeMaterials();
  const before = new Set(Object.values(materials));
  const root = buildCreekBanks(banks, { materials });
  assert.ok(root, `${label}: 호안 형상이 만들어지지 않았다`);

  const meshes = [];
  root.traverse((object) => { if (object.isMesh) meshes.push(object); });
  assert.ok(meshes.length >= 1 && meshes.length <= CREEK_BANK_MATERIAL_ROLES.length,
    `${label}: 호안 메시가 ${meshes.length}개 — 역할 수(${CREEK_BANK_MATERIAL_ROLES.length}) 안이어야 한다`);
  // 자연석 역할 메시가 실제로 나와야 한다. 사고 당시 이 경로가 던졌고, 던지지 않도록 고친 뒤에도
  //   "조용히 0개"가 되면 회귀를 놓친다.
  assert.ok(meshes.some((mesh) => mesh.name === 'creek-bank-natural'),
    `${label}: 자연석 메시가 없다 — 성 밖 위계가 형상으로 나오지 않았다`);

  let totalTriangles = 0;
  for (const mesh of meshes) {
    const tag = `${label}/${mesh.name}`;
    const geometry = mesh.geometry;
    // ── 이 절이 사고 계열을 직접 막는다 ──────────────────────────────────────
    const position = geometry.getAttribute('position');
    assert.ok(position, `${tag}: position 속성이 null 이다`);
    assert.ok(position.count > 0, `${tag}: position 정점이 0개다`);
    const index = geometry.getIndex();
    assert.ok(index, `${tag}: index 가 null 이다 — 소비부가 getIndex().count 에서 죽는다`);
    assert.equal(index.count % 3, 0, `${tag}: 인덱스 수가 삼각형 배수가 아니다`);
    assert.ok(index.count > 0, `${tag}: 삼각형이 0개인 메시가 씬에 들어간다`);
    let maxIndex = -1;
    for (let i = 0; i < index.count; i++) maxIndex = Math.max(maxIndex, index.getX(i));
    assert.ok(maxIndex < position.count,
      `${tag}: 인덱스 ${maxIndex} 가 정점 수 ${position.count} 밖을 가리킨다`);
    const normal = geometry.getAttribute('normal');
    assert.ok(normal && normal.count === position.count,
      `${tag}: normal 속성이 position 과 짝이 맞지 않는다`);
    for (let i = 0; i < position.count; i++) {
      assert.ok(Number.isFinite(position.getX(i))
        && Number.isFinite(position.getY(i))
        && Number.isFinite(position.getZ(i)),
      `${tag}: 정점 ${i} 좌표가 유한하지 않다`);
    }
    // 예산: 재질은 차용이고 그림자 캐스터를 늘리지 않는다.
    assert.ok(before.has(mesh.material),
      `${tag}: 주입한 재질이 아니라 자기 재질을 쓴다 — 병합 후 드로우콜이 늘어난다`);
    assert.equal(mesh.castShadow, false, `${tag}: 그림자 캐스터가 늘었다`);
    totalTriangles += index.count / 3;
  }

  // 소유권: dispose 는 지오메트리만 해제하고 차용 재질은 살려 둔다.
  disposeCreekBanks(root);
  for (const material of before) {
    assert.ok(!material.__disposed_marker_unused, `${label}: 차용 재질이 dispose 됐다`);
  }

  rows.push({ seed, meshes: meshes.length, triangles: totalTriangles, ...banks.stats });
}

// 빈 계획은 아무것도 할당하지 않고 조기 반환한다(농촌 개울이 형상 경로를 타지 않는 증거).
for (const scale of ['hamlet', 'village', 'town', 'capital']) {
  const plan = planVillage({ scale, seed: 2026, includePalace: scale === 'capital' });
  const banks = planCreekBanks(plan.site);
  assert.equal(banks.urban, false, `${scale}: 농촌 개울이 개착 하천으로 표시됐다`);
  assert.equal(buildCreekBanks(banks, { materials: makeMaterials() }), null,
    `${scale}: 빈 호안 계획이 형상을 만들었다 — 빈 레코드는 조기 반환해야 한다`);
}
assert.equal(buildCreekBanks(null), null, 'null 계획이 조기 반환하지 않는다');
assert.equal(buildCreekBanks({ urban: true, runs: [] }), null, '빈 runs 가 조기 반환하지 않는다');

// 재질 주입은 역할 계약을 강제한다(잘못된 주입이 조용히 통과하면 예산 검사가 무의미해진다).
assert.throws(() => buildCreekBanks(
  planCreekBanks(planVillage({ scale: 'hanyang', seed: 2026, includePalace: true }).site),
  { materials: { face: new THREE.MeshStandardMaterial() } },
), /materials\.(shade|natural) must be a THREE\.Material/, '불완전한 재질 주입이 통과했다');

const triangles = rows.map((row) => row.triangles);
console.log(`  호안 형상: ${rows.length}개 도성, 메시 ${Math.min(...rows.map((r) => r.meshes))}~`
  + `${Math.max(...rows.map((r) => r.meshes))}개, 삼각형 ${Math.min(...triangles)}~${Math.max(...triangles)}`);
console.log(`CREEK BANK GEOMETRY: PASS (${rows.length} hanyang seeds, `
  + `${(performance.now() - started).toFixed(0)}ms)`);
