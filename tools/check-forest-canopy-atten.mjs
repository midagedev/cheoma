// #20 pure contract: village-adjacent canopy scale attenuation for aerial wall-line
// readability. Renderer-free — forest-crunch ownership, no Three/DOM.
import assert from 'node:assert/strict';
import { villageCanopyAtten } from '../src/village/forest-canopy-atten.js';

const bowlR = 100;
const keep = 7;
const ramp = 28;

// Outer mountain: full stature (no wall-line conflict).
const outer = villageCanopyAtten(bowlR * 1.25, bowlR, Infinity, keep, ramp);
assert.equal(outer.atten, 0, 'outer mountain canopy must not attenuate');
assert.equal(outer.yMul, 1);
assert.equal(outer.xzMul, 1);

// Deep inside bowl: radial attenuation engages.
const inner = villageCanopyAtten(bowlR * 0.4, bowlR, Infinity, keep, ramp);
assert.ok(inner.atten > 0.7, `inner bowl must attenuate strongly (atten=${inner.atten})`);
assert.ok(inner.yMul < 0.75 && inner.yMul >= 0.60, `inner yMul in [0.60,0.75) got ${inner.yMul}`);
assert.ok(inner.xzMul < 0.92 && inner.xzMul >= 0.84, `inner xzMul in [0.84,0.92) got ${inner.xzMul}`);
assert.ok(inner.yMul < inner.xzMul, 'height must fall more than footprint (wall crowns need vertical clearance)');

// Structure proximity alone shortens canopies even on the outer fringe.
const nearWall = villageCanopyAtten(bowlR * 1.05, bowlR, keep * 0.5, keep, ramp);
const farStruct = villageCanopyAtten(bowlR * 1.05, bowlR, keep + ramp * 2, keep, ramp);
assert.ok(nearWall.atten > farStruct.atten,
  `near-structure atten (${nearWall.atten}) must exceed far-structure (${farStruct.atten})`);
assert.ok(nearWall.yMul < farStruct.yMul, 'near-structure canopies must be shorter');

// Continuous radial fade through the fringe band.
let prev = villageCanopyAtten(bowlR * 0.5, bowlR, Infinity, keep, ramp).atten;
for (const k of [0.65, 0.80, 0.95, 1.10, 1.20]) {
  const a = villageCanopyAtten(bowlR * k, bowlR, Infinity, keep, ramp).atten;
  assert.ok(a <= prev + 1e-9, `radial atten must be monotone non-increasing at ${k} bowlR (${a} > ${prev})`);
  prev = a;
}

// Floor/ceiling bounds everywhere.
for (const r of [0, bowlR * 0.3, bowlR, bowlR * 1.5, bowlR * 3]) {
  for (const cd of [0, keep, keep + ramp, 1e6, Infinity]) {
    const { atten, yMul, xzMul } = villageCanopyAtten(r, bowlR, cd, keep, ramp);
    assert.ok(atten >= 0 && atten <= 1, `atten in [0,1] at r=${r} cd=${cd}`);
    assert.ok(yMul >= 0.60 && yMul <= 1, `yMul bounds at r=${r}`);
    assert.ok(xzMul >= 0.84 && xzMul <= 1, `xzMul bounds at r=${r}`);
  }
}

// Non-finite clearDist is treated as "no structure term" (radial only).
const noStruct = villageCanopyAtten(bowlR * 0.5, bowlR, NaN, keep, ramp);
const radialOnly = villageCanopyAtten(bowlR * 0.5, bowlR, Infinity, keep, ramp);
assert.equal(noStruct.atten, radialOnly.atten, 'NaN clearDist must ignore structure term');

console.log('FOREST CANOPY ATTEN: PASS');
