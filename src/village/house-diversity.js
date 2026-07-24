// Pure household diversity policy.  It deliberately owns no renderer state and
// consumes no global randomness: planning and focused-house rerolls both arrive
// here through assignFittedVariationSequence(), while editor readback consumes
// the selected variant's same planShape/bays fields.

const clamp01 = (value) => Math.min(1, Math.max(0, value));
const TIER_SCORE = Object.freeze({ hamlet: 0, village: 0.25, town: 0.5, capital: 0.75, hanyang: 1 });

export const GIWA_VARIANT = Object.freeze({
  L_RIGHT: 0,
  L_LEFT: 1,
  SINGLE: 2,
  U: 3,
});

// Historical house-size limits establish only a monotone direction here; they
// are not observed averages and must not become literal 10/30/60-bay houses.
// Keep human-scale bay width in the builders, and let a household step increase
// the main range and connected ranges instead.
const compositionLevel = (level, targetMainBays, targetConnectedWings) =>
  Object.freeze({ level, targetMainBays, targetConnectedWings });

export const HOUSEHOLD_COMPOSITION_LEVELS = Object.freeze({
  small: compositionLevel('small', 3, 0),
  medium: compositionLevel('medium', 4, 1),
  large: compositionLevel('large', 5, 2),
});

// Calibrated against the fixed-seed household01 distributions: village keeps
// large compounds rare, while capital/Hanyang expose a natural upper tail.
const HOUSEHOLD_COMPOSITION_MEDIUM = 0.28;
const HOUSEHOLD_COMPOSITION_LARGE = 0.5;

// Pure, deterministic composition centre for every renderer/LOD. The caller
// may pass householdDiversityProfile() or its scalar score. Seed-local choice
// retains adjacent forms around the target, while physical parcel and roof fit
// remain the final authority and may step an oversized form down.
export function householdCompositionPolicy(profileOrScore = 0) {
  const candidate = Number.isFinite(profileOrScore)
    ? profileOrScore
    : profileOrScore?.household01;
  const score = clamp01(Number.isFinite(candidate) ? candidate : 0);
  if (score >= HOUSEHOLD_COMPOSITION_LARGE) return HOUSEHOLD_COMPOSITION_LEVELS.large;
  if (score >= HOUSEHOLD_COMPOSITION_MEDIUM) return HOUSEHOLD_COMPOSITION_LEVELS.medium;
  return HOUSEHOLD_COMPOSITION_LEVELS.small;
}

export function householdDiversityProfile(parcel, char01 = 0.5, wealth = 0.5) {
  const area = Math.max(0, (parcel.plotW || 0) * (parcel.plotD || 0));
  const lot01 = clamp01((Math.sqrt(area) - 9) / 9);
  const rank01 = clamp01(parcel.rank ?? 0.5);
  // Frontage/infill parcels already carry the density scale that shrinks both
  // lot and structure by tier (hamlet 1.00 → hanyang 0.88).  Reuse it instead
  // of duplicating tier metadata on every plan record; satellites retain the
  // explicit continuous value because they intentionally have no density scale.
  const structureTier01 = Number.isFinite(parcel.structureScale)
    ? clamp01((1 - parcel.structureScale) / 0.12)
    : undefined;
  const tier01 = clamp01(parcel.settlementScale01
    ?? structureTier01
    ?? TIER_SCORE[parcel.settlementTier]
    ?? TIER_SCORE[parcel.scale]
    ?? 0.25);
  const household01 = clamp01(
    rank01 * 0.40 + clamp01(wealth) * 0.28 + lot01 * 0.25 + tier01 * 0.07,
  );
  return { area, lot01, rank01, tier01, household01, char01: clamp01(char01) };
}

// Four active prototype groups are retained: ㅡ one, ㄱ mirrored pair, ㄷ one.
// A U is only eligible on a genuinely broad/deep lot; the exact roof-in-polygon
// solver remains the final authority and may still fall back to L or ㅡ.
export function pickGiwaHouseVariant(parcel, char01, wealth, roll, resolvedProfile = null) {
  const profile = resolvedProfile || householdDiversityProfile(parcel, char01, wealth);
  const composition = householdCompositionPolicy(profile);
  const uEligible = profile.area >= 175
    && (parcel.plotW || 0) >= 13
    && (parcel.plotD || 0) >= 12
    && composition.targetConnectedWings >= 2;
  const uChance = uEligible
    ? Math.min(0.68, clamp01(0.48
      + (profile.household01 - HOUSEHOLD_COMPOSITION_LARGE) * 0.75
      + (profile.lot01 - 0.45) * 0.18))
    : 0;
  const singleChance = composition.targetConnectedWings === 0
    ? Math.max(0.58, Math.min(0.82,
      0.68 + (0.28 - profile.household01) * 0.45 + (0.36 - profile.lot01) * 0.18,
    ))
    : composition.targetConnectedWings === 1
      ? Math.max(0.08, Math.min(0.22,
        0.14 + (0.4 - profile.household01) * 0.25,
      ))
      : 0.04;
  const r = clamp01(roll);
  // One seeded quantile keeps the ordering intelligible: low draw=modest ㅡ,
  // middle=ㄱ, high draw=eligible ㄷ.  Household inputs move the cut points.
  if (r < singleChance) return GIWA_VARIANT.SINGLE;
  if (r > 1 - uChance) return GIWA_VARIANT.U;
  const lSpan = Math.max(1e-9, 1 - uChance - singleChance);
  return ((r - singleChance) / lSpan) < 0.5
    ? GIWA_VARIANT.L_RIGHT : GIWA_VARIANT.L_LEFT;
}

export function giwaVariantFallbacks(variant, seed = 0) {
  if (variant === GIWA_VARIANT.U) {
    const pair = (seed >>> 0) & 1
      ? [GIWA_VARIANT.L_LEFT, GIWA_VARIANT.L_RIGHT]
      : [GIWA_VARIANT.L_RIGHT, GIWA_VARIANT.L_LEFT];
    return [...pair, GIWA_VARIANT.SINGLE];
  }
  if (variant === GIWA_VARIANT.L_RIGHT || variant === GIWA_VARIANT.L_LEFT) return [GIWA_VARIANT.SINGLE];
  return [];
}

export function minimumGiwaFit(variant) {
  return variant === GIWA_VARIANT.U
    ? { factor: 0.82, effectiveScale: 0.76 }
    : { factor: 0.70, effectiveScale: 0.68 };
}
