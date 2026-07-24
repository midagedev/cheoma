const DEG = Math.PI / 180;

export const MOON_DISTANCE = 460;
export const MOON_ANGULAR_DIAMETER_DEG = 0.52;
export const MOON_CORONA_DIAMETER_DEG = 5;

// Opaque terrain/buildings still own depth. Within the transparent sky lane, the
// direct lunar disc and transmitted corona sit behind cloud alpha while a much
// fainter scattered corona is added after it. Thin cloud can therefore attenuate
// the source without cutting every trace of nearby atmospheric light.
export const MOON_RENDER_ORDER = Object.freeze({
  coronaTransmitted: -1,
  disk: 0,
  cloudsStart: 1,
  cloudsEnd: 3,
  coronaScattered: 4,
});

export const MOON_CORONA_ENERGY = Object.freeze({
  transmitted: 0.40,
  scattered: 0.02,
});
export const MOON_BLOOM_KNEE = Object.freeze({
  nightThreshold: 0.32,
  releaseThreshold: 0.60,
  radius: 0.10,
  stockWidth: 0.01,
});

export const MOON_CORONA_PROFILE = Object.freeze([
  Object.freeze([0, 0]),
  Object.freeze([0.11, 0]),
  Object.freeze([0.125, 0.34]),
  Object.freeze([0.16, 0.20]),
  Object.freeze([0.32, 0.07]),
  Object.freeze([0.62, 0.018]),
  Object.freeze([1, 0]),
]);

const positive = (value, fallback) => (
  Number.isFinite(value) && value > 0 ? value : fallback
);
const clamp01 = (value) => Math.max(0, Math.min(1, value));
const smoothstep01 = (value) => {
  const t = clamp01(value);
  return t * t * (3 - 2 * t);
};

export function sphereRadiusForAngularDiameter(distance, angularDiameterDeg) {
  const d = positive(distance, MOON_DISTANCE);
  const angle = positive(angularDiameterDeg, MOON_ANGULAR_DIAMETER_DEG) * DEG;
  return d * Math.sin(angle * 0.5);
}

export function planeSpanForAngularDiameter(distance, angularDiameterDeg) {
  const d = positive(distance, MOON_DISTANCE);
  const angle = positive(angularDiameterDeg, MOON_CORONA_DIAMETER_DEG) * DEG;
  return 2 * d * Math.tan(angle * 0.5);
}

export function projectedAngularDiameterPixels(
  angularDiameterDeg,
  verticalFovDeg,
  viewportHeight,
) {
  const angle = positive(angularDiameterDeg, MOON_ANGULAR_DIAMETER_DEG) * DEG;
  const fov = positive(verticalFovDeg, 46) * DEG;
  const height = positive(viewportHeight, 1);
  return height * Math.tan(angle * 0.5) / Math.tan(fov * 0.5);
}

export function sampleMoonCoronaProfile(normalizedRadius) {
  const radius = Number.isFinite(normalizedRadius)
    ? Math.max(0, Math.min(1, normalizedRadius))
    : 0;
  for (let index = 1; index < MOON_CORONA_PROFILE.length; index++) {
    const [rightRadius, rightAlpha] = MOON_CORONA_PROFILE[index];
    if (radius > rightRadius) continue;
    const [leftRadius, leftAlpha] = MOON_CORONA_PROFILE[index - 1];
    const span = Math.max(Number.EPSILON, rightRadius - leftRadius);
    const t = (radius - leftRadius) / span;
    return leftAlpha + (rightAlpha - leftAlpha) * t;
  }
  return MOON_CORONA_PROFILE.at(-1)[1];
}

export function resolveMoonCloudComposite(cloudAlpha) {
  const opacity = Number.isFinite(cloudAlpha)
    ? Math.max(0, Math.min(1, cloudAlpha))
    : 0;
  const transmission = 1 - opacity;
  return Object.freeze({
    disk: transmission,
    corona: MOON_CORONA_ENERGY.transmitted * transmission
      + MOON_CORONA_ENERGY.scattered,
  });
}

export function resolveMoonBloomGate(bloomThreshold) {
  const authoredThreshold = positive(
    bloomThreshold,
    MOON_BLOOM_KNEE.nightThreshold,
  );
  const releaseSpan = MOON_BLOOM_KNEE.releaseThreshold
    - MOON_BLOOM_KNEE.nightThreshold;
  const release = smoothstep01(
    (authoredThreshold - MOON_BLOOM_KNEE.nightThreshold) / releaseSpan,
  );
  const knee = MOON_BLOOM_KNEE.radius * (1 - release);
  return Object.freeze({
    authoredThreshold,
    knee,
    threshold: authoredThreshold - knee,
    smoothWidth: Math.max(MOON_BLOOM_KNEE.stockWidth, knee * 2),
  });
}

export function resolveMoonOptics({
  distance = MOON_DISTANCE,
  diskAngularDiameterDeg = MOON_ANGULAR_DIAMETER_DEG,
  coronaAngularDiameterDeg = MOON_CORONA_DIAMETER_DEG,
} = {}) {
  const resolvedDistance = positive(distance, MOON_DISTANCE);
  const diskAngle = positive(diskAngularDiameterDeg, MOON_ANGULAR_DIAMETER_DEG);
  const coronaAngle = Math.max(
    diskAngle,
    positive(coronaAngularDiameterDeg, MOON_CORONA_DIAMETER_DEG),
  );
  return Object.freeze({
    distance: resolvedDistance,
    diskAngularDiameterDeg: diskAngle,
    coronaAngularDiameterDeg: coronaAngle,
    diskRadius: sphereRadiusForAngularDiameter(resolvedDistance, diskAngle),
    coronaSpan: planeSpanForAngularDiameter(resolvedDistance, coronaAngle),
  });
}

export const DEFAULT_MOON_OPTICS = resolveMoonOptics();
