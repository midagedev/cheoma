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
  /* Shrink-wrapped card in the free viewport. Width is explicit so portrait
     overrides can reset it — a leftover min() left the card ~190px wide and
     Korean lines broke into single characters. */
  .scene-guide {
    position: fixed;
    left: max(16px, env(safe-area-inset-left));
    right: auto;
    top: max(56px, calc(env(safe-area-inset-top) + 48px));
    z-index: 18;
    width: min(420px, calc(100vw - var(--inspector-w, 0px) - 200px));
    max-width: min(420px, calc(100vw - var(--inspector-w, 0px) - 200px));
    margin: 0;
    pointer-events: none;
    animation: guide-in 0.42s cubic-bezier(0.22, 1, 0.36, 1) both;
  }

  .paper {
    position: relative;
    padding: 10px 42px 11px 12px;
    border: 1px solid var(--glass-border);
    border-radius: 8px;
    color: var(--glass-text);
    background-color: var(--glass-strong);
    background-image: var(--grain);
    box-shadow: 0 10px 28px rgba(0, 0, 0, 0.32);
  }

  .title {
    margin: 0 0 7px;
    color: var(--glass-muted);
    font-family: var(--ui);
    font-size: 10px;
    font-weight: 650;
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }

  ul {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 5px 14px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  li {
    min-width: 0;
    display: grid;
    grid-template-columns: 22px minmax(0, 1fr);
    align-items: center;
    gap: 7px;
    color: var(--glass-text);
    font-family: var(--ui);
    font-size: 11.5px;
    line-height: 1.3;
  }

  .mark {
    width: 22px;
    height: 22px;
    display: grid;
    place-items: center;
    border: 1px solid var(--glass-border);
    border-radius: 4px;
    color: var(--accent);
    background: rgba(255, 255, 255, 0.05);
    font-family: var(--mono);
    font-size: 11px;
    font-weight: 650;
    line-height: 1;
  }

  .dismiss {
    position: absolute;
    top: 2px;
    right: 2px;
    min-width: 44px;
    min-height: 44px;
    display: grid;
    place-items: center;
    padding: 0;
    border: 0;
    border-radius: 6px;
    color: var(--glass-muted);
    background: transparent;
    font-size: 20px;
    font-weight: 300;
    line-height: 1;
    pointer-events: auto;
  }

  .dismiss:hover {
    color: var(--accent);
    background: rgba(255, 255, 255, 0.06);
  }

  .dismiss:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -4px;
  }

  @keyframes guide-in {
    from { opacity: 0; transform: translateY(-8px); }
    to { opacity: 1; transform: translateY(0); }
  }

  /* Portrait touch UI: the top belongs to the breadcrumb and the view card, so
     the guide sits between them and the peek sheet, clear of the raised dock. */
  @media (max-width: 768px) and (orientation: portrait) {
    .scene-guide.touch {
      left: 10px;
      right: 10px;
      top: auto;
      width: auto;
      max-width: none;
      /* The dock publishes --dock-h because it wraps to a second row on narrow
         phones and long locales; a constant clearance read the one-row case and
         let the card cover the drone button (#158 P5). */
      bottom: calc(max(96px, env(safe-area-inset-bottom) + 90px) + var(--dock-h, 58px) + 10px);
    }
    .paper { padding: 9px 40px 10px 10px; }
    .title { margin: 0 0 5px; font-size: 9.5px; }
    ul { gap: 4px 8px; grid-template-columns: 1fr 1fr; }
    li { grid-template-columns: 20px minmax(0, 1fr); gap: 5px; font-size: 11px; line-height: 1.3; }
    .mark { width: 20px; height: 20px; font-size: 10px; border-radius: 3px; }
  }

  @media (max-width: 360px) {
    ul { grid-template-columns: 1fr; }
  }

  /* Landscape phone: hide the onboarding card — the right rail + short height
     leave no framing band once a left-anchored guide also claims an edge. */
  @media (max-height: 520px) and (orientation: landscape) {
    .scene-guide.touch {
      display: none;
    }
  }
</style>
