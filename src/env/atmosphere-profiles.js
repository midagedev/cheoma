// Renderer-independent atmosphere profiles. A "time" keeps the simulation contract
// (animals, lanterns, water, audio), while sunsetLook varies only the presentation.
// Keeping sky, lighting, haze, ridge and post values in one profile prevents a purple
// sky from retaining an unrelated orange rim or fog treatment.

export const DEFAULT_SUNSET_LOOK = 'gold';
export const SUNSET_LOOK_IDS = Object.freeze(['gold', 'crimson', 'violet']);

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

const profile = (atmosphere, post) => deepFreeze({ atmosphere, post });

const DAWN = profile({
  sky: [[0.0, '#e7d0b8'], [0.35, '#d9c3bb'], [0.7, '#8f9bbf'], [1.0, '#5d6a97']],
  sunDir: [26, 9, 34], sunColor: 0xffd7ac, sunInt: 1.7,
  hemiSky: 0xc3bcd0, hemiGround: 0x6f6252, hemiInt: 0.75,
  fog: 0xe4cfbd, fogNear: 55, fogFar: 430, exposure: 1.02,
  ridgeNear: 0x4a5069, ridgeFar: 0xcfc1c4, mist: 0xf1e2d4, mistOp: 0.72,
  lantern: 0.0,
}, {
  bloomStrength: 0.55, bloomRadius: 0.55, bloomThreshold: 0.82,
  rim: 1.15, rimColor: 0xffd6bc, rimPower: 2.1, rimWrap: 0.14,
  sunGlow: 0.70, sunGlowSize: 70, sunGlowColor: 0xffdcb4, sat: 1.12,
  flare: 0.55, flareColor: 0xffd9b4,
});

const DAY = profile({
  sky: [[0.0, '#d3dfe8'], [0.4, '#a9c4de'], [0.75, '#7ba6d6'], [1.0, '#5f8fca']],
  sunDir: [30, 42, 26], sunColor: 0xfff3e0, sunInt: 2.6,
  hemiSky: 0xbcd4ec, hemiGround: 0x8a7a63, hemiInt: 0.9,
  fog: 0xcfdde8, fogNear: 95, fogFar: 500, exposure: 1.05,
  ridgeNear: 0x445f6d, ridgeFar: 0xbdd0dc, mist: 0xeef4f8, mistOp: 0.6,
  lantern: 0.0,
}, {
  bloomStrength: 0.42, bloomRadius: 0.5, bloomThreshold: 0.92,
  rim: 0.45, rimColor: 0xfff6ea, rimPower: 2.6, rimWrap: 0.12,
  sunGlow: 0.55, sunGlowSize: 46, sunGlowColor: 0xfff4e6, sat: 1.0,
  flare: 0.24, flareColor: 0xfff2e2,
});

const NIGHT = profile({
  sky: [[0.0, '#2b3a58'], [0.4, '#1c2a48'], [0.75, '#141d33'], [1.0, '#0c1220']],
  sunDir: [-7, 5, -32], sunColor: 0x9fb4d9, sunInt: 0.9,
  hemiSky: 0x33405e, hemiGround: 0x161c28, hemiInt: 0.3,
  fog: 0x1a2740, fogNear: 60, fogFar: 400, exposure: 1.16,
  ridgeNear: 0x222d48, ridgeFar: 0x445270, mist: 0x53628a, mistOp: 0.46,
  lantern: 1.0, moon: true,
}, {
  bloomStrength: 0.70, bloomRadius: 0.62, bloomThreshold: 0.32,
  rim: 0.32, rimColor: 0xaec2e6, rimPower: 3.0, rimWrap: 0.12,
  sunGlow: 0.0, sunGlowSize: 0, sunGlowColor: 0x9fb4d9, sat: 1.0,
  flare: 0.0, flareColor: 0x9fb4d9,
});

export const SUNSET_LOOKS = deepFreeze({
  gold: {
    label: { ko: '금빛 노을', en: 'Golden sunset' },
    ...profile({
      // Existing flagship look, preserved byte-for-byte as the default profile.
      sky: [[0.0, '#f3b877'], [0.26, '#e8a074'], [0.55, '#a87e97'], [1.0, '#45598c']],
      sunDir: [-16, 8, -45], sunColor: 0xffa85c, sunInt: 2.3,
      hemiSky: 0x8593bd, hemiGround: 0x9c7856, hemiInt: 0.72,
      fog: 0xc4a48e, fogNear: 70, fogFar: 470, exposure: 1.11,
      ridgeNear: 0x574863, ridgeFar: 0xc2a284, mist: 0xd8c0ad, mistOp: 0.6,
      lantern: 0.15,
    }, {
      bloomStrength: 0.62, bloomRadius: 0.38, bloomThreshold: 0.80,
      rim: 2.05, rimColor: 0xffc070, rimPower: 1.7, rimWrap: 0.13,
      sunGlow: 0.92, sunGlowSize: 40, sunGlowColor: 0xffb570, sat: 1.18,
      flare: 1.0, flareColor: 0xffc078,
    }),
  },
  crimson: {
    label: { ko: '붉은 노을', en: 'Crimson sunset' },
    ...profile({
      // A clearer, aerosol-rich afterglow: hot peach at the horizon, red lower sky,
      // restrained plum above. Ambient light stays mauve so foliage does not turn brown.
      sky: [[0.0, '#f6a266'], [0.26, '#d96862'], [0.57, '#8d587e'], [1.0, '#3d4d80']],
      sunDir: [-16, 8, -45], sunColor: 0xff9168, sunInt: 2.25,
      hemiSky: 0x8d87b2, hemiGround: 0x925f50, hemiInt: 0.70,
      fog: 0xbd8d89, fogNear: 70, fogFar: 462, exposure: 1.09,
      ridgeNear: 0x57445b, ridgeFar: 0xb98a84, mist: 0xd2aaa1, mistOp: 0.61,
      lantern: 0.15,
    }, {
      bloomStrength: 0.61, bloomRadius: 0.37, bloomThreshold: 0.80,
      rim: 1.98, rimColor: 0xffad7d, rimPower: 1.75, rimWrap: 0.13,
      sunGlow: 0.90, sunGlowSize: 39, sunGlowColor: 0xff9974, sat: 1.17,
      flare: 0.96, flareColor: 0xffad86,
    }),
  },
  violet: {
    label: { ko: '보랏빛 노을', en: 'Violet sunset' },
    ...profile({
      // Late civil twilight: a warm solar band remains at the horizon while scattered
      // blue light mixes with red afterglow into mauve and indigo higher in the dome.
      sky: [[0.0, '#e9aa82'], [0.27, '#c37c99'], [0.58, '#756a9c'], [1.0, '#354777']],
      sunDir: [-16, 8, -45], sunColor: 0xffbea0, sunInt: 2.14,
      hemiSky: 0x7d83b8, hemiGround: 0x806078, hemiInt: 0.72,
      fog: 0xa291a9, fogNear: 68, fogFar: 455, exposure: 1.12,
      ridgeNear: 0x4b4c68, ridgeFar: 0x978ca8, mist: 0xbdb1c0, mistOp: 0.62,
      lantern: 0.18,
    }, {
      bloomStrength: 0.60, bloomRadius: 0.39, bloomThreshold: 0.79,
      rim: 1.90, rimColor: 0xe9bec5, rimPower: 1.82, rimWrap: 0.13,
      sunGlow: 0.86, sunGlowSize: 38, sunGlowColor: 0xf2ad9f, sat: 1.20,
      flare: 0.88, flareColor: 0xe5b4c5,
    }),
  },
});

export const TIME_PROFILES = deepFreeze({ dawn: DAWN, day: DAY, night: NIGHT });

// Backward-compatible atmosphere-only view for consumers that only need the canonical
// direction or lighting values. `sunset` intentionally remains the flagship gold look.
export const TIME_PRESETS = deepFreeze({
  dawn: DAWN.atmosphere,
  day: DAY.atmosphere,
  sunset: SUNSET_LOOKS[DEFAULT_SUNSET_LOOK].atmosphere,
  night: NIGHT.atmosphere,
});

export function normalizeSunsetLook(value) {
  return SUNSET_LOOK_IDS.includes(value) ? value : DEFAULT_SUNSET_LOOK;
}

export function resolveAtmosphereProfile(time, sunsetLook = DEFAULT_SUNSET_LOOK) {
  if (time === 'sunset') return SUNSET_LOOKS[normalizeSunsetLook(sunsetLook)].atmosphere;
  return (TIME_PROFILES[time] || TIME_PROFILES.day).atmosphere;
}

export function resolvePostProfile(time, sunsetLook = DEFAULT_SUNSET_LOOK) {
  if (time === 'sunset') return SUNSET_LOOKS[normalizeSunsetLook(sunsetLook)].post;
  return (TIME_PROFILES[time] || TIME_PROFILES.day).post;
}

export function atmosphereProfileKey(time, sunsetLook = DEFAULT_SUNSET_LOOK) {
  return time === 'sunset' ? `sunset:${normalizeSunsetLook(sunsetLook)}` : (time in TIME_PROFILES ? time : 'day');
}
