import { PNG } from 'pngjs';

export const ROUNDNESS_RADIUS = 20;
export const ENERGY_RADIUS = 40;
export const STRIP_RADIUS = 28;
// The default 2.4× source profile is intentionally darker than its sharp source
// through the filled core. Its positive ON−OFF evidence lives in the thin outer
// shoulder, not in the diluted centre.
const SOURCE_ANNULUS_INNER = 14;
const SOURCE_ANNULUS_OUTER = 22;

function pixelLuminance(png, x, y) {
  const offset = (y * png.width + x) * 4;
  return 0.2126 * png.data[offset]
    + 0.7152 * png.data[offset + 1]
    + 0.0722 * png.data[offset + 2];
}

function estimateBackground(png) {
  let energy = 0;
  let count = 0;
  const origins = [
    [8, 8],
    [png.width - 16, 8],
    [8, png.height - 16],
    [png.width - 16, png.height - 16],
  ];
  for (const [originX, originY] of origins) {
    for (let y = originY; y < originY + 8; y++) {
      for (let x = originX; x < originX + 8; x++) {
        energy += pixelLuminance(png, x, y);
        count++;
      }
    }
  }
  return energy / count;
}

function measureLight(png, light, background, radius = ROUNDNESS_RADIUS) {
  const cx = Math.round(light.x);
  const cy = Math.round(light.y);
  const samples = [];
  for (let y = cy - radius; y <= cy + radius; y++) {
    for (let x = cx - radius; x <= cx + radius; x++) {
      samples.push({ x, y, luminance: pixelLuminance(png, x, y) });
    }
  }
  let energy = 0;
  let weightedX = 0;
  let weightedY = 0;
  for (const sample of samples) {
    sample.weight = Math.max(0, sample.luminance - background);
    energy += sample.weight;
    weightedX += sample.x * sample.weight;
    weightedY += sample.y * sample.weight;
  }
  if (!(energy > 0)) throw new Error(`${light.name} has no measurable HDR bokeh energy`);
  const centroidX = weightedX / energy;
  const centroidY = weightedY / energy;
  let xx = 0;
  let yy = 0;
  let xy = 0;
  for (const sample of samples) {
    const dx = sample.x - centroidX;
    const dy = sample.y - centroidY;
    xx += sample.weight * dx * dx;
    yy += sample.weight * dy * dy;
    xy += sample.weight * dx * dy;
  }
  xx /= energy;
  yy /= energy;
  xy /= energy;
  const trace = xx + yy;
  const delta = Math.sqrt((xx - yy) ** 2 + 4 * xy ** 2);
  const minor = Math.max(1e-9, (trace - delta) * 0.5);
  const major = Math.max(minor, (trace + delta) * 0.5);
  const angularEnergy = Array(24).fill(0);
  for (const sample of samples) {
    const dx = sample.x - centroidX;
    const dy = sample.y - centroidY;
    const distance = Math.hypot(dx, dy);
    if (distance < 3 || distance > radius * 0.9) continue;
    const angle = (Math.atan2(dy, dx) + Math.PI * 2) % (Math.PI * 2);
    const bin = Math.min(
      angularEnergy.length - 1,
      Math.floor(angle / (Math.PI * 2) * angularEnergy.length),
    );
    angularEnergy[bin] += sample.weight;
  }
  const angularMean = angularEnergy.reduce((sum, value) => sum + value, 0)
    / angularEnergy.length;
  const angularVariance = angularEnergy.reduce(
    (sum, value) => sum + (value - angularMean) ** 2,
    0,
  ) / angularEnergy.length;
  return {
    name: light.name,
    x: light.x,
    y: light.y,
    centroidX,
    centroidY,
    energy,
    aspect: Math.sqrt(major / minor),
    angularVariation: angularMean > 0
      ? Math.sqrt(angularVariance) / angularMean
      : Infinity,
    rmsRadius: Math.sqrt(trace),
  };
}

export function measureLights(image, lights) {
  const png = PNG.sync.read(image);
  const background = estimateBackground(png);
  return lights.map((light) => ({
    ...measureLight(png, light, background),
    energy: measureLight(png, light, background, ENERGY_RADIUS).energy,
  }));
}

export function measureDiscProfile(image, light, radius = ENERGY_RADIUS) {
  const png = PNG.sync.read(image);
  const background = estimateBackground(png);
  const cx = Math.round(light.x);
  const cy = Math.round(light.y);
  const bins = Array.from({ length: radius + 1 }, () => ({ energy: 0, count: 0 }));
  for (let y = cy - radius; y <= cy + radius; y++) {
    for (let x = cx - radius; x <= cx + radius; x++) {
      const bin = Math.floor(Math.hypot(x - cx, y - cy));
      if (bin > radius) continue;
      bins[bin].energy += pixelLuminance(png, x, y);
      bins[bin].count++;
    }
  }
  const radialMean = bins.map((bin) => bin.energy / Math.max(1, bin.count));
  const peak = Math.max(...radialMean.slice(0, 3));
  const peakSignal = Math.max(1e-9, peak - background);
  const diameterAt = (fraction) => {
    let outerRadius = 0;
    for (let index = 0; index < radialMean.length; index++) {
      if (radialMean[index] - background >= peakSignal * fraction) outerRadius = index;
    }
    return outerRadius * 2 + 1;
  };
  const coreDiameterPx = diameterAt(0.8);
  const outerDiameterPx = diameterAt(0.35);
  const outerRadius = Math.max(1, (outerDiameterPx - 1) * 0.5);
  const innerIndex = Math.min(radius, Math.max(0, Math.round(outerRadius * 0.7)));
  const outsideIndex = Math.min(
    radius,
    Math.max(innerIndex + 1, Math.round(outerRadius * 1.2)),
  );
  return {
    projectedEmitterDiameterPx: light.diameterPx,
    coreDiameterPx,
    outerDiameterPx,
    coreMagnification: coreDiameterPx / Math.max(1e-9, light.diameterPx),
    outerMagnification: outerDiameterPx / Math.max(1e-9, light.diameterPx),
    edgeDrop: (radialMean[innerIndex] - radialMean[outsideIndex]) / peakSignal,
    innerRadiusPx: innerIndex,
    outsideRadiusPx: outsideIndex,
  };
}

export function measurePositiveDelta(
  onImage,
  offImage,
  light,
  radius = ROUNDNESS_RADIUS,
) {
  const on = PNG.sync.read(onImage);
  const off = PNG.sync.read(offImage);
  if (on.width !== off.width || on.height !== off.height) {
    throw new Error(`${light.name} delta images have mismatched dimensions`);
  }
  const cx = Math.round(light.x);
  const cy = Math.round(light.y);
  const samples = [];
  let energy = 0;
  let annulusEnergy = 0;
  let annulusPixels = 0;
  let weightedX = 0;
  let weightedY = 0;
  for (let y = cy - radius; y <= cy + radius; y++) {
    for (let x = cx - radius; x <= cx + radius; x++) {
      const weight = Math.max(
        0,
        pixelLuminance(on, x, y) - pixelLuminance(off, x, y),
      );
      const distance = Math.hypot(x - cx, y - cy);
      if (distance >= SOURCE_ANNULUS_INNER && distance <= SOURCE_ANNULUS_OUTER) {
        annulusEnergy += weight;
        annulusPixels++;
      }
      samples.push({ x, y, weight });
      energy += weight;
      weightedX += x * weight;
      weightedY += y * weight;
    }
  }
  if (!(energy > 0)) {
    return {
      name: light.name,
      energy: 0,
      annulusEnergy: 0,
      annulusMean: 0,
      aspect: Infinity,
      angularVariation: Infinity,
      rmsRadius: 0,
      centroidError: Infinity,
    };
  }
  const centroidX = weightedX / energy;
  const centroidY = weightedY / energy;
  let xx = 0;
  let yy = 0;
  let xy = 0;
  for (const sample of samples) {
    const dx = sample.x - centroidX;
    const dy = sample.y - centroidY;
    xx += sample.weight * dx * dx;
    yy += sample.weight * dy * dy;
    xy += sample.weight * dx * dy;
  }
  xx /= energy;
  yy /= energy;
  xy /= energy;
  const trace = xx + yy;
  const delta = Math.sqrt((xx - yy) ** 2 + 4 * xy ** 2);
  const minor = Math.max(1e-9, (trace - delta) * 0.5);
  const major = Math.max(minor, (trace + delta) * 0.5);
  const angularEnergy = Array(24).fill(0);
  for (const sample of samples) {
    const dx = sample.x - centroidX;
    const dy = sample.y - centroidY;
    const distance = Math.hypot(dx, dy);
    if (distance < 3 || distance > radius * 0.9) continue;
    const angle = (Math.atan2(dy, dx) + Math.PI * 2) % (Math.PI * 2);
    const bin = Math.min(
      angularEnergy.length - 1,
      Math.floor(angle / (Math.PI * 2) * angularEnergy.length),
    );
    angularEnergy[bin] += sample.weight;
  }
  const angularMean = angularEnergy.reduce((sum, value) => sum + value, 0)
    / angularEnergy.length;
  const angularVariance = angularEnergy.reduce(
    (sum, value) => sum + (value - angularMean) ** 2,
    0,
  ) / angularEnergy.length;
  return {
    name: light.name,
    energy,
    annulusEnergy,
    annulusMean: annulusEnergy / Math.max(1, annulusPixels),
    aspect: Math.sqrt(major / minor),
    angularVariation: angularMean > 0
      ? Math.sqrt(angularVariance) / angularMean
      : Infinity,
    rmsRadius: Math.sqrt(trace),
    centroidError: Math.hypot(centroidX - light.x, centroidY - light.y),
  };
}

export function edgeEnergy(image, point, halfWidth = 8, halfHeight = 24) {
  const png = PNG.sync.read(image);
  const cx = Math.round(point.x);
  const cy = Math.round(point.y);
  let energy = 0;
  for (let y = cy - halfHeight; y <= cy + halfHeight; y++) {
    for (let x = cx - halfWidth; x <= cx + halfWidth; x++) {
      energy += Math.abs(
        pixelLuminance(png, x + 1, y) - pixelLuminance(png, x - 1, y),
      );
    }
  }
  return energy;
}

export function measureCardLeak(onImage, offImage, point, bounds, edge) {
  const on = PNG.sync.read(onImage);
  const off = PNG.sync.read(offImage);
  const x0 = edge === 'left' ? bounds.left + 1 : bounds.right - 6;
  const x1 = edge === 'left' ? bounds.left + 6 : bounds.right - 1;
  const cy = Math.round(point.y);
  let maxPositiveChannel = 0;
  let positiveLuminance = 0;
  let count = 0;
  for (let y = cy - 8; y <= cy + 8; y++) {
    for (let x = x0; x <= x1; x++) {
      const offset = (y * on.width + x) * 4;
      const dr = Math.max(0, on.data[offset] - off.data[offset]);
      const dg = Math.max(0, on.data[offset + 1] - off.data[offset + 1]);
      const db = Math.max(0, on.data[offset + 2] - off.data[offset + 2]);
      maxPositiveChannel = Math.max(maxPositiveChannel, dr, dg, db);
      positiveLuminance += 0.2126 * dr + 0.7152 * dg + 0.0722 * db;
      count++;
    }
  }
  return {
    maxPositiveChannel,
    meanPositiveLuminance: positiveLuminance / Math.max(1, count),
    pixels: count,
  };
}

export function maxChannelDifference(a, b) {
  const first = PNG.sync.read(a);
  const second = PNG.sync.read(b);
  if (first.width !== second.width || first.height !== second.height) return Infinity;
  let difference = 0;
  for (let index = 0; index < first.data.length; index++) {
    difference = Math.max(
      difference,
      Math.abs(first.data[index] - second.data[index]),
    );
  }
  return difference;
}

export function positiveDeltaImage(onImage, offImage, gain = 1) {
  const on = PNG.sync.read(onImage);
  const off = PNG.sync.read(offImage);
  const delta = new PNG({ width: on.width, height: on.height });
  for (let index = 0; index < on.data.length; index += 4) {
    delta.data[index] = Math.min(
      255,
      Math.max(0, on.data[index] - off.data[index]) * gain,
    );
    delta.data[index + 1] = Math.min(
      255,
      Math.max(0, on.data[index + 1] - off.data[index + 1]) * gain,
    );
    delta.data[index + 2] = Math.min(
      255,
      Math.max(0, on.data[index + 2] - off.data[index + 2]) * gain,
    );
    delta.data[index + 3] = 255;
  }
  return PNG.sync.write(delta);
}

export function makePanStrip(
  frames,
  lightNames,
  scale = 4,
  radius = STRIP_RADIUS,
) {
  const cropSize = radius * 2 + 1;
  const strip = new PNG({
    width: frames.length * cropSize * scale,
    height: lightNames.length * cropSize * scale,
  });
  for (let column = 0; column < frames.length; column++) {
    const png = PNG.sync.read(frames[column].image);
    for (let row = 0; row < lightNames.length; row++) {
      const light = frames[column].lights.find(
        (candidate) => candidate.name === lightNames[row],
      );
      const cx = Math.round(light.x);
      const cy = Math.round(light.y);
      for (let sy = -radius; sy <= radius; sy++) {
        for (let sx = -radius; sx <= radius; sx++) {
          const source = ((cy + sy) * png.width + cx + sx) * 4;
          for (let oy = 0; oy < scale; oy++) {
            for (let ox = 0; ox < scale; ox++) {
              const dx = column * cropSize * scale
                + (sx + radius) * scale + ox;
              const dy = row * cropSize * scale
                + (sy + radius) * scale + oy;
              const target = (dy * strip.width + dx) * 4;
              png.data.copy(strip.data, target, source, source + 4);
            }
          }
        }
      }
    }
  }
  return PNG.sync.write(strip);
}
