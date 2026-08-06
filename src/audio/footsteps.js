// 1인칭 도보 발소리 · 착지음 (2026-08-06 사용자 요청 "fps모드에서 … 걷는 효과음도 나고").
//
// 파일 샘플이 아니라 **합성**이다 — 이 레포의 사운드 규약(synth.js 머리말: "파라메트릭이 컨셉이므로
// 사운드도 합성으로 만든다")을 따르고, assets/audio/ 는 사용자가 Suno 로 만드는 BGM 소유이므로
// 새 샘플 파일을 요구하지 않는다.
//
//   createFootsteps(listener, { destination }) → footsteps
//     footsteps.step(intensity)   한 걸음. intensity ∈ [0,1] (걷기 ~0.5, 달리기 ~1)
//     footsteps.land(mps)         착지 충격(수직 속도 m/s)
//     footsteps.dispose()
//
// 조선 마을의 노면은 흙·마사토이고 신발은 짚신·가죽신이다. 그래서 목표 음색은 아스팔트의 또렷한
// 'tap' 이 아니라 **마른 흙의 부스럭거리는 짧은 사각(scuff)** 이다:
//   ① 저역 몸통 — 발이 땅을 누르는 둔탁한 성분. 120~180Hz 사인 임펄스, 60ms 감쇠.
//   ② 중고역 마찰 — 흙·모래 알갱이. 화이트 노이즈를 밴드패스(700~1600Hz)로 좁히고 40~90ms 감쇠.
// 두 성분의 비율과 밴드 중심을 걸음마다 결정론 없이 흔들어(발소리는 시드 계약 밖이다) 같은 소리가
// 반복되는 기계음을 피한다. 소리 길이가 100ms 아래라 케이던스가 빨라져도 겹쳐 뭉치지 않는다.
import { createAudioScope, makeWhiteNoise } from './synth.js';

// 케이던스는 시간이 아니라 **보폭**이다(walker.strideDistance() 가 접지 이동거리를 적립한다).
//   사람 보폭은 0.7~0.8m 인데 우리 걷기 속도는 FPS 관례상 실측의 3배(4.5m/s)다. 실측 보폭을 쓰면
//   초당 6걸음이 되어 달리는 소리로 들린다. FPS 관례를 따라 보폭도 함께 늘려 걷기 케이던스를
//   초당 ~2.6걸음(사람 보행 케이던스 2 Hz 근처)으로 맞춘다.
export const STRIDE_WALK = 1.7;    // m — 4.5m/s ÷ 1.7 = 2.65 걸음/s
export const STRIDE_RUN = 2.4;     // m — 7.5m/s ÷ 2.4 = 3.13 걸음/s
export const LAND_MIN_MPS = 1.5;   // 이보다 약한 착지는 소리 없음(계단 한 칸 내려서는 정도)

export function createFootsteps(listener, { destination = null } = {}) {
  const ctx = listener?.context;
  if (!ctx) return null;
  const scope = createAudioScope();
  const out = ctx.createGain();
  out.gain.value = 0.55;
  out.connect(destination || listener.getInput());
  scope.track(out);
  // 노이즈는 한 번만 만들어 재사용한다(걸음마다 버퍼를 굽으면 GC 압력이 걸음 케이던스로 들어온다).
  const noise = makeWhiteNoise(ctx, 0.5, 1);

  function burst(at, {
    level, bodyHz, bandHz, bodyDur, scuffDur, scuffLevel,
  }) {
    // ① 저역 몸통
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(bodyHz, at);
    osc.frequency.exponentialRampToValueAtTime(Math.max(40, bodyHz * 0.55), at + bodyDur);
    const bodyGain = ctx.createGain();
    bodyGain.gain.setValueAtTime(0.0001, at);
    bodyGain.gain.exponentialRampToValueAtTime(level, at + 0.004);
    bodyGain.gain.exponentialRampToValueAtTime(0.0001, at + bodyDur);
    osc.connect(bodyGain).connect(out);

    // ② 중고역 마찰
    const src = ctx.createBufferSource();
    src.buffer = noise;
    src.loop = true;
    // 재생 시작 오프셋을 흔들어 같은 파형 구간이 반복되지 않게 한다.
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.setValueAtTime(bandHz, at);
    band.frequency.exponentialRampToValueAtTime(Math.max(200, bandHz * 0.6), at + scuffDur);
    band.Q.value = 1.1;
    const scuff = ctx.createGain();
    scuff.gain.setValueAtTime(0.0001, at);
    scuff.gain.exponentialRampToValueAtTime(level * scuffLevel, at + 0.006);
    scuff.gain.exponentialRampToValueAtTime(0.0001, at + scuffDur);
    src.connect(band).connect(scuff).connect(out);

    const stopAt = at + Math.max(bodyDur, scuffDur) + 0.02;
    osc.start(at); osc.stop(stopAt);
    src.start(at, Math.random() * 0.4); src.stop(stopAt);
    scope.trackVoice([osc, src], [bodyGain, band, scuff]);
  }

  return {
    /** 한 걸음. intensity 는 걷기 0.5 ~ 달리기 1.0 을 기대한다. */
    step(intensity = 0.5) {
      const k = Math.max(0, Math.min(1, intensity));
      const at = ctx.currentTime + 0.001;
      const jitter = 0.85 + Math.random() * 0.3;
      burst(at, {
        level: (0.055 + 0.075 * k) * jitter,
        bodyHz: (120 + Math.random() * 60) * (1 - 0.12 * k),
        bandHz: 700 + Math.random() * 900,
        bodyDur: 0.055 + Math.random() * 0.02,
        scuffDur: 0.04 + Math.random() * 0.05,
        // 달릴수록 마찰(사각거림)이 커진다 — 발을 끌며 흙을 밀어내는 성분.
        scuffLevel: 0.55 + 0.5 * k,
      });
    },
    /** 착지. mps = 접지 순간의 수직 속도 크기. 약한 착지는 무음. */
    land(mps = 0) {
      if (!(mps >= LAND_MIN_MPS)) return;
      const k = Math.max(0, Math.min(1, (mps - LAND_MIN_MPS) / 5));
      const at = ctx.currentTime + 0.001;
      burst(at, {
        level: 0.12 + 0.10 * k,
        bodyHz: 95 + Math.random() * 25,     // 걸음보다 낮게 — 무게가 실린 한 방
        bandHz: 520 + Math.random() * 480,
        bodyDur: 0.11 + 0.05 * k,
        scuffDur: 0.09 + 0.05 * k,
        scuffLevel: 0.7,
      });
    },
    setVolume(v) { out.gain.value = Math.max(0, Math.min(1, v)); },
    dispose() { scope.dispose(); },
  };
}
