// Standalone (not registered): #29 hero global merge source-range hide round-trip.
// Builds mergeable heroes with shared mats + one mergeStatic(ids), folds one id via
// the heroHandle-compatible visible proxy, restores, and asserts position digests
// match the pre-hide baseline (pixel-identical range restore).
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const requireApp = createRequire(join(ROOT, 'app', 'package.json'));
const esbuild = requireApp('esbuild');
const THREE_MAIN = join(ROOT, 'app/node_modules/three/build/three.module.js');
const THREE_ADDONS = join(ROOT, 'app/node_modules/three/examples/jsm');

function makeRecordingCanvasFactory() {
  function createCanvas() {
    let width = 0;
    let height = 0;
    const gradient = { addColorStop() {} };
    const ctx = {
      set fillStyle(_v) {}, get fillStyle() { return '#000'; },
      set strokeStyle(_v) {}, get strokeStyle() { return '#000'; },
      set lineWidth(_v) {}, get lineWidth() { return 1; },
      fillRect() {}, strokeRect() {}, clearRect() {},
      beginPath() {}, closePath() {}, moveTo() {}, lineTo() {},
      rect() {}, arc() {}, ellipse() {}, fill() {}, stroke() {},
      save() {}, restore() {}, clip() {}, translate() {}, rotate() {},
      createLinearGradient() { return gradient; },
      createRadialGradient() { return gradient; },
      getImageData(x, y, w, h) {
        return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
      },
      measureText() { return { width: 0 }; },
      get canvas() { return canvas; },
    };
    const canvas = {
      get width() { return width; },
      set width(v) { width = v; },
      get height() { return height; },
      set height(v) { height = v; },
      getContext(type) {
        if (type !== '2d') throw new Error(`expected 2d, got ${type}`);
        return ctx;
      },
      toDataURL: () => 'data:,',
    };
    return canvas;
  }
  return { createCanvas };
}

const built = await esbuild.build({
  stdin: {
    contents: `
      import { planVillage } from './src/village/plan.js';
      import { buildHeroParcel } from './src/generators/village/features.js';
      import {
        makeMaterials,
        canonicalizeSharedMaterials,
        setPaletteContext,
        createPaletteContext,
      } from './src/builder/palette.js';
      import { mergeStatic } from './src/village/instancing.js';
      import * as THREE from 'three';
      export {
        planVillage, buildHeroParcel, makeMaterials, canonicalizeSharedMaterials,
        setPaletteContext, createPaletteContext, mergeStatic, THREE,
      };
    `,
    resolveDir: ROOT,
    sourcefile: 'hero-global-merge-hide-entry.js',
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
const {
  planVillage,
  buildHeroParcel,
  makeMaterials,
  canonicalizeSharedMaterials,
  setPaletteContext,
  createPaletteContext,
  mergeStatic,
  THREE,
} = await import(moduleUrl);

const factory = makeRecordingCanvasFactory();
setPaletteContext(createPaletteContext({
  random: () => 0.5,
  createCanvas: factory.createCanvas,
}));

function digestPositions(group) {
  const h = createHash('sha256');
  const meshes = [];
  group.traverse((o) => {
    if (o.isMesh && o.geometry?.attributes?.position) meshes.push(o);
  });
  meshes.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  for (const mesh of meshes) {
    const arr = mesh.geometry.attributes.position.array;
    h.update(mesh.name || '');
    h.update(Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength));
  }
  return h.digest('hex');
}

// Mirrors populate.js #29: style-keyed shared mats + canon + one mergeStatic(ids).
function makeHeroSourceHideProxy(mergedGroup, id) {
  let visible = true;
  return {
    get visible() { return visible; },
    set visible(on) {
      const next = !!on;
      if (next === visible) return;
      visible = next;
      mergedGroup.userData.setHidden?.(id, !next);
    },
    userData: {},
  };
}

const plan = planVillage({ seed: 20260716, scale: 'hanyang' });
const heroes = (plan.parcels || []).filter((p) => p.hero && !p.mjaHouse);
assert.ok(heroes.length >= 2, `need ≥2 mergeable heroes, got ${heroes.length}`);

const site = { heightAt: () => 0 };
const matsCache = new Map();
const canon = new Map();
const raws = [];
const ids = [];
for (const p of heroes) {
  const style = p.heroStyle || 'hanok';
  const matStyle = style === 'palace' ? 'palace' : style;
  if (!matsCache.has(matStyle)) matsCache.set(matStyle, makeMaterials(matStyle));
  const raw = buildHeroParcel(p, site, { materials: matsCache.get(matStyle) });
  canonicalizeSharedMaterials(raw, canon);
  raws.push(raw);
  ids.push(p.id);
}

const merged = mergeStatic(raws, 'village-heroes', { ids });
assert.equal(typeof merged.userData.setHidden, 'function', 'mergeStatic must expose setHidden');
assert.ok(merged.children.length > 0, 'merged group empty');
assert.ok(
  merged.children.length <= 90,
  `expected global hero merge ≤90 material meshes, got ${merged.children.length}`,
);

const heroHandle = new Map();
for (const id of ids) heroHandle.set(id, makeHeroSourceHideProxy(merged, id));

const baseline = digestPositions(merged);
const targetId = ids[0];
const proxy = heroHandle.get(targetId);

proxy.visible = false;
assert.equal(merged.userData.isHidden(targetId), true, 'setHidden after visible=false');
const hiddenDigest = digestPositions(merged);
assert.notEqual(hiddenDigest, baseline, 'hide must change position buffer');

proxy.visible = true;
assert.equal(merged.userData.isHidden(targetId), false, 'restored isHidden');
const restored = digestPositions(merged);
assert.equal(restored, baseline, 'fold→restore must restore position digest byte-for-byte');

// Second hero independent of first
const otherId = ids[1];
heroHandle.get(otherId).visible = false;
assert.equal(merged.userData.isHidden(otherId), true);
assert.equal(merged.userData.isHidden(targetId), false);
heroHandle.get(otherId).visible = true;
assert.equal(digestPositions(merged), baseline, 'second hero fold→restore restores baseline');

console.log('HERO GLOBAL MERGE HIDE: PASS');
console.log(`  mergeable heroes: ${heroes.length} (${ids.join(', ')})`);
console.log(`  merged material meshes: ${merged.children.length}`);
console.log(`  mat styles: ${[...matsCache.keys()].join(', ')}`);
console.log(`  canon materials: ${canon.size}`);
console.log(`  baseline digest: ${baseline.slice(0, 16)}…`);
