<script>
  // Make-panel shell geometry (Spectrum surface tokens via .inspector-surface).
  //
  //   Desktop / tablet     : full-height right dock (.ctxcard)
  //   Landscape phone      : same right dock, thinner rail
  //   Portrait phone       : bottom sheet (.sheet) peek / half
  //
  // Detents use **visible height** so scroll content cannot leave the viewport.
  // Dock open → --inspector-w so dial / share dock / guide clear the column.
  import { tick, untrack } from 'svelte';
  import { device } from '../lib/device.svelte.js';
  import { t } from '../lib/i18n.svelte.js';

  let {
    open = false, ariaLabel = 'panel', gap = 10, peekPx = 52, detent = null, children,
    header = null, footer = null,
  } = $props();

  // Expanded sheet height. 0.50 keeps ≥28% framing band (focus-framing
  // minSafeFraction). Density comes from tighter rows, not a taller sheet.
  const HALF_VH = 0.50;
  let viewportH = $state(0);
  let snap = $state('hidden');
  let dragH = $state(null);
  let dragging = $state(false);
  let suppressClick = false;
  let surface = $state(null);
  let grip = $state(null);

  const halfPx = $derived(Math.round((viewportH || 0) * HALF_VH));
  const detentH = (name) => (name === 'half' ? halfPx : peekPx);
  const sheetMax = $derived(dragH != null ? dragH : detentH(snap));
  const expanded = $derived(snap === 'half');
  const contentInteractive = $derived(open && (!device.sheet || expanded));

  // Measure the right dock and publish --inspector-w so dial / share dock / guide
  // clear the column without hard-coded corner constants.
  $effect(() => {
    const root = document.documentElement;
    if (device.sheet || !open || !surface) {
      root.style.setProperty('--inspector-w', '0px');
      return () => root.style.removeProperty('--inspector-w');
    }
    const publish = () => {
      const w = Math.round(surface.getBoundingClientRect().width);
      root.style.setProperty('--inspector-w', `${Math.max(0, w)}px`);
    };
    publish();
    if (typeof ResizeObserver === 'undefined') {
      return () => root.style.removeProperty('--inspector-w');
    }
    const observer = new ResizeObserver(publish);
    observer.observe(surface);
    return () => {
      observer.disconnect();
      root.style.removeProperty('--inspector-w');
    };
  });

  let previousOpen = null;
  let previousContentInteractive = null;
  $effect.pre(() => {
    const nextOpen = open;
    const nextInteractive = contentInteractive;
    if (previousOpen == null || previousContentInteractive == null) {
      previousOpen = nextOpen;
      previousContentInteractive = nextInteractive;
      return;
    }
    const active = typeof document === 'undefined' ? null : document.activeElement;
    let destination = null;
    if (previousOpen && !nextOpen && surface?.contains(active)) {
      destination = () => document.querySelector('[data-app-surface]');
    } else if (previousContentInteractive && !nextInteractive && nextOpen
      && surface?.contains(active) && active?.closest('[data-sheet-content]')) {
      destination = () => grip;
    }
    previousOpen = nextOpen;
    previousContentInteractive = nextInteractive;
    if (destination) {
      void tick().then(() => {
        const target = destination();
        if (target?.isConnected && !target.closest('[inert]')) target.focus({ preventScroll: true });
      });
    }
  });

  $effect(() => {
    if (!device.sheet || !halfPx) return;
    document.documentElement.style.setProperty('--sheet-half', `${halfPx}px`);
    return () => document.documentElement.style.removeProperty('--sheet-half');
  });

  $effect(() => {
    if (!device.sheet) return;
    if (open) { if (snap === 'hidden') snap = 'peek'; }
    else snap = 'hidden';
  });

  let appliedDetent = null;
  $effect(() => {
    if (!device.sheet || !open) { appliedDetent = null; return; }
    if (detent == null || dragging || detent === appliedDetent) return;
    appliedDetent = detent;
    if ((detent === 'half' || detent === 'peek') && untrack(() => snap) !== 'hidden') snap = detent;
  });

  let startPY = 0, startH = 0, movedBy = 0;
  function down(e) {
    if (!device.sheet) return;
    dragging = true; movedBy = 0;
    startPY = e.clientY; startH = detentH(snap); dragH = startH;
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }
  function move(e) {
    if (!dragging) return;
    const dy = e.clientY - startPY;
    movedBy = Math.max(movedBy, Math.abs(dy));
    dragH = Math.max(peekPx, Math.min(halfPx, startH - dy));
  }
  function up() {
    if (!dragging) return;
    dragging = false;
    const h = dragH; dragH = null;
    suppressClick = movedBy > 6;
    snap = Math.abs(h - halfPx) <= Math.abs(h - peekPx) ? 'half' : 'peek';
  }
  function tapGrip() {
    if (suppressClick) { suppressClick = false; return; }
    snap = expanded ? 'peek' : 'half';
  }
</script>

<svelte:window bind:innerHeight={viewportH} />

{#if device.sheet}
  <aside
    bind:this={surface}
    class="sheet context inspector-surface"
    class:open
    class:dragging
    data-snap={snap}
    data-make-panel
    style="max-height: {sheetMax}px"
    aria-hidden={!open}
    aria-label={ariaLabel}
    inert={!open}
  >
    <div
      bind:this={grip}
      class="grip context" role="button" tabindex="0"
      aria-label={expanded ? t('sheet_collapse') : t('sheet_expand')}
      aria-expanded={expanded}
      onpointerdown={down} onpointermove={move} onpointerup={up} onpointercancel={up}
      onclick={tapGrip}
      onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); tapGrip(); } }}
    >
      <span class="peekbtn">
        <span class="chev" class:open={expanded} aria-hidden="true"></span>
        <span class="lbl">{expanded ? t('sheet_collapse') : `${t('axis_make')} · ${t('sheet_expand')}`}</span>
      </span>
    </div>
    {#if header}
      <div data-sheet-content class="sheethead" inert={!contentInteractive} aria-hidden={!contentInteractive}>
        {@render header()}
      </div>
    {/if}
    <div
      data-sheet-content
      data-panel-scroll
      class="scroll"
      style="gap:{gap}px"
      inert={!contentInteractive}
      aria-hidden={!contentInteractive}
    >{@render children?.()}</div>
    {#if footer}
      <div data-sheet-content class="sheetfoot" inert={!contentInteractive} aria-hidden={!contentInteractive}>
        {@render footer()}
      </div>
    {/if}
  </aside>
{:else}
  <!-- Right inspector dock: full-height properties column (desktop + landscape phone). -->
  <aside
    bind:this={surface}
    class="ctxcard inspector-surface"
    class:open
    class:landscape={device.landscapePhone}
    data-make-panel
    aria-hidden={!open}
    aria-label={ariaLabel}
    inert={!open}
  >
    {#if header}<div class="ctxhead">{@render header()}</div>{/if}
    <div class="ctxscroll" data-panel-scroll style="gap:{gap}px">{@render children?.()}</div>
    {#if footer}<div class="ctxfoot">{@render footer()}</div>{/if}
  </aside>
{/if}

<style>
  /* ---------- Right inspector dock (CAD column) ---------- */
  .ctxcard {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    left: auto;
    z-index: 32;
    width: min(var(--inspector-max, 320px), 34vw);
    max-height: none;
    padding: 0;
    border-radius: 0;
    border-left: 1px solid var(--panel-border);
    border-top: none;
    border-bottom: none;
    border-right: none;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    /* Instant open/close so --inspector-w and the stage canvas stay in lockstep;
       a slide would leave a dead strip between a already-shrunk canvas and the panel. */
    transform: translateX(0);
    opacity: 0;
    transition: opacity 0.2s ease;
    pointer-events: none;
  }
  .ctxcard.open {
    opacity: 1;
    pointer-events: auto;
    transition: opacity 0.36s ease;
  }
  .ctxcard:not(.open) {
    visibility: hidden;
  }
  /* Landscape phone: same right rail — never a left floating card. */
  .ctxcard.landscape {
    top: 0;
    bottom: 0;
    right: 0;
    left: auto;
    width: min(268px, 34vw);
    max-height: none;
  }
  .ctxhead {
    flex: none;
    padding: 9px 11px 0;
    border-bottom: 1px solid var(--panel-line);
    background: linear-gradient(180deg, var(--panel-2) 0%, var(--panel) 100%);
  }
  .ctxscroll {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    padding: 9px 11px 11px;
    overscroll-behavior: contain;
    scrollbar-width: thin;
    scrollbar-color: rgba(255, 255, 255, 0.12) transparent;
  }
  .ctxscroll::-webkit-scrollbar { width: 5px; }
  .ctxscroll::-webkit-scrollbar-thumb {
    background: rgba(255, 255, 255, 0.1);
    border-radius: 3px;
  }
  .ctxfoot {
    flex: none;
    padding: 9px 11px calc(11px + env(safe-area-inset-bottom, 0px));
    border-top: 1px solid var(--panel-line);
    background: var(--panel-2);
  }
  .ctxcard.landscape .ctxhead { padding: 8px 10px 0; }
  .ctxcard.landscape .ctxscroll { padding: 8px 10px 10px; }
  .ctxcard.landscape .ctxfoot { padding: 8px 10px 10px; }

  /* ---------- Portrait mobile bottom sheet ---------- */
  .sheet {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 46;
    border-radius: 14px 14px 0 0;
    border: 1px solid var(--panel-border);
    border-bottom: none;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    /* Slightly longer ease so view-shift can track the rising sheet without a pop. */
    transition: max-height 0.52s cubic-bezier(0.22, 1, 0.36, 1), transform 0.36s ease;
    will-change: max-height;
    touch-action: none;
    box-shadow: 0 -16px 48px rgba(0, 0, 0, 0.45);
  }
  .sheet.dragging { transition: none; }
  .sheet[aria-hidden='true'] { transform: translateY(110%); pointer-events: none; }

  .grip {
    position: relative;
    flex: none;
    height: 44px;
    display: grid;
    place-items: center;
    cursor: pointer;
    touch-action: none;
    border-bottom: 1px solid var(--panel-line);
  }
  .grip::before {
    content: '';
    position: absolute;
    top: 7px;
    left: 50%;
    width: 32px;
    height: 3px;
    border-radius: 2px;
    background: rgba(255, 255, 255, 0.18);
    transform: translateX(-50%);
  }
  .peekbtn {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    margin-top: 4px;
    padding: 5px 12px;
    border-radius: 999px;
    background: var(--panel-elevated);
    border: 1px solid var(--panel-border);
    font-family: var(--ui);
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.02em;
    color: var(--panel-text);
  }
  .peekbtn .chev {
    width: 7px;
    height: 7px;
    margin-top: 2px;
    border-right: 1.5px solid var(--panel-muted);
    border-bottom: 1.5px solid var(--panel-muted);
    transform: rotate(-135deg);
    transition: transform 0.22s ease, margin 0.22s ease;
  }
  .peekbtn .chev.open { transform: rotate(45deg); margin-top: -2px; }
  .scroll {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    overscroll-behavior: contain;
    touch-action: pan-y;
    display: flex;
    flex-direction: column;
    /* Extra bottom pad so the last property row is not hidden under the sticky rebuild footer. */
    padding: 0 clamp(10px, 3vw, 14px) 56px;
    gap: 2px;
  }
  .sheethead { flex: none; padding: 0 clamp(10px, 3vw, 14px); }
  .sheet[data-snap='peek'] .sheethead,
  .sheet[data-snap='peek'] .scroll,
  .sheet[data-snap='peek'] .sheetfoot { visibility: hidden; }
  .sheetfoot {
    flex: none;
    padding: 3px clamp(10px, 3vw, 14px) calc(5px + env(safe-area-inset-bottom));
    border-top: 1px solid var(--panel-line);
    background: var(--panel-2);
  }
</style>
