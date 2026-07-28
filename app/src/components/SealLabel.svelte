<script>
  // Bottom-left brand + seed + locale — CAD status chip (glass), not loose floating type.
  // Brand stamp is the only traditional seal accent in chrome.
  import { i18n, setLang } from '../lib/i18n.svelte.js';
  let { seed = 0, onInfo } = $props();
  const seedStr = $derived('#' + String(seed >>> 0).slice(-4).padStart(4, '0'));
  const infoLabel = $derived(i18n.lang === 'ko' ? '참고 자료' : 'References & credits');

  function openInfo(event) {
    onInfo?.(event.currentTarget);
  }
</script>

<div class="seal-label glass-surface" data-status-chip>
  <button
    class="brand"
    data-reference-trigger="brand"
    onclick={openInfo}
    aria-label={infoLabel}
    title={infoLabel}
  >
    <span class="stamp" aria-hidden="true">처마</span>
  </button>
  <div class="rail">
    <div class="meta">
      <span class="seed" title={'seed ' + (seed >>> 0)}>{seedStr}</span>
      <button
        class="info"
        data-reference-trigger="info"
        onclick={openInfo}
        aria-label={infoLabel}
        title={infoLabel}
      >ⓘ</button>
    </div>
    <div class="lang" role="group" aria-label="Language">
      <button type="button" class:on={i18n.lang === 'en'} onclick={() => setLang('en')}>EN</button>
      <button type="button" class:on={i18n.lang === 'ko'} onclick={() => setLang('ko')}>한</button>
    </div>
  </div>
</div>

<style>
  .seal-label {
    position: fixed;
    left: clamp(12px, 1.8vw, 24px);
    bottom: clamp(14px, 2.6vh, 28px);
    z-index: 20;
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 10px;
    padding: 7px 10px 7px 8px;
    border-radius: 10px;
    user-select: none;
    pointer-events: none;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.32);
  }
  .brand {
    pointer-events: auto;
    cursor: pointer;
    -webkit-appearance: none;
    appearance: none;
    border: none;
    background: none;
    padding: 0;
    display: flex;
    align-items: center;
    flex: none;
  }
  .brand:focus-visible { outline: none; }
  .brand:focus-visible .stamp {
    box-shadow: 0 0 0 2px rgba(18, 21, 26, 0.9), 0 0 0 3.5px var(--accent);
  }
  .stamp {
    writing-mode: vertical-rl;
    font-family: var(--serif);
    font-weight: 700;
    font-size: 11px;
    line-height: 1.05;
    letter-spacing: 0.14em;
    color: var(--paper);
    background: var(--seal);
    padding: 7px 3px;
    border-radius: 2px;
    box-shadow: 0 0 0 1px rgba(120, 40, 30, 0.35), 0 2px 6px rgba(0, 0, 0, 0.28);
    transform-origin: center;
    animation: stamp 0.52s cubic-bezier(0.34, 1.56, 0.64, 1) both;
  }
  @keyframes stamp {
    0% { transform: scale(1.45) rotate(-6deg); opacity: 0; }
    55% { transform: scale(0.92) rotate(1deg); opacity: 1; }
    100% { transform: scale(1) rotate(0deg); opacity: 1; }
  }
  .rail {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
    min-width: 0;
  }
  .meta {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .seed {
    font-family: var(--mono);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.06em;
    color: var(--glass-muted);
    font-variant-numeric: tabular-nums;
  }
  .info {
    pointer-events: auto;
    cursor: pointer;
    -webkit-appearance: none;
    appearance: none;
    border: none;
    background: transparent;
    padding: 2px 4px;
    border-radius: 4px;
    font-family: var(--ui);
    font-size: 12px;
    line-height: 1;
    color: var(--glass-muted);
    transition: color 0.15s ease, background 0.15s ease;
  }
  .info:hover, .info:focus-visible {
    color: var(--accent);
    background: rgba(255, 255, 255, 0.06);
    outline: none;
  }
  .lang {
    pointer-events: auto;
    display: inline-flex;
    align-items: center;
    padding: 2px;
    border-radius: 5px;
    background: rgba(0, 0, 0, 0.28);
    border: 1px solid rgba(255, 255, 255, 0.08);
  }
  .lang button {
    -webkit-appearance: none;
    appearance: none;
    border: none;
    background: transparent;
    min-width: 28px;
    height: 22px;
    padding: 0 7px;
    border-radius: 3px;
    font-family: var(--ui);
    font-size: 10.5px;
    font-weight: 650;
    letter-spacing: 0.04em;
    color: var(--glass-muted);
    cursor: pointer;
    transition: color 0.15s ease, background 0.15s ease;
  }
  .lang button:hover { color: var(--glass-text); }
  .lang button.on {
    color: #fff;
    background: rgba(90, 168, 224, 0.28);
    box-shadow: inset 0 0 0 1px rgba(90, 168, 224, 0.4);
  }
  .lang button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }

  @media (pointer: coarse) {
    .seal-label {
      left: max(10px, calc(env(safe-area-inset-left) + 4px));
      bottom: max(12px, calc(env(safe-area-inset-bottom) + 8px));
      padding: 8px 10px 8px 8px;
      gap: 10px;
    }
    .stamp { font-size: 11px; padding: 8px 3px; }
    .info { font-size: 15px; padding: 6px 8px; min-width: 36px; min-height: 36px; }
    .lang button { min-width: 36px; height: 32px; font-size: 12px; }
  }
</style>
