// Renderer-free semantic boundary for the keyboard building navigator (#114).
// The engine maps its existing pick proxies to `{ id, type }`; the UI never
// receives Object3D, camera, bounds, plan, or a second scene model.

export const BUILDING_NAVIGATION_TYPES = Object.freeze([
  'head-house',
  'government',
  'palace',
  'temple',
  'giwa',
  'choga',
]);

const TYPE_SET = new Set(BUILDING_NAVIGATION_TYPES);
const MAX_ID_LENGTH = 128;

function validId(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_ID_LENGTH
    && value.trim() === value;
}

export function classifyBuildingNavigationTarget(buildingSpec, parcelId = null) {
  if (parcelId === 'palace' || buildingSpec?.family === 'palace-compound') return 'palace';
  if (parcelId === 'temple' || buildingSpec?.family === 'temple') return 'temple';
  if (buildingSpec?.hero) {
    return buildingSpec.heroStyle === 'hanok' ? 'head-house' : 'government';
  }
  if (buildingSpec?.kind === 'giwa' || buildingSpec?.kind === 'choga') {
    return buildingSpec.kind;
  }
  return null;
}

export function buildingNavigationTargetFromProxy(proxy) {
  const id = proxy?.parcelId;
  const type = classifyBuildingNavigationTarget(proxy?.buildingSpec, id);
  return validId(id) && type ? { id, type } : null;
}

export function normalizeBuildingNavigationTargets(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const counts = new Map();
  const targets = [];
  for (const candidate of value) {
    const id = candidate?.id;
    const type = candidate?.type;
    if (!validId(id) || !TYPE_SET.has(type) || seen.has(id)) continue;
    seen.add(id);
    const ordinal = (counts.get(type) || 0) + 1;
    counts.set(type, ordinal);
    targets.push({ id, type, ordinal });
  }
  return targets;
}

export function resolveBuildingNavigationTarget(targets, id) {
  return targets.find((target) => target.id === id) || null;
}

// Landmark types read as places, ordinary houses only as a numbered series.
// Grouping keeps that difference visible and lets the ordinary series stay
// bounded (#158 P8: Hanyang produced 297 flat `기와집 N` options).
export const BUILDING_NAVIGATION_LANDMARK_TYPES = Object.freeze([
  'head-house', 'government', 'palace', 'temple',
]);
const LANDMARK_SET = new Set(BUILDING_NAVIGATION_LANDMARK_TYPES);
export const BUILDING_NAVIGATION_GROUP_LIMIT = 20;

// Pure, JSON-safe grouping for the native selector. Order inside each group
// stays the incoming pick-proxy order so keyboard Home/End remain meaningful,
// the currently selected target is always present even past the limit, and the
// caller learns how many ordinary candidates exist behind the bound.
export function groupBuildingNavigationTargets(targets, {
  selectedId = null,
  limit = BUILDING_NAVIGATION_GROUP_LIMIT,
} = {}) {
  const list = Array.isArray(targets) ? targets : [];
  const landmarks = list.filter((target) => LANDMARK_SET.has(target.type));
  const ordinary = list.filter((target) => !LANDMARK_SET.has(target.type));
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : ordinary.length;
  let kept = ordinary.slice(0, cap);
  const selected = ordinary.find((target) => target.id === selectedId);
  // Past the bound the selected target replaces the last slot, so the visible
  // list stays capped and still ascends in pick-proxy order.
  if (selected && !kept.includes(selected)) kept = [...kept.slice(0, Math.max(0, cap - 1)), selected];
  const groups = [];
  if (landmarks.length) {
    groups.push({ id: 'landmark', labelKey: 'nav_group_landmark', total: landmarks.length, targets: landmarks });
  }
  if (kept.length) {
    groups.push({ id: 'houses', labelKey: 'nav_group_houses', total: ordinary.length, targets: kept });
  }
  return groups;
}

export function buildingNavigationStatus(targets, selectedId) {
  const selected = resolveBuildingNavigationTarget(targets, selectedId);
  if (selected) return { kind: 'focus', total: targets.length, selected };
  if (targets.length) return { kind: 'explore', total: targets.length, selected: null };
  return { kind: 'empty', total: 0, selected: null };
}
