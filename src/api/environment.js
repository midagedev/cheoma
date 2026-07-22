// 환경·후처리 공개 API. browser/WebGL runtime용이다.
export { setupEnvironment, createFocusRing, setupGrass } from '../env/index.js';
export { setupPost } from '../env/post.js';
export { createDofController, DEFAULT_DOF_APERTURE, focusDepthForPoint } from '../env/dof.js';
export { setupWeather } from '../env/weather.js';
export {
  patchSnowMaterial,
  snowProfileForObject,
  SNOW_ACCUMULATE_SECONDS,
  SNOW_AMOUNT_MAX,
  SNOW_MELT_SECONDS,
} from '../env/snow-material.js';
export { setupNightGlow } from '../env/night-glow.js';
export { setupInk, INK_PALETTE } from '../render/ink.js';
export {
  DEFAULT_SUNSET_LOOK,
  SUNSET_LOOK_IDS,
  SUNSET_LOOKS,
  TIME_PRESETS,
  atmosphereProfileKey,
  normalizeSunsetLook,
  resolveAtmosphereProfile,
  resolvePostProfile,
} from '../env/atmosphere-profiles.js';
export { makeWorldEdge } from '../core/math/world-edge.js';
export {
  ENVIRONMENT_SCENES,
  SEASON_IDS,
  WEATHER_IDS,
  environmentSceneKey,
  normalizeEnvironmentState,
  pickEnvironmentScene,
  resolveEnvironmentChange,
  weatherOkForSeason,
} from '../env/environment-state.js';
