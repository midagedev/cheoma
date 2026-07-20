// 초가 지붕/벽 프로파일의 브라우저 없는 수치 게이트.
// 지붕 그리드의 실제 삼각형 높이와 네 벽 리본의 상단을 비교해 황토벽 돌출과 큰 틈을 막는다.
import { createHash } from 'node:crypto';
import { PRESETS, computeLayout } from '../src/params.js';
import {
  createThatchRoofProfile,
  THATCH_ROOF_SEGMENTS,
  thatchRoofSurfaceHeightAt,
  thatchWallBreakpoints,
  thatchWallTopAt,
} from '../src/builder/thatch-profile.js';
import { CHOGA_VARIANTS } from '../src/village/variants.js';
import { makeRng } from '../src/rng.js';

const NA = THATCH_ROOF_SEGMENTS.a;
const NB = THATCH_ROOF_SEGMENTS.b;
const EPS = 1e-9;
const WALL_DENSE_STEPS = 32;
const PRESET_ROOF_HASH = '442a4c11ab5fba1d';

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function makeSurface(profile) {
  const vertices = [];
  for (let ib = 0; ib <= NB; ib++) {
    for (let ia = 0; ia <= NA; ia++) {
      const a = (ia / NA) * 2 - 1;
      const b = (ib / NB) * 2 - 1;
      const [x, z] = profile.planXZ(a, b);
      vertices.push({
        x: Math.fround(x),
        y: Math.fround(profile.heightAB(a, b)),
        z: Math.fround(z),
      });
    }
  }
  return vertices;
}

function triangleY(point, a, b, c) {
  const det = (b.z - c.z) * (a.x - c.x) + (c.x - b.x) * (a.z - c.z);
  if (Math.abs(det) < EPS) return null;
  const wa = ((b.z - c.z) * (point.x - c.x) + (c.x - b.x) * (point.z - c.z)) / det;
  const wb = ((c.z - a.z) * (point.x - c.x) + (a.x - c.x) * (point.z - c.z)) / det;
  const wc = 1 - wa - wb;
  if (wa < -EPS || wb < -EPS || wc < -EPS) return null;
  return wa * a.y + wb * b.y + wc * c.y;
}

function surfaceY(vertices, x, z) {
  const point = { x, z };
  for (let ib = 0; ib < NB; ib++) {
    for (let ia = 0; ia < NA; ia++) {
      const q = ib * (NA + 1) + ia;
      const w = q + 1;
      const e = q + (NA + 1);
      const r = e + 1;
      const first = triangleY(point, vertices[q], vertices[e], vertices[w]);
      if (first != null) return first;
      const second = triangleY(point, vertices[w], vertices[e], vertices[r]);
      if (second != null) return second;
    }
  }
  throw new Error(`roof surface does not cover wall point (${x}, ${z})`);
}

function wallLines(P, L) {
  const cr = P.columnRadius + 0.03;
  const xL = L.xPos[0];
  const xR = L.xPos.at(-1);
  const zB = L.zPos[0];
  const zF = L.zPos.at(-1);
  return [
    ['front', 'x', zF, xL - cr, xR + cr],
    ['back', 'x', zB, xL - cr, xR + cr],
    ['left', 'z', xL, zB - cr, zF + cr],
    ['right', 'z', xR, zB - cr, zF + cr],
  ];
}

const cases = [
  ['preset', {}],
  ...CHOGA_VARIANTS.map((variant) => [variant.name, variant.ov]),
  ['editor-min', {
    frontBays: 3, sideBays: 2, roofPitch: 0.5, eaveOverhang: 0.8,
    centerBayW: 2.2, endBayW: 2.0, columnHeight: 1.8, podiumTierH: 0.16,
  }],
  ['editor-max', {
    frontBays: 5, sideBays: 3, roofPitch: 0.78, eaveOverhang: 1.8,
    centerBayW: 3.8, endBayW: 3.0, columnHeight: 2.7, podiumTierH: 0.5,
  }],
  ['wide-shallow', {
    frontBays: 5, sideBays: 3, eaveOverhang: 0.8,
    centerBayW: 3.8, endBayW: 3.0,
  }],
  ['standalone-max', {
    frontBays: 9, sideBays: 5, eaveOverhang: 1.0,
  }],
  ['mixed-regress', {
    frontBays: 5, sideBays: 3, roofPitch: 0.7407618018, eaveOverhang: 1.4580324213,
    centerBayW: 3.2432932124, endBayW: 2.5075016271,
  }],
];

let presetHash = '';
function checkCase(name, overrides, verifySampler = false) {
  const P = { ...PRESETS.choga, ...overrides };
  const L = computeLayout(P);
  const profile = createThatchRoofProfile(P, L);
  const vertices = makeSurface(profile);

  let roundTripError = 0;
  for (let ib = 0; ib <= NB; ib += 4) {
    for (let ia = 0; ia <= NA; ia += 4) {
      const a = (ia / NA) * 2 - 1;
      const b = (ib / NB) * 2 - 1;
      const [x, z] = profile.planXZ(a, b);
      roundTripError = Math.max(roundTripError, Math.abs(profile.heightAt(x, z) - profile.heightAB(a, b)));
    }
  }
  invariant(roundTripError < 1e-9, `${name}: profile inverse error ${roundTripError}`);

  let minClearance = Infinity;
  let maxClearance = -Infinity;
  let minPoint = null;
  let maxPoint = null;
  let samples = 0;
  for (const [, axis, fixed, start, end] of wallLines(P, L)) {
    const points = thatchWallBreakpoints(profile, axis, fixed, start, end);
    const wallFixed = Math.fround(fixed);
    const tops = points.map((along) => {
      const x = axis === 'x' ? along : wallFixed;
      const z = axis === 'x' ? wallFixed : along;
      const sampledY = thatchRoofSurfaceHeightAt(profile, x, z);
      if (verifySampler) {
        const meshY = surfaceY(vertices, x, z);
        invariant(Math.abs(sampledY - meshY) < 1e-6, `${name}: mesh sampler drift at (${x}, ${z})`);
      }
      return Math.fround(thatchWallTopAt(profile, x, z));
    });
    // 실제 벽 삼각형의 직선 상단을 각 segment 안에서 다시 보간해, 정점 사이 돌출도 검사한다.
    for (let i = 0; i < points.length - 1; i++) {
      for (let step = 0; step <= WALL_DENSE_STEPS; step++) {
        const u = step / WALL_DENSE_STEPS;
        const along = points[i] + (points[i + 1] - points[i]) * u;
        const x = axis === 'x' ? along : wallFixed;
        const z = axis === 'x' ? wallFixed : along;
        const wallY = tops[i] + (tops[i + 1] - tops[i]) * u;
        const clearance = wallY - thatchRoofSurfaceHeightAt(profile, x, z);
        if (clearance < minClearance) { minClearance = clearance; minPoint = { x, z }; }
        if (clearance > maxClearance) { maxClearance = clearance; maxPoint = { x, z }; }
        samples++;
      }
    }
  }

  // 양수면 벽 돌출. 2mm는 부동소수·삼각 보간 여유, -10cm는 눈에 보이는 틈 방지 한계다.
  invariant(maxClearance <= 0.002, `${name}: wall protrudes ${maxClearance.toFixed(6)}m at ${JSON.stringify(maxPoint)}`);
  invariant(minClearance >= -0.10, `${name}: wall gap ${minClearance.toFixed(6)}m at ${JSON.stringify(minPoint)}`);

  if (name === 'preset') {
    invariant(profile.planExponent === 4.2, `preset plan exponent changed: ${profile.planExponent}`);
    const positions = new Float32Array(vertices.flatMap(({ x, y, z }) => [x, y, z]));
    presetHash = createHash('sha256').update(Buffer.from(positions.buffer)).digest('hex').slice(0, 16);
  }
  if (name === 'wide-shallow') {
    invariant(
      profile.planExponent > 4.2 && profile.planExponent < 5.4,
      `${name}: unexpected plan exponent ${profile.planExponent}`,
    );
  }
  if (name === 'standalone-max') {
    invariant(
      profile.planExponent > 4.2 && profile.planExponent < 6.7,
      `${name}: unexpected plan exponent ${profile.planExponent}`,
    );
  }
  return { name, samples, minClearance, maxClearance, roundTripError };
}

function printResult(result) {
  console.log(
    `${result.name.padEnd(13)} samples=${String(result.samples).padStart(5)} `
    + `clearance=${result.minClearance.toFixed(4)}..${result.maxClearance.toFixed(4)}m `
    + `inverse=${result.roundTripError.toExponential(1)}`,
  );
}

for (const [name, overrides] of cases) printResult(checkCase(name, overrides, true));

let boundarySamples = 0;
for (const frontBays of [3, 5]) {
  for (const sideBays of [2, 3]) {
    for (const eaveOverhang of [0.8, 1.8]) {
      for (const centerBayW of [2.2, 3.8]) {
        for (const endBayW of [2.0, 3.0]) {
          const result = checkCase('boundary', {
            frontBays, sideBays, eaveOverhang, centerBayW, endBayW,
          }, true);
          boundarySamples += result.samples;
        }
      }
    }
  }
}
console.log(`boundary-32  samples=${boundarySamples}`);

const fuzzRng = makeRng(0x1c40a);
let fuzzMin = Infinity;
let fuzzMax = -Infinity;
let fuzzSamples = 0;
const FUZZ_CASES = 96;
for (let i = 0; i < FUZZ_CASES; i++) {
  const between = (min, max) => min + (max - min) * fuzzRng();
  const result = checkCase(`fuzz-${i}`, {
    frontBays: 3 + Math.floor(fuzzRng() * 3),
    sideBays: 2 + Math.floor(fuzzRng() * 2),
    roofPitch: between(0.5, 0.78),
    eaveOverhang: between(0.8, 1.8),
    profileCurve: between(0, 0.6),
    centerBayW: between(2.2, 3.8),
    endBayW: between(2.0, 3.0),
    columnHeight: between(1.8, 2.7),
    podiumTierH: between(0.16, 0.5),
  });
  fuzzMin = Math.min(fuzzMin, result.minClearance);
  fuzzMax = Math.max(fuzzMax, result.maxClearance);
  fuzzSamples += result.samples;
}
console.log(
  `fuzz-${FUZZ_CASES}`.padEnd(13)
  + ` samples=${String(fuzzSamples).padStart(5)} clearance=${fuzzMin.toFixed(4)}..${fuzzMax.toFixed(4)}m`,
);

invariant(presetHash === PRESET_ROOF_HASH, `preset roof changed: ${presetHash} != ${PRESET_ROOF_HASH}`);
console.log(`preset roof positions sha256=${presetHash}`);
console.log('CHOGA ROOF: PASS');
