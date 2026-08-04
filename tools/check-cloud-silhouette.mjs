// #53 S6 실루엣 다양성 게이트(순수 노드, 브라우저 락 0).
//
// 판정 대상은 "한 프레임에서 두 구름이 같은 도장으로 안 읽히는가"다. 그것을 지각으로 묻지 않고
//   여섯 축으로 수치화한다(비전 판정문 2026-08-04 의 항목과 1:1 대응):
//     ① 위상 무결       — A3 게이트 계승:  알파 투과 밴드 전 구간 내부 홀 0 · 종횡비 · 조각 상한
//     ② 패밀리 비유사도 — "같은 형상 3 개": 정규화 마스크 IoU + 형상 거리(5 항 복합)
//     ③ 미러 정체성     — 미러가 거울상으로 읽히지 않는가
//     ④ 씬 배치 위계    — "크기 위계 없음": 쿼드 면적 × 베이크 커버리지 = 칠해지는 면적의 위계
//     ⑤ 방향·반복       — "동일 방향":     방위 이웃·화각 창 안 조합 반복
//     ⑥ wisp 외곽       — "경계가 딱 끊김": 실루엣 밖 알파 꼬리의 폭·지분
//
// 계측 규율: 배치·스펙은 제품 모듈에서 export 된 것을 그대로 읽는다(HIGH_CLOUD_SPECS·
//   horizonBankSpecs·CLOUD_ATLAS_TILES). 게이트가 배치표를 복사해 두면 그 순간 계측기가 자기증명이
//   된다 — 이 레포는 실제로 그런 계측기 버그를 두 건 겪었다.
//
// 임계는 두 소스의 실측 분포 사이에서 골랐다(shapemetrics.mjs, 2026-08-04):
//                        A3(HEAD, 상공 4 장)      S6(신판 4 패밀리)     채택 임계
//   정규화 IoU 최대       0.825~0.848             0.408~0.628          ≤ 0.75
//   형상 거리 최소        0.118                   0.511                ≥ 0.35
//   wisp p75             3.0~4.2                 8.5~15.6             ≥ 6.0
//   wisp 꼬리≥6px 지분    9~12%                   36~64%               ≥ 25%
//   희박 알파/커버 지분   3.7~3.9%                11.7~24.2%           ≥ 8%
// FAIL-first: CLOUD_BUNDLE=./bake-a3.mjs 로 같은 판정을 A3(HEAD) 소스에 걸면 ②④⑤⑥ 이 실패한다
//   (실행 로그는 라운드 보고에 첨부). HEAD 는 배치표를 export 하지 않으므로 그 경우에만 A3 실측
//   배치를 대체 입력으로 쓴다 — 아래 표는 HEAD 소스의 highSpecs·horizonSpecs 값 그대로다.
// [tools/ 편입 2026-08-04, 리드] 원판은 스크래치의 사전 빌드 번들(./bake.mjs)을 읽었다.
// 레포 게이트는 자립해야 하므로, CLOUD_BUNDLE 미지정 시 현재 소스에서 즉석 번들한다
// (clouds.js 는 브라우저 전역을 조건부로만 읽어 노드에서 그대로 평가된다).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
let BUNDLE = process.env.CLOUD_BUNDLE;
if (!BUNDLE) {
  const tmp = mkdtempSync(join(tmpdir(), 'cloud-sil-'));
  const entry = join(tmp, 'entry.mjs');
  writeFileSync(entry, `export {
  bakeCloudData, bakeCloudAtlas, cloudAtlasRect, cloudFamilySpec, CLOUD_TEX_SIZE,
  CLOUD_FAMILY_ORDER, CLOUD_ATLAS_TILES, CLOUD_ATLAS_COLS, HIGH_CLOUD_SPECS, horizonBankSpecs,
} from ${JSON.stringify(join(REPO, 'src/env/clouds.js'))};\n`);
  BUNDLE = join(tmp, 'bake.mjs');
  execFileSync('npx', ['esbuild', entry, '--bundle', '--format=esm',
    `--alias:three=${join(REPO, 'app/node_modules/three/build/three.module.js')}`,
    `--outfile=${BUNDLE}`, '--log-level=warning'], { cwd: REPO, stdio: 'inherit' });
}
const mod = await import(pathToFileURL(BUNDLE).href);
const { bakeCloudData } = mod;
const HEAD_MODE = !mod.HIGH_CLOUD_SPECS;
const S = 256, N = 96;

const A3_TILES = [
  { tile: 0, family: 'cumulus', seed: 11 }, { tile: 1, family: 'cumulus', seed: 29 },
  { tile: 2, family: 'cumulus', seed: 47 }, { tile: 3, family: 'cumulus', seed: 63 },
];
const A3_HIGH = [
  { w: 150, h: 108, tile: 0, mir: 1 }, { w: 182, h: 124, tile: 1, mir: 1 },
  { w: 160, h: 112, tile: 2, mir: 1 }, { w: 192, h: 132, tile: 3, mir: 1 },
];
const TILES = HEAD_MODE ? A3_TILES : mod.CLOUD_ATLAS_TILES;
const HIGH = (HEAD_MODE ? A3_HIGH : mod.HIGH_CLOUD_SPECS).slice(0, 4);   // 제품 기본 highCloudCount=4
const BANK = HEAD_MODE
  ? Array.from({ length: 16 }, (_, i) => ({
    az: 0.17 + i * Math.PI * 2 / 16, tile: 0, mirror: 1, roll: 0,
    sx: [0.82, 1.06, 1.18, 0.94][i % 4], sy: [0.84, 1.06, 0.92, 1.14][(i + 1) % 4],
  }))
  : mod.horizonBankSpecs(16);
const FAMILY_OF = (tile) => (HEAD_MODE ? `cumulus${tile}` : mod.CLOUD_FAMILY_ORDER[tile]);

const IOU_MAX = 0.75;
const SHAPE_MIN = 0.35;
const WISP_P75_MIN = 6.0, WISP_FRAC_MIN = 0.25, FAINT_MIN = 0.08;
const FRAGMENT_MAX = 0.006, FRAGMENT_TOTAL_MAX = 0.025;
const ASPECT_LO = 0.70, ASPECT_HI = 1.30;
const HOLE_BAND = [26, 51, 77, 102, 128];
const A3_PAINTED_SUM = 26110;      // A3 상공 4 장 실측 합(쿼드 면적 × 커버리지)

let failed = 0;
const ok = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { console.log(`  FAIL ${msg}`); failed++; }
};

// ── 측정 유틸 ─────────────────────────────────────────────────────────────────
function maskAt(data, T) {
  const m = new Uint8Array(S * S);
  let x0 = S, x1 = -1, y0 = S, y1 = -1, area = 0;
  for (let i = 0; i < S * S; i++) {
    if (data[i * 4 + 3] < T) continue;
    m[i] = 1; area++;
    const x = i % S, y = (i / S) | 0;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return { m, x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1, area };
}
// bbox 를 N×N 로 정규화 — 크기·종횡비를 제거하고 **형상만** 비교한다(크기 위계는 축 ④ 가 따로 잰다).
function normalize(mk) {
  const out = new Uint8Array(N * N);
  for (let y = 0; y < N; y++) {
    const sy = mk.y0 + Math.min(mk.h - 1, Math.floor((y + 0.5) * mk.h / N));
    for (let x = 0; x < N; x++) {
      const sx = mk.x0 + Math.min(mk.w - 1, Math.floor((x + 0.5) * mk.w / N));
      out[y * N + x] = mk.m[sy * S + sx];
    }
  }
  return out;
}
function iou(a, b) {
  let inter = 0, union = 0;
  for (let i = 0; i < N * N; i++) { if (a[i] && b[i]) inter++; if (a[i] || b[i]) union++; }
  return union ? inter / union : 1;
}
// 형상 특징 다섯. solidity·compact 는 "덩어리 하나인가 성긴 사슬인가", elong·skew 는 질량 분포의
//   방향·비대칭, prof(행별 폭)는 "소시지 위에 조약돌" 같은 **수직 구성**을 직접 담는다.
function feats(a) {
  let A = 0, P = 0, sx = 0, sy = 0;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      if (!a[i]) continue;
      A++; sx += x; sy += y;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= N || yy >= N || !a[yy * N + xx]) P++;
      }
    }
  }
  const cx = sx / A, cy = sy / A;
  let m20 = 0, m02 = 0, m30 = 0;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      if (!a[y * N + x]) continue;
      const dx = x - cx, dy = y - cy;
      m20 += dx * dx; m02 += dy * dy; m30 += dx * dx * dx;
    }
  }
  const prof = [];
  for (let y = 0; y < N; y++) { let c = 0; for (let x = 0; x < N; x++) if (a[y * N + x]) c++; prof.push(c / N); }
  return {
    solidity: A / (N * N), compact: 4 * Math.PI * A / (P * P),
    elong: (m20 - m02) / (m20 + m02), skew: m30 / (A * Math.pow(m20 / A, 1.5)), prof,
  };
}
function shapeDist(a, b) {
  let p = 0;
  for (let k = 0; k < N; k++) p += Math.abs(a.prof[k] - b.prof[k]);
  return Math.abs(a.solidity - b.solidity) + Math.abs(a.compact - b.compact) + p / N
    + Math.abs(a.elong - b.elong) + 0.5 * Math.abs(a.skew - b.skew);
}
function label(mask, conn8) {
  const lab = new Int32Array(S * S).fill(-1);
  const sizes = [], touches = [];
  const stack = new Int32Array(S * S);
  for (let start = 0; start < S * S; start++) {
    if (lab[start] !== -1 || !mask[start]) continue;
    const id = sizes.length;
    sizes.push(0); touches.push(false);
    let sp = 0; stack[sp++] = start; lab[start] = id;
    while (sp) {
      const p = stack[--sp];
      sizes[id]++;
      const x = p % S, y = (p / S) | 0;
      if (x === 0 || y === 0 || x === S - 1 || y === S - 1) touches[id] = true;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= S) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          if (!conn8 && dx && dy) continue;
          const xx = x + dx;
          if (xx < 0 || xx >= S) continue;
          const q = yy * S + xx;
          if (lab[q] !== -1 || !mask[q]) continue;
          lab[q] = id; stack[sp++] = q;
        }
      }
    }
  }
  return { lab, sizes, touches };
}
// 한 알파 임계에서의 위상. 전경 8-이웃 성분, 배경 4-이웃 내부 홀(A3 게이트와 같은 엄격 정의).
//   조각 판정에는 성분의 **최대 알파**도 같이 본다 — 불투명 조각과 증기 조각은 다른 결함이다.
function topologyAt(data, T) {
  const solid = new Uint8Array(S * S), empty = new Uint8Array(S * S);
  for (let i = 0; i < S * S; i++) {
    if (data[i * 4 + 3] >= T) solid[i] = 1; else empty[i] = 1;
  }
  const fg = label(solid, true), bg = label(empty, false);
  let holes = 0, holePx = 0;
  bg.sizes.forEach((n, i) => { if (!bg.touches[i]) { holes++; holePx += n; } });
  let main = 0;
  fg.sizes.forEach((n, i) => { if (n > fg.sizes[main]) main = i; });
  const peak = new Array(fg.sizes.length).fill(0);
  for (let i = 0; i < S * S; i++) {
    const id = fg.lab[i];
    if (id >= 0) peak[id] = Math.max(peak[id], data[i * 4 + 3]);
  }
  const frags = fg.sizes.map((n, i) => ({ area: n, share: n / fg.sizes[main], peak: peak[i] }))
    .filter((_, i) => i !== main);
  return {
    holes, holePx, comps: fg.sizes.length, mainArea: fg.sizes[main], frags,
    maxFragShare: frags.reduce((a, f) => Math.max(a, f.share), 0),
    totalFragShare: frags.reduce((a, f) => a + f.share, 0),
    opaqueFrags: frags.filter((f) => f.peak >= 128).length,
  };
}
// wisp: 실루엣(알파≥128) 경계에서 밖으로 향한 방위마다 알파≥4 가 연속으로 남는 거리. 찢긴 프린지는
//   방위 절반쯤에만 꼬리가 있으므로 중앙값이 아니라 p75 와 "꼬리≥6px 지분"으로 본다.
function wispMetrics(data) {
  const solid = new Uint8Array(S * S);
  let faint = 0, cover = 0;
  for (let i = 0; i < S * S; i++) {
    const a = data[i * 4 + 3];
    solid[i] = a >= 128 ? 1 : 0;
    if (a > 10) cover++;
    if (a >= 4 && a < 64) faint++;
  }
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  const runs = [];
  for (let y = 1; y < S - 1; y++) {
    for (let x = 1; x < S - 1; x++) {
      const i = y * S + x;
      if (!solid[i]) continue;
      for (const [dx, dy] of dirs) {
        if (solid[i + dy * S + dx]) continue;
        let d = 0;
        for (let k = 1; k < 48; k++) {
          const xx = x + dx * k, yy = y + dy * k;
          if (xx < 0 || yy < 0 || xx >= S || yy >= S) break;
          if (data[(yy * S + xx) * 4 + 3] < 4) break;
          d = k * Math.hypot(dx, dy);
        }
        runs.push(d);
      }
    }
  }
  runs.sort((a, b) => a - b);
  const q = (p) => (runs.length ? runs[Math.floor(runs.length * p)] : 0);
  return {
    med: q(0.5), p75: q(0.75), p90: q(0.9),
    frac6: runs.length ? runs.filter((v) => v >= 6).length / runs.length : 0,
    faintRatio: cover ? faint / cover : 0,
    cover: cover / (S * S),
  };
}

// ── 베이크 ─────────────────────────────────────────────────────────────────────
const bakes = new Map();
function bake(t, mirror) {
  const key = `${t.family}:${t.seed}:${mirror ? 'm' : 'o'}`;
  if (!bakes.has(key)) {
    const args = HEAD_MODE ? [t.seed, 'cumulus', S] : [t.seed, t.family, S, { mirror }];
    bakes.set(key, bakeCloudData(...args));
  }
  return bakes.get(key);
}

console.log(`check-cloud-silhouette (#53 S6)  source=${BUNDLE}${HEAD_MODE ? '  [A3 대체 배치]' : ''}\n`);

// ── ① 위상·종횡비 ─────────────────────────────────────────────────────────────
console.log('① 패밀리별 베이크 — 위상(알파 26~128 전 구간) · 종횡비 · 커버리지');
console.log('family      seed mir  bbox      aspect  cover%  holes@T  comps  조각최대  조각합  불투명조각');
const rows = [];
for (const t of TILES) {
  for (const mirror of HEAD_MODE ? [false] : [false, true]) {
    const b = bake(t, mirror);
    const mk = maskAt(b.data, 128);
    const band = HOLE_BAND.map((T) => ({ T, ...topologyAt(b.data, T) }));
    const worstHole = band.reduce((a, c) => (c.holePx > a.holePx ? c : a));
    const worstFrag = band.reduce((a, c) => (c.maxFragShare > a.maxFragShare ? c : a));
    const worstTotal = band.reduce((a, c) => (c.totalFragShare > a.totalFragShare ? c : a));
    const wisp = wispMetrics(b.data);
    const row = {
      family: t.family, seed: t.seed, mirror, aspect: mk.w / mk.h, cover: wisp.cover * 100,
      holes: worstHole.holes, holeT: worstHole.T, comps: Math.max(...band.map((c) => c.comps)),
      maxFrag: worstFrag.maxFragShare, totalFrag: worstTotal.totalFragShare,
      opaqueFrags: Math.max(...band.map((c) => c.opaqueFrags)),
      wisp, norm: normalize(mk), feat: feats(normalize(mk)),
    };
    rows.push(row);
    console.log(`${t.family.padEnd(11)} ${String(t.seed).padStart(4)} ${mirror ? 'm' : ' '}  `
      + `${(mk.w + 'x' + mk.h).padStart(8)} ${row.aspect.toFixed(3).padStart(6)} `
      + `${row.cover.toFixed(1).padStart(6)}  ${String(row.holes).padStart(2)}@${String(row.holeT).padStart(3)}`
      + `  ${String(row.comps).padStart(4)}  ${(100 * row.maxFrag).toFixed(2).padStart(7)}% `
      + `${(100 * row.totalFrag).toFixed(2).padStart(6)}%  ${String(row.opaqueFrags).padStart(6)}`);
  }
}
ok(rows.every((r) => r.holes === 0), `내부 홀 0 (투과 밴드 ${HOLE_BAND.join('/')} 전 구간)`);
ok(rows.every((r) => r.aspect >= ASPECT_LO && r.aspect <= ASPECT_HI),
  `베이크 종횡비 ${ASPECT_LO}~${ASPECT_HI} (실측 ${Math.min(...rows.map((r) => r.aspect)).toFixed(2)}~${Math.max(...rows.map((r) => r.aspect)).toFixed(2)})`);
// ── 조각 단언 재핀(2026-08-04, #53 S6) ────────────────────────────────────────
// A3 게이트는 "고립 성분 0"(투과 밴드 전 구간 comps === 1)이었다. 그 단언이 겨냥한 결함은 기단 위에
//   떠 있던 **불투명한** 장기말/호로병형 nub 이다(A2 FIX③ 의 대상). 이 라운드는 그 반대 방향의
//   결함("외곽에 흩어지는 wisp 없이 경계가 딱 끊김")을 고치라는 요구를 받았고, 알파 0.1~0.3 의 증기
//   조각은 그 해법의 일부다 — 원 단언을 그대로 두면 두 요구가 서로를 배제한다.
// 정당한 파생: 불투명 조각은 **여전히 0**(원 결함 강도 유지)이고, 반투명 조각은 면적 상한으로만
//   허용한다(하나 ≤ 0.6% · 합 ≤ 2.5% of 본체). 즉 완화가 아니라 조건 분기다 — 아래 합성 픽스처가
//   원 결함(불투명 nub)이 지금도 실패로 잡히는 것과 증기 조각이 통과하는 것을 함께 증명한다.
ok(rows.every((r) => r.opaqueFrags === 0), '불투명(알파≥128) 고립 조각 0 — A2 FIX③ 결함 강도 유지');
ok(rows.every((r) => r.maxFrag <= FRAGMENT_MAX),
  `증기 조각 하나 ≤ 본체의 ${(100 * FRAGMENT_MAX).toFixed(1)}% (실측 ${(100 * Math.max(...rows.map((r) => r.maxFrag))).toFixed(2)}%)`);
ok(rows.every((r) => r.totalFrag <= FRAGMENT_TOTAL_MAX),
  `증기 조각 합 ≤ 본체의 ${(100 * FRAGMENT_TOTAL_MAX).toFixed(1)}% (실측 ${(100 * Math.max(...rows.map((r) => r.totalFrag))).toFixed(2)}%)`);

// 합성 회귀 픽스처 — 게이트가 원 결함을 지금도 잡는지 자기 안에서 증명한다(게이트는 녹색인 것이
//   아니라 **빨강일 수 있음**이 증명돼야 신뢰된다).
{
  const base = bake(TILES[0], false);
  const withNub = new Uint8Array(base.data);
  const withVapour = new Uint8Array(base.data);
  const paint = (buf, cx, cy, r, alpha) => {
    for (let y = cy - r; y <= cy + r; y++) {
      for (let x = cx - r; x <= cx + r; x++) {
        if (x < 0 || y < 0 || x >= S || y >= S) continue;
        if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) continue;
        buf[(y * S + x) * 4 + 3] = alpha;
      }
    }
  };
  paint(withNub, 30, 210, 6, 255);      // 본체에서 떨어진 불투명 nub (A2 FIX③ 결함)
  paint(withVapour, 30, 210, 6, 60);    // 같은 자리의 증기 조각 (이 라운드가 허용해야 하는 것)
  const nub = topologyAt(withNub, 26), vap = topologyAt(withVapour, 26);
  console.log(`  픽스처: 불투명 nub → 조각 ${nub.frags.length}개 불투명 ${nub.opaqueFrags} `
    + `· 증기 조각 → 조각 ${vap.frags.length}개 불투명 ${vap.opaqueFrags} 지분 ${(100 * vap.maxFragShare).toFixed(2)}%`);
  ok(nub.opaqueFrags > 0, '합성 픽스처: 불투명 고립 nub 을 지금도 결함으로 잡는다(FAIL-first)');
  ok(vap.opaqueFrags === 0 && vap.maxFragShare <= FRAGMENT_MAX,
    '합성 픽스처: 같은 크기의 증기 조각은 통과한다(두 요구가 배타적이지 않음)');
}

// ── ② 패밀리 비유사도 ─────────────────────────────────────────────────────────
console.log('\n② 패밀리 쌍별 — 정규화 IoU(작을수록 다른 형상) · 형상 거리(5 항)');
const originals = rows.filter((r) => !r.mirror);
const pairs = [];
for (let i = 0; i < originals.length; i++) {
  for (let j = i + 1; j < originals.length; j++) {
    const a = originals[i], b = originals[j];
    const v = iou(a.norm, b.norm), d = shapeDist(a.feat, b.feat);
    pairs.push({ a: a.family, b: b.family, iou: v, d });
    console.log(`  ${a.family.padEnd(10)} × ${b.family.padEnd(10)} IoU ${v.toFixed(3)}  형상거리 ${d.toFixed(3)}`);
  }
}
ok(pairs.every((p) => p.iou <= IOU_MAX),
  `모든 쌍 IoU ≤ ${IOU_MAX} (최대 ${Math.max(...pairs.map((p) => p.iou)).toFixed(3)})`);
ok(pairs.every((p) => p.d >= SHAPE_MIN),
  `모든 쌍 형상 거리 ≥ ${SHAPE_MIN} (최소 ${Math.min(...pairs.map((p) => p.d)).toFixed(3)})`);

// ── ③ 미러 정체성 ─────────────────────────────────────────────────────────────
if (!HEAD_MODE) {
  console.log('\n③ 미러 타일 — 정확한 반사와의 IoU(1.0 이면 거울상으로 읽힌다)');
  const gaps = TILES.map((t) => {
    const o = normalize(maskAt(bake(t, false).data, 128));
    const m = normalize(maskAt(bake(t, true).data, 128));
    const flipped = new Uint8Array(N * N);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) flipped[y * N + x] = o[y * N + (N - 1 - x)];
    return { family: t.family, iou: iou(m, flipped) };
  });
  for (const g of gaps) console.log(`  ${g.family.padEnd(10)} ${g.iou.toFixed(3)}`);
  ok(gaps.every((g) => g.iou <= 0.94),
    `미러가 완전한 거울상이 아니다 (최대 ${Math.max(...gaps.map((g) => g.iou)).toFixed(3)} ≤ 0.94)`);
}

// ── ④ 씬 배치 위계 ────────────────────────────────────────────────────────────
console.log('\n④ 상공 슬롯 위계 — 쿼드 · 패밀리 · 미러 · 칠해지는 면적');
const rowFor = (tile, mir) => rows.find((r) => r.family === TILES[tile].family
  && (HEAD_MODE || r.mirror === (mir < 0)));
const slots = HIGH.map((s, i) => {
  const r = rowFor(s.tile, s.mir);
  return {
    slot: i, family: FAMILY_OF(s.tile), mirror: s.mir, w: s.w, h: s.h,
    quadAspect: s.w / s.h, cover: r.cover / 100, painted: s.w * s.h * r.cover / 100,
    composite: (s.w / s.h) * r.aspect,
  };
});
for (const s of slots) {
  console.log(`  slot${s.slot} ${s.family.padEnd(10)} mir${s.mirror > 0 ? '+' : '-'} `
    + `${(s.w + '×' + s.h).padStart(8)} quadAR ${s.quadAspect.toFixed(2)} cover ${(100 * s.cover).toFixed(1)}% `
    + `→ painted ${s.painted.toFixed(0).padStart(6)}  합성종횡비 ${s.composite.toFixed(2)}`);
}
const painted = slots.map((s) => s.painted).sort((a, b) => b - a);
const paintedSum = painted.reduce((a, b) => a + b, 0);
const ratio = painted[0] / painted[painted.length - 1];
console.log(`  painted 합 ${paintedSum.toFixed(0)} (A3 ${A3_PAINTED_SUM}) · 지배/최소 ${ratio.toFixed(2)}배`);
ok(ratio >= 3.0, `지배 구름 / 최소 파편 칠해지는 면적비 ≥ 3.0 (실측 ${ratio.toFixed(2)})`);
ok(paintedSum >= A3_PAINTED_SUM * 0.9,
  `하늘에 칠해지는 총량 ≥ A3 의 90% (실측 ${(100 * paintedSum / A3_PAINTED_SUM).toFixed(0)}%)`);
const adjSame = slots.filter((s, i) => i > 0
  && s.family === slots[i - 1].family && s.mirror === slots[i - 1].mirror);
ok(adjSame.length === 0, `인접 슬롯에 같은 (패밀리, 미러) 없음 (위반 ${adjSame.length})`);
const dominant = slots.reduce((a, s) => (s.painted > a.painted ? s : a));
ok(slots.every((s) => s.composite <= 1.75),
  `모든 슬롯 화면 합성 종횡비 ≤ 1.75 (최대 ${Math.max(...slots.map((s) => s.composite)).toFixed(2)})`);
ok(dominant.composite <= 1.45,
  `지배 구름 합성 종횡비 ≤ 1.45 (slot${dominant.slot} ${dominant.composite.toFixed(2)})`);

// ── ⑤ 뱅크 방위 반복 ──────────────────────────────────────────────────────────
console.log('\n⑤ 원경 뱅크 16 인스턴스 — 방위 이웃 반복 · 화각 창 안 중복');
const bankKey = (b) => `${FAMILY_OF(b.tile)}|${b.mirror}`;
let adjBank = 0;
for (let i = 0; i < BANK.length; i++) {
  if (bankKey(BANK[i]) === bankKey(BANK[(i + 1) % BANK.length])) adjBank++;
}
const WINDOW = Math.PI / 3;                 // 최대 화각 60°
let windowDup = 0, windowMax = 0;
for (let i = 0; i < BANK.length; i++) {
  const inWin = BANK.filter((b) => Math.abs(Math.atan2(Math.sin(b.az - BANK[i].az),
    Math.cos(b.az - BANK[i].az))) <= WINDOW * 0.5);
  windowMax = Math.max(windowMax, inWin.length);
  const keys = inWin.map((b) => `${bankKey(b)}|${b.sx}`);
  windowDup += keys.length - new Set(keys).size;
}
const bankAreas = [...new Set(BANK.map((b) => b.sx * b.sy))].sort((a, b) => b - a);
const bankRatio = bankAreas[0] / bankAreas[bankAreas.length - 1];
const rolls = [...new Set(BANK.map((b) => b.roll || 0))];
console.log(`  방위 이웃 동일 (패밀리,미러) ${adjBank}건 · 60° 창 최대 ${windowMax}장 · 창 안 중복 조합 ${windowDup}건`);
console.log(`  크기 역할 ${bankAreas.length}종 면적비 ${bankRatio.toFixed(2)}배 · 롤 ${rolls.length}종 `
  + `(${rolls.map((r) => (r * 180 / Math.PI).toFixed(1)).join(', ')}°)`);
ok(adjBank === 0, `방위 이웃이 같은 (패밀리, 미러) 를 쓰지 않는다 (위반 ${adjBank})`);
ok(windowDup === 0, `60° 화각 창 안에 같은 (패밀리, 미러, 크기) 조합 없음 (중복 ${windowDup})`);
ok(bankRatio >= 3.0, `뱅크 크기 역할 면적비 ≥ 3.0 (실측 ${bankRatio.toFixed(2)})`);
ok(rolls.length >= 4 && Math.max(...rolls.map(Math.abs)) <= 0.09,
  `롤 4 종 이상, 최대 ±5.2° 이내 (종수 ${rolls.length}, 최대 ${(Math.max(...rolls.map(Math.abs)) * 180 / Math.PI).toFixed(1)}°)`);

// ── ⑥ wisp 외곽 ───────────────────────────────────────────────────────────────
console.log('\n⑥ wisp 외곽 — 경계 밖 알파≥4 꼬리 · 희박 알파(4~63) 지분');
for (const r of rows) {
  console.log(`  ${(r.family + (r.mirror ? '/m' : '')).padEnd(13)} med ${r.wisp.med.toFixed(1).padStart(4)} `
    + `p75 ${r.wisp.p75.toFixed(1).padStart(4)} p90 ${r.wisp.p90.toFixed(1).padStart(4)} `
    + `꼬리≥6px ${(100 * r.wisp.frac6).toFixed(0).padStart(3)}%  희박/커버 ${(100 * r.wisp.faintRatio).toFixed(1).padStart(5)}%`);
}
ok(rows.every((r) => r.wisp.p75 >= WISP_P75_MIN),
  `외곽 꼬리 p75 ≥ ${WISP_P75_MIN}px (최소 ${Math.min(...rows.map((r) => r.wisp.p75)).toFixed(1)})`);
ok(rows.every((r) => r.wisp.frac6 >= WISP_FRAC_MIN),
  `경계 방위 중 꼬리 ≥6px 인 비율 ≥ ${(100 * WISP_FRAC_MIN).toFixed(0)}% (최소 ${(100 * Math.min(...rows.map((r) => r.wisp.frac6))).toFixed(0)}%)`);
ok(rows.every((r) => r.wisp.faintRatio >= FAINT_MIN),
  `희박 알파 지분 ≥ ${(100 * FAINT_MIN).toFixed(0)}% (최소 ${(100 * Math.min(...rows.map((r) => r.wisp.faintRatio))).toFixed(1)}%)`);

// ── 예산·결정론 ───────────────────────────────────────────────────────────────
if (!HEAD_MODE) {
  const t0 = performance.now();
  const atlas = mod.bakeCloudAtlas();
  const cold = performance.now() - t0;
  const t1 = performance.now();
  const again = mod.bakeCloudAtlas();
  const warm = performance.now() - t1;
  let identical = atlas.data.length === again.data.length;
  for (let i = 0; identical && i < atlas.data.length; i++) identical = atlas.data[i] === again.data[i];
  // 타일 경계 여백 — 아틀라스는 밉·바이리니어가 이웃 타일을 빨아올 수 있으므로 각 타일의 테두리
  //   두 텍셀이 알파 0 이어야 한다(셰이더 clamp 와 이중 방어).
  let borderMax = 0;
  const T = atlas.tileSize, A = atlas.size;
  for (const t of atlas.tiles) {
    const ox = (t.tile % 2) * T, oy = Math.floor(t.tile / 2) * T;
    for (let k = 0; k < T; k++) {
      for (const [x, y] of [[ox + k, oy], [ox + k, oy + T - 1], [ox, oy + k], [ox + T - 1, oy + k],
        [ox + k, oy + 1], [ox + k, oy + T - 2], [ox + 1, oy + k], [ox + T - 2, oy + k]]) {
        borderMax = Math.max(borderMax, atlas.data[(y * A + x) * 4 + 3]);
      }
    }
  }
  console.log(`\n⑦ 예산 — 아틀라스 ${A}×${A} (${(atlas.data.length / 1024).toFixed(0)}KB, 타일 ${atlas.tiles.length}) `
    + `베이크 cold ${cold.toFixed(0)}ms · warm ${warm.toFixed(0)}ms · 타일 테두리 최대 알파 ${borderMax}`);
  ok(cold <= 200, `아틀라스 베이크 총 ≤ 200ms (cold ${cold.toFixed(0)}ms)`);
  ok(identical, '같은 시드 재베이크가 바이트 동일(결정론)');
  ok(borderMax === 0, `타일 테두리 2 텍셀 알파 0 (최대 ${borderMax})`);
  ok(atlas.tiles.length === mod.CLOUD_FAMILY_ORDER.length,
    `아틀라스 타일 수 = 패밀리 수 ${mod.CLOUD_FAMILY_ORDER.length}`);
}

console.log(failed ? `\nFAIL — ${failed} 항목` : '\nPASS — 실루엣 다양성·위계·방향·wisp·위상 전부 충족');
process.exit(failed ? 1 : 0);
