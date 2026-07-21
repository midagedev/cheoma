import {
  createDirectionController,
  createDronePaths,
  createWalker,
} from '../../../src/api/cinematic.js';

const clamp01 = (value) => Math.min(1, Math.max(0, value));
const DRONE_CHAIN = ['crane-in', 'landmark-orbit', 'street-flythrough', 'pullback-reveal'];
const DEG = Math.PI / 180;

// 마을 시네마틱의 상태기계. 씬 전환 정책은 콜백으로 받고 카메라 경로 구동만 소유한다.
// 명명된 드론 패스 사이의 위치 컷은 유지하되 시선은 가속도 제한 컨트롤러로 연속 인계한다.
export function createCinematicRuntime({
  camera,
  cancelTween,
  controls,
  village,
  focusOutDuration,
  clearHover,
  emit,
  getAerial,
  markActivity,
  reapplyVillageFog,
  returnFromFocus,
  setPostFocus,
  setZoomRegime,
  settleControls,
  stopHeroDrive,
  tweenTo,
} = {}) {
  const viewDirection = camera.position.clone();
  camera.getWorldDirection(viewDirection);
  const droneLook = createDirectionController({
    direction: viewDirection,
    // Axis limits combine to a <=72.2°/s spherical turn, including diagonal
    // yaw+pitch changes at a pass boundary.
    maxYawSpeed: 60 * DEG,
    maxYawAcceleration: 150 * DEG,
    maxPitchSpeed: 40 * DEG,
    maxPitchAcceleration: 100 * DEG,
  });
  const state = {
    active: false,
    mode: null,
    paths: null,
    walker: null,
    chain: [],
    chainIdx: 0,
    pass: null,
    t: 0,
    single: null,
    lastLook: camera.position.clone(),
    input: { fwd: 0, strafe: 0, yaw: 0, pitch: 0, run: false },
    ambT: 0,
    viewReady: false,
    desiredLook: camera.position.clone(),
    smoothedLook: camera.position.clone(),
  };

  const available = () => !!(
    village.active
    && village.handle
    && !village.wave
    && !village.heroAsm
    && !village.transitioning
  );

  function turnRateDegrees() {
    if (!state.active) return 0;
    const rate = state.mode === 'walk' && state.walker
      ? Math.abs(state.walker.turnRate())
      : droneLook.angularSpeed;
    return +(rate / DEG).toFixed(2);
  }

  function paths() {
    const plan = village.handle.plan;
    const { site } = plan;
    return createDronePaths({
      site,
      plan,
      heightAt: (x, z) => site.heightAt(x, z),
      seed: village.seed,
    });
  }

  function start(mode = 'drone', opts = {}) {
    if (!available()) return false;
    if (village.selected) {
      returnFromFocus();
      setTimeout(() => {
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
    state.viewReady = false;
    Object.assign(state.input, { fwd: 0, strafe: 0, yaw: 0, pitch: 0, run: false });
    controls.enabled = false;
    setPostFocus(false);
    reapplyVillageFog();

    const plan = village.handle.plan;
    const { site } = plan;
    if (mode === 'walk') {
      state.walker = createWalker({ site, plan, heightAt: (x, z) => site.heightAt(x, z) });
      state.walker.startAutoStroll();
      camera.near = 0.08;
      camera.updateProjectionMatrix();
      state.pass = null;
      state.chain = [];
      state.single = null;
      // Walk framing was authored at its physical FOV, without compensated dolly.
      // Clear a preceding house/landmark profile so local-detail LOD stays literal.
      camera.userData.villageReferenceFov = camera.fov;
    } else {
      state.paths = paths();
      const byName = Object.fromEntries(state.paths.map((path) => [path.name, path]));
      if (opts.pass && byName[opts.pass]) {
        state.chain = [byName[opts.pass]];
        state.single = opts.pass;
      } else {
        state.chain = DRONE_CHAIN.map((name) => byName[name]).filter(Boolean);
        state.single = null;
      }
      state.chainIdx = 0;
      state.pass = state.chain[0];
      state.t = 0;
    }
    markActivity();
    emit('cinematic', {
      active: true,
      mode,
      pass: state.pass ? state.pass.name : null,
      index: 0,
    });
    return true;
  }

  function update(dt) {
    let lookAt;
    if (state.mode === 'walk') {
      const { pos, dir } = state.walker.update(dt, state.input);
      camera.position.copy(pos);
      lookAt = state.smoothedLook.copy(pos).add(dir);
    } else {
      if (!state.pass) return;
      state.t += dt / state.pass.duration;
      if (state.t >= 1) {
        if (state.single) {
          stop();
          return;
        }
        state.t = 0;
        state.chainIdx = (state.chainIdx + 1) % state.chain.length;
        state.pass = state.chain[state.chainIdx];
        emit('cinematic', {
          active: true,
          mode: 'drone',
          pass: state.pass.name,
          index: state.chainIdx,
        });
      }
      const sample = state.pass.sample(clamp01(state.t));
      camera.position.copy(sample.pos);
      if (sample.fov != null && Math.abs(camera.fov - sample.fov) > 1e-3) {
        camera.fov = sample.fov;
        camera.updateProjectionMatrix();
      }
      if (sample.fov != null) camera.userData.villageReferenceFov = sample.referenceFov ?? sample.fov;
      state.desiredLook.copy(sample.lookAt).sub(sample.pos);
      if (!state.viewReady) {
        droneLook.reset(state.desiredLook);
        state.viewReady = true;
      }
      const direction = droneLook.step(state.desiredLook, dt);
      viewDirection.set(direction.x, direction.y, direction.z);
      const lookDistance = Math.max(1, sample.pos.distanceTo(sample.lookAt));
      lookAt = state.smoothedLook.copy(sample.pos).addScaledVector(viewDirection, lookDistance);
    }

    // 종료 시 OrbitControls로 방향을 연속 인계할 수 있도록 매 프레임 같은 시선을 공유한다.
    camera.lookAt(lookAt);
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
      const ahead = state.pass.sample(clamp01(state.t + 2.5 / state.pass.duration));
      x = ahead.pos.x;
      z = ahead.pos.z;
    }
    try { hook(x, z); } catch {}
  }

  function stop() {
    if (!state.active) return;
    state.active = false;
    const wasWalk = state.mode === 'walk';
    state.mode = null;
    state.pass = null;
    state.walker = null;
    state.chain = [];
    state.single = null;
    state.viewReady = false;
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
    input(partial = {}) {
      if (state.active && state.mode === 'walk') Object.assign(state.input, partial);
    },
    setAutoStroll(on) {
      if (state.walker) on ? state.walker.startAutoStroll() : state.walker.stopAutoStroll();
    },
    getState: () => ({
      active: state.active,
      mode: state.mode,
      pass: state.pass ? state.pass.name : null,
      index: state.chainIdx,
      chain: state.chain.map((path) => path.name),
      single: state.single,
      t: +state.t.toFixed(3),
      turnRateDeg: turnRateDegrees(),
    }),
    passList: () => (village.handle
      ? paths().map(({ name, kind, duration }) => ({ name, kind, duration }))
      : []),
    debugAdvance() {
      if (state.active && state.mode === 'drone') state.t = 1;
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
    } : null),
    dispose() {
      state.active = false;
      state.walker = null;
      state.chain = [];
      state.pass = null;
      state.viewReady = false;
    },
  };
}
