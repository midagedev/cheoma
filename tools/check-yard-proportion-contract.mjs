// 필지·마당 비례 계약 (순수 node, 브라우저 없음).
//
// 근거: docs/architectural-authenticity.md §9 · HANDOFF §3.1
//   - 멍석 짧은 변 2.1 m 가 앞마당 깊이의 하한
//   - L/H ≈ 2.55 (마당 길이 ÷ 채 높이) 가 단정 가능한 1차 비례, 관측 대역 1–3
//   - 마당은 작업 면적 역산이 아니라 채 크기의 종속 변수
//   - 집 축소 금지: structureScale 과 LOT_SCALE 을 분리해 필지만 키운다
//
// 수정 전(seed 7) 대표값 — 이 게이트가 공허해지지 않게 음성 대조군으로 내장:
//   village 기와 앞마당 평균 0.8 m (최소 0.3) · hamlet 초가 houseFit 평균 0.833 (전량 축소)
//
// 판정:
//   1. 모든 비-히어로 주거 앞마당 ≥ 2.1 m
//   2. 기와 L/H 규모 평균이 관측 대역 (1, 3.5] 안 (상한은 초가 개방 마당 여유)
//   3. 농촌 명명 tier 의 structureScale = 1 (집 축척을 필지 확대와 묶지 않음)
//   4. hamlet houseFit 평균 ≥ 0.90 (필지 확대가 온전한 집 크기를 되돌림)
//   5. 음성 대조: 수정 전 village 기와 앞마당 0.8 m 은 하한을 깨므로, 현재 측정이
//      그 값 이하로 떨어지면 회귀

import { planVillage } from '../src/api/village-plan.js';
import { parcelLocalRoofBounds } from '../src/village/house-footprint.js';
import { impostorHouseSpec } from '../src/village/impostor-spec.js';

const SCALES = ['hamlet', 'village', 'town', 'capital', 'hanyang'];
const SEEDS = [7, 42, 91];
const MAT_FLOOR_M = 2.1;
// 관측 대역 1 < L/H ≤ 3 의 69%. 제품 평균은 그 안에 두고, 초가 개방 마당은 상한을 조금 연다.
const LH_MIN = 1.0;
const LH_MAX = 3.6;
const GIWA_LH_MIN_MEAN = 1.45; // 수정 전 village 기와 ~0.2 대 — 1.45 면 실질 회복
const HAMLET_FIT_FLOOR = 0.90;
// 수정 전 seed-7 village 기와 앞마당 평균(measure-yard-proportion). 이하면 회귀.
const PRE_FIX_VILLAGE_GIWA_FRONT = 0.8;

const errors = [];
function invariant(condition, message) {
  if (!condition) errors.push(message);
}

function eaveHeight(parcel) {
  const body = impostorHouseSpec(parcel).body;
  const base = Number.isFinite(body?.y1) ? body.y1 : 3.5;
  return base * (Number.isFinite(parcel.sy) ? parcel.sy : 1);
}

function frontYard(parcel) {
  const bounds = parcelLocalRoofBounds(parcel);
  return (parcel.plotD * 0.5) - bounds.maxZ;
}

const samples = [];
for (const scale of SCALES) {
  for (const seed of SEEDS) {
    const plan = planVillage({ scale, seed });
    const parcels = (plan.parcels || []).filter((p) => (
      !p.hero
      && (p.kind === 'giwa' || p.kind === 'choga')
      && Number.isFinite(p.plotW)
      && Number.isFinite(p.plotD)
      && Number.isFinite(p.houseFitFactor)
    ));
    invariant(parcels.length > 0, `${scale}/${seed}: no residential parcels`);
    for (const parcel of parcels) {
      let front;
      try {
        front = frontYard(parcel);
      } catch (error) {
        errors.push(`${scale}/${seed}/${parcel.id ?? '?'}: roof bounds failed: ${error.message}`);
        continue;
      }
      const eaveH = eaveHeight(parcel);
      const lh = front / Math.max(1e-6, eaveH);
      samples.push({
        scale,
        seed,
        kind: parcel.kind,
        front,
        lh,
        fit: parcel.houseFitFactor,
        structureScale: parcel.structureScale,
      });
      invariant(
        front + 1e-6 >= MAT_FLOOR_M,
        `${scale}/${seed} ${parcel.kind}: front yard ${front.toFixed(2)}m < mat floor ${MAT_FLOOR_M}m`,
      );
    }
  }
}

const byScaleKind = new Map();
for (const row of samples) {
  const key = `${row.scale}:${row.kind}`;
  (byScaleKind.get(key) || byScaleKind.set(key, []).get(key)).push(row);
}

const avg = (rows, key) => rows.reduce((sum, row) => sum + row[key], 0) / rows.length;

for (const [key, rows] of byScaleKind) {
  const [scale, kind] = key.split(':');
  const meanLh = avg(rows, 'lh');
  const meanFront = avg(rows, 'front');
  const meanFit = avg(rows, 'fit');
  if (kind === 'giwa' && rows.length >= 3) {
    invariant(
      meanLh + 1e-6 >= LH_MIN && meanLh - 1e-6 <= LH_MAX,
      `${scale} giwa mean L/H ${meanLh.toFixed(2)} outside band (${LH_MIN}, ${LH_MAX}]`,
    );
    invariant(
      meanLh + 1e-6 >= GIWA_LH_MIN_MEAN,
      `${scale} giwa mean L/H ${meanLh.toFixed(2)} below recovery floor ${GIWA_LH_MIN_MEAN}`,
    );
  }
  if (scale === 'village' && kind === 'giwa') {
    invariant(
      meanFront > PRE_FIX_VILLAGE_GIWA_FRONT + 1.0,
      `village giwa mean front ${meanFront.toFixed(2)}m did not clear pre-fix ${PRE_FIX_VILLAGE_GIWA_FRONT}m by ≥1m`,
    );
  }
  if (scale === 'hamlet') {
    invariant(
      meanFit + 1e-6 >= HAMLET_FIT_FLOOR,
      `hamlet ${kind} mean houseFit ${meanFit.toFixed(3)} < ${HAMLET_FIT_FLOOR}`,
    );
  }
}

// 농촌 명명 tier 는 필지 확대와 집 축척을 묶지 않는다 (structureScale = 1).
for (const row of samples) {
  if (row.scale === 'hamlet' || row.scale === 'village' || row.scale === 'town') {
    invariant(
      Math.abs((row.structureScale ?? 1) - 1) <= 1e-9,
      `${row.scale} structureScale ${row.structureScale} must be 1 so lot expansion grows yards, not houses`,
    );
  }
}

if (errors.length) {
  console.error('YARD PROPORTION CONTRACT: FAIL');
  for (const message of errors.slice(0, 40)) console.error(' -', message);
  if (errors.length > 40) console.error(` … +${errors.length - 40} more`);
  process.exit(1);
}

const villageGiwa = byScaleKind.get('village:giwa') || [];
const hamletChoga = byScaleKind.get('hamlet:choga') || [];
console.log(
  'YARD PROPORTION CONTRACT: PASS',
  `(${samples.length} parcels × ${SEEDS.length} seeds;`,
  `village giwa front ${villageGiwa.length ? avg(villageGiwa, 'front').toFixed(2) : '—'}m`,
  `L/H ${villageGiwa.length ? avg(villageGiwa, 'lh').toFixed(2) : '—'};`,
  `hamlet fit ${hamletChoga.length ? avg(hamletChoga, 'fit').toFixed(3) : '—'};`,
  `mat floor ${MAT_FLOOR_M}m)`,
);
