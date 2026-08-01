// 순수 노드 PNG 픽셀 통계 — 룩 라운드가 매번 재제작하던 스크래치 분석의 공용 이관본 (#38).
//
// 의존성은 node 내장 zlib 하나다. 브라우저·GL·pngjs 없이 캡처된 PNG 를 그대로 읽어
// "무엇이 얼마나 달라졌는가"를 수치로 말하기 위한 도구이며, 판정 임계는 각 게이트가 소유한다
// (이 파일은 임계를 갖지 않는다).
//
// 산술 출처 — 전부 2026-08-01 룩 라운드에서 실제로 쓰여 결론을 낸 스크래치 코드다.
// 새 수식을 발명하지 않고 그대로 옮겼으며, 각 함수 주석에 원본을 적었다.
//   scratchpad/look-diag/png.mjs      디코더·rgbToHsv·srgbToLinear·relLum
//   scratchpad/look-diag/1-wash.mjs   hue 히스토그램·rose/green 점유·peak60·명도 3분위 밴드
//   scratchpad/look-diag/5-fogband.mjs  행 프로파일·평활 평면 검출·국소 3x3 표준편차
//   scratchpad/fog-round/analyze.mjs  평면 구배(/100행)·하단 하드 스텝
//   scratchpad/fog-round/bands.mjs    원형 hue 산포(hueSpread)
//   scratchpad/vis-facet.mjs          패싯 nxn 패치 표본
//   scratchpad/vis-crop.mjs           확대 크롭·차분 최댓값 위치
//   tools/lib/png-metrics.mjs         변화 픽셀 계수의 정의(임계 합산)를 diffStats 가 승계
//
// 자체 계약: tools/check-pixel-stats.mjs (합성 픽스처 인코드→디코드 왕복 단언).
import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync, inflateSync } from 'node:zlib';

// ---------------------------------------------------------------------------
// PNG 디코드 / 인코드
// ---------------------------------------------------------------------------

/**
 * 8bit·non-interlaced·colour type 2(RGB)/6(RGBA) PNG 디코더.
 * 출처: scratchpad/look-diag/png.mjs `readPng` (2026-08-01 워시 진단에서 검증됨).
 * @returns {{width:number,height:number,channels:number,data:Uint8Array}}
 */
export function decodePng(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a png');
  let off = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (bitDepth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`unsupported png: depth ${bitDepth} type ${colorType} interlace ${interlace}`);
  }
  const channels = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(width * height * channels);
  let prev = new Uint8Array(stride);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    const line = raw.subarray(p, p + stride); p += stride;
    const cur = new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let v = line[i];
      switch (filter) {
        case 0: break;
        case 1: v = (v + a) & 255; break;
        case 2: v = (v + b) & 255; break;
        case 3: v = (v + ((a + b) >> 1)) & 255; break;
        case 4: {
          const pp = a + b - c;
          const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
          v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
          break;
        }
        default: throw new Error(`bad png filter ${filter}`);
      }
      cur[i] = v;
    }
    out.set(cur, y * stride);
    prev = cur;
  }
  return { width, height, channels, data: out };
}

/** 파일 경로에서 바로 디코드. */
export function readPng(path) {
  return decodePng(readFileSync(path));
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, body) {
  const out = Buffer.alloc(body.length + 12);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, 'ascii');
  body.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
  return out;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/**
 * 행마다 필터 타입을 지정해 인코드한다.
 * 실제 캡처 PNG 는 다섯 가지 스캔라인 필터를 섞어 쓰므로 decodePng 의 다섯 분기를 전부 덮으려면
 * 그런 픽스처를 만들 수 있어야 한다 — check-pixel-stats 가 이 함수로 필터별 픽스처를 합성한다.
 * 일반 저장은 encodePng(필터 0)을 쓴다.
 */
export function encodePngWithFilters({ width, height, channels, data }, filterFor = () => 0) {
  if (channels !== 3 && channels !== 4) throw new Error(`encodePng: channels ${channels}`);
  if (data.length !== width * height * channels) throw new Error('encodePng: data length mismatch');
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const filter = filterFor(y) | 0;
    if (filter < 0 || filter > 4) throw new Error(`encodePng: bad filter ${filter}`);
    const base = y * (stride + 1);
    raw[base] = filter;
    for (let i = 0; i < stride; i++) {
      const cur = data[y * stride + i];
      const a = i >= channels ? data[y * stride + i - channels] : 0;
      const b = y > 0 ? data[(y - 1) * stride + i] : 0;
      const c = y > 0 && i >= channels ? data[(y - 1) * stride + i - channels] : 0;
      let v;
      switch (filter) {
        case 1: v = cur - a; break;
        case 2: v = cur - b; break;
        case 3: v = cur - ((a + b) >> 1); break;
        case 4: v = cur - paeth(a, b, c); break;
        default: v = cur;
      }
      raw[base + 1 + i] = v & 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = channels === 4 ? 6 : 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * 최소 PNG 라이터(필터 0 고정). 합성 픽스처 생성과 크롭 저장용이며 압축률은 목적이 아니다.
 * decodePng 의 역함수여야 하고, 그 왕복이 check-pixel-stats 의 첫 단언이다.
 */
export function encodePng(image) {
  return encodePngWithFilters(image, () => 0);
}

export function writePng(path, image) {
  writeFileSync(path, encodePng(image));
  return path;
}

// ---------------------------------------------------------------------------
// 색 변환 — 출처: scratchpad/look-diag/png.mjs
// ---------------------------------------------------------------------------

/** sRGB 바이트 → {h(도), s(HSV), v(0..1)}. */
export function rgbToHsv(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d !== 0) {
    if (mx === r) h = 60 * (((g - b) / d) % 6);
    else if (mx === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  if (h < 0) h += 360;
  return { h, s: mx === 0 ? 0 : d / mx, v: mx / 255 };
}

export const srgbToLinear = (c) => {
  const x = c / 255;
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
};

/** 선형 상대 휘도(0..1). 감마 해제 후 Rec.709 가중. */
export const relLum = (r, g, b) =>
  0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);

/** 감마 공간 Rec.709 luma(0..255). 행 프로파일·차분은 이 축을 쓴다. */
export const luma709 = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

// ---------------------------------------------------------------------------
// 영역 선택
// ---------------------------------------------------------------------------

/**
 * 영역 서술자를 픽셀 사각형으로 정규화한다.
 * {x0,y0,x1,y1} 은 픽셀(끝 포함), {yFrac:[a,b]} / {xFrac:[a,b]} 는 프레임 비율이다.
 * 비율 밴드는 scratchpad/fog-round/bands.mjs 의 4밴드 분할이 쓰던 형태다.
 */
export function resolveRegion(image, region = {}) {
  const { width, height } = image;
  let x0 = 0, y0 = 0, x1 = width - 1, y1 = height - 1;
  if (Array.isArray(region.xFrac)) {
    x0 = Math.floor(width * region.xFrac[0]);
    x1 = Math.floor(width * region.xFrac[1]) - 1;
  }
  if (Array.isArray(region.yFrac)) {
    y0 = Math.floor(height * region.yFrac[0]);
    y1 = Math.floor(height * region.yFrac[1]) - 1;
  }
  if (Number.isFinite(region.x0)) x0 = Math.floor(region.x0);
  if (Number.isFinite(region.y0)) y0 = Math.floor(region.y0);
  if (Number.isFinite(region.x1)) x1 = Math.floor(region.x1);
  if (Number.isFinite(region.y1)) y1 = Math.floor(region.y1);
  x0 = Math.max(0, Math.min(width - 1, x0));
  y0 = Math.max(0, Math.min(height - 1, y0));
  x1 = Math.max(x0, Math.min(width - 1, x1));
  y1 = Math.max(y0, Math.min(height - 1, y1));
  return { x0, y0, x1, y1, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

/** 프레임 비율 밴드 서술자(bands.mjs 의 `sky/far plane` 등을 그대로 표현한다). */
export const band = (y0, y1) => ({ yFrac: [y0, y1] });

function pixelAt(image, x, y) {
  const i = (y * image.width + x) * image.channels;
  return [image.data[i], image.data[i + 1], image.data[i + 2]];
}

export { pixelAt };

// ---------------------------------------------------------------------------
// 색상 분포
// ---------------------------------------------------------------------------

/** hue 대역 술어 — 2026-08-01 워시 라운드가 고정한 정의. */
export const ROSE_BAND = (h) => h >= 320 || h < 30;
export const GREEN_BAND = (h) => h >= 60 && h < 180;

/**
 * 유채색 화소의 hue 히스토그램과 대역 점유.
 * 출처: scratchpad/look-diag/1-wash.mjs(30도 12빈·peak60) + scratchpad/fog-round/analyze.mjs
 *   (유채색 판정에 minValue 를 더한 개정판). 기본 임계는 후자다.
 *
 * peak60 = 인접 두 빈(60도 창)이 가진 유채색 화소 최대 비율 — "프레임이 한 색으로 뭉쳤는가".
 */
export function hueHistogram(image, {
  region, step = 2, binSize = 30, minSat = 0.12, minValue = 0.06,
} = {}) {
  const r = resolveRegion(image, region);
  const bins = new Array(Math.round(360 / binSize)).fill(0);
  let chromatic = 0, total = 0, satSum = 0;
  for (let y = r.y0; y <= r.y1; y += step) {
    for (let x = r.x0; x <= r.x1; x += step) {
      const [pr, pg, pb] = pixelAt(image, x, y);
      const { h, s, v } = rgbToHsv(pr, pg, pb);
      total++; satSum += s;
      if (s > minSat && v > minValue) {
        chromatic++;
        bins[Math.min(bins.length - 1, Math.floor(h / binSize))]++;
      }
    }
  }
  const shareOf = (pred) => bins.reduce(
    (acc, n, i) => acc + (pred(i * binSize + binSize / 2) ? n : 0), 0,
  ) / Math.max(1, chromatic);
  let peak = 0;
  for (let i = 0; i < bins.length; i++) peak = Math.max(peak, bins[i] + bins[(i + 1) % bins.length]);
  return {
    total, chromatic,
    chromaticShare: total ? chromatic / total : 0,
    meanSat: total ? satSum / total : 0,
    bins,
    roseShare: shareOf(ROSE_BAND),
    greenShare: shareOf(GREEN_BAND),
    peak60: peak / Math.max(1, chromatic),
  };
}

/**
 * 유채색 화소의 원형 hue 평균과 산포.
 * 출처: scratchpad/fog-round/bands.mjs — spread = sqrt(-2 ln R) (원형 표준편차, 도 단위).
 *   R 이 1 에 가까울수록(한 색으로 모임) spread → 0.
 * `weight: 'sat'` 은 scratchpad/look-diag/1-wash.mjs 의 채도가중 원형 평균이고,
 * `weight: 'none'` 은 bands.mjs 가 실제로 쓴 무가중이다. 기본은 채도가중.
 */
export function hueStats(image, {
  region, step = 2, minSat = 0.12, minValue = 0.06, weight = 'sat',
} = {}) {
  const r = resolveRegion(image, region);
  let sx = 0, sy = 0, ws = 0, n = 0;
  for (let y = r.y0; y <= r.y1; y += step) {
    for (let x = r.x0; x <= r.x1; x += step) {
      const [pr, pg, pb] = pixelAt(image, x, y);
      const { h, s, v } = rgbToHsv(pr, pg, pb);
      if (!(s > minSat && v > minValue)) continue;
      const w = weight === 'sat' ? s : 1;
      const a = h * Math.PI / 180;
      sx += Math.cos(a) * w; sy += Math.sin(a) * w; ws += w; n++;
    }
  }
  if (!n || ws <= 0) return { count: 0, meanHue: NaN, R: 1, spreadDeg: 0 };
  let meanHue = Math.atan2(sy, sx) * 180 / Math.PI;
  if (meanHue < 0) meanHue += 360;
  const R = Math.hypot(sx, sy) / ws;
  const spreadDeg = Math.sqrt(Math.max(0, -2 * Math.log(Math.min(1, R)))) * 180 / Math.PI;
  return { count: n, meanHue, R, spreadDeg };
}

/**
 * 명도 3분위 통계(암부/중간/명부). 계약 "그림자·중간톤은 중립, 온기는 하이라이트"를 재는 축이다.
 * 출처: scratchpad/look-diag/1-wash.mjs `band()` + scratchpad/fog-round/analyze.mjs `darkSat`.
 *   정렬 키는 선형 상대휘도(relLum), 각 분위의 hue 는 채도가중 원형 평균이다.
 */
export function terciles(image, { region, step = 2 } = {}) {
  const r = resolveRegion(image, region);
  const px = [];
  for (let y = r.y0; y <= r.y1; y += step) {
    for (let x = r.x0; x <= r.x1; x += step) {
      const [pr, pg, pb] = pixelAt(image, x, y);
      const { h, s, v } = rgbToHsv(pr, pg, pb);
      px.push({ h, s, v, l: relLum(pr, pg, pb) });
    }
  }
  px.sort((a, b) => a.l - b.l);
  const third = Math.max(1, Math.floor(px.length / 3));
  const summarize = (arr) => {
    let sx = 0, sy = 0, ss = 0, sl = 0, sv = 0;
    for (const p of arr) {
      const a = p.h * Math.PI / 180;
      sx += Math.cos(a) * p.s; sy += Math.sin(a) * p.s; ss += p.s; sl += p.l; sv += p.v;
    }
    let hue = Math.atan2(sy, sx) * 180 / Math.PI;
    if (hue < 0) hue += 360;
    return { hue, sat: ss / arr.length, lum: sl / arr.length, value: sv / arr.length };
  };
  return {
    count: px.length,
    dark: summarize(px.slice(0, third)),
    mid: summarize(px.slice(third, third * 2)),
    bright: summarize(px.slice(-third)),
  };
}

// ---------------------------------------------------------------------------
// 휘도 필드 · 행 프로파일
// ---------------------------------------------------------------------------

/** 감마공간 luma(0..255) 필드. 행 프로파일·국소 표준편차가 공유한다. */
export function luminanceField(image) {
  const { width, height, channels, data } = image;
  const lum = new Float32Array(width * height);
  for (let i = 0, p = 0; i < width * height; i++, p += channels) {
    lum[i] = luma709(data[p], data[p + 1], data[p + 2]);
  }
  return lum;
}

/** 국소 3x3 luma 표준편차. 출처: scratchpad/look-diag/5-fogband.mjs `localStd`. */
export function localStd(lum, width, height, x, y) {
  let s = 0, s2 = 0, n = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
      const v = lum[yy * width + xx]; s += v; s2 += v * v; n++;
    }
  }
  return Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2));
}

/**
 * 행별 평균 luma 와 행별 국소 대비.
 * 출처: scratchpad/fog-round/analyze.mjs · scratchpad/look-diag/5-fogband.mjs
 *   (열 표본 간격 3, 국소 표준편차 표본 간격 17 — 원본 그대로).
 */
export function rowProfile(image, { colStep = 3, stdStep = 17 } = {}) {
  const { width, height } = image;
  const lum = luminanceField(image);
  const rowMean = new Float64Array(height);
  const rowStd = new Float64Array(height);
  for (let y = 0; y < height; y++) {
    let s = 0, n = 0, sd = 0, sn = 0;
    for (let x = 0; x < width; x += colStep) { s += lum[y * width + x]; n++; }
    const yy = Math.min(height - 2, Math.max(1, y));
    for (let x = 2; x < width - 2; x += stdStep) { sd += localStd(lum, width, height, x, yy); sn++; }
    rowMean[y] = n ? s / n : 0;
    rowStd[y] = sn ? sd / sn : 0;
  }
  return { rowMean, rowStd, lum, width, height };
}

/**
 * 평활 평면(하늘·안개 띠) 검출과 그 구배·하단 하드 스텝.
 * 출처: scratchpad/fog-round/analyze.mjs — 상반부에서 rowStd < smoothStd 인 최장 연속 구간을
 *   평면으로 보고, 100행당 luma 변화(per100)와 평면 바로 아래로의 낙차(stepBelow)를 잰다.
 *   per100 이 0 근처면 "구배 없는 밝은 평면", stepBelow 가 크면 "띠 아래 하드 스텝"이다.
 */
export function smoothPlane(profile, { smoothStd = 1.2, searchFrac = 0.5 } = {}) {
  const { rowMean, rowStd, height } = profile;
  let best = { start: 0, len: 0 };
  let run = 0;
  const limit = Math.max(1, Math.floor(height * searchFrac));
  for (let y = 0; y < limit; y++) {
    if (rowStd[y] < smoothStd) {
      run++;
      if (run > best.len) best = { start: y - run + 1, len: run };
    } else run = 0;
  }
  if (!best.len) {
    return { found: false, start: 0, len: 0, lo: NaN, hi: NaN, per100Rows: NaN, stepBelow: NaN };
  }
  const lo = rowMean[best.start];
  const hi = rowMean[best.start + best.len - 1];
  const per100Rows = best.len > 1 ? (hi - lo) / best.len * 100 : NaN;
  const edge = best.start + best.len;
  const stepBelow = edge > 0 && edge + 6 < height
    ? rowMean[edge - 1] - (rowMean[edge + 2] + rowMean[edge + 4] + rowMean[edge + 6]) / 3
    : NaN;
  return { found: true, start: best.start, len: best.len, lo, hi, per100Rows, stepBelow };
}

// ---------------------------------------------------------------------------
// 두 이미지 차분
// ---------------------------------------------------------------------------

/**
 * A/B 차분 통계. 변화 픽셀 정의(채널 절대차 합 >= threshold)는
 *   tools/lib/png-metrics.mjs `countChangedPixels` 의 정의를 그대로 승계한다.
 * 최댓값 위치는 scratchpad/vis-crop.mjs 가 핫스팟 크롭 중심을 잡던 방식이다.
 * 채널 평균차(부호 유지)는 "무엇이 어느 쪽으로 밀렸는가"를 보므로 절대차와 함께 낸다.
 */
export function diffStats(a, b, { threshold = 12, region, step = 1 } = {}) {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`diffStats: size mismatch ${a.width}x${a.height} vs ${b.width}x${b.height}`);
  }
  const r = resolveRegion(a, region);
  let examined = 0, changed = 0, sumAbs = 0, maxAbs = -1;
  let maxAt = [-1, -1];
  const sumCh = [0, 0, 0];
  let sumLuma = 0, maxLumaGain = -Infinity, maxLumaDrop = Infinity;
  for (let y = r.y0; y <= r.y1; y += step) {
    for (let x = r.x0; x <= r.x1; x += step) {
      const pa = pixelAt(a, x, y), pb = pixelAt(b, x, y);
      const d = Math.abs(pa[0] - pb[0]) + Math.abs(pa[1] - pb[1]) + Math.abs(pa[2] - pb[2]);
      examined++;
      sumAbs += d;
      if (d >= threshold) changed++;
      if (d > maxAbs) { maxAbs = d; maxAt = [x, y]; }
      for (let c = 0; c < 3; c++) sumCh[c] += pb[c] - pa[c];
      const dl = luma709(...pb) - luma709(...pa);
      sumLuma += dl;
      if (dl > maxLumaGain) maxLumaGain = dl;
      if (dl < maxLumaDrop) maxLumaDrop = dl;
    }
  }
  return {
    examined, changed,
    changedRatio: examined ? changed / examined : 0,
    meanAbs: examined ? sumAbs / examined : 0,
    maxAbs: maxAbs < 0 ? 0 : maxAbs,
    maxAt,
    channelMeanDelta: sumCh.map((v) => (examined ? v / examined : 0)),
    meanLumaDelta: examined ? sumLuma / examined : 0,
    maxLumaGain: Number.isFinite(maxLumaGain) ? maxLumaGain : 0,
    maxLumaDrop: Number.isFinite(maxLumaDrop) ? maxLumaDrop : 0,
    identical: changed === 0 && maxAbs === 0,
  };
}

// ---------------------------------------------------------------------------
// 표본 · 크롭
// ---------------------------------------------------------------------------

/**
 * 좌표 주변 nxn 평균 색 표본(패싯 판독).
 * 출처: scratchpad/vis-facet.mjs `patch()` — "이 패싯이 초록을 잃었는가"를 G-R 로 읽던 용도라
 *   greenMinusRed 를 함께 낸다.
 */
export function patchSample(image, cx, cy, n = 5) {
  const half = Math.floor(n / 2);
  const r = resolveRegion(image, { x0: cx - half, y0: cy - half, x1: cx + half, y1: cy + half });
  let sr = 0, sg = 0, sb = 0, count = 0;
  for (let y = r.y0; y <= r.y1; y++) {
    for (let x = r.x0; x <= r.x1; x++) {
      const [pr, pg, pb] = pixelAt(image, x, y);
      sr += pr; sg += pg; sb += pb; count++;
    }
  }
  const rgb = [sr / count, sg / count, sb / count];
  return {
    count, rgb,
    luma: luma709(...rgb),
    greenMinusRed: rgb[1] - rgb[0],
    hsv: rgbToHsv(Math.round(rgb[0]), Math.round(rgb[1]), Math.round(rgb[2])),
  };
}

/**
 * 최근접 확대 크롭. 출처: scratchpad/vis-crop.mjs `crop()` — 비전 에이전트에게 넘길 확대컷을
 *   만들 때 쓰며, 보간하지 않는다(픽셀 단위 결함을 흐리지 않기 위해).
 */
export function cropScaled(image, { cx, cy, width: w, height: h, scale = 1 }) {
  const x0 = Math.max(0, Math.min(image.width - w, cx - (w >> 1)));
  const y0 = Math.max(0, Math.min(image.height - h, cy - (h >> 1)));
  const outW = w * scale, outH = h * scale;
  const out = new Uint8Array(outW * outH * 4);
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const sx = Math.min(image.width - 1, x0 + ((x / scale) | 0));
      const sy = Math.min(image.height - 1, y0 + ((y / scale) | 0));
      const [pr, pg, pb] = pixelAt(image, sx, sy);
      const di = (y * outW + x) * 4;
      out[di] = pr; out[di + 1] = pg; out[di + 2] = pb; out[di + 3] = 255;
    }
  }
  return { width: outW, height: outH, channels: 4, data: out, origin: [x0, y0] };
}
