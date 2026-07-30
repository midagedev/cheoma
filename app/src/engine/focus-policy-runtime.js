/**
 * Product focus policy for rim / flare / DoF enable.
 *
 * Owns the single place that remembers the current focus context so aerial
 * vs focused PBR pass budgets stay coherent across focus-in/out/hop.
 */
export function createFocusPolicyRuntime({ post } = {}) {
  const policy = {
    focused: true,
    flare: !!post?.flarePass?.enabled,
    dofAmount: post?.dof?.amount ?? 0,
  };

  function setFocusPolicy({ focused = policy.focused, flare = focused, dofAmount = policy.dofAmount } = {}) {
    policy.focused = !!focused;
    policy.flare = !!flare;
    policy.dofAmount = Number.isFinite(dofAmount) ? Math.min(1, Math.max(0, dofAmount)) : 0;
    post?.setRimEnabled?.(policy.focused);
    post?.setFlareEnabled?.(policy.flare);
    post?.setDofAmount?.(policy.dofAmount);
  }

  return {
    setFocusPolicy,
    get policy() { return { ...policy }; },
  };
}
