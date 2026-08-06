import {
  createDronePaths,
  createWalker,
} from '../../../src/api/cinematic.js';
import { STRIDE_RUN, STRIDE_WALK } from '../../../src/api/audio.js';

const clamp01 = (value) => Math.min(1, Math.max(0, value));
const DEG = Math.PI / 180;
// 뱅킹 지연은 **없다**. 표본 롤은 dronepath 가 이미 원뿔(슬루) 제한 + 주기 Hann 으로 만든 연속
//   신호이고, 그 위에 1차 지연을 얹으면 지연 이득이 dt 를 타면서 프레임 시간 흔들림이 그대로 롤
//   흔들림이 된다(#42 프로브 실측: 지연 min(1,dt/τ) 는 ±18% dt 흔들림에서 프레임 잔차 0.023~0.105°,
//   dt 불변형 1-exp(-dt/τ) 로 고쳐도 0.14~0.17° — 지연이 남아 있는 한 정상 상태 오차 e=φ̇·τ 가
//   dt 흔들림을 증폭한다). 시선과 같은 원칙이다: **한 번만 제어한다.**

// 마을 시네마틱의 상태기계. 씬 전환 정책은 콜백으로 받고 카메라 경로 구동만 소유한다.
//
// ── 드론 재생은 **하나의 τ 진행**이다(#42, 2026-08-02) ──
// dronepath 가 내는 것은 하나의 닫힌 곡선이고, leg 는 그 위의 시간 창(라벨)일 뿐이다. 종전 러너는
//   패스를 체인으로 이어 붙이며 경계마다 t 를 리셋했고, 그 경계에서 리셋되는 상태(시선 스무딩 누적,
//   롤 지연)가 전환감의 물증이었다. 이제 τ 하나만 진행시키고 leg 는 τ 로 조회한다 — 경계에서
//   리셋되는 상태가 **존재하지 않는다**.
//
// ── 시선을 두 번 제어하지 않는다 ──
// dronepath 의 방향장은 이미 Hann 1.05s 짐벌 관성과 저작 요 상한이 걸린 신호다. 그 위에 가속도
//   제한 컨트롤러(createDirectionController)를 한 겹 더 얹으면 그 컨트롤러는 bang-bang 이라
//   목표 근처에서 프레임마다 부호를 뒤집는다(속도가 accel·dt 단위로만 변하므로 원하는 속도가 그
//   양자보다 작아지는 순간 넘었다 되돌아온다). #42 프로브 실측: 저작 방향장의 프레임 잔차는
//   0.0001° 인데 컨트롤러 출력은 0.018~0.056°(부호 교대율 84~100%), 가변 프레임에서는 투어 전체
//   최대 0.20°. 사용자가 "시작부터 떨린다"고 본 것이 이것이다. 그래서 컨트롤러를 걷어내고 표본
//   방향을 그대로 카메라에 넣는다.
export function createCinematicRuntime({
  camera,
  cancelTween,
  controls,
  village,
  focusOutDuration,
  clearHover,
  emit,
  getAerial,
  getSunAzimuth,
  markActivity,
  reapplyVillageFog,
  returnFromFocus,
  setPostFocus,
  setZoomRegime,
  settleControls,
  stopHeroDrive,
  tweenTo,
  footstep = null,
  footLand = null,
} = {}) {
  const state = {
    active: false,
    mode: null,
    paths: null,
    walker: null,
    lastStepDist: 0,     // 마지막 발소리를 낸 누적 보행거리(m) — 발소리 케이던스 기준점
    legs: [],
    legIdx: 0,
    tour: null,          // 투어 표본기(모든 leg 이 공유하는 같은 함수)
    tourDuration: 0,
    tau: 0,              // **단일 진행**. leg 경계는 이 값의 조회일 뿐이다.
    window: null,        // opts.pass 단독 재생 시 [t0, t1]
    single: null,
    lastLook: camera.position.clone(),
    input: { fwd: 0, strafe: 0, yaw: 0, pitch: 0, run: false },
    ambT: 0,
    roll: null,
    viewReady: false,
    smoothedLook: camera.position.clone(),
  };
  const legAt = (tau) => {
    const legs = state.legs;
    let k = 0;
    for (let i = 0; i < legs.length; i++) if (tau >= legs[i].t0) k = i;
    return k;
  };
  let disposed = false;
  let pendingStart = null;
  // #36 투어 첫 프레임 전 shader warm 동안 t 를 고정한다. warm 이 LOD FULL 재질을 링크하는
  //   동안 카메라가 저공으로 진행하면 같은 재질이 첫 드로우에서 다시 링크 스톨을 낸다.
  let warmHold = false;

  function cancelPendingStart() {
    if (pendingStart == null) return;
    clearTimeout(pendingStart);
    pendingStart = null;
  }

  const available = () => !!(
    !disposed
    && village.active
    && village.handle
    && !village.wave
    && !village.heroAsm
    && !village.transitioning
  );

  // 시선 각속도 — 워킹뷰는 walker 가, 드론은 경로 표본의 프레임 간 각으로 잰다(제어기가 없으므로
  //   컨트롤러 상태가 아니라 실제 프레임 델타가 유일한 진실이다).
  let lastDroneDir = null;
  let droneTurnRate = 0;
  function turnRateDegrees() {
    if (!state.active) return 0;
    const rate = state.mode === 'walk' && state.walker
      ? Math.abs(state.walker.turnRate())
      : droneTurnRate;
    return +(rate / DEG).toFixed(2);
  }

  function paths() {
    const plan = village.handle.plan;
    const { site } = plan;
    // 실측 태양 방위(라디안, atan2(sunDir.x, sunDir.z))를 넘겨 crane-in·orbit·pullback 방위를 역광으로
    // 정렬한다. 히어로 랜딩이 방위를 고정한 상태(heroSunAz)도 그대로 반영된다. 값이 없으면 남향 고정.
    const sunAzimuth = typeof getSunAzimuth === 'function' ? getSunAzimuth() : null;
    return createDronePaths({
      site,
      plan,
      heightAt: (x, z) => site.heightAt(x, z),
      seed: village.seed,
      sunAzimuth: Number.isFinite(sunAzimuth) ? sunAzimuth : null,
    });
  }

  function start(mode = 'drone', opts = {}) {
    if (disposed) return false;
    if (!available()) return false;
    cancelPendingStart();
    if (village.selected) {
      returnFromFocus();
      pendingStart = setTimeout(() => {
        pendingStart = null;
        if (available() && !village.selected) start(mode, opts);
      }, focusOutDuration * 1000 + 140);
      return true;
    }

    cancelTween();
    stopHeroDrive();
    clearHover();
    state.mode = mode;
    state.active = true;
    state.ambT = 0;
    state.roll = 0;
    state.viewReady = false;
    Object.assign(state.input, { fwd: 0, strafe: 0, yaw: 0, pitch: 0, run: false });
    controls.enabled = false;
    setPostFocus(false);
    reapplyVillageFog();

    const plan = village.handle.plan;
    const { site } = plan;
    if (mode === 'walk') {
      state.walker = createWalker({ site, plan, heightAt: (x, z) => site.heightAt(x, z) });
      state.lastStepDist = 0;
      // #33: 워킹뷰는 사용자가 조작하는 탐험 모드다. 진입 즉시 정지 상태로 서 있고 입력을 기다린다
      //   (종전에는 여기서 startAutoStroll() 로 자동 산책을 걸었다). 자동 산책은 명시 API 로만.
      camera.near = 0.08;
      camera.updateProjectionMatrix();
      state.legs = [];
      state.tour = null;
      state.single = null;
      state.window = null;
      // Walk framing was authored at its physical FOV, without compensated dolly.
      // Clear a preceding house/landmark profile so local-detail LOD stays literal.
      camera.userData.villageReferenceFov = camera.fov;
    } else {
      state.paths = paths();
      state.legs = state.paths;
      state.tour = state.paths[0].sampleTour;
      state.tourDuration = state.paths[0].tourDuration;
      const named = state.paths.find((path) => path.name === opts.pass);
      if (opts.pass && named) {
        // 단독 재생도 같은 τ 축을 쓴다 — 창만 좁힌다(별도 재생 경로를 만들지 않는다).
        state.single = opts.pass;
        state.window = [named.t0, named.t1];
        state.tau = named.t0;
      } else {
        state.single = null;
        state.window = null;
        state.tau = 0;
      }
      state.legIdx = legAt(state.tau);
      state.roll = null;
      lastDroneDir = null;
    }
    markActivity();
    emit('cinematic', {
      active: true,
      mode,
      pass: state.legs.length ? state.legs[state.legIdx].name : null,
      index: state.legIdx,
    });
    return true;
  }

  function update(dt) {
    if (disposed) return;
    if (!state.active) return;
    // warm hold: 시작 자세만 유지하고 t·walker 시계는 얼린다(#36).
    const stepDt = warmHold ? 0 : dt;
    let lookAt;
    if (state.mode === 'walk') {
      // 입력은 input() 이 이미 walker 로 밀어넣었다(이동=지속 상태, 시선=누적 델타). 여기서 다시
      //   state.input 을 넘기면 같은 시선 델타를 매 프레임 재적용해 드래그가 무한 회전이 된다.
      const { pos, dir } = state.walker.update(stepDt);
      camera.position.copy(pos);
      lookAt = state.smoothedLook.copy(pos).add(dir);
      // 발소리(2026-08-06) — 케이던스는 시간이 아니라 **보폭 누적**에서 나온다. walker 가 접지
      //   이동거리만 적립하므로 비행·체공 중에는 자동으로 조용하고, 저fps 에서도 걸음 수가
      //   어긋나지 않는다. 달리기 판정은 속도 중간값 기준(램프 중 깜박임 방지).
      if (footstep) {
        const dist = state.walker.strideDistance();
        const running = state.walker.speed() > (state.walker.walkSpeed + state.walker.runSpeed) / 2;
        const stride = running ? STRIDE_RUN : STRIDE_WALK;
        if (state.walker.grounded() && dist - state.lastStepDist >= stride) {
          state.lastStepDist = dist;
          footstep(running ? 1 : 0.5);
        } else if (dist < state.lastStepDist) {
          state.lastStepDist = dist;   // walker 재생성·순간이동으로 누적이 되돌아간 경우
        }
      }
      if (footLand) {
        const impact = state.walker.takeLandImpact();
        if (impact > 0) footLand(impact);
      }
    } else {
      if (!state.tour) return;
      if (!warmHold) {
        // **단일 진행**. leg 경계에 넘침 환산도, t 리셋도, 상태 초기화도 없다 — 경계가 없기 때문이다.
        state.tau += stepDt / state.tourDuration;
        if (state.window) {
          if (state.tau >= state.window[1]) { stop(); return; }
        } else if (state.tau >= 1) {
          state.tau -= Math.floor(state.tau);   // 닫힌 곡선이라 그대로 순환한다
        }
        const nextLeg = legAt(state.tau);
        if (nextLeg !== state.legIdx) {
          state.legIdx = nextLeg;
          // 라벨 갱신일 뿐 재생에는 아무 영향이 없다(HUD·오버레이 소비면 계약 유지).
          emit('cinematic', {
            active: true,
            mode: 'drone',
            pass: state.legs[state.legIdx].name,
            index: state.legIdx,
          });
        }
      }
      const sample = state.tour(clamp01(state.tau));
      camera.position.copy(sample.pos);
      if (sample.fov != null && Math.abs(camera.fov - sample.fov) > 1e-3) {
        camera.fov = sample.fov;
        camera.updateProjectionMatrix();
      }
      if (sample.fov != null) camera.userData.villageReferenceFov = sample.referenceFov ?? sample.fov;
      // 시선은 **표본 그대로** 쓴다(위 헤더 주석: 두 번 제어하지 않는다). 진단용 각속도만 여기서 잰다.
      const dirX = sample.lookAt.x - sample.pos.x;
      const dirY = sample.lookAt.y - sample.pos.y;
      const dirZ = sample.lookAt.z - sample.pos.z;
      const dirLen = Math.hypot(dirX, dirY, dirZ) || 1;
      const nx = dirX / dirLen, ny = dirY / dirLen, nz = dirZ / dirLen;
      if (lastDroneDir && stepDt > 0) {
        const dot = Math.min(1, Math.max(-1,
          lastDroneDir[0] * nx + lastDroneDir[1] * ny + lastDroneDir[2] * nz));
        droneTurnRate = Math.acos(dot) / stepDt;
      }
      lastDroneDir = [nx, ny, nz];
      state.viewReady = true;
      lookAt = state.smoothedLook.copy(sample.lookAt);
      // 뱅킹 — dronepath 가 궤적 곡률·속도에서 유도한 롤(라디안). lookAt 뒤에 별도로 적용한다(아래).
      //   표본을 **그대로** 쓴다(위 주석: 한 번만 제어한다). 재생 시작 롤이 0 이 아니어도 그것이
      //   그 비행 시점의 옳은 자세다 — 0 에서 끌어올리는 램프가 오히려 없는 기동을 만든다.
      state.roll = Number.isFinite(sample.roll) ? sample.roll : 0;
    }

    // 종료 시 OrbitControls로 방향을 연속 인계할 수 있도록 매 프레임 같은 시선을 공유한다.
    camera.lookAt(lookAt);
    // lookAt 은 up=(0,1,0) 기준으로 자세를 다시 세우므로 롤은 그 **뒤에** 얹어야 한다. 로컬 +Z 는
    //   카메라 뒤를 향하고, 그 축의 양의 회전은 화면 up 을 왼쪽으로 눕힌다 — dronepath 의 부호 규약과
    //   같으므로 값을 그대로 넣는다. 워킹뷰는 롤이 없다(state.roll 은 진입 시 0 으로 리셋된다).
    if (state.mode === 'drone' && state.roll) camera.rotateZ(state.roll);
    state.lastLook.copy(lookAt);
    controls.target.copy(lookAt);
    state.ambT += dt;
    if (state.ambT < 1) return;
    state.ambT = 0;
    const hook = typeof window !== 'undefined' && window.__ambLookahead;
    if (typeof hook !== 'function') return;
    let x;
    let z;
    if (state.mode === 'walk') {
      x = lookAt.x;
      z = lookAt.z;
    } else {
      const ahead = state.tour(clamp01((state.tau + 2.5 / state.tourDuration) % 1));
      x = ahead.pos.x;
      z = ahead.pos.z;
    }
    try { hook(x, z); } catch {}
  }

  function stop() {
    cancelPendingStart();
    warmHold = false;
    if (disposed) return;
    if (!state.active) return;
    state.active = false;
    const wasWalk = state.mode === 'walk';
    state.mode = null;
    state.walker = null;
    state.legs = [];
    state.tour = null;
    state.single = null;
    state.window = null;
    state.viewReady = false;
    state.roll = null;
    lastDroneDir = null;
    controls.enabled = true;
    reapplyVillageFog();
    controls.target.copy(state.lastLook);
    if (village.active && village.handle) {
      const framing = getAerial();
      setPostFocus(false);
      tweenTo(framing.pos, framing.target, wasWalk ? 1.3 : 1.0, {
        fov: framing.fov,
        referenceFov: framing.referenceFov,
        onDone: () => setZoomRegime('explore'),
      });
    } else {
      camera.lookAt(controls.target);
      settleControls();
    }
    markActivity();
    emit('cinematic', { active: false });
  }

  return {
    state,
    available,
    start,
    stop,
    update,
    // #36 투어 진행 hold — engine 이 LOD 서브트리 compileAsync 완료 전/후에 토글한다.
    setWarmHold(on) {
      warmHold = !!on;
    },
    isWarmHold: () => warmHold,
    // 이동 의도(fwd/strafe/run)는 지속 상태로 walker 가 소유하고, 시선은 델타라 누적 후 1회 소비된다.
    //   lookDX/lookDY 는 픽셀(감도는 코어 소유), yaw/pitch 는 라디안(하위 호환).
    input(partial = {}) {
      if (!state.active || state.mode !== 'walk' || !state.walker) return;
      Object.assign(state.input, partial);
      state.walker.setInput(partial);
      if (partial.lookDX || partial.lookDY) state.walker.look(partial.lookDX || 0, partial.lookDY || 0);
      if (partial.yaw || partial.pitch) state.walker.lookRadians(partial.yaw || 0, partial.pitch || 0);
    },
    setAutoStroll(on) {
      if (state.walker) on ? state.walker.startAutoStroll() : state.walker.stopAutoStroll();
    },
    // 크리에이티브 비행 토글. 데스크톱은 점프 더블탭이 코어에서 판정되므로 이 경로가 필요 없지만,
    //   키보드가 없는 표면(모바일 HUD 버튼)과 하네스는 명시 토글이 필요하다.
    setFly(on) { return state.walker ? state.walker.setFly(on) : false; },
    flying() { return state.walker ? state.walker.flying() : false; },
    getState: () => {
      const leg = state.legs[state.legIdx] || null;
      // t 는 **현재 leg 안의 진행률**로 보고한다(소비면 호환). 재생 자체는 τ 하나이므로 이 값은
      //   파생 진단이지 상태가 아니다.
      const span = leg ? Math.max(1e-9, leg.t1 - leg.t0) : 1;
      return {
        active: state.active,
        mode: state.mode,
        pass: leg ? leg.name : null,
        index: state.legIdx,
        chain: state.legs.map((path) => path.name),
        single: state.single,
        t: leg ? +clamp01((state.tau - leg.t0) / span).toFixed(3) : 0,
        tau: +state.tau.toFixed(4),
        turnRateDeg: turnRateDegrees(),
        rollDeg: +((state.roll || 0) / DEG).toFixed(2),
        warmHold,
      };
    },
    passList: () => (village.handle
      ? paths().map(({ name, kind, duration }) => ({ name, kind, duration }))
      : []),
    // 임의 τ 로 시크한다(진단 전용). 재생이 **단일 τ** 가 되면서 비로소 가능해진 affordance 다 —
    //   종전 패스 체인에서는 구간마다 별도 시계라 임의 지점으로 점프할 수 없었고, 그래서 스토리보드
    //   캡처가 authored duration 을 실시간으로 흘려보내야 했다. 여정 전체를 등간격으로 훑는 캡처는
    //   이 훅 없이는 만들 수 없다. 제품 경로는 이 함수를 부르지 않는다.
    debugSeek(tau) {
      if (!state.active || state.mode !== 'drone' || !state.tour) return false;
      const v = Number(tau);
      if (!Number.isFinite(v)) return false;
      state.tau = ((v % 1) + 1) % 1;
      state.legIdx = legAt(state.tau);
      lastDroneDir = null;
      update(0);
      return true;
    },
    // 다음 leg 경계로 건너뛴다(진단 전용). 재생은 여전히 같은 τ 축 위에 있다.
    debugAdvance() {
      if (!state.active || state.mode !== 'drone' || !state.legs.length) return;
      const next = (state.legIdx + 1) % state.legs.length;
      state.tau = next === 0 ? 0 : state.legs[next].t0;
      state.legIdx = next;
      if (state.window) state.window = [state.legs[next].t0, state.legs[next].t1];
    },
    debugWalker: () => (state.walker ? {
      clearance: +state.walker.groundClearance().toFixed(3),
      eyeHeight: state.walker.eyeHeight,
      colliding: state.walker.isColliding(),
      outside: state.walker.outsideBoundary(),
      pos: {
        x: +state.walker.pos.x.toFixed(2),
        y: +state.walker.pos.y.toFixed(2),
        z: +state.walker.pos.z.toFixed(2),
      },
      turnRateDeg: +(state.walker.turnRate() / DEG).toFixed(2),
      turnarounds: state.walker.turnaroundCount(),
      // #33 수동 조작 검증: 진행 속도(m/s)·시선각·자동산책 여부.
      speed: +state.walker.speed().toFixed(3),
      yawDeg: +(state.walker.yaw / DEG).toFixed(2),
      pitchDeg: +(state.walker.pitch / DEG).toFixed(2),
      autoStroll: state.walker.autoStroll,
    } : null),
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelPendingStart();
      state.active = false;
      state.walker = null;
      state.legs = [];
      state.tour = null;
      state.viewReady = false;
    },
  };
}
