// 고샅 topology contract (pure node, no browser).
//
// docs/village-walls-parcels.md R-P2 + #150 item G:
//   measure wall-to-wall / boundary-to-boundary gaps between neighbour parcels;
//   assert bands related to the historical 1.0–3.4m 소로 alley without changing
//   placement (no worker golden churn).
//
// Measured product expectations (3 seeds × scales, 2026-07-26 probe):
//   alley-band median poly clearance ≈ 2.0–2.6m (inside historical 1–3.4)
//   ≥ ~70% of alley pairs fall inside historical 1.0–3.4m
//   product planning clamp remains 0.7–3.9m (gapWidth); classification uses
//   SHARE_DIST 1.15 / ALLEY_DIST 3.8 from parcels.js
//   dual solid wall-face medians stay positive (~1.4–2.2m)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { planVillage } from '../src/api/village-plan.js';
import {
  GOSAT_TOPOLOGY,
  analyzeGosatTopology,
  inspectEdgeShareFlags,
  parcelBoundaryClearance,
  classifyGosatGap,
  gapQuantiles,
} from '../src/village/gosat-topology.js';

const SCALES = ['hamlet', 'village', 'town', 'capital', 'hanyang'];
const SEEDS = [7, 42, 20260716];
// Dense scales must produce neighbour alleys; hamlet may be sparse.
const ALLEY_REQUIRED_SCALES = new Set(['village', 'town', 'capital', 'hanyang']);
const SHARE_REQUIRED_SCALES = new Set(['village', 'town', 'capital', 'hanyang']);
// Historical band coverage among alley-classified pairs (product soft max is 3.8).
const ALLEY_HISTORICAL_FLOOR = 0.70;
// Median of alley poly clearance must sit inside the historical 소로 band.
const ALLEY_MEDIAN_MIN = GOSAT_TOPOLOGY.historicalMin;
const ALLEY_MEDIAN_MAX = GOSAT_TOPOLOGY.historicalMax;
// Dual solid wall-face median must remain a positive passage when both bodies exist.
const DUAL_FACE_MEDIAN_FLOOR = 0.4;

const errors = [];
function invariant(condition, message) {
  if (!condition) errors.push(message);
}

const sourcePath = fileURLToPath(new URL('../src/village/gosat-topology.js', import.meta.url));
const source = readFileSync(sourcePath, 'utf8');
invariant(!/from\s+['"]three['"]|\bTHREE\b|\bdocument\b|\bwindow\b/.test(source),
  'gosat-topology imported a renderer or DOM dependency');

const parcelsSource = readFileSync(fileURLToPath(
  new URL('../src/village/parcels.js', import.meta.url),
), 'utf8');
invariant(
  new RegExp(`SHARE_DIST\\s*=\\s*${GOSAT_TOPOLOGY.shareDist}\\b`).test(parcelsSource),
  `parcels.js SHARE_DIST drifted from GOSAT_TOPOLOGY.shareDist=${GOSAT_TOPOLOGY.shareDist}`,
);
invariant(
  new RegExp(`ALLEY_DIST\\s*=\\s*${GOSAT_TOPOLOGY.alleyDist}\\b`).test(parcelsSource),
  `parcels.js ALLEY_DIST drifted from GOSAT_TOPOLOGY.alleyDist=${GOSAT_TOPOLOGY.alleyDist}`,
);
invariant(
  /Math\.max\(\s*0\.7\s*,\s*Math\.min\(\s*3\.9\s*,/.test(parcelsSource)
  || /Math\.max\(0\.7, Math\.min\(3\.9,/.test(parcelsSource),
  'parcels.js gapWidth product clamp 0.7–3.9 drifted',
);

// Unit-level pure classification (no plan).
invariant(classifyGosatGap(0.5) === 'share', '0.5m must classify as share');
invariant(classifyGosatGap(1.15) === 'alley', 'shareDist boundary is alley');
invariant(classifyGosatGap(2.2) === 'alley', '2.2m must classify as alley');
invariant(classifyGosatGap(3.8) === 'open', 'alleyDist boundary is open');
invariant(classifyGosatGap(5) === 'open', '5m must classify as open');
const q = gapQuantiles([1, 2, 3, 4]);
invariant(q && Math.abs(q.median - 2.5) < 1e-12 && q.n === 4, 'gapQuantiles median');

function buildWithoutGlobalRandom(options) {
  const original = Math.random;
  Math.random = () => { throw new Error('gosat topology consumed global Math.random'); };
  try { return planVillage(options); }
  finally { Math.random = original; }
}

const scaleReports = new Map();
let totalPairs = 0;

for (const scale of SCALES) {
  const alleyGaps = [];
  const shareGaps = [];
  const dualFace = [];
  let shareFlags = 0;
  let shareIssues = 0;
  let plans = 0;

  for (const seed of SEEDS) {
    const plan = buildWithoutGlobalRandom({ scale, seed });
    plans += 1;
    const parcels = plan.parcels || [];

    // Analysis must not mutate the plan.
    const before = JSON.stringify(parcels.map((p) => ({
      id: p.id,
      poly: p.poly,
      edges: p.shape?.edges,
      wallType: p.wallType,
    })));
    const originalRandom = Math.random;
    Math.random = () => { throw new Error('analyzeGosatTopology consumed global Math.random'); };
    let report;
    let shareReport;
    try {
      report = analyzeGosatTopology(parcels);
      shareReport = inspectEdgeShareFlags(parcels);
    } finally {
      Math.random = originalRandom;
    }
    const after = JSON.stringify(parcels.map((p) => ({
      id: p.id,
      poly: p.poly,
      edges: p.shape?.edges,
      wallType: p.wallType,
    })));
    invariant(before === after, `${scale}/${seed}: analysis mutated parcel geometry`);

    // Determinism of the pure analyser.
    const again = analyzeGosatTopology(parcels);
    invariant(
      JSON.stringify(report.pairs) === JSON.stringify(again.pairs),
      `${scale}/${seed}: analyzeGosatTopology is not deterministic`,
    );

    shareFlags += shareReport.shareFlags;
    shareIssues += shareReport.issues.length;
    for (const issue of shareReport.issues) {
      errors.push(`${scale}/${seed}: share flag issue ${issue.type} parcel=${issue.parcelId} edge=${issue.edgeIndex}`);
    }

    for (const pair of report.pairs) {
      totalPairs += 1;
      invariant(pair.clearance + 1e-12 >= 0, `${scale}/${seed}: negative clearance`);
      // Parcels must not overlap interiors (clearance 0 with penetration).
      // Touching at a point/edge is allowed (clearance ≈ 0 in share band).
      if (pair.kind === 'share') shareGaps.push(pair.clearance);
      if (pair.kind === 'alley') {
        alleyGaps.push(pair.clearance);
        invariant(
          pair.clearance + 1e-12 >= GOSAT_TOPOLOGY.shareDist
          && pair.clearance < GOSAT_TOPOLOGY.alleyDist,
          `${scale}/${seed}: alley pair clearance ${pair.clearance} outside band`,
        );
        if (pair.dualSolid && Number.isFinite(pair.wallFaceClearance)) {
          dualFace.push(pair.wallFaceClearance);
        }
      }
      // Recompute one pair independently to guard the helper.
      const a = parcels[pair.aIndex];
      const b = parcels[pair.bIndex];
      if (a?.poly && b?.poly) {
        const d = parcelBoundaryClearance(a.poly, b.poly);
        invariant(Math.abs(d - pair.clearance) <= 1e-9,
          `${scale}/${seed}: pair clearance drift ${d} vs ${pair.clearance}`);
      }
    }
  }

  const alley = gapQuantiles(alleyGaps);
  const share = gapQuantiles(shareGaps);
  const face = gapQuantiles(dualFace);
  const histFrac = alleyGaps.length
    ? alleyGaps.filter((g) => (
      g + 1e-9 >= GOSAT_TOPOLOGY.historicalMin
      && g - 1e-9 <= GOSAT_TOPOLOGY.historicalMax
    )).length / alleyGaps.length
    : null;

  scaleReports.set(scale, {
    plans,
    alley,
    share,
    face,
    histFrac,
    shareFlags,
    shareIssues,
  });

  if (ALLEY_REQUIRED_SCALES.has(scale)) {
    invariant(alley && alley.n > 0, `${scale}: expected neighbour alley pairs`);
    invariant(
      alley.median + 1e-9 >= ALLEY_MEDIAN_MIN
      && alley.median - 1e-9 <= ALLEY_MEDIAN_MAX,
      `${scale}: alley median ${alley?.median?.toFixed?.(3)}m outside historical ${ALLEY_MEDIAN_MIN}–${ALLEY_MEDIAN_MAX}m`,
    );
    invariant(
      histFrac != null && histFrac + 1e-12 >= ALLEY_HISTORICAL_FLOOR,
      `${scale}: only ${(histFrac * 100).toFixed(1)}% of alley gaps fall in historical 1.0–3.4m (floor ${(ALLEY_HISTORICAL_FLOOR * 100).toFixed(0)}%)`,
    );
  }

  if (SHARE_REQUIRED_SCALES.has(scale)) {
    invariant(
      (share && share.n > 0) || shareFlags > 0,
      `${scale}: expected at least one close-boundary share relation`,
    );
  }

  if (face && face.n >= 3) {
    invariant(
      face.median + 1e-9 >= DUAL_FACE_MEDIAN_FLOOR,
      `${scale}: dual solid wall-face median ${face.median.toFixed(3)}m < ${DUAL_FACE_MEDIAN_FLOOR}m`,
    );
  }

  invariant(shareIssues === 0, `${scale}: ${shareIssues} share-flag consistency issues`);
}

if (errors.length) {
  console.error('GOSAT TOPOLOGY CONTRACT: FAIL');
  for (const message of errors.slice(0, 50)) console.error(' -', message);
  if (errors.length > 50) console.error(` … +${errors.length - 50} more`);
  process.exit(1);
}

const fmt = (q) => (q ? `${q.median.toFixed(2)}m n=${q.n}` : '—');
const lines = SCALES.map((scale) => {
  const r = scaleReports.get(scale);
  return `${scale}: alleyMed ${fmt(r.alley)} hist=${r.histFrac == null ? '—' : `${(r.histFrac * 100).toFixed(0)}%`} share n=${r.share?.n ?? 0} faceMed ${fmt(r.face)}`;
});
console.log(
  'GOSAT TOPOLOGY CONTRACT: PASS',
  `(${totalPairs} neighbour pairs × ${SEEDS.length} seeds;`,
  `historical band ${GOSAT_TOPOLOGY.historicalMin}–${GOSAT_TOPOLOGY.historicalMax}m;`,
  `product clamp ${GOSAT_TOPOLOGY.productClampMin}–${GOSAT_TOPOLOGY.productClampMax}m)`,
);
for (const line of lines) console.log(' ', line);
