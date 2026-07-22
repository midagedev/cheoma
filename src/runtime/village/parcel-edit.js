import { PRESETS } from '../../params.js';
import { variantOv } from '../../village/variants.js';

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
export function buildParcelSpec(parcel) {
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
    params: {
      frontBays: value('frontBays'), sideBays: value('sideBays'),
      roofPitch: value('roofPitch'), riseScale: value('riseScale'),
      eaveOverhang: value('eaveOverhang'), profileCurve: value('profileCurve'), cornerLift: value('cornerLift'),
      columnHeight: value('columnHeight'), ridgeH: value('ridgeH'), podiumTierH: value('podiumTierH'),
      centerBayW: value('centerBayW'), endBayW: value('endBayW'),
      mainHalfW: value('mainHalfW'), mainHalfD: value('mainHalfD'),
      wingLen: value('wingLen'), wingW: value('wingW'),
      winBack: generatorKind === 'choga' ? (variation.winBack ?? 0) : undefined,
      winSide: generatorKind === 'choga' ? !!variation.winSide : undefined,
      doorPattern: variation.doorPattern || 'ttisal',
      footprintScale: 1,
      wallType: parcel.wallType || 'stone',
      roofTone: parcel.toneIdx || 0,
      thatchAge: generatorKind === 'giwa' ? undefined : (parcel.thatchAge ?? 0.5),
      aux: !!parcel.aux,
      jangdok: parcel.jangdok ?? 0,
      yardStack: !!parcel.yardStack,
      clothesline: !!parcel.clothesline,
      vegBed: !!parcel.vegBed,
    },
  };
}

const PARCEL_TOP_EDIT_KEYS = Object.freeze([
  'footprintScale', 'wallType', 'roofTone', 'thatchAge', 'aux', 'jangdok',
  'yardStack', 'clothesline', 'vegBed',
]);

// A persistent runtime overlay becomes the authoritative representation for its
// parcel. Keep the declarative editor spec in lockstep so leaving and re-entering
// focus cannot reset the panel to the original instanced-house values.
export function buildEditedParcelSpec(parcel, newParams = {}) {
  const spec = buildParcelSpec(parcel);
  const kind = newParams.kind === 'giwa' ? 'giwa'
    : newParams.kind === 'choga' ? 'choga' : spec.kind;
  spec.kind = kind;
  spec.params = { ...spec.params, ...(newParams.building || {}) };
  for (const key of PARCEL_TOP_EDIT_KEYS) {
    if (newParams[key] !== undefined) spec.params[key] = newParams[key];
  }
  return spec;
}

// 가사제한 어휘를 보존해 서민 주택 편집값이 궁궐 비례로 넘어가지 않게 한다.
export function clampBuildingDimensions(params, kind) {
  const clamp = (key, min, max) => {
    if (params[key] != null) params[key] = Math.max(min, Math.min(max, params[key]));
  };
  if (kind === 'giwa') {
    clamp('columnHeight', 2.4, 3.8);
    clamp('ridgeH', 0.30, 0.60);
    clamp('podiumTierH', 0.30, 0.95);
  } else {
    clamp('columnHeight', 1.8, 2.7);
    clamp('ridgeH', 0.24, 0.40);
    clamp('podiumTierH', 0.16, 0.50);
  }
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
