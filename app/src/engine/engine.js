// cheoma 씬 엔진 — 프레임워크 무관 three.js 배선.
// src/main.js 데모 셸의 배선을 계승하되, lil-gui 대신 Svelte UI 가 구동하는
// 명령형 API 를 노출한다. 코어(../../../src)는 ES 모듈 그대로 import.
//
//   createEngine({ container }) → controller
//
// 렌더 경로는 플래그십 룩(env/post.js): RenderPass → Rim → Bloom → (Outline) → Bokeh → Output.
// 히어로/조립/포스트카드/셔플/환경 훅은 코어 모듈을 직접 재사용한다.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { OutlinePass } from 'three/addons/postprocessing/OutlinePass.js';
import { PRESETS, computeLayout } from '../../../src/params.js';
import { buildBuilding } from '../../../src/builder/index.js';
import { setupEnvironment, createFocusRing } from '../../../src/env/index.js';
import { setupWeather } from '../../../src/env/weather.js';
import { setupNightGlow } from '../../../src/env/night-glow.js';
import { setupCinematic } from '../../../src/camera/cinematic.js';
import { setupAudio } from '../../../src/audio/index.js';
import { setupPost } from '../../../src/env/post.js';
import { playAssembly, tofuScale, tofuBob } from '../../../src/anim/assembly.js';
import { capturePostcard } from '../../../src/share/postcard.js';
import { createVillage } from '../../../src/village/adapter.js';
import { createRerollWave } from '../../../src/village/wave.js';
import { configFromSeed, paramsFor, newSeed } from '../lib/seed.js';
import { buildWings, wingCount, buildNextWing, ghostSpec } from './expansion.js';

const DEG = Math.PI / 180;
const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);
const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOutCubic = (t) => 1 - Math.pow(1 - clamp01(t), 3);
// 머지 이동 곡선: 착지(IMPACT=0.5)까지 감속 도착하고 이후엔 제자리(두부 출렁이 마무리).
const moveArrive = (u) => (u >= 0.5 ? 1 : (1 - Math.pow(1 - u / 0.5, 3)));

// 히어로 오프닝 타이밍(연출 압축, #46). 착공을 크게 앞당기고 reveal 드라이브를 배속 재생해
// 첫 초 안에 기단·기둥이 올라오고 ~6초에 조립 절정이 정면 3/4 안착과 맞물리게 한다.
// window.__heroLegacy=true 면 구버전 타이밍(6.6s 착공·등속 reveal)으로 재현(before 계측).
const HERO_REVEAL_SCALE = 0.56;        // reveal 재생 배속(12s → ~6.7s)
const HERO_ASSEMBLE_DELAY_MS = 1300;   // enter 후 착공까지(타이틀 페이드 0.85s 직후)
const HERO_ASSEMBLE_DUR = 4.8;         // 조립 길이(완료 ≈6.1s — reveal 종료와 맞물림)

// focus 전환 타임라인 통일(#92, mode-integration §5.5 원칙 3) — focus-in 은 카메라 돌리 + DoF 램프 +
// 링 크로스페이드 + 패널 컨텍스트 모프를 "한 타임라인"으로 구동한다. 카메라 트윈이 그 클록의 권위 —
// tweenTo(onProgress)가 매 프레임 이즈드 k 를 흘려 App 이 패널 모프를 같은 커브로 그린다. DoF 는
// dofPull 로 트윈에 결선, 링은 경계(START/도착)에서 focusRing.set/clear(내부 페이드는 env 소유).
const FOCUS_IN_DUR = 1.9;              // 부감→근접 돌리인(줌 연속체 스냅 마무리 + 패널 모프)
const FOCUS_OUT_DUR = 1.7;             // 근접→부감 돌리아웃(역재생)
// 줌 연속체 임계(mode-integration §5.5 원칙 1) — 카메라↔필지(부감=화면중심 후보, 근접=focus 필지)
// 거리를 부감 기준거리(aerialDist)에 대한 비율로 게이트. ENTER<EXIT 히스테리시스로 경계 왕복 떨림 방지.
const ZOOM_ENTER_FRAC = 0.52;          // 줌인해 이 배율 이하로 가까워지면 자동 focus-in
const ZOOM_EXIT_FRAC = 0.72;           // 줌아웃해 이 배율 이상 멀어지면 자동 focus-out

export function createEngine({ container, perf = false, compact = false } = {}) {
  // 모바일 성능 프로파일. perf: 터치/좁은 뷰포트(폰·태블릿) → DoF off·그림자맵 하향.
  // compact: 폰급(최소변 ≤520) → pixelRatio 1.5·저해상 bloom(필레이트 절감). 데스크톱은 무변.
  const PR_CAP = compact ? 1.5 : 2;
  const SHADOW_SIZE = compact ? 1536 : perf ? 2048 : 4096;
  const LOW_BLOOM = compact;   // bloom 내부 타깃 반해상도(저주파라 시각 손실 미미)
  // ---------- 이벤트 버스 (Svelte 로 상태 변화 통지) ----------
  const listeners = {};
  const emit = (ev, payload) => { (listeners[ev] || []).forEach((f) => f(payload)); };
  const on = (ev, fn) => {
    (listeners[ev] || (listeners[ev] = [])).push(fn);
    return () => { listeners[ev] = (listeners[ev] || []).filter((f) => f !== fn); };
  };

  // ---------- 상태 ----------
  const state = {
    seed: 0, preset: 'korea', time: 'day', season: 'summer', weather: 'clear',
    expansion: 1, selected: false, canMerge: false,
  };
  let P = {}; // 현재 파라미터

  // ---------- 렌더러 / 씬 ----------
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.setPixelRatio(Math.min(devicePixelRatio, PR_CAP));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;   // OutputPass 가 최종 1회 적용
  renderer.toneMappingExposure = 1.05;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xcfd8e0);
  scene.fog = new THREE.Fog(0xcfd8e0, 60, 220);

  const sun = new THREE.DirectionalLight(0xfff0dd, 2.6);
  sun.position.set(30, 42, 26);
  sun.castShadow = true;
  sun.shadow.mapSize.set(SHADOW_SIZE, SHADOW_SIZE);
  sun.shadow.camera.left = -22; sun.shadow.camera.right = 22;
  sun.shadow.camera.top = 22; sun.shadow.camera.bottom = -22;
  sun.shadow.bias = -0.0001;
  sun.shadow.normalBias = 0.05;
  scene.add(sun);
  const hemi = new THREE.HemisphereLight(0xbdd0e4, 0x8a7a63, 0.9);
  scene.add(hemi);

  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(160, 48),
    new THREE.MeshStandardMaterial({ color: 0xb5a893, roughness: 1 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // ---------- 카메라 / 컨트롤 ----------
  const camera = new THREE.PerspectiveCamera(28, container.clientWidth / container.clientHeight, 0.1, 500);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI / 2 - 0.02;
  // 감상 자동 회전(느린 궤도). 유휴일 때만 ease-in 으로 켜고, 조작·전환 중엔 정지.
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0;             // 매 프레임 램프로 제어(아래 루프)
  const ORBIT_SPEED = 0.33;                 // ≈ 3분/바퀴 (autoRotateSpeed 2.0=30초 기준)
  const ORBIT_IDLE_MS = 9000;               // 유휴 후 재개까지(8~12초 범위)
  const ORBIT_RAMP_SEC = 2.6;               // ease-in 램프 시간
  let orbitGain = 0;                        // 0..1 회전 강도(램프)
  let lastActivity = performance.now();     // 마지막 사용자 조작 시각
  let heroActive = false;                   // 히어로 시퀀스 진행 중 플래그
  const markActivity = () => { lastActivity = performance.now(); };
  for (const ev of ['pointerdown', 'pointermove', 'wheel', 'keydown', 'touchstart']) {
    addEventListener(ev, markActivity, { passive: true });
  }

  // ---------- 건물 + 날개(wing) ----------
  let building = null;
  let wings = [];         // [{ group, assembly }]
  let weatherRef = null, nightGlowRef = null, audio = null;
  let assembly = null;    // 본채 조립 애니메이션
  // 머지용 그룹 이동 애니(두부처럼 끌려와 붙기). [{ group, p0, p1, amp, dur, e, onDone }]
  let groupAnims = [];
  // 머지 후보 점선 윤곽(부속채가 놓인 바깥 자리). THREE.LineSegments.
  let ghost = null;

  // ---------- 마을 모드 상태 ----------
  //   active: 마을 부감 씬 활성 / handle: VillageHandle(어댑터) / selected: 편집 중 필지 id
  //   transitioning: 돌리인/아웃 진행 중(클릭 무시) / opts·seed: 다음 생성 파라미터.
  const village = {
    active: false, handle: null, selected: null, transitioning: false,
    opts: { scale: 'village', character: 'yeoyeom', includePalace: false, includeTemple: false },
    seed: 20260716,
    // 사전 생성 캐시(#46): 히어로 재생 중 createVillage 를 미리 돌려 만든 미진입 handle 1벌.
    // key=시드·옵션 직렬화(코어 내부 구조 불결합). enter/setOpts 가 key 일치 시 즉시 소비.
    cache: { key: null, handle: null },
    reveal: null,   // 진입 시 먹 안개 reveal 모션 상태 { e, dur }
    heroAsm: null,  // 종가 랜딩/리플레이 조립 애니(#62·#59) — 렌더 루프가 매 프레임 update
    heroTimer: null, // 랜딩 착공 지연 타이머(중단 시 취소)
    // ── 줌 연속체(#92) ──
    aerialDist: 0,  // 현재 부감 기준 카메라↔중심 거리(줌 임계 산출 기준, villageAerial 이 갱신)
    zoomCand: null, // 부감 줌인 중 화면중심 후보 필지 id(임계 넘으면 자동 focus)
    lastCenterT: 0, // 화면중심 픽 레이캐스트 스로틀
    // ── 리롤 웨이브(#56 배선) ──
    wave: null,     // { anim, oldHandle, newHandle, seed } — 진행 중 재구성 웨이브(입력 잠금)
  };
  let hoverParcel = null;     // 마을 호버 중 필지 id(하이라이트 토글 최소화)
  let lastHoverT = 0;         // 호버 레이캐스트 스로틀(~30Hz)
  let wheelAccum = 0;         // 편집 중 줌아웃 제스처 누적

  function disposeGroup(g) {
    g.traverse((o) => { o.geometry?.dispose?.(); });
  }

  function regenerate({ animateWings = false } = {}) {
    if (assembly) { assembly.skip(); assembly = null; }
    for (const w of wings) { w.assembly?.skip?.(); scene.remove(w.group); disposeGroup(w.group); }
    wings = [];
    if (building) { scene.remove(building); disposeGroup(building); }

    building = buildBuilding(P);
    scene.add(building);

    // 확장(칸 들이기): 현재 스텝에 맞는 날개들을 붙인다.
    if (state.expansion > 1) {
      wings = buildWings(P, state.expansion).map((w) => {
        scene.add(w.group);
        return { group: w.group, assembly: null, animate: animateWings };
      });
    }

    weatherRef?.onBuildingChanged();
    nightGlowRef?.onBuildingChanged();
    audio?.setLayout(computeLayout(P));
    cinematic && (cinematic.__dirty = true);
  }

  function startAssembly(duration = 5, { includeWings = true } = {}) {
    if (assembly) assembly.skip();
    building.visible = true;
    assembly = playAssembly(building, { duration, onDone: () => { assembly = null; } });
    if (includeWings) {
      for (const w of wings) {
        w.group.visible = true;
        w.assembly = playAssembly(w.group, { duration, onDone: () => { w.assembly = null; } });
      }
    }
  }

  // 파라미터 재조립 연출 — 슬라이더 연속 조작은 디바운스 후 1회만 짧은 두부 조립으로 정착시킨다.
  // (매 틱 flat 스왑 대신, 조작을 멈추면 교체 부재들이 띠용 하고 앉는다. 조립 언어는 assembly.js 공유.)
  const REBUILD_DEBOUNCE_MS = 90;   // 조작 멈춤 후 재생 지연(UI 110ms 디바운스와 합쳐 ~0.2s)
  const REBUILD_ANIM_SEC = 0.8;     // 짧게 — 파라미터 미세조정 반복이 답답하지 않게
  let rebuildTimer = null;
  function scheduleRebuild() {
    if (rebuildTimer) clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => {
      rebuildTimer = null;
      regenerate();                                        // regenerate 가 audio.setLayout 도 갱신
      startAssembly(REBUILD_ANIM_SEC, { includeWings: true });
      if (state.selected) refreshGhost();
    }, REBUILD_DEBOUNCE_MS);
  }

  // ---------- 환경 (산수화 레이어) ----------
  const env = setupEnvironment(scene, { sun, hemi, renderer, layout: computeLayout(PRESETS.korea) });
  // 앰비언스 근접 링(#79·mode-integration §3) — focus-in 필지에 마당 닭·굴뚝 연기·먼지 모트·등롱 흔들림을
  // 점등한다. 동시 1개, 크로스페이드. 부감(focus-out)에선 clear. heightAt 은 현재 마을 지형 조회(폴백 0).
  const focusRing = createFocusRing(scene, {
    heightAt: (x, z) => village.handle?.plan?.site?.heightAt?.(x, z) ?? 0,
    sun, renderer,
  });
  const cinematic = setupCinematic(camera, controls, {
    getLayout: () => computeLayout(P),
    domElement: renderer.domElement,
  });

  weatherRef = setupWeather(scene, {
    layout: computeLayout(PRESETS.korea),
    getBuilding: () => building,
    getGround: () => ground,
    env, // 대기 틴트를 fog 모디파이어로 자동 등록 — 비/눈 중 시간 크로스페이드에도 틴트 유지
    lowPerf: perf, // 모바일 perf 프로파일은 볼륨 시뮬(눈 쉘·빗물 흐름) 폴백 → 셰이더 틴트만(#52)
  });
  nightGlowRef = setupNightGlow({ getBuilding: () => building });

  // ---------- 플래그십 후처리 (메인 룩) ----------
  const post = setupPost({ renderer, scene, camera });
  // 모바일(perf)은 DoF off — BokehPass 풀스크린 블러가 필레이트를 크게 먹는다. 돌리인 전환의
  // dofPull 램프는 pass 비활성 시 무해(카메라 트윈만 유지). 데스크톱은 종전대로 ON.
  post.setDof(!perf);
  // 모바일(perf)은 렌즈 플레어 패스도 스킵 — 풀스크린 가산 패스 필레이트 절감(#67).
  post.setFlareEnabled(!perf);
  const dofOn = !perf;
  // compact: bloom 내부 타깃 반해상도(저주파라 손실 미미, 필레이트 절감). setSize 뒤 재적용.
  const applyBloomRes = (w, h) => { if (LOW_BLOOM) post.bloomPass.setSize(Math.max(1, w >> 1), Math.max(1, h >> 1)); };
  applyBloomRes(container.clientWidth, container.clientHeight);
  // 호버 윤곽(먹선) — post 컴포저의 OutputPass 앞에 삽입.
  const outline = new OutlinePass(
    new THREE.Vector2(container.clientWidth, container.clientHeight), scene, camera
  );
  outline.edgeStrength = 2.2;                // 은은한 먹선 하이라이트
  outline.edgeGlow = 0.0;
  outline.edgeThickness = 1.0;
  outline.pulsePeriod = 0;
  outline.visibleEdgeColor.set('#2c2620');   // 먹색(보이는 실루엣만)
  // 가려진(occluded) 실루엣은 그리지 않는다 — 검정=가산 0. (지형 뒤 기단 윤곽이
  // 밝은 흰 선으로 누출되던 아티팩트 제거: OutlinePass 는 hidden 엣지를 항상 렌더하므로 색으로 소거.)
  outline.hiddenEdgeColor.set('#000000');
  outline.selectedObjects = [];
  post.composer.insertPass(outline, post.composer.passes.length - 1);

  function reapplyEnvBase() {
    env.setTime(state.time); // sky.apply → fog/bg/exposure/조명
  }
  function refreshAtmosphere() {
    weatherRef?.applyAtmosphere({ mode: 'pbr' });
  }

  // ---------- 카메라 프레이밍 ----------
  function spotFor(name, L) {
    const maxDim = Math.max(L.W + 4, L.D + 4, L.totalH);
    const target = new THREE.Vector3(0, L.totalH * 0.42, 0);
    const spots = {
      'front': { az: 0, el: 7, r: 2.9 },
      'three-quarter': { az: 38, el: 13, r: 3.0 },
      'side': { az: 90, el: 8, r: 2.9 },
      'roof': { az: 42, el: 36, r: 2.9 },
      'closeup': { az: 42, el: -12, r: 0.76, ty: L.plateY + 0.8 },
      'focus': { az: 34, el: 10, r: 2.35 },
    };
    const s = spots[name] || spots['three-quarter'];
    if (s.ty !== undefined) target.y = s.ty;
    const az = (s.az * Math.PI) / 180, el = (s.el * Math.PI) / 180;
    const r = s.r * maxDim;
    const pos = new THREE.Vector3(
      target.x + r * Math.cos(el) * Math.sin(az),
      target.y + r * Math.sin(el),
      target.z + r * Math.cos(el) * Math.cos(az)
    );
    return { pos, target };
  }
  function setAngle(name) {
    const { pos, target } = spotFor(name, computeLayout(P));
    camera.position.copy(pos);
    controls.target.copy(target);
    controls.update();
  }

  // 선택/확장 포커스 프레이밍 — 마당(날개 포함) 전체가 들어오도록 확장 단계에 따라 넓힌다.
  function focusFraming() {
    const L = computeLayout(P);
    const exp = state.expansion;
    const maxDim = Math.max(L.W + 4, L.D + 4, L.totalH) * (1 + 0.34 * (exp - 1));
    const target = new THREE.Vector3(0, L.totalH * 0.42, exp > 1 ? L.D * 0.35 : 0);
    const az = 34 * Math.PI / 180, el = (exp > 1 ? 17 : 11) * Math.PI / 180;
    const r = (exp > 1 ? 2.55 : 2.35) * maxDim;
    const pos = new THREE.Vector3(
      target.x + r * Math.cos(el) * Math.sin(az),
      target.y + r * Math.sin(el),
      target.z + r * Math.cos(el) * Math.cos(az)
    );
    return { pos, target };
  }

  // 카메라 트윈(선택 포커스·해제·마을 돌리인/아웃). 진행 중이면 매 프레임 lerp.
  //   opts.fov 지정 시 화각도 함께 보간(마을 부감 42 ↔ 필지 28), opts.dofPull 로 전환 중 조리개 램프,
  //   opts.onDone 은 도착 콜백(마을 도착 시 편집 패널 슬라이드 인 등).
  let tween = null;
  function tweenTo(pos, target, dur = 0.95, { fov, onDone, onProgress, dofPull = false } = {}) {
    cinematic.stop();
    tween = {
      p0: camera.position.clone(), p1: pos.clone(),
      t0: controls.target.clone(), t1: target.clone(),
      f0: camera.fov, f1: fov ?? camera.fov,
      dur, e: 0, onDone, onProgress, dofPull,
      // 검증 토글(before/after 계측용). window.__flowNoFix=true 면 이번 트윈은 방향 연속화·핸드오프
      // 리셋을 끈다(구버전 버그 재현). 미설정=수정본. 트윈 시작 시 1회만 읽어 핫 루프 오염 방지.
      noFix: typeof window !== 'undefined' && !!window.__flowNoFix,
    };
  }

  // 플래그십 후처리 컴포저에서 BokehPass(DoF)를 찾아 전환 중 조리개를 램프한다(있을 때만).
  const bokehPass = post.composer.passes.find((p) => p.uniforms && p.uniforms.aperture);
  const bokehBase = bokehPass ? bokehPass.uniforms.aperture.value : 0;
  // 전환 진행 k(0→1)에 sin 종 모양으로 조리개를 부풀렸다 복원 — 중간에 주변이 뭉개져 집으로 시선이 모임.
  function dofPullRamp(k) {
    if (!bokehPass) return;
    bokehPass.uniforms.aperture.value = bokehBase * (1 + 6 * Math.sin(Math.PI * clamp01(k)));
  }

  // 트윈 핸드오프용 — OrbitControls 관성(회전 _sphericalDelta·팬 _panOffset·줌 _scale)을 0 으로.
  // three 0.185 인스턴스 필드 직접 리셋(공개 stop() 이 없어 이게 표준 패턴): 전환 중 사용자
  // 드래그/휠이 남긴 momentum 이 트윈 종료 직후 첫 update() 에 한꺼번에 적용되며 튀는 것 방지.
  function settleControls() {
    controls._sphericalDelta?.set(0, 0, 0);
    controls._panOffset?.set(0, 0, 0);
    controls._scale = 1;
  }

  // ---------- 오디오 (첫 제스처에서 생성·재생) ----------
  function ensureAudio() {
    if (audio) return audio;
    audio = setupAudio(camera, {
      layout: computeLayout(P),
      streamAnchor: env.streamAnchor,
      getDogAnchor: () => env.dogAnchor,
      getDogState: () => env.dogState,
    });
    audio.setTime(state.time);
    audio.setWeather(state.weather);
    audio.setEnvActive(true);
    return audio;
  }

  // ---------- 초기 씬 적용 ----------
  function applyConfig(cfg, { animate = false } = {}) {
    state.preset = cfg.preset;
    state.time = cfg.time;
    state.season = cfg.season;
    state.weather = cfg.weather;
    state.canMerge = false;
    P = cfg.params;

    clearGhost();
    groupAnims = [];
    regenerate();
    setAngle('three-quarter');

    env.setEnabled(true);
    ground.visible = false;
    env.setTime(state.time);
    env.setSeason(state.season, {});
    weatherRef.setWeather(state.weather);
    nightGlowRef.setEnabled(true);
    nightGlowRef.setTime(state.time);
    post.setTime(state.time);
    reapplyEnvBase();
    refreshAtmosphere();
    audio?.setTime(state.time); audio?.setWeather(state.weather);
    emit('state', { ...state });
    if (animate) startAssembly(2.6);
  }

  // ---------- 렌더 루프 ----------
  function renderFrame() {
    if (dofOn) post.setFocus(camera.position.distanceTo(controls.target));
    post.update();
    post.composer.render();
  }
  function resizeAll() {
    const w = container.clientWidth, h = container.clientHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    post.setSize(w, h);
    applyBloomRes(w, h);   // composer.setSize 가 bloom 을 풀해상도로 되돌리므로 재적용
    outline.setSize(w, h);
  }
  addEventListener('resize', resizeAll);

  let frames = 0;
  const clock = new THREE.Clock();
  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.05);
    // 카메라 트윈
    if (tween) {
      tween.e = Math.min(tween.dur, tween.e + dt);
      const k = easeInOutCubic(clamp01(tween.e / tween.dur));
      camera.position.lerpVectors(tween.p0, tween.p1, k);
      controls.target.lerpVectors(tween.t0, tween.t1, k);
      // 위치·타깃과 함께 시선 방향도 매 프레임 연속 갱신한다. OrbitControls.update() 는 트윈 중
      // 게이트(아래 line ~392)로 스킵되므로 그 안의 object.lookAt(target) 이 걸리지 않는다 —
      // 이걸 빼면 전환 내내 방향이 동결됐다가 종료 프레임에 update() 가 재개되며 스냅한다(= 화면
      // 중심이 튀는 현상). 여기서 직접 바라보게 해 방향 불연속을 제거.
      if (!tween.noFix) camera.lookAt(controls.target);
      if (tween.f1 !== tween.f0) { camera.fov = tween.f0 + (tween.f1 - tween.f0) * k; camera.updateProjectionMatrix(); }
      if (tween.dofPull) dofPullRamp(k);
      tween.onProgress?.(k);   // 패널 컨텍스트 모프 등 — 카메라와 동일 클록(#92 타임라인 통일)
      if (tween.e >= tween.dur) {
        // 핸드오프: OrbitControls 관성(회전/팬/줌 잔류)을 0 으로 리셋해 다음 update() 가 스냅·lurch
        // 없이 현재 지오메트리에서 재개하도록(자동 회전도 0속도 시작 보장).
        if (!tween.noFix) settleControls();
        const cb = tween.onDone; tween = null; cb?.();
      }
    }
    cinematic.update(dt);
    if (assembly && assembly.update(dt)) assembly = null;
    for (const w of wings) if (w.assembly && w.assembly.update(dt)) w.assembly = null;
    if (village.heroAsm && village.heroAsm.update(dt)) village.heroAsm = null;   // 종가 랜딩/리플레이 조립
    // 머지 두부 이동 애니
    if (groupAnims.length) {
      groupAnims = groupAnims.filter((a) => {
        a.e += dt;
        const u = clamp01(a.e / a.dur);
        a.group.position.lerpVectors(a.p0, a.p1, moveArrive(u));
        a.group.position.y += tofuBob(u, a.amp) * 0.5;
        const s = tofuScale(u, a.amp);
        a.group.scale.set(s.sxz, s.sy, s.sxz);
        if (u >= 1) { a.group.position.copy(a.p1); a.group.scale.set(1, 1, 1); a.onDone?.(); return false; }
        return true;
      });
    }
    // 머지 후보 점선 펄스
    if (ghost) {
      const k = 0.5 + 0.5 * Math.sin(clock.elapsedTime * 3.2);
      ghost.material.opacity = 0.32 + 0.4 * k;
    }
    // 감상 자동 회전 게이트 + ease-in 램프. 히어로·조립/확장/머지·시네마틱·트윈·선택 중엔 정지,
    // 유휴(ORBIT_IDLE_MS) 지나면 부드럽게 재개. 조작(markActivity) 시 즉시 정지.
    const orbitBusy = heroActive || assembly || groupAnims.length > 0 ||
      wings.some((w) => w.assembly) || cinematic.isActive() || tween || state.selected ||
      (village.active && village.selected) || village.heroAsm || village.wave;
    if (!orbitBusy && performance.now() - lastActivity > ORBIT_IDLE_MS) {
      orbitGain = Math.min(1, orbitGain + dt / ORBIT_RAMP_SEC);
    } else {
      orbitGain = 0; // 조작·전환 시 즉시 일시정지
    }
    const g = orbitGain * orbitGain * (3 - 2 * orbitGain); // smoothstep ease-in
    controls.autoRotateSpeed = ORBIT_SPEED * g;
    // dt 를 넘겨 autoRotate 를 프레임레이트 독립으로 — 무인자 update() 는 60fps 를 가정한
    // 프레임당 고정 회전이라 120Hz 디스플레이에서 2배 빨라진다(주기 스펙 이탈). dt 경로는
    // 초당 회전량이 (2π/60·speed) 로 고정되어 주기 60/speed 초가 주사율과 무관하게 유지된다.
    if (!cinematic.isActive() && !tween) controls.update(dt);
    weatherRef.update(dt);
    env.update(dt);
    nightGlowRef.update(dt);
    if (village.active && village.handle) village.handle.update(dt);   // 개울 물결·야간 촛불 일렁임
    // 리롤 웨이브(#56) — 옛 마을 방사 해체 → 지형 크로스페이드 → 새 마을 방사 조립. 완료 시 승격.
    if (village.wave) { if (village.wave.anim.update(dt) >= 1) finishRerollWave(); }
    focusRing.update(dt, state.time);                                  // 앰비언스 근접 링(#79) — 미설정 시 no-op
    updateZoomContinuum();                                             // 줌 연속체 자동 focus-in/out(#92)
    // 진입 먹 안개 reveal: fog 를 짙게(near/far 좁게) 시작해 base(R비례)로 풀어 마을이 드러남.
    if (village.active && village.reveal && scene.fog && village.handle) {
      village.reveal.e += dt;
      const k = clamp01(village.reveal.e / village.reveal.dur);
      const e = easeOutCubic(k);
      const R = village.handle.plan.site.R;
      scene.fog.near = R * (0.5 + 1.7 * e);   // 0.5R(짙음) → 2.2R(base)
      scene.fog.far = R * (2.6 + 4.4 * e);    // 2.6R → 7.0R(base)
      if (k >= 1) village.reveal = null;
    }
    audio?.update(dt);
    renderFrame();
    frames++;
    if (frames === 3) window.__SHOT_READY = true;
  });

  // ---------- 호버/선택 (레이캐스트) ----------
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let hovering = false;
  function pick(clientX, clientY) {
    const rect = renderer.domElement.getBoundingClientRect();
    ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
    const targets = [building, ...wings.map((w) => w.group)];
    const hit = raycaster.intersectObjects(targets, true);
    return hit.length ? hit[0] : null;
  }
  renderer.domElement.addEventListener('pointermove', (e) => {
    if (village.wave) return;                                  // 웨이브 중 입력 무시(#56)
    if (village.active) { villageHover(e.clientX, e.clientY); return; }
    if (state.selected) { outline.selectedObjects = []; return; }
    const h = pick(e.clientX, e.clientY);
    const now = !!h;
    if (now !== hovering) {
      hovering = now;
      outline.selectedObjects = now ? [building, ...wings.map((w) => w.group)] : [];
      renderer.domElement.style.cursor = now ? 'pointer' : '';
      emit('hover', now);
    }
  });
  let downPos = null;
  renderer.domElement.addEventListener('pointerdown', (e) => {
    downPos = { x: e.clientX, y: e.clientY };
    // 터치엔 호버가 없으므로 탭 시작 순간 미니 라벨을 잠깐 띄운다(선택 시 villageSelectStart 가 지움).
    if (e.pointerType === 'touch' && village.active && !village.selected && !village.transitioning) {
      lastHoverT = 0; villageHover(e.clientX, e.clientY);
    }
  });
  renderer.domElement.addEventListener('pointerup', (e) => {
    ensureAudio()?.start();
    if (!downPos) return;
    const moved = Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y);
    downPos = null;
    if (moved > 6) return;             // 드래그(궤도 회전)는 선택으로 치지 않음
    if (village.active) {
      if (village.wave || village.transitioning || village.selected) return;   // 웨이브·전환·focus 중 클릭 무시
      const rect = renderer.domElement.getBoundingClientRect();
      ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(ndc, camera);
      const hit = village.handle.raycast(raycaster);
      if (hit) villageSelect(hit.parcelId);   // 클릭 = 그 필지 focus-in(줌 연속체와 별개 직행 경로)
      return;
    }
    const h = pick(e.clientX, e.clientY);
    if (h && !state.selected) { selectBuilding(); }
  });
  // 줌 연속체(#92): 부감↔근접 전환은 렌더 루프의 updateZoomContinuum 이 카메라↔필지 거리(휠·핀치가
  //   OrbitControls 로 구동)를 감시해 자동 트리거한다. 휠 자체는 OrbitControls 가 소비 — 여기선 봉인 없음.

  // ---------- 머지 후보 점선 윤곽 ----------
  function clearGhost() {
    if (ghost) { scene.remove(ghost); ghost.geometry.dispose(); ghost.material.dispose(); ghost = null; }
  }
  function refreshGhost() {
    clearGhost();
    state.canMerge = false;
    if (!state.selected) return;
    if (state.expansion >= wingCount(state.preset) + 1) return;
    const gs = ghostSpec(P, state.expansion + 1);
    if (!gs) return;
    const box = new THREE.BoxGeometry(gs.size.D, gs.size.H, gs.size.W); // 회전축(깊이=x, 폭=z)
    const edges = new THREE.EdgesGeometry(box);
    box.dispose();
    const mat = new THREE.LineDashedMaterial({ color: 0xf4efe4, dashSize: 0.5, gapSize: 0.34, transparent: true, opacity: 0.7, depthTest: true });
    ghost = new THREE.LineSegments(edges, mat);
    ghost.computeLineDistances();
    ghost.position.copy(gs.pStart).add(new THREE.Vector3(0, gs.size.H / 2, 0));
    ghost.renderOrder = 999;
    scene.add(ghost);
    state.canMerge = true;
  }

  function selectBuilding() {
    state.selected = true;
    outline.selectedObjects = [];
    hovering = false;
    renderer.domElement.style.cursor = '';
    const { pos, target } = focusFraming();
    tweenTo(pos, target);
    refreshGhost();
    emit('select', true);
    emit('state', { ...state });
  }
  function clearSelection() {
    if (!state.selected) return;
    state.selected = false;
    state.canMerge = false;
    clearGhost();
    const { pos, target } = spotFor('three-quarter', computeLayout(P));
    tweenTo(pos, target);
    emit('select', false);
    emit('state', { ...state });
  }

  // ---------- 머지(합치기): 부속채가 두부처럼 끌려와 붙어 ㄱ/ㄷ자로 재편 ----------
  function merge() {
    const target = state.expansion + 1;
    if (target > wingCount(state.preset) + 1) return;
    const nw = buildNextWing(P, target);
    if (!nw) return;
    clearGhost();
    state.canMerge = false;
    nw.group.position.copy(nw.pStart);
    scene.add(nw.group);
    const wingObj = { group: nw.group, assembly: null };
    wings.push(wingObj);
    state.expansion = target;
    // 두부 이동 애니: 바깥 부속채 자리 → 최종 접합 위치로 끌려오며 착지 순간 눌림·출렁.
    groupAnims.push({
      group: nw.group, p0: nw.pStart.clone(), p1: nw.pFinal.clone(),
      amp: 0.26, dur: 1.15, e: 0,
      onDone: () => { refreshGhost(); emit('state', { ...state }); },
    });
    // 확장이 커졌으니 마당 전체가 들어오게 재프레이밍.
    const f = focusFraming();
    tweenTo(f.pos, f.target, 1.0);
    audio?.setLayout(computeLayout(P));
    emit('state', { ...state });
  }

  // ---------- 마을 모드 ----------
  // 마을 외곽 실반경(#80) — 지형 반경(site.R)이 아니라 실제 집이 퍼진 반경으로 프레이밍해야 마을이
  // 화면을 채운다. 필지 중심 최대거리 + 담/마당 여유(×1.12). 캐시(핸들당 1회).
  function villageOuterR() {
    if (village.__outerR != null) return village.__outerR;
    const plan = village.handle.plan;
    let r = (plan.site.bowlR || plan.site.R * 0.56);
    for (const p of (plan.parcels || [])) {
      const d = Math.hypot(p.center.x, p.center.z);
      if (d > r) r = d;
    }
    village.__outerR = r * 1.12;
    return village.__outerR;
  }
  // 마을 부감 프레이밍(#80) — 마을 외곽 원이 뷰포트 최소변의 ~72% 를 채우도록 거리 산출(규모 파생, 고정
  // 상수 아님). 배산임수 실루엣(뒤 능선+하늘)은 타깃을 살짝 위·북으로 올려 상단에 남긴다. 자동 회전 중심.
  const AERIAL_FILL = 0.72;    // 마을 외곽 지름이 최소변에서 차지할 비율
  const AERIAL_FOV = 42;
  const AERIAL_EL = 31 * DEG;  // 부감 앙각(능선 헤드룸 유지)
  const AERIAL_AZ = 9 * DEG;
  function villageAerial() {
    const Rv = villageOuterR();
    const aspect = camera.aspect || (container.clientWidth / container.clientHeight) || 1.6;
    // 실측 보정(shoot-entry-aerial): 부감 틸트(AERIAL_EL)·fov 에서 지면 중앙의 화면 수평 반폭 ≈ C·d·aspect.
    // 두 종횡비(1.78·0.59)에서 C≈0.40 일치. 마을 지름(2Rv)이 최소변의 fill 을 채우도록 d 를 역산한다.
    //   landscape(가로 넓음): 세로가 최소변이나 틸트로 세로가 압축돼 체감이 커지므로 수평 fill 목표는
    //     조금 낮춰(0.60) 잡아 세로 체감 ~0.7 + 능선/하늘 상단 여백 확보. portrait: 가로가 최소변 → 0.70.
    const C = 0.40;
    const fill = aspect >= 1 ? 0.60 : 0.70;
    let d = Rv / (C * fill * aspect);
    village.aerialDist = d;   // 줌 연속체 임계 산출 기준(#92)
    const target = new THREE.Vector3(0, Rv * 0.05, -Rv * 0.10);   // 살짝 위+북(능선/하늘 상단 여백)
    const pos = new THREE.Vector3(
      target.x + d * Math.cos(AERIAL_EL) * Math.sin(AERIAL_AZ),
      target.y + d * Math.sin(AERIAL_EL),
      target.z + d * Math.cos(AERIAL_EL) * Math.cos(AERIAL_AZ));
    return { pos, target, fov: AERIAL_FOV };
  }

  // ── 줌 연속체(#92) — OrbitControls 줌을 상태별 거리 클램프로 제어 ──
  //   'aerial': 부감. 줌아웃 상한은 부감거리 근처(더 못 뺌), 줌인 하한은 focus 진입 임계 살짝 아래
  //             (임계에 도달하면 자동 focus-in 이 인계). 'focus': 근접. 줌인 하한은 근경 안쪽(집 살펴보기),
  //             줌아웃 상한은 focus-out 임계 살짝 위(임계 도달 시 자동 focus-out 인계). 'lock': 전환/웨이브
  //             중 줌 봉인.
  function setZoomRegime(mode, closeupDist = 0) {
    const a = village.aerialDist || 150;
    if (mode === 'aerial') {
      controls.enableZoom = true;
      controls.minDistance = a * (ZOOM_ENTER_FRAC * 0.82);
      controls.maxDistance = a * 1.06;
    } else if (mode === 'focus') {
      controls.enableZoom = true;
      controls.minDistance = Math.max(2, closeupDist * 0.5);
      controls.maxDistance = a * (ZOOM_EXIT_FRAC * 1.06);
    } else {                       // lock
      controls.enableZoom = false;
    }
  }
  // 화면 중심(NDC 0,0) 필지 픽 — 부감 줌인 중 "지금 보고 있는 집" 후보를 뽑는다(스로틀).
  function centerParcel() {
    if (!village.handle) return null;
    ndc.set(0, 0);
    raycaster.setFromCamera(ndc, camera);
    const hit = village.handle.raycast(raycaster);
    return hit ? hit.parcelId : null;
  }
  // 부감 중심 후보 필지의 월드 중심까지 카메라 거리(줌 연속체 metric). 없으면 Infinity.
  function parcelDist(parcelId) {
    if (!parcelId || !village.handle) return Infinity;
    const pr = village.handle.getPickProxies().find((p) => p.parcelId === parcelId);
    return pr ? camera.position.distanceTo(pr.worldCenter) : Infinity;
  }
  // 매 프레임 줌 연속체 게이트(#92). 부감(미focus)에서 휠/핀치로 화면중심 후보 필지가 ENTER 임계 이내로
  //   가까워지면 자동 focus-in(스냅 돌리 마무리). 근접(focus)에서 EXIT 임계 밖으로 멀어지면 자동 focus-out.
  //   히스테리시스(ENTER<EXIT)로 경계 왕복 떨림 방지. 전환·웨이브·랜딩 중엔 게이트 정지(중복 트리거 차단).
  function updateZoomContinuum() {
    // 엔진 구동 카메라 트윈(진입·부감·focus·setOpts·reroll) 중엔 정지 — 그때는 dist 가 목표를 향해
    // 흐르는 중이라(진입 초기엔 근접) 오작동 트리거가 난다. 사용자 줌(OrbitControls dolly)은 tween 을
    // 만들지 않으므로 게이트 통과 → 실사용 연속체만 반응한다.
    if (!village.active || tween || village.transitioning || village.wave || village.heroAsm) return;
    const a = village.aerialDist || 0;
    if (a <= 0) return;
    if (!village.selected) {
      // 부감: 화면중심 후보 필지(스로틀) → ENTER 임계 이내면 자동 focus-in.
      const now = performance.now();
      if (now - village.lastCenterT > 90) {
        village.lastCenterT = now;
        const cand = centerParcel();
        if (cand !== village.zoomCand) {
          if (village.zoomCand && village.zoomCand !== hoverParcel) village.handle.highlightParcel(village.zoomCand, false);
          village.zoomCand = cand;
        }
      }
      const cand = village.zoomCand;
      if (!cand) return;
      const d = parcelDist(cand);
      // 후보가 화면중심에 잡히고 부감보다 눈에 띄게 가까워졌을 때만 후보 하이라이트(줌인 피드백).
      if (d < a * (ZOOM_ENTER_FRAC + 0.28) && cand !== hoverParcel) village.handle.highlightParcel(cand, true);
      if (d < a * ZOOM_ENTER_FRAC) { village.zoomCand = null; villageSelect(cand); }
    } else {
      // 근접: focus 필지에서 EXIT 임계 밖으로 멀어지면 자동 focus-out.
      const d = camera.position.distanceTo(controls.target);
      if (d > a * ZOOM_EXIT_FRAC) villageReturn();
    }
  }
  // 마을은 규모가 커 단일건물용 fog(near55~ far500)·camera.far(500)로는 원경이 잘리거나 안개에 먹힌다.
  // env.setTime 이 fog 를 되돌리므로 시간·날씨 전환 뒤 항상 이걸로 R 비례 값을 덮어쓴다.
  function reapplyVillageFog() {
    if (!village.active || !village.handle) return;
    const R = village.handle.plan.site.R;
    if (scene.fog) { scene.fog.near = R * 2.2; scene.fog.far = R * 7.0; }
    camera.far = R * 8; camera.near = 0.5;
    camera.updateProjectionMatrix();
  }

  // 배율별 후처리(mode-integration §5): 마을 부감은 RimPass(매 프레임 씬 노멀 재렌더)가 도성 규모에서
  // 60fps 위험이라 OFF. focus-in(집 근접)·단일건물 씬은 ON. rim OFF 시 FlarePass 가림 판정이 스테일
  // depth 로 오작동하므로 flare 도 동반 토글(모바일 perf 분기와 합성 — 한 곳에서 관리). 부감엔 flare 불필요.
  function setPostFocus(focused) {
    post.setRimEnabled?.(focused);
    post.setFlareEnabled?.(focused && !perf);
    // 부감(focus=null)은 DoF off — 마을 전체가 얕은 심도로 뭉개지지 않게(#80 완성도, hanyang·모바일 특히).
    // focus-in(집 근접)·단일건물은 on(플래그십 근경 심도). 돌리인 dofPull 램프는 focus-in 시작 시 DoF 가
    // 켜진 상태에서만 유효하므로 focus-in START(setPostFocus(true))에 함께 켜진다. 모바일 perf 는 항상 off.
    post.setDof?.(focused && !perf);
  }

  // 시드·옵션 → 캐시 키(코어 내부 구조 불결합, 직렬화만).
  function villageKey(opts, seed) {
    return `${seed >>> 0}|${opts.scale}|${opts.character}|${!!opts.includePalace}|${!!opts.includeTemple}`;
  }

  // 사전 생성: 주어진 옵션·시드의 마을을 미리 createVillage 로 만들어 캐시에 보관(씬 미진입).
  // 이미 같은 key 가 캐시/활성이면 no-op. window.__pregenOff 면 건너뛴다(before 계측용).
  function preloadVillage(opts = village.opts, seed = village.seed) {
    if (typeof window !== 'undefined' && window.__pregenOff) return null;
    const key = villageKey(opts, seed);
    if (village.cache.key === key && village.cache.handle) return village.cache.handle;
    if (village.active && village.handle && villageKey(village.opts, village.seed) === key) return village.handle;
    if (village.cache.handle) { village.cache.handle.dispose(); village.cache = { key: null, handle: null }; }
    const h = createVillage({ ...opts, seed: seed >>> 0 });   // group 생성만(씬 add 는 enter 시)
    village.cache = { key, handle: h };
    prewarmVillage(h);
    return h;
  }

  // GPU 프리워밍(#46): CPU createVillage 만으로는 첫 진입 프레임에 셰이더 컴파일·버퍼 업로드 히치가
  // 남는다. 미리 씬에 붙여 compile + 1프레임 렌더(모든 메시 frustumCulled 임시 해제해 버퍼 업로드
  // 강제)한 뒤 떼어, 그 비용을 히어로 타이틀 구간(마스킹)으로 앞당긴다. 상태는 즉시 원복(플래시 없음).
  function prewarmVillage(h) {
    if (!h || !h.group) return;
    const culled = [];
    const cam = { pos: camera.position.clone(), tgt: controls.target.clone(), fov: camera.fov, far: camera.far, near: camera.near };
    const fog = scene.fog ? { near: scene.fog.near, far: scene.fog.far } : null;
    try {
      scene.add(h.group);
      h.group.traverse((o) => { if (o.isMesh || o.isInstancedMesh || o.isLine || o.isPoints) { culled.push([o, o.frustumCulled]); o.frustumCulled = false; } });
      // 실제 진입 뷰(부감 카메라 + 마을 fog·far)로 예열 — 첫 진입 프레임의 셰이더 변종·업로드·
      // 스테이트를 그대로 warming(단일건물 카메라/far 로는 원경 지오·부감 셰이더가 덜 예열됨).
      const R = h.plan.site.R;
      camera.position.set(0.20 * R, 1.02 * R, 1.98 * R);
      controls.target.set(0, 0.06 * R, -0.10 * R);
      camera.fov = 42; camera.far = R * 8; camera.near = 0.5; camera.updateProjectionMatrix();
      camera.lookAt(controls.target);
      if (scene.fog) { scene.fog.near = R * 2.2; scene.fog.far = R * 7.0; }
      renderer.compile(scene, camera);   // 셰이더 컴파일(그림자 depth 포함)
      renderFrame();                     // 버퍼·instanceMatrix 업로드(draw 강제)
    } catch (e) {
      /* 프리워밍 실패는 비치명적 — 진입 시 정상 생성 경로로 폴백 */
    } finally {
      for (const [o, v] of culled) o.frustumCulled = v;
      scene.remove(h.group);
      camera.position.copy(cam.pos); controls.target.copy(cam.tgt);
      camera.fov = cam.fov; camera.far = cam.far; camera.near = cam.near; camera.updateProjectionMatrix();
      camera.lookAt(controls.target);
      if (fog && scene.fog) { scene.fog.near = fog.near; scene.fog.far = fog.far; }
      renderFrame();                     // 캔버스를 단일건물 상태로 원복(플래시 없음)
    }
  }

  // 다음 enter/setOpts 가 즉시(무생성) 가능한지 — App 이 먹 안개 마스킹 필요 여부 판단에 사용.
  function villageReady(opts = village.opts, seed = village.seed) {
    const key = villageKey(opts, seed);
    return (village.cache.key === key && !!village.cache.handle) ||
      (village.active && !!village.handle && villageKey(village.opts, village.seed) === key);
  }

  // 진입 순간 먹 안개 reveal(수묵 크로스페이드) — fog 를 짙게 시작해 base 로 풀며 마을이 드러난다.
  function startVillageReveal(dur = 1.3) { if (village.handle) village.reveal = { e: 0, dur }; }

  function buildVillage() {
    // 진행 중 종가 조립/타이머 정리(이전 핸들과 함께 폐기됨)
    if (village.heroTimer) { clearTimeout(village.heroTimer); village.heroTimer = null; }
    village.heroAsm = null;
    village.__outerR = null;   // 마을 외곽 실반경 캐시 리셋(#80) — 새 핸들 기준 재계산
    focusRing.clear();         // 마을 재구성 → 근접 링 해제(오버레이 폐기됨)
    if (village.handle) {
      village.handle.exitVillageMode({ scene, building, ground, env });
      village.handle.dispose();
      village.handle = null;
    }
    hoverParcel = null;
    const key = villageKey(village.opts, village.seed);
    if (village.cache.key === key && village.cache.handle) {
      village.handle = village.cache.handle;        // 사전 생성분 소비(생성 프리징 없음)
      village.cache = { key: null, handle: null };
    } else {
      village.handle = createVillage({ ...village.opts, seed: village.seed });
    }
    village.handle.enterVillageMode({ scene, building, ground, env });
    village.handle.setTime(state.time);
    village.handle.setSeason(state.season, {});
    village.handle.setWeather(state.weather);
    reapplyVillageFog();
    startVillageReveal();
  }

  function enterVillage(opts = null, seed = null) {
    if (opts) Object.assign(village.opts, opts);
    if (seed != null) village.seed = seed >>> 0;
    if (village.active) { buildVillage(); setPostFocus(false); const f = villageAerial(); tweenTo(f.pos, f.target, 1.0, { fov: f.fov, onDone: () => setZoomRegime('aerial') }); emit('villageMode', true); return; }
    // 단일건물 선택·호버 상태 정리
    if (state.selected) { clearGhost(); state.selected = false; state.canMerge = false; emit('select', false); emit('state', { ...state }); }
    outline.selectedObjects = []; hovering = false;
    // 단일건물 날씨 파티클은 원점(숨은 본채)에 몰려 부감에 튀므로 억제(상태값은 유지).
    weatherRef.setWeather('clear');
    village.active = true; village.selected = null; village.transitioning = false; village.zoomCand = null;
    camera.__houseFar = camera.far; camera.__houseNear = camera.near; camera.__houseFov = camera.fov;
    buildVillage();
    setPostFocus(false);                 // 부감 진입 → RimPass·flare OFF(성능)
    const f = villageAerial();
    tweenTo(f.pos, f.target, 1.4, { fov: f.fov, onDone: () => setZoomRegime('aerial') });
    emit('villageMode', true);
  }

  function exitVillage() {
    if (!village.active) return;
    stopHeroAsm();                                   // 진행 중 종가 조립·타이머 정리
    focusRing.clear();
    if (village.selected) village.handle.hideParcelDetail(village.selected);   // 오버레이(정규/특수) 해제
    else village.handle?.hideHeroDetail?.();
    if (hoverParcel) { village.handle.highlightParcel(hoverParcel, false); hoverParcel = null; }
    if (village.selected) village.handle.highlightParcel(village.selected, false);
    village.active = false; village.selected = null; village.transitioning = false; village.zoomCand = null;
    controls.enableZoom = true; controls.minDistance = 0; controls.maxDistance = Infinity; wheelAccum = 0;
    renderer.domElement.style.cursor = '';
    setPostFocus(true);                  // 단일건물 씬 복귀 → rim/flare 기본 복원
    village.handle.exitVillageMode({ scene, building, ground, env });
    camera.far = camera.__houseFar ?? 500; camera.near = camera.__houseNear ?? 0.1;
    camera.updateProjectionMatrix();
    reapplyEnvBase();                    // 단일건물 fog 복원(env.setTime)
    weatherRef.setWeather(state.weather); refreshAtmosphere();
    const { pos, target } = spotFor('three-quarter', computeLayout(P));
    tweenTo(pos, target, 1.2, { fov: camera.__houseFov ?? 28 });
    emit('villageMode', false);
  }

  // 필지 호버(마을 부감): 프록시 레이캐스트 → 어댑터 먹선 하이라이트 + 커서 + 미니라벨 이벤트.
  function villageHover(clientX, clientY) {
    if (village.selected || village.transitioning) {
      if (hoverParcel) { village.handle.highlightParcel(hoverParcel, false); hoverParcel = null; renderer.domElement.style.cursor = ''; emit('villageHover', null); }
      return;
    }
    const now = performance.now();
    if (now - lastHoverT < 33) return;   // ~30Hz 스로틀
    lastHoverT = now;
    const rect = renderer.domElement.getBoundingClientRect();
    ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
    const hit = village.handle.raycast(raycaster);
    const id = hit ? hit.parcelId : null;
    if (id !== hoverParcel) {
      if (hoverParcel) village.handle.highlightParcel(hoverParcel, false);
      if (id) village.handle.highlightParcel(id, true);
      hoverParcel = id;
      renderer.domElement.style.cursor = id ? 'pointer' : '';
    }
    emit('villageHover', hit ? { parcelId: id, spec: hit.buildingSpec, x: clientX, y: clientY } : null);
  }

  // 앰비언스 근접 링(#79) — focus 오버레이 컴파운드에 붙인다(마당 닭·연기·모트·등롱). 미설정 시 no-op.
  function attachFocusRing(overlayGroup) {
    if (!overlayGroup) return;
    // 궁궐(#93): 다일곽 궁역은 기념비적 건축 — 농가 앰비언스(마당 닭·풀·굴뚝 연기)가 조정(박석) 위에
    //   깔리면 고증 붕괴. focus.js 는 그룹 바운드로 풀/모트를 깔아 궁역 60~96m 를 채우므로 도메스틱 링은 생략.
    if (village.selected === 'palace') { focusRing.clear(); return; }
    const compound = overlayGroup.children.find((c) => c.name && c.name.startsWith('parcel-')) || overlayGroup.children[0] || overlayGroup;
    focusRing.set({ group: compound, parcel: null, radius: 18, seed: (village.seed ^ 0xf0c5) >>> 0, season: state.season });
    focusRing.setTime?.(state.time, true);
  }

  // 필지 focus-in(클릭·줌 연속체·토글 숏컷 공통) — mode-integration §5.5 원칙 1·3.
  //   모든 필지를 풀디테일 오버레이로 승격(showParcelDetail: 종가=컴파운드, 정규=단일 집) → 편집·리플레이·
  //   근접 링 앵커 확보(§4). 카메라 돌리 + DoF 램프 + 링 크로스페이드 + 패널 컨텍스트 모프를 FOCUS_IN_DUR
  //   한 타임라인으로 구동(onProgress 가 카메라 이즈드 k 를 App 패널 모프로 흘림). 줌은 전환 중 봉인.
  function villageSelect(parcelId) {
    if (!village.handle) return;
    const pr = village.handle.getPickProxies().find((p) => p.parcelId === parcelId);
    if (!pr) return;
    if (hoverParcel && hoverParcel !== parcelId) village.handle.highlightParcel(hoverParcel, false);
    hoverParcel = null; village.zoomCand = null;
    village.handle.highlightParcel(parcelId, true);   // 돌리인 동안 추적 하이라이트
    village.selected = parcelId; village.transitioning = true;
    setPostFocus(true);                                 // focus-in → rim/flare ON(#76 이전 임시)
    setZoomRegime('lock');                              // 전환 중 줌 봉인
    // 풀디테일 오버레이 승격(모든 필지) — 편집·리플레이·근접 링 앵커.
    const detail = village.handle.showParcelDetail(parcelId);
    renderer.domElement.style.cursor = '';
    const f = pr.cameraFraming;
    const closeupDist = f.position.distanceTo(f.target);
    emit('villageSelectStart', { parcelId, spec: pr.buildingSpec });
    emit('villageHover', null);
    tweenTo(f.position, f.target, FOCUS_IN_DUR, {
      fov: f.fov, dofPull: true,
      onProgress: (k) => emit('villageFocusMorph', k),         // 부감→집 패널 모프(0→1)
      onDone: () => {
        village.transitioning = false;
        village.handle.highlightParcel(parcelId, false);        // 도착: 근경엔 박스 숨김
        if (detail && detail.group) attachFocusRing(detail.group);  // 근접 앰비언스 점등(모든 필지)
        setZoomRegime('focus', closeupDist);                    // 근접 줌 클램프(줌아웃 → focus-out 인계)
        emit('villageFocusMorph', 1);
        emit('villageSelect', { parcelId, spec: pr.buildingSpec });
      },
    });
  }

  // focus-out(ESC·닫기·줌아웃·토글 숏컷) — focus-in 의 역재생(#92 원칙 3). 링 페이드아웃·패널 모프 역행·
  //   카메라 돌리아웃을 FOCUS_OUT_DUR 한 타임라인으로. 풀디테일 오버레이는 돌리아웃 내내 유지하고 부감
  //   도착 시(onDone) 해제 — 근경에서 인스턴스/병합본으로 갈아끼는 팝을 부감 거리로 밀어낸다.
  function villageReturn() {
    if (!village.active) return;
    if (!village.selected && !village.transitioning) return;
    stopHeroAsm();                                   // 진행 중 조립 정리
    focusRing.clear();                               // focus-out → 근접 앰비언스 페이드아웃(#79)
    const parcelId = village.selected;
    village.selected = null; village.transitioning = true; village.zoomCand = null;
    setZoomRegime('lock');                            // 전환 중 줌 봉인
    if (parcelId) village.handle.highlightParcel(parcelId, true);  // "내 집이 저기" 앵커
    const f = villageAerial();
    tweenTo(f.pos, f.target, FOCUS_OUT_DUR, {
      fov: f.fov,
      onProgress: (k) => emit('villageFocusMorph', 1 - k),   // 집→부감 패널 모프(1→0)
      onDone: () => {
        village.transitioning = false;
        setPostFocus(false);              // 부감 도착 → rim/flare OFF(전환 중엔 유지해 팝 방지)
        if (parcelId) village.handle.hideParcelDetail(parcelId);   // 부감 거리에서 오버레이 해제(팝 은닉)
        setZoomRegime('aerial');
        emit('villageFocusMorph', 0);
        emit('villageReturnDone', { parcelId });
        if (parcelId) setTimeout(() => { if (!village.selected && village.active) village.handle.highlightParcel(parcelId, false); }, 2000);
      },
    });
    emit('villageReturn', { parcelId });
  }

  function villageEscape() {
    if (village.active && (village.selected || village.transitioning)) villageReturn();
  }

  function villageSpec(parcelId) {
    if (!village.handle || !parcelId) return null;
    return village.handle.getPickProxies().find((p) => p.parcelId === parcelId)?.buildingSpec || null;
  }

  // ---------- 종가 랜딩·포커스·리플레이 (마을 우선 진입 #62 · 모드 일원화·리플레이 #59) ----------
  // 마을 우선 진입: 마을을 짓고 종가(hero) 필지에 카메라를 근접 프레이밍한 뒤 그 집을 조립 애니로
  //   지어 올린다(주변 마을은 먹 안개에서 드러남). 조립이 끝나면 그 집이 "내 집"(집 모드 클로즈업).
  //   집 모드↔마을 모드는 별도 씬이 아니라 이 종가 클로즈업 ↔ 부감 사이의 카메라 돌리로 일원화된다.

  function stopHeroAsm() {
    if (village.heroTimer) { clearTimeout(village.heroTimer); village.heroTimer = null; }
    if (village.heroAsm) { village.heroAsm.skip(); village.heroAsm = null; }   // skip → onDone(폴백 병합본 복원)
  }
  // 종가 컴파운드 조립 — 핵심 assembly.js(playAssembly)는 podium/columns/roof 등 부재 이름으로 파트를
  //   찾는데, 종가 오버레이(buildParcel 'hanok'/'palace' 컴파운드)는 그 이름 구조가 없어 아무것도 안
  //   움직였다. 그래서 컴파운드의 상위 청크(담·문·몸채·행각 — 자식이 있는 그룹)를 시공 순서대로 아래에서
  //   떠올려 두부 물리(tofuScale/Bob)로 안착시킨다. 몸채(hanok)를 마지막 클라이맥스로. 마당 평면·디딤돌
  //   (리프 메시)은 지면 디테일이라 정적. 원상복구(position.y·scale·visible)는 skip/완료 시 보장.
  function playCompoundAssembly(root, duration, { onDone, delay = 0 } = {}) {
    const compound = root.children[0] || root;
    const items = compound.children
      .filter((c) => c.children && c.children.length > 0)     // 그룹만(마당 평면·디딤돌 리프는 정적)
      .map((c, i) => ({ obj: c, y0: c.position.y, sx: c.scale.x, sy: c.scale.y, sz: c.scale.z, vis0: c.visible, i, body: c.name === 'hanok' }));
    items.forEach((it) => { it.ord = it.body ? 1e6 : it.i; });
    items.sort((a, b) => a.ord - b.ord);
    const n = items.length || 1;
    let e = 0, done = false;
    const set = (it, uu) => {
      if (uu <= 0) { it.obj.visible = false; it.obj.position.y = it.y0; it.obj.scale.set(it.sx, it.sy, it.sz); return; }
      if (uu >= 1) { it.obj.visible = it.vis0; it.obj.position.y = it.y0; it.obj.scale.set(it.sx, it.sy, it.sz); return; }
      it.obj.visible = it.vis0;
      const amp = it.body ? 0.3 : 0.2;
      const drop = it.body ? 3.4 : 2.2;
      const fall = uu < 0.5 ? (1 - easeOutCubic(uu / 0.5)) : 0;   // 아래(−drop)에서 제자리로 감속 착지
      it.obj.position.y = it.y0 - fall * drop + tofuBob(uu, amp) * drop * 0.5;
      const s = tofuScale(uu, amp);
      it.obj.scale.set(it.sx * s.sxz, it.sy * s.sy, it.sz * s.sxz);
    };
    const applyAt = (t) => items.forEach((it, i) => set(it, clamp01((t - (i / n) * 0.5) / 0.5)));
    const restore = () => items.forEach((it) => { it.obj.position.y = it.y0; it.obj.scale.set(it.sx, it.sy, it.sz); it.obj.visible = it.vis0; });
    applyAt(0);   // 즉시 빈 터(착공 전) — 완성본이 1프레임도 안 비치게
    return {
      update(dt) {
        if (done) return true;
        e += dt;
        if (e < delay) { applyAt(0); return false; }   // 착공 지연 동안 빈 터 유지(타이틀 페이드·먹안개 마스킹)
        const t = (e - delay) / duration;
        if (t >= 1) { restore(); done = true; onDone?.(); return true; }
        applyAt(t); return false;
      },
      skip() { if (done) return; restore(); done = true; onDone?.(); },
      isDone() { return done; },
    };
  }
  // 오버레이 g 에 조립 재생(delay=착공 지연). 완료 시 편집 불가(populate 언머지 전)면 병합본으로 되돌려 소품 복원.
  function playHeroAssembly(g, dur, { onDone, delay = 0 } = {}) {
    village.heroAsm = playCompoundAssembly(g, dur, { delay, onDone: () => {
      village.heroAsm = null;
      if (village.handle && !village.handle.heroEditable()) village.handle.hideHeroDetail();
      onDone?.();
    } });
  }

  function enterVillageHero(opts = null, seed = null, { onDone } = {}) {
    if (opts) Object.assign(village.opts, opts);
    if (seed != null) village.seed = seed >>> 0;
    cinematic.stop();
    if (state.selected) { clearGhost(); state.selected = false; state.canMerge = false; emit('select', false); emit('state', { ...state }); }
    outline.selectedObjects = []; hovering = false;
    weatherRef.setWeather('clear');
    village.active = true; village.selected = null; village.transitioning = true;
    camera.__houseFar = camera.far; camera.__houseNear = camera.near; camera.__houseFov = camera.fov;
    heroActive = true;                          // 랜딩 중 자동 회전 억제
    buildVillage();                              // 사전 생성분 소비(무프리징) + 먹 안개 reveal 시작
    const heroId = village.handle.heroParcelId();
    if (!heroId) {                               // 종가 없음(예외) → 부감 랜딩 폴백
      const f = villageAerial();
      camera.position.copy(f.pos); controls.target.copy(f.target); camera.fov = f.fov;
      camera.updateProjectionMatrix(); camera.lookAt(controls.target);
      village.transitioning = false; heroActive = false;
      emit('villageMode', true); onDone?.(); return;
    }
    village.selected = heroId;
    setPostFocus(true);                                 // 종가 클로즈업 랜딩 → rim/flare ON
    const g = village.handle.showHeroDetail(heroId);   // 풀디테일 오버레이(원본 종가 가림)
    // 종가 클로즈업 프레이밍으로 스냅(타이틀이 화면을 덮는 동안 세팅 → 페이드 아웃되면 조립이 보임)
    const pr = village.handle.getPickProxies().find((p) => p.parcelId === heroId);
    const f = pr.cameraFraming;
    camera.position.copy(f.position); controls.target.copy(f.target); camera.fov = f.fov ?? 28;
    camera.updateProjectionMatrix(); camera.lookAt(controls.target);
    reapplyVillageFog();
    // 랜딩 먹 안개 reveal 을 조립 완주까지 길게 — 마을이 서서히 드러나고, 근접 소품 은닉 폴백을 마스킹.
    startVillageReveal(HERO_ASSEMBLE_DELAY_MS / 1000 + HERO_ASSEMBLE_DUR + 0.8);
    emit('villageMode', true);
    emit('villageSelectStart', { parcelId: heroId, spec: pr.buildingSpec });   // 패널 집 컨텍스트(스펙 선전달)
    emit('villageFocusMorph', 1);                                              // 랜딩=집 컨텍스트로 안착
    const closeupDist = f.position.distanceTo(f.target);
    // 조립 즉시 시작하되 착공 지연(delay)만큼 빈 터 유지 → 타이틀 페이드·먹안개가 착공 순간을 덮는다.
    // 완료 시 클로즈업 편집 상태로 안착(패널 슬라이드 인).
    playHeroAssembly(g, HERO_ASSEMBLE_DUR, { delay: HERO_ASSEMBLE_DELAY_MS / 1000, onDone: () => {
      village.transitioning = false; heroActive = false; lastActivity = performance.now();
      attachFocusRing(village.handle.heroDetailGroup());   // 조립 정착 후 근접 앰비언스 점등(#79)
      setZoomRegime('focus', closeupDist);                 // 랜딩 착지 → 근접 줌(줌아웃 시 부감 연속체 인계)
      emit('villageSelect', { parcelId: heroId, spec: pr.buildingSpec });
      onDone?.();
    } });
  }

  // 종가 클로즈업으로 돌리(모드 토글 '집' — 부감에서 호출). villageSelect 재사용(돌리인+DoF 조임+패널).
  function focusHero() {
    if (!village.active || !village.handle || village.transitioning) return;
    const heroId = village.handle.heroParcelId();
    if (!heroId || village.selected === heroId) return;
    villageSelect(heroId);
  }

  // focus 조립 재생(#92 리플레이 일반화) — 컴파운드(종가·궁)는 청크 단위, 정규 집은 부재 단위(playAssembly).
  //   descriptor { group, assembly, compound }. compound·비편집(populate 언머지 불가) 종가는 완료 후 병합본 복원.
  function playFocusAssembly(detail, dur, { onDone, delay = 0 } = {}) {
    const finish = () => {
      village.heroAsm = null;
      if (detail.compound && village.handle && !village.handle.heroEditable()) village.handle.hideHeroDetail();
      onDone?.();
    };
    village.heroAsm = detail.compound
      ? playCompoundAssembly(detail.assembly, dur, { delay, onDone: finish })
      : playAssembly(detail.assembly, { duration: dur, onDone: finish });
  }

  // 리플레이(#59·#92 일반화) — 현재 focus 중인 "그 집"을 다시 조립. 종가 한정 해제: 어느 필지든 동작.
  //   focus 중인 오버레이(편집 상태 보존, 재생성 안 함)를 그대로 조립 재생 → 부팅 히어로 랜딩과 동형 경로.
  //   리플레이 내내 transitioning=true(연타 무효) + 패널 접힘(villageSelectStart), 정착 시 재슬라이드인.
  function replayFocus() {
    if (!village.active || !village.handle || village.transitioning) return;
    const id = village.selected;
    if (!id) return;
    const pr = village.handle.getPickProxies().find((p) => p.parcelId === id);
    if (!pr) return;
    let detail = village.handle.focusAssembly(id);           // 현 오버레이(편집 보존)
    if (!detail) { const d = village.handle.showParcelDetail(id); if (!d) return; detail = d; }
    const dur = detail.compound ? HERO_ASSEMBLE_DUR : 3.0;   // 정규 집은 짧게
    village.transitioning = true;
    setPostFocus(true);
    setZoomRegime('lock');
    stopHeroAsm();
    focusRing.clear();                                        // 재조립 중 링 해제(정착 후 재부착)
    emit('villageSelectStart', { parcelId: id, spec: pr.buildingSpec });   // 패널 접힘(감상)
    emit('villageHover', null);
    startVillageReveal(dur + 0.4);                            // 재형성 무드 + 폴백 소품 은닉 마스킹
    playFocusAssembly(detail, dur, { onDone: () => {
      village.transitioning = false;
      attachFocusRing(detail.group);
      const cp = pr.cameraFraming;
      setZoomRegime('focus', cp.position.distanceTo(cp.target));
      emit('villageFocusMorph', 1);
      emit('villageSelect', { parcelId: id, spec: pr.buildingSpec });      // 패널 재슬라이드인
    } });
  }

  // ── 리롤 웨이브(#56 배선·mode-integration §5.5 원칙) — 부감 유지, 옛 마을 방사 해체 → 지형 크로스페이드
  //    → 새 마을 방사 조립. 웨이브 시작 전 focus-out(링·오버레이 정리)은 호출부(App)가 보장. 입력 잠금. ──
  function startRerollWave() {
    if (!village.active || !village.handle || village.wave || village.transitioning) return null;
    // 진행 중 focus/조립 흔적 정리(부감 상태에서 호출되지만 방어)
    stopHeroAsm();
    if (village.selected) { focusRing.clear(); village.handle.hideParcelDetail(village.selected); village.selected = null; }
    if (hoverParcel) { village.handle.highlightParcel(hoverParcel, false); hoverParcel = null; }
    village.zoomCand = null;
    setZoomRegime('lock');
    const oldHandle = village.handle;
    const newSeedV = newSeed();
    const newHandle = createVillage({ ...village.opts, seed: newSeedV });
    // 새 핸들에 현재 env 상태 선적용(웨이브 중 옛 마을과 톤 일치) — 조명 리그는 옛 핸들 것이 씬을 비춘다.
    newHandle.setTime(state.time);
    newHandle.setSeason(state.season, {});
    newHandle.setWeather(state.weather);
    scene.add(newHandle.group);                              // old 와 공존(웨이브 대상)
    const site = oldHandle.plan.site;
    const anim = createRerollWave({
      oldRoot: oldHandle.group, newRoot: newHandle.group,
      center: site.center || { x: 0, z: 0 },
      heightAt: (x, z) => site.heightAt(x, z),
      seed: newSeedV, duration: 3.6,
    });
    village.wave = { anim, oldHandle, newHandle, seed: newSeedV };
    emit('villageWave', { phase: 'start' });
    return newSeedV;
  }
  // 웨이브 완료 → 옛 마을 폐기 + 새 마을 활성 승격(enterVillageMode 상당: 조명 리그·구름·fog·야경·픽킹 재연결).
  function finishRerollWave() {
    const w = village.wave; if (!w) return;
    village.wave = null;
    w.anim.dispose();                                        // 새 마을 트랜스폼·재질 완전 정상화
    // 옛 마을 이탈(조명 리그·구름·fog 모디파이어 해제 + 그룹 제거) 후 폐기.
    w.oldHandle.exitVillageMode({ scene, building, ground, env });
    w.oldHandle.dispose();
    // 새 마을 승격 — enterVillageMode(그룹은 이미 scene 자식이라 재부모 no-op) + 시간·계절·날씨·fog 재적용.
    village.handle = w.newHandle;
    village.seed = w.seed;
    village.__outerR = null;
    village.handle.enterVillageMode({ scene, building, ground, env });
    village.handle.setTime(state.time);
    village.handle.setSeason(state.season, {});
    village.handle.setWeather(state.weather);
    reapplyVillageFog();
    setZoomRegime('aerial');
    emit('villageSeed', village.seed);
    emit('villageWave', { phase: 'done' });
  }

  // ---------- 컨트롤러 API ----------
  const controller = {
    on, emit,
    getState: () => ({ ...state }),
    getParams: () => ({ ...P }),
    getLayout: () => computeLayout(P),

    start(cfg, seed = 0) { state.seed = seed >>> 0; applyConfig(cfg, { animate: false }); },

    // 리롤(다시 짓기): 새 seed → 결정적 설정 → 조립 연출. 새 seed 반환.
    reroll() {
      const seed = newSeed();
      state.seed = seed;
      state.expansion = 1; state.selected = false;
      applyConfig(configFromSeed(seed), { animate: true });
      emit('seed', seed);
      return seed;
    },
    applySeed(seed) {
      state.seed = seed >>> 0;
      state.expansion = 1; state.selected = false;
      applyConfig(configFromSeed(state.seed), { animate: true });
      emit('seed', state.seed);
      return state.seed;
    },

    setType(presetKey) {
      if (!PRESETS[presetKey]) return;
      state.preset = presetKey;
      state.expansion = 1;
      P = paramsFor(presetKey);
      clearGhost();
      regenerate();
      audio?.setLayout(computeLayout(P));
      // 선택 상태면 포커스 유지(+후보 갱신), 아니면 3/4
      const { pos, target } = state.selected ? focusFraming() : spotFor('three-quarter', computeLayout(P));
      tweenTo(pos, target, 0.7);
      startAssembly(2.4);
      if (state.selected) refreshGhost();
      emit('state', { ...state });
    },

    // 파라미터 슬라이더. UI 110ms 디바운스 + 여기 debounce 로 조작을 멈추면 1회 재조립(두부 정착).
    setParam(key, value) {
      P[key] = value;
      scheduleRebuild();
    },

    // 칸 확장 스테퍼: 1→2→3. 늘어난 날개만 조립 애니로 자라남.
    setExpansion(step) {
      step = Math.max(1, Math.min(wingCount(state.preset) + 1, step | 0));
      if (step === state.expansion) return;
      const growing = step > state.expansion;
      state.expansion = step;
      // 본채·기존 날개는 유지, 재생성 후 새 날개만 애니메이션.
      const prevWingGroups = wings.map((w) => w.group);
      const prevBuilding = building;
      // 부분 재구성: 본채/기존 날개를 없애지 않고 새 날개만 추가하려면 buildWings 를
      // 전체로 다시 만들되, 이미 존재하던 그룹은 즉시 완성 상태로 둔다.
      regenerate();
      building.visible = true;
      building.traverse(() => {});
      if (growing) {
        // 마지막(새) 날개만 조립 애니메이션(두부), 앞 날개는 즉시 완성.
        wings.forEach((w, i) => {
          if (i < state.expansion - 2) { w.group.visible = true; }
          else {
            w.group.visible = true;
            w.assembly = playAssembly(w.group, { duration: 2.4, onDone: () => { w.assembly = null; } });
          }
        });
      }
      audio?.setLayout(computeLayout(P));
      if (state.selected) { const f = focusFraming(); tweenTo(f.pos, f.target, 0.9); refreshGhost(); }
      emit('state', { ...state });
      void prevWingGroups; void prevBuilding;
    },
    merge,
    maxExpansion: () => wingCount(state.preset) + 1,

    setTime(name) {
      state.time = name;
      env.setTime(name);
      nightGlowRef.setTime(name);
      post.setTime(name);
      refreshAtmosphere();
      audio?.setTime(name);
      if (village.active && village.handle) { village.handle.setTime(name); reapplyVillageFog(); }
      focusRing.setTime?.(name);          // 근접 링 앰비언스 시간대(연기·모트·닭)
      emit('state', { ...state });
    },
    setSeason(name) {
      state.season = name;
      env.setSeason(name, {});
      refreshAtmosphere();
      if (village.active && village.handle) { village.handle.setSeason(name, {}); reapplyVillageFog(); }
      focusRing.setSeason?.(name);        // 근접 링 바람 풀 계절색 연동(#90) — 마을 계절과 일치(미배선 시 여름 초록 고정)
      emit('state', { ...state });
    },
    setWeather(name) {
      state.weather = name;
      // 마을 모드: 파티클은 숨은 본채에 몰려 부감에 튀므로 배선하지 않고(어댑터 한계) v 로만 라우팅.
      if (village.active && village.handle) { village.handle.setWeather(name); reapplyEnvBase(); reapplyVillageFog(); }
      else { weatherRef.setWeather(name); reapplyEnvBase(); refreshAtmosphere(); }
      audio?.setWeather(name);
      emit('state', { ...state });
    },

    select: selectBuilding,
    clearSelection,

    // 검증용(디버그): 현재 P 로 재조립을 진행도 t01 에 '정지'시켜 정지 프레임 스크린샷을 뜬다.
    // 루프에 assembly 를 넘기지 않아 자동진행 없음 — seek 로 찌그러진 순간을 고정.
    __debugFreezeRebuild(t01) {
      if (assembly) { assembly.skip(); assembly = null; }
      if (rebuildTimer) { clearTimeout(rebuildTimer); rebuildTimer = null; }
      regenerate();
      // 조립 효과만 측정하려면 부재별 '기본' scale.y(일부 부재는 1이 아님) 대비 비율로 봐야 한다.
      const base = new Map();
      building.traverse((o) => base.set(o, o.scale.y));
      playAssembly(building, { duration: REBUILD_ANIM_SEC }).seek(clamp01(t01));
      let minR = 1, maxR = 1;
      building.traverse((o) => { const b = base.get(o); if (b && Math.abs(b) > 1e-6) { const r = o.scale.y / b; minR = Math.min(minR, r); maxR = Math.max(maxR, r); } });
      return { t: t01, minScaleY: +minR.toFixed(3), maxScaleY: +maxR.toFixed(3) };
    },
    // 검증용: rebuild 두부 조립 재생 중 여부(디바운스 setParam 이 flat 스왑이 아니라 조립을 태우는지).
    __debugAssemblyActive: () => !!assembly,

    // ---------- 마을 모드 ----------
    village: {
      enter: (opts, seed) => enterVillage(opts, seed),
      // 마을 우선 진입(#62): 마을 진입 + 종가 클로즈업 랜딩 + 조립. 기본 인터랙티브 부팅에서 호출.
      enterHero: (opts, seed, cb) => enterVillageHero(opts, seed, cb),
      // 모드 일원화(#59): '집' 토글 = 종가 클로즈업 돌리 / 부감 복귀는 return.
      focusHero,
      // 리플레이(#59·#92 일반화): 현재 focus 중인 필지를 다시 조립(종가 한정 해제).
      replay: replayFocus,
      // 임의 필지 focus(모드 토글 '집'은 종가 focusHero, 클릭·줌은 이 경로) — 검증·프로그램 진입.
      focus: (id) => { if (village.active && !village.transitioning && !village.wave && !village.selected) villageSelect(id); },
      heroId: () => village.handle?.heroParcelId?.() ?? null,
      // focus 중 여부(App 이 再 버튼 노출·모드 판단) — selected 이면서 전환 완료 상태.
      focused: () => !!(village.active && village.selected),
      exit: exitVillage,
      escape: villageEscape,
      return: villageReturn,
      // 사전 생성(#46): 히어로 재생 중 App 이 호출 → 기본 시드 마을을 미리 만들어 hidden 보관.
      preload: (opts, seed) => preloadVillage(
        opts ? { ...village.opts, ...opts } : village.opts,
        seed != null ? seed >>> 0 : village.seed),
      // 다음 enter/setOpts 가 무생성(즉시)인지 — App 이 먹 안개 마스킹 필요 여부 판단.
      isReady: (opts, seed) => villageReady(
        opts ? { ...village.opts, ...opts } : village.opts,
        seed != null ? seed >>> 0 : village.seed),
      // 마을 옵션 변경(규모·성격·궁·절) → 재생성 + 부감 재프레이밍. 궁은 capital·hanyang 만 유효(그 외 무시).
      setOpts(partial = {}) {
        if (partial.scale && partial.scale !== 'capital' && partial.scale !== 'hanyang') partial = { ...partial, includePalace: false };
        Object.assign(village.opts, partial);
        if (village.active) {
          village.selected = null; village.transitioning = false; village.zoomCand = null;
          buildVillage();
          setPostFocus(false);
          const f = villageAerial();
          tweenTo(f.pos, f.target, 1.0, { fov: f.fov, onDone: () => setZoomRegime('aerial') });
          emit('villageMode', true);
        }
      },
      // 즉시 리롤(먹 안개 마스킹 경로 — 검증·폴백용). 마을 UI 는 rerollWave(#56 연출)를 쓴다.
      reroll() {
        village.seed = newSeed();
        if (village.active) {
          village.selected = null; village.transitioning = false; village.zoomCand = null;
          buildVillage();
          setPostFocus(false);
          const f = villageAerial();
          tweenTo(f.pos, f.target, 1.0, { fov: f.fov, onDone: () => setZoomRegime('aerial') });
        }
        emit('villageSeed', village.seed);
        return village.seed;
      },
      // 리롤 웨이브(#56): 부감 유지·연출 재구성. 웨이브 진행 중 여부는 isWaving.
      rerollWave: () => startRerollWave(),
      isWaving: () => !!village.wave,
      // 필지 편집 반영(#48, 라이브 스로틀은 App). 정규 필지는 오버레이 단일 집 교체, 특수(종가·관아)는
      //   컴파운드 오버레이 재생성. 편집 시 오버레이가 새로 만들어져 근접 앰비언스 링 앵커가 스테일해지므로
      //   focus 중인 그 필지면 새 오버레이에 링을 재부착(정규·특수 모두 — #92 정규도 오버레이+링).
      rebuild: (id, params) => {
        const g = village.handle?.rebuildParcel(id, params);
        if (g && village.selected === id) attachFocusRing(g);
        return g;
      },
      getState: () => ({
        active: village.active, selected: village.selected, transitioning: village.transitioning,
        hover: hoverParcel,
        opts: { ...village.opts }, seed: village.seed,
        spec: villageSpec(village.selected),
        stats: village.handle?.plan?.stats || null,
        warnings: village.handle?.plan?.warnings || [],
      }),
      // 검증용: 필지 목록·화면 투영(플레이라이트 결정적 호버/클릭 좌표).
      debugParcels: () => (village.handle?.getPickProxies() || []).map((p) => ({
        parcelId: p.parcelId, hero: p.buildingSpec.hero, kind: p.buildingSpec.kind,
        heroStyle: p.buildingSpec.heroStyle || null, family: p.buildingSpec.family || null,
        editable: p.buildingSpec.editable === true })),
      // 검증용(#48): 좌표 클릭 대신 필지 id 로 직접 focus-in(돌리인+패널). 실사용 경로 villageSelect 재사용.
      debugFocus: (id) => { if (village.active && !village.transitioning && !village.selected) villageSelect(id); },
      // 검증용(#48): 편집 오버레이 바운딩 크기 — 편집 전후 비교로 지오 변화 정량 확인.
      debugOverlayBox: (id) => village.handle?.overlayBox?.(id) ?? null,
      // 검증용(#93): 씬 기하 드로우콜 수(궁 편집 전/후·재생성 회귀 계측). 컴포저 최종 패스가
      //   info.render.calls 를 1(풀스크린 쿼드)로 덮으므로, 후처리 없는 씬 1회 렌더로 실측한다.
      debugDrawCalls: () => { renderer.render(scene, camera); return renderer.info.render.calls; },
      debugScreenOf(parcelId) {
        const pr = village.handle?.getPickProxies().find((p) => p.parcelId === parcelId);
        if (!pr) return null;
        const c = pr.bbox.getCenter(new THREE.Vector3());
        const v = c.project(camera);
        const rect = renderer.domElement.getBoundingClientRect();
        return { x: rect.left + (v.x * 0.5 + 0.5) * rect.width, y: rect.top + (-v.y * 0.5 + 0.5) * rect.height, behind: v.z > 1 };
      },
      // 검증용(#80): 현재 부감 프레임이 지면(y=0)에 소비하는 월드 반경 실측. 화면 코너·변중점을 지면에
      // 레이캐스트 → 각 지점 중심거리(하늘 방향은 Infinity). frameMaxR=지면에 걸린 최대 반경, outerR=마을 외곽.
      debugFrameRadius() {
        const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
        const rc = new THREE.Raycaster(); const hit = new THREE.Vector3();
        const pts = { bl: [-1, -1], br: [1, -1], tl: [-1, 1], tr: [1, 1], bc: [0, -1], tc: [0, 1], lc: [-1, 0], rc: [1, 0] };
        const out = {}; let maxR = 0;
        for (const [k, [x, y]] of Object.entries(pts)) {
          rc.setFromCamera({ x, y }, camera);
          const p = rc.ray.intersectPlane(plane, hit);
          const r = p ? Math.hypot(p.x, p.z) : Infinity;
          out[k] = isFinite(r) ? +r.toFixed(0) : 'sky';
          if (isFinite(r) && r > maxR) maxR = r;
        }
        return { outerR: +villageOuterR().toFixed(0), frameMaxR: +maxR.toFixed(0), corners: out, aspect: +(camera.aspect || 0).toFixed(2) };
      },
      // 검증용(#92): 줌 연속체 시뮬 — 카메라 거리를 aerialDist 의 frac 배로 설정(휠/핀치 등가). parcelId 지정
      //   시 controls.target 을 그 필지로 조준해 화면중심 후보가 그것이 되게 한다. 다음 프레임 updateZoomContinuum
      //   이 임계 판정으로 자동 focus-in/out 을 트리거(실사용 게이트 경로). 반환: 설정된 카메라↔타깃 거리.
      debugDolly(frac, parcelId = null) {
        if (!village.active || village.transitioning || village.wave) return null;
        if (parcelId) { const pr = village.handle.getPickProxies().find((p) => p.parcelId === parcelId); if (pr) controls.target.copy(pr.worldCenter); }
        const d = (village.aerialDist || 150) * frac;
        const dir = new THREE.Vector3().subVectors(camera.position, controls.target);
        if (dir.lengthSq() < 1e-6) dir.set(0.2, 1, 1.9);
        dir.normalize();
        camera.position.copy(controls.target).addScaledVector(dir, d);
        camera.lookAt(controls.target); controls.update();
        return +camera.position.distanceTo(controls.target).toFixed(1);
      },
      debugContinuum: () => ({
        active: village.active, selected: village.selected, transitioning: village.transitioning,
        wave: !!village.wave, zoomCand: village.zoomCand,
        aerialDist: +(village.aerialDist || 0).toFixed(1),
        dist: +camera.position.distanceTo(controls.target).toFixed(1),
        enterDist: +((village.aerialDist || 0) * ZOOM_ENTER_FRAC).toFixed(1),
        exitDist: +((village.aerialDist || 0) * ZOOM_EXIT_FRAC).toFixed(1),
      }),
    },

    // 오디오 토글 (♪). 첫 호출 시 오디오 그래프 생성·재생.
    toggleAudio(onWanted) {
      const a = ensureAudio();
      a.start();
      a.setEnabled(onWanted);
      return onWanted;
    },

    // 엽서: 현재 뷰 → 낙관 합성 PNG. pixelRatio 2 로 승격 후 복구.
    postcard({ download = true } = {}) {
      const prev = renderer.getPixelRatio();
      const bump = prev < 2;
      if (bump) { renderer.setPixelRatio(2); resizeAll(); }
      const filename = `cheoma-${state.preset}-${state.seed}.png`;
      const url = capturePostcard(renderer, renderFrame, { title: 'cheoma', filename, download });
      if (bump) { renderer.setPixelRatio(prev); resizeAll(); }
      renderFrame();
      return url;
    },

    // ---------- 히어로 오프닝 ----------
    hero: {
      arm() {
        heroActive = true;                  // 감상 자동 회전 비활성
        building.visible = false;
        for (const w of wings) w.group.visible = false;
        // 마을 우선 진입(#62): 타이틀 동안 단일건물 날씨 입자를 억제한다. 시드가 비/눈을 뽑으면 타이틀
        // 구간에 원점(숨은 본채)에 입자가 스폰돼, 마을 랜딩 시작 후에도 잔류하며 부감에 튄다(오렌지 낙수
        // 줄무늬). state.weather 는 유지(마을 무드용) — 어댑터는 입자 대신 대기 틴트로만 반영.
        weatherRef?.setWeather('clear');
        cinematic.setProgress(0, 'reveal');
        ensureAudio(); audio.setBgmVolume(0);
      },
      enter({ onDone } = {}) {
        ensureAudio(); audio.start();
        // before 계측 토글: __heroLegacy 면 구버전(등속 reveal·6.6s 착공)으로 재현.
        const legacy = typeof window !== 'undefined' && !!window.__heroLegacy;
        const revealScale = legacy ? 1 : HERO_REVEAL_SCALE;
        const assembleDelay = legacy ? 6600 : HERO_ASSEMBLE_DELAY_MS;
        const assembleDur = legacy ? 5 : HERO_ASSEMBLE_DUR;
        // BGM 페이드인
        const t0 = performance.now(), durMs = 2500;
        if (typeof window !== 'undefined') { window.__heroEnterT = t0; window.__heroAssembleT = null; }
        const stepFade = () => {
          const k = Math.min(1, (performance.now() - t0) / durMs);
          audio?.setBgmVolume(k);
          if (k < 1) requestAnimationFrame(stepFade);
        };
        requestAnimationFrame(stepFade);
        cinematic.play('reveal', { timeScale: revealScale });
        // 착공(조립 시작)을 크게 앞당김 — 타이틀 페이드 직후 기단이 올라오기 시작(중단 시 취소).
        let assembleTimer = setTimeout(() => {
          assembleTimer = null;
          building.visible = true;
          for (const w of wings) w.group.visible = true;
          if (typeof window !== 'undefined') window.__heroAssembleT = performance.now() - t0;
          startAssembly(assembleDur);
        }, assembleDelay);
        // reveal 자연 종료·사용자 중단(cinematic 내장 interrupt) 감시 → 컨트롤 인계.
        let handed = false;
        const iv = setInterval(() => {
          if (handed) { clearInterval(iv); return; }
          if (!cinematic.isActive()) {
            handed = true;
            clearInterval(iv);
            if (assembleTimer) { clearTimeout(assembleTimer); assembleTimer = null; }
            building.visible = true;
            for (const w of wings) w.group.visible = true;
            audio?.setBgmVolume(1);
            heroActive = false;             // reveal 종료 → 유휴 시 자동 회전 재개 허용
            lastActivity = performance.now();
            onDone?.();
          }
        }, 150);
      },
      skip({ onDone } = {}) {
        cinematic.stop();
        building.visible = true;
        for (const w of wings) w.group.visible = true;
        if (assembly) { assembly.skip(); assembly = null; }
        for (const w of wings) { w.assembly?.skip?.(); w.assembly = null; }
        setAngle('three-quarter');
        ensureAudio(); audio.start();
        audio.setBgmVolume(1);
        onDone?.();
      },
    },

    resize: resizeAll,
    renderer, scene, camera,
    __controls: controls,   // 검증용: 프레임 단위 controls.target 샘플링
    dispose() {
      renderer.setAnimationLoop(null);
      removeEventListener('resize', resizeAll);
      focusRing.clear();
      if (village.handle) { village.handle.exitVillageMode({ scene, building, ground, env }); village.handle.dispose(); village.handle = null; }
      if (village.cache.handle) { village.cache.handle.dispose(); village.cache = { key: null, handle: null }; }
      renderer.dispose();
    },
  };

  // 스크린샷/디버그 훅 (playwright 검증용)
  window.__engine = controller;

  return controller;
}
