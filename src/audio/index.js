import * as THREE from 'three';
import { createChimes } from './chime.js';
import { createAmbience } from './ambience.js';
import { createBgm } from './bgm.js';
import { createStream } from './stream.js';
import { createDog } from './dog.js';

// 사운드 레이어 오케스트레이터.
//   setupAudio(listenerCarrier, { layout, streamAnchor, getDogAnchor, getDogState }) →
//     { start(), setEnabled(v), setEnvActive(v), setTime(name), setWeather(name),
//       update(dt), setBgmVolume(v), setAmbienceVolume(v), setLayout(l),
//       strike(i?), barkDog(), getTracks(), playTrack(n), listener }
//   streamAnchor: 개울 물소리를 앉힐 월드 좌표(THREE.Vector3) 또는 null.
//   getDogAnchor/getDogState: 마당 개의 라이브 월드 위치·상태('walking'|'sitting') getter(없으면 개 없음).
//
// listenerCarrier(보통 camera)에 THREE.AudioListener 를 붙인다. 브라우저 autoplay 정책상
// 소리는 첫 사용자 제스처에서 start() 로 AudioContext.resume() 한 뒤에야 난다.
//
// 신호 흐름:
//   ambience 레이어 -> ambienceGain --\
//   bgm 보이스       -> bgmGain -------- +--> listener.gain(master) -> destination
//   풍경(PositionalAudio) -------------/  (three 가 panner->gain->listener 로 연결)
// 풍경 볼륨은 ambience 볼륨에 종속(환경음의 일부).

export function setupAudio(listenerCarrier, { layout, streamAnchor = null, getDogAnchor = null, getDogState = null } = {}) {
  const listener = new THREE.AudioListener();
  listenerCarrier.add(listener);
  const ctx = listener.context;
  const input = listener.getInput();

  // Web Audio API non-finite 파라미터 에러 방지용 가드
  if (typeof window !== 'undefined' && window.AudioParam && !window.AudioParam.__safeguarded) {
    window.AudioParam.__safeguarded = true;
    const origLinear = AudioParam.prototype.linearRampToValueAtTime;
    AudioParam.prototype.linearRampToValueAtTime = function(value, endTime) {
      if (!isFinite(value) || !isFinite(endTime)) {
        console.warn('AudioParam.linearRampToValueAtTime was bypassed due to non-finite arguments:', value, endTime);
        return this;
      }
      return origLinear.call(this, value, endTime);
    };
    const origExp = AudioParam.prototype.exponentialRampToValueAtTime;
    AudioParam.prototype.exponentialRampToValueAtTime = function(value, endTime) {
      if (!isFinite(value) || !isFinite(endTime) || value <= 0) {
        console.warn('AudioParam.exponentialRampToValueAtTime was bypassed due to non-finite or non-positive arguments:', value, endTime);
        return this;
      }
      return origExp.call(this, value, endTime);
    };
    const origSetValue = AudioParam.prototype.setValueAtTime;
    AudioParam.prototype.setValueAtTime = function(value, startTime) {
      if (!isFinite(value) || !isFinite(startTime)) {
        console.warn('AudioParam.setValueAtTime was bypassed due to non-finite arguments:', value, startTime);
        return this;
      }
      return origSetValue.call(this, value, startTime);
    };
  }

  // 마스터 소프트 리미터. 풍경 4연타·환경음·BGM 동시 피크를 부드럽게 잡아 클리핑 방지.
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -8;
  limiter.knee.value = 6;
  limiter.ratio.value = 4;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.25;
  input.disconnect();
  input.connect(limiter);
  limiter.connect(ctx.destination);

  const ambienceGain = ctx.createGain();
  ambienceGain.gain.value = 1;
  ambienceGain.connect(input);

  const bgmGain = ctx.createGain();
  bgmGain.gain.value = 1;
  bgmGain.connect(input);

  const chimes = createChimes(listener, { layout });
  const ambience = createAmbience(listener, { layout, destination: ambienceGain });
  const bgm = createBgm(listener, { destination: bgmGain });
  // 개울 물소리(위치성). 앵커 없으면(물 없는 씬) 생성하지 않는다.
  const stream = streamAnchor ? createStream(listener, { anchor: streamAnchor }) : null;
  // 마당 개 짖음(위치성). 개 앵커 getter 없으면 생성하지 않는다.
  const dog = getDogAnchor ? createDog(listener, { getAnchor: getDogAnchor, getState: getDogState }) : null;

  let enabled = true;
  let started = false;
  let envActive = true;  // env 레이어 ON 여부 — 개울 물소리는 env 가 꺼지면 정지
  let time = 'day';
  let weather = 'clear';
  let ambienceVol = 1;

  // 시간대·날씨 → 바람 세기(0~1). 풍경 타종·바람음의 공통 구동값.
  function windiness() {
    let w = { dawn: 0.1, day: 0.22, sunset: 0.3, night: 0.12 }[time] ?? 0.18;
    if (weather === 'rain') w = Math.max(w, 0.62);
    else if (weather === 'snow') w = Math.min(0.35, w + 0.12);
    return w;
  }
  function pushWind() {
    const w = windiness();
    chimes.setWindiness(w);
    ambience.setWindiness(w);
  }

  function applyMaster() {
    listener.setMasterVolume(enabled ? 1 : 0);
  }
  // 개울 물소리·개 짖음(위치성 env 사운드)은 전체 사운드 ON && env 레이어 ON 일 때만.
  function pushEnvAudio() {
    const on = enabled && envActive;
    stream?.setEnabled(on);
    dog?.setEnabled(on);
  }

  const api = {
    listener,
    async start() {
      if (started) return;
      if (ctx.state === 'suspended') { try { await ctx.resume(); } catch {} }
      started = true;
      chimes.start();
      ambience.start();
      stream?.start();
      dog?.start();
      await bgm.start();
      applyMaster();
      pushEnvAudio();
    },
    setEnabled(v) { enabled = !!v; applyMaster(); pushEnvAudio(); },
    // env 레이어(산수화 배경·지형·개울·개) ON/OFF — 위치성 env 사운드를 따라 정지/재개
    setEnvActive(v) { envActive = !!v; pushEnvAudio(); },
    setTime(name) {
      time = name;
      ambience.setTime(name);
      pushWind();
      // BGM 트랙 매핑 + 4s 크로스페이드
      const track = { dawn: 'dawn', day: 'main-theme', sunset: 'sunset', night: 'night' }[name];
      if (track) bgm.play(track);
    },
    setWeather(name) {
      weather = name;
      ambience.setWeather(name);
      stream?.setWeather(name); // 눈(결빙) 시 물소리 0.25배
      pushWind();
    },
    // 건물 재생성(크기 변경) 시 풍경 위치 갱신
    setLayout(layout) { chimes.setLayout(layout); },
    setBgmVolume(v) { bgm.setVolume(v); },
    setAmbienceVolume(v) {
      ambienceVol = Math.max(0, v);
      ambienceGain.gain.setTargetAtTime(ambienceVol, ctx.currentTime, 0.1);
      chimes.setVolume(ambienceVol); // 풍경도 환경음 볼륨에 종속
      stream?.setVolume(ambienceVol); // 개울도 환경음 볼륨에 종속
      dog?.setVolume(ambienceVol);    // 개 짖음도 환경음 볼륨에 종속
    },
    // BGM 트랙 선택지(옵션 트랙 village/genesis 포함) 노출
    getTracks() { return bgm.getTracks(); },
    // 특정 트랙 강제 재생(옵션 트랙 테스트/노출용)
    playTrack(name) { bgm.play(name); },
    // 테스트용 즉시 타종
    strike(i) { chimes.strike(i); },
    // 테스트용 즉시 개 짖음
    barkDog() { dog?.bark(); },
    update(dt) {
      if (!started || !enabled) return;
      chimes.update(dt);
      ambience.update(dt);
      stream?.update(dt);
      dog?.update(dt);
      bgm.update(dt);
    },
  };

  // 초기 상태 반영
  ambience.setTime(time);
  ambience.setWeather(weather);
  stream?.setWeather(weather);
  pushWind();
  bgm.play({ dawn: 'dawn', day: 'main-theme', sunset: 'sunset', night: 'night' }[time]);

  return api;
}
