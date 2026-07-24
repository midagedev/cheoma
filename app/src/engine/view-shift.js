import {
  fitFocusFraming,
  safeViewportRect,
} from '../../../src/api/cinematic.js';

const OCCLUSION_SELECTOR = [
  '.ctxcard',
  '.panel',
  '.sheet',
  '.scene-guide',
  '.dial',
  '.actions',
  '.mode',
].join(', ');
const SAFE_GUTTER = 16;

function intersects(a, b) {
  return a.right > b.left && a.left < b.right
    && a.bottom > b.top && a.top < b.bottom;
}

// Collapse irregular product chrome into the largest conservative central
// rectangle. A corner control is assigned to the edge that discards the least
// remaining area; controls already outside a previously claimed edge disappear
// from consideration, so a top-left mode toggle does not also erase a full
// horizontal strip after the larger context card claimed the left side.
function measureViewportInsets(container) {
  const width = container.clientWidth || 1;
  const height = container.clientHeight || 1;
  const host = container.getBoundingClientRect();
  const centerX = width * 0.5;
  const centerY = height * 0.5;
  const safe = { left: 0, right: width, top: 0, bottom: height };
  const overlays = [...document.querySelectorAll(OCCLUSION_SELECTOR)]
    .flatMap((element) => {
      if (element.hidden || element.inert || element.getAttribute('aria-hidden') === 'true') return [];
      const rect = element.getBoundingClientRect();
      const local = {
        left: Math.max(0, rect.left - host.left),
        right: Math.min(width, rect.right - host.left),
        top: Math.max(0, rect.top - host.top),
        bottom: Math.min(height, rect.bottom - host.top),
      };
      if (local.right - local.left < 2 || local.bottom - local.top < 2) return [];
      return [{ local, area: (local.right - local.left) * (local.bottom - local.top) }];
    })
    .sort((a, b) => b.area - a.area);

  for (const { local } of overlays) {
    if (!intersects(local, safe)) continue;
    const candidates = [];
    if (local.right <= centerX) {
      const edge = Math.max(safe.left, local.right);
      candidates.push({
        side: 'left',
        edge,
        loss: Math.max(0, edge - safe.left) * (safe.bottom - safe.top),
      });
    }
    if (local.left >= centerX) {
      const edge = Math.min(safe.right, local.left);
      candidates.push({
        side: 'right',
        edge,
        loss: Math.max(0, safe.right - edge) * (safe.bottom - safe.top),
      });
    }
    if (local.bottom <= centerY) {
      const edge = Math.max(safe.top, local.bottom);
      candidates.push({
        side: 'top',
        edge,
        loss: Math.max(0, edge - safe.top) * (safe.right - safe.left),
      });
    }
    if (local.top >= centerY) {
      const edge = Math.min(safe.bottom, local.top);
      candidates.push({
        side: 'bottom',
        edge,
        loss: Math.max(0, safe.bottom - edge) * (safe.right - safe.left),
      });
    }
    candidates.sort((a, b) => a.loss - b.loss);
    const choice = candidates[0];
    if (choice) safe[choice.side] = choice.edge;
  }
  return {
    width,
    height,
    insets: {
      left: safe.left,
      right: width - safe.right,
      top: safe.top,
      bottom: height - safe.bottom,
    },
    gutter: SAFE_GUTTER,
  };
}

/**
 * Keep the subject inside the viewport left by product chrome. Projection
 * shifting recentres that safe rectangle continuously; a focus lifecycle may
 * additionally ask fitFraming() for the minimum same-ray physical dolly needed
 * to keep its semantic architecture and court inside the rectangle.
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
    layout: null,
    safeRect: null,
    lastFit: null,
  };

  function sampleTarget() {
    if (typeof document === 'undefined') return;
    state.layout = measureViewportInsets(container);
    state.safeRect = safeViewportRect(state.layout);
    const capX = state.layout.width * 0.42;
    const capY = state.layout.height * 0.42;
    state.tgtX = Math.max(-capX, Math.min(capX, state.safeRect.shiftX));
    state.tgtY = Math.max(-capY, Math.min(capY, state.safeRect.shiftY));
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
      state.layout = null;
      state.safeRect = null;
      state.lastFit = null;
      apply();
    }
  }

  function fitFraming(framing, subject) {
    if (!framing?.position || !framing?.target) return framing;
    if (!state.enabled) {
      return {
        ...framing,
        position: framing.position.clone(),
        target: framing.target.clone(),
      };
    }
    sampleTarget();
    const result = fitFocusFraming({
      framing,
      subject,
      viewport: state.layout,
    });
    state.lastFit = result;
    const fitted = {
      ...framing,
      position: framing.position.clone(),
      target: framing.target.clone(),
    };
    if (result.framing?.position) fitted.position.set(
      result.framing.position.x,
      result.framing.position.y,
      result.framing.position.z,
    );
    if (result.framing?.target) fitted.target.set(
      result.framing.target.x,
      result.framing.target.y,
      result.framing.target.z,
    );
    return fitted;
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

  return {
    state,
    update,
    apply,
    applyCompositionOnly,
    fitFraming,
    setCompositionY,
    setEnabled,
    invalidate,
  };
}
