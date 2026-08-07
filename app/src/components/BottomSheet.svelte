<script>
  // Make-panel shell geometry (Spectrum surface tokens via .inspector-surface).
  //
  //   Desktop / tablet     : full-height right dock (.ctxcard)
  //   Landscape phone      : same right dock, thinner rail
  //   Portrait phone       : bottom sheet (.sheet) peek / half / full
  //
  // Detents use **visible height** so scroll content cannot leave the viewport.
  // Dock open → --inspector-w so dial / share dock / guide clear the column.
  import { tick, untrack } from 'svelte';
  import { device } from '../lib/device.svelte.js';
  import { t } from '../lib/i18n.svelte.js';

  let {
    open = false, ariaLabel = 'panel', gap = 10, peekPx = 52, detent = null, children,
    header = null, footer = null,
    // Sheet layouts have no room for a selection header or a footer status line, so
    // the docking bar carries both: the selection identity is its protagonist and
    // the collapse state is the chevron. Desktop keeps the header + status bar.
    status = '', identityBadge = '', identityName = '',
  } = $props();

  // Expanded sheet height. 0.50 keeps ≥28% framing band (focus-framing
  // minSafeFraction). Density comes from tighter rows, not a taller sheet.
  const HALF_VH = 0.50;
  // Third detent (2026-08-05, 사용자 지적 "모바일 편집 패널 사용감이 안 좋다 · 파라미터가
  // 거의 안 보여"): scanning a 15-lever list through a 226px window is the complaint.
  // `full` exists for **finding** a parameter, not for adjusting it — half stays the
  // default so the subject keeps its framing band while a slider is being dragged.
  // Drag-only: a tap must stay the collapse affordance (check:ui-shell contracts one
  // tap = half), and dragging a sheet past its detent is the gesture users already try.
  const FULL_VH = 0.86;
  // ── 짧은 뷰포트 최소 높이(2026-08-07, 사용자 지적 "트위터 같은 데서 열면 화면비율이 거의 1:1이
  //   되어 거의 보기가 힘들다") ── 이 시트의 구조적 문제는 **크롬은 고정 px, 높이는 비율**이라는
  //   것이다. 스크롤 창 = 0.50·H − 크롬 이므로 화면이 짧아지면 선형이 아니라 절벽처럼 사라진다:
  //   실측(scratch/mobile-panel) 393×852 에서 226px 이던 창이 393×430 에서 **72px · 보이는
  //   파라미터 행 0개**가 된다(트위터 인앱 브라우저가 대략 이 비율이다).
  //   그래서 확장 높이를 비율이 아니라 **clamp** 로 정의한다: 최소 MIN_EXPANDED_PX(크롬 + 쓸 만한
  //   스크롤), 최대 SHORT_MAX_VH. 긴 폰(852)에서는 426 → 440 으로 사실상 무변화이고, 짧은 화면
  //   에서는 자연히 화면 대부분을 덮는다 — **패널을 열었다는 것은 지금 파라미터를 보겠다는 뜻**
  //   이므로 그게 맞는 동작이고, peek 는 그대로라 씬은 한 번의 탭으로 되찾는다.
  //   ★ 이 clamp 는 **짧은 뷰포트(≤SHORT_VP_PX)에만** 적용한다. 그 위에서는 0.50 이 계약이다 —
  //   슬라이더를 끄는 동안 피사체가 보여야 한다는 프레이밍 밴드(focus-framing `minSafeFraction`
  //   0.28)를 지키는 값이고, `usable:false` 는 게이트 문구가 아니라 **코어 카메라의 overflow 경로**를
  //   켠다. 2026-08-07 실측: 클램프를 전 화면에 걸었더니 phone-small 360×780 에서 밴드가
  //   0.297 → 0.233 으로 내려가 `check:ui-shell` 이 잡았다. 780 은 애초에 문제 사례가 아니다
  //   (인앱 브라우저는 ~430) — 게이트가 옳고 클램프의 **범위**가 틀렸다. 짧은 화면에서 밴드를
  //   포기하는 것은 사용자 판단이다(2026-08-07 "작은 화면에서는 어쩔 수 없다") — 그 화면에는
  //   애초에 지킬 밴드가 없다.
  //   짧은 화면에서만 밴드를 포기하는 이유는 그 화면에는 애초에 지킬 밴드가 없기 때문이다.
  const MIN_EXPANDED_PX = 440;   // 크롬(실측 152~200) + 최소 스크롤 240
  const SHORT_MAX_VH = 0.92;     // 짧은 화면에서도 그립·상단 여백은 남긴다
  const SHORT_VP_PX = 560;       // device.svelte.js 의 shortViewport 질의와 같은 경계
  let viewportH = $state(0);
  let snap = $state('hidden');
  let dragH = $state(null);
  let dragging = $state(false);
  let suppressClick = false;
  let surface = $state(null);
  let grip = $state(null);

  const halfPx = $derived(
    viewportH > 0 && viewportH <= SHORT_VP_PX
      ? Math.min(
        Math.max(Math.round(viewportH * HALF_VH), MIN_EXPANDED_PX),
        Math.round(viewportH * SHORT_MAX_VH),
      )
      : Math.round((viewportH || 0) * HALF_VH),
  );
  // full 은 half 보다 낮아질 수 없다. 짧은 화면에서는 둘이 같은 값으로 만나 세 번째 정지점이
  //   자연히 사라진다(쓸모없는 detent 를 남기지 않는다).
  const fullPx = $derived(Math.max(Math.round((viewportH || 0) * FULL_VH), halfPx));
  const detentH = (name) => (name === 'full' ? fullPx : name === 'half' ? halfPx : peekPx);
  const sheetMax = $derived(dragH != null ? dragH : detentH(snap));
  const expanded = $derived(snap === 'half' || snap === 'full');
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
    dragH = Math.max(peekPx, Math.min(fullPx, startH - dy));
  }
  function up() {
    if (!dragging) return;
    dragging = false;
    const h = dragH; dragH = null;
    suppressClick = movedBy > 6;
    // Nearest of the three detents by visible height.
    const near = [['peek', peekPx], ['half', halfPx], ['full', fullPx]]
      .reduce((best, cur) => (Math.abs(h - cur[1]) < Math.abs(h - best[1]) ? cur : best));
    snap = near[0];
  }
  function tapGrip() {
    if (suppressClick) { suppressClick = false; return; }
    // Tap stays a two-state toggle (peek ↔ half): "tap the bar to put the panel away"
    // is the model, and check:ui-shell contracts one tap = half. `full` is drag-only —
    // dragging a sheet past its detent is the gesture users already try, and making a
    // tap land there stranded them (the collapse affordance became a third expand).
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
        {#if identityName}
          {#if identityBadge}<span class="gidbadge">{identityBadge}</span>{/if}
          <span class="lbl gidname">{identityName}</span>
        {:else}
          <span class="lbl">{expanded ? t('sheet_collapse') : `${t('axis_make')} · ${t('sheet_expand')}`}</span>
        {/if}
      </span>
      {#if status}<span class="gripstatus" data-status-bar>{status}</span>{/if}
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
    <div class="scrollfade" aria-hidden="true"></div>
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
    <div class="scrollfade" aria-hidden="true"></div>
    {#if footer}<div class="ctxfoot">{@render footer()}</div>{/if}
  </aside>
{/if}

<style>
  /* Shell geometry only — surface color from .inspector-surface (Spectrum tokens). */
  .ctxcard {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    left: auto;
    z-index: 32;
    width: min(var(--inspector-max, 360px), 36vw);
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
    transform: translateX(0);
    opacity: 0;
    transition: opacity 0.2s ease;
    pointer-events: none;
  }
  /* `inherit`, not `auto`: 감상 페이드는 컨테이너(.chroma.faded)에 pointer-events: none 을 걸어
     "보이지 않는 크롬은 화면을 가리지 않는다"를 의도하는데, 여기서 auto 로 되살리면 투명한 컬럼이
     계속 히트 타깃이라 페이드 상태에서 우측 컬럼 폭만큼의 포인터 입력이 씬에 닿지 않았다(#48).
     비페이드 상태의 컨테이너는 pointer-events 기본값이므로 inherit 도 auto 로 해석된다. */
  .ctxcard.open {
    opacity: 1;
    pointer-events: inherit;
    transition: opacity 0.36s ease;
  }
  .ctxcard:not(.open) { visibility: hidden; }
  .ctxcard.landscape {
    width: min(268px, 34vw);
  }
  /* 4px module: 12px block padding, 8px scroll gutter. `--cad-scroll-pad` lets
     sticky group headers bleed to the full column width. */
  .ctxhead {
    flex: none;
    padding: 12px 12px 0;
    border-bottom: 1px solid var(--panel-border);
    background: var(--panel-2);
  }
  /* Flush top: an 8px gutter above the first sticky header let content leak into
     the strip that the header is supposed to own, which is what produced the
     half-cut first row. Bottom padding is a footer's worth so the last row can
     clear the fold instead of being sliced mid-glyph. */
  .ctxscroll {
    --cad-scroll-pad: 12px;
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    padding: 0 var(--cad-scroll-pad) 56px;
    gap: 0;
    overscroll-behavior: contain;
    scrollbar-width: thin;
    scrollbar-color: var(--panel-border) transparent;
  }
  .ctxscroll::-webkit-scrollbar { width: 8px; }
  .ctxscroll::-webkit-scrollbar-track { background: var(--panel-inset); }
  .ctxscroll::-webkit-scrollbar-thumb {
    background: var(--panel-border);
    border-radius: 0;
    border: 2px solid var(--panel-inset);
  }
  /* Short fade at the scroll's bottom edge so a row clipped by the fold reads as
     "more below" rather than as a broken row. Sits above the footer, below chrome. */
  .scrollfade {
    position: relative;
    flex: none;
    height: 0;
    z-index: 3;
    pointer-events: none;
  }
  .scrollfade::before {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 18px;
    /* Opaque for the first 5px: a 1px segment rail clipped by the fold survived a
       pure gradient and read as a stray coloured line above the primary. */
    background: linear-gradient(to top, var(--panel) 0, var(--panel) 5px, transparent 100%);
  }
  .ctxfoot {
    flex: none;
    padding: 8px 12px calc(12px + env(safe-area-inset-bottom, 0px));
    border-top: 1px solid var(--panel-border);
    background: var(--panel-2);
  }
  .ctxcard.landscape .ctxhead { padding: 8px 8px 0; }
  .ctxcard.landscape .ctxscroll { --cad-scroll-pad: 8px; padding: 0 var(--cad-scroll-pad) 44px; }
  .ctxcard.landscape .ctxfoot { padding: 8px; }

  .sheet {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 46;
    border-radius: 4px 4px 0 0;
    border: 1px solid var(--panel-border);
    border-bottom: none;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    transition: max-height 0.52s cubic-bezier(0.22, 1, 0.36, 1), transform 0.36s ease;
    will-change: max-height;
    touch-action: none;
    box-shadow: 0 -12px 40px rgba(0, 0, 0, 0.4);
  }
  .sheet.dragging { transition: none; }
  .sheet[aria-hidden='true'] { transform: translateY(110%); pointer-events: none; }

  /* Docking toolbar, not a hand-holding pill: one 44px bar with a drag handle on
     the left, the state label next, and the live status readout on the right. */
  .grip {
    position: relative;
    z-index: 5;
    flex: none;
    height: 44px;
    display: grid;
    grid-template-columns: auto minmax(0, auto) minmax(0, 1fr);
    align-items: center;
    column-gap: 8px;
    padding: 0 clamp(8px, 3vw, 12px);
    cursor: pointer;
    touch-action: none;
    border-bottom: 1px solid var(--panel-border);
    background: var(--panel-2);
  }
  .grip::before {
    content: '';
    width: 26px;
    height: 3px;
    border-radius: 2px;
    background: var(--panel-border);
    margin-right: 4px;
  }
  .peekbtn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    font-size: 13px;
    font-weight: 600;
    color: var(--panel-text);
    white-space: nowrap;
  }
  .peekbtn .lbl { overflow: hidden; text-overflow: ellipsis; }
  .gidbadge {
    flex: none;
    padding: 2px 5px;
    border: 1px solid var(--panel-border);
    border-radius: 2px;
    background: var(--panel-inset);
    color: var(--panel-muted);
    font-size: 10px;
    font-weight: 650;
    letter-spacing: 0.04em;
  }
  .gidname { font-size: 14px; font-weight: 650; color: var(--panel-text); }
  .peekbtn .chev {
    flex: none;
    width: 7px;
    height: 7px;
    border-right: 1.5px solid var(--panel-muted);
    border-bottom: 1.5px solid var(--panel-muted);
    transform: rotate(-135deg);
    transition: transform 0.22s ease;
  }
  .peekbtn .chev.open { transform: rotate(45deg); }
  .gripstatus {
    justify-self: end;
    min-width: 0;
    font-family: var(--mono);
    font-size: 11px;
    color: var(--panel-muted);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .scroll {
    --cad-scroll-pad: clamp(10px, 3vw, 14px);
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    overscroll-behavior: contain;
    touch-action: pan-y;
    display: flex;
    flex-direction: column;
    padding: 0 var(--cad-scroll-pad) 72px;
    gap: 0;
  }
  .sheethead { flex: none; padding: 4px clamp(10px, 3vw, 14px) 0; }
  .sheet[data-snap='peek'] .sheethead,
  .sheet[data-snap='peek'] .scroll,
  .sheet[data-snap='peek'] .scrollfade,
  .sheet[data-snap='peek'] .sheetfoot { visibility: hidden; }
  /* Sheet detents are the tightest budget in the product: the footer keeps the
     4px module but nothing more, so §4's scroll window survives on 360×780. */
  .sheetfoot {
    flex: none;
    padding: 4px clamp(10px, 3vw, 14px) calc(4px + env(safe-area-inset-bottom));
    border-top: 1px solid var(--panel-border);
    background: var(--panel-2);
  }
</style>
