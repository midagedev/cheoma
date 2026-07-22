// straight-skeleton 지붕 face의 상단 경계가 모든 ridge junction을 통과하는지 검사한다.
// 순수 sampler 계약과 app의 단일 three로 만든 실제 production Float32 geometry를 함께 잠근다.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from '../app/node_modules/vite/dist/node/index.js';
import { resampleChainPreservingKnots } from '../src/layout/chain-sampling.js';
import { hanokFootprint } from '../src/layout/hanok-footprint.js';
import { computeSkeleton } from '../src/layout/skeleton.js';
import { PRESETS, giwaFootprintPolygon } from '../src/params.js';

const ROOT = resolve(import.meta.dirname, '..');
const ROOF_U_SEGMENTS = 14;
const EPS = 1e-9;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

const subtract = (a, b) => ({ x: a.x - b.x, z: a.z - b.z });
const dot = (a, b) => a.x * b.x + a.z * b.z;
const planDistance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const spatialDistance = (a, b, riseScale) => Math.hypot(
  a.x - b.x,
  (a.h - b.h) * riseScale,
  a.z - b.z,
);

function upperChains(footprint) {
  const skeleton = computeSkeleton(footprint);
  return skeleton.faces.flatMap((face) => {
    const edgeStart = skeleton.poly[face.edgeIndex];
    const edgeEnd = skeleton.poly[(face.edgeIndex + 1) % skeleton.poly.length];
    const edge = subtract(edgeEnd, edgeStart);
    const edgeLength = Math.hypot(edge.x, edge.z) || 1;
    const direction = { x: edge.x / edgeLength, z: edge.z / edgeLength };
    const upper = face.polygon
      .filter((point) => point.h > 1e-4)
      .map((point) => ({ ...point, t: dot(subtract(point, edgeStart), direction) }))
      .sort((a, b) => a.t - b.t);
    if (upper.length === 0) return [];
    return [upper.length === 1 ? [upper[0], upper[0]] : upper];
  });
}

// 수정 전의 균등 호길이 sampler. fixture가 실제 결함을 재현하는지 확인할 때만 쓴다.
function legacyResample(chain, segmentCount) {
  const lengths = [];
  let total = 0;
  for (let i = 0; i + 1 < chain.length; i++) {
    const length = planDistance(chain[i], chain[i + 1]);
    lengths.push(length);
    total += length;
  }
  if (total < 1e-6) {
    return Array.from({ length: segmentCount + 1 }, () => ({ ...chain[0] }));
  }
  const out = [];
  for (let i = 0; i <= segmentCount; i++) {
    let distance = (i / segmentCount) * total;
    let segment = 0;
    while (segment < lengths.length && distance > lengths[segment]) {
      distance -= lengths[segment];
      segment++;
    }
    if (segment >= lengths.length) {
      out.push({ ...chain.at(-1) });
      continue;
    }
    const t = lengths[segment] > EPS ? distance / lengths[segment] : 0;
    const a = chain[segment];
    const b = chain[segment + 1];
    out.push({
      x: a.x + (b.x - a.x) * t,
      z: a.z + (b.z - a.z) * t,
      h: a.h + (b.h - a.h) * t,
    });
  }
  return out;
}

function segmentProjection(point, a, b, riseScale) {
  const abx = b.x - a.x;
  const aby = (b.h - a.h) * riseScale;
  const abz = b.z - a.z;
  const length2 = abx * abx + aby * aby + abz * abz;
  const t = length2 > EPS ? Math.max(0, Math.min(1, (
    (point.x - a.x) * abx
    + (point.h - a.h) * riseScale * aby
    + (point.z - a.z) * abz
  ) / length2)) : 0;
  return {
    distance: Math.hypot(
      point.x - (a.x + abx * t),
      (point.h - (a.h + (b.h - a.h) * t)) * riseScale,
      point.z - (a.z + abz * t),
    ),
    t,
  };
}

function closestChainLocation(point, chain, riseScale) {
  if (chain.length === 1) {
    return { distance: spatialDistance(point, chain[0], riseScale), progress: 0 };
  }
  let best = { distance: Infinity, progress: 0 };
  for (let i = 0; i + 1 < chain.length; i++) {
    const projection = segmentProjection(point, chain[i], chain[i + 1], riseScale);
    if (projection.distance < best.distance - EPS) {
      best = { distance: projection.distance, progress: i + projection.t };
    }
  }
  return best;
}

// 원래 knot가 리샘플 결과 polyline에서 얼마나 벗어났는지: 이 값이 화면의 seam 폭이다.
function knotDeviation(chain, samples, riseScale) {
  let worst = 0;
  for (const knot of chain) {
    let nearest = Infinity;
    for (let i = 0; i + 1 < samples.length; i++) {
      nearest = Math.min(nearest, segmentProjection(knot, samples[i], samples[i + 1], riseScale).distance);
    }
    worst = Math.max(worst, nearest);
  }
  return worst;
}

function knotVertexDeviation(chain, samples, riseScale) {
  let worst = 0;
  for (const knot of chain) {
    const nearest = Math.min(...samples.map((sample) => spatialDistance(knot, sample, riseScale)));
    worst = Math.max(worst, nearest);
  }
  return worst;
}

function samplePathDeviation(chain, samples, riseScale) {
  return Math.max(...samples.map((sample) => closestChainLocation(sample, chain, riseScale).distance));
}

function sampleOrderRegression(chain, samples, riseScale) {
  let previous = -Infinity;
  let worst = 0;
  for (const sample of samples) {
    const { progress } = closestChainLocation(sample, chain, riseScale);
    worst = Math.max(worst, previous - progress);
    previous = progress;
  }
  return worst;
}

let legacyDefault = 0;
let legacyGiwaWorst = 0;
let fixedKnotWorst = 0;
let fixedPathWorst = 0;
let fixedOrderWorst = 0;
let chainsChecked = 0;

function checkPureChain(chain, riseScale, label, legacyFixture = false, isDefault = false) {
  const fixed = resampleChainPreservingKnots(chain, ROOF_U_SEGMENTS);
  invariant(fixed.length === ROOF_U_SEGMENTS + 1, `${label}: vertex budget changed`);
  if (legacyFixture) {
    const legacyDrift = knotDeviation(chain, legacyResample(chain, ROOF_U_SEGMENTS), riseScale);
    legacyGiwaWorst = Math.max(legacyGiwaWorst, legacyDrift);
    if (isDefault) legacyDefault = Math.max(legacyDefault, legacyDrift);
  }
  fixedKnotWorst = Math.max(fixedKnotWorst, knotVertexDeviation(chain, fixed, riseScale));
  fixedPathWorst = Math.max(fixedPathWorst, samplePathDeviation(chain, fixed, riseScale));
  fixedOrderWorst = Math.max(fixedOrderWorst, sampleOrderRegression(chain, fixed, riseScale));
  chainsChecked++;
}

const giwaRanges = {
  mainHalfW: [2.8, PRESETS.giwa.mainHalfW, 5.2],
  mainHalfD: [1.8, PRESETS.giwa.mainHalfD, 2.8],
  wingLen: [2.8, PRESETS.giwa.wingLen, 4.6],
  wingW: [1.8, PRESETS.giwa.wingW, 3.0],
  riseScale: [0.6, PRESETS.giwa.riseScale, 1.2],
};
for (const mainHalfW of giwaRanges.mainHalfW) {
  for (const mainHalfD of giwaRanges.mainHalfD) {
    for (const wingLen of giwaRanges.wingLen) {
      for (const wingW of giwaRanges.wingW) {
        const P = { ...PRESETS.giwa, mainHalfW, mainHalfD, wingLen, wingW };
        const chains = upperChains(giwaFootprintPolygon(P));
        for (const riseScale of giwaRanges.riseScale) {
          const isDefault = mainHalfW === PRESETS.giwa.mainHalfW
            && mainHalfD === PRESETS.giwa.mainHalfD
            && wingLen === PRESETS.giwa.wingLen
            && wingW === PRESETS.giwa.wingW
            && riseScale === PRESETS.giwa.riseScale;
          for (const [face, chain] of chains.entries()) {
            checkPureChain(chain, riseScale, `giwa-${mainHalfW}/${mainHalfD}/${wingLen}/${wingW}-${face}`, true, isDefault);
          }
        }
      }
    }
  }
}

// Regular-house repertoire added by #8: exact ㅡ and minimum-four-bay ㄷ plans.
for (const P of [
  { ...PRESETS.giwa, planShape: 'single', bays: 3, mainHalfW: 3.7, mainHalfD: 2.0 },
  { ...PRESETS.giwa, planShape: 'u', bays: 4, mainHalfW: 5.0, mainHalfD: 2.2, wingLen: 3.4, wingW: 2.15 },
]) {
  for (const riseScale of giwaRanges.riseScale) {
    for (const [face, chain] of upperChains(giwaFootprintPolygon(P)).entries()) {
      checkPureChain(chain, riseScale, `regular-${P.planShape}-${P.bays}-${face}`);
    }
  }
}

// 같은 production 지붕 엔진을 쓰는 종가 ㅡ/ㄱ/ㄷ 평면도 함께 보호한다.
for (const shape of ['single', 'l', 'u']) {
  for (const bays of [2, 3, 4]) {
    const chains = upperChains(hanokFootprint(shape, bays));
    for (const riseScale of [0.9, 1.18, 1.8]) {
      for (const [face, chain] of chains.entries()) {
        checkPureChain(chain, riseScale, `hanok-${shape}-${bays}-${face}`);
      }
    }
  }
}

// helper의 분기 계약: 단일점, 영길이 구간, 전부 영길이, segment 부족.
const one = { x: 1, z: -2, h: 0.5 };
const single = resampleChainPreservingKnots([one], 4);
invariant(single.length === 5 && single.every((point) => spatialDistance(point, one, 1) === 0), 'single-point chain failed');
const degenerateChain = [
  { x: 0, z: 0, h: 0 }, { x: 0, z: 0, h: 0 }, { x: 2, z: 1, h: 0.7 },
];
const degenerate = resampleChainPreservingKnots(degenerateChain, 4);
invariant(knotVertexDeviation(degenerateChain, degenerate, 1) < EPS, 'zero-length segment lost a knot');
invariant(samplePathDeviation(degenerateChain, degenerate, 1) < EPS, 'zero-length segment left the chain');
const allSame = resampleChainPreservingKnots([one, { ...one }, { ...one }], 4);
invariant(allSame.every((point) => spatialDistance(point, one, 1) === 0), 'all-zero chain changed position');
let shortageRejected = false;
try {
  resampleChainPreservingKnots([
    { x: 0, z: 0, h: 0 }, { x: 1, z: 0, h: 0 },
    { x: 2, z: 0, h: 0 }, { x: 3, z: 0, h: 0 },
  ], 2);
} catch (error) {
  shortageRejected = error instanceof RangeError;
}
invariant(shortageRejected, 'insufficient segment budget was not rejected');

async function inspectProductionGeometry() {
  const cacheDir = await mkdtemp(join(tmpdir(), 'cheoma-roof-seams-'));
  const threeMain = join(ROOT, 'app/node_modules/three/build/three.module.js');
  const threeAddons = join(ROOT, 'app/node_modules/three/examples/jsm/');
  const vite = await createServer({
    appType: 'custom',
    cacheDir,
    configFile: false,
    root: ROOT,
    logLevel: 'error',
    resolve: {
      alias: [
        { find: /^three\/addons\//, replacement: threeAddons },
        { find: /^three$/, replacement: threeMain },
      ],
      dedupe: ['three'],
    },
    optimizeDeps: { noDiscovery: true },
    server: { middlewareMode: true, hmr: false },
    ssr: { noExternal: true },
  });
  try {
    const probe = await vite.ssrLoadModule('/tools/lib/roof-seam-production.mjs');
    return probe.inspectProductionRoofSeams();
  } finally {
    await vite.close();
    await rm(cacheDir, { recursive: true, force: true });
  }
}

const production = await inspectProductionGeometry();
invariant(production.cases.length === 245, `production matrix changed (${production.cases.length})`);
invariant(production.faces.length === 1470, `production face matrix changed (${production.faces.length})`);
invariant(production.uVertices === 15, `production U vertex budget changed (${production.uVertices})`);
invariant(production.faceVertexCount === 135, `production face vertex budget changed (${production.faceVertexCount})`);
invariant(production.faceIndexCount === 672, `production face index budget changed (${production.faceIndexCount})`);
for (const item of production.cases) {
  invariant(item.actualFaces === item.expectedFaces, `${item.label}: production face wiring ${item.actualFaces}/${item.expectedFaces}`);
}
let productionKnotWorst = 0;
let productionPathWorst = 0;
let productionOrderWorst = 0;
for (const face of production.faces) {
  invariant(face.samples.length === ROOF_U_SEGMENTS + 1, `${face.label}: production boundary budget changed`);
  productionKnotWorst = Math.max(productionKnotWorst, knotVertexDeviation(face.chain, face.samples, 1));
  productionPathWorst = Math.max(productionPathWorst, samplePathDeviation(face.chain, face.samples, 1));
  productionOrderWorst = Math.max(productionOrderWorst, sampleOrderRegression(face.chain, face.samples, 1));
}

invariant(legacyDefault > 0.08, `fixture no longer reproduces default seam (${legacyDefault}m)`);
invariant(legacyGiwaWorst > 0.13, `giwa boundary sweep no longer reproduces seam (${legacyGiwaWorst}m)`);
invariant(fixedKnotWorst < 1e-8, `pure ridge knot drift remains ${fixedKnotWorst}m`);
invariant(fixedPathWorst < 1e-8, `pure samples leave their source chain by ${fixedPathWorst}m`);
invariant(fixedOrderWorst < 1e-8, `pure samples reverse by ${fixedOrderWorst}`);
invariant(productionKnotWorst < 1e-5, `production Float32 ridge knot drift remains ${productionKnotWorst}m`);
invariant(productionPathWorst < 1e-5, `production Float32 samples leave their chain by ${productionPathWorst}m`);
invariant(productionOrderWorst < 1e-5, `production Float32 samples reverse by ${productionOrderWorst}`);

console.log(`default giwa legacy junction drift=${legacyDefault.toFixed(6)}m`);
console.log(`boundary giwa legacy junction drift=${legacyGiwaWorst.toFixed(6)}m`);
console.log(`pure knot/path/order=${fixedKnotWorst.toExponential(2)}/${fixedPathWorst.toExponential(2)}/${fixedOrderWorst.toExponential(2)}`);
console.log(`production Float32 knot/path/order=${productionKnotWorst.toExponential(2)}/${productionPathWorst.toExponential(2)}/${productionOrderWorst.toExponential(2)}`);
console.log(`ROOF SEAMS: PASS (${production.cases.length} UI cases, ${production.faces.length} production faces, ${chainsChecked} pure face/rise cases)`);
