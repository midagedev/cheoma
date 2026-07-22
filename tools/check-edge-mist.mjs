import assert from 'node:assert/strict';
import { edgeMistViewWeight } from '../src/env/edge-mist-view.js';

const forwardY = (downDegrees) => -Math.sin(downDegrees * Math.PI / 180);

assert.equal(edgeMistViewWeight(0), 1,
  'a horizon-level view must retain the authored edge mist');
assert.equal(edgeMistViewWeight(forwardY(8)), 1,
  'an eye-level downward glance must retain the authored edge mist');
assert.equal(edgeMistViewWeight(forwardY(10)), 1,
  'the fade must start continuously at its lower boundary');
assert.equal(edgeMistViewWeight(forwardY(18)), 0,
  'an aerial view must fully suppress the horizontal annulus');
assert.equal(edgeMistViewWeight(forwardY(30)), 0,
  'steeper aerial views must remain free of transparent wedges');
assert.equal(edgeMistViewWeight(0.5), 1,
  'looking upward must not dim ground mist');

const partial = [12, 14, 16].map((degrees) => edgeMistViewWeight(forwardY(degrees)));
assert.ok(partial[0] > partial[1] && partial[1] > partial[2]
    && partial.every((weight) => weight > 0 && weight < 1),
  `edge mist must fade continuously through the transition band (${partial.join(', ')})`);

let previous = 1;
for (let degrees = 10; degrees <= 18; degrees += 0.25) {
  const weight = edgeMistViewWeight(forwardY(degrees));
  assert.ok(weight >= 0 && weight <= previous,
    `edge mist fade is not bounded and monotonic at ${degrees}°`);
  previous = weight;
}

assert.equal(edgeMistViewWeight(NaN), 0,
  'invalid camera state must fail closed instead of covering the scene');
assert.equal(edgeMistViewWeight(Infinity), 0,
  'non-finite camera state must fail closed instead of covering the scene');

console.log('EDGE MIST VIEW: PASS');
