<script>
  // Viewport dock — audio / cinematic / glossary (and solo-house rebuild + share).
  // Village scenes put photo/share/export inside the make panel so a collapsed
  // peek sheet never floats secondary tools over the frame. Selectors
  // (.actions, [data-action], .seal) stay stable for gates that still hit the dock.
  import { t } from '../lib/i18n.svelte.js';
  // raised: 세로 모바일 부감에서 하단 peek 시트 위로 올려 겹침 방지.
  // onReroll: 레거시 단일건물 씬에서만 전달(새 씨앗). 마을 씬은 만들기 패널이 소유.
  // onPostcard/onShare/onExport: 마을 씬은 null(패널 소유). 솔로 집 씬만 독에 노출.
  // lifted: 세로 모바일에서 만들기 시트가 펼쳐진 동안(편집·전환) 시트 위 씬 영역으로 올린다 —
  //   시트가 게시하는 --sheet-half 를 그대로 소비하므로 독이 시트를 덮거나 시트에 덮이지 않는다.
  let {
    onReroll = null, onPostcard = null, onShare = null, onExport = null, onToggleAudio = null,
    audioOn = false, busy = false, raised = false, lifted = false, exporting = false,
    onDrone = null, onWalk = null,
    // #216 focus exterior glossary — only when eligible settled focus.
    onToggleGlossary = null, glossaryOn = false,
  } = $props();

  // 독은 좁은 폭·긴 로케일 라벨에서 위로 한 줄 접힌다(의도된 동작). 그러면 높이가 58px 상수가
  // 아니게 되므로, 그 위에 앉는 조작 안내(#158 P5)가 상수로 비켜설 수 없다 — 독이 자기 높이를
  // --dock-h 로 게시하고 안내가 그것을 소비한다. 상수 가정이 깨지는 회귀를 원천 차단.
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
        <button class="seal round" onclick={onDrone} disabled={busy} title={t('act_drone_tip')} aria-label={t('act_drone_tip')}>
          <span class="face glyph">▷</span>
        </button>
      {/if}
      {#if onWalk}
        <button class="seal round" onclick={onWalk} disabled={busy} title={t('act_walk_tip')} aria-label={t('act_walk_tip')}>
          <span class="face glyph">步</span>
        </button>
      {/if}
    </div>
  {/if}
  {#if onReroll}
    <button class="seal primary" onclick={onReroll} disabled={busy} title={t('act_rebuild_tip')}>
      <span class="face">{t('act_rebuild')}</span>
    </button>
  {/if}
  {#if onPostcard}
    <button class="seal" data-action="postcard" onclick={onPostcard} title={t('act_postcard_tip')}>
      <span class="face">{t('act_postcard')}</span>
    </button>
  {/if}
  {#if onShare}
    <button class="seal" data-action="share" onclick={onShare} title={t('act_share_tip')}>
      <span class="face">{t('act_share')}</span>
    </button>
  {/if}
  {#if onExport}
    <button
      class="seal"
      data-action="export"
      onclick={onExport}
      disabled={exporting || busy}
      title={t('glb_house_tip')}
    >
      <span class="face">{exporting ? t('glb_exporting') : t('act_glb')}</span>
    </button>
  {/if}
  {#if onToggleGlossary}
    <button
      class="seal round"
      class:active={glossaryOn}
      data-action="glossary"
      onclick={onToggleGlossary}
      title={glossaryOn ? t('act_glossary_on_tip') : t('act_glossary_off_tip')}
      aria-label={glossaryOn ? t('act_glossary_on_tip') : t('act_glossary_off_tip')}
      aria-pressed={glossaryOn}
      disabled={busy}
    >
      <span class="face glyph">名</span>
    </button>
  {/if}
  {#if onToggleAudio}
    <button
      class="seal round"
      class:active={audioOn}
      onclick={onToggleAudio}
      title={audioOn ? t('act_sound_on_tip') : t('act_sound_off_tip')}
      aria-pressed={audioOn}
    >
      <span class="face note">♪</span>
    </button>
  {/if}
</div>

<style>
  /* Scene dock — glass rail over WebGL (Spectrum theme tokens via cheoma-glass). */
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
    gap: 4px;
    padding: 5px;
    border-radius: 12px;
    /* cheoma-glass provides fill; strengthen slightly for dock legibility */
    background-color: var(--glass-strong);
    transition: right 0.32s cubic-bezier(0.22, 1, 0.36, 1), transform 0.5s cubic-bezier(0.22, 1, 0.36, 1);
  }
  .watchgroup {
    display: flex;
    align-items: center;
    gap: 3px;
    padding-right: 6px;
    margin-right: 2px;
    border-right: 1px solid rgba(255, 255, 255, 0.1);
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
    /* Peek sheet: clear the grip only. */
    .actions.raised { bottom: max(96px, calc(env(safe-area-inset-bottom) + 90px)); }
    /* Half sheet (focus edit OR aerial panel expanded): ride above --sheet-half.
       CSS :has() covers aerial expand where lifted prop is still false. */
    .actions.lifted,
    :global(html:has([data-make-panel][data-snap='half'])) .actions {
      bottom: calc(var(--sheet-half, 50vh) + 10px);
      flex-wrap: nowrap;
      gap: 3px;
      padding: 4px;
      max-width: calc(100vw - 20px);
    }
    .actions.lifted .seal,
    :global(html:has([data-make-panel][data-snap='half'])) .actions .seal {
      min-width: 44px;
      height: 44px;
      padding: 0 8px;
    }
    .actions.lifted .seal .face,
    :global(html:has([data-make-panel][data-snap='half'])) .actions .seal .face { font-size: 11px; }
    .actions.lifted .seal.round,
    :global(html:has([data-make-panel][data-snap='half'])) .actions .seal.round {
      width: 44px; min-width: 44px; height: 44px;
    }
  }
  .seal {
    -webkit-appearance: none;
    appearance: none;
    min-width: 48px;
    width: auto;
    height: 40px;
    padding: 0 11px;
    border-radius: 8px;
    display: grid;
    place-items: center;
    font-family: var(--ui);
    background: transparent;
    border: 1px solid transparent;
    color: var(--glass-text);
    box-shadow: none;
    transition: background 0.12s ease, border-color 0.12s ease, color 0.12s ease;
  }
  .seal .face {
    font-size: 12px;
    line-height: 1.1;
    letter-spacing: 0.01em;
    font-weight: 650;
    text-align: center;
    white-space: nowrap;
  }
  .seal.round {
    border-radius: 8px;
    width: 40px;
    min-width: 40px;
    height: 40px;
    padding: 0;
  }
  .seal .note { font-size: 16px; color: var(--glass-muted); }
  .seal .glyph { font-size: 15px; font-weight: 650; color: var(--glass-text); line-height: 1; }
  .seal.round.active {
    background: var(--accent-soft);
    border-color: rgba(90, 168, 224, 0.4);
  }
  .seal.round.active .note,
  .seal.round.active .glyph { color: var(--accent); }

  .seal.primary {
    min-width: 56px;
    height: 40px;
    background: linear-gradient(180deg, rgba(90, 168, 224, 0.42) 0%, rgba(61, 135, 196, 0.34) 100%);
    border-color: rgba(90, 168, 224, 0.55);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.1);
  }
  .seal.primary .face { color: #fff; font-weight: 700; }

  .seal:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.07);
    border-color: rgba(255, 255, 255, 0.1);
  }
  .seal.primary:hover:not(:disabled) {
    background: linear-gradient(180deg, rgba(90, 168, 224, 0.55) 0%, rgba(61, 135, 196, 0.42) 100%);
    border-color: rgba(120, 190, 240, 0.7);
  }
  .seal:active:not(:disabled) { background: rgba(255, 255, 255, 0.1); }
  .seal:disabled { opacity: 0.42; cursor: default; }
  .seal:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  @media (pointer: coarse) {
    .seal { min-width: 48px; height: 44px; }
    .seal.round { width: 44px; min-width: 44px; height: 44px; }
    .seal.primary { height: 44px; }
  }

  @media (max-width: 430px) {
    .actions { gap: 2px; left: auto; max-width: calc(100vw - 16px); padding: 4px; }
    .seal { min-width: 44px; height: 44px; padding: 0 8px; }
    .seal .face { font-size: 11px; }
    .seal.round { width: 44px; min-width: 44px; height: 44px; }
    .watchgroup { gap: 2px; padding-right: 4px; }
  }
</style>
