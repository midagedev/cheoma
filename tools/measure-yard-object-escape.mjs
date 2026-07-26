// 측정 도구(게이트 아님). HANDOFF.md §3.1·§4.1 의 근거 수치를 재현한다. 순수 node.
// Pure node: does the rectangle-based yard object placement escape the irregular parcel polygon?
import { planVillage } from '../src/village/plan.js';
import { yardJangdokLayout, yardStackLayout, yardClotheslineLayout, yardGardenPatchLayout }
  from '../src/village/yard-layout.js';

const inPoly = (pt, poly) => {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (((a.z > pt.z) !== (b.z > pt.z))
      && (pt.x < (b.x - a.x) * (pt.z - a.z) / (b.z - a.z) + a.x)) inside = !inside;
  }
  return inside;
};
// Signed distance from pt to the polygon boundary (negative = outside).
const distToPoly = (pt, poly) => {
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    const dx = b.x - a.x, dz = b.z - a.z;
    const t = Math.max(0, Math.min(1, ((pt.x - a.x) * dx + (pt.z - a.z) * dz) / (dx * dx + dz * dz || 1)));
    best = Math.min(best, Math.hypot(pt.x - (a.x + t * dx), pt.z - (a.z + t * dz)));
  }
  return inPoly(pt, poly) ? best : -best;
};

const cornersOf = (o) => (o.shape === 'circle'
  ? [{ x: o.x - o.radius, z: o.z }, { x: o.x + o.radius, z: o.z },
     { x: o.x, z: o.z - o.radius }, { x: o.x, z: o.z + o.radius }]
  : [{ x: o.x - o.halfWidth, z: o.z - o.halfDepth }, { x: o.x + o.halfWidth, z: o.z - o.halfDepth },
     { x: o.x - o.halfWidth, z: o.z + o.halfDepth }, { x: o.x + o.halfWidth, z: o.z + o.halfDepth }]);

for (const scale of ['village', 'town', 'capital']) {
  const plan = planVillage({ scale, seed: 7 });
  const parcels = (plan.parcels || []).filter((p) => p.plotW && p.shape);
  const stats = {};
  for (const p of parcels) {
    const poly = p.shape.pts;
    if (!poly || !poly.length) continue;
    const objs = {
      jangdok: yardJangdokLayout(p.plotW, p.plotD, 2),
      stack: yardStackLayout(p.plotW, p.plotD, 0.9),
      clothesline: yardClotheslineLayout(p.plotW, p.plotD, 0),
      garden: yardGardenPatchLayout(p.plotW, p.plotD),
    };
    for (const [name, o] of Object.entries(objs)) {
      if (!o) continue;
      const box = o.halfWidth != null ? o
        : (o.width != null ? { ...o, halfWidth: o.width / 2, halfDepth: o.depth / 2, shape: 'rect' } : o);
      const worst = Math.min(...cornersOf(box).map((c) => distToPoly(c, poly)));
      const s = (stats[name] ||= { n: 0, out: 0, worst: Infinity });
      s.n++; if (worst < 0) { s.out++; s.worst = Math.min(s.worst, worst); }
    }
  }
  console.log(`\n=== ${scale} (${parcels.length} parcels) ===`);
  for (const [name, s] of Object.entries(stats)) {
    console.log(`  ${name.padEnd(12)} outside on ${String(s.out).padStart(3)}/${s.n} parcels`
      + `  (${(s.out / s.n * 100).toFixed(0)}%)`
      + (s.out ? `  worst overhang ${(-s.worst).toFixed(2)}m` : ''));
  }
}
