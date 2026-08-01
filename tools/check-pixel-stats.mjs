// tools/lib/pixel-stats.mjs 자체의 순수 계약 (#38).
//
// 픽셀 통계는 다른 게이트가 결론을 세우는 바닥이므로, 그 바닥이 "해석적으로 답을 아는 그림"에서
// 정확히 그 답을 내놓는지부터 못박는다. 모든 픽스처는 코드로 합성해 인코드→디코드 왕복시킨다 —
// 왕복 자체가 첫 단언이고, 통계는 손으로 계산 가능한 값과 비교한다.
//
// 판정 임계는 여기에 없다(임계는 각 룩 게이트가 소유한다). 여기서 재는 것은 산술의 정확성뿐이다.
import assert from 'node:assert/strict';
import {
  ROSE_BAND, GREEN_BAND,
  band, cropScaled, decodePng, diffStats, encodePng, encodePngWithFilters, hueHistogram, hueStats,
  luma709, luminanceField, localStd, patchSample, pixelAt, relLum, resolveRegion,
  rgbToHsv, rowProfile, smoothPlane, srgbToLinear, terciles,
} from './lib/pixel-stats.mjs';

let checks = 0;
const near = (actual, expected, tol, label) => {
  checks++;
  assert.ok(Number.isFinite(actual), `${label}: not finite (${actual})`);
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${label}: ${actual} vs expected ${expected} (tol ${tol})`,
  );
};
const eq = (actual, expected, label) => { checks++; assert.equal(actual, expected, label); };
const ok = (value, label) => { checks++; assert.ok(value, label); };

// 합성 픽스처 — (x, y) → [r, g, b] 함수로 만든다.
function synth(width, height, channels, fn) {
  const data = new Uint8Array(width * height * channels);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = fn(x, y);
      const i = (y * width + x) * channels;
      data[i] = r; data[i + 1] = g; data[i + 2] = b;
      if (channels === 4) data[i + 3] = 255;
    }
  }
  return { width, height, channels, data };
}

// 인코드→디코드 왕복만 통과한 이미지를 통계에 넘긴다. 디코더가 틀리면 아래 단언 전부가 흔들린다.
function roundTrip(image) {
  const decoded = decodePng(encodePng(image));
  eq(decoded.width, image.width, 'roundTrip width');
  eq(decoded.height, image.height, 'roundTrip height');
  eq(decoded.channels, image.channels, 'roundTrip channels');
  eq(Buffer.compare(Buffer.from(decoded.data), Buffer.from(image.data)), 0, 'roundTrip bytes');
  return decoded;
}

// ---------------------------------------------------------------------------
// 1. PNG 왕복 — RGB / RGBA, 그리고 필터가 붙는 실제 압축 경로
// ---------------------------------------------------------------------------
{
  // 그라디언트: 인접 화소가 전부 다르므로 필터·압축 경로가 자명하게 무너지면 드러난다.
  const grad = synth(37, 23, 3, (x, y) => [(x * 7) & 255, (y * 11) & 255, (x * y) & 255]);
  roundTrip(grad);
  const rgba = synth(16, 9, 4, (x, y) => [x * 16, y * 28, 255 - x * 16]);
  roundTrip(rgba);
  // 단색 대영역(RLE 가 강하게 걸리는 경로)도 같은 바이트로 돌아온다.
  roundTrip(synth(64, 64, 3, () => [17, 200, 90]));

  assert.throws(() => decodePng(Buffer.alloc(64)), /not a png/, 'decodePng rejects non-png');
  checks++;

  // 실제 캡처 PNG 는 스캔라인마다 다른 필터를 고른다. 필터 0 픽스처만 쓰면 Sub/Up/Average/Paeth
  //   분기가 한 번도 실행되지 않아 그 분기가 깨져도 게이트가 녹색으로 남는다(2026-08-01 FAIL-first
  //   에서 실제로 Paeth 를 망가뜨려도 통과했다). 다섯 필터를 순환시켜 전부 덮는다.
  const mixed = synth(29, 25, 3, (x, y) => [(x * 9 + y) & 255, (y * 13) & 255, (x ^ y) & 255]);
  const filtered = decodePng(encodePngWithFilters(mixed, (y) => y % 5));
  eq(Buffer.compare(Buffer.from(filtered.data), Buffer.from(mixed.data)), 0,
    'decodePng reproduces every scanline filter (0..4)');
  const filteredRgba = decodePng(encodePngWithFilters(
    synth(17, 11, 4, (x, y) => [(x * 5) & 255, (y * 23) & 255, (x + y * 3) & 255]), (y) => 4,
  ));
  eq(filteredRgba.channels, 4, 'paeth-filtered RGBA channels');
  eq(filteredRgba.data[0], 0, 'paeth-filtered RGBA first pixel');
}

// ---------------------------------------------------------------------------
// 2. 색 변환 — 알려진 삼원색과 흑백
// ---------------------------------------------------------------------------
{
  const c = rgbToHsv(204, 102, 51);           // 순수 hue 20도, s = 153/204 = 0.75
  near(c.h, 20, 1e-9, 'rgbToHsv hue');
  near(c.s, 0.75, 1e-9, 'rgbToHsv sat');
  near(c.v, 0.8, 1e-9, 'rgbToHsv value');
  near(rgbToHsv(0, 0, 0).s, 0, 1e-12, 'rgbToHsv black sat');
  near(rgbToHsv(0, 255, 0).h, 120, 1e-9, 'rgbToHsv green hue');
  near(rgbToHsv(0, 0, 255).h, 240, 1e-9, 'rgbToHsv blue hue');
  // hue 는 음수로 계산된 뒤 한 바퀴 감긴다(mx = r, g < b). 이 경우가 없으면 감기를 지워도
  //   게이트가 통과한다 — 그리고 hue 330 대는 곧 rose 대역이라 워시 진단의 핵심 구간이다.
  near(rgbToHsv(255, 0, 128).h, 360 - 60 * (128 / 255), 1e-9, 'rgbToHsv wraps a negative hue');
  ok(ROSE_BAND(rgbToHsv(255, 0, 128).h), 'the wrapped hue lands in the rose band');
  near(relLum(255, 255, 255), 1, 1e-12, 'relLum white');
  near(relLum(0, 0, 0), 0, 1e-12, 'relLum black');
  // 흑백 끝점은 선형/감마 어느 쪽으로 계산해도 같으므로 중간 회색이 실제 판별점이다.
  near(srgbToLinear(128), 0.215861, 1e-6, 'srgbToLinear at mid grey');
  near(relLum(128, 128, 128), 0.215861, 1e-6, 'relLum decodes sRGB before weighting');
  near(luma709(255, 255, 255), 255, 1e-9, 'luma709 white');
  near(luma709(128, 128, 128), 128, 1e-9, 'luma709 stays in gamma space');
  ok(ROSE_BAND(354) && ROSE_BAND(15) && !ROSE_BAND(120), 'ROSE_BAND covers 320..30');
  ok(GREEN_BAND(120) && !GREEN_BAND(200), 'GREEN_BAND covers 60..180');
}

// ---------------------------------------------------------------------------
// 3. 영역 해석 — 픽셀 사각형과 비율 밴드
// ---------------------------------------------------------------------------
{
  const img = synth(200, 100, 3, () => [1, 2, 3]);
  const full = resolveRegion(img);
  eq(`${full.x0},${full.y0},${full.x1},${full.y1}`, '0,0,199,99', 'resolveRegion default');
  const lower = resolveRegion(img, band(0.5, 1.0));
  eq(`${lower.y0},${lower.y1}`, '50,99', 'resolveRegion yFrac band');
  eq(lower.height, 50, 'resolveRegion band height');
  const clamped = resolveRegion(img, { x0: -40, y0: -5, x1: 9999, y1: 9999 });
  eq(`${clamped.x0},${clamped.y0},${clamped.x1},${clamped.y1}`, '0,0,199,99', 'resolveRegion clamps');
  eq(pixelAt(img, 3, 4).join(','), '1,2,3', 'pixelAt');
}

// ---------------------------------------------------------------------------
// 4. hue 히스토그램 — 단색·이색·무채색·저휘도 게이트
// ---------------------------------------------------------------------------
{
  // 단색 rose(hue 20): 전 화소 유채색, rose 점유 100%, peak60 100%.
  const rose = roundTrip(synth(40, 40, 3, () => [204, 102, 51]));
  const h1 = hueHistogram(rose);
  eq(h1.chromatic, h1.total, 'solid rose: every sample chromatic');
  near(h1.roseShare, 1, 1e-12, 'solid rose roseShare');
  near(h1.greenShare, 0, 1e-12, 'solid rose greenShare');
  near(h1.peak60, 1, 1e-12, 'solid rose peak60');
  near(h1.meanSat, 0.75, 1e-12, 'solid rose meanSat');
  eq(h1.bins.length, 12, 'default 30-degree bins');
  eq(h1.bins[0], h1.chromatic, 'hue 20 lands in bin 0');

  // 좌우 반반 rose/green: 각 점유 50%, peak60 은 한쪽 60도 창의 50%.
  const half = roundTrip(synth(40, 40, 3, (x) => (x < 20 ? [204, 102, 51] : [51, 204, 102])));
  const h2 = hueHistogram(half);
  near(h2.roseShare, 0.5, 1e-12, 'half/half roseShare');
  near(h2.greenShare, 0.5, 1e-12, 'half/half greenShare');
  near(h2.peak60, 0.5, 1e-12, 'half/half peak60');

  // peak60 은 인접 두 빈(60도 창)의 합이다. 두 색이 서로 다른 빈이면서 인접할 때만 한 빈짜리
  //   구현과 갈라진다 — hue 20(빈 0)과 hue 40(빈 1)이 반반이면 60도 창은 전부를 담는다.
  const adjacent = roundTrip(synth(40, 40, 3, (x) => (x < 20 ? [204, 102, 51] : [204, 153, 51])));
  const h4 = hueHistogram(adjacent);
  eq(h4.bins[0], h4.chromatic / 2, 'hue 20 fills bin 0');
  eq(h4.bins[1], h4.chromatic / 2, 'hue 40 fills bin 1');
  near(h4.peak60, 1, 1e-12, 'peak60 sums two adjacent bins, not one');

  // 무채색은 유채색 표본이 0 이라 점유율이 0 으로 떨어진다(0 나눗셈 방어 포함).
  const grey = roundTrip(synth(20, 20, 3, () => [128, 128, 128]));
  const h3 = hueHistogram(grey);
  eq(h3.chromatic, 0, 'grey has no chromatic samples');
  near(h3.roseShare, 0, 1e-12, 'grey roseShare guard');
  near(h3.peak60, 0, 1e-12, 'grey peak60 guard');

  // 채도는 높지만 거의 검은 화소는 minValue 가 걸러낸다(v = 12/255 = 0.047 < 0.06).
  const nearBlack = roundTrip(synth(20, 20, 3, () => [12, 3, 3]));
  eq(hueHistogram(nearBlack).chromatic, 0, 'minValue gate drops near-black chroma');
  ok(hueHistogram(nearBlack, { minValue: 0 }).chromatic > 0, 'minValue is the reason, not sat');
}

// ---------------------------------------------------------------------------
// 5. 원형 hue 통계 — 산포가 해석값과 일치하는가
// ---------------------------------------------------------------------------
{
  // 같은 채도의 hue 0 과 hue 90 이 반반이면 원형 평균은 45도, R = cos(45도),
  //   spread = sqrt(-2 ln R) 라디안 = 47.75도.
  const two = roundTrip(synth(40, 40, 3, (x) => (x < 20 ? [255, 0, 0] : [128, 255, 0])));
  const s = hueStats(two);
  near(s.meanHue, 45, 0.6, 'two-hue circular mean');
  near(s.R, Math.cos(Math.PI / 4), 0.01, 'two-hue resultant length');
  const expectedSpread = Math.sqrt(-2 * Math.log(Math.cos(Math.PI / 4))) * 180 / Math.PI;
  near(s.spreadDeg, expectedSpread, 0.6, 'two-hue circular spread (deg)');
  near(expectedSpread, 47.7, 0.2, 'spread formula anchor');

  // 한 색으로 뭉치면 산포는 0 이다 — "프레임이 한 색 워시인가"의 극한.
  const one = roundTrip(synth(20, 20, 3, () => [204, 102, 51]));
  // R 은 부동소수 누적으로 1 을 아주 조금 밑돌 수 있고, sqrt(-2 ln R) 이 그 오차를 확대한다.
  near(hueStats(one).spreadDeg, 0, 1e-3, 'single-hue spread is zero');
  near(hueStats(one).meanHue, 20, 1e-6, 'single-hue mean');

  // 채도가중과 무가중은 다른 축이다: 채도 높은 쪽으로 평균이 끌린다.
  const weighted = roundTrip(synth(40, 40, 3, (x) => (x < 20 ? [255, 0, 0] : [255, 191, 128])));
  const sw = hueStats(weighted, { weight: 'sat' });
  const su = hueStats(weighted, { weight: 'none' });
  ok(sw.meanHue < su.meanHue, 'sat weighting pulls the mean toward the saturated hue');
  eq(hueStats(roundTrip(synth(8, 8, 3, () => [10, 10, 10]))).count, 0, 'hueStats empty guard');
}

// ---------------------------------------------------------------------------
// 6. 명도 3분위 — 정렬 축과 분위별 채도
// ---------------------------------------------------------------------------
{
  // 위 1/3 은 어두운 고채도, 가운데는 중간 저채도, 아래 1/3 은 밝은 중채도.
  const img = roundTrip(synth(30, 30, 3, (x, y) => {
    if (y < 10) return [60, 12, 12];      // dark, s = 0.8
    if (y < 20) return [140, 126, 126];   // mid,  s = 0.1
    return [240, 168, 168];               // bright, s = 0.3
  }));
  const t = terciles(img);
  near(t.dark.sat, 0.8, 1e-9, 'dark tercile saturation');
  near(t.mid.sat, 0.1, 1e-9, 'mid tercile saturation');
  near(t.bright.sat, 0.3, 1e-9, 'bright tercile saturation');
  ok(t.dark.lum < t.mid.lum && t.mid.lum < t.bright.lum, 'terciles ordered by linear luminance');
  near(t.dark.hue, 0, 1e-6, 'dark tercile hue');

  // 정렬 축은 선형 상대휘도이지 HSV value 가 아니다. 두 축이 어긋나는 그림이 없으면 축을 바꿔도
  //   게이트가 통과한다(2026-08-01 FAIL-first 에서 살아남은 변이). 포화 파랑은 value 1.0 로
  //   가장 밝지만 상대휘도는 0.072 로 가장 어둡다 — 계약이 말하는 "암부"는 후자다.
  const blueTrap = roundTrip(synth(30, 30, 3, (x, y) => {
    if (y < 10) return [0, 0, 255];      // value 1.000 · relLum 0.072 → 실제 암부
    if (y < 20) return [90, 90, 90];     // value 0.353 · relLum 0.098
    return [200, 200, 200];              // value 0.784 · relLum 0.579
  }));
  const bt = terciles(blueTrap);
  near(bt.dark.sat, 1, 1e-9, 'saturated blue is the dark tercile by linear luminance');
  near(bt.dark.hue, 240, 1e-6, 'dark tercile hue is blue, not the HSV-brightest');
  near(bt.bright.sat, 0, 1e-9, 'bright tercile is the light neutral');
}

// ---------------------------------------------------------------------------
// 7. 행 프로파일 · 국소 대비
// ---------------------------------------------------------------------------
{
  // 행마다 정확히 1 씩 오르는 회색 램프: 행 평균은 그 값과 같아야 한다.
  const ramp = roundTrip(synth(60, 100, 3, (x, y) => {
    const v = 10 + y;
    return [v, v, v];
  }));
  const p = rowProfile(ramp);
  near(p.rowMean[0], 10, 1e-4, 'rowMean at first row');
  near(p.rowMean[99], 109, 1e-4, 'rowMean at last row');
  near(p.rowMean[50], 60, 1e-4, 'rowMean mid');
  // 램프의 국소 3x3 표준편차는 세 행(v-1, v, v+1)의 표준편차 = sqrt(2/3).
  near(localStd(luminanceField(ramp), 60, 100, 30, 50), Math.sqrt(2 / 3), 1e-4, 'localStd on a 1/row ramp');
  near(localStd(luminanceField(roundTrip(synth(20, 20, 3, () => [90, 90, 90]))), 20, 20, 10, 10),
    0, 1e-9, 'localStd on a flat field');

  // 열 표본 간격은 원본 스크립트가 쓴 3 이다. x 로 변하는 그림에서만 그 값이 드러난다 —
  //   colStep 1 은 진짜 행 평균(29.5), 기본 3 은 x=0,3,…,57 의 20 표본 평균(28.5)이다.
  const xRamp = roundTrip(synth(60, 20, 3, (x) => [x, x, x]));
  near(rowProfile(xRamp, { colStep: 1 }).rowMean[10], 29.5, 1e-4, 'rowProfile colStep 1 is the true row mean');
  near(rowProfile(xRamp).rowMean[10], 28.5, 1e-4, 'rowProfile default column step is 3');
}

// ---------------------------------------------------------------------------
// 8. 평활 평면 검출 — 구배 있는 램프 vs 무구배 평면 + 하단 하드 스텝
// ---------------------------------------------------------------------------
{
  // (a) 램프: 상반부 50행 전부 평활(std 0.816 < 1.2)이라 평면 길이 50,
  //     구배는 (59 - 10) / 50 * 100 = 98/100행, 아래로는 -5 (계속 밝아지므로 음수).
  const ramp = roundTrip(synth(60, 100, 3, (x, y) => { const v = 10 + y; return [v, v, v]; }));
  const a = smoothPlane(rowProfile(ramp));
  ok(a.found, 'ramp: plane found');
  eq(a.start, 0, 'ramp plane start');
  eq(a.len, 50, 'ramp plane length');
  near(a.per100Rows, 98, 1e-3, 'ramp gradient per 100 rows');
  near(a.stepBelow, -5, 1e-3, 'ramp has no downward step below the plane');

  // (b) 무구배 밝은 평면 + 하드 스텝: 구배 0, 스텝 140. 룩 라운드가 잡아낸 결함 형태다.
  //     평면은 48행까지다 — 49행의 3x3 표본이 이미 아래 스텝(60)을 물어 대비가 튄다.
  const flat = roundTrip(synth(60, 100, 3, (x, y) => {
    const v = y < 50 ? 200 : 60;
    return [v, v, v];
  }));
  const b = smoothPlane(rowProfile(flat));
  ok(b.found, 'flat: plane found');
  eq(b.start, 0, 'flat plane start');
  eq(b.len, 49, 'flat plane length stops one row before the step');
  near(b.per100Rows, 0, 1e-9, 'flat plane has zero gradient');
  near(b.stepBelow, 140, 1e-3, 'hard step below the flat plane');

  // (c) 잡음 프레임에는 평활 평면이 없다 — found=false 경로.
  let seed = 1;
  const noise = roundTrip(synth(60, 100, 3, () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const v = 40 + (seed % 180);
    return [v, v, v];
  }));
  eq(smoothPlane(rowProfile(noise)).found, false, 'noise: no smooth plane');
}

// ---------------------------------------------------------------------------
// 9. 차분 통계 — 변화 화소 비율·채널 편향·최댓값 위치
// ---------------------------------------------------------------------------
{
  const base = roundTrip(synth(100, 100, 3, () => [100, 100, 100]));
  // 20x10 = 200 화소만 red +30. 전체 10000 화소 중 2%.
  const shifted = roundTrip(synth(100, 100, 3, (x, y) => (
    x >= 10 && x < 30 && y >= 40 && y < 50 ? [130, 100, 100] : [100, 100, 100]
  )));
  const d = diffStats(base, shifted);
  eq(d.examined, 10000, 'diffStats examined');
  eq(d.changed, 200, 'diffStats changed pixel count');
  near(d.changedRatio, 0.02, 1e-12, 'diffStats changed ratio');
  near(d.meanAbs, 30 * 200 / 10000, 1e-9, 'diffStats mean absolute delta');
  near(d.maxAbs, 30, 1e-9, 'diffStats max absolute delta');
  eq(d.maxAt.join(','), '10,40', 'diffStats max location');
  near(d.channelMeanDelta[0], 30 * 200 / 10000, 1e-9, 'diffStats red channel bias');
  near(d.channelMeanDelta[1], 0, 1e-12, 'diffStats green channel unchanged');
  near(d.meanLumaDelta, 0.2126 * 30 * 200 / 10000, 1e-9, 'diffStats mean luma delta');
  near(d.maxLumaGain, 0.2126 * 30, 1e-9, 'diffStats max luma gain');
  near(d.maxLumaDrop, 0, 1e-12, 'diffStats max luma drop');
  eq(d.identical, false, 'diffStats identical=false when pixels moved');

  // 같은 이미지끼리는 identical, 임계 아래 변화는 changed 에 안 들어간다.
  const same = diffStats(base, base);
  eq(same.identical, true, 'diffStats identical=true for the same frame');
  eq(same.changed, 0, 'diffStats no changed pixels for the same frame');
  const tiny = roundTrip(synth(100, 100, 3, () => [103, 100, 100]));  // 합 3 < 임계 12
  eq(diffStats(base, tiny).changed, 0, 'sub-threshold change is not counted');
  eq(diffStats(base, tiny).identical, false, 'sub-threshold change is still not identical');
  near(diffStats(base, tiny, { threshold: 2 }).changedRatio, 1, 1e-12, 'threshold is the only gate');
  // 경계는 포함이다(png-metrics.countChangedPixels 의 정의를 승계). 정확히 임계인 프레임이 없으면
  //   `>` 로 바뀌어도 게이트가 통과한다 — 2026-08-01 FAIL-first 에서 실제로 살아남은 변이다.
  const atThreshold = roundTrip(synth(100, 100, 3, () => [104, 104, 104]));  // 합 12 == 임계
  eq(diffStats(base, atThreshold).changed, 10000, 'a delta exactly at the threshold counts as changed');

  // 영역 한정: 변화가 없는 밴드만 보면 changed 는 0 이다.
  eq(diffStats(base, shifted, { region: band(0.6, 1.0) }).changed, 0, 'region limits the diff');
  assert.throws(
    () => diffStats(base, synth(50, 50, 3, () => [0, 0, 0])),
    /size mismatch/, 'diffStats rejects mismatched sizes',
  );
  checks++;
}

// ---------------------------------------------------------------------------
// 10. 패치 표본 · 확대 크롭
// ---------------------------------------------------------------------------
{
  // x 축 램프에서 5x5 패치 평균은 중심 x 값과 같다(대칭이므로).
  const img = roundTrip(synth(60, 60, 3, (x) => [x, 200 - x, 30]));
  const s = patchSample(img, 20, 30, 5);
  eq(s.count, 25, 'patchSample sample count');
  near(s.rgb[0], 20, 1e-9, 'patchSample mean red equals ramp centre');
  near(s.rgb[1], 180, 1e-9, 'patchSample mean green');
  near(s.greenMinusRed, 160, 1e-9, 'patchSample G-R');
  near(s.luma, luma709(20, 180, 30), 1e-9, 'patchSample luma');
  // 경계에서는 프레임 안으로 잘린다(밖을 읽지 않는다).
  eq(patchSample(img, 0, 0, 5).count, 9, 'patchSample clips at the frame corner');

  const crop = cropScaled(img, { cx: 30, cy: 30, width: 8, height: 6, scale: 3 });
  eq(`${crop.width}x${crop.height}`, '24x18', 'cropScaled output size');
  eq(crop.channels, 4, 'cropScaled emits RGBA');
  eq(crop.origin.join(','), '26,27', 'cropScaled origin');
  // 최근접 확대이므로 3x3 블록 안은 전부 같은 원본 화소다.
  const at = (x, y) => pixelAt(crop, x, y).join(',');
  eq(at(0, 0), at(2, 2), 'cropScaled block is nearest-neighbour');
  eq(at(0, 0), pixelAt(img, 26, 27).join(','), 'cropScaled samples the source pixel');
  eq(at(3, 0), pixelAt(img, 27, 27).join(','), 'cropScaled advances one source pixel per block');
  roundTrip(crop);   // 크롭도 그대로 저장 가능해야 한다(비전 에이전트 전달용).
  // 프레임 밖을 요구해도 안쪽으로 물린다.
  eq(cropScaled(img, { cx: 0, cy: 0, width: 10, height: 10, scale: 1 }).origin.join(','), '0,0',
    'cropScaled clamps to the frame');
}

console.log(`check-pixel-stats: ${checks} assertions PASS`);
