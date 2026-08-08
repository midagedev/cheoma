// P0 packaging: plain Node can load and run the three-touching core without
// esbuild aliases. Root package.json must declare three@0.185.1 so bare
// `import 'three'` resolves from node_modules. Canvas textures need an
// injected palette context (document is absent in Node).
//
// (a) village-plan determinism — two planVillage calls, same JSON.
// (b) building geometry — palette stub + buildBuilding(PRESETS.giwa) + dispose.
// (c) full façade import is informational only (does not fail the gate).
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { makeRecordingCanvasFactory } from './lib/node-canvas-stub.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const api = (name) => pathToFileURL(resolve(ROOT, 'src/api', name)).href;
const builder = (name) => pathToFileURL(resolve(ROOT, 'src/builder', name)).href;

function countMeshesAndTriangles(root) {
  let meshes = 0;
  let triangles = 0;
  root.traverse((obj) => {
    if (!obj.isMesh && !obj.isInstancedMesh) return;
    meshes += 1;
    const geom = obj.geometry;
    if (!geom) return;
    const index = geom.index;
    if (index) {
      triangles += Math.floor(index.count / 3) * (obj.isInstancedMesh ? (obj.count || 1) : 1);
    } else if (geom.attributes?.position) {
      triangles += Math.floor(geom.attributes.position.count / 3)
        * (obj.isInstancedMesh ? (obj.count || 1) : 1);
    }
  });
  return { meshes, triangles };
}

// ── (a) plan layer, three-free ──────────────────────────────────────────────
{
  const { planVillage } = await import(api('village-plan.js'));
  assert.equal(typeof planVillage, 'function', 'planVillage export missing');
  const a = planVillage({ seed: 7, siteR: 120 });
  const b = planVillage({ seed: 7, siteR: 120 });
  assert.equal(
    JSON.stringify(a),
    JSON.stringify(b),
    'planVillage must be deterministic in-process for the same seed/siteR',
  );
  console.log('PASS (a) village-plan: planVillage({seed:7,siteR:120}) deterministic');
}

// ── (b) building layer needs root three + palette canvas injection ──────────
{
  const buildingMod = await import(api('building.js'));
  const { PRESETS, buildBuilding, disposeBuilding } = buildingMod;
  // setPaletteContext / createPaletteContext are not re-exported from the
  // public building façade; import the palette module directly (src is read-only).
  const { setPaletteContext, createPaletteContext } = await import(builder('palette.js'));

  assert.ok(PRESETS?.giwa, 'PRESETS.giwa missing');
  assert.equal(typeof buildBuilding, 'function');
  assert.equal(typeof disposeBuilding, 'function');

  const factory = makeRecordingCanvasFactory();
  setPaletteContext(createPaletteContext({
    random: () => 0.5,
    createCanvas: factory.createCanvas,
  }));

  const root = buildBuilding({ ...PRESETS.giwa });
  assert.ok(root, 'buildBuilding returned empty');
  const { meshes, triangles } = countMeshesAndTriangles(root);
  assert.ok(meshes > 0, `expected meshes > 0, got ${meshes}`);
  assert.ok(triangles > 0, `expected triangles > 0, got ${triangles}`);
  console.log(`PASS (b) building: meshes=${meshes} triangles=${triangles}`);

  assert.doesNotThrow(() => disposeBuilding(root), 'disposeBuilding must not throw');
  console.log('PASS (b) disposeBuilding: ok');
}

// ── (c) full façade — informational; failure does not fail the gate ─────────
{
  try {
    await import(api('index.js'));
    console.log('PASS (c) src/api/index.js full façade import succeeded');
  } catch (err) {
    const msg = err && (err.message || String(err));
    const stackTop = (err && err.stack && String(err.stack).split('\n').slice(0, 4).join('\n')) || msg;
    console.log('INFO (c) src/api/index.js full façade import failed (non-blocking):');
    console.log(stackTop);
  }
}

console.log('NODE-CORE: PASS');
