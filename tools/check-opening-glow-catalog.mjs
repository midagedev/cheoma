import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const requireApp = createRequire(join(ROOT, 'app', 'package.json'));
const esbuild = requireApp('esbuild');
const built = await esbuild.build({
  stdin: {
    contents: `
      export { buildKindDecomps } from './src/generators/village/houses.js';
      export { CHOGA_VARIANTS, GIWA_VARIANTS } from './src/village/variants.js';
    `,
    resolveDir: ROOT,
    sourcefile: 'opening-glow-catalog-contract-entry.js',
  },
  alias: {
    'three/addons': join(ROOT, 'app/node_modules/three/examples/jsm'),
    three: join(ROOT, 'app/node_modules/three/build/three.module.js'),
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  write: false,
  logLevel: 'silent',
});

function makeCanvas() {
  const noop = () => {};
  const gradient = Object.freeze({ addColorStop: noop });
  let canvas;
  const context = new Proxy({}, {
    get(target, key) {
      if (key === 'canvas') return canvas;
      if (key === 'createLinearGradient' || key === 'createRadialGradient') {
        return () => gradient;
      }
      if (!(key in target)) target[key] = noop;
      return target[key];
    },
    set(target, key, value) { target[key] = value; return true; },
  });
  canvas = {
    width: 0,
    height: 0,
    getContext(type) {
      assert.equal(type, '2d', 'building prototype requested a non-2D canvas');
      return context;
    },
  };
  return canvas;
}

const previousDocument = globalThis.document;
globalThis.document = {
  createElement(tag) {
    assert.equal(String(tag).toLowerCase(), 'canvas', 'prototype allocated a non-canvas DOM node');
    return makeCanvas();
  },
};

const moduleUrl = `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString('base64')}`;
const production = await import(moduleUrl);
const { buildKindDecomps, CHOGA_VARIANTS, GIWA_VARIANTS } = production;
const ANCHOR_KEYS = [
  'height', 'kind', 'openingId', 'outward', 'position', 'primary', 'style', 'width',
];
const VECTOR_KEYS = ['x', 'y', 'z'];

function assertPlainFrozen(value, path) {
  if (value == null || ['string', 'number', 'boolean'].includes(typeof value)) return;
  assert.equal(typeof value, 'object', `${path} contains a non-JSON value`);
  assert(Object.isFrozen(value), `${path} is mutable`);
  assert(Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype,
    `${path} retained a renderer or drawable instance`);
  for (const [key, child] of Object.entries(value)) assertPlainFrozen(child, `${path}.${key}`);
}

function assertAnchor(anchor, label) {
  assert.deepEqual(Object.keys(anchor).sort(), ANCHOR_KEYS, `${label} schema drifted`);
  assert.deepEqual(Object.keys(anchor.position).sort(), VECTOR_KEYS, `${label} position schema drifted`);
  assert.deepEqual(Object.keys(anchor.outward).sort(), VECTOR_KEYS, `${label} outward schema drifted`);
  assert(anchor.openingId.length > 0 && ['door', 'window'].includes(anchor.kind),
    `${label} lost opening identity`);
  assert(Number.isFinite(anchor.width) && anchor.width > 0
      && Number.isFinite(anchor.height) && anchor.height > 0,
  `${label} has invalid dimensions`);
  assert(Object.values(anchor.position).every(Number.isFinite)
      && Object.values(anchor.outward).every(Number.isFinite),
  `${label} has non-finite coordinates`);
  const outwardLength = Math.hypot(anchor.outward.x, anchor.outward.y, anchor.outward.z);
  assert(Math.abs(outwardLength - 1) < 1e-9, `${label} outward is not normalized`);
  assertPlainFrozen(anchor, label);
}

function assertMirrored(source, mirrored, label) {
  assert.equal(mirrored.length, source.length, `${label} changed anchor count`);
  for (let index = 0; index < source.length; index++) {
    const a = source[index];
    const b = mirrored[index];
    assert.equal(b.openingId, a.openingId, `${label}:${index} changed opening identity`);
    assert.equal(b.position.x, -a.position.x, `${label}:${index} did not mirror position x`);
    assert.equal(b.position.y, a.position.y, `${label}:${index} changed position y`);
    assert.equal(b.position.z, a.position.z, `${label}:${index} changed position z`);
    assert.equal(b.outward.x, -a.outward.x, `${label}:${index} did not mirror outward x`);
    assert.equal(b.outward.y, a.outward.y, `${label}:${index} changed outward y`);
    assert.equal(b.outward.z, a.outward.z, `${label}:${index} changed outward z`);
    for (const key of ['kind', 'style', 'primary', 'width', 'height']) {
      assert.equal(b[key], a[key], `${label}:${index} changed ${key}`);
    }
  }
}

let checked = 0;
for (const [kind, variants] of [
  ['choga', CHOGA_VARIANTS],
  ['giwa', GIWA_VARIANTS],
]) {
  const first = buildKindDecomps(kind);
  const repeat = buildKindDecomps(kind);
  assert.equal(first.decomps.length, variants.length, `${kind} decomp catalog length changed`);
  assert.equal(first.glowAnchors.length, variants.length, `${kind} glow catalog length changed`);
  assert(Object.isFrozen(first.glowAnchors), `${kind} glow catalog is mutable`);
  assert(first.matset && typeof first.matset === 'object', `${kind} lost its material set`);
  assert.equal(JSON.stringify(first.glowAnchors), JSON.stringify(repeat.glowAnchors),
    `${kind} glow catalog is not deterministic`);

  for (let variantIndex = 0; variantIndex < variants.length; variantIndex++) {
    const label = `${kind}:${variants[variantIndex].name}`;
    const anchors = first.glowAnchors[variantIndex];
    assert(anchors.length > 0, `${label} has no opening glow anchors`);
    assert(Object.isFrozen(anchors), `${label} anchor list is mutable`);
    assert(first.decomps[variantIndex].length > 0, `${label} lost its drawable decomposition`);
    assert(first.decomps[variantIndex].every((entry) => (
      entry.material?.isMaterial && entry.geometry?.isBufferGeometry
    )), `${label} changed the material/geometry decomposition contract`);
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(anchors)), `${label} is not JSON-safe`);
    anchors.forEach((anchor, anchorIndex) => assertAnchor(anchor, `${label}:${anchorIndex}`));
    if (variants[variantIndex].mirrorOf != null) {
      const sourceDecomp = first.decomps[variants[variantIndex].mirrorOf];
      assert.equal(first.decomps[variantIndex].length, sourceDecomp.length,
        `${label} changed mirrored decomposition size`);
      first.decomps[variantIndex].forEach((entry, index) => {
        assert.equal(entry.material, sourceDecomp[index].material,
          `${label}:${index} allocated a material for its mirror`);
        assert.notEqual(entry.geometry, sourceDecomp[index].geometry,
          `${label}:${index} reused unmirrored geometry`);
      });
      assertMirrored(
        first.glowAnchors[variants[variantIndex].mirrorOf],
        anchors,
        label,
      );
    }
    checked += anchors.length;
  }
}

if (previousDocument === undefined) delete globalThis.document;
else globalThis.document = previousDocument;
console.log(`OPENING GLOW CATALOG: PASS (${checked} anchors across choga/giwa variants)`);
