import * as G from '../core/math/geom2.js';
import { makeRng } from '../rng.js';
import { assignFittedVariationSequence } from './house-footprint.js';
import {
  attachParcelSpatialContract,
  canopyBlocksSolarAccess,
} from './parcel-contract.js';
import {
  PAVILION_ROOF_RADIUS,
  pavilionBlocksParcelFocus,
} from './pavilion-plan.js';
import { buildingBlocksSolarAccess } from './solar-access.js';

// A focused-house rebuild may redraw its yard inside the already reserved lot,
// but it must never renegotiate neighbours, roads, streams, or solar access.
// The original parcel is therefore an immutable envelope: each rebuild derives a
// fresh inset polygon from that envelope instead of repeatedly shrinking the last
// result. This makes the operation deterministic, overlap-safe, and reversible by
// a whole-village reroll without introducing a second parcel planner at runtime.

const MIN_BOUNDARY_SCALE = 0.88;
const MAX_BOUNDARY_SCALE = 0.995;

function clonePoint(point) {
  return point ? { x: point.x, z: point.z } : point;
}

function cloneShape(shape) {
  if (!shape) return shape;
  return {
    ...shape,
    pts: (shape.pts || []).map(clonePoint),
    roles: shape.roles ? shape.roles.slice() : undefined,
    // A rebuilt inset wall is independent. Keeping an old shared-edge flag would
    // omit a wall segment even though the neighbouring wall remains on the outer
    // envelope.
    edges: shape.edges?.map((edge) => ({ ...edge, share: false })),
  };
}

export function captureParcelRebuildEnvelope(parcel) {
  return {
    ...parcel,
    center: clonePoint(parcel.center),
    frontDir: clonePoint(parcel.frontDir),
    shape: cloneShape(parcel.shape),
    poly: parcel.poly?.map(clonePoint),
    solarAccess: parcel.solarAccess ? { ...parcel.solarAccess } : null,
    access: parcel.access ? {
      ...parcel.access,
      roadPoint: clonePoint(parcel.access.roadPoint),
      gatePoint: clonePoint(parcel.access.gatePoint),
      gateLocalPoint: clonePoint(parcel.access.gateLocalPoint),
    } : null,
  };
}

function insetShape(shape, scaleX, scaleZ) {
  const points = shape?.pts || [];
  if (points.length < 3) return cloneShape(shape);
  const center = G.polyCentroid(points);
  const next = cloneShape(shape);
  next.pts = points.map((point) => ({
    x: center.x + (point.x - center.x) * scaleX,
    z: center.z + (point.z - center.z) * scaleZ,
  }));
  return next;
}

export function planParcelRebuild(
  envelope,
  rebuildSeed,
  {
    char01 = 0.5,
    tuning = {},
    attempts = 16,
    pavilion = null,
    site = null,
    solarPeers = [],
  } = {},
) {
  if (!envelope?.center || !envelope?.shape?.pts?.length) return null;
  const seed = Number.isFinite(rebuildSeed) ? rebuildSeed >>> 0 : 0;
  const rng = makeRng((seed ^ 0x504c4f54) >>> 0);
  const boundaryX = rng.range(MIN_BOUNDARY_SCALE, MAX_BOUNDARY_SCALE);
  const boundaryZ = rng.range(MIN_BOUNDARY_SCALE, MAX_BOUNDARY_SCALE);
  // If an unusually broad house variant cannot fit the first inset, expand the
  // boundary monotonically toward the immutable envelope. If its height/roof
  // still shadows a neighbour, advance through a fixed sequence of derived
  // variation seeds; this remains deterministic and never mutates the peers.
  const boundaryAttempts = envelope.hero ? 1 : 5;
  for (let variationAttempt = 0; variationAttempt < 6; variationAttempt++) {
    const variationSeed = ((seed ^ 0x484f5553) + Math.imul(variationAttempt, 0x9e3779b1)) >>> 0;
    for (let boundaryAttempt = 0; boundaryAttempt < boundaryAttempts; boundaryAttempt++) {
      const candidate = captureParcelRebuildEnvelope(envelope);
      if (!candidate.hero) {
        const t = boundaryAttempt / (boundaryAttempts - 1);
        const scaleX = boundaryX + (1 - boundaryX) * t;
        const scaleZ = boundaryZ + (1 - boundaryZ) * t;
        candidate.plotW = envelope.plotW * scaleX;
        candidate.plotD = envelope.plotD * scaleZ;
        candidate.shape = insetShape(envelope.shape, scaleX, scaleZ);
        attachParcelSpatialContract(
          candidate,
          envelope.access?.roadId || null,
          envelope.access?.roadPoint || null,
        );
      }
      candidate.rebuildSeed = seed;
      delete candidate.editRoofBounds;
      delete candidate.editBuildingBounds;
      if (!assignFittedVariationSequence(candidate, char01, tuning, {
        baseSeed: variationSeed,
        attempts,
      })) continue;
      // Runtime rebuilds may adjust the wall envelope and therefore the pure focus
      // framing. The village pavilion is a full-height building with broad eaves,
      // not a point prop: keep both the daylight opening and the camera frame clear
      // under the same contract used by initial village planning.
      if (pavilion && (
        canopyBlocksSolarAccess(candidate, pavilion, pavilion.radius || PAVILION_ROOF_RADIUS)
        || pavilionBlocksParcelFocus(candidate, pavilion)
      )) continue;
      if (site && solarPeers.some((peer) => peer && peer.id !== candidate.id && (
        buildingBlocksSolarAccess(candidate, peer, site)
        // A palace owns a precinct-scale vegetation opening, not one residential
        // window target. It can shadow the rebuilt house, but the house must not
        // be rejected for entering that deliberately broad palace corridor.
        || (peer.kind !== 'palace' && buildingBlocksSolarAccess(peer, candidate, site))
      ))) continue;
      return candidate;
    }
  }
  return null;
}

export function parcelRebuildIssues(envelope, candidate) {
  const issues = [];
  if (!envelope || !candidate) return ['missing parcel rebuild input'];
  if (candidate.kind !== envelope.kind) issues.push('social house type changed');
  if (candidate.frontDir?.x !== envelope.frontDir?.x
    || candidate.frontDir?.z !== envelope.frontDir?.z) issues.push('south-facing frame changed');
  if (candidate.plotW > envelope.plotW + 1e-8 || candidate.plotD > envelope.plotD + 1e-8) {
    issues.push('parcel escaped reserved dimensions');
  }
  const outer = envelope.poly || [];
  for (const point of candidate.poly || []) {
    if (!G.pointInPoly(point, outer)
      && !outer.some((a, index) => G.distToSeg(point, a, outer[(index + 1) % outer.length]).d < 1e-7)) {
      issues.push('parcel escaped reserved polygon');
      break;
    }
  }
  if (!candidate.access && envelope.access) issues.push('road access lost');
  if (!candidate.solarAccess) issues.push('solar access lost');
  return issues;
}
