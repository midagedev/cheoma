import { setupVillageCritters } from '../../env/critters.js';
import { parcelRotY } from '../../generators/shared/parcel-transform.js';

const COW_AERIAL_SCALE = 3.5;

/** Own the post-generation village critters and camera-dependent cow LOD. */
export function createVillageFaunaController({ group, plan, site, seed, time = 'day', season = 'summer' }) {
  const parcels = [];
  for (const parcel of plan.parcels) {
    if (parcel.hero || !parcel.poly) continue;
    parcels.push({
      x: parcel.center.x,
      z: parcel.center.z,
      baseY: parcel.baseY != null ? parcel.baseY : site.heightAt(parcel.center.x, parcel.center.z),
      W: parcel.plotW || 20,
      D: parcel.plotD || 18,
      rotY: parcelRotY(parcel),
      kind: parcel.kind === 'giwa' ? 'giwa' : 'choga',
    });
  }

  const treePerches = [];
  for (const tree of (group.userData.guardianAnchors || [])) {
    treePerches.push({ x: tree.x, y: tree.y + (tree.h || 12) * 0.82, z: tree.z });
  }
  for (const tree of (group.userData.yardTreeAnchors || [])) {
    treePerches.push({ x: tree.x, y: tree.y + 0.5, z: tree.z });
  }

  const bounds = plan.bounds || {};
  const radius = Math.max(bounds.w || 0, bounds.d || 0) * 0.5 || 40;
  const center = site.center || { x: 0, z: 0 };
  const rig = setupVillageCritters(group, {
    heightAt: (x, z) => site?.heightAt?.(x, z) ?? 0,
    center: { x: center.x, z: center.z },
    radius,
    siteR: site.R || 0,
    scale: plan.scale,
    parcels,
    treePerches,
    seed: (seed ^ 0x00c1c7) >>> 0,
  });
  rig.setTime(time);
  rig.setSeason(season);

  const rampRef = (site.R && site.R > 1) ? site.R : 120;
  const rampLow = rampRef * 0.55;
  const rampHigh = rampRef * 0.90;
  let cowGroups = null;

  function updateCowLod(camera) {
    if (cowGroups === null) {
      cowGroups = [];
      group.traverse((object) => { if (object.name === 'cow') cowGroups.push(object); });
    }
    if (!cowGroups.length) return;
    const cameraY = camera?.position?.y ?? 0;
    const t = Math.max(0, Math.min(1, (cameraY - rampLow) / Math.max(1, rampHigh - rampLow)));
    const eased = t * t * (3 - 2 * t);
    const scale = 1 + eased * (COW_AERIAL_SCALE - 1);
    for (const cow of cowGroups) cow.scale.setScalar(scale);
  }

  return {
    setTime(name) { rig.setTime(name); },
    setSeason(name) { rig.setSeason(name); },
    update(dt) { rig.update(dt); },
    updateLod(camera) { rig.updateLod(camera); updateCowLod(camera); },
  };
}
