// #222 scatter instanceColor 값 층화 — 순수 수식 + esbuild 번들 조립 단언.
//   · foliage-value-stratify: 능선 어둡게·산자락 밝게·침엽 deep 더 짙게
//   · scatter 조립: instanceColor 존재, 그루 간 분산, 시드 결정론
// 브라우저 불필요. FAST_CHECKS.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import {
  FOLIAGE_VALUE_STRATIFY,
  foliageHillBias,
  foliageInstanceTint,
  stratifyFoliageRgb,
} from '../src/village/foliage-value-stratify.js';

// ── 순수 수식 ──────────────────────────────────────────────────────────
const mid = foliageInstanceTint(0.5, 0.5, false);
const ridge = foliageInstanceTint(0.5, 1.0, false);
const foothill = foliageInstanceTint(0.5, 0.0, false);
const luma = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

assert.ok(luma(ridge) < luma(mid), `ridge must be darker than mid (${luma(ridge)} < ${luma(mid)})`);
assert.ok(luma(foothill) > luma(mid), `foothill must be brighter than mid (${luma(foothill)} > ${luma(mid)})`);

const pineDeep = foliageInstanceTint(0.5, 0.5, true);
const broad = foliageInstanceTint(0.5, 0.5, false);
assert.ok(luma(pineDeep) < luma(broad), 'pine deep tint must be darker than broad at same axes');

// 능선은 차갑게(b↑·r↓ 방향), 산자락은 상대적으로 따뜻.
assert.ok(ridge.b / Math.max(1e-6, ridge.r) > foothill.b / Math.max(1e-6, foothill.r),
  'ridge tint must be cooler (higher b/r) than foothill');

// 절대색에 층화를 곱해도 축이 같다(forest 경로 동형).
const base = { r: 0.25, g: 0.35, b: 0.18 };
const abs = stratifyFoliageRgb(base.r, base.g, base.b, 0.4, 0.7, true);
const tint = foliageInstanceTint(0.4, 0.7, true);
assert.ok(Math.abs(abs.r - base.r * tint.r) < 1e-9, 'absolute path = base × white tint (r)');
assert.ok(Math.abs(abs.g - base.g * tint.g) < 1e-9, 'absolute path = base × white tint (g)');
assert.ok(Math.abs(abs.b - base.b * tint.b) < 1e-9, 'absolute path = base × white tint (b)');

// hillBias 는 기존 forest 온셋과 동일(0.3→0.85).
assert.equal(foliageHillBias(0.3), 0);
assert.equal(foliageHillBias(0.85), 1);
assert.ok(foliageHillBias(0.575) > 0.4 && foliageHillBias(0.575) < 0.6);

// 틴트 배율 상·하한(문서 계약): 대략 0.45~1.55 안에 머문다.
for (const t of [0, 0.25, 0.5, 0.75, 1]) {
  for (const h of [0, 0.35, 0.7, 1]) {
    for (const deep of [false, true]) {
      const c = foliageInstanceTint(t, h, deep);
      for (const ch of [c.r, c.g, c.b]) {
        assert.ok(ch > 0.45 && ch < 1.55,
          `tint channel out of band t=${t} h=${h} deep=${deep}: ${ch}`);
      }
    }
  }
}
assert.equal(FOLIAGE_VALUE_STRATIFY.valueT, 0.32);
assert.equal(FOLIAGE_VALUE_STRATIFY.valueHill, 0.40);

// ── scatter 조립 (app three 경로 esbuild 번들) ─────────────────────────
const ROOT = resolve(import.meta.dirname, '..');
const requireApp = createRequire(join(ROOT, 'app', 'package.json'));
const esbuild = requireApp('esbuild');
const built = await esbuild.build({
  stdin: {
    contents: `
      export { scatterTrees } from './src/generators/village/trees.js';
    `,
    resolveDir: ROOT,
    sourcefile: 'scatter-tree-color-entry.js',
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
const { scatterTrees } = await import(url);

// 최소 site 픽스처: 능선·중사면·산자락이 섞이도록 hill/height 를 위치에 연동.
function makeSite() {
  const R = 120, bowlR = 40, terrainR = 140;
  return {
    R, bowlR, terrainR, Hmax: 40,
    center: { x: 0, z: 0 },
    seed: 7,
    heightAt: (x, z) => 2 + 18 * Math.max(0, (Math.hypot(x, z) - bowlR) / (terrainR - bowlR)),
    hillAt: (x, z) => Math.min(1, Math.max(0, (Math.hypot(x, z) - bowlR * 0.9) / (terrainR * 0.55))),
  };
}

const site = makeSite();
const group = scatterTrees(site, null, 7, null, 1);
assert.equal(group.name, 'village-trees');
assert.equal(group.userData.instanceColorStratified, true, 'scatter must flag instanceColor stratification');

let meshes = 0, total = 0, withColor = 0;
const lumas = [];
const matrixDigests = [];
const colorByName = new Map();
group.traverse((o) => {
  if (!o.isInstancedMesh) return;
  meshes++;
  total += o.count;
  assert.ok(o.instanceColor, `${o.name} missing instanceColor`);
  assert.equal(o.instanceColor.count, o.count, `${o.name} instanceColor length`);
  withColor++;
  const arr = o.instanceColor.array;
  colorByName.set(o.name, Array.from(arr));
  for (let i = 0; i < o.count; i++) {
    lumas.push(0.2126 * arr[i * 3] + 0.7152 * arr[i * 3 + 1] + 0.0722 * arr[i * 3 + 2]);
  }
  let h = 2166136261;
  const m = o.instanceMatrix.array;
  for (let i = 0; i < m.length; i++) {
    h ^= Math.floor(m[i] * 1e4);
    h = Math.imul(h, 16777619);
  }
  matrixDigests.push(`${o.name}:${o.count}:${(h >>> 0).toString(16)}`);
});

assert.ok(meshes >= 1, 'expected at least one scatter InstancedMesh');
assert.equal(withColor, meshes, 'every scatter mesh must carry instanceColor');
assert.ok(total >= 8, `expected a useful scatter population, got ${total}`);

const minL = Math.min(...lumas), maxL = Math.max(...lumas);
assert.ok(maxL - minL > 0.08,
  `instanceColor luma span too narrow (${minL.toFixed(3)}..${maxL.toFixed(3)}) — stratification not audible`);

// 같은 시드 재조립: 매트릭스·색 모두 결정론.
const group2 = scatterTrees(site, null, 7, null, 1);
const digests2 = [];
group2.traverse((o) => {
  if (!o.isInstancedMesh) return;
  let h = 2166136261;
  const m = o.instanceMatrix.array;
  for (let i = 0; i < m.length; i++) {
    h ^= Math.floor(m[i] * 1e4);
    h = Math.imul(h, 16777619);
  }
  digests2.push(`${o.name}:${o.count}:${(h >>> 0).toString(16)}`);
  assert.deepEqual(
    Array.from(o.instanceColor.array),
    colorByName.get(o.name),
    `${o.name} instanceColor must be seed-stable`,
  );
});
assert.deepEqual(digests2, matrixDigests, 'scatter matrices must be seed-stable');

console.log(`SCATTER TREE COLOR: PASS (meshes=${meshes} trees=${total} luma ${minL.toFixed(3)}..${maxL.toFixed(3)})`);
