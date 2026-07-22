// Fast Three/DOM-free contract for texel-stable directional-shadow anchors.
import {
  DEFAULT_DIRECTIONAL_SHADOW_MAP_SIZE,
  DEFAULT_DIRECTIONAL_SHADOW_SPAN,
  snapDirectionalShadowAnchor,
} from '../src/api/shadow-framing.js';

const EPSILON = 1e-9;
const invariant = (condition, message) => {
  if (!condition) throw new Error(message);
};
const near = (actual, expected, message, epsilon = EPSILON) => {
  invariant(Math.abs(actual - expected) <= epsilon, `${message} (${actual} != ${expected})`);
};
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const length = (value) => Math.hypot(value.x, value.y, value.z);
const subtract = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const combine = (basis, right, up, along) => ({
  x: basis.right.x * right + basis.up.x * up + basis.direction.x * along,
  y: basis.right.y * right + basis.up.y * up + basis.direction.y * along,
  z: basis.right.z * right + basis.up.z * up + basis.direction.z * along,
});

const requested = { x: 12.35, y: -4.8, z: 91.2 };
const arbitraryDirection = { x: 30, y: 42, z: 26 };
const framed = snapDirectionalShadowAnchor(requested, arbitraryDirection, 44, 4096);
const { direction, basis } = framed;

invariant([
  ...Object.values(framed.anchor),
  ...Object.values(direction),
  ...Object.values(basis.right),
  ...Object.values(basis.up),
  framed.texel.size,
].every(Number.isFinite), 'framed anchor or basis contained a non-finite number');
near(length(direction), 1, 'arbitrary light direction was not normalized');
near(length(basis.right), 1, 'shadow right basis was not unit length');
near(length(basis.up), 1, 'shadow up basis was not unit length');
near(dot(direction, basis.right), 0, 'shadow right basis was not perpendicular to light');
near(dot(direction, basis.up), 0, 'shadow up basis was not perpendicular to light');
near(dot(basis.right, basis.up), 0, 'shadow right/up basis was not orthogonal');
near(dot(framed.anchor, direction), dot(requested, direction),
  'texel snapping changed the anchor component along the light direction');
near(dot(subtract(framed.anchor, requested), direction), 0,
  'texel snapping translated the anchor along the light direction');

const frameBasis = { ...basis, direction };
const texel = framed.texel.size;
const sameCellA = combine(frameBasis, texel * 2.08, texel * -3.12, 17);
const sameCellB = combine(frameBasis, texel * 2.34, texel * -3.42, 17);
const sameA = snapDirectionalShadowAnchor(sameCellA, arbitraryDirection, 44, 4096);
const sameB = snapDirectionalShadowAnchor(sameCellB, arbitraryDirection, 44, 4096);
invariant(JSON.stringify(sameA.anchor) === JSON.stringify(sameB.anchor),
  'anchors inside one right/up texel cell did not remain stable');

const adjacentA = combine(frameBasis, texel * 2.49, texel * -3, 17);
const adjacentB = combine(frameBasis, texel * 2.51, texel * -3, 17);
const edgeA = snapDirectionalShadowAnchor(adjacentA, arbitraryDirection, 44, 4096);
const edgeB = snapDirectionalShadowAnchor(adjacentB, arbitraryDirection, 44, 4096);
const edgeDelta = subtract(edgeB.anchor, edgeA.anchor);
near(length(edgeDelta), texel, 'crossing one texel boundary did not move by one texel');
near(dot(edgeDelta, basis.right), texel, 'adjacent-cell motion did not follow shadow right');
near(dot(edgeDelta, direction), 0, 'adjacent-cell motion leaked along the light direction');

const vertical = snapDirectionalShadowAnchor(
  { x: 1.23, y: 9.87, z: -4.56 },
  { x: 1e-15, y: 50, z: -1e-15 },
  44,
  4096,
);
invariant(JSON.stringify(vertical.direction) === '{"x":0,"y":1,"z":0}',
  'near-vertical direction did not resolve to a stable normalized direction');
invariant(JSON.stringify(vertical.basis.right) === '{"x":1,"y":0,"z":0}'
    && JSON.stringify(vertical.basis.up) === '{"x":0,"y":0,"z":-1}',
  'near-vertical direction did not use the deterministic +X basis fallback');
near(vertical.anchor.y, 9.87, 'vertical fallback changed the along-light anchor component');

const invalid = snapDirectionalShadowAnchor(
  { x: NaN, y: Infinity, z: -Infinity },
  { x: NaN, y: Infinity, z: 0 },
  NaN,
  0,
);
invariant(JSON.stringify(invalid.anchor) === '{"x":0,"y":0,"z":0}',
  'non-finite anchor did not fail closed to the finite origin');
invariant(JSON.stringify(invalid.direction) === '{"x":0,"y":1,"z":0}',
  'non-finite direction did not use the deterministic vertical fallback');
invariant(invalid.texel.span === DEFAULT_DIRECTIONAL_SHADOW_SPAN
    && invalid.texel.mapSize === DEFAULT_DIRECTIONAL_SHADOW_MAP_SIZE
    && invalid.texel.size === DEFAULT_DIRECTIONAL_SHADOW_SPAN / DEFAULT_DIRECTIONAL_SHADOW_MAP_SIZE,
  'invalid shadow resolution did not use stable finite defaults');

const repeatA = snapDirectionalShadowAnchor(requested, arbitraryDirection, 44, 4096);
const repeatB = snapDirectionalShadowAnchor(requested, arbitraryDirection, 44, 4096);
invariant(JSON.stringify(repeatA) === JSON.stringify(repeatB),
  'same directional-shadow input was not byte-identical');

console.log('SHADOW FRAMING: PASS');
