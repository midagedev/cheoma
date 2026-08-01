import { RIM_CONTEXT_MASTER } from '../../../src/api/environment.js';

/**
 * Product focus policy for rim / flare / DoF.
 *
 * Owns the single place that remembers the current focus context so aerial
 * vs focused PBR pass budgets stay coherent across focus-in/out/hop.
 *
 * Rim is a *weight* here, not a switch. Until this round one boolean turned rim, flare and DoF
 * off together, so every aerial and cinematic frame ran with `uRimScale = 0` — the flagship
 * backlit rim was absent from the whole drone tour (measured 0 rim add on 32/32 frames). Flare
 * and DoF genuinely belong to the focus context (a village-wide shallow depth of field would
 * smear the whole settlement, and the aerial frame does not want a sun ghost), but the rim is the
 * unifier of the look and must survive at every scale. So the focus axis only dials
 * RIM_CONTEXT_MASTER; the on/off axis (`post.setRimEnabled`) stays with A/B verification, the
 * `?rim=pass` fallback, and `post.setEnabled`. Rim direction stays optically real either way —
 * the sun-elevation and per-fragment backlight gates live in the core rim shader.
 */
export function createFocusPolicyRuntime({ post } = {}) {
  const policy = {
    focused: true,
    flare: !!post?.flarePass?.enabled,
    dofAmount: post?.dof?.amount ?? 0,
    rimMaster: RIM_CONTEXT_MASTER.focus,
  };

  const contextRimMaster = (focused) => (
    focused ? RIM_CONTEXT_MASTER.focus : RIM_CONTEXT_MASTER.aerial
  );

  function setFocusPolicy({
    focused = policy.focused,
    flare = focused,
    dofAmount = policy.dofAmount,
    rimMaster = contextRimMaster(focused),
  } = {}) {
    policy.focused = !!focused;
    policy.flare = !!flare;
    policy.dofAmount = Number.isFinite(dofAmount) ? Math.min(1, Math.max(0, dofAmount)) : 0;
    policy.rimMaster = Number.isFinite(rimMaster)
      ? Math.min(1, Math.max(0, rimMaster))
      : contextRimMaster(policy.focused);
    post?.setRimMaster?.(policy.rimMaster);
    post?.setFlareEnabled?.(policy.flare);
    post?.setDofAmount?.(policy.dofAmount);
  }

  return {
    setFocusPolicy,
    get policy() { return { ...policy }; },
  };
}
