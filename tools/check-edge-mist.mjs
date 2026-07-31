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

// 부감은 링을 완전히 끄지 않는다(R5/U1 #211). 지형 절단면·외곽 수관을 대기로 녹이는 장치라
// 0 이면 마을이 하늘에 하드컷으로 붙는다. 웨지가 두드러지지 않는 바닥 가중치까지만 내린다.
assert.ok(EDGE_MIST_AERIAL_FLOOR > 0 && EDGE_MIST_AERIAL_FLOOR < 1,
  'the aerial floor must be a bounded partial weight');
// #31 재저작. 이전 단언은 `>= 0.8` 이었고 그 근거는 "scene fog 가 절단면까지 못 미친다"였다 —
//   fog 부재 보상값을 게이트가 고정하고 있었던 것이다. #31 에서 fog 미발화가 버그로 확정되고
//   복구되었으므로, 이제 계약은 "높게 유지"가 아니라 **이중 계상 금지 + 하드컷 금지의 양측 상한**
//   이다. 부감에서 링은 보조 레이어이므로 절반 이하로 내려가야 하고(상한), 하드컷 원반을 막는
//   최소 존재감은 남아야 한다(하한). fog 가 깊이 성분을 갖는다는 전제가 이 대역의 근거다.
assert.ok(EDGE_MIST_AERIAL_FLOOR <= 0.6,
  'aerial edge-mist must drop to a secondary layer now that scene fog supplies the depth term');
assert.ok(EDGE_MIST_AERIAL_FLOOR >= 0.25,
  'aerial edge-mist must still keep enough presence to prevent a hard-cut diorama disc');
assert.equal(edgeMistViewWeight(forwardY(30)), EDGE_MIST_AERIAL_FLOOR,
  'an aerial view must settle on the authored atmospheric floor');
assert.equal(edgeMistViewWeight(forwardY(60)), EDGE_MIST_AERIAL_FLOOR,
  'steeper aerial views must not dip below the floor');
assert.equal(edgeMistViewWeight(forwardY(89)), EDGE_MIST_AERIAL_FLOOR,
  'a top-down view must still keep the terrain edge dissolving');
assert.equal(edgeMistViewWeight(0.5), 1,
  'looking upward must not dim ground mist');

// Product aerial framing: capital aerial look-down ≈ 25–30°, village context elev ≈ 31°.
// Fade ends at 30°, so 25° is still in the tail of the band — require a residual above the
// floor, not the exact floor. At ≥30° the floor is exact so the basin rim never fully
// vanishes mid-orbit.
// #31 재저작: 구 단언의 `> 0.85` 는 0.9375 바닥에서만 성립하는 수치였다(=보상값 고정). 계약의
//   실체는 절대 수치가 아니라 "25° 는 전이 대역의 꼬리이므로 아직 바닥보다 위에 있어야 한다"는
//   연속성이다. 바닥값과 무관한 형태로 다시 쓴다.
const capitalAerialEdge = edgeMistViewWeight(forwardY(25));
assert.ok(capitalAerialEdge > EDGE_MIST_AERIAL_FLOOR && capitalAerialEdge < 1,
  `product capital aerial pitch must sit in the fade tail, above the floor (${capitalAerialEdge})`);
assert.equal(edgeMistViewWeight(forwardY(31)), EDGE_MIST_AERIAL_FLOOR,
  'product village context elevation must keep the edge-mist floor');

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
// #211: 부감에서도 0 이 되면 능선 겹침 소실이 사라져 하드컷 원반이 다시 선다.
assert.ok(RIDGE_MIST_AERIAL_FLOOR > 0 && RIDGE_MIST_AERIAL_FLOOR < EDGE_MIST_AERIAL_FLOOR,
  'ridge mist must fall further than the horizontal ring in an aerial view, but never to zero');
// #31 재저작: 구 단언 `>= 0.5` 도 fog 부재 보상값을 고정한 것이었다. 배산 사면의 대기 원근을 이제
//   fog 가 실제로 공급하므로(아이레벨 배경 사면 ≈0.30 fogFactor) 뱅크는 보조 레이어로 내려가야
//   한다. 계약은 링 바닥의 절반 이상(레이어링이 사라지지 않음) ~ 링 바닥 미만(주역 역전 금지).
assert.ok(RIDGE_MIST_AERIAL_FLOOR >= EDGE_MIST_AERIAL_FLOOR * 0.5,
  'ridge aerial floor must keep a secondary atmospheric layer for basin-edge layering');
assert.equal(ridgeMistViewWeight(0), 1,
  'a horizon-level view must retain the authored ridge mist');
assert.equal(ridgeMistViewWeight(forwardY(10)), 1,
  'the ridge fade must start continuously at its lower boundary');
assert.equal(ridgeMistViewWeight(forwardY(30)), RIDGE_MIST_AERIAL_FLOOR,
  'an aerial view must settle on the authored ridge floor');
assert.equal(ridgeMistViewWeight(forwardY(31)), RIDGE_MIST_AERIAL_FLOOR,
  'product village context elevation must keep the ridge-mist floor');
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

// At every pitch in the product aerial band the ring stays the stronger softener.
for (const degrees of [25, 30, 31, 45, 60]) {
  assert.ok(
    edgeMistViewWeight(forwardY(degrees)) > ridgeMistViewWeight(forwardY(degrees)),
    `edge ring must outrank ridge banks at ${degrees}° aerial`,
  );
}

console.log('EDGE MIST VIEW: PASS');
