import { PRESETS } from '../../params.js';
import { normalizeGiwaPlan } from '../../layout/giwa-footprint.js';
import { normalizeResidentialOpenings } from '../../layout/residential-openings.js';
import { variantOv, variantThatchAge } from '../../village/variants.js';

const WALL_TYPES = Object.freeze({
  giwa: new Set(['tile', 'stone', 'mud', 'brush']),
  choga: new Set(['stone', 'mud', 'brush', 'hedge', 'open']),
});

export function parcelWallType(kind, value) {
  const generatorKind = kind === 'giwa' ? 'giwa' : 'choga';
  return WALL_TYPES[generatorKind].has(value) ? value : 'stone';
}

function palaceBuildingDefaults() {
  const preset = PRESETS.korea;
  return {
    roofPitch: preset.roofPitch,
    eaveOverhang: preset.eaveOverhang,
    profileCurve: preset.profileCurve,
    bracketTiers: preset.bracketTiers,
    bracketScale: preset.bracketScale,
    interBrackets: preset.interBrackets,
    frontBays: preset.frontBays,
    sideBays: preset.sideBays,
    columnHeight: preset.columnHeight,
    podiumTiers: preset.podiumTiers,
    podiumTierH: preset.podiumTierH,
    podiumRailing: preset.podiumRailing,
    cornerLift: preset.cornerLift,
    ridgeH: preset.ridgeH,
    dancheongClarity: preset.dancheongClarity,
    dancheongSplendor: preset.dancheongSplendor,
  };
}

// 다일곽 궁궐 전체에 안전하게 일괄 적용할 수 있는 축만 노출한다.
export function palaceCompoundDefaults() {
  const preset = PRESETS.korea;
  return {
    roofPitch: preset.roofPitch,
    eaveOverhang: preset.eaveOverhang,
    profileCurve: preset.profileCurve,
    cornerLift: preset.cornerLift,
    bracketTiers: preset.bracketTiers,
    bracketScale: preset.bracketScale,
    interBrackets: preset.interBrackets,
    dancheongClarity: preset.dancheongClarity,
    dancheongSplendor: preset.dancheongSplendor,
  };
}

// UI 편집 스키마가 생성기 키를 번역 없이 사용할 수 있게 현재 렌더 기본값을 명세한다.
export function buildParcelSpec(sourceParcel, kindOverride = null) {
  const requestedKind = kindOverride === 'giwa' ? 'giwa'
    : kindOverride === 'choga' ? 'choga' : sourceParcel.kind;
  const changedKind = !sourceParcel.hero && requestedKind !== sourceParcel.kind;
  const parcel = changedKind ? {
    ...sourceParcel,
    kind: requestedKind,
    variant: 0,
    wallType: parcelWallType(requestedKind, sourceParcel.wallType),
    thatchAge: requestedKind === 'choga'
      ? variantThatchAge({ kind: 'choga', variant: 0 })
      : undefined,
  } : sourceParcel;
  const kind = parcel.kind;
  if (parcel.hero) {
    const heroStyle = parcel.heroStyle === 'hanok' ? 'hanok' : 'palace';
    const params = heroStyle === 'hanok'
      ? { riseScale: 1.3, eaveOverhang: 1.15, profileCurve: 0.45, cornerLift: 0.45, ridgeH: 0.42, wallH: 2.7 }
      : palaceBuildingDefaults();
    return {
      kind,
      rank: parcel.rank,
      hero: true,
      heroStyle,
      family: 'hero',
      compound: true,
      plotW: parcel.plotW,
      plotD: parcel.plotD,
      seed: parcel.seed,
      editable: true,
      params,
    };
  }

  const generatorKind = kind === 'giwa' ? 'giwa' : 'choga';
  const preset = PRESETS[generatorKind] || {};
  const variation = variantOv(parcel);
  const value = (key) => variation[key] ?? preset[key];
  const params = {
    planShape: generatorKind === 'giwa' ? value('planShape') : undefined,
    bays: generatorKind === 'giwa' ? value('bays') : undefined,
    bay: generatorKind === 'giwa' ? value('bay') : undefined,
    frontBays: value('frontBays'), sideBays: value('sideBays'),
    roofPitch: value('roofPitch'), riseScale: value('riseScale'),
    eaveOverhang: value('eaveOverhang'), profileCurve: value('profileCurve'), cornerLift: value('cornerLift'),
    columnHeight: value('columnHeight'), ridgeH: value('ridgeH'), podiumTierH: value('podiumTierH'),
    centerBayW: value('centerBayW'), endBayW: value('endBayW'),
    mainHalfW: value('mainHalfW'), mainHalfD: value('mainHalfD'),
    wingLen: value('wingLen'), wingW: value('wingW'),
    doorPattern: variation.doorPattern || 'ttisal',
    footprintScale: 1,
    wallType: parcelWallType(generatorKind, parcel.wallType),
    roofTone: parcel.toneIdx || 0,
    thatchAge: generatorKind === 'giwa' ? undefined : (parcel.thatchAge ?? 0.5),
    aux: !!parcel.aux,
    jangdok: parcel.jangdok ?? 0,
    yardStack: !!parcel.yardStack,
    clothesline: !!parcel.clothesline,
    vegBed: !!parcel.vegBed,
  };
  Object.assign(params, normalizeResidentialOpenings(generatorKind, {
    ...preset,
    ...variation,
    ...params,
  }));
  return {
    kind,
    rank: parcel.rank,
    hero: false,
    family: 'regular',
    plotW: parcel.plotW,
    plotD: parcel.plotD,
    seed: parcel.seed,
    variant: parcel.variant,
    editable: true,
    params,
  };
}

export const PARCEL_TOP_EDIT_KEYS = Object.freeze([
  'footprintScale', 'wallType', 'roofTone', 'thatchAge', 'aux', 'jangdok',
  'yardStack', 'clothesline', 'vegBed',
]);
const PARCEL_TOP_EDIT_KEY_SET = new Set(PARCEL_TOP_EDIT_KEYS);

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeTopEditParams(kind, params) {
  const normalized = { ...params };
  normalized.footprintScale = clamp(
    Number.isFinite(params.footprintScale) ? params.footprintScale : 1,
    0.6,
    1.6,
  );
  normalized.wallType = parcelWallType(kind, params.wallType);
  const roofTone = Number.isFinite(params.roofTone) ? Math.trunc(params.roofTone) : 0;
  normalized.roofTone = ((roofTone % 5) + 5) % 5;
  normalized.thatchAge = kind === 'choga'
    ? clamp(Number.isFinite(params.thatchAge) ? params.thatchAge : 0.5, 0, 1)
    : undefined;
  normalized.aux = !!params.aux;
  normalized.jangdok = clamp(
    Number.isFinite(params.jangdok) ? Math.round(params.jangdok) : 0,
    0,
    3,
  );
  normalized.yardStack = !!params.yardStack;
  normalized.clothesline = !!params.clothesline;
  normalized.vegBed = !!params.vegBed;
  return normalized;
}

function buildingParams(params) {
  return Object.fromEntries(Object.entries(params).filter(([key, value]) => (
    !PARCEL_TOP_EDIT_KEY_SET.has(key) && value !== undefined
  )));
}

// Resolve one residential editor transaction without Three.js state. `previousSpec`
// is the last accepted, fully normalized result; `patch` is the public optional
// rebuildParcel payload. A same-kind patch composes over that result. An explicit
// type change deliberately starts from the target kind's generated defaults so a
// choga-only bay frame or thatch option cannot leak into a giwa (and vice versa).
export function resolveResidentialEdit(sourceParcel, previousSpec = null, patch = {}) {
  const previousKind = previousSpec?.kind === 'giwa' || previousSpec?.kind === 'choga'
    ? previousSpec.kind
    : (sourceParcel.kind === 'giwa' ? 'giwa' : 'choga');
  const requestedKind = patch.kind === 'giwa' || patch.kind === 'choga'
    ? patch.kind
    : previousKind;
  const changedKind = requestedKind !== previousKind;
  const baseSpec = changedKind || !previousSpec
    ? buildParcelSpec(sourceParcel, requestedKind)
    : previousSpec;
  const buildingPatch = { ...(patch.building || {}) };
  if (buildingPatch.roofCurve != null && buildingPatch.profileCurve == null) {
    buildingPatch.profileCurve = buildingPatch.roofCurve;
  }
  delete buildingPatch.roofCurve;
  const params = {
    ...(baseSpec.params || {}),
    ...buildingPatch,
  };
  for (const key of PARCEL_TOP_EDIT_KEYS) {
    if (patch[key] !== undefined) params[key] = patch[key];
  }
  const targetParcel = requestedKind === sourceParcel.kind
    ? sourceParcel
    : { ...sourceParcel, kind: requestedKind, variant: 0 };
  const acceptedBuildingFrame = {
    ...PRESETS[requestedKind],
    ...variantOv(targetParcel),
    ...buildingParams(params),
  };
  clampBuildingDimensions(acceptedBuildingFrame, requestedKind);
  const acceptedBuilding = Object.fromEntries(
    Object.keys(buildingParams(params)).map((key) => [key, acceptedBuildingFrame[key]]),
  );
  const top = normalizeTopEditParams(requestedKind, params);
  const acceptedPatch = { kind: requestedKind, building: acceptedBuilding };
  for (const key of PARCEL_TOP_EDIT_KEYS) acceptedPatch[key] = top[key];
  const spec = buildEditedParcelSpec(sourceParcel, acceptedPatch, acceptedBuilding);
  return { kind: requestedKind, building: acceptedBuilding, top, spec };
}

// A persistent runtime overlay becomes the authoritative representation for its
// parcel. Keep the declarative editor spec in lockstep so leaving and re-entering
// focus cannot reset the panel to the original instanced-house values.
export function buildEditedParcelSpec(parcel, newParams = {}, acceptedBuilding = null) {
  const original = buildParcelSpec(parcel);
  const kind = newParams.kind === 'giwa' ? 'giwa'
    : newParams.kind === 'choga' ? 'choga' : original.kind;
  const spec = buildParcelSpec(parcel, kind);
  spec.params = { ...spec.params, ...(acceptedBuilding || newParams.building || {}) };
  const top = normalizeTopEditParams(kind, { ...spec.params, ...newParams });
  for (const key of PARCEL_TOP_EDIT_KEYS) {
    if (newParams[key] === undefined) continue;
    spec.params[key] = top[key];
  }
  Object.assign(spec.params, normalizeResidentialOpenings(kind, spec.params));
  return spec;
}

// 가사제한 어휘를 보존해 서민 주택 편집값이 궁궐 비례로 넘어가지 않게 한다.
export function clampBuildingDimensions(params, kind) {
  const clamp = (key, min, max) => {
    if (params[key] != null) params[key] = Math.max(min, Math.min(max, params[key]));
  };
  if (kind === 'giwa') {
    const plan = normalizeGiwaPlan(params.planShape, params.bays);
    params.planShape = plan.planShape;
    params.bays = plan.bays;
    clamp('columnHeight', 2.4, 3.8);
    clamp('ridgeH', 0.30, 0.60);
    clamp('podiumTierH', 0.30, 0.95);
  } else {
    clamp('columnHeight', 1.8, 2.7);
    clamp('ridgeH', 0.24, 0.40);
    clamp('podiumTierH', 0.16, 0.50);
  }
  Object.assign(params, normalizeResidentialOpenings(kind, params));
}

// 풀디테일 overlay에도 instanced village와 같은 role별 색 변주를 적용한다.
export function applyMaterialRoleTints(root, tints) {
  root.traverse((object) => {
    const materials = Array.isArray(object.material) ? object.material : (object.material ? [object.material] : []);
    for (const material of materials) {
      if (!material?.color || material.userData._toned) continue;
      const role = material.userData.role;
      const tint = role === 'roof' ? tints.roof : role === 'wall' ? tints.wall
        : role === 'wood' ? tints.wood : role === 'stone' ? tints.stone : null;
      if (!tint) continue;
      material.color.setRGB(
        material.color.r * tint[0],
        material.color.g * tint[1],
        material.color.b * tint[2],
      );
      material.userData._toned = true;
    }
  });
}
