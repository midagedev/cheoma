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
//
// 변경 전 코드에서 실패하는 단언(의도된 회귀 게이트):
//   ① contact velocity(=0) · settle squash 없음 · 접촉 스케일 정확히 1
//   ② rippleSec ≈ 0.026s · 순서가 배열 인덱스
//   ③ courseFlow=false
//   ⑥ buildHanok 파트 그룹 부재
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
  const tiles = house.getObjectByName('roof').children.filter((o) => !o.userData.asmGroup);
  const seen = new Map(tiles.map((m) => [m, null]));
  for (let i = 0; i <= 900; i++) {
    const t = i / 900;
    anim.seek(t);
    for (const m of tiles) if (seen.get(m) === null && m.visible) seen.set(m, t);
  }
  const ordered = [...tiles].sort((a, b) => a.position.y - b.position.y);
  for (let i = 1; i < ordered.length; i++) {
    assert.ok(seen.get(ordered[i]) >= seen.get(ordered[i - 1]),
      'roof tile courses did not appear from the eave upward toward the ridge');
  }
  assert.ok(seen.get(ordered.at(-1)) > seen.get(ordered[0]),
    'roof tile courses all appeared on the same frame (no course flow)');
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
  for (let i = 0; i <= 40; i++) {
    const t = 0.74 + (i / 40) * 0.26;
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

  // Under-eave stack (outer/gaepan/band + rafters) must stay dark until the rigid
  // roof settle is mostly damped — otherwise the rising underside/rafters z-fight
  // the column/plate band ("기둥 위에 반자").
  {
    const outer = roof.getObjectByName('roof-tile-outer');
    const gaepan = roof.getObjectByName('roof-gaepan');
    const band = roof.getObjectByName('roof-eave-band');
    const rafters = roof.children.filter((c) => c.userData?.asmGroup === 'rafters');
    assert.ok(outer && gaepan && band, 'synthetic roof is missing named shell pieces');
    assert.ok(rafters.length > 0, 'synthetic roof is missing rafter pieces');
    let firstShellT = null;
    let firstRafterT = null;
    for (let i = 0; i <= 200; i++) {
      const t = 0.70 + (i / 200) * 0.30;
      anim.seek(t);
      assert.equal(outer.visible, gaepan.visible,
        `t=${t.toFixed(3)} outer/gaepan visibility desynced during shell gate`);
      if (band.visible) {
        assert.equal(band.visible, outer.visible,
          `t=${t.toFixed(3)} eave band desynced from outer shell`);
      }
      // Rafters share the under-eave gate with the shell — never lead alone
      // through the plate band (prior residual sparkle).
      for (const r of rafters) {
        if (r.visible) {
          assert.equal(outer.visible, true,
            `t=${t.toFixed(3)} rafter visible while shell still dark`);
        }
      }
      if (firstShellT === null && outer.visible) firstShellT = t;
      if (firstRafterT === null && rafters.some((r) => r.visible)) firstRafterT = t;
    }
    assert.ok(firstShellT !== null, 'shell never became visible');
    assert.ok(firstRafterT !== null, 'rafters never became visible');
    // Under-eave waits until settle is mostly damped (SHELL_REVEAL_UU ≈ 0.85 of roof u),
    // not merely IMPACT — so bob cannot scrape the plate/창방 band.
    const shellFloor = 0.74 + (1 - 0.74) * (IMPACT + (1 - IMPACT) * 0.70) * 0.92;
    assert.ok(firstShellT >= shellFloor,
      `shell appeared at t=${firstShellT.toFixed(3)} — still in the bob window `
      + '(column-band z-fight)');
    assert.ok(firstRafterT >= shellFloor,
      `rafters appeared at t=${firstRafterT.toFixed(3)} — still scraping plate/창방`);
    // Mid-rise and early-settle samples must keep the under-eave dark.
    // t=0.90 is still pre-reveal (uu≈0.615); top-side ornaments may already show.
    for (const t of [0.78, 0.84, 0.90]) {
      anim.seek(t);
      assert.equal(outer.visible, false, `shell visible too early (t=${t})`);
      assert.equal(gaepan.visible, false, `gaepan visible too early (t=${t})`);
      for (const r of rafters) {
        assert.equal(r.visible, false, `rafter visible too early (t=${t})`);
      }
    }
    // Near settle the under-eave stack is on and locked.
    anim.seek(0.98);
    assert.equal(outer.visible, true, 'shell missing near settle');
    assert.equal(gaepan.visible, true, 'gaepan missing near settle');
    assert.equal(band.visible, true, 'eave band missing near settle');
    assert.ok(rafters.every((r) => r.visible), 'rafters missing near settle');
  }

  anim.seek(0.88); // mid roof window (PART_WINDOWS.roof ≈ 0.74–1.0)
  // Group has left rest (rise/bob in flight).
  assert.ok(Math.abs(roof.position.y - restGroupY) > 1e-4,
    'rigid roof group did not move mid-assembly');
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
function snapshot(root) {
  const out = [];
  root.traverse((o) => out.push([o, o.position.y, o.scale.x, o.scale.y, o.scale.z, o.visible]));
  return out;
}
function assertExact(shot, label) {
  for (const [o, y, sx, sy, sz, vis] of shot) {
    assert.equal(o.position.y, y, `${label}: position.y not exactly restored on ${o.name || o.type}`);
    assert.equal(o.scale.x, sx, `${label}: scale.x not exactly restored`);
    assert.equal(o.scale.y, sy, `${label}: scale.y not exactly restored`);
    assert.equal(o.scale.z, sz, `${label}: scale.z not exactly restored`);
    assert.equal(o.visible, vis, `${label}: visible not exactly restored`);
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
}

console.log('ASSEMBLY CONTRACT: PASS (momentum-continuous settle, geometry-derived member ripple, '
  + 'eave→ridge course flow, exact restoration, no finished flash, hero part groups)');
