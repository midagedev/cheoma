// 저수준 Web Audio 합성 헬퍼.
// 이 프로젝트는 파라메트릭이 컨셉이므로 사운드도 파일 샘플이 아닌 합성으로 만든다.
// 모든 함수는 BaseAudioContext(실시간 AudioContext / OfflineAudioContext 공용)에서 동작한다.

// ---------- 노이즈 버퍼 ----------
// 흰 노이즈: 바람/비의 원재료. loop=true 로 재생.
export function makeWhiteNoise(ctx, seconds = 2, channels = 1) {
  const buf = ctx.createBuffer(channels, Math.max(1, Math.floor(ctx.sampleRate * seconds)), ctx.sampleRate);
  for (let c = 0; c < channels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  return buf;
}

// 핑크 노이즈(Paul Kellet 근사): 저역이 강해 바람에 더 자연스럽다.
export function makePinkNoise(ctx, seconds = 3, channels = 1) {
  const buf = ctx.createBuffer(channels, Math.max(1, Math.floor(ctx.sampleRate * seconds)), ctx.sampleRate);
  for (let c = 0; c < channels; c++) {
    const d = buf.getChannelData(c);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < d.length; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.96900 * b2 + w * 0.1538520;
      b3 = 0.86650 * b3 + w * 0.3104856;
      b4 = 0.55000 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.0168980;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    }
  }
  return buf;
}

// loop 재생용 버퍼 소스(재사용 불가 — 정지 후 새로 만든다).
export function playBuffer(ctx, buffer, dest, { loop = true, rate = 1 } = {}) {
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.loop = loop;
  src.playbackRate.value = rate;
  if (dest) src.connect(dest);
  return src;
}

// 등파워 크로스페이드 이득 매핑. p:0→out(1)/in(0), p:1→out(0)/in(1).
export function equalPower(p) {
  const x = Math.max(0, Math.min(1, p));
  return { out: Math.cos(x * Math.PI * 0.5), in: Math.sin(x * Math.PI * 0.5) };
}

// ---------- 풍경(風磬) 청동 종 합성 ----------
// 처마 끝 풍경: 작은 청동 종 + 물고기 판(붕어) 풍탁. 타종 1회를 destination 에 스케줄한다.
// 비정수배(inharmonic) 부분음으로 struck-metal 음색을 만들고, 고주파일수록 짧은 감쇠를 주어
// (청동 두께에 따른 물리적 직관: 높은 부분음이 먼저 소멸) 종소리의 "빛"이 빠르게 사라지게 한다.
// 어택은 1~2ms 로 날카롭게, 감쇠는 setTargetAtTime 로 지수 곡선.
//
//   when: destination.context.currentTime 기준 시작 시각
//   base: 기음 주파수(Hz). 작은 풍경은 1.2~2kHz.
//   gain: 전체 세기(0~1).
//   rand: 난수원(결정론 테스트용, 기본 Math.random)
const BELL_PARTIALS = [
  { ratio: 1.00, amp: 1.00, tau: 3.4 },  // 기음 — 가장 오래 남는다
  { ratio: 2.76, amp: 0.66, tau: 2.1 },
  { ratio: 5.40, amp: 0.44, tau: 1.15 },
  { ratio: 8.93, amp: 0.30, tau: 0.62 }, // 고부분음 — 어택 직후 빠르게 소멸
  { ratio: 11.34, amp: 0.16, tau: 0.34 }, // 반짝임
];

export function synthBell(ctx, destination, when = ctx.currentTime, { base = 1500, gain = 1, rand = Math.random } = {}) {
  const t0 = Math.max(when, ctx.currentTime);
  // 종 전체 미세 디튠(타종마다 다른 개체감)
  const detune = 1 + (rand() * 2 - 1) * 0.02;
  const master = ctx.createGain();
  master.gain.value = 0.16 * gain;
  master.connect(destination);

  let ringEnd = t0;
  for (const p of BELL_PARTIALS) {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    // 부분음별 추가 미세 디튠 → 맥놀이(beating)로 금속의 살아있는 느낌
    const f = base * detune * p.ratio * (1 + (rand() * 2 - 1) * 0.004);
    osc.frequency.value = f;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(p.amp, t0 + 0.0015);       // 날카로운 어택
    g.gain.setTargetAtTime(0.0001, t0 + 0.0015, p.tau / 3.2); // 지수 감쇠
    osc.connect(g);
    g.connect(master);
    const stop = t0 + p.tau * 2.6 + 0.15;
    osc.start(t0);
    osc.stop(stop);
    ringEnd = Math.max(ringEnd, stop);
  }

  // 물고기 판이 종신에 부딪히는 가벼운 클릭(붕어 풍탁의 "딱")
  const clickBuf = makeWhiteNoise(ctx, 0.08, 1);
  const click = ctx.createBufferSource();
  click.buffer = clickBuf;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = base * 2.1;
  bp.Q.value = 1.4;
  const cg = ctx.createGain();
  cg.gain.setValueAtTime(0.0001, t0);
  cg.gain.linearRampToValueAtTime(0.14 * gain, t0 + 0.0006);
  cg.gain.setTargetAtTime(0.0001, t0 + 0.0006, 0.012);
  click.connect(bp);
  bp.connect(cg);
  cg.connect(destination);
  click.start(t0);
  click.stop(t0 + 0.09);

  return ringEnd;
}

// 포아송 과정 다음 간격(초). mean 평균, [min,max] 클램프.
export function poissonInterval(mean, min, max, rand = Math.random) {
  const u = Math.max(1e-6, 1 - rand());
  const dt = -Math.log(u) * mean;
  return Math.max(min, Math.min(max, dt));
}
