<script>
  // First stable village-frame help. It is deliberately nonmodal: the card
  // never receives stage input, and only its 44px dismiss button is interactive.
  import { device } from '../lib/device.svelte.js';
  import { t } from '../lib/i18n.svelte.js';

  let {
    visible = false,
    touch = null,
    onDismiss = null,
  } = $props();

  const touchLayout = $derived(touch ?? device.touch);
  // 문 열기/닫기는 호버 힌트에만 있어 터치 사용자에게는 존재하지 않는 인터랙션이었다(#158 P7).
  // 안내 카드에 한 줄로 올려 두 입력 방식 모두에서 발견 가능하게 한다.
  const instructionKeys = $derived(touchLayout
    ? ['guide_touch_orbit', 'guide_touch_zoom', 'guide_touch_house', 'guide_touch_door', 'guide_touch_exit']
    : ['guide_desktop_orbit', 'guide_desktop_zoom', 'guide_desktop_house', 'guide_desktop_door', 'guide_desktop_exit']);
  const marks = $derived(touchLayout ? ['1', '2', '⌂', '戶', '↩'] : ['↻', '＋', '⌂', '戶', '↩']);
</script>

{#if visible}
  <aside
    class="scene-guide"
    class:touch={touchLayout}
    data-scene-guide
    data-input={touchLayout ? 'touch' : 'desktop'}
    aria-label={t('guide_title')}
  >
    <div class="paper">
      <p class="title">{t('guide_title')}</p>
      <ul>
        {#each instructionKeys as key, i}
          <li>
            <span class="mark" aria-hidden="true">{marks[i]}</span>
            <span>{t(key)}</span>
          </li>
        {/each}
      </ul>
      <button
        type="button"
        class="dismiss"
        onclick={() => onDismiss?.()}
        aria-label={t('guide_dismiss')}
        title={t('guide_dismiss')}
      >×</button>
    </div>
  </aside>
{/if}

<style>
  /* 하단은 만들기 패널(좌하)·공유 독(우하)이 쓰므로, 데스크톱 안내는 상단 자유 대역
     (좌상 브레드크럼과 우상 보기 카드 사이)에 좌우 인셋으로 클램프해 앉힌다 — 어느 액션도
     시각적으로 가리지 않는다(#158 P5: 구 안내는 드론 버튼을 반쯤 덮었다). */
  /* Insets are chosen so the card cannot intersect either bottom-left panel or
     top-right view card on any axis, whatever the window height does to the
     panel's 62vh box: 340px clears the panel column, 250px clears the dial. */
  .scene-guide {
    position: fixed;
    left: 340px;
    right: 250px;
    top: max(20px, calc(env(safe-area-inset-top) + 14px));
    z-index: 18;
    width: auto;
    max-width: 548px;
    margin: 0 auto;
    pointer-events: none;
    animation: guide-in 0.42s cubic-bezier(0.22, 1, 0.36, 1) both;
  }

  .paper {
    position: relative;
    padding: 15px 54px 16px 18px;
    border: 1px solid rgba(44, 38, 32, 0.22);
    border-left: 3px solid var(--seal);
    border-radius: 7px;
    color: var(--ink);
    background-color: rgba(244, 239, 228, 0.94);
    background-image:
      var(--hanji),
      linear-gradient(155deg, rgba(250, 246, 237, 0.96), rgba(232, 222, 204, 0.94));
    box-shadow:
      0 8px 28px rgba(22, 17, 12, 0.22),
      inset 0 0 0 1px rgba(255, 255, 255, 0.38);
    backdrop-filter: blur(7px);
    -webkit-backdrop-filter: blur(7px);
  }

  .title {
    margin: 0 0 10px;
    color: var(--ink-soft);
    font-family: var(--serif);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.16em;
    text-transform: uppercase;
  }

  ul {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px 18px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  li {
    min-width: 0;
    display: grid;
    grid-template-columns: 25px minmax(0, 1fr);
    align-items: center;
    gap: 8px;
    color: var(--ink);
    font-family: var(--serif);
    font-size: 12.5px;
    line-height: 1.35;
  }

  .mark {
    width: 25px;
    height: 25px;
    display: grid;
    place-items: center;
    border: 1px solid var(--ink-hair);
    border-radius: 50%;
    color: var(--seal);
    background: rgba(255, 255, 255, 0.24);
    font-family: var(--serif);
    font-size: 13px;
    font-weight: 700;
    line-height: 1;
  }

  .dismiss {
    position: absolute;
    top: 4px;
    right: 4px;
    min-width: 44px;
    min-height: 44px;
    display: grid;
    place-items: center;
    padding: 0;
    border: 0;
    border-radius: 50%;
    color: var(--ink-soft);
    background: transparent;
    font-size: 23px;
    font-weight: 300;
    line-height: 1;
    pointer-events: auto;
  }

  .dismiss:hover {
    color: var(--seal);
    background: rgba(44, 38, 32, 0.06);
  }

  .dismiss:focus-visible {
    outline: 2px solid var(--seal);
    outline-offset: -4px;
  }

  @keyframes guide-in {
    from { opacity: 0; transform: translateY(-8px); }
    to { opacity: 1; transform: translateY(0); }
  }

  /* Narrow desktop windows keep the same insets with a tighter right edge, so the
     card shrinks instead of sliding under the view card. */
  @media (max-width: 1180px) {
    .scene-guide { right: 216px; max-width: 520px; }
  }

  /* Portrait touch UI: the top belongs to the breadcrumb and the view card, so
     the guide sits between them and the peek sheet, clear of the raised dock. */
  @media (max-width: 768px) and (orientation: portrait) {
    .scene-guide.touch {
      left: 12px;
      right: 12px;
      top: auto;
      /* The dock publishes --dock-h because it wraps to a second row on narrow
         phones and long locales; a constant clearance read the one-row case and
         let the card cover the drone button (#158 P5). */
      bottom: calc(max(96px, env(safe-area-inset-bottom) + 90px) + var(--dock-h, 58px) + 14px);
      max-width: min(366px, calc(100vw - 24px));
    }
    .paper { padding: 14px 50px 15px 14px; }
    ul { gap: 8px 11px; }
    li { grid-template-columns: 23px minmax(0, 1fr); gap: 7px; font-size: 11.5px; }
    .mark { width: 23px; height: 23px; font-size: 12px; }
  }

  @media (max-width: 360px) {
    ul { grid-template-columns: 1fr; }
  }

  /* Landscape phone: the make panel owns the left 42% and the dock the bottom
     right, so the guide is clamped into the remaining upper-right band. */
  @media (max-height: 520px) and (orientation: landscape) {
    .scene-guide.touch {
      /* Between the left make panel and the right view card, above the dock. */
      left: calc(min(340px, 42vw) + 16px);
      right: 200px;
      top: auto;
      bottom: calc(max(16px, env(safe-area-inset-bottom) + 12px) + var(--dock-h, 58px) + 14px);
      max-width: none;
    }
    .paper { padding-block: 10px; }
    .title { margin-bottom: 7px; }
    /* The clamped band is narrow, so one line per row instead of two cramped columns. */
    ul { grid-template-columns: 1fr; gap: 5px; }
    li { font-size: 11.5px; }
  }
</style>
