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

export function buildingNavigationStatus(targets, selectedId) {
  const selected = resolveBuildingNavigationTarget(targets, selectedId);
  if (selected) return { kind: 'focus', total: targets.length, selected };
  if (targets.length) return { kind: 'explore', total: targets.length, selected: null };
  return { kind: 'empty', total: 0, selected: null };
}
