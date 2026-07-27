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
  /* Top-left path bar — glass chip, not a paper slab. */
  .crumbs {
    position: fixed;
    left: clamp(10px, 1.6vw, 22px);
    top: clamp(10px, 1.6vh, 22px);
    z-index: 40;
    display: flex; align-items: baseline; gap: 7px;
    max-width: min(36vw, calc(100vw - var(--inspector-w, 0px) - 200px), 320px);
    padding: 6px 12px 7px;
    border-radius: 8px;
    background-color: var(--glass);
    background-image: var(--grain);
    border: 1px solid var(--glass-border);
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.28);
    user-select: none;
  }
  .crumb {
    background: none; border: none; padding: 0;
    font-family: var(--ui); color: var(--glass-text);
  }
  .crumb.root {
    margin: 0; font-size: 14px; font-weight: 650; line-height: 1.2; cursor: default;
    min-width: 44px; min-height: 44px;
    display: inline-flex; align-items: center;
  }
  .crumb.root.link { cursor: pointer; color: var(--glass-muted); }
  .crumb.root.link:hover { color: #fff; }
  .crumb.root.link:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
  .sep { font-size: 13px; color: var(--glass-muted); opacity: 0.7; transition: opacity 0.24s ease; }
  .crumb.leaf {
    font-size: 14px; font-weight: 650; line-height: 1.2; color: var(--accent);
    transition: opacity 0.24s ease; white-space: nowrap;
    overflow: hidden; text-overflow: ellipsis;
  }
  .count {
    margin-left: 4px; font-family: var(--mono); font-size: 11px; font-weight: 600;
    color: var(--glass-muted); font-variant-numeric: tabular-nums;
  }
  .busylabel {
    font-family: var(--ui); font-size: 10.5px; letter-spacing: 0.06em;
    color: var(--glass-muted);
  }
  .crumbs.busy { border-color: rgba(90, 168, 224, 0.45); }

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

  /* Landscape phone: inspector is a RIGHT rail — path bar stays top-left of the
     viewport (not offset past a retired left panel). */
  @media (max-height: 520px) and (orientation: landscape) {
    .crumbs {
      left: max(10px, calc(env(safe-area-inset-left) + 6px));
      top: max(8px, env(safe-area-inset-top));
      max-width: min(28vw, calc(100vw - var(--inspector-w, 0px) - 120px), 220px);
    }
    .crumb.root, .crumb.leaf { font-size: 15px; }
  }
</style>
