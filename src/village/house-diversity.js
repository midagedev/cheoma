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
  const uEligible = profile.area >= 175
    && (parcel.plotW || 0) >= 13
    && (parcel.plotD || 0) >= 12
    && profile.household01 >= 0.54;
  const uChance = uEligible
    ? Math.min(0.46, clamp01(0.08
      + (profile.household01 - 0.54) * 1.5
      + (profile.lot01 - 0.45) * 0.20))
    : 0;
  const singleChance = Math.max(0.08, Math.min(0.58,
    0.18 + (0.48 - profile.household01) * 0.95 + (0.36 - profile.lot01) * 0.20,
  ));
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
