import {
  fitFocusFraming,
  safeViewportRect,
} from '../../../src/api/cinematic.js';

// #158: the three-axis chrome. The make-panel shells (.ctxcard / .sheet), the view
// card (.dial) and the share dock (.actions) are the same classes as before; the
// retired ModeToggle (.mode) and legacy right drawer (.panel) are replaced by the
// top-left breadcrumb, which is small but must still be measured so a corner
// control cannot claim a whole strip.
const OCCLUSION_SELECTOR = [
  '.ctxcard',
  '.sheet',
  '.scene-guide',
  '.dial',
  '.actions',
  '[data-breadcrumb]',
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
//
// Two rules make that assignment survive a surface that is larger than a corner
// control (#158): an overlay anchored flush against a viewport edge may always
// claim that edge, and every overlay is judged after being clipped to the safe
// rectangle that earlier overlays left. Without the first rule a bottom sheet
// tall enough to cross the viewport centre produced no candidate at all and was
// silently ignored; without the second, a mid-height dock still overlapping a
// sliver of the safe rectangle could surrender the entire band above it.
const EDGE_ANCHOR_TOLERANCE = 28;      // chrome insets are clamp(10px … 22px)
const COMPOSITION_LIMIT = 0.3;         // normalized artistic shift, both directions
const clampComposition = (fraction) => Math.max(
  -COMPOSITION_LIMIT,
  Math.min(COMPOSITION_LIMIT, Number(fraction) || 0),
);

function measureViewportInsets(container) {
  const width = container.clientWidth || 1;
  const height = container.clientHeight || 1;
  const host = container.getBoundingClientRect();
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
    // Judge the overlay by the part that still competes with the scene, and
    // against the centre of what is left rather than of the whole viewport.
    const clipped = {
      left: Math.max(local.left, safe.left),
      right: Math.min(local.right, safe.right),
      top: Math.max(local.top, safe.top),
      bottom: Math.min(local.bottom, safe.bottom),
    };
    const safeCenterX = (safe.left + safe.right) * 0.5;
    const safeCenterY = (safe.top + safe.bottom) * 0.5;
    const anchoredLeft = local.left <= EDGE_ANCHOR_TOLERANCE;
    const anchoredRight = local.right >= width - EDGE_ANCHOR_TOLERANCE;
    const anchoredTop = local.top <= EDGE_ANCHOR_TOLERANCE;
    const anchoredBottom = local.bottom >= height - EDGE_ANCHOR_TOLERANCE;
    const candidates = [];
    if (anchoredLeft || clipped.right <= safeCenterX) {
      const edge = Math.max(safe.left, clipped.right);
      candidates.push({
        side: 'left',
        edge,
        loss: Math.max(0, edge - safe.left) * (safe.bottom - safe.top),
      });
    }
    if (anchoredRight || clipped.left >= safeCenterX) {
      const edge = Math.min(safe.right, clipped.left);
      candidates.push({
        side: 'right',
        edge,
        loss: Math.max(0, safe.right - edge) * (safe.bottom - safe.top),
      });
    }
    if (anchoredTop || clipped.bottom <= safeCenterY) {
      const edge = Math.max(safe.top, clipped.bottom);
      candidates.push({
        side: 'top',
        edge,
        loss: Math.max(0, edge - safe.top) * (safe.right - safe.left),
      });
    }
    if (anchoredBottom || clipped.top >= safeCenterY) {
      const edge = Math.min(safe.bottom, clipped.top);
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

  // The projection offset this runtime will really apply once the shift has settled.
  // apply() writes setViewOffset(w, h, -x, y, w, h) with y = curY + compositionYFrac·h,
  // and three's view offset moves the image by (-offsetX, -offsetY), so the settled
  // screen shift is (+tgtX, -(tgtY + compositionYFrac·h)) — the panel term is already
  // clamped inside sampleTarget(), and the composition term survives even when panel
  // shifting is disabled. Handing this to the solver is what keeps `fitted`/`overflow`
  // true of the frame that ships instead of of an uncomposed ideal (§6.17).
  function appliedProjectionShift(compositionY) {
    const height = container.clientHeight || 1;
    return { x: state.tgtX, y: state.tgtY + compositionY * height };
  }

  // compositionY: the *settled* composition of the frame being solved for. A focus
  // lifecycle tweens composition toward its destination, so a caller that knows the
  // destination should pass it; otherwise the current value is the best available.
  function fitFraming(framing, subject, { compositionY = null } = {}) {
    if (!framing?.position || !framing?.target) return framing;
    if (!state.enabled) {
      return {
        ...framing,
        position: framing.position.clone(),
        target: framing.target.clone(),
      };
    }
    sampleTarget();
    const composition = Number.isFinite(compositionY)
      ? clampComposition(compositionY)
      : state.compositionYFrac;
    const result = fitFocusFraming({
      framing,
      subject,
      viewport: state.layout,
      appliedShift: appliedProjectionShift(composition),
    });
    // When the applied projection cannot contain the subject, dollying is the wrong lever
    // and pulling on it makes the frame worse: the composed shift puts the camera axis near
    // a band edge (measured 390×844 editing: axis 18.8px above the band bottom), and a dolly
    // shrinks the box *around that axis*, so containment would need the subject's lower half
    // to be under 19px. The honest solve therefore runs to the dolly clamp and still
    // overflows — 4× further away, no better framed. Keep the honest verdict for consumers
    // and gates, but let the frame stay at the previous (ideal-shift) solve rather than
    // regress. The real remedy is a composition that respects the band; that is a look
    // decision, recorded in ui-consolidation §6.17.
    let framingResult = result;
    if (!result.fitted) {
      const idealFit = fitFocusFraming({ framing, subject, viewport: state.layout });
      framingResult = idealFit;
      // `scale` 은 항상 **출하된 프레임**의 dolly 를 가리킨다(소비자가 fit.scale 로 프레임 크기를
      // 읽는다). 정직한 탐색이 도달한 값은 appliedSearchScale 로 따로 남긴다.
      state.lastFit = {
        ...result,
        scale: idealFit.scale,
        appliedSearchScale: result.scale,
        framingSource: 'ideal-shift-fallback',
        idealFitted: idealFit.fitted,
      };
    } else {
      state.lastFit = { ...result, framingSource: 'applied-shift' };
    }
    const fitted = {
      ...framing,
      position: framing.position.clone(),
      target: framing.target.clone(),
    };
    if (framingResult.framing?.position) fitted.position.set(
      framingResult.framing.position.x,
      framingResult.framing.position.y,
      framingResult.framing.position.z,
    );
    if (framingResult.framing?.target) fitted.target.set(
      framingResult.framing.target.x,
      framingResult.framing.target.y,
      framingResult.framing.target.z,
    );
    return fitted;
  }

  // A normalized artistic composition shift composes with transient panel offsets.
  // Negative values place the subject lower and reveal more sky. Keeping it normalized
  // makes resize invalidation sufficient; no camera pose or focus distance changes.
  function setCompositionY(fraction = 0) {
    state.compositionYFrac = clampComposition(fraction);
    invalidate();
  }

  function applyCompositionOnly() { apply({ panels: false }); }

  // Rounded signature of the *current* chrome insets, with no state mutation. The chrome
  // morph that follows a focus-in is a Svelte flush plus a 420ms CSS transition, so a
  // choreography owner that wants to re-solve on the settled frame needs a cheap per-frame
  // "has it stopped moving yet" probe. DOM measurement stays owned here (§6.15 / §6.18).
  function layoutSignature() {
    if (typeof document === 'undefined') return '';
    const { insets } = measureViewportInsets(container);
    return `${Math.round(insets.left)}|${Math.round(insets.right)}`
      + `|${Math.round(insets.top)}|${Math.round(insets.bottom)}`;
  }

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
    layoutSignature,
    setCompositionY,
    setEnabled,
    invalidate,
  };
}
