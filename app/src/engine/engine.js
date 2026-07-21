// cheoma 씬 엔진 — 프레임워크 무관 three.js 배선.
// src/main.js 데모 셸의 배선을 계승하되, lil-gui 대신 Svelte UI 가 구동하는
// 명령형 API 를 노출한다. 코어(../../../src)는 ES 모듈 그대로 import.
//
//   createEngine({ container }) → controller
//
// 렌더 경로는 플래그십 룩(env/post.js): Render → Grade/Rim → Bloom → Bokeh → Flare → Outline → Output.
// 히어로/조립/포스트카드/셔플/환경 훅은 코어 모듈을 직접 재사용한다.

import * as THREE from 'three';
import {
  PRESETS, buildBuilding, computeLayout, disposeBuilding, playAssembly, tofuBob, tofuScale,
} from '../../../src/api/building.js';
import {
  setupEnvironment, createFocusRing, setupNightGlow, setupWeather,
} from '../../../src/api/environment.js';
import {
  VILLAGE_LENS,
  dollyDistanceForFov,
  lensScaleForCamera,
  referenceFovForCamera,
  referenceVillageFov,
  setupCinematic,
  villageScreenDistanceForCamera,
} from '../../../src/api/cinematic.js';
import { setupAudio } from '../../../src/api/audio.js';
import { capturePostcard } from '../../../src/api/export.js';
import { compileSubtreeAsync } from '../../../src/api/rendering.js';
import {
  createRerollWave, createVillage, createVillageAsync,
} from '../../../src/api/village.js';
import { configFromSeed, paramsFor, newSeed } from '../lib/seed.js';
import { buildWings, disposeWing, wingCount, buildNextWing, ghostSpec } from './expansion.js';
import { buildingSpot, expandedBuildingSpot } from './camera-framing.js';
import { createCinematicRuntime } from './cinematic-runtime.js';
import { createPostRuntime } from './post-runtime.js';
import { createSceneRuntime } from './scene-runtime.js';
import { createViewShift } from './view-shift.js';
import { createVillageCameraRuntime } from './village-camera-runtime.js';

const DEG = Math.PI / 180;
const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);
const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOutCubic = (t) => 1 - Math.pow(1 - clamp01(t), 3);
// 머지 이동 곡선: 착지(IMPACT=0.5)까지 감속 도착하고 이후엔 제자리(두부 출렁이 마무리).
const moveArrive = (u) => (u >= 0.5 ? 1 : (1 - Math.pow(1 - u / 0.5, 3)));

// 히어로 오프닝 타이밍(#98 감동 복원). 착공은 타이틀 페이드 직후로 앞당기되, 조립을 "0에서 자라나는
// 집"으로 관람할 시간을 확보한다(#46 과압축 되돌림). 먹 안개는 조립 전반부에 앞당겨 걷혀(집이 먼저
// 드러남) 조립 후반이 맑게 보이고, 카메라는 그 동안 웅장하게 선회 줌인한다. 완료(≈8.2s)까지가 관람
// 구간 — 유휴 대기가 아니라 카메라·조립이 계속 움직이므로 첫 인터랙션 지연 체감이 낮다.
// window.__heroLegacy=true 면 구버전 타이밍(6.6s 착공·등속 reveal)으로 재현(before 계측).
const HERO_REVEAL_SCALE = 0.56;        // reveal 재생 배속(12s → ~6.7s) — 구 단일건물 hero.enter 경로 전용
const HERO_ASSEMBLE_DELAY_MS = 1100;   // enter 후 착공까지(타이틀 페이드 0.9s 직후 착공 동기)
const HERO_ASSEMBLE_DUR = 7.0;         // 조립 길이(완료 ≈8.1s) — 안개 걷힌 뒤 관람 구간 확보(4.8→7.0)
const HERO_REVEAL_HOLD = 0.5;          // 먹 안개 무대 유지 배율(이 진행도까지 짙게 → 조립 후반에 마을 개방)
const HERO_REVEAL_VEIL = 1.14;         // 랜딩 베일 강화(#87②) — 주변 먹안개 far 시작 깊이 배율(1=기본), 히어로 근접은 불변
const HERO_SPIN_RAD = 2.35;            // 랜딩 나선 선회량(라디안 ≈135°) — "멋있게 회전"(구 1.258→2.35)

// focus 전환 타임라인 통일(#92, mode-integration §5.5 원칙 3) — focus-in 은 카메라 돌리 + DoF 페이드 +
// 링 크로스페이드 + 패널 컨텍스트 모프를 "한 타임라인"으로 구동한다. 카메라 트윈이 그 클록의 권위 —
// tweenTo(onProgress)가 매 프레임 이즈드 k 를 흘려 App 패널과 DoF 강도를 같은 커브로 그린다. 초점은
// 의미 있는 필지 앵커의 카메라축 깊이에 고정하고, 링은 경계에서 set/clear(내부 페이드는 env 소유).
const FOCUS_IN_DUR = 1.9;              // 둘러보기→집 돌리인(명시적 선택 + 패널 모프)
const FOCUS_OUT_DUR = 1.7;             // 근접→부감 돌리아웃(역재생)
const FOCUS_HOP_DUR = 1.5;             // 집(A)→집(B) 직접 전환(#95) — 부감 미경유 측면 돌리(약간 더 짧게)
// #128 reveal 게이트 상한(ms): focus-in/hop 돌리 시작을 안전한 오버레이 셰이더 프리컴파일 완료에
//   묶되, 느린 GPU 에서 클릭→카메라 지연이 체감되지 않도록 이 상한까지만 기다린다(초과 시 그대로 시작 —
//   잔여 링크는 checkShaderErrors=false 로 논블록). 병렬 컴파일 미지원 환경에서는 program readiness가
//   즉시 완료되므로 사실상 대기 없음(현행 타이밍 보존).
const REVEAL_WARM_CAP_MS = 200;
export function createEngine({ container, perf = false, compact = false } = {}) {
  // 모바일 성능 프로파일. perf: 터치/좁은 뷰포트(폰·태블릿) → DoF off·그림자맵 하향.
  // compact: 폰급(최소변 ≤520) → pixelRatio 1.5·저해상 bloom(필레이트 절감). 데스크톱은 무변.
  const PR_CAP = compact ? 1.5 : 2;
  const SHADOW_SIZE = compact ? 1536 : perf ? 2048 : 4096;
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
  let disposed = false;
  let P = {}; // 현재 파라미터

  // ---------- 렌더러 / 씬 / 카메라 ----------
  const { renderer, scene, sun, hemi, ground, camera, controls } = createSceneRuntime({
    container,
    pixelRatioCap: PR_CAP,
    shadowSize: SHADOW_SIZE,
  });
  // #128 전환 프리징 본체: three 는 신규 프로그램 첫 렌더(onFirstUse)마다 checkShaderErrors 가 켜져 있으면
  //   getProgramInfoLog + LINK_STATUS 를 조회해 GPU 링크 완료를 메인스레드에서 동기 대기한다(KHR_parallel_
  //   shader_compile 가 있어도 이 조회가 병렬성을 무력화). focus-out/in·hop 전환마다 대량 신규 프로그램이
  //   생겨 이 조회가 압도적 셀프타임(focus-out ~1.6s)이 된다. 부팅 초기 컴파일 동안은 true 로 두어 개발 중
  //   셰이더 에러 가시성을 보존하고(첫 마을 draw 로 공유 셰이더 코드가 전부 검증됨), 첫 마을 예열 완료 후
  //   retireShaderErrorCheck() 가 1회 false 로 플립해 이후 런타임 전환의 첫 렌더를 논블록으로 만든다.
  // 감상 자동 회전(느린 궤도). 유휴일 때만 ease-in 으로 켜고, 조작·전환 중엔 정지.
  // autoRotate 기본값은 scene-runtime 이 켜고, 속도는 매 프레임 아래 램프로 제어한다.
  const ORBIT_SPEED = 0.33;                 // ≈ 3분/바퀴 (autoRotateSpeed 2.0=30초 기준)
  const ORBIT_IDLE_MS = 9000;               // 유휴 후 재개까지(8~12초 범위)
  const ORBIT_RAMP_SEC = 2.6;               // ease-in 램프 시간
  let orbitGain = 0;                        // 0..1 회전 강도(램프)
  let lastActivity = performance.now();     // 마지막 사용자 조작 시각
  let heroActive = false;                   // 히어로 시퀀스 진행 중 플래그
  // 히어로 역광 방위(#98 사용자 지시). 종가 랜딩 시 종가 배면(frontDir+180±) 쪽으로 태양 방위를 고정해,
  //   정측면에서 멈춘 카메라가 집을 역광으로 보게 한다(처마 실루엣 골든 림). 태양 고도·색은 시간대(석양)
  //   그대로 두고 방위만 매 프레임 회전(env sky 가 sun.position 을 세팅한 뒤 덮어씀). null=미적용(비히어로).
  let heroSunAz = null;

  // ---------- 그림자 정적 캐시(#140-A) ----------
  //   sun.shadow.camera 는 원점 고정 ±22 ortho(위 설정, 어디서도 카메라를 따라 이동·리사이즈하지
  //   않음) → 카메라 궤도·줌·팬·트윈·walk 는 그림자 맵을 바꾸지 않는다. 정적 부감/정적 focus 에서
  //   매 프레임 shadowMap 을 재렌더하면 중앙 박스 캐스터(≈240콜/프레임)를 헛제출한다. 그래서 부팅
  //   예열 후 shadowMap.autoUpdate=false 로 두고, 아래 조건에서만 needsUpdate 를 1프레임 세운다:
  //     · shadowHot 창(setTime/재생성 등 태양방향·지오 변동 후 일정 시간)
  //     · 조립·리롤 웨이브·머지 두부·데모(walk/drone)·카메라 트윈 등 지오/무대가 움직이는 프레임
  //     · focus 중(선택 필지): 링 동물·연기 그림자 저빈도(≈10Hz) 갱신
  //   그 외 정적 프레임엔 그림자 패스 제출 0. (three 는 shadow 렌더 후 needsUpdate 를 자동 false 로.)
  let shadowCacheOn = false;              // 부팅 예열 후 true → autoUpdate=false 캐시 모드 개시
  let shadowHot = 0;                      // performance.now() 이 값 미만이면 매 프레임 그림자 갱신
  const bumpShadow = (ms = 1800) => { shadowHot = Math.max(shadowHot, performance.now() + ms); };

  const activityEvents = ['pointerdown', 'pointermove', 'wheel', 'keydown', 'touchstart'];
  const markActivity = () => { lastActivity = performance.now(); };
  for (const ev of activityEvents) {
    addEventListener(ev, markActivity, { passive: true });
  }

  // ---------- 건물 + 날개(wing) ----------
  let building = null;
  let wings = [];         // [{ group, assembly }]
  let weatherRef = null, nightGlowRef = null, audio = null;
  let bootAudioWarmed = false;   // #140-D 부팅 리빌 정착 후 현재 트랙 프리페치 1회 게이트
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
    // ── 보기별 줌 범위(#14) ──
    aerialDist: 0,          // 46° 부감의 실제 카메라↔중심 거리(villageAerial 갱신)
    aerialReferenceDist: 0, // 42° 화면 등가 거리 — 광각/망원 줌 범위의 공통 기준
    // ── 리롤 웨이브(#56 배선) ──
    wave: null,     // { anim, oldHandle, newHandle, seed } — 진행 중 재구성 웨이브(입력 잠금)
    waveBuild: null, // 비동기 incoming handle 준비 토큰 — active wave 전에도 입력은 잠그되 최신 토큰 교체는 허용
  };
  // 워커가 새 핸들을 만드는 구간도 화면상 하나의 웨이브 수명이다. 애니메이션 여부(village.wave)와
  // 상호작용 busy 여부를 분리해, latest-wins 토큰 교체는 보존하면서 focus/줌 레이스만 닫는다.
  const villageWaveBusy = () => !!(village.wave || village.waveBuild);
  function forEachPresentedVillageHandle(fn) {
    if (!village.active) return 0;
    const current = village.handle;
    const incoming = village.wave?.newHandle;
    let count = 0;
    if (current) { fn(current); count++; }
    if (incoming && incoming !== current) { fn(incoming); count++; }
    return count;
  }
  let hoverParcel = null;     // 마을 호버 중 필지 id(하이라이트 토글 최소화)
  let lastHoverT = 0;         // 호버 레이캐스트 스로틀(~30Hz)
  let villageCamera;

  // 마을 드론·보행 데모는 독립 상태기계가 소유한다. 아래 콜백은 씬 전환 정책만 주입한다.
  const demoRuntime = createCinematicRuntime({
    camera,
    cancelTween: () => { tween = null; },
    controls,
    village,
    focusOutDuration: FOCUS_OUT_DUR,
    clearHover: () => {
      if (!hoverParcel) return;
      village.handle?.highlightParcel(hoverParcel, false);
      hoverParcel = null;
    },
    emit,
    getAerial: () => villageAerial(),
    markActivity,
    reapplyVillageFog: () => reapplyVillageFog(),
    returnFromFocus: () => villageReturn(),
    setPostFocus,
    setZoomRegime: (mode, distance) => setZoomRegime(mode, distance),
    settleControls,
    stopHeroDrive: () => cinematic.stop(),
    tweenTo,
  });
  const demo = demoRuntime.state;

  function regenerate() {
    bumpShadow(1500);   // #140-A 단일건물 재생성: 원점 근처 지오 교체 → 그림자 갱신
    if (assembly) { assembly.skip(); assembly = null; }
    for (const w of wings) { w.assembly?.skip?.(); scene.remove(w.group); disposeWing(w); }
    wings = [];
    if (building) { scene.remove(building); disposeBuilding(building); }

    building = buildBuilding(P);
    scene.add(building);

    // 확장(칸 들이기): 현재 스텝에 맞는 날개들을 붙인다.
    if (state.expansion > 1) {
      wings = buildWings(P, state.expansion).map((w) => {
        scene.add(w.group);
        return { group: w.group, assembly: null };
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
  let env = setupEnvironment(scene, { sun, hemi, renderer, layout: computeLayout(PRESETS.korea) });
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
  
  function updateWeatherColliders() {
    if (!weatherRef) return;
    const boxes = [];
    if (village.active && village.handle) {
      const proxies = village.handle.getPickProxies() || [];
      for (const pr of proxies) {
        if (pr.bbox) {
          const box = pr.bbox.clone();
          // 지붕 영역: 처마 아래 기단 상면부터 지붕 위 2m 높이까지 충돌 영역으로 설정
          box.min.y = Math.max(box.min.y, box.max.y - 4.5);
          box.max.y += 2.0;
          boxes.push(box);
        }
      }
    } else if (building && building.visible) {
      const layout = building.userData.layout || computeLayout(P);
      const xE = layout.xEave ?? 9, zE = layout.zEave ?? 6;
      const topY = layout.eaveEdgeY ?? 6.5;
      const box = new THREE.Box3(
        new THREE.Vector3(-xE, topY, -zE),
        new THREE.Vector3(xE, topY + 8.0, zE)
      );
      boxes.push(box);
    }
    weatherRef.setRoofColliders(boxes);
  }
  updateWeatherColliders();

  nightGlowRef = setupNightGlow({ getBuilding: () => building });

  // ---------- 플래그십 후처리 (메인 룩) ----------
  // 모바일은 DoF/flare를 끄고, compact는 bloom 내부 타깃을 반해상도로 유지한다.
  const postRuntime = createPostRuntime({
    renderer,
    scene,
    camera,
    width: container.clientWidth,
    height: container.clientHeight,
    perf,
    compact,
  });
  const { post, outline, dofOn } = postRuntime;

  function reapplyEnvBase(opts) {
    env.setTime(state.time, opts); // sky.apply → fog/bg/exposure/조명
  }
  function refreshAtmosphere() {
    weatherRef?.applyAtmosphere({ mode: 'pbr' });
  }

  // ---------- 카메라 프레이밍 ----------
  function setAngle(name) {
    const { pos, target } = buildingSpot(name, computeLayout(P));
    camera.position.copy(pos);
    controls.target.copy(target);
    controls.update();
  }

  // 선택/확장 포커스 프레이밍 — 마당(날개 포함) 전체가 들어오도록 확장 단계에 따라 넓힌다.
  function focusFraming() {
    return expandedBuildingSpot(computeLayout(P), state.expansion);
  }

  // 카메라 트윈(선택 포커스·해제·마을 돌리인/아웃). 진행 중이면 매 프레임 lerp.
  //   opts.fov 지정 시 화각도 함께 보간(광각 부감 46 ↔ 망원 필지 20). opts.dofAnchor 는 전환 중 의미 있는
  //   월드 초점점을 고정한다. 생략하면 보간 중인 controls.target(항상 화면 앞)을 따라가며, opts.dofAmount 는
  //   현재 강도에서 목표값까지 단조 보간한다.
  //   opts.onDone 은 도착 콜백(마을 도착 시 편집 패널 슬라이드 인 등).
  let tween = null;
  function tweenTo(pos, target, dur = 0.95, {
    fov, referenceFov, onDone, onProgress, dofAnchor = null, dofAmount = null,
  } = {}) {
    cinematic.stop();
    const currentReferenceFov = referenceFovForCamera(camera);
    const changesLens = Number.isFinite(fov) || Number.isFinite(referenceFov);
    tween = {
      p0: camera.position.clone(), p1: pos.clone(),
      t0: controls.target.clone(), t1: target.clone(),
      f0: camera.fov, f1: fov ?? camera.fov,
      r0: currentReferenceFov,
      r1: Number.isFinite(referenceFov)
        ? referenceFov
        : (Number.isFinite(fov) ? referenceVillageFov(fov) : currentReferenceFov),
      changesLens,
      dur, e: 0, onDone, onProgress,
      dofAnchor: dofAnchor?.clone?.() || null,
      dof0: post.dof.amount,
      dof1: Number.isFinite(dofAmount) ? clamp01(dofAmount) : null,
      // 검증 토글(before/after 계측용). window.__flowNoFix=true 면 이번 트윈은 방향 연속화·핸드오프
      // 리셋을 끈다(구버전 버그 재현). 미설정=수정본. 트윈 시작 시 1회만 읽어 핫 루프 오염 방지.
      noFix: typeof window !== 'undefined' && !!window.__flowNoFix,
    };
  }

  const bokehPass = post.bokehPass;
  let dofTargetDepth = post.dof.focus;

  // 트윈 핸드오프용 — OrbitControls 관성(회전 _sphericalDelta·팬 _panOffset·줌 _scale)을 0 으로.
  // three 0.185 인스턴스 필드 직접 리셋(공개 stop() 이 없어 이게 표준 패턴): 전환 중 사용자
  // 드래그/휠이 남긴 momentum 이 트윈 종료 직후 첫 update() 에 한꺼번에 적용되며 튀는 것 방지.
  function settleControls() {
    controls._sphericalDelta?.set(0, 0, 0);
    controls._panOffset?.set(0, 0, 0);
    controls._scale = 1;
  }

  // ---------- 뷰포트 중심 보정(#124) — 패널 점유 시 피사체를 "가시 영역" 중심으로 ----------
  // 데스크톱 좌측 컨텍스트 카드(.ctxcard)·우측 패널(.panel)·모바일 하단 시트(.sheet)가 화면을 가리면,
  //   그 반대편(패널이 없는 가시 영역)의 중심에 피사체가 오도록 camera.setViewOffset 으로 프러스텀만
  //   비대칭 시프트한다. 카메라 위치·시선·프레이밍은 불변 — 오직 투영(projectionMatrix)만 민다. 그래서
  //   레이캐스트(setFromCamera)·DoF 초점(거리)·FlarePass 태양 투영이 모두 같은 offset 행렬을 경유해
  //   자동 정합한다(별도 보정 불필요). cur/tgt 는 "피사체 화면 시프트 px": curX>0=오른쪽, curY>0=위.
  //   프러스텀 매핑은 offsetX=-curX(축 point NDC=+2·curX/W → 오른쪽), offsetY=+curY(NDC=+2·curY/H → 위).
  // 데모·리롤·히어로 연출 중에는 홀드하고, focus 트윈 중에는 패널 모프와 함께 추종한다.
  const viewShiftRuntime = createViewShift({
    container,
    camera,
    isBusy: () => !!(demo.active || villageWaveBusy() || village.heroAsm || heroActive),
  });
  const viewShift = viewShiftRuntime.state;

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
  const activeDofAnchor = () => tween?.dofAnchor || controls.target;

  function debugDofState() {
    const anchorDepth = post.dof.depthAt(activeDofAnchor());
    return {
      enabled: post.dof.enabled,
      amount: post.dof.amount,
      focus: post.dof.focus,
      aperture: bokehPass.uniforms.aperture.value,
      baseAperture: post.dof.aperture,
      maxBlur: bokehPass.uniforms.maxblur.value,
      bokehSamples: bokehPass.bokehSampleCount,
      highlightThreshold: bokehPass.uniforms.highlightThreshold.value,
      highlightGain: bokehPass.uniforms.highlightGain.value,
      bokehRadiusScale: bokehPass.uniforms.bokehRadiusScale.value,
      fov: camera.fov,
      anchorDepth,
      error: anchorDepth == null ? null : Math.abs(post.dof.focus - anchorDepth),
      depthExcluded: bokehPass.depthExcludedCount,
      depthDithered: bokehPass.depthDitheredCount,
      tweenProgress: tween ? clamp01(tween.e / tween.dur) : null,
      anchored: !!tween?.dofAnchor,
    };
  }

  function renderFrame(postDt) {
    if (dofOn && post.dof.amount > 0) {
      // Bokeh focus는 유클리드 거리가 아니라 카메라 시선축(view-space -Z) 깊이다. 전환 앵커가
      // 화면 중심 밖에 있어도 post가 그 축 깊이를 계산해 선택 집의 초점면을 정확히 유지한다.
      dofTargetDepth = post.setFocusPoint(activeDofAnchor());
    }
    post.update(postDt);
    post.composer.render();
  }

  // Camera-dependent environment policy has one owner so the live frame and focused
  // regression harness cannot drift. `frameDetailLod` is available inside village mode;
  // mode handoffs deliberately fall back to the camera's named lens metadata.
  function syncCameraDependentEnvironment(frameDetailLod = null) {
    const physicalDistance = camera.position.distanceTo(controls.target);
    const physicalAltitude = Math.max(0, camera.position.y - controls.target.y);
    const visualDistance = frameDetailLod?.visualDistance
      ?? villageScreenDistanceForCamera(physicalDistance, camera);
    const visualAltitude = frameDetailLod?.visualAltitude
      ?? villageScreenDistanceForCamera(physicalAltitude, camera);
    const lensScale = frameDetailLod?.lensScale ?? lensScaleForCamera(camera);
    weatherRef.setWeatherCenter?.(
      controls.target.x,
      controls.target.z,
      physicalDistance,
      visualAltitude,
      frameDetailLod?.particleWeight,
      visualDistance,
      lensScale,
    );
    env.setLensScale?.(lensScale);
    return { physicalDistance, physicalAltitude, visualDistance, visualAltitude, lensScale };
  }

  // 카메라·시선·화각·DoF·패널 모프는 하나의 순수한 진행도 적용 경로를 공유한다. 런타임은
  // advanceCameraTween 이 시간을 진행시키고, 검증은 debugSeekDofTween 이 같은 경로를 정지 샘플링한다.
  // 두 구현이 갈라지면 테스트가 실제 전환을 검증하지 않게 되므로 별도 "테스트용 보간"을 만들지 않는다.
  function applyCameraTween(active, progress) {
    const k = easeInOutCubic(clamp01(progress));
    if (active.arc) {
      // 종가 랜딩 나선 궤도(#98②) — 타깃 수직축 둘레 극좌표 보간. 각속도 일정(이즈드), 반경은
      // 단조 감소(줌인)라 궤도가 집 쪽으로 파고들지 않는다(중간 휩 팬 없음). 높이도 함께 하강.
      const A = active.arc;
      const a = A.a0 + (A.a1 - A.a0) * k;
      const r = A.r0 + (A.r1 - A.r0) * k;
      const y = A.y0 + (A.y1 - A.y0) * k;
      camera.position.set(A.cx + Math.sin(a) * r, y, A.cz + Math.cos(a) * r);
    } else {
      camera.position.lerpVectors(active.p0, active.p1, k);
    }
    controls.target.lerpVectors(active.t0, active.t1, k);
    // 위치·타깃과 함께 시선 방향도 매 프레임 연속 갱신한다. OrbitControls.update() 는 트윈 중
    // 게이트로 스킵되므로 여기서 직접 바라보게 해 종료 프레임의 방향 스냅을 막는다.
    if (!active.noFix) camera.lookAt(controls.target);
    if (active.f1 !== active.f0) {
      camera.fov = active.f0 + (active.f1 - active.f0) * k;
      camera.updateProjectionMatrix();
    }
    // FOV alone cannot identify landmark profiles (for example palace 24° keeps
    // the former 32° composition). Interpolate the explicit reference lens with
    // the camera so LOD and zoom thresholds see the same projected scale.
    // Manual cinematic tweens may carry r0/r1 directly; an explicit false is the
    // position-only contract. This default keeps authored arc lenses safe if a caller
    // omits the convenience flag while still preventing plain house tweens from leaking
    // village metadata.
    if (active.changesLens !== false && Number.isFinite(active.r0) && Number.isFinite(active.r1)) {
      camera.userData.villageReferenceFov = active.r0 + (active.r1 - active.r0) * k;
    }
    if (active.dof1 != null) post.setDofAmount(active.dof0 + (active.dof1 - active.dof0) * k);
    active.onProgress?.(k);   // 패널 컨텍스트 모프 등 — 카메라와 동일 클록(#92 타임라인 통일)
    return k;
  }

  function finishCameraTween(active) {
    if (tween !== active) return;
    // 핸드오프: OrbitControls 관성(회전/팬/줌 잔류)을 0 으로 리셋해 다음 update() 가 스냅·lurch
    // 없이 현재 지오메트리에서 재개하도록(자동 회전도 0속도 시작 보장).
    if (!active.noFix) settleControls();
    const cb = active.onDone;
    tween = null;
    cb?.();
  }

  function advanceCameraTween(dt) {
    const active = tween;
    if (!active) return;
    active.e = Math.min(active.dur, active.e + dt);
    applyCameraTween(active, active.e / active.dur);
    if (active.e >= active.dur) finishCameraTween(active);
  }

  // 회귀 하네스용 결정적 seek. 컴포저를 수백 프레임 돌리지 않고 실제 제품 트윈을 같은 진행도에서
  // 샘플링한다. finish=true·progress=1 이면 실제 onDone까지 실행해 다음 전환을 이어갈 수 있다.
  function debugSeekDofTween(progress, { finish = false } = {}) {
    const active = tween;
    if (!active) return null;
    const p = clamp01(progress);
    active.e = active.dur * p;
    const easedProgress = applyCameraTween(active, p);
    camera.updateMatrixWorld(true);
    if (dofOn && post.dof.amount > 0) dofTargetDepth = post.setFocusPoint(activeDofAnchor());
    const sampled = debugDofState();
    if (finish && p >= 1) finishCameraTween(active);
    return { ...sampled, easedProgress, finished: tween !== active };
  }

  function resizeAll() {
    const w = container.clientWidth, h = container.clientHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    postRuntime.resize(w, h);
    viewShiftRuntime.invalidate();   // #124: 새 뷰포트 dims 로 setViewOffset 재적용 강제
  }
  addEventListener('resize', resizeAll);

  let frames = 0;
  const clock = new THREE.Clock();
  let debugPaused = false;
  renderer.setAnimationLoop(() => {
    const elapsed = clock.getDelta();
    if (debugPaused) return;
    const dt = Math.min(elapsed, 0.05);
    advanceCameraTween(dt);
    cinematic.update(dt);
    if (demo.active) updateDemo(dt);                                           // 시네마틱 데모 카메라 구동(#112)
    if (assembly && assembly.update(dt)) assembly = null;
    for (const w of wings) if (w.assembly && w.assembly.update(dt)) w.assembly = null;
    if (village.heroAsm && !village.asmFrozen && village.heroAsm.update(dt)) village.heroAsm = null;   // 종가 랜딩/리플레이 조립 (#126 asmFrozen=검증 정지)
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
    // 단, 마을 모드에서 조립 중(village.heroAsm)일 때는 자동 선회 연출을 허용합니다.
    const orbitBusy = (heroActive && !village.heroAsm) || assembly || groupAnims.length > 0 ||
      wings.some((w) => w.assembly) || cinematic.isActive() || tween || state.selected || demo.active ||
      (village.active && village.selected && !village.heroAsm) || villageWaveBusy();

    let curRotateSpeed = ORBIT_SPEED;
    if (village.active && village.heroAsm) {
      // 조립 중 회전 (모바일/저사양 제외, 회전각 체감을 높이기 위해 약간 더 빠르게 선회)
      curRotateSpeed = perf ? 0 : ORBIT_SPEED * 5.2;
    }

    if (!orbitBusy && performance.now() - lastActivity > ORBIT_IDLE_MS) {
      orbitGain = Math.min(1, orbitGain + dt / ORBIT_RAMP_SEC);
    } else {
      orbitGain = 0; // 조작·전환 시 즉시 일시정지
    }
    const g = orbitGain * orbitGain * (3 - 2 * orbitGain); // smoothstep ease-in
    // 조립 중에는 유휴 타이머(orbitGain)에 구애받지 않고 무조건 웅장한 선회를 관철함
    controls.autoRotateSpeed = village.heroAsm ? curRotateSpeed : (curRotateSpeed * g);
    // dt 를 넘겨 autoRotate 를 프레임레이트 독립으로 — 무인자 update() 는 60fps 를 가정한
    // 프레임당 고정 회전이라 120Hz 디스플레이에서 2배 빨라진다(주기 스펙 이탈). dt 경로는
    // 초당 회전량이 (2π/60·speed) 로 고정되어 주기 60/speed 초가 주사율과 무관하게 유지된다.
    if (!cinematic.isActive() && !tween && !demo.active) controls.update(dt);   // 데모 중 카메라는 updateDemo 소유
    const settledFocusAmount = village.active && village.selected && !village.transitioning && !tween
      ? villageCamera.updateFocusContext() : null;
    // #14: 집 선택은 줌아웃으로 풀리지 않지만 근경 보케까지 넓은 마을 문맥에 남아서는 안 된다.
    // 화면 등가 거리를 따라 1→0으로 줄여 가까운 집의 원형 보케는 보존하고, 넓은 집 보기에서는
    // Bokeh pass를 완전히 쉬게 한다. focus-in/out/hop 중에는 카메라 tween이 amount를 단독 소유한다.
    if (settledFocusAmount != null && !perf) post.setDofAmount(settledFocusAmount);
    // 카메라/시선 셀 LOD는 이 프레임에 한 번만 계산한다. weather·focus·동물·필지 필드가
    // 같은 ground/particle weight를 소비해 서로 다른 거리에서 팝하지 않게 한다.
    let frameDetailLod = null;
    let lodSwaps = 0;
    if (village.active && village.handle) {
      lodSwaps = village.handle.updateLod(camera, controls.target, dt);
      frameDetailLod = village.handle.detailLodState?.() || null;
      // 웨이브 중 새 마을도 현재 카메라로 계속 샘플한다. 규모 reframe 동안 FAR/MID/FULL과
      // 지상 동물이 옛 카메라 상태에 고정됐다가 승격 직후 팝하지 않게 한다.
      if (village.wave?.newHandle) {
        lodSwaps += village.wave.newHandle.updateLod(camera, controls.target, dt);
      }
    }
    // 하늘 입자(눈·비) 낙하 필드를 시선(카메라 타깃)으로 이설 — 마을 부감·종가 클로즈업·랜딩 등
    //   원점을 벗어난 뷰에서도 "보는 곳에 눈/비"가 오게(#98). 단일건물은 타깃≈원점이라 사실상 무변.
    // Fade/spread use former-FOV equivalent distance; point size separately uses
    // the physical/visual ratio so a compensated lens dolly remains pixel-stable.
    syncCameraDependentEnvironment(frameDetailLod);
    weatherRef.update(dt);
    env.update(dt);
    // 히어로 역광 방위 고정(#98) — env sky 가 매 프레임 sun.position 을 시간대 방향으로 세팅한 직후,
    //   방위만 종가 배면으로 회전(고도·거리 보존). 마을 활성 + 히어로 방위 확정 시. sun.target=원점 고정이라
    //   position 회전만으로 그림자·rim(post uSunViewDir)·flare 가 일관되게 역광으로 정렬된다.
    if (village.active && heroSunAz != null) {
      const sp = sun.position;
      const hmag = Math.hypot(sp.x, sp.z);
      if (hmag > 1e-4) { sp.x = Math.sin(heroSunAz) * hmag; sp.z = Math.cos(heroSunAz) * hmag; }
    }
    nightGlowRef.update(dt);
    // LOD가 활성화한 애니메이션만 갱신한다. 청크/overlay caster 소유권 변화도 같은 프레임에
    // 그림자 캐시를 무효화한다.
    if (village.active && village.handle) {
      if (lodSwaps && shadowCacheOn) renderer.shadowMap.needsUpdate = true;
      village.handle.update(dt);   // 개울 물결·야간 촛불·LOD로 활성화된 동물
      village.wave?.newHandle?.update(dt);   // 조립 중 새 마을의 물·하늘 새 떼도 정지하지 않는다.
    }
    // 리롤 웨이브(#56) — 옛 건물 방사 해체 → 먹안개 peak scenery handoff → 새 건물 방사 조립.
    // 코어는 재질을 건드리지 않고 veil/shadow weight만 내보내며, 앱이 fog·태양 그림자를 표현한다.
    if (village.wave) {
      const activeWave = village.wave;
      const finished = !activeWave.debugPaused && activeWave.anim.update(dt) >= 1;
      applyVillageWavePresentation(activeWave);
      if (finished) finishRerollWave();
    }
    focusRing.update(
      dt,
      state.time,
      village.active ? (frameDetailLod || { groundWeight: 0, particleWeight: 0 }) : 1,
    );                                                                 // 앰비언스 근접 링(#79)
    // 진입 먹 안개 reveal: fog 를 짙게(near/far 좁게) 시작해 base(R비례)로 풀어 마을이 드러남.
    //   hold 구간 동안은 짙은 먹안개를 유지(히어로 단독 무대감) → 이후 easeOut 으로 마을을 연다.
    if (village.active && village.reveal && scene.fog && village.handle) {
      village.reveal.e += dt;
      const k = clamp01(village.reveal.e / village.reveal.dur);
      const hold = village.reveal.hold || 0;
      const e = easeOutCubic(hold < 1 ? clamp01((k - hold) / (1 - hold)) : 0);
      const R = village.handle.plan.site.R;
      const veil = village.reveal.veil || 1;  // #87② 랜딩 베일 강화(주변 far 만 깊게, near 불변)
      scene.fog.near = R * (0.5 + 1.7 * e);            // 0.5R(짙음) → 2.2R(base) — 히어로 근접은 늘 맑게
      scene.fog.far = R * (7.0 - 4.4 * veil * (1 - e)); // veil=1: 2.6R → 7.0R(base). veil>1: 시작 더 짙음
      if (k >= 1) {
        village.reveal = null;
        // #140-D 부팅 리빌 정착 직후 오디오를 생성하고 현재 시간대 트랙을 프리페치(fetch+decode)해 둔다 →
        //   사용자가 사운드를 처음 켤 때 대기 없이 즉시 재생. 유휴 콜백으로 실행해 리빌 종료 프레임을 방해하지
        //   않는다(부팅 임계 경로엔 mp3 0 — 프리페치는 여기 정착 이후 발생). 1회만.
        if (!bootAudioWarmed) {
          bootAudioWarmed = true;
          const warm = () => { if (disposed) return; try { ensureAudio()?.prefetchCurrentTrack?.(); } catch {} };
          if (typeof requestIdleCallback === 'function') requestIdleCallback(warm, { timeout: 3000 });
          else setTimeout(warm, 500);
        }
      }
    }
    audio?.update(dt);
    // #145 부감 z-fight: 카메라↔타깃 거리 종속 near 램프(부감=큰 near로 원거리 깊이정밀도 확보,
    //   근접=작은 near로 근경 클리핑 없음). 보기 안 줌·트윈 중 매 프레임 부드럽게 추종(팝 없음).
    //   walk/drone(demo)은 자체 near(0.08) 관리라 제외. 변화 미미하면 updateProjectionMatrix 생략(정적 부감 무비용).
    //   viewShiftRuntime.update 직전에 둬 offset 재적용이 새 near 위에 얹힌다(#124 정합).
    if (village.active && !demo.active) {
      const nn = villageNear();
      if (Math.abs(nn - camera.near) > 1e-3) { camera.near = nn; camera.updateProjectionMatrix(); }
    }
    viewShiftRuntime.update(dt);   // 뷰포트 중심 보정(#124) — 투영만 시프트
    // #140-A 그림자 재렌더 게이트 — autoUpdate=false 캐시 모드에서만 관여(그 전엔 매 프레임 자동).
    if (shadowCacheOn) {
      // 무대/지오가 움직이는 프레임: 조립 낙하·리롤 웨이브·머지 두부·데모(walk/drone)·카메라 트윈.
      //   (heroAsm·assembly·groupAnims 은 위에서 이미 처리된 뒤라 이 시점 truthy = 진행 중.)
      const moving = !!tween || demo.active || village.wave || !!village.heroAsm || !!assembly || groupAnims.length > 0;
      if (moving || performance.now() < shadowHot) {
        renderer.shadowMap.needsUpdate = true;
      } else if (village.active && village.selected && (frames % 6) === 0) {
        // 정적 focus: 링 동물·연기 캐스터 그림자를 ≈10Hz 로 갱신(동결 방지). 정적 부감은 갱신 0.
        renderer.shadowMap.needsUpdate = true;
      }
    }
    renderFrame();
    frames++;
    if (frames === 3) window.__SHOT_READY = true;
  });

  // ---------- 호버/선택 (레이캐스트) ----------
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  villageCamera = createVillageCameraRuntime({
    camera,
    container,
    controls,
    scene,
    village,
  });
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
  function onCanvasPointerMove(e) {
    if (demo.active) return;                                   // 시네마틱 데모 중 호버 무시(#112)
    if (villageWaveBusy()) return;                              // 웨이브 빌드·애니 중 입력 무시(#56)
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
  }
  let downPos = null;
  function onCanvasPointerDown(e) {
    // 시네마틱 데모 중 캔버스 입력(#112): 드론(수동관람)은 탭/클릭 = 종료. 1인칭은 드래그가 시선 조작이라
    //   종료하지 않음(ESC·오버레이 종료 버튼으로만 나간다).
    if (demo.active) { if (demo.mode !== 'walk') stopDemo(); return; }
    downPos = { x: e.clientX, y: e.clientY };
    // 터치엔 호버가 없으므로 탭 시작 순간 미니 라벨을 잠깐 띄운다(선택 시 villageSelectStart 가 지움).
    //   focus 중에도 허용(#95) — 다른 필지 탭 예고(villageHover 가 현 focus 필지 자신은 제외).
    if (e.pointerType === 'touch' && village.active && !village.transitioning && !villageWaveBusy()) {
      lastHoverT = 0; villageHover(e.clientX, e.clientY);
    }
  }
  function onCanvasPointerUp(e) {
    ensureAudio()?.start();
    if (!downPos) return;
    const moved = Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y);
    downPos = null;
    if (moved > 6) return;             // 드래그(궤도 회전)는 선택으로 치지 않음
    if (village.active) {
      if (villageWaveBusy() || village.transitioning) return;     // 웨이브 빌드·애니·전환 중 클릭 무시
      const rect = renderer.domElement.getBoundingClientRect();
      ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(ndc, camera);
      const hit = village.handle.raycast(raycaster);
      if (!hit) return;
      if (village.selected) {
        // focus 중 다른 필지 클릭 = 부감 미경유 A→B 직접 전환(#95). 같은 필지 재클릭은 no-op.
        if (hit.parcelId !== village.selected) villageSwitch(hit.parcelId);
      } else {
        villageSelect(hit.parcelId);   // 둘러보기→집 focus-in: 집 클릭만 선택 상태를 바꾼다.
      }
      return;
    }
    const h = pick(e.clientX, e.clientY);
    if (h && !state.selected) { selectBuilding(); }
  }
  renderer.domElement.addEventListener('pointermove', onCanvasPointerMove);
  renderer.domElement.addEventListener('pointerdown', onCanvasPointerDown);
  renderer.domElement.addEventListener('pointerup', onCanvasPointerUp);
  // #14: 휠·핀치는 현재 보기 안에서 OrbitControls 거리만 바꾼다. 집 선택은 클릭/명시 API,
  //   둘러보기 복귀는 브레드크럼·ESC·모드 버튼만 소유해 거리 임계가 상태를 몰래 바꾸지 않는다.

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
    const { pos, target } = buildingSpot('three-quarter', computeLayout(P));
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
  const villageOuterR = (handle = village.handle) => villageCamera.outerRadius(handle);
  const villageAerial = (handle = village.handle) => villageCamera.aerial(handle);
  const setZoomRegime = (mode, closeupDist = 0) => villageCamera.setRegime(mode, closeupDist);
  const villageNear = () => villageCamera.near();
  const reapplyVillageFog = () => villageCamera.reapplyFog();

  // 배율별 후처리(mode-integration §5): 마을 부감은 RimPass(매 프레임 씬 노멀 재렌더)가 도성 규모에서
  // 60fps 위험이라 OFF. focus-in(집 근접)·단일건물 씬은 ON. rim OFF 시 FlarePass 가림 판정이 스테일
  // depth 로 오작동하므로 flare 도 동반 토글(모바일 perf 분기와 합성 — 한 곳에서 관리). 부감엔 flare 불필요.
  function setPostFocus(focused, dofAmount = focused ? 1 : 0) {
    post.setRimEnabled?.(focused);
    post.setFlareEnabled?.(focused && !perf);
    // 부감(focus=null)은 DoF off — 마을 전체가 얕은 심도로 뭉개지지 않게(#80 완성도, hanyang·모바일 특히).
    // amount 하나가 pass enable과 기본 조리개 배율을 함께 소유한다. focus-in은 0→1, focus-out은
    // 현재값→0 단조 전환이라 중단·교체 뒤 부풀린 조리개가 남지 않는다. 모바일 perf는 항상 0.
    post.setDofAmount?.(focused && !perf ? dofAmount : 0);
  }

  // ---------- 시네마틱 데모 모드 — 독립 runtime으로 위임 ----------
  const cineAvailable = () => demoRuntime.available();
  const startDemo = (mode = 'drone', opts = {}) => demoRuntime.start(mode, opts);
  const updateDemo = (dt) => demoRuntime.update(dt);
  const stopDemo = () => demoRuntime.stop();

  // 시드·옵션 → 캐시 키(코어 내부 구조 불결합, 직렬화만).
  function villageKey(opts, seed) {
    // 사전생성 캐시 소비 판정 키 — 재생성 결과를 바꾸는 옵션은 전부 포함해야 스테일 캐시 오소비를 막는다.
    //   #91 상세 파라미터(지형·구성·어휘)도 마을 지오를 바꾸므로 직렬화에 편입(기본값이면 현행 키와 동치 문자열).
    const n = (v, d) => (v == null ? d : v);
    const base = `${seed >>> 0}|${opts.scale}|${opts.character}|${!!opts.includePalace}|${!!opts.includeTemple}`;
    const tune = `${n(opts.undAmpK, 1)},${n(opts.ridgeHK, 1)},${n(opts.streamMeanderK, 1)},${opts.stream === false ? 0 : 1}`
      + `|${n(opts.paddyDensityK, 1)},${n(opts.treeDensityK, 1)},${n(opts.cityWall, 'a')},${n(opts.sijeon, 'a')}`
      + `|${opts.char01 == null ? 'a' : opts.char01},${n(opts.diversityK, 1)}`
      + `|h${opts.houses == null ? 'a' : opts.houses}`;   // #114 집 수 오버라이드(0="절 하나만" 등)
    return `${base}|${tune}`;
  }

  // 사전 생성: 주어진 옵션·시드의 마을을 미리 만들어 캐시에 보관(씬 미진입).
  //   #123: createVillageAsync(forest 워커 오프로드 + rAF 스텝 분산)로 비블로킹 사전 생성 → 부팅 히어로
  //   랜딩·타이틀 구간 동안 메인 스레드가 프리즈 없이 마을을 준비한다. 완료 시 캐시 채움 + GPU 프리워밍.
  //   진행 중 프리로드(pending)와 같은 key 면 no-op(중복 방지). window.__pregenOff 면 건너뜀(before 계측).
  //   window.__villageSync 폴백은 동기 createVillage(A/B). 반환: 즉시 사용 가능한 핸들 or null(비동기 진행 중).
  function preloadVillage(opts = village.opts, seed = village.seed) {
    if (typeof window !== 'undefined' && window.__pregenOff) return null;
    const key = villageKey(opts, seed);
    if (village.cache.key === key && village.cache.handle) return village.cache.handle;
    if (village.active && village.handle && villageKey(village.opts, village.seed) === key) return village.handle;
    if (village.pregen && village.pregen.key === key) return null;   // 같은 key 비동기 프리로드 진행 중
    if (village.cache.handle) { village.cache.handle.dispose(); village.cache = { key: null, handle: null }; }
    if (villageAsyncBuild()) {
      const tok = (village.pregen = { key });
      createVillageAsync({ ...opts, seed: seed >>> 0 }).then((h) => {
        if (village.pregen !== tok) { h.dispose(); return; }   // 더 최신 프리로드 시작됨 → 폐기
        village.pregen = null;
        // 그 사이 캐시에 최신분이 들어왔거나 활성 마을이 같은 key 면 폐기.
        if (village.cache.key === key && village.cache.handle) { h.dispose(); return; }
        village.cache = { key, handle: h };
        prewarmVillage(h);
      }, () => { if (village.pregen === tok) village.pregen = null; });
      return null;
    }
    const h = createVillage({ ...opts, seed: seed >>> 0 });   // 동기 폴백(group 생성만; 씬 add 는 enter 시)
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
    const lodVisibility = [];
    const cam = {
      pos: camera.position.clone(), tgt: controls.target.clone(), fov: camera.fov,
      referenceFov: camera.userData.villageReferenceFov,
      far: camera.far, near: camera.near,
    };
    const fog = scene.fog ? { near: scene.fog.near, far: scene.fog.far } : null;
    try {
      scene.add(h.group);
      h.group.traverse((o) => {
        // compile은 숨은 재질 프로그램을 찾을 수 있어도 실제 render는 visible=false 서브트리의
        // geometry/instance buffer를 업로드하지 않는다. FAR/MID/FULL root를 한 프레임만 모두 열어
        // 첫 거리 전환까지 GPU 업로드가 미뤄지는 히치를 제거하고, 아래 finally에서 정확히 복원한다.
        const name = o.name || '';
        const lodTierRoot = o.userData?.impostor === true
          || name.startsWith('chunk-mid-') || name.startsWith('chunk-full-');
        if (lodTierRoot) { lodVisibility.push([o, o.visible]); o.visible = true; }
        if (o.isMesh || o.isInstancedMesh || o.isLine || o.isPoints) {
          culled.push([o, o.frustumCulled]); o.frustumCulled = false;
        }
      });
      // 실제 진입 뷰(부감 카메라 + 마을 fog·far)로 예열 — 첫 진입 프레임의 셰이더 변종·업로드·
      // 스테이트를 그대로 warming(단일건물 카메라/far 로는 원경 지오·부감 셰이더가 덜 예열됨).
      const R = h.plan.site.R;
      controls.target.set(0, 0.06 * R, -0.10 * R);
      const prewarmScale = dollyDistanceForFov(
        1,
        VILLAGE_LENS.aerial.referenceFov,
        VILLAGE_LENS.aerial.fov,
      );
      camera.position.set(
        controls.target.x + 0.20 * R * prewarmScale,
        controls.target.y + 0.96 * R * prewarmScale,
        controls.target.z + 2.08 * R * prewarmScale,
      );
      camera.fov = VILLAGE_LENS.aerial.fov;
      camera.userData.villageReferenceFov = VILLAGE_LENS.aerial.referenceFov;
      camera.far = R * 8; camera.near = 0.5; camera.updateProjectionMatrix();
      camera.lookAt(controls.target);
      if (scene.fog) { scene.fog.near = R * 2.2; scene.fog.far = R * 7.0; }
      post.rimRescan?.(h.group);          // patch first, then compile that final shader variant
      renderer.compile(scene, camera);   // 셰이더 컴파일(그림자 depth 포함)
      renderFrame();                     // 버퍼·instanceMatrix 업로드(draw 강제)
    } catch (e) {
      /* 프리워밍 실패는 비치명적 — 진입 시 정상 생성 경로로 폴백 */
    } finally {
      for (const [o, v] of lodVisibility) o.visible = v;
      for (const [o, v] of culled) o.frustumCulled = v;
      scene.remove(h.group);
      camera.position.copy(cam.pos); controls.target.copy(cam.tgt);
      camera.fov = cam.fov; camera.far = cam.far; camera.near = cam.near; camera.updateProjectionMatrix();
      if (Number.isFinite(cam.referenceFov)) camera.userData.villageReferenceFov = cam.referenceFov;
      else delete camera.userData.villageReferenceFov;
      camera.lookAt(controls.target);
      if (fog && scene.fog) { scene.fog.near = fog.near; scene.fog.far = fog.far; }
      renderFrame();                     // 캔버스를 단일건물 상태로 원복(플래시 없음)
    }
  }

  // 셰이더 프리컴파일(#117): 새 마을·오버레이 지오가 씬에 붙으면 첫 렌더 프레임에 그 재질의 셰이더가
  //   지연 컴파일되며 메인스레드가 정지한다 — walk 진입(원경 풀디테일 청크 LOD 스왑 ~146 프로그램)·
  //   hop·focus-in·리롤 리빌 스톨의 실체가 바로 이 첫 렌더 컴파일이다. compileSubtreeAsync 는
  //   프로그램을 미리 초기화하고 KHR_parallel_shader_compile 로 링크를 드라이버 백그라운드에 위임
  //   (동기 비용↓)한 뒤 Promise 로 완료를 알린다. 다만 compile의 프로그램 준비와 실제 vertex/index/
  //   instance buffer 업로드는 별개다. preload의 prewarmVillage만 숨은 LOD root를 임시로 열어 render하고,
  //   일반 focus/wave warmShaders는 가시성에 손대지 않는다.
  //   이미 컴파일된 재질은 건너뛰므로 재호출은 신규분만 예열(정상상태 재질엔 저렴). 베일·카메라 트윈·
  //   카메라 트윈 구간에 얹어 프리즈를 흡수한다. 미지원(구 three)이면 조용히 no-op(폴백=지연 컴파일).
  //   ★ root 를 반드시 신규 서브트리(오버레이·새 핸들 그룹)로 좁혀야 한다: precompile은 인자 root를
  //     scene.traverse 로 전수 순회하며 재질마다 prepareMaterial 을 돌리므로, scene 전체를 넘기면
  //     이미 컴파일된 마을 수백 재질까지 매번 재처리해 도리어 큰 정지가 생긴다(hop·focus 악화 확인).
  //     targetScene=scene 을 넘겨 조명·fog 는 메인 씬 것을 쓰되, 컴파일 대상은 root 서브트리로 한정.
  function warmShaders(root, cam = camera) {
    // Material patches must precede both real rendering and compileAsync. Keeping
    // this ahead of the no-warm A/B gate also makes the visual contract independent
    // of the optional performance experiment and prevents a first-frame rim pop.
    post.rimRescan?.(root);
    if (typeof renderer.compile !== 'function' || !root) return Promise.resolve();
    if (typeof window !== 'undefined' && window.__noWarm) return Promise.resolve();   // A/B 계측 게이트(#117 검증용)
    try { return compileSubtreeAsync(renderer, root, cam, root === scene ? null : scene).catch(() => {}); }
    catch { return Promise.resolve(); }
  }

  // #128 활성 focus 링 컨테이너(env/focus.js makeRing 이 scene 직속으로 add, name='focusRing') 프리컴파일.
  //   링 재질(마당 닭·연기·모트·풀)은 focusRing.set() 순간 새로 생성되므로 오버레이(detail.group) 예열이
  //   놓친다 — set 직후 방금 붙은(가장 최근) 컨테이너를 찾아 예열해 링 첫 렌더의 링크 스톨을 흡수한다.
  function warmFocusRingShaders() {
    for (let i = scene.children.length - 1; i >= 0; i--) {
      const c = scene.children[i];
      if (c && c.name === 'focusRing') { warmShaders(c); return; }   // 최근 추가분 = 활성 링
    }
  }

  // #128 셰이더 에러 체크 은퇴(부팅 후 1회): 인자 프라미스(첫 마을 예열)가 완료되면 checkShaderErrors 를
  //   끈다. 그 시점엔 이미 여러 프레임이 checkShaderErrors=true 로 draw 되어(prewarm renderFrame + 초기
  //   부감) 마을·env 의 공유 셰이더 코드가 전부 onFirstUse 검증을 거친 뒤다. 이후 오버레이·링·env 전환의
  //   신규 프로그램 첫 렌더는 getProgramInfoLog 동기 조회 없이 KHR_parallel_shader_compile 로 논블록.
  let bootShaderCheckRetired = false;
  function retireShaderErrorCheck(afterPromise) {
    if (bootShaderCheckRetired) return;
    bootShaderCheckRetired = true;
    const off = () => {
      if (disposed) return;
      try { renderer.debug.checkShaderErrors = false; } catch {}
      // #140-A 그림자 정적 캐시 개시 — 예열 완료(공유 셰이더 검증·초기 부감 정착) 후 autoUpdate 를
      //   끄고, 이후엔 shadowHot/움직임/ focus 조건에서만 needsUpdate 로 재렌더한다. 개시 직후 잠깐은
      //   env 기본(sunset) 크로스페이드가 이어질 수 있어 창을 한 번 열어 초기 그림자를 확정한다.
      try { renderer.shadowMap.autoUpdate = false; shadowCacheOn = true; bumpShadow(1200); } catch {}
    };
    Promise.resolve(afterPromise).then(off, off);
  }

  // #128 reveal 게이트: 프리컴파일 프라미스 완료 또는 cap(ms) 경과 중 먼저 오는 쪽에 fn 을 1회 실행한다.
  //   전환 돌리 시작을 오버레이(+링) 셰이더 링크 완료에 묶어 첫 렌더 스톨을 없애되, 상한으로 클릭 반응성을
  //   보장(초과분 잔여 링크는 checkShaderErrors=false 로 논블록).
  function afterWarm(promise, capMs, fn) {
    let done = false;
    const go = () => { if (done || disposed) return; done = true; fn(); };
    Promise.resolve(promise).then(go, go);
    setTimeout(go, capMs);
  }

  // 다음 enter/setOpts 가 즉시(무생성) 가능한지 — App 이 먹 안개 마스킹 필요 여부 판단에 사용.
  function villageReady(opts = village.opts, seed = village.seed) {
    const key = villageKey(opts, seed);
    return (village.cache.key === key && !!village.cache.handle) ||
      (village.active && !!village.handle && villageKey(village.opts, village.seed) === key);
  }

  // 진입 순간 먹 안개 reveal(수묵 크로스페이드) — fog 를 짙게 시작해 base 로 풀며 마을이 드러난다.
  //   hold(0..1): 이 진행도까지 짙은 먹안개를 유지(무대감)한 뒤 그 이후 구간에 걷는다. 종가 랜딩은
  //   hold 로 조립 전반부 동안 주변 마을을 물려 히어로 단독 무대감을 만들고, 조립 후반에 마을을 연다(#98④).
  //   veil(#87②): 시작 시 주변 먹안개 깊이 배율(1=기본). 히어로 랜딩만 살짝 키워(>1) 등장감 강화 —
  //   far(주변 베일)만 깊게 하고 near(히어로 근접)는 불변이라 종가는 hold 중에도 늘 맑게 보인다.
  function startVillageReveal(dur = 1.3, { hold = 0, veil = 1 } = {}) { if (village.handle) village.reveal = { e: 0, dur, hold, veil }; }

  // #123: 엔진 비동기 빌드 게이트. 기본 ON(createVillageAsync = forest 워커 오프로드). window.__villageSync 로 강제 동기(A/B·비상 폴백).
  function villageAsyncBuild() { return !(typeof window !== 'undefined' && window.__villageSync); }

  // buildVillage(onReady) — 새 핸들을 확정한 뒤 씬에 스왑하고 onReady(후속 트윈·프레이밍) 를 실행한다.
  //   · 워밍 캐시 hit → 즉시 동기 스왑(프리징 0, 기존 경로).
  //   · 활성 마을 재생성(규모커밋·리롤·재진입, active+handle 有) → createVillageAsync(forest 워커) 로 메인
  //     프리즈 없이 빌드. 구 마을을 준비 완료까지 화면에 유지(블랭크·프리즈 없음), 준비되면 스왑. 토큰으로
  //     연속 커밋 중 스테일 결과 취소. ?worker=0·window.__villageSync 는 내부 폴백(동기/메인 크런치).
  //   · 첫 진입(handle 無) → 동기(부팅은 preload 워밍 + 히어로 랜딩 마스킹이 담당). 회귀 안전.
  function buildVillage(onReady, forceSync) {
    // regular swap과 wave swap은 같은 village.handle/scene root를 소유한다. 어느 경로가
    // 나중에 시작됐든 먼저 진행 중이던 wave(build 포함)를 회수해 late promotion을 막는다.
    cancelVillageWave();
    if (demo.active) stopDemo();   // 마을 재생성(리롤·규모·재진입) 시 데모 정지(스테일 패스 방지)
    if (village.heroTimer) { clearTimeout(village.heroTimer); village.heroTimer = null; }
    village.heroAsm = null;
    const key = villageKey(village.opts, village.seed);

    // 새 핸들 확정 후 스왑(구 마을은 그때까지 유지). enterVillageMode·env 전파·reveal·warmShaders(#117/#128).
    const swap = (h) => {
      village.__outerR = null;   // 마을 외곽 실반경 캐시 리셋(#80)
      focusRing.clear();         // 마을 재구성 → 근접 링 해제(오버레이 폐기됨)
      if (village.handle) { village.handle.exitVillageMode({ scene, building, ground, env }); village.handle.dispose(); }
      hoverParcel = null;
      village.handle = h;
      village.handle.enterVillageMode({ scene, building, ground, env });
      village.handle.setTime(state.time);
      village.handle.setSeason(state.season, {});
      village.handle.setWeather(state.weather);
      reapplyVillageFog();
      updateWeatherColliders();
      startVillageReveal();
      bumpShadow(3000);   // #140-A 새 마을 지오 등장 + reveal·예열 정착 동안 그림자 갱신(캐시 개시는 retire 소유)
      requestAnimationFrame(() => {
        if (disposed) return;
        const warm = (village.active && village.handle) ? warmShaders(village.handle.group) : Promise.resolve();
        retireShaderErrorCheck(warm);   // #128: 첫 마을 예열 완료 후 셰이더 에러 체크 은퇴. 1회 게이트.
      });
      if (onReady) onReady();
    };

    // (1) 사전 생성분(워밍 캐시) → 즉시 동기 스왑.
    if (village.cache.key === key && village.cache.handle) {
      const h = village.cache.handle; village.cache = { key: null, handle: null };
      village.build = null;
      swap(h);
      return;
    }
    // (2) 활성 재생성 → 비동기(forest 워커 오프로드). 구 마을 유지, 준비되면 스왑(스테일 토큰 취소).
    //     forceSync(히어로 랜딩 등 buildVillage 직후 village.handle 동기 의존 경로)는 제외.
    if (!forceSync && villageAsyncBuild() && village.active && village.handle) {
      const tok = (village.build = { key });
      createVillageAsync({ ...village.opts, seed: village.seed }).then((h) => {
        if (village.build !== tok) { h.dispose(); return; }   // 더 최신 빌드 시작됨(연속 커밋) → 폐기
        village.build = null; swap(h);
      }, () => {
        if (village.build !== tok) return;                     // 폴백: 동기 빌드
        village.build = null; swap(createVillage({ ...village.opts, seed: village.seed }));
      });
      return;
    }
    // (3) 첫 진입·강제 동기 폴백.
    village.build = null;
    swap(createVillage({ ...village.opts, seed: village.seed }));
  }

  function enterVillage(opts = null, seed = null) {
    if (opts) Object.assign(village.opts, opts);
    if (seed != null) village.seed = seed >>> 0;
    // 재진입(활성): 비동기 빌드일 수 있어 프레이밍 트윈을 onReady 로(새 핸들 site.R 기준). 구 마을 유지 중 부감.
    if (village.active) { setPostFocus(false); buildVillage(() => { const f = villageAerial(); tweenTo(f.pos, f.target, 1.0, { fov: f.fov, referenceFov: f.referenceFov, onDone: () => setZoomRegime('explore') }); }); emit('villageMode', true); return; }
    // 단일건물 선택·호버 상태 정리
    if (state.selected) { clearGhost(); state.selected = false; state.canMerge = false; emit('select', false); emit('state', { ...state }); }
    outline.selectedObjects = []; hovering = false;
    // 단일건물 날씨 파티클은 원점(숨은 본채)에 몰려 부감에 튀므로 억제(상태값은 유지).
    weatherRef.setWeather('clear');
    village.active = true; village.selected = null; village.transitioning = false;
    camera.__houseFar = camera.far; camera.__houseNear = camera.near; camera.__houseFov = camera.fov;
    camera.__houseReferenceFov = Number.isFinite(camera.userData.villageReferenceFov)
      ? camera.userData.villageReferenceFov : camera.fov;
    setPostFocus(false);                 // 부감 진입 → RimPass·flare OFF(성능)
    // 첫 진입은 동기(handle 無) → onReady 즉시 실행. 프레이밍 트윈을 onReady 로 두어 async 폴백에도 정합.
    buildVillage(() => { const f = villageAerial(); tweenTo(f.pos, f.target, 1.4, { fov: f.fov, referenceFov: f.referenceFov, onDone: () => setZoomRegime('explore') }); });
    updateWeatherColliders();
    emit('villageMode', true);
  }

  function exitVillage() {
    if (!village.active) return;
    if (demo.active) stopDemo();                      // 시네마틱 데모 종료(#112)
    // 공개 API로 웨이브 도중 이탈할 수도 있다. 새 루트를 scene에 둔 채 active만 끄면 애니가
    // 뒤늦게 승격되어 단일집을 다시 숨기므로, 현재 핸들을 건드리기 전에 웨이브 소유물을 회수한다.
    cancelVillageWave();
    stopHeroAsm();                                   // 진행 중 종가 조립·타이머 정리
    focusRing.clear();
    if (village.selected) village.handle.hideParcelDetail(village.selected);   // 오버레이(정규/특수) 해제
    else village.handle?.hideHeroDetail?.();
    if (hoverParcel) { village.handle.highlightParcel(hoverParcel, false); hoverParcel = null; }
    if (village.selected) village.handle.highlightParcel(village.selected, false);
    village.build = null; village.waveBuild = null;   // #123: 진행 중 비동기 빌드·웨이브빌드 취소(이탈 후 스테일 스왑 방지)
    village.active = false; village.selected = null; village.transitioning = false;
    controls.enableZoom = true; controls.minDistance = 0; controls.maxDistance = Infinity;
    renderer.domElement.style.cursor = '';
    setPostFocus(true);                  // 단일건물 씬 복귀 → rim/flare 기본 복원
    // 마을에서 바뀐 계절·시간의 단일집 전환은 env.group이 숨은 동안 CPU를 쉬었다. 재노출 전에
    // 목표 상태를 즉시 정착시켜 예전 들판/수목뿐 아니라 물·연기·모트 프로파일이 한 프레임
    // 나타났다 다시 변하는 회귀를 막는다. 보이는 상태의 일반 다이얼 변경은 여전히 크로스페이드한다.
    env.setSeason(state.season, { immediate: true });
    reapplyEnvBase({ immediate: true });
    village.handle.exitVillageMode({ scene, building, ground, env });
    camera.far = camera.__houseFar ?? 500; camera.near = camera.__houseNear ?? 0.1;
    camera.updateProjectionMatrix();
    weatherRef.setWeather(state.weather); refreshAtmosphere();
    updateWeatherColliders();
    const { pos, target } = buildingSpot('three-quarter', computeLayout(P));
    tweenTo(pos, target, 1.2, {
      fov: camera.__houseFov ?? 28,
      referenceFov: camera.__houseReferenceFov ?? camera.__houseFov ?? 28,
      onDone: () => { delete camera.userData.villageReferenceFov; },
    });
    emit('villageMode', false);
  }

  // 필지 호버(마을 부감): 프록시 레이캐스트 → 어댑터 먹선 하이라이트 + 커서 + 미니라벨 이벤트.
  function villageHover(clientX, clientY) {
    // 전환·웨이브 중엔 호버 봉인. focus 중(selected)에도 다른 필지 호버는 허용(#95 직접 전환 예고) —
    //   현 focus 필지 자신만 제외(재클릭 no-op 대상이라 하이라이트·라벨 불필요).
    if (village.transitioning || villageWaveBusy()) {
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
    let id = hit ? hit.parcelId : null;
    if (id && id === village.selected) id = null;   // 현 focus 필지는 호버 대상에서 제외
    if (id !== hoverParcel) {
      if (hoverParcel) village.handle.highlightParcel(hoverParcel, false);
      // #134: focus(줌인) 모드에선 이웃 필지 호버 박스를 그리지 않는다 — 감상 몰입 유지. hop(직접 전환)
      //   예고는 커서 pointer + 미니 라벨(아래 emit)로만. 부감(미선택)에선 종전대로 먹선 박스 표시.
      if (id && !village.selected) village.handle.highlightParcel(id, true);
      hoverParcel = id;
      renderer.domElement.style.cursor = id ? 'pointer' : '';
    }
    emit('villageHover', (hit && id) ? { parcelId: id, spec: hit.buildingSpec, x: clientX, y: clientY } : null);
  }

  // 앰비언스 근접 링(#79) — focus 오버레이 컴파운드에 붙인다(마당 닭·연기·모트·등롱). 미설정 시 no-op.
  function attachFocusRing(detailOrGroup) {
    const overlayGroup = detailOrGroup?.group || detailOrGroup;
    if (!overlayGroup) return;
    // 궁궐(#93): 다일곽 궁역은 기념비적 건축 — 농가 앰비언스(마당 닭·풀·굴뚝 연기)가 조정(박석) 위에
    //   깔리면 고증 붕괴. focus.js 는 그룹 바운드로 풀/모트를 깔아 궁역 60~96m 를 채우므로 도메스틱 링은 생략.
    if (village.selected === 'palace') { focusRing.clear(); return; }
    const ambient = detailOrGroup?.ambient
      || village.handle?.focusAmbientDescriptor?.(village.selected, overlayGroup);
    if (!ambient) { focusRing.clear(); return; }
    focusRing.set({ ...ambient, season: state.season });
    focusRing.setTime?.(state.time, true);
    warmFocusRingShaders();   // #128: 방금 생성된 링 컨테이너(scene 직속) 프리컴파일 — 링 첫 렌더 링크 스톨 흡수
  }

  // 필지 focus-in(클릭·집 보기 토글·프로그램 진입 공통) — mode-integration §5.5 원칙 1·3.
  //   모든 필지를 풀디테일 오버레이로 승격(showParcelDetail: 종가=컴파운드, 정규=단일 집) → 편집·리플레이·
  //   근접 링 앵커 확보(§4). 카메라 돌리 + DoF 램프 + 링 크로스페이드 + 패널 컨텍스트 모프를 FOCUS_IN_DUR
  //   한 타임라인으로 구동(onProgress 가 카메라 이즈드 k 를 App 패널 모프로 흘림). 줌은 전환 중 봉인.
  function villageSelect(parcelId) {
    if (!village.active || !village.handle || village.transitioning || villageWaveBusy()) return;
    const pr = village.handle.getPickProxy(parcelId);
    if (!pr) return;
    if (hoverParcel && hoverParcel !== parcelId) village.handle.highlightParcel(hoverParcel, false);
    hoverParcel = null;
    village.handle.highlightParcel(parcelId, true);   // 돌리인 동안 추적 하이라이트
    village.selected = parcelId; village.transitioning = true;
    setPostFocus(true, 0);                              // focus-in 시작은 선명, 카메라와 함께 DoF를 단조 점등
    setZoomRegime('lock');                              // 전환 중 줌 봉인
    // 풀디테일 오버레이 승격(모든 필지) — 편집·리플레이·근접 링 앵커.
    const detail = village.handle.showParcelDetail(parcelId);
    // 링은 전환 시작 프레임부터 소유권을 넘겨받되 공통 생활 LOD weight로 0→1이 된다.
    // 도착 후 갑자기 생기는 닭/낙엽 팝과, 전환 중 ambient-field 공백을 동시에 없앤다.
    if (detail?.group) attachFocusRing(detail);
    const warmP = detail?.group ? warmShaders(detail.group) : Promise.resolve();   // 오버레이 서브트리 프리컴파일(#117)
    renderer.domElement.style.cursor = '';
    const f = pr.cameraFraming;
    const closeupDist = f.position.distanceTo(f.target);
    emit('villageSelectStart', { parcelId, spec: pr.buildingSpec });
    emit('villageHover', null);
    // #128 reveal 게이트: 돌리인 시작을 오버레이 셰이더 링크 완료(cap 상한)에 묶어 첫 렌더 스톨 방지.
    //   대기 중 transitioning=true 라 재클릭·줌 감시자 봉인 유지. 게이트 통과 전 상태가 바뀌면(취소·전환) 중단.
    afterWarm(warmP, REVEAL_WARM_CAP_MS, () => {
      if (!village.active || village.selected !== parcelId) return;
      tweenTo(f.position, f.target, FOCUS_IN_DUR, {
        fov: f.fov, referenceFov: f.referenceFov,
        dofAnchor: f.target, dofAmount: 1,                         // 선택 필지 축깊이 고정 + 0→1 페이드
        onProgress: (k) => emit('villageFocusMorph', k),         // 부감→집 패널 모프(0→1)
        onDone: () => {
          village.transitioning = false;
          village.handle.highlightParcel(parcelId, false);        // 도착: 근경엔 박스 숨김
          setZoomRegime('focus', closeupDist);                    // 집 보기 안의 근접·문맥 줌 범위
          emit('villageFocusMorph', 1);
          emit('villageSelect', { parcelId, spec: pr.buildingSpec });
        },
      });
    });
  }

  // focus 중 필지→필지 직접 전환(#95) — A(현재 focus)에서 B 로 부감 미경유 이동. #92 타임라인 통일 규약:
  //   카메라 측면 돌리(A framing→B framing, tweenTo 가 매 프레임 lookAt + 종료 관성 리셋) + 패널 유형 모프
  //   (브레드크럼·편집 스키마가 B 로) + DoF(renderFrame 이 A→B 시선점을 추적) 한 타임라인. focusMorph 는 1 유지
  //   (집→집, 부감 골짜기 없음). 오버레이 스왑 순서: B 선표시(도착 시 근경 완성) → 도착(onDone)에 A 해제
  //   (근경 팝을 부감/원거리로 밀어냄). 앰비언스 링은 attachFocusRing(B) 이 focusRing.set → A 링 retiring
  //   크로스페이드. 전환 내내 transitioning=true → 줌 감시자·재클릭 봉인.
  function villageSwitch(toId) {
    if (!village.active || !village.handle || village.transitioning || villageWaveBusy()) return;
    const fromId = village.selected;
    if (!fromId || toId === fromId) return;                       // 부감(미focus)이거나 같은 필지면 무효(재클릭 no-op)
    const pr = village.handle.getPickProxy(toId);
    if (!pr) return;
    if (hoverParcel) { village.handle.highlightParcel(hoverParcel, false); hoverParcel = null; }
    stopHeroAsm();                                                // 진행 중 조립(리플레이 등) 정리
    // B 를 풀디테일 오버레이로 선표시(도착 시 근경엔 B 완성). A 오버레이는 도착까지 유지(팝 은닉).
    const detail = village.handle.showParcelDetail(toId);
    if (!detail) return;
    const warmP = detail.group ? warmShaders(detail.group) : Promise.resolve();   // B 오버레이 프리컴파일(#117)
    village.selected = toId; village.transitioning = true;
    setPostFocus(true);                                           // 두 상태 모두 focus(멱등) — rim/flare 유지
    setZoomRegime('lock');                                        // 전환 중 줌 봉인
    village.handle.highlightParcel(toId, true);                   // 돌리 동안 B 추적 하이라이트
    if (detail.group) attachFocusRing(detail);                   // 앰비언스 링 A→B 크로스페이드(set 이 A 링 retiring)
    renderer.domElement.style.cursor = '';
    const f = pr.cameraFraming;
    const closeupDist = f.position.distanceTo(f.target);
    emit('villageSelectStart', { parcelId: toId, spec: pr.buildingSpec, reseed: true });   // 패널 유형·기본값 갱신
    emit('villageHover', null);
    // #128 reveal 게이트: hop 돌리 시작을 B 오버레이 셰이더 링크 완료(cap 상한)에 묶어 첫 렌더 스톨 방지.
    afterWarm(warmP, REVEAL_WARM_CAP_MS, () => {
      if (!village.active || village.selected !== toId) return;
      tweenTo(f.position, f.target, FOCUS_HOP_DUR, {
        // 목적지 B가 출발 카메라 뒤에 있을 수 있다. 보이지 않는 B를 고정 추적하면 시야평면을 통과할 때
        // near→원거리 초점 점프가 생기므로, 생략된 dofAnchor가 보간 controls.target(A→B)을 따라가게 한다.
        fov: f.fov, referenceFov: f.referenceFov,
        onProgress: () => emit('villageFocusMorph', 1),             // 집→집: 모프 1 유지(부감 미경유)
        onDone: () => {
          village.transitioning = false;
          village.handle.highlightParcel(toId, false);              // 도착: 근경 박스 숨김
          if (fromId) village.handle.hideParcelDetail(fromId);      // A 오버레이 해제(A 인스턴스 복원) — 팝을 원거리로
          setZoomRegime('focus', closeupDist);
          emit('villageFocusMorph', 1);
          emit('villageSelect', { parcelId: toId, spec: pr.buildingSpec });
        },
      });
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
    const departingFocus = parcelId
      ? village.handle?.getPickProxy(parcelId)?.cameraFraming?.target || controls.target
      : controls.target;
    village.selected = null; village.transitioning = true;
    setZoomRegime('lock');                            // 전환 중 줌 봉인
    if (parcelId) village.handle.highlightParcel(parcelId, true);  // "내 집이 저기" 앵커
    const f = villageAerial();
    tweenTo(f.pos, f.target, FOCUS_OUT_DUR, {
      fov: f.fov, referenceFov: f.referenceFov,
      dofAnchor: departingFocus, dofAmount: 0,
      onProgress: (k) => emit('villageFocusMorph', 1 - k),   // 집→부감 패널 모프(1→0)
      onDone: () => {
        village.transitioning = false;
        setPostFocus(false);              // 부감 도착 → rim/flare OFF(전환 중엔 유지해 팝 방지)
        if (parcelId) village.handle.hideParcelDetail(parcelId);   // 부감 거리에서 오버레이 해제(팝 은닉)
        setZoomRegime('explore');
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
    return village.handle.getPickProxy(parcelId)?.buildingSpec || null;
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
    village.asmStarts = (village.asmStarts || 0) + 1;   // #126 재트리거 계측(히어로 랜딩=정확히 1회)
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
      // 검증용(#126): 정지 프레임 — 진행도 t(0..1) 를 자동진행 없이 그대로 적용(playAssembly.seek 대응).
      seek(t) { applyAt(clamp01(t)); },
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
    // 사용자/시드 날씨를 유지해 조립 중 하늘 입자(눈·비)가 종가 위로 내린다(#98 앰비언트 복원). 건물
    //   종속 FX(처마 낙수 등)는 building.visible=false 로 bldFx 게이트가 0 → 빈 터 조기노출 없음(#61 보존).
    //   입자 필드는 매 프레임 카메라 타깃 추종(setWeatherCenter)이라 원점 잔류 줄무늬(구 arm clear 사유) 없음.
    weatherRef.setWeather(state.weather);
    env.setTime('sunset');                              // 조립 중 비주얼 석양 강제 (오디오 반응성 보호를 위해 state.time 은 보존)
    post.setTime('sunset');
    village.active = true; village.selected = null; village.transitioning = true;
    camera.__houseFar = camera.far; camera.__houseNear = camera.near; camera.__houseFov = camera.fov;
    camera.__houseReferenceFov = Number.isFinite(camera.userData.villageReferenceFov)
      ? camera.userData.villageReferenceFov : camera.fov;
    heroActive = true;                          // 랜딩 중 자동 회전 억제
    lastActivity = performance.now() - ORBIT_IDLE_MS - 1000; // 조립 시작 즉시 카메라 선회
    buildVillage(null, true);                    // 히어로 랜딩은 동기(직후 village.handle 사용) — 사전 생성분 소비(무프리징) + 먹 안개 reveal
    const heroId = village.handle.heroParcelId();
    if (!heroId) {                               // 종가 없음(예외) → 부감 랜딩 폴백
      const f = villageAerial();
      camera.position.copy(f.pos); controls.target.copy(f.target); camera.fov = f.fov;
      camera.userData.villageReferenceFov = f.referenceFov;
      camera.updateProjectionMatrix(); camera.lookAt(controls.target);
      village.transitioning = false; heroActive = false;
      ensureAudio(); audio?.setBgmVolume(1);   // arm() 이 0 으로 뮤트한 BGM 복원(폴백 경로 — 랜딩 스킵)
      emit('villageMode', true); onDone?.(); return;
    }
    village.selected = heroId;
    setPostFocus(true);                                 // 종가 클로즈업 랜딩 → rim/flare ON
    const g = village.handle.showHeroDetail(heroId);   // 풀디테일 오버레이(원본 종가 가림)
    if (g) warmShaders(g);   // 종가 컴파운드 오버레이 서브트리만 프리컴파일(#117) — 랜딩 조립 첫 렌더 컴파일 스톨 흡수(타이틀 마스킹 구간)
    // 종가 클로즈업 프레이밍으로 스냅(타이틀이 화면을 덮는 동안 세팅 → 페이드 아웃되면 조립이 보임)
    const pr = village.handle.getPickProxy(heroId);
    // 종가 치수·회전. getPickProxies 가 미노출하던 시절 pr.rotY/maxDim 이 undefined → 카메라
    //   좌표 NaN → 랜딩 카메라가 정지(선회·줌인 소실)했다(#98 근본 원인). 어댑터에서 노출 복원 +
    //   여기 방어 폴백(bbox·cameraFraming 파생)으로 재발을 원천 차단한다.
    const bbSpan = pr.bbox ? { x: pr.bbox.max.x - pr.bbox.min.x, y: pr.bbox.max.y - pr.bbox.min.y, z: pr.bbox.max.z - pr.bbox.min.z } : null;
    const rotY = Number.isFinite(pr.rotY) ? pr.rotY : 0;
    const maxDim = Number.isFinite(pr.maxDim) ? pr.maxDim : (bbSpan ? Math.max(bbSpan.x, bbSpan.y, bbSpan.z) : 14);
    // 역광 무대(#98): 태양을 종가 배면(frontDir≈rotY, +180°+25° 사선)에 고정한다.
    // 카메라 XZ 방향은 일반 focus와 같은 남측 개방부 계약을 쓰므로 고정 방위로 앞집을 끌어들이지 않는다.
    heroSunAz = rotY + Math.PI + 25 * DEG;   // 배면 +25° 사선 역광(정배면보다 처마·측면 실루엣 림이 예쁨)
    village.heroRotY = rotY;   // 검증용(카메라·태양 방위 vs frontDir 단언)
    // 시선점은 문 높이로 내리되 카메라까지 낮춰 앞집 처마에 가리지 않는다. 9°의 완만한
    // 하향 시선은 기존 카메라 절대 높이를 거의 보존하면서 단청↔마당 탐색 여백을 만든다.
    const el = 9 * DEG;
    // 더 먼 자리에서 좁은 화각으로 같은 화면 점유율을 유지해 처마·산세가 망원으로 압축된다.
    const heroDistance = dollyDistanceForFov(
      1.85,
      VILLAGE_LENS.hero.referenceFov,
      VILLAGE_LENS.hero.fov,
    );
    const r = heroDistance * maxDim;
    const finalTarget = pr.cameraFraming.target.clone();
    const plannedXZ = pr.cameraFraming.position.clone().sub(finalTarget).setY(0).normalize();
    const off = plannedXZ.multiplyScalar(r * Math.cos(el));
    off.y = r * Math.sin(el);
    const finalPosition = finalTarget.clone().add(off);
    const finalFov = VILLAGE_LENS.hero.fov;

    // 나선 줌인 궤도 극좌표(#98②) — 최종 구도(finalPosition)를 기준각/반경/높이로 분해하고, 시작은
    //   HERO_SPIN_RAD 만큼 앞선 각 + 1.9배 먼 반경 + 4.2m 높은 상공. 조립 내내 각속도 일정(이즈드)으로
    //   선회하며 반경이 단조 축소돼(줌인) 집으로 파고들지 않고 finalPosition 에 정확히 안착한다.
    const a1 = Math.atan2(off.x, off.z);
    const r1 = Math.hypot(off.x, off.z);
    const arc = {
      cx: finalTarget.x, cz: finalTarget.z,
      a0: a1 + HERO_SPIN_RAD, a1,
      r0: r1 * 1.9, r1,
      y0: finalPosition.y + 4.2, y1: finalPosition.y,
    };
    const startPos = new THREE.Vector3(arc.cx + Math.sin(arc.a0) * arc.r0, arc.y0, arc.cz + Math.cos(arc.a0) * arc.r0);

    camera.position.copy(startPos); controls.target.copy(finalTarget); camera.fov = 34; // 먼 fov로 시작
    camera.userData.villageReferenceFov = 34;
    camera.updateProjectionMatrix(); camera.lookAt(controls.target);
    reapplyVillageFog();
    // 랜딩 먹 안개: 조립 완주까지 걸쳐 두되(hold 로 전반부 짙은 무대 유지) 조립 후반에 마을을 연다(#98④).
    //   히어로는 근접(near fog 안)이라 hold 중에도 늘 맑게 보이고, 무대(주변 마을)만 물렸다 열린다.
    // #87 빈 터 웜 글로우 귀속: 착공 전 빈 필지의 따뜻한 광채는 별도 진입 이펙트가 아니라 위 env.setTime
    //   ('sunset') 골든아워 조명 + 이 reveal fog(대기색=석양 하늘색으로 웜 틴트)의 합이다. 조립이 같은
    //   조명 위에서 자라나므로 빈 터→착공 전이는 이미 연속적(별도 연결 이펙트 불필요). veil 로 랜딩 베일만 강화.
    startVillageReveal(HERO_ASSEMBLE_DELAY_MS / 1000 + HERO_ASSEMBLE_DUR + 0.6, { hold: HERO_REVEAL_HOLD, veil: HERO_REVEAL_VEIL });
    emit('villageMode', true);
    emit('villageSelectStart', { parcelId: heroId, spec: pr.buildingSpec });   // 패널 집 컨텍스트(스펙 선전달)
    emit('villageFocusMorph', 1);                                              // 랜딩=집 컨텍스트로 안착
    // BGM 페이드인(#BGM): hero.arm() 이 타이틀 동안 BGM 볼륨을 0 으로 뮤트했으므로, 마을 우선 랜딩에서
    //   다시 0→1 로 스웰시킨다(레거시 hero.enter 의 stepFade 대응 — 이게 없어 마을 우선 경로에서 BGM 이
    //   0 에 갇혀 효과음만 들리던 회귀 수정). setBgmVolume 은 볼륨 배수라 audio 미start 여도 안전.
    ensureAudio();
    { const t0 = performance.now(), durMs = 2500;
      const stepFade = () => { if (disposed) return; const k = Math.min(1, (performance.now() - t0) / durMs); audio?.setBgmVolume(k); if (k < 1) requestAnimationFrame(stepFade); };
      requestAnimationFrame(stepFade); }
    const closeupDist = finalPosition.distanceTo(finalTarget);
    // 조립 즉시 시작하되 착공 지연(delay)만큼 빈 터 유지 → 타이틀 페이드·먹안개가 착공 순간을 덮는다.
    // 완료 시 클로즈업 편집 상태로 안착(패널 슬라이드 인).
    // 상공(startPos) → 최종 역광 클로즈업(finalPosition)으로 나선 회전 줌인. 조립 완주(delay+dur)까지
    //   카메라가 끊김 없이 선회 도착 → 도중 autoRotate 로 넘어가며 속도 튐(lurch)이 없다(#98②).
    tween = {
      e: 0,
      dur: HERO_ASSEMBLE_DELAY_MS / 1000 + HERO_ASSEMBLE_DUR,
      arc,
      p1: finalPosition.clone(),   // 폴백/참조용(arc 모드에선 미사용)
      t0: finalTarget.clone(),
      t1: finalTarget.clone(),
      f0: 34,
      f1: finalFov,
      r0: 34,
      r1: VILLAGE_LENS.hero.referenceFov,
      changesLens: true,
      onDone: () => {
        settleControls();
        controls.update(); // 1프레임 회전 튕김 차단
      }
    };
    playHeroAssembly(g, HERO_ASSEMBLE_DUR, { delay: HERO_ASSEMBLE_DELAY_MS / 1000, onDone: () => {
      village.transitioning = false; heroActive = false; lastActivity = performance.now();
      settleControls();
      controls.update(); // 조립 종료 시점에서도 즉시 컨트롤 관성 리셋
      // 원래 사용자 시간대 비주얼 복구
      env.setTime(state.time);
      post.setTime(state.time);
      if (village.handle) { village.handle.setTime(state.time); reapplyVillageFog(); }
      attachFocusRing(village.handle.heroDetailGroup());   // 조립 정착 후 근접 앰비언스 점등(#79)
      setZoomRegime('focus', closeupDist);                 // 랜딩 착지 → 근접 줌
      weatherRef?.setWeather(state.weather);               // 랜딩 조립 정착 후 날씨 복원
      updateWeatherColliders();
      emit('villageSelect', { parcelId: heroId, spec: pr.buildingSpec });
      onDone?.();
    } });
  }

  // 종가 클로즈업으로 돌리(모드 토글 '집' — 부감에서 호출). villageSelect 재사용(돌리인+DoF 조임+패널).
  function focusHero() {
    if (!village.active || !village.handle || village.transitioning || villageWaveBusy()) return;
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
    if (!village.active || !village.handle || village.transitioning || villageWaveBusy()) return;
    const id = village.selected;
    if (!id) return;
    const pr = village.handle.getPickProxy(id);
    if (!pr) return;
    let detail = village.handle.focusAssembly(id);           // 현 오버레이(편집 보존)
    if (!detail) { const d = village.handle.showParcelDetail(id); if (!d) return; detail = d; }
    const dur = detail.compound ? HERO_ASSEMBLE_DUR : 3.0;   // 정규 집은 짧게
    village.transitioning = true;
    lastActivity = performance.now() - ORBIT_IDLE_MS - 1000; // 조립 시작 즉시 카메라 선회
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
      updateWeatherColliders();
      emit('villageFocusMorph', 1);
      emit('villageSelect', { parcelId: id, spec: pr.buildingSpec });      // 패널 재슬라이드인
    } });
  }

  // 이 집만 다시 굴리기(#100) — 현재 focus 중인 필지의 시드만 바꿔 그 집만 재생성(마을·이웃 불변).
  //   리플레이(같은 시드 재조립)와 구분: 리롤은 어댑터 rerollParcel 이 변주를 새 시드로 재유도 → 오버레이
  //   교체 → 새 buildingSpec 반환. 편집값은 새 기본값으로 리셋하되 패널과 동기(emit reseed:true). 그 뒤는
  //   replayFocus 와 동형(조립 재생 + 링 재부착 + 패널 재시드).
  function rerollFocusParcel() {
    if (!village.active || !village.handle || village.transitioning || villageWaveBusy()) return;
    const id = village.selected;
    if (!id) return;
    const detail = village.handle.rerollParcel(id);
    if (!detail) return;
    if (detail.group) warmShaders(detail.group);   // 리롤 신규 오버레이 서브트리만 프리컴파일(#117) — 재조립 첫 렌더 컴파일 스톨 흡수
    const pr = village.handle.getPickProxy(id);
    const spec = detail.spec || pr?.buildingSpec;
    const dur = detail.compound ? HERO_ASSEMBLE_DUR : 3.0;
    village.transitioning = true;
    lastActivity = performance.now() - ORBIT_IDLE_MS - 1000; // 조립 시작 즉시 카메라 선회
    setPostFocus(true);
    setZoomRegime('lock');
    stopHeroAsm();
    focusRing.clear();                                            // 재생성 중 링 해제(정착 후 재부착)
    emit('villageSelectStart', { parcelId: id, spec, reseed: true });   // 패널 접힘 + 새 기본값 강제 재시드
    emit('villageHover', null);
    startVillageReveal(dur + 0.4);                               // 재형성 무드 + 폴백 소품 은닉 마스킹
    if (pr) {
      const framing = pr.cameraFraming;
      tweenTo(framing.position, framing.target, Math.min(1.2, dur * 0.42), {
        fov: framing.fov,
        referenceFov: framing.referenceFov,
        dofAnchor: framing.target,
        onProgress: () => emit('villageFocusMorph', 1),
      });
    }
    playFocusAssembly(detail, dur, { onDone: () => {
      village.transitioning = false;
      attachFocusRing(detail.group);
      if (pr) setZoomRegime('focus', pr.cameraFraming.position.distanceTo(pr.cameraFraming.target));
      updateWeatherColliders();
      emit('villageFocusMorph', 1);
      emit('villageSelect', { parcelId: id, spec });             // 패널 재슬라이드인(새 시드 기본값)
    } });
  }

  // ── 마을 웨이브 재구성(#56 배선·mode-integration §5.5 원칙·#144 일반화) — 부감 유지, 옛 마을 방사 해체
  //    → 먹안개 속 scenery 단일 handoff → 새 마을 중앙에서 방사형 조립. 리롤(새 시드)·규모/궁/절/상세
  //      옵션 커밋 공용. 도로·필지·지형은 동시에 한 root만 보이며 material transparency를 쓰지 않는다.
  //    · buildOpts 지정 → 그 옵션으로 빌드하고 완료 시 village.opts 에 확정(규모·상세 커밋), 미지정 → 현
  //      village.opts 유지(리롤). · seed 지정 → 그 시드로(리롤=newSeed), 미지정 → 현 시드 유지(옵션 커밋).
  //    · reframe → 새 site 반경 기준 부감 재프레이밍을 웨이브와 동반 트윈(규모 변경 시 새 마을이 프레임에
  //      맞게 자람). 리롤(동일 규모)은 생략. 웨이브 시작 전 focus-out(링·오버레이 정리)은 방어적으로 처리.
  //    레이스: 애니 진행 중(village.wave)·전환 중엔 진입 거부(App 이 waving 잠금). 빌드 진행 중(waveBuild)
  //      재호출은 새 토큰이 이전 빌드를 무효화(최신 커밋 승리) — 연타 커밋 스테일 스왑 방지.
  function applyVillageWavePresentation(wave) {
    const veil = clamp01(wave.anim.veil);
    const ownerRadius = wave.anim.sceneryOwner === 'old' ? wave.oldRadius : wave.newRadius;
    if (scene.fog) {
      // 평상시 각 장면의 규모별 fog에서 시작/종료하고, peak만 더 큰 장면까지 감싸는 먹안개로 모인다.
      // handoff 순간에는 ownerRadius 항이 0이라 규모가 달라도 fog 거리가 튀지 않는다.
      scene.fog.near = ownerRadius * 2.2 * (1 - veil);
      scene.fog.far = ownerRadius * 7.0 * (1 - veil) + wave.coverRadius * 0.14 * veil;
    }
    if (sun.shadow) sun.shadow.intensity = wave.shadowIntensity * wave.anim.shadowWeight;
    const requiredFar = wave.coverRadius * 8;
    if (camera.far < requiredFar) {
      camera.far = requiredFar;
      camera.updateProjectionMatrix();
    }
  }

  function restoreVillageWavePresentation(wave) {
    if (sun.shadow) sun.shadow.intensity = wave.shadowIntensity;
    reapplyVillageFog();
  }

  function startVillageWave({ seed, buildOpts, reframe = false } = {}) {
    if (!village.active || !village.handle || village.wave || village.transitioning) return null;
    // 반대 방향 경합도 latest request가 이긴다. 진행 중 regular async 결과는 토큰 불일치로
    // 완성 즉시 dispose되고 현재 oldHandle을 건드리지 않는다.
    village.build = null;
    if (demo.active) stopDemo();
    // 진행 중 focus/조립 흔적 정리(부감 상태에서 호출되지만 방어)
    stopHeroAsm();
    if (village.selected) { focusRing.clear(); village.handle.hideParcelDetail(village.selected); village.selected = null; }
    if (hoverParcel) { village.handle.highlightParcel(hoverParcel, false); hoverParcel = null; }
    village.reveal = null;    // 진입 reveal과 웨이브 fog가 같은 scene.fog를 동시에 소유하지 않게 한다.
    setPostFocus(false);   // 부감 연출 — focus 잔재가 있어도 rim/flare OFF(성능·룩)
    setZoomRegime('lock');
    const oldHandle = village.handle;
    const useSeed = (seed != null) ? (seed >>> 0) : village.seed;
    const useOpts = buildOpts || village.opts;
    // #123: 새 마을 핸들은 forest 워커 오프로드로 비블로킹 생성(구 마을 유지 중 부감). 준비되면 웨이브 시작
    //   → 웨이브 시작 프레임의 동기 createVillage 프리즈 제거. 스테일 토큰 취소(연속 커밋·이탈 방어).
    const startWave = (newHandle) => {
      // 현재 토큰은 startWave 호출 직전에 비워진다. 이후에도 busy/선택/전환이 남았다면 빌드 중
      // 다른 화면 흐름이 소유권을 얻은 것이므로 incoming 핸들을 폐기한다.
      if (villageWaveBusy() || village.selected || village.transitioning
        || !village.active || village.handle !== oldHandle) { newHandle.dispose(); return; }
      newHandle.setTime(state.time);              // env 상태 선적용(웨이브 중 옛 마을과 톤 일치)
      newHandle.setSeason(state.season, {});
      newHandle.setWeather(state.weather);
      // createRerollWave가 vis0를 캡처하기 전에 현재 부감 LOD를 적용한다. 그렇지 않으면 새 마을의
      // 닭·소·개·고양이·까치가 기본 visible=true로 데코 웨이브에 섞였다가 승격 때 갑자기 사라진다.
      newHandle.updateLod(camera, controls.target, 0);
      // 새 마을의 scene-direct 연기·모트·등롱 필드는 완료 뒤 갑자기 만들지 않고 미리 연결한다.
      // 아직 셀이 없고 아래 wave가 ownerWeight=0으로 prime하므로 이 동기 구간에 보이는 팝은 없다.
      newHandle.prepareWavePresentation({ scene });
      scene.add(newHandle.group);                 // old 와 공존(웨이브 대상)
      const site = oldHandle.plan.site;
      const anim = createRerollWave({
        oldRoot: oldHandle.group, newRoot: newHandle.group,
        center: site.center || { x: 0, z: 0 },
        seed: useSeed, duration: 3.6,
      });
      // Patch every incoming material before its first visible frame, then let the scoped
      // async compile overlap the opening veil. Without this explicit handoff the post
      // composer's throttled self-heal can change material programs midway through the wave.
      warmShaders(newHandle.group);
      const oldRadius = oldHandle.plan.site.R;
      const newRadius = newHandle.plan.site.R;
      village.wave = {
        anim, oldHandle, newHandle, seed: useSeed,
        opts: buildOpts ? { ...buildOpts } : null,
        oldRadius, newRadius, coverRadius: Math.max(oldRadius, newRadius),
        shadowIntensity: Number.isFinite(sun.shadow?.intensity) ? sun.shadow.intensity : 1,
      };
      applyVillageWavePresentation(village.wave);
      // 규모 커밋 동반 재프레이밍(#144): 새 핸들 site 기준 부감으로 웨이브와 함께 밀어 새 마을이 프레임에
      //   맞게 자란다(완료 후 스냅 대신). 웨이브(3.6s)보다 살짝 짧게 끝내 finish 의 setZoomRegime 과 안 겹침.
      if (reframe) {
        const f = villageAerial(newHandle);
        tweenTo(f.pos, f.target, 3.0, { fov: f.fov, referenceFov: f.referenceFov });
        village.wave.reframeTween = tween;
      }
      emit('villageWave', { phase: 'start' });
    };
    if (villageAsyncBuild()) {
      const tok = (village.waveBuild = { seed: useSeed });   // 이전 waveBuild 토큰 자동 무효화(최신 커밋 승리)
      createVillageAsync({ ...useOpts, seed: useSeed }).then((h) => {
        if (village.waveBuild !== tok) { h.dispose(); return; }
        village.waveBuild = null; startWave(h);
      }, () => { if (village.waveBuild === tok) { village.waveBuild = null; startWave(createVillage({ ...useOpts, seed: useSeed })); } });
    } else {
      startWave(createVillage({ ...useOpts, seed: useSeed }));
    }
    return useSeed;
  }
  // 리롤 웨이브(#56): 새 시드로 마을 전체 재구성. 옵션은 유지, 규모 불변이라 재프레이밍 없음.
  function startRerollWave() { return startVillageWave({ seed: newSeed() }); }
  function cancelVillageWave() {
    // 비동기 build 토큰을 먼저 무효화한다. 이미 resolve 중인 Promise는 토큰 불일치를 보고
    // 완성된 핸들을 dispose하며, 공개 exit/isWaving은 같은 틱에 idle로 돌아간다.
    const cancelledBuild = !!village.waveBuild;
    village.waveBuild = null;
    const w = village.wave;
    if (!w) {
      if (cancelledBuild) emit('villageWave', { phase: 'cancel' });
      return cancelledBuild;
    }
    village.wave = null;
    if (tween && tween === w.reframeTween) {
      tween = null;
      settleControls();
    }
    w.anim.cancel();                        // old 루트 복원·new 루트 미착공 + scenery 소유권 복원
    scene.remove(w.newHandle.group);        // dispose 뒤 scene에 죽은 Object3D를 남기지 않는다.
    w.newHandle.dispose();
    village.handle = w.oldHandle;           // 방어: 웨이브 도중에는 원래 같지만 공개 API 레이스에도 명시
    restoreVillageWavePresentation(w);
    bumpShadow(1200);                       // partial-wave caster 행렬 복원을 즉시 shadow cache에 반영
    emit('villageWave', { phase: 'cancel' });
    return true;
  }
  // 웨이브 완료 → 옛 마을 폐기 + 새 마을 활성 승격(enterVillageMode 상당: 조명 리그·구름·fog·야경·픽킹 재연결).
  function finishRerollWave() {
    const w = village.wave; if (!w) return;
    village.wave = null;
    w.anim.dispose();                                        // 새 마을 트랜스폼·scenery 소유권 정상화
    if (sun.shadow) sun.shadow.intensity = w.shadowIntensity;
    // 옛 마을 이탈(조명 리그·구름·fog 모디파이어 해제 + 그룹 제거) 후 폐기.
    w.oldHandle.exitVillageMode({ scene, building, ground, env });
    w.oldHandle.dispose();
    // 새 마을 승격 — enterVillageMode(그룹은 이미 scene 자식이라 재부모 no-op) + 시간·계절·날씨·fog 재적용.
    village.handle = w.newHandle;
    village.seed = w.seed;
    if (w.opts) Object.assign(village.opts, w.opts);   // #144 규모/궁/절/상세 커밋 확정(완료 시점에 반영)
    village.__outerR = null;
    village.handle.enterVillageMode({ scene, building, ground, env });
    village.handle.setTime(state.time);
    village.handle.setSeason(state.season, {});
    village.handle.setWeather(state.weather);
    reapplyVillageFog();
    updateWeatherColliders();   // 새 seed/규모의 지붕·마당 AABB로 눈·비 충돌 대상을 즉시 교체
    bumpShadow(2000);   // #140-A 웨이브 완료 후 새 마을 정착 프레임 그림자 갱신
    setZoomRegime('explore');
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
      const { pos, target } = state.selected ? focusFraming() : buildingSpot('three-quarter', computeLayout(P));
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
      // 전체를 새 구성으로 교체하되, 확장할 때는 새 마지막 날개만 조립 애니메이션을 준다.
      regenerate();
      building.visible = true;
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
    },
    merge,
    maxExpansion: () => wingCount(state.preset) + 1,

    setTime(name, opts = {}) {
      state.time = name;
      bumpShadow(2200);   // #140-A 시간대 크로스페이드: 태양 방향(고도·방위) 이동 동안 그림자 갱신
      env.setTime(name, opts);
      nightGlowRef.setTime(name);
      post.setTime(name, opts);
      refreshAtmosphere();
      audio?.setTime(name);
      // 웨이브 중 old/new가 함께 보이므로 두 핸들에 같은 프레임의 환경 상태를 전달한다.
      // 전역 sky/fog/post는 위에서 한 번만 갱신하고, 핸들별 물·조명·동물만 각각 동기화한다.
      if (forEachPresentedVillageHandle((handle) => handle.setTime(name, opts))) reapplyVillageFog();
      focusRing.setTime?.(name, opts.immediate); // 근접 링 앰비언스 시간대(연기·모트·닭)
      emit('state', { ...state });
    },
    setSeason(name, opts = {}) {
      state.season = name;
      bumpShadow(1800);   // #140-A 계절 전환 크로스페이드 동안 그림자 갱신(잎·개화 캐스터 정합)
      env.setSeason(name, opts);
      refreshAtmosphere();
      if (forEachPresentedVillageHandle((handle) => handle.setSeason(name, opts))) reapplyVillageFog();
      focusRing.setSeason?.(name, opts);  // 근접 링 풀·반딧불 계절 연동(결정론 캡처는 immediate까지 전달)
      emit('state', { ...state });
    },
    setWeather(name) {
      state.weather = name;
      bumpShadow(1800);   // #140-A 날씨 전환 크로스페이드 동안 그림자 갱신
      // 마을 모드: 건물 종속 FX(처마 낙수 등)는 building.visible=false 로 자동 억제되므로
      // 안전하게 weatherRef 를 동시 업데이트하여 하늘 입자를 구동합니다.
      if (forEachPresentedVillageHandle((handle) => handle.setWeather(name))) {
        reapplyEnvBase();
        reapplyVillageFog();
      } else {
        reapplyEnvBase();
        refreshAtmosphere();
      }
      weatherRef?.setWeather(name);
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
      // 리플레이(#59·#92 일반화): 현재 focus 중인 필지를 다시 조립(같은 시드, 시각 불변).
      replay: replayFocus,
      // 이 집만 다시 굴리기(#100): 현재 focus 중인 필지만 새 시드로 재생성(마을·이웃 불변).
      rerollParcel: rerollFocusParcel,
      // 임의 필지 focus(모드 토글 '집'은 종가 focusHero, 클릭·줌은 이 경로) — 검증·프로그램 진입.
      focus: (id) => { if (village.active && !village.transitioning && !villageWaveBusy() && !village.selected) villageSelect(id); },
      // focus 중 필지→필지 직접 전환(#95): 현재 focus 상태에서 B 로 부감 미경유 이동. 검증·프로그램 진입.
      switchTo: (id) => { if (village.active && !village.transitioning && !villageWaveBusy() && village.selected) villageSwitch(id); },
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
      // 마을 옵션 변경(규모·성격·궁·절·상세) → 재생성 + 부감 재프레이밍. 궁은 capital·hanyang 만 유효(그 외 무시).
      //   opts.wave(App UI 경로) → 구 마을 유지 + 중앙→방사 웨이브 조립(#144, 베일 헛번쩍·통짜 팝 제거). 미지정
      //   (검증·프로그램 경로) → 즉시 빌드+팝 스왑(구 계약 유지, bench/verify 툴 debugPlan 동기 판독 보존).
      setOpts(partial = {}, opts = {}) {
        if (partial.scale && partial.scale !== 'capital' && partial.scale !== 'hanyang') partial = { ...partial, includePalace: false };
        if (opts.wave && village.active && village.handle) {
          // village.opts 는 웨이브 완료 시점(finishRerollWave)에 확정 — 진행 중엔 구 마을·구 opts 유지(레이스 정합).
          const started = startVillageWave({ buildOpts: { ...village.opts, ...partial }, reframe: true });
          if (started != null) emit('villageMode', true);
          return;   // 웨이브 진입 실패(애니/전환 중)면 커밋 드롭 — App 이 waving 잠금으로 이 상황을 사전 차단.
        }
        Object.assign(village.opts, partial);
        if (village.active) {
          village.selected = null; village.transitioning = false;
          setPostFocus(false);
          // #123: 규모커밋은 비동기 빌드(forest 워커) — 구 마을 유지 중 부감 프레이밍은 새 핸들 준비 시(onReady).
          buildVillage(() => { const f = villageAerial(); tweenTo(f.pos, f.target, 1.0, { fov: f.fov, referenceFov: f.referenceFov, onDone: () => setZoomRegime('explore') }); });
          emit('villageMode', true);
        }
      },
      // 즉시 리롤(먹 안개 마스킹 경로 — 검증·폴백용). 마을 UI 는 rerollWave(#56 연출)를 쓴다.
      reroll() {
        village.seed = newSeed();
        if (village.active) {
          village.selected = null; village.transitioning = false;
          setPostFocus(false);
          buildVillage(() => { const f = villageAerial(); tweenTo(f.pos, f.target, 1.0, { fov: f.fov, referenceFov: f.referenceFov, onDone: () => setZoomRegime('explore') }); });
        }
        emit('villageSeed', village.seed);
        return village.seed;
      },
      // 리롤 웨이브(#56): 부감 유지·연출 재구성. isWaving은 워커 빌드부터 애니 완료까지 true다.
      rerollWave: () => startRerollWave(),
      isWaving: villageWaveBusy,
      // 검증용: 비동기 준비와 활성 웨이브를 구분하고, 동시에 제시되는 두 핸들의 환경 상태만
      // 읽는다. Object3D/handle 자체를 노출하지 않아 테스트가 수명 소유권을 우회하지 못하게 한다.
      debugWave: () => {
        const snapshot = (handle) => handle ? {
          time: handle.time, season: handle.season, weather: handle.weather,
        } : null;
        const active = village.wave;
        return {
          building: !!village.waveBuild,
          active: !!active,
          old: snapshot(active?.oldHandle || (village.waveBuild ? village.handle : null)),
          incoming: snapshot(active?.newHandle || null),
          presentation: active ? {
            progress: active.anim.progress,
            veil: active.anim.veil,
            shadowWeight: active.anim.shadowWeight,
            sceneryOwner: active.anim.sceneryOwner,
            fogNear: scene.fog?.near ?? null,
            fogFar: scene.fog?.far ?? null,
            shadowIntensity: sun.shadow?.intensity ?? null,
            paused: !!active.debugPaused,
          } : null,
        };
      },
      // 결정론 시각 하네스: 실제 앱의 post/env/scene 수명을 유지한 채 지정 seed 웨이브를 시작하고
      // 한 progress에 정지한다. 일반 UI는 이 API를 쓰지 않으며, cancel까지 같은 공개 수명 경로를 탄다.
      debugStartWave: ({ seed, opts, reframe = false } = {}) => startVillageWave({
        seed: seed != null ? seed >>> 0 : newSeed(),
        buildOpts: opts ? { ...village.opts, ...opts } : undefined,
        reframe,
      }),
      debugSeekWave: (progress) => {
        const active = village.wave;
        if (!active) return null;
        active.debugPaused = true;
        active.anim.seek(clamp01(progress));
        applyVillageWavePresentation(active);
        if (shadowCacheOn) renderer.shadowMap.needsUpdate = true;
        return {
          progress: active.anim.progress,
          veil: active.anim.veil,
          shadowWeight: active.anim.shadowWeight,
          sceneryOwner: active.anim.sceneryOwner,
        };
      },
      debugResumeWave: () => {
        if (!village.wave) return false;
        village.wave.debugPaused = false;
        return true;
      },
      debugCancelWave: () => cancelVillageWave(),
      // glb 익스포트 대상(#104·#112). exportRoot=마을 전체(populate root, 부감에서 노출), focusRoot=현재
      //   focus 중 필지의 풀디테일 오버레이(재생성 없이 현 오버레이 반환). 둘 다 gltf.exportGLB 에 그대로.
      exportRoot: () => village.handle?.group ?? null,
      focusRoot: () => {
        if (!village.handle || !village.selected) return null;
        const d = village.handle.focusAssembly?.(village.selected);
        return d?.group ?? null;
      },
      // 필지 편집 반영(#48, 라이브 스로틀은 App). 정규 필지는 오버레이 단일 집 교체, 특수(종가·관아)는
      //   컴파운드 오버레이 재생성. 편집 시 오버레이가 새로 만들어져 근접 앰비언스 링 앵커가 스테일해지므로
      //   focus 중인 그 필지면 새 오버레이에 링을 재부착(정규·특수 모두 — #92 정규도 오버레이+링).
      rebuild: (id, params, opts = {}) => {
        const g = village.handle?.rebuildParcel(id, params, {
          persist: true,
          refreshFlora: opts.refreshFlora !== false,
        });
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
      // 검증용(#91): 현재 마을 plan 요약 — 상세 옵션 반영을 수치로 단언(개울 유무·성곽·논·시전·나무·시드·char01).
      //   개울/성곽/논은 plan 데이터, 나무 수는 village-trees 인스턴스 총합 실측(밀도 배율 효과).
      debugPlan: () => {
        const p = village.handle?.plan; if (!p) return null;
        const feat = p.features || {};
        let trees = 0;
        const inTrees = (o) => { for (let n = o; n; n = n.parent) if (n.name === 'village-trees') return true; return false; };
        village.handle?.group?.traverse?.((o) => { if (o.isInstancedMesh && inTrees(o)) trees += o.count; });
        return {
          seed: village.seed >>> 0, scale: p.scale, siteR: p.siteR,
          houses: p.stats?.houses ?? 0, paddies: p.stats?.paddies ?? 0, trees,
          stream: !!(p.site && p.site.stream),
          cityWall: !!feat.cityWall, sijeon: Array.isArray(feat.sijeon) ? feat.sijeon.length : 0,
          temple: !!feat.temple,
          char01: (typeof p.opts?.char01 === 'number') ? +p.opts.char01.toFixed(3) : null,
          charOverride: !!p.opts?.charOverride,
          opts: { ...village.opts },
        };
      },
      // 검증용(#96): 필지 params 로 오버레이 재생성 후 메시·정점 수 — 마당 소품(장독대·텃밭·낟가리·빨래줄)은
      //   makeYardProps 가 개별 메시로 추가(병합 없음)라, jangdok/vegBed 등 켜기/끄기가 메시·정점 수 변화로 잡힌다.
      debugParcelStats: (id, params) => village.handle?.parcelBuildStats?.(id, params) ?? null,
      // 검증용(#19): persistent rebuild 소유권, 필지 치수, 편집 스펙, 마당나무 충돌을
      // renderer traversal 없이 한 스냅샷으로 확인한다.
      debugParcelRebuild: (id) => village.handle?.parcelRebuildState(id) ?? null,
      // 검증용: 필지 목록·화면 투영(플레이라이트 결정적 호버/클릭 좌표).
      debugParcels: () => (village.handle?.getPickProxies() || []).map((p) => ({
        parcelId: p.parcelId, hero: p.buildingSpec.hero, kind: p.buildingSpec.kind,
        heroStyle: p.buildingSpec.heroStyle || null, family: p.buildingSpec.family || null,
        editable: p.buildingSpec.editable === true,
        focusBaseY: +p.worldCenter.y.toFixed(2),
        focusTargetY: +p.cameraFraming.target.y.toFixed(2),
        focusTargetLift: +(p.cameraFraming.target.y - p.worldCenter.y).toFixed(2),
        focusCameraY: +p.cameraFraming.position.y.toFixed(2),
      })),
      // 검증용(#29): FAR/MID/FULL/focus overlay 중 필지당 정확히 하나만 보이는지 상태 스냅샷.
      debugLod: (id = null) => village.handle?.lodState?.(id) ?? null,
      // 검증용(#48): 좌표 클릭 대신 필지 id 로 직접 focus-in(돌리인+패널). 실사용 경로 villageSelect 재사용.
      debugFocus: (id) => {
        if (village.active && !village.transitioning && !villageWaveBusy() && !village.selected) villageSelect(id);
      },
      // 검증용(#48): 편집 오버레이 바운딩 크기 — 편집 전후 비교로 지오 변화 정량 확인.
      debugOverlayBox: (id) => village.handle?.overlayBox?.(id) ?? null,
      // 검증용(#93): 씬 기하 드로우콜 수(궁 편집 전/후·재생성 회귀 계측). 컴포저 최종 패스가
      //   info.render.calls 를 1(풀스크린 쿼드)로 덮으므로, 후처리 없는 씬 1회 렌더로 실측한다.
      debugDrawCalls: () => { renderer.render(scene, camera); return renderer.info.render.calls; },
      debugScreenOf(parcelId) {
        const pr = village.handle?.getPickProxy(parcelId);
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
      // 검증용(#14): 카메라 거리를 부감 화면 등가 거리의 frac 배로 설정하고 현재 렌즈의 실제
      // dolly로 변환한다(휠/핀치 등가). parcelId를 주면 그 필지를 조준하지만 선택 상태는 바꾸지 않는다.
      debugDolly(frac, parcelId = null) {
        if (!village.active || village.transitioning || villageWaveBusy()) return null;
        if (parcelId) { const pr = village.handle.getPickProxy(parcelId); if (pr) controls.target.copy(pr.worldCenter); }
        const d = villageCamera.distanceAtFraction(frac);
        const dir = new THREE.Vector3().subVectors(camera.position, controls.target);
        if (dir.lengthSq() < 1e-6) dir.set(0.2, 1, 1.9);
        dir.normalize();
        camera.position.copy(controls.target).addScaledVector(dir, d);
        camera.lookAt(controls.target); controls.update();
        return +camera.position.distanceTo(controls.target).toFixed(1);
      },
      debugContinuum: () => villageCamera.debugContinuum(),
      // 검증용(#95·#145): 카메라 고도·타깃·거리·near — A→B 전환 중 고도 튐 계측 + 거리종속 near 램프 확인.
      debugCamera: () => ({
        y: +camera.position.y.toFixed(1), targetY: +controls.target.y.toFixed(1),
        dist: +camera.position.distanceTo(controls.target).toFixed(1),
        near: +camera.near.toFixed(3), far: +camera.far.toFixed(0),
        selected: village.selected, transitioning: village.transitioning,
      }),
    },

    // 오디오 토글 (♪). 첫 호출 시 오디오 그래프 생성·재생.
    toggleAudio(onWanted) {
      const a = ensureAudio();
      a.start();
      a.setEnabled(onWanted);
      return onWanted;
    },

    // 사진 찍기: 현재 뷰 → 낙관 합성 PNG. 기존 postcard API 이름은 호환을 위해 유지한다.
    postcard({ download = true } = {}) {
      const prev = renderer.getPixelRatio();
      const bump = prev < 2;
      if (bump) { renderer.setPixelRatio(2); resizeAll(); }
      // 캡처 이미지엔 패널이 없으므로 뷰 오프셋(#124)을 빼고 피사체 중앙 프레이밍으로 캡처(캡처 후 복원).
      const restoreView = !!(camera.view && camera.view.enabled);
      if (restoreView) camera.clearViewOffset();
      const filename = `cheoma-${state.preset}-${state.seed}.png`;
      const url = capturePostcard(renderer, renderFrame, { title: 'cheoma', filename, download });
      if (bump) { renderer.setPixelRatio(prev); resizeAll(); }
      if (restoreView) viewShiftRuntime.invalidate();
      viewShiftRuntime.apply();
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
          if (disposed) return;
          const k = Math.min(1, (performance.now() - t0) / durMs);
          audio?.setBgmVolume(k);
          if (k < 1) requestAnimationFrame(stepFade);
        };
        requestAnimationFrame(stepFade);
        cinematic.play('reveal', { timeScale: revealScale });
        // 착공(조립 시작)을 크게 앞당김 — 타이틀 페이드 직후 기단이 올라오기 시작(중단 시 취소).
        let assembleTimer = setTimeout(() => {
          assembleTimer = null;
          if (disposed) return;
          building.visible = true;
          for (const w of wings) w.group.visible = true;
          if (typeof window !== 'undefined') window.__heroAssembleT = performance.now() - t0;
          startAssembly(assembleDur);
        }, assembleDelay);
        // reveal 자연 종료·사용자 중단(cinematic 내장 interrupt) 감시 → 컨트롤 인계.
        let handed = false;
        const iv = setInterval(() => {
          if (disposed) {
            handed = true;
            clearInterval(iv);
            if (assembleTimer) { clearTimeout(assembleTimer); assembleTimer = null; }
            return;
          }
          if (handed) { clearInterval(iv); return; }
          if (!cinematic.isActive()) {
            handed = true;
            clearInterval(iv);
            if (assembleTimer) { clearTimeout(assembleTimer); assembleTimer = null; }
            building.visible = true;
            for (const w of wings) w.group.visible = true;
            audio?.setBgmVolume(1);
            heroActive = false;             // reveal 종료 → 유휴 시 자동 회전 재개 허용
            weatherRef?.setWeather(state.weather); // 오프닝 자연 완료 시 날씨 복원
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
        weatherRef?.setWeather(state.weather); // 오프닝 스킵 시 날씨 복원
        onDone?.();
      },
    },

    // ---------- 시네마틱 데모 모드(#103·#112) ----------
    cine: {
      // mode 'drone'(opts.pass 지정 시 그 패스 1회, 없으면 오토플레이 체인 순환) | 'walk'(1인칭 autoStroll).
      start: (mode = 'drone', opts = {}) => startDemo(mode, opts),
      stop: () => stopDemo(),
      isActive: () => demo.active,
      available: () => cineAvailable(),
      // 1인칭 데스크톱 입력 피드(WASD/마우스). walk 모드일 때만 반영. { fwd, strafe, yaw, pitch, run }.
      input: (partial = {}) => demoRuntime.input(partial),
      // autoStroll 토글(walk) — 수동 조작 시 자동산책 중지. 다시 켜면 경로 복귀.
      setAutoStroll: (on) => demoRuntime.setAutoStroll(on),
      getState: () => demoRuntime.getState(),
      // 검증용: 드론 패스 목록·duration.
      passList: () => demoRuntime.passList(),
      // 검증용: 현재 드론 패스를 강제 완주(다음 프레임 전환/종료) — 긴 duration 대기 없이 체인 전이 관찰.
      debugAdvance: () => demoRuntime.debugAdvance(),
      // 검증용: walker 접지·경계·충돌(1인칭 히트박스 단언).
      debugWalker: () => demoRuntime.debugWalker(),
      // 검증용: 현재 카메라 pos/quat 유한성·시선(종료 인계 각도 연속성 계측).
      debugCam: () => ({
        pos: { x: +camera.position.x.toFixed(2), y: +camera.position.y.toFixed(2), z: +camera.position.z.toFixed(2) },
        finite: [camera.position.x, camera.position.y, camera.position.z, camera.quaternion.x, camera.quaternion.y, camera.quaternion.z, camera.quaternion.w].every(Number.isFinite),
        fov: +camera.fov.toFixed(2),
        look: (() => { const d = new THREE.Vector3(); camera.getWorldDirection(d); return { x: +d.x.toFixed(4), y: +d.y.toFixed(4), z: +d.z.toFixed(4) }; })(),
        controlsEnabled: controls.enabled,
        targetFinite: [controls.target.x, controls.target.y, controls.target.z].every(Number.isFinite),
      }),
    },

    resize: resizeAll,
    // 뷰포트 중심 보정 마스터 토글(#124) — App 이 !shot 로 설정. shot·검증 하네스는 오프셋 0(픽셀 불변).
    setViewShiftEnabled: (enabled) => viewShiftRuntime.setEnabled(enabled),
    renderer, scene, camera,
    __controls: controls,   // 검증용: 프레임 단위 controls.target 샘플링
    debugPostPassOrder: () => postRuntime.debugPassOrder(),
    debugPostResolution: () => postRuntime.debugResolution(),
    debugDof: debugDofState,
    debugDofSeek: debugSeekDofTween,
    debugRenderDofFrame: () => { renderFrame(0); return debugDofState(); },
    // Deterministic camera-transition gate: applies the exact live-frame particle/LOD
    // lens policy without drawing the large scene.
    debugSyncCameraEnvironment: () => syncCameraDependentEnvironment(
      village.active ? village.handle?.detailLodState?.() : null,
    ),
    debugSetPaused(paused = true) {
      debugPaused = !!paused;
      clock.getDelta();
      return debugPaused;
    },
    debugAdvancePost(seconds = 2) {
      const step = 0.05;
      const count = Math.max(1, Math.ceil(Math.max(0, seconds) / step));
      for (let i = 0; i < count; i++) post.update(step);
      return bokehPass.uniforms.highlightThreshold.value;
    },
    debugTuneDof({ amount, aperture, maxBlur } = {}) {
      if (Number.isFinite(aperture)) post.setDofAperture(aperture);
      if (Number.isFinite(maxBlur)) bokehPass.uniforms.maxblur.value = Math.max(0, maxBlur);
      if (Number.isFinite(amount)) post.setDofAmount(amount);
      return debugDofState();
    },
    debugAdvanceFocusRing(seconds = 3) {
      const step = 0.05;
      const count = Math.max(1, Math.ceil(Math.max(0, seconds) / step));
      for (let i = 0; i < count; i++) {
        if (village.active && village.handle) village.handle.updateLod(camera, controls.target, step);
        const lod = village.active
          ? (village.handle?.detailLodState?.() || { groundWeight: 0, particleWeight: 0 })
          : 1;
        focusRing.update(step, state.time, lod);
      }
      return focusRing.strength;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      renderer.setAnimationLoop(null);
      village.pregen = null;
      village.build = null;
      village.waveBuild = null;
      village.active = false;
      village.selected = null;
      village.transitioning = false;
      village.reveal = null;
      village.heroAsm = null;
      heroActive = false;
      hoverParcel = null;
      tween = null;
      groupAnims = [];
      if (rebuildTimer) { clearTimeout(rebuildTimer); rebuildTimer = null; }
      if (village.heroTimer) { clearTimeout(village.heroTimer); village.heroTimer = null; }
      demoRuntime.dispose();
      cinematic.dispose?.();
      removeEventListener('resize', resizeAll);
      for (const ev of activityEvents) removeEventListener(ev, markActivity);
      renderer.domElement.removeEventListener('pointermove', onCanvasPointerMove);
      renderer.domElement.removeEventListener('pointerdown', onCanvasPointerDown);
      renderer.domElement.removeEventListener('pointerup', onCanvasPointerUp);
      focusRing.dispose();
      nightGlowRef?.dispose?.();
      audio?.dispose?.();
      if (village.wave) {
        const wave = village.wave;
        village.wave = null;
        if (sun.shadow) sun.shadow.intensity = wave.shadowIntensity;
        wave.anim.dispose();
        scene.remove(wave.newHandle.group);
        if (wave.newHandle !== village.handle) wave.newHandle.dispose();
      }
      if (village.handle) { village.handle.exitVillageMode({ scene, building, ground, env }); village.handle.dispose(); village.handle = null; }
      if (village.cache.handle) { village.cache.handle.dispose(); village.cache = { key: null, handle: null }; }
      weatherRef?.dispose?.();
      postRuntime.dispose();
      env?.dispose?.();
      env = null;
      clearGhost();
      if (assembly) { assembly.skip(); assembly = null; }
      for (const wing of wings) {
        wing.assembly?.skip?.();
        scene.remove(wing.group);
        disposeWing(wing);
      }
      wings = [];
      if (building) { scene.remove(building); disposeBuilding(building); building = null; }
      scene.remove(ground);
      ground.geometry.dispose();
      ground.material.dispose();
      controls.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      for (const eventName of Object.keys(listeners)) listeners[eventName] = [];
      if (typeof window !== 'undefined' && window.__engine === controller) {
        delete window.__engine;
        delete window.__viewshift;
        delete window.__hero;
        delete window.__asm;
      }
    },
  };

  // 스크린샷/디버그 훅 (playwright 검증용)
  window.__engine = controller;
  // #124 뷰포트 중심 보정 검증 훅 — 현재/목표 시프트 px, 활성·프러스텀 offset 상태.
  window.__viewshift = {
    get enabled() { return viewShift.enabled; },
    get x() { return viewShift.curX; }, get y() { return viewShift.curY; },
    get tx() { return viewShift.tgtX; }, get ty() { return viewShift.tgtY; },
    get viewEnabled() { return !!(camera.view && camera.view.enabled); },
    setEnabled: (b) => controller.setViewShiftEnabled(b),
  };
  // #98 히어로 감동 계측 훅 — 조립 중 선회(방위각)·조립 단계·근접 링 강도·날씨 입자·무대(fog) 를
  // 코드/수치로만 검증(스크린샷 없이). village 내부 상태는 비노출이라 여기서만 읽기 전용 게터로 흘린다.
  window.__hero = {
    get selected() { return village.selected; },
    get transitioning() { return village.transitioning; },
    get heroAsm() { return !!village.heroAsm; },
    get reveal() { return village.reveal ? { e: village.reveal.e, dur: village.reveal.dur } : null; },
    get focusStrength() { return focusRing.strength; },
    get focusRetiring() { return focusRing.retiringCount; },
    // 방위각(라디안): 카메라가 타깃을 기준으로 도는 각. 조립 중 매초 변화율>0 을 단언.
    get az() { return Math.atan2(camera.position.x - controls.target.x, camera.position.z - controls.target.z); },
    get target() { return { x: controls.target.x, y: controls.target.y, z: controls.target.z }; },
    get camPos() { return { x: camera.position.x, y: camera.position.y, z: camera.position.z }; },
    get fogNear() { return scene.fog ? scene.fog.near : null; },
    get fogFar() { return scene.fog ? scene.fog.far : null; },
    get siteR() { return village.handle?.plan?.site?.R ?? null; },
    // #24 DoF: Bokeh uniform과 활성 의미 앵커의 카메라축 깊이 계측.
    get dofOn() { return !!(bokehPass && bokehPass.enabled); },
    get dofFocus() { return bokehPass ? bokehPass.uniforms.focus.value : null; },
    get dofTargetDepth() { return post.dof.depthAt(activeDofAnchor()) ?? dofTargetDepth; },
    // 하위 호환 이름. 이제 잘못된 유클리드 거리가 아니라 실제 Bokeh 축깊이를 반환한다.
    get dofTargetDist() { return post.dof.depthAt(activeDofAnchor()) ?? dofTargetDepth; },
    get dofAmount() { return post.dof.amount; },
    get dofAperture() { return bokehPass ? bokehPass.uniforms.aperture.value : null; },
    // #98 역광: 태양 방위(sun.position 실측)·히어로 종가 frontDir(rotY)·카메라 방위 — 역광 구도 단언.
    get sunAz() { return Math.atan2(sun.position.x, sun.position.z); },
    get heroRotY() { return village.heroRotY != null ? village.heroRotY : null; },
    get timeState() { return state.time; },
  };
  // #126 두부 조립 검증 훅 — 정지 seek(결정론 프레임)·활성·오버레이 청크 최대 스케일편차(정착 후
  //   재움직임=재트리거/늦은반동 검출). seek 은 heroAsm.update 와 경합하므로 캡처 시 __asmFreeze 로 정지.
  window.__asm = {
    get active() { return !!village.heroAsm; },
    get starts() { return village.asmStarts || 0; },   // compound 조립 인스턴스화 누적(재트리거=히어로 랜딩 중 delta>1)
    get frozen() { return !!village.asmFrozen; },
    freeze(b) { village.asmFrozen = !!b; },
    seek(t) { if (village.heroAsm && village.heroAsm.seek) { village.heroAsm.seek(t); renderFrame(); } },
    maxScaleDev() {
      const g = village.handle?.heroDetailGroup?.();
      if (!g) return null;
      let m = 0;
      g.traverse((o) => { if (o.scale) m = Math.max(m, Math.abs(o.scale.x - 1), Math.abs(o.scale.y - 1), Math.abs(o.scale.z - 1)); });
      return +m.toFixed(4);
    },
  };

  return controller;
}
