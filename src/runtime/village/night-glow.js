import { candleFlicker } from '../../env/night-glow.js';

const WARM_LIGHT = 0xffb35c;
const TRANSITION_RATE = 2.4;

function levelForTime(name) {
  if (name === 'night') return 1;
  if (name === 'sunset') return 0.42;
  if (name === 'dawn') return 0.22;
  return 0;
}

function collectGlowMaterials(root) {
  const records = [];
  const seen = new Set();
  let index = 0;
  root.traverse((object) => {
    const materials = Array.isArray(object.material) ? object.material : (object.material ? [object.material] : []);
    for (const material of materials) {
      const intensity = material?.userData?.hanjiGlow;
      if (intensity == null || seen.has(material)) continue;
      seen.add(material);
      records.push({ material, intensity, phase: index++ * 1.7, original: null });
    }
  });
  return records;
}

export function createVillageNightGlow(root, onLevelChange = () => {}) {
  const records = collectGlowMaterials(root);
  let elapsed = 0;
  let level = 0;
  let targetLevel = 0;
  let boost = 1;
  let transitionStarted = false;

  function patch(active) {
    for (const record of records) {
      const material = record.material;
      if (active && !record.original) {
        record.original = {
          emissive: material.emissive.getHex(),
          intensity: material.emissiveIntensity,
          map: material.emissiveMap,
        };
        material.emissive.setHex(WARM_LIGHT);
        material.emissiveMap = material.map || null;
        material.needsUpdate = true;
      } else if (!active && record.original) {
        material.emissive.setHex(record.original.emissive);
        material.emissiveIntensity = record.original.intensity;
        material.emissiveMap = record.original.map;
        record.original = null;
        material.needsUpdate = true;
      }
    }
  }

  function apply(flicker) {
    for (const record of records) {
      if (!record.original) continue;
      const variation = flicker ? candleFlicker(elapsed, record.phase) : 1;
      record.material.emissiveIntensity = record.intensity * boost * level * variation;
    }
  }

  function setTime(name, { immediate = false } = {}) {
    targetLevel = levelForTime(name);
    if (!immediate && transitionStarted) return;
    level = targetLevel;
    patch(level > 0.001);
    apply(false);
    onLevelChange(0, level);
  }

  function update(dt) {
    transitionStarted = true;
    if (Math.abs(level - targetLevel) > 1e-4) {
      level += (targetLevel - level) * Math.min(1, dt * TRANSITION_RATE);
      if (Math.abs(level - targetLevel) <= 1e-4) level = targetLevel;
      patch(level > 0.001);
    }
    if (level > 0.001) {
      elapsed += dt;
      apply(true);
    }
    onLevelChange(dt, level);
  }

  return {
    setTime,
    update,
    setBoost(value) { boost = value; },
    resetTransition() { transitionStarted = false; },
    add(additionalRoot) {
      const added = collectGlowMaterials(additionalRoot);
      records.push(...added);
      patch(level > 0.001);
      apply(false);
      return added;
    },
    remove(added) {
      for (const record of added || []) {
        const index = records.indexOf(record);
        if (index >= 0) records.splice(index, 1);
      }
    },
  };
}
