<script>
  // First stable village-frame help. Nonmodal: card never receives stage input;
  // only the 44px dismiss control is interactive.
  import { device } from '../lib/device.svelte.js';
  import { t } from '../lib/i18n.svelte.js';

  let {
    visible = false,
    touch = null,
    onDismiss = null,
  } = $props();

  const touchLayout = $derived(touch ?? device.touch);
  // Door open/close is hover-only without this line (#158 P7).
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
    <div class="paper cheoma-glass">
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
  /* Desktop: free band under breadcrumbs, clear of dock and dial (#158 P5).
     Width is explicit so portrait overrides can reset it. */
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
    border-radius: 8px;
    color: var(--glass-text);
  }

  .title {
    margin: 0 0 7px;
    color: var(--glass-muted);
    font-size: var(--spectrum-font-size-50, 11px);
    font-weight: 650;
    letter-spacing: 0.12em;
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
    font-size: var(--spectrum-font-size-75, 12px);
    line-height: 1.3;
  }

  .mark {
    width: 22px;
    height: 22px;
    display: grid;
    place-items: center;
    border: 1px solid var(--glass-border);
    border-radius: var(--spectrum-corner-radius-100, 4px);
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

  @media (max-width: 768px) and (orientation: portrait) {
    .scene-guide.touch {
      left: 10px;
      right: 10px;
      top: auto;
      width: auto;
      max-width: none;
      /* Dock publishes --dock-h (wraps on narrow phones / long locales). */
      bottom: calc(max(96px, env(safe-area-inset-bottom) + 90px) + var(--dock-h, 58px) + 10px);
    }
    .paper { padding: 9px 40px 10px 10px; }
    .title { margin: 0 0 5px; font-size: 9.5px; }
    ul { gap: 4px 8px; grid-template-columns: 1fr 1fr; }
    li { grid-template-columns: 20px minmax(0, 1fr); gap: 5px; font-size: 11px; line-height: 1.3; }
    .mark { width: 20px; height: 20px; font-size: 10px; }
  }

  @media (max-width: 360px) {
    ul { grid-template-columns: 1fr; }
  }

  /* Landscape phone: hide — right rail + short height leave no free band. */
  @media (max-height: 520px) and (orientation: landscape) {
    .scene-guide.touch {
      display: none;
    }
  }
</style>
