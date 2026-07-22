import { planResidentialOpenings } from '../layout/residential-openings.js';
import { planOpeningDetail } from './opening-detail-plan.js';
import { createOpeningDetailAssembler } from './opening-details.js';

// FULL residential builders share one bridge from the renderer-free opening
// policy to the batched changho detail assembler. Besides removing duplicate
// door/window grammar, this boundary fails closed when a planned opening is
// skipped or assembled twice: counts, widths and the single primary entrance
// must remain the planner's values all the way to rendered geometry.

const EPSILON = 1e-9;

function profileFor(profiles, opening) {
  const profile = profiles?.[opening.kind];
  if (!profile) throw new Error(`Missing ${opening.style} ${opening.kind} detail profile`);
  return typeof profile === 'function' ? profile(opening) : profile;
}

export function createResidentialOpeningDetails(kind, building, target, materials, profiles) {
  const plan = planResidentialOpenings(kind, building, building?.seed);
  const assembler = createOpeningDetailAssembler(target, materials);
  const byBay = new Map(plan.openings.map((opening) => (
    [`${opening.edgeIndex}:${opening.bayIndex}`, opening]
  )));
  const added = new Set();
  target.userData.residentialOpeningPlan = plan;

  function openingAt(edgeIndex, bayIndex) {
    return byBay.get(`${edgeIndex}:${bayIndex}`) || null;
  }

  function add(opening, ownerOrFactory = null) {
    if (!opening || !plan.openings.includes(opening)) {
      throw new Error('Residential opening does not belong to this building plan');
    }
    if (added.has(opening.id)) throw new Error(`Residential opening assembled twice: ${opening.id}`);
    const profile = profileFor(profiles, opening);
    const detail = planOpeningDetail({
      kind: opening.kind,
      style: opening.style,
      seed: `${plan.seed}:${opening.id}`,
      width: opening.width,
      height: profile.height,
      wallThickness: profile.wallThickness,
      leafCount: profile.leafCount,
      meoreumHeight: opening.kind === 'window' ? profile.meoreumHeight : undefined,
      lowerPanelHeight: opening.kind === 'door' ? profile.lowerPanelHeight : undefined,
      primary: opening.primary,
      footwear: opening.primary ? profile.footwear : null,
    });
    if (Math.abs(detail.width - opening.width) > EPSILON) {
      throw new Error(`Opening detail width drifted for ${opening.id}: ${detail.width} != ${opening.width}`);
    }
    const owner = typeof ownerOrFactory === 'function'
      ? ownerOrFactory(detail)
      : ownerOrFactory;
    if (owner) {
      owner.userData.residentialOpening = opening;
      owner.userData.residentialOpeningDetail = detail;
    }
    assembler.add(detail, {
      center: opening.center,
      bottomY: profile.bottomY,
      tangent: opening.tangent,
      outward: opening.outward,
    }, owner);
    added.add(opening.id);
    return detail;
  }

  function finish() {
    const missing = plan.openings.filter((opening) => !added.has(opening.id));
    if (missing.length) {
      throw new Error(`Residential openings were not assembled: ${missing.map((opening) => opening.id).join(', ')}`);
    }
    assembler.finish();
  }

  return { plan, openingAt, add, finish };
}
