import { createAudioScope, equalPower } from './synth.js';

// BGM 크로스페이드 매니저. assets/audio/ 의 Suno 트랙을 시간대에 매핑하고
// setTime 시 4초 등파워 크로스페이드로 전환. 루프 재생, 기본 볼륨 낮게(환경음이 주인공).
//
//   createBgm(listener, { destination, baseUrl }) →
//     { play(name), setVolume(v), update(dt), getTracks(), start(), dispose() }
//   destination: BGM 마스터 게인(setupAudio 가 listener 입력에 연결).

const TIME_TRACK = { dawn: 'dawn', day: 'main-theme', sunset: 'sunset', night: 'night' };
const OPTION_TRACKS = ['village', 'genesis']; // getTracks() 로 노출되는 추가 선택지
const FADE = 4.0; // 크로스페이드 시간(초)
const BASE_GAIN = 0.2; // ≈ -14dB

export function createBgm(listener, { destination, baseUrl = './assets/audio/' } = {}) {
  const ctx = listener.context;
  const scope = createAudioScope();
  const master = ctx.createGain();
  let volMul = 1; // setVolume 배수(1 → 기본 -14dB)
  master.gain.value = BASE_GAIN;
  master.connect(destination || ctx.destination);
  scope.track(master);

  const buffers = new Map();   // name → AudioBuffer
  const loading = new Map();   // name → Promise
  let started = false;
  let disposed = false;
  let currentName = null;
  let requestId = 0;
  const loadAbort = typeof AbortController === 'function' ? new AbortController() : null;

  // 재생 중인 보이스들. 각 { src, gain, from, to, p, dispose }(p: 페이드 진행 0..1)
  let voices = [];

  async function load(name) {
    if (disposed) return null;
    if (buffers.has(name)) return buffers.get(name);
    if (loading.has(name)) return loading.get(name);
    const p = (async () => {
      try {
        const res = await fetch(baseUrl + name + '.mp3', loadAbort ? { signal: loadAbort.signal } : undefined);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        if (disposed) return null;
        const arr = await res.arrayBuffer();
        if (disposed) return null;
        const buf = await ctx.decodeAudioData(arr);
        if (disposed) return null;
        buffers.set(name, buf);
        return buf;
      } catch (e) {
        // mp3 디코드 실패(코덱 미지원 등)는 치명적이지 않다 — 무음으로 진행.
        if (!disposed && e?.name !== 'AbortError') console.warn('[bgm] load failed:', name, e && e.message);
        return null;
      }
    })();
    loading.set(name, p);
    const clearLoading = () => { if (loading.get(name) === p) loading.delete(name); };
    void p.then(clearLoading, clearLoading);
    return p;
  }

  function startVoice(buf, targetGain) {
    if (disposed) return null;
    const src = ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(gain); gain.connect(master);
    const voiceScope = scope.trackVoice([src], [gain]);
    src.start();
    return { src, gain, from: 0, to: targetGain, p: 0, dispose: voiceScope.dispose };
  }

  async function play(name) {
    if (disposed) return;
    const request = ++requestId;
    currentName = name;
    if (!started) return; // start() 후 실제 재생
    const buf = await load(name);
    if (!buf || disposed) return;
    // #140-D stale 가드: await(fetch+decode) 중 새 play(다른 트랙)가 들어왔으면 이 요청은 버린다.
    //   느린 옛 로드가 새 요청을 덮어써 엉뚱한 트랙이 이기던 레이스(시간대 연타 시 트랙 어긋남) 방지.
    if (request !== requestId || currentName !== name) return;
    // 기존 보이스는 페이드 아웃, 새 보이스 페이드 인
    for (const v of voices) { v.from = v.gain.gain.value; v.to = 0; v.p = 0; }
    const voice = startVoice(buf, 1);
    if (voice) voices.push(voice);
  }

  // #140-D 프리페치: 재생 없이 fetch+decode 만 해 buffers 에 담아둔다(load 가 memoized).
  //   · prefetch(name): 단일 트랙(첫 사운드 활성 즉시 재생용, 제스처 전 유휴에 호출 — decode 는 suspended ctx 에서도 동작).
  //   · prefetchTimeTracks(): TIME_TRACK 4곡을 동시 1개·순차로(대역폭 폭주 방지). start() 후 호출 → 이후 시간대 전환 즉시 크로스페이드.
  function prefetch(name) { return !disposed && name ? load(name) : Promise.resolve(null); }
  let prefetchedTimeTracks = false;
  async function prefetchTimeTracks() {
    if (prefetchedTimeTracks || disposed) return;
    prefetchedTimeTracks = true;
    for (const name of Object.values(TIME_TRACK)) {
      if (disposed) return;
      if (!buffers.has(name)) { try { await load(name); } catch {} }
    }
  }

  return {
    async start() {
      if (started || disposed) return;
      started = true;
      if (currentName) await play(currentName);
      if (!disposed) prefetchTimeTracks(); // 나머지 시간대 트랙 백그라운드 프리페치(await 안 함)
    },
    play, prefetch, prefetchTimeTracks,
    setVolume(v) {
      if (disposed) return;
      volMul = Math.max(0, v);
      master.gain.setTargetAtTime(volMul * BASE_GAIN, ctx.currentTime, 0.1);
    },
    getTracks() { return { byTime: { ...TIME_TRACK }, options: [...OPTION_TRACKS] }; },
    update(dt) {
      if (disposed || !voices.length) return;
      const step = dt / FADE;
      for (const v of voices) {
        v.p = Math.min(1, v.p + step);
        // from→to 를 등파워 곡선으로. 페이드인(to=1)은 in, 페이드아웃(to=0)은 out.
        const ep = equalPower(v.p);
        v.gain.gain.value = v.to > 0 ? ep.in : ep.out * v.from;
      }
      // 완전히 사라진 보이스 정리
      voices = voices.filter((v) => {
        if (v.to === 0 && v.p >= 1) { v.dispose(); return false; }
        return true;
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      started = false;
      requestId++;
      try { loadAbort?.abort(); } catch {}
      try {
        master.gain.cancelScheduledValues(ctx.currentTime);
        master.gain.setValueAtTime(0, ctx.currentTime);
      } catch {}
      for (const voice of voices) voice.dispose();
      voices = [];
      buffers.clear();
      loading.clear();
      scope.dispose();
    },
  };
}

export { TIME_TRACK };
