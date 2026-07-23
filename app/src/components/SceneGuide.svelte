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
  const instructionKeys = $derived(touchLayout
    ? ['guide_touch_orbit', 'guide_touch_zoom', 'guide_touch_house', 'guide_touch_exit']
    : ['guide_desktop_orbit', 'guide_desktop_zoom', 'guide_desktop_house', 'guide_desktop_exit']);
  const marks = $derived(touchLayout ? ['1', '2', '⌂', '↩'] : ['↻', '＋', '⌂', 'Esc']);
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
            <span class="mark" class:word={marks[i] === 'Esc'} aria-hidden="true">{marks[i]}</span>
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
  .scene-guide {
    position: fixed;
    left: 50%;
    bottom: max(24px, calc(env(safe-area-inset-bottom) + 18px));
    z-index: 18;
    width: min(548px, calc(100vw - 32px));
    transform: translateX(-50%);
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

  .mark.word {
    border-radius: 4px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 8px;
    letter-spacing: -0.04em;
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
    from { opacity: 0; transform: translate(-50%, 8px); }
    to { opacity: 1; transform: translate(-50%, 0); }
  }

  /* Portrait touch UI has a bottom-sheet peek and raised action bar. Keep the
     guide above both without claiming any of their input area. */
  @media (max-width: 768px) and (orientation: portrait) {
    .scene-guide.touch {
      bottom: max(170px, calc(env(safe-area-inset-bottom) + 164px));
      width: min(366px, calc(100vw - 24px));
    }
    .paper { padding: 14px 50px 15px 14px; }
    ul { gap: 8px 11px; }
    li { grid-template-columns: 23px minmax(0, 1fr); gap: 7px; font-size: 11.5px; }
    .mark { width: 23px; height: 23px; font-size: 12px; }
  }

  @media (max-width: 360px) {
    ul { grid-template-columns: 1fr; }
  }

  @media (max-height: 520px) and (orientation: landscape) {
    .scene-guide { bottom: max(12px, calc(env(safe-area-inset-bottom) + 8px)); }
    .paper { padding-block: 10px; }
    .title { margin-bottom: 7px; }
    ul { gap-block: 5px; }
  }
</style>
