import { PNG } from 'pngjs';

// Prove that a semantic layer contributes to the rendered canvas instead of
// merely projecting inside the camera frustum.
export function countChangedPixels(firstBuffer, secondBuffer, threshold = 12) {
  const first = PNG.sync.read(firstBuffer);
  const second = PNG.sync.read(secondBuffer);
  if (first.width !== second.width || first.height !== second.height) return -1;

  let changed = 0;
  for (let index = 0; index < first.data.length; index += 4) {
    const delta = Math.abs(first.data[index] - second.data[index])
      + Math.abs(first.data[index + 1] - second.data[index + 1])
      + Math.abs(first.data[index + 2] - second.data[index + 2]);
    if (delta >= threshold) changed++;
  }
  return changed;
}

// ---------------------------------------------------------------------------
// Edge staircase quantification (AA regression axis).
//
// An aliased oblique edge resolves a coverage boundary into exactly one pixel
// row/column per step: the neighbour difference across it is the *full* contrast
// of the two surfaces, and there is no intermediate value. Multisampling turns
// that single hard step into two or three partial-coverage steps of smaller
// magnitude. So the discriminating quantity is not "how much edge energy" (that
// is nearly conserved) but *how the same energy is distributed across step
// magnitudes*.
//
// Measured on adjacent-pixel luminance differences inside a fixed region:
//   hard  = pairs with |dL| >= hardThreshold      (full-contrast jumps = staircase)
//   soft  = pairs with softThreshold <= |dL| < hardThreshold  (partial coverage)
//   softRatio = soft / hard
//
// Rejected alternatives and why:
//  - Pixel hash / changed-pixel count: says "something changed", never "the
//    staircase got shorter", and water glint alone makes it nondeterministic.
//  - Total gradient magnitude: MSAA roughly conserves it, so the axis is flat.
//  - FFT high-frequency ratio: bloom haze and DoF dominate the spectrum, and
//    the number moves with time-of-day rather than with AA.
//  - Per-column edge-thickness fitting: only valid where exactly one edge
//    crosses each column, which no real village frame satisfies.
export function edgeStepProfile(buffer, {
  x0 = 0, y0 = 0, x1 = Infinity, y1 = Infinity,
  hardThreshold = 40, softThreshold = 8,
} = {}) {
  const png = PNG.sync.read(buffer);
  const { width, height, data } = png;
  const left = Math.max(0, Math.floor(x0));
  const top = Math.max(0, Math.floor(y0));
  const right = Math.min(width - 1, Math.floor(x1));
  const bottom = Math.min(height - 1, Math.floor(y1));
  const lum = (x, y) => {
    const i = (y * width + x) * 4;
    return 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
  };
  let pairs = 0, hard = 0, soft = 0, energy = 0;
  for (let y = top; y <= bottom; y++) {
    for (let x = left; x <= right; x++) {
      for (const [dx, dy] of [[1, 0], [0, 1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx > right || ny > bottom) continue;
        const d = Math.abs(lum(x, y) - lum(nx, ny));
        pairs++;
        energy += d;
        if (d >= hardThreshold) hard++;
        else if (d >= softThreshold) soft++;
      }
    }
  }
  return {
    width, height, pairs, hard, soft, energy,
    hardDensity: pairs ? hard / pairs : 0,
    softDensity: pairs ? soft / pairs : 0,
    softRatio: hard ? soft / hard : Infinity,
    meanGradient: pairs ? energy / pairs : 0,
  };
}

// 선 화소 조건부 계단성 — 기하 에지 판정용 축. 정의를 한 곳에 두어 여러 하네스의 수치가
// 직접 비교 가능하게 한다.
//
//   lineMask : 3x3 휘도 레인지 > lineThreshold (선 또는 강한 톤 경계)
//   grad     : 4근방 최대 절대차 — AA 된 선은 2~3px 램프(작은 grad), 계단 선은 1px 절벽(큰 grad)
//   cliffRatio / rampRatio 는 **선 화소 수로 정규화**하므로, 프레임의 에지 총량이 변해도
//   "선 하나가 얼마나 절벽인가"를 본다.
//
// 왜 edgeStepProfile 과 둘 다 두는가(실측 근거):
//   부감 게이트 프레임에서 분리 폭은 edgeStepProfile 이 압도적이다
//   (hardDensity −37.7% / softRatio +86% vs cliffRatio −8.0%). 반면 근접 DoF 프레임에서는
//   두 축 모두 방향이 뒤집힌다(cliffRatio 39.8→42.0%) — 선 화소 정규화로도 상쇄되지 않는데,
//   MSAA 가 놓치던 서브픽셀 기와 하이라이트를 복원해 lineMask 자체가 커지기 때문이다
//   (line 13.73→14.21%). **세 장면에서 유일하게 부호를 지키는 축은 선 화소 조건부 meanGrad**
//   (49.7→47.3 / 63.0→60.5 / 67.3→62.0)이므로, 그 축을 근접 프레임까지 통하는 보조축으로 쓴다.
export function lineEdgeProfile(buffer, {
  x0 = 0, y0 = 0, x1 = Infinity, y1 = Infinity,
  lineThreshold = 25, cliffThreshold = 60, rampThreshold = 12,
} = {}) {
  const png = PNG.sync.read(buffer);
  const { width, height, data } = png;
  const left = Math.max(2, Math.floor(x0));
  const top = Math.max(2, Math.floor(y0));
  const right = Math.min(width - 3, Math.floor(x1));
  const bottom = Math.min(height - 3, Math.floor(y1));
  // Rec.601 휘도(축 정의 일치가 목적).
  const lum = (x, y) => {
    const i = (y * width + x) * 4;
    return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  };
  let total = 0, lines = 0, gradSum = 0, cliff = 0, ramp = 0;
  for (let y = top; y <= bottom; y++) {
    for (let x = left; x <= right; x++) {
      total++;
      let lo = Infinity, hi = -Infinity;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const v = lum(x + dx, y + dy);
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }
      if (hi - lo <= lineThreshold) continue;
      lines++;
      const c = lum(x, y);
      const g = Math.max(
        Math.abs(lum(x - 1, y) - c), Math.abs(lum(x + 1, y) - c),
        Math.abs(lum(x, y - 1) - c), Math.abs(lum(x, y + 1) - c),
      );
      gradSum += g;
      if (g > cliffThreshold) cliff++;
      else if (g > rampThreshold) ramp++;
    }
  }
  return {
    total, lines,
    lineRatio: total ? lines / total : 0,
    lineMeanGradient: lines ? gradSum / lines : 0,
    cliffRatio: lines ? cliff / lines : 0,
    rampRatio: lines ? ramp / lines : 0,
  };
}

// 고립된 1픽셀 밝은 점(스펙클) 계수. DoF 판정문 항목 3 의 "렌즈 먼지처럼 읽히는 흰 점 밀집
// 필드"를 직접 측정한다. 4-이웃 최댓값보다 minDelta 이상 밝고 자체 휘도가 minLum 이상인
// 픽셀만 센다 — 즉 이웃과 연결되지 않은 서브픽셀 하이라이트다. 연속된 밝은 에지·창호 면은
// 이웃도 밝으므로 걸리지 않는다.
export function isolatedBrightSpecks(buffer, {
  x0 = 0, y0 = 0, x1 = Infinity, y1 = Infinity,
  minLum = 140, minDelta = 24,
} = {}) {
  const png = PNG.sync.read(buffer);
  const { width, height, data } = png;
  const left = Math.max(1, Math.floor(x0));
  const top = Math.max(1, Math.floor(y0));
  const right = Math.min(width - 2, Math.floor(x1));
  const bottom = Math.min(height - 2, Math.floor(y1));
  const lum = (x, y) => {
    const i = (y * width + x) * 4;
    return 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
  };
  let specks = 0, examined = 0, peakDelta = 0;
  for (let y = top; y <= bottom; y++) {
    for (let x = left; x <= right; x++) {
      examined++;
      const c = lum(x, y);
      if (c < minLum) continue;
      const around = Math.max(lum(x - 1, y), lum(x + 1, y), lum(x, y - 1), lum(x, y + 1));
      const delta = c - around;
      if (delta >= minDelta) { specks++; if (delta > peakDelta) peakDelta = delta; }
    }
  }
  return { specks, examined, density: examined ? specks / examined : 0, peakDelta };
}
