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
      export { candleFlicker } from './src/env/night-glow.js';
      export { createVillageNightGlow } from './src/runtime/village/night-glow.js';
      export { hashString } from './src/rng.js';
    `,
    resolveDir: ROOT,
    sourcefile: 'village-night-glow-contract-entry.js',
  },
  alias: { three: join(ROOT, 'app/node_modules/three/build/three.module.js') },
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  write: false,
  logLevel: 'silent',
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString('base64')}`;
const { candleFlicker, createVillageNightGlow, hashString } = await import(moduleUrl);

const WARM_LIGHT = 0xffb35c;

function makeMaterial({ hex, intensity, emissiveMap, map, glow }) {
  let value = hex;
  const stats = { getHex: 0, setHex: 0 };
  return {
    emissive: {
      getHex() { stats.getHex++; return value; },
      setHex(next) { stats.setHex++; value = next; },
    },
    emissiveIntensity: intensity,
    emissiveMap,
    map,
    needsUpdate: false,
    userData: glow == null ? {} : { hanjiGlow: glow },
    stats,
    currentHex() { return value; },
  };
}

function makeRoot(...materials) {
  return {
    traverse(visitor) {
      for (const material of materials) visitor({ material });
    },
  };
}

function assertOriginal(material, original, message) {
  assert.equal(material.currentHex(), original.hex, `${message}: emissive`);
  assert.equal(material.emissiveIntensity, original.intensity, `${message}: intensity`);
  assert.equal(material.emissiveMap, original.emissiveMap, `${message}: emissive map`);
}

const baseMap = { name: 'base-map' };
const baseEmissiveMap = { name: 'base-emissive-map' };
const baseOriginal = { hex: 0x102030, intensity: 0.37, emissiveMap: baseEmissiveMap };
const base = makeMaterial({ ...baseOriginal, map: baseMap, glow: 0.8 });
const ignored = makeMaterial({
  hex: 0x445566, intensity: 0.2, emissiveMap: null, map: null, glow: null,
});
const callbacks = [];
const glow = createVillageNightGlow(
  makeRoot(base, [base, ignored]),
  (dt, level) => callbacks.push([dt, level]),
);

assert.equal(base.stats.getHex, 1, 'base material was snapshotted more than once within one root');
assert.equal(ignored.stats.getHex, 0, 'untagged material entered night-glow ownership');

glow.setBoost(1.25);
glow.setTime('night');
assert.equal(base.currentHex(), WARM_LIGHT, 'base material was not patched at night');
assert.equal(base.emissiveMap, baseMap, 'night glow did not reuse the material map');
assert.equal(base.emissiveIntensity, 1, 'boost was not applied to the initial night level');
assert.deepEqual(callbacks, [[0, 1]], 'initial setTime callback behavior changed');

glow.update(0.25);
const basePhase = (hashString('village-base|0') / 0x100000000) * Math.PI * 2;
assert.equal(
  base.emissiveIntensity,
  0.8 * 1.25 * candleFlicker(0.25, basePhase),
  'deterministic base flicker changed',
);

const overlayMap = { name: 'overlay-map' };
const overlayEmissiveMap = { name: 'overlay-emissive-map' };
const overlayOriginal = { hex: 0x223344, intensity: 0.19, emissiveMap: overlayEmissiveMap };
const overlay = makeMaterial({ ...overlayOriginal, map: overlayMap, glow: 0.5 });
const overlayOwner = glow.add(makeRoot(base, [overlay, overlay]), 'overlay:p7');
const sharedOwner = glow.add(makeRoot(base), 'shared:base');

assert.equal(overlayOwner.length, 2, 'owner token did not deduplicate its root by identity');
assert.equal(sharedOwner.length, 1, 'shared owner token lost its material');
assert.notEqual(overlayOwner, sharedOwner, 'add() reused an owner token');
assert.equal(base.stats.getHex, 1, 'shared material was re-snapshotted by another root');
assert.equal(overlay.stats.getHex, 1, 'unique overlay material snapshot count changed');
assert.equal(overlay.currentHex(), WARM_LIGHT, 'active add() did not patch its unique material');

glow.remove(overlayOwner);
assertOriginal(overlay, overlayOriginal, 'removed unique overlay was not restored while night stayed active');
assert.equal(overlay.stats.setHex, 2, 'unique overlay was not patched and restored exactly once');
assert.equal(base.currentHex(), WARM_LIGHT, 'removing an overlay restored a still-shared base material');
glow.remove(overlayOwner);
assert.equal(overlay.stats.setHex, 2, 'repeated owner removal restored a material twice');
glow.remove(sharedOwner);
assert.equal(base.currentHex(), WARM_LIGHT, 'base ownership was lost with its duplicate owner');

glow.setTime('day');
assert.equal(callbacks.length, 2, 'post-update setTime should preserve the transition callback boundary');
glow.update(1);
assertOriginal(base, baseOriginal, 'day transition did not restore the base material');
assert.equal(base.stats.getHex, 1, 'day restoration discarded the original snapshot');

glow.setBoost(2);
glow.setTime('night', { immediate: true });
assert.equal(base.emissiveIntensity, 1.6, 'immediate night did not preserve boost behavior');
assert.equal(base.stats.getHex, 1, 'second patch cycle re-snapshotted the base material');

const disposeMap = { name: 'dispose-map' };
const disposeEmissiveMap = { name: 'dispose-emissive-map' };
const disposeOriginal = { hex: 0x334455, intensity: 0.23, emissiveMap: disposeEmissiveMap };
const disposeOnly = makeMaterial({ ...disposeOriginal, map: disposeMap, glow: 0.4 });
const duplicateAtDispose = glow.add(makeRoot(base), 'dispose:base');
const uniqueAtDispose = glow.add(makeRoot(disposeOnly), 'dispose:unique');
const baseSetsBeforeDispose = base.stats.setHex;

glow.dispose();
assertOriginal(base, baseOriginal, 'dispose did not restore multiply-owned base material');
assertOriginal(disposeOnly, disposeOriginal, 'dispose did not restore unique added material');
assert.equal(base.stats.setHex, baseSetsBeforeDispose + 1,
  'dispose restored a multiply-owned material more than once');
assert.equal(disposeOnly.stats.setHex, 2, 'dispose did not patch and restore its unique material once');

const callbacksAtDispose = callbacks.length;
const late = makeMaterial({
  hex: 0x556677, intensity: 0.31, emissiveMap: null, map: { name: 'late-map' }, glow: 0.9,
});
const inertOwner = glow.add(makeRoot(late));
glow.remove(duplicateAtDispose);
glow.remove(uniqueAtDispose);
glow.remove(inertOwner);
glow.setBoost(9);
glow.resetTransition();
glow.setTime('sunset', { immediate: true });
glow.update(1);
glow.dispose();

assert.equal(inertOwner.length, 0, 'disposed add() returned a live owner token');
assert.equal(late.stats.getHex, 0, 'disposed API acquired a late material');
assert.equal(callbacks.length, callbacksAtDispose, 'disposed API still invoked its callback');
assertOriginal(base, baseOriginal, 'disposed API mutated a restored material');

function targetIntensityAfterHistory(withPriorOwner) {
  const rootMaterial = makeMaterial({
    hex: 0x101010, intensity: 0.2, emissiveMap: null, map: null, glow: 0.4,
  });
  const target = makeMaterial({
    hex: 0x202020, intensity: 0.3, emissiveMap: null, map: null, glow: 0.7,
  });
  const prior = makeMaterial({
    hex: 0x303030, intensity: 0.4, emissiveMap: null, map: null, glow: 0.6,
  });
  const runtime = createVillageNightGlow(makeRoot(rootMaterial));
  runtime.setTime('night', { immediate: true });
  if (withPriorOwner) {
    const priorOwner = runtime.add(makeRoot(prior), 'residential:p1');
    runtime.remove(priorOwner);
  }
  runtime.add(makeRoot(target), 'residential:p42');
  runtime.update(0.5);
  const intensity = target.emissiveIntensity;
  runtime.dispose();
  return intensity;
}

assert.equal(
  targetIntensityAfterHistory(false),
  targetIntensityAfterHistory(true),
  'overlay flicker depends on prior focus/acquisition history',
);

console.log('VILLAGE NIGHT GLOW CONTRACT: PASS');
