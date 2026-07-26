// 측정 도구(게이트 아님). HANDOFF.md §3.1·§4.1 의 근거 수치를 재현한다. 순수 node.
// Pure-node: parcel vs real roof footprint → built fraction and front-yard depth.
import { planVillage } from '../src/village/plan.js';
import { parcelEffectiveRoofBounds } from '../src/village/house-footprint.js';

const PYEONG = 3.3058;
const SCALES = ['hamlet', 'village', 'town', 'capital', 'hanyang'];

for (const scale of SCALES) {
  const plan = planVillage({ scale, seed: 7 });
  const parcels = (plan.parcels || []).filter((p) => p.plotW && p.plotD && !p.hero);
  const rows = [];
  for (const p of parcels) {
    let b = null;
    try { b = parcelEffectiveRoofBounds(p); } catch { /* variant not assigned in plan */ }
    if (!b) continue;
    const hw = (b.maxX - b.minX), hd = (b.maxZ - b.minZ);
    const lotA = p.plotW * p.plotD, roofA = hw * hd;
    // +z is south / the gate side, so front yard = lot front edge minus roof front edge.
    const frontYard = (p.plotD / 2) - b.maxZ;
    rows.push({ kind: p.kind, lotA, roofA, hw, hd, frontYard, w: p.plotW, d: p.plotD });
  }
  if (!rows.length) { console.log(`${scale}: no roof bounds in plan output`); continue; }
  const byKind = {};
  for (const r of rows) (byKind[r.kind] ||= []).push(r);
  const avg = (a, f) => a.reduce((s, x) => s + f(x), 0) / a.length;
  console.log(`\n=== ${scale} (${rows.length}) ===`);
  for (const [kind, L] of Object.entries(byKind)) {
    console.log(`  ${kind.padEnd(6)} n=${String(L.length).padStart(3)}`
      + `  lot ${avg(L, (r) => r.w).toFixed(1)}×${avg(L, (r) => r.d).toFixed(1)}m = ${avg(L, (r) => r.lotA).toFixed(0)}m² (${(avg(L, (r) => r.lotA) / PYEONG).toFixed(0)}평)`
      + `  roof ${avg(L, (r) => r.hw).toFixed(1)}×${avg(L, (r) => r.hd).toFixed(1)}m = ${avg(L, (r) => r.roofA).toFixed(0)}m²`
      + `  built ${(avg(L, (r) => r.roofA / r.lotA) * 100).toFixed(0)}%`
      + `  frontYard ${avg(L, (r) => r.frontYard).toFixed(1)}m (min ${Math.min(...L.map((r) => r.frontYard)).toFixed(1)})`);
  }
}
