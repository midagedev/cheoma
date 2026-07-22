import {
  createArchitecturalReveal,
  createArchitecturalRevealTimeline,
} from '../../../src/api/cinematic.js';

// Imperative adapter for the renderer-free architectural reveal path. It owns
// camera/OrbitControls handoff and input interruption, but knows nothing about
// village generation, assemblies, Svelte, or shader warming.
export function createArchitecturalRevealRuntime({
  camera,
  controls,
  domElement,
  setComposition = () => {},
  getComposition = () => 0,
  getMotion = () => 'full',
  getReferenceFov = () => camera?.userData?.villageReferenceFov ?? camera?.fov,
  settleControls = () => {},
  cancelConflictingMotion = () => {},
  markActivity = () => {},
} = {}) {
  let shot = null;
  let timeline = null;
  let phase = 'idle'; // idle | holding | playing
  let reason = null;
  let onDone = null;
  let onInterrupt = null;
  let previousControlsEnabled = true;

  function capture({
    position = camera.position,
    target = controls.target,
    fov = camera.fov,
    referenceFov = getReferenceFov(),
    composition = getComposition(),
  } = {}) {
    return {
      position: { x: position.x, y: position.y, z: position.z },
      target: { x: target.x, y: target.y, z: target.z },
      fov,
      referenceFov,
      composition,
    };
  }

  function apply(sample) {
    camera.position.set(sample.position.x, sample.position.y, sample.position.z);
    controls.target.set(sample.target.x, sample.target.y, sample.target.z);
    camera.fov = sample.fov;
    camera.userData.villageReferenceFov = sample.referenceFov;
    setComposition(sample.composition);
    camera.updateProjectionMatrix();
    // This is intentionally explicit on every sampled frame. OrbitControls is
    // disabled while playing, and relying on its next update causes a finish snap.
    camera.lookAt(controls.target);
    camera.updateMatrixWorld(true);
    return sample;
  }

  function handoff() {
    settleControls();
    controls.enabled = previousControlsEnabled;
    // Keep controls and the camera on exactly the same final/current sightline.
    camera.lookAt(controls.target);
    camera.updateMatrixWorld(true);
    markActivity();
  }

  function finish(nextReason, { complete = false, notify = true } = {}) {
    if (phase === 'idle') return false;
    const done = onDone;
    const interrupted = onInterrupt;
    if (complete && timeline) apply(timeline.seek(1));
    phase = 'idle';
    reason = nextReason;
    onDone = null;
    onInterrupt = null;
    handoff();
    if (notify) {
      if (nextReason === 'complete') done?.();
      else if (nextReason === 'input') interrupted?.();
    }
    return true;
  }

  function begin(nextShot, callbacks = {}) {
    if (!nextShot) return false;
    if (phase !== 'idle') finish('replaced', { notify: false });
    cancelConflictingMotion();
    shot = nextShot;
    timeline = createArchitecturalRevealTimeline(nextShot);
    onDone = callbacks.onDone || null;
    onInterrupt = callbacks.onInterrupt || null;
    reason = null;
    previousControlsEnabled = controls.enabled;
    controls.enabled = false;
    phase = 'playing';
    apply(timeline.seek(0));
    if (nextShot.duration <= 0) finish('complete', { complete: true });
    return true;
  }

  function reveal(kind, destination, {
    from = capture(),
    seed = 0,
    subjectSize = 12,
    duration,
    prime: shouldPrime = false,
    onDone: done,
    onInterrupt: interrupted,
  } = {}) {
    const nextShot = createArchitecturalReveal({
      kind,
      from,
      to: capture(destination),
      seed,
      subjectSize,
      motion: getMotion(),
      duration,
    });
    return shouldPrime
      ? prime(nextShot)
      : begin(nextShot, { onDone: done, onInterrupt: interrupted });
  }

  function prime(nextShot) {
    if (!nextShot) return false;
    if (phase !== 'idle') finish('replaced', { notify: false });
    cancelConflictingMotion();
    shot = nextShot;
    timeline = createArchitecturalRevealTimeline(nextShot);
    reason = null;
    previousControlsEnabled = controls.enabled;
    controls.enabled = false;
    phase = 'holding';
    apply(timeline.seek(0));
    return true;
  }

  function playPrimed(callbacks = {}) {
    if (phase !== 'holding' || !shot) return false;
    onDone = callbacks.onDone || null;
    onInterrupt = callbacks.onInterrupt || null;
    reason = null;
    timeline = createArchitecturalRevealTimeline(shot);
    phase = 'playing';
    apply(timeline.seek(0));
    if (shot.duration <= 0) finish('complete', { complete: true });
    return true;
  }

  function update(dt) {
    if (phase !== 'playing' || !timeline) return false;
    apply(timeline.advance(dt));
    if (timeline.isDone()) finish('complete', { complete: true });
    return true;
  }

  function seek(progress, { finish: shouldFinish = false } = {}) {
    if (phase === 'idle' || !timeline) return null;
    const sample = apply(timeline.seek(progress));
    if (shouldFinish && progress >= 1) finish('complete', { complete: true });
    return { ...getState(), sample };
  }

  function interrupt() {
    if (phase !== 'playing') return;
    // Capture-phase listeners run before OrbitControls' target listener, so the
    // same pointerdown that cancels the reveal can immediately begin an orbit.
    finish('input');
  }

  const inputOptions = { capture: true, passive: true };
  domElement?.addEventListener('pointerdown', interrupt, inputOptions);
  domElement?.addEventListener('wheel', interrupt, inputOptions);
  domElement?.addEventListener('touchstart', interrupt, inputOptions);
  if (typeof window !== 'undefined') window.addEventListener('keydown', interrupt, inputOptions);

  function getState() {
    return {
      active: phase !== 'idle',
      phase,
      kind: shot?.kind || null,
      motion: shot?.motion || null,
      progress: timeline ? +timeline.progress().toFixed(4) : null,
      duration: shot?.duration ?? null,
      reason,
      controlsEnabled: controls.enabled,
      start: shot?.start || null,
      end: shot?.end || null,
    };
  }

  return {
    capture,
    reveal,
    begin,
    prime,
    playPrimed,
    update,
    seek,
    stop: (nextReason = 'cancelled', options) => finish(nextReason, options),
    isActive: () => phase !== 'idle',
    isPlaying: () => phase === 'playing',
    getState,
    dispose() {
      finish('disposed', { notify: false });
      domElement?.removeEventListener('pointerdown', interrupt, inputOptions);
      domElement?.removeEventListener('wheel', interrupt, inputOptions);
      domElement?.removeEventListener('touchstart', interrupt, inputOptions);
      if (typeof window !== 'undefined') window.removeEventListener('keydown', interrupt, inputOptions);
      shot = null;
      timeline = null;
    },
  };
}
