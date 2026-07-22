const SHIFT_FRAC = 0.5;
const PANEL_SELECTOR = '.ctxcard, .vcard, .panel, .sheet';

/**
 * Keep the subject centered in the visible viewport when UI panels cover part
 * of the canvas. Only the projection matrix moves; camera pose stays intact.
 */
export function createViewShift({ container, camera, isBusy = () => false }) {
  const state = {
    curX: 0,
    curY: 0,
    tgtX: 0,
    tgtY: 0,
    compositionYFrac: 0,
    enabled: true,
    lastSample: 0,
    appliedX: NaN,
    appliedY: NaN,
  };

  function sampleTarget() {
    if (typeof document === 'undefined') return;
    const width = container.clientWidth || 1;
    const height = container.clientHeight || 1;
    let dx = 0;
    let dy = 0;

    for (const element of document.querySelectorAll(PANEL_SELECTOR)) {
      const rect = element.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) continue;
      if (element.classList.contains('sheet')) {
        dy += Math.max(0, Math.min(height, height - rect.top));
      } else if (element.classList.contains('panel')) {
        dx -= Math.max(0, Math.min(width, width - rect.left));
      } else {
        dx += Math.max(0, Math.min(width, rect.right));
      }
    }

    const capX = width * 0.42;
    const capY = height * 0.42;
    state.tgtX = Math.max(-capX, Math.min(capX, dx * SHIFT_FRAC));
    state.tgtY = Math.max(-capY, Math.min(capY, dy * SHIFT_FRAC));
  }

  function apply({ panels = true } = {}) {
    const height = container.clientHeight || 1;
    const x = panels && state.enabled ? state.curX : 0;
    const y = (panels && state.enabled ? state.curY : 0)
      + state.compositionYFrac * height;
    if (Math.abs(x - state.appliedX) < 0.2 && Math.abs(y - state.appliedY) < 0.2) return;
    state.appliedX = x;
    state.appliedY = y;
    const width = container.clientWidth || 1;
    if (Math.abs(x) > 0.4 || Math.abs(y) > 0.4) {
      camera.setViewOffset(width, height, -x, y, width, height);
    } else if (camera.view?.enabled) {
      camera.clearViewOffset();
    }
  }

  function update(dt) {
    if (!state.enabled) {
      state.curX = 0;
      state.curY = 0;
      state.tgtX = 0;
      state.tgtY = 0;
      apply();
      return;
    }

    if (!isBusy()) {
      const now = performance.now();
      if (now - state.lastSample > 90) {
        state.lastSample = now;
        sampleTarget();
      }
      const alpha = 1 - Math.exp(-dt / 0.18);
      state.curX += (state.tgtX - state.curX) * alpha;
      state.curY += (state.tgtY - state.curY) * alpha;
    }
    apply();
  }

  function setEnabled(enabled) {
    state.enabled = !!enabled;
    if (!state.enabled) {
      state.curX = 0;
      state.curY = 0;
      state.tgtX = 0;
      state.tgtY = 0;
      apply();
    }
  }

  // A normalized artistic composition shift composes with transient panel offsets.
  // Negative values place the subject lower and reveal more sky. Keeping it normalized
  // makes resize invalidation sufficient; no camera pose or focus distance changes.
  function setCompositionY(fraction = 0) {
    state.compositionYFrac = Math.max(-0.3, Math.min(0.3, Number(fraction) || 0));
    invalidate();
  }

  function applyCompositionOnly() { apply({ panels: false }); }

  function invalidate() {
    state.appliedX = NaN;
    state.appliedY = NaN;
  }

  return { state, update, apply, applyCompositionOnly, setCompositionY, setEnabled, invalidate };
}
