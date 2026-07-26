<script>
  // 좌상 브레드크럼(#158 B안) — 폐기된 ModeToggle 의 승계자.
  //   mode-integration §5.5 원칙 1("마을 브레드크럼이 정규 focus-out 창구")을 실제 유일 창구로 승격한다.
  //   집으로 들어가는 창구는 씬의 집 클릭(또는 만들기 패널의 [집] 탭)이고, 나오는 창구는 여기 루트다.
  //   좌상 슬롯을 이 컴포넌트 하나만 쓰므로 P4(좌표 3중 점유)가 정의상 소멸한다.
  //   전환 중에는 aria-busy 로 "이동 중"을 표시한다(P12: 2-state 토글이 숨기던 상태).
  import { tick } from 'svelte';
  import { t } from '../lib/i18n.svelte.js';

  let {
    houseLabel = '', houses = 0, houseActive = false, busy = false, onBack = null,
  } = $props();

  // 컨텍스트가 바뀌면 이 nav 는 루트 요소를 버튼↔제목으로 **교체**한다. 그러면 나가는 요소가
  // 언마운트되며 포커스가 body 로 떨어지므로, 그 인계는 요소를 소유한 이 컴포넌트가 해야 한다.
  // (ContextPanel 도 같은 인계를 시도하지만 그쪽 `$effect.pre` 가 읽는 시점은 이 컴포넌트의 DOM
  // 교체 뒤일 수 있어 — 실측: activeElement 가 이미 BODY — 헤더 케이스는 여기서 소유한다.
  // 두 경로 모두 같은 목적지를 가리키므로 중복 실행돼도 결과는 같다.)
  let previousHouseActive = null;
  $effect.pre(() => {
    const next = houseActive;
    if (previousHouseActive == null) { previousHouseActive = next; return; }
    if (previousHouseActive === next) return;
    const outgoing = previousHouseActive ? 'house' : 'village';
    previousHouseActive = next;
    const active = typeof document === 'undefined' ? null : document.activeElement;
    if (!active || active.dataset?.contextFocus !== outgoing) return;
    void tick().then(() => {
      const destination = document.querySelector(`[data-context-focus="${next ? 'house' : 'village'}"]`);
      if (destination?.isConnected && !destination.closest('[inert]')) {
        destination.focus({ preventScroll: true });
      }
    });
  });
</script>

<nav
  class="crumbs"
  class:busy
  data-breadcrumb
  aria-label={t('vil_title')}
  aria-busy={busy ? 'true' : undefined}
>
  {#if houseActive}
    <button
      class="crumb root link"
      type="button"
      onclick={() => onBack?.()}
      aria-label={t('vil_title')}
      title={t('crumb_back_tip')}
      data-context-focus="house"
    >{t('vil_title')}</button>
  {:else}
    <h3
      class="crumb root"
      tabindex="-1"
      data-context-focus="village"
    >{t('vil_title')}</h3>
  {/if}
  {#if houseActive || houseLabel}
    <span class="sep" style="opacity:{houseActive ? 1 : 0}" aria-hidden="true">›</span>
    <span class="crumb leaf" style="opacity:{houseActive ? 1 : 0}">{houseLabel}</span>
  {/if}
  {#if !houseActive && houses > 0}<span class="count">{houses}{t('vil_houses')}</span>{/if}
  {#if busy}<span class="busylabel" role="status" aria-live="polite">{t('crumb_busy')}</span>{/if}
</nav>

<style>
  /* 좌상 단독 슬롯. 씬 위에 얹히는 먹빛 글라스 — 한지 슬래브를 놓지 않아 씬 톤을 깨지 않는다. */
  .crumbs {
    position: fixed;
    left: clamp(10px, 1.6vw, 22px);
    top: clamp(10px, 1.6vh, 22px);
    z-index: 40;
    display: flex; align-items: baseline; gap: 7px;
    max-width: min(52vw, 420px);
    padding: 5px 12px 6px;
    border-radius: 8px;
    background-color: rgba(30, 24, 18, 0.22);
    border: 1px solid rgba(244, 239, 228, 0.26);
    backdrop-filter: blur(3px); -webkit-backdrop-filter: blur(3px);
    box-shadow: 0 2px 10px rgba(30, 22, 14, 0.22);
    user-select: none;
  }
  .crumb {
    background: none; border: none; padding: 0;
    font-family: var(--brush); color: rgba(244, 239, 228, 0.94);
    text-shadow: 0 1px 5px rgba(30, 22, 14, 0.6);
  }
  .crumb.root { margin: 0; font-size: 22px; line-height: 1.1; cursor: default; }
  .crumb.root.link { cursor: pointer; color: rgba(244, 239, 228, 0.8); }
  .crumb.root.link:hover { color: #fff2e2; }
  .crumb.root.link:focus-visible { outline: 2px solid var(--seal); outline-offset: 3px; }
  .sep { font-size: 17px; color: rgba(244, 239, 228, 0.6); transition: opacity 0.24s ease; }
  .crumb.leaf {
    font-size: 22px; line-height: 1.1; color: #ffd9c8;
    transition: opacity 0.24s ease; white-space: nowrap;
    overflow: hidden; text-overflow: ellipsis;
  }
  .count {
    margin-left: 4px; font-family: var(--serif); font-size: 11px; font-weight: 700;
    color: #ffd9c8; font-variant-numeric: tabular-nums;
    text-shadow: 0 1px 5px rgba(30, 22, 14, 0.6);
  }
  .busylabel {
    font-family: var(--serif); font-size: 10.5px; letter-spacing: 0.1em;
    color: rgba(244, 239, 228, 0.78);
  }
  .crumbs.busy { border-color: rgba(255, 214, 170, 0.5); }

  /* 터치: 루트 타깃 ≥44px. */
  @media (pointer: coarse) {
    .crumbs {
      left: max(10px, calc(env(safe-area-inset-left) + 6px));
      top: max(10px, calc(env(safe-area-inset-top) + 4px));
      padding: 4px 12px 5px;
      max-width: min(58vw, 320px);
    }
    .crumb.root, .crumb.leaf { font-size: 21px; }
    .crumb.root.link { min-height: 44px; display: flex; align-items: center; padding: 0 2px; }
  }

  /* 가로 폰: 만들기 패널이 좌측 42% 전高를 쓰므로 브레드크럼은 그 오른쪽 상단 대역으로 물러난다
     (좌상 단독 점유 규약은 "패널과 겹치지 않는다"는 뜻이다 — #158 P4). */
  @media (max-height: 520px) and (orientation: landscape) {
    .crumbs {
      left: calc(min(340px, 42vw) + 16px);
      top: max(8px, env(safe-area-inset-top));
      max-width: min(38vw, 260px);
    }
  }
</style>
