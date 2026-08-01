// Pure contract: the backlit rim survives the aerial / cinematic focus policy, and its distance
// band reaches a subject the camera frames from 300–470 m (village → hanyang aerial and drone).
//
// Why this gate exists. The flagship look is "golden-hour backlit rim + bloom haze", but every
// captured drone/aerial frame shipped with a rim add of exactly 0, from two independent hard
// zeros: (a) the product focus policy turned the rim *master* off together with flare and DoF
// (`setPostFocus(false)` → `uRimScale = 0`), a gate whose original reason — the retired
// screen-space RimPass re-submitting the scene — no longer exists; and (b) the distance band
// clamped to the parcel-lens floor at every fov, so it ended at 253 m while the hanyang aerial
// camera stands 300–470 m from what it frames, putting the subject itself past `far`.
//
// Browser-free: rim.js and the app focus policy are imported for real through esbuild (three runs
// in node for uniform/Object3D reads), and the two lines of post.js/engine.js glue that no node
// process can execute are asserted as source contracts. The live `uRimScale` value on a real drone
// frame is confirmed once in the browser (shoot-rim-aerial.mjs).
//
// CHEOMA_RIM_ROOT points the whole gate at another checkout of the same tree, which is how the
// FAIL-first evidence for this fix was produced (`git archive HEAD src app/src`).
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const ROOT = process.env.CHEOMA_RIM_ROOT ? process.env.CHEOMA_RIM_ROOT : REPO;
const requireApp = createRequire(join(REPO, 'app', 'package.json'));
const esbuild = requireApp('esbuild');
const THREE_MAIN = join(REPO, 'app/node_modules/three/build/three.module.js');
const THREE_ADDONS = join(REPO, 'app/node_modules/three/examples/jsm');

const built = await esbuild.build({
  stdin: {
    // Namespace imports on purpose: a tree without the new exports must reach the assertions and
    // fail on the value, not on the bundle.
    contents: `
      import * as rim from './src/env/rim.js';
      import * as optics from './src/camera/optics.js';
      import * as fogBand from './src/env/village-fog-band.js';
      import * as profiles from './src/env/atmosphere-profiles.js';
      import * as policy from './app/src/engine/focus-policy-runtime.js';
      export { rim, optics, fogBand, profiles, policy };
    `,
    resolveDir: ROOT,
    sourcefile: 'rim-master-entry.js',
  },
  alias: { 'three/addons': THREE_ADDONS, three: THREE_MAIN },
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  write: false,
  logLevel: 'silent',
});

const { rim, optics, fogBand, profiles, policy } = await import(
  `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString('base64')}`
);

let failed = 0;
function ok(cond, msg) {
  if (cond) console.log(`PASS ${msg}`);
  else { console.error(`FAIL ${msg}`); failed++; }
}
const num = (v, digits = 3) => (Number.isFinite(v) ? v.toFixed(digits) : String(v));
const smoothstep = (a, b, x) => {
  if (!(b > a)) return x < a ? 0 : 1;
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// ─────────────────────────────────────────────────────────────────────────────
// 1. The aerial / cinematic focus policy must leave the rim master above zero.
// ─────────────────────────────────────────────────────────────────────────────
console.log('== 1. focus policy: rim master is a weight, not a switch ==');
// Fallback so a tree without the fix still reaches groups 2 and 3 with the master it really
// shipped: `setRimEnabled(false)` in the aerial policy is a literal uRimScale of 0.
const CONTEXT = rim.RIM_CONTEXT_MASTER || { focus: 1, aerial: 0 };
ok(
  !!CONTEXT && CONTEXT.focus === 1 && CONTEXT.aerial > 0 && CONTEXT.aerial <= 1,
  `RIM_CONTEXT_MASTER exports a nonzero aerial floor (focus=${CONTEXT?.focus}, aerial=${CONTEXT?.aerial})`,
);

function drivePolicy(call) {
  const calls = [];
  const post = {
    flarePass: { enabled: true },
    dof: { amount: 1 },
    setRimMaster: (v) => calls.push(['rimMaster', v]),
    setRimEnabled: (v) => calls.push(['rimEnabled', v]),
    setFlareEnabled: (v) => calls.push(['flare', v]),
    setDofAmount: (v) => calls.push(['dof', v]),
  };
  const runtime = policy.createFocusPolicyRuntime({ post });
  const results = [];
  for (const args of call) {
    calls.length = 0;
    runtime.setFocusPolicy(args);
    results.push({ calls: calls.slice(), policy: runtime.policy });
  }
  return results;
}

// setPostFocus(false) — the exact call every aerial arrival and both cinematic boundaries make.
const [aerial, focus, dofOnly] = drivePolicy([
  { focused: false, flare: false, dofAmount: 0 },
  { focused: true, flare: true, dofAmount: 1 },
  { dofAmount: 0.4 },
]);
const masterOf = (r) => r.calls.filter(([k]) => k === 'rimMaster').map(([, v]) => v).pop();
const disabledRim = (r) => r.calls.some(([k, v]) => k === 'rimEnabled' && !v);

ok(
  Number.isFinite(masterOf(aerial)) && masterOf(aerial) > 0,
  `aerial policy keeps the rim master above 0 (master=${num(masterOf(aerial))})`,
);
ok(
  !disabledRim(aerial),
  `aerial policy never calls setRimEnabled(false) (calls=${JSON.stringify(aerial.calls)})`,
);
ok(
  aerial.calls.some(([k, v]) => k === 'flare' && v === false)
    && aerial.calls.some(([k, v]) => k === 'dof' && v === 0),
  'aerial policy still turns flare off and DoF to 0 (only the rim axis changed)',
);
ok(
  masterOf(focus) === CONTEXT.focus,
  `focus policy keeps full rim strength (master=${num(masterOf(focus))}) — no close-focus regression`,
);
ok(
  masterOf(dofOnly) === CONTEXT.focus && dofOnly.policy.rimMaster === CONTEXT.focus,
  `a dofAmount-only tween frame does not disturb the remembered master (master=${num(masterOf(dofOnly))})`,
);

// The master the aerial policy really produces: a tree that disables the rim instead ships 0.
const AERIAL_MASTER = Number.isFinite(masterOf(aerial))
  ? masterOf(aerial)
  : (disabledRim(aerial) ? 0 : CONTEXT.aerial);

// rim.js side of the same chain: the master lands on uRimScale.
const scene = { traverse() {} };
const fresnel = rim.createFresnelRim(scene);
fresnel.setScale(AERIAL_MASTER);
ok(
  fresnel.uniforms.uRimScale.value > 0,
  `uRimScale under the aerial master is nonzero (uRimScale=${num(fresnel.uniforms.uRimScale.value)})`,
);

// The post.js / engine.js glue cannot run without a GL context — assert it as source text.
const postSrc = readFileSync(join(ROOT, 'src/env/post.js'), 'utf8');
const engineSrc = readFileSync(join(ROOT, 'app/src/engine/engine.js'), 'utf8');
ok(
  postSrc.includes('fresnelRim.setScale((enabled && rimOn) ? rimMaster : 0)'),
  'post.js composes uRimScale from the master weight (not a boolean 1/0)',
);
ok(
  postSrc.includes('function setRimMaster(') && postSrc.includes('setRimMaster, setRimViewDistance'),
  'post.js exposes setRimMaster / setRimViewDistance to the product policy',
);
ok(
  postSrc.includes('rimDistanceGate(camera.fov, rimViewDistance)'),
  'post.js feeds the live camera→subject distance into the rim band',
);
ok(
  engineSrc.includes('post.setRimViewDistance?.(physicalDistance)'),
  'engine publishes the camera→subject distance from its camera-dependent environment owner',
);

// ─────────────────────────────────────────────────────────────────────────────
// 2. The distance band must reach a 300–470 m aerial / drone subject.
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n== 2. distance band vs measured aerial framings ==');
const lensBand = rim.rimDistanceGateForFov;
const viewBand = rim.rimDistanceGate;
const bandOf = (fov, d) => (typeof viewBand === 'function' ? viewBand(fov, d) : lensBand(fov));
// Distance fade the subject at its own depth receives: 1 - smoothstep(near, far, d).
const subjectFade = (fov, d) => {
  const band = bandOf(fov, d);
  return 1 - smoothstep(band.near, band.far, d);
};
const SUBJECT_FADE_MIN = 0.60;
console.log('  framing                        fov     d(m)  band near/far (m)   subject df');
const framings = [
  ['hanyang crane-in (measured)', 46, 464],
  ['hanyang pullback-reveal (measured)', 46, 432],
  ['hanyang drone mid (measured)', 34, 366],
  ['hanyang street/orbit (measured)', 24, 298],
  ['capital aerial', 46, 360],
  ['village aerial', 46, 353],
];
for (const [label, fov, d] of framings) {
  const band = bandOf(fov, d);
  const df = subjectFade(fov, d);
  console.log(`  ${label.padEnd(30)} ${String(fov).padStart(3)} ${String(d).padStart(8)}  ${num(band.near, 1).padStart(7)}/${num(band.far, 1).padStart(7)}   ${num(df)}`);
  ok(df >= SUBJECT_FADE_MIN, `${label}: subject stays inside the band (df=${num(df)} >= ${SUBJECT_FADE_MIN})`);
}

// The band may only ever extend the lens band, which is what protects every shipped close framing.
let extendsOnly = true;
for (const fov of [7, 9, 12, 16, 24, 34, 40, 46]) {
  for (const d of [0, 1, 30, 60, 170, 298, 464, 900]) {
    const lens = lensBand(fov);
    const band = bandOf(fov, d);
    if (!(band.near >= lens.near - 1e-9 && band.far >= lens.far - 1e-9 && band.far > band.near)) {
      extendsOnly = false;
    }
  }
}
ok(extendsOnly, 'the view term only extends the lens band (near/far never shrink) — close framings keep their numbers');
for (const bad of [0, -10, NaN, undefined, null]) {
  const band = bandOf(16, bad);
  const lens = lensBand(16);
  ok(
    Math.abs(band.near - lens.near) < 1e-9 && Math.abs(band.far - lens.far) < 1e-9,
    `a missing view distance (${String(bad)}) falls back to the lens band exactly`,
  );
}
// Regression witnesses for the two authored close framings.
for (const [label, fov, d] of [['parcel closeup', 16, 60], ['hero settle', 7, 170]]) {
  const before = 1 - smoothstep(lensBand(fov).near, lensBand(fov).far, d);
  const after = subjectFade(fov, d);
  console.log(`  ${label}: lens-only df ${num(before)} → live df ${num(after)}`);
  ok(after >= before - 1e-9, `${label} rim is not weakened (${num(before)} → ${num(after)})`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. The shipped energy chain, expanded on an aerial backlit eave fragment.
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n== 3. rim add on an aerial backlit eave fragment (sunset) ==');
const FRES_STR_MUL = 1.85;
ok(
  postSrc.includes(`fresnelRim.setStrength(enabled ? rimBase * ${FRES_STR_MUL} : 0)`)
    && postSrc.includes('THREE.MathUtils.smoothstep(cur.dir.y, 0.20, 0.52)'),
  'post.js strength chain matches the expansion below (rimBase × 1.85, altGate 0.20–0.52)',
);

function chainFor(timeName) {
  const P = profiles.resolvePostProfile(timeName, profiles.DEFAULT_SUNSET_LOOK);
  const A = profiles.resolveAtmosphereProfile(timeName, profiles.DEFAULT_SUNSET_LOOK);
  const len = Math.hypot(...A.sunDir);
  const dirY = A.sunDir[1] / len;
  const altGate = 1 - smoothstep(0.20, 0.52, dirY);
  return {
    dirY,
    altGate,
    strength: P.rim * altGate * FRES_STR_MUL,
    power: P.rimPower + 3.2,
    wrap: Math.max(rim.RIM_WRAP_FLOOR, P.rimWrap * 0.4),
  };
}

const rimSrc = readFileSync(join(ROOT, 'src/env/rim.js'), 'utf8');
// Which composition the tree under test actually ships. The expansion below reproduces *both*, so
// pointing CHEOMA_RIM_ROOT at a pre-fix checkout produces that tree's real numbers rather than the
// new formula evaluated with old constants — that is what makes group 5 genuine FAIL-first
// evidence instead of a tautology.
const SHADE_FORM = rimSrc.includes('float _sunShade = 1.0 - smoothstep(')
  && rimSrc.includes('float _sunFacing = mix(uRimWrap, 1.0, _sunShade);');
const EVIDENCE_FORM = rimSrc.includes(
  'max(smoothstep(${directStart}, ${directFull}, _directLuma), _sunShade)',
);

// One backlit eave-edge fragment: grazing silhouette, face averted from the sun, in its own shade.
//
// Two independent shading facts, deliberately kept apart (they were conflated before the
// 2026-08-01 inversion fix):
//   sunN       — orientation of the fragment relative to the sun. Negative = the surface is turned
//                away, so stock diffuse gives it nothing. This is *self* shade, not occlusion.
//   castShadow — the main sun is blocked by other geometry (_mainSunVisibility → 0).
function rimAdd({
  time = 'sunset', fov, viewDistance, depth, terrainR, sunN, castShadow = false, master,
  group = 'building', ndv = 0.05, backlitDot = 0.9,
}) {
  const C = chainFor(time);
  // 프레넬 지수는 재질군별이다(유기물만 상향 — 큰 평면 패싯 대신 실루엣만 훑게).
  const powerMul = rim.RIM_GROUP_POWER_MUL ? (rim.RIM_GROUP_POWER_MUL[group] ?? 1) : 1;
  const fres = (1 - ndv) ** (C.power * powerMul);
  const silhouette = 1 - smoothstep(rim.RIM_FACING_GATE.full, rim.RIM_FACING_GATE.cutoff, ndv);
  const S = rim.RIM_SOLAR_GATE;
  const solarRamp = smoothstep(S.facingStart, S.facingFull, sunN);
  const sunShade = 1 - solarRamp;
  // Fixed tree: the wrap taper runs on the *lit* side. Pre-fix tree: a signed sun-direction gate.
  const sunFacing = C.wrap + (1 - C.wrap) * (SHADE_FORM ? sunShade : solarRamp);
  const backlit = S.backlitFloor + (1 - S.backlitFloor) * smoothstep(S.backlitStart, S.backlitFull, backlitDot);
  // reflectedLight.directDiffuse is ~0 for an averted face and for an occluded one alike; the
  // fixed shader restores the difference with max(directRamp, _sunShade).
  const directRamp = (!castShadow && sunN > S.backlitStart) ? 1 : 0;
  const visibility = castShadow ? 0 : 1;
  const evidence = EVIDENCE_FORM ? Math.max(directRamp, sunShade) : directRamp;
  const directGate = S.shadowFloor + (1 - S.shadowFloor) * evidence * visibility;
  const band = bandOf(fov, viewDistance);
  const fog = fogBand.villageFogBand(viewDistance, terrainR);
  const fogFactor = smoothstep(fog.near, fog.far, depth);
  const df = (1 - smoothstep(band.near, band.far, depth)) * (1 - Math.min(1, Math.max(0, fogFactor)));
  const raw = fres * silhouette * sunFacing * backlit * directGate * df * C.strength;
  const capped = Math.min(Math.max(raw, 0), rim.RIM_BASE_ENERGY_CAP);
  return {
    band, fogFactor, df, capped, raw, sunFacing, directGate,
    add: capped * rim.RIM_GROUP_MUL[group] * master,
    peak: rim.RIM_BASE_ENERGY_CAP * rim.RIM_GROUP_MUL.building * CONTEXT.focus,
  };
}

const AERIAL_PEAK_MIN = 0.06;   // fraction of the authored peak add
const tiers = [
  ['village aerial', 46, 353, 236],
  ['capital aerial', 46, 360, 412],
  ['hanyang crane-in', 46, 464, 512],
  ['hanyang pullback', 46, 432, 512],
];
console.log('  tier                 fov   d(m)  TR(m)  fog@d    df   add(linear)  %ofPeak');
for (const [label, fov, d, TR] of tiers) {
  const r = rimAdd({
    fov, viewDistance: d, depth: d, terrainR: TR, sunN: -0.35, castShadow: true, master: AERIAL_MASTER,
  });
  const pct = 100 * r.add / r.peak;
  console.log(`  ${label.padEnd(20)} ${String(fov).padStart(3)} ${String(d).padStart(6)} ${String(TR).padStart(6)}  ${num(r.fogFactor)}  ${num(r.df)}   ${num(r.add, 4)}      ${pct.toFixed(1)}%`);
  ok(r.add > 0, `${label}: backlit eave receives a nonzero rim add (${num(r.add, 4)})`);
  ok(
    pct >= 100 * AERIAL_PEAK_MIN,
    `${label}: backlit add is at least ${(100 * AERIAL_PEAK_MIN).toFixed(0)}% of the authored peak (${pct.toFixed(1)}%)`,
  );
}

// Optical reality must survive the master: no sun behind the subject, no rim.
const noon = chainFor('day');
console.log(`\n  noon: sunDir.y=${num(noon.dirY)} → altGate=${num(noon.altGate)} → uRimStrength=${num(noon.strength)}`);
const noonAdd = rimAdd({
  time: 'day', fov: 46, viewDistance: 464, depth: 464, terrainR: 512,
  sunN: -0.35, castShadow: true, master: AERIAL_MASTER,
});
ok(noon.altGate === 0 && noonAdd.add === 0, `noon still erases the rim entirely (add=${num(noonAdd.add, 4)})`);

// Front-lit reference, reported here and asserted in group 5 (the _sunFacing / _directGate
// balance was a separate, user-gated axis until the 2026-08-01 inversion fix).
const frontLit = rimAdd({
  fov: 46, viewDistance: 464, depth: 464, terrainR: 512, sunN: 0.2, castShadow: false, master: AERIAL_MASTER,
});
const backLit = rimAdd({
  fov: 46, viewDistance: 464, depth: 464, terrainR: 512, sunN: -0.35, castShadow: true, master: AERIAL_MASTER,
});
console.log(`  hanyang crane-in, backlit ${num(backLit.add, 4)} vs sun-facing sliver ${num(frontLit.add, 4)} (ratio ${num(backLit.add / Math.max(frontLit.add, 1e-9), 2)})`);

// Group hierarchy must stay building > misc > organic so a lit aerial canopy cannot outshine roofs.
const canopy = rimAdd({
  fov: 46, viewDistance: 464, depth: 464, terrainR: 512, sunN: -0.35, castShadow: true,
  master: AERIAL_MASTER, group: 'organic',
});
ok(
  canopy.add < backLit.add,
  `aerial canopy stays below building rim (organic ${num(canopy.add, 4)} < building ${num(backLit.add, 4)})`,
);

// ─────────────────────────────────────────────────────────────────────────────
// 4. 유기물은 선으로만 림을 받아야 한다 (면 범람 금지).
// ─────────────────────────────────────────────────────────────────────────────
// 비전 A/B 판정에서 유기물이 림을 선이 아니라 **면**으로 받고 있었다: 부감 차분 최대 지점이
// 건물이 아니라 나무였고 수관 상단 패싯이 불투명한 갈색 덩어리로 읽혔다(수도 부감 +33 루마,
// 녹색 우세 픽셀 평균 상승이 비녹색의 13.0배, 한양 진입에서 전경 수관 > 한옥 지붕으로 실루엣
// 위계 역전). 실패 축은 거리가 아니라 기하이므로(면 범람 비율이 가까울수록 증가: 마을 부감 0%
// → 한양 진입 80.6%) 계수 인하만으로는 부족하고 지수가 각도 형태를 담당해야 한다.
console.log('\n== 4. organic: silhouette line only, never a flooded facet ==');
const POWER_MUL = rim.RIM_GROUP_POWER_MUL;
ok(
  !!POWER_MUL && POWER_MUL.organic > POWER_MUL.building,
  `organic Fresnel exponent is raised above building (organic=${POWER_MUL?.organic}, building=${POWER_MUL?.building})`,
);
ok(
  rim.RIM_GROUP_MUL.organic <= 0.30,
  `organic group multiplier is pulled to the vision-measured level (${rim.RIM_GROUP_MUL.organic} <= 0.30)`,
);
ok(
  rimSrc.includes('pow(1.0 - _ndv, uRimPower * uRimGroupPowerMul)'),
  'the shader takes its exponent per material group (one shared source, no new program family)',
);
ok(
  fresnel.groupPowerMultipliers
    && fresnel.groupPowerMultipliers.organic === POWER_MUL?.organic
    && fresnel.groupPowerMultipliers.building === POWER_MUL?.building,
  `the per-group exponent uniform is really wired (${JSON.stringify(fresnel.groupPowerMultipliers)})`,
);

// 부감 수도 프레이밍의 근거리 유기물. 같은 프래그먼트 조건에서 건물과 직접 비교한다.
const FACET_MAX_RATIO = 0.12;   // 패싯 대역에서 유기물은 건물의 12% 를 넘지 않는다
// 접선 에지 하한(완전 소거 금지). 0.10 → 0.05 재핀(2026-08-01): 종전 0.10 은 계수 0.30 의 실측
//   비율(≈0.18)의 절반에 놓은 마진이었는데, 2차 비전 판정이 색상 역전 임계(k≈0.24) 아래인 0.15 를
//   확정하면서 실측 비율이 0.092 로 내려왔다. 같은 파생 철학(실측의 절반)으로 0.05 에 둔다 —
//   유기물 림을 통째로 끄거나 계수를 ~0.08 아래로 내리는 회귀는 여전히 잡는다(비율은 계수에
//   선형이므로 0 이면 0). FAIL-first: 계수 0.15 반영 전 소스(0.30 기준 하한 0.10)에서 이 단언이
//   ratio 0.092 로 실제로 실패함을 확인하고 재핀했다.
const EDGE_MIN_RATIO = 0.05;    // 그러나 접선 에지에서는 선이 살아 있어야 한다(완전 소거 금지)
const facetCase = (ndv, group) => rimAdd({
  fov: 46, viewDistance: 262.7, depth: 200, terrainR: 412,
  sunN: -0.35, castShadow: true, master: AERIAL_MASTER, group, ndv,
});
console.log('  ndv     building add   organic add   organic/building');
for (const ndv of [0.02, 0.06, 0.20, 0.25, 0.32]) {
  const b = facetCase(ndv, 'building').add;
  const o = facetCase(ndv, 'organic').add;
  const ratio = o / Math.max(b, 1e-12);
  console.log(`  ${ndv.toFixed(2)}    ${num(b, 4).padStart(8)}     ${num(o, 4).padStart(8)}      ${num(ratio, 3)}`);
  if (ndv >= 0.20) {
    ok(ratio <= FACET_MAX_RATIO, `facet ndv=${ndv}: organic stays under ${FACET_MAX_RATIO} of building (${num(ratio, 3)})`);
  }
}
const edgeRatio = facetCase(0.02, 'organic').add / Math.max(facetCase(0.02, 'building').add, 1e-12);
ok(
  facetCase(0.02, 'organic').add > 0 && edgeRatio >= EDGE_MIN_RATIO,
  `tangent edge keeps an organic silhouette line (ratio ${num(edgeRatio, 3)} >= ${EDGE_MIN_RATIO})`,
);
// 각도에 따라 위계가 벌어져야 한다 — 종전에는 계수만 있어 모든 각도에서 0.467 로 일정했다.
ok(
  edgeRatio > facetCase(0.25, 'organic').add / Math.max(facetCase(0.25, 'building').add, 1e-12) * 2,
  'the organic/building ratio widens with the facet angle (a flat coefficient cannot do this)',
);

// ─────────────────────────────────────────────────────────────────────────────
// 5. 역광 실루엣이 피크여야 한다 — 순광면이 아니라 (2026-08-01 역전 해소, #35 라운드3).
// ─────────────────────────────────────────────────────────────────────────────
// 결함: 프래그먼트 게이트 둘이 같은 사실(면이 태양을 등졌다)을 두 번 벌했다. `_sunFacing` 은
// dot(N, sun) < 0 을 uRimWrap 바닥 0.10 으로(10배 감쇠), `_directGate` 는 그 면의 directDiffuse
// 가 0 이라는 이유로 shadowFloor 0.45 로(2.22배) 내렸다. 역광 피사체의 카메라 대면 플랭크는
// 정의상 두 조건을 동시에 만족하므로 게이트 곱이 4.5% 만 남았고, 반대로 태양쪽으로 살짝 기운
// 슬리버는 두 게이트 모두 1.0 을 받아 상한을 포화시켰다 — 림이 순광에서 가장 밝고 역광
// 실루엣에서 가장 어두운, 룩 계약의 정확한 반대.
//
// 처방(사용자 승인 P2c): 뷰 레벨 "태양이 피사체 뒤"는 `_backlit` 이 이미 판정하므로 프래그먼트
// 레벨은 "이 에너지를 stock BRDF 가 이미 전달했는가"만 답한다. 터미네이터 안팎에서는 아니므로
// 전량(빛 감싸기), 태양을 향해 돌아선 면에서는 그렇므로 하늘 산란 바닥까지 테이퍼. 그림자항은
// 실제 가림(_mainSunVisibility)만 남긴다.
console.log('\n== 5. backlit silhouette is the peak, not the front-lit sliver ==');
ok(SHADE_FORM, 'the shader derives _sunFacing from a light-wrap shade term, not a signed sun gate');
ok(
  EVIDENCE_FORM,
  'the shadow term takes max(direct evidence, _sunShade) so orientation is not charged twice',
);
ok(
  rim.RIM_SOLAR_GATE.facingFull > rim.RIM_SOLAR_GATE.backlitFull,
  `the wrap taper completes on the lit side of the terminator (facingFull=${rim.RIM_SOLAR_GATE.facingFull})`,
);

// 히어로 프레이밍(16°/60 m 마을)의 한 프래그먼트를 sunN 만 바꿔가며 전개한다.
const heroAt = (sunN, castShadow = false, ndv = 0.05) => rimAdd({
  fov: 16, viewDistance: 60, depth: 60, terrainR: 236,
  sunN, castShadow, master: CONTEXT.focus, ndv,
});
const antiSun = heroAt(-0.9);           // 역광 피사체의 카메라 대면 플랭크(자기 그늘, 가림 없음)
const tangentSun = heroAt(0.0);         // 접선(터미네이터) — 저작된 피크가 놓여야 하는 지점
const sunSliver = heroAt(0.2);          // 태양쪽으로 살짝 기운 슬리버(직사광 있음)
console.log('  hero 16°/60 m   sunN   _sunFacing  _directGate     raw   add(linear)  %ofPeak');
for (const [label, r, sunN] of [
  ['anti-sun flank ', antiSun, -0.9], ['tangent        ', tangentSun, 0.0], ['sun sliver     ', sunSliver, 0.2],
]) {
  console.log(`  ${label} ${String(sunN).padStart(5)}   ${num(r.sunFacing)}      ${num(r.directGate)}   ${num(r.raw, 4)}    ${num(r.add, 4)}     ${(100 * r.add / r.peak).toFixed(1)}%`);
}
const ANTI_SUN_PEAK_MIN = 0.60;
ok(
  antiSun.add >= ANTI_SUN_PEAK_MIN * tangentSun.add,
  `the sun-opposite backlit flank reaches ${(100 * ANTI_SUN_PEAK_MIN).toFixed(0)}% of the tangent peak `
  + `(${num(antiSun.add, 4)} / ${num(tangentSun.add, 4)} = ${(100 * antiSun.add / Math.max(tangentSun.add, 1e-12)).toFixed(1)}%)`,
);
ok(
  sunSliver.add <= antiSun.add + 1e-12 && sunSliver.raw < antiSun.raw,
  `a sun-facing sliver never outshines it (add ${num(sunSliver.add, 4)} <= ${num(antiSun.add, 4)}, `
  + `uncapped ${num(sunSliver.raw, 3)} < ${num(antiSun.raw, 3)})`,
);

// 상한 아래 대역의 증인. ndv 0.05 는 sunset 강도에서 양쪽 모두 캡을 포화시키므로 위 단언만으로는
// 부등호가 등호로 만족될 수 있다. 부감 46°/464 m·ndv 0.28 은 캡 아래라 실제 크기를 비교한다.
const subCap = (sunN, castShadow) => rimAdd({
  fov: 46, viewDistance: 464, depth: 464, terrainR: 512,
  sunN, castShadow, master: AERIAL_MASTER, ndv: 0.28,
});
const subBack = subCap(-0.9, false);
const subFront = subCap(0.2, false);
const subOccluded = subCap(-0.9, true);
console.log(`  sub-cap aerial ndv 0.28: anti-sun ${num(subBack.add, 4)} | sun sliver ${num(subFront.add, 4)} | anti-sun occluded ${num(subOccluded.add, 4)}`);
ok(
  subBack.capped < rim.RIM_BASE_ENERGY_CAP && subFront.add < subBack.add,
  `below the energy cap the backlit flank is strictly brighter than the sun sliver (${num(subFront.add, 4)} < ${num(subBack.add, 4)})`,
);
// 이중 처벌 해소가 그림자 항을 무력화하면 안 된다: 진짜 가림은 여전히 shadowFloor 로 감쇠한다.
ok(
  subOccluded.add < subBack.add,
  `a genuinely cast-shadowed fragment is still attenuated (${num(subOccluded.add, 4)} < ${num(subBack.add, 4)})`,
);
// 정오·에너지 캡은 이 축과 무관하게 유지된다(그룹 3 의 noon 단언과 함께 읽을 것).
ok(
  antiSun.capped <= rim.RIM_BASE_ENERGY_CAP + 1e-12
    && tangentSun.capped <= rim.RIM_BASE_ENERGY_CAP + 1e-12,
  `the HDR energy cap still bounds both (${num(antiSun.capped, 3)}, ${num(tangentSun.capped, 3)} <= ${rim.RIM_BASE_ENERGY_CAP})`,
);

if (failed) {
  console.error(`\nRIM MASTER: FAIL (${failed})`);
  process.exit(1);
}
console.log('\nRIM MASTER: PASS');
