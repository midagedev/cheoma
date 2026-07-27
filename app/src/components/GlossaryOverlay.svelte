<script>
  // Focus exterior member glossary (#216) — DOM labels only, no WebGL draws.
  // labels: [{ id, x, y, visible }], disclaimer string (product Korean line).
  import { t } from '../lib/i18n.svelte.js';

  let { labels = [], disclaimer = '', active = false } = $props();

  const LABEL_KEYS = {
    eave: 'glossary_eave',
    ridge: 'glossary_ridge',
    podium: 'glossary_podium',
    changbang: 'glossary_changbang',
    rafter: 'glossary_rafter',
    bracket: 'glossary_bracket',
    changho: 'glossary_changho',
    giwa: 'glossary_giwa',
    ieung: 'glossary_ieung',
  };

  const visibleLabels = $derived(
    (labels || []).filter((label) => label && label.visible !== false
      && Number.isFinite(label.x) && Number.isFinite(label.y)),
  );
</script>

{#if active && visibleLabels.length}
  <div class="glossary" aria-live="polite" data-glossary-overlay>
    {#each visibleLabels as label (label.id)}
      <div
        class="tag"
        data-glossary-id={label.id}
        style="left:{label.x}px; top:{label.y}px;"
      >
        <span class="dot" aria-hidden="true"></span>
        <span class="text">{t(LABEL_KEYS[label.id] || label.id)}</span>
      </div>
    {/each}
    {#if disclaimer}
      <div class="note" data-glossary-disclaimer>{disclaimer}</div>
    {/if}
  </div>
{/if}

<style>
  .glossary {
    position: fixed;
    inset: 0;
    z-index: 42;
    pointer-events: none;
  }
  .tag {
    position: fixed;
    transform: translate(-50%, calc(-100% - 10px));
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 8px 3px 6px;
    border-radius: 999px;
    background: var(--glass-strong);
    border: 1px solid var(--glass-border);
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.28);
    color: var(--glass-text);
    font-family: var(--ui);
    white-space: nowrap;
  }
  .tag .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent);
    box-shadow: 0 0 0 2px rgba(90, 168, 224, 0.22);
    flex: 0 0 auto;
  }
  .tag .text {
    font-size: 12px;
    font-weight: 650;
    letter-spacing: 0.02em;
    line-height: 1.2;
  }
  .note {
    position: fixed;
    left: 50%;
    bottom: max(18px, calc(env(safe-area-inset-bottom) + 12px));
    transform: translateX(-50%);
    padding: 4px 10px;
    border-radius: 6px;
    background: var(--glass-strong);
    border: 1px solid var(--glass-border);
    color: var(--glass-muted);
    font-family: var(--ui);
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 0.01em;
    white-space: nowrap;
    max-width: min(92vw, 360px);
    text-align: center;
  }
  @media (max-width: 768px) and (orientation: portrait) {
    .note {
      bottom: max(72px, calc(env(safe-area-inset-bottom) + 64px));
    }
  }
</style>
