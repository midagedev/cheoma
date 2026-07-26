// Palette provider contract (#150 L) — browser-free.
//
// Proves canvas allocation and texture-paint RNG are injectable:
//   1. Node injects stub createCanvas + fixed RNG (no document / Math.random).
//   2. The paint path (makeThatchTexture / makeMaterials) is deterministic under
//      that context: two runs with the same seed hash equal; a different seed does not.
//   3. setTextureRandom remains a thin RNG-only wrapper (createCanvas preserved).
//   4. Dancheong source keys stay stable across injected contexts.
//   5. Product path (no injection) is restored after the gate.
//
// Pixel fidelity is not claimed — the stub records draw ops for a deterministic
// digest. Geometry gates still use their own canvas stubs independently.
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
      export {
        createPaletteContext,
        getPaletteContext,
        setPaletteContext,
        setTextureRandom,
        makeMaterials,
        makeThatchTexture,
        dancheongSourceCacheStats,
      } from './src/builder/palette.js';
      export { dancheongSourceKey, resolveDancheong } from './src/builder/dancheong.js';
      export * as THREE from 'three';
    `,
    resolveDir: ROOT,
    sourcefile: 'palette-provider-entry.js',
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

const moduleUrl = `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString('base64')}`;
const {
  createPaletteContext,
  getPaletteContext,
  setPaletteContext,
  setTextureRandom,
  makeMaterials,
  makeThatchTexture,
  dancheongSourceCacheStats,
  dancheongSourceKey,
  resolveDancheong,
  THREE,
} = await import(moduleUrl);

// ── stub canvas: records paint ops for a stable digest (no real pixels) ────────
function makeRecordingCanvasFactory() {
  const sessions = [];
  function createCanvas() {
    const ops = [];
    let width = 0;
    let height = 0;
    const gradient = {
      addColorStop(offset, color) {
        ops.push(`cs:${offset}:${color}`);
      },
    };
    const ctx = {
      set fillStyle(v) { ops.push(`fs:${v}`); },
      get fillStyle() { return '#000'; },
      set strokeStyle(v) { ops.push(`ss:${v}`); },
      get strokeStyle() { return '#000'; },
      set lineWidth(v) { ops.push(`lw:${v}`); },
      get lineWidth() { return 1; },
      fillRect(x, y, w, h) { ops.push(`fr:${x},${y},${w},${h}`); },
      strokeRect(x, y, w, h) { ops.push(`sr:${x},${y},${w},${h}`); },
      clearRect(x, y, w, h) { ops.push(`cr:${x},${y},${w},${h}`); },
      beginPath() { ops.push('bp'); },
      closePath() { ops.push('cp'); },
      moveTo(x, y) { ops.push(`mt:${x},${y}`); },
      lineTo(x, y) { ops.push(`lt:${x},${y}`); },
      rect(x, y, w, h) { ops.push(`rc:${x},${y},${w},${h}`); },
      arc(x, y, r, a0, a1, ccw) { ops.push(`ar:${x},${y},${r},${a0},${a1},${!!ccw}`); },
      ellipse(x, y, rx, ry, rot, a0, a1, ccw) {
        ops.push(`el:${x},${y},${rx},${ry},${rot},${a0},${a1},${!!ccw}`);
      },
      fill() { ops.push('fl'); },
      stroke() { ops.push('st'); },
      save() { ops.push('sv'); },
      restore() { ops.push('rs'); },
      clip() { ops.push('cl'); },
      translate(x, y) { ops.push(`tr:${x},${y}`); },
      rotate(a) { ops.push(`ro:${a}`); },
      createLinearGradient(x0, y0, x1, y1) {
        ops.push(`lg:${x0},${y0},${x1},${y1}`);
        return gradient;
      },
      createRadialGradient(x0, y0, r0, x1, y1, r1) {
        ops.push(`rg:${x0},${y0},${r0},${x1},${y1},${r1}`);
        return gradient;
      },
      getImageData(x, y, w, h) {
        return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
      },
      measureText() { return { width: 0 }; },
      get canvas() { return canvas; },
    };
    const canvas = {
      get width() { return width; },
      set width(v) { width = v; ops.push(`w:${v}`); },
      get height() { return height; },
      set height(v) { height = v; ops.push(`h:${v}`); },
      getContext(type) {
        assert.equal(type, '2d', 'palette requested a non-2D canvas context');
        return ctx;
      },
      toDataURL: () => 'data:,',
      _ops: ops,
    };
    sessions.push(canvas);
    return canvas;
  }
  return {
    createCanvas,
    digest() {
      const h = createHash('sha256');
      for (const canvas of sessions) {
        h.update(String(canvas.width));
        h.update('x');
        h.update(String(canvas.height));
        h.update('|');
        h.update(canvas._ops.join(';'));
        h.update('\n');
      }
      return h.digest('hex');
    },
    count: () => sessions.length,
    reset() { sessions.length = 0; },
  };
}

function makeFixedRng(seed) {
  let state = seed >>> 0;
  return function fixedRandom() {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

// No ambient document: createCanvas must come from the injected context.
// Math.random stays intact — three.js Object3D/Texture UUIDs consume it; the paint
// digest proves texture noise used the injected RNG (same seed → identical digest).
const hadDocument = 'document' in globalThis;
const previousDocument = globalThis.document;
delete globalThis.document;

const defaultContext = getPaletteContext();
assert.equal(typeof defaultContext.random, 'function');
assert.equal(typeof defaultContext.createCanvas, 'function');

// Paint only styles/textures that always allocate (no dancheong source cache).
// Dancheong cache keys are asserted separately so a cache hit cannot desync digests.
function paintWithSeed(seed) {
  const factory = makeRecordingCanvasFactory();
  const random = makeFixedRng(seed);
  const paletteContext = createPaletteContext({
    random,
    createCanvas: factory.createCanvas,
  });
  // Per-build injection path (makeMaterials options).
  const materials = makeMaterials('choga', { paletteContext });
  assert.ok(materials.thatch?.map, 'choga palette missing thatch map');
  assert.ok(materials.fieldstone?.map, 'choga palette missing fieldstone map');
  assert.ok(materials.maru?.map, 'choga palette missing maru map');
  // Module-active install path (setPaletteContext + standalone texture maker).
  setPaletteContext(paletteContext);
  const thatch = makeThatchTexture(0.55);
  assert.ok(thatch instanceof THREE.CanvasTexture || thatch?.isTexture,
    'makeThatchTexture did not return a texture');
  assert.ok(factory.count() > 0, 'injected createCanvas was never called');
  return { digest: factory.digest(), materials, canvasCount: factory.count() };
}

let first;
let second;
let other;
let palace;
let dancheongKey;
try {
  first = paintWithSeed(0xC0FFEE);
  second = paintWithSeed(0xC0FFEE);
  other = paintWithSeed(0xBADC0DE);

  // Dancheong: canvas comes from the provider; source keys stay content-stable.
  const dcFactory = makeRecordingCanvasFactory();
  palace = makeMaterials('palace', {
    paletteContext: createPaletteContext({
      random: makeFixedRng(0xD4C4),
      createCanvas: dcFactory.createCanvas,
    }),
  });
  assert.ok(palace.beamDancheong?.map, 'palace dancheong band texture missing');
  assert.ok(dcFactory.count() > 0, 'dancheong paint did not use injected createCanvas');
  dancheongKey = dancheongSourceKey(resolveDancheong('palace'), 'band');
  assert.equal(
    dancheongKey,
    dancheongSourceKey(resolveDancheong('palace'), 'band'),
    'dancheong source key is not stable under injected canvas',
  );
  assert.ok(dancheongKey && dancheongKey.length > 0, 'dancheong source key empty');
  // Second palace build with a different canvas provider must reuse source by key
  // (Texture/Material stay palette-owned; source canvas is cache-shared).
  const beforeSize = dancheongSourceCacheStats().size;
  const palace2 = makeMaterials('palace', {
    paletteContext: createPaletteContext({
      random: makeFixedRng(0xD4C4),
      createCanvas: makeRecordingCanvasFactory().createCanvas,
    }),
  });
  assert.ok(palace2.beamDancheong?.map, 'second palace palette missing dancheong map');
  assert.equal(
    palace.beamDancheong.map.userData.dancheongSourceKey,
    palace2.beamDancheong.map.userData.dancheongSourceKey,
    'dancheong texture source keys diverged across palettes',
  );
  assert.ok(dancheongSourceCacheStats().size >= beforeSize,
    'dancheong source cache shrank unexpectedly');
} finally {
  if (hadDocument) globalThis.document = previousDocument;
  else delete globalThis.document;
  setPaletteContext(null);
}

assert.equal(first.digest, second.digest, 'same seed produced different paint digests');
assert.notEqual(first.digest, other.digest, 'different seeds produced identical paint digests');
assert.equal(first.canvasCount, second.canvasCount, 'canvas allocation count drifted');

// setTextureRandom is a thin RNG wrapper: createCanvas identity is preserved.
const factory = makeRecordingCanvasFactory();
const canvasFn = factory.createCanvas;
const rngA = makeFixedRng(1);
const rngB = makeFixedRng(2);
setPaletteContext(createPaletteContext({ random: rngA, createCanvas: canvasFn }));
assert.equal(getPaletteContext().createCanvas, canvasFn);
setTextureRandom(rngB);
assert.equal(getPaletteContext().createCanvas, canvasFn,
  'setTextureRandom replaced createCanvas instead of only swapping RNG');
setTextureRandom(null);
assert.equal(getPaletteContext().createCanvas, canvasFn,
  'setTextureRandom(null) dropped the installed createCanvas');
// After null, random falls back to Math.random but createCanvas stays injected.
const afterNull = getPaletteContext();
assert.equal(afterNull.createCanvas, canvasFn);
assert.notEqual(afterNull.random, rngB);

// Module-active path: setPaletteContext + makeMaterials without options.
factory.reset();
setPaletteContext(createPaletteContext({
  random: makeFixedRng(0xA11CE),
  createCanvas: factory.createCanvas,
}));
const activeMats = makeMaterials('giwa');
assert.ok(activeMats.door?.map, 'giwa door texture missing under module-active context');
assert.ok(factory.count() > 0, 'module-active createCanvas was never called');
const stats = dancheongSourceCacheStats();
assert.ok(stats.max >= stats.size, 'dancheong source cache size exceeded max');
assert.ok(stats.size >= 1, 'palace paint did not populate dancheong source cache');

// Restore product defaults so other gates sharing this process see browser context.
setPaletteContext(null);
const restored = getPaletteContext();
assert.equal(typeof restored.random, 'function');
assert.equal(typeof restored.createCanvas, 'function');
// Default createCanvas must refuse node without document (product path uses document).
assert.throws(() => restored.createCanvas(), /createCanvas|document/,
  'default createCanvas did not require a document outside the browser');

console.log(
  `PALETTE PROVIDER: PASS (digest=${first.digest.slice(0, 12)}… canvases=${first.canvasCount} `
  + `dancheongCache=${stats.size}/${stats.max} key=${dancheongKey})`,
);
