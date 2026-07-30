import {
  VILLAGE_FOCUS_SKY_REFERENCE_BAND,
  fitFocusFraming,
  safeViewportRect,
} from '../../../src/api/cinematic.js';

// Product chrome that still floats *over the WebGL canvas*. The right inspector
// dock (.ctxcard) is intentionally absent: the stage is laid out with
// `right: var(--inspector-w)` so the canvas ends at the column edge and the
// camera already centres on the free viewport. Portrait `.sheet` still overlays
// the full-bleed canvas and must be measured here. Corner chips (dial, dock,
// breadcrumb, guide) remain small occlusion sources.
const OCCLUSION_SELECTOR = [
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

// 보이지 않는 크롬은 화면을 가리지 않는다. `hidden`/`inert`/`aria-hidden` 만 걸러내던 종전 규칙은
//   **투명한** 표면을 놓쳤다: 인스펙터 컬럼은 닫힐 때 inert 지만, 열린 상태로 `.chroma.faded`
//   (opacity 0) 안에 있으면 inert 가 풀린 채 눈에 보이지 않는다. ?clip= 녹화 부팅이 정확히 그
//   상태이고, 그래서 히어로 정착 1.2초 뒤 프레임이 **보이지 않는 패널을 위해 좌측으로 172px 팬**
//   했다(2026-07-30 판정: dy 0, 스케일 변화 0 의 순수 횡이동 = 렌즈 시프트). 조상까지 올라가며
//   실효 가시성을 보는 이유는 페이드가 컨테이너(.chroma)에 걸리기 때문이다.
const OCCLUSION_OPACITY_FLOOR = 0.05;
function effectivelyVisible(element, container) {
  for (let node = element; node && node !== document.body; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    if ((Number(style.opacity) || 0) < OCCLUSION_OPACITY_FLOOR) return false;
    if (node === container) break;
  }
  return true;
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
// 시프트 추종은 임계감쇠 2차 스프링이다. 종전 1차 지연(alpha = 1 - exp(-dt/0.28))은 목표가 계단으로
//   바뀌는 프레임에 **최대 속도**를 낸다 — 정지 상태에서 Δ/0.28 px/s 로 즉시 출발하므로 히어로 정착
//   직후 인스펙터가 열리는 프레임에 렌즈가 튀었다(실측 1024×640 데스크톱 4.24px/frame ≈ 170px/s 를
//   정지에서 한 프레임에, 폰 시트 Δ≈140px 에서는 500px/s 급). 게다가 1차 지연은 프레임이 길면 남은
//   거리의 큰 몫을 한 번에 먹는다(실측: 149ms 히치 프레임에서 25.3px 단일 프레임 점프).
//   2차 스프링은 속도 상태를 갖고 v=0 에서 출발하므로 시작 가속만 있고 속도 불연속이 없으며,
//   서브스텝이 히치 프레임의 단일 점프를 막는다. omega 는 종전과 비슷한 정착 시간(≈0.6s 내 5%)으로.
const SHIFT_OMEGA = 7.0;
const SHIFT_SUBSTEP = 1 / 120;
// 크롬이 나타나거나 사라지면 구도 밴드(가용 높이)가 계단으로 바뀐다. 구도 **분수**는 focus 트윈이
//   매 프레임 저작한 값이므로 지연시키면 안 되고(도착이 늦어진다), 밴드만 같은 스프링으로 따라간다.
const BAND_OMEGA = 7.0;

// 임계감쇠 스프링 한 스텝(semi-implicit). dt 가 길면 서브스텝으로 나눠 적분해 안정성과
// "한 프레임에 큰 몫" 문제를 함께 없앤다.
function springTo(cur, vel, target, omega, dt) {
  let x = cur;
  let v = vel;
  let remaining = Math.min(Math.max(dt, 0), 0.5);
  while (remaining > 1e-6) {
    const h = Math.min(SHIFT_SUBSTEP, remaining);
    remaining -= h;
    v += (-2 * omega * v - omega * omega * (x - target)) * h;
    x += v * h;
  }
  if (Math.abs(x - target) < 0.01 && Math.abs(v) < 0.05) return { value: target, velocity: 0 };
  return { value: x, velocity: v };
}
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
      if (!effectivelyVisible(element, container)) return [];
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
 * Keep the subject inside the viewport left by *overlay* product chrome
 * (sheet, chips). The permanent right inspector is not an overlay — the stage
 * canvas is physically narrower — so this runtime no longer recentres past it.
 * Projection shifting still recentres for remaining overlays; a focus lifecycle
 * may additionally ask fitFraming() for a same-ray physical dolly.
 */
export function createViewShift({ container, camera, isBusy = () => false }) {
  const state = {
    curX: 0,
    curY: 0,
    velX: 0,
    velY: 0,
    tgtX: 0,
    tgtY: 0,
    bandCur: 0,
    bandVel: 0,
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
    // 검증 A/B 토글은 이 샘플 주기(≤48ms)에서만 읽는다 — 프레임 핫 루프에 window 조회를 넣지 않는다.
    state.legacyFlow = typeof window !== 'undefined' && window.__camFlowLegacy === true;
    state.layout = measureViewportInsets(container);
    state.safeRect = safeViewportRect(state.layout);
    const capX = state.layout.width * 0.42;
    const capY = state.layout.height * 0.42;
    state.tgtX = Math.max(-capX, Math.min(capX, state.safeRect.shiftX));
    state.tgtY = Math.max(-capY, Math.min(capY, state.safeRect.shiftY));
  }

  // Composition is a fraction of the **usable band**, not of raw viewport height (§6.19): sky above
  // the eave is a proportion of what the viewer can actually see. The band comes from the live safe
  // rectangle; when panel shifting is disabled the rectangle is not maintained, so measure it here at
  // the same 90ms cadence sampleTarget() uses rather than on every frame.
  //
  // The band is capped at the share the value was authored against (VILLAGE_FOCUS_SKY_REFERENCE_BAND).
  // Without that cap a chrome-free frame — the hero landing, every ?shot=1 capture — reads 0.2 of
  // nearly the whole viewport and crops the yard out of the authored frame. With it, the proportion
  // only ever shrinks, and only where chrome really claims more than the reference share.
  let bandSampleAt = 0;
  let bandSampleH = 0;
  function compositionBandHeight() {
    const viewportH = container.clientHeight || 1;
    const cap = viewportH * VILLAGE_FOCUS_SKY_REFERENCE_BAND;
    if (state.safeRect) return Math.min(state.safeRect.height || 1, cap);
    if (typeof document === 'undefined') return Math.min(viewportH, cap);
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (!bandSampleH || now - bandSampleAt > 90) {
      bandSampleAt = now;
      bandSampleH = safeViewportRect(measureViewportInsets(container)).height || 1;
    }
    return Math.min(bandSampleH, cap);
  }

  // 적용에 쓰는 밴드는 위 측정값을 스프링으로 따라간다. 첫 호출은 측정값에서 시작한다(부팅 램프 없음).
  function appliedBandHeight() {
    const target = compositionBandHeight();
    if (!(state.bandCur > 0)) {
      state.bandCur = target;
      state.bandVel = 0;
    }
    return state.bandCur;
  }

  function apply({ panels = true } = {}) {
    const x = panels && state.enabled ? state.curX : 0;
    const y = (panels && state.enabled ? state.curY : 0)
      + state.compositionYFrac * appliedBandHeight();
    if (Math.abs(x - state.appliedX) < 0.2 && Math.abs(y - state.appliedY) < 0.2) return;
    state.appliedX = x;
    state.appliedY = y;
    const width = container.clientWidth || 1;
    const height = container.clientHeight || 1;
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
      state.velX = 0;
      state.velY = 0;
      state.tgtX = 0;
      state.tgtY = 0;
      apply();
      return;
    }

    if (!isBusy()) {
      const now = performance.now();
      // Sample often enough to track a 0.5s sheet expand without a stepped jump.
      if (now - state.lastSample > 48) {
        state.lastSample = now;
        sampleTarget();
      }
      if (state.legacyFlow) {
        // 검증 전용(window.__camFlowLegacy) — 종전 1차 지연 재현. 제품 기본 경로가 아니다.
        const alpha = 1 - Math.exp(-dt / 0.28);
        state.curX += (state.tgtX - state.curX) * alpha;
        state.curY += (state.tgtY - state.curY) * alpha;
        state.velX = 0;
        state.velY = 0;
      } else {
        const nx = springTo(state.curX, state.velX, state.tgtX, SHIFT_OMEGA, dt);
        const ny = springTo(state.curY, state.velY, state.tgtY, SHIFT_OMEGA, dt);
        state.curX = nx.value; state.velX = nx.velocity;
        state.curY = ny.value; state.velY = ny.velocity;
      }
    }
    // 밴드는 busy 구간에도 따라간다(그 구간의 크롬 변화가 정착 프레임에 계단으로 쌓이지 않게).
    const bandTarget = compositionBandHeight();
    if (!(state.bandCur > 0) || state.legacyFlow) {
      state.bandCur = bandTarget;
      state.bandVel = 0;
    } else {
      const nb = springTo(state.bandCur, state.bandVel, bandTarget, BAND_OMEGA, dt);
      state.bandCur = nb.value;
      state.bandVel = nb.velocity;
    }
    apply();
  }

  function setEnabled(enabled) {
    state.enabled = !!enabled;
    if (!state.enabled) {
      state.curX = 0;
      state.curY = 0;
      state.velX = 0;
      state.velY = 0;
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
    return { x: state.tgtX, y: state.tgtY + compositionY * compositionBandHeight() };
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
    // There is deliberately no fallback here. An earlier round shipped one — when the applied
    // projection could not contain the subject it quietly framed with the uncomposed solve — and
    // that is the same class of defect this whole contract exists to remove: a frame the verdict
    // never authorised. The composition is now band-relative (§6.19), which is what made the
    // unsatisfiable case go away at its cause: the axis no longer lands 19px from the band edge,
    // so the dolly search can actually reach containment. If some viewport still cannot fit, the
    // honest `overflow` must surface as a gate failure rather than as a silent substitution.
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
