// 소동물 계약(browser 없음): 기러기 V자 편대 기하·적분기, 계절 종 게이트, 규모별 개체수와
// 시선-셀 LOD 커버리지, 필지 실측 앵커에서 나오는 개 순찰 구간·고양이 페르치, 그리고 실제
// 렌더러(critters.js)의 드로우콜·관절 속성·결정론.
//
// Part A 는 순수 모듈만 정적 import 한다(변경 라우팅이 이 파일의 import closure로 잡히도록).
// Part B 는 Three 를 쓰는 실제 렌더러를 Node 에서 번들해 소유권·예산·결정론을 검사한다.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { planVillage } from '../src/api/village-plan.js';
import { VILLAGE_DETAIL_LOD } from '../src/village/lod-policy.js';
import { parcelCritterStation } from '../src/village/critter-station-plan.js';
import { villageWallBaseHeight, VILLAGE_WALL_STYLE_HEIGHT } from '../src/village/wall-contract.js';
import { makeRng } from '../src/rng.js';
import { MATERIAL_PROGRAM_PATCH } from '../src/render/material-program-key.js';
import {
  CAT_COATS, CAT_MOVE, CAT_PERCH, CAT_POSES, CAT_POSE_IDS, CAT_POSE_WEIGHTS,
  DOG_BEAT, DOG_COATS, GROUND_CAP, GROUND_DENSITY, SKEIN, SKY_FLOCK_SEASON, SKY_FLOCK_SPECIES,
  catPerchesFor, createSkein, dogBeatFor, groundPopulation, pickCatPose, pickWeighted,
  skeinHalfAngle, skeinSlots, skeinTargets, skyFlockSpeciesFor, stationPointOk, stepSkein,
} from '../src/env/critter-plan.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCALES = ['hamlet', 'village', 'town', 'capital', 'hanyang'];
const SEEDS = [7, 12, 42];
// 종전 고정 상한(개 2·고양이 2 = 마을 전체). 회귀 방지용 반례로 남긴다.
const LEGACY_CAP = {
  hamlet: { dog: 1, cat: 1 }, village: { dog: 2, cat: 2 }, town: { dog: 4, cat: 3 },
  capital: { dog: 5, cat: 4 }, hanyang: { dog: 6, cat: 5 },
};
const CRITTER_TOKEN = MATERIAL_PROGRAM_PATCH.CRITTER_ARTICULATION;
const failures = [];
function check(name, fn) {
  try { fn(); } catch (error) { failures.push(`${name}: ${error.message}`); }
}
const TAU = Math.PI * 2;
const smoothstep = (a, b, v) => {
  const t = Math.max(0, Math.min(1, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const fade = (v, full, hidden) => 1 - smoothstep(full, hidden, v);

// ============================================================================
// Part A1 — 계절 종 게이트
// ============================================================================
check('season species gate', () => {
  assert.equal(skyFlockSpeciesFor('autumn'), 'goose', '기러기는 가을 도래 겨울철새');
  assert.equal(skyFlockSpeciesFor('winter'), 'goose');
  assert.equal(skyFlockSpeciesFor('spring'), 'resident', '봄 북상 후에는 텃새 무리');
  assert.equal(skyFlockSpeciesFor('summer'), 'resident');
  assert.equal(skyFlockSpeciesFor('nonsense'), 'resident', '알 수 없는 계절은 텃새로 fail-safe');
  assert.deepEqual(Object.keys(SKY_FLOCK_SEASON).sort(), ['autumn', 'spring', 'summer', 'winter']);
  const goose = SKY_FLOCK_SPECIES.goose, resident = SKY_FLOCK_SPECIES.resident;
  assert.equal(goose.formation, true);
  assert.equal(resident.formation, false);
  // 프로토 지오메트리 폭 1.16m × size = 실제 기러기 날개폭(1.4~1.7m) 범위.
  const span = (k) => 1.16 * k;
  assert.ok(span(goose.sizeLo) >= 1.35 && span(goose.sizeHi) <= 1.75,
    `goose wingspan ${span(goose.sizeLo).toFixed(2)}~${span(goose.sizeHi).toFixed(2)}m`);
  assert.ok(goose.flapRate < resident.flapRate, '큰 새는 느리게 날갯짓한다');
  assert.ok(goose.speed > resident.speed, '편대 이동은 텃새 선회보다 빠르다');
  assert.ok(goose.countLo >= 7 && goose.countHi <= 20);
});

// ============================================================================
// Part A2 — V자 편대 기하(swarm 이 아님을 수치로)
// ============================================================================
check('skein slot geometry', () => {
  for (const count of [3, 6, 9, 12, 15]) {
    for (const halfAngle of [0.5, 0.62, 0.72]) {
      const jitter = Array.from({ length: count * 2 + 2 }, (_, i) => (i * 37 % 101) / 101);
      const slots = skeinSlots(count, { halfAngle, spacing: SKEIN.spacing, jitter });
      assert.equal(slots.length, count);
      const lead = slots[0];
      assert.deepEqual([lead.along, lead.cross, lead.arm], [0, 0, 0], '선두는 편대 원점');
      const arms = { '-1': [], 1: [] };
      for (let i = 1; i < slots.length; i++) {
        const slot = slots[i];
        assert.ok(slot.arm === -1 || slot.arm === 1, 'follower must belong to one arm');
        assert.ok(Math.abs(slot.cross) >= SKEIN.minCrossOffset - 1e-9,
          `follower ${i} sits directly behind its leader (cross=${slot.cross.toFixed(2)})`);
        assert.equal(Math.sign(slot.cross), slot.arm, 'cross offset must stay on its own arm');
        assert.ok(slot.along < 0, 'followers trail the leader');
        arms[String(slot.arm)].push(slot);
      }
      assert.ok(Math.abs(arms['-1'].length - arms['1'].length) <= 1, 'arms stay balanced');
      for (const arm of [arms['-1'], arms['1']]) {
        for (let k = 1; k < arm.length; k++) {
          assert.ok(arm[k].along < arm[k - 1].along, 'echelon: deeper rank trails further');
          assert.ok(Math.abs(arm[k].cross) > Math.abs(arm[k - 1].cross),
            'echelon: deeper rank steps further out laterally');
          const gap = Math.hypot(arm[k].along - arm[k - 1].along, arm[k].cross - arm[k - 1].cross);
          assert.ok(gap > SKEIN.spacing * 0.6 && gap < SKEIN.spacing * 1.6,
            `same-arm spacing ${gap.toFixed(2)} outside bounds`);
          const angle = Math.atan2(Math.abs(arm[k].cross), -arm[k].along);
          assert.ok(Math.abs(angle - halfAngle) < 0.4,
            `arm ${k} angle ${angle.toFixed(2)} strays from half angle ${halfAngle}`);
        }
      }
      // 최소 개체 간격(충돌하지 않는 편대).
      for (let i = 0; i < slots.length; i++) {
        for (let j = i + 1; j < slots.length; j++) {
          const d = Math.hypot(slots[i].along - slots[j].along, slots[i].cross - slots[j].cross);
          assert.ok(d > 1.2, `slots ${i}/${j} overlap (${d.toFixed(2)}m)`);
        }
      }
      // "V" 판정: 가장 깊은 개체는 최소 이격의 몇 배로 벌어져 있어야 한다(줄비행·군집이 아님).
      if (count >= 9) {
        const deepest = slots[slots.length - 1];
        assert.ok(Math.abs(deepest.cross) > SKEIN.minCrossOffset * 3,
          `V never opens: deepest cross ${Math.abs(deepest.cross).toFixed(2)}m`);
      }
    }
  }
});

check('skein half angle breathes slowly', () => {
  let prev = skeinHalfAngle(0);
  let maxRate = 0;
  for (let t = 0.5; t <= 200; t += 0.5) {
    const value = skeinHalfAngle(t);
    assert.ok(value > 0.35 && value < 0.95, `half angle ${value} out of range`);
    maxRate = Math.max(maxRate, Math.abs(value - prev) / 0.5);
    prev = value;
  }
  assert.ok(maxRate < 0.02, `half angle changes too fast (${maxRate.toFixed(4)} rad/s)`);
});

function runSkein(seconds, seed = 4242, { dt = 1 / 60 } = {}) {
  const rng = makeRng(seed);
  const state = createSkein({ count: 13, rng, center: { x: 0, z: 0 }, altitude: 45, radius: 128 });
  const samples = [];
  const targets = [];
  let travel = 0;
  let lastX = state.lx, lastZ = state.lz;
  let maxBank = 0;
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) {
    stepSkein(state, dt, rng);
    skeinTargets(state, targets);
    travel += Math.hypot(state.lx - lastX, state.lz - lastZ);
    lastX = state.lx; lastZ = state.lz;
    maxBank = Math.max(maxBank, Math.abs(state.bank));
    if (i % 60 === 0) {
      samples.push({
        t: +state.t.toFixed(3),
        lead: [+state.lx.toFixed(4), +state.ly.toFixed(4), +state.lz.toFixed(4)],
        heading: +state.heading.toFixed(5),
        bank: +state.bank.toFixed(5),
        order: state.order.slice(),
        first: targets.map((target) => [+target.x.toFixed(3), +target.z.toFixed(3)]),
      });
    }
    // 편대 정합: 팔 부호 유지 + 선두 슬롯은 항상 최전방.
    let leadAlong = null;
    for (const target of targets) {
      if (target.rank === 0) leadAlong = target;
    }
    assert.ok(leadAlong, 'leader target must exist');
    assert.ok(Math.abs(state.bank) <= SKEIN.maxBank + 1e-9, 'bank exceeds policy');
    assert.ok(state.order.length === state.count);
    assert.equal(new Set(state.order).size, state.count, 'slot assignment must stay a permutation');
  }
  return { state, samples, travel, maxBank, targets };
}

check('skein stays inside the framed bowl', () => {
  // 편대가 프레임 밖으로 나가 버리면 사용자에게는 "새가 없다"가 된다. 이탈 상한은 통과 반경 +
  // U턴 한 번의 기하적 초과분(선회 반경 = speed / maxTurnRate)으로 닫는다.
  const turnRadius = SKY_FLOCK_SPECIES.goose.speed / SKEIN.maxTurnRate;
  for (const radius of [37, 64, 88, 128, 176, 250, 500]) {
    for (const seed of [1, 7, 31337, 999]) {
      const rng = makeRng(seed);
      const center = { x: 20, z: -10 };
      const state = createSkein({ count: 13, rng, center, altitude: 60, radius });
      let maxDistance = 0;
      for (let i = 0; i < 60 * 240; i++) {
        stepSkein(state, 1 / 60, rng);
        maxDistance = Math.max(maxDistance, Math.hypot(state.lx - center.x, state.lz - center.z));
      }
      const bound = state.outR + turnRadius * 2.4;
      assert.ok(maxDistance <= bound,
        `radius ${radius} seed ${seed}: skein ran to ${maxDistance.toFixed(0)}m (leash bound ${bound.toFixed(0)}m)`);
      assert.ok(maxDistance > state.outR * 0.6, 'skein never travels — it must cross, not hover');
      assert.ok(state.crossings >= 4, `radius ${radius}: only ${state.crossings} crossings in 240s`);
      // 기본 부감 프레이밍(마을 반경 128 기준)에서는 항상 분지 안에 남는다.
      if (radius === 128) {
        assert.ok(maxDistance < radius * 0.95,
          `flagship aerial framing loses the skein (${maxDistance.toFixed(0)}m)`);
      }
    }
  }
});

check('skein integrator crosses the sky as one body', () => {
  const { state, travel, maxBank, targets } = runSkein(200);
  assert.ok(travel > 1500, `skein mills instead of crossing (${travel.toFixed(0)}m in 200s)`);
  assert.ok(state.crossings >= 1, 'skein never re-crosses the village');
  assert.ok(state.rotations >= 2, `leader never rotated (${state.rotations})`);
  assert.ok(maxBank > 0.02, 'skein never banks');
  // 무리 전체가 같은 방향으로 기운다(개체별 독립 롤 금지).
  const rolls = new Set(targets.map((target) => Math.sign(target.roll)));
  assert.ok(rolls.size <= 1, 'formation rolls must share one sign');
  // 편대 폭·깊이가 정상 범위(퍼져 흩어지지 않음).
  let maxCross = 0, minAlongDelta = Infinity;
  for (const target of targets) {
    maxCross = Math.max(maxCross, Math.hypot(target.x - state.lx, target.z - state.lz));
  }
  assert.ok(maxCross < 60, `formation too spread (${maxCross.toFixed(1)}m)`);
  for (let i = 0; i < targets.length; i++) {
    for (let j = i + 1; j < targets.length; j++) {
      minAlongDelta = Math.min(minAlongDelta,
        Math.hypot(targets[i].x - targets[j].x, targets[i].z - targets[j].z));
    }
  }
  assert.ok(minAlongDelta > 1.0, `formation members overlap (${minAlongDelta.toFixed(2)}m)`);
});

check('skein is deterministic and never touches global Math.random', () => {
  const a = runSkein(60, 991);
  const b = runSkein(60, 991);
  assert.equal(JSON.stringify(a.samples), JSON.stringify(b.samples), 'same seed must replay exactly');
  const c = runSkein(60, 992);
  assert.notEqual(JSON.stringify(a.samples), JSON.stringify(c.samples), 'different seed must differ');
  const original = Math.random;
  Math.random = () => { throw new Error('global Math.random consumed'); };
  try { runSkein(20, 993); } finally { Math.random = original; }
});

// ============================================================================
// Part A3 — 개체수 정책과 시선-셀 LOD 커버리지
// ============================================================================
check('ground population is density-driven and capped', () => {
  assert.deepEqual(groundPopulation('village', 0), { dog: 0, cat: 0, magpie: 0 });
  for (const scale of SCALES) {
    const cap = GROUND_CAP[scale];
    const huge = groundPopulation(scale, 10000);
    assert.deepEqual(huge, { dog: cap.dog, cat: cap.cat, magpie: cap.magpie }, `${scale} cap`);
    let previous = groundPopulation(scale, 1);
    for (let parcels = 2; parcels <= 400; parcels++) {
      const next = groundPopulation(scale, parcels);
      for (const key of ['dog', 'cat', 'magpie']) {
        assert.ok(next[key] >= previous[key], `${scale} ${key} must not decrease with parcels`);
        assert.ok(next[key] >= 1, `${scale} ${key} must never be zero for a populated plan`);
      }
      previous = next;
    }
    assert.ok(cap.cat >= cap.dog, '고양이는 개보다 많다(사용자 요청 축)');
  }
  assert.ok(GROUND_DENSITY.cat.perParcel > GROUND_DENSITY.dog.perParcel);
  // 회귀 방지: 종전 고정 상한보다 반드시 많다.
  assert.ok(groundPopulation('village', 28).dog >= 6, 'village dogs must exceed the legacy 2');
  assert.ok(groundPopulation('village', 28).cat >= 8, 'village cats must exceed the legacy 2');
});

// 실제 plan 으로 커버리지를 잰다: "지금 보고 있는 필지 근처에 개/고양이가 있는가".
function coverage(homes, parcels) {
  let full = 0, any = 0, weight = 0;
  for (const parcel of parcels) {
    let best = 0, nearFull = false, nearAny = false;
    for (const home of homes) {
      const d = Math.hypot(home.x - parcel.center.x, home.z - parcel.center.z);
      if (d <= VILLAGE_DETAIL_LOD.spatial.full) nearFull = true;
      if (d < VILLAGE_DETAIL_LOD.spatial.hidden) nearAny = true;
      best = Math.max(best, fade(d, VILLAGE_DETAIL_LOD.spatial.full, VILLAGE_DETAIL_LOD.spatial.hidden));
    }
    if (nearFull) full++;
    if (nearAny) any++;
    weight += best;
  }
  const n = Math.max(1, parcels.length);
  return { full: full / n, any: any / n, weight: weight / n };
}

// critters.js 와 같은 셔플·선택 순서를 순수하게 재현한다(placementRng → 정렬 → 앞에서 N개).
function shuffledParcels(plan) {
  const parcels = plan.parcels.filter((parcel) => !parcel.hero && parcel.poly);
  const rng = makeRng(((plan.seed ^ 0x00c1c7) ^ 0x504c4143) >>> 0);
  return parcels
    .map((parcel) => ({ parcel, key: rng() }))
    .sort((a, b) => a.key - b.key)
    .map((entry) => entry.parcel);
}

const coverageReport = [];
let legacyMisses = 0;
check('village dog/cat coverage clears the view-cell LOD window', () => {
  for (const scale of SCALES) {
    for (const seed of SEEDS) {
      const plan = planVillage({
        scale, seed, includePalace: scale === 'capital' || scale === 'hanyang',
      });
      const parcels = plan.parcels.filter((parcel) => !parcel.hero && parcel.poly);
      const order = shuffledParcels(plan);
      const population = groundPopulation(scale, parcels.length);
      const now = {
        dog: coverage(order.slice(0, population.dog).map((p) => p.center), parcels),
        cat: coverage(order.slice(0, population.cat).map((p) => p.center), parcels),
      };
      const legacy = {
        dog: coverage(order.slice(0, LEGACY_CAP[scale].dog).map((p) => p.center), parcels),
        cat: coverage(order.slice(0, LEGACY_CAP[scale].cat).map((p) => p.center), parcels),
      };
      coverageReport.push({
        scale, seed, parcels: parcels.length,
        dogs: population.dog, cats: population.cat,
        fullNow: +now.dog.full.toFixed(2), fullLegacy: +legacy.dog.full.toFixed(2),
        anyNow: +now.dog.any.toFixed(2), anyLegacy: +legacy.dog.any.toFixed(2),
      });
      // 필지·siteR 확대 뒤 필지 중심 간격이 32m full-detail 창과 비슷해져
      // 같은 밀도라도 커버 분율이 줄 수 있다. 한양은 원래 넓어 0.40, 그 외 0.55.
      const floorFull = scale === 'hanyang' ? 0.40 : 0.55;
      for (const kind of ['dog', 'cat']) {
        assert.ok(now[kind].full >= floorFull,
          `${scale}:${seed} ${kind} full-detail parcel coverage ${now[kind].full.toFixed(2)} < ${floorFull}`);
        assert.ok(now[kind].any >= 0.85,
          `${scale}:${seed} ${kind} any coverage ${now[kind].any.toFixed(2)} < 0.85`);
        assert.ok(now[kind].full >= legacy[kind].full,
          `${scale}:${seed} ${kind} coverage regressed below the legacy fixed cap`);
      }
      if (legacy.dog.full < floorFull) legacyMisses++;
      // 한양은 종전 상한(개 6/도성 전체)으로는 근접 커버리지가 사실상 0이었다.
      if (scale === 'hanyang') {
        assert.ok(legacy.dog.full < 0.30,
          `${seed} legacy hanyang coverage ${legacy.dog.full.toFixed(2)} — counter-example lost`);
      }
    }
  }
  // 이 게이트가 실효적인지 자체 검증: 종전 고정 상한은 대부분의 규모·시드에서 기준을 못 넘는다.
  assert.ok(legacyMisses >= 8,
    `legacy fixed caps passed the coverage floor in too many cases (${legacyMisses}/15 missed)`);
});

// ============================================================================
// Part A4 — 개 순찰 구간·고양이 페르치가 실제 담·집을 지키는가
// ============================================================================
const stationReport = { beats: 0, walking: 0, perches: 0, walltop: 0, gatepost: 0, yard: 0 };
check('dog beats and cat perches respect the real wall, gate and house', () => {
  for (const scale of SCALES) {
    for (const seed of SEEDS) {
      const plan = planVillage({
        scale, seed, includePalace: scale === 'capital' || scale === 'hanyang',
      });
      const char01 = typeof plan.opts?.char01 === 'number' ? plan.opts.char01 : 0.5;
      const order = shuffledParcels(plan);
      const population = groundPopulation(scale, order.length);
      const dogRng = makeRng((((plan.seed ^ 0x00c1c7) ^ 0x444f4753) >>> 0));
      const catRng = makeRng((((plan.seed ^ 0x00c1c7) ^ 0x43415453) >>> 0));
      // critters.js 와 같은 선택: 자리를 검증 못한 필지는 건너뛰고 다음 필지에서 채운다.
      let placedDogs = 0;
      for (const parcel of order) {
        if (placedDogs >= population.dog) break;
        const station = parcelCritterStation(parcel, plan.site, char01);
        assert.ok(station, `${scale}:${seed} ${parcel.id} has no station record`);
        const beat = dogBeatFor(station, dogRng);
        if (!beat) continue;
        placedDogs++;
        stationReport.beats++;
        if (beat.half >= 1) stationReport.walking++;
        const clearance = station.wallThickness * 0.5 + 0.45;
        const samples = Math.max(6, Math.ceil(beat.half * 2 / 0.25));
        for (let s = 0; s <= samples; s++) {
          const u = (s / samples) * 2 - 1;
          const x = (beat.ax + beat.bx) * 0.5 + (beat.bx - beat.ax) * 0.5 * u;
          const z = (beat.az + beat.bz) * 0.5 + (beat.bz - beat.az) * 0.5 * u;
          assert.ok(stationPointOk(station, x, z, clearance * 0.92, -DOG_BEAT.eaveWalkIn - 0.05),
            `${scale}:${seed} ${parcel.id} dog beat leaves the parcel or crosses its own wall`);
        }
        assert.ok(Number.isFinite(beat.half) && beat.half >= 0);
        assert.ok(beat.standoff >= DOG_BEAT.standoff, 'standoff below policy');
      }
      assert.ok(placedDogs >= Math.min(population.dog, Math.max(1, Math.floor(population.dog * 0.8))),
        `${scale}:${seed} only ${placedDogs}/${population.dog} dogs found a legal beat`);
      let placedCats = 0;
      for (const parcel of order) {
        if (placedCats >= population.cat) break;
        const station = parcelCritterStation(parcel, plan.site, char01);
        const perches = catPerchesFor(station, catRng, CAT_PERCH);
        if (!perches) continue;
        placedCats++;
        assert.ok(perches.length >= 1, `${scale}:${seed} ${parcel.id} cat has no perch`);
        stationReport.perches += perches.length;
        for (const perch of perches) {
          assert.ok(Number.isFinite(perch.x) && Number.isFinite(perch.z) && Number.isFinite(perch.y));
          assert.ok(Math.hypot(perch.dirX, perch.dirZ) > 0.5, 'perch needs a facing direction');
          if (perch.kind === 'walltop') {
            stationReport.walltop++;
            // 담 상단 높이는 renderer 가 쓰는 계약값과 정확히 같아야 한다(추정 금지).
            const expected = villageWallBaseHeight(parcel.wallType, {
              char01, wallHeightK: parcel.wallHeightK,
            });
            assert.ok(Math.abs(perch.y - expected) < 1e-9 || perch.y <= expected + 1e-9,
              `${parcel.id} wall-top perch ${perch.y} above the wall contract ${expected}`);
            assert.ok(perch.y >= 1.0 && perch.y <= VILLAGE_WALL_STYLE_HEIGHT.tile * 1.25,
              `wall-top perch height ${perch.y.toFixed(2)} implausible`);
            // 대문 개구 안에 앉지 않는다.
            const along = (perch.x - station.gate.x) * station.tangent.x
              + (perch.z - station.gate.z) * station.tangent.z;
            assert.ok(Math.abs(along) >= station.gateHalfGap + CAT_PERCH.wallInset - 1e-6,
              `${parcel.id} cat sits inside the gate opening`);
            // 담 선(대문 변) 위에 있어야 한다.
            const off = (perch.x - station.gate.x) * -station.tangent.z
              + (perch.z - station.gate.z) * station.tangent.x;
            assert.ok(Math.abs(off) < 1e-6, `${parcel.id} wall-top perch is off the wall line`);
          } else if (perch.kind === 'gatepost') {
            stationReport.gatepost++;
            assert.ok(perch.y > 0.6 && perch.y < 2.6);
          } else {
            stationReport.yard++;
            assert.equal(perch.y, 0, 'ground perches sit on the parcel pad');
            assert.ok(stationPointOk(station, perch.x, perch.z, station.wallThickness * 0.5 + 0.3, 0.25),
              `${parcel.id} yard perch is outside the parcel or inside the house`);
          }
        }
      }
      assert.ok(placedCats >= Math.min(population.cat, Math.max(1, Math.floor(population.cat * 0.8))),
        `${scale}:${seed} only ${placedCats}/${population.cat} cats found a legal perch`);
    }
  }
  assert.ok(stationReport.walking / stationReport.beats > 0.6,
    `too many dogs are stuck in place (${stationReport.walking}/${stationReport.beats})`);
  assert.ok(stationReport.walltop / Math.max(1, stationReport.perches) > 0.25,
    'wall-top cats disappeared — the silhouette perch is the visibility lever');
});

// 반례(회귀 고정): 종전 배치는 앞마당 앵커(+W*0.1, +D*0.62 = 앞담 밖) 주변 반경 6.5m 를
// 랜덤워크했다. 그 원의 상당 부분이 담 안쪽이라 개가 자기 집 담을 통과해 걸었다.
// 이 반례가 통과해 버리면 위의 담 이격 계약은 아무것도 보장하지 않는다.
check('legacy dog wander ring must fail the wall containment contract', () => {
  let tested = 0, violated = 0;
  for (const seed of SEEDS) {
    const plan = planVillage({ scale: 'village', seed });
    const char01 = typeof plan.opts?.char01 === 'number' ? plan.opts.char01 : 0.5;
    for (const parcel of shuffledParcels(plan)) {
      const station = parcelCritterStation(parcel, plan.site, char01);
      if (!station) continue;
      const W = parcel.plotW || 20, D = parcel.plotD || 18;
      const home = { x: W * 0.1, z: D * 0.62 };
      const clearance = station.wallThickness * 0.5 + 0.45;
      tested++;
      let bad = 0;
      for (let i = 0; i < 24; i++) {
        const angle = (i / 24) * Math.PI * 2;
        for (const radius of [2, 4, 6.5]) {
          const x = home.x + Math.cos(angle) * radius;
          const z = home.z + Math.sin(angle) * radius;
          if (!stationPointOk(station, x, z, clearance, -DOG_BEAT.eaveWalkIn)) bad++;
        }
      }
      if (bad > 0) violated++;
    }
  }
  assert.ok(tested > 40, 'counter-example needs a representative parcel cohort');
  assert.ok(violated / tested > 0.9,
    `legacy wander ring stayed legal on ${((1 - violated / tested) * 100).toFixed(0)}% of parcels`);
});

check('station placement is seed-deterministic', () => {
  const plan = planVillage({ scale: 'village', seed: 12 });
  const char01 = plan.opts.char01;
  const parcel = shuffledParcels(plan)[0];
  const station = parcelCritterStation(parcel, plan.site, char01);
  const snapshot = (seed) => JSON.stringify([
    dogBeatFor(station, makeRng(seed)),
    catPerchesFor(station, makeRng(seed)),
  ]);
  assert.equal(snapshot(77), snapshot(77));
  assert.notEqual(snapshot(77), snapshot(78));
  assert.equal(JSON.stringify(parcelCritterStation(parcel, plan.site, char01)), JSON.stringify(station));
});

// ============================================================================
// Part A5 — 털색 대비와 고양이 자세표
// ============================================================================
const REC709 = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
check('coat variety creates ground contrast', () => {
  for (const list of [DOG_COATS, CAT_COATS]) {
    const total = list.reduce((sum, coat) => sum + coat.weight, 0);
    assert.ok(Math.abs(total - 1) < 1e-6, 'coat weights must sum to 1');
    const seen = new Set();
    for (let i = 0; i < 200; i++) seen.add(pickWeighted(list, i / 200));
    assert.equal(seen.size, list.length, 'every coat must be reachable');
    for (const coat of list) {
      assert.ok(coat.tint.every((value) => value > 0 && value < 4), `${coat.id} tint out of range`);
    }
  }
  // 다진 흙 마당(0x7a7060, terrain.js cCourt)과 누렁이(0xc79a5b)의 명도차는 1.4배뿐이다.
  const ground = REC709(0x7a / 255, 0x70 / 255, 0x60 / 255);
  const baseDog = [0xc7 / 255, 0x9a / 255, 0x5b / 255];
  const legacy = REC709(...baseDog) / ground;
  let bright = 0, dark = 0;
  for (const coat of DOG_COATS) {
    const lum = REC709(...baseDog.map((value, i) => value * coat.tint[i]));
    if (lum / ground > legacy * 1.25) bright++;
    if (lum / ground < 0.75) dark++;
  }
  assert.ok(bright >= 1, 'no light coat to read against dark ground');
  assert.ok(dark >= 1, 'no dark coat to read against lit ground');
});

check('cat pose table stays micro-scale with one deliberate beat', () => {
  assert.equal(CAT_POSE_IDS.length, CAT_POSE_WEIGHTS.length);
  assert.ok(Math.abs(CAT_POSE_WEIGHTS.reduce((a, b) => a + b, 0) - 1) < 1e-6);
  const seen = new Set();
  for (let i = 0; i < 500; i++) seen.add(pickCatPose(i / 500).id);
  assert.equal(seen.size, CAT_POSE_IDS.length, 'every pose must be reachable');
  for (const id of CAT_POSE_IDS) {
    const pose = CAT_POSES[id];
    assert.ok(pose.squash >= 0.75 && pose.squash <= 1.15, `${id} squash out of range`);
    assert.ok(pose.stretch >= 0.9 && pose.stretch <= 1.3, `${id} stretch out of range`);
    assert.ok(Math.abs(pose.lift) <= 0.05, `${id} lift is not micro-scale`);
    assert.ok(pose.hold[0] > 0.9 && pose.hold[1] > pose.hold[0], `${id} hold window invalid`);
  }
  assert.ok(CAT_MOVE.dashSpeed > CAT_MOVE.walkSpeed * 3, 'dash must read as a beat, not a walk');
  assert.ok(CAT_MOVE.walkSpeed <= 1.4, 'ordinary cat travel stays a soft walk');
  assert.ok(CAT_MOVE.dashChance <= 0.3, 'the dash is occasional by policy');
  assert.ok(CAT_MOVE.restLo >= 6, 'cats hold a pose long enough to read as still');
});

// ============================================================================
// Part B — 실제 렌더러(critters.js): 드로우콜·관절 속성·결정론
// ============================================================================
const requireApp = createRequire(join(ROOT, 'app', 'package.json'));
const esbuild = requireApp('esbuild');
const built = await esbuild.build({
  stdin: {
    contents: `
      export { setupVillageCritters, CRITTER_ANIM_DRIVER } from './src/env/critters.js';
      export * as THREE from 'three';
    `,
    resolveDir: ROOT,
    sourcefile: 'critter-contract-entry.js',
  },
  alias: {
    'three/addons': join(ROOT, 'app/node_modules/three/examples/jsm'),
    three: join(ROOT, 'app/node_modules/three/build/three.module.js'),
  },
  bundle: true, format: 'esm', platform: 'node', target: 'node20', write: false, logLevel: 'silent',
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString('base64')}`;
const { setupVillageCritters, CRITTER_ANIM_DRIVER, THREE } = await import(moduleUrl);

function buildRig(scale, seed) {
  const plan = planVillage({
    scale, seed, includePalace: scale === 'capital' || scale === 'hanyang',
  });
  const char01 = typeof plan.opts?.char01 === 'number' ? plan.opts.char01 : 0.5;
  const parcels = [];
  for (const parcel of plan.parcels) {
    if (parcel.hero || !parcel.poly) continue;
    parcels.push({
      x: parcel.center.x, z: parcel.center.z,
      baseY: parcel.baseY != null ? parcel.baseY : plan.site.heightAt(parcel.center.x, parcel.center.z),
      W: parcel.plotW || 20, D: parcel.plotD || 18,
      rotY: 0, kind: parcel.kind === 'giwa' ? 'giwa' : 'choga',
      station: parcelCritterStation(parcel, plan.site, char01),
    });
  }
  const group = new THREE.Group();
  const rig = setupVillageCritters(group, {
    heightAt: (x, z) => plan.site.heightAt(x, z),
    center: plan.site.center || { x: 0, z: 0 },
    radius: Math.max(plan.bounds?.w || 0, plan.bounds?.d || 0) * 0.5 || 40,
    scale, parcels, treePerches: [{ x: 0, y: 12, z: 0 }],
    seed: (plan.seed ^ 0x00c1c7) >>> 0,
  });
  return { plan, group, rig, parcels };
}

const budget = [];
check('renderer keeps one instanced mesh per species and one shared material', () => {
  for (const scale of SCALES) {
    const { group, rig } = buildRig(scale, 12);
    const meshes = [];
    group.traverse((object) => { if (object.isMesh || object.isInstancedMesh) meshes.push(object); });
    assert.ok(meshes.length <= 4, `${scale} critters use ${meshes.length} draw objects (max 4)`);
    const materials = new Set(meshes.map((mesh) => mesh.material.uuid));
    assert.ok(materials.size <= 2, `${scale} uses ${materials.size} materials (ground + sky only)`);
    for (const mesh of meshes) {
      assert.ok(!mesh.material.map, 'critters must stay texture-free');
      assert.ok(mesh.isInstancedMesh, 'every critter batch is instanced');
    }
    const named = Object.fromEntries(meshes.map((mesh) => [mesh.name, mesh]));
    assert.deepEqual(Object.keys(named).sort(), ['birds', 'v-cats', 'v-dogs', 'v-magpies']);
    assert.equal(rig.counts.dogs, named['v-dogs'].count);
    assert.equal(rig.counts.cats, named['v-cats'].count);
    budget.push({
      scale, drawObjects: meshes.length, materials: materials.size,
      dogs: rig.counts.dogs, cats: rig.counts.cats, magpies: rig.counts.magpies,
      birds: named.birds.count,
      triangles: meshes.reduce((sum, mesh) => sum
        + (mesh.geometry.attributes.position.count / 3) * (mesh.count || 1), 0),
    });
  }
});

check('articulation rides vertex attributes, not extra draw calls', () => {
  const { group } = buildRig('village', 12);
  for (const name of ['v-dogs', 'v-cats', 'v-magpies']) {
    const mesh = group.getObjectByName(name);
    const geometry = mesh.geometry;
    for (const attribute of ['aPivot', 'aSwing', 'aAnim', 'color', 'position']) {
      assert.ok(geometry.attributes[attribute], `${name} lost ${attribute}`);
    }
    assert.equal(geometry.attributes.aAnim.itemSize, 4);
    assert.equal(geometry.attributes.aAnim.isInstancedBufferAttribute, true);
    assert.equal(geometry.attributes.aAnim.count, mesh.count);
    const swing = geometry.attributes.aSwing;
    const drivers = new Set();
    let animated = 0;
    for (let i = 0; i < swing.count; i++) {
      if (swing.getX(i) !== 0) { animated++; drivers.add(swing.getZ(i)); }
    }
    assert.ok(animated > 0, `${name} has no animated part`);
    assert.ok(drivers.has(CRITTER_ANIM_DRIVER.TAIL), `${name} tail is not articulated`);
    if (name === 'v-dogs') {
      assert.ok(drivers.has(CRITTER_ANIM_DRIVER.GAIT), 'dog legs are not articulated');
      assert.ok(drivers.has(CRITTER_ANIM_DRIVER.HEAD), 'dog head is not articulated');
    }
    assert.ok(mesh.instanceColor || name === 'v-magpies', `${name} lost coat variety`);
  }
  // 관절은 공유 재질 하나의 프로그램 키만 갈아탄다(재질·프로그램 계열 추가 없음).
  const dog = group.getObjectByName('v-dogs');
  const cat = group.getObjectByName('v-cats');
  assert.equal(dog.material, cat.material, 'ground critters must share one material');
  assert.equal(typeof dog.material.customProgramCacheKey, 'function');
  assert.ok(dog.material.customProgramCacheKey().split('|').includes(CRITTER_TOKEN),
    'articulated ground material must own an explicit program token');
});

check('critter layer is independent of global Math.random', () => {
  const snapshot = (hostile) => {
    const original = Math.random;
    if (hostile) {
      let state = 12345;
      Math.random = () => { state = (state * 1103515245 + 12345) % 2147483648; return state / 2147483648; };
    }
    try {
      const { group, rig } = buildRig('village', 12);
      for (let i = 0; i < 180; i++) rig.update(1 / 60);
      const out = [];
      const matrix = new THREE.Matrix4();
      for (const name of ['v-dogs', 'v-cats', 'v-magpies', 'birds']) {
        const mesh = group.getObjectByName(name);
        for (let i = 0; i < mesh.count; i++) {
          mesh.getMatrixAt(i, matrix);
          out.push(matrix.elements.map((value) => +value.toFixed(4)));
        }
      }
      return JSON.stringify(out);
    } finally { Math.random = original; }
  };
  assert.equal(snapshot(false), snapshot(true),
    'critter placement/animation must not read the global RNG stream');
});

check('season switch swaps sky species without changing draw calls', () => {
  const { group, rig } = buildRig('village', 12);
  const birds = group.getObjectByName('birds');
  rig.setSeason('summer');
  for (let i = 0; i < 120; i++) rig.update(1 / 60);
  const summer = rig.debugFlock();
  assert.equal(summer.species, 'resident');
  assert.equal(summer.formation, false);
  const residentCount = birds.count;
  rig.setSeason('autumn');
  for (let i = 0; i < 600; i++) rig.update(1 / 60);
  const autumn = rig.debugFlock();
  assert.equal(autumn.species, 'goose');
  assert.equal(autumn.formation, true);
  assert.ok(birds.count >= SKY_FLOCK_SPECIES.goose.countLo);
  assert.ok(birds.count <= Math.max(residentCount, SKY_FLOCK_SPECIES.goose.countHi));
  // 실제 인스턴스 위치가 V자인지 검사한다: 진행 방향 기준 좌우 두 팔 + 뒤로 벌어짐.
  const matrix = new THREE.Matrix4();
  const points = [];
  for (let i = 0; i < birds.count; i++) {
    birds.getMatrixAt(i, matrix);
    points.push({ x: matrix.elements[12], y: matrix.elements[13], z: matrix.elements[14] });
  }
  const heading = autumn.heading;
  const fx = Math.cos(heading), fz = Math.sin(heading);
  const lead = points.reduce((best, point) => {
    const along = point.x * fx + point.z * fz;
    return along > best.along ? { along, point } : best;
  }, { along: -Infinity, point: null });
  let left = 0, right = 0, maxWidth = 0;
  for (const point of points) {
    if (point === lead.point) continue;
    const dx = point.x - lead.point.x, dz = point.z - lead.point.z;
    const along = dx * fx + dz * fz;
    const cross = dx * -fz + dz * fx;
    assert.ok(along < 0.5, 'no follower may fly ahead of the leader');
    assert.ok(Math.abs(cross) > 0.4, 'no follower may sit directly behind the leader');
    if (cross < 0) left++; else right++;
    maxWidth = Math.max(maxWidth, Math.abs(cross));
  }
  assert.ok(left > 0 && right > 0, 'a V needs both arms occupied');
  assert.ok(Math.abs(left - right) <= 2, `arms unbalanced (${left}/${right})`);
  assert.ok(maxWidth > 3, `formation never opens (max width ${maxWidth.toFixed(1)}m)`);
  rig.setSeason('spring');
  for (let i = 0; i < 60; i++) rig.update(1 / 60);
  assert.equal(rig.debugFlock().species, 'resident');
});

// ============================================================================
if (process.env.CHEOMA_CRITTER_REPORT !== '0') {
  console.log('coverage (parcels with a dog inside the 32m full-detail window):');
  for (const row of coverageReport) {
    console.log(`  ${row.scale}/${row.seed}`.padEnd(18)
      + `parcels=${String(row.parcels).padStart(3)} dogs=${String(row.dogs).padStart(2)} cats=${String(row.cats).padStart(2)}`
      + `  full ${(row.fullLegacy * 100).toFixed(0)}% → ${(row.fullNow * 100).toFixed(0)}%`
      + `  any ${(row.anyLegacy * 100).toFixed(0)}% → ${(row.anyNow * 100).toFixed(0)}%`);
  }
  console.log('station plan:', JSON.stringify(stationReport));
  console.log('budget:');
  for (const row of budget) console.log('  ', JSON.stringify(row));
}

if (failures.length) {
  console.error(`\ncritter contract FAILED (${failures.length})`);
  for (const failure of failures) console.error(` - ${failure}`);
  process.exit(1);
}
console.log('critter contract OK');
