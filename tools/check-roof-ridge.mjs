// 용마루 형태 계약 (2026-08-05, 사용자 지적 "궁도 절도 용마루가 짧은 형태는 사진 어디에도 없다").
//
// 두 개의 독립 결함이 같은 증상을 만들었고, 이 게이트는 둘 다 영구 픽스처로 잡는다.
//   A. 팔작 용마루 기하 — 합각 후퇴는 처마 반깊이가 정한다(평면 45° 추녀), 칸 폭이 아니다.
//      종전 식 `W/2 − hipInsetBays·endBayW` 는 소전각(절 누문·종각)에서 ridge/정면폭 29% 를
//      만들었다. 수정 후 base = xEave − zEave (src/params.js#computeLayout).
//   B. 지붕형 위계 — 궁 부속 소채(침전 satellites·궐내각사 subCells)는 애초에 팔작을 쓸
//      건물이 아니다: 부속채는 맞배 (src/village/palace.js#SUBSIDIARY_ROOF,
//      docs/architectural-authenticity.md 삼산고택 위계). 정전급 주전각은 팔작 유지.
//
// FAIL-first (2026-08-05 실측): 수정 전 소스에서 18 FAIL — A2 절 누문·종각 12건 전부
// (ridge/정면폭 29%, 하한 45%) + B 부속 소채·궐내각사 6채 전부(팔작 ridgeHalf 1.82 < W/2 4.00).
// A1 유도 관계는 korea 프리셋이 수정 전에도 0.8 을 넘겨 통과 — A1 의 몫은 회귀 방지다.
// 수정 후 소스에서 0 FAIL.
//
// 순수 노드 게이트: 렌더러 없음. A 는 three-free 모듈 정적 import(변경 라우팅이 정적 폐쇄로
// 잡힌다). B 의 궁 컴파운드만 three 의존이라 esbuild 번들(+canvas 스텁)로 조립한다 —
// 정적 폐쇄에 안 잡히므로 palace.js 소유는 verification-impact.mjs EXACT_IMPACT 에 명시.
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PRESETS, computeLayout } from '../src/params.js';
import { planTempleCompound } from '../src/temple/plan.js';
import { templeHallBuilderPreset } from '../src/temple/role-hierarchy.js';

const ROOT = resolve(import.meta.dirname, '..');
const requireApp = createRequire(join(ROOT, 'app', 'package.json'));
const esbuild = requireApp('esbuild');

const built = await esbuild.build({
  stdin: {
    contents: `
      export { buildPalaceCompound } from './src/village/palace.js';
      export { makeMaterials, setPaletteContext, createPaletteContext } from './src/builder/palette.js';
    `,
    resolveDir: ROOT,
    sourcefile: 'roof-ridge-entry.js',
  },
  alias: {
    'three/addons/utils/BufferGeometryUtils.js': join(
      ROOT, 'app/node_modules/three/examples/jsm/utils/BufferGeometryUtils.js',
    ),
    three: join(ROOT, 'app/node_modules/three/build/three.module.js'),
  },
  bundle: true, format: 'esm', platform: 'node', target: 'node20',
  write: false, logLevel: 'silent',
});
const bundleFile = join(mkdtempSync(join(tmpdir(), 'roof-ridge-')), 'bundle.mjs');
writeFileSync(bundleFile, built.outputFiles[0].text);
const {
  buildPalaceCompound, makeMaterials, setPaletteContext, createPaletteContext,
} = await import(pathToFileURL(bundleFile).href);

// palette 는 canvas 를 요구한다 — check-palace-precinct.mjs 와 같은 스텁.
function stubCanvas() {
  let width = 0, height = 0;
  const gradient = { addColorStop() {} };
  const ctx = new Proxy({
    getImageData(x, y, w, h) { return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }; },
    createImageData(w, h) { return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }; },
    putImageData() {},
    measureText() { return { width: 0 }; },
    createLinearGradient() { return gradient; },
    createRadialGradient() { return gradient; },
    createConicGradient() { return gradient; },
    createPattern() { return null; },
    getLineDash() { return []; },
    get canvas() { return canvas; },
  }, { get(t, k) { return k in t ? t[k] : () => {}; }, set() { return true; } });
  const canvas = {
    get width() { return width; }, set width(v) { width = v; },
    get height() { return height; }, set height(v) { height = v; },
    getContext() { return ctx; }, toDataURL: () => 'data:,',
  };
  return canvas;
}
globalThis.document = { createElement: (tag) => (tag === 'canvas' ? stubCanvas() : {}) };
setPaletteContext(createPaletteContext({ random: () => 0.5, createCanvas: stubCanvas }));

let fails = 0;
const fail = (msg) => { fails += 1; console.error(`FAIL  ${msg}`); };
const pass = (msg) => console.log(`ok    ${msg}`);

// ── A1. 팔작 유도 관계: 용마루 ≈ 처마폭 − 처마깊이 ──────────────────────────────
// 고증 기준은 평면 45° 추녀 = ridge ≈ xEave·2 − zEave·2. 하한 0.8 은 수정 전 실측 0.51 과
// 확실히 구분되고, 클램프 플로어(max(W·0.12, 1.25·zGable))·캡(W·0.46)이 물리는 케이스는
// 기준치가 작아 자동 통과한다.
const RIDGE_DERIVATION_MIN = 0.8;
for (const [name, preset] of Object.entries(PRESETS)) {
  if (preset.roofType !== 'paljak') continue;
  for (const [frontBays, sideBays] of [[3, 2], [5, 3], [7, 4]]) {
    const L = computeLayout({ ...preset, frontBays, sideBays });
    const ridge = 2 * L.ridgeHalf;
    const ideal = 2 * (L.xEave - L.zEave);
    if (ideal < 1) { pass(`A1 ${name} ${frontBays}x${sideBays}: 기준치 ${ideal.toFixed(2)}m < 1m — 클램프 지배, 통과`); continue; }
    const ratio = ridge / ideal;
    if (ratio < RIDGE_DERIVATION_MIN) {
      fail(`A1 ${name} ${frontBays}x${sideBays}: ridge ${ridge.toFixed(2)}m / 고증기준(처마폭−깊이) ${ideal.toFixed(2)}m = ${ratio.toFixed(2)} < ${RIDGE_DERIVATION_MIN}`);
    } else {
      pass(`A1 ${name} ${frontBays}x${sideBays}: ridge/기준 ${ratio.toFixed(2)}`);
    }
  }
}

// ── A2. 제품 픽스처: 절 누문·종각의 ridge/정면폭 ────────────────────────────────
// 사용자가 지적한 바로 그 건물들. PAVILION 은 항상 팔작이라 조건 없이 단언한다.
const PAVILION_RIDGE_MIN = 0.45; // 수정 전 실측 29%, 수정 후 56%
const PAVILION_ROLES = new Set(['gate-pavilion', 'bell-pavilion']);
let pavilions = 0;
for (const variant of ['compact', 'courtyard', 'extended']) {
  for (const seed of [20273533, 7, 42]) {
    const plan = planTempleCompound({ seed, variant, entryProfile: 'mountain' });
    for (const building of plan.buildings || []) {
      if (!PAVILION_ROLES.has(building.role)) continue;
      pavilions += 1;
      const L = computeLayout(templeHallBuilderPreset(building));
      const ratio = (2 * L.ridgeHalf) / L.W;
      if (ratio < PAVILION_RIDGE_MIN) {
        fail(`A2 ${variant}/${seed}/${building.role}: ridge/정면폭 ${(ratio * 100).toFixed(0)}% < ${PAVILION_RIDGE_MIN * 100}%`);
      }
    }
  }
}
if (pavilions === 0) fail('A2: 누문·종각 픽스처가 한 건도 계획되지 않음 — 게이트 무력화');
else pass(`A2 절 누문·종각 ${pavilions}건 전부 ridge/정면폭 ≥ ${PAVILION_RIDGE_MIN * 100}%`);

// ── B. 궁 지붕형 위계: 부속 소채 맞배 · 주전각 팔작 유지 ─────────────────────────
// 맞배 판별은 layout 기하로 한다: matbae ridgeHalf = W/2 + gableOverhang ≥ W/2,
// paljak ridgeHalf ≤ 0.46·W < W/2 — 두 형이 겹치지 않는 판별식.
{
  let s = 0x2545f491 >>> 0;
  Math.random = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  // merge:false + canvas 스텁 조합에서 three 가 텍스처 직렬화 경고를 뿜는다 — 렌더 무관 노이즈.
  const realWarn = console.warn;
  console.warn = (...a) => { if (!String(a[0]).includes('Unable to serialize Texture')) realWarn(...a); };
  const root = buildPalaceCompound({
    w: 150, d: 120, tier: 'hanyang', seed: 5, mats: makeMaterials('palace'), merge: false,
  });
  console.warn = realWarn;
  let sats = 0, cells = 0, principals = 0;
  root.traverse((node) => {
    const L = node.userData?.layout;
    if (!L || !Number.isFinite(L.ridgeHalf) || !Number.isFinite(L.W)) return;
    const isMatbae = L.ridgeHalf >= L.W / 2;
    if (/^sat-/.test(node.name)) {
      sats += 1;
      if (!isMatbae) fail(`B ${node.name}: 부속 소채가 맞배가 아님 (ridgeHalf ${L.ridgeHalf.toFixed(2)} < W/2 ${(L.W / 2).toFixed(2)})`);
    } else if (/-cell\d+$/.test(node.name)) {
      cells += 1;
      if (!isMatbae) fail(`B ${node.name}: 궐내각사 소전이 맞배가 아님 (ridgeHalf ${L.ridgeHalf.toFixed(2)} < W/2 ${(L.W / 2).toFixed(2)})`);
    } else if (/^hall-/.test(node.userData?.palaceRole || '')) {
      // placeHall 은 `hall-{role}` 로 태깅한다 — 정전·편전·침전·중궁전 등 주전각 전부.
      principals += 1;
      if (isMatbae) fail(`B ${node.userData.palaceRole}: 주전각이 팔작이 아님 (과적용 — ridgeHalf ${L.ridgeHalf.toFixed(2)} ≥ W/2)`);
    }
  });
  if (sats === 0) fail('B: 침전 부속 소채(sat-*)가 한 채도 없음 — 게이트 무력화');
  if (cells === 0) fail('B: 궐내각사 소전(*-cell*)이 한 채도 없음 — 게이트 무력화');
  if (principals === 0) fail('B: 주전각(palaceRole)이 한 채도 없음 — 게이트 무력화');
  if (fails === 0) pass(`B 궁 위계: 부속 소채 ${sats + cells}채 맞배 · 주전각 ${principals}채 팔작 유지`);
}

console.log(fails === 0 ? 'ROOF RIDGE: ALL PASS' : `ROOF RIDGE: ${fails} FAIL`);
process.exit(fails === 0 ? 0 : 1);
