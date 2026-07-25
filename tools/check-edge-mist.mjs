import assert from 'node:assert/strict';
import {
  EDGE_MIST_AERIAL_FLOOR,
  RIDGE_MIST_AERIAL_FLOOR,
  edgeMistViewWeight,
  ridgeMistViewWeight,
} from '../src/env/edge-mist-view.js';

const forwardY = (downDegrees) => -Math.sin(downDegrees * Math.PI / 180);

assert.equal(edgeMistViewWeight(0), 1,
  'a horizon-level view must retain the authored edge mist');
assert.equal(edgeMistViewWeight(forwardY(8)), 1,
  'an eye-level downward glance must retain the authored edge mist');
assert.equal(edgeMistViewWeight(forwardY(10)), 1,
  'the fade must start continuously at its lower boundary');

// 부감은 링을 완전히 끄지 않는다(R5/U1). 지형 절단면·외곽 수관을 대기로 녹이는 유일한 장치라
// 0 이면 마을이 하늘에 하드컷으로 붙는다. 웨지가 두드러지지 않는 바닥 가중치까지만 내린다.
assert.ok(EDGE_MIST_AERIAL_FLOOR > 0 && EDGE_MIST_AERIAL_FLOOR < 1,
  'the aerial floor must be a bounded partial weight');
assert.equal(edgeMistViewWeight(forwardY(30)), EDGE_MIST_AERIAL_FLOOR,
  'an aerial view must settle on the authored atmospheric floor');
assert.equal(edgeMistViewWeight(forwardY(60)), EDGE_MIST_AERIAL_FLOOR,
  'steeper aerial views must not dip below the floor');
assert.equal(edgeMistViewWeight(forwardY(89)), EDGE_MIST_AERIAL_FLOOR,
  'a top-down view must still keep the terrain edge dissolving');
assert.equal(edgeMistViewWeight(0.5), 1,
  'looking upward must not dim ground mist');

const partial = [14, 18, 24].map((degrees) => edgeMistViewWeight(forwardY(degrees)));
assert.ok(partial[0] > partial[1] && partial[1] > partial[2]
    && partial.every((weight) => weight > EDGE_MIST_AERIAL_FLOOR && weight < 1),
  `edge mist must fade continuously through the transition band (${partial.join(', ')})`);

let previous = 1;
for (let degrees = 10; degrees <= 30; degrees += 0.25) {
  const weight = edgeMistViewWeight(forwardY(degrees));
  assert.ok(weight >= EDGE_MIST_AERIAL_FLOOR && weight <= previous,
    `edge mist fade is not bounded and monotonic at ${degrees}°`);
  previous = weight;
}

assert.equal(edgeMistViewWeight(NaN), 0,
  'invalid camera state must fail closed instead of covering the scene');
assert.equal(edgeMistViewWeight(Infinity), 0,
  'non-finite camera state must fail closed instead of covering the scene');

// 능선 물안개(직립 뱅크)는 아이레벨이 주역·부감이 보조다. 링보다 더 깊은 바닥값을 가져야
// 부감에서 산 사면에 회색 얼룩으로 남지 않는다. 두 가중치는 같은 전이 밴드를 공유한다.
assert.ok(RIDGE_MIST_AERIAL_FLOOR > 0 && RIDGE_MIST_AERIAL_FLOOR < EDGE_MIST_AERIAL_FLOOR,
  'ridge mist must fall further than the horizontal ring in an aerial view, but never to zero');
assert.equal(ridgeMistViewWeight(0), 1,
  'a horizon-level view must retain the authored ridge mist');
assert.equal(ridgeMistViewWeight(forwardY(10)), 1,
  'the ridge fade must start continuously at its lower boundary');
assert.equal(ridgeMistViewWeight(forwardY(30)), RIDGE_MIST_AERIAL_FLOOR,
  'an aerial view must settle on the authored ridge floor');
assert.equal(ridgeMistViewWeight(forwardY(89)), RIDGE_MIST_AERIAL_FLOOR,
  'a top-down view must not dip below the ridge floor');
assert.equal(ridgeMistViewWeight(NaN), 0,
  'invalid camera state must fail closed for ridge mist too');

let ridgePrev = 1;
for (let degrees = 10; degrees <= 30; degrees += 0.25) {
  const weight = ridgeMistViewWeight(forwardY(degrees));
  assert.ok(weight >= RIDGE_MIST_AERIAL_FLOOR && weight <= ridgePrev,
    `ridge mist fade is not bounded and monotonic at ${degrees}°`);
  ridgePrev = weight;
}

console.log('EDGE MIST VIEW: PASS');
