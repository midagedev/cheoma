const DEFAULTS = Object.freeze({
  enterSpeed: 18,
  exitSpeed: 7,
  settleHold: 0.12,
  settleDuration: 0.22,
});

const clamp01 = (value) => Math.max(0, Math.min(1, value));
const smoothstep = (value) => {
  const t = clamp01(value);
  return t * t * (3 - 2 * t);
};

/**
 * Frame-rate-independent quality state for an adaptive post effect.
 *
 * `motionPx` is the screen-space displacement accumulated over `dt`. The state
 * converts it to px/s before applying hysteresis, so the same camera path has
 * the same result at 60 Hz, 120 Hz, and across a bounded long frame. The object
 * is mutated and returned in place; live frames allocate nothing here.
 */
export function createPostQualityState(options = {}) {
  const config = { ...DEFAULTS, ...options };
  if (!(config.enterSpeed > config.exitSpeed && config.exitSpeed >= 0)) {
    throw new RangeError('post quality requires enterSpeed > exitSpeed >= 0');
  }
  if (!(config.settleHold >= 0 && config.settleDuration > 0)) {
    throw new RangeError('post quality requires settleHold >= 0 and settleDuration > 0');
  }

  const state = {
    mode: 'stable',
    quality: 1,
    speed: 0,
    quietTime: 0,
    settleTime: config.settleDuration,
    update(dt, motionPx = 0) {
      if (!(dt > 0) || !Number.isFinite(dt)) return state;
      const displacement = Number.isFinite(motionPx) ? Math.max(0, motionPx) : 0;
      state.speed = displacement / dt;

      if (state.speed >= config.enterSpeed) {
        state.mode = 'moving';
        state.quality = 0;
        state.quietTime = 0;
        state.settleTime = 0;
        return state;
      }

      if (state.mode === 'stable') return state;

      if (state.speed > config.exitSpeed) {
        state.mode = 'moving';
        state.quality = 0;
        state.quietTime = 0;
        state.settleTime = 0;
        return state;
      }

      if (state.mode === 'moving') {
        const beforeHold = state.quietTime;
        state.quietTime = Math.min(config.settleHold, beforeHold + dt);
        if (state.quietTime + 1e-12 < config.settleHold) return state;
        state.mode = 'settling';
        state.settleTime = Math.max(0, dt - (config.settleHold - beforeHold));
      } else {
        state.settleTime += dt;
      }

      if (state.settleTime + 1e-12 >= config.settleDuration) {
        state.mode = 'stable';
        state.quality = 1;
        state.settleTime = config.settleDuration;
        return state;
      }

      state.quality = smoothstep(state.settleTime / config.settleDuration);
      return state;
    },
    reset() {
      state.mode = 'stable';
      state.quality = 1;
      state.speed = 0;
      state.quietTime = 0;
      state.settleTime = config.settleDuration;
      return state;
    },
  };
  return state;
}
