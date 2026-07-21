const TAU = Math.PI * 2;

export const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

// Stable expanding-ring search for the nearest usable clearing. The caller owns
// semantics through its predicate; this helper owns only deterministic ordering.
export function radialPlacementCandidates(
  preferred,
  { phase = 0, step, maxRadius, arcStep = step },
) {
  const candidates = [{ x: preferred.x, z: preferred.z }];
  const rings = Math.ceil(maxRadius / step);
  for (let ring = 1; ring <= rings; ring++) {
    const radius = ring * step;
    const count = Math.max(8, Math.ceil(TAU * radius / arcStep));
    const ringPhase = phase + ring * GOLDEN_ANGLE;
    for (let index = 0; index < count; index++) {
      const angle = ringPhase + index / count * TAU;
      candidates.push({
        x: preferred.x + Math.cos(angle) * radius,
        z: preferred.z + Math.sin(angle) * radius,
      });
    }
  }
  return candidates;
}

export function terrainRelief(site, point, sampleRadius, perimeterSamples) {
  let min = Infinity;
  let max = -Infinity;
  const sample = (x, z) => {
    const height = site.heightAt(x, z);
    min = Math.min(min, height);
    max = Math.max(max, height);
  };
  sample(point.x, point.z);
  for (let index = 0; index < perimeterSamples; index++) {
    const angle = index / perimeterSamples * TAU;
    sample(
      point.x + Math.cos(angle) * sampleRadius,
      point.z + Math.sin(angle) * sampleRadius,
    );
  }
  return max - min;
}
