// Renderer-free roof rank and palace-ornament policy (#150 item C).
//
// Hierarchy (high → low): palace > magistracy/gaeksa > city-gate > giwa.
// Temple and choga sit outside the palace-style ladder; they resolve to the same
// ornament denial as giwa so japsang/chwidu cannot leak through style or roofType.
//
// Product ornament gate (more conservative than some secondary readings of
// 「잡상」 for 문루·관아): only rank `palace` receives palace-japsang / palace-chwidu.
// Magistracy and gaeksa may still use palace materials / dancheong / ridge plaster,
// but not those figures. City gates never receive palace ornaments.
//
// ── 개정 2026-08-05 (#54, 사용자 지시) ─────────────────────────────────────────
// 원 결정(위 문단)은 **그대로 유효하다**: city-gate 는 palace-japsang / palace-chwidu 를
// 영원히 받지 않는다(`roofOrnamentPolicy` 의 chwidu/japsang 플래그·이름은 불변).
// 개정된 것은 "성문 지붕에는 장식이 아예 없다"는 그 조항의 **부수 효과**뿐이다. 근거는
// 사용자 판정 인용: "성문 좀더 기와에 곡률이 나와야겠다, 사진과 갭이 그게 크네. 사진 속
// 성문은 제대로 된 지붕이야 — 기와 장식도 있고." (구한말 숭례문 사진: 용마루 양성바름 띠 +
// 양단 취두 + 내림마루 잡상 열이 실제로 보인다.)
// 그래서 palace 등급을 빌려오는 대신 **city-gate 전용 장식 등급**을 신설한다
// (`city-gate-chwidu` / `city-gate-japsang`). 궁 장식과 이름·정책·개수 정책이 분리되므로
// 감사·아이콘·게이트가 두 등급을 섞어 읽을 수 없고, 위계도 유지된다: 성문 잡상 수 상한(5)은
// 궁 상한(11)보다 낮고, 성문은 palace 등급의 토수·추녀마루 종물을 받지 않는다.

export const ROOF_RANK = Object.freeze({
  PALACE: 'palace',
  MAGISTRACY: 'magistracy',
  CITY_GATE: 'city-gate',
  GIWA: 'giwa',
});

/** Stable high → low order for docs, gates, and UI. */
export const ROOF_RANK_ORDER = Object.freeze([
  ROOF_RANK.PALACE,
  ROOF_RANK.MAGISTRACY,
  ROOF_RANK.CITY_GATE,
  ROOF_RANK.GIWA,
]);

const LEVEL = Object.freeze({
  [ROOF_RANK.PALACE]: 3,
  [ROOF_RANK.MAGISTRACY]: 2,
  [ROOF_RANK.CITY_GATE]: 1,
  [ROOF_RANK.GIWA]: 0,
});

/** Product aliases that collapse onto the four public ranks. */
const ALIASES = Object.freeze({
  gaeksa: ROOF_RANK.MAGISTRACY,
  government: ROOF_RANK.MAGISTRACY,
  'guest-house': ROOF_RANK.MAGISTRACY,
  'gov-core': ROOF_RANK.MAGISTRACY,
  gate: ROOF_RANK.CITY_GATE,
  'city-wall-gate': ROOF_RANK.CITY_GATE,
  munru: ROOF_RANK.CITY_GATE,
  hanok: ROOF_RANK.GIWA,
  choga: ROOF_RANK.GIWA,
  temple: ROOF_RANK.GIWA,
});

export const PALACE_CHWIDU_NAME = 'palace-chwidu';
export const PALACE_JAPSANG_NAME = 'palace-japsang';

// 신설 등급(개정 2026-08-05): 성문 문루 전용 마루 종물. palace 이름을 빌리지 않는다.
export const CITY_GATE_CHWIDU_NAME = 'city-gate-chwidu';
export const CITY_GATE_JAPSANG_NAME = 'city-gate-japsang';
/** 내림마루 한 줄의 잡상 수 대역(홀수). 궁 상한 11 아래 위계를 지킨다. */
export const CITY_GATE_JAPSANG_RANGE = Object.freeze({ min: 3, max: 5 });

export function normalizeRoofRank(value) {
  if (value == null) return null;
  const key = String(value).trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(LEVEL, key)) return key;
  if (Object.prototype.hasOwnProperty.call(ALIASES, key)) return ALIASES[key];
  return null;
}

export function roofRankLevel(rank) {
  const normalized = normalizeRoofRank(rank);
  return normalized == null ? -1 : LEVEL[normalized];
}

/** Positive when `a` is higher rank than `b`. */
export function compareRoofRank(a, b) {
  return roofRankLevel(a) - roofRankLevel(b);
}

function isCityGateContext(input = {}) {
  const kind = input.kind != null ? String(input.kind) : '';
  const family = input.family != null ? String(input.family) : '';
  const role = input.role != null ? String(input.role) : '';
  const placement = input.placement != null ? String(input.placement) : '';
  return kind === 'city-gate'
    || family === 'city-gate'
    || role === 'city-gate'
    || placement === 'city-gate'
    || normalizeRoofRank(input.roofRank) === ROOF_RANK.CITY_GATE;
}

/**
 * Resolve the public roof rank from plan/build context.
 *
 * Precedence:
 * 1. explicit `roofRank` (and known aliases)
 * 2. city-gate markers
 * 3. true palace compound / landmark kind `palace`
 * 4. magistracy/gaeksa cores that borrow palace style via `heroStyle: 'palace'`
 * 5. standalone `style: 'palace'` (PRESETS.korea / multi-area halls) → palace
 * 6. everything else → giwa (ornament denial)
 */
export function resolveRoofRank(input = {}) {
  const explicit = normalizeRoofRank(input.roofRank);
  if (explicit) return explicit;

  if (isCityGateContext(input)) return ROOF_RANK.CITY_GATE;

  const kind = input.kind != null ? String(input.kind) : null;
  const family = input.family != null ? String(input.family) : null;
  const heroStyle = input.heroStyle != null ? String(input.heroStyle) : null;
  const style = input.style != null ? String(input.style) : null;
  const placement = input.placement != null ? String(input.placement) : null;

  if (
    kind === 'palace'
    || family === 'palace-compound'
    || placement === 'landmark' && kind === 'palace'
    || input.palace === true
  ) {
    return ROOF_RANK.PALACE;
  }

  // Town/capital reserved cores borrow palace materials but are not multi-곽 palaces.
  if (
    heroStyle === 'palace'
    || family === 'government'
    || family === 'magistracy'
    || family === 'gaeksa'
  ) {
    return ROOF_RANK.MAGISTRACY;
  }

  if (style === 'palace') return ROOF_RANK.PALACE;

  return ROOF_RANK.GIWA;
}

/**
 * Palace-only roof figures. Ridge plaster and dancheong stay style-owned;
 * this policy only gates named japsang / chwidu meshes.
 */
export function roofOrnamentPolicy(rankOrInput) {
  const rank = typeof rankOrInput === 'string' || rankOrInput == null
    ? (normalizeRoofRank(rankOrInput) || ROOF_RANK.GIWA)
    : resolveRoofRank(rankOrInput);
  const palaceOrnaments = rank === ROOF_RANK.PALACE;
  return Object.freeze({
    rank,
    chwidu: palaceOrnaments,
    japsang: palaceOrnaments,
    chwiduName: PALACE_CHWIDU_NAME,
    japsangName: PALACE_JAPSANG_NAME,
  });
}

export function allowsPalaceRoofOrnaments(rankOrInput) {
  const policy = roofOrnamentPolicy(rankOrInput);
  return policy.chwidu && policy.japsang;
}

/**
 * City-gate-only ridge ornaments (개정 2026-08-05, #54). Separate grade from the
 * palace figures: exclusive with `roofOrnamentPolicy`'s palace flags by construction,
 * because it only ever turns on for rank `city-gate`, which that policy denies.
 * 양성 (white ridge plaster) rides this grade too — it is a 격식 marker on the main
 * ridge, not a 종물 mesh, and city gates carry it in the 구한말 photographs.
 */
export function cityGateRoofOrnamentPolicy(rankOrInput) {
  const rank = typeof rankOrInput === 'string' || rankOrInput == null
    ? (normalizeRoofRank(rankOrInput) || ROOF_RANK.GIWA)
    : resolveRoofRank(rankOrInput);
  const cityGate = rank === ROOF_RANK.CITY_GATE;
  return Object.freeze({
    rank,
    chwidu: cityGate,
    japsang: cityGate,
    ridgePlaster: cityGate,
    chwiduName: CITY_GATE_CHWIDU_NAME,
    japsangName: CITY_GATE_JAPSANG_NAME,
    japsangRange: CITY_GATE_JAPSANG_RANGE,
  });
}

export function allowsCityGateRoofOrnaments(rankOrInput) {
  const policy = cityGateRoofOrnamentPolicy(rankOrInput);
  return policy.chwidu && policy.japsang;
}

/**
 * Plan-facing helper: assign the roof rank field for a reserved hero parcel.
 * True multi-area palaces use features.palace + kind palace, not this path.
 */
export function planHeroRoofRank(heroStyle) {
  if (heroStyle === 'palace') return ROOF_RANK.MAGISTRACY;
  if (heroStyle === 'hanok') return ROOF_RANK.GIWA;
  return null;
}
