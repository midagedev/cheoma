import { createAmbientField } from '../../env/focus.js';

/** Camera-proximity ambience for non-focused residential parcels. */
export function createVillageAmbientFieldController({ plan, site, proxyById, overrideById, findSun }) {
  const enabled = typeof location === 'undefined'
    || new URLSearchParams(location.search).get('ambfield') !== '0';
  let field = null;
  let lastDt = 0.016;
  let time = 'day';
  let season = 'summer';

  function buildDescriptors() {
    const descriptors = [];
    for (const parcel of plan.parcels) {
      if (parcel.hero) continue;
      const proxy = proxyById.get(parcel.id);
      if (!proxy) continue;
      const style = parcel.kind === 'giwa' ? 'giwa' : 'choga';
      const { rotY, worldCenter } = proxy;
      const baseY = parcel.baseY != null ? parcel.baseY : worldCenter.y;
      const width = parcel.plotW || 20;
      const depth = parcel.plotD || 18;
      const sign = (parcel.seed & 4) ? 1 : -1;
      const localX = width * 0.22 * sign;
      const localZ = -depth * 0.30;
      const cos = Math.cos(rotY);
      const sin = Math.sin(rotY);
      descriptors.push({
        id: parcel.id,
        cx: worldCenter.x,
        cz: worldCenter.z,
        baseY,
        rotY,
        W: width,
        D: depth,
        style,
        seed: (parcel.seed || 7) >>> 0,
        chimney: {
          x: parcel.center.x + localX * cos + localZ * sin,
          y: baseY + (style === 'giwa' ? 4.6 : 3.4),
          z: parcel.center.z - localX * sin + localZ * cos,
        },
      });
    }
    return descriptors;
  }

  function enter(scene) {
    if (!enabled || field || !scene) return;
    field = createAmbientField(scene, {
      heightAt: (x, z) => site?.heightAt?.(x, z) ?? 0,
      sun: findSun(scene),
    });
    field.setParcels(buildDescriptors());
    field.setExcluded((id) => overrideById.has(id));
    field.setTime(time, true);
    field.setSeason(season);
  }

  function exit() {
    field?.dispose();
    field = null;
  }

  return {
    enter,
    exit,
    rememberDt(dt) { lastDt = dt; },
    update(camera) { field?.update(lastDt, camera); },
    setTime(name) { time = name; field?.setTime(name); },
    setSeason(name) { season = name; field?.setSeason(name); },
  };
}
