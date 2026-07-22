import { createInkPass } from '../../../src/api/ink.js';
import { normalizeRenderStyle } from '../../../src/api/render-style.js';

const EPSILON = 1e-4;
const FADE_SECONDS = 0.72;

/**
 * Product render-style state machine.
 *
 * Ink stays inside the app's one composer and immediately before its one OutputPass.
 * PBR effects remain live beneath the transition, then sleep only after the paper image
 * fully covers them. The reverse transition wakes them behind an opaque ink frame first,
 * so neither direction exposes a pass-enable pop.
 */
export function createInkModeRuntime({
  renderer,
  scene,
  camera,
  postRuntime,
  compact = false,
  reducedMotion = false,
} = {}) {
  const { post } = postRuntime;
  let style = 'pbr';
  let amount = 0;
  let target = 0;
  let ink = null;
  let disposed = false;
  let pbrAwake = true;
  const policy = {
    focused: true,
    flare: !!post.flarePass.enabled,
    dofAmount: post.dof.amount,
  };

  function ensureInk() {
    if (ink) return ink;
    ink = createInkPass(scene, camera, {
      // Edges tolerate a reduced normal/depth target; color and paper remain full resolution.
      resolutionScale: compact ? 0.5 : 0.75,
      // The paper is broad, low-frequency grain. A bounded source avoids walking a 4M-pixel
      // canvas on the first input event while preserving lazy GPU allocation in default PBR.
      paperSize: compact ? 512 : 1024,
      uniforms: {
        mixAmount: amount,
        silhouetteWidth: compact ? 2.2 : 2.6,
      },
    });
    postRuntime.addPassAfterRender(ink.sourcePass, 'InkBeautyCapturePass');
    ink.sourcePass.enabled = amount > EPSILON || target > EPSILON;
    ink.pass.enabled = amount > EPSILON;
    postRuntime.addPassBeforeOutput(ink.pass, 'InkPass');
    const size = renderer.getSize({ set(x, y) { this.x = x; this.y = y; return this; } });
    ink.setSize(size.x, size.y, renderer.getPixelRatio());
    return ink;
  }

  function setPbrAwake(awake) {
    if (pbrAwake === awake) return;
    pbrAwake = awake;
    if (post.gradePass) {
      const saturation = post.gradePass.uniforms?.sat?.value ?? 1;
      post.gradePass.enabled = awake && Math.abs(saturation - 1) > EPSILON;
    }
    post.bloomPass.enabled = awake;
    // Fresnel rim/sun glow belong to the raw scene beauty and cost no duplicate scene pass.
    // Keep that source policy stable while only the covered fullscreen effects sleep.
    post.setFlareEnabled?.(awake && policy.flare);
    post.setDofAmount?.(awake ? policy.dofAmount : 0);
  }

  function applyAmount(next) {
    amount = Math.min(1, Math.max(0, next));
    const entry = amount > EPSILON || target > EPSILON ? ensureInk() : ink;
    if (entry) {
      entry.sourcePass.enabled = amount > EPSILON || target > EPSILON;
      entry.pass.uniforms.mixAmount.value = amount;
      entry.pass.enabled = amount > EPSILON;
    }
    if (amount >= 1 - EPSILON && target >= 1 - EPSILON) setPbrAwake(false);
    else if (amount < 1 - EPSILON) setPbrAwake(true);
  }

  function setMode(value, { immediate = false } = {}) {
    style = normalizeRenderStyle(value);
    target = style === 'ink' ? 1 : 0;
    if (target > 0) ensureInk();
    if (target === 0) setPbrAwake(true);
    if (immediate || reducedMotion) applyAmount(target);
    return style;
  }

  function setFocusPolicy({ focused = policy.focused, flare = focused, dofAmount = policy.dofAmount } = {}) {
    policy.focused = !!focused;
    policy.flare = !!flare;
    policy.dofAmount = Number.isFinite(dofAmount) ? Math.min(1, Math.max(0, dofAmount)) : 0;
    post.setRimEnabled?.(policy.focused);
    if (pbrAwake) {
      post.setFlareEnabled?.(policy.flare);
      post.setDofAmount?.(policy.dofAmount);
    }
  }

  function update(dt) {
    if (disposed || Math.abs(target - amount) <= EPSILON) return false;
    const step = Math.max(0, Math.min(0.1, dt || 0)) / FADE_SECONDS;
    applyAmount(target > amount ? Math.min(target, amount + step) : Math.max(target, amount - step));
    return true;
  }

  // post.update() owns time-profile interpolation and may call GradePass.setSaturation().
  // Reassert the full-ink sleep gate afterwards without discarding that profile's desired
  // saturation; setPbrAwake(true) restores the pass from its current uniform value.
  function syncAfterPostUpdate() {
    if (!pbrAwake && post.gradePass) post.gradePass.enabled = false;
  }

  return {
    setMode,
    setFocusPolicy,
    update,
    syncAfterPostUpdate,
    resize(width, height) {
      ink?.setSize(width, height, renderer.getPixelRatio());
    },
    debugState() {
      return {
        style,
        amount,
        target,
        transitioning: Math.abs(target - amount) > EPSILON,
        pbrAwake,
        created: !!ink,
        inkEnabled: !!ink?.pass.enabled,
        sourceEnabled: !!ink?.sourcePass.enabled,
        beautyScale: ink?.sourcePass.resolutionScale ?? null,
        paperSize: ink?.paperTexture?.image?.width ?? null,
        beautyCaptures: ink?.sourcePass.captureCount ?? 0,
        normalScale: ink?.pass.resolutionScale ?? null,
        normalExcluded: ink?.pass.normalExcludedCount ?? 0,
        normalDithered: ink?.pass.normalDitheredCount ?? 0,
        instFadeNormal: ink?.pass.instFadeNormalCount ?? 0,
        lodScreenDoorNormal: ink?.pass.lodScreenDoorNormalCount ?? 0,
        normalDrawCalls: ink?.pass.normalDrawCalls ?? 0,
        pbrPasses: {
          grade: !!post.gradePass?.enabled,
          bloom: !!post.bloomPass.enabled,
          bokeh: !!post.bokehPass.enabled,
          flare: !!post.flarePass.enabled,
        },
      };
    },
    debugSetPbrAwake(awake) {
      setPbrAwake(!!awake);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      setPbrAwake(true);
      if (ink) {
        postRuntime.removePass(ink.sourcePass);
        postRuntime.removePass(ink.pass);
        ink.dispose();
        ink = null;
      }
    },
    get style() { return style; },
    get amount() { return amount; },
  };
}
