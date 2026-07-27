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

<div bind:this={dock} class="actions" class:raised class:lifted role="group" aria-label={t('axis_share')}>
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
  .actions {
    position: fixed;
    right: calc(var(--inspector-w, 0px) + clamp(14px, 2.4vw, 30px));
    bottom: clamp(16px, 3vh, 34px);
    z-index: 34;
    display: flex;
    align-items: flex-end;
    justify-content: flex-end;
    flex-wrap: wrap;
    max-width: calc(100vw - var(--inspector-w, 0px) - 2 * clamp(14px, 2.4vw, 30px));
    gap: 8px;
    transition: right 0.32s cubic-bezier(0.22, 1, 0.36, 1), transform 0.5s cubic-bezier(0.22, 1, 0.36, 1);
  }
  .watchgroup {
    display: flex; align-items: flex-end; gap: 6px;
    padding-right: 8px; margin-right: 2px;
    border-right: 1px solid var(--glass-border);
  }
  @media (pointer: coarse) {
    .actions {
      right: calc(var(--inspector-w, 0px) + max(12px, env(safe-area-inset-right)));
      bottom: max(16px, calc(env(safe-area-inset-bottom) + 12px));
      z-index: 47;
    }
  }
  @media (max-width: 768px) and (orientation: portrait) {
    .actions {
      right: max(12px, env(safe-area-inset-right));
      max-width: calc(100vw - 24px);
    }
    .actions.raised { bottom: max(96px, calc(env(safe-area-inset-bottom) + 90px)); }
    /* One row only while editing — a wrapped dock collapses the focus framing band. */
    .actions.lifted {
      bottom: calc(var(--sheet-half, 51vh) + 8px);
      flex-wrap: nowrap;
      gap: 6px;
      max-width: calc(100vw - 24px);
    }
    .actions.lifted .seal {
      min-width: 44px;
      height: 44px;
      padding: 0 8px;
    }
    .actions.lifted .seal .face { font-size: 11.5px; }
    .actions.lifted .seal.round { width: 44px; min-width: 44px; height: 44px; }
    .actions.lifted .watchgroup { display: none; }
  }
  .seal {
    -webkit-appearance: none;
    appearance: none;
    border: none;
    min-width: 52px;
    width: auto;
    height: 48px;
    padding: 0 12px;
    border-radius: 8px;
    display: grid;
    place-items: center;
    font-family: var(--ui);
    background: var(--glass-strong);
    background-image: var(--grain);
    border: 1px solid var(--glass-border);
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.28);
    color: var(--glass-text);
    transition: transform 0.12s ease, background 0.12s ease, border-color 0.12s ease, filter 0.2s ease;
  }
  .seal .face {
    font-size: 12.5px;
    line-height: 1.1;
    letter-spacing: 0.02em;
    font-weight: 650;
    text-align: center;
    white-space: nowrap;
  }
  .seal.round { border-radius: 50%; width: 46px; min-width: 46px; height: 46px; padding: 0; }
  .seal .note { font-size: 18px; color: var(--glass-muted); }
  .seal .glyph { font-size: 17px; font-weight: 650; color: var(--glass-text); line-height: 1; }
  .seal.round.active {
    background: var(--accent-soft);
    border-color: rgba(90, 168, 224, 0.45);
  }
  .seal.round.active .note { color: var(--accent); }

  .seal.primary {
    min-width: 56px;
    height: 52px;
    background: var(--accent-soft);
    border-color: rgba(90, 168, 224, 0.45);
  }
  .seal.primary .face { color: var(--glass-text); }

  .seal:hover {
    transform: translateY(-1px);
    background: rgba(20, 24, 30, 0.82);
    border-color: rgba(90, 168, 224, 0.35);
  }
  .seal:active { transform: translateY(0) scale(0.97); }
  .seal:disabled { filter: saturate(0.7) opacity(0.55); cursor: default; }
  .seal:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }

  @media (max-width: 430px) {
    .actions { gap: 6px; left: auto; max-width: calc(100vw - 20px); }
    .seal { min-width: 46px; height: 46px; padding: 0 8px; }
    .seal .face { font-size: 12px; }
    .seal.round { width: 44px; min-width: 44px; height: 44px; }
    .watchgroup { gap: 5px; padding-right: 6px; }
  }
</style>
