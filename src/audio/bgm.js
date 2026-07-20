import { equalPower } from './synth.js';

// BGM 크로스페이드 매니저. assets/audio/ 의 Suno 트랙을 시간대에 매핑하고
// setTime 시 4초 등파워 크로스페이드로 전환. 루프 재생, 기본 볼륨 낮게(환경음이 주인공).
//
//   createBgm(listener, { destination, baseUrl }) →
//     { play(name), setVolume(v), update(dt), getTracks(), start() }
//   destination: BGM 마스터 게인(setupAudio 가 listener 입력에 연결).

const TIME_TRACK = { dawn: 'dawn', day: 'main-theme', sunset: 'sunset', night: 'night' };
const OPTION_TRACKS = ['village', 'genesis']; // getTracks() 로 노출되는 추가 선택지
const FADE = 4.0; // 크로스페이드 시간(초)
const BASE_GAIN = 0.2; // ≈ -14dB

export function createBgm(listener, { destination, baseUrl = './assets/audio/' } = {}) {
  const ctx = listener.context;
  const master = ctx.createGain();
  let volMul = 1; // setVolume 배수(1 → 기본 -14dB)
  master.gain.value = BASE_GAIN;
  master.connect(destination || ctx.destination);

  const buffers = new Map();   // name → AudioBuffer
  const loading = new Map();   // name → Promise
  let started = false;
  let currentName = null;

  // 재생 중인 보이스들. 각 { src, gain, from, to, p }(p: 페이드 진행 0..1)
  let voices = [];

  async function load(name) {
    if (buffers.has(name)) return buffers.get(name);
    if (loading.has(name)) return loading.get(name);
    const p = (async () => {
      try {
        const res = await fetch(baseUrl + name + '.mp3');
        const arr = await res.arrayBuffer();
        const buf = await ctx.decodeAudioData(arr);
        buffers.set(name, buf);
        return buf;
      } catch (e) {
        // mp3 디코드 실패(코덱 미지원 등)는 치명적이지 않다 — 무음으로 진행.
        console.warn('[bgm] load failed:', name, e && e.message);
        return null;
      }
    })();
    loading.set(name, p);
    return p;
  }

  function startVoice(buf, targetGain) {
    const src = ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(gain); gain.connect(master);
    src.start();
    return { src, gain, from: 0, to: targetGain, p: 0 };
  }

  async function play(name) {
    currentName = name;
    if (!started) return; // start() 후 실제 재생
    const buf = await load(name);
    if (!buf) return;
    // #140-D stale 가드: await(fetch+decode) 중 새 play(다른 트랙)가 들어왔으면 이 요청은 버린다.
    //   느린 옛 로드가 새 요청을 덮어써 엉뚱한 트랙이 이기던 레이스(시간대 연타 시 트랙 어긋남) 방지.
    if (currentName !== name) return;
    // 기존 보이스는 페이드 아웃, 새 보이스 페이드 인
    for (const v of voices) { v.from = v.gain.gain.value; v.to = 0; v.p = 0; }
    voices.push(startVoice(buf, 1));
  }

  // #140-D 프리페치: 재생 없이 fetch+decode 만 해 buffers 에 담아둔다(load 가 memoized).
  //   · prefetch(name): 단일 트랙(첫 사운드 활성 즉시 재생용, 제스처 전 유휴에 호출 — decode 는 suspended ctx 에서도 동작).
  //   · prefetchTimeTracks(): TIME_TRACK 4곡을 동시 1개·순차로(대역폭 폭주 방지). start() 후 호출 → 이후 시간대 전환 즉시 크로스페이드.
  function prefetch(name) { return name ? load(name) : Promise.resolve(null); }
  let prefetchedTimeTracks = false;
  async function prefetchTimeTracks() {
    if (prefetchedTimeTracks) return;
    prefetchedTimeTracks = true;
    for (const name of Object.values(TIME_TRACK)) {
      if (!buffers.has(name)) { try { await load(name); } catch {} }
    }
  }

  return {
    async start() {
      if (started) return;
      started = true;
      if (currentName) await play(currentName);
      prefetchTimeTracks();   // #140-D 나머지 시간대 트랙 백그라운드 프리페치(await 안 함 — start 는 즉시 반환)
    },
    play, prefetch, prefetchTimeTracks,
    setVolume(v) { volMul = Math.max(0, v); master.gain.setTargetAtTime(volMul * BASE_GAIN, ctx.currentTime, 0.1); },
    getTracks() { return { byTime: { ...TIME_TRACK }, options: [...OPTION_TRACKS] }; },
    update(dt) {
      if (!voices.length) return;
      const step = dt / FADE;
      for (const v of voices) {
        v.p = Math.min(1, v.p + step);
        // from→to 를 등파워 곡선으로. 페이드인(to=1)은 in, 페이드아웃(to=0)은 out.
        const ep = equalPower(v.p);
        v.gain.gain.value = v.to > 0 ? ep.in : ep.out * v.from;
      }
      // 완전히 사라진 보이스 정리
      voices = voices.filter((v) => {
        if (v.to === 0 && v.p >= 1) { try { v.src.stop(); } catch {} return false; }
        return true;
      });
    },
  };
}

export { TIME_TRACK };
