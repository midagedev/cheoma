import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  DEFAULT_SUNSET_LOOK,
  SUNSET_LOOK_IDS,
  SUNSET_LOOKS,
  TIME_PRESETS,
  atmosphereProfileKey,
  normalizeSunsetLook,
  resolveAtmosphereProfile,
  resolvePostProfile,
} from '../src/env/atmosphere-profiles.js';
import {
  DEFAULT_MOON_OPTICS,
  MOON_ANGULAR_DIAMETER_DEG,
  MOON_BLOOM_KNEE,
  MOON_CORONA_DIAMETER_DEG,
  MOON_CORONA_ENERGY,
  MOON_CORONA_PROFILE,
  MOON_DISTANCE,
  MOON_RENDER_ORDER,
  NIGHT_AERIAL_MOON_FRAME,
  planeSpanForAngularDiameter,
  projectCelestialDirectionNdc,
  projectedAngularDiameterPixels,
  resolveMoonBloomGate,
  resolveMoonCloudComposite,
  resolveMoonOptics,
  resolveNightAerialMoonFrame,
  sampleMoonCoronaProfile,
  sphereRadiusForAngularDiameter,
} from '../src/api/moon-optics.js';
import {
  VILLAGE_FOCUS_CONTEXT_ELEVATION,
  VILLAGE_NIGHT_AERIAL_ELEVATION,
  villageAerialElevation,
} from '../src/camera/optics.js';

const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const rgb = (hex) => {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
};
const distance = (a, b) => Math.hypot(...a.map((value, index) => value - b[index]));

assert.equal(DEFAULT_SUNSET_LOOK, 'gold');
assert.deepEqual(SUNSET_LOOK_IDS, ['gold', 'crimson', 'violet']);
assert.equal(normalizeSunsetLook('missing'), DEFAULT_SUNSET_LOOK);
assert.equal(atmosphereProfileKey('sunset', 'crimson'), 'sunset:crimson');
assert.equal(atmosphereProfileKey('invalid', 'violet'), 'day');
assert.equal(TIME_PRESETS.sunset, SUNSET_LOOKS.gold.atmosphere);
assert.equal(resolveAtmosphereProfile('day', 'violet'), TIME_PRESETS.day);
assert.equal(resolvePostProfile('night', 'crimson'), resolvePostProfile('night', 'gold'));

const directions = [];
const lowerBands = [];
for (const id of SUNSET_LOOK_IDS) {
  const entry = SUNSET_LOOKS[id];
  const atmosphere = resolveAtmosphereProfile('sunset', id);
  const post = resolvePostProfile('sunset', id);
  assert.equal(entry.atmosphere, atmosphere);
  assert.equal(entry.post, post);
  assert.ok(Object.isFrozen(entry) && Object.isFrozen(atmosphere) && Object.isFrozen(post));
  assert.equal(atmosphere.sky.length, 4, `${id}: four compatible sky stops`);
  assert.deepEqual(atmosphere.sky.map(([position]) => position), [...atmosphere.sky.map(([position]) => position)].sort((a, b) => a - b));
  for (const [position, color] of atmosphere.sky) {
    assert.ok(finite(position) && position >= 0 && position <= 1);
    assert.match(color, /^#[0-9a-f]{6}$/i);
  }
  for (const key of ['sunInt', 'hemiInt', 'fogNear', 'fogFar', 'exposure', 'mistOp']) {
    assert.ok(finite(atmosphere[key]), `${id}: ${key}`);
  }
  assert.ok(atmosphere.fogNear < atmosphere.fogFar && atmosphere.sunInt > 0);
  for (const key of [
    'bloomStrength', 'bloomRadius', 'bloomThreshold', 'rim', 'rimPower', 'rimWrap',
    'sunGlow', 'sunGlowSize', 'sat', 'flare',
  ]) assert.ok(finite(post[key]), `${id}: post.${key}`);
  assert.ok(post.rim > 1.5 && post.sunGlow > 0.75 && post.flare > 0.75, `${id}: flagship low-sun energy`);
  directions.push(atmosphere.sunDir);
  lowerBands.push(rgb(atmosphere.sky[1][1]));
}

// Changing sunset hue must not move the sun or pop shadow direction.
assert.deepEqual(directions[1], directions[0]);
assert.deepEqual(directions[2], directions[0]);
// The variants must be visibly separated, not aliases with tiny numerical jitter.
assert.ok(distance(lowerBands[0], lowerBands[1]) > 35, 'gold/crimson lower sky separation');
assert.ok(distance(lowerBands[1], lowerBands[2]) > 35, 'crimson/violet lower sky separation');
assert.ok(distance(lowerBands[0], lowerBands[2]) > 35, 'gold/violet lower sky separation');

const source = await readFile(new URL('../src/env/atmosphere-profiles.js', import.meta.url), 'utf8');
assert.doesNotMatch(source, /from\s+['"]three['"]|document\.|window\.|WebGL/i,
  'profile registry remains renderer/browser independent');

const DEG = Math.PI / 180;
const diskDiameter = 2 * Math.asin(DEFAULT_MOON_OPTICS.diskRadius / MOON_DISTANCE) / DEG;
const coronaDiameter = 2 * Math.atan(
  DEFAULT_MOON_OPTICS.coronaSpan / (2 * MOON_DISTANCE),
) / DEG;
assert.ok(Object.isFrozen(DEFAULT_MOON_OPTICS));
assert.equal(DEFAULT_MOON_OPTICS.distance, MOON_DISTANCE);
assert.ok(Math.abs(diskDiameter - MOON_ANGULAR_DIAMETER_DEG) < 1e-12);
assert.ok(Math.abs(coronaDiameter - MOON_CORONA_DIAMETER_DEG) < 1e-12);
assert.equal(
  sphereRadiusForAngularDiameter(MOON_DISTANCE, MOON_ANGULAR_DIAMETER_DEG),
  DEFAULT_MOON_OPTICS.diskRadius,
);
assert.equal(
  planeSpanForAngularDiameter(MOON_DISTANCE, MOON_CORONA_DIAMETER_DEG),
  DEFAULT_MOON_OPTICS.coronaSpan,
);
assert.deepEqual(resolveMoonOptics({ distance: 0, diskAngularDiameterDeg: -1 }), DEFAULT_MOON_OPTICS);

const diskPixels = [46, 24, 10, 7].map((fov) => (
  projectedAngularDiameterPixels(MOON_ANGULAR_DIAMETER_DEG, fov, 640)
));
assert.ok(diskPixels.every((value, index) => index === 0 || value > diskPixels[index - 1]));
assert.ok(diskPixels[0] > 6.8 && diskPixels[0] < 6.9);
assert.ok(diskPixels[2] > 33.1 && diskPixels[2] < 33.3);
assert.ok(diskPixels[3] > 47.4 && diskPixels[3] < 47.6);

const diskRadiusInCorona = DEFAULT_MOON_OPTICS.diskRadius / (DEFAULT_MOON_OPTICS.coronaSpan * 0.5);
assert.ok(Object.isFrozen(MOON_CORONA_PROFILE) && MOON_CORONA_PROFILE.every(Object.isFrozen));
assert.equal(sampleMoonCoronaProfile(diskRadiusInCorona), 0,
  'interpolated corona energy stays empty across the direct lunar disc');
assert.equal(MOON_CORONA_PROFILE.at(-1)[1], 0);
assert.ok(MOON_CORONA_ENERGY.transmitted > MOON_CORONA_ENERGY.scattered);
assert.ok(Math.abs(
  MOON_CORONA_ENERGY.transmitted + MOON_CORONA_ENERGY.scattered - 0.42,
) < 1e-12);
assert.ok(
  MOON_RENDER_ORDER.coronaTransmitted < MOON_RENDER_ORDER.disk
  && MOON_RENDER_ORDER.disk < MOON_RENDER_ORDER.cloudsStart
  && MOON_RENDER_ORDER.cloudsEnd < MOON_RENDER_ORDER.coronaScattered,
);
const cloudSweep = [0, 0.25, 0.5, 0.75, 1].map(resolveMoonCloudComposite);
assert.deepEqual(cloudSweep.map(({ disk }) => disk), [1, 0.75, 0.5, 0.25, 0]);
assert.ok(cloudSweep.every(({ corona }, index) => (
  Math.abs(corona - [0.42, 0.32, 0.22, 0.12, 0.02][index]) < 1e-12
)));
assert.ok(cloudSweep.every((sample, index) => (
  index === 0
  || (sample.disk < cloudSweep[index - 1].disk
    && sample.corona < cloudSweep[index - 1].corona)
)));
assert.ok(cloudSweep.every(Object.isFrozen));

const bloomGateSweep = Array.from({ length: 97 }, (_, index) => (
  resolveMoonBloomGate(0.32 + index * 0.005)
));
const smoothWeight = (value, edge0, edge1) => {
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};
const bloomWeights = bloomGateSweep.map((gate) => (
  smoothWeight(0.5, gate.threshold, gate.threshold + gate.smoothWidth)
));
const reverseBloomGateSweep = [...bloomGateSweep]
  .reverse()
  .map(({ authoredThreshold }) => resolveMoonBloomGate(authoredThreshold));
assert.equal(bloomGateSweep[0].knee, MOON_BLOOM_KNEE.radius);
assert.equal(bloomGateSweep[0].threshold, 0.22);
assert.equal(bloomGateSweep[0].smoothWidth, 0.20);
assert.equal(bloomGateSweep.at(-1).knee, 0);
assert.equal(bloomGateSweep.at(-1).smoothWidth, MOON_BLOOM_KNEE.stockWidth);
assert.ok(bloomGateSweep.every(Object.isFrozen));
assert.ok(bloomGateSweep.slice(1).every((gate, index) => (
  Math.abs(gate.threshold - bloomGateSweep[index].threshold) < 0.01
  && Math.abs(gate.smoothWidth - bloomGateSweep[index].smoothWidth) < 0.01
  && Math.abs(bloomWeights[index + 1] - bloomWeights[index]) < 0.20
)), 'night bloom knee releases continuously across time-of-day threshold tween');
assert.ok(reverseBloomGateSweep.every((gate, index) => {
  const forward = bloomGateSweep.at(-(index + 1));
  return Math.abs(gate.threshold - forward.threshold) < 1e-12
    && Math.abs(gate.smoothWidth - forward.smoothWidth) < 1e-12;
}), 'time-of-day reversal retraces the same bloom gate without hysteresis');

const moonSource = await readFile(new URL('../src/env/moon-optics.js', import.meta.url), 'utf8');
assert.doesNotMatch(moonSource, /from\s+['"]three['"]|document\.|window\.|WebGL/i,
  'moon optics remain renderer/browser independent');
const moonFacade = await readFile(new URL('../src/api/moon-optics.js', import.meta.url), 'utf8');
assert.doesNotMatch(moonFacade, /from\s+['"]three['"]|document\.|window\.|WebGL/i,
  'the public Moon façade stays renderer/browser independent');

// #150-H: day / dawn / sunset must not drift when night depth is retuned.
// Numeric floors freeze the flagship day and gold sunset light + post grades.
const dayAtmo = resolveAtmosphereProfile('day');
const dawnAtmo = resolveAtmosphereProfile('dawn');
const sunsetAtmo = resolveAtmosphereProfile('sunset', 'gold');
const dayPost = resolvePostProfile('day');
const sunsetPost = resolvePostProfile('sunset', 'gold');
assert.equal(dayAtmo.sunInt, 2.6, 'day sunInt frozen');
assert.equal(dayAtmo.hemiInt, 0.9, 'day hemiInt frozen');
assert.equal(dayAtmo.fogNear, 95, 'day fogNear frozen');
assert.equal(dayAtmo.fogFar, 500, 'day fogFar frozen');
assert.equal(dayAtmo.exposure, 1.05, 'day exposure frozen');
assert.equal(dayAtmo.lantern, 0.0, 'day lantern off');
assert.equal(dayPost.rim, 0.45, 'day rim frozen');
assert.equal(dayPost.bloomThreshold, 0.92, 'day bloom threshold frozen');
assert.equal(dayPost.sat, 1.0, 'day sat frozen');
assert.equal(dawnAtmo.sunInt, 1.7, 'dawn sunInt frozen');
assert.equal(dawnAtmo.hemiInt, 0.75, 'dawn hemiInt frozen');
assert.equal(sunsetAtmo.sunInt, 2.38, 'gold sunset sunInt frozen');
assert.equal(sunsetAtmo.hemiInt, 0.72, 'gold sunset hemiInt frozen');
assert.equal(sunsetAtmo.fogNear, 70, 'gold sunset fogNear frozen');
assert.equal(sunsetPost.rim, 2.05, 'gold sunset rim frozen');
assert.equal(sunsetPost.bloomThreshold, 0.80, 'gold sunset bloom threshold frozen');

// Night depth legibility + U2 aerial moon-in-frame: moon (sun slot) + hemi + fog + grade/rim only.
const nightAtmo = resolveAtmosphereProfile('night');
const nightPost = resolvePostProfile('night');
assert.equal(nightAtmo.moon, true, 'night enables moon presentation');
assert.equal(nightAtmo.lantern, 1.0, 'night lantern weight stays full');
assert.deepEqual(nightAtmo.sunDir, [-7, 3, -32], 'night moon direction stable (low positive elev for aerial)');
assert.ok(nightAtmo.sunDir[1] > 0, 'night moon stays above the horizon for form lighting');
assert.ok(nightAtmo.sunInt >= 1.0, 'night moon intensity models eave/roof form');
assert.ok(nightAtmo.hemiInt >= 0.38, 'night hemi fill lifts soffits and wall faces');
assert.ok(nightAtmo.sunInt > nightAtmo.hemiInt, 'directional moon remains stronger than hemi fill');
assert.ok(nightAtmo.exposure >= 1.18, 'night exposure keeps midtones above crushed black');
assert.ok(nightAtmo.fogNear >= 60 && nightAtmo.fogNear < nightAtmo.fogFar,
  'night fog leaves near architecture readable while layering ridges');
assert.ok(nightAtmo.mistOp >= 0.48, 'night mist contributes aerial depth cue');
assert.equal(nightPost.bloomThreshold, 0.32, 'night bloom threshold anchors moon soft-knee');
assert.equal(nightPost.sunGlow, 0, 'night has no sun glow disc');
assert.equal(nightPost.flare, 0, 'night has no lens flare');
assert.ok(nightPost.rim >= 0.45, 'night moon rim energy separates eave/column silhouettes');
assert.ok(nightPost.rimPower <= 2.6, 'night rim is soft enough for architectural edges');
assert.ok(nightPost.rimWrap >= 0.14, 'night rim wrap fills non-moon edges without a new light');
assert.equal(nightPost.sat, 1.0, 'night grade keeps sat neutral (warmth from lanterns only)');
// Profile registry itself never constructs lights — retune is intensity/colour only.
assert.doesNotMatch(source, /new\s+(THREE\.)?(Point|Directional|Spot|Hemisphere|RectArea)Light/,
  'atmosphere profiles add no light objects');

// U2: pure night-aerial moon framing — product 15° elev admits disc; 31° day survey does not.
assert.ok(Math.abs(VILLAGE_NIGHT_AERIAL_ELEVATION / DEG - NIGHT_AERIAL_MOON_FRAME.cameraElevationDeg) < 1e-9,
  'optics night aerial elevation matches moon-frame contract');
assert.equal(villageAerialElevation('night'), VILLAGE_NIGHT_AERIAL_ELEVATION);
assert.equal(villageAerialElevation('day'), VILLAGE_FOCUS_CONTEXT_ELEVATION);
assert.equal(villageAerialElevation('sunset'), VILLAGE_FOCUS_CONTEXT_ELEVATION);
const nightAerialMoon = resolveNightAerialMoonFrame(nightAtmo.sunDir);
assert.ok(
  nightAerialMoon.discInFrame,
  `night product aerial frames the lunar disc (ndc=${nightAerialMoon.ndcX.toFixed(3)},${nightAerialMoon.ndcY.toFixed(3)})`,
);
assert.ok(nightAerialMoon.coronaInFrame, 'night product aerial keeps corona budget in frame');
const daySurveyMoon = resolveNightAerialMoonFrame(nightAtmo.sunDir, {
  cameraElevationDeg: VILLAGE_FOCUS_CONTEXT_ELEVATION / DEG,
});
assert.equal(daySurveyMoon.discInFrame, false,
  '31° day survey aerial still excludes the moon (elevation change is night-only)');
const steepProject = projectCelestialDirectionNdc(nightAtmo.sunDir, {
  cameraElevationDeg: 31,
});
assert.ok(steepProject.ndcY > 1.0, 'steep aerial projects moon above the top edge');

// Village light rig (linked consumer): still exactly one hemi + one fill directional.
// Values are night-only; day/sunset fill tables stay as authored.
const villageLightSource = await readFile(
  new URL('../src/runtime/village/lighting.js', import.meta.url),
  'utf8',
);
const hemiLightCt = (villageLightSource.match(/new THREE\.HemisphereLight/g) || []).length;
const dirLightCt = (villageLightSource.match(/new THREE\.DirectionalLight/g) || []).length;
const pointLightCt = (villageLightSource.match(/new THREE\.PointLight/g) || []).length;
assert.equal(hemiLightCt, 1, 'village light rig keeps one HemisphereLight');
assert.equal(dirLightCt, 1, 'village light rig keeps one fill DirectionalLight');
assert.equal(pointLightCt, 0, 'village light rig adds no PointLights');
assert.match(villageLightSource, /night:\s*\{[\s\S]*?hemiInt:\s*0\.5[0-9]?/,
  'village night hemi fill is raised for depth legibility');
assert.match(villageLightSource, /night:\s*\{[\s\S]*?fillInt:\s*0\.3[5-9]/,
  'village night anti-solar fill is raised for wall/column modeling');
assert.match(villageLightSource, /glowBoost:\s*1\.5/,
  'hanji glowBoost stays product 1.5 (no wood emissive path)');
// Day/sunset village fill must not have been rewritten by the night retune.
assert.match(villageLightSource, /day:\s*\{[\s\S]*?hemiInt:\s*0\.22/,
  'day village hemi fill frozen');
assert.match(villageLightSource, /sunset:\s*\{[\s\S]*?fillInt:\s*0\.62/,
  'sunset village fill frozen');

console.log(
  'ATMOSPHERE CONTRACT: PASS '
  + '(3 synchronized sunset looks, stable sun direction, 0.52° Moon + split 5° corona, '
  + 'night depth fill without new lights, night aerial moon-in-frame, day/sunset frozen)',
);
