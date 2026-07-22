<script>
  import { t } from '../lib/i18n.svelte.js';
  let { mode = 'pbr', onToggle } = $props();
</script>

<div class="render-style" role="group" aria-label={t('render_style')}>
  <button
    class:on={mode === 'pbr'}
    type="button"
    aria-pressed={mode === 'pbr'}
    title={t('render_pbr_tip')}
    onclick={() => mode !== 'pbr' && onToggle?.('pbr')}
  >
    <span class="glyph" aria-hidden="true">景</span>
    <span>{t('render_pbr')}</span>
  </button>
  <button
    class:on={mode === 'ink'}
    type="button"
    aria-pressed={mode === 'ink'}
    title={t('render_ink_tip')}
    onclick={() => mode !== 'ink' && onToggle?.('ink')}
  >
    <span class="glyph" aria-hidden="true">墨</span>
    <span>{t('render_ink')}</span>
  </button>
</div>

<style>
  .render-style {
    position: fixed;
    left: clamp(10px, 1.6vw, 22px);
    top: clamp(62px, calc(1.6vh + 52px), 74px);
    z-index: 40;
    display: flex;
    gap: 2px;
    padding: 3px;
    border: 1px solid rgba(244, 239, 228, 0.28);
    border-radius: 8px;
    background: rgba(244, 239, 228, 0.14);
    backdrop-filter: blur(3px);
    box-shadow: 0 2px 10px rgba(30, 22, 14, 0.22);
    user-select: none;
  }
  button {
    -webkit-appearance: none; appearance: none; border: 0;
    min-height: 32px; padding: 6px 9px; border-radius: 6px;
    display: flex; align-items: center; gap: 5px;
    background: transparent; color: rgba(244, 239, 228, 0.9);
    font-size: 12px; font-weight: 700; letter-spacing: 0.04em;
    text-shadow: 0 1px 4px rgba(30, 22, 14, 0.55);
    transition: background 0.18s ease, color 0.18s ease, transform 0.12s ease;
  }
  button:hover { background: rgba(244, 239, 228, 0.12); }
  button:active { transform: scale(0.97); }
  button.on {
    background: var(--paper); color: var(--ink); text-shadow: none;
    box-shadow: inset 0 0 0 1px rgba(44, 38, 32, 0.13);
  }
  button:last-child.on { background: var(--ink); color: var(--paper); }
  button:focus-visible { outline: 2px solid var(--seal); outline-offset: 2px; }
  .glyph { font-size: 14px; }

  @media (pointer: coarse) {
    .render-style {
      left: max(10px, calc(env(safe-area-inset-left) + 6px));
      top: max(62px, calc(env(safe-area-inset-top) + 56px));
    }
    button { min-height: 44px; padding: 8px 11px; font-size: 13px; }
    .glyph { font-size: 15px; }
  }
</style>
