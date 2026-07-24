function assertFinite(value, label) {
  if (!Number.isFinite(value)) throw new TypeError(`${label} must be finite`);
}

function normalizeBounds(bounds, label = 'bounds') {
  if (!bounds || typeof bounds !== 'object') throw new TypeError(`${label} must be an object`);
  const normalized = {
    minX: bounds.minX,
    minZ: bounds.minZ,
    maxX: bounds.maxX,
    maxZ: bounds.maxZ,
  };
  for (const [key, value] of Object.entries(normalized)) assertFinite(value, `${label}.${key}`);
  if (normalized.minX > normalized.maxX || normalized.minZ > normalized.maxZ) {
    throw new RangeError(`${label} minimum exceeds maximum`);
  }
  return normalized;
}

export function boundsOverlap(a, b) {
  return a.minX <= b.maxX && a.maxX >= b.minX
    && a.minZ <= b.maxZ && a.maxZ >= b.minZ;
}

export function boundsOfPoints(points, padding = 0) {
  assertFinite(padding, 'padding');
  if (padding < 0) throw new RangeError('padding must not be negative');
  if (!Array.isArray(points) || points.length === 0) {
    throw new TypeError('points must be a non-empty array');
  }
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (let index = 0; index < points.length; index++) {
    const point = points[index];
    assertFinite(point?.x, `points[${index}].x`);
    assertFinite(point?.z, `points[${index}].z`);
    minX = Math.min(minX, point.x);
    minZ = Math.min(minZ, point.z);
    maxX = Math.max(maxX, point.x);
    maxZ = Math.max(maxZ, point.z);
  }
  return {
    minX: minX - padding,
    minZ: minZ - padding,
    maxX: maxX + padding,
    maxZ: maxZ + padding,
  };
}

export function unionBounds(boundsList) {
  if (!Array.isArray(boundsList) || boundsList.length === 0) {
    throw new TypeError('boundsList must be a non-empty array');
  }
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (let index = 0; index < boundsList.length; index++) {
    const bounds = normalizeBounds(boundsList[index], `boundsList[${index}]`);
    minX = Math.min(minX, bounds.minX);
    minZ = Math.min(minZ, bounds.minZ);
    maxX = Math.max(maxX, bounds.maxX);
    maxZ = Math.max(maxZ, bounds.maxZ);
  }
  return { minX, minZ, maxX, maxZ };
}

export function createVerificationSpatialGrid(
  records,
  boundsFor,
  { cellSize = 32 } = {},
) {
  if (!Array.isArray(records)) throw new TypeError('records must be an array');
  if (typeof boundsFor !== 'function') throw new TypeError('boundsFor must be a function');
  assertFinite(cellSize, 'cellSize');
  if (cellSize <= 0) throw new RangeError('cellSize must be positive');

  const recordBounds = records.map((record, index) => (
    normalizeBounds(boundsFor(record, index), `record bounds ${index}`)
  ));
  const cells = new Map();
  let members = 0;

  const visitCells = (bounds, visit) => {
    const minCellX = Math.floor(bounds.minX / cellSize);
    const minCellZ = Math.floor(bounds.minZ / cellSize);
    const maxCellX = Math.floor(bounds.maxX / cellSize);
    const maxCellZ = Math.floor(bounds.maxZ / cellSize);
    for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
      for (let cellZ = minCellZ; cellZ <= maxCellZ; cellZ++) visit(cellX, cellZ);
    }
  };

  for (let index = 0; index < recordBounds.length; index++) {
    visitCells(recordBounds[index], (cellX, cellZ) => {
      const key = `${cellX}:${cellZ}`;
      let bucket = cells.get(key);
      if (!bucket) {
        bucket = [];
        cells.set(key, bucket);
      }
      bucket.push(index);
      members++;
    });
  }

  const marks = new Uint32Array(records.length);
  let epoch = 0;
  const beginQuery = () => {
    epoch++;
    if (epoch === 0xffffffff) {
      marks.fill(0);
      epoch = 1;
    }
  };

  const queryUnion = (queries) => {
    if (!Array.isArray(queries)) throw new TypeError('queries must be an array');
    if (queries.length === 0 || records.length === 0) return [];
    const normalized = queries.map((query, index) => normalizeBounds(query, `query ${index}`));
    const matches = [];
    beginQuery();
    for (const query of normalized) {
      visitCells(query, (cellX, cellZ) => {
        const bucket = cells.get(`${cellX}:${cellZ}`);
        if (!bucket) return;
        for (const index of bucket) {
          if (marks[index] === epoch || !boundsOverlap(recordBounds[index], query)) continue;
          marks[index] = epoch;
          matches.push(index);
        }
      });
    }
    matches.sort((a, b) => a - b);
    return matches;
  };

  const query = (queryBounds) => queryUnion([queryBounds]);

  const candidatePairs = () => {
    const pairs = [];
    for (let left = 0; left < records.length; left++) {
      for (const right of query(recordBounds[left])) {
        if (right > left) pairs.push([left, right]);
      }
    }
    return pairs;
  };

  return Object.freeze({
    query,
    queryUnion,
    candidatePairs,
    stats: Object.freeze({
      records: records.length,
      cells: cells.size,
      members,
    }),
  });
}
