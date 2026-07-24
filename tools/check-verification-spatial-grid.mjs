import {
  boundsOverlap,
  createVerificationSpatialGrid,
} from './lib/verification-spatial-grid.mjs';

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function expectThrow(action, ErrorType, message) {
  let caught = null;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  invariant(caught instanceof ErrorType, message);
}

function snapshot(value) {
  return JSON.stringify(value);
}

function bruteQuery(bounds, queries) {
  return bounds.flatMap((record, index) => (
    queries.some((query) => boundsOverlap(record, query)) ? [index] : []
  ));
}

function brutePairs(bounds) {
  const pairs = [];
  for (let left = 0; left < bounds.length; left++) {
    for (let right = left + 1; right < bounds.length; right++) {
      if (boundsOverlap(bounds[left], bounds[right])) pairs.push([left, right]);
    }
  }
  return pairs;
}

const boundaryFixture = [
  { minX: -10, minZ: -10, maxX: 0, maxZ: 0 },
  { minX: 0, minZ: 0, maxX: 10, maxZ: 10 },
  { minX: 2, minZ: 2, maxX: 2, maxZ: 2 },
  { minX: -35, minZ: -4, maxX: 35, maxZ: 4 },
  { minX: 9.9, minZ: -0.1, maxX: 10.1, maxZ: 0.1 },
  { minX: 80, minZ: 80, maxX: 90, maxZ: 90 },
  { minX: 0, minZ: 0, maxX: 10, maxZ: 10 },
];
const boundaryQueries = [
  { minX: -1, minZ: -1, maxX: 0, maxZ: 0 },
  { minX: 10, minZ: -2, maxX: 10, maxZ: 2 },
  { minX: -20, minZ: -20, maxX: 20, maxZ: 20 },
  { minX: 200, minZ: 200, maxX: 210, maxZ: 210 },
];

let state = 0x156c0de;
const random = () => {
  state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
  return state / 0x100000000;
};
const randomBounds = Array.from({ length: 420 }, (_, index) => {
  const x = random() * 1200 - 600;
  const z = random() * 1200 - 600;
  const width = index % 47 === 0 ? 180 + random() * 220 : random() * 42;
  const depth = index % 61 === 0 ? 160 + random() * 180 : random() * 42;
  return { minX: x, minZ: z, maxX: x + width, maxZ: z + depth };
});
const randomQueries = Array.from({ length: 180 }, (_, index) => {
  const x = random() * 1300 - 650;
  const z = random() * 1300 - 650;
  const width = index % 29 === 0 ? 240 : random() * 70;
  const depth = index % 31 === 0 ? 240 : random() * 70;
  return { minX: x, minZ: z, maxX: x + width, maxZ: z + depth };
});

let queryChecks = 0;
let pairChecks = 0;
for (const [label, bounds, queries] of [
  ['boundary', boundaryFixture, boundaryQueries],
  ['random', randomBounds, randomQueries],
]) {
  for (const cellSize of [7, 16, 32, 73]) {
    const grid = createVerificationSpatialGrid(bounds, (record) => record, { cellSize });
    invariant(snapshot(grid.queryUnion([])) === '[]', `${label}:${cellSize} empty query drift`);
    for (const query of queries) {
      invariant(
        snapshot(grid.query(query)) === snapshot(bruteQuery(bounds, [query])),
        `${label}:${cellSize} query parity drift`,
      );
      queryChecks++;
    }
    for (let index = 0; index < queries.length; index += 9) {
      const union = queries.slice(index, index + 4);
      invariant(
        snapshot(grid.queryUnion(union)) === snapshot(bruteQuery(bounds, union)),
        `${label}:${cellSize} union parity or source-order drift`,
      );
      queryChecks++;
    }
    invariant(
      snapshot(grid.candidatePairs()) === snapshot(brutePairs(bounds)),
      `${label}:${cellSize} pair parity or pair-order drift`,
    );
    pairChecks++;
  }
}

const empty = createVerificationSpatialGrid([], (record) => record);
invariant(snapshot(empty.query({ minX: 0, minZ: 0, maxX: 1, maxZ: 1 })) === '[]',
  'empty index query drift');
invariant(snapshot(empty.candidatePairs()) === '[]', 'empty index pair drift');
expectThrow(
  () => createVerificationSpatialGrid(
    [{ minX: 0, minZ: 0, maxX: Number.NaN, maxZ: 1 }],
    (record) => record,
  ),
  TypeError,
  'non-finite record bounds did not fail closed',
);
expectThrow(
  () => createVerificationSpatialGrid(
    [{ minX: 2, minZ: 0, maxX: 1, maxZ: 1 }],
    (record) => record,
  ),
  RangeError,
  'inverted record bounds did not fail closed',
);
expectThrow(
  () => createVerificationSpatialGrid([], (record) => record, { cellSize: 0 }),
  RangeError,
  'non-positive cell size did not fail closed',
);

console.log(
  `VERIFICATION SPATIAL GRID: PASS (${queryChecks} brute-force query parity checks, `
  + `${pairChecks} pair/order checks, boundary-touch, duplicate-cell, large, empty and invalid fixtures)`,
);
