<script>
  // Viewport dock — audio / cinematic / glossary (and solo-house rebuild + share).
  // Village scenes put photo/share/export inside the make panel so a collapsed
  // peek sheet never floats secondary tools over the frame. Selectors
  // (.actions, [data-action], .seal) stay stable for gates that still hit the dock.
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
        <sp-action-button
          class="seal round"
          quiet
          disabled={busy || undefined}
          title={t('act_drone_tip')}
          aria-label={t('act_drone_tip')}
          onclick={onDrone}
        >▷</sp-action-button>
      {/if}
      {#if onWalk}
        <sp-action-button
          class="seal round"
          quiet
          disabled={busy || undefined}
          title={t('act_walk_tip')}
          aria-label={t('act_walk_tip')}
          onclick={onWalk}
        >步</sp-action-button>
      {/if}
    </div>
  {/if}
  {#if onReroll}
    <sp-action-button
      class="seal primary"
      selected
      disabled={busy || undefined}
      title={t('act_rebuild_tip')}
      onclick={onReroll}
    >{t('act_rebuild')}</sp-action-button>
  {/if}
  {#if onPostcard}
    <sp-action-button
      class="seal"
      quiet
      data-action="postcard"
      title={t('act_postcard_tip')}
      onclick={onPostcard}
    >{t('act_postcard')}</sp-action-button>
  {/if}
  {#if onShare}
    <sp-action-button
      class="seal"
      quiet
      data-action="share"
      title={t('act_share_tip')}
      onclick={onShare}
    >{t('act_share')}</sp-action-button>
  {/if}
  {#if onExport}
    <sp-action-button
      class="seal"
      quiet
      data-action="export"
      disabled={exporting || busy || undefined}
      title={t('glb_house_tip')}
      onclick={onExport}
    >{exporting ? t('glb_exporting') : t('act_glb')}</sp-action-button>
  {/if}
  {#if onToggleGlossary}
    <sp-action-button
      class="seal round"
      quiet
      selected={glossaryOn || undefined}
      data-action="glossary"
      title={glossaryOn ? t('act_glossary_on_tip') : t('act_glossary_off_tip')}
      aria-label={glossaryOn ? t('act_glossary_on_tip') : t('act_glossary_off_tip')}
      aria-pressed={glossaryOn}
      disabled={busy || undefined}
      onclick={onToggleGlossary}
    >名</sp-action-button>
  {/if}
  {#if onToggleAudio}
    <sp-action-button
      class="seal round"
      quiet
      selected={audioOn || undefined}
      title={audioOn ? t('act_sound_on_tip') : t('act_sound_off_tip')}
      aria-pressed={audioOn}
      onclick={onToggleAudio}
    >♪</sp-action-button>
  {/if}
</div>

<style>
  /* Geometry + glass rail only — buttons are Spectrum action-buttons */
  .actions {
    position: fixed;
    right: calc(var(--inspector-w, 0px) + clamp(12px, 1.8vw, 24px));
    bottom: clamp(14px, 2.6vh, 28px);
    z-index: 34;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    flex-wrap: wrap;
    max-width: calc(100vw - var(--inspector-w, 0px) - 2 * clamp(12px, 1.8vw, 24px));
    gap: 2px;
    padding: 4px;
    border-radius: 10px;
    background-color: var(--glass-strong);
    transition: right 0.32s cubic-bezier(0.22, 1, 0.36, 1), bottom 0.5s cubic-bezier(0.22, 1, 0.36, 1);
  }
  .watchgroup {
    display: flex;
    align-items: center;
    gap: 2px;
    padding-right: 4px;
    margin-right: 2px;
    border-right: 1px solid var(--glass-border);
  }
  .actions :global(sp-action-button.seal) {
    min-width: 44px;
    min-height: 44px;
  }
  .actions :global(sp-action-button.seal.primary) {
    min-width: 56px;
  }

  @media (pointer: coarse) {
    .actions {
      right: calc(var(--inspector-w, 0px) + max(10px, env(safe-area-inset-right)));
      bottom: max(14px, calc(env(safe-area-inset-bottom) + 10px));
      z-index: 47;
    }
  }
  @media (max-width: 768px) and (orientation: portrait) {
    .actions {
      right: max(10px, env(safe-area-inset-right));
      max-width: calc(100vw - 20px);
    }
    .actions.raised { bottom: max(96px, calc(env(safe-area-inset-bottom) + 90px)); }
    .actions.lifted,
    :global(html:has([data-make-panel][data-snap='half'])) .actions {
      bottom: calc(var(--sheet-half, 50vh) + 10px);
      flex-wrap: nowrap;
      gap: 2px;
      padding: 3px;
      max-width: calc(100vw - 20px);
    }
  }
  @media (max-width: 430px) {
    .actions { gap: 1px; max-width: calc(100vw - 16px); padding: 3px; }
  }
</style>
