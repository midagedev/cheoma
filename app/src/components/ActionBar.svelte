<script>
  // Viewport dock — audio / cinematic / glossary (and solo-house rebuild + share).
  // Village scenes put photo/share/export inside the make panel. Selectors
  // (.actions, [data-action], .seal) stay stable for gates.
  import { t } from '../lib/i18n.svelte.js';
  let {
    onReroll = null, onPostcard = null, onShare = null, onExport = null, onToggleAudio = null,
    audioOn = false, busy = false, raised = false, lifted = false, exporting = false,
    onDrone = null, onWalk = null,
    onToggleGlossary = null, glossaryOn = false,
  } = $props();

  let dock = $state(null);
  $effect(() => {
    if (!dock || typeof ResizeObserver === 'undefined') return;
    const publish = () => document.documentElement.style.setProperty('--dock-h', `${Math.round(dock.getBoundingClientRect().height)}px`);
    const observer = new ResizeObserver(publish);
    observer.observe(dock);
    publish();
    return () => {
      observer.disconnect();
      document.documentElement.style.removeProperty('--dock-h');
    };
  });
</script>

<div bind:this={dock} class="actions cheoma-glass" class:raised class:lifted role="group" aria-label={t('axis_share')}>
  {#if onDrone || onWalk}
    <div class="watchgroup">
      {#if onDrone}
        <button type="button" class="seal round" disabled={busy} title={t('act_drone_tip')} aria-label={t('act_drone_tip')} onclick={onDrone}>▷</button>
      {/if}
      {#if onWalk}
        <button type="button" class="seal round" disabled={busy} title={t('act_walk_tip')} aria-label={t('act_walk_tip')} onclick={onWalk}>步</button>
      {/if}
    </div>
  {/if}
  {#if onReroll}
    <button type="button" class="seal primary" disabled={busy} title={t('act_rebuild_tip')} onclick={onReroll}>{t('act_rebuild')}</button>
  {/if}
  {#if onPostcard}
    <button type="button" class="seal" data-action="postcard" title={t('act_postcard_tip')} onclick={onPostcard}>{t('act_postcard')}</button>
  {/if}
  {#if onShare}
    <button type="button" class="seal" data-action="share" title={t('act_share_tip')} onclick={onShare}>{t('act_share')}</button>
  {/if}
  {#if onExport}
    <button type="button" class="seal" data-action="export" disabled={exporting || busy} title={t('glb_house_tip')} onclick={onExport}>
      {exporting ? t('glb_exporting') : t('act_glb')}
    </button>
  {/if}
  {#if onToggleGlossary}
    <button
      type="button"
      class="seal round"
      class:active={glossaryOn}
      data-action="glossary"
      title={glossaryOn ? t('act_glossary_on_tip') : t('act_glossary_off_tip')}
      aria-label={glossaryOn ? t('act_glossary_on_tip') : t('act_glossary_off_tip')}
      aria-pressed={glossaryOn}
      disabled={busy}
      onclick={onToggleGlossary}
    >名</button>
  {/if}
  {#if onToggleAudio}
    <button
      type="button"
      class="seal round"
      class:active={audioOn}
      title={audioOn ? t('act_sound_on_tip') : t('act_sound_off_tip')}
      aria-pressed={audioOn}
      onclick={onToggleAudio}
    >♪</button>
  {/if}
</div>

<style>
  .actions {
    position: fixed;
    /* Hug content on the right of the free stage (do not stretch full width —
       a full-width dock would intercept seal / canvas hits). */
    right: calc(var(--inspector-w, 0px) + max(10px, env(safe-area-inset-right, 0px)));
    bottom: clamp(14px, 2.6vh, 28px);
    left: auto;
    z-index: 34;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    flex-wrap: wrap;
    gap: 2px;
    padding: 4px;
    border-radius: 10px;
    background-color: var(--glass-strong);
    box-sizing: border-box;
    max-width: min(
      100vw - 20px - var(--inspector-w, 0px),
      calc(100vw - 20px - env(safe-area-inset-left, 0px) - env(safe-area-inset-right, 0px) - var(--inspector-w, 0px))
    );
    /* Right only — bottom jumps with sheet detents; continuous bottom
       transitions make Playwright "stable" clicks time out. */
    transition: right 0.32s cubic-bezier(0.22, 1, 0.36, 1);
  }
  .watchgroup {
    display: flex;
    align-items: center;
    gap: 2px;
    padding-right: 4px;
    margin-right: 2px;
    border-right: 1px solid var(--glass-border);
  }
  .seal {
    -webkit-appearance: none;
    appearance: none;
    min-width: 44px;
    min-height: 44px;
    height: 44px;
    padding: 0 10px;
    border-radius: 8px;
    display: grid;
    place-items: center;
    background: transparent;
    border: 1px solid transparent;
    color: var(--glass-text);
    font-size: 12px;
    font-weight: 650;
    cursor: pointer;
  }
  .seal.round { width: 44px; min-width: 44px; padding: 0; font-size: 15px; }
  .seal.primary {
    min-width: 56px;
    background: color-mix(in srgb, var(--accent) 32%, transparent);
    border-color: color-mix(in srgb, var(--accent) 50%, transparent);
  }
  .seal.active {
    background: var(--accent-soft);
    border-color: color-mix(in srgb, var(--accent) 40%, transparent);
    color: var(--accent);
  }
  .seal:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.08);
    border-color: rgba(255, 255, 255, 0.1);
  }
  .seal:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .seal:disabled { opacity: 0.42; cursor: default; }

  @media (pointer: coarse) {
    .actions {
      bottom: max(14px, calc(env(safe-area-inset-bottom) + 10px));
      z-index: 47;
    }
  }
  @media (max-width: 768px) and (orientation: portrait) {
    .actions.raised { bottom: max(96px, calc(env(safe-area-inset-bottom) + 90px)); }
    .actions.lifted,
    :global(html:has([data-make-panel][data-snap='half'])) .actions {
      bottom: calc(var(--sheet-half, 50vh) + 10px);
      flex-wrap: nowrap;
      gap: 2px;
      padding: 3px;
    }
  }
  @media (max-width: 430px) {
    .actions { gap: 1px; padding: 3px; }
  }
</style>
