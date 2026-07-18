// 색분리 정량 측정: PNG 의 hue 히스토그램·녹/청 성분·근흑 비율을 찍는다.
// 사용: NODE_PATH=/Users/hckim/repo/threesur/node_modules node tools/hue-stats.mjs shots/look4-default.png [...]
// 판정: 주황 단일 피크(orange 밴드 비율↑, green/cool≈0)면 뭉갬. green·cool 성분이 살아있고
//       orange 비율이 내려가면 색분리 성공. sky(상단 25%)는 별도로 2색 이상인지 확인.
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
// pngjs 는 CJS + NODE_PATH 로만 접근 → ESM 베어 임포트 대신 require 로(NODE_PATH 존중).
const { PNG } = createRequire(import.meta.url)('pngjs');

function rgb2hsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d > 1e-6) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  return [h, mx === 0 ? 0 : d / mx, mx];
}

// hue 밴드(도): 색분리 판정용 구간.
function band(h) {
  if (h < 20 || h >= 345) return 'redpink';   // 주홍·분홍(단청 주홍·석양 하단)
  if (h < 50) return 'orange';                 // 주황(문제의 단색 피크)
  if (h < 70) return 'yellow';
  if (h < 165) return 'green';                 // 수목·뇌록
  if (h < 200) return 'cyan';
  if (h < 255) return 'blue';                  // 쿨 그늘·하늘 상단
  return 'purple';                             // 모브·자
}

function analyze(png, rowFrom, rowTo) {
  const { width, height, data } = png;
  const y0 = Math.floor(height * rowFrom), y1 = Math.floor(height * rowTo);
  const bands = { redpink: 0, orange: 0, yellow: 0, green: 0, cyan: 0, blue: 0, purple: 0 };
  let colored = 0, total = 0, nearBlack = 0, greenDom = 0, coolDom = 0, lumaSum = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      total++;
      const luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      lumaSum += luma;
      if (luma < 0.02) nearBlack++;
      if (g > r + 6 && g >= b - 2) greenDom++;         // 녹색 우세(수목 음지·뇌록 생존)
      if (b > r + 4 && b >= g - 2) coolDom++;          // 청 우세(쿨 그늘·하늘)
      const [h, s, v] = rgb2hsv(r, g, b);
      if (s > 0.12 && v > 0.06) { bands[band(h)]++; colored++; }
    }
  }
  const pct = (n) => (100 * n / Math.max(1, colored)).toFixed(1);
  const pctT = (n) => (100 * n / Math.max(1, total)).toFixed(1);
  return {
    meanLuma: (lumaSum / total).toFixed(3),
    nearBlackPct: pctT(nearBlack),
    greenDomPct: pctT(greenDom),
    coolDomPct: pctT(coolDom),
    coloredPct: pctT(colored),
    band: Object.fromEntries(Object.entries(bands).map(([k, v]) => [k, pct(v)])),
  };
}

for (const file of process.argv.slice(2)) {
  const buf = await readFile(file);
  const png = PNG.sync.read(buf);
  const full = analyze(png, 0, 1);
  const sky = analyze(png, 0, 0.28);   // 상단 하늘 밴드
  console.log(`\n=== ${file} ===`);
  console.log(`  meanLuma=${full.meanLuma}  nearBlack=${full.nearBlackPct}%  colored=${full.coloredPct}%  greenDom=${full.greenDomPct}%  coolDom=${full.coolDomPct}%`);
  console.log(`  FULL hue%: orange=${full.band.orange} redpink=${full.band.redpink} yellow=${full.band.yellow} green=${full.band.green} cyan=${full.band.cyan} blue=${full.band.blue} purple=${full.band.purple}`);
  console.log(`  SKY  hue%: orange=${sky.band.orange} redpink=${sky.band.redpink} green=${sky.band.green} blue=${sky.band.blue} purple=${sky.band.purple}  (greenDom=${sky.greenDomPct}% coolDom=${sky.coolDomPct}%)`);
}
