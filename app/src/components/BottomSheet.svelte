<script>
  // 만들기 패널 셸(#158 B안). 하나의 컨텍스트 패널만 남았으므로 셸도 하나의 성격 —
  // "씬을 가리지 않는 만들기 표면" — 을 세 뷰포트 형태로 표현한다.
  //
  //   데스크톱(넓은 창)   : 좌하 카드(.ctxcard) — 낙관 위, 다이얼(우상)·공유 독(우하)과 충돌 없음
  //   가로 폰            : 좌측 42% 오버레이 패널(.ctxcard.landscape) — P1(가로폰 26px 스크롤) 해소
  //   세로 좁은 화면      : 바텀 시트(.sheet.context) — detent 2개(peek / half)
  //
  // detent 는 translateY 가 아니라 **가시 높이**로 정의한다(P2 근인). 시트는 항상 뷰포트 안에
  // 있고 max-height 만 바뀌므로 스크롤 본문이 화면 밖으로 밀려나지 않는다. 펼침 상한이 58vh 라서
  // 편집 중에도 씬이 42% 이상 상시 보인다(§4 지표: 편집 중 씬 ≥40%).
  import { tick } from 'svelte';
  import { device } from '../lib/device.svelte.js';
  import { t } from '../lib/i18n.svelte.js';

  let {
    open = false, ariaLabel = 'panel', gap = 13, peekPx = 80, detent = null, children,
    // sticky 헤더/푸터 — 상세만 내부 스크롤, 탭·주요 액션은 항상 가시.
    header = null, footer = null,
  } = $props();

  // 시트 상태머신 — 2 detent(peek / half). 'hidden' 은 open=false(연출 중 숨김) 전용.
  const HALF_VH = 0.58;                       // 펼침 상한(씬 ≥42% 상시 가시)
  let viewportH = $state(0);
  let snap = $state('hidden');
  let dragH = $state(null);                   // 드래그 중 실시간 가시 높이(px), null=스냅
  let dragging = $state(false);
  let suppressClick = false;
  let surface = $state(null);
  let grip = $state(null);

  const halfPx = $derived(Math.round((viewportH || 0) * HALF_VH));
  const detentH = (name) => (name === 'half' ? halfPx : peekPx);
  const sheetMax = $derived(dragH != null ? dragH : detentH(snap));
  const expanded = $derived(snap === 'half');
  // peek 에서는 손잡이만 실제로 보인다 → 그때만 본문이 키보드·접근성 소유권을 내놓는다.
  const contentInteractive = $derived(open && (!device.sheet || expanded));

  // 닫힘/접힘이 현재 포커스를 inert 로 만들 때만 계속 보이는 소유자로 회수한다.
  // References 가 앱 표면을 inert 로 만든 중첩 상태에서는 모달 포커스를 절대 빼앗지 않는다.
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

  // 외부 open 제어 → 진입(peek)/이탈(hidden).
  $effect(() => {
    if (!device.sheet) return;
    if (open) { if (snap === 'hidden') snap = 'peek'; }
    else snap = 'hidden';
  });
  // 외부 detent 요청(#158 P3): App 이 컨텍스트에 따라 실제로 값을 넘긴다 — 부감=peek, 근접=half.
  //   focus-in 이 시트를 자동으로 펼치므로 모바일 첫 사용자가 손잡이를 찾지 않아도 편집에 도달한다.
  $effect(() => {
    if (!device.sheet || !open || detent == null || dragging) return;
    if ((detent === 'half' || detent === 'peek') && snap !== 'hidden') snap = detent;
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
    const dy = e.clientY - startPY;                 // 아래로 끌면 +
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
  // 손잡이 탭 = 접힘↔펼침 2-state 토글('만들기 열기' 버튼 은유).
  function tapGrip() {
    if (suppressClick) { suppressClick = false; return; }
    snap = expanded ? 'peek' : 'half';
  }
</script>

<svelte:window bind:innerHeight={viewportH} />

{#if device.sheet}
  <aside
    bind:this={surface}
    class="sheet context hanji-surface" class:open class:dragging
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
  <!-- 데스크톱 좌하 카드 / 가로 폰 좌측 오버레이. 브레드크럼은 이 셸 밖(좌상)으로 나갔다(#158). -->
  <aside
    bind:this={surface}
    class="ctxcard hanji-surface"
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
  /* ---------- 데스크톱 좌하 "만들기" 카드 ----------
     좌상은 브레드크럼 하나만 쓰므로 3중 점유(P4)가 정의상 사라진다. 카드는 낙관 위에 앉고
     다이얼(우상)·공유 독(우하)과 겹치지 않는다. 상한은 62vh — 스크롤 가시 높이 ≥200px 확보. */
  .ctxcard {
    position: fixed;
    left: clamp(10px, 1.6vw, 22px);
    bottom: calc(clamp(16px, 3vh, 34px) + 58px);
    z-index: 32;
    width: min(304px, 84vw);
    max-height: min(62vh, calc(100vh - 108px));
    padding: 0;
    border-radius: 9px;
    display: flex; flex-direction: column;
    overflow: hidden;                          /* 카드 자체는 스크롤 안 함 — 상세 영역만 */
    transform: translateX(-118%);
    opacity: 0;
    transition: transform 0.45s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.35s ease;
    pointer-events: none;
  }
  .ctxcard.open { transform: translateX(0); opacity: 1; pointer-events: auto; }
  /* 가로 폰(P1): 데스크톱 카드의 200px 상수 클램프를 벗어나 좌측 42% 전高 오버레이로. */
  .ctxcard.landscape {
    top: max(8px, env(safe-area-inset-top));
    bottom: max(8px, env(safe-area-inset-bottom));
    left: max(8px, calc(env(safe-area-inset-left) + 4px));
    width: min(340px, 42vw);
    max-height: none;
  }
  .ctxhead { flex: none; padding: 12px 14px 0; }
  .ctxscroll {
    flex: 1 1 auto; min-height: 0; overflow-y: auto;
    display: flex; flex-direction: column;
    padding: 11px 14px 12px;
    overscroll-behavior: contain;
  }
  .ctxfoot { flex: none; padding: 10px 14px 12px; border-top: 1px solid var(--ink-line); }
  .ctxcard.landscape .ctxhead { padding: 8px 12px 0; }
  .ctxcard.landscape .ctxscroll { padding: 8px 12px 10px; }
  .ctxcard.landscape .ctxfoot { padding: 8px 12px 10px; }

  /* ---------- 세로 모바일 바텀 시트: 2 detent, 가시 높이로 정의 ---------- */
  .sheet {
    position: fixed;
    left: 0; right: 0; bottom: 0;
    z-index: 46;
    border-radius: 18px 18px 0 0;
    display: flex; flex-direction: column;
    overflow: hidden;
    transition: max-height 0.42s cubic-bezier(0.22, 1, 0.36, 1), transform 0.32s ease;
    will-change: max-height;
    touch-action: none;
    box-shadow: 0 -6px 26px rgba(30, 22, 14, 0.28), inset 0 0 0 1px rgba(255, 255, 255, 0.4);
  }
  .sheet.dragging { transition: none; }
  .sheet[aria-hidden='true'] { transform: translateY(110%); pointer-events: none; }

  .grip {
    position: relative;
    flex: none;
    height: 46px;
    display: grid; place-items: center;
    cursor: pointer;
    touch-action: none;
  }
  .peekbtn {
    display: inline-flex; align-items: center; gap: 8px;
    padding: 8px 18px; border-radius: 999px;
    background: rgba(44, 38, 32, 0.06); border: 1px solid var(--ink-hair);
    font-family: var(--serif); font-size: 14px; font-weight: 700; color: var(--ink);
  }
  .peekbtn .chev {
    width: 9px; height: 9px; margin-top: 2px;
    border-right: 2px solid var(--ink-soft); border-bottom: 2px solid var(--ink-soft);
    transform: rotate(-135deg);                       /* 접힘=위(펼치기) */
    transition: transform 0.22s ease, margin 0.22s ease;
  }
  .peekbtn .chev.open { transform: rotate(45deg); margin-top: -2px; }   /* 펼침=아래(접기) */
  .scroll {
    flex: 1 1 auto; min-height: 0;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    overscroll-behavior: contain;
    touch-action: pan-y;
    display: flex; flex-direction: column;
    padding: 0 clamp(16px, 5vw, 22px) 12px;
  }
  .sheethead { flex: none; padding: 2px clamp(16px, 5vw, 22px) 8px; }
  /* 접힘(peek)에서는 손잡이만 보인다 — 잘린 헤더 조각이 씬 위에 남지 않게. */
  .sheet[data-snap='peek'] .sheethead,
  .sheet[data-snap='peek'] .scroll,
  .sheet[data-snap='peek'] .sheetfoot { visibility: hidden; }
  /* 푸터는 시트가 늘 뷰포트 안에 있으므로 실제 하단에 도킹된다(구 상단 도킹 우회 불필요). */
  .sheetfoot {
    flex: none;
    padding: 9px clamp(16px, 5vw, 22px) calc(10px + env(safe-area-inset-bottom));
    border-top: 1px solid var(--ink-line);
  }
</style>
