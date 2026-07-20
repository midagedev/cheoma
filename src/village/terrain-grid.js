// village terrain renderer가 쓰는 정규 격자와 삼각 분할의 순수 높이 계약. 도로·성곽·검증이
// 해석 site.heightAt만 다시 부르면 실제 화면의 선형 terrain 면과 어긋날 수 있다.

const GRID_CACHE = new WeakMap();

export function terrainGridSize(site) {
  const terrainR = site.terrainR || site.R;
  return Math.max(150, Math.min(260, Math.round(terrainR / 1.4)));
}

export function terrainMeshHeightAt(site, x, z) {
  const terrainR = site.terrainR || site.R;
  const size = terrainGridSize(site);
  const u = Math.max(0, Math.min(size, (x + terrainR) / (2 * terrainR) * size));
  const v = Math.max(0, Math.min(size, (z + terrainR) / (2 * terrainR) * size));
  const i = Math.min(size - 1, Math.floor(u));
  const j = Math.min(size - 1, Math.floor(v));
  const fu = u - i, fv = v - j;
  const step = 2 * terrainR / size;
  let grid = GRID_CACHE.get(site);
  if (!grid || grid.size !== size || grid.terrainR !== terrainR) {
    const heights = new Float64Array((size + 1) * (size + 1));
    heights.fill(Number.NaN);
    grid = { size, terrainR, heights };
    GRID_CACHE.set(site, grid);
  }
  const height = (di, dj) => {
    const gi = i + di, gj = j + dj;
    const index = gi * (size + 1) + gj;
    let value = grid.heights[index];
    if (Number.isNaN(value)) {
      value = site.heightAt(-terrainR + gi * step, -terrainR + gj * step);
      grid.heights[index] = value;
    }
    return value;
  };
  const a = height(0, 0), b = height(0, 1), c = height(1, 0), d = height(1, 1);
  // terrain.js index: (a,b,c) / (b,d,c), 분할선 fu+fv=1.
  return fu + fv <= 1
    ? a * (1 - fu - fv) + b * fv + c * fu
    : b * (1 - fu) + c * (1 - fv) + d * (fu + fv - 1);
}
