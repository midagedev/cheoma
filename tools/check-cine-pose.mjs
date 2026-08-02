// 드론 투어 **포즈 프레임 델타** 계약 (#42, 2026-08-02).
//
// 사용자 판정: "아직도 시작부터 떨림". 이 게이트는 그 떨림을 픽셀이 아니라 **포즈 시계열**로 잡는다.
// 재생 시퀀스는 app/src/engine/cinematic-runtime.js 를 그대로 옮긴 것이다 — 게이트가 재현하는 것이
//   곧 런타임 계약이므로, 둘이 어긋나면 이 게이트는 무의미해진다.
//
// ── 무엇을 재는가 ──
//   프레임 i 의 시선 방향과 i+1 의 시선 방향 사이 각 d_i (°). 안무 자체가 회전을 담고 있으므로 d_i 의
//   크기는 결함이 아니다. 결함은 d 의 **고주파 잔차**다:
//       hf_i = d_i - (d_{i-1} + d_{i+1}) / 2
//   부드러운 안무는 d 가 프레임 스케일에서 거의 선형이라 hf ≈ 0 이고, 떨림(한 프레임 앞섰다 한 프레임
//   뒤처지는 제어기 채터)은 hf 의 **부호가 매 프레임 교대**하면서 크기를 갖는다. 그래서 두 축으로 본다:
//     ① max |hf| (°) — 눈에 보이는 한 프레임 튐의 크기
//     ② 부호 교대율 — 연속한 hf 쌍 중 부호가 반대인 비율. 채터의 지문(1.0 에 붙는다)
//   ②만으로는 부족하다(잡음도 교대한다). 크기 문턱을 넘는 표본에서만 교대율을 세는 이유다.
//
// ── FAIL-first 실측(2026-08-02, 수정 전 소스 = HEAD 7d95496) ──
//   런타임이 dronepath 의 방향장(이미 Hann 1.05s 로 평활되고 저작 요 상한이 걸린 신호)을 **가속도
//   제한 컨트롤러**(createDirectionController, maxYawAcc 150°/s²)로 한 번 더 추종한다. 그 컨트롤러는
//   bang-bang 이다: 목표 근처에서 desiredVelocity 가 작아지는데 velocity 는 프레임당 accel·dt
//   (=2.5°/s) 단위로만 움직이므로 목표를 넘었다 되돌아오는 극한 주기가 생긴다. 진폭은 대략
//   accel·dt²/2 ≈ 0.021° 이고 **매 프레임 부호가 뒤집힌다**. 실측 표는 아래 REPORT 참조.
//
// standalone(미등록). 등록은 리드가 한다.

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const requireApp = createRequire(join(ROOT, 'app', 'package.json'));
const esbuild = requireApp('esbuild');
const THREE_MAIN = join(ROOT, 'app/node_modules/three/build/three.module.js');
const THREE_ADDONS = join(ROOT, 'app/node_modules/three/examples/jsm');

const DEG = Math.PI / 180;
const DT = 1 / 60;
const SUNSET_SUN_DIR = [-16, 8, -45];
const SUN_AZ = Math.atan2(SUNSET_SUN_DIR[0], SUNSET_SUN_DIR[2]);

const built = await esbuild.build({
  stdin: {
    contents: `
export { planVillage } from './src/api/village-plan.js';
export { createDronePaths } from './src/cinematic/dronepath.js';
export { createDirectionController } from './src/camera/heading.js';
`,
    resolveDir: ROOT,
    sourcefile: 'cine-pose-entry.js',
  },
  alias: { 'three/addons': THREE_ADDONS, three: THREE_MAIN },
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  write: false,
  logLevel: 'silent',
});
const M = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString('base64')}`);
const { createDronePaths, createDirectionController, planVillage } = M;

const CASES = [
  { scale: 'hamlet', seed: 11, label: 'hamlet' },
  { scale: 'village', seed: 20260716, label: 'village' },
  { scale: 'capital', seed: 7, includePalace: true, includeTemple: true, label: 'capital' },
  { scale: 'hanyang', seed: 2026, includePalace: true, includeTemple: true, label: 'hanyang' },
];
const filter = (process.env.CHEOMA_CINE_CASES || '').split(',').map((s) => s.trim()).filter(Boolean);
const SELECTED = filter.length ? CASES.filter((c) => filter.some((f) => c.label.includes(f))) : CASES;

// ── 계약 ──
// 시작 구간(투어 첫 5초)과 투어 전체를 같은 문턱으로 본다. 떨림은 시작에만 있는 것이 아니라
//   시작에서 가장 잘 보일 뿐이므로(안무 회전이 아직 작아 잔차가 상대적으로 크게 읽힌다) 둘 다 본다.
const START_SEC = 5;
// 크기 문턱 — 이보다 작은 잔차는 부호를 세지 않는다(부동소수 잡음의 부호는 무의미하다).
//   1600x900·fov40 에서 1px ≈ 0.044° 이므로 0.004° 는 1/10 px.
const HF_MAG_DEG = 0.004;
// 부호 교대율 상한. bang-bang 채터는 1.0 에 붙고, 안무 잔차는 방향성이 있어 0.5 아래다.
const HF_ALT_MAX = 0.60;
// 교대율을 판정하기 위한 **최소 표본 수**. 크기 문턱을 넘는 쌍이 한둘뿐이면 100% 든 0% 든 통계가
//   아니라 우연이다(수정 후 실측: 투어 전체에서 문턱 초과 쌍이 1~8 개). 채터가 있을 때는 이 수가
//   구조적으로 크다 — 수정 전 소스 실측 n = 446·1075·397·2096(60fps) · 6473~9379(가변 dt).
//   그래서 이 하한은 완화가 아니라 **판정 가능 조건**이고, FAIL-first 는 그대로 성립한다.
const HF_ALT_MIN_N = 30;
// **비율 계약이 이 게이트의 본체다.** 절대 상한만 두면 "안무가 급해서 잔차가 크다"와 "런타임이
//   고주파를 만들어 낸다"를 구분하지 못한다. dronepath 의 방향장은 이미 Hann 1.05s 로 평활되고
//   저작 요 상한이 걸린 신호이므로, 런타임은 그것을 **그대로 통과시켜야** 한다. 소비면이 만들어 낸
//   고주파는 전부 결함이다.
const HF_RATIO_MAX = 1.6;
// 비율의 바닥 — 저작 잔차가 0 에 가까운 구간(투어 시작)에서 비율이 발산하지 않게.
const HF_FLOOR_DEG = 0.006;
// 절대 상한 — 안무가 아무리 급해도 한 프레임 잔차가 이보다 크면 튐이다.
const HF_MAX_DEG = 0.12;
// 롤도 같은 축으로 본다(롤 채터는 수평선 떨림으로 보인다).
const ROLL_HF_MAX_DEG = 0.10;
// ── 가변 프레임 시간 ── 실제 브라우저의 dt 는 1/60 고정이 아니다. bang-bang 제어기의 채터 진폭은
//   accel·dt²/2 라 dt 흔들림이 그대로 진폭 흔들림이 되므로, 고정 dt 재생은 결함을 **과소평가**한다.
//   결정론적 의사난수로 ±18% 를 흔든 두 번째 재생을 같은 계약으로 본다.
const DT_JITTER = 0.18;

const failures = [];
const report = [];
const check = (ok, msg) => { if (!ok) failures.push(msg); };

const dirOf = (a, b) => {
  const x = b.x - a.x, y = b.y - a.y, z = b.z - a.z;
  const m = Math.hypot(x, y, z) || 1;
  return { x: x / m, y: y / m, z: z / m };
};
const angBetween = (a, b) => {
  const d = Math.min(1, Math.max(-1, a.x * b.x + a.y * b.y + a.z * b.z));
  return Math.acos(d) / DEG;
};

// hf 잔차 통계. values = 프레임별 **각속도**(°/s 또는 m/s), 반환은 60fps 한 프레임 등가량으로 환산.
// 각속도로 재는 이유: dt 가 흔들리면 프레임당 각(=속도×dt)은 dt 만큼 자동으로 흔들리므로, 그 흔들림이
//   경로 결함으로 오독된다. 속도는 dt 불변량이라 가변 프레임에서도 같은 양을 잰다.
function hfStats(values) {
  const hf = [];
  for (let i = 1; i + 1 < values.length; i++) {
    hf.push((values[i] - (values[i - 1] + values[i + 1]) * 0.5) * DT);
  }
  let max = 0;
  for (const v of hf) max = Math.max(max, Math.abs(v));
  // 부호 교대율 — 크기 문턱을 넘는 연속 쌍만 센다.
  let pairs = 0, alt = 0;
  for (let i = 1; i < hf.length; i++) {
    if (Math.abs(hf[i]) < HF_MAG_DEG || Math.abs(hf[i - 1]) < HF_MAG_DEG) continue;
    pairs++;
    if (hf[i] * hf[i - 1] < 0) alt++;
  }
  return { max, pairs, altRate: pairs ? alt / pairs : 0 };
}

for (const c of SELECTED) {
  const plan = planVillage({
    scale: c.scale, seed: c.seed, houses: c.houses,
    includePalace: !!c.includePalace, includeTemple: !!c.includeTemple,
  });
  const site = plan.site;
  const legs = createDronePaths({
    site, plan, heightAt: (x, z) => site.heightAt(x, z), seed: c.seed, sunAzimuth: SUN_AZ,
  });
  const row = { scale: c.label };

  // ── 런타임 재생 재현 ──
  // cinematic-runtime.js 와 같은 순서: 표본 → (컨트롤러가 있으면) 시선 슬루 → 롤 1차 지연.
  // 컨트롤러/지연의 존재 여부는 런타임 소스에서 읽어 온다(계약면 표류 방지).
  const runtimeSrc = await import('node:fs').then((fs) => fs.promises.readFile(
    join(ROOT, 'app/src/engine/cinematic-runtime.js'), 'utf8'));
  const usesController = /droneLook\s*\.\s*step\s*\(/.test(runtimeSrc);
  const rollLagMatch = runtimeSrc.match(/^const ROLL_LAG_SEC\s*=\s*([0-9.]+)/m);
  const rollLag = rollLagMatch ? Number(rollLagMatch[1]) : 0;
  row.wiring = `controller ${usesController ? 'ON' : 'OFF'} · rollLag ${rollLag || 0}s`;

  const first = legs[0];
  const total = first.tourDuration;

  // 재생 1회. jitter=0 이면 고정 60fps, >0 이면 결정론 의사난수로 dt 를 흔든다.
  const replay = (jitter) => {
    let rs = 0x2f6e2b1 ^ (c.seed >>> 0);
    const rnd = () => {
      rs ^= rs << 13; rs ^= rs >>> 17; rs ^= rs << 5; rs >>>= 0;
      return rs / 4294967296;
    };
    const authored = [];
    const driven = [];
    const rolls = [];
    const positions = [];
    const dts = [];
    let ctrl = null;
    let roll = null;
    let t = 0;
    while (t < total) {
      const dt = jitter ? DT * (1 + (rnd() * 2 - 1) * jitter) : DT;
      dts.push(dt);
      const s = first.sampleTour(t / total);
      const want = dirOf(s.pos, s.lookAt);
      authored.push(want);
      if (usesController) {
        if (!ctrl) {
          ctrl = createDirectionController({
            direction: want,
            maxYawSpeed: 60 * DEG, maxYawAcceleration: 150 * DEG,
            maxPitchSpeed: 40 * DEG, maxPitchAcceleration: 100 * DEG,
          });
          driven.push({ ...want });
        } else {
          const d = ctrl.step(want, dt);
          driven.push({ x: d.x, y: d.y, z: d.z });
        }
      } else {
        driven.push({ ...want });
      }
      const wantRoll = Number.isFinite(s.roll) ? s.roll : 0;
      if (roll == null) roll = wantRoll;
      else if (rollLag > 0) roll += (wantRoll - roll) * Math.min(1, dt / rollLag);
      else roll = wantRoll;
      rolls.push(roll / DEG);
      positions.push(s.pos);
      t += dt;
    }
    return { authored, driven, rolls, positions, dts };
  };

  for (const [mode, jitter] of [['60fps', 0], ['jitter', DT_JITTER]]) {
    const { authored, driven, rolls, positions, dts } = replay(jitter);
    const frames = driven.length;
    // 프레임 간 양을 dt 로 나눠 **속도**로 만든다(위 hfStats 주석).
    const angSpeed = (seq) => {
      const out = [];
      for (let i = 0; i + 1 < seq.length; i++) out.push(angBetween(seq[i], seq[i + 1]) / dts[i]);
      return out;
    };
    const rollDelta = [];
    for (let i = 0; i + 1 < rolls.length; i++) rollDelta.push((rolls[i + 1] - rolls[i]) / dts[i]);
    const posDelta = [];
    for (let i = 0; i + 1 < positions.length; i++) {
      const a = positions[i], b = positions[i + 1];
      posDelta.push(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) / dts[i]);
    }
    const startN = Math.min(frames - 2, Math.round(START_SEC / DT));
    for (const [win, n] of [['start', startN], ['all', frames - 1]]) {
      const tag = `${mode}/${win}`;
      const a = hfStats(angSpeed(driven.slice(0, n + 2)));
      const ref = hfStats(angSpeed(authored.slice(0, n + 2)));
      const rl = hfStats(rollDelta.slice(0, n + 1));
      const pos = hfStats(posDelta.slice(0, n + 1));
      const budget = Math.max(HF_FLOOR_DEG, ref.max * HF_RATIO_MAX);
      row[`${mode}_${win}`] = `driven ${a.max.toFixed(4)}° alt ${(a.altRate * 100).toFixed(0)}%(n${a.pairs})`
        + ` | authored ${ref.max.toFixed(4)}° | 예산 ${budget.toFixed(4)}° | roll ${rl.max.toFixed(4)}° | pos ${pos.max.toFixed(4)}m`;
      check(a.max <= HF_MAX_DEG,
        `POSE-1 ${row.scale} ${tag}: 시선 프레임 잔차 max ${a.max.toFixed(4)}° > ${HF_MAX_DEG}°`);
      check(a.pairs < HF_ALT_MIN_N || a.altRate <= HF_ALT_MAX,
        `POSE-2 ${row.scale} ${tag}: 시선 잔차 부호 교대율 ${(a.altRate * 100).toFixed(0)}% > ${HF_ALT_MAX * 100}% (n=${a.pairs}, max ${a.max.toFixed(4)}°) — 제어기 채터`);
      check(a.max <= budget,
        `POSE-4 ${row.scale} ${tag}: 런타임이 고주파를 만들어 냈다 — driven ${a.max.toFixed(4)}° > 예산 ${budget.toFixed(4)}° (authored ${ref.max.toFixed(4)}°)`);
      check(rl.max <= ROLL_HF_MAX_DEG,
        `POSE-3 ${row.scale} ${tag}: 롤 프레임 잔차 max ${rl.max.toFixed(4)}° > ${ROLL_HF_MAX_DEG}°`);
    }
  }
  report.push(row);
}

console.log('── 드론 투어 포즈 프레임 델타 (#42) ──');
for (const r of report) {
  console.log(`  ${r.scale}  [${r.wiring}]`);
  console.log(`    60fps  시작${START_SEC}s  ${r['60fps_start']}`);
  console.log(`    60fps  전체      ${r['60fps_all']}`);
  console.log(`    jitter 시작${START_SEC}s  ${r.jitter_start}`);
  console.log(`    jitter 전체      ${r.jitter_all}`);
}
if (failures.length) {
  console.error(`\nFAIL (${failures.length})`);
  for (const f of failures) console.error(`  · ${f}`);
  process.exit(1);
}
console.log('\nPASS — 포즈 시계열에 프레임 스케일 채터·첨점 없음');
