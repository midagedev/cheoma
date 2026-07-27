// Pure contract: tile outer + underside are physically separated (no zero-thickness
// DoubleSide coplanar ceiling faces). Browser-free; production geometry via esbuild.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ROOF_MARU_SURFACE_CLEAR,
  ROOF_SHELL_THICKNESS,
} from '../src/core/surface-clearance.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const requireApp = createRequire(join(ROOT, 'app', 'package.json'));
const esbuild = requireApp('esbuild');
const THREE_MAIN = join(ROOT, 'app/node_modules/three/build/three.module.js');
const THREE_ADDONS = join(ROOT, 'app/node_modules/three/examples/jsm');

const built = await esbuild.build({
  stdin: {
    contents: "export { buildBuilding } from './src/api/building.js';"
      + " export { makeMaterials } from './src/builder/palette.js';"
      + " export { PRESETS } from './src/params.js';"
      + " export * as THREE from 'three';",
    resolveDir: ROOT,
    sourcefile: 'roof-shell-contract-entry.js',
  },
  alias: { 'three/addons': THREE_ADDONS, three: THREE_MAIN },
  bundle: true, format: 'esm', platform: 'node', target: 'node20', write: false, logLevel: 'silent',
});

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

process.on('uncaughtException', (error) => {
  console.error(`ROOF SHELL: FAIL — ${error.message}`);
  process.exit(1);
});

const { buildBuilding, makeMaterials, PRESETS, THREE } = await import(
  `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString('base64')}`
);

assert.ok(ROOF_SHELL_THICKNESS >= 0.06 && ROOF_SHELL_THICKNESS <= 0.14,
  `ROOF_SHELL_THICKNESS ${ROOF_SHELL_THICKNESS} outside the physical eave-board band`);

function centroid(mesh) {
  const pos = mesh.geometry.attributes.position;
  mesh.updateWorldMatrix(true, false);
  let sx = 0, sy = 0, sz = 0;
  const v = new THREE.Vector3();
  const step = Math.max(1, Math.floor(pos.count / 40));
  let n = 0;
  for (let i = 0; i < pos.count; i += step) {
    v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
    sx += v.x; sy += v.y; sz += v.z;
    n++;
  }
  return { x: sx / n, y: sy / n, z: sz / n };
}

/** Same-index min distance — collapses to 0 when underside offset hit a zero normal. */
function minSameIndexSeparation(outer, under) {
  outer.updateWorldMatrix(true, false);
  under.updateWorldMatrix(true, false);
  const pa = outer.geometry.attributes.position;
  const pb = under.geometry.attributes.position;
  assert.equal(pa.count, pb.count, 'outer/gaepan vertex counts differ');
  const va = new THREE.Vector3();
  const vb = new THREE.Vector3();
  let min = Infinity;
  for (let i = 0; i < pa.count; i++) {
    va.fromBufferAttribute(pa, i).applyMatrix4(outer.matrixWorld);
    vb.fromBufferAttribute(pb, i).applyMatrix4(under.matrixWorld);
    min = Math.min(min, va.distanceTo(vb));
  }
  return min;
}

function checkHouse(label, house) {
  const roof = house.getObjectByName('roof');
  assert.ok(roof, `${label}: no roof group`);
  // addRoofTileShell always inserts outer then structural gaepan as consecutive children.
  const pairs = [];
  for (let i = 0; i < roof.children.length - 1; i++) {
    const a = roof.children[i];
    const b = roof.children[i + 1];
    if (a?.name === 'roof-tile-outer' && b?.name === 'roof-gaepan') {
      pairs.push([a, b]);
    }
  }
  const outers = [];
  const unders = [];
  roof.traverse((o) => {
    if (!o.isMesh) return;
    if (o.name === 'roof-tile-outer') outers.push(o);
    if (o.name === 'roof-gaepan') unders.push(o);
  });
  assert.ok(outers.length >= 1, `${label}: missing roof-tile-outer`);
  assert.equal(unders.length, outers.length,
    `${label}: gaepan count ${unders.length} != outer count ${outers.length}`);
  assert.equal(pairs.length, outers.length,
    `${label}: expected consecutive outer/gaepan pairs (got ${pairs.length} of ${outers.length})`);
  for (const m of outers) {
    assert.equal(m.material.side, THREE.FrontSide,
      `${label}: outer tile must be FrontSide (not DoubleSide zero-thickness)`);
    assert.equal(m.userData.roofLayer, 'tile');
  }
  for (const m of unders) {
    assert.equal(m.material.side, THREE.FrontSide,
      `${label}: gaepan must be FrontSide`);
    assert.equal(m.userData.roofLayer, 'gaepan');
    assert.equal(m.userData.isRoomBanja, false,
      `${label}: gaepan must not claim to be room banja (docs/ceiling.md)`);
    assert.equal(m.material.userData?.paletteKey, 'gaepan',
      `${label}: gaepan material must use paletteKey=gaepan (not eaveBand — rim sparkle)`);
    assert.equal(m.material.userData?.isRoofGaepan, true,
      `${label}: gaepan material must set isRoofGaepan for rim exclusion`);
  }
  for (const [outer, under] of pairs) {
    const o = centroid(outer);
    const u = centroid(under);
    const sep = Math.hypot(o.x - u.x, o.y - u.y, o.z - u.z);
    assert.ok(sep >= ROOF_SHELL_THICKNESS * 0.85,
      `${label}: outer/gaepan centroid separation ${sep.toFixed(3)}m < shell thickness `
      + `(${ROOF_SHELL_THICKNESS}m) — coplanar faces would z-fight`);
    assert.ok(o.y > u.y,
      `${label}: gaepan centroid is not below outer (oy=${o.y.toFixed(3)} uy=${u.y.toFixed(3)})`);
    // Same-index vertex distance must never collapse to 0 (degenerate normals).
    const minVert = minSameIndexSeparation(outer, under);
    assert.ok(minVert >= ROOF_SHELL_THICKNESS * 0.85,
      `${label}: outer/gaepan min same-index separation ${minVert.toFixed(4)}m `
      + `< ${ROOF_SHELL_THICKNESS}m — zero-normal offset left coplanar verts`);
    assert.equal(outer.userData.asmGroup, under.userData.asmGroup,
      `${label}: outer/gaepan asmGroup mismatch (${outer.userData.asmGroup}/${under.userData.asmGroup})`);
  }
  roof.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    if (o.material.userData?.paletteKey === 'tileSurface') {
      assert.equal(o.material.side, THREE.FrontSide,
        `${label}: tileSurface still DoubleSide on ${o.name || o.type}`);
    }
  });

  // Hip / valley maru tubes must clear the outer tile — a radius embed pierces the
  // shell and z-fights under assembly / close eave cameras (docs/ceiling.md §1b).
  const maru = [];
  roof.traverse((o) => {
    if (!o.isMesh) return;
    if (o.name === 'hip-maru' || o.name === 'valley-maru') maru.push(o);
  });
  if (maru.length && outers.length) {
    const sample = (mesh, maxN = 48) => {
      mesh.updateWorldMatrix(true, false);
      const pos = mesh.geometry.attributes.position;
      const step = Math.max(1, Math.floor(pos.count / maxN));
      const v = new THREE.Vector3();
      const out = [];
      for (let i = 0; i < pos.count; i += step) {
        v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
        out.push(v.clone());
      }
      return out;
    };
    const outerPts = outers.flatMap((m) => sample(m, 36));
    let worst = Infinity;
    let worstName = '';
    for (const m of maru) {
      const pts = sample(m, 40);
      for (const a of pts) {
        for (const b of outerPts) {
          const d = a.distanceTo(b);
          if (d < worst) {
            worst = d;
            worstName = m.name;
          }
        }
      }
    }
    // Allow half the authored clear as the sample floor (tube radial verts sit at
    // clear from the surface path; sampling both meshes undershoots slightly).
    const floor = ROOF_MARU_SURFACE_CLEAR * 0.45;
    assert.ok(worst >= floor,
      `${label}: ${worstName} sits only ${worst.toFixed(4)}m from outer tile `
      + `(need ≥ ${floor.toFixed(3)}m — maru piercing shell)`);
    console.log(`  ${label}: maru↔outer min≈${worst.toFixed(3)}m (clear≥${floor.toFixed(3)})`);
  }

  console.log(`  ${label}: ${pairs.length} shell pair(s), min-sep ok`);
}

console.log('ROOF SHELL contract');

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
checkHouse('giwa', giwa);

const palace = buildBuilding({
  ...PRESETS.korea,
  style: 'palace',
  mats: makeMaterials('palace'),
});
checkHouse('palace', palace);

const temple = buildBuilding({
  ...PRESETS.temple,
  style: 'temple',
  mats: makeMaterials('temple'),
});
checkHouse('temple', temple);

console.log('ROOF SHELL: PASS');
