// Three-free ground-junction plans for the structures that own no pad (#56).
//
// A residential parcel already sits on a 성토 shelf whose skirt closes the
// downhill face (pad-landing-plan.js). Landmark-adjacent structures do not: they
// are placed at ONE height sample at their centre and their lowest solid starts at
// local y = 0, so wherever the ground falls away under the footprint a slot opens
// at walk-mode eye height. Measured on the rendered surface at base=d9dcdfc:
//
//   category          objs  float>0.12m   maxFloat   file:line of the datum
//   guardian 돌단      18    11 (61%)      6.49 m     village/gardens.js:430
//   sijeon shop rows   319   99 (31%)      2.91 m     generators/village/sijeon.js:235
//   pavilion podium    8     5  (63%)      0.98 m     generators/village/features.js:357
//   jangseung/sotdae   16    13 (81%)      0.57 m     generators/village/features.js:408
//
// The base height is deliberately NOT re-datumed here. Those samples are the street
// / clearing grade the surrounding roads and parcels were solved against, and the
// same measurement shows the uphill side is simultaneously buried (sijeon up to
// 3.13 m) — moving the datum would trade a float for a different defect and would
// move every landmark. The float is closed from the building side only, exactly as
// a pad skirt closes a parcel: a vertical 석축 face down to the lowest point of the
// rendered terrain under each chord. The shared terrain mesh is never re-tessellated.
//
// Footprint dimensions come from the modules that own the drawn geometry
// (pavilion-spec, guardian-plan, sijeon facade plan) — never re-estimated here.
// An earlier revision of this diagnosis mis-sized three of the four footprints by
// guessing; the numbers above are from the owning modules' constants.

import { deepFreeze } from '../core/stable-seed.js';
import * as G from '../core/math/geom2.js';
import { pavilionPodiumFootprintRadius } from '../builder/pavilion-spec.js';
import { guardianDolranFootprintRadius } from './guardian-plan.js';
import { planSijeonFacade } from './sijeon-plan.js';
import { isSijeonShop } from './sijeon-plan.js';
import {
  GROUND_JUNCTION,
  planGroundJunction,
  ringFootprint,
  rotatedRectFootprint,
} from './ground-junction-plan.js';

// A drawn n-gon of vertex radius R has flats at R·cos(π/n). A junction ring must
// contain the drawn base, so the ring radius is inflated to circumscribe it. At
// RING_SIDES = 24 that is +0.9%, i.e. ~3 cm on a 3.4 m podium — below the sink.
const RING_SIDES = 24;
const RING_CIRCUMSCRIBE = 1 / Math.cos(Math.PI / RING_SIDES);

function junctionRing(centerX, centerZ, radius, rotation = 0) {
  return ringFootprint(centerX, centerZ, radius * RING_CIRCUMSCRIBE, RING_SIDES, rotation);
}

// One junction record: the footprint ring, its datum, and the apron plan.
function record(kind, id, footprint, baseY, site) {
  const ring = G.ensureCCW(footprint);
  const junction = planGroundJunction(site, ring, baseY);
  return deepFreeze({
    kind,
    id: id ?? null,
    baseY,
    footprint: ring.map((point) => ({ x: point.x, z: point.z })),
    junction,
  });
}

/**
 * Ground-junction plans for every no-pad structure in one village plan.
 *
 * Pure and worker-safe. Renderers tessellate `junction.segments` into the existing
 * pad-stone buffer (generators/village/pads.js) — they must not re-derive a
 * footprint, a datum, or an apron height.
 *
 * @returns frozen array of { kind, id, baseY, footprint, junction }
 */
export function planFeatureGroundJunctions(plan, site) {
  if (typeof site?.heightAt !== 'function') {
    throw new TypeError('planFeatureGroundJunctions requires site.heightAt');
  }
  const features = plan?.features || {};
  const out = [];

  // 시전 행랑: base is one analytic sample at the lot centre (sijeon.js:235) and the
  // façade's lowest solid is the wall/column foot at local y = 0. The junction ring
  // is the building box, so the face closes under the walls — the façade part
  // structure and the roof are untouched.
  for (const shop of features.sijeon || []) {
    if (!isSijeonShop(shop)) continue;
    const center = shop?.center;
    if (!Number.isFinite(center?.x) || !Number.isFinite(center?.z)) continue;
    const facade = planSijeonFacade(shop);
    const footprint = rotatedRectFootprint(
      center.x, center.z,
      facade.building.width, facade.building.depth,
      G.facingY(shop.frontDir),
    );
    out.push(record('sijeon', shop.id, footprint, site.heightAt(center.x, center.z), site));
  }

  // 정자 석재 기단.
  const pavilion = features.pavilion;
  if (pavilion && Number.isFinite(pavilion.x) && Number.isFinite(pavilion.z)) {
    out.push(record(
      'pavilion', 'pavilion',
      junctionRing(pavilion.x, pavilion.z, pavilionPodiumFootprintRadius(), pavilion.rot || 0),
      site.heightAt(pavilion.x, pavilion.z), site,
    ));
  }

  // 보호수 밑동 돌단(원형 석축단).
  for (const tree of features.guardianTrees || []) {
    if (!Number.isFinite(tree?.x) || !Number.isFinite(tree?.z)) continue;
    out.push(record(
      'guardian-dolran', `guardian-${tree.role || 'tree'}`,
      junctionRing(tree.x, tree.z, guardianDolranFootprintRadius(tree.scale), tree.spin || 0),
      site.heightAt(tree.x, tree.z), site,
    ));
  }

  return deepFreeze(out);
}

// Aggregate budget of a junction set, reportable without building geometry.
//
// Since v2 the quad count is driven by COURSES, not segments: an undressed lip is
// one quad, a dressed face is one quad per course plus one 갓돌 ledge quad. Two
// triangles per quad.
export function featureGroundJunctionBudget(junctions) {
  let segments = 0;
  let courses = 0;
  let ledges = 0;
  let returns = 0;
  let dressedSegments = 0;
  let maxHeight = 0;
  let chukdaeSegments = 0;
  const byKind = {};
  for (const entry of junctions || []) {
    const junction = entry.junction;
    const count = junction.segments.length;
    let entryCourses = 0;
    let entryLedges = 0;
    for (const segment of junction.segments) {
      entryCourses += segment.courses.length;
      for (const course of segment.courses) {
        if (course.role === 'capstone' && course.outsetTop > 0) entryLedges++;
      }
    }
    segments += count;
    courses += entryCourses;
    ledges += entryLedges;
    returns += (junction.returns || []).length;
    dressedSegments += junction.dressedSegments || 0;
    chukdaeSegments += junction.chukdaeSegments;
    maxHeight = Math.max(maxHeight, junction.maxHeight);
    const bucket = byKind[entry.kind] || (byKind[entry.kind] = {
      objects: 0, segments: 0, quads: 0, maxHeight: 0,
    });
    bucket.objects++;
    bucket.segments += count;
    bucket.quads += entryCourses + entryLedges + (junction.returns || []).length;
    bucket.maxHeight = Math.max(bucket.maxHeight, junction.maxHeight);
  }
  const quads = courses + ledges + returns;
  return {
    objects: (junctions || []).length,
    segments,
    courses,
    ledges,
    returns,
    quads,
    triangles: quads * 2,
    dressedSegments,
    chukdaeSegments,
    maxHeight,
    materialRole: GROUND_JUNCTION.materialRole,
    byKind,
  };
}
