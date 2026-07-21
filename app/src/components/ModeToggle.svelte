<script>
  // 좌상 보기 전환(#14) — 줌 거리가 아니라 상호작용 의도를 표시한다. 둘러보기에서는 휠/핀치로
  //   자유롭게 이동하고, 집 보기는 명시적으로 선택한 한 채의 컨텍스트를 유지한다.
  import { t } from '../lib/i18n.svelte.js';
  let { mode = 'house', onToggle } = $props();
</script>

<div class="mode" role="group" aria-label="view scale">
  <button
    class="seg" class:on={mode === 'village'}
    onclick={() => mode !== 'village' && onToggle?.('village')}
    aria-pressed={mode === 'village'} title={t('mode_to_village')}
  >
    <span class="glyph" aria-hidden="true">村</span>
    <span class="lab">{t('mode_village')}</span>
  </button>
  <button
    class="seg" class:on={mode === 'house'}
    onclick={() => mode !== 'house' && onToggle?.('house')}
    aria-pressed={mode === 'house'} title={t('mode_to_house')}
  >
    <span class="glyph" aria-hidden="true">家</span>
    <span class="lab">{t('mode_house')}</span>
  </button>
</div>

<style>
  .mode {
    position: fixed;
    left: clamp(10px, 1.6vw, 22px);
    top: clamp(10px, 1.6vh, 22px);
    z-index: 40;
    display: flex;
    gap: 3px;
    padding: 3px;
    border-radius: 8px;
    background-color: rgba(244, 239, 228, 0.14);
    border: 1px solid rgba(244, 239, 228, 0.28);
    backdrop-filter: blur(3px);
    box-shadow: 0 2px 10px rgba(30, 22, 14, 0.22);
    user-select: none;
  }
  .seg {
    -webkit-appearance: none; appearance: none; border: none;
    display: flex; align-items: center; gap: 6px;
    padding: 7px 12px; border-radius: 6px;
    background: transparent; color: rgba(244, 239, 228, 0.9);
    font-family: var(--serif); letter-spacing: 0.04em;
    text-shadow: 0 1px 4px rgba(30, 22, 14, 0.55);
    transition: background 0.18s ease, color 0.18s ease, transform 0.12s ease;
  }
  .seg .glyph { font-size: 15px; font-weight: 700; opacity: 0.85; }
  .seg .lab { font-size: 13px; font-weight: 700; }
  .seg:hover { background: rgba(244, 239, 228, 0.12); }
  .seg:active { transform: scale(0.97); }
  .seg.on {
    background: var(--seal); color: var(--paper);
    text-shadow: none;
    box-shadow: 0 1px 4px rgba(120, 40, 30, 0.4), inset 0 0 0 1px rgba(255, 220, 210, 0.18);
  }
  .seg.on .glyph { opacity: 1; }
  .seg:focus-visible { outline: 2px solid var(--seal); outline-offset: 2px; }

  /* 모바일: safe-area 존중 + 터치 타깃 ≥44px. */
  @media (pointer: coarse) {
    .mode {
      left: max(10px, calc(env(safe-area-inset-left) + 6px));
      top: max(10px, calc(env(safe-area-inset-top) + 4px));
    }
    .seg { padding: 10px 14px; }
    .seg .glyph { font-size: 16px; }
    .seg .lab { font-size: 14px; }
  }
</style>
