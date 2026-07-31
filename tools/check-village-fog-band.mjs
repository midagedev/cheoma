// 마을 대기(fog) 밴드 계약(#31). 순수 노드 — GL·브라우저 없음.
//
// 이 게이트가 존재하는 이유: `scene.fog` 는 마을 모드에서 **한 번도 발화하지 않았다**. 규약이
// `near = R*2.2` 였고 지형은 `terrainR = nearR + 12`(site.js #143)로 잘려 있어서 near 가 지형
// 지름보다도 멀었다. 실측(capital vseed 7 제품 경로) near/far = 616/1960m vs 카메라→숲 인스턴스
// 최원 거리 279m → 전 지오메트리 fogFactor 0. 지형만 자체 로컬 헤이즈로 씻기고 그 위 수관·암반은
// 대기 참여도 0이라 산 표면에서 분리된 레이어로 읽혔다(중단 밴드 나무/지형 휘도비 0.53x).
//
// 영구 회귀 픽스처(FAIL-first 확인 완료): 아래 REACH 단언은 "fog 는 씬 안쪽에 도달해야 한다"는
// 최소 계약이고, 구 소스(near = R*2.2)에서는 전 tier 에서 실패한다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeSite } from '../src/village/site.js';
import {
  VILLAGE_FOG_BAND,
  followFogDistance,
  villageFogBand,
} from '../src/env/village-fog-band.js';

const TIERS = [
  ['hamlet', 90], ['village', 150], ['town', 240], ['capital', 400], ['hanyang', 500],
];
// 제품 프레이밍의 카메라→분지 중심 거리(siteR 배수). aerial 은 프리워밍/진입 리그
//   (0.20, 0.96, 2.08)·R 의 노름 = 2.30R, drone/walk 는 #31 실측 궤도에서 취했다.
const FRAMINGS = [
  ['aerial', 2.30], ['drone', 0.63], ['eyelevel', 0.14], ['eyelevel-rim', 0.72],
];
const fogFactor = (band, distance) => Math.min(1, Math.max(0,
  (distance - band.near) / (band.far - band.near)));

// ── 상수 형태 ────────────────────────────────────────────────────────────────
assert.ok(VILLAGE_FOG_BAND.nearPull > 0 && VILLAGE_FOG_BAND.nearPull < 1,
  'nearPull must place fog onset inside the basin, behind the front rim');
assert.ok(VILLAGE_FOG_BAND.farSpan > VILLAGE_FOG_BAND.nearPull * 2,
  'the band must span the scene depth, not a sliver behind the onset');
assert.ok(VILLAGE_FOG_BAND.nearFloor > 0,
  'a non-positive fog near would fog the camera lens itself at eye level');
assert.ok(VILLAGE_FOG_BAND.followPerSec > 0,
  'the follow constant must damp camera-distance steps, per the no-pop contract');

let unclampedSeen = 0;
for (const [scale, siteR] of TIERS) {
  const site = makeSite({ scale, siteR, seed: 7 });
  const TR = site.terrainR;
  const diameter = 2 * TR;

  for (const [framing, mul] of FRAMINGS) {
    const d = siteR * mul;
    const band = villageFogBand(d, TR);
    const label = `${scale}/${framing}`;

    assert.ok(band.near < band.far, `${label}: degenerate band`);
    assert.ok(band.near >= VILLAGE_FOG_BAND.nearFloor, `${label}: near below floor`);

    // ── REACH: 영구 회귀 픽스처. 구 규약(near = R*2.2)이 정확히 여기서 실패한다. ──
    // fog 는 씬 안쪽에 도달해야 한다 = near 가 그 프레이밍에서 실제로 보이는 최원 지오메트리보다
    // 가까워야 한다. 최원단은 카메라에서 분지 반대편 테두리(d + terrainR)로 잡는다.
    const farthest = d + TR;
    assert.ok(band.near < farthest,
      `${label}: fog never engages — near ${band.near.toFixed(0)}m is beyond the farthest `
      + `geometry ${farthest.toFixed(0)}m (this is the #31 bug: R*2.2 = ${(siteR * 2.2).toFixed(0)}m `
      + `vs terrain diameter ${diameter.toFixed(0)}m)`);

    // 최원단은 실질적인 대기량을 받아야 한다(수관·암반이 지형과 함께 씻긴다).
    const farFactor = fogFactor(band, farthest);
    assert.ok(farFactor >= 0.25,
      `${label}: farthest geometry gets only ${(farFactor * 100).toFixed(0)}% atmosphere`);
    // 그러나 능선 실루엣을 지울 만큼은 아니어야 한다(유백색 이중 계상 = 즉시 실패).
    assert.ok(farFactor <= 0.62,
      `${label}: farthest geometry is over-washed at ${(farFactor * 100).toFixed(0)}% — ridge `
      + 'silhouettes must survive');

    // 근경은 항상 선명하다(플래그십 룩: 근경 선명 + 원경 소실).
    const nearest = Math.max(1, d - TR);
    assert.equal(fogFactor(band, nearest), 0,
      `${label}: the near rim must stay clear of the atmosphere band`);
  }

  // 프레이밍 무관 불변: near 가 바닥에 걸리지 않는 프레이밍에서 최원단 계수는 닫힌 형태의
  //   상수다 — (1 + nearPull)·TR / (farSpan·TR) = 1.6 / 3.4. 이 항등식이 "부감에서 근접까지
  //   무드가 끊기지 않는다"의 수치 형태다(작은 규모는 terrainR > R 이라 부감만 unclamped 다).
  const identity = (1 + VILLAGE_FOG_BAND.nearPull) / VILLAGE_FOG_BAND.farSpan;
  for (const [framing, mul] of FRAMINGS) {
    const d = siteR * mul;
    if (d - TR * VILLAGE_FOG_BAND.nearPull <= VILLAGE_FOG_BAND.nearFloor) continue;
    unclampedSeen++;
    const factor = fogFactor(villageFogBand(d, TR), d + TR);
    assert.ok(Math.abs(factor - identity) < 1e-9,
      `${scale}/${framing}: far-edge atmosphere must be framing-invariant `
      + `(${factor} vs ${identity})`);
  }
}
assert.ok(unclampedSeen >= TIERS.length,
  `expected at least one unclamped framing per tier (${unclampedSeen})`);

// ── 퇴화 입력은 닫힌 방향으로 실패한다(부감 폴백 거리) ───────────────────────
for (const bad of [NaN, Infinity, -1, 0, null, undefined]) {
  const band = villageFogBand(bad, 236.2);
  assert.ok(Number.isFinite(band.near) && Number.isFinite(band.far) && band.near < band.far,
    `degenerate camera distance ${String(bad)} must fall back to a finite aerial band`);
}
for (const bad of [NaN, Infinity, -1, 0, null, undefined]) {
  const band = villageFogBand(400, bad);
  assert.ok(Number.isFinite(band.near) && Number.isFinite(band.far) && band.near < band.far,
    `degenerate terrainR ${String(bad)} must still produce a usable band`);
}

// ── 추종(스무딩) ────────────────────────────────────────────────────────────
// 첫 프레임·비정상 dt 는 목표로 스냅한다(진입 프레임이 폴백 밴드로 그려지지 않게).
assert.equal(followFogDistance(null, 300, 1 / 60), 300, 'first sample must snap');
assert.equal(followFogDistance(0, 300, 1 / 60), 300, 'a zero previous must snap');
assert.equal(followFogDistance(NaN, 300, 1 / 60), 300, 'a non-finite previous must snap');
assert.equal(followFogDistance(100, 300, 0), 300, 'a zero dt must snap rather than freeze');
assert.equal(followFogDistance(100, 300, NaN), 300, 'a non-finite dt must snap');

// 한 프레임은 목표로 점프하지 않는다 — 이것이 fog 펄스를 막는 계약이다.
const oneFrame = followFogDistance(100, 300, 1 / 60);
assert.ok(oneFrame > 100 && oneFrame < 300, `one frame must not jump (${oneFrame})`);
assert.ok(oneFrame - 100 < 0.15 * (300 - 100),
  `one frame must cover well under a fifth of a hard camera cut (${(oneFrame - 100).toFixed(2)}m)`);

// 단조 수렴 + 유한 시간 정착. 드론 컷(35m → 502m)이 1초 안에 대부분 따라잡되 프레임 단위로는
//   부드러워야 한다.
let followed = 35;
let previous = -Infinity;
for (let i = 0; i < 60; i++) {
  followed = followFogDistance(followed, 502, 1 / 60);
  assert.ok(followed > previous && followed <= 502, `follow must converge monotonically at ${i}`);
  previous = followed;
}
assert.ok(followed > 502 * 0.9,
  `a one-second follow must mostly settle a hard cut (${followed.toFixed(1)}m)`);

// dt 상한(탭 전환·긴 히치)에서도 목표를 넘지 않는다.
assert.ok(followFogDistance(35, 502, 10) <= 502, 'a long dt must not overshoot');
assert.ok(followFogDistance(502, 35, 10) >= 35, 'a long dt must not undershoot downward');

// ── 단일 대기 메커니즘 계약(#31-3) ──────────────────────────────────────────
// 마을 지형은 대기 원근을 **직접 칠하지 않는다**. scene.fog 가 발화 0회이던 시절 지형에 구워 넣은
// 보상항 두 개(정점색 cFar 감쇠 + aEdge 엣지 소실 헤이즈)는 fog 복구 후 지형만 대기를 이중 계상하는
// 항이 되어 제거됐다 — 실측 상단 밴드 지형-수관 Δmean sunset 0.147 / day 0.205 의 유일 드라이버.
// 이 단언은 그 항들이 되살아나는 것을 막는 회귀 픽스처다(수정 전 소스에서 실패 확인).
// look-grammar "everything participates in the atmosphere" 를 단일 메커니즘으로 수렴시킨다.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const terrainSource = readFileSync(join(ROOT, 'src/generators/village/terrain.js'), 'utf8');
// 주석은 제외하고 실코드만 본다(삭제 근거 주석에 옛 심볼 이름이 등장한다).
const terrainCode = terrainSource
  .split('\n')
  .filter((line) => !line.trim().startsWith('//'))
  .join('\n');

for (const [symbol, why] of [
  ['V_EDGE_HAZE_AMT', 'edge-haze amplitude'],
  ['V_EDGE_HAZE_ONSET', 'edge-haze ramp onset'],
  ['uEdgeHazeV', 'edge-haze atmosphere-colour uniform'],
  ['aEdge', 'edge-haze vertex attribute'],
  ['vEdgeV', 'edge-haze varying'],
  ['cFar', 'baked distance-atmosphere vertex colour'],
]) {
  assert.ok(!terrainCode.includes(symbol),
    `village terrain must not reintroduce ${symbol} (${why}) — the atmosphere belongs to `
    + 'scene.fog alone (#31-3 double-count removal)');
}
// setHaze 소비 경로도 함께 사라져야 한다(죽은 훅이 남으면 다음 사람이 다시 채운다).
assert.ok(!terrainCode.includes('setHaze'),
  'village terrain must not expose a setHaze hook once the local haze term is gone');
const populateCode = readFileSync(join(ROOT, 'src/village/populate.js'), 'utf8')
  .split('\n')
  .filter((line) => !line.trim().startsWith('//'))
  .join('\n');
assert.ok(!/terrain\.setHaze/.test(populateCode),
  'populate must not call the removed terrain.setHaze');

console.log('VILLAGE FOG BAND: PASS (band contract + single-atmosphere-mechanism fixture)');
