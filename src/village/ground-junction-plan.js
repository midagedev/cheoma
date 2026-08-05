// Three-free ground-junction contract (#56).
//
// A structure whose base sits at one authored datum (baseY) floats wherever the
// rendered terrain falls away under its footprint. Walk-mode eye height reads that
// slot immediately. This module owns the pure numbers that close it from the
// building side: a vertical apron (석축/축대 face) hung off the footprint ring and
// carried down past the LOWEST point of the *rendered* terrain surface under each
// chord.
//
// Two rules make it exact rather than sampled:
//   1. The datum is `terrainMeshSegmentRange` — the triangulated surface the
//      renderer actually draws — not the analytic `site.heightAt` field. Analytic
//      re-sampling diverges from the drawn triangles (terrain-grid.js header), and
//      an apron bottom computed on the wrong surface leaves a residual slot.
//   2. Every terrain triangle is planar, so a chord's exact minimum is available
//      in closed form. A chord's apron bottom is FLAT at that minimum minus
//      GROUND_JUNCTION.sink, which closes the chord along its whole length — a
//      bottom edge interpolated between endpoint samples does not (a mid-chord dip
//      is never seen by endpoint sampling).
//
// The shared terrain mesh is never re-tessellated for this: the building comes
// down to the ground, the ground is not subdivided up to the building (same
// principle as the drainage contract).
//
// Geometry consumers borrow the existing pad-stone material family
// (generators/village/pads.js) — this contract adds no material, texture, or
// draw group of its own.

import { deepFreeze } from '../core/stable-seed.js';
import { FOUNDATION_SINK } from '../core/surface-clearance.js';
import { terrainMeshSegmentRange } from './terrain-grid.js';
import { CITY_GATE_MASONRY, CITY_STONE_BOND, CITY_STONE_VALUES, cityStoneTone } from './citywall-contour.js';

export const GROUND_JUNCTION_SCHEMA_VERSION = 2;

export const GROUND_JUNCTION = deepFreeze({
  // Below the rendered surface, matching the shared foundation/pad sink so a
  // junction face and a pad skirt meet grade the same way.
  sink: FOUNDATION_SINK,
  // Rises under this read as a micro-lip, not a slot: no geometry.
  stepMin: 0.1,
  // Chord cap. A junction bottom is exact per chord, so this only bounds how
  // stepped the (below-grade) bottom edge is allowed to look in section.
  maxSegmentLength: 2,
  // Above this the face is a retaining 석축 rather than a plinth lip. Recorded so
  // renderers and audits can classify a junction without re-deriving it.
  chukdaeCourse: 0.8,
  // Borrowed stone family — VILLAGE_PAD.materialRole. Kept as a literal so
  // pad-landing-plan.js can depend on this module without a cycle.
  materialRole: 'pad-stone',

  // ── 석축 dressing (v2) ────────────────────────────────────────────────────
  // A single tall untextured quad reads as a concrete slab, which is exactly how
  // the v1 apron was judged. The fix reuses the city-wall granite vocabulary —
  // stacked courses, a battered face, a 갓돌 capstone, and per-block value
  // variation carried in VERTEX COLOURS — so no material, texture, or program
  // family is added. Below `dressAbove` the face is a plinth lip that nobody
  // reads as masonry, and dressing it would only cost triangles.
  dressAbove: 0.5,
  courseHeight: 0.42,          // ≈ CITY_GATE_MASONRY.corniceHeight, one granite course
  maxCourses: 10,              // triangle guard for the extreme tail (6.6 m apron)
  batterSlope: CITY_GATE_MASONRY.batterSlope,   // 0.08 — face leans back, base flares
  batterMaxInset: 0.34,        // absolute cap so a tall face cannot flare into a neighbour
  capstoneHeight: 0.18,
  capstoneProjection: 0.07,    // 갓돌 lip beyond the footprint ring
  toneSpread: CITY_STONE_BOND.toneSpread,   // 0.055 per-block value variation
  jointShade: CITY_STONE_BOND.jointShade,   // 0.06 course-bottom joint shadow
  crownLift: CITY_STONE_BOND.crownLift,     // 0.03 course-top highlight
  capstoneValue: CITY_STONE_VALUES.cornice, // 1.02 — the 갓돌 catches the light
  baseCourseValue: CITY_STONE_VALUES.base,  // 0.95 — 대석 켜 sits darker
});

const EPSILON = 1e-8;

function requireSite(site) {
  if (typeof site?.heightAt !== 'function') {
    throw new TypeError('ground junction requires a site with heightAt');
  }
  return site;
}

// Exact lowest rendered-terrain height along the straight chord a→b.
export function junctionChordFloor(site, a, b) {
  return terrainMeshSegmentRange(requireSite(site), a, b).min;
}

// How many chords one edge is split into. Length-driven, so a long façade cannot
// hide a dip between two sparse samples.
export function junctionChordCount(a, b, maxSegmentLength = GROUND_JUNCTION.maxSegmentLength) {
  const length = Math.hypot(b.x - a.x, b.z - a.z);
  const cap = Math.max(0.25, maxSegmentLength);
  return Math.max(1, Math.ceil(length / cap - EPSILON));
}

/**
 * Apron records closing one footprint ring down to the rendered terrain.
 *
 * @param site   village site (heightAt + R/terrainR); the rendered grid is derived.
 * @param polygon footprint ring in world XZ. Not offset — pass the ring the
 *                renderer actually draws its lowest solid on.
 * @param baseY  the datum the structure's lowest solid sits at.
 * @returns frozen, JSON-safe { schema, baseY, segments, maxHeight, chukdaeSegments }
 */
export function planGroundJunction(site, polygon, baseY, {
  sink = GROUND_JUNCTION.sink,
  stepMin = GROUND_JUNCTION.stepMin,
  maxSegmentLength = GROUND_JUNCTION.maxSegmentLength,
} = {}) {
  requireSite(site);
  if (!Array.isArray(polygon) || polygon.length < 3) {
    throw new TypeError('planGroundJunction requires a footprint ring of 3+ points');
  }
  if (!Number.isFinite(baseY)) throw new TypeError('planGroundJunction requires finite baseY');

  // Outward direction of a chord = the side away from the ring's centroid. Derived
  // rather than assumed from winding, so a caller cannot flip the batter by handing
  // over a CW ring.
  let cx = 0, cz = 0;
  for (const point of polygon) { cx += point.x; cz += point.z; }
  cx /= polygon.length; cz /= polygon.length;
  const outwardNormal = (p0, p1) => {
    const dx = p1.x - p0.x, dz = p1.z - p0.z;
    const length = Math.hypot(dx, dz) || 1;
    let nx = -dz / length, nz = dx / length;
    const mx = (p0.x + p1.x) * 0.5, mz = (p0.z + p1.z) * 0.5;
    if (nx * (mx - cx) + nz * (mz - cz) < 0) { nx = -nx; nz = -nz; }
    return { nx, nz };
  };
  const offsetChord = (p0, p1, normal, distance) => [
    { x: p0.x + normal.nx * distance, z: p0.z + normal.nz * distance },
    { x: p1.x + normal.nx * distance, z: p1.z + normal.nz * distance },
  ];
  const batterOutset = (depthBelowBase) => Math.min(
    depthBelowBase * GROUND_JUNCTION.batterSlope,
    GROUND_JUNCTION.batterMaxInset,
  );

  const seed = Math.abs(Math.round(cx * 73856093) ^ Math.round(cz * 19349663)) >>> 0;
  const segments = [];
  let maxHeight = 0;
  let chukdaeSegments = 0;
  let dressedSegments = 0;
  let courseCount = 0;
  for (let index = 0; index < polygon.length; index++) {
    const a = polygon[index];
    const b = polygon[(index + 1) % polygon.length];
    const count = junctionChordCount(a, b, maxSegmentLength);
    for (let chord = 0; chord < count; chord++) {
      const t0 = chord / count;
      const t1 = (chord + 1) / count;
      const p0 = { x: a.x + (b.x - a.x) * t0, z: a.z + (b.z - a.z) * t0 };
      const p1 = { x: a.x + (b.x - a.x) * t1, z: a.z + (b.z - a.z) * t1 };
      const ringFloor = junctionChordFloor(site, p0, p1);
      // Nothing to close: terrain is at or above the datum along this chord.
      if (baseY - ringFloor < stepMin) continue;
      const normal = outwardNormal(p0, p1);
      // A battered face puts its base OUTSIDE the ring, over terrain the ring chord
      // never sampled. Closure must therefore hold on the flared line too, so the
      // floor is the minimum over the ring, half-flare, and full-flare chords.
      const provisional = baseY - ringFloor + sink;
      const flare = batterOutset(provisional);
      const [m0, m1] = offsetChord(p0, p1, normal, flare * 0.5);
      const [o0, o1] = offsetChord(p0, p1, normal, flare);
      const floor = Math.min(
        ringFloor,
        junctionChordFloor(site, m0, m1),
        junctionChordFloor(site, o0, o1),
      );
      const bottomY = Math.min(floor, baseY) - sink;
      const height = baseY - bottomY;
      maxHeight = Math.max(maxHeight, height);
      if (height >= GROUND_JUNCTION.chukdaeCourse) chukdaeSegments++;

      // Courses, top-down. A short lip stays one undressed quad.
      const dressed = height > GROUND_JUNCTION.dressAbove;
      const courses = [];
      const pushCourse = (courseTopY, courseBottomY, role, value) => {
        const tone = value * cityStoneTone(seed, chord + index * 977, courses.length, {
          spread: GROUND_JUNCTION.toneSpread,
        });
        const projection = role === 'capstone' ? GROUND_JUNCTION.capstoneProjection : 0;
        courses.push(deepFreeze({
          role,
          topY: courseTopY,
          bottomY: courseBottomY,
          // Outward offsets of the course's top and bottom edges from the ring.
          outsetTop: Math.max(batterOutset(baseY - courseTopY), projection),
          outsetBottom: Math.max(batterOutset(baseY - courseBottomY), projection),
          tone,
        }));
      };
      if (!dressed) {
        pushCourse(baseY, bottomY, 'plinth', 1);
      } else {
        const capBottom = baseY - GROUND_JUNCTION.capstoneHeight;
        pushCourse(baseY, capBottom, 'capstone', GROUND_JUNCTION.capstoneValue);
        const bodyHeight = capBottom - bottomY;
        const rows = Math.max(1, Math.min(
          GROUND_JUNCTION.maxCourses,
          Math.round(bodyHeight / GROUND_JUNCTION.courseHeight),
        ));
        for (let row = 0; row < rows; row++) {
          const courseTopY = capBottom - bodyHeight * row / rows;
          const courseBottomY = capBottom - bodyHeight * (row + 1) / rows;
          // The lowest course is the 대석 base course and sits a shade darker.
          pushCourse(courseTopY, courseBottomY, row === rows - 1 ? 'base' : 'body',
            row === rows - 1 ? GROUND_JUNCTION.baseCourseValue : 1);
        }
        dressedSegments++;
      }
      courseCount += courses.length;

      segments.push(deepFreeze({
        a: { x: p0.x, z: p0.z },
        b: { x: p1.x, z: p1.z },
        normal: { x: normal.nx, z: normal.nz },
        topY: baseY,
        bottomY,
        height,
        edge: index,
        dressed,
        courses,
      }));
    }
  }
  return deepFreeze({
    schema: GROUND_JUNCTION_SCHEMA_VERSION,
    baseY,
    segments,
    maxHeight,
    chukdaeSegments,
    dressedSegments,
    courseCount,
    materialRole: GROUND_JUNCTION.materialRole,
  });
}

/**
 * Residual visible float left by a junction plan, measured against the rendered
 * surface. Pure audit — no geometry. Returns metres (0 = fully closed).
 *
 * A point on the ring is covered when some segment spanning it reaches below the
 * terrain there. Because each segment bottom is flat at its chord minimum, it is
 * enough to re-derive each chord's minimum and compare.
 */
export function groundJunctionResidualFloat(site, polygon, baseY, plan = null) {
  requireSite(site);
  const junction = plan || planGroundJunction(site, polygon, baseY);
  const covered = new Map();
  for (const segment of junction.segments) {
    covered.set(`${segment.a.x},${segment.a.z},${segment.b.x},${segment.b.z}`, segment);
  }
  let residual = 0;
  for (let index = 0; index < polygon.length; index++) {
    const a = polygon[index];
    const b = polygon[(index + 1) % polygon.length];
    const count = junctionChordCount(a, b);
    for (let chord = 0; chord < count; chord++) {
      const t0 = chord / count;
      const t1 = (chord + 1) / count;
      const p0 = { x: a.x + (b.x - a.x) * t0, z: a.z + (b.z - a.z) * t0 };
      const p1 = { x: a.x + (b.x - a.x) * t1, z: a.z + (b.z - a.z) * t1 };
      const key = `${p0.x},${p0.z},${p1.x},${p1.z}`;
      const segment = covered.get(key) || null;
      const bottom = segment ? segment.bottomY : baseY;
      // Check the ring chord and, when the face is battered, the flared base line
      // too: the batter puts the lowest stone outside the ring, over terrain the
      // ring chord never sampled.
      let floor = junctionChordFloor(site, p0, p1);
      if (segment) {
        const flare = Math.max(
          ...segment.courses.map((course) => Math.max(course.outsetTop, course.outsetBottom)),
          0,
        );
        if (flare > 0) {
          const n = segment.normal;
          for (const distance of [flare * 0.5, flare]) {
            const q0 = { x: p0.x + n.x * distance, z: p0.z + n.z * distance };
            const q1 = { x: p1.x + n.x * distance, z: p1.z + n.z * distance };
            floor = Math.min(floor, junctionChordFloor(site, q0, q1));
          }
        }
      }
      residual = Math.max(residual, bottom - floor);
    }
  }
  return residual;
}

// Rotated-rectangle footprint helper. Shares the local→world convention used by
// pads.js#buildFeaturePad so a renderer and an audit cannot disagree on which
// rectangle a structure stands on.
export function rotatedRectFootprint(centerX, centerZ, width, depth, rotationY = 0) {
  const halfWidth = width / 2;
  const halfDepth = depth / 2;
  const cos = Math.cos(rotationY);
  const sin = Math.sin(rotationY);
  return [
    [-halfWidth, -halfDepth], [halfWidth, -halfDepth],
    [halfWidth, halfDepth], [-halfWidth, halfDepth],
  ].map(([x, z]) => ({
    x: centerX + x * cos + z * sin,
    z: centerZ - x * sin + z * cos,
  }));
}

// Regular n-gon footprint (pavilion podium, 돌단 platform).
export function ringFootprint(centerX, centerZ, radius, sides = 16, rotation = 0) {
  const count = Math.max(3, Math.round(sides));
  const out = [];
  for (let index = 0; index < count; index++) {
    const angle = rotation + (index / count) * Math.PI * 2;
    out.push({
      x: centerX + Math.cos(angle) * radius,
      z: centerZ + Math.sin(angle) * radius,
    });
  }
  return out;
}
