// 조립(시공) 애니메이션 순수 계약 — 브라우저 없음. src/anim/assembly.js 는 프레임워크 무관이고
// position.y·scale·visible 만 쓰므로, 이 라운드의 거의 모든 주장은 순수 계산으로 판정된다.
//
// 판정 항목
//   ① 모멘텀 연속 정착: 접촉 순간 상승 속도가 0 이 아니고(구 모델은 정확히 0), 정착 스프링의
//      초기속도가 바로 그 속도이며, 위치·스케일이 접촉을 C1 으로 통과한다. 정착은 스쿼시
//      (sy<1·sxz>1)를 거쳐 u=1 에서 **정확히** 항등으로 수렴한다(잔여 오프셋 0).
//   ② 부재 리플: 반복 부재(기둥열)의 이웃 시간차가 지각 하한 위에 있고(구 코드는 ~26ms=1.5프레임),
//      순서가 배열 인덱스가 아니라 기하(켜↑ → 칸 훑기)에서 유도된다.
//   ③ 청크 내부 켜 흐름: 지붕 기와 통덩어리가 처마(낮은 면)에서 용마루(높은 면) 순으로 흐른다.
//   ④ 원상복구: 완료·skip()·seek(1) 이 저장된 원값과 **정확히** 같다(부동소수 오차 0).
//   ⑤ 착공 전 무노출: applyAt(0) 이 모든 대상 자식을 숨긴다(완성본 1프레임 노출 0).
//   ⑥ 종가(buildHanok) 파트 그룹 계약: 몸채가 통짜가 아니라 부재 이름 그룹을 갖고, 그 그룹 밖에
//      렌더 가능한 직속 자식이 남지 않는다(남으면 그 부재만 t=0 에 완성 상태로 보인다).
//   ⑦ 결정론: 타이밍 계획이 rng 를 소비하지 않아 두 번 만들면 바이트 동일(worker/sync 해시 불침해).
//   ⑧ 상량 인양 물리: 내려앉는 부재는 중력처럼 가속하고, 호버 높이는 건물 높이의 30% 이하이며,
//      그래도 접촉 속도는 승인 밴드(3.3~4.4 m/s)를 지키고, 강체 좌대가 그 모멘텀을 여행거리 6% 이하
//      한 번의 안착으로 흡수하고, 롤 정렬이 접촉에서 정확히 0 이 된다. 올라오는 부재는 불변.
//      접촉 속도 밴드는 합성 fixture 와 **실제 종가** 양쪽에서 본다(⑧-real b) — 합성 fixture 의
//      totalH=12 는 폴백 값이라 dropBase 파생 회귀를 못 잡는다.
//
// 변경 전 코드에서 실패하는 단언(의도된 회귀 게이트):
//   ① contact velocity(=0) · settle squash 없음 · 접촉 스케일 정확히 1
//   ② rippleSec ≈ 0.026s · 순서가 배열 인덱스
//   ③ courseFlow=false
//   ⑥ buildHanok 파트 그룹 부재 · buildHanok 이 userData.layout.totalH 를 달지 않아 폴백 12m 사용
//   ⑧ 하강이 감속(엘리베이터) · 호버 44% · 정착 오버슈트 36cm 3연속 호핑 · 롤 정렬 없음
//   ⑧-real(b) 실제 종가 접촉 속도 2.95 m/s (공중 창을 dropBase 파생 비율로 좁혀 속도가 흔들림)
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const requireApp = createRequire(join(ROOT, 'app', 'package.json'));
const esbuild = requireApp('esbuild');
const THREE_MAIN = join(ROOT, 'app/node_modules/three/build/three.module.js');
const THREE_ADDONS = join(ROOT, 'app/node_modules/three/examples/jsm');

const built = await esbuild.build({
  stdin: {
    contents: "export { buildHanok, playAssembly, tofuBob, tofuRise, tofuScale } from './src/api/building.js';"
      + " export { makeMaterials } from './src/builder/palette.js';"
      + " export * as THREE from 'three';",
    resolveDir: ROOT,
    sourcefile: 'assembly-contract-entry.js',
  },
  alias: { 'three/addons': THREE_ADDONS, three: THREE_MAIN },
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  write: false,
  logLevel: 'silent',
});

// 팔레트는 canvas 2D 로 텍스처를 그린다. 이 계약은 **씬 그래프 구조**만 보므로 픽셀 없는
//   canvas 스텁으로 충분하다(check-opening-glow-catalog.mjs 와 동일 패턴).
function makeCanvas() {
  const noop = () => {};
  const gradient = Object.freeze({ addColorStop: noop });
  let canvas;
  const context = new Proxy({}, {
    get(target, key) {
      if (key === 'canvas') return canvas;
      if (key === 'createLinearGradient' || key === 'createRadialGradient') return () => gradient;
      if (key === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
      if (!(key in target)) target[key] = noop;
      return target[key];
    },
    set(target, key, value) { target[key] = value; return true; },
  });
  canvas = { width: 0, height: 0, getContext: () => context };
  return canvas;
}
globalThis.document = globalThis.document || { createElement: () => makeCanvas() };

const moduleUrl = `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString('base64')}`;
const {
  buildHanok, playAssembly, tofuBob, tofuRise, tofuScale, makeMaterials, THREE,
} = await import(moduleUrl);

// 실패 메시지만 남긴다(번들이 data: URL 이라 스택에 모듈 전체가 실려 출력이 폭발한다).
process.on('uncaughtException', (error) => {
  console.error(`ASSEMBLY CONTRACT: FAIL — ${error.message}`);
  process.exit(1);
});

const IMPACT = 0.5;
const AMP = 0.3;
const near = (a, b, eps, label) => assert.ok(Math.abs(a - b) <= eps,
  `${label}: ${a} vs ${b} (eps ${eps})`);

// ── ① 모멘텀 연속 정착 ────────────────────────────────────────────────────────────────
// 위치 오프셋(drop 배수). 상승은 음수에서 0 으로, 정착은 0 주변 감쇠 진동.
const posAt = (u) => -tofuRise(u) + tofuBob(u, AMP);
const h = 1e-6;
const vBefore = (posAt(IMPACT - h) - posAt(IMPACT - 3 * h)) / (2 * h);
const vAfter = (posAt(IMPACT + 3 * h) - posAt(IMPACT + h)) / (2 * h);
assert.ok(vBefore > 0.5,
  `arrival is not carrying momentum into contact (v=${vBefore.toFixed(4)} drop/u) — a zero-velocity `
  + 'arrival can only be followed by an independent bolted-on wobble');
near(vAfter, vBefore, Math.abs(vBefore) * 0.02, 'position velocity is not continuous through contact');

const syBefore = tofuScale(IMPACT - h, AMP).sy;
const syAfter = tofuScale(IMPACT + h, AMP).sy;
assert.ok(syBefore > 1.02,
  `member is not still stretched at contact (sy=${syBefore.toFixed(4)}) — the settle has no stored `
  + 'deformation to release, so any wobble would be authored rather than inherited');
near(syAfter, syBefore, 1e-4, 'squash&stretch value jumps at contact');
const dsBefore = (tofuScale(IMPACT - h, AMP).sy - tofuScale(IMPACT - 3 * h, AMP).sy) / (2 * h);
const dsAfter = (tofuScale(IMPACT + 3 * h, AMP).sy - tofuScale(IMPACT + h, AMP).sy) / (2 * h);
near(dsAfter, dsBefore, Math.max(1, Math.abs(dsBefore)) * 0.05,
  'squash&stretch derivative jumps at contact');

// 정착이 실제로 눌린다(푸딩) — 부피보존 방향(sy<1 ↔ sxz>1)까지 함께 본다.
let minSy = Infinity, minSyU = 0, maxBob = 0;
for (let i = 1; i < 4000; i++) {
  const u = IMPACT + (1 - IMPACT) * (i / 4000);
  const s = tofuScale(u, AMP);
  if (s.sy < minSy) { minSy = s.sy; minSyU = u; }
  maxBob = Math.max(maxBob, tofuBob(u, AMP));
}
assert.ok(minSy < 1 - 0.02, `settle never squashes (min sy=${minSy.toFixed(4)}) — no pudding`);
assert.ok(tofuScale(minSyU, AMP).sxz > 1, 'squash is not volume-preserving (sxz did not widen)');
assert.ok(maxBob > 0.02 && maxBob < 0.20,
  `settle overshoot ${maxBob.toFixed(4)} of drop is outside the pudding band (0.02..0.20) — 0 is dead, `
  + 'large is a trampoline bounce');

// 정확한 수렴: u→1 에서 잔여 오프셋·잔여 변형 0, u=1 은 정확히 항등.
assert.ok(Math.abs(tofuBob(1 - 1e-9, AMP)) < 1e-6, 'settle leaves a residual vertical offset at t=1');
assert.ok(Math.abs(tofuScale(1 - 1e-9, AMP).sy - 1) < 1e-6, 'settle leaves a residual scale at t=1');
assert.equal(tofuRise(1), 0, 'rise offset is nonzero at t=1');
assert.equal(tofuBob(1, AMP), 0, 'settle offset is nonzero at t=1');
assert.deepEqual(tofuScale(1, AMP), { sy: 1, sxz: 1 }, 'scale is not identity at t=1');
assert.deepEqual(tofuScale(0, AMP), { sy: 1, sxz: 1 }, 'scale is not identity at t=0');
assert.equal(tofuRise(0), 1, 'rise does not start a full drop below rest');

// 정착은 접촉에서 **물려받은** 변형이 잦아드는 하나의 운동이어야 한다:
//   (a) 정착창 안 최대 변형은 접촉 순간(w≈0)에 있다 — 중간에 더 큰 변형이 새로 생기면 그것이
//       바로 사용자가 기각한 "다 지어진 다음에 덜렁거리는" 독립 반동이다.
//   (b) 이후 |변형| 국소 최대는 단조 감소(재가진 없음).
{
  const samples = [];
  for (let i = 0; i <= 4000; i++) {
    const u = IMPACT + (1 - IMPACT) * (i / 4000);
    samples.push(Math.abs(tofuScale(u, AMP).sy - 1));
  }
  const peaks = [];
  for (let i = 1; i < samples.length - 1; i++) {
    if (samples[i] >= samples[i - 1] && samples[i] > samples[i + 1]) peaks.push({ i, v: samples[i] });
  }
  assert.ok(samples[0] >= Math.max(...samples) - 1e-9,
    'the largest settle deformation is not the one inherited at contact — an independent rebound was added');
  for (let i = 1; i < peaks.length; i++) {
    assert.ok(peaks[i].v < peaks[i - 1].v,
      `settle re-excites at sample ${peaks[i].i} (${peaks[i].v} >= ${peaks[i - 1].v})`);
  }
  assert.ok(peaks.length <= 3, `settle rings ${peaks.length} times — reads as repeated jiggling`);
}

// ── 합성 트리(기와집 골격과 같은 구조) ─────────────────────────────────────────────────
// 실제 팔레트는 canvas 텍스처를 요구하므로, 순수 노드에서는 같은 **이름 규약·좌표 배치**의
// 최소 트리로 playAssembly 의 순서·타이밍·복구를 판정한다.
const mat = new THREE.MeshBasicMaterial();
const BAYS = 6;
const BAY_W = 2.4;
function box(w, hh, d, x, y, z) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, hh, d), mat);
  m.position.set(x, y, z);
  return m;
}
function makeHouse() {
  const root = new THREE.Group();
  root.name = 'building';
  root.userData.layout = { totalH: 12 };

  const podium = new THREE.Group(); podium.name = 'podium';
  podium.add(box(16, 0.14, 8, 0, 0.07, 0));    // 지대석
  podium.add(box(15, 0.36, 7, 0, 0.32, 0));    // 기단 몸통
  podium.add(box(15.4, 0.11, 7.4, 0, 0.56, 0)); // 갑석
  root.add(podium);

  const columns = new THREE.Group(); columns.name = 'columns';
  // 6칸 × 앞뒤 2열 = 기둥 12본. 같은 칸(같은 x)의 앞뒤 기둥은 한 랭크로 묶여야 한다.
  for (let b = 0; b < BAYS; b++) {
    const x = (b - (BAYS - 1) / 2) * BAY_W;
    for (const z of [2, -2]) columns.add(box(0.32, 2.2, 0.32, x, 0.5 + 1.1, z));
  }
  columns.add(box(15, 0.12, 7, 0, 1.77, 0));   // 중인방(기둥 위 켜)
  columns.add(box(15, 0.16, 7, 0, 2.62, 0));   // 창방(기둥머리 켜)
  root.add(columns);

  const walls = new THREE.Group(); walls.name = 'walls';
  walls.add(box(15, 2.2, 7, 0, 1.6, 0));
  walls.add(box(3, 1.6, 0.1, 0, 1.4, 3.5));
  root.add(walls);

  const roof = new THREE.Group(); roof.name = 'roof';
  roof.userData.asmChunked = true;
  for (let i = 0; i < 3; i++) {
    const r = box(15, 0.1, 2, 0, 3.1 + i * 0.05, (i - 1) * 2);
    r.userData.asmGroup = 'rafters';
    roof.add(r);
  }
  // 기와면: 처마(낮은 y) → 용마루(높은 y) 순으로 흘러야 한다.
  for (let i = 0; i < 4; i++) roof.add(box(15, 0.3, 2, 0, 3.4 + i * 0.5, 0));
  // Physical shell pair (real builders name these). Must stay visibility-locked and
  // must not appear before the rigid roof reaches contact (column-band z-fight).
  {
    const outer = box(15, 0.05, 4, 0, 3.55, 0);
    outer.name = 'roof-tile-outer';
    outer.userData.asmGroup = 'body';
    roof.add(outer);
    const gaepan = box(15, 0.05, 4, 0, 3.45, 0);
    gaepan.name = 'roof-gaepan';
    gaepan.userData.asmGroup = 'body';
    roof.add(gaepan);
    const band = box(15, 0.08, 0.12, 0, 3.5, 2.1);
    band.name = 'roof-eave-band';
    band.userData.asmGroup = 'body';
    roof.add(band);
  }
  for (const x of [-7, 7]) {
    const f = box(0.4, 0.4, 0.4, x, 5.4, 0);
    f.userData.asmGroup = 'finial';
    roof.add(f);
  }
  root.add(roof);
  return root;
}

const DUR = 5.0;
const house = makeHouse();
const anim = playAssembly(house, { duration: DUR });
const plan = anim.plan();
const byPart = new Map(plan.map((p) => [p.part, p]));

// ── ② 부재 리플 ───────────────────────────────────────────────────────────────────────
const cols = byPart.get('columns');
assert.ok(cols, 'columns part window is missing from the assembly plan');
assert.equal(cols.members, BAYS * 2 + 2, 'synthetic column set changed — update the fixture');
// 같은 칸의 앞뒤 기둥이 한 랭크로 묶이고, 켜(중인방·창방)가 별도 랭크가 된다.
assert.equal(cols.ranks, BAYS + 2,
  `columns resolved into ${cols.ranks} ripple ranks (expected ${BAYS + 2}: ${BAYS} bays + 2 courses) — `
  + 'the order is not being derived from the footprint');
// 지각 하한: 60fps 에서 4 프레임 이상. 종전 (창폭*0.4)/(부재수-1) 은 5s 기준 ~0.021s(1.3프레임).
assert.ok(cols.rippleSec >= 0.06,
  `neighbour ripple offset ${(cols.rippleSec * 1000).toFixed(1)}ms is below the perceptual floor `
  + '(needs >= 60ms so the sweep resolves into frames)');
assert.ok(cols.rippleSec <= 0.35,
  `neighbour ripple offset ${(cols.rippleSec * 1000).toFixed(1)}ms is a slow parade, not "아주 약간의 시간차"`);
// 순서: 시작시각이 랭크 순서로 단조 증가(결정론 지터가 순서를 뒤집지 않는다).
for (let i = 1; i < cols.starts.length; i++) {
  assert.ok(cols.starts[i] > cols.starts[i - 1],
    `ripple start times are not monotonic at rank ${i} (jitter reordered the sweep)`);
}
// 켜 규칙: 기둥(y≈1.6) 랭크가 모두 중인방(1.77)·창방(2.62) 랭크보다 먼저다.
assert.equal(cols.starts.length, BAYS + 2, 'rank start list does not match rank count');

// 파트 창 준수: 리플이 다음 파트 창으로 새면 기단→기둥→벽→지붕 순서 가독성이 무너진다.
for (const p of plan) {
  assert.ok(p.endSec <= p.window[1] * DUR + 1e-6,
    `${p.part} ripple overruns its part window (${p.endSec}s > ${(p.window[1] * DUR).toFixed(3)}s)`);
}

// 부재가 아주 많은 파트(마을 giwa 기둥 34본 등)는 창을 넓히는 대신 랭크를 슬롯으로 병합해
//   이웃 간격을 하한 위로 올려야 한다 — 창 넘침 없이 리플이 보이는 유일한 해법.
{
  const dense = new THREE.Group();
  dense.name = 'building';
  const dcols = new THREE.Group(); dcols.name = 'columns';
  for (let i = 0; i < 30; i++) dcols.add(box(0.3, 2, 0.3, i * 1.1 - 16, 1.6, 0));
  const dpod = new THREE.Group(); dpod.name = 'podium';
  dpod.add(box(40, 0.3, 8, 0, 0.15, 0));
  const droof = new THREE.Group(); droof.name = 'roof';
  droof.add(box(40, 0.4, 8, 0, 3.2, 0));
  dense.add(dpod); dense.add(dcols); dense.add(droof);
  const da = playAssembly(dense, { duration: 2.6 });
  const dcolPlan = da.plan().find((p) => p.part === 'columns');
  assert.equal(dcolPlan.rawRanks, 30, 'dense fixture did not produce one rank per column');
  assert.ok(dcolPlan.ranks < dcolPlan.rawRanks,
    'dense column set did not merge ranks — the ripple would either be invisible or overrun the window');
  assert.ok(dcolPlan.rippleSec >= 0.06,
    `dense column ripple ${(dcolPlan.rippleSec * 1000).toFixed(1)}ms is still below the perceptual floor`);
  assert.ok(dcolPlan.endSec <= dcolPlan.window[1] * 2.6 + 1e-6,
    'dense column ripple overran its part window');
  da.skip();
}

// 실제 등장 순서를 트리에서 직접 확인 — 기둥이 칸 순서(x 오름)로, 앞뒤 짝은 동시에 선다.
const colMeshes = house.getObjectByName('columns').children.slice(0, BAYS * 2);
const firstVisible = new Map(colMeshes.map((m) => [m, null]));
for (let i = 0; i <= 600; i++) {
  const t = i / 600;
  anim.seek(t);
  for (const m of colMeshes) if (firstVisible.get(m) === null && m.visible) firstVisible.set(m, t * DUR);
}
for (const m of colMeshes) assert.ok(firstVisible.get(m) !== null, 'a column never became visible');
for (let b = 0; b < BAYS; b++) {
  const a = firstVisible.get(colMeshes[b * 2]);
  const bb = firstVisible.get(colMeshes[b * 2 + 1]);
  near(a, bb, 0.02, `front/rear columns of bay ${b} did not rise as one bay`);
  if (b > 0) {
    const prev = firstVisible.get(colMeshes[(b - 1) * 2]);
    assert.ok(a - prev >= 0.05,
      `bay ${b} started only ${((a - prev) * 1000).toFixed(1)}ms after bay ${b - 1} — invisible ripple`);
  }
}

// ── ③ 청크 내부 켜 흐름(처마 → 용마루) ────────────────────────────────────────────────
const roofPlan = byPart.get('roof');
assert.ok(roofPlan, 'roof part window is missing from the assembly plan');
assert.equal(roofPlan.ranks, 3, 'roof semantic chunks (rafters/body/finial) collapsed or split');
assert.equal(roofPlan.courseFlow, true,
  'roof chunks do not carry a course flow — tiles are not running from the eave up to the ridge');
{
  // 켜 흐름은 **마감 부재**(잡상·마루 캡, asmGroup='finial')가 소유한다. 지붕 본체는 상량 이후
  //   강체 한 덩어리로 내려앉으므로 공중에서 이미 통째로 보인다(아래 ④ 참조) — 본체를 켜별로
  //   숨겼다 드러내던 구 모델이 낙하 비트를 프레임 밖으로 밀어낸 원인이었다.
  const finials = house.getObjectByName('roof').children
    .filter((o) => o.userData.asmGroup === 'finial');
  assert.ok(finials.length > 1, 'synthetic roof has no finial course to flow');
  const seen = new Map(finials.map((m) => [m, null]));
  for (let i = 0; i <= 900; i++) {
    const t = i / 900;
    anim.seek(t);
    for (const m of finials) if (seen.get(m) === null && m.visible) seen.set(m, t);
  }
  const ordered = [...finials].sort((a, b) => a.position.y - b.position.y);
  for (let i = 1; i < ordered.length; i++) {
    assert.ok(seen.get(ordered[i]) >= seen.get(ordered[i - 1]),
      'roof finial courses did not appear from the eave upward toward the ridge');
  }
  assert.ok(seen.get(ordered.at(-1)) > seen.get(ordered[0]),
    'roof finial courses all appeared on the same frame (no course flow)');
}

// Roof is a rigid body: group owns rise/bob; children keep rest local Y/scale so
// outer tile / underside / rafters never lose their authored depth stack.
{
  const roof = house.getObjectByName('roof');
  assert.equal(roofPlan.rigid, true, 'roof assembly is not marked rigid');
  // Capture rest pose first (course-flow loop ended at t≈1).
  const restChild = roof.children.map((c) => [c.position.y, c.scale.x, c.scale.y, c.scale.z]);
  const restGroupY = roof.position.y;

  // Frame walk of the roof window: shell halves stay visibility-locked and no
  // child local transform drifts (z-fight root cause during assembly).
  //   창을 상수로 적지 않는다 — 지붕 창은 ROOF_LIFT_OF_MASS 상한에 따라 기하별로 좁아진다.
  for (let i = 0; i <= 40; i++) {
    const t = roofPlan.window[0] + (i / 40) * (roofPlan.window[1] - roofPlan.window[0]);
    anim.seek(t);
    for (let c = 0; c < roof.children.length - 1; c++) {
      const a = roof.children[c];
      const b = roof.children[c + 1];
      if (a?.name === 'roof-tile-outer' && b?.name === 'roof-gaepan') {
        assert.equal(a.visible, b.visible,
          `t=${t.toFixed(3)} shell halves desynced (outer=${a.visible} gaepan=${b.visible})`);
        assert.equal(a.position.y, restChild[c][0], `t=${t.toFixed(3)} outer local Y drifted`);
        assert.equal(b.position.y, restChild[c + 1][0], `t=${t.toFixed(3)} gaepan local Y drifted`);
        assert.equal(a.scale.y, restChild[c][2], `t=${t.toFixed(3)} outer scale.y drifted`);
        assert.equal(b.scale.y, restChild[c + 1][2], `t=${t.toFixed(3)} gaepan scale.y drifted`);
      }
    }
  }

  // ④ 상량 방향 계약: 지붕은 **위에서** 내려앉는다. 그래서 (a) 지붕 그룹 Y 가 창 전체에서 rest 이상을
  //   유지하고(평방/창방 띠를 통과하는 프레임이 원리적으로 없다), (b) 개판·서까래·기와 외피를 숨길
  //   이유가 없으므로 공중에서 보인다. 구 모델은 반대였다 — 아래에서 밀어 올리느라 uu<0.85 까지
  //   지붕 전체를 숨겨야 했고, 그 게이트가 "기와가 애니메이션 없이 팝인"의 원인이었다.
  {
    const outer = roof.getObjectByName('roof-tile-outer');
    const gaepan = roof.getObjectByName('roof-gaepan');
    const band = roof.getObjectByName('roof-eave-band');
    const rafters = roof.children.filter((c) => c.userData?.asmGroup === 'rafters');
    assert.ok(outer && gaepan && band, 'synthetic roof is missing named shell pieces');
    assert.ok(rafters.length > 0, 'synthetic roof is missing rafter pieces');
    // (a) 접근 방향 — 지붕은 창 전체에서 rest 위에 머문다. 정착 스프링의 두 번째 로브만 rest 아래로
    //   내려갈 뻔한 것을 좌대 정류가 막는다(assembly.js applyItem 참조). 구 모델은 여행거리 **전체**를
    //   아래에서 올라오며 창방 띠를 통과했다(= -100%).
    let peakLift = 0;
    let minLift = Infinity;
    let minLiftT = 0;
    const [roofWs, roofWe] = roofPlan.window;
    for (let i = 0; i <= 400; i++) {
      const t = roofWs + (i / 400) * (roofWe - roofWs);
      anim.seek(t);
      const lift = roof.position.y - restGroupY;
      peakLift = Math.max(peakLift, lift);
      if (lift < minLift) { minLift = lift; minLiftT = t; }
    }
    assert.ok(peakLift > 0.5,
      `roof travel peaked at only ${peakLift.toFixed(3)}m — the descent is not readable on screen`);
    // 공중 구간은 창의 절반(u<IMPACT)이고, 보는 사람에게 낙하로 읽힐 만큼 길어야 한다.
    //   하한 개정(2026-07-31): 종전 기준은 "1.0s 초과"였고 근거는 **캡처 케이던스**였다(0.25s 간격
    //   라이브 샘플에 공중 프레임이 1장만 남았다 → 팝으로 보였다). 그건 도구 문제였고, 이제 지붕 창을
    //   비율로 훑는 결정론 seek 캡처로 대체됐다. 실제 팝은 "공중 프레임 0장"이었지(구 shell 은닉 게이트)
    //   0.6s 짜리 하강이 아니다. 여행거리를 지붕 덩어리 높이에 묶으면(ROOF_LIFT_OF_MASS) 접촉 속도를
    //   보존하는 대가로 공중 시간이 짧아지는데, 셋 중 하나는 내줘야 한다:
    //     travel = contactMps × airborne × 0.734  (이 모델의 항등식)
    //   내준 것은 공중 시간이다. 사용자 판정은 "높고 느리게 떨어진다"였으므로 접근 속도(무게)와
    //   낮은 호버를 지키고 시간을 줄이는 것이 판정 방향과 같다. 하한은 지각 기준으로 다시 잡는다:
    //   60fps 에서 27프레임(0.45s) — 팝(수 프레임)과는 자릿수가 다르다.
    const roofWindowSec = (roofWe - roofWs) * 7.4;
    assert.ok(roofWindowSec * 0.5 >= 0.45,
      `roof airborne window is only ${(roofWindowSec * 0.5).toFixed(2)}s on the hero body timeline `
      + `(${Math.round(roofWindowSec * 0.5 * 60)} frames @60fps) — under 27 frames it starts to read as a pop`);
    assert.ok(roofWindowSec * 0.5 <= 1.3,
      `roof airborne window ${(roofWindowSec * 0.5).toFixed(2)}s is a slow float — a heavy roof that hangs `
      + 'that long reads as weightless');
    assert.ok(minLift >= -1e-9,
      `t=${minLiftT.toFixed(3)} roof group sank ${(-minLift).toFixed(4)}m below rest `
      + `(${(-minLift / peakLift * 100).toFixed(1)}% of travel) — the rigid roof must approach from `
      + 'above (상량) and the settle is rectified at the rigid seat, so it can never cross the '
      + 'plate band');
    // (b) 공중 가시성 — 낙하 구간(접촉 전) 샘플에서 외피·개판·서까래가 실제로 보인다.
    //   창 대비 상대 위치로 샘플한다(창이 바뀌어도 "접촉 전"의 뜻이 유지되게).
    const airborneAt = (share) => roofWs + (roofWe - roofWs) * share;
    for (const t of [0.08, 0.20, 0.34].map(airborneAt)) {
      anim.seek(t);
      assert.ok(roof.position.y - restGroupY > 0.05,
        `t=${t} expected the roof to still be airborne`);
      assert.equal(outer.visible, true, `shell hidden in flight (t=${t}) — no visible drop beat`);
      assert.equal(gaepan.visible, true, `gaepan hidden in flight (t=${t})`);
      for (const r of rafters) {
        assert.equal(r.visible, true, `rafter hidden in flight (t=${t})`);
      }
    }
    // 마감 부재(용마루·추녀)는 **접촉 전에** 모두 얹혀 있어야 한다. 기와 외피는 tile field 라
    //   림을 받지 않으므로(uRimTileMul=0), 마감 부재가 늦게 켜지면 공중 지붕이 평면 검정 실루엣이
    //   되고 플래그십 웜 림이 착지 후에야 도착한다(2026-07-30 측정: 웜 최대 103 → 197).
    {
      const finials = roof.children.filter((c) => c.userData?.asmGroup === 'finial');
      assert.ok(finials.length > 0, 'synthetic roof has no finial members');
      const at = (share) => roofWs + (roofWe - roofWs) * share;
      anim.seek(at(IMPACT * 0.55));
      assert.ok(finials.some((f) => f.visible),
        'no finial is on mid-descent — the airborne roof has no rim-bearing member');
      anim.seek(at(IMPACT));
      assert.ok(finials.every((f) => f.visible),
        'finials are still arriving at contact — the flagship rim lands after the beat');
    }
    // 외피 두 겹은 여전히 가시성 동기(같은 물리 껍질).
    for (let i = 0; i <= 200; i++) {
      const t = roofWs - 0.04 + (i / 200) * (roofWe - roofWs + 0.04);
      anim.seek(t);
      assert.equal(outer.visible, gaepan.visible,
        `t=${t.toFixed(3)} outer/gaepan visibility desynced`);
      if (band.visible) {
        assert.equal(band.visible, outer.visible,
          `t=${t.toFixed(3)} eave band desynced from outer shell`);
      }
    }
    // 착공 전에는 지붕 자식이 하나도 보이지 않는다(완성본 조기 노출 0).
    anim.seek(roofWs - 0.02);
    assert.equal(outer.visible, false, 'shell visible before the roof window opens');
    assert.ok(rafters.every((r) => !r.visible), 'rafters visible before the roof window opens');
    // Near settle the under-eave stack is on and locked.
    anim.seek(0.98);
    assert.equal(outer.visible, true, 'shell missing near settle');
    assert.equal(gaepan.visible, true, 'gaepan missing near settle');
    assert.equal(band.visible, true, 'eave band missing near settle');
    assert.ok(rafters.every((r) => r.visible), 'rafters missing near settle');
  }

  // Group leaves rest across the window. 단일 샘플로 판정하면 안 된다: 강체 좌대는 정착창에서
  //   2.5 사이클을 돌아 노드(변위 0)가 여러 번 지나간다 — 종전의 t=0.88 고정 샘플이 정확히 그
  //   노드였다. 창 전체의 최대 변위와, 접촉 이후 구간의 최대 변위를 따로 본다.
  {
    const [rws, rwe] = roofPlan.window;
    let peakAll = 0, peakSettle = 0;
    for (let i = 0; i <= 800; i++) {
      const t = rws + (i / 800) * (rwe - rws);
      anim.seek(t);
      const d = Math.abs(roof.position.y - restGroupY);
      peakAll = Math.max(peakAll, d);
      if ((t - rws) / (rwe - rws) > IMPACT) peakSettle = Math.max(peakSettle, d);
    }
    assert.ok(peakAll > 1e-4, 'rigid roof group did not move mid-assembly');
    assert.ok(peakSettle > 0.01,
      `roof settle overshoot is only ${(peakSettle * 1000).toFixed(1)}mm — the seat absorbed everything `
      + 'and the landing has no thud');
  }
  // 하강 중간(창 상대 35%) — 창이 기하별로 움직이므로 상수 t 를 쓰지 않는다.
  anim.seek(roofPlan.window[0] + (roofPlan.window[1] - roofPlan.window[0]) * IMPACT * 0.7);
  for (let i = 0; i < roof.children.length; i++) {
    const c = roof.children[i];
    assert.equal(c.position.y, restChild[i][0], 'roof child local Y drifted — not rigid');
    assert.equal(c.scale.x, restChild[i][1], 'roof child scale.x changed mid-assembly');
    assert.equal(c.scale.y, restChild[i][2], 'roof child scale.y changed mid-assembly');
    assert.equal(c.scale.z, restChild[i][3], 'roof child scale.z changed mid-assembly');
  }
  // Group itself does not squash either (depth stack).
  assert.equal(roof.scale.x, 1, 'roof group scale.x changed');
  assert.equal(roof.scale.y, 1, 'roof group scale.y changed');
  assert.equal(roof.scale.z, 1, 'roof group scale.z changed');
  // Columns still squash (contrast — roof is the exception).
  anim.seek(0.33);
  const col = house.getObjectByName('columns').children.find((c) => c.visible);
  assert.ok(col, 'no visible column mid-assembly');
  assert.ok(
    Math.abs(col.scale.y - 1) > 1e-4 || Math.abs(col.scale.x - 1) > 1e-4,
    'columns lost tofu squash — roof-only scale freeze leaked to other parts',
  );
  anim.seek(1);
}

// ── ⑧ 상량 인양 물리(2026-07-30 "위에서 뚝 떨어지는 인상" 판정) ──────────────────────
// 판정하는 것: 내려앉는 부재는 (a) 중력처럼 **가속**하며 접근하고, (b) 호버 높이가 건물 높이에 비해
//   절제돼 있고, (c) 그럼에도 접촉 속도(=무게감의 유일한 출처)는 종전 값을 유지하고, (d) 강체 좌대가
//   그 모멘텀을 짧고 작은 안착으로 흡수하며(공처럼 튀지 않음), (e) 접촉에서 정확히 수평이 되는
//   롤 정렬로 "얹힌다"를 읽히게 한다. 올라오는 부재의 물리는 (f) 종전 그대로다.
{
  const dn = { descending: true };
  const vel = (u, opts) => (tofuRise(u + 1e-6, opts) - tofuRise(u - 1e-6, opts)) / -2e-6;
  // (a) 가속: 접근 초반보다 접촉 직전이 빠르다. 감속 프로파일(구 코드)에서는 반대다.
  const vEarly = vel(IMPACT * 0.12, dn);
  const vLate = vel(IMPACT * 0.94, dn);
  assert.ok(vLate > vEarly * 1.4,
    `descending approach is not accelerating (early ${vEarly.toFixed(3)} → late ${vLate.toFixed(3)} drop/u) `
    + '— a decelerating descent reads as an elevator, not as a member let down under gravity');
  // 하강 접촉 속도는 상승보다 1/VEND=1.67배. 이것이 거리를 줄이면서 무게를 지키는 유일한 여유다.
  const cvUp = vel(IMPACT * (1 - 1e-4));
  const cvDown = vel(IMPACT * (1 - 1e-4), dn);
  near(cvDown / cvUp, 1 / 0.6, 0.02, 'descending/ascending contact-speed ratio is not the profile mirror');
  // 접촉 C1: 하강 위치도 접촉을 통과할 때 속도가 이어진다(정착 스프링 초기속도 = 접촉 속도).
  const posDn = (u) => -tofuRise(u, dn) + tofuBob(u, AMP, dn);
  const dnBefore = (posDn(IMPACT - h) - posDn(IMPACT - 3 * h)) / (2 * h);
  const dnAfter = (posDn(IMPACT + 3 * h) - posDn(IMPACT + h)) / (2 * h);
  near(dnAfter, dnBefore, Math.abs(dnBefore) * 0.02,
    'descending position velocity is not continuous through contact');
  // 두 방향 모두 u=1 에서 정확히 원상.
  assert.equal(tofuRise(1, dn), 0, 'descending rise offset is nonzero at t=1');
  assert.equal(tofuBob(1, AMP, dn), 0, 'descending settle offset is nonzero at t=1');
  assert.equal(tofuRise(0, dn), 1, 'descending rise does not start a full travel above rest');

  // (f) 올라오는 부재의 물리는 불변 — 사용자가 승인한 값이므로 상수로 못박는다.
  near(cvUp, 1.6364, 0.002, 'ascending contact speed drifted (approved momentum model changed)');
  {
    let peak = 0;
    for (let i = 1; i < 4000; i++) peak = Math.max(peak, Math.abs(tofuBob(IMPACT + (1 - IMPACT) * i / 4000, AMP)));
    near(peak, 0.0679, 0.0015, 'ascending settle overshoot drifted from the approved 6.8% of drop');
  }

  // 히어로 몸채 타임라인(7.4s)에서 지붕 접근 물리를 수치로 본다.
  const HERO_DUR = 7.4;
  const TOTAL_H = 12;                       // makeHouse 의 userData.layout.totalH
  const heroRoof = playAssembly(makeHouse(), { duration: HERO_DUR }).plan()
    .find((p) => p.part === 'roof');
  assert.equal(heroRoof.descending, true, 'roof no longer approaches from above (상량)');
  // (b) 호버 높이는 **지붕 덩어리가 앉는 높이**에 묶인다. 종전 기준으로 쓰던 `layout.totalH` 는
  //   신뢰할 수 없다: buildHanok 은 layout 을 달지 않아 폴백 12m 가 쓰이는데 실제 종가는 5.98m 다
  //   (2026-07-31 실측). 그래서 기준을 기하에서 직접 얻은 massY(지붕 그룹 localCenter.y)로 바꾼다.
  assert.ok(heroRoof.massY > 0, 'roof mass height was not derived from geometry');
  assert.ok(heroRoof.liftOfMass <= 0.45 + 1e-6,
    `roof lifts ${(heroRoof.liftOfMass * 100).toFixed(0)}% of its own mass height `
    + `(${heroRoof.travelM.toFixed(2)}m of ${heroRoof.massY.toFixed(2)}m) — above that the airborne eave `
    + 'clears its own ridge and the roof reads as falling out of the sky');
  assert.ok(heroRoof.liftOfMass >= 0.20,
    `roof lifts only ${(heroRoof.liftOfMass * 100).toFixed(0)}% of its mass height — too little to read`);
  void TOTAL_H;
  // (c) 접촉 속도 — 거리를 줄이면서도 종전(3.91 m/s)과 같은 무게로 도착한다.
  assert.ok(heroRoof.contactMps >= 3.3 && heroRoof.contactMps <= 4.4,
    `roof contact speed ${heroRoof.contactMps.toFixed(2)} m/s left the approved heavy band (3.3..4.4) — `
    + 'weight comes from approach speed, so shortening the travel must be paid for by the profile');
  // 공중 시간 하한은 지각 기준(60fps 27프레임)이다 — 종전 1.0s 기준의 근거였던 캡처 케이던스는
  //   결정론 seek 캡처로 대체됐다. 위 roofWindowSec 단언과 같은 밴드를 쓴다.
  assert.ok(heroRoof.airborneSec >= 0.45 && heroRoof.airborneSec <= 1.3,
    `roof airborne time ${heroRoof.airborneSec.toFixed(2)}s `
    + `(${Math.round(heroRoof.airborneSec * 60)} frames @60fps) left the readable band (0.45..1.3s)`);
  // (d) 강체 좌대 — 모멘텀을 여행거리의 6% 이하 한 번의 안착으로 흡수한다(구 기본 좌대는 6.8%,
  //   절대값 36cm 짜리 3연속 호핑이었다: 5톤 지붕이 공처럼 튀는 인상).
  assert.ok(heroRoof.settleM <= heroRoof.travelM * 0.06,
    `roof settle overshoot ${(heroRoof.settleM * 100).toFixed(1)}cm is `
    + `${(heroRoof.settleM / heroRoof.travelM * 100).toFixed(1)}% of travel — a rigid roof with no squash `
    + 'channel reads as a bouncing ball at that amplitude');
  assert.ok(heroRoof.settleM >= 0.05,
    `roof settle overshoot ${(heroRoof.settleM * 100).toFixed(1)}cm is too small to read as a thud`);

  // (e) 롤 정렬 — 용마루 축(긴 축) 기준, 접근 중에만 존재하고 접촉에서 정확히 0.
  assert.equal(heroRoof.rollAxis, 'x', 'roof roll is not about the ridge (dominant) axis');
  assert.ok(heroRoof.rollDeg > 0.5 && heroRoof.rollDeg <= 3.0,
    `roof roll ${heroRoof.rollDeg}° is outside the readable band (0.5..3.0) — below it nothing reads, `
    + 'above it the tilt looks like an error rather than a lift');
  {
    const roof = house.getObjectByName('roof');
    anim.seek(1);
    const restRot = [roof.rotation.x, roof.rotation.y, roof.rotation.z];
    const [rws, rwe] = roofPlan.window;
    const at = (share) => rws + (rwe - rws) * share;
    let peakRoll = 0;
    for (let i = 0; i <= 400; i++) {
      anim.seek(at(i / 400));
      peakRoll = Math.max(peakRoll, Math.abs(roof.rotation.x - restRot[0]));
    }
    near(peakRoll * 180 / Math.PI, heroRoof.rollDeg, 0.02, 'roll never reaches its authored angle');
    // 접촉 이후 회전 잔여 0 — 후행 회전 흔들림은 기각된 "분리된 wobble" 이다.
    for (let i = 0; i <= 200; i++) {
      anim.seek(at(IMPACT + (1 - IMPACT) * (i / 200)));
      assert.equal(roof.rotation.x, restRot[0],
        `roof is still rotating after contact (${((roof.rotation.x - restRot[0]) * 180 / Math.PI).toFixed(3)}°)`);
      assert.equal(roof.rotation.z, restRot[2], 'roof rolled about the wrong axis after contact');
      assert.equal(roof.rotation.y, restRot[1], 'roof yawed during assembly');
    }
    // 롤은 여행거리에 비해 작아야 한다. 리프트와 롤이 같은 포락(tofuRise)을 쓰므로 "기울어진 끝의
    //   하강량 / 그 순간의 리프트" 는 u 와 무관한 상수 = |z|max·sinθ / travel 이다. 그 비율이 1 에
    //   가까워지면 아직 공중인데도 한쪽 처마가 좌대를 파고들기 시작한다 — 각도를 눈에 보이게 키우려는
    //   유혹이 정확히 이 한계에 부딪힌다(히어로 fixture 에서 9.6° 부터 위반).
    {
      let zMax = 0;
      for (const c of roof.children) zMax = Math.max(zMax, Math.abs(c.position.z));
      const dip = zMax * Math.sin(heroRoof.rollDeg * Math.PI / 180);
      assert.ok(dip < heroRoof.travelM * 0.25,
        `the rolled eave eats ${(dip / heroRoof.travelM * 100).toFixed(0)}% of the roof's travel `
        + `(${dip.toFixed(2)}m of ${heroRoof.travelM.toFixed(2)}m) — at that ratio the low corner reaches `
        + 'the plate band while the roof is still descending');
    }
    anim.seek(1);
    for (const [i, k] of ['x', 'y', 'z'].entries()) {
      assert.equal(roof.rotation[k], restRot[i], `roof rotation.${k} not exactly restored at t=1`);
    }
  }
}

// ── ⑤ 착공 전 무노출 ─────────────────────────────────────────────────────────────────
anim.seek(0);
const animated = [];
for (const part of ['podium', 'columns', 'walls', 'roof']) {
  for (const c of house.getObjectByName(part).children) animated.push(c);
}
for (const c of animated) {
  assert.equal(c.visible, false, 'a member is already visible at t=0 (finished building would flash)');
}

// ── ④ 원상복구(정확히 원값) ──────────────────────────────────────────────────────────
// 회전도 포함한다 — 강체 지붕의 롤 정렬이 rotation 을 쓰므로, 복구 계약이 이 채널까지 덮어야 한다.
function snapshot(root) {
  const out = [];
  root.traverse((o) => out.push([o, o.position.y, o.scale.x, o.scale.y, o.scale.z, o.visible,
    o.rotation.x, o.rotation.y, o.rotation.z]));
  return out;
}
function assertExact(shot, label) {
  for (const [o, y, sx, sy, sz, vis, rx, ry, rz] of shot) {
    assert.equal(o.position.y, y, `${label}: position.y not exactly restored on ${o.name || o.type}`);
    assert.equal(o.scale.x, sx, `${label}: scale.x not exactly restored`);
    assert.equal(o.scale.y, sy, `${label}: scale.y not exactly restored`);
    assert.equal(o.scale.z, sz, `${label}: scale.z not exactly restored`);
    assert.equal(o.visible, vis, `${label}: visible not exactly restored`);
    assert.equal(o.rotation.x, rx, `${label}: rotation.x not exactly restored on ${o.name || o.type}`);
    assert.equal(o.rotation.y, ry, `${label}: rotation.y not exactly restored`);
    assert.equal(o.rotation.z, rz, `${label}: rotation.z not exactly restored`);
  }
}
for (const mode of ['update', 'skip', 'seek1']) {
  const tree = makeHouse();
  const rest = snapshot(tree);
  const a = playAssembly(tree, { duration: DUR });
  a.seek(0.37);
  assert.ok(rest.some(([o, y]) => o.position.y !== y || !o.visible),
    'mid-flight state is identical to rest — the animation did nothing');
  if (mode === 'update') {
    let guard = 0;
    while (!a.update(0.25) && guard++ < 200) { /* 실시간 완주 */ }
    assert.ok(a.isDone(), 'update never completed');
  } else if (mode === 'skip') {
    a.skip();
  } else {
    a.seek(1);
  }
  assertExact(rest, mode);
}
// regenerate 경합: seek 중 skip 이 즉시 원상으로 되돌린다(두 번 호출도 멱등).
{
  const tree = makeHouse();
  const rest = snapshot(tree);
  const a = playAssembly(tree, { duration: DUR });
  a.seek(0.62);
  a.skip(); a.skip();
  assertExact(rest, 'double skip');
}

// ── ⑦ 결정론 ─────────────────────────────────────────────────────────────────────────
{
  const p1 = JSON.stringify(playAssembly(makeHouse(), { duration: DUR }).plan());
  const p2 = JSON.stringify(playAssembly(makeHouse(), { duration: DUR }).plan());
  assert.equal(p1, p2, 'assembly timing plan is not deterministic (rng leaked into the ripple)');
}

// ── ⑥ 종가(buildHanok) 파트 그룹 계약 ────────────────────────────────────────────────
// canvas 스텁 위에서 실제 팔레트로 실제 종가를 만든다(구조만 판정 — 픽셀은 별도 게이트).
{
  const mats = makeMaterials('giwa');
  const footprint = [
    { x: -5, z: -3 }, { x: 5, z: -3 }, { x: 5, z: 3 }, { x: 1, z: 3 }, { x: 1, z: 0 }, { x: -5, z: 0 },
  ];
  const hanok = buildHanok({ footprint, seed: 11, mats });
  // 낙하 기준 정합(#28): playAssembly 는 `userData.layout.totalH` 로 dropBase 를 만들고, 없으면
  //   폴백 12m 를 쓴다. 종가 실측은 ~5.98m 이므로 폴백은 기단·기둥·벽 낙하거리를 두 배로 부풀린다
  //   (지붕만 ROOF_LIFT_OF_MASS 기하 상한으로 우연히 방어된다). buildHanok 은 computeLayout 경로가
  //   아니라 자기 기하로 totalH 를 달아야 한다.
  {
    const totalH = hanok.userData?.layout?.totalH;
    assert.ok(Number.isFinite(totalH),
      'buildHanok does not attach userData.layout.totalH — playAssembly then falls back to 12m, '
      + 'twice the real hero body height, and every non-roof part drops from too far');
    assert.ok(totalH >= 4 && totalH <= 8,
      `hero body totalH ${totalH} left the measured band (4..8m, actual ~5.98) — either the geometry `
      + 'changed or the value is the playAssembly fallback 12 leaking through');
  }
  const partNames = ['podium', 'columns', 'walls', 'roof'];
  for (const name of partNames) {
    const grp = hanok.children.find((c) => c.name === name);
    assert.ok(grp && grp.children.length > 0,
      `buildHanok has no '${name}' part group — the hero body would be lifted as one lump`);
  }
  assert.equal(hanok.children.find((c) => c.name === 'roof').userData.asmChunked, true,
    'hero roof is not semantic-chunked (rafters → tile mass → finial)');
  // 파트 그룹 밖에 남은 렌더 가능한 직속 자식이 없어야 한다(남으면 t=0 에 그 부재만 완성 노출).
  const orphans = hanok.children
    .filter((c) => !partNames.includes(c.name))
    .filter((c) => { let renderable = false; c.traverse((o) => { if (o.isMesh) renderable = true; }); return renderable; })
    .map((c) => c.name || c.type);
  assert.deepEqual(orphans, [], `hero body has renderable children outside every part group: ${orphans}`);
  // 굴뚝은 중첩되어도 traverse 기반 소비자(smoke.js)가 찾을 수 있어야 한다.
  assert.ok(hanok.getObjectByName('chimney'), 'chimney is no longer reachable by name after regrouping');
  // 부재 단위 조립이 실제로 성립하는지(파트 창 4 개 + 착공 전 무노출).
  const ha = playAssembly(hanok, { duration: 5 });
  const hp = ha.plan();
  assert.deepEqual(hp.map((p) => p.part), ['podium', 'columns', 'walls', 'roof'],
    'hero part order is not 기단 → 기둥 → 벽 → 지붕');
  ha.seek(0);
  let visibleAtZero = 0;
  hanok.traverse((o) => { if (o.isMesh && o.visible && o.parent?.visible !== false) visibleAtZero++; });
  ha.skip();
  assert.ok(hp.find((p) => p.part === 'columns').ranks >= 4,
    'hero column ripple collapsed into too few ranks to read');

  // ⑧-real: "하늘에서 떨어진다"를 **실제 종가 기하**로 판정한다. 합성 fixture 의 totalH=12 는
  //   실제 높이(5.98m)의 두 배라, 이 단언만이 제품에서 실제로 보이는 것을 본다.
  //   기준: 공중에서 가장 높이 든 순간의 **처마선(지붕 bbox 하단)이 자기 용마루선을 넘지 않는다.**
  //   구 소스에서는 처마 출발점이 7.57m 로 용마루 5.92m 보다 1.65m 높았다 — 지붕이 건물 위 허공에
  //   통째로 떠 있는 프레임이고, 그것이 사용자 판정의 정체다.
  {
    const roof = hanok.children.find((c) => c.name === 'roof');
    const ha2 = playAssembly(hanok, { duration: 10 });
    const rp = ha2.plan().find((p) => p.part === 'roof');
    const box = new THREE.Box3();
    ha2.seek(1);
    box.setFromObject(roof);
    const restEave = box.min.y;
    const ridgeY = box.max.y;
    let peakEave = -Infinity;
    for (let i = 0; i <= 200; i++) {
      ha2.seek(rp.window[0] + (i / 200) * (rp.window[1] - rp.window[0]));
      roof.updateWorldMatrix(true, true);
      box.setFromObject(roof);
      peakEave = Math.max(peakEave, box.min.y);
    }
    ha2.skip();
    assert.ok(peakEave < ridgeY,
      `the airborne hero roof lifts its eave line to ${peakEave.toFixed(2)}m, above its own ridge at `
      + `${ridgeY.toFixed(2)}m (rest eave ${restEave.toFixed(2)}m) — the whole roof floats clear of the `
      + 'house and reads as dropping out of the sky');
    // 여유도 함께 기록한다: 처마 피크가 용마루의 80% 를 넘으면 이미 "건물 위에 뜬" 인상이다.
    assert.ok(peakEave < restEave + (ridgeY - restEave) * 0.80,
      `airborne eave peak ${peakEave.toFixed(2)}m eats `
      + `${((peakEave - restEave) / (ridgeY - restEave) * 100).toFixed(0)}% of the roof's own height — `
      + 'the lift should read as clearing the columns, not as a second storey of air');
  }

  // ⑧-real (b): 접촉 속도도 **실제 종가**에서 본다. 위 합성 fixture 단언(makeHouse, totalH=12)은
  //   폴백 높이를 쓰므로 제품 수치를 대변하지 못한다: #28 에서 실측 totalH(5.92m)가 붙자 dropBase 가
  //   1.56 → 1.20 으로 내려가 지붕 접촉 속도가 3.83 → 2.95 m/s 로 떨어졌는데, 여행거리는
  //   ROOF_LIFT_OF_MASS 상한 탓에 1.71m 로 전후 동일했다 — 즉 이 회귀는 거리·기하 단언 어디에도
  //   걸리지 않고 통과했다. 무게는 진폭이 아니라 **접근 속도**에서 온다는 계약(①)이므로, 공중 시간
  //   창은 여행거리와 목표 속도에서 파생돼야 하고 dropBase 에 딸려 흔들려선 안 된다.
  {
    const ha3 = playAssembly(hanok, { duration: 7.4 });   // 히어로 몸채 타임라인(위 HERO_DUR 과 동일)
    const rp = ha3.plan().find((p) => p.part === 'roof');
    ha3.skip();
    assert.ok(rp.contactMps >= 3.3 && rp.contactMps <= 4.4,
      `real hero roof contact speed ${rp.contactMps.toFixed(2)} m/s is outside the approved heavy band `
      + `(3.3..4.4) that the synthetic fixture asserts — travel ${rp.travelM.toFixed(2)}m over an `
      + `airborne ${rp.airborneSec.toFixed(2)}s window ${JSON.stringify(rp.window.map((v) => +v.toFixed(4)))}. `
      + 'Contact speed must be derived from travel and the target speed, not inherited from dropBase');
    // 창이 속도에서 파생되더라도 지각 밴드(위 roofWindowSec 과 동일)를 벗어나선 안 된다.
    assert.ok(rp.airborneSec >= 0.45 && rp.airborneSec <= 1.3,
      `real hero roof airborne time ${rp.airborneSec.toFixed(2)}s `
      + `(${Math.round(rp.airborneSec * 60)} frames @60fps) left the readable band (0.45..1.3s)`);
    // 창은 저작 창(PART_WINDOWS.roof) 안에 들어야 한다 — 앞으로 넓히면 벽 파트를 잡아먹고
    //   전체 duration·빈 터 dead time 이 늘어난다.
    assert.ok(rp.window[0] >= 0.70 - 1e-9 && rp.window[1] <= 1 + 1e-9,
      `roof window ${JSON.stringify(rp.window)} escaped the authored PART_WINDOWS.roof [0.70, 1.00] — `
      + 'widening the roof window forward steals the walls window and grows the empty-site dead time');
  }
}

console.log('ASSEMBLY CONTRACT: PASS (momentum-continuous settle, geometry-derived member ripple, '
  + 'eave→ridge course flow, exact restoration, no finished flash, hero part groups, '
  + 'gravity-accelerated 상량 descent on a rigid seat with contact-zero roll)');
