<script>
  // 반응형 패널 셸. 데스크톱은 기존 우측 한지 패널(.panel) / 좌상 카드(.vcard) 그대로,
  // 모바일(device.sheet)에서는 드래그 핸들·detent(반개/전개)·스크림을 갖춘 바텀 시트로 전환.
  // 내용은 children 스니펫으로 받아 부모의 스타일 스코프를 유지한다(.tab/.step/.opt 등 그대로).
  //
  //   variant='right'    : 집 고치기 패널. 모바일 detent [full, half], half 아래로 끌면 닫힘, 스크림.
  //   variant='leftCard' : 마을 옵션. 모바일 detent [full, half, peek], 닫히지 않고 peek 로 접힘, 스크림 없음(씬 계속 선택 가능).
  //   variant='context'  : 단일 컨텍스트 패널(#92) — 데스크톱 우측 드로어(넓음, 편집 스키마 수용), 모바일
  //                        은 detent [full, half, peek] 상주 시트(스크림 없음 — 부감에서 줌·필지 조작 유지).
  //                        detent prop 으로 컨텍스트 전환 시 외부에서 detent 요청(부감=peek, 근접=half).
  import { device } from '../lib/device.svelte.js';

  let {
    open = false, onClose, variant = 'right', ariaLabel = 'panel',
    closable = true, gap = 18, peekPx = 80, detent = null, children,
    // #118 U1: context 패널 sticky 헤더/푸터 — 상세만 내부 스크롤, 액션은 항상 가시.
    //   header(브레드크럼)·footer(액션)를 스크롤 밖 고정 영역으로 렌더한다. 데스크톱은 카드 하단 푸터,
    //   모바일 시트는 상단 도킹(half detent 에서 아래 밀려나 감춰지지 않도록 grip 아래로). context 만 사용.
    header = null, footer = null,
  } = $props();
  // 상주·소형카드 계열(스크림 없이 씬 조작 유지, peek detent 허용).
  const isCard = $derived(variant === 'leftCard' || variant === 'context');

  // 모바일 시트 상태머신 — translateY(px, 아래로 +)로 detent 표현.
  //   full(0) → half → peek(H-peekPx) → hidden(H+40).
  let sheetH = $state(0);
  const HALF = 0.46;                       // half 에서 아래로 감출 비율(≈54% 표시)
  let snap = $state('hidden');
  let dragY = $state(null);                // 드래그 중 실시간 translateY(px), null=스냅
  let dragging = $state(false);
  let suppressClick = false;

  const detentY = (name) => {
    const H = sheetH || 1;
    if (name === 'full') return 0;
    if (name === 'half') return H * HALF;
    if (name === 'peek') return Math.max(0, H - peekPx);
    return H + 40;                          // hidden
  };
  const transY = $derived(dragY != null ? dragY : detentY(snap));

  // 외부 open 제어 → 진입(half)/이탈(hidden).
  let openedAt = 0;
  $effect(() => {
    if (!device.sheet) return;
    if (open) {
      // 카드 계열(마을 옵션·컨텍스트)은 peek 로 진입 — 씬·액션바를 가리지 않고 손잡이만 노출.
      // 집 편집(right)은 half 로 진입.
      if (snap === 'hidden') { snap = isCard ? 'peek' : 'half'; openedAt = performance.now(); }
    } else snap = 'hidden';
  });
  // 외부 detent 요청(#92 컨텍스트 전환 — 부감=peek, 근접=half). 드래그 중이 아니면 부드럽게 스냅.
  $effect(() => {
    if (!device.sheet || !open || detent == null || dragging) return;
    if ((detent === 'full' || detent === 'half' || detent === 'peek') && snap !== 'hidden') snap = detent;
  });
  // 선택 탭(캔버스)의 후속 click/compat-mouse 가 갓 나타난 스크림에 떨어져 곧바로 닫히는 것을 방지.
  function scrimClose() {
    if (performance.now() - openedAt < 350) return;
    onClose?.();
  }

  let startPY = 0, startY = 0, movedBy = 0;
  function down(e) {
    if (!device.sheet) return;
    dragging = true; movedBy = 0;
    startPY = e.clientY; startY = detentY(snap); dragY = startY;
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }
  function move(e) {
    if (!dragging) return;
    const dy = e.clientY - startPY;
    movedBy = Math.max(movedBy, Math.abs(dy));
    dragY = Math.max(-24, Math.min(sheetH + 40, startY + dy));
  }
  function up() {
    if (!dragging) return;
    dragging = false;
    const y = dragY; dragY = null;
    suppressClick = movedBy > 6;
    const allowed = isCard ? ['full', 'half', 'peek'] : ['full', 'half'];
    if (variant === 'right' && y > detentY('half') + sheetH * 0.16) { onClose?.(); return; }
    let best = allowed[0], bd = 1e9;
    for (const a of allowed) { const d = Math.abs(y - detentY(a)); if (d < bd) { bd = d; best = a; } }
    snap = best;
  }
  // 핸들 탭 = detent 토글(드래그 후 클릭은 무시).
  function tapGrip() {
    if (suppressClick) { suppressClick = false; return; }
    if (isCard) snap = snap === 'peek' ? 'half' : snap === 'half' ? 'full' : 'peek';
    else snap = snap === 'full' ? 'half' : 'full';
  }
</script>

{#if device.sheet}
  {#if variant === 'right'}
    <div class="scrim" class:show={open && snap !== 'hidden'} onclick={scrimClose} aria-hidden="true"></div>
  {/if}
  <aside
    bind:clientHeight={sheetH}
    class="sheet {variant} hanji-surface" class:open class:dragging
    data-snap={snap}
    style="transform: translateY({transY}px)"
    aria-hidden={!open}
    aria-label={ariaLabel}
  >
    <div
      class="grip" role="button" tabindex="0" aria-label="drag handle"
      onpointerdown={down} onpointermove={move} onpointerup={up} onpointercancel={up}
      onclick={tapGrip}
      onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); tapGrip(); } }}
    >
      <span class="bar"></span>
      {#if closable}
        <button class="x" onclick={(e) => { e.stopPropagation(); onClose?.(); }} aria-label="close">×</button>
      {/if}
    </div>
    <!-- #118 U1: context 헤더/푸터는 grip 아래 고정 도킹 — half detent(하단 46% 감춤)에서도 상단
         가시 영역에 남아 브레드크럼·주요 액션이 항상 보인다(바텀시트는 하단이 뷰포트 밖으로 밀리므로). -->
    {#if header}<div class="sheethead">{@render header()}</div>{/if}
    {#if footer}<div class="sheetfoot">{@render footer()}</div>{/if}
    <div class="scroll" style="gap:{gap}px">{@render children?.()}</div>
  </aside>
{:else if variant === 'right'}
  <aside class="panel hanji-surface" class:open aria-hidden={!open} style="gap:{gap}px">
    {#if closable}<button class="close" onclick={onClose} aria-label="close">×</button>{/if}
    {@render children?.()}
  </aside>
{:else if variant === 'context'}
  <!-- 단일 컨텍스트 패널(#92) 데스크톱 — 좌상단 자동높이 카드. #118 U1: 헤더(브레드크럼)·푸터(액션)를
       스크롤 밖 고정, 상세만 내부 스크롤 → 기본 펼침이어도 주요 액션이 폴드 아래 매몰되지 않는다. -->
  <aside class="ctxcard hanji-surface" class:open aria-hidden={!open}>
    {#if header}<div class="ctxhead">{@render header()}</div>{/if}
    <div class="ctxscroll" style="gap:{gap}px">{@render children?.()}</div>
    {#if footer}<div class="ctxfoot">{@render footer()}</div>{/if}
  </aside>
{:else}
  <aside class="vcard hanji-surface" class:open aria-hidden={!open} style="gap:{gap}px">
    {@render children?.()}
  </aside>
{/if}

<style>
  /* ---------- 데스크톱 우측 패널 (기존 .panel 그대로 — 셀렉터·룩 보존) ---------- */
  .panel {
    position: fixed;
    top: 0; right: 0; bottom: 0;
    width: min(320px, 84vw);
    z-index: 30;
    padding: clamp(18px, 3vh, 30px) clamp(16px, 2vw, 24px);
    transform: translateX(104%);
    transition: transform 0.5s cubic-bezier(0.22, 1, 0.36, 1);
    overflow-y: auto;
    display: flex;
    flex-direction: column;
  }
  .panel.open { transform: translateX(0); }
  .close {
    position: absolute; top: 12px; right: 14px;
    width: 30px; height: 30px; border-radius: 50%;
    border: 1px solid var(--ink-hair); background: transparent;
    font-size: 20px; line-height: 1; color: var(--ink-soft);
  }
  .close:hover { background: rgba(44, 38, 32, 0.06); }

  /* ---------- 데스크톱 좌상 카드 (마을 옵션) ---------- */
  .vcard {
    position: fixed;
    left: clamp(10px, 1.6vw, 22px);
    top: calc(clamp(10px, 1.6vh, 22px) + 52px);
    z-index: 32;
    width: 216px;
    max-width: 78vw;
    padding: 14px 15px 16px;
    border-radius: 9px;
    display: flex; flex-direction: column;
    transform: translateX(-118%);
    opacity: 0;
    transition: transform 0.45s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.35s ease;
    pointer-events: none;
  }
  .vcard.open { transform: translateX(0); opacity: 1; pointer-events: auto; }

  /* ---------- 데스크톱 단일 컨텍스트 카드(#92) — 좌상단(ModeToggle 아래) 자동높이, 편집 시 늘어나 스크롤 ----------
     마을 옵션(구 vcard) 자리를 계승해 다이얼(우상단)·액션바(우하단)와 충돌하지 않는다(시프트 불필요). */
  .ctxcard {
    position: fixed;
    left: clamp(10px, 1.6vw, 22px);
    top: calc(clamp(10px, 1.6vh, 22px) + 52px);
    z-index: 32;
    width: min(300px, 84vw);
    max-height: calc(100vh - clamp(10px, 1.6vh, 22px) - 200px);
    padding: 0;
    border-radius: 9px;
    display: flex; flex-direction: column;
    overflow: hidden;                          /* #118 U1: 카드 자체는 스크롤 안 함 — 상세 영역만 스크롤 */
    transform: translateX(-118%);
    opacity: 0;
    transition: transform 0.45s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.35s ease;
    pointer-events: none;
  }
  .ctxcard.open { transform: translateX(0); opacity: 1; pointer-events: auto; }
  /* #118 U1: 고정 헤더(브레드크럼) / 스크롤 상세 / 고정 푸터(액션) 3분할. */
  .ctxhead { flex: none; padding: 15px 16px 0; }
  .ctxscroll {
    flex: 1 1 auto; min-height: 0; overflow-y: auto;
    display: flex; flex-direction: column;
    padding: 12px 16px 14px;
    overscroll-behavior: contain;
  }
  .ctxfoot { flex: none; padding: 13px 16px 16px; border-top: 1px solid var(--ink-line); }

  /* ---------- 모바일 바텀 시트 ---------- */
  .scrim {
    position: fixed; inset: 0; z-index: 33;
    background: rgba(24, 18, 12, 0.22);
    opacity: 0; pointer-events: none;
    transition: opacity 0.35s ease;
  }
  .scrim.show { opacity: 1; pointer-events: auto; }

  .sheet {
    position: fixed;
    left: 0; right: 0; bottom: 0;
    z-index: 46;
    max-height: 88vh;
    border-radius: 18px 18px 0 0;
    display: flex; flex-direction: column;
    transition: transform 0.42s cubic-bezier(0.22, 1, 0.36, 1);
    will-change: transform;
    touch-action: none;
    box-shadow: 0 -6px 26px rgba(30, 22, 14, 0.28), inset 0 0 0 1px rgba(255, 255, 255, 0.4);
  }
  .sheet.dragging { transition: none; }
  .sheet[aria-hidden='true'] { pointer-events: none; }

  .grip {
    position: relative;
    flex: none;
    height: 30px;
    display: grid; place-items: center;
    cursor: grab;
    touch-action: none;
  }
  .grip:active { cursor: grabbing; }
  .grip .bar {
    width: 44px; height: 5px; border-radius: 3px;
    background: var(--ink-faint); opacity: 0.55;
  }
  .grip .x {
    position: absolute; right: 10px; top: 50%; transform: translateY(-50%);
    width: 34px; height: 34px; border-radius: 50%;
    border: 1px solid var(--ink-hair); background: transparent;
    font-size: 22px; line-height: 1; color: var(--ink-soft);
    display: grid; place-items: center;
  }
  .scroll {
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    overscroll-behavior: contain;
    touch-action: pan-y;
    display: flex; flex-direction: column;
    padding: 0 clamp(16px, 5vw, 22px) calc(20px + env(safe-area-inset-bottom));
  }
  /* #118 U1 모바일: 헤더·푸터를 grip 아래 고정 도킹 — half detent 상단 가시대에 남아 액션이 감춰지지
     않는다(바텀시트 하단은 뷰포트 밖으로 밀림). 푸터 아래 border 로 스크롤 상세와 구분. */
  .sheethead { flex: none; padding: 2px clamp(16px, 5vw, 22px) 0; }
  .sheetfoot {
    flex: none; padding: 12px clamp(16px, 5vw, 22px) 13px;
    border-bottom: 1px solid var(--ink-line);
  }
</style>
